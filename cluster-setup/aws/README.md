# AWS Cluster Setup

Use these files to create a minimum EKS cluster that can run Rulebricks without using the Rulebricks CLI Terraform flow.

## Files

- `cluster.yaml` is the minimum compatible `eksctl` cluster config, using ARM64 managed nodes and EBS CSI support.
- `check-aws-access.sh` verifies AWS identity, common EKS/EC2/IAM permissions, quota, `eksctl`, `kubectl`, and Helm.

## Core Cluster Parameters

- Cluster name: `rulebricks-cluster` (`cluster.yaml` -> `metadata.name`)
- Region: `us-east-1` (`cluster.yaml` -> `metadata.region`)
- Kubernetes version: `1.34` (`cluster.yaml` -> `metadata.version`)
- Node count: `4` (`cluster.yaml` -> `managedNodeGroups[0].desiredCapacity`)
- Instance type: `c8g.large` (`cluster.yaml` -> `managedNodeGroups[0].instanceType`)
- Disk size (GB): `50` (`cluster.yaml` -> `managedNodeGroups[0].volumeSize`)
- Disk type: `gp3` (`cluster.yaml` -> `managedNodeGroups[0].volumeType`)

## Check Access

```bash
AWS_REGION=us-east-1 bash check-aws-access.sh
```

## Create The Cluster

```bash
eksctl create cluster -f cluster.yaml
```

`eksctl` updates kubeconfig automatically. To refresh it manually:

```bash
aws eks update-kubeconfig --name rulebricks-cluster --region us-east-1
```

Use `rulebricks init` with **Use existing Kubernetes cluster** after kubeconfig works.

## Optional Identity Setup

If you use S3 decision-log export or AWS Managed Prometheus remote write, create IAM roles for the Kubernetes service accounts rendered by the CLI:

```bash
NAMESPACE=rulebricks-demo
CLUSTER=rulebricks-cluster
REGION=us-east-1
ACCOUNT_ID="$(aws sts get-caller-identity --query Account --output text)"

eksctl utils associate-iam-oidc-provider \
  --cluster "$CLUSTER" \
  --region "$REGION" \
  --approve

eksctl create iamserviceaccount \
  --cluster "$CLUSTER" \
  --region "$REGION" \
  --namespace "$NAMESPACE" \
  --name vector \
  --attach-policy-arn arn:aws:iam::"$ACCOUNT_ID":policy/<vector-s3-policy> \
  --role-name rulebricks-vector \
  --approve

eksctl create iamserviceaccount \
  --cluster "$CLUSTER" \
  --region "$REGION" \
  --namespace "$NAMESPACE" \
  --name prometheus \
  --attach-policy-arn arn:aws:iam::aws:policy/AmazonPrometheusRemoteWriteAccess \
  --role-name rulebricks-prometheus \
  --approve
```

Enter the created role ARNs when prompted by the CLI.
