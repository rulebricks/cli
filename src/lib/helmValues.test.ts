import test from "node:test";
import assert from "node:assert/strict";
import { buildHelmValues } from "./helmValues.js";
import {
  validateHelmValues,
  validateValuesInvariants,
} from "./validateValues.js";
import { buildConfigMatrix } from "./configFixtures.js";
import {
  DeploymentConfig,
  DeploymentConfigSchema,
  RemoteWriteConfig,
  validateRemoteWriteConfig,
} from "../types/index.js";

const matrix = buildConfigMatrix();

type Toleration = Record<string, string>;

const BURST_POOL_TOLERATION: Toleration = {
  key: "rulebricks.com/pool",
  operator: "Equal",
  value: "burst",
  effect: "NoSchedule",
};

function cloneFixture(name: string): DeploymentConfig {
  const entry = matrix.find((c) => c.name === name);
  assert.ok(entry, `missing matrix fixture ${name}`);
  return JSON.parse(JSON.stringify(entry.config)) as DeploymentConfig;
}

function assertNoBareExistsToleration(
  label: string,
  tolerations: Toleration[],
): void {
  assert.ok(
    tolerations.every((tol) => !(tol.operator === "Exists" && !tol.key)),
    `${label}: must not contain a bare operator: Exists toleration`,
  );
}

function assertIncludesToleration(
  label: string,
  tolerations: Toleration[],
  expected: Toleration,
): void {
  assert.ok(
    tolerations.some((tol) =>
      Object.entries(expected).every(([key, value]) => tol[key] === value),
    ),
    `${label}: expected toleration ${JSON.stringify(expected)}, got ${JSON.stringify(tolerations)}`,
  );
}

test("config matrix parses against the deployment schema", () => {
  for (const { name, config } of matrix) {
    const result = DeploymentConfigSchema.safeParse(config);
    assert.ok(
      result.success,
      `${name}: expected a valid DeploymentConfig but got ${
        result.success ? "" : JSON.stringify(result.error.issues, null, 2)
      }`,
    );
  }
});

test("generated Helm values are valid against the chart schema for every config", () => {
  for (const { name, config } of matrix) {
    const values = buildHelmValues(config);
    const result = validateHelmValues(values);
    assert.ok(
      result.valid,
      `${name}: generated values failed schema validation:\n${result.errors
        .map((e) => `  - ${e}`)
        .join("\n")}`,
    );
  }
});

test("generated values are valid both with and without TLS", () => {
  for (const { name, config } of matrix) {
    for (const tlsEnabled of [true, false]) {
      const values = buildHelmValues(config, { tlsEnabled });
      const result = validateHelmValues(values);
      assert.ok(
        result.valid,
        `${name} (tls=${tlsEnabled}): ${result.errors.join("; ")}`,
      );
    }
  }
});

interface KafkaTopicValues {
  name: string;
  partitions: number;
  replicationFactor: number;
  config: Record<string, string>;
}

interface GeneratedKafkaValues {
  rulebricks: {
    hps: {
      workers: {
        solutionPartitions?: number;
        // Sizing (resources, keda min/max) is no longer emitted by the CLI; it
        // falls back to the chart defaults, so these are optional here.
        resources?: {
          requests: { cpu: string };
          limits: { cpu: string };
        };
        keda: { maxReplicaCount?: number; lagThreshold: number };
      };
    };
    app: { logging: { kafkaTopicPrefix?: string } };
  };
  kafka: {
    enabled: boolean;
    overrideConfiguration: Record<string, string>;
    provisioning: {
      enabled: boolean;
      topics?: KafkaTopicValues[];
    };
  };
}

function tierFixture(name: string): GeneratedKafkaValues {
  const entry = matrix.find((c) => c.name === name);
  assert.ok(entry, `missing matrix fixture ${name}`);
  return buildHelmValues(entry!.config) as unknown as GeneratedKafkaValues;
}

