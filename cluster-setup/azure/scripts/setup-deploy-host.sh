#!/usr/bin/env bash
# Before running this script, run: 
#   rulebricks host link
#
# Sets up a linked Azure VM to execute Rulebricks deployments:
#   1. Installs & upgrades all required CLI tools
#   2. Copies your local ~/.rulebricks config files to the VM
#   3. Verifies your VM can access Azure and the AKS cluster
#
# This script runs on the deployer's local machine.
# 
# After, the VM can run: 
#   rulebricks deploy <deployment-name>

set -euo pipefail

SCRIPT_NAME="${0##*/}"
RULEBRICKS_ROOT="${RULEBRICKS_HOME:-$HOME/.rulebricks}"
DEPLOYMENTS_ROOT="$RULEBRICKS_ROOT/deployments"
CHUNK_BYTES="${RULEBRICKS_HOST_CHUNK_BYTES:-90000}"

DEPLOYMENT_NAME=""
VM_NAME=""
VM_RESOURCE_GROUP=""
ADMIN_USER=""
SKIP_TOOLS=0
SKIP_CONFIG=0
SKIP_VERIFY=0
REMOVE_CONFIG=0

TEMP_DIR=""

usage() {
  cat <<EOF
Usage:
  $SCRIPT_NAME <deployment-name> [options]

Prepare the Azure VM linked by "rulebricks host link", copy the current
deployment configuration to it, and verify managed-identity cluster access.

Options:
  --vm NAME                 Override the linked VM name
  --resource-group NAME     Override the linked VM resource group
  --admin-user NAME         Override the VM OS administrator user
  --skip-tools              Do not install or update host tools
  --skip-config             Do not copy deployment configuration
  --skip-verify             Do not verify managed identity and AKS access
  --remove                  Remove this deployment's remote configuration only
  -h, --help                Show this help

Environment:
  RULEBRICKS_HOME                  Local Rulebricks directory
                                   (default: ~/.rulebricks)
  RULEBRICKS_HOST_CHUNK_BYTES      Config-transfer chunk size
                                   (default: 90000)

Examples:
  $SCRIPT_NAME production
  $SCRIPT_NAME production --skip-tools
  $SCRIPT_NAME production --remove
  $SCRIPT_NAME production --remove \\
    --vm deploy-jumpbox --resource-group platform-rg
EOF
}

info() {
  printf '==> %s\n' "$*"
}

pass() {
  printf 'PASS: %s\n' "$*"
}

warn() {
  printf 'WARN: %s\n' "$*" >&2
}

die() {
  printf 'ERROR: %s\n' "$*" >&2
  exit 1
}

cleanup() {
  if [[ -n "$TEMP_DIR" && -d "$TEMP_DIR" ]]; then
    rm -rf "$TEMP_DIR"
  fi
}
trap cleanup EXIT

require_value() {
  local option="$1"
  local value="${2:-}"
  [[ -n "$value" ]] || die "$option requires a value."
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --vm)
      require_value "$1" "${2:-}"
      VM_NAME="$2"
      shift 2
      ;;
    --resource-group)
      require_value "$1" "${2:-}"
      VM_RESOURCE_GROUP="$2"
      shift 2
      ;;
    --admin-user)
      require_value "$1" "${2:-}"
      ADMIN_USER="$2"
      shift 2
      ;;
    --skip-tools)
      SKIP_TOOLS=1
      shift
      ;;
    --skip-config)
      SKIP_CONFIG=1
      shift
      ;;
    --skip-verify)
      SKIP_VERIFY=1
      shift
      ;;
    --remove)
      REMOVE_CONFIG=1
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    -*)
      die "Unknown option: $1"
      ;;
    *)
      if [[ -n "$DEPLOYMENT_NAME" ]]; then
        die "Only one deployment name may be supplied."
      fi
      DEPLOYMENT_NAME="$1"
      shift
      ;;
  esac
done

[[ -n "$DEPLOYMENT_NAME" ]] || {
  usage >&2
  exit 2
}
[[ "$DEPLOYMENT_NAME" =~ ^[A-Za-z0-9][A-Za-z0-9._-]*$ ]] ||
  die "Deployment names may contain only letters, numbers, dots, underscores, and hyphens."
[[ "$CHUNK_BYTES" =~ ^[0-9]+$ ]] && ((CHUNK_BYTES >= 4096)) ||
  die "RULEBRICKS_HOST_CHUNK_BYTES must be an integer of at least 4096."

