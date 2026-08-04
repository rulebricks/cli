targetScope = 'resourceGroup'

param registryName string
param kubeletIdentityObjectId string

@allowed([
  'AcrPull'
  'Container Registry Repository Reader'
])
param pullRoleName string

param assignRole bool = false
param importerPrincipalIds array = []
param importerPrincipalType string = 'User'
param assignImporterRole bool = false

var acrPullRoleId = subscriptionResourceId(
  'Microsoft.Authorization/roleDefinitions',
  '7f951dda-4ed3-4680-a7ca-43fe172d538d'
)
var repositoryReaderRoleId = subscriptionResourceId(
  'Microsoft.Authorization/roleDefinitions',
  'b93aa761-3e63-49ed-ac28-beffa264f7ac'
)
var importerRoleId = subscriptionResourceId(
  'Microsoft.Authorization/roleDefinitions',
  '577a9874-89fd-4f24-9dbd-b5034d0ad23a'
)

resource registry 'Microsoft.ContainerRegistry/registries@2025-11-01' existing = {
  name: registryName
}

resource pullRole 'Microsoft.Authorization/roleAssignments@2022-04-01' = if (assignRole) {
  name: guid(registry.id, kubeletIdentityObjectId, pullRoleName)
  scope: registry
  properties: {
    roleDefinitionId: pullRoleName == 'Container Registry Repository Reader'
      ? repositoryReaderRoleId
      : acrPullRoleId
    principalId: kubeletIdentityObjectId
    principalType: 'ServicePrincipal'
  }
}

resource importerRoles 'Microsoft.Authorization/roleAssignments@2022-04-01' = [
  for principalId in importerPrincipalIds: if (assignImporterRole) {
    name: guid(registry.id, principalId, 'Container Registry Data Importer and Data Reader')
    scope: registry
    properties: {
      roleDefinitionId: importerRoleId
      principalId: principalId
      principalType: importerPrincipalType
    }
  }
]

output registryId string = registry.id
output registryName string = registry.name
output loginServer string = registry.properties.loginServer
