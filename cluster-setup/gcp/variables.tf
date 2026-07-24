# =============================================================================
# Rulebricks GKE cluster - variables.
#
# The three managed data-service toggles (enable_managed_kafka /
# enable_managed_redis / enable_managed_database) all default to FALSE:
# the Rulebricks chart runs Kafka, Valkey, and Postgres in-cluster for
# whichever you leave off. Any combination is valid.
# =============================================================================

variable "project_id" {
  description = "GCP project ID that hosts every resource."
  type        = string
}

variable "region" {
  description = "Region for the cluster and all data services."
  type        = string
  default     = "us-central1"
}

variable "cluster_name" {
  description = <<-EOT
    Name prefix for every resource. The Rulebricks CLI wizard preselects
    resources named <cluster>-rulebricks (service account) and <cluster>-data
    (bucket), so keep the convention if you rename. Keep it short: service
    account IDs cap at 30 chars ("<cluster>-rulebricks" must fit).
  EOT
  type        = string
  default     = "rulebricks-cluster"

  validation {
    condition     = length(var.cluster_name) <= 19
    error_message = "cluster_name must be <= 19 chars so \"<cluster>-rulebricks\" fits the 30-char service account ID limit."
  }
}

variable "kubernetes_version" {
  description = "Minimum GKE master version (REGULAR release channel picks the exact patch)."
  type        = string
  default     = "1.34"
}

# ------------------------------------------------------------------------------
# Network. All three ranges are parameterized for IPAM fit. Pods/services draw
# from the secondary ranges (VPC-native GKE).
# ------------------------------------------------------------------------------
variable "subnet_cidr" {
  description = "Primary subnet range (nodes + internal load balancers)."
  type        = string
  default     = "10.0.0.0/16"
}

variable "pods_cidr" {
  description = "Secondary range for pod IPs."
  type        = string
  default     = "10.1.0.0/16"
}

variable "services_cidr" {
  description = "Secondary range for Kubernetes service IPs."
  type        = string
  default     = "10.2.0.0/16"
}

variable "master_cidr" {
  description = "RFC1918 /28 for the GKE control-plane peering (private nodes)."
  type        = string
  default     = "172.16.0.0/28"
}

variable "master_authorized_cidrs" {
  description = <<-EOT
    CIDRs allowed to reach the Kubernetes API. Default is open so
    kubectl/helm/the Rulebricks CLI work from anywhere; tighten to corporate
    ranges for locked-down environments.
  EOT
  type        = list(string)
  default     = ["0.0.0.0/0"]
}

variable "enable_private_endpoint" {
  description = <<-EOT
    Restrict the Kubernetes API to the VPC (no public endpoint). Requires
    VPN/bastion line-of-sight to run kubectl, helm, and the Rulebricks CLI,
    and master_authorized_cidrs must then be private ranges.
  EOT
  type        = bool
  default     = false
}

# ------------------------------------------------------------------------------
# Node pools. Same sizing rationale as the AWS/Azure templates: the chart's
# steady-state request floor is ~10 vCPU / ~23 GiB, so the core floor is
# 3 x 4-vCPU/16-GiB nodes; the burst pool absorbs the KEDA-scaled worker fleet.
# ------------------------------------------------------------------------------
variable "node_machine_type" {
  description = <<-EOT
    Core pool machine type. n4-standard-4 (4 vCPU / 16 GiB, 4th-gen general
    purpose) - the 4 GiB/vCPU ratio matters: compute-optimized shapes run out
    of memory first. N4 requires hyperdisk-balanced boot disks (node_disk_type).
  EOT
  type        = string
  default     = "n4-standard-4"
}

variable "node_min_count" {
  description = "Core pool floor (total across zones). 3 nodes = 12 vCPU / 48 GiB - fits the chart's ~10 vCPU / ~23 GiB request floor; 2 forced a scale-up mid-install."
  type        = number
  default     = 3
}

variable "node_max_count" {
  description = "Core pool ceiling (total). 6 leaves room for HPS scaling 3->8 (+5 vCPU of requests), which stays on the core pool."
  type        = number
  default     = 6
}

variable "node_disk_type" {
  description = "Boot disk type. hyperdisk-balanced is required for N4 machine types; use pd-balanced for N2/E2."
  type        = string
  default     = "hyperdisk-balanced"
}

variable "node_disk_size_gb" {
  description = "Boot disk size per node."
  type        = number
  default     = 64
}

variable "enable_burst_pool" {
  description = <<-EOT
    Dedicated burst node pool: large nodes (0 -> burst_max_count) labeled and
    tainted rulebricks.com/pool=burst. The Rulebricks chart makes workers
    tolerate and softly prefer it out of the box, keeping the scaled-out
    fleet off the core nodes.
  EOT
  type        = bool
  default     = true
}

variable "burst_machine_type" {
  description = <<-EOT
    Burst pool machine type. Default 16 vCPU / 64 GiB: 3x4 vCPU core floor
    + 16 = 28 vCPU running steady-state at full burst. Memory matters as much
    as cores - workers request 1 GiB each, so the default 64-worker KEDA
    ceiling needs ~64 GiB.
  EOT
  type        = string
  default     = "n4-standard-16"
}

variable "burst_max_count" {
  description = "Maximum burst nodes (total)."
  type        = number
  default     = 1
}

variable "cluster_deletion_protection" {
  description = "Blocks terraform destroy of the GKE cluster. Set false before tearing down."
  type        = bool
  default     = true
}

