![Banner](./banner.png)

The Rulebricks CLI is a management utility that automates the creation and maintenance of private Rulebricks clusters, helping you deploy Rulebricks in customizable, high-throughput configurations on AWS, GCP, or Azure.

You can choose how much you would like the CLI to automate for you– use it to generate valid configuration values, automate infrastructure provisioning (via Terraform), software deployment (via Helm), or all of the above.

## Installation

```bash
npm install -g @rulebricks/cli
```

Alternatively, try the quick install script (macOS/Linux):

```bash
curl -fsSL https://raw.githubusercontent.com/rulebricks/cli/main/install.sh | bash
```

Standalone binaries are also available on the [Releases page](https://github.com/rulebricks/cli/releases).

## Prerequisites

You must have a valid **Rulebricks license key**
to deploy using this CLI. You will be
requested for this key during project
configuration.

Rulebricks requires TLS. You will require either external-dns on your cluster to automatically add DNS records, or you will need **access** to manually add **DNS records** for the subdomain(s) where you would like to access your private deployment from.

Finally, you will need to have the following tools installed and ready on your machine:

- **Node.js** >= 20
- **kubectl** - Kubernetes CLI
- **Helm** >= 3.0
- **Terraform** >= 1.0 (for infrastructure provisioning)
- Cloud CLI (`aws`, `gcloud`, or `az`) configured for your provider

## Quick Start

```bash
# Configuration wizard (generates values.yaml)
rulebricks init

# Provision and/or deploy to your cluster
rulebricks deploy my-deployment
```

## Commands

| Command                     | Description                            |
| --------------------------- | -------------------------------------- |
| `rulebricks init`           | Interactive setup wizard               |
| `rulebricks deploy [name]`  | Deploy to Kubernetes                   |
| `rulebricks upgrade [name]` | Upgrade to a new version               |
| `rulebricks destroy [name]` | Remove a deployment                    |
| `rulebricks status [name]`  | Show deployment health                 |
| `rulebricks logs [name]`    | Inspect services                       |
| `rulebricks open [name]`    | Open the generated configuration files |

Add `-h` to any command to learn more about its options.

## Notes

There are a uniquely wide variety of customization options this CLI makes available (multi-cloud, hybrid vs. self-hosted database deployment, custom email templates, etc.), and not all combinations have been validated.

If you encounter any issue deploying your private Rulebricks cluster, please [email us](mailto:support@rulebricks.com) or [open an issue](https://github.com/rulebricks/cli/issues) and we will follow up promptly.
