// Managed database: Azure Database for PostgreSQL Flexible Server.
//
// VNet-integrated (delegated subnet + private DNS zone): the server has no
// public endpoint, and only workloads inside the VNet resolve/reach it.
//
// Supabase Realtime requires LOGICAL REPLICATION, so this module sets
// wal_level=logical (plus slot/sender headroom). wal_level is static: the
// server must restart once after deployment for it to take effect -
//   az postgres flexible-server restart -g <rg> -n <server>
// The Rulebricks CLI preflights wal_level and tells you if it is off.
//
// CLI mapping: database "self-hosted" + postgres mode "external";
// host = fqdn output, port 5432, database "postgres", bootstrap master
// username/password = administratorLogin / the @secure password you passed.

param clusterName string
param location string

@description('Globally-unique server name (becomes <name>.postgres.database.azure.com).')
param serverName string

@description('PostgreSQL major version.')
param postgresVersion string = '17'

@description('Admin login. Not "azure_superuser", "admin", "administrator", "root", "guest", "public", or pg_-prefixed; Rulebricks uses it once for bootstrap (roles + schemas), after which the app uses its own roles.')
param administratorLogin string = 'rbadmin'

@secure()
@description('Admin password (8-128 chars, three of: lowercase/uppercase/digit/special). Store it in your secret manager; the Rulebricks CLI wizard asks for it as the bootstrap master password.')
param administratorPassword string

@description('Compute SKU. General Purpose D4ds_v5 (4 vCPU / 16 GiB) is a sane production floor; scale up for heavy rule-authoring teams.')
param skuName string = 'Standard_D4ds_v5'

@description('SKU tier matching skuName.')
@allowed(['Burstable', 'GeneralPurpose', 'MemoryOptimized'])
param skuTier string = 'GeneralPurpose'

@description('Storage in GB (auto-grow is enabled).')
param storageSizeGB int = 128

@description('Zone-redundant high availability (standby in a second AZ; requires an AZ-enabled region).')
param enableHighAvailability bool = false

@description('Backup retention in days (7-35).')
@minValue(7)
@maxValue(35)
param backupRetentionDays int = 7

@description('Delegated subnet for the server (Microsoft.DBforPostgreSQL/flexibleServers delegation).')
param postgresSubnetId string

param vnetId string

// VNet-integrated flexible servers need a private DNS zone ending in
// .postgres.database.azure.com, linked to the VNet, before server creation.
resource privateDnsZone 'Microsoft.Network/privateDnsZones@2024-06-01' = {
  name: '${serverName}.private.postgres.database.azure.com'
  location: 'global'
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
  tags: {
    Environment: 'rulebricks'
  }
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

// --- Server parameters for Supabase Realtime (logical replication) ----------
// Chained dependsOn: Flexible Server rejects concurrent configuration writes.
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
