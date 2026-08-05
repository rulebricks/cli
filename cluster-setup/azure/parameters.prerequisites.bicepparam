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
param location = 'westus'
param resourceTags = {
  environment: 'production'
  workload: 'rulebricks'
}

// Leave empty to auto-detect the ARM deployment identity
param operatorPrincipalIds = []

// By default the workload is deployed into this same resource group. When the
// platform and workload groups differ, set the full workload RG resource ID:
// param workloadResourceGroupId = '/subscriptions/<subscription>/resourceGroups/<workload-rg>'

// ================================================

// VNET / SUBNETS / PRIVATE ENDPOINTS
// Pick an existing subnet with sufficient IP addresses ahead of time

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

// ================================================

// ROLES
// Role assignments need a plan: self-grant (Owner or Contributor+UAA/RBAC Admin
// on each target scope) or platform tickets from the roleRequirements output.
//
// Always required before main when using a custom/existing VNet:
// - Network Contributor on the AKS subnet → AKS control-plane identity
//   (created above when createAksControlPlaneIdentity=true)
//
// Readers on existing platform resources (VNet/DNS/ACS) only if you did not
// create them here; leave assign*Role false and ticket those otherwise.

// Usually left false
// platform/network owners can grant Network Contributor on the AKS subnet
// to the AKS control-plane identity
param assignAksNetworkRole = false

// Below are usually true unless otherwise provisioned
// or managed externally
// DNS Zone Contributor → external-dns identity can write records in the public zone
param assignExternalDnsZoneRole = true
// FIC Contributor → CLI can bind a K8s ServiceAccount to the external-dns identity
param assignExternalDnsFederatedIdentityRole = true

param assignAksIdentityOperatorRole = true
param assignAksIdentityReaderRole = true

// Reader on the public DNS zone for main.bicep
param assignExternalDnsZoneReaderRole = true
// Reader on the external-dns identity for main.bicep
param assignExternalDnsIdentityReaderRole = true

// If the below commands fail, you need Reader from whoever owns that VNet/ACS
// Setting true only works if you also have elevated privileges on that external scope
// az resource show --ids <existingCommunicationServiceId>
param assignCommunicationServiceReaderRole = false
// az network vnet show --ids <parent VNet of existingAksSubnetId>
param assignAksVnetReaderRole = false

// az network private-dns zone show --ids <existingAksPrivateDnsZoneId>
param assignAksPrivateDnsZoneRole = false

// ================================================

// PRIVATE DNS ZONES
// Depends on selected managed services (Event Hubs, Redis, Postgres)
// Depends on if using existing resources (Blob, Key Vault, ACR)
// Central private DNS is the enterprise default

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

// ================================================

// DNS ZONE
// Select a DNS zone ahead of time (e.g. rb.corp.com)
// The cluster's external-dns identity will need a writer role on the zone
// so it can automatically manage A records for subdomains like *.rb.corp.com

// Create both the public zone and external-dns identity. Set this false and
// provide both existing IDs to use platform-owned resources instead.
param createExternalDnsResources = true
// Zone name only (not a resource ID), e.g. rb.corp.com
param dnsZoneName = ''
param existingDnsZoneId = ''
param existingExternalDnsIdentityId = ''

// ================================================

// COMMUNICATION SERVICES
// Email is required for the application to be accessible

// Standard deployment creates ACS with its Azure-managed sender. Set false and
// provide existingCommunicationServiceId when messaging is platform-owned.
param createAcsEmail = false
// Created ACS resources default to clean names (rulebricks-email,
// rulebricks-comms), which must be unique across Azure. Uncomment to override
// param emailServiceName = 'rulebricks-email2'
// param communicationServiceName = 'rulebricks-comms2'
// Portal: Communication Services → your ACS → JSON View → id
// Looks like: /subscriptions/<sub>/resourceGroups/<rg>/providers/Microsoft.Communication/communicationServices/<name>
param existingCommunicationServiceId = ''
param emailSenderDomain = ''
