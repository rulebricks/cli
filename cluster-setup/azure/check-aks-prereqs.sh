#!/usr/bin/env bash
set -euo pipefail

if [[ -z "${BASH_VERSION:-}" ]]; then
  exec bash "$0" "$@"
fi

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PARAMETERS_FILE="$SCRIPT_DIR/parameters.test.json"
RESOURCE_GROUP="${AZURE_RESOURCE_GROUP:-}"
LOCATION_OVERRIDE="${AZURE_LOCATION:-}"
VERBOSE="${VERBOSE:-0}"

usage() {
  printf '%s\n' \
    "Usage: bash check-aks-prereqs.sh [options]" \
    "" \
    "  --parameters FILE      ARM parameter file to inspect" \
    "  --resource-group NAME  Existing deployment resource group" \
    "  --location REGION      Override the region in the parameter file" \
    "  -h, --help             Show this help"
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --parameters) PARAMETERS_FILE="${2:?missing parameter file}"; shift 2 ;;
    --resource-group) RESOURCE_GROUP="${2:?missing resource group}"; shift 2 ;;
    --location) LOCATION_OVERRIDE="${2:?missing location}"; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) usage >&2; printf 'ERROR: unknown option: %s\n' "$1" >&2; exit 2 ;;
  esac
done

export AZURE_CORE_SURVEY_MESSAGE=no
export AZURE_CORE_COLLECT_TELEMETRY=no

require_cmd() {
  command -v "$1" >/dev/null 2>&1 || {
    printf 'ERROR: required command not found: %s\n' "$1" >&2
    exit 1
  }
}

require_cmd az
require_cmd jq
require_cmd kubectl
require_cmd helm

[[ -f "$PARAMETERS_FILE" ]] || {
  printf 'ERROR: parameter file not found: %s\n' "$PARAMETERS_FILE" >&2
  exit 1
}
jq empty "$PARAMETERS_FILE" || exit 1

parameter_value() {
  jq -r --arg key "$1" \
    'if (.parameters | has($key)) then .parameters[$key].value else empty end' \
    "$PARAMETERS_FILE"
}

parameter_array_length() {
  jq -r --arg key "$1" \
    'if (.parameters | has($key)) then (.parameters[$key].value | length) else 0 end' \
    "$PARAMETERS_FILE"
}

value_or() {
  local value
  value="$(parameter_value "$1")"
  printf '%s' "${value:-$2}"
}

PROFILE="$(value_or deploymentProfile test)"
LOCATION="${LOCATION_OVERRIDE:-$(value_or location eastus)}"
NODE_COUNT="$(value_or nodeCount 3)"
NODE_MAX="$(value_or maxNodeCount "$([[ "$PROFILE" == production ]] && printf 5 || printf 4)")"
NODE_VM_SIZE="$(value_or nodeVmSize Standard_F4as_v6)"
SEPARATE_SYSTEM_POOL="$(value_or separateSystemPool "$([[ "$PROFILE" == production ]] && printf true || printf false)")"
SYSTEM_NODE_COUNT="$(value_or systemNodeCount 3)"
SYSTEM_NODE_MAX="$(value_or systemMaxNodeCount 3)"
SYSTEM_VM_SIZE="$(value_or systemNodeVmSize Standard_D2as_v4)"
ENABLE_BURST="$(value_or enableBurstPool "$([[ "$PROFILE" == production ]] && printf true || printf false)")"
BURST_MAX="$(value_or burstMaxCount 1)"
BURST_VM_SIZE="$(value_or burstVmSize Standard_F16as_v6)"

ACTIONS=()
BLOCKERS=0

row() { printf '  %-52s %s\n' "$1" "$2"; }
add_action() { ACTIONS+=("$1"); }
mark_blocker() { BLOCKERS=$((BLOCKERS + 1)); }

config_error() {
  row "$1" "FAIL"
  add_action "$2"
  mark_blocker
}

validate_integer() {
  local variable_name="$1"
  local label="$2"
  local value="${!variable_name}"
  if [[ ! "$value" =~ ^[0-9]+$ ]]; then
    config_error "$label" "Set $label to a non-negative integer."
    printf -v "$variable_name" 0
  fi
}

