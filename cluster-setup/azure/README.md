# Azure cluster setup

This folder provisions an AKS cluster for the Rulebricks Helm chart. The same
Bicep modules support a low-cost test environment and a hardened production
environment.

The templates are intended for a dedicated resource group. Managed Kafka,
Redis, PostgreSQL, Azure Monitor, and Grafana remain optional.

## Deployment profiles

`deploymentProfile` selects defaults. Any individual parameter can override a
profile default.

| Setting | Test | Production |
| --- | --- | --- |
| AKS tier | Free | Standard |
| API server | Public | Private |
| Kubernetes authentication | Local accounts | Entra ID and Azure RBAC |
| Node pools | Shared system/core pool | Dedicated system and core pools |
| Availability zones | None | 1, 2, and 3 |
| Upgrade policy | Manual | Stable channel and weekly node image updates |
| Azure Policy | Off | On |
| Key Vault secret sync | Off | Private vault and workload identity |
| Initial vCPU | 12 | 18 |
| Default autoscaling ceiling | 16 | 42 |
| ACR mirror | Off | Premium ACR with a private endpoint |
| Blob storage | LRS, 7-day soft delete | ZRS, versioning, 30-day soft delete, private endpoint, delete lock |
| Managed data services | Off | Off |

The test profile uses the same network, AKS, identity, and storage modules as
production. It omits controls that add cost or require private network access.

Do not convert an existing test cluster to the production profile in place.
The production profile changes node-pool topology and control-plane access.
Create a separate production resource group and cluster.

## Files

| File | Purpose |
| --- | --- |
| `main.bicep` | Entry point and profile defaults |
| `parameters.test.json` | Low-cost, removable test environment |
| `parameters.production.json` | Production baseline |
| `parameters.json` | Backward-compatible alias of the test profile |
| `modules/` | Network, AKS, identity, Key Vault, storage, monitoring, and optional data services |
| `check-aks-prereqs.sh` | Local configuration, regional availability, access, and quota checks |
| `mirror-to-acr.sh` | Copies all Rulebricks images into ACR |

## Core parameters

| Parameter | Default | Purpose |
| --- | --- | --- |
| `clusterName` | `rulebricks-cluster` | Prefix for resources |
| `location` | Resource group region | Azure region |
| `kubernetesVersion` | `1.34` | AKS minor version |
| `apiServerAuthorizedIpRanges` | `[]` | Optional CIDR allowlist for a public API server |
| `aksAdminPrincipalIds` | `[]` | Entra group or user object IDs granted AKS Cluster Admin |
| `nodeCount` | `3` | Initial and minimum core nodes |
| `maxNodeCount` | Test `4`, production `5` | Core autoscaling ceiling |
| `systemNodeVmSize` | `Standard_D2as_v4` | Production system-pool size with broadly available quota |
| `enableBurstPool` | Test `false`, production `true` | Worker pool with the `rulebricks.com/pool=burst` taint |
| `burstMaxCount` | `1` | Initial burst ceiling; increase after quota is approved |
| `enableDataServicePrivateEndpoints` | Test `false`, production `true` | Private endpoints for enabled Event Hubs, Redis, and ACR resources |

All network ranges are parameters. The defaults use a `/22` node subnet,
separate private-endpoint and PostgreSQL subnets, Azure CNI Overlay, and Cilium.

## Base architecture

Every profile creates a virtual network with AKS, private-endpoint, and
PostgreSQL subnets; an AKS cluster with OIDC and Workload Identity; managed
identities for the cluster and Rulebricks; and blob storage for exports and
backups. The cluster identity receives Network Contributor on this VNet only.
The Rulebricks identity receives Blob Data Contributor on its storage account.

AKS also creates an `MC_*` node resource group for VM scale sets, managed
disks, and load balancers. Azure removes that node resource group with the AKS
cluster.

## Workload placement

The production system pool is reserved for Kubernetes add-ons. The core pool
holds steady application capacity, including HPS gather pods. HPS workers can
run on the core pool and prefer the optional burst pool when it scales up. The
burst pool starts at zero nodes and is capped at one node by default.

