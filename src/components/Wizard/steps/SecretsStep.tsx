import React, { useState } from "react";
import { Box, Text } from "ink";
import { useWizard } from "../WizardContext.js";
import { useFieldFlow, FlowField } from "../fieldFlow.js";
import {
  BorderBox,
  CheckRows,
  FieldError,
  StepFooter,
  TextField,
  WizardSelect,
  DiscoveredSelect,
  useTheme,
} from "../../common/index.js";
import { SecretsBackend } from "../../../types/index.js";
import {
  listIamRoles,
  listAzureKeyVaults,
  listAzureWorkloadIdentities,
  getAzureTenantId,
  listGcpServiceAccounts,
} from "../../../lib/cloudCli.js";
import { listSecretStores } from "../../../lib/eso.js";
import {
  findClusterSetupDefaultIndex,
  isAwsInfrastructureRoleName,
} from "../../../lib/clusterSetupDefaults.js";

interface SecretsStepProps {
  onComplete: () => void;
  onBack: () => void;
  entryDirection?: "forward" | "back";
}

// The cloud path chosen earlier filters the backends: only the matching
// native manager is offered (nobody deploys on AWS and uses Key Vault),
// followed by the cloud-agnostic options.
function backendChoices(
  provider: string | null,
): { label: string; value: SecretsBackend }[] {
  const native: { label: string; value: SecretsBackend }[] =
    provider === "azure"
      ? [{ label: "Azure Key Vault (recommended)", value: "azure-key-vault" }]
      : provider === "gcp"
        ? [
            {
              label: "GCP Secret Manager (recommended)",
              value: "gcp-secret-manager",
            },
          ]
        : [
            {
              label: "AWS Secrets Manager (recommended)",
              value: "aws-secrets-manager",
            },
          ];
  return [
    ...native,
    {
      label: "Other secrets platform (existing ESO SecretStore)",
      value: "byo-secret-store",
    },
    {
      label: "Plain cluster Secrets (dev/test only)",
      value: "cluster",
    },
  ];
}

const NATIVE_BACKENDS: SecretsBackend[] = [
  "aws-secrets-manager",
  "azure-key-vault",
  "gcp-secret-manager",
];

