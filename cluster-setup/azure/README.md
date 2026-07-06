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
(`1.34`), `nodeCount`/`maxNodeCount` (`3`/`5`), `nodeVmSize`
(`Standard_F4as_v6`), `maxPods` (`110`), `osDiskSizeGB` (`64`), `osDiskType`
(`Managed`). The default (core) pool runs the always-on services on three to
five 4-vCPU / 16-GiB nodes: the chart's steady-state request floor is
~10 vCPU / ~23 GiB (plus per-node DaemonSets and headroom for request-less
pods), so 3 nodes are the floor — 2 forced a scale-up mid-install — and the
5-node ceiling leaves room for HPS scaling 3 -> 8. Burst capacity for the
worker fleet lives in the dedicated burst pool below.
The `110` max-pods avoids the legacy 30/node limit, and the autoscaler
profile is tuned for bursts (`scan-interval` 10s, `least-waste` expander).
Both pools use `Deallocate` scale-down: removed nodes are parked (disk-only
cost, container images cached) and resume in ~30-60s instead of
reprovisioning.

### Burst worker pool (default on)

`enableBurstPool` (`true`), `burstVmSize` (`Standard_F16as_v6`, 16 vCPU /
64 GiB - the Fas_v6 family has no 24-vCPU size), `burstMaxCount` (`1`). One
large `User`-mode node that scales 0 -> 1 on demand and parks between bursts.
It is labeled and tainted `rulebricks.com/pool=burst`: the Rulebricks chart
makes workers tolerate the taint and softly prefer the label out of the box,
so the entire scaled-out worker fleet lands on this node while core services
stay on the default pool. Sizing math: 3 x 4 vCPU core floor + 16 vCPU burst
= 28 vCPU running steady-state at full burst, and 36 vCPU with the core pool
at its 5-node max - check the Fasv6-family vCPU quota covers this. The 64 GiB
also matters: workers request 1 GiB each, so the default 64-worker KEDA
ceiling needs ~64 GiB.
First-ever burst
cold-provisions the VM (~2-4 min); every burst after resumes the parked VM
(~30-60s). Note deallocated VMs resume into their original zone/SKU - in a
capacity-constrained region a resume can fail and the autoscaler retries;
the warm worker floor on the core pool carries traffic in the meantime.

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
