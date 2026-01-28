/**
 * Benchmark Command
 *
 * Interactive wizard for configuring and running k6 load tests
 * against Rulebricks deployments.
 */

import React, { useState, useEffect, useCallback } from "react";
import { Box, Text, useApp, useInput } from "ink";
import {
  BorderBox,
  Spinner,
  StatusLine,
  ThemeProvider,
  useTheme,
  Logo,
} from "../components/common/index.js";
import {
  DeploymentSelectStep,
  ApiKeyStep,
  FlowSlugStep,
  TestModeStep,
  PresetsStep,
  ReviewStep,
  BenchmarkWizardState,
  createInitialBenchmarkState,
} from "../components/Wizard/steps/BenchmarkSteps.js";
import {
  isK6Installed,
  getK6InstallInstructions,
  runBenchmark,
  buildApiUrl,
  openInBrowser,
  formatDuration,
} from "../lib/benchmark.js";
import { BenchmarkConfig, BenchmarkResult } from "../types/index.js";

interface BenchmarkCommandProps {
  name?: string;
}

type BenchmarkStep =
  | "preflight"
  | "select-deployment"
  | "api-key"
  | "flow-slug"
  | "test-mode"
  | "presets"
  | "review"
  | "running"
  | "complete"
  | "error";

function BenchmarkCommandInner({ name }: BenchmarkCommandProps) {
  const { exit } = useApp();
  const { colors } = useTheme();
  const [step, setStep] = useState<BenchmarkStep>("preflight");
  const [wizardState, setWizardState] = useState<BenchmarkWizardState>(
    createInitialBenchmarkState(),
  );
  const [error, setError] = useState<string | null>(null);
  const [k6Output, setK6Output] = useState<string[]>([]);
  const [result, setResult] = useState<BenchmarkResult | null>(null);

  // Preflight check for k6
  useEffect(() => {
    if (step !== "preflight") return;

    (async () => {
      const installed = await isK6Installed();
      if (!installed) {
        setError(
          `k6 is not installed.\n\n${getK6InstallInstructions()}\n\nVisit https://k6.io/docs/get-started/installation/ for more options.`,
        );
        setStep("error");
        return;
      }

      // If a deployment name was provided via CLI, skip the selection step
      if (name) {
        setWizardState((s) => ({ ...s, deploymentName: name }));
        // We still need to load the deployment URL, which the DeploymentSelectStep does
        // So we'll go to that step anyway to validate and load the URL
      }

      setStep("select-deployment");
    })();
  }, [step, name]);

  // Handle wizard step completion
  const handleStepComplete = useCallback(
    (data: Partial<BenchmarkWizardState>) => {
      setWizardState((s) => ({ ...s, ...data }));

      // Progress to next step
      switch (step) {
        case "select-deployment":
          setStep("api-key");
          break;
        case "api-key":
          setStep("flow-slug");
          break;
        case "flow-slug":
          setStep("test-mode");
          break;
        case "test-mode":
          setStep("presets");
          break;
        case "presets":
          setStep("review");
          break;
        case "review":
          setStep("running");
          break;
      }
    },
    [step],
  );

  // Handle going back
  const handleBack = useCallback(() => {
    switch (step) {
      case "select-deployment":
        exit();
        break;
      case "api-key":
        setStep("select-deployment");
        break;
      case "flow-slug":
        setStep("api-key");
        break;
      case "test-mode":
        setStep("flow-slug");
        break;
      case "presets":
        setStep("test-mode");
        break;
      case "review":
        setStep("presets");
        break;
    }
  }, [step, exit]);

  // Run the benchmark
  useEffect(() => {
    if (step !== "running") return;

    (async () => {
      const config: BenchmarkConfig = {
        deploymentName: wizardState.deploymentName,
        apiUrl: buildApiUrl(wizardState.deploymentUrl, wizardState.flowSlug),
        apiKey: wizardState.apiKey,
        testMode: wizardState.testMode,
        testDuration: wizardState.testDuration,
        targetRps: wizardState.targetRps,
        bulkSize:
          wizardState.testMode === "throughput"
            ? wizardState.bulkSize
            : undefined,
      };

      const benchmarkResult = await runBenchmark(config, {
        onOutput: (line) => {
          setK6Output((prev) => {
            // Keep only last 15 lines to avoid memory issues
            const newOutput = [...prev, line];
            if (newOutput.length > 15) {
              return newOutput.slice(-15);
            }
            return newOutput;
          });
        },
      });

      setResult(benchmarkResult);

      if (benchmarkResult.success) {
        setStep("complete");
        // Try to open report in browser
        try {
          await openInBrowser(benchmarkResult.reportPath);
        } catch {
          // Ignore browser open errors
        }
      } else {
        setError(benchmarkResult.error || "Benchmark failed");
        setStep("error");
      }
    })();
  }, [step, wizardState]);

  // Handle key input for error/complete screens
  useInput((input, key) => {
    if (key.escape && (step === "error" || step === "complete")) {
      exit();
    }
  });

  // Render preflight check
  if (step === "preflight") {
    return (
      <BorderBox title="Benchmark">
        <Box marginY={1}>
          <Spinner label="Checking prerequisites..." />
        </Box>
      </BorderBox>
    );
  }

  // Render error screen
  if (step === "error") {
    return (
      <BorderBox title="Benchmark Failed">
        <Box flexDirection="column" marginY={1}>
          <Text color={colors.error} bold>
            Error
          </Text>
          <Text color={colors.error}>{error}</Text>

          {result?.outputDir && (
            <Box marginTop={1}>
              <Text color={colors.muted} dimColor>
                Output directory: {result.outputDir}
              </Text>
            </Box>
          )}

          <Box marginTop={1}>
            <Text color={colors.muted} dimColor>
              Press Esc to exit
            </Text>
          </Box>
        </Box>
      </BorderBox>
    );
  }

  // Render running screen
  if (step === "running") {
    const expectedThroughput =
      wizardState.testMode === "throughput"
        ? wizardState.targetRps * wizardState.bulkSize
        : wizardState.targetRps;

    return (
      <BorderBox title="Running Benchmark">
        <Box flexDirection="column" marginY={1}>
          <Box marginBottom={1}>
            <Spinner
              label={`Running ${wizardState.testMode.toUpperCase()} test against ${wizardState.deploymentName}...`}
            />
          </Box>

          <Box flexDirection="column" marginBottom={1}>
            <Text color={colors.muted}>
              Target: {expectedThroughput.toLocaleString()}{" "}
              {wizardState.testMode === "throughput" ? "solutions" : "requests"}
              /sec
            </Text>
            <Text color={colors.muted}>
              Duration: 1m warm-up + {formatDuration(wizardState.testDuration)}
            </Text>
          </Box>

          {k6Output.length > 0 && (
            <Box flexDirection="column" borderStyle="single" paddingX={1}>
              {k6Output.map((line, i) => (
                <Text key={i} color={colors.muted} dimColor>
                  {line.length > 80 ? line.slice(0, 77) + "..." : line}
                </Text>
              ))}
            </Box>
          )}

          <Box marginTop={1}>
            <Text color={colors.warning} dimColor>
              This may take several minutes. Please wait...
            </Text>
          </Box>
        </Box>
      </BorderBox>
    );
  }

  // Render complete screen
  if (step === "complete" && result) {
    const metrics = result.metrics;

    return (
      <BorderBox title="Benchmark Complete">
        <Box flexDirection="column" marginY={1}>
          <Text color={colors.success} bold>
            Benchmark completed successfully!
          </Text>

          {metrics && (
            <Box flexDirection="column" marginTop={1}>
              <Text bold>Results Summary:</Text>
              <Box marginTop={1} flexDirection="column">
                <Box>
                  <Text color={colors.muted}>Success Rate: </Text>
                  <Text
                    color={
                      metrics.successRate >= 99
                        ? colors.success
                        : metrics.successRate >= 95
                          ? colors.warning
                          : colors.error
                    }
                    bold
                  >
                    {metrics.successRate.toFixed(1)}%
                  </Text>
                </Box>
                <Box>
                  <Text color={colors.muted}>Actual RPS: </Text>
                  <Text color={colors.accent} bold>
                    {metrics.actualRps.toFixed(1)}
                  </Text>
                </Box>
                {metrics.actualThroughput && (
                  <Box>
                    <Text color={colors.muted}>Throughput: </Text>
                    <Text color={colors.accent} bold>
                      {metrics.actualThroughput.toFixed(0)} solutions/sec
                    </Text>
                  </Box>
                )}
                <Box>
                  <Text color={colors.muted}>P95 Latency: </Text>
                  <Text
                    color={
                      metrics.p95Latency < 200
                        ? colors.success
                        : metrics.p95Latency < 500
                          ? colors.warning
                          : colors.error
                    }
                  >
                    {metrics.p95Latency.toFixed(0)}ms
                  </Text>
                </Box>
                <Box>
                  <Text color={colors.muted}>P99 Latency: </Text>
                  <Text>{metrics.p99Latency.toFixed(0)}ms</Text>
                </Box>
                <Box>
                  <Text color={colors.muted}>Total Requests: </Text>
                  <Text>{metrics.totalRequests.toLocaleString()}</Text>
                </Box>
              </Box>
            </Box>
          )}

          <Box flexDirection="column" marginTop={1}>
            <Text color={colors.muted}>Results saved to:</Text>
            <Text color={colors.accent}>{result.outputDir}</Text>
          </Box>

          <Box marginTop={1}>
            <Text color={colors.muted}>
              Report: {result.reportPath.split("/").pop()}
            </Text>
          </Box>

          <Box marginTop={1}>
            <Text color={colors.success}>
              The HTML report should open in your browser automatically.
            </Text>
          </Box>

          <Box marginTop={1}>
            <Text color={colors.muted} dimColor>
              Press Esc to exit
            </Text>
          </Box>
        </Box>
      </BorderBox>
    );
  }

  // Render wizard steps
  return (
    <>
      {step === "select-deployment" && (
        <DeploymentSelectStep
          onComplete={handleStepComplete}
          onBack={handleBack}
          state={wizardState}
        />
      )}
      {step === "api-key" && (
        <ApiKeyStep
          onComplete={handleStepComplete}
          onBack={handleBack}
          state={wizardState}
        />
      )}
      {step === "flow-slug" && (
        <FlowSlugStep
          onComplete={handleStepComplete}
          onBack={handleBack}
          state={wizardState}
        />
      )}
      {step === "test-mode" && (
        <TestModeStep
          onComplete={handleStepComplete}
          onBack={handleBack}
          state={wizardState}
        />
      )}
      {step === "presets" && (
        <PresetsStep
          onComplete={handleStepComplete}
          onBack={handleBack}
          state={wizardState}
        />
      )}
      {step === "review" && (
        <ReviewStep
          onComplete={handleStepComplete}
          onBack={handleBack}
          state={wizardState}
        />
      )}
    </>
  );
}

export function BenchmarkCommand(props: BenchmarkCommandProps) {
  return (
    <ThemeProvider theme="status">
      <Logo />
      <BenchmarkCommandInner {...props} />
    </ThemeProvider>
  );
}
