import { execa, ExecaError } from 'execa';
import { promises as fs } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { CloudProvider, DeploymentConfig, isSupportedDnsProvider } from '../types/index.js';
import { getTerraformDir } from './config.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Path to embedded terraform templates
const TERRAFORM_TEMPLATES_DIR = path.resolve(__dirname, '../../terraform');

/**
 * Detects if an error is a GCP authentication error
 */
function isGcpAuthError(output: string): boolean {
  const lowerOutput = output.toLowerCase();
  return (
    lowerOutput.includes('oauth2') ||
    lowerOutput.includes('invalid_grant') ||
    lowerOutput.includes('reauth') ||
    lowerOutput.includes('invalid_rapt') ||
    lowerOutput.includes('authentication') && lowerOutput.includes('google') ||
    lowerOutput.includes('unable to find default credentials') ||
    lowerOutput.includes('application default credentials')
  );
}

/**
 * Enhances GCP authentication errors with helpful guidance
 */
function enhanceGcpAuthError(output: string): string {
  return (
    'GCP Authentication Error\n\n' +
    'Terraform requires Application Default Credentials (ADC) to authenticate with Google Cloud.\n\n' +
    'To fix this:\n' +
    '  • Run: gcloud auth login\n' +
    '  • Run: gcloud auth application-default login\n' +
    '  • Verify: gcloud auth application-default print-access-token\n\n' +
    'For more information: https://cloud.google.com/docs/authentication/application-default-credentials\n\n' +
    'Original error:\n' +
    (output.length > 500 ? '...' + output.slice(-500) : output)
  );
}

/**
 * Extracts meaningful error message from execa error
 */
function getErrorMessage(error: unknown, fallback: string): string {
  const execaError = error as ExecaError;
  // Try stderr first, then stdout (terraform sometimes writes errors to stdout)
  const output = execaError.stderr || execaError.stdout || '';
  if (output) {
    // Check if this is a GCP authentication error
    if (isGcpAuthError(output)) {
      return enhanceGcpAuthError(output);
    }
    // Get last 500 chars of output for the error message
    const truncated = output.length > 500 ? '...' + output.slice(-500) : output;
    return truncated;
  }
  return execaError.shortMessage || execaError.message || fallback;
}

/**
 * Saves command output to a log file
 */
async function saveLogFile(workDir: string, command: string, stdout: string, stderr: string): Promise<string> {
  const logFile = path.join(workDir, `${command}-${Date.now()}.log`);
  const content = `=== STDOUT ===\n${stdout}\n\n=== STDERR ===\n${stderr}`;
  await fs.writeFile(logFile, content);
  return logFile;
}

/**
 * Checks if Terraform is installed
 */
export async function isTerraformInstalled(): Promise<boolean> {
  try {
    await execa('terraform', ['version']);
    return true;
  } catch {
    return false;
  }
}

/**
 * Gets the installed Terraform version
 */
export async function getTerraformVersion(): Promise<string> {
  const { stdout } = await execa('terraform', ['version', '-json']);
  const info = JSON.parse(stdout) as { terraform_version: string };
  return info.terraform_version;
}

/**
 * Copies terraform templates to the deployment directory
 */
export async function setupTerraformWorkspace(
  deploymentName: string,
  provider: CloudProvider
): Promise<string> {
  const sourceDir = path.join(TERRAFORM_TEMPLATES_DIR, provider);
  const targetDir = getTerraformDir(deploymentName);
  
  // Create target directory
  await fs.mkdir(targetDir, { recursive: true });
  
  // Copy all terraform files
  await copyDirectory(sourceDir, targetDir);
  
  return targetDir;
}

/**
 * Recursively copies a directory
 */
async function copyDirectory(src: string, dest: string): Promise<void> {
  await fs.mkdir(dest, { recursive: true });
  const entries = await fs.readdir(src, { withFileTypes: true });
  
  for (const entry of entries) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    
    if (entry.isDirectory()) {
      await copyDirectory(srcPath, destPath);
    } else {
      await fs.copyFile(srcPath, destPath);
    }
  }
}

/**
 * Initializes Terraform in the deployment directory
 */
