import { test } from "node:test";
import assert from "node:assert/strict";
import { runInstallSequence, InstallSequenceDeps } from "./deploySequence.js";
import {
  buildConfigureValues,
  buildDeployValues,
  buildHelmValues,
} from "./helmValues.js";
import { buildConfigMatrix } from "./configFixtures.js";

function recordingDeps(log: string[]): InstallSequenceDeps {
  return {
    generateValues: async (tlsEnabled, secretMode) => {
      log.push(`generate(tls=${tlsEnabled},mode=${secretMode})`);
    },
    validateValues: async () => {
      log.push("validate");
    },
    ensureNamespace: async () => {
      log.push("namespace");
    },
    applySecrets: async () => {
      log.push("secrets");
    },
    installChart: async () => {
      log.push("install");
    },
  };
}

test("k8s mode applies secrets before helm on the manual-DNS path", async () => {
  const log: string[] = [];
  await runInstallSequence(
    { regenerateValues: true, tlsEnabled: false, secretMode: "k8s" },
    recordingDeps(log),
  );
  assert.deepEqual(log, [
    "generate(tls=false,mode=k8s)",
    "validate",
    "namespace",
    "secrets",
    "install",
  ]);
});

test("k8s mode applies secrets before helm on the external-DNS path", async () => {
  const log: string[] = [];
  await runInstallSequence(
    { regenerateValues: true, tlsEnabled: true, secretMode: "k8s" },
    recordingDeps(log),
  );
  assert.deepEqual(log, [
    "generate(tls=true,mode=k8s)",
    "validate",
    "namespace",
    "secrets",
    "install",
  ]);
});

test("inline mode skips secret creation", async () => {
  const log: string[] = [];
  await runInstallSequence(
    { regenerateValues: true, tlsEnabled: false, secretMode: "inline" },
    recordingDeps(log),
  );
  assert.deepEqual(log, ["generate(tls=false,mode=inline)", "validate", "install"]);
});

test("configure (regenerateValues=false) still validates and applies secrets", async () => {
  const log: string[] = [];
  await runInstallSequence(
    { regenerateValues: false, tlsEnabled: false, secretMode: "k8s" },
    recordingDeps(log),
  );
  assert.deepEqual(log, ["validate", "namespace", "secrets", "install"]);
});

test("buildConfigureValues scrubs inline secrets carried over from old values", () => {
  const base = buildConfigMatrix().find(
    (c) => c.name === "aws-all-features",
  )!.config;

  // An old-style values file with inline plaintext secrets.
  const legacy = buildHelmValues(base, { secretMode: "inline" });
  const legacyGlobal = legacy.global as Record<string, any>;
  assert.equal(legacyGlobal.smtp.pass, base.smtp.pass);

  const merged = buildConfigureValues(legacy, base);
  const global = merged.global as Record<string, any>;
  assert.equal(global.smtp.pass, undefined);
  assert.equal(global.smtp.user, undefined);
  assert.equal(global.ai?.openaiApiKey, undefined);
  assert.equal(global.sso?.clientSecret, undefined);
  assert.equal(typeof global.secrets?.secretRef, "string");

  const supabase = merged.supabase as Record<string, any>;
  assert.equal(typeof supabase.secret?.jwt?.secretRef, "string");
});

test("buildConfigureValues preserves manual edits outside generated keys", () => {
  const base = buildConfigMatrix().find(
    (c) => c.name === "aws-self-hosted-minimal",
  )!.config;
  const existing = buildHelmValues(base, { secretMode: "k8s" });
  (existing as Record<string, any>).customOperatorBlock = { keep: true };

  const merged = buildConfigureValues(existing, base) as Record<string, any>;
  assert.deepEqual(merged.customOperatorBlock, { keep: true });
});

test("buildDeployValues keeps manual edits while config changes win", () => {
  const base = buildConfigMatrix().find(
    (c) => c.name === "aws-self-hosted-minimal",
  )!.config;
  const existing = buildHelmValues(base, { secretMode: "k8s" }) as Record<
    string,
    any
  >;
  existing.customOperatorBlock = { keep: true };

  const changed = { ...base, domain: "updated.example.com" };
  const merged = buildDeployValues(existing, changed, {
    secretMode: "k8s",
  }) as Record<string, any>;

  assert.deepEqual(merged.customOperatorBlock, { keep: true });
  assert.equal(merged.global.domain, "updated.example.com");
});

test("buildDeployValues without an existing file is plain generation", () => {
  const base = buildConfigMatrix().find(
    (c) => c.name === "aws-self-hosted-minimal",
  )!.config;

  assert.deepEqual(
    buildDeployValues(null, base, { secretMode: "k8s" }),
    buildHelmValues(base, { secretMode: "k8s" }),
  );
});

test("buildDeployValues inline mode does not scrub freshly inlined secrets", () => {
  const base = buildConfigMatrix().find(
    (c) => c.name === "aws-self-hosted-minimal",
  )!.config;
  const existing = buildHelmValues(base, { secretMode: "k8s" });

  const merged = buildDeployValues(existing, base, {
    secretMode: "inline",
  }) as Record<string, any>;

  assert.equal(merged.global.smtp.pass, base.smtp.pass);
});
