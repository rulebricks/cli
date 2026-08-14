import { test } from "node:test";
import assert from "node:assert/strict";
import {
  esoSecretEntries,
  buildEsoManifests,
  defaultSecretsPrefix,
  formatSeedDeniedHint,
  isEsoBackend,
  mergeMissingSecretKeys,
  obsoleteEsoSecretEntries,
  reconcileManagedSecretKeys,
} from "./eso.js";
import {
  buildDeploymentSecretMergePatch,
  buildDeploymentSecrets,
  deploymentSecretInventory,
  isDeploymentOwnedSecretResource,
  obsoleteDeploymentSecretNames,
} from "./secrets.js";
import { deploymentSecretNames } from "./helmValues.js";
import { secretModeForConfig } from "./deploySequence.js";
import { buildConfigMatrix } from "./configFixtures.js";
import { DeploymentConfig } from "../types/index.js";

function fixture(name: string): DeploymentConfig {
  const found = buildConfigMatrix().find((c) => c.name === name);
  assert.ok(found, `fixture ${name} exists`);
  return structuredClone(found!.config);
}

function withBackend(
  config: DeploymentConfig,
  secrets: DeploymentConfig["secrets"],
): DeploymentConfig {
  return { ...config, secrets };
}

test("secretModeForConfig: cluster/absent -> k8s, everything else -> eso", () => {
  const base = fixture("aws-self-hosted-minimal");
  assert.equal(secretModeForConfig(base), "k8s");
  assert.equal(
    secretModeForConfig(withBackend(base, { backend: "cluster" })),
    "k8s",
  );
  assert.equal(
    secretModeForConfig(withBackend(base, { backend: "aws-secrets-manager" })),
    "eso",
  );
  assert.equal(
    secretModeForConfig(withBackend(base, { backend: "byo-secret-store" })),
    "eso",
  );
  assert.equal(isEsoBackend(base), false);
});

test("eso entries mirror buildDeploymentSecrets exactly (same Secrets, same keys)", () => {
  const config = withBackend(fixture("aws-all-features"), {
    backend: "aws-secrets-manager",
    aws: { roleArn: "arn:aws:iam::1:role/x" },
  });
  const entries = esoSecretEntries(config);
  const direct = buildDeploymentSecrets(config);

  assert.deepEqual(
    entries.map((e) => e.k8sName).sort(),
    direct.map((s) => s.name).sort(),
  );
  for (const entry of entries) {
    const secret = direct.find((s) => s.name === entry.k8sName)!;
    assert.deepEqual(
      entry.keys.sort(),
      Object.keys(secret.stringData).sort(),
      `${entry.k8sName} keys`,
    );
    assert.deepEqual(JSON.parse(entry.json), secret.stringData);
  }
});

test("provider entry names: AWS uses / paths; Azure/GCP never contain /", () => {
  const base = fixture("aws-self-hosted-minimal");

  const aws = esoSecretEntries(
    withBackend(base, { backend: "aws-secrets-manager" }),
  );
  assert.ok(aws.every((e) => e.remoteKey.startsWith(`rulebricks/${base.name}/`)));

  const azure = esoSecretEntries(
    withBackend(base, { backend: "azure-key-vault" }),
  );
  assert.ok(azure.every((e) => !e.remoteKey.includes("/")));
  assert.ok(azure.every((e) => e.remoteKey.startsWith(`rulebricks-${base.name}-`)));

  // A custom prefix with slashes is sanitized for slash-less providers.
  const custom = esoSecretEntries(
    withBackend(base, { backend: "gcp-secret-manager", prefix: "acme/prod" }),
  );
  assert.ok(custom.every((e) => e.remoteKey.startsWith("acme-prod-")));

  assert.equal(defaultSecretsPrefix(withBackend(base, { backend: "aws-secrets-manager" })), `rulebricks/${base.name}`);
});

