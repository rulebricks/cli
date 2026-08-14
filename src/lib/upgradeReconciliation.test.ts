import test from "node:test";
import assert from "node:assert/strict";
import type { DeploymentConfig } from "../types/index.js";
import { buildConfigMatrix } from "./configFixtures.js";
import {
  runUpgradeReconciliation,
  type UpgradeReconciliationDeps,
  withUpgradeVersion,
} from "./upgradeReconciliation.js";

interface Snapshot {
  configVersion: string;
  values: string;
}

function baseConfig(): DeploymentConfig {
  return buildConfigMatrix().find(
    (entry) => entry.name === "aws-self-hosted-minimal",
  )!.config;
}

function recordingDeps(
  config: DeploymentConfig,
  log: string[],
  helmError?: Error,
): UpgradeReconciliationDeps<Snapshot, string> {
  return {
    reloadConfig: async () => {
      log.push("reload");
      return config;
    },
    captureSnapshot: async (original) => {
      log.push("snapshot");
      return { configVersion: original.version, values: "original-values" };
    },
    prepareArtifacts: async () => {
      log.push("artifacts");
    },
    regenerateValues: async (target) => {
      log.push(`values:${target.version}`);
    },
    persistConfig: async (target) => {
      log.push(`config:${target.version}`);
    },
    ensureNamespace: async () => {
      log.push("namespace");
    },
    applyKubernetesSecrets: async () => {
      log.push("k8s-secrets");
    },
    setupExternalSecrets: async () => {
      log.push("eso-secrets");
    },
    runHelm: async () => {
      log.push("helm");
      if (helmError) throw helmError;
      return "rendered";
    },
    restoreSnapshot: async (snapshot) => {
      log.push(`restore:${snapshot.configVersion}:${snapshot.values}`);
    },
  };
}

test("app and chart upgrades run full k8s reconciliation before Helm", async () => {
  const log: string[] = [];
  const result = await runUpgradeReconciliation(
    { targetVersion: "2.0.0", dryRun: false },
    recordingDeps(baseConfig(), log),
  );

  assert.equal(result.config.version, "2.0.0");
  assert.equal(result.helmResult, "rendered");
  assert.deepEqual(log, [
    "reload",
    "artifacts",
    "values:2.0.0",
    "config:2.0.0",
    "namespace",
    "k8s-secrets",
    "helm",
  ]);
});

test("ESO reconciliation completes before Helm", async () => {
  const log: string[] = [];
  const config: DeploymentConfig = {
    ...baseConfig(),
    secrets: { backend: "aws-secrets-manager" },
  };

  await runUpgradeReconciliation(
    { targetVersion: "2.0.0", dryRun: false },
    recordingDeps(config, log),
  );

  assert.deepEqual(log.slice(-3), ["namespace", "eso-secrets", "helm"]);
  assert.equal(log.includes("k8s-secrets"), false);
});

test("dry-run skips all secret writes and restores config and values", async () => {
  const log: string[] = [];
  await runUpgradeReconciliation(
    { targetVersion: "2.0.0", dryRun: true },
    recordingDeps(baseConfig(), log),
  );

  assert.deepEqual(log, [
    "reload",
    "snapshot",
    "artifacts",
    "values:2.0.0",
    "config:2.0.0",
    "helm",
    "restore:1.8.17:original-values",
  ]);
});

test("dry-run restores local files when Helm rendering fails", async () => {
  const log: string[] = [];
  await assert.rejects(
    runUpgradeReconciliation(
      { targetVersion: "2.0.0", dryRun: true },
      recordingDeps(baseConfig(), log, new Error("render failed")),
    ),
    /render failed/,
  );

  assert.equal(log.at(-1), "restore:1.8.17:original-values");
  assert.equal(log.includes("k8s-secrets"), false);
  assert.equal(log.includes("eso-secrets"), false);
});

test("failed atomic chart reconciliation restores its rollback snapshot", async () => {
  const log: string[] = [];
  await assert.rejects(
    runUpgradeReconciliation(
      {
        targetVersion: "2.0.0",
        dryRun: false,
        restoreOnFailure: true,
      },
      recordingDeps(baseConfig(), log, new Error("upgrade failed")),
    ),
    /upgrade failed/,
  );

  assert.equal(log[1], "snapshot");
  assert.equal(log.at(-1), "restore:1.8.17:original-values");
});

test("reports a local snapshot restoration failure", async () => {
  const log: string[] = [];
  const deps = recordingDeps(
    baseConfig(),
    log,
    new Error("render failed"),
  );
  deps.restoreSnapshot = async () => {
    throw new Error("disk is read-only");
  };

  await assert.rejects(
    runUpgradeReconciliation(
      { targetVersion: "2.0.0", dryRun: true },
      deps,
    ),
    /render failed[\s\S]*failed to restore[\s\S]*disk is read-only/,
  );
});

test("target version reconciliation does not mutate loaded config", () => {
  const source = baseConfig();
  const target = withUpgradeVersion(source, "2.0.0");

  assert.equal(source.version, "1.8.17");
  assert.equal(target.version, "2.0.0");
  assert.notEqual(target, source);
});
