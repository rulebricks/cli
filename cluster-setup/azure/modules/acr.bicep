param clusterName string
param location string
param tags object

@description('Globally unique registry name.')
param registryName string

@description('ACR SKU.')
@allowed(['Basic', 'Standard', 'Premium'])
param skuName string = 'Premium'

@description('Object ID of the AKS kubelet identity.')
param kubeletIdentityObjectId string

@description('Use a private endpoint for registry access.')
param enablePrivateEndpoint bool
param allowPublicNetworkAccess bool

param privateEndpointsSubnetId string
param vnetId string

// Key Vault (in this resource group) that stores the Docker Hub pull
// credentials for the cache. Empty = registry only, no upstream cache.
param vaultName string = ''

// Docker Hub credential tied to the Rulebricks license: the username is a
// fixed convention, the token is dckr_pat_<license-key> (assembled by
// main.bicep). ACR fetches images from docker.io/rulebricks/* on first pull
// and serves them from cache afterward - no seeding step, and only the
// registry (not the nodes) needs Docker Hub egress.
param dockerHubUsername string = 'rulebricks'
@secure()
param dockerHubToken string = ''

var cacheEnabled = vaultName != '' && dockerHubToken != ''

var acrPullRoleId = subscriptionResourceId(
  'Microsoft.Authorization/roleDefinitions',
  '7f951dda-4ed3-4680-a7ca-43fe172d538d'
)
var keyVaultSecretsUserRoleId = subscriptionResourceId(
  'Microsoft.Authorization/roleDefinitions',
  '4633458b-17de-408a-b874-0445c86b69e6'
)

resource registry 'Microsoft.ContainerRegistry/registries@2023-07-01' = {
  name: registryName
  location: location
  tags: tags
  sku: {
    name: skuName
  }
  properties: {
    adminUserEnabled: false
    publicNetworkAccess: allowPublicNetworkAccess ? 'Enabled' : 'Disabled'
    networkRuleBypassOptions: 'AzureServices'
  }
}

resource acrPullRole 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(registry.id, kubeletIdentityObjectId, 'AcrPull')
  scope: registry
  properties: {
    roleDefinitionId: acrPullRoleId
    principalId: kubeletIdentityObjectId
    principalType: 'ServicePrincipal'
  }
}

// ----------------------------------------------------------------------------
// Pull-through cache: docker.io/rulebricks/* -> <registry>/rulebricks/*.
// Credential sets can only read credentials from a Key Vault, so the two
// values land there first and the set's system identity is granted read.
// ----------------------------------------------------------------------------

resource vault 'Microsoft.KeyVault/vaults@2023-07-01' existing = {
  name: vaultName == '' ? 'placeholder-vault' : vaultName
}

resource dockerHubUsernameSecret 'Microsoft.KeyVault/vaults/secrets@2023-07-01' = if (cacheEnabled) {
  parent: vault
  name: 'acr-dockerhub-username'
  properties: {
    value: dockerHubUsername
  }
}

resource dockerHubTokenSecret 'Microsoft.KeyVault/vaults/secrets@2023-07-01' = if (cacheEnabled) {
  parent: vault
  name: 'acr-dockerhub-token'
  properties: {
    value: dockerHubToken
  }
}

resource dockerHubCredentials 'Microsoft.ContainerRegistry/registries/credentialSets@2025-11-01' = if (cacheEnabled) {
  parent: registry
  name: 'dockerhub'
  identity: {
    type: 'SystemAssigned'
  }
  properties: {
    loginServer: 'docker.io'
    authCredentials: [
      {
        // ACR requires this literal credential name.
        name: 'Credential1'
        usernameSecretIdentifier: dockerHubUsernameSecret!.properties.secretUri
        passwordSecretIdentifier: dockerHubTokenSecret!.properties.secretUri
      }
    ]
  }
}

resource credentialSetVaultAccess 'Microsoft.Authorization/roleAssignments@2022-04-01' = if (cacheEnabled) {
  name: guid(registry.id, 'dockerhub-credential-set', 'Key Vault Secrets User')
  scope: vault
  properties: {
    roleDefinitionId: keyVaultSecretsUserRoleId
    principalId: dockerHubCredentials!.identity.principalId
    principalType: 'ServicePrincipal'
  }
}

// Wildcard rule: preserves the rulebricks/<name> path, so the deployment's
// single imageRegistry host swap resolves every image.
resource dockerHubCache 'Microsoft.ContainerRegistry/registries/cacheRules@2025-11-01' = if (cacheEnabled) {
  parent: registry
  name: 'rulebricks-dockerhub'
  properties: {
    sourceRepository: 'docker.io/rulebricks/*'
    targetRepository: 'rulebricks/*'
    credentialSetResourceId: dockerHubCredentials!.id
  }
  dependsOn: [
    credentialSetVaultAccess
  ]
}

resource privateDnsZone 'Microsoft.Network/privateDnsZones@2024-06-01' = if (enablePrivateEndpoint) {
  name: 'privatelink.azurecr.io'
  location: 'global'
  tags: tags
}

resource privateDnsZoneLink 'Microsoft.Network/privateDnsZones/virtualNetworkLinks@2024-06-01' = if (enablePrivateEndpoint) {
  parent: privateDnsZone
  name: '${clusterName}-acr'
  location: 'global'
  properties: {
    registrationEnabled: false
    virtualNetwork: {
      id: vnetId
    }
  }
}

resource privateEndpoint 'Microsoft.Network/privateEndpoints@2023-11-01' = if (enablePrivateEndpoint) {
  name: '${registryName}-pe'
  location: location
  tags: tags
  properties: {
    subnet: {
      id: privateEndpointsSubnetId
    }
    privateLinkServiceConnections: [
      {
        name: 'registry'
        properties: {
          privateLinkServiceId: registry.id
          groupIds: [
            'registry'
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
        name: 'registry'
        properties: {
          privateDnsZoneId: privateDnsZone!.id
        }
      }
    ]
  }
}

output registryName string = registry.name
output loginServer string = registry.properties.loginServer
