import React from "react";
import { Box, Text, useInput } from "ink";
import SelectInput from "ink-select-input";

interface DeploymentPickerProps {
  deployments: string[];
  /** Verb phrase shown in the prompt, e.g. "deploy" or "view logs for". */
  action?: string;
  onSelect: (name: string) => void;
  onCancel: () => void;
}

/**
 * Interactive deployment selector shown when a command is run without a
 * deployment name and more than one deployment exists. Kept standalone (no
 * ThemeProvider) so it can render before a command's own Ink tree mounts.
 */
export function DeploymentPicker({
  deployments,
  action,
  onSelect,
  onCancel,
}: DeploymentPickerProps) {
  useInput((input, key) => {
    if (key.escape) {
      onCancel();
    }
  });

  return (
    <Box flexDirection="column" marginY={1}>
      <Text bold>
        Select a deployment{action ? ` to ${action}` : ""}:
      </Text>
      <Box marginTop={1} flexDirection="column">
        <SelectInput
          items={deployments.map((d) => ({ label: d, value: d }))}
          onSelect={(item) => onSelect(item.value)}
          limit={10}
          indicatorComponent={() => null}
          itemComponent={({ isSelected, label }) => (
            <Text color={isSelected ? "cyan" : undefined}>
              {isSelected ? "❯ " : "  "}
              {label}
            </Text>
          )}
        />
      </Box>
      <Box marginTop={1}>
        <Text color="gray" dimColor>
          ↑/↓ to navigate • Enter to select • Esc to cancel
        </Text>
      </Box>
    </Box>
  );
}
