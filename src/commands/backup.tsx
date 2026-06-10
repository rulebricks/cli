import React, { useEffect, useState } from "react";
import { Box, Text, useApp } from "ink";
import {
  BorderBox,
  Logo,
  Spinner,
  StatusLine,
  ThemeProvider,
  useTheme,
} from "../components/common/index.js";
import { loadDeploymentConfig } from "../lib/config.js";
import { updateKubeconfig } from "../lib/cloudCli.js";
import {
  checkClusterAccessible,
  createJobFromCronJob,
  isKubectlInstalled,
  waitForJobComplete,
} from "../lib/kubernetes.js";
import { DeploymentConfig, getNamespace, getReleaseName } from "../types/index.js";

interface BackupCommandProps {
  name: string;
}

type Step = "loading" | "preflight" | "running" | "complete" | "error";
type Status = "pending" | "running" | "success" | "error" | "skipped";

function k8sName(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9-]/g, "-").slice(0, 63).replace(/-+$/, "");
}

function BackupCommandInner({ name }: BackupCommandProps) {
  const { exit } = useApp();
  const { colors } = useTheme();
  const [step, setStep] = useState<Step>("loading");
  const [error, setError] = useState<string | null>(null);
  const [logs, setLogs] = useState("");
  const [status, setStatus] = useState<Record<string, Status>>({
    preflight: "pending",
    job: "pending",
  });

  useEffect(() => {
    runBackup();
  }, []);

  async function runBackup() {
    try {
      const config = await loadDeploymentConfig(name);
      validateConfig(config);

      setStep("preflight");
      setStatus((current) => ({ ...current, preflight: "running" }));
      await runPreflight(config);
      setStatus((current) => ({ ...current, preflight: "success" }));

      const namespace = getNamespace(config.name);
      const releaseName = getReleaseName(config.name);
      const cronJobName = `${releaseName}-db-backup`;
      const jobName = k8sName(`${cronJobName}-manual-${Date.now()}`);

      setStep("running");
      setStatus((current) => ({ ...current, job: "running" }));
      await createJobFromCronJob(namespace, cronJobName, jobName);
      const jobLogs = await waitForJobComplete(namespace, jobName);
      setLogs(jobLogs);
      setStatus((current) => ({ ...current, job: "success" }));

      setStep("complete");
      setTimeout(() => exit(), 5000);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Backup failed");
      setStatus((current) => ({
        ...current,
        preflight: step === "preflight" ? "error" : current.preflight,
        job: step === "running" ? "error" : current.job,
      }));
      setStep("error");
    }
  }

  function validateConfig(config: DeploymentConfig) {
    if (config.database.type !== "self-hosted") {
      throw new Error("Backups are only available for self-hosted Supabase.");
    }
    if (!config.storage) {
      throw new Error("Shared object storage is required for database backups.");
    }
    if (!config.backup?.enabled) {
      throw new Error(
        "Database backups are disabled for this deployment. Re-run `rulebricks init` to enable them.",
      );
    }
  }

  async function runPreflight(config: DeploymentConfig) {
    if (!(await isKubectlInstalled())) {
      throw new Error("kubectl is not installed. Please install kubectl first.");
    }

    let clusterError = await checkClusterAccessible();
    if (
      clusterError &&
      config.infrastructure.provider &&
      config.infrastructure.region &&
      config.infrastructure.clusterName
    ) {
      await updateKubeconfig(
        config.infrastructure.provider,
        config.infrastructure.clusterName,
        config.infrastructure.region,
        {
          gcpProjectId: config.infrastructure.gcpProjectId,
          azureResourceGroup: config.infrastructure.azureResourceGroup,
        },
      );
      clusterError = await checkClusterAccessible();
    }

    if (clusterError) {
      throw new Error(`Cannot access Kubernetes cluster:\n${clusterError}`);
    }
  }

  if (step === "error") {
    return (
      <BorderBox title="Backup Failed">
        <Box flexDirection="column" marginY={1}>
          <Text color={colors.error} bold>✗ Error</Text>
          <Text color={colors.error}>{error}</Text>
        </Box>
      </BorderBox>
    );
  }

  if (step === "complete") {
    return (
      <BorderBox title="Backup Complete">
        <Box flexDirection="column" marginY={1}>
          <Text color={colors.success} bold>✓ Database backup completed</Text>
          {logs && (
            <Box marginTop={1} flexDirection="column">
              <Text color={colors.muted}>Job output:</Text>
              {logs.split("\n").slice(-8).map((line, index) => (
                <Text key={index} color={colors.muted}>{line}</Text>
              ))}
            </Box>
          )}
        </Box>
      </BorderBox>
    );
  }

  return (
    <BorderBox title={`Backing Up ${name}`}>
      <Box flexDirection="column" marginY={1}>
        <StatusLine status={status.preflight} label="Preflight checks" />
        <StatusLine status={status.job} label="Database backup job" />
        <Box marginTop={1}>
          <Spinner
            label={step === "running" ? "Running backup job..." : "Preparing backup..."}
          />
        </Box>
      </Box>
    </BorderBox>
  );
}

export function BackupCommand(props: BackupCommandProps) {
  return (
    <ThemeProvider theme="status">
      <Logo />
      <BackupCommandInner {...props} />
    </ThemeProvider>
  );
}
