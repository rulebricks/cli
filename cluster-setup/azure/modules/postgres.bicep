// PostgreSQL is VNet-only. Supabase Realtime requires wal_level=logical, which
// takes effect after the one-time restart returned by this module.

param clusterName string
param location string
param tags object

@description('Globally unique PostgreSQL server name.')
param serverName string

@description('PostgreSQL major version.')
param postgresVersion string = '17'

@description('Administrator login used for initial application bootstrap.')
param administratorLogin string = 'rbadmin'

@secure()
@description('Administrator password. Supply this securely at deployment time.')
param administratorPassword string

@description('PostgreSQL compute SKU.')
param skuName string = 'Standard_D4ds_v5'

@description('SKU tier matching skuName.')
@allowed(['Burstable', 'GeneralPurpose', 'MemoryOptimized'])
param skuTier string = 'GeneralPurpose'

@description('Storage capacity in GB. Auto-grow is enabled.')
param storageSizeGB int = 128

@description('Enable zone-redundant high availability.')
param enableHighAvailability bool = false

@description('Backup retention in days.')
@minValue(7)
@maxValue(35)
param backupRetentionDays int = 7

@description('Delegated subnet for PostgreSQL Flexible Server.')
param postgresSubnetId string

param vnetId string

resource privateDnsZone 'Microsoft.Network/privateDnsZones@2024-06-01' = {
  name: '${serverName}.private.postgres.database.azure.com'
  location: 'global'
  tags: tags
}

resource privateDnsZoneLink 'Microsoft.Network/privateDnsZones/virtualNetworkLinks@2024-06-01' = {
  parent: privateDnsZone
  name: '${clusterName}-postgres'
  location: 'global'
  properties: {
    registrationEnabled: false
    virtualNetwork: {
      id: vnetId
    }
  }
}

resource server 'Microsoft.DBforPostgreSQL/flexibleServers@2024-08-01' = {
  name: serverName
  location: location
  tags: tags
  sku: {
    name: skuName
    tier: skuTier
  }
  properties: {
    version: postgresVersion
    administratorLogin: administratorLogin
    administratorLoginPassword: administratorPassword
    storage: {
      storageSizeGB: storageSizeGB
      autoGrow: 'Enabled'
    }
    network: {
      delegatedSubnetResourceId: postgresSubnetId
      privateDnsZoneArmResourceId: privateDnsZone.id
    }
    highAvailability: {
      mode: enableHighAvailability ? 'ZoneRedundant' : 'Disabled'
    }
    backup: {
      backupRetentionDays: backupRetentionDays
      geoRedundantBackup: 'Disabled'
    }
  }
  dependsOn: [
    privateDnsZoneLink
  ]
}

resource walLevel 'Microsoft.DBforPostgreSQL/flexibleServers/configurations@2024-08-01' = {
  parent: server
  name: 'wal_level'
  properties: {
    value: 'logical'
    source: 'user-override'
  }
}

resource maxReplicationSlots 'Microsoft.DBforPostgreSQL/flexibleServers/configurations@2024-08-01' = {
  parent: server
  name: 'max_replication_slots'
  properties: {
    value: '10'
    source: 'user-override'
  }
  dependsOn: [
    walLevel
  ]
}

resource maxWalSenders 'Microsoft.DBforPostgreSQL/flexibleServers/configurations@2024-08-01' = {
  parent: server
  name: 'max_wal_senders'
  properties: {
    value: '10'
    source: 'user-override'
  }
  dependsOn: [
    maxReplicationSlots
  ]
}

output fqdn string = server.properties.fullyQualifiedDomainName
output port int = 5432
output databaseName string = 'postgres'
output administratorLogin string = administratorLogin
output restartCommand string = 'az postgres flexible-server restart --resource-group ${resourceGroup().name} --name ${server.name}'
