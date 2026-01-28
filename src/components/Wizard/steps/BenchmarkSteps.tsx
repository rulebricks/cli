/**
 * Benchmark Wizard Steps
 *
 * These components provide the interactive wizard flow for configuring
 * and running benchmark tests against Rulebricks deployments.
 */

import React, { useState, useEffect } from "react";
import { Box, Text, useInput } from "ink";
import SelectInput from "ink-select-input";
import TextInput from "ink-text-input";
import { BorderBox, useTheme, Spinner } from "../../common/index.js";
import {
  BenchmarkTestMode,
  BenchmarkPreset,
  QPS_PRESETS,
  THROUGHPUT_PRESETS,
} from "../../../types/index.js";
import { listDeployments, loadDeploymentState } from "../../../lib/config.js";
import { buildApiUrl, checkDeploymentHealth } from "../../../lib/benchmark.js";

// ============================================================================
// Types
// ============================================================================

export interface BenchmarkWizardState {
  deploymentName: string;
  deploymentUrl: string;
  apiKey: string;
  flowSlug: string;
  testMode: BenchmarkTestMode;
  preset: BenchmarkPreset;
  targetRps: number;
  testDuration: string;
  bulkSize: number;
}

interface StepProps {
  onComplete: (data: Partial<BenchmarkWizardState>) => void;
  onBack: () => void;
  state: BenchmarkWizardState;
}

// ============================================================================
// Step 1: Deployment Selection
// ============================================================================

interface DeploymentInfo {
  name: string;
  url: string;
  healthy: boolean;
}

