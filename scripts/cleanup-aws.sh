#!/bin/bash
# AWS EKS Cluster Cleanup Script
# Deletes EKS cluster and all associated resources created by Terraform
# Use when Terraform state is lost and resources need manual cleanup

set -e

# Configuration - modify these if needed
CLUSTER_NAME="${CLUSTER_NAME:-rulebricks-cluster}"
REGION="${REGION:-us-east-1}"
VPC_NAME="${CLUSTER_NAME}-vpc"

echo "=============================================="
echo "AWS EKS Cleanup Script"
echo "=============================================="
echo "Cluster: $CLUSTER_NAME"
echo "Region:  $REGION"
echo "VPC:     $VPC_NAME"
echo "=============================================="
echo ""

# Helper function to handle errors gracefully
safe_run() {
    "$@" 2>/dev/null || true
}

# Check if AWS CLI is configured
echo "Checking AWS credentials..."
if ! aws sts get-caller-identity --region "$REGION" > /dev/null 2>&1; then
    echo "ERROR: AWS CLI is not configured or credentials are invalid"
    exit 1
fi
echo "AWS credentials OK"
echo ""

# ============================================
# Step 0: Delete CloudWatch Log Groups
# ============================================
echo "Step 0: Deleting CloudWatch Log Groups..."

LOG_GROUPS=$(aws logs describe-log-groups --region "$REGION" --log-group-name-prefix "/aws/eks/${CLUSTER_NAME}" --query 'logGroups[*].logGroupName' --output text 2>/dev/null || echo "")
for LG in $LOG_GROUPS; do
    echo "  Deleting log group: $LG"
    aws logs delete-log-group --log-group-name "$LG" --region "$REGION" 2>/dev/null || true
done
echo "  CloudWatch Log Groups deleted"
echo ""

# ============================================
# Step 0.5: Delete KMS Aliases and Keys
# ============================================
echo "Step 0.5: Deleting KMS aliases and scheduling key deletion..."

KMS_ALIASES=$(aws kms list-aliases --region "$REGION" --query "Aliases[?contains(AliasName, '${CLUSTER_NAME}')].AliasName" --output text 2>/dev/null || echo "")
for ALIAS in $KMS_ALIASES; do
    if [ -n "$ALIAS" ]; then
        echo "  Found KMS alias: $ALIAS"
        KEY_ID=$(aws kms list-aliases --region "$REGION" --query "Aliases[?AliasName=='$ALIAS'].TargetKeyId" --output text 2>/dev/null || echo "")
        
        echo "  Deleting alias: $ALIAS"
        aws kms delete-alias --alias-name "$ALIAS" --region "$REGION" 2>/dev/null || true
        
        if [ -n "$KEY_ID" ]; then
            echo "  Scheduling key for deletion: $KEY_ID"
            aws kms schedule-key-deletion --key-id "$KEY_ID" --pending-window-in-days 7 --region "$REGION" 2>/dev/null || true
        fi
    fi
done

echo "  KMS resources cleaned up"
echo ""

# ============================================
# Step 1: Delete EKS Node Groups
# ============================================
echo "Step 1: Deleting EKS node groups..."

NODE_GROUPS=$(aws eks list-nodegroups --cluster-name "$CLUSTER_NAME" --region "$REGION" --query 'nodegroups[*]' --output text 2>/dev/null || echo "")

if [ -n "$NODE_GROUPS" ]; then
    for NG in $NODE_GROUPS; do
        echo "  Deleting node group: $NG"
        aws eks delete-nodegroup \
            --cluster-name "$CLUSTER_NAME" \
            --nodegroup-name "$NG" \
            --region "$REGION" 2>/dev/null || echo "  (already deleted or doesn't exist)"
    done
    
    echo "  Waiting for node groups to be deleted (this may take 5-10 minutes)..."
    for NG in $NODE_GROUPS; do
        aws eks wait nodegroup-deleted \
            --cluster-name "$CLUSTER_NAME" \
            --nodegroup-name "$NG" \
            --region "$REGION" 2>/dev/null || true
    done
    echo "  Node groups deleted"
else
    echo "  No node groups found"
