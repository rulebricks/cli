/**
 * Benchmark utilities for running k6 load tests against Rulebricks deployments
 */

import { execa, ExecaError } from "execa";
import { promises as fs } from "fs";
import path from "path";
import os from "os";
import { spawn } from "child_process";
import {
  BenchmarkConfig,
  BenchmarkResult,
  BenchmarkMetrics,
  BLOCKED_BENCHMARK_DOMAINS,
} from "../types/index.js";

// Directory for benchmark scripts and results
const RULEBRICKS_DIR = path.join(os.homedir(), ".rulebricks");
const BENCHMARKS_DIR = path.join(RULEBRICKS_DIR, "benchmarks");

/**
 * Extracts meaningful error message from execa error
 */
function extractExecaError(error: unknown): string {
  const execaError = error as ExecaError;
  const output = execaError.stderr || execaError.stdout || "";
  if (output) {
    const lines = output.split("\n").filter((l: string) => l.trim());
    if (lines.length > 0) return lines[0];
  }
  return execaError.shortMessage || execaError.message || "Unknown error";
}

/**
 * Check if k6 is installed and available
 */
export async function isK6Installed(): Promise<boolean> {
  try {
    await execa("k6", ["version"]);
    return true;
  } catch {
    return false;
  }
}

/**
 * Get k6 version string
 */
export async function getK6Version(): Promise<string | null> {
  try {
    const { stdout } = await execa("k6", ["version"]);
    return stdout.trim();
  } catch {
    return null;
  }
}

/**
 * Get k6 installation instructions based on OS
 */
export function getK6InstallInstructions(): string {
  const platform = process.platform;
  switch (platform) {
    case "darwin":
      return "Install k6 with: brew install k6";
    case "linux":
      return "Install k6: https://k6.io/docs/get-started/installation/#linux";
    case "win32":
      return "Install k6 with: choco install k6 or winget install k6";
    default:
      return "Install k6: https://k6.io/docs/get-started/installation/";
  }
}

/**
 * Validate that a URL is a valid benchmark target (not a cloud URL)
 */
export function isValidBenchmarkTarget(url: string): {
  valid: boolean;
  reason?: string;
} {
  try {
    const parsed = new URL(url);
    const hostname = parsed.hostname.toLowerCase();

    // Check against blocked domains
    for (const blocked of BLOCKED_BENCHMARK_DOMAINS) {
      if (hostname === blocked || hostname.endsWith(`.${blocked}`)) {
        return {
          valid: false,
          reason: `Cannot benchmark against Rulebricks Cloud (${blocked}). Only private deployments managed by this CLI are allowed.`,
        };
      }
    }

    // Must be HTTPS for production deployments
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
      return {
        valid: false,
        reason: "URL must use http:// or https:// protocol",
      };
    }

    return { valid: true };
  } catch {
    return {
      valid: false,
      reason: "Invalid URL format",
    };
  }
}

/**
 * Check if a deployment is healthy by calling the /api/health endpoint
 * Returns true if the deployment responds with {"status":"OK"}
 */
export async function checkDeploymentHealth(
  deploymentUrl: string,
): Promise<boolean> {
  try {
    // Ensure URL has protocol
    const baseUrl = deploymentUrl.startsWith("http")
      ? deploymentUrl
      : `https://${deploymentUrl}`;
    const cleanUrl = baseUrl.replace(/\/$/, "");
    const healthUrl = `${cleanUrl}/api/health`;

    // Use native fetch with a timeout
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 10000); // 10 second timeout

    try {
      const response = await fetch(healthUrl, {
        method: "GET",
        signal: controller.signal,
        headers: {
          Accept: "application/json",
        },
      });

      clearTimeout(timeoutId);

      if (!response.ok) {
        return false;
      }

      const data = (await response.json()) as { status?: string };
      // Check for the expected health response
      return data.status === "OK";
    } catch {
      clearTimeout(timeoutId);
      return false;
    }
  } catch {
    return false;
  }
}

/**
 * Build the full API URL from deployment domain and flow slug
 */
export function buildApiUrl(domain: string, flowSlug: string): string {
  // Ensure domain has protocol
  const baseUrl = domain.startsWith("http") ? domain : `https://${domain}`;
  // Remove trailing slash if present
  const cleanUrl = baseUrl.replace(/\/$/, "");
  // Build the flows API endpoint
  return `${cleanUrl}/api/v1/flows/${flowSlug}`;
}

/**
 * Ensure benchmark scripts directory exists and contains the test scripts
 */
