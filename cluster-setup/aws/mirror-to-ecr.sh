#!/usr/bin/env bash
set -euo pipefail
#
# Seed Amazon ECR with every image a Rulebricks deployment pulls, so clusters
# with no (or restricted) egress to Docker Hub can run fully self-contained.
# This is the push-based alternative to the stack's EnableRegistryMirror
# pull-through cache (use the cache when the cluster can reach Docker Hub at
# least once per image; use this script for fully air-gapped seeding).
#
# Copies two sets of images from the private docker.io/rulebricks/* namespace
# (authenticated by your Rulebricks license credentials) into your ECR
# registry, preserving the rulebricks/<name>:<tag> path so the deployment's
# single imageRegistry override (registry HOST swap) covers everything:
#
#   1. Infrastructure images from the chart's images/manifest.yaml
#      (the single source of truth shipped inside each chart version).
#   2. Product images for the app, HPS, and HPS workers
#      (rulebricks/hps:worker-<version>), governed by your product version.
#
# Unlike `az acr import` there is no server-side import API, so this machine
# pulls each image and pushes it to ECR (crane copies layers without a local
# daemon when available; docker is the fallback). Expect roughly 30-60 minutes
# for a first full seed; re-runs refresh tags in place.
#
# Usage:
#   bash mirror-to-ecr.sh --region <awsRegion> --version <productVersion> \
#       [--registry <accountId>.dkr.ecr.<region>.amazonaws.com] \
#       [--chart-version <chartVersion>] [--manifest <path>] [--dry-run]
#
#   --region         AWS region of the ECR registry.
#   --registry       ECR registry host (default: the caller account's registry
#                    in --region).
#   --version        Rulebricks product version (e.g. 1.8.17) for app/HPS/worker.
#                    Omit to seed only the infrastructure images.
#   --chart-version  Chart version whose image manifest to mirror (default:
#                    latest published chart).
#   --manifest       Local images/manifest.yaml to use instead of fetching one.
#   --dry-run        Print the copy commands without running them.
#
# Credentials for the private docker.io/rulebricks/* source (from onboarding):
#   DOCKERHUB_USERNAME   Docker Hub username tied to your license
#   DOCKERHUB_TOKEN      the license pull token (PAT)
#
# Requires: aws (logged in, ECR push access), yq, and crane or docker; helm or
# curl to fetch the chart's image manifest when --manifest is not given.

REGION=""
REGISTRY=""
PRODUCT_VERSION=""
CHART_VERSION=""
MANIFEST_PATH=""
DRY_RUN=0

CHART_OCI="oci://ghcr.io/rulebricks/helm/stack"
MANIFEST_RAW_URL="https://raw.githubusercontent.com/rulebricks/helm"

usage() {
  sed -n '4,46p' "$0" | sed 's/^# \{0,1\}//'
}

die() { printf 'ERROR: %s\n' "$*" >&2; exit 1; }

while [ "$#" -gt 0 ]; do
  case "$1" in
    --region)        REGION="${2:?}"; shift 2 ;;
    --registry)      REGISTRY="${2:?}"; shift 2 ;;
    --version)       PRODUCT_VERSION="${2:?}"; shift 2 ;;
    --chart-version) CHART_VERSION="${2:?}"; shift 2 ;;
    --manifest)      MANIFEST_PATH="${2:?}"; shift 2 ;;
    --dry-run)       DRY_RUN=1; shift ;;
    -h|--help)       usage; exit 0 ;;
    *)               usage >&2; die "unknown argument: $1" ;;
  esac
done

[ -n "$REGION" ] || { usage >&2; die "--region is required"; }
command -v aws >/dev/null 2>&1 || die "aws CLI not found"
command -v yq >/dev/null 2>&1 || die "yq not found (https://github.com/mikefarah/yq)"
[ -n "${DOCKERHUB_USERNAME:-}" ] || die "DOCKERHUB_USERNAME is not set (your license's Docker Hub username)"
[ -n "${DOCKERHUB_TOKEN:-}" ] || die "DOCKERHUB_TOKEN is not set (your license's pull token)"

