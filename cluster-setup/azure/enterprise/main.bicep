// =============================================================================
// Rulebricks AKS cluster, enterprise edition.
//
// One `az deployment group create` run composes:
//
//   modules/network.bicep   VNet with purpose-built subnets (parameterized
//                           address space - no 10/8 grabs), NSG.
//   modules/cluster.bicep   AKS with Azure CNI Overlay + Cilium, Workload
//                           Identity + OIDC, optional private API server and
//                           Entra/Azure RBAC; core + burst node pools with the
//                           rulebricks.com/pool=burst label/taint contract.
//   modules/data.bicep      The single <cluster>-rulebricks identity, blob
//                           storage for decision logs + DB backups, Azure
//                           Monitor managed Prometheus (AMW + DCE + DCR),
//                           optional external-dns identity.
//   modules/kafka.bicep     enableManagedKafka    -> Event Hubs Premium
//   modules/redis.bicep     enableManagedRedis    -> Azure Managed Redis
//   modules/postgres.bicep  enableManagedDatabase -> PostgreSQL Flexible Server
//
// The three managed data services are independent true/false toggles - any
// combination is valid; the Rulebricks chart runs Kafka, Valkey, and Postgres
// in-cluster for whichever you leave disabled.
//
// Everything except the optional external-dns path is deployment-independent:
// federated identity credentials are namespace-scoped, so the Rulebricks CLI
// creates them at `rulebricks deploy` time against the <cluster>-rulebricks
// identity. One cluster can host any number of deployments.
//
// Outputs map 1:1 to the fields the Rulebricks CLI wizard asks for (see the
// README's outputs table).
// =============================================================================

targetScope = 'resourceGroup'

// ----------------------------------------------------------------------------
// Cluster
// ----------------------------------------------------------------------------
@description('Name of the AKS cluster; prefixes every resource name. The Rulebricks CLI preselects resources named <cluster>-rulebricks and <cluster>-data, so keep the convention if you rename.')
param clusterName string = 'rulebricks-cluster'

@description('Azure region for all resources.')
param location string = resourceGroup().location

@description('AKS Kubernetes version.')
param kubernetesVersion string = '1.34'

@description('Restrict the Kubernetes API server to private access. Requires VPN/Bastion/jumpbox connectivity to run kubectl, helm, and the Rulebricks CLI.')
param enablePrivateCluster bool = false

@description('Entra ID integration with Azure RBAC for Kubernetes authorization; disables local accounts. Operators need the "Azure Kubernetes Service RBAC Cluster Admin" role and kubelogin.')
param enableEntraRbac bool = false

// ----------------------------------------------------------------------------
// Network. All CIDRs are parameterized so enterprises can slot the VNet into
// existing IPAM. serviceCidr/podCidr are cluster-internal but still must not
// overlap the VNet or peered networks.
// ----------------------------------------------------------------------------
param vnetAddressSpace string = '10.240.0.0/16'
param aksSubnetPrefix string = '10.240.0.0/22'
param privateEndpointsSubnetPrefix string = '10.240.4.0/24'
param postgresSubnetPrefix string = '10.240.5.0/24'
param serviceCidr string = '172.16.0.0/16'
param dnsServiceIP string = '172.16.0.10'
param podCidr string = '192.168.0.0/16'

@description('Reach Event Hubs / Managed Redis through private endpoints in the private-endpoints subnet (Event Hubs additionally disables public network access). Postgres Flexible Server is always VNet-only via subnet delegation.')
param enableDataServicePrivateEndpoints bool = false

// ----------------------------------------------------------------------------
// Node pools (same sizing rationale as the turnkey template: the chart's
// steady-state request floor is ~10 vCPU / ~23 GiB, so 3 x 4-vCPU/16-GiB
// nodes minimum; the burst pool absorbs the KEDA-scaled worker fleet).
// ----------------------------------------------------------------------------
param nodeCount int = 3
param maxNodeCount int = 5
param nodeVmSize string = 'Standard_F4as_v6'

@minValue(10)
@maxValue(250)
param maxPods int = 110

@minValue(30)
@maxValue(2048)
param osDiskSizeGB int = 64

@allowed(['Managed', 'Ephemeral'])
param osDiskType string = 'Managed'

param enableBurstPool bool = true
param burstVmSize string = 'Standard_F16as_v6'
param burstMaxCount int = 1

// ----------------------------------------------------------------------------
// Storage / metrics / external-dns (identical to the turnkey template)
// ----------------------------------------------------------------------------
@description('Provision a storage account + the single data container (turnkey). Set false to bring your own.')
param createStorage bool = true

@description('BYO: existing storage account for all Rulebricks data. Required when createStorage is false and decision-log or backup export is enabled.')
param existingStorageAccountName string = ''

