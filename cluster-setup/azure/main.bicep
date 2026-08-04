targetScope = 'resourceGroup'

// ============================================================================
// Rulebricks workload deployment
//
// RESOURCES THIS TEMPLATE CREATES. Every one is behind a parameter named
// create<Thing>, so a parameter file can be reviewed for blast radius without
// reading the template:
//
//   always              Microsoft.ContainerService/managedClusters (AKS)
//                       Microsoft.ManagedIdentity/userAssignedIdentities (x1-2)
//   createStorage       Microsoft.Storage/storageAccounts + one blob container
//   createKeyVault      Microsoft.KeyVault/vaults
//   createMonitorWorkspace
//                       Microsoft.Monitor/accounts + a DCE/DCR pair
//   createManagedGrafana
//                       Microsoft.Dashboard/grafana
//   createContainerRegistry
//                       Microsoft.ContainerRegistry/registries
//   createEventHubsNamespace
//                       Microsoft.EventHub/namespaces
//   createRedisEnterprise
//                       Microsoft.Cache/redisEnterprise
//   createPostgresFlexibleServer
//                       Microsoft.DBforPostgreSQL/flexibleServers
//   createBlobPrivateEndpoint, enableKeyVaultPrivateEndpoint,
//   enableDataServicePrivateEndpoints
//                       Microsoft.Network/privateEndpoints
//   createStorageDeleteLock
//                       Microsoft.Authorization/locks
//   assign<Role>        independently selected workload role assignments
//
// It does NOT create, under any parameter combination:
//   - VNets, subnets, or private DNS zones/links. They are staged by
//     prerequisites.bicep or supplied by organization-owned resource ID.
//   - Any Azure Communication Services resource. See createAcsEmail there.
//   - DNS zones or the external-dns identity. See prerequisites.bicep.
//   - Anything at all in a bring-your-own resource's configuration: the
//     existing* paths assign roles and change nothing else.
//
// Preview the exact blast radius of a parameter file before running it:
//   az deployment group what-if -g <rg> --template-file main.bicep \
//     --parameters parameters.bicepparam
//
// parameters.bicepparam is the single organized deployment profile. Role
// writes remain off by default even though the standard workload features are
// enabled.
// ============================================================================
param clusterName string = 'rulebricks-cluster'
param location string = resourceGroup().location
param environmentName string = 'test'
param resourceTags object = {
  environment: environmentName
  workload: 'rulebricks'
}

param kubernetesVersion string = '1.34'

@allowed([
  'Free'
  'Standard'
  'Premium'
])
param aksSkuTier string = 'Free'

@allowed([
  'restrictedPublic'
  'privateWithAzureDns'
  'privateWithPublicFqdn'
  'privateWithExistingDns'
])
@description('AKS API exposure. restrictedPublic requires approved apiServerAuthorizedIpRanges. Private modes explicitly select Azure-managed DNS, a public FQDN for the private endpoint, or an existing private DNS zone.')
param aksApiAccessMode string = 'restrictedPublic'

@description('Existing AKS private DNS zone resource ID. Required only for privateWithExistingDns; the AKS identity needs Private DNS Zone Contributor on it.')
param existingAksPrivateDnsZoneId string = ''

param apiServerAuthorizedIpRanges array = []
param enableEntraRbac bool = false

@description('Entra group or user object IDs granted AKS RBAC Cluster Admin.')
param aksAdminPrincipalIds array = []
param availabilityZones array = []

@allowed([
  'none'
  'patch'
  'rapid'
  'stable'
])
param kubernetesUpgradeChannel string = 'none'

@allowed([
  'None'
  'NodeImage'
  'SecurityPatch'
  'Unmanaged'
])
param nodeOsUpgradeChannel string = 'None'

param enableMaintenanceWindow bool = false

@allowed([
  'Monday'
  'Tuesday'
  'Wednesday'
  'Thursday'
  'Friday'
  'Saturday'
  'Sunday'
])
param maintenanceDay string = 'Sunday'
param maintenanceStartTime string = '02:00'
param maintenanceUtcOffset string = '+00:00'
param enableAzurePolicy bool = false
param enableKeyVaultSecretsProvider bool = false
@description('Send AKS control-plane logs (kube-apiserver, kube-audit-admin, guard) to an existing Log Analytics workspace - EKS control-plane logging parity. Requires controlPlaneLogAnalyticsWorkspaceId.')
param enableControlPlaneLogs bool = false
param controlPlaneLogAnalyticsWorkspaceId string = ''

// ---------------------------------------------------------------------------
// Role assignments
//
// Creating a role assignment needs Microsoft.Authorization/roleAssignments/
// write, which Contributor does not include. The Contributor-safe profile
// leaves this off; a privileged platform owner applies the documented grants
// after main and before `rulebricks deploy`.
// ---------------------------------------------------------------------------

@description('Assign AKS RBAC Cluster Admin to aksAdminPrincipalIds when Entra RBAC is enabled.')
param assignAksAdminRoles bool = false

@description('Assign Storage Blob Data Contributor to the data-access identity.')
param assignStorageRole bool = false

@description('Assign Key Vault Secrets User to the external-secrets identity.')
param assignKeyVaultReaderRole bool = false

@description('Assign Key Vault Secrets Officer to keyVaultWriterPrincipalIds.')
param assignKeyVaultWriterRoles bool = false

@description('Assign Monitoring Metrics Publisher to the data-access identity.')
param assignMonitoringPublisherRole bool = false

@description('Assign Monitoring Data Reader to template-created Managed Grafana.')
param assignGrafanaReaderRole bool = false

@description('Assign the appropriate registry pull role to the AKS kubelet identity.')
param assignAcrPullRole bool = false

@description('Assign Container Registry Data Importer and Data Reader to cliPrincipalIds for the CLI mirror flow.')
param assignAcrImporterRole bool = false

@description('Common operator object IDs for deployment and CLI phases. Empty auto-detects the current ARM deployment principal. Use the phase-specific lists only when the actors differ.')
param operatorPrincipalIds array = []

@allowed([
  'User'
  'Group'
  'ServicePrincipal'
])
@description('Principal type for explicitly supplied operatorPrincipalIds. Auto-detected as User or ServicePrincipal when operatorPrincipalIds is empty.')
param operatorPrincipalType string = 'User'

@description('Optional override for principals that deploy main.bicep. Empty uses the common operator.')
param mainDeployerPrincipalIds array = []

@description('Optional override for principals that run the Rulebricks CLI. Empty uses the common operator.')
param cliPrincipalIds array = []

@allowed([
  'User'
  'Group'
  'ServicePrincipal'
])
param cliPrincipalType string = 'User'

@description('Deprecated compatibility fallback. When an actor-specific principal list is empty, these IDs are used for that actor.')
param deployerPrincipalIds array = []

@allowed([
  'User'
  'Group'
  'ServicePrincipal'
])
param deployerPrincipalType string = 'User'

@description('Assign federated-identity-credential write access to cliPrincipalIds on the data-access identity.')
param assignDataAccessFederatedIdentityRoles bool = false

@description('Assign federated-identity-credential write access to cliPrincipalIds on the external-secrets identity.')
param assignExternalSecretsFederatedIdentityRoles bool = false

// ---------------------------------------------------------------------------
// Networking: REFERENCES ONLY
//
// This template cannot create a VNet or a subnet. Address space is centrally
// allocated in most organizations, and a VNet created where one should have
// been requested is discovered late and expensive to unwind. Point these at
// subnets your network team allocated, or set networkMode = 'createVnet' in
// prerequisites.bicep and copy its mainDeploymentParameters output.
// ---------------------------------------------------------------------------

@description('REQUIRED. Resource ID of the AKS control-plane user-assigned identity staged by prerequisites.bicep. A subnet owner must grant it Network Contributor before this deployment.')
param existingAksControlPlaneIdentityId string = ''

@description('REQUIRED. Resource ID of the subnet AKS nodes are placed in. With Cilium overlay only node NICs consume addresses; /26 is recommended for the shipped non-production node maxima and upgrade surge.')
param existingAksSubnetId string = ''

@description('Resource ID of the subnet private endpoints are created in. Required only when a private endpoint is enabled. Azure requires private-endpoint network policies to be disabled on it.')
param existingPrivateEndpointsSubnetId string = ''

@description('Resource ID of the subnet the PostgreSQL Flexible Server is injected into. Required only when createPostgresFlexibleServer is true. Must be delegated to Microsoft.DBforPostgreSQL/flexibleServers and hold no other resources.')
param existingPostgresSubnetId string = ''

@description('Kubernetes-internal service address range. Never appears on your network, but must not overlap the VNet or anything routed to it.')
param serviceCidr string = '172.16.0.0/16'

@description('Cluster DNS service address; must fall inside serviceCidr.')
param dnsServiceIP string = '172.16.0.10'

@description('Kubernetes-internal pod address range (Cilium overlay). Never appears on your network, but must not overlap the VNet or anything routed to it.')
param podCidr string = '192.168.0.0/16'

@description('CREATES private endpoints for Event Hubs, Redis, and the container registry in existingPrivateEndpointsSubnetId, and disables their public access.')
param enableDataServicePrivateEndpoints bool = false

type PrivateDnsZoneIds = {
  blob: string
  keyVault: string
  acr: string
  eventHubs: string
  redis: string
  postgres: string
}

@allowed([
  'policy'
  'existingZones'
])
@description('policy creates endpoints without DNS zone groups for central Azure Policy to register. existingZones creates zone groups using existingPrivateDnsZoneIds and requires privateDnsZones/join/action on those zones. This template never creates or links zones.')
param privateDnsIntegrationMode string = 'policy'

@description('Organization-owned private DNS zone IDs. Required per enabled service in existingZones mode; postgres is always required when managed PostgreSQL is created.')
param existingPrivateDnsZoneIds PrivateDnsZoneIds = {
  blob: ''
  keyVault: ''
  acr: ''
  eventHubs: ''
  redis: ''
  postgres: ''
}

param nodeCount int = 3
param maxNodeCount int = 4
// D-series v6 (AMD): current-generation general purpose, available across
// zones in the mainstream regions and overlapping PostgreSQL Flexible Server
// availability. v5 remains a drop-in substitute where a subscription has
// quota there instead.
param nodeVmSize string = 'Standard_D4as_v6'

@minValue(10)
@maxValue(250)
param maxPods int = 110

