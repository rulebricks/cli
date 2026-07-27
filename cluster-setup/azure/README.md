# Azure cluster setup

Provisions a production-ready AKS environment for Rulebricks in a dedicated
resource group. Everything is defined by [main.bicep](main.bicep) and one
parameter file, [parameters.bicepparam](parameters.bicepparam):

| Setting | Default |
| --- | --- |
| AKS | Standard tier, private control plane, Entra ID + Azure RBAC, zones 1-3 |
| Node pools | Dedicated system pool + core pool (D4as_v6) + warm burst pool (1-4 x D16as_v6) |
| PostgreSQL | On: Flexible Server 17, HA, private access |
| Key Vault secret sync | On: private vault, workload identity |
| DNS + TLS | On: delegated-subdomain zone; records and certificates fully automatic |
| Email | On: Azure Communication Services (SMTP-compatible, Entra-app credentials) |
| Monitoring | On: managed Prometheus + Azure Managed Grafana |
| Registry mirror | On: ACR pull-through cache of Rulebricks images (license-key authenticated) |
| Blob storage | ZRS, versioning, soft delete, private endpoint, delete lock |
| Kafka / Redis | Off - the chart runs them in-cluster |

Every tunable parameter lives in the parameter file with a comment. Search it
for `REQUIRED` to find the values you must provide. Names derived from
`uniqueString()` (vault, registry, Postgres server, ...) stay in `main.bicep`
so each resource group gets collision-free names.

## Prerequisites

Work through [PRECHECK.md](PRECHECK.md), a short checklist of the region,
quota, DNS, and identity values to confirm before deploying. Tools: `az`,
`kubectl`, `helm`, and `kubelogin` (Entra RBAC clusters), with a subscription
role that can create resources and role assignments.

## Deploy

Fill in the `REQUIRED` parameters in `parameters.bicepparam`
(`aksAdminPrincipalIds`, `keyVaultWriterPrincipalIds`, `dnsZoneName`, the
email app IDs), then:

```bash
az account set --subscription <subscription-id>
az group create --name rulebricks-rg --location eastus

export RB_POSTGRES_ADMIN_PASSWORD='<strong-password>'   # never stored in a file
export RB_LICENSE_KEY='<license-key>'                   # authenticates the image cache

az deployment group create \
  --name rulebricks \
  --resource-group rulebricks-rg \
  --parameters parameters.bicepparam

az aks get-credentials --name rulebricks-prod --resource-group rulebricks-rg
```

The Kubernetes control plane is private by default: run this deployment and all later
`kubectl`/`helm`/`rulebricks` commands from a network that can reach the AKS
VNet (VPN, peering, or a jump host).

Then run `rulebricks init`, select the created cluster, and deploy the
application. The CLI discovers the created resources and creates the
namespace-scoped workload-identity bindings (storage, database, external-dns,
Key Vault) at deploy time. Retrieve deployment outputs any time with:

```bash
az deployment group show --resource-group rulebricks-rg --name rulebricks \
  --query properties.outputs
```

## One-time steps after the first deploy

These are the only manual steps; each is needed once.

**1. Delegate the DNS zone.** The template creates the `dnsZoneName` zone and
outputs `dnsZoneNameServers`. Hand those NS records to whoever controls the
parent domain. After that one delegation, external-dns manages every record
and Let's Encrypt issues all certificates automatically, no per-record DNS
access is ever needed. (To use a pre-existing zone instead, set
`createDnsZone = false` and `dnsZoneResourceGroup`.)

**2. Create the email Entra app.** Entra app registrations are Microsoft
Graph objects that ARM cannot create:

```bash
SMTP_APP_ID=$(az ad app create --display-name "Rulebricks SMTP" \
  --sign-in-audience AzureADMyOrg --query appId -o tsv)
az ad sp create --id "$SMTP_APP_ID"
az ad app credential reset --id "$SMTP_APP_ID" --query password -o tsv  # SMTP password
az ad sp show --id "$SMTP_APP_ID" --query id -o tsv                     # emailSmtpAppPrincipalId
```

