// Container registry: an Azure Container Registry mirror of the private
// docker.io/rulebricks/* namespace, for clusters with no (or restricted)
// egress to Docker Hub.
//
// The chart pulls every image from docker.io/rulebricks/<name> by default and
// exposes a single registry-HOST override (global.imageRegistry; the CLI
// config's imageRegistry field) that repoints all of them while keeping the
// rulebricks/<name> path. This module provides the Azure side of that story:
//
//   1. Deploy with enableContainerRegistry=true.
//   2. Seed the registry:  bash mirror-to-acr.sh --registry <acrName>
//      (az acr import copies every entry in the chart's images/manifest.yaml,
//      plus the app/HPS/worker product images for your product version,
//      preserving the rulebricks/<name>:<tag> path).
//   3. Set the deployment's imageRegistry to the loginServer output. Because
//      only the registry host changes, no per-image values edits are needed.
//
// The AKS kubelet identity gets AcrPull on the registry (the role-assignment
// equivalent of `az aks update --attach-acr`), so nodes pull without an
// imagePullSecret.

param clusterName string
param location string

@description('Registry name; globally unique, 5-50 alphanumeric characters (becomes <name>.azurecr.io).')
param registryName string

@description('ACR SKU. Premium is required for private endpoints and adds geo-replication + higher throughput; Standard suffices for public-endpoint pulls.')
@allowed(['Basic', 'Standard', 'Premium'])
param skuName string = 'Premium'

@description('Object ID of the AKS kubelet identity (the identity nodes present when pulling images).')
param kubeletIdentityObjectId string

@description('Reach the registry through a private endpoint (requires the Premium SKU).')
param enablePrivateEndpoint bool

param privateEndpointsSubnetId string
param vnetId string

var acrPullRoleId = subscriptionResourceId('Microsoft.Authorization/roleDefinitions', '7f951dda-4ed3-4680-a7ca-43fe172d538d')

resource registry 'Microsoft.ContainerRegistry/registries@2023-11-01-preview' = {
  name: registryName
  location: location
  tags: {
    Environment: 'rulebricks'
  }
  sku: {
    name: skuName
  }
  properties: {
    // RBAC-only data plane: nodes pull via the AcrPull assignment below and
    // operators seed via `az acr import` (an ARM operation) - no admin user.
    adminUserEnabled: false
    // Public network access stays on so `az acr import` (which copies images
    // registry-side) works from any operator workstation. The private endpoint
    // still keeps NODE pulls inside the VNet. Harden to 'Disabled' after
    // seeding if your policy requires it - re-seeding then needs the trusted-
    // services bypass or a network rule for your egress IP.
    // (No minimumTlsVersion property: ACR enforces TLS >= 1.2 platform-wide.)
    publicNetworkAccess: 'Enabled'
  }
}

// AcrPull for the kubelet identity - the identity AKS nodes present to the
// registry. Same effect as `az aks update --attach-acr`, but declarative.
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
// Optional private endpoint + DNS (Premium SKU only)
// ----------------------------------------------------------------------------
resource privateDnsZone 'Microsoft.Network/privateDnsZones@2024-06-01' = if (enablePrivateEndpoint) {
  name: 'privatelink.azurecr.io'
  location: 'global'
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
