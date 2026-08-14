import React, { useState, useEffect, useCallback } from "react";
import { Box, Text, useApp, useInput } from "ink";
import SelectInput from "ink-select-input";
import fs from "fs/promises";
import path from "path";
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
  saveDeploymentConfig,
  updateDeploymentStatus,
  getDeploymentDir,
  getHelmValuesPath,
  loadHelmValues,
} from "../lib/config.js";
import {
  fetchAvailableChartVersions,
  upgradeChart,
  dryRunUpgrade,
  getInstalledChartVersion,
  isHelmSsaConflict,
} from "../lib/helm.js";
import {
  deriveTlsEnabled,
  generateHelmValuesPreservingEdits,
} from "../lib/helmValues.js";
import { resolveImageCatalog } from "../lib/imageCatalog.js";
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
  ChartVersion,
  DeploymentConfig,
  getNamespace,
  getReleaseName,
} from "../types/index.js";
import {
  getDeployedImageVersions,
  rolloutRestart,
  type DeployedVersions,
} from "../lib/kubernetes.js";
import {
  assertAcrMirrorSucceeded,
  chartOciRef,
  helmRegistryLoginToAcr,
  mirrorChartToAcr,
  mirrorImagesToAcr,
  planAcrImports,
  shouldMirrorToAcr,
} from "../lib/cloudCli.js";
import { ensureNamespace, applyDeploymentSecrets } from "../lib/secrets.js";
import { setupExternalSecrets } from "../lib/eso.js";
import { secretModeForConfig } from "../lib/deploySequence.js";
import { runUpgradeReconciliation } from "../lib/upgradeReconciliation.js";

const CHART_RELEASES_URL = "https://github.com/rulebricks/helm/releases";

