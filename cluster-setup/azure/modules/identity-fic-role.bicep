targetScope = 'resourceGroup'

param identityName string
param principalIds array
param assignFederatedIdentityRole bool = false
param assignOperatorRole bool = false
param assignReaderRole bool = false

@allowed([
  'User'
  'Group'
  'ServicePrincipal'
])
param principalType string

var ficContributorRoleId = subscriptionResourceId(
  'Microsoft.Authorization/roleDefinitions',
  '7e559ce2-48d7-4b27-9128-fa1b247f1308'
)
var managedIdentityOperatorRoleId = subscriptionResourceId(
  'Microsoft.Authorization/roleDefinitions',
  'f1a07417-d97a-45cb-824c-7a7467783830'
)
var readerRoleId = subscriptionResourceId(
  'Microsoft.Authorization/roleDefinitions',
  'acdd72a7-3385-48ef-bd42-f606fba81ae7'
)

resource identity 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' existing = {
  name: identityName
}

resource ficContributor 'Microsoft.Authorization/roleAssignments@2022-04-01' = [
  for principalId in principalIds: if (assignFederatedIdentityRole) {
    name: guid(identity.id, principalId, 'rulebricks-fic-contributor')
    scope: identity
    properties: {
      roleDefinitionId: ficContributorRoleId
      principalId: principalId
      principalType: principalType
    }
  }
]

resource identityOperator 'Microsoft.Authorization/roleAssignments@2022-04-01' = [
  for principalId in principalIds: if (assignOperatorRole) {
    name: guid(identity.id, principalId, 'rulebricks-identity-operator')
    scope: identity
    properties: {
      roleDefinitionId: managedIdentityOperatorRoleId
      principalId: principalId
      principalType: principalType
    }
  }
]

resource identityReader 'Microsoft.Authorization/roleAssignments@2022-04-01' = [
  for principalId in principalIds: if (assignReaderRole) {
    name: guid(identity.id, principalId, 'rulebricks-identity-reader')
    scope: identity
    properties: {
      roleDefinitionId: readerRoleId
      principalId: principalId
      principalType: principalType
    }
  }
]
