/**
 * Deploy-time workload-identity federation.
 *
 * cluster-setup provisions the deployment-independent infrastructure (one
 * identity / role / service account, plus the bucket and DCR). The trust between
 * that identity and a specific Kubernetes ServiceAccount is namespace-scoped, so
 * it can only be created once the deployment namespace is known. This module
 * creates that trust at `rulebricks deploy` time, which keeps cluster-setup
 * generic and lets one cluster host many deployments.
 *
 *   Azure -> federated identity credential (subject = system:serviceaccount:ns:sa)
 *   AWS   -> EKS Pod Identity association (namespace + serviceAccount -> role)
 *   GCP   -> IAM workloadIdentityUser binding (member = ns/sa -> service account)
 *
 * All operations are idempotent, so it is safe to run on every deploy.
 */
import { exec } from "child_process";
import { promisify } from "util";
import {
  CloudProvider,
  DeploymentConfig,
  getNamespace,
  getReleaseName,
} from "../types/index.js";
import { approveCloudCommandOrThrow } from "./commandApproval.js";

const execAsync = promisify(exec);
const CLI_TIMEOUT = 60000;

export interface FederationOutcome {
  created: string[];
  existing: string[];
  skipped?: string;
}

interface ExecResult {
  stdout: string;
  stderr: string;
  code: number;
}

interface RunOptions {
  intent: string;
  provider: CloudProvider;
  mutating?: boolean;
}

async function run(command: string, options: RunOptions): Promise<ExecResult> {
  await approveCloudCommandOrThrow({
    command,
    intent: options.intent,
    provider: options.provider,
    mutating: options.mutating,
  });

  try {
    const { stdout, stderr } = await execAsync(command, { timeout: CLI_TIMEOUT });
    return { stdout, stderr, code: 0 };
  } catch (error: unknown) {
    const e = error as { stdout?: string; stderr?: string; message?: string; code?: number };
    return {
      stdout: e.stdout || "",
      stderr: e.stderr || e.message || "command failed",
      code: typeof e.code === "number" ? e.code : 1,
    };
  }
}

function shq(value: string): string {
  return `'${String(value).replace(/'/g, "'\\''")}'`;
}

/** A Kubernetes ServiceAccount that needs cloud access, plus the cloud principal it maps to. */
interface SubjectBinding {
  serviceAccount: string;
  // The cloud principal backing this SA: azure UAMI clientId, AWS role ARN, or GCP SA email.
  principal: string;
}

/**
 * The SAs that need workload-identity trust, given the deployment config. Vector
 * and the backup job use the storage identity; Prometheus uses the metrics
 * identity (the consolidated setup makes these the same principal, but we read
 * them independently so split setups still work).
 */
function plannedBindings(config: DeploymentConfig): SubjectBinding[] {
  const bindings: SubjectBinding[] = [];
  const storage = config.storage;
  const releaseName = getReleaseName(config.name);
  const usesSecretAuth = storage?.cloudAuthMode === "secret";

  const storagePrincipal =
    storage?.provider === "s3"
      ? storage.awsIamRoleArn
      : storage?.provider === "gcs"
        ? storage.gcpServiceAccountEmail
        : storage?.azureBlobClientId;

  if (storage && !usesSecretAuth && storagePrincipal) {
    bindings.push({ serviceAccount: "vector", principal: storagePrincipal });
    // ClickHouse reads the decision-log archive straight from object storage
    // (the rulebricks.decision_logs view / named collection), so it needs the
    // same storage identity as Vector. Without this trust the cloud IdP rejects
    // ClickHouse's token and every decision_logs query fails to authenticate.
    bindings.push({
      serviceAccount: `${releaseName}-clickhouse`,
      principal: storagePrincipal,
    });
    if (config.backup?.enabled && config.database.type === "self-hosted") {
      bindings.push({
        serviceAccount: `${releaseName}-backup`,
        principal: storagePrincipal,
      });
    }
  }

  const rw = config.features.monitoring?.remoteWrite;
  const metricsPrincipal =
    rw?.destination === "aws-amp"
      ? rw.awsRoleArn
      : rw?.authType === "workload-identity"
        ? rw.clientId
        : undefined;
  if (
    config.features.monitoring?.enabled &&
    rw &&
    rw.destination !== "generic" &&
    rw.destination !== "grafana-cloud" &&
    metricsPrincipal
  ) {
    bindings.push({ serviceAccount: "prometheus", principal: metricsPrincipal });
  }

  return bindings;
}