export function DeploymentSelectStep({ onComplete, onBack, state }: StepProps) {
  const { colors } = useTheme();
  const [deployments, setDeployments] = useState<DeploymentInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadingStatus, setLoadingStatus] = useState("Loading deployments...");
  const [error, setError] = useState<string | null>(null);

  useInput((input, key) => {
    if (key.escape) {
      onBack();
    }
  });

  useEffect(() => {
    (async () => {
      try {
        const names = await listDeployments();
        const candidates: { name: string; url: string }[] = [];

        // First, collect all deployments that have a URL
        for (const name of names) {
          try {
            const deploymentState = await loadDeploymentState(name);
            if (deploymentState?.application?.url) {
              candidates.push({
                name,
                url: deploymentState.application.url,
              });
            }
          } catch {
            // Skip deployments without state
          }
        }

        if (candidates.length === 0) {
          setError(
            "No deployments found. Deploy a Rulebricks instance first with 'rulebricks deploy'.",
          );
          setLoading(false);
          return;
        }

        // Now check health of each candidate
        setLoadingStatus(
          `Checking health of ${candidates.length} deployment(s)...`,
        );
        const healthyDeployments: DeploymentInfo[] = [];

        for (const candidate of candidates) {
          setLoadingStatus(`Checking ${candidate.name}...`);
          const isHealthy = await checkDeploymentHealth(candidate.url);
          if (isHealthy) {
            healthyDeployments.push({
              name: candidate.name,
              url: candidate.url,
              healthy: true,
            });
          }
        }

        setDeployments(healthyDeployments);
        if (healthyDeployments.length === 0) {
          setError(
            "No healthy deployments found.\n\nAll configured deployments failed the health check (/api/health).\nMake sure your deployment is running and accessible.",
          );
        }
      } catch (err) {
        setError("Failed to load deployments");
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  if (loading) {
    return (
      <BorderBox title="Select Deployment">
        <Box marginY={1}>
          <Spinner label={loadingStatus} />
        </Box>
      </BorderBox>
    );
  }

  if (error) {
    return (
      <BorderBox title="Select Deployment">
        <Box flexDirection="column" marginY={1}>
          <Text color={colors.error}>{error}</Text>
          <Box marginTop={1}>
            <Text color={colors.muted} dimColor>
              Esc to go back
            </Text>
          </Box>
        </Box>
      </BorderBox>
    );
  }

  const items = deployments.map((d) => ({
    label: d.name,
    value: d.name,
    url: d.url,
  }));

  const handleSelect = (item: { value: string; url?: string }) => {
    const deployment = deployments.find((d) => d.name === item.value);
    onComplete({
      deploymentName: item.value,
      deploymentUrl: deployment?.url || "",
    });
  };

  return (
    <BorderBox title="Select Deployment">
      <Box flexDirection="column" marginY={1}>
        <Text>Choose a deployment to benchmark:</Text>
        <Text color={colors.muted} dimColor>
          Only healthy, accessible deployments are shown
        </Text>
      </Box>

      <SelectInput
        items={items}
        onSelect={handleSelect}
        indicatorComponent={() => null}
        itemComponent={({ isSelected, label }) => {
          const deployment = deployments.find((d) => d.name === label);
          return (
            <Box flexDirection="column" marginY={isSelected ? 1 : 0}>
              <Text
                color={isSelected ? colors.accent : undefined}
                bold={isSelected}
              >
                {isSelected ? "❯ " : "  "}
                {label}
              </Text>
              {isSelected && deployment?.url && (
                <Text color={colors.muted} dimColor>
                  {"    "}
                  {deployment.url}
                </Text>
              )}
            </Box>
          );
        }}
      />

      <Box marginTop={1}>
        <Text color={colors.muted} dimColor>
          Esc to go back • Enter to select
        </Text>
      </Box>
    </BorderBox>
  );
}

// ============================================================================
// Step 2: API Key Input
// ============================================================================

export function ApiKeyStep({ onComplete, onBack, state }: StepProps) {
  const { colors } = useTheme();
  const [apiKey, setApiKey] = useState(state.apiKey || "");

  useInput((input, key) => {
    if (key.escape) {
      onBack();
    }
  });

  const handleSubmit = () => {
    if (!apiKey.trim()) return;
    onComplete({ apiKey: apiKey.trim() });
  };

  return (
    <BorderBox title="API Key">
      <Box flexDirection="column" marginY={1}>
        <Text>Enter your Rulebricks API key:</Text>
        <Text color={colors.muted} dimColor>
          This key is used to authenticate benchmark requests
        </Text>
        <Box marginTop={1}>
          <Text color={colors.accent}>❯ </Text>
          <TextInput
            value={apiKey}
            onChange={setApiKey}
            onSubmit={handleSubmit}
            placeholder="Enter your API key"
            mask="*"
          />
        </Box>
      </Box>

      <Box marginTop={1}>
        <Text color={colors.muted} dimColor>
          Esc to go back • Enter to continue
        </Text>
      </Box>
    </BorderBox>
  );
}

// ============================================================================
// Step 3: Flow Slug Input
// ============================================================================

export function FlowSlugStep({ onComplete, onBack, state }: StepProps) {
  const { colors } = useTheme();
  const [flowSlug, setFlowSlug] = useState(state.flowSlug || "");

  useInput((input, key) => {
    if (key.escape) {
      onBack();
    }
  });

  const handleSubmit = () => {
    if (!flowSlug.trim()) return;
    onComplete({ flowSlug: flowSlug.trim() });
  };

  return (
    <BorderBox title="Benchmarking Flow">
      <Box flexDirection="column" marginY={1}>
        <Text>Enter the slug of your benchmarking flow:</Text>
        <Text color={colors.muted} dimColor>
          Create a flow in Rulebricks using the "Benchmarking Flow" template,
          then find its slug (ex: "oryoRqvOV1")
        </Text>

        <Box marginTop={1} flexDirection="column">
          <Text color={colors.muted}>Expected payload schema:</Text>
          <Text color={colors.muted}>
            {"  "}• req_id: string (auto-generated)
          </Text>
          <Text color={colors.muted}>{"  "}• alpha: number (0-100)</Text>
          <Text color={colors.muted}>{"  "}• beta: string</Text>
          <Text color={colors.muted}>{"  "}• charlie: boolean</Text>
        </Box>

        <Box marginTop={1}>
          <Text color={colors.accent}>❯ </Text>
          <TextInput
            value={flowSlug}
            onChange={setFlowSlug}
            onSubmit={handleSubmit}
            placeholder="e.g., benchmark-flow"
          />
        </Box>

        {state.deploymentUrl && flowSlug && (
          <Box marginTop={1}>
            <Text color={colors.muted} dimColor>
              Will test: {buildApiUrl(state.deploymentUrl, flowSlug)}
            </Text>
          </Box>
        )}
      </Box>

      <Box marginTop={1}>
        <Text color={colors.muted} dimColor>
          Esc to go back • Enter to continue
        </Text>
      </Box>
    </BorderBox>
  );
}

// ============================================================================
// Step 4: Test Mode Selection
// ============================================================================

export function TestModeStep({ onComplete, onBack, state }: StepProps) {
  const { colors } = useTheme();

  useInput((input, key) => {
    if (key.escape) {
      onBack();
    }
  });

  const items = [
    {
      label: "QPS Test",
      value: "qps" as BenchmarkTestMode,
      description: "Measures requests per second - tests API responsiveness",
    },
    {
      label: "Throughput Test",
      value: "throughput" as BenchmarkTestMode,
      description:
        "Measures solutions per second with bulk requests - tests engine capacity",
    },
  ];

  const handleSelect = (item: { value: BenchmarkTestMode }) => {
    // Set default presets based on mode
    const defaults =
      item.value === "qps"
        ? {
            targetRps: QPS_PRESETS.medium.targetRps,
            testDuration: QPS_PRESETS.medium.testDuration,
          }
        : {
            targetRps: THROUGHPUT_PRESETS.medium.targetRps,
            testDuration: THROUGHPUT_PRESETS.medium.testDuration,
            bulkSize: THROUGHPUT_PRESETS.medium.bulkSize,
          };

    onComplete({
      testMode: item.value,
      preset: "medium",
      ...defaults,
    });
  };

  return (
    <BorderBox title="Test Mode">
      <Box flexDirection="column" marginY={1}>
        <Text>Select the type of benchmark to run:</Text>
      </Box>

      <SelectInput
        items={items}
        onSelect={handleSelect}
        itemComponent={({ isSelected, label }) => {
          const item = items.find((i) => i.label === label);
          return (
            <Box flexDirection="column" marginY={isSelected ? 1 : 0}>
              <Text
                color={isSelected ? colors.accent : undefined}
                bold={isSelected}
              >
                {isSelected ? "❯ " : "  "}
                {label}
              </Text>
              {isSelected && item && (
                <Text color={colors.muted} dimColor>
                  {"    "}
                  {item.description}
                </Text>
              )}
            </Box>
          );
        }}
      />

      <Box marginTop={1}>
        <Text color={colors.muted} dimColor>
          Esc to go back • Enter to select
        </Text>
      </Box>
    </BorderBox>
  );
}

// ============================================================================
// Step 5: Presets Selection
// ============================================================================

export function PresetsStep({ onComplete, onBack, state }: StepProps) {
  const { colors } = useTheme();
  const [customMode, setCustomMode] = useState(false);
  const [customRps, setCustomRps] = useState(state.targetRps.toString());
  const [customDuration, setCustomDuration] = useState(state.testDuration);
  const [customBulkSize, setCustomBulkSize] = useState(
    state.bulkSize?.toString() || "50",
  );
  const [activeField, setActiveField] = useState<
    "rps" | "duration" | "bulkSize"
  >("rps");

  const presets = state.testMode === "qps" ? QPS_PRESETS : THROUGHPUT_PRESETS;

  useInput((input, key) => {
    if (key.escape) {
      if (customMode) {
        setCustomMode(false);
      } else {
        onBack();
      }
    }
    if (customMode && key.tab) {
      // Cycle through fields
      if (state.testMode === "throughput") {
        setActiveField((prev) =>
          prev === "rps"
            ? "duration"
            : prev === "duration"
              ? "bulkSize"
              : "rps",
        );
      } else {
        setActiveField((prev) => (prev === "rps" ? "duration" : "rps"));
      }
    }
  });

  const items = [
    ...Object.entries(presets).map(([key, value]) => ({
      label: value.label,
      value: key as BenchmarkPreset,
      description: value.description,
    })),
    {
      label: "Custom",
      value: "custom" as BenchmarkPreset,
      description: "Define your own test parameters",
    },
  ];

  const handleSelect = (item: { value: BenchmarkPreset }) => {
    if (item.value === "custom") {
      setCustomMode(true);
      return;
    }

    const preset = presets[item.value as keyof typeof presets];
    const data: Partial<BenchmarkWizardState> = {
      preset: item.value,
      targetRps: preset.targetRps,
      testDuration: preset.testDuration,
    };

    if (state.testMode === "throughput" && "bulkSize" in preset) {
      data.bulkSize = (preset as { bulkSize: number }).bulkSize;
    }

    onComplete(data);
  };

  const handleCustomSubmit = () => {
    const rps = parseInt(customRps, 10);
    const bulkSize = parseInt(customBulkSize, 10);

    if (isNaN(rps) || rps < 1) return;
    if (state.testMode === "throughput" && (isNaN(bulkSize) || bulkSize < 1))
      return;

    const data: Partial<BenchmarkWizardState> = {
      preset: "custom",
      targetRps: rps,
      testDuration: customDuration,
    };

    if (state.testMode === "throughput") {
      data.bulkSize = bulkSize;
    }

    onComplete(data);
  };

  if (customMode) {
    return (
      <BorderBox title="Custom Configuration">
        <Box flexDirection="column" marginY={1}>
          <Text>Configure your custom benchmark parameters:</Text>

          <Box marginTop={1} flexDirection="column">
            <Box>
              <Text color={activeField === "rps" ? colors.accent : undefined}>
                {activeField === "rps" ? "❯ " : "  "}Target RPS:{" "}
              </Text>
              {activeField === "rps" ? (
                <TextInput
                  value={customRps}
                  onChange={setCustomRps}
                  onSubmit={handleCustomSubmit}
                  placeholder="e.g., 500"
                />
              ) : (
                <Text>{customRps}</Text>
              )}
            </Box>

            <Box>
              <Text
                color={activeField === "duration" ? colors.accent : undefined}
              >
                {activeField === "duration" ? "❯ " : "  "}Duration:{" "}
              </Text>
              {activeField === "duration" ? (
                <TextInput
                  value={customDuration}
                  onChange={setCustomDuration}
                  onSubmit={handleCustomSubmit}
                  placeholder="e.g., 4m"
                />
              ) : (
                <Text>{customDuration}</Text>
              )}
            </Box>

            {state.testMode === "throughput" && (
              <Box>
                <Text
                  color={activeField === "bulkSize" ? colors.accent : undefined}
                >
                  {activeField === "bulkSize" ? "❯ " : "  "}Bulk Size:{" "}
                </Text>
                {activeField === "bulkSize" ? (
                  <TextInput
                    value={customBulkSize}
                    onChange={setCustomBulkSize}
                    onSubmit={handleCustomSubmit}
                    placeholder="e.g., 50"
                  />
                ) : (
                  <Text>{customBulkSize}</Text>
                )}
              </Box>
            )}
          </Box>
        </Box>

        <Box marginTop={1}>
          <Text color={colors.muted} dimColor>
            Tab to switch fields • Esc to go back • Enter to continue
          </Text>
        </Box>
      </BorderBox>
    );
  }

  return (
    <BorderBox title="Test Presets">
      <Box flexDirection="column" marginY={1}>
        <Text>
          Select a preset for your {state.testMode.toUpperCase()} test:
        </Text>
      </Box>

      <SelectInput
        items={items}
        onSelect={handleSelect}
        itemComponent={({ isSelected, label }) => {
          const item = items.find((i) => i.label === label);
          return (
            <Box flexDirection="column" marginY={isSelected ? 1 : 0}>
              <Text
                color={isSelected ? colors.accent : undefined}
                bold={isSelected}
              >
                {isSelected ? "❯ " : "  "}
                {label}
              </Text>
              {isSelected && item && (
                <Text color={colors.muted} dimColor>
                  {"    "}
                  {item.description}
                </Text>
              )}
            </Box>
          );
        }}
      />

      <Box marginTop={1}>
        <Text color={colors.muted} dimColor>
          Esc to go back • Enter to select
        </Text>
      </Box>
    </BorderBox>
  );
}

// ============================================================================
// Step 6: Review and Confirm
// ============================================================================

export function ReviewStep({ onComplete, onBack, state }: StepProps) {
  const { colors } = useTheme();

  useInput((input, key) => {
    if (key.escape) {
      onBack();
    }
    if (key.return) {
      onComplete({});
    }
  });

  const apiUrl = buildApiUrl(state.deploymentUrl, state.flowSlug);
  const expectedThroughput =
    state.testMode === "throughput"
      ? state.targetRps * state.bulkSize
      : state.targetRps;

  return (
    <BorderBox title="Review Configuration">
      <Box flexDirection="column" marginY={1}>
        <Text bold>Ready to run benchmark</Text>
        <Text color={colors.muted} dimColor>
          Review your configuration before starting the test
        </Text>

        <Box marginTop={1} flexDirection="column">
          <Box>
            <Text color={colors.muted}>Deployment: </Text>
            <Text bold>{state.deploymentName}</Text>
          </Box>
          <Box>
            <Text color={colors.muted}>Target URL: </Text>
            <Text>{apiUrl}</Text>
          </Box>
          <Box>
            <Text color={colors.muted}>Test Mode: </Text>
            <Text bold>{state.testMode.toUpperCase()}</Text>
          </Box>
          <Box>
            <Text color={colors.muted}>Preset: </Text>
            <Text>{state.preset}</Text>
          </Box>
          <Box>
            <Text color={colors.muted}>Target RPS: </Text>
            <Text>{state.targetRps} requests/sec</Text>
          </Box>
          <Box>
            <Text color={colors.muted}>Duration: </Text>
            <Text>{state.testDuration} (+ 1m warm-up)</Text>
          </Box>
          {state.testMode === "throughput" && (
            <Box>
              <Text color={colors.muted}>Bulk Size: </Text>
              <Text>{state.bulkSize} payloads/request</Text>
            </Box>
          )}
          <Box marginTop={1}>
            <Text color={colors.accent}>
              Expected {state.testMode === "throughput" ? "throughput" : "load"}
              : ~{expectedThroughput.toLocaleString()}{" "}
              {state.testMode === "throughput" ? "solutions" : "requests"}/sec
            </Text>
          </Box>
        </Box>
      </Box>

      <Box marginTop={1}>
        <Text color={colors.muted} dimColor>
          Esc to go back • Enter to start benchmark
        </Text>
      </Box>
    </BorderBox>
  );
}

// ============================================================================
// Initial State Factory
// ============================================================================

export function createInitialBenchmarkState(): BenchmarkWizardState {
  return {
    deploymentName: "",
    deploymentUrl: "",
    apiKey: "",
    flowSlug: "",
    testMode: "qps",
    preset: "medium",
    targetRps: QPS_PRESETS.medium.targetRps,
    testDuration: QPS_PRESETS.medium.testDuration,
    bulkSize: THROUGHPUT_PRESETS.medium.bulkSize,
  };
}
