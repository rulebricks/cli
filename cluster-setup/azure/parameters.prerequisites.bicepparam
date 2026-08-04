// ============================================================================
// Rulebricks prerequisites
//
// Stages the organization-boundary pieces that usually need a platform team,
// network owner, or other elevated approval before the workload can land:
// networking references or subnet/VNet setup, the AKS control-plane identity,
// public DNS + external-dns identity, optional private DNS, and ACS email.
//
// main.bicep only consumes the IDs this deployment emits. Role assignment
// toggles below are optional self-service when the deployer can write RBAC at
// each target scope; otherwise leave them off and use the roleRequirements
// output as ticket items.
//
// Review potential created resources with:
// az deployment group what-if -g <resource-group> --parameters parameters.prerequisites.bicepparam
// ============================================================================

using 'prerequisites.bicep'

param clusterName = 'rulebricks'
param location = 'eastus'
param resourceTags = {
  environment: 'production'
  workload: 'rulebricks'
}

// Empty auto-detects the ARM deployment identity and uses it for prerequisite, main, and CLI handoffs
param operatorPrincipalIds = []

// By default the workload is deployed into this same resource group. When the
// platform and workload groups differ, set the full workload RG resource ID:
// param workloadResourceGroupId = '/subscriptions/<subscription>/resourceGroups/<workload-rg>'

// none | existingSubnets | createSubnetsInExistingVnet | createVnetAndSubnets
// existingSubnets makes no VNet or subnet writes
param networkProvisioningMode = 'existingSubnets'
// Portal: Virtual networks → vnet → Subnets → subnet → JSON View → full resource ID
// Looks like: /subscriptions/<sub>/resourceGroups/<rg>/providers/Microsoft.Network/virtualNetworks/<vnet>/subnets/<subnet>
param existingAksSubnetId = ''
param existingVnetId = ''
param existingPrivateEndpointsSubnetId = ''
param existingPostgresSubnetId = ''
param existingAksSubnetNetworkSecurityGroupId = ''

param configureAksControlPlaneIdentity = true
param createAksControlPlaneIdentity = true
param existingAksControlPlaneIdentityId = ''

// Every role requires consideration

// AKS network role is false unless you also have Owner/Access Admin on the subnet/VNet
param assignAksNetworkRole = false

// Below are usually true unless otherwise provisioned
param assignExternalDnsZoneRole = true
param assignExternalDnsFederatedIdentityRole = true
param assignAksIdentityOperatorRole = true
param assignAksIdentityReaderRole = true
param assignExternalDnsZoneReaderRole = true
param assignExternalDnsIdentityReaderRole = true

// If the below commands fail, you need Reader from whoever owns that VNet/ACS
// Setting true only works if you also have elevated privileges on that external scope
// az resource show --ids <existingCommunicationServiceId>
param assignCommunicationServiceReaderRole = false
// az network vnet show --ids <parent VNet of existingAksSubnetId>
param assignAksVnetReaderRole = false

// az network private-dns zone show --ids <existingAksPrivateDnsZoneId>
param assignAksPrivateDnsZoneRole = false

// Central private DNS is the enterprise default; create nothing here.
param createPrivateDnsZonesFor = []
param existingPrivateDnsZoneIds = {
  blob: ''
  keyVault: ''
  acr: ''
  eventHubs: ''
  redis: ''
  postgres: ''
}
param privateDnsVnetId = ''
param existingAksPrivateDnsZoneId = ''

// Create both the public zone and external-dns identity. Set this false and
// provide both existing IDs to use platform-owned resources instead.
param createExternalDnsResources = true
// Zone name only (not a resource ID), e.g. rb.corp.com
param dnsZoneName = ''
param existingDnsZoneId = ''
param existingExternalDnsIdentityId = ''

// Standard deployment creates ACS with its Azure-managed sender. Set false and
// provide existingCommunicationServiceId when messaging is platform-owned.
param createAcsEmail = false
// Portal: Communication Services → your ACS → JSON View → id
// Looks like: /subscriptions/<sub>/resourceGroups/<rg>/providers/Microsoft.Communication/communicationServices/<name>
param existingCommunicationServiceId = ''
param emailSenderDomain = ''
