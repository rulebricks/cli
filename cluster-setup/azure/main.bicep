targetScope = 'resourceGroup'

// There is no profile switch: parameters.test.bicepparam and
// parameters.production.bicepparam enumerate every tunable value and ARE the
// profiles. The defaults below exist only so a bare
// `az deployment group create --template-file main.bicep` produces a small,
// low-cost cluster; file-driven deploys override all of them explicitly.
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

param enablePrivateCluster bool = false
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

param vnetAddressSpace string = '10.240.0.0/16'
param aksSubnetPrefix string = '10.240.0.0/22'
param privateEndpointsSubnetPrefix string = '10.240.4.0/24'
param postgresSubnetPrefix string = '10.240.5.0/24'
param serviceCidr string = '172.16.0.0/16'
param dnsServiceIP string = '172.16.0.10'
param podCidr string = '192.168.0.0/16'
param enableDataServicePrivateEndpoints bool = false

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

param createStorage bool = true
param existingStorageAccountName string = ''
param existingStorageAccountResourceGroup string = ''
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

param allowStorageSharedKeyAccess bool = true
param enableStorageVersioning bool = false

@minValue(0)
@maxValue(365)
param storageSoftDeleteDays int = 7

param enableStoragePrivateEndpoint bool = false
param enableStorageDeleteLock bool = false

param enableMetricsRemoteWrite bool = false
param createMonitorWorkspace bool = true
param existingDataCollectionRuleName string = ''
param existingDataCollectionRuleResourceGroup string = ''
param enableManagedGrafana bool = false
param grafanaName string = take('rbgraf${take(uniqueString(resourceGroup().id), 6)}', 23)

param enableExternalDns bool = false
@description('DNS zone for the deployment, e.g. rb.corp.com. With createDnsZone the template creates it and outputs the NS records for a one-time parent-domain delegation; otherwise it must already exist (see dnsZoneResourceGroup).')
param dnsZoneName string = ''
// Create the zone here (delegated-subdomain model) instead of requiring a
// pre-existing zone. Ignored when enableExternalDns is false.
param createDnsZone bool = true
// Resource group of a PRE-EXISTING zone (createDnsZone=false only).
param dnsZoneResourceGroup string = ''

param enableKeyVaultIntegration bool = false
param createKeyVault bool = true
param keyVaultName string = take('rbkv${uniqueString(resourceGroup().id, clusterName)}', 24)
param existingKeyVaultResourceGroup string = ''
param allowKeyVaultPublicAccess bool = true
param enableKeyVaultPrivateEndpoint bool = false
param enableKeyVaultPurgeProtection bool = false

@minValue(7)
@maxValue(90)
param keyVaultSoftDeleteRetentionDays int = 7

@description('Object IDs allowed to create and rotate secrets in a newly created vault.')
param keyVaultWriterPrincipalIds array = []

// Fixed convention: the ServiceAccount name the CLI's ESO manifests create
// (ESO_READER_SERVICE_ACCOUNT in the CLI). The CLI creates the
// namespace-scoped federated credential for it at deploy time.
var esoServiceAccountName = 'rulebricks-secrets-reader'

param enableContainerRegistry bool = false
param containerRegistryName string = take(
  '${replace(toLower(clusterName), '-', '')}acr${uniqueString(resourceGroup().id)}',
  50
)

@allowed([
  'Basic'
  'Standard'
  'Premium'
])
param containerRegistrySku string = 'Premium'

// Rulebricks license key: a read-only Docker Hub access-token suffix (the
// full token is dckr_pat_<license-key>, assembled below). Powers the
// registry's pull-through cache of docker.io/rulebricks/*. Required for the
// mirror to function when enableContainerRegistry is true; the value is
// stored in the deployment's Key Vault, never in outputs.
@secure()
param rulebricksLicenseKey string = ''

param allowContainerRegistryPublicAccess bool = true

param enableManagedKafka bool = false
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

param enableManagedRedis bool = false
param redisName string = '${toLower(clusterName)}-redis-${take(uniqueString(resourceGroup().id), 6)}'
param redisSkuName string = 'Balanced_B1'

