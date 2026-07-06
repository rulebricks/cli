# Azure Cluster Setup (AKS)

One Bicep deployment: `main.bicep` + `modules/`. Managed Kafka (Event Hubs),
Redis (Azure Managed Redis), Postgres (Flexible Server), and metrics remote
write are independent toggles that **default to off** — the Rulebricks chart
runs those services in-cluster until you enable them.

> This IaC is a reference implementation. Treat it as a starting point and
> customize it to accommodate pre-existing services (VNets, storage accounts,
> databases) or unique performance requirements.

## 1. Parameters

Cluster:

| Parameter | Default | Purpose |
| --- | --- | --- |
| `clusterName` | `rulebricks-cluster` | Prefixes every resource name; the CLI preselects `<cluster>-rulebricks` / `<cluster>-data` by convention |
| `location` | resource group location | Region for all resources |
| `kubernetesVersion` | `1.34` | AKS version |
| `enablePrivateCluster` | `false` | Private API server (needs VPN/Bastion for kubectl/helm/CLI) |
| `enableEntraRbac` | `false` | Entra ID + Azure RBAC for Kubernetes; disables local accounts |

Networking (all CIDRs parameterized for existing IPAM):

| Parameter | Default | Purpose |
| --- | --- | --- |
| `vnetAddressSpace` | `10.240.0.0/16` | VNet |
| `aksSubnetPrefix` | `10.240.0.0/22` | Nodes + load balancers |
| `privateEndpointsSubnetPrefix` | `10.240.4.0/24` | Private endpoints for data services |
| `postgresSubnetPrefix` | `10.240.5.0/24` | Delegated to PostgreSQL Flexible Server |
| `serviceCidr` / `dnsServiceIP` / `podCidr` | `172.16.0.0/16` / `172.16.0.10` / `192.168.0.0/16` | Cluster-internal; must not overlap peered networks |
| `enableDataServicePrivateEndpoints` | `false` | Private endpoints for Event Hubs / Managed Redis |

Node pools:

| Parameter | Default | Purpose |
| --- | --- | --- |
| `nodeCount` / `maxNodeCount` | `3` / `5` | Core pool (autoscaling) |
| `nodeVmSize` | `Standard_F4as_v6` | 4 vCPU / 16 GiB core nodes |
| `maxPods` / `osDiskSizeGB` / `osDiskType` | `110` / `64` / `Managed` | Node config |
| `enableBurstPool` | `true` | Worker pool, taint `rulebricks.com/pool=burst`, 0-N with Deallocate scale-down |
| `burstVmSize` / `burstMaxCount` | `Standard_F16as_v6` / `1` | 16 vCPU / 64 GiB burst nodes |

Storage / metrics / DNS:

| Parameter | Default | Purpose |
| --- | --- | --- |
| `createStorage` | `true` | Storage account + data container; `false` = BYO (`existingStorageAccountName`) |
| `dataContainerName` | `<cluster>-data` | One container, `decision-logs/` + `db-backups/` prefixes |
| `enableDecisionLogExport` / `enableBackupExport` | `true` / `true` | Blob role assignments per data path |
| `enableMetricsRemoteWrite` | `false` | Prometheus remote write to Azure Monitor |
| `createMonitorWorkspace` | `true` | AMW + DCE + DCR when remote write is on; `false` = BYO (`existingDataCollectionRuleId`) |
| `enableExternalDns` | `false` | Identity + federated credential for external-dns (`dnsZoneResourceGroup`, `rulebricksNamespace`) |

Managed services (all off by default; the sizing parameters below each toggle
are ignored unless that toggle is `true`, so they cannot create a bad state):

| Parameter | Default | Purpose |
| --- | --- | --- |
| `enableManagedKafka` | `false` | Event Hubs Premium as the Kafka backend (CLI preset `azure-event-hubs`) |
| `eventHubsNamespaceName` / `eventHubsCapacityUnits` | `<cluster>-kafka-<hash>` / `1` | 1 PU = 200 partitions namespace-wide |
| `kafkaTopicPrefix` / `solutionPartitions` / `logsPartitions` / `kafkaRetentionHours` | `com.rulebricks.` / `64` / `24` / `168` | Premium caps 100 partitions/hub; set `rulebricks.hps.workers.solutionPartitions` to match |
| `enableManagedRedis` | `false` | Azure Managed Redis (TLS, port 10000) instead of in-cluster Valkey |
| `redisName` / `redisSkuName` | `<cluster>-redis-<hash>` / `Balanced_B1` | Redis sizing |
| `enableManagedDatabase` | `false` | PostgreSQL Flexible Server 17 instead of in-cluster Postgres |
| `postgresServerName` / `postgresVersion` | `<cluster>-pg-<hash>` / `17` | Server |
| `postgresAdminUsername` / `postgresAdminPassword` | `rbadmin` / — | Password is `@secure()` and **required** when the toggle is on |
| `postgresSkuName` / `postgresSkuTier` / `postgresStorageSizeGB` | `Standard_D4ds_v5` / `GeneralPurpose` / `128` | Compute + storage (auto-grow) |
| `postgresHighAvailability` / `postgresBackupRetentionDays` | `true` / `7` | Zone-redundant HA (needs an AZ-enabled region) / backups |

## 2. Deployed resources

Always created:

