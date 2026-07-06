import React, { useState } from "react";
import { Box, Text } from "ink";
import { useWizard } from "../WizardContext.js";
import { useFieldFlow, FlowField } from "../fieldFlow.js";
import {
  BorderBox,
  CheckRows,
  FieldError,
  StepFooter,
  TextField,
  WizardSelect,
  DiscoveredSelect,
  useGatedInput,
  useTheme,
} from "../../common/index.js";
import {
  ObjectStorageProvider,
  CloudProvider,
  CloudLoggingAuthMode,
} from "../../../types/index.js";
import {
  listRegionsWithFallback,
  listBucketsInRegion,
  listAzureBlobContainers,
  listIamRoles,
  listAzureWorkloadIdentities,
  getAzureTenantId,
  listGcpServiceAccounts,
} from "../../../lib/cloudCli.js";
import {
  findClusterSetupDefaultIndex,
  isAwsInfrastructureRoleName,
} from "../../../lib/clusterSetupDefaults.js";

interface StorageStepProps {
  onComplete: () => void;
  onBack: () => void;
  entryDirection?: "forward" | "back";
}

const PROVIDER_LABELS: Record<ObjectStorageProvider, string> = {
  s3: "AWS S3",
  "azure-blob": "Azure Blob Storage",
  gcs: "Google Cloud Storage",
};

const AZURE_AUTH = [
  { label: "Workload identity (recommended)", value: "workload-identity" },
  { label: "Connection string Secret (fallback)", value: "secret" },
];

// Healthy cron presets so users don't hand-write cron for DB backups.
const BACKUP_FREQUENCY_PRESETS: { label: string; value: string }[] = [
  { label: "Every 30 minutes", value: "*/30 * * * *" },
  { label: "Hourly", value: "0 * * * *" },
  { label: "Every 6 hours", value: "0 */6 * * *" },
  { label: "Every 12 hours", value: "0 */12 * * *" },
  { label: "Daily (02:00 UTC)", value: "0 2 * * *" },
  { label: "Weekly (Sun 02:00 UTC)", value: "0 2 * * 0" },
  { label: "Custom cron…", value: "__custom__" },
];

const CUSTOM_CRON = "__custom__";

function providerToCloud(provider: ObjectStorageProvider): CloudProvider {
  if (provider === "azure-blob") return "azure";
  if (provider === "gcs") return "gcp";
  return "aws";
}

export function storageProviderForCloud(
  provider: string | null,
): ObjectStorageProvider {
  if (provider === "azure") return "azure-blob";
  if (provider === "gcp") return "gcs";
  return "s3";
}

// GKE zonal clusters report a zone (e.g. us-central1-a) as their location, but
// object storage wants the region (us-central1). GCP zones always end in a
// single-letter suffix; AWS/Azure regions never do, so this is GCS-only.
function gcpZoneToRegion(location: string): string {
  return location.replace(/-[a-z]$/, "");
}

export function storageRegionForCloud(
  cloudProvider: string | null,
  clusterRegion: string,
  savedStorageProvider?: ObjectStorageProvider | null,
  savedStorageRegion?: string,
): string {
  const provider = storageProviderForCloud(cloudProvider);
  if (savedStorageProvider === provider && savedStorageRegion) {
    return savedStorageRegion;
  }
  return provider === "gcs" ? gcpZoneToRegion(clusterRegion) : clusterRegion;
}

interface StorageSummaryProps {
  rows: { label: string; value: string }[];
  note: string;
  onConfirm: () => void;
}

function StorageSummary({ rows, note, onConfirm }: StorageSummaryProps) {
  const { colors } = useTheme();

  useGatedInput((_input, key) => {
    if (key.return) onConfirm();
  });

  return (
    <Box flexDirection="column" marginY={1}>
      <Text color={colors.success}>Storage backend configured.</Text>
      <Box marginTop={1} flexDirection="column">
        {rows.map((row) => (
          <Text key={row.label}>
            {row.label}: {row.value}
          </Text>
        ))}
      </Box>
      <Box marginTop={1}>
        <Text color={colors.muted}>{note}</Text>
      </Box>
    </Box>
  );
}

