/**
 * HTML Report Generation for Rulebricks Benchmarking
 *
 * Generates standalone HTML reports with Chart.js visualizations
 */

/**
 * Format a number with appropriate precision
 */
function formatNumber(num, decimals = 2) {
  if (num === null || num === undefined || isNaN(num)) return "N/A";
  return num.toFixed(decimals);
}

/**
 * Format bytes to human readable string
 */
function formatBytes(bytes) {
  if (bytes === 0) return "0 B";
  const k = 1024;
  const sizes = ["B", "KB", "MB", "GB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return formatNumber(bytes / Math.pow(k, i), 2) + " " + sizes[i];
}

/**
 * Format duration in milliseconds to human readable string
 */
function formatDuration(ms) {
  if (ms < 1000) return formatNumber(ms, 2) + " ms";
  if (ms < 60000) return formatNumber(ms / 1000, 2) + " s";
  return formatNumber(ms / 60000, 2) + " min";
}

/**
 * Get status color based on value and thresholds (using neon/pastel palette)
 */
function getStatusColor(
  value,
  goodThreshold,
  warningThreshold,
  inverse = false
) {
  if (inverse) {
    if (value <= goodThreshold) return "#4ade80"; // neon green
    if (value <= warningThreshold) return "#fbbf24"; // neon yellow
    return "#f87171"; // neon red/coral
  } else {
    if (value >= goodThreshold) return "#4ade80"; // neon green
    if (value >= warningThreshold) return "#fbbf24"; // neon yellow
    return "#f87171"; // neon red/coral
  }
}

/**
 * Generate HTML report for QPS test
 */
export function generateQpsReport(data, config) {
  const metrics = data.metrics || {};

  // Extract key metrics
  const totalRequests = metrics.http_reqs?.values?.count || 0;
  const testDuration = (data.state?.testRunDurationMs || 0) / 1000;
  const actualRps = testDuration > 0 ? totalRequests / testDuration : 0;
  const rpsEfficiency =
    config.targetRps > 0 ? (actualRps / config.targetRps) * 100 : 0;

  const successRate = (metrics.successes?.values?.rate || 0) * 100;
  const errorRate = (metrics.errors?.values?.rate || 0) * 100;
  const failedRequests =
    metrics.dropped_requests?.values?.count ||
    Math.round(totalRequests * (errorRate / 100));

  const p50 = metrics.http_req_duration?.values?.med || 0;
  const p90 = metrics.http_req_duration?.values?.["p(90)"] || 0;
  const p95 = metrics.http_req_duration?.values?.["p(95)"] || 0;
  const p99 = metrics.http_req_duration?.values?.["p(99)"] || 0;
  const avgLatency = metrics.http_req_duration?.values?.avg || 0;
  const minLatency = metrics.http_req_duration?.values?.min || 0;
  const maxLatency = metrics.http_req_duration?.values?.max || 0;

  // Connection metrics
  const avgConnecting = metrics.http_req_connecting?.values?.avg || 0;
  const avgTlsHandshake = metrics.http_req_tls_handshaking?.values?.avg || 0;
  const avgWaiting = metrics.http_req_waiting?.values?.avg || 0;
  const avgReceiving = metrics.http_req_receiving?.values?.avg || 0;
  const avgSending = metrics.http_req_sending?.values?.avg || 0;

  const dataReceived = metrics.data_received?.values?.count || 0;
  const dataSent = metrics.data_sent?.values?.count || 0;
  const avgRequestSize = totalRequests > 0 ? dataSent / totalRequests : 0;
  const avgResponseSize = totalRequests > 0 ? dataReceived / totalRequests : 0;

  // VU metrics
  const maxVUs = metrics.vus_max?.values?.max || metrics.vus?.values?.max || 0;

  const successColor = getStatusColor(successRate, 99, 95);
  const p95Color = getStatusColor(p95, 200, 500, true);

  return generateHtmlTemplate({
    title: "QPS Benchmark Report",
    testType: "QPS (Requests/Second)",
    description: "Measures API responsiveness with individual payload requests",
    config,
    metrics: {
      totalRequests,
      testDuration,
      actualRps,
      rpsEfficiency,
      successRate,
      errorRate,
      failedRequests,
      p50,
      p90,
      p95,
      p99,
      avgLatency,
      minLatency,
      maxLatency,
      avgConnecting,
      avgTlsHandshake,
      avgWaiting,
      avgReceiving,
      avgSending,
      dataReceived,
      dataSent,
      avgRequestSize,
      avgResponseSize,
      maxVUs,
    },
    successColor,
    p95Color,
    showBulkMetrics: false,
  });
}

/**
 * Generate HTML report for Throughput test
 */
export function generateThroughputReport(data, config) {
  const metrics = data.metrics || {};

  // Extract key metrics
  const totalRequests = metrics.http_reqs?.values?.count || 0;
  const testDuration = (data.state?.testRunDurationMs || 0) / 1000;
  const actualRps = testDuration > 0 ? totalRequests / testDuration : 0;
  const actualThroughput = actualRps * config.bulkSize;
  const rpsEfficiency =
    config.targetRps > 0 ? (actualRps / config.targetRps) * 100 : 0;

  const successRate = (metrics.successes?.values?.rate || 0) * 100;
  const errorRate = (metrics.errors?.values?.rate || 0) * 100;
  const failedRequests =
    metrics.dropped_requests?.values?.count ||
    Math.round(totalRequests * (errorRate / 100));

  const totalPayloads =
    metrics.total_payloads?.values?.count || totalRequests * config.bulkSize;
  const failedPayloads = metrics.failed_payloads?.values?.count || 0;
  const successfulPayloads = totalPayloads - failedPayloads;

  const p50 = metrics.http_req_duration?.values?.med || 0;
  const p90 = metrics.http_req_duration?.values?.["p(90)"] || 0;
  const p95 = metrics.http_req_duration?.values?.["p(95)"] || 0;
  const p99 = metrics.http_req_duration?.values?.["p(99)"] || 0;
  const avgLatency = metrics.http_req_duration?.values?.avg || 0;
  const minLatency = metrics.http_req_duration?.values?.min || 0;
  const maxLatency = metrics.http_req_duration?.values?.max || 0;

  // Connection metrics
  const avgConnecting = metrics.http_req_connecting?.values?.avg || 0;
  const avgTlsHandshake = metrics.http_req_tls_handshaking?.values?.avg || 0;
  const avgWaiting = metrics.http_req_waiting?.values?.avg || 0;
  const avgReceiving = metrics.http_req_receiving?.values?.avg || 0;
  const avgSending = metrics.http_req_sending?.values?.avg || 0;

  const dataReceived = metrics.data_received?.values?.count || 0;
  const dataSent = metrics.data_sent?.values?.count || 0;
  const avgRequestSize = totalRequests > 0 ? dataSent / totalRequests : 0;
  const avgResponseSize = totalRequests > 0 ? dataReceived / totalRequests : 0;

  // VU metrics
  const maxVUs = metrics.vus_max?.values?.max || metrics.vus?.values?.max || 0;

  const successColor = getStatusColor(successRate, 99, 95);
  const p95Color = getStatusColor(p95, 500, 1000, true);

  return generateHtmlTemplate({
    title: "Throughput Benchmark Report",
    testType: "Throughput (Solutions/Second)",
    description: "Measures rule engine capacity with bulk payload requests",
    config,
    metrics: {
      totalRequests,
      testDuration,
      actualRps,
      actualThroughput,
      rpsEfficiency,
      successRate,
      errorRate,
      failedRequests,
      totalPayloads,
      successfulPayloads,
      failedPayloads,
      p50,
      p90,
      p95,
      p99,
      avgLatency,
      minLatency,
      maxLatency,
      avgConnecting,
      avgTlsHandshake,
      avgWaiting,
      avgReceiving,
      avgSending,
      dataReceived,
      dataSent,
      avgRequestSize,
      avgResponseSize,
      maxVUs,
    },
    successColor,
    p95Color,
    showBulkMetrics: true,
  });
}

/**
 * Generate the HTML template
 */
function generateHtmlTemplate({
  title,
  testType,
  description,
  config,
  metrics,
  successColor,
  p95Color,
  showBulkMetrics,
}) {
  const timestamp = new Date().toISOString();
  const formattedDate = new Date().toLocaleString();

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${title} - Rulebricks</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Archivo:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500&display=swap" rel="stylesheet">
  <script src="https://cdn.jsdelivr.net/npm/chart.js"></script>
  <style>
    :root {
      --bg-primary: #0a0a0a;
      --bg-secondary: #141414;
      --bg-tertiary: #1f1f1f;
      --bg-hover: #2a2a2a;
      --text-primary: #fafafa;
      --text-secondary: #a1a1a1;
      --text-muted: #6b6b6b;
      --border: #2a2a2a;
      --border-light: #333;
      --accent: #a78bfa;
      --accent-cyan: #22d3ee;
      --accent-green: #4ade80;
      --accent-yellow: #fbbf24;
      --accent-red: #f87171;
      --accent-pink: #f472b6;
    }
    
    * {
      margin: 0;
      padding: 0;
      box-sizing: border-box;
    }
    
    body {
      font-family: 'Archivo', -apple-system, BlinkMacSystemFont, sans-serif;
      background: var(--bg-primary);
      color: var(--text-primary);
      line-height: 1.6;
      min-height: 100vh;
    }
    
    .container {
      max-width: 1280px;
      margin: 0 auto;
      padding: 2.5rem;
    }
    
    header {
      margin-bottom: 2.5rem;
      padding-bottom: 2rem;
      border-bottom: 1px solid var(--border);
    }
    
    .header-top {
      display: flex;
      align-items: center;
      justify-content: space-between;
      margin-bottom: 1.5rem;
    }
    
    .logo {
      font-size: 0.75rem;
      font-weight: 600;
      letter-spacing: 0.15em;
      text-transform: uppercase;
      color: var(--text-muted);
    }
    
    .timestamp {
      font-size: 0.8rem;
      color: var(--text-muted);
      font-family: 'JetBrains Mono', monospace;
    }
    
    h1 {
      font-size: 2rem;
      font-weight: 700;
      margin-bottom: 0.5rem;
      letter-spacing: -0.02em;
    }
    
    .subtitle {
      color: var(--text-secondary);
      font-size: 1rem;
    }
    
    .grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(240px, 1fr));
      gap: 1rem;
      margin-bottom: 1.5rem;
    }
    
    .grid-6 {
      grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
    }
    
    .card {
      background: var(--bg-secondary);
      border-radius: 4px;
      padding: 1.25rem;
      border: 1px solid var(--border);
      transition: border-color 0.15s ease;
    }
    
    .card:hover {
      border-color: var(--border-light);
    }
    
    .card-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      margin-bottom: 0.75rem;
    }
    
    .card-title {
      font-size: 0.7rem;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.08em;
      color: var(--text-muted);
    }
    
    .card-value {
      font-size: 2rem;
      font-weight: 700;
      line-height: 1.1;
      letter-spacing: -0.02em;
    }
    
    .card-value-sm {
      font-size: 1.5rem;
    }
    
    .card-subtitle {
      color: var(--text-muted);
      font-size: 0.8rem;
      margin-top: 0.5rem;
    }
    
    .status-indicator {
      width: 8px;
      height: 8px;
      border-radius: 2px;
      display: inline-block;
    }
    
    .section {
      margin-bottom: 1.5rem;
    }
    
    .section-title {
      font-size: 0.7rem;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.1em;
      color: var(--text-muted);
      margin-bottom: 1rem;
      padding-bottom: 0.5rem;
      border-bottom: 1px solid var(--border);
    }
    
    .chart-container {
      background: var(--bg-secondary);
      border-radius: 4px;
      padding: 1.5rem;
      border: 1px solid var(--border);
      margin-bottom: 1.5rem;
    }
    
    .chart-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      margin-bottom: 1rem;
    }
    
    .chart-title {
      font-size: 0.9rem;
      font-weight: 600;
    }
    
    .chart-wrapper {
      position: relative;
      height: 280px;
    }
    
    .two-col {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 1.5rem;
    }
    
    @media (max-width: 768px) {
      .two-col {
        grid-template-columns: 1fr;
      }
    }
    
    .metrics-table {
      width: 100%;
      border-collapse: collapse;
      font-size: 0.85rem;
    }
    
    .metrics-table th,
    .metrics-table td {
      padding: 0.75rem 1rem;
      text-align: left;
      border-bottom: 1px solid var(--border);
    }
    
    .metrics-table th {
      color: var(--text-muted);
      font-weight: 500;
      font-size: 0.7rem;
      text-transform: uppercase;
      letter-spacing: 0.08em;
    }
    
    .metrics-table td {
      font-family: 'JetBrains Mono', monospace;
      font-size: 0.8rem;
    }
    
    .metrics-table tr:last-child td {
      border-bottom: none;
    }
    
    .config-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
      gap: 0.75rem;
    }
    
    .config-item {
      display: flex;
      flex-direction: column;
      gap: 0.25rem;
      padding: 0.75rem;
      background: var(--bg-tertiary);
      border-radius: 3px;
    }
    
    .config-key {
      font-size: 0.7rem;
      font-weight: 500;
      text-transform: uppercase;
      letter-spacing: 0.08em;
      color: var(--text-muted);
    }
    
    .config-value {
      font-family: 'JetBrains Mono', monospace;
      font-size: 0.8rem;
      color: var(--accent-cyan);
      word-break: break-all;
    }
    
    footer {
      text-align: center;
      padding-top: 2rem;
      margin-top: 1rem;
      border-top: 1px solid var(--border);
      color: var(--text-muted);
      font-size: 0.75rem;
    }
    
    .tag {
      display: inline-block;
      padding: 0.2rem 0.5rem;
      border-radius: 2px;
      font-size: 0.65rem;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.05em;
    }
    
    .tag-success { background: rgba(74, 222, 128, 0.15); color: var(--accent-green); }
    .tag-warning { background: rgba(251, 191, 36, 0.15); color: var(--accent-yellow); }
    .tag-error { background: rgba(248, 113, 113, 0.15); color: var(--accent-red); }
    
    .highlight { color: var(--accent-cyan); }
    .highlight-pink { color: var(--accent-pink); }
    .highlight-purple { color: var(--accent); }
  </style>
