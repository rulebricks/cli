// ============================================================================
// Rulebricks AKS cluster-setup parameters
//   Find all "REQUIRED" to review each value you must provide before deploying
// ============================================================================

using 'main.bicep'

// ---------------------------------------------------------------------------
// Identity
// ---------------------------------------------------------------------------

param clusterName = 'rulebricks'

// Region for every resource, review quota and availability
param location = 'eastus'

// Tag value + monitoring workspace suffix.
param environmentName = 'production'

// Stamped on every resource this deployment creates.
param resourceTags = {
  environment: 'production'
  workload: 'rulebricks'
}

// ---------------------------------------------------------------------------
// AKS control plane
// ---------------------------------------------------------------------------

// AKS minor version; confirm availability in `location` with
// `az aks get-versions --location <region>`.
param kubernetesVersion = '1.34'

// Free | Standard | Premium. Standard carries the uptime SLA.
param aksSkuTier = 'Standard'

// Private Kubernetes control plane: reachable only via VPN/bastion/peering.
param enablePrivateCluster = true

// CIDR allowlist for a PUBLIC control plane; ignored while the cluster is private.
param apiServerAuthorizedIpRanges = []

// Entra ID + Azure RBAC for Kubernetes authorization instead of local accounts.
param enableEntraRbac = true

// REQUIRED: Entra group or user object IDs granted AKS RBAC Cluster Admin
// (must be non-empty while enableEntraRbac is true).
param aksAdminPrincipalIds = []

// Zone spread for node pools.
param availabilityZones = ['1', '2', '3']

// none | patch | rapid | stable - control-plane auto-upgrade cadence.
param kubernetesUpgradeChannel = 'stable'

// None | NodeImage | SecurityPatch | Unmanaged - node OS patching cadence.
param nodeOsUpgradeChannel = 'NodeImage'

// Constrain auto-upgrades to the window below.
param enableMaintenanceWindow = true
param maintenanceDay = 'Sunday'
param maintenanceStartTime = '02:00'
param maintenanceUtcOffset = '+00:00'

// Azure Policy add-on (audit/enforce cluster policies).
param enableAzurePolicy = true

// CSI Secrets Store driver for Key Vault. The Rulebricks CLI uses the
// External Secrets Operator instead, so this stays off unless you have your
// own CSI consumers.
param enableKeyVaultSecretsProvider = false

// Send AKS control-plane logs (kube-apiserver, kube-audit-admin, guard) to an
// existing Log Analytics workspace - EKS control-plane logging parity.
// Requires controlPlaneLogAnalyticsWorkspaceId.
param enableControlPlaneLogs = false
param controlPlaneLogAnalyticsWorkspaceId = ''

// ---------------------------------------------------------------------------
// Networking
// ---------------------------------------------------------------------------

param vnetAddressSpace = '10.240.0.0/16'
param aksSubnetPrefix = '10.240.0.0/22'
param privateEndpointsSubnetPrefix = '10.240.4.0/24'
// Delegated to PostgreSQL Flexible Server (private access networking).
param postgresSubnetPrefix = '10.240.5.0/24'
// Kubernetes Service CIDR; must not overlap the VNet.
param serviceCidr = '172.16.0.0/16'
param dnsServiceIP = '172.16.0.10'
param podCidr = '192.168.0.0/16'

// Private endpoints for Event Hubs / Redis when those managed services are
// enabled.
param enableDataServicePrivateEndpoints = true

// ---------------------------------------------------------------------------
// Node pools
// ---------------------------------------------------------------------------
// Sizing guidance: the Rulebricks chart's steady-state request floor is
// ~10 vCPU / ~23 GiB; the burst pool absorbs the KEDA-scaled worker fleet.
// D-series v6 (AMD) is the current-generation general-purpose family; v5 or
// compute-optimized F-series are valid substitutes wherever your
// subscription's quota lives.