| Resource | Type | Name / notes |
| --- | --- | --- |
| NSG | `Microsoft.Network/networkSecurityGroups` | `<cluster>-nsg`; 80/443 inbound to the AKS subnet |
| VNet | `Microsoft.Network/virtualNetworks` | `<cluster>-vnet`; subnets: aks, private-endpoints, postgres (delegated) |
| Cluster identity | `Microsoft.ManagedIdentity/userAssignedIdentities` | `<cluster>-identity`; Network Contributor on the VNet only |
| AKS cluster | `Microsoft.ContainerService/managedClusters` | `<cluster>`; CNI Overlay + Cilium, OIDC issuer + Workload Identity enabled, core + burst pools |
| Rulebricks identity | `Microsoft.ManagedIdentity/userAssignedIdentities` | `<cluster>-rulebricks`; the single workload identity the CLI federates at deploy time |
| Storage account + container | `Microsoft.Storage/storageAccounts` (+ blobServices/containers) | `rb<hash>` + `<cluster>-data`; when `createStorage` |
| Blob role assignment | `Microsoft.Authorization/roleAssignments` | Storage Blob Data Contributor for `<cluster>-rulebricks` |

Note: AKS also auto-creates its node resource group (`MC_<rg>_<cluster>_<region>`) holding VMSS, managed disks, and load balancers. It is deleted with the cluster.

Conditionally created:

| Resource | Type | Condition |
| --- | --- | --- |
| Azure Monitor workspace + DCE + DCR + Monitoring Metrics Publisher role | `Microsoft.Monitor/accounts`, `Microsoft.Insights/dataCollection*` | `enableMetricsRemoteWrite` (+ `createMonitorWorkspace`) |
| external-dns identity + DNS Zone Contributor + federated credential | `Microsoft.ManagedIdentity/*` | `enableExternalDns` |
| Event Hubs Premium namespace + `rulebricks` SAS rule (Send+Listen) + 3 hubs | `Microsoft.EventHub/namespaces` (+ eventhubs) | `enableManagedKafka` |
| Azure Managed Redis cluster + database | `Microsoft.Cache/redisEnterprise` (+ databases) | `enableManagedRedis` |
| PostgreSQL Flexible Server + private DNS zone + `wal_level=logical` configs | `Microsoft.DBforPostgreSQL/flexibleServers` | `enableManagedDatabase` |
| Private DNS zones + private endpoints for Event Hubs / Redis | `Microsoft.Network/privateDnsZones`, `privateEndpoints` | `enableDataServicePrivateEndpoints` |

## 3. Manual provisioning still required

- **Kubeconfig** (after deploy): `az aks get-credentials --name <cluster> --resource-group <rg>`
- **Postgres restart** (only when `enableManagedDatabase=true`): `wal_level` is static; run the `postgresRestartCommand` output once after creation, or Supabase Realtime will crashloop.
- **DNS**: point your app domain at the load balancer the chart creates during `rulebricks deploy` (or use `enableExternalDns`).
- **Secrets for the CLI wizard** (only when toggles are on) — run the `kafkaConnectionStringCommand` / `redisAccessKeyCommand` outputs; the Postgres password is the one you passed at deploy.
- Federated identity credentials are **not** manual — the Rulebricks CLI creates them at `rulebricks deploy` time.

### Bring your own cluster

If your AKS cluster was not created by this deployment, `rulebricks deploy` needs (validated at preflight):

1. OIDC issuer + workload identity enabled on the cluster:

```bash
az aks update --name <cluster> --resource-group <rg> \
  --enable-oidc-issuer --enable-workload-identity
```

2. A user-assigned managed identity (any resource group in the subscription) with Storage Blob Data Contributor on your storage account — never the cluster's control-plane or agentpool identities:

```bash
az identity create --name <cluster>-rulebricks --resource-group <rg>
az role assignment create \
  --assignee "$(az identity show -n <cluster>-rulebricks -g <rg> --query principalId -o tsv)" \
  --role "Storage Blob Data Contributor" \
  --scope "$(az storage account show -n <account> -g <rg> --query id -o tsv)"
```

## 4. Deploy

```bash
az account set --subscription <subscription-id>
AZURE_LOCATION=eastus bash check-aks-prereqs.sh   # verifies identity, providers, quota

az group create --name rulebricks-rg --location eastus

az deployment group create \
  --resource-group rulebricks-rg \
  --template-file main.bicep \
  --parameters @parameters.json \
  --parameters postgresAdminPassword='<strong-password>'   # only if enableManagedDatabase

az aks get-credentials --name rulebricks-cluster --resource-group rulebricks-rg
```

- Timing: ~10-15 min base; Event Hubs Premium adds ~15 min, Flexible Server ~10 min (parallel).
- Then run `rulebricks init`; outputs (`az deployment group show -g rulebricks-rg -n main --query properties.outputs`) map 1:1 to wizard fields.

## 5. Take down

```bash
# 1. Remove Kubernetes-created resources first (load balancers, PVC-backed disks)
rulebricks destroy <deployment-name>

# 2. Delete the resource group (cascade-deletes the MC_* node resource group)
az group delete --name rulebricks-rg --yes
```

Note: deleting the group also deletes the storage account, including your
decision-log archives (`decision-logs/`) and database backups (`db-backups/`)
in the `<cluster>-data` container — copy out anything you need first.

Resources that linger after group deletion — check and remove manually:

| Leftover | Why | Cleanup |
| --- | --- | --- |
| Anything else in a **shared** resource group | `az group delete` removes the whole group — use a dedicated RG, or delete resources individually if shared | Delete per-resource via `az resource delete` |
| Role assignments on out-of-group scopes | e.g. DNS Zone Contributor on a zone in `dnsZoneResourceGroup` | `az role assignment delete` |
| Entra ID objects for deleted identities | Stale role assignments can reference them | `az role assignment list --query "[?principalName==null]"` and delete |
| Kubernetes load balancers / disks | Live in `MC_*` (deleted with the group), but orphan if the cluster was deleted separately first | `rulebricks destroy` before deleting |
