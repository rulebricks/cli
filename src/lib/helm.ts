import { execa, ExecaError } from "execa";
import { HELM_CHART_OCI, ChartVersion } from "../types/index.js";
import { getHelmValuesPath } from "./config.js";
import { deletePVCs } from "./kubernetes.js";

/**
 * Extracts meaningful error message from execa error
 */
function getErrorMessage(error: unknown): string {
  const execaError = error as ExecaError;
  // Try stderr first, then stdout
  const output = execaError.stderr || execaError.stdout || "";
  if (output) {
    // Get last 500 chars of output for the error message
    const truncated = output.length > 500 ? "..." + output.slice(-500) : output;
    return truncated;
  }
  return execaError.shortMessage || execaError.message || "Unknown error";
}

/**
 * Checks if Helm is installed
 */
export async function isHelmInstalled(): Promise<boolean> {
  try {
    await execa("helm", ["version", "--short"]);
    return true;
  } catch {
    return false;
  }
}

/**
 * Gets the installed Helm version
 */
export async function getHelmVersion(): Promise<string> {
  const { stdout } = await execa("helm", ["version", "--short"]);
  return stdout.trim();
}

/**
 * Fetches available chart versions from the OCI registry
 */
export async function fetchChartVersions(): Promise<ChartVersion[]> {
  try {
    // Use helm show chart to get info about the latest version
    const { stdout } = await execa("helm", ["show", "chart", HELM_CHART_OCI]);

    // Parse the chart info
    const lines = stdout.split("\n");
    const versionLine = lines.find((l) => l.startsWith("version:"));
    const appVersionLine = lines.find((l) => l.startsWith("appVersion:"));

    const version = versionLine?.split(":")[1]?.trim() || "unknown";
    const appVersion = appVersionLine?.split(":")[1]?.trim() || version;

    // Return at least the current version
    return [
      {
        version,
        appVersion,
        created: new Date().toISOString(),
        digest: "",
      },
    ];
  } catch (error) {
    // If we can't fetch, try to get from GitHub API
    return fetchVersionsFromGitHub();
  }
}

/**
 * Compares two semver-ish strings (local copy: versions.ts imports this
 * module, so helm.ts cannot import compareVersions from there).
 */
