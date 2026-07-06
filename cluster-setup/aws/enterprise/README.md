# AWS Enterprise Cluster Setup

One CloudFormation stack (`rulebricks-enterprise.cfn.yaml`) that provisions
everything a production Rulebricks deployment needs on AWS, hardened for
enterprise environments and with **independent true/false toggles** for the
managed data services Rulebricks can externalize to:

| Toggle | Managed service | Replaces in-cluster |
| --- | --- | --- |
| `EnableManagedKafka` | Amazon MSK (IAM auth, TLS) | Strimzi Kafka |
| `EnableManagedRedis` | ElastiCache for Valkey (TLS + AUTH) | Valkey |
| `EnableManagedDatabase` | RDS for PostgreSQL 17 | Supabase Postgres |
| `EnableManagedPrometheus` | Amazon Managed Prometheus | (metrics stay in-cluster) |

Any combination is valid — the Rulebricks chart runs Kafka, Valkey, and
Postgres in-cluster for whichever you leave disabled. Beyond the toggles, this
differs from the turnkey stack (`../rulebricks-cluster.cfn.yaml`) by adding
private networking, KMS secrets encryption, control-plane audit logging, a
least-privilege EBS CSI role, and Secrets Manager for every generated
credential.

Even if your team cannot run the template directly, it is written to be read:
every resource, security-group rule, IAM statement, and parameter is commented
with why Rulebricks needs it. Treat it as the authoritative statement of our
AWS requirements.

## Files

- `rulebricks-enterprise.cfn.yaml` — the single, self-contained stack (no
  nested stacks; review or email one file).
- `parameters.json` — sample parameters. The three data-service toggles
  default to **off** (everything runs in-cluster); flip the ones you want
  managed to `"true"` before deploying.
- `../check-aws-prereqs.sh` — same prerequisite checks as the turnkey stack.

## Architecture

```
                        Internet
                           │
              ┌────────────┴───────────┐
              │  Internet gateway      │
              └────────────┬───────────┘
        public subnets (3 AZs): NLB for Traefik, NAT gateway(s)
              └────────────┬───────────┘
        private subnets (3 AZs)
        ├─ EKS nodes: core nodegroup (3-6 x m7i.xlarge)
        │             burst nodegroup (0-N x m7i.4xlarge,
        │             taint rulebricks.com/pool=burst)
        ├─ Amazon MSK brokers        (EnableManagedKafka)
        ├─ ElastiCache for Valkey    (EnableManagedRedis)
        └─ RDS for PostgreSQL        (EnableManagedDatabase)

        S3 gateway endpoint  →  s3://<cluster>-data-<account>
        Amazon Managed Prometheus    (EnableManagedPrometheus)
```

- **Nodes and data services have no public IPs.** Only load balancers and NAT
  gateways live in public subnets. Data-service security groups admit traffic
  exclusively from the EKS cluster security group on the service port
  (9098 Kafka, 6379 Valkey, 5432 Postgres).
- **Kubernetes API**: `ClusterEndpointAccess=PublicAndPrivate` (default) keeps
  `kubectl`/CLI access simple; `PrivateOnly` restricts the API to the VPC —
  you then need a bastion/VPN to deploy.
- **Egress**: private subnets reach the internet through NAT
  (`SingleNatGateway=true` for one shared gateway, `false` for per-AZ HA).
  S3 traffic bypasses NAT via the gateway endpoint. Set
  `EnableVpcInterfaceEndpoints=true` to also keep ECR/EC2/STS/EKS/ELB/Logs
  control traffic inside the VPC (restricted-egress environments).

## Identity model (EKS Pod Identity)

A single IAM role, `<cluster>-rulebricks`, is trusted by the EKS Pod Identity
service principal (`pods.eks.amazonaws.com`) — AWS's recommended mechanism for
new clusters (no OIDC provider to manage). The stack grants it exactly three
things:

| Permission | Target | Used by |
| --- | --- | --- |
| `s3:Get/Put/DeleteObject`, `s3:ListBucket` | `<cluster>-data-<account>` | Vector (decision logs), backup job, ClickHouse archive reads |
| `aps:RemoteWrite` | the AMP workspace | Prometheus |
| `kafka-cluster:*` (connect/topics/groups) | the MSK cluster (scoped when `EnableManagedKafka=true`, account-wide fallback otherwise) | HPS, workers, Vector's Kafka bridge, topic-provision job |

**This stack does not need a deployment name.** Pod Identity associations are
namespace-scoped, so the **Rulebricks CLI creates the associations** at
`rulebricks deploy` time, binding these ServiceAccounts to the role:

