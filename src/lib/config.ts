import { promises as fs } from "fs";
import path from "path";
import os from "os";
import yaml from "yaml";
import {
  DeploymentConfig,
  DeploymentConfigSchema,
  DeploymentState,
  ProfileConfig,
  ProfileConfigSchema,
} from "../types/index.js";

const RULEBRICKS_DIR = path.join(os.homedir(), ".rulebricks");
const DEPLOYMENTS_DIR = path.join(RULEBRICKS_DIR, "deployments");
const PROFILE_FILE = "profile.yaml";

/**
 * Ensures the base directories exist
 */
export async function ensureDirectories(): Promise<void> {
  await fs.mkdir(DEPLOYMENTS_DIR, { recursive: true });
}

/**
 * Gets the deployment directory path
 */
export function getDeploymentDir(name: string): string {
  return path.join(DEPLOYMENTS_DIR, name);
}

/**
 * Lists all deployments
 */
export async function listDeployments(): Promise<string[]> {
  await ensureDirectories();
  try {
    const entries = await fs.readdir(DEPLOYMENTS_DIR, { withFileTypes: true });
    return entries.filter((e) => e.isDirectory()).map((e) => e.name);
  } catch {
    return [];
  }
}

/**
 * Checks if a deployment exists
 */
export async function deploymentExists(name: string): Promise<boolean> {
  const dir = getDeploymentDir(name);
  try {
    await fs.access(dir);
    return true;
  } catch {
    return false;
  }
}

/**
 * Saves a deployment configuration
 */
export async function saveDeploymentConfig(
  config: DeploymentConfig,
): Promise<void> {
  const dir = getDeploymentDir(config.name);
  await fs.mkdir(dir, { recursive: true });

  const configPath = path.join(dir, "config.yaml");
  await fs.writeFile(configPath, yaml.stringify(config), "utf-8");
}

/**
 * Loads a deployment configuration
 */
export async function loadDeploymentConfig(
  name: string,
): Promise<DeploymentConfig> {
  const configPath = path.join(getDeploymentDir(name), "config.yaml");
  const content = await fs.readFile(configPath, "utf-8");
  const parsed = yaml.parse(content);
  return DeploymentConfigSchema.parse(parsed);
}

/**
 * Clones a deployment configuration to a new name
 * Only copies config.yaml with the new name - state and terraform are not copied
 */
export async function cloneDeploymentConfig(
  sourceName: string,
  targetName: string,
): Promise<DeploymentConfig> {
  const sourceConfig = await loadDeploymentConfig(sourceName);
  const clonedConfig: DeploymentConfig = {
    ...sourceConfig,
    name: targetName,
  };
  await saveDeploymentConfig(clonedConfig);
  return clonedConfig;
}

/**
 * Saves the deployment state
 */
export async function saveDeploymentState(
  name: string,
  state: DeploymentState,
): Promise<void> {
  const dir = getDeploymentDir(name);
  await fs.mkdir(dir, { recursive: true });

  const statePath = path.join(dir, "state.yaml");
  await fs.writeFile(statePath, yaml.stringify(state), "utf-8");
}

/**
 * Loads the deployment state
 */
export async function loadDeploymentState(
  name: string,
): Promise<DeploymentState | null> {
  const statePath = path.join(getDeploymentDir(name), "state.yaml");
  try {
    const content = await fs.readFile(statePath, "utf-8");
    return yaml.parse(content) as DeploymentState;
  } catch {
    return null;
  }
}

/**
 * Saves the generated Helm values
 */
export async function saveHelmValues(
  name: string,
  values: Record<string, unknown>,
): Promise<string> {
  const dir = getDeploymentDir(name);
  await fs.mkdir(dir, { recursive: true });

  const valuesPath = path.join(dir, "values.yaml");
  await fs.writeFile(valuesPath, yaml.stringify(values), "utf-8");
  return valuesPath;
}

/**
 * Loads the Helm values
 */
