targetScope = 'resourceGroup'

// ============================================================================
// Rulebricks prerequisites: Org-gated resources and network bootstrap
//
// This is the only template allowed to write network or shared prerequisite
// resources. It either consumes existing subnet/resource IDs (no network
// writes) or creates a complete VNet for self-managed environments.
// main.bicep consumes only the resulting IDs.
//
// RESOURCES THIS TEMPLATE CAN CREATE:
//   networkProvisioningMode
//                      no network, existing subnet references, approved
//                      subnets in an existing VNet, or a new VNet/subnets
//   configureAksControlPlaneIdentity
//                      enable AKS identity creation/reference independently
//   createAksControlPlaneIdentity
//                      Microsoft.ManagedIdentity/userAssignedIdentities
//   createExternalDnsResources
//                      Microsoft.Network/dnsZones
//                      Microsoft.ManagedIdentity/userAssignedIdentities
//   createAcsEmail     Microsoft.Communication/emailServices (+ its domains)
//                      Microsoft.Communication/communicationServices
//                      Microsoft.Communication/communicationServices/smtpUsernames
//   createPrivateDnsZonesFor
//                      selected private DNS zones and VNet links
//   assign<Role>       independently selected network, DNS, Reader, identity,
//                      and FIC role assignments
//
// Contributor can create permitted resources and identities but cannot create
// role assignments. Every role toggle defaults false; deploy, then give the
// roleRequirements output to the appropriate platform owner before main.
//
// Branded sender domains: this template creates the DNS verification records
// in the zone, but starting verification is a POST action ARM cannot perform
// and ACS links a domain only once it reports verified, so a fresh deployment
// always ends with the branded domain unlinked and the azurecomm.net fallback
// sending. A platform owner initiates verification and links the domain using
// the handoff outputs below; the Rulebricks CLI verifies the final state but
// never mutates these organization-owned resources. main.bicep also remains
// read-only.
// ============================================================================

// Must match main.bicep's clusterName: identity names and default ACS names
// are derived from it.
param clusterName string = 'rulebricks-cluster'
param location string = resourceGroup().location
param resourceTags object = {
  workload: 'rulebricks'
}

// ---------------------------------------------------------------------------
// Workload boundary and networking
// ---------------------------------------------------------------------------

@description('Resource ID of the resource group where main.bicep deploys. The AKS control-plane identity is created here so that a Contributor on the workload group can attach it to the cluster.')
param workloadResourceGroupId string = resourceGroup().id

@allowed([
  'none'
  'existingSubnets'
  'createSubnetsInExistingVnet'
  'createVnetAndSubnets'
])
@description('none performs no AKS network staging; existingSubnets references organization-provided IDs; createSubnetsInExistingVnet creates approved subnets in an existing VNet; createVnetAndSubnets creates a new VNet here. main.bicep never writes any of them.')
param networkProvisioningMode string = 'existingSubnets'

@description('Existing AKS subnet ID. Required in existingSubnets mode; the VNet is derived from it.')
param existingAksSubnetId string = ''

@description('Existing VNet resource ID. Required only in createSubnetsInExistingVnet mode.')
param existingVnetId string = ''

@description('Existing private-endpoints subnet ID. Optional while private endpoints are disabled.')
param existingPrivateEndpointsSubnetId string = ''

@description('Existing PostgreSQL delegated subnet ID. Optional while managed PostgreSQL is disabled.')
param existingPostgresSubnetId string = ''

@description('Optional organization-owned NSG ID to attach to an AKS subnet created inside an existing VNet. The self-managed VNet path creates its own NSG.')
param existingAksSubnetNetworkSecurityGroupId string = ''

@description('Only used when createVnetAndSubnets is selected. The block your network team allocates; it must not overlap anything routable on a network this VNet will be peered with.')
param vnetAddressSpace string = '10.240.0.0/16'

@description('AKS subnet name when this template creates the VNet.')
param aksSubnetName string = 'aks-subnet'

@description('CIDR for a created AKS subnet. With Cilium overlay only node NICs consume VNet addresses. /26 is the recommended non-production size for the shipped node maxima and upgrade surge.')
param aksSubnetPrefix string = '10.240.0.0/26'

@description('Create a dedicated private-endpoints subnet in the created VNet. Leave false for the public-endpoint prototype.')
param createPrivateEndpointsSubnet bool = false

param privateEndpointsSubnetName string = 'private-endpoints-subnet'

@description('CIDR for a created private-endpoints subnet. /27 leaves 27 usable addresses after Azure reservations.')
param privateEndpointsSubnetPrefix string = '10.240.0.64/27'

@description('Create a PostgreSQL Flexible Server delegated subnet in the created VNet. Leave false while managed PostgreSQL is disabled.')
param createPostgresSubnet bool = false

param postgresSubnetName string = 'postgres-subnet'

@description('Organization-approved CIDR for a created PostgreSQL delegated subnet. /28 is the Azure minimum; /27 leaves growth room.')
param postgresSubnetPrefix string = '10.240.0.96/27'

// ---------------------------------------------------------------------------
// AKS control-plane identity
// ---------------------------------------------------------------------------

@description('Stage an AKS control-plane identity. False permits DNS-only, ACS-only, private-DNS-only, and other partial prerequisite runs.')
param configureAksControlPlaneIdentity bool = true

@description('Create the AKS control-plane identity in workloadResourceGroupId. False uses existingAksControlPlaneIdentityId.')
param createAksControlPlaneIdentity bool = true

@description('Existing AKS control-plane identity resource ID when creation is disabled.')
param existingAksControlPlaneIdentityId string = ''

@description('Assign Network Contributor to the AKS control-plane identity on the AKS subnet. Contributor cannot do this; leave false for platform-team handoff.')
param assignAksNetworkRole bool = false

@description('Assign DNS Zone Contributor to the external-dns identity on the public zone.')
param assignExternalDnsZoneRole bool = false

@description('Allow cliPrincipalIds to create federated credentials on the external-dns identity.')
param assignExternalDnsFederatedIdentityRole bool = false

@description('Allow mainDeployerPrincipalIds to attach the staged AKS identity to the cluster. Usually already covered by Contributor on the workload resource group.')
param assignAksIdentityOperatorRole bool = false

@description('Assign Reader on the staged AKS identity to mainDeployerPrincipalIds.')
param assignAksIdentityReaderRole bool = false

@description('Assign Reader on the public DNS zone to mainDeployerPrincipalIds.')
param assignExternalDnsZoneReaderRole bool = false

@description('Assign Reader on the external-dns identity to mainDeployerPrincipalIds.')
param assignExternalDnsIdentityReaderRole bool = false

@description('Assign Reader on the ACS communication service to cliPrincipalIds.')
param assignCommunicationServiceReaderRole bool = false

@description('Assign Reader on the AKS VNet to mainDeployerPrincipalIds.')
param assignAksVnetReaderRole bool = false

@description('Assign Private DNS Zone Contributor to the AKS identity on existingAksPrivateDnsZoneId for privateWithExistingDns API mode.')
param assignAksPrivateDnsZoneRole bool = false

// ---------------------------------------------------------------------------
// Optional private DNS creation
// ---------------------------------------------------------------------------

@description('Private DNS namespaces to CREATE and link to the effective VNet. Supported values: blob, keyVault, acr, eventHubs, redis, postgres. Empty (the enterprise default) creates none.')
param createPrivateDnsZonesFor array = []

type PrivateDnsZoneIds = {
  blob: string
  keyVault: string
  acr: string
  eventHubs: string
  redis: string
  postgres: string
}

@description('Existing organization-owned private DNS zone IDs to pass through to main. These resources are never modified here.')
param existingPrivateDnsZoneIds PrivateDnsZoneIds = {
  blob: ''
  keyVault: ''
  acr: ''
  eventHubs: ''
  redis: ''
  postgres: ''
}

@description('VNet resource ID to link newly created private DNS zones when AKS network staging is disabled. Empty uses the VNet selected by networkProvisioningMode.')
param privateDnsVnetId string = ''

@description('Existing private DNS zone ID used by AKS privateWithExistingDns mode. Passed to main and optionally granted to the AKS identity before main runs.')
param existingAksPrivateDnsZoneId string = ''

// ---------------------------------------------------------------------------
// DNS (delegated-subdomain model)
// ---------------------------------------------------------------------------

@description('Create the public DNS zone and external-dns identity. False either references existingDnsZoneId/existingExternalDnsIdentityId or disables automatic DNS when both are empty.')
param createExternalDnsResources bool = false

@description('Public DNS zone name to create, e.g. rb.corp.com. Used only when createExternalDnsResources is true.')
param dnsZoneName string = ''

@description('Existing public DNS zone resource ID when createExternalDnsResources is false.')
param existingDnsZoneId string = ''

@description('Existing external-dns user-assigned identity resource ID when createExternalDnsResources is false.')
param existingExternalDnsIdentityId string = ''

// ---------------------------------------------------------------------------
// Email (Azure Communication Services)
// ---------------------------------------------------------------------------

@description('CREATES the ACS email service, sender domains, communication service, and SMTP Username linked to acsSmtpEntraApplicationId. Off by default because ACS provisioning is restricted in many tenants.')
param createAcsEmail bool = false

@description('Existing Azure Communication Services resource ID to pass through to main when createAcsEmail is false. Empty disables managed email.')
param existingCommunicationServiceId string = ''

@description('REQUIRED when createAcsEmail is true. Client/application ID of the existing Entra application used for ACS SMTP authentication. Its client secret remains a secure out-of-band handoff.')
param acsSmtpEntraApplicationId string = ''

