import React, { useState } from "react";
import { Box, Text } from "ink";
import { useWizard } from "../WizardContext.js";
import { useFieldFlow, FlowField } from "../fieldFlow.js";
import {
  BorderBox,
  CheckboxList,
  FieldError,
  StepFooter,
  TextField,
  WizardSelect,
  useTheme,
} from "../../common/index.js";
import {
  DEFAULT_CLICKHOUSE_STORAGE_SIZE,
  DEFAULT_DECISION_LOG_RETENTION_DAYS,
} from "../../../lib/chartDefaults.js";

interface ObservabilityStepProps {
  onComplete: () => void;
  onBack: () => void;
  entryDirection?: "forward" | "back";
}

const MODE_OPTIONS = [
  {
    label: "Use Rulebricks built-in observability (ClickStack + HyperDX)",
    value: "built-in",
  },
  {
    label: "Export to my own observability systems (no built-in stack)",
    value: "byo",
  },
];

function parsePositiveInt(value: string, fallback: number): number {
  const parsed = Number.parseInt(value.trim(), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export function ObservabilityStep({
  onComplete,
  onBack,
  entryDirection,
}: ObservabilityStepProps) {
  const { state, dispatch } = useWizard();
  const { colors } = useTheme();
  const [error, setError] = useState<string | null>(null);

  const [mode, setMode] = useState<"built-in" | "byo">(
    state.clickStackEnabled ? "built-in" : "byo",
  );
  const [telemetryRetention, setTelemetryRetention] = useState(
    String(state.clickStackTelemetryRetentionDays || 7),
  );
  const [clickHouseStorage, setClickHouseStorage] = useState(
    state.clickHouseStorageSize || DEFAULT_CLICKHOUSE_STORAGE_SIZE,
  );
  const [decisionLogRetention, setDecisionLogRetention] = useState(
    String(
      state.decisionLogRetentionDays || DEFAULT_DECISION_LOG_RETENTION_DAYS,
    ),
  );

  const hyperDxStorageGi = mode === "built-in" ? 10 : 0;
  const requestedStorageGi =
    Number.parseInt(clickHouseStorage, 10) + hyperDxStorageGi;
  const reportedStorageGi = state.totalPersistentStorageGi || 0;
  const storageWarning =
    reportedStorageGi > 0 && requestedStorageGi > reportedStorageGi * 0.75;

  const capacitySummary = (
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
        Requested persistent PVCs:{" "}
        {Number.isFinite(requestedStorageGi) ? requestedStorageGi : 0} Gi (
        {clickHouseStorage || DEFAULT_CLICKHOUSE_STORAGE_SIZE} ClickHouse
        {hyperDxStorageGi > 0 ? " + 10Gi HyperDX metadata" : ""})
        {storageWarning ? " (high relative to reported capacity)" : ""}
      </Text>
    </Box>
  );

  const fields: FlowField[] = [
    {
      id: "mode",
      render: (flow) => (
        <WizardSelect
          label="How should Rulebricks observability be set up?"
          hint="Built-in ClickStack gives you logs, traces, mirrored metrics, and dashboards. It also keeps queryable decision logs in persistent ClickHouse while continuing the durable object-storage export."
          items={MODE_OPTIONS}
          initialValue={mode}
          onSelect={(value) => {
            const selected = value as "built-in" | "byo";
            setMode(selected);
            dispatch({
              type: "SET_CLICKSTACK_ENABLED",
              enabled: selected === "built-in",
            });
            flow.next();
          }}
        />
      ),
    },
    {
      id: "telemetry-retention",
      when: () => mode === "built-in",
      render: (flow) => (
        <TextField
          label="Telemetry retention (days)"
          hint="How many days of ClickStack operational logs, traces, and metrics to retain. Decision logs use their own retention window next."
          value={telemetryRetention}
          onChange={setTelemetryRetention}
          placeholder="7"
          onSubmit={() => {
            dispatch({
              type: "SET_CLICKSTACK_CONFIG",
              config: {
                clickStackTelemetryRetentionDays: parsePositiveInt(
                  telemetryRetention,
                  7,
                ),
              },
            });
            flow.next();
          }}
        />
      ),
    },
    {
      id: "decision-log-retention",
      when: () => mode === "built-in" || state.clickHousePersistenceEnabled,
      render: (flow) => (
        <TextField
          label="Decision-log retention (days)"
          hint="How long decision logs stay queryable in persistent ClickHouse. The object-storage export is unaffected and remains the durable history."
          value={decisionLogRetention}
          onChange={setDecisionLogRetention}
          placeholder={String(DEFAULT_DECISION_LOG_RETENTION_DAYS)}
          onSubmit={() => {
            dispatch({
              type: "SET_CLICKSTACK_CONFIG",
              config: {
                decisionLogRetentionDays: parsePositiveInt(
                  decisionLogRetention,
                  DEFAULT_DECISION_LOG_RETENTION_DAYS,
                ),
              },
            });
            flow.next();
          }}
        />
      ),
    },
    {
      id: "clickhouse-storage",
      when: () => mode === "built-in" || state.clickHousePersistenceEnabled,
      render: (flow) => (
        <Box flexDirection="column">
          <TextField
            label="ClickHouse PVC size"
            hint="Stores retained decision logs and, with ClickStack, operational telemetry. Start at 100Gi; size for retained ingest plus about 30% free merge headroom."
            value={clickHouseStorage}
            onChange={setClickHouseStorage}
            placeholder={DEFAULT_CLICKHOUSE_STORAGE_SIZE}
            onSubmit={() => {
              dispatch({
                type: "SET_CLICKSTACK_CONFIG",
                config: {
                  clickStackTelemetryRetentionDays: parsePositiveInt(
                    telemetryRetention,
                    7,
                  ),
                  decisionLogRetentionDays: parsePositiveInt(
                    decisionLogRetention,
                    DEFAULT_DECISION_LOG_RETENTION_DAYS,
                  ),
                  clickHouseStorageSize:
                    clickHouseStorage.trim() ||
                    DEFAULT_CLICKHOUSE_STORAGE_SIZE,
                },
              });
              flow.next();
            }}
          />
          {capacitySummary}
        </Box>
      ),
    },
    {
      // Metrics export is orthogonal to built-in observability: ClickStack
      // mirrors metrics for its own dashboards, while Prometheus remote_write
      // can simultaneously deliver them to the platform the customer's ops
      // team already lives in (Azure Managed Grafana, AMP, Grafana Cloud).
      id: "metrics-export",
      when: () => mode === "built-in",
      render: (flow) => (
        <WizardSelect
          label="Also send metrics to your own monitoring system?"
          hint="Built-in dashboards keep working either way. Prometheus remote_write can additionally deliver metrics to Azure Managed Prometheus/Grafana, Amazon Managed Prometheus, Grafana Cloud, or any compatible endpoint. Connection details come later in Feature Settings."
          items={[
            { label: "No - keep metrics in-cluster", value: "no" },
            { label: "Yes - also export metrics", value: "yes" },
          ]}
          initialValue={state.metricsExportEnabled ? "yes" : "no"}
          onSelect={(value) => {
            dispatch({
              type: "SET_METRICS_EXPORT",
              enabled: value === "yes",
            });
            flow.next();
          }}
        />
      ),
    },
    {
      id: "byo-signals",
      when: () => mode === "byo",
      render: (flow) => (
        <CheckboxList
          label="Select the signals you want to export to your own systems"
          hint="Space/Enter to toggle, then Continue. Connection details come later in Feature Settings."
          items={[
            {
              key: "metrics",
              label: "Metrics export",
              hint: "Prometheus remote_write to your managed metrics backend.",
              checked: state.metricsExportEnabled,
            },
            {
              key: "traces",
              label: "Distributed tracing",
              hint: "OTLP traces to Elastic, Azure Monitor, or another backend.",
              checked: state.tracingEnabled,
            },
            {
              key: "logs",
              label: "Application log shipping",
              hint: "Pod/app logs to Elasticsearch, Loki, or generic HTTP.",
              checked: state.appLogsEnabled,
            },
          ]}
          onToggle={(key) => {
            if (key === "metrics") {
              dispatch({
                type: "SET_METRICS_EXPORT",
                enabled: !state.metricsExportEnabled,
              });
            } else if (key === "traces") {
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
          }}
          onContinue={() => flow.next()}
        />
      ),
    },
  ];

  const flow = useFieldFlow({
    fields,
    onDone: onComplete,
    onExit: onBack,
    entry: entryDirection === "back" ? "end" : "start",
    onNavigate: () => setError(null),
  });

  return (
    <BorderBox title="Observability" footer={<StepFooter />}>
      {flow.render()}

      <FieldError error={error} />
    </BorderBox>
  );
}