@minValue(30)
@maxValue(2048)
param osDiskSizeGB int = 64

@allowed([
  'Managed'
  'Ephemeral'
])
param osDiskType string = 'Managed'

param separateSystemPool bool = false
param systemNodeCount int = 3
param systemMaxNodeCount int = 3
param systemNodeVmSize string = 'Standard_D2as_v6'

param enableBurstPool bool = false
param burstVmSize string = 'Standard_D16as_v6'
// WARM burst pool: at least one burst node stays available so the KEDA-scaled
// worker fleet lands there immediately instead of being absorbed into the
// core pool while a cold node provisions. Set 0 only if you accept that
// scale-up latency.
param burstMinCount int = 1
param burstMaxCount int = 4

@description('CREATES a storage account. False = bring your own via existingStorageAccountId; this template then only assigns workload access and changes nothing else about the account.')
param createStorage bool = true

@description('Full storage-account resource ID when createStorage is false. Every created-account setting below is ignored for this read-only BYO path.')
param existingStorageAccountId string = ''
// Fixed convention the CLI detects (clusterSetupDefaults.ts): one container
// holding the decision-logs/ and db-backups/ prefixes. Not parameterized -
// decision-log export is required by ClickHouse and the in-app log UI, so
// there is no deployment without this container.
var dataContainerName = '${clusterName}-data'

@allowed([
  'Standard_LRS'
  'Standard_ZRS'
  'Standard_GRS'
  'Standard_GZRS'
  'Standard_RAGZRS'
])
param storageSkuName string = 'Standard_LRS'

@description('Applies only to a created account. False disables connection-string auth, leaving workload identity as the only way in.')
param allowStorageSharedKeyAccess bool = true

@description('Applies only to a created account. Keeps previous versions of overwritten blobs, at the cost of storing them.')
param enableBlobVersioning bool = false

@description('Applies only to a created account. Blob and container SOFT DELETE: how many days a deleted blob stays recoverable before Azure removes it for good. This deletes nothing - it is purely a recovery window, and 0 turns it off. It cannot affect any account this template did not create.')
@minValue(0)
@maxValue(365)
param blobSoftDeleteRetentionDays int = 7

@description('CREATES a private endpoint for the storage account in existingPrivateEndpointsSubnetId, and disables its public access.')
param createBlobPrivateEndpoint bool = false

@description('CREATES a CanNotDelete lock on the storage account. The lock must be removed by hand before the resource group can ever be deleted.')
param createStorageDeleteLock bool = false

@description('Ships cluster Prometheus metrics to Azure Monitor. Needs either a workspace created here or an existing Data Collection Rule.')
param enableMetricsRemoteWrite bool = false

@description('CREATES an Azure Monitor workspace with its Data Collection Endpoint and Rule. False = reuse existingDataCollectionRuleId.')
param createMonitorWorkspace bool = true
param existingDataCollectionRuleId string = ''

@description('CREATES an Azure Managed Grafana instance wired to the monitor workspace. Skip it if your organization already runs Grafana.')
param createManagedGrafana bool = false
param grafanaName string = take('rbgraf${take(uniqueString(resourceGroup().id), 6)}', 23)

@description('Use organization-owned public DNS resources staged by prerequisites.bicep.')
param useExternalDns bool = false

@description('Full public DNS zone resource ID. Required when useExternalDns is true.')
param existingDnsZoneId string = ''

@description('Full external-dns user-assigned identity resource ID. Required when useExternalDns is true.')
param existingExternalDnsIdentityId string = ''

// Key Vault settings below apply ONLY to a vault this template creates
// (createKeyVault = true). Bring-your-own vaults go through
// key-vault-role.bicep, which can assign the reader/writer roles and touches
// no other property of the vault - its access policies, network rules, soft
// delete, and purge protection are all left exactly as they are.
@description('Store Rulebricks secrets in Key Vault, read by the External Secrets Operator. False = the CLI manages them as Kubernetes Secrets instead, needing no vault.')
param enableKeyVaultIntegration bool = false

@description('CREATES a Key Vault. False = bring your own via existingKeyVaultId, whose settings this template never modifies.')
param createKeyVault bool = true
param keyVaultName string = take('rbkv${uniqueString(resourceGroup().id, clusterName)}', 24)
@allowed([
  'default'
  'recover'
])
@description('Set to recover only when keyVaultName exists in Azure soft-deleted state after teardown.')
param keyVaultCreateMode string = 'default'
param existingKeyVaultId string = ''

@description('CREATES a private endpoint for a created vault in existingPrivateEndpointsSubnetId.')
param enableKeyVaultPrivateEndpoint bool = false

@description('Applies only to a created vault. Blocks permanent deletion of the vault and its secrets until the retention window elapses. IRREVERSIBLE once on: Azure does not allow turning purge protection back off.')
param enableKeyVaultPurgeProtection bool = false

@description('Applies only to a created vault. Key Vault soft delete is mandatory on every Azure vault and cannot be switched off; this only sets how long a DELETED secret stays recoverable before purging. It never deletes or expires a secret that is in use, and it cannot affect a vault this template did not create.')
@minValue(7)
@maxValue(90)
param keyVaultSoftDeleteRetentionDays int = 7

@description('Optional Key Vault Secrets Officer overrides. Empty grants/reports the CLI principals so the same operator can seed and rotate entries.')
param keyVaultWriterPrincipalIds array = []

// Fixed convention: the ServiceAccount name the CLI's ESO manifests create
// (ESO_READER_SERVICE_ACCOUNT in the CLI). The CLI creates the
// namespace-scoped federated credential for it at deploy time.
var esoServiceAccountName = 'rulebricks-secrets-reader'

@description('CREATES a plain Azure Container Registry. The Rulebricks CLI mirrors images and the helm chart into it; this template stores no registry credentials.')
param createContainerRegistry bool = false

@description('Existing Azure Container Registry resource ID when createContainerRegistry is false. Empty disables ACR integration.')
param existingContainerRegistryId string = ''

@allowed([
  'legacyRbac'
  'rbacAbac'
])
@description('Permission mode of an existing ACR. legacyRbac uses AcrPull; rbacAbac uses Container Registry Repository Reader.')
param existingContainerRegistryPermissionMode string = 'legacyRbac'

param containerRegistryName string = take(
  '${replace(replace(toLower(clusterName), '-', ''), '_', '')}acr${uniqueString(resourceGroup().id)}',
  50
)

@allowed([
  'Basic'
  'Standard'
  'Premium'
])
param containerRegistrySku string = 'Standard'

@description('CREATES an Event Hubs Premium namespace used through its Kafka-compatible endpoint. False = Kafka runs in-cluster, which needs no Azure resource.')
param createEventHubsNamespace bool = false
param eventHubsNamespaceName string = '${toLower(clusterName)}-kafka-${take(uniqueString(resourceGroup().id), 6)}'

@allowed([
  1
  2
  4
  8
  12
  16
])
param eventHubsCapacityUnits int = 1

// Fixed convention: must equal the Helm chart's topic prefix, so it is not an
// operator knob.
var kafkaTopicPrefix = 'com.rulebricks.'

@minValue(1)
@maxValue(100)
param solutionPartitions int = 64

@minValue(1)
@maxValue(100)
param logsPartitions int = 24

param kafkaRetentionHours int = 168

@description('CREATES an Azure Managed Redis (Redis Enterprise) cache. False = Valkey runs in-cluster, which needs no Azure resource.')
param createRedisEnterprise bool = false
param redisName string = '${toLower(clusterName)}-redis-${take(uniqueString(resourceGroup().id), 6)}'
param redisSkuName string = 'Balanced_B1'

// Azure Communication Services Email: SMTP-compatible email for tenants where
// Exchange Online basic-auth SMTP is retired. The app keeps plain SMTP config;
// credentials come from an Entra app registration the Rulebricks CLI wires up
// at deploy time, the same model as SSO, so no app IDs are needed here.
//
// THIS TEMPLATE CREATES NO ACS RESOURCES. Every one of them - the email
// service, its sender domains, and the communication service - is created by
// prerequisites.bicep under its createAcsEmail flag, or already exists because
// your organization runs ACS. All this parameter does is read the resource
// name so it can be surfaced to the CLI.
@description('READ-ONLY reference to an existing Azure Communication Services resource. Creates nothing. False = supply SMTP credentials from any other provider to `rulebricks init` instead.')
param useManagedEmail bool = false

@description('Full communication-service resource ID from prerequisites.bicep. Reader on it is sufficient.')
param existingCommunicationServiceId string = ''

@description('CREATES a PostgreSQL Flexible Server injected into existingPostgresSubnetId. False = Supabase runs its database in-cluster, which needs no Azure resource and no delegated subnet.')
param createPostgresFlexibleServer bool = false
param postgresServerName string = '${toLower(clusterName)}-pg-${take(uniqueString(resourceGroup().id), 6)}'

@description('PostgreSQL MAJOR version. Azure manages the minor version and patches it during maintenance, so it cannot be pinned. 18 has been GA on Flexible Server since January 2026.')
param postgresVersion string = '18'
param postgresAdminUsername string = 'rbadmin'

@secure()
param postgresAdminPassword string = ''

param postgresSkuName string = 'Standard_D4ds_v5'

@allowed([
  'Burstable'
  'GeneralPurpose'
  'MemoryOptimized'
])
param postgresSkuTier string = 'GeneralPurpose'

param postgresStorageSizeGB int = 128
param postgresHighAvailability bool = true

@minValue(7)
@maxValue(35)
param postgresBackupRetentionDays int = 7

var storageIdSegments = split(existingStorageAccountId, '/')
var existingStorageSubscriptionId = length(storageIdSegments) > 8
  ? storageIdSegments[2]
  : subscription().subscriptionId
var existingStorageResourceGroup = length(storageIdSegments) > 8
  ? storageIdSegments[4]
  : resourceGroup().name
var existingStorageName = length(storageIdSegments) > 8 ? storageIdSegments[8] : ''
var existingStorageType = length(storageIdSegments) > 8
  ? '${toLower(storageIdSegments[6])}/${toLower(storageIdSegments[7])}'
  : ''
var generatedStorageAccountName = take('rb${uniqueString(resourceGroup().id, clusterName)}', 24)
var effectiveStorageAccountId = createStorage
  ? resourceId('Microsoft.Storage/storageAccounts', generatedStorageAccountName)
  : existingStorageAccountId
