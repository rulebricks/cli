import React, { useState, useEffect, useCallback } from "react";
import { Box, Text, useApp, useInput } from "ink";
import SelectInput from "ink-select-input";
import fs from "fs/promises";
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
  loadHelmValues,
} from "../lib/config.js";
import {
  fetchAvailableChartVersions,
  getInstalledChartVersion,
  upgradeChart,
  dryRunUpgrade,
} from "../lib/helm.js";
import {
  deriveTlsEnabled,
  generateHelmValuesPreservingEdits,
} from "../lib/helmValues.js";
import { resolveImageCatalog } from "../lib/imageCatalog.js";
import { ensureNamespace, applyDeploymentSecrets } from "../lib/secrets.js";
import { setupExternalSecrets } from "../lib/eso.js";
import { secretModeForConfig } from "../lib/deploySequence.js";
import { formatDate } from "../lib/versions.js";
import {
  ChartVersion,
  DeploymentConfig,
  getNamespace,
  getReleaseName,
} from "../types/index.js";

const CHART_RELEASES_URL = "https://github.com/rulebricks/helm/releases";

interface ChartUpgradeCommandProps {
  name: string;
  /** Skip the selector and target this chart version directly. */
  targetVersion?: string;
}

type ChartUpgradeStep =
  | "loading"
  | "select"
  | "preparing"
  | "confirm"
  | "upgrading"
  | "complete"
  | "error";

