targetScope = 'resourceGroup'

param privateDnsZoneName string
param principalId string
param identityId string

var privateDnsZoneContributorRoleId = subscriptionResourceId(
  'Microsoft.Authorization/roleDefinitions',
  'b12aa53e-6015-4669-85d0-8515ebb3ae7f'
)

resource privateDnsZone 'Microsoft.Network/privateDnsZones@2024-06-01' existing = {
  name: privateDnsZoneName
}

resource aksPrivateDnsRole 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(privateDnsZone.id, identityId, 'Private DNS Zone Contributor')
  scope: privateDnsZone
  properties: {
    roleDefinitionId: privateDnsZoneContributorRoleId
    principalId: principalId
    principalType: 'ServicePrincipal'
  }
}
