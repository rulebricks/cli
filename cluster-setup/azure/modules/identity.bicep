param clusterName string
param location string
param tags object

@description('AKS OIDC issuer URL.')
param oidcIssuerUrl string

param enableExternalDns bool
param enableExternalSecrets bool
param rulebricksNamespace string
param esoServiceAccountName string

resource rulebricksIdentity 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' = {
  name: '${clusterName}-rulebricks'
  location: location
  tags: tags
}

resource externalDnsIdentity 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' = if (enableExternalDns) {
  name: '${clusterName}-external-dns'
  location: location
  tags: tags
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

resource externalSecretsIdentity 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' = if (enableExternalSecrets) {
  name: '${clusterName}-external-secrets'
  location: location
  tags: tags
}

resource externalSecretsFederatedCredential 'Microsoft.ManagedIdentity/userAssignedIdentities/federatedIdentityCredentials@2023-01-31' = if (enableExternalSecrets) {
  parent: externalSecretsIdentity
  name: 'external-secrets'
  properties: {
    issuer: oidcIssuerUrl
    subject: 'system:serviceaccount:${rulebricksNamespace}:${esoServiceAccountName}'
    audiences: [
      'api://AzureADTokenExchange'
    ]
  }
}

output rulebricksClientId string = rulebricksIdentity.properties.clientId
output rulebricksPrincipalId string = rulebricksIdentity.properties.principalId
output rulebricksIdentityId string = rulebricksIdentity.id
output externalDnsClientId string = enableExternalDns ? externalDnsIdentity!.properties.clientId : ''
output externalDnsPrincipalId string = enableExternalDns ? externalDnsIdentity!.properties.principalId : ''
output externalSecretsClientId string = enableExternalSecrets ? externalSecretsIdentity!.properties.clientId : ''
output externalSecretsPrincipalId string = enableExternalSecrets ? externalSecretsIdentity!.properties.principalId : ''
output externalSecretsIdentityId string = enableExternalSecrets ? externalSecretsIdentity!.id : ''