export function SecretsStep({
  onComplete,
  onBack,
  entryDirection,
}: SecretsStepProps) {
  const { state, dispatch } = useWizard();
  const { colors } = useTheme();
  const [error, setError] = useState<string | null>(null);

  const defaultBackend = backendChoices(state.provider)[0].value;
  const [backend, setBackend] = useState<SecretsBackend | null>(
    state.secretsBackend,
  );
  const [prefix, setPrefix] = useState(state.secretsPrefix || "");
  const [awsRoleArn, setAwsRoleArn] = useState(state.secretsAwsRoleArn || "");
  const [roleManual, setRoleManual] = useState(false);
  const [vaultName, setVaultName] = useState(state.secretsAzureVaultName || "");
  const [vaultManual, setVaultManual] = useState(false);
  const [azureClientId, setAzureClientId] = useState(
    state.secretsAzureClientId || "",
  );
  const [identityManual, setIdentityManual] = useState(false);
  const [gcpServiceAccount, setGcpServiceAccount] = useState(
    state.secretsGcpServiceAccountEmail || "",
  );
  const [gsaManual, setGsaManual] = useState(false);
  const [byoStore, setByoStore] = useState(state.secretsByoStoreName || "");
  const [byoManual, setByoManual] = useState(false);

  // Same relevance narrowing the storage step uses for cluster-setup resources.
  const relevantToRulebricks = (name: string): boolean => {
    const n = name.toLowerCase();
    const clusterName = (state.clusterName || "").toLowerCase();
    return (
      n.includes("rulebricks") ||
      n.includes("secret") ||
      (clusterName !== "" && n.includes(clusterName))
    );
  };

  const isNative = () => backend !== null && NATIVE_BACKENDS.includes(backend);
  const prefixPlaceholder =
    backend === "aws-secrets-manager"
      ? "rulebricks/<deployment>"
      : "rulebricks-<deployment>";

  const saveSecrets = (
    config: Extract<
      Parameters<typeof dispatch>[0],
      { type: "SET_SECRETS_CONFIG" }
    >["config"],
  ) => {
    dispatch({ type: "SET_SECRETS_CONFIG", config });
  };

  const fields: FlowField[] = [
    {
      id: "backend",
      render: (flow) => (
        <WizardSelect
          label="Where should this deployment's secrets live?"
          hint={
            "The External Secrets Operator syncs your secrets platform into the cluster - the enterprise default. " +
            "Plain cluster Secrets skip the platform entirely (dev/test)."
          }
          items={backendChoices(state.provider)}
          initialValue={backend ?? defaultBackend}
          onSelect={(value) => {
            const selected = value as SecretsBackend;
            setBackend(selected);
            saveSecrets({ secretsBackend: selected });
            flow.next();
          }}
        />
      ),
    },

    // ----- Native managers: entry name prefix -----
    {
      id: "prefix",
      when: isNative,
      render: (flow) => (
        <TextField
          label="Secrets manager entry prefix"
          hint={`Entries are seeded under this prefix (e.g. ${prefixPlaceholder}-app). Leave empty for the default, derived from the deployment name.`}
          value={prefix}
          onChange={setPrefix}
          placeholder={prefixPlaceholder}
          onSubmit={() => {
            setError(null);
            saveSecrets({ secretsPrefix: prefix.trim() });
            flow.next();
          }}
        />
      ),
    },

    // ----- AWS: external-secrets Pod Identity role -----
    {
      id: "aws-role",
      when: () => backend === "aws-secrets-manager" && !roleManual,
      render: (flow) => (
        <DiscoveredSelect
          label="Select the external-secrets IAM role"
          hint={`Read-only role from cluster-setup (${state.clusterName || "<cluster>"}-external-secrets) the External Secrets Operator assumes to read the entries.`}
          loadingLabel="Loading IAM roles..."
          emptyHint="None found. Press R to refresh or enter an ARN manually."
          load={async () => {
            const roles = (await listIamRoles()).filter(
              (r) => !isAwsInfrastructureRoleName(r.name),
            );
            const narrowed = roles.filter((r) => relevantToRulebricks(r.name));
            return (narrowed.length > 0 ? narrowed : roles).map((r) => ({
              label: r.name,
              value: r.arn,
            }));
          }}
          recommendIndex={(items) =>
            findClusterSetupDefaultIndex(
              items.map((item) => item.label),
              "secrets-identity",
              { provider: "aws", clusterName: state.clusterName },
            )
          }
          noRecommendationNotice={`No ${state.clusterName || "<cluster>"}-external-secrets role found. Deploy the cluster-setup stack with EnableExternalSecrets=true (the default), press R to refresh, or enter the role ARN manually.`}
          initialValue={awsRoleArn || undefined}
          onSelect={(value) => {
            setAwsRoleArn(value);
            saveSecrets({ secretsAwsRoleArn: value });
            flow.next();
          }}
          onManual={() => {
            setRoleManual(true);
            flow.next();
          }}
        />
      ),
    },
    {
      id: "aws-role-manual",
      onEscape: () => setRoleManual(false),
      when: () => backend === "aws-secrets-manager" && roleManual,
      render: (flow) => (
        <TextField
          label="External-secrets IAM role ARN"
          value={awsRoleArn}
          onChange={setAwsRoleArn}
          placeholder="arn:aws:iam::123456789012:role/rulebricks-cluster-external-secrets"
          onSubmit={() => {
            if (!awsRoleArn.startsWith("arn:")) {
              setError("Enter a valid IAM role ARN (arn:aws:iam::...)");
              return;
            }
            setError(null);
            saveSecrets({ secretsAwsRoleArn: awsRoleArn });
            flow.next();
          }}
        />
      ),
    },

    // ----- Azure: Key Vault + external-secrets workload identity -----
    {
      id: "azure-vault",
      when: () => backend === "azure-key-vault" && !vaultManual,
      render: (flow) => (
        <DiscoveredSelect
          label="Select the Key Vault"
          hint="The vault holding this deployment's secrets - from cluster-setup (keyVaultName output) or any existing RBAC-enabled vault. Create one and press R to refresh."
          loadingLabel="Loading Key Vaults..."
          emptyHint="None found. Press R to refresh or enter a vault name manually."
          load={async () =>
            (await listAzureKeyVaults()).map((v) => ({
              label: v.name,
              value: v.name,
            }))
          }
          recommendIndex={(items) =>
            findClusterSetupDefaultIndex(
              items.map((item) => item.label),
              "secrets-vault",
              { provider: "azure", clusterName: state.clusterName },
            )
          }
          initialValue={vaultName || undefined}
          onSelect={(value) => {
            setVaultName(value);
            saveSecrets({
              secretsAzureVaultName: value,
              secretsAzureVaultUri: `https://${value}.vault.azure.net`,
            });
            flow.next();
          }}
          onManual={() => {
            setVaultManual(true);
            flow.next();
          }}
        />
      ),
    },
    {
      id: "azure-vault-manual",
      onEscape: () => setVaultManual(false),
      when: () => backend === "azure-key-vault" && vaultManual,
      render: (flow) => (
        <TextField
          label="Key Vault name"
          value={vaultName}
          onChange={setVaultName}
          placeholder="rulebricks-kv"
          onSubmit={() => {
            if (!vaultName.trim()) {
              setError("Key Vault name is required");
              return;
            }
            setError(null);
            saveSecrets({
              secretsAzureVaultName: vaultName.trim(),
              secretsAzureVaultUri: `https://${vaultName.trim()}.vault.azure.net`,
            });
            flow.next();
          }}
        />
      ),
    },
    {
      id: "azure-identity",
      when: () => backend === "azure-key-vault" && !identityManual,
      render: (flow) => (
        <DiscoveredSelect
          label="Select the external-secrets workload identity"
          hint={`The identity from cluster-setup (${state.clusterName || "<cluster>"}-external-secrets, externalSecretsClientId output) with Key Vault Secrets User on the vault.`}
          loadingLabel="Loading managed identities..."
          emptyHint="None found. Press R to refresh or enter a client ID manually."
          load={async () => {
            const [identities, tenant] = await Promise.all([
              listAzureWorkloadIdentities(state.clusterName),
              getAzureTenantId(),
            ]);
            if (tenant) {
              saveSecrets({ secretsAzureTenantId: tenant });
            }
            return identities.map((identity) => ({
              label: identity.name,
              value: identity.clientId,
            }));
          }}
          recommendIndex={(items) =>
            findClusterSetupDefaultIndex(
              items.map((item) => item.label),
              "secrets-identity",
              { provider: "azure", clusterName: state.clusterName },
            )
          }
          noRecommendationNotice={`No ${state.clusterName || "<cluster>"}-external-secrets identity found. Deploy cluster-setup with enableKeyVaultIntegration=true, press R to refresh, or enter the client ID manually.`}
          initialValue={azureClientId || undefined}
          onSelect={(value) => {
            setAzureClientId(value);
            saveSecrets({ secretsAzureClientId: value });
            flow.next();
          }}
          onManual={() => {
            setIdentityManual(true);
            flow.next();
          }}
        />
      ),
    },
    {
      id: "azure-identity-manual",
      onEscape: () => setIdentityManual(false),
      when: () => backend === "azure-key-vault" && identityManual,
      render: (flow) => (
        <TextField
          label="External-secrets identity client ID"
          value={azureClientId}
          onChange={setAzureClientId}
          placeholder="00000000-0000-0000-0000-000000000000"
          onSubmit={() => {
            if (!azureClientId.trim()) {
              setError("Client ID is required");
              return;
            }
            setError(null);
            saveSecrets({ secretsAzureClientId: azureClientId.trim() });
            flow.next();
          }}
        />
      ),
    },

    // ----- GCP: external-secrets Google service account -----
    {
      id: "gcp-sa",
      when: () => backend === "gcp-secret-manager" && !gsaManual,
      render: (flow) => (
        <DiscoveredSelect
          label="Select the external-secrets Google service account"
          hint={`The read-only GSA from cluster-setup (${state.clusterName || "<cluster>"}-secrets, external_secrets_service_account output).`}
          loadingLabel="Loading service accounts..."
          emptyHint="None found. Press R to refresh or enter an email manually."
          load={async () => {
            const accounts = await listGcpServiceAccounts();
            const narrowed = accounts.filter((a) =>
              relevantToRulebricks(a.email),
            );
            return (narrowed.length > 0 ? narrowed : accounts).map((a) => ({
              label: a.email,
              value: a.email,
            }));
          }}
          recommendIndex={(items) =>
            findClusterSetupDefaultIndex(
              items.map((item) => item.value),
              "secrets-identity",
              { provider: "gcp", clusterName: state.clusterName },
            )
          }
          noRecommendationNotice={`No ${state.clusterName || "<cluster>"}-secrets service account found. Apply cluster-setup with enable_external_secrets=true (the default), press R to refresh, or enter its email manually.`}
          initialValue={gcpServiceAccount || undefined}
          onSelect={(value) => {
            setGcpServiceAccount(value);
            saveSecrets({ secretsGcpServiceAccountEmail: value });
            flow.next();
          }}
          onManual={() => {
            setGsaManual(true);
            flow.next();
          }}
        />
      ),
    },
    {
      id: "gcp-sa-manual",
      onEscape: () => setGsaManual(false),
      when: () => backend === "gcp-secret-manager" && gsaManual,
      render: (flow) => (
        <TextField
          label="External-secrets service account email"
          value={gcpServiceAccount}
          onChange={setGcpServiceAccount}
          placeholder="rulebricks-cluster-secrets@project.iam.gserviceaccount.com"
          onSubmit={() => {
            if (!gcpServiceAccount.includes("@")) {
              setError("Enter a valid service account email");
              return;
            }
            setError(null);
            saveSecrets({ secretsGcpServiceAccountEmail: gcpServiceAccount });
            flow.next();
          }}
        />
      ),
    },

    // ----- BYO: existing (Cluster)SecretStore -----
    {
      id: "byo-store",
      when: () => backend === "byo-secret-store" && !byoManual,
      render: (flow) => (
        <DiscoveredSelect
          label="Select your existing secret store"
          hint="Any External Secrets Operator (Cluster)SecretStore already on the cluster - HashiCorp Vault, 1Password, Doppler, and every other ESO provider work. You seed the entries in your platform; the CLI only wires the sync."
          loadingLabel="Looking for SecretStores on the cluster..."
          emptyHint="None found (is kubectl pointed at the cluster, with ESO installed?). Press R to refresh or enter a name manually."
          load={async () => {
            const stores = await listSecretStores(
              `rulebricks-${state.name || ""}`,
            );
            return stores.map((store) => ({
              label: `${store.name} (${store.kind})`,
              value: `${store.kind}:${store.name}`,
            }));
          }}
          initialValue={
            byoStore
              ? `${state.secretsByoStoreKind}:${byoStore}`
              : undefined
          }
          onSelect={(value) => {
            const [kind, name] = value.split(":", 2);
            setByoStore(name);
            saveSecrets({
              secretsByoStoreName: name,
              secretsByoStoreKind: kind as "SecretStore" | "ClusterSecretStore",
            });
            flow.next();
          }}
          onManual={() => {
            setByoManual(true);
            flow.next();
          }}
        />
      ),
    },
    {
      id: "byo-store-manual",
      onEscape: () => setByoManual(false),
      when: () => backend === "byo-secret-store" && byoManual,
      render: (flow) => (
        <TextField
          label="ClusterSecretStore name"
          hint="The store must exist before deploy; a namespaced SecretStore also works if it lives in this deployment's namespace."
          value={byoStore}
          onChange={setByoStore}
          placeholder="my-vault-store"
          onSubmit={() => {
            if (!byoStore.trim()) {
              setError("Secret store name is required");
              return;
            }
            setError(null);
            saveSecrets({
              secretsByoStoreName: byoStore.trim(),
              secretsByoStoreKind: "ClusterSecretStore",
            });
            flow.next();
          }}
        />
      ),
    },
  ];

  const flow = useFieldFlow({
    fields,
    onDone: onComplete,
    onExit: onBack,
    entry: entryDirection === "back" ? "end" : "start",
    onNavigate: () => setError(null),
  });

  const progress = () => {
    const rows: { label: string }[] = [];
    if (backend && flow.current !== "backend") {
      rows.push({
        label: `Backend: ${
          backendChoices(state.provider).find((c) => c.value === backend)
            ?.label ?? backend
        }`,
      });
    }
    return rows;
  };

  return (
    <BorderBox title="Secrets">
      {flow.render()}

      {backend === "cluster" && flow.current === "backend" && (
        <Box marginTop={1}>
          <Text color={colors.muted} dimColor>
            Plain cluster Secrets are fine for evaluation, but production
            deployments should sync from a secrets platform.
          </Text>
        </Box>
      )}

      <CheckRows rows={progress()} />
      <FieldError error={error} />
      <StepFooter />
    </BorderBox>
  );
}
