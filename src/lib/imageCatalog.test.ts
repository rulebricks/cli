import test from "node:test";
import assert from "node:assert/strict";
import {
  ImageCatalog,
  bundledImageCatalog,
  parseImageManifest,
} from "./imageCatalog.js";

// Mirrors the helm repo's images/manifest.yaml shape (flow-style entries with
// mirror-pipeline fields the CLI ignores), covering target overrides and a
// written-back digest.
const MANIFEST_FIXTURE = `
images:
  - { name: curl, kind: mirror, source: dhi.io/curl, tag: "8.14.1-debian13", auth: dhi, digest: "" }
  - { name: hyperdx, kind: build, source: docker.io/hyperdx/hyperdx, tag: "2.19.0", auth: none, digest: "" }
  - { name: clickstack-otel-collector, kind: build, source: docker.io/hyperdx/hyperdx-otel-collector, tag: "2.19.0", auth: none, digest: "" }
  - { name: ferretdb, kind: mirror, source: docker.io/ferretdb/ferretdb, tag: "2.7.0", auth: none, digest: "" }
  - { name: postgres-documentdb, kind: mirror, source: docker.io/ferretdb/postgres-documentdb, tag: "17-0.107.0-ferretdb-2.7.0", auth: none, digest: "" }
  - { name: opentelemetry-collector, kind: mirror, source: dhi.io/opentelemetry-collector, tag: "0.155.0-debian13-contrib", auth: dhi, digest: "" }
  - { name: kafka-proxy, kind: mirror, source: docker.io/grepplabs/kafka-proxy, tag: "0.4.3", auth: none, digest: "" }
  - { name: supabase-postgres, kind: mirror, source: docker.io/supabase/postgres, tag: "17.6.1.141", auth: none, digest: "sha256:abc123" }
  - { name: rclone, kind: mirror, source: docker.io/rclone/rclone, tag: "1.71.1", auth: none, digest: "" }
  - { name: strimzi-kafka, kind: mirror, source: dhi.io/strimzi-kafka, tag: "1.0.1-debian13-kafka-4.2.0", auth: dhi, digest: "" }
  - { name: postgres15, kind: mirror, source: dhi.io/postgres, tag: "15-debian13", auth: dhi, target: rulebricks/postgres, digest: "" }
`;

function fixtureCatalog(): ImageCatalog {
  return new ImageCatalog(parseImageManifest(MANIFEST_FIXTURE, "fixture"), {
    source: "chart",
    chartVersion: "9.9.9",
  });
}

test("parses manifest entries and resolves rulebricks/<name> references", () => {
  const catalog = fixtureCatalog();
  assert.deepEqual(catalog.image("curl"), {
    registry: "docker.io",
    repository: "rulebricks/curl",
    tag: "8.14.1-debian13",
    ref: "docker.io/rulebricks/curl:8.14.1-debian13",
  });
});

test("honors explicit target repositories and registry overrides", () => {
  const catalog = fixtureCatalog();
  assert.equal(
    catalog.image("postgres15").ref,
    "docker.io/rulebricks/postgres:15-debian13",
  );
  assert.equal(
    catalog.image("kafka-proxy", "registry.corp.example").ref,
    "registry.corp.example/rulebricks/kafka-proxy:0.4.3",
  );
});

test("derives the Apache Kafka version from the strimzi-kafka tag", () => {
  assert.equal(fixtureCatalog().kafkaVersion(), "4.2.0");
});

test("exposes only written-back digests", () => {
  assert.deepEqual(fixtureCatalog().digests(), {
    "supabase-postgres": "sha256:abc123",
  });
});

test("fails loudly on unknown image names (schema drift guard)", () => {
  assert.throws(
    () => fixtureCatalog().image("no-such-image"),
    /missing from the chart image manifest/,
  );
});

test("rejects a manifest missing entries the CLI depends on", () => {
  const withoutCurl = MANIFEST_FIXTURE.split("\n")
    .filter((line) => !line.includes("name: curl"))
    .join("\n");
  assert.throws(
    () => parseImageManifest(withoutCurl, "fixture"),
    /missing entries the CLI depends on: curl/,
  );
});

test("rejects malformed manifest documents", () => {
  assert.throws(
    () => parseImageManifest("not-a-manifest: true", "fixture"),
    /no images: list/,
  );
  assert.throws(
    () => parseImageManifest("images:\n  - { name: curl }\n", "fixture"),
    /malformed entry/,
  );
});

test("bundled snapshot satisfies every image the CLI references", () => {
  const catalog = bundledImageCatalog();
  assert.equal(catalog.source, "bundled");
  for (const name of [
    "curl",
    "hyperdx",
    "clickstack-otel-collector",
    "ferretdb",
    "postgres-documentdb",
    "opentelemetry-collector",
    "kafka-proxy",
    "supabase-postgres",
    "rclone",
  ]) {
    const resolved = catalog.image(name);
    assert.ok(resolved.tag.length > 0, `${name} has a tag`);
    assert.ok(
      resolved.repository.startsWith("rulebricks/"),
      `${name} stays under rulebricks/`,
    );
  }
  assert.match(catalog.kafkaVersion(), /^\d+\.\d+/);
});
