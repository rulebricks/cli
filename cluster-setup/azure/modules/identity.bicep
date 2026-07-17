// Workload identity: the single <cluster>-rulebricks user-assigned identity
// that holds every data-path role (blob storage, metrics publishing), plus the
// optional external-dns identity.
//
// Federated identity credentials for the rulebricks identity are
// namespace-scoped, so the Rulebricks CLI creates them at `rulebricks deploy`
// time (vector / <release>-backup / prometheus / <release>-clickhouse against
// this identity) - which keeps this module deployment-independent: one
// cluster hosts any number of deployments. The exception is external-dns,
// whose federated credential embeds the deployment namespace, hence the
// rulebricksNamespace parameter.
//
// Role assignments live with the resources they scope to: blob roles in
// storage.bicep, metrics roles in monitoring.bicep, AcrPull in acr.bicep.

param clusterName string
param location string

@description('OIDC issuer URL of the AKS cluster (for the optional external-dns federated credential).')
param oidcIssuerUrl string

param enableExternalDns bool
param dnsZoneResourceGroup string
param rulebricksNamespace string

var dnsZoneContributorRoleId = subscriptionResourceId('Microsoft.Authorization/roleDefinitions', 'befefa01-2a29-4197-83a8-272ff33ce314')

// ----------------------------------------------------------------------------
// RULEBRICKS WORKLOAD IDENTITY (single identity for all data paths)
// ----------------------------------------------------------------------------
resource rulebricksIdentity 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' = {
  name: '${clusterName}-rulebricks'
  location: location
}

// ----------------------------------------------------------------------------
// EXTERNAL-DNS (optional): identity + DNS Zone Contributor + federated
// credential.
// ----------------------------------------------------------------------------
resource externalDnsIdentity 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' = if (enableExternalDns) {
  name: '${clusterName}-external-dns'
  location: location
}

resource externalDnsRole 'Microsoft.Authorization/roleAssignments@2022-04-01' = if (enableExternalDns && (empty(dnsZoneResourceGroup) || dnsZoneResourceGroup == resourceGroup().name)) {
  name: guid(resourceGroup().id, externalDnsIdentity!.id, 'DNS Zone Contributor')
  scope: resourceGroup()
  properties: {
    roleDefinitionId: dnsZoneContributorRoleId
    principalId: externalDnsIdentity!.properties.principalId
    principalType: 'ServicePrincipal'
  }
}

resource externalDnsFederatedCredential 'Microsoft.ManagedIdentity/userAssignedIdentities/federatedIdentityCredentials@2023-01-31' = if (enableExternalDns) {
  parent: externalDnsIdentity
  name: 'external-dns'
  properties: {
    issuer: oidcIssuerUrl
    subject: 'system:serviceaccount:${rulebricksNamespace}:external-dns'
    audiences: [
      'api://AzureADTokenExchange'
    ]
  }
}

output rulebricksClientId string = rulebricksIdentity.properties.clientId
output rulebricksPrincipalId string = rulebricksIdentity.properties.principalId
// Resource ID: role-assignment guid() seed in storage.bicep / monitoring.bicep
// (kept identical to the pre-split seeds so re-deploys stay idempotent).
output rulebricksIdentityId string = rulebricksIdentity.id
output externalDnsClientId string = enableExternalDns ? externalDnsIdentity!.properties.clientId : ''
