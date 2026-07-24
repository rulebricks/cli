// External Secrets Operator (ESO) secret mode - the CLI's default.
//
// Instead of applying plain Kubernetes Secrets (src/lib/secrets.ts, "cluster"
// backend), the deployment's secrets live in the client's secrets platform and
// ESO syncs them into the cluster:
//
//   1. seedCloudSecrets       - write one JSON object per Secret into the
//                               cloud secrets manager (create-if-absent, so
//                               client-rotated values are never clobbered).
//   2. ensureEsoOperator      - install a namespace-scoped ESO when its CRDs
//                               are absent; respect any platform-managed ESO.
//   3. applyEsoManifests      - ServiceAccount + SecretStore + one
//                               ExternalSecret per Secret. Targets reuse
//                               deploymentSecretNames(), so every secretRef
//                               seam in the generated values resolves
//                               unchanged from k8s mode.
//   4. waitForExternalSecrets - gate the Helm install on SecretSynced=True so
//                               a missing vault entry fails in seconds with a
//                               pointed error, never as a wedged pod.
//
// The identity that lets ESO read the platform (Pod Identity / federated
// credential / Workload Identity binding) is created by the shared
// ensureWorkloadIdentityFederation step (see esoBinding in workloadIdentity.ts).
//
// byo-secret-store backend: the user brings an existing (Cluster)SecretStore
// (any ESO provider - Vault, 1Password, Doppler, ...) and seeds values in
// their platform themselves; the CLI only generates the ExternalSecrets and
// prints the entries the store must serve.

import { execa } from "execa";
import * as yaml from "yaml";
import {
  DeploymentConfig,
  getNamespace,
  getReleaseName,
} from "../types/index.js";
import { buildDeploymentSecrets } from "./secrets.js";
import { deploymentSecretNames } from "./helmValues.js";
import {
  writeAwsSecretsManagerSecret,
  writeAzureKeyVaultSecret,
  writeGcpSecretManagerSecret,
} from "./cloudCli.js";
import {
  ESO_READER_SERVICE_ACCOUNT,
  ESO_CONTROLLER_SERVICE_ACCOUNT,
} from "./workloadIdentity.js";

// Pinned to the chart's external-secrets dependency version (Chart.yaml).
const ESO_CHART_VERSION = "2.7.0";
const ESO_HELM_REPO = "https://charts.external-secrets.io";
const ESO_RELEASE_NAME = "rulebricks-external-secrets";

export type EsoBackend =
  | "aws-secrets-manager"
  | "azure-key-vault"
  | "gcp-secret-manager"
  | "byo-secret-store";

export function isEsoBackend(config: DeploymentConfig): boolean {
  const backend = config.secrets?.backend;
  return backend !== undefined && backend !== "cluster";
}

/**
 * Default provider entry prefix. AWS Secrets Manager supports "/" paths; Key
 * Vault and GCP Secret Manager IDs do not, so they use dashes.
 */
export function defaultSecretsPrefix(config: DeploymentConfig): string {
  const backend = config.secrets?.backend;
  return backend === "aws-secrets-manager"
    ? `rulebricks/${config.name}`
    : `rulebricks-${config.name}`;
}