export async function ensureBenchmarkScripts(): Promise<string> {
  await fs.mkdir(BENCHMARKS_DIR, { recursive: true });

  // Check if scripts exist, if not write them
  const qpsScript = path.join(BENCHMARKS_DIR, "qps-test.js");
  const throughputScript = path.join(BENCHMARKS_DIR, "throughput-test.js");
  const libDir = path.join(BENCHMARKS_DIR, "lib");
  const payloadScript = path.join(libDir, "payload.js");
  const reportScript = path.join(libDir, "report.js");

  // Create lib directory
  await fs.mkdir(libDir, { recursive: true });

  // Try to copy from package first (during development or installed package)
  const packageBenchmarksDir = await findPackageBenchmarksDir();

  if (packageBenchmarksDir) {
    // Copy from package
    await copyFile(path.join(packageBenchmarksDir, "qps-test.js"), qpsScript);
    await copyFile(
      path.join(packageBenchmarksDir, "throughput-test.js"),
      throughputScript,
    );
    await copyFile(
      path.join(packageBenchmarksDir, "lib", "payload.js"),
      payloadScript,
    );
    await copyFile(
      path.join(packageBenchmarksDir, "lib", "report.js"),
      reportScript,
    );
  } else {
    // Scripts not found - this shouldn't happen in a properly installed package
    throw new Error(
      "Benchmark scripts not found. Please reinstall the CLI package.",
    );
  }

  return BENCHMARKS_DIR;
}

/**
 * Find the benchmarks directory in the package
 */
async function findPackageBenchmarksDir(): Promise<string | null> {
  // Try relative to the current file (development)
  const possiblePaths = [
    // Development: src/lib/benchmark.ts -> benchmarks/
    path.resolve(import.meta.dirname, "..", "..", "benchmarks"),
    // Installed: dist/lib/benchmark.js -> benchmarks/
    path.resolve(import.meta.dirname, "..", "..", "..", "benchmarks"),
  ];

  for (const p of possiblePaths) {
    try {
      await fs.access(path.join(p, "qps-test.js"));
      return p;
    } catch {
      // Continue to next path
    }
  }

  return null;
}

/**
 * Copy a file, creating destination directory if needed
 */
async function copyFile(src: string, dest: string): Promise<void> {
  try {
    const content = await fs.readFile(src, "utf-8");
    await fs.writeFile(dest, content, "utf-8");
  } catch (error) {
    throw new Error(`Failed to copy ${src} to ${dest}: ${error}`);
  }
}

/**
 * Create the output directory for benchmark results
 */
export async function createOutputDirectory(
  deploymentName: string,
): Promise<string> {
  const timestamp = new Date()
    .toISOString()
    .replace(/[:.]/g, "-")
    .replace("T", "_")
    .slice(0, 19);
  const dirName = `rulebricks-${deploymentName}-${timestamp}`;
  const outputDir = path.join(process.cwd(), dirName);

  await fs.mkdir(outputDir, { recursive: true });
  return outputDir;
}

/**
 * Save benchmark configuration to output directory
 */
export async function saveBenchmarkConfig(
  outputDir: string,
  config: BenchmarkConfig,
): Promise<void> {
  const configPath = path.join(outputDir, "config.json");
  // Redact API key for security
  const safeConfig = {
    ...config,
    apiKey: config.apiKey.slice(0, 8) + "..." + config.apiKey.slice(-4),
  };
  await fs.writeFile(configPath, JSON.stringify(safeConfig, null, 2), "utf-8");
}

/**
 * Run a benchmark test
 */
