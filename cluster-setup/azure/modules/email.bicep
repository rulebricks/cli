targetScope = 'resourceGroup'

param clusterName string
param tags object

// ACS data-at-rest region ('United States', 'Europe', ...). Independent of
// the resource-group region; ACS resources themselves are global.
param dataLocation string

// NOTE: SMTP authentication requires an Entra app registration (a Microsoft
// Graph object ARM cannot create) granted Contributor on the communication
// service below. That grant is performed by the Rulebricks CLI at deploy
// time - the same place it creates workload-identity bindings and SSO trust -
// so this module deliberately does NOT take the app's IDs. That keeps email a
// single-deploy, CLI-configured concern, exactly like SSO, with no
// parameter-file round-trip.

// Branded sender domain (e.g. rb.corp.com or mail.rb.corp.com), typically the
// deployment's delegated DNS zone or a subdomain of it. Empty = send from the
// instantly-verified Azure-managed domain (DoNotReply@<guid>.azurecomm.net).
param customDomain string = ''

// The delegated DNS zone in THIS resource group, when the custom domain sits
// under it: the verification TXT/SPF/DKIM records are then created here
// declaratively, so no external DNS access is ever needed. Empty = the
// operator publishes customDomainVerificationRecords themselves.
param dnsZoneName string = ''

var emailServiceName = take('rbemail${uniqueString(resourceGroup().id, clusterName)}', 63)
var communicationServiceName = take('rbcomm${uniqueString(resourceGroup().id, clusterName)}', 63)

var hasCustomDomain = customDomain != ''
// Records are only creatable here when the custom domain is the zone apex or
// a subdomain of the zone this deployment owns.
var createDnsRecords = hasCustomDomain && dnsZoneName != '' && (customDomain == dnsZoneName || endsWith(customDomain, '.${dnsZoneName}'))
// Record names are zone-relative: '' (apex) or the label prefix.
var customDomainLabel = customDomain == dnsZoneName
  ? ''
  : substring(customDomain, 0, length(customDomain) - length(dnsZoneName) - 1)
// ACS DKIM selectors are fixed product-wide constants; using them as static
// record names keeps runtime references out of resource names.
var dkimSelector1 = 'selector1-azurecomm-prod-net._domainkey'
var dkimSelector2 = 'selector2-azurecomm-prod-net._domainkey'

// Azure Communication Services Email: Microsoft's recommended replacement for
// retired basic-auth SMTP in Exchange Online. It still PRESENTS plain SMTP
// (smtp.azurecomm.net:587) but authenticates with Entra application
// credentials, so GoTrue, the app, and the workers all keep their existing
// SMTP configuration - only the host/username/password change.
resource emailService 'Microsoft.Communication/emailServices@2023-04-01' = {
  name: emailServiceName
  location: 'global'
  tags: tags
  properties: {
    dataLocation: dataLocation
  }
}

// Azure-managed sender domain: instantly verified, sends as
// DoNotReply@<guid>.azurecomm.net. Swap for a customer-verified custom domain
// (domainManagement: 'CustomerManaged' + DNS TXT/SPF/DKIM records) when
// branded sender addresses are required.
resource managedDomain 'Microsoft.Communication/emailServices/domains@2023-04-01' = {
  parent: emailService
  name: 'AzureManagedDomain'
  location: 'global'
  tags: tags
  properties: {
    domainManagement: 'AzureManaged'
    userEngagementTracking: 'Disabled'
  }
}

// Branded sender domain. Unverified at creation; the operator runs the
// initiate-verification output commands once, ACS checks the DNS records
// below, and any later redeploy (same command, no edits) links it: the
// verification state is read at deployment time. The sender is the domain's
// built-in DoNotReply MailFrom - additional sender usernames (notifications@,
// support@, ...) require an ACS sending-limit increase and are out of scope.
resource customDomainRes 'Microsoft.Communication/emailServices/domains@2023-04-01' = if (hasCustomDomain) {
  parent: emailService
  name: customDomain
  location: 'global'
  tags: tags
  properties: {
    domainManagement: 'CustomerManaged'
    userEngagementTracking: 'Disabled'
  }
}

