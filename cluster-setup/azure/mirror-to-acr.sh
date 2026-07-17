#!/usr/bin/env bash
set -euo pipefail
#
# Seed an Azure Container Registry with every image a
# Rulebricks deployment pulls, so clusters with no (or restricted) egress to
# Docker Hub can run fully self-contained.
#
# Copies two sets of images from the private docker.io/rulebricks/* namespace
# (authenticated by your Rulebricks license credentials) into your ACR,
# preserving the rulebricks/<name>:<tag> path so the deployment's single
# imageRegistry override (registry HOST swap) covers everything:
#
#   1. Infrastructure images from the chart's images/manifest.yaml
#      (the single source of truth shipped inside each chart version).
#   2. Product images for the app, HPS, and HPS workers
#      (rulebricks/hps:worker-<version>), governed by your product version.
#
# Imports run server-side via `az acr import` (multi-arch manifest lists are
# preserved; nothing is pulled to this machine). Expect roughly 15-30 minutes
# for a first full seed; re-runs refresh tags in place (--force).
#
# Usage:
#   bash mirror-to-acr.sh --registry <acrName> --version <productVersion> \
#       [--chart-version <chartVersion>] [--manifest <path>] [--dry-run]
#
#   --registry       ACR name (the containerRegistryName deployment output).
#   --version        Rulebricks product version (e.g. 1.8.17) for app/HPS/worker.
#                    Omit to seed only the infrastructure images.
#   --chart-version  Chart version whose image manifest to mirror (default:
#                    latest published chart).
#   --manifest       Local images/manifest.yaml to use instead of fetching one.
#   --dry-run        Print the az acr import commands without running them.
#
# Credentials for the private docker.io/rulebricks/* source (from onboarding):
#   DOCKERHUB_USERNAME   Docker Hub username tied to your license
#   DOCKERHUB_TOKEN      the license pull token (PAT)
#
# Requires: az (logged in, Contributor on the registry), yq, and helm or curl
# (to fetch the chart's image manifest when --manifest is not given).

REGISTRY=""
PRODUCT_VERSION=""
CHART_VERSION=""
MANIFEST_PATH=""
DRY_RUN=0

CHART_OCI="oci://ghcr.io/rulebricks/helm/stack"
MANIFEST_RAW_URL="https://raw.githubusercontent.com/rulebricks/helm"

usage() {
  sed -n '4,39p' "$0" | sed 's/^# \{0,1\}//'
}

die() { printf 'ERROR: %s\n' "$*" >&2; exit 1; }

while [ "$#" -gt 0 ]; do
  case "$1" in
    --registry)      REGISTRY="${2:?}"; shift 2 ;;
    --version)       PRODUCT_VERSION="${2:?}"; shift 2 ;;
    --chart-version) CHART_VERSION="${2:?}"; shift 2 ;;
    --manifest)      MANIFEST_PATH="${2:?}"; shift 2 ;;
    --dry-run)       DRY_RUN=1; shift ;;
    -h|--help)       usage; exit 0 ;;
    *)               usage >&2; die "unknown argument: $1" ;;
  esac
done

[ -n "$REGISTRY" ] || { usage >&2; die "--registry is required"; }
command -v az >/dev/null 2>&1 || die "az CLI not found"
command -v yq >/dev/null 2>&1 || die "yq not found (https://github.com/mikefarah/yq)"
[ -n "${DOCKERHUB_USERNAME:-}" ] || die "DOCKERHUB_USERNAME is not set (your license's Docker Hub username)"
[ -n "${DOCKERHUB_TOKEN:-}" ] || die "DOCKERHUB_TOKEN is not set (your license's pull token)"

if [ -z "$PRODUCT_VERSION" ]; then
  echo "note: --version not given; seeding infrastructure images only" \
       "(re-run with --version <productVersion> for app/HPS/worker)." >&2
fi