// ACS data-at-rest region ('United States', 'Europe', ...). Domains can only
// be linked into a communication service with the same data location, so
// every ACS resource here shares this one value.
param emailDataLocation string = 'United States'

// Optional branded sender domain (e.g. rb.corp.com or mail.rb.corp.com),
// normally the zone above or a subdomain of it - verification records are
// then written into the zone here. Empty = only the instantly-verified
// Azure-managed azurecomm.net sender.
param emailSenderDomain string = ''

// ---------------------------------------------------------------------------
// Handover
// ---------------------------------------------------------------------------

@description('Common operator object IDs used for all phases. Empty auto-detects the current ARM deployment principal. Set phase-specific lists below only when different actors perform different phases.')
param operatorPrincipalIds array = []

@allowed([
  'User'
  'Group'
  'ServicePrincipal'
])
@description('Principal type for explicitly supplied operatorPrincipalIds. Auto-detected as User or ServicePrincipal when operatorPrincipalIds is empty.')
param operatorPrincipalType string = 'User'

@description('Optional override for principals that deploy prerequisites.bicep. Empty uses the common operator.')
param prerequisiteDeployerPrincipalIds array = []

@description('Optional override for principals that deploy main.bicep. Empty uses the common operator.')
param mainDeployerPrincipalIds array = []

@allowed([
  'User'
  'Group'
  'ServicePrincipal'
])
param mainDeployerPrincipalType string = 'User'

@description('Optional override for principals that run the Rulebricks CLI. Empty uses the common operator.')
param cliPrincipalIds array = []

@allowed([
  'User'
  'Group'
  'ServicePrincipal'
])
param cliPrincipalType string = 'User'

@description('Deprecated compatibility fallback. Empty actor-specific lists inherit these IDs.')
param deployerPrincipalIds array = []

@allowed([
  'User'
  'Group'
  'ServicePrincipal'
])
param deployerPrincipalType string = 'User'

// ---------------------------------------------------------------------------

var noAksNetwork = networkProvisioningMode == 'none'
var useExistingSubnets = networkProvisioningMode == 'existingSubnets'
var createSubnetsInExistingVnet = networkProvisioningMode == 'createSubnetsInExistingVnet'
var createVnet = networkProvisioningMode == 'createVnetAndSubnets'
var createNetworkSubnets = createVnet || createSubnetsInExistingVnet

var existingAksSubnetSegments = split(existingAksSubnetId, '/')
var existingAksSubnetType = length(existingAksSubnetSegments) > 10
  ? '${toLower(existingAksSubnetSegments[6])}/${toLower(existingAksSubnetSegments[7])}/${toLower(existingAksSubnetSegments[9])}'
  : ''
var vnetIdFromExistingAksSubnet = length(existingAksSubnetSegments) > 10
  ? join(take(existingAksSubnetSegments, 9), '/')
  : ''
var existingPrivateEndpointsSubnetSegments = split(existingPrivateEndpointsSubnetId, '/')
var existingPrivateEndpointsSubnetType = length(existingPrivateEndpointsSubnetSegments) > 10
  ? '${toLower(existingPrivateEndpointsSubnetSegments[6])}/${toLower(existingPrivateEndpointsSubnetSegments[7])}/${toLower(existingPrivateEndpointsSubnetSegments[9])}'
  : ''
var existingPostgresSubnetSegments = split(existingPostgresSubnetId, '/')
var existingPostgresSubnetType = length(existingPostgresSubnetSegments) > 10
  ? '${toLower(existingPostgresSubnetSegments[6])}/${toLower(existingPostgresSubnetSegments[7])}/${toLower(existingPostgresSubnetSegments[9])}'
  : ''
var existingAksSubnetNsgSegments = split(existingAksSubnetNetworkSecurityGroupId, '/')
var existingAksSubnetNsgType = length(existingAksSubnetNsgSegments) > 8
  ? '${toLower(existingAksSubnetNsgSegments[6])}/${toLower(existingAksSubnetNsgSegments[7])}'
  : ''
var providedVnetId = createSubnetsInExistingVnet
  ? existingVnetId
  : (useExistingSubnets ? vnetIdFromExistingAksSubnet : '')
var providedVnetSegments = split(providedVnetId, '/')
var providedVnetSubscriptionId = length(providedVnetSegments) > 8
  ? providedVnetSegments[2]
  : subscription().subscriptionId
var providedVnetResourceGroup = length(providedVnetSegments) > 8
  ? providedVnetSegments[4]
  : resourceGroup().name
var providedVnetName = length(providedVnetSegments) > 8 ? providedVnetSegments[8] : ''

var workloadResourceGroupSegments = split(workloadResourceGroupId, '/')
var workloadResourceGroupType = length(workloadResourceGroupSegments) > 4
  ? '${toLower(workloadResourceGroupSegments[1])}/${toLower(workloadResourceGroupSegments[3])}'
  : ''
var workloadSubscriptionId = length(workloadResourceGroupSegments) > 4
  ? workloadResourceGroupSegments[2]
  : subscription().subscriptionId
var workloadResourceGroupName = length(workloadResourceGroupSegments) > 4
  ? workloadResourceGroupSegments[4]
  : resourceGroup().name

var existingAksIdentitySegments = split(existingAksControlPlaneIdentityId, '/')
var existingAksIdentitySubscriptionId = length(existingAksIdentitySegments) > 8
  ? existingAksIdentitySegments[2]
  : subscription().subscriptionId
var existingAksIdentityResourceGroup = length(existingAksIdentitySegments) > 8
  ? existingAksIdentitySegments[4]
  : workloadResourceGroupName
var existingAksIdentityName = length(existingAksIdentitySegments) > 8 ? existingAksIdentitySegments[8] : ''
var existingAksIdentityType = length(existingAksIdentitySegments) > 8
  ? '${toLower(existingAksIdentitySegments[6])}/${toLower(existingAksIdentitySegments[7])}'
  : ''

var existingDnsZoneSegments = split(existingDnsZoneId, '/')
var existingDnsZoneSubscriptionId = length(existingDnsZoneSegments) > 8
  ? existingDnsZoneSegments[2]
  : subscription().subscriptionId
var existingDnsZoneResourceGroup = length(existingDnsZoneSegments) > 8
  ? existingDnsZoneSegments[4]
  : resourceGroup().name
var existingDnsZoneName = length(existingDnsZoneSegments) > 8 ? existingDnsZoneSegments[8] : ''
var existingDnsZoneType = length(existingDnsZoneSegments) > 8
  ? '${toLower(existingDnsZoneSegments[6])}/${toLower(existingDnsZoneSegments[7])}'
  : ''

var existingExternalDnsIdentitySegments = split(existingExternalDnsIdentityId, '/')
var existingExternalDnsIdentitySubscriptionId = length(existingExternalDnsIdentitySegments) > 8
  ? existingExternalDnsIdentitySegments[2]
  : subscription().subscriptionId
var existingExternalDnsIdentityResourceGroup = length(existingExternalDnsIdentitySegments) > 8
  ? existingExternalDnsIdentitySegments[4]
  : resourceGroup().name
var existingExternalDnsIdentityName = length(existingExternalDnsIdentitySegments) > 8
  ? existingExternalDnsIdentitySegments[8]
  : ''
var existingExternalDnsIdentityType = length(existingExternalDnsIdentitySegments) > 8
  ? '${toLower(existingExternalDnsIdentitySegments[6])}/${toLower(existingExternalDnsIdentitySegments[7])}'
  : ''

var existingCommunicationServiceSegments = split(existingCommunicationServiceId, '/')
var existingCommunicationServiceSubscriptionId = length(existingCommunicationServiceSegments) > 8
  ? existingCommunicationServiceSegments[2]
  : subscription().subscriptionId
var existingCommunicationServiceResourceGroup = length(existingCommunicationServiceSegments) > 8
  ? existingCommunicationServiceSegments[4]
  : resourceGroup().name
var existingCommunicationServiceType = length(existingCommunicationServiceSegments) > 8
  ? '${toLower(existingCommunicationServiceSegments[6])}/${toLower(existingCommunicationServiceSegments[7])}'
  : ''
var existingCommunicationServiceName = length(existingCommunicationServiceSegments) > 8
  ? existingCommunicationServiceSegments[8]
  : ''

var existingAksPrivateDnsZoneSegments = split(existingAksPrivateDnsZoneId, '/')
var existingAksPrivateDnsZoneSubscriptionId = length(existingAksPrivateDnsZoneSegments) > 8
  ? existingAksPrivateDnsZoneSegments[2]
  : subscription().subscriptionId
var existingAksPrivateDnsZoneResourceGroup = length(existingAksPrivateDnsZoneSegments) > 8
  ? existingAksPrivateDnsZoneSegments[4]
  : resourceGroup().name
var existingAksPrivateDnsZoneName = length(existingAksPrivateDnsZoneSegments) > 8
  ? existingAksPrivateDnsZoneSegments[8]
  : ''
var existingAksPrivateDnsZoneType = length(existingAksPrivateDnsZoneSegments) > 8
  ? '${toLower(existingAksPrivateDnsZoneSegments[6])}/${toLower(existingAksPrivateDnsZoneSegments[7])}'
  : ''

var useExternalDns = createExternalDnsResources || (!empty(existingDnsZoneId) && !empty(existingExternalDnsIdentityId))
var effectiveDnsZoneName = createExternalDnsResources ? dnsZoneName : existingDnsZoneName
var effectiveDnsZoneResourceGroup = createExternalDnsResources
  ? resourceGroup().name
  : existingDnsZoneResourceGroup
