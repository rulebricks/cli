import React, { useEffect, useState } from "react";
import { Box, Text } from "ink";
import SelectInput from "ink-select-input";
import TextInput from "ink-text-input";
import { useWizard } from "../WizardContext.js";
import { BorderBox, useGatedInput, useTheme } from "../../common/index.js";
import { Spinner } from "../../common/Spinner.js";
import {
  ObjectStorageProvider,
  CloudProvider,
  CloudLoggingAuthMode,
  CLOUD_REGIONS,
} from "../../../types/index.js";
import {
  listRegions,
  listBucketsInRegion,
  listAzureBlobContainers,
  listIamRoles,
  listAzureManagedIdentities,
  getAzureTenantId,
  listGcpServiceAccounts,
  IamRole,
  AzureManagedIdentity,
  GcpServiceAccount,
} from "../../../lib/cloudCli.js";
import { findClusterSetupDefaultIndex } from "../../../lib/clusterSetupDefaults.js";

interface StorageStepProps {
  onComplete: () => void;
  onBack: () => void;
}

// Sentinel value used in select lists to drop into manual text entry.
const MANUAL = "__manual__";

const PROVIDERS: { label: string; value: ObjectStorageProvider }[] = [
  { label: "AWS S3", value: "s3" },
  { label: "Azure Blob Storage", value: "azure-blob" },
  { label: "Google Cloud Storage", value: "gcs" },
];

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

