#!/usr/bin/env bash
# Rulebricks AKS prerequisite check.
#
# Prints a short pass/fail report and a final READY / NOT READY verdict
# with the exact actions you need to take before running the Bicep deploy.
#
# Env vars:
#   AZURE_LOCATION        Region to check (default: eastus)
#   AZURE_RESOURCE_GROUP  Optional existing RG to verify access on
#   VERBOSE=1             Print raw Azure error messages inline

set -euo pipefail

if [[ -z "${BASH_VERSION:-}" ]]; then
  exec bash "$0" "$@"
fi

export AZURE_CORE_SURVEY_MESSAGE=no
export AZURE_CORE_COLLECT_TELEMETRY=no

LOCATION="${AZURE_LOCATION:-eastus}"
RESOURCE_GROUP="${AZURE_RESOURCE_GROUP:-}"
# Worst case with template defaults: core pool at its 5-node max
# (5 x Standard_F4as_v6 = 20 vCPU) + burst node (F16as_v6 = 16 vCPU) = 36.
# The launch floor is 12 (3 x F4as_v6); this checks the ceiling so a quota
# surprise never shows up mid-burst.
REQUIRED_VCPU=36
VERBOSE="${VERBOSE:-0}"

# Providers needed by the turnkey template. Storage covers decision-log/backup
# blob; Monitor/Insights/AlertsManagement cover the managed-Prometheus path
# (Azure Monitor workspace + data collection endpoint/rule).
REQUIRED_PROVIDERS=(
  Microsoft.ContainerService
  Microsoft.Network
  Microsoft.ManagedIdentity
  Microsoft.Compute
  Microsoft.Authorization
  Microsoft.Storage
  Microsoft.Monitor
  Microsoft.Insights
  Microsoft.AlertsManagement
)

ACTIONS=()
BLOCKERS=0

# ---------- helpers ----------

require_cmd() {
  command -v "$1" >/dev/null 2>&1 || {
    printf "ERROR: required command not found: %s\n" "$1" >&2
    exit 1
  }
}

# Run an az command. Sets AZ_STDOUT / AZ_STDERR / AZ_RC. Never aborts the script.
az_run() {
  AZ_STDOUT=""; AZ_STDERR=""; AZ_RC=0
  local _err
  _err="$(mktemp)"
  AZ_STDOUT="$(az "$@" 2>"$_err")" || AZ_RC=$?
  AZ_STDERR="$(cat "$_err")"
  rm -f "$_err"
  if [[ "$VERBOSE" == "1" && -n "$AZ_STDERR" ]]; then
    printf "      debug: %s\n" "${AZ_STDERR%%$'\n'*}" >&2
  fi
  return "$AZ_RC"
}

is_auth_error() {
  [[ "$AZ_STDERR" == *AADSTS*           ]] && return 0
  [[ "$AZ_STDERR" == *"refresh token"*  ]] && return 0
  [[ "$AZ_STDERR" == *"az login"*       ]] && return 0
  [[ "$AZ_STDERR" == *"interactive authentication"* ]] && return 0
  return 1
}

# pad label to 50 chars
row() {
  printf "  %-50s %s\n" "$1" "$2"
}

mark_blocker()  { BLOCKERS=$((BLOCKERS + 1)); }
add_action()    { ACTIONS+=("$1"); }

# ---------- pre-flight ----------

require_cmd az
require_cmd kubectl
require_cmd helm

printf "Rulebricks AKS prerequisite check\n"
printf "  Location:       %s\n" "$LOCATION"
[[ -n "$RESOURCE_GROUP" ]] && printf "  Resource group: %s\n" "$RESOURCE_GROUP"
printf "\n"

# ---------- 1. Authentication ----------
# Two-step: az account show reads local cache (cheap), then we hit ARM with
# get-access-token to detect expired refresh tokens before doing anything else.

AUTH_OK=0
SUB_NAME=""
SUB_ID=""