az_run() {
  AZ_STDOUT=""
  AZ_STDERR=""
  AZ_RC=0
  local error_file
  error_file="$(mktemp)"
  AZ_STDOUT="$(az "$@" 2>"$error_file")" || AZ_RC=$?
  AZ_STDERR="$(<"$error_file")"
  rm -f "$error_file"
  if [[ "$VERBOSE" == 1 && -n "$AZ_STDERR" ]]; then
    printf '      debug: %s\n' "${AZ_STDERR%%$'\n'*}" >&2
  fi
  return "$AZ_RC"
}

printf 'Rulebricks AKS prerequisite check\n'
printf '  Profile:        %s\n' "$PROFILE"
printf '  Parameters:     %s\n' "$PARAMETERS_FILE"
printf '  Location:       %s\n' "$LOCATION"
[[ -n "$RESOURCE_GROUP" ]] && printf '  Resource group: %s\n' "$RESOURCE_GROUP"
printf '\n'

if az bicep build --file "$SCRIPT_DIR/main.bicep" --stdout >/dev/null 2>&1 && \
   az bicep lint --file "$SCRIPT_DIR/main.bicep" >/dev/null 2>&1; then
  row "Bicep build and lint" "OK"
else
  config_error "Bicep build and lint" "Fix the local Bicep diagnostics before deploying."
fi

if [[ "$PROFILE" != test && "$PROFILE" != production ]]; then
  config_error "Deployment profile" "Set deploymentProfile to test or production."
else
  row "Deployment profile" "OK ($PROFILE)"
fi

ENTRA_RBAC="$(value_or enableEntraRbac "$([[ "$PROFILE" == production ]] && printf true || printf false)")"
AKS_ADMIN_COUNT="$(parameter_array_length aksAdminPrincipalIds)"
if [[ "$ENTRA_RBAC" == true && "$AKS_ADMIN_COUNT" == 0 ]]; then
  config_error "AKS administrator access" "Set aksAdminPrincipalIds to at least one Entra group or user object ID."
fi

validate_integer NODE_COUNT nodeCount
validate_integer NODE_MAX maxNodeCount
validate_integer SYSTEM_NODE_COUNT systemNodeCount
validate_integer SYSTEM_NODE_MAX systemMaxNodeCount
validate_integer BURST_MAX burstMaxCount

if (( NODE_COUNT > NODE_MAX )); then
  config_error "Core node counts" "nodeCount must be less than or equal to maxNodeCount."
fi
if [[ "$SEPARATE_SYSTEM_POOL" == true ]] && (( SYSTEM_NODE_COUNT > SYSTEM_NODE_MAX )); then
  config_error "System node counts" "systemNodeCount must be less than or equal to systemMaxNodeCount."
fi
if [[ "$ENABLE_BURST" == true ]] && (( BURST_MAX < 1 )); then
  config_error "Burst node count" "burstMaxCount must be at least 1 when the burst pool is enabled."
fi

CREATE_STORAGE="$(value_or createStorage true)"
STORAGE_NAME="$(value_or existingStorageAccountName '')"
STORAGE_RG="$(value_or existingStorageAccountResourceGroup '')"
STORAGE_PE="$(value_or enableStoragePrivateEndpoint "$([[ "$PROFILE" == production ]] && printf true || printf false)")"
STORAGE_LOCK="$(value_or enableStorageDeleteLock "$([[ "$PROFILE" == production ]] && printf true || printf false)")"
if [[ "$CREATE_STORAGE" == false && ( -z "$STORAGE_NAME" || -z "$STORAGE_RG" ) ]]; then
  config_error "Existing storage configuration" "Set existingStorageAccountName and existingStorageAccountResourceGroup."
fi
if [[ "$CREATE_STORAGE" == false && ( "$STORAGE_PE" == true || "$STORAGE_LOCK" == true ) ]]; then
  config_error "Existing storage ownership" "Disable enableStoragePrivateEndpoint and enableStorageDeleteLock for BYO storage."
fi

KEY_VAULT_ENABLED="$(value_or enableKeyVaultIntegration "$([[ "$PROFILE" == production ]] && printf true || printf false)")"
CREATE_KEY_VAULT="$(value_or createKeyVault true)"
KEY_VAULT_NAME="$(value_or keyVaultName '')"
KEY_VAULT_RG="$(value_or existingKeyVaultResourceGroup '')"
KEY_VAULT_PUBLIC="$(value_or allowKeyVaultPublicAccess "$([[ "$PROFILE" == test ]] && printf true || printf false)")"
KEY_VAULT_PE="$(value_or enableKeyVaultPrivateEndpoint "$([[ "$PROFILE" == production ]] && printf true || printf false)")"
KEY_VAULT_RETENTION="$(value_or keyVaultSoftDeleteRetentionDays "$([[ "$PROFILE" == production ]] && printf 90 || printf 7)")"
KEY_VAULT_PURGE="$(value_or enableKeyVaultPurgeProtection "$([[ "$PROFILE" == production ]] && printf true || printf false)")"
KEY_VAULT_OFFICER_COUNT="$(parameter_array_length keyVaultWriterPrincipalIds)"
KEY_VAULT_CSI="$(value_or enableKeyVaultSecretsProvider false)"
ESO_SERVICE_ACCOUNT="$(value_or esoServiceAccountName rulebricks-key-vault-reader)"

