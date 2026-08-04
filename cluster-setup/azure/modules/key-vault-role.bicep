targetScope = 'resourceGroup'

param keyVaultName string
param principalId string
param identityId string
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

resource vault 'Microsoft.KeyVault/vaults@2023-07-01' existing = {
  name: keyVaultName
}

// Required before rulebricks deploy: the external-secrets identity reads
// workload secrets from this existing vault.
resource secretsUserRole 'Microsoft.Authorization/roleAssignments@2022-04-01' = if (assignReaderRole) {
  name: guid(vault.id, identityId, 'Key Vault Secrets User')
  scope: vault
  properties: {
    roleDefinitionId: keyVaultSecretsUserRoleId
    principalId: principalId
    principalType: 'ServicePrincipal'
  }
}

// Required before rulebricks deploy: these operator principals seed and rotate
// values in this existing vault.
resource secretsOfficerRoles 'Microsoft.Authorization/roleAssignments@2022-04-01' = [
  for writerPrincipalId in writerPrincipalIds: if (assignWriterRoles) {
    name: guid(vault.id, writerPrincipalId, 'Key Vault Secrets Officer')
    scope: vault
    properties: {
      roleDefinitionId: keyVaultSecretsOfficerRoleId
      principalId: writerPrincipalId
    }
  }
]

output vaultId string = vault.id
output vaultUri string = vault.properties.vaultUri
