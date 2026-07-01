import test from "node:test";
import assert from "node:assert/strict";
import { getRequiredDNSRecords } from "./dns.js";

test("manual DNS records include app, Supabase, and built-in observability", () => {
  const records = getRequiredDNSRecords(
    "az-p055.rulebricks.com",
    "4.236.203.25",
    "ip",
    true,
    true,
  );

  assert.deepEqual(
    records.map((record) => record.hostname),
    [
      "az-p055.rulebricks.com",
      "supabase.az-p055.rulebricks.com",
      "observability.az-p055.rulebricks.com",
    ],
  );
  assert.ok(records.every((record) => record.type === "A"));
  assert.ok(records.every((record) => record.target === "4.236.203.25"));
});

test("manual DNS records omit observability when built-in observability is disabled", () => {
  const records = getRequiredDNSRecords(
    "az-p055.rulebricks.com",
    "example-lb.example.net",
    "hostname",
    true,
    false,
  );

  assert.deepEqual(
    records.map((record) => record.hostname),
    ["az-p055.rulebricks.com", "supabase.az-p055.rulebricks.com"],
  );
  assert.ok(records.every((record) => record.type === "CNAME"));
});

test("manual DNS records include Valkey Admin ingress when enabled", () => {
  const records = getRequiredDNSRecords(
    "az-p055.rulebricks.com",
    "4.236.203.25",
    "ip",
    false,
    false,
    undefined,
    true,
  );

  assert.deepEqual(
    records.map((record) => record.hostname),
    ["az-p055.rulebricks.com", "valkey.az-p055.rulebricks.com"],
  );
});

test("manual DNS records use custom Valkey Admin hostname", () => {
  const records = getRequiredDNSRecords(
    "az-p055.rulebricks.com",
    "example-lb.example.net",
    "hostname",
    false,
    false,
    undefined,
    true,
    "redis-tools.example.com",
  );

  assert.deepEqual(
    records.map((record) => record.hostname),
    ["az-p055.rulebricks.com", "redis-tools.example.com"],
  );
  assert.ok(records.every((record) => record.type === "CNAME"));
});
