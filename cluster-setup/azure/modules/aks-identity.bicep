targetScope = 'resourceGroup'

// The AKS control-plane identity, split out of cluster.bicep so its
// subnet-scoped Network Contributor grant can be made BEFORE the cluster is
// created.
// AKS fails to provision if the identity cannot manage the subnet it is being
// placed in, and on a bring-your-own VNet that grant is a cross-resource-group
// role assignment - which Bicep can only express as a separate module
// (network-role.bicep), which in turn needs the principal ID up front.

param clusterName string
param location string
param tags object

resource aksIdentity 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' = {
  name: '${clusterName}-identity'
  location: location
  tags: tags
}

output identityId string = aksIdentity.id
output principalId string = aksIdentity.properties.principalId