test("ACS API-key relay: connection-string secret created and ESO-mapped, no empty smtp secret", () => {
  const base = fixture("azure-acs-api-email");
  const names = deploymentSecretNames(base);
  const direct = buildDeploymentSecrets(base);

  const relay = direct.find((s) => s.name === names.smtpRelay);
  assert.ok(relay, "smtp-relay connection-string secret exists");
  assert.deepEqual(Object.keys(relay!.stringData), ["connection-string"]);
  assert.equal(
    relay!.stringData["connection-string"],
    base.smtp.acsApi!.connectionString,
  );

  // Credential-less mode still creates the supabase-smtp secret, with EMPTY
  // username/password: existing deployments already own this Secret via the
  // CLI/ESO, and GoTrue mounts both keys unconditionally. Same for the app
  // secret's SMTP_USER/SMTP_PASS.
  const smtp = direct.find((s) => s.name === names.smtp);
  assert.ok(smtp, "supabase-smtp secret still exists in relay mode");
  assert.deepEqual(smtp!.stringData, { username: "", password: "" });
  const app = direct.find((s) => s.name === names.app)!;
  assert.equal(app.stringData.SMTP_USER, "");
  assert.equal(app.stringData.SMTP_PASS, "");

  // ESO mode maps the relay secret with its own short name.
  const entries = esoSecretEntries(
    withBackend(base, { backend: "azure-key-vault" }),
  );
  const relayEntry = entries.find((e) => e.k8sName === names.smtpRelay);
  assert.ok(relayEntry, "relay secret has an ESO entry");
  assert.equal(
    relayEntry!.remoteKey,
    `rulebricks-${base.name}-smtp-relay`,
  );
});

test("ACS API-key relay: stale smtp credentials on the config never reach the secrets", () => {
  // Simulates a config that switched to ACS mode but still carries the old
  // SMTP credentials (hand-edited, or persisted before normalizeSmtpConfig
  // existed). GoTrue refuses plaintext SMTP AUTH to non-localhost hosts and
  // the relay ignores credentials, so leaked creds break every auth email -
  // and via reconcileManagedSecretKeys they would also resurrect inside the
  // cloud vault entry on every deploy.
  const base = fixture("azure-acs-api-email");
  base.smtp.user = "stale-user@corp.example.com";
  base.smtp.pass = "stale-password";
  const names = deploymentSecretNames(base);
  const direct = buildDeploymentSecrets(base);

  const smtp = direct.find((s) => s.name === names.smtp);
  assert.ok(smtp, "supabase-smtp secret exists in relay mode");
  assert.deepEqual(smtp!.stringData, { username: "", password: "" });

  const app = direct.find((s) => s.name === names.app)!;
  assert.equal(app.stringData.SMTP_USER, "");
  assert.equal(app.stringData.SMTP_PASS, "");

  // The ESO seed JSON is what reconciliation writes into the vault entry.
  const entries = esoSecretEntries(
    withBackend(base, { backend: "azure-key-vault" }),
  );
  const smtpEntry = entries.find((e) => e.k8sName === names.smtp);
  assert.ok(smtpEntry, "smtp secret has an ESO entry");
  assert.deepEqual(JSON.parse(smtpEntry!.json), {
    username: "",
    password: "",
  });
});

test("ExternalSecret targets are exactly the chart's secretRef names", () => {
  const config = withBackend(fixture("aws-all-features"), {
    backend: "aws-secrets-manager",
    aws: { roleArn: "arn:aws:iam::1:role/x" },
  });
  const manifests = buildEsoManifests(config) as Array<{
    kind: string;
    metadata: { name: string };
    spec?: any;
  }>;

  const externalSecrets = manifests.filter((m) => m.kind === "ExternalSecret");
  const targets = externalSecrets.map((m) => m.spec.target.name).sort();
  const names = deploymentSecretNames(config);
  const expected = buildDeploymentSecrets(config).map((s) => s.name);
  assert.deepEqual(targets, [...expected].sort());
  // The consolidated app secret (global.secrets.secretRef seam) is present.
  assert.ok(targets.includes(names.app));

  // Every ExternalSecret extracts a JSON object from the same store.
  for (const es of externalSecrets) {
    assert.equal(es.spec.secretStoreRef.name, "rulebricks-secrets");
    assert.equal(es.spec.secretStoreRef.kind, "SecretStore");
    assert.equal(es.spec.target.creationPolicy, "Owner");
    assert.equal(
      es.spec.target.template.metadata.labels["app.kubernetes.io/managed-by"],
      "rulebricks-cli",
    );
    assert.ok(es.spec.dataFrom[0].extract.key);
  }

  // AWS: SecretStore with region, no reader SA (Pod Identity targets the
  // ESO controller pod itself).
  const store = manifests.find((m) => m.kind === "SecretStore")!;
  assert.equal(store.spec.provider.aws.region, config.infrastructure.region);
  assert.equal(manifests.some((m) => m.kind === "ServiceAccount"), false);
});

