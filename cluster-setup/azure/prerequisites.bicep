targetScope = 'resourceGroup'

// ============================================================================
// Rulebricks prerequisites: Org-gated resources
//
// Everything here is something a platform/network/messaging team typically
// controls: a public DNS zone (needs a parent-domain NS delegation), the
// managed identity external-dns runs as (needs a role assignment, i.e.
// Microsoft.Authorization write), and the ACS email service with its sender
// domains (branded domains need DNS verification). 
//
// main.bicep consumes these resources by name and only ever READS them, so a
// deployer without any write access to this template's resource group can
// still run the full main deployment. The one deploy-time write the
// Rulebricks CLI performs against a resource here is creating the AKS
// federated credential on the external-dns identity, and this is covered by the
// narrow role that *deployerPrincipalIds* below grants automatically.
//
// Branded sender domains: the DNS verification records are created in the
// zone by this template, but starting verification is a POST action ARM
// cannot perform. After deploying, run the emailInitiateVerificationCommands
// outputs once and wait for Verified on all four checks
// (emailVerificationStatusCommand) before running main.bicep, which links the 
// domain and uses it as the sender.
// ============================================================================

// Must match main.bicep's clusterName: the identity name and the default
// email-service name are derived from it.
param clusterName string = 'rulebricks-cluster'
param location string = resourceGroup().location
param resourceTags object = {
  workload: 'rulebricks'
}

// ---------------------------------------------------------------------------
// DNS (delegated-subdomain model)
// ---------------------------------------------------------------------------

param enableExternalDns bool = true

@description('The deployment subdomain, e.g. rb.corp.com. The dnsZoneNameServers output feeds a one-time NS delegation at the parent domain; afterwards external-dns manages every record.')
param dnsZoneName string = ''

// ---------------------------------------------------------------------------
// Email (Azure Communication Services)
// ---------------------------------------------------------------------------

param enableManagedEmail bool = true

// ACS data-at-rest region ('United States', 'Europe', ...). main.bicep's
// emailDataLocation must match: ACS only links domains to a communication
// service with the same data location.
param emailDataLocation string = 'United States'

// Optional branded sender domain (e.g. rb.corp.com or mail.rb.corp.com),
// normally the zone above or a subdomain of it - verification records are
// then written into the zone here. Empty = only the instantly-verified
// Azure-managed azurecomm.net sender.
param emailSenderDomain string = ''

// ---------------------------------------------------------------------------
// Handover
// ---------------------------------------------------------------------------

// Object IDs of whoever runs main.bicep and the Rulebricks CLI, when that is
// NOT the account deploying this template. Each gets exactly the two grants
// the main deployment needs against these resources: Reader on this resource
// group, and federated-credential write on the external-dns identity. Leave
// empty when the same account deploys both templates.
param deployerPrincipalIds array = []

@allowed([
  'User'
  'Group'
  'ServicePrincipal'
])
param deployerPrincipalType string = 'User'

// ---------------------------------------------------------------------------

var hasBrandedDomain = enableManagedEmail && emailSenderDomain != ''
// Verification records are only creatable here when the branded domain is the
// zone apex or a subdomain of the zone this template owns; otherwise the
// emailVerificationRecords output must be published manually.
var createDnsRecords = hasBrandedDomain && enableExternalDns && dnsZoneName != '' && (emailSenderDomain == dnsZoneName || endsWith(emailSenderDomain, '.${dnsZoneName}'))
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

// Same derivation main.bicep falls back to when emailServiceName is left
// empty, so the default same-resource-group flow needs no name handoff.
var emailServiceName = take('rbemail${uniqueString(resourceGroup().id, clusterName)}', 63)

var readerRoleId = subscriptionResourceId(
  'Microsoft.Authorization/roleDefinitions',
  'acdd72a7-3385-48ef-bd42-f606fba81ae7'
)
// Managed Identity Federated Identity Credential Contributor: FIC write and
// nothing else, scoped to the one identity below.
var ficContributorRoleId = subscriptionResourceId(
  'Microsoft.Authorization/roleDefinitions',
  '7e559ce2-48d7-4b27-9128-fa1b247f1308'
)

// ---------------------------------------------------------------------------
// External DNS: identity, zone, zone-scoped grant
// ---------------------------------------------------------------------------

// The identity external-dns runs as. It lives HERE, next to the zone, because
// its DNS Zone Contributor grant is the privileged piece; the Rulebricks CLI
// only ever adds a federated credential to it (see deployerPrincipalIds).
// NO federated credentials here: the trust between the identity and a
// Kubernetes ServiceAccount is namespace-scoped and per-deployment,
// unknowable at prerequisites time.
resource externalDnsIdentity 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' = if (enableExternalDns) {
  name: '${clusterName}-external-dns'
  location: location
  tags: resourceTags
}

// Delegated-subdomain model: this zone hosts the Rulebricks subdomain. Hand
// the nameServers output to whoever controls the parent domain for a one-time
// NS delegation; from then on external-dns manages every record and Let's
// Encrypt HTTP-01 issues certificates with no further DNS involvement.
resource dnsZone 'Microsoft.Network/dnsZones@2018-05-01' = if (enableExternalDns) {
  name: dnsZoneName
  location: 'global'
  tags: resourceTags
}

