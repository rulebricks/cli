# GKE: regional, private nodes, VPC-native, Dataplane V2 (Cilium - enforces
# the chart's NetworkPolicies natively), Workload Identity enabled.
#
# Node pools carry the same contract the Rulebricks chart targets everywhere:
# a core pool for always-on services and a burst pool labeled and tainted
# rulebricks.com/pool=burst that the KEDA-scaled worker fleet lands on.

# Least-privilege node service account (GKE default SA is over-broad).
resource "google_service_account" "nodes" {
  account_id   = "${var.cluster_name}-nodes"
  display_name = "Rulebricks GKE node pool"
}

resource "google_project_iam_member" "node_roles" {
  for_each = toset([
    "roles/logging.logWriter",
    "roles/monitoring.metricWriter",
    "roles/monitoring.viewer",
    "roles/stackdriver.resourceMetadata.writer",
    "roles/artifactregistry.reader",
  ])
  project = var.project_id
  role    = each.key
  member  = "serviceAccount:${google_service_account.nodes.email}"
}

resource "google_container_cluster" "main" {
  name     = var.cluster_name
  location = var.region # regional: HA control plane, nodes spread across zones

  min_master_version = var.kubernetes_version
  release_channel {
    channel = "REGULAR"
  }

  network    = google_compute_network.main.id
  subnetwork = google_compute_subnetwork.main.id

  networking_mode = "VPC_NATIVE"
  ip_allocation_policy {
    cluster_secondary_range_name  = "pods"
    services_secondary_range_name = "services"
  }

  # Dataplane V2 = eBPF/Cilium dataplane with built-in NetworkPolicy
  # enforcement (parity with the Azure template's CNI Overlay + Cilium).
  datapath_provider = "ADVANCED_DATAPATH"

  private_cluster_config {
    enable_private_nodes    = true # nodes have no public IPs; egress via Cloud NAT
    enable_private_endpoint = var.enable_private_endpoint
    master_ipv4_cidr_block  = var.master_cidr
  }

  master_authorized_networks_config {
    dynamic "cidr_blocks" {
      for_each = var.master_authorized_cidrs
      content {
        cidr_block   = cidr_blocks.value
        display_name = "authorized"
      }
    }
  }

  # HARD REQUIREMENT: the Rulebricks CLI federates Kubernetes service
  # accounts to the <cluster>-rulebricks Google service account through this
  # pool at deploy time (keyless GCS/monitoring auth).
  workload_identity_config {
    workload_pool = "${var.project_id}.svc.id.goog"
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

  # We manage node pools explicitly below.
  remove_default_node_pool = true
  initial_node_count       = 1

  deletion_protection = var.cluster_deletion_protection

  resource_labels = {
    environment = "rulebricks"
  }

  depends_on = [google_project_service.base]
}

# --- Core pool: always-on services --------------------------------------------
resource "google_container_node_pool" "core" {
  name     = "core"
  location = var.region
  cluster  = google_container_cluster.main.name

  initial_node_count = 1 # per zone; a regional pool starts at 3 total

  autoscaling {
    # total_* counts are cluster-wide (not per-zone) - the floor is exactly
    # 3 nodes, one per zone.
    total_min_node_count = var.node_min_count
    total_max_node_count = var.node_max_count
    location_policy      = "BALANCED"
  }

  management {
    auto_repair  = true
    auto_upgrade = true
  }

  node_config {
    machine_type    = var.node_machine_type
    disk_type       = var.node_disk_type
    disk_size_gb    = var.node_disk_size_gb
    service_account = google_service_account.nodes.email
    oauth_scopes    = ["https://www.googleapis.com/auth/cloud-platform"]
    tags            = ["gke-${var.cluster_name}"]

    workload_metadata_config {
      mode = "GKE_METADATA" # required for Workload Identity
    }

    labels = {
      environment = "rulebricks"
    }
  }
}

# --- Burst pool: the KEDA-scaled worker fleet ----------------------------------
# The taint keeps everything except workers off it; the label is what the
# chart's soft worker affinity targets. GKE has no parked-VM (Deallocate)
# equivalent, so bursts cold-provision (~2 min); the warm worker floor on the
# core nodes carries traffic during provisioning.
resource "google_container_node_pool" "burst" {
  count = var.enable_burst_pool ? 1 : 0

  name     = "burst"
  location = var.region
  cluster  = google_container_cluster.main.name

  initial_node_count = 0

  autoscaling {
    total_min_node_count = 0
    total_max_node_count = var.burst_max_count
    location_policy      = "ANY" # one big node wherever capacity exists
  }

  management {
    auto_repair  = true
    auto_upgrade = true
  }

  node_config {
    machine_type    = var.burst_machine_type
    disk_type       = var.node_disk_type
    disk_size_gb    = var.node_disk_size_gb
    service_account = google_service_account.nodes.email
    oauth_scopes    = ["https://www.googleapis.com/auth/cloud-platform"]
    tags            = ["gke-${var.cluster_name}"]

    workload_metadata_config {
      mode = "GKE_METADATA"
    }

    labels = {
      environment           = "rulebricks"
      "rulebricks.com/pool" = "burst"
    }

    taint {
      key    = "rulebricks.com/pool"
      value  = "burst"
      effect = "NO_SCHEDULE"
    }
  }
}