The Bicep profile does not set Helm replica counts. Keep the frontend at one
replica when that is sufficient, and size `hps.replicas`,
`hps.workers.minReplicaCount`, and `hps.workers.maxReplicaCount` from measured
traffic. ClickHouse can remain single-replica because it is outside the request
path.

Managed Kafka uses Event Hubs Premium and remains off by default. If enabled,
set the Helm `hps.workers.solutionPartitions` value to the Bicep
`solutionPartitions` value. The default is 64 because Event Hubs Premium caps
an individual hub at 100 partitions. Keep the HPS worker maximum at or below
the partition count.

## Storage and identity

The deployment creates `<cluster>-rulebricks`, a user-assigned managed identity
used by the chart through AKS Workload Identity. The Rulebricks CLI creates the
namespace-specific federated credentials during `rulebricks deploy`.

The created storage account holds one container with `decision-logs/` and
`db-backups/` prefixes. `enableBackupExport` grants access to the backup path;
the actual backup schedule is enabled separately in the Rulebricks CLI.

For an existing storage account, set:

```json
{
  "createStorage": { "value": false },
  "existingStorageAccountName": { "value": "mystorageaccount" },
  "existingStorageAccountResourceGroup": { "value": "shared-data-rg" },
  "enableStoragePrivateEndpoint": { "value": false },
  "enableStorageDeleteLock": { "value": false }
}
```

The account and container must already exist. The deployment adds the Blob Data
Contributor role at the storage-account scope.

## Key Vault and Kubernetes secrets

The production profile creates a Key Vault, a private endpoint, private DNS, and
a dedicated workload identity for External Secrets Operator. That identity gets
the `Key Vault Secrets User` role on this vault only. It cannot create, update,
or delete secrets.

The template intentionally does not accept secret values. Grant the
`Key Vault Secrets Officer` role to the group, user, or automation identity that
seeds and rotates them:

```json
"keyVaultWriterPrincipalIds": {
  "value": ["<secret-writer-object-id>"]
}
```

For an existing RBAC-enabled vault, set:

```json
{
  "enableKeyVaultIntegration": { "value": true },
  "createKeyVault": { "value": false },
  "keyVaultName": { "value": "shared-rulebricks-vault" },
  "existingKeyVaultResourceGroup": { "value": "shared-security-rg" }
}
```

The deployment adds only the reader role to an existing vault. Its firewall,
private endpoint, DNS, secret writers, and lifecycle remain owned by the shared
vault team.

After deployment, use the outputs `keyVaultUri`, `externalSecretsClientId`,
`externalSecretsTenantId`, and `externalSecretsServiceAccountName` to fill the
placeholders in the Helm chart's
`examples/external-secrets/azure-key-vault.yaml`. That manifest is applied with
`kubectl` (the chart renders no vault-specific resources) and creates:

1. A service account annotated with the Azure client and tenant IDs.
2. A namespaced `SecretStore` that authenticates with AKS Workload Identity.
3. `ExternalSecret` resources that map Key Vault entries into the Kubernetes
   Secrets listed in the chart's `.secrets.example`.

The chart can still install a namespace-scoped External Secrets Operator via
`externalSecrets.installOperator: true`. Point `global.secrets.secretRef` and
any Supabase secret references at the synced Secrets. No Key Vault value is
stored in the Bicep deployment, Helm values, or Bicep outputs.

Install the Helm release in the `externalSecretsNamespace` output. If a
different namespace is required, set `rulebricksNamespace` before deploying
the infrastructure so the federated credential and Kubernetes service account
stay aligned.

## Optional services

| Parameter | Resource |
| --- | --- |
| `enableContainerRegistry` | ACR mirror and `AcrPull` for the AKS kubelet identity |
| `enableManagedKafka` | Event Hubs Premium with three Kafka-compatible hubs |
| `enableManagedRedis` | Azure Managed Redis |
| `enableManagedDatabase` | PostgreSQL Flexible Server with private DNS and logical replication |
| `enableMetricsRemoteWrite` | Azure Monitor workspace, DCE, DCR, and publisher role |
| `enableManagedGrafana` | Azure Managed Grafana connected to the created monitor workspace |
| `enableExternalDns` | Workload identity and DNS-zone-scoped contributor role |
| `enableKeyVaultIntegration` | Key Vault reader identity and either a created vault or a scoped role on an existing vault |
| `enableControlPlaneLogs` | AKS control-plane diagnostics (kube-apiserver, kube-audit-admin, guard) to an existing Log Analytics workspace (`controlPlaneLogAnalyticsWorkspaceId`) |

