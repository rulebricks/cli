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
`NodeInstanceType` (`m7i.xlarge`), `NodeDesiredCapacity`/`NodeMinSize`/`NodeMaxSize`
(`3`/`3`/`6`), `NodeVolumeSizeGiB` (`50`). The standard (core) nodegroup runs
the always-on services on three to six 4-vCPU / 16-GiB nodes. The chart's
steady-state request floor is ~10 vCPU / ~23 GiB (plus per-node DaemonSets and
headroom for request-less pods), which is why the floor is 3 nodes and the
node family is general-purpose `m7i` (4 GiB/vCPU) rather than compute-optimized
`c7i` (2 GiB/vCPU) — memory runs out first on c-family nodes. The 6-node
ceiling leaves room for HPS scaling 3 -> 8 (+5 vCPU of requests), which stays
on the core pool; burst capacity for the worker fleet lives in the dedicated
burst nodegroup below.

### Burst worker nodegroup (default on)

`EnableBurstPool` (`"true"`), `BurstInstanceType` (`m7i.4xlarge`, 16 vCPU /
64 GiB), `BurstNodeMaxSize` (`1`). One large on-demand node that scales 0 -> 1
on demand, labeled and tainted `rulebricks.com/pool=burst`: the Rulebricks chart
makes workers tolerate the taint and softly prefer the label out of the box,
so the scaled-out worker fleet lands here while core services stay on the
standard nodegroup. Sizing math: 3 x 4 vCPU core floor + 16 vCPU burst =
28 vCPU running steady-state at full burst, and 40 vCPU with the core
nodegroup at its 6-node max — check your regional on-demand vCPU quota covers
this before enabling. Memory matters as much as cores here: workers request
1 GiB each, so the default 64-worker KEDA ceiling needs ~64 GiB — the reason
for `m7i.4xlarge` over `c7i.4xlarge` (32 GiB, caps out near 28 workers).
Note: EKS has no parked-VM equivalent of AKS
Deallocate, so each burst cold-provisions the node (~2-3 min); the warm
worker floor on the core nodes carries traffic during provisioning, and a
Karpenter NodePool carrying the same label/taint is the planned fast path.

> `NodeInstanceType` and the node AMI are coupled: `m7i` is x86, so the template
> uses `AL2023_x86_64_STANDARD`. If you switch to a Graviton/ARM type (e.g.
> `m8g`), change `AmiType` to `AL2023_ARM_64_STANDARD` or the nodes won't boot.

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

## Bring your own cluster

If the EKS cluster was **not** created by this stack (Terraform, eksctl, an
older cluster-setup, ...), the Rulebricks CLI still works, but two things the
stack normally provides must exist before `rulebricks deploy`:

1. **The Pod Identity agent add-on.** Without it, Pod Identity associations
   are created successfully but pods never receive credentials:

```bash
aws eks create-addon --cluster-name <cluster> \
  --addon-name eks-pod-identity-agent --region <region>
```

2. **A workload IAM role trusted by EKS Pod Identity.** Do not reuse the
   cluster or node roles — Pod Identity rejects their trust policies
   (`InvalidParameterException: Trust policy of the role provided is
   invalid`), and legacy IRSA roles (OIDC `Federated` trust) fail the same
   way. Create a dedicated role named `<cluster>-rulebricks` — the CLI wizard
   preselects it by that name:

```bash
aws iam create-role --role-name <cluster>-rulebricks \
  --assume-role-policy-document '{
    "Version": "2012-10-17",
    "Statement": [{
      "Effect": "Allow",
      "Principal": { "Service": "pods.eks.amazonaws.com" },
      "Action": ["sts:AssumeRole", "sts:TagSession"]
    }]
  }'

aws iam put-role-policy --role-name <cluster>-rulebricks \
  --policy-name rulebricks-s3-data \
  --policy-document '{
    "Version": "2012-10-17",
    "Statement": [{
      "Effect": "Allow",
      "Action": ["s3:PutObject", "s3:GetObject", "s3:DeleteObject", "s3:ListBucket"],
      "Resource": ["arn:aws:s3:::<bucket>", "arn:aws:s3:::<bucket>/*"]
    }]
  }'
```

Add `aps:RemoteWrite` on your AMP workspace (metrics remote write) and the
`kafka-cluster:*` statements from `rulebricks-cluster.cfn.yaml` (MSK IAM auth)
if you use those paths.

The CLI validates both prerequisites at deploy time and stops with guidance
when either is missing. A BYO cluster also needs the `aws-ebs-csi-driver` and
`metrics-server` add-ons (PVCs and CPU-based autoscaling), which this stack
otherwise installs.

## Notes

- Rulebricks uses a Kubernetes LoadBalancer service; EKS provisions the load balancer and its `80`/`443` security-group rules. In a locked-down VPC, ensure public inbound `80`/`443` can reach it for DNS and cert-manager HTTP-01 validation.
- Pod Identity requires the `eks-pod-identity-agent` add-on, which the stack installs.
- To bring your own buckets or AMP workspace, replace the corresponding resources with parameters and references (not enabled by default to keep the stack compact).