# ----------------------------------------------------------------------------
# Resolve images/manifest.yaml: --manifest > helm pull (exact chart) > GitHub.
# ----------------------------------------------------------------------------
fetch_manifest() {
  if [ -n "$MANIFEST_PATH" ]; then
    [ -f "$MANIFEST_PATH" ] || die "manifest not found: $MANIFEST_PATH"
    printf '%s' "$MANIFEST_PATH"
    return
  fi

  local tmp
  tmp="$(mktemp -d)"
  if command -v helm >/dev/null 2>&1; then
    local args=(pull "$CHART_OCI" --untar --untardir "$tmp")
    [ -n "$CHART_VERSION" ] && args+=(--version "$CHART_VERSION")
    if helm "${args[@]}" >/dev/null 2>&1; then
      local found
      found="$(find "$tmp" -maxdepth 3 -path '*/images/manifest.yaml' | head -n1)"
      if [ -n "$found" ]; then
        printf '%s' "$found"
        return
      fi
    fi
  fi

  if command -v curl >/dev/null 2>&1; then
    local ref="main"
    [ -n "$CHART_VERSION" ] && ref="v${CHART_VERSION}"
    if curl -fsSL "${MANIFEST_RAW_URL}/${ref}/images/manifest.yaml" -o "$tmp/manifest.yaml"; then
      printf '%s' "$tmp/manifest.yaml"
      return
    fi
  fi

  die "could not fetch the chart image manifest (helm pull and GitHub both failed); pass --manifest <path>"
}

MANIFEST="$(fetch_manifest)"
echo "==> image manifest: $MANIFEST"

# ----------------------------------------------------------------------------
# Import loop. Source path == target path (rulebricks/<name-or-target>:<tag>),
# so the deployment's imageRegistry host swap resolves every image.
# ----------------------------------------------------------------------------
FAILED=()
IMPORTED=0

import_image() {
  local repo_tag="$1"
  echo "==> import ${repo_tag}"
  if [ "$DRY_RUN" -eq 1 ]; then
    echo "    az acr import --name $REGISTRY --source docker.io/${repo_tag} --image ${repo_tag} --force"
    return
  fi
  if az acr import \
       --name "$REGISTRY" \
       --source "docker.io/${repo_tag}" \
       --image "${repo_tag}" \
       --username "$DOCKERHUB_USERNAME" \
       --password "$DOCKERHUB_TOKEN" \
       --force \
       --only-show-errors; then
    IMPORTED=$((IMPORTED + 1))
  else
    FAILED+=("${repo_tag}")
  fi
}

# Infrastructure images: name + tag (+ optional explicit target repo).
while IFS=$'\t' read -r name tag target; do
  [ -n "$name" ] || continue
  repo="${target:-rulebricks/${name}}"
  import_image "${repo}:${tag}"
done < <(yq -r '.images[] | [.name, .tag, .target // ""] | @tsv' "$MANIFEST")

# Product images, governed by the deployment's product version.
if [ -n "$PRODUCT_VERSION" ]; then
  import_image "rulebricks/app:${PRODUCT_VERSION}"
  import_image "rulebricks/hps:${PRODUCT_VERSION}"
  import_image "rulebricks/hps:worker-${PRODUCT_VERSION}"
fi

# ----------------------------------------------------------------------------
# Summary
# ----------------------------------------------------------------------------
echo
if [ "$DRY_RUN" -eq 1 ]; then
  echo "dry run complete (no images imported)."
  exit 0
fi

echo "imported ${IMPORTED} image(s) into ${REGISTRY}.azurecr.io"
if [ "${#FAILED[@]}" -gt 0 ]; then
  echo "FAILED (${#FAILED[@]}):"
  printf '  %s\n' "${FAILED[@]}"
  echo "re-run this script to retry; already-imported tags are refreshed in place." >&2
  exit 1
fi

cat <<EOF

Next step: point the deployment at the mirror by setting imageRegistry in your
Rulebricks deployment config to the registry login server:

  imageRegistry: ${REGISTRY}.azurecr.io

The CLI rewrites every chart image to ${REGISTRY}.azurecr.io/rulebricks/<name>
at deploy time; AKS nodes authenticate via the AcrPull role the Bicep template
granted to the cluster's kubelet identity (no imagePullSecret needed).
EOF
