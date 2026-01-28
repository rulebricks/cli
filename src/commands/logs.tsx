import React, { useState, useEffect, useRef } from "react";
import { Box, Text, useApp, useStdout } from "ink";
import SelectInput from "ink-select-input";
import {
  BorderBox,
  Spinner,
  ThemeProvider,
  useTheme,
  Logo,
} from "../components/common/index.js";
import { loadDeploymentState } from "../lib/config.js";
import {
  getComponentPods,
  streamLogs,
  streamMultiPodLogs,
  VALID_LOG_COMPONENTS,
} from "../lib/kubernetes.js";
import { getNamespace, getReleaseName } from "../types/index.js";

interface LogsCommandProps {
  name: string;
  component: string;
  follow?: boolean;
  tail?: number;
  split?: boolean;
}

const COMPONENTS = [
  { label: "Web Application", value: "app" },
  { label: "Solver Handlers", value: "hps" },
  { label: "Solver Workers", value: "workers" },
  { label: "Kafka", value: "kafka" },
  { label: "Supabase", value: "supabase" },
  { label: "Traefik", value: "traefik" },
];

/**
 * Shortens a pod name for display.
 * E.g., "rulebricks-app-7f8b9c6d5-x2k4m" -> "app-x2k4m"
 */
function shortenPodName(podName: string): string {
  const parts = podName.split("-");
  if (parts.length >= 3) {
    const suffix = parts[parts.length - 1];
    let componentIndex = 0;
    if (parts[0] === "rulebricks" || parts[0].length > 10) {
      componentIndex = 1;
    }
    const component = parts[componentIndex] || parts[0];
    return `${component}-${suffix}`;
  }
  return podName.length > 20 ? podName.substring(0, 17) + "..." : podName;
}

/**
 * Colors for split view column headers
 */
const COLUMN_COLORS = ["cyan", "yellow", "magenta", "green", "blue"] as const;

/**
 * Maximum number of columns to display in split view
 */
const MAX_SPLIT_COLUMNS = 3;

/**
 * Number of log lines to buffer per pod
 */
const LOG_BUFFER_SIZE = 50;

interface SplitLogViewProps {
  pods: string[];
  namespace: string;
  follow: boolean;
  tail?: number;
  onCleanup: (cleanup: () => void) => void;
}

interface PodLogBuffer {
  lines: string[];
}