DEPLOYMENT_DIR="$DEPLOYMENTS_ROOT/$DEPLOYMENT_NAME"
STATE_FILE="$DEPLOYMENT_DIR/state.yaml"
CONFIG_FILE="$DEPLOYMENT_DIR/config.yaml"

require_cmd() {
  command -v "$1" >/dev/null 2>&1 ||
    die "Required local command not found: $1"
}

# Read one direct child from a known top-level YAML mapping. Deployment and
# Azure names are scalar strings, so this intentionally avoids requiring yq.
yaml_section_value() {
  local file="$1"
  local section="$2"
  local key="$3"

  awk -v section="$section" -v key="$key" '
    $0 == section ":" {
      inside = 1
      next
    }
    inside && $0 ~ /^[^[:space:]]/ {
      exit
    }
    inside {
      line = $0
      sub(/^[[:space:]]+/, "", line)
      prefix = key ":"
      if (index(line, prefix) == 1) {
        sub("^[^:]+:[[:space:]]*", "", line)
        sub(/[[:space:]]+$/, "", line)
        if ((substr(line, 1, 1) == "\"" && substr(line, length(line), 1) == "\"") ||
            (substr(line, 1, 1) == "\047" && substr(line, length(line), 1) == "\047")) {
          line = substr(line, 2, length(line) - 2)
        }
        print line
        exit
      }
    }
  ' "$file"
}

shell_quote() {
  printf '%q' "$1"
}

require_cmd az

if [[ -z "$VM_NAME" || -z "$VM_RESOURCE_GROUP" ]]; then
  [[ -f "$STATE_FILE" ]] ||
    die "No state found for \"$DEPLOYMENT_NAME\". Run \"rulebricks host link $DEPLOYMENT_NAME\" or supply --vm and --resource-group."
  [[ -n "$VM_NAME" ]] ||
    VM_NAME="$(yaml_section_value "$STATE_FILE" linkedHost vmName)"
  [[ -n "$VM_RESOURCE_GROUP" ]] ||
    VM_RESOURCE_GROUP="$(yaml_section_value "$STATE_FILE" linkedHost vmResourceGroup)"
fi

[[ -n "$VM_NAME" && -n "$VM_RESOURCE_GROUP" ]] ||
  die "Deployment \"$DEPLOYMENT_NAME\" has no linked host. Run \"rulebricks host link $DEPLOYMENT_NAME\" or supply --vm and --resource-group."

if [[ "$REMOVE_CONFIG" -eq 0 ]]; then
  [[ -d "$DEPLOYMENT_DIR" ]] ||
    die "Local deployment directory not found: $DEPLOYMENT_DIR"
  [[ -f "$CONFIG_FILE" ]] ||
    die "Deployment configuration not found: $CONFIG_FILE"
fi

if [[ "$SKIP_VERIFY" -eq 0 && "$REMOVE_CONFIG" -eq 0 ]]; then
  CLUSTER_NAME="$(yaml_section_value "$CONFIG_FILE" infrastructure clusterName)"
  CLUSTER_RESOURCE_GROUP="$(yaml_section_value "$CONFIG_FILE" infrastructure azureResourceGroup)"
  [[ -n "$CLUSTER_NAME" && -n "$CLUSTER_RESOURCE_GROUP" ]] ||
    die "The deployment config must contain infrastructure.clusterName and infrastructure.azureResourceGroup."
else
  CLUSTER_NAME=""
  CLUSTER_RESOURCE_GROUP=""
fi

info "Resolving Azure VM $VM_NAME in $VM_RESOURCE_GROUP"
VM_DETAILS="$(
  az vm show \
    --resource-group "$VM_RESOURCE_GROUP" \
    --name "$VM_NAME" \
    --query '[id,osProfile.adminUsername]' \
    --output tsv \
    --only-show-errors
)" || die "Could not resolve Azure VM \"$VM_NAME\" in \"$VM_RESOURCE_GROUP\"."

VM_ID="$(printf '%s\n' "$VM_DETAILS" | awk 'NR == 1 { print; exit }')"
if [[ -z "$ADMIN_USER" ]]; then
  ADMIN_USER="$(printf '%s\n' "$VM_DETAILS" | awk 'NR == 2 { print; exit }')"
