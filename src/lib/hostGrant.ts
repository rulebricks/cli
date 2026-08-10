import type {
  DeploymentConfig,
  LinkedHostGrant,
} from "../types/index.js";
import { shouldMirrorToAcr } from "./cloudCli.js";
import { secretModeForConfig } from "./deploySequence.js";

export interface HostRoleGrant {
  role: string;
  scope: string;
  scopeLabel: string;
  reason: string;
}

export interface AzureHostGrantFacts {
  clusterId: string;
  resourceGroupId: string;
  entraRbacEnabled: boolean;
  keyVaultId?: string;
  acrId?: string;
}

export interface HostGrantDeniedBinding {
  subject: string;
  command: string;
}

export const AZURE_CLUSTER_USER_ROLE =
  "Azure Kubernetes Service Cluster User Role";
export const AZURE_CLUSTER_ADMIN_ROLE =
  "Azure Kubernetes Service RBAC Cluster Admin";
export const KEY_VAULT_SECRETS_OFFICER_ROLE =
  "Key Vault Secrets Officer";
export const CONTRIBUTOR_ROLE = "Contributor";
export const ACR_PULL_ROLE = "AcrPull";

function grantKey(grant: Pick<HostRoleGrant, "role" | "scope">): string {
  return `${grant.role.toLowerCase()}\0${grant.scope.toLowerCase()}`;
}

/**
 * The managed identity only receives access that this deployment's current
 * configuration needs. Resource discovery happens separately so this remains
 * deterministic and testable.
 */
export function deriveHostGrantPlan(
  config: DeploymentConfig,
  facts: AzureHostGrantFacts,
): HostRoleGrant[] {
  if (config.infrastructure.provider !== "azure") {
    throw new Error("Deploy host grants currently support Azure deployments only.");
  }
  if (!config.infrastructure.clusterName) {
    throw new Error("The deployment config is missing an AKS cluster name.");
  }
  if (!config.infrastructure.azureResourceGroup) {
    throw new Error("The deployment config is missing an Azure resource group.");
  }

  const grants: HostRoleGrant[] = [
    {
      role: AZURE_CLUSTER_USER_ROLE,
      scope: facts.clusterId,
      scopeLabel: `AKS ${config.infrastructure.clusterName}`,
      reason: "Refresh kubeconfig credentials from the deploy host",
    },
  ];

  if (facts.entraRbacEnabled) {
    grants.push({
      role: AZURE_CLUSTER_ADMIN_ROLE,
      scope: facts.clusterId,
      scopeLabel: `AKS ${config.infrastructure.clusterName}`,
      reason: "Run Kubernetes and Helm operations on an Entra RBAC cluster",
    });
  }

  const usesKeyVault =
    secretModeForConfig(config) === "eso" &&
    config.secrets?.backend === "azure-key-vault";
  if (usesKeyVault) {
    if (!facts.keyVaultId) {
      throw new Error(
        "The deployment uses Azure Key Vault, but its resource ID could not be resolved.",
      );
    }
    grants.push({
      role: KEY_VAULT_SECRETS_OFFICER_ROLE,
      scope: facts.keyVaultId,
      scopeLabel: `Key Vault ${config.secrets?.azure?.vaultName ?? ""}`.trim(),
      reason: "Seed and rotate deployment secrets",
    });
  }

  if (shouldMirrorToAcr(config)) {
    if (!facts.acrId) {
      throw new Error(
        "The deployment mirrors images to ACR, but its resource ID could not be resolved.",
      );
    }
    const registryName = config.imageRegistry?.split(".")[0] ?? "registry";
    grants.push(
      {
        role: CONTRIBUTOR_ROLE,
        scope: facts.acrId,
        scopeLabel: `ACR ${registryName}`,
        reason: "Import mirrored images and Helm charts",
      },
      {
        role: ACR_PULL_ROLE,
        scope: facts.acrId,
        scopeLabel: `ACR ${registryName}`,
        reason: "Authenticate Helm to the mirrored chart registry",
      },
    );
  }

  grants.push({
    role: CONTRIBUTOR_ROLE,
    scope: facts.resourceGroupId,
    scopeLabel: `resource group ${config.infrastructure.azureResourceGroup}`,
    reason: "Run deployment-level Azure setup and checks",
  });

  return grants;
}

/** Return grants not already recorded as successfully available on this host. */
export function diffHostGrants(
  planned: HostRoleGrant[],
  persisted: LinkedHostGrant[] = [],
): HostRoleGrant[] {
  const available = new Set(
    persisted
      .filter((grant) => grant.status === "granted")
      .map((grant) => grantKey(grant)),
  );
  return planned.filter((grant) => !available.has(grantKey(grant)));
}

/** Pull the containing resource-group scope from a full Azure resource ID. */
export function azureResourceGroupScope(resourceId: string): string {
  const match = resourceId.match(
    /^\/subscriptions\/[^/]+\/resourceGroups\/[^/]+/i,
  );
  if (!match) {
    throw new Error(`Invalid Azure resource ID: ${resourceId}`);
  }
  return match[0];
}

export function formatGrantDeniedWarning(
  denied: HostGrantDeniedBinding[],
): string {
  return [
    "Some host access grants need a cloud administrator:",
    ...denied.map((item) => `  - ${item.subject}`),
    "Ask an administrator to run (skip any that already exist):",
    ...denied.map((item) => `  ${item.command}`),
  ].join("\n");
}
