#!/usr/bin/env bash
set -euo pipefail

LOCATION="${AZURE_LOCATION:-eastus}"
RESOURCE_GROUP="${AZURE_RESOURCE_GROUP:-}"
REQUIRED_VCPU=8
REQUIRED_PROVIDERS=(
  Microsoft.ContainerService
  Microsoft.Network
  Microsoft.ManagedIdentity
  Microsoft.Compute
  Microsoft.Authorization
  Microsoft.Storage
)

require_cmd() {
  command -v "$1" >/dev/null 2>&1 || {
    echo "Missing required command: $1" >&2
    exit 1
  }
}

check_provider() {
  local provider="$1"
  local state
  state="$(az provider show --namespace "$provider" --query registrationState --output tsv 2>/dev/null || true)"
  if [[ "$state" == "Registered" ]]; then
    echo "OK: $provider is registered"
  else
    echo "WARN: $provider is $state. Run: az provider register --namespace $provider"
  fi
}

check_quota() {
  echo "Checking regional vCPU quota in $LOCATION..."
  local usage
  local limit
  usage="$(az vm list-usage --location "$LOCATION" --query "[?name.value=='cores'].currentValue | [0]" --output tsv 2>/dev/null || true)"
  limit="$(az vm list-usage --location "$LOCATION" --query "[?name.value=='cores'].limit | [0]" --output tsv 2>/dev/null || true)"

  if [[ -z "$usage" || -z "$limit" ]]; then
    echo "WARN: Could not read regional vCPU quota."
    return
  fi

  local available=$((limit - usage))
  if (( available < REQUIRED_VCPU )); then
    echo "WARN: ${available}/${limit} vCPUs available; ${REQUIRED_VCPU}+ recommended for the included cluster config."
  else
    echo "OK: ${available}/${limit} vCPUs available."
  fi
}

check_access() {
  local label="$1"
  shift
  if "$@" >/dev/null 2>&1; then
    echo "OK: $label"
  else
    echo "WARN: Could not verify $label"
    echo "      Command failed: $*"
  fi
}

require_cmd az
require_cmd kubectl
require_cmd helm

echo "Rulebricks AKS prerequisite checks"
echo "Location: $LOCATION"
echo

echo "Checking Azure account..."
az account show --query "{name:name,id:id,state:state,tenantId:tenantId}" --output table
echo

for provider in "${REQUIRED_PROVIDERS[@]}"; do
  check_provider "$provider"
done

echo
check_access "AKS list access" az aks list --output none
check_access "Subscription deployment read access" az deployment sub list --query "[0].name" --output tsv
if [[ -n "$RESOURCE_GROUP" ]]; then
  check_access "Resource group access ($RESOURCE_GROUP)" az group show --name "$RESOURCE_GROUP"
fi
check_quota

echo
echo "Checking local Kubernetes tools..."
kubectl version --client=true >/dev/null
helm version >/dev/null
echo "OK: kubectl and Helm are installed."

echo
echo "AKS prerequisite checks completed. Warnings may require Azure admin review before cluster creation."
