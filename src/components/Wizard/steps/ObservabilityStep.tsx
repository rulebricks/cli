import React, { useState } from "react";
import { Box, Text, useInput } from "ink";
import SelectInput from "ink-select-input";
import TextInput from "ink-text-input";
import { useWizard } from "../WizardContext.js";
import { BorderBox, useTheme } from "../../common/index.js";

interface ObservabilityStepProps {
  onComplete: () => void;
  onBack: () => void;
}

type SubStep =
  | "mode"
  | "builtin-decision-retention"
  | "builtin-telemetry-retention"
  | "builtin-clickhouse-storage"
  | "byo-signals";

const MODE_OPTIONS = [
  {
    label: "Use Rulebricks built-in observability (ClickStack + HyperDX)",
    value: "built-in",
  },
  {
    label: "Export to my own observability systems",
    value: "byo",
  },
];

const SIGNALS = [
  {
    id: "metrics",
    label: "Metrics export",
    description: "Prometheus remote_write to your managed metrics backend.",
  },
  {
    id: "traces",
    label: "Distributed tracing",
    description: "OTLP traces to Elastic, Azure Monitor, or another backend.",
  },
  {
    id: "logs",
    label: "Application log shipping",
    description: "Pod/app logs to Elasticsearch, Loki, or generic HTTP.",
  },
] as const;

