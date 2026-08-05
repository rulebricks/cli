// ============================================================================
// Rulebricks AKS
//
// Run after prerequisites.bicep succeeds and the AKS identity has been granted
// access to the chosen subnet (and any other access called out in that
// deployment's roleRequirements output). Copy that output's resource IDs
// into the parameters below.
//
// Review potential created resources with:
// az deployment group what-if -g <resource-group> --parameters parameters.bicepparam
// ============================================================================

using 'main.bicep'

param clusterName = 'rulebricks'
param location = 'westus'
param environmentName = 'production'
param resourceTags = {
  environment: 'production'
  workload: 'rulebricks'
}

// Empty auto-detects the identity running this ARM deployment and uses it
param operatorPrincipalIds = []

// ================================================

// FROM PREREQUISITES
// Direct outputs from running/completing prerequisites.bicep

param existingAksControlPlaneIdentityId = ''
param existingAksSubnetId = ''
param existingAksPrivateDnsZoneId = ''
param existingPrivateEndpointsSubnetId = ''
param existingPostgresSubnetId = ''
param existingPrivateDnsZoneIds = {
  blob: ''
  keyVault: ''
  acr: ''
  eventHubs: ''
  redis: ''
  postgres: ''
}

// ================================================

// CLUSTER CONFIGURATION
// restrictedPublic needs at least one approved corporate/VPN egress CIDR

param aksApiAccessMode = 'restrictedPublic'
param apiServerAuthorizedIpRanges = []

// Cluster access and lifecycle. Entra RBAC remains opt-in.
param enableEntraRbac = false
param maxNodeCount = 4
param separateSystemPool = true
param enableBurstPool = true
param aksSkuTier = 'Standard'
param availabilityZones = []
param kubernetesUpgradeChannel = 'stable'
param nodeOsUpgradeChannel = 'NodeImage'
param enableMaintenanceWindow = true
param maintenanceDay = 'Sunday'
param maintenanceStartTime = '02:00'

// ================================================

// ROLES
// Same workflow as prerequisites: self-grant (Owner or Contributor+UAA/RBAC Admin
// on this RG) or platform tickets from the roleRequirements output after main.

// These grants are all needed before CLI `rulebricks deploy`

// Below are usually true when you create storage/KV/ACR/monitoring in this RG
// and have Owner/UAA here, leave false for Contributor-only + ticket handoff.

// AKS RBAC Cluster Admin → aksAdminPrincipalIds (only if enableEntraRbac)
param assignAksAdminRoles = false
// Storage Blob Data Contributor → data-access identity
param assignStorageRole = true
// Key Vault Secrets User → external-secrets identity
param assignKeyVaultReaderRole = true
// Key Vault Secrets Officer → CLI operator (secret seeding)
param assignKeyVaultWriterRoles = true
// Monitoring Metrics Publisher → data-access identity
param assignMonitoringPublisherRole = true
// Monitoring Data Reader → Managed Grafana identity
param assignGrafanaReaderRole = true
// AcrPull → kubelet identity (nodes pull mirrored images)
param assignAcrPullRole = true
// ACR Data Importer → CLI operator (image/chart mirror)
param assignAcrImporterRole = true
// FIC Contributor → CLI can bind K8s SAs to the data-access identity
param assignDataAccessFederatedIdentityRoles = true
// FIC Contributor → CLI can bind K8s SAs to the external-secrets identity
param assignExternalSecretsFederatedIdentityRoles = true

// ================================================

// PRIVATE ENDPOINTS / PRIVATE DNS
// On = needs a PE subnet ID above, plus either central Azure Policy DNS
// (privateDnsIntegrationMode='policy') or existingPrivateDnsZoneIds
// ('existingZones')

// Public defaults: no endpoint, subnet, private-zone
param createBlobPrivateEndpoint = false
param enableKeyVaultPrivateEndpoint = false
param enableDataServicePrivateEndpoints = false
param privateDnsIntegrationMode = 'policy'

// ================================================

// STORAGE / MONITORING / KEY VAULT / ACR
// create*=true provisions in this RG
// this is where main.bicep does most resource creation

// Storage is required for decision logs/backups
param createStorage = true
param existingStorageAccountId = ''
// Uncomment to override the account name (taken, or pinning a pre-rename name):
// param storageAccountName = 'rulebricksdata2'
param allowStorageSharedKeyAccess = false
param enableBlobVersioning = true
param blobSoftDeleteRetentionDays = 30
param createStorageDeleteLock = false

// Standard observability: Azure Monitor managed Prometheus + Grafana.
param enableMetricsRemoteWrite = true
param createMonitorWorkspace = true
param createManagedGrafana = true
// Uncomment to override the workspace name (taken, or pinning a pre-rename name):
// param grafanaName = 'rulebricks-grafana2'

// Key Vault-backed secrets. Blank writer overrides use the CLI operator.
param enableKeyVaultIntegration = true
param createKeyVault = true
param existingKeyVaultId = ''
// Uncomment to override the vault name (taken, or pinning a pre-rename name):
// param keyVaultName = 'rulebricks-kv2'
// Change to 'recover' only when redeploying a soft-deleted vault with the
// same keyVaultName after resource-group teardown.
param keyVaultCreateMode = 'default'
param enableKeyVaultPurgeProtection = true
param keyVaultSoftDeleteRetentionDays = 90

// ACR is used for the Rulebricks image/chart mirror
param createContainerRegistry = true
param existingContainerRegistryId = ''
// Uncomment to override the registry name (taken, or pinning a pre-rename name):
// param containerRegistryName = 'rulebricksacr2'
param existingContainerRegistryPermissionMode = 'legacyRbac'
param containerRegistrySku = 'Standard'

// Managed services (Kafka, Redis, Postgres)
// Details are in the main.bicep or corresponding modules/*.bicep file
param createEventHubsNamespace = false
param createRedisEnterprise = false
param createPostgresFlexibleServer = false

// ================================================

// FROM PREREQUISITES
// Prerequisites owns these sensitive resource creations, main only reads

// Public DNS resources are read-only, prerequisites bicep decides resoure creation
param useExternalDns = true
param existingDnsZoneId = ''
param existingExternalDnsIdentityId = ''

// ACS is read-only here; prerequisites bicep decides resource creation
param useManagedEmail = true
param existingCommunicationServiceId = ''
