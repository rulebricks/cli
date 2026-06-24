targetScope = 'resourceGroup'

@description('Name of the AKS cluster.')
param clusterName string = 'rulebricks-cluster'

@description('Azure region for all resources.')
param location string = resourceGroup().location

@description('AKS Kubernetes version.')
param kubernetesVersion string = '1.34'

@description('Number of nodes in the default node pool.')
param nodeCount int = 2

@description('Maximum number of nodes in the default (core) pool. Core services need only 2-4 small nodes; burst capacity lives in the dedicated burst pool, so keeping this ceiling low also steers the autoscaler toward the burst pool when the worker fleet scales out.')
param maxNodeCount int = 4

@description('VM size for the default node pool.')
param nodeVmSize string = 'Standard_F4as_v6'

@description('Maximum pods per node in the default node pool.')
@minValue(10)
@maxValue(250)
param maxPods int = 110

@description('OS disk size in GB for the default node pool. 64+ keeps image churn and container ephemeral usage safely under the kubelet disk-pressure eviction threshold (~85%); 30GB disks ran at 65-82% under load.')
@minValue(30)
@maxValue(2048)
param osDiskSizeGB int = 64

@description('OS disk type for the default node pool.')
@allowed([
  'Managed'
  'Ephemeral'
])
param osDiskType string = 'Managed'

@description('Provision the dedicated burst worker pool: one large VM, scale 0->burstMaxCount, Deallocate scale-down (parked at disk-only cost with images cached, ~30-60s resume). Labeled and tainted rulebricks.com/pool=burst; the Rulebricks chart makes workers tolerate and softly prefer it out of the box.')
param enableBurstPool bool = true

@description('VM size for the burst worker pool. Default 16 vCPU (the Fas_v6 family has no 24-vCPU size): 2x4 vCPU core floor + 16 = 24 vCPU running steady-state at full burst, and exactly 32 vCPU even with the core pool at its 4-node max - sized to a 32-vCPU family quota. One big node beats many small ones for bang-bang scaling: one start event, one image set, no straggler tail.')
param burstVmSize string = 'Standard_F16as_v6'

@description('Maximum nodes in the burst pool.')
param burstMaxCount int = 1

// This template is deployment-independent: it provisions the shared identity,
// storage, and Azure Monitor resources but NOT the federated identity
// credentials, which are namespace-scoped. The Rulebricks CLI creates the
// per-deployment federated credentials at `rulebricks deploy` time (it knows the
// namespace and ServiceAccounts), so one cluster can host many deployments
// without re-running this template.

@description('Enable a user-assigned identity and federated credential for external-dns with Azure DNS.')
param enableExternalDns bool = false

@description('Resource group containing the Azure DNS zone. Required when enableExternalDns is true.')
param dnsZoneResourceGroup string = ''

@description('Namespace for the external-dns federated credential. Only used when enableExternalDns is true; set it to the CLI deployment namespace (rulebricks-<deploymentName>). The core vector/backup/prometheus credentials are created by the CLI at deploy time and do not use this.')
param rulebricksNamespace string = 'rulebricks'

// ----------------------------------------------------------------------------
// OBJECT STORAGE (all Rulebricks data)
//
// One identity, one storage account, one container. Decision logs and database
// backups are just key prefixes within it (decision-logs/ and db-backups/), so
// adding more data types later never means another identity or container.
//
// createStorage = true  -> this template provisions the storage account and the
//                          single data container (turnkey; deterministic
//                          globally-unique account name via uniqueString()).
// createStorage = false -> bring your own: set existingStorageAccountName.
// ----------------------------------------------------------------------------
@description('Provision a storage account + the single data container in this template (turnkey). Set false to bring your own.')
param createStorage bool = true

@description('BYO: existing storage account for all Rulebricks data. Required when createStorage is false and decision-log or backup export is enabled.')
param existingStorageAccountName string = ''

@description('Blob container holding all Rulebricks data (decision-logs/ and db-backups/ prefixes).')
param dataContainerName string = '${clusterName}-data'

@description('Enable Vector decision-log export to Blob (federates the Rulebricks identity to the vector ServiceAccount).')
param enableDecisionLogExport bool = false

@description('Enable database backup export to Blob (federates the Rulebricks identity to the backup ServiceAccount).')
param enableBackupExport bool = false

