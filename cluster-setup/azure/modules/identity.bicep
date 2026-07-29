param clusterName string
param location string
param tags object

param enableExternalSecrets bool

// NO federated credentials here: the trust between an identity and a
// Kubernetes ServiceAccount is namespace-scoped, and deployment namespaces are
// per-deployment (rulebricks-<name>), unknowable at cluster-setup time. The
// Rulebricks CLI creates the federated credentials at deploy time (see
// workloadIdentity.ts ensureAzure), exactly like AWS Pod Identity
// associations. This module only provisions the identities themselves.
//
// The external-dns identity is NOT here: its DNS Zone Contributor grant makes
// it org-gated, so it lives in prerequisites.bicep next to the zone.
//
// The shared data-access identity: the one identity the Rulebricks workloads
// assume for every cloud data path (blob storage for decision logs and
// backups, metrics remote write). The CLI preselects it by this name.
resource rulebricksIdentity 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' = {
  name: '${clusterName}-data-access'
  location: location
  tags: tags
}

resource externalSecretsIdentity 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' = if (enableExternalSecrets) {
  name: '${clusterName}-external-secrets'
  location: location
  tags: tags
}

output rulebricksClientId string = rulebricksIdentity.properties.clientId
output rulebricksPrincipalId string = rulebricksIdentity.properties.principalId
output rulebricksIdentityId string = rulebricksIdentity.id
output externalSecretsClientId string = enableExternalSecrets ? externalSecretsIdentity!.properties.clientId : ''
output externalSecretsPrincipalId string = enableExternalSecrets ? externalSecretsIdentity!.properties.principalId : ''
output externalSecretsIdentityId string = enableExternalSecrets ? externalSecretsIdentity!.id : ''
