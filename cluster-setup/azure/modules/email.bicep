targetScope = 'resourceGroup'

param clusterName string
param tags object

// ACS data-at-rest region ('United States', 'Europe', ...). Must match the
// email service's: ACS only links domains into a communication service with
// the same data location.
param dataLocation string

// The ACS email service and sender domains are prerequisites (see
// prerequisites.bicep): they carry domain verification, which is org-gated.
// This module only creates the per-deployment communication service and LINKS
// the domains - a write on the communication service that needs nothing more
// than READ access on the domains, so they may live in a resource group the
// deployer cannot modify.
param emailServiceName string
param emailServiceResourceGroup string

// The always-verified Azure-managed domain (DoNotReply@<guid>.azurecomm.net),
// the working fallback sender. '' when the email service has none (an
// organization's own service carrying only their verified domain).
param fallbackDomainName string = 'AzureManagedDomain'

// The branded sender domain, when one was provisioned. Linked - and used as
// the sender - only once ACS reports it fully verified, so an unfinished
// verification degrades to the fallback sender instead of failing the
// deployment.
param brandedDomainName string = ''

// NOTE: SMTP authentication requires an Entra app registration (a Microsoft
// Graph object ARM cannot create) granted access on the communication service
// below. That grant is performed by the Rulebricks CLI at deploy time - the
// same place it creates workload-identity bindings and SSO trust - so this
// module deliberately does NOT take the app's IDs.

var hasFallback = fallbackDomainName != ''
var hasBranded = brandedDomainName != ''

var communicationServiceName = take('rbcomm${uniqueString(resourceGroup().id, clusterName)}', 63)

resource fallbackDomain 'Microsoft.Communication/emailServices/domains@2023-04-01' existing = if (hasFallback) {
  name: '${emailServiceName}/${fallbackDomainName}'
  scope: resourceGroup(emailServiceResourceGroup)
}

resource brandedDomain 'Microsoft.Communication/emailServices/domains@2023-04-01' existing = if (hasBranded) {
  name: '${emailServiceName}/${brandedDomainName}'
  scope: resourceGroup(emailServiceResourceGroup)
}

// Evaluated at DEPLOYMENT time against the domain's live state. ACS requires
// all four states Verified before a domain can be linked. Only ever
// referenced inside hasBranded-guarded ternaries (ARM if() short-circuits;
// and() does not).
var brandedVerified = brandedDomain!.properties.verificationStates.Domain.status == 'Verified' && brandedDomain!.properties.verificationStates.SPF.status == 'Verified' && brandedDomain!.properties.verificationStates.DKIM.status == 'Verified' && brandedDomain!.properties.verificationStates.DKIM2.status == 'Verified'

// Azure Communication Services Email: Microsoft's recommended replacement for
// retired basic-auth SMTP in Exchange Online. It still PRESENTS plain SMTP
// (smtp.azurecomm.net:587) but authenticates with Entra application
// credentials, so GoTrue, the app, and the workers all keep their existing
// SMTP configuration - only the host/username/password change.
resource communicationService 'Microsoft.Communication/communicationServices@2023-04-01' = {
  name: communicationServiceName
  location: 'global'
  tags: tags
  properties: {
    dataLocation: dataLocation
    linkedDomains: hasBranded
      ? (brandedVerified
          ? (hasFallback
              ? [
                  fallbackDomain!.id
                  brandedDomain!.id
                ]
              : [
                  brandedDomain!.id
                ])
          : (hasFallback
              ? [
                  fallbackDomain!.id
                ]
              : []))
      : (hasFallback
          ? [
              fallbackDomain!.id
            ]
          : [])
  }
}

output senderAddress string = hasBranded
  ? (brandedVerified
      ? 'DoNotReply@${brandedDomain!.properties.fromSenderDomain}'
      : (hasFallback ? 'DoNotReply@${fallbackDomain!.properties.fromSenderDomain}' : ''))
  : (hasFallback ? 'DoNotReply@${fallbackDomain!.properties.fromSenderDomain}' : '')
output smtpHost string = 'smtp.azurecomm.net'
output smtpPort int = 587
// The SMTP username is <acs-resource>.<entra-app-client-id>.<tenant-id>. Only
// the ACS resource name comes from the infrastructure; the CLI assembles the
// full username from this plus the Entra app the operator supplies, and the
// password is that app's client secret.
output acsResourceName string = communicationService.name
// False only while a provisioned branded domain has verification pending -
// finish it (see the prerequisites deployment's outputs) and rerun, or let
// `rulebricks deploy` link it automatically once verified.
output brandedDomainLinked bool = hasBranded ? brandedVerified : true
