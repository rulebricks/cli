# Google Cloud GKE Cluster for Rulebricks
# Meets minimum requirements: 4 nodes, 8 vCPU, 16GB RAM per node

terraform {
  required_version = ">= 1.0.0"

  required_providers {
    google = {
      source  = "hashicorp/google"
      version = "~> 5.0"
    }
    google-beta = {
      source  = "hashicorp/google-beta"
      version = "~> 5.0"
    }
  }
}

provider "google" {
  project = var.project_id
  region  = var.region
}

provider "google-beta" {
  project = var.project_id
  region  = var.region
}

# Variables
variable "cluster_name" {
  description = "Name of the GKE cluster"
  type        = string
  default     = "rulebricks-cluster"
}

variable "project_id" {
  description = "GCP project ID"
  type        = string
}

variable "region" {
  description = "GCP region"
  type        = string
  default     = "us-central1"
}

variable "tier" {
  description = "Performance tier: small, medium, large"
  type        = string
  default     = "small"
}

variable "kubernetes_version" {
  description = "Kubernetes version"
  type        = string
  default     = "1.34"
}

variable "enable_external_dns" {
  description = "Enable service account for external-dns (Cloud DNS)"
  type        = bool
  default     = false
}

variable "enable_gcs_logging" {
  description = "Enable service account for Vector GCS logging"
  type        = bool
  default     = false
}

variable "logging_gcs_bucket" {
  description = "GCS bucket name for Vector logs"
  type        = string
  default     = ""
}

# Tier configurations
# Using C4A (Google Axion ARM64) instances for best ARM64 performance
# C4A requires Hyperdisk (does not support Persistent Disk)
locals {
  tier_configs = {
    small = {
      node_count    = 4
      machine_type  = "c4a-standard-2"  # 2 vCPU, 8GB (Google Axion ARM64)
      min_nodes     = 4
      max_nodes     = 4
      disk_size     = 20
    }
    medium = {
      node_count    = 4
      machine_type  = "c4a-standard-4"  # 4 vCPU, 16GB (Google Axion ARM64)
      min_nodes     = 4
      max_nodes     = 8
      disk_size     = 30
    }
    large = {
      node_count    = 5
      machine_type  = "c4a-standard-8"  # 8 vCPU, 32GB (Google Axion ARM64)
      min_nodes     = 5
      max_nodes     = 16
      disk_size     = 50
    }
  }

  config = local.tier_configs[var.tier]
}

# Enable required APIs
resource "google_project_service" "compute" {
  service            = "compute.googleapis.com"
  disable_on_destroy = false
}

resource "google_project_service" "container" {
  service            = "container.googleapis.com"
  disable_on_destroy = false
}

resource "google_project_service" "dns" {
  count              = var.enable_external_dns ? 1 : 0
  service            = "dns.googleapis.com"
  disable_on_destroy = false
}

# VPC Network
resource "google_compute_network" "vpc" {
  name                    = "${var.cluster_name}-vpc"
  auto_create_subnetworks = false

  depends_on = [google_project_service.compute]
}

# Subnet
resource "google_compute_subnetwork" "subnet" {
  name          = "${var.cluster_name}-subnet"
  region        = var.region
  network       = google_compute_network.vpc.name
  ip_cidr_range = "10.0.0.0/16"

  secondary_ip_range {
    range_name    = "pods"
    ip_cidr_range = "10.1.0.0/16"
  }

  secondary_ip_range {
    range_name    = "services"
    ip_cidr_range = "10.2.0.0/16"
  }

  private_ip_google_access = true
}

# Cloud Router for NAT
resource "google_compute_router" "router" {
  name    = "${var.cluster_name}-router"
  region  = var.region
  network = google_compute_network.vpc.id
}

# Cloud NAT
resource "google_compute_router_nat" "nat" {
  name                               = "${var.cluster_name}-nat"
  router                             = google_compute_router.router.name
  region                             = var.region
  nat_ip_allocate_option             = "AUTO_ONLY"
  source_subnetwork_ip_ranges_to_nat = "ALL_SUBNETWORKS_ALL_IP_RANGES"
}

# Firewall rule to allow all internal traffic within the VPC
# This ensures services on any port can communicate between nodes
resource "google_compute_firewall" "allow_internal" {
  name    = "${var.cluster_name}-allow-internal"
  network = google_compute_network.vpc.name

  allow {
    protocol = "tcp"
    ports    = ["0-65535"]
  }

  allow {
    protocol = "udp"
    ports    = ["0-65535"]
  }

  allow {
    protocol = "icmp"
  }

  # Allow traffic from nodes, pods, and services in the same VPC
  source_ranges = [
    google_compute_subnetwork.subnet.ip_cidr_range,                        # Node IPs (10.0.0.0/16)
    google_compute_subnetwork.subnet.secondary_ip_range[0].ip_cidr_range,  # Pod IPs (10.1.0.0/16)
    google_compute_subnetwork.subnet.secondary_ip_range[1].ip_cidr_range   # Service IPs (10.2.0.0/16)
  ]

  # Target all instances in the VPC
  target_tags = ["gke-${var.cluster_name}"]
}