/** Sanitize the configured prefix for providers that reject "/" in IDs. */
function providerPrefix(config: DeploymentConfig): string {
  const prefix = config.secrets?.prefix || defaultSecretsPrefix(config);
  if (config.secrets?.backend === "aws-secrets-manager") return prefix;
  return prefix.replace(/\//g, "-");
}

/**
 * One deployment secret in both coordinate systems: the Kubernetes Secret the
 * chart's secretRef seams point at, and the provider entry ESO reads.
 */
export interface EsoSecretEntry {
  /** Kubernetes Secret name (deploymentSecretNames value). */
  k8sName: string;
  /** Provider entry name (e.g. rulebricks/prod/app). */
  remoteKey: string;
  /** JSON object payload with the Secret's keys. */
  json: string;
  keys: string[];
}

/**
 * The deployment's secrets in ESO coordinates. Reuses buildDeploymentSecrets
 * (single source of truth shared with k8s mode) and maps each Kubernetes
 * Secret to a short provider entry name.
 */
export function esoSecretEntries(config: DeploymentConfig): EsoSecretEntry[] {
  const names = deploymentSecretNames(config);
  const shortNames: Record<string, string> = {
    [names.app]: "app",
    [names.db]: "supabase-db",
    [names.dbBootstrap]: "supabase-db-bootstrap",
    [names.jwt]: "supabase-jwt",
    [names.dashboard]: "supabase-dashboard",
    [names.realtime]: "supabase-realtime",
    [names.smtp]: "supabase-smtp",
  };
  const prefix = providerPrefix(config);
  const separator = config.secrets?.backend === "aws-secrets-manager" ? "/" : "-";

  return buildDeploymentSecrets(config).map((secret) => {
    const short = shortNames[secret.name] ?? secret.name;
    return {
      k8sName: secret.name,
      remoteKey: `${prefix}${separator}${short}`,
      json: JSON.stringify(secret.stringData),
      keys: Object.keys(secret.stringData),
    };
  });
}

export interface SeedSummary {
  created: string[];
  updated: string[];
  skipped: string[];
}

/**
 * Seed the cloud secrets manager with the deployment's secrets.
 * create-if-absent unless overwrite; byo-secret-store seeds nothing.
 */
export async function seedCloudSecrets(
  config: DeploymentConfig,
  options: { overwrite: boolean },
): Promise<SeedSummary> {
  const summary: SeedSummary = { created: [], updated: [], skipped: [] };
  const backend = config.secrets?.backend;
  if (!backend || backend === "cluster" || backend === "byo-secret-store") {
    return summary;
  }

  for (const entry of esoSecretEntries(config)) {
    let result;
    switch (backend) {
      case "aws-secrets-manager": {
        const region = config.infrastructure.region;
        if (!region) {
          throw new Error(
            "infrastructure.region is required to seed AWS Secrets Manager.",
          );
        }
        result = await writeAwsSecretsManagerSecret({
          name: entry.remoteKey,
          value: entry.json,
          region,
          overwrite: options.overwrite,
        });
        break;
      }
      case "azure-key-vault": {
        const vaultName = config.secrets?.azure?.vaultName;
        if (!vaultName) {
          throw new Error(
            "secrets.azure.vaultName is required to seed Azure Key Vault.",
          );
        }
        result = await writeAzureKeyVaultSecret({
          vaultName,
          name: entry.remoteKey,
          value: entry.json,
          overwrite: options.overwrite,
        });
        break;
      }
      case "gcp-secret-manager": {
        const projectId = config.infrastructure.gcpProjectId;
        if (!projectId) {
          throw new Error(
            "infrastructure.gcpProjectId is required to seed GCP Secret Manager.",
          );
        }
        result = await writeGcpSecretManagerSecret({
          projectId,
          name: entry.remoteKey,
          value: entry.json,
          overwrite: options.overwrite,
        });
        break;
      }
    }
    if (result.created) summary.created.push(entry.remoteKey);
    else if (result.updated) summary.updated.push(entry.remoteKey);
    else summary.skipped.push(entry.remoteKey);
  }
  return summary;
}

/** True when the ExternalSecret CRD is available on the cluster. */
export async function esoCrdsPresent(): Promise<boolean> {
  try {
    await execa("kubectl", [
      "get",
      "crd",
      "externalsecrets.external-secrets.io",
    ]);
    return true;
  } catch {
    return false;
  }
}

/**
 * Ensure an External Secrets Operator serves this cluster. A platform-managed
 * ESO (CRDs already present) is respected untouched; otherwise the CLI
 * installs a namespace-scoped operator from the upstream chart, pinned to the
 * same version the Rulebricks chart's optional dependency uses. Installing
 * before the Rulebricks chart is what breaks the ordering deadlock: the
 * SecretStore/ExternalSecret resources (and their sync gate) must exist
 * before the app pods that consume the synced Secrets.
 */
export async function ensureEsoOperator(
  namespace: string,
): Promise<{ installed: boolean }> {
  if (await esoCrdsPresent()) {
    return { installed: false };
  }
  try {
    await execa("helm", [
      "upgrade",
      "--install",
      ESO_RELEASE_NAME,
      "external-secrets",
      "--repo",
      ESO_HELM_REPO,
      "--version",
      ESO_CHART_VERSION,
      "--namespace",
      namespace,
      "--create-namespace",
      "--set",
      "installCRDs=true",
      "--set",
      "scopedRBAC=true",
      "--set",
      "processClusterExternalSecret=false",
      "--set",
      "processClusterStore=false",
      "--wait",
      "--timeout",
      "5m",
    ]);
  } catch (error) {
    throw new Error(
      `Failed to install the External Secrets Operator (release ${ESO_RELEASE_NAME}): ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  return { installed: true };
}

const SECRET_STORE_NAME = "rulebricks-secrets";

function storeRef(config: DeploymentConfig): { name: string; kind: string } {
  if (config.secrets?.backend === "byo-secret-store") {
    return {
      name: config.secrets.byo?.storeName ?? SECRET_STORE_NAME,
      kind: config.secrets.byo?.storeKind ?? "ClusterSecretStore",
    };
  }
  return { name: SECRET_STORE_NAME, kind: "SecretStore" };
}

/**
 * Build the ESO manifests for this deployment: reader ServiceAccount +
 * SecretStore (native backends) and one ExternalSecret per deployment Secret.
 */
export function buildEsoManifests(config: DeploymentConfig): object[] {
  const namespace = getNamespace(config.name);
  const releaseName = getReleaseName(config.name);
  const backend = config.secrets?.backend;
  const manifests: object[] = [];
  const labels = {
    "app.kubernetes.io/managed-by": "rulebricks-cli",
    "app.kubernetes.io/instance": releaseName,
  };

  if (backend === "azure-key-vault" || backend === "gcp-secret-manager") {
    const annotations: Record<string, string> = {};
    if (backend === "azure-key-vault") {
      if (config.secrets?.azure?.clientId) {
        annotations["azure.workload.identity/client-id"] =
          config.secrets.azure.clientId;
      }
      if (config.secrets?.azure?.tenantId) {
        annotations["azure.workload.identity/tenant-id"] =
          config.secrets.azure.tenantId;
      }
    } else if (config.secrets?.gcp?.serviceAccountEmail) {
      annotations["iam.gke.io/gcp-service-account"] =
        config.secrets.gcp.serviceAccountEmail;
    }
    manifests.push({
      apiVersion: "v1",
      kind: "ServiceAccount",
      metadata: {
        name: ESO_READER_SERVICE_ACCOUNT,
        namespace,
        labels,
        ...(Object.keys(annotations).length > 0 ? { annotations } : {}),
      },
    });
  }

  if (backend === "aws-secrets-manager") {
    manifests.push({
      apiVersion: "external-secrets.io/v1",
      kind: "SecretStore",
      metadata: { name: SECRET_STORE_NAME, namespace, labels },
      spec: {
        provider: {
          aws: {
            service: "SecretsManager",
            region: config.infrastructure.region,
            // No auth block: the ESO controller pod itself carries the
            // <cluster>-external-secrets role via its Pod Identity
            // association (see esoBinding in workloadIdentity.ts).
          },
        },
      },
    });
  } else if (backend === "azure-key-vault") {
    manifests.push({
      apiVersion: "external-secrets.io/v1",
      kind: "SecretStore",
      metadata: { name: SECRET_STORE_NAME, namespace, labels },
      spec: {
        provider: {
          azurekv: {
            authType: "WorkloadIdentity",
            vaultUrl:
              config.secrets?.azure?.vaultUri ??
              `https://${config.secrets?.azure?.vaultName}.vault.azure.net`,
            serviceAccountRef: { name: ESO_READER_SERVICE_ACCOUNT },
          },
        },
      },
    });
  } else if (backend === "gcp-secret-manager") {
    manifests.push({
      apiVersion: "external-secrets.io/v1",
      kind: "SecretStore",
      metadata: { name: SECRET_STORE_NAME, namespace, labels },
      spec: {
        provider: {
          gcpsm: {
            projectID: config.infrastructure.gcpProjectId,
            auth: {
              workloadIdentity: {
                clusterLocation: config.infrastructure.region,
                clusterName: config.infrastructure.clusterName,
                serviceAccountRef: { name: ESO_READER_SERVICE_ACCOUNT },
              },
            },
          },
        },
      },
    });
  }
  // byo-secret-store: the user's existing (Cluster)SecretStore is referenced
  // by name below; nothing to create.

  const ref = storeRef(config);
  for (const entry of esoSecretEntries(config)) {
    manifests.push({
      apiVersion: "external-secrets.io/v1",
      kind: "ExternalSecret",
      metadata: { name: entry.k8sName, namespace, labels },
      spec: {
        refreshInterval: "1h",
        secretStoreRef: ref,
        target: {
          name: entry.k8sName,
          // Owner is safe: with a secretRef configured the chart never
          // creates these Secrets, so ESO is their sole owner.
          creationPolicy: "Owner",
        },
        // Each provider entry is a JSON object whose keys are the Kubernetes
        // Secret's keys; extract maps them 1:1 on every ESO provider.
        dataFrom: [{ extract: { key: entry.remoteKey } }],
      },
    });
  }

  return manifests;
}

