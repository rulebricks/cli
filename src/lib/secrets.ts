// Kubernetes Secret management for k8s secret mode.
//
// In k8s mode the CLI creates or merge-patches the deployment's Secrets and the
// generated values.yaml carries only secretRef
// references; no plaintext secrets on disk or in the Helm release. Secret names
// come from deploymentSecretNames() so they always match the secretRef seams the
// value generator writes.
import { execa } from "execa";
import {
  DeploymentConfig,
  getReleaseName,
} from "../types/index.js";
import {
  signSupabaseJwt,
  deriveRealtimeSecrets,
  deploymentSecretNames,
} from "./helmValues.js";
import {
  forceReleaseStuckNamespaceFinalizers,
  getNamespacePhase,
  waitForNamespaceDeletion,
} from "./kubernetes.js";
import { isKubernetesForbiddenError } from "./cloudErrors.js";

export interface K8sSecretManifest {
  name: string;
  stringData: Record<string, string>;
}

export interface DeploymentSecretInventoryEntry {
  name: string;
  /** Every key this CLI may own in the Secret, including currently inactive keys. */
  knownKeys: string[];
}

const APP_SECRET_KEYS = [
  "LICENSE_KEY",
  "EMAIL",
  "SMTP_USER",
  "SMTP_PASS",
  "SUPABASE_ANON_KEY",
  "SUPABASE_SERVICE_KEY",
  "SUPABASE_SECRET_KEY",
  "SUPABASE_ACCESS_TOKEN",
  "JWT_SECRET",
  "SSO_CLIENT_ID",
  "SSO_CLIENT_SECRET",
  "REDIS_PASSWORD",
  "KAFKA_SASL_USERNAME",
  "KAFKA_SASL_PASSWORD",
];

/**
 * Stable inventory of every Secret and key the CLI may create for a deployment.
 * This is intentionally broader than buildDeploymentSecrets(): inactive entries
 * let upgrades remove only known CLI-owned keys/resources without touching a
 * customer's unrelated Secrets or custom keys.
 */
export function deploymentSecretInventory(
  config: DeploymentConfig,
): DeploymentSecretInventoryEntry[] {
  const names = deploymentSecretNames(config);
  return [
    { name: names.app, knownKeys: [...APP_SECRET_KEYS] },
    {
      name: names.db,
      knownKeys: ["username", "password", "database", "host", "port"],
    },
    {
      name: names.dbBootstrap,
      knownKeys: ["master-username", "master-password", "service-password"],
    },
    {
      name: names.jwt,
      knownKeys: ["secret", "anonKey", "serviceKey"],
    },
    { name: names.dashboard, knownKeys: ["username", "password"] },
    {
      name: names.realtime,
      knownKeys: ["SECRET_KEY_BASE", "DB_ENC_KEY"],
    },
    { name: names.smtp, knownKeys: ["username", "password"] },
    { name: names.smtpRelay, knownKeys: ["connection-string"] },
  ];
}

/** Labels used to distinguish deployment-owned resources from BYO/custom refs. */
export function deploymentSecretLabels(
  config: DeploymentConfig,
): Record<string, string> {
  return {
    "app.kubernetes.io/managed-by": "rulebricks-cli",
    "app.kubernetes.io/instance": getReleaseName(config.name),
    "rulebricks.io/resource-purpose": "deployment-secret",
  };
}

export function obsoleteDeploymentSecretNames(
  config: DeploymentConfig,
): string[] {
  const active = new Set(buildDeploymentSecrets(config).map((secret) => secret.name));
  return deploymentSecretInventory(config)
    .map((entry) => entry.name)
    .filter((name) => !active.has(name));
}

/**
 * Build the Kubernetes Secret manifests for a deployment. Only includes values
 * that are actually set. Supabase anon/service keys are derived from the JWT
 * secret (HS256), matching self-hosted Supabase.
 */
