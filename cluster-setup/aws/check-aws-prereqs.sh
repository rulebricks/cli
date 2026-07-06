#!/usr/bin/env bash
# Rulebricks AWS / EKS prerequisite check.
#
# Prints a short pass/fail report and a final READY / NOT READY verdict
# with the exact actions you need to take before deploying the CloudFormation
# stack.
#
# Env vars:
#   AWS_REGION / AWS_DEFAULT_REGION   Region to check (default: us-east-1)
#   AWS_PROFILE                       Optional named profile to verify
#   VERBOSE=1                         Print raw AWS error messages inline

set -euo pipefail

if [[ -z "${BASH_VERSION:-}" ]]; then
  exec bash "$0" "$@"
fi

export AWS_PAGER=""

REGION="${AWS_REGION:-${AWS_DEFAULT_REGION:-us-east-1}}"
# Worst case with template defaults: core nodegroup at its 6-node max
# (6 x m7i.xlarge = 24 vCPU) + burst node (m7i.4xlarge = 16 vCPU) = 40.
# The launch floor is 12 (3 x m7i.xlarge); this checks the ceiling so a
# quota surprise never shows up mid-burst.
REQUIRED_VCPU=40
VERBOSE="${VERBOSE:-0}"

ACTIONS=()
BLOCKERS=0

# ---------- helpers ----------

require_cmd() {
  command -v "$1" >/dev/null 2>&1 || {
    printf "ERROR: required command not found: %s\n" "$1" >&2
    exit 1
  }
}

# Run an aws command. Sets AWS_STDOUT / AWS_STDERR / AWS_RC. Never aborts.
aws_run() {
  AWS_STDOUT=""; AWS_STDERR=""; AWS_RC=0
  local _err
  _err="$(mktemp)"
  AWS_STDOUT="$(aws "$@" 2>"$_err")" || AWS_RC=$?
  AWS_STDERR="$(cat "$_err")"
  rm -f "$_err"
  if [[ "$VERBOSE" == "1" && -n "$AWS_STDERR" ]]; then
    printf "      debug: %s\n" "${AWS_STDERR%%$'\n'*}" >&2
  fi
  return "$AWS_RC"
}

is_auth_error() {
  [[ "$AWS_STDERR" == *"ExpiredToken"*           ]] && return 0
  [[ "$AWS_STDERR" == *"InvalidClientTokenId"*   ]] && return 0
  [[ "$AWS_STDERR" == *"UnrecognizedClientException"* ]] && return 0
  [[ "$AWS_STDERR" == *"Unable to locate credentials"* ]] && return 0
  [[ "$AWS_STDERR" == *"SignatureDoesNotMatch"*  ]] && return 0
  [[ "$AWS_STDERR" == *"TokenRefreshRequired"*   ]] && return 0
  [[ "$AWS_STDERR" == *"SSOTokenLoadError"*      ]] && return 0
  [[ "$AWS_STDERR" == *"sso login"*              ]] && return 0
  return 1
}

row() {
  printf "  %-50s %s\n" "$1" "$2"
}

mark_blocker() { BLOCKERS=$((BLOCKERS + 1)); }
add_action()   { ACTIONS+=("$1"); }

login_hint() {
  if [[ -n "${AWS_PROFILE:-}" ]]; then
    printf "aws sso login --profile %s   (or refresh credentials for profile '%s')" "$AWS_PROFILE" "$AWS_PROFILE"
  else
    printf "aws sso login   (or 'aws configure' to set up credentials)"
  fi
}

# ---------- pre-flight ----------
# Note: eksctl is NOT required. The cluster is deployed via a single
# CloudFormation stack, so only the AWS CLI plus kubectl/helm are needed.

require_cmd aws
require_cmd kubectl
require_cmd helm

printf "Rulebricks AWS prerequisite check\n"
printf "  Region:  %s\n" "$REGION"
[[ -n "${AWS_PROFILE:-}" ]] && printf "  Profile: %s\n" "$AWS_PROFILE"
printf "\n"

# ---------- 1. Authentication ----------
AUTH_OK=0
ACCOUNT_ID=""
CALLER_ARN=""

if aws_run sts get-caller-identity --query "Account" --output text; then
  ACCOUNT_ID="$AWS_STDOUT"
  if aws_run sts get-caller-identity --query "Arn" --output text; then
    CALLER_ARN="$AWS_STDOUT"
  fi
  row "AWS credentials valid" "OK ($ACCOUNT_ID)"
  [[ -n "$CALLER_ARN" ]] && row "Caller identity" "$CALLER_ARN"
  AUTH_OK=1
else
  if is_auth_error; then
    row "AWS credentials valid" "FAIL - credentials missing or expired"
  else
    row "AWS credentials valid" "FAIL - ${AWS_STDERR%%$'\n'*}"
  fi
  add_action "Refresh credentials: $(login_hint)"
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

# ---------- 2. Service access ----------
# These cover what the CloudFormation stack touches: EKS, EC2/VPC, IAM (roles +
# Pod Identity associations), S3 (log/backup buckets), APS (managed Prometheus),
# and CloudFormation itself.
declare -a missing_access=()

