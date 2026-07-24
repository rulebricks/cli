import { test } from "node:test";
import assert from "node:assert/strict";
import {
  esoSecretEntries,
  buildEsoManifests,
  defaultSecretsPrefix,
  isEsoBackend,
} from "./eso.js";
import { buildDeploymentSecrets } from "./secrets.js";
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