var effectiveStorageSubscriptionId = createStorage
  ? subscription().subscriptionId
  : existingStorageSubscriptionId
var effectiveStorageResourceGroup = createStorage
  ? resourceGroup().name
  : existingStorageResourceGroup

var dcrIdSegments = split(existingDataCollectionRuleId, '/')
var existingDcrSubscriptionId = length(dcrIdSegments) > 8
  ? dcrIdSegments[2]
  : subscription().subscriptionId
var existingDcrResourceGroup = length(dcrIdSegments) > 8 ? dcrIdSegments[4] : resourceGroup().name
var existingDcrName = length(dcrIdSegments) > 8 ? dcrIdSegments[8] : ''
var existingDcrType = length(dcrIdSegments) > 8
  ? '${toLower(dcrIdSegments[6])}/${toLower(dcrIdSegments[7])}'
  : ''
var effectiveDcrSubscriptionId = createMonitorWorkspace
  ? subscription().subscriptionId
  : existingDcrSubscriptionId
var effectiveDcrResourceGroup = createMonitorWorkspace
  ? resourceGroup().name
  : existingDcrResourceGroup
var effectiveDataCollectionRuleId = createMonitorWorkspace
  ? resourceId('Microsoft.Insights/dataCollectionRules', '${clusterName}-dcr')
  : existingDataCollectionRuleId

var keyVaultIdSegments = split(existingKeyVaultId, '/')
var existingKeyVaultSubscriptionId = length(keyVaultIdSegments) > 8
  ? keyVaultIdSegments[2]
  : subscription().subscriptionId
var existingKeyVaultResourceGroup = length(keyVaultIdSegments) > 8
  ? keyVaultIdSegments[4]
  : resourceGroup().name
var existingKeyVaultName = length(keyVaultIdSegments) > 8 ? keyVaultIdSegments[8] : ''
var existingKeyVaultType = length(keyVaultIdSegments) > 8
  ? '${toLower(keyVaultIdSegments[6])}/${toLower(keyVaultIdSegments[7])}'
  : ''
var effectiveKeyVaultSubscriptionId = createKeyVault
  ? subscription().subscriptionId
  : existingKeyVaultSubscriptionId
var effectiveKeyVaultResourceGroup = createKeyVault
  ? resourceGroup().name
  : existingKeyVaultResourceGroup
var effectiveKeyVaultName = createKeyVault ? keyVaultName : existingKeyVaultName
var effectiveKeyVaultId = createKeyVault
  ? resourceId('Microsoft.KeyVault/vaults', keyVaultName)
  : existingKeyVaultId

var containerRegistryIdSegments = split(existingContainerRegistryId, '/')
var existingContainerRegistrySubscriptionId = length(containerRegistryIdSegments) > 8
  ? containerRegistryIdSegments[2]
  : subscription().subscriptionId
var existingContainerRegistryResourceGroup = length(containerRegistryIdSegments) > 8
  ? containerRegistryIdSegments[4]
  : resourceGroup().name
var existingContainerRegistryName = length(containerRegistryIdSegments) > 8
  ? containerRegistryIdSegments[8]
  : ''
var existingContainerRegistryType = length(containerRegistryIdSegments) > 8
  ? '${toLower(containerRegistryIdSegments[6])}/${toLower(containerRegistryIdSegments[7])}'
  : ''
var useContainerRegistry = createContainerRegistry || !empty(existingContainerRegistryId)
var effectiveContainerRegistryId = createContainerRegistry
  ? resourceId('Microsoft.ContainerRegistry/registries', containerRegistryName)
  : existingContainerRegistryId
var effectiveContainerRegistryName = createContainerRegistry
  ? containerRegistryName
  : existingContainerRegistryName
var effectiveContainerRegistryPullRoleName = !createContainerRegistry && existingContainerRegistryPermissionMode == 'rbacAbac'
  ? 'Container Registry Repository Reader'
  : 'AcrPull'

var dnsZoneIdSegments = split(existingDnsZoneId, '/')
var dnsZoneSubscriptionId = length(dnsZoneIdSegments) > 8
  ? dnsZoneIdSegments[2]
  : subscription().subscriptionId
var existingDnsZoneResourceGroup = length(dnsZoneIdSegments) > 8
  ? dnsZoneIdSegments[4]
  : resourceGroup().name
var dnsZoneName = length(dnsZoneIdSegments) > 8 ? dnsZoneIdSegments[8] : ''
var existingDnsZoneType = length(dnsZoneIdSegments) > 8
  ? '${toLower(dnsZoneIdSegments[6])}/${toLower(dnsZoneIdSegments[7])}'
  : ''

var externalDnsIdentityIdSegments = split(existingExternalDnsIdentityId, '/')
var externalDnsIdentitySubscriptionId = length(externalDnsIdentityIdSegments) > 8
  ? externalDnsIdentityIdSegments[2]
  : subscription().subscriptionId
var externalDnsIdentityResourceGroup = length(externalDnsIdentityIdSegments) > 8
  ? externalDnsIdentityIdSegments[4]
  : resourceGroup().name
var externalDnsIdentityName = length(externalDnsIdentityIdSegments) > 8
  ? externalDnsIdentityIdSegments[8]
  : ''
var existingExternalDnsIdentityType = length(externalDnsIdentityIdSegments) > 8
  ? '${toLower(externalDnsIdentityIdSegments[6])}/${toLower(externalDnsIdentityIdSegments[7])}'
  : ''

var communicationServiceIdSegments = split(existingCommunicationServiceId, '/')
var communicationServiceSubscriptionId = length(communicationServiceIdSegments) > 8
  ? communicationServiceIdSegments[2]
  : subscription().subscriptionId
var communicationServiceResourceGroup = length(communicationServiceIdSegments) > 8
  ? communicationServiceIdSegments[4]
  : resourceGroup().name
var communicationServiceName = length(communicationServiceIdSegments) > 8
  ? communicationServiceIdSegments[8]
  : ''
var existingCommunicationServiceType = length(communicationServiceIdSegments) > 8
  ? '${toLower(communicationServiceIdSegments[6])}/${toLower(communicationServiceIdSegments[7])}'
  : ''

var aksSubnetIdSegments = split(existingAksSubnetId, '/')
var privateEndpointsSubnetIdSegments = split(existingPrivateEndpointsSubnetId, '/')
var postgresSubnetIdSegments = split(existingPostgresSubnetId, '/')
var aksPrivateDnsZoneIdSegments = split(existingAksPrivateDnsZoneId, '/')
var blobPrivateDnsZoneIdSegments = split(existingPrivateDnsZoneIds.blob, '/')
var keyVaultPrivateDnsZoneIdSegments = split(existingPrivateDnsZoneIds.keyVault, '/')
var acrPrivateDnsZoneIdSegments = split(existingPrivateDnsZoneIds.acr, '/')
var eventHubsPrivateDnsZoneIdSegments = split(existingPrivateDnsZoneIds.eventHubs, '/')
var redisPrivateDnsZoneIdSegments = split(existingPrivateDnsZoneIds.redis, '/')
var postgresPrivateDnsZoneIdSegments = split(existingPrivateDnsZoneIds.postgres, '/')
var aksVnetSubscriptionId = length(aksSubnetIdSegments) > 10
  ? aksSubnetIdSegments[2]
  : subscription().subscriptionId
var aksVnetResourceGroup = length(aksSubnetIdSegments) > 10
  ? aksSubnetIdSegments[4]
  : resourceGroup().name
var aksVnetName = length(aksSubnetIdSegments) > 10 ? aksSubnetIdSegments[8] : 'invalid-vnet-id'
var aksVnetId = resourceId(
  aksVnetSubscriptionId,
  aksVnetResourceGroup,
  'Microsoft.Network/virtualNetworks',
  aksVnetName
)
var aksSubnetType = length(aksSubnetIdSegments) > 10
  ? '${toLower(aksSubnetIdSegments[6])}/${toLower(aksSubnetIdSegments[7])}/${toLower(aksSubnetIdSegments[9])}'
  : ''
var privateEndpointsSubnetType = length(privateEndpointsSubnetIdSegments) > 10
  ? '${toLower(privateEndpointsSubnetIdSegments[6])}/${toLower(privateEndpointsSubnetIdSegments[7])}/${toLower(privateEndpointsSubnetIdSegments[9])}'
  : ''
var postgresSubnetType = length(postgresSubnetIdSegments) > 10
  ? '${toLower(postgresSubnetIdSegments[6])}/${toLower(postgresSubnetIdSegments[7])}/${toLower(postgresSubnetIdSegments[9])}'
  : ''
var aksPrivateDnsZoneType = length(aksPrivateDnsZoneIdSegments) > 8
  ? '${toLower(aksPrivateDnsZoneIdSegments[6])}/${toLower(aksPrivateDnsZoneIdSegments[7])}'
  : ''
var blobPrivateDnsZoneType = length(blobPrivateDnsZoneIdSegments) > 8
  ? '${toLower(blobPrivateDnsZoneIdSegments[6])}/${toLower(blobPrivateDnsZoneIdSegments[7])}'
  : ''
var blobPrivateDnsZoneName = length(blobPrivateDnsZoneIdSegments) > 8 ? toLower(blobPrivateDnsZoneIdSegments[8]) : ''
var keyVaultPrivateDnsZoneType = length(keyVaultPrivateDnsZoneIdSegments) > 8
  ? '${toLower(keyVaultPrivateDnsZoneIdSegments[6])}/${toLower(keyVaultPrivateDnsZoneIdSegments[7])}'
  : ''
var keyVaultPrivateDnsZoneName = length(keyVaultPrivateDnsZoneIdSegments) > 8
  ? toLower(keyVaultPrivateDnsZoneIdSegments[8])
  : ''
var acrPrivateDnsZoneType = length(acrPrivateDnsZoneIdSegments) > 8
  ? '${toLower(acrPrivateDnsZoneIdSegments[6])}/${toLower(acrPrivateDnsZoneIdSegments[7])}'
  : ''
var acrPrivateDnsZoneName = length(acrPrivateDnsZoneIdSegments) > 8 ? toLower(acrPrivateDnsZoneIdSegments[8]) : ''
var eventHubsPrivateDnsZoneType = length(eventHubsPrivateDnsZoneIdSegments) > 8
  ? '${toLower(eventHubsPrivateDnsZoneIdSegments[6])}/${toLower(eventHubsPrivateDnsZoneIdSegments[7])}'
  : ''