var effectiveDnsZoneSubscriptionId = createExternalDnsResources
  ? subscription().subscriptionId
  : existingDnsZoneSubscriptionId
var useManagedEmail = createAcsEmail || !empty(existingCommunicationServiceId)
var effectiveCommunicationServiceId = createAcsEmail
  ? communicationService.id
  : existingCommunicationServiceId
var effectiveCommunicationServiceName = createAcsEmail
  ? communicationService.name
  : existingCommunicationServiceName
var effectiveCommunicationServiceSubscriptionId = createAcsEmail
  ? subscription().subscriptionId
  : existingCommunicationServiceSubscriptionId
var effectiveCommunicationServiceResourceGroup = createAcsEmail
  ? resourceGroup().name
  : existingCommunicationServiceResourceGroup

var hasBrandedDomain = createAcsEmail && emailSenderDomain != ''
// Verification records are only creatable here when the branded domain is the
// zone apex or a subdomain of the zone this template owns; otherwise the
// emailVerificationRecords output must be published manually.
var createDnsRecords = hasBrandedDomain && createExternalDnsResources && dnsZoneName != '' && (emailSenderDomain == dnsZoneName || endsWith(emailSenderDomain, '.${dnsZoneName}'))
// Record names are zone-relative: '' (apex) or the label prefix. The
// createDnsRecords guard doubles as the substring bound check: ARM evaluates
// even unused conditional resources' names at validation time, and a
// senderless deployment would otherwise hit substring with a negative length.
var brandedDomainLabel = (!createDnsRecords || emailSenderDomain == dnsZoneName)
  ? ''
  : substring(emailSenderDomain, 0, length(emailSenderDomain) - length(dnsZoneName) - 1)
// ACS DKIM selectors are fixed product-wide constants; using them as static
// record names keeps runtime references out of resource names.
var dkimSelector1 = 'selector1-azurecomm-prod-net._domainkey'
var dkimSelector2 = 'selector2-azurecomm-prod-net._domainkey'

var emailServiceName = take('rbemail${uniqueString(resourceGroup().id, validatedClusterName)}', 63)
// Returned as a full resource ID for main.bicep; no name/resource-group
// reconstruction is required.
var communicationServiceName = take('rbcomm${uniqueString(resourceGroup().id, validatedClusterName)}', 63)
var acsSmtpUsernameResourceName = take('${replace(toLower(validatedClusterName), '_', '-')}-smtp', 253)
var acsSmtpUsername = take('${replace(toLower(validatedClusterName), '_', '-')}-smtp-user', 253)

var networkContributorRoleDefinitionId = '4d97b98b-1d4f-4787-a291-c67834d212e7'
var contributorRoleDefinitionId = 'b24988ac-6180-42a0-ab88-20f7382dd24c'
var dnsZoneContributorRoleDefinitionId = 'befefa01-2a29-4197-83a8-272ff33ce314'
var ficContributorRoleDefinitionId = '7e559ce2-48d7-4b27-9128-fa1b247f1308'
var managedIdentityOperatorRoleDefinitionId = 'f1a07417-d97a-45cb-824c-7a7467783830'
var privateDnsZoneContributorRoleDefinitionId = 'b12aa53e-6015-4669-85d0-8515ebb3ae7f'
var readerRoleDefinitionId = 'acdd72a7-3385-48ef-bd42-f606fba81ae7'
// Managed Identity Federated Identity Credential Contributor: FIC write and
// nothing else, scoped to the one identity below.
// ---------------------------------------------------------------------------
// Networking
// ---------------------------------------------------------------------------

// Lives here rather than in main.bicep because address space is centrally
// allocated in most organizations. This module can create approved subnets in
// an existing VNet without touching its address space, or create a complete
// VNet only in self-managed environments. main.bicep receives IDs either way.
var networkModuleSubscriptionId = createSubnetsInExistingVnet
  ? providedVnetSubscriptionId
  : subscription().subscriptionId
var networkModuleResourceGroup = createSubnetsInExistingVnet
  ? providedVnetResourceGroup
  : resourceGroup().name
var networkModuleVnetName = createSubnetsInExistingVnet ? providedVnetName : '${clusterName}-vnet'
var networkModuleVnetId = resourceId(
  networkModuleSubscriptionId,
  networkModuleResourceGroup,
  'Microsoft.Network/virtualNetworks',
  networkModuleVnetName
)
var effectiveAksNetworkSubscriptionId = createVnet
  ? subscription().subscriptionId
  : (noAksNetwork ? workloadSubscriptionId : providedVnetSubscriptionId)

resource existingAksVnetForValidation 'Microsoft.Network/virtualNetworks@2023-11-01' existing = if (useExistingSubnets || createSubnetsInExistingVnet) {
  name: !empty(providedVnetName) ? providedVnetName : 'invalid-vnet-id'
  scope: resourceGroup(providedVnetSubscriptionId, providedVnetResourceGroup)
}

module network 'modules/network.bicep' = if (createNetworkSubnets) {
  name: '${validatedClusterName}-network'
  scope: resourceGroup(networkModuleSubscriptionId, networkModuleResourceGroup)
  params: {
    clusterName: deploymentClusterName
    location: location
    tags: resourceTags
    createVnet: createVnet
    vnetName: networkModuleVnetName
    vnetAddressSpace: vnetAddressSpace
    aksSubnetName: aksSubnetName
    aksSubnetPrefix: aksSubnetPrefix
    aksSubnetNetworkSecurityGroupId: existingAksSubnetNetworkSecurityGroupId
    createPrivateEndpointsSubnet: createPrivateEndpointsSubnet
    privateEndpointsSubnetName: privateEndpointsSubnetName
    privateEndpointsSubnetPrefix: privateEndpointsSubnetPrefix
    createPostgresSubnet: createPostgresSubnet
    postgresSubnetName: postgresSubnetName
    postgresSubnetPrefix: postgresSubnetPrefix
  }
}

var effectiveVnetId = createNetworkSubnets ? networkModuleVnetId : (useExistingSubnets ? vnetIdFromExistingAksSubnet : '')
var effectiveAksSubnetId = createNetworkSubnets
  ? '${networkModuleVnetId}/subnets/${aksSubnetName}'
  : (useExistingSubnets ? existingAksSubnetId : '')
var effectivePrivateEndpointsSubnetId = createNetworkSubnets && createPrivateEndpointsSubnet
  ? '${networkModuleVnetId}/subnets/${privateEndpointsSubnetName}'
  : existingPrivateEndpointsSubnetId
var effectivePostgresSubnetId = createNetworkSubnets && createPostgresSubnet
  ? '${networkModuleVnetId}/subnets/${postgresSubnetName}'
  : existingPostgresSubnetId
var effectivePrivateDnsVnetId = !empty(privateDnsVnetId) ? privateDnsVnetId : effectiveVnetId
var effectivePrivateDnsVnetScopeId = !empty(privateDnsVnetId)
  ? privateDnsVnetId
  : (createNetworkSubnets
      ? networkModuleVnetId
      : (useExistingSubnets ? vnetIdFromExistingAksSubnet : ''))
var privateDnsUsesCreatedVnet = !empty(createPrivateDnsZonesFor) && empty(privateDnsVnetId) && createVnet
var effectiveAksVnetScopeId = createNetworkSubnets
  ? networkModuleVnetId
  : (useExistingSubnets ? vnetIdFromExistingAksSubnet : '')

// Role-assignment module scopes must be known before deployment. Derive the
// effective subnet coordinates from parameters rather than module outputs.
var aksNetworkRoleSubscriptionId = createVnet
  ? subscription().subscriptionId
  : (createSubnetsInExistingVnet
      ? providedVnetSubscriptionId
      : (useExistingSubnets && length(existingAksSubnetSegments) > 10
          ? existingAksSubnetSegments[2]
          : subscription().subscriptionId))
var aksNetworkRoleResourceGroup = createVnet
  ? resourceGroup().name
  : (createSubnetsInExistingVnet
      ? providedVnetResourceGroup
      : (useExistingSubnets && length(existingAksSubnetSegments) > 10
          ? existingAksSubnetSegments[4]
          : resourceGroup().name))
var aksNetworkRoleVnetName = createVnet
  ? networkModuleVnetName
  : (createSubnetsInExistingVnet
      ? providedVnetName
      : (useExistingSubnets && length(existingAksSubnetSegments) > 10 ? existingAksSubnetSegments[8] : ''))
var aksNetworkRoleSubnetName = createNetworkSubnets
  ? aksSubnetName
  : (useExistingSubnets && length(existingAksSubnetSegments) > 10 ? existingAksSubnetSegments[10] : '')

module privateDns 'modules/private-dns.bicep' = if (!empty(createPrivateDnsZonesFor)) {
  name: '${validatedClusterName}-private-dns'
  params: {
    clusterName: deploymentClusterName
    tags: resourceTags
    vnetId: effectivePrivateDnsVnetId
    createZonesFor: createPrivateDnsZonesFor
  }
}

