// Monitoring: Prometheus remote write -> Azure Monitor managed Prometheus.
//
// createMonitorWorkspace = true provisions an Azure Monitor workspace + an
// explicit Data Collection Endpoint + Rule in THIS resource group, so the
// Monitoring Metrics Publisher role is scoped to a DCR we own and name. Role
// propagation takes ~30 min; expect HTTP 403 from remote write until then.
//
// createMonitorWorkspace = false is the BYO path: pass the resource ID of an
// existing DCR (associated with an Azure Monitor workspace) and only the role
// assignment is created.
//
// The grantee is the <cluster>-rulebricks workload identity (identity.bicep);
// the in-cluster Prometheus authenticates via AKS Workload Identity.
//
// This module is only deployed when enableMetricsRemoteWrite is true (see
// main.bicep) - leave it off to keep metrics in-cluster or send them to an
// existing observability platform.

param clusterName string
param location string

param createMonitorWorkspace bool
param existingDataCollectionRuleId string

@description('Principal ID of the <cluster>-rulebricks workload identity (grantee of the metrics-publisher role).')
param rulebricksPrincipalId string

@description('Resource ID of the <cluster>-rulebricks workload identity (role-assignment guid() seed).')
param rulebricksIdentityId string

var monitoringMetricsPublisherRoleId = subscriptionResourceId('Microsoft.Authorization/roleDefinitions', '3913510d-42f4-4e42-8a64-420c390055eb')

var monitorWorkspaceName = '${clusterName}-amw'
var dceName = '${clusterName}-dce'
var dcrName = '${clusterName}-dcr'

resource monitorWorkspace 'Microsoft.Monitor/accounts@2023-04-03' = if (createMonitorWorkspace) {
  name: monitorWorkspaceName
  location: location
}

resource dce 'Microsoft.Insights/dataCollectionEndpoints@2023-03-11' = if (createMonitorWorkspace) {
  name: dceName
  location: location
  kind: 'Linux'
  properties: {}
}

resource dcr 'Microsoft.Insights/dataCollectionRules@2023-03-11' = if (createMonitorWorkspace) {
  name: dcrName
  location: location
  kind: 'Linux'
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

// BYO DCR reference (createMonitorWorkspace = false)
resource existingDcr 'Microsoft.Insights/dataCollectionRules@2023-03-11' existing = if (!createMonitorWorkspace && !empty(existingDataCollectionRuleId)) {
  name: last(split(existingDataCollectionRuleId, '/'))
}

resource metricsPublisherRoleCreated 'Microsoft.Authorization/roleAssignments@2022-04-01' = if (createMonitorWorkspace) {
  name: guid(dcr!.id, rulebricksIdentityId, 'Monitoring Metrics Publisher')
  scope: dcr
  properties: {
    roleDefinitionId: monitoringMetricsPublisherRoleId
    principalId: rulebricksPrincipalId
    principalType: 'ServicePrincipal'
  }
}

resource metricsPublisherRoleByo 'Microsoft.Authorization/roleAssignments@2022-04-01' = if (!createMonitorWorkspace && !empty(existingDataCollectionRuleId)) {
  name: guid(existingDataCollectionRuleId, rulebricksIdentityId, 'Monitoring Metrics Publisher')
  scope: existingDcr
  properties: {
    roleDefinitionId: monitoringMetricsPublisherRoleId
    principalId: rulebricksPrincipalId
    principalType: 'ServicePrincipal'
  }
}

output dceMetricsIngestionEndpoint string = createMonitorWorkspace ? dce!.properties.metricsIngestion.endpoint : ''
output dcrImmutableId string = createMonitorWorkspace ? dcr!.properties.immutableId : ''
output dataCollectionRuleId string = createMonitorWorkspace ? dcr!.id : existingDataCollectionRuleId
