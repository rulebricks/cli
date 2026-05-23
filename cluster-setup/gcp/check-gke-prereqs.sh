#!/usr/bin/env bash
set -euo pipefail

PROJECT_ID="${GOOGLE_CLOUD_PROJECT:-$(gcloud config get-value project 2>/dev/null || true)}"
REGION="${GCP_REGION:-us-central1}"
REQUIRED_VCPU=8
REQUIRED_APIS=(
  compute.googleapis.com
  container.googleapis.com
  iam.googleapis.com
  cloudresourcemanager.googleapis.com
)

require_cmd() {
  command -v "$1" >/dev/null 2>&1 || {
    echo "Missing required command: $1" >&2
    exit 1
  }
}

check_api() {
  local api="$1"
  if gcloud services list \
    --project "$PROJECT_ID" \
    --enabled \
    --filter="name:${api}" \
    --format="value(name)" | awk -v api="$api" '$0 ~ api { found=1 } END { exit found ? 0 : 1 }'; then
    echo "OK: $api is enabled"
  else
    echo "WARN: $api is not enabled. Run: gcloud services enable $api --project $PROJECT_ID"
  fi
}

check_quota() {
  echo "Checking regional CPU quota in $REGION..."
  local quota_line
  quota_line="$(gcloud compute regions describe "$REGION" \
    --project "$PROJECT_ID" \
    --format="csv[no-heading](quotas.metric,quotas.limit,quotas.usage)" 2>/dev/null \
    | awk -F, '$1=="CPUS"{print $2 "," $3; exit}' || true)"

  if [[ -z "$quota_line" ]]; then
    echo "WARN: Could not read regional CPU quota."
    return
  fi

  local limit="${quota_line%,*}"
  local usage="${quota_line#*,}"
  local available
  available="$(awk -v limit="$limit" -v usage="$usage" 'BEGIN { printf "%d", limit - usage }')"

  if (( available < REQUIRED_VCPU )); then
    echo "WARN: ${available}/${limit} CPUs available; ${REQUIRED_VCPU}+ recommended for the included cluster commands."
  else
    echo "OK: ${available}/${limit} CPUs available."
  fi
}

require_cmd gcloud
require_cmd kubectl
require_cmd helm
require_cmd awk

if [[ -z "$PROJECT_ID" ]]; then
  echo "No GCP project configured. Run: gcloud config set project PROJECT_ID" >&2
  exit 1
fi

echo "Rulebricks GKE prerequisite checks"
echo "Project: $PROJECT_ID"
echo "Region: $REGION"
echo

echo "Checking gcloud account..."
gcloud auth list --filter=status:ACTIVE --format="value(account)"
gcloud auth application-default print-access-token >/dev/null
echo "OK: gcloud auth and Application Default Credentials are available."
echo

for api in "${REQUIRED_APIS[@]}"; do
  check_api "$api"
done

echo
gcloud compute regions describe "$REGION" --project "$PROJECT_ID" >/dev/null
echo "OK: region $REGION is accessible."
gcloud container clusters list --region "$REGION" --project "$PROJECT_ID" >/dev/null
echo "OK: GKE cluster list access works."
check_quota

echo
echo "Checking local Kubernetes tools..."
kubectl version --client=true >/dev/null
helm version >/dev/null
echo "OK: kubectl and Helm are installed."

echo
echo "GKE prerequisite checks completed. Warnings may require GCP project-admin review before cluster creation."
