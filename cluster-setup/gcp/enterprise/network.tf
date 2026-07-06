# Network: custom-mode VPC, one VPC-native subnet (pods/services in secondary
# ranges), Cloud NAT for private-node egress, and explicit firewall rules.
# Managed data services attach privately: Managed Kafka provisions Private
# Service Connect endpoints in this subnet, Memorystore peers directly, and
# Cloud SQL uses a Private Services Access range (see database.tf).

locals {
  subnet_full_id = "projects/${var.project_id}/regions/${var.region}/subnetworks/${google_compute_subnetwork.main.name}"
}

# --- Required APIs (base; data-service APIs live with their toggles) ---------
resource "google_project_service" "base" {
  for_each = toset([
    "compute.googleapis.com",
    "container.googleapis.com",
    "iam.googleapis.com",
    "cloudresourcemanager.googleapis.com",
    "storage.googleapis.com",
    "monitoring.googleapis.com",
  ])
  service            = each.key
  disable_on_destroy = false
}

resource "google_compute_network" "main" {
  name                    = "${var.cluster_name}-vpc"
  auto_create_subnetworks = false
  depends_on              = [google_project_service.base]
}

resource "google_compute_subnetwork" "main" {
  name                     = "${var.cluster_name}-subnet"
  region                   = var.region
  network                  = google_compute_network.main.id
  ip_cidr_range            = var.subnet_cidr
  private_ip_google_access = true # Google APIs (GCS, Artifact Registry) without NAT

  secondary_ip_range {
    range_name    = "pods"
    ip_cidr_range = var.pods_cidr
  }
  secondary_ip_range {
    range_name    = "services"
    ip_cidr_range = var.services_cidr
  }
}

# --- NAT egress for the private node fleet -----------------------------------
resource "google_compute_router" "main" {
  name    = "${var.cluster_name}-router"
  region  = var.region
  network = google_compute_network.main.id
}

resource "google_compute_router_nat" "main" {
  name                               = "${var.cluster_name}-nat"
  router                             = google_compute_router.main.name
  region                             = var.region
  nat_ip_allocate_option             = "AUTO_ONLY"
  source_subnetwork_ip_ranges_to_nat = "ALL_SUBNETWORKS_ALL_IP_RANGES"
}

# --- Firewall -----------------------------------------------------------------
# GKE manages LB health-check/data rules for LoadBalancer services itself;
# these two mirror the turnkey guide for reviewability.
resource "google_compute_firewall" "allow_internal" {
  name    = "${var.cluster_name}-allow-internal"
  network = google_compute_network.main.name

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

  source_ranges = [var.subnet_cidr, var.pods_cidr, var.services_cidr]
  target_tags   = ["gke-${var.cluster_name}"]
}

# Traefik's LoadBalancer service; 80 exists for ACME HTTP-01 + the
# HTTP->HTTPS redirect. Tighten source_ranges to corporate CIDRs for
# internal-only deployments.
resource "google_compute_firewall" "allow_web" {
  name    = "${var.cluster_name}-allow-web"
  network = google_compute_network.main.name

  allow {
    protocol = "tcp"
    ports    = ["80", "443"]
  }

  source_ranges = ["0.0.0.0/0"]
  target_tags   = ["gke-${var.cluster_name}"]
}
