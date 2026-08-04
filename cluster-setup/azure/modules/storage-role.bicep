targetScope = 'resourceGroup'

param storageAccountName string
param principalId string
param identityId string
// False defers the grant to a platform owner using main.bicep principalIds.
param assignRoles bool = false

var storageBlobDataContributorRoleId = subscriptionResourceId(
  'Microsoft.Authorization/roleDefinitions',
  'ba92f5b4-2d11-453d-a403-e96b0029c9fe'
)

resource storageAccount 'Microsoft.Storage/storageAccounts@2023-05-01' existing = {
  name: storageAccountName
}

// Required before rulebricks deploy: Storage Blob Data Contributor for the
// data-access identity on this existing account.
resource blobRole 'Microsoft.Authorization/roleAssignments@2022-04-01' = if (assignRoles) {
  name: guid(storageAccount.id, identityId, 'Storage Blob Data Contributor')
  scope: storageAccount
  properties: {
    roleDefinitionId: storageBlobDataContributorRoleId
    principalId: principalId
    principalType: 'ServicePrincipal'
  }
}