function defaultProviderForCloud(
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

type Field =
  | "provider"
  | "region-loading"
  | "region"
  | "bucket-loading"
  | "bucket"
  | "bucket-manual"
  | "s3-role-loading"
  | "s3-role"
  | "s3-role-manual"
  | "azure-container-loading"
  | "azure-container"
  | "azure-container-manual"
  | "azure-auth"
  | "azure-identity-loading"
  | "azure-client"
  | "azure-client-manual"
  | "azure-tenant"
  | "azure-secret"
  | "gcp-sa-loading"
  | "gcp-sa"
  | "gcp-sa-manual"
  | "done"
  // Database backup policy (self-hosted Postgres only); same bucket, db-backups/ prefix.
  | "backup-enabled"
  | "backup-frequency"
  | "backup-frequency-custom"
  | "backup-retention"
  | "backup-done";

export function StorageStep({ onComplete, onBack }: StorageStepProps) {
  const { state, dispatch } = useWizard();
  const { colors } = useTheme();

  // Object storage always lives in the same cloud as the cluster, so derive the
  // provider from the cluster's cloud instead of asking again. (No real scenario
  // deploys to e.g. an AKS cluster and writes to S3.)
  const provider: ObjectStorageProvider =
    state.storageProvider || defaultProviderForCloud(state.provider);

  // The storage region is likewise assumed to be the cluster's region, so the
  // region question is skipped whenever one is known (Esc from the bucket list
  // still drops back to region selection for the rare cross-region setup).
  // Only the manual-cluster path (no region captured) asks up front.
  const initialRegion =
    state.storageRegion ||
    (provider === "gcs" ? gcpZoneToRegion(state.region) : state.region) ||
    "";
  const [field, setField] = useState<Field>(
    initialRegion ? "bucket-loading" : "region-loading",
  );

  const [region, setRegion] = useState(initialRegion);
  const [bucket, setBucket] = useState(state.storageBucket || "");
  const [roleArn, setRoleArn] = useState(state.storageAwsIamRoleArn || "");
  const [azureContainer, setAzureContainer] = useState(
    state.storageAzureBlobContainer || "rulebricks",
  );
  const [authMode, setAuthMode] = useState<CloudLoggingAuthMode>(
    state.storageCloudAuthMode || "workload-identity",
  );
  const [azureClientId, setAzureClientId] = useState(
    state.storageAzureBlobClientId || "",
  );
  const [azureTenantId, setAzureTenantId] = useState(
    state.storageAzureBlobTenantId || "",
  );
  const [tenantAutoDetected, setTenantAutoDetected] = useState(false);
  const [azureSecretRef, setAzureSecretRef] = useState(
    state.storageAzureBlobConnectionStringSecretRef || "",
  );
  const [gcpServiceAccount, setGcpServiceAccount] = useState(
    state.storageGcpServiceAccountEmail || "",
  );

  // Database backups are configured in this same step (self-hosted only); they
  // share the bucket above and land under the db-backups/ prefix.
  const isSelfHosted = state.databaseType === "self-hosted";
  const [backupEnabled, setBackupEnabled] = useState(state.backupEnabled);
  const [backupSchedule, setBackupSchedule] = useState(
    state.backupSchedule || "0 2 * * *",
  );
  const [backupRetentionDays, setBackupRetentionDays] = useState(
    String(state.backupRetentionDays || 7),
  );

  // Dynamic resource lists (empty => manual entry fallback).
  const [availableRegions, setAvailableRegions] = useState<string[]>([]);
  const [availableBuckets, setAvailableBuckets] = useState<string[]>([]);
  const [availableContainers, setAvailableContainers] = useState<string[]>([]);
  const [availableRoles, setAvailableRoles] = useState<IamRole[]>([]);
  const [availableIdentities, setAvailableIdentities] = useState<
    AzureManagedIdentity[]
  >([]);
  const [availableServiceAccounts, setAvailableServiceAccounts] = useState<
    GcpServiceAccount[]
  >([]);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const bucketLabel = provider === "azure-blob" ? "Storage account" : "Bucket";

  // ===== Loaders =====
  const loadRegions = async (selected: ObjectStorageProvider) => {
    const cloud = providerToCloud(selected);
    setField("region-loading");
    try {
      const regions = await listRegions(cloud);
      setAvailableRegions(regions.length > 0 ? regions : CLOUD_REGIONS[cloud]);
    } catch {
      setAvailableRegions(CLOUD_REGIONS[cloud]);
    }
    setField("region");
  };

  // Provider (and usually region) are derived from the cluster, so jump
  // straight to bucket discovery when the region is already known.
  useEffect(() => {
    if (initialRegion) {
      loadBuckets(initialRegion);
    } else {
      loadRegions(provider);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const loadBuckets = async (selectedRegion: string) => {
    const cloud = providerToCloud(provider);
    setField("bucket-loading");
    try {
      const buckets = await listBucketsInRegion(cloud, selectedRegion);
      setAvailableBuckets(buckets);
    } catch {
      setAvailableBuckets([]);
    }
    setField("bucket");
  };

  const proceedAfterBucket = () => {
    if (provider === "s3") {
      loadRoles();
    } else if (provider === "gcs") {
      loadServiceAccounts();
    } else {
      loadContainers(bucket);
    }
  };

  // Narrow huge account-wide lists to the Rulebricks workload identity from
  // cluster-setup (by cluster name or the "rulebricks" marker). Falls back to the
  // full list if nothing matches, and "Enter manually…" is always available.
  const relevantToRulebricks = (name: string): boolean => {
    const n = name.toLowerCase();
    const cluster = (state.clusterName || "").toLowerCase();
    return n.includes("rulebricks") || (cluster !== "" && n.includes(cluster));
  };

  const loadRoles = async () => {
    setField("s3-role-loading");
    try {
      const roles = await listIamRoles();
      const narrowed = roles.filter((r) => relevantToRulebricks(r.name));
      setAvailableRoles(narrowed.length > 0 ? narrowed : roles);
    } catch {
      setAvailableRoles([]);
    }
    setField("s3-role");
  };

  const loadServiceAccounts = async () => {
    setField("gcp-sa-loading");
    try {
      const accounts = await listGcpServiceAccounts();
      const narrowed = accounts.filter((s) => relevantToRulebricks(s.email));
      setAvailableServiceAccounts(narrowed.length > 0 ? narrowed : accounts);
    } catch {
      setAvailableServiceAccounts([]);
    }
    setField("gcp-sa");
  };

  const loadContainers = async (account: string) => {
    setField("azure-container-loading");
    try {
      setAvailableContainers(await listAzureBlobContainers(account));
    } catch {
      setAvailableContainers([]);
    }
    setField("azure-container");
  };

  const loadAzureIdentities = async () => {
    setField("azure-identity-loading");
    try {
      const [identities, tenant] = await Promise.all([
        listAzureManagedIdentities(),
        azureTenantId ? Promise.resolve<string | null>(null) : getAzureTenantId(),
      ]);
      // Hide the identities AKS creates for itself (the kubelet "-agentpool" and
      // the control-plane "<cluster>-identity") -- they are never the Rulebricks
      // workload identity, and listing them just makes the choice confusing.
      const cluster = (state.clusterName || "").toLowerCase();
      const workloadIdentities = identities.filter((i) => {
        const name = i.name.toLowerCase();
        if (name.endsWith("-agentpool")) return false;
        if (cluster && name === `${cluster}-identity`) return false;
        return true;
      });
      setAvailableIdentities(
        workloadIdentities.length > 0 ? workloadIdentities : identities,
      );
      if (tenant) {
        setAzureTenantId(tenant);
        setTenantAutoDetected(true);
      }
    } catch {
      setAvailableIdentities([]);
    }
    setField("azure-client");
  };

  const refreshList = async () => {
    if (isRefreshing) return;
    const cloud = providerToCloud(provider);
    setIsRefreshing(true);
    try {
      if (field === "bucket") {
        setAvailableBuckets(await listBucketsInRegion(cloud, region));
      } else if (field === "azure-container") {
        setAvailableContainers(await listAzureBlobContainers(bucket));
      }
    } catch {
      // Keep existing list on error
    }
    setIsRefreshing(false);
  };

  // ===== Persistence =====
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

  // After object storage is configured, self-hosted deployments continue into
  // the database backup policy (same bucket); managed-database deployments are
  // done here.
  const completeFromStorage = () => {
    persistStorage();
    if (isSelfHosted) {
      setField("backup-enabled");
    } else {
      onComplete();
    }
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
    onComplete();
  };

  // ===== Back navigation =====
  const handleBack = () => {
    setError(null);
    switch (field) {
      case "region":
      case "region-loading":
        // Provider is derived from the cluster cloud (no provider step), so the
        // first storage field returns to the previous wizard step.
        onBack();
        break;
      case "bucket":
      case "bucket-loading":
      case "bucket-manual":
        // The region list may not have been loaded yet when the region
        // question was skipped (region derived from the cluster).
        if (availableRegions.length === 0) {
          loadRegions(provider);
        } else {
          setField("region");
        }
        break;
      case "s3-role":
      case "s3-role-loading":
      case "s3-role-manual":
      case "azure-container":
      case "azure-container-loading":
      case "azure-container-manual":
      case "gcp-sa":
      case "gcp-sa-loading":
      case "gcp-sa-manual":
        setField("bucket");
        break;
      case "azure-auth":
        setField("azure-container");
        break;
      case "azure-client":
      case "azure-identity-loading":
      case "azure-client-manual":
        setField("azure-auth");
        break;
      case "azure-tenant":
        setField("azure-client");
        break;
      case "azure-secret":
        setField("azure-auth");
        break;
      case "done":
        if (provider === "s3") setField("s3-role");
        else if (provider === "gcs") setField("gcp-sa");
        else setField(authMode === "secret" ? "azure-secret" : "azure-tenant");
        break;
      case "backup-enabled":
        setField("done");
        break;
      case "backup-frequency":
      case "backup-frequency-custom":
        setField("backup-enabled");
        break;
      case "backup-retention":
        setField("backup-frequency");
        break;
      case "backup-done":
        setField("backup-retention");
        break;
    }
  };

  useGatedInput((input, key) => {
    if (key.escape) {
      handleBack();
      return;
    }
    if (
      input.toLowerCase() === "r" &&
      (field === "bucket" || field === "azure-container")
    ) {
      refreshList();
      return;
    }
    if (field === "done" && key.return) {
      completeFromStorage();
      return;
    }
    if (field === "backup-enabled") {
      if (input === " " || input.toLowerCase() === "x") {
        setBackupEnabled((value) => !value);
      } else if (key.return) {
        if (backupEnabled) {
          setField("backup-frequency");
        } else {
          finishBackups();
        }
      }
      return;
    }
    if (field === "backup-done" && key.return) {
      finishBackups();
    }
  });

  // ===== Selection handlers =====
  const handleRegionSelect = (item: { value: string }) => {
    setRegion(item.value);
    loadBuckets(item.value);
  };

  const handleBucketSelect = (item: { value: string }) => {
    if (item.value === MANUAL) {
      setField("bucket-manual");
      return;
    }
    setBucket(item.value);
    proceedAfterBucket();
  };

  const handleBucketManualSubmit = () => {
    if (!bucket.trim()) {
      setError(`${bucketLabel} name is required`);
      return;
    }
    setError(null);
    proceedAfterBucket();
  };

  const handleRoleSelect = (item: { value: string }) => {
    if (item.value === MANUAL) {
      setField("s3-role-manual");
      return;
    }
    setRoleArn(item.value);
    setField("done");
  };

  const handleRoleManualSubmit = () => {
    if (!roleArn.startsWith("arn:")) {
      setError("Enter a valid IAM role ARN (arn:aws:iam::...)");
      return;
    }
    setError(null);
    setField("done");
  };

  const handleServiceAccountSelect = (item: { value: string }) => {
    if (item.value === MANUAL) {
      setField("gcp-sa-manual");
      return;
    }
    setGcpServiceAccount(item.value);
    setField("done");
  };

  const handleServiceAccountManualSubmit = () => {
    if (!gcpServiceAccount.includes("@")) {
      setError("Enter a valid service account email");
      return;
    }
    setError(null);
    setField("done");
  };

  const handleContainerSelect = (item: { value: string }) => {
    if (item.value === MANUAL) {
      setField("azure-container-manual");
      return;
    }
    setAzureContainer(item.value);
    setField("azure-auth");
  };

  const handleContainerManualSubmit = () => {
    if (!azureContainer.trim()) {
      setError("Container name is required");
      return;
    }
    setError(null);
    setField("azure-auth");
  };

  const handleAuthSelect = (item: { value: string }) => {
    const mode = item.value as CloudLoggingAuthMode;
    setAuthMode(mode);
    if (mode === "workload-identity") {
      loadAzureIdentities();
    } else {
      setField("azure-secret");
    }
  };

  const handleIdentitySelect = (item: { value: string }) => {
    if (item.value === MANUAL) {
      setField("azure-client-manual");
      return;
    }
    setAzureClientId(item.value);
    setField("azure-tenant");
  };

  const handleIdentityManualSubmit = () => {
    if (!azureClientId.trim()) {
      setError("Managed identity client ID is required");
      return;
    }
    setError(null);
    setField("azure-tenant");
  };

  const handleTenantSubmit = () => {
    if (!azureTenantId.trim()) {
      setError("Azure tenant ID is required");
      return;
    }
    setError(null);
    setField("done");
  };

  const handleSecretSubmit = () => {
    if (!azureSecretRef.includes(":")) {
      setError("Use secret-name:key format");
      return;
    }
    setError(null);
    setField("done");
  };

  // ===== Backup handlers =====
  const handleBackupFrequencySelect = (item: { value: string }) => {
    if (item.value === CUSTOM_CRON) {
      setField("backup-frequency-custom");
      return;
    }
    setBackupSchedule(item.value);
    setField("backup-retention");
  };

  const handleBackupFrequencyCustomSubmit = () => {
    if (!backupSchedule.trim()) {
      setError("Enter a cron expression or go back to pick a preset");
      return;
    }
    setError(null);
    setField("backup-retention");
  };

  const handleBackupRetentionSubmit = () => {
    const parsed = Number.parseInt(backupRetentionDays, 10);
    if (!Number.isFinite(parsed) || parsed < 2) {
      setError("Retention must be greater than 1 (at least 2 days)");
      return;
    }
    setError(null);
    setField("backup-done");
  };

  // ===== Item builders =====
  const withManual = (
    items: { label: string; value: string }[],
  ): { label: string; value: string }[] => [
    ...items,
    { label: "Enter manually…", value: MANUAL },
  ];

  const renderSelect = (
    items: { label: string; value: string }[],
    onSelect: (item: { value: string }) => void,
    initialIndex = 0,
  ) => (
    <Box marginTop={1} height={10} flexDirection="column" overflowY="hidden">
      <SelectInput
        items={items}
        onSelect={onSelect}
        limit={8}
        initialIndex={initialIndex}
        indicatorComponent={() => null}
        itemComponent={({ isSelected, label }) => (
          <Text color={isSelected ? colors.accent : undefined}>
            {isSelected ? "❯ " : "  "}
            {label}
          </Text>
        )}
      />
    </Box>
  );

  // Summary of what's chosen so far (shown on identity sub-steps).
  const ChosenSummary = () => (
    <Box marginTop={1} flexDirection="column">
      <Box>
        <Text color={colors.success}>✓</Text>
        <Text color="gray">
          {" "}
          {PROVIDERS.find((p) => p.value === provider)?.label}
        </Text>
      </Box>
      <Box>
        <Text color={colors.success}>✓</Text>
        <Text color="gray"> Region: {region}</Text>
      </Box>
      <Box>
        <Text color={colors.success}>✓</Text>
        <Text color="gray">
          {" "}
          {bucketLabel}: {bucket}
        </Text>
      </Box>
    </Box>
  );

  const storageTitle = isSelfHosted ? "Storage & Backups" : "Object Storage";

  return (
    <BorderBox title={storageTitle}>
      <Box flexDirection="column" marginBottom={1}>
        <Text>Configure one bucket/container for all Rulebricks data.</Text>
        <Text color="gray" dimColor>
          Decision logs and database backups are stored as prefixes within it.
        </Text>
      </Box>

      {field === "region-loading" && (
        <Spinner label="Loading available regions..." />
      )}

      {field === "region" && (
        <Box flexDirection="column">
          <Text bold>Select Region</Text>
          <Text color="gray" dimColor>
            Region where decision logs will be stored.
          </Text>
          {renderSelect(
            availableRegions.map((r) => ({ label: r, value: r })),
            handleRegionSelect,
            Math.max(0, availableRegions.indexOf(region)),
          )}
        </Box>
      )}

      {field === "bucket-loading" && (
        <Spinner label={`Loading ${bucketLabel.toLowerCase()}s in ${region}...`} />
      )}

      {field === "bucket" && (
        <Box flexDirection="column">
          <Text bold>
            Select {provider === "azure-blob" ? "Storage Account" : "Bucket"}
          </Text>
          <Text color="gray" dimColor>
            Existing {bucketLabel.toLowerCase()}s in {region}.
          </Text>
          {isRefreshing ? (
            <Box marginTop={1}>
              <Spinner label="Refreshing list..." />
            </Box>
          ) : (
            <>
              {availableBuckets.length === 0 && (
                <Box marginTop={1}>
                  <Text color="yellow">
                    None found in {region}. Press R to refresh or enter manually.
                  </Text>
                </Box>
              )}
              {renderSelect(
                withManual(
                  availableBuckets.map((b) => ({ label: b, value: b })),
                ),
                handleBucketSelect,
                Math.max(
                  0,
                  findClusterSetupDefaultIndex(
                    availableBuckets,
                    "decision-logs-bucket",
                    {
                      provider: providerToCloud(provider),
                      clusterName: state.clusterName,
                    },
                  ),
                ),
              )}
            </>
          )}
          <Box marginTop={1}>
            <Text color="gray" dimColor>
              R to refresh • ↑/↓ to navigate • Enter to select • Esc to change
              region
            </Text>
          </Box>
        </Box>
      )}

      {field === "bucket-manual" && (
        <Box flexDirection="column">
          <Text bold>
            {provider === "azure-blob"
              ? "Storage Account Name"
              : "Bucket Name"}
          </Text>
          <Box marginTop={1}>
            <TextInput
              value={bucket}
              onChange={setBucket}
              onSubmit={handleBucketManualSubmit}
              placeholder={
                provider === "azure-blob" ? "mystorageaccount" : "my-bucket"
              }
            />
          </Box>
        </Box>
      )}

      {field === "s3-role-loading" && (
        <Spinner label="Loading IAM roles..." />
      )}

      {field === "s3-role" && (
        <Box flexDirection="column">
          <Text bold>Select the Rulebricks IAM role</Text>
          <Text color="gray" dimColor>
            The single role from cluster-setup ({`${state.clusterName || "<cluster>"}-rulebricks`}),
            used for all cloud access: decision logs, database backups, and metrics.
          </Text>
          {(() => {
            const recommendedIndex = Math.max(
              0,
              findClusterSetupDefaultIndex(
                availableRoles.map((r) => r.name),
                "decision-logs-identity",
                { provider: "aws", clusterName: state.clusterName },
              ),
            );
            return renderSelect(
              withManual(
                availableRoles.map((r, idx) => ({
                  label:
                    idx === recommendedIndex
                      ? `${r.name}  - recommended`
                      : r.name,
                  value: r.arn,
                })),
              ),
              handleRoleSelect,
              recommendedIndex,
            );
          })()}
          <ChosenSummary />
        </Box>
      )}

      {field === "s3-role-manual" && (
        <Box flexDirection="column">
          <Text bold>S3 IRSA Role ARN</Text>
          <Box marginTop={1}>
            <TextInput
              value={roleArn}
              onChange={setRoleArn}
              onSubmit={handleRoleManualSubmit}
              placeholder="arn:aws:iam::123456789012:role/rulebricks-vector"
            />
          </Box>
          <ChosenSummary />
        </Box>
      )}

      {field === "gcp-sa-loading" && (
        <Spinner label="Loading service accounts..." />
      )}

      {field === "gcp-sa" && (
        <Box flexDirection="column">
          <Text bold>Select the Rulebricks Google service account</Text>
          <Text color="gray" dimColor>
            The single service account from cluster-setup, used for all cloud
            access: decision logs, database backups, and metrics.
          </Text>
          {(() => {
            const recommendedIndex = Math.max(
              0,
              findClusterSetupDefaultIndex(
                availableServiceAccounts.map((s) => s.email),
                "decision-logs-identity",
                { provider: "gcp", clusterName: state.clusterName },
              ),
            );
            return renderSelect(
              withManual(
                availableServiceAccounts.map((s, idx) => ({
                  label:
                    idx === recommendedIndex
                      ? `${s.email}  - recommended`
                      : s.email,
                  value: s.email,
                })),
              ),
              handleServiceAccountSelect,
              recommendedIndex,
            );
          })()}
          <ChosenSummary />
        </Box>
      )}

      {field === "gcp-sa-manual" && (
        <Box flexDirection="column">
          <Text bold>Google Service Account Email</Text>
          <Box marginTop={1}>
            <TextInput
              value={gcpServiceAccount}
              onChange={setGcpServiceAccount}
              onSubmit={handleServiceAccountManualSubmit}
              placeholder="rulebricks-vector@project.iam.gserviceaccount.com"
            />
          </Box>
          <ChosenSummary />
        </Box>
      )}

      {field === "azure-container-loading" && (
        <Spinner label="Loading blob containers..." />
      )}

      {field === "azure-container" && (
        <Box flexDirection="column">
          <Text bold>Select Blob Container</Text>
          <Text color="gray" dimColor>
            Container in {bucket} where decision logs are written.
          </Text>
          {isRefreshing ? (
            <Box marginTop={1}>
              <Spinner label="Refreshing list..." />
            </Box>
          ) : (
            <>
              {availableContainers.length === 0 && (
                <Box marginTop={1}>
                  <Text color="yellow">
                    None found. Press R to refresh or enter manually.
                  </Text>
                </Box>
              )}
              {renderSelect(
                withManual(
                  availableContainers.map((c) => ({ label: c, value: c })),
                ),
                handleContainerSelect,
                Math.max(
                  0,
                  findClusterSetupDefaultIndex(
                    availableContainers,
                    "decision-logs-container",
                    { provider: "azure", clusterName: state.clusterName },
                  ),
                ),
              )}
            </>
          )}
          <Box marginTop={1}>
            <Text color="gray" dimColor>
              R to refresh • ↑/↓ to navigate • Enter to select
            </Text>
          </Box>
        </Box>
      )}

      {field === "azure-container-manual" && (
        <Box flexDirection="column">
          <Text bold>Azure Blob Container</Text>
          <Box marginTop={1}>
            <TextInput
              value={azureContainer}
              onChange={setAzureContainer}
              onSubmit={handleContainerManualSubmit}
              placeholder="rulebricks-logs"
            />
          </Box>
        </Box>
      )}

      {field === "azure-auth" && (
        <Box flexDirection="column">
          <Text bold>Azure Blob Authentication</Text>
          <Text color="gray" dimColor>
            Workload identity is recommended; connection-string Secret is a
            fallback for clusters without Azure Workload Identity.
          </Text>
          {renderSelect(AZURE_AUTH, handleAuthSelect)}
        </Box>
      )}

      {field === "azure-identity-loading" && (
        <Spinner label="Loading managed identities..." />
      )}

      {field === "azure-client" && (
        <Box flexDirection="column">
          <Text bold>Select the Rulebricks workload identity</Text>
          <Text color="gray" dimColor>
            The single identity from cluster-setup ({`${state.clusterName || "<cluster>"}-rulebricks`}),
            used for all cloud access: decision logs, database backups, and metrics.
          </Text>
          {(() => {
            const recommendedIndex = Math.max(
              0,
              findClusterSetupDefaultIndex(
                availableIdentities.map((i) => i.name),
                "decision-logs-identity",
                { provider: "azure", clusterName: state.clusterName },
              ),
            );
            return renderSelect(
              withManual(
                availableIdentities.map((i, idx) => ({
                  label:
                    idx === recommendedIndex
                      ? `${i.name} (${i.clientId})  - recommended`
                      : `${i.name} (${i.clientId})`,
                  value: i.clientId,
                })),
              ),
              handleIdentitySelect,
              recommendedIndex,
            );
          })()}
        </Box>
      )}

      {field === "azure-client-manual" && (
        <Box flexDirection="column">
          <Text bold>Managed Identity Client ID</Text>
          <Box marginTop={1}>
            <TextInput
              value={azureClientId}
              onChange={setAzureClientId}
              onSubmit={handleIdentityManualSubmit}
              placeholder="00000000-0000-0000-0000-000000000000"
            />
          </Box>
        </Box>
      )}

      {field === "azure-tenant" && (
        <Box flexDirection="column">
          <Text bold>Azure Tenant ID</Text>
          <Text color="gray" dimColor>
            {tenantAutoDetected
              ? "Auto-detected from your Azure CLI session - edit if needed."
              : "Tenant ID used by Azure Workload Identity."}
          </Text>
          <Box marginTop={1}>
            <TextInput
              value={azureTenantId}
              onChange={setAzureTenantId}
              onSubmit={handleTenantSubmit}
              placeholder="00000000-0000-0000-0000-000000000000"
            />
          </Box>
        </Box>
      )}

      {field === "azure-secret" && (
        <Box flexDirection="column">
          <Text bold>Azure Connection String Secret</Text>
          <Text color="gray" dimColor>
            Existing Kubernetes Secret key in the format name:key.
          </Text>
          <Box marginTop={1}>
            <TextInput
              value={azureSecretRef}
              onChange={setAzureSecretRef}
              onSubmit={handleSecretSubmit}
              placeholder="azure-blob-logs:connection-string"
            />
          </Box>
        </Box>
      )}

      {field === "done" && (
        <Box flexDirection="column">
          <Text color={colors.success}>Storage backend configured.</Text>
          <Box marginTop={1} flexDirection="column">
            <Text>
              Provider: {PROVIDERS.find((p) => p.value === provider)?.label}
            </Text>
            <Text>
              {bucketLabel}: {bucket}
            </Text>
            <Text>Region: {region}</Text>
            {provider === "azure-blob" && (
              <Text>Container: {azureContainer}</Text>
            )}
          </Box>
          <Box marginTop={1}>
            <Text color={colors.muted}>
              {isSelfHosted
                ? "Press Enter to configure database backups"
                : "Press Enter to continue"}
            </Text>
          </Box>
        </Box>
      )}

      {field === "backup-enabled" && (
        <Box flexDirection="column">
          <Text bold>Database Backups</Text>
          <Text color="gray" dimColor>
            Logical pg_dump backups of the in-cluster Postgres are written to the
            same bucket under the db-backups/ prefix. Restore any time with
            `rulebricks restore {state.name}`.
          </Text>
          <Box marginTop={1}>
            <Text color={colors.accent}>
              {backupEnabled ? "[x]" : "[ ]"} Enable database backups
            </Text>
          </Box>
          <Text color={colors.muted}>Space toggles backups. Enter continues.</Text>
        </Box>
      )}

      {field === "backup-frequency" && (
        <Box flexDirection="column">
          <Text bold>Backup frequency</Text>
          <Text color="gray" dimColor>
            How often a backup is taken (UTC cron).
          </Text>
          {renderSelect(
            BACKUP_FREQUENCY_PRESETS,
            handleBackupFrequencySelect,
            Math.max(
              0,
              BACKUP_FREQUENCY_PRESETS.findIndex(
                (p) => p.value === backupSchedule,
              ),
            ),
          )}
        </Box>
      )}

      {field === "backup-frequency-custom" && (
        <Box flexDirection="column">
          <Text bold>Custom cron schedule</Text>
          <Text color="gray" dimColor>
            Standard cron format (UTC).
          </Text>
          <Box marginTop={1}>
            <TextInput
              value={backupSchedule}
              onChange={setBackupSchedule}
              onSubmit={handleBackupFrequencyCustomSubmit}
              placeholder="0 2 * * *"
            />
          </Box>
        </Box>
      )}

      {field === "backup-retention" && (
        <Box flexDirection="column">
          <Text bold>Retention days</Text>
          <Text color="gray" dimColor>
            Backups older than this are pruned from object storage (must be
            greater than 1).
          </Text>
          <Box marginTop={1}>
            <TextInput
              value={backupRetentionDays}
              onChange={setBackupRetentionDays}
              onSubmit={handleBackupRetentionSubmit}
              placeholder="7"
            />
          </Box>
        </Box>
      )}

      {field === "backup-done" && (
        <Box flexDirection="column">
          <Text color={colors.success}>Database backups configured.</Text>
          <Text>
            Frequency:{" "}
            {BACKUP_FREQUENCY_PRESETS.find((p) => p.value === backupSchedule)
              ?.label || backupSchedule}
          </Text>
          <Text>Retention: {backupRetentionDays} days</Text>
          <Box marginTop={1}>
            <Text color={colors.muted}>Press Enter to continue</Text>
          </Box>
        </Box>
      )}

      {error && (
        <Box marginTop={1}>
          <Text color="red">✗ {error}</Text>
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
