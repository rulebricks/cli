/**
 * Shared payload generation utilities for Rulebricks benchmarking
 *
 * This module provides consistent payload generation across all benchmark tests.
 * The payload structure matches the expected input for the benchmark flow.
 */

import {
  randomIntBetween,
  randomString,
} from "https://jslib.k6.io/k6-utils/1.2.0/index.js";

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
  return {
    req_id: id || `req_${__VU}_${__ITER}_${Date.now()}`,
    alpha:
      Math.random() < 0.5 ? randomIntBetween(0, 9) : randomIntBetween(10, 100),
    beta: Math.random() < 0.5 ? "" : randomString(randomIntBetween(1, 10)),
    charlie: Math.random() < 0.5,
  };
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
