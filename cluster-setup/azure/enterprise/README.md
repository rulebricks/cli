# Azure Enterprise Cluster Setup

A modular Bicep deployment (`main.bicep` + `modules/`) that provisions
everything a production Rulebricks deployment needs on Azure, hardened for
enterprise environments and with **independent true/false toggles** for the
managed data services Rulebricks can externalize to:

| Toggle | Managed service | Replaces in-cluster |
| --- | --- | --- |
| `enableManagedKafka` | Event Hubs Premium (Kafka endpoint) | Strimzi Kafka |
| `enableManagedRedis` | Azure Managed Redis | Valkey |
| `enableManagedDatabase` | PostgreSQL Flexible Server 17 | Supabase Postgres |

Any combination is valid — the Rulebricks chart runs Kafka, Valkey, and
Postgres in-cluster for whichever you leave disabled. Beyond the toggles, this
differs from the turnkey template (`../rulebricks-cluster.bicep`) by using
Azure CNI Overlay + Cilium, a parameterized address space (no `10.0.0.0/8`
grab), purpose-built subnets (AKS / private endpoints / delegated Postgres),
and optional private-cluster, Entra RBAC, and private-endpoint hardening.

Even if your team cannot run the deployment directly, it is written to be
read: every module, role assignment, and parameter is commented with why
Rulebricks needs it. Treat it as the authoritative statement of our Azure
requirements — the companion workbook
(`rulebricks-azure-aks-deployment-checklist-*.xlsx`) itemizes the same
content row by row for infra/cyber sign-off.

## Files

```
main.bicep              parameters, module wiring, aggregated outputs
parameters.json         sample parameters (data-service toggles default OFF)
modules/network.bicep   VNet, subnets (aks / private-endpoints / postgres), NSG
modules/cluster.bicep   AKS: CNI Overlay + Cilium, Workload Identity + OIDC,
                        core + burst pools, optional private cluster + Entra RBAC
modules/data.bicep      <cluster>-rulebricks identity, blob storage, Azure
                        Monitor managed Prometheus (AMW + DCE + DCR), external-dns
modules/kafka.bicep     Event Hubs Premium namespace + the three Kafka topics
modules/redis.bicep     Azure Managed Redis (redisEnterprise) + default database
modules/postgres.bicep  PostgreSQL Flexible Server (VNet-integrated, wal_level=logical)
../check-aks-prereqs.sh same prerequisite checks as the turnkey template
```

## Architecture

```
VNet <vnetAddressSpace, default 10.240.0.0/16>
├─ aks-subnet (/22, NSG: 80/443 in)      nodes + LBs; pods live in podCidr
│   ├─ core pool: 3-5 x Standard_F4as_v6 (Deallocate scale-down)
│   └─ burst pool: 0-1 x Standard_F16as_v6, taint rulebricks.com/pool=burst
├─ private-endpoints-subnet (/24)        PEs for Event Hubs / Managed Redis
│                                        (enableDataServicePrivateEndpoints)
└─ postgres-subnet (/24, delegated)      PostgreSQL Flexible Server (VNet-only)

Outside the VNet: storage account (blob), Azure Monitor workspace + DCE/DCR,
Event Hubs namespace, Azure Managed Redis (public endpoints unless
enableDataServicePrivateEndpoints = true; Postgres is always private).
```

Network layout notes:

- **CNI Overlay + Cilium**: pods draw from `podCidr` (default
  `192.168.0.0/16`) instead of VNet IPs, so the AKS subnet only needs to hold
  nodes and load balancers. Cilium provides the dataplane and enforces the
  chart's NetworkPolicies. `serviceCidr`/`podCidr` must not overlap the VNet
  or peered networks.
- **Kubernetes API**: public by default; `enablePrivateCluster=true` makes it
  VNet-only (you then need VPN/Bastion/jumpbox to run kubectl, helm, and the
  Rulebricks CLI).
- **Inbound**: only 80/443 to the Traefik LoadBalancer (80 for ACME HTTP-01 +
  redirect). Tighten the NSG source to corporate CIDRs for internal-only use.
- **Data services**: Postgres is VNet-integrated by design (delegated subnet +
  private DNS zone — no public endpoint exists). Event Hubs and Managed Redis
  default to public endpoints with TLS; `enableDataServicePrivateEndpoints=true`
  gives both private endpoints and disables Event Hubs public network access.

