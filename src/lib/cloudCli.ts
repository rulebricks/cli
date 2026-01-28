/**
 * Cloud CLI detection and dynamic resource listing
 *
 * Detects installed cloud CLIs (AWS, GCP, Azure), checks authentication status,
 * and provides functions to list regions and buckets dynamically.
 */

import { exec } from "child_process";
import { promisify } from "util";
import { CloudProvider, CLOUD_REGIONS } from "../types/index.js";

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
 * Execute a CLI command with timeout
 */
async function execCommand(
  command: string,
  timeout: number = CLI_TIMEOUT,
): Promise<{ stdout: string; stderr: string }> {
  try {
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
 * Static fallback for AWS regions
 */
function getStaticAwsRegions(): string[] {
  return [
    "us-east-1",
    "us-east-2",
    "us-west-1",
    "us-west-2",
    "ap-south-1",
    "ap-northeast-1",
    "ap-northeast-2",
    "ap-northeast-3",
    "ap-southeast-1",
    "ap-southeast-2",
    "ca-central-1",
    "eu-central-1",
    "eu-west-1",
    "eu-west-2",
    "eu-west-3",
    "eu-north-1",
    "sa-east-1",
  ];
}

/**
 * List EKS clusters in a specific region
 */
export async function listEksClusters(region: string): Promise<string[]> {
  try {
    const result = await execCommand(
      `aws eks list-clusters --region ${region} --output json`,
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

// ============================================================================
// GCP CLI (gcloud)
// ============================================================================

/**
 * Check if gcloud CLI is installed and authenticated
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

      status.authenticated = true;
      status.identity = project ? `Project: ${project}` : `Account: ${account}`;

      if (!project) {
        status.error =
          'No default project set - run "gcloud config set project PROJECT_ID"';
      }
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
 * Static fallback for GCP regions
 */
function getStaticGcpRegions(): string[] {
  return [
    "us-central1",
    "us-east1",
    "us-east4",
    "us-west1",
    "us-west2",
    "us-west3",
    "us-west4",
    "northamerica-northeast1",
    "northamerica-northeast2",
    "southamerica-east1",
    "southamerica-west1",
    "europe-central2",
    "europe-north1",
    "europe-west1",
    "europe-west2",
    "europe-west3",
    "europe-west4",
    "europe-west6",
    "europe-southwest1",
    "asia-east1",
    "asia-east2",
    "asia-northeast1",
    "asia-northeast2",
    "asia-northeast3",
    "asia-south1",
    "asia-south2",
    "asia-southeast1",
    "asia-southeast2",
    "australia-southeast1",
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

// ============================================================================
// Azure CLI
// ============================================================================

/**
 * Check if Azure CLI is installed and authenticated
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

    // Check authentication
    const accountResult = await execCommand("az account show --output json");

    if (accountResult.stderr && accountResult.stderr.includes("Please run")) {
      status.error = 'Not authenticated - run "az login"';
      return status;
    }

    try {
      const account = JSON.parse(accountResult.stdout);
      status.authenticated = true;
      status.identity = account.name
        ? `Subscription: ${account.name}`
        : undefined;
    } catch {
      status.error = "Failed to parse account info";
    }
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
 * Static fallback for Azure regions
 */
function getStaticAzureRegions(): string[] {
  return [
    "eastus",
    "eastus2",
    "centralus",
    "northcentralus",
    "southcentralus",
    "westus",
    "westus2",
    "westus3",
    "canadacentral",
    "canadaeast",
    "brazilsouth",
    "northeurope",
    "westeurope",
    "uksouth",
    "ukwest",
    "francecentral",
    "germanywestcentral",
    "switzerlandnorth",
    "norwayeast",
    "eastasia",
    "southeastasia",
    "japaneast",
    "japanwest",
    "koreacentral",
    "australiaeast",
    "australiasoutheast",
    "australiacentral",
    "centralindia",
    "southindia",
    "westindia",
    "uaenorth",
    "southafricanorth",
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
export const CLI_LOGIN_COMMANDS: Record<CloudProvider, string> = {
  aws: "aws configure",
  gcp: "gcloud auth login",
  azure: "az login",
};

// ============================================================================
// Terraform
// ============================================================================

/**
 * Terraform installation status
 */
export interface TerraformStatus {
  installed: boolean;
  version?: string;
  error?: string;
}

/**
 * Check if Terraform is installed
 */
export async function checkTerraform(): Promise<TerraformStatus> {
  try {
    const result = await execCommand("terraform --version");

    if (result.stderr && !result.stdout) {
      return { installed: false, error: "Terraform not found" };
    }

    // Extract version (e.g., "Terraform v1.5.0")
    const versionMatch = result.stdout.match(/Terraform v([\d.]+)/);
    return {
      installed: true,
      version: versionMatch ? versionMatch[1] : undefined,
    };
  } catch {
    return { installed: false, error: "Terraform not found" };
  }
}

/**
 * Terraform installation info
 */
export const TERRAFORM_INSTALL_INFO = {
  name: "Terraform",
  url: "https://developer.hashicorp.com/terraform/downloads",
  installCmd: "brew install terraform",
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
