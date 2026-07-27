targetScope = 'resourceGroup'

param dnsZoneName string
param tags object
param principalId string

var dnsZoneContributorRoleId = subscriptionResourceId(
  'Microsoft.Authorization/roleDefinitions',
  'befefa01-2a29-4197-83a8-272ff33ce314'
)

// Delegated-subdomain model: this zone hosts the Rulebricks subdomain (e.g.
// rb.corp.com). The operator hands the nameServers output to whoever controls
// the parent domain for a one-time NS delegation; from then on external-dns
// manages every record and Let's Encrypt HTTP-01 issues certificates with no
// further DNS involvement.
resource dnsZone 'Microsoft.Network/dnsZones@2018-05-01' = {
  name: dnsZoneName
  location: 'global'
  tags: tags
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

output nameServers array = dnsZone.properties.nameServers