if ! az_run account show --query "{n:name,i:id}" -o tsv; then
  row "Azure CLI signed in" "FAIL - not signed in"
  add_action "Run: az login"
  mark_blocker
else
  SUB_NAME="$(printf '%s' "$AZ_STDOUT" | awk '{print $1}')"
  SUB_ID="$(printf '%s'  "$AZ_STDOUT" | awk '{print $2}')"
  row "Azure CLI signed in" "OK ($SUB_NAME)"

  if ! az_run account get-access-token --query expiresOn -o tsv; then
    if is_auth_error; then
      row "Azure session valid" "FAIL - session expired"
      add_action "Run: az login   # your refresh token has expired"
    else
      row "Azure session valid" "FAIL - ${AZ_STDERR%%$'\n'*}"
      add_action "Run: az login   # could not obtain an ARM access token"
    fi
    mark_blocker
  else
    row "Azure session valid" "OK"
    AUTH_OK=1
  fi
fi

# Without a valid session, every other check is guaranteed to fail with the
# same auth error. Skip to the summary so the output stays useful.
if [[ $AUTH_OK -eq 0 ]]; then
  printf "\nRemaining checks skipped - fix authentication first.\n"
  printf "\n========================================\n"
  printf "RESULT: NOT READY\n"
  printf "========================================\n"
  printf "Required actions:\n"
  i=1
  for a in "${ACTIONS[@]}"; do
    printf "  %d. %s\n" "$i" "$a"
    i=$((i + 1))
  done
  exit 1
fi

# ---------- 2. Resource provider registrations ----------
missing_providers=()
unknown_providers=()
for p in "${REQUIRED_PROVIDERS[@]}"; do
  if az_run provider show --namespace "$p" --query registrationState -o tsv; then
    if [[ "$AZ_STDOUT" != "Registered" ]]; then
      missing_providers+=("$p")
    fi
  else
    unknown_providers+=("$p")
  fi
done

