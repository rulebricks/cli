import { CloudProvider } from "../types/index.js";

/**
 * Detects the IAM roles / managed identities / buckets that the bundled
 * cluster-setup templates (cluster-setup/aws|azure|gcp) provision, so the wizard
 * can preselect them as sensible defaults. The user can always arrow to a
 * different option, and when nothing matches the behavior is unchanged.
 *
 * Naming conventions (parameterized by cluster name, default rulebricks-cluster):
 *   AWS  (CloudFormation): roles `${cluster}-metrics`, `${cluster}-decision-logs`,
 *                          `${cluster}-backups`; buckets `${cluster}-decision-logs-*`,
 *                          `${cluster}-backups-*`.
 *   Azure (Bicep):         UAMIs `${cluster}-metrics`, `${cluster}-decision-logs`,
 *                          `${cluster}-backups`; blob containers `decision-logs`, `backups`.
 *   GCP  (docs):           service account `rulebricks-vector` (decision logs only).
 */

export type ClusterSetupCategory =
  | "metrics-identity"
  | "decision-logs-identity"
  | "backups-identity"
  | "decision-logs-bucket"
  | "backups-bucket"
  | "decision-logs-container"
  | "backups-container";

export interface ClusterSetupDetectOptions {
  provider?: CloudProvider | null;
  /** Cluster name used to build the most specific match. */
  clusterName?: string;
}

const DEFAULT_CLUSTER = "rulebricks-cluster";

/**
 * Patterns to look for, ordered most-specific to least-specific. The first
 * candidate matching the highest-priority pattern wins. Strings match as
 * case-insensitive substrings; regexes match the whole candidate.
 */
function patternsFor(
  category: ClusterSetupCategory,
  cluster: string,
  provider?: CloudProvider | null,
): (string | RegExp)[] {
  // The consolidated cluster-setup provisions a single `${cluster}-rulebricks`
  // identity and a single `${cluster}-data` bucket/container. Older split
  // resources (`-decision-logs`, `-backups`, `-metrics`) are kept as lower-
  // priority fallbacks so the wizard still preselects sensibly on legacy infra.
  switch (category) {
    case "metrics-identity":
      return [`${cluster}-rulebricks`, `${cluster}-metrics`, "-rulebricks", "-metrics"];
    case "decision-logs-identity":
    case "backups-identity":
      return [
        `${cluster}-rulebricks`,
        "-rulebricks",
        `${cluster}-decision-logs`,
        "-decision-logs",
        `${cluster}-backups`,
        "-backups",
      ];
    case "decision-logs-bucket":
    case "backups-bucket":
      return [
        `${cluster}-data`,
        "-data",
        // Azure storage account names forbid hyphens; the cluster-setup
        // template generates rb<uniqueString> (13-char hash).
        ...(provider === "azure" ? [/^rb[a-z0-9]{13}$/] : []),
        `${cluster}-decision-logs`,
        "-decision-logs",
        `${cluster}-backups`,
        "-backups",
      ];
    case "decision-logs-container":
    case "backups-container":
      return [`${cluster}-data`, "-data", "rulebricks", "decision-logs", "backups"];
    default:
      return [];
  }
}

/**
 * Returns the index of the best cluster-setup match in `candidates`, or -1 when
 * none match. Matching is case-insensitive and prefers more specific patterns.
 */
export function findClusterSetupDefaultIndex(
  candidates: string[],
  category: ClusterSetupCategory,
  options: ClusterSetupDetectOptions = {},
): number {
  if (candidates.length === 0) return -1;
  const cluster = (options.clusterName || DEFAULT_CLUSTER).trim() || DEFAULT_CLUSTER;
  const lowered = candidates.map((c) => c.toLowerCase());

  for (const pattern of patternsFor(category, cluster, options.provider)) {
    const index =
      typeof pattern === "string"
        ? lowered.findIndex((c) => c.includes(pattern.toLowerCase()))
        : lowered.findIndex((c) => pattern.test(c));
    if (index >= 0) return index;
  }
  return -1;
}

/**
 * Convenience wrapper returning the matched candidate string (or undefined).
 */
export function findClusterSetupDefault(
  candidates: string[],
  category: ClusterSetupCategory,
  options: ClusterSetupDetectOptions = {},
): string | undefined {
  const index = findClusterSetupDefaultIndex(candidates, category, options);
  return index >= 0 ? candidates[index] : undefined;
}

/**
 * Cluster-infrastructure IAM roles that must never back a workload identity:
 * EKS control-plane and nodegroup roles (Terraform name_prefix, CloudFormation
 * logical-ID, and eksctl naming conventions) plus AWS service-linked roles.
 * Binding one to Pod Identity either fails outright (control-plane roles trust
 * eks.amazonaws.com, not pods.eks.amazonaws.com) or would hand application
 * pods node-level credentials.
 *
 * Patterns are suffix-anchored where possible so they never swallow the
 * legitimate `<cluster>-rulebricks` role of a cluster whose name itself
 * contains "cluster" (e.g. rulebricks-cluster-rulebricks).
 */
const AWS_INFRA_ROLE_PATTERNS: RegExp[] = [
  // Service-linked roles (AWSServiceRoleForAmazonEKS, ...).
  /AWSServiceRole/i,
  // eksctl-managed cluster/nodegroup stacks.
  /^eksctl-/i,
  // CFN/eksctl node roles.
  /NodeInstanceRole/i,
  // terraform-aws-eks name_prefix roles: <cluster>-cluster-<26-digit suffix>,
  // <nodegroup>-eks-node-group-<26-digit suffix>.
  /-cluster-\d+$/i,
  /-node(-group)?-\d+$/i,
  // CloudFormation generated names: <stack>-ClusterRole-<RANDOM> etc.
  /-(ClusterRole|NodeRole|NodeGroupRole|ServiceRole)-[A-Z0-9]{8,}$/,
];

/** True when an IAM role name belongs to cluster infrastructure, not workloads. */
export function isAwsInfrastructureRoleName(name: string): boolean {
  return AWS_INFRA_ROLE_PATTERNS.some((pattern) => pattern.test(name));
}

/**
 * Narrows Azure user-assigned identities to workload-identity candidates by
 * dropping AKS infrastructure identities: kubelet agentpool identities and the
 * cluster's own control-plane identity (`<cluster>-identity` in our
 * cluster-setup templates). Never falls back to the unfiltered list - offering
 * an infra identity would succeed at federation time and then fail at runtime
 * with authorization errors, which is far harder to diagnose.
 */
export function filterAzureWorkloadIdentities<T extends { name: string }>(
  identities: T[],
  clusterName?: string,
): T[] {
  const cluster = (clusterName || "").toLowerCase();
  return identities.filter((identity) => {
    const name = identity.name.toLowerCase();
    if (name.endsWith("-agentpool")) return false;
    if (cluster && name === `${cluster}-identity`) return false;
    return true;
  });
}
