targetScope = 'resourceGroup'

@allowed([
  'test'
  'production'
])
@description('Selects low-cost test defaults or hardened production defaults. Every derived setting can still be overridden.')
param deploymentProfile string = 'test'

param clusterName string = 'rulebricks-cluster'
param location string = resourceGroup().location
param environmentName string = deploymentProfile
param resourceTags object = {
  environment: environmentName
  managedBy: 'bicep'
  workload: 'rulebricks'
}

param kubernetesVersion string = '1.34'

@allowed([
  'Free'
  'Standard'
  'Premium'
])
param aksSkuTier string = deploymentProfile == 'production' ? 'Standard' : 'Free'

param enablePrivateCluster bool = deploymentProfile == 'production'
param apiServerAuthorizedIpRanges array = []
param enableEntraRbac bool = deploymentProfile == 'production'

@description('Entra group or user object IDs granted AKS RBAC Cluster Admin.')
param aksAdminPrincipalIds array = []
param availabilityZones array = deploymentProfile == 'production' ? ['1', '2', '3'] : []

@allowed([
  'none'
  'patch'
  'rapid'
  'stable'
])
param kubernetesUpgradeChannel string = deploymentProfile == 'production' ? 'stable' : 'none'

@allowed([
  'None'
  'NodeImage'
  'SecurityPatch'
  'Unmanaged'
])
param nodeOsUpgradeChannel string = deploymentProfile == 'production' ? 'NodeImage' : 'None'

param enableMaintenanceWindow bool = deploymentProfile == 'production'

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
param enableAzurePolicy bool = deploymentProfile == 'production'
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
param enableDataServicePrivateEndpoints bool = deploymentProfile == 'production'

param nodeCount int = 3
param maxNodeCount int = deploymentProfile == 'production' ? 5 : 4
param nodeVmSize string = 'Standard_F4as_v6'

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

param separateSystemPool bool = deploymentProfile == 'production'
param systemNodeCount int = 3
param systemMaxNodeCount int = 3
param systemNodeVmSize string = 'Standard_D2as_v4'

param enableBurstPool bool = deploymentProfile == 'production'
param burstVmSize string = 'Standard_F16as_v6'
param burstMaxCount int = 1

param createStorage bool = true
param existingStorageAccountName string = ''
param existingStorageAccountResourceGroup string = ''
param dataContainerName string = '${clusterName}-data'
param enableDecisionLogExport bool = true
param enableBackupExport bool = true

@allowed([
  'Standard_LRS'
  'Standard_ZRS'
  'Standard_GRS'
  'Standard_GZRS'
  'Standard_RAGZRS'
])
param storageSkuName string = deploymentProfile == 'production' ? 'Standard_ZRS' : 'Standard_LRS'

param allowStorageSharedKeyAccess bool = deploymentProfile == 'test'
param enableStorageVersioning bool = deploymentProfile == 'production'

@minValue(0)
@maxValue(365)
param storageSoftDeleteDays int = deploymentProfile == 'production' ? 30 : 7

param enableStoragePrivateEndpoint bool = deploymentProfile == 'production'
param enableStorageDeleteLock bool = deploymentProfile == 'production'

param enableMetricsRemoteWrite bool = false
param createMonitorWorkspace bool = true
param existingDataCollectionRuleName string = ''
param existingDataCollectionRuleResourceGroup string = ''
param enableManagedGrafana bool = false
param grafanaName string = take('rbgraf${take(uniqueString(resourceGroup().id), 6)}', 23)

param enableExternalDns bool = false
param dnsZoneName string = ''
param dnsZoneResourceGroup string = ''
param rulebricksNamespace string = 'rulebricks'

param enableKeyVaultIntegration bool = deploymentProfile == 'production'
param createKeyVault bool = true
param keyVaultName string = take('rbkv${uniqueString(resourceGroup().id, clusterName)}', 24)
param existingKeyVaultResourceGroup string = ''
param allowKeyVaultPublicAccess bool = deploymentProfile == 'test'
param enableKeyVaultPrivateEndpoint bool = deploymentProfile == 'production'
param enableKeyVaultPurgeProtection bool = deploymentProfile == 'production'

@minValue(7)
@maxValue(90)
param keyVaultSoftDeleteRetentionDays int = deploymentProfile == 'production' ? 90 : 7

@description('Object IDs allowed to create and rotate secrets in a newly created vault.')
param keyVaultWriterPrincipalIds array = []

