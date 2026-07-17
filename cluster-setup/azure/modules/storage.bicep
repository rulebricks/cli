// Object storage: the Azure Blob storage account behind every Rulebricks data
// export.
//
// All data lives in ONE container (<cluster>-data by convention) under
// per-purpose prefixes:
//
//   decision-logs/   Vector's decision-log archive (queried back through the
//                    ClickHouse blob-archive path)
//   db-backups/      scheduled database backup exports
//
// The <cluster>-rulebricks workload identity (identity.bicep) gets Storage
// Blob Data Contributor on the account - pods authenticate via AKS Workload
// Identity, so no account keys or connection strings are involved.
//
// createStorage=false is the BYO path: no account is created, and the role is
// assigned on existingStorageAccountName instead.

param clusterName string
param location string

param createStorage bool
param existingStorageAccountName string
param dataContainerName string
param enableDecisionLogExport bool
param enableBackupExport bool

@description('Principal ID of the <cluster>-rulebricks workload identity (grantee of the blob role).')
param rulebricksPrincipalId string

@description('Resource ID of the <cluster>-rulebricks workload identity (role-assignment guid() seed).')
param rulebricksIdentityId string

var storageBlobDataContributorRoleId = subscriptionResourceId('Microsoft.Authorization/roleDefinitions', 'ba92f5b4-2d11-453d-a403-e96b0029c9fe')

// Deterministic, globally-unique storage account name (3-24 chars, lowercase alphanumeric).
var generatedStorageAccountName = take('rb${uniqueString(resourceGroup().id, clusterName)}', 24)
var effectiveStorageAccountName = createStorage ? generatedStorageAccountName : existingStorageAccountName
var enableBlobAccess = enableDecisionLogExport || enableBackupExport

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
  name: guid(storageAccount.id, rulebricksIdentityId, 'Storage Blob Data Contributor')
  scope: storageAccount
  properties: {
    roleDefinitionId: storageBlobDataContributorRoleId
    principalId: rulebricksPrincipalId
    principalType: 'ServicePrincipal'
  }
}

resource blobRoleByo 'Microsoft.Authorization/roleAssignments@2022-04-01' = if (enableBlobAccess && !createStorage && !empty(effectiveStorageAccountName)) {
  name: guid(existingStorageAccount.id, rulebricksIdentityId, 'Storage Blob Data Contributor')
  scope: existingStorageAccount
  properties: {
    roleDefinitionId: storageBlobDataContributorRoleId
    principalId: rulebricksPrincipalId
    principalType: 'ServicePrincipal'
  }
}

output storageAccountName string = effectiveStorageAccountName
output dataContainer string = enableBlobAccess ? dataContainerName : ''