test("in-cluster provisioning uses baseline partitions and the (empty) prefix", () => {
  // Tiers were removed: partition sizing is now a fixed baseline that mirrors
  // the chart defaults, identical across every in-cluster deployment.
  for (const fixtureName of [
    "aws-self-hosted-minimal",
    "gcp-self-hosted",
    "azure-workload-identity",
  ] as const) {
    const values = tierFixture(fixtureName);

    // In-cluster installs run UNPREFIXED; provisioning names must match.
    assert.equal(values.rulebricks.app.logging.kafkaTopicPrefix, "");
    assert.equal(values.kafka.provisioning.enabled, true);

    const topics = values.kafka.provisioning.topics!;
    const byName = Object.fromEntries(topics.map((t) => [t.name, t]));
    assert.deepEqual(
      Object.keys(byName).sort(),
      ["logs", "solution", "solution-response"],
      `${fixtureName}: topic names must be unprefixed`,
    );

    // Baseline partitions: the structural contract between provisioning,
    // workers.solutionPartitions, and the chart defaults.
    assert.equal(byName["solution"].partitions, 128);
    assert.equal(byName["solution-response"].partitions, 128);
    assert.equal(byName["logs"].partitions, 24);

    // Single in-cluster broker: every topic stays RF 1.
    assert.equal(byName["solution"].replicationFactor, 1);
    assert.equal(byName["logs"].replicationFactor, 1);

    // MAX_WORKERS source must match the solution topic exactly.
    assert.equal(values.rulebricks.hps.workers.solutionPartitions, 128);

    // Sizing (worker replicas/resources, keda min/max) is no longer emitted;
    // it falls back to the chart defaults.
    assert.equal(values.rulebricks.hps.workers.resources, undefined);
    assert.equal(values.rulebricks.hps.workers.keda.maxReplicaCount, undefined);

    // Non-tier scale-out tuning is still emitted (aggressive early scale-out).
    assert.equal(values.rulebricks.hps.workers.keda.lagThreshold, 50);

    // num.partitions is decoupled from worker count (auto-create default only).
    assert.equal(
      values.kafka.overrideConfiguration["num.partitions"],
      "12",
      `${fixtureName}: num.partitions must no longer track max workers`,
    );
  }
});

test("external Kafka disables provisioning (topics are customer-managed)", () => {
  for (const name of ["gcp-external-kafka", "aws-external-kafka-msk"]) {
    const values = tierFixture(name);
    assert.equal(values.kafka.enabled, false, `${name}: kafka subchart off`);
    assert.equal(
      values.kafka.provisioning.enabled,
      false,
      `${name}: provisioning must be disabled for external Kafka`,
    );
  }
});

test("invariant checker catches partition/worker and prefix drift", () => {
  const base = tierFixture("aws-self-hosted-minimal");

  // Healthy values pass.
  assert.deepEqual(validateValuesInvariants(base), []);

  // Workers above the partition ceiling.
  const tooManyWorkers = JSON.parse(JSON.stringify(base));
  tooManyWorkers.rulebricks.hps.workers.keda.maxReplicaCount =
    tooManyWorkers.rulebricks.hps.workers.solutionPartitions + 1;
  assert.ok(
    validateValuesInvariants(tooManyWorkers).some((e) =>
      e.includes("maxReplicaCount"),
    ),
  );

  // Prefixed provisioning names while the app runs unprefixed (the original
  // CLI/chart drift this guard exists for).
  const wrongPrefix = JSON.parse(JSON.stringify(base));
  for (const topic of wrongPrefix.kafka.provisioning.topics) {
    topic.name = `com.rulebricks.${topic.name}`;
  }
  assert.ok(
    validateValuesInvariants(wrongPrefix).some((e) =>
      e.includes('must include "solution"'),
    ),
  );

  // Solution topic partitions diverging from solutionPartitions (MAX_WORKERS).
  const divergedPartitions = JSON.parse(JSON.stringify(base));
  divergedPartitions.kafka.provisioning.topics[0].partitions += 8;
  assert.ok(
    validateValuesInvariants(divergedPartitions).some((e) =>
      e.includes("MAX_WORKERS"),
    ),
  );

  // Worker CPU request exceeding the limit is rejected (K8s would reject it).
  // The CLI no longer emits worker resources (chart defaults apply), but the
  // invariant must still catch a hand-edited values file that sets them wrong.
  const requestOverLimit = JSON.parse(JSON.stringify(base));
  requestOverLimit.rulebricks.hps.workers.resources = {
    requests: { cpu: "4000m" },
    limits: { cpu: "1000m" },
  };
  assert.ok(
    validateValuesInvariants(requestOverLimit).some((e) =>
      e.includes("must not exceed limit"),
    ),
  );
});

