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
 * Substrings to look for, ordered most-specific to least-specific. The first
 * candidate matching the highest-priority pattern wins.
 */
function patternsFor(
  category: ClusterSetupCategory,
  cluster: string,
): string[] {
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

  for (const pattern of patternsFor(category, cluster)) {
    const needle = pattern.toLowerCase();
    const index = lowered.findIndex((c) => c.includes(needle));
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
