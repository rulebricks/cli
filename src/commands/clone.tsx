import React, { useState, useEffect } from "react";
import { Box, Text, useApp } from "ink";
import {
  BorderBox,
  Spinner,
  ThemeProvider,
  useTheme,
  Logo,
} from "../components/common/index.js";
import {
  deploymentExists,
  cloneDeploymentConfig,
  getDeploymentDir,
} from "../lib/config.js";
import { generateHelmValues } from "../lib/helmValues.js";

interface CloneCommandProps {
  source: string;
  target: string;
}

type CloneStep = "validating" | "cloning" | "complete" | "error";

function CloneCommandInner({ source, target }: CloneCommandProps) {
  const { exit } = useApp();
  const { colors } = useTheme();
  const [step, setStep] = useState<CloneStep>("validating");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      try {
        // Validate source exists
        const sourceExists = await deploymentExists(source);
        if (!sourceExists) {
          setError(`Source deployment "${source}" not found`);
          setStep("error");
          return;
        }

        // Validate target doesn't exist
        const targetExists = await deploymentExists(target);
        if (targetExists) {
          setError(`Target deployment "${target}" already exists`);
          setStep("error");
          return;
        }

        // Clone the configuration
        setStep("cloning");
        const clonedConfig = await cloneDeploymentConfig(source, target);

        // Generate fresh Helm values from the cloned config
        await generateHelmValues(clonedConfig);

        setStep("complete");
        setTimeout(() => exit(), 3000);
      } catch (err) {
        setError(
          err instanceof Error ? err.message : "Failed to clone deployment",
        );
        setStep("error");
      }
    })();
  }, [source, target, exit]);

  // Validating screen
  if (step === "validating") {
    return (
      <BorderBox title="Clone Deployment">
        <Box flexDirection="column" marginY={1}>
          <Spinner label="Validating deployments..." />
        </Box>
      </BorderBox>
    );
  }

  // Error screen
  if (step === "error") {
    return (
      <BorderBox title="Clone Failed">
        <Box flexDirection="column" marginY={1}>
          <Text color={colors.error} bold>
            ✗ Error
          </Text>
          <Text color={colors.error}>{error}</Text>
          <Box marginTop={1}>
            <Text color={colors.muted} dimColor>
              Use <Text color={colors.accent}>rulebricks list</Text> to see
              available deployments.
            </Text>
          </Box>
        </Box>
      </BorderBox>
    );
  }

  // Cloning screen
  if (step === "cloning") {
    return (
      <BorderBox title="Clone Deployment">
        <Box flexDirection="column" marginY={1}>
          <Text color={colors.muted}>
            Source: <Text color={colors.accent}>{source}</Text>
          </Text>
          <Text color={colors.muted}>
            Target: <Text color={colors.accent}>{target}</Text>
          </Text>
          <Box marginTop={1}>
            <Spinner label="Cloning configuration..." />
          </Box>
        </Box>
      </BorderBox>
    );
  }

  // Complete screen
  return (
    <BorderBox title="Clone Complete">
      <Box flexDirection="column" marginY={1}>
        <Text color={colors.success} bold>
          ✓ Successfully cloned "{source}" to "{target}"
        </Text>

        <Box marginTop={1} flexDirection="column">
          <Text color={colors.muted}>Created files:</Text>
          <Text color={colors.muted}> • config.yaml</Text>
          <Text color={colors.muted}> • values.yaml</Text>
        </Box>

        <Box marginTop={1} flexDirection="column">
          <Text color={colors.muted} dimColor>
            Location: {getDeploymentDir(target)}
          </Text>
        </Box>

        <Box marginTop={1} flexDirection="column">
          <Text color={colors.muted}>Next steps:</Text>
          <Text color={colors.accent}> rulebricks deploy {target}</Text>
        </Box>
      </Box>
    </BorderBox>
  );
}

export function CloneCommand(props: CloneCommandProps) {
  return (
    <ThemeProvider theme="init">
      <Logo />
      <CloneCommandInner {...props} />
    </ThemeProvider>
  );
}
