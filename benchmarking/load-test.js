import {
  randomIntBetween,
  randomString,
} from "https://jslib.k6.io/k6-utils/1.2.0/index.js";
import { check } from "k6";
import http from "k6/http";
import { Counter, Rate, Trend } from "k6/metrics";

// API Configuration - Set via environment variables
const API_URL =
  __ENV.API_URL ||
  "https://<your-private-rulebricks-instance>.com/api/v1/flows/<your_test_flow_slug>";
const API_KEY = __ENV.API_KEY || "<your_api_key>";

// Test Configuration (defaults are for the 'small' tier)
const CONSTANT_RPS = 100;
const BULK_SIZE = 50;
const TEST_DURATION = "5m"; // 5 minutes of constant load

// Custom metrics
const errorRate = new Rate("errors");
const successRate = new Rate("successes");
const requestDuration = new Trend("request_duration");
const droppedRequests = new Counter("dropped_requests");
const totalPayloads = new Counter("total_payloads");
const failedPayloads = new Counter("failed_payloads");

export const options = {
  scenarios: {
    bulk_constant: {
      executor: "constant-arrival-rate",
      rate: CONSTANT_RPS,
      timeUnit: "1s",
      duration: TEST_DURATION,
      preAllocatedVUs: 100,
      maxVUs: 500,
    },
  },
  thresholds: {
    http_req_duration: ["p(95)<2000", "p(99)<5000"],
    errors: ["rate<0.05"],
  },
};

// Generate request payload
function generatePayload(id) {
  return {
    req_id: id || `req_${__VU}_${__ITER}_${Date.now()}`,
    alpha:
      Math.random() < 0.5 ? randomIntBetween(0, 9) : randomIntBetween(10, 100),
    beta: Math.random() < 0.5 ? "" : randomString(randomIntBetween(1, 10)),
    charlie: Math.random() < 0.5,
  };
}

