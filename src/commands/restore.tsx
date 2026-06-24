import React, { useEffect, useState } from "react";
import { Box, Text, useApp } from "ink";
import SelectInput from "ink-select-input";
import TextInput from "ink-text-input";
import {
  BorderBox,
  Logo,
  Spinner,
  StatusLine,
  ThemeProvider,
  useTheme,
  CommandApprovalProvider,
} from "../components/common/index.js";
import { loadDeploymentConfig } from "../lib/config.js";
import { updateKubeconfig } from "../lib/cloudCli.js";
import { CommandDeniedError } from "../lib/commandApproval.js";
import {
  checkClusterAccessible,
  getDeploymentReplicas,
  isKubectlInstalled,
  runEphemeralJob,
  scaleDeployment,
  waitForDeploymentReady,
} from "../lib/kubernetes.js";
import {
  RCLONE_IMAGE,
  SUPABASE_POSTGRES_IMAGE_REPOSITORY,
  SUPABASE_POSTGRES_IMAGE_TAG,
} from "../lib/versions.js";
import { DeploymentConfig, getNamespace, getReleaseName } from "../types/index.js";

interface RestoreCommandProps {
  name: string;
}

type Step =
  | "loading"
  | "preflight"
  | "listing"
  | "select"
  | "confirm"
  | "restoring"
  | "complete"
  | "error";
type Status = "pending" | "running" | "success" | "error" | "skipped";

interface BackupInfo {
  id: string;
  label: string;
}

interface DeploymentReplica {
  name: string;
  replicas: number;
}

const DB_IMAGE = `${SUPABASE_POSTGRES_IMAGE_REPOSITORY}:${SUPABASE_POSTGRES_IMAGE_TAG}`;

function k8sName(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9-]/g, "-").slice(0, 63).replace(/-+$/, "");
}

// The single bucket/container plus the db-backups prefix, e.g. "my-bucket/db-backups"
// (S3/GCS) or "my-container/db-backups" (azure-blob).
function dbBackupsTarget(config: DeploymentConfig): string {
  const storage = config.storage;
  if (!storage) throw new Error("Shared object storage is required.");
  const prefix = (storage.paths?.dbBackups || "db-backups").replace(
    /^\/+|\/+$/g,
    "",
  );
  if (storage.provider === "azure-blob") {
    return `${storage.azureBlobContainer || "rulebricks"}/${prefix}`;
  }
  return `${storage.bucket}/${prefix}`;
}

// rclone on-the-fly remote "dest" config via env vars (no config file). Auth is
// the pod's workload identity (env_auth) for every provider, or an Azure Blob
// connection string Secret in the fallback path.
function rcloneEnv(config: DeploymentConfig): Array<Record<string, unknown>> {
  const storage = config.storage;
  if (!storage) throw new Error("Shared object storage is required.");
  const env: Array<Record<string, unknown>> = [];

  switch (storage.provider) {
    case "azure-blob":
      env.push({ name: "RCLONE_CONFIG_DEST_TYPE", value: "azureblob" });
      env.push({ name: "RCLONE_CONFIG_DEST_ACCOUNT", value: storage.bucket });
      if (storage.cloudAuthMode === "secret") {
        if (!storage.azureBlobConnectionStringSecretRef) {
          throw new Error("Azure Blob connection string secret ref is required.");
        }
        env.push({
          name: "RCLONE_CONFIG_DEST_CONNECTION_STRING",
          valueFrom: {
            secretKeyRef: {
              name: storage.azureBlobConnectionStringSecretRef.name,
              key: storage.azureBlobConnectionStringSecretRef.key,
            },
          },
        });
      } else {
        env.push({ name: "RCLONE_CONFIG_DEST_ENV_AUTH", value: "true" });
      }
      break;
    case "gcs":
      env.push({ name: "RCLONE_CONFIG_DEST_TYPE", value: "google cloud storage" });
      env.push({ name: "RCLONE_CONFIG_DEST_ENV_AUTH", value: "true" });
      env.push({ name: "RCLONE_CONFIG_DEST_BUCKET_POLICY_ONLY", value: "true" });
      break;
    default:
      env.push({ name: "RCLONE_CONFIG_DEST_TYPE", value: "s3" });
      env.push({ name: "RCLONE_CONFIG_DEST_PROVIDER", value: "AWS" });
      env.push({ name: "RCLONE_CONFIG_DEST_ENV_AUTH", value: "true" });
      env.push({ name: "RCLONE_CONFIG_DEST_REGION", value: storage.region });
      break;
  }
  return env;
}

