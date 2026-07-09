import {
  ChartVersion,
  CHANGELOG_URL,
  AppVersion,
  NodeArchitecture,
  getNamespace,
  getReleaseName,
} from "../types/index.js";
import { fetchChartVersions, getInstalledVersion } from "./helm.js";
import {
  fetchAllImageTags,
  ImageTag,
  normalizeVersion,
} from "./dockerHub.js";

// ============================================================================
// Image registry & repositories
// ============================================================================
// Every image the chart pulls lives under docker.io/rulebricks/* (mirrored or
// built by the helm repo's images/manifest.yaml pipeline). The CLI sets the
// rulebricks/* defaults; when config.imageRegistry is set, the registry HOST is
// rewritten per chart while the rulebricks/<name> path is kept.
//
// TAGS ARE NOT PINNED HERE. They are resolved at values-generation time from
// the chart's own images/manifest.yaml (the SSOT) for the exact chart version
// being installed — see src/lib/imageCatalog.ts. Only the stable repository
// paths live in this file.
export const DEFAULT_IMAGE_REGISTRY = "docker.io";

// Self-hosted Supabase Postgres image (mirrored to rulebricks/*). The backup
// path uses pg_dump/rclone (no barman), so there is no custom fork.
export const SUPABASE_POSTGRES_IMAGE_REPOSITORY = "rulebricks/supabase-postgres";

/**
 * Repository paths for the rulebricks/* images the CLI sets directly: the app
 * stack, clickstack, the kafka-proxy bridge, and the Tier-2 upstream
 * charts. The registry HOST is overridable via config.imageRegistry; the
 * repository path (rulebricks/<name>) is never changed. Tags come from the
 * chart's image manifest at runtime (src/lib/imageCatalog.ts).
 */
export const IMAGE_REPOSITORIES = {
  // App stack (pinned by global.version, not by a fixed tag here)
  app: "rulebricks/app",
  hps: "rulebricks/hps",
  // ClickStack
  hyperdx: "rulebricks/hyperdx",
  clickstackOtelCollector: "rulebricks/clickstack-otel-collector",
  ferretdb: "rulebricks/ferretdb",
  postgresDocumentdb: "rulebricks/postgres-documentdb",
  // Parent-chart OpenTelemetry collector (BYO tracing, ClickStack disabled)
  opentelemetryCollector: "rulebricks/opentelemetry-collector",
  // Bridge sidecar
  kafkaProxy: "rulebricks/kafka-proxy",
  // CA-bundle seeder for the hardened vector image (ships no system CA store);
  // also a general-purpose curl.
  curl: "rulebricks/curl",
  // --- Tier-2: kube-prometheus-stack sub-images ---
  prometheus: "rulebricks/prometheus",
  alertmanager: "rulebricks/alertmanager",
  prometheusOperator: "rulebricks/prometheus-operator",
  prometheusConfigReloader: "rulebricks/prometheus-config-reloader",
  kubeWebhookCertgen: "rulebricks/kube-webhook-certgen",
  grafana: "rulebricks/grafana",
  k8sSidecar: "rulebricks/k8s-sidecar",
  kubeStateMetrics: "rulebricks/kube-state-metrics",
  nodeExporter: "rulebricks/node-exporter",
  // --- Tier-2: cert-manager ---
  certManagerController: "rulebricks/cert-manager-controller",
  certManagerWebhook: "rulebricks/cert-manager-webhook",
  certManagerCainjector: "rulebricks/cert-manager-cainjector",
  certManagerStartupapicheck: "rulebricks/cert-manager-startupapicheck",
  certManagerAcmesolver: "rulebricks/cert-manager-acmesolver",
  // --- Tier-2: traefik / keda / vector / external-dns / cluster-autoscaler ---
  traefik: "rulebricks/traefik",
  keda: "rulebricks/keda",
  kedaMetricsApiServer: "rulebricks/keda-metrics-apiserver",
  kedaAdmissionWebhooks: "rulebricks/keda-admission-webhooks",
  vector: "rulebricks/vector",
  externalDns: "rulebricks/external-dns",
  clusterAutoscaler: "rulebricks/cluster-autoscaler",
} as const;

/**
 * Gets version information for display (legacy chart-based)
 */
export interface VersionInfo {
  current: string | null;
  latest: string | null;
  available: ChartVersion[];
  hasUpdate: boolean;
  changelogUrl: string;
}

/**
 * Product version information
 */
export interface AppVersionInfo {
  current: AppVersion | null;
  latest: AppVersion | null;
  available: AppVersion[];
  hasUpdate: boolean;
  changelogUrl: string;
}

export function hasRegistryDigestMismatch(
  deployedDigests: string[],
  registryDigests?: string[],
): boolean {
  if (deployedDigests.length === 0 || !registryDigests?.length) {
    return false;
  }

  const registryDigestSet = new Set(registryDigests);
  return deployedDigests.some((digest) => !registryDigestSet.has(digest));
}

/**
 * Fetches complete version information (legacy chart-based)
 */