export async function loadHelmValues(
  name: string,
): Promise<Record<string, unknown> | null> {
  const valuesPath = path.join(getDeploymentDir(name), "values.yaml");
  try {
    const content = await fs.readFile(valuesPath, "utf-8");
    return yaml.parse(content) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/**
 * Gets the Helm values file path
 */
export function getHelmValuesPath(name: string): string {
  return path.join(getDeploymentDir(name), "values.yaml");
}

/**
 * Saves Terraform variables
 */
export async function saveTerraformVars(
  name: string,
  vars: Record<string, unknown>,
): Promise<string> {
  const dir = path.join(getDeploymentDir(name), "terraform");
  await fs.mkdir(dir, { recursive: true });

  // Convert to HCL-compatible format
  let content = "";
  for (const [key, value] of Object.entries(vars)) {
    if (typeof value === "string") {
      content += `${key} = "${value}"\n`;
    } else if (typeof value === "number" || typeof value === "boolean") {
      content += `${key} = ${value}\n`;
    } else {
      content += `${key} = ${JSON.stringify(value)}\n`;
    }
  }

  const varsPath = path.join(dir, "terraform.tfvars");
  await fs.writeFile(varsPath, content, "utf-8");
  return varsPath;
}

/**
 * Gets the Terraform working directory
 */
export function getTerraformDir(name: string): string {
  return path.join(getDeploymentDir(name), "terraform");
}

/**
 * Deletes a deployment and all its files
 */
export async function deleteDeployment(name: string): Promise<void> {
  const dir = getDeploymentDir(name);
  await fs.rm(dir, { recursive: true, force: true });
}

/**
 * Updates the deployment state status
 */
export async function updateDeploymentStatus(
  name: string,
  status: DeploymentState["status"],
  updates?: Partial<DeploymentState>,
): Promise<void> {
  const state = await loadDeploymentState(name);
  if (state) {
    // Deep merge nested objects like application, infrastructure, dnsRecords
    const updatedState: DeploymentState = {
      ...state,
      ...updates,
      // Deep merge application object to preserve existing fields
      application: updates?.application
        ? { ...state.application, ...updates.application }
        : state.application,
      // Deep merge infrastructure object
      infrastructure: updates?.infrastructure
        ? { ...state.infrastructure, ...updates.infrastructure }
        : state.infrastructure,
      status,
      updatedAt: new Date().toISOString(),
    };
    await saveDeploymentState(name, updatedState);
  }
}

// ============================================================================
// Profile Management - Persistent user preferences across deployments
// ============================================================================

/**
 * Extracts the domain suffix from a full domain.
 * e.g., "app.example.com" -> ".example.com"
 * e.g., "sub.app.example.com" -> ".app.example.com"
 */
export function extractDomainSuffix(domain: string): string | undefined {
  if (!domain) return undefined;
  const parts = domain.split(".");
  if (parts.length < 2) return undefined;
  // Return everything after the first segment
  return "." + parts.slice(1).join(".");
}

/**
 * Loads the user profile from ~/.rulebricks/profile.yaml
 * Returns null if the profile doesn't exist or is invalid
 */
export async function loadProfile(): Promise<ProfileConfig | null> {
  const profilePath = path.join(RULEBRICKS_DIR, PROFILE_FILE);
  try {
    const content = await fs.readFile(profilePath, "utf-8");
    const data = yaml.parse(content);
    return ProfileConfigSchema.parse(data);
  } catch {
    return null;
  }
}

/**
 * Saves the user profile to ~/.rulebricks/profile.yaml
 */
export async function saveProfile(profile: ProfileConfig): Promise<void> {
  await fs.mkdir(RULEBRICKS_DIR, { recursive: true });
  const profilePath = path.join(RULEBRICKS_DIR, PROFILE_FILE);

  // Filter out undefined values to keep the file clean
  const cleanProfile = Object.fromEntries(
    Object.entries(profile).filter(([_, v]) => v !== undefined),
  );

  await fs.writeFile(profilePath, yaml.stringify(cleanProfile), "utf-8");
}

/**
 * Extracts profile-worthy values from a deployment configuration.
 * These are values that are likely to be reused across deployments.
 */
export function extractProfileFromConfig(
  config: DeploymentConfig,
): ProfileConfig {
  return {
    // Infrastructure
    provider: config.infrastructure.provider,
    region: config.infrastructure.region,
    clusterName: config.infrastructure.clusterName,
    infrastructureMode: config.infrastructure.mode,

    // Domain - store suffix for suggesting new domains
    domainSuffix: extractDomainSuffix(config.domain),
    adminEmail: config.adminEmail,
    tlsEmail: config.tlsEmail,
    dnsProvider: config.dns.provider,

    // SMTP
    smtpHost: config.smtp.host,
    smtpPort: config.smtp.port,
    smtpUser: config.smtp.user,
    smtpPass: config.smtp.pass,
    smtpFrom: config.smtp.from,
    smtpFromName: config.smtp.fromName,

    // API Keys
    openaiApiKey: config.features.ai.openaiApiKey,
    licenseKey: config.licenseKey,

    // Preferences
    tier: config.tier,
    databaseType: config.database.type,

    // SSO
    ssoProvider: config.features.sso.provider,
    ssoUrl: config.features.sso.url,
    ssoClientId: config.features.sso.clientId,
    ssoClientSecret: config.features.sso.clientSecret,
  };
}

/**
 * Merges a new profile with an existing one, preferring new non-undefined values.
 * This allows incremental updates without losing existing preferences.
 */
export async function updateProfile(newValues: ProfileConfig): Promise<void> {
  const existing = await loadProfile();
  const merged: ProfileConfig = {
    ...existing,
    ...Object.fromEntries(
      Object.entries(newValues).filter(([_, v]) => v !== undefined),
    ),
  };
  await saveProfile(merged);
}
