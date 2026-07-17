// Event Hubs exposes Kafka on port 9093 using SASL PLAIN. The three hubs and
// their partition counts must match the topic settings generated for Helm.

param clusterName string
param location string
param tags object

@description('Globally unique Event Hubs namespace name.')
param namespaceName string

@description('Event Hubs Premium capacity units.')
@allowed([1, 2, 4, 8, 12, 16])
param capacityUnits int = 1

@description('Prefix shared by the provisioned hubs and Helm topic settings.')
param topicPrefix string = 'com.rulebricks.'

@description('Partitions for the solution and solution-response hubs.')
@minValue(1)
@maxValue(100)
param solutionPartitions int = 64

@description('Partitions for the decision-log hub.')
@minValue(1)
@maxValue(100)
param logsPartitions int = 24

@description('Retention for all hubs in hours.')
param retentionHours int = 168

@description('Use a private endpoint and disable public network access.')
param enablePrivateEndpoint bool

param privateEndpointsSubnetId string
param vnetId string

resource namespace 'Microsoft.EventHub/namespaces@2024-01-01' = {
  name: namespaceName
  location: location
  tags: tags
  sku: {
    name: 'Premium'
    tier: 'Premium'
    capacity: capacityUnits
  }
  properties: {
    kafkaEnabled: true
    minimumTlsVersion: '1.2'
    disableLocalAuth: false
    publicNetworkAccess: enablePrivateEndpoint ? 'Disabled' : 'Enabled'
  }
}

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

resource privateDnsZone 'Microsoft.Network/privateDnsZones@2024-06-01' = if (enablePrivateEndpoint) {
  name: 'privatelink.servicebus.windows.net'
  location: 'global'
  tags: tags
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
  tags: tags
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
output connectionStringCommand string = 'az eventhubs namespace authorization-rule keys list --resource-group ${resourceGroup().name} --namespace-name ${namespace.name} --name ${authRule.name} --query primaryConnectionString -o tsv'
