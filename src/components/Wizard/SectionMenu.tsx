import React, { useState } from "react";
import { Box, Text } from "ink";
import {
  BorderBox,
  StepFooter,
  useGatedInput,
  useStepLayout,
  useTheme,
} from "../common/index.js";
import {
  computeListWindow,
  computeSectionMenuLayout,
  type SectionMenuLayout,
} from "../../lib/layout.js";
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

/** Everything visible: used outside the wizard shell's fixed frame. */
const UNCONSTRAINED_LAYOUT: SectionMenuLayout = {
  windowSize: Number.MAX_SAFE_INTEGER,
  showSubtitle: true,
  showActions: true,
  showReviewMargin: true,
  showDescription: true,
};

/**
 * Entry screen for the configure command: pick a config section to update,
 * return here after each edit, then save, apply, or review. Modeled on
 * CheckboxList's cursor-driven list so edited markers and per-item descriptions
 * render with full styling control. The section list is windowed to the fixed
 * step-box height (computeSectionMenuLayout) so no entry can clip off-screen;
 * "N more" markers flag hidden rows and the review action stays pinned.
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
  const stepLayout = useStepLayout();
  const [cursor, setCursor] = useState(0);
  const reviewIndex = sections.length;

  const menu = stepLayout
    ? computeSectionMenuLayout(stepLayout.stepBoxHeight, sections.length)
    : UNCONSTRAINED_LAYOUT;
  const windowed = menu.windowSize < sections.length;
  // When the cursor sits on the pinned review row, keep the window anchored
  // to the end of the list.
  const anchor = Math.min(cursor, reviewIndex - 1);
  const { start, hiddenAbove, hiddenBelow } = computeListWindow(
    anchor,
    sections.length,
    menu.windowSize,
  );
  const visibleSections = sections.slice(start, start + menu.windowSize);

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

  // Keep the hints to a single line: navigation keys while the colored
  // actions row advertises S/A, the save keys once that row is shed.
  const hints = menu.showActions
    ? ["↑/↓ to navigate", "Enter to select", "Esc discard"]
    : ["S save & exit", "A save & deploy", "Esc discard"];

  return (
    <BorderBox
      title="Update Configuration"
      footer={
        // The review action, description, and hints live in the pinned footer
        // so an unexpected text wrap can only ever clip list rows, never the
        // actions.
        <Box flexDirection="column">
          <Box marginTop={menu.showReviewMargin ? 1 : 0}>
            <Text
              color={cursor === reviewIndex ? colors.success : colors.muted}
              bold={cursor === reviewIndex}
            >
              {cursor === reviewIndex ? "❯ " : "  "}
              {"Review & save changes"}
            </Text>
          </Box>
          {menu.showDescription && highlightedDescription && (
            <Box marginTop={1}>
              <Text color="gray" dimColor>
                {highlightedDescription}
              </Text>
            </Box>
          )}
          <StepFooter hints={hints} />
        </Box>
      }
    >
      <Box flexDirection="column" marginTop={1}>
        <Text bold>What would you like to update?</Text>
        {menu.showSubtitle && (
          <Text color="gray" dimColor>
            Nothing is saved until you choose a save action.
          </Text>
        )}
        {menu.showActions && (
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
        )}

        <Box marginTop={1} flexDirection="column">
          {windowed && (
            <Text color="gray" dimColor>
              {hiddenAbove > 0 ? `  ↑ ${hiddenAbove} more` : " "}
            </Text>
          )}
          {visibleSections.map((section, offset) => {
            const index = start + offset;
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
          {windowed && (
            <Text color="gray" dimColor>
              {hiddenBelow > 0 ? `  ↓ ${hiddenBelow} more` : " "}
            </Text>
          )}
        </Box>
      </Box>
    </BorderBox>
  );
}
