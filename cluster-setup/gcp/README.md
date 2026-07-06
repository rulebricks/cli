# GCP Cluster Setup (GKE)

One Terraform module (`*.tf` in this directory). Managed Kafka, Memorystore
Redis, Cloud SQL Postgres, and the metrics-writer grant are independent
toggles that **default to off** — the Rulebricks chart runs those services
in-cluster until you enable them.

> This IaC is a reference implementation. Treat it as a starting point and
> customize it to accommodate pre-existing services (VPCs, buckets, databases)
> or unique performance requirements.

## 1. Parameters (variables)

Cluster:

| Variable | Default | Purpose |
| --- | --- | --- |
| `project_id` | — (required) | Target GCP project |
| `region` | `us-central1` | Region for all resources |
| `cluster_name` | `rulebricks-cluster` | Prefixes every resource name; the CLI preselects `<cluster>-rulebricks` / `<cluster>-data-*` by convention |
| `kubernetes_version` | `1.34` | GKE version prefix |
| `cluster_deletion_protection` | `true` | Blocks `terraform destroy`; set `false` before teardown |

Networking:

| Variable | Default | Purpose |
| --- | --- | --- |
| `subnet_cidr` / `pods_cidr` / `services_cidr` | `10.0.0.0/16` / `10.1.0.0/16` / `10.2.0.0/16` | Node subnet + secondary ranges |
| `master_cidr` | `172.16.0.0/28` | Control-plane peering range |
| `master_authorized_cidrs` | `["0.0.0.0/0"]` | Restrict who can reach the Kubernetes API |
| `enable_private_endpoint` | `false` | Private-only API endpoint (needs VPN/bastion) |

Node pools:

| Variable | Default | Purpose |
| --- | --- | --- |
| `node_machine_type` | `n4-standard-4` | Core nodes (4 vCPU / 16 GiB) |
| `node_min_count` / `node_max_count` | `3` / `6` | Core pool autoscaling |
| `node_disk_type` / `node_disk_size_gb` | `hyperdisk-balanced` / `64` | Node disks |
| `enable_burst_pool` | `true` | Worker pool, taint `rulebricks.com/pool=burst`, scales 0-N |
| `burst_machine_type` / `burst_max_count` | `n4-standard-16` / `1` | 16 vCPU / 64 GiB burst nodes |

Metrics:

| Variable | Default | Purpose |
| --- | --- | --- |
| `enable_metrics_writer` | `false` | Grant `roles/monitoring.metricWriter` for Prometheus remote write to Managed Service for Prometheus |

Managed services (all off by default; the sizing variables below each toggle
are ignored unless that toggle is `true`, so they cannot create a bad state):

| Variable | Default | Purpose |
| --- | --- | --- |
| `enable_managed_kafka` | `false` | Managed Service for Apache Kafka instead of in-cluster Kafka |
| `kafka_vcpus` / `kafka_memory_gb` | `4` / `16` | Kafka cluster capacity |
| `kafka_topic_prefix` / `kafka_solution_partitions` / `kafka_logs_partitions` | `com.rulebricks.` / `128` / `24` | Topics created here (match the chart config) |
| `enable_managed_redis` | `false` | Memorystore for Redis (STANDARD_HA) instead of in-cluster Valkey |
| `redis_memory_size_gb` / `redis_transit_encryption` | `4` / `false` | Capacity / TLS |
| `enable_managed_database` | `false` | Cloud SQL for PostgreSQL 17 instead of in-cluster Postgres |
| `db_tier` / `db_disk_size_gb` / `db_high_availability` | `db-custom-2-8192` / `100` / `true` | Instance sizing / HA |
| `db_master_password` | `""` | **Required** when the DB toggle is on; pass via `TF_VAR_db_master_password` |
| `db_deletion_protection` | `true` | Blocks destroy of the instance; set `false` before teardown |

## 2. Deployed resources

Always created:

| Resource | Type | Name / notes |
| --- | --- | --- |
| Project APIs | `google_project_service` | container, compute, etc. (stay enabled after destroy) |
| VPC + subnet | `google_compute_network`, `google_compute_subnetwork` | `<cluster>-vpc`, `<cluster>-subnet` (pods/services secondary ranges) |
| Cloud Router + NAT | `google_compute_router`, `google_compute_router_nat` | `<cluster>-router`, `<cluster>-nat` (private nodes egress) |
| Firewalls | `google_compute_firewall` x2 | `<cluster>-allow-internal`, `<cluster>-allow-web` (80/443) |
| Node service account | `google_service_account` | `<cluster>-nodes` + 5 least-privilege project roles (logging, monitoring, artifact registry) |
| GKE cluster | `google_container_cluster` | `<cluster>`; private nodes, Dataplane V2, Workload Identity pool `<project>.svc.id.goog` |
| Node pools | `google_container_node_pool` x2 | `core` (3-6 nodes), `burst` (0-N, taint `rulebricks.com/pool=burst`, when `enable_burst_pool`) |
| Rulebricks service account | `google_service_account` | `<cluster>-rulebricks`; the single workload identity the CLI binds at deploy time |
| Data bucket | `google_storage_bucket` | `<cluster>-data-<project>`; uniform access, public access prevented; `roles/storage.objectAdmin` for the Rulebricks SA |

