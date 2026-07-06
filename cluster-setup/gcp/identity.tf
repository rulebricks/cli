# Rulebricks workload identity + object storage.
#
# One Google service account, <cluster>-rulebricks, holds every data-path
# role; all data lives in one GCS bucket under per-purpose prefixes
# (decision-logs/ and db-backups/). The namespace-scoped Workload Identity
# bindings (roles/iam.workloadIdentityUser for vector / <release>-backup /
# prometheus / <release>-clickhouse) are created by the Rulebricks CLI at
# `rulebricks deploy` time - which keeps this stack deployment-independent:
# one cluster hosts any number of deployments.

resource "google_service_account" "rulebricks" {
  account_id   = "${var.cluster_name}-rulebricks"
  display_name = "Rulebricks data plane (decision logs, backups, metrics)"
}

resource "google_storage_bucket" "data" {
  # Bucket names are global; the project suffix keeps the <cluster>-data
  # convention (which the CLI wizard preselects on) collision-free.
  name     = "${var.cluster_name}-data-${var.project_id}"
  location = var.region

  uniform_bucket_level_access = true
  public_access_prevention    = "enforced"

  labels = {
    environment = "rulebricks"
  }

  depends_on = [google_project_service.base]
}

# Read/write/delete on the one bucket: Vector writes decision-logs/, the
# backup job writes and prunes db-backups/, ClickHouse reads the archive.
resource "google_storage_bucket_iam_member" "rulebricks_object_admin" {
  bucket = google_storage_bucket.data.name
  role   = "roles/storage.objectAdmin"
  member = "serviceAccount:${google_service_account.rulebricks.email}"
}

# Prometheus remote write into Google Cloud Managed Service for Prometheus
# (monitoring.googleapis.com ingest). Project-scoped by necessity.
resource "google_project_iam_member" "rulebricks_metric_writer" {
  count   = var.enable_metrics_writer ? 1 : 0
  project = var.project_id
  role    = "roles/monitoring.metricWriter"
  member  = "serviceAccount:${google_service_account.rulebricks.email}"
}