fi
[[ -n "$VM_ID" ]] || die "Azure returned no resource ID for the target VM."
[[ -n "$ADMIN_USER" ]] ||
  die "Azure returned no OS administrator user; supply --admin-user."
[[ "$ADMIN_USER" =~ ^[A-Za-z_][A-Za-z0-9._-]*$ ]] ||
  die "Unsafe or unsupported VM administrator user: $ADMIN_USER"

ADMIN_HOME="/home/$ADMIN_USER"
pass "Target: $ADMIN_USER@$VM_NAME ($VM_RESOURCE_GROUP)"

invoke_remote() {
  local phase="$1"
  local marker="$2"
  local remote_script="$3"
  local output
  local rc

  info "$phase"
  set +e
  output="$(
    az vm run-command invoke \
      --resource-group "$VM_RESOURCE_GROUP" \
      --name "$VM_NAME" \
      --command-id RunShellScript \
      --scripts "$remote_script" \
      --query 'value[0].message' \
      --output tsv \
      --only-show-errors 2>&1
  )"
  rc=$?
  set -e

  if [[ -n "$output" ]]; then
    printf '%s\n' "$output"
  fi
  if [[ "$rc" -ne 0 ]]; then
    printf 'ERROR: Azure Run Command failed during %s.\n' "$phase" >&2
    return "$rc"
  fi
  if [[ "$output" != *"$marker"* ]]; then
    printf 'ERROR: The VM did not report successful completion during %s.\n' "$phase" >&2
    return 1
  fi
}

if [[ "$REMOVE_CONFIG" -eq 1 ]]; then
  REMOVE_BODY=""
  IFS= read -r -d '' REMOVE_BODY <<'REMOTE' || true
set -Eeuo pipefail

destination="$ADMIN_HOME/.rulebricks/deployments/$DEPLOYMENT_NAME"
destination_parent="${destination%/*}"
removed=0
for path in \
  "$destination" \
  "$destination".bak.* \
  "$destination_parent/.$DEPLOYMENT_NAME".incoming.*; do
  [[ -e "$path" ]] || continue
  rm -rf -- "$path"
  printf 'Removed %s\n' "$path"
  removed=$((removed + 1))
done
if [[ "$removed" -eq 0 ]]; then
  printf 'Already absent: %s\n' "$destination"
fi
printf 'RB_REMOVE_OK\n'
REMOTE
  printf -v REMOVE_SCRIPT \
    '#!/usr/bin/env bash\nADMIN_USER=%s\nADMIN_HOME=%s\nDEPLOYMENT_NAME=%s\n%s\n' \
    "$(shell_quote "$ADMIN_USER")" \
    "$(shell_quote "$ADMIN_HOME")" \
    "$(shell_quote "$DEPLOYMENT_NAME")" \
    "$REMOVE_BODY"
  invoke_remote "Removing remote deployment configuration" "RB_REMOVE_OK" "$REMOVE_SCRIPT"
  printf '\nREADY: Remote configuration for %s is removed; installed tools were left untouched.\n' "$DEPLOYMENT_NAME"
  exit 0
fi

if [[ "$SKIP_TOOLS" -eq 0 ]]; then
  BOOTSTRAP_BODY=""
  IFS= read -r -d '' BOOTSTRAP_BODY <<'REMOTE' || true
set -Eeuo pipefail

LOG_FILE="/tmp/rulebricks-host-setup.log"
: >"$LOG_FILE"
exec 3>&1

fail() {
  local message="$1"
  printf 'FAIL: %s\n' "$message" >&3
  if [[ -s "$LOG_FILE" ]]; then
    printf '%s\n' '--- installer output ---' >&3
    tail -n 30 "$LOG_FILE" >&3
  fi
  printf 'RB_BOOTSTRAP_ERROR\n' >&3
  exit 1
}

note() {
  printf '%s\n' "$*" >&3
}

if [[ ! -r /etc/os-release ]]; then
  fail "Cannot detect this Linux distribution (/etc/os-release is missing)."
fi
# shellcheck disable=SC1091
. /etc/os-release

PACKAGE_MANAGER=""
if command -v apt-get >/dev/null 2>&1; then
  PACKAGE_MANAGER="apt"
elif command -v dnf >/dev/null 2>&1; then
  PACKAGE_MANAGER="dnf"
elif command -v yum >/dev/null 2>&1; then
  PACKAGE_MANAGER="yum"