fi
echo ""

# ============================================
# Step 2: Delete EKS Cluster
# ============================================
echo "Step 2: Deleting EKS cluster..."

if aws eks describe-cluster --name "$CLUSTER_NAME" --region "$REGION" > /dev/null 2>&1; then
    echo "  Deleting cluster: $CLUSTER_NAME"
    aws eks delete-cluster --name "$CLUSTER_NAME" --region "$REGION"
    
    echo "  Waiting for cluster to be deleted (this may take 5-10 minutes)..."
    aws eks wait cluster-deleted --name "$CLUSTER_NAME" --region "$REGION" 2>/dev/null || true
    echo "  Cluster deleted"
else
    echo "  Cluster not found or already deleted"
fi
echo ""

# ============================================
# Step 3: Delete IAM Roles and Policies
# ============================================
echo "Step 3: Deleting IAM roles..."

# Function to delete an IAM role and its attached policies
delete_iam_role() {
    local ROLE_NAME=$1
    
    if aws iam get-role --role-name "$ROLE_NAME" > /dev/null 2>&1; then
        echo "  Deleting role: $ROLE_NAME"
        
        # Detach managed policies
        POLICIES=$(aws iam list-attached-role-policies --role-name "$ROLE_NAME" --query 'AttachedPolicies[*].PolicyArn' --output text 2>/dev/null || echo "")
        for POLICY in $POLICIES; do
            aws iam detach-role-policy --role-name "$ROLE_NAME" --policy-arn "$POLICY" 2>/dev/null || true
        done
        
        # Delete inline policies
        INLINE_POLICIES=$(aws iam list-role-policies --role-name "$ROLE_NAME" --query 'PolicyNames[*]' --output text 2>/dev/null || echo "")
        for POLICY in $INLINE_POLICIES; do
            aws iam delete-role-policy --role-name "$ROLE_NAME" --policy-name "$POLICY" 2>/dev/null || true
        done
        
        # Delete instance profiles
        INSTANCE_PROFILES=$(aws iam list-instance-profiles-for-role --role-name "$ROLE_NAME" --query 'InstanceProfiles[*].InstanceProfileName' --output text 2>/dev/null || echo "")
        for PROFILE in $INSTANCE_PROFILES; do
            aws iam remove-role-from-instance-profile --instance-profile-name "$PROFILE" --role-name "$ROLE_NAME" 2>/dev/null || true
            aws iam delete-instance-profile --instance-profile-name "$PROFILE" 2>/dev/null || true
        done
        
        # Delete the role
        aws iam delete-role --role-name "$ROLE_NAME" 2>/dev/null || true
    fi
}

# Find and delete roles matching our cluster name pattern
ROLES=$(aws iam list-roles --query "Roles[?contains(RoleName, '${CLUSTER_NAME}')].RoleName" --output text 2>/dev/null || echo "")
for ROLE in $ROLES; do
    delete_iam_role "$ROLE"
done

# Also try specific known role names
delete_iam_role "${CLUSTER_NAME}-ebs-csi"
delete_iam_role "${CLUSTER_NAME}-external-dns"
delete_iam_role "${CLUSTER_NAME}-vector"

echo "  IAM roles deleted"
echo ""

# ============================================
# Step 4: Delete IAM Policies
# ============================================
echo "Step 4: Deleting IAM policies..."

POLICIES=$(aws iam list-policies --scope Local --query "Policies[?contains(PolicyName, '${CLUSTER_NAME}')].Arn" --output text 2>/dev/null || echo "")
for POLICY_ARN in $POLICIES; do
    echo "  Deleting policy: $POLICY_ARN"
    
    # Detach from all roles first
    ATTACHED_ROLES=$(aws iam list-entities-for-policy --policy-arn "$POLICY_ARN" --query 'PolicyRoles[*].RoleName' --output text 2>/dev/null || echo "")
    for ROLE in $ATTACHED_ROLES; do
        aws iam detach-role-policy --role-name "$ROLE" --policy-arn "$POLICY_ARN" 2>/dev/null || true
    done
    
    # Delete all versions except default
    VERSIONS=$(aws iam list-policy-versions --policy-arn "$POLICY_ARN" --query 'Versions[?IsDefaultVersion==`false`].VersionId' --output text 2>/dev/null || echo "")
    for VERSION in $VERSIONS; do
        aws iam delete-policy-version --policy-arn "$POLICY_ARN" --version-id "$VERSION" 2>/dev/null || true
    done
    
    aws iam delete-policy --policy-arn "$POLICY_ARN" 2>/dev/null || true
