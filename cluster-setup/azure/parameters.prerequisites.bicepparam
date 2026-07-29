// ============================================================================
// Rulebricks prerequisites parameters
//   Usually deployed by a platform team or requested from one.
// ============================================================================

using 'prerequisites.bicep'

// REQUIRED to match main.bicep's clusterName: the external-dns identity name
// and the default email-service name are derived from it.
param clusterName = 'rulebricks'

// Region for the external-dns identity (DNS zones and ACS are global).
param location = 'eastus'

// Stamped on every resource this deployment creates.
param resourceTags = {
  workload: 'rulebricks'
}

// ---------------------------------------------------------------------------
// DNS (delegated-subdomain model)
// ---------------------------------------------------------------------------
// Creates the zone and the identity external-dns runs as, granted DNS Zone
// Contributor on the zone. Hand the dnsZoneNameServers output to whoever
// controls the parent domain for a ONE-TIME NS delegation.

param enableExternalDns = true

// REQUIRED: the deployment's subdomain, e.g. 'rb.corp.com'.
param dnsZoneName = ''

// ---------------------------------------------------------------------------
// Email (Azure Communication Services)
// ---------------------------------------------------------------------------
// Creates the ACS email service and its sender domains. The per-deployment
// communication service is created by main.bicep.

param enableManagedEmail = true

// ACS data-at-rest region; main.bicep's emailDataLocation must match.
param emailDataLocation = 'United States'

// Optional branded sender domain, normally dnsZoneName or a subdomain of it
// (e.g. 'rb.corp.com' -> DoNotReply@rb.corp.com). The verification records
// are written into the zone automatically; after deploying, run the
// emailInitiateVerificationCommands outputs once and wait for Verified
// (emailVerificationStatusCommand) before running main.bicep.
// Empty = only the instantly-working Azure-managed azurecomm.net sender.
param emailSenderDomain = ''

// ---------------------------------------------------------------------------
// Handover
// ---------------------------------------------------------------------------

// Object IDs of whoever runs main.bicep and the Rulebricks CLI, when that is
// NOT the account deploying this template (object ID:
// `az ad signed-in-user show --query id -o tsv`). Each is granted Reader on
// this resource group plus federated-credential write on the external-dns
// identity - everything the main deployment needs here. Leave empty when the
// same account deploys both templates.
param deployerPrincipalIds = []
param deployerPrincipalType = 'User'
