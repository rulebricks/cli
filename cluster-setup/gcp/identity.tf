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

# ------------------------------------------------------------------------------
# External Secrets Operator identity (AWS <cluster>-external-secrets / Azure
# Key Vault reader parity). Read-only, restricted by IAM condition to Secret
# Manager entries whose IDs start with secrets_prefix. The namespace-scoped
# roles/iam.workloadIdentityUser binding to the ESO reader Kubernetes
# ServiceAccount is created by the Rulebricks CLI at deploy time, like every
# other workload identity here. Named <cluster>-secrets (not
# -external-secrets) to fit the 30-char service account ID limit.
# ------------------------------------------------------------------------------
resource "google_project_service" "secretmanager" {
  count              = var.enable_external_secrets ? 1 : 0
  service            = "secretmanager.googleapis.com"
  disable_on_destroy = false
}

data "google_project" "current" {}

resource "google_service_account" "external_secrets" {
  count        = var.enable_external_secrets ? 1 : 0
  account_id   = "${var.cluster_name}-secrets"
  display_name = "External Secrets Operator reader (Rulebricks)"

  depends_on = [google_project_service.base]
}

resource "google_project_iam_member" "external_secrets_accessor" {
  count   = var.enable_external_secrets ? 1 : 0
  project = var.project_id
  role    = "roles/secretmanager.secretAccessor"
  member  = "serviceAccount:${google_service_account.external_secrets[0].email}"

  # IAM conditions on Secret Manager match the project NUMBER, not the ID.
  condition {
    title       = "rulebricks-secrets-only"
    description = "Read only Secret Manager entries under the Rulebricks prefix"
    expression  = "resource.name.startsWith(\"projects/${data.google_project.current.number}/secrets/${var.secrets_prefix}\")"
  }

  depends_on = [google_project_service.secretmanager]
}

# ESO's SecretStore also calls DescribeSecret-style metadata reads.
resource "google_project_iam_member" "external_secrets_viewer" {
  count   = var.enable_external_secrets ? 1 : 0
  project = var.project_id
  role    = "roles/secretmanager.viewer"
  member  = "serviceAccount:${google_service_account.external_secrets[0].email}"

  condition {
    title       = "rulebricks-secrets-only"
    description = "View only Secret Manager entries under the Rulebricks prefix"
    expression  = "resource.name.startsWith(\"projects/${data.google_project.current.number}/secrets/${var.secrets_prefix}\")"
  }

  depends_on = [google_project_service.secretmanager]
}