// Azure Communication Services Email: SMTP-compatible email for tenants where
// Exchange Online basic-auth SMTP is retired (the app keeps plain SMTP config;
// credentials come from an Entra app registration).
param enableManagedEmail bool = false
// ACS data-at-rest region; independent of `location`.
param emailDataLocation string = 'United States'
// SMTP authentication uses an Entra app the Rulebricks CLI wires up at deploy
// time (it grants the app Contributor on the communication service) - the
// same model as SSO. No app IDs are needed here.
// Branded sender domain (e.g. rb.corp.com), normally the delegated DNS zone
// or a subdomain of it - the verification records are then created in that
// zone automatically. Empty = the Azure-managed azurecomm.net sender. After
// the first deploy, run the emailInitiateVerificationCommands outputs, wait
// for Verified, then rerun the same deployment - it links automatically.
param emailCustomDomain string = ''

param enableManagedDatabase bool = false
param postgresServerName string = '${toLower(clusterName)}-pg-${take(uniqueString(resourceGroup().id), 6)}'
param postgresVersion string = '17'
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

var effectiveDnsZoneResourceGroup = empty(dnsZoneResourceGroup) ? resourceGroup().name : dnsZoneResourceGroup
var effectiveStorageResourceGroup = empty(existingStorageAccountResourceGroup)
  ? resourceGroup().name
  : existingStorageAccountResourceGroup
var effectiveDcrResourceGroup = empty(existingDataCollectionRuleResourceGroup)
  ? resourceGroup().name
  : existingDataCollectionRuleResourceGroup
var effectiveKeyVaultResourceGroup = empty(existingKeyVaultResourceGroup)
  ? resourceGroup().name
  : existingKeyVaultResourceGroup

module network 'modules/network.bicep' = {
  name: '${clusterName}-network'
  params: {
    clusterName: clusterName
    location: location
    tags: resourceTags
    vnetAddressSpace: vnetAddressSpace
    aksSubnetPrefix: aksSubnetPrefix
    privateEndpointsSubnetPrefix: privateEndpointsSubnetPrefix
    postgresSubnetPrefix: postgresSubnetPrefix
  }
}

module cluster 'modules/cluster.bicep' = {
  name: '${clusterName}-cluster'
  params: {
    clusterName: clusterName
    location: location
    tags: resourceTags
    kubernetesVersion: kubernetesVersion
    aksSkuTier: aksSkuTier
    vnetName: network.outputs.vnetName
    aksSubnetId: network.outputs.aksSubnetId
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
    enablePrivateCluster: enablePrivateCluster
    apiServerAuthorizedIpRanges: apiServerAuthorizedIpRanges
    enableEntraRbac: enableEntraRbac
    aksAdminPrincipalIds: aksAdminPrincipalIds
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
    enableExternalDns: enableExternalDns
    enableExternalSecrets: enableKeyVaultIntegration
  }
}

// Delegated-subdomain model: create the zone alongside the cluster and grant
// the external-dns identity on it. The dnsZoneNameServers output feeds the
// one-time NS delegation at the parent domain.
module dnsZone 'modules/dns-zone.bicep' = if (enableExternalDns && createDnsZone) {
  name: '${clusterName}-dns-zone'
  params: {
    dnsZoneName: dnsZoneName
    tags: resourceTags
    principalId: identity.outputs.externalDnsPrincipalId
  }
}

// Pre-existing zone (customer-owned): grant only.
module externalDnsRole 'modules/dns-role.bicep' = if (enableExternalDns && !createDnsZone) {
  name: '${clusterName}-external-dns-role'
  scope: resourceGroup(effectiveDnsZoneResourceGroup)
  params: {
    dnsZoneName: dnsZoneName
    principalId: identity.outputs.externalDnsPrincipalId
  }
}