## Identity model (Workload Identity)

A single user-assigned identity, `<cluster>-rulebricks`, holds every data-path
role:

| Role | Scope | Used by |
| --- | --- | --- |
| Storage Blob Data Contributor | the storage account | Vector (decision logs), backup job, ClickHouse archive reads |
| Monitoring Metrics Publisher | the DCR | Prometheus remote write |

**This deployment does not need a deployment name.** Federated identity
credentials are namespace-scoped
(`system:serviceaccount:rulebricks-<deploymentName>:<sa>`), so the
**Rulebricks CLI creates them at `rulebricks deploy` time** against this
identity for `vector`, `<release>-backup`, `prometheus`, and
`<release>-clickhouse`. One cluster hosts any number of deployments without
re-running this template. (The optional `external-dns` path is the one
exception — set `rulebricksNamespace` if you enable it.)

The AKS cluster itself runs under a separate `<cluster>-identity` UAMI with
Network Contributor on the VNet only. Kafka (Event Hubs) and Redis use
connection-string/access-key auth handed to the chart as Kubernetes secrets —
Vector's Kafka client cannot use OAUTHBEARER, so SASL PLAIN with the namespace
connection string is the supported Event Hubs path (the CLI's
`azure-event-hubs` preset).

## Node sizing

Same rationale as the turnkey template: the chart's steady-state request floor
is ~10 vCPU / ~23 GiB, so the core pool floor is 3 x `Standard_F4as_v6`
(4 vCPU / 16 GiB each) with a 5-node ceiling for HPS scaling 3 → 8. The burst
pool (1 x `Standard_F16as_v6`, 16 vCPU / 64 GiB) absorbs the KEDA-scaled
worker fleet (up to 64 workers x 1 GiB requests); `Deallocate` scale-down
parks it between bursts at disk-only cost with images cached (~30-60s resume).
Check the Fasv6-family regional vCPU quota covers 3x4 + 16 = 28 steady-state
(36 with the core pool maxed).

## Managed data services

### Kafka — Event Hubs Premium (`enableManagedKafka`)

- Premium namespace (`eventHubsCapacityUnits` PUs, default 1), Kafka endpoint
  on port 9093, TLS 1.2+, and a least-privilege `rulebricks` SAS rule
  (Send + Listen; RootManage stays with admins).
- **Topics are event hubs**, created here (unlike MSK, where the chart's job
  creates them): `com.rulebricks.solution`, `com.rulebricks.solution-response`
  (both `solutionPartitions`, default 64) and `com.rulebricks.logs`
  (`logsPartitions`, default 24). Kafka consumer groups are virtual on Event
  Hubs — nothing to pre-create.
- **Partition limits are the design constraint**: Premium caps at 100
  partitions per hub and 200 per PU namespace-wide. The chart's default
  solution partition count (128) does not fit, hence the default of 64
  (64+64+24 = 152 ≤ 200, fits one PU). **Set
  `rulebricks.hps.workers.solutionPartitions` to the same value** in your
  deployment (it caps worker concurrency and the KEDA max), or raise PUs and
  partitions together up to 100.
- CLI config: external Kafka, preset **`azure-event-hubs`** — brokers from the
  `kafkaBootstrapServers` output, connection string from the
  `kafkaConnectionStringCommand` output (SASL PLAIN, username
  `$ConnectionString` — the CLI fills these in automatically).

### Redis — Azure Managed Redis (`enableManagedRedis`)

- Azure Managed Redis (`Microsoft.Cache/redisEnterprise`) — Azure Cache for
  Redis is retiring, and AMR is its replacement. `Balanced_B1` (1 GB) matches
  the in-cluster Valkey footprint; scale the SKU for larger rule caches.
- TLS-only on **port 10000** (not 6379/6380), access-key auth, `Enterprise`
  clustering policy (single endpoint — standard Redis clients, which is what
  the chart uses), `NoEviction` to match in-cluster Valkey defaults.
- CLI config: external Redis — host from `redisHost`, port `10000`, TLS
  **on**, password from the `redisAccessKeyCommand` output.

### Database — PostgreSQL Flexible Server (`enableManagedDatabase`)

