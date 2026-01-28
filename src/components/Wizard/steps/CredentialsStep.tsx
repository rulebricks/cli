import React, { useState } from 'react';
import { Box, Text, useInput } from 'ink';
import TextInput from 'ink-text-input';
import { useWizard } from '../WizardContext.js';
import { BorderBox } from '../../common/index.js';

interface CredentialsStepProps {
  onComplete: () => void;
  onBack: () => void;
}

export function CredentialsStep({ onComplete, onBack }: CredentialsStepProps) {
  const { state, dispatch } = useWizard();
  const [licenseKey, setLicenseKey] = useState(state.licenseKey || '');
  
  useInput((input, key) => {
    if (key.escape) {
      onBack();
    }
  });
  
  const handleSubmit = () => {
    if (!licenseKey) return;
    dispatch({ type: 'SET_LICENSE_KEY', key: licenseKey });
    onComplete();
  };
  
  return (
    <BorderBox title="Credentials">
      <Box flexDirection="column" marginY={1}>
        <Text>Enter your Rulebricks license key:</Text>
        <Text color="gray" dimColor>
          This is required to pull the Rulebricks Docker images
        </Text>
        <Box marginTop={1}>
          <Text color="cyan">❯ </Text>
          <TextInput
            value={licenseKey}
            onChange={setLicenseKey}
            onSubmit={handleSubmit}
            placeholder="Enter your license key"
            mask="*"
          />
        </Box>
      </Box>
      
      <Box marginTop={1}>
        <Text color="gray" dimColor>
          Esc to go back • Enter to continue
        </Text>
      </Box>
    </BorderBox>
  );
}