if [[ "$KEY_VAULT_ENABLED" == true ]]; then
  if [[ ! "$KEY_VAULT_RETENTION" =~ ^[0-9]+$ ]]; then
    config_error "Key Vault retention" "Set keyVaultSoftDeleteRetentionDays to an integer between 7 and 90."
  elif (( KEY_VAULT_RETENTION < 7 || KEY_VAULT_RETENTION > 90 )); then
    config_error "Key Vault retention" "Set keyVaultSoftDeleteRetentionDays between 7 and 90."
  fi
  if [[ "$CREATE_KEY_VAULT" == false && ( -z "$KEY_VAULT_NAME" || -z "$KEY_VAULT_RG" ) ]]; then
    config_error "Existing Key Vault configuration" "Set keyVaultName and existingKeyVaultResourceGroup."
  fi
  if [[ "$CREATE_KEY_VAULT" == true && "$KEY_VAULT_PUBLIC" == false && "$KEY_VAULT_PE" != true ]]; then
    config_error "Key Vault network access" "Enable the Key Vault private endpoint or allow public network access."
  fi
  if [[ ! "$ESO_SERVICE_ACCOUNT" =~ ^[a-z0-9]([-a-z0-9]*[a-z0-9])?$ ]]; then
    config_error "External Secrets service account" "Set esoServiceAccountName to a valid Kubernetes DNS label."
  fi
  if [[ "$CREATE_KEY_VAULT" == true && "$KEY_VAULT_OFFICER_COUNT" == 0 ]]; then
    row "Key Vault secret writers" "WARN (none assigned)"
    add_action "Set keyVaultWriterPrincipalIds or arrange a separate secret-seeding identity."
  fi
  if [[ "$KEY_VAULT_CSI" == true ]]; then
    row "Key Vault secret drivers" "WARN (ESO and CSI are both enabled)"
    add_action "Disable enableKeyVaultSecretsProvider unless CSI-mounted secrets are also required."
  fi
fi

METRICS="$(value_or enableMetricsRemoteWrite false)"
CREATE_MONITOR="$(value_or createMonitorWorkspace true)"
DCR_NAME="$(value_or existingDataCollectionRuleName '')"
DCR_RG="$(value_or existingDataCollectionRuleResourceGroup '')"
GRAFANA="$(value_or enableManagedGrafana false)"
if [[ "$METRICS" == true && "$CREATE_MONITOR" == false && ( -z "$DCR_NAME" || -z "$DCR_RG" ) ]]; then
  config_error "Existing monitor configuration" "Set existingDataCollectionRuleName and existingDataCollectionRuleResourceGroup."
fi
if [[ "$GRAFANA" == true && ( "$METRICS" != true || "$CREATE_MONITOR" != true ) ]]; then
  config_error "Managed Grafana configuration" "Managed Grafana requires metrics remote write and a new monitor workspace."
fi

EXTERNAL_DNS="$(value_or enableExternalDns false)"
DNS_ZONE="$(value_or dnsZoneName '')"
DNS_RG="$(value_or dnsZoneResourceGroup '')"
if [[ "$EXTERNAL_DNS" == true && ( -z "$DNS_ZONE" || -z "$DNS_RG" ) ]]; then
  config_error "External DNS configuration" "Set dnsZoneName and dnsZoneResourceGroup."
fi

ENABLE_ACR="$(value_or enableContainerRegistry "$([[ "$PROFILE" == production ]] && printf true || printf false)")"
PRIVATE_SERVICES="$(value_or enableDataServicePrivateEndpoints "$([[ "$PROFILE" == production ]] && printf true || printf false)")"
ACR_SKU="$(value_or containerRegistrySku Premium)"
if [[ "$ENABLE_ACR" == true && "$PRIVATE_SERVICES" == true && "$ACR_SKU" != Premium ]]; then
  config_error "Private container registry" "A private ACR endpoint requires the Premium SKU."