@description('Blob container holding all Rulebricks data (decision-logs/ and db-backups/ prefixes).')
param dataContainerName string = '${clusterName}-data'

@description('Enable Vector decision-log export to Blob.')
param enableDecisionLogExport bool = true

@description('Enable database backup export to Blob.')
param enableBackupExport bool = true

@description('Provision Azure Monitor workspace + DCE + DCR (turnkey). Set false to bring your own DCR.')
param createMonitorWorkspace bool = true

@description('BYO: resource ID of an existing DCR associated with an Azure Monitor workspace.')
param existingDataCollectionRuleId string = ''

@description('Enable identity + role for Prometheus remote write to Azure Monitor.')
param enableMetricsRemoteWrite bool = true

@description('Enable a user-assigned identity and federated credential for external-dns with Azure DNS.')
param enableExternalDns bool = false

@description('Resource group containing the Azure DNS zone. Required when enableExternalDns is true.')
param dnsZoneResourceGroup string = ''

@description('Namespace for the external-dns federated credential (rulebricks-<deploymentName>). Only used when enableExternalDns is true.')
param rulebricksNamespace string = 'rulebricks'

// ----------------------------------------------------------------------------
// Managed Kafka (Azure Event Hubs Premium)
// ----------------------------------------------------------------------------
@description('Provision Event Hubs Premium as the Kafka backend instead of running Kafka in-cluster. CLI preset: "azure-event-hubs" (SASL PLAIN, $ConnectionString).')
param enableManagedKafka bool = false

@description('Event Hubs namespace name; globally unique (becomes <name>.servicebus.windows.net).')
param eventHubsNamespaceName string = '${toLower(clusterName)}-kafka-${take(uniqueString(resourceGroup().id), 6)}'

@description('Premium Processing Units (1, 2, 4, 8, 12, 16). One PU = 200 partitions namespace-wide; the default hub layout uses 152.')
@allowed([1, 2, 4, 8, 12, 16])
param eventHubsCapacityUnits int = 1

@description('Kafka topic prefix; must match the deployment\'s kafkaTopicPrefix (CLI default "com.rulebricks.").')
param kafkaTopicPrefix string = 'com.rulebricks.'

@description('Partitions for solution/solution-response hubs. Premium caps at 100/hub (the chart default of 128 does not fit) - set rulebricks.hps.workers.solutionPartitions to this same value.')
@minValue(1)
@maxValue(100)
param solutionPartitions int = 64

@description('Partitions for the decision-logs hub.')
@minValue(1)
@maxValue(100)
param logsPartitions int = 24

@description('Event hub retention in hours.')
param kafkaRetentionHours int = 168

// ----------------------------------------------------------------------------
// Managed Redis (Azure Managed Redis)
// ----------------------------------------------------------------------------
@description('Provision Azure Managed Redis instead of running Valkey in-cluster. CLI: redis mode "external", TLS on, port 10000.')
param enableManagedRedis bool = false

@description('Azure Managed Redis name; unique within the region.')
param redisName string = '${toLower(clusterName)}-redis-${take(uniqueString(resourceGroup().id), 6)}'

@description('Azure Managed Redis SKU (Balanced_B0/B1/B3/B5..., MemoryOptimized_M*, ComputeOptimized_X*).')
param redisSkuName string = 'Balanced_B1'

// ----------------------------------------------------------------------------
// Managed database (Azure Database for PostgreSQL Flexible Server)
// ----------------------------------------------------------------------------
@description('Provision PostgreSQL Flexible Server instead of running Postgres in-cluster. CLI: database "self-hosted" + postgres mode "external".')
param enableManagedDatabase bool = false

@description('Server name; globally unique (becomes <name>.postgres.database.azure.com).')
param postgresServerName string = '${toLower(clusterName)}-pg-${take(uniqueString(resourceGroup().id), 6)}'

@description('PostgreSQL major version (the in-cluster Supabase image tracks Postgres 17).')
param postgresVersion string = '17'

@description('Admin login for bootstrap (the CLI wizard\'s master username).')
param postgresAdminUsername string = 'rbadmin'

@secure()
@description('REQUIRED when enableManagedDatabase is true. Admin password; the CLI wizard\'s bootstrap master password.')
param postgresAdminPassword string = ''

@description('Flexible Server compute SKU.')
param postgresSkuName string = 'Standard_D4ds_v5'

@allowed(['Burstable', 'GeneralPurpose', 'MemoryOptimized'])
param postgresSkuTier string = 'GeneralPurpose'

@description('Storage in GB (auto-grow enabled).')
param postgresStorageSizeGB int = 128

