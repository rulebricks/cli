# AWS Cluster Setup

A compact, turnkey EKS cluster for Rulebricks. One CloudFormation stack creates
the cluster **and** the S3 bucket + Amazon Managed Prometheus workspace the
platform needs, wired to workloads via **EKS Pod Identity** (AWS's recommended
mechanism for new clusters — no OIDC provider to manage).

`eksctl` is not used: it can create a cluster but not the bucket or AMP
workspace, so the full picture lives in one stack instead.

## Files

- `rulebricks-cluster.cfn.yaml` — VPC, EKS cluster + managed node group, EBS CSI + Pod Identity add-ons, one S3 data bucket, AMP workspace, and a single IAM role. (The CLI creates the namespace-scoped Pod Identity associations at deploy time.)
- `parameters.json` — sample parameter overrides (omit any to use template defaults).
- `check-aws-prereqs.sh` — verifies identity, service access, IAM role-creation rights, quota, kubectl/helm.

## One role, one bucket

A single IAM role, `<cluster>-rulebricks`, is bound to the ServiceAccounts that
need cloud access via `EKS::PodIdentityAssociation`. All data lives in one
bucket, `<cluster>-data-<account-id>`, under per-purpose prefixes.

| Path                              | Service account                      | Permission / target                                       |
| --------------------------------- | ------------------------------------ | --------------------------------------------------------- |
| Decision logs (Vector → S3)       | `vector`                             | `s3:*Object`/`ListBucket` → `<cluster>-data/decision-logs/` |
| DB backups (job → S3)             | `rulebricks-<deploymentName>-backup` | `s3:*Object`/`ListBucket` → `<cluster>-data/db-backups/`    |
| Metrics (Prometheus remote write) | `prometheus`                         | `aps:RemoteWrite` → AMP workspace                          |

The bucket is encrypted and has public access blocked.

> **This stack does not need a deployment name.** `EKS::PodIdentityAssociation` is
> `namespace`-scoped, so the **Rulebricks CLI creates the associations** (vector / backup /
> prometheus → this role) at `rulebricks deploy` time. The stack only provisions the
> deployment-independent role, bucket, and AMP workspace, so one cluster can host many deployments.

## Core cluster parameters

`ClusterName` (`rulebricks-cluster`), `KubernetesVersion` (`1.34`),
`NodeInstanceType` (`c7i.xlarge`), `NodeDesiredCapacity`/`NodeMinSize`/`NodeMaxSize`
(`2`/`2`/`4`), `NodeVolumeSizeGiB` (`50`). Two 4-vCPU nodes give an 8-vCPU
baseline that scales to four. Worker pods use soft anti-affinity, so no labels
or taints are required.

> `NodeInstanceType` and the node AMI are coupled: `c7i` is x86, so the template
> uses `AL2023_x86_64_STANDARD`. If you switch to a Graviton/ARM type (e.g.
> `c8g`), change `AmiType` to `AL2023_ARM_64_STANDARD` or the nodes won't boot.

## Region

CloudFormation is regional — the stack deploys to whatever region your CLI call
targets. Set it with `--region` (or `AWS_REGION` / your profile), not a
parameter. Availability zones auto-resolve to that region.

## Check access

```bash
AWS_REGION=us-east-1 bash check-aws-prereqs.sh
```

The stack creates named IAM roles, so the deploying principal must be able to
create roles, and the deploy must pass `--capabilities CAPABILITY_NAMED_IAM`
(below). The check script flags this.

## Create the cluster

```bash
aws cloudformation create-stack \
  --stack-name rulebricks-cluster \
  --region us-east-1 \
  --template-body file://rulebricks-cluster.cfn.yaml \
  --parameters file://parameters.json \
  --capabilities CAPABILITY_NAMED_IAM

aws cloudformation wait stack-create-complete \
  --stack-name rulebricks-cluster --region us-east-1

aws eks update-kubeconfig --name rulebricks-cluster --region us-east-1
```

`CAPABILITY_NAMED_IAM` is a single inline flag on the deploy call (no
prerequisite step) and is required because the role has an explicit name. Run
`rulebricks init` once kubeconfig works, then select this cluster. Stack outputs
give `DataBucketName`, `RulebricksRoleArn`, and the AMP `remote_write` URL for
the CLI.

## Delete the cluster

Run `rulebricks destroy <deployment-name>` first so Kubernetes removes
LoadBalancer services and PVC-backed EBS volumes. CloudFormation **cannot delete
non-empty S3 buckets**, so empty them before deleting the stack:

```bash
ACCOUNT_ID="$(aws sts get-caller-identity --query Account --output text)"
aws s3 rm "s3://rulebricks-cluster-data-${ACCOUNT_ID}" --recursive

aws cloudformation delete-stack --stack-name rulebricks-cluster --region us-east-1
aws cloudformation wait stack-delete-complete \
  --stack-name rulebricks-cluster --region us-east-1
```

The stack is the teardown boundary (analogous to the Azure resource group):
deleting it removes the cluster, node group, VPC, the IAM role, Pod Identity
associations, AMP workspace, and the (emptied) bucket.

## Notes

- Rulebricks uses a Kubernetes LoadBalancer service; EKS provisions the load balancer and its `80`/`443` security-group rules. In a locked-down VPC, ensure public inbound `80`/`443` can reach it for DNS and cert-manager HTTP-01 validation.
- Pod Identity requires the `eks-pod-identity-agent` add-on, which the stack installs.
- To bring your own buckets or AMP workspace, replace the corresponding resources with parameters and references (not enabled by default to keep the stack compact).
