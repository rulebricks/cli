# Azure cluster setup

Provisions a production-ready AKS environment for Rulebricks in a dedicated
resource group. Everything is defined by [main.bicep](main.bicep) and one
parameter file, [parameters.bicepparam](parameters.bicepparam).

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

```bash
az account set --subscription <subscription-id>
az group create --name rulebricks-rg --location eastus

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

- Storage: `createStorage = false` + `existingStorageAccountName` /
  `existingStorageAccountResourceGroup` (account and container must exist).
- Key Vault: `createKeyVault = false` + `keyVaultName` +
  `existingKeyVaultResourceGroup` (RBAC-enabled; only the reader role is added).
- DNS zone: `createDnsZone = false` + `dnsZoneName` + `dnsZoneResourceGroup`.
- Monitoring: `createMonitorWorkspace = false` + `existingDataCollectionRule*`.

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
Role assignments made in BYO resource groups are not removed by the template.