export function StorageStep({
  onComplete,
  onBack,
  entryDirection,
}: StorageStepProps) {
  const { state, dispatch } = useWizard();
  const [error, setError] = useState<string | null>(null);

  // Object storage always lives in the same cloud as the cluster, so the
  // provider is derived instead of asked. (No real scenario deploys to e.g. an
  // AKS cluster and writes to S3.)
  const provider: ObjectStorageProvider = storageProviderForCloud(
    state.provider,
  );
  const cloud = providerToCloud(provider);
  const savedStorageMatchesProvider = state.storageProvider === provider;
  const bucketLabel = provider === "azure-blob" ? "Storage account" : "Bucket";

  const [region, setRegion] = useState(
    storageRegionForCloud(
      state.provider,
      state.region,
      state.storageProvider,
      state.storageRegion,
    ) || "",
  );
  const [regionManual, setRegionManual] = useState(false);
  const [bucket, setBucket] = useState(
    savedStorageMatchesProvider ? state.storageBucket || "" : "",
  );
  const [bucketManual, setBucketManual] = useState(false);
  const [roleArn, setRoleArn] = useState(
    savedStorageMatchesProvider && provider === "s3"
      ? state.storageAwsIamRoleArn || ""
      : "",
  );
  const [roleManual, setRoleManual] = useState(false);
  const [azureContainer, setAzureContainer] = useState(
    savedStorageMatchesProvider && provider === "azure-blob"
      ? state.storageAzureBlobContainer || "rulebricks"
      : "rulebricks",
  );
  const [containerManual, setContainerManual] = useState(false);
  const [authMode, setAuthMode] = useState<CloudLoggingAuthMode>(
    savedStorageMatchesProvider && provider === "azure-blob"
      ? state.storageCloudAuthMode || "workload-identity"
      : "workload-identity",
  );
  const [azureClientId, setAzureClientId] = useState(
    savedStorageMatchesProvider && provider === "azure-blob"
      ? state.storageAzureBlobClientId || ""
      : "",
  );
  const [clientManual, setClientManual] = useState(false);
  const [azureTenantId, setAzureTenantId] = useState(
    savedStorageMatchesProvider && provider === "azure-blob"
      ? state.storageAzureBlobTenantId || ""
      : "",
  );
  const [tenantAutoDetected, setTenantAutoDetected] = useState(false);
  const [azureSecretRef, setAzureSecretRef] = useState(
    savedStorageMatchesProvider && provider === "azure-blob"
      ? state.storageAzureBlobConnectionStringSecretRef || ""
      : "",
  );
  const [gcpServiceAccount, setGcpServiceAccount] = useState(
    savedStorageMatchesProvider && provider === "gcs"
      ? state.storageGcpServiceAccountEmail || ""
      : "",
  );
  const [saManual, setSaManual] = useState(false);

  // Database backups are configured here only when the chart owns the
  // in-cluster Postgres. Managed/external databases own their own backups.
  const usesInClusterPostgres =
    state.databaseType === "self-hosted" && state.postgresMode !== "external";
  const [backupEnabled, setBackupEnabled] = useState(state.backupEnabled);
  const [backupCustomCron, setBackupCustomCron] = useState(false);
  const [backupSchedule, setBackupSchedule] = useState(
    state.backupSchedule || "0 2 * * *",
  );
  const [backupRetentionDays, setBackupRetentionDays] = useState(
    String(state.backupRetentionDays || 7),
  );

  // Narrow huge account-wide lists to the Rulebricks workload identity from
  // cluster-setup (by cluster name or the "rulebricks" marker), falling back to
  // the full list when nothing matches.
  const relevantToRulebricks = (name: string): boolean => {
    const n = name.toLowerCase();
    const clusterName = (state.clusterName || "").toLowerCase();
    return (
      n.includes("rulebricks") || (clusterName !== "" && n.includes(clusterName))
    );
  };

  // Commits a single answered field to wizard state (always tagged with the
  // derived provider so re-entry recognizes the saved values), keeping
  // mid-step exits lossless. The summary's persistStorage remains the
  // authoritative full write.
  const saveStorage = (
    config: Omit<
      Extract<
        Parameters<typeof dispatch>[0],
        { type: "SET_STORAGE_CONFIG" }
      >["config"],
      "storageProvider"
    >,
  ) =>
    dispatch({
      type: "SET_STORAGE_CONFIG",
      config: { storageProvider: provider, ...config },
    });

  const persistStorage = () => {
    dispatch({
      type: "SET_STORAGE_CONFIG",
      config: {
        storageProvider: provider,
        storageRegion: region,
        storageBucket: bucket,
        storageCloudAuthMode:
          provider === "azure-blob" ? authMode : "workload-identity",
        storageAwsIamRoleArn: provider === "s3" ? roleArn : "",
        storageAzureBlobContainer:
          provider === "azure-blob" ? azureContainer : "",
        storageAzureBlobClientId:
          provider === "azure-blob" && authMode === "workload-identity"
            ? azureClientId
            : "",
        storageAzureBlobTenantId:
          provider === "azure-blob" && authMode === "workload-identity"
            ? azureTenantId
            : "",
        storageAzureBlobConnectionStringSecretRef:
          provider === "azure-blob" && authMode === "secret"
            ? azureSecretRef
            : "",
        storageGcpServiceAccountEmail:
          provider === "gcs" ? gcpServiceAccount : "",
      },
    });
  };

  const finishBackups = () => {
    const parsedRetention = Number.parseInt(backupRetentionDays, 10);
    dispatch({ type: "SET_BACKUP_ENABLED", enabled: backupEnabled });
    dispatch({
      type: "SET_BACKUP_SCHEDULE",
      schedule: backupSchedule || "0 2 * * *",
    });
    dispatch({
      type: "SET_BACKUP_RETENTION_DAYS",
      retentionDays: Number.isFinite(parsedRetention) ? parsedRetention : 7,
    });
  };

  const cloudAccessPurpose = usesInClusterPostgres
    ? "decision logs, database backups, and metrics"
    : "decision logs and metrics";

  const chosenSummary = () => {
    const rows: { label: string; value: string }[] = [
      { label: "Provider", value: PROVIDER_LABELS[provider] },
    ];
    if (region) rows.push({ label: "Region", value: region });
    if (bucket) rows.push({ label: bucketLabel, value: bucket });
    return rows;
  };

  const fields: FlowField[] = [
    {
      id: "region",
      when: () => !regionManual,
      render: (flow) => (
        <DiscoveredSelect
          label="Select Region"
          hint="Region where decision logs will be stored. Defaults to your cluster's region."
          loadingLabel="Loading available regions..."
          emptyHint="No regions listed. Press R to refresh or enter one manually."
          load={async () =>
            (await listRegionsWithFallback(cloud)).map((r) => ({
              label: r,
              value: r,
            }))
          }
          initialValue={region || undefined}
          onSelect={(value) => {
            setRegion(value);
            saveStorage({ storageRegion: value });
            flow.next();
          }}
          onManual={() => {
            setRegionManual(true);
            flow.next();
          }}
        />
      ),
    },
    {
      id: "region-manual",
      onEscape: () => setRegionManual(false),
      when: () => regionManual,
      render: (flow) => (
        <TextField
          label="Region"
          value={region}
          onChange={setRegion}
          placeholder={cloud === "azure" ? "eastus" : "us-east-1"}
          onSubmit={() => {
            if (!region.trim()) {
              setError("Region is required");
              return;
            }
            setError(null);
            saveStorage({ storageRegion: region.trim() });
            flow.next();
          }}
        />
      ),
    },
    {
      id: "bucket",
      when: () => !bucketManual,
      render: (flow) => (
        <DiscoveredSelect
          label={`Select ${provider === "azure-blob" ? "Storage Account" : "Bucket"}`}
          hint={`Existing ${bucketLabel.toLowerCase()}s in ${region}. One ${bucketLabel.toLowerCase()} holds all Rulebricks data.`}
          loadingLabel={`Loading ${bucketLabel.toLowerCase()}s in ${region}...`}
          emptyHint={`None found in ${region}. Press R to refresh or enter manually.`}
          load={async () =>
            (await listBucketsInRegion(cloud, region)).map((b) => ({
              label: b,
              value: b,
            }))
          }
          recommendIndex={(items) =>
            findClusterSetupDefaultIndex(
              items.map((item) => item.value),
              "decision-logs-bucket",
              { provider: cloud, clusterName: state.clusterName },
            )
          }
          initialValue={bucket || undefined}
          onSelect={(value) => {
            setBucket(value);
            saveStorage({ storageBucket: value });
            flow.next();
          }}
          onManual={() => {
            setBucketManual(true);
            flow.next();
          }}
        />
      ),
    },
    {
      id: "bucket-manual",
      onEscape: () => setBucketManual(false),
      when: () => bucketManual,
      render: (flow) => (
        <TextField
          label={
            provider === "azure-blob" ? "Storage Account Name" : "Bucket Name"
          }
          value={bucket}
          onChange={setBucket}
          placeholder={
            provider === "azure-blob" ? "mystorageaccount" : "my-bucket"
          }
          onSubmit={() => {
            if (!bucket.trim()) {
              setError(`${bucketLabel} name is required`);
              return;
            }
            setError(null);
            saveStorage({ storageBucket: bucket.trim() });
            flow.next();
          }}
        />
      ),
    },

    // ----- S3 -----
    {
      id: "s3-role",
      when: () => provider === "s3" && !roleManual,
      render: (flow) => (
        <DiscoveredSelect
          label="Select the Rulebricks IAM role"
          hint={`The single role from cluster-setup (${state.clusterName || "<cluster>"}-rulebricks), used for all cloud access: ${cloudAccessPurpose}.`}
          loadingLabel="Loading IAM roles..."
          emptyHint="None found. Press R to refresh or enter an ARN manually."
          load={async () => {
            // Infra roles (EKS control-plane / nodegroup / service-linked) are
            // never offered: Pod Identity rejects their trust policies, or
            // worse, binding them would hand pods node-level credentials.
            const roles = (await listIamRoles()).filter(
              (r) => !isAwsInfrastructureRoleName(r.name),
            );
            const narrowed = roles.filter((r) => relevantToRulebricks(r.name));
            return (narrowed.length > 0 ? narrowed : roles).map((r) => ({
              label: r.name,
              value: r.arn,
            }));
          }}
          recommendIndex={(items) =>
            findClusterSetupDefaultIndex(
              items.map((item) => item.label),
              "decision-logs-identity",
              { provider: "aws", clusterName: state.clusterName },
            )
          }
          noRecommendationNotice={`No ${state.clusterName || "<cluster>"}-rulebricks role found. If this cluster wasn't created by Rulebricks cluster-setup, create the role first (see cluster-setup/aws/README, "Bring your own cluster") or enter its ARN manually.`}
          initialValue={roleArn || undefined}
          onSelect={(value) => {
            setRoleArn(value);
            saveStorage({ storageAwsIamRoleArn: value });
            flow.next();
          }}
          onManual={() => {
            setRoleManual(true);
            flow.next();
          }}
        />
      ),
    },
    {
      id: "s3-role-manual",
      onEscape: () => setRoleManual(false),
      when: () => provider === "s3" && roleManual,
      render: (flow) => (
        <TextField
          label="S3 IRSA Role ARN"
          value={roleArn}
          onChange={setRoleArn}
          placeholder="arn:aws:iam::123456789012:role/rulebricks-vector"
          onSubmit={() => {
            if (!roleArn.startsWith("arn:")) {
              setError("Enter a valid IAM role ARN (arn:aws:iam::...)");
              return;
            }
            setError(null);
            saveStorage({ storageAwsIamRoleArn: roleArn });
            flow.next();
          }}
        />
      ),
    },

    // ----- GCS -----
    {
      id: "gcp-sa",
      when: () => provider === "gcs" && !saManual,
      render: (flow) => (
        <DiscoveredSelect
          label="Select the Rulebricks Google service account"
          hint={`The single service account from cluster-setup, used for all cloud access: ${cloudAccessPurpose}.`}
          loadingLabel="Loading service accounts..."
          emptyHint="None found. Press R to refresh or enter an email manually."
          load={async () => {
            const accounts = await listGcpServiceAccounts();
            const narrowed = accounts.filter((a) =>
              relevantToRulebricks(a.email),
            );
            return (narrowed.length > 0 ? narrowed : accounts).map((a) => ({
              label: a.email,
              value: a.email,
            }));
          }}
          recommendIndex={(items) =>
            findClusterSetupDefaultIndex(
              items.map((item) => item.value),
              "decision-logs-identity",
              { provider: "gcp", clusterName: state.clusterName },
            )
          }
          noRecommendationNotice={`No ${state.clusterName || "<cluster>"}-rulebricks service account found. If this cluster wasn't created by Rulebricks cluster-setup, create it first (see cluster-setup/gcp/README) or enter its email manually.`}
          initialValue={gcpServiceAccount || undefined}
          onSelect={(value) => {
            setGcpServiceAccount(value);
            saveStorage({ storageGcpServiceAccountEmail: value });
            flow.next();
          }}
          onManual={() => {
            setSaManual(true);
            flow.next();
          }}
        />
      ),
    },
    {
      id: "gcp-sa-manual",
      onEscape: () => setSaManual(false),
      when: () => provider === "gcs" && saManual,
      render: (flow) => (
        <TextField
          label="Google Service Account Email"
          value={gcpServiceAccount}
          onChange={setGcpServiceAccount}
          placeholder="rulebricks-vector@project.iam.gserviceaccount.com"
          onSubmit={() => {
            if (!gcpServiceAccount.includes("@")) {
              setError("Enter a valid service account email");
              return;
            }
            setError(null);
            saveStorage({ storageGcpServiceAccountEmail: gcpServiceAccount });
            flow.next();
          }}
        />
      ),
    },

    // ----- Azure Blob -----
    {
      id: "azure-container",
      when: () => provider === "azure-blob" && !containerManual,
      render: (flow) => (
        <DiscoveredSelect
          label="Select Blob Container"
          hint={`Container in ${bucket} where decision logs are written.`}
          loadingLabel="Loading blob containers..."
          emptyHint="None found. Press R to refresh or enter manually."
          load={async () =>
            (await listAzureBlobContainers(bucket)).map((c) => ({
              label: c,
              value: c,
            }))
          }
          recommendIndex={(items) =>
            findClusterSetupDefaultIndex(
              items.map((item) => item.value),
              "decision-logs-container",
              { provider: "azure", clusterName: state.clusterName },
            )
          }
          initialValue={azureContainer || undefined}
          onSelect={(value) => {
            setAzureContainer(value);
            saveStorage({ storageAzureBlobContainer: value });
            flow.next();
          }}
          onManual={() => {
            setContainerManual(true);
            flow.next();
          }}
        />
      ),
    },
    {
      id: "azure-container-manual",
      onEscape: () => setContainerManual(false),
      when: () => provider === "azure-blob" && containerManual,
      render: (flow) => (
        <TextField
          label="Azure Blob Container"
          value={azureContainer}
          onChange={setAzureContainer}
          placeholder="rulebricks-logs"
          onSubmit={() => {
            if (!azureContainer.trim()) {
              setError("Container name is required");
              return;
            }
            setError(null);
            saveStorage({ storageAzureBlobContainer: azureContainer.trim() });
            flow.next();
          }}
        />
      ),
    },
    {
      id: "azure-auth",
      when: () => provider === "azure-blob",
      render: (flow) => (
        <WizardSelect
          label="Azure Blob Authentication"
          hint="Workload identity is recommended; connection-string Secret is a fallback for clusters without Azure Workload Identity."
          items={AZURE_AUTH}
          initialValue={authMode}
          onSelect={(value) => {
            setAuthMode(value as CloudLoggingAuthMode);
            saveStorage({
              storageCloudAuthMode: value as CloudLoggingAuthMode,
            });
            flow.next();
          }}
        />
      ),
    },
    {
      id: "azure-client",
      when: () =>
        provider === "azure-blob" &&
        authMode === "workload-identity" &&
        !clientManual,
      render: (flow) => (
        <DiscoveredSelect
          label="Select the Rulebricks workload identity"
          hint={`The single identity from cluster-setup (${state.clusterName || "<cluster>"}-rulebricks), used for all cloud access: ${cloudAccessPurpose}.`}
          loadingLabel="Loading managed identities..."
          emptyHint="None found. Press R to refresh or enter a client ID manually."
          load={async () => {
            const [identities, tenant] = await Promise.all([
              listAzureWorkloadIdentities(state.clusterName),
              azureTenantId
                ? Promise.resolve<string | null>(null)
                : getAzureTenantId(),
            ]);
            if (tenant) {
              setAzureTenantId(tenant);
              setTenantAutoDetected(true);
            }
            return identities.map((identity) => ({
              label: `${identity.name} (${identity.clientId})`,
              value: identity.clientId,
            }));
          }}
          recommendIndex={(items) =>
            findClusterSetupDefaultIndex(
              items.map((item) => item.label),
              "decision-logs-identity",
              { provider: "azure", clusterName: state.clusterName },
            )
          }
          noRecommendationNotice={`No ${state.clusterName || "<cluster>"}-rulebricks identity found. If this cluster wasn't created by Rulebricks cluster-setup, create the identity first (see cluster-setup/azure/README) or enter its client ID manually.`}
          initialValue={azureClientId || undefined}
          onSelect={(value) => {
            setAzureClientId(value);
            saveStorage({ storageAzureBlobClientId: value });
            flow.next();
          }}
          onManual={() => {
            setClientManual(true);
            flow.next();
          }}
        />
      ),
    },
    {
      id: "azure-client-manual",
      onEscape: () => setClientManual(false),
      when: () =>
        provider === "azure-blob" &&
        authMode === "workload-identity" &&
        clientManual,
      render: (flow) => (
        <TextField
          label="Managed Identity Client ID"
          value={azureClientId}
          onChange={setAzureClientId}
          placeholder="00000000-0000-0000-0000-000000000000"
          onSubmit={() => {
            if (!azureClientId.trim()) {
              setError("Managed identity client ID is required");
              return;
            }
            setError(null);
            saveStorage({ storageAzureBlobClientId: azureClientId.trim() });
            flow.next();
          }}
        />
      ),
    },
    {
      id: "azure-tenant",
      when: () => provider === "azure-blob" && authMode === "workload-identity",
      render: (flow) => (
        <TextField
          label="Azure Tenant ID"
          hint={
            tenantAutoDetected
              ? "Auto-detected from your Azure CLI session - edit if needed."
              : "Tenant ID used by Azure Workload Identity."
          }
          value={azureTenantId}
          onChange={setAzureTenantId}
          placeholder="00000000-0000-0000-0000-000000000000"
          onSubmit={() => {
            if (!azureTenantId.trim()) {
              setError("Azure tenant ID is required");
              return;
            }
            setError(null);
            saveStorage({ storageAzureBlobTenantId: azureTenantId.trim() });
            flow.next();
          }}
        />
      ),
    },
    {
      id: "azure-secret",
      when: () => provider === "azure-blob" && authMode === "secret",
      render: (flow) => (
        <TextField
          label="Azure Connection String Secret"
          hint="Existing Kubernetes Secret key in the format name:key."
          value={azureSecretRef}
          onChange={setAzureSecretRef}
          placeholder="azure-blob-logs:connection-string"
          onSubmit={() => {
            if (!azureSecretRef.includes(":")) {
              setError("Use secret-name:key format");
              return;
            }
            setError(null);
            saveStorage({
              storageAzureBlobConnectionStringSecretRef: azureSecretRef,
            });
            flow.next();
          }}
        />
      ),
    },

    // ----- Summary + backups -----
    {
      id: "done",
      render: (flow) => (
        <StorageSummary
          rows={[
            ...chosenSummary(),
            ...(provider === "azure-blob"
              ? [{ label: "Container", value: azureContainer }]
              : []),
          ]}
          note={
            usesInClusterPostgres
              ? "Press Enter to configure database backups"
              : "Press Enter to continue"
          }
          onConfirm={() => {
            persistStorage();
            flow.next();
          }}
        />
      ),
    },
    {
      id: "backup-enabled",
      when: () => usesInClusterPostgres,
      render: (flow) => (
        <WizardSelect
          label="Database Backups"
          hint={`Logical pg_dump backups of the in-cluster Postgres are written to the same ${bucketLabel.toLowerCase()} under the db-backups/ prefix. Restore any time with \`rulebricks restore ${state.name}\`.`}
          items={[
            { label: "No database backups", value: "no" },
            { label: "Yes, schedule automatic backups", value: "yes" },
          ]}
          initialValue={backupEnabled ? "yes" : "no"}
          onSelect={(value) => {
            setBackupEnabled(value === "yes");
            dispatch({ type: "SET_BACKUP_ENABLED", enabled: value === "yes" });
            flow.next();
          }}
        />
      ),
    },
    {
      id: "backup-frequency",
      when: () => usesInClusterPostgres && backupEnabled && !backupCustomCron,
      render: (flow) => (
        <WizardSelect
          label="Backup frequency"
          hint="How often a backup is taken (UTC cron)."
          items={BACKUP_FREQUENCY_PRESETS}
          initialValue={backupSchedule}
          onSelect={(value) => {
            if (value === CUSTOM_CRON) {
              setBackupCustomCron(true);
              flow.next();
              return;
            }
            setBackupSchedule(value);
            dispatch({ type: "SET_BACKUP_SCHEDULE", schedule: value });
            flow.next();
          }}
        />
      ),
    },
    {
      id: "backup-frequency-custom",
      onEscape: () => setBackupCustomCron(false),
      when: () => usesInClusterPostgres && backupEnabled && backupCustomCron,
      render: (flow) => (
        <TextField
          label="Custom cron schedule"
          hint="Standard cron format (UTC)."
          value={backupSchedule}
          onChange={setBackupSchedule}
          placeholder="0 2 * * *"
          onSubmit={() => {
            if (!backupSchedule.trim()) {
              setError("Enter a cron expression or go back to pick a preset");
              return;
            }
            setError(null);
            dispatch({
              type: "SET_BACKUP_SCHEDULE",
              schedule: backupSchedule.trim(),
            });
            flow.next();
          }}
        />
      ),
    },
    {
      id: "backup-retention",
      when: () => usesInClusterPostgres && backupEnabled,
      render: (flow) => (
        <TextField
          label="Retention days"
          hint="Backups older than this are pruned from object storage (must be greater than 1)."
          value={backupRetentionDays}
          onChange={setBackupRetentionDays}
          placeholder="7"
          onSubmit={() => {
            const parsed = Number.parseInt(backupRetentionDays, 10);
            if (!Number.isFinite(parsed) || parsed < 2) {
              setError("Retention must be greater than 1 (at least 2 days)");
              return;
            }
            setError(null);
            dispatch({
              type: "SET_BACKUP_RETENTION_DAYS",
              retentionDays: parsed,
            });
            flow.next();
          }}
        />
      ),
    },
  ];

  const flow = useFieldFlow({
    fields,
    onDone: () => {
      finishBackups();
      onComplete();
    },
    onExit: onBack,
    entry: entryDirection === "back" ? "end" : "start",
    onNavigate: () => setError(null),
  });

  const storageTitle = usesInClusterPostgres
    ? "Storage & Backups"
    : "Object Storage";
  const storagePurpose = usesInClusterPostgres
    ? "Decision logs and database backups are stored as prefixes within it."
    : "Decision logs are stored as a prefix within it.";

  return (
    <BorderBox title={storageTitle}>
      <Box flexDirection="column" marginBottom={1}>
        <Text>Configure one bucket/container for all Rulebricks data.</Text>
        <Text color="gray" dimColor>
          {storagePurpose}
        </Text>
      </Box>

      {flow.render()}

      {["s3-role", "s3-role-manual", "gcp-sa", "gcp-sa-manual", "azure-client"].includes(
        flow.current,
      ) && <CheckRows rows={chosenSummary()} />}
      <FieldError error={error} />
      <StepFooter />
    </BorderBox>
  );
}
