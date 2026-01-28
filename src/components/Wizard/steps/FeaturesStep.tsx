import React, { useState } from 'react';
import { Box, Text, useInput } from 'ink';
import { useWizard } from '../WizardContext.js';
import { BorderBox, useTheme } from '../../common/index.js';
import { LOGGING_SINK_INFO, LoggingSink } from '../../../types/index.js';

interface FeaturesStepProps {
  onComplete: () => void;
  onBack: () => void;
}

interface Feature {
  id: string;
  label: string;
  description: string;
  requiresConfig: boolean;
}

// Five features: AI, SSO, Monitoring, External Logging, Custom Emails
// External DNS is handled in Domain step, not here
const FEATURES: Feature[] = [
  {
    id: 'ai',
    label: 'AI Features',
    description: 'Enable AI-powered rule generation (requires OpenAI API key)',
    requiresConfig: true
  },
  {
    id: 'sso',
    label: 'Single Sign-On',
    description: 'Enable SSO via OIDC provider (Azure AD, Google, Okta, etc.)',
    requiresConfig: true
  },
  {
    id: 'monitoring',
    label: 'Monitoring',
    description: 'Enable Prometheus metrics collection. Optionally send to external system.',
    requiresConfig: true
  },
  {
    id: 'logging',
    label: 'External Logging',
    description: 'Forward logs to cloud storage or logging platforms (Datadog, Splunk, etc.)',
    requiresConfig: true
  },
  {
    id: 'customEmails',
    label: 'Custom Email Templates',
    description: 'Use custom HTML templates for Supabase auth emails (invite, confirm, reset, etc.)',
    requiresConfig: true
  }
];

export function FeaturesStep({ onComplete, onBack }: FeaturesStepProps) {
  const { state, dispatch } = useWizard();
  const { colors } = useTheme();
  const [currentIndex, setCurrentIndex] = useState(0);
  
  const enabledFeatures = {
    ai: state.aiEnabled,
    sso: state.ssoEnabled,
    monitoring: state.monitoringEnabled,
    logging: state.loggingSink !== 'console', // External logging is "enabled" if not console-only (includes 'pending')
    customEmails: state.customEmailsEnabled
  };
  
  useInput((input, key) => {
    if (key.escape) {
      onBack();
      return;
    }
    
    if (key.upArrow) {
      setCurrentIndex(i => Math.max(0, i - 1));
    } else if (key.downArrow) {
      setCurrentIndex(i => Math.min(FEATURES.length, i + 1));
    } else if (input === ' ' || input === 'x') {
      if (currentIndex < FEATURES.length) {
        const feature = FEATURES[currentIndex];
        toggleFeature(feature.id);
      }
    } else if (key.return) {
      if (currentIndex === FEATURES.length) {
        // "Continue" button
        onComplete();
      } else {
        // Toggle the feature on Enter too
        const feature = FEATURES[currentIndex];
        toggleFeature(feature.id);
      }
    }
  });
  
  const toggleFeature = (id: string) => {
    switch (id) {
      case 'ai':
        dispatch({ type: 'SET_AI_ENABLED', enabled: !state.aiEnabled });
        break;
      case 'sso':
        dispatch({ type: 'SET_SSO_ENABLED', enabled: !state.ssoEnabled });
        break;
      case 'monitoring':
        dispatch({ type: 'SET_MONITORING', enabled: !state.monitoringEnabled });
        break;
      case 'logging':
        // Toggle between console-only and needing to pick a sink
        // If currently console, mark as pending - FeatureConfigStep will handle sink selection
        if (state.loggingSink === 'console') {
          dispatch({ type: 'SET_LOGGING_SINK', sink: 'pending' });
        } else {
          dispatch({ type: 'SET_LOGGING_SINK', sink: 'console' });
        }
        break;
      case 'customEmails':
        dispatch({ type: 'SET_CUSTOM_EMAILS_ENABLED', enabled: !state.customEmailsEnabled });
        break;
    }
  };
  
  // Get current logging sink description
  const getLoggingStatusText = () => {
    if (state.loggingSink === 'console') {
      return 'Console only (default)';
    }
    return LOGGING_SINK_INFO[state.loggingSink]?.name || state.loggingSink;
  };
  
  return (
    <BorderBox title="Optional Features">
      <Box flexDirection="column" marginY={1}>
        <Text>Select features to enable:</Text>
        <Text color="gray" dimColor>
          Use arrows to navigate, space/enter to toggle
        </Text>
      </Box>
      
      <Box flexDirection="column" marginY={1}>
        {FEATURES.map((feature, index) => {
          const isSelected = index === currentIndex;
          const isEnabled = enabledFeatures[feature.id as keyof typeof enabledFeatures];
          
          return (
            <Box key={feature.id} flexDirection="column" marginBottom={isSelected ? 1 : 0}>
              <Box>
                <Text color={isSelected ? colors.accent : undefined}>
                  {isSelected ? '❯ ' : '  '}
                </Text>
                <Text color={isEnabled ? colors.success : colors.muted}>
                  {isEnabled ? '[✓]' : '[ ]'}
                </Text>
                <Text color={isSelected ? colors.accent : undefined}>
                  {' '}{feature.label}
                </Text>
                {feature.id === 'logging' && state.loggingSink !== 'console' && state.loggingSink !== 'pending' && (
                  <Text color={colors.accent}> → {getLoggingStatusText()}</Text>
                )}
              </Box>
              {isSelected && (
                <Box marginLeft={6}>
                  <Text color="gray" dimColor>{feature.description}</Text>
                </Box>
              )}
            </Box>
          );
        })}
        
        <Box marginTop={1}>
          <Text color={currentIndex === FEATURES.length ? colors.accent : colors.muted}>
            {currentIndex === FEATURES.length ? '❯ ' : '  '}
          </Text>
          <Text color={currentIndex === FEATURES.length ? colors.success : colors.muted} bold={currentIndex === FEATURES.length}>
            [Continue →]
          </Text>
        </Box>
      </Box>
      
      <Box marginTop={1} flexDirection="column">
        <Text color="gray" dimColor>
          Space/Enter to toggle • ↑/↓ to navigate • Esc to go back
        </Text>
        {(state.aiEnabled || state.ssoEnabled || state.monitoringEnabled || state.loggingSink !== 'console') && (
          <Text color="yellow" dimColor>
            Note: Enabled features will be configured in the next step
          </Text>
        )}
      </Box>
    </BorderBox>
  );
}
