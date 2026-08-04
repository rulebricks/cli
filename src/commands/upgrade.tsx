import React, { useState, useEffect, useCallback } from "react";
import { Box, Text, useApp, useInput } from "ink";
import SelectInput from "ink-select-input";
import fs from "fs/promises";
import YAML from "yaml";
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
  getHelmValuesPath,
  loadHelmValues,
} from "../lib/config.js";
import {
  fetchAvailableChartVersions,
  upgradeChart,
  dryRunUpgrade,
  getInstalledChartVersion,
} from "../lib/helm.js";
import {
  deriveTlsEnabled,
  generateHelmValuesPreservingEdits,
  resolveProductVersion,
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

const CHART_RELEASES_URL = "https://github.com/rulebricks/helm/releases";

interface UpgradeCommandProps {
  name: string;
  /** Skip the app picker and target this product version. */
  targetVersion?: string;
  /** Skip the chart picker and target this chart version. */
  targetChartVersion?: string;
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
  | "upgrading"
  | "complete"
  | "error";

function UpgradeCommandInner({
  name,
  targetVersion,
  targetChartVersion,
  dryRun,
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
  const [valuesSnapshot, setValuesSnapshot] = useState<string | null>(null);
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
    cfg: DeploymentConfig,
    app: AppVersion,
    chart: ChartVersion,
    installed: string | null,
  ) {
    const changing = !chartVersionsEqual(chart.version, installed);
    if (changing) {
      await prepareChartUpgrade(cfg, app, chart);
      return;
    }

    if (dryRun) {
      await performAppDryRun(app, chart.version);
      return;
    }

    setStep("confirm");
  }

  async function restoreValuesSnapshot(snapshot: string | null) {
    if (snapshot === null) return;
    await fs
      .writeFile(getHelmValuesPath(name), snapshot, "utf8")
      .catch(() => {});
  }

  async function readValuesProductVersion(): Promise<string | undefined> {
    try {
      const values = await loadHelmValues(name);
      const global = values?.global as { version?: unknown } | undefined;
      return typeof global?.version === "string" ? global.version : undefined;
    } catch {
      return undefined;
    }
  }

  async function syncProductVersion(
    cfg: DeploymentConfig,
    version: string,
  ): Promise<DeploymentConfig> {
    const valuesPath = getHelmValuesPath(name);
    try {
      const content = await fs.readFile(valuesPath, "utf8");
      const values = YAML.parse(content) as Record<string, unknown>;
      if (!values.global) {
        values.global = {};
      }
      (values.global as Record<string, unknown>).version = version;
      await fs.writeFile(valuesPath, YAML.stringify(values), "utf8");
    } catch (err) {
      throw new Error(`Failed to update Helm values: ${err}`);
    }

    const updated = { ...cfg, version };
    await saveDeploymentConfig(updated);
    setConfig(updated);
    return updated;
  }

  /**
   * Regenerates values against the target chart's image manifest and gates on
   * a helm dry run. Any failure restores the values snapshot; nothing has
   * touched the cluster yet.
   */
  async function prepareChartUpgrade(
    cfg: DeploymentConfig,
    app: AppVersion,
    chart: ChartVersion,
  ) {
    setStep("preparing");

    let snapshot: string | null = null;
    try {
      snapshot = await fs.readFile(getHelmValuesPath(name), "utf8");
    } catch {
      setError(
        `No values.yaml found for ${name}. Run "rulebricks configure ${name}" first.`,
      );
      setStep("error");
      return;
    }
    setValuesSnapshot(snapshot);

    try {
      const state = await loadDeploymentState(name);
      const valuesVersion = await readValuesProductVersion();
      const productVersion = resolveProductVersion({
        selected: app.version,
        valuesVersion,
        stateVersion: state?.application?.version,
        configVersion: cfg.version,
      });
      const cfgWithVersion = {
        ...cfg,
        version: productVersion || app.version,
      };

      const currentValues = await loadHelmValues(name);
      const tlsEnabled = deriveTlsEnabled(currentValues);
      const images = await resolveImageCatalog(chart.version);

      if (shouldMirrorToAcr(cfgWithVersion)) {
        const registry = cfgWithVersion.imageRegistry!;
        const mirror = await mirrorImagesToAcr(
          registry.split(".")[0],
          cfgWithVersion.licenseKey,
          planAcrImports(images.entries()),
          cfgWithVersion.imageRegistryResourceId,
        );
        assertAcrMirrorSucceeded(
          registry,
          mirror,
          `Mirroring chart ${chart.version} image pins`,
        );
      }
      // The dry run below pulls the chart from the registry in full-mirror
      // mode, so the target chart version must be imported first.
      await ensureMirroredChart(cfgWithVersion, chart.version);

      await generateHelmValuesPreservingEdits(cfgWithVersion, {
        tlsEnabled,
        secretMode: secretModeForConfig(cfgWithVersion),
        images,
      });

      const output = await dryRunUpgrade(name, {
        releaseName,
        namespace,
        version: chart.version,
        chartRef: chartOciRef(cfgWithVersion),
      });

      if (dryRun) {
        setDryRunOutput(output);
        // Dry-run must not leave regenerated values on disk.
        await restoreValuesSnapshot(snapshot);
        setStep("complete");
        return;
      }

      setStep("confirm");
    } catch (err) {
      await restoreValuesSnapshot(snapshot);
      setError(
        `${err instanceof Error ? err.message : "Upgrade dry run failed"}\n\nNo changes were made to the deployment.`,
      );
      setStep("error");
    }
  }

  async function performAppDryRun(app: AppVersion, chartVersion: string) {
    let snapshot: string | null = null;
    try {
      snapshot = await fs.readFile(getHelmValuesPath(name), "utf8");
      await syncProductVersion(config!, app.version);

      // Full-mirror mode renders from the registry's chart copy; make sure
      // the (unchanged) chart version is actually there.
      await ensureMirroredChart(config!, chartVersion);

      const output = await dryRunUpgrade(name, {
        releaseName,
        namespace,
        version: chartVersion,
        chartRef: chartOciRef(config!),
      });
      setDryRunOutput(output);
      await restoreValuesSnapshot(snapshot);
      // Restore config version too — syncProductVersion may have rewritten it.
      if (config) {
        await saveDeploymentConfig(config);
      }
      setStep("complete");
    } catch (err) {
      await restoreValuesSnapshot(snapshot);
      if (config) {
        await saveDeploymentConfig(config).catch(() => {});
      }
      setError(err instanceof Error ? err.message : "Dry run failed");
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

  async function performUpgrade() {
    if (!selectedApp || !selectedChart || !config) return;

    setStep("upgrading");
    const changingChart = !chartVersionsEqual(
      selectedChart.version,
      installedChartVersion,
    );

    try {
      await mirrorReleaseArtifactsIfNeeded(
        config,
        selectedApp,
        selectedChart.version,
      );

      if (changingChart) {
        // Values were regenerated in prepare with the selected app version.
        // Ensure config.yaml stays aligned, then apply with --atomic.
        const updated = { ...config, version: selectedApp.version };
        await saveDeploymentConfig(updated);
        setConfig(updated);

        await ensureNamespace(namespace);
        if (secretModeForConfig(updated) === "eso") {
          await setupExternalSecrets(updated, { overwriteSecrets: false });
        } else {
          await applyDeploymentSecrets(updated, namespace);
        }

        await upgradeChart(name, {
          releaseName,
          namespace,
          version: selectedChart.version,
          chartRef: chartOciRef(config),
          wait: true,
          atomic: true,
        });
      } else {
        await syncProductVersion(config, selectedApp.version);

        await upgradeChart(name, {
          releaseName,
          namespace,
          version: selectedChart.version,
          chartRef: chartOciRef(config),
          wait: true,
        });

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
          url: `https://${config.domain}`,
        },
      });

      setStep("complete");
      setTimeout(() => exit(), 5000);
    } catch (err) {
      if (changingChart) {
        await restoreValuesSnapshot(valuesSnapshot);
        setRolledBack(true);
      }
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
        const restore = chartChanging
          ? restoreValuesSnapshot(valuesSnapshot)
          : Promise.resolve();
        restore.then(() => {
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
        });
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