function compareChartVersions(a: string, b: string): number {
  const parse = (v: string) =>
    v.replace(/^v/, "").split(".").map((n) => parseInt(n, 10) || 0);
  const aParts = parse(a);
  const bParts = parse(b);
  for (let i = 0; i < Math.max(aParts.length, bParts.length); i++) {
    const diff = (aParts[i] ?? 0) - (bParts[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

/**
 * Parses the GitHub releases API payload for the helm repo into chart
 * versions: prereleases dropped, v-prefix stripped, newest first.
 */
export function parseGitHubReleases(payload: unknown): ChartVersion[] {
  if (!Array.isArray(payload)) return [];
  return payload
    .filter(
      (r): r is { tag_name: string; published_at: string; prerelease?: boolean } =>
        !!r &&
        typeof r === "object" &&
        typeof (r as { tag_name?: unknown }).tag_name === "string" &&
        typeof (r as { published_at?: unknown }).published_at === "string",
    )
    .filter((r) => !r.prerelease)
    .map((r) => ({
      version: r.tag_name.replace(/^v/, ""),
      appVersion: r.tag_name.replace(/^v/, ""),
      created: r.published_at,
      digest: "",
    }))
    .sort((a, b) => compareChartVersions(b.version, a.version));
}

/**
 * Fetches versions from GitHub releases API
 */
async function fetchVersionsFromGitHub(): Promise<ChartVersion[]> {
  try {
    const response = await fetch(
      "https://api.github.com/repos/rulebricks/helm/releases",
    );
    if (!response.ok) {
      throw new Error(`GitHub API returned ${response.status}`);
    }

    return parseGitHubReleases(await response.json());
  } catch {
    return [];
  }
}

/**
 * Fetches the full list of chart versions with release dates for the chart
 * upgrade selector. GitHub releases is the primary source (it carries dates
 * and the whole history); the OCI registry's `helm show chart` is the
 * fallback, which can only report the single latest version.
 */
export async function fetchAvailableChartVersions(): Promise<ChartVersion[]> {
  const fromGitHub = await fetchVersionsFromGitHub();
  if (fromGitHub.length > 0) {
    return fromGitHub;
  }
  return fetchChartVersions();
}

/**
 * Gets a release's COMPUTED values (chart defaults + user overrides) as JSON.
 * Returns null when the release does not exist or helm fails.
 */
export async function getReleaseComputedValues(
  releaseName: string,
  namespace: string,
): Promise<Record<string, unknown> | null> {
  try {
    const { stdout } = await execa(
      "helm",
      ["get", "values", releaseName, "-n", namespace, "--all", "-o", "json"],
      { timeout: 30000 },
    );
    return JSON.parse(stdout) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/**
 * Gets the currently installed chart version for a deployment
 */
export async function getInstalledVersion(
  releaseName: string,
  namespace: string,
): Promise<string | null> {
  try {
    const { stdout } = await execa(
      "helm",
      ["list", "-n", namespace, "-f", `^${releaseName}$`, "-o", "json"],
      { timeout: 15000 },
    ); // 15 second timeout

    const releases = JSON.parse(stdout) as Array<{
      name: string;
      chart: string;
      app_version: string;
    }>;

    if (releases.length > 0) {
      return (
        releases[0].app_version || releases[0].chart.split("-").pop() || null
      );
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Gets the installed Helm chart version for a deployment.
 */
export async function getInstalledChartVersion(
  releaseName: string,
  namespace: string,
): Promise<string | null> {
  try {
    const { stdout } = await execa(
      "helm",
      ["list", "-n", namespace, "-f", `^${releaseName}$`, "-o", "json"],
      { timeout: 15000 },
    );

    const releases = JSON.parse(stdout) as Array<{
      chart: string;
    }>;

    if (releases.length === 0) {
      return null;
    }

    return releases[0].chart.split("-").pop() || null;
  } catch {
    return null;
  }
}

/**
 * Installs the Rulebricks Helm chart (use installOrUpgradeChart for idempotent operations)
 */
export async function installChart(
  deploymentName: string,
  options: {
    releaseName: string;
    namespace: string;
    version?: string;
    wait?: boolean;
    timeout?: string;
    createNamespace?: boolean;
    /** Chart OCI ref to install from (a fully mirrored registry's copy). */
    chartRef?: string;
  },
): Promise<void> {
  const {
    releaseName,
    namespace,
    version,
    wait = true,
    timeout = "15m",
    createNamespace = true,
    chartRef = HELM_CHART_OCI,
  } = options;

  const valuesPath = getHelmValuesPath(deploymentName);

  const args = [
    "install",
    releaseName,
    chartRef,
    "--namespace",
    namespace,
    "--values",
    valuesPath,
  ];

  if (version) {
    args.push("--version", version);
  }

  if (createNamespace) {
    args.push("--create-namespace");
  }

  if (wait) {
    args.push("--wait");
    args.push("--timeout", timeout);
  }

  try {
    await execa("helm", args);
  } catch (error) {
    throw new Error(`Helm install failed:\n${getErrorMessage(error)}`);
  }
}

interface HelmHistoryEntry {
  revision?: number;
  status?: string;
}

/**
 * Latest revision status for a release, or undefined when it has none.
 * Used by the stranded-release recovery to pick the right cleanup: helm can
 * uninstall failed/pending releases, but a record stuck in "uninstalling"
 * (a previous uninstall was interrupted) makes `helm uninstall` hang forever,
 * so that state is cleared by deleting the release-record Secrets instead.
 */
async function latestReleaseStatus(
  releaseName: string,
  namespace: string,
): Promise<string | undefined> {
  try {
    const { stdout } = await execa(
      "helm",
      ["history", releaseName, "--namespace", namespace, "--output", "json"],
      { timeout: 30000 },
    );
    const entries = JSON.parse(stdout) as HelmHistoryEntry[];
    return Array.isArray(entries) && entries.length > 0
      ? entries[entries.length - 1].status
      : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Removes the release-record Secrets (sh.helm.release.v1.<name>.vN) for a
 * release whose uninstall was interrupted and left the record wedged in
 * "uninstalling": helm refuses to install over it, upgrade fails with "has
 * no deployed releases", and re-running uninstall hangs. The release's
 * RESOURCES were already deleted by the interrupted uninstall (or will be
 * replaced by the fresh install of the same manifests).
 */
async function deleteReleaseRecords(
  releaseName: string,
  namespace: string,
): Promise<void> {
  await execa(
    "kubectl",
    [
      "delete",
      "secret",
      "--namespace",
      namespace,
      "--selector",
      `owner=helm,name=${releaseName}`,
      "--ignore-not-found",
    ],
    { timeout: 60000 },
  );
}

/**
 * True when an existing release is stranded where `helm upgrade --install`
 * cannot act: no revision was ever deployed, because the FIRST install failed
 * (e.g. its --wait timed out) or a helm process died mid-install and left
 * `pending-install` behind. Upgrading such a release fails with "has no
 * deployed releases" / "another operation is in progress", so the only way
 * forward is uninstalling the dead release and installing fresh - safe
 * precisely because nothing was ever successfully deployed. Fail-open: a
 * missing release or unreadable history reports false and lets helm surface
 * its own error.
 */
async function isReleaseStrandedBeforeFirstDeploy(
  releaseName: string,
  namespace: string,
): Promise<boolean> {
  let stdout: string;
  try {
    ({ stdout } = await execa(
      "helm",
      ["history", releaseName, "--namespace", namespace, "--output", "json"],
      { timeout: 30000 },
    ));
  } catch {
    // Release not found (fresh install) or history unavailable.
    return false;
  }

  try {
    const entries = JSON.parse(stdout) as HelmHistoryEntry[];
    if (!Array.isArray(entries) || entries.length === 0) return false;
    const everDeployed = entries.some(
      (entry) => entry.status === "deployed" || entry.status === "superseded",
    );
    if (everDeployed) return false;
    const latest = entries[entries.length - 1];
    // "uninstalling" appears when a previous uninstall was interrupted (e.g.
    // process killed mid-wait): resources may be gone but the record stays,
    // and helm can neither install over it nor upgrade it. Re-running
    // uninstall clears it.
    return (
      latest.status === "failed" ||
      latest.status === "pending-install" ||
      latest.status === "uninstalling"
    );
  } catch {
    return false;
  }
}

/**
 * Installs or upgrades the Rulebricks Helm chart (idempotent operation).
 * Uses `helm upgrade --install` which will install if release doesn't exist,
 * or upgrade if it does. This is safe to run multiple times.
 *
 * A release stranded before its first successful deploy (failed or orphaned
 * pending-install revision 1) is uninstalled first, since helm cannot upgrade
 * past it. NOTE: this also matches a pending-install held by a live helm
 * process; the CLI runs one deploy per deployment at a time, so a stuck lock
 * is by far the more likely owner.
 */
export async function installOrUpgradeChart(
  deploymentName: string,
  options: {
    releaseName: string;
    namespace: string;
    version?: string;
    wait?: boolean;
    timeout?: string;
    createNamespace?: boolean;
    /** Chart OCI ref to install from (a fully mirrored registry's copy). */
    chartRef?: string;
  },
): Promise<void> {
  const {
    releaseName,
    namespace,
    version,
    wait = true,
    timeout = "15m",
    createNamespace = true,
    chartRef = HELM_CHART_OCI,
  } = options;

  if (await isReleaseStrandedBeforeFirstDeploy(releaseName, namespace)) {
    if ((await latestReleaseStatus(releaseName, namespace)) === "uninstalling") {
      // A previous uninstall was interrupted: resources are gone but the
      // record is wedged, and `helm uninstall` on it hangs forever. Clear
      // the record directly.
      await deleteReleaseRecords(releaseName, namespace);
    } else {
      // Wait for resource deletion so the fresh install below never races
      // still-terminating objects from the dead release.
      await uninstallChart(releaseName, namespace, {
        wait: true,
        timeout: "15m",
        processTimeoutMs: 15 * 60_000,
      });
    }
    // uninstallChart tolerates process timeouts (destroy semantics), so the
    // uninstall may still be running here. Installing while release records
    // exist fails with "has no deployed releases" - poll until they are gone
    // before proceeding, and fail with a real message instead if they aren't.
    const deadline = Date.now() + 5 * 60_000;
    for (;;) {
      try {
        await execa(
          "helm",
          ["status", releaseName, "--namespace", namespace],
          { timeout: 30000 },
        );
      } catch {
        // Release records gone: safe to install fresh.
        break;
      }
      if (Date.now() > deadline) {
        throw new Error(
          `Release ${releaseName} is still uninstalling after its stranded ` +
            `first install; wait for 'helm status ${releaseName} -n ${namespace}' ` +
            `to report "not found", then rerun the deploy.`,
        );
      }
      await new Promise((resolve) => setTimeout(resolve, 10_000));
    }
    // Stranded-before-first-deploy means the release NEVER worked, so its
    // PVCs hold nothing worth keeping - and leaving them poisons the fresh
    // install: StatefulSets re-adopt the old volumes, and e.g. Kafka refuses
    // to start on data formatted with the previous install's cluster ID
    // ("Invalid cluster.id in .../meta.properties" crashloop). The namespace
    // is exclusively this deployment's.
    await deletePVCs(namespace);
  }

  const valuesPath = getHelmValuesPath(deploymentName);

  const args = [
    "upgrade",
    "--install", // This makes it idempotent - install if not exists, upgrade if exists
    releaseName,
    chartRef,
    "--namespace",
    namespace,
    "--values",
    valuesPath,
  ];

  if (version) {
    args.push("--version", version);
  }

  if (createNamespace) {
    args.push("--create-namespace");
  }

  if (wait) {
    args.push("--wait");
    args.push("--timeout", timeout);
  }

  try {
    await execa("helm", args);
  } catch (error) {
    throw new Error(`Helm install/upgrade failed:\n${getErrorMessage(error)}`);
  }
}

/**
 * Upgrades the Rulebricks Helm chart
 */
export async function upgradeChart(
  deploymentName: string,
  options: {
    releaseName: string;
    namespace: string;
    version?: string;
    wait?: boolean;
    timeout?: string;
    /** Roll the release back automatically when the upgrade fails. */
    atomic?: boolean;
    /** Chart OCI ref to upgrade from (a fully mirrored registry's copy). */
    chartRef?: string;
  },
): Promise<void> {
  const {
    releaseName,
    namespace,
    version,
    wait = true,
    timeout = "15m",
    atomic = false,
    chartRef = HELM_CHART_OCI,
  } = options;

  const valuesPath = getHelmValuesPath(deploymentName);

  const args = [
    "upgrade",
    releaseName,
    chartRef,
    "--namespace",
    namespace,
    "--values",
    valuesPath,
  ];

  if (version) {
    args.push("--version", version);
  }

  if (atomic) {
    // --atomic implies --wait; a failed upgrade rolls back to the previous
    // release instead of leaving it stranded mid-upgrade.
    args.push("--atomic");
    args.push("--timeout", timeout);
  } else if (wait) {
    args.push("--wait");
    args.push("--timeout", timeout);
  }

  try {
    await execa("helm", args);
  } catch (error) {
    throw new Error(`Helm upgrade failed:\n${getErrorMessage(error)}`);
  }
}

/**
 * Uninstalls the Rulebricks Helm chart
 */
export async function uninstallChart(
  releaseName: string,
  namespace: string,
  options: {
    wait?: boolean;
    timeout?: string;
    /**
     * Kill-switch for the helm process itself (default 60s). Callers that
     * pass wait: true should raise it to at least the helm --timeout, or the
     * wait is silently cut short (timeouts are tolerated below).
     */
    processTimeoutMs?: number;
  } = {},
): Promise<void> {
  const { wait = false, timeout = "10m", processTimeoutMs = 60000 } = options;

  const args = ["uninstall", releaseName, "--namespace", namespace];

  if (wait) {
    args.push("--wait");
    args.push("--timeout", timeout);
  }

  try {
    await execa("helm", args, { timeout: processTimeoutMs });
  } catch (error) {
    const execaError = error as ExecaError;
    // Ignore "release not found" errors and timeouts (we'll continue anyway)
    const errorMsg = execaError.stderr || execaError.message || "";
    if (!errorMsg.includes("not found") && !execaError.timedOut) {
      throw new Error(`Helm uninstall failed:\n${getErrorMessage(error)}`);
    }
  }
}

/**
 * Performs a dry-run upgrade to preview changes
 */
export async function dryRunUpgrade(
  deploymentName: string,
  options: {
    releaseName: string;
    namespace: string;
    version?: string;
    /** Chart OCI ref to render from (a fully mirrored registry's copy). */
    chartRef?: string;
  },
): Promise<string> {
  const {
    releaseName,
    namespace,
    version,
    chartRef = HELM_CHART_OCI,
  } = options;
  const valuesPath = getHelmValuesPath(deploymentName);

  const args = [
    "upgrade",
    releaseName,
    chartRef,
    "--namespace",
    namespace,
    "--values",
    valuesPath,
    "--dry-run",
  ];

  if (version) {
    args.push("--version", version);
  }

  const { stdout } = await execa("helm", args);
  return stdout;
}
