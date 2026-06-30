import React, { useState } from 'react';
import { Box, Text, useInput } from 'ink';
import TextInput from 'ink-text-input';
import { useWizard } from '../WizardContext.js';
import { BorderBox, useTheme } from '../../common/index.js';
import { DNS_PROVIDER_NAMES, CLOUD_PROVIDER_NAMES, LOGGING_SINK_INFO, isSupportedDnsProvider, KafkaPreset } from '../../../types/index.js';

interface ReviewStepProps {
  onComplete: () => void;
  onBack: () => void;
  allowEditName?: boolean;
}

function kafkaPresetLabel(preset: KafkaPreset | null): string {
  switch (preset) {
    case 'aws-msk-iam':
      return 'AWS MSK IAM';
    case 'azure-event-hubs':
      return 'Azure Event Hubs';
    case 'gcp-managed':
      return 'GCP Managed Kafka';
    case 'custom':
      return 'custom';
    default:
      return 'not configured';
  }
}

export function ReviewStep({
  onComplete,
  onBack,
  allowEditName = true,
}: ReviewStepProps) {
  const { state, dispatch } = useWizard();
  const { colors } = useTheme();
  const [editingName, setEditingName] = useState(allowEditName && !state.name);
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
    } else if (allowEditName && input === 'e') {
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
  
  const externalDnsEnabled = state.dnsAutoManage && isSupportedDnsProvider(state.dnsProvider);
  const clusterCpuCores = state.eligibleCpuCores || Math.ceil(state.totalCpuCores);
  const clusterMemoryGi = state.eligibleMemoryGi || Math.ceil(state.totalMemoryGi);
  const storageValue = state.storageClass
    ? state.totalPersistentStorageGi > 0
      ? `${state.storageClass} (${Math.ceil(state.totalPersistentStorageGi)} Gi reported available)`
      : `${state.storageClass} (dynamic PVC provisioning)`
    : '';
  const monitoringDestination = state.clickStackEnabled
    ? 'Prometheus + in-cluster ClickStack metrics mirror'
    : state.metricsExportEnabled && state.prometheusRemoteWriteDestination
      ? `Remote write: ${state.prometheusRemoteWriteDestination}`
      : 'In-cluster Prometheus (no remote write)';
  const storageAuthValue =
    state.storageProvider === 's3'
      ? state.storageAwsIamRoleArn || 'not configured'
      : state.storageProvider === 'gcs'
        ? state.storageGcpServiceAccountEmail || 'not configured'
        : state.storageCloudAuthMode === 'secret'
          ? `secret: ${state.storageAzureBlobConnectionStringSecretRef || 'not configured'}`
          : state.storageAzureBlobClientId
            ? `workload identity (${state.storageAzureBlobClientId})`
            : 'workload identity';
  const clickStackStorageGi =
    Number.parseInt(state.clickHouseStorageSize || "0", 10) + 10;
  
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
        {state.version && (
          <ConfigRow label="Version" value={state.version} />
        )}
        
        <SectionHeader title="Infrastructure" />
        {state.provider && (
          <ConfigRow label="Provider" value={CLOUD_PROVIDER_NAMES[state.provider]} />
        )}
        {state.clusterName && (
          <ConfigRow label="Cluster" value={state.clusterName} />
        )}
        {state.region && (
          <ConfigRow label="Region" value={state.region} />
        )}
        {state.azureResourceGroup && (
          <ConfigRow label="Resource Group" value={state.azureResourceGroup} />
        )}
        {state.gcpProjectId && (
          <ConfigRow label="GCP Project" value={state.gcpProjectId} />
        )}
        
        <SectionHeader title="Domain & DNS" />
        <ConfigRow label="Domain" value={state.domain} />
        <ConfigRow label="Admin Email" value={state.adminEmail} />
        {state.tlsEmail && state.tlsEmail !== state.adminEmail && (
          <ConfigRow label="TLS Email" value={state.tlsEmail} />
        )}
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
        
        <SectionHeader title="Cluster" />
        {state.totalCpuCores > 0 && (
          <ConfigRow
            label="Capacity"
            value={`${state.schedulableNodeCount} nodes, ${clusterCpuCores} vCPU, ${clusterMemoryGi} Gi`}
          />
        )}
        {state.storageClass && (
          <ConfigRow label="Storage" value={storageValue} />
        )}
        {state.storageProvider && (
          <>
            <SectionHeader title="Object Storage" />
            <ConfigRow
              label="Bucket"
              value={`${state.storageProvider} / ${state.storageBucket || 'not configured'}`}
            />
            {state.storageRegion && (
              <ConfigRow label="Region" value={state.storageRegion} />
            )}
            {state.storageProvider === 'azure-blob' &&
              state.storageAzureBlobContainer && (
                <ConfigRow
                  label="Container"
                  value={state.storageAzureBlobContainer}
                />
              )}
            <ConfigRow label="Auth" value={storageAuthValue} />
            {state.backupEnabled && (
              <ConfigRow
                label="DB backups"
                value={`${state.storageBucket || 'not configured'} / db-backups/`}
              />
            )}
          </>
        )}
        {state.databaseType === 'self-hosted' && (
          <>
            <SectionHeader title="Backups" />
            <ConfigRow
              label="Database"
              value={
                state.backupEnabled
                  ? `${state.backupSchedule} / ${state.backupRetentionDays} days`
                  : 'Disabled'
              }
              valueColor={state.backupEnabled ? colors.success : colors.muted}
            />
          </>
        )}

        {(state.redisMode === 'external' || state.kafkaMode === 'external') && (
          <>
            <SectionHeader title="External Services" />
            <ConfigRow
              label="Redis"
              value={
                state.redisMode === 'external'
                  ? `external (${state.redisHost || 'not configured'}${state.redisTls ? ', TLS' : ''})`
                  : 'in-cluster'
              }
              valueColor={
                state.redisMode === 'external' ? colors.success : colors.muted
              }
            />
            <ConfigRow
              label="Kafka"
              value={
                state.kafkaMode === 'external'
                  ? `external (${kafkaPresetLabel(state.kafkaPreset)})`
                  : 'in-cluster'
              }
              valueColor={
                state.kafkaMode === 'external' ? colors.success : colors.muted
              }
            />
            {state.kafkaMode === 'external' && (
              <ConfigRow
                label="Topic prefix"
                value={state.kafkaTopicPrefix || '(none)'}
              />
            )}
            {state.kafkaMode === 'external' &&
              state.kafkaSaslMechanism === 'aws-iam' && (
                <ConfigRow
                  label="Vector"
                  value="kafka-proxy bridge sidecar (MSK IAM)"
                  valueColor={colors.muted}
                />
              )}
          </>
        )}
        
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
          <Text color={colors.success}>✓ Monitoring</Text>
          <Text>  </Text>
          <Text color={state.clickStackEnabled ? colors.success : colors.muted}>
            {state.clickStackEnabled ? '✓' : '○'} ClickStack
          </Text>
          <Text>  </Text>
          <Text color={!state.clickStackEnabled && state.tracingEnabled ? colors.success : colors.muted}>
            {!state.clickStackEnabled && state.tracingEnabled ? '✓' : '○'} Tracing
          </Text>
          <Text>  </Text>
          <Text color={!state.clickStackEnabled && state.appLogsEnabled ? colors.success : colors.muted}>
            {!state.clickStackEnabled && state.appLogsEnabled ? '✓' : '○'} App Logs
          </Text>
          <Text>  </Text>
          <Text color={state.loggingSink !== 'console' ? colors.success : colors.muted}>
            {state.loggingSink !== 'console' ? '✓' : '○'} Logging
          </Text>
        </Box>
        <ConfigRow
          label="Observability"
          value={
            state.clickStackEnabled
              ? 'Built-in ClickStack + HyperDX'
              : 'BYO/export mode'
          }
          valueColor={state.clickStackEnabled ? colors.success : colors.muted}
        />
        {state.clickStackEnabled && (
          <>
            <ConfigRow
              label="Retention"
              value={`decision logs ${state.decisionLogAccelerationRetentionDays}d / telemetry ${state.clickStackTelemetryRetentionDays}d`}
            />
            <ConfigRow
              label="Storage"
              value={`ClickHouse ${state.clickHouseStorageSize}, HyperDX metadata 10Gi (${clickStackStorageGi} Gi requested)`}
            />
          </>
        )}
        <ConfigRow label="Monitoring" value={monitoringDestination} />
        {!state.clickStackEnabled && state.tracingEnabled && (
          <ConfigRow
            label="Tracing"
            value={state.tracingElasticEndpoint || 'enabled'}
          />
        )}
        {!state.clickStackEnabled && state.appLogsEnabled && (
          <ConfigRow
            label="App logs"
            value={state.appLogsElasticEndpoint || 'enabled'}
          />
        )}
        {state.loggingSink !== 'console' && (
          <ConfigRow
            label="Logging"
            value={
              LOGGING_SINK_INFO[state.loggingSink]?.name || state.loggingSink
            }
          />
        )}
        
        <SectionHeader title="License" />
        <ConfigRow label="Key" value={`${state.licenseKey?.substring(0, 12)}...`} />
      </Box>
      
      <Box marginTop={1} flexDirection="column">
        <Text color={colors.success} bold>
          Press Enter to save this configuration
        </Text>
        <Text color={colors.muted} dimColor>
          {allowEditName ? 'e to edit name • ' : ''}Esc to go back
        </Text>
      </Box>
    </BorderBox>
  );
}
