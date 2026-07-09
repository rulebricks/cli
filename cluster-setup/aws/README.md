# AWS Cluster Setup (EKS)

One CloudFormation stack: `rulebricks-cluster.cfn.yaml`. Managed Kafka, Redis,
Postgres, and Prometheus are independent toggles that **default to off** — the
Rulebricks chart runs those services in-cluster until you enable them.

> This IaC is a reference implementation. Treat it as a starting point and
> customize it to accommodate pre-existing services (VPCs, buckets, databases)
> or unique performance requirements.

## 1. Parameters

Cluster:

| Parameter | Default | Purpose |
| --- | --- | --- |
| `ClusterName` | `rulebricks-cluster` | Prefixes every resource name; the CLI preselects `<cluster>-rulebricks` / `<cluster>-data` by convention |
| `KubernetesVersion` | `1.34` | EKS version |
| `ClusterEndpointAccess` | `PublicAndPrivate` | `PrivateOnly` restricts the API to the VPC (needs VPN/bastion) |
| `AdminPrincipalArn` | `""` | Optional second cluster-admin IAM principal (stack creator gets admin automatically) |
| `KmsKeyArn` | `""` | BYO KMS key for secrets encryption; empty creates a dedicated key |

Networking:

| Parameter | Default | Purpose |
| --- | --- | --- |
| `VpcCidr` | `10.0.0.0/16` | Must be /18+; carved into six /19 subnets (3 private, 3 public) |
| `SingleNatGateway` | `"true"` | `"false"` = one NAT per AZ (HA, 3x cost) |
| `EnableVpcInterfaceEndpoints` | `"false"` | ECR/EC2/STS/EKS/ELB/Logs interface endpoints for restricted-egress environments |

Node groups:

| Parameter | Default | Purpose |
| --- | --- | --- |
| `NodeInstanceType` | `m7i.xlarge` | Core nodes (4 vCPU / 16 GiB) |
| `NodeDesiredCapacity` / `NodeMinSize` / `NodeMaxSize` | `3` / `3` / `6` | Core pool sizing |
| `NodeVolumeSizeGiB` | `50` | Node disk |
| `EnableBurstPool` | `"true"` | Dedicated worker pool, taint `rulebricks.com/pool=burst`, scales 0-N |
| `BurstInstanceType` | `m7i.4xlarge` | 16 vCPU / 64 GiB per burst node |
| `BurstNodeMaxSize` | `1` | Burst pool ceiling |

Managed services (all off by default; the sizing parameters below each toggle
are ignored unless that toggle is `"true"`, so they cannot create a bad state):

| Parameter | Default | Purpose |
| --- | --- | --- |
| `EnableManagedKafka` | `"false"` | Amazon MSK (IAM auth, TLS) instead of in-cluster Kafka |
| `KafkaVersion` / `KafkaInstanceType` / `KafkaBrokerNodes` / `KafkaVolumeSizeGiB` | `3.9.x` / `kafka.m7g.large` / `3` / `100` | MSK sizing (brokers must be a multiple of 3) |
| `EnableManagedRedis` | `"false"` | ElastiCache for Valkey (TLS + AUTH) instead of in-cluster Valkey |
| `RedisNodeType` / `RedisEngineVersion` / `RedisMultiAz` | `cache.m7g.large` / `8.2` / `"true"` | ElastiCache sizing / HA |
| `EnableManagedDatabase` | `"false"` | RDS for PostgreSQL 17 instead of in-cluster Postgres |
| `DbInstanceClass` / `DbEngineVersion` / `DbMasterUsername` | `db.m7g.large` / `17` / `postgres` | RDS instance |
| `DbAllocatedStorageGiB` / `DbMaxAllocatedStorageGiB` | `100` / `500` | Storage + autoscaling ceiling |
| `DbMultiAz` / `DbBackupRetentionDays` / `DbDeletionProtection` | `"true"` / `7` / `"true"` | HA / backups / delete guard |
| `EnableManagedPrometheus` | `"false"` | Amazon Managed Prometheus workspace for remote write |

## 2. Deployed resources

Always created:

| Resource | Type | Name / notes |
| --- | --- | --- |
| VPC | `AWS::EC2::VPC` | `<cluster>-vpc`; 3 private subnets (nodes + data), 3 public subnets (load balancers, NAT) |
| Internet gateway, route tables | `AWS::EC2::InternetGateway`, `AWS::EC2::RouteTable` x4 | Public route via IGW; per-AZ private route tables via NAT |
| NAT gateway + EIP | `AWS::EC2::NatGateway`, `AWS::EC2::EIP` | 1 (or 3 when `SingleNatGateway=false`) |
| S3 gateway endpoint | `AWS::EC2::VPCEndpoint` | Keeps S3 traffic off NAT (free) |
| KMS key + alias | `AWS::KMS::Key`, `AWS::KMS::Alias` | `alias/<cluster>-eks-secrets`; only when `KmsKeyArn` is empty |
| EKS cluster | `AWS::EKS::Cluster` | `<cluster>`; private nodes, KMS secrets encryption, api/audit/authenticator logs |
| Cluster IAM role | `AWS::IAM::Role` | Control-plane role (trusts `eks.amazonaws.com`) + KMS grant policy |
| Node IAM role | `AWS::IAM::Role` | Kubelet/CNI/ECR only (no CSI policy) |
| EBS CSI IAM role | `AWS::IAM::Role` | `<cluster>-ebs-csi`; Pod Identity-trusted, scoped to the CSI driver |
| Cluster-autoscaler IAM role | `AWS::IAM::Role` | `<cluster>-cluster-autoscaler`; Pod Identity-trusted; ASG writes conditioned on this cluster's autoscaler discovery tags. The chart deploys the autoscaler itself on AWS |
| Rulebricks IAM role | `AWS::IAM::Role` | `<cluster>-rulebricks`; trusts `pods.eks.amazonaws.com`; S3 data policy + conditional AMP/MSK policies |
| Add-ons | `AWS::EKS::Addon` x3 | `eks-pod-identity-agent`, `aws-ebs-csi-driver`, `metrics-server` |
| Core nodegroup | `AWS::EKS::Nodegroup` | `standard-nodes` |
| Data bucket | `AWS::S3::Bucket` + `AWS::S3::BucketPolicy` | `<cluster>-data-<account>`; encrypted, public access blocked, TLS-only policy |

