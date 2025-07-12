```


           ⟋ ‾‾‾‾⟋|
           ██████  |
           ██████  |
           ██████ ⟋ ‾‾‾⟋|
         ⟋     ⟋██████  |
        ██████   ██████  |
        ██████   ██████⟋
        ██████⟋

         [Rulebricks CLI]

```

<div align="start">
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

This CLI can deploy Rulebricks via Terraform across AWS, Azure, and Google Cloud, and requires a valid Rulebricks license key to use.

### Key Features

- **🌐 Multi-Cloud Support**: Deploy seamlessly to AWS, Azure, or Google Cloud
- **📦 Complete Stack**: Automatically provisions Kubernetes, databases, monitoring, and all required services
- **🔄 Zero-Downtime Upgrades**: Safely upgrade your Rulebricks deployment with rollback capabilities
- **🔒 Enterprise Security**: Built-in TLS/SSL, secrets management, and network security
- **📊 Observability**: Integrated Prometheus, Grafana, and centralized logging
- **⚡ High Performance**: Auto-scaling, Kafka event streaming, and optimized resource utilization

## Prerequisites

The Rulebricks CLI requires the following tools to be installed based on your cloud provider:

### Common Requirements
- **kubectl**: Kubernetes command-line tool
  - macOS: `brew install kubectl`
  - Linux: See [official docs](https://kubernetes.io/docs/tasks/tools/)

### AWS Requirements
For AWS deployments and Vector S3 sink setup:
- **AWS CLI**: AWS command-line interface
  - macOS: `brew install awscli`
  - Linux: See [AWS CLI installation](https://docs.aws.amazon.com/cli/latest/userguide/getting-started-install.html)
- **eksctl**: EKS cluster management tool
  - macOS: `brew tap weaveworks/tap && brew install weaveworks/tap/eksctl`
  - Linux: See [eksctl installation](https://eksctl.io/installation/)

### GCP Requirements
For GCP deployments and Vector GCS sink setup:
- **Google Cloud SDK**: Google Cloud command-line tools
  - macOS: `brew install --cask google-cloud-sdk`
  - Linux: See [Google Cloud SDK installation](https://cloud.google.com/sdk/docs/install)

### Azure Requirements
For Azure deployments and Vector Azure Blob sink setup:
- **Azure CLI**: Azure command-line interface
  - macOS: `brew install azure-cli`
  - Linux: See [Azure CLI installation](https://docs.microsoft.com/en-us/cli/azure/install-azure-cli)

> **Note**: The CLI will check for required dependencies and provide installation instructions if any are missing.

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

> **Note**: Vector setup commands require cloud provider CLI tools to be installed:
> - For S3: `kubectl`, `aws`, and `eksctl`
> - For GCS: `kubectl` and `gcloud`
> - For Azure: `kubectl` and `az`
>
> The CLI will check for these dependencies and provide installation instructions if they're missing.

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
│                        Load Balancer                        │
│                    (Cloud Provider LB)                      │
└────────────────────────────┬────────────────────────────────┘
                             │
┌────────────────────────────┴────────────────────────────────┐
│                     Traefik Ingress                         │
│              (TLS Termination, Routing)                     │
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
- Flexible deployment modes:
  - **Local**: Full Prometheus + Grafana stack in cluster
  - **Remote**: Minimal Prometheus that forwards to external monitoring
  - **Disabled**: No monitoring infrastructure
- Remote write support for:
  - Grafana Cloud
  - New Relic
  - Any Prometheus-compatible endpoint
- Cluster and application metrics
- Custom dashboards (local mode only)

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

## Resource Requirements

### Choose Your Performance Tier

| Tier | Use Case | Expected Load | Total Resources Needed |
|------|----------|---------------|------------------------|
| **Small** | Development/Testing | <100 rules/sec | 2-4 CPUs, 4-8GB RAM, 1-2 nodes |
| **Medium** | Production | 100-1,000 rules/sec | 6-12 CPUs, 12-24GB RAM, 3+ nodes |
| **Large** | High Performance | >1,000 rules/sec | 15+ CPUs, 30+ GB RAM, 5+ nodes |

### What's Running in Your Cluster

**Core Services** (always required):
- **Rulebricks App**: Web interface and API (1-6 replicas)
- **HPS Service**: Rule processing engine (1-8 replicas)
- **HPS Workers**: Background job processors (3-50 replicas)
- **Redis**: Caching layer (single instance)
- **Kafka**: Message queue (1-3 brokers)

**Optional Components**:
- Database (if self-hosting Supabase): 2-4 CPUs, 8-16GB RAM
- Monitoring stack: +2-4 CPUs, +4-16GB RAM

### Auto-Scaling Behavior

- **HPS Service & App**: Scale based on CPU/memory usage (50% CPU, 80% memory targets)
- **Workers**: Scale based on Kafka message backlog (default: 100 messages)
- **Kafka**: Manual scaling - add brokers for high throughput (1 broker per 50MB/s)

### Important Notes

- **ARM processors required** (AWS Graviton, Azure Ampere, GCP Tau)
- Use **c8g/c8gd instances** for CPU-heavy workloads
- Use **spot instances** for workers to save 70-90% on costs
- Plan for 20-30% overhead beyond the minimums listed above

### Quick Start Recommendations

- **Development**: 2x t4g.medium instances
- **Production**: 3x c8g.xlarge instances
- **High Performance**: 5x c8g.2xlarge instances

All resource limits apply per pod/replica, not total across replicas.

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

### Monitoring Configuration

The monitoring system provides flexible deployment options for metrics collection and visualization:

**Deployment Modes:**

1. **Local Mode** (default):
   - Full Prometheus and Grafana stack deployed in your cluster
   - 30-day retention, 50Gi storage
   - Grafana accessible at `https://grafana.{your-domain}`
   - Best for: Development, isolated environments, full control

2. **Remote Mode**:
   - Minimal Prometheus deployment (7-day retention, 10Gi storage)
   - Forwards all metrics to external monitoring system
   - No local Grafana deployment
   - Best for: Production environments with existing monitoring infrastructure

3. **Disabled**:
   - No monitoring infrastructure deployed
   - Choose this if you have alternative monitoring solutions

**Supported Remote Write Destinations:**

- **Grafana Cloud**: Full Prometheus remote write support
- **New Relic**: Native Prometheus integration
- **Generic Prometheus**: Any Prometheus-compatible remote write endpoint
- **Custom**: Configure your own remote write endpoint

**Configuration Example:**

```yaml
monitoring:
  enabled: true
  mode: remote  # or "local"
  remote:
    provider: grafana-cloud
    prometheus_write:
      url: https://prometheus-us-central1.grafana.net/api/prom/push
      username: "123456"
      password_from: env:MONITORING_PASSWORD
      # Optional: Filter metrics to reduce costs
      write_relabel_configs:
        - source_labels: [__name__]
          regex: "kubernetes_.*|node_.*|up|traefik_.*"
          action: keep
```

**Authentication:**
- Credentials are read from environment variables for security
- Basic auth: Set `MONITORING_PASSWORD` environment variable
- Bearer token: Set `MONITORING_TOKEN` environment variable
- New Relic: Set `NEWRELIC_LICENSE_KEY` environment variable

### Secret Management

Certain secrets can be sourced from:
- Environment variables: `env:VAR_NAME`
- Files: `file:/path/to/secret`
- Cloud secret managers (via backend config)

## Troubleshooting

### Common Issues

**Cloud Specifics:**
- Ensure cloud CLI tools are installed and configured
- Azure: ensure quotas are sufficient for resource provisioning
- GCP: ensure billing is enabled on the project and your CLI is freshly authenticated
- GCP: cleaning up resources via `rulebricks destroy` may fail due to Google Cloud adding `deletion_protection` to resources. You can manually remove this protection via the GCP console or from your terraform state.
- AWS: ensure your IAM user has sufficient permissions for EKS, S3, and other resources

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
