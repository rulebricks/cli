import test from "node:test";
import assert from "node:assert/strict";
import {
  extractSecretCredential,
  buildAcsSmtpUsername,
  parseAcsSmtpAppClientId,
} from "./cloudCli.js";

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
