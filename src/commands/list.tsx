import React, { useEffect, useState } from "react";
import { Box, Text, useApp } from "ink";
import {
  BorderBox,
  Logo,
  Spinner,
  ThemeProvider,
  useTheme,
} from "../components/common/index.js";
import { listDeployments } from "../lib/config.js";
import {
  DeploymentHealth,
  loadDeploymentHealth,
} from "../lib/deploymentHealth.js";

type ListStep = "loading" | "complete" | "empty" | "error";

function statusText(health: DeploymentHealth): {
  icon: string;
  label: string;
  color: string;
} {
  switch (health.kind) {
    case "online":
      return { icon: "●", label: "online", color: "green" };
    case "installed-unreachable":
      return { icon: "◐", label: "installed, URL unreachable", color: "yellow" };
    case "installed-degraded":
      return { icon: "◐", label: "installed, pods not ready", color: "yellow" };
    case "cluster-unreachable":
      return { icon: "?", label: "cluster unreachable", color: "yellow" };
    case "destroyed":
      return { icon: "○", label: "destroyed", color: "gray" };
    case "not-installed":
      return { icon: "○", label: "not installed", color: "gray" };
    case "config-error":
      return { icon: "✗", label: "config error", color: "red" };
  }
}

function ListCommandInner() {
  const { exit } = useApp();
  const { colors } = useTheme();
  const [step, setStep] = useState<ListStep>("loading");
  const [loadingLabel, setLoadingLabel] = useState("Loading deployments...");
  const [deployments, setDeployments] = useState<DeploymentHealth[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      try {
        const names = await listDeployments();
        if (names.length === 0) {
          setStep("empty");
          setTimeout(() => exit(), 250);
          return;
        }

        setLoadingLabel(`Checking health for ${names.length} deployment(s)...`);
        const results: DeploymentHealth[] = [];
        for (const name of names) {
          setLoadingLabel(`Checking ${name}...`);
          results.push(await loadDeploymentHealth(name));
        }

        setDeployments(results);
        setStep("complete");
        setTimeout(() => exit(), 250);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Failed to list deployments");
        setStep("error");
        setTimeout(() => exit(), 1000);
      }
    })();
  }, [exit]);

  if (step === "loading") {
    return (
      <BorderBox title="Deployments">
        <Box marginY={1}>
          <Spinner label={loadingLabel} />
        </Box>
      </BorderBox>
    );
  }

  if (step === "empty") {
    return (
      <BorderBox title="Deployments">
        <Box marginY={1}>
          <Text color={colors.warning}>
            No deployments found. Run "rulebricks init" to create one.
          </Text>
        </Box>
      </BorderBox>
    );
  }

  if (step === "error") {
    return (
      <BorderBox title="List Failed">
        <Box flexDirection="column" marginY={1}>
          <Text color={colors.error} bold>
            ✗ Error
          </Text>
          <Text color={colors.error}>{error}</Text>
        </Box>
      </BorderBox>
    );
  }

  return (
    <BorderBox title="Deployments">
      <Box flexDirection="column" marginY={1}>
        {deployments.map((deployment) => {
          const status = statusText(deployment);
          return (
            <Box key={deployment.name}>
              <Text color={status.color}>{status.icon}</Text>
              <Text> {deployment.name} </Text>
              <Text color={status.color}>{status.label}</Text>
              {deployment.url && (
                <Text color={colors.muted}> {deployment.url}</Text>
              )}
            </Box>
          );
        })}
      </Box>
    </BorderBox>
  );
}

export function ListCommand() {
  return (
    <ThemeProvider theme="status">
      <Logo />
      <ListCommandInner />
    </ThemeProvider>
  );
}
