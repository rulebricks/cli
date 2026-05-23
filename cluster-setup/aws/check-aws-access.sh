#!/usr/bin/env bash
set -euo pipefail

REGION="${AWS_REGION:-${AWS_DEFAULT_REGION:-us-east-1}}"
REQUIRED_VCPU=8

require_cmd() {
  command -v "$1" >/dev/null 2>&1 || {
    echo "Missing required command: $1" >&2
    exit 1
  }
}

check_aws() {
  echo "Checking AWS identity..."
  aws sts get-caller-identity --output table
  echo
}

check_permission() {
  local label="$1"
  shift
  if "$@" >/dev/null 2>&1; then
    echo "OK: $label"
  else
    echo "WARN: Could not verify $label"
    echo "      Command failed: $*"
  fi
}

check_quota() {
  echo "Checking regional on-demand vCPU quota in $REGION..."
  local quota
  quota="$(aws service-quotas get-service-quota \
    --service-code ec2 \
    --quota-code L-1216C47A \
    --region "$REGION" \
    --query 'Quota.Value' \
    --output text 2>/dev/null || true)"

  if [[ -z "$quota" || "$quota" == "None" ]]; then
    echo "WARN: Could not read EC2 on-demand vCPU quota."
    return
  fi

  local quota_int="${quota%.*}"
  if (( quota_int < REQUIRED_VCPU )); then
    echo "WARN: Quota may be too low: ${quota} vCPU available, ${REQUIRED_VCPU}+ recommended for the included cluster config."
  else
    echo "OK: EC2 on-demand vCPU quota is ${quota}."
  fi
}

require_cmd aws
require_cmd eksctl
require_cmd kubectl
require_cmd helm

echo "Rulebricks AWS access checks"
echo "Region: $REGION"
echo

check_aws
check_permission "EKS access" aws eks list-clusters --region "$REGION"
check_permission "EC2 VPC access" aws ec2 describe-vpcs --region "$REGION" --max-items 5
check_permission "IAM access" aws iam get-user
check_permission "ECR public image pull path" aws ecr-public describe-registries --region us-east-1
check_quota

echo
echo "Checking local Kubernetes tools..."
eksctl version >/dev/null
kubectl version --client=true >/dev/null
helm version >/dev/null
echo "OK: eksctl, kubectl, and Helm are installed."

echo
echo "AWS access checks completed. Warnings may require cloud-admin review before cluster creation."
