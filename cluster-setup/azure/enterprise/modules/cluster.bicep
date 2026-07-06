// AKS cluster: Azure CNI Overlay + Cilium (modern AKS default: pods draw IPs
// from an overlay podCidr instead of the VNet, and Cilium provides the
// dataplane + NetworkPolicy), Workload Identity + OIDC issuer, optional
// private API server and Entra ID / Azure RBAC integration.
//
// Node pools carry the same contract the Rulebricks chart targets everywhere:
// a core pool for always-on services and a burst pool labeled and tainted
// rulebricks.com/pool=burst that the KEDA-scaled worker fleet lands on.

param clusterName string
param location string
param kubernetesVersion string

param vnetName string
param aksSubnetId string

param nodeCount int
param maxNodeCount int
param nodeVmSize string
param maxPods int
param osDiskSizeGB int
param osDiskType string

param enableBurstPool bool
param burstVmSize string
param burstMaxCount int

// Overlay/service CIDRs. None of these may overlap the VNet address space or
// networks it peers with; serviceCidr/podCidr are cluster-internal.
param serviceCidr string
param dnsServiceIP string
param podCidr string

@description('Restrict the Kubernetes API server to private access (requires VPN/Bastion/jumpbox connectivity to run kubectl, helm, and the Rulebricks CLI).')
param enablePrivateCluster bool

@description('Enable Entra ID integration with Azure RBAC for Kubernetes authorization and disable local accounts. Operators then need "Azure Kubernetes Service RBAC Cluster Admin" plus kubelogin.')
param enableEntraRbac bool

var networkContributorRoleId = subscriptionResourceId('Microsoft.Authorization/roleDefinitions', 'b24988ac-6180-42a0-ab88-20f7382dd24c')

resource vnet 'Microsoft.Network/virtualNetworks@2023-11-01' existing = {
  name: vnetName
}

resource aksIdentity 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' = {
  name: '${clusterName}-identity'
  location: location
}

// The cluster identity manages load balancers / routes in the node subnet.
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
    disableLocalAccounts: enableEntraRbac
    aadProfile: enableEntraRbac
      ? {
          managed: true
          enableAzureRBAC: true
        }
      : null
    apiServerAccessProfile: {
      enablePrivateCluster: enablePrivateCluster
    }
    agentPoolProfiles: concat(
      [
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
          // Scale-down parks VMs (stopped, disk-only cost) instead of
          // deleting them; resume is ~30-60s with container images cached.
          scaleDownMode: 'Deallocate'
          vnetSubnetID: aksSubnetId
        }
      ],
      enableBurstPool
        ? [
            {
              // Dedicated burst capacity for the stateless worker fleet:
              // one large VM that parks (Deallocate) between bursts. The
              // taint keeps everything except workers off it; the label is
              // what the chart's soft node affinity targets. First-ever
              // burst cold-provisions (~2-4 min); thereafter resume is
              // ~30-60s with images cached.
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
            }
          ]
        : []
    )
    // Tuned for bursty traffic: detect pending pods quickly and pick the
    // node pool that wastes the least capacity. With the core pool capped at
    // maxNodeCount, a scaled-out worker fleet overflows to the burst pool
    // within 1-2 autoscaler iterations.
    autoScalerProfile: {
      'scan-interval': '10s'
      expander: 'least-waste'
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

output clusterName string = aks.name
output oidcIssuerUrl string = aks.properties.oidcIssuerProfile.issuerURL
output clusterIdentityPrincipalId string = aksIdentity.properties.principalId
