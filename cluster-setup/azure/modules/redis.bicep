// Azure Managed Redis uses TLS on port 10000. EnterpriseCluster preserves the
// single-endpoint client behavior expected by the chart.

param clusterName string
param location string
param tags object

@description('Azure Managed Redis cluster name.')
param redisName string

@description('Azure Managed Redis SKU.')
param skuName string = 'Balanced_B1'

@description('Use a private endpoint for cache access.')
param enablePrivateEndpoint bool

param privateEndpointsSubnetId string
param vnetId string

resource redis 'Microsoft.Cache/redisEnterprise@2025-04-01' = {
  name: redisName
  location: location
  tags: tags
  sku: {
    name: skuName
  }
  properties: {
    minimumTlsVersion: '1.2'
  }
}

resource redisDatabase 'Microsoft.Cache/redisEnterprise/databases@2025-04-01' = {
  parent: redis
  name: 'default'
  properties: {
    clientProtocol: 'Encrypted'
    port: 10000
    clusteringPolicy: 'EnterpriseCluster'
    evictionPolicy: 'NoEviction'
    persistence: {
      aofEnabled: false
      rdbEnabled: false
    }
  }
}

resource privateDnsZone 'Microsoft.Network/privateDnsZones@2024-06-01' = if (enablePrivateEndpoint) {
  name: 'privatelink.redis.azure.net'
  location: 'global'
  tags: tags
}

resource privateDnsZoneLink 'Microsoft.Network/privateDnsZones/virtualNetworkLinks@2024-06-01' = if (enablePrivateEndpoint) {
  parent: privateDnsZone
  name: '${clusterName}-redis'
  location: 'global'
  properties: {
    registrationEnabled: false
    virtualNetwork: {
      id: vnetId
    }
  }
}

resource privateEndpoint 'Microsoft.Network/privateEndpoints@2023-11-01' = if (enablePrivateEndpoint) {
  name: '${redisName}-pe'
  location: location
  tags: tags
  properties: {
    subnet: {
      id: privateEndpointsSubnetId
    }
    privateLinkServiceConnections: [
      {
        name: 'redis'
        properties: {
          privateLinkServiceId: redis.id
          groupIds: [
            'redisEnterprise'
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
        name: 'redis'
        properties: {
          privateDnsZoneId: privateDnsZone!.id
        }
      }
    ]
  }
}

output hostName string = redis.properties.hostName
output port int = redisDatabase.properties.port
output tlsEnabled bool = true
output accessKeyCommand string = 'az redisenterprise database list-keys --cluster-name ${redis.name} --resource-group ${resourceGroup().name} --query primaryKey -o tsv'