module keyVault 'modules/key-vault.bicep' = if (enableKeyVaultIntegration && createKeyVault) {
  name: '${clusterName}-key-vault'
  params: {
    clusterName: clusterName
    location: location
    tags: resourceTags
    keyVaultName: keyVaultName
    allowPublicNetworkAccess: allowKeyVaultPublicAccess
    enablePrivateEndpoint: enableKeyVaultPrivateEndpoint
    enablePurgeProtection: enableKeyVaultPurgeProtection
    softDeleteRetentionDays: keyVaultSoftDeleteRetentionDays
    privateEndpointsSubnetId: network.outputs.privateEndpointsSubnetId
    vnetId: network.outputs.vnetId
    readerPrincipalId: identity.outputs.externalSecretsPrincipalId
    readerIdentityId: identity.outputs.externalSecretsIdentityId
    writerPrincipalIds: keyVaultWriterPrincipalIds
  }
}

module keyVaultRoleByo 'modules/key-vault-role.bicep' = if (enableKeyVaultIntegration && !createKeyVault) {
  name: '${clusterName}-key-vault-role'
  scope: resourceGroup(effectiveKeyVaultResourceGroup)
  params: {
    keyVaultName: keyVaultName
    principalId: identity.outputs.externalSecretsPrincipalId
    identityId: identity.outputs.externalSecretsIdentityId
  }
}

module storage 'modules/storage.bicep' = {
  name: '${clusterName}-storage'
  params: {
    clusterName: clusterName
    location: location
    tags: resourceTags
    createStorage: createStorage
    existingStorageAccountName: existingStorageAccountName
    dataContainerName: dataContainerName
    storageSkuName: storageSkuName
    allowSharedKeyAccess: allowStorageSharedKeyAccess
    enableBlobVersioning: enableStorageVersioning
    blobSoftDeleteDays: storageSoftDeleteDays
    enablePrivateEndpoint: enableStoragePrivateEndpoint
    privateEndpointsSubnetId: network.outputs.privateEndpointsSubnetId
    vnetId: network.outputs.vnetId
    enableDeleteLock: enableStorageDeleteLock
    rulebricksPrincipalId: identity.outputs.rulebricksPrincipalId
    rulebricksIdentityId: identity.outputs.rulebricksIdentityId
  }
}

module storageRoleByo 'modules/storage-role.bicep' = if (!createStorage) {
  name: '${clusterName}-storage-role'
  scope: resourceGroup(effectiveStorageResourceGroup)
  params: {
    storageAccountName: existingStorageAccountName
    principalId: identity.outputs.rulebricksPrincipalId
    identityId: identity.outputs.rulebricksIdentityId
  }
}

module monitoring 'modules/monitoring.bicep' = if (enableMetricsRemoteWrite && createMonitorWorkspace) {
  name: '${clusterName}-monitoring'
  params: {
    clusterName: clusterName
    location: location
    tags: resourceTags
    createMonitorWorkspace: createMonitorWorkspace
    enableManagedGrafana: enableManagedGrafana
    grafanaName: grafanaName
    rulebricksPrincipalId: identity.outputs.rulebricksPrincipalId
    rulebricksIdentityId: identity.outputs.rulebricksIdentityId
  }
}

module monitoringRoleByo 'modules/monitoring-role.bicep' = if (enableMetricsRemoteWrite && !createMonitorWorkspace) {
  name: '${clusterName}-monitoring-role'
  scope: resourceGroup(effectiveDcrResourceGroup)
  params: {
    dataCollectionRuleName: existingDataCollectionRuleName
    principalId: identity.outputs.rulebricksPrincipalId
    identityId: identity.outputs.rulebricksIdentityId
  }
}

module acr 'modules/acr.bicep' = if (enableContainerRegistry) {
  name: '${clusterName}-acr'
  params: {
    clusterName: clusterName
    location: location
    tags: resourceTags
    registryName: containerRegistryName
    skuName: containerRegistrySku
    kubeletIdentityObjectId: cluster.outputs.kubeletIdentityObjectId
    enablePrivateEndpoint: enableDataServicePrivateEndpoints
    allowPublicNetworkAccess: allowContainerRegistryPublicAccess
    privateEndpointsSubnetId: network.outputs.privateEndpointsSubnetId
    vnetId: network.outputs.vnetId
    // Pull-through cache credentials live in the deployment's Key Vault;
    // the cache is skipped (registry only) without a created vault or key.
    vaultName: (enableKeyVaultIntegration && createKeyVault) ? keyVaultName : ''
    dockerHubToken: rulebricksLicenseKey == '' ? '' : 'dckr_pat_${rulebricksLicenseKey}'
  }
  dependsOn: [
    keyVault
  ]
}