test("Azure manifests carry workload-identity SA + vault URL", () => {
  const config = withBackend(fixture("azure-workload-identity"), {
    backend: "azure-key-vault",
    azure: {
      vaultName: "acme-kv",
      clientId: "11111111-1111-1111-1111-111111111111",
      tenantId: "22222222-2222-2222-2222-222222222222",
    },
  });
  const manifests = buildEsoManifests(config) as Array<{
    kind: string;
    metadata: { name: string; annotations?: Record<string, string> };
    spec?: any;
  }>;

  const sa = manifests.find((m) => m.kind === "ServiceAccount")!;
  assert.equal(sa.metadata.name, "rulebricks-secrets-reader");
  assert.equal(
    sa.metadata.annotations?.["azure.workload.identity/client-id"],
    "11111111-1111-1111-1111-111111111111",
  );

  const store = manifests.find((m) => m.kind === "SecretStore")!;
  assert.equal(store.spec.provider.azurekv.vaultUrl, "https://acme-kv.vault.azure.net");
  assert.equal(store.spec.provider.azurekv.authType, "WorkloadIdentity");
  assert.equal(
    store.spec.provider.azurekv.serviceAccountRef.name,
    "rulebricks-secrets-reader",
  );
});

test("seed-denied hint lists only the denied entries with their keys and a grant", () => {
  const config = withBackend(fixture("aws-all-features"), {
    backend: "aws-secrets-manager",
    aws: { roleArn: "arn:aws:iam::1:role/x" },
  });
  const entries = esoSecretEntries(config);
  assert.ok(entries.length >= 2, "fixture has at least two entries");
  const deniedKey = entries[0].remoteKey;
  const hint = formatSeedDeniedHint(config, [deniedKey]);

  assert.match(hint, /could not be written from this machine/);
  assert.ok(hint.includes(deniedKey), hint);
  assert.ok(
    hint.includes(entries[0].keys[0]),
    "lists the entry's JSON keys",
  );
  assert.ok(
    !hint.includes(`  ${entries[1].remoteKey}  `),
    "does not list entries that were written",
  );
  assert.match(hint, /secretsmanager:CreateSecret/);

  const azureConfig = withBackend(config, {
    backend: "azure-key-vault",
    azure: { vaultName: "corp-vault" },
  });
  const azureHint = formatSeedDeniedHint(azureConfig, [
    esoSecretEntries(azureConfig)[0].remoteKey,
  ]);
  assert.match(azureHint, /Key Vault Secrets Officer/);
});

test("byo-secret-store references the existing store and creates none", () => {
  const config = withBackend(fixture("aws-self-hosted-minimal"), {
    backend: "byo-secret-store",
    byo: { storeName: "corp-vault", storeKind: "ClusterSecretStore" },
  });
  const manifests = buildEsoManifests(config) as Array<{
    kind: string;
    spec?: any;
  }>;

  assert.equal(manifests.some((m) => m.kind === "SecretStore"), false);
  assert.equal(manifests.some((m) => m.kind === "ServiceAccount"), false);
  for (const es of manifests.filter((m) => m.kind === "ExternalSecret")) {
    assert.equal(es.spec.secretStoreRef.name, "corp-vault");
    assert.equal(es.spec.secretStoreRef.kind, "ClusterSecretStore");
  }
});

