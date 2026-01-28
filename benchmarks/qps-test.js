/**
 * QPS (Queries Per Second) Benchmark Test
 *
 * Measures API responsiveness by sending individual payload requests at a constant rate.
 * This test helps you understand:
 * - How many individual requests your deployment can handle per second
 * - API gateway and connection handling performance
 * - Response latency under load
 *
 * Test Structure:
 * - 1 minute warm-up phase (allows cluster to scale, excluded from results)
 * - 4 minutes measurement phase (steady-state performance)
 *
 * Usage:
 *   k6 run -e API_URL=https://your-instance.com/api/v1/flows/flow_id \
 *          -e API_KEY=your-api-key \
 *          qps-test.js
 *
 * Optional environment variables:
 *   TEST_DURATION - Measurement duration after warm-up (default: 4m)
 *   TARGET_RPS    - Target requests per second (default: 500)
 */

import { check } from "k6";
import http from "k6/http";
import { Counter, Rate, Trend } from "k6/metrics";
import {
  generatePayload,
  getConfig,
  createRequestParams,
} from "./lib/payload.js";
import { generateQpsReport, generateQpsConsoleSummary } from "./lib/report.js";

// Load configuration
const config = getConfig({
  testDuration: "4m",
  targetRps: 500,
});

// Custom metrics (only for measurement phase)
const errorRate = new Rate("errors");
const successRate = new Rate("successes");
const requestDuration = new Trend("request_duration");
const droppedRequests = new Counter("dropped_requests");

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
      maxVUs: Math.min(config.targetRps * 2, 1000),
      exec: "warmUp",
      tags: { phase: "warmup" },
    },
    // Measurement phase: actual test after warm-up
    qps_test: {
      executor: "constant-arrival-rate",
      rate: config.targetRps,
      timeUnit: "1s",
      duration: config.testDuration,
      preAllocatedVUs: Math.min(config.targetRps, 200),
      maxVUs: Math.min(config.targetRps * 2, 1000),
      startTime: "1m", // Start after warm-up
      exec: "measureTest",
      tags: { phase: "measurement" },
    },
  },
  thresholds: {
    // Only apply thresholds to measurement phase
    "http_req_duration{phase:measurement}": ["p(95)<500", "p(99)<1000"],
    "errors{phase:measurement}": ["rate<0.05"],
  },
};

// Request parameters
const params = createRequestParams(config.apiKey);

/**
 * Warm-up function - same as test but metrics tagged differently
 */
export function warmUp() {
  const payload = generatePayload();

  try {
    http.post(config.apiUrl, JSON.stringify(payload), params);
  } catch (error) {
    // Ignore errors during warm-up
  }
}

/**
 * Measurement test function - sends individual requests
 */
export function measureTest() {
  const payload = generatePayload();
  const start = Date.now();

  try {
    const response = http.post(config.apiUrl, JSON.stringify(payload), params);

    const duration = Date.now() - start;
    requestDuration.add(duration);

    const success = check(response, {
      "status is 200": (r) => r.status === 200,
      "valid response": (r) => r.body && r.body.length > 0,
    });

    errorRate.add(!success);
    successRate.add(success);

    if (!success) {
      droppedRequests.add(1);
    }
  } catch (error) {
    errorRate.add(1);
    successRate.add(0);
    droppedRequests.add(1);
  }
}

/**
 * Generate summary report
 */
export function handleSummary(data) {
  return {
    stdout: generateQpsConsoleSummary(data, config),
    "qps-report.html": generateQpsReport(data, config),
    "qps-results.json": JSON.stringify(data, null, 2),
  };
}