export async function terraformInit(deploymentName: string): Promise<void> {
  const workDir = getTerraformDir(deploymentName);
  
  try {
    // Use 'pipe' to capture output instead of 'inherit' to avoid
    // interfering with Ink's terminal rendering
    await execa('terraform', ['init', '-upgrade'], {
      cwd: workDir
    });
  } catch (error) {
    const execaError = error as ExecaError;
    // Save logs for debugging
    if (execaError.stdout || execaError.stderr) {
      await saveLogFile(workDir, 'init', execaError.stdout || '', execaError.stderr || '');
    }
    throw new Error(`Terraform init failed:\n${getErrorMessage(error, 'Unknown error')}\n\nLogs saved to: ${workDir}`);
  }
}

/**
 * Plans Terraform changes
 */
export async function terraformPlan(deploymentName: string): Promise<void> {
  const workDir = getTerraformDir(deploymentName);
  
  try {
    await execa('terraform', ['plan', '-out=tfplan'], {
      cwd: workDir
    });
  } catch (error) {
    const execaError = error as ExecaError;
    if (execaError.stdout || execaError.stderr) {
      await saveLogFile(workDir, 'plan', execaError.stdout || '', execaError.stderr || '');
    }
    throw new Error(`Terraform plan failed:\n${getErrorMessage(error, 'Unknown error')}\n\nLogs saved to: ${workDir}`);
  }
}

/**
 * Applies Terraform changes
 */
export async function terraformApply(deploymentName: string): Promise<void> {
  const workDir = getTerraformDir(deploymentName);
  
  try {
    await execa('terraform', ['apply', '-auto-approve', 'tfplan'], {
      cwd: workDir
    });
  } catch (error) {
    const execaError = error as ExecaError;
    if (execaError.stdout || execaError.stderr) {
      await saveLogFile(workDir, 'apply', execaError.stdout || '', execaError.stderr || '');
    }
    throw new Error(`Terraform apply failed:\n${getErrorMessage(error, 'Unknown error')}\n\nLogs saved to: ${workDir}`);
  }
}

/**
 * Destroys Terraform infrastructure.
 * Runs init first to ensure .terraform folder exists (handles partial deployments).
 */
export async function terraformDestroy(deploymentName: string): Promise<void> {
  const workDir = getTerraformDir(deploymentName);
  
  try {
    // Run init first to ensure terraform is ready (handles partial deployments
    // where .terraform folder might be missing or corrupted)
    try {
      await execa('terraform', ['init', '-upgrade'], {
        cwd: workDir
      });
    } catch (initError) {
      // If init fails, still try destroy - it might work if state exists
      const execaInitError = initError as ExecaError;
      if (execaInitError.stdout || execaInitError.stderr) {
        await saveLogFile(workDir, 'destroy-init', execaInitError.stdout || '', execaInitError.stderr || '');
      }
      // Don't throw - continue to try destroy anyway
    }
    
    await execa('terraform', ['destroy', '-auto-approve'], {
      cwd: workDir
    });
  } catch (error) {
    const execaError = error as ExecaError;
    if (execaError.stdout || execaError.stderr) {
      await saveLogFile(workDir, 'destroy', execaError.stdout || '', execaError.stderr || '');
    }
    throw new Error(`Terraform destroy failed:\n${getErrorMessage(error, 'Unknown error')}\n\nLogs saved to: ${workDir}`);
  }
}

/**
 * Gets Terraform outputs
 */
export async function getTerraformOutputs(
  deploymentName: string
): Promise<Record<string, string>> {
  const workDir = getTerraformDir(deploymentName);
  
  try {
    const { stdout } = await execa('terraform', ['output', '-json'], {
      cwd: workDir
    });
    
    const outputs = JSON.parse(stdout) as Record<string, { value: unknown }>;
    const result: Record<string, string> = {};
    
    for (const [key, data] of Object.entries(outputs)) {
      result[key] = String(data.value);
    }
    
    return result;
  } catch {
    return {};
  }
}

/**
 * Checks if Terraform files/state exist for a deployment.
 * Returns true if the terraform directory contains any terraform files,
 * not just the state file. This allows destroy to work on partial infrastructure.
 */
export async function hasTerraformState(deploymentName: string): Promise<boolean> {
  const workDir = getTerraformDir(deploymentName);
  
  try {
    // Check if terraform directory exists
    await fs.access(workDir);
    
    // Check for any of: state file, .terraform folder, or .tf files
    const entries = await fs.readdir(workDir);
    const hasTerraformFiles = entries.some(
      (e) =>
        e === 'terraform.tfstate' || 
        e === '.terraform' || 
        e.endsWith('.tf')
    );
    
    return hasTerraformFiles;
  } catch {
    return false;
  }
}