# GKE Cluster
resource "google_container_cluster" "cluster" {
  provider = google-beta

  name     = var.cluster_name
  location = var.region

  # Use VPC-native cluster
  network    = google_compute_network.vpc.name
  subnetwork = google_compute_subnetwork.subnet.name

  # Remove default node pool
  remove_default_node_pool = true
  initial_node_count       = 1

  # Allow terraform destroy to delete the cluster
  deletion_protection = false

  # Cluster configuration
  min_master_version = var.kubernetes_version

  # Enable Workload Identity
  workload_identity_config {
    workload_pool = "${var.project_id}.svc.id.goog"
  }

  # IP allocation policy for VPC-native
  ip_allocation_policy {
    cluster_secondary_range_name  = "pods"
    services_secondary_range_name = "services"
  }

  # Private cluster config
  private_cluster_config {
    enable_private_nodes    = true
    enable_private_endpoint = false
    master_ipv4_cidr_block  = "172.16.0.0/28"
  }

  # Master authorized networks
  master_authorized_networks_config {
    cidr_blocks {
      cidr_block   = "0.0.0.0/0"
      display_name = "All"
    }
  }

  # Release channel
  release_channel {
    channel = "REGULAR"
  }

  # Enable network policy
  network_policy {
    enabled  = true
    provider = "CALICO"
  }

  addons_config {
    http_load_balancing {
      disabled = false
    }
    horizontal_pod_autoscaling {
      disabled = false
    }
    gce_persistent_disk_csi_driver_config {
      enabled = true
    }
  }

  depends_on = [google_project_service.container]
}

# Node Pool
resource "google_container_node_pool" "primary" {
  name     = "rulebricks-nodes"
  location = var.region
  cluster  = google_container_cluster.cluster.name

  node_count = var.tier == "small" ? local.config.node_count : null

  dynamic "autoscaling" {
    for_each = var.tier != "small" ? [1] : []
    content {
      min_node_count = local.config.min_nodes
      max_node_count = local.config.max_nodes
    }
  }

  node_config {
    preemptible  = false
    machine_type = local.config.machine_type
    disk_size_gb = local.config.disk_size
    disk_type    = "hyperdisk-balanced"

    oauth_scopes = [
      "https://www.googleapis.com/auth/cloud-platform"
    ]

    labels = {
      environment = "rulebricks"
      tier        = var.tier
    }

    # Network tags for firewall rules
    tags = ["gke-${var.cluster_name}"]

    workload_metadata_config {
      mode = "GKE_METADATA"
    }
  }

  management {
    auto_repair  = true
    auto_upgrade = true
  }
}

# ============================================
# External DNS Service Account (Cloud DNS)
# ============================================
resource "google_service_account" "external_dns" {
  count        = var.enable_external_dns ? 1 : 0
  account_id   = "${var.cluster_name}-external-dns"
  display_name = "External DNS for Rulebricks"
  description  = "Service account for external-dns to manage Cloud DNS records"
}

resource "google_project_iam_member" "external_dns" {
  count   = var.enable_external_dns ? 1 : 0
  project = var.project_id
  role    = "roles/dns.admin"
  member  = "serviceAccount:${google_service_account.external_dns[0].email}"
}

resource "google_service_account_iam_member" "external_dns_workload_identity" {
  count              = var.enable_external_dns ? 1 : 0
  service_account_id = google_service_account.external_dns[0].name
  role               = "roles/iam.workloadIdentityUser"
  member             = "serviceAccount:${var.project_id}.svc.id.goog[rulebricks/external-dns]"
}

# ============================================
# Vector GCS Logging Service Account
# ============================================
resource "google_service_account" "vector" {
  count        = var.enable_gcs_logging ? 1 : 0
  account_id   = "${var.cluster_name}-vector"
  display_name = "Vector for Rulebricks"
  description  = "Service account for Vector to write logs to GCS"
}

resource "google_storage_bucket_iam_member" "vector_gcs" {
  count  = var.enable_gcs_logging && var.logging_gcs_bucket != "" ? 1 : 0
  bucket = var.logging_gcs_bucket
  role   = "roles/storage.objectCreator"
  member = "serviceAccount:${google_service_account.vector[0].email}"
}

resource "google_service_account_iam_member" "vector_workload_identity" {
  count              = var.enable_gcs_logging ? 1 : 0
  service_account_id = google_service_account.vector[0].name
  role               = "roles/iam.workloadIdentityUser"
  member             = "serviceAccount:${var.project_id}.svc.id.goog[rulebricks/vector]"
}

# Outputs
output "cluster_name" {
  value       = google_container_cluster.cluster.name
  description = "GKE cluster name"
}

output "cluster_endpoint" {
  value       = google_container_cluster.cluster.endpoint
  description = "GKE cluster endpoint"
  sensitive   = true
}

output "cluster_ca_certificate" {
  value       = google_container_cluster.cluster.master_auth[0].cluster_ca_certificate
  description = "Base64 encoded cluster CA certificate"
  sensitive   = true
}

output "region" {
  value       = var.region
  description = "GCP region"
}

output "project_id" {
  value       = var.project_id
  description = "GCP project ID"
}

output "kubeconfig_command" {
  value       = "gcloud container clusters get-credentials ${var.cluster_name} --region ${var.region} --project ${var.project_id}"
  description = "Command to update kubeconfig"
}

output "external_dns_service_account" {
  value       = var.enable_external_dns ? google_service_account.external_dns[0].email : ""
  description = "GCP service account email for external-dns"
}

output "vector_service_account" {
  value       = var.enable_gcs_logging ? google_service_account.vector[0].email : ""
  description = "GCP service account email for Vector"
}
