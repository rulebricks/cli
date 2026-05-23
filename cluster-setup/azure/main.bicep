targetScope = 'resourceGroup'

@description('Name of the AKS cluster.')
param clusterName string = 'rulebricks-cluster'

@description('Azure region for all resources.')
param location string = resourceGroup().location

@description('AKS Kubernetes version.')
param kubernetesVersion string = '1.34'

@description('Number of nodes in the default node pool.')
param nodeCount int = 4

@description('VM size for the default node pool. ARM64 (Standard_*ps_*) recommended.')
param nodeVmSize string = 'Standard_D2ps_v5'

@description('OS disk size in GB for the default node pool.')
param osDiskSizeGB int = 20

@description('OS disk type for the default node pool.')
@allowed([
  'Managed'
  'Ephemeral'
])
param osDiskType string = 'Managed'

@description('Namespace where Rulebricks will be installed. CLI deployments usually use rulebricks-<deployment-name>.')
param rulebricksNamespace string = 'rulebricks'

@description('Kubernetes ServiceAccount name used by Vector.')
param vectorServiceAccountName string = 'vector'

@description('Kubernetes ServiceAccount name used by Prometheus.')
param prometheusServiceAccountName string = 'prometheus'

@description('Enable a user-assigned identity and federated credential for external-dns with Azure DNS.')
param enableExternalDns bool = false

@description('Resource group containing the Azure DNS zone. Required when enableExternalDns is true.')
param dnsZoneResourceGroup string = ''

@description('Enable a user-assigned identity and federated credential for Vector Azure Blob logging.')
param enableBlobLogging bool = false

@description('Existing Azure Storage account name for Vector logs.')
param loggingStorageAccountName string = ''

var networkContributorRoleId = subscriptionResourceId('Microsoft.Authorization/roleDefinitions', 'b24988ac-6180-42a0-ab88-20f7382dd24c')
var dnsZoneContributorRoleId = subscriptionResourceId('Microsoft.Authorization/roleDefinitions', 'befefa01-2a29-4197-83a8-272ff33ce314')
var storageBlobDataContributorRoleId = subscriptionResourceId('Microsoft.Authorization/roleDefinitions', 'ba92f5b4-2d11-453d-a403-e96b0029c9fe')

resource vnet 'Microsoft.Network/virtualNetworks@2023-11-01' = {
  name: '${clusterName}-vnet'
  location: location
  tags: {
    Environment: 'rulebricks'
  }
  properties: {
    addressSpace: {
      addressPrefixes: [
        '10.0.0.0/8'
      ]
    }
    subnets: [
      {
        name: 'aks-subnet'
        properties: {
          addressPrefix: '10.240.0.0/16'
        }
      }
    ]
  }
}

resource nsg 'Microsoft.Network/networkSecurityGroups@2023-11-01' = {
  name: '${clusterName}-nsg'
  location: location
  tags: {
    Environment: 'rulebricks'
  }
  properties: {
    securityRules: [
      {
        name: 'AllowVNetInbound'
        properties: {
          priority: 100
          direction: 'Inbound'
          access: 'Allow'
          protocol: '*'
          sourcePortRange: '*'
          destinationPortRange: '*'
          sourceAddressPrefix: 'VirtualNetwork'
          destinationAddressPrefix: 'VirtualNetwork'
        }
      }
      {
        name: 'AllowVNetOutbound'
        properties: {
          priority: 100
          direction: 'Outbound'
          access: 'Allow'
          protocol: '*'
          sourcePortRange: '*'
          destinationPortRange: '*'
          sourceAddressPrefix: 'VirtualNetwork'
          destinationAddressPrefix: 'VirtualNetwork'
        }
      }
    ]
  }
}

resource subnet 'Microsoft.Network/virtualNetworks/subnets@2023-11-01' = {
  parent: vnet
  name: 'aks-subnet'
  properties: {
    addressPrefix: '10.240.0.0/16'
    networkSecurityGroup: {
      id: nsg.id
    }
  }
}

resource aksIdentity 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' = {
  name: '${clusterName}-identity'
  location: location
}

resource aksNetworkRole 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(vnet.id, aksIdentity.id, 'Network Contributor')
  scope: vnet
  properties: {
    roleDefinitionId: networkContributorRoleId
    principalId: aksIdentity.properties.principalId
    principalType: 'ServicePrincipal'
  }
}

