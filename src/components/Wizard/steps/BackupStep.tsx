import React, { useState } from "react";
import { Box, Text, useInput } from "ink";
import TextInput from "ink-text-input";
import SelectInput from "ink-select-input";
import { useWizard } from "../WizardContext.js";
import { BorderBox, useTheme } from "../../common/index.js";

interface BackupStepProps {
  onComplete: () => void;
  onBack: () => void;
}

type Field = "enabled" | "frequency" | "frequency-custom" | "retention" | "done";

// Healthy cron presets so users don't hand-write cron.
const FREQUENCY_PRESETS: { label: string; value: string }[] = [
  { label: "Every 30 minutes", value: "*/30 * * * *" },
  { label: "Hourly", value: "0 * * * *" },
  { label: "Every 6 hours", value: "0 */6 * * *" },
  { label: "Every 12 hours", value: "0 */12 * * *" },
  { label: "Daily (02:00 UTC)", value: "0 2 * * *" },
  { label: "Weekly (Sun 02:00 UTC)", value: "0 2 * * 0" },
  { label: "Custom cron…", value: "__custom__" },
];

const CUSTOM = "__custom__";

export function BackupStep({ onComplete, onBack }: BackupStepProps) {
  const { state, dispatch } = useWizard();
  const { colors } = useTheme();
  const [field, setField] = useState<Field>("enabled");
  const [enabled, setEnabled] = useState(state.backupEnabled);
  const [schedule, setSchedule] = useState(state.backupSchedule || "0 2 * * *");
  const [retentionDays, setRetentionDays] = useState(
    String(state.backupRetentionDays || 7),
  );
  const [error, setError] = useState<string | null>(null);

  const finish = () => {
    const parsedRetention = Number.parseInt(retentionDays, 10);
    dispatch({ type: "SET_BACKUP_ENABLED", enabled });
    dispatch({ type: "SET_BACKUP_SCHEDULE", schedule: schedule || "0 2 * * *" });
    dispatch({
      type: "SET_BACKUP_RETENTION_DAYS",
      retentionDays: Number.isFinite(parsedRetention) ? parsedRetention : 7,
    });
    onComplete();
  };

  useInput((input, key) => {
    if (key.escape) {
      onBack();
      return;
    }

    if (field === "enabled") {
      if (input === " " || input.toLowerCase() === "x") {
        setEnabled((value) => !value);
      } else if (key.return) {
        if (enabled) {
          setField("frequency");
        } else {
          finish();
        }
      }
      return;
    }

    if (field === "done" && key.return) {
      finish();
    }
  });

  const handleFrequencySelect = (item: { value: string }) => {
    if (item.value === CUSTOM) {
      setField("frequency-custom");
      return;
    }
    setSchedule(item.value);
    setField("retention");
  };

  const handleFrequencyCustomSubmit = () => {
    if (!schedule.trim()) {
      setError("Enter a cron expression or go back to pick a preset");
      return;
    }
    setError(null);
    setField("retention");
  };

  const handleRetentionSubmit = () => {
    const parsed = Number.parseInt(retentionDays, 10);
    if (!Number.isFinite(parsed) || parsed < 2) {
      setError("Retention must be greater than 1 (at least 2 days)");
      return;
    }
    setError(null);
    setField("done");
  };

  const renderSelect = (
    items: { label: string; value: string }[],
    onSelect: (item: { value: string }) => void,
    initialIndex = 0,
  ) => (
    <Box marginTop={1} height={10} flexDirection="column" overflowY="hidden">
      <SelectInput
        items={items}
        onSelect={onSelect}
        limit={8}
        initialIndex={initialIndex}
        indicatorComponent={() => null}
        itemComponent={({ isSelected, label }) => (
          <Text color={isSelected ? colors.accent : undefined}>
            {isSelected ? "❯ " : "  "}
            {label}
          </Text>
        )}
      />
    </Box>
  );

  return (
    <BorderBox title="Database Backups">
      <Box flexDirection="column" marginY={1}>
        <Text>Configure periodic Supabase Postgres backups.</Text>
        <Text color="gray" dimColor>
          Logical pg_dump backups are written to the shared object storage bucket
          under the db-backups/ prefix. Restore any time with `rulebricks restore{" "}
          {state.name}`.
        </Text>
      </Box>

      {field === "enabled" && (
        <Box flexDirection="column" marginY={1}>
          <Text color={colors.accent}>
            {enabled ? "[x]" : "[ ]"} Enable database backups
          </Text>
          <Text color={colors.muted}>
            Space toggles backups. Enter continues.
          </Text>
        </Box>
      )}

      {field === "frequency" && (
        <Box flexDirection="column" marginY={1}>
          <Text>Backup frequency</Text>
          <Text color="gray" dimColor>
            How often a backup is taken (UTC cron).
          </Text>
          {renderSelect(
            FREQUENCY_PRESETS,
            handleFrequencySelect,
            Math.max(
              0,
              FREQUENCY_PRESETS.findIndex((p) => p.value === schedule),
            ),
          )}
        </Box>
      )}

      {field === "frequency-custom" && (
        <Box flexDirection="column" marginY={1}>
          <Text>Custom cron schedule</Text>
          <Text color="gray" dimColor>
            Standard cron format (UTC).
          </Text>
          <Box marginTop={1}>
            <TextInput
              value={schedule}
              onChange={setSchedule}
              onSubmit={handleFrequencyCustomSubmit}
              placeholder="0 2 * * *"
            />
          </Box>
        </Box>
      )}

      {field === "retention" && (
        <Box flexDirection="column" marginY={1}>
          <Text>Retention days</Text>
          <Text color="gray" dimColor>
            Backups older than this are pruned from object storage (must be
            greater than 1).
          </Text>
          <Box marginTop={1}>
            <TextInput
              value={retentionDays}
              onChange={setRetentionDays}
              onSubmit={handleRetentionSubmit}
              placeholder="7"
            />
          </Box>
        </Box>
      )}

      {field === "done" && (
        <Box flexDirection="column" marginY={1}>
          <Text color={colors.success}>Database backups configured.</Text>
          <Text>
            Frequency:{" "}
            {FREQUENCY_PRESETS.find((p) => p.value === schedule)?.label ||
              schedule}
          </Text>
          <Text>Retention: {retentionDays} days</Text>
          <Text color={colors.muted}>Press Enter to continue</Text>
        </Box>
      )}

      {error && (
        <Box marginTop={1}>
          <Text color={colors.error}>✗ {error}</Text>
        </Box>
      )}

      <Box marginTop={1}>
        <Text color="gray" dimColor>
          Esc to go back
        </Text>
      </Box>
    </BorderBox>
  );
}
