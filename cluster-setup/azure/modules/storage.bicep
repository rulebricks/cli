@description('Name for a created account; must be unique across Azure (main.bicep passes its storageAccountName param).')
param storageAccountName string
param location string
param tags object

param createStorage bool
param existingStorageAccountName string
param dataContainerName string

param storageSkuName string
param allowSharedKeyAccess bool
param enableBlobVersioning bool
param blobSoftDeleteDays int
param enablePrivateEndpoint bool
param privateEndpointsSubnetId string
@description('Attach the endpoint to an organization-owned private DNS zone. False leaves registration to Azure Policy.')
param createPrivateDnsZoneGroup bool = false
param privateDnsZoneId string = ''
param enableDeleteLock bool

param rulebricksPrincipalId string
param rulebricksIdentityId string
// False defers the grant to a platform owner using main.bicep principalIds.
param assignRoles bool = false

var storageBlobDataContributorRoleId = subscriptionResourceId(
  'Microsoft.Authorization/roleDefinitions',
  'ba92f5b4-2d11-453d-a403-e96b0029c9fe'
)
var effectiveStorageAccountName = createStorage ? storageAccountName : existingStorageAccountName

// Blob access is unconditional: decision-log export is required by ClickHouse
// and the in-app log UI, and database backups share the same container (as the
// db-backups/ prefix) whenever the database is in-cluster. There is no
// supported deployment without it.

resource storageAccount 'Microsoft.Storage/storageAccounts@2023-05-01' = if (createStorage) {
  name: storageAccountName
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
      days: blobSoftDeleteDays > 0 ? blobSoftDeleteDays : null
    }
    deleteRetentionPolicy: {
      enabled: blobSoftDeleteDays > 0
      days: blobSoftDeleteDays > 0 ? blobSoftDeleteDays : null
    }
    isVersioningEnabled: enableBlobVersioning
  }
}

resource dataContainer 'Microsoft.Storage/storageAccounts/blobServices/containers@2023-05-01' = if (createStorage) {
  parent: blobService
  name: dataContainerName
  properties: {
    publicAccess: 'None'
  }
}

// Required before rulebricks deploy: Storage Blob Data Contributor for the
// data-access identity on the created account.
resource blobRoleCreated 'Microsoft.Authorization/roleAssignments@2022-04-01' = if (createStorage && assignRoles) {
  name: guid(storageAccount.id, rulebricksIdentityId, 'Storage Blob Data Contributor')
  scope: storageAccount
  properties: {
    roleDefinitionId: storageBlobDataContributorRoleId
    principalId: rulebricksPrincipalId
    principalType: 'ServicePrincipal'
  }
}

resource privateEndpoint 'Microsoft.Network/privateEndpoints@2023-11-01' = if (createStorage && enablePrivateEndpoint) {
  name: '${storageAccountName}-blob-pe'
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

resource privateEndpointDns 'Microsoft.Network/privateEndpoints/privateDnsZoneGroups@2023-11-01' = if (createStorage && enablePrivateEndpoint && createPrivateDnsZoneGroup) {
  parent: privateEndpoint
  name: 'default'
  properties: {
    privateDnsZoneConfigs: [
      {
        name: 'blob'
        properties: {
          privateDnsZoneId: privateDnsZoneId
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
output storageAccountId string = createStorage ? storageAccount!.id : ''
output dataContainer string = dataContainerName
