import React, { ReactNode } from "react";
import { Box, Text } from "ink";
import { useTheme } from "../../lib/theme.js";
import { computeLayout } from "../../lib/layout.js";
import { StepLayoutContext, useStepLayout, useViewport } from "./layout.js";
import { LOGO_LINES } from "./Logo.js";

interface WizardShellProps {
  title: string;
  /** Rendered in a fixed-height slot between the frame top and the step. */
  header?: ReactNode;
  children: ReactNode;
}

/**
 * Full-screen wizard chrome with a constant footprint: logo, titled frame,
 * header slot, and a fixed-height step area. The layout is derived from the
 * terminal size (recomputed live on resize) and never exceeds it, so the
 * logo and frame stay put no matter what each step renders.
 */
export function WizardShell({ title, header, children }: WizardShellProps) {
  const { colors } = useTheme();
  const { rows, columns } = useViewport();
  const layout = computeLayout(rows, columns);

  if (layout.tooSmall) {
    return (
      <Box flexDirection="column" paddingLeft={1} paddingTop={1}>
        <Text color={colors.warning} bold>
          Terminal window is too small
        </Text>
        <Text color={colors.muted}>
          Resize to at least 60×20 — the wizard adapts automatically.
        </Text>
      </Box>
    );
  }

  const topBorder = `╭─ ${title} ${"─".repeat(
    Math.max(0, layout.frameWidth - title.length - 5),
  )}╮`;
  const bottomBorder = `╰${"─".repeat(Math.max(0, layout.frameWidth - 2))}╯`;

  return (
    <StepLayoutContext.Provider value={{ ...layout, frameClaimed: false }}>
      <Box flexDirection="column" paddingLeft={2}>
        {layout.showLogo && (
          <Box flexDirection="column" marginTop={1} marginBottom={1}>
            {LOGO_LINES.map((line, i) => (
              <Text key={i} color={colors.accent}>
                {line}
              </Text>
            ))}
          </Box>
        )}

        <Text color={colors.accent}>{topBorder}</Text>
        <Box flexDirection="column" paddingX={2} paddingY={1}>
          <Box
            flexDirection="column"
            height={layout.headerRows}
            overflowY="hidden"
          >
            {header}
          </Box>
          <Box
            flexDirection="column"
            height={layout.stepBoxHeight}
            overflowY="hidden"
          >
            {children}
          </Box>
        </Box>
        <Text color={colors.accent}>{bottomBorder}</Text>
      </Box>
    </StepLayoutContext.Provider>
  );
}

interface ProgressHeaderProps {
  currentStep: number;
  totalSteps: number;
  stepTitle: string;
}

/**
 * Progress header showing step number and progress bar. The bar row is
 * dropped on short terminals (driven by the wizard layout).
 */
export function ProgressHeader({
  currentStep,
  totalSteps,
  stepTitle,
}: ProgressHeaderProps) {
  const { colors } = useTheme();
  const layout = useStepLayout();
  const showBar = layout?.showProgressBar ?? true;
  const percentage = Math.round((currentStep / totalSteps) * 100);
  const barWidth = 30;
  const filled = Math.round((percentage / 100) * barWidth);
  const empty = barWidth - filled;

  return (
    <Box flexDirection="column" marginBottom={1}>
      <Text color={colors.muted}>
        Step {currentStep} of {totalSteps}:{" "}
        <Text color="white">{stepTitle}</Text>
      </Text>
      {showBar && (
        <Box marginTop={1}>
          <Text color={colors.accent}>[</Text>
          <Text color={colors.success}>{"█".repeat(filled)}</Text>
          <Text color={colors.muted}>{"░".repeat(empty)}</Text>
          <Text color={colors.accent}>]</Text>
          <Text color={colors.muted}> {percentage}%</Text>
        </Box>
      )}
    </Box>
  );
}