interface UpgradeCommandProps {
  name: string;
  /** Skip the app picker and target this product version. */
  targetVersion?: string;
  /** Skip the chart picker and target this chart version. */
  targetChartVersion?: string;
  dryRun?: boolean;
  /** Allow one guarded Helm 4 SSA conflict retry without prompting. */
  forceConflicts?: boolean;
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

function chartVersionsEqual(
  a: string | null | undefined,
  b: string | null | undefined,
): boolean {
  if (!a || !b) return false;
  return a === b;
}

/**
 * Full-mirror registries: import the chart release into the ACR (a no-op when
 * already present - chart releases are immutable) and log the local helm
 * client in so upgrade/dry-run can pull the chart from the registry. Also
 * covers releases installed before chart mirroring existed, whose current
 * chart version is not in the registry yet. No-op outside full-mirror mode.
 */
async function ensureMirroredChart(
  cfg: DeploymentConfig,
  chartVersion: string,
): Promise<void> {
  if (!shouldMirrorToAcr(cfg)) {
    return;
  }
  const registry = cfg.imageRegistry!;
  const registryName = registry.split(".")[0];
  const chartMirror = await mirrorChartToAcr(
    registryName,
    chartVersion,
    cfg.imageRegistryResourceId,
  );
  assertAcrMirrorSucceeded(
    registry,
    chartMirror,
    `Mirroring helm chart ${chartVersion}`,
  );
  await helmRegistryLoginToAcr(
    registryName,
    registry,
    cfg.imageRegistryResourceId,
  );
}

type UpgradeStep =
  | "loading"
  | "selectApp"
  | "selectChart"
  | "preparing"
  | "confirm"
  | "confirmForceConflicts"
  | "upgrading"
  | "complete"
  | "error";

function UpgradeCommandInner({
  name,
  targetVersion,
  targetChartVersion,
  dryRun,
  forceConflicts,
}: UpgradeCommandProps) {
  const { exit } = useApp();
  const { colors } = useTheme();
  const [step, setStep] = useState<UpgradeStep>("loading");
  const [config, setConfig] = useState<DeploymentConfig | null>(null);
  const [versionInfo, setVersionInfo] = useState<AppVersionInfo | null>(null);
  const [selectedApp, setSelectedApp] = useState<AppVersion | null>(null);
  const [availableCharts, setAvailableCharts] = useState<ChartVersion[]>([]);
  const [installedChartVersion, setInstalledChartVersion] = useState<
    string | null
  >(null);
  const [selectedChart, setSelectedChart] = useState<ChartVersion | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [dryRunOutput, setDryRunOutput] = useState<string | null>(null);
  const [rolledBack, setRolledBack] = useState(false);
  const [ssaConflictError, setSsaConflictError] = useState<string | null>(null);
  const [secretsWarning, setSecretsWarning] = useState<string | null>(null);
  const [deployedHpsVersion, setDeployedHpsVersion] = useState<string | null>(
    null,
  );
  const [deployedVersions, setDeployedVersions] =
    useState<DeployedVersions | null>(null);
  const [namespace, setNamespace] = useState(getNamespace(name));

  const releaseName = getReleaseName(name);
  const chartChanging =
    !!selectedChart &&
    !chartVersionsEqual(selectedChart.version, installedChartVersion);

  useEffect(() => {
    load();
  }, []);

  async function load() {
    try {
      const cfg = await loadDeploymentConfig(name);
      setConfig(cfg);

      const state = await loadDeploymentState(name);
      const ns = state?.application?.namespace || getNamespace(name);
      setNamespace(ns);

      const deployed = await getDeployedImageVersions(releaseName, ns);
      setDeployedVersions(deployed);
      setDeployedHpsVersion(deployed.hpsVersion || null);

      const currentAppVersion =
        deployed.appVersion || state?.application?.version || null;
      const info = await getAppVersionInfo(cfg.licenseKey, currentAppVersion);
      setVersionInfo(info);

      const installed =
        (await getInstalledChartVersion(releaseName, ns)) ||
        (state?.application?.chartVersion !== "latest"
          ? state?.application?.chartVersion
          : null) ||
        null;
      setInstalledChartVersion(installed);

      const charts = await fetchAvailableChartVersions();
      setAvailableCharts(charts);

      if (targetVersion) {
        const targetApp = info.available.find((v) => v.version === targetVersion);
        if (!targetApp) {
          setError(`Version ${targetVersion} not found`);
          setStep("error");
          return;
        }
        setSelectedApp(targetApp);
        await proceedAfterAppSelect(cfg, targetApp, charts, installed);
        return;
      }

      setStep("selectApp");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load versions");
      setStep("error");
    }
  }

  async function proceedAfterAppSelect(
    cfg: DeploymentConfig,
    app: AppVersion,
    charts: ChartVersion[],
    installed: string | null,
  ) {
    if (targetChartVersion) {
      const target =
        charts.find((v) => v.version === targetChartVersion) ?? {
          version: targetChartVersion,
          appVersion: targetChartVersion,
          created: "",
          digest: "",
        };
      setSelectedChart(target);
      await afterChartSelect(cfg, app, target, installed);
      return;
    }

    if (charts.length === 0 && !targetChartVersion) {
      setError(
        `Could not fetch available chart versions. Check ${CHART_RELEASES_URL} and retry with --chart-version <version>.`,
      );
      setStep("error");
      return;
    }

    setStep("selectChart");
  }

  async function afterChartSelect(
    _cfg: DeploymentConfig,
    app: AppVersion,
    chart: ChartVersion,
    installed: string | null,
  ) {
    const changing = !chartVersionsEqual(chart.version, installed);
    if (changing || dryRun) {
      await prepareUpgradeDryRun(app, chart, changing);
      return;
    }

    setStep("confirm");
  }

  async function runReconciledUpgrade(
    app: AppVersion,
    chart: ChartVersion,
    changingChart: boolean,
    dryRunMode: boolean,
    retryWithForceConflicts: boolean,
    onHelmStart?: () => void,
  ) {
    let images: Awaited<ReturnType<typeof resolveImageCatalog>> | undefined;

    return runUpgradeReconciliation(
      {
        targetVersion: app.version,
        dryRun: dryRunMode,
        // Every real upgrade is atomic now, including app-only releases. Keep
        // local desired files aligned with Helm's rollback when any apply
        // fails; otherwise config.yaml/values.yaml would claim the target
        // version while the cluster remained on the previous one.
        restoreOnFailure: !dryRunMode,
      },
      {
        reloadConfig: () => loadDeploymentConfig(name),
        captureSnapshot: async () => {
          let configContent: string;
          let valuesContent: string;
          try {
            [configContent, valuesContent] = await Promise.all([
              fs.readFile(
                path.join(getDeploymentDir(name), "config.yaml"),
                "utf8",
              ),
              fs.readFile(getHelmValuesPath(name), "utf8"),
            ]);
          } catch {
            throw new Error(
              `Could not snapshot config.yaml and values.yaml for ${name}. Run "rulebricks configure ${name}" first.`,
            );
          }
          return { configContent, valuesContent };
        },
        prepareArtifacts: async (targetConfig) => {
          images = await resolveImageCatalog(chart.version);

          if (changingChart && shouldMirrorToAcr(targetConfig)) {
            const registry = targetConfig.imageRegistry!;
            const mirror = await mirrorImagesToAcr(
              registry.split(".")[0],
              targetConfig.licenseKey,
              planAcrImports(images.entries()),
              targetConfig.imageRegistryResourceId,
            );
            assertAcrMirrorSucceeded(
              registry,
              mirror,
              `Mirroring chart ${chart.version} image pins`,
            );
          }

          if (dryRunMode) {
            // A full-mirror dry-run renders from the selected chart copy but
            // intentionally does not mirror the target app release.
            await ensureMirroredChart(targetConfig, chart.version);
          } else {
            await mirrorReleaseArtifactsIfNeeded(
              targetConfig,
              app,
              chart.version,
            );
          }
        },
        regenerateValues: async (targetConfig) => {
          const currentValues = await loadHelmValues(name);
          await generateHelmValuesPreservingEdits(targetConfig, {
            tlsEnabled: deriveTlsEnabled(currentValues),
            secretMode: secretModeForConfig(targetConfig),
            images:
              images ?? (await resolveImageCatalog(chart.version)),
          });
        },
        persistConfig: (targetConfig) =>
          saveDeploymentConfig(targetConfig),
        ensureNamespace: () => ensureNamespace(namespace),
        applyKubernetesSecrets: async (targetConfig) => {
          await applyDeploymentSecrets(targetConfig, namespace);
        },
        setupExternalSecrets: async (targetConfig) => {
          const { seeded } = await setupExternalSecrets(targetConfig, {
            overwriteSecrets: false,
          });
          const warnings: string[] = [];
          if (seeded.denied.length > 0) {
            warnings.push(
              `${seeded.denied.length} secret entr${seeded.denied.length === 1 ? "y was" : "ies were"} not writable from this machine; existing platform values were used: ${seeded.denied.join(", ")}`,
            );
          }
          if (seeded.retained.length > 0) {
            warnings.push(
              `Obsolete ExternalSecret consumers were detached; remote vault entries were retained: ${seeded.retained.join(", ")}`,
            );
          }
          setSecretsWarning(warnings.length > 0 ? warnings.join(" ") : null);
        },
        runHelm: async (targetConfig) => {
          if (dryRunMode) {
            return dryRunUpgrade(name, {
              releaseName,
              namespace,
              version: chart.version,
              chartRef: chartOciRef(targetConfig),
            });
          }

          onHelmStart?.();
          await upgradeChart(name, {
            releaseName,
            namespace,
            version: chart.version,
            chartRef: chartOciRef(targetConfig),
            atomic: true,
            forceConflicts: retryWithForceConflicts,
          });
          return "";
        },
        restoreSnapshot: async (snapshot) => {
          await Promise.all([
            fs.writeFile(
              path.join(getDeploymentDir(name), "config.yaml"),
              snapshot.configContent,
              "utf8",
            ),
            fs.writeFile(
              getHelmValuesPath(name),
              snapshot.valuesContent,
              "utf8",
            ),
          ]);
        },
      },
    );
  }

  async function prepareUpgradeDryRun(
    app: AppVersion,
    chart: ChartVersion,
    changingChart: boolean,
  ) {
    setStep("preparing");
    try {
      const result = await runReconciledUpgrade(
        app,
        chart,
        changingChart,
        true,
        false,
      );
      if (dryRun) {
        setDryRunOutput(result.helmResult);
        setStep("complete");
      } else {
        setStep("confirm");
      }
    } catch (err) {
      setError(
        `${err instanceof Error ? err.message : "Upgrade dry run failed"}\n\nNo changes were made to the deployment.`,
      );
      setStep("error");
    }
  }

  async function mirrorReleaseArtifactsIfNeeded(
    cfg: DeploymentConfig,
    app: AppVersion,
    chartVersion: string,
  ) {
    if (!shouldMirrorToAcr(cfg)) {
      return;
    }

    const registry = cfg.imageRegistry!;
    const mirror = await mirrorImagesToAcr(
      registry.split(".")[0],
      cfg.licenseKey,
      planAcrImports([], app.version),
      cfg.imageRegistryResourceId,
    );
    assertAcrMirrorSucceeded(
      registry,
      mirror,
      `Mirroring ${app.version} application images`,
    );
    // The upgrade below installs the chart from the registry; make sure the
    // selected chart version is present (idempotent for versions the prepare
    // step already imported).
    await ensureMirroredChart(cfg, chartVersion);
  }

  async function restartHpsWorkloads(ns: string) {
    for (const workload of [`${releaseName}-hps`, `${releaseName}-hps-worker`]) {
      const restarted = await rolloutRestart("deployment", workload, ns);
      if (!restarted) {
        await rolloutRestart("statefulset", workload, ns);
      }
    }
  }

  async function performUpgrade(retryWithForceConflicts = false) {
    if (!selectedApp || !selectedChart || !config) return;

    setStep("upgrading");
    const changingChart = !chartVersionsEqual(
      selectedChart.version,
      installedChartVersion,
    );
    let helmStarted = false;

    try {
      const result = await runReconciledUpgrade(
        selectedApp,
        selectedChart,
        changingChart,
        false,
        retryWithForceConflicts,
        () => {
          helmStarted = true;
        },
      );
      setConfig(result.config);

      if (!changingChart) {
        await restartHpsWorkloads(namespace);
      }

      // When both axes change, pods roll via the chart apply; still restart
      // HPS when the product version changed so digest-only patches land.
      if (
        changingChart &&
        versionInfo?.current?.version !== selectedApp.version
      ) {
        await restartHpsWorkloads(namespace);
      }

      await updateDeploymentStatus(name, "running", {
        application: {
          version: selectedApp.version,
          chartVersion: selectedChart.version,
          namespace,
          url: `https://${result.config.domain}`,
        },
      });

      setStep("complete");
      setTimeout(() => exit(), 5000);
    } catch (err) {
      if (!retryWithForceConflicts && isHelmSsaConflict(err)) {
        if (forceConflicts) {
          await performUpgrade(true);
          return;
        }
        if (process.stdin.isTTY === true && process.stdout.isTTY === true) {
          setSsaConflictError(
            err instanceof Error ? err.message : "Helm SSA conflict",
          );
          setStep("confirmForceConflicts");
          return;
        }
        setError(
          `${err instanceof Error ? err.message : "Helm SSA conflict"}\n\nThis is a Helm 4 server-side apply field ownership conflict. Review the conflicting manager and field, then rerun with --force-conflicts to permit one guarded retry.`,
        );
        setStep("error");
        return;
      }
      if (helmStarted) setRolledBack(true);
      setError(err instanceof Error ? err.message : "Upgrade failed");
      setStep("error");
    }
  }

  const handleAppSelect = useCallback(
    (item: { value: string }) => {
      const version = versionInfo?.available.find(
        (v) => v.version === item.value,
      );
      if (version && config) {
        setSelectedApp(version);
        proceedAfterAppSelect(
          config,
          version,
          availableCharts,
          installedChartVersion,
        );
      }
    },
    [versionInfo, dryRun, config, availableCharts, installedChartVersion],
  );

  const handleChartSelect = useCallback(
    (item: { value: string }) => {
      const chart = availableCharts.find((v) => v.version === item.value);
      if (chart && config && selectedApp) {
        setSelectedChart(chart);
        afterChartSelect(config, selectedApp, chart, installedChartVersion);
      }
    },
    [availableCharts, config, selectedApp, installedChartVersion, dryRun],
  );

  useInput((_input, key) => {
    if (step === "confirm") {
      if (key.return) {
        performUpgrade();
      } else if (key.escape) {
        if (targetChartVersion) {
          // Pinned chart: back to app select, or exit if app was also pinned.
          if (targetVersion) {
            exit();
          } else {
            setSelectedChart(null);
            setStep("selectApp");
          }
        } else {
          setSelectedChart(null);
          setStep("selectChart");
        }
      }
    } else if (step === "confirmForceConflicts") {
      if (key.return) {
        performUpgrade(true);
      } else if (key.escape) {
        setError(
          `${ssaConflictError || "Helm SSA conflict"}\n\nUpgrade stopped without taking ownership of the conflicting fields.`,
        );
        setStep("error");
      }
    } else if (step === "selectChart" && key.escape) {
      if (targetVersion) {
        exit();
      } else {
        setSelectedApp(null);
        setStep("selectApp");
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
          {rolledBack && (
            <Box marginTop={1} flexDirection="column">
              <Text color={colors.warning}>
                The release was automatically rolled back and remains on chart{" "}
                {installedChartVersion || "the previous version"}.
              </Text>
              <Text color={colors.muted}>
                Your deployment is still running the previous version.
              </Text>
            </Box>
          )}
        </Box>
      </BorderBox>
    );
  }

  if (step === "preparing") {
    return (
      <BorderBox title="Preparing Upgrade">
        <Box marginY={1}>
          <Spinner
            label={`Preparing chart ${selectedChart?.version || ""}...`}
          />
        </Box>
      </BorderBox>
    );
  }

  if (step === "confirmForceConflicts") {
    return (
      <BorderBox title="Helm Field Ownership Conflict">
        <Box flexDirection="column" marginY={1}>
          <Text color={colors.warning}>
            Helm 4 server-side apply found fields owned by another manager.
          </Text>
          <Box marginTop={1}>
            <Text color={colors.muted}>
              {ssaConflictError?.substring(0, 700)}
            </Text>
          </Box>
          <Box marginTop={1} flexDirection="column">
            <Text>
              Retrying with --force-conflicts transfers those fields to Helm
              and may override the other manager.
            </Text>
            <Text color={colors.warning}>
              Confirm only after reviewing the manager and field above.
            </Text>
          </Box>
          <Box marginTop={1}>
            <Text color={colors.success} bold>
              Press Enter for one forced retry, Esc to stop
            </Text>
          </Box>
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
            ✓ App{" "}
            {formatVersionDisplay(selectedApp?.version || "")}
            {" · Chart "}
            {selectedChart?.version}
          </Text>
          <Box marginTop={1}>
            <Text>Run `rulebricks status {name}` to verify the deployment</Text>
          </Box>
          {secretsWarning && (
            <Box marginTop={1}>
              <Text color={colors.warning}>{secretsWarning}</Text>
            </Box>
          )}
        </Box>
      </BorderBox>
    );
  }

  if (step === "upgrading") {
    return (
      <BorderBox title="Upgrading">
        <Box flexDirection="column" marginY={1}>
          <Spinner
            label={
              chartChanging
                ? `Upgrading to app ${formatVersionDisplay(selectedApp?.version || "")}, chart ${selectedChart?.version || ""}...`
                : `Installing ${formatVersionDisplay(selectedApp?.version || "")}...`
            }
          />
          <Box marginTop={1}>
            <Text color={colors.muted}>
              Watch: kubectl get pods -n {namespace} -w
            </Text>
          </Box>
        </Box>
      </BorderBox>
    );
  }

  if (step === "confirm") {
    return (
      <BorderBox title="Confirm Upgrade">
        <Box flexDirection="column" marginY={1}>
          <Text>
            App:{" "}
            <Text color={colors.accent}>
              {versionInfo?.current
                ? formatVersionDisplay(versionInfo.current.version)
                : "Not installed"}
            </Text>
            {" → "}
            <Text color={colors.success}>
              {formatVersionDisplay(selectedApp?.version || "")}
            </Text>
          </Text>
          <Text>
            Chart:{" "}
            <Text color={colors.accent}>
              {installedChartVersion || "unknown"}
            </Text>
            {" → "}
            <Text color={colors.success}>{selectedChart?.version}</Text>
          </Text>

          {chartChanging && (
            <Box marginTop={1}>
              <Text color={colors.muted}>
                Dry run passed. Infrastructure components may restart.
              </Text>
            </Box>
          )}

          <Box marginTop={1} flexDirection="column">
            <Text color={colors.warning}>
              ⚠ This will upgrade your Rulebricks deployment.
            </Text>
            <Text color={colors.muted}>
              {chartChanging
                ? "If the upgrade fails, Helm automatically rolls back to the current chart version."
                : "Pods will be restarted and there may be brief downtime."}
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

  if (step === "selectChart") {
    const items = availableCharts.map((v) => ({
      label: v.version,
      value: v.version,
      date: v.created,
      isCurrent: installedChartVersion === v.version,
      isLatest: availableCharts[0]?.version === v.version,
    }));

    const hasUpdate =
      !!installedChartVersion &&
      availableCharts.length > 0 &&
      availableCharts[0].version !== installedChartVersion;

    return (
      <BorderBox title="Select Chart Version">
        <Box flexDirection="column" marginY={1}>
          <Box flexDirection="column" marginBottom={1}>
            <Text>
              App version:{" "}
              <Text color={colors.accent}>
                {formatVersionDisplay(selectedApp?.version || "")}
              </Text>
            </Text>
            <Text>
              Current chart:{" "}
              <Text color={colors.accent}>
                {installedChartVersion || "unknown"}
              </Text>
            </Text>
            <Text>
              Latest chart:{" "}
              <Text color={hasUpdate ? colors.success : colors.accent}>
                {availableCharts[0]?.version || "unknown"}
              </Text>
            </Text>
            {hasUpdate && (
              <Text color={colors.muted} dimColor>
                Chart update available
              </Text>
            )}
          </Box>

          <Box
            marginBottom={1}
            paddingX={1}
            borderStyle="single"
            borderColor={colors.accent}
            alignSelf="flex-start"
          >
            <Text>📚 Release notes: </Text>
            <Text color={colors.accent} underline>
              {CHART_RELEASES_URL}
            </Text>
          </Box>

          <Text bold>Select chart version:</Text>
          <Text color={colors.muted}>
            Selecting the current version is fine. Esc to go back.
          </Text>
          <Box marginTop={1}>
            <SelectInput
              items={items}
              onSelect={handleChartSelect}
              limit={8}
              itemComponent={({ isSelected, label }) => {
                const item = items.find((i) => i.label === label) || items[0];
                const isLatestWithUpdate = item.isLatest && !item.isCurrent;
                const labelColor = isSelected
                  ? colors.accent
                  : isLatestWithUpdate
                    ? colors.success
                    : undefined;

                return (
                  <Box>
                    <Text color={labelColor}>{label}</Text>
                    {item.isCurrent && (
                      <Text color={colors.warning}> current</Text>
                    )}
                    {item.date && (
                      <Text color={colors.muted}> {formatDate(item.date)}</Text>
                    )}
                  </Box>
                );
              }}
            />
          </Box>
        </Box>
      </BorderBox>
    );
  }

  // App version selection screen
  const versionItems =
    versionInfo?.available.map((v) => ({
      label: formatVersionDisplay(v.version),
      value: v.version,
      date: v.releaseDate,
      hasSameVersionPatch: hasSameVersionHpsPatch(v, deployedVersions),
      isCurrent:
        versionInfo.current?.version === v.version &&
        (!deployedHpsVersion ||
          normalizeVersion(deployedHpsVersion) ===
            normalizeVersion(v.version)) &&
        !hasSameVersionHpsPatch(v, deployedVersions),
      isLatest: versionInfo.latest?.version === v.version,
    })) || [];

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
    <BorderBox title="Select App Version">
      <Box flexDirection="column" marginY={1}>
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

        <Text bold>Select Rulebricks version:</Text>
        <Text color={colors.muted}>
          Selecting the current version is fine. Next you will pick a chart
          version.
        </Text>
        <Box marginTop={1}>
          <SelectInput
            items={versionItems}
            onSelect={handleAppSelect}
            limit={8}
            itemComponent={({ isSelected, label }) => {
              const vItem =
                versionItems.find((v) => v.label === label) || versionItems[0];

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