elif command -v tdnf >/dev/null 2>&1; then
  PACKAGE_MANAGER="tdnf"
elif command -v zypper >/dev/null 2>&1; then
  PACKAGE_MANAGER="zypper"
else
  fail "Unsupported Linux distribution: ${PRETTY_NAME:-${ID:-unknown}} (no apt, dnf, yum, tdnf, or zypper)."
fi
note "Detected ${PRETTY_NAME:-$ID} ($PACKAGE_MANAGER)"

install_packages() {
  case "$PACKAGE_MANAGER" in
    apt)
      DEBIAN_FRONTEND=noninteractive apt-get update >>"$LOG_FILE" 2>&1
      DEBIAN_FRONTEND=noninteractive apt-get install -y "$@" >>"$LOG_FILE" 2>&1
      ;;
    dnf|yum|tdnf)
      "$PACKAGE_MANAGER" install -y "$@" >>"$LOG_FILE" 2>&1
      ;;
    zypper)
      zypper --non-interactive install -y "$@" >>"$LOG_FILE" 2>&1
      ;;
  esac
}

if ! command -v curl >/dev/null 2>&1; then
  note "Installing curl"
  install_packages curl ca-certificates || fail "Could not install curl."
fi

install_azure_cli() {
  case "$PACKAGE_MANAGER" in
    apt)
      curl -fsSL https://aka.ms/InstallAzureCLIDeb | bash >>"$LOG_FILE" 2>&1
      ;;
    dnf|yum)
      local major="${VERSION_ID%%.*}"
      local config_url
      case "$major" in
        8) config_url="https://packages.microsoft.com/config/rhel/8/packages-microsoft-prod.rpm" ;;
        9) config_url="https://packages.microsoft.com/config/rhel/9.0/packages-microsoft-prod.rpm" ;;
        10) config_url="https://packages.microsoft.com/config/rhel/10/packages-microsoft-prod.rpm" ;;
        *) config_url="" ;;
      esac
      rpm --import https://packages.microsoft.com/keys/microsoft.asc >>"$LOG_FILE" 2>&1
      if [[ -n "$config_url" ]]; then
        "$PACKAGE_MANAGER" install -y "$config_url" >>"$LOG_FILE" 2>&1
      else
        cat >/etc/yum.repos.d/azure-cli.repo <<'REPO'
[azure-cli]
name=Azure CLI
baseurl=https://packages.microsoft.com/yumrepos/azure-cli
enabled=1
gpgcheck=1
gpgkey=https://packages.microsoft.com/keys/microsoft.asc
REPO
      fi
      "$PACKAGE_MANAGER" install -y azure-cli >>"$LOG_FILE" 2>&1
      ;;
    tdnf)
      tdnf install -y azure-cli >>"$LOG_FILE" 2>&1
      ;;
    zypper)
      rpm --import https://packages.microsoft.com/keys/microsoft.asc >>"$LOG_FILE" 2>&1
      zypper --non-interactive addrepo --check \
        https://packages.microsoft.com/yumrepos/azure-cli azure-cli >>"$LOG_FILE" 2>&1 ||
        zypper --non-interactive modifyrepo --enable azure-cli >>"$LOG_FILE" 2>&1
      zypper --non-interactive --gpg-auto-import-keys refresh >>"$LOG_FILE" 2>&1
      zypper --non-interactive install -y --from azure-cli azure-cli >>"$LOG_FILE" 2>&1
      ;;
  esac
}

if command -v az >/dev/null 2>&1; then
  note "Keeping existing Azure CLI: $(az version --query '"azure-cli"' -o tsv 2>/dev/null || az --version 2>/dev/null | sed -n '1p')"
else
  note "Installing Azure CLI"
  install_azure_cli || fail "Could not install Azure CLI on ${PRETTY_NAME:-$ID}."
  command -v az >/dev/null 2>&1 || fail "Azure CLI installation completed but az is not on PATH."
fi

if command -v kubectl >/dev/null 2>&1 && command -v kubelogin >/dev/null 2>&1; then
  note "Keeping existing kubectl and kubelogin"
