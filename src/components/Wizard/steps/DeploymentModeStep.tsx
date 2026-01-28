import React from 'react';
import { Box, Text } from 'ink';
import SelectInput from 'ink-select-input';
import { useWizard } from '../WizardContext.js';
import { BorderBox, useTheme } from '../../common/index.js';

interface DeploymentModeStepProps {
  onComplete: () => void;
}

export function DeploymentModeStep({ onComplete }: DeploymentModeStepProps) {
  const { dispatch } = useWizard();
  const { colors } = useTheme();
  
  const items = [
    {
      label: 'Use existing Kubernetes cluster',
      value: 'existing',
      description: 'I already have a cluster configured'
    },
    {
      label: 'Provision new infrastructure',
      value: 'provision',
      description: 'Create a new cluster on AWS, GCP, or Azure'
    }
  ];
  
  const handleSelect = (item: { value: string }) => {
    dispatch({ type: 'SET_INFRA_MODE', mode: item.value as 'existing' | 'provision' });
    onComplete();
  };
  
  return (
    <BorderBox title="Deployment Mode">
      <Box flexDirection="column" marginY={1}>
        <Text>How would you like to deploy Rulebricks?</Text>
        <Text color="gray" dimColor>
          Select whether to use an existing cluster or provision new infrastructure
        </Text>
      </Box>
      
      <Box marginY={1}>
        <SelectInput
          items={items}
          onSelect={handleSelect}
          itemComponent={({ isSelected, label }) => (
            <Box>
              <Text color={isSelected ? colors.accent : undefined}>
                {label}
              </Text>
            </Box>
          )}
        />
      </Box>
      
      <Box marginTop={1}>
        <Text color="gray" dimColor>
          ↑/↓ to navigate • Enter to select
        </Text>
      </Box>
    </BorderBox>
  );
}