done

echo "  IAM policies deleted"
echo ""

# ============================================
# Step 5: Delete OIDC Provider
# ============================================
echo "Step 5: Deleting OIDC provider..."

OIDC_PROVIDERS=$(aws iam list-open-id-connect-providers --query 'OpenIDConnectProviderList[*].Arn' --output text 2>/dev/null || echo "")
for OIDC_ARN in $OIDC_PROVIDERS; do
    if echo "$OIDC_ARN" | grep -q "$REGION"; then
        # Check if it's related to our cluster by checking the URL
        OIDC_URL=$(aws iam get-open-id-connect-provider --open-id-connect-provider-arn "$OIDC_ARN" --query 'Url' --output text 2>/dev/null || echo "")
        if echo "$OIDC_URL" | grep -q "$CLUSTER_NAME"; then
            echo "  Deleting OIDC provider: $OIDC_ARN"
            aws iam delete-open-id-connect-provider --open-id-connect-provider-arn "$OIDC_ARN" 2>/dev/null || true
        fi
    fi
done

echo "  OIDC provider deleted"
echo ""

# ============================================
# Step 6: Find and Delete VPC Resources
# ============================================
echo "Step 6: Finding VPC..."

VPC_ID=$(aws ec2 describe-vpcs \
    --region "$REGION" \
    --filters "Name=tag:Name,Values=$VPC_NAME" \
    --query 'Vpcs[0].VpcId' \
    --output text 2>/dev/null || echo "None")

if [ "$VPC_ID" = "None" ] || [ -z "$VPC_ID" ]; then
    echo "  VPC not found, skipping VPC cleanup"
