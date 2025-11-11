## Benchmarking with k6 and `load-test.js`

This project includes a pre-configured load test script for benchmarking the Rulebricks API using [k6](https://k6.io/), a modern load testing tool.

### Prerequisites

- [Install k6](https://k6.io/) (version 0.42.0+ recommended)
- Access to a deployed Rulebricks API instance (URL and API key)

### The Load Test Script

The primary load test script is [`load-test.js`](./load-test.js). It is meant to simulate a sustained bulk load using k6's `constant-arrival-rate` scenario, reporting on performance and reliability.

#### Configure Your Test

You can set the following environment variables (or edit values in the script):

- `API_URL`: The base API endpoint to target (e.g., `https://<your-domain>/api/v1/flows/<your_flow_slug>`)
- `API_KEY`: The API key for authentication

Optional k6 parameter overrides (can be set in the script):

- `CONSTANT_RPS`: Target number of requests per second (default: 100)
- `BULK_SIZE`: Number of items in a single bulk request (default: 50)
- `TEST_DURATION`: Test time span (e.g. `5m` for 5 minutes; default is 5 minutes)

You can pass custom values as environment variables when invoking k6 (see below).

### Running the Load Test

Ensure you have an accessible Rulebricks instance, and have built & published a test flow.

1. **Set your environment variables (example, bash):**

   ```bash
   export API_URL="https://your-rulebricks.com/api/v1/flows/your_flow_slug"
   export API_KEY="your_api_key"
   ```

   _(Optional: Edit script and override RPS, bulk size, etc.)_

2. **Run the test:**

   ```bash
   k6 run load-test.js
   ```

3. **See Results:**
   At the end of the test, you'll get a summary in the terminal and a `bulk-load-test-results.json` file with all detailed metrics.

### Example Command

```bash
CONSTANT_RPS=200 BULK_SIZE=200 TEST_DURATION=1m \
API_URL="https://my-instance/api/v1/flows/demo" \
API_KEY="xxxxxxxx" \
k6 run load-test.js
```

### Output

- Console output: High-level summary of performance (RPS, error rate, request latencies, throughput, etc)
- `bulk-load-test-results.json`: Detailed metrics for further analysis.

---

For further customization, see the comments within `load-test.js`. To adjust scenario settings, refer to the [`k6` documentation](https://k6.io/docs/using-k6/scenarios/).