var createdPrivateDnsZoneIds = {
  blob: contains(createPrivateDnsZonesFor, 'blob')
    ? resourceId('Microsoft.Network/privateDnsZones', 'privatelink.blob.${environment().suffixes.storage}')
    : ''
  keyVault: contains(createPrivateDnsZonesFor, 'keyVault')
    ? resourceId('Microsoft.Network/privateDnsZones', 'privatelink.vaultcore.azure.net')
    : ''
  acr: contains(createPrivateDnsZonesFor, 'acr')
    ? resourceId('Microsoft.Network/privateDnsZones', 'privatelink.azurecr.io')
    : ''
  eventHubs: contains(createPrivateDnsZonesFor, 'eventHubs')
    ? resourceId('Microsoft.Network/privateDnsZones', 'privatelink.servicebus.windows.net')
    : ''
  redis: contains(createPrivateDnsZonesFor, 'redis')
    ? resourceId('Microsoft.Network/privateDnsZones', 'privatelink.redis.azure.net')
    : ''
  postgres: contains(createPrivateDnsZonesFor, 'postgres')
    ? resourceId('Microsoft.Network/privateDnsZones', 'private.postgres.database.azure.com')
    : ''
}
var effectivePrivateDnsZoneIds = {
  blob: !empty(createdPrivateDnsZoneIds.blob) ? createdPrivateDnsZoneIds.blob : existingPrivateDnsZoneIds.blob
  keyVault: !empty(createdPrivateDnsZoneIds.keyVault)
    ? createdPrivateDnsZoneIds.keyVault
    : existingPrivateDnsZoneIds.keyVault
  acr: !empty(createdPrivateDnsZoneIds.acr) ? createdPrivateDnsZoneIds.acr : existingPrivateDnsZoneIds.acr
  eventHubs: !empty(createdPrivateDnsZoneIds.eventHubs)
    ? createdPrivateDnsZoneIds.eventHubs
    : existingPrivateDnsZoneIds.eventHubs
  redis: !empty(createdPrivateDnsZoneIds.redis) ? createdPrivateDnsZoneIds.redis : existingPrivateDnsZoneIds.redis
  postgres: !empty(createdPrivateDnsZoneIds.postgres)
    ? createdPrivateDnsZoneIds.postgres
    : existingPrivateDnsZoneIds.postgres
}
var useExistingPrivateDnsZones = !empty(effectivePrivateDnsZoneIds.blob) || !empty(
  effectivePrivateDnsZoneIds.keyVault
) || !empty(effectivePrivateDnsZoneIds.acr) || !empty(effectivePrivateDnsZoneIds.eventHubs) || !empty(
  effectivePrivateDnsZoneIds.redis
) || !empty(effectivePrivateDnsZoneIds.postgres)
var existingPrivateDnsReferences = [
  {
    service: 'blob'
    id: existingPrivateDnsZoneIds.blob
    expectedName: 'privatelink.blob.${environment().suffixes.storage}'
  }
  {
    service: 'keyVault'
    id: existingPrivateDnsZoneIds.keyVault
    expectedName: 'privatelink.vaultcore.azure.net'
  }
  {
    service: 'acr'
    id: existingPrivateDnsZoneIds.acr
    expectedName: 'privatelink.azurecr.io'
  }
  {
    service: 'eventHubs'
    id: existingPrivateDnsZoneIds.eventHubs
    expectedName: 'privatelink.servicebus.windows.net'
  }
  {
    service: 'redis'
    id: existingPrivateDnsZoneIds.redis
    expectedName: 'privatelink.redis.azure.net'
  }
  {
    service: 'postgres'
    id: existingPrivateDnsZoneIds.postgres
    expectedName: 'private.postgres.database.azure.com'
  }
]
var parsedExistingPrivateDnsReferences = map(existingPrivateDnsReferences, reference => {
  service: reference.service
  id: reference.id
  expectedName: reference.expectedName
  type: length(split(reference.id, '/')) > 8
    ? '${toLower(split(reference.id, '/')[6])}/${toLower(split(reference.id, '/')[7])}'
    : ''
  name: length(split(reference.id, '/')) > 8 ? toLower(split(reference.id, '/')[8]) : ''
})
var invalidExistingPrivateDnsReferences = filter(
  parsedExistingPrivateDnsReferences,
  reference => !contains(createPrivateDnsZonesFor, reference.service) && !empty(reference.id) && (reference.type != 'microsoft.network/privatednszones' || reference.name != reference.expectedName)
)

// ---------------------------------------------------------------------------
// AKS control-plane identity and network grant
// ---------------------------------------------------------------------------

module aksIdentity 'modules/aks-identity.bicep' = if (configureAksControlPlaneIdentity && createAksControlPlaneIdentity) {
  name: '${validatedClusterName}-aks-identity'
  scope: resourceGroup(workloadSubscriptionId, workloadResourceGroupName)
  params: {
    clusterName: deploymentClusterName
    location: location
    tags: resourceTags
  }
}

resource existingAksIdentity 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' existing = if (configureAksControlPlaneIdentity && !createAksControlPlaneIdentity) {
  name: existingAksIdentityName
  scope: resourceGroup(existingAksIdentitySubscriptionId, existingAksIdentityResourceGroup)
}

var createdAksIdentityId = resourceId(
  workloadSubscriptionId,
  workloadResourceGroupName,
  'Microsoft.ManagedIdentity/userAssignedIdentities',
  '${validatedClusterName}-identity'
)
var effectiveAksIdentityId = configureAksControlPlaneIdentity
  ? (createAksControlPlaneIdentity ? createdAksIdentityId : existingAksIdentity!.id)
  : ''
var effectiveAksIdentityPrincipalId = configureAksControlPlaneIdentity
  ? (createAksControlPlaneIdentity
      ? aksIdentity!.outputs.principalId
      : existingAksIdentity!.properties.principalId)
  : ''

var effectiveAksIdentitySubscriptionId = createAksControlPlaneIdentity
  ? workloadSubscriptionId
  : existingAksIdentitySubscriptionId
var effectiveAksIdentityResourceGroup = createAksControlPlaneIdentity
  ? workloadResourceGroupName
  : existingAksIdentityResourceGroup
var effectiveAksIdentityName = createAksControlPlaneIdentity
  ? '${validatedClusterName}-identity'
  : existingAksIdentityName

module aksNetworkRole 'modules/network-role.bicep' = if (!noAksNetwork && ((assignAksNetworkRole && configureAksControlPlaneIdentity) || assignAksVnetReaderRole)) {
  name: '${validatedClusterName}-network-role'
  scope: resourceGroup(aksNetworkRoleSubscriptionId, aksNetworkRoleResourceGroup)
  params: {
    vnetName: aksNetworkRoleVnetName
    subnetName: aksNetworkRoleSubnetName
    subnetId: effectiveAksSubnetId
    principalId: effectiveAksIdentityPrincipalId
    identityId: effectiveAksIdentityId
    assignNetworkContributorRole: assignAksNetworkRole
    readerPrincipalIds: effectiveMainDeployerPrincipalIds
    readerPrincipalType: effectiveMainDeployerPrincipalType
    assignVnetReaderRole: assignAksVnetReaderRole
  }
}

module aksIdentityAccessRole 'modules/identity-fic-role.bicep' = if ((assignAksIdentityOperatorRole || assignAksIdentityReaderRole) && configureAksControlPlaneIdentity && !empty(effectiveMainDeployerPrincipalIds)) {
  name: '${validatedClusterName}-aks-identity-access'
  scope: resourceGroup(effectiveAksIdentitySubscriptionId, effectiveAksIdentityResourceGroup)
  params: {
    identityName: effectiveAksIdentityName
    principalIds: effectiveMainDeployerPrincipalIds
    principalType: effectiveMainDeployerPrincipalType
    assignFederatedIdentityRole: false
    assignOperatorRole: assignAksIdentityOperatorRole
    assignReaderRole: assignAksIdentityReaderRole
  }
  dependsOn: [
    aksIdentity
  ]
}

// ---------------------------------------------------------------------------
// External DNS: identity, zone, zone-scoped grant
// ---------------------------------------------------------------------------

// The identity external-dns runs as. It lives HERE, next to the zone, because
// its DNS Zone Contributor grant is the privileged piece; the Rulebricks CLI
// only ever adds a federated credential to it (see cliPrincipalIds).
// NO federated credentials here: the trust between the identity and a
// Kubernetes ServiceAccount is namespace-scoped and per-deployment,
// unknowable at prerequisites time.
resource externalDnsIdentity 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' = if (createExternalDnsResources) {
  name: '${validatedClusterName}-external-dns'
  location: location
  tags: resourceTags
}

// Delegated-subdomain model: this zone hosts the Rulebricks subdomain. Hand
// the nameServers output to whoever controls the parent domain for a one-time
// NS delegation; from then on external-dns manages every record and Let's
// Encrypt HTTP-01 issues certificates with no further DNS involvement.
resource dnsZone 'Microsoft.Network/dnsZones@2018-05-01' = if (createExternalDnsResources) {
  name: dnsZoneName
  location: 'global'
  tags: resourceTags
}

resource existingExternalDnsIdentity 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' existing = if (!createExternalDnsResources && useExternalDns) {
  name: existingExternalDnsIdentityName
  scope: resourceGroup(
    existingExternalDnsIdentitySubscriptionId,
    existingExternalDnsIdentityResourceGroup
  )
}

resource existingDnsZone 'Microsoft.Network/dnsZones@2018-05-01' existing = if (!createExternalDnsResources && useExternalDns) {
  name: existingDnsZoneName
  scope: resourceGroup(existingDnsZoneSubscriptionId, existingDnsZoneResourceGroup)
}

var effectiveExternalDnsIdentityId = createExternalDnsResources
  ? externalDnsIdentity!.id
  : (useExternalDns ? existingExternalDnsIdentity!.id : '')
var effectiveExternalDnsIdentityPrincipalId = createExternalDnsResources
  ? externalDnsIdentity!.properties.principalId
  : (useExternalDns ? existingExternalDnsIdentity!.properties.principalId : '')