/** Apply the ESO manifests (idempotent kubectl apply). */
export async function applyEsoManifests(
  config: DeploymentConfig,
): Promise<string[]> {
  const manifests = buildEsoManifests(config);
  for (const manifest of manifests) {
    await execa("kubectl", ["apply", "-f", "-"], {
      input: JSON.stringify(manifest),
    });
  }
  return manifests.map((m) => {
    const meta = (m as { kind: string; metadata: { name: string } });
    return `${meta.kind}/${meta.metadata.name}`;
  });
}

interface ExternalSecretStatus {
  metadata?: { name?: string };
  status?: {
    conditions?: Array<{
      type?: string;
      status?: string;
      reason?: string;
      message?: string;
    }>;
  };
}

/**
 * Block until every deployment ExternalSecret reports Ready=True
 * (reason SecretSynced), so the Helm install never starts against missing
 * Secrets. Fails with the per-secret provider errors on timeout.
 */
export async function waitForExternalSecrets(
  config: DeploymentConfig,
  options: { timeoutSeconds?: number } = {},
): Promise<void> {
  const namespace = getNamespace(config.name);
  const expected = esoSecretEntries(config).map((entry) => entry.k8sName);
  const timeoutSeconds = options.timeoutSeconds ?? 120;
  const deadline = Date.now() + timeoutSeconds * 1000;

  let pending = new Map<string, string>();
  while (Date.now() < deadline) {
    pending = new Map();
    let items: ExternalSecretStatus[] = [];
    try {
      const result = await execa("kubectl", [
        "get",
        "externalsecret",
        "--namespace",
        namespace,
        "-o",
        "json",
      ]);
      items = (JSON.parse(result.stdout) as { items?: ExternalSecretStatus[] })
        .items ?? [];
    } catch {
      // Transient API error; retry until the deadline.
    }
    const byName = new Map(items.map((item) => [item.metadata?.name, item]));
    for (const name of expected) {
      const item = byName.get(name);
      const ready = item?.status?.conditions?.find((c) => c.type === "Ready");
      if (ready?.status !== "True") {
        pending.set(
          name,
          ready?.message?.trim() || "no status yet (waiting for first sync)",
        );
      }
    }
    if (pending.size === 0) return;
    await new Promise((resolve) => setTimeout(resolve, 3000));
  }

  const detail = [...pending.entries()]
    .map(([name, message]) => `  - ${name}: ${message}`)
    .join("\n");
  throw new Error(
    [
      `${pending.size} ExternalSecret(s) in ${namespace} did not reach SecretSynced within ${timeoutSeconds}s:`,
      detail,
      "",
      "Verify the provider entries exist and the ESO identity can read them",
      `(kubectl describe externalsecret -n ${namespace} for full sync errors),`,
      "then rerun the deploy.",
    ].join("\n"),
  );
}

