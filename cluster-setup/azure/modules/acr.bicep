param clusterName string
param location string
param tags object

@description('Globally unique registry name.')
param registryName string

@description('ACR SKU.')
@allowed(['Basic', 'Standard', 'Premium'])
param skuName string = 'Premium'

@description('Object ID of the AKS kubelet identity.')
param kubeletIdentityObjectId string

@description('Use a private endpoint for registry access.')
param enablePrivateEndpoint bool
param allowPublicNetworkAccess bool

param privateEndpointsSubnetId string
param vnetId string

var acrPullRoleId = subscriptionResourceId(
  'Microsoft.Authorization/roleDefinitions',
  '7f951dda-4ed3-4680-a7ca-43fe172d538d'
)

resource registry 'Microsoft.ContainerRegistry/registries@2023-07-01' = {
  name: registryName
  location: location
  tags: tags
  sku: {
    name: skuName
  }
  properties: {
    adminUserEnabled: false
    publicNetworkAccess: allowPublicNetworkAccess ? 'Enabled' : 'Disabled'
    networkRuleBypassOptions: 'AzureServices'
  }
}

resource acrPullRole 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(registry.id, kubeletIdentityObjectId, 'AcrPull')
  scope: registry
  properties: {
    roleDefinitionId: acrPullRoleId
    principalId: kubeletIdentityObjectId
    principalType: 'ServicePrincipal'
  }
}

resource privateDnsZone 'Microsoft.Network/privateDnsZones@2024-06-01' = if (enablePrivateEndpoint) {
  name: 'privatelink.azurecr.io'
  location: 'global'
  tags: tags
}

resource privateDnsZoneLink 'Microsoft.Network/privateDnsZones/virtualNetworkLinks@2024-06-01' = if (enablePrivateEndpoint) {
  parent: privateDnsZone
  name: '${clusterName}-acr'
  location: 'global'
  properties: {
    registrationEnabled: false
    virtualNetwork: {
      id: vnetId
    }
  }
}

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

resource privateEndpointDns 'Microsoft.Network/privateEndpoints/privateDnsZoneGroups@2023-11-01' = if (enablePrivateEndpoint) {
  parent: privateEndpoint
  name: 'default'
  properties: {
    privateDnsZoneConfigs: [
      {
        name: 'registry'
        properties: {
          privateDnsZoneId: privateDnsZone!.id
        }
      }
    ]
  }
}

output registryName string = registry.name
output loginServer string = registry.properties.loginServer