else
  note "Installing missing AKS client tools"
  kubectl_target="/usr/local/bin/kubectl"
  kubelogin_target="/usr/local/bin/kubelogin"
  kubectl_temporary=0
  kubelogin_temporary=0
  if command -v kubectl >/dev/null 2>&1; then
    kubectl_target="/tmp/rulebricks-kubectl-unused"
    kubectl_temporary=1
  fi
  if command -v kubelogin >/dev/null 2>&1; then
    kubelogin_target="/tmp/rulebricks-kubelogin-unused"
    kubelogin_temporary=1
  fi
  az aks install-cli \
    --install-location "$kubectl_target" \
    --kubelogin-install-location "$kubelogin_target" >>"$LOG_FILE" 2>&1 ||
    fail "Could not install kubectl and kubelogin."
  [[ "$kubectl_temporary" -eq 0 ]] || rm -f "$kubectl_target"
  [[ "$kubelogin_temporary" -eq 0 ]] || rm -f "$kubelogin_target"
fi

if command -v helm >/dev/null 2>&1; then
  note "Keeping existing Helm: $(helm version --short 2>/dev/null || true)"
else
  note "Installing Helm"
  curl -fsSL https://raw.githubusercontent.com/helm/helm/main/scripts/get-helm-3 |
    bash >>"$LOG_FILE" 2>&1 || fail "Could not install Helm."
fi

run_as_admin() {
  local command="$1"
  local prefix
  prefix='export PATH="$HOME/.local/bin:/usr/local/bin:/usr/bin:/bin:$PATH"
if [[ -s "$HOME/.nvm/nvm.sh" ]]; then
  export NVM_DIR="$HOME/.nvm"
  . "$NVM_DIR/nvm.sh"
fi'

  if command -v runuser >/dev/null 2>&1; then
    runuser -u "$ADMIN_USER" -- env \
      HOME="$ADMIN_HOME" USER="$ADMIN_USER" LOGNAME="$ADMIN_USER" \
      bash -c "$prefix
$command"
  else
    sudo -u "$ADMIN_USER" -H env \
      HOME="$ADMIN_HOME" USER="$ADMIN_USER" LOGNAME="$ADMIN_USER" \
      bash -c "$prefix
$command"
  fi
}

admin_node_major() {
  run_as_admin 'node -p "Number(process.versions.node.split(\".\")[0])"' 2>/dev/null || true
}

install_nvm_node() {
  note "Installing an isolated Node.js 24 runtime for $ADMIN_USER"
  run_as_admin '
    export NVM_DIR="$HOME/.nvm"
    if [[ ! -s "$NVM_DIR/nvm.sh" ]]; then
      PROFILE=/dev/null curl -fsSL https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.3/install.sh | bash
    fi
    . "$NVM_DIR/nvm.sh"
    nvm install 24
    nvm alias default 24
  ' >>"$LOG_FILE" 2>&1
}

node_major="$(admin_node_major)"
if [[ "$node_major" =~ ^[0-9]+$ ]] && ((node_major >= 20)); then
  node_version="$(run_as_admin 'node --version' 2>/dev/null || true)"
  note "Keeping existing Node.js: $node_version"
else
  note "Installing Node.js 24"
  case "$PACKAGE_MANAGER" in
    apt)
      curl -fsSL https://deb.nodesource.com/setup_24.x | bash >>"$LOG_FILE" 2>&1 ||
        fail "Could not configure the NodeSource repository."
      DEBIAN_FRONTEND=noninteractive apt-get install -y nodejs >>"$LOG_FILE" 2>&1 ||
        fail "Could not install Node.js 24."
      ;;
    dnf|yum)
      curl -fsSL https://rpm.nodesource.com/setup_24.x | bash >>"$LOG_FILE" 2>&1 ||
        fail "Could not configure the NodeSource repository."
      "$PACKAGE_MANAGER" install -y nodejs >>"$LOG_FILE" 2>&1 ||
        fail "Could not install Node.js 24."
      ;;
    tdnf|zypper)
      install_nvm_node || fail "Could not install Node.js 24 for $ADMIN_USER."
      ;;
  esac
  node_major="$(admin_node_major)"
  [[ "$node_major" =~ ^[0-9]+$ ]] && ((node_major >= 20)) ||
    fail "Node.js installation finished, but a compatible runtime is not available to $ADMIN_USER."
fi

had_rulebricks=0
if run_as_admin 'command -v rulebricks >/dev/null 2>&1'; then
  had_rulebricks=1
  note "Upgrading the existing Rulebricks CLI"
else
  note "Installing the Rulebricks CLI"
fi

