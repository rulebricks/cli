// ============================================================================
// Rulebricks AKS
//
// Run after prerequisites.bicep succeeds and the AKS identity has been granted
// access to the chosen subnet (and any other access called out in that
// deployment's roleRequirements output). Copy that output's resource IDs
// into the parameters below.
//
// Review created resources with:
// az deployment group what-if -g <resource-group> --parameters parameters.bicepparam
// ============================================================================

using 'main.bicep'

param clusterName = 'rulebricks'
param location = 'eastus'
param environmentName = 'production'
param resourceTags = {
  environment: 'production'
  workload: 'rulebricks'
}

// Empty auto-detects the identity running this ARM deployment and uses it for
// both main and Rulebricks CLI phases. Set mainDeployerPrincipalIds and
// cliPrincipalIds directly only when those are different actors.
param operatorPrincipalIds = []

// REQUIRED: outputs from prerequisites.bicep.
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

// REQUIRED: at least one approved corporate/VPN egress CIDR
param aksApiAccessMode = 'restrictedPublic'
param apiServerAuthorizedIpRanges = []

// Cluster access and lifecycle. Entra RBAC remains opt-in.
param enableEntraRbac = false
param maxNodeCount = 4
param separateSystemPool = false
param enableBurstPool = false
param aksSkuTier = 'Free'
param availabilityZones = []
param kubernetesUpgradeChannel = 'stable'
param nodeOsUpgradeChannel = 'NodeImage'
param enableMaintenanceWindow = true
param maintenanceDay = 'Sunday'
param maintenanceStartTime = '02:00'

// Every role write remains independently selectable and off by default.
// This is the external-platform-team handoff path. Owner or Contributor+UAA
// can turn on only the grants they want this deployment to apply.
param assignAksAdminRoles = false
param assignStorageRole = false
param assignKeyVaultReaderRole = false
param assignKeyVaultWriterRoles = false
param assignMonitoringPublisherRole = false
param assignGrafanaReaderRole = false
param assignAcrPullRole = false
param assignAcrImporterRole = false
param assignDataAccessFederatedIdentityRoles = false
param assignExternalSecretsFederatedIdentityRoles = false

// Public defaults: no endpoint, subnet, private-zone
param createBlobPrivateEndpoint = false
param enableKeyVaultPrivateEndpoint = false
param enableDataServicePrivateEndpoints = false
param privateDnsIntegrationMode = 'policy'

// Storage is required for decision logs/backups
param createStorage = true
param existingStorageAccountId = ''
param allowStorageSharedKeyAccess = false
param enableBlobVersioning = true
param blobSoftDeleteRetentionDays = 30
param createStorageDeleteLock = false

// Standard observability: Azure Monitor managed Prometheus + Grafana.
param enableMetricsRemoteWrite = true
param createMonitorWorkspace = true
param createManagedGrafana = true

// Key Vault-backed secrets. Blank writer overrides use the CLI operator.
param enableKeyVaultIntegration = true
param createKeyVault = true
param existingKeyVaultId = ''
// Uncomment and customize if Azure reports the generated global name is in use:
// param keyVaultName = 'rbkv-<globally-unique-name>'
// Change to 'recover' only when redeploying a soft-deleted vault with the
// generated keyVaultName after resource-group teardown.
param keyVaultCreateMode = 'default'
param enableKeyVaultPurgeProtection = true
param keyVaultSoftDeleteRetentionDays = 90

// ACR is used for the Rulebricks image/chart mirror.
param createContainerRegistry = true
param existingContainerRegistryId = ''
param existingContainerRegistryPermissionMode = 'legacyRbac'
param containerRegistrySku = 'Standard'

// Managed services (Kafka, Redis, Postgres)
param createEventHubsNamespace = false
param createRedisEnterprise = false
param createPostgresFlexibleServer = false

// Public DNS resources are read-only references staged in prerequisites.
param useExternalDns = true
param existingDnsZoneId = ''
param existingExternalDnsIdentityId = ''

// ACS is read-only here; prerequisites creates or references it.
param useManagedEmail = true
param existingCommunicationServiceId = ''