fi

MANAGED_KAFKA="$(value_or enableManagedKafka false)"
EVENT_HUB_UNITS="$(value_or eventHubsCapacityUnits 1)"
SOLUTION_PARTITIONS="$(value_or solutionPartitions 64)"
LOG_PARTITIONS="$(value_or logsPartitions 24)"
if [[ "$MANAGED_KAFKA" == true ]] && \
   (( (SOLUTION_PARTITIONS * 2) + LOG_PARTITIONS > EVENT_HUB_UNITS * 200 )); then
  config_error "Event Hubs partition capacity" "Increase eventHubsCapacityUnits or reduce partition counts."
fi

if ! az_run account show -o json; then
  row "Azure CLI signed in" "FAIL"
  add_action "Run az login and select the intended subscription."
  mark_blocker
else
  SUB_NAME="$(jq -r '.name // ""' <<<"$AZ_STDOUT")"
  SUB_ID="$(jq -r '.id // ""' <<<"$AZ_STDOUT")"
  PRINCIPAL="$(jq -r '.user.name // ""' <<<"$AZ_STDOUT")"
  row "Azure CLI signed in" "OK ($SUB_NAME)"
fi

if (( BLOCKERS > 0 )) && [[ -z "${SUB_ID:-}" ]]; then
  printf '\nRESULT: NOT READY\n'
  for action in "${ACTIONS[@]}"; do printf '  - %s\n' "$action"; done
  exit 1
fi

REQUIRED_PROVIDERS=(
  Microsoft.Authorization
  Microsoft.Cache
  Microsoft.Compute
  Microsoft.ContainerRegistry
  Microsoft.ContainerService
  Microsoft.Dashboard
  Microsoft.DBforPostgreSQL
  Microsoft.EventHub
  Microsoft.Insights
  Microsoft.KeyVault
  Microsoft.ManagedIdentity
  Microsoft.Monitor
  Microsoft.Network
  Microsoft.PolicyInsights
  Microsoft.Storage
)

missing_providers=()
for provider in "${REQUIRED_PROVIDERS[@]}"; do
  if az_run provider show --namespace "$provider" --query registrationState -o tsv; then
    [[ "$AZ_STDOUT" == Registered ]] || missing_providers+=("$provider")
  fi
done

if [[ ${#missing_providers[@]} -eq 0 ]]; then
  row "Resource providers" "OK (${#REQUIRED_PROVIDERS[@]}/${#REQUIRED_PROVIDERS[@]})"
else
  row "Resource providers" "WARN (${#missing_providers[@]} not registered)"
  add_action "Register providers: ${missing_providers[*]}"
fi

KUBERNETES_VERSION="$(value_or kubernetesVersion 1.34)"
if az_run aks get-versions --location "$LOCATION" --query "length(values[?version=='$KUBERNETES_VERSION'])" -o tsv && [[ "$AZ_STDOUT" != 0 ]]; then
  row "AKS version $KUBERNETES_VERSION in $LOCATION" "OK"
else
  config_error "AKS version $KUBERNETES_VERSION in $LOCATION" "Choose a Kubernetes version offered in the target region."
fi

if [[ "$KEY_VAULT_ENABLED" == true && "$CREATE_KEY_VAULT" == false ]]; then
  if az_run keyvault show --name "$KEY_VAULT_NAME" --resource-group "$KEY_VAULT_RG" -o json; then
    if [[ "$(jq -r '.properties.enableRbacAuthorization // false' <<<"$AZ_STDOUT")" == true ]]; then
      row "Existing Key Vault RBAC" "OK"
    else
      config_error "Existing Key Vault RBAC" "Enable Azure RBAC authorization on the existing vault."
    fi
  else
    config_error "Existing Key Vault" "Confirm that $KEY_VAULT_NAME exists in $KEY_VAULT_RG and is accessible."
  fi
fi

VM_SIZE_CATALOG='[]'
if az_run rest --method get \
    --url "https://management.azure.com/subscriptions/$SUB_ID/providers/Microsoft.Compute/locations/$LOCATION/vmSizes?api-version=2024-07-01" \
    --query value -o json; then
  VM_SIZE_CATALOG="$AZ_STDOUT"
fi

sku_vcpu() {
  local sku="$1"
  local cores
  cores="$(jq -r --arg sku "$sku" '[.[] | select(.name == $sku) | .numberOfCores][0] // empty' <<<"$VM_SIZE_CATALOG")"
  if [[ -n "$cores" ]]; then
    printf '%s' "$cores"
    return
  fi
  case "$sku" in
    Standard_F4as_v6) printf 4 ;;
    Standard_F16as_v6) printf 16 ;;
    Standard_D2as_v4) printf 2 ;;
    *) printf 0 ;;
  esac
}