module kafka 'modules/kafka.bicep' = if (enableManagedKafka) {
  name: '${clusterName}-kafka'
  params: {
    clusterName: clusterName
    location: location
    tags: resourceTags
    namespaceName: eventHubsNamespaceName
    capacityUnits: eventHubsCapacityUnits
    topicPrefix: kafkaTopicPrefix
    solutionPartitions: solutionPartitions
    logsPartitions: logsPartitions
    retentionHours: kafkaRetentionHours
    enablePrivateEndpoint: enableDataServicePrivateEndpoints
    privateEndpointsSubnetId: network.outputs.privateEndpointsSubnetId
    vnetId: network.outputs.vnetId
  }
}

module redis 'modules/redis.bicep' = if (enableManagedRedis) {
  name: '${clusterName}-redis'
  params: {
    clusterName: clusterName
    location: location
    tags: resourceTags
    redisName: redisName
    skuName: redisSkuName
    enablePrivateEndpoint: enableDataServicePrivateEndpoints
    privateEndpointsSubnetId: network.outputs.privateEndpointsSubnetId
    vnetId: network.outputs.vnetId
  }
}

module email 'modules/email.bicep' = if (enableManagedEmail) {
  name: '${clusterName}-email'
  params: {
    clusterName: clusterName
    tags: resourceTags
    dataLocation: emailDataLocation
    customDomain: emailCustomDomain
    // Verification records can only be created here when this deployment
    // owns the zone; BYO zones get the records via output instead.
    dnsZoneName: (enableExternalDns && createDnsZone) ? dnsZoneName : ''
  }
  dependsOn: [
    dnsZone
  ]
}

module postgres 'modules/postgres.bicep' = if (enableManagedDatabase) {
  name: '${clusterName}-postgres'
  params: {
    clusterName: clusterName
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
    postgresSubnetId: network.outputs.postgresSubnetId
    vnetId: network.outputs.vnetId
  }
}

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

@description('Name of the AKS cluster.')
output clusterName string = cluster.outputs.clusterName

@description('Resource group holding every resource in this deployment.')
output resourceGroupName string = resourceGroup().name

@description('Azure region of the deployment.')
output location string = location

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
output externalDnsClientId string = identity.outputs.externalDnsClientId

@description('The delegated DNS zone for this deployment (empty when external DNS is disabled).')
output dnsZoneNameOut string = enableExternalDns ? dnsZoneName : ''

@description('Hand these to whoever controls the parent domain: one NS record set for the zone delegating to them, and DNS is done forever - records and TLS certificates are automatic afterward.')
output dnsZoneNameServers array = enableExternalDns && createDnsZone ? dnsZone!.outputs.nameServers : []

// ----- Secrets (Key Vault) --------------------------------------------------

@description('Client ID of the external-secrets identity that reads Key Vault from the cluster.')
output externalSecretsClientId string = enableKeyVaultIntegration ? identity.outputs.externalSecretsClientId : ''

@description('Entra tenant ID for the external-secrets workload identity federation.')
output externalSecretsTenantId string = enableKeyVaultIntegration ? tenant().tenantId : ''

@description('Kubernetes ServiceAccount name the external-secrets binding targets.')
output externalSecretsServiceAccountName string = enableKeyVaultIntegration ? esoServiceAccountName : ''

@description('Key Vault that is the source of truth for deployment secrets.')
output keyVaultName string = enableKeyVaultIntegration ? keyVaultName : ''

@description('URI of the deployment Key Vault.')
output keyVaultUri string = enableKeyVaultIntegration
  ? (createKeyVault ? keyVault!.outputs.vaultUri : keyVaultRoleByo!.outputs.vaultUri)
  : ''

// ----- Container registry ---------------------------------------------------

@description('ACR that caches Rulebricks images via pull-through (license-key authenticated).')
output containerRegistryName string = enableContainerRegistry ? acr!.outputs.registryName : ''

