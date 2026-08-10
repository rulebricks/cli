import React, { useState } from "react";
import { Box, Text } from "ink";
import {
  BorderBox,
  StepFooter,
  useGatedInput,
  useTheme,
} from "../common/index.js";
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
  onSave: () => void;
  onSaveAndApply: () => void;
  /** Called on Esc; nothing has been saved at that point. */
  onExit: () => void;
}

/**
 * Entry screen for the configure command: pick a config section to update,
 * return here after each edit, then save, apply, or review. Modeled on
 * CheckboxList's cursor-driven list so edited markers and per-item descriptions
 * render with full styling control.
 */
export function SectionMenu({
  sections,
  onSelect,
  onReview,
  onSave,
  onSaveAndApply,
  onExit,
}: SectionMenuProps) {
  const { colors } = useTheme();
  const [cursor, setCursor] = useState(0);
  const reviewIndex = sections.length;

  useGatedInput((input, key) => {
    const command = input.toLowerCase();
    if (command === "s") {
      onSave();
    } else if (command === "a") {
      onSaveAndApply();
    } else if (command === "r") {
      onReview();
    } else if (key.upArrow) {
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
    <BorderBox
      title="Update Configuration"
      footer={
        <StepFooter
          hints={[
            "↑/↓ to navigate",
            "Enter to select",
            "S save & exit",
            "A save & deploy",
            "Esc discard",
          ]}
        />
      }
    >
      <Box flexDirection="column" marginY={1}>
        <Text bold>What would you like to update?</Text>
        <Text color="gray" dimColor>
          Nothing is saved until you choose a save action.
        </Text>
        <Box marginTop={1}>
          <Text color={colors.success} bold>
            S Save & exit
          </Text>
          <Text color={colors.muted}> • </Text>
          <Text color={colors.accent} bold>
            A Save & deploy
          </Text>
          <Text color={colors.muted}> • R Review</Text>
        </Box>

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
      </Box>
    </BorderBox>
  );
}