function pgEnv(
  config: DeploymentConfig,
  releaseName: string,
): Array<Record<string, unknown>> {
  const secret = `${releaseName}-supabase-db`;
  return [
    { name: "PGHOST", value: `${releaseName}-supabase-db` },
    { name: "PGPORT", value: "5432" },
    {
      name: "PGDATABASE",
      valueFrom: { secretKeyRef: { name: secret, key: "database" } },
    },
    // Restore as a superuser so pg_restore --clean and the globals.sql roles can
    // drop/recreate objects in schemas owned by supabase_admin (auth, storage,
    // realtime, etc.). The secret's `username` role (postgres) is not a superuser.
    { name: "PGUSER", value: "supabase_admin" },
    {
      name: "PGPASSWORD",
      valueFrom: { secretKeyRef: { name: secret, key: "password" } },
    },
  ];
}

function jobLabels(config: DeploymentConfig): Record<string, string> {
  const labels: Record<string, string> = {
    "app.kubernetes.io/component": "db-restore",
  };
  // Azure Workload Identity requires this pod label so the projected token is
  // injected for the rclone download. S3 (IRSA) and GCS (GKE WI) work via the SA.
  if (
    config.storage?.provider === "azure-blob" &&
    config.storage.cloudAuthMode !== "secret"
  ) {
    labels["azure.workload.identity/use"] = "true";
  }
  return labels;
}

function parseBackups(output: string): BackupInfo[] {
  return output
    .split("\n")
    .map((line) => line.trim().replace(/\/+$/, ""))
    .filter((line) => line.length > 0 && !line.includes("/"))
    .sort()
    .reverse()
    .map((id) => ({ id, label: id }));
}