npm_prefix="$(run_as_admin 'npm config get prefix' 2>/dev/null || true)"
if [[ "$npm_prefix" == "$ADMIN_HOME"* ]]; then
  if ! run_as_admin 'npm install -g @rulebricks/cli@latest' >>"$LOG_FILE" 2>&1; then
    if [[ "$had_rulebricks" -eq 1 ]]; then
      note "WARN: Could not check for a Rulebricks CLI update; keeping the installed version"
    else
      fail "Could not install the Rulebricks CLI."
    fi
  fi
else
  if ! npm install -g @rulebricks/cli@latest >>"$LOG_FILE" 2>&1; then
    if [[ "$had_rulebricks" -eq 1 ]]; then
      note "WARN: Could not check for a Rulebricks CLI update; keeping the installed version"
    else
      fail "Could not install the Rulebricks CLI."
    fi
  fi
fi

run_as_admin 'command -v rulebricks >/dev/null 2>&1' ||
  fail "Rulebricks CLI installation finished, but rulebricks is not on $ADMIN_USER's PATH."

note "Azure CLI: $(az version --query '"azure-cli"' -o tsv 2>/dev/null || true)"
note "kubectl: $(kubectl version --client=true -o yaml 2>/dev/null | awk '/gitVersion:/ {print $2; exit}' || true)"
note "kubelogin: $(kubelogin --version 2>/dev/null | sed -n '1p' || true)"
note "Helm: $(helm version --short 2>/dev/null || true)"
note "Node.js: $(run_as_admin 'node --version' 2>/dev/null || true)"
note "Rulebricks: $(run_as_admin 'rulebricks --version' 2>/dev/null || true)"
printf 'RB_BOOTSTRAP_OK\n' >&3
REMOTE
  printf -v BOOTSTRAP_SCRIPT \
    '#!/usr/bin/env bash\nADMIN_USER=%s\nADMIN_HOME=%s\n%s\n' \
    "$(shell_quote "$ADMIN_USER")" \
    "$(shell_quote "$ADMIN_HOME")" \
    "$BOOTSTRAP_BODY"

  invoke_remote "Ensuring Azure, Kubernetes, Helm, Node.js, and Rulebricks tools" \
    "RB_BOOTSTRAP_OK" "$BOOTSTRAP_SCRIPT"
else
  info "Skipping tool setup"
fi

if [[ "$SKIP_CONFIG" -eq 0 ]]; then
  require_cmd tar
  require_cmd base64
  require_cmd split

  TEMP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/rulebricks-host-sync.XXXXXX")"
  ARCHIVE_FILE="$TEMP_DIR/deployment.tgz"
  PAYLOAD_FILE="$TEMP_DIR/deployment.b64"
  CHUNK_PREFIX="$TEMP_DIR/chunk."
  REMOTE_PAYLOAD="/tmp/rulebricks-host-$DEPLOYMENT_NAME.b64"

  info "Packing current deployment configuration"
  COPYFILE_DISABLE=1 tar --no-xattrs \
    -C "$DEPLOYMENTS_ROOT" -czf "$ARCHIVE_FILE" -- "$DEPLOYMENT_NAME"
  base64 <"$ARCHIVE_FILE" | tr -d '\r\n' >"$PAYLOAD_FILE"
  split -b "$CHUNK_BYTES" "$PAYLOAD_FILE" "$CHUNK_PREFIX"

  INIT_BODY=""
  IFS= read -r -d '' INIT_BODY <<'REMOTE' || true
set -Eeuo pipefail
umask 077
: >"$REMOTE_PAYLOAD"
printf 'RB_SYNC_INIT_OK\n'
REMOTE
  printf -v INIT_SCRIPT \
    '#!/usr/bin/env bash\nREMOTE_PAYLOAD=%s\n%s\n' \
    "$(shell_quote "$REMOTE_PAYLOAD")" \
    "$INIT_BODY"
  invoke_remote "Preparing secure configuration transfer" "RB_SYNC_INIT_OK" "$INIT_SCRIPT"

  chunk_count="$(awk 'END { print NR }' < <(printf '%s\n' "$CHUNK_PREFIX"* 2>/dev/null))"
  chunk_index=0
  for chunk_file in "$CHUNK_PREFIX"*; do
    [[ -f "$chunk_file" ]] || continue
    chunk_index=$((chunk_index + 1))
    chunk="$(<"$chunk_file")"
    CHUNK_BODY=""
    IFS= read -r -d '' CHUNK_BODY <<REMOTE || true