var effectiveExternalDnsIdentityName = createExternalDnsResources
  ? externalDnsIdentity!.name
  : (useExternalDns ? existingExternalDnsIdentity!.name : '')
var effectiveExternalDnsIdentitySubscriptionId = createExternalDnsResources
  ? subscription().subscriptionId
  : existingExternalDnsIdentitySubscriptionId
var effectiveExternalDnsIdentityResourceGroup = createExternalDnsResources
  ? resourceGroup().name
  : existingExternalDnsIdentityResourceGroup

var allowedPrivateDnsServices = [
  'blob'
  'keyVault'
  'acr'
  'eventHubs'
  'redis'
  'postgres'
]

var providedVnetType = length(providedVnetSegments) > 8
  ? '${toLower(providedVnetSegments[6])}/${toLower(providedVnetSegments[7])}'
  : ''
var autoDetectedOperatorPrincipalIds = [
  deployer().objectId
]
var commonOperatorPrincipalIds = !empty(operatorPrincipalIds)
  ? operatorPrincipalIds
  : (!empty(deployerPrincipalIds) ? deployerPrincipalIds : autoDetectedOperatorPrincipalIds)
var commonOperatorPrincipalType = !empty(operatorPrincipalIds)
  ? operatorPrincipalType
  : (!empty(deployerPrincipalIds)
      ? deployerPrincipalType
      : (!empty(deployer().userPrincipalName) ? 'User' : 'ServicePrincipal'))
var effectivePrerequisiteDeployerPrincipalIds = !empty(prerequisiteDeployerPrincipalIds)
  ? prerequisiteDeployerPrincipalIds
  : commonOperatorPrincipalIds
var effectiveMainDeployerPrincipalIds = !empty(mainDeployerPrincipalIds)
  ? mainDeployerPrincipalIds
  : commonOperatorPrincipalIds
var effectiveMainDeployerPrincipalType = !empty(mainDeployerPrincipalIds)
  ? mainDeployerPrincipalType
  : commonOperatorPrincipalType
var effectiveCliPrincipalIds = !empty(cliPrincipalIds) ? cliPrincipalIds : commonOperatorPrincipalIds
var effectiveCliPrincipalType = !empty(cliPrincipalIds) ? cliPrincipalType : commonOperatorPrincipalType
var createsAksIdentityOutsidePrerequisitesGroup = configureAksControlPlaneIdentity && createAksControlPlaneIdentity && toLower(
  workloadResourceGroupId
) != toLower(resourceGroup().id)
var requiresPrerequisiteDeployerPrincipalIds = useExistingSubnets || createSubnetsInExistingVnet || (!empty(
  createPrivateDnsZonesFor
) && !privateDnsUsesCreatedVnet) || createsAksIdentityOutsidePrerequisitesGroup
var requiresMainDeployerPrincipalIds = !noAksNetwork || configureAksControlPlaneIdentity || useExternalDns || !empty(
  effectivePrivateEndpointsSubnetId
) || !empty(effectivePostgresSubnetId) || useExistingPrivateDnsZones
var requiresCliPrincipalIds = useExternalDns || useManagedEmail

var configurationErrors = [
  workloadResourceGroupType == 'subscriptions/resourcegroups'
    ? ''
    : 'workloadResourceGroupId must be a full resource group ID.'
  !useExistingSubnets || existingAksSubnetType == 'microsoft.network/virtualnetworks/subnets'
    ? ''
    : 'existingAksSubnetId must be a full subnet resource ID in existingSubnets mode.'
  empty(existingPrivateEndpointsSubnetId) || existingPrivateEndpointsSubnetType == 'microsoft.network/virtualnetworks/subnets'
    ? ''
    : 'existingPrivateEndpointsSubnetId must reference a subnet.'
  empty(existingPostgresSubnetId) || existingPostgresSubnetType == 'microsoft.network/virtualnetworks/subnets'
    ? ''
    : 'existingPostgresSubnetId must reference a subnet.'
  empty(existingAksSubnetNetworkSecurityGroupId) || existingAksSubnetNsgType == 'microsoft.network/networksecuritygroups'
    ? ''
    : 'existingAksSubnetNetworkSecurityGroupId must reference a network security group.'
  !createSubnetsInExistingVnet || providedVnetType == 'microsoft.network/virtualnetworks'
    ? ''
    : 'existingVnetId must be a full VNet resource ID in createSubnetsInExistingVnet mode.'
  noAksNetwork || toLower(effectiveAksNetworkSubscriptionId) == toLower(workloadSubscriptionId)
    ? ''
    : 'The AKS VNet/subnet and workload resource group must be in the same subscription.'
  !configureAksControlPlaneIdentity || createAksControlPlaneIdentity || existingAksIdentityType == 'microsoft.managedidentity/userassignedidentities'
    ? ''
    : 'existingAksControlPlaneIdentityId must reference a user-assigned identity when the AKS identity is referenced.'
  createExternalDnsResources
    ? (empty(dnsZoneName) ? 'dnsZoneName is required when creating external DNS resources.' : '')
    : (empty(existingDnsZoneId) == empty(existingExternalDnsIdentityId)
        ? ''
        : 'Supply both existingDnsZoneId and existingExternalDnsIdentityId, or neither.')
  createExternalDnsResources || empty(existingDnsZoneId) || existingDnsZoneType == 'microsoft.network/dnszones'
    ? ''
    : 'existingDnsZoneId must reference Microsoft.Network/dnsZones.'
  createExternalDnsResources || empty(existingExternalDnsIdentityId) || existingExternalDnsIdentityType == 'microsoft.managedidentity/userassignedidentities'
    ? ''
    : 'existingExternalDnsIdentityId must reference a user-assigned identity.'
  !createAcsEmail || empty(existingCommunicationServiceId)
    ? ''
    : 'createAcsEmail and existingCommunicationServiceId are mutually exclusive.'
  !createAcsEmail || !empty(acsSmtpEntraApplicationId)
    ? ''
    : 'acsSmtpEntraApplicationId is required when createAcsEmail is true.'
  empty(existingCommunicationServiceId) || existingCommunicationServiceType == 'microsoft.communication/communicationservices'
    ? ''
    : 'existingCommunicationServiceId must reference Microsoft.Communication/communicationServices.'
  empty(existingAksPrivateDnsZoneId) || existingAksPrivateDnsZoneType == 'microsoft.network/privatednszones'
    ? ''
    : 'existingAksPrivateDnsZoneId must reference Microsoft.Network/privateDnsZones.'
  empty(filter(createPrivateDnsZonesFor, service => !contains(allowedPrivateDnsServices, service)))
    ? ''
    : 'createPrivateDnsZonesFor contains an unsupported service.'
  empty(invalidExistingPrivateDnsReferences)
    ? ''
    : 'existingPrivateDnsZoneIds.${first(invalidExistingPrivateDnsReferences)!.service} must reference the canonical ${first(invalidExistingPrivateDnsReferences)!.expectedName} private DNS zone.'
  empty(createPrivateDnsZonesFor) || !empty(effectivePrivateDnsVnetScopeId)
    ? ''
    : 'A VNet ID is required when creating private DNS links.'
  !createPrivateEndpointsSubnet || (createNetworkSubnets && !empty(privateEndpointsSubnetPrefix))
    ? ''
    : 'Private-endpoint subnet creation requires a create-network mode and address prefix.'
  !createPostgresSubnet || (createNetworkSubnets && !empty(postgresSubnetPrefix))
    ? ''
    : 'PostgreSQL subnet creation requires a create-network mode and address prefix.'
  !assignAksNetworkRole || (!noAksNetwork && configureAksControlPlaneIdentity)
    ? ''
    : 'assignAksNetworkRole requires both an AKS subnet and control-plane identity.'
  !assignExternalDnsZoneRole || useExternalDns
    ? ''
    : 'assignExternalDnsZoneRole requires external DNS resources.'
  !assignExternalDnsFederatedIdentityRole || (useExternalDns && !empty(effectiveCliPrincipalIds))
    ? ''
    : 'assignExternalDnsFederatedIdentityRole requires external DNS and cliPrincipalIds.'
  !assignAksIdentityOperatorRole || (configureAksControlPlaneIdentity && !empty(effectiveMainDeployerPrincipalIds))
    ? ''
    : 'assignAksIdentityOperatorRole requires an AKS identity and mainDeployerPrincipalIds.'
  !assignAksIdentityReaderRole || (configureAksControlPlaneIdentity && !empty(effectiveMainDeployerPrincipalIds))
    ? ''
    : 'assignAksIdentityReaderRole requires an AKS identity and mainDeployerPrincipalIds.'
  !assignExternalDnsZoneReaderRole || (useExternalDns && !empty(effectiveMainDeployerPrincipalIds))
    ? ''
    : 'assignExternalDnsZoneReaderRole requires external DNS and mainDeployerPrincipalIds.'
  !assignExternalDnsIdentityReaderRole || (useExternalDns && !empty(effectiveMainDeployerPrincipalIds))
    ? ''
    : 'assignExternalDnsIdentityReaderRole requires external DNS and mainDeployerPrincipalIds.'
  !assignCommunicationServiceReaderRole || (useManagedEmail && !empty(effectiveCliPrincipalIds))
    ? ''
    : 'assignCommunicationServiceReaderRole requires ACS and cliPrincipalIds.'
  !assignAksVnetReaderRole || (!noAksNetwork && !empty(effectiveMainDeployerPrincipalIds))
    ? ''
    : 'assignAksVnetReaderRole requires an AKS VNet and mainDeployerPrincipalIds.'
  !assignAksPrivateDnsZoneRole || (configureAksControlPlaneIdentity && existingAksPrivateDnsZoneType == 'microsoft.network/privatednszones')
    ? ''
    : 'assignAksPrivateDnsZoneRole requires an AKS identity and private DNS zone ID.'
  !requiresPrerequisiteDeployerPrincipalIds || !empty(effectivePrerequisiteDeployerPrincipalIds)
    ? ''
    : 'prerequisiteDeployerPrincipalIds is required for beforePrerequisites requirements.'
  !requiresMainDeployerPrincipalIds || !empty(effectiveMainDeployerPrincipalIds)
    ? ''
    : 'mainDeployerPrincipalIds is required for beforeMain requirements.'
  !requiresCliPrincipalIds || !empty(effectiveCliPrincipalIds)
    ? ''
    : 'cliPrincipalIds is required for beforeCliDeploy requirements.'
]
var activeConfigurationErrors = filter(configurationErrors, error => !empty(error))
var validatedClusterName = empty(activeConfigurationErrors)
  ? clusterName
  : fail(first(activeConfigurationErrors) ?? 'Invalid prerequisite configuration.')
