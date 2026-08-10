import test from "node:test";
import assert from "node:assert/strict";
import type {
  DeploymentConfig,
  LinkedHostGrant,
} from "../types/index.js";
import {
  ACR_PULL_ROLE,
  AZURE_CLUSTER_ADMIN_ROLE,
  AZURE_CLUSTER_USER_ROLE,
  CONTRIBUTOR_ROLE,
  KEY_VAULT_SECRETS_OFFICER_ROLE,
  READER_ROLE,
  azureResourceGroupScope,
  deriveHostGrantPlan,
  diffHostGrants,
  formatGrantDeniedWarning,
  type AzureHostGrantFacts,
} from "./hostGrant.js";

const CLUSTER_ID =
  "/subscriptions/sub/resourceGroups/rg/providers/Microsoft.ContainerService/managedClusters/aks";
const RESOURCE_GROUP_ID = "/subscriptions/sub/resourceGroups/rg";
const KEY_VAULT_ID =
  "/subscriptions/sub/resourceGroups/rg/providers/Microsoft.KeyVault/vaults/vault";
const ACR_ID =
  "/subscriptions/sub/resourceGroups/rg/providers/Microsoft.ContainerRegistry/registries/acr";
const ACS_ID =
  "/subscriptions/sub/resourceGroups/shared-services/providers/Microsoft.Communication/communicationServices/acs";

function config(
  overrides: Partial<Pick<
    DeploymentConfig,
    "secrets" | "imageRegistry" | "imageRegistryMode" | "smtp"
  >> = {},
): DeploymentConfig {
  return {
    name: "test",
    infrastructure: {
      mode: "existing",
      provider: "azure",
      region: "westus",
      clusterName: "aks",
      azureResourceGroup: "rg",
    },
    secrets: { backend: "cluster" },
    ...overrides,
  } as unknown as DeploymentConfig;
}

function facts(
  overrides: Partial<AzureHostGrantFacts> = {},
): AzureHostGrantFacts {
  return {
    clusterId: CLUSTER_ID,
    resourceGroupId: RESOURCE_GROUP_ID,
    entraRbacEnabled: false,
    ...overrides,
  };
}

test("deriveHostGrantPlan grants baseline AKS and resource-group access", () => {
  const grants = deriveHostGrantPlan(config(), facts());
  assert.deepEqual(
    grants.map((grant) => [grant.role, grant.scope]),
    [
      [AZURE_CLUSTER_USER_ROLE, CLUSTER_ID],
      [CONTRIBUTOR_ROLE, RESOURCE_GROUP_ID],
    ],
  );
});

test("deriveHostGrantPlan adds Entra RBAC cluster admin", () => {
  const grants = deriveHostGrantPlan(
    config(),
    facts({ entraRbacEnabled: true }),
  );
  assert.ok(grants.some((grant) => grant.role === AZURE_CLUSTER_ADMIN_ROLE));
});

test("deriveHostGrantPlan adds Key Vault writer access only when configured", () => {
  const grants = deriveHostGrantPlan(
    config({
      secrets: {
        backend: "azure-key-vault",
        azure: { vaultName: "vault" },
      },
    }),
    facts({ keyVaultId: KEY_VAULT_ID }),
  );
  assert.ok(
    grants.some(
      (grant) =>
        grant.role === KEY_VAULT_SECRETS_OFFICER_ROLE &&
        grant.scope === KEY_VAULT_ID,
    ),
  );
});

test("deriveHostGrantPlan adds ACR import and pull access for mirror mode", () => {
  const grants = deriveHostGrantPlan(
    config({
      imageRegistry: "acr.azurecr.io",
      imageRegistryMode: "mirror",
    }),
    facts({ acrId: ACR_ID }),
  );
  assert.ok(
    grants.some(
      (grant) => grant.role === CONTRIBUTOR_ROLE && grant.scope === ACR_ID,
    ),
  );
  assert.ok(
    grants.some(
      (grant) => grant.role === ACR_PULL_ROLE && grant.scope === ACR_ID,
    ),
  );
});

test("deriveHostGrantPlan adds Reader for ACS in an external resource group", () => {
  const grants = deriveHostGrantPlan(
    config({
      smtp: {
        host: "smtp.azurecomm.net",
        port: 587,
        user: "smtp-user",
        pass: "smtp-password",
        from: "DoNotReply@example.azurecomm.net",
        fromName: "Rulebricks",
        azure: {
          communicationServiceId: ACS_ID,
          entraApplicationId: "11111111-1111-4111-8111-111111111111",
        },
      },
    }),
    facts(),
  );
  assert.ok(
    grants.some(
      (grant) =>
        grant.role === READER_ROLE &&
        grant.scope === "/subscriptions/sub/resourceGroups/shared-services",
    ),
  );
});

test("deriveHostGrantPlan reuses deployment-group Contributor for ACS reads", () => {
  const grants = deriveHostGrantPlan(
    config({
      smtp: {
        host: "smtp.azurecomm.net",
        port: 587,
        user: "smtp-user",
        pass: "smtp-password",
        from: "DoNotReply@example.azurecomm.net",
        fromName: "Rulebricks",
        azure: {
          communicationServiceId: `${RESOURCE_GROUP_ID}/providers/Microsoft.Communication/communicationServices/acs`,
          entraApplicationId: "11111111-1111-4111-8111-111111111111",
        },
      },
    }),
    facts(),
  );
  assert.equal(grants.filter((grant) => grant.role === READER_ROLE).length, 0);
});

test("deriveHostGrantPlan rejects non-Azure deployments", () => {
  const nonAzure = config();
  nonAzure.infrastructure.provider = "aws";
  assert.throws(
    () => deriveHostGrantPlan(nonAzure, facts()),
    /supports Azure deployments only/,
  );
});

test("diffHostGrants skips only successfully persisted grants", () => {
  const planned = deriveHostGrantPlan(config(), facts());
  const persisted: LinkedHostGrant[] = [
    {
      role: planned[0].role.toUpperCase(),
      scope: planned[0].scope.toUpperCase(),
      status: "granted",
      createdByRulebricks: true,
    },
    {
      role: planned[1].role,
      scope: planned[1].scope,
      status: "pending",
      createdByRulebricks: false,
    },
  ];
  assert.deepEqual(diffHostGrants(planned, persisted), [planned[1]]);
});

test("azureResourceGroupScope extracts the parent resource group", () => {
  assert.equal(azureResourceGroupScope(CLUSTER_ID), RESOURCE_GROUP_ID);
  assert.throws(
    () => azureResourceGroupScope("not-an-azure-resource-id"),
    /Invalid Azure resource ID/,
  );
});

test("formatGrantDeniedWarning includes subjects and admin commands", () => {
  const message = formatGrantDeniedWarning([
    {
      subject: "Contributor on resource group rg",
      command: "az role assignment create --role Contributor",
    },
  ]);
  assert.match(message, /Contributor on resource group rg/);
  assert.match(message, /az role assignment create --role Contributor/);
});
