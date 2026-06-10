import test from "node:test";
import assert from "node:assert/strict";
import { ImageTag } from "./dockerHub.js";
import {
  hasRegistryDigestMismatch,
  matchExactHpsVersions,
} from "./versions.js";
import { extractImageDigest, extractImageTag } from "./kubernetes.js";
import { resolveDeploymentConfigVersion } from "./config.js";
import { classifyDeploymentHealth } from "./deploymentHealth.js";

function tag(
  name: string,
  digest: string = `sha256:${name.replace(/[^a-zA-Z0-9]/g, "")}`,
): ImageTag {
  return {
    name,
    lastUpdated: new Date(`2026-01-${name === "0.0.1" ? "31" : "01"}T00:00:00Z`),
    digest,
    imageDigests: [digest],
    fullSize: 1,
    architectures: ["amd64", "arm64"],
  };
}

test("matches only exact app, HPS, and worker versions", () => {
  const versions = matchExactHpsVersions(
    [tag("1.8.17"), tag("1.8.16")],
    [tag("1.8.17")],
    [tag("worker-1.8.17")],
  );

  assert.deepEqual(
    versions.map((version) => version.version),
    ["1.8.17"],
  );
});

test("sorts product versions by semver instead of Docker Hub update time", () => {
  const versions = matchExactHpsVersions(
    [tag("0.0.1"), tag("1.8.16"), tag("1.8.17")],
    [tag("0.0.1"), tag("1.8.16"), tag("1.8.17")],
    [tag("worker-0.0.1"), tag("worker-1.8.16"), tag("worker-1.8.17")],
  );

  assert.deepEqual(
    versions.map((version) => version.version),
    ["1.8.17", "1.8.16"],
  );
});

test("detects same-version registry digest mismatches", () => {
  assert.equal(
    hasRegistryDigestMismatch(["sha256:old"], ["sha256:new", "sha256:other"]),
    true,
  );
  assert.equal(
    hasRegistryDigestMismatch(["sha256:new"], ["sha256:new", "sha256:other"]),
    false,
  );
});

test("extracts image tags and digests from Kubernetes image fields", () => {
  assert.equal(
    extractImageTag("index.docker.io/rulebricks/hps:worker-1.8.17"),
    "worker-1.8.17",
  );
  assert.equal(
    extractImageDigest(
      "docker-pullable://index.docker.io/rulebricks/hps@sha256:abc123",
    ),
    "sha256:abc123",
  );
});

test("resolves missing deployment config version from generated artifacts", () => {
  assert.equal(
    resolveDeploymentConfigVersion(
      { chartVersion: "1.0.0" },
      { global: { version: "2.0.0" } },
      { application: { version: "1.5.0" } },
    ),
    "2.0.0",
  );
  assert.equal(
    resolveDeploymentConfigVersion(
      { chartVersion: "1.0.0" },
      undefined,
      { application: { version: "1.5.0" } },
    ),
    "1.5.0",
  );
  assert.equal(resolveDeploymentConfigVersion({}), "latest");
});

test("classifies installed deployment health with HTTP reachability", () => {
  const readyPod = {
    name: "rulebricks-app",
    status: "Running",
    ready: true,
    restarts: 0,
  };

  assert.equal(
    classifyDeploymentHealth({
      state: null,
      helmVersion: null,
      pods: [],
      httpReachable: false,
    }),
    "not-installed",
  );
  assert.equal(
    classifyDeploymentHealth({
      state: {
        name: "demo",
        version: "1.0.0",
        createdAt: "",
        updatedAt: "",
        status: "destroyed",
      },
      helmVersion: null,
      pods: [],
      httpReachable: false,
    }),
    "destroyed",
  );
  assert.equal(
    classifyDeploymentHealth({
      state: null,
      helmVersion: "1.0.0",
      pods: [readyPod],
      httpReachable: true,
    }),
    "online",
  );
  assert.equal(
    classifyDeploymentHealth({
      state: null,
      helmVersion: "1.0.0",
      pods: [readyPod],
      httpReachable: false,
    }),
    "installed-unreachable",
  );
  assert.equal(
    classifyDeploymentHealth({
      state: null,
      helmVersion: "1.0.0",
      pods: [],
      httpReachable: true,
    }),
    "installed-degraded",
  );
});