sku_family_key() {
  local sku="${1#Standard_}"
  sku="${sku//_/}"
  sku="$(sed -E 's/^([[:alpha:]]+)[0-9]+(-[0-9]+)?/\1/' <<<"$sku")"
  printf 'standard%sfamily' "$(tr '[:upper:]' '[:lower:]' <<<"$sku")"
}

NODE_VCPU="$(sku_vcpu "$NODE_VM_SIZE")"
SYSTEM_VCPU="$(sku_vcpu "$SYSTEM_VM_SIZE")"
BURST_VCPU="$(sku_vcpu "$BURST_VM_SIZE")"

if (( NODE_VCPU == 0 )); then
  config_error "Core VM SKU $NODE_VM_SIZE" "Confirm that the core VM size is available in $LOCATION."
fi
if [[ "$SEPARATE_SYSTEM_POOL" == true ]] && (( SYSTEM_VCPU == 0 )); then
  config_error "System VM SKU $SYSTEM_VM_SIZE" "Confirm that the system VM size is available in $LOCATION."
fi
if [[ "$ENABLE_BURST" == true ]] && (( BURST_VCPU == 0 )); then
  config_error "Burst VM SKU $BURST_VM_SIZE" "Confirm that the burst VM size is available in $LOCATION."
fi

LAUNCH_VCPU=$((NODE_COUNT * NODE_VCPU))
CEILING_VCPU=$((NODE_MAX * NODE_VCPU))
if [[ "$SEPARATE_SYSTEM_POOL" == true ]]; then
  LAUNCH_VCPU=$((LAUNCH_VCPU + SYSTEM_NODE_COUNT * SYSTEM_VCPU))
  CEILING_VCPU=$((CEILING_VCPU + SYSTEM_NODE_MAX * SYSTEM_VCPU))
fi
if [[ "$ENABLE_BURST" == true ]]; then
  CEILING_VCPU=$((CEILING_VCPU + BURST_MAX * BURST_VCPU))
fi

if az_run vm list-usage --location "$LOCATION" -o json; then
  VM_USAGE="$AZ_STDOUT"
  read -r USED_VCPU LIMIT_VCPU <<<"$(jq -r '[.[] | select(.name.value == "cores")][0] | [.currentValue, .limit] | @tsv' <<<"$VM_USAGE")"
  AVAILABLE_VCPU=$((LIMIT_VCPU - USED_VCPU))
  if (( AVAILABLE_VCPU < LAUNCH_VCPU )); then
    config_error "Launch vCPU quota ($LAUNCH_VCPU required)" "Request enough regional quota to create the initial node pools."
  elif (( AVAILABLE_VCPU < CEILING_VCPU )); then
    row "Launch vCPU quota ($LAUNCH_VCPU required)" "OK ($AVAILABLE_VCPU available)"
    row "Autoscaling ceiling ($CEILING_VCPU vCPU)" "WARN (raise quota before full scale-out)"
    add_action "Raise regional vCPU quota before using the full autoscaling ceiling."
  else
    row "Launch and autoscaling vCPU quota" "OK ($AVAILABLE_VCPU available)"
  fi

  NODE_FAMILY="$(sku_family_key "$NODE_VM_SIZE")"
  SYSTEM_FAMILY="$(sku_family_key "$SYSTEM_VM_SIZE")"
  BURST_FAMILY="$(sku_family_key "$BURST_VM_SIZE")"
  families=("$NODE_FAMILY")
  [[ "$SEPARATE_SYSTEM_POOL" == true ]] && families+=("$SYSTEM_FAMILY")
  [[ "$ENABLE_BURST" == true ]] && families+=("$BURST_FAMILY")

  seen_families='|'
  for family in "${families[@]}"; do
    [[ "$seen_families" == *"|$family|"* ]] && continue
    seen_families+="$family|"

    family_launch=0
    family_ceiling=0
    if [[ "$NODE_FAMILY" == "$family" ]]; then
      family_launch=$((family_launch + NODE_COUNT * NODE_VCPU))
      family_ceiling=$((family_ceiling + NODE_MAX * NODE_VCPU))
    fi
    if [[ "$SEPARATE_SYSTEM_POOL" == true && "$SYSTEM_FAMILY" == "$family" ]]; then
      family_launch=$((family_launch + SYSTEM_NODE_COUNT * SYSTEM_VCPU))
      family_ceiling=$((family_ceiling + SYSTEM_NODE_MAX * SYSTEM_VCPU))
    fi
    if [[ "$ENABLE_BURST" == true && "$BURST_FAMILY" == "$family" ]]; then
      family_ceiling=$((family_ceiling + BURST_MAX * BURST_VCPU))
    fi

    family_quota="$(jq -r --arg family "$family" \
      '[.[] | select((.name.value | ascii_downcase) == $family)][0] | if . then [.currentValue, .limit] | @tsv else empty end' \
      <<<"$VM_USAGE")"
    if [[ -z "$family_quota" ]]; then
      row "VM-family quota ($family)" "WARN (could not map SKU family)"
      add_action "Confirm the VM-family quota for the selected node SKUs."
      continue
    fi

    read -r family_used family_limit <<<"$family_quota"
    family_available=$((family_limit - family_used))
    if (( family_available < family_launch )); then
      config_error "VM-family launch quota ($family_launch required)" "Raise $family quota or choose node SKUs from a family with available quota."
    elif (( family_available < family_ceiling )); then
      row "VM-family launch quota ($family_launch required)" "OK ($family_available available)"
      row "VM-family ceiling ($family_ceiling vCPU)" "WARN ($family)"
      add_action "Raise $family quota before using that family's full autoscaling ceiling."
    else
      row "VM-family quota ($family)" "OK ($family_available available)"
    fi
  done
