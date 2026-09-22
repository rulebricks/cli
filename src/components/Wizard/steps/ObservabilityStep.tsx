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
import { DEFAULT_CLICKHOUSE_STORAGE_SIZE } from "../../../lib/chartDefaults.js";

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
  const [clickHouseStorage, setClickHouseStorage] = useState(
    state.clickHouseStorageSize || DEFAULT_CLICKHOUSE_STORAGE_SIZE,
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
          hint="Built-in ClickStack gives you logs, traces, mirrored metrics, and dashboards. Persistent ClickHouse stores native data in object storage and uses its PVC as a bounded local cache."
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
      id: "clickhouse-storage",
      when: () => mode === "built-in" || state.clickHousePersistenceEnabled,
      render: (flow) => (
        <Box flexDirection="column">
          <TextField
            label="ClickHouse cache PVC size"
            hint="Sets only the disposable native-object read cache. Stateful installs also keep a separate 100Gi catalog/metadata PVC; stateless installs create neither PVC."
            value={clickHouseStorage}
            onChange={setClickHouseStorage}
            placeholder={DEFAULT_CLICKHOUSE_STORAGE_SIZE}
            onSubmit={() => {
              dispatch({
                type: "SET_CLICKHOUSE_CONFIG",
                config: {
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
