/**
 * Throughput (Solutions Per Second) Benchmark Test
 *
 * Measures rule engine capacity by sending bulk payload requests at a constant rate.
 * This test helps you understand:
 * - How many rule evaluations your deployment can process per second
 * - Maximum throughput for batch workloads
 * - Engine performance under sustained load
 *
 * Test Structure:
 * - 1 minute warm-up phase (allows cluster to scale, excluded from results)
 * - 4 minutes measurement phase (steady-state performance)
 *
 * Usage:
 *   k6 run -e API_URL=https://your-instance.com/api/v1/flows/flow_id \
 *          -e API_KEY=your-api-key \
 *          throughput-test.js
 *
 * Optional environment variables:
 *   TEST_DURATION - Measurement duration after warm-up (default: 4m)
 *   TARGET_RPS    - Target bulk requests per second (default: 100)
 *   BULK_SIZE     - Number of payloads per request (default: 50)
 */

import { check } from "k6";
import http from "k6/http";
import { Counter, Rate, Trend } from "k6/metrics";
import {
  generateBulkBody,
  getPayloadShape,
  getConfig,
  createRequestParams,
} from "./lib/payload.js";
import {
  generateThroughputReport,
  generateThroughputConsoleSummary,
} from "./lib/report.js";

// Load configuration
const config = getConfig({
  testDuration: "4m",
  targetRps: 100,
  bulkSize: 50,
});

// Custom metrics (only for measurement phase)
const errorRate = new Rate("errors");
const successRate = new Rate("successes");
const requestDuration = new Trend("request_duration");
const droppedRequests = new Counter("dropped_requests");
const totalPayloads = new Counter("total_payloads");
const successfulPayloads = new Counter("successful_payloads");
const failedPayloads = new Counter("failed_payloads");
const successfulRequests = new Counter("successful_requests");
const failedRequests = new Counter("failed_requests");
const requestBodyBytes = new Trend("request_body_bytes", true);
const responseBodyBytes = new Trend("response_body_bytes", true);
const inputBytes = new Counter("input_bytes");
const outputBytes = new Counter("output_bytes");
const status2xx = new Counter("status_2xx");
const status4xx = new Counter("status_4xx");
const status5xx = new Counter("status_5xx");
const status413 = new Counter("status_413");
const status429 = new Counter("status_429");
const statusTimeout = new Counter("status_timeout");
const payloadShape = getPayloadShape();
const validateBody = __ENV.VALIDATE_BODY !== "0";
const expectedStatus = parseInt(__ENV.EXPECTED_STATUS) || 200;
const requestTimeout = __ENV.K6_REQUEST_TIMEOUT || "310s";

// Allow overriding the VU ceiling so the generator doesn't cap out before
// the server does (default mirrors the original min(rps*3, 500) behavior).
const maxVUs = parseInt(__ENV.MAX_VUS) || Math.min(config.targetRps * 3, 500);
const preAllocatedVUs = Math.min(
  maxVUs,
  parseInt(__ENV.PREALLOCATED_VUS) || Math.min(config.targetRps, 200)
);

// Warm-up length is overridable so short calibration cells don't spend a
// full minute warming an already-warm system (default preserved).
const warmupDuration = __ENV.WARMUP_DURATION || "1m";
const warmupEnabled = !/^0+(?:ms|s|m|h)$/.test(warmupDuration);
const scenarios = {
  throughput_test: {
    executor: "constant-arrival-rate",
    rate: config.targetRps,
    timeUnit: "1s",
    duration: config.testDuration,
    preAllocatedVUs,
    maxVUs: maxVUs,
    ...(warmupEnabled ? { startTime: warmupDuration } : {}),
    // Let every scheduled in-flight request report its terminal outcome. The
    // server/client timeout remains the upper bound for deliberately
    // overloaded cells.
    gracefulStop: __ENV.K6_GRACEFUL_STOP || requestTimeout,
    exec: "measureTest",
    tags: { phase: "measurement" },
  },
};
if (warmupEnabled) {
  scenarios.warm_up = {
    executor: "constant-arrival-rate",
    rate: config.targetRps,
    timeUnit: "1s",
    duration: warmupDuration,
    preAllocatedVUs,
    maxVUs: maxVUs,
    exec: "warmUp",
    tags: { phase: "warmup" },
  };
}

// k6 options with warm-up and measurement phases
export const options = {
  discardResponseBodies: !validateBody,
  scenarios,
  thresholds: {
    // Only apply thresholds to measurement phase
    "http_req_duration{phase:measurement}": ["p(95)<2000", "p(99)<5000"],
    "errors{phase:measurement}": ["rate<0.05"],
    "dropped_iterations{phase:measurement}": ["count<1"],
  },
  // Include p(99) in exported trend summaries for report extraction.
  summaryTrendStats: ["avg", "min", "med", "max", "p(90)", "p(95)", "p(99)"],
};