// ----------------------------------------------------------------------------
// METRICS (Prometheus remote write -> Azure Monitor managed Prometheus)
//
// createMonitorWorkspace = true  -> provision Azure Monitor workspace + an
//   explicit Data Collection Endpoint + Data Collection Rule in THIS resource
//   group, so the Monitoring Metrics Publisher role can be scoped to a DCR we
//   own and name. (Creating only the workspace would auto-spawn a DCR/DCE in a
//   separate MA_<name>_<region>_managed RG that this template can't cleanly
//   scope a role to.)
// createMonitorWorkspace = false -> bring your own: set existingDataCollectionRuleId.
// ----------------------------------------------------------------------------
@description('Provision Azure Monitor workspace + DCE + DCR in this template (turnkey). Set false to bring your own DCR.')
param createMonitorWorkspace bool = true

@description('BYO: resource ID of an existing DCR associated with an Azure Monitor workspace. Required when createMonitorWorkspace is false and metrics remote write is enabled. The Monitoring Metrics Publisher role is assigned on this DCR.')
param existingDataCollectionRuleId string = ''

@description('Enable identity + role for Prometheus remote write to Azure Monitor.')
param enableMetricsRemoteWrite bool = false

var networkContributorRoleId = subscriptionResourceId('Microsoft.Authorization/roleDefinitions', 'b24988ac-6180-42a0-ab88-20f7382dd24c')
var dnsZoneContributorRoleId = subscriptionResourceId('Microsoft.Authorization/roleDefinitions', 'befefa01-2a29-4197-83a8-272ff33ce314')
var storageBlobDataContributorRoleId = subscriptionResourceId('Microsoft.Authorization/roleDefinitions', 'ba92f5b4-2d11-453d-a403-e96b0029c9fe')
var monitoringMetricsPublisherRoleId = subscriptionResourceId('Microsoft.Authorization/roleDefinitions', '3913510d-42f4-4e42-8a64-420c390055eb')

// Deterministic, globally-unique storage account name (3-24 chars, lowercase alphanumeric).
var generatedStorageAccountName = take('rb${uniqueString(resourceGroup().id, clusterName)}', 24)
var effectiveStorageAccountName = createStorage ? generatedStorageAccountName : existingStorageAccountName
var enableBlobAccess = enableDecisionLogExport || enableBackupExport
var monitorWorkspaceName = '${clusterName}-amw'
var dceName = '${clusterName}-dce'
var dcrName = '${clusterName}-dcr'

resource vnet 'Microsoft.Network/virtualNetworks@2023-11-01' = {
  name: '${clusterName}-vnet'
  location: location
  tags: {
    Environment: 'rulebricks'
  }
  properties: {
    addressSpace: {
      addressPrefixes: [
        '10.0.0.0/8'
      ]
    }
    subnets: [
      {
        name: 'aks-subnet'
        properties: {
          addressPrefix: '10.240.0.0/16'
        }
      }
    ]
  }
}

resource nsg 'Microsoft.Network/networkSecurityGroups@2023-11-01' = {
  name: '${clusterName}-nsg'
  location: location
  tags: {
    Environment: 'rulebricks'
  }
  properties: {
    securityRules: [
      {
        name: 'AllowVNetInbound'
        properties: {
          priority: 100
          direction: 'Inbound'
          access: 'Allow'
          protocol: '*'
          sourcePortRange: '*'
          destinationPortRange: '*'
          sourceAddressPrefix: 'VirtualNetwork'
          destinationAddressPrefix: 'VirtualNetwork'
        }
      }
      {
        name: 'AllowVNetOutbound'
        properties: {
          priority: 100
          direction: 'Outbound'
          access: 'Allow'
          protocol: '*'
          sourcePortRange: '*'
          destinationPortRange: '*'
          sourceAddressPrefix: 'VirtualNetwork'
          destinationAddressPrefix: 'VirtualNetwork'
        }
      }
      {
        name: 'AllowHTTPInbound'
        properties: {
          priority: 110
          direction: 'Inbound'
          access: 'Allow'
          protocol: 'Tcp'
          sourcePortRange: '*'
          destinationPortRange: '80'
          sourceAddressPrefix: 'Internet'
          destinationAddressPrefix: '*'
        }
      }
      {
        name: 'AllowHTTPSInbound'
        properties: {
          priority: 120
          direction: 'Inbound'
          access: 'Allow'
          protocol: 'Tcp'
          sourcePortRange: '*'
          destinationPortRange: '443'
          sourceAddressPrefix: 'Internet'
          destinationAddressPrefix: '*'
        }
      }
    ]
  }
}