var eventHubsPrivateDnsZoneName = length(eventHubsPrivateDnsZoneIdSegments) > 8
  ? toLower(eventHubsPrivateDnsZoneIdSegments[8])
  : ''
var redisPrivateDnsZoneType = length(redisPrivateDnsZoneIdSegments) > 8
  ? '${toLower(redisPrivateDnsZoneIdSegments[6])}/${toLower(redisPrivateDnsZoneIdSegments[7])}'
  : ''
var redisPrivateDnsZoneName = length(redisPrivateDnsZoneIdSegments) > 8
  ? toLower(redisPrivateDnsZoneIdSegments[8])
  : ''
var postgresPrivateDnsZoneType = length(postgresPrivateDnsZoneIdSegments) > 8
  ? '${toLower(postgresPrivateDnsZoneIdSegments[6])}/${toLower(postgresPrivateDnsZoneIdSegments[7])}'
  : ''
var postgresPrivateDnsZoneName = length(postgresPrivateDnsZoneIdSegments) > 8
  ? toLower(postgresPrivateDnsZoneIdSegments[8])
  : ''

var hasPublicDnsResourceIds = existingDnsZoneType == 'microsoft.network/dnszones' && existingExternalDnsIdentityType == 'microsoft.managedidentity/userassignedidentities'
var autoDetectedOperatorPrincipalIds = [
  deployer().objectId
]
var commonOperatorPrincipalIds = !empty(operatorPrincipalIds)
  ? operatorPrincipalIds
  : (!empty(deployerPrincipalIds) ? deployerPrincipalIds : autoDetectedOperatorPrincipalIds)
var commonOperatorPrincipalType = !empty(operatorPrincipalIds)
  ? operatorPrincipalType
  : (!empty(deployerPrincipalIds)
      ? deployerPrincipalType
      : (!empty(deployer().userPrincipalName) ? 'User' : 'ServicePrincipal'))
var effectiveMainDeployerPrincipalIds = !empty(mainDeployerPrincipalIds)
  ? mainDeployerPrincipalIds
  : commonOperatorPrincipalIds
var effectiveCliPrincipalIds = !empty(cliPrincipalIds) ? cliPrincipalIds : commonOperatorPrincipalIds
var effectiveCliPrincipalType = !empty(cliPrincipalIds) ? cliPrincipalType : commonOperatorPrincipalType
var effectiveKeyVaultWriterPrincipalIds = !empty(keyVaultWriterPrincipalIds)
  ? keyVaultWriterPrincipalIds
  : effectiveCliPrincipalIds
var createStoragePrivateEndpoint = createStorage && createBlobPrivateEndpoint
var createKeyVaultPrivateEndpoint = enableKeyVaultIntegration && createKeyVault && enableKeyVaultPrivateEndpoint
var createAcrPrivateEndpoint = enableDataServicePrivateEndpoints && createContainerRegistry
var createEventHubsPrivateEndpoint = enableDataServicePrivateEndpoints && createEventHubsNamespace
var createRedisPrivateEndpoint = enableDataServicePrivateEndpoints && createRedisEnterprise
var createAnyPrivateEndpoint = createStoragePrivateEndpoint || createKeyVaultPrivateEndpoint || createAcrPrivateEndpoint || createEventHubsPrivateEndpoint || createRedisPrivateEndpoint
var keyVaultIntegrationCanCreateEndpoint = enableKeyVaultIntegration && createKeyVault

var configurationErrors = [
  aksApiAccessMode != 'restrictedPublic' || !empty(apiServerAuthorizedIpRanges)
    ? ''
    : 'restrictedPublic AKS API access requires at least one approved CIDR.'
  aksApiAccessMode != 'privateWithExistingDns' || aksPrivateDnsZoneType == 'microsoft.network/privatednszones'
    ? ''
    : 'privateWithExistingDns requires a Microsoft.Network/privateDnsZones resource ID.'
  !enableControlPlaneLogs || !empty(controlPlaneLogAnalyticsWorkspaceId)
    ? ''
    : 'Control-plane logs require controlPlaneLogAnalyticsWorkspaceId.'
  existingAksIdentityType == 'microsoft.managedidentity/userassignedidentities'
    ? ''
    : 'existingAksControlPlaneIdentityId must reference a user-assigned identity.'
  aksSubnetType == 'microsoft.network/virtualnetworks/subnets'
    ? ''
    : 'existingAksSubnetId must reference a subnet.'
  toLower(aksVnetSubscriptionId) == toLower(subscription().subscriptionId)
    ? ''
    : 'The AKS subnet and cluster must be in the same subscription.'
  createStorage || existingStorageType == 'microsoft.storage/storageaccounts'
    ? ''
    : 'Supply a valid existingStorageAccountId when createStorage is false.'
  !enableMetricsRemoteWrite || createMonitorWorkspace || existingDcrType == 'microsoft.insights/datacollectionrules'
    ? ''
    : 'Supply a valid existingDataCollectionRuleId when using existing monitoring.'
  !enableKeyVaultIntegration || createKeyVault || existingKeyVaultType == 'microsoft.keyvault/vaults'
    ? ''
    : 'Supply a valid existingKeyVaultId when using an existing Key Vault.'
  !createContainerRegistry || empty(existingContainerRegistryId)
    ? ''
    : 'createContainerRegistry and existingContainerRegistryId are mutually exclusive.'
  empty(existingContainerRegistryId) || existingContainerRegistryType == 'microsoft.containerregistry/registries'
    ? ''
    : 'existingContainerRegistryId must reference Microsoft.ContainerRegistry/registries.'
  !useExternalDns || hasPublicDnsResourceIds
    ? ''
    : 'External DNS requires both a public DNS zone ID and user-assigned identity ID.'
  !useManagedEmail || existingCommunicationServiceType == 'microsoft.communication/communicationservices'
    ? ''
    : 'Managed email requires a valid Azure Communication Services resource ID.'
  !createAnyPrivateEndpoint || privateEndpointsSubnetType == 'microsoft.network/virtualnetworks/subnets'
    ? ''
    : 'Private endpoints require existingPrivateEndpointsSubnetId.'
  !createBlobPrivateEndpoint || createStorage
    ? ''
    : 'Blob private endpoint creation requires createStorage.'
  !enableKeyVaultPrivateEndpoint || keyVaultIntegrationCanCreateEndpoint
    ? ''
    : 'Key Vault private endpoint creation requires a template-created Key Vault.'
  !createAcrPrivateEndpoint || containerRegistrySku == 'Premium'
    ? ''
    : 'An ACR private endpoint requires the Premium SKU.'
  privateDnsIntegrationMode != 'existingZones' || !createStoragePrivateEndpoint || (blobPrivateDnsZoneType == 'microsoft.network/privatednszones' && blobPrivateDnsZoneName == 'privatelink.blob.${environment().suffixes.storage}')
    ? ''
    : 'Blob private endpoint creation requires the privatelink.blob storage private DNS zone ID.'
  privateDnsIntegrationMode != 'existingZones' || !createKeyVaultPrivateEndpoint || (keyVaultPrivateDnsZoneType == 'microsoft.network/privatednszones' && keyVaultPrivateDnsZoneName == 'privatelink.vaultcore.azure.net')
    ? ''
    : 'Key Vault private endpoint creation requires the privatelink.vaultcore.azure.net private DNS zone ID.'
  privateDnsIntegrationMode != 'existingZones' || !createAcrPrivateEndpoint || (acrPrivateDnsZoneType == 'microsoft.network/privatednszones' && acrPrivateDnsZoneName == 'privatelink.azurecr.io')
    ? ''
    : 'ACR private endpoint creation requires the privatelink.azurecr.io private DNS zone ID.'
  privateDnsIntegrationMode != 'existingZones' || !createEventHubsPrivateEndpoint || (eventHubsPrivateDnsZoneType == 'microsoft.network/privatednszones' && eventHubsPrivateDnsZoneName == 'privatelink.servicebus.windows.net')
    ? ''
    : 'Event Hubs private endpoint creation requires the privatelink.servicebus.windows.net private DNS zone ID.'
  privateDnsIntegrationMode != 'existingZones' || !createRedisPrivateEndpoint || (redisPrivateDnsZoneType == 'microsoft.network/privatednszones' && redisPrivateDnsZoneName == 'privatelink.redis.azure.net')
    ? ''
    : 'Redis private endpoint creation requires the privatelink.redis.azure.net private DNS zone ID.'
  !createPostgresFlexibleServer || postgresSubnetType == 'microsoft.network/virtualnetworks/subnets'
    ? ''
    : 'PostgreSQL Flexible Server requires a delegated subnet ID.'
  !createPostgresFlexibleServer || (postgresPrivateDnsZoneType == 'microsoft.network/privatednszones' && endsWith(postgresPrivateDnsZoneName, '.postgres.database.azure.com'))
    ? ''
    : 'PostgreSQL Flexible Server requires a private DNS zone ID whose name ends in .postgres.database.azure.com.'
  !createPostgresFlexibleServer || !empty(postgresAdminPassword)
    ? ''
    : 'PostgreSQL Flexible Server requires postgresAdminPassword.'
  !enableEntraRbac || !empty(aksAdminPrincipalIds)
    ? ''
    : 'Entra RBAC requires at least one AKS administrator principal ID.'
  !assignAksAdminRoles || enableEntraRbac
    ? ''
    : 'assignAksAdminRoles requires enableEntraRbac.'
  (!assignKeyVaultReaderRole && !assignKeyVaultWriterRoles) || enableKeyVaultIntegration
    ? ''
    : 'Key Vault role toggles require Key Vault integration.'
  !assignMonitoringPublisherRole || enableMetricsRemoteWrite
    ? ''
    : 'assignMonitoringPublisherRole requires metrics remote write.'
  !assignGrafanaReaderRole || (enableMetricsRemoteWrite && createMonitorWorkspace && createManagedGrafana)
    ? ''
    : 'assignGrafanaReaderRole requires template-created monitoring and Managed Grafana.'
  !assignAcrPullRole || useContainerRegistry
    ? ''
    : 'assignAcrPullRole requires a created or existing ACR.'
  !assignAcrImporterRole || (useContainerRegistry && !empty(effectiveCliPrincipalIds))
    ? ''
    : 'assignAcrImporterRole requires an ACR and cliPrincipalIds.'
  (!assignDataAccessFederatedIdentityRoles && !assignExternalSecretsFederatedIdentityRoles) || !empty(
    effectiveCliPrincipalIds
  )
    ? ''
    : 'Federated identity role toggles require cliPrincipalIds.'
  !assignExternalSecretsFederatedIdentityRoles || enableKeyVaultIntegration
    ? ''
    : 'assignExternalSecretsFederatedIdentityRoles requires Key Vault integration.'
  !empty(effectiveMainDeployerPrincipalIds)
    ? ''
    : 'mainDeployerPrincipalIds is required to produce the beforeMain enterprise access handoff.'
  !empty(effectiveCliPrincipalIds)
    ? ''
    : 'cliPrincipalIds is required to produce the beforeCliDeploy enterprise access handoff.'
]
var activeConfigurationErrors = filter(configurationErrors, error => !empty(error))
var validatedClusterName = empty(activeConfigurationErrors)
  ? clusterName
  : fail(first(activeConfigurationErrors) ?? 'Invalid main deployment configuration.')
