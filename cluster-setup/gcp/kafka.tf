# Managed Kafka: Google Cloud Managed Service for Apache Kafka
# (enable_managed_kafka = false by default - Kafka runs in-cluster otherwise).
#
# The service provisions Private Service Connect endpoints in the cluster
# subnet, so brokers are reachable only inside the VPC. All connections are
# TLS; plaintext is not supported.
#
# AUTH: the chart's Kafka clients (and Vector) use SASL/PLAIN - username is a
# service account email, password is the base64-encoded JSON key of that
# account (the CLI's "gcp-managed" preset collects exactly these two values;
# OAUTHBEARER is not usable because Vector's Kafka client cannot do it).
# Terraform deliberately does NOT create the key (key material would land in
# state) - mint it out-of-band with the kafka_sasl_password_command output.
#
# Topics are created here (the chart's provisioning job only handles MSK IAM),
# partitioned to the chart defaults: solution/solution-response x128, logs x24.

resource "google_project_service" "managedkafka" {
  count              = var.enable_managed_kafka ? 1 : 0
  service            = "managedkafka.googleapis.com"
  disable_on_destroy = false
}

resource "google_managed_kafka_cluster" "main" {
  count = var.enable_managed_kafka ? 1 : 0

  cluster_id = "${var.cluster_name}-kafka"
  location   = var.region

  capacity_config {
    vcpu_count   = var.kafka_vcpus
    memory_bytes = var.kafka_memory_gb * 1073741824
  }

  gcp_config {
    access_config {
      network_configs {
        subnet = local.subnet_full_id
      }
    }
  }

  rebalance_config {
    mode = "AUTO_REBALANCE_ON_SCALE_UP"
  }

  labels = {
    environment = "rulebricks"
  }

  depends_on = [google_project_service.managedkafka]
}

resource "google_managed_kafka_topic" "solution" {
  count = var.enable_managed_kafka ? 1 : 0

  topic_id           = "${var.kafka_topic_prefix}solution"
  cluster            = google_managed_kafka_cluster.main[0].cluster_id
  location           = var.region
  partition_count    = var.kafka_solution_partitions
  replication_factor = 3
}

resource "google_managed_kafka_topic" "solution_response" {
  count = var.enable_managed_kafka ? 1 : 0

  topic_id           = "${var.kafka_topic_prefix}solution-response"
  cluster            = google_managed_kafka_cluster.main[0].cluster_id
  location           = var.region
  partition_count    = var.kafka_solution_partitions
  replication_factor = 3
}

resource "google_managed_kafka_topic" "logs" {
  count = var.enable_managed_kafka ? 1 : 0

  topic_id           = "${var.kafka_topic_prefix}logs"
  cluster            = google_managed_kafka_cluster.main[0].cluster_id
  location           = var.region
  partition_count    = var.kafka_logs_partitions
  replication_factor = 3
}

# Dedicated client identity for SASL/PLAIN. Kept separate from
# <cluster>-rulebricks so the static key credential carries Kafka access only.
resource "google_service_account" "kafka_client" {
  count = var.enable_managed_kafka ? 1 : 0

  account_id   = "${var.cluster_name}-kafka"
  display_name = "Rulebricks Kafka client (SASL/PLAIN)"
}

resource "google_project_iam_member" "kafka_client_role" {
  count   = var.enable_managed_kafka ? 1 : 0
  project = var.project_id
  role    = "roles/managedkafka.client"
  member  = "serviceAccount:${google_service_account.kafka_client[0].email}"
}
