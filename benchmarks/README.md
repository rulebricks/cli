## Rulebricks Benchmarking Toolkit

A simple benchmarking suite for testing your Rulebricks deployment performance.

| Test                | Purpose            | Measures                                  |
| ------------------- | ------------------ | ----------------------------------------- |
| **QPS Test**        | API responsiveness | Requests per second (individual payloads) |
| **Throughput Test** | Engine capacity    | Solutions per second (bulk processing)    |

### Prerequisites

- [k6](https://k6.io/docs/get-started/installation/) load testing tool installed
- A deployed Rulebricks instance
- The benchmark flow imported into your instance
- An API key with access to the benchmark flow

### Quick Start

#### 1. Import the Benchmark Flow

Import the `Test Flow.rbf` file into your Rulebricks instance:

1. Log into your Rulebricks dashboard
2. Navigate to **Flows** → **Import**
3. Upload the test flow file, click into the flow and ensure it is published
4. Note the published flow API URL (e.g., `https://your-instance.com/api/v1/flows/YOUR_FLOW_ID`)

#### 2. Get Your API Key

1. Navigate to the **API** tab on your Rulebricks dashboard
2. Copy the API Key

#### 3. Run the Tests

```bash
# QPS Test
./run-qps-test.sh -u https://your-instance.com/api/v1/flows/YOUR_FLOW_ID -k your-api-key

# Throughput Test
./run-throughput-test.sh -u https://your-instance.com/api/v1/flows/YOUR_FLOW_ID -k your-api-key
```

### Configuration

All configuration is done via environment variables passed to k6:

#### Required Variables

| Variable  | Description                                                                            |
| --------- | -------------------------------------------------------------------------------------- |
| `API_URL` | Full URL to your flow endpoint (e.g., `https://rb.example.com/api/v1/flows/ds_abc123`) |
| `API_KEY` | Your Rulebricks API key                                                                |

#### Optional Variables

| Variable        | Default                          | Description                                      |
| --------------- | -------------------------------- | ------------------------------------------------ |
| `TEST_DURATION` | `4m`                             | Measurement duration (after 1m warm-up)          |
| `TARGET_RPS`    | `500` (QPS) / `100` (Throughput) | Target requests per second                       |
| `BULK_SIZE`     | `50`                             | Payloads per bulk request (throughput test only) |
| `MAX_VUS`       | `min(TARGET_RPS * 3, 500)`       | VU ceiling (throughput test only). Raise when server latency exceeds ~1s at the target rate, otherwise the arrival rate silently VU-starves below `TARGET_RPS` |

Bulk sizes of 500-1000+ exercise the engine's chunked dispatch most
efficiently (HPS splits bulk requests into <=`FLOW_CHUNK_MAX_ITEMS`-payload
Kafka messages, so large bulks amortize per-request gather overhead).
Payload throughput = `TARGET_RPS x BULK_SIZE`; prefer raising `BULK_SIZE`
over `TARGET_RPS` when probing engine capacity, and raise `TARGET_RPS` with
small bulks when probing the API/ingress path.

### Test Structure

Each test consists of two phases:

1. **Warm-up Phase (1 minute)**: Allows the cluster to scale up and stabilize. Results from this phase are excluded from the final metrics.
2. **Measurement Phase (4 minutes by default)**: Steady-state performance measurement. Only this phase contributes to the reported metrics.

Total test time = 1m warm-up + `TEST_DURATION`

### Understanding the Tests

#### QPS Test (`qps-test.js`)

Measures how many **individual requests** your deployment can handle per second. Useful for understanding API gateway performance, connection handling capacity, and latency under load.

Sends single-payload requests at a constant rate and measures response times and success rates.

#### Throughput Test (`throughput-test.js`)

Measures how many **rule evaluations (solutions)** your deployment can process per second. Useful for understanding rule engine processing capacity and bulk API performance.

Sends bulk requests (arrays of payloads) at a constant rate. Each request contains multiple payloads that are processed together.

```
Solutions/second = Successful Requests × Bulk Size / Test Duration
```

---

### Running In-Cluster (co-located load generator)

For benchmarks that remove internet/NAT variance - or to push loads a laptop
can't - run k6 from a pod inside the deployment's own cluster using
`k8s/k6-runner.yaml` (usage instructions in the manifest header). One 2-CPU
runner pod generates ~25k payloads/sec of bulk traffic; run several in
parallel and sum the results to measure beyond that. Point `API_URL` at the
public URL (with the manifest's optional hostAlias pinning it to the traefik
ClusterIP) to exercise the full ingress path, or directly at the
`<release>-hps` service to isolate the engine from the ingress.

Size the runner pod's memory for `MAX_VUS x response size`: at bulk 1000 a
response is ~1 MB, so 500 in-flight VUs need ~3 GiB during high-latency
(scale-up) windows - an undersized pod gets OOM-killed mid-run (exit 137)
exactly when results matter most.

---

### Note on Autoscaling

The 1-minute warm-up phase helps clusters with autoscaling (HPA) scale up before measurement begins. However, if you still see inconsistent results, you may want to:

1. **Set fixed replica counts** temporarily by adjusting `hps.minReplicas` and `hps.maxReplicas` in your Helm values to the same value
2. **Increase test duration** with `-d 10m` for longer measurement after warm-up

Refer to the Helm chart documentation for tuning autoscaling behavior.
