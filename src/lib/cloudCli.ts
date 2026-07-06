/**
 * Cloud CLI detection and dynamic resource listing
 *
 * Detects installed cloud CLIs (AWS, GCP, Azure), checks authentication status,
 * and provides functions to list regions, clusters, and storage dynamically.
 */

import { exec } from "child_process";
import { promisify } from "util";
import { CloudProvider, CLOUD_REGIONS } from "../types/index.js";
import { approveCloudCommandOrThrow } from "./commandApproval.js";
import { filterAzureWorkloadIdentities } from "./clusterSetupDefaults.js";

const execAsync = promisify(exec);

// Timeout for CLI commands (in ms)
const CLI_TIMEOUT = 15000;

/**
 * Sort regions by priority order defined in CLOUD_REGIONS.
 * Priority regions come first (in their defined order), followed by
 * any additional regions sorted alphabetically.
 */
function sortRegionsByPriority(
  regions: string[],
  provider: CloudProvider,
): string[] {
  const priorityOrder = CLOUD_REGIONS[provider];
  const prioritySet = new Set(priorityOrder);

  // Separate priority regions from others
  const priorityRegions = priorityOrder.filter((r) => regions.includes(r));
  const otherRegions = regions.filter((r) => !prioritySet.has(r)).sort();

  return [...priorityRegions, ...otherRegions];
}

/**
 * Status of a cloud provider CLI
 */
export interface CloudCliStatus {
  provider: CloudProvider;
  installed: boolean;
  authenticated: boolean;
  version?: string;
  identity?: string; // Account/project/subscription info
  error?: string;
}

/**
 * All cloud CLI statuses
 */
export interface AllCloudCliStatus {
  aws: CloudCliStatus;
  gcp: CloudCliStatus;
  azure: CloudCliStatus;
  anyAvailable: boolean;
  anyInstalled: boolean;
}

/**
 * Managed Kubernetes cluster discovered through a cloud provider CLI.
 */
export interface DiscoveredCluster {
  provider: CloudProvider;
  name: string;
  region: string;
  projectId?: string;
  resourceGroup?: string;
  status?: string;
  version?: string;
  nodeCount?: number;
}

/**
 * AWS IAM role discovered through the AWS CLI.
 */
export interface IamRole {
  name: string;
  arn: string;
}

/**
 * Azure user-assigned managed identity discovered through the Azure CLI.
 */
export interface AzureManagedIdentity {
  name: string;
  clientId: string;
  resourceGroup?: string;
}

/**
 * GCP service account discovered through the gcloud CLI.
 */
export interface GcpServiceAccount {
  email: string;
  displayName?: string;
}

/**
 * Execute a CLI command with timeout
 */
interface ExecCommandOptions {
  timeout?: number;
  intent?: string;
  description?: string;
  provider?: CloudProvider;
  mutating?: boolean;
}

async function execCommand(
  command: string,
  options: ExecCommandOptions | number = {},
): Promise<{ stdout: string; stderr: string }> {
  const opts: ExecCommandOptions =
    typeof options === "number" ? { timeout: options } : options;
  const timeout = opts.timeout ?? CLI_TIMEOUT;

  try {
    await approveCloudCommandOrThrow({
      intent: opts.intent ?? inferCommandIntent(command),
      command,
      description: opts.description,
      provider: opts.provider ?? inferProvider(command),
      mutating: opts.mutating,
    });
    const result = await execAsync(command, { timeout });
    return result;
  } catch (error: unknown) {
    if (error && typeof error === "object" && "stdout" in error) {
      // Command executed but returned non-zero exit code
      const execError = error as {
        stdout?: string;
        stderr?: string;
        message?: string;
      };
      return {
        stdout: execError.stdout || "",
        stderr: execError.stderr || execError.message || "Command failed",
      };
    }
    throw error;
  }
}

function inferProvider(command: string): CloudProvider | undefined {
  if (command.startsWith("aws ")) return "aws";
  if (command.startsWith("gcloud ")) return "gcp";
  if (command.startsWith("az ")) return "azure";
  return undefined;
}

function inferCommandIntent(command: string): string {
  if (
    command.includes("--version") ||
    command.includes("get-caller-identity") ||
    command.includes("gcloud config list") ||
    command.includes("az account show")
  ) {
    return "Detect cloud CLIs";
  }
  if (
    command.includes("describe-regions") ||
    command.includes("compute regions list") ||
    command.includes("list-locations")
  ) {
    return "List available regions";
  }
  if (
    command.includes("eks list-clusters") ||
    command.includes("eks describe-cluster") ||
    command.includes("container clusters list") ||
    command.includes("az aks list")
  ) {
    return "Discover clusters";
  }
  if (
    command.includes("update-kubeconfig") ||
    command.includes("get-credentials")
  ) {
    return "Refresh kubeconfig";
  }
  if (
    command.includes("s3api") ||
    command.includes("storage buckets") ||
    command.includes("storage account") ||
    command.includes("storage container")
  ) {
    return "Discover storage resources";
  }
  if (
    command.includes("iam list-roles") ||
    command.includes("service-accounts list") ||
    command.includes("identity list")
  ) {
    return "List workload identities";
  }
  if (command.includes("amp ") || command.includes("monitor data-collection")) {
    return "Discover monitoring destinations";
  }
  return "Run cloud CLI command";
}

// ============================================================================
// AWS CLI
// ============================================================================

/**
 * Check if AWS CLI is installed and authenticated
 */
export async function checkAwsCli(): Promise<CloudCliStatus> {
  const status: CloudCliStatus = {
    provider: "aws",
    installed: false,
    authenticated: false,
  };

  try {
    // Check if AWS CLI is installed
    const versionResult = await execCommand("aws --version");
    if (versionResult.stderr && !versionResult.stdout) {
      status.error = "AWS CLI not found";
      return status;
    }

    status.installed = true;
    // Extract version (e.g., "aws-cli/2.13.0 Python/3.11.4 ...")
    const versionMatch = versionResult.stdout.match(/aws-cli\/([\d.]+)/);
    status.version = versionMatch ? versionMatch[1] : undefined;

    // Check authentication by getting caller identity
    const identityResult = await execCommand(
      "aws sts get-caller-identity --output json",
    );
    if (
      identityResult.stderr &&
      identityResult.stderr.includes("Unable to locate credentials")
    ) {
      status.error =
        'Not authenticated - run "aws configure" or set credentials';
      return status;
    }

    if (
      identityResult.stderr &&
      identityResult.stderr.includes("ExpiredToken")
    ) {
      status.error = "Session expired - refresh your credentials";
      return status;
    }

    try {
      const identity = JSON.parse(identityResult.stdout);
      status.authenticated = true;
      status.identity = identity.Account
        ? `Account: ${identity.Account}`
        : undefined;
    } catch {
      status.error = "Failed to parse identity response";
    }
  } catch (error) {
    status.error = error instanceof Error ? error.message : "Unknown error";
  }

  return status;
}

/**
 * List available AWS regions
 */
export async function listAwsRegions(): Promise<string[]> {
  try {
    const result = await execCommand(
      'aws ec2 describe-regions --query "Regions[].RegionName" --output json',
    );
    if (result.stderr && !result.stdout) {
      return getStaticAwsRegions();
    }

    const regions = JSON.parse(result.stdout);
    return sortRegionsByPriority(regions, "aws");
  } catch {
    return getStaticAwsRegions();
  }
}

/**
 * List S3 buckets
 */
