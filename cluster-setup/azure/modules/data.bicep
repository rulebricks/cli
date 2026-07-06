// Rulebricks workload identity + object storage + metrics pipeline.
//
// One user-assigned identity, <cluster>-rulebricks, holds every data-path
// role; all data lives in one blob container under per-purpose prefixes
// (decision-logs/ and db-backups/). Federated identity credentials are
// namespace-scoped, so the Rulebricks CLI creates them at `rulebricks deploy`
// time (vector / <release>-backup / prometheus / <release>-clickhouse against
// this identity) - which keeps this module deployment-independent: one
// cluster hosts any number of deployments.

param clusterName string
param location string

@description('OIDC issuer URL of the AKS cluster (for the optional external-dns federated credential).')
param oidcIssuerUrl string

param enableExternalDns bool
param dnsZoneResourceGroup string
param rulebricksNamespace string

param createStorage bool
param existingStorageAccountName string
param dataContainerName string
param enableDecisionLogExport bool
param enableBackupExport bool

param createMonitorWorkspace bool
param existingDataCollectionRuleId string
param enableMetricsRemoteWrite bool

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

// ----------------------------------------------------------------------------
// RULEBRICKS WORKLOAD IDENTITY (single identity for all data paths)
// ----------------------------------------------------------------------------
resource rulebricksIdentity 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' = {
  name: '${clusterName}-rulebricks'
  location: location
}

// ----------------------------------------------------------------------------
// OBJECT STORAGE (all Rulebricks data)
// ----------------------------------------------------------------------------
resource storageAccount 'Microsoft.Storage/storageAccounts@2023-01-01' = if (createStorage) {
  name: generatedStorageAccountName
  location: location
  sku: {
    name: 'Standard_LRS'
  }
  kind: 'StorageV2'
  tags: {
    Environment: 'rulebricks'
  }
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

// ----------------------------------------------------------------------------
// METRICS PATH (Prometheus remote write -> Azure Monitor managed Prometheus)
//
// createMonitorWorkspace = true provisions AMW + an explicit Data Collection
// Endpoint + Rule in THIS resource group, so the Monitoring Metrics Publisher
// role is scoped to a DCR we own and name. Role propagation takes ~30 min;
// expect HTTP 403 from remote write until then.
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

// ----------------------------------------------------------------------------
// EXTERNAL-DNS (optional): identity + DNS Zone Contributor + federated
// credential. This is the one namespace-coupled path in cluster-setup (the
// subject embeds the deployment namespace), hence the rulebricksNamespace
// parameter - only used when enableExternalDns is true.
// ----------------------------------------------------------------------------
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
    issuer: oidcIssuerUrl
    subject: 'system:serviceaccount:${rulebricksNamespace}:external-dns'
    audiences: [
      'api://AzureADTokenExchange'
    ]
  }
}

output rulebricksClientId string = rulebricksIdentity.properties.clientId
output storageAccountName string = effectiveStorageAccountName
output dataContainer string = enableBlobAccess ? dataContainerName : ''
output externalDnsClientId string = enableExternalDns ? externalDnsIdentity!.properties.clientId : ''
output dceMetricsIngestionEndpoint string = (enableMetricsRemoteWrite && createMonitorWorkspace) ? dce!.properties.metricsIngestion.endpoint : ''
output dcrImmutableId string = (enableMetricsRemoteWrite && createMonitorWorkspace) ? dcr!.properties.immutableId : ''
output dataCollectionRuleId string = (enableMetricsRemoteWrite && createMonitorWorkspace) ? dcr!.id : existingDataCollectionRuleId