param nodeCount = 3
// Autoscaling ceiling for the core pool.
param maxNodeCount = 6
param nodeVmSize = 'Standard_D4as_v6'
// 10-250.
param maxPods = 110
// 30-2048 GiB.
param osDiskSizeGB = 64
// Managed | Ephemeral.
param osDiskType = 'Managed'

// Dedicated system pool keeps cluster add-ons off the workload nodes.
param separateSystemPool = true
param systemNodeCount = 3
param systemMaxNodeCount = 3
param systemNodeVmSize = 'Standard_D2as_v6'

// WARM burst pool, labeled/tainted rulebricks.com/pool=burst, for the
// KEDA-scaled worker fleet. burstMinCount keeps at least one node always
// available so scaled-out workers land immediately instead of being absorbed
// into the core pool while a cold node provisions.
param enableBurstPool = true
param burstVmSize = 'Standard_D16as_v6'
param burstMinCount = 1
param burstMaxCount = 4

// ---------------------------------------------------------------------------
// Object storage (decision logs + database backups)
// ---------------------------------------------------------------------------
// The blob container (<clusterName>-data) and the workload identity's access
// to it are always provisioned: decision-log export is required by ClickHouse
// and the in-app log UI.

// false = bring your own account via existingStorageAccount*.
param createStorage = true
param existingStorageAccountName = ''
param existingStorageAccountResourceGroup = ''

// Standard_LRS | Standard_ZRS | Standard_GRS | Standard_GZRS | Standard_RAGZRS.
param storageSkuName = 'Standard_ZRS'

// Shared-key (connection string) auth disabled: workload identity only.
param allowStorageSharedKeyAccess = false
// Versioning + soft-delete give accidental-delete/overwrite recovery.
param enableStorageVersioning = true
// 0-365 days of blob/container soft-delete.
param storageSoftDeleteDays = 30
param enableStoragePrivateEndpoint = true
// Azure resource lock against accidental account deletion.
param enableStorageDeleteLock = true

// ---------------------------------------------------------------------------
// Monitoring (Azure Monitor managed Prometheus + Managed Grafana)
// ---------------------------------------------------------------------------
// On by default: the workspace, DCE/DCR remote_write pipeline, and an Azure
// Managed Grafana wired to the workspace are all provisioned, and the CLI's
// monitoring step discovers the DCE/DCR automatically. Prometheus metrics
// land in Grafana out of the box.

param enableMetricsRemoteWrite = true
// false = reuse an existing Data Collection Rule via existingDataCollectionRule*.
param createMonitorWorkspace = true
param existingDataCollectionRuleName = ''
param existingDataCollectionRuleResourceGroup = ''
param enableManagedGrafana = true

// ---------------------------------------------------------------------------
// DNS (delegated-subdomain model)
// ---------------------------------------------------------------------------
// The template creates the DNS zone below and outputs dnsZoneNameServers.
// Hand those NS records to whoever controls the parent domain for a ONE-TIME
// delegation; afterwards external-dns manages every record and Let's Encrypt
// HTTP-01 issues certificates
// Set your deployment's domain in the Rulebricks CLI to match this zone.

param enableExternalDns = true
// REQUIRED: the deployment's subdomain, e.g. 'rb.corp.com'.
param dnsZoneName = ''
// false = target a pre-existing zone instead (see dnsZoneResourceGroup).
param createDnsZone = true
// Resource group of a PRE-EXISTING zone (createDnsZone=false only).
param dnsZoneResourceGroup = ''

// ---------------------------------------------------------------------------
// Key Vault (External Secrets Operator backend)
// ---------------------------------------------------------------------------

param enableKeyVaultIntegration = true
// false = bring your own vault via keyVaultName + existingKeyVaultResourceGroup.
param createKeyVault = true
param existingKeyVaultResourceGroup = ''
param allowKeyVaultPublicAccess = false
param enableKeyVaultPrivateEndpoint = true
// Purge protection cannot be disabled once enabled.
param enableKeyVaultPurgeProtection = true
// 7-90 days.
param keyVaultSoftDeleteRetentionDays = 90
// REQUIRED: object IDs allowed to create and rotate secrets in the vault
// include whoever runs `rulebricks deploy` (their machine seeds the entries;
// your own object ID: `az ad signed-in-user show --query id -o tsv`).
param keyVaultWriterPrincipalIds = []

