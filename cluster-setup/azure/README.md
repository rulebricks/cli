# Azure Cluster Setup

Use these files to create a minimum AKS cluster that can run Rulebricks without using the Rulebricks CLI Terraform flow.

## Files

- `main.bicep` creates a minimum compatible AKS cluster with ARM64 nodes, Azure CNI, Calico, Standard Load Balancer, Disk CSI, OIDC issuer, and Workload Identity.
- `main.parameters.json` is a sample Bicep parameter file.
- `check-aks-prereqs.sh` verifies Azure CLI login, subscription state, provider registration, selected-region quota, resource group access, `kubectl`, and Helm.

## Core Cluster Parameters

- Cluster name: `rulebricks-cluster` (`main.parameters.json` -> `clusterName`)
- Region: `eastus` (`main.parameters.json` -> `location`)
- Kubernetes version: `1.34` (`main.parameters.json` -> `kubernetesVersion`)
- Node count: `4` (`main.parameters.json` -> `nodeCount`)
- VM size: `Standard_D2ps_v5` (`main.parameters.json` -> `nodeVmSize`)
- Disk size (GB): `20` (`main.parameters.json` -> `osDiskSizeGB`)
- Disk type: `Managed` (`main.parameters.json` -> `osDiskType`)

## Parameter Groups

`main.parameters.json` keeps the core cluster shape first, followed by optional Rulebricks identity settings.

- Core cluster parameters: `clusterName`, `location`, `kubernetesVersion`, `nodeCount`, `nodeVmSize`, `osDiskSizeGB`, `osDiskType`.
- Rulebricks identity parameters: `rulebricksNamespace`, `vectorServiceAccountName`, `prometheusServiceAccountName`, `enableExternalDns`, `dnsZoneResourceGroup`, `enableBlobLogging`, `loggingStorageAccountName`.

## Check Access

```bash
az login
az account set --subscription <subscription-id>
AZURE_LOCATION=eastus bash check-aks-prereqs.sh
```

If provider registration warnings appear, run the suggested `az provider register` commands and wait for registration to complete.

## Create The Cluster

```bash
az group create --name rulebricks-rg --location eastus
az deployment group create \
  --resource-group rulebricks-rg \
  --template-file main.bicep \
  --parameters @main.parameters.json
```

Then configure kubeconfig:

```bash
az aks get-credentials --name rulebricks-cluster --resource-group rulebricks-rg
```

Use `rulebricks init` with **Use existing Kubernetes cluster** after kubeconfig works.

## Notes

- The template creates four `Standard_D2ps_v5` ARM64 nodes, matching the minimum CLI Terraform defaults.
- Set `rulebricksNamespace` in `main.parameters.json` to the namespace the CLI will use, usually `rulebricks-<deployment-name>`, before enabling Workload Identity integrations.
- Azure DNS and Blob role assignments are created in the deployment resource group. If your DNS zone or storage account lives elsewhere, have an Azure admin assign `DNS Zone Contributor` or `Storage Blob Data Contributor` to the emitted managed identity client ID.

The deployment outputs `vectorClientId` and `prometheusClientId`. Enter those client IDs in the CLI when configuring Azure Blob decision logs or Azure Monitor remote write with Workload Identity.

## Fallback Secret-Based Auth

If Workload Identity is not available, Azure Blob decision-log export can use a storage account connection string stored in the Rulebricks namespace:

```bash
kubectl create namespace rulebricks-demo
kubectl create secret generic azure-blob-logs \
  --namespace rulebricks-demo \
  --from-literal=connection-string='<azure-storage-connection-string>'
```

When prompted by the CLI, enter:

```text
azure-blob-logs:connection-string
```

Azure Monitor remote write can also use OAuth client-secret auth as a fallback:

```bash
kubectl create secret generic azure-monitor-oauth \
  --namespace rulebricks-demo \
  --from-literal=client-secret='<client-secret>'
```

When prompted by the CLI, enter:

```text
azure-monitor-oauth:client-secret
```
