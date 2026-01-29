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
 * Static fallback for AWS regions (c8g Graviton4 ARM64 available or expected)
 */
function getStaticAwsRegions(): string[] {
  return [
    // US regions (c8g Graviton4 available)
    "us-east-1",
    "us-east-2",
    "us-west-1",
    "us-west-2",
    // Canada
    "ca-central-1",
    "ca-west-1",
    // Europe (c8g available)
    "eu-west-1",
    "eu-west-2",
    "eu-west-3",
    "eu-central-1",
    "eu-central-2",
    "eu-north-1",
    "eu-south-1",
    "eu-south-2",
    // Asia Pacific (c8g available)
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
 * Check if gcloud CLI is installed and fully authenticated
 * 
 * For GCP to be considered "authenticated", the user must have:
 * 1. Logged in with `gcloud auth login`
 * 2. Set a default project with `gcloud config set project PROJECT_ID`
 * 3. Configured Application Default Credentials with `gcloud auth application-default login`
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

      // Step 1: Check if logged in
      if (!account) {
        status.error = 'Not authenticated - run "gcloud auth login"';
        return status;
      }

      // Step 2: Check if project is set
      if (!project) {
        status.error =
          'No default project set - run "gcloud config set project PROJECT_ID"';
        return status;
      }

      // Step 3: Check Application Default Credentials
      const adcResult = await checkGcpApplicationDefaultCredentials();
      if (!adcResult.configured) {
        status.error =
          'Application Default Credentials not configured - run "gcloud auth application-default login"';
        return status;
      }

      // All checks passed
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
 * Check if GCP Application Default Credentials (ADC) are configured
 * ADC is required for Terraform to authenticate with Google Cloud
 */
export async function checkGcpApplicationDefaultCredentials(): Promise<{
  configured: boolean;
  error?: string;
}> {
  try {
    // Try to get an access token using ADC
    const result = await execCommand(
      "gcloud auth application-default print-access-token"
    );
    
    if (result.stdout && result.stdout.trim().length > 0) {
      return { configured: true };
    }
    
    return {
      configured: false,
      error: "Application Default Credentials not configured",
    };
  } catch (error) {
    const errorMessage =
      error instanceof Error ? error.message : "Unknown error";
    
    // Check if it's specifically an authentication error
    if (
      errorMessage.includes("not found") ||
      errorMessage.includes("not configured") ||
      errorMessage.includes("Could not automatically determine credentials")
    ) {
      return {
        configured: false,
        error: "Application Default Credentials not configured",
      };
    }
    
    return {
      configured: false,
      error: errorMessage,
    };
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
 * Static fallback for GCP regions (C4A/Google Axion ARM64 confirmed availability)
 * Only includes regions with full C4A zone coverage for GKE regional clusters
 */
function getStaticGcpRegions(): string[] {
  return [
    // Tier 1: Full C4A (Google Axion ARM64) availability - 3+ zones confirmed
    // US regions
    "us-central1",    // C4A in zones a, b, c, f (best availability)
    "us-east1",       // C4A in zones b, c, d
    "us-east4",       // C4A in zones a, b, c
    "us-west1",       // C4A in zones a, b, c
    "us-west4",       // C4A in zones a, b, c
    // North America
    "northamerica-south1", // C4A in zones a, b, c (Mexico)
    // Europe
    "europe-west1",   // C4A in zones b, c, d
    "europe-west2",   // C4A in zones a, b, c
    "europe-west3",   // C4A in zones a, b, c
    "europe-west4",   // C4A in zones a, b, c
    "europe-north1",  // C4A in zones a, b
    // Asia Pacific
    "asia-east1",     // C4A in zones a, b, c
    "asia-northeast1", // C4A in zones b, c
    "asia-south1",    // C4A in zones a, b, c
    "asia-southeast1", // C4A in zones a, b, c
    // Australia
    "australia-southeast2", // C4A in zones a, b, c
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
 * Check if Azure CLI is installed and fully authenticated
 * 
 * For Azure to be considered "authenticated", the user must have:
 * 1. Logged in with `az login`
 * 2. An active subscription in "Enabled" state
 * 3. Required resource providers registered (Microsoft.ContainerService, etc.)
 * 4. Sufficient vCPU quota for at least the small tier (8 cores)
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

    // Step 1: Check authentication and subscription
    const accountResult = await execCommand("az account show --output json");

    if (accountResult.stderr && accountResult.stderr.includes("Please run")) {
      status.error = 'Not authenticated - run "az login"';
      return status;
    }

    let subscriptionName: string | undefined;
    try {
      const account = JSON.parse(accountResult.stdout);
      subscriptionName = account.name;
      
      // Step 2: Check subscription state is Enabled
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

    // Step 3: Check required resource providers are registered
    const providerCheck = await checkAzureResourceProviders();
    if (!providerCheck.allRegistered) {
      status.error =
        `Resource providers not registered: ${providerCheck.missing.join(", ")}. ` +
        `Run: ${providerCheck.missing.map((p) => `az provider register --namespace ${p}`).join(" && ")}`;
      return status;
    }

    // Step 4: Check minimum vCPU quota (small tier = 8 cores)
    const quotaCheck = await checkAzureVmQuota(
      AZURE_DEFAULT_QUOTA_CHECK_REGION,
      AZURE_TIER_CORES.small,
    );
    
    if (!quotaCheck.sufficient) {
      status.error =
        `Insufficient vCPU quota (${quotaCheck.available}/${quotaCheck.limit} available in ${AZURE_DEFAULT_QUOTA_CHECK_REGION}). ` +
        "Request increase at Azure portal > Subscriptions > Usage + quotas";
      return status;
    }

    // All checks passed
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
 * Static fallback for Azure regions (Dpsv5 ARM64 available or expected)
 */
function getStaticAzureRegions(): string[] {
  return [
    // US regions (Dpsv5 ARM64 available)
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
    // Europe (Dpsv5 available)
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
 * Required Azure resource providers for AKS deployment
 */
const AZURE_REQUIRED_PROVIDERS = [
  "Microsoft.ContainerService", // For AKS
  "Microsoft.Network", // For VNets, NSGs
  "Microsoft.ManagedIdentity", // For managed identities
  "Microsoft.Compute", // For VMs
];

/**
 * Azure tier to vCPU core requirements mapping
 */
export const AZURE_TIER_CORES: Record<string, number> = {
  small: 8, // 4 nodes × 2 vCPU
  medium: 16, // 4 nodes × 4 vCPU
  large: 40, // 5 nodes × 8 vCPU
};

/**
 * Default region used for baseline quota checks when region is not yet selected
 */
const AZURE_DEFAULT_QUOTA_CHECK_REGION = "eastus";

/**
 * Check if required Azure resource providers are registered
 */
export async function checkAzureResourceProviders(): Promise<{
  allRegistered: boolean;
  missing: string[];
}> {
  const missing: string[] = [];

  try {
    for (const provider of AZURE_REQUIRED_PROVIDERS) {
      const result = await execCommand(
        `az provider show --namespace ${provider} --query "registrationState" --output tsv`,
      );

      const state = result.stdout.trim();
      if (state !== "Registered") {
        missing.push(provider);
      }
    }

    return {
      allRegistered: missing.length === 0,
      missing,
    };
  } catch {
    // If we can't check, assume they're not registered
    return {
      allRegistered: false,
      missing: AZURE_REQUIRED_PROVIDERS,
    };
  }
}

/**
 * Check Azure VM quota for a specific region
 * 
 * @param region - Azure region to check quota for
 * @param requiredCores - Number of vCPUs required
 * @returns Quota check result with availability info
 */
export async function checkAzureVmQuota(
  region: string,
  requiredCores: number,
): Promise<{
  sufficient: boolean;
  available: number;
  limit: number;
  used: number;
  error?: string;
}> {
  try {
    const result = await execCommand(
      `az vm list-usage --location ${region} --output json`,
    );

    if (result.stderr && !result.stdout) {
      return {
        sufficient: false,
        available: 0,
        limit: 0,
        used: 0,
        error: "Failed to check VM quota",
      };
    }

    const usageList = JSON.parse(result.stdout) as Array<{
      name: { value: string; localizedValue: string };
      currentValue: number;
      limit: number;
    }>;

    // Find total regional vCPU quota
    const regionalQuota = usageList.find(
      (u) => u.name.value === "cores" || u.name.localizedValue === "Total Regional vCPUs",
    );

    if (!regionalQuota) {
      return {
        sufficient: false,
        available: 0,
        limit: 0,
        used: 0,
        error: "Could not find regional vCPU quota",
      };
    }

    const used = regionalQuota.currentValue;
    const limit = regionalQuota.limit;
    const available = limit - used;

    return {
      sufficient: available >= requiredCores,
      available,
      limit,
      used,
    };
  } catch (error) {
    return {
      sufficient: false,
      available: 0,
      limit: 0,
      used: 0,
      error: error instanceof Error ? error.message : "Failed to check VM quota",
    };
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
export const CLI_LOGIN_COMMANDS: Record<CloudProvider, string | string[]> = {
  aws: "aws configure",
  gcp: [
    "gcloud auth login",
    "gcloud config set project PROJECT_ID",
    "gcloud auth application-default login",
  ],
  azure: [
    "az login",
    "az account set --subscription YOUR_SUBSCRIPTION_ID",
    "az provider register --namespace Microsoft.ContainerService",
  ],
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
