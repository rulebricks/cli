// Managed Redis: Azure Managed Redis (Microsoft.Cache/redisEnterprise).
//
// Azure Cache for Redis (Microsoft.Cache/redis) is retiring; Azure Managed
// Redis is its replacement and what new deployments should use. Differences
// that matter to Rulebricks:
//   - TLS-only client protocol on port 10000 (not 6380/6379)
//   - access-key auth (chart external-redis password field)
//   - "Enterprise" clustering policy keeps the single-endpoint, standard
//     Redis client behavior the chart expects (no CLUSTER-aware client needed)
//   - eviction stays NoEviction to match the in-cluster Valkey defaults
//
// CLI mapping: redis mode "external", host = hostName output, port = 10000,
// TLS = true, password = access key (command output below).

param clusterName string
param location string

@description('Azure Managed Redis cluster name (unique within the region; becomes the hostname).')
param redisName string

@description('Azure Managed Redis SKU: Balanced_B0/B1/B3/B5/B10..., MemoryOptimized_M10..., ComputeOptimized_X3... Balanced_B1 (1 GB) matches the in-cluster Valkey footprint.')
param skuName string = 'Balanced_B1'

@description('Reach the cache through a private endpoint.')
param enablePrivateEndpoint bool

param privateEndpointsSubnetId string
param vnetId string

resource redis 'Microsoft.Cache/redisEnterprise@2025-04-01' = {
  name: redisName
  location: location
  tags: {
    Environment: 'rulebricks'
  }
  sku: {
    name: skuName
  }
  properties: {
    minimumTlsVersion: '1.2'
  }
}

resource redisDatabase 'Microsoft.Cache/redisEnterprise/databases@2025-04-01' = {
  parent: redis
  name: 'default' // AMR requires exactly one database named "default"
  properties: {
    clientProtocol: 'Encrypted' // TLS-only
    port: 10000
    clusteringPolicy: 'EnterpriseCluster' // single endpoint, standard clients
    evictionPolicy: 'NoEviction' // match in-cluster Valkey defaults
    persistence: {
      aofEnabled: false
      rdbEnabled: false
    }
  }
}

// ----------------------------------------------------------------------------
// Optional private endpoint + DNS
// ----------------------------------------------------------------------------
resource privateDnsZone 'Microsoft.Network/privateDnsZones@2024-06-01' = if (enablePrivateEndpoint) {
  name: 'privatelink.redis.azure.net'
  location: 'global'
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
// The access key is a secret; fetch it out-of-band with this command (paste
// the value into the CLI wizard's Redis password field):
output accessKeyCommand string = 'az redisenterprise database list-keys --cluster-name ${redis.name} --resource-group ${resourceGroup().name} --query primaryKey -o tsv'