// ---------------------------------------------------------------------------
// Container registry (optional image mirror)
// ---------------------------------------------------------------------------

param enableContainerRegistry = true
// Basic | Standard | Premium (Premium is required for private endpoints).
param containerRegistrySku = 'Premium'
param allowContainerRegistryPublicAccess = false
// REQUIRED while enableContainerRegistry is true: your Rulebricks license
// key. It authenticates the registry's pull-through cache of Rulebricks
// images - no seeding or scripts; images cache on first pull. Export before
// deploying:  export LICENSE_KEY='<license-key>'
param rulebricksLicenseKey = readEnvironmentVariable('LICENSE_KEY', '')

// ---------------------------------------------------------------------------
// Managed Kafka (Event Hubs Premium, Kafka-compatible)
// ---------------------------------------------------------------------------

param enableManagedKafka = false
// 1 | 2 | 4 | 8 | 12 | 16 Premium Processing Units.
param eventHubsCapacityUnits = 1
// 1-100 partitions each; keep in sync with the Helm values when enabled.
param solutionPartitions = 64
param logsPartitions = 24
param kafkaRetentionHours = 168

// ---------------------------------------------------------------------------
// Managed Redis (Azure Managed Redis)
// ---------------------------------------------------------------------------

param enableManagedRedis = false
param redisSkuName = 'Balanced_B1'

// ---------------------------------------------------------------------------
// Managed Email (Azure Communication Services) - ON by default
// ---------------------------------------------------------------------------
// Working email is a hard requirement (admin invites, password recovery),
// and most Microsoft-centric enterprises can no longer hand out basic-auth
// SMTP credentials (retired in Exchange Online). ACS is Microsoft's
// replacement: plain SMTP (smtp.azurecomm.net:587) authenticated with an
// Entra app registration. The Rulebricks CLI wires that app up at deploy time
// (it grants the app access to this service, assembles the SMTP username, and
// takes the client secret as the password) - the same model as SSO, so no app
// IDs are needed here. Set false if you already have an SMTP provider
// (Resend, SES, ...).

param enableManagedEmail = true
param emailDataLocation = 'United States'
// Optional branded sender: a domain under dnsZoneName (or the zone itself),
// e.g. 'rb.corp.com' -> DoNotReply@rb.corp.com. Verification DNS records are
// created in the delegated zone automatically; after the first deploy, run
// the emailInitiateVerificationCommands outputs, wait for Verified, and rerun
// the deployment - linking is automatic. Empty = send from the
// instantly-working Azure-managed azurecomm.net address.
param emailCustomDomain = ''

// ---------------------------------------------------------------------------
// Managed PostgreSQL (Flexible Server, private access)
// ---------------------------------------------------------------------------
// On by default: Supabase runs against this managed instance
// (externalServices.postgres in the CLI) instead of an in-cluster database.
// wal_level=logical is configured here and activated automatically -
// `rulebricks deploy` performs the required one-time server restart.

param enableManagedDatabase = true
param postgresVersion = '17'
param postgresAdminUsername = 'rbadmin'
// REQUIRED: export POSTGRES_ADMIN_PASSWORD='<strong-password>'
param postgresAdminPassword = readEnvironmentVariable('POSTGRES_ADMIN_PASSWORD', '')
param postgresSkuName = 'Standard_D4ds_v5'
// Burstable | GeneralPurpose | MemoryOptimized.
param postgresSkuTier = 'GeneralPurpose'
param postgresStorageSizeGB = 128
// Zone-redundant HA standby (roughly doubles cost).
param postgresHighAvailability = true
// 7-35 days of automated backups.
param postgresBackupRetentionDays = 7
