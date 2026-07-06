# Cluster Setup

Infrastructure-as-code for standing up a Rulebricks-ready Kubernetes cluster.
Each cloud has a **turnkey** template (compact, one file, sane defaults — what
we use for load testing and quick installs) and an **enterprise** variant
(private networking, hardened defaults, and true/false toggles that provision
managed Kafka/Redis/Postgres for the deployment to externalize to).

Both variants double as documentation: every resource is commented with why
Rulebricks needs it, and the enterprise READMEs are written to be handed to a
customer's infra/cyber teams as the authoritative statement of requirements.

## Layout

```
aws/rulebricks-cluster.cfn.yaml          turnkey EKS (CloudFormation)
aws/enterprise/rulebricks-enterprise.cfn.yaml
                                         enterprise EKS + MSK/ElastiCache/RDS toggles
azure/rulebricks-cluster.bicep           turnkey AKS (Bicep)
azure/enterprise/main.bicep + modules/   enterprise AKS + Event Hubs/Managed Redis/
                                         PostgreSQL Flexible Server toggles
gcp/README.md                            turnkey GKE (gcloud guidance)
gcp/enterprise/*.tf                      enterprise GKE (Terraform) + Managed Kafka/
                                         Memorystore/Cloud SQL toggles
```

Each folder ships a parameters sample (`parameters.json` /
`terraform.tfvars.example`), a README with create/verify/delete commands, and
a `check-*-prereqs.sh` access checker. **The managed data-service toggles all
default to off** — everything runs in-cluster until you flip them.

## Turnkey vs enterprise

| | Turnkey | Enterprise |
| --- | --- | --- |
| Networking | Public subnets (AWS) / single subnet (Azure) / gcloud guide (GCP) | Private nodes + data subnets, NAT, VPC/private endpoints, parameterized CIDRs |
| Cluster hardening | Defaults | KMS secrets encryption + control-plane logging (AWS); CNI Overlay + Cilium, optional private cluster + Entra RBAC (Azure); Dataplane V2 + least-privilege node SA (GCP) |
| Node pools | Core 3-6 x 4 vCPU/16 GiB + burst 16 vCPU/64 GiB | Same contract (`rulebricks.com/pool=burst` label/taint) |
| Managed Kafka | - | Amazon MSK (IAM) / Event Hubs Premium / Managed Service for Apache Kafka |
| Managed Redis | - | ElastiCache for Valkey / Azure Managed Redis / Memorystore for Redis |
| Managed Postgres | - | RDS PostgreSQL 17 / PostgreSQL Flexible Server 17 / Cloud SQL PostgreSQL 17 (all with logical replication for Supabase Realtime) |
| Metrics | AMP / Azure Monitor managed Prometheus / Managed Service for Prometheus | Same, toggleable |

The three data-service toggles are independent and **default to off** — enable
any combination; the Rulebricks chart runs Kafka, Valkey, and Postgres
in-cluster for whichever stays off. One caveat: the CLI wizard offers external
Postgres on AWS/Azure only today — on GCP, external Cloud SQL is configured by
hand in the deployment config file (the chart itself is cloud-agnostic; see
`gcp/enterprise/README.md`).

## Shared conventions (what the CLI keys on)

- **One identity**: `<cluster>-rulebricks` (IAM role via EKS Pod Identity /
  user-assigned managed identity via AKS Workload Identity). The `rulebricks`
  CLI wizard preselects it by name.
- **One data store**: bucket `<cluster>-data-<account>` (AWS) / container
  `<cluster>-data` (Azure), with `decision-logs/` and `db-backups/` prefixes.
- **Deployment-independent**: namespace-scoped bindings (Pod Identity
  associations / federated identity credentials) are created by the CLI at
  `rulebricks deploy` time, so one cluster hosts many deployments without
  re-running the template.
- **Burst pool contract**: label + taint `rulebricks.com/pool=burst`; the
  chart's worker fleet tolerates and prefers it out of the box.

## Outputs -> CLI wizard fields

Run `rulebricks init` after the cluster exists; the wizard consumes these
outputs (enterprise adds the data-service rows):

| Purpose | AWS output | Azure output | GCP output |
| --- | --- | --- | --- |
| Cluster selection | `ClusterName` | `clusterName` | `cluster_name` |
| Storage identity | `RulebricksRoleArn` | `rulebricksClientId` | `rulebricks_service_account` |
| Object storage | `DataBucketName` | `storageAccountName` + `dataContainer` | `data_bucket` |
| Metrics remote write | `PrometheusRemoteWriteUrl` | `dceMetricsIngestionEndpoint` + `dcrImmutableId` | (`monitoring.metricWriter` grant; no endpoint output needed) |
| Kafka brokers | `MskBootstrapBrokersCommand` (run it) | `kafkaBootstrapServers` | `kafka_bootstrap_servers` |
| Kafka auth | `KafkaSaslMechanism` (`aws-iam`) + `KafkaRegion` | `kafkaConnectionStringCommand` (run it) | `kafka_sasl_username` + `kafka_sasl_password_command` (run it) |
| Redis endpoint | `RedisHost` / `RedisPort` / `RedisTlsEnabled` | `redisHost` / `redisPort` / `redisTlsEnabled` | `redis_host` / `redis_port` / `redis_tls_enabled` |
| Redis password | `RedisAuthTokenCommand` (run it) | `redisAccessKeyCommand` (run it) | `redis_auth_string_command` (run it) |
| Postgres endpoint | `DbEndpoint` / `DbPort` / `DbName` | `postgresHost` / `postgresPort` / `postgresDatabase` | `postgres_host` / `postgres_port` / `postgres_database` (config-file only, see caveat) |
| Postgres bootstrap creds | `DbMasterUsername` + `DbMasterPasswordCommand` (run it) | `postgresAdminUsernameOut` + your `@secure` password | `postgres_master_username` + your `TF_VAR` password |

Secrets never appear in template outputs — the `*Command` outputs print them
on demand from Secrets Manager / the Azure control plane / gcloud.

## Related documentation

The helm repo's `reports/` folder generates customer-facing deployment
checklist workbooks that itemize the same requirements row by row for
infra/cyber sign-off: `reports/aws-deployment-checklist/` and
`reports/azure-deployment-checklist/`.
