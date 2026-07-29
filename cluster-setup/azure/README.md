# Azure cluster setup

Provisions a production-ready AKS environment for Rulebricks in a dedicated
resource group, in two templates:

- [prerequisites.bicep](prerequisites.bicep) | Likely org-gated resources: the
  delegated DNS zone, the external-dns identity (granted on that zone), and
  the ACS email service with its sender domains. This exists to document things
  you might need to request beforehand, or require a high level of access for.
- [main.bicep](main.bicep) | Everything else (AKS, networking, PostgreSQL,
  Key Vault, storage, monitoring, registry). It only READS the prerequisite
  resources, so it deploys with rights on the workload resource group alone.

Each has one parameter file:
[parameters.prerequisites.bicepparam](parameters.prerequisites.bicepparam) and
[parameters.bicepparam](parameters.bicepparam).

**Review the [CHECKLIST.md](CHECKLIST.md) for clear steps on using the Bicep templates provided and installing Rulebricks.**

---

These are the default settings configured in parameters.bicepparam:

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


---

## Deploy

### 1. Prerequisites

```bash
az account set --subscription <subscription-id>
az group create --name rulebricks-rg --location eastus

az deployment group create \
  --name rulebricks-prerequisites \
  --resource-group rulebricks-rg \
  --parameters parameters.myprerequisites.bicepparam \
  --query properties.outputs -o json | tee rulebricks-prerequisites.json
```

Then, from its outputs:

- Hand `dnsZoneNameServers` to whoever controls the parent domain for the
  one-time NS delegation.
- Using a branded sender domain? Run the four
  `emailInitiateVerificationCommands` and wait until
  `emailVerificationStatusCommand` reports every check Verified (typically a
  couple of minutes, once the delegation is live).

If a platform team deploys this into a different resource group, they list
your Entra object ID in `deployerPrincipalIds` (which grants everything the
main deployment needs there) and send you the `mainDeploymentParameters`
output - copy those values into your main parameters file.

### 2. Main deployment

```bash
export POSTGRES_ADMIN_PASSWORD='<strong-password>'   # never stored in a file
export LICENSE_KEY='<license-key>'                   # authenticates the image cache

az deployment group create \
  --name rulebricks \
  --resource-group rulebricks-rg \
  --parameters parameters.mydeployment.bicepparam \
  --query properties.outputs -o json | tee rulebricks-setup.json

az aks get-credentials --name rulebricks-prod --resource-group rulebricks-rg
```

### Deployment outputs

```bash
az deployment group show --resource-group rulebricks-rg --name rulebricks \
  --query properties.outputs -o json > rulebricks-setup.json
```

## Bring your own resources

- DNS zone, external-dns identity, email service: these ARE the prerequisites
  deployment. Deployed by someone else, into a different resource group?
  Set `prerequisitesResourceGroup` plus the names from its
  `mainDeploymentParameters` output - the main deployment only reads them.
- Storage: `createStorage = false` + `existingStorageAccountName` /
  `existingStorageAccountResourceGroup` (account and container must exist).
- Key Vault: `createKeyVault = false` + `keyVaultName` +
  `existingKeyVaultResourceGroup` (RBAC-enabled; only the reader role is added).
- Monitoring: `createMonitorWorkspace = false` + `existingDataCollectionRule*`.
- Email: `enableManagedEmail = false` when you already have SMTP credentials
  from any provider; give them to `rulebricks init` instead.
- ACS sender domain your organization already verified (on their own email
  service, no prerequisites needed for email): `emailServiceName` /
  `emailServiceResourceGroup` / `emailBrandedDomainName`, with
  `emailFallbackDomainName = ''` if that service has no Azure-managed domain.
  Linking only reads the domain, so Reader on it suffices.

## Cleanup

Remove the application first so its load balancers and disks are deleted
cleanly, then the lock, then the resource group:

```bash
rulebricks destroy <deployment-name>

STORAGE_ACCOUNT=$(az storage account list --resource-group rulebricks-rg \
  --query "[?tags.workload=='rulebricks'].name | [0]" -o tsv)
az lock delete --name protect-rulebricks-data --resource-group rulebricks-rg \
  --resource-type Microsoft.Storage/storageAccounts --resource-name "$STORAGE_ACCOUNT"

az group delete --name rulebricks-rg --yes
```

This deletes all data (decision logs, backups (if using in-cluster PostgreSQL), mirrored images).
Deleting the resource group also removes the prerequisites when they were
deployed into it (the zone delegation and any verified email domain go with
them - keep them by deploying prerequisites into their own group instead).
Role assignments made in other resource groups are not removed by the
template.