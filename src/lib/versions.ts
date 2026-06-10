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

// Stock upstream Supabase Postgres image. The backup path uses pg_dump/rclone
// (no barman), so there is no longer a custom rulebricks/supabase-postgres fork.
export const SUPABASE_POSTGRES_IMAGE_REPOSITORY = "supabase/postgres";
export const SUPABASE_POSTGRES_IMAGE_TAG = "15.1.0.147";
// Cross-cloud uploader used by the backup CronJob and `rulebricks restore`.
export const RCLONE_IMAGE = "rclone/rclone:latest";

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
