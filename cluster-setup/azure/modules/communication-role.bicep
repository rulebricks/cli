targetScope = 'resourceGroup'

param communicationServiceName string
param readerPrincipalIds array

@allowed([
  'User'
  'Group'
  'ServicePrincipal'
])
param readerPrincipalType string

var readerRoleId = subscriptionResourceId(
  'Microsoft.Authorization/roleDefinitions',
  'acdd72a7-3385-48ef-bd42-f606fba81ae7'
)

resource communicationService 'Microsoft.Communication/communicationServices@2023-04-01' existing = {
  name: communicationServiceName
}

resource communicationServiceReader 'Microsoft.Authorization/roleAssignments@2022-04-01' = [
  for principalId in readerPrincipalIds: {
    name: guid(communicationService.id, principalId, 'rulebricks-communication-reader')
    scope: communicationService
    properties: {
      roleDefinitionId: readerRoleId
      principalId: principalId
      principalType: readerPrincipalType
    }
  }
]