/**
 * Generates Terraform variables from deployment configuration
 */
export function generateTerraformVars(config: DeploymentConfig): Record<string, unknown> {
  const provider = config.infrastructure.provider;
  if (!provider) {
    throw new Error('Cloud provider is required for infrastructure provisioning');
  }

  const region = config.infrastructure.region || (provider === 'gcp' ? 'us-central1' : provider === 'aws' ? 'us-east-1' : 'eastus');
  const clusterName = config.infrastructure.clusterName || `${config.name}-cluster`;
  const tier = config.tier || 'small';
  const kubernetesVersion = '1.34';

  // Determine if external DNS should be enabled
  const enableExternalDns = config.dns.autoManage && isSupportedDnsProvider(config.dns.provider);

  // Determine logging configuration
  const loggingSink = config.features.logging.sink;
  const loggingBucket = config.features.logging.bucket || '';

  switch (provider) {
    case 'gcp': {
      if (!config.infrastructure.gcpProjectId) {
        throw new Error('GCP project ID is required for GCP infrastructure provisioning');
      }

      const vars: Record<string, unknown> = {
        project_id: config.infrastructure.gcpProjectId,
        region,
        cluster_name: clusterName,
        tier,
        kubernetes_version: kubernetesVersion,
        enable_external_dns: enableExternalDns,
        enable_gcs_logging: loggingSink === 'gcs',
        logging_gcs_bucket: loggingSink === 'gcs' ? loggingBucket : '',
      };

      return vars;
    }

    case 'aws': {
      // Extract domain suffix for external DNS domain filter
      const domainSuffix = enableExternalDns && config.domain ? config.domain.split('.').slice(1).join('.') : '';

      const vars: Record<string, unknown> = {
        region,
        cluster_name: clusterName,
        tier,
        kubernetes_version: kubernetesVersion,
        enable_external_dns: enableExternalDns,
        external_dns_domain: enableExternalDns ? domainSuffix : '',
        enable_s3_logging: loggingSink === 's3',
        logging_s3_bucket: loggingSink === 's3' ? loggingBucket : '',
      };

      return vars;
    }

    case 'azure': {
      const resourceGroupName = config.infrastructure.azureResourceGroup || `${config.name}-rg`;

      // For Azure DNS, we need the DNS zone resource group
      // This is typically the same as the resource group, but can be different
      const dnsZoneResourceGroup = enableExternalDns ? resourceGroupName : '';

      const vars: Record<string, unknown> = {
        resource_group_name: resourceGroupName,
        location: region,
        cluster_name: clusterName,
        tier,
        kubernetes_version: kubernetesVersion,
        enable_external_dns: enableExternalDns,
        dns_zone_resource_group: dnsZoneResourceGroup,
        enable_blob_logging: loggingSink === 'azure-blob',
        logging_storage_account: loggingSink === 'azure-blob' ? loggingBucket : '',
        logging_container_name: loggingSink === 'azure-blob' ? 'logs' : '',
      };

      return vars;
    }

    default:
      throw new Error(`Unsupported cloud provider: ${provider}`);
  }
}

/**
 * Updates kubeconfig for the provisioned cluster
 */
export async function updateKubeconfig(
  provider: CloudProvider,
  clusterName: string,
  region: string,
  options: {
    gcpProjectId?: string;
    azureResourceGroup?: string;
  } = {}
): Promise<void> {
  try {
    switch (provider) {
      case 'aws':
        await execa('aws', [
          'eks', 'update-kubeconfig',
          '--name', clusterName,
          '--region', region
        ]);
        break;
        
      case 'gcp':
        if (!options.gcpProjectId) {
          throw new Error('GCP project ID is required');
        }
        await execa('gcloud', [
          'container', 'clusters', 'get-credentials',
          clusterName,
          '--region', region,
          '--project', options.gcpProjectId
        ]);
        break;
        
      case 'azure':
        if (!options.azureResourceGroup) {
          throw new Error('Azure resource group is required');
        }
        await execa('az', [
          'aks', 'get-credentials',
          '--name', clusterName,
          '--resource-group', options.azureResourceGroup
        ]);
        break;
    }
  } catch (error) {
    throw new Error(`Failed to update kubeconfig:\n${getErrorMessage(error, 'Unknown error')}`);
  }
}