export async function listS3Buckets(): Promise<string[]> {
  try {
    const result = await execCommand(
      'aws s3api list-buckets --query "Buckets[].Name" --output json',
    );
    if (result.stderr && !result.stdout) {
      return [];
    }

    const buckets = JSON.parse(result.stdout);
    return buckets.sort();
  } catch {
    return [];
  }
}

/**
 * Static fallback for common AWS regions.
 */
function getStaticAwsRegions(): string[] {
  return [
    // US regions
    "us-east-1",
    "us-east-2",
    "us-west-1",
    "us-west-2",
    // Canada
    "ca-central-1",
    "ca-west-1",
    // Europe
    "eu-west-1",
    "eu-west-2",
    "eu-west-3",
    "eu-central-1",
    "eu-central-2",
    "eu-north-1",
    "eu-south-1",
    "eu-south-2",
    // Asia Pacific
    "ap-northeast-1",
    "ap-northeast-2",
    "ap-northeast-3",
    "ap-southeast-1",
    "ap-southeast-2",
    "ap-southeast-3",
    "ap-southeast-4",
    "ap-southeast-5",
    "ap-southeast-7",
    "ap-south-1",
    "ap-south-2",
    "ap-east-1",
    // South America
    "sa-east-1",
    // Middle East & Africa
    "me-south-1",
    "me-central-1",
    "af-south-1",
    "il-central-1",
  ];
}

/**
 * List EKS clusters in a specific region
 */
export async function listEksClusters(region: string): Promise<string[]> {
  try {
    const result = await execCommand(
      `aws eks list-clusters --region ${region} --output json`,
      {
        intent: `Discover clusters in ${region}`,
        provider: "aws",
      },
    );
    if (result.stderr && !result.stdout) {
      return [];
    }

    const response = JSON.parse(result.stdout);
    return (response.clusters || []).sort();
  } catch {
    return [];
  }
}

export type AuroraLogicalReplication = "enabled" | "disabled" | "unknown";

/**
 * Best-effort preflight for an external AWS Aurora Postgres cluster: Supabase
 * Realtime needs logical replication (wal_level=logical), which on Aurora is the
 * STATIC cluster parameter rds.logical_replication - it lives in a custom DB
 * cluster parameter group and needs a reboot, so bootstrap.sql can't set it and
 * Realtime crashloops without it. Parses the cluster id + region from the writer
 * endpoint and reads the attached parameter group. Fails OPEN ("unknown") on any
 * ambiguity (non-Aurora host, denied describe, unexpected value) so it never
 * blocks a deploy spuriously.
 */
export async function checkAuroraLogicalReplication(
  host: string,
  fallbackRegion?: string,
): Promise<{ status: AuroraLogicalReplication; parameterGroup?: string }> {
  // <cluster>.cluster[-ro]-<hash>.<region>.rds.amazonaws.com
  const match =
    /^([^.]+)\.cluster(?:-ro)?-[^.]+\.([^.]+)\.rds\.amazonaws\.com$/i.exec(
      host.trim(),
    );
  if (!match) return { status: "unknown" };
  const clusterId = match[1];
  const region = match[2] || fallbackRegion;
  if (!region) return { status: "unknown" };
  try {
    const pgRes = await execCommand(
      `aws rds describe-db-clusters --db-cluster-identifier ${clusterId} ` +
        `--region ${region} --query "DBClusters[0].DBClusterParameterGroup" --output text`,
      {
        intent: `Check Aurora logical replication (${clusterId})`,
        provider: "aws",
      },
    );
    const parameterGroup = pgRes.stdout.trim();
    if (!parameterGroup || parameterGroup === "None") {
      return { status: "unknown" };
    }
    const valRes = await execCommand(
      `aws rds describe-db-cluster-parameters ` +
        `--db-cluster-parameter-group-name ${parameterGroup} --region ${region} ` +
        `--query "Parameters[?ParameterName=='rds.logical_replication'].ParameterValue | [0]" ` +
        `--output text`,
      { intent: "Read rds.logical_replication", provider: "aws" },
    );
    const value = valRes.stdout.trim();
    if (value === "1") return { status: "enabled", parameterGroup };
    if (value === "0" || value === "" || value === "None") {
      return { status: "disabled", parameterGroup };
    }
    return { status: "unknown", parameterGroup };
  } catch {
    return { status: "unknown" };
  }
}

async function describeEksCluster(
  name: string,
  region: string,
): Promise<DiscoveredCluster | null> {
  try {
    const result = await execCommand(
      `aws eks describe-cluster --name ${name} --region ${region} --query "cluster.{name:name,status:status,version:version}" --output json`,
      {
        intent: `Discover clusters in ${region}`,
        provider: "aws",
      },
    );
    if (result.stderr && !result.stdout) {
      return null;
    }

    const cluster = JSON.parse(result.stdout) as {
      name: string;
      status?: string;
      version?: string;
    };

    if (cluster.status !== "ACTIVE") {
      return null;
    }

    return {
      provider: "aws",
      name: cluster.name,
      region,
      status: cluster.status,
      version: cluster.version,
    };
  } catch {
    return null;
  }
}

/**
 * List EKS clusters across all accessible AWS regions.
 */
export async function listAllEksClusters(): Promise<DiscoveredCluster[]> {
  const regions = await listAwsRegions();
  const clustersByRegion = await Promise.all(
    regions.map(async (region) => {
      const names = await listEksClusters(region);
      return Promise.all(names.map((name) => describeEksCluster(name, region)));
    }),
  );

  return clustersByRegion
    .flat()
    .filter((cluster): cluster is DiscoveredCluster => cluster !== null)
    .sort(
      (a, b) =>
        a.region.localeCompare(b.region) || a.name.localeCompare(b.name),
    );
}

/**
 * Discover active EKS clusters in one region.
 */