/**
 * Ensures the per-namespace workload-identity trust exists for this deployment.
 * No-op (with a `skipped` reason) for non-cloud providers or secret-based auth.
 */
export async function ensureWorkloadIdentityFederation(
  config: DeploymentConfig,
): Promise<FederationOutcome> {
  const provider = config.infrastructure.provider;
  if (provider !== "azure" && provider !== "aws" && provider !== "gcp") {
    return { created: [], existing: [], skipped: "non-cloud provider" };
  }

  const bindings = plannedBindings(config);
  if (bindings.length === 0) {
    return { created: [], existing: [], skipped: "no workload-identity service accounts" };
  }

  const namespace = getNamespace(config.name);
  switch (provider) {
    case "azure":
      return ensureAzure(config, namespace, bindings);
    case "aws":
      return ensureAws(config, namespace, bindings);
    case "gcp":
      return ensureGcp(config, namespace, bindings);
    default:
      return { created: [], existing: [], skipped: "non-cloud provider" };
  }
}

// ---------------------------------------------------------------------------
// Azure: federated identity credentials on the user-assigned managed identity
// ---------------------------------------------------------------------------
async function ensureAzure(
  config: DeploymentConfig,
  namespace: string,
  bindings: SubjectBinding[],
): Promise<FederationOutcome> {
  const rg = config.infrastructure.azureResourceGroup;
  const cluster = config.infrastructure.clusterName;
  if (!rg || !cluster) {
    throw new Error(
      "Azure resource group and cluster name are required to create federated credentials.",
    );
  }

  const intent = "Configure workload identity (Azure)";
  const issuerRes = await run(
    `az aks show --name ${shq(cluster)} --resource-group ${shq(rg)} --query oidcIssuerProfile.issuerUrl --output tsv`,
    { intent, provider: "azure" },
  );
  const issuer = issuerRes.stdout.trim();
  if (!issuer) {
    throw new Error(
      `Could not read the AKS OIDC issuer for ${cluster}/${rg}. Ensure the cluster has the OIDC issuer enabled. (${issuerRes.stderr.trim()})`,
    );
  }

  // Resolve identity name once per distinct clientId (principal).
  const identityNameByClientId = new Map<string, string>();
  const created: string[] = [];
  const existing: string[] = [];

  for (const binding of bindings) {
    const clientId = binding.principal;
    let identityName = identityNameByClientId.get(clientId);
    if (!identityName) {
      const nameRes = await run(
        `az identity list --resource-group ${shq(rg)} --query "[?clientId=='${clientId}'].name | [0]" --output tsv`,
        { intent, provider: "azure" },
      );
      identityName = nameRes.stdout.trim();
      if (!identityName) {
        throw new Error(
          `No user-assigned identity with client ID ${clientId} found in resource group ${rg}. Run cluster-setup first.`,
        );
      }
      identityNameByClientId.set(clientId, identityName);
    }

    const subject = `system:serviceaccount:${namespace}:${binding.serviceAccount}`;
    // Unique per (namespace, SA) so several deployments can share one identity.
    const ficName = `${namespace}-${binding.serviceAccount}`.slice(0, 120);

    const listRes = await run(
      `az identity federated-credential list --identity-name ${shq(identityName)} --resource-group ${shq(rg)} --query "[?subject=='${subject}'] | length(@)" --output tsv`,
      { intent, provider: "azure" },
    );
    if (listRes.stdout.trim() !== "0" && listRes.stdout.trim() !== "") {
      existing.push(subject);
      continue;
    }

    const createRes = await run(
      `az identity federated-credential create --name ${shq(ficName)} ` +
        `--identity-name ${shq(identityName)} --resource-group ${shq(rg)} ` +
        `--issuer ${shq(issuer)} --subject ${shq(subject)} ` +
        `--audiences api://AzureADTokenExchange`,
      { intent, provider: "azure", mutating: true },
    );
    if (createRes.code !== 0) {
      throw new Error(
        `Failed to create federated credential for ${subject}: ${createRes.stderr.trim()}`,
      );
    }
    created.push(subject);
  }

  return { created, existing };
}