resource subnet 'Microsoft.Network/virtualNetworks/subnets@2023-11-01' = {
  parent: vnet
  name: 'aks-subnet'
  properties: {
    addressPrefix: '10.240.0.0/16'
    networkSecurityGroup: {
      id: nsg.id
    }
  }
}

resource aksIdentity 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' = {
  name: '${clusterName}-identity'
  location: location
}

resource aksNetworkRole 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(vnet.id, aksIdentity.id, 'Network Contributor')
  scope: vnet
  properties: {
    roleDefinitionId: networkContributorRoleId
    principalId: aksIdentity.properties.principalId
    principalType: 'ServicePrincipal'
  }
}

resource aks 'Microsoft.ContainerService/managedClusters@2024-05-01' = {
  name: clusterName
  location: location
  tags: {
    Environment: 'rulebricks'
  }
  identity: {
    type: 'UserAssigned'
    userAssignedIdentities: {
      '${aksIdentity.id}': {}
    }
  }
  properties: {
    dnsPrefix: clusterName
    kubernetesVersion: kubernetesVersion
    agentPoolProfiles: concat(
      [
        {
          name: 'default'
          count: nodeCount
          enableAutoScaling: true
          minCount: nodeCount
          maxCount: maxNodeCount
          vmSize: nodeVmSize
          maxPods: maxPods
          osDiskSizeGB: osDiskSizeGB
          osDiskType: osDiskType
          osType: 'Linux'
          type: 'VirtualMachineScaleSets'
          mode: 'System'
          // Scale-down parks VMs (stopped, disk-only cost) instead of
          // deleting them; resume is ~30-60s with container images cached.
          scaleDownMode: 'Deallocate'
          vnetSubnetID: subnet.id
        }
      ],
      enableBurstPool
        ? [
            {
              // Dedicated burst capacity for the stateless worker fleet:
              // one large VM that parks (Deallocate) between bursts. The
              // taint keeps everything except workers off it; the label is
              // what the chart's soft node affinity targets. First-ever
              // burst cold-provisions (~2-4 min); thereafter resume is
              // ~30-60s with images cached.
              name: 'burst'
              count: 0
              enableAutoScaling: true
              minCount: 0
              maxCount: burstMaxCount
              vmSize: burstVmSize
              maxPods: maxPods
              osDiskSizeGB: osDiskSizeGB
              osDiskType: osDiskType
              osType: 'Linux'
              type: 'VirtualMachineScaleSets'
              mode: 'User'
              scaleDownMode: 'Deallocate'
              nodeLabels: {
                'rulebricks.com/pool': 'burst'
              }
              nodeTaints: [
                'rulebricks.com/pool=burst:NoSchedule'
              ]
              vnetSubnetID: subnet.id
            }
          ]
        : [],
    )
    // Tuned for bursty traffic: detect pending pods quickly and pick the
    // node pool that wastes the least capacity. With the core pool capped at
    // maxNodeCount (4), a scaled-out worker fleet overflows to the burst
    // pool within 1-2 autoscaler iterations. Scale-down keeps defaults -
    // gaps between bursts should not thrash nodes.
    autoScalerProfile: {
      'scan-interval': '10s'
      expander: 'least-waste'
    }
    networkProfile: {
      networkPlugin: 'azure'
      networkPolicy: 'calico'
      loadBalancerSku: 'standard'
      serviceCidr: '10.0.0.0/16'
      dnsServiceIP: '10.0.0.10'
    }
    oidcIssuerProfile: {
      enabled: true
    }
    securityProfile: {
      workloadIdentity: {
        enabled: true
      }
    }
    storageProfile: {
      diskCSIDriver: {
        enabled: true
      }
      fileCSIDriver: {
        enabled: true
      }
    }
  }
  dependsOn: [
    aksNetworkRole
  ]
}

resource externalDnsIdentity 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' = if (enableExternalDns) {
  name: '${clusterName}-external-dns'
  location: location
}

