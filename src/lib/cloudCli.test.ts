import test from "node:test";
import assert from "node:assert/strict";
import { extractSecretCredential } from "./cloudCli.js";

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
