import React, { useState } from 'react';
import { Box, Text } from 'ink';
import { useWizard } from '../WizardContext.js';
import {
  BorderBox,
  FieldError,
  StepFooter,
  TextField,
  useGatedInput,
  useTheme,
} from '../../common/index.js';
import {
  MAX_DEPLOYMENT_NAME_LENGTH,
  validateDeploymentName,
} from '../../../types/index.js';

interface DeploymentNameStepProps {
  onComplete: () => void;
  onBack: () => void;
  /**
   * The deployment's saved name (configure mode). Submitting a different name
   * renames the local config on save, which points future deploys at a new
   * Helm release/namespace, so a warning spells out the consequences.
   * Resubmitting the saved name is always allowed, even when it predates the
   * length cap.
   */
  originalName?: string;
}

export function DeploymentNameStep({
  onComplete,
  onBack,
  originalName,
}: DeploymentNameStepProps) {
  const { state, dispatch } = useWizard();
  const { colors } = useTheme();
  const [name, setName] = useState(state.name || '');
  const [error, setError] = useState<string | null>(null);

  useGatedInput((_input, key) => {
    if (key.escape) onBack();
  });

  const handleSubmit = () => {
    if (!originalName || name !== originalName) {
      const validationError = validateDeploymentName(name);
      if (validationError) {
        setError(validationError);
        return;
      }
    }
    setError(null);
    dispatch({ type: 'SET_NAME', name });
    onComplete();
  };

  return (
    <BorderBox
      title="Deployment Name"
      footer={<StepFooter hints={['Enter to confirm', 'Esc to go back']} />}
    >
      <TextField
        label="Deployment name"
        hint={`Lowercase letters, numbers, and hyphens; at most ${MAX_DEPLOYMENT_NAME_LENGTH} characters`}
        value={name}
        onChange={setName}
        onSubmit={handleSubmit}
        placeholder="my-deployment"
      />
      {originalName && (
        <Box flexDirection="column" marginBottom={1}>
          <Text color={colors.warning}>
            Renaming only updates the local config: the next deploy installs a
            fresh release in namespace rulebricks-{'<'}new name{'>'}, and
            nothing moves or carries over.
          </Text>
          <Text color={colors.warning}>
            If "{originalName}" is already deployed, run rulebricks destroy{' '}
            {originalName} before saving the rename, or clean up its namespace
            manually afterwards.
          </Text>
        </Box>
      )}
      <FieldError error={error} />
    </BorderBox>
  );
}
