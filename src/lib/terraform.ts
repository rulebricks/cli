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
 * Lightweight pre-deploy cleanup for the CloudWatch log group that the EKS module
 * no longer manages (create_cloudwatch_log_group = false). Safe to call before
 * terraform apply since it targets a resource outside terraform's control.
 */
export async function cleanupOrphanedResources(
  provider: CloudProvider,
  clusterName: string,
  region: string,
): Promise<void> {
  if (provider === 'aws') {
    const logGroupName = `/aws/eks/${clusterName}/cluster`;
    try {
      await execa('aws', [
        'logs', 'delete-log-group',
        '--log-group-name', logGroupName,
        '--region', region,
      ]);
    } catch {
      // Log group may not exist — that's fine
    }
  }
}

// ============================================================================
// Post-destroy cloud-native cleanup (AWS)
//
// Handles every uniquely-named resource that terraform tends to leave behind
// after a failed destroy or partial apply. Runs unconditionally after every
// terraform destroy since terraform can report success while resources linger.
// Every step is best-effort: failures are silently swallowed.
// ============================================================================

async function deleteAwsEksNodeGroups(clusterName: string, region: string): Promise<void> {
  let nodeGroups: string[];
  try {
    const { stdout } = await execa('aws', [
      'eks', 'list-nodegroups',
      '--cluster-name', clusterName,
      '--region', region,
      '--output', 'json',
    ]);
    const parsed = JSON.parse(stdout) as { nodegroups?: string[] };
    nodeGroups = parsed.nodegroups ?? [];
  } catch {
    return; // Cluster may not exist
  }

  for (const ng of nodeGroups) {
    try {
      await execa('aws', [
        'eks', 'delete-nodegroup',
        '--cluster-name', clusterName,
        '--nodegroup-name', ng,
        '--region', region,
      ]);
    } catch { /* already gone */ }
  }

  // Wait for all node groups to finish deleting
  for (const ng of nodeGroups) {
    try {
      await execa('aws', [
        'eks', 'wait', 'nodegroup-deleted',
        '--cluster-name', clusterName,
        '--nodegroup-name', ng,
        '--region', region,
      ]);
    } catch { /* timeout or already gone */ }
  }
}

async function deleteAwsEksCluster(clusterName: string, region: string): Promise<void> {
  try {
    await execa('aws', [
      'eks', 'delete-cluster',
      '--name', clusterName,
      '--region', region,
    ]);
  } catch {
    return; // Cluster may not exist
  }

  try {
    await execa('aws', [
      'eks', 'wait', 'cluster-deleted',
      '--name', clusterName,
      '--region', region,
    ]);
  } catch { /* timeout or already gone */ }
}

async function deleteAwsCloudWatchLogGroup(clusterName: string, region: string): Promise<void> {
  try {
    await execa('aws', [
      'logs', 'delete-log-group',
      '--log-group-name', `/aws/eks/${clusterName}/cluster`,
      '--region', region,
    ]);
  } catch { /* may not exist */ }
}

/**
 * Captures the OIDC issuer URL from an EKS cluster before it's deleted.
 * The URL uses a random cluster ID (not the cluster name), so we must
 * grab it while the cluster still exists to identify the OIDC provider later.
 */
async function getEksOidcIssuer(clusterName: string, region: string): Promise<string | undefined> {
  try {
    const { stdout } = await execa('aws', [
      'eks', 'describe-cluster',
      '--name', clusterName,
      '--region', region,
      '--query', 'cluster.identity.oidc.issuer',
      '--output', 'text',
    ]);
    const url = stdout.trim();
    return url && url !== 'None' ? url : undefined;
  } catch {
    return undefined;
  }
}

async function deleteAwsOidcProvider(oidcIssuerUrl: string | undefined): Promise<void> {
  if (!oidcIssuerUrl) return;

  // Strip the https:// prefix to match how IAM stores the URL
  const issuerHost = oidcIssuerUrl.replace('https://', '');

  let providerArns: string[];
  try {
    const { stdout } = await execa('aws', [
      'iam', 'list-open-id-connect-providers',
      '--output', 'json',
    ]);
    const parsed = JSON.parse(stdout) as { OpenIDConnectProviderList?: { Arn: string }[] };
    providerArns = (parsed.OpenIDConnectProviderList ?? []).map((p) => p.Arn);
  } catch {
    return;
  }

  for (const arn of providerArns) {
    try {
      const { stdout } = await execa('aws', [
        'iam', 'get-open-id-connect-provider',
        '--open-id-connect-provider-arn', arn,
        '--output', 'json',
      ]);
      const parsed = JSON.parse(stdout) as { Url?: string };
      if (parsed.Url && issuerHost.includes(parsed.Url)) {
        await execa('aws', [
          'iam', 'delete-open-id-connect-provider',
          '--open-id-connect-provider-arn', arn,
        ]);
      }
    } catch { /* skip */ }
  }
}

