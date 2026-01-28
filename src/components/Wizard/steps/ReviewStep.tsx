import React, { useState } from 'react';
import { Box, Text, useInput } from 'ink';
import TextInput from 'ink-text-input';
import { useWizard } from '../WizardContext.js';
import { BorderBox, useTheme } from '../../common/index.js';
import { TIER_CONFIGS, DNS_PROVIDER_NAMES, LOGGING_SINK_INFO, isSupportedDnsProvider } from '../../../types/index.js';

interface ReviewStepProps {
  onComplete: () => void;
  onBack: () => void;
}

export function ReviewStep({ onComplete, onBack }: ReviewStepProps) {
  const { state, dispatch } = useWizard();
  const { colors } = useTheme();
  const [editingName, setEditingName] = useState(!state.name);
  const [name, setName] = useState(state.name || '');
  const [error, setError] = useState<string | null>(null);
  
  useInput((input, key) => {
    if (editingName) return;
    
    if (key.escape) {
      onBack();
    } else if (key.return) {
      if (state.name) {
        onComplete();
      }
    } else if (input === 'e') {
      setEditingName(true);
    }
  });
  
  const handleNameSubmit = () => {
    if (!name) {
      setError('Name is required');
      return;
    }
    if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/.test(name)) {
      setError('Name must be lowercase letters, numbers, and hyphens');
      return;
    }
    if (name.length > 63) {
      setError('Name must be 63 characters or less');
      return;
    }
    setError(null);
    dispatch({ type: 'SET_NAME', name });
    setEditingName(false);
  };
  
  const tierConfig = state.tier ? TIER_CONFIGS[state.tier] : null;
  const externalDnsEnabled = state.dnsAutoManage && isSupportedDnsProvider(state.dnsProvider);
  
  if (editingName) {
    return (
      <BorderBox title="Deployment Name">
        <Box flexDirection="column" marginY={1}>
          <Text>Enter a name for this deployment:</Text>
          <Text color="gray" dimColor>
            Lowercase letters, numbers, and hyphens only
          </Text>
          <Box marginTop={1}>
            <TextInput
              value={name}
              onChange={setName}
              onSubmit={handleNameSubmit}
              placeholder="my-deployment"
            />
          </Box>
          {error && (
            <Box marginTop={1}>
              <Text color="red">✗ {error}</Text>
            </Box>
          )}
        </Box>
      </BorderBox>
    );
  }
  
  // Helper to render a config row
  const ConfigRow = ({ label, value, valueColor }: { label: string; value: string; valueColor?: string }) => (
    <Box>
      <Box width={16}>
        <Text color={colors.muted}>{label}</Text>
      </Box>
      <Text color={valueColor || colors.accent}>{value}</Text>
    </Box>
  );
  
  // Helper to render a section header
  const SectionHeader = ({ title }: { title: string }) => (
    <Box marginTop={1}>
      <Text bold color={colors.accent}>── {title} ──</Text>
    </Box>
  );
  
  return (
    <BorderBox title="Review Configuration">
      <Box flexDirection="column">
        <SectionHeader title="Deployment" />
        <ConfigRow label="Name" value={state.name} />
        {state.appVersion && (
          <ConfigRow label="App Version" value={state.appVersion} />
        )}
        
        <SectionHeader title="Infrastructure" />
        <ConfigRow 
          label="Mode" 
          value={state.infrastructureMode === 'provision' ? 'Provision new cluster' : 'Use existing cluster'} 
        />
        {state.provider && (
          <ConfigRow label="Provider" value={state.provider.toUpperCase()} />
        )}
        {state.region && (
          <ConfigRow label="Region" value={state.region} />
        )}
        
        <SectionHeader title="Domain & DNS" />
        <ConfigRow label="Domain" value={state.domain} />
        <ConfigRow label="Admin Email" value={state.adminEmail} />
        <ConfigRow label="TLS Email" value={state.tlsEmail} />
        <Box>
          <Box width={16}>
            <Text color={colors.muted}>DNS</Text>
          </Box>
          <Text color={colors.accent}>{DNS_PROVIDER_NAMES[state.dnsProvider]}</Text>
          {externalDnsEnabled && <Text color={colors.success}> (auto)</Text>}
        </Box>
        
        <SectionHeader title="SMTP" />
        <ConfigRow label="Host" value={`${state.smtpHost}:${state.smtpPort}`} />
        <ConfigRow label="From" value={`${state.smtpFromName} <${state.smtpFrom}>`} />
        
        <SectionHeader title="Database" />
        <ConfigRow 
          label="Type" 
          value={state.databaseType === 'supabase-cloud' ? 'Supabase Cloud' : 'Self-hosted'} 
        />
        
        <SectionHeader title="Performance" />
        <Box>
          <Box width={16}>
            <Text color={colors.muted}>Tier</Text>
          </Box>
          <Text color={colors.accent} bold>
            {state.tier?.charAt(0).toUpperCase()}{state.tier?.slice(1)}
          </Text>
          {tierConfig && <Text color={colors.muted}> ({tierConfig.throughput})</Text>}
        </Box>
        
        <SectionHeader title="Features" />
        <Box>
          <Text color={state.aiEnabled ? colors.success : colors.muted}>
            {state.aiEnabled ? '✓' : '○'} AI
          </Text>
          <Text>  </Text>
          <Text color={state.ssoEnabled ? colors.success : colors.muted}>
            {state.ssoEnabled ? '✓' : '○'} SSO
          </Text>
          <Text>  </Text>
          <Text color={state.monitoringEnabled ? colors.success : colors.muted}>
            {state.monitoringEnabled ? '✓' : '○'} Monitoring
          </Text>
          <Text>  </Text>
          <Text color={state.loggingSink !== 'console' ? colors.success : colors.muted}>
            {state.loggingSink !== 'console' ? '✓' : '○'} Logging
          </Text>
        </Box>
        
        <SectionHeader title="License" />
        <ConfigRow label="Key" value={`${state.licenseKey?.substring(0, 12)}...`} />
      </Box>
      
      <Box marginTop={1} flexDirection="column">
        <Text color={colors.success} bold>
          Press Enter to save this configuration
        </Text>
        <Text color={colors.muted} dimColor>
          e to edit name • Esc to go back
        </Text>
      </Box>
    </BorderBox>
  );
}
