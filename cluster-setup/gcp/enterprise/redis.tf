# Managed Redis: Memorystore for Redis, STANDARD_HA
# (enable_managed_redis = false by default - Valkey runs in-cluster otherwise).
#
# Memorystore for REDIS (not the newer Memorystore for Valkey) on purpose:
# the chart's external-Redis config authenticates with a static password
# (AUTH string), which the Redis product supports; the Valkey product only
# offers IAM auth, whose hourly-expiring tokens the chart cannot refresh.
#
# TLS is off by default: Memorystore's in-transit encryption uses a
# per-instance private CA that Redis clients must be configured to trust,
# which the chart does not do out of the box. Traffic stays inside the VPC
# (direct peering, no public IP) and the AUTH string gates access either way;
# flip redis_transit_encryption on only if you also wire the CA into the
# clients.

resource "google_project_service" "redis" {
  count              = var.enable_managed_redis ? 1 : 0
  service            = "redis.googleapis.com"
  disable_on_destroy = false
}

resource "google_redis_instance" "main" {
  count = var.enable_managed_redis ? 1 : 0

  name           = "${var.cluster_name}-redis"
  region         = var.region
  tier           = "STANDARD_HA" # primary + replica across zones, auto failover
  memory_size_gb = var.redis_memory_size_gb
  redis_version  = "REDIS_7_2"

  authorized_network      = google_compute_network.main.id
  auth_enabled            = true
  transit_encryption_mode = var.redis_transit_encryption ? "SERVER_AUTHENTICATION" : "DISABLED"

  labels = {
    environment = "rulebricks"
  }

  depends_on = [google_project_service.redis]
}
