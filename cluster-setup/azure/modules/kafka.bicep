// Managed Kafka: Azure Event Hubs Premium with the Kafka endpoint.
//
// The Rulebricks chart speaks the Kafka protocol to Event Hubs on port 9093
// with SASL PLAIN, username "$ConnectionString", password = the namespace
// connection string (the CLI's "azure-event-hubs" preset fills these in).
//
// Unlike AWS MSK (where the chart's provisioning job creates topics), Event
// Hubs topics are the event hub resources themselves - so this module creates
// the three hubs the platform needs, partitioned to match the deployment's
// worker ceiling:
//
//   <prefix>solution           solutionPartitions   work queue; partition
//                                                    count caps worker
//                                                    concurrency (KEDA max)
//   <prefix>solution-response  solutionPartitions   response path back to HPS
//   <prefix>logs               logsPartitions       decision-log stream
//
// PARTITION LIMITS: Premium allows 100 partitions per event hub and 200 per
// PU per namespace. The chart's default solution partition count (128)
// exceeds the per-hub cap, so solutionPartitions defaults to 64 here -
// 64 + 64 + 24 = 152 partitions fits one PU. Set the deployment's
// rulebricks.hps.workers.solutionPartitions to the same value.

param clusterName string
param location string

@description('Globally-unique Event Hubs namespace name (becomes <name>.servicebus.windows.net).')
param namespaceName string

@description('Premium Processing Units (1, 2, 4, 8, 12, 16). One PU allows 200 partitions namespace-wide and ~5-10 MB/s ingress.')
@allowed([1, 2, 4, 8, 12, 16])
param capacityUnits int = 1

@description('Kafka topic prefix; must match the deployment\'s kafkaTopicPrefix (CLI default "com.rulebricks.").')
param topicPrefix string = 'com.rulebricks.'

@description('Partitions for the solution and solution-response hubs. Caps worker concurrency; keep <= 100 (Premium per-hub limit) and set rulebricks.hps.workers.solutionPartitions to match.')
@minValue(1)
@maxValue(100)
param solutionPartitions int = 64

@description('Partitions for the decision-logs hub.')
@minValue(1)
@maxValue(100)
param logsPartitions int = 24

@description('Retention for all hubs, in hours (Premium supports up to 90 days).')
param retentionHours int = 168

@description('Reach the namespace through a private endpoint and disable public network access.')
param enablePrivateEndpoint bool

param privateEndpointsSubnetId string
param vnetId string

resource namespace 'Microsoft.EventHub/namespaces@2024-01-01' = {
  name: namespaceName
  location: location
  tags: {
    Environment: 'rulebricks'
  }
  sku: {
    name: 'Premium'
    tier: 'Premium'
    capacity: capacityUnits
  }
  properties: {
    kafkaEnabled: true
    minimumTlsVersion: '1.2'
    disableLocalAuth: false // chart auth = SAS connection string over SASL PLAIN
    publicNetworkAccess: enablePrivateEndpoint ? 'Disabled' : 'Enabled'
  }
}

// Least-privilege SAS rule for the chart: produce + consume, no Manage. The
// namespace's RootManageSharedAccessKey stays for administrators.
resource authRule 'Microsoft.EventHub/namespaces/authorizationRules@2024-01-01' = {
  parent: namespace
  name: 'rulebricks'
  properties: {
    rights: [
      'Send'
      'Listen'
    ]
  }
}

resource solutionHub 'Microsoft.EventHub/namespaces/eventhubs@2024-01-01' = {
  parent: namespace
  name: '${topicPrefix}solution'
  properties: {
    partitionCount: solutionPartitions
    retentionDescription: {
      cleanupPolicy: 'Delete'
      retentionTimeInHours: retentionHours
    }
  }
}

resource solutionResponseHub 'Microsoft.EventHub/namespaces/eventhubs@2024-01-01' = {
  parent: namespace
  name: '${topicPrefix}solution-response'
  properties: {
    partitionCount: solutionPartitions
    retentionDescription: {
      cleanupPolicy: 'Delete'
      retentionTimeInHours: retentionHours
    }
  }
}

resource logsHub 'Microsoft.EventHub/namespaces/eventhubs@2024-01-01' = {
  parent: namespace
  name: '${topicPrefix}logs'
  properties: {
    partitionCount: logsPartitions
    retentionDescription: {
      cleanupPolicy: 'Delete'
      retentionTimeInHours: retentionHours
    }
  }
}

// Kafka consumer groups (hps-response-consumer, generic-workers, vector, KEDA)
// are managed dynamically through the Kafka group protocol - no pre-creation.

// ----------------------------------------------------------------------------
// Optional private endpoint + DNS
// ----------------------------------------------------------------------------
resource privateDnsZone 'Microsoft.Network/privateDnsZones@2024-06-01' = if (enablePrivateEndpoint) {
  name: 'privatelink.servicebus.windows.net'
  location: 'global'
}

resource privateDnsZoneLink 'Microsoft.Network/privateDnsZones/virtualNetworkLinks@2024-06-01' = if (enablePrivateEndpoint) {
  parent: privateDnsZone
  name: '${clusterName}-eventhubs'
  location: 'global'
  properties: {
    registrationEnabled: false
    virtualNetwork: {
      id: vnetId
    }
  }
}

resource privateEndpoint 'Microsoft.Network/privateEndpoints@2023-11-01' = if (enablePrivateEndpoint) {
  name: '${namespaceName}-pe'
  location: location
  properties: {
    subnet: {
      id: privateEndpointsSubnetId
    }
    privateLinkServiceConnections: [
      {
        name: 'eventhubs'
        properties: {
          privateLinkServiceId: namespace.id
          groupIds: [
            'namespace'
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
        name: 'servicebus'
        properties: {
          privateDnsZoneId: privateDnsZone!.id
        }
      }
    ]
  }
}

output namespaceName string = namespace.name
output bootstrapServers string = '${namespace.name}.servicebus.windows.net:9093'
output topicNames array = [solutionHub.name, solutionResponseHub.name, logsHub.name]
// The connection string is a secret; fetch it out-of-band with this command
// (paste the value into the CLI wizard's Event Hubs connection string field):
output connectionStringCommand string = 'az eventhubs namespace authorization-rule keys list --resource-group ${resourceGroup().name} --namespace-name ${namespace.name} --name ${authRule.name} --query primaryConnectionString -o tsv'