- PostgreSQL 17 (matching the in-cluster Supabase image), `Standard_D4ds_v5`
  General Purpose, 128 GB auto-growing storage, 7-day backups, optional
  zone-redundant HA (`postgresHighAvailability`).
- VNet-integrated: delegated `postgres-subnet` + private DNS zone; there is no
  public endpoint.
- Ships `wal_level=logical` (+ `max_replication_slots`/`max_wal_senders` = 10)
  because **Supabase Realtime requires logical replication** — the CLI
  preflights this. `wal_level` is static: **restart the server once after
  deployment** (`postgresRestartCommand` output prints the exact command).
- **Password**: `postgresAdminPassword` is a required `@secure()` parameter
  when the toggle is on — pass it on the command line (below), never in
  `parameters.json`. It becomes the CLI wizard's bootstrap master password.
- CLI config: database "self-hosted" + external Postgres — host from
  `postgresHost`, port 5432, database `postgres`, master username/password as
  configured here.

## Check access, create, connect

```bash
az login
az account set --subscription <subscription-id>
AZURE_LOCATION=eastus bash ../check-aks-prereqs.sh

az group create --name rulebricks-rg --location eastus
az deployment group create \
  --resource-group rulebricks-rg \
  --template-file main.bicep \
  --parameters @parameters.json \
  --parameters postgresAdminPassword='<strong-password>'   # only if enableManagedDatabase

az aks get-credentials --name rulebricks-cluster --resource-group rulebricks-rg

# Only if enableManagedDatabase: wal_level is static - restart once
az postgres flexible-server restart --resource-group rulebricks-rg \
  --name "$(az deployment group show -g rulebricks-rg -n main --query properties.outputs.postgresHost.value -o tsv | cut -d. -f1)"
```

Notes:

- Creating role assignments needs **Owner** or **User Access Administrator**
  on the resource group — Contributor alone fails partway.
- Managed-Prometheus role assignments take ~30 min to propagate; expect HTTP
  403 in the Prometheus log until then. This is expected.
- `enableEntraRbac=true` disables local accounts; run
  `az aks get-credentials` then authenticate via kubelogin with an identity
  holding "Azure Kubernetes Service RBAC Cluster Admin".
- **Cost**: every data-service toggle you flip on adds real spend — Event Hubs
  Premium (1 PU), Azure Managed Redis, a D4ds_v5 Flexible Server — on top of
  the 3+ nodes. All three default to off (everything runs in-cluster).

## Deployment outputs → Rulebricks CLI fields

Run `rulebricks init` after kubeconfig works, then map outputs
(`az deployment group show -g rulebricks-rg -n main --query properties.outputs`)
to wizard fields:

| Output | CLI wizard field |
| --- | --- |
| `clusterName` | cluster selection |
| `rulebricksClientId` | storage/metrics identity (preselected by naming convention) |
| `storageAccountName`, `dataContainer` | storage step — account + container |
| `dceMetricsIngestionEndpoint`, `dcrImmutableId` | monitoring step — remote write URL parts |
| `kafkaBootstrapServers` | external services — Kafka brokers |
| `kafkaConnectionStringCommand` (run it) | external services — Event Hubs connection string |
| `kafkaSolutionPartitions` | deployment `solutionPartitions` (must match) |
| `redisHost`, `redisPort`, `redisTlsEnabled` | external services — Redis host / port / TLS |
| `redisAccessKeyCommand` (run it) | external services — Redis password |
| `postgresHost`, `postgresPort`, `postgresDatabase` | external services — Postgres host / port / database |
| `postgresAdminUsernameOut` + your `@secure` password | external services — bootstrap master credentials |

Secrets never appear in outputs; the two `*Command` outputs print them on
demand for pasting into the wizard (which stores them as Kubernetes secrets).

## Delete the cluster

Run `rulebricks destroy <deployment-name>` first so Kubernetes removes
LoadBalancer services and PVC-backed disks. Then delete the resource group:

```bash
az group delete --name rulebricks-rg --yes
```

AKS cascade-deletes its `MC_*` node resource group; the group delete removes
the cluster, pools, identities, role assignments, federated credentials,
Event Hubs namespace, Managed Redis, Flexible Server, storage, and monitor
resources. Take a final `pg_dump` / storage snapshot first if you need the
data — unlike CloudFormation+RDS, `az group delete` does not snapshot.