test("self-hosted deployments emit supabase.db.enabled so backup validation holds", () => {
  const selfHosted = matrix.find((c) => c.name === "aws-backup-enabled");
  assert.ok(selfHosted);
  const values = buildHelmValues(selfHosted!.config) as {
    supabase: { db: { enabled: boolean } };
    backup: { enabled: boolean };
  };
  assert.equal(values.backup.enabled, true);
  assert.equal(values.supabase.db.enabled, true);
});

test("non-semver product versions are omitted from global.version", () => {
  const latest = matrix.find((c) => c.name === "aws-version-latest");
  assert.ok(latest);
  const values = buildHelmValues(latest!.config) as {
    global: { version?: string };
  };
  assert.equal(values.global.version, undefined);
});

test("semver product versions are emitted to global.version", () => {
  const base = matrix.find((c) => c.name === "aws-self-hosted-minimal");
  const values = buildHelmValues(base!.config) as {
    global: { version?: string };
  };
  assert.equal(values.global.version, "1.8.17");
});

test("validateRemoteWriteConfig enforces per-destination requirements", () => {
  const azureNoClientId: RemoteWriteConfig = {
    destination: "azure-monitor",
    url: "https://example.monitor.azure.com/api/v1/write",
    authType: "managed-identity",
  };
  assert.ok(validateRemoteWriteConfig(azureNoClientId).length > 0);

  const azureUndefinedAuth: RemoteWriteConfig = {
    destination: "azure-monitor",
    url: "https://example.monitor.azure.com/api/v1/write",
  };
  assert.ok(
    validateRemoteWriteConfig(azureUndefinedAuth).length > 0,
    "undefined Azure authType should be treated as managed identity and require a client ID",
  );

  const ampNoRegion: RemoteWriteConfig = {
    destination: "aws-amp",
    url: "https://aps.example.com/api/v1/remote_write",
  };
  assert.ok(validateRemoteWriteConfig(ampNoRegion).length > 0);

  const validAzure: RemoteWriteConfig = {
    destination: "azure-monitor",
    url: "https://example.eastus.metrics.ingest.monitor.azure.com/dataCollectionRules/dcr-1/streams/Microsoft-PrometheusMetrics/api/v1/write?api-version=2023-04-24",
    authType: "managed-identity",
    clientId: "00000000-0000-0000-0000-000000000000",
  };
  assert.deepEqual(validateRemoteWriteConfig(validAzure), []);

  // A bare DCE host (missing the dataCollectionRules/streams path) is rejected.
  const azureBareHost: RemoteWriteConfig = {
    destination: "azure-monitor",
    url: "https://example.eastus-1.ingest.monitor.azure.com",
    authType: "workload-identity",
    clientId: "00000000-0000-0000-0000-000000000000",
    tenantId: "00000000-0000-0000-0000-000000000000",
  };
  assert.ok(
    validateRemoteWriteConfig(azureBareHost).some((e) =>
      e.includes("full DCE metrics-ingestion path"),
    ),
  );
});

test("DeploymentConfigSchema rejects incomplete Azure Monitor remote write", () => {
  const base = matrix.find((c) => c.name === "azure-remote-write-managed")!;
  const broken = {
    ...base.config,
    features: {
      ...base.config.features,
      monitoring: {
        enabled: true,
        destination: "azure-monitor" as const,
        remoteWrite: {
          destination: "azure-monitor" as const,
          url: "https://example.monitor.azure.com/api/v1/write",
          authType: "managed-identity" as const,
          // clientId intentionally omitted
        },
      },
    },
  };
  const result = DeploymentConfigSchema.safeParse(broken);
  assert.equal(result.success, false);
});

test("buildHelmValues throws on a hand-broken remote write config", () => {
  const base = matrix.find((c) => c.name === "azure-remote-write-managed")!;
  // Bypass Zod to simulate a hand-edited values/config reaching generation.
  const broken = JSON.parse(JSON.stringify(base.config));
  delete broken.features.monitoring.remoteWrite.clientId;
  assert.throws(() => buildHelmValues(broken));
});

