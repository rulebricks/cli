/**
 * Cloud CLI detection and dynamic resource listing
 *
 * Detects installed cloud CLIs (AWS, GCP, Azure), checks authentication status,
 * and provides functions to list regions, clusters, and storage dynamically.
 */

import { exec } from "child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "util";
import { execa } from "execa";
import {
  CloudProvider,
  CLOUD_REGIONS,
  HELM_CHART_OCI,
  HELM_CHART_OCI_SOURCE,
  MIRRORED_CHART_REPOSITORY,
} from "../types/index.js";
import {
  approveCloudCommandOrThrow,
  CommandDeniedError,
} from "./commandApproval.js";
import { isCloudAuthorizationError } from "./cloudErrors.js";
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
  id?: string;
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

function displayCommandArg(value: string): string {
  return /^[A-Za-z0-9_./:=@+-]+$/.test(value)
    ? value
    : `'${value.replace(/'/g, "'\\''")}'`;
}

async function execCommandArgs(
  file: string,
  args: string[],
  options: ExecCommandOptions | number = {},
): Promise<{ stdout: string; stderr: string }> {
  const opts: ExecCommandOptions =
    typeof options === "number" ? { timeout: options } : options;
  const timeout = opts.timeout ?? CLI_TIMEOUT;
  const command = [file, ...args.map(displayCommandArg)].join(" ");

  try {
    await approveCloudCommandOrThrow({
      intent: opts.intent ?? inferCommandIntent(command),
      command,
      description: opts.description,
      provider: opts.provider ?? inferProvider(command),
      mutating: opts.mutating,
    });
    const result = await execa(file, args, { timeout });
    return { stdout: result.stdout, stderr: result.stderr };
  } catch (error: unknown) {
    if (
      error &&
      typeof error === "object" &&
      ("stdout" in error || "stderr" in error)
    ) {
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
 * Azure Flexible Server counterpart of checkAuroraLogicalReplication - but
 * self-healing. cluster-setup sets wal_level=logical declaratively, yet it is
 * a STATIC parameter that only takes effect after a server restart, which ARM
 * cannot perform. Detect the pending state and perform the restart here: the
 * database is idle on a first deploy, and this is a no-op on every subsequent
 * one. Ambiguous or denied restarts are surfaced so deploy cannot claim the
 * database is ready while Azure still reports a pending static parameter.
 */
export async function ensureAzurePostgresLogicalReplication(
  host: string,
  resourceGroup: string,
): Promise<{
  status: "ok" | "restarted" | "restart-required" | "wrong-value" | "unknown";
  value?: string;
  detail?: string;
}> {
  const serverName = host.split(".")[0];
  if (!serverName || !resourceGroup) return { status: "unknown" };
  try {
    const readParameter = () =>
      execCommandArgs(
        "az",
        [
          "postgres",
          "flexible-server",
          "parameter",
          "show",
          "--resource-group",
          resourceGroup,
          "--server-name",
          serverName,
          "--name",
          "wal_level",
          "--output",
          "json",
        ],
        {
          intent: "Verify database configuration",
          provider: "azure",
          timeout: 60000,
        },
      );
    const res = await readParameter();
    if (!res.stdout.trim()) {
      return {
        status: "unknown",
        detail: res.stderr.trim() || "Azure returned no wal_level state.",
      };
    }
    const parsed = JSON.parse(res.stdout || "{}") as {
      value?: string;
      isConfigPendingRestart?: boolean | string;
    };
    if (!parsed.value) {
      return { status: "unknown", detail: "Azure omitted the wal_level value." };
    }
    if (parsed.value.toLowerCase() !== "logical") {
      return { status: "wrong-value", value: parsed.value };
    }
    const pendingRestart =
      parsed.isConfigPendingRestart === true ||
      String(parsed.isConfigPendingRestart).toLowerCase() === "true";
    if (!pendingRestart) return { status: "ok" };
    const restart = await execCommandArgs(
      "az",
      [
        "postgres",
        "flexible-server",
        "restart",
        "--resource-group",
        resourceGroup,
        "--name",
        serverName,
      ],
      {
        intent: "Restart managed database",
        provider: "azure",
        mutating: true,
        // HA servers take a few minutes to fail over and come back.
        timeout: 600000,
      },
    );
    if (restart.stderr.trim()) {
      return {
        status: "restart-required",
        value: parsed.value,
        detail: restart.stderr.trim(),
      };
    }
    const afterRestart = await readParameter();
    if (!afterRestart.stdout.trim()) {
      return {
        status: "restart-required",
        value: parsed.value,
        detail:
          afterRestart.stderr.trim() ||
          "The CLI could not confirm that the pending restart cleared.",
      };
    }
    const confirmed = JSON.parse(afterRestart.stdout) as {
      isConfigPendingRestart?: boolean | string;
    };
    const stillPending =
      confirmed.isConfigPendingRestart === true ||
      String(confirmed.isConfigPendingRestart).toLowerCase() === "true";
    if (stillPending) {
      return {
        status: "restart-required",
        value: parsed.value,
        detail: "Azure still reports wal_level as pending restart.",
      };
    }
    return { status: "restarted" };
  } catch (error) {
    return {
      status: "unknown",
      detail: error instanceof Error ? error.message : String(error),
    };
  }
}

/** Read-only verification of a custom ACS sender domain and its link. */
export async function checkAcsCustomEmailDomainLinked(
  fromAddress: string,
  resourceGroup: string,
  smtpUsername?: string,
  communicationServiceId?: string,
): Promise<{
  status: "ok" | "not-linked" | "not-verified" | "unknown";
  domain?: string;
  detail?: string;
}> {
  const domain = fromAddress.split("@")[1]?.toLowerCase();
  if (!domain || domain.endsWith(".azurecomm.net")) return { status: "ok" };
  try {
    // Modern configs carry the exact resource ID. Legacy composite usernames
    // retain a resource-name fallback.
    const parsedCommunicationService = communicationServiceId
      ? parseAcsCommunicationServiceId(communicationServiceId)
      : null;
    const smtpAcsName =
      parsedCommunicationService?.name ||
      (smtpUsername ? parseAcsSmtpResourceName(smtpUsername) : null);
    let commService = "";
    let commResourceGroup = resourceGroup;
    if (parsedCommunicationService) {
      commService = parsedCommunicationService.name;
      commResourceGroup = parsedCommunicationService.resourceGroup;
    } else if (smtpAcsName) {
      const commRes = await execCommand(
        `az resource list --resource-type Microsoft.Communication/communicationServices --query "[?name=='${smtpAcsName}'].{name:name,resourceGroup:resourceGroup}" --output json`,
        { intent: "Verify email domain", provider: "azure" },
      );
      const matches = JSON.parse(commRes.stdout || "[]") as Array<{
        name?: string;
        resourceGroup?: string;
      }>;
      if (matches[0]?.name && matches[0]?.resourceGroup) {
        commService = matches[0].name;
        commResourceGroup = matches[0].resourceGroup;
      }
    }
    if (!commService) {
      const commRes = await execCommand(
        `az resource list --resource-group ${resourceGroup} --resource-type Microsoft.Communication/communicationServices --query "[0].name" --output tsv`,
        { intent: "Verify email domain", provider: "azure" },
      );
      commService = commRes.stdout.trim();
      commResourceGroup = resourceGroup;
    }
    if (!commService) return { status: "unknown" };

    const linkedArgs = [
      "communication",
      "show",
      "--name",
      commService,
      "--resource-group",
      commResourceGroup,
      "--query",
      "linkedDomains",
      "--output",
      "json",
    ];
    if (parsedCommunicationService) {
      linkedArgs.push(
        "--subscription",
        parsedCommunicationService.subscriptionId,
      );
    }
    const linkedRes = await execCommandArgs("az", linkedArgs, {
      intent: "Verify email domain",
      provider: "azure",
    });
    let linked: string[] = [];
    try {
      linked = JSON.parse(linkedRes.stdout || "[]");
    } catch {
      return { status: "unknown" };
    }

    // Already linked: nothing to heal. Matching by the domain segment of the
    // resource ID avoids a lookup round-trip.
    if (
      linked.some(
        (id) => parseAcsEmailDomainId(id)?.domain.toLowerCase() === domain,
      )
    ) {
      return { status: "ok", domain };
    }

    // Locate the email service carrying the sender domain. The services
    // behind the already-linked domains are checked first (the branded domain
    // normally sits next to the azurecomm.net fallback, wherever the
    // prerequisites deployment put them), then the deployment resource
    // group's own email services.
    const candidates: Array<{
      subscriptionId?: string;
      resourceGroup: string;
      name: string;
    }> = [];
    const seenSvc = new Set<string>();
    const addCandidate = (
      rg: string,
      name: string,
      subscriptionId?: string,
    ) => {
      const key = `${subscriptionId || ""}/${rg}/${name}`.toLowerCase();
      if (seenSvc.has(key)) return;
      seenSvc.add(key);
      candidates.push({ subscriptionId, resourceGroup: rg, name });
    };
    for (const id of linked) {
      const parsed = parseAcsEmailDomainId(id);
      if (parsed) {
        addCandidate(
          parsed.resourceGroup,
          parsed.emailService,
          parsed.subscriptionId,
        );
      }
    }
    try {
      const svcRes = await execCommand(
        `az resource list --resource-group ${resourceGroup} --resource-type Microsoft.Communication/emailServices --query "[].name" --output json`,
        { intent: "Verify email domain", provider: "azure" },
      );
      for (const name of JSON.parse(svcRes.stdout || "[]") as string[]) {
        if (name) addCandidate(resourceGroup, name);
      }
    } catch {
      // The deployment resource group may hold no email service at all when
      // the prerequisites live elsewhere; the linked-domain candidates above
      // still stand.
    }
    if (candidates.length === 0) return { status: "unknown" };

    const showDomain = async (): Promise<{
      id?: string;
      resourceGroup?: string;
      emailService?: string;
      verificationStates?: Record<string, { status?: string }>;
    } | null> => {
      for (const svc of candidates) {
        const args = [
          "communication",
          "email",
          "domain",
          "show",
          "--domain-name",
          domain,
          "--email-service-name",
          svc.name,
          "--resource-group",
          svc.resourceGroup,
          "--output",
          "json",
        ];
        if (svc.subscriptionId) {
          args.push("--subscription", svc.subscriptionId);
        }
        const res = await execCommandArgs("az", args, {
          intent: "Verify email domain",
          provider: "azure",
        });
        try {
          const parsed = JSON.parse(res.stdout || "null");
          if (parsed?.id) {
            return {
              ...parsed,
              resourceGroup: svc.resourceGroup,
              emailService: svc.name,
            };
          }
        } catch {
          // Not on this service; try the next candidate.
        }
      }
      return null;
    };
    // The four states that gate linking (DMARC is reported but not required),
    // named as the API reports them - verificationStates keys come back in
    // PascalCase (Domain, SPF, ...), and these same names are what
    // initiate-verification takes as --verification-type. The lookup is
    // case-normalized so an API casing change degrades gracefully instead of
    // reporting a verified domain as forever pending.
    const REQUIRED_CHECKS = ["Domain", "SPF", "DKIM", "DKIM2"];
    const unverified = (info: {
      verificationStates?: Record<string, { status?: string }>;
    }) => {
      const statusByCheck = new Map(
        Object.entries(info.verificationStates ?? {}).map(([key, state]) => [
          key.toLowerCase(),
          state?.status,
        ]),
      );
      return REQUIRED_CHECKS.filter(
        (check) => statusByCheck.get(check.toLowerCase()) !== "Verified",
      );
    };

    const info = await showDomain();
    if (!info?.id) return { status: "unknown" };

    const pendingChecks = unverified(info);
    if (pendingChecks.length > 0) {
      return {
        status: "not-verified",
        domain,
        detail: pendingChecks.join(", "),
      };
    }

    return {
      status: "not-linked",
      domain,
      detail: "The verified domain is not linked to the communication service.",
    };
  } catch (error) {
    return {
      status: "unknown",
      detail: error instanceof Error ? error.message : String(error),
    };
  }
}

export interface AzureAcsResource {
  name: string;
  resourceGroup: string;
  id: string;
}

/**
 * List ACS communication services in the active subscription. Deliberately
 * subscription-wide because enterprise messaging resources often live in a
 * platform-owned resource group.
 */
export async function listAzureAcsResources(): Promise<AzureAcsResource[]> {
  try {
    const res = await execCommand(
      `az resource list --resource-type Microsoft.Communication/communicationServices --query "[].{name:name, resourceGroup:resourceGroup, id:id}" --output json`,
      { intent: "Discover managed email", provider: "azure" },
    );
    const rows = JSON.parse(res.stdout || "[]") as Array<{
      name?: string;
      resourceGroup?: string;
      id?: string;
    }>;
    return rows
      .filter((row) => row.name && row.id)
      .map((row) => ({
        name: row.name!,
        resourceGroup: row.resourceGroup || "",
        id: row.id!,
      }))
      .sort((a, b) => a.name.localeCompare(b.name));
  } catch {
    return [];
  }
}

export interface AzureAcsSmtpUsername {
  name: string;
  username: string;
  entraApplicationId: string;
  tenantId: string;
  status?: string;
  communicationServiceId: string;
}

export function parseAcsCommunicationServiceId(
  id: string,
): { subscriptionId: string; resourceGroup: string; name: string } | null {
  const match = id.match(
    /^\/subscriptions\/([^/]+)\/resourceGroups\/([^/]+)\/providers\/Microsoft\.Communication\/communicationServices\/([^/]+)$/i,
  );
  if (!match) return null;
  return {
    subscriptionId: match[1],
    resourceGroup: match[2],
    name: match[3],
  };
}

/**
 * Discover the modern ACS SMTP Username child resources. The username is
 * user-defined; its Entra application and tenant are authoritative metadata,
 * so the CLI must not synthesize or parse them from the username text.
 */
export async function listAcsSmtpUsernames(
  communicationService: Pick<AzureAcsResource, "id">,
): Promise<AzureAcsSmtpUsername[]> {
  if (!parseAcsCommunicationServiceId(communicationService.id)) return [];
  try {
    const res = await execCommandArgs(
      "az",
      [
        "rest",
        "--method",
        "get",
        "--url",
        `${communicationService.id}/smtpUsernames?api-version=2026-03-18`,
        "--output",
        "json",
      ],
      { intent: "Discover managed email", provider: "azure" },
    );
    if (!res.stdout.trim()) return [];
    const payload = JSON.parse(res.stdout) as {
      value?: Array<{
        name?: string;
        properties?: {
          username?: string;
          entraApplicationId?: string;
          tenantId?: string;
          status?: string;
        };
      }>;
    };
    return (payload.value ?? [])
      .filter(
        (item) =>
          item.name &&
          item.properties?.username &&
          item.properties?.entraApplicationId &&
          item.properties?.tenantId,
      )
      .map((item) => ({
        name: item.name!,
        username: item.properties!.username!,
        entraApplicationId: item.properties!.entraApplicationId!,
        tenantId: item.properties!.tenantId!,
        status: item.properties!.status,
        communicationServiceId: communicationService.id,
      }))
      .sort((a, b) => a.username.localeCompare(b.username));
  } catch {
    return [];
  }
}

/**
 * True when a user-assigned managed identity of the given name exists
 * anywhere in the subscription - used to confirm the cluster-setup
 * external-dns identity is present before the wizard commits to auto-managed
 * DNS. Subscription-wide because the prerequisites template may place the
 * identity in a platform team's resource group, not the deployment's own.
 */
export async function azureManagedIdentityExists(
  name: string,
): Promise<boolean> {
  return Boolean(await findAzureManagedIdentity(name));
}

export async function findAzureManagedIdentity(
  name: string,
): Promise<AzureManagedIdentity | null> {
  if (!name) return null;
  try {
    const res = await execCommandArgs(
      "az",
      [
        "identity",
        "list",
        "--query",
        `[?name=='${name}'] | [0].{id:id,name:name,clientId:clientId,resourceGroup:resourceGroup}`,
        "--output",
        "json",
      ],
      { intent: "Discover DNS zones", provider: "azure" },
    );
    if (!res.stdout.trim()) return null;
    const identity = JSON.parse(res.stdout) as AzureManagedIdentity | null;
    return identity?.id && identity.clientId ? identity : null;
  } catch {
    return null;
  }
}

export interface AzureDnsZoneInfo {
  id: string;
  name: string;
  resourceGroup: string;
  nameServers: string[];
  // True when public NS records for the zone already point at its Azure name
  // servers - i.e. the one-time parent-domain delegation is live.
  delegated: boolean;
}

export function parseAzureDnsZoneId(
  id: string,
): { subscriptionId: string; resourceGroup: string; name: string } | null {
  const match = id.match(
    /^\/subscriptions\/([^/]+)\/resourceGroups\/([^/]+)\/providers\/Microsoft\.Network\/dnsZones\/([^/]+)$/i,
  );
  if (!match) return null;
  return {
    subscriptionId: match[1],
    resourceGroup: match[2],
    name: match[3],
  };
}

export function parseAzureManagedIdentityId(
  id: string,
): { subscriptionId: string; resourceGroup: string; name: string } | null {
  const match = id.match(
    /^\/subscriptions\/([^/]+)\/resourceGroups\/([^/]+)\/providers\/Microsoft\.ManagedIdentity\/userAssignedIdentities\/([^/]+)$/i,
  );
  if (!match) return null;
  return {
    subscriptionId: match[1],
    resourceGroup: match[2],
    name: match[3],
  };
}

async function withAzureDnsDelegation(
  zone: Omit<AzureDnsZoneInfo, "delegated">,
): Promise<AzureDnsZoneInfo> {
  let delegated = false;
  try {
    const { promises: dns } = await import("node:dns");
    const publicNs = await Promise.race([
      dns.resolveNs(zone.name),
      new Promise<string[]>((resolve) =>
        setTimeout(() => resolve([]), 5000).unref?.(),
      ),
    ]);
    const normalized = publicNs.map((name) =>
      name.replace(/\.$/, "").toLowerCase(),
    );
    delegated =
      normalized.length > 0 &&
      zone.nameServers.some((name) => normalized.includes(name));
  } catch {
    delegated = false;
  }
  return { ...zone, delegated };
}

/** Resolve an exact Azure DNS resource ID, including cross-subscription IDs. */
export async function findAzureDnsZoneById(
  dnsZoneId: string,
): Promise<AzureDnsZoneInfo | null> {
  if (!parseAzureDnsZoneId(dnsZoneId)) return null;
  try {
    const result = await execCommandArgs(
      "az",
      [
        "network",
        "dns",
        "zone",
        "show",
        "--ids",
        dnsZoneId,
        "--query",
        "{id:id,name:name,resourceGroup:resourceGroup,nameServers:nameServers}",
        "--output",
        "json",
      ],
      { intent: "Discover DNS zones", provider: "azure" },
    );
    const zone = JSON.parse(result.stdout || "null") as {
      id?: string;
      name?: string;
      resourceGroup?: string;
      nameServers?: string[];
    } | null;
    if (!zone?.id || !zone.name || !zone.resourceGroup) return null;
    return withAzureDnsDelegation({
      id: zone.id,
      name: zone.name.toLowerCase(),
      resourceGroup: zone.resourceGroup,
      nameServers: (zone.nameServers ?? []).map((name) =>
        name.replace(/\.$/, "").toLowerCase(),
      ),
    });
  } catch {
    return null;
  }
}

export async function resolveAzureExternalDnsReferences(
  dnsZoneId: string,
  identityId: string,
): Promise<{
  clientId: string;
  subscriptionId: string;
  resourceGroup: string;
} | null> {
  const zone = parseAzureDnsZoneId(dnsZoneId);
  const identity = parseAzureManagedIdentityId(identityId);
  if (!zone || !identity) return null;
  try {
    const result = await execCommandArgs(
      "az",
      [
        "identity",
        "show",
        "--ids",
        identityId,
        "--query",
        "clientId",
        "--output",
        "tsv",
      ],
      { intent: "Discover DNS zones", provider: "azure" },
    );
    const clientId = result.stdout.trim();
    return clientId
      ? {
          clientId,
          subscriptionId: zone.subscriptionId,
          resourceGroup: zone.resourceGroup,
        }
      : null;
  } catch {
    return null;
  }
}

/**
 * Find the Azure DNS zone that covers `domain` (the zone apex or the nearest
 * parent zone) across the subscription, and report whether its delegation is
 * live. Auto-DNS is VIABLE when this zone plus the external-dns identity
 * exist; delegation being live is what makes it COMPLETE (records resolve,
 * certificates issue). The wizard uses the former to skip the auto/manual
 * question and the latter to show status. Null when no covering zone exists.
 */
export async function findAzureDnsZone(
  domain: string,
): Promise<AzureDnsZoneInfo | null> {
  if (!domain) return null;
  let zones: Array<{ id: string; name: string; resourceGroup: string }>;
  try {
    const res = await execCommand(
      `az network dns zone list --query "[].{id:id,name:name,resourceGroup:resourceGroup}" --output json`,
      { intent: "Discover DNS zones", provider: "azure" },
    );
    zones = JSON.parse(res.stdout || "[]");
  } catch {
    return null;
  }
  // Prefer the most specific covering zone: exact match, else the longest
  // zone name that `domain` is a subdomain of.
  const covering = zones
    .filter(
      (z) =>
        domain === z.name.toLowerCase() ||
        domain.endsWith(`.${z.name.toLowerCase()}`),
    )
    .sort((a, b) => b.name.length - a.name.length)[0];
  if (!covering) return null;

  let nameServers: string[] = [];
  try {
    const res = await execCommandArgs(
      "az",
      [
        "network",
        "dns",
        "zone",
        "show",
        "--ids",
        covering.id,
        "--query",
        "nameServers",
        "--output",
        "json",
      ],
      { intent: "Discover DNS zones", provider: "azure" },
    );
    nameServers = (JSON.parse(res.stdout || "[]") as string[]).map((n) =>
      n.replace(/\.$/, "").toLowerCase(),
    );
  } catch {
    nameServers = [];
  }

  return withAzureDnsDelegation({
    id: covering.id,
    name: covering.name,
    resourceGroup: covering.resourceGroup,
    nameServers,
  });
}

export interface AcsSenderAddress {
  address: string;
  /** True for a customer-managed domain (a branded sender). */
  branded: boolean;
  /**
   * True once ACS has verified ownership of the domain. A branded domain is
   * created by cluster-setup in the NotStarted state and only becomes sendable
   * after the emailInitiateVerificationCommands outputs are run and the DNS
   * records propagate, so this is what separates "offered" from "usable".
   */
  verified: boolean;
}

/**
 * Parse an ACS email-domain resource ID into the coordinates needed to query
 * it. The IDs come from a communication service's linkedDomains and are the
 * one authoritative pointer to where the sender domains actually live - which
 * may be a platform team's resource group, not the deployment's own.
 */
export function parseAcsEmailDomainId(
  id: string,
): {
  subscriptionId: string;
  resourceGroup: string;
  emailService: string;
  domain: string;
} | null {
  const match = id.match(
    /^\/subscriptions\/([^/]+)\/resourceGroups\/([^/]+)\/providers\/Microsoft\.Communication\/emailServices\/([^/]+)\/domains\/([^/]+)$/i,
  );
  if (!match) return null;
  return {
    subscriptionId: match[1],
    resourceGroup: match[2],
    emailService: match[3],
    domain: match[4],
  };
}

/**
 * List the sender addresses available on the deployment's ACS email service.
 * Every provisioned domain has a DoNotReply MailFrom, so the wizard can offer
 * the branded sender (when one was provisioned) and the Azure-managed one as
 * choices instead of asking the operator to type an address.
 *
 * When the communication service is known, its linkedDomains point at the
 * exact email services carrying the senders - including ones in a different
 * resource group (the prerequisites template's, or a central messaging
 * team's). Every domain on those services is offered, not just the linked
 * ones: a branded domain awaiting verification is not linked yet but should
 * still appear (labeled) in the list. Without a communication service, every
 * email service in the resource group is queried as before.
 *
 * Verified addresses sort first, branded ahead of Azure-managed within each
 * group. An unverified branded domain must NOT outrank a working one: the
 * cluster-setup template creates it unverified, and choosing it there makes
 * every send fail with an unhelpful ACS error.
 */
export async function listAcsSenderAddresses(
  resourceGroup: string,
  acsResourceName?: string,
  communicationServiceId?: string,
): Promise<AcsSenderAddress[]> {
  if (!resourceGroup) return [];
  try {
    // (resource group, email service) pairs to pull domains from.
    let emailServices: Array<{
      subscriptionId?: string;
      resourceGroup: string;
      name: string;
    }> = [];

    if (acsResourceName) {
      try {
        const parsedCommunicationService = communicationServiceId
          ? parseAcsCommunicationServiceId(communicationServiceId)
          : null;
        const args = [
          "communication",
          "show",
          "--name",
          parsedCommunicationService?.name || acsResourceName,
          "--resource-group",
          parsedCommunicationService?.resourceGroup || resourceGroup,
          "--query",
          "linkedDomains",
          "--output",
          "json",
        ];
        if (parsedCommunicationService) {
          args.push(
            "--subscription",
            parsedCommunicationService.subscriptionId,
          );
        }
        const linkedRes = await execCommandArgs("az", args, {
          intent: "Discover managed email",
          provider: "azure",
        });
        const linked = JSON.parse(linkedRes.stdout || "[]") as string[];
        const seenSvc = new Set<string>();
        for (const id of linked) {
          const parsed = parseAcsEmailDomainId(id);
          if (!parsed) continue;
          const key = `${parsed.resourceGroup}/${parsed.emailService}`.toLowerCase();
          if (seenSvc.has(key)) continue;
          seenSvc.add(key);
          emailServices.push({
            subscriptionId: parsed.subscriptionId,
            resourceGroup: parsed.resourceGroup,
            name: parsed.emailService,
          });
        }
      } catch {
        emailServices = [];
      }
    }

    if (emailServices.length === 0) {
      const parsedCommunicationService = communicationServiceId
        ? parseAcsCommunicationServiceId(communicationServiceId)
        : null;
      const args = [
        "resource",
        "list",
        "--resource-group",
        parsedCommunicationService?.resourceGroup || resourceGroup,
        "--resource-type",
        "Microsoft.Communication/emailServices",
        "--query",
        "[].name",
        "--output",
        "json",
      ];
      if (parsedCommunicationService) {
        args.push(
          "--subscription",
          parsedCommunicationService.subscriptionId,
        );
      }
      const svcRes = await execCommandArgs("az", args, {
        intent: "Discover managed email",
        provider: "azure",
      });
      // Every email service in the group is queried, not just the first: a
      // resource group holding a second (staging, legacy) email service would
      // otherwise hide the domains of whichever one did not sort first.
      emailServices = (JSON.parse(svcRes.stdout || "[]") as string[])
        .filter(Boolean)
        .map((name) => ({
          subscriptionId: parsedCommunicationService?.subscriptionId,
          resourceGroup:
            parsedCommunicationService?.resourceGroup || resourceGroup,
          name,
        }));
    }
    if (emailServices.length === 0) return [];

    const perService = await Promise.all(
      emailServices.map(async (svc) => {
        try {
          const args = [
            "communication",
            "email",
            "domain",
            "list",
            "--email-service-name",
            svc.name,
            "--resource-group",
            svc.resourceGroup,
            "--output",
            "json",
          ];
          if (svc.subscriptionId) {
            args.push("--subscription", svc.subscriptionId);
          }
          const res = await execCommandArgs("az", args, {
            intent: "Discover managed email",
            provider: "azure",
          });
          return JSON.parse(res.stdout || "[]") as Array<{
            fromSenderDomain?: string;
            domainManagement?: string;
            verificationStates?: { Domain?: { status?: string } };
          }>;
        } catch {
          return [];
        }
      }),
    );

    const seen = new Set<string>();
    return perService
      .flat()
      .filter((d) => d.fromSenderDomain)
      .map((d) => ({
        address: `DoNotReply@${d.fromSenderDomain}`,
        branded: d.domainManagement === "CustomerManaged",
        // Domain ownership is the gate on sending; SPF/DKIM only affect
        // deliverability, so they do not decide usability here.
        verified: d.verificationStates?.Domain?.status === "Verified",
      }))
      .filter((sender) => {
        if (seen.has(sender.address)) return false;
        seen.add(sender.address);
        return true;
      })
      .sort(
        (a, b) =>
          Number(b.verified) - Number(a.verified) ||
          Number(b.branded) - Number(a.branded),
      );
  } catch {
    return [];
  }
}

/** Legacy composite username helper retained for existing deployment configs. */
export function buildAcsSmtpUsername(
  acsResource: string,
  appClientId: string,
  tenantId: string,
): string {
  return `${acsResource}.${appClientId}.${tenantId}`;
}

/** Parse the app ID from a legacy composite ACS SMTP username. */
export function parseAcsSmtpAppClientId(smtpUsername: string): string | null {
  const parts = smtpUsername.split(".");
  if (parts.length < 3) return null;
  const appClientId = parts[1];
  if (!appClientId || appClientId.startsWith("<")) return null;
  return appClientId;
}

/** Parse the ACS resource name from a legacy composite SMTP username. */
export function parseAcsSmtpResourceName(smtpUsername: string): string | null {
  const parts = smtpUsername.split(".");
  if (parts.length < 3) return null;
  const acsResource = parts[0];
  if (!acsResource || acsResource.startsWith("<")) return null;
  return acsResource;
}

export interface AzureEntraApp {
  name: string;
  appId: string;
  redirectUris: string[];
}

function parseEntraApps(json: string): AzureEntraApp[] {
  const rows = JSON.parse(json || "[]") as Array<{
    name?: string;
    appId?: string;
    web?: string[] | null;
    spa?: string[] | null;
  }>;
  return rows
    .filter((row) => row.appId)
    .map((row) => ({
      name: row.name || row.appId!,
      appId: row.appId!,
      redirectUris: [...(row.web ?? []), ...(row.spa ?? [])],
    }));
}

const ENTRA_APP_PROJECTION =
  '"[].{name:displayName, appId:appId, web:web.redirectUris, spa:spa.redirectUris}"';

/**
 * List Entra app registrations so the wizard can offer the SSO app as a
 * selection instead of asking for a pasted client ID. Owned apps are listed
 * first (the operator running the wizard usually created the SSO app), then
 * every other app in the tenant. Both listings always run: an SSO app created
 * by a colleague, by Terraform, or with no owner at all is invisible to
 * --show-mine, and hiding it leaves the operator picking from a list that
 * cannot contain the right answer. The tenant-wide query carries a hard
 * timeout since large tenants can hold thousands of registrations, and either
 * listing may fail independently (no tenant-wide Graph read, for instance)
 * without losing the other. Empty list when both fail so callers fall back to
 * manual entry.
 */
export async function listAzureEntraApps(): Promise<AzureEntraApp[]> {
  const listApps = async (
    scope: "--show-mine" | "--all",
    timeout?: number,
  ): Promise<AzureEntraApp[]> => {
    try {
      const result = await execCommand(
        `az ad app list ${scope} --query ${ENTRA_APP_PROJECTION} --output json`,
        {
          intent: "Discover Entra applications",
          provider: "azure",
          ...(timeout ? { timeout } : {}),
        },
      );
      return parseEntraApps(result.stdout);
    } catch {
      return [];
    }
  };

  const [owned, all] = await Promise.all([
    listApps("--show-mine"),
    listApps("--all", 30000),
  ]);

  const merged: AzureEntraApp[] = [];
  const seen = new Set<string>();
  for (const app of [...owned, ...all]) {
    if (seen.has(app.appId)) continue;
    seen.add(app.appId);
    merged.push(app);
  }
  return merged;
}

/**
 * The redirect URI a native SSO provider's app registration must allow:
 * GoTrue performs the OAuth exchange, so the IdP calls back into Supabase
 * (documented in the chart's values.yaml). A mismatch breaks login with a
 * redirect_uri error at the IdP.
 */
export function expectedSsoRedirectUri(domain: string): string {
  return `https://supabase.${domain.toLowerCase()}/auth/v1/callback`;
}

/** True when one of the registered redirect URIs is the deployment's callback. */
export function hasSsoRedirectUri(
  redirectUris: string[],
  domain: string,
): boolean {
  if (!domain) return false;
  const expected = expectedSsoRedirectUri(domain);
  return redirectUris.some(
    (uri) => uri.toLowerCase().replace(/\/+$/, "") === expected,
  );
}

/**
 * Index of the Entra app most likely to be this deployment's SSO app: exact
 * callback match first, then any redirect URI referencing the deployment
 * domain. -1 when nothing matches.
 */
export function recommendEntraAppIndex(
  apps: Array<Pick<AzureEntraApp, "redirectUris">>,
  domain: string,
): number {
  if (!domain) return -1;
  const exact = apps.findIndex((app) =>
    hasSsoRedirectUri(app.redirectUris, domain),
  );
  if (exact >= 0) return exact;
  const needle = domain.toLowerCase();
  return apps.findIndex((app) =>
    app.redirectUris.some((uri) => uri.toLowerCase().includes(needle)),
  );
}

/**
 * Index of the Entra app most likely to be the ACS email SMTP app. The docs
 * tell operators to create it as "Rulebricks SMTP", so match by display name
 * ("smtp" first, then "rulebricks") - the SMTP app has no redirect URIs to
 * match on. -1 when nothing matches.
 */
export function recommendSmtpAppIndex(
  apps: Array<Pick<AzureEntraApp, "name">>,
): number {
  const smtp = apps.findIndex((app) => /smtp/i.test(app.name));
  if (smtp >= 0) return smtp;
  return apps.findIndex((app) => /rulebricks/i.test(app.name));
}

export const ACS_SMTP_BUILT_IN_ROLE =
  "Communication and Email Service Owner";

export const ACS_SMTP_CUSTOM_ROLE_ACTIONS = [
  "Microsoft.Communication/CommunicationServices/Read",
  "Microsoft.Communication/CommunicationServices/Write",
  "Microsoft.Communication/EmailServices/Write",
] as const;

export type AcsSmtpRoleRequirement = {
  principalId: string;
  scope: string;
  builtInRole: typeof ACS_SMTP_BUILT_IN_ROLE;
  customRoleActions: typeof ACS_SMTP_CUSTOM_ROLE_ACTIONS;
};

export type AcsCommandRunner = (
  file: string,
  args: string[],
  intent: string,
) => Promise<{ stdout: string; stderr: string }>;

const runAcsCommand: AcsCommandRunner = (file, args, intent) =>
  execCommandArgs(file, args, { intent, provider: "azure" });

export interface AcsSmtpContext {
  communicationServiceId?: string;
  entraApplicationId?: string;
}

export async function checkAcsSmtpRoleAssignment(
  smtpUsername: string,
  contextOrRun: AcsSmtpContext | AcsCommandRunner = {},
  injectedRun: AcsCommandRunner = runAcsCommand,
): Promise<{
  status:
    | "ok"
    | "needs-review"
    | "no-app"
    | "no-service-principal"
    | "unknown";
  /** Missing-app/SP statuses carry the application client ID. */
  detail?: string;
  requirement?: AcsSmtpRoleRequirement;
}> {
  const run =
    typeof contextOrRun === "function" ? contextOrRun : injectedRun;
  const context =
    typeof contextOrRun === "function" ? {} : contextOrRun;
  let appClientId =
    context.entraApplicationId || parseAcsSmtpAppClientId(smtpUsername);
  let acsId = context.communicationServiceId || "";
  let requirement: AcsSmtpRoleRequirement | undefined;
  const parsedAcsId = acsId ? parseAcsCommunicationServiceId(acsId) : null;

  // Modern SMTP usernames are free-form child resources. If the caller knows
  // the exact ACS resource but loaded an older config without app metadata,
  // recover the authoritative Entra application from that child.
  if (parsedAcsId && !appClientId) {
    try {
      const usernames = await run(
        "az",
        [
          "rest",
          "--method",
          "get",
          "--url",
          `${acsId}/smtpUsernames?api-version=2026-03-18`,
          "--query",
          `value[?properties.username=='${smtpUsername}'].properties.entraApplicationId | [0]`,
          "--output",
          "tsv",
        ],
        "Verify ACS SMTP access",
      );
      appClientId = usernames.stdout.trim();
    } catch (error) {
      return {
        status: "unknown",
        detail: error instanceof Error ? error.message : String(error),
      };
    }
  }

  // Compatibility for configs created before SMTP Username child resources:
  // their username embedded the ACS name, app ID, and tenant.
  const legacyAcsResource = !acsId
    ? parseAcsSmtpResourceName(smtpUsername)
    : null;
  if (!appClientId || (!parsedAcsId && !legacyAcsResource)) {
    return {
      status: "unknown",
      detail:
        "The SMTP Username is not linked to an ACS resource and Entra application in this configuration.",
    };
  }
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      appClientId,
    ) ||
    (legacyAcsResource &&
      !/^[A-Za-z0-9][A-Za-z0-9-]{0,62}$/.test(legacyAcsResource))
  ) {
    return {
      status: "unknown",
      detail: "The ACS resource name or Entra application ID is invalid.",
    };
  }
  try {
    if (!acsId && legacyAcsResource) {
      const acsRes = await run(
        "az",
        [
          "resource",
          "list",
          "--resource-type",
          "Microsoft.Communication/communicationServices",
          "--query",
          `[?name=='${legacyAcsResource}'].id | [0]`,
          "--output",
          "tsv",
        ],
        "Verify ACS SMTP access",
      );
      acsId = acsRes.stdout.trim();
      if (!acsId) {
        return {
          status: "unknown",
          detail:
            acsRes.stderr.trim() ||
            `Azure Communication Services resource "${legacyAcsResource}" was not found.`,
        };
      }
    }

    const spRes = await run(
      "az",
      [
        "ad",
        "sp",
        "show",
        "--id",
        appClientId,
        "--query",
        "id",
        "--output",
        "tsv",
      ],
      "Verify ACS SMTP access",
    );
    const spObjectId = spRes.stdout.trim();
    if (!spObjectId) {
      const detail = spRes.stderr.trim();
      if (detail && !/does not exist|not found|no service principal/i.test(detail)) {
        return { status: "unknown", detail };
      }
      const appRes = await run(
        "az",
        [
          "ad",
          "app",
          "show",
          "--id",
          appClientId,
          "--query",
          "appId",
          "--output",
          "tsv",
        ],
        "Verify ACS SMTP access",
      );
      if (appRes.stdout.trim()) {
        return { status: "no-service-principal", detail: appClientId };
      }
      const appDetail = appRes.stderr.trim();
      return appDetail &&
        !/does not exist|not found|could not be found/i.test(appDetail)
        ? { status: "unknown", detail: appDetail }
        : { status: "no-app", detail: appClientId };
    }

    requirement = {
      principalId: spObjectId,
      scope: acsId,
      builtInRole: ACS_SMTP_BUILT_IN_ROLE,
      customRoleActions: ACS_SMTP_CUSTOM_ROLE_ACTIONS,
    };

    // Deliberately read-only: Contributor cannot create role assignments, and
    // the documented SMTP grant belongs to the platform owner. An equivalent
    // custom role is also valid, so absence of the built-in role requires
    // review rather than proving that access is missing.
    const existing = await run(
      "az",
      [
        "role",
        "assignment",
        "list",
        "--assignee",
        spObjectId,
        "--scope",
        acsId,
        "--include-inherited",
        "--query",
        `[?roleDefinitionName=='${ACS_SMTP_BUILT_IN_ROLE}'] | length(@)`,
        "--output",
        "tsv",
      ],
      "Verify ACS SMTP access",
    );
    const assignmentCount = existing.stdout.trim();
    if (!assignmentCount) {
      return {
        status: "unknown",
        detail: existing.stderr.trim(),
        requirement,
      };
    }
    if (assignmentCount !== "0") {
      return { status: "ok", requirement };
    }

    return { status: "needs-review", requirement };
  } catch (error) {
    return {
      status: "unknown",
      detail: error instanceof Error ? error.message : String(error),
      ...(requirement ? { requirement } : {}),
    };
  }
}

/**
 * Probe Key Vault DATA-PLANE access from this machine. Secret seeding runs
 * here via `az keyvault secret set`, and enterprise vaults commonly disable
 * public network access (allowKeyVaultPublicAccess=false + private endpoint,
 * the cluster-setup production default). In that posture the deploy would
 * otherwise fail midway through the install with a raw Azure error; this
 * classifies the failure up front so preflight can stop with real guidance.
 * Ambiguous failures return ok so a probe quirk never blocks a deploy that
 * would have succeeded.
 */
export async function checkAzureKeyVaultDataPlaneAccess(
  vaultName: string,
): Promise<{ ok: boolean; reason?: "network" | "rbac"; detail?: string }> {
  const result = await execCommand(
    `az keyvault secret list --vault-name ${vaultName} --maxresults 1 --output none`,
    { intent: "Verify Key Vault access", provider: "azure", timeout: 45000 },
  );
  const stderr = result.stderr || "";
  // az writes nothing on success (--output none); classify failures.
  if (
    /public network access is disabled|not authorized.*(trusted service|ip address)|Connection was closed|ConnectionError|getaddrinfo|connection (refused|timed out)|Firewall/i.test(
      stderr,
    )
  ) {
    return { ok: false, reason: "network", detail: stderr.trim() };
  }
  if (
    /ForbiddenByRbac|AuthorizationFailed|does not have secrets (list|get|set) permission|Caller is not authorized/i.test(
      stderr,
    )
  ) {
    return { ok: false, reason: "rbac", detail: stderr.trim() };
  }
  return { ok: true };
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
      'az identity list --query "[].{id:id,name:name,clientId:clientId,resourceGroup:resourceGroup}" --output json',
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
  // Management plane FIRST. `az storage container list` is a data-plane call,
  // so it fails from anywhere without a network path to the account - and the
  // cluster-setup production default puts storage behind a private endpoint
  // (publicNetworkAccess: Disabled). That made the wizard's container picker
  // silently empty for exactly the posture we recommend. ARM listing needs
  // only reader access on the account and is unaffected by private endpoints.
  try {
    const idResult = await execCommand(
      `az storage account show --name ${storageAccount} --query id --output tsv`,
      { intent: "Discover storage resources", provider: "azure" },
    );
    const accountId = idResult.stdout.trim();
    if (accountId) {
      const result = await execCommand(
        `az rest --method GET --url "https://management.azure.com${accountId}/blobServices/default/containers?api-version=2023-05-01" --query "value[].name" --output json`,
        { intent: "Discover storage resources", provider: "azure" },
      );
      const containers = JSON.parse(result.stdout || "[]");
      if (Array.isArray(containers) && containers.length > 0) {
        return containers.sort();
      }
    }
  } catch {
    // Fall through to the data plane below.
  }

  // Data-plane fallback: covers callers with blob access but no ARM read on
  // the account.
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

export interface AzureContainerRegistry {
  id: string;
  name: string;
  loginServer: string;
  resourceGroup: string;
  sku: string;
}

/**
 * List Azure Container Registries across the subscription. The wizard's
 * image-source step offers the deployment's registry as the image host.
 * Subscription-wide because it may live in another resource group.
 */
export async function listAzureContainerRegistries(): Promise<
  AzureContainerRegistry[]
> {
  try {
    const res = await execCommand(
      `az acr list --query "[].{id:id,name:name,loginServer:loginServer,resourceGroup:resourceGroup,sku:sku.name}" --output json`,
      { intent: "Discover container registries", provider: "azure" },
    );
    const rows = JSON.parse(res.stdout || "[]") as Array<{
      id?: string;
      name?: string;
      loginServer?: string;
      resourceGroup?: string;
      sku?: string;
    }>;
    return rows
      .filter((row) => row.id && row.name && row.loginServer)
      .map((row) => ({
        id: row.id!,
        name: row.name!,
        loginServer: row.loginServer!,
        resourceGroup: row.resourceGroup || "",
        sku: row.sku || "",
      }))
      .sort((a, b) => a.name.localeCompare(b.name));
  } catch {
    return [];
  }
}

/**
 * True when the CLI fully mirrors the deployment's registry - every container
 * image AND the helm chart are imported into it, and helm installs from it.
 * Azure ACR only. Deploy and upgrade share this gate.
 */
export function shouldMirrorToAcr(config: {
  imageRegistryMode?: string;
  imageRegistry?: string;
  infrastructure: { provider?: CloudProvider };
}): boolean {
  return (
    config.imageRegistryMode === "mirror" &&
    Boolean(config.imageRegistry) &&
    config.infrastructure.provider === "azure"
  );
}

/**
 * The chart ref helm installs/upgrades/dry-runs from: the deployment's own
 * fully mirrored registry, or the canonical ghcr.io chart otherwise.
 */
export function chartOciRef(config: {
  imageRegistryMode?: string;
  imageRegistry?: string;
  infrastructure: { provider?: CloudProvider };
}): string {
  return shouldMirrorToAcr(config)
    ? `oci://${config.imageRegistry}/${MIRRORED_CHART_REPOSITORY}`
    : HELM_CHART_OCI;
}

export interface AcrImportSpec {
  /** Source reference on Docker Hub, digest-pinned when the pin is known. */
  source: string;
  /** Repository path inside the registry (rulebricks/<name>). */
  repository: string;
  /** Tag to apply inside the registry. */
  tag: string;
  /** Expected sha256 digest, when the manifest pins one. */
  digest?: string;
  /**
   * Re-import even when the tag already exists. Set for the app-tier tags,
   * which are MUTABLE upstream: Rulebricks republishes hps/hps-worker under
   * the same version tag (the "same-version patch" rulebricks upgrade
   * detects), and a skip-if-present mirror would pin the registry to the
   * stale build forever.
   */
  force?: boolean;
}

/**
 * The full image set a mirrored registry must carry: every chart-manifest pin
 * (imported by digest when one is recorded, so the mirror can never drift
 * from global.imageDigests) plus the app-tier images governed by the selected
 * product version - app and hps at the version tag, and the worker, which is
 * the `worker-<version>` TAG on rulebricks/hps (there is no hps-worker
 * repository). Pure so the plan is testable; mirrorImagesToAcr executes it.
 */
export function planAcrImports(
  entries: Array<{ name: string; tag: string; target?: string; digest?: string }>,
  appVersion?: string,
): AcrImportSpec[] {
  const specs: AcrImportSpec[] = entries.map((entry) => {
    const repository = entry.target || `rulebricks/${entry.name}`;
    return {
      source: entry.digest
        ? `docker.io/${repository}@${entry.digest}`
        : `docker.io/${repository}:${entry.tag}`,
      repository,
      tag: entry.tag,
      ...(entry.digest ? { digest: entry.digest } : {}),
    };
  });
  if (appVersion) {
    const appTier: Array<{ repository: string; tag: string }> = [
      { repository: "rulebricks/app", tag: appVersion },
      { repository: "rulebricks/hps", tag: appVersion },
      { repository: "rulebricks/hps", tag: `worker-${appVersion}` },
    ];
    for (const { repository, tag } of appTier) {
      specs.push({
        source: `docker.io/${repository}:${tag}`,
        repository,
        tag,
        force: true,
      });
    }
  }
  return specs;
}

/**
 * Copy the planned images into an ACR with `az acr import`, so a fully
 * mirrored deployment never pulls from Docker Hub (air-gapped clusters, or
 * egress policies that forbid on-demand upstream pulls). Idempotent: a tag
 * already present with the expected digest (or any digest, when the plan has
 * no pin - release tags are immutable) is skipped; mismatches are re-imported
 * with --force so digest pins in the values always resolve. Source auth is
 * the same Docker Hub PAT the license key backs everywhere else. Failures are
 * collected, not thrown: the caller decides whether missing mirrors block the
 * deploy.
 */
export interface AcrImportFailure {
  ref: string;
  source: string;
  detail?: string;
}

export function formatAcrMirrorFailureMessage(
  registry: string,
  failed: AcrImportFailure[],
  context = "Mirroring images",
): string {
  const registryName = registry.split(".")[0];
  return [
    `${context} into ${registry} failed for:`,
    ...failed.map((failure) =>
      `  - ${failure.ref}${failure.detail ? ` (${failure.detail})` : ""}`,
    ),
    "Ask a registry admin to grant Container Registry Data Importer and Data Reader on the registry, or import them:",
    ...failed.map((failure) => {
      // Docker Hub sources need the license-derived PAT; the ghcr.io chart
      // package is public and imports anonymously.
      const sourceAuth = failure.source.startsWith("docker.io/")
        ? " --username rulebricks --password <Docker PAT derived from your license key>"
        : "";
      return `  az acr import --name ${registryName} --source "${failure.source}" --image "${failure.ref}"${sourceAuth} --force`;
    }),
  ].join("\n");
}

export function assertAcrMirrorSucceeded(
  registry: string,
  result: { failed: AcrImportFailure[] },
  context?: string,
): void {
  if (result.failed.length > 0) {
    throw new Error(
      formatAcrMirrorFailureMessage(registry, result.failed, context),
    );
  }
}

export function parseAzureContainerRegistryId(
  id: string,
): { subscriptionId: string; resourceGroup: string; name: string } | null {
  const match = id.match(
    /^\/subscriptions\/([^/]+)\/resourceGroups\/([^/]+)\/providers\/Microsoft\.ContainerRegistry\/registries\/([^/]+)$/i,
  );
  if (!match) return null;
  return {
    subscriptionId: match[1],
    resourceGroup: match[2],
    name: match[3],
  };
}

async function resolveAzureContainerRegistryId(
  registryName: string,
  configuredResourceId?: string,
): Promise<string> {
  if (configuredResourceId) {
    const parsed = parseAzureContainerRegistryId(configuredResourceId);
    if (!parsed || parsed.name.toLowerCase() !== registryName.toLowerCase()) {
      throw new Error(
        "imageRegistryResourceId must reference the selected Azure Container Registry.",
      );
    }
    return configuredResourceId;
  }
  const result = await execCommandArgs(
    "az",
    [
      "acr",
      "show",
      "--name",
      registryName,
      "--query",
      "id",
      "--output",
      "tsv",
    ],
    { intent: "Discover container registries", provider: "azure" },
  );
  const id = result.stdout.trim();
  if (!id) {
    throw new Error(
      result.stderr.trim() ||
        `Azure Container Registry "${registryName}" was not found.`,
    );
  }
  return id;
}

function acrSubscriptionArgs(resourceId?: string): string[] {
  const parsed = resourceId
    ? parseAzureContainerRegistryId(resourceId)
    : null;
  if (resourceId && !parsed) {
    throw new Error(
      "imageRegistryResourceId must be a full Azure Container Registry resource ID.",
    );
  }
  return parsed ? ["--subscription", parsed.subscriptionId] : [];
}

async function importPrivateImageToAcr(
  registryResourceId: string,
  source: string,
  target: string,
  password: string,
): Promise<{ stdout: string; stderr: string }> {
  const separator = source.indexOf("/");
  if (separator <= 0 || separator === source.length - 1) {
    throw new Error(`Invalid registry source reference: ${source}`);
  }
  const body = {
    source: {
      registryUri: source.slice(0, separator),
      sourceImage: source.slice(separator + 1),
      credentials: {
        username: "rulebricks",
        password,
      },
    },
    targetTags: [target],
    mode: "Force",
  };
  const directory = await mkdtemp(join(tmpdir(), "rulebricks-acr-import-"));
  const bodyPath = join(directory, "request.json");
  try {
    await writeFile(bodyPath, JSON.stringify(body), { mode: 0o600 });
    return await execCommandArgs(
      "az",
      [
        "rest",
        "--method",
        "post",
        "--url",
        `${registryResourceId}/importImage?api-version=2023-11-01-preview`,
        "--body",
        `@${bodyPath}`,
        "--output",
        "none",
      ],
      {
        intent: "Mirror images to registry",
        provider: "azure",
        mutating: true,
        timeout: 600000,
      },
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

export async function mirrorImagesToAcr(
  registryName: string,
  licenseKey: string,
  specs: AcrImportSpec[],
  registryResourceId?: string,
): Promise<{ imported: string[]; skipped: string[]; failed: AcrImportFailure[] }> {
  const { formatDockerPat } = await import("./dockerHub.js");
  const pat = formatDockerPat(licenseKey);
  const imported: string[] = [];
  const skipped: string[] = [];
  const failed: AcrImportFailure[] = [];
  const resolvedRegistryId = await resolveAzureContainerRegistryId(
    registryName,
    registryResourceId,
  );
  const subscriptionArgs = acrSubscriptionArgs(resolvedRegistryId);

  for (const spec of specs) {
    const ref = `${spec.repository}:${spec.tag}`;
    try {
      // Mutable-tag images (force) are always re-imported; the check below
      // would wrongly skip a tag whose upstream content changed.
      if (!spec.force) {
        try {
          const existing = await execCommandArgs(
            "az",
            [
              "acr",
              "manifest",
              "show",
              "--registry",
              registryName,
              "--name",
              ref,
              "--query",
              "digest",
              "--output",
              "tsv",
              ...subscriptionArgs,
            ],
            { intent: "Mirror images to registry", provider: "azure" },
          );
          const currentDigest = existing.stdout.trim();
          if (currentDigest && (!spec.digest || currentDigest === spec.digest)) {
            skipped.push(ref);
            continue;
          }
        } catch {
          // Repository-read access is only an optimization. The import action
          // is authoritative and can still succeed with a narrower custom
          // role, so fall through and import instead of failing pre-emptively.
        }
      }
      const importRes = await importPrivateImageToAcr(
        resolvedRegistryId,
        spec.source,
        ref,
        pat,
      );
      if (importRes.stderr && /error/i.test(importRes.stderr)) {
        failed.push({
          ref,
          source: spec.source,
          detail: importRes.stderr.split("\n")[0],
        });
      } else {
        imported.push(ref);
      }
    } catch (error) {
      failed.push({
        ref,
        source: spec.source,
        detail:
          error instanceof CommandDeniedError
            ? "command approval denied"
            : (error as { message?: string })?.message,
      });
    }
  }
  return { imported, skipped, failed };
}

/**
 * Copy the helm chart OCI artifact for a release into an ACR with
 * `az acr import`, so fully mirrored deployments install the chart from the
 * registry instead of ghcr.io. Chart releases are immutable, so a version
 * already present is skipped. The ghcr.io chart package is public - no
 * source credentials are needed. Same result shape as mirrorImagesToAcr so
 * assertAcrMirrorSucceeded gates both.
 */
export async function mirrorChartToAcr(
  registryName: string,
  chartVersion: string,
  registryResourceId?: string,
): Promise<{ imported: string[]; skipped: string[]; failed: AcrImportFailure[] }> {
  const ref = `${MIRRORED_CHART_REPOSITORY}:${chartVersion}`;
  const source = `${HELM_CHART_OCI_SOURCE}:${chartVersion}`;
  try {
    const resolvedRegistryId = await resolveAzureContainerRegistryId(
      registryName,
      registryResourceId,
    );
    const subscriptionArgs = acrSubscriptionArgs(resolvedRegistryId);
    try {
      const existing = await execCommandArgs(
        "az",
        [
          "acr",
          "manifest",
          "show",
          "--registry",
          registryName,
          "--name",
          ref,
          "--query",
          "digest",
          "--output",
          "tsv",
          ...subscriptionArgs,
        ],
        { intent: "Mirror images to registry", provider: "azure" },
      );
      if (existing.stdout.trim()) {
        return { imported: [], skipped: [ref], failed: [] };
      }
    } catch {
      // Repository-read access is only an optimization. The import action is
      // authoritative, so fall through instead of failing pre-emptively.
    }
    const importRes = await execCommandArgs(
      "az",
      [
        "acr",
        "import",
        "--name",
        registryName,
        "--source",
        source,
        "--image",
        ref,
        "--force",
        "--output",
        "none",
        ...subscriptionArgs,
      ],
      {
        intent: "Mirror images to registry",
        provider: "azure",
        mutating: true,
        timeout: 600000,
      },
    );
    if (importRes.stderr && /error/i.test(importRes.stderr)) {
      return {
        imported: [],
        skipped: [],
        failed: [{ ref, source, detail: importRes.stderr.split("\n")[0] }],
      };
    }
    return { imported: [ref], skipped: [], failed: [] };
  } catch (error) {
    return {
      imported: [],
      skipped: [],
      failed: [
        {
          ref,
          source,
          detail:
            error instanceof CommandDeniedError
              ? "command approval denied"
              : (error as { message?: string })?.message,
        },
      ],
    };
  }
}

/**
 * Log the local helm client into an ACR so it can pull the mirrored chart:
 * helm install/upgrade/dry-run run on the operator machine, which has no
 * kubelet AcrPull identity. `az acr login --expose-token` mints a registry
 * token without needing a docker daemon; helm stores it in its registry
 * config for the rest of the run. Tokens are valid for hours - once per CLI
 * invocation is plenty.
 */
export async function helmRegistryLoginToAcr(
  registryName: string,
  loginServer: string,
  registryResourceId?: string,
): Promise<void> {
  const res = await execCommandArgs(
    "az",
    [
      "acr",
      "login",
      "--name",
      registryName,
      "--expose-token",
      "--output",
      "json",
      ...acrSubscriptionArgs(registryResourceId),
    ],
    { intent: "Mirror images to registry", provider: "azure", timeout: 60000 },
  );
  let token = "";
  try {
    token =
      (JSON.parse(res.stdout || "{}") as { accessToken?: string })
        .accessToken ?? "";
  } catch {
    // Unparseable output falls through to the error below.
  }
  if (!token) {
    throw new Error(
      `Could not obtain an access token for ${loginServer} (az acr login --expose-token). ` +
        "Ensure your Azure identity can pull from the registry (AcrPull, or Container Registry Data Importer and Data Reader)." +
        (res.stderr ? `\nAzure said: ${res.stderr.split("\n")[0]}` : ""),
    );
  }
  // The fixed GUID is ACR's documented username for token-based logins.
  await execa(
    "helm",
    [
      "registry",
      "login",
      loginServer,
      "--username",
      "00000000-0000-0000-0000-000000000000",
      "--password-stdin",
    ],
    { input: token, timeout: 60000 },
  );
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
 * Azure Key Vault discovered through the Azure CLI.
 */
export interface AzureKeyVault {
  name: string;
  uri: string;
  resourceGroup?: string;
}

/**
 * List Key Vaults visible to the logged-in Azure CLI (CLI secrets step).
 */
export async function listAzureKeyVaults(): Promise<AzureKeyVault[]> {
  try {
    const result = await execCommand(
      'az keyvault list --query "[].{name:name, uri:properties.vaultUri, resourceGroup:resourceGroup}" --output json',
      { intent: "Discover Key Vaults", provider: "azure" },
    );
    if (result.stderr && !result.stdout) {
      return [];
    }
    const vaults = JSON.parse(result.stdout) as Array<{
      name: string;
      uri: string | null;
      resourceGroup?: string;
    }>;
    return vaults
      .map((v) => ({
        name: v.name,
        // vaultUri is null in `az keyvault list` for some API versions; the
        // canonical public URI is derivable from the name.
        uri: v.uri || `https://${v.name}.vault.azure.net/`,
        resourceGroup: v.resourceGroup,
      }))
      .sort((a, b) => a.name.localeCompare(b.name));
  } catch {
    return [];
  }
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
        // Entra-RBAC clusters (enableEntraRbac in cluster-setup, the
        // production default): get-credentials writes a kubelogin exec block
        // that defaults to INTERACTIVE device-code login, which hangs every
        // kubectl call this CLI makes. Detect that kubeconfig shape, REQUIRE
        // kubelogin, and convert the exec block to reuse the
        // already-authenticated Azure CLI session. Local-account clusters
        // write plain client-cert kubeconfigs and skip all of this.
        let execPlugin = "";
        try {
          const view = await execa("kubectl", [
            "config",
            "view",
            "--minify",
            "--output",
            "jsonpath={.users[0].user.exec.command}",
          ]);
          execPlugin = view.stdout.trim();
        } catch {
          // Unreadable kubeconfig/context: the cluster access check that
          // follows every refresh will surface it with its own guidance.
        }
        if (execPlugin.includes("kubelogin")) {
          try {
            await execa("kubelogin", ["--version"]);
          } catch {
            throw new Error(
              [
                `Cluster ${clusterName} uses Entra ID RBAC (enableEntraRbac), so kubectl authentication requires kubelogin - which is not installed on this machine.`,
                "  • Install it: brew install Azure/kubelogin/kubelogin (macOS)",
                "  • Other platforms: https://azure.github.io/kubelogin/install.html",
                "  • Then re-run this command.",
              ].join("\n"),
            );
          }
          try {
            await execa("kubelogin", ["convert-kubeconfig", "-l", "azurecli"]);
          } catch {
            // Conversion is best-effort once the binary exists; kubectl will
            // surface any residual auth problem with kubelogin's own hints.
          }
        }
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
  const instances: DiscoveredRedisInstance[] = [];
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
    for (const cache of caches) {
      if (!cache.host) continue;
      instances.push({
        name: cache.name,
        host: cache.host,
        port: cache.sslPort ?? cache.port ?? 6380,
        tls: !!cache.sslPort,
        authEnabled: true,
        resourceGroup: cache.rg,
      });
    }
  } catch {
    // Classic-tier listing failed; Enterprise listing below may still work.
  }
  try {
    // Azure Managed Redis (the cluster-setup template's redis.bicep) is
    // Microsoft.Cache/redisEnterprise - a DIFFERENT resource type that
    // `az redis list` never returns. Databases listen with TLS on 10000.
    // Requires the `redisenterprise` az extension; when absent this fails
    // and the instance can still be entered manually.
    const result = await execCommand(
      'az redisenterprise list --query "[].{name:name,host:hostName,rg:resourceGroup}" --output json',
      { intent: "Discover managed Redis", provider: "azure" },
    );
    const clusters = JSON.parse(result.stdout || "[]") as Array<{
      name: string;
      host: string;
      rg?: string;
    }>;
    for (const cluster of clusters) {
      if (!cluster.host) continue;
      instances.push({
        name: cluster.name,
        host: cluster.host,
        port: 10000,
        tls: true,
        authEnabled: true,
        resourceGroup: cluster.rg,
      });
    }
  } catch {
    // Extension missing or listing failed; classic results (if any) stand.
  }
  return instances.sort((a, b) => a.name.localeCompare(b.name));
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
 * Unwrap a Secrets Manager SecretString to the bare credential. Known JSON
 * envelopes: the RDS-managed {username, password} document, and the
 * cluster-setup ElastiCache document {authToken} (GenerateStringKey:
 * authToken in rulebricks-cluster.cfn.yaml). Passing the raw JSON through -
 * as happened for ElastiCache before authToken was handled here - poisons
 * REDIS_PASSWORD, and every Redis consumer fails with WRONGPASS at runtime.
 */
export function extractSecretCredential(raw: string): string {
  try {
    const parsed = JSON.parse(raw) as {
      password?: string;
      authToken?: string;
    };
    if (typeof parsed.password === "string") return parsed.password;
    if (typeof parsed.authToken === "string") return parsed.authToken;
  } catch {
    // Plain string secret.
  }
  return raw;
}

/**
 * Read a Secrets Manager secret, unwrapping known JSON envelopes
 * (see extractSecretCredential).
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
    return extractSecretCredential(raw);
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
    const key = result.stdout.trim();
    if (key) return key;
  } catch {
    // Fall through to the Enterprise-tier lookup.
  }
  try {
    // Azure Managed Redis (redisEnterprise) keys live on the database
    // resource, under a different command group than classic caches.
    const result = await execCommand(
      `az redisenterprise database list-keys --cluster-name ${name} --resource-group ${resourceGroup} --query primaryKey --output tsv`,
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

// ============================================================================
// Secrets manager seeding (ESO secrets backend)
//
// Secret VALUES never appear in a shell string or process argv: writes run
// through execa (no shell) and stream the value over stdin. The approval
// prompt shows a redacted command. create-if-absent by default so values a
// client rotated in their platform are never clobbered; overwrite=true forces
// an update (deploy --sync-secrets).
// ============================================================================

export interface SecretWriteResult {
  created: boolean;
  updated: boolean;
  skipped: boolean;
  /** Write refused (IAM/RBAC or approval denied). Caller decides; the ESO sync gate is the arbiter of missing entries. */
  denied?: boolean;
}

/**
 * Run a mutating seeding command. Returns denied (instead of throwing) when
 * the user declined the approval or the cloud refused authorization, so
 * seeding fails open: entries pre-seeded by a platform team still sync.
 */
async function approvedExeca(
  displayCommand: string,
  intent: string,
  provider: CloudProvider,
  file: string,
  args: string[],
  input?: string,
): Promise<{ denied: boolean }> {
  try {
    await approveCloudCommandOrThrow({
      command: displayCommand,
      intent,
      provider,
      mutating: true,
    });
    await execa(file, args, input === undefined ? {} : { input });
    return { denied: false };
  } catch (error) {
    if (error instanceof CommandDeniedError) {
      return { denied: true };
    }
    const e = error as { stderr?: string; message?: string };
    if (isCloudAuthorizationError(e.stderr || e.message || "")) {
      return { denied: true };
    }
    throw error;
  }
}

/**
 * Seed one AWS Secrets Manager entry (JSON object per the chart's
 * .secrets.example section).
 */
export async function writeAwsSecretsManagerSecret(options: {
  name: string;
  value: string;
  region: string;
  overwrite: boolean;
}): Promise<SecretWriteResult> {
  const { name, value, region, overwrite } = options;
  const describe = await execCommand(
    `aws secretsmanager describe-secret --secret-id "${name}" --region ${region} --query ARN --output text`,
    { intent: "Check secrets manager entry", provider: "aws" },
  );
  const exists = Boolean(describe.stdout.trim()) && !describe.stderr;

  if (exists && !overwrite) {
    return { created: false, updated: false, skipped: true };
  }
  if (exists) {
    const write = await approvedExeca(
      `aws secretsmanager put-secret-value --secret-id ${name} --region ${region} --secret-string <redacted>`,
      "Update secrets manager entry",
      "aws",
      "aws",
      [
        "secretsmanager",
        "put-secret-value",
        "--secret-id",
        name,
        "--region",
        region,
        "--secret-string",
        "file:///dev/stdin",
      ],
      value,
    );
    if (write.denied) {
      return { created: false, updated: false, skipped: false, denied: true };
    }
    return { created: false, updated: true, skipped: false };
  }
  const write = await approvedExeca(
    `aws secretsmanager create-secret --name ${name} --region ${region} --secret-string <redacted>`,
    "Create secrets manager entry",
    "aws",
    "aws",
    [
      "secretsmanager",
      "create-secret",
      "--name",
      name,
      "--region",
      region,
      "--description",
      "Rulebricks deployment secret (synced into Kubernetes by External Secrets Operator)",
      "--secret-string",
      "file:///dev/stdin",
    ],
    value,
  );
  if (write.denied) {
    return { created: false, updated: false, skipped: false, denied: true };
  }
  return { created: true, updated: false, skipped: false };
}

/**
 * Seed one Azure Key Vault entry.
 */
export async function writeAzureKeyVaultSecret(options: {
  vaultName: string;
  name: string;
  value: string;
  overwrite: boolean;
}): Promise<SecretWriteResult> {
  const { vaultName, name, value, overwrite } = options;
  const show = await execCommand(
    `az keyvault secret show --vault-name ${vaultName} --name ${name} --query id --output tsv`,
    { intent: "Check Key Vault entry", provider: "azure" },
  );
  const exists = Boolean(show.stdout.trim()) && !show.stderr;

  if (exists && !overwrite) {
    return { created: false, updated: false, skipped: true };
  }
  const write = await approvedExeca(
    `az keyvault secret set --vault-name ${vaultName} --name ${name} --file <redacted>`,
    exists ? "Update Key Vault entry" : "Create Key Vault entry",
    "azure",
    "az",
    [
      "keyvault",
      "secret",
      "set",
      "--vault-name",
      vaultName,
      "--name",
      name,
      "--file",
      "/dev/stdin",
      "--output",
      "none",
    ],
    value,
  );
  if (write.denied) {
    return { created: false, updated: false, skipped: false, denied: true };
  }
  return exists
    ? { created: false, updated: true, skipped: false }
    : { created: true, updated: false, skipped: false };
}

/**
 * Seed one GCP Secret Manager entry.
 */
export async function writeGcpSecretManagerSecret(options: {
  projectId: string;
  name: string;
  value: string;
  overwrite: boolean;
}): Promise<SecretWriteResult> {
  const { projectId, name, value, overwrite } = options;
  const describe = await execCommand(
    `gcloud secrets describe ${name} --project ${projectId} --format="value(name)"`,
    { intent: "Check Secret Manager entry", provider: "gcp" },
  );
  const exists = Boolean(describe.stdout.trim()) && !describe.stderr;

  if (exists && !overwrite) {
    return { created: false, updated: false, skipped: true };
  }
  if (exists) {
    const write = await approvedExeca(
      `gcloud secrets versions add ${name} --project ${projectId} --data-file=<redacted>`,
      "Update Secret Manager entry",
      "gcp",
      "gcloud",
      ["secrets", "versions", "add", name, "--project", projectId, "--data-file=-"],
      value,
    );
    if (write.denied) {
      return { created: false, updated: false, skipped: false, denied: true };
    }
    return { created: false, updated: true, skipped: false };
  }
  const write = await approvedExeca(
    `gcloud secrets create ${name} --project ${projectId} --data-file=<redacted>`,
    "Create Secret Manager entry",
    "gcp",
    "gcloud",
    [
      "secrets",
      "create",
      name,
      "--project",
      projectId,
      "--replication-policy",
      "automatic",
      "--data-file=-",
    ],
    value,
  );
  if (write.denied) {
    return { created: false, updated: false, skipped: false, denied: true };
  }
  return { created: true, updated: false, skipped: false };
}