aws_run eks list-clusters --region "$REGION" --output text >/dev/null \
  || missing_access+=("eks:ListClusters")
aws_run ec2 describe-vpcs --region "$REGION" --max-items 5 --output text >/dev/null \
  || missing_access+=("ec2:DescribeVpcs")
aws_run iam list-roles --max-items 5 --output text >/dev/null \
  || missing_access+=("iam:ListRoles")
aws_run s3api list-buckets --output text >/dev/null \
  || missing_access+=("s3:ListAllMyBuckets")
aws_run aps list-workspaces --region "$REGION" --output text >/dev/null \
  || missing_access+=("aps:ListWorkspaces")
aws_run cloudformation list-stacks --region "$REGION" --output text >/dev/null \
  || missing_access+=("cloudformation:ListStacks")

if [[ ${#missing_access[@]} -eq 0 ]]; then
  row "EKS/EC2/IAM/S3/APS/CFN access" "OK"
else
  row "EKS/EC2/IAM/S3/APS/CFN access" "WARN - missing: ${missing_access[*]}"
  add_action "Ask your AWS admin to grant the missing IAM actions in $REGION: ${missing_access[*]}"
fi

# ---------- 3. IAM role-creation rights (CAPABILITY_NAMED_IAM) ----------
# The stack creates named IAM roles, so the deploying principal must be allowed
# to create roles and attach policies. We can't fully simulate this without
# iam:SimulatePrincipalPolicy, but we can flag whether the caller is obviously
# an admin vs. a scoped role so the operator knows to expect a capability prompt.
if aws_run iam simulate-principal-policy \
     --policy-source-arn "$CALLER_ARN" \
     --action-names iam:CreateRole iam:AttachRolePolicy iam:PutRolePolicy \
     --query "EvaluationResults[?EvalDecision=='allowed'] | length(@)" \
     --output text; then
  allowed="$AWS_STDOUT"
  if [[ "$allowed" == "3" ]]; then
    row "IAM role-creation rights" "OK"
  else
    row "IAM role-creation rights" "WARN - some IAM create/attach actions denied"
    add_action "The stack creates named IAM roles (deploy needs CAPABILITY_NAMED_IAM). Ensure your principal can iam:CreateRole / iam:AttachRolePolicy / iam:PutRolePolicy, or have an admin deploy."
  fi
else
  # SimulatePrincipalPolicy itself is often denied for non-admins; don't block.
  row "IAM role-creation rights" "WARN - could not simulate (needs iam:SimulatePrincipalPolicy)"
  add_action "Could not verify IAM role-creation rights. The stack creates named IAM roles and must be deployed with --capabilities CAPABILITY_NAMED_IAM by a principal allowed to create roles."
fi

# ---------- 4. EC2 on-demand vCPU quota ----------
quota_label="EC2 on-demand vCPU quota in $REGION (need ${REQUIRED_VCPU}+)"
if aws_run service-quotas get-service-quota \
     --service-code ec2 \
     --quota-code L-1216C47A \
     --region "$REGION" \
     --query "Quota.Value" \
     --output text; then
  quota="$AWS_STDOUT"
  if [[ -z "$quota" || "$quota" == "None" ]]; then
    row "$quota_label" "WARN - empty response"
    add_action "Check the EC2 'Running On-Demand Standard vCPUs' quota in the AWS console: Service Quotas → EC2."
  else
    quota_int="${quota%.*}"
    if (( quota_int < REQUIRED_VCPU )); then
      row "$quota_label" "WARN ($quota available)"
      add_action "Request a quota increase: AWS console → Service Quotas → EC2 → 'Running On-Demand Standard vCPUs' in $REGION."
    else
      row "$quota_label" "OK ($quota available)"
    fi
  fi
else
  row "$quota_label" "WARN - could not read quota"
  add_action "Manually verify EC2 vCPU quota in the AWS console (Service Quotas → EC2) for $REGION."
fi

# ---------- 5. Local tools ----------
missing_tools=()
kubectl version --client=true >/dev/null 2>&1 || missing_tools+=("kubectl")
helm version   >/dev/null 2>&1 || missing_tools+=("helm")

if [[ ${#missing_tools[@]} -gt 0 ]]; then
  uniq_tools="$(printf '%s\n' "${missing_tools[@]}" | sort -u | tr '\n' ' ')"
  row "Local tools (kubectl, helm)" "FAIL - missing/broken: ${uniq_tools% }"
  add_action "Install/repair: ${uniq_tools% }"
  mark_blocker
else
  row "Local tools (kubectl, helm)" "OK"
fi

# ---------- summary ----------
printf "\n========================================\n"
if [[ $BLOCKERS -eq 0 && ${#ACTIONS[@]} -eq 0 ]]; then
  printf "RESULT: READY - you can deploy the CloudFormation stack.\n"
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
printf "(Set VERBOSE=1 to see raw AWS error messages.)\n"

[[ $BLOCKERS -gt 0 ]] && exit 1 || exit 0