function SplitLogView({
  pods,
  namespace,
  follow,
  tail,
  onCleanup,
}: SplitLogViewProps) {
  const { colors } = useTheme();
  const { stdout } = useStdout();
  const [logBuffers, setLogBuffers] = useState<Record<string, PodLogBuffer>>(
    () => {
      const initial: Record<string, PodLogBuffer> = {};
      for (const pod of pods.slice(0, MAX_SPLIT_COLUMNS)) {
        initial[pod] = { lines: [] };
      }
      return initial;
    },
  );
  const [terminalHeight, setTerminalHeight] = useState(stdout?.rows || 24);
  const cleanupRef = useRef<(() => void) | null>(null);

  // Calculate available height for log content
  const headerHeight = 4; // Header + pod names + separator + footer
  const contentHeight = Math.max(5, terminalHeight - headerHeight);
  const displayedPods = pods.slice(0, MAX_SPLIT_COLUMNS);

  // Handle terminal resize
  useEffect(() => {
    if (stdout) {
      const handleResize = () => {
        setTerminalHeight(stdout.rows || 24);
      };
      stdout.on("resize", handleResize);
      return () => {
        stdout.off("resize", handleResize);
      };
    }
  }, [stdout]);

  // Start log streaming
  useEffect(() => {
    const cleanup = streamMultiPodLogs(displayedPods, namespace, {
      follow,
      tail: tail || LOG_BUFFER_SIZE,
      timestamps: false,
      onLine: (podName, line, _colorIndex) => {
        setLogBuffers((prev) => {
          const buffer = prev[podName] || { lines: [] };
          const newLines = [...buffer.lines, line];
          // Keep only the last LOG_BUFFER_SIZE lines
          if (newLines.length > LOG_BUFFER_SIZE) {
            newLines.splice(0, newLines.length - LOG_BUFFER_SIZE);
          }
          return {
            ...prev,
            [podName]: { lines: newLines },
          };
        });
      },
    });

    cleanupRef.current = cleanup;
    onCleanup(cleanup);

    return () => {
      if (cleanupRef.current) {
        cleanupRef.current();
      }
    };
  }, [displayedPods.join(","), namespace, follow, tail]);

  // Get terminal width for column sizing
  const terminalWidth = stdout?.columns || 80;
  const columnWidth = Math.floor(
    (terminalWidth - displayedPods.length - 1) / displayedPods.length,
  );

  return (
    <Box flexDirection="column">
      {/* Header */}
      <Box marginBottom={1}>
        <Text color={colors.accent} bold>
          Split view: {displayedPods.length} pods
          {pods.length > MAX_SPLIT_COLUMNS && (
            <Text color={colors.muted}>
              {" "}
              ({pods.length - MAX_SPLIT_COLUMNS} more not shown)
            </Text>
          )}
        </Text>
      </Box>

      {/* Column headers */}
      <Box flexDirection="row">
        {displayedPods.map((pod, index) => (
          <Box
            key={pod}
            width={columnWidth}
            marginRight={index < displayedPods.length - 1 ? 1 : 0}
          >
            <Text color={COLUMN_COLORS[index % COLUMN_COLORS.length]} bold>
              {shortenPodName(pod).substring(0, columnWidth - 2)}
            </Text>
          </Box>
        ))}
      </Box>

      {/* Separator */}
      <Box flexDirection="row" marginBottom={1}>
        {displayedPods.map((pod, index) => (
          <Box
            key={`sep-${pod}`}
            width={columnWidth}
            marginRight={index < displayedPods.length - 1 ? 1 : 0}
          >
            <Text color={colors.muted}>
              {"─".repeat(Math.max(1, columnWidth - 1))}
            </Text>
          </Box>
        ))}
      </Box>

      {/* Log content columns */}
      <Box flexDirection="row" height={contentHeight}>
        {displayedPods.map((pod, index) => {
          const buffer = logBuffers[pod] || { lines: [] };
          // Show the most recent lines that fit in the content height
          const visibleLines = buffer.lines.slice(-contentHeight);

          return (
            <Box
              key={`log-${pod}`}
              width={columnWidth}
              flexDirection="column"
              marginRight={index < displayedPods.length - 1 ? 1 : 0}
              overflow="hidden"
            >
              {visibleLines.map((line, lineIndex) => (
                <Text key={lineIndex} wrap="truncate">
                  {line.substring(0, columnWidth - 1)}
                </Text>
              ))}
              {visibleLines.length === 0 && (
                <Text color={colors.muted} dimColor>
                  Waiting for logs...
                </Text>
              )}
            </Box>
          );
        })}
      </Box>

      {/* Footer */}
      <Box marginTop={1}>
        <Text color={colors.muted}>Press Ctrl+C to stop</Text>
      </Box>
    </Box>
  );
}

