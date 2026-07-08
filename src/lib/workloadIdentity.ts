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

export interface FederationRemovalOutcome {
  removed: string[];
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

export function isAwsPodIdentityCliUnsupported(stderr: string): boolean {
  return (
    /Invalid choice/i.test(stderr) &&
    !/list-pod-identity-associations|create-pod-identity-association/i.test(
      stderr,
    )
  );
}

export function isAwsPodIdentityTrustPolicyInvalid(stderr: string): boolean {
  return /InvalidParameterException/i.test(stderr) && /Trust policy/i.test(stderr);
}

/**
 * True when an IAM trust policy document (as returned by `aws iam get-role`)
 * allows the EKS Pod Identity service principal to assume the role. This is
 * what distinguishes a workload role from e.g. an EKS control-plane role
 * (trusts eks.amazonaws.com) or a legacy IRSA role (Federated OIDC trust).
 */
export function awsTrustPolicyAllowsPodIdentity(document: unknown): boolean {
  if (!document || typeof document !== "object") return false;
  const statements = (document as { Statement?: unknown }).Statement;
  const list = Array.isArray(statements)
    ? statements
    : statements
      ? [statements]
      : [];
  return list.some((statement) => {
    if (!statement || typeof statement !== "object") return false;
    const s = statement as {
      Effect?: unknown;
      Principal?: { Service?: unknown };
      Action?: unknown;
    };
    if (s.Effect !== "Allow") return false;
    const service = s.Principal?.Service;
    const services = Array.isArray(service) ? service : [service];
    if (!services.includes("pods.eks.amazonaws.com")) return false;
    const action = s.Action;
    const actions = Array.isArray(action) ? action : [action];
    return actions.some(
      (a) => a === "sts:AssumeRole" || a === "sts:*" || a === "*",
    );
  });
}

/** Extracts the role name from an IAM role ARN (path segments dropped). */
export function awsRoleNameFromArn(roleArn: string): string {
  const afterRole = roleArn.split(":role/")[1] ?? roleArn;
  const segments = afterRole.split("/");
  return segments[segments.length - 1] || roleArn;
}

function awsPodIdentityUnsupportedMessage(stderr: string): string {
  const detail = stderr.trim().split("\n").slice(0, 4).join("\n");
  return [
    "Your installed AWS CLI does not support EKS Pod Identity association commands.",
    "",
    "Rulebricks AWS cluster setup uses EKS Pod Identity, so deploy needs AWS CLI v2 with:",
    "  aws eks list-pod-identity-associations",
    "  aws eks create-pod-identity-association",
    "",
    "Update or install AWS CLI v2, then rerun the deploy/init command.",
    "",
    "First check which AWS CLI your shell is using:",
    "  which aws && aws --version",
    "",
    "On macOS with Homebrew:",
    "  brew install awscli",
    "  # or, if Homebrew already owns it:",
    "  brew upgrade awscli",
    "",
    "Or install the official AWS CLI v2 package:",
    "  curl \"https://awscli.amazonaws.com/AWSCLIV2.pkg\" -o \"/tmp/AWSCLIV2.pkg\"",
    "  sudo installer -pkg /tmp/AWSCLIV2.pkg -target /",
    "",
    "If aws --version still shows an older binary after installing, update your PATH so the new aws comes first.",
    "",
    detail ? `AWS CLI output:\n${detail}` : "",
  ]
    .filter(Boolean)
    .join("\n");
}

function awsPodIdentityAgentMissingMessage(
  cluster: string,
  region: string,
): string {
  return [
    `The EKS cluster ${cluster} does not have the eks-pod-identity-agent add-on installed.`,
    "",
    "Rulebricks binds workload IAM roles through EKS Pod Identity. Without the",
    "agent, the associations are created but pods never receive credentials,",
    "which surfaces later as authorization errors at runtime.",
    "",
    "Clusters provisioned by Rulebricks cluster-setup include the add-on. For a",
    "bring-your-own cluster, install it and rerun the deploy:",
    `  aws eks create-addon --cluster-name ${cluster} --addon-name eks-pod-identity-agent --region ${region}`,
  ].join("\n");
}

function awsPodIdentityInvalidTrustMessage(input: {
  stderr: string;
  subject: string;
  roleArn: string;
  cluster: string;
}): string {
  const expectedRole = `${input.cluster}-rulebricks`;
  const detail = input.stderr.trim();
  return [
    `The IAM role selected for ${input.subject} cannot be used with EKS Pod Identity.`,
    "",
    `Selected role: ${input.roleArn}`,
    `Expected role from Rulebricks cluster-setup: ${expectedRole}`,
    "",
    "The role trust policy must allow the EKS Pod Identity service principal:",
    "  Principal: { Service: pods.eks.amazonaws.com }",
    "  Actions: sts:AssumeRole and sts:TagSession",
    "",
    "Fix by selecting the RulebricksRoleArn output from the AWS cluster-setup stack,",
    `or update that role's trust policy to match cluster-setup/aws/rulebricks-cluster.cfn.yaml.`,
    "",
    detail ? `AWS CLI output:\n${detail}` : "",
  ]
    .filter(Boolean)
    .join("\n");
}

/** A Kubernetes ServiceAccount that needs cloud access, plus the cloud principal it maps to. */
interface SubjectBinding {
  serviceAccount: string;
  // The cloud principal backing this SA: azure UAMI clientId, AWS role ARN, or GCP SA email.
  principal: string;
}

/**
 * The SAs that talk directly to a token-auth managed broker: HPS + the worker
 * fleet produce/consume, the kafka-topic-provision pre-install hook creates
 * topics. Shared between plannedBindings and the manual-association preflight
 * so the two can never drift.
 */
export function kafkaWorkloadServiceAccounts(releaseName: string): string[] {
  return [
    `${releaseName}-hps`,
    `${releaseName}-hps-worker`,
    `${releaseName}-kafka-topic-provision`,
  ];
}

/**
 * The SAs that need workload-identity trust, given the deployment config. Vector
 * and the backup job use the storage identity; Prometheus uses the metrics
 * identity (the consolidated setup makes these the same principal, but we read
 * them independently so split setups still work).
 */
export function plannedBindings(config: DeploymentConfig): SubjectBinding[] {
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

  // Workloads that talk directly to the managed broker each need the Kafka cloud
  // identity under a token mechanism (AWS MSK IAM / GCP OAUTHBEARER). We give each
  // its OWN service account and bind it here via Pod Identity - the chart no
  // longer stamps an eks.amazonaws.com/role-arn annotation, so the association is
  // the single source of credentials (no IRSA/annotation tug-of-war on a shared
  // SA). HPS + the worker fleet produce/consume; the kafka-topic-provision
  // pre-install hook creates the topics. (When no identity role is set the broker
  // uses SCRAM/PLAIN secret auth, so there is no principal to bind.)
  const kafka = config.externalServices?.kafka;
  const kafkaPrincipal =
    kafka?.mode === "external"
      ? (kafka.external?.identity?.awsRoleArn ??
        kafka.external?.identity?.gcpServiceAccountEmail ??
        kafka.external?.identity?.azureClientId)
      : undefined;
  if (kafkaPrincipal) {
    for (const serviceAccount of kafkaWorkloadServiceAccounts(releaseName)) {
      bindings.push({ serviceAccount, principal: kafkaPrincipal });
    }
  }

  // Under AWS MSK IAM the KEDA operator also authenticates to the broker
  // directly (the lag triggers use a podIdentity TriggerAuthentication), so
  // it needs the same role. kafka-exporter is deliberately NOT bound here:
  // it only supports IRSA, not Pod Identity (kafka_exporter#494), so an
  // association would leave it crashlooping.
  const kafkaUsesAwsIam =
    kafka?.mode === "external" &&
    (kafka.external?.preset === "aws-msk-iam" ||
      kafka.external?.sasl?.mechanism === "aws-iam");
  const kafkaAwsRole = kafka?.external?.identity?.awsRoleArn;
  if (kafkaUsesAwsIam && kafkaAwsRole) {
    // Fixed SA name from the bundled KEDA subchart (serviceAccount.operator.name).
    bindings.push({ serviceAccount: "keda-operator", principal: kafkaAwsRole });
  }

  const rw = config.features.monitoring?.remoteWrite;
  const metricsPrincipal =
    rw?.destination === "aws-amp"
      ? rw.awsRoleArn
      : rw?.authType === "workload-identity"
        ? rw.clientId
        : undefined;
  if (
    rw &&
    rw.destination !== "generic" &&
    rw.destination !== "grafana-cloud" &&
    metricsPrincipal
  ) {
    bindings.push({ serviceAccount: "prometheus", principal: metricsPrincipal });
  }

  return bindings;
}

/** External Kafka under MSK IAM with no explicit identity role configured. */
function kafkaUsesAwsIamWithoutRole(config: DeploymentConfig): boolean {
  const kafka = config.externalServices?.kafka;
  const usesAwsIam =
    kafka?.mode === "external" &&
    (kafka.external?.preset === "aws-msk-iam" ||
      kafka.external?.sasl?.mechanism === "aws-iam");
  return usesAwsIam && !kafka?.external?.identity?.awsRoleArn;
}

/**
 * The cluster-setup CloudFormation stack provisions one workload role named
 * `<cluster>-rulebricks` (RulebricksRole). When MSK IAM is configured without
 * an explicit identity role, deploy binds the kafka service accounts to this
 * conventional role automatically, so the wizard never has to ask for an ARN.
 * Returns undefined (never throws) when the role is absent or its trust
 * policy does not allow Pod Identity - e.g. on a bring-your-own cluster -
 * in which case callers fall back to pre-existing associations.
 */
export async function deriveConventionalAwsKafkaRole(
  config: DeploymentConfig,
): Promise<string | undefined> {
  const cluster = config.infrastructure.clusterName;
  if (!cluster) return undefined;
  const roleRes = await run(
    `aws iam get-role --role-name ${shq(`${cluster}-rulebricks`)} ` +
      `--query Role --output json`,
    { intent: "Configure workload identity (AWS)", provider: "aws" },
  );
  if (roleRes.code !== 0) return undefined;
  try {
    const role = JSON.parse(roleRes.stdout) as {
      Arn?: string;
      AssumeRolePolicyDocument?: unknown;
    };
    if (!role.Arn) return undefined;
    return awsTrustPolicyAllowsPodIdentity(role.AssumeRolePolicyDocument)
      ? role.Arn
      : undefined;
  } catch {
    return undefined;
  }
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

  // MSK IAM with no explicit identity role: bind the kafka SAs to the derived
  // cluster-setup role. When the role can't be derived (BYO cluster), leave
  // the bindings alone - preflight (verifyManualKafkaAssociations) has already
  // confirmed manually-managed associations cover these SAs.
  if (provider === "aws" && kafkaUsesAwsIamWithoutRole(config)) {
    const derived = await deriveConventionalAwsKafkaRole(config);
    if (derived) {
      const releaseName = getReleaseName(config.name);
      for (const serviceAccount of [
        ...kafkaWorkloadServiceAccounts(releaseName),
        "keda-operator",
      ]) {
        bindings.push({ serviceAccount, principal: derived });
      }
    }
  }

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

export interface KafkaIdentityVerification {
  ok: boolean;
  missing: string[];
  skipped?: string;
}

/**
 * Preflight for AWS MSK IAM deployments that configure NO kafka identity role.
 * Deploy first tries to derive the cluster-setup role (<cluster>-rulebricks)
 * and bind it; when that role doesn't exist either, credentials must already
 * be present as manually-managed associations. When neither holds, the
 * kafka-proxy sidecars fall back to EC2 IMDS ("no EC2 IMDS role found") and
 * the topic-provision pre-install hook wedges until the helm timeout. This
 * catches that in seconds. Fail-open: only a definitive "association missing"
 * blocks the deploy; listing errors skip the check.
 */
export async function verifyManualKafkaAssociations(
  config: DeploymentConfig,
): Promise<KafkaIdentityVerification> {
  const kafka = config.externalServices?.kafka;
  const usesAwsIam =
    kafka?.mode === "external" &&
    (kafka.external?.preset === "aws-msk-iam" ||
      kafka.external?.sasl?.mechanism === "aws-iam");
  if (!usesAwsIam) {
    return { ok: true, missing: [], skipped: "kafka is not AWS MSK IAM" };
  }
  if (kafka?.external?.identity?.awsRoleArn) {
    return {
      ok: true,
      missing: [],
      skipped: "identity role configured; deploy creates the associations",
    };
  }

  const cluster = config.infrastructure.clusterName;
  const region = config.infrastructure.region;
  if (!cluster || !region) {
    return { ok: true, missing: [], skipped: "missing EKS cluster name or region" };
  }

  const derived = await deriveConventionalAwsKafkaRole(config);
  if (derived) {
    return {
      ok: true,
      missing: [],
      skipped: `cluster-setup role found (${derived}); deploy binds it`,
    };
  }

  const namespace = getNamespace(config.name);
  const releaseName = getReleaseName(config.name);
  const listRes = await run(
    `aws eks list-pod-identity-associations --cluster-name ${shq(cluster)} ` +
      `--namespace ${shq(namespace)} --region ${shq(region)} --output json`,
    { intent: "Configure workload identity (AWS)", provider: "aws" },
  );
  if (listRes.code !== 0) {
    return { ok: true, missing: [], skipped: "could not list associations" };
  }

  let present = new Set<string>();
  try {
    const parsed = JSON.parse(listRes.stdout) as {
      associations?: Array<{ serviceAccount?: string }>;
    };
    present = new Set(
      (parsed.associations ?? [])
        .map((a) => a.serviceAccount)
        .filter((sa): sa is string => typeof sa === "string"),
    );
  } catch {
    return { ok: true, missing: [], skipped: "could not parse association list" };
  }

  // Same set plannedBindings would create, incl. the KEDA operator (lag
  // triggers authenticate to the broker under MSK IAM).
  const expected = [...kafkaWorkloadServiceAccounts(releaseName), "keda-operator"];
  const missing = expected.filter((sa) => !present.has(sa));
  return { ok: missing.length === 0, missing };
}

/**
 * Reverses ensureWorkloadIdentityFederation at `rulebricks destroy` time.
 * The trust is namespace-scoped and useless once the deployment namespace is
 * gone, so destroy removes it. Talks only to the cloud control plane; works
 * even when the Kubernetes cluster itself is unreachable or already deleted.
 * Best-effort by design: every deletion tolerates "not found" so it is safe
 * to run on partially-cleaned deployments.
 */
export async function removeWorkloadIdentityFederation(
  config: DeploymentConfig,
): Promise<FederationRemovalOutcome> {
  const provider = config.infrastructure.provider;
  if (provider !== "azure" && provider !== "aws" && provider !== "gcp") {
    return { removed: [], skipped: "non-cloud provider" };
  }

  const namespace = getNamespace(config.name);
  switch (provider) {
    case "aws":
      return removeAws(config, namespace);
    case "azure":
      return removeAzure(config, namespace, plannedBindings(config));
    case "gcp":
      return removeGcp(config, namespace, plannedBindings(config));
    default:
      return { removed: [], skipped: "non-cloud provider" };
  }
}

// AWS removal lists by namespace instead of replaying plannedBindings: the
// namespace is exclusively this deployment's, and listing also catches
// associations created by older CLI versions or manual fixes whose bindings
// the current config would not plan.
async function removeAws(
  config: DeploymentConfig,
  namespace: string,
): Promise<FederationRemovalOutcome> {
  const cluster = config.infrastructure.clusterName;
  const region = config.infrastructure.region;
  if (!cluster || !region) {
    return { removed: [], skipped: "missing EKS cluster name or region" };
  }

  const intent = "Remove workload identity (AWS)";
  const listRes = await run(
    `aws eks list-pod-identity-associations --cluster-name ${shq(cluster)} ` +
      `--namespace ${shq(namespace)} --region ${shq(region)} --output json`,
    { intent, provider: "aws" },
  );
  if (listRes.code !== 0) {
    if (isAwsPodIdentityCliUnsupported(listRes.stderr)) {
      return { removed: [], skipped: "AWS CLI lacks Pod Identity support" };
    }
    if (/ResourceNotFoundException/i.test(listRes.stderr)) {
      // Cluster already deleted; nothing to unbind.
      return { removed: [], skipped: "EKS cluster not found" };
    }
    throw new Error(
      `Failed to list Pod Identity associations for ${namespace}: ${listRes.stderr.trim()}`,
    );
  }

  let associations: Array<{
    associationId?: string;
    serviceAccount?: string;
    ownerArn?: string;
  }> = [];
  try {
    const parsed = JSON.parse(listRes.stdout) as { associations?: typeof associations };
    associations = parsed.associations ?? [];
  } catch {
    return { removed: [], skipped: "could not parse association list" };
  }

  const removed: string[] = [];
  for (const association of associations) {
    if (!association.associationId) continue;
    // Owned associations (EKS add-ons) are managed by their owner; never ours.
    if (association.ownerArn) continue;
    const deleteRes = await run(
      `aws eks delete-pod-identity-association --cluster-name ${shq(cluster)} ` +
        `--association-id ${shq(association.associationId)} --region ${shq(region)}`,
      { intent, provider: "aws", mutating: true },
    );
    if (deleteRes.code !== 0 && !/ResourceNotFoundException/i.test(deleteRes.stderr)) {
      throw new Error(
        `Failed to delete Pod Identity association ${namespace}/${association.serviceAccount ?? association.associationId}: ${deleteRes.stderr.trim()}`,
      );
    }
    removed.push(`${namespace}/${association.serviceAccount ?? association.associationId}`);
  }
  return { removed };
}

async function removeAzure(
  config: DeploymentConfig,
  namespace: string,
  bindings: SubjectBinding[],
): Promise<FederationRemovalOutcome> {
  if (bindings.length === 0) {
    return { removed: [], skipped: "no workload-identity service accounts" };
  }
  const intent = "Remove workload identity (Azure)";
  const removed: string[] = [];
  const identityByClientId = new Map<
    string,
    { name: string; resourceGroup: string } | null
  >();

  for (const binding of bindings) {
    const clientId = binding.principal;
    let identity = identityByClientId.get(clientId);
    if (identity === undefined) {
      const lookupRes = await run(
        `az identity list --query "[?clientId=='${clientId}'].{name: name, resourceGroup: resourceGroup} | [0]" --output json`,
        { intent, provider: "azure" },
      );
      identity = null;
      try {
        const parsed = JSON.parse(lookupRes.stdout) as {
          name?: string;
          resourceGroup?: string;
        } | null;
        if (parsed?.name && parsed.resourceGroup) {
          identity = { name: parsed.name, resourceGroup: parsed.resourceGroup };
        }
      } catch {
        // Identity gone (e.g. cluster-setup already torn down): nothing to remove.
      }
      identityByClientId.set(clientId, identity);
    }
    if (!identity) continue;

    // Deterministic name assigned at create time (see ensureAzure).
    const ficName = `${namespace}-${binding.serviceAccount}`.slice(0, 120);
    const deleteRes = await run(
      `az identity federated-credential delete --name ${shq(ficName)} ` +
        `--identity-name ${shq(identity.name)} --resource-group ${shq(identity.resourceGroup)}`,
      { intent, provider: "azure", mutating: true },
    );
    if (deleteRes.code === 0) {
      removed.push(`${namespace}/${binding.serviceAccount}`);
    } else if (!/not found|does not exist|NotFound/i.test(deleteRes.stderr)) {
      throw new Error(
        `Failed to delete federated credential for ${namespace}/${binding.serviceAccount}: ${deleteRes.stderr.trim()}`,
      );
    }
  }
  return { removed };
}

async function removeGcp(
  config: DeploymentConfig,
  namespace: string,
  bindings: SubjectBinding[],
): Promise<FederationRemovalOutcome> {
  const project = config.infrastructure.gcpProjectId;
  if (!project) {
    return { removed: [], skipped: "missing GCP project ID" };
  }
  if (bindings.length === 0) {
    return { removed: [], skipped: "no workload-identity service accounts" };
  }

  const intent = "Remove workload identity (GCP)";
  const removed: string[] = [];
  for (const binding of bindings) {
    const member = `serviceAccount:${project}.svc.id.goog[${namespace}/${binding.serviceAccount}]`;
    const res = await run(
      `gcloud iam service-accounts remove-iam-policy-binding ${shq(binding.principal)} ` +
        `--project ${shq(project)} --role roles/iam.workloadIdentityUser ` +
        `--member ${shq(member)} --quiet`,
      { intent, provider: "gcp", mutating: true },
    );
    if (res.code === 0) {
      removed.push(`${namespace}/${binding.serviceAccount}`);
    } else if (!/not found|does not exist|NOT_FOUND/i.test(res.stderr)) {
      throw new Error(
        `Failed to remove Workload Identity binding for ${namespace}/${binding.serviceAccount}: ${res.stderr.trim()}`,
      );
    }
  }
  return { removed };
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
  const profileRes = await run(
    `az aks show --name ${shq(cluster)} --resource-group ${shq(rg)} ` +
      `--query "{issuer: oidcIssuerProfile.issuerUrl, workloadIdentityEnabled: securityProfile.workloadIdentity.enabled}" --output json`,
    { intent, provider: "azure" },
  );
  let issuer = "";
  let workloadIdentityEnabled: unknown;
  try {
    const profile = JSON.parse(profileRes.stdout) as {
      issuer?: unknown;
      workloadIdentityEnabled?: unknown;
    };
    issuer = typeof profile.issuer === "string" ? profile.issuer.trim() : "";
    workloadIdentityEnabled = profile.workloadIdentityEnabled;
  } catch {
    // Fall through to the issuer error below with the CLI stderr.
  }
  if (!issuer) {
    throw new Error(
      [
        `Could not read the AKS OIDC issuer for ${cluster}/${rg}. Ensure the cluster has the OIDC issuer enabled:`,
        `  az aks update --name ${cluster} --resource-group ${rg} --enable-oidc-issuer --enable-workload-identity`,
        profileRes.stderr.trim() ? `Azure CLI output:\n${profileRes.stderr.trim()}` : "",
      ]
        .filter(Boolean)
        .join("\n"),
    );
  }
  // Azure has no trust-policy rejection: federated credentials create fine on
  // a cluster without the workload-identity webhook, and pods simply never
  // receive tokens (runtime 403s). Block early instead.
  if (workloadIdentityEnabled !== true) {
    throw new Error(
      [
        `Azure Workload Identity is not enabled on the AKS cluster ${cluster}/${rg}.`,
        "",
        "Without it, federated credentials are created but pods never receive",
        "tokens, which surfaces later as authorization errors at runtime.",
        "",
        "Clusters provisioned by Rulebricks cluster-setup enable it. For a",
        "bring-your-own cluster, enable it and rerun the deploy:",
        `  az aks update --name ${cluster} --resource-group ${rg} --enable-workload-identity`,
      ].join("\n"),
    );
  }

  // Resolve identity name + resource group once per distinct clientId. The
  // lookup is subscription-wide: the wizard offers identities from any
  // resource group, so a valid identity living outside the cluster's RG must
  // still resolve here.
  interface ResolvedIdentity {
    name: string;
    resourceGroup: string;
  }
  const identityByClientId = new Map<string, ResolvedIdentity>();
  const created: string[] = [];
  const existing: string[] = [];

  for (const binding of bindings) {
    const clientId = binding.principal;
    let identity = identityByClientId.get(clientId);
    if (!identity) {
      const lookupRes = await run(
        `az identity list --query "[?clientId=='${clientId}'].{name: name, resourceGroup: resourceGroup} | [0]" --output json`,
        { intent, provider: "azure" },
      );
      try {
        const parsed = JSON.parse(lookupRes.stdout) as {
          name?: string;
          resourceGroup?: string;
        } | null;
        if (parsed?.name && parsed.resourceGroup) {
          identity = { name: parsed.name, resourceGroup: parsed.resourceGroup };
        }
      } catch {
        // Treated as not found below.
      }
      if (!identity) {
        throw new Error(
          `No user-assigned identity with client ID ${clientId} found in the current subscription. Run cluster-setup first, or check the active subscription (az account show).`,
        );
      }
      identityByClientId.set(clientId, identity);
    }

    const subject = `system:serviceaccount:${namespace}:${binding.serviceAccount}`;
    // Unique per (namespace, SA) so several deployments can share one identity.
    const ficName = `${namespace}-${binding.serviceAccount}`.slice(0, 120);

    const listRes = await run(
      `az identity federated-credential list --identity-name ${shq(identity.name)} --resource-group ${shq(identity.resourceGroup)} --query "[?subject=='${subject}'] | length(@)" --output tsv`,
      { intent, provider: "azure" },
    );
    if (listRes.stdout.trim() !== "0" && listRes.stdout.trim() !== "") {
      existing.push(subject);
      continue;
    }

    const createRes = await run(
      `az identity federated-credential create --name ${shq(ficName)} ` +
        `--identity-name ${shq(identity.name)} --resource-group ${shq(identity.resourceGroup)} ` +
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

  // Preflight 1: the Pod Identity agent add-on. Without it every association
  // below is created successfully but pods never receive credentials - a
  // silent runtime failure. Only a positive "not found" blocks the deploy;
  // permission errors fall through to the association calls.
  const addonRes = await run(
    `aws eks describe-addon --cluster-name ${shq(cluster)} ` +
      `--addon-name eks-pod-identity-agent --region ${shq(region)} ` +
      `--query addon.addonName --output text`,
    { intent, provider: "aws" },
  );
  if (addonRes.code !== 0 && /ResourceNotFoundException/i.test(addonRes.stderr)) {
    throw new Error(awsPodIdentityAgentMissingMessage(cluster, region));
  }

  // Preflight 2: every distinct role must trust pods.eks.amazonaws.com. This
  // catches wrong picks (control-plane roles, legacy IRSA roles) before any
  // association is created, instead of failing partway through the set. A
  // failed get-role (e.g. no iam:GetRole permission) skips the check; the
  // create call still reports invalid trust with the same guidance.
  const checkedRoles = new Map<string, string[]>();
  for (const binding of bindings) {
    const subjects = checkedRoles.get(binding.principal) ?? [];
    subjects.push(`${namespace}/${binding.serviceAccount}`);
    checkedRoles.set(binding.principal, subjects);
  }
  for (const [roleArn, subjects] of checkedRoles) {
    const roleRes = await run(
      `aws iam get-role --role-name ${shq(awsRoleNameFromArn(roleArn))} ` +
        `--query Role.AssumeRolePolicyDocument --output json`,
      { intent, provider: "aws" },
    );
    if (roleRes.code !== 0) continue;
    let document: unknown;
    try {
      document = JSON.parse(roleRes.stdout);
    } catch {
      continue;
    }
    if (!awsTrustPolicyAllowsPodIdentity(document)) {
      throw new Error(
        awsPodIdentityInvalidTrustMessage({
          stderr: "",
          subject: subjects.join(", "),
          roleArn,
          cluster,
        }),
      );
    }
  }

  for (const binding of bindings) {
    const roleArn = binding.principal;
    const subject = `${namespace}/${binding.serviceAccount}`;

    const listRes = await run(
      `aws eks list-pod-identity-associations --cluster-name ${shq(cluster)} ` +
        `--namespace ${shq(namespace)} --service-account ${shq(binding.serviceAccount)} ` +
        `--region ${shq(region)} --query "associations | length(@)" --output text`,
      { intent, provider: "aws" },
    );
    if (listRes.code !== 0 && isAwsPodIdentityCliUnsupported(listRes.stderr)) {
      throw new Error(awsPodIdentityUnsupportedMessage(listRes.stderr));
    }
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
      if (isAwsPodIdentityCliUnsupported(createRes.stderr)) {
        throw new Error(awsPodIdentityUnsupportedMessage(createRes.stderr));
      }
      if (isAwsPodIdentityTrustPolicyInvalid(createRes.stderr)) {
        throw new Error(
          awsPodIdentityInvalidTrustMessage({
            stderr: createRes.stderr,
            subject,
            roleArn,
            cluster,
          }),
        );
      }
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

  // Preflight: the GKE cluster must have a Workload Identity pool. Without it
  // the IAM bindings below are created but pods can never exchange tokens - a
  // silent runtime failure. Only a positive "pool unset" blocks; a failed
  // describe (permissions, location mismatch) falls through.
  const gkeCluster = config.infrastructure.clusterName;
  const gkeLocation = config.infrastructure.region;
  if (gkeCluster && gkeLocation) {
    const poolRes = await run(
      `gcloud container clusters describe ${shq(gkeCluster)} ` +
        `--location ${shq(gkeLocation)} --project ${shq(project)} ` +
        `--format "value(workloadIdentityConfig.workloadPool)"`,
      { intent, provider: "gcp" },
    );
    if (poolRes.code === 0 && poolRes.stdout.trim() === "") {
      throw new Error(
        [
          `GKE Workload Identity is not enabled on the cluster ${gkeCluster}.`,
          "",
          "Without it, the IAM bindings are created but pods never receive",
          "Google credentials, which surfaces later as authorization errors at",
          "runtime.",
          "",
          "Clusters provisioned by Rulebricks cluster-setup enable it. For a",
          "bring-your-own cluster, enable it and rerun the deploy:",
          `  gcloud container clusters update ${gkeCluster} --location ${gkeLocation} --project ${project} --workload-pool=${project}.svc.id.goog`,
        ].join("\n"),
      );
    }
  }

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