export function buildDeploymentSecrets(
  config: DeploymentConfig,
): K8sSecretManifest[] {
  const names = deploymentSecretNames(config);
  const out: K8sSecretManifest[] = [];

  // Consolidated app secret (global.secrets.secretRef).
  const app: Record<string, string> = {};
  const put = (k: string, v?: string) => {
    if (v) app[k] = v;
  };
  put("LICENSE_KEY", config.licenseKey);
  put("EMAIL", config.adminEmail);
  put("SMTP_USER", config.smtp?.user);
  put("SMTP_PASS", config.smtp?.pass);
  // ACS API-key relay mode runs SMTP credential-less, but the app deployment
  // mounts SMTP_USER/SMTP_PASS from this secret unconditionally - the keys
  // must exist (empty) or the pod fails with CreateContainerConfigError.
  // Force-empty regardless of any stale user/pass still present on the config
  // object: GoTrue refuses plaintext SMTP AUTH to non-localhost hosts and the
  // relay ignores credentials, so non-empty values break every auth email.
  // normalizeSmtpConfig scrubs persisted configs; this builder is the last
  // line of defense for the applied/seeded secrets.
  if (config.smtp?.acsApi) {
    app.SMTP_USER = "";
    app.SMTP_PASS = "";
  }
  if (config.database.type === "supabase-cloud") {
    put("SUPABASE_ANON_KEY", config.database.supabaseAnonKey);
    put("SUPABASE_SERVICE_KEY", config.database.supabaseServiceKey);
    put("SUPABASE_SECRET_KEY", config.database.supabaseServiceKey);
    put("SUPABASE_ACCESS_TOKEN", config.database.supabaseAccessToken);
  } else if (config.database.supabaseJwtSecret) {
    const jwt = config.database.supabaseJwtSecret;
    put("SUPABASE_ANON_KEY", signSupabaseJwt("anon", jwt));
    put("SUPABASE_SERVICE_KEY", signSupabaseJwt("service_role", jwt));
    put("SUPABASE_SECRET_KEY", signSupabaseJwt("service_role", jwt));
    put("JWT_SECRET", jwt);
  }
  if (config.features.sso.enabled) {
    put("SSO_CLIENT_ID", config.features.sso.clientId);
    put("SSO_CLIENT_SECRET", config.features.sso.clientSecret);
  }
  const redis = config.externalServices?.redis?.external;
  if (redis?.password) put("REDIS_PASSWORD", redis.password);
  const kafkaSasl = config.externalServices?.kafka?.external?.sasl;
  if (kafkaSasl?.username) put("KAFKA_SASL_USERNAME", kafkaSasl.username);
  if (kafkaSasl?.password) put("KAFKA_SASL_PASSWORD", kafkaSasl.password);
  if (Object.keys(app).length > 0) {
    out.push({ name: names.app, stringData: app });
  }

  // Supabase self-hosted component secrets (each maps to a supabase.secret.*.secretRef).
  if (config.database.type === "self-hosted") {
    const pgExt =
      config.externalServices?.postgres?.mode === "external"
        ? config.externalServices.postgres.external
        : undefined;
    const dbStringData: Record<string, string> = {
      username: "postgres",
      password: config.database.supabaseDbPassword ?? "",
      database: pgExt?.database ?? "postgres",
    };
    if (pgExt) {
      dbStringData.host = pgExt.host ?? "";
      dbStringData.port = String(pgExt.port ?? 5432);
    }
    out.push({
      name: names.db,
      stringData: dbStringData,
    });
    if (pgExt) {
      out.push({
        name: names.dbBootstrap,
        stringData: {
          "master-username": pgExt.bootstrap?.masterUsername ?? "postgres",
          "master-password": pgExt.bootstrap?.masterPassword ?? "",
          "service-password": config.database.supabaseDbPassword ?? "",
        },
      });
    }
    const jwt = config.database.supabaseJwtSecret ?? "";
    out.push({
      name: names.jwt,
      stringData: {
        secret: jwt,
        anonKey: jwt ? signSupabaseJwt("anon", jwt) : "",
        serviceKey: jwt ? signSupabaseJwt("service_role", jwt) : "",
      },
    });
    out.push({
      name: names.dashboard,
      stringData: {
        username: config.database.supabaseDashboardUser || "supabase",
        password: config.database.supabaseDashboardPass ?? "",
      },
    });
    const rt = deriveRealtimeSecrets(jwt);
    out.push({
      name: names.realtime,
      stringData: { SECRET_KEY_BASE: rt.secretKeyBase, DB_ENC_KEY: rt.dbEncKey },
    });
    // Supabase auth (GoTrue) SMTP. Also created in the ACS API-key relay
    // mode with EMPTY username/password: existing deployments already have
    // this Secret owned by the CLI/ESO, and dropping the secretRef would
    // make the subchart render its own Secret under the SAME name - a helm
    // ownership conflict on upgrade (plus a stale ExternalSecret re-syncing
    // the old credentials over it). Keeping the seam preserves ownership;
    // GoTrue skips SMTP AUTH when the mounted username is empty.
    if (config.smtp?.user || config.smtp?.pass || config.smtp?.acsApi) {
      // In ACS relay mode the credentials are forced empty even if a stale
      // config still carries them (see the app-secret block above): the
      // ESO seeding reconciles known keys to these values, so this is also
      // what scrubs an old vault entry back to credential-less.
      const credentialless = Boolean(config.smtp?.acsApi);
      out.push({
        name: names.smtp,
        stringData: {
          username: credentialless ? "" : (config.smtp.user ?? ""),
          password: credentialless ? "" : (config.smtp.pass ?? ""),
        },
      });
    }
  }

  // ACS API-key mode: the in-cluster SMTP relay's connection string
  // (referenced by the generated values as smtpRelay.existingSecret).
  if (config.smtp?.acsApi?.connectionString) {
    out.push({
      name: names.smtpRelay,
      stringData: {
        "connection-string": config.smtp.acsApi.connectionString,
      },
    });
  }

  return out;
}