resource aksVnetForValidation 'Microsoft.Network/virtualNetworks@2023-11-01' existing = {
  name: aksVnetName
  scope: resourceGroup(aksVnetSubscriptionId, aksVnetResourceGroup)
}
var deploymentClusterName = toLower(aksVnetForValidation.location) == toLower(location)
  ? validatedClusterName
  : fail('The AKS VNet and cluster must be in the same Azure region.')

// Cross-scope BYO resources are read directly. Role modules are invoked only
// when their explicit role toggle is on, so a role-off deployment never needs
// Microsoft.Resources/deployments/write in an organization-owned resource
// group.
resource existingKeyVaultResource 'Microsoft.KeyVault/vaults@2023-07-01' existing = if (enableKeyVaultIntegration && !createKeyVault) {
  name: existingKeyVaultName
  scope: resourceGroup(effectiveKeyVaultSubscriptionId, effectiveKeyVaultResourceGroup)
}

resource existingDcrResource 'Microsoft.Insights/dataCollectionRules@2023-03-11' existing = if (enableMetricsRemoteWrite && !createMonitorWorkspace) {
  name: existingDcrName
  scope: resourceGroup(effectiveDcrSubscriptionId, effectiveDcrResourceGroup)
}

resource existingContainerRegistryResource 'Microsoft.ContainerRegistry/registries@2025-11-01' existing = if (!createContainerRegistry && useContainerRegistry) {
  name: existingContainerRegistryName
  scope: resourceGroup(
    existingContainerRegistrySubscriptionId,
    existingContainerRegistryResourceGroup
  )
}

var aksIdentityIdSegments = split(existingAksControlPlaneIdentityId, '/')
var aksIdentitySubscriptionId = length(aksIdentityIdSegments) > 8
  ? aksIdentityIdSegments[2]
  : subscription().subscriptionId
var aksIdentityResourceGroup = length(aksIdentityIdSegments) > 8
  ? aksIdentityIdSegments[4]
  : resourceGroup().name
var aksIdentityName = length(aksIdentityIdSegments) > 8 ? aksIdentityIdSegments[8] : ''
var existingAksIdentityType = length(aksIdentityIdSegments) > 8
  ? '${toLower(aksIdentityIdSegments[6])}/${toLower(aksIdentityIdSegments[7])}'
  : ''

// Staged by prerequisites.bicep. The subnet owner grants this principal
// Network Contributor before main runs; this template never writes that
// organization-owned network scope.
resource aksControlPlaneIdentity 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' existing = {
  name: aksIdentityName
  scope: resourceGroup(aksIdentitySubscriptionId, aksIdentityResourceGroup)
}

module cluster 'modules/cluster.bicep' = {
  name: '${validatedClusterName}-cluster'
  params: {
    clusterName: deploymentClusterName
    location: location
    tags: resourceTags
    kubernetesVersion: kubernetesVersion
    aksSkuTier: aksSkuTier
    aksIdentityId: aksControlPlaneIdentity.id
    aksIdentityPrincipalId: aksControlPlaneIdentity.properties.principalId
    aksSubnetId: existingAksSubnetId
    nodeCount: nodeCount
    maxNodeCount: maxNodeCount
    nodeVmSize: nodeVmSize
    maxPods: maxPods
    osDiskSizeGB: osDiskSizeGB
    osDiskType: osDiskType
    separateSystemPool: separateSystemPool
    systemNodeCount: systemNodeCount
    systemMaxNodeCount: systemMaxNodeCount
    systemNodeVmSize: systemNodeVmSize
    enableBurstPool: enableBurstPool
    burstVmSize: burstVmSize
    burstMinCount: burstMinCount
    burstMaxCount: burstMaxCount
    serviceCidr: serviceCidr
    dnsServiceIP: dnsServiceIP
    podCidr: podCidr
    availabilityZones: availabilityZones
    aksApiAccessMode: aksApiAccessMode
    existingAksPrivateDnsZoneId: existingAksPrivateDnsZoneId
    apiServerAuthorizedIpRanges: apiServerAuthorizedIpRanges
    enableEntraRbac: enableEntraRbac
    aksAdminPrincipalIds: aksAdminPrincipalIds
    assignAksAdminRoles: assignAksAdminRoles
    kubernetesUpgradeChannel: kubernetesUpgradeChannel
    nodeOsUpgradeChannel: nodeOsUpgradeChannel
    enableMaintenanceWindow: enableMaintenanceWindow
    maintenanceDay: maintenanceDay
    maintenanceStartTime: maintenanceStartTime
    maintenanceUtcOffset: maintenanceUtcOffset
    enableAzurePolicy: enableAzurePolicy
    enableKeyVaultSecretsProvider: enableKeyVaultSecretsProvider
    enableControlPlaneLogs: enableControlPlaneLogs
    controlPlaneLogAnalyticsWorkspaceId: controlPlaneLogAnalyticsWorkspaceId
  }
}

module identity 'modules/identity.bicep' = {
  name: '${clusterName}-identity'
  params: {
    clusterName: clusterName
    location: location
    tags: resourceTags
    enableExternalSecrets: enableKeyVaultIntegration
  }
}

module dataAccessFicRole 'modules/identity-fic-role.bicep' = if (assignDataAccessFederatedIdentityRoles && !empty(effectiveCliPrincipalIds)) {
  name: '${clusterName}-data-access-fic-role'
  params: {
    identityName: '${clusterName}-data-access'
    principalIds: effectiveCliPrincipalIds
    principalType: effectiveCliPrincipalType
    assignFederatedIdentityRole: true
    assignOperatorRole: false
  }
  dependsOn: [
    identity
  ]
}

module externalSecretsFicRole 'modules/identity-fic-role.bicep' = if (assignExternalSecretsFederatedIdentityRoles && enableKeyVaultIntegration && !empty(effectiveCliPrincipalIds)) {
  name: '${clusterName}-external-secrets-fic-role'
  params: {
    identityName: '${clusterName}-external-secrets'
    principalIds: effectiveCliPrincipalIds
    principalType: effectiveCliPrincipalType
    assignFederatedIdentityRole: true
    assignOperatorRole: false
  }
  dependsOn: [
    identity
  ]
}

// The zone and the external-dns identity (with its zone-scoped grant) come
// from prerequisites.bicep; read-only references here surface their outputs
// (NS delegation records, the client ID the CLI binds) without needing any
// write access to the prerequisites resource group.
resource dnsZone 'Microsoft.Network/dnsZones@2018-05-01' existing = if (useExternalDns) {
  name: dnsZoneName
  scope: resourceGroup(dnsZoneSubscriptionId, existingDnsZoneResourceGroup)
}

resource externalDnsIdentity 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' existing = if (useExternalDns) {
  name: externalDnsIdentityName
  scope: resourceGroup(externalDnsIdentitySubscriptionId, externalDnsIdentityResourceGroup)
}

module keyVault 'modules/key-vault.bicep' = if (enableKeyVaultIntegration && createKeyVault) {
  name: '${clusterName}-key-vault'
  params: {
    location: location
    tags: resourceTags
    keyVaultName: keyVaultName
    enablePrivateEndpoint: enableKeyVaultPrivateEndpoint
    enablePurgeProtection: enableKeyVaultPurgeProtection
    softDeleteRetentionDays: keyVaultSoftDeleteRetentionDays
    createMode: keyVaultCreateMode
    privateEndpointsSubnetId: existingPrivateEndpointsSubnetId
    createPrivateDnsZoneGroup: privateDnsIntegrationMode == 'existingZones'
    privateDnsZoneId: existingPrivateDnsZoneIds.keyVault
    readerPrincipalId: identity.outputs.externalSecretsPrincipalId
    readerIdentityId: identity.outputs.externalSecretsIdentityId
    writerPrincipalIds: effectiveKeyVaultWriterPrincipalIds
    assignReaderRole: assignKeyVaultReaderRole
    assignWriterRoles: assignKeyVaultWriterRoles
  }
}

module keyVaultRoleByo 'modules/key-vault-role.bicep' = if (enableKeyVaultIntegration && !createKeyVault && (assignKeyVaultReaderRole || assignKeyVaultWriterRoles)) {
  name: '${clusterName}-key-vault-role'
  scope: resourceGroup(effectiveKeyVaultSubscriptionId, effectiveKeyVaultResourceGroup)
  params: {
    keyVaultName: effectiveKeyVaultName
    principalId: identity.outputs.externalSecretsPrincipalId
    identityId: identity.outputs.externalSecretsIdentityId
    writerPrincipalIds: effectiveKeyVaultWriterPrincipalIds
    assignReaderRole: assignKeyVaultReaderRole
    assignWriterRoles: assignKeyVaultWriterRoles
  }
}

module storage 'modules/storage.bicep' = {
  name: '${clusterName}-storage'
  params: {
    clusterName: clusterName
    location: location
    tags: resourceTags
    createStorage: createStorage
    existingStorageAccountName: existingStorageName
    dataContainerName: dataContainerName
    storageSkuName: storageSkuName
    allowSharedKeyAccess: allowStorageSharedKeyAccess
    enableBlobVersioning: enableBlobVersioning
    blobSoftDeleteDays: blobSoftDeleteRetentionDays
    enablePrivateEndpoint: createBlobPrivateEndpoint
    privateEndpointsSubnetId: existingPrivateEndpointsSubnetId
    createPrivateDnsZoneGroup: privateDnsIntegrationMode == 'existingZones'
    privateDnsZoneId: existingPrivateDnsZoneIds.blob
    enableDeleteLock: createStorageDeleteLock
    rulebricksPrincipalId: identity.outputs.rulebricksPrincipalId
    rulebricksIdentityId: identity.outputs.rulebricksIdentityId
    assignRoles: assignStorageRole
  }
}