export async function getVersionInfo(
  deploymentName: string,
  overrideNamespace?: string,
): Promise<VersionInfo> {
  const namespace = overrideNamespace || getNamespace(deploymentName);
  const releaseName = getReleaseName(deploymentName);

  const [current, available] = await Promise.all([
    getInstalledVersion(releaseName, namespace),
    fetchChartVersions(),
  ]);

  const latest = available.length > 0 ? available[0].version : null;
  const hasUpdate = !!(current && latest && current !== latest);

  return {
    current,
    latest,
    available,
    hasUpdate,
    changelogUrl: CHANGELOG_URL,
  };
}

const KNOWN_BAD_PRODUCT_VERSIONS = new Set(["0.0.1"]);

function isSingleNodeArchitecture(
  architecture?: NodeArchitecture,
): architecture is "amd64" | "arm64" {
  return architecture === "amd64" || architecture === "arm64";
}

function supportsArchitecture(
  tag: ImageTag,
  architecture?: NodeArchitecture,
): boolean {
  if (!isSingleNodeArchitecture(architecture)) return true;
  return tag.architectures.includes(architecture);
}

/**
 * Matches app versions to exact HPS server and worker versions.
 *
 * @param appTags - Array of app image tags
 * @param hpsTags - Array of HPS image tags
 * @param hpsWorkerTags - Array of HPS worker image tags
 * @returns Array of product versions with app, HPS, and worker images available
 */
export function matchExactHpsVersions(
  appTags: ImageTag[],
  hpsTags: ImageTag[],
  hpsWorkerTags: ImageTag[],
  architecture?: NodeArchitecture,
): AppVersion[] {
  const compatibleAppTags = appTags.filter((tag) =>
    supportsArchitecture(tag, architecture),
  );
  const hpsByVersion = new Map(
    hpsTags
      .filter((tag) => supportsArchitecture(tag, architecture))
      .map((tag) => [normalizeVersion(tag.name), tag]),
  );
  const workerByVersion = new Map(
    hpsWorkerTags
      .filter((tag) => supportsArchitecture(tag, architecture))
      .map((tag) => [normalizeVersion(tag.name.replace(/^worker-/, "")), tag]),
  );

  return compatibleAppTags
    .flatMap((appTag) => {
      const version = normalizeVersion(appTag.name);
      if (KNOWN_BAD_PRODUCT_VERSIONS.has(version)) {
        return [];
      }

      const matchedHps = hpsByVersion.get(version);
      const matchedWorker = workerByVersion.get(version);
      if (!matchedHps || !matchedWorker) {
        return [];
      }

      return {
        version,
        releaseDate: appTag.lastUpdated.toISOString(),
        digest: appTag.digest,
        hpsDigests: matchedHps.imageDigests,
        hpsWorkerDigests: matchedWorker.imageDigests,
      };
    })
    .sort((a, b) => compareVersions(b.version, a.version));
}

/**
 * Fetches product versions with app, HPS, and worker images from Docker Hub
 *
 * @param licenseKey - The Rulebricks license key (Docker PAT)
 * @returns Array of AppVersion objects
 */
export async function fetchAppVersions(
  licenseKey: string,
  architecture?: NodeArchitecture,
): Promise<AppVersion[]> {
  const { appTags, hpsTags, hpsWorkerTags } = await fetchAllImageTags(licenseKey);
  return matchExactHpsVersions(appTags, hpsTags, hpsWorkerTags, architecture);
}

/**
 * Gets complete app version information for a deployment
 *
 * @param licenseKey - The Rulebricks license key
 * @param currentAppVersion - Currently installed app version (if known)
 * @returns AppVersionInfo with current, latest, and available versions
 */
export async function getAppVersionInfo(
  licenseKey: string,
  currentAppVersion?: string | null,
  architecture?: NodeArchitecture,
): Promise<AppVersionInfo> {
  const available = await fetchAppVersions(licenseKey, architecture);

  const latest = available.length > 0 ? available[0] : null;

  // Find current version in available list
  const current = currentAppVersion
    ? available.find(
        (v) => v.version === normalizeVersion(currentAppVersion),
      ) || null
    : null;

  const hasUpdate = !!(
    current &&
    latest &&
    normalizeVersion(current.version) !== normalizeVersion(latest.version)
  );

  return {
    current,
    latest,
    available,
    hasUpdate,
    changelogUrl: CHANGELOG_URL,
  };
}

/**
 * Formats a version for display
 */
export function formatVersion(version: string | null): string {
  if (!version) return "Not installed";
  return version.startsWith("v") ? version : `v${version}`;
}

/**
 * Compares two versions
 * Returns: negative if a < b, positive if a > b, 0 if equal
 */
export function compareVersions(a: string, b: string): number {
  const parseVersion = (v: string) => {
    const clean = v.replace(/^v/, "");
    return clean.split(".").map((n) => parseInt(n, 10) || 0);
  };

  const aParts = parseVersion(a);
  const bParts = parseVersion(b);

  for (let i = 0; i < Math.max(aParts.length, bParts.length); i++) {
    const aVal = aParts[i] ?? 0;
    const bVal = bParts[i] ?? 0;
    if (aVal !== bVal) {
      return aVal - bVal;
    }
  }

  return 0;
}

/**
 * Checks if a version is newer than another
 */
export function isNewerVersion(version: string, than: string): boolean {
  return compareVersions(version, than) > 0;
}

/**
 * Formats a date for display
 */
export function formatDate(dateString: string): string {
  const date = new Date(dateString);
  return date.toLocaleDateString("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}