param esoServiceAccountName string = 'rulebricks-key-vault-reader'

param enableContainerRegistry bool = deploymentProfile == 'production'
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

param allowContainerRegistryPublicAccess bool = deploymentProfile == 'test'

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

param kafkaTopicPrefix string = 'com.rulebricks.'

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
    oidcIssuerUrl: cluster.outputs.oidcIssuerUrl
    enableExternalDns: enableExternalDns
    enableExternalSecrets: enableKeyVaultIntegration
    rulebricksNamespace: rulebricksNamespace
    esoServiceAccountName: esoServiceAccountName
  }
}

module externalDnsRole 'modules/dns-role.bicep' = if (enableExternalDns) {
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
    enableDecisionLogExport: enableDecisionLogExport
    enableBackupExport: enableBackupExport
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

module storageRoleByo 'modules/storage-role.bicep' = if (!createStorage && (enableDecisionLogExport || enableBackupExport)) {
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
  }
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

output deploymentProfile string = deploymentProfile
output clusterName string = cluster.outputs.clusterName
output resourceGroupName string = resourceGroup().name
output location string = location
output kubeconfigCommand string = 'az aks get-credentials --name ${clusterName} --resource-group ${resourceGroup().name}'

output rulebricksClientId string = identity.outputs.rulebricksClientId
output storageAccountName string = storage.outputs.storageAccountName
output dataContainer string = storage.outputs.dataContainer
output externalDnsClientId string = identity.outputs.externalDnsClientId
output externalSecretsClientId string = enableKeyVaultIntegration ? identity.outputs.externalSecretsClientId : ''
output externalSecretsTenantId string = enableKeyVaultIntegration ? tenant().tenantId : ''
output externalSecretsNamespace string = enableKeyVaultIntegration ? rulebricksNamespace : ''
output externalSecretsServiceAccountName string = enableKeyVaultIntegration ? esoServiceAccountName : ''
output keyVaultName string = enableKeyVaultIntegration ? keyVaultName : ''
output keyVaultUri string = enableKeyVaultIntegration
  ? (createKeyVault ? keyVault!.outputs.vaultUri : keyVaultRoleByo!.outputs.vaultUri)
  : ''

output containerRegistryName string = enableContainerRegistry ? acr!.outputs.registryName : ''
output containerRegistryLoginServer string = enableContainerRegistry ? acr!.outputs.loginServer : ''

output dceMetricsIngestionEndpoint string = enableMetricsRemoteWrite && createMonitorWorkspace
  ? monitoring!.outputs.dceMetricsIngestionEndpoint
  : ''
output dcrImmutableId string = enableMetricsRemoteWrite && createMonitorWorkspace
  ? monitoring!.outputs.dcrImmutableId
  : ''
output dataCollectionRuleId string = enableMetricsRemoteWrite
  ? (createMonitorWorkspace ? monitoring!.outputs.dataCollectionRuleId : monitoringRoleByo!.outputs.dataCollectionRuleId)
  : ''
output grafanaEndpoint string = enableMetricsRemoteWrite && createMonitorWorkspace
  ? monitoring!.outputs.grafanaEndpoint
  : ''

output kafkaBootstrapServers string = enableManagedKafka ? kafka!.outputs.bootstrapServers : ''
output kafkaTopics array = enableManagedKafka ? kafka!.outputs.topicNames : []
output kafkaConnectionStringCommand string = enableManagedKafka ? kafka!.outputs.connectionStringCommand : ''
output kafkaSolutionPartitions int = enableManagedKafka ? solutionPartitions : 0

output redisHost string = enableManagedRedis ? redis!.outputs.hostName : ''
output redisPort int = enableManagedRedis ? redis!.outputs.port : 0
output redisTlsEnabled bool = enableManagedRedis
output redisAccessKeyCommand string = enableManagedRedis ? redis!.outputs.accessKeyCommand : ''

output postgresHost string = enableManagedDatabase ? postgres!.outputs.fqdn : ''
output postgresPort int = enableManagedDatabase ? postgres!.outputs.port : 0
output postgresDatabase string = enableManagedDatabase ? postgres!.outputs.databaseName : ''
output postgresAdminUsernameOut string = enableManagedDatabase ? postgres!.outputs.administratorLogin : ''
output postgresRestartCommand string = enableManagedDatabase ? postgres!.outputs.restartCommand : ''