var deploymentClusterName = useExistingSubnets || createSubnetsInExistingVnet
  ? (toLower(existingAksVnetForValidation!.location) == toLower(location)
      ? validatedClusterName
      : fail('The AKS VNet and cluster must be in the same Azure region.'))
  : validatedClusterName

module externalDnsRole 'modules/dns-role.bicep' = if ((assignExternalDnsZoneRole || assignExternalDnsZoneReaderRole) && useExternalDns) {
  name: '${validatedClusterName}-external-dns-role'
  scope: resourceGroup(effectiveDnsZoneSubscriptionId, effectiveDnsZoneResourceGroup)
  params: {
    dnsZoneName: effectiveDnsZoneName
    principalId: effectiveExternalDnsIdentityPrincipalId
    assignContributorRole: assignExternalDnsZoneRole
    readerPrincipalIds: effectiveMainDeployerPrincipalIds
    readerPrincipalType: effectiveMainDeployerPrincipalType
    assignReaderRole: assignExternalDnsZoneReaderRole
  }
  dependsOn: [
    dnsZone
  ]
}

module externalDnsFicRole 'modules/identity-fic-role.bicep' = if (assignExternalDnsFederatedIdentityRole && useExternalDns && !empty(effectiveCliPrincipalIds)) {
  name: '${validatedClusterName}-external-dns-fic-role'
  scope: resourceGroup(
    effectiveExternalDnsIdentitySubscriptionId,
    effectiveExternalDnsIdentityResourceGroup
  )
  params: {
    identityName: effectiveExternalDnsIdentityName
    principalIds: effectiveCliPrincipalIds
    principalType: effectiveCliPrincipalType
    assignFederatedIdentityRole: true
    assignOperatorRole: false
  }
}

module externalDnsIdentityReader 'modules/identity-fic-role.bicep' = if (assignExternalDnsIdentityReaderRole && useExternalDns && !empty(effectiveMainDeployerPrincipalIds)) {
  name: '${validatedClusterName}-external-dns-identity-reader'
  scope: resourceGroup(
    effectiveExternalDnsIdentitySubscriptionId,
    effectiveExternalDnsIdentityResourceGroup
  )
  params: {
    identityName: effectiveExternalDnsIdentityName
    principalIds: effectiveMainDeployerPrincipalIds
    principalType: effectiveMainDeployerPrincipalType
    assignFederatedIdentityRole: false
    assignOperatorRole: false
    assignReaderRole: true
  }
}

module aksPrivateDnsRole 'modules/private-dns-role.bicep' = if (assignAksPrivateDnsZoneRole && configureAksControlPlaneIdentity && !empty(existingAksPrivateDnsZoneId)) {
  name: '${validatedClusterName}-aks-private-dns-role'
  scope: resourceGroup(existingAksPrivateDnsZoneSubscriptionId, existingAksPrivateDnsZoneResourceGroup)
  params: {
    privateDnsZoneName: existingAksPrivateDnsZoneName
    principalId: effectiveAksIdentityPrincipalId
    identityId: effectiveAksIdentityId
  }
}

// ---------------------------------------------------------------------------
// Email: service and sender domains
// ---------------------------------------------------------------------------

// Azure Communication Services Email: Microsoft's recommended replacement for
// retired basic-auth SMTP in Exchange Online. It still PRESENTS plain SMTP
// (smtp.azurecomm.net:587) but authenticates with Entra application
// credentials. Every ACS resource lives here, not in main.bicep: creating them
// is restricted in many tenants, and the sender domains carry verification
// state that outlives any single deployment.
resource emailService 'Microsoft.Communication/emailServices@2023-04-01' = if (createAcsEmail) {
  name: emailServiceName
  location: 'global'
  tags: resourceTags
  properties: {
    dataLocation: emailDataLocation
  }
}

// Azure-managed sender domain: instantly verified, sends as
// DoNotReply@<guid>.azurecomm.net. The working fallback sender while (or
// instead of) a branded domain.
resource managedDomain 'Microsoft.Communication/emailServices/domains@2023-04-01' = if (createAcsEmail) {
  parent: emailService
  name: 'AzureManagedDomain'
  location: 'global'
  tags: resourceTags
  properties: {
    domainManagement: 'AzureManaged'
    userEngagementTracking: 'Disabled'
  }
}

// Branded sender domain. Created unverified; the initiate-verification output
// commands start the DNS checks against the records below. The sender is the
// domain's built-in DoNotReply MailFrom - additional sender usernames
// (notifications@, support@, ...) require an ACS sending-limit increase and
// are out of scope.
resource brandedDomain 'Microsoft.Communication/emailServices/domains@2023-04-01' = if (hasBrandedDomain) {
  parent: emailService
  name: emailSenderDomain
  location: 'global'
  tags: resourceTags
  properties: {
    domainManagement: 'CustomerManaged'
    userEngagementTracking: 'Disabled'
  }
}

// Verification records, written straight into the delegated zone. Domain and
// SPF are both TXT values at the same zone-relative name, so they share one
// record set; the two DKIM CNAMEs use ACS's fixed selector names.
resource verificationTxt 'Microsoft.Network/dnsZones/TXT@2018-05-01' = if (createDnsRecords) {
  parent: dnsZone
  name: brandedDomainLabel == '' ? '@' : brandedDomainLabel
  properties: {
    TTL: 3600
    TXTRecords: [
      {
        value: [
          brandedDomain!.properties.verificationRecords.Domain.value
        ]
      }
      {
        value: [
          brandedDomain!.properties.verificationRecords.SPF.value
        ]
      }
    ]
  }
}

resource dkim1Cname 'Microsoft.Network/dnsZones/CNAME@2018-05-01' = if (createDnsRecords) {
  parent: dnsZone
  name: brandedDomainLabel == '' ? dkimSelector1 : '${dkimSelector1}.${brandedDomainLabel}'
  properties: {
    TTL: 3600
    CNAMERecord: {
      cname: brandedDomain!.properties.verificationRecords.DKIM.value
    }
  }
}

resource dkim2Cname 'Microsoft.Network/dnsZones/CNAME@2018-05-01' = if (createDnsRecords) {
  parent: dnsZone
  name: brandedDomainLabel == '' ? dkimSelector2 : '${dkimSelector2}.${brandedDomainLabel}'
  properties: {
    TTL: 3600
    CNAMERecord: {
      cname: brandedDomain!.properties.verificationRecords.DKIM2.value
    }
  }
}

// The resource the application actually authenticates against: SMTP
// credentials are Entra app credentials scoped to THIS communication service,
// and its name is the first segment of the SMTP username. Sender domains are
// linked into it, which is why it lives alongside them - linking is a write on
// the communication service, and main.bicep is deliberately read-only here.
//
// Evaluated at DEPLOYMENT time against the domain's live state. ACS refuses to
// link a domain until all four checks read Verified, and verification is a
// POST action ARM cannot perform, so a first deployment almost always lands
// here with the branded domain unlinked: the deployment succeeds and the
// azurecomm.net fallback sends. The link is made afterwards, by the CLI at
// deploy time or by emailLinkBrandedDomainCommand. Re-reading the live state
// here is what makes a later redeploy agree with that instead of unlinking it.
//
// Reference this ONLY inside a hasBrandedDomain-guarded ternary. ARM's if()
// evaluates just the branch it returns, but and() evaluates every argument, so
// folding the guard into this expression would run reference() against a
// domain resource that a senderless deployment never created.
var brandedVerified = brandedDomain!.properties.verificationStates.Domain.status == 'Verified' && brandedDomain!.properties.verificationStates.SPF.status == 'Verified' && brandedDomain!.properties.verificationStates.DKIM.status == 'Verified' && brandedDomain!.properties.verificationStates.DKIM2.status == 'Verified'

resource communicationService 'Microsoft.Communication/communicationServices@2023-04-01' = if (createAcsEmail) {
  name: communicationServiceName
  location: 'global'
  tags: resourceTags
  properties: {
    dataLocation: emailDataLocation
    // The Azure-managed domain is always linked, so email works from the
    // first deployment onward whatever the branded domain's state.
    linkedDomains: hasBrandedDomain
      ? (brandedVerified
          ? [
              managedDomain!.id
              brandedDomain!.id
            ]
          : [
              managedDomain!.id
            ])
      : [
          managedDomain!.id
        ]
  }
}

