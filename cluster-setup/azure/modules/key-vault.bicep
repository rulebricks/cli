param clusterName string
param location string
param tags object
param keyVaultName string

param allowPublicNetworkAccess bool
param enablePrivateEndpoint bool
param enablePurgeProtection bool
param softDeleteRetentionDays int
param privateEndpointsSubnetId string
param vnetId string

param readerPrincipalId string
param readerIdentityId string
param writerPrincipalIds array

var keyVaultSecretsUserRoleId = subscriptionResourceId(
  'Microsoft.Authorization/roleDefinitions',
  '4633458b-17de-408a-b874-0445c86b69e6'
)
var keyVaultSecretsOfficerRoleId = subscriptionResourceId(
  'Microsoft.Authorization/roleDefinitions',
  'b86a8fe4-44ce-4948-aee5-eccb2c155cd7'
)

resource vault 'Microsoft.KeyVault/vaults@2023-07-01' = {
  name: keyVaultName
  location: location
  tags: tags
  properties: {
    tenantId: tenant().tenantId
    sku: {
      family: 'A'
      name: 'standard'
    }
    enableRbacAuthorization: true
    enablePurgeProtection: enablePurgeProtection
    softDeleteRetentionInDays: softDeleteRetentionDays
    publicNetworkAccess: allowPublicNetworkAccess ? 'Enabled' : 'Disabled'
    networkAcls: {
      bypass: 'AzureServices'
      defaultAction: allowPublicNetworkAccess ? 'Allow' : 'Deny'
    }
  }
}

resource secretsUserRole 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(vault.id, readerIdentityId, 'Key Vault Secrets User')
  scope: vault
  properties: {
    roleDefinitionId: keyVaultSecretsUserRoleId
    principalId: readerPrincipalId
    principalType: 'ServicePrincipal'
  }
}

resource secretsOfficerRoles 'Microsoft.Authorization/roleAssignments@2022-04-01' = [
  for principalId in writerPrincipalIds: {
    name: guid(vault.id, principalId, 'Key Vault Secrets Officer')
    scope: vault
    properties: {
      roleDefinitionId: keyVaultSecretsOfficerRoleId
      principalId: principalId
    }
  }
]

resource privateDnsZone 'Microsoft.Network/privateDnsZones@2024-06-01' = if (enablePrivateEndpoint) {
  name: 'privatelink.vaultcore.azure.net'
  location: 'global'
  tags: tags
}

resource privateDnsZoneLink 'Microsoft.Network/privateDnsZones/virtualNetworkLinks@2024-06-01' = if (enablePrivateEndpoint) {
  parent: privateDnsZone
  name: '${clusterName}-key-vault'
  location: 'global'
  properties: {
    registrationEnabled: false
    virtualNetwork: {
      id: vnetId
    }
  }
}

resource privateEndpoint 'Microsoft.Network/privateEndpoints@2023-11-01' = if (enablePrivateEndpoint) {
  name: '${keyVaultName}-pe'
  location: location
  tags: tags
  properties: {
    subnet: {
      id: privateEndpointsSubnetId
    }
    privateLinkServiceConnections: [
      {
        name: 'vault'
        properties: {
          privateLinkServiceId: vault.id
          groupIds: [
            'vault'
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
        name: 'vault'
        properties: {
          privateDnsZoneId: privateDnsZone!.id
        }
      }
    ]
  }
}

output vaultName string = vault.name
output vaultUri string = vault.properties.vaultUri