else
  row "Regional vCPU quota" "WARN (could not read)"
  add_action "Confirm regional and VM-family vCPU quotas before deploying."
fi

if [[ -n "${PRINCIPAL:-}" ]] && az_run role assignment list --assignee "$PRINCIPAL" --include-groups --include-inherited --all \
    --query "[?roleDefinitionName=='Owner' || roleDefinitionName=='User Access Administrator' || roleDefinitionName=='Role Based Access Control Administrator'] | [0].roleDefinitionName" -o tsv && \
    [[ -n "$AZ_STDOUT" ]]; then
  row "Role assignment permission" "OK ($AZ_STDOUT)"
else
  row "Role assignment permission" "WARN (not detected)"
  add_action "The deployer needs Owner, User Access Administrator, or Role Based Access Control Administrator at the deployment scopes."
fi

if [[ -n "$RESOURCE_GROUP" ]]; then
  if az_run group show --name "$RESOURCE_GROUP" --output none; then
    row "Resource group $RESOURCE_GROUP" "OK"
    if az deployment group validate \
        --resource-group "$RESOURCE_GROUP" \
        --template-file "$SCRIPT_DIR/main.bicep" \
        --parameters "@$PARAMETERS_FILE" \
        --validation-level ProviderNoRbac \
        --output none >/dev/null 2>&1; then
      row "ARM provider validation" "OK"
    else
      row "ARM provider validation" "WARN (run with VERBOSE=1 for details)"
      add_action "Run az deployment group validate against the target resource group."
    fi
  else
    row "Resource group $RESOURCE_GROUP" "WARN (not found or inaccessible)"
    add_action "Create the dedicated resource group before provider validation."
  fi
fi

if [[ "$PROFILE" == production ]]; then
  row "Private-cluster access" "INFO (VPN, peering, or a jump host required)"
  [[ "$STORAGE_LOCK" == true ]] && row "Storage delete lock" "INFO (cleanup command is documented)"
  [[ "$KEY_VAULT_ENABLED" == true && "$CREATE_KEY_VAULT" == true && "$KEY_VAULT_PURGE" == true ]] && row "Key Vault purge protection" "INFO (deleted vault is retained)"
fi

printf '\n'
if (( BLOCKERS > 0 )); then
  printf 'RESULT: NOT READY\n'
elif [[ ${#ACTIONS[@]} -gt 0 ]]; then
  printf 'RESULT: READY WITH WARNINGS\n'
else
  printf 'RESULT: READY\n'
fi

for action in "${ACTIONS[@]}"; do
  printf '  - %s\n' "$action"
done

(( BLOCKERS > 0 )) && exit 1 || exit 0