| Service account | Data path |
| --- | --- |
| `vector` | decision logs → S3 |
| `<release>-clickhouse` | decision-log archive reads ← S3 |
| `<release>-backup` | DB backups → S3 |
| `prometheus` | metrics → AMP |
| `<release>-hps`, `<release>-hps-worker`, `<release>-kafka-topic-provision` | MSK IAM auth |

One cluster can therefore host many deployments without re-running this stack.
Two other scoped roles exist and are not shared: `<cluster>-ebs-csi` (EBS CSI
driver via Pod Identity — kept off the node role on purpose) and the node role
itself (kubelet, CNI, ECR pulls only).

Bringing your own cluster instead of this stack? See "Bring your own cluster"
in [`../README.md`](../README.md): deploy requires the `eks-pod-identity-agent`
add-on and a dedicated role trusted by `pods.eks.amazonaws.com` — never the
cluster or node roles, whose trust policies Pod Identity rejects.

## Node sizing

The chart's steady-state request floor is ~10 vCPU / ~23 GiB (plus per-node
DaemonSets and headroom for request-less pods), which sets the defaults:

- **Core**: 3-6 x `m7i.xlarge` (4 vCPU / 16 GiB). 3 nodes = 12 vCPU / 48 GiB —
  fits the floor with headroom, one node per AZ. The 6-node ceiling covers HPS
  scaling 3 → 8. General-purpose `m7i` (4 GiB/vCPU) beats compute-optimized
  `c7i` (2 GiB/vCPU) here because memory runs out first.
- **Burst**: 0-1 x `m7i.4xlarge` (16 vCPU / 64 GiB), labeled and tainted
  `rulebricks.com/pool=burst`. The chart's workers tolerate the taint and
  softly prefer the label, so the KEDA-scaled fleet (up to 64 workers x
  1 GiB requests ≈ 64 GiB) lands here, not on core nodes.
- **Quota check**: full burst = 3x4 + 16 = 28 vCPU steady-state; absolute max
  (6 core nodes + burst) = 40 on-demand vCPUs, plus MSK/ElastiCache/RDS vCPUs
  which draw from separate service quotas.

## Managed data services

### Kafka — Amazon MSK (`EnableManagedKafka`)

- MSK Provisioned, 3 brokers (`kafka.m7g.large`, one per AZ), Kafka `3.9.x`,
  **IAM auth only** over TLS (no SASL/SCRAM, no plaintext, no unauthenticated
  access), 100 GiB EBS per broker.
- The chart's provisioning job creates the topics at deploy time —
  `com.rulebricks.solution` (128 partitions), `com.rulebricks.solution-response`
  (128), `com.rulebricks.logs` (24), replication factor 3 — authenticated via
  the `<cluster>-rulebricks` role. No manual topic administration needed.
- CLI config: external Kafka, preset **`aws-msk-iam`**; brokers from the
  `MskBootstrapBrokersCommand` output (port 9098); region = stack region.

### Redis — ElastiCache for Valkey (`EnableManagedRedis`)

- Valkey `8.2` replication group — the same engine the chart runs in-cluster,
  so behavior is identical. `RedisMultiAz=true` (default) runs primary +
  replica across AZs with automatic failover.
- TLS in transit, encryption at rest, and a 32-char AUTH token generated
  directly into Secrets Manager (`<cluster>/redis-auth`) — it never appears in
  parameters, outputs, or CloudFormation state.
- CLI config: external Redis, host/port from outputs, TLS **on**, password
  from the `RedisAuthTokenCommand` output.

### Database — RDS for PostgreSQL (`EnableManagedDatabase`)

- PostgreSQL 17 (`db.m7g.large`, Multi-AZ by default), 100 GiB gp3 with
  autoscaling to 500 GiB, encrypted at rest, 7-day backups, Performance
  Insights on.
- The parameter group ships **`rds.logical_replication=1`** (plus
  `max_replication_slots`/`max_wal_senders` = 10) because Supabase Realtime
  requires logical replication — the Rulebricks CLI preflights this and blocks
  the deploy if it is off.
- Master credentials are **RDS-managed in Secrets Manager**
  (`ManageMasterUserPassword`); no password ever passes through CloudFormation.
  The Rulebricks bootstrap job uses them once to create the Supabase roles and
  schemas.
- `DeletionProtection=true` by default and the instance snapshots on delete.
- CLI config: database "self-hosted" + external Postgres; host/port/database
  from outputs; bootstrap master username/password from the
  `DbMasterPasswordCommand` output.