function LogsCommandInner({
  name,
  component,
  follow,
  tail,
  split,
}: LogsCommandProps) {
  const { exit } = useApp();
  const { colors } = useTheme();
  const [step, setStep] = useState<
    "select" | "loading" | "streaming" | "streaming-split" | "error"
  >(
    component && VALID_LOG_COMPONENTS.includes(component)
      ? "loading"
      : "select",
  );
  const [selectedComponent, setSelectedComponent] = useState(component);
  const [pods, setPods] = useState<string[]>([]);
  const [namespace, setNamespace] = useState<string>("");
  const [error, setError] = useState<string | null>(null);
  const cleanupRef = useRef<(() => void) | null>(null);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (cleanupRef.current) {
        cleanupRef.current();
      }
    };
  }, []);

  useEffect(() => {
    if (step === "loading") {
      loadPods();
    }
  }, [step, selectedComponent]);

  async function loadPods() {
    try {
      const state = await loadDeploymentState(name);
      // Use namespace from state if available (backwards compat), otherwise compute from deployment name
      const ns = state?.application?.namespace || getNamespace(name);
      setNamespace(ns);
      const releaseName = getReleaseName(name);

      if (!VALID_LOG_COMPONENTS.includes(selectedComponent)) {
        setError(`Unknown component: ${selectedComponent}`);
        setStep("error");
        return;
      }

      const podNames = await getComponentPods(
        selectedComponent,
        releaseName,
        ns,
      );

      if (podNames.length === 0) {
        setError(`No pods found for component: ${selectedComponent}`);
        setStep("error");
        return;
      }

      setPods(podNames);
      const isFollowing = follow ?? true;

      // Use split view if requested and multiple pods exist
      if (split && podNames.length > 1) {
        setStep("streaming-split");
        // Split view will be rendered by the component
        return;
      }

      // For multiple pods without split, use unified multi-pod streaming
      if (podNames.length > 1) {
        setStep("streaming");
        // Start multi-pod log streaming with prefixed output
        cleanupRef.current = streamMultiPodLogs(podNames, ns, {
          follow: isFollowing,
          tail,
          timestamps: true,
        });

        // If not following, wait a bit then exit
        if (!isFollowing) {
          setTimeout(() => {
            if (cleanupRef.current) {
              cleanupRef.current();
            }
            exit();
          }, 2000);
        }
        return;
      }

      // Single pod - use original behavior
      setStep("streaming");
      await streamLogs(podNames[0], ns, { follow: isFollowing, tail });

      // If not following, exit after logs are printed
      if (!isFollowing) {
        exit();
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to get logs");
      setStep("error");
    }
  }

  const handleComponentSelect = (item: { value: string }) => {
    setSelectedComponent(item.value);
    setStep("loading");
  };

  if (step === "error") {
    return (
      <BorderBox title="Logs Error">
        <Box marginY={1}>
          <Text color={colors.error}>✗ {error}</Text>
        </Box>
      </BorderBox>
    );
  }

  if (step === "loading") {
    return (
      <BorderBox title={`Logs: ${selectedComponent}`}>
        <Box marginY={1}>
          <Spinner label={`Finding ${selectedComponent} pods...`} />
        </Box>
      </BorderBox>
    );
  }

  if (step === "streaming-split") {
    const isFollowing = follow ?? true;
    return (
      <SplitLogView
        pods={pods}
        namespace={namespace}
        follow={isFollowing}
        tail={tail}
        onCleanup={(cleanup) => {
          cleanupRef.current = cleanup;
        }}
      />
    );
  }

  if (step === "streaming") {
    const isFollowing = follow ?? true;
    const podCountText = pods.length > 1 ? `${pods.length} pods` : pods[0];
    return (
      <Box flexDirection="column">
        <Text color={colors.accent} bold>
          {isFollowing ? "Streaming" : "Showing"} logs from {podCountText}
        </Text>
        {pods.length > 1 && (
          <Text color={colors.muted}>
            Pods: {pods.map((p, i) => shortenPodName(p)).join(", ")}
          </Text>
        )}
        {isFollowing && <Text color={colors.muted}>Press Ctrl+C to stop</Text>}
        {/* Logs are streamed directly to stdout */}
      </Box>
    );
  }

  // Component selection
  return (
    <BorderBox title="Select Component">
      <Box flexDirection="column" marginY={1}>
        <Text>Which component's logs would you like to view?</Text>
        <Box marginTop={1}>
          <SelectInput
            items={COMPONENTS}
            onSelect={handleComponentSelect}
            itemComponent={({ isSelected, label }) => (
              <Text color={isSelected ? colors.accent : undefined}>
                {label}
              </Text>
            )}
          />
        </Box>
      </Box>
    </BorderBox>
  );
}

export function LogsCommand(props: LogsCommandProps) {
  return (
    <ThemeProvider theme="logs">
      <Logo />
      <LogsCommandInner {...props} />
    </ThemeProvider>
  );
}
