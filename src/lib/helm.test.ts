import test from "node:test";
import assert from "node:assert/strict";
import {
  applyFlagsForHelmVersion,
  buildUpgradeChartArgs,
  isHelmSsaConflict,
  parseDeployedChartVersion,
  parseGitHubReleases,
  waitFlagForHelmVersion,
} from "./helm.js";
import { deriveTlsEnabled } from "./helmValues.js";

test("parses GitHub releases into chart versions, newest first", () => {
  const payload = [
    { tag_name: "v2.1.0", published_at: "2026-05-01T00:00:00Z", prerelease: false },
    { tag_name: "v2.10.0", published_at: "2026-07-01T00:00:00Z", prerelease: false },
    { tag_name: "v2.2.0", published_at: "2026-06-01T00:00:00Z", prerelease: false },
  ];

  const versions = parseGitHubReleases(payload);
  assert.deepEqual(
    versions.map((v) => v.version),
    ["2.10.0", "2.2.0", "2.1.0"],
  );
  assert.equal(versions[0].created, "2026-07-01T00:00:00Z");
});

test("filters prereleases and malformed release entries", () => {
  const payload = [
    { tag_name: "v3.0.0-rc.1", published_at: "2026-07-01T00:00:00Z", prerelease: true },
    { tag_name: "v2.5.0", published_at: "2026-06-15T00:00:00Z", prerelease: false },
    { published_at: "2026-06-01T00:00:00Z", prerelease: false },
    { tag_name: 42, published_at: "2026-06-01T00:00:00Z" },
    null,
  ];

  const versions = parseGitHubReleases(payload);
  assert.deepEqual(
    versions.map((v) => v.version),
    ["2.5.0"],
  );
});

test("returns empty list for non-array payloads", () => {
  assert.deepEqual(parseGitHubReleases(null), []);
  assert.deepEqual(parseGitHubReleases({ message: "rate limited" }), []);
});

test("parses the deployed chart version from Helm list output", () => {
  const payload = [
    {
      name: "another-release",
      status: "deployed",
      chart: "stack-9.9.9",
    },
    {
      name: "rulebricks-azpg3",
      status: "deployed",
      chart: "stack-0.3.60",
    },
  ];

  assert.equal(
    parseDeployedChartVersion(payload, "rulebricks-azpg3"),
    "0.3.60",
  );
});

test("does not return a chart version for a non-deployed release", () => {
  assert.equal(
    parseDeployedChartVersion(
      [
        {
          name: "rulebricks-azpg3",
          status: "failed",
          chart: "stack-0.3.60",
        },
      ],
      "rulebricks-azpg3",
    ),
    undefined,
  );
});

test("strips the v prefix from tags", () => {
  const versions = parseGitHubReleases([
    { tag_name: "v1.2.3", published_at: "2026-01-01T00:00:00Z" },
    { tag_name: "1.2.4", published_at: "2026-01-02T00:00:00Z" },
  ]);
  assert.deepEqual(
    versions.map((v) => v.version),
    ["1.2.4", "1.2.3"],
  );
});

test("uses Helm 4 hook-only waiting for controller-managed resources", () => {
  assert.equal(waitFlagForHelmVersion("v4.2.3+g43e8b7f"), "--wait=hookOnly");
  assert.equal(waitFlagForHelmVersion("4.0.0"), "--wait=hookOnly");
  assert.equal(waitFlagForHelmVersion("v3.19.0+g3d8990f"), "--wait");
  assert.deepEqual(applyFlagsForHelmVersion("v4.2.3+g43e8b7f"), [
    "--server-side=false",
  ]);
  assert.deepEqual(applyFlagsForHelmVersion("v3.19.0+g3d8990f"), []);
});

test("derives TLS state from values with sensible fallbacks", () => {
  // global.tlsEnabled wins.
  assert.equal(deriveTlsEnabled({ global: { tlsEnabled: false } }), false);
  assert.equal(
    deriveTlsEnabled({
      global: { tlsEnabled: true },
      "cert-manager": { enabled: false },
    }),
    true,
  );
  // cert-manager.enabled is the fallback for older values files.
  assert.equal(deriveTlsEnabled({ "cert-manager": { enabled: false } }), false);
  assert.equal(deriveTlsEnabled({ "cert-manager": { enabled: true } }), true);
  // Fully deployed systems run TLS; default true when neither key exists.
  assert.equal(deriveTlsEnabled({}), true);
  assert.equal(deriveTlsEnabled(null), true);
});

test("classifies actual Helm 4 server-side apply conflicts", () => {
  const stderr =
    'Error: UPGRADE FAILED: conflict occurred while applying object default/rulebricks apps/v1, Kind=Deployment: Apply failed with 1 conflict: conflict with "kube-controller-manager" with subresource "scale" using apps/v1: .spec.replicas';

  assert.equal(isHelmSsaConflict({ stderr }), true);
  assert.equal(isHelmSsaConflict(new Error(stderr)), true);
});

test("does not classify generic Helm or Kubernetes conflicts as SSA conflicts", () => {
  assert.equal(
    isHelmSsaConflict(
      new Error(
        "UPGRADE FAILED: another operation (install/upgrade/rollback) is in progress",
      ),
    ),
    false,
  );
  assert.equal(
    isHelmSsaConflict(
      new Error('the object has been modified; conflict with "controller"'),
    ),
    false,
  );
  assert.equal(
    isHelmSsaConflict(
      new Error(
        'Apply failed with 1 conflict: conflict with "kubectl" using apps/v1: .spec.replicas',
      ),
    ),
    false,
  );
});

test("adds force-conflicts only to an explicitly forced upgrade retry", () => {
  const baseOptions = {
    releaseName: "rulebricks-prod",
    namespace: "rulebricks-prod",
    version: "0.4.0",
    chartRef: "oci://registry.example.com/rulebricks/stack",
    atomic: true,
  };

  const normal = buildUpgradeChartArgs("prod", baseOptions);
  assert.equal(normal.includes("--force-conflicts"), false);
  assert.equal(normal.includes("--atomic"), true);
  assert.equal(normal.includes("--wait"), false);

  const forced = buildUpgradeChartArgs("prod", {
    ...baseOptions,
    forceConflicts: true,
  });
  assert.equal(
    forced.filter((arg) => arg === "--force-conflicts").length,
    1,
  );
});
