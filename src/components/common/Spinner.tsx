import React from 'react';
import { Box, Text } from 'ink';
import InkSpinner from 'ink-spinner';
import { useTheme } from '../../lib/theme.js';

interface SpinnerProps {
  label: string;
  color?: string;
}

export function Spinner({ label, color }: SpinnerProps) {
  const { colors } = useTheme();
  const spinnerColor = color || colors.accent;
  
  return (
    <Box>
      <Text color={spinnerColor}>
        <InkSpinner type="dots" />
      </Text>
      <Text> {label}</Text>
    </Box>
  );
}

interface StatusLineProps {
  status: 'pending' | 'running' | 'success' | 'error' | 'skipped';
  label: string;
  detail?: string;
}

export function StatusLine({ status, label, detail }: StatusLineProps) {
  const { colors } = useTheme();
  
  const getStatusConfig = () => {
    switch (status) {
      case 'pending':
        return { icon: '○', color: colors.muted };
      case 'running':
        return { icon: '◐', color: colors.accent };
      case 'success':
        return { icon: '✓', color: colors.success };
      case 'error':
        return { icon: '✗', color: colors.error };
      case 'skipped':
        return { icon: '⊘', color: colors.warning };
    }
  };
  
  const { icon, color } = getStatusConfig();
  
  return (
    <Box>
      <Text color={color}>{icon}</Text>
      <Text> {label}</Text>
      {detail && <Text color={colors.muted}> - {detail}</Text>}
    </Box>
  );
}