// Request parameters (above the server's 60s RPC deadline so the benchmark
// measures server behavior, not the client cap)
const params = createRequestParams(config.apiKey, requestTimeout);

/**
 * Pre-stringified body pool, built lazily per VU. Generating and stringifying
 * 500-1000 payload objects per iteration saturates the load generator's CPU
 * long before the server saturates; a small rotating pool keeps payload
 * variety while making send cost O(1).
 */
const POOL_SIZE =
  parseInt(__ENV.BODY_POOL_SIZE) ||
  (payloadShape.target_request_bytes >= 1024 * 1024 ? 1 : 4);
let bodyPool = null;
function getBody(iter) {
  if (!bodyPool) {
    bodyPool = [];
    for (let i = 0; i < POOL_SIZE; i++) {
      bodyPool.push(generateBulkBody(config.bulkSize, `pool${i}`));
    }
  }
  return bodyPool[iter % POOL_SIZE];
}

/**
 * Warm-up function - same as test but metrics tagged differently
 */
export function warmUp() {
  try {
    http.post(config.apiUrl, getBody(__ITER), params);
  } catch (error) {
    // Ignore errors during warm-up
  }
}

/**
 * Measurement test function - sends bulk requests
 */
export function measureTest() {
  const start = Date.now();
  const body = getBody(__ITER);

  try {
    const response = http.post(config.apiUrl, body, params);

    const duration = Date.now() - start;
    requestDuration.add(duration);
    requestBodyBytes.add(body.length);
    inputBytes.add(body.length);
    const declaredLength = Number(
      response.headers?.["Content-Length"] ||
        response.headers?.["content-length"] ||
        0
    );
    const receivedBytes = response.body
      ? String(response.body).length
      : Number.isFinite(declaredLength)
        ? declaredLength
        : 0;
    responseBodyBytes.add(receivedBytes);
    outputBytes.add(receivedBytes);
    if (response.status >= 200 && response.status < 300) status2xx.add(1);
    if (response.status >= 400 && response.status < 500) status4xx.add(1);
    if (response.status >= 500) status5xx.add(1);
    if (response.status === 413) status413.add(1);
    if (response.status === 429) status429.add(1);

    const success = check(response, {
      "status is expected": (r) => r.status === expectedStatus,
      "valid response": (r) =>
        !validateBody ||
        expectedStatus !== 200 ||
        Boolean(r.body && r.body.length > 0),
      "no error in response": (r) => {
        if (!validateBody || expectedStatus !== 200) return true;
        try {
          const body = JSON.parse(r.body);
          return !body.error;
        } catch (e) {
          return false;
        }
      },
    });

    // Diagnostic: log failing responses so we can classify the failure mode.
    if (!success) {
      console.warn(
        `FAIL status=${response.status} dur=${duration}ms body=${String(
          response.body || ""
        ).slice(0, 300)}`
      );
    }

    errorRate.add(!success);
    successRate.add(success);
    totalPayloads.add(config.bulkSize);

    if (success) {
      successfulRequests.add(1);
      successfulPayloads.add(config.bulkSize);
    } else {
      failedRequests.add(1);
      droppedRequests.add(1);
      failedPayloads.add(config.bulkSize);
    }
  } catch (error) {
    requestBodyBytes.add(body.length);
    inputBytes.add(body.length);
    statusTimeout.add(1);
    errorRate.add(1);
    successRate.add(0);
    failedRequests.add(1);
    droppedRequests.add(1);
    totalPayloads.add(config.bulkSize);
    failedPayloads.add(config.bulkSize);
  }
}

/**
 * Generate summary report
 */
export function handleSummary(data) {
  const enriched = {
    ...data,
    benchmark_metadata: {
      api_url: config.apiUrl.replace(/\/api\/v1\/.*/, "/api/v1/[redacted]"),
      target_rps: config.targetRps,
      bulk_size: config.bulkSize,
      warmup_duration: warmupDuration,
      test_duration: config.testDuration,
      max_vus: maxVUs,
      body_pool_size: POOL_SIZE,
      validate_body: validateBody,
      expected_status: expectedStatus,
      request_timeout: requestTimeout,
      payload_shape: payloadShape,
    },
  };
  return {
    stdout: generateThroughputConsoleSummary(data, config),
    "throughput-report.html": generateThroughputReport(data, config),
    "throughput-results.json": JSON.stringify(enriched, null, 2),
  };
}
