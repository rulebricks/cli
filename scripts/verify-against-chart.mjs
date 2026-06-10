#!/usr/bin/env node
// End-to-end verification: render every config in the matrix against the real
// Helm chart with `helm template`, which runs the chart's values.schema.json
// validation AND template rendering. This catches both schema drift and
// "value not actually consumed / renders wrong" issues that a schema-only
// check cannot.
//
// Usage:
//   npm run verify-chart -- --chart=/path/to/helm
//   RULEBRICKS_CHART_DIR=/path/to/helm npm run verify-chart
//   npm run verify-chart -- --chart=/path/to/helm --build-deps
//
// Requires `helm` and the chart's dependencies (run once with --build-deps, or
// `helm dependency build` in the chart dir). Defaults chart dir to ../helm.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import YAML from "yaml";
import { buildConfigMatrix } from "../dist/lib/configFixtures.js";
import { buildHelmValues } from "../dist/lib/helmValues.js";

const cliRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function arg(flag) {
  return process.argv.find((a) => a.startsWith(`${flag}=`))?.slice(flag.length + 1);
}

const chartDir =
  arg("--chart") ||
  process.env.RULEBRICKS_CHART_DIR ||
  path.resolve(cliRoot, "../helm");
const buildDeps = process.argv.includes("--build-deps");

function run(cmd, args, opts = {}) {
  return execFileSync(cmd, args, { encoding: "utf8", ...opts });
}

function helmAvailable() {
  try {
    run("helm", ["version", "--short"]);
    return true;
  } catch {
    return false;
  }
}

const VECTOR_IMAGE = "timberio/vector:0.55.0-distroless-libc";

// How we can run `vector validate`: a local binary if present, else Docker with
// the pinned image (so this works in CI/dev without a local install).
function vectorRunner() {
  try {
    run("vector", ["--version"]);
    return "local";
  } catch {
    /* no local binary */
  }
  try {
    run("docker", ["version", "--format", "{{.Server.Version}}"]);
    return "docker";
  } catch {
    /* no docker */
  }
  return null;
}

// Run `vector validate` (WITHOUT --no-environment, so transforms/VRL are
// actually compiled) on a config file. Dummy SASL env so external direct-SASL
// configs that reference ${KAFKA_SASL_USERNAME} don't fail on an unset var.
function runVectorValidate(mode, file) {
  const env = {
    ...process.env,
    KAFKA_SASL_USERNAME: "ci-validate",
    KAFKA_SASL_PASSWORD: "ci-validate",
  };
  if (mode === "local") {
    run("vector", ["validate", file], { env });
  } else {
    run("docker", [
      "run", "--rm",
      "-e", "KAFKA_SASL_USERNAME=ci-validate",
      "-e", "KAFKA_SASL_PASSWORD=ci-validate",
      "-v", `${file}:/c/vector.yaml:ro`,
      VECTOR_IMAGE, "validate", "/c/vector.yaml",
    ]);
  }
}

// Pull every rendered ConfigMap that carries a Vector config (data["vector.yaml"]).
function extractVectorConfigs(renderedYaml) {
  const configs = [];
  for (const doc of YAML.parseAllDocuments(renderedYaml)) {
    const obj = doc.toJSON();
    const content = obj?.kind === "ConfigMap" && obj?.data?.["vector.yaml"];
    if (typeof content === "string") {
      configs.push({ name: obj.metadata?.name ?? "vector", content });
    }
  }
  return configs;
}

