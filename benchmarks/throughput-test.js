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
  generateBulkPayload,
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
const failedPayloads = new Counter("failed_payloads");

// Allow overriding the VU ceiling so the generator doesn't cap out before
// the server does (default mirrors the original min(rps*3, 500) behavior).
const maxVUs = parseInt(__ENV.MAX_VUS) || Math.min(config.targetRps * 3, 500);

// k6 options with warm-up and measurement phases
export const options = {
  scenarios: {
    // Warm-up phase: 1 minute to let cluster scale
    warm_up: {
      executor: "constant-arrival-rate",
      rate: config.targetRps,
      timeUnit: "1s",
      duration: "1m",
      preAllocatedVUs: Math.min(config.targetRps, 200),
      maxVUs: maxVUs,
      exec: "warmUp",
      tags: { phase: "warmup" },
    },
    // Measurement phase: actual test after warm-up
    throughput_test: {
      executor: "constant-arrival-rate",
      rate: config.targetRps,
      timeUnit: "1s",
      duration: config.testDuration,
      preAllocatedVUs: Math.min(config.targetRps, 200),
      maxVUs: maxVUs,
      startTime: "1m", // Start after warm-up
      exec: "measureTest",
      tags: { phase: "measurement" },
    },
  },
  thresholds: {
    // Only apply thresholds to measurement phase
    "http_req_duration{phase:measurement}": ["p(95)<2000", "p(99)<5000"],
    "errors{phase:measurement}": ["rate<0.05"],
  },
};

// Request parameters (longer timeout for bulk requests)
const params = createRequestParams(config.apiKey, "30s");

/**
 * Pre-stringified body pool, built lazily per VU. Generating and stringifying
 * 500-1000 payload objects per iteration saturates the load generator's CPU
 * long before the server saturates; a small rotating pool keeps payload
 * variety while making send cost O(1).
 */
const POOL_SIZE = 4;
let bodyPool = null;
function getBody(iter) {
  if (!bodyPool) {
    bodyPool = [];
    for (let i = 0; i < POOL_SIZE; i++) {
      bodyPool.push(JSON.stringify(generateBulkPayload(config.bulkSize, `pool${i}`)));
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

  try {
    const response = http.post(config.apiUrl, getBody(__ITER), params);

    const duration = Date.now() - start;
    requestDuration.add(duration);

    const success = check(response, {
      "status is 200": (r) => r.status === 200,
      "valid response": (r) => r.body && r.body.length > 0,
      "no error in response": (r) => {
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

    if (!success) {
      droppedRequests.add(1);
      failedPayloads.add(config.bulkSize);
    }
  } catch (error) {
    errorRate.add(1);
    successRate.add(0);
    droppedRequests.add(1);
    totalPayloads.add(config.bulkSize);
    failedPayloads.add(config.bulkSize);
  }
}

/**
 * Generate summary report
 */
export function handleSummary(data) {
  return {
    stdout: generateThroughputConsoleSummary(data, config),
    "throughput-report.html": generateThroughputReport(data, config),
    "throughput-results.json": JSON.stringify(data, null, 2),
  };
}
