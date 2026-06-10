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

/**
 * Validates a generated Helm values object against the bundled chart schema.
 * Values are round-tripped through YAML first so we validate exactly what Helm
 * receives (dropping `undefined`, normalizing numbers, etc.).
 */
export function validateHelmValues(values: unknown): ValuesValidationResult {
  const normalized = YAML.parse(YAML.stringify(values));
  const validate = loadValidator();
  const valid = validate(normalized) as boolean;
  if (valid) return { valid: true, errors: [] };
  return { valid: false, errors: formatErrors(validate.errors) };
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
