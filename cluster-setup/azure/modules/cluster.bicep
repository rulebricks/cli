param clusterName string
param location string
param tags object
param kubernetesVersion string
param aksSkuTier string

param vnetName string
param aksSubnetId string

param nodeCount int
param maxNodeCount int
param nodeVmSize string
param maxPods int
param osDiskSizeGB int
param osDiskType string

param separateSystemPool bool
param systemNodeCount int
param systemMaxNodeCount int
param systemNodeVmSize string

param enableBurstPool bool
param burstVmSize string
param burstMaxCount int

param serviceCidr string
param dnsServiceIP string
param podCidr string

param availabilityZones array
param enablePrivateCluster bool
param apiServerAuthorizedIpRanges array
param enableEntraRbac bool
param aksAdminPrincipalIds array
param kubernetesUpgradeChannel string
param nodeOsUpgradeChannel string
param enableMaintenanceWindow bool
param maintenanceDay string
param maintenanceStartTime string
param maintenanceUtcOffset string
param enableAzurePolicy bool
param enableKeyVaultSecretsProvider bool
param enableControlPlaneLogs bool
param controlPlaneLogAnalyticsWorkspaceId string

var networkContributorRoleId = subscriptionResourceId(
  'Microsoft.Authorization/roleDefinitions',
  'b24988ac-6180-42a0-ab88-20f7382dd24c'
)
var aksRbacClusterAdminRoleId = subscriptionResourceId(
  'Microsoft.Authorization/roleDefinitions',
  'b1ff04bb-8a4e-4dc4-8eb5-8693973ce19b'
)
var zoneConfig = empty(availabilityZones) ? {} : { availabilityZones: availabilityZones }

resource vnet 'Microsoft.Network/virtualNetworks@2023-11-01' existing = {
  name: vnetName
}

resource aksIdentity 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' = {
  name: '${clusterName}-identity'
  location: location
  tags: tags
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

var sharedSystemPool = union(
  {
    name: 'default'
    count: nodeCount
    enableAutoScaling: true
    minCount: nodeCount
    maxCount: maxNodeCount
    vmSize: nodeVmSize
    maxPods: maxPods
    osDiskSizeGB: osDiskSizeGB
    osDiskType: osDiskType
    osType: 'Linux'
    type: 'VirtualMachineScaleSets'
    mode: 'System'
    scaleDownMode: 'Deallocate'
    vnetSubnetID: aksSubnetId
    upgradeSettings: {
      maxSurge: '33%'
    }
  },
  zoneConfig
)

var dedicatedSystemPool = union(
  {
    name: 'system'
    count: systemNodeCount
    enableAutoScaling: true
    minCount: systemNodeCount
    maxCount: systemMaxNodeCount
    vmSize: systemNodeVmSize
    maxPods: maxPods
    osDiskSizeGB: osDiskSizeGB
    osDiskType: osDiskType
    osType: 'Linux'
    type: 'VirtualMachineScaleSets'
    mode: 'System'
    scaleDownMode: 'Delete'
    nodeTaints: [
      'CriticalAddonsOnly=true:NoSchedule'
    ]
    vnetSubnetID: aksSubnetId
    upgradeSettings: {
      maxSurge: '33%'
    }
  },
  zoneConfig
)

var coreUserPool = union(
  {
    name: 'core'
    count: nodeCount
    enableAutoScaling: true
    minCount: nodeCount
    maxCount: maxNodeCount
    vmSize: nodeVmSize
    maxPods: maxPods
    osDiskSizeGB: osDiskSizeGB
    osDiskType: osDiskType
    osType: 'Linux'
    type: 'VirtualMachineScaleSets'
    mode: 'User'
    scaleDownMode: 'Deallocate'
    nodeLabels: {
      'rulebricks.com/pool': 'core'
    }
    vnetSubnetID: aksSubnetId
    upgradeSettings: {
      maxSurge: '33%'
    }
  },
  zoneConfig
)

var burstPool = union(
  {
    name: 'burst'
    count: 0
    enableAutoScaling: true
    minCount: 0
    maxCount: burstMaxCount
    vmSize: burstVmSize
    maxPods: maxPods
    osDiskSizeGB: osDiskSizeGB
    osDiskType: osDiskType
    osType: 'Linux'
    type: 'VirtualMachineScaleSets'
    mode: 'User'
    scaleDownMode: 'Deallocate'
    nodeLabels: {
      'rulebricks.com/pool': 'burst'
    }
    nodeTaints: [
      'rulebricks.com/pool=burst:NoSchedule'
    ]
    vnetSubnetID: aksSubnetId
    upgradeSettings: {
      maxSurge: '33%'
    }
  },
  zoneConfig
)