set -Eeuo pipefail
umask 077
cat >>"\$REMOTE_PAYLOAD" <<'RULEBRICKS_CONFIG_CHUNK'
$chunk
RULEBRICKS_CONFIG_CHUNK
printf 'RB_SYNC_CHUNK_OK\n'
REMOTE
    printf -v CHUNK_SCRIPT \
      '#!/usr/bin/env bash\nREMOTE_PAYLOAD=%s\n%s\n' \
      "$(shell_quote "$REMOTE_PAYLOAD")" \
      "$CHUNK_BODY"
    invoke_remote "Uploading configuration chunk $chunk_index/$chunk_count" \
      "RB_SYNC_CHUNK_OK" "$CHUNK_SCRIPT"
  done

  FINALIZE_BODY=""
  IFS= read -r -d '' FINALIZE_BODY <<'REMOTE' || true
set -Eeuo pipefail

staging="$(mktemp -d /tmp/rulebricks-host-config.XXXXXX)"
destination_parent="$ADMIN_HOME/.rulebricks/deployments"
destination="$destination_parent/$DEPLOYMENT_NAME"
incoming="$destination_parent/.$DEPLOYMENT_NAME.incoming.$$"

cleanup() {
  rm -rf "$staging" "$incoming"
  rm -f "$REMOTE_PAYLOAD"
}
trap cleanup EXIT

base64 -d "$REMOTE_PAYLOAD" >"$staging/deployment.tgz"
tar -xzf "$staging/deployment.tgz" -C "$staging"
source_dir="$staging/$DEPLOYMENT_NAME"
[[ -d "$source_dir" ]] || {
  printf 'FAIL: Uploaded archive does not contain %s\n' "$DEPLOYMENT_NAME"
  printf 'RB_SYNC_ERROR\n'
  exit 1
}

install -d -m 700 -o "$ADMIN_USER" -g "$ADMIN_USER" \
  "$ADMIN_HOME/.rulebricks" "$destination_parent"
mkdir -m 700 "$incoming"
cp -a "$source_dir/." "$incoming/"
chown -R "$ADMIN_USER:$ADMIN_USER" "$incoming"
find "$incoming" -type d -exec chmod 700 {} +
find "$incoming" -type f -exec chmod 600 {} +

if [[ -e "$destination" ]]; then
  backup="$destination.bak.$(date -u +%Y%m%dT%H%M%SZ)"
  mv "$destination" "$backup"
  printf 'Backed up prior configuration to %s\n' "$backup"
fi
mv "$incoming" "$destination"
printf 'Configuration installed at %s\n' "$destination"
printf 'RB_SYNC_OK\n'
REMOTE
  printf -v FINALIZE_SCRIPT \
    '#!/usr/bin/env bash\nADMIN_USER=%s\nADMIN_HOME=%s\nDEPLOYMENT_NAME=%s\nREMOTE_PAYLOAD=%s\n%s\n' \
    "$(shell_quote "$ADMIN_USER")" \
    "$(shell_quote "$ADMIN_HOME")" \
    "$(shell_quote "$DEPLOYMENT_NAME")" \
    "$(shell_quote "$REMOTE_PAYLOAD")" \
    "$FINALIZE_BODY"

  invoke_remote "Installing deployment configuration" "RB_SYNC_OK" "$FINALIZE_SCRIPT"
else
  info "Skipping configuration sync"
fi

if [[ "$SKIP_VERIFY" -eq 0 ]]; then
  VERIFY_BODY=""
  IFS= read -r -d '' VERIFY_BODY <<'REMOTE' || true
set -Eeuo pipefail

LOG_FILE="/tmp/rulebricks-host-verify.log"
: >"$LOG_FILE"

