terraform {
  required_version = ">= 1.8"

  required_providers {
    google = {
      source = "hashicorp/google"
      # 6.30+ for GA google_managed_kafka_cluster/topic; < 8 to avoid
      # unreviewed major-version breaking changes.
      version = ">= 6.30.0, < 8.0.0"
    }
  }
}

provider "google" {
  project = var.project_id
  region  = var.region
}
