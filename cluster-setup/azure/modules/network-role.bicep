targetScope = 'resourceGroup'

// Network Contributor for the AKS control-plane identity on its node subnet.
// Microsoft documents subnet scope as sufficient for Azure CNI custom-VNet
// clusters; it avoids granting access to sibling subnets.
//
// A module because the VNet commonly lives in a network team's resource group:
// a role assignment scoped outside the deployment's own resource group has to
// be deployed at that scope, which prerequisites.bicep does before main.
//
// prerequisites.bicep invokes this only when assignAksNetworkRole is true.
// Otherwise the subnet owner applies the grant from the staged principal ID.

param vnetName string
param subnetName string
param subnetId string
param principalId string
// Seeds the role-assignment name, keeping it identical to what cluster.bicep
// produced before this module existed so redeploys of an existing stack do not
// collide with their own prior assignment.
param identityId string
param assignNetworkContributorRole bool = false
param readerPrincipalIds array = []
param assignVnetReaderRole bool = false

@allowed([
  'User'
  'Group'
  'ServicePrincipal'
])
param readerPrincipalType string = 'User'

var networkContributorRoleId = subscriptionResourceId(
  'Microsoft.Authorization/roleDefinitions',
  '4d97b98b-1d4f-4787-a291-c67834d212e7'
)
var readerRoleId = subscriptionResourceId(
  'Microsoft.Authorization/roleDefinitions',
  'acdd72a7-3385-48ef-bd42-f606fba81ae7'
)

resource vnet 'Microsoft.Network/virtualNetworks@2023-11-01' existing = {
  name: vnetName
}

resource subnet 'Microsoft.Network/virtualNetworks/subnets@2023-11-01' existing = {
  parent: vnet
  name: subnetName
}

resource aksNetworkRole 'Microsoft.Authorization/roleAssignments@2022-04-01' = if (assignNetworkContributorRole) {
  name: guid(subnetId, identityId, 'Network Contributor')
  scope: subnet
  properties: {
    roleDefinitionId: networkContributorRoleId
    principalId: principalId
    principalType: 'ServicePrincipal'
  }
}

resource vnetReader 'Microsoft.Authorization/roleAssignments@2022-04-01' = [
  for readerPrincipalId in readerPrincipalIds: if (assignVnetReaderRole) {
    name: guid(vnet.id, readerPrincipalId, 'rulebricks-vnet-reader')
    scope: vnet
    properties: {
      roleDefinitionId: readerRoleId
      principalId: readerPrincipalId
      principalType: readerPrincipalType
    }
  }
]
