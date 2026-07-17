targetScope = 'resourceGroup'

param dnsZoneName string
param principalId string

var dnsZoneContributorRoleId = subscriptionResourceId(
  'Microsoft.Authorization/roleDefinitions',
  'befefa01-2a29-4197-83a8-272ff33ce314'
)

resource dnsZone 'Microsoft.Network/dnsZones@2018-05-01' existing = {
  name: dnsZoneName
}

resource externalDnsRole 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(dnsZone.id, principalId, 'DNS Zone Contributor')
  scope: dnsZone
  properties: {
    roleDefinitionId: dnsZoneContributorRoleId
    principalId: principalId
    principalType: 'ServicePrincipal'
  }
}