export async function discoverEksClustersInRegion(
  region: string,
): Promise<DiscoveredCluster[]> {
  const names = await listEksClusters(region);
  const clusters = await Promise.all(
    names.map((name) => describeEksCluster(name, region)),
  );

  return clusters
    .filter((cluster): cluster is DiscoveredCluster => cluster !== null)
    .sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * List IAM roles for selection (e.g. IRSA roles for S3 / AMP). Returns an empty
 * list on any failure so callers can fall back to manual entry.
 */
export async function listIamRoles(): Promise<IamRole[]> {
  try {
    const result = await execCommand(
      'aws iam list-roles --query "Roles[].{name:RoleName,arn:Arn}" --output json',
    );
    if (result.stderr && !result.stdout) {
      return [];
    }

    const roles = JSON.parse(result.stdout) as IamRole[];
    return roles.sort((a, b) => a.name.localeCompare(b.name));
  } catch {
    return [];
  }
}

/**
 * Get the active AWS account ID (useful for constructing/validating ARNs).
 */
export async function getAwsAccountId(): Promise<string | null> {
  try {
    const result = await execCommand(
      "aws sts get-caller-identity --query Account --output text",
    );
    const accountId = result.stdout.trim();
    return accountId || null;
  } catch {
    return null;
  }
}

// ============================================================================
// GCP CLI (gcloud)
// ============================================================================

/**
 * Check if gcloud CLI is installed and authenticated enough to list clusters.
 */
export async function checkGcloudCli(): Promise<CloudCliStatus> {
  const status: CloudCliStatus = {
    provider: "gcp",
    installed: false,
    authenticated: false,
  };

  try {
    // Check if gcloud is installed
    const versionResult = await execCommand("gcloud --version");
    if (versionResult.stderr && !versionResult.stdout) {
      status.error = "gcloud CLI not found";
      return status;
    }

    status.installed = true;
    // Extract version (e.g., "Google Cloud SDK 440.0.0")
    const versionMatch = versionResult.stdout.match(
      /Google Cloud SDK ([\d.]+)/,
    );
    status.version = versionMatch ? versionMatch[1] : undefined;

    // Check authentication and active project
    const configResult = await execCommand(
      'gcloud config list --format="json"',
    );

    try {
      const config = JSON.parse(configResult.stdout);
      const account = config.core?.account;
      const project = config.core?.project;

      if (!account) {
        status.error = 'Not authenticated - run "gcloud auth login"';
        return status;
      }

      if (!project) {
        status.error =
          'No default project set - run "gcloud config set project PROJECT_ID"';
        return status;
      }

      status.authenticated = true;
      status.identity = `Project: ${project}`;
    } catch {
      status.error = "Failed to parse gcloud config";
    }
  } catch (error) {
    status.error = error instanceof Error ? error.message : "Unknown error";
  }

  return status;
}

/**
 * Get the active GCP project ID
 */
export async function getGcpProjectId(): Promise<string | null> {
  try {
    const result = await execCommand("gcloud config get-value project");
    const projectId = result.stdout.trim();
    return projectId && projectId !== "(unset)" ? projectId : null;
  } catch {
    return null;
  }
}

/**
 * List available GCP regions
 */
export async function listGcpRegions(): Promise<string[]> {
  try {
    const result = await execCommand(
      'gcloud compute regions list --format="json(name)"',
    );
    if (result.stderr && !result.stdout) {
      return getStaticGcpRegions();
    }

    const regions = JSON.parse(result.stdout);
    const regionNames = regions.map((r: { name: string }) => r.name);
    return sortRegionsByPriority(regionNames, "gcp");
  } catch {
    return getStaticGcpRegions();
  }
}

/**
 * List GCS buckets
 */
export async function listGcsBuckets(): Promise<string[]> {
  try {
    const result = await execCommand(
      'gcloud storage buckets list --format="json(name)"',
    );
    if (result.stderr && !result.stdout) {
      return [];
    }

    const buckets = JSON.parse(result.stdout);
    // Bucket names come as "gs://bucket-name", strip the prefix
    return buckets
      .map((b: { name: string }) =>
        b.name.replace("gs://", "").replace(/\/$/, ""),
      )
      .sort();
  } catch {
    return [];
  }
}

/**
 * List GCP service accounts for selection (e.g. for GKE Workload Identity).
 * Returns an empty list on any failure so callers can fall back to manual entry.
 */
export async function listGcpServiceAccounts(): Promise<GcpServiceAccount[]> {
  try {
    const result = await execCommand(
      'gcloud iam service-accounts list --format="json(email,displayName)"',
    );
    if (result.stderr && !result.stdout) {
      return [];
    }

    const accounts = JSON.parse(result.stdout) as Array<{
      email: string;
      displayName?: string;
    }>;
    return accounts
      .map((account) => ({
        email: account.email,
        displayName: account.displayName,
      }))
      .sort((a, b) => a.email.localeCompare(b.email));
  } catch {
    return [];
  }
}

/**
 * Static fallback for common GCP regions.
 */
function getStaticGcpRegions(): string[] {
  return [
    // US regions
    "us-central1",
    "us-east1",
    "us-east4",
    "us-west1",
    "us-west4",
    // North America
    "northamerica-south1",
    // Europe
    "europe-west1",
    "europe-west2",
    "europe-west3",
    "europe-west4",
    "europe-north1",
    // Asia Pacific
    "asia-east1",
    "asia-northeast1",
    "asia-south1",
    "asia-southeast1",
    // Australia
    "australia-southeast2",
  ];
}

/**
 * List GKE clusters in a specific region
 * Note: GKE supports both regional and zonal clusters. We search for regional clusters.
 */
export async function listGkeClusters(region: string): Promise<string[]> {
  try {
    // List clusters in the specified region (includes both regional and zonal clusters in that region)
    const result = await execCommand(
      `gcloud container clusters list --region ${region} --format="json(name)" 2>/dev/null || gcloud container clusters list --filter="location~^${region}" --format="json(name)"`,
      {
        intent: `Discover clusters in ${region}`,
        provider: "gcp",
      },
    );
    if (result.stderr && !result.stdout) {
      return [];
    }

    const clusters = JSON.parse(result.stdout);
    return clusters.map((c: { name: string }) => c.name).sort();
  } catch {
    return [];
  }
}

/**
 * List GKE clusters across the active GCP project.
 */
export async function listAllGkeClusters(): Promise<DiscoveredCluster[]> {
  const projectId = await getGcpProjectId();

  try {
    const result = await execCommand(
      'gcloud container clusters list --format="json(name,location,status,currentMasterVersion,currentNodeCount)"',
    );
    if (result.stderr && !result.stdout) {
      return [];
    }

    const clusters = JSON.parse(result.stdout) as Array<{
      name: string;
      location: string;
      status?: string;
      currentMasterVersion?: string;
      currentNodeCount?: number;
    }>;

    return clusters
      .filter((cluster) => cluster.status === "RUNNING")
      .map((cluster) => ({
        provider: "gcp" as const,
        name: cluster.name,
        region: cluster.location,
        projectId: projectId || undefined,
        status: cluster.status,
        version: cluster.currentMasterVersion,
        nodeCount: cluster.currentNodeCount,
      }))
      .sort(
        (a, b) =>
          a.region.localeCompare(b.region) || a.name.localeCompare(b.name),
      );
  } catch {
    return [];
  }
}

/**
 * Discover running GKE clusters in a selected region/location.
 */
export async function discoverGkeClustersInRegion(
  region: string,
): Promise<DiscoveredCluster[]> {
  const projectId = await getGcpProjectId();

  try {
    const result = await execCommand(
      `gcloud container clusters list --region ${region} --format="json(name,location,status,currentMasterVersion,currentNodeCount)" 2>/dev/null || gcloud container clusters list --filter="location~^${region}" --format="json(name,location,status,currentMasterVersion,currentNodeCount)"`,
      {
        intent: `Discover clusters in ${region}`,
        provider: "gcp",
      },
    );
    if (result.stderr && !result.stdout) {
      return [];
    }

    const clusters = JSON.parse(result.stdout) as Array<{
      name: string;
      location: string;
      status?: string;
      currentMasterVersion?: string;
      currentNodeCount?: number;
    }>;

    return clusters
      .filter((cluster) => cluster.status === "RUNNING")
      .map((cluster) => ({
        provider: "gcp" as const,
        name: cluster.name,
        region: cluster.location,
        projectId: projectId || undefined,
        status: cluster.status,
        version: cluster.currentMasterVersion,
        nodeCount: cluster.currentNodeCount,
      }))
      .sort((a, b) => a.name.localeCompare(b.name));
  } catch {
    return [];
  }
}

// ============================================================================
// Azure CLI
// ============================================================================

/**
 * Check if Azure CLI is installed and authenticated enough to list clusters.
 */
export async function checkAzureCli(): Promise<CloudCliStatus> {
  const status: CloudCliStatus = {
    provider: "azure",
    installed: false,
    authenticated: false,
  };

  try {
    // Check if az is installed
    const versionResult = await execCommand("az --version");
    if (versionResult.stderr && !versionResult.stdout) {
      status.error = "Azure CLI not found";
      return status;
    }

    status.installed = true;
    // Extract version (e.g., "azure-cli                         2.51.0")
    const versionMatch = versionResult.stdout.match(/azure-cli\s+([\d.]+)/);
    status.version = versionMatch ? versionMatch[1] : undefined;

    const accountResult = await execCommand("az account show --output json");

    if (accountResult.stderr && accountResult.stderr.includes("Please run")) {
      status.error = 'Not authenticated - run "az login"';
      return status;
    }

    let subscriptionName: string | undefined;
    try {
      const account = JSON.parse(accountResult.stdout);
      subscriptionName = account.name;
      
      if (account.state !== "Enabled") {
        status.error = `Subscription "${account.name}" is not enabled (state: ${account.state})`;
        return status;
      }
      
      status.identity = subscriptionName
        ? `Subscription: ${subscriptionName}`
        : undefined;
    } catch {
      status.error = "Failed to parse account info";
      return status;
    }

    status.authenticated = true;
  } catch (error) {
    status.error = error instanceof Error ? error.message : "Unknown error";
  }

  return status;
}

/**
 * Get the active Azure subscription ID
 */
export async function getAzureSubscriptionId(): Promise<string | null> {
  try {
    const result = await execCommand("az account show --query id --output tsv");
    return result.stdout.trim() || null;
  } catch {
    return null;
  }
}

/**
 * Get the active Azure tenant ID. Used to auto-fill workload-identity tenant
 * fields so users don't have to look it up manually.
 */
export async function getAzureTenantId(): Promise<string | null> {
  try {
    const result = await execCommand(
      "az account show --query tenantId --output tsv",
    );
    return result.stdout.trim() || null;
  } catch {
    return null;
  }
}

/**
 * List Azure user-assigned managed identities for selection (workload identity
 * client IDs). Returns an empty list on any failure so callers can fall back to
 * manual entry.
 */
export async function listAzureManagedIdentities(): Promise<
  AzureManagedIdentity[]
> {
  try {
    const result = await execCommand(
      'az identity list --query "[].{name:name,clientId:clientId,resourceGroup:resourceGroup}" --output json',
    );
    if (result.stderr && !result.stdout) {
      return [];
    }

    const identities = JSON.parse(result.stdout) as AzureManagedIdentity[];
    return identities.sort((a, b) => a.name.localeCompare(b.name));
  } catch {
    return [];
  }
}

/**
 * A Prometheus remote_write target the user can write to, with the full URL
 * pre-assembled so the wizard never has to hand-build it.
 */
export interface RemoteWriteTarget {
  name: string;
  url: string;
}

/**
 * Discovers Azure Monitor Prometheus remote_write targets: every Data Collection
 * Rule that ingests the Microsoft-PrometheusMetrics stream, paired with its Data
 * Collection Endpoint's metrics-ingestion endpoint, assembled into the exact
 * remote_write URL. Works for any DCR the caller can see (not just ones we made).
 */
export async function listAzurePrometheusTargets(): Promise<RemoteWriteTarget[]> {
  try {
    const dceResult = await execCommand(
      'az monitor data-collection endpoint list --query "[].{id:id,endpoint:metricsIngestion.endpoint}" --output json',
    );
    const dces = JSON.parse(dceResult.stdout || "[]") as {
      id: string;
      endpoint?: string;
    }[];
    const endpointById = new Map<string, string>();
    for (const dce of dces) {
      if (dce.id && dce.endpoint) {
        endpointById.set(dce.id.toLowerCase(), dce.endpoint);
      }
    }

    const dcrResult = await execCommand(
      'az monitor data-collection rule list --query "[].{name:name,immutableId:immutableId,dce:dataCollectionEndpointId,streams:dataFlows[].streams[]}" --output json',
    );
    const dcrs = JSON.parse(dcrResult.stdout || "[]") as {
      name: string;
      immutableId?: string;
      dce?: string;
      streams?: string[];
    }[];

    const targets: RemoteWriteTarget[] = [];
    for (const dcr of dcrs) {
      if (!dcr.immutableId || !dcr.dce) continue;
      if (!(dcr.streams || []).includes("Microsoft-PrometheusMetrics")) continue;
      const endpoint = endpointById.get(dcr.dce.toLowerCase());
      if (!endpoint) continue;
      const url = `${endpoint.replace(/\/+$/, "")}/dataCollectionRules/${dcr.immutableId}/streams/Microsoft-PrometheusMetrics/api/v1/write?api-version=2023-04-24`;
      targets.push({ name: dcr.name, url });
    }
    return targets.sort((a, b) => a.name.localeCompare(b.name));
  } catch {
    return [];
  }
}

/**
 * Discovers AWS Managed Prometheus (AMP) workspaces in a region and assembles the
 * remote_write URL (<prometheusEndpoint>api/v1/remote_write) for each.
 */
export async function listAwsPrometheusWorkspaces(
  region: string,
): Promise<RemoteWriteTarget[]> {
  try {
    const listResult = await execCommand(
      `aws amp list-workspaces --region ${region} --query "workspaces[].{id:workspaceId,alias:alias}" --output json`,
    );
    const workspaces = JSON.parse(listResult.stdout || "[]") as {
      id: string;
      alias?: string;
    }[];

    const targets: RemoteWriteTarget[] = [];
    for (const ws of workspaces) {
      const descResult = await execCommand(
        `aws amp describe-workspace --workspace-id ${ws.id} --region ${region} --query "workspace.prometheusEndpoint" --output text`,
      );
      const endpoint = descResult.stdout.trim();
      if (!endpoint || endpoint === "None") continue;
      const url = `${endpoint.replace(/\/+$/, "")}/api/v1/remote_write`;
      targets.push({
        name: ws.alias ? `${ws.alias} (${ws.id})` : ws.id,
        url,
      });
    }
    return targets.sort((a, b) => a.name.localeCompare(b.name));
  } catch {
    return [];
  }
}

/**
 * List available Azure regions (locations)
 */
export async function listAzureRegions(): Promise<string[]> {
  try {
    const result = await execCommand(
      'az account list-locations --query "[].name" --output json',
    );
    if (result.stderr && !result.stdout) {
      return getStaticAzureRegions();
    }

    const regions = JSON.parse(result.stdout);
    return sortRegionsByPriority(regions, "azure");
  } catch {
    return getStaticAzureRegions();
  }
}

/**
 * List Azure storage accounts (containers require a storage account)
 */
export async function listAzureStorageAccounts(): Promise<string[]> {
  try {
    const result = await execCommand(
      'az storage account list --query "[].name" --output json',
    );
    if (result.stderr && !result.stdout) {
      return [];
    }

    const accounts = JSON.parse(result.stdout);
    return accounts.sort();
  } catch {
    return [];
  }
}

/**
 * List Azure blob containers in a storage account
 */
export async function listAzureBlobContainers(
  storageAccount: string,
): Promise<string[]> {
  try {
    const result = await execCommand(
      `az storage container list --account-name ${storageAccount} --auth-mode login --query "[].name" --output json`,
    );
    if (result.stderr && !result.stdout) {
      return [];
    }

    const containers = JSON.parse(result.stdout);
    return containers.sort();
  } catch {
    return [];
  }
}

/**
 * Static fallback for common Azure regions.
 */
function getStaticAzureRegions(): string[] {
  return [
    // US regions
    "eastus",
    "eastus2",
    "westus",
    "westus2",
    "westus3",
    "centralus",
    "northcentralus",
    "southcentralus",
    "westcentralus",
    // Canada
    "canadacentral",
    "canadaeast",
    // South America
    "brazilsouth",
    // Europe
    "northeurope",
    "westeurope",
    "uksouth",
    "ukwest",
    "francecentral",
    "francesouth",
    "germanywestcentral",
    "germanynorth",
    "switzerlandnorth",
    "switzerlandwest",
    "norwayeast",
    "norwaywest",
    "swedencentral",
    "polandcentral",
    // Asia Pacific
    "eastasia",
    "southeastasia",
    "japaneast",
    "japanwest",
    "koreacentral",
    "koreasouth",
    // Australia
    "australiaeast",
    "australiasoutheast",
    "australiacentral",
    // India
    "centralindia",
    "southindia",
    "westindia",
    // Middle East & Africa
    "uaenorth",
    "uaecentral",
    "southafricanorth",
    "qatarcentral",
    "israelcentral",
  ];
}

/**
 * List AKS clusters, optionally filtered by resource group
 */
export async function listAksClusters(
  resourceGroup?: string,
): Promise<string[]> {
  try {
    const rgFilter = resourceGroup ? ` --resource-group ${resourceGroup}` : "";
    const result = await execCommand(
      `az aks list${rgFilter} --query "[].name" --output json`,
    );
    if (result.stderr && !result.stdout) {
      return [];
    }

    const clusters = JSON.parse(result.stdout) as string[];
    return clusters.sort();
  } catch {
    return [];
  }
}

/**
 * List AKS clusters across the active Azure subscription.
 */
export async function listAllAksClusters(): Promise<DiscoveredCluster[]> {
  try {
    const result = await execCommand(
      'az aks list --query "[].{name:name,resourceGroup:resourceGroup,location:location,kubernetesVersion:kubernetesVersion,powerState:powerState,agentPoolProfiles:agentPoolProfiles}" --output json',
    );
    if (result.stderr && !result.stdout) {
      return [];
    }

    const clusters = JSON.parse(result.stdout) as Array<{
      name: string;
      resourceGroup?: string;
      location: string;
      kubernetesVersion?: string;
      powerState?: { code?: string };
      agentPoolProfiles?: Array<{ count?: number }>;
    }>;

    return clusters
      .filter((cluster) => cluster.powerState?.code === "Running")
      .map((cluster) => ({
        provider: "azure" as const,
        name: cluster.name,
        region: cluster.location,
        resourceGroup: cluster.resourceGroup,
        status: cluster.powerState?.code,
        version: cluster.kubernetesVersion,
        nodeCount: cluster.agentPoolProfiles?.reduce(
          (sum, pool) => sum + (pool.count || 0),
          0,
        ),
      }))
      .sort(
        (a, b) =>
          a.region.localeCompare(b.region) || a.name.localeCompare(b.name),
      );
  } catch {
    return [];
  }
}

/**
 * Discover running AKS clusters in a selected Azure location.
 */
export async function discoverAksClustersInRegion(
  region: string,
): Promise<DiscoveredCluster[]> {
  try {
    const result = await execCommand(
      'az aks list --query "[].{name:name,resourceGroup:resourceGroup,location:location,kubernetesVersion:kubernetesVersion,powerState:powerState,agentPoolProfiles:agentPoolProfiles}" --output json',
      {
        intent: `Discover clusters in ${region}`,
        provider: "azure",
      },
    );
    if (result.stderr && !result.stdout) {
      return [];
    }

    const clusters = JSON.parse(result.stdout) as Array<{
      name: string;
      resourceGroup?: string;
      location: string;
      kubernetesVersion?: string;
      powerState?: { code?: string };
      agentPoolProfiles?: Array<{ count?: number }>;
    }>;

    return clusters
      .filter(
        (cluster) =>
          cluster.location === region && cluster.powerState?.code === "Running",
      )
      .map((cluster) => ({
        provider: "azure" as const,
        name: cluster.name,
        region: cluster.location,
        resourceGroup: cluster.resourceGroup,
        status: cluster.powerState?.code,
        version: cluster.kubernetesVersion,
        nodeCount: cluster.agentPoolProfiles?.reduce(
          (sum, pool) => sum + (pool.count || 0),
          0,
        ),
      }))
      .sort((a, b) => a.name.localeCompare(b.name));
  } catch {
    return [];
  }
}

// ============================================================================
// Aggregated Functions
// ============================================================================

/**
 * Check all cloud CLIs in parallel
 */
export async function checkAllCloudClis(): Promise<AllCloudCliStatus> {
  const [aws, gcp, azure] = await Promise.all([
    checkAwsCli(),
    checkGcloudCli(),
    checkAzureCli(),
  ]);

  const anyInstalled = aws.installed || gcp.installed || azure.installed;
  const anyAvailable =
    aws.authenticated || gcp.authenticated || azure.authenticated;

  return { aws, gcp, azure, anyAvailable, anyInstalled };
}

/**
 * List regions for a specific provider
 */
export async function listRegions(provider: CloudProvider): Promise<string[]> {
  switch (provider) {
    case "aws":
      return listAwsRegions();
    case "gcp":
      return listGcpRegions();
    case "azure":
      return listAzureRegions();
    default:
      return [];
  }
}

/**
 * List regions for a provider, falling back to the static CLOUD_REGIONS list
 * when the CLI is unavailable or returns nothing.
 */
export async function listRegionsWithFallback(
  provider: CloudProvider,
): Promise<string[]> {
  try {
    const regions = await listRegions(provider);
    return regions.length > 0 ? regions : CLOUD_REGIONS[provider];
  } catch {
    return CLOUD_REGIONS[provider];
  }
}

/**
 * List Azure user-assigned identities that can plausibly be the Rulebricks
 * workload identity, hiding the ones AKS creates for itself (the kubelet
 * "-agentpool" identity and the control-plane "<cluster>-identity"). Falls back
 * to the unfiltered list when the filter removes everything.
 */
export async function listAzureWorkloadIdentities(
  clusterName?: string,
): Promise<AzureManagedIdentity[]> {
  const identities = await listAzureManagedIdentities();
  // No unfiltered fallback: an empty list drops the user into manual entry,
  // which beats offering an agentpool/control-plane identity that federates
  // fine and then fails at runtime with authorization errors.
  return filterAzureWorkloadIdentities(identities, clusterName);
}

/**
 * List buckets/storage for a specific provider
 */
export async function listBuckets(provider: CloudProvider): Promise<string[]> {
  switch (provider) {
    case "aws":
      return listS3Buckets();
    case "gcp":
      return listGcsBuckets();
    case "azure":
      return listAzureStorageAccounts();
    default:
      return [];
  }
}

/**
 * List Kubernetes clusters for a specific provider
 */
export async function listClusters(
  provider: CloudProvider,
  region: string,
  options?: { azureResourceGroup?: string },
): Promise<string[]> {
  switch (provider) {
    case "aws":
      return listEksClusters(region);
    case "gcp":
      return listGkeClusters(region);
    case "azure":
      return listAksClusters(options?.azureResourceGroup);
    default:
      return [];
  }
}

/**
 * List managed Kubernetes clusters discoverable through a provider CLI.
 */
export async function listManagedClusters(
  provider: CloudProvider,
): Promise<DiscoveredCluster[]> {
  switch (provider) {
    case "aws":
      return listAllEksClusters();
    case "gcp":
      return listAllGkeClusters();
    case "azure":
      return listAllAksClusters();
    default:
      return [];
  }
}

/**
 * List managed Kubernetes clusters discoverable through a provider CLI in a
 * selected region/location. This is used by init to avoid account-wide fan-out.
 */
export async function discoverClustersInRegion(
  provider: CloudProvider,
  region: string,
): Promise<DiscoveredCluster[]> {
  switch (provider) {
    case "aws":
      return discoverEksClustersInRegion(region);
    case "gcp":
      return discoverGkeClustersInRegion(region);
    case "azure":
      return discoverAksClustersInRegion(region);
    default:
      return [];
  }
}

/**
 * Refresh kubeconfig credentials for a selected managed Kubernetes cluster.
 */
export async function updateKubeconfig(
  provider: CloudProvider,
  clusterName: string,
  region: string,
  options: {
    gcpProjectId?: string;
    azureResourceGroup?: string;
  } = {},
): Promise<void> {
  switch (provider) {
    case "aws":
      {
        const result = await execCommand(
          `aws eks update-kubeconfig --name ${clusterName} --region ${region}`,
          {
            timeout: 30000,
            intent: `Refresh kubeconfig for ${clusterName}`,
            provider: "aws",
            mutating: true,
          },
        );
        if (result.stderr && !result.stdout) throw new Error(result.stderr);
      }
      return;
    case "gcp":
      if (!options.gcpProjectId) {
        throw new Error("GCP project ID is required to refresh kubeconfig");
      }
      {
        const result = await execCommand(
          `gcloud container clusters get-credentials ${clusterName} --location ${region} --project ${options.gcpProjectId}`,
          {
            timeout: 30000,
            intent: `Refresh kubeconfig for ${clusterName}`,
            provider: "gcp",
            mutating: true,
          },
        );
        if (result.stderr && !result.stdout) throw new Error(result.stderr);
      }
      return;
    case "azure":
      if (!options.azureResourceGroup) {
        throw new Error("Azure resource group is required to refresh kubeconfig");
      }
      {
        const result = await execCommand(
          `az aks get-credentials --name ${clusterName} --resource-group ${options.azureResourceGroup} --overwrite-existing`,
          {
            timeout: 30000,
            intent: `Refresh kubeconfig for ${clusterName}`,
            provider: "azure",
            mutating: true,
          },
        );
        if (result.stderr && !result.stdout) throw new Error(result.stderr);
      }
      return;
  }
}

/**
 * Get installation URLs for cloud CLIs
 */
export const CLI_INSTALL_URLS: Record<
  CloudProvider,
  { name: string; url: string; installCmd?: string }
> = {
  aws: {
    name: "AWS CLI",
    url: "https://docs.aws.amazon.com/cli/latest/userguide/getting-started-install.html",
    installCmd: "brew install awscli",
  },
  gcp: {
    name: "Google Cloud SDK",
    url: "https://cloud.google.com/sdk/docs/install",
    installCmd: "brew install --cask google-cloud-sdk",
  },
  azure: {
    name: "Azure CLI",
    url: "https://docs.microsoft.com/en-us/cli/azure/install-azure-cli",
    installCmd: "brew install azure-cli",
  },
};

/**
 * Get login commands for cloud CLIs
 */
export const CLI_LOGIN_COMMANDS: Record<CloudProvider, string | string[]> = {
  aws: "aws configure",
  gcp: [
    "gcloud auth login",
    "gcloud config set project PROJECT_ID",
  ],
  azure: [
    "az login",
    "az account set --subscription YOUR_SUBSCRIPTION_ID",
  ],
};

// ============================================================================
// Region-filtered bucket listing
// ============================================================================

/**
 * List S3 buckets in a specific region
 * Note: S3 buckets are global, but we filter by region
 */
export async function listS3BucketsInRegion(region: string): Promise<string[]> {
  try {
    // First get all buckets
    const bucketsResult = await execCommand(
      'aws s3api list-buckets --query "Buckets[].Name" --output json',
    );
    if (bucketsResult.stderr && !bucketsResult.stdout) {
      return [];
    }

    const allBuckets = JSON.parse(bucketsResult.stdout) as string[];

    // Filter by region - check each bucket's region
    const bucketsInRegion: string[] = [];

    for (const bucket of allBuckets) {
      try {
        const locationResult = await execCommand(
          `aws s3api get-bucket-location --bucket ${bucket} --output json`,
          5000,
        );

        if (locationResult.stdout) {
          const location = JSON.parse(locationResult.stdout);
          // null means us-east-1, otherwise it's the region name
          const bucketRegion = location.LocationConstraint || "us-east-1";
          if (bucketRegion === region) {
            bucketsInRegion.push(bucket);
          }
        }
      } catch {
        // Skip buckets we can't access
      }
    }

    return bucketsInRegion.sort();
  } catch {
    return [];
  }
}

/**
 * List GCS buckets in a specific region
 */
export async function listGcsBucketsInRegion(
  region: string,
): Promise<string[]> {
  try {
    // GCS locations can be multi-region (US, EU, ASIA) or single region
    // We'll match on the region name (case-insensitive)
    const result = await execCommand(
      `gcloud storage buckets list --format="json(name,location)"`,
    );

    if (result.stderr && !result.stdout) {
      return [];
    }

    const buckets = JSON.parse(result.stdout) as Array<{
      name: string;
      location: string;
    }>;

    return buckets
      .filter((b) => b.location.toLowerCase() === region.toLowerCase())
      .map((b) => b.name.replace("gs://", "").replace(/\/$/, ""))
      .sort();
  } catch {
    return [];
  }
}

/**
 * List Azure storage accounts in a specific region
 */
export async function listAzureStorageAccountsInRegion(
  region: string,
): Promise<string[]> {
  try {
    const result = await execCommand(
      `az storage account list --query "[?primaryLocation=='${region}'].name" --output json`,
    );

    if (result.stderr && !result.stdout) {
      return [];
    }

    const accounts = JSON.parse(result.stdout) as string[];
    return accounts.sort();
  } catch {
    return [];
  }
}

/**
 * List buckets/storage for a specific provider in a specific region
 */
export async function listBucketsInRegion(
  provider: CloudProvider,
  region: string,
): Promise<string[]> {
  switch (provider) {
    case "aws":
      return listS3BucketsInRegion(region);
    case "gcp":
      return listGcsBucketsInRegion(region);
    case "azure":
      return listAzureStorageAccountsInRegion(region);
    default:
      return [];
  }
}

// ============================================================================
// Managed data services (Redis / Kafka / Postgres)
// ============================================================================
//
// Discovery for the External Services step. Every function is read-only, runs
// through the approval gate, and returns an empty list (or null) on failure so
// manual entry always remains available. Credential fetchers print secrets to
// the CLI process only; the wizard stores them in Kubernetes Secrets.

export interface DiscoveredRedisInstance {
  name: string;
  host: string;
  port: number;
  tls: boolean;
  authEnabled?: boolean;
  /** Azure resource group, needed to fetch access keys. */
  resourceGroup?: string;
  /** AWS Secrets Manager id holding the AUTH token (cluster-setup convention). */
  authSecretId?: string;
}

export interface DiscoveredKafkaCluster {
  name: string;
  /** Bootstrap brokers; empty for MSK until fetched via getMskBootstrapBrokers. */
  brokers: string;
  arn?: string;
  resourceGroup?: string;
}

export interface DiscoveredPostgresInstance {
  name: string;
  host: string;
  port: number;
  database?: string;
  masterUsername?: string;
  /** AWS Secrets Manager ARN of the RDS-managed master password. */
  masterSecretArn?: string;
  engine?: string;
}

/**
 * List ElastiCache Valkey/Redis endpoints (replication groups and serverless
 * caches) in a region.
 */
export async function listElastiCacheInstances(
  region: string,
  clusterName?: string,
): Promise<DiscoveredRedisInstance[]> {
  const instances: DiscoveredRedisInstance[] = [];
  const authSecretId = clusterName ? `${clusterName}/redis-auth` : undefined;

  try {
    const result = await execCommand(
      `aws elasticache describe-replication-groups --region ${region} ` +
        `--query "ReplicationGroups[].{id:ReplicationGroupId,tls:TransitEncryptionEnabled,auth:AuthTokenEnabled,primary:NodeGroups[0].PrimaryEndpoint,configuration:ConfigurationEndpoint}" --output json`,
      { intent: "Discover managed Redis", provider: "aws" },
    );
    const groups = JSON.parse(result.stdout || "[]") as Array<{
      id: string;
      tls?: boolean;
      auth?: boolean;
      primary?: { Address?: string; Port?: number };
      configuration?: { Address?: string; Port?: number };
    }>;
    for (const group of groups) {
      const endpoint = group.configuration ?? group.primary;
      if (!endpoint?.Address) continue;
      instances.push({
        name: group.id,
        host: endpoint.Address,
        port: endpoint.Port ?? 6379,
        tls: group.tls ?? false,
        authEnabled: group.auth ?? false,
        authSecretId,
      });
    }
  } catch {
    // Fall through to serverless caches.
  }

  try {
    const result = await execCommand(
      `aws elasticache describe-serverless-caches --region ${region} ` +
        `--query "ServerlessCaches[].{name:ServerlessCacheName,endpoint:Endpoint}" --output json`,
      { intent: "Discover managed Redis", provider: "aws" },
    );
    const caches = JSON.parse(result.stdout || "[]") as Array<{
      name: string;
      endpoint?: { Address?: string; Port?: number };
    }>;
    for (const cache of caches) {
      if (!cache.endpoint?.Address) continue;
      instances.push({
        name: `${cache.name} (serverless)`,
        host: cache.endpoint.Address,
        port: cache.endpoint.Port ?? 6379,
        tls: true,
        authEnabled: false,
      });
    }
  } catch {
    // Ignore; replication groups may already be listed.
  }

  return instances.sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * List Azure Cache for Redis instances in the subscription.
 */
export async function listAzureRedisInstances(): Promise<
  DiscoveredRedisInstance[]
> {
  try {
    const result = await execCommand(
      'az redis list --query "[].{name:name,host:hostName,port:port,sslPort:sslPort,rg:resourceGroup}" --output json',
      { intent: "Discover managed Redis", provider: "azure" },
    );
    const caches = JSON.parse(result.stdout || "[]") as Array<{
      name: string;
      host: string;
      port?: number;
      sslPort?: number;
      rg?: string;
    }>;
    return caches
      .filter((cache) => cache.host)
      .map((cache) => ({
        name: cache.name,
        host: cache.host,
        port: cache.sslPort ?? cache.port ?? 6380,
        tls: !!cache.sslPort,
        authEnabled: true,
        resourceGroup: cache.rg,
      }))
      .sort((a, b) => a.name.localeCompare(b.name));
  } catch {
    return [];
  }
}

/**
 * List GCP Memorystore Redis instances in a region.
 */
export async function listMemorystoreInstances(
  region: string,
): Promise<DiscoveredRedisInstance[]> {
  try {
    const result = await execCommand(
      `gcloud redis instances list --region ${region} --format="json(name,host,port,transitEncryptionMode,authEnabled)"`,
      { intent: "Discover managed Redis", provider: "gcp" },
    );
    const items = JSON.parse(result.stdout || "[]") as Array<{
      name: string;
      host?: string;
      port?: number;
      transitEncryptionMode?: string;
      authEnabled?: boolean;
    }>;
    return items
      .filter((item) => item.host)
      .map((item) => ({
        name: item.name.split("/").pop() ?? item.name,
        host: item.host as string,
        port: item.port ?? 6379,
        tls: item.transitEncryptionMode === "SERVER_AUTHENTICATION",
        authEnabled: item.authEnabled ?? false,
      }))
      .sort((a, b) => a.name.localeCompare(b.name));
  } catch {
    return [];
  }
}

/**
 * List managed Redis instances for the given provider.
 */
export async function listManagedRedis(
  provider: CloudProvider,
  region: string,
  options: { clusterName?: string } = {},
): Promise<DiscoveredRedisInstance[]> {
  switch (provider) {
    case "aws":
      return listElastiCacheInstances(region, options.clusterName);
    case "azure":
      return listAzureRedisInstances();
    case "gcp":
      return listMemorystoreInstances(region);
    default:
      return [];
  }
}

/**
 * List MSK clusters in a region. Brokers require a second call per cluster
 * (getMskBootstrapBrokers) so listing stays fast.
 */
export async function listMskClusters(
  region: string,
): Promise<DiscoveredKafkaCluster[]> {
  try {
    const result = await execCommand(
      `aws kafka list-clusters-v2 --region ${region} ` +
        `--query "ClusterInfoList[?State=='ACTIVE'].{name:ClusterName,arn:ClusterArn}" --output json`,
      { intent: "Discover managed Kafka", provider: "aws" },
    );
    const clusters = JSON.parse(result.stdout || "[]") as Array<{
      name: string;
      arn: string;
    }>;
    return clusters
      .map((cluster) => ({ name: cluster.name, arn: cluster.arn, brokers: "" }))
      .sort((a, b) => a.name.localeCompare(b.name));
  } catch {
    return [];
  }
}

/**
 * Fetch the IAM bootstrap-broker string for an MSK cluster.
 */
export async function getMskBootstrapBrokers(
  clusterArn: string,
  region: string,
): Promise<string | null> {
  try {
    const result = await execCommand(
      `aws kafka get-bootstrap-brokers --cluster-arn ${clusterArn} --region ${region} --output json`,
      { intent: "Fetch MSK bootstrap brokers", provider: "aws" },
    );
    const parsed = JSON.parse(result.stdout || "{}") as Record<
      string,
      string | undefined
    >;
    return (
      parsed.BootstrapBrokerStringSaslIam ||
      parsed.BootstrapBrokerStringSaslScram ||
      parsed.BootstrapBrokerStringTls ||
      parsed.BootstrapBrokerString ||
      null
    );
  } catch {
    return null;
  }
}

/**
 * List Event Hubs namespaces; the Kafka endpoint is <namespace>:9093.
 */
export async function listEventHubsNamespaces(): Promise<
  DiscoveredKafkaCluster[]
> {
  try {
    const result = await execCommand(
      'az eventhubs namespace list --query "[].{name:name,rg:resourceGroup,host:serviceBusEndpoint}" --output json',
      { intent: "Discover managed Kafka", provider: "azure" },
    );
    const namespaces = JSON.parse(result.stdout || "[]") as Array<{
      name: string;
      rg?: string;
      host?: string;
    }>;
    return namespaces
      .map((ns) => {
        const host = ns.host
          ? new URL(ns.host).hostname
          : `${ns.name}.servicebus.windows.net`;
        return {
          name: ns.name,
          brokers: `${host}:9093`,
          resourceGroup: ns.rg,
        };
      })
      .sort((a, b) => a.name.localeCompare(b.name));
  } catch {
    return [];
  }
}

/**
 * List GCP Managed Service for Apache Kafka clusters in a location.
 */
export async function listGcpKafkaClusters(
  region: string,
): Promise<DiscoveredKafkaCluster[]> {
  try {
    const result = await execCommand(
      `gcloud managed-kafka clusters list --location ${region} --format=json`,
      { intent: "Discover managed Kafka", provider: "gcp" },
    );
    const clusters = JSON.parse(result.stdout || "[]") as Array<{
      name: string;
      bootstrapAddress?: string;
    }>;
    return clusters
      .map((cluster) => ({
        name: cluster.name.split("/").pop() ?? cluster.name,
        brokers: cluster.bootstrapAddress ?? "",
      }))
      .sort((a, b) => a.name.localeCompare(b.name));
  } catch {
    return [];
  }
}

/**
 * List managed Kafka clusters for the given provider.
 */
export async function listManagedKafka(
  provider: CloudProvider,
  region: string,
): Promise<DiscoveredKafkaCluster[]> {
  switch (provider) {
    case "aws":
      return listMskClusters(region);
    case "azure":
      return listEventHubsNamespaces();
    case "gcp":
      return listGcpKafkaClusters(region);
    default:
      return [];
  }
}

/**
 * List Aurora Postgres clusters and standalone RDS Postgres instances.
 */
export async function listRdsPostgresInstances(
  region: string,
): Promise<DiscoveredPostgresInstance[]> {
  const instances: DiscoveredPostgresInstance[] = [];

  try {
    const result = await execCommand(
      `aws rds describe-db-clusters --region ${region} ` +
        `--query "DBClusters[].{id:DBClusterIdentifier,endpoint:Endpoint,port:Port,db:DatabaseName,user:MasterUsername,engine:Engine,secretArn:MasterUserSecret.SecretArn}" --output json`,
      { intent: "Discover managed Postgres", provider: "aws" },
    );
    const clusters = JSON.parse(result.stdout || "[]") as Array<{
      id: string;
      endpoint?: string;
      port?: number;
      db?: string;
      user?: string;
      engine?: string;
      secretArn?: string;
    }>;
    for (const cluster of clusters) {
      if (!cluster.endpoint || !cluster.engine?.includes("postgres")) continue;
      instances.push({
        name: cluster.id,
        host: cluster.endpoint,
        port: cluster.port ?? 5432,
        database: cluster.db || undefined,
        masterUsername: cluster.user || undefined,
        masterSecretArn: cluster.secretArn || undefined,
        engine: cluster.engine,
      });
    }
  } catch {
    // Fall through to standalone instances.
  }

  try {
    const result = await execCommand(
      `aws rds describe-db-instances --region ${region} ` +
        `--query "DBInstances[?!DBClusterIdentifier].{id:DBInstanceIdentifier,endpoint:Endpoint.Address,port:Endpoint.Port,db:DBName,user:MasterUsername,engine:Engine,secretArn:MasterUserSecret.SecretArn}" --output json`,
      { intent: "Discover managed Postgres", provider: "aws" },
    );
    const dbInstances = JSON.parse(result.stdout || "[]") as Array<{
      id: string;
      endpoint?: string;
      port?: number;
      db?: string;
      user?: string;
      engine?: string;
      secretArn?: string;
    }>;
    for (const instance of dbInstances) {
      if (!instance.endpoint || !instance.engine?.includes("postgres")) {
        continue;
      }
      instances.push({
        name: instance.id,
        host: instance.endpoint,
        port: instance.port ?? 5432,
        database: instance.db || undefined,
        masterUsername: instance.user || undefined,
        masterSecretArn: instance.secretArn || undefined,
        engine: instance.engine,
      });
    }
  } catch {
    // Ignore; clusters may already be listed.
  }

  return instances.sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * List Azure Database for PostgreSQL flexible servers.
 */
export async function listAzurePostgresServers(): Promise<
  DiscoveredPostgresInstance[]
> {
  try {
    const result = await execCommand(
      'az postgres flexible-server list --query "[].{name:name,host:fullyQualifiedDomainName,user:administratorLogin}" --output json',
      { intent: "Discover managed Postgres", provider: "azure" },
    );
    const servers = JSON.parse(result.stdout || "[]") as Array<{
      name: string;
      host?: string;
      user?: string;
    }>;
    return servers
      .filter((server) => server.host)
      .map((server) => ({
        name: server.name,
        host: server.host as string,
        port: 5432,
        masterUsername: server.user || undefined,
      }))
      .sort((a, b) => a.name.localeCompare(b.name));
  } catch {
    return [];
  }
}

/**
 * List Cloud SQL Postgres instances with a public address.
 */
export async function listCloudSqlPostgresInstances(): Promise<
  DiscoveredPostgresInstance[]
> {
  try {
    const result = await execCommand(
      'gcloud sql instances list --format="json(name,databaseVersion,ipAddresses)"',
      { intent: "Discover managed Postgres", provider: "gcp" },
    );
    const items = JSON.parse(result.stdout || "[]") as Array<{
      name: string;
      databaseVersion?: string;
      ipAddresses?: Array<{ type?: string; ipAddress?: string }>;
    }>;
    const instances: DiscoveredPostgresInstance[] = [];
    for (const item of items) {
      if (!item.databaseVersion?.startsWith("POSTGRES")) continue;
      const address =
        item.ipAddresses?.find((ip) => ip.type === "PRIVATE")?.ipAddress ??
        item.ipAddresses?.find((ip) => ip.type === "PRIMARY")?.ipAddress;
      if (!address) continue;
      instances.push({
        name: item.name,
        host: address,
        port: 5432,
        engine: item.databaseVersion,
      });
    }
    return instances.sort((a, b) => a.name.localeCompare(b.name));
  } catch {
    return [];
  }
}

/**
 * List managed Postgres instances for the given provider.
 */
export async function listManagedPostgres(
  provider: CloudProvider,
  region: string,
): Promise<DiscoveredPostgresInstance[]> {
  switch (provider) {
    case "aws":
      return listRdsPostgresInstances(region);
    case "azure":
      return listAzurePostgresServers();
    case "gcp":
      return listCloudSqlPostgresInstances();
    default:
      return [];
  }
}

/**
 * Read a Secrets Manager secret. When the value is the RDS-managed JSON
 * ({username, password}), the password field is returned.
 */
export async function getAwsSecretValue(
  secretId: string,
  region: string,
): Promise<string | null> {
  try {
    const result = await execCommand(
      `aws secretsmanager get-secret-value --secret-id "${secretId}" --region ${region} --query SecretString --output text`,
      { intent: "Fetch service credential", provider: "aws" },
    );
    const raw = result.stdout.trim();
    if (!raw || raw === "None") return null;
    try {
      const parsed = JSON.parse(raw) as { password?: string };
      if (typeof parsed.password === "string") return parsed.password;
    } catch {
      // Plain string secret.
    }
    return raw;
  } catch {
    return null;
  }
}

/**
 * Fetch the primary access key for an Azure Cache for Redis instance.
 */
export async function getAzureRedisKey(
  name: string,
  resourceGroup: string,
): Promise<string | null> {
  try {
    const result = await execCommand(
      `az redis list-keys --name ${name} --resource-group ${resourceGroup} --query primaryKey --output tsv`,
      { intent: "Fetch service credential", provider: "azure" },
    );
    return result.stdout.trim() || null;
  } catch {
    return null;
  }
}

/**
 * Fetch the RootManageSharedAccessKey connection string for an Event Hubs
 * namespace (used as the Kafka SASL PLAIN password).
 */
export async function getEventHubsConnectionString(
  namespace: string,
  resourceGroup: string,
): Promise<string | null> {
  try {
    const result = await execCommand(
      `az eventhubs namespace authorization-rule keys list --namespace-name ${namespace} ` +
        `--resource-group ${resourceGroup} --name RootManageSharedAccessKey --query primaryConnectionString --output tsv`,
      { intent: "Fetch service credential", provider: "azure" },
    );
    return result.stdout.trim() || null;
  } catch {
    return null;
  }
}

/**
 * Fetch the AUTH string for a Memorystore Redis instance.
 */
export async function getGcpRedisAuthString(
  name: string,
  region: string,
): Promise<string | null> {
  try {
    const result = await execCommand(
      `gcloud redis instances get-auth-string ${name} --region ${region} --format="value(authString)"`,
      { intent: "Fetch service credential", provider: "gcp" },
    );
    return result.stdout.trim() || null;
  } catch {
    return null;
  }
}