test("Azure Monitor workload identity maps to azureAd.sdk (not workloadIdentity)", () => {
  const base = matrix.find((c) => c.name === "azure-remote-write-workload")!;
  const values = buildHelmValues(base.config) as {
    "kube-prometheus-stack"?: {
      prometheus?: {
        prometheusSpec?: {
          remoteWrite?: Array<{
            azureAd?: Record<string, unknown>;
          }>;
        };
      };
    };
  };
  const rw =
    values["kube-prometheus-stack"]?.prometheus?.prometheusSpec
      ?.remoteWrite?.[0];
  assert.ok(rw, "expected a remoteWrite entry");
  const azureAd = rw!.azureAd as
    | { cloud?: string; sdk?: { tenantId?: string }; workloadIdentity?: unknown }
    | undefined;
  // The prometheus-operator schema only accepts managedIdentity/oauth/sdk.
  assert.equal(azureAd?.workloadIdentity, undefined);
  assert.equal(
    azureAd?.sdk?.tenantId,
    "22222222-2222-2222-2222-222222222222",
  );
});

test("remote write URL is stripped of stray control characters", () => {
  const base = matrix.find((c) => c.name === "azure-remote-write-workload")!;
  const dirty = JSON.parse(JSON.stringify(base.config));
  // Simulate a CRLF-pasted DCE URL reaching generation.
  dirty.features.monitoring.remoteWrite.url =
    base.config.features.monitoring.remoteWrite!.url + "\r";
  const values = buildHelmValues(dirty) as {
    "kube-prometheus-stack"?: {
      prometheus?: {
        prometheusSpec?: { remoteWrite?: Array<{ url?: string }> };
      };
    };
  };
  const url =
    values["kube-prometheus-stack"]?.prometheus?.prometheusSpec
      ?.remoteWrite?.[0]?.url;
  assert.ok(url && !/[\r\n]/.test(url), "expected no carriage returns in url");
});

function vectorKafkaSasl(
  config: DeploymentConfig,
): Record<string, unknown> | undefined {
  const values = buildHelmValues(config) as {
    vector?: {
      customConfig?: {
        sources?: { kafka?: { sasl?: Record<string, unknown> } };
      };
    };
  };
  return values.vector?.customConfig?.sources?.kafka?.sasl;
}

test("vector kafka SASL never emits an empty-default credential (would render as YAML null)", () => {
  // Helm's toYaml drops the quotes around "${VAR:-}", so an empty default
  // interpolates to a bare value that YAML parses as null, which Vector rejects
  // at config load ("invalid type: unit value, expected any valid TOML value").
  for (const { name, config } of matrix) {
    const sasl = vectorKafkaSasl(config);
    assert.ok(sasl, `${name}: expected a vector kafka sasl block`);
    for (const key of ["username", "password"] as const) {
      const value = sasl![key];
      assert.ok(
        value === undefined ||
          (typeof value === "string" && !value.includes(":-")),
        `${name}: vector kafka sasl.${key}=${JSON.stringify(value)} would render as YAML null`,
      );
    }
  }
});

test("vector kafka SASL omits creds for in-cluster/bridge Kafka and sets them for direct SASL", () => {
  const inCluster = vectorKafkaSasl(
    matrix.find((c) => c.name === "aws-self-hosted-minimal")!.config,
  );
  assert.equal(inCluster?.username, undefined);
  assert.equal(inCluster?.password, undefined);

  const mskBridge = vectorKafkaSasl(
    matrix.find((c) => c.name === "aws-external-kafka-msk")!.config,
  );
  assert.equal(mskBridge?.username, undefined);
  assert.equal(mskBridge?.password, undefined);

  const directSasl = vectorKafkaSasl(
    matrix.find((c) => c.name === "gcp-external-kafka")!.config,
  );
  assert.equal(directSasl?.username, "${KAFKA_SASL_USERNAME}");
  assert.equal(directSasl?.password, "${KAFKA_SASL_PASSWORD}");
});

function vectorSinks(
  config: DeploymentConfig,
): Record<string, Record<string, unknown>> {
  const values = buildHelmValues(config) as {
    vector?: {
      customConfig?: { sinks?: Record<string, Record<string, unknown>> };
    };
  };
  return values.vector?.customConfig?.sinks ?? {};
}