function ChartUpgradeCommandInner({
  name,
  targetVersion,
}: ChartUpgradeCommandProps) {
  const { exit } = useApp();
  const { colors } = useTheme();
  const [step, setStep] = useState<ChartUpgradeStep>("loading");
  const [config, setConfig] = useState<DeploymentConfig | null>(null);
  const [available, setAvailable] = useState<ChartVersion[]>([]);
  const [installedVersion, setInstalledVersion] = useState<string | null>(null);
  const [selected, setSelected] = useState<ChartVersion | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [rolledBack, setRolledBack] = useState(false);
  // Raw values.yaml content captured before regeneration; written back on any
  // non-success path so the local file always describes the deployed chart.
  const [valuesSnapshot, setValuesSnapshot] = useState<string | null>(null);

  const namespace = getNamespace(name);
  const releaseName = getReleaseName(name);

  useEffect(() => {
    load();
  }, []);

  async function load() {
    try {
      const cfg = await loadDeploymentConfig(name);
      setConfig(cfg);

      const state = await loadDeploymentState(name);
      const installed =
        (await getInstalledChartVersion(releaseName, namespace)) ||
        (state?.application?.chartVersion !== "latest"
          ? state?.application?.chartVersion
          : null) ||
        null;
      setInstalledVersion(installed);

      const versions = await fetchAvailableChartVersions();
      setAvailable(versions);

      if (targetVersion) {
        // A pinned target proceeds even when the list is unavailable or
        // incomplete; the dry run gates whether the version actually exists.
        const target = versions.find((v) => v.version === targetVersion) ?? {
          version: targetVersion,
          appVersion: targetVersion,
          created: "",
          digest: "",
        };
        setSelected(target);
        await prepare(cfg, target);
        return;
      }

      if (versions.length === 0) {
        setError(
          `Could not fetch available chart versions. Check ${CHART_RELEASES_URL} and retry with --chart --version <version>.`,
        );
        setStep("error");
        return;
      }

      setStep("select");
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Failed to load chart versions",
      );
      setStep("error");
    }
  }

  async function restoreValuesSnapshot(snapshot: string | null) {
    if (snapshot === null) return;
    await fs
      .writeFile(getHelmValuesPath(name), snapshot, "utf8")
      .catch(() => {});
  }

  /**
   * Regenerates values against the target chart's image manifest and gates on
   * a helm dry run. Any failure restores the values snapshot; nothing has
   * touched the cluster yet.
   */
  async function prepare(cfg: DeploymentConfig, target: ChartVersion) {
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
      const currentValues = await loadHelmValues(name);
      const tlsEnabled = deriveTlsEnabled(currentValues);

      // Resolve the target chart's own images/manifest.yaml. Fails loudly if
      // that chart is incompatible with this CLI; generation then validates
      // the merged values against the chart schema before helm ever runs.
      const images = await resolveImageCatalog(target.version);
      await generateHelmValuesPreservingEdits(cfg, {
        tlsEnabled,
        secretMode: secretModeForConfig(cfg),
        images,
      });

      await dryRunUpgrade(name, {
        releaseName,
        namespace,
        version: target.version,
      });

      setStep("confirm");
    } catch (err) {
      await restoreValuesSnapshot(snapshot);
      setError(
        `${err instanceof Error ? err.message : "Chart upgrade dry run failed"}\n\nNo changes were made to the deployment.`,
      );
      setStep("error");
    }
  }

  async function performUpgrade() {
    if (!selected || !config) return;
    setStep("upgrading");

    try {
      // Values were regenerated in ref-based secret mode, so the referenced
      // Kubernetes Secrets must exist before helm renders against them:
      // ESO-synced from the configured backend, or CLI-applied for the
      // "cluster" backend.
      await ensureNamespace(namespace);
      if (secretModeForConfig(config) === "eso") {
        await setupExternalSecrets(config, { overwriteSecrets: false });
      } else {
        await applyDeploymentSecrets(config, namespace);
      }

      await upgradeChart(name, {
        releaseName,
        namespace,
        version: selected.version,
        wait: true,
        atomic: true,
      });

      const state = await loadDeploymentState(name);
      await updateDeploymentStatus(name, "running", {
        application: {
          version: state?.application?.version || "unknown",
          chartVersion: selected.version,
          namespace,
          url: state?.application?.url || `https://${config.domain}`,
        },
      });

      setStep("complete");
      setTimeout(() => exit(), 5000);
    } catch (err) {
      // --atomic already rolled the release back; restore values.yaml so the
      // local files match the still-running previous chart.
      await restoreValuesSnapshot(valuesSnapshot);
      setRolledBack(true);
      setError(err instanceof Error ? err.message : "Chart upgrade failed");
      setStep("error");
    }
  }

  const handleSelect = useCallback(
    (item: { value: string }) => {
      const version = available.find((v) => v.version === item.value);
      if (version && config) {
        setSelected(version);
        prepare(config, version);
      }
    },
    [available, config],
  );

  useInput((_input, key) => {
    if (step === "confirm") {
      if (key.return) {
        performUpgrade();
      } else if (key.escape) {
        // Nothing has touched the cluster; put values.yaml back and return
        // to the selector.
        restoreValuesSnapshot(valuesSnapshot).then(() => {
          if (targetVersion) {
            exit();
          } else {
            setStep("select");
          }
        });
      }
    }
  });

  if (step === "loading") {
    return (
      <BorderBox title="Chart Version Manager">
        <Box marginY={1}>
          <Spinner label="Loading chart version information..." />
        </Box>
      </BorderBox>
    );
  }

  if (step === "error") {
    return (
      <BorderBox title="Chart Upgrade Failed">
        <Box flexDirection="column" marginY={1}>
          <Text color={colors.error}>✗ {error}</Text>
          {rolledBack && (
            <Box marginTop={1} flexDirection="column">
              <Text color={colors.warning}>
                The release was automatically rolled back and remains on chart{" "}
                {installedVersion || "the previous version"}.
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
      <BorderBox title="Chart Upgrade">
        <Box marginY={1}>
          <Spinner
            label={`Preparing chart ${selected?.version || ""}...`}
          />
        </Box>
      </BorderBox>
    );
  }

  if (step === "upgrading") {
    return (
      <BorderBox title="Upgrading Chart">
        <Box marginY={1}>
          <Spinner
            label={`Upgrading infrastructure chart to ${selected?.version || ""}...`}
          />
        </Box>
      </BorderBox>
    );
  }

  if (step === "complete") {
    return (
      <BorderBox title="Chart Upgrade Complete">
        <Box flexDirection="column" marginY={1}>
          <Text color={colors.success} bold>
            ✓ Chart upgraded to {selected?.version}
          </Text>
          <Box marginTop={1}>
            <Text>Run `rulebricks status {name}` to verify the deployment</Text>
          </Box>
        </Box>
      </BorderBox>
    );
  }

  if (step === "confirm") {
    return (
      <BorderBox title="Confirm Chart Upgrade">
        <Box flexDirection="column" marginY={1}>
          <Text>
            Current chart:{" "}
            <Text color={colors.accent}>{installedVersion || "unknown"}</Text>
          </Text>
          <Text>
            Target chart:{" "}
            <Text color={colors.success}>{selected?.version}</Text>
          </Text>
          <Box marginTop={1}>
            <Text color={colors.muted}>
              Dry run passed. The app version stays unchanged.
            </Text>
          </Box>

          <Box marginTop={1} flexDirection="column">
            <Text color={colors.warning}>
              ⚠ Infrastructure components (ingress, certificates, monitoring)
              may restart during the upgrade.
            </Text>
            <Text color={colors.muted}>
              This can cause a brief period of downtime. If the upgrade fails,
              Helm automatically rolls back to the current version.
            </Text>
          </Box>

          <Box marginTop={1}>
            <Text color={colors.success} bold>
              Press Enter to continue, Esc to cancel
            </Text>
          </Box>
        </Box>
      </BorderBox>
    );
  }

  // Version selection screen
  const items = available.map((v) => ({
    label: v.version,
    value: v.version,
    date: v.created,
    isCurrent: installedVersion === v.version,
    isLatest: available[0]?.version === v.version,
  }));

  const hasUpdate =
    !!installedVersion &&
    available.length > 0 &&
    available[0].version !== installedVersion;

  return (
    <BorderBox title="Rulebricks Chart Version Manager">
      <Box flexDirection="column" marginY={1}>
        <Box flexDirection="column" marginBottom={1}>
          <Text>
            Current chart:{" "}
            <Text color={colors.accent}>{installedVersion || "unknown"}</Text>
          </Text>
          <Text>
            Latest chart:{" "}
            <Text color={hasUpdate ? colors.success : colors.accent}>
              {available[0]?.version || "unknown"}
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

        <Text bold>Select chart version to install:</Text>
        <Box marginTop={1}>
          <SelectInput
            items={items}
            onSelect={handleSelect}
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

export function ChartUpgradeCommand(props: ChartUpgradeCommandProps) {
  return (
    <ThemeProvider theme="upgrade">
      <Logo />
      <ChartUpgradeCommandInner {...props} />
    </ThemeProvider>
  );
}
