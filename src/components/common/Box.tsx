import React from "react";
import { Box as InkBox, Text } from "ink";
import { useTheme } from "../../lib/theme.js";

interface BorderBoxProps {
  title?: string;
  children: React.ReactNode;
  width?: number;
  borderColor?: string;
}

export function BorderBox({
  title,
  children,
  width = 60,
  borderColor,
}: BorderBoxProps) {
  const { colors } = useTheme();
  const actualBorderColor = borderColor || colors.accent;
  const horizontalBorder = "─".repeat(width - 1);

  return (
    <InkBox flexDirection="column">
      <Text color={actualBorderColor}>
        ┌{title ? `─ ${title} ` : ""}
        {"─".repeat(width - 4 - (title?.length || 0))}┐
      </Text>
      <InkBox flexDirection="column" paddingX={1}>
        {children}
      </InkBox>
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