var basePools = separateSystemPool ? [dedicatedSystemPool, coreUserPool] : [sharedSystemPool]
var agentPools = enableBurstPool ? concat(basePools, [burstPool]) : basePools

resource aks 'Microsoft.ContainerService/managedClusters@2024-08-01' = {
  name: clusterName
  location: location
  tags: tags
  sku: {
    name: 'Base'
    tier: aksSkuTier
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
    disableLocalAccounts: enableEntraRbac
    aadProfile: enableEntraRbac
      ? {
          managed: true
          enableAzureRBAC: true
        }
      : null
    apiServerAccessProfile: {
      enablePrivateCluster: enablePrivateCluster
      authorizedIPRanges: enablePrivateCluster ? [] : apiServerAuthorizedIpRanges
    }
    agentPoolProfiles: agentPools
    autoScalerProfile: {
      'scan-interval': '10s'
      expander: 'least-waste'
    }
    autoUpgradeProfile: {
      upgradeChannel: kubernetesUpgradeChannel
      nodeOSUpgradeChannel: nodeOsUpgradeChannel
    }
    networkProfile: {
      networkPlugin: 'azure'
      networkPluginMode: 'overlay'
      networkDataplane: 'cilium'
      networkPolicy: 'cilium'
      loadBalancerSku: 'standard'
      podCidr: podCidr
      serviceCidr: serviceCidr
      dnsServiceIP: dnsServiceIP
    }
    oidcIssuerProfile: {
      enabled: true
    }
    addonProfiles: {
      azurepolicy: {
        enabled: enableAzurePolicy
        config: null
      }
      azureKeyvaultSecretsProvider: {
        enabled: enableKeyVaultSecretsProvider
        config: enableKeyVaultSecretsProvider
          ? {
              enableSecretRotation: 'true'
              rotationPollInterval: '2m'
            }
          : null
      }
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

// Control-plane log parity with the EKS stack (api/audit/authenticator
// logging is always on there). BYO Log Analytics workspace: enterprises
// usually centralize diagnostics, so the module never creates one.
resource controlPlaneDiagnostics 'Microsoft.Insights/diagnosticSettings@2021-05-01-preview' = if (enableControlPlaneLogs) {
  name: '${clusterName}-control-plane-logs'
  scope: aks
  properties: {
    workspaceId: controlPlaneLogAnalyticsWorkspaceId
    logs: [
      {
        category: 'kube-apiserver'
        enabled: true
      }
      {
        category: 'kube-audit-admin'
        enabled: true
      }
      {
        category: 'guard'
        enabled: true
      }
    ]
  }
}

resource aksAdminRoles 'Microsoft.Authorization/roleAssignments@2022-04-01' = [
  for principalId in aksAdminPrincipalIds: if (enableEntraRbac) {
    name: guid(aks.id, principalId, 'Azure Kubernetes Service RBAC Cluster Admin')
    scope: aks
    properties: {
      roleDefinitionId: aksRbacClusterAdminRoleId
      principalId: principalId
    }
  }
]

resource autoUpgradeMaintenance 'Microsoft.ContainerService/managedClusters/maintenanceConfigurations@2024-08-01' = if (enableMaintenanceWindow) {
  parent: aks
  name: 'aksManagedAutoUpgradeSchedule'
  properties: {
    maintenanceWindow: {
      durationHours: 4
      schedule: {
        weekly: {
          dayOfWeek: maintenanceDay
          intervalWeeks: 1
        }
      }
      startTime: maintenanceStartTime
      utcOffset: maintenanceUtcOffset
    }
  }
}

resource nodeOsMaintenance 'Microsoft.ContainerService/managedClusters/maintenanceConfigurations@2024-08-01' = if (enableMaintenanceWindow) {
  parent: aks
  name: 'aksManagedNodeOSUpgradeSchedule'
  properties: {
    maintenanceWindow: {
      durationHours: 4
      schedule: {
        weekly: {
          dayOfWeek: maintenanceDay
          intervalWeeks: 1
        }
      }
      startTime: maintenanceStartTime
      utcOffset: maintenanceUtcOffset
    }
  }
}

output clusterName string = aks.name
output oidcIssuerUrl string = aks.properties.oidcIssuerProfile.issuerURL
output clusterIdentityPrincipalId string = aksIdentity.properties.principalId
output kubeletIdentityObjectId string = aks.properties.identityProfile.kubeletidentity.objectId