Conditionally created:

| Resource | Type | Condition |
| --- | --- | --- |
| `roles/monitoring.metricWriter` grant | `google_project_iam_member` | `enable_metrics_writer` |
| Managed Kafka cluster + 3 topics + client SA | `google_managed_kafka_cluster` (`<cluster>-kafka`), `google_managed_kafka_topic` x3, `google_service_account` (`<cluster>-kafka`) | `enable_managed_kafka` |
| Memorystore Redis | `google_redis_instance` (`<cluster>-redis`, STANDARD_HA) | `enable_managed_redis` |
| Cloud SQL PostgreSQL 17 + PSA peering | `google_sql_database_instance` (`<cluster>-db`, `cloudsql.logical_decoding=on`), `google_compute_global_address` + `google_service_networking_connection` (`<cluster>-psa`) | `enable_managed_database` |

## 3. Manual provisioning still required

- **Variables file**: `cp terraform.tfvars.example terraform.tfvars` and set `project_id` (never commit `terraform.tfvars`; it may hold the DB password).
- **DB password** (only when `enable_managed_database=true`): `export TF_VAR_db_master_password='<strong-password>'`.
- **Kubeconfig** (after apply): run the `kubeconfig_command` output; requires the `gke-gcloud-auth-plugin` component.
- **DNS**: point your app domain at the load balancer the chart creates during `rulebricks deploy`.
- **External Cloud SQL caveat**: the CLI wizard does not prompt for GCP Postgres — set the `postgres_*` outputs in the deployment config file by hand.
- Workload Identity bindings are **not** manual — the Rulebricks CLI creates them at `rulebricks deploy` time.

### Bring your own cluster

If your GKE cluster was not created by this module, `rulebricks deploy` needs (validated at preflight):

1. A Workload Identity pool on the cluster:

```bash
gcloud container clusters update <cluster> --location <region> \
  --workload-pool=<project>.svc.id.goog
```

2. A dedicated Google service account with object access on your bucket — never the default compute SA:

```bash
gcloud iam service-accounts create <cluster>-rulebricks --project <project>
gcloud storage buckets add-iam-policy-binding gs://<bucket> \
  --member "serviceAccount:<cluster>-rulebricks@<project>.iam.gserviceaccount.com" \
  --role roles/storage.objectAdmin
```

## 4. Deploy

```bash
bash check-gke-prereqs.sh   # verifies gcloud auth, APIs, quota

terraform init
terraform plan    # review
terraform apply

# kubeconfig (also printed as the kubeconfig_command output)
gcloud container clusters get-credentials rulebricks-cluster \
  --region us-central1 --project <project>
```

- Timing: ~15-20 min base; Managed Kafka adds ~20 min, Cloud SQL HA ~10-15 min (parallel).
- Then run `rulebricks init`; Terraform outputs map 1:1 to wizard fields (`terraform output`).

## 5. Take down

```bash
# 1. Remove Kubernetes-created resources first (load balancers, PVC-backed disks)
rulebricks destroy <deployment-name>

# 2. Empty the data bucket (destroy fails on non-empty buckets). NOTE: the
#    bucket holds your decision-log archives (decision-logs/) and database
#    backups (db-backups/) - emptying it destroys them permanently, so copy
#    out anything you need first.
gcloud storage rm -r "gs://rulebricks-cluster-data-<project>/**"

# 3. Lift deletion protection, then destroy
terraform apply -var cluster_deletion_protection=false -var db_deletion_protection=false
terraform destroy -var cluster_deletion_protection=false -var db_deletion_protection=false
```

Resources that linger after `terraform destroy` — check and remove manually:

| Leftover | Why | Cleanup |
| --- | --- | --- |
| Kubernetes load balancers / persistent disks | Provisioned by the cluster, not Terraform | `rulebricks destroy` before `terraform destroy`; otherwise delete via the console |
| Enabled project APIs | `google_project_service` is created with destroy disabled to avoid breaking shared projects | Disable via `gcloud services disable` if truly unused |
| Private service access peering | The PSA connection (`<cluster>-psa`) can survive if Cloud SQL deletion races the VPC | `gcloud services vpc-peerings delete` |
| Terraform state | Local `terraform.tfstate` (and `terraform.tfvars` with secrets) | Delete locally once done |
