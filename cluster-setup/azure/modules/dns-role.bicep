targetScope = 'resourceGroup'

param dnsZoneName string
param principalId string
param assignContributorRole bool = false
param readerPrincipalIds array = []
param assignReaderRole bool = false

@allowed([
  'User'
  'Group'
  'ServicePrincipal'
])
param readerPrincipalType string = 'User'

var dnsZoneContributorRoleId = subscriptionResourceId(
  'Microsoft.Authorization/roleDefinitions',
  'befefa01-2a29-4197-83a8-272ff33ce314'
)
var readerRoleId = subscriptionResourceId(
  'Microsoft.Authorization/roleDefinitions',
  'acdd72a7-3385-48ef-bd42-f606fba81ae7'
)

resource dnsZone 'Microsoft.Network/dnsZones@2018-05-01' existing = {
  name: dnsZoneName
}

resource externalDnsRole 'Microsoft.Authorization/roleAssignments@2022-04-01' = if (assignContributorRole) {
  name: guid(dnsZone.id, principalId, 'DNS Zone Contributor')
  scope: dnsZone
  properties: {
    roleDefinitionId: dnsZoneContributorRoleId
    principalId: principalId
    principalType: 'ServicePrincipal'
  }
}

resource dnsZoneReader 'Microsoft.Authorization/roleAssignments@2022-04-01' = [
  for readerPrincipalId in readerPrincipalIds: if (assignReaderRole) {
    name: guid(dnsZone.id, readerPrincipalId, 'rulebricks-dns-zone-reader')
    scope: dnsZone
    properties: {
      roleDefinitionId: readerRoleId
      principalId: readerPrincipalId
      principalType: readerPrincipalType
    }
  }
]