module storageRoleByo 'modules/storage-role.bicep' = if (!createStorage && assignStorageRole) {
  name: '${clusterName}-storage-role'
  scope: resourceGroup(effectiveStorageSubscriptionId, effectiveStorageResourceGroup)
  params: {
    storageAccountName: existingStorageName
    principalId: identity.outputs.rulebricksPrincipalId
    identityId: identity.outputs.rulebricksIdentityId
    assignRoles: assignStorageRole
  }
}

module monitoring 'modules/monitoring.bicep' = if (enableMetricsRemoteWrite && createMonitorWorkspace) {
  name: '${clusterName}-monitoring'
  params: {
    clusterName: clusterName
    location: location
    tags: resourceTags
    createMonitorWorkspace: createMonitorWorkspace
    enableManagedGrafana: createManagedGrafana
    grafanaName: grafanaName
    rulebricksPrincipalId: identity.outputs.rulebricksPrincipalId
    rulebricksIdentityId: identity.outputs.rulebricksIdentityId
    assignPublisherRole: assignMonitoringPublisherRole
    assignGrafanaReaderRole: assignGrafanaReaderRole
  }
}

module monitoringRoleByo 'modules/monitoring-role.bicep' = if (enableMetricsRemoteWrite && !createMonitorWorkspace && assignMonitoringPublisherRole) {
  name: '${clusterName}-monitoring-role'
  scope: resourceGroup(effectiveDcrSubscriptionId, effectiveDcrResourceGroup)
  params: {
    dataCollectionRuleName: existingDcrName
    principalId: identity.outputs.rulebricksPrincipalId
    identityId: identity.outputs.rulebricksIdentityId
    assignPublisherRole: assignMonitoringPublisherRole
  }
}

module acr 'modules/acr.bicep' = if (createContainerRegistry) {
  name: '${clusterName}-acr'
  params: {
    location: location
    tags: resourceTags
    registryName: containerRegistryName
    skuName: containerRegistrySku
    kubeletIdentityObjectId: cluster.outputs.kubeletIdentityObjectId
    assignRoles: assignAcrPullRole
    importerPrincipalIds: effectiveCliPrincipalIds
    importerPrincipalType: effectiveCliPrincipalType
    assignImporterRole: assignAcrImporterRole
    enablePrivateEndpoint: enableDataServicePrivateEndpoints
    privateEndpointsSubnetId: existingPrivateEndpointsSubnetId
    createPrivateDnsZoneGroup: privateDnsIntegrationMode == 'existingZones'
    privateDnsZoneId: existingPrivateDnsZoneIds.acr
  }
}

module acrRoleByo 'modules/acr-role.bicep' = if (!createContainerRegistry && useContainerRegistry && (assignAcrPullRole || assignAcrImporterRole)) {
  name: '${clusterName}-acr-role'
  scope: resourceGroup(
    existingContainerRegistrySubscriptionId,
    existingContainerRegistryResourceGroup
  )
  params: {
    registryName: existingContainerRegistryName
    kubeletIdentityObjectId: cluster.outputs.kubeletIdentityObjectId
    pullRoleName: effectiveContainerRegistryPullRoleName
    assignRole: assignAcrPullRole
    importerPrincipalIds: effectiveCliPrincipalIds
    importerPrincipalType: effectiveCliPrincipalType
    assignImporterRole: assignAcrImporterRole
  }
}

module kafka 'modules/kafka.bicep' = if (createEventHubsNamespace) {
  name: '${clusterName}-kafka'
  params: {
    location: location
    tags: resourceTags
    namespaceName: eventHubsNamespaceName
    capacityUnits: eventHubsCapacityUnits
    topicPrefix: kafkaTopicPrefix
    solutionPartitions: solutionPartitions
    logsPartitions: logsPartitions
    retentionHours: kafkaRetentionHours
    enablePrivateEndpoint: enableDataServicePrivateEndpoints
    privateEndpointsSubnetId: existingPrivateEndpointsSubnetId
    createPrivateDnsZoneGroup: privateDnsIntegrationMode == 'existingZones'
    privateDnsZoneId: existingPrivateDnsZoneIds.eventHubs
  }
}

module redis 'modules/redis.bicep' = if (createRedisEnterprise) {
  name: '${clusterName}-redis'
  params: {
    location: location
    tags: resourceTags
    redisName: redisName
    skuName: redisSkuName
    enablePrivateEndpoint: enableDataServicePrivateEndpoints
    privateEndpointsSubnetId: existingPrivateEndpointsSubnetId
    createPrivateDnsZoneGroup: privateDnsIntegrationMode == 'existingZones'
    privateDnsZoneId: existingPrivateDnsZoneIds.redis
  }
}

// Read-only. The communication service, its sender domains, and their
// verification all belong to prerequisites.bicep; this reference exists purely
// to surface the resource name and sender address to the Rulebricks CLI.
resource communicationService 'Microsoft.Communication/communicationServices@2023-04-01' existing = if (useManagedEmail) {
  name: communicationServiceName
  scope: resourceGroup(communicationServiceSubscriptionId, communicationServiceResourceGroup)
}

module postgres 'modules/postgres.bicep' = if (createPostgresFlexibleServer) {
  name: '${clusterName}-postgres'
  params: {
    location: location
    tags: resourceTags
    serverName: postgresServerName
    postgresVersion: postgresVersion
    administratorLogin: postgresAdminUsername
    administratorPassword: postgresAdminPassword
    skuName: postgresSkuName
    skuTier: postgresSkuTier
    storageSizeGB: postgresStorageSizeGB
    enableHighAvailability: postgresHighAvailability
    backupRetentionDays: postgresBackupRetentionDays
    postgresSubnetId: existingPostgresSubnetId
    privateDnsZoneId: existingPrivateDnsZoneIds.postgres
  }
}

var storageBlobContributorRoleDefinitionId = 'ba92f5b4-2d11-453d-a403-e96b0029c9fe'
var keyVaultSecretsUserRoleDefinitionId = '4633458b-17de-408a-b874-0445c86b69e6'
var keyVaultSecretsOfficerRoleDefinitionId = 'b86a8fe4-44ce-4948-aee5-eccb2c155cd7'
var monitoringMetricsPublisherRoleDefinitionId = '3913510d-42f4-4e42-8a64-420c390055eb'
var monitoringDataReaderRoleDefinitionId = 'b0d8363b-8ddd-447d-831f-62ca05bff136'
var acrPullRoleDefinitionId = '7f951dda-4ed3-4680-a7ca-43fe172d538d'
var acrRepositoryReaderRoleDefinitionId = 'b93aa761-3e63-49ed-ac28-beffa264f7ac'
var acrImporterRoleDefinitionId = '577a9874-89fd-4f24-9dbd-b5034d0ad23a'
var aksRbacClusterAdminRoleDefinitionId = 'b1ff04bb-8a4e-4dc4-8eb5-8693973ce19b'
var ficContributorRoleDefinitionId = '7e559ce2-48d7-4b27-9128-fa1b247f1308'
var networkContributorRoleDefinitionId = '4d97b98b-1d4f-4787-a291-c67834d212e7'
var privateDnsZoneContributorRoleDefinitionId = 'b12aa53e-6015-4669-85d0-8515ebb3ae7f'
var readerRoleDefinitionId = 'acdd72a7-3385-48ef-bd42-f606fba81ae7'
var dataAccessIdentityId = resourceId(
  'Microsoft.ManagedIdentity/userAssignedIdentities',
  '${clusterName}-data-access'
)
var externalSecretsIdentityId = resourceId(
  'Microsoft.ManagedIdentity/userAssignedIdentities',
  '${clusterName}-external-secrets'
)
var aksClusterId = resourceId('Microsoft.ContainerService/managedClusters', clusterName)
var monitorWorkspaceId = resourceId('Microsoft.Monitor/accounts', '${clusterName}-amw')

var storageRoleRequirements = [
  {
    phase: 'beforeCliDeploy'
    roleName: 'Storage Blob Data Contributor'
    roleDefinitionId: storageBlobContributorRoleDefinitionId
    principalId: identity.outputs.rulebricksPrincipalId
    scope: effectiveStorageAccountId
    reason: 'Allow Rulebricks workloads to write decision logs and backups.'
    assignmentEnabled: assignStorageRole
  }
]
var keyVaultReaderRoleRequirements = enableKeyVaultIntegration
  ? [
      {
        phase: 'beforeCliDeploy'
        roleName: 'Key Vault Secrets User'
        roleDefinitionId: keyVaultSecretsUserRoleDefinitionId
        principalId: identity.outputs.externalSecretsPrincipalId
        scope: effectiveKeyVaultId
        reason: 'Allow External Secrets Operator to read workload secrets.'
        assignmentEnabled: assignKeyVaultReaderRole
      }
    ]
  : []
var keyVaultWriterRoleRequirements = [
  for principalId in (enableKeyVaultIntegration ? effectiveKeyVaultWriterPrincipalIds : []): {
    phase: 'beforeCliDeploy'
    roleName: 'Key Vault Secrets Officer'
    roleDefinitionId: keyVaultSecretsOfficerRoleDefinitionId
    principalId: principalId
    scope: effectiveKeyVaultId
    reason: 'Allow the selected operator to seed and rotate workload secrets.'
    assignmentEnabled: assignKeyVaultWriterRoles
  }
]
var monitoringPublisherRoleRequirements = enableMetricsRemoteWrite
  ? [
      {
        phase: 'beforeCliDeploy'
        roleName: 'Monitoring Metrics Publisher'
        roleDefinitionId: monitoringMetricsPublisherRoleDefinitionId
        principalId: identity.outputs.rulebricksPrincipalId
        scope: effectiveDataCollectionRuleId
        reason: 'Allow Prometheus to publish remote-write metrics.'
        assignmentEnabled: assignMonitoringPublisherRole
      }
    ]
  : []