export async function runBenchmark(
  config: BenchmarkConfig,
  options: {
    onOutput?: (line: string) => void;
    onProgress?: (phase: string, progress: number) => void;
  } = {},
): Promise<BenchmarkResult> {
  // Ensure k6 is installed
  const k6Installed = await isK6Installed();
  if (!k6Installed) {
    return {
      success: false,
      outputDir: "",
      reportPath: "",
      resultsPath: "",
      error: `k6 is not installed. ${getK6InstallInstructions()}`,
    };
  }

  // Validate target URL
  const urlValidation = isValidBenchmarkTarget(config.apiUrl);
  if (!urlValidation.valid) {
    return {
      success: false,
      outputDir: "",
      reportPath: "",
      resultsPath: "",
      error: urlValidation.reason,
    };
  }

  // Ensure benchmark scripts exist
  let scriptsDir: string;
  try {
    scriptsDir = await ensureBenchmarkScripts();
  } catch (error) {
    return {
      success: false,
      outputDir: "",
      reportPath: "",
      resultsPath: "",
      error: `Failed to set up benchmark scripts: ${error}`,
    };
  }

  // Create output directory
  const outputDir = await createOutputDirectory(config.deploymentName);

  // Save config for reference
  await saveBenchmarkConfig(outputDir, config);

  // Determine which test script to run
  const testScript =
    config.testMode === "qps"
      ? path.join(scriptsDir, "qps-test.js")
      : path.join(scriptsDir, "throughput-test.js");

  const reportName =
    config.testMode === "qps" ? "qps-report.html" : "throughput-report.html";
  const resultsName =
    config.testMode === "qps" ? "qps-results.json" : "throughput-results.json";

  // Build environment variables for k6
  const env: Record<string, string> = {
    ...process.env,
    API_URL: config.apiUrl,
    API_KEY: config.apiKey,
    TEST_DURATION: config.testDuration,
    TARGET_RPS: config.targetRps.toString(),
  };

  if (config.testMode === "throughput" && config.bulkSize) {
    env.BULK_SIZE = config.bulkSize.toString();
  }

  // Run k6
  try {
    const k6Process = spawn("k6", ["run", testScript], {
      cwd: outputDir,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";

    k6Process.stdout?.on("data", (data) => {
      const text = data.toString();
      stdout += text;
      if (options.onOutput) {
        text.split("\n").forEach((line: string) => {
          if (line.trim()) options.onOutput!(line);
        });
      }
    });

    k6Process.stderr?.on("data", (data) => {
      const text = data.toString();
      stderr += text;
      if (options.onOutput) {
        text.split("\n").forEach((line: string) => {
          if (line.trim()) options.onOutput!(line);
        });
      }
    });

    // Wait for process to complete
    const exitCode = await new Promise<number>((resolve) => {
      k6Process.on("close", (code) => {
        resolve(code ?? 1);
      });
    });

    const reportPath = path.join(outputDir, reportName);
    const resultsPath = path.join(outputDir, resultsName);

    // Check if report was generated
    let reportExists = false;
    try {
      await fs.access(reportPath);
      reportExists = true;
    } catch {
      reportExists = false;
    }

    // Parse metrics from results JSON if available
    let metrics: BenchmarkMetrics | undefined;
    try {
      const resultsContent = await fs.readFile(resultsPath, "utf-8");
      metrics = parseK6Results(resultsContent, config);
    } catch {
      // Results file might not exist or be parseable
    }

    // k6 returns non-zero if thresholds fail, but we still consider it a success
    // if the report was generated
    if (reportExists) {
      return {
        success: true,
        outputDir,
        reportPath,
        resultsPath,
        metrics,
      };
    } else {
      return {
        success: false,
        outputDir,
        reportPath,
        resultsPath,
        error:
          `k6 test failed (exit code ${exitCode}). ${stderr || stdout}`.trim(),
      };
    }
  } catch (error) {
    return {
      success: false,
      outputDir,
      reportPath: path.join(outputDir, reportName),
      resultsPath: path.join(outputDir, resultsName),
      error: extractExecaError(error),
    };
  }
}

/**
 * Parse k6 JSON results into BenchmarkMetrics
 */
function parseK6Results(
  jsonContent: string,
  config: BenchmarkConfig,
): BenchmarkMetrics {
  const data = JSON.parse(jsonContent);
  const metrics = data.metrics || {};

  const totalRequests = metrics.http_reqs?.values?.count || 0;
  const testDuration = (data.state?.testRunDurationMs || 0) / 1000;
  const actualRps = testDuration > 0 ? totalRequests / testDuration : 0;

  const result: BenchmarkMetrics = {
    actualRps,
    successRate: (metrics.successes?.values?.rate || 0) * 100,
    p50Latency: metrics.http_req_duration?.values?.med || 0,
    p90Latency: metrics.http_req_duration?.values?.["p(90)"] || 0,
    p95Latency: metrics.http_req_duration?.values?.["p(95)"] || 0,
    p99Latency: metrics.http_req_duration?.values?.["p(99)"] || 0,
    minLatency: metrics.http_req_duration?.values?.min || 0,
    maxLatency: metrics.http_req_duration?.values?.max || 0,
    avgLatency: metrics.http_req_duration?.values?.avg || 0,
    totalRequests,
    failedRequests: metrics.dropped_requests?.values?.count || 0,
    testDuration,
    dataSent: metrics.data_sent?.values?.count || 0,
    dataReceived: metrics.data_received?.values?.count || 0,
    maxVUs: metrics.vus_max?.values?.max || metrics.vus?.values?.max || 0,
  };

  // Add throughput-specific metrics
  if (config.testMode === "throughput" && config.bulkSize) {
    result.actualThroughput = actualRps * config.bulkSize;
    result.totalPayloads =
      metrics.total_payloads?.values?.count || totalRequests * config.bulkSize;
  }

  return result;
}

/**
 * Open a file in the default browser/application
 */
export async function openInBrowser(filePath: string): Promise<void> {
  const platform = process.platform;

  try {
    switch (platform) {
      case "darwin":
        await execa("open", [filePath]);
        break;
      case "win32":
        await execa("cmd", ["/c", "start", '""', filePath]);
        break;
      case "linux":
      default:
        await execa("xdg-open", [filePath]);
        break;
    }
  } catch {
    // Silently fail if browser can't be opened
  }
}

/**
 * Format duration string (e.g., "4m") to human readable
 */
export function formatDuration(duration: string): string {
  const match = duration.match(/^(\d+)(m|s|h)$/);
  if (!match) return duration;

  const [, value, unit] = match;
  const num = parseInt(value, 10);

  switch (unit) {
    case "s":
      return `${num} second${num !== 1 ? "s" : ""}`;
    case "m":
      return `${num} minute${num !== 1 ? "s" : ""}`;
    case "h":
      return `${num} hour${num !== 1 ? "s" : ""}`;
    default:
      return duration;
  }
}

/**
 * Calculate expected throughput for display
 */
export function calculateExpectedThroughput(
  targetRps: number,
  bulkSize?: number,
): number {
  return bulkSize ? targetRps * bulkSize : targetRps;
}
