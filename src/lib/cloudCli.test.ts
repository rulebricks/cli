import test from "node:test";
import assert from "node:assert/strict";
import {
  extractSecretCredential,
  buildAcsSmtpUsername,
  parseAcsSmtpAppClientId,
  expectedSsoRedirectUri,
  hasSsoRedirectUri,
  recommendEntraAppIndex,
  recommendSmtpAppIndex,
} from "./cloudCli.js";

test("recommends the SMTP-named Entra app for ACS email", () => {
  const apps = [
    { name: "Corp Intranet" },
    { name: "Rulebricks SSO" },
    { name: "Rulebricks SMTP" },
  ];
  // "smtp" in the name beats a mere "rulebricks" mention.
  assert.equal(recommendSmtpAppIndex(apps), 2);
  // Fallback: any Rulebricks-named app.
  assert.equal(recommendSmtpAppIndex(apps.slice(0, 2)), 1);
  // Nothing matches: no recommendation.
  assert.equal(recommendSmtpAppIndex(apps.slice(0, 1)), -1);
});

test("builds the native-provider SSO callback for a deployment domain", () => {
  assert.equal(
    expectedSsoRedirectUri("Azpg.Rulebricks.com"),
    "https://supabase.azpg.rulebricks.com/auth/v1/callback",
  );
});

test("matches registered redirect URIs case- and slash-insensitively", () => {
  assert.equal(
    hasSsoRedirectUri(
      ["https://Supabase.azpg.rulebricks.com/auth/v1/callback/"],
      "azpg.rulebricks.com",
    ),
    true,
  );
  assert.equal(
    hasSsoRedirectUri(
      ["https://azpg.rulebricks.com/api/sso-proxy/callback"],
      "azpg.rulebricks.com",
    ),
    false,
  );
});

test("recommends the Entra app whose redirect URIs match the deployment", () => {
  const apps = [
    { redirectUris: ["https://other.example.com/callback"] },
    { redirectUris: ["https://azpg.rulebricks.com/api/sso-proxy/callback"] },
    { redirectUris: ["https://supabase.azpg.rulebricks.com/auth/v1/callback"] },
  ];
  // Exact callback beats a mere domain reference.
  assert.equal(recommendEntraAppIndex(apps, "azpg.rulebricks.com"), 2);
  // Domain reference is the fallback when no exact callback exists.
  assert.equal(recommendEntraAppIndex(apps.slice(0, 2), "azpg.rulebricks.com"), 1);
  // Nothing matches: no recommendation.
  assert.equal(recommendEntraAppIndex(apps.slice(0, 1), "azpg.rulebricks.com"), -1);
  assert.equal(recommendEntraAppIndex(apps, ""), -1);
});

test("assembles the ACS SMTP username from discovered parts", () => {
  assert.equal(
    buildAcsSmtpUsername("rbcommxyz", "app-id-123", "tenant-abc"),
    "rbcommxyz.app-id-123.tenant-abc",
  );
});

test("round-trips the app client ID through assemble and parse", () => {
  const username = buildAcsSmtpUsername(
    "rbcommxyz",
    "app-id-123",
    "tenant-abc",
  );
  assert.equal(parseAcsSmtpAppClientId(username), "app-id-123");
});

test("rejects ACS usernames that are incomplete or still placeholders", () => {
  assert.equal(parseAcsSmtpAppClientId("rbcommxyz.tenant-only"), null);
  assert.equal(
    parseAcsSmtpAppClientId("rbcommxyz.<entra-app-client-id>.tenant-abc"),
    null,
  );
});

test("unwraps RDS-managed {username, password} secrets", () => {
  assert.equal(
    extractSecretCredential('{"username":"postgres","password":"s3cret"}'),
    "s3cret",
  );
});

test("unwraps cluster-setup ElastiCache {authToken} secrets", () => {
  // Regression: this JSON used to be returned verbatim and became
  // REDIS_PASSWORD, making every Redis consumer fail with WRONGPASS.
  assert.equal(
    extractSecretCredential('{"authToken":"zm0QrVxow9nGwAJvrEKGSUqR67VAFYpw"}'),
    "zm0QrVxow9nGwAJvrEKGSUqR67VAFYpw",
  );
});

test("prefers password when both keys are present", () => {
  assert.equal(
    extractSecretCredential('{"password":"a","authToken":"b"}'),
    "a",
  );
});

test("returns plain string secrets verbatim", () => {
  assert.equal(extractSecretCredential("just-a-token"), "just-a-token");
});

test("returns unrecognized JSON envelopes verbatim", () => {
  const raw = '{"connectionString":"redis://..."}';
  assert.equal(extractSecretCredential(raw), raw);
});