</head>
<body>
  <div class="container">
    <header>
      <div class="header-top">
        <div class="logo">Rulebricks Benchmark</div>
        <div class="timestamp">${formattedDate}</div>
      </div>
      <h1>${title}</h1>
      <p class="subtitle">${testType} · ${description}</p>
    </header>
    
    <div class="section">
      <div class="section-title">Performance Overview</div>
      <div class="grid">
        <div class="card">
          <div class="card-header">
            <span class="card-title">Total Requests</span>
          </div>
          <div class="card-value">${metrics.totalRequests.toLocaleString()}</div>
          <div class="card-subtitle">Over ${formatDuration(
            metrics.testDuration * 1000
          )}</div>
        </div>
        
        <div class="card">
          <div class="card-header">
            <span class="card-title">Success Rate</span>
            <span class="status-indicator" style="background: ${successColor}"></span>
          </div>
          <div class="card-value" style="color: ${successColor}">${formatNumber(
    metrics.successRate,
    1
  )}%</div>
          <div class="card-subtitle">${metrics.failedRequests.toLocaleString()} failed</div>
        </div>
        
        <div class="card">
          <div class="card-header">
            <span class="card-title">Actual RPS</span>
          </div>
          <div class="card-value"><span class="highlight">${formatNumber(
            metrics.actualRps,
            1
          )}</span></div>
          <div class="card-subtitle">${formatNumber(
            metrics.rpsEfficiency,
            0
          )}% of target (${config.targetRps})</div>
        </div>
        
        <div class="card">
          <div class="card-header">
            <span class="card-title">P95 Latency</span>
            <span class="status-indicator" style="background: ${p95Color}"></span>
          </div>
          <div class="card-value" style="color: ${p95Color}">${formatNumber(
    metrics.p95,
    0
  )}<span style="font-size: 1rem; opacity: 0.7">ms</span></div>
          <div class="card-subtitle">P99: ${formatNumber(
            metrics.p99,
            0
          )}ms</div>
        </div>
        
        ${
          showBulkMetrics
            ? `
        <div class="card">
          <div class="card-header">
            <span class="card-title">Throughput</span>
          </div>
          <div class="card-value"><span class="highlight-pink">${formatNumber(
            metrics.actualThroughput,
            0
          )}</span></div>
          <div class="card-subtitle">Solutions/sec (${
            config.bulkSize
          }/req)</div>
        </div>
        
        <div class="card">
          <div class="card-header">
            <span class="card-title">Total Payloads</span>
          </div>
          <div class="card-value">${metrics.totalPayloads.toLocaleString()}</div>
          <div class="card-subtitle">${metrics.successfulPayloads.toLocaleString()} processed</div>
        </div>
        `
            : `
        <div class="card">
          <div class="card-header">
            <span class="card-title">Peak VUs</span>
          </div>
          <div class="card-value">${metrics.maxVUs}</div>
          <div class="card-subtitle">Virtual users</div>
        </div>
        `
        }
      </div>
    </div>
    
    <div class="two-col">
      <div class="chart-container">
        <div class="chart-header">
          <h3 class="chart-title">Response Time Distribution</h3>
        </div>
        <div class="chart-wrapper">
          <canvas id="latencyChart"></canvas>
        </div>
      </div>
      
      <div class="chart-container">
        <div class="chart-header">
          <h3 class="chart-title">Request Timing Breakdown</h3>
        </div>
        <div class="chart-wrapper">
          <canvas id="timingChart"></canvas>
        </div>
      </div>
    </div>
    
    <div class="section">
      <div class="section-title">Detailed Metrics</div>
      <div class="two-col">
        <div class="card">
          <table class="metrics-table">
            <thead>
              <tr>
                <th>Latency Metric</th>
                <th>Value</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td>Minimum</td>
                <td>${formatNumber(metrics.minLatency, 2)} ms</td>
              </tr>
              <tr>
                <td>Average</td>
                <td>${formatNumber(metrics.avgLatency, 2)} ms</td>
              </tr>
              <tr>
                <td>Median (P50)</td>
                <td>${formatNumber(metrics.p50, 2)} ms</td>
              </tr>
              <tr>
                <td>P90</td>
                <td>${formatNumber(metrics.p90, 2)} ms</td>
              </tr>
              <tr>
                <td>P95</td>
                <td>${formatNumber(metrics.p95, 2)} ms</td>
              </tr>
              <tr>
                <td>P99</td>
                <td>${formatNumber(metrics.p99, 2)} ms</td>
              </tr>
              <tr>
                <td>Maximum</td>
                <td>${formatNumber(metrics.maxLatency, 2)} ms</td>
              </tr>
            </tbody>
          </table>
        </div>
        
        <div class="card">
          <table class="metrics-table">
            <thead>
              <tr>
                <th>Transfer Metric</th>
                <th>Value</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td>Data Sent</td>
                <td>${formatBytes(metrics.dataSent)}</td>
              </tr>
              <tr>
                <td>Data Received</td>
                <td>${formatBytes(metrics.dataReceived)}</td>
              </tr>
              <tr>
                <td>Avg Request Size</td>
                <td>${formatBytes(metrics.avgRequestSize)}</td>
              </tr>
              <tr>
                <td>Avg Response Size</td>
                <td>${formatBytes(metrics.avgResponseSize)}</td>
              </tr>
              <tr>
                <td>Avg Connecting</td>
                <td>${formatNumber(metrics.avgConnecting, 2)} ms</td>
              </tr>
              <tr>
                <td>Avg TLS Handshake</td>
                <td>${formatNumber(metrics.avgTlsHandshake, 2)} ms</td>
              </tr>
              <tr>
                <td>Avg Waiting (TTFB)</td>
                <td>${formatNumber(metrics.avgWaiting, 2)} ms</td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>
    </div>
    
    <div class="section">
      <div class="section-title">Test Configuration</div>
      <div class="config-grid">
        <div class="config-item">
          <span class="config-key">API URL</span>
          <span class="config-value">${config.apiUrl}</span>
        </div>
        <div class="config-item">
          <span class="config-key">Test Duration</span>
          <span class="config-value">${config.testDuration}</span>
        </div>
        <div class="config-item">
          <span class="config-key">Target RPS</span>
          <span class="config-value">${config.targetRps}</span>
        </div>
        ${
          showBulkMetrics
            ? `
        <div class="config-item">
          <span class="config-key">Bulk Size</span>
          <span class="config-value">${config.bulkSize} payloads</span>
        </div>
        `
            : ""
        }
        <div class="config-item">
          <span class="config-key">Peak Virtual Users</span>
          <span class="config-value">${metrics.maxVUs}</span>
        </div>
      </div>
    </div>
    
    <footer>
      <p>Generated by Rulebricks Benchmarking Toolkit</p>
    </footer>
  </div>
  
  <script>
    Chart.defaults.font.family = "'Archivo', sans-serif";
    Chart.defaults.color = '#a1a1a1';
    
    // Latency Distribution Chart
    const latencyCtx = document.getElementById('latencyChart').getContext('2d');
    new Chart(latencyCtx, {
      type: 'bar',
      data: {
        labels: ['Min', 'P50', 'P90', 'P95', 'P99', 'Max'],
        datasets: [{
          label: 'Response Time (ms)',
          data: [
            ${formatNumber(metrics.minLatency, 2)},
            ${formatNumber(metrics.p50, 2)},
            ${formatNumber(metrics.p90, 2)},
            ${formatNumber(metrics.p95, 2)},
            ${formatNumber(metrics.p99, 2)},
            ${formatNumber(metrics.maxLatency, 2)}
          ],
          backgroundColor: [
            'rgba(74, 222, 128, 0.7)',
            'rgba(74, 222, 128, 0.7)',
            'rgba(251, 191, 36, 0.7)',
            'rgba(251, 191, 36, 0.7)',
            'rgba(248, 113, 113, 0.7)',
            'rgba(248, 113, 113, 0.7)'
          ],
          borderColor: [
            'rgb(74, 222, 128)',
            'rgb(74, 222, 128)',
            'rgb(251, 191, 36)',
            'rgb(251, 191, 36)',
            'rgb(248, 113, 113)',
            'rgb(248, 113, 113)'
          ],
          borderWidth: 1,
          borderRadius: 2,
        }]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: { display: false },
          tooltip: {
            backgroundColor: '#1f1f1f',
            titleColor: '#fafafa',
            bodyColor: '#a1a1a1',
            borderColor: '#2a2a2a',
            borderWidth: 1,
            padding: 10,
            cornerRadius: 3,
            displayColors: false,
            callbacks: {
              label: function(context) {
                return context.parsed.y.toFixed(2) + ' ms';
              }
            }
          }
        },
        scales: {
          y: {
            beginAtZero: true,
            grid: { color: '#2a2a2a', drawBorder: false },
            ticks: {
              callback: function(value) { return value + ' ms'; }
            }
          },
          x: {
            grid: { display: false }
          }
        }
      }
    });
    
    // Timing Breakdown Chart
    const timingCtx = document.getElementById('timingChart').getContext('2d');
    new Chart(timingCtx, {
      type: 'doughnut',
      data: {
        labels: ['Connecting', 'TLS Handshake', 'Sending', 'Waiting (TTFB)', 'Receiving'],
        datasets: [{
          data: [
            ${formatNumber(metrics.avgConnecting, 2)},
            ${formatNumber(metrics.avgTlsHandshake, 2)},
            ${formatNumber(metrics.avgSending, 2)},
            ${formatNumber(metrics.avgWaiting, 2)},
            ${formatNumber(metrics.avgReceiving, 2)}
          ],
          backgroundColor: [
            'rgba(167, 139, 250, 0.8)',
            'rgba(34, 211, 238, 0.8)',
            'rgba(244, 114, 182, 0.8)',
            'rgba(74, 222, 128, 0.8)',
            'rgba(251, 191, 36, 0.8)'
          ],
          borderColor: '#0a0a0a',
          borderWidth: 2,
        }]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        cutout: '60%',
        plugins: {
          legend: {
            position: 'right',
            labels: {
              padding: 15,
              usePointStyle: true,
              pointStyle: 'rect'
            }
          },
          tooltip: {
            backgroundColor: '#1f1f1f',
            titleColor: '#fafafa',
            bodyColor: '#a1a1a1',
            borderColor: '#2a2a2a',
            borderWidth: 1,
            padding: 10,
            cornerRadius: 3,
            callbacks: {
              label: function(context) {
                return context.label + ': ' + context.parsed.toFixed(2) + ' ms';
              }
            }
          }
        }
      }
    });
  </script>
</body>
</html>`;
}

/**
 * Generate console summary for QPS test
 */
export function generateQpsConsoleSummary(data, config) {
  return "\nResults saved to qps-report.html\n";
}

/**
 * Generate console summary for Throughput test
 */
export function generateThroughputConsoleSummary(data, config) {
  return "\nResults saved to throughput-report.html\n";
}
