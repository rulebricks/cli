import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { Ajv, type ErrorObject, type ValidateFunction } from "ajv";
import YAML from "yaml";

/**
 * Validates generated Helm values against the chart's values.schema.json.
 *
 * The schema is bundled with the CLI (schema/values.schema.json) and kept in
 * sync with the Helm chart via `npm run sync-schema`. This gives us a last-line
 * guardrail: the CLI refuses to deploy values the chart would reject at install
 * time, surfacing a readable message instead of a raw Helm/JSON-schema error.
 */

export interface ValuesValidationResult {
  valid: boolean;
  errors: string[];
}

let cachedValidator: ValidateFunction | null = null;

function getBundledSchemaPath(): string {
  // Compiled location: dist/lib/validateValues.js -> ../../schema/...
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(here, "../../schema/values.schema.json");
}

function loadValidator(): ValidateFunction {
  if (cachedValidator) return cachedValidator;
  const schema = JSON.parse(fs.readFileSync(getBundledSchemaPath(), "utf8"));
  // strict:false tolerates the chart schema's union types and `default`
  // keywords; allErrors collects every problem so we can report them together.
  const ajv = new Ajv({ allErrors: true, strict: false });
  const validate = ajv.compile(schema);
  cachedValidator = validate;
  return validate;
}

