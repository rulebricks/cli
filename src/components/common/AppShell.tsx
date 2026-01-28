import React, { ReactNode } from "react";
import { Box, Text } from "ink";
import { useTheme } from "../../lib/theme.js";

interface AppShellProps {
  children: ReactNode;
  title?: string;
  subtitle?: string;
  width?: number;
}

/**
 * AppShell wraps the entire application content with consistent margins,
 * padding, and a border container for a focused visual experience.
 */
export function AppShell({
  children,
  title,
  subtitle,
  width = 70,
}: AppShellProps) {
  const { colors } = useTheme();
  const horizontalBorder = "─".repeat(width - 2);

  return (
    <Box flexDirection="column" paddingTop={0} paddingLeft={2}>
      {/* Top border with title */}
      <Text color={colors.accent}>
        ╭{title ? `─ ${title} ` : ""}
        {"─".repeat(width - 4 - (title?.length || 0))}╮
      </Text>

      {/* Subtitle if provided */}
      {subtitle && (
        <Box paddingX={2}>
          <Text color={colors.muted}>{subtitle}</Text>
        </Box>
      )}

      {/* Content area */}
      <Box flexDirection="column" paddingX={2} paddingY={1}>
        {children}
      </Box>

      {/* Bottom border */}
      <Text color={colors.accent}>╰{horizontalBorder}╯</Text>
    </Box>
  );
}

interface ScreenContainerProps {
  children: ReactNode;
  title: string;
  width?: number;
}

/**
 * ScreenContainer is a simpler bordered container for individual screens/steps
 */
export function ScreenContainer({
  children,
  title,
  width = 66,
}: ScreenContainerProps) {
  const { colors } = useTheme();
  const innerWidth = width - 4;

  return (
    <Box flexDirection="column">
      {/* Header */}
      <Box>
        <Text color={colors.accent}>┌─ </Text>
        <Text bold color="white">
          {title}
        </Text>
        <Text color={colors.accent}>
          {" "}
          {"─".repeat(Math.max(0, innerWidth - title.length - 2))}┐
        </Text>
      </Box>

      {/* Content */}
      <Box flexDirection="column">
        <Box>
          <Text color={colors.accent}>│</Text>
          <Box flexDirection="column" paddingX={1} width={innerWidth}>
            {children}
          </Box>
          <Text color={colors.accent}>│</Text>
        </Box>
      </Box>

      {/* Footer */}
      <Text color={colors.accent}>└{"─".repeat(width - 1)}┘</Text>
    </Box>
  );
}

interface ProgressHeaderProps {
  currentStep: number;
  totalSteps: number;
  stepTitle: string;
}

/**
 * Progress header showing step number and progress bar
 */
export function ProgressHeader({
  currentStep,
  totalSteps,
  stepTitle,
}: ProgressHeaderProps) {
  const { colors } = useTheme();
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
      <Box marginTop={1}>
        <Text color={colors.accent}>[</Text>
        <Text color={colors.success}>{"█".repeat(filled)}</Text>
        <Text color={colors.muted}>{"░".repeat(empty)}</Text>
        <Text color={colors.accent}>]</Text>
        <Text color={colors.muted}> {percentage}%</Text>
      </Box>
    </Box>
  );
}