async function releaseAwsElasticIps(clusterName: string, region: string): Promise<void> {
  try {
    const { stdout } = await execa('aws', [
      'ec2', 'describe-addresses',
      '--filters', `Name=tag:Name,Values=*${clusterName}*`,
      '--region', region,
      '--query', 'Addresses[?AssociationId==null].AllocationId',
      '--output', 'json',
    ]);
    const allocationIds = JSON.parse(stdout) as string[];
    for (const id of allocationIds) {
      try {
        await execa('aws', [
          'ec2', 'release-address',
          '--allocation-id', id,
          '--region', region,
        ]);
      } catch { /* may already be released */ }
    }
  } catch { /* skip */ }
}

async function deleteAwsIamRole(roleName: string): Promise<void> {
  // Detach all managed policies
  try {
    const { stdout } = await execa('aws', [
      'iam', 'list-attached-role-policies',
      '--role-name', roleName,
      '--output', 'json',
    ]);
    const parsed = JSON.parse(stdout) as { AttachedPolicies?: { PolicyArn: string }[] };
    for (const policy of parsed.AttachedPolicies ?? []) {
      try {
        await execa('aws', [
          'iam', 'detach-role-policy',
          '--role-name', roleName,
          '--policy-arn', policy.PolicyArn,
        ]);
      } catch { /* skip */ }
    }
  } catch { /* role may not exist */ }

  // Delete inline policies
  try {
    const { stdout } = await execa('aws', [
      'iam', 'list-role-policies',
      '--role-name', roleName,
      '--output', 'json',
    ]);
    const parsed = JSON.parse(stdout) as { PolicyNames?: string[] };
    for (const policyName of parsed.PolicyNames ?? []) {
      try {
        await execa('aws', [
          'iam', 'delete-role-policy',
          '--role-name', roleName,
          '--policy-name', policyName,
        ]);
      } catch { /* skip */ }
    }
  } catch { /* role may not exist */ }

  // Delete the role itself
  try {
    await execa('aws', ['iam', 'delete-role', '--role-name', roleName]);
  } catch { /* may not exist */ }
}

async function deleteAwsKmsAlias(clusterName: string, region: string): Promise<void> {
  const aliasName = `alias/eks/${clusterName}`;
  let keyId: string | undefined;

  // Find the KMS key behind the alias so we can schedule it for deletion
  try {
    const { stdout } = await execa('aws', [
      'kms', 'list-aliases',
      '--query', `Aliases[?AliasName=='${aliasName}'].TargetKeyId | [0]`,
      '--output', 'text',
      '--region', region,
    ]);
    const id = stdout.trim();
    if (id && id !== 'None') {
      keyId = id;
    }
  } catch { /* skip */ }

  // Delete the alias (unique name constraint -- blocks re-deploy if left behind)
  try {
    await execa('aws', [
      'kms', 'delete-alias',
      '--alias-name', aliasName,
      '--region', region,
    ]);
  } catch { /* may not exist */ }

  // Schedule the underlying key for deletion (7-day mandatory minimum)
  if (keyId) {
    try {
      await execa('aws', [
        'kms', 'schedule-key-deletion',
        '--key-id', keyId,
        '--pending-window-in-days', '7',
        '--region', region,
      ]);
    } catch { /* key may already be pending deletion or not exist */ }
  }
}

/**
 * Finds KMS keys by the description the EKS module uses, and schedules them for
 * deletion. Catches keys that survive after their alias is already deleted.
 */
async function scheduleAwsOrphanedKmsKeys(clusterName: string, region: string): Promise<void> {
  try {
    const { stdout } = await execa('aws', [
      'kms', 'list-keys',
      '--region', region,
      '--query', 'Keys[].KeyId',
      '--output', 'json',
    ]);
    const keyIds = JSON.parse(stdout) as string[];
    for (const keyId of keyIds) {
      try {
        const { stdout: meta } = await execa('aws', [
          'kms', 'describe-key',
          '--key-id', keyId,
          '--region', region,
          '--query', 'KeyMetadata.{State:KeyState,Desc:Description,Manager:KeyManager}',
          '--output', 'json',
        ]);
        const info = JSON.parse(meta) as { State: string; Desc: string; Manager: string };
        if (
          info.Manager === 'CUSTOMER' &&
          info.State === 'Enabled' &&
          info.Desc.includes(clusterName)
        ) {
          await execa('aws', [
            'kms', 'schedule-key-deletion',
            '--key-id', keyId,
            '--pending-window-in-days', '7',
            '--region', region,
          ]);
        }
      } catch { /* skip individual key */ }
    }
  } catch { /* skip */ }
}

async function deleteAwsLaunchTemplates(clusterName: string, region: string): Promise<void> {
  try {
    const { stdout } = await execa('aws', [
      'ec2', 'describe-launch-templates',
      '--filters', `Name=tag:Environment,Values=rulebricks`,
      '--region', region,
      '--query', 'LaunchTemplates[].LaunchTemplateId',
      '--output', 'json',
    ]);
    const ids = JSON.parse(stdout) as string[];
    for (const id of ids) {
      try {
        await execa('aws', [
          'ec2', 'delete-launch-template',
          '--launch-template-id', id,
          '--region', region,
        ]);
      } catch { /* may not exist or in use */ }
    }
  } catch { /* skip */ }
}