// The Azure-side SMTP identity. The Entra app and its client secret remain
// directory-owned inputs because subscription Owner/UAA does not grant Entra
// application-management permission.
resource smtpUsername 'Microsoft.Communication/communicationServices/smtpUsernames@2026-03-18' = if (createAcsEmail) {
  parent: communicationService
  name: acsSmtpUsernameResourceName
  properties: {
    entraApplicationId: acsSmtpEntraApplicationId
    tenantId: tenant().tenantId
    username: acsSmtpUsername
  }
}

module communicationServiceReader 'modules/communication-role.bicep' = if (assignCommunicationServiceReaderRole && useManagedEmail && !empty(effectiveCliPrincipalIds)) {
  name: '${validatedClusterName}-communication-reader'
  scope: resourceGroup(
    effectiveCommunicationServiceSubscriptionId,
    effectiveCommunicationServiceResourceGroup
  )
  params: {
    communicationServiceName: effectiveCommunicationServiceName
    readerPrincipalIds: effectiveCliPrincipalIds
    readerPrincipalType: effectiveCliPrincipalType
  }
}

// ---------------------------------------------------------------------------
// Handover grants
// ---------------------------------------------------------------------------

var aksNetworkRoleRequirements = !noAksNetwork && configureAksControlPlaneIdentity
  ? [
      {
        phase: 'beforeMain'
        roleName: 'Network Contributor'
        roleDefinitionId: networkContributorRoleDefinitionId
        principalId: effectiveAksIdentityPrincipalId
        scope: effectiveAksSubnetId
        reason: 'Allow the AKS control-plane identity to read and join its node subnet.'
        assignmentEnabled: assignAksNetworkRole
      }
    ]
  : []
var externalDnsRoleRequirements = useExternalDns
  ? [
      {
        phase: 'beforeMain'
        roleName: 'DNS Zone Contributor'
        roleDefinitionId: dnsZoneContributorRoleDefinitionId
        principalId: effectiveExternalDnsIdentityPrincipalId
        scope: createExternalDnsResources ? dnsZone!.id : existingDnsZone!.id
        reason: 'Allow external-dns to reconcile records in the delegated public zone.'
        assignmentEnabled: assignExternalDnsZoneRole
      }
    ]
  : []
var externalDnsFicRoleRequirements = [
  for principalId in (useExternalDns ? effectiveCliPrincipalIds : []): {
    phase: 'beforeCliDeploy'
    roleName: 'Managed Identity Federated Identity Credential Contributor'
    roleDefinitionId: ficContributorRoleDefinitionId
    principalId: principalId
    scope: effectiveExternalDnsIdentityId
    reason: 'Allow the CLI operator to bind the external-dns Kubernetes service account.'
    assignmentEnabled: assignExternalDnsFederatedIdentityRole
  }
]
var aksIdentityOperatorRequirements = [
  for principalId in (configureAksControlPlaneIdentity ? effectiveMainDeployerPrincipalIds : []): {
    phase: 'beforeMain'
    roleName: 'Managed Identity Operator'
    roleDefinitionId: managedIdentityOperatorRoleDefinitionId
    principalId: principalId
    scope: effectiveAksIdentityId
    reason: 'Allow the main deployment principal to attach the staged identity to AKS when this is not inherited through Contributor.'
    assignmentEnabled: assignAksIdentityOperatorRole
  }
]
var aksIdentityReaderRequirements = [
  for principalId in (configureAksControlPlaneIdentity ? effectiveMainDeployerPrincipalIds : []): {
    phase: 'beforeMain'
    roleName: 'Reader'
    roleDefinitionId: readerRoleDefinitionId
    principalId: principalId
    scope: effectiveAksIdentityId
    reason: 'Allow main to resolve the staged AKS control-plane identity without exposing unrelated resources.'
    assignmentEnabled: assignAksIdentityReaderRole
  }
]
var aksPrivateDnsRoleRequirements = configureAksControlPlaneIdentity && !empty(existingAksPrivateDnsZoneId)
  ? [
      {
        phase: 'beforeMain'
        roleName: 'Private DNS Zone Contributor'
        roleDefinitionId: privateDnsZoneContributorRoleDefinitionId
        principalId: effectiveAksIdentityPrincipalId
        scope: existingAksPrivateDnsZoneId
        reason: 'Allow AKS privateWithExistingDns mode to use the organization-owned private DNS zone.'
        assignmentEnabled: assignAksPrivateDnsZoneRole
      }
    ]
  : []
var privateDnsVnetJoinRequirements = [
  for principalId in (!empty(createPrivateDnsZonesFor) && !privateDnsUsesCreatedVnet
      ? effectivePrerequisiteDeployerPrincipalIds
      : []): {
    phase: 'beforePrerequisites'
    roleName: 'Network Contributor'
    roleDefinitionId: networkContributorRoleDefinitionId
    principalId: principalId
    scope: effectivePrivateDnsVnetScopeId
    reason: 'Allow prerequisite private DNS links to join the selected VNet; an approved custom role with virtualNetworks/join/action is also sufficient.'
    assignmentEnabled: false
  }
]
var workloadResourceGroupContributorRequirements = [
  for principalId in (createsAksIdentityOutsidePrerequisitesGroup
      ? effectivePrerequisiteDeployerPrincipalIds
      : []): {
    phase: 'beforePrerequisites'
    roleName: 'Contributor'
    roleDefinitionId: contributorRoleDefinitionId
    principalId: principalId
    scope: workloadResourceGroupId
    reason: 'Allow prerequisites to deploy the AKS control-plane identity into the separate workload resource group; a custom role with deployment and managed-identity write permissions is also sufficient.'
    assignmentEnabled: false
  }
]
var externalDnsZoneReaderRequirements = [
  for principalId in (useExternalDns ? effectiveMainDeployerPrincipalIds : []): {
    phase: 'beforeMain'
    roleName: 'Reader'
    roleDefinitionId: readerRoleDefinitionId
    principalId: principalId
    scope: createExternalDnsResources ? dnsZone!.id : existingDnsZone!.id
    reason: 'Allow main to resolve the organization-owned public DNS zone without exposing unrelated resources.'
    assignmentEnabled: assignExternalDnsZoneReaderRole
  }
]
var externalDnsIdentityReaderRequirements = [
  for principalId in (useExternalDns ? effectiveMainDeployerPrincipalIds : []): {
    phase: 'beforeMain'
    roleName: 'Reader'
    roleDefinitionId: readerRoleDefinitionId
    principalId: principalId
    scope: effectiveExternalDnsIdentityId
    reason: 'Allow main to resolve the external-dns identity without exposing unrelated resources.'
    assignmentEnabled: assignExternalDnsIdentityReaderRole
  }
]
var communicationServiceReaderRequirements = [
  for principalId in (useManagedEmail ? effectiveCliPrincipalIds : []): {
    phase: 'beforeCliDeploy'
    roleName: 'Reader'
    roleDefinitionId: readerRoleDefinitionId
    principalId: principalId
    scope: effectiveCommunicationServiceId
    reason: 'Allow the CLI to discover the selected SMTP Username and linked sender domains.'
    assignmentEnabled: assignCommunicationServiceReaderRole
  }
]
var prerequisiteAksVnetReaderRequirements = [
  for principalId in (useExistingSubnets ? effectivePrerequisiteDeployerPrincipalIds : []): {
    phase: 'beforePrerequisites'
    roleName: 'Reader'
    roleDefinitionId: readerRoleDefinitionId
    principalId: principalId
    scope: effectiveAksVnetScopeId
    reason: 'Allow prerequisites to validate the organization-owned VNet used by the supplied AKS subnet.'
    assignmentEnabled: false
  }
]
var prerequisiteAksVnetWriterRequirements = [
  for principalId in (createSubnetsInExistingVnet ? effectivePrerequisiteDeployerPrincipalIds : []): {
    phase: 'beforePrerequisites'
    roleName: 'Network Contributor'
    roleDefinitionId: networkContributorRoleDefinitionId
    principalId: principalId
    scope: effectiveAksVnetScopeId
    reason: 'Allow prerequisites to create the approved subnets inside the organization-owned VNet; an approved custom role with subnet read/write is also sufficient.'
    assignmentEnabled: false
  }
]
var mainAksVnetReaderRequirements = [
  for principalId in (!noAksNetwork ? effectiveMainDeployerPrincipalIds : []): {
    phase: 'beforeMain'
    roleName: 'Reader'
    roleDefinitionId: readerRoleDefinitionId
    principalId: principalId
    scope: effectiveAksVnetScopeId
    reason: 'Allow main to validate that the AKS VNet is in the cluster region.'
    assignmentEnabled: assignAksVnetReaderRole
  }
]
var mainPrivateEndpointsSubnetRequirements = [
  for principalId in (!empty(effectivePrivateEndpointsSubnetId) ? effectiveMainDeployerPrincipalIds : []): {
    phase: 'beforeMain'
    roleName: 'Network Contributor'
    roleDefinitionId: networkContributorRoleDefinitionId
    principalId: principalId
    scope: effectivePrivateEndpointsSubnetId
    reason: 'Allow main to join selected private endpoints to the staged subnet; an approved custom subnet read/join role is also sufficient.'
    assignmentEnabled: false
  }
]
var mainPostgresSubnetRequirements = [
  for principalId in (!empty(effectivePostgresSubnetId) ? effectiveMainDeployerPrincipalIds : []): {
    phase: 'beforeMain'
    roleName: 'Network Contributor'
    roleDefinitionId: networkContributorRoleDefinitionId
    principalId: principalId
    scope: effectivePostgresSubnetId
    reason: 'Allow main to deploy PostgreSQL Flexible Server into the staged delegated subnet; an approved custom subnet read/join role is also sufficient.'
    assignmentEnabled: false
  }
]
var privateDnsHandoffZoneIds = filter([
  effectivePrivateDnsZoneIds.blob
  effectivePrivateDnsZoneIds.keyVault
  effectivePrivateDnsZoneIds.acr
  effectivePrivateDnsZoneIds.eventHubs
  effectivePrivateDnsZoneIds.redis
  effectivePrivateDnsZoneIds.postgres
], zoneId => !empty(zoneId))
var mainPrivateDnsZoneRequirements = flatten(
  map(privateDnsHandoffZoneIds, zoneId => map(
    effectiveMainDeployerPrincipalIds,
    principalId => {
      phase: 'beforeMain'
      roleName: 'Private DNS Zone Contributor'
      roleDefinitionId: privateDnsZoneContributorRoleDefinitionId
      principalId: principalId
      scope: zoneId
      reason: 'Allow main to join selected private endpoints or PostgreSQL to this staged private DNS zone.'
      assignmentEnabled: false
    }
  ))
)
var requiredRoleAssignments = concat(
  aksNetworkRoleRequirements,
  externalDnsRoleRequirements,
  externalDnsFicRoleRequirements,
  aksIdentityOperatorRequirements,
  aksIdentityReaderRequirements,
  aksPrivateDnsRoleRequirements,
  privateDnsVnetJoinRequirements,
  workloadResourceGroupContributorRequirements,
  externalDnsZoneReaderRequirements,
  externalDnsIdentityReaderRequirements,
  communicationServiceReaderRequirements,
  prerequisiteAksVnetReaderRequirements,
  prerequisiteAksVnetWriterRequirements,
  mainAksVnetReaderRequirements,
  mainPrivateEndpointsSubnetRequirements,
  mainPostgresSubnetRequirements,
  mainPrivateDnsZoneRequirements
)

