# GCP Enterprise Cluster Setup

A Terraform stack that provisions everything a production Rulebricks
deployment needs on GCP, hardened for enterprise environments and with
**independent true/false toggles** for the managed data services Rulebricks
can externalize to. Terraform is GCP's de-facto IaC (Deployment Manager is
deprecated; Google's own Infrastructure Manager runs Terraform), which is why
this path is `.tf` where AWS gets CloudFormation and Azure gets Bicep.

| Toggle | Managed service | Replaces in-cluster |
| --- | --- | --- |
| `enable_managed_kafka` | Managed Service for Apache Kafka | Strimzi Kafka |
| `enable_managed_redis` | Memorystore for Redis (STANDARD_HA) | Valkey |
| `enable_managed_database` | Cloud SQL for PostgreSQL 17 | Supabase Postgres |

All three default to **false** — the Rulebricks chart runs Kafka, Valkey, and
Postgres in-cluster for whichever you leave off. Any combination is valid.

Even if your team cannot run the stack directly, it is written to be read:
every resource, IAM binding, and variable is commented with why Rulebricks
needs it. Treat it as the authoritative statement of our GCP requirements.

## Files

```
versions.tf              provider pin (hashicorp/google >= 6.30)
variables.tf             every knob, with the sizing/identity rationale inline
network.tf               VPC, VPC-native subnet, Cloud NAT, firewall, base APIs
cluster.tf               GKE: regional, private nodes, Dataplane V2 (Cilium),
                         Workload Identity; core + burst node pools
identity.tf              <cluster>-rulebricks service account + GCS data bucket
kafka.tf                 Managed Kafka cluster + the three topics + client SA
redis.tf                 Memorystore for Redis (AUTH + optional TLS)
database.tf              Cloud SQL PG17 (private IP, logical replication)
outputs.tf               values mapped to the Rulebricks CLI wizard fields
terraform.tfvars.example copy to terraform.tfvars and edit
../check-gke-prereqs.sh  same prerequisite checks as the turnkey guide
```

## Architecture

```
VPC <cluster>-vpc
└─ <cluster>-subnet (10.0.0.0/16; pods 10.1/16, services 10.2/16 secondary)
   ├─ GKE (regional, private nodes, Dataplane V2, Workload Identity)
   │   ├─ core pool: 3-6 x n4-standard-4 (autoscaled, one per zone at floor)
   │   └─ burst pool: 0-1 x n4-standard-16, taint rulebricks.com/pool=burst
   ├─ Managed Kafka  (PSC endpoints in this subnet)   [enable_managed_kafka]
   ├─ Memorystore    (VPC peering, private IP)        [enable_managed_redis]
   └─ Cloud SQL      (Private Services Access range)  [enable_managed_database]

   Cloud NAT (egress for the private node fleet)
   GCS bucket <cluster>-data-<project> (decision-logs/ + db-backups/)
```

- **Nodes and data services have no public IPs.** Node egress rides Cloud NAT;
  Google APIs (GCS, Artifact Registry) ride Private Google Access. All three
  managed data services are VPC-private by construction.
- **Kubernetes API**: public endpoint gated by `master_authorized_cidrs`
  (default open, like the turnkey guide — tighten it, or set
  `enable_private_endpoint = true` for VPC-only access via VPN/bastion).
