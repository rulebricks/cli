import React, { useState } from 'react';
import { Box, Text, useInput } from 'ink';
import SelectInput from 'ink-select-input';
import TextInput from 'ink-text-input';
import { useWizard } from '../WizardContext.js';
import { BorderBox, useTheme } from '../../common/index.js';
import { DatabaseType } from '../../../types/index.js';

interface DatabaseStepProps {
  onComplete: () => void;
  onBack: () => void;
}

type SubStep = 'type' | 'supabase-url' | 'supabase-keys';

export function DatabaseStep({ onComplete, onBack }: DatabaseStepProps) {
  const { state, dispatch } = useWizard();
  const { colors } = useTheme();
  const [subStep, setSubStep] = useState<SubStep>('type');
  const [supabaseUrl, setSupabaseUrl] = useState(state.supabaseUrl || '');
  const [anonKey, setAnonKey] = useState(state.supabaseAnonKey || '');
  const [serviceKey, setServiceKey] = useState(state.supabaseServiceKey || '');
  const [currentField, setCurrentField] = useState<'anon' | 'service'>('anon');
  
  useInput((input, key) => {
    if (key.escape) {
      if (subStep === 'type') {
        onBack();
      } else if (subStep === 'supabase-url') {
        setSubStep('type');
      } else if (subStep === 'supabase-keys') {
        if (currentField === 'service') {
          setCurrentField('anon');
        } else {
          setSubStep('supabase-url');
        }
      }
    }
  });
  
  const items = [
    {
      label: 'Self-hosted Supabase',
      value: 'self-hosted',
      description: 'Deploy Supabase as part of the Helm chart'
    },
    {
      label: 'Supabase Cloud',
      value: 'supabase-cloud',
      description: 'Use your existing Supabase Cloud project'
    }
  ];
  
  const handleTypeSelect = (item: { value: string }) => {
    const dbType = item.value as DatabaseType;
    dispatch({ type: 'SET_DATABASE_TYPE', dbType });
    
    if (dbType === 'supabase-cloud') {
      setSubStep('supabase-url');
    } else {
      onComplete();
    }
  };
  
  const handleUrlSubmit = () => {
    if (!supabaseUrl) return;
    dispatch({ type: 'SET_SUPABASE_CONFIG', config: { supabaseUrl } });
    setSubStep('supabase-keys');
  };
  
  const handleAnonKeySubmit = () => {
    if (!anonKey) return;
    setCurrentField('service');
  };
  
  const handleServiceKeySubmit = () => {
    if (!serviceKey) return;
    dispatch({
      type: 'SET_SUPABASE_CONFIG',
      config: {
        supabaseAnonKey: anonKey,
        supabaseServiceKey: serviceKey
      }
    });
    onComplete();
  };
  
  return (
    <BorderBox title="Database">
      {subStep === 'type' && (
        <>
          <Box flexDirection="column" marginY={1}>
            <Text>Choose your database setup:</Text>
          </Box>
          <SelectInput
            items={items}
            onSelect={handleTypeSelect}
            itemComponent={({ isSelected, label }) => (
              <Text color={isSelected ? colors.accent : undefined}>
                {label}
              </Text>
            )}
          />
        </>
      )}
      
      {subStep === 'supabase-url' && (
        <Box flexDirection="column" marginY={1}>
          <Text>Enter your Supabase project URL:</Text>
          <Text color="gray" dimColor>
            Find this in your Supabase Dashboard → Project Settings
          </Text>
          <Box marginTop={1}>
            <Text color={colors.accent}>❯ </Text>
            <TextInput
              value={supabaseUrl}
              onChange={setSupabaseUrl}
              onSubmit={handleUrlSubmit}
              placeholder="https://xxxxx.supabase.co"
            />
          </Box>
        </Box>
      )}
      
      {subStep === 'supabase-keys' && (
        <Box flexDirection="column" marginY={1}>
          <Text>Enter your Supabase API keys:</Text>
          
          {currentField === 'anon' ? (
            <Box marginTop={1} flexDirection="column">
              <Text>Anon (public) key:</Text>
              <Box>
                <Text color={colors.accent}>❯ </Text>
                <TextInput
                  value={anonKey}
                  onChange={setAnonKey}
                  onSubmit={handleAnonKeySubmit}
                  placeholder="eyJhbGciOiJIUzI1NiIs..."
                />
              </Box>
            </Box>
          ) : (
            <Box marginTop={1} flexDirection="column">
              <Box>
                <Text color="green">✓</Text>
                <Text> Anon key: {anonKey.substring(0, 20)}...</Text>
              </Box>
              <Box marginTop={1}>
                <Text>Service role key:</Text>
              </Box>
              <Box>
                <Text color={colors.accent}>❯ </Text>
                <TextInput
                  value={serviceKey}
                  onChange={setServiceKey}
                  onSubmit={handleServiceKeySubmit}
                  placeholder="eyJhbGciOiJIUzI1NiIs..."
                />
              </Box>
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