test("mergeMissingSecretKeys adds only absent keys, existing values win", () => {
  // The feature-enabled-after-first-seed seam: the entry was seeded without
  // SSO_CLIENT_SECRET (SSO off), then SSO is enabled. Only the new key is added.
  const existing = JSON.stringify({
    LICENSE_KEY: "rotated-by-client",
    EMAIL: "ops@example.com",
  });
  const desired = JSON.stringify({
    LICENSE_KEY: "from-config",
    EMAIL: "ops@example.com",
    SSO_CLIENT_SECRET: "sso-new",
  });

  const merged = mergeMissingSecretKeys(existing, desired);
  assert.ok(merged);
  assert.deepEqual(JSON.parse(merged!), {
    LICENSE_KEY: "rotated-by-client", // never clobbered
    EMAIL: "ops@example.com",
    SSO_CLIENT_SECRET: "sso-new",
  });
});

test("mergeMissingSecretKeys is a no-op when the entry is complete", () => {
  const existing = JSON.stringify({ A: "rotated", B: "2" });
  const desired = JSON.stringify({ A: "1", B: "2" });
  assert.equal(mergeMissingSecretKeys(existing, desired), null);

  // A superset entry (keys beyond the desired set) is also left alone.
  const superset = JSON.stringify({ A: "1", B: "2", EXTRA: "keep" });
  assert.equal(mergeMissingSecretKeys(superset, desired), null);
});

test("mergeMissingSecretKeys never touches hand-managed non-JSON entries", () => {
  const desired = JSON.stringify({ A: "1" });
  assert.equal(mergeMissingSecretKeys("not-json", desired), null);
  assert.equal(mergeMissingSecretKeys('"a plain string"', desired), null);
  assert.equal(mergeMissingSecretKeys('["array"]', desired), null);
  assert.equal(mergeMissingSecretKeys("null", desired), null);
});

test("provider switch updates active SMTP credentials in cloud JSON", () => {
  const before = withBackend(fixture("aws-all-features"), {
    backend: "aws-secrets-manager",
  });
  const names = deploymentSecretNames(before);
  const previous = esoSecretEntries(before).find(
    (entry) => entry.k8sName === names.app,
  )!;

  const after = structuredClone(before);
  after.smtp = {
    ...after.smtp,
    host: "smtp.new-provider.example",
    user: "new-provider-user",
    pass: "new-provider-pass",
  };
  const desired = esoSecretEntries(after).find(
    (entry) => entry.k8sName === names.app,
  )!;
  const existing = {
    ...JSON.parse(previous.json),
    SMTP_USER: "old-provider-user",
    SMTP_PASS: "old-provider-pass",
  };

  const reconciled = reconcileManagedSecretKeys(
    JSON.stringify(existing),
    desired.json,
    desired.knownKeys,
  );
  assert.ok(reconciled);
  assert.equal(JSON.parse(reconciled!).SMTP_USER, "new-provider-user");
  assert.equal(JSON.parse(reconciled!).SMTP_PASS, "new-provider-pass");
});

test("SSO disable removes inactive known keys from cloud JSON and k8s patches", () => {
  const enabled = withBackend(fixture("aws-all-features"), {
    backend: "aws-secrets-manager",
  });
  const names = deploymentSecretNames(enabled);
  const previous = esoSecretEntries(enabled).find(
    (entry) => entry.k8sName === names.app,
  )!;

  const disabled = structuredClone(enabled);
  disabled.features.sso = { enabled: false };
  const desired = esoSecretEntries(disabled).find(
    (entry) => entry.k8sName === names.app,
  )!;
  const reconciled = reconcileManagedSecretKeys(
    previous.json,
    desired.json,
    desired.knownKeys,
  );
  assert.ok(reconciled);
  assert.equal("SSO_CLIENT_ID" in JSON.parse(reconciled!), false);
  assert.equal("SSO_CLIENT_SECRET" in JSON.parse(reconciled!), false);

  const appSecret = buildDeploymentSecrets(disabled).find(
    (secret) => secret.name === names.app,
  )!;
  const patch = buildDeploymentSecretMergePatch(disabled, appSecret) as {
    data: Record<string, string | null>;
  };
  assert.equal(patch.data.SSO_CLIENT_ID, null);
  assert.equal(patch.data.SSO_CLIENT_SECRET, null);
  assert.equal(
    Buffer.from(patch.data.SMTP_USER!, "base64").toString("utf8"),
    disabled.smtp.user,
  );
});

