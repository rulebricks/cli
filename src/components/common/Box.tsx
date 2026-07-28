import React from "react";
import { Box as InkBox, Text } from "ink";
import { useTheme } from "../../lib/theme.js";
import { StepLayoutContext, useStepLayout } from "./layout.js";

interface BorderBoxProps {
  title?: string;
  children: React.ReactNode;
  width?: number;
  borderColor?: string;
  /** Pinned to the bottom edge of the box when inside the WizardShell. */
  footer?: React.ReactNode;
}

export function BorderBox({
  title,
  children,
  width,
  borderColor,
  footer,
}: BorderBoxProps) {
  const { colors } = useTheme();
  const layout = useStepLayout();
  // Inside the WizardShell the outermost BorderBox stretches to the fixed
  // step-box size so the frame never changes height between steps or fields.
  // Nested BorderBoxes (and usage outside the wizard) keep natural sizing.
  const managed = layout !== null && !layout.frameClaimed;
  const resolvedWidth = width ?? (managed ? layout.stepBoxWidth : 60);
  const actualBorderColor = borderColor || colors.accent;
  const horizontalBorder = "─".repeat(Math.max(0, resolvedWidth - 1));

  const body = managed ? (
    <StepLayoutContext.Provider value={{ ...layout, frameClaimed: true }}>
      <InkBox
        flexDirection="column"
        paddingX={1}
        height={layout.stepBoxHeight - 2}
        overflowY="hidden"
      >
        <InkBox
          flexDirection="column"
          flexGrow={1}
          flexBasis={0}
          overflowY="hidden"
        >
          {/* flexShrink=0 keeps content at natural height so any overflow is
              clipped cleanly at the bottom instead of yoga shrinking children
              into each other. */}
          <InkBox flexDirection="column" flexShrink={0}>
            {children}
          </InkBox>
        </InkBox>
        {footer != null && (
          <InkBox flexDirection="column" flexShrink={0}>
            {footer}
          </InkBox>
        )}
      </InkBox>
    </StepLayoutContext.Provider>
  ) : (
    <InkBox flexDirection="column" paddingX={1}>
      {children}
      {footer}
    </InkBox>
  );

  return (
    <InkBox flexDirection="column">
      <Text color={actualBorderColor}>
        ┌{title ? `─ ${title} ` : ""}
        {"─".repeat(Math.max(0, resolvedWidth - 4 - (title?.length || 0)))}┐
      </Text>
      {body}
      <Text color={actualBorderColor}>└{horizontalBorder}┘</Text>
    </InkBox>
  );
}

interface SectionProps {
  title: string;
  children: React.ReactNode;
}

export function Section({ title, children }: SectionProps) {
  const { colors } = useTheme();

  return (
    <InkBox flexDirection="column" marginY={1}>
      <Text bold color={colors.accent}>
        {title}
      </Text>
      <InkBox flexDirection="column" marginLeft={2}>
        {children}
      </InkBox>
    </InkBox>
  );
}

interface ProgressBarProps {
  current: number;
  total: number;
  width?: number;
}

export function ProgressBar({ current, total, width = 30 }: ProgressBarProps) {
  const { colors } = useTheme();
  const percentage = Math.min(100, Math.round((current / total) * 100));
  const filled = Math.round((percentage / 100) * width);
  const empty = width - filled;

  return (
    <InkBox>
      <Text color={colors.accent}>[</Text>
      <Text color={colors.success}>{"█".repeat(filled)}</Text>
      <Text color={colors.muted}>{"░".repeat(empty)}</Text>
      <Text color={colors.accent}>]</Text>
      <Text> {percentage}%</Text>
    </InkBox>
  );
}
