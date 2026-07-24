# Outputs, grouped by the Rulebricks CLI wizard step that consumes them.
# Secrets never appear here - the *_command outputs print them on demand.

# --- Cluster ------------------------------------------------------------------
output "cluster_name" {
  value = google_container_cluster.main.name
}

output "kubeconfig_command" {
  value = "gcloud container clusters get-credentials ${google_container_cluster.main.name} --region ${var.region} --project ${var.project_id}"
}

output "workload_identity_pool" {
  description = "The pool the Rulebricks CLI federates Kubernetes service accounts through at deploy time."
  value       = "${var.project_id}.svc.id.goog"
}

# --- Storage + identity (CLI storage step) -------------------------------------
output "rulebricks_service_account" {
  description = "CLI storage/metrics identity - enter this Google service account email in the wizard."
  value       = google_service_account.rulebricks.email
}

output "data_bucket" {
  description = "CLI storage step - GCS bucket for decision logs and DB backups."
  value       = google_storage_bucket.data.name
}

# --- Secrets (CLI secrets step) --------------------------------------------------
output "external_secrets_service_account" {
  description = "Read-only GSA the External Secrets Operator reader impersonates; the CLI's secrets step preselects it."
  value       = var.enable_external_secrets ? google_service_account.external_secrets[0].email : ""
}

output "secrets_prefix" {
  description = "Secret Manager ID prefix the service account may read (entries named <prefix>-<deployment>-app etc.)."
  value       = var.enable_external_secrets ? var.secrets_prefix : ""
}

# --- Managed Kafka (CLI external-services step, preset gcp-managed) ------------
output "kafka_bootstrap_servers" {
  description = "CLI wizard Kafka brokers field (TLS, port 9092)."
  value = var.enable_managed_kafka ? (
    "bootstrap.${google_managed_kafka_cluster.main[0].cluster_id}.${var.region}.managedkafka.${var.project_id}.cloud.goog:9092"
  ) : ""
}

output "kafka_topics" {
  value = var.enable_managed_kafka ? [
    google_managed_kafka_topic.solution[0].topic_id,
    google_managed_kafka_topic.solution_response[0].topic_id,
    google_managed_kafka_topic.logs[0].topic_id,
  ] : []
}

output "kafka_sasl_username" {
  description = "CLI wizard Kafka username field (SASL/PLAIN username = service account email)."
  value       = var.enable_managed_kafka ? google_service_account.kafka_client[0].email : ""
}

output "kafka_sasl_password_command" {
  description = <<-EOT
    Mints a key for the Kafka client service account and prints the SASL/PLAIN
    password (base64 of the JSON key) - paste into the CLI wizard's Kafka
    password field. Terraform does not create the key on purpose (it would
    land in state). Rotate by re-running and deleting the old key.
  EOT
  value = var.enable_managed_kafka ? (
    "gcloud iam service-accounts keys create /dev/stdout --iam-account=${google_service_account.kafka_client[0].email} | base64"
  ) : ""
}

# --- Managed Redis (CLI external-services step) ---------------------------------
output "redis_host" {
  description = "CLI wizard Redis host field."
  value       = var.enable_managed_redis ? google_redis_instance.main[0].host : ""
}

output "redis_port" {
  description = "CLI wizard Redis port field."
  value       = var.enable_managed_redis ? google_redis_instance.main[0].port : 0
}

output "redis_tls_enabled" {
  description = "CLI wizard Redis TLS toggle (see redis.tf for why this defaults off on Memorystore)."
  value       = var.enable_managed_redis ? var.redis_transit_encryption : false
}

output "redis_auth_string_command" {
  description = "Prints the AUTH string - paste into the CLI wizard's Redis password field."
  value = var.enable_managed_redis ? (
    "gcloud redis instances get-auth-string ${google_redis_instance.main[0].name} --region ${var.region} --project ${var.project_id}"
  ) : ""
}

# --- Managed database (chart external Postgres; see database.tf CLI note) ------
output "postgres_host" {
  description = "Private IP of the Cloud SQL instance (externalServices.postgres.external.host)."
  value       = var.enable_managed_database ? google_sql_database_instance.main[0].private_ip_address : ""
}

output "postgres_port" {
  value = var.enable_managed_database ? 5432 : 0
}

output "postgres_database" {
  value = var.enable_managed_database ? "postgres" : ""
}

output "postgres_master_username" {
  description = "Bootstrap master username (password = the db_master_password you passed)."
  value       = var.enable_managed_database ? "postgres" : ""
}

output "postgres_connection_name" {
  description = "For Cloud SQL tooling (proxy/psql via gcloud), not needed by the chart."
  value       = var.enable_managed_database ? google_sql_database_instance.main[0].connection_name : ""
}
