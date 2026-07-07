import React, { useState, useEffect, useCallback } from "react";
import { Box, Text, useApp, useInput } from "ink";
import SelectInput from "ink-select-input";
import {
  BorderBox,
  Spinner,
  ThemeProvider,
  useTheme,
  Logo,
} from "../components/common/index.js";
import {
  loadDeploymentConfig,
  loadDeploymentState,
  updateDeploymentStatus,
  getHelmValuesPath,
} from "../lib/config.js";
import {
  upgradeChart,
  dryRunUpgrade,
  getInstalledChartVersion,
} from "../lib/helm.js";
import {
  formatDate,
  AppVersionInfo,
  getAppVersionInfo,
  hasRegistryDigestMismatch,
} from "../lib/versions.js";
import { formatVersionDisplay, normalizeVersion } from "../lib/dockerHub.js";
import {
  CHANGELOG_URL,
  AppVersion,
  DeploymentConfig,
  getNamespace,
  getReleaseName,
} from "../types/index.js";
import {
  getDeployedImageVersions,
  rolloutRestart,
  type DeployedVersions,
} from "../lib/kubernetes.js";
import fs from "fs/promises";
import YAML from "yaml";

interface UpgradeCommandProps {
  name: string;
  targetVersion?: string;
  dryRun?: boolean;
}

function hasSameVersionHpsPatch(
  version: AppVersion,
  deployedVersions: DeployedVersions | null,
): boolean {
  if (!deployedVersions) {
    return false;
  }

  const hpsVersionMatches =
    deployedVersions.hpsVersion &&
    normalizeVersion(deployedVersions.hpsVersion) ===
      normalizeVersion(version.version);
  const workerVersionMatches =
    deployedVersions.hpsWorkerVersion &&
    normalizeVersion(deployedVersions.hpsWorkerVersion) ===
      normalizeVersion(version.version);

  if (!hpsVersionMatches && !workerVersionMatches) {
    return false;
  }

  return (
    hasRegistryDigestMismatch(deployedVersions.hpsDigests, version.hpsDigests) ||
    hasRegistryDigestMismatch(
      deployedVersions.hpsWorkerDigests,
      version.hpsWorkerDigests,
    )
  );
}

type UpgradeStep =
  | "loading"
  | "select"
  | "confirm"
  | "upgrading"
  | "complete"
  | "error";