# ------------------------------------------------------------------------------
# Secrets (External Secrets Operator)
# ------------------------------------------------------------------------------
variable "enable_external_secrets" {
  description = <<-EOT
    Create the <cluster>-secrets Google service account the External Secrets
    Operator's reader Kubernetes ServiceAccount impersonates (via Workload
    Identity, bound by the Rulebricks CLI at deploy time) to sync Secret
    Manager entries into Kubernetes Secrets. Read-only, restricted to secrets
    whose IDs start with secrets_prefix.
  EOT
  type        = bool
  default     = true
}

variable "secrets_prefix" {
  description = <<-EOT
    Secret Manager ID prefix the external-secrets service account may read
    (Secret Manager IDs cannot contain "/", so entries are named like
    <prefix>-<deployment>-app - see the Helm chart's .secrets.example).
  EOT
  type        = string
  default     = "rulebricks"
}

# ------------------------------------------------------------------------------
# Storage (always on; the identity/bucket back every deployment) + metrics
# ------------------------------------------------------------------------------
variable "enable_metrics_writer" {
  description = <<-EOT
    Grant roles/monitoring.metricWriter to the Rulebricks service account for
    Prometheus remote write into Google Cloud Managed Service for Prometheus.
    Off by default; leave off to keep metrics in-cluster or send them to an
    existing observability platform.
  EOT
  type        = bool
  default     = false
}

# ------------------------------------------------------------------------------
# Managed Kafka (Google Cloud Managed Service for Apache Kafka)
# ------------------------------------------------------------------------------
variable "enable_managed_kafka" {
  description = <<-EOT
    Provision Managed Service for Apache Kafka instead of running Kafka
    in-cluster. Pair with CLI config: kafka mode "external", preset
    "gcp-managed" (SASL/PLAIN: username = the kafka client service account
    email, password = base64 of its JSON key - see outputs).
  EOT
  type        = bool
  default     = false
}

variable "kafka_vcpus" {
  description = "Kafka cluster vCPUs (minimum 3)."
  type        = number
  default     = 4
}

variable "kafka_memory_gb" {
  description = "Kafka cluster memory in GiB (1-8 GiB per vCPU)."
  type        = number
  default     = 16
}

variable "kafka_topic_prefix" {
  description = "Kafka topic prefix; must match the deployment's kafkaTopicPrefix (CLI default \"com.rulebricks.\")."
  type        = string
  default     = "com.rulebricks."
}

variable "kafka_solution_partitions" {
  description = "Partitions for the solution and solution-response topics. Caps worker concurrency (KEDA max); matches the chart default."
  type        = number
  default     = 128
}

variable "kafka_logs_partitions" {
  description = "Partitions for the decision-logs topic."
  type        = number
  default     = 24
}

# ------------------------------------------------------------------------------
# Managed Redis (Memorystore for Redis)
# ------------------------------------------------------------------------------
variable "enable_managed_redis" {
  description = <<-EOT
    Provision Memorystore for Redis (STANDARD_HA) instead of running Valkey
    in-cluster. Pair with CLI config: redis mode "external" (host/port/AUTH
    from outputs). Memorystore for Redis is used (not Memorystore for Valkey)
    because it supports the password-style AUTH string the chart expects;
    Valkey-flavor Memorystore only offers hourly-expiring IAM tokens.
  EOT
  type        = bool
  default     = false
}

variable "redis_memory_size_gb" {
  description = "Memorystore capacity in GiB (in-cluster Valkey caps at 4 GiB by default)."
  type        = number
  default     = 4
}

variable "redis_transit_encryption" {
  description = <<-EOT
    Enable TLS (SERVER_AUTHENTICATION) on Memorystore. Default OFF: Memorystore
    TLS uses a per-instance private CA that Redis clients must be configured to
    trust, which the chart does not do out of the box. Traffic stays inside the
    VPC and is protected by the AUTH string either way.
  EOT
  type        = bool
  default     = false
}

# ------------------------------------------------------------------------------
# Managed database (Cloud SQL for PostgreSQL)
# ------------------------------------------------------------------------------
variable "enable_managed_database" {
  description = <<-EOT
    Provision Cloud SQL for PostgreSQL 17 instead of running Postgres
    in-cluster. NOTE: the Rulebricks CLI wizard currently offers external
    Postgres on AWS/Azure only - on GCP, set externalServices.postgres in the
    deployment config file by hand (the chart itself is cloud-agnostic).
    Ships cloudsql.logical_decoding=on because Supabase Realtime requires
    logical replication.
  EOT
  type        = bool
  default     = false
}

variable "db_tier" {
  description = "Cloud SQL machine tier (db-custom-<vCPU>-<memory MiB>)."
  type        = string
  default     = "db-custom-2-8192"
}

variable "db_disk_size_gb" {
  description = "Initial disk size in GiB (autoresize is enabled)."
  type        = number
  default     = 100
}

variable "db_high_availability" {
  description = "Regional (multi-zone) HA for the Cloud SQL instance."
  type        = bool
  default     = true
}

variable "db_master_password" {
  description = <<-EOT
    REQUIRED when enable_managed_database is true. Password for the "postgres"
    master user - pass via TF_VAR_db_master_password or -var, never commit it.
    Becomes the CLI wizard's bootstrap master password.
  EOT
  type        = string
  default     = ""
  sensitive   = true
}

variable "db_deletion_protection" {
  description = "Blocks deletion of the Cloud SQL instance. Set false before tearing down."
  type        = bool
  default     = true
}