var grafanaReaderRoleRequirements = enableMetricsRemoteWrite && createMonitorWorkspace && createManagedGrafana
  ? [
      {
        phase: 'beforeCliDeploy'
        roleName: 'Monitoring Data Reader'
        roleDefinitionId: monitoringDataReaderRoleDefinitionId
        principalId: monitoring!.outputs.grafanaPrincipalId
        scope: monitorWorkspaceId
        reason: 'Allow Managed Grafana to query the Azure Monitor workspace.'
        assignmentEnabled: assignGrafanaReaderRole
      }
    ]
  : []
var acrPullRoleRequirements = useContainerRegistry
  ? [
      {
        phase: 'beforeCliDeploy'
        roleName: effectiveContainerRegistryPullRoleName
        roleDefinitionId: effectiveContainerRegistryPullRoleName == 'Container Registry Repository Reader'
          ? acrRepositoryReaderRoleDefinitionId
          : acrPullRoleDefinitionId
        principalId: cluster.outputs.kubeletIdentityObjectId
        scope: effectiveContainerRegistryId
        reason: 'Allow AKS nodes to pull mirrored Rulebricks images.'
        assignmentEnabled: assignAcrPullRole
      }
    ]
  : []
var acrImporterRoleRequirements = [
  for principalId in (useContainerRegistry ? effectiveCliPrincipalIds : []): {
    phase: 'beforeCliDeploy'
    roleName: 'Container Registry Data Importer and Data Reader'
    roleDefinitionId: acrImporterRoleDefinitionId
    principalId: principalId
    scope: effectiveContainerRegistryId
    reason: 'Allow the CLI mirror flow to import images and the Helm chart.'
    assignmentEnabled: assignAcrImporterRole
  }
]
var aksAdminRoleRequirements = [
  for principalId in (enableEntraRbac ? aksAdminPrincipalIds : []): {
    phase: 'beforeCliDeploy'
    roleName: 'Azure Kubernetes Service RBAC Cluster Admin'
    roleDefinitionId: aksRbacClusterAdminRoleDefinitionId
    principalId: principalId
    scope: aksClusterId
    reason: 'Allow the selected Entra principal to administer the Kubernetes cluster.'
    assignmentEnabled: assignAksAdminRoles
  }
]
var dataAccessFicRoleRequirements = [
  for principalId in effectiveCliPrincipalIds: {
    phase: 'beforeCliDeploy'
    roleName: 'Managed Identity Federated Identity Credential Contributor'
    roleDefinitionId: ficContributorRoleDefinitionId
    principalId: principalId
    scope: dataAccessIdentityId
    reason: 'Allow the CLI to bind Rulebricks workload service accounts to the data-access identity.'
    assignmentEnabled: assignDataAccessFederatedIdentityRoles
  }
]
var externalSecretsFicRoleRequirements = [
  for principalId in (enableKeyVaultIntegration ? effectiveCliPrincipalIds : []): {
    phase: 'beforeCliDeploy'
    roleName: 'Managed Identity Federated Identity Credential Contributor'
    roleDefinitionId: ficContributorRoleDefinitionId
    principalId: principalId
    scope: externalSecretsIdentityId
    reason: 'Allow the CLI to bind the External Secrets service account.'
    assignmentEnabled: assignExternalSecretsFederatedIdentityRoles
  }
]
var privateEndpointSubnetRoleRequirements = [
  for principalId in (createAnyPrivateEndpoint ? effectiveMainDeployerPrincipalIds : []): {
    phase: 'beforeMain'
    roleName: 'Network Contributor'
    roleDefinitionId: networkContributorRoleDefinitionId
    principalId: principalId
    scope: existingPrivateEndpointsSubnetId
    reason: 'Allow the main deployment to join private endpoints to the organization-owned subnet; a custom role with subnet read/join is also sufficient.'
    assignmentEnabled: false
  }
]
var postgresSubnetRoleRequirements = [
  for principalId in (createPostgresFlexibleServer ? effectiveMainDeployerPrincipalIds : []): {
    phase: 'beforeMain'
    roleName: 'Network Contributor'
    roleDefinitionId: networkContributorRoleDefinitionId
    principalId: principalId
    scope: existingPostgresSubnetId
    reason: 'Allow the main deployment to join PostgreSQL Flexible Server to its delegated subnet; a custom subnet read/join role is also sufficient.'
    assignmentEnabled: false
  }
]
var postgresPrivateDnsRoleRequirements = [
  for principalId in (createPostgresFlexibleServer ? effectiveMainDeployerPrincipalIds : []): {
    phase: 'beforeMain'
    roleName: 'Private DNS Zone Contributor'
    roleDefinitionId: privateDnsZoneContributorRoleDefinitionId
    principalId: principalId
    scope: existingPrivateDnsZoneIds.postgres
    reason: 'Allow PostgreSQL Flexible Server to join the organization-owned private DNS zone.'
    assignmentEnabled: false
  }
]
var blobPrivateDnsRoleRequirements = [
  for principalId in (privateDnsIntegrationMode == 'existingZones' && createStoragePrivateEndpoint
      ? effectiveMainDeployerPrincipalIds
      : []): {
    phase: 'beforeMain'
    roleName: 'Private DNS Zone Contributor'
    roleDefinitionId: privateDnsZoneContributorRoleDefinitionId
    principalId: principalId
    scope: existingPrivateDnsZoneIds.blob
    reason: 'Allow the private endpoint zone group to join the existing Blob private DNS zone.'
    assignmentEnabled: false
  }
]
var keyVaultPrivateDnsRoleRequirements = [
  for principalId in (privateDnsIntegrationMode == 'existingZones' && createKeyVaultPrivateEndpoint
      ? effectiveMainDeployerPrincipalIds
      : []): {
    phase: 'beforeMain'
    roleName: 'Private DNS Zone Contributor'
    roleDefinitionId: privateDnsZoneContributorRoleDefinitionId
    principalId: principalId
    scope: existingPrivateDnsZoneIds.keyVault
    reason: 'Allow the private endpoint zone group to join the existing Key Vault private DNS zone.'
    assignmentEnabled: false
  }
]
var acrPrivateDnsRoleRequirements = [
  for principalId in (privateDnsIntegrationMode == 'existingZones' && createAcrPrivateEndpoint
      ? effectiveMainDeployerPrincipalIds
      : []): {
    phase: 'beforeMain'
    roleName: 'Private DNS Zone Contributor'
    roleDefinitionId: privateDnsZoneContributorRoleDefinitionId
    principalId: principalId
    scope: existingPrivateDnsZoneIds.acr
    reason: 'Allow the private endpoint zone group to join the existing ACR private DNS zone.'
    assignmentEnabled: false
  }
]
var eventHubsPrivateDnsRoleRequirements = [
  for principalId in (privateDnsIntegrationMode == 'existingZones' && createEventHubsPrivateEndpoint
      ? effectiveMainDeployerPrincipalIds
      : []): {
    phase: 'beforeMain'
    roleName: 'Private DNS Zone Contributor'
    roleDefinitionId: privateDnsZoneContributorRoleDefinitionId
    principalId: principalId
    scope: existingPrivateDnsZoneIds.eventHubs
    reason: 'Allow the private endpoint zone group to join the existing Event Hubs private DNS zone.'
    assignmentEnabled: false
  }
]
var redisPrivateDnsRoleRequirements = [
  for principalId in (privateDnsIntegrationMode == 'existingZones' && createRedisPrivateEndpoint
      ? effectiveMainDeployerPrincipalIds
      : []): {
    phase: 'beforeMain'
    roleName: 'Private DNS Zone Contributor'
    roleDefinitionId: privateDnsZoneContributorRoleDefinitionId
    principalId: principalId
    scope: existingPrivateDnsZoneIds.redis
    reason: 'Allow the private endpoint zone group to join the existing Redis private DNS zone.'
    assignmentEnabled: false
  }
]
var existingStorageReaderRoleRequirements = [
  for principalId in (!createStorage ? effectiveMainDeployerPrincipalIds : []): {
    phase: 'beforeMain'
    roleName: 'Reader'
    roleDefinitionId: readerRoleDefinitionId
    principalId: principalId
    scope: existingStorageAccountId
    reason: 'Allow main and the CLI to resolve the organization-owned storage account.'
    assignmentEnabled: false
  }
]
var existingKeyVaultReaderRoleRequirements = [
  for principalId in (enableKeyVaultIntegration && !createKeyVault ? effectiveMainDeployerPrincipalIds : []): {
    phase: 'beforeMain'
    roleName: 'Reader'
    roleDefinitionId: readerRoleDefinitionId
    principalId: principalId
    scope: existingKeyVaultId
    reason: 'Allow main and the CLI to resolve the organization-owned Key Vault.'
    assignmentEnabled: false
  }
]
var existingDcrReaderRoleRequirements = [
  for principalId in (enableMetricsRemoteWrite && !createMonitorWorkspace
      ? effectiveMainDeployerPrincipalIds
      : []): {
    phase: 'beforeMain'
    roleName: 'Reader'
    roleDefinitionId: readerRoleDefinitionId
    principalId: principalId
    scope: existingDataCollectionRuleId
    reason: 'Allow main and the CLI to resolve the organization-owned data collection rule.'
    assignmentEnabled: false
  }
]
var existingAcrReaderRoleRequirements = [
  for principalId in (useContainerRegistry && !createContainerRegistry ? effectiveMainDeployerPrincipalIds : []): {
    phase: 'beforeMain'
    roleName: 'Reader'
    roleDefinitionId: readerRoleDefinitionId
    principalId: principalId
    scope: existingContainerRegistryId
    reason: 'Allow main and the CLI to resolve the organization-owned container registry.'
    assignmentEnabled: false
  }
]
var aksVnetReaderRoleRequirements = [
  for principalId in effectiveMainDeployerPrincipalIds: {
    phase: 'beforeMain'
    roleName: 'Reader'
    roleDefinitionId: readerRoleDefinitionId
    principalId: principalId
    scope: aksVnetId
    reason: 'Allow main to validate that the organization-owned AKS VNet is in the cluster region.'
    assignmentEnabled: false
  }
]
var requiredRoleAssignments = concat(
  storageRoleRequirements,
  keyVaultReaderRoleRequirements,
  keyVaultWriterRoleRequirements,
  monitoringPublisherRoleRequirements,
  grafanaReaderRoleRequirements,
  acrPullRoleRequirements,
  acrImporterRoleRequirements,
  aksAdminRoleRequirements,
  dataAccessFicRoleRequirements,
  externalSecretsFicRoleRequirements,
  privateEndpointSubnetRoleRequirements,
  postgresSubnetRoleRequirements,
  postgresPrivateDnsRoleRequirements,
  blobPrivateDnsRoleRequirements,
  keyVaultPrivateDnsRoleRequirements,
  acrPrivateDnsRoleRequirements,
  eventHubsPrivateDnsRoleRequirements,
  redisPrivateDnsRoleRequirements,
  existingStorageReaderRoleRequirements,
  existingKeyVaultReaderRoleRequirements,
  existingDcrReaderRoleRequirements,
  existingAcrReaderRoleRequirements,
  aksVnetReaderRoleRequirements
)