resource aks 'Microsoft.ContainerService/managedClusters@2024-05-01' = {
  name: clusterName
  location: location
  tags: {
    Environment: 'rulebricks'
  }
  identity: {
    type: 'UserAssigned'
    userAssignedIdentities: {
      '${aksIdentity.id}': {}
    }
  }
  properties: {
    dnsPrefix: clusterName
    kubernetesVersion: kubernetesVersion
    agentPoolProfiles: [
      {
        name: 'default'
        count: nodeCount
        enableAutoScaling: false
        vmSize: nodeVmSize
        osDiskSizeGB: osDiskSizeGB
        osDiskType: osDiskType
        osType: 'Linux'
        type: 'VirtualMachineScaleSets'
        mode: 'System'
        vnetSubnetID: subnet.id
        nodeLabels: {
          environment: 'rulebricks'
        }
      }
    ]
    networkProfile: {
      networkPlugin: 'azure'
      networkPolicy: 'calico'
      loadBalancerSku: 'standard'
      serviceCidr: '10.0.0.0/16'
      dnsServiceIP: '10.0.0.10'
    }
    oidcIssuerProfile: {
      enabled: true
    }
    securityProfile: {
      workloadIdentity: {
        enabled: true
      }
    }
    storageProfile: {
      diskCSIDriver: {
        enabled: true
      }
      fileCSIDriver: {
        enabled: true
      }
    }
  }
  dependsOn: [
    aksNetworkRole
  ]
}

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
    issuer: aks.properties.oidcIssuerProfile.issuerURL
    subject: 'system:serviceaccount:${rulebricksNamespace}:external-dns'
    audiences: [
      'api://AzureADTokenExchange'
    ]
  }
}

resource vectorIdentity 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' = if (enableBlobLogging) {
  name: '${clusterName}-vector'
  location: location
}

resource loggingStorageAccount 'Microsoft.Storage/storageAccounts@2023-01-01' existing = if (enableBlobLogging && !empty(loggingStorageAccountName)) {
  name: loggingStorageAccountName
}

resource vectorBlobRole 'Microsoft.Authorization/roleAssignments@2022-04-01' = if (enableBlobLogging && !empty(loggingStorageAccountName)) {
  name: guid(loggingStorageAccount.id, vectorIdentity!.id, 'Storage Blob Data Contributor')
  scope: loggingStorageAccount
  properties: {
    roleDefinitionId: storageBlobDataContributorRoleId
    principalId: vectorIdentity!.properties.principalId
    principalType: 'ServicePrincipal'
  }
}

resource vectorFederatedCredential 'Microsoft.ManagedIdentity/userAssignedIdentities/federatedIdentityCredentials@2023-01-31' = if (enableBlobLogging) {
  parent: vectorIdentity
  name: 'vector'
  properties: {
    issuer: aks.properties.oidcIssuerProfile.issuerURL
    subject: 'system:serviceaccount:${rulebricksNamespace}:${vectorServiceAccountName}'
    audiences: [
      'api://AzureADTokenExchange'
    ]
  }
}

resource prometheusIdentity 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' = {
  name: '${clusterName}-prometheus'
  location: location
}

resource prometheusFederatedCredential 'Microsoft.ManagedIdentity/userAssignedIdentities/federatedIdentityCredentials@2023-01-31' = {
  parent: prometheusIdentity
  name: 'prometheus'
  properties: {
    issuer: aks.properties.oidcIssuerProfile.issuerURL
    subject: 'system:serviceaccount:${rulebricksNamespace}:${prometheusServiceAccountName}'
    audiences: [
      'api://AzureADTokenExchange'
    ]
  }
}

output clusterName string = aks.name
output resourceGroupName string = resourceGroup().name
output location string = location
output kubeconfigCommand string = 'az aks get-credentials --name ${clusterName} --resource-group ${resourceGroup().name}'
output externalDnsClientId string = enableExternalDns ? externalDnsIdentity!.properties.clientId : ''
output vectorClientId string = enableBlobLogging ? vectorIdentity!.properties.clientId : ''
output prometheusClientId string = prometheusIdentity.properties.clientId
