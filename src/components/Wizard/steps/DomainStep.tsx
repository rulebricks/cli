import React, { useState } from 'react';
import { Box, Text, useInput } from 'ink';
import TextInput from 'ink-text-input';
import SelectInput from 'ink-select-input';
import { useWizard } from '../WizardContext.js';
import { BorderBox, useTheme } from '../../common/index.js';
import { Spinner } from '../../common/Spinner.js';
import { validateBaseDomain, isValidEmail, isValidDomainFormat } from '../../../lib/validation.js';
import { DnsProvider, DNS_PROVIDER_NAMES, isSupportedDnsProvider } from '../../../types/index.js';

interface DomainStepProps {
  onComplete: () => void;
  onBack: () => void;
}

type SubStep = 'domain' | 'validating' | 'admin-email' | 'tls-email' | 'dns-provider' | 'dns-auto-manage';

const DNS_PROVIDER_OPTIONS: Array<{ label: string; value: DnsProvider }> = [
  { label: 'Other / Not sure (manual DNS)', value: 'other' },
  { label: 'AWS Route 53', value: 'route53' },
  { label: 'Cloudflare', value: 'cloudflare' },
  { label: 'Google Cloud DNS', value: 'google' },
  { label: 'Azure DNS', value: 'azure' }
];

const AUTO_MANAGE_OPTIONS = [
  { label: 'Yes, automatically manage DNS records', value: true },
  { label: 'No, I\'ll configure DNS manually', value: false }
];

