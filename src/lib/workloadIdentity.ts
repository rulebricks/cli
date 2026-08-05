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
  usesInClusterPostgres,
} from "../types/index.js";
import { approveCloudCommandOrThrow } from "./commandApproval.js";
import { isCloudAuthorizationError } from "./cloudErrors.js";

const execAsync = promisify(exec);
const CLI_TIMEOUT = 60000;

/** A binding whose create was refused by cloud IAM, with the command an admin can run. */
export interface DeniedBinding {
  subject: string;
  command: string;
}

export interface FederationOutcome {
  created: string[];
  existing: string[];
  /** Bindings skipped because cloud IAM denied the create (fail-open). */
  denied?: DeniedBinding[];
  skipped?: string;
}

/**
 * Warning shown when IAM denied some federation creates: lists the exact
 * commands an admin can run. Deploy continues on the assumption the trust
 * exists or will be created out-of-band.
 */
export function formatFederationDeniedWarning(denied: DeniedBinding[]): string {
  return [
    "No permission to create workload identity trust for:",
    ...denied.map((d) => `  - ${d.subject}`),
    "Ask your cloud admin to run (skip any that already exist):",
    ...denied.map((d) => `  ${d.command}`),
  ].join("\n");
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
  const expectedRole = `${input.cluster}-data-access`;
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
  /** Exact Azure UAMI ID when the identity lives outside the active subscription. */
  resourceId?: string;
}

/**
 * The ServiceAccount the External Secrets Operator's SecretStore references to
 * read the cloud secrets manager on Azure/GCP (ESO mints tokens for it via the
 * TokenRequest API, so it needs no pod). The CLI creates it (with the
 * per-cloud identity annotations) alongside the SecretStore/ExternalSecret
 * manifests and binds it here like every other workload identity. Matches the
 * name used in the Helm chart's examples/external-secrets manifests.
 */
export const ESO_READER_SERVICE_ACCOUNT = "rulebricks-secrets-reader";

/**
 * The ESO controller's own ServiceAccount (fixed by the CLI-managed operator
 * release name). AWS is bound here instead of a reader SA: EKS Pod Identity
 * delivers credentials to running PODS, so the association must target the
 * controller pod - a serviceAccountRef would be the IRSA flow, which the
 * cluster-setup role's trust policy (pods.eks.amazonaws.com) does not allow.
 */
export const ESO_CONTROLLER_SERVICE_ACCOUNT = "external-secrets";