total=${#REQUIRED_PROVIDERS[@]}
registered=$((total - ${#missing_providers[@]} - ${#unknown_providers[@]}))

if [[ ${#missing_providers[@]} -eq 0 && ${#unknown_providers[@]} -eq 0 ]]; then
  row "Resource providers registered" "OK ($registered/$total)"
elif [[ ${#unknown_providers[@]} -gt 0 ]]; then
  row "Resource providers registered" "WARN - could not read ${#unknown_providers[@]} provider(s)"
  add_action "Ask your Azure admin to grant you Reader on the subscription, then re-run."
else
  row "Resource providers registered" "WARN ($registered/$total registered)"
  reg_cmd="for ns in ${missing_providers[*]}; do az provider register --namespace \$ns; done"
  add_action "Register missing providers (takes 1-5 min):"
  add_action "    $reg_cmd"
fi

# ---------- 3. Subscription-level access ----------
ACCESS_OK=1
if ! az_run aks list --output none; then
  ACCESS_OK=0
fi
if ! az_run deployment sub list --query "[0].name" --output tsv; then
  ACCESS_OK=0
fi

if [[ $ACCESS_OK -eq 1 ]]; then
  row "Subscription access (AKS + deployments)" "OK"
else
  row "Subscription access (AKS + deployments)" "WARN - read access missing"
  add_action "Ask the subscription owner to grant you 'Contributor' on subscription $SUB_NAME."
fi

# ---------- 4. Role-assignment rights ----------
# The template creates role assignments (Storage Blob Data Contributor on the
# storage account, Monitoring Metrics Publisher on the DCR, Network Contributor
# on the VNet). Writing role assignments requires Owner or User Access
# Administrator, NOT just Contributor. This is the single most common reason a
# turnkey deploy gets partway and then fails on the role-assignment resources.
if az_run role assignment list --assignee "$SUB_ID" --scope "/subscriptions/$SUB_ID" --query "[0].id" -o tsv; then
  # We can at least read assignments. Probe for write capability via whoami roles.
  if az_run role assignment list --assignee "$(az account show --query user.name -o tsv 2>/dev/null)" \
        --query "[?roleDefinitionName=='Owner' || roleDefinitionName=='User Access Administrator'] | [0].roleDefinitionName" -o tsv \
     && [[ -n "$AZ_STDOUT" ]]; then
    row "Role-assignment rights (Owner / UAA)" "OK ($AZ_STDOUT)"
  else
    row "Role-assignment rights (Owner / UAA)" "WARN - not detected"
    add_action "The deploy creates role assignments, which needs 'Owner' or 'User Access Administrator' (Contributor alone is NOT enough). Ask an admin to grant one of these on the target resource group, or to run the deploy."
  fi
else
  row "Role-assignment rights (Owner / UAA)" "WARN - could not read role assignments"
  add_action "Could not verify role-assignment rights. The deploy creates role assignments and needs 'Owner' or 'User Access Administrator' on the target scope."
fi

# ---------- 5. Optional: existing resource group ----------
if [[ -n "$RESOURCE_GROUP" ]]; then
  if az_run group show --name "$RESOURCE_GROUP" --output none; then
    row "Resource group '$RESOURCE_GROUP'" "OK"
  else
    row "Resource group '$RESOURCE_GROUP'" "WARN - not found or no access"
    add_action "Create or get access to resource group '$RESOURCE_GROUP'."
  fi
fi

# ---------- 6. Regional vCPU quota ----------
quota_label="vCPU quota in $LOCATION (need ${REQUIRED_VCPU}+)"
usage=""; limit=""
if az_run vm list-usage --location "$LOCATION" \
       --query "[?name.value=='cores'].currentValue | [0]" -o tsv; then
  usage="$AZ_STDOUT"
fi
if az_run vm list-usage --location "$LOCATION" \
       --query "[?name.value=='cores'].limit | [0]" -o tsv; then
  limit="$AZ_STDOUT"
fi

if [[ -z "$usage" || -z "$limit" ]]; then
  row "$quota_label" "WARN - could not read quota"
  add_action "Manually check vCPU quota in the Azure Portal: Subscriptions → $SUB_NAME → Usage + quotas."
else
  available=$((limit - usage))
  if (( available < REQUIRED_VCPU )); then
    row "$quota_label" "WARN ($available/$limit free)"
    add_action "Request a vCPU quota increase in $LOCATION (Portal: Subscription → Usage + quotas → Request increase)."
  else
    row "$quota_label" "OK ($available/$limit free)"
  fi
fi

# ---------- 7. Local tools ----------
if kubectl version --client=true >/dev/null 2>&1 && helm version >/dev/null 2>&1; then
  row "Local tools (kubectl, helm)" "OK"
else
  row "Local tools (kubectl, helm)" "FAIL"
  add_action "Install kubectl and helm locally."
  mark_blocker
fi

# ---------- summary ----------
printf "\n========================================\n"
if [[ $BLOCKERS -eq 0 && ${#ACTIONS[@]} -eq 0 ]]; then
  printf "RESULT: READY - you can run the Bicep deploy.\n"
  printf "========================================\n"
  exit 0
elif [[ $BLOCKERS -eq 0 ]]; then
  printf "RESULT: READY WITH WARNINGS\n"
  printf "========================================\n"
  printf "The deploy should work, but address these first if possible:\n"
else
  printf "RESULT: NOT READY\n"
  printf "========================================\n"
  printf "Required actions:\n"
fi

i=1
for a in "${ACTIONS[@]}"; do
  printf "  %d. %s\n" "$i" "$a"
  i=$((i + 1))
done

printf "\nRe-run this script after completing the actions above.\n"
printf "(Set VERBOSE=1 to see raw Azure error messages.)\n"

[[ $BLOCKERS -gt 0 ]] && exit 1 || exit 0