else
    echo "  Found VPC: $VPC_ID"
    echo ""
    
    # ============================================
    # Step 7: Delete Load Balancers
    # ============================================
    echo "Step 7: Deleting load balancers in VPC..."
    
    # Delete ELBv2 (ALB/NLB)
    LOAD_BALANCERS=$(aws elbv2 describe-load-balancers --region "$REGION" --query "LoadBalancers[?VpcId=='$VPC_ID'].LoadBalancerArn" --output text 2>/dev/null || echo "")
    for LB_ARN in $LOAD_BALANCERS; do
        echo "  Deleting load balancer: $LB_ARN"
        aws elbv2 delete-load-balancer --load-balancer-arn "$LB_ARN" --region "$REGION" 2>/dev/null || true
    done
    
    # Delete classic ELBs
    CLASSIC_LBS=$(aws elb describe-load-balancers --region "$REGION" --query "LoadBalancerDescriptions[?VPCId=='$VPC_ID'].LoadBalancerName" --output text 2>/dev/null || echo "")
    for LB_NAME in $CLASSIC_LBS; do
        echo "  Deleting classic load balancer: $LB_NAME"
        aws elb delete-load-balancer --load-balancer-name "$LB_NAME" --region "$REGION" 2>/dev/null || true
    done
    
    # Wait for LBs to be deleted
    sleep 10
    echo "  Load balancers deleted"
    echo ""
    
    # ============================================
    # Step 8: Delete NAT Gateways
    # ============================================
    echo "Step 8: Deleting NAT gateways..."
    
    NAT_GATEWAYS=$(aws ec2 describe-nat-gateways \
        --region "$REGION" \
        --filter "Name=vpc-id,Values=$VPC_ID" "Name=state,Values=available,pending" \
        --query 'NatGateways[*].NatGatewayId' \
        --output text 2>/dev/null || echo "")
    
    for NAT_ID in $NAT_GATEWAYS; do
        echo "  Deleting NAT gateway: $NAT_ID"
        aws ec2 delete-nat-gateway --nat-gateway-id "$NAT_ID" --region "$REGION" 2>/dev/null || true
    done
    
    if [ -n "$NAT_GATEWAYS" ]; then
        echo "  Waiting for NAT gateways to be deleted..."
        sleep 60  # NAT gateways take a while to delete
    fi
    echo "  NAT gateways deleted"
    echo ""
    
    # ============================================
    # Step 9: Delete Elastic IPs
    # ============================================
    echo "Step 9: Releasing Elastic IPs..."
    
    # Find EIPs tagged with our cluster name or associated with our VPC's NAT gateways
    EIPS=$(aws ec2 describe-addresses \
        --region "$REGION" \
        --filters "Name=tag:kubernetes.io/cluster/${CLUSTER_NAME},Values=owned" \
        --query 'Addresses[*].AllocationId' \
        --output text 2>/dev/null || echo "")
    
    # Also find any unassociated EIPs that might be ours
    UNASSOCIATED_EIPS=$(aws ec2 describe-addresses \
        --region "$REGION" \
        --query 'Addresses[?AssociationId==`null`].AllocationId' \
        --output text 2>/dev/null || echo "")
    
    for EIP_ID in $EIPS; do
        echo "  Releasing EIP: $EIP_ID"
        aws ec2 release-address --allocation-id "$EIP_ID" --region "$REGION" 2>/dev/null || true
    done
    
    echo "  Elastic IPs released"
    echo ""
    
    # ============================================
    # Step 10: Delete Network Interfaces
    # ============================================
    echo "Step 10: Deleting network interfaces..."
    
    ENIS=$(aws ec2 describe-network-interfaces \
        --region "$REGION" \
        --filters "Name=vpc-id,Values=$VPC_ID" \
        --query 'NetworkInterfaces[*].NetworkInterfaceId' \
        --output text 2>/dev/null || echo "")
    
    for ENI_ID in $ENIS; do
        # First detach if attached
        ATTACHMENT=$(aws ec2 describe-network-interfaces \
            --network-interface-ids "$ENI_ID" \
            --region "$REGION" \
            --query 'NetworkInterfaces[0].Attachment.AttachmentId' \
            --output text 2>/dev/null || echo "None")
        
        if [ "$ATTACHMENT" != "None" ] && [ -n "$ATTACHMENT" ]; then
            echo "  Detaching ENI: $ENI_ID"
            aws ec2 detach-network-interface --attachment-id "$ATTACHMENT" --force --region "$REGION" 2>/dev/null || true
            sleep 2
        fi
        
        echo "  Deleting ENI: $ENI_ID"
        aws ec2 delete-network-interface --network-interface-id "$ENI_ID" --region "$REGION" 2>/dev/null || true
    done
    
    echo "  Network interfaces deleted"
    echo ""
    
    # ============================================
    # Step 11: Delete Security Groups
    # ============================================
    echo "Step 11: Deleting security groups..."
    
    # Get all security groups except default
    SECURITY_GROUPS=$(aws ec2 describe-security-groups \
        --region "$REGION" \
        --filters "Name=vpc-id,Values=$VPC_ID" \
        --query 'SecurityGroups[?GroupName!=`default`].GroupId' \
        --output text 2>/dev/null || echo "")
    
    # First, remove all ingress/egress rules that reference other SGs (to break circular dependencies)
    for SG_ID in $SECURITY_GROUPS; do
        echo "  Removing rules from: $SG_ID"
        
        # Get and revoke ingress rules
        aws ec2 describe-security-groups --group-ids "$SG_ID" --region "$REGION" \
            --query 'SecurityGroups[0].IpPermissions' --output json 2>/dev/null | \
            aws ec2 revoke-security-group-ingress --group-id "$SG_ID" --region "$REGION" \
            --ip-permissions file:///dev/stdin 2>/dev/null || true
        
        # Get and revoke egress rules
        aws ec2 describe-security-groups --group-ids "$SG_ID" --region "$REGION" \
            --query 'SecurityGroups[0].IpPermissionsEgress' --output json 2>/dev/null | \
            aws ec2 revoke-security-group-egress --group-id "$SG_ID" --region "$REGION" \
            --ip-permissions file:///dev/stdin 2>/dev/null || true
    done
    
    # Now delete the security groups
    for SG_ID in $SECURITY_GROUPS; do
        echo "  Deleting security group: $SG_ID"
        aws ec2 delete-security-group --group-id "$SG_ID" --region "$REGION" 2>/dev/null || true
    done
    
    echo "  Security groups deleted"
    echo ""
    
    # ============================================
    # Step 12: Delete Subnets
    # ============================================
    echo "Step 12: Deleting subnets..."
    
    SUBNETS=$(aws ec2 describe-subnets \
        --region "$REGION" \
        --filters "Name=vpc-id,Values=$VPC_ID" \
        --query 'Subnets[*].SubnetId' \
        --output text 2>/dev/null || echo "")
    
    for SUBNET_ID in $SUBNETS; do
        echo "  Deleting subnet: $SUBNET_ID"
        aws ec2 delete-subnet --subnet-id "$SUBNET_ID" --region "$REGION" 2>/dev/null || true
    done
    
    echo "  Subnets deleted"
    echo ""
    
    # ============================================
    # Step 13: Delete Internet Gateway
    # ============================================
    echo "Step 13: Deleting internet gateway..."
    
    IGW_ID=$(aws ec2 describe-internet-gateways \
        --region "$REGION" \
        --filters "Name=attachment.vpc-id,Values=$VPC_ID" \
        --query 'InternetGateways[0].InternetGatewayId' \
        --output text 2>/dev/null || echo "None")
    
    if [ "$IGW_ID" != "None" ] && [ -n "$IGW_ID" ]; then
        echo "  Detaching internet gateway: $IGW_ID"
        aws ec2 detach-internet-gateway --internet-gateway-id "$IGW_ID" --vpc-id "$VPC_ID" --region "$REGION" 2>/dev/null || true
        
        echo "  Deleting internet gateway: $IGW_ID"
        aws ec2 delete-internet-gateway --internet-gateway-id "$IGW_ID" --region "$REGION" 2>/dev/null || true
    fi
    
    echo "  Internet gateway deleted"
    echo ""
    
    # ============================================
    # Step 14: Delete Route Tables
    # ============================================
    echo "Step 14: Deleting route tables..."
    
    # Get all route tables except main
    ROUTE_TABLES=$(aws ec2 describe-route-tables \
        --region "$REGION" \
        --filters "Name=vpc-id,Values=$VPC_ID" \
        --query 'RouteTables[?Associations[?Main!=`true`]].RouteTableId' \
        --output text 2>/dev/null || echo "")
    
    for RT_ID in $ROUTE_TABLES; do
        # Disassociate from subnets first
        ASSOCIATIONS=$(aws ec2 describe-route-tables \
            --route-table-ids "$RT_ID" \
            --region "$REGION" \
            --query 'RouteTables[0].Associations[?!Main].RouteTableAssociationId' \
            --output text 2>/dev/null || echo "")
        
        for ASSOC_ID in $ASSOCIATIONS; do
            aws ec2 disassociate-route-table --association-id "$ASSOC_ID" --region "$REGION" 2>/dev/null || true
        done
        
        echo "  Deleting route table: $RT_ID"
        aws ec2 delete-route-table --route-table-id "$RT_ID" --region "$REGION" 2>/dev/null || true
    done
    
    echo "  Route tables deleted"
    echo ""
    
    # ============================================
    # Step 15: Delete VPC
    # ============================================
    echo "Step 15: Deleting VPC..."
    
    echo "  Deleting VPC: $VPC_ID"
    aws ec2 delete-vpc --vpc-id "$VPC_ID" --region "$REGION" 2>/dev/null || true
    
    echo "  VPC deleted"
fi

echo ""
echo "=============================================="
echo "Cleanup complete!"
echo "=============================================="
echo ""
echo "Verify by checking:"
echo "  aws eks list-clusters --region $REGION"
echo "  aws ec2 describe-vpcs --region $REGION --filters \"Name=tag:Name,Values=$VPC_NAME\""
echo ""