export function DomainStep({ onComplete, onBack }: DomainStepProps) {
  const { state, dispatch } = useWizard();
  const { colors } = useTheme();
  const [subStep, setSubStep] = useState<SubStep>('domain');
  const [domain, setDomain] = useState(state.domain || '');
  const [adminEmail, setAdminEmail] = useState(state.adminEmail || '');
  const [tlsEmail, setTlsEmail] = useState(state.tlsEmail || '');
  const [error, setError] = useState<string | null>(null);
  
  useInput((input, key) => {
    if (key.escape) {
      setError(null);
      if (subStep === 'domain') {
        onBack();
      } else if (subStep === 'admin-email') {
        setSubStep('domain');
      } else if (subStep === 'tls-email') {
        setSubStep('admin-email');
      } else if (subStep === 'dns-provider') {
        setSubStep('tls-email');
      } else if (subStep === 'dns-auto-manage') {
        setSubStep('dns-provider');
      }
    }
  });
  
  const handleDomainSubmit = async () => {
    if (!domain) {
      setError('Domain is required');
      return;
    }
    
    if (!isValidDomainFormat(domain)) {
      setError('Invalid domain format (e.g., rulebricks.example.com)');
      return;
    }
    
    setError(null);
    setSubStep('validating');
    
    try {
      const result = await validateBaseDomain(domain);
      
      if (!result.valid) {
        setError(result.error || 'Domain validation failed');
        setSubStep('domain');
        return;
      }
      
      dispatch({ type: 'SET_DOMAIN', domain });
      setSubStep('admin-email');
    } catch {
      // If validation fails due to network issues, allow continuing
      dispatch({ type: 'SET_DOMAIN', domain });
      setSubStep('admin-email');
    }
  };
  
  const handleAdminEmailSubmit = () => {
    if (!adminEmail) {
      setError('Admin email is required');
      return;
    }
    
    if (!isValidEmail(adminEmail)) {
      setError('Invalid email format');
      return;
    }
    
    setError(null);
    dispatch({ type: 'SET_ADMIN_EMAIL', email: adminEmail });
    
    // Default TLS email to admin email if not set
    if (!tlsEmail) {
      setTlsEmail(adminEmail);
    }
    
    setSubStep('tls-email');
  };
  
  const handleTlsEmailSubmit = () => {
    if (!tlsEmail) {
      setError('TLS email is required');
      return;
    }
    
    if (!isValidEmail(tlsEmail)) {
      setError('Invalid email format');
      return;
    }
    
    setError(null);
    dispatch({ type: 'SET_TLS_EMAIL', email: tlsEmail });
    setSubStep('dns-provider');
  };
  
  const handleDnsProviderSelect = (item: { value: DnsProvider }) => {
    dispatch({ type: 'SET_DNS_PROVIDER', provider: item.value });
    
    // If unsupported provider, skip auto-manage question and complete
    if (!isSupportedDnsProvider(item.value)) {
      dispatch({ type: 'SET_DNS_AUTO_MANAGE', autoManage: false });
      onComplete();
    } else {
      // For supported providers, ask if they want auto-management
      setSubStep('dns-auto-manage');
    }
  };
  
  const handleAutoManageSelect = (item: { value: boolean }) => {
    dispatch({ type: 'SET_DNS_AUTO_MANAGE', autoManage: item.value });
    onComplete();
  };
  
  // Progress summary component
  const ProgressSummary = () => (
    <Box marginTop={1} flexDirection="column">
      {domain && (
        <Box>
          <Text color="green">✓</Text>
          <Text color="gray"> Domain: {domain}</Text>
        </Box>
      )}
      {adminEmail && subStep !== 'admin-email' && (
        <Box>
          <Text color="green">✓</Text>
          <Text color="gray"> Admin: {adminEmail}</Text>
        </Box>
      )}
      {tlsEmail && subStep !== 'tls-email' && subStep !== 'admin-email' && (
        <Box>
          <Text color="green">✓</Text>
          <Text color="gray"> TLS email: {tlsEmail}</Text>
        </Box>
      )}
    </Box>
  );
  
  return (
    <BorderBox title="Domain & DNS">
      {subStep === 'domain' && (
        <Box flexDirection="column" marginY={1}>
          <Text>Enter your Rulebricks domain:</Text>
          <Text color="gray" dimColor>
            This is where Rulebricks will be accessible (e.g., rulebricks.example.com)
          </Text>
          <Box marginTop={1}>
            <TextInput
              value={domain}
              onChange={setDomain}
              onSubmit={handleDomainSubmit}
              placeholder="rulebricks.example.com"
            />
          </Box>
          {error && (
            <Box marginTop={1}>
              <Text color="red">✗ {error}</Text>
            </Box>
          )}
        </Box>
      )}
      
      {subStep === 'validating' && (
        <Box flexDirection="column" marginY={1}>
          <Spinner label="Validating domain..." />
        </Box>
      )}
      
      {subStep === 'admin-email' && (
        <Box flexDirection="column" marginY={1}>
          <Text>Enter the admin email address:</Text>
          <Text color="gray" dimColor>
            This email will be used for Rulebricks administration and notifications
          </Text>
          <Box marginTop={1}>
            <TextInput
              value={adminEmail}
              onChange={setAdminEmail}
              onSubmit={handleAdminEmailSubmit}
              placeholder="admin@example.com"
            />
          </Box>
          <ProgressSummary />
          {error && (
            <Box marginTop={1}>
              <Text color="red">✗ {error}</Text>
            </Box>
          )}
        </Box>
      )}
      
      {subStep === 'tls-email' && (
        <Box flexDirection="column" marginY={1}>
          <Text>Enter the email for TLS certificates:</Text>
          <Text color="gray" dimColor>
            Let's Encrypt will send certificate expiration notices here
          </Text>
          <Box marginTop={1}>
            <TextInput
              value={tlsEmail}
              onChange={setTlsEmail}
              onSubmit={handleTlsEmailSubmit}
              placeholder={adminEmail || 'admin@example.com'}
            />
          </Box>
          <ProgressSummary />
          {error && (
            <Box marginTop={1}>
              <Text color="red">✗ {error}</Text>
            </Box>
          )}
        </Box>
      )}
      
      {subStep === 'dns-provider' && (
        <Box flexDirection="column" marginY={1}>
          <Text bold>Where is your domain's DNS hosted?</Text>
          <Text color="gray" dimColor>
            This determines whether we can automatically manage DNS records for you
          </Text>
          <Box marginTop={1}>
            <SelectInput
              items={DNS_PROVIDER_OPTIONS}
              onSelect={handleDnsProviderSelect}
              itemComponent={({ isSelected, label }) => (
                <Text color={isSelected ? colors.accent : undefined}>
                  {label}
                </Text>
              )}
            />
          </Box>
          <ProgressSummary />
        </Box>
      )}
      
      {subStep === 'dns-auto-manage' && (
        <Box flexDirection="column" marginY={1}>
          <Text bold>Automatic DNS Management</Text>
          <Text color="gray" dimColor>
            Would you like Rulebricks to automatically create and manage DNS records?
          </Text>
          <Text color="gray" dimColor>
            This enables single-step deployment without manual DNS configuration.
          </Text>
          <Box marginTop={1}>
            <SelectInput
              items={AUTO_MANAGE_OPTIONS}
              onSelect={handleAutoManageSelect}
              itemComponent={({ isSelected, label }) => (
                <Text color={isSelected ? colors.accent : undefined}>
                  {label}
                </Text>
              )}
            />
          </Box>
          <ProgressSummary />
          <Box marginTop={1}>
            <Text color="green">✓</Text>
            <Text color="gray"> DNS Provider: {DNS_PROVIDER_NAMES[state.dnsProvider]}</Text>
          </Box>
          
          {state.infrastructureMode === 'existing' && (
            <Box marginTop={1} borderStyle="round" borderColor="yellow" paddingX={1}>
              <Text color="yellow">
                Note: Auto-DNS requires external-dns with proper IAM credentials in your cluster.
              </Text>
            </Box>
          )}
        </Box>
      )}
      
      <Box marginTop={1}>
        <Text color="gray" dimColor>
          Esc to go back • Enter to continue
        </Text>
      </Box>
    </BorderBox>
  );
}
