<div align="center">
  <h1>🚀 Rulebricks CLI</h1>
  <p><strong>Enterprise-grade deployment tool for Rulebricks rule engine clusters</strong></p>
  <p>
    <a href="#installation">Installation</a> •
    <a href="#quick-start">Quick Start</a> •
    <a href="#commands">Commands</a> •
    <a href="#architecture">Architecture</a> •
    <a href="#configuration">Configuration</a>
  </p>
</div>

---

## Overview

The Rulebricks CLI is a powerful deployment and management tool that automates the creation and maintenance of production-ready Rulebricks rule engine clusters. It handles the complete infrastructure lifecycle across multiple cloud providers, from initial setup to ongoing operations.

This CLI is designed and tested primarily for use with AWS, though we make infrastructure decisions that ensure we can easily adapt to Azure and Google Cloud in the future.

### Key Features

- **🌐 Multi-Cloud Support**: Deploy seamlessly to AWS, Azure, or Google Cloud
- **📦 Complete Stack**: Automatically provisions Kubernetes, databases, monitoring, and all required services
- **🔄 Zero-Downtime Upgrades**: Safely upgrade your Rulebricks deployment with rollback capabilities
- **🔒 Enterprise Security**: Built-in TLS/SSL, secrets management, and network security
- **📊 Observability**: Integrated Prometheus, Grafana, and centralized logging
- **⚡ High Performance**: Auto-scaling, Kafka event streaming, and optimized resource utilization

## Installation

### Quick Install (Recommended)

**macOS and Linux:**
```bash
curl -sSfL https://raw.githubusercontent.com/rulebricks/cli/main/install.sh | sh
```

