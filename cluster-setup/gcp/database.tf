# Managed database: Cloud SQL for PostgreSQL 17
# (enable_managed_database = false by default - Postgres runs in-cluster
# otherwise).
#
# Private IP only, via Private Services Access (a reserved range peered to
# Google's service network). Supabase Realtime requires LOGICAL REPLICATION,
# so the instance ships cloudsql.logical_decoding=on (wal_level=logical) plus
# slot/sender headroom - the same posture as the AWS/Azure templates.
#
# NOTE: the Rulebricks CLI wizard currently offers external Postgres on
# AWS/Azure only. On GCP, set externalServices.postgres in the deployment
# config file by hand (host/port/database/bootstrap from the outputs); the
# chart's external-database path itself is cloud-agnostic.

resource "google_project_service" "database" {
  for_each = var.enable_managed_database ? toset([
    "sqladmin.googleapis.com",
    "servicenetworking.googleapis.com",
  ]) : toset([])
  service            = each.key
  disable_on_destroy = false
}

# --- Private Services Access (required for Cloud SQL private IP) -------------
resource "google_compute_global_address" "psa_range" {
  count = var.enable_managed_database ? 1 : 0

  name          = "${var.cluster_name}-psa"
  purpose       = "VPC_PEERING"
  address_type  = "INTERNAL"
  prefix_length = 16
  network       = google_compute_network.main.id
}

resource "google_service_networking_connection" "psa" {
  count = var.enable_managed_database ? 1 : 0

  network                 = google_compute_network.main.id
  service                 = "servicenetworking.googleapis.com"
  reserved_peering_ranges = [google_compute_global_address.psa_range[0].name]

  depends_on = [google_project_service.database]
}

# --- Instance -----------------------------------------------------------------
resource "google_sql_database_instance" "main" {
  count = var.enable_managed_database ? 1 : 0

  name                = "${var.cluster_name}-db"
  region              = var.region
  database_version    = "POSTGRES_17"
  deletion_protection = var.db_deletion_protection

  settings {
    tier              = var.db_tier
    edition           = "ENTERPRISE"
    availability_type = var.db_high_availability ? "REGIONAL" : "ZONAL"
    disk_type         = "PD_SSD"
    disk_size         = var.db_disk_size_gb
    disk_autoresize   = true

    ip_configuration {
      ipv4_enabled    = false # private IP only
      private_network = google_compute_network.main.id
    }

    backup_configuration {
      enabled                        = true
      point_in_time_recovery_enabled = true
      start_time                     = "02:00"
    }

    # wal_level=logical for Supabase Realtime; the Rulebricks CLI preflights
    # logical replication on external Postgres and blocks the deploy when off.
    database_flags {
      name  = "cloudsql.logical_decoding"
      value = "on"
    }
    database_flags {
      name  = "max_replication_slots"
      value = "10"
    }
    database_flags {
      name  = "max_wal_senders"
      value = "10"
    }

    user_labels = {
      environment = "rulebricks"
    }
  }

  depends_on = [google_service_networking_connection.psa]
}

# Sets the password on the built-in "postgres" superuser - the bootstrap
# master credential the Rulebricks deploy uses once to create the Supabase
# roles and schemas.
resource "google_sql_user" "master" {
  count = var.enable_managed_database ? 1 : 0

  name     = "postgres"
  instance = google_sql_database_instance.main[0].name
  password = var.db_master_password

  lifecycle {
    precondition {
      condition     = var.db_master_password != ""
      error_message = "db_master_password is required when enable_managed_database is true (pass via TF_VAR_db_master_password)."
    }
  }
}
