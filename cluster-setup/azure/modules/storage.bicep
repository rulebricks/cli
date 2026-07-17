param clusterName string
param location string
param tags object

param createStorage bool
param existingStorageAccountName string
param dataContainerName string
param enableDecisionLogExport bool
param enableBackupExport bool

param storageSkuName string
param allowSharedKeyAccess bool
param enableBlobVersioning bool
param blobSoftDeleteDays int
param enablePrivateEndpoint bool
param privateEndpointsSubnetId string
param vnetId string
param enableDeleteLock bool

param rulebricksPrincipalId string
param rulebricksIdentityId string

var storageBlobDataContributorRoleId = subscriptionResourceId(
  'Microsoft.Authorization/roleDefinitions',
  'ba92f5b4-2d11-453d-a403-e96b0029c9fe'
)
var generatedStorageAccountName = take('rb${uniqueString(resourceGroup().id, clusterName)}', 24)
var effectiveStorageAccountName = createStorage ? generatedStorageAccountName : existingStorageAccountName
var enableBlobAccess = enableDecisionLogExport || enableBackupExport

resource storageAccount 'Microsoft.Storage/storageAccounts@2023-05-01' = if (createStorage) {
  name: generatedStorageAccountName
  location: location
  sku: {
    name: storageSkuName
  }
  kind: 'StorageV2'
  tags: tags
  properties: {
    accessTier: 'Hot'
    allowBlobPublicAccess: false
    allowSharedKeyAccess: allowSharedKeyAccess
    defaultToOAuthAuthentication: !allowSharedKeyAccess
    minimumTlsVersion: 'TLS1_2'
    publicNetworkAccess: enablePrivateEndpoint ? 'Disabled' : 'Enabled'
    supportsHttpsTrafficOnly: true
  }
}

resource blobService 'Microsoft.Storage/storageAccounts/blobServices@2023-05-01' = if (createStorage) {
  parent: storageAccount
  name: 'default'
  properties: {
    containerDeleteRetentionPolicy: {
      enabled: blobSoftDeleteDays > 0
      days: blobSoftDeleteDays
    }
    deleteRetentionPolicy: {
      enabled: blobSoftDeleteDays > 0
      days: blobSoftDeleteDays
    }
    isVersioningEnabled: enableBlobVersioning
  }
}

resource dataContainer 'Microsoft.Storage/storageAccounts/blobServices/containers@2023-05-01' = if (createStorage && enableBlobAccess) {
  parent: blobService
  name: dataContainerName
  properties: {
    publicAccess: 'None'
  }
}

resource blobRoleCreated 'Microsoft.Authorization/roleAssignments@2022-04-01' = if (enableBlobAccess && createStorage) {
  name: guid(storageAccount.id, rulebricksIdentityId, 'Storage Blob Data Contributor')
  scope: storageAccount
  properties: {
    roleDefinitionId: storageBlobDataContributorRoleId
    principalId: rulebricksPrincipalId
    principalType: 'ServicePrincipal'
  }
}

resource privateDnsZone 'Microsoft.Network/privateDnsZones@2024-06-01' = if (createStorage && enablePrivateEndpoint) {
  name: 'privatelink.blob.${environment().suffixes.storage}'
  location: 'global'
  tags: tags
}

resource privateDnsZoneLink 'Microsoft.Network/privateDnsZones/virtualNetworkLinks@2024-06-01' = if (createStorage && enablePrivateEndpoint) {
  parent: privateDnsZone
  name: '${clusterName}-storage'
  location: 'global'
  properties: {
    registrationEnabled: false
    virtualNetwork: {
      id: vnetId
    }
  }
}

resource privateEndpoint 'Microsoft.Network/privateEndpoints@2023-11-01' = if (createStorage && enablePrivateEndpoint) {
  name: '${generatedStorageAccountName}-blob-pe'
  location: location
  tags: tags
  properties: {
    subnet: {
      id: privateEndpointsSubnetId
    }
    privateLinkServiceConnections: [
      {
        name: 'blob'
        properties: {
          privateLinkServiceId: storageAccount.id
          groupIds: [
            'blob'
          ]
        }
      }
    ]
  }
}

resource privateEndpointDns 'Microsoft.Network/privateEndpoints/privateDnsZoneGroups@2023-11-01' = if (createStorage && enablePrivateEndpoint) {
  parent: privateEndpoint
  name: 'default'
  properties: {
    privateDnsZoneConfigs: [
      {
        name: 'blob'
        properties: {
          privateDnsZoneId: privateDnsZone!.id
        }
      }
    ]
  }
}

resource storageDeleteLock 'Microsoft.Authorization/locks@2020-05-01' = if (createStorage && enableDeleteLock) {
  name: 'protect-rulebricks-data'
  scope: storageAccount
  properties: {
    level: 'CanNotDelete'
    notes: 'Remove this lock before intentionally deleting the environment.'
  }
}

output storageAccountName string = effectiveStorageAccountName
output dataContainer string = enableBlobAccess ? dataContainerName : ''