function RestoreCommandInner({ name }: RestoreCommandProps) {
  const { exit } = useApp();
  const { colors } = useTheme();
  const [step, setStep] = useState<Step>("loading");
  const [config, setConfig] = useState<DeploymentConfig | null>(null);
  const [backups, setBackups] = useState<BackupInfo[]>([]);
  const [selectedBackup, setSelectedBackup] = useState<BackupInfo | null>(null);
  const [confirmation, setConfirmation] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [logs, setLogs] = useState("");
  const [status, setStatus] = useState<Record<string, Status>>({
    preflight: "pending",
    list: "pending",
    scaleDown: "pending",
    restore: "pending",
    scaleUp: "pending",
  });

  useEffect(() => {
    prepare();
  }, []);

  async function prepare() {
    try {
      const cfg = await loadDeploymentConfig(name);
      validateConfig(cfg);
      setConfig(cfg);

      setStep("preflight");
      setStatus((current) => ({ ...current, preflight: "running" }));
      await runPreflight(cfg);
      setStatus((current) => ({ ...current, preflight: "success" }));

      setStep("listing");
      setStatus((current) => ({ ...current, list: "running" }));
      const available = await listBackups(cfg);
      setBackups(available);
      setStatus((current) => ({ ...current, list: "success" }));
      setStep("select");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Restore preparation failed");
      setStep("error");
    }
  }

  function validateConfig(cfg: DeploymentConfig) {
    if (cfg.database.type !== "self-hosted") {
      throw new Error("Restore is only available for self-hosted Supabase.");
    }
    if (!cfg.storage) {
      throw new Error("Shared object storage is required for restore.");
    }
    if (!cfg.backup?.enabled) {
      throw new Error("Database backups are disabled for this deployment.");
    }
  }

  async function runPreflight(cfg: DeploymentConfig) {
    if (!(await isKubectlInstalled())) {
      throw new Error("kubectl is not installed. Please install kubectl first.");
    }

    let clusterError = await checkClusterAccessible();
    if (
      clusterError &&
      cfg.infrastructure.provider &&
      cfg.infrastructure.region &&
      cfg.infrastructure.clusterName
    ) {
      try {
        await updateKubeconfig(
          cfg.infrastructure.provider,
          cfg.infrastructure.clusterName,
          cfg.infrastructure.region,
          {
            gcpProjectId: cfg.infrastructure.gcpProjectId,
            azureResourceGroup: cfg.infrastructure.azureResourceGroup,
          },
        );
      } catch (err) {
        if (!(err instanceof CommandDeniedError)) {
          throw err;
        }
      }
      clusterError = await checkClusterAccessible();
    }

    if (clusterError) {
      throw new Error(`Cannot access Kubernetes cluster:\n${clusterError}`);
    }
  }

  async function listBackups(cfg: DeploymentConfig): Promise<BackupInfo[]> {
    const namespace = getNamespace(cfg.name);
    const releaseName = getReleaseName(cfg.name);
    const target = dbBackupsTarget(cfg);
    const result = await runEphemeralJob({
      name: k8sName(`${releaseName}-backup-list-${Date.now()}`),
      namespace,
      serviceAccountName: `${releaseName}-backup`,
      image: RCLONE_IMAGE,
      command: [
        "/bin/sh",
        "-c",
        `rclone lsf "dest:${target}/" --dirs-only`,
      ],
      env: rcloneEnv(cfg),
      labels: jobLabels(cfg),
      timeoutSeconds: 300,
    });

    const parsed = parseBackups(result.logs);
    if (parsed.length === 0) {
      throw new Error("No database backups found in object storage.");
    }
    return parsed;
  }

  async function handleRestore() {
    if (!config || !selectedBackup) return;
    if (confirmation !== config.name) {
      setError(`Type "${config.name}" to confirm restore.`);
      return;
    }

    setError(null);
    setStep("restoring");
    let originalReplicas: DeploymentReplica[] = [];

    try {
      setStatus((current) => ({ ...current, scaleDown: "running" }));
      originalReplicas = await scaleDownForRestore(config);
      setStatus((current) => ({ ...current, scaleDown: "success" }));

      setStatus((current) => ({ ...current, restore: "running" }));
      const result = await runRestoreJob(config, selectedBackup.id);
      setLogs(result.logs);
      setStatus((current) => ({ ...current, restore: "success" }));

      setStatus((current) => ({ ...current, scaleUp: "running" }));
      await scaleBackUp(config, originalReplicas);
      setStatus((current) => ({ ...current, scaleUp: "success" }));

      setStep("complete");
      setTimeout(() => exit(), 8000);
    } catch (err) {
      if (originalReplicas.length > 0) {
        await scaleBackUp(config, originalReplicas).catch(() => {});
      }
      setError(err instanceof Error ? err.message : "Restore failed");
      setStep("error");
    }
  }

  // Logical restore runs pg_restore against the live database, so we keep the DB
  // up and instead pause the application tier to stop writes during the restore.
  async function scaleDownForRestore(cfg: DeploymentConfig): Promise<DeploymentReplica[]> {
    const namespace = getNamespace(cfg.name);
    const releaseName = getReleaseName(cfg.name);
    const appName = `${releaseName}-app`;
    const replicas = await getDeploymentReplicas(namespace, appName);

    if (replicas === null || replicas <= 0) {
      return [];
    }

    await scaleDeployment(namespace, appName, 0);
    await waitForDeploymentReady(namespace, appName, 120).catch(() => {});
    return [{ name: appName, replicas }];
  }

  async function scaleBackUp(
    cfg: DeploymentConfig,
    originalReplicas: DeploymentReplica[],
  ) {
    const namespace = getNamespace(cfg.name);
    for (const item of originalReplicas) {
      if (item.replicas <= 0) continue;
      await scaleDeployment(namespace, item.name, item.replicas);
      await waitForDeploymentReady(namespace, item.name).catch(() => {});
    }
  }

  async function runRestoreJob(cfg: DeploymentConfig, backupId: string) {
    const namespace = getNamespace(cfg.name);
    const releaseName = getReleaseName(cfg.name);
    const target = dbBackupsTarget(cfg);

    return runEphemeralJob({
      name: k8sName(`${releaseName}-db-restore-${Date.now()}`),
      namespace,
      serviceAccountName: `${releaseName}-backup`,
      // Init container downloads the selected backup; the main container restores
      // it into the live database over the network. They share an emptyDir.
      initContainers: [
        {
          name: "download",
          image: RCLONE_IMAGE,
          imagePullPolicy: "IfNotPresent",
          command: [
            "/bin/sh",
            "-c",
            `set -e; echo "Downloading backup ${backupId}"; rclone copy "dest:${target}/${backupId}/" /work/`,
          ],
          env: rcloneEnv(cfg),
          volumeMounts: [{ name: "work", mountPath: "/work" }],
        },
      ],
      image: DB_IMAGE,
      command: [
        "/bin/bash",
        "-c",
        [
          "set -euo pipefail",
          'if [ -f /work/globals.sql ]; then',
          '  echo "Applying cluster globals (roles)"',
          '  psql -h "$PGHOST" -p "$PGPORT" -U "$PGUSER" -d "$PGDATABASE" -v ON_ERROR_STOP=0 -f /work/globals.sql || true',
          "fi",
          'echo "Restoring database from /work/db.dump"',
          'pg_restore -h "$PGHOST" -p "$PGPORT" -U "$PGUSER" -d "$PGDATABASE" --clean --if-exists --no-owner --no-privileges /work/db.dump',
          'echo "Restore complete"',
        ].join("\n"),
      ],
      env: pgEnv(cfg, releaseName),
      labels: jobLabels(cfg),
      volumeMounts: [{ name: "work", mountPath: "/work" }],
      volumes: [{ name: "work", emptyDir: {} }],
      timeoutSeconds: 3600,
    });
  }

  if (step === "error") {
    return (
      <BorderBox title="Restore Failed">
        <Box flexDirection="column" marginY={1}>
          <Text color={colors.error} bold>✗ Error</Text>
          <Text color={colors.error}>{error}</Text>
        </Box>
      </BorderBox>
    );
  }

  if (step === "select") {
    return (
      <BorderBox title="Select Backup">
        <Box flexDirection="column" marginY={1}>
          <Text>Select a backup to restore:</Text>
          <Box marginTop={1}>
            <SelectInput
              items={backups.map((backup) => ({
                label: backup.label,
                value: backup,
              }))}
              onSelect={(item) => {
                setSelectedBackup(item.value);
                setStep("confirm");
              }}
              indicatorComponent={() => null}
              itemComponent={({ isSelected, label }) => (
                <Text color={isSelected ? colors.accent : undefined}>
                  {isSelected ? "❯ " : "  "}
                  {label}
                </Text>
              )}
            />
          </Box>
        </Box>
      </BorderBox>
    );
  }

  if (step === "confirm" && config && selectedBackup) {
    return (
      <BorderBox title="Confirm Restore">
        <Box flexDirection="column" marginY={1}>
          <Text color={colors.warning} bold>WARNING</Text>
          <Text>This will overwrite the live database for {config.name}.</Text>
          <Text>Selected backup: {selectedBackup.id}</Text>
          <Box marginTop={1}>
            <Text>Type the deployment name to continue:</Text>
          </Box>
          <Box marginTop={1}>
            <TextInput
              value={confirmation}
              onChange={setConfirmation}
              onSubmit={handleRestore}
              placeholder={config.name}
            />
          </Box>
          {error && (
            <Box marginTop={1}>
              <Text color={colors.error}>{error}</Text>
            </Box>
          )}
        </Box>
      </BorderBox>
    );
  }

  if (step === "complete") {
    return (
      <BorderBox title="Restore Complete">
        <Box flexDirection="column" marginY={1}>
          <Text color={colors.success} bold>✓ Database restore completed</Text>
          {logs && (
            <Box marginTop={1} flexDirection="column">
              <Text color={colors.muted}>Restore output:</Text>
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
    <BorderBox title={`Restoring ${name}`}>
      <Box flexDirection="column" marginY={1}>
        <StatusLine status={status.preflight} label="Preflight checks" />
        <StatusLine status={status.list} label="Listing backups" />
        <StatusLine status={status.scaleDown} label="Pausing application writers" />
        <StatusLine status={status.restore} label="Restoring selected backup" />
        <StatusLine status={status.scaleUp} label="Resuming application" />
        <Box marginTop={1}>
          <Spinner label={step === "listing" ? "Listing backups..." : "Preparing restore..."} />
        </Box>
      </Box>
    </BorderBox>
  );
}

export function RestoreCommand(props: RestoreCommandProps) {
  return (
    <ThemeProvider theme="status">
      <Logo />
      <CommandApprovalProvider>
        <RestoreCommandInner {...props} />
      </CommandApprovalProvider>
    </ThemeProvider>
  );
}