@description('Zone-redundant HA (standby in a second AZ; requires an AZ-enabled region).')
param postgresHighAvailability bool = false

@minValue(7)
@maxValue(35)
param postgresBackupRetentionDays int = 7

// ============================================================================
// Modules
// ============================================================================
module network 'modules/network.bicep' = {
  name: '${clusterName}-network'
  params: {
    clusterName: clusterName
    location: location
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
    kubernetesVersion: kubernetesVersion
    vnetName: network.outputs.vnetName
    aksSubnetId: network.outputs.aksSubnetId
    nodeCount: nodeCount
    maxNodeCount: maxNodeCount
    nodeVmSize: nodeVmSize
    maxPods: maxPods
    osDiskSizeGB: osDiskSizeGB
    osDiskType: osDiskType
    enableBurstPool: enableBurstPool
    burstVmSize: burstVmSize
    burstMaxCount: burstMaxCount
    serviceCidr: serviceCidr
    dnsServiceIP: dnsServiceIP
    podCidr: podCidr
    enablePrivateCluster: enablePrivateCluster
    enableEntraRbac: enableEntraRbac
  }
}

module data 'modules/data.bicep' = {
  name: '${clusterName}-data'
  params: {
    clusterName: clusterName
    location: location
    oidcIssuerUrl: cluster.outputs.oidcIssuerUrl
    enableExternalDns: enableExternalDns
    dnsZoneResourceGroup: dnsZoneResourceGroup
    rulebricksNamespace: rulebricksNamespace
    createStorage: createStorage
    existingStorageAccountName: existingStorageAccountName
    dataContainerName: dataContainerName
    enableDecisionLogExport: enableDecisionLogExport
    enableBackupExport: enableBackupExport
    createMonitorWorkspace: createMonitorWorkspace
    existingDataCollectionRuleId: existingDataCollectionRuleId
    enableMetricsRemoteWrite: enableMetricsRemoteWrite
  }
}

module kafka 'modules/kafka.bicep' = if (enableManagedKafka) {
  name: '${clusterName}-kafka'
  params: {
    clusterName: clusterName
    location: location
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
// Outputs (grouped by the Rulebricks CLI wizard step that consumes them)
// ============================================================================
output clusterName string = cluster.outputs.clusterName
output resourceGroupName string = resourceGroup().name
output location string = location
output kubeconfigCommand string = 'az aks get-credentials --name ${clusterName} --resource-group ${resourceGroup().name}'

// --- Storage + identity (CLI storage step) -----------------------------------
output rulebricksClientId string = data.outputs.rulebricksClientId
output storageAccountName string = data.outputs.storageAccountName
output dataContainer string = data.outputs.dataContainer
output externalDnsClientId string = data.outputs.externalDnsClientId

// --- Metrics (CLI monitoring step) -------------------------------------------
// Prometheus remote_write URL =
//   <dceMetricsIngestionEndpoint>/dataCollectionRules/<dcrImmutableId>/streams/Microsoft-PrometheusMetrics/api/v1/write?api-version=2023-04-24
output dceMetricsIngestionEndpoint string = data.outputs.dceMetricsIngestionEndpoint
output dcrImmutableId string = data.outputs.dcrImmutableId
output dataCollectionRuleId string = data.outputs.dataCollectionRuleId

// --- Managed Kafka (CLI external-services step, preset azure-event-hubs) -----
output kafkaBootstrapServers string = enableManagedKafka ? kafka!.outputs.bootstrapServers : ''
output kafkaTopics array = enableManagedKafka ? kafka!.outputs.topicNames : []
output kafkaConnectionStringCommand string = enableManagedKafka ? kafka!.outputs.connectionStringCommand : ''
output kafkaSolutionPartitions int = enableManagedKafka ? solutionPartitions : 0

// --- Managed Redis (CLI external-services step) -------------------------------
output redisHost string = enableManagedRedis ? redis!.outputs.hostName : ''
output redisPort int = enableManagedRedis ? redis!.outputs.port : 0
output redisTlsEnabled bool = enableManagedRedis
output redisAccessKeyCommand string = enableManagedRedis ? redis!.outputs.accessKeyCommand : ''

// --- Managed database (CLI external-services step, self-hosted Supabase) -----
output postgresHost string = enableManagedDatabase ? postgres!.outputs.fqdn : ''
output postgresPort int = enableManagedDatabase ? postgres!.outputs.port : 0
output postgresDatabase string = enableManagedDatabase ? postgres!.outputs.databaseName : ''
output postgresAdminUsernameOut string = enableManagedDatabase ? postgres!.outputs.administratorLogin : ''
output postgresRestartCommand string = enableManagedDatabase ? postgres!.outputs.restartCommand : ''
