#!/usr/bin/env node
// Syncs the chart's values.schema.json into the CLI bundle so the pre-deploy
// guardrail and the verification harness validate against the exact same schema
// the Helm chart ships.
//
// The Helm chart repo is the source of truth. Point this at it via:
//   node scripts/sync-schema.mjs --from=/path/to/helm
//   RULEBRICKS_HELM_DIR=/path/to/helm node scripts/sync-schema.mjs
//   node scripts/sync-schema.mjs --from=/path/to/values.schema.json
//
// Defaults to ../helm relative to the CLI repo.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const cliRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const fromArg = process.argv
  .find((arg) => arg.startsWith("--from="))
  ?.slice("--from=".length);
const source =
  fromArg || process.env.RULEBRICKS_HELM_DIR || path.resolve(cliRoot, "../helm");

function resolveSchemaPath(input) {
  const resolved = path.resolve(input);
  if (fs.existsSync(resolved) && fs.statSync(resolved).isDirectory()) {
    return path.join(resolved, "values.schema.json");
  }
  return resolved;
}

const schemaPath = resolveSchemaPath(source);
if (!fs.existsSync(schemaPath)) {
  console.error(`Schema not found at ${schemaPath}`);
  console.error(
    "Pass --from=<helm repo or values.schema.json> or set RULEBRICKS_HELM_DIR.",
  );
  process.exit(1);
}

// Parse to fail fast on malformed JSON before writing the bundle.
const raw = fs.readFileSync(schemaPath, "utf8");
JSON.parse(raw);

const destDir = path.join(cliRoot, "schema");
const destPath = path.join(destDir, "values.schema.json");
fs.mkdirSync(destDir, { recursive: true });
fs.writeFileSync(destPath, raw.endsWith("\n") ? raw : `${raw}\n`);

console.log(`Synced schema:\n  from ${schemaPath}\n  to   ${destPath}`);
