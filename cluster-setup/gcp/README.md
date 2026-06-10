# GCP Cluster Setup

Use these commands to create a compact GKE cluster that can run Rulebricks before installing with the Rulebricks CLI. GCP does not have an `eksctl`-style cluster YAML or a concise Bicep equivalent; the most familiar native interface is `gcloud`.

## Files

- `check-gke-prereqs.sh` verifies `gcloud` auth, Application Default Credentials, required APIs, selected-region quota, GKE access, `kubectl`, and Helm.

## Core Cluster Parameters

- Cluster name: `rulebricks-cluster` (`Core cluster parameters` block -> `CLUSTER_NAME`)
- Region / zone: `us-central1` / `us-central1-a` (`Core cluster parameters` block -> `REGION` / `ZONE`)
- Kubernetes version: `1.34` (`Core cluster parameters` block -> `KUBERNETES_VERSION`)
- Initial node count: `2` (`Core cluster parameters` block -> `NODE_COUNT`)
- Autoscaling range: `2-4` nodes (`Core cluster parameters` block -> `NODE_COUNT` / `MAX_NODE_COUNT`)
- Machine type: `n2-standard-4` (`Core cluster parameters` block -> `MACHINE_TYPE`)
- Disk size (GB): `20` (`Core cluster parameters` block -> `DISK_SIZE`)
- Disk type: `pd-balanced` (`Core cluster parameters` block -> `DISK_TYPE`)

## Check Access

```bash
gcloud auth login
gcloud config set project <project-id>
gcloud auth application-default login
GCP_REGION=us-central1 bash check-gke-prereqs.sh
```

If API warnings appear, run the suggested `gcloud services enable` commands and wait for enablement to complete.

## Create The Cluster

Set the core cluster parameters.

```bash
PROJECT_ID="$(gcloud config get-value project)"
CLUSTER_NAME=rulebricks-cluster
REGION=us-central1
ZONE=us-central1-a
KUBERNETES_VERSION="1.34"
NODE_COUNT=2
MAX_NODE_COUNT=4
MACHINE_TYPE=n2-standard-4
DISK_SIZE=20
DISK_TYPE=pd-balanced
```

Enable required APIs:

```bash
gcloud services enable \
  compute.googleapis.com \
  container.googleapis.com \
  iam.googleapis.com \
  cloudresourcemanager.googleapis.com \
  --project "$PROJECT_ID"
```

Create the VPC, subnet, NAT, and firewall rules:

```bash
gcloud compute networks create "${CLUSTER_NAME}-vpc" \
  --project "$PROJECT_ID" \
  --subnet-mode custom

gcloud compute networks subnets create "${CLUSTER_NAME}-subnet" \
  --project "$PROJECT_ID" \
  --region "$REGION" \
  --network "${CLUSTER_NAME}-vpc" \
  --range 10.0.0.0/16 \
  --secondary-range pods=10.1.0.0/16,services=10.2.0.0/16 \
  --enable-private-ip-google-access

gcloud compute routers create "${CLUSTER_NAME}-router" \
  --project "$PROJECT_ID" \
  --region "$REGION" \
  --network "${CLUSTER_NAME}-vpc"

gcloud compute routers nats create "${CLUSTER_NAME}-nat" \
  --project "$PROJECT_ID" \
  --region "$REGION" \
  --router "${CLUSTER_NAME}-router" \
  --auto-allocate-nat-external-ips \
  --nat-all-subnet-ip-ranges

gcloud compute firewall-rules create "${CLUSTER_NAME}-allow-internal" \
  --project "$PROJECT_ID" \
  --network "${CLUSTER_NAME}-vpc" \
  --allow tcp:0-65535,udp:0-65535,icmp \
  --source-ranges 10.0.0.0/16,10.1.0.0/16,10.2.0.0/16 \
  --target-tags "gke-${CLUSTER_NAME}"

gcloud compute firewall-rules create "${CLUSTER_NAME}-allow-web" \
  --project "$PROJECT_ID" \
  --network "${CLUSTER_NAME}-vpc" \
  --allow tcp:80,tcp:443 \
  --source-ranges 0.0.0.0/0 \
  --target-tags "gke-${CLUSTER_NAME}"
```

Create the GKE cluster:

```bash
gcloud container clusters create "$CLUSTER_NAME" \
  --project "$PROJECT_ID" \
  --region "$REGION" \
  --node-locations "$ZONE" \
  --cluster-version "$KUBERNETES_VERSION" \
  --release-channel regular \
  --network "${CLUSTER_NAME}-vpc" \
  --subnetwork "${CLUSTER_NAME}-subnet" \
  --enable-ip-alias \
  --cluster-secondary-range-name pods \
  --services-secondary-range-name services \
  --enable-private-nodes \
  --master-ipv4-cidr 172.16.0.0/28 \
  --enable-master-authorized-networks \
  --master-authorized-networks 0.0.0.0/0 \
  --workload-pool "${PROJECT_ID}.svc.id.goog" \
  --enable-network-policy \
  --addons HttpLoadBalancing,HorizontalPodAutoscaling,GcePersistentDiskCsiDriver \
  --node-pool rulebricks-nodes \
  --machine-type "$MACHINE_TYPE" \
  --num-nodes "$NODE_COUNT" \
  --enable-autoscaling \
  --min-nodes "$NODE_COUNT" \
  --max-nodes "$MAX_NODE_COUNT" \
  --disk-type "$DISK_TYPE" \
  --disk-size "$DISK_SIZE" \
  --scopes cloud-platform \
  --workload-metadata GKE_METADATA \
  --enable-autorepair \
  --enable-autoupgrade \
  --tags "gke-${CLUSTER_NAME}"
```

Configure kubeconfig:

```bash
gcloud container clusters get-credentials "$CLUSTER_NAME" \
  --region "$REGION" \
  --project "$PROJECT_ID"
```

Use `rulebricks init` after kubeconfig works, then select this cluster from the GCP cluster list.

## Multi-Node Scheduling

The default configuration starts with two 4-vCPU nodes for a simple standalone deployment and can scale out to four nodes. Splitting the baseline across two nodes provides more Kubernetes pod slots than a single large node while keeping the initial 8-vCPU footprint. Rulebricks worker pods use soft scheduling preferences so Kubernetes can place them away from the rest of the deployment when extra nodes are available. No node labels or taints are required.

## Identity Setup (one service account, one bucket)

All Rulebricks data lives in a single GCS bucket; decision logs and database
backups are key prefixes (`decision-logs/`, `db-backups/`) within it. Create one
Google service account and the bucket — this is deployment-independent:

```bash
PROJECT_ID="$(gcloud config get-value project)"
CLUSTER_NAME=rulebricks-cluster
GSA=rulebricks@"$PROJECT_ID".iam.gserviceaccount.com
BUCKET="$CLUSTER_NAME-data"

gcloud iam service-accounts create rulebricks --project "$PROJECT_ID"

# Create the single data bucket and grant read/write/delete (delete is needed so
# the backup job can prune backups older than the retention window).
gcloud storage buckets create "gs://$BUCKET" --project "$PROJECT_ID" --location "$REGION"
gcloud storage buckets add-iam-policy-binding "gs://$BUCKET" \
  --member "serviceAccount:$GSA" \
  --role roles/storage.objectAdmin

# Prometheus remote write to Google Managed Prometheus (skip if unused).
gcloud projects add-iam-policy-binding "$PROJECT_ID" \
  --member "serviceAccount:$GSA" \
  --role roles/monitoring.metricWriter
```

The per-namespace `roles/iam.workloadIdentityUser` bindings (for `vector`,
`<release>-backup`, and `prometheus`) are **created by the Rulebricks CLI at
`rulebricks deploy` time**, since they're namespace-scoped — so this setup stays
generic and one cluster can host many deployments. Enter the Google service
account email (`$GSA`) and the `$BUCKET` name when prompted by the CLI.

## Notes

- The example creates two `n2-standard-4` nodes initially and enables autoscaling up to four nodes. The initial nodes provide 8 vCPU total for the compact Rulebricks cluster shape while avoiding single-node pod density limits.
- If you change `REGION`, choose a `ZONE` where the selected machine type is available.
- Regional GKE clusters can multiply node counts across node locations. This example pins one node location to keep the minimum cluster shape predictable.
- The public web firewall rule allows HTTP and HTTPS to the node pool so Kubernetes LoadBalancer services and cert-manager HTTP-01 validation can receive internet traffic.