### Metrics — Amazon Managed Prometheus (`EnableManagedPrometheus`)

- An AMP workspace plus the `aps:RemoteWrite` grant on the Rulebricks role.
  The CLI's monitoring step consumes `PrometheusRemoteWriteUrl` (append
  `/api/v1/remote_write`).

## Check access, create, connect

```bash
AWS_REGION=us-east-1 bash ../check-aws-prereqs.sh

aws cloudformation create-stack \
  --stack-name rulebricks-enterprise \
  --region us-east-1 \
  --template-body file://rulebricks-enterprise.cfn.yaml \
  --parameters file://parameters.json \
  --capabilities CAPABILITY_NAMED_IAM

aws cloudformation wait stack-create-complete \
  --stack-name rulebricks-enterprise --region us-east-1

aws eks update-kubeconfig --name rulebricks-cluster --region us-east-1
```

Notes:

- `CAPABILITY_NAMED_IAM` is required because the stack creates named roles
  (`<cluster>-rulebricks`, `<cluster>-ebs-csi`).
- The deploying principal automatically becomes cluster admin
  (`BootstrapClusterCreatorAdminPermissions`). Grant a second operations
  principal with `AdminPrincipalArn`.
- Expect ~20-25 min for the base stack; MSK adds ~30 min, RDS Multi-AZ ~15-20
  min (they create in parallel).
- **Cost**: every data-service toggle you flip on adds real spend — MSK is a
  multi-AZ 3-broker cluster, ElastiCache a 2-node replication group, RDS a
  Multi-AZ instance — on top of the 3+ nodes. All three default to off.

## Stack outputs → Rulebricks CLI fields

Run `rulebricks init` after kubeconfig works, then map outputs to wizard
fields:

| Output | CLI wizard field |
| --- | --- |
| `ClusterName` | cluster selection |
| `DataBucketName` | storage step — S3 bucket |
| `RulebricksRoleArn` | storage step — IAM role (preselected by naming convention) |
| `PrometheusRemoteWriteUrl` | monitoring step — remote write URL (append `/api/v1/remote_write`) |
| `MskBootstrapBrokersCommand` (run it) | external services — Kafka brokers |
| `KafkaSaslMechanism`, `KafkaRegion` | external services — Kafka auth (`aws-iam`) + region |
| `RedisHost`, `RedisPort`, `RedisTlsEnabled` | external services — Redis host / port / TLS |
| `RedisAuthTokenCommand` (run it) | external services — Redis password |
| `DbEndpoint`, `DbPort`, `DbName` | external services — Postgres host / port / database |
| `DbMasterUsername`, `DbMasterPasswordCommand` (run it) | external services — bootstrap master credentials |

Secrets stay in Secrets Manager; the two `*Command` outputs print them on
demand for pasting into the wizard (which stores them as Kubernetes secrets).

## Inbound / outbound summary (for network reviews)

**Inbound (from the internet):** only 80/443 to the load balancer EKS
provisions for Traefik (80 exists for ACME HTTP-01 + redirect). The Kubernetes
API (443) is also public unless `ClusterEndpointAccess=PrivateOnly`.

**Within the VPC:** node SG → MSK 9098, Valkey 6379, Postgres 5432 (each
data-service SG admits only the EKS cluster security group).

**Outbound (via NAT):** container registries (Docker Hub, ghcr.io, quay.io),
`*.amazonaws.com` service APIs (unless using interface endpoints),
`api.rulebricks.com` (license validation), Let's Encrypt (TLS issuance), and
your SMTP relay. S3 rides the gateway endpoint, not NAT.

## Delete the cluster

Run `rulebricks destroy <deployment-name>` first so Kubernetes removes
LoadBalancer services and PVC-backed EBS volumes. Then:

```bash
# 1. RDS deletion protection blocks stack deletion; lift it first (skip if DB toggle off)
aws rds modify-db-instance --db-instance-identifier rulebricks-cluster-db \
  --no-deletion-protection --apply-immediately --region us-east-1

# 2. CloudFormation cannot delete non-empty buckets
ACCOUNT_ID="$(aws sts get-caller-identity --query Account --output text)"
aws s3 rm "s3://rulebricks-cluster-data-${ACCOUNT_ID}" --recursive

# 3. Delete the stack (RDS takes a final snapshot automatically)
aws cloudformation delete-stack --stack-name rulebricks-enterprise --region us-east-1
aws cloudformation wait stack-delete-complete \
  --stack-name rulebricks-enterprise --region us-east-1
```