test("relay removal prunes deterministic in-cluster and ESO consumers", () => {
  const relay = withBackend(fixture("azure-acs-api-email"), {
    backend: "azure-key-vault",
    azure: { vaultName: "rulebricks-test" },
  });
  const names = deploymentSecretNames(relay);
  const oldRelay = esoSecretEntries(relay).find(
    (entry) => entry.k8sName === names.smtpRelay,
  )!;

  const standardSmtp = structuredClone(relay);
  standardSmtp.smtp = {
    host: "smtp.example.com",
    port: 587,
    user: "smtp-user",
    pass: "smtp-pass",
    from: "no-reply@example.com",
    fromName: "Rulebricks",
  };

  assert.ok(
    obsoleteDeploymentSecretNames(standardSmtp).includes(names.smtpRelay),
  );
  assert.ok(
    obsoleteEsoSecretEntries(standardSmtp).some(
      (entry) =>
        entry.k8sName === names.smtpRelay &&
        entry.remoteKey === oldRelay.remoteKey,
    ),
  );
  assert.equal(
    (buildEsoManifests(standardSmtp) as Array<{ kind: string; metadata: { name: string } }>).some(
      (manifest) =>
        manifest.kind === "ExternalSecret" &&
        manifest.metadata.name === names.smtpRelay,
    ),
    false,
  );
});

test("cloud reconciliation preserves unknown customer keys", () => {
  const existing = JSON.stringify({
    SMTP_USER: "old",
    SMTP_PASS: "old",
    CUSTOMER_NOTE: "keep-me",
    CUSTOMER_NESTED: { owner: "platform" },
  });
  const desired = JSON.stringify({
    SMTP_USER: "new",
    SMTP_PASS: "new",
  });
  const reconciled = reconcileManagedSecretKeys(existing, desired, [
    "SMTP_USER",
    "SMTP_PASS",
    "SSO_CLIENT_ID",
  ]);
  assert.deepEqual(JSON.parse(reconciled!), {
    SMTP_USER: "new",
    SMTP_PASS: "new",
    CUSTOMER_NOTE: "keep-me",
    CUSTOMER_NESTED: { owner: "platform" },
  });
});

test("secret inventory never adopts BYO/custom secret references", () => {
  const config = fixture("everything-external");
  const inventoryNames = deploymentSecretInventory(config).map(
    (entry) => entry.name,
  );
  assert.equal(inventoryNames.includes("redis-auth"), false);
  assert.equal(inventoryNames.includes("azure-storage"), false);
  assert.equal(inventoryNames.includes("metrics"), false);
});

test("legacy pruning requires deterministic names and known CLI keys", () => {
  const config = fixture("aws-self-hosted-minimal");
  const name = deploymentSecretNames(config).smtpRelay;
  const legacy = (stringData: Record<string, string>) => ({
    kind: "Secret",
    metadata: {
      name,
      annotations: {
        "kubectl.kubernetes.io/last-applied-configuration": JSON.stringify({
          kind: "Secret",
          metadata: { name },
          stringData,
        }),
      },
    },
  });

  assert.equal(
    isDeploymentOwnedSecretResource(
      config,
      legacy({ "connection-string": "old" }),
      "Secret",
      name,
    ),
    true,
  );
  assert.equal(
    isDeploymentOwnedSecretResource(
      config,
      legacy({ "customer-key": "keep" }),
      "Secret",
      name,
    ),
    false,
  );
});