// Validates the rendered Vector config. Two layers:
//  1. A dependency-free regex guard for empty-default env interpolations
//     ("${VAR:-}") that fold to YAML null and crash config load.
//  2. A real `vector validate` of an isolated sources+transforms+console-sink
//     config. Dropping the cloud sinks avoids offline object-store auth, while
//     still COMPILING the VRL transforms (which --no-environment would skip) -
//     this is what catches a normalize_logs/VRL that has folded to one line.
function checkVectorConfig(name, renderedYaml, runner) {
  const configs = extractVectorConfigs(renderedYaml);
  const problems = [];

  for (const { name: cmName, content } of configs) {
    const emptyDefaults = [...new Set(content.match(/\$\{[^}]*:-\}/g) || [])];
    if (emptyDefaults.length) {
      problems.push(
        `${cmName}: empty-default interpolation(s) render as YAML null: ${emptyDefaults.join(", ")}`,
      );
    }

    if (!runner) continue;

    let parsed;
    try {
      parsed = YAML.parse(content);
    } catch (err) {
      problems.push(`${cmName}: vector.yaml is not parseable YAML: ${err.message}`);
      continue;
    }

    const transforms = parsed?.transforms ?? {};
    if (Object.keys(transforms).length === 0) continue;

    // Isolate sources + transforms with a console sink so VRL compiles without
    // needing cloud-storage credentials/network.
    const minimal = {
      sources: parsed.sources ?? {},
      transforms,
      sinks: {
        _ci_validate: {
          type: "console",
          inputs: Object.keys(transforms),
          encoding: { codec: "json" },
        },
      },
    };
    const file = path.join(tmpDir, `${name}-${cmName}-validate.yaml`);
    fs.writeFileSync(file, YAML.stringify(minimal));
    try {
      runVectorValidate(runner, file);
    } catch (err) {
      const msg = (err.stderr || err.stdout || err.message || "")
        .toString()
        .trim();
      problems.push(`${cmName}: vector validate failed:\n${msg}`);
    }
  }

  if (problems.length) {
    console.error(`  FAIL ${name} (vector config)`);
    for (const problem of problems) {
      for (const line of problem.split("\n")) console.error(`       ${line}`);
    }
    return false;
  }
  return true;
}

if (!helmAvailable()) {
  console.error("helm is not installed or not on PATH; skipping chart verification.");
  process.exit(1);
}

if (!fs.existsSync(path.join(chartDir, "Chart.yaml"))) {
  console.error(`No Chart.yaml found in ${chartDir}.`);
  console.error("Pass --chart=<helm repo> or set RULEBRICKS_CHART_DIR.");
  process.exit(1);
}

if (buildDeps) {
  console.log(`Building chart dependencies in ${chartDir} ...`);
  try {
    run("helm", ["dependency", "build", chartDir], { stdio: "inherit" });
  } catch (err) {
    console.error("helm dependency build failed:", err.message);
    process.exit(1);
  }
}

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "rb-verify-"));
const matrix = buildConfigMatrix();
let failures = 0;

const vectorMode = vectorRunner();
console.log(
  vectorMode
    ? `Vector config validation: enabled (${vectorMode})`
    : "Vector config validation: skipped (no vector binary or docker; regex guard only)",
);

for (const { name, config } of matrix) {
  const values = buildHelmValues(config);
  const valuesPath = path.join(tmpDir, `${name}.yaml`);
  fs.writeFileSync(valuesPath, YAML.stringify(values));

  try {
    const rendered = run("helm", [
      "template",
      `rb-${name}`,
      chartDir,
      "--namespace",
      "rulebricks-verify",
      "--values",
      valuesPath,
    ]);
    if (checkVectorConfig(name, rendered, vectorMode)) {
      console.log(`  ok   ${name}`);
    } else {
      failures += 1;
    }
  } catch (err) {
    failures += 1;
    const stderr = (err.stderr || err.message || "").toString().trim();
    console.error(`  FAIL ${name}`);
    for (const line of stderr.split("\n")) {
      console.error(`       ${line}`);
    }
    if (/missing in charts|found in Chart.yaml, but missing/.test(stderr)) {
      console.error(
        "       (chart dependencies not built - rerun with --build-deps)",
      );
      break;
    }
  }
}

fs.rmSync(tmpDir, { recursive: true, force: true });

if (failures > 0) {
  console.error(`\n${failures} config(s) failed chart rendering.`);
  process.exit(1);
}
console.log(`\nAll ${matrix.length} configs rendered cleanly against the chart.`);