/**
 * One-call ESO setup for the install sequence: seed, ensure operator, apply
 * manifests, and gate on the first sync.
 */
export async function setupExternalSecrets(
  config: DeploymentConfig,
  options: { overwriteSecrets: boolean },
): Promise<{ seeded: SeedSummary; operatorInstalled: boolean }> {
  const namespace = getNamespace(config.name);
  const seeded = await seedCloudSecrets(config, {
    overwrite: options.overwriteSecrets,
  });
  const { installed } = await ensureEsoOperator(namespace);
  await applyEsoManifests(config);
  await waitForExternalSecrets(config);
  return { seeded, operatorInstalled: installed };
}

/**
 * Remove the CLI-managed ESO resources at destroy time. Provider entries in
 * the secrets platform are never deleted - they are the client's system of
 * record; we print what remains instead.
 */
export async function removeEsoResources(
  config: DeploymentConfig,
): Promise<{ removed: string[]; remainingRemoteKeys: string[] }> {
  const namespace = getNamespace(config.name);
  const removed: string[] = [];
  const entries = esoSecretEntries(config);

  for (const entry of entries) {
    try {
      await execa("kubectl", [
        "delete",
        "externalsecret",
        entry.k8sName,
        "--namespace",
        namespace,
        "--ignore-not-found",
      ]);
      removed.push(`ExternalSecret/${entry.k8sName}`);
    } catch {
      // Namespace/cluster may already be gone; destroy is best-effort.
    }
  }
  if (config.secrets?.backend !== "byo-secret-store") {
    try {
      await execa("kubectl", [
        "delete",
        "secretstore",
        SECRET_STORE_NAME,
        "--namespace",
        namespace,
        "--ignore-not-found",
      ]);
      removed.push(`SecretStore/${SECRET_STORE_NAME}`);
    } catch {
      // Best-effort.
    }
  }
  const remainingRemoteKeys =
    config.secrets?.backend === "byo-secret-store"
      ? []
      : entries.map((entry) => entry.remoteKey);
  return { removed, remainingRemoteKeys };
}

