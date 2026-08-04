param clusterName string
param location string
param tags object

param createMonitorWorkspace bool
param enableManagedGrafana bool
param grafanaName string

param rulebricksPrincipalId string
param rulebricksIdentityId string
param assignPublisherRole bool = false
param assignGrafanaReaderRole bool = false

var monitoringMetricsPublisherRoleId = subscriptionResourceId(
  'Microsoft.Authorization/roleDefinitions',
  '3913510d-42f4-4e42-8a64-420c390055eb'
)
var monitoringDataReaderRoleId = subscriptionResourceId(
  'Microsoft.Authorization/roleDefinitions',
  'b0d8363b-8ddd-447d-831f-62ca05bff136'
)

resource monitorWorkspace 'Microsoft.Monitor/accounts@2023-04-03' = if (createMonitorWorkspace) {
  name: '${clusterName}-amw'
  location: location
  tags: tags
}

resource dce 'Microsoft.Insights/dataCollectionEndpoints@2023-03-11' = if (createMonitorWorkspace) {
  name: '${clusterName}-dce'
  location: location
  kind: 'Linux'
  tags: tags
  properties: {}
}

resource dcr 'Microsoft.Insights/dataCollectionRules@2023-03-11' = if (createMonitorWorkspace) {
  name: '${clusterName}-dcr'
  location: location
  kind: 'Linux'
  tags: tags
  properties: {
    dataCollectionEndpointId: dce!.id
    dataSources: {
      prometheusForwarder: [
        {
          name: 'PrometheusDataSource'
          streams: [
            'Microsoft-PrometheusMetrics'
          ]
          labelIncludeFilter: {}
        }
      ]
    }
    destinations: {
      monitoringAccounts: [
        {
          accountResourceId: monitorWorkspace!.id
          name: 'MonitoringAccountDestination'
        }
      ]
    }
    dataFlows: [
      {
        streams: [
          'Microsoft-PrometheusMetrics'
        ]
        destinations: [
          'MonitoringAccountDestination'
        ]
      }
    ]
  }
}

// Optional feature grant: Monitoring Metrics Publisher lets the data-access
// identity send Prometheus remote-write traffic to the DCR.
resource metricsPublisherRoleCreated 'Microsoft.Authorization/roleAssignments@2022-04-01' = if (createMonitorWorkspace && assignPublisherRole) {
  name: guid(dcr!.id, rulebricksIdentityId, 'Monitoring Metrics Publisher')
  scope: dcr
  properties: {
    roleDefinitionId: monitoringMetricsPublisherRoleId
    principalId: rulebricksPrincipalId
    principalType: 'ServicePrincipal'
  }
}

resource grafana 'Microsoft.Dashboard/grafana@2023-09-01' = if (enableManagedGrafana && createMonitorWorkspace) {
  name: grafanaName
  location: location
  tags: tags
  sku: {
    name: 'Standard'
  }
  identity: {
    type: 'SystemAssigned'
  }
  properties: {
    grafanaIntegrations: {
      azureMonitorWorkspaceIntegrations: [
        {
          azureMonitorWorkspaceResourceId: monitorWorkspace!.id
        }
      ]
    }
  }
}

// Optional feature grant: Monitoring Data Reader lets Managed Grafana query
// the Azure Monitor workspace.
resource grafanaAmwReader 'Microsoft.Authorization/roleAssignments@2022-04-01' = if (enableManagedGrafana && createMonitorWorkspace && assignGrafanaReaderRole) {
  name: guid(monitorWorkspace!.id, grafanaName, 'Monitoring Data Reader')
  scope: monitorWorkspace
  properties: {
    roleDefinitionId: monitoringDataReaderRoleId
    principalId: grafana!.identity.principalId
    principalType: 'ServicePrincipal'
  }
}

output dceMetricsIngestionEndpoint string = createMonitorWorkspace ? dce!.properties.metricsIngestion.endpoint : ''
output dcrImmutableId string = createMonitorWorkspace ? dcr!.properties.immutableId : ''
output dataCollectionRuleId string = dcr!.id
output monitorWorkspaceId string = createMonitorWorkspace ? monitorWorkspace!.id : ''
output grafanaEndpoint string = enableManagedGrafana ? grafana!.properties.endpoint : ''
output grafanaPrincipalId string = enableManagedGrafana ? grafana!.identity.principalId : ''
