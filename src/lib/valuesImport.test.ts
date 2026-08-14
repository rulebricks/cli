import test from "node:test";
import assert from "node:assert/strict";
import { chunkEntries, flattenValues } from "./valuesImport.js";

test("flattenValues keeps name-based $ref markers as leaves", () => {
  const entries = flattenValues({
    A: { $ref: "B" },
    B: 1,
    nested: { deep: { $ref: "B" } },
  });
  assert.deepEqual(entries, [
    ["A", { $ref: "B" }],
    ["B", 1],
    ["nested.deep", { $ref: "B" }],
  ]);
});

test("flattenValues keeps id-based $rb markers as leaves", () => {
  const entries = flattenValues({
    A: { $rb: "globalValue", id: "abc-123" },
  });
  assert.deepEqual(entries, [["A", { $rb: "globalValue", id: "abc-123" }]]);
});

test("flattenValues still walks plain nested objects and non-marker shapes", () => {
  const entries = flattenValues({
    a: { b: { c: 2 } },
    // Not markers: empty $ref, $ref alongside $rb, $rb without a string id.
    x: { $ref: "" },
    y: { $ref: "B", $rb: "other" },
    z: { $rb: "globalValue" },
  });
  assert.deepEqual(entries, [
    ["a.b.c", 2],
    ["x.$ref", ""],
    ["y.$ref", "B"],
    ["y.$rb", "other"],
    ["z.$rb", "globalValue"],
  ]);
});

test("chunkEntries orders marker-free entries first, dependencies before dependents", () => {
  const chunks = chunkEntries([
    ["X", { $ref: "Y" }],
    ["Y", { $ref: "Z" }],
    ["Z", 5],
  ]);
  assert.equal(chunks.length, 1);
  assert.deepEqual(
    chunks[0].map(([name]) => name),
    ["Z", "Y", "X"],
  );
});

test("chunkEntries keeps cycle members adjacent and reads $refs from array items", () => {
  const chunks = chunkEntries([
    ["C", { $ref: "D" }],
    ["plain", true],
    ["D", { $ref: "C" }],
    ["L", [{ $ref: "plain" }, 1]],
  ]);
  const names = chunks[0].map(([name]) => name);
  assert.equal(names[0], "plain");
  assert.equal(Math.abs(names.indexOf("C") - names.indexOf("D")), 1);
  assert.ok(names.includes("L"));
});

test("chunkEntries measures encoded bytes so multi-byte payloads split", () => {
  // 600k CJK chars each: ~600 KB of UTF-16 code units but ~1.8 MB encoded,
  // so two entries exceed the 2 MiB target and must land in separate chunks.
  const big = "\u4e16".repeat(600_000);
  const chunks = chunkEntries([
    ["a", big],
    ["b", big],
  ]);
  assert.equal(chunks.length, 2);
  assert.deepEqual(
    chunks.map((chunk) => chunk.map(([name]) => name)),
    [["a"], ["b"]],
  );
});