- **Dataplane V2** is GKE's eBPF/Cilium dataplane and enforces the chart's
  NetworkPolicies natively (parity with the Azure template's Cilium setup).

## Identity model (GKE Workload Identity)

One Google service account, `<cluster>-rulebricks`, holds every data-path
role:

| Role | Scope | Used by |
| --- | --- | --- |
| `roles/storage.objectAdmin` | the data bucket | Vector (decision logs), backup job, ClickHouse archive reads |
| `roles/monitoring.metricWriter` | project | Prometheus remote write to Managed Service for Prometheus |

**This stack does not need a deployment name.** The namespace-scoped Workload
Identity bindings (`roles/iam.workloadIdentityUser` for `vector`,
`<release>-backup`, `prometheus`, `<release>-clickhouse` onto this service
account) are created by the **Rulebricks CLI at `rulebricks deploy` time**, so
one cluster hosts any number of deployments. Two other identities exist and
stay narrow: `<cluster>-nodes` (least-privilege node SA: logging, monitoring,
image pulls) and `<cluster>-kafka` (SASL/PLAIN client for Managed Kafka only).

## Node sizing

Same rationale as the AWS/Azure templates: the chart's steady-state request
floor is ~10 vCPU / ~23 GiB, so the core floor is 3 x `n4-standard-4`
(4 vCPU / 16 GiB — general-purpose 4 GiB/vCPU, because memory runs out before
CPU) with a 6-node ceiling for HPS scaling 3 → 8. The pools use *total*
autoscaling counts (not per-zone), so the floor is exactly 3 nodes, one per
zone. The burst pool (`n4-standard-16`, 16 vCPU / 64 GiB) absorbs the
KEDA-scaled worker fleet — up to 64 workers x 1 GiB requests. N4 machine
types need `hyperdisk-balanced` boot disks (the default here); switch
`node_disk_type` to `pd-balanced` if you drop to N2/E2 shapes.

## Managed data services

### Kafka — Managed Service for Apache Kafka (`enable_managed_kafka`)

- 4 vCPU / 16 GiB cluster (parameterized), reachable only through Private
  Service Connect endpoints in the cluster subnet. TLS always; plaintext is
  not supported by the service.
- **Topics are created here** (the chart's provisioning job only handles AWS
  MSK): `com.rulebricks.solution` and `com.rulebricks.solution-response` at
  the chart-default 128 partitions, `com.rulebricks.logs` at 24, RF 3.
- **Auth**: the chart and Vector speak SASL/PLAIN — username is the
  `<cluster>-kafka` service account email, password is the **base64 of its
  JSON key** (the `kafka_sasl_password_command` output mints and prints it;
  Terraform deliberately never creates the key, so no key material lands in
  state). OAUTHBEARER would avoid the static key but Vector's Kafka client
  cannot use it.
- CLI config: external Kafka, preset **`gcp-managed`** — brokers, username,
  and password from the outputs.

### Redis — Memorystore for Redis (`enable_managed_redis`)

- STANDARD_HA (primary + replica across zones, automatic failover), 4 GiB
  default, Redis 7.2, private VPC peering, **AUTH string enabled**.
- Memorystore for **Redis** rather than the newer Memorystore for Valkey, on
  purpose: the chart authenticates with a static password, which the Valkey
  product does not offer (IAM-only, hourly-expiring tokens the chart cannot
  refresh).
- TLS defaults **off**: Memorystore's in-transit encryption uses a
  per-instance private CA the chart's clients are not configured to trust.
  Traffic is VPC-internal and AUTH-gated regardless; enable
  `redis_transit_encryption` only if you also wire the CA into the clients.
- CLI config: external Redis — host/port from outputs, TLS off, password from
  the `redis_auth_string_command` output.

### Database — Cloud SQL for PostgreSQL (`enable_managed_database`)

- PostgreSQL 17, `db-custom-2-8192` (2 vCPU / 8 GiB) default, regional HA
  toggle, 100 GiB PD-SSD with autoresize, automated backups + PITR, private
  IP only (Private Services Access), deletion protection on.
- Ships **`cloudsql.logical_decoding=on`** (wal_level=logical) plus
  `max_replication_slots`/`max_wal_senders` = 10, because Supabase Realtime
  requires logical replication.
- The master password is a required sensitive variable
  (`TF_VAR_db_master_password`) that sets the built-in `postgres` user — the
  bootstrap master credential the deploy uses once to create Supabase roles
  and schemas.
- **CLI caveat**: the wizard currently offers external Postgres on AWS/Azure
  only. On GCP, set `externalServices.postgres` in the deployment config file
  by hand using the outputs — the chart's external-database path itself is
  cloud-agnostic.

## Check access, create, connect

```bash
gcloud auth login
gcloud config set project <project-id>
gcloud auth application-default login   # Terraform uses ADC
GCP_REGION=us-central1 bash ../check-gke-prereqs.sh

cp terraform.tfvars.example terraform.tfvars   # edit project_id + toggles
export TF_VAR_db_master_password='<strong-password>'   # only if enable_managed_database

terraform init
terraform plan
terraform apply

gcloud container clusters get-credentials rulebricks-cluster \
  --region us-central1 --project <project-id>
```

Notes:

- The deploying principal needs to create networks, GKE clusters, service
  accounts, IAM bindings, buckets, and the toggled data services — `Owner` or
  `Editor` + `Project IAM Admin` on the project is the practical bar.
- Expect ~15 min for the base stack; Managed Kafka adds ~20-30 min, Cloud SQL
  regional ~10-15 min (parallel).
- **Cost**: every toggle you flip on adds real spend on top of the 3+ nodes.
  All three default to off.

## Terraform outputs → Rulebricks CLI fields

Run `rulebricks init` after kubeconfig works, then map outputs
(`terraform output`) to wizard fields:

| Output | CLI wizard field |
| --- | --- |
| `cluster_name` | cluster selection |
| `rulebricks_service_account` | storage step — Google service account (preselected by naming convention) |
| `data_bucket` | storage step — GCS bucket |
| `kafka_bootstrap_servers` | external services — Kafka brokers |
| `kafka_sasl_username` | external services — Kafka username (`gcp-managed` preset) |
| `kafka_sasl_password_command` (run it) | external services — Kafka password |
| `redis_host`, `redis_port`, `redis_tls_enabled` | external services — Redis host / port / TLS |
| `redis_auth_string_command` (run it) | external services — Redis password |
| `postgres_host`, `postgres_port`, `postgres_database`, `postgres_master_username` | `externalServices.postgres` in the config file (see CLI caveat above) |

## Delete the cluster

Run `rulebricks destroy <deployment-name>` first so Kubernetes removes
LoadBalancer services and PVC-backed disks. Then:

```bash
# Deletion protection blocks destroy; lift it first
terraform apply -var cluster_deletion_protection=false -var db_deletion_protection=false

# Empty the data bucket if you want it gone (force_destroy is off on purpose)
gcloud storage rm -r "gs://$(terraform output -raw data_bucket)/**"

terraform destroy
```