resource externalDnsRole 'Microsoft.Authorization/roleAssignments@2022-04-01' = if (enableExternalDns && (empty(dnsZoneResourceGroup) || dnsZoneResourceGroup == resourceGroup().name)) {
  name: guid(resourceGroup().id, externalDnsIdentity!.id, 'DNS Zone Contributor')
  scope: resourceGroup()
  properties: {
    roleDefinitionId: dnsZoneContributorRoleId
    principalId: externalDnsIdentity!.properties.principalId
    principalType: 'ServicePrincipal'
  }
}

resource externalDnsFederatedCredential 'Microsoft.ManagedIdentity/userAssignedIdentities/federatedIdentityCredentials@2023-01-31' = if (enableExternalDns) {
  parent: externalDnsIdentity
  name: 'external-dns'
  properties: {
    issuer: aks.properties.oidcIssuerProfile.issuerURL
    subject: 'system:serviceaccount:${rulebricksNamespace}:external-dns'
    audiences: [
      'api://AzureADTokenExchange'
    ]
  }
}

// ----------------------------------------------------------------------------
// STORAGE ACCOUNT + CONTAINERS (created only when createStorage = true)
// ----------------------------------------------------------------------------
resource storageAccount 'Microsoft.Storage/storageAccounts@2023-01-01' = if (createStorage) {
  name: generatedStorageAccountName
  location: location
  sku: {
    name: 'Standard_LRS'
  }
  kind: 'StorageV2'
  properties: {
    accessTier: 'Hot'
    allowBlobPublicAccess: false
    minimumTlsVersion: 'TLS1_2'
    supportsHttpsTrafficOnly: true
  }
}

resource blobService 'Microsoft.Storage/storageAccounts/blobServices@2023-01-01' = if (createStorage) {
  parent: storageAccount
  name: 'default'
}

resource dataContainer 'Microsoft.Storage/storageAccounts/blobServices/containers@2023-01-01' = if (createStorage && enableBlobAccess) {
  parent: blobService
  name: dataContainerName
  properties: {
    publicAccess: 'None'
  }
}

// Existing-account reference for BYO (createStorage = false)
resource existingStorageAccount 'Microsoft.Storage/storageAccounts@2023-01-01' existing = if (!createStorage && enableBlobAccess && !empty(effectiveStorageAccountName)) {
  name: effectiveStorageAccountName
}

// ----------------------------------------------------------------------------
// RULEBRICKS WORKLOAD IDENTITY (single identity for all data paths)
// Identity:  ${clusterName}-rulebricks
// Roles:     Storage Blob Data Contributor (logs + backups) on the storage
//            account, and Monitoring Metrics Publisher on the DCR (below).
// Federation to the vector / backup / prometheus ServiceAccounts is created by
// the Rulebricks CLI at deploy time (namespace-scoped), so this one identity can
// back any number of deployments on the cluster.
// ----------------------------------------------------------------------------
resource rulebricksIdentity 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' = {
  name: '${clusterName}-rulebricks'
  location: location
}

resource blobRoleCreated 'Microsoft.Authorization/roleAssignments@2022-04-01' = if (enableBlobAccess && createStorage) {
  name: guid(storageAccount.id, rulebricksIdentity.id, 'Storage Blob Data Contributor')
  scope: storageAccount
  properties: {
    roleDefinitionId: storageBlobDataContributorRoleId
    principalId: rulebricksIdentity.properties.principalId
    principalType: 'ServicePrincipal'
  }
}

resource blobRoleByo 'Microsoft.Authorization/roleAssignments@2022-04-01' = if (enableBlobAccess && !createStorage && !empty(effectiveStorageAccountName)) {
  name: guid(existingStorageAccount.id, rulebricksIdentity.id, 'Storage Blob Data Contributor')
  scope: existingStorageAccount
  properties: {
    roleDefinitionId: storageBlobDataContributorRoleId
    principalId: rulebricksIdentity.properties.principalId
    principalType: 'ServicePrincipal'
  }
}

// Federated credentials for vector / backup / prometheus are created by the
// Rulebricks CLI at deploy time (they are namespace-scoped). This template only
// grants the identity its roles.

// ----------------------------------------------------------------------------
// METRICS PATH (same Rulebricks identity)
// Federated: created by the CLI at deploy time for SA ${rulebricksNamespace}:prometheus
// Role:      Monitoring Metrics Publisher on the DCR
// Note:      role takes ~30 min to propagate; expect HTTP 403 until then.
//
// createMonitorWorkspace = true provisions AMW + DCE + DCR here so the role is
// scoped to a DCR we own. The remote-write endpoint for Prometheus is the DCE
// metricsIngestion endpoint (surfaced as an output).
// ----------------------------------------------------------------------------
resource monitorWorkspace 'Microsoft.Monitor/accounts@2023-04-03' = if (enableMetricsRemoteWrite && createMonitorWorkspace) {
  name: monitorWorkspaceName
  location: location
}