**Windows:**
Download the latest Windows binary from the [releases page](https://github.com/rulebricks/cli/releases/latest) and add it to your PATH.

### Install from Source

Requires Go 1.21+:
```bash
git clone https://github.com/rulebricks/cli.git
cd cli
make install
```

### Verify Installation

```bash
rulebricks version
```

## Quick Start

### 1. Initialize Your Project

Create a configuration file with the interactive wizard:

```bash
rulebricks init
```

This guides you through:
- Project naming and domain configuration
- Cloud provider selection and credentials
- Database deployment options
- Email provider setup
- Security and monitoring preferences

### 2. Deploy Your Cluster

Deploy your complete Rulebricks cluster:

```bash
rulebricks deploy
```

This single command:
- Provisions cloud infrastructure using Terraform
- Creates a managed Kubernetes cluster
- Deploys and configures all required services
- Sets up DNS and SSL certificates
- Initializes the database with migrations

### 3. Monitor Your Deployment

Check the status of your deployment:

```bash
rulebricks status
```

View logs from any component:

```bash
rulebricks logs app -f
```

## Commands

### Core Commands

| Command | Description |
|---------|-------------|
| `rulebricks init` | Initialize a new project configuration |
| `rulebricks deploy` | Deploy Rulebricks to your cluster |
| `rulebricks destroy` | Remove Rulebricks deployment |
| `rulebricks status` | Show deployment status and health |
| `rulebricks logs [component]` | View component logs |
| `rulebricks upgrade` | Manage version upgrades |

### Deploy Command

```bash
rulebricks deploy [flags]
```

**Flags:**
- `--chart-version string`: Specific chart version to deploy (default: latest)
- `-c, --config string`: Config file path (default: rulebricks.yaml)
- `-v, --verbose`: Enable verbose output

The deploy command handles:
- Infrastructure provisioning (VPC, subnets, security groups)
- Kubernetes cluster creation with autoscaling
- Core services installation (Traefik, cert-manager, KEDA)
- Database deployment (Supabase or external)
- Application deployment with proper configuration
- DNS verification and TLS certificate provisioning

### Destroy Command

```bash
rulebricks destroy [flags]
```

**Flags:**
- `--cluster`: Destroy the entire cluster infrastructure
- `--force`: Skip confirmation prompts
- `-v, --verbose`: Enable verbose output

**⚠️ Warning:** Using `--cluster` will permanently delete all data and infrastructure.

### Status Command

```bash
rulebricks status
```

Displays comprehensive status including:
- Infrastructure health and cluster endpoint
- Kubernetes node status and resource usage
- Pod distribution and health
- Database availability and endpoints
- Application deployment status
- Service endpoints and versions
- Certificate validity

### Logs Command

```bash
rulebricks logs [component] [flags]
```

**Components:**
- `app`: Main Rulebricks application
- `database`: PostgreSQL database logs
- `supabase`: All Supabase services
- `traefik`: Ingress controller logs
- `prometheus`: Metrics collection
- `grafana`: Monitoring dashboards
- `all`: Combined logs from all components

**Flags:**
- `-f, --follow`: Stream logs in real-time
- `-t, --tail int`: Number of recent lines to show (default: 100)

### Upgrade Command

```bash
rulebricks upgrade <subcommand>
```

**Subcommands:**
- `list`: Show available versions
- `status`: Check current version and available updates
- `run [version]`: Upgrade to specified version (or latest)

**Upgrade Features:**
- Zero-downtime rolling updates
- Automatic backup of current configuration
- Dry-run mode to preview changes
- Rollback capability on failure

### Vector Command

```bash
rulebricks vector <subcommand>
```

Configure IAM permissions for Vector logging sinks that require cloud provider authentication.

**Subcommands:**

#### `setup-s3`
Automatically configure AWS IAM permissions for S3 logging:
```bash
rulebricks vector setup-s3 [flags]
```

**Flags:**
- `--bucket`: S3 bucket name (uses config value if not specified)
- `--region`: AWS region (uses config value if not specified)
- `--cluster`: EKS cluster name (uses config value if not specified)

**What it does:**
- Creates OIDC provider for the cluster (if needed)
- Creates IAM policy with S3 permissions
- Creates IRSA service account
- Updates Vector deployment to use the service account
- Verifies S3 access

#### `setup-gcs`
Automatically configure GCP Workload Identity for Cloud Storage logging:
```bash
rulebricks vector setup-gcs [flags]
```

**Flags:**
- `--bucket`: GCS bucket name (uses config value if not specified)
- `--project`: GCP project ID (uses config value if not specified)
- `--cluster`: GKE cluster name (uses config value if not specified)

**What it does:**
- Enables Workload Identity on the cluster (if needed)
- Creates GCP service account
- Grants storage permissions
- Binds Workload Identity
- Updates Vector deployment
- Verifies GCS access

#### `setup-azure`
Automatically configure Azure Managed Identity for Blob Storage logging:
```bash
rulebricks vector setup-azure [flags]
```

**Flags:**
- `--storage-account`: Azure storage account name
- `--container`: Blob container name (uses config value if not specified)
- `--resource-group`: Azure resource group (uses config value if not specified)
- `--cluster`: AKS cluster name (uses config value if not specified)

**What it does:**
- Creates managed identity
- Assigns storage permissions
- Configures pod identity
- Updates Vector deployment
- Verifies Azure access

#### `generate-iam-config`
Generate IAM configuration for manual setup:
```bash
rulebricks vector generate-iam-config [flags]
```

**Flags:**
- `--sink`: Sink type (aws_s3, gcp_cloud_storage, azure_blob)
- `--bucket`: Bucket/container name

**Output:**
- IAM policy documents
- Step-by-step manual setup instructions
- CLI commands to execute

**Example Usage:**
```bash
# Automatic S3 setup after deployment
rulebricks vector setup-s3

# Generate manual setup instructions for GCS
rulebricks vector generate-iam-config --sink gcp_cloud_storage --bucket my-logs

# Setup Azure with specific parameters
rulebricks vector setup-azure --storage-account mylogs --container logs
```

## Architecture

### System Overview

Rulebricks deploys a complete, production-ready microservices architecture:

```
┌─────────────────────────────────────────────────────────────┐
│                        Load Balancer                         │
│                    (Cloud Provider LB)                       │
└────────────────────────────┬────────────────────────────────┘
                             │
┌────────────────────────────┴────────────────────────────────┐
│                     Traefik Ingress                          │
│              (TLS Termination, Routing)                      │
└────────────────────────────┬────────────────────────────────┘
                             │
        ┌────────────────────┼────────────────────┐
        │                    │                    │
┌───────▼────────┐  ┌────────▼────────┐  ┌───────▼────────┐
│   Rulebricks   │  │    Supabase     │  │    Grafana     │
│      App       │  │    Dashboard    │  │   Dashboard    │
│                │  │                 │  │                │
└────────────────┘  └─────────────────┘  └────────────────┘
        │                    │
        ├────────────────────┤
        │                    │
┌───────▼────────┐  ┌────────▼────────┐
│    Workers     │  │   PostgreSQL    │
│  (HPS/Kafka)   │  │    Database     │
└────────────────┘  └─────────────────┘
        │
┌───────▼────────────────────────────────┐
│             Kafka Cluster              │
│        (Event Streaming Bus)           │
└────────────────────────────────────────┘
```

### Core Components

#### 1. **Kubernetes Cluster**
- Managed Kubernetes service (EKS, AKS, or GKE)
- Auto-scaling node groups
- Multiple availability zones for HA
- RBAC and network policies

#### 2. **Rulebricks Application**
- Main rule engine application
- Horizontal Pod Autoscaler (HPA) for dynamic scaling
- ConfigMaps for environment configuration
- Persistent volume claims for data

#### 3. **Event Processing (Kafka)**
- High-throughput event streaming
- Configurable partitions and replication
- Used for async rule processing
- KEDA-based autoscaling for workers

#### 4. **Database Layer**
Three deployment options:

**Self-Hosted Supabase:**
- Complete Supabase stack in Kubernetes
- PostgreSQL with automatic backups
- Realtime subscriptions
- Authentication and storage services

**External Database:**
- Connect to existing PostgreSQL
- Support for read replicas
- Connection pooling
- SSL/TLS encryption

**Managed Supabase:**
- Fully managed Supabase project
- Automatic scaling and backups
- Global CDN for assets
- Built-in monitoring

#### 5. **Observability Stack**

**Metrics (Prometheus + Grafana):**
- Cluster and application metrics
- Custom dashboards
- Alert rules
- Long-term storage options

**Logging (Vector):**
- Centralized log aggregation
- Multiple sink options:
  - Elasticsearch
  - Datadog
  - AWS S3
  - Splunk
  - Custom HTTP endpoints
- Structured logging with filtering

#### 6. **Ingress & Security**
- Traefik for advanced routing
- Automatic TLS with Let's Encrypt
- Rate limiting and DDoS protection
- Web Application Firewall (WAF) rules

### Resource Requirements

#### Performance Tiers

The CLI provides three performance tiers that align with resource allocations:

| Tier | Volume Level | Use Case | Typical Load |
|------|--------------|----------|--------------|
| **Small** | `small` | Development/Testing | <100 rules/sec |
| **Medium** | `medium` | Production | 100-1000 rules/sec |
| **Large** | `large` | High Performance | >1000 rules/sec |

#### Minimum Requirements by Tier

**Small (Development)**
- **Nodes**: 1-2 nodes
- **CPU**: 2 vCPUs per node
- **Memory**: 4GB RAM per node
- **Storage**: 20GB SSD per node
- **Total Minimum**: ~2 CPUs, 4GB RAM

**Medium (Production)**
- **Nodes**: 3 nodes (for HA)
- **CPU**: 4 vCPUs per node
- **Memory**: 8GB RAM per node
- **Storage**: 50GB SSD per node
- **Total Minimum**: ~12 CPUs, 24GB RAM

**Large (High Performance)**
- **Nodes**: 5+ nodes with autoscaling
- **CPU**: 8 vCPUs per node
- **Memory**: 16GB RAM per node
- **Storage**: 100GB+ SSD per node
- **Total Minimum**: ~40 CPUs, 80GB RAM

#### Service Resource Breakdown

**Core Services (Required):**
| Service | CPU Request | Memory Request | CPU Limit | Memory Limit | Replicas |
|---------|-------------|----------------|-----------|--------------|----------|
| Rulebricks App | 256m | 256Mi | 512m | 1Gi | 1-6 (HPA) |
| HPS Service | 250m | 256Mi | 1000m | 1Gi | 1-8 (HPA) |
| HPS Workers | 100m | 128Mi | 500m | 512Mi | 3-50 (KEDA) |
| Redis | 200m | 256Mi | 500m | 4Gi | 1 |
| Serverless Redis | - | - | - | - | 1 |

**Kafka Cluster:**
| Component | CPU Request | Memory Request | CPU Limit | Memory Limit | Count |
|-----------|-------------|----------------|-----------|--------------|-------|
| Kafka Broker | 250m | 512Mi | 500m | 2Gi | 1-3 |
| Zookeeper (if used) | 100m | 128Mi | 150m | 192Mi | 1-3 |

**Monitoring Stack (Optional):**
| Component | Typical CPU | Typical Memory | Storage |
|-----------|-------------|----------------|---------|
| Prometheus | 500m-2000m | 4GB-16GB | 50GB-500GB |
| Grafana | 100m-500m | 512Mi-2Gi | 1GB |
| Node Exporter | 100m | 128Mi | - |

**Ingress & Security:**
| Component | CPU Request | Memory Request | Notes |
|-----------|-------------|----------------|-------|
| Traefik | 100m | 128Mi | Auto-scales with traffic |
| KEDA | 100m | 100Mi | Per operator component |

**Logging (Optional):**
| Component | CPU Request | Memory Request | CPU Limit | Memory Limit | Replicas |
|-----------|-------------|----------------|-----------|--------------|----------|
| Vector | 50m | 128Mi | 200m | 256Mi | 2 |

**Database Options:**

*Self-Hosted Supabase (default):*
- No specific resource limits set by default
- Recommended: 2-4 CPU, 8-16GB RAM for PostgreSQL
- Storage: 10Gi minimum, scales with data

*External Database:*
- No cluster resources required
- Ensure database can handle connection pool size

*Managed Supabase:*
- No cluster resources required
- Billed separately by Supabase

#### Scaling Considerations

**Autoscaling Targets:**
- HPS: 50% CPU, 80% Memory utilization
- Workers: Based on Kafka lag (default: 100 messages)
- Apps: 50% CPU, 80% Memory utilization

**Performance Configuration Example:**
```yaml
performance:
  volume_level: medium
  hps_replicas: 2
  hps_max_replicas: 8
  hps_worker_replicas: 5
  hps_worker_max_replicas: 30
  kafka_partitions: 36
  kafka_replication_factor: 2
```

#### Total Cluster Resource Summary

Here's the total minimum resource allocation needed for each tier:

| Performance Tier | Total CPU (Requests) | Total Memory (Requests) | Storage | Recommended Nodes |
|-----------------|---------------------|------------------------|---------|-------------------|
| **Small** | ~2.5 CPUs | ~4GB | 50GB | 1-2 x t4g.medium or equivalent |
| **Medium** | ~6 CPUs | ~12GB | 200GB | 3 x c8g.xlarge or equivalent |
| **Large** | ~15 CPUs | ~30GB | 500GB+ | 5+ x c8g.2xlarge or equivalent |

**Notes:**
- CPU values are in Kubernetes resource units (1000m = 1 CPU core)
- Memory includes all services (app, workers, Kafka, monitoring if enabled)
- Storage includes persistent volumes for Redis, Kafka, and database
- Node recommendations assume 80% resource utilization target
- Add 20-30% overhead for system pods and burst capacity
- **Important**: All instances must be ARM-based (Graviton on AWS, Ampere on Azure/GCP)

### Resource Tuning Guide

#### Component-Specific Tuning

**Rulebricks Application**

The main application serves the API and web interface.

- Default CPU Request: 256m, Limit: 512m
- Default Memory Request: 256Mi, Limit: 1Gi
- Scales based on 50% CPU and 80% memory utilization

Tuning example:
```yaml
advanced:
  custom_values:
    app:
      resources:
        requests:
          cpu: "500m"
          memory: "512Mi"
        limits:
          cpu: "2000m"
          memory: "2Gi"
```

**HPS (High-Performance Service)**

Handles rule evaluation and processing.

- Default CPU Request: 250m, Limit: 1000m
- Default Memory Request: 256Mi, Limit: 1Gi
- CPU-intensive service - prioritize CPU allocation

Tuning via performance settings:
```yaml
performance:
  hps_resources:
    requests:
      cpu: "500m"
      memory: "512Mi"
    limits:
      cpu: "2000m"
      memory: "2Gi"
```

**HPS Workers**

Process asynchronous jobs from Kafka.

- Default CPU Request: 100m, Limit: 500m
- Default Memory Request: 128Mi, Limit: 512Mi
- Scale based on Kafka lag (default threshold: 100 messages)

**Kafka**

- Default per broker: 250m CPU, 512Mi Memory
- Partition calculation: `max(throughput_mb_per_sec / 10, num_consumers * 3)`
- Scale brokers for throughput (1 broker per 50MB/s)

**Redis**

- Default: 200m CPU, 256Mi Memory (limit 4Gi)
- Memory limit should be 2x expected dataset

#### Common Performance Scenarios

**High API Traffic**
```yaml
performance:
  hps_replicas: 5
  hps_max_replicas: 20
advanced:
  custom_values:
    app:
      autoscaling:
        minReplicas: 5
        maxReplicas: 15
```

**Large Batch Processing**
```yaml
performance:
  hps_worker_replicas: 20
  hps_worker_max_replicas: 100
  kafka_partitions: 100
  kafka_lag_threshold: 50
```

**Memory-Intensive Rules**
```yaml
performance:
  hps_resources:
    requests:
      memory: "2Gi"
    limits:
      memory: "4Gi"
```

#### Cost Optimization

**Right-Sizing ARM Nodes**
- **CPU-optimized**: c8g, c8gd (for evaluation-heavy workloads, Graviton4)
- **Memory-optimized**: r8g, r8gd (for large rule sets, Graviton4)
- **General purpose**: m8g, m8gd (balanced workloads, Graviton4)
- **Burstable**: t4g (development/testing, Graviton2)

**Autoscaling Best Practices**
1. Set appropriate minimums based on baseline load
2. Configure scale-down delays to avoid flapping:
   ```yaml
   performance:
     scale_down_stabilization: 300  # 5 minutes
   ```
3. Use spot instances for workers (70-90% cost savings)

**Storage Optimization**
- Adjust Kafka retention based on needs
- Use gp3 for general purpose (cost-effective)
- Enable compression for Kafka and PostgreSQL

#### Monitoring Resource Usage

Key metrics to watch:
- CPU/Memory utilization: `kubectl top pods -n <namespace>`
- Kafka lag: Check consumer group lag
- Database connections: Monitor connection pool usage
- Response times: Track P50/P90/P99 latencies

When monitoring is enabled, Grafana provides dashboards for:
- Kubernetes resource overview
- Application metrics
- Kafka throughput and lag
- Database performance

### Networking Architecture

- **VPC**: Isolated network per deployment
- **Subnets**: Public (LB) and private (nodes)
- **Security Groups**: Least-privilege access
- **Network Policies**: Pod-to-pod communication rules

## Configuration

### Configuration File Structure

The `rulebricks.yaml` file controls all aspects of your deployment. See [`examples/rulebricks-example.yaml`](../examples/rulebricks-example.yaml) for a complete example with all available options and detailed comments.

**Key configuration sections:**
- `project`: Project metadata and naming
- `cloud`: Cloud provider and infrastructure settings
- `kubernetes`: Cluster configuration
- `database`: Database setup (self-hosted, managed, or external)
- `email`: Email provider configuration
- `security`: TLS/SSL and security settings
- `monitoring`: Prometheus and Grafana setup
- `logging`: Vector logging pipeline configuration
- `performance`: Resource allocation and scaling
- `ai`: AI integration settings
- `advanced`: Terraform backend, backups, and custom values

### Logging Configuration

The logging system uses Vector for centralized log collection from all components. See the `logging` section in [`examples/rulebricks-example.yaml`](../examples/rulebricks-example.yaml) for complete configuration examples.

**Sink Types:**

1. **API Key/Token Based** (no IAM required):
   - `elasticsearch`, `datadog_logs`, `splunk_hec`, `new_relic_logs`
   - Configure with endpoint and API key

2. **Cloud Storage** (IAM setup required):
   - `aws_s3`: Requires IRSA setup via `rulebricks vector setup-s3`
   - `gcp_cloud_storage`: Requires Workload Identity via `rulebricks vector setup-gcs`
   - `azure_blob`: Requires Managed Identity via `rulebricks vector setup-azure`

3. **Other Sinks**:
   - `loki`: Simple endpoint-based configuration
   - `http`: Generic HTTP endpoint with optional auth
   - `console`: Default, outputs to stdout

**Cloud Storage Setup:**
When using cloud storage sinks, set `setup_iam: true` in your configuration to get prompted for automatic IAM setup after deployment. Alternatively, use `rulebricks vector generate-iam-config` for manual setup instructions.

### Secret Management

Certain secrets can be sourced from:
- Environment variables: `env:VAR_NAME`
- Files: `file:/path/to/secret`
- Cloud secret managers (via backend config)

## Troubleshooting

### Common Issues

**Certificate Generation:**
- Ensure domain points to load balancer
- Check Traefik logs for ACME errors
- Verify port 80/443 are accessible

**Resource Constraints:**
- Monitor with `rulebricks status`
- Check node resources: `kubectl top nodes`
- Scale up if needed

### Debug Mode

Enable verbose logging:
```bash
rulebricks deploy -v
```

Check component health:
```bash
kubectl get pods --all-namespaces
kubectl describe pod <pod-name> -n <namespace>
```

## License

This CLI requires a valid Rulebricks license key. Contact support@rulebricks.com for licensing information.

## Support

- **Documentation**: [rulebricks.com/docs](https://rulebricks.com/docs)
- **Issues**: [GitHub Issues](https://github.com/rulebricks/cli/issues)
- **Email**: support@rulebricks.com