// Main test function
export default function () {
  // Generate bulk payload with fixed size of 100
  const bulkPayload = [];
  for (let i = 0; i < BULK_SIZE; i++) {
    bulkPayload.push(generatePayload(`bulk_${__VU}_${__ITER}_${i}`));
  }

  const params = {
    headers: {
      "Content-Type": "application/json",
      "x-api-key": API_KEY,
    },
    timeout: "30s", // Increased timeout for bulk requests
    insecureSkipTLSVerify: true,
  };

  const start = Date.now();
  let success = false;
  let response;

  try {
    response = http.post(API_URL, JSON.stringify(bulkPayload), params);
    const duration = Date.now() - start;
    requestDuration.add(duration);

    success = check(response, {
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

    errorRate.add(!success);
    successRate.add(success);

    // Track total payloads processed
    totalPayloads.add(BULK_SIZE);

    if (!success) {
      droppedRequests.add(1);
      failedPayloads.add(BULK_SIZE);
    }
  } catch (error) {
    errorRate.add(1);
    successRate.add(0);
    droppedRequests.add(1);
    failedPayloads.add(BULK_SIZE);
    totalPayloads.add(BULK_SIZE);
  }
}

// Handle summary
export function handleSummary(data) {
  const metrics = data.metrics;
  let summary = "\n\n=== BULK LOAD TEST RESULTS ===\n\n";

  // Test configuration
  summary += "TEST CONFIGURATION:\n";
  summary += `  Target RPS: ${CONSTANT_RPS} requests/second\n`;
  summary += `  Bulk Size: ${BULK_SIZE} payloads per request\n`;
  summary += `  Test Duration: ${TEST_DURATION}\n`;
  summary += `  Target Throughput: ${
    CONSTANT_RPS * BULK_SIZE
  } payloads/second\n\n`;

  // Overall test metrics
  const totalRequests =
    (metrics.http_reqs &&
      metrics.http_reqs.values &&
      metrics.http_reqs.values.count) ||
    0;
  const totalDuration =
    data.state && data.state.testRunDurationMs
      ? data.state.testRunDurationMs / 1000
      : 0;
  const actualRPS = totalRequests / totalDuration;
  const actualThroughput = actualRPS * BULK_SIZE;

  summary += "ACTUAL PERFORMANCE:\n";
  summary += `  Total Requests: ${totalRequests}\n`;
  summary += `  Test Duration: ${totalDuration.toFixed(1)} seconds\n`;
  summary += `  Actual RPS: ${actualRPS.toFixed(2)} requests/second\n`;
  summary += `  Actual Throughput: ${actualThroughput.toFixed(
    0
  )} payloads/second\n\n`;

  // Response time analysis
  summary += "RESPONSE TIME METRICS:\n";
  if (metrics.request_duration && metrics.request_duration.values) {
    const values = metrics.request_duration.values;
    summary += `  Average: ${values.avg ? values.avg.toFixed(2) : "N/A"} ms\n`;
    summary += `  Median: ${values.med ? values.med.toFixed(2) : "N/A"} ms\n`;
    summary += `  Min: ${values.min ? values.min.toFixed(2) : "N/A"} ms\n`;
    summary += `  Max: ${values.max ? values.max.toFixed(2) : "N/A"} ms\n`;
    summary += `  P90: ${
      values["p(90)"] ? values["p(90)"].toFixed(2) : "N/A"
    } ms\n`;
    summary += `  P95: ${
      values["p(95)"] ? values["p(95)"].toFixed(2) : "N/A"
    } ms\n`;
    summary += `  P99: ${
      values["p(99)"] ? values["p(99)"].toFixed(2) : "N/A"
    } ms\n\n`;
  }

  // Success and error rates
  summary += "RELIABILITY METRICS:\n";
  const successRateValue =
    (metrics.successes &&
      metrics.successes.values &&
      metrics.successes.values.rate) ||
    0;
  const errorRateValue =
    (metrics.errors && metrics.errors.values && metrics.errors.values.rate) ||
    0;

  summary += `  Success Rate: ${(successRateValue * 100).toFixed(2)}%\n`;
  summary += `  Error Rate: ${(errorRateValue * 100).toFixed(2)}%\n`;
  summary += `  Dropped Requests: ${
    (metrics.dropped_requests &&
      metrics.dropped_requests.values &&
      metrics.dropped_requests.values.count) ||
    0
  }\n`;

  const totalPayloadsCount =
    (metrics.total_payloads &&
      metrics.total_payloads.values &&
      metrics.total_payloads.values.count) ||
    0;
  const failedPayloadsCount =
    (metrics.failed_payloads &&
      metrics.failed_payloads.values &&
      metrics.failed_payloads.values.count) ||
    0;
  const successfulPayloads = totalPayloadsCount - failedPayloadsCount;

  summary += `  Total Payloads Sent: ${totalPayloadsCount}\n`;
  summary += `  Successful Payloads: ${successfulPayloads}\n`;
  summary += `  Failed Payloads: ${failedPayloadsCount}\n`;
  summary += `  Payload Success Rate: ${
    totalPayloadsCount > 0
      ? ((successfulPayloads / totalPayloadsCount) * 100).toFixed(2)
      : 0
  }%\n\n`;

  // HTTP specific metrics if available
  if (metrics.http_req_duration && metrics.http_req_duration.values) {
    summary += "HTTP REQUEST DURATION:\n";
    const httpValues = metrics.http_req_duration.values;
    summary += `  Average: ${
      httpValues.avg ? httpValues.avg.toFixed(2) : "N/A"
    } ms\n`;
    summary += `  Median: ${
      httpValues.med ? httpValues.med.toFixed(2) : "N/A"
    } ms\n`;
    summary += `  P95: ${
      httpValues["p(95)"] ? httpValues["p(95)"].toFixed(2) : "N/A"
    } ms\n`;
    summary += `  P99: ${
      httpValues["p(99)"] ? httpValues["p(99)"].toFixed(2) : "N/A"
    } ms\n\n`;
  }

  // Connection metrics
  if (metrics.http_req_connecting && metrics.http_req_connecting.values) {
    summary += "CONNECTION METRICS:\n";
    const connValues = metrics.http_req_connecting.values;
    summary += `  Average Connection Time: ${
      connValues.avg ? connValues.avg.toFixed(2) : "N/A"
    } ms\n`;

    if (
      metrics.http_req_tls_handshaking &&
      metrics.http_req_tls_handshaking.values
    ) {
      const tlsValues = metrics.http_req_tls_handshaking.values;
      summary += `  Average TLS Handshake: ${
        tlsValues.avg ? tlsValues.avg.toFixed(2) : "N/A"
      } ms\n`;
    }
    summary += "\n";
  }

  // Data transfer
  if (metrics.data_received && metrics.data_sent) {
    summary += "DATA TRANSFER:\n";
    const dataReceived =
      (metrics.data_received.values && metrics.data_received.values.count) || 0;
    const dataSent =
      (metrics.data_sent.values && metrics.data_sent.values.count) || 0;
    summary += `  Data Sent: ${(dataSent / 1024 / 1024).toFixed(2)} MB\n`;
    summary += `  Data Received: ${(dataReceived / 1024 / 1024).toFixed(
      2
    )} MB\n`;
    summary += `  Average Request Size: ${
      totalRequests > 0 ? (dataSent / totalRequests / 1024).toFixed(2) : 0
    } KB\n`;
    summary += `  Average Response Size: ${
      totalRequests > 0 ? (dataReceived / totalRequests / 1024).toFixed(2) : 0
    } KB\n`;
  }

  return {
    stdout: summary,
    "bulk-load-test-results.json": JSON.stringify(data, null, 2),
  };
}