function UpgradeCommandInner({
  name,
  targetVersion,
  dryRun,
}: UpgradeCommandProps) {
  const { exit } = useApp();
  const { colors } = useTheme();
  const [step, setStep] = useState<UpgradeStep>("loading");
  const [config, setConfig] = useState<DeploymentConfig | null>(null);
  const [versionInfo, setVersionInfo] = useState<AppVersionInfo | null>(null);
  const [selectedVersion, setSelectedVersion] = useState<AppVersion | null>(
    null,
  );
  const [error, setError] = useState<string | null>(null);
  const [dryRunOutput, setDryRunOutput] = useState<string | null>(null);
  // Store actual deployed HPS version separately (may differ from expected)
  const [deployedHpsVersion, setDeployedHpsVersion] = useState<string | null>(
    null,
  );
  const [deployedVersions, setDeployedVersions] =
    useState<DeployedVersions | null>(null);

  async function resolvePinnedChartVersion(
    namespace: string,
    releaseName: string,
  ): Promise<string | undefined> {
    const state = await loadDeploymentState(name);
    const stateChartVersion = state?.application?.chartVersion;
    if (stateChartVersion && stateChartVersion !== "latest") {
      return stateChartVersion;
    }

    return (await getInstalledChartVersion(releaseName, namespace)) || undefined;
  }

  useEffect(() => {
    loadVersions();
  }, []);

  async function loadVersions() {
    try {
      const cfg = await loadDeploymentConfig(name);
      setConfig(cfg);

      const state = await loadDeploymentState(name);

      // Get actual deployed versions from Kubernetes
      const namespace = state?.application?.namespace || getNamespace(name);
      const releaseName = getReleaseName(name);
      const deployedVersions = await getDeployedImageVersions(
        releaseName,
        namespace,
      );
      setDeployedVersions(deployedVersions);

      // Use deployed version from K8s, fall back to state file if K8s query fails
      const currentVersion =
        deployedVersions.appVersion ||
        state?.application?.version ||
        null;

      // Store actual deployed HPS version for display
      setDeployedHpsVersion(deployedVersions.hpsVersion || null);

      const info = await getAppVersionInfo(cfg.licenseKey, currentVersion);
      setVersionInfo(info);

      if (targetVersion) {
        // Find the version in available list
        const targetVer = info.available.find(
          (v) => v.version === targetVersion,
        );
        if (targetVer) {
          setSelectedVersion(targetVer);
          if (dryRun) {
            await performDryRun(targetVer);
          } else {
            setStep("confirm");
          }
        } else {
          setError(`Version ${targetVersion} not found`);
          setStep("error");
        }
      } else {
        setStep("select");
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load versions");
      setStep("error");
    }
  }

  async function performDryRun(version: AppVersion) {
    try {
      // Update Helm values with the unified product version before dry run
      await updateHelmValuesWithVersion(version);

      const state = await loadDeploymentState(name);
      // Use namespace from state if available (backwards compat), otherwise compute from deployment name
      const namespace = state?.application?.namespace || getNamespace(name);
      const releaseName = getReleaseName(name);

      const chartVersion = await resolvePinnedChartVersion(namespace, releaseName);

      const output = await dryRunUpgrade(name, {
        releaseName,
        namespace,
        version: chartVersion,
      });
      setDryRunOutput(output);
      setStep("complete");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Dry run failed");
      setStep("error");
    }
  }

  async function updateHelmValuesWithVersion(version: AppVersion) {
    const valuesPath = getHelmValuesPath(name);

    try {
      const content = await fs.readFile(valuesPath, "utf8");
      const values = YAML.parse(content) as Record<string, unknown>;

      if (!values.global) {
        values.global = {};
      }
      (values.global as Record<string, unknown>).version = version.version;

      // Save updated values
      await fs.writeFile(valuesPath, YAML.stringify(values), "utf8");
    } catch (err) {
      throw new Error(`Failed to update Helm values: ${err}`);
    }
  }

  async function performUpgrade() {
    if (!selectedVersion || !config) return;

    setStep("upgrading");
    try {
      // Update Helm values with the unified product version
      await updateHelmValuesWithVersion(selectedVersion);

      const state = await loadDeploymentState(name);
      // Use namespace from state if available (backwards compat), otherwise compute from deployment name
      const namespace = state?.application?.namespace || getNamespace(name);
      const releaseName = getReleaseName(name);

      // Perform the upgrade
      const chartVersion = await resolvePinnedChartVersion(namespace, releaseName);

      await upgradeChart(name, {
        releaseName,
        namespace,
        version: chartVersion,
        wait: true,
      });

      // Force restart HPS workloads to ensure fresh images are pulled
      // (pullPolicy: Always only pulls on pod restart, not on unchanged spec).
      // HPS runs as a Deployment in current charts; fall back to statefulset
      // for releases that predate the stateless conversion.
      for (const workload of [
        `${releaseName}-hps`,
        `${releaseName}-hps-worker`,
      ]) {
        const restarted = await rolloutRestart(
          "deployment",
          workload,
          namespace,
        );
        if (!restarted) {
          await rolloutRestart("statefulset", workload, namespace);
        }
      }

      // Update deployment state
      await updateDeploymentStatus(name, "running", {
        application: {
          version: selectedVersion.version,
          chartVersion: chartVersion || state?.application?.chartVersion,
          namespace,
          url: `https://${config.domain}`,
        },
      });

      setStep("complete");
      setTimeout(() => exit(), 5000);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Upgrade failed");
      setStep("error");
    }
  }

  const handleVersionSelect = useCallback(
    (item: { value: string }) => {
      const version = versionInfo?.available.find(
        (v) => v.version === item.value,
      );
      if (version) {
        setSelectedVersion(version);
        if (dryRun) {
          performDryRun(version);
        } else {
          setStep("confirm");
        }
      }
    },
    [versionInfo, dryRun],
  );

  useInput((input, key) => {
    if (step === "confirm") {
      if (key.return) {
        performUpgrade();
      } else if (key.escape) {
        setStep("select");
      }
    }
  });

  if (step === "loading") {
    return (
      <BorderBox title="Version Manager">
        <Box marginY={1}>
          <Spinner label="Loading version information..." />
        </Box>
      </BorderBox>
    );
  }

  if (step === "error") {
    return (
      <BorderBox title="Upgrade Failed">
        <Box flexDirection="column" marginY={1}>
          <Text color={colors.error}>✗ {error}</Text>
        </Box>
      </BorderBox>
    );
  }

  if (step === "complete") {
    if (dryRun && dryRunOutput) {
      return (
        <BorderBox title="Dry Run Results">
          <Box flexDirection="column" marginY={1}>
            <Text color={colors.accent}>
              Preview of changes (no changes made):
            </Text>
            <Box marginTop={1}>
              <Text color={colors.muted}>
                {dryRunOutput.substring(0, 500)}...
              </Text>
            </Box>
          </Box>
        </BorderBox>
      );
    }

    return (
      <BorderBox title="Upgrade Complete">
        <Box flexDirection="column" marginY={1}>
          <Text color={colors.success} bold>
            ✓ Upgraded to {formatVersionDisplay(selectedVersion?.version || "")}
          </Text>
          <Box marginTop={1}>
            <Text>Run `rulebricks status {name}` to verify the deployment</Text>
          </Box>
        </Box>
      </BorderBox>
    );
  }

  if (step === "upgrading") {
    return (
      <BorderBox title="Upgrading">
        <Box marginY={1}>
          <Spinner
            label={`Installing ${formatVersionDisplay(selectedVersion?.version || "")}...`}
          />
        </Box>
      </BorderBox>
    );
  }

  if (step === "confirm") {
    return (
      <BorderBox title="Confirm Upgrade">
        <Box flexDirection="column" marginY={1}>
          <Text>
            Current:{" "}
            <Text color={colors.accent}>
              {versionInfo?.current
                ? formatVersionDisplay(versionInfo.current.version)
                : "Not installed"}
            </Text>
          </Text>
          <Text>
            Target:{" "}
            <Text color={colors.success}>
              {formatVersionDisplay(selectedVersion?.version || "")}
            </Text>
          </Text>

          <Box marginTop={1} flexDirection="column">
            <Text color={colors.warning}>
              ⚠ This will upgrade your Rulebricks deployment.
            </Text>
            <Text color={colors.muted}>
              Pods will be restarted and there may be brief downtime.
            </Text>
          </Box>

          <Box marginTop={1}>
            <Text color={colors.success} bold>
              Press Enter to continue, Esc to go back
            </Text>
          </Box>
        </Box>
      </BorderBox>
    );
  }

  // Version selection screen
  const versionItems =
    versionInfo?.available.map((v) => ({
      label: formatVersionDisplay(v.version),
      value: v.version,
      date: v.releaseDate,
      hasSameVersionPatch: hasSameVersionHpsPatch(v, deployedVersions),
      // Only mark as "current" if app and HPS versions match what's deployed
      isCurrent:
        versionInfo.current?.version === v.version &&
        (!deployedHpsVersion ||
          normalizeVersion(deployedHpsVersion) === normalizeVersion(v.version)) &&
        !hasSameVersionHpsPatch(v, deployedVersions),
      isLatest: versionInfo.latest?.version === v.version,
    })) || [];

  return (
    <BorderBox title="Rulebricks Version Manager">
      <Box flexDirection="column" marginY={1}>
        {/* Current/Latest status */}
        {(() => {
          // Check if HPS has an update available (even if app version is current)
          const hasHpsDigestUpdate = versionInfo?.latest
            ? hasSameVersionHpsPatch(versionInfo.latest, deployedVersions)
            : false;
          const hasHpsUpdate =
            hasHpsDigestUpdate ||
            !!(
              deployedHpsVersion &&
              versionInfo?.latest &&
              normalizeVersion(deployedHpsVersion) !==
                normalizeVersion(versionInfo.latest.version)
            );
          const hasAnyUpdate = versionInfo?.hasUpdate || hasHpsUpdate;

          return (
            <Box flexDirection="column" marginBottom={1}>
              <Text>
                Current:{" "}
                <Text color={colors.accent}>
                  {versionInfo?.current
                    ? formatVersionDisplay(versionInfo.current.version)
                    : "Not installed"}
                </Text>
              </Text>
              <Text>
                Latest:{" "}
                <Text color={hasAnyUpdate ? colors.success : colors.accent}>
                  {versionInfo?.latest
                    ? formatVersionDisplay(versionInfo.latest.version)
                    : "Unknown"}
                </Text>
              </Text>
              {hasAnyUpdate && (
                <Text color={colors.muted} dimColor>
                  {hasHpsDigestUpdate
                    ? "HPS patch available for the installed version"
                    : "Update available"}
                </Text>
              )}
            </Box>
          );
        })()}

        {/* Changelog link */}
        <Box
          marginBottom={1}
          paddingX={1}
          borderStyle="single"
          borderColor={colors.accent}
          alignSelf="flex-start"
        >
          <Text>📚 What's new: </Text>
          <Text color={colors.accent} underline>
            {CHANGELOG_URL}
          </Text>
        </Box>

        {/* Version selector */}
        <Text bold>Select Rulebricks version to install:</Text>
        <Box marginTop={1}>
          <SelectInput
            items={versionItems}
            onSelect={handleVersionSelect}
            limit={8}
            itemComponent={({ isSelected, label }) => {
              const vItem =
                versionItems.find((v) => v.label === label) || versionItems[0];

              // Highlight latest in green when there's an update available
              const isLatestWithUpdate = vItem.isLatest && !vItem.isCurrent;
              const labelColor = isSelected
                ? colors.accent
                : isLatestWithUpdate
                  ? colors.success
                  : undefined;

              return (
                <Box>
                  <Text color={labelColor}>{label}</Text>
                  {vItem.isCurrent && (
                    <Text color={colors.warning}> current</Text>
                  )}
                  {vItem.hasSameVersionPatch && (
                    <Text color={colors.success}> patch available</Text>
                  )}
                  <Text color={colors.muted}> {formatDate(vItem.date)}</Text>
                </Box>
              );
            }}
          />
        </Box>
      </Box>
    </BorderBox>
  );
}

export function UpgradeCommand(props: UpgradeCommandProps) {
  return (
    <ThemeProvider theme="upgrade">
      <Logo />
      <UpgradeCommandInner {...props} />
    </ThemeProvider>
  );
}
