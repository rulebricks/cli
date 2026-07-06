// Network: one VNet with purpose-built subnets.
//
//   aks-subnet               nodes + internal load balancers (CNI Overlay:
//                            pods draw from podCidr, not from this subnet,
//                            so a /22 comfortably holds the node fleet)
//   private-endpoints-subnet private endpoints for Event Hubs / Managed Redis
//   postgres-subnet          delegated to PostgreSQL Flexible Server
//
// The address space is parameterized (default 10.240.0.0/16) so enterprises
// can slot it into existing IPAM without conflicts - unlike a 10/8 grab.

param clusterName string
param location string
param vnetAddressSpace string
param aksSubnetPrefix string
param privateEndpointsSubnetPrefix string
param postgresSubnetPrefix string

resource nsg 'Microsoft.Network/networkSecurityGroups@2023-11-01' = {
  name: '${clusterName}-nsg'
  location: location
  tags: {
    Environment: 'rulebricks'
  }
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
        // Traefik's LoadBalancer service; 80 exists for ACME HTTP-01 +
        // redirect-to-HTTPS. Tighten sourceAddressPrefix to a corporate CIDR
        // for internal-only deployments.
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

resource vnet 'Microsoft.Network/virtualNetworks@2023-11-01' = {
  name: '${clusterName}-vnet'
  location: location
  tags: {
    Environment: 'rulebricks'
  }
  properties: {
    addressSpace: {
      addressPrefixes: [
        vnetAddressSpace
      ]
    }
    // Subnets are declared inline (not as child resources) so repeat
    // deployments never try to delete/recreate them.
    subnets: [
      {
        name: 'aks-subnet'
        properties: {
          addressPrefix: aksSubnetPrefix
          networkSecurityGroup: {
            id: nsg.id
          }
        }
      }
      {
        name: 'private-endpoints-subnet'
        properties: {
          addressPrefix: privateEndpointsSubnetPrefix
        }
      }
      {
        name: 'postgres-subnet'
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
      }
    ]
  }
}

output vnetId string = vnet.id
output vnetName string = vnet.name
output aksSubnetId string = vnet.properties.subnets[0].id
output privateEndpointsSubnetId string = vnet.properties.subnets[1].id
output postgresSubnetId string = vnet.properties.subnets[2].id
