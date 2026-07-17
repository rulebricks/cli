# Cluster Setup

Infrastructure-as-code for standing up a Rulebricks-ready Kubernetes cluster —
one template per cloud. Managed Kafka, Redis, and Postgres are independent
true/false toggles on each template that **default to off**: everything runs
in-cluster until you enable them, and any combination is valid.

> These templates are reference implementations. Treat them as a starting
> point and customize them to accommodate pre-existing services or unique
> performance requirements. Every resource is commented with why Rulebricks
> needs it, so the templates double as the authoritative statement of
> requirements for infra/cyber review.

## Layout

```
aws/rulebricks-cluster.cfn.yaml   EKS (CloudFormation) + MSK/ElastiCache/RDS toggles
azure/main.bicep + modules/       AKS (Bicep) + Event Hubs/Managed Redis/
                                  PostgreSQL Flexible Server/ACR image-mirror
                                  toggles (+ mirror-to-acr.sh seeding script)
gcp/*.tf                          GKE (Terraform) + Managed Kafka/Memorystore/
                                  Cloud SQL toggles
```

Each folder ships a parameters sample (`parameters.json` /
`terraform.tfvars.example`), a `check-*-prereqs.sh` access checker, and a
README with five sections: parameters, deployed resources, remaining manual
steps, deploy command, and take-down command.

## Shared conventions (what the CLI keys on)

- **One identity**: `<cluster>-rulebricks` (IAM role via EKS Pod Identity /
  user-assigned managed identity via AKS Workload Identity / Google service
  account via GKE Workload Identity). The `rulebricks` CLI wizard preselects
  it by name.
- **One data store**: bucket `<cluster>-data-<account|project>` (AWS/GCP) /
  container `<cluster>-data` (Azure), with `decision-logs/` and `db-backups/`
  prefixes.
- **Deployment-independent**: namespace-scoped bindings (Pod Identity
  associations / federated identity credentials / workloadIdentityUser
  bindings) are created by the CLI at `rulebricks deploy` time, so one cluster
  hosts many deployments without re-running the template.
- **Burst pool contract**: label + taint `rulebricks.com/pool=burst`; the
  chart's worker fleet tolerates and prefers it out of the box.
- **Node autoscaling**: AKS and GKE node pools autoscale natively. EKS does
  not, so the chart deploys cluster-autoscaler on AWS and the CFN template
  provisions its `<cluster>-cluster-autoscaler` Pod Identity role (the CLI
  binds the two at deploy time). Without it, worker scale-outs strand Pending
  pods and the burst pool never leaves 0 nodes.

## Outputs -> CLI wizard fields

Run `rulebricks init` after the cluster exists; the wizard consumes these
outputs (data-service rows appear only when the matching toggle is on):

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
| Postgres endpoint | `DbEndpoint` / `DbPort` / `DbName` | `postgresHost` / `postgresPort` / `postgresDatabase` | `postgres_host` / `postgres_port` / `postgres_database` (config-file only; the wizard does not prompt for GCP Postgres) |
| Postgres bootstrap creds | `DbMasterUsername` + `DbMasterPasswordCommand` (run it) | `postgresAdminUsernameOut` + your `@secure` password | `postgres_master_username` + your `TF_VAR` password |

Secrets never appear in template outputs — the `*Command` outputs print them
on demand from Secrets Manager / the Azure control plane / gcloud.

Azure additionally offers an ACR image mirror (`enableContainerRegistry`) for
restricted-egress installs: its `containerRegistryLoginServer` output is not a
wizard field but goes into the deployment config's `imageRegistry` setting
after seeding the registry with `azure/mirror-to-acr.sh` (see the Azure
README's "Manual provisioning" section).

## Related documentation

The helm repo's `reports/` folder generates customer-facing deployment
checklist workbooks that itemize the same requirements row by row for
infra/cyber sign-off: `reports/aws-deployment-checklist/` and
`reports/azure-deployment-checklist/`.
