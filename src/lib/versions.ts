import {
  ChartVersion,
  CHANGELOG_URL,
  AppVersion,
  getNamespace,
  getReleaseName,
} from "../types/index.js";
import { fetchChartVersions, getInstalledVersion } from "./helm.js";
import {
  fetchAllImageTags,
  ImageTag,
  normalizeVersion,
  formatVersionDisplay,
} from "./dockerHub.js";

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
 * App version information with matched HPS version
 */
export interface AppVersionInfo {
  current: AppVersion | null;
  latest: AppVersion | null;
  available: AppVersion[];
  hasUpdate: boolean;
  changelogUrl: string;
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

/**
 * Normalizes a Date to the start of day (midnight UTC).
 * This allows comparing dates without time components.
 */
function toStartOfDay(date: Date): Date {
  const d = new Date(date);
  d.setUTCHours(0, 0, 0, 0);
  return d;
}

/**
 * Matches HPS versions to app versions based on release dates.
 * For each app version, finds the latest HPS version released on or before that date.
 * Compares dates only (ignoring time), so an HPS released later in the same day
 * as the app version will still be matched.
 *
 * @param appTags - Array of app image tags
 * @param hpsTags - Array of HPS image tags
 * @returns Array of AppVersion with matched HPS versions
 */
export function matchHpsVersions(
  appTags: ImageTag[],
  hpsTags: ImageTag[],
): AppVersion[] {
  // Sort HPS tags by date descending for efficient matching
  const sortedHpsTags = [...hpsTags].sort(
    (a, b) => b.lastUpdated.getTime() - a.lastUpdated.getTime(),
  );

  return appTags.map((appTag) => {
    // Normalize app release date to start of day for comparison
    const appDateStart = toStartOfDay(appTag.lastUpdated);

    // Find the latest HPS version released on or before the app version's date
    // Compare by date only (start of day), ignoring time
    const matchedHps = sortedHpsTags.find(
      (hpsTag) =>
        toStartOfDay(hpsTag.lastUpdated).getTime() <= appDateStart.getTime(),
    );

    return {
      version: normalizeVersion(appTag.name),
      releaseDate: appTag.lastUpdated.toISOString(),
      hpsVersion: matchedHps ? normalizeVersion(matchedHps.name) : null,
      digest: appTag.digest,
    };
  });
}

/**
 * Fetches app versions with matched HPS versions from Docker Hub
 *
 * @param licenseKey - The Rulebricks license key (Docker PAT)
 * @returns Array of AppVersion objects
 */
export async function fetchAppVersions(
  licenseKey: string,
): Promise<AppVersion[]> {
  const { appTags, hpsTags } = await fetchAllImageTags(licenseKey);
  return matchHpsVersions(appTags, hpsTags);
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
): Promise<AppVersionInfo> {
  const available = await fetchAppVersions(licenseKey);

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
