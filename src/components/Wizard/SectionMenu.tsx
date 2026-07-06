import React, { useState } from "react";
import { Box, Text } from "ink";
import { BorderBox, useGatedInput, useTheme } from "../common/index.js";
import type { WizardStepId } from "../../lib/wizardSteps.js";

export interface SectionMenuItem {
  id: WizardStepId;
  title: string;
  description: string;
  /** Whether the user has walked through this section in this session. */
  edited: boolean;
}

interface SectionMenuProps {
  sections: SectionMenuItem[];
  onSelect: (id: WizardStepId) => void;
  onReview: () => void;
  /** Called on Esc; nothing has been saved at that point. */
  onExit: () => void;
}

/**
 * Entry screen for the configure command: pick a config section to update,
 * return here after each edit, then review & save when done. Modeled on
 * CheckboxList's cursor-driven list so the edited markers and per-item
 * descriptions render with full styling control.
 */
export function SectionMenu({
  sections,
  onSelect,
  onReview,
  onExit,
}: SectionMenuProps) {
  const { colors } = useTheme();
  const [cursor, setCursor] = useState(0);
  const reviewIndex = sections.length;

  useGatedInput((_input, key) => {
    if (key.upArrow) {
      setCursor((i) => Math.max(0, i - 1));
    } else if (key.downArrow) {
      setCursor((i) => Math.min(reviewIndex, i + 1));
    } else if (key.return) {
      if (cursor === reviewIndex) onReview();
      else onSelect(sections[cursor].id);
    } else if (key.escape) {
      onExit();
    }
  });

  const highlightedDescription =
    cursor === reviewIndex
      ? "Review the full configuration and save your changes"
      : sections[cursor]?.description;

  return (
    <BorderBox title="Update Configuration">
      <Box flexDirection="column" marginY={1}>
        <Text bold>What would you like to update?</Text>
        <Text color="gray" dimColor>
          Nothing is saved until you review and confirm.
        </Text>

        <Box marginTop={1} flexDirection="column">
          {sections.map((section, index) => {
            const selected = index === cursor;
            return (
              <Box key={section.id}>
                <Text color={selected ? colors.accent : undefined}>
                  {selected ? "❯ " : "  "}
                  {section.title}
                </Text>
                {section.edited && (
                  <Text color={colors.success}> ✓ updated</Text>
                )}
              </Box>
            );
          })}

          <Box marginTop={1}>
            <Text
              color={cursor === reviewIndex ? colors.success : colors.muted}
              bold={cursor === reviewIndex}
            >
              {cursor === reviewIndex ? "❯ " : "  "}
              {"Review & save changes"}
            </Text>
          </Box>
        </Box>

        {highlightedDescription && (
          <Box marginTop={1}>
            <Text color="gray" dimColor>
              {highlightedDescription}
            </Text>
          </Box>
        )}

        <Box marginTop={1}>
          <Text color="gray" dimColor>
            ↑/↓ to navigate • Enter to select • Esc to exit without saving
          </Text>
        </Box>
      </Box>
    </BorderBox>
  );
}