// ============================================================================
// OUTPUTS
//
// Save a copy for the main deployment:
//   az deployment group show --name rulebricks-prerequisites -g <rg> \
//     --query properties.outputs
// ============================================================================

@description('True when all cross-parameter validation passed.')
output configurationValidated bool = deploymentClusterName == clusterName

@description('Resource group where this prerequisites deployment ran. Full resource IDs in mainDeploymentParameters remain authoritative for cross-group resources.')
output prerequisitesResourceGroup string = resourceGroup().name

@description('Role requirements for platform review. This reports names, principals, scopes, and timing only; it never emits executable commands or claims that a grant is missing.')
output roleRequirements array = requiredRoleAssignments

@description('Effective VNet resource ID, whether existing or created.')
output vnetId string = effectiveVnetId

@description('Effective AKS node subnet resource ID.')
output aksSubnetId string = effectiveAksSubnetId

@description('Effective private-endpoints subnet resource ID (empty when none is configured).')
output privateEndpointsSubnetId string = effectivePrivateEndpointsSubnetId

@description('Effective PostgreSQL-delegated subnet resource ID (empty when none is configured).')
output postgresSubnetId string = effectivePostgresSubnetId

@description('AKS control-plane identity resource ID. A subnet owner grants this identity Network Contributor before main.bicep runs.')
output aksControlPlaneIdentityId string = effectiveAksIdentityId

@description('AKS control-plane identity principal ID for the platform-team RBAC handoff.')
output aksControlPlaneIdentityPrincipalId string = effectiveAksIdentityPrincipalId

@description('Effective private DNS zone IDs, whether created here or supplied by the organization. Empty values use central policy or disable that integration.')
output privateDnsZoneIds object = effectivePrivateDnsZoneIds

@description('The delegated DNS zone (empty when external DNS is disabled).')
output dnsZoneNameOut string = useExternalDns ? effectiveDnsZoneName : ''

@description('Resource ID of the delegated public DNS zone.')
output dnsZoneId string = useExternalDns
  ? (createExternalDnsResources ? dnsZone!.id : existingDnsZone!.id)
  : ''

@description('Hand these to whoever controls the parent domain: one NS record set for the zone delegating to them, and DNS is done forever.')
output dnsZoneNameServers array = useExternalDns
  ? (createExternalDnsResources ? dnsZone!.properties.nameServers : existingDnsZone!.properties.nameServers)
  : []

@description('Name of the external-dns identity for CLI discovery and platform handoff.')
output externalDnsIdentityName string = useExternalDns ? effectiveExternalDnsIdentityName : ''

@description('Client ID of the external-dns identity.')
output externalDnsClientId string = useExternalDns
  ? (createExternalDnsResources
      ? externalDnsIdentity!.properties.clientId
      : existingExternalDnsIdentity!.properties.clientId)
  : ''

@description('Resource ID of the external-dns identity.')
output externalDnsIdentityId string = effectiveExternalDnsIdentityId

@description('Principal ID of the external-dns identity for the platform-team DNS role handoff.')
output externalDnsIdentityPrincipalId string = effectiveExternalDnsIdentityPrincipalId

@description('The communication service the app authenticates against; its name is also the first segment of the SMTP username the CLI assembles.')
output communicationServiceNameOut string = useManagedEmail ? effectiveCommunicationServiceName : ''

@description('Resource ID of the ACS communication service.')
output communicationServiceId string = useManagedEmail ? effectiveCommunicationServiceId : ''

@description('ACS email service holding the sender domains.')
output emailServiceNameOut string = createAcsEmail ? emailService!.name : ''

@description('The always-verified Azure-managed sender domain.')
output emailFallbackDomainName string = createAcsEmail ? managedDomain!.name : ''

@description('The branded sender domain (empty when none was requested).')
output emailBrandedDomainName string = hasBrandedDomain ? brandedDomain!.name : ''

@description('False while a branded domain is still unverified: the fallback azurecomm.net sender is in use. Verification and linking remain a platform-team prerequisite.')
output emailBrandedDomainLinked bool = hasBrandedDomain ? brandedVerified : true

@description('The address email will send from: the branded domain once verified, otherwise the Azure-managed azurecomm.net one.')
output emailSenderAddress string = createAcsEmail
  ? (hasBrandedDomain
      ? (brandedVerified
          ? 'DoNotReply@${brandedDomain!.properties.fromSenderDomain}'
          : 'DoNotReply@${managedDomain!.properties.fromSenderDomain}')
      : 'DoNotReply@${managedDomain!.properties.fromSenderDomain}')
  : ''

@description('SMTP host and port for the ACS sender.')
output emailSmtpEndpoint string = createAcsEmail ? 'smtp.azurecomm.net:587' : ''

@description('SMTP Username created under the communication service and linked to the approved Entra application.')
output emailSmtpUsername string = createAcsEmail ? smtpUsername!.properties.username : ''

@description('Entra application client ID linked to the SMTP Username.')
output emailSmtpEntraApplicationId string = createAcsEmail ? acsSmtpEntraApplicationId : ''

@description('Branded domain only. Starting verification is a POST action ARM cannot perform. A platform owner runs these once, waits for all four checks, then links the domain.')
output emailInitiateVerificationCommands array = [
  for t in (hasBrandedDomain ? ['Domain', 'SPF', 'DKIM', 'DKIM2'] : []): 'az communication email domain initiate-verification --resource-group ${resourceGroup().name} --email-service-name ${emailServiceName} --domain-name ${emailSenderDomain} --verification-type ${t}'
]

@description('Shows the four verification states; all must read Verified before the branded domain can be linked.')
output emailVerificationStatusCommand string = hasBrandedDomain
  ? 'az communication email domain show --resource-group ${resourceGroup().name} --email-service-name ${emailServiceName} --domain-name ${emailSenderDomain} --query verificationStates'
  : ''

// Both domain IDs are passed because --linked-domains replaces the list rather
// than appending to it; omitting the managed domain would unlink the fallback.
@description('Branded domain only: platform-team command that links the verified domain to the communication service in one call.')
output emailLinkBrandedDomainCommand string = hasBrandedDomain
  ? 'az communication update --name ${communicationServiceName} --resource-group ${resourceGroup().name} --linked-domains ${managedDomain!.id} ${brandedDomain!.id}'
  : ''

@description('Branded domains hosted OUTSIDE the delegated zone: publish these records at your DNS provider before initiating verification.')
output emailVerificationRecords object = hasBrandedDomain && !createDnsRecords
  ? brandedDomain!.properties.verificationRecords
  : {}

@description('Copy these IDs into main parameters. main.bicep performs no network, public-DNS, identity, or ACS creation.')
output mainDeploymentParameters object = {
  existingAksControlPlaneIdentityId: effectiveAksIdentityId
  existingAksSubnetId: effectiveAksSubnetId
  existingAksPrivateDnsZoneId: existingAksPrivateDnsZoneId
  existingPrivateEndpointsSubnetId: effectivePrivateEndpointsSubnetId
  existingPostgresSubnetId: effectivePostgresSubnetId
  privateDnsIntegrationMode: useExistingPrivateDnsZones ? 'existingZones' : 'policy'
  existingPrivateDnsZoneIds: effectivePrivateDnsZoneIds
  useExternalDns: useExternalDns
  existingDnsZoneId: useExternalDns
    ? (createExternalDnsResources ? dnsZone!.id : existingDnsZone!.id)
    : ''
  existingExternalDnsIdentityId: effectiveExternalDnsIdentityId
  useManagedEmail: useManagedEmail
  existingCommunicationServiceId: useManagedEmail ? effectiveCommunicationServiceId : ''
  mainDeployerPrincipalIds: effectiveMainDeployerPrincipalIds
  cliPrincipalIds: effectiveCliPrincipalIds
  cliPrincipalType: effectiveCliPrincipalType
}
