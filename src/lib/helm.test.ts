import test from "node:test";
import assert from "node:assert/strict";
import { parseGitHubReleases } from "./helm.js";
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