function parsePositiveInt(value: string, fallback: number): number {
  const parsed = Number.parseInt(value.trim(), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function normalizeSize(value: string, fallback: string): string {
  const trimmed = value.trim();
  return trimmed || fallback;
}

export function ObservabilityStep({
  onComplete,
  onBack,
}: ObservabilityStepProps) {
  const { state, dispatch } = useWizard();
  const { colors } = useTheme();
  const [subStep, setSubStep] = useState<SubStep>("mode");
  const [decisionRetention, setDecisionRetention] = useState(
    String(state.decisionLogAccelerationRetentionDays || 30),
  );
  const [telemetryRetention, setTelemetryRetention] = useState(
    String(state.clickStackTelemetryRetentionDays || 7),
  );
  const [clickHouseStorage, setClickHouseStorage] = useState(
    state.clickHouseStorageSize || "100Gi",
  );
  const [signalIndex, setSignalIndex] = useState(0);

  const requestedStorageGi = Number.parseInt(clickHouseStorage, 10) + 10;
  const reportedStorageGi = state.totalPersistentStorageGi || 0;
  const storageWarning =
    reportedStorageGi > 0 && requestedStorageGi > reportedStorageGi * 0.75;

  useInput((input, key) => {
    if (key.escape) {
      if (subStep === "mode") {
        onBack();
      } else {
        setSubStep("mode");
      }
      return;
    }

    if (subStep !== "byo-signals") return;

    if (key.upArrow) {
      setSignalIndex((idx) => Math.max(0, idx - 1));
    } else if (key.downArrow) {
      setSignalIndex((idx) => Math.min(SIGNALS.length, idx + 1));
    } else if (input === " " || input === "x" || key.return) {
      if (signalIndex === SIGNALS.length) {
        onComplete();
        return;
      }
      const signal = SIGNALS[signalIndex];
      if (signal.id === "metrics") {
        dispatch({
          type: "SET_METRICS_EXPORT",
          enabled: !state.metricsExportEnabled,
        });
      } else if (signal.id === "traces") {
        dispatch({
          type: "SET_TRACING_ENABLED",
          enabled: !state.tracingEnabled,
        });
      } else {
        dispatch({
          type: "SET_APP_LOGS_ENABLED",
          enabled: !state.appLogsEnabled,
        });
      }
    }
  });

  const chooseMode = (item: { value: string }) => {
    if (item.value === "built-in") {
      dispatch({ type: "SET_CLICKSTACK_ENABLED", enabled: true });
      setSubStep("builtin-decision-retention");
      return;
    }

    dispatch({ type: "SET_CLICKSTACK_ENABLED", enabled: false });
    setSubStep("byo-signals");
  };

  const saveBuiltInSettings = () => {
    dispatch({
      type: "SET_CLICKSTACK_CONFIG",
      config: {
        decisionLogAccelerationRetentionDays: parsePositiveInt(
          decisionRetention,
          30,
        ),
        clickStackTelemetryRetentionDays: parsePositiveInt(telemetryRetention, 7),
        clickHouseStorageSize: normalizeSize(clickHouseStorage, "100Gi"),
      },
    });
    onComplete();
  };

  const renderCapacitySummary = () => (
    <Box flexDirection="column" marginTop={1}>
      <Text color="gray" dimColor>
        Storage class: {state.storageClass || "not detected"}
      </Text>
      <Text color="gray" dimColor>
        Reported persistent storage:{" "}
        {reportedStorageGi > 0
          ? `${Math.ceil(reportedStorageGi)} Gi`
          : "unknown / dynamic provisioning"}
      </Text>
      <Text color={storageWarning ? colors.warning : "gray"} dimColor>
        Requested ClickStack PVCs: {Number.isFinite(requestedStorageGi) ? requestedStorageGi : 0} Gi
        {" "}({clickHouseStorage || "100Gi"} ClickHouse + 10Gi HyperDX metadata)
        {storageWarning ? " (high relative to reported capacity)" : ""}
      </Text>
    </Box>
  );

  if (subStep === "mode") {
    return (
      <BorderBox title="Observability">
        <Box flexDirection="column" marginY={1}>
          <Text>How should Rulebricks observability be set up?</Text>
          <Text color="gray" dimColor>
            Built-in ClickStack gives you logs, traces, mirrored metrics, and
            accelerated decision-log queries in-cluster.
          </Text>
        </Box>
        <SelectInput items={MODE_OPTIONS} onSelect={chooseMode} />
        <Box marginTop={1}>
          <Text color="gray" dimColor>
            Esc to go back
          </Text>
        </Box>
      </BorderBox>
    );
  }

  if (subStep === "builtin-decision-retention") {
    return (
      <BorderBox title="Decision Log Acceleration">
        <Box flexDirection="column" marginY={1}>
          <Text>How many days of decision logs should stay fast in ClickHouse?</Text>
          <Text color="gray" dimColor>
            Older records still fall back to the object-storage archive.
          </Text>
          <Box marginTop={1}>
            <Text>Days: </Text>
            <TextInput
              value={decisionRetention}
              onChange={setDecisionRetention}
              onSubmit={() => setSubStep("builtin-telemetry-retention")}
              placeholder="30"
            />
          </Box>
        </Box>
      </BorderBox>
    );
  }

  if (subStep === "builtin-telemetry-retention") {
    return (
      <BorderBox title="Telemetry Retention">
        <Box flexDirection="column" marginY={1}>
          <Text>How many days of ClickStack logs/traces/metrics should be retained?</Text>
          <Text color="gray" dimColor>
            This controls operational telemetry TTL, not the decision-log archive.
          </Text>
          <Box marginTop={1}>
            <Text>Days: </Text>
            <TextInput
              value={telemetryRetention}
              onChange={setTelemetryRetention}
              onSubmit={() => setSubStep("builtin-clickhouse-storage")}
              placeholder="7"
            />
          </Box>
        </Box>
      </BorderBox>
    );
  }

  if (subStep === "builtin-clickhouse-storage") {
    return (
      <BorderBox title="ClickHouse Storage">
        <Box flexDirection="column" marginY={1}>
          <Text>How large should the ClickHouse PVC be?</Text>
          <Text color="gray" dimColor>
            Stores recent decision logs and ClickStack telemetry. Example: 100Gi
          </Text>
          {renderCapacitySummary()}
          <Box marginTop={1}>
            <Text>Size: </Text>
            <TextInput
              value={clickHouseStorage}
              onChange={setClickHouseStorage}
              onSubmit={saveBuiltInSettings}
              placeholder="100Gi"
            />
          </Box>
        </Box>
      </BorderBox>
    );
  }

  return (
    <BorderBox title="BYO Observability Signals">
      <Box flexDirection="column" marginY={1}>
        <Text>Select the signals you want to export to your own systems:</Text>
        <Text color="gray" dimColor>
          Space/Enter to toggle, then Continue. Connection details come later in
          Feature Settings.
        </Text>
      </Box>
      <Box flexDirection="column" marginY={1}>
        {SIGNALS.map((signal, index) => {
          const enabled =
            signal.id === "metrics"
              ? state.metricsExportEnabled
              : signal.id === "traces"
                ? state.tracingEnabled
                : state.appLogsEnabled;
          const selected = signalIndex === index;
          return (
            <Box key={signal.id} flexDirection="column" marginBottom={selected ? 1 : 0}>
              <Box>
                <Text color={selected ? colors.accent : undefined}>
                  {selected ? "❯ " : "  "}
                </Text>
                <Text color={enabled ? colors.success : colors.muted}>
                  {enabled ? "[✓]" : "[ ]"}
                </Text>
                <Text color={selected ? colors.accent : undefined}>
                  {" "}
                  {signal.label}
                </Text>
              </Box>
              {selected && (
                <Box marginLeft={6}>
                  <Text color="gray" dimColor>
                    {signal.description}
                  </Text>
                </Box>
              )}
            </Box>
          );
        })}
        <Box marginTop={1}>
          <Text color={signalIndex === SIGNALS.length ? colors.accent : colors.muted}>
            {signalIndex === SIGNALS.length ? "❯ " : "  "}
          </Text>
          <Text
            color={signalIndex === SIGNALS.length ? colors.success : colors.muted}
            bold={signalIndex === SIGNALS.length}
          >
            [Continue →]
          </Text>
        </Box>
      </Box>
    </BorderBox>
  );
}