Conditionally created:

| Resource | Type | Condition |
| --- | --- | --- |
| Burst nodegroup | `AWS::EKS::Nodegroup` (`burst-workers`) | `EnableBurstPool` |
| Admin access entry | `AWS::EKS::AccessEntry` | `AdminPrincipalArn` set |
| Interface endpoints + SG | `AWS::EC2::VPCEndpoint` x7, `AWS::EC2::SecurityGroup` | `EnableVpcInterfaceEndpoints` |
| AMP workspace | `AWS::APS::Workspace` (`<cluster>-amp`) | `EnableManagedPrometheus` |
| MSK cluster + SG | `AWS::MSK::Cluster` (`<cluster>-kafka`), `AWS::EC2::SecurityGroup` (9098 from nodes only) | `EnableManagedKafka` |
| ElastiCache Valkey + SG + subnet group + AUTH secret | `AWS::ElastiCache::ReplicationGroup` (`<cluster>-redis`), `AWS::SecretsManager::Secret` (`<cluster>/redis-auth`) | `EnableManagedRedis` |
| RDS PostgreSQL + SG + subnet/parameter groups | `AWS::RDS::DBInstance` (`<cluster>-db`, `rds.logical_replication=1`), master password managed in Secrets Manager | `EnableManagedDatabase` |

## 3. Manual provisioning still required

- **Kubeconfig** (after stack create): `aws eks update-kubeconfig --name <cluster> --region <region>`
- **DNS**: point your app domain at the load balancer the chart creates during `rulebricks deploy` (or enable external-dns in the deployment).
- **Secrets for the CLI wizard** (only when toggles are on) — run the stack's `*Command` outputs: `MskBootstrapBrokersCommand`, `RedisAuthTokenCommand`, `DbMasterPasswordCommand`.
- Pod Identity associations are **not** manual — the Rulebricks CLI creates them at `rulebricks deploy` time.

### Bring your own cluster

If your EKS cluster was not created by this stack, `rulebricks deploy` needs two things it validates at preflight:

1. The Pod Identity agent add-on:

```bash
aws eks create-addon --cluster-name <cluster> \
  --addon-name eks-pod-identity-agent --region <region>
```

2. A dedicated workload role named `<cluster>-rulebricks` trusted by `pods.eks.amazonaws.com` — never the cluster or node roles (Pod Identity rejects their trust policies; legacy IRSA/OIDC roles fail the same way):

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

Add `aps:RemoteWrite` (AMP) and the `kafka-cluster:*` statements from `rulebricks-cluster.cfn.yaml` (MSK IAM) if you use those paths. A BYO cluster also needs the `aws-ebs-csi-driver` and `metrics-server` add-ons.

## 4. Deploy

```bash
AWS_REGION=us-east-1 bash check-aws-prereqs.sh   # verifies identity, quotas, IAM rights

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

- `CAPABILITY_NAMED_IAM` is required (named roles `<cluster>-rulebricks`, `<cluster>-ebs-csi`, `<cluster>-cluster-autoscaler`).
- Timing: ~20-25 min base; `EnableManagedKafka` adds ~30 min, `EnableManagedDatabase` (Multi-AZ) ~15-20 min (parallel).
- Then run `rulebricks init` and select the cluster; stack outputs map 1:1 to wizard fields.

## 5. Take down

```bash
# 1. Remove Kubernetes-created resources first (load balancers, PVC-backed EBS volumes)
rulebricks destroy <deployment-name>

# 2. Only if EnableManagedDatabase was on: lift deletion protection
aws rds modify-db-instance --db-instance-identifier rulebricks-cluster-db \
  --no-deletion-protection --apply-immediately --region us-east-1

# 3. CloudFormation cannot delete non-empty buckets. NOTE: the bucket holds
#    your decision-log archives (decision-logs/) and database backups
#    (db-backups/) - emptying it destroys them permanently, so copy out
#    anything you need first.
ACCOUNT_ID="$(aws sts get-caller-identity --query Account --output text)"
aws s3 rm "s3://rulebricks-cluster-data-${ACCOUNT_ID}" --recursive

# 4. Delete the stack
aws cloudformation delete-stack --stack-name rulebricks-cluster --region us-east-1
aws cloudformation wait stack-delete-complete \
  --stack-name rulebricks-cluster --region us-east-1
```

Resources that linger after stack deletion — check and remove manually:

| Leftover | Why | Cleanup |
| --- | --- | --- |
| Load balancers + EBS volumes created by Kubernetes | Provisioned by the cluster, not the stack | `rulebricks destroy` before stack delete; otherwise delete via EC2/ELB console |
| RDS final snapshot | `DeletionPolicy: Snapshot` on the DB instance | `aws rds delete-db-snapshot` when no longer needed |
| KMS key (stack-created) | Keys enter a pending-deletion window instead of deleting immediately | Auto-deletes after the window; nothing to do |
| CloudWatch log group `/aws/eks/<cluster>/cluster` | Control-plane logs outlive the cluster | `aws logs delete-log-group` |
| Pod Identity associations | Created by the CLI, not the stack (deleted with the cluster) | None |
