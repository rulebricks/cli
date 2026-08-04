param location string
param tags object

@description('Globally unique registry name.')
param registryName string

@description('ACR SKU.')
@allowed(['Basic', 'Standard', 'Premium'])
param skuName string = 'Standard'

@description('Object ID of the AKS kubelet identity.')
param kubeletIdentityObjectId string

// False defers AcrPull to a platform owner using main.bicep principalIds.
param assignRoles bool = false
param importerPrincipalIds array = []
param importerPrincipalType string = 'User'
param assignImporterRole bool = false

@description('Use a private endpoint for registry access.')
param enablePrivateEndpoint bool

param privateEndpointsSubnetId string
@description('Attach the endpoint to an organization-owned private DNS zone. False leaves registration to Azure Policy.')
param createPrivateDnsZoneGroup bool = false
param privateDnsZoneId string = ''

var acrPullRoleId = subscriptionResourceId(
  'Microsoft.Authorization/roleDefinitions',
  '7f951dda-4ed3-4680-a7ca-43fe172d538d'
)
var importerRoleId = subscriptionResourceId(
  'Microsoft.Authorization/roleDefinitions',
  '577a9874-89fd-4f24-9dbd-b5034d0ad23a'
)
resource registry 'Microsoft.ContainerRegistry/registries@2025-11-01' = {
  name: registryName
  location: location
  tags: tags
  sku: {
    name: skuName
  }
  properties: {
    adminUserEnabled: false
    publicNetworkAccess: enablePrivateEndpoint ? 'Disabled' : 'Enabled'
    networkRuleBypassOptions: 'AzureServices'
    // Keep template-created registries deterministic: AcrPull remains valid
    // for the kubelet. Organization-owned ABAC registries are still supported
    // by assigning Container Registry Repository Reader out of band.
    roleAssignmentMode: 'LegacyRegistryPermissions'
  }
}

// Required before rulebricks deploy: AcrPull for the AKS kubelet identity on
// this registry. The CLI mirrors images and the helm chart into this plain
// registry.
resource acrPullRole 'Microsoft.Authorization/roleAssignments@2022-04-01' = if (assignRoles) {
  name: guid(registry.id, kubeletIdentityObjectId, 'AcrPull')
  scope: registry
  properties: {
    roleDefinitionId: acrPullRoleId
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

resource privateEndpoint 'Microsoft.Network/privateEndpoints@2023-11-01' = if (enablePrivateEndpoint) {
  name: '${registryName}-pe'
  location: location
  tags: tags
  properties: {
    subnet: {
      id: privateEndpointsSubnetId
    }
    privateLinkServiceConnections: [
      {
        name: 'registry'
        properties: {
          privateLinkServiceId: registry.id
          groupIds: [
            'registry'
          ]
        }
      }
    ]
  }
}

resource privateEndpointDns 'Microsoft.Network/privateEndpoints/privateDnsZoneGroups@2023-11-01' = if (enablePrivateEndpoint && createPrivateDnsZoneGroup) {
  parent: privateEndpoint
  name: 'default'
  properties: {
    privateDnsZoneConfigs: [
      {
        name: 'registry'
        properties: {
          privateDnsZoneId: privateDnsZoneId
        }
      }
    ]
  }
}

output registryName string = registry.name
output registryId string = registry.id
output loginServer string = registry.properties.loginServer
