# GCP Cluster Setup

Use these commands to create a minimum GKE cluster that can run Rulebricks without using the Rulebricks CLI Terraform flow. GCP does not have an `eksctl`-style cluster YAML or a concise Bicep equivalent; the most familiar native interface is `gcloud`.

## Files

- `check-gke-prereqs.sh` verifies `gcloud` auth, Application Default Credentials, required APIs, selected-region quota, GKE access, `kubectl`, and Helm.

## Core Cluster Parameters

- Cluster name: `rulebricks-cluster` (`Core cluster parameters` block -> `CLUSTER_NAME`)
- Region / zone: `us-central1` / `us-central1-a` (`Core cluster parameters` block -> `REGION` / `ZONE`)
- Kubernetes version: `1.34` (`Core cluster parameters` block -> `KUBERNETES_VERSION`)
- Node count: `4` (`Core cluster parameters` block -> `NODE_COUNT`)
- Machine type: `c4a-standard-2` (`Core cluster parameters` block -> `MACHINE_TYPE`)
- Disk size (GB): `20` (`Core cluster parameters` block -> `DISK_SIZE`)
- Disk type: `hyperdisk-balanced` (`Core cluster parameters` block -> `DISK_TYPE`)

## Check Access

```bash
gcloud auth login
gcloud config set project <project-id>
gcloud auth application-default login
GCP_REGION=us-central1 bash check-gke-prereqs.sh
```

If API warnings appear, run the suggested `gcloud services enable` commands and wait for enablement to complete.

## Create The Cluster

Set the core cluster parameters. The default example uses `us-central1-a` because it supports C4A ARM64 nodes.

```bash
PROJECT_ID="$(gcloud config get-value project)"
CLUSTER_NAME=rulebricks-cluster
REGION=us-central1
ZONE=us-central1-a
KUBERNETES_VERSION="1.34"
NODE_COUNT=4
MACHINE_TYPE=c4a-standard-2
DISK_SIZE=20
DISK_TYPE=hyperdisk-balanced
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

Create the VPC, subnet, NAT, and internal firewall rule:

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
  --disk-type "$DISK_TYPE" \
  --disk-size "$DISK_SIZE" \
  --scopes cloud-platform \
  --workload-metadata GKE_METADATA \
  --enable-autorepair \
  --enable-autoupgrade \
  --node-labels environment=rulebricks \
  --tags "gke-${CLUSTER_NAME}"
```

Configure kubeconfig:

```bash
gcloud container clusters get-credentials "$CLUSTER_NAME" \
  --region "$REGION" \
  --project "$PROJECT_ID"
```

Use `rulebricks init` with **Use existing Kubernetes cluster** after kubeconfig works.

## Optional Identity Setup

If you use GCS decision-log export, bind the `vector` Kubernetes service account to a Google service account that can write to the bucket:

```bash
NAMESPACE=rulebricks-demo
PROJECT_ID="$(gcloud config get-value project)"
GSA=rulebricks-vector@"$PROJECT_ID".iam.gserviceaccount.com

gcloud iam service-accounts create rulebricks-vector \
  --project "$PROJECT_ID"

gcloud storage buckets add-iam-policy-binding gs://<bucket-name> \
  --member "serviceAccount:$GSA" \
  --role roles/storage.objectCreator

gcloud iam service-accounts add-iam-policy-binding "$GSA" \
  --project "$PROJECT_ID" \
  --role roles/iam.workloadIdentityUser \
  --member "serviceAccount:$PROJECT_ID.svc.id.goog[$NAMESPACE/vector]"
```

Annotate the service account after the Rulebricks namespace exists:

```bash
kubectl annotate serviceaccount vector \
  --namespace "$NAMESPACE" \
  iam.gke.io/gcp-service-account="$GSA"
```

Enter the Google service account email when prompted by the CLI.

## Notes

- The example creates four `c4a-standard-2` ARM64 nodes with `hyperdisk-balanced`, matching the minimum CLI Terraform defaults.
- C4A availability varies by region and zone. If you change `REGION`, choose a `ZONE` where C4A is available.
- Regional GKE clusters can multiply node counts across node locations. This example pins one node location to keep the minimum cluster shape predictable.