For a shared Data Collection Rule, provide
`existingDataCollectionRuleName` and
`existingDataCollectionRuleResourceGroup`. For external-dns, provide
`dnsZoneName` and `dnsZoneResourceGroup`.

## Test deployment

The test environment is the recommended first validation path. It has no
resource lock and can be removed by deleting its dedicated resource group.

```bash
az account set --subscription <subscription-id>
az group create --name rulebricks-test-rg --location eastus

bash check-aks-prereqs.sh \
  --parameters parameters.test.json \
  --resource-group rulebricks-test-rg

az deployment group what-if \
  --resource-group rulebricks-test-rg \
  --template-file main.bicep \
  --parameters @parameters.test.json \
  --validation-level ProviderNoRbac

az deployment group create \
  --name rulebricks-test \
  --resource-group rulebricks-test-rg \
  --template-file main.bicep \
  --parameters @parameters.test.json

az aks get-credentials \
  --name rulebricks-test \
  --resource-group rulebricks-test-rg
```

Run `rulebricks init`, select the created AKS cluster, and then deploy the Helm
release. The CLI detects the Azure disk storage class and creates the workload
identity bindings used by the chart.

Key Vault is off in the test profile. Enable it for an end-to-end secret-sync
test without adding a private endpoint or purge protection:

```bash
SIGNED_IN_ID=$(az ad signed-in-user show --query id -o tsv)

az deployment group create \
  --name rulebricks-test \
  --resource-group rulebricks-test-rg \
  --template-file main.bicep \
  --parameters @parameters.test.json \
  --parameters enableKeyVaultIntegration=true \
               keyVaultWriterPrincipalIds="[\"$SIGNED_IN_ID\"]"
```

## Production deployment

The production API server is private. Run the deployment and all later
`kubectl`, Helm, and Rulebricks CLI commands from a network that can reach the
AKS virtual network.

Before deploying, add at least one Entra group object ID to
`aksAdminPrincipalIds` in `parameters.production.json`. Group-based access is
preferred so administrators can change without redeploying the cluster.

```json
"aksAdminPrincipalIds": {
  "value": ["<entra-group-object-id>"]
},
"keyVaultWriterPrincipalIds": {
  "value": ["<secret-writer-group-object-id>"]
}
```

```bash
az group create --name rulebricks-prod-rg --location eastus

bash check-aks-prereqs.sh \
  --parameters parameters.production.json \
  --resource-group rulebricks-prod-rg

az deployment group what-if \
  --resource-group rulebricks-prod-rg \
  --template-file main.bicep \
  --parameters @parameters.production.json \
  --validation-level ProviderNoRbac

az deployment group create \
  --name rulebricks-production \
  --resource-group rulebricks-prod-rg \
  --template-file main.bicep \
  --parameters @parameters.production.json
```

The production profile creates a zero-node burst pool capped at one node.
Increase `burstMaxCount` only after load testing and quota approval. The
prerequisite checker treats launch quota as a blocker and a lower-than-ceiling
quota as a warning, so an unused autoscaling ceiling does not prevent initial
validation.

## After the infrastructure deployment

Retrieve outputs with:

```bash
az deployment group show \
  --resource-group <resource-group> \
  --name <deployment-name> \
  --query properties.outputs
```

Point the application DNS names at the load balancer created by the Helm
release, or enable external-dns and provide its zone parameters. Microsoft
Entra application registrations are Microsoft Graph objects, so SSO clients
are configured separately from this ARM deployment.

When a managed service is enabled, use the returned Kafka or Redis command to
retrieve its secret at deployment time. The PostgreSQL password is the secure
value supplied to ARM. None of these secrets appear in Bicep outputs.

