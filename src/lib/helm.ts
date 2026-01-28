import { execa, ExecaError } from "execa";
import { HELM_CHART_OCI, ChartVersion } from "../types/index.js";
import { getHelmValuesPath } from "./config.js";

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

    const releases = (await response.json()) as Array<{
      tag_name: string;
      published_at: string;
      prerelease: boolean;
    }>;

    return releases
      .filter((r) => !r.prerelease)
      .map((r) => ({
        version: r.tag_name.replace(/^v/, ""),
        appVersion: r.tag_name.replace(/^v/, ""),
        created: r.published_at,
        digest: "",
      }));
  } catch {
    return [];
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
  },
): Promise<void> {
  const {
    releaseName,
    namespace,
    version,
    wait = true,
    timeout = "15m",
    createNamespace = true,
  } = options;

  const valuesPath = getHelmValuesPath(deploymentName);

  const args = [
    "install",
    releaseName,
    HELM_CHART_OCI,
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

/**
 * Installs or upgrades the Rulebricks Helm chart (idempotent operation).
 * Uses `helm upgrade --install` which will install if release doesn't exist,
 * or upgrade if it does. This is safe to run multiple times.
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
  },
): Promise<void> {
  const {
    releaseName,
    namespace,
    version,
    wait = true,
    timeout = "15m",
    createNamespace = true,
  } = options;

  const valuesPath = getHelmValuesPath(deploymentName);

  const args = [
    "upgrade",
    "--install", // This makes it idempotent - install if not exists, upgrade if exists
    releaseName,
    HELM_CHART_OCI,
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
  },
): Promise<void> {
  const {
    releaseName,
    namespace,
    version,
    wait = true,
    timeout = "15m",
  } = options;

  const valuesPath = getHelmValuesPath(deploymentName);

  const args = [
    "upgrade",
    releaseName,
    HELM_CHART_OCI,
    "--namespace",
    namespace,
    "--values",
    valuesPath,
  ];

  if (version) {
    args.push("--version", version);
  }

  if (wait) {
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
  } = {},
): Promise<void> {
  const { wait = false, timeout = "10m" } = options;

  const args = ["uninstall", releaseName, "--namespace", namespace];

  if (wait) {
    args.push("--wait");
    args.push("--timeout", timeout);
  }

  try {
    // 60 second process timeout to prevent hanging
    await execa("helm", args, { timeout: 60000 });
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
  },
): Promise<string> {
  const { releaseName, namespace, version } = options;
  const valuesPath = getHelmValuesPath(deploymentName);

  const args = [
    "upgrade",
    releaseName,
    HELM_CHART_OCI,
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
