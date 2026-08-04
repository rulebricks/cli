param location string
param tags object
param keyVaultName string

param enablePrivateEndpoint bool
param enablePurgeProtection bool
param softDeleteRetentionDays int
@allowed([
  'default'
  'recover'
])
@description('Use recover only when a soft-deleted vault with keyVaultName already exists.')
param createMode string = 'default'
param privateEndpointsSubnetId string
@description('Attach the endpoint to an organization-owned private DNS zone. False leaves registration to Azure Policy.')
param createPrivateDnsZoneGroup bool = false
param privateDnsZoneId string = ''

param readerPrincipalId string
param readerIdentityId string
param writerPrincipalIds array
param assignReaderRole bool = false
param assignWriterRoles bool = false

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
    createMode: createMode
    tenantId: tenant().tenantId
    sku: {
      family: 'A'
      name: 'standard'
    }
    enableRbacAuthorization: true
    // The ARM API rejects an explicit false ("cannot be set to false" -
    // enabling purge protection is irreversible, so false must be expressed
    // by OMITTING the property). null omits it.
    enablePurgeProtection: enablePurgeProtection ? true : null
    softDeleteRetentionInDays: softDeleteRetentionDays
    publicNetworkAccess: enablePrivateEndpoint ? 'Disabled' : 'Enabled'
    networkAcls: {
      bypass: 'AzureServices'
      defaultAction: enablePrivateEndpoint ? 'Deny' : 'Allow'
    }
  }
}

// Required before rulebricks deploy: Key Vault Secrets User for the
// external-secrets identity.
resource secretsUserRole 'Microsoft.Authorization/roleAssignments@2022-04-01' = if (assignReaderRole) {
  name: guid(vault.id, readerIdentityId, 'Key Vault Secrets User')
  scope: vault
  properties: {
    roleDefinitionId: keyVaultSecretsUserRoleId
    principalId: readerPrincipalId
    principalType: 'ServicePrincipal'
  }
}

// Required before rulebricks deploy: Key Vault Secrets Officer for each
// operator that seeds or rotates workload secrets.
resource secretsOfficerRoles 'Microsoft.Authorization/roleAssignments@2022-04-01' = [
  for principalId in writerPrincipalIds: if (assignWriterRoles) {
    name: guid(vault.id, principalId, 'Key Vault Secrets Officer')
    scope: vault
    properties: {
      roleDefinitionId: keyVaultSecretsOfficerRoleId
      principalId: principalId
    }
  }
]

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

resource privateEndpointDns 'Microsoft.Network/privateEndpoints/privateDnsZoneGroups@2023-11-01' = if (enablePrivateEndpoint && createPrivateDnsZoneGroup) {
  parent: privateEndpoint
  name: 'default'
  properties: {
    privateDnsZoneConfigs: [
      {
        name: 'vault'
        properties: {
          privateDnsZoneId: privateDnsZoneId
        }
      }
    ]
  }
}

output vaultName string = vault.name
output vaultId string = vault.id
output vaultUri string = vault.properties.vaultUri