run_as_admin() {
  local command="$1"
  local prefix
  prefix='export PATH="$HOME/.local/bin:/usr/local/bin:/usr/bin:/bin:$PATH"
if [[ -s "$HOME/.nvm/nvm.sh" ]]; then
  export NVM_DIR="$HOME/.nvm"
  . "$NVM_DIR/nvm.sh"
fi'

  if command -v runuser >/dev/null 2>&1; then
    runuser -u "$ADMIN_USER" -- env \
      HOME="$ADMIN_HOME" USER="$ADMIN_USER" LOGNAME="$ADMIN_USER" \
      CLUSTER_NAME="$CLUSTER_NAME" \
      CLUSTER_RESOURCE_GROUP="$CLUSTER_RESOURCE_GROUP" \
      DEPLOYMENT_NAME="$DEPLOYMENT_NAME" \
      bash -c "$prefix
$command"
  else
    sudo -u "$ADMIN_USER" -H env \
      HOME="$ADMIN_HOME" USER="$ADMIN_USER" LOGNAME="$ADMIN_USER" \
      CLUSTER_NAME="$CLUSTER_NAME" \
      CLUSTER_RESOURCE_GROUP="$CLUSTER_RESOURCE_GROUP" \
      DEPLOYMENT_NAME="$DEPLOYMENT_NAME" \
      bash -c "$prefix
$command"
  fi
}

fail() {
  printf 'FAIL: %s\n' "$1"
  if [[ -s "$LOG_FILE" ]]; then
    printf '%s\n' '--- verification output ---'
    tail -n 20 "$LOG_FILE"
  fi
  printf 'RB_VERIFY_ERROR\n'
  exit 1
}

if ! run_as_admin 'az login --identity --output none' >>"$LOG_FILE" 2>&1; then
  fail "Managed-identity login failed. Run \"rulebricks host link $DEPLOYMENT_NAME\" and retry."
fi
printf 'PASS: managed-identity login\n'

if ! run_as_admin \
  'az aks get-credentials --resource-group "$CLUSTER_RESOURCE_GROUP" --name "$CLUSTER_NAME" --overwrite-existing' \
  >>"$LOG_FILE" 2>&1; then
  fail "AKS credentials could not be retrieved. Check the linked host's AKS Cluster User grant."
fi
printf 'PASS: AKS credentials\n'

if run_as_admin 'grep -q "command: kubelogin" "$HOME/.kube/config"'; then
  if ! run_as_admin 'kubelogin convert-kubeconfig -l msi' >>"$LOG_FILE" 2>&1; then
    fail "kubelogin could not configure managed-identity Kubernetes authentication."
  fi
  printf 'PASS: kubelogin managed-identity authentication\n'
fi

if ! run_as_admin \
  'kubectl get nodes --request-timeout=30s -o name' >>"$LOG_FILE" 2>&1; then
  fail "kubectl could not reach or authorize against the AKS cluster."
fi
node_count="$(grep -c '^node/' "$LOG_FILE" || true)"
printf 'PASS: kubectl cluster access (%s node%s)\n' \
  "$node_count" "$([[ "$node_count" == "1" ]] && printf '' || printf 's')"

if ! cli_version="$(run_as_admin 'rulebricks --version' 2>>"$LOG_FILE")"; then
  fail "The Rulebricks CLI is not available to $ADMIN_USER."
fi
printf 'PASS: Rulebricks CLI %s\n' "$cli_version"

config_path="$ADMIN_HOME/.rulebricks/deployments/$DEPLOYMENT_NAME/config.yaml"
[[ -f "$config_path" ]] ||
  fail "Remote deployment config is missing: $config_path"
printf 'PASS: deployment configuration\n'
printf 'RB_VERIFY_OK\n'
REMOTE
  printf -v VERIFY_SCRIPT \
    '#!/usr/bin/env bash\nADMIN_USER=%s\nADMIN_HOME=%s\nDEPLOYMENT_NAME=%s\nCLUSTER_NAME=%s\nCLUSTER_RESOURCE_GROUP=%s\n%s\n' \
    "$(shell_quote "$ADMIN_USER")" \
    "$(shell_quote "$ADMIN_HOME")" \
    "$(shell_quote "$DEPLOYMENT_NAME")" \
    "$(shell_quote "$CLUSTER_NAME")" \
    "$(shell_quote "$CLUSTER_RESOURCE_GROUP")" \
    "$VERIFY_BODY"

  invoke_remote "Verifying managed identity, AKS, and Rulebricks access" \
    "RB_VERIFY_OK" "$VERIFY_SCRIPT"
else
  info "Skipping cluster access verification"
fi

printf '\nREADY: %s is prepared on %s.\n' "$DEPLOYMENT_NAME" "$VM_NAME"
printf 'Re-run this script to sync your latest Rulebricks configurations and CLI version.\n'
printf 'The VM can now run: rulebricks deploy %s\n' "$DEPLOYMENT_NAME"