test("decision_logs sink writes gzipped NDJSON (never parquet) for every cloud", () => {
  // Vector's azure_blob/gcs sinks have no parquet encoder and `parquet` is not a
  // valid encoding.codec; ClickHouse reads these blobs as JSONEachRow.
  for (const name of [
    "aws-self-hosted-minimal", // s3
    "gcp-self-hosted", // gcs
    "azure-workload-identity", // azure_blob
  ]) {
    const sink = vectorSinks(matrix.find((c) => c.name === name)!.config)
      .decision_logs;
    assert.ok(sink, `${name}: expected a decision_logs sink`);
    const encoding = sink.encoding as { codec?: string } | undefined;
    const framing = sink.framing as { method?: string } | undefined;
    assert.equal(encoding?.codec, "json", `${name}: encoding.codec`);
    assert.equal(
      framing?.method,
      "newline_delimited",
      `${name}: framing.method`,
    );
    assert.equal(sink.compression, "gzip", `${name}: compression`);
    // azure_blob has no filename_extension field (always writes .log/.log.gz);
    // aws_s3 and gcs support it and we set ndjson.
    if (sink.type === "azure_blob") {
      assert.equal(
        sink.filename_extension,
        undefined,
        `${name}: azure_blob must not set filename_extension`,
      );
    } else {
      assert.equal(
        sink.filename_extension,
        "ndjson",
        `${name}: filename_extension`,
      );
    }
  }
});

test("no vector sink uses the unsupported parquet codec or extension", () => {
  for (const { name, config } of matrix) {
    for (const [key, sink] of Object.entries(vectorSinks(config))) {
      const encoding = sink.encoding as { codec?: string } | undefined;
      assert.notEqual(
        encoding?.codec,
        "parquet",
        `${name}: sink ${key} uses unsupported codec parquet`,
      );
      assert.notEqual(
        sink.filename_extension,
        "parquet",
        `${name}: sink ${key} uses parquet filename_extension`,
      );
    }
  }
});

test("tracing disabled by default: no global.tracing, traefik.tracing empty", () => {
  const values = buildHelmValues(
    matrix.find((c) => c.name === "aws-self-hosted-minimal")!.config,
  ) as Record<string, any>;
  assert.equal(values.global.tracing, undefined);
  assert.deepEqual(values.traefik.tracing, {});
  assert.equal(values["vector-agent"].enabled, false);
});

test("tracing enabled wires global.tracing, traefik OTLP, and Elastic auth", () => {
  const values = buildHelmValues(
    matrix.find((c) => c.name === "aws-tracing-elastic")!.config,
  ) as Record<string, any>;

  assert.equal(values.global.tracing.enabled, true);
  assert.equal(
    values.global.tracing.elastic.endpoint,
    "https://rb-deployment.apm.us-east-1.aws.elastic-cloud.com:443",
  );
  assert.equal(values.global.tracing.elastic.authMode, "secret-token");
  assert.equal(
    values.global.tracing.elastic.secretToken,
    "elastic-apm-secret-token",
  );

  // Default destination is elastic when none is specified.
  assert.equal(values.global.tracing.destination, "elastic");

  // Traefik becomes the root span and points at the in-cluster collector.
  assert.equal(values.traefik.tracing.otlp.enabled, true);
  assert.match(
    values.traefik.tracing.otlp.http.endpoint as string,
    /-otel-collector:4318\/v1\/traces$/,
  );
});

test("tracing destination otlp wires a generic OTLP backend with bearer auth", () => {
  const values = buildHelmValues(
    matrix.find((c) => c.name === "aws-tracing-otlp")!.config,
  ) as Record<string, any>;

  assert.equal(values.global.tracing.enabled, true);
  assert.equal(values.global.tracing.destination, "otlp");
  assert.equal(values.global.tracing.elastic, undefined);
  assert.equal(
    values.global.tracing.otlp.endpoint,
    "https://otlp-gateway.example.com/otlp",
  );
  assert.equal(values.global.tracing.otlp.authMode, "bearer");
  assert.equal(values.global.tracing.otlp.token, "otlp-bearer-token");

  // Collector is still the in-cluster receiver; only the export target differs.
  assert.equal(values.traefik.tracing.otlp.enabled, true);
});