// ============================================================================
// OUTPUTS
//
// Everything the Rulebricks install needs from this deployment, grouped by
// concern. No secrets are ever output (deployment history is readable by
// anyone with reader access) - secret-bearing outputs are `az` fetch commands
// instead. Save a copy while setting up:
//   az deployment group show --name rulebricks -g <rg> --query properties.outputs
// ============================================================================

// ----- Cluster access -------------------------------------------------------

@description('True when all cross-parameter validation passed.')
output configurationValidated bool = deploymentClusterName == clusterName

@description('Role requirements for platform review. This reports names, principals, scopes, and timing only; it never emits executable commands or claims that a grant is missing.')
output roleRequirements array = requiredRoleAssignments

@description('Name of the AKS cluster.')
output clusterName string = cluster.outputs.clusterName

@description('Resource group holding every resource in this deployment.')
output resourceGroupName string = resourceGroup().name

@description('Azure region of the deployment.')
output location string = location

@description('Object IDs a platform owner uses to apply deferred workload grants in the Azure portal. Empty values mean the optional feature is disabled.')
output principalIds object = {
  aksControlPlane: aksControlPlaneIdentity.properties.principalId
  dataAccess: identity.outputs.rulebricksPrincipalId
  externalSecrets: enableKeyVaultIntegration ? identity.outputs.externalSecretsPrincipalId : ''
  kubelet: cluster.outputs.kubeletIdentityObjectId
  grafana: enableMetricsRemoteWrite && createMonitorWorkspace && createManagedGrafana
    ? monitoring!.outputs.grafanaPrincipalId
    : ''
}

var configuredMaximumNodes = maxNodeCount + (separateSystemPool ? systemMaxNodeCount : 0) + (enableBurstPool
    ? burstMaxCount
    : 0)
var upgradeSurgeNodes = ((configuredMaximumNodes * 33) + 99) / 100

@description('Preflight guidance for the AKS subnet. Azure reserves five addresses in every subnet; also leave load-balancer and future-growth headroom beyond plannedNodeIpsDuringUpgrade.')
output subnetCapacityGuidance object = {
  configuredMaximumNodes: configuredMaximumNodes
  upgradeSurgePercent: 33
  plannedNodeIpsDuringUpgrade: configuredMaximumNodes + upgradeSurgeNodes
  recommendedNonProductionPrefix: '/26'
  tightTechnicalFloor: '/27'
}

@description('Run this to add the cluster to your kubeconfig. Entra-RBAC clusters also need kubelogin (kubelogin convert-kubeconfig -l azurecli).')
output kubeconfigCommand string = 'az aks get-credentials --name ${clusterName} --resource-group ${resourceGroup().name}'

// ----- Workload identity and object storage ---------------------------------

@description('Client ID of the shared data-access identity (blob storage, backups, metrics). The Rulebricks CLI discovers and binds it automatically.')
output rulebricksClientId string = identity.outputs.rulebricksClientId

@description('Storage account holding decision logs and database backups.')
output storageAccountName string = storage.outputs.storageAccountName

@description('Blob container for all Rulebricks data (per-purpose prefixes inside).')
output dataContainer string = storage.outputs.dataContainer

// ----- DNS ------------------------------------------------------------------

@description('Client ID of the external-dns identity; the CLI binds it so DNS records are managed automatically.')
output externalDnsClientId string = useExternalDns ? externalDnsIdentity!.properties.clientId : ''

@description('The delegated DNS zone for this deployment (empty when external DNS is disabled).')
output dnsZoneNameOut string = useExternalDns ? dnsZoneName : ''

@description('Resource group holding the DNS zone (the prerequisites deployment).')
output dnsZoneResourceGroup string = useExternalDns ? existingDnsZoneResourceGroup : ''

@description('Hand these to whoever controls the parent domain: one NS record set for the zone delegating to them, and DNS is done forever - records and TLS certificates are automatic afterward.')
output dnsZoneNameServers array = useExternalDns ? dnsZone!.properties.nameServers : []

// ----- Secrets (Key Vault) --------------------------------------------------

@description('Client ID of the external-secrets identity that reads Key Vault from the cluster.')
output externalSecretsClientId string = enableKeyVaultIntegration ? identity.outputs.externalSecretsClientId : ''

@description('Entra tenant ID for the external-secrets workload identity federation.')
output externalSecretsTenantId string = enableKeyVaultIntegration ? tenant().tenantId : ''

@description('Kubernetes ServiceAccount name the external-secrets binding targets.')
output externalSecretsServiceAccountName string = enableKeyVaultIntegration ? esoServiceAccountName : ''

@description('Key Vault that is the source of truth for deployment secrets.')
output keyVaultName string = enableKeyVaultIntegration ? effectiveKeyVaultName : ''

@description('URI of the deployment Key Vault.')
output keyVaultUri string = enableKeyVaultIntegration
  ? (createKeyVault ? keyVault!.outputs.vaultUri : existingKeyVaultResource!.properties.vaultUri)
  : ''

// ----- Container registry ---------------------------------------------------

@description('ACR that receives Rulebricks images through the CLI mirror flow.')
output containerRegistryName string = useContainerRegistry ? effectiveContainerRegistryName : ''

@description('Login server for the registry; nodes pull Rulebricks images through it.')
output containerRegistryLoginServer string = useContainerRegistry
  ? (createContainerRegistry
      ? acr!.outputs.loginServer
      : existingContainerRegistryResource!.properties.loginServer)
  : ''

@description('Resource ID of the created or organization-owned registry.')
output containerRegistryId string = useContainerRegistry ? effectiveContainerRegistryId : ''

// ----- Monitoring (Managed Prometheus + Grafana) -----------------------------

@description('Prometheus remote-write ingestion endpoint (Azure Monitor data collection endpoint).')
output dceMetricsIngestionEndpoint string = enableMetricsRemoteWrite && createMonitorWorkspace
  ? monitoring!.outputs.dceMetricsIngestionEndpoint
  : ''

@description('Immutable ID of the Prometheus data collection rule (part of the remote-write URL).')
output dcrImmutableId string = enableMetricsRemoteWrite && createMonitorWorkspace
  ? monitoring!.outputs.dcrImmutableId
  : ''

@description('Resource ID of the data collection rule; the CLI discovers remote-write targets from it.')
output dataCollectionRuleId string = enableMetricsRemoteWrite
  ? (createMonitorWorkspace ? monitoring!.outputs.dataCollectionRuleId : existingDcrResource!.id)
  : ''

@description('Azure Managed Grafana endpoint, pre-wired to the Prometheus workspace.')
output grafanaEndpoint string = enableMetricsRemoteWrite && createMonitorWorkspace
  ? monitoring!.outputs.grafanaEndpoint
  : ''

// ----- Kafka (Event Hubs, when managed) --------------------------------------

@description('Kafka bootstrap servers for the Event Hubs namespace.')
output kafkaBootstrapServers string = createEventHubsNamespace ? kafka!.outputs.bootstrapServers : ''

@description('Pre-created Kafka topics (Event Hubs).')
output kafkaTopics array = createEventHubsNamespace ? kafka!.outputs.topicNames : []

@description('Run this to fetch the Kafka SASL connection string (never stored in outputs).')
output kafkaConnectionStringCommand string = createEventHubsNamespace ? kafka!.outputs.connectionStringCommand : ''

@description('Partition count of the solution topic; the CLI mirrors it in worker settings.')
output kafkaSolutionPartitions int = createEventHubsNamespace ? solutionPartitions : 0

// ----- Redis (when managed) ---------------------------------------------------

@description('Managed Redis hostname.')
output redisHost string = createRedisEnterprise ? redis!.outputs.hostName : ''

@description('Managed Redis port.')
output redisPort int = createRedisEnterprise ? redis!.outputs.port : 0

@description('True when the managed Redis endpoint requires TLS.')
output redisTlsEnabled bool = createRedisEnterprise

@description('Run this to fetch the Redis access key (never stored in outputs).')
output redisAccessKeyCommand string = createRedisEnterprise ? redis!.outputs.accessKeyCommand : ''

// ----- Email (Azure Communication Services) ----------------------------------
// Read-only: every ACS resource belongs to prerequisites.bicep. The CLI's
// email step discovers the platform-created SMTP Username child resource and
// linked sender domains from the exact communication-service ID. The password
// is the linked Entra app's client secret and is never a Bicep output.

@description('SMTP host for ACS email.')
output emailSmtpHost string = useManagedEmail ? 'smtp.azurecomm.net' : ''

@description('SMTP port for ACS email.')
output emailSmtpPort int = useManagedEmail ? 587 : 0

@description('ACS communication service name used for display and discovery.')
output emailAcsResourceName string = useManagedEmail ? communicationService!.name : ''

@description('Exact ACS communication service ID used to discover SMTP Username and sender-domain resources, including cross-subscription services.')
output emailAcsResourceId string = useManagedEmail ? existingCommunicationServiceId : ''

// ----- Database (PostgreSQL Flexible Server, when managed) -------------------

@description('Managed Postgres server FQDN (the CLI database step discovers it too).')
output postgresHost string = createPostgresFlexibleServer ? postgres!.outputs.fqdn : ''

@description('Managed Postgres port.')
output postgresPort int = createPostgresFlexibleServer ? postgres!.outputs.port : 0

@description('Initial database name.')
output postgresDatabase string = createPostgresFlexibleServer ? postgres!.outputs.databaseName : ''

@description('Admin username; pair it with the POSTGRES_ADMIN_PASSWORD you exported when deploying.')
output postgresAdminUsernameOut string = createPostgresFlexibleServer ? postgres!.outputs.administratorLogin : ''

@description('Run this to restart the server (needed only if wal_level changes are pending; the CLI does it automatically).')
output postgresRestartCommand string = createPostgresFlexibleServer ? postgres!.outputs.restartCommand : ''
