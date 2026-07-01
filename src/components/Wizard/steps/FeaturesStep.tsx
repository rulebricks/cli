import React, { useState } from 'react';
import { Box, Text, useInput } from 'ink';
import { useWizard } from '../WizardContext.js';
import { BorderBox, useTheme } from '../../common/index.js';

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

// Features: AI, SSO, External Logging, Custom Emails
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
    id: 'valkeyObservability',
    label: 'Valkey Admin + Cache Metrics',
    description: 'Deploy the official Apache-2.0 Valkey Admin console (internal by default, optionally public via Traefik BasicAuth) and export Valkey/Kafka lag metrics to Prometheus.',
    requiresConfig: false
  },
  // NOTE: Forwarding a copy of decision logs to a third-party platform
  // (Datadog, Splunk, Elasticsearch, Loki, New Relic, Axiom) is no longer
  // offered in the wizard - it was confusing alongside the always-on
  // decision-log archive to object storage. The capability still exists for
  // config-file/redeploy users (features.logging.sink + generateVectorSinks).
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
    valkeyObservability: state.valkeyAdminEnabled,
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
      case 'valkeyObservability': {
        const enabled = !state.valkeyAdminEnabled;
        dispatch({
          type: 'SET_EXTERNAL_SERVICES',
          config: {
            valkeyAdminEnabled: enabled,
            redisExporterEnabled: enabled,
            kafkaExporterEnabled: enabled,
            valkeyAdminExposure: enabled ? 'ingress' : 'internal',
            valkeyAdminHostname: '',
            ...(enabled ? {} : { valkeyAdminBasicAuthUsers: [], valkeyAdminAllowedIPs: [] })
          }
        });
        break;
      }
      case 'customEmails':
        dispatch({ type: 'SET_CUSTOM_EMAILS_ENABLED', enabled: !state.customEmailsEnabled });
        break;
    }
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
        {(state.aiEnabled ||
          state.ssoEnabled ||
          state.valkeyAdminEnabled ||
          state.loggingSink !== 'console' ||
          state.customEmailsEnabled) && (
          <Text color="yellow" dimColor>
            Note: Enabled features will be configured in the next step
          </Text>
        )}
      </Box>
    </BorderBox>
  );
}