### Sync Key Vault secrets

Seed the vault from a trusted workstation or delivery pipeline that has the
writer role. Production writers must also have network access to the AKS virtual
network because the vault's public endpoint is disabled. Use your own secret
names as long as they match the `remoteRef` mappings in your applied
`ExternalSecret` manifests.

```bash
KV_NAME=$(az deployment group show \
  --resource-group <resource-group> \
  --name <deployment-name> \
  --query properties.outputs.keyVaultName.value -o tsv)

az keyvault secret set \
  --vault-name "$KV_NAME" \
  --name rulebricks-license-key \
  --value "$LICENSE_KEY" \
  --output none
```

Copy `examples/external-secrets/azure-key-vault.yaml` from the Helm chart,
replace the Bicep output placeholders, map each required Kubernetes Secret key
to its Key Vault secret name, and apply it with `kubectl`. Set
`externalSecrets.installOperator=true` in the Helm values unless the cluster
already has a compatible External Secrets Operator.

### Seed the production registry

```bash
export DOCKERHUB_USERNAME=<license-username>
export DOCKERHUB_TOKEN=<license-token>

bash mirror-to-acr.sh \
  --registry <containerRegistryName-output> \
  --version <product-version>
```

Set `imageRegistry` in the Rulebricks deployment configuration to the
`containerRegistryLoginServer` output. ACR imports are server-side and the
template enables the Azure-services bypass. If tenant policy blocks an import,
temporarily deploy with `allowContainerRegistryPublicAccess=true`, seed the
registry, and redeploy with it set to `false`.

### Managed PostgreSQL

When `enableManagedDatabase=true`, pass the administrator password as a secure
deployment parameter. Do not commit it to a parameter file.

```bash
az deployment group create \
  --resource-group rulebricks-prod-rg \
  --template-file main.bicep \
  --parameters @parameters.production.json \
  --parameters enableManagedDatabase=true \
               postgresAdminPassword='<strong-password>'
```

Run the `postgresRestartCommand` output once. The restart activates
`wal_level=logical`, which Supabase Realtime requires.

## Cleanup

Remove the Kubernetes release first so its load balancers and disks are
deleted cleanly.

```bash
rulebricks destroy <deployment-name>
```

The test profile has no locks. If Key Vault was enabled, capture its name so it
can be purged after the resource group is gone:

```bash
TEST_VAULT=$(az keyvault list \
  --resource-group rulebricks-test-rg \
  --query "[?tags.workload=='rulebricks'].name | [0]" -o tsv)

az group delete --name rulebricks-test-rg --yes

if [[ -n "$TEST_VAULT" ]]; then
  az keyvault purge --name "$TEST_VAULT" --location eastus
fi
```

The production profile protects its created storage account with a delete lock.
Remove that known lock, then delete the dedicated resource group:

```bash
STORAGE_ACCOUNT=$(az storage account list \
  --resource-group rulebricks-prod-rg \
  --query "[?tags.workload=='rulebricks'].name | [0]" -o tsv)

az lock delete \
  --name protect-rulebricks-data \
  --resource-group rulebricks-prod-rg \
  --resource-type Microsoft.Storage/storageAccounts \
  --resource-name "$STORAGE_ACCOUNT"

az group delete --name rulebricks-prod-rg --yes
```

Deleting the resource group also deletes the created storage account, decision
logs, backups, and mirrored images. Copy out anything that must be retained.

The production vault has purge protection by default. Deleting its resource
group soft-deletes the vault, retains it for the configured retention period,
and keeps its name reserved. Recover the vault if the environment must be
restored during that period. Use the test profile for disposable validation.

If the deployment assigned roles in shared storage, DNS, or monitoring resource
groups, remove those assignments before deleting the managed identity. These
external resources are never deleted by this template.

## Validation scope

`az bicep build` and `az bicep lint` provide local validation. The prerequisite
checker adds parameter consistency, regional AKS version, VM SKU, access, and
quota checks. `az deployment group what-if` performs provider validation and
shows the exact Azure changes without creating resources.
