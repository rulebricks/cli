/**
 * Shared payload generation utilities for Rulebricks benchmarking.
 *
 * The generator intentionally has no CDN imports so an in-cluster k6 Job does
 * not depend on public egress. All generated strings are ASCII, which makes
 * JavaScript string length equal to the UTF-8 byte length used on the wire.
 */

function randomIntBetween(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

const ALPHANUMERIC =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";

function randomString(length) {
  let result = "";
  for (let i = 0; i < length; i++) {
    result += ALPHANUMERIC[randomIntBetween(0, ALPHANUMERIC.length - 1)];
  }
  return result;
}

/**
 * Optional payload byte-size shaping: when TARGET_PAYLOAD_BYTES is set, each
 * payload is padded so its serialized JSON is approximately that many bytes.
 * This lets benchmarks sweep payload SIZE independently of payload COUNT
 * (needed for chunk-planner calibration and shape-invariance testing).
 */
const TARGET_PAYLOAD_BYTES = parseInt(__ENV.TARGET_PAYLOAD_BYTES) || 0;
const TARGET_REQUEST_BYTES = parseInt(__ENV.TARGET_REQUEST_BYTES) || 0;
const PAYLOAD_PROFILE = (__ENV.PAYLOAD_PROFILE || "benchmark").toLowerCase();
const QUOTE_LINES = Math.max(1, parseInt(__ENV.QUOTE_LINES) || 1);
const CATALOG_ROWS = Math.max(2, parseInt(__ENV.CATALOG_ROWS) || 20000);
const MATCH_PROFILE = (__ENV.MATCH_PROFILE || "uniform").toLowerCase();

if (!["benchmark", "pricing"].includes(PAYLOAD_PROFILE)) {
  throw new Error("PAYLOAD_PROFILE must be benchmark or pricing");
}

if (!["early", "uniform", "tail", "unmatched"].includes(MATCH_PROFILE)) {
  throw new Error(
    "MATCH_PROFILE must be early, uniform, tail, or unmatched"
  );
}

/**
 * Optional fixed `n` field (PAYLOAD_N): flows whose rules key on `n` require
 * it in every payload. -1 matches only the catch-all row of the chunk-lab
 * heavy fixture, making each item pay the full-table evaluation.
 */
const PAYLOAD_N = __ENV.PAYLOAD_N !== undefined && __ENV.PAYLOAD_N !== ""
  ? Number(__ENV.PAYLOAD_N)
  : null;

// Filler built from 1 KiB random segments: repeated segments keep generation
// cheap for megabyte payloads while avoiding the near-total compression a
// single repeated character would get on the Kafka (snappy) hops. Built
// lazily once per VU and sliced per payload.
let fillerBlock = null;
function getFiller(length) {
  if (length <= 0) return "";
  if (!fillerBlock || fillerBlock.length < length) {
    const segment = randomString(1024);
    fillerBlock = segment.repeat(Math.ceil(length / segment.length));
  }
  return fillerBlock.slice(0, length);
}

function padObjectToBytes(payload, targetBytes, key) {
  if (targetBytes <= 0) return payload;
  const base = JSON.stringify(payload);
  if (base.length > targetBytes) {
    throw new Error(
      `${key} target ${targetBytes} bytes is below the ${base.length}-byte structured payload`
    );
  }
  if (base.length === targetBytes) return payload;

  payload[key] = "";
  const withEmptyPadding = JSON.stringify(payload);
  if (withEmptyPadding.length > targetBytes) {
    throw new Error(
      `${key} target ${targetBytes} bytes leaves too little room for padding metadata`
    );
  }
  payload[key] = getFiller(targetBytes - withEmptyPadding.length);
  const actual = JSON.stringify(payload).length;
  if (actual !== targetBytes) {
    throw new Error(
      `${key} byte shaping failed: target=${targetBytes} actual=${actual}`
    );
  }
  return payload;
}

function skuFor(id, lineIndex) {
  const seed = Math.abs(
    String(id || "")
      .split("")
      .reduce((sum, char) => (sum * 33 + char.charCodeAt(0)) | 0, lineIndex + 1)
  );
  let index;
  switch (MATCH_PROFILE) {
    case "early":
      index = lineIndex % Math.min(8, CATALOG_ROWS - 1);
      break;
    case "tail":
      index = CATALOG_ROWS - 2;
      break;
    case "unmatched":
      return `SKU-MISSING-${lineIndex}`;
    case "uniform":
    default:
      index = seed % (CATALOG_ROWS - 1);
      break;
  }
  return `SKU-${String(index).padStart(6, "0")}`;
}

function pricingPayload(id) {
  const lines = Array.from({ length: QUOTE_LINES }, (_, lineIndex) => ({
    sku: skuFor(id, lineIndex),
    quantity: 1 + ((lineIndex + String(id || "").length) % 5),
  }));
  const first = lines[0];
  return {
    request_id: id || `quote_${__VU}_${__ITER}_${Date.now()}`,
    account_id: `ACCT-${String((__VU * 7919 + __ITER) % 10000).padStart(5, "0")}`,
    sku: first.sku,
    quantity: first.quantity,
    tier: ["STANDARD", "GOLD", "PLATINUM"][(__VU + __ITER) % 3],
    region: `R-${String((__VU * 7 + __ITER) % 50).padStart(2, "0")}`,
    promo_code: (__VU + __ITER) % 3 === 0 ? "SAVE10" : "NONE",
    currency: "USD",
    family: "FAM-00",
    account_band: `B-${String((__VU + __ITER) % 20).padStart(2, "0")}`,
    jurisdiction: ["US", "CA", "EU", "APAC"][(__VU + __ITER) % 4],
    lines,
  };
}

function benchmarkPayload(id) {
  const payload = {
    req_id: id || `req_${__VU}_${__ITER}_${Date.now()}`,
    alpha:
      Math.random() < 0.5 ? randomIntBetween(0, 9) : randomIntBetween(10, 100),
    beta: Math.random() < 0.5 ? "" : randomString(randomIntBetween(1, 10)),
    charlie: Math.random() < 0.5,
  };
  if (PAYLOAD_N !== null) payload.n = PAYLOAD_N;
  return payload;
}

/**
 * Generate a single test payload
 *
 * The payload structure is designed to exercise various rule conditions:
 * - alpha: numeric value (sometimes small 0-9, sometimes larger 10-100)
 * - beta: string value (sometimes empty, sometimes random)
 * - charlie: boolean value
 *
 * @param {string} [id] - Optional request ID for tracking
 * @returns {Object} Generated payload
 */
export function generatePayload(id) {
  const payload =
    PAYLOAD_PROFILE === "pricing" ? pricingPayload(id) : benchmarkPayload(id);
  if (TARGET_PAYLOAD_BYTES > 0) {
    padObjectToBytes(payload, TARGET_PAYLOAD_BYTES, "_item_padding");
  }
  return payload;
}

/**
 * Generate a bulk payload (array of payloads)
 *
 * @param {number} size - Number of payloads to generate
 * @param {string} [prefix] - Optional prefix for request IDs
 * @returns {Array<Object>} Array of generated payloads
 */
export function generateBulkPayload(size, prefix = "bulk") {
  const payloads = [];
  for (let i = 0; i < size; i++) {
    payloads.push(generatePayload(`${prefix}_${__VU}_${__ITER}_${i}`));
  }
  return payloads;
}

/**
 * Generate and stringify one bulk request. TARGET_REQUEST_BYTES pads the final
 * item after all structured and per-item shaping so the complete JSON array is
 * exact. This is the source of truth for request-size matrix cells.
 */
export function generateBulkBody(size, prefix = "bulk") {
  const payloads = generateBulkPayload(size, prefix);
  let body = JSON.stringify(payloads);
  if (TARGET_REQUEST_BYTES <= 0) return body;
  if (body.length > TARGET_REQUEST_BYTES) {
    throw new Error(
      `TARGET_REQUEST_BYTES=${TARGET_REQUEST_BYTES} is below the generated ${body.length}-byte body`
    );
  }
  if (body.length === TARGET_REQUEST_BYTES) return body;
  if (payloads.length === 0) {
    throw new Error("Cannot pad an empty bulk request");
  }

  const last = payloads[payloads.length - 1];
  last._request_padding = "";
  const withEmptyPadding = JSON.stringify(payloads);
  if (withEmptyPadding.length > TARGET_REQUEST_BYTES) {
    throw new Error(
      `TARGET_REQUEST_BYTES=${TARGET_REQUEST_BYTES} leaves too little room for request padding metadata`
    );
  }
  last._request_padding = getFiller(
    TARGET_REQUEST_BYTES - withEmptyPadding.length
  );
  body = JSON.stringify(payloads);
  if (body.length !== TARGET_REQUEST_BYTES) {
    throw new Error(
      `request byte shaping failed: target=${TARGET_REQUEST_BYTES} actual=${body.length}`
    );
  }
  return body;
}

export function getPayloadShape() {
  return {
    profile: PAYLOAD_PROFILE,
    target_payload_bytes: TARGET_PAYLOAD_BYTES || null,
    target_request_bytes: TARGET_REQUEST_BYTES || null,
    quote_lines: PAYLOAD_PROFILE === "pricing" ? QUOTE_LINES : null,
    catalog_rows: PAYLOAD_PROFILE === "pricing" ? CATALOG_ROWS : null,
    match_profile: PAYLOAD_PROFILE === "pricing" ? MATCH_PROFILE : null,
  };
}

/**
 * Validate required environment variables
 *
 * @throws {Error} If required variables are missing
 */
export function validateConfig() {
  if (!__ENV.API_URL) {
    throw new Error(
      "API_URL is required. Usage: k6 run -e API_URL=https://your-instance.com/api/v1/flows/flow_id ..."
    );
  }
  if (!__ENV.API_KEY) {
    throw new Error(
      "API_KEY is required. Usage: k6 run -e API_KEY=your-api-key ..."
    );
  }
}

/**
 * Get configuration from environment variables with defaults
 *
 * @param {Object} defaults - Default values for configuration
 * @returns {Object} Configuration object
 */
export function getConfig(defaults = {}) {
  validateConfig();

  return {
    apiUrl: __ENV.API_URL,
    apiKey: __ENV.API_KEY,
    testDuration: __ENV.TEST_DURATION || defaults.testDuration || "4m",
    targetRps: parseInt(__ENV.TARGET_RPS) || defaults.targetRps || 500,
    bulkSize: parseInt(__ENV.BULK_SIZE) || defaults.bulkSize || 50,
  };
}

/**
 * Create HTTP request parameters
 *
 * @param {string} apiKey - API key for authentication
 * @param {string} [timeout] - Request timeout
 * @returns {Object} HTTP request parameters for k6
 */
export function createRequestParams(apiKey, timeout = "10s") {
  return {
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
    },
    timeout: timeout,
    insecureSkipTLSVerify: true,
  };
}