// A module because role-assignment names must be deployment-time constants:
// the guid() over the identity's principal ID (kept for parity with
// deployments made before the prerequisites split) only becomes one when
// passed through a module parameter.
module externalDnsRole 'modules/dns-role.bicep' = if (enableExternalDns) {
  name: '${clusterName}-external-dns-role'
  params: {
    dnsZoneName: dnsZoneName
    principalId: externalDnsIdentity!.properties.principalId
  }
  dependsOn: [
    dnsZone
  ]
}

// ---------------------------------------------------------------------------
// Email: service and sender domains
// ---------------------------------------------------------------------------

// Azure Communication Services Email: Microsoft's recommended replacement for
// retired basic-auth SMTP in Exchange Online. It still PRESENTS plain SMTP
// (smtp.azurecomm.net:587) but authenticates with Entra application
// credentials. The communication service itself is per-deployment plumbing
// and is created by main.bicep; only the email service and its domains - the
// part that carries domain verification - live here.
resource emailService 'Microsoft.Communication/emailServices@2023-04-01' = if (enableManagedEmail) {
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
resource managedDomain 'Microsoft.Communication/emailServices/domains@2023-04-01' = if (enableManagedEmail) {
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

// ---------------------------------------------------------------------------
// Handover grants
// ---------------------------------------------------------------------------

// Reader on this resource group: main.bicep resolves the zone, identity, and
// domains as existing resources, and the Rulebricks CLI discovers them - all
// reads.
resource deployerReader 'Microsoft.Authorization/roleAssignments@2022-04-01' = [
  for principalId in deployerPrincipalIds: {
    name: guid(resourceGroup().id, principalId, 'rulebricks-prerequisites-reader')
    properties: {
      roleDefinitionId: readerRoleId
      principalId: principalId
      principalType: deployerPrincipalType
    }
  }
]

// The single write the CLI performs here: creating the AKS federated
// credential on the external-dns identity at deploy time.
resource deployerFicContributor 'Microsoft.Authorization/roleAssignments@2022-04-01' = [
  for principalId in deployerPrincipalIds: if (enableExternalDns) {
    name: guid(externalDnsIdentity.id, principalId, 'rulebricks-fic-contributor')
    scope: externalDnsIdentity
    properties: {
      roleDefinitionId: ficContributorRoleId
      principalId: principalId
      principalType: deployerPrincipalType
    }
  }
]

// ============================================================================
// OUTPUTS
//
// Save a copy for the main deployment:
//   az deployment group show --name rulebricks-prerequisites -g <rg> \
//     --query properties.outputs
// ============================================================================

@description('Resource group holding every prerequisite resource; main.bicep takes it as prerequisitesResourceGroup when different from its own.')
output prerequisitesResourceGroup string = resourceGroup().name

@description('The delegated DNS zone (empty when external DNS is disabled).')
output dnsZoneNameOut string = enableExternalDns ? dnsZoneName : ''

@description('Hand these to whoever controls the parent domain: one NS record set for the zone delegating to them, and DNS is done forever.')
output dnsZoneNameServers array = enableExternalDns ? dnsZone!.properties.nameServers : []

@description('Name of the external-dns identity; main.bicep and the Rulebricks CLI resolve it by this name.')
output externalDnsIdentityName string = enableExternalDns ? externalDnsIdentity!.name : ''

@description('Client ID of the external-dns identity.')
output externalDnsClientId string = enableExternalDns ? externalDnsIdentity!.properties.clientId : ''

@description('ACS email service holding the sender domains; main.bicep takes it as emailServiceName when deploying into a different resource group.')
output emailServiceNameOut string = enableManagedEmail ? emailService!.name : ''

@description('The always-verified Azure-managed sender domain.')
output emailFallbackDomainName string = enableManagedEmail ? managedDomain!.name : ''

@description('The branded sender domain (empty when none was requested); main.bicep takes it as emailBrandedDomainName.')
output emailBrandedDomainName string = hasBrandedDomain ? brandedDomain!.name : ''

@description('Branded domain only: run these once after this deployment (verification is a POST action ARM cannot perform), then wait for Verified on all four checks before running main.bicep.')
output emailInitiateVerificationCommands array = [
  for t in (hasBrandedDomain ? ['Domain', 'SPF', 'DKIM', 'DKIM2'] : []): 'az communication email domain initiate-verification --resource-group ${resourceGroup().name} --email-service-name ${emailServiceName} --domain-name ${emailSenderDomain} --verification-type ${t}'
]

@description('Shows the four verification states; all must read Verified before main.bicep can link the branded domain.')
output emailVerificationStatusCommand string = hasBrandedDomain
  ? 'az communication email domain show --resource-group ${resourceGroup().name} --email-service-name ${emailServiceName} --domain-name ${emailSenderDomain} --query verificationStates'
  : ''

@description('Branded domains hosted OUTSIDE the delegated zone: publish these records at your DNS provider before initiating verification.')
output emailVerificationRecords object = hasBrandedDomain && !createDnsRecords
  ? brandedDomain!.properties.verificationRecords
  : {}

@description('The parameter values main.bicep needs when it deploys into a DIFFERENT resource group than this one. Same-resource-group deployments can omit all of them.')
output mainDeploymentParameters object = {
  prerequisitesResourceGroup: resourceGroup().name
  dnsZoneName: enableExternalDns ? dnsZoneName : ''
  emailServiceName: enableManagedEmail ? emailService!.name : ''
  emailBrandedDomainName: hasBrandedDomain ? emailSenderDomain : ''
}