// ---------------------------------------------------------------------------
// AWS: EKS Pod Identity associations
// ---------------------------------------------------------------------------
async function ensureAws(
  config: DeploymentConfig,
  namespace: string,
  bindings: SubjectBinding[],
): Promise<FederationOutcome> {
  const cluster = config.infrastructure.clusterName;
  const region = config.infrastructure.region;
  if (!cluster || !region) {
    throw new Error(
      "EKS cluster name and region are required to create Pod Identity associations.",
    );
  }

  const created: string[] = [];
  const existing: string[] = [];
  const intent = "Configure workload identity (AWS)";

  for (const binding of bindings) {
    const roleArn = binding.principal;
    const subject = `${namespace}/${binding.serviceAccount}`;

    const listRes = await run(
      `aws eks list-pod-identity-associations --cluster-name ${shq(cluster)} ` +
        `--namespace ${shq(namespace)} --service-account ${shq(binding.serviceAccount)} ` +
        `--region ${shq(region)} --query "associations | length(@)" --output text`,
      { intent, provider: "aws" },
    );
    if (listRes.code === 0 && listRes.stdout.trim() !== "0" && listRes.stdout.trim() !== "") {
      existing.push(subject);
      continue;
    }

    const createRes = await run(
      `aws eks create-pod-identity-association --cluster-name ${shq(cluster)} ` +
        `--namespace ${shq(namespace)} --service-account ${shq(binding.serviceAccount)} ` +
        `--role-arn ${shq(roleArn)} --region ${shq(region)}`,
      { intent, provider: "aws", mutating: true },
    );
    if (createRes.code !== 0) {
      // Treat an existing association as success (race / prior run).
      if (/ResourceInUse|already exists/i.test(createRes.stderr)) {
        existing.push(subject);
        continue;
      }
      throw new Error(
        `Failed to create Pod Identity association for ${subject}: ${createRes.stderr.trim()}`,
      );
    }
    created.push(subject);
  }

  return { created, existing };
}

// ---------------------------------------------------------------------------
// GCP: IAM workloadIdentityUser bindings on the Google service account
// ---------------------------------------------------------------------------
async function ensureGcp(
  config: DeploymentConfig,
  namespace: string,
  bindings: SubjectBinding[],
): Promise<FederationOutcome> {
  const project = config.infrastructure.gcpProjectId;
  if (!project) {
    throw new Error(
      "GCP project ID is required to create Workload Identity bindings.",
    );
  }

  const created: string[] = [];
  const intent = "Configure workload identity (GCP)";

  for (const binding of bindings) {
    const gsa = binding.principal;
    const member = `serviceAccount:${project}.svc.id.goog[${namespace}/${binding.serviceAccount}]`;

    // add-iam-policy-binding is idempotent; re-adding an existing member is a no-op.
    const res = await run(
      `gcloud iam service-accounts add-iam-policy-binding ${shq(gsa)} ` +
        `--project ${shq(project)} --role roles/iam.workloadIdentityUser ` +
        `--member ${shq(member)} --quiet`,
      { intent, provider: "gcp", mutating: true },
    );
    if (res.code !== 0) {
      throw new Error(
        `Failed to bind Workload Identity for ${namespace}/${binding.serviceAccount}: ${res.stderr.trim()}`,
      );
    }
    created.push(`${namespace}/${binding.serviceAccount}`);
  }

  return { created, existing: [] };
}
