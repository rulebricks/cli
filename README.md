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
    <a href="https://rulebricks.com/docs/private-deployment/quick-start">Full Documentation</a> •
    <a href="https://github.com/rulebricks/charts">App/Vendored Charts</a> •
    <a href="#support">Support</a>
  </p>
</div>

---

The Rulebricks CLI is a powerful deployment and management tool that automates the rapid creation and maintenance of production-ready Rulebricks rule engine clusters. It handles the complete infrastructure lifecycle across multiple cloud providers, from initial setup to ongoing operations. 

- **🌐 Multi-Cloud Support**: Deploy seamlessly to AWS, Azure, or Google Cloud
- **📦 Complete Stack**: Automatically provisions Kubernetes, databases, monitoring, and all required services
- **🔄 Zero-Downtime Upgrades**: Safely upgrade your Rulebricks deployment with rollback capabilities
- **🔒 Enterprise Security**: Built-in TLS/SSL, secrets management, and network security
- **📊 Observability**: Integrated Prometheus, Grafana, and centralized logging
- **⚡ High Performance**: Auto-scaling, Kafka event streaming, and optimized resource utilization

> Under the hood, this is a deployment orchestrator that sequences Helm installs with computed cross-service dependencies. Rather than vendor everything into an umbrella chart or require manual coordination, the CLI calculates configs (Kafka partition counts, service URLs, resource limits) and feeds them between installations. Stateful tracking enables idempotent deploys and supports both fresh infrastructure provisioning and app-only upgrades.

## Prerequisites

You must have a valid Rulebricks license key to deploy using this CLI. You will be requested for this key during project configuration.

The Rulebricks CLI requires the following tools to be installed locally:
- **docker**
- **kubectl**
- **helm**
- **terraform**
- **Cloud CLI** (one of (aws cli + eksctl), (google-cloud-sdk), (azure-cli))
- **Supabase CLI**
  
> The CLI will check for any other required dependencies and provide installation instructions if any are missing.

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

### Commands

| Command | Description |
|---------|-------------|
| `rulebricks init` | Initialize a new project configuration |
| `rulebricks deploy` | Deploy Rulebricks to your cluster |
| `rulebricks destroy` | Remove Rulebricks deployment |
| `rulebricks status` | Show deployment status and health |
| `rulebricks logs [component]` | View component logs |
| `rulebricks upgrade` | Manage version upgrades |

### Troubleshooting

Get CLI help:
```bash
rulebricks <command> --help
```

Enable verbose logging:
```bash
rulebricks deploy --verbose
```

Retry deployment:
```bash
rulebricks destroy
rulebricks deploy --verbose
```

Check component health:
```bash
kubectl get pods --all-namespaces
kubectl describe pod <pod-name> -n <namespace>
```

## License

This CLI requires a valid Rulebricks license key to use. Contact support@rulebricks.com for licensing information.

## Support

- **CLI Documentation**: [rulebricks.com/docs](https://rulebricks.com/docs/private-deployment/quick-start)
- **Issues**: [GitHub Issues](https://github.com/rulebricks/cli/issues)
- **Email**: support@rulebricks.com
