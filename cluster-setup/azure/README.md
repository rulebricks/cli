# Azure Cluster Setup

A compact, turnkey AKS cluster for Rulebricks. One Bicep deploy creates the
cluster **and** the object storage + Azure Monitor resources the platform needs,
fully wired to Workload Identity. Bring-your-own infra is also supported.

## Files

- `rulebricks-cluster.bicep` — AKS cluster (Azure CNI, Calico, Standard LB, Disk CSI, OIDC issuer, Workload Identity) plus the single Rulebricks identity and its data paths.
- `parameters.json` — sample parameters (turnkey defaults: all paths on).
- `check-aks-prereqs.sh` — verifies login, providers, quota, role-assignment rights, kubectl/helm.

## One identity, one container (deployment-independent)

A single user-assigned identity, `<cluster>-rulebricks`, holds both data roles,
and all data lives in one container, `<cluster>-data`, under per-purpose prefixes.
Toggle each path with its `enable*` flag.

| Path                              | Service account             | Role / target                                                   |
| --------------------------------- | --------------------------- | --------------------------------------------------------------- |
| Decision logs (Vector → Blob)     | `vector`                    | Storage Blob Data Contributor → `<cluster>-data/decision-logs/` |
| DB backups (job → Blob)           | `<release>-backup`          | Storage Blob Data Contributor → `<cluster>-data/db-backups/`    |
| Metrics (Prometheus remote write) | `prometheus`                | Monitoring Metrics Publisher → Azure Monitor DCR                |

The identity has Storage Blob Data Contributor on the storage account and
Monitoring Metrics Publisher on the DCR.

> **This template does not need a deployment name.** Federated identity credentials are
> `namespace`-scoped (`system:serviceaccount:rulebricks-<deploymentName>:<sa>`), so they can't be
> created until the deployment namespace is known. The **Rulebricks CLI creates them at
> `rulebricks deploy` time** against this identity. That keeps cluster-setup generic, so one cluster
> can host any number of deployments without re-running it — the CLI adds each deployment's
> credentials on deploy. (Azure wildcard "flexible" FICs would avoid even that, but they're
> unsupported on managed identities and AKS OIDC issuers.)

## Turnkey vs. bring-your-own

- `createStorage: true` provisions a storage account + the single `<cluster>-data` container (deterministic globally-unique account name). `false` → set `existingStorageAccountName`.
- `createMonitorWorkspace: true` provisions an Azure Monitor workspace + data collection endpoint + rule, so the metrics role is scoped to a DCR we own. `false` → set `existingDataCollectionRuleId`.

Defaults are turnkey: `createStorage`, `createMonitorWorkspace`, and all `enable*` flags are `true`.

## Core cluster parameters

`clusterName` (`rulebricks-cluster`), `location` (`eastus`), `kubernetesVersion`
(`1.34`), `nodeCount`/`maxNodeCount` (`2`/`4`), `nodeVmSize`
(`Standard_F4as_v6`), `maxPods` (`110`), `osDiskSizeGB` (`30`), `osDiskType`
(`Managed`). Two 4-vCPU nodes give an 8-vCPU baseline that scales to four; the
`110` max-pods avoids the legacy 30/node limit. Worker pods use soft
anti-affinity, so no labels or taints are required.

## Check access

```bash
az login
az account set --subscription <subscription-id>
AZURE_LOCATION=eastus bash check-aks-prereqs.sh
```

Register any flagged providers with the suggested `az provider register`
commands and wait for completion. Note: creating role assignments needs
**Owner** or **User Access Administrator** — Contributor alone is not enough.

## Create the cluster

```bash
az group create --name rulebricks-rg --location eastus
az deployment group create \
  --resource-group rulebricks-rg \
  --template-file rulebricks-cluster.bicep \
  --parameters @parameters.json

az aks get-credentials --name rulebricks-cluster --resource-group rulebricks-rg
```

Run `rulebricks init` once kubeconfig works, then select this cluster. The
deploy emits `rulebricksClientId`, the generated `storageAccountName`, the
`dataContainer` name, and `dceMetricsIngestionEndpoint` / `dcrImmutableId` for
the CLI to consume.

> Managed-Prometheus role assignments take ~30 min to propagate; expect HTTP 403
> in the Prometheus log until then. This is expected, not a misconfiguration.

## Delete the cluster

Run `rulebricks destroy <deployment-name>` first so Kubernetes removes
LoadBalancer services and PVC-backed disks. Then delete the resource group:

```bash
az group delete --name rulebricks-rg --yes
```

AKS cascade-deletes its `MC_<rg>_<cluster>_<region>` node resource group, so
this removes the cluster, node pool, identities, role assignments, federated
credentials, and (when created by the template) the storage account and Azure
Monitor workspace.

## Notes

- Inbound TCP `80`/`443` are open to the AKS subnet for LoadBalancer services and cert-manager HTTP-01 validation.
- `maxPods` is fixed at node-pool creation; changing it means a replacement pool or recreate.
- Federated identity credentials for vector/backup/prometheus are created by the Rulebricks CLI at deploy time, so this template takes no deployment name. (The optional `external-dns` path is the one exception — set `rulebricksNamespace` if you enable it.)
- BYO storage/monitor resources outside this resource group need an admin to assign the relevant role to the emitted identity client ID.

## Fallback secret-based auth

If Workload Identity is unavailable, decision-log export can use a storage
connection string, and metrics can use OAuth client-secret auth:

```bash
kubectl create secret generic azure-blob-logs \
  --namespace rulebricks-demo \
  --from-literal=connection-string='<connection-string>'
# CLI prompt: azure-blob-logs:connection-string

kubectl create secret generic azure-monitor-oauth \
  --namespace rulebricks-demo \
  --from-literal=client-secret='<client-secret>'
# CLI prompt: azure-monitor-oauth:client-secret
```
