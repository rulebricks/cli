targetScope = 'resourceGroup'

param keyVaultName string
param principalId string
param identityId string

var keyVaultSecretsUserRoleId = subscriptionResourceId(
  'Microsoft.Authorization/roleDefinitions',
  '4633458b-17de-408a-b874-0445c86b69e6'
)

resource vault 'Microsoft.KeyVault/vaults@2023-07-01' existing = {
  name: keyVaultName
}

resource secretsUserRole 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(vault.id, identityId, 'Key Vault Secrets User')
  scope: vault
  properties: {
    roleDefinitionId: keyVaultSecretsUserRoleId
    principalId: principalId
    principalType: 'ServicePrincipal'
  }
}

output vaultUri string = vault.properties.vaultUri