Put the last two values in `emailSmtpAppPrincipalId` / `emailSmtpAppClientId`
and redeploy (or assign the role manually). In the Rulebricks CLI's email
step, pick "Azure Communication Services" and enter the `emailSmtpUsername`
and `emailSenderAddress` outputs with the client secret as the password.

**3. (Optional) SSO app registration.** Rulebricks supports Entra ID login
natively:

```bash
APP_ID=$(az ad app create \
  --display-name "Rulebricks SSO" \
  --sign-in-audience AzureADMyOrg \
  --web-redirect-uris "https://supabase.<your-domain>/auth/v1/callback" \
  --enable-id-token-issuance true \
  --query appId -o tsv)
az ad app credential reset --id "$APP_ID" --display-name rulebricks --query password -o tsv
```

In the CLI's SSO step: provider `azure`, URL
`https://login.microsoftonline.com/<tenant-id>`, plus the app ID and secret.
Register only the Supabase callback above; the default `User.Read` permission
is sufficient. Set the CLI's `adminEmail` to the Entra account that should own
the workspace - the first matching sign-in becomes the administrator.

**4. (Optional) Branded email sender.** By default email sends from
`DoNotReply@<guid>.azurecomm.net`. To send from your own subdomain instead,
set `emailCustomDomain` to the delegated zone (or a subdomain of it) - its
verification DNS records are created in the zone as part of the deployment -
and use `DoNotReply@<your-domain>` as the sender address in the Rulebricks
CLI. `rulebricks deploy` verifies the domain and links it to the email
service automatically.

For a domain hosted outside the delegated zone, publish the
`emailCustomDomainVerificationRecords` output at your DNS provider first.

**5. (Optional) Use the registry mirror** for restricted-egress clusters:
set `imageRegistry` in the Rulebricks deployment config to the
`containerRegistryLoginServer` output. Nothing to seed - the registry caches
Rulebricks images on first pull, authenticated by the license key from the
deployment (only the registry needs Docker Hub egress, never the nodes).

## Bring your own resources

The template can reuse shared resources instead of creating its own; it only
adds the minimal scoped role assignments and never manages their lifecycle:

- Storage: `createStorage = false` + `existingStorageAccountName` /
  `existingStorageAccountResourceGroup` (the account and container must exist).
- Key Vault: `createKeyVault = false` + `keyVaultName` +
  `existingKeyVaultResourceGroup` (RBAC-enabled vault; only the reader role is
  added).
- DNS zone: `createDnsZone = false` + `dnsZoneName` + `dnsZoneResourceGroup`.
- Monitoring: `createMonitorWorkspace = false` +
  `existingDataCollectionRule*`.

Managed Kafka (Event Hubs Premium) and Managed Redis stay off by default. If
you enable Kafka, keep the Helm `hps.workers.solutionPartitions` equal to the
Bicep `solutionPartitions` value and the worker maximum at or below it.

## Cleanup

Remove the application first so its load balancers and disks are deleted
cleanly, then remove the lock and the resource group:

```bash
rulebricks destroy <deployment-name>

STORAGE_ACCOUNT=$(az storage account list --resource-group rulebricks-rg \
  --query "[?tags.workload=='rulebricks'].name | [0]" -o tsv)
az lock delete --name protect-rulebricks-data --resource-group rulebricks-rg \
  --resource-type Microsoft.Storage/storageAccounts --resource-name "$STORAGE_ACCOUNT"

az group delete --name rulebricks-rg --yes
```

This deletes all data (decision logs, backups, mirrored images) - copy out
anything that must be retained. The vault is soft-deleted with purge
protection: recover it to restore, or wait out the retention period to release
the name. Role assignments made in shared (BYO) resource groups are not
deleted by the template - remove them if you tore down permanently.