@description('Login server for the registry; nodes pull Rulebricks images through it.')
output containerRegistryLoginServer string = enableContainerRegistry ? acr!.outputs.loginServer : ''

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
  ? (createMonitorWorkspace ? monitoring!.outputs.dataCollectionRuleId : monitoringRoleByo!.outputs.dataCollectionRuleId)
  : ''

@description('Azure Managed Grafana endpoint, pre-wired to the Prometheus workspace.')
output grafanaEndpoint string = enableMetricsRemoteWrite && createMonitorWorkspace
  ? monitoring!.outputs.grafanaEndpoint
  : ''

// ----- Kafka (Event Hubs, when managed) --------------------------------------

@description('Kafka bootstrap servers for the Event Hubs namespace.')
output kafkaBootstrapServers string = enableManagedKafka ? kafka!.outputs.bootstrapServers : ''

@description('Pre-created Kafka topics (Event Hubs).')
output kafkaTopics array = enableManagedKafka ? kafka!.outputs.topicNames : []

@description('Run this to fetch the Kafka SASL connection string (never stored in outputs).')
output kafkaConnectionStringCommand string = enableManagedKafka ? kafka!.outputs.connectionStringCommand : ''

@description('Partition count of the solution topic; the CLI mirrors it in worker settings.')
output kafkaSolutionPartitions int = enableManagedKafka ? solutionPartitions : 0

// ----- Redis (when managed) ---------------------------------------------------

@description('Managed Redis hostname.')
output redisHost string = enableManagedRedis ? redis!.outputs.hostName : ''

@description('Managed Redis port.')
output redisPort int = enableManagedRedis ? redis!.outputs.port : 0

@description('True when the managed Redis endpoint requires TLS.')
output redisTlsEnabled bool = enableManagedRedis

@description('Run this to fetch the Redis access key (never stored in outputs).')
output redisAccessKeyCommand string = enableManagedRedis ? redis!.outputs.accessKeyCommand : ''

// ----- Email (Azure Communication Services) ----------------------------------
// The CLI's email step consumes these (provider "Azure Communication
// Services"). It assembles the SMTP username from emailAcsResourceName plus
// the Entra app the operator supplies; the password is that app's client
// secret - never an output.

@description('Ready-to-use sender address (DoNotReply@... on the Azure-managed domain, or the branded domain once verified).')
output emailSenderAddress string = enableManagedEmail ? email!.outputs.senderAddress : ''

@description('SMTP host for ACS email (smtp.azurecomm.net).')
output emailSmtpHost string = enableManagedEmail ? email!.outputs.smtpHost : ''

@description('SMTP port for ACS email.')
output emailSmtpPort int = enableManagedEmail ? email!.outputs.smtpPort : 0

@description('ACS communication service name; the CLI uses it to assemble the SMTP username.')
output emailAcsResourceName string = enableManagedEmail ? email!.outputs.acsResourceName : ''

@description('Branded sender domain only: run these once, wait for Verified, then rerun this same deployment - it reads the verification state and links the domain automatically.')
output emailInitiateVerificationCommands array = enableManagedEmail
  ? email!.outputs.initiateVerificationCommands
  : []

@description('Verification DNS records to publish manually when the branded domain is hosted OUTSIDE the delegated zone.')
output emailCustomDomainVerificationRecords object = enableManagedEmail
  ? email!.outputs.customDomainVerificationRecords
  : {}

// ----- Database (PostgreSQL Flexible Server, when managed) -------------------

@description('Managed Postgres server FQDN (the CLI database step discovers it too).')
output postgresHost string = enableManagedDatabase ? postgres!.outputs.fqdn : ''

@description('Managed Postgres port.')
output postgresPort int = enableManagedDatabase ? postgres!.outputs.port : 0

@description('Initial database name.')
output postgresDatabase string = enableManagedDatabase ? postgres!.outputs.databaseName : ''

@description('Admin username; pair it with the POSTGRES_ADMIN_PASSWORD you exported when deploying.')
output postgresAdminUsernameOut string = enableManagedDatabase ? postgres!.outputs.administratorLogin : ''

@description('Run this to restart the server (needed only if wal_level changes are pending; the CLI does it automatically).')
output postgresRestartCommand string = enableManagedDatabase ? postgres!.outputs.restartCommand : ''
