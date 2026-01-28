import { execa, ExecaError } from 'execa';
import { promises as fs } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { CloudProvider } from '../types/index.js';
import { getTerraformDir } from './config.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Path to embedded terraform templates
const TERRAFORM_TEMPLATES_DIR = path.resolve(__dirname, '../../terraform');

/**
 * Extracts meaningful error message from execa error
 */
function getErrorMessage(error: unknown, fallback: string): string {
  const execaError = error as ExecaError;
  // Try stderr first, then stdout (terraform sometimes writes errors to stdout)
  const output = execaError.stderr || execaError.stdout || '';
  if (output) {
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
 * Destroys Terraform infrastructure
 */
export async function terraformDestroy(deploymentName: string): Promise<void> {
  const workDir = getTerraformDir(deploymentName);
  
  try {
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
 * Checks if Terraform state exists for a deployment
 */
export async function hasTerraformState(deploymentName: string): Promise<boolean> {
  const workDir = getTerraformDir(deploymentName);
  const statePath = path.join(workDir, 'terraform.tfstate');
  
  try {
    await fs.access(statePath);
    return true;
  } catch {
    return false;
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