async function deleteAwsIamPolicy(policyName: string): Promise<void> {
  try {
    const { stdout } = await execa('aws', [
      'iam', 'list-policies',
      '--query', `Policies[?PolicyName=='${policyName}']`,
      '--output', 'json',
    ]);
    const policies = JSON.parse(stdout) as { Arn: string }[];
    for (const policy of policies) {
      try {
        await execa('aws', ['iam', 'delete-policy', '--policy-arn', policy.Arn]);
      } catch { /* may have attachments or not exist */ }
    }
  } catch { /* skip */ }
}

/**
 * Comprehensive post-destroy cleanup of AWS resources that terraform leaves
 * behind. Handles the full dependency chain in the correct order.
 * Entirely best-effort: every step silently swallows errors.
 */
async function cleanupAwsResources(clusterName: string, region: string): Promise<void> {
  // Capture the OIDC issuer URL BEFORE deleting the cluster -- the URL uses a
  // random cluster ID (not the cluster name) so we can't find it after deletion.
  const oidcIssuerUrl = await getEksOidcIssuer(clusterName, region);

  // 1. EKS node groups (must be deleted before cluster)
  await deleteAwsEksNodeGroups(clusterName, region);

  // 2. EKS cluster
  await deleteAwsEksCluster(clusterName, region);

  // 3. CloudWatch log group (now safe -- cluster is gone, won't be recreated)
  await deleteAwsCloudWatchLogGroup(clusterName, region);

  // 4. OIDC provider (matched by issuer URL captured above)
  await deleteAwsOidcProvider(oidcIssuerUrl);

  // 5. IAM roles created by terraform modules
  await deleteAwsIamRole(`${clusterName}-ebs-csi`);
  await deleteAwsIamRole(`${clusterName}-external-dns`);
  await deleteAwsIamRole(`${clusterName}-vector`);

  // 6. Customer-managed IAM policies
  await deleteAwsIamPolicy(`${clusterName}-vector-s3`);

  // 7. KMS key + alias (created by EKS module for envelope encryption)
  await deleteAwsKmsAlias(clusterName, region);

  // 8. KMS keys that lost their alias but are still Enabled (matched by description)
  await scheduleAwsOrphanedKmsKeys(clusterName, region);

  // 9. Launch templates (created by EKS managed node groups)
  await deleteAwsLaunchTemplates(clusterName, region);

  // 10. Elastic IPs (created by VPC module for NAT gateways, cost money if leaked)
  await releaseAwsElasticIps(clusterName, region);
}

/**
 * Destroys Terraform infrastructure, then sweeps remaining cloud resources.
 *
 * Flow:
 *   1. terraform destroy (single attempt)
 *   2. Cloud-native cleanup ALWAYS runs (terraform can report success while
 *      resources still exist)
 *   3. If terraform reported failure, try once more now that blockers are gone
 */
export async function terraformDestroy(
  deploymentName: string,
  cloudContext?: { provider: CloudProvider; clusterName: string; region: string },
): Promise<void> {
  const workDir = getTerraformDir(deploymentName);

  // Run init first to ensure terraform is ready
  try {
    await execa('terraform', ['init', '-upgrade'], {
      cwd: workDir
    });
  } catch (initError) {
    const execaInitError = initError as ExecaError;
    if (execaInitError.stdout || execaInitError.stderr) {
      await saveLogFile(workDir, 'destroy-init', execaInitError.stdout || '', execaInitError.stderr || '');
    }
  }

  // First terraform destroy attempt
  let firstAttemptFailed = false;
  try {
    await execa('terraform', ['destroy', '-auto-approve'], {
      cwd: workDir
    });
  } catch (error) {
    firstAttemptFailed = true;
    const execaError = error as ExecaError;
    if (execaError.stdout || execaError.stderr) {
      await saveLogFile(workDir, 'destroy', execaError.stdout || '', execaError.stderr || '');
    }
  }

  // ALWAYS run cloud-native cleanup -- terraform can't be trusted to report
  // accurately whether all resources were actually destroyed
  if (cloudContext?.provider === 'aws') {
    await cleanupAwsResources(cloudContext.clusterName, cloudContext.region);
  }

  // If terraform failed, try once more now that cloud-native cleanup removed blockers
  if (firstAttemptFailed) {
    try {
      await execa('terraform', ['destroy', '-auto-approve'], {
        cwd: workDir
      });
    } catch (error) {
      const execaError = error as ExecaError;
      if (execaError.stdout || execaError.stderr) {
        await saveLogFile(workDir, 'destroy-final', execaError.stdout || '', execaError.stderr || '');
      }
      throw new Error(`Terraform destroy failed:\n${getErrorMessage(error, 'Unknown error')}\n\nLogs saved to: ${workDir}`);
    }
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