function secretManifest(
  name: string,
  namespace: string,
  stringData: Record<string, string>,
  labels?: Record<string, string>,
): Record<string, unknown> {
  return {
    apiVersion: "v1",
    kind: "Secret",
    type: "Opaque",
    metadata: {
      name,
      namespace,
      ...(labels ? { labels } : {}),
    },
    stringData,
  };
}

/**
 * Idempotently ensure the namespace exists so Secrets can be applied before Helm
 * runs (`helm upgrade --install --create-namespace` also creates it, but that
 * happens after this step).
 *
 * A namespace left Terminating by a recent destroy rejects all new content
 * ("unable to create new content in namespace ... because it is being
 * terminated"), so wait out the deletion first - rescuing orphaned finalizers
 * if it wedges - and recreate fresh.
 */
export async function ensureNamespace(namespace: string): Promise<void> {
  if ((await getNamespacePhase(namespace)) === "terminating") {
    let gone = await waitForNamespaceDeletion(namespace, 5 * 60_000);
    if (!gone) {
      await forceReleaseStuckNamespaceFinalizers(namespace);
      gone = await waitForNamespaceDeletion(namespace, 2 * 60_000);
    }
    if (!gone) {
      throw new Error(
        `Namespace ${namespace} is stuck terminating (a previous destroy has not finished); ` +
          `inspect 'kubectl get namespace ${namespace} -o yaml' conditions and retry.`,
      );
    }
  }

  const manifest = {
    apiVersion: "v1",
    kind: "Namespace",
    metadata: { name: namespace },
  };
  try {
    await execa("kubectl", ["apply", "-f", "-"], {
      input: JSON.stringify(manifest),
    });
  } catch (error) {
    const detail =
      error && typeof error === "object" && "stderr" in error
        ? String((error as { stderr?: string }).stderr ?? "")
        : error instanceof Error
          ? error.message
          : String(error);
    if (isKubernetesForbiddenError(detail)) {
      throw new Error(
        [
          `No permission to create the namespace ${namespace}. Ask your platform team to run:`,
          `  kubectl create namespace ${namespace}`,
          `  kubectl create rolebinding rulebricks-deployer --clusterrole=admin --user=<your-user> --namespace ${namespace}`,
          "Then rerun the deploy.",
        ].join("\n"),
      );
    }
    throw error;
  }
}

/**
 * external-dns's Azure provider reads its target subscription and DNS-zone
 * resource group from an azure.json file; with useWorkloadIdentityExtension it
 * authenticates via the federated ServiceAccount instead of static
 * credentials. Deploy creates this Secret when dns.autoManage targets Azure
 * DNS; the external-dns values mount it at /etc/kubernetes (the provider's
 * default config path).
 */