resource dce 'Microsoft.Insights/dataCollectionEndpoints@2023-03-11' = if (enableMetricsRemoteWrite && createMonitorWorkspace) {
  name: dceName
  location: location
  kind: 'Linux'
  properties: {}
}

resource dcr 'Microsoft.Insights/dataCollectionRules@2023-03-11' = if (enableMetricsRemoteWrite && createMonitorWorkspace) {
  name: dcrName
  location: location
  kind: 'Linux'
  properties: {
    dataCollectionEndpointId: dce.id
    dataSources: {
      prometheusForwarder: [
        {
          name: 'PrometheusDataSource'
          streams: [
            'Microsoft-PrometheusMetrics'
          ]
          labelIncludeFilter: {}
        }
      ]
    }
    destinations: {
      monitoringAccounts: [
        {
          accountResourceId: monitorWorkspace.id
          name: 'MonitoringAccountDestination'
        }
      ]
    }
    dataFlows: [
      {
        streams: [
          'Microsoft-PrometheusMetrics'
        ]
        destinations: [
          'MonitoringAccountDestination'
        ]
      }
    ]
  }
}

// BYO DCR reference (createMonitorWorkspace = false)
resource existingDcr 'Microsoft.Insights/dataCollectionRules@2023-03-11' existing = if (enableMetricsRemoteWrite && !createMonitorWorkspace && !empty(existingDataCollectionRuleId)) {
  name: last(split(existingDataCollectionRuleId, '/'))
}

resource metricsPublisherRoleCreated 'Microsoft.Authorization/roleAssignments@2022-04-01' = if (enableMetricsRemoteWrite && createMonitorWorkspace) {
  name: guid(dcr.id, rulebricksIdentity.id, 'Monitoring Metrics Publisher')
  scope: dcr
  properties: {
    roleDefinitionId: monitoringMetricsPublisherRoleId
    principalId: rulebricksIdentity.properties.principalId
    principalType: 'ServicePrincipal'
  }
}

resource metricsPublisherRoleByo 'Microsoft.Authorization/roleAssignments@2022-04-01' = if (enableMetricsRemoteWrite && !createMonitorWorkspace && !empty(existingDataCollectionRuleId)) {
  name: guid(existingDataCollectionRuleId, rulebricksIdentity.id, 'Monitoring Metrics Publisher')
  scope: existingDcr
  properties: {
    roleDefinitionId: monitoringMetricsPublisherRoleId
    principalId: rulebricksIdentity.properties.principalId
    principalType: 'ServicePrincipal'
  }
}

output clusterName string = aks.name
output resourceGroupName string = resourceGroup().name
output location string = location
output kubeconfigCommand string = 'az aks get-credentials --name ${clusterName} --resource-group ${resourceGroup().name}'
output externalDnsClientId string = enableExternalDns ? externalDnsIdentity!.properties.clientId : ''

// Storage outputs. One identity + one account + one container back every data
// path; decision logs and backups are prefixes within the container.
output storageAccountName string = effectiveStorageAccountName
output dataContainer string = enableBlobAccess ? dataContainerName : ''
output rulebricksClientId string = rulebricksIdentity.properties.clientId

// Metrics outputs (Prometheus remote write uses the same rulebricksClientId).
// DCE ingestion endpoint + DCR immutableId. The Prometheus remote_write URL is:
//   <dceMetricsIngestionEndpoint>/dataCollectionRules/<dcrImmutableId>/streams/Microsoft-PrometheusMetrics/api/v1/write?api-version=2023-04-24
output dceMetricsIngestionEndpoint string = (enableMetricsRemoteWrite && createMonitorWorkspace) ? dce!.properties.metricsIngestion.endpoint : ''
output dcrImmutableId string = (enableMetricsRemoteWrite && createMonitorWorkspace) ? dcr!.properties.immutableId : ''
output dataCollectionRuleId string = (enableMetricsRemoteWrite && createMonitorWorkspace) ? dcr!.id : existingDataCollectionRuleId
