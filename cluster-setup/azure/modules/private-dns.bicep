targetScope = 'resourceGroup'

param clusterName string
param tags object

@description('VNet whose workloads resolve these zones. Creating links requires Microsoft.Network/virtualNetworks/join/action on this VNet.')
param vnetId string

@description('Private DNS namespaces to create. Supported values: blob, keyVault, acr, eventHubs, redis, postgres. Empty creates nothing.')
param createZonesFor array = []

var createBlobZone = contains(createZonesFor, 'blob')
var createKeyVaultZone = contains(createZonesFor, 'keyVault')
var createAcrZone = contains(createZonesFor, 'acr')
var createEventHubsZone = contains(createZonesFor, 'eventHubs')
var createRedisZone = contains(createZonesFor, 'redis')
var createPostgresZone = contains(createZonesFor, 'postgres')

resource blobZone 'Microsoft.Network/privateDnsZones@2024-06-01' = if (createBlobZone) {
  name: 'privatelink.blob.${environment().suffixes.storage}'
  location: 'global'
  tags: tags
}

resource blobLink 'Microsoft.Network/privateDnsZones/virtualNetworkLinks@2024-06-01' = if (createBlobZone) {
  parent: blobZone
  name: '${clusterName}-blob'
  location: 'global'
  properties: {
    registrationEnabled: false
    virtualNetwork: {
      id: vnetId
    }
  }
}

resource keyVaultZone 'Microsoft.Network/privateDnsZones@2024-06-01' = if (createKeyVaultZone) {
  name: 'privatelink.vaultcore.azure.net'
  location: 'global'
  tags: tags
}

resource keyVaultLink 'Microsoft.Network/privateDnsZones/virtualNetworkLinks@2024-06-01' = if (createKeyVaultZone) {
  parent: keyVaultZone
  name: '${clusterName}-key-vault'
  location: 'global'
  properties: {
    registrationEnabled: false
    virtualNetwork: {
      id: vnetId
    }
  }
}

resource acrZone 'Microsoft.Network/privateDnsZones@2024-06-01' = if (createAcrZone) {
  name: 'privatelink.azurecr.io'
  location: 'global'
  tags: tags
}

resource acrLink 'Microsoft.Network/privateDnsZones/virtualNetworkLinks@2024-06-01' = if (createAcrZone) {
  parent: acrZone
  name: '${clusterName}-acr'
  location: 'global'
  properties: {
    registrationEnabled: false
    virtualNetwork: {
      id: vnetId
    }
  }
}

resource eventHubsZone 'Microsoft.Network/privateDnsZones@2024-06-01' = if (createEventHubsZone) {
  name: 'privatelink.servicebus.windows.net'
  location: 'global'
  tags: tags
}

resource eventHubsLink 'Microsoft.Network/privateDnsZones/virtualNetworkLinks@2024-06-01' = if (createEventHubsZone) {
  parent: eventHubsZone
  name: '${clusterName}-event-hubs'
  location: 'global'
  properties: {
    registrationEnabled: false
    virtualNetwork: {
      id: vnetId
    }
  }
}

resource redisZone 'Microsoft.Network/privateDnsZones@2024-06-01' = if (createRedisZone) {
  name: 'privatelink.redis.azure.net'
  location: 'global'
  tags: tags
}

resource redisLink 'Microsoft.Network/privateDnsZones/virtualNetworkLinks@2024-06-01' = if (createRedisZone) {
  parent: redisZone
  name: '${clusterName}-redis'
  location: 'global'
  properties: {
    registrationEnabled: false
    virtualNetwork: {
      id: vnetId
    }
  }
}

// Flexible Server uses VNet injection rather than a private endpoint. One
// shared zone ending in postgres.database.azure.com can hold every server.
resource postgresZone 'Microsoft.Network/privateDnsZones@2024-06-01' = if (createPostgresZone) {
  name: 'private.postgres.database.azure.com'
  location: 'global'
  tags: tags
}

resource postgresLink 'Microsoft.Network/privateDnsZones/virtualNetworkLinks@2024-06-01' = if (createPostgresZone) {
  parent: postgresZone
  name: '${clusterName}-postgres'
  location: 'global'
  properties: {
    registrationEnabled: false
    virtualNetwork: {
      id: vnetId
    }
  }
}

output zoneIds object = {
  blob: createBlobZone ? blobZone!.id : ''
  keyVault: createKeyVaultZone ? keyVaultZone!.id : ''
  acr: createAcrZone ? acrZone!.id : ''
  eventHubs: createEventHubsZone ? eventHubsZone!.id : ''
  redis: createRedisZone ? redisZone!.id : ''
  postgres: createPostgresZone ? postgresZone!.id : ''
}