export async function applyExternalDnsAzureConfig(
  namespace: string,
  input: { tenantId: string; subscriptionId: string; resourceGroup: string },
): Promise<void> {
  const azureJson = {
    tenantId: input.tenantId,
    subscriptionId: input.subscriptionId,
    resourceGroup: input.resourceGroup,
    useWorkloadIdentityExtension: true,
  };
  await execa("kubectl", ["apply", "-f", "-"], {
    input: JSON.stringify(
      secretManifest("external-dns-azure-config", namespace, {
        "azure.json": JSON.stringify(azureJson),
      }),
    ),
  });
}

/**
 * Bring-your-own certificates: create/update the kubernetes.io/tls Secrets
 * each ingress expects, from the operator's PEM material (planned by
 * tlsCerts.planTlsSecrets). Applied in every secret mode - TLS material is
 * ingress plumbing, not an application secret, so it never routes through a
 * managed secrets backend. `kubectl apply` upserts, which is also the
 * rotation path: rerun deploy with renewed files and Traefik hot-reloads.
 */
export async function applyProvidedTlsSecrets(
  namespace: string,
  entries: Array<{ secretName: string; certPem: string; keyPem: string }>,
): Promise<void> {
  for (const entry of entries) {
    await execa("kubectl", ["apply", "-f", "-"], {
      input: JSON.stringify({
        apiVersion: "v1",
        kind: "Secret",
        type: "kubernetes.io/tls",
        metadata: { name: entry.secretName, namespace },
        stringData: {
          "tls.crt": entry.certPem,
          "tls.key": entry.keyPem,
        },
      }),
    });
  }
}

/**
 * Build a merge patch that updates every active CLI-owned value, removes known
 * keys that are no longer active, and leaves unknown customer-added keys alone.
 */
export function buildDeploymentSecretMergePatch(
  config: DeploymentConfig,
  secret: K8sSecretManifest,
): Record<string, unknown> {
  const inventory = deploymentSecretInventory(config).find(
    (entry) => entry.name === secret.name,
  );
  if (!inventory) {
    throw new Error(`No CLI secret inventory entry exists for ${secret.name}.`);
  }

  const data: Record<string, string | null> = {};
  for (const key of inventory.knownKeys) {
    data[key] =
      key in secret.stringData
        ? Buffer.from(secret.stringData[key], "utf8").toString("base64")
        : null;
  }
  return {
    metadata: { labels: deploymentSecretLabels(config) },
    data,
  };
}

interface KubernetesResource {
  kind?: string;
  data?: Record<string, unknown>;
  stringData?: Record<string, unknown>;
  metadata?: {
    name?: string;
    labels?: Record<string, string>;
    annotations?: Record<string, string>;
  };
}

function commandErrorDetail(error: unknown): string {
  if (error && typeof error === "object" && "stderr" in error) {
    return String((error as { stderr?: string }).stderr ?? "");
  }
  return error instanceof Error ? error.message : String(error);
}

function isMissingKubernetesResource(error: unknown): boolean {
  return /not found|NotFound|the server doesn't have a resource type|no matches for kind/i.test(
    commandErrorDetail(error),
  );
}

async function readKubernetesResource(
  kind: string,
  name: string,
  namespace: string,
): Promise<KubernetesResource | null> {
  try {
    const { stdout } = await execa("kubectl", [
      "get",
      kind,
      name,
      "--namespace",
      namespace,
      "-o",
      "json",
    ]);
    return JSON.parse(stdout) as KubernetesResource;
  } catch (error) {
    if (isMissingKubernetesResource(error)) return null;
    throw error;
  }
}

/**
 * Recognize current labeled resources and unlabeled resources created by older
 * CLI versions via their deterministic name + kubectl last-applied annotation.
 */
