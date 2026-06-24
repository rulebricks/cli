#!/usr/bin/env bash
# Rulebricks GKE prerequisite check.
#
# Prints a short pass/fail report and a final READY / NOT READY verdict
# with the exact actions you need to take before running the GKE deploy.
#
# Env vars:
#   GOOGLE_CLOUD_PROJECT   GCP project id (defaults to gcloud config)
#   GCP_REGION             Region to check (default: us-central1)
#   VERBOSE=1              Print raw gcloud error messages inline

set -euo pipefail

if [[ -z "${BASH_VERSION:-}" ]]; then
  exec bash "$0" "$@"
fi

# Quiet gcloud's interactive nags / survey output.
export CLOUDSDK_CORE_DISABLE_PROMPTS=1

PROJECT_ID="${GOOGLE_CLOUD_PROJECT:-$(gcloud config get-value project 2>/dev/null || true)}"
REGION="${GCP_REGION:-us-central1}"
REQUIRED_VCPU=8
VERBOSE="${VERBOSE:-0}"

REQUIRED_APIS=(
  compute.googleapis.com
  container.googleapis.com
  iam.googleapis.com
  cloudresourcemanager.googleapis.com
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

# Run a gcloud command. Sets GC_STDOUT / GC_STDERR / GC_RC. Never aborts.
gc_run() {
  GC_STDOUT=""; GC_STDERR=""; GC_RC=0
  local _err
  _err="$(mktemp)"
  GC_STDOUT="$(gcloud "$@" 2>"$_err")" || GC_RC=$?
  GC_STDERR="$(cat "$_err")"
  rm -f "$_err"
  if [[ "$VERBOSE" == "1" && -n "$GC_STDERR" ]]; then
    printf "      debug: %s\n" "${GC_STDERR%%$'\n'*}" >&2
  fi
  return "$GC_RC"
}

is_auth_error() {
  [[ "$GC_STDERR" == *"reauthentication"*    ]] && return 0
  [[ "$GC_STDERR" == *"credentials"*"expired"* ]] && return 0
  [[ "$GC_STDERR" == *"invalid_grant"*       ]] && return 0
  [[ "$GC_STDERR" == *"gcloud auth login"*   ]] && return 0
  [[ "$GC_STDERR" == *"gcloud auth application-default login"* ]] && return 0
  [[ "$GC_STDERR" == *"There was a problem refreshing"* ]] && return 0
  [[ "$GC_STDERR" == *"do not have active credentials"* ]] && return 0
  return 1
}

row() {
  printf "  %-50s %s\n" "$1" "$2"
}

mark_blocker() { BLOCKERS=$((BLOCKERS + 1)); }
add_action()   { ACTIONS+=("$1"); }

# ---------- pre-flight ----------

require_cmd gcloud
require_cmd kubectl
require_cmd helm
require_cmd awk

printf "Rulebricks GKE prerequisite check\n"
printf "  Region:  %s\n" "$REGION"
printf "  Project: %s\n" "${PROJECT_ID:-<unset>}"
printf "\n"

if [[ -z "$PROJECT_ID" ]]; then
  row "GCP project configured" "FAIL - no project set"
  add_action "Set a project: gcloud config set project <PROJECT_ID>"
  printf "\n========================================\n"
  printf "RESULT: NOT READY\n"
  printf "========================================\n"
  printf "Required actions:\n  1. %s\n" "${ACTIONS[0]}"
  exit 1
fi

# ---------- 1. Authentication ----------
AUTH_OK=0
ACTIVE_ACCOUNT=""

if gc_run auth list --filter=status:ACTIVE --format="value(account)"; then
  ACTIVE_ACCOUNT="$(printf '%s' "$GC_STDOUT" | head -n 1)"
  if [[ -z "$ACTIVE_ACCOUNT" ]]; then
    row "gcloud user signed in" "FAIL - no active account"
    add_action "Run: gcloud auth login"
    mark_blocker
  else
    row "gcloud user signed in" "OK ($ACTIVE_ACCOUNT)"

    # Now verify ADC actually works against Google APIs - this is what
    # the deploy tooling uses, and the most common breakage.
    if gc_run auth application-default print-access-token; then
      row "Application Default Credentials" "OK"
      AUTH_OK=1
    else
      if is_auth_error; then
        row "Application Default Credentials" "FAIL - ADC missing or expired"
      else
        row "Application Default Credentials" "FAIL - ${GC_STDERR%%$'\n'*}"
      fi
      add_action "Run: gcloud auth application-default login"
      mark_blocker
    fi
  fi
else
  row "gcloud user signed in" "FAIL - ${GC_STDERR%%$'\n'*}"
  add_action "Run: gcloud auth login && gcloud auth application-default login"
  mark_blocker
fi

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

# ---------- 2. Project access ----------
if gc_run projects describe "$PROJECT_ID" --format="value(projectId)"; then
  row "Project '$PROJECT_ID' accessible" "OK"
else
  row "Project '$PROJECT_ID' accessible" "FAIL - ${GC_STDERR%%$'\n'*}"
  add_action "Ensure '$ACTIVE_ACCOUNT' has at least roles/viewer on project '$PROJECT_ID', or fix the project id."
  mark_blocker
fi

# ---------- 3. Required APIs ----------
missing_apis=()
unknown_apis=()
if gc_run services list --project "$PROJECT_ID" --enabled --format="value(config.name)"; then
  enabled="$GC_STDOUT"
  for api in "${REQUIRED_APIS[@]}"; do
    if ! printf '%s\n' "$enabled" | grep -qx "$api"; then
      missing_apis+=("$api")
    fi
  done
else
  unknown_apis=("${REQUIRED_APIS[@]}")
fi

total=${#REQUIRED_APIS[@]}

if [[ ${#unknown_apis[@]} -gt 0 ]]; then
  row "Required APIs enabled" "WARN - could not list enabled services"
  add_action "Verify 'serviceusage.services.list' permission, then re-run."
elif [[ ${#missing_apis[@]} -eq 0 ]]; then
  row "Required APIs enabled" "OK ($total/$total)"
else
  enabled_count=$((total - ${#missing_apis[@]}))
  row "Required APIs enabled" "WARN ($enabled_count/$total)"
  enable_cmd="gcloud services enable ${missing_apis[*]} --project $PROJECT_ID"
  add_action "Enable missing APIs (takes ~1 min):"
  add_action "    $enable_cmd"
fi

# ---------- 4. Region + GKE access ----------
REGION_OK=1
if ! gc_run compute regions describe "$REGION" --project "$PROJECT_ID" --format="value(name)"; then
  REGION_OK=0
  row "Region '$REGION' accessible" "FAIL - ${GC_STDERR%%$'\n'*}"
  add_action "Verify region name '$REGION' and that the Compute Engine API is enabled."
  mark_blocker
fi

if [[ $REGION_OK -eq 1 ]]; then
  if gc_run container clusters list --region "$REGION" --project "$PROJECT_ID" --format="value(name)"; then
    row "Region + GKE list access" "OK"
  else
    row "Region + GKE list access" "WARN - ${GC_STDERR%%$'\n'*}"
    add_action "Ensure '$ACTIVE_ACCOUNT' has roles/container.viewer (or higher) on '$PROJECT_ID'."
  fi
fi

# ---------- 5. Regional CPU quota ----------
quota_label="Regional CPU quota in $REGION (need ${REQUIRED_VCPU}+)"
quota_line=""
if gc_run compute regions describe "$REGION" --project "$PROJECT_ID" \
       --format="csv[no-heading](quotas.metric,quotas.limit,quotas.usage)"; then
  quota_line="$(printf '%s\n' "$GC_STDOUT" | awk -F, '$1=="CPUS"{print $2 "," $3; exit}')"
fi

if [[ -z "$quota_line" ]]; then
  row "$quota_label" "WARN - could not read quota"
  add_action "Manually check CPU quota in Console → IAM & Admin → Quotas (region: $REGION)."
else
  limit="${quota_line%,*}"
  usage="${quota_line#*,}"
  available="$(awk -v l="$limit" -v u="$usage" 'BEGIN { printf "%d", l - u }')"
  if (( available < REQUIRED_VCPU )); then
    row "$quota_label" "WARN ($available/$limit free)"
    add_action "Request CPU quota increase: Console → IAM & Admin → Quotas → 'Compute Engine API CPUs' in $REGION."
  else
    row "$quota_label" "OK ($available/$limit free)"
  fi
fi

# ---------- 6. Local tools ----------
if kubectl version --client=true >/dev/null 2>&1 && helm version >/dev/null 2>&1; then
  row "Local tools (kubectl, helm)" "OK"
else
  row "Local tools (kubectl, helm)" "FAIL"
  add_action "Install/repair kubectl and helm."
  mark_blocker
fi

# ---------- summary ----------
printf "\n========================================\n"
if [[ $BLOCKERS -eq 0 && ${#ACTIONS[@]} -eq 0 ]]; then
  printf "RESULT: READY - you can run the GKE deploy.\n"
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
printf "(Set VERBOSE=1 to see raw gcloud error messages.)\n"

[[ $BLOCKERS -gt 0 ]] && exit 1 || exit 0
