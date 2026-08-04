param clusterName string
param location string
param tags object

@description('Create a new VNet. False creates the requested subnets inside existing vnetName without modifying the VNet address space.')
param createVnet bool = true

@description('VNet to create or reference in this module scope.')
param vnetName string = '${clusterName}-vnet'

param vnetAddressSpace string
param aksSubnetName string
param aksSubnetPrefix string
@description('Optional organization-owned NSG to attach when creating the AKS subnet in an existing VNet. A newly created VNet uses the module-managed NSG.')
param aksSubnetNetworkSecurityGroupId string = ''
param createPrivateEndpointsSubnet bool
param privateEndpointsSubnetName string
param privateEndpointsSubnetPrefix string
param createPostgresSubnet bool
param postgresSubnetName string
param postgresSubnetPrefix string

resource nsg 'Microsoft.Network/networkSecurityGroups@2023-11-01' = if (createVnet) {
  name: '${clusterName}-nsg'
  location: location
  tags: tags
  properties: {
    securityRules: [
      {
        name: 'AllowVNetInbound'
        properties: {
          priority: 100
          direction: 'Inbound'
          access: 'Allow'
          protocol: '*'
          sourcePortRange: '*'
          destinationPortRange: '*'
          sourceAddressPrefix: 'VirtualNetwork'
          destinationAddressPrefix: 'VirtualNetwork'
        }
      }
      {
        name: 'AllowVNetOutbound'
        properties: {
          priority: 100
          direction: 'Outbound'
          access: 'Allow'
          protocol: '*'
          sourcePortRange: '*'
          destinationPortRange: '*'
          sourceAddressPrefix: 'VirtualNetwork'
          destinationAddressPrefix: 'VirtualNetwork'
        }
      }
      {
        name: 'AllowHTTPInbound'
        properties: {
          priority: 110
          direction: 'Inbound'
          access: 'Allow'
          protocol: 'Tcp'
          sourcePortRange: '*'
          destinationPortRange: '80'
          sourceAddressPrefix: 'Internet'
          destinationAddressPrefix: '*'
        }
      }
      {
        name: 'AllowHTTPSInbound'
        properties: {
          priority: 120
          direction: 'Inbound'
          access: 'Allow'
          protocol: 'Tcp'
          sourcePortRange: '*'
          destinationPortRange: '443'
          sourceAddressPrefix: 'Internet'
          destinationAddressPrefix: '*'
        }
      }
    ]
  }
}

resource vnet 'Microsoft.Network/virtualNetworks@2023-11-01' = if (createVnet) {
  name: vnetName
  location: location
  tags: tags
  properties: {
    addressSpace: {
      addressPrefixes: [
        vnetAddressSpace
      ]
    }
  }
}

resource existingVnet 'Microsoft.Network/virtualNetworks@2023-11-01' existing = if (!createVnet) {
  name: vnetName
}

// Subnets are child resources instead of an inline VNet array. This keeps the
// creation model identical to the existing-VNet path and prevents future
// changes from replacing sibling subnets accidentally.
resource aksSubnet 'Microsoft.Network/virtualNetworks/subnets@2023-11-01' = if (createVnet) {
  parent: vnet
  name: aksSubnetName
  properties: {
    addressPrefix: aksSubnetPrefix
    networkSecurityGroup: {
      id: nsg!.id
    }
  }
}

resource aksSubnetInExistingVnet 'Microsoft.Network/virtualNetworks/subnets@2023-11-01' = if (!createVnet) {
  parent: existingVnet
  name: aksSubnetName
  properties: union(
    {
      addressPrefix: aksSubnetPrefix
    },
    empty(aksSubnetNetworkSecurityGroupId)
      ? {}
      : {
          networkSecurityGroup: {
            id: aksSubnetNetworkSecurityGroupId
          }
        }
  )
}

resource privateEndpointsSubnet 'Microsoft.Network/virtualNetworks/subnets@2023-11-01' = if (createVnet && createPrivateEndpointsSubnet) {
  parent: vnet
  name: privateEndpointsSubnetName
  properties: {
    addressPrefix: privateEndpointsSubnetPrefix
    privateEndpointNetworkPolicies: 'Disabled'
  }
  dependsOn: [
    aksSubnet
  ]
}

resource privateEndpointsSubnetInExistingVnet 'Microsoft.Network/virtualNetworks/subnets@2023-11-01' = if (!createVnet && createPrivateEndpointsSubnet) {
  parent: existingVnet
  name: privateEndpointsSubnetName
  properties: {
    addressPrefix: privateEndpointsSubnetPrefix
    privateEndpointNetworkPolicies: 'Disabled'
  }
  dependsOn: [
    aksSubnetInExistingVnet
  ]
}

resource postgresSubnet 'Microsoft.Network/virtualNetworks/subnets@2023-11-01' = if (createVnet && createPostgresSubnet) {
  parent: vnet
  name: postgresSubnetName
  properties: {
    addressPrefix: postgresSubnetPrefix
    delegations: [
      {
        name: 'postgres-flexible-server'
        properties: {
          serviceName: 'Microsoft.DBforPostgreSQL/flexibleServers'
        }
      }
    ]
  }
  dependsOn: [
    aksSubnet
    privateEndpointsSubnet
  ]
}

resource postgresSubnetInExistingVnet 'Microsoft.Network/virtualNetworks/subnets@2023-11-01' = if (!createVnet && createPostgresSubnet) {
  parent: existingVnet
  name: postgresSubnetName
  properties: {
    addressPrefix: postgresSubnetPrefix
    delegations: [
      {
        name: 'postgres-flexible-server'
        properties: {
          serviceName: 'Microsoft.DBforPostgreSQL/flexibleServers'
        }
      }
    ]
  }
  dependsOn: [
    aksSubnetInExistingVnet
    privateEndpointsSubnetInExistingVnet
  ]
}

output vnetId string = createVnet ? vnet!.id : existingVnet!.id
output vnetName string = vnetName
output aksSubnetId string = createVnet ? aksSubnet!.id : aksSubnetInExistingVnet!.id
output privateEndpointsSubnetId string = createPrivateEndpointsSubnet
  ? (createVnet ? privateEndpointsSubnet!.id : privateEndpointsSubnetInExistingVnet!.id)
  : ''
output postgresSubnetId string = createPostgresSubnet
  ? (createVnet ? postgresSubnet!.id : postgresSubnetInExistingVnet!.id)
  : ''