COPIER=""
if command -v crane >/dev/null 2>&1; then
  COPIER="crane"
elif command -v docker >/dev/null 2>&1; then
  COPIER="docker"
else
  die "neither crane nor docker found (crane recommended: https://github.com/google/go-containerregistry)"
fi

if [ -z "$REGISTRY" ]; then
  ACCOUNT_ID="$(aws sts get-caller-identity --query Account --output text)" \
    || die "could not resolve the AWS account id (is the aws CLI logged in?)"
  REGISTRY="${ACCOUNT_ID}.dkr.ecr.${REGION}.amazonaws.com"
fi

if [ -z "$PRODUCT_VERSION" ]; then
  echo "note: --version not given; seeding infrastructure images only" \
       "(re-run with --version <productVersion> for app/HPS/worker)." >&2
fi

# ----------------------------------------------------------------------------
# Authenticate the copier against both registries.
# ----------------------------------------------------------------------------
ECR_PASSWORD="$(aws ecr get-login-password --region "$REGION")" \
  || die "aws ecr get-login-password failed"

if [ "$DRY_RUN" -eq 0 ]; then
  if [ "$COPIER" = "crane" ]; then
    crane auth login docker.io -u "$DOCKERHUB_USERNAME" -p "$DOCKERHUB_TOKEN" >/dev/null
    crane auth login "$REGISTRY" -u AWS -p "$ECR_PASSWORD" >/dev/null
  else
    printf '%s' "$DOCKERHUB_TOKEN" | docker login docker.io -u "$DOCKERHUB_USERNAME" --password-stdin >/dev/null
    printf '%s' "$ECR_PASSWORD" | docker login "$REGISTRY" -u AWS --password-stdin >/dev/null
  fi
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
# Copy loop. Source path == target path (rulebricks/<name-or-target>:<tag>),
# so the deployment's imageRegistry host swap resolves every image. ECR
# requires the repository to exist before push; create-if-absent per repo.
# ----------------------------------------------------------------------------
FAILED=()
IMPORTED=0

ensure_repo() {
  local repo="$1"
  aws ecr describe-repositories --region "$REGION" --repository-names "$repo" >/dev/null 2>&1 \
    || aws ecr create-repository --region "$REGION" --repository-name "$repo" >/dev/null
}

import_image() {
  local repo_tag="$1"
  local repo="${repo_tag%%:*}"
  echo "==> copy ${repo_tag}"
  if [ "$DRY_RUN" -eq 1 ]; then
    echo "    ${COPIER} copy docker.io/${repo_tag} ${REGISTRY}/${repo_tag}"
    return
  fi
  if ! ensure_repo "$repo"; then
    FAILED+=("${repo_tag}")
    return
  fi
  local ok=0
  if [ "$COPIER" = "crane" ]; then
    # crane copy preserves multi-arch manifest lists without a local daemon.
    crane copy "docker.io/${repo_tag}" "${REGISTRY}/${repo_tag}" >/dev/null && ok=1
  else
    docker pull "docker.io/${repo_tag}" >/dev/null \
      && docker tag "docker.io/${repo_tag}" "${REGISTRY}/${repo_tag}" \
      && docker push "${REGISTRY}/${repo_tag}" >/dev/null && ok=1
  fi
  if [ "$ok" -eq 1 ]; then
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
  echo "dry run complete (no images copied)."
  exit 0
fi

echo "copied ${IMPORTED} image(s) into ${REGISTRY}"
if [ "${#FAILED[@]}" -gt 0 ]; then
  echo "FAILED (${#FAILED[@]}):"
  printf '  %s\n' "${FAILED[@]}"
  echo "re-run this script to retry; already-copied tags are refreshed in place." >&2
  exit 1
fi

cat <<EOF

Next step: point the deployment at the mirror by setting imageRegistry in your
Rulebricks deployment config to the registry host:

  imageRegistry: ${REGISTRY}

The CLI rewrites every chart image to ${REGISTRY}/rulebricks/<name> at deploy
time; EKS nodes authenticate via the AmazonEC2ContainerRegistryReadOnly policy
on the node role (no imagePullSecret needed).
EOF