function pointerToPath(instancePath: string): string {
  if (!instancePath) return "";
  return instancePath
    .replace(/^\//, "")
    .split("/")
    .map((seg) => seg.replace(/~1/g, "/").replace(/~0/g, "~"))
    .join(".");
}

function describeError(err: ErrorObject): string | null {
  const where = pointerToPath(err.instancePath || "");
  const prefix = where ? `${where}` : "values";
  switch (err.keyword) {
    case "required": {
      const missing = (err.params as { missingProperty: string })
        .missingProperty;
      return `${where ? `${where}.` : ""}${missing} is required`;
    }
    case "minLength": {
      const limit = (err.params as { limit: number }).limit;
      return limit <= 1
        ? `${prefix} must not be empty`
        : `${prefix} must be at least ${limit} characters`;
    }
    case "enum": {
      const allowed = (err.params as { allowedValues: unknown[] }).allowedValues;
      return `${prefix} must be one of: ${allowed
        .map((v) => JSON.stringify(v))
        .join(", ")}`;
    }
    case "const": {
      const allowed = (err.params as { allowedValue: unknown }).allowedValue;
      return `${prefix} must be ${JSON.stringify(allowed)}`;
    }
    case "pattern":
      return `${prefix} has an invalid format`;
    case "type": {
      const type = (err.params as { type: string | string[] }).type;
      return `${prefix} must be of type ${
        Array.isArray(type) ? type.join(" or ") : type
      }`;
    }
    case "minimum": {
      const limit = (err.params as { limit: number }).limit;
      return `${prefix} must be >= ${limit}`;
    }
    case "additionalProperties": {
      const extra = (err.params as { additionalProperty: string })
        .additionalProperty;
      return `${prefix} has an unexpected property '${extra}'`;
    }
    default:
      return null;
  }
}

function formatErrors(errors: ErrorObject[] | null | undefined): string[] {
  if (!errors || errors.length === 0) {
    return ["Generated values failed schema validation."];
  }
  const messages = new Set<string>();
  for (const err of errors) {
    const message = describeError(err);
    if (message) messages.add(message);
  }
  if (messages.size === 0) {
    // Only structural (if/then/allOf) errors were present; surface a hint.
    messages.add(
      "Generated values do not satisfy a conditional schema rule (check storage, backup, external services, and monitoring settings).",
    );
  }
  return [...messages];
}

/* eslint-disable @typescript-eslint/no-explicit-any */
function get(obj: unknown, path: string[]): any {
  let cur: any = obj;
  for (const key of path) {
    if (cur === null || cur === undefined || typeof cur !== "object") {
      return undefined;
    }
    cur = cur[key];
  }
  return cur;
}

/**
 * Cross-field invariants the JSON schema cannot express. These encode the
 * Kafka sizing model: partitions are the worker-fleet concurrency ceiling,
 * topic names must carry the same prefix HPS/Vector/KEDA use, and worker CPU
 * requests must not exceed their (one-core) burst limit.
 */
export function validateValuesInvariants(values: unknown): string[] {
  const errors: string[] = [];

  const workers = get(values, ["rulebricks", "hps", "workers"]);
  const solutionPartitions = get(workers, ["solutionPartitions"]);
  const maxReplicaCount = get(workers, ["keda", "maxReplicaCount"]);

  // 1. Workers beyond the partition count would sit idle.
  if (
    typeof solutionPartitions === "number" &&
    typeof maxReplicaCount === "number" &&
    maxReplicaCount > solutionPartitions
  ) {
    errors.push(
      `rulebricks.hps.workers.keda.maxReplicaCount (${maxReplicaCount}) must be <= solutionPartitions (${solutionPartitions}); partitions are the fleet concurrency ceiling`,
    );
  }

  // 2. Single-threaded CPU-bound workers are Burstable: the request may sit
  //    below the limit (tight bin-packing + a cheap warm pool), but it must
  //    never exceed the limit. The limit is the per-worker burst ceiling (one
  //    core); under genuine node contention a Burstable worker can be
  //    CFS-throttled toward its request.
  const parseCpuMillicores = (value: unknown): number | undefined => {
    if (typeof value === "number") return value * 1000;
    if (typeof value !== "string") return undefined;
    const millicores = value.endsWith("m")
      ? Number(value.slice(0, -1))
      : Number(value) * 1000;
    return Number.isFinite(millicores) ? millicores : undefined;
  };
  const workerCpuRequest = get(workers, ["resources", "requests", "cpu"]);
  const workerCpuLimit = get(workers, ["resources", "limits", "cpu"]);
  const workerCpuRequestM = parseCpuMillicores(workerCpuRequest);
  const workerCpuLimitM = parseCpuMillicores(workerCpuLimit);
  if (
    workerCpuRequestM !== undefined &&
    workerCpuLimitM !== undefined &&
    workerCpuRequestM > workerCpuLimitM
  ) {
    errors.push(
      `rulebricks.hps.workers.resources cpu request (${workerCpuRequest}) must not exceed limit (${workerCpuLimit})`,
    );
  }

  // 3. In-cluster provisioning: topic names must carry the SAME prefix the
  //    application uses, and the solution topic must match solutionPartitions
  //    (which HPS receives as MAX_WORKERS). Mirrors the chart's render guard.
  const kafkaEnabled = get(values, ["kafka", "enabled"]);
  const kafkaTopics = get(values, ["kafka", "topics"]);
  if (kafkaEnabled && Array.isArray(kafkaTopics) && kafkaTopics.length > 0) {
    const logging = get(values, ["rulebricks", "app", "logging"]) ?? {};
    const prefix = Object.prototype.hasOwnProperty.call(
      logging,
      "kafkaTopicPrefix",
    )
      ? String(logging.kafkaTopicPrefix ?? "")
      : "com.rulebricks.";
    const topics: Array<{ name?: string; partitions?: number }> = kafkaTopics;
    const names = topics.map((t) => t?.name);

    for (const base of ["solution", "solution-response", "logs"]) {
      const expected = `${prefix}${base}`;
      if (!names.includes(expected)) {
        errors.push(
          `kafka.topics must include "${expected}" (kafkaTopicPrefix is "${prefix}"); found: ${names.join(", ") || "none"}`,
        );
      }
    }

    const solutionTopic = topics.find((t) => t?.name === `${prefix}solution`);
    if (
      typeof solutionPartitions === "number" &&
      solutionTopic &&
      typeof solutionTopic.partitions === "number" &&
      solutionTopic.partitions !== solutionPartitions
    ) {
      errors.push(
        `kafka "${prefix}solution" partitions (${solutionTopic.partitions}) must equal rulebricks.hps.workers.solutionPartitions (${solutionPartitions}); HPS derives MAX_WORKERS from it`,
      );
    }
  }

  // 4. Distributed tracing: when enabled, the collector must have a non-empty
  //    endpoint for the selected destination (the JSON schema also enforces
  //    this, but we surface a clearer message), and the active auth mode must
  //    carry its credential.
  const tracing = get(values, ["global", "tracing"]);
  if (tracing && tracing.enabled) {
    const destination = tracing.destination ?? "elastic";
    if (destination === "elastic") {
      const elastic = get(tracing, ["elastic"]) ?? {};
      if (!elastic.endpoint) {
        errors.push(
          "global.tracing.elastic.endpoint must be set when tracing destination is 'elastic'",
        );
      }
      const authMode = elastic.authMode ?? "secret-token";
      if (
        authMode === "secret-token" &&
        !elastic.secretToken &&
        !elastic.existingSecret?.name
      ) {
        errors.push(
          "global.tracing.elastic.secretToken (or existingSecret.name) is required for authMode 'secret-token'",
        );
      }
      if (
        authMode === "api-key" &&
        !elastic.apiKey &&
        !elastic.existingSecret?.name
      ) {
        errors.push(
          "global.tracing.elastic.apiKey (or existingSecret.name) is required for authMode 'api-key'",
        );
      }
    } else if (destination === "otlp") {
      const otlp = get(tracing, ["otlp"]) ?? {};
      if (!otlp.endpoint) {
        errors.push(
          "global.tracing.otlp.endpoint must be set when tracing destination is 'otlp'",
        );
      }
    } else if (destination === "azure-monitor") {
      const azure = get(tracing, ["azureMonitor"]) ?? {};
      if (!azure.connectionString && !azure.existingSecret?.name) {
        errors.push(
          "global.tracing.azureMonitor.connectionString (or existingSecret.name) is required when tracing destination is 'azure-monitor'",
        );
      }
    }
  }

  // 5. Application/container log shipping: when the Vector agent is enabled it
  //    must have exactly one configured external sink.
  const vectorAgent = get(values, ["vector-agent"]);
  if (vectorAgent && vectorAgent.enabled) {
    const sinks = get(vectorAgent, ["customConfig", "sinks"]) as
      | Record<string, unknown>
      | undefined;
    const elasticsearchEndpoints = get(sinks, ["elasticsearch", "endpoints"]);
    const hasElasticsearch =
      Array.isArray(elasticsearchEndpoints) &&
      elasticsearchEndpoints.some(
        (e) => typeof e === "string" && e.length > 0,
      );
    const lokiEndpoint = get(sinks, ["loki", "endpoint"]);
    const hasLoki = typeof lokiEndpoint === "string" && lokiEndpoint.length > 0;
    const genericUri = get(sinks, ["generic_http", "uri"]);
    const hasGeneric = typeof genericUri === "string" && genericUri.length > 0;

    if (!hasElasticsearch && !hasLoki && !hasGeneric) {
      errors.push(
        "vector-agent is enabled but no app-log sink endpoint is configured; set features.logging.appLogs for elasticsearch, loki, or generic",
      );
    }
  }

  return errors;
}

/**
 * Validates a generated Helm values object against the bundled chart schema
 * plus cross-field invariants the schema cannot express.
 * Values are round-tripped through YAML first so we validate exactly what Helm
 * receives (dropping `undefined`, normalizing numbers, etc.).
 */
export function validateHelmValues(values: unknown): ValuesValidationResult {
  const normalized = YAML.parse(YAML.stringify(values));
  const validate = loadValidator();
  const valid = validate(normalized) as boolean;
  const errors = valid ? [] : formatErrors(validate.errors);
  errors.push(...validateValuesInvariants(normalized));
  if (errors.length === 0) return { valid: true, errors: [] };
  return { valid: false, errors };
}

/**
 * Throws a readable error if the values are invalid. Used as a pre-deploy
 * guardrail so we never hand Helm a config the chart would reject.
 */
export function assertValidHelmValues(values: unknown): void {
  const result = validateHelmValues(values);
  if (result.valid) return;
  throw new Error(
    [
      "Generated Helm values are not valid for the Rulebricks chart:",
      ...result.errors.map((e) => `  • ${e}`),
    ].join("\n"),
  );
}
