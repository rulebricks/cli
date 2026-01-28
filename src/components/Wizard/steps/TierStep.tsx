import React from 'react';
import { Box, Text, useInput } from 'ink';
import SelectInput from 'ink-select-input';
import { useWizard } from '../WizardContext.js';
import { BorderBox, useTheme } from '../../common/index.js';
import { TIER_CONFIGS, PerformanceTier } from '../../../types/index.js';

interface TierStepProps {
  onComplete: () => void;
  onBack: () => void;
}

export function TierStep({ onComplete, onBack }: TierStepProps) {
  const { dispatch } = useWizard();
  const { colors } = useTheme();
  
  useInput((input, key) => {
    if (key.escape) {
      onBack();
    }
  });
  
  const items = (Object.entries(TIER_CONFIGS) as [PerformanceTier, typeof TIER_CONFIGS.small][]).map(
    ([tier, config]) => ({
      label: tier.charAt(0).toUpperCase() + tier.slice(1),
      value: tier,
      config
    })
  );
  
  const handleSelect = (item: { value: string }) => {
    dispatch({ type: 'SET_TIER', tier: item.value as PerformanceTier });
    onComplete();
  };
  
  return (
    <BorderBox title="Performance Tier">
      <Box flexDirection="column" marginY={1}>
        <Text>Select your deployment size:</Text>
        <Text color="gray" dimColor>
          This determines the cluster resources and scaling limits
        </Text>
      </Box>
      
      <SelectInput
        items={items}
        onSelect={handleSelect}
        indicatorComponent={() => null}
        itemComponent={({ isSelected, label }) => {
          const currentItem = items.find(i => i.label === label) || items[0];
          const config = currentItem.config;
          return (
            <Box flexDirection="column" marginY={isSelected ? 1 : 0}>
              <Text color={isSelected ? colors.accent : undefined} bold={isSelected}>
                {isSelected ? '❯ ' : '  '}{currentItem.label}
                <Text color="gray"> - {config.description}</Text>
              </Text>
              {isSelected && (
                <Box flexDirection="column" marginLeft={4}>
                  <Text color="gray">
                    Throughput: {config.throughput}
                  </Text>
                  <Text color="gray">
                    Nodes: {config.nodes.min}-{config.nodes.max} • {config.resources}
                  </Text>
                  <Text color="gray">
                    HPS Workers: {config.hpsWorkerReplicas.min}-{config.hpsWorkerReplicas.max}
                  </Text>
                </Box>
              )}
            </Box>
          );
        }}
      />
      
      <Box marginTop={1}>
        <Text color="gray" dimColor>
          Esc to go back • Enter to select
        </Text>
      </Box>
    </BorderBox>
  );
}
