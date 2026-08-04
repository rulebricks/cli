targetScope = 'resourceGroup'

param dataCollectionRuleName string
param principalId string
param identityId string
param assignPublisherRole bool = false

var monitoringMetricsPublisherRoleId = subscriptionResourceId(
  'Microsoft.Authorization/roleDefinitions',
  '3913510d-42f4-4e42-8a64-420c390055eb'
)

resource dcr 'Microsoft.Insights/dataCollectionRules@2023-03-11' existing = {
  name: dataCollectionRuleName
}

// Optional feature grant: Monitoring Metrics Publisher for the data-access
// identity on this existing DCR.
resource metricsPublisherRole 'Microsoft.Authorization/roleAssignments@2022-04-01' = if (assignPublisherRole) {
  name: guid(dcr.id, identityId, 'Monitoring Metrics Publisher')
  scope: dcr
  properties: {
    roleDefinitionId: monitoringMetricsPublisherRoleId
    principalId: principalId
    principalType: 'ServicePrincipal'
  }
}

output dataCollectionRuleId string = dcr.id