/**
 * List (Cluster)SecretStores on the cluster - the byo-secret-store wizard
 * step offers these (with refresh) so users link the store they already run.
 */
export async function listSecretStores(namespace: string): Promise<
  Array<{ name: string; kind: "SecretStore" | "ClusterSecretStore" }>
> {
  const stores: Array<{
    name: string;
    kind: "SecretStore" | "ClusterSecretStore";
  }> = [];
  if (!(await esoCrdsPresent())) return stores;
  try {
    const cluster = await execa("kubectl", [
      "get",
      "clustersecretstore",
      "-o",
      "jsonpath={.items[*].metadata.name}",
    ]);
    for (const name of cluster.stdout.split(/\s+/).filter(Boolean)) {
      stores.push({ name, kind: "ClusterSecretStore" });
    }
  } catch {
    // CRD variant absent or no access; namespace stores below may still work.
  }
  try {
    const namespaced = await execa("kubectl", [
      "get",
      "secretstore",
      "--namespace",
      namespace,
      "-o",
      "jsonpath={.items[*].metadata.name}",
    ]);
    for (const name of namespaced.stdout.split(/\s+/).filter(Boolean)) {
      stores.push({ name, kind: "SecretStore" });
    }
  } catch {
    // Namespace may not exist yet.
  }
  return stores;
}

/** Human-readable summary of the entries a byo store must serve. */
export function describeRequiredEntries(config: DeploymentConfig): string {
  const lines = esoSecretEntries(config).map(
    (entry) =>
      `  ${entry.remoteKey}  (JSON object with keys: ${entry.keys.join(", ")})`,
  );
  return [
    "Your secret store must serve these entries (one JSON object each):",
    ...lines,
  ].join("\n");
}

/** Serialize the manifests for display/debugging. */
export function renderEsoManifests(config: DeploymentConfig): string {
  return buildEsoManifests(config)
    .map((manifest) => yaml.stringify(manifest))
    .join("---\n");
}