export function isDeploymentOwnedSecretResource(
  config: DeploymentConfig,
  resource: KubernetesResource,
  expectedKind: "Secret" | "ExternalSecret",
  expectedName: string,
): boolean {
  const metadata = resource.metadata;
  if (metadata?.name !== expectedName) return false;
  const labels = metadata.labels ?? {};
  const expectedLabels = deploymentSecretLabels(config);
  if (
    labels["app.kubernetes.io/managed-by"] ===
      expectedLabels["app.kubernetes.io/managed-by"] &&
    labels["app.kubernetes.io/instance"] ===
      expectedLabels["app.kubernetes.io/instance"]
  ) {
    return true;
  }

  const lastApplied =
    metadata.annotations?.["kubectl.kubernetes.io/last-applied-configuration"];
  if (!lastApplied) return false;
  try {
    const applied = JSON.parse(lastApplied) as KubernetesResource;
    if (
      applied.kind !== expectedKind ||
      applied.metadata?.name !== expectedName
    ) {
      return false;
    }
    if (expectedKind === "ExternalSecret") return true;

    const inventory = deploymentSecretInventory(config).find(
      (entry) => entry.name === expectedName,
    );
    const appliedKeys = Object.keys(applied.stringData ?? applied.data ?? {});
    const knownKeys = new Set(inventory?.knownKeys ?? []);
    return (
      appliedKeys.length > 0 && appliedKeys.every((key) => knownKeys.has(key))
    );
  } catch {
    return false;
  }
}

async function deleteOwnedResource(
  config: DeploymentConfig,
  kind: "secret" | "externalsecret",
  name: string,
  namespace: string,
): Promise<boolean> {
  const resource = await readKubernetesResource(kind, name, namespace);
  if (
    !resource ||
    !isDeploymentOwnedSecretResource(
      config,
      resource,
      kind === "secret" ? "Secret" : "ExternalSecret",
      name,
    )
  ) {
    return false;
  }
  await execa("kubectl", [
    "delete",
    kind,
    name,
    "--namespace",
    namespace,
    "--ignore-not-found",
    "--cascade=foreground",
    "--wait=true",
    "--timeout=60s",
  ]);
  return true;
}

/**
 * A switch from ESO to cluster mode must detach the old CLI-owned consumers
 * before patching their target Secrets, otherwise ESO can immediately restore
 * obsolete cloud values. Foreground deletion also lets ESO's owned targets be
 * garbage-collected before the CLI recreates them. Custom ExternalSecrets are
 * never selected.
 */
async function detachDeploymentExternalSecrets(
  config: DeploymentConfig,
  namespace: string,
): Promise<void> {
  for (const entry of deploymentSecretInventory(config)) {
    await deleteOwnedResource(
      config,
      "externalsecret",
      entry.name,
      namespace,
    );
  }
}

/** Remove inactive in-cluster Secrets only when CLI ownership is provable. */
export async function pruneObsoleteDeploymentSecrets(
  config: DeploymentConfig,
  namespace: string,
): Promise<string[]> {
  const removed: string[] = [];
  for (const name of obsoleteDeploymentSecretNames(config)) {
    if (await deleteOwnedResource(config, "secret", name, namespace)) {
      removed.push(name);
    }
  }
  return removed;
}

/**
 * Create/update active Kubernetes Secrets and prune obsolete deployment-owned
 * Secrets. Merge patches reconcile all known CLI keys while preserving unknown
 * keys; pruning is restricted to deterministic names carrying CLI ownership
 * labels (or the old CLI's last-applied marker), so BYO/custom refs are safe.
 */
export async function applyDeploymentSecrets(
  config: DeploymentConfig,
  namespace: string,
): Promise<string[]> {
  await detachDeploymentExternalSecrets(config, namespace);

  const secrets = buildDeploymentSecrets(config);
  const labels = deploymentSecretLabels(config);
  for (const s of secrets) {
    const existing = await readKubernetesResource("secret", s.name, namespace);
    if (existing) {
      await execa(
        "kubectl",
        [
          "patch",
          "secret",
          s.name,
          "--namespace",
          namespace,
          "--type=merge",
          "--patch-file=/dev/stdin",
        ],
        {
          input: JSON.stringify(buildDeploymentSecretMergePatch(config, s)),
        },
      );
    } else {
      await execa("kubectl", ["create", "-f", "-"], {
        input: JSON.stringify(
          secretManifest(s.name, namespace, s.stringData, labels),
        ),
      });
    }
  }

  await pruneObsoleteDeploymentSecrets(config, namespace);
  return secrets.map((s) => s.name);
}