/** The (serviceAccount, principal) pair ESO needs, per the secrets backend. */
export function esoBinding(
  config: DeploymentConfig,
): SubjectBinding | undefined {
  const secrets = config.secrets;
  switch (secrets?.backend) {
    case "aws-secrets-manager":
      return secrets.aws?.roleArn
        ? {
            serviceAccount: ESO_CONTROLLER_SERVICE_ACCOUNT,
            principal: secrets.aws.roleArn,
          }
        : undefined;
    case "azure-key-vault":
      return secrets.azure?.clientId
        ? {
            serviceAccount: ESO_READER_SERVICE_ACCOUNT,
            principal: secrets.azure.clientId,
          }
        : undefined;
    case "gcp-secret-manager":
      return secrets.gcp?.serviceAccountEmail
        ? {
            serviceAccount: ESO_READER_SERVICE_ACCOUNT,
            principal: secrets.gcp.serviceAccountEmail,
          }
        : undefined;
    default:
      // cluster / byo-secret-store: no CLI-managed secrets identity.
      return undefined;
  }
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

  // External Secrets Operator: syncs the cloud secrets manager into the
  // Kubernetes Secrets every secretRef seam points at. Only for the
  // native-manager backends; byo-secret-store users own their store's auth.
  const eso = esoBinding(config);
  if (eso) {
    bindings.push(eso);
  }

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
    // Only when the chart actually deploys the backup CronJob: with an
    // external managed database, generateBackupValues disables backups (the
    // provider owns them), so binding the -backup SA would create dead trust
    // for a ServiceAccount that never exists.
    if (config.backup?.enabled && usesInClusterPostgres(config)) {
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
 * `<cluster>-data-access` (RulebricksRole). When MSK IAM is configured without
 * an explicit identity role, deploy binds the kafka service accounts to this
 * conventional role automatically, so the wizard never has to ask for an ARN.
 * Returns undefined (never throws) when the role is absent or its trust
 * policy does not allow Pod Identity - e.g. on a bring-your-own cluster -
 * in which case callers fall back to pre-existing associations.
 */
export async function deriveConventionalAwsKafkaRole(
  config: DeploymentConfig,
): Promise<string | undefined> {
  // Current cluster-setup name first; `-rulebricks` is the name earlier
  // template generations created, kept so existing clusters keep resolving.
  return (
    (await deriveConventionalAwsRole(config, "data-access")) ??
    (await deriveConventionalAwsRole(config, "rulebricks"))
  );
}

/**
 * Same convention for the cluster-setup autoscaler role
 * (`<cluster>-cluster-autoscaler`, ClusterAutoscalerRole): deploy binds the
 * chart's fixed "cluster-autoscaler" ServiceAccount to it so node autoscaling
 * works out of the box on AWS. Undefined on BYO clusters without the role -
 * the chart still installs the autoscaler, which then needs a manually-managed
 * association or role.
 */
export async function deriveConventionalAwsClusterAutoscalerRole(
  config: DeploymentConfig,
): Promise<string | undefined> {
  return deriveConventionalAwsRole(config, "cluster-autoscaler");
}

/**
 * Same convention for the cluster-setup external-dns role
 * (`<cluster>-external-dns`, ExternalDnsRole): deploy binds the chart's fixed
 * "external-dns" ServiceAccount to it so record automation works out of the
 * box when dns.autoManage targets Route53.
 */
export async function deriveConventionalAwsExternalDnsRole(
  config: DeploymentConfig,
): Promise<string | undefined> {
  return deriveConventionalAwsRole(config, "external-dns");
}

/**
 * Azure counterpart: the cluster-setup Bicep provisions the
 * `<cluster>-external-dns` user-assigned identity (already granted DNS Zone
 * Contributor on the deployment's zone); deploy federates the chart's fixed
 * "external-dns" ServiceAccount to it. Undefined when the identity does not
 * exist (external-dns disabled at cluster-setup, or BYO cluster).
 */
export async function deriveConventionalAzureExternalDnsClientId(
  config: DeploymentConfig,
): Promise<string | undefined> {
  const exactIdentityId =
    config.infrastructure.azureExternalDnsIdentityId;
  if (exactIdentityId) {
    const result = await run(
      `az identity show --ids ${shq(exactIdentityId)} --query clientId --output tsv`,
      { intent: "Configure workload identity (Azure)", provider: "azure" },
    );
    if (result.code === 0 && result.stdout.trim()) {
      return result.stdout.trim();
    }
  }
  return deriveConventionalAzureIdentityClientId(config, "external-dns");
}

/**
 * Azure counterpart of deriveConventionalAwsRole: resolve the client ID of a
 * cluster-setup user-assigned identity by its `<cluster>-<suffix>` naming
 * convention. The deployment's resource group is checked first; when the name
 * is not there, the lookup widens to the subscription, because the
 * prerequisites template may place an identity (external-dns) in a platform
 * team's resource group. The deployment's resource group wins when the name
 * appears in several. Undefined when the identity does not exist.
 */
export async function deriveConventionalAzureIdentityClientId(
  config: DeploymentConfig,
  suffix: string,
): Promise<string | undefined> {
  const cluster = config.infrastructure.clusterName;
  if (!cluster) return undefined;
  const list = async (
    scope?: string,
  ): Promise<Array<{ clientId?: string; resourceGroup?: string }>> => {
    const res = await run(
      `az identity list${scope ? ` --resource-group ${shq(scope)}` : ""} --query ${shq(
        `[?name=='${cluster}-${suffix}'].{clientId:clientId,resourceGroup:resourceGroup}`,
      )} --output json`,
      { intent: "Configure workload identity (Azure)", provider: "azure" },
    );
    if (res.code !== 0) return [];
    try {
      return JSON.parse(res.stdout || "[]");
    } catch {
      return [];
    }
  };
  const rg = (config.infrastructure.azureResourceGroup || "").trim();
  let identities = rg ? await list(rg) : [];
  if (identities.length === 0) {
    identities = await list(undefined);
  }
  const rgLower = rg.toLowerCase();
  const preferred =
    identities.find((i) => (i.resourceGroup || "").toLowerCase() === rgLower) ??
    identities[0];
  return preferred?.clientId || undefined;
}

/**
 * Cluster-setup provisions a dedicated secrets backend (Azure: Key Vault +
 * `<cluster>-external-secrets` reader identity; AWS: `<cluster>-external-secrets`
 * Secrets Manager role) when its Key Vault / external-secrets toggle is on.
 * Detecting that identity lets deploy warn when a config runs in plain
 * cluster-secrets mode against a cluster whose setup clearly intended a
 * managed secrets backend.
 */
export async function detectProvisionedSecretsBackend(
  config: DeploymentConfig,
): Promise<string | undefined> {
  const provider = config.infrastructure.provider;
  if (provider === "azure") {
    const clientId = await deriveConventionalAzureIdentityClientId(
      config,
      "external-secrets",
    );
    return clientId
      ? "Azure Key Vault (cluster-setup enableKeyVaultIntegration)"
      : undefined;
  }
  if (provider === "aws") {
    const role = await deriveConventionalAwsRole(config, "external-secrets");
    return role
      ? "AWS Secrets Manager (cluster-setup EnableExternalSecrets)"
      : undefined;
  }
  return undefined;
}

/** True when this deployment expects automatic DNS on the given cloud. */
export function wantsManagedDns(
  config: DeploymentConfig,
  cloud: "aws" | "azure",
): boolean {
  if (!config.dns?.autoManage) return false;
  return cloud === "aws"
    ? config.dns.provider === "route53"
    : config.dns.provider === "azure";
}

async function deriveConventionalAwsRole(
  config: DeploymentConfig,
  roleSuffix: string,
): Promise<string | undefined> {
  const cluster = config.infrastructure.clusterName;
  if (!cluster) return undefined;
  const roleRes = await run(
    `aws iam get-role --role-name ${shq(`${cluster}-${roleSuffix}`)} ` +
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

  // AWS node autoscaling: the chart deploys cluster-autoscaler (EKS nodegroups
  // have no built-in scaling), whose fixed "cluster-autoscaler" SA binds to the
  // cluster-setup <cluster>-cluster-autoscaler role. Skipped silently when the
  // role doesn't exist (BYO cluster / pre-autoscaler cluster-setup stacks).
  if (provider === "aws") {
    const autoscalerRole =
      await deriveConventionalAwsClusterAutoscalerRole(config);
    if (autoscalerRole) {
      bindings.push({
        serviceAccount: "cluster-autoscaler",
        principal: autoscalerRole,
      });
    }
  }

  // Automatic DNS: bind the chart's fixed "external-dns" SA to the
  // cluster-setup DNS identity (<cluster>-external-dns IAM role on AWS, UAMI
  // on Azure - both already scoped to the deployment's zone). Without this
  // trust, external-dns deploys but cannot write records; the templates
  // provision the identities, and this namespace-scoped binding is deploy's
  // job. Skipped silently when the identity doesn't exist.
  if (provider === "aws" && wantsManagedDns(config, "aws")) {
    const dnsRole = await deriveConventionalAwsExternalDnsRole(config);
    if (dnsRole) {
      bindings.push({ serviceAccount: "external-dns", principal: dnsRole });
    }
  }
  if (provider === "azure" && wantsManagedDns(config, "azure")) {
    const dnsClientId = await deriveConventionalAzureExternalDnsClientId(config);
    if (dnsClientId) {
      bindings.push({
        serviceAccount: "external-dns",
        principal: dnsClientId,
        ...(config.infrastructure.azureExternalDnsIdentityId
          ? {
              resourceId:
                config.infrastructure.azureExternalDnsIdentityId,
            }
          : {}),
      });
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

export interface ClusterAutoscalerIdentityCheck {
  ok: boolean;
  skipped?: string;
}

/**
 * Whether the chart's cluster-autoscaler (enabled on AWS) will actually get
 * AWS credentials: either deploy can bind the conventional cluster-setup role
 * (<cluster>-cluster-autoscaler), or an association for the fixed
 * "cluster-autoscaler" SA already exists in the namespace (manually managed,
 * e.g. BYO clusters). Without either, the autoscaler pod fatally crashloops
 * on "no EC2 IMDS role found" and blocks helm --wait until the timeout, so
 * deploy disables the autoscaler in the generated values instead. Fail-open:
 * a failed association listing reports ok so transient IAM/API errors never
 * flip a working deploy.
 */
export async function verifyClusterAutoscalerIdentity(
  config: DeploymentConfig,
): Promise<ClusterAutoscalerIdentityCheck> {
  if (config.infrastructure.provider !== "aws") {
    return { ok: true, skipped: "autoscaler identity is AWS-only" };
  }
  const cluster = config.infrastructure.clusterName;
  const region = config.infrastructure.region;
  if (!cluster || !region) {
    // generateClusterAutoscaler disables the autoscaler in this case anyway.
    return { ok: true, skipped: "missing EKS cluster name or region" };
  }

  const role = await deriveConventionalAwsClusterAutoscalerRole(config);
  if (role) return { ok: true };

  const namespace = getNamespace(config.name);
  const listRes = await run(
    `aws eks list-pod-identity-associations --cluster-name ${shq(cluster)} ` +
      `--namespace ${shq(namespace)} --service-account cluster-autoscaler ` +
      `--region ${shq(region)} --query "associations | length(@)" --output text`,
    { intent: "Configure workload identity (AWS)", provider: "aws" },
  );
  if (listRes.code !== 0) {
    return { ok: true, skipped: "could not list associations" };
  }
  const count = listRes.stdout.trim();
  return { ok: count !== "0" && count !== "" };
}

export interface KafkaIdentityVerification {
  ok: boolean;
  missing: string[];
  skipped?: string;
}

/**
 * Preflight for AWS MSK IAM deployments that configure NO kafka identity role.
 * Deploy first tries to derive the cluster-setup role (<cluster>-data-access,
 * or the earlier <cluster>-rulebricks name) and bind it; when that role
 * doesn't exist either, credentials must already
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

/**
 * Resolve a user-assigned identity's name and resource group from its client
 * ID, checking the deployment's resource group first (where cluster-setup
 * places workload identities) and widening to the subscription when it is not
 * there - the wizard offers identities from any resource group, so a valid
 * identity living outside the cluster's group must still resolve. The last
 * az result is returned so callers can distinguish "not found" from RBAC
 * denial.
 */
async function lookupAzureIdentityByClientId(
  clientId: string,
  resourceGroup: string | undefined,
  intent: string,
): Promise<{
  identity: { name: string; resourceGroup: string } | null;
  lastResult: { code: number; stdout: string; stderr: string };
}> {
  const lookup = async (rg?: string) => {
    const res = await run(
      `az identity list${rg ? ` --resource-group ${shq(rg)}` : ""} --query "[?clientId=='${clientId}'].{name: name, resourceGroup: resourceGroup} | [0]" --output json`,
      { intent, provider: "azure" },
    );
    let identity: { name: string; resourceGroup: string } | null = null;
    try {
      const parsed = JSON.parse(res.stdout) as {
        name?: string;
        resourceGroup?: string;
      } | null;
      if (parsed?.name && parsed.resourceGroup) {
        identity = { name: parsed.name, resourceGroup: parsed.resourceGroup };
      }
    } catch {
      // Treated as not found by callers.
    }
    return { identity, res };
  };
  const rg = resourceGroup?.trim();
  if (rg) {
    const scoped = await lookup(rg);
    if (scoped.identity) {
      return { identity: scoped.identity, lastResult: scoped.res };
    }
  }
  const wide = await lookup(undefined);
  return { identity: wide.identity, lastResult: wide.res };
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
    { name: string; resourceGroup: string; subscriptionId?: string } | null
  >();

  for (const binding of bindings) {
    const clientId = binding.principal;
    let identity = identityByClientId.get(clientId);
    if (identity === undefined && binding.resourceId) {
      const exact = binding.resourceId.match(
        /^\/subscriptions\/([^/]+)\/resourceGroups\/([^/]+)\/providers\/Microsoft\.ManagedIdentity\/userAssignedIdentities\/([^/]+)$/i,
      );
      if (exact) {
        identity = {
          subscriptionId: exact[1],
          resourceGroup: exact[2],
          name: exact[3],
        };
        identityByClientId.set(clientId, identity);
      }
    }
    if (identity === undefined) {
      // Identity gone (e.g. cluster-setup already torn down) resolves to
      // null: nothing to remove.
      const lookup = await lookupAzureIdentityByClientId(
        clientId,
        config.infrastructure.azureResourceGroup,
        intent,
      );
      identity = lookup.identity;
      identityByClientId.set(clientId, identity);
    }
    if (!identity) continue;

    // Deterministic name assigned at create time (see ensureAzure).
    const ficName = `${namespace}-${binding.serviceAccount}`.slice(0, 120);
    const deleteRes = await run(
      `az identity federated-credential delete --name ${shq(ficName)} ` +
        `--identity-name ${shq(identity.name)} --resource-group ${shq(identity.resourceGroup)}` +
        `${identity.subscriptionId ? ` --subscription ${shq(identity.subscriptionId)}` : ""}`,
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
  // lookup checks the deployment's resource group first and then widens to
  // the subscription: the wizard offers identities from any resource group,
  // so a valid identity living outside the cluster's RG must still resolve.
  interface ResolvedIdentity {
    name: string;
    resourceGroup: string;
    subscriptionId?: string;
  }
  const identityByClientId = new Map<string, ResolvedIdentity>();
  // clientIds whose lookup was refused by RBAC: skip repeat lookups and
  // fail open with a placeholder command instead of a misleading hard stop.
  const lookupDenied = new Set<string>();
  const created: string[] = [];
  const existing: string[] = [];
  const denied: DeniedBinding[] = [];

  for (const binding of bindings) {
    const clientId = binding.principal;
    const subject = `system:serviceaccount:${namespace}:${binding.serviceAccount}`;
    // Unique per (namespace, SA) so several deployments can share one identity.
    const ficName = `${namespace}-${binding.serviceAccount}`.slice(0, 120);

    let identity = identityByClientId.get(clientId);
    if (!identity && binding.resourceId) {
      const exact = binding.resourceId.match(
        /^\/subscriptions\/([^/]+)\/resourceGroups\/([^/]+)\/providers\/Microsoft\.ManagedIdentity\/userAssignedIdentities\/([^/]+)$/i,
      );
      if (exact) {
        identity = {
          subscriptionId: exact[1],
          resourceGroup: exact[2],
          name: exact[3],
        };
        identityByClientId.set(clientId, identity);
      }
    }
    if (!identity && !lookupDenied.has(clientId)) {
      const lookup = await lookupAzureIdentityByClientId(clientId, rg, intent);
      identity = lookup.identity ?? undefined;
      if (
        !identity &&
        lookup.lastResult.code !== 0 &&
        isCloudAuthorizationError(lookup.lastResult.stderr)
      ) {
        lookupDenied.add(clientId);
      } else if (!identity) {
        throw new Error(
          `No user-assigned identity with client ID ${clientId} found in the current subscription. Run cluster-setup first, or check the active subscription (az account show).`,
        );
      } else {
        identityByClientId.set(clientId, identity);
      }
    }
    if (!identity) {
      denied.push({
        subject,
        command:
          `az identity federated-credential create --name ${ficName} ` +
          `--identity-name <identity with clientId ${clientId}> --resource-group <its resource group> ` +
          `--issuer ${issuer} --subject ${subject} --audiences api://AzureADTokenExchange`,
      });
      continue;
    }

    const listRes = await run(
      `az identity federated-credential list --identity-name ${shq(identity.name)} --resource-group ${shq(identity.resourceGroup)}${identity.subscriptionId ? ` --subscription ${shq(identity.subscriptionId)}` : ""} --query "[?subject=='${subject}'] | length(@)" --output tsv`,
      { intent, provider: "azure" },
    );
    if (listRes.stdout.trim() !== "0" && listRes.stdout.trim() !== "") {
      existing.push(subject);
      continue;
    }

    const createCommand =
      `az identity federated-credential create --name ${shq(ficName)} ` +
      `--identity-name ${shq(identity.name)} --resource-group ${shq(identity.resourceGroup)} ` +
      `${identity.subscriptionId ? `--subscription ${shq(identity.subscriptionId)} ` : ""}` +
      `--issuer ${shq(issuer)} --subject ${shq(subject)} ` +
      `--audiences api://AzureADTokenExchange`;
    const createRes = await run(createCommand, {
      intent,
      provider: "azure",
      mutating: true,
    });
    if (createRes.code !== 0) {
      if (isCloudAuthorizationError(createRes.stderr)) {
        denied.push({ subject, command: createCommand });
        continue;
      }
      throw new Error(
        `Failed to create federated credential for ${subject}: ${createRes.stderr.trim()}`,
      );
    }
    created.push(subject);
  }

  return { created, existing, ...(denied.length > 0 ? { denied } : {}) };
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
  const denied: DeniedBinding[] = [];
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

    const createCommand =
      `aws eks create-pod-identity-association --cluster-name ${shq(cluster)} ` +
      `--namespace ${shq(namespace)} --service-account ${shq(binding.serviceAccount)} ` +
      `--role-arn ${shq(roleArn)} --region ${shq(region)}`;
    const createRes = await run(createCommand, {
      intent,
      provider: "aws",
      mutating: true,
    });
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
      if (isCloudAuthorizationError(createRes.stderr)) {
        denied.push({ subject: `${namespace}/${binding.serviceAccount}`, command: createCommand });
        continue;
      }
      throw new Error(
        `Failed to create Pod Identity association for ${subject}: ${createRes.stderr.trim()}`,
      );
    }
    created.push(subject);
  }

  return { created, existing, ...(denied.length > 0 ? { denied } : {}) };
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
  const denied: DeniedBinding[] = [];
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
    const bindCommand =
      `gcloud iam service-accounts add-iam-policy-binding ${shq(gsa)} ` +
      `--project ${shq(project)} --role roles/iam.workloadIdentityUser ` +
      `--member ${shq(member)} --quiet`;
    const res = await run(bindCommand, {
      intent,
      provider: "gcp",
      mutating: true,
    });
    if (res.code !== 0) {
      if (isCloudAuthorizationError(res.stderr)) {
        denied.push({
          subject: `${namespace}/${binding.serviceAccount}`,
          command: bindCommand,
        });
        continue;
      }
      throw new Error(
        `Failed to bind Workload Identity for ${namespace}/${binding.serviceAccount}: ${res.stderr.trim()}`,
      );
    }
    created.push(`${namespace}/${binding.serviceAccount}`);
  }

  return { created, existing: [], ...(denied.length > 0 ? { denied } : {}) };
}