test("tracing destination azure-monitor wires the Application Insights backend", () => {
  const values = buildHelmValues(
    matrix.find((c) => c.name === "azure-tracing-azure-monitor")!.config,
  ) as Record<string, any>;

  assert.equal(values.global.tracing.enabled, true);
  assert.equal(values.global.tracing.destination, "azure-monitor");
  assert.equal(values.global.tracing.elastic, undefined);
  assert.match(
    values.global.tracing.azureMonitor.connectionString as string,
    /^InstrumentationKey=/,
  );
});

test("appLogs enabled produces a vector-agent with an elasticsearch sink", () => {
  const values = buildHelmValues(
    matrix.find((c) => c.name === "aws-app-logs-elasticsearch")!.config,
  ) as Record<string, any>;

  const agent = values["vector-agent"];
  assert.equal(agent.enabled, true);
  assert.equal(agent.role, "Agent");
  assertNoBareExistsToleration("vector-agent", agent.tolerations);
  assert.deepEqual(agent.tolerations, [BURST_POOL_TOLERATION]);
  assert.equal(
    agent.customConfig.sources.kubernetes_logs.type,
    "kubernetes_logs",
  );
  // The agent must not scrape the Vector pods: the aggregator re-emits decision
  // logs on stdout (ClickHouse-only) and self-scraping the agent would loop.
  assert.match(
    agent.customConfig.sources.kubernetes_logs.extra_label_selector as string,
    /notin \(vector,vector-agent\)/,
  );
  const sink = agent.customConfig.sinks.elasticsearch;
  assert.equal(sink.type, "elasticsearch");
  assert.deepEqual(sink.endpoints, [
    "https://rb-deployment.es.us-east-1.aws.elastic-cloud.com:9243",
  ]);
  assert.equal(sink.auth.strategy, "basic");
  assert.equal(sink.auth.user, "elastic");
});

test("operational DaemonSets use explicit safe tolerations", () => {
  const values = buildHelmValues(
    matrix.find((c) => c.name === "aws-self-hosted-minimal")!.config,
  ) as Record<string, any>;

  const prepullTolerations = values.rulebricks.hps.imagePrepull
    .tolerations as Toleration[];
  assertNoBareExistsToleration("imagePrepull", prepullTolerations);
  assert.deepEqual(prepullTolerations, [BURST_POOL_TOLERATION]);
});

test("operational DaemonSet tolerations include ARM and burst pools explicitly", () => {
  const config = cloneFixture("azure-workload-identity");
  const appLogsConfig = cloneFixture("aws-app-logs-elasticsearch");
  config.infrastructure.arm64TolerationRequired = true;
  config.features.logging.appLogs = appLogsConfig.features.logging.appLogs;

  const values = buildHelmValues(config) as Record<string, any>;
  const expectedTolerations: Toleration[] = [
    {
      key: "kubernetes.io/arch",
      operator: "Equal",
      value: "arm64",
      effect: "NoSchedule",
    },
    BURST_POOL_TOLERATION,
  ];

  for (const [label, tolerations] of [
    ["imagePrepull", values.rulebricks.hps.imagePrepull.tolerations],
    ["vector-agent", values["vector-agent"].tolerations],
  ] as Array<[string, Toleration[]]>) {
    assertNoBareExistsToleration(label, tolerations);
    for (const expected of expectedTolerations) {
      assertIncludesToleration(label, tolerations, expected);
    }
  }
});

test("worker metrics path/port are emitted for the worker ServiceMonitor", () => {
  const values = buildHelmValues(
    matrix.find((c) => c.name === "aws-self-hosted-minimal")!.config,
  ) as Record<string, any>;
  assert.equal(values.rulebricks.metrics.worker.path, "/metrics");
  assert.equal(values.rulebricks.metrics.worker.port, 3000);
});

test("invariant rejects enabled tracing without an Elastic endpoint", () => {
  const values = buildHelmValues(
    matrix.find((c) => c.name === "aws-tracing-elastic")!.config,
  ) as Record<string, any>;
  values.global.tracing.elastic.endpoint = "";
  const errors = validateValuesInvariants(values);
  assert.ok(
    errors.some((e) => e.includes("tracing.elastic.endpoint")),
    `expected a tracing endpoint invariant error, got: ${errors.join("; ")}`,
  );
});