// Evaluated at DEPLOYMENT time against the domain's live state; false on the
// first pass, true on any redeploy after verification completes. ACS
// requires all four states Verified before a domain can be linked. Only ever
// referenced inside hasCustomDomain-guarded ternaries (ARM if() short-
// circuits; and() does not).
var customDomainVerified = customDomainRes!.properties.verificationStates.Domain.status == 'Verified' && customDomainRes!.properties.verificationStates.SPF.status == 'Verified' && customDomainRes!.properties.verificationStates.DKIM.status == 'Verified' && customDomainRes!.properties.verificationStates.DKIM2.status == 'Verified'

// Verification records, written straight into the delegated zone. Domain and
// SPF are both TXT values at the same zone-relative name, so they share one
// record set; the two DKIM CNAMEs use ACS's fixed selector names.
resource verificationTxt 'Microsoft.Network/dnsZones/TXT@2018-05-01' = if (createDnsRecords) {
  name: '${dnsZoneName == '' ? 'placeholder.invalid' : dnsZoneName}/${customDomainLabel == '' ? '@' : customDomainLabel}'
  properties: {
    TTL: 3600
    TXTRecords: [
      {
        value: [
          customDomainRes!.properties.verificationRecords.Domain.value
        ]
      }
      {
        value: [
          customDomainRes!.properties.verificationRecords.SPF.value
        ]
      }
    ]
  }
}

resource dkim1Cname 'Microsoft.Network/dnsZones/CNAME@2018-05-01' = if (createDnsRecords) {
  name: '${dnsZoneName == '' ? 'placeholder.invalid' : dnsZoneName}/${customDomainLabel == '' ? dkimSelector1 : '${dkimSelector1}.${customDomainLabel}'}'
  properties: {
    TTL: 3600
    CNAMERecord: {
      cname: customDomainRes!.properties.verificationRecords.DKIM.value
    }
  }
}

resource dkim2Cname 'Microsoft.Network/dnsZones/CNAME@2018-05-01' = if (createDnsRecords) {
  name: '${dnsZoneName == '' ? 'placeholder.invalid' : dnsZoneName}/${customDomainLabel == '' ? dkimSelector2 : '${dkimSelector2}.${customDomainLabel}'}'
  properties: {
    TTL: 3600
    CNAMERecord: {
      cname: customDomainRes!.properties.verificationRecords.DKIM2.value
    }
  }
}

resource communicationService 'Microsoft.Communication/communicationServices@2023-04-01' = {
  name: communicationServiceName
  location: 'global'
  tags: tags
  properties: {
    dataLocation: dataLocation
    // The managed domain always stays linked (it is the working fallback
    // sender); the custom domain joins automatically once verified.
    linkedDomains: hasCustomDomain
      ? (customDomainVerified
          ? [
              managedDomain.id
              customDomainRes!.id
            ]
          : [
              managedDomain.id
            ])
      : [
          managedDomain.id
        ]
  }
}

output senderAddress string = hasCustomDomain
  ? (customDomainVerified
      ? 'DoNotReply@${customDomain}'
      : 'DoNotReply@${managedDomain.properties.fromSenderDomain}')
  : 'DoNotReply@${managedDomain.properties.fromSenderDomain}'
output smtpHost string = 'smtp.azurecomm.net'
output smtpPort int = 587
// The SMTP username is <acs-resource>.<entra-app-client-id>.<tenant-id>. Only
// the ACS resource name comes from the infrastructure; the CLI assembles the
// full username from this plus the Entra app the operator supplies, and the
// password is that app's client secret.
output acsResourceName string = communicationService.name
// Phase-2 handoff: run these once after the first deploy (verification is a
// POST action ARM cannot perform), wait for Verified on all four checks
// (az communication email domain show), then rerun the SAME deployment - it
// reads the verification state and links the domain automatically.
output initiateVerificationCommands array = [
  for t in (hasCustomDomain ? ['Domain', 'SPF', 'DKIM', 'DKIM2'] : []): 'az communication email domain initiate-verification --resource-group ${resourceGroup().name} --email-service-name ${emailServiceName} --domain-name ${customDomain} --verification-type ${t}'
]
// For custom domains OUTSIDE the delegated zone: publish these records at
// your DNS provider before initiating verification.
output customDomainVerificationRecords object = hasCustomDomain && !createDnsRecords
  ? customDomainRes!.properties.verificationRecords
  : {}
