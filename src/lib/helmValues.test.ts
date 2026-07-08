import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { buildHelmValues, signSupabaseJwt } from "./helmValues.js";
import { getActiveWizardSteps } from "./wizardSteps.js";
import {
  collectConfigIssues,
  configToWizardState,
} from "../components/Wizard/WizardContext.js";
import {
  storageProviderForCloud,
  storageRegionForCloud,
} from "../components/Wizard/steps/StorageStep.js";
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
  getReleaseName,
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

test("ClickStack is the default in-cluster observability backend", () => {
  const config = cloneFixture("aws-self-hosted-minimal");
  const values = buildHelmValues(config) as Record<string, any>;

  assert.equal(values.global.clickstack.enabled, true);
  assert.equal(typeof values.global.supabase.anonKey, "string");
  assert.equal(typeof values.global.supabase.serviceKey, "string");
  assert.ok(values.global.supabase.anonKey.length > 0);
  assert.ok(values.global.supabase.serviceKey.length > 0);
  assert.equal(values.decisionLogs, undefined);
  assert.equal(values.global.clickstack.clickhouse, undefined);
  // global.clickstack.enabled is the single switch; the subchart block carries
  // no enabled mirror.
  assert.equal(values.clickstack.enabled, undefined);
  assert.equal(values.clickhouse.persistence.enabled, true);
  assert.equal(values.clickhouse.persistence.size, "100Gi");
  assert.deepEqual(values.clickhouse.resources, {
    requests: { cpu: "1000m", memory: "4Gi" },
    limits: { cpu: "4", memory: "12Gi" },
  });
  assert.deepEqual(values.clickhouse.otelQueryLimits, {
    maxMemoryUsage: 4294967296,
    maxThreads: 8,
    maxExecutionTime: 120,
  });
  assert.equal(values.clickstack.clickhouse.retentionDays, 7);
  assert.equal(values.clickstack.clickhouse.ttl, "");
  assert.equal(values.clickstack.clickhouse.decisionLogs, undefined);
  assert.deepEqual(values.clickstack.hyperdx.resources, {
    requests: { cpu: "250m", memory: "512Mi" },
    limits: { cpu: "1000m", memory: "1Gi" },
  });
  assert.deepEqual(values.clickstack.collector.gateway.resources, {
    requests: { cpu: "250m", memory: "512Mi" },
    limits: { cpu: "2000m", memory: "1Gi" },
  });
  assert.deepEqual(values.clickstack.collector.agent.resources, {
    requests: { cpu: "100m", memory: "256Mi" },
    limits: { cpu: "500m", memory: "512Mi" },
  });
  assert.deepEqual(values.clickstack.ferretdb.persistence, {
    enabled: true,
    size: "10Gi",
    storageClassName: "gp3",
  });
  assert.deepEqual(values.clickstack.ferretdb.resources.ferretdb, {
    requests: { cpu: "100m", memory: "256Mi" },
    limits: { cpu: "500m", memory: "512Mi" },
  });
  assert.deepEqual(values.clickstack.ferretdb.resources.postgres, {
    requests: { cpu: "250m", memory: "512Mi" },
    limits: { cpu: "1000m", memory: "1Gi" },
  });
  assert.equal(values["vector-agent"].enabled, false);
  assert.equal(values.vector.customConfig.sinks.decision_logs_clickhouse, undefined);
  assert.ok(values.vector.customConfig.sinks.decision_logs);
  assert.equal(
    values.vector.env.some((entry: { name?: string }) => entry.name === "CLICKHOUSE_PASSWORD"),
    false,
  );
  assert.equal(values.global.tracing, undefined);
  assert.equal(values.traefik.tracing.otlp.enabled, true);

  const remoteWrite =
    values["kube-prometheus-stack"].prometheus.prometheusSpec.remoteWrite;
  assert.deepEqual(remoteWrite, []);
});

test("built-in observability settings flow into generated Helm values", () => {
  const config = cloneFixture("aws-self-hosted-minimal");
  config.features.observability = {
    clickstack: {
      enabled: true,
      telemetryRetentionDays: 14,
      clickHouseStorageSize: "250Gi",
    },
  };

  const values = buildHelmValues(config) as Record<string, any>;

  assert.equal(values.clickstack.clickhouse.retentionDays, 14);
  assert.equal(values.clickstack.clickhouse.decisionLogs, undefined);
  assert.equal(values.global.clickstack.clickhouse, undefined);
  assert.equal(values.clickhouse.persistence.size, "250Gi");
  assert.equal(values.clickstack.ferretdb.persistence.size, "10Gi");
});

test("buildHelmValues rejects self-hosted Supabase without a JWT secret early", () => {
  const config = cloneFixture("aws-self-hosted-minimal");
  delete config.database.supabaseJwtSecret;

  assert.throws(
    () => buildHelmValues(config),
    /Self-hosted Supabase is missing a JWT secret/,
  );
});

test("buildHelmValues rejects enabled AI without an OpenAI key early", () => {
  const config = cloneFixture("aws-self-hosted-minimal");
  config.features.ai = { enabled: true };

  assert.throws(
    () => buildHelmValues(config),
    /AI features are enabled but the OpenAI API key is missing/,
  );
});

test("configure wizard backfills missing self-hosted Supabase JWT secret", () => {
  const config = cloneFixture("aws-self-hosted-minimal");
  delete config.database.supabaseJwtSecret;

  const state = configToWizardState(config);

  assert.equal(typeof state.supabaseJwtSecret, "string");
  assert.ok(state.supabaseJwtSecret.length >= 32);
  assert.equal(
    collectConfigIssues({ ...state, name: "configure-test" }).some((issue) =>
      issue.includes("JWT secret"),
    ),
    false,
  );
});

test("self-hosted Supabase keys derive from the configured JWT secret", () => {
  const config = cloneFixture("aws-self-hosted-minimal");
  config.database.supabaseJwtSecret = "test-jwt-secret-used-for-derived-keys";

  const values = buildHelmValues(config) as Record<string, any>;

  assert.equal(
    values.global.supabase.anonKey,
    signSupabaseJwt("anon", config.database.supabaseJwtSecret),
  );
  assert.equal(
    values.global.supabase.serviceKey,
    signSupabaseJwt("service_role", config.database.supabaseJwtSecret),
  );
  assert.equal(
    values.supabase.secret.jwt.secret,
    config.database.supabaseJwtSecret,
  );
});

test("wizard orders storage before observability and skips feature config for built-in observability alone", () => {
  const state = {
    databaseType: "self-hosted",
    aiEnabled: false,
    ssoEnabled: false,
    clickStackEnabled: true,
    metricsExportEnabled: false,
    tracingEnabled: false,
    appLogsEnabled: false,
    valkeyAdminEnabled: false,
    loggingSink: "console",
    customEmailsEnabled: false,
  };

  const steps = getActiveWizardSteps(state, "create");

  assert.deepEqual(
    steps.slice(
      steps.indexOf("external-services"),
      steps.indexOf("version"),
    ),
    ["external-services", "storage", "observability", "features"],
  );
  assert.equal(steps.includes("feature-config"), false);
});

test("wizard routes enabled AI without key through feature config", () => {
  const steps = getActiveWizardSteps(
    {
      databaseType: "self-hosted",
      aiEnabled: true,
      ssoEnabled: false,
      clickStackEnabled: true,
      metricsExportEnabled: false,
      tracingEnabled: false,
      appLogsEnabled: false,
      valkeyAdminEnabled: false,
      loggingSink: "console",
      customEmailsEnabled: false,
    },
    "create",
  );

  assert.ok(steps.includes("feature-config"));
});

test("wizard includes feature config for BYO observability signals", () => {
  const steps = getActiveWizardSteps(
    {
      databaseType: "self-hosted",
      aiEnabled: false,
      ssoEnabled: false,
      clickStackEnabled: false,
      metricsExportEnabled: true,
      tracingEnabled: true,
      appLogsEnabled: false,
      valkeyAdminEnabled: false,
      loggingSink: "console",
      customEmailsEnabled: false,
    },
    "create",
  );

  assert.ok(steps.indexOf("storage") < steps.indexOf("observability"));
  assert.ok(steps.indexOf("observability") < steps.indexOf("features"));
  assert.ok(steps.includes("feature-config"));
});

test("wizard includes feature config for Valkey Admin options", () => {
  const steps = getActiveWizardSteps(
    {
      databaseType: "self-hosted",
      aiEnabled: false,
      ssoEnabled: false,
      clickStackEnabled: true,
      metricsExportEnabled: false,
      tracingEnabled: false,
      appLogsEnabled: false,
      valkeyAdminEnabled: true,
      loggingSink: "console",
      customEmailsEnabled: false,
    },
    "create",
  );

  assert.ok(steps.includes("feature-config"));
});

test("Valkey Admin ingress emits public hostname and BasicAuth users", () => {
  const config = cloneFixture("aws-self-hosted-minimal");
  config.features.cache = {
    valkeyAdmin: {
      enabled: true,
      exposure: "ingress",
      basicAuthUsers: ["admin:$2a$10$abcdefghijklmnopqrstuv"],
      allowedIPs: ["203.0.113.0/24"],
    },
    redisExporter: { enabled: true },
    kafkaExporter: { enabled: true },
  };

  const values = buildHelmValues(config) as Record<string, any>;
  const valkeyAdmin = values.rulebricks.cache.valkeyAdmin;

  assert.equal(valkeyAdmin.enabled, true);
  assert.equal(valkeyAdmin.exposure, "ingress");
  assert.equal(valkeyAdmin.ingress.enabled, true);
  assert.equal(valkeyAdmin.ingress.hostname, "valkey.rb.example.com");
  assert.deepEqual(valkeyAdmin.ingress.basicAuth.users, [
    "admin:$2a$10$abcdefghijklmnopqrstuv",
  ]);
  assert.deepEqual(valkeyAdmin.ingress.allowedIPs, ["203.0.113.0/24"]);
});

test("ClickHouse decision-log bootstrap reads only the object-storage archive", (t) => {
  const candidates = [
    process.env.RULEBRICKS_CHART_DIR,
    path.resolve(process.cwd(), "../private/helm"),
    path.resolve(process.cwd(), "../helm"),
  ].filter(Boolean) as string[];
  const chartDir = candidates.find((candidate) =>
    fs.existsSync(path.join(candidate, "templates", "_defaults.tpl")),
  );

  if (!chartDir) {
    t.skip("Helm chart templates not available in this checkout");
    return;
  }

  const defaults = fs.readFileSync(
    path.join(chartDir, "templates", "_defaults.tpl"),
    "utf8",
  );

  assert.match(defaults, /rulebricks\.decision_logs_archive/);
  assert.match(defaults, /CREATE OR REPLACE VIEW rulebricks\.decision_logs AS SELECT/);
  assert.doesNotMatch(defaults, /rulebricks\.decision_logs_recent/);
  assert.doesNotMatch(defaults, /TTL toDateTime\(timestamp\)/);
});

test("BYO observability opt-out disables ClickStack and keeps export paths", () => {
  const config = cloneFixture("aws-tracing-elastic");
  const values = buildHelmValues(config) as Record<string, any>;

  assert.equal(values.global.clickstack.enabled, false);
  assert.equal(values.global.clickstack.clickhouse, undefined);
  assert.equal(values.clickstack.enabled, undefined);
  assert.equal(values.clickhouse.persistence.enabled, false);
  assert.equal(values.vector.customConfig.sinks.decision_logs_clickhouse, undefined);
  assert.equal(values.global.tracing.destination, "elastic");
  assert.deepEqual(
    values["kube-prometheus-stack"].prometheus.prometheusSpec.remoteWrite,
    [],
  );
});

interface KafkaTopicValues {
  name: string;
  partitions: number;
  replicas: number;
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
    config: Record<string, string>;
    topics?: KafkaTopicValues[];
  };
}

function tierFixture(name: string): GeneratedKafkaValues {
  const entry = matrix.find((c) => c.name === name);
  assert.ok(entry, `missing matrix fixture ${name}`);
  return buildHelmValues(entry!.config) as unknown as GeneratedKafkaValues;
}

test("external MSK IAM topic-provisioning toggle maps to kafka.provisioning.enabled", () => {
  const entry = matrix.find((c) => c.name === "aws-external-kafka-msk");
  assert.ok(entry, "missing aws-external-kafka-msk fixture");

  // Default (provisionTopics unset): the chart provisions topics.
  const on = buildHelmValues(entry!.config) as unknown as {
    kafka: { provisioning?: { enabled?: boolean }; topics?: unknown[] };
  };
  assert.equal(on.kafka.provisioning?.enabled, true);

  // Locked-down: operator manages topics -> provisioning disabled, but the topic
  // list is still emitted (so it's documented; the Job just won't render).
  const cfg = JSON.parse(JSON.stringify(entry!.config));
  cfg.externalServices.kafka.external.provisionTopics = false;
  const off = buildHelmValues(cfg) as unknown as {
    kafka: { provisioning?: { enabled?: boolean }; topics?: unknown[] };
  };
  assert.equal(off.kafka.provisioning?.enabled, false);
  assert.equal(off.kafka.topics?.length, 3);
});

test("kafka-exporter defaults on wherever the chart can authenticate it", () => {
  // In-cluster: plaintext broker, exporter always works.
  const inCluster = buildHelmValues(
    cloneFixture("aws-self-hosted-minimal"),
  ) as Record<string, any>;
  assert.equal(inCluster.rulebricks.kafkaExporter.enabled, true);

  // External MSK IAM: opt-in - the exporter only supports IRSA, not the Pod
  // Identity associations the CLI creates (kafka_exporter#494).
  const msk = buildHelmValues(
    cloneFixture("aws-external-kafka-msk"),
  ) as Record<string, any>;
  assert.equal(msk.rulebricks.kafkaExporter.enabled, false);
  assert.equal(
    msk.rulebricks.kafkaExporter.brokers,
    "b-1.msk.example:9098,b-2.msk.example:9098",
  );

  // Explicit opt-in (IRSA users) is honored.
  const optIn = cloneFixture("aws-external-kafka-msk");
  optIn.features.cache = { kafkaExporter: { enabled: true } };
  const optInValues = buildHelmValues(optIn) as Record<string, any>;
  assert.equal(optInValues.rulebricks.kafkaExporter.enabled, true);

  // Static PLAIN/SCRAM with credentials: the chart inherits kafkaSasl into the
  // exporter, so it works out of the box.
  const staticSasl = buildHelmValues(
    cloneFixture("gcp-external-kafka"),
  ) as Record<string, any>;
  assert.equal(staticSasl.rulebricks.kafkaExporter.enabled, true);

  // Static mechanism without any credential to carry: stay opt-in.
  const noCreds = cloneFixture("gcp-external-kafka");
  (noCreds.externalServices!.kafka!.external!.sasl as any) = {
    mechanism: "plain",
  };
  const noCredsValues = buildHelmValues(noCreds) as Record<string, any>;
  assert.equal(noCredsValues.rulebricks.kafkaExporter.enabled, false);
});

test("MSK IAM config without a SASL region fails schema validation", () => {
  const cfg = cloneFixture("aws-external-kafka-msk");
  delete (cfg.externalServices!.kafka!.external!.sasl as any).region;
  const result = DeploymentConfigSchema.safeParse(cfg);
  assert.equal(result.success, false);
  assert.ok(
    result.error!.issues.some((issue) =>
      issue.path.join(".").endsWith("external.sasl.region"),
    ),
    JSON.stringify(result.error!.issues),
  );
});

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
    assert.equal(values.kafka.enabled, true);

    const topics = values.kafka.topics!;
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
    assert.equal(byName["solution"].replicas, 1);
    assert.equal(byName["logs"].replicas, 1);

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
      values.kafka.config["num.partitions"],
      "12",
      `${fixtureName}: num.partitions must no longer track max workers`,
    );
  }
});

test("external MSK IAM populates topics for provisioning; other external Kafka stays customer-managed", () => {
  // AWS MSK IAM: the chart's kafka-topic-provision Job creates these on the
  // managed broker (through the proxy bridge), so they MUST be populated - MSK
  // Serverless won't auto-create them.
  const msk = tierFixture("aws-external-kafka-msk");
  assert.equal(msk.kafka.enabled, false, "msk: kafka subchart off");
  assert.equal(
    msk.kafka.topics?.length ?? 0,
    3,
    "msk: topics populated so the provisioning Job can create them",
  );

  // GCP managed Kafka (no kafka-proxy bridge - a plain client reaches it
  // directly): topics remain customer-managed, so the CLI emits none.
  const gcp = tierFixture("gcp-external-kafka");
  assert.equal(gcp.kafka.enabled, false, "gcp: kafka subchart off");
  assert.equal(
    gcp.kafka.topics?.length ?? 0,
    0,
    "gcp: no managed topics for non-bridge external Kafka",
  );
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
  for (const topic of wrongPrefix.kafka.topics) {
    topic.name = `com.rulebricks.${topic.name}`;
  }
  assert.ok(
    validateValuesInvariants(wrongPrefix).some((e) =>
      e.includes('must include "solution"'),
    ),
  );

  // Solution topic partitions diverging from solutionPartitions (MAX_WORKERS).
  const divergedPartitions = JSON.parse(JSON.stringify(base));
  divergedPartitions.kafka.topics[0].partitions += 8;
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

test("external Postgres disables backups even with stale backup config", () => {
  const config = cloneFixture("aws-external-postgres");
  config.backup = {
    enabled: true,
    schedule: "0 2 * * *",
    retentionDays: 14,
  };

  const values = buildHelmValues(config) as {
    backup: { enabled: boolean; schedule: string; retentionDays: number };
  };

  assert.equal(values.backup.enabled, false);
  assert.equal(values.backup.schedule, "0 2 * * *");
  assert.equal(values.backup.retentionDays, 14);
});

test("storage wizard derives provider from selected cloud", () => {
  assert.equal(storageProviderForCloud("aws"), "s3");
  assert.equal(storageProviderForCloud("azure"), "azure-blob");
  assert.equal(storageProviderForCloud("gcp"), "gcs");
  assert.equal(storageProviderForCloud(null), "s3");
  assert.equal(storageRegionForCloud("aws", "us-east-1", "azure-blob", "eastus"), "us-east-1");
  assert.equal(storageRegionForCloud("azure", "eastus", "azure-blob", "eastus2"), "eastus2");
  assert.equal(storageRegionForCloud("gcp", "us-central1-a", undefined, "eastus"), "us-central1");
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
    // aws_s3 and gcs support it. The extension MUST end in .gz because the
    // ClickHouse decision_logs named collection globs *.gz and relies on the
    // extension for compression auto-detection - files without it upload fine
    // but never show up in the app.
    if (sink.type === "azure_blob") {
      assert.equal(
        sink.filename_extension,
        undefined,
        `${name}: azure_blob must not set filename_extension`,
      );
    } else {
      assert.equal(
        sink.filename_extension,
        "ndjson.gz",
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

test("Grafana dashboard references only classified metric families", (t) => {
  const candidates = [
    process.env.RULEBRICKS_CHART_DIR,
    path.resolve(process.cwd(), "../private/helm"),
    path.resolve(process.cwd(), "../helm"),
  ].filter(Boolean) as string[];
  const chartDir = candidates.find((candidate) =>
    fs.existsSync(path.join(candidate, "dashboards", "rulebricks-overview.json")),
  );

  if (!chartDir) {
    t.skip("Helm chart dashboard not available in this checkout");
    return;
  }

  const dashboardPath = path.join(
    chartDir,
    "dashboards",
    "rulebricks-overview.json",
  );
  const dashboard = JSON.parse(fs.readFileSync(dashboardPath, "utf8")) as {
    panels?: Array<{
      targets?: Array<{ expr?: string }>;
    }>;
  };

  const expressions = (dashboard.panels ?? [])
    .flatMap((panel) => panel.targets ?? [])
    .map((target) => target.expr)
    .filter((expr): expr is string => Boolean(expr));

  const knownFamilies = [
    // Rulebricks-owned metrics from app/HPS/worker code.
    /^rulebricks_app_(http_requests_total|http_request_duration_seconds_(bucket|sum|count)|http_rejections_total|frontend_errors_total|redis_operations_total|redis_operation_duration_seconds_(bucket|sum|count)|nodejs_.*)$/,
    /^rulebricks_hps_(http_requests_total|http_request_duration_seconds_(bucket|sum|count)|rejections_total|kafka_request_duration_seconds_(bucket|sum|count)|kafka_errors_total|bulk_items_total|decision_log_failures_total|decision_logs_total|decision_log_bytes_total|chunks_per_request_(bucket|sum|count)|chunk_failures_total|chunk_processing_ms_(bucket|sum|count)|chunk_cost_ms_per_item|chunk_cost_ms_per_byte|cache_items|cache_max_entries|cache_requests_total|redis_cache_operations_total|redis_cache_operation_duration_seconds_(bucket|sum|count)|nodejs_.*)$/,
    /^rulebricks_worker_(messages_total|processing_duration_seconds_(bucket|sum|count)|redis_cache_operations_total|redis_cache_operation_duration_seconds_(bucket|sum|count)|nodejs_.*)$/,
    // kube-prometheus-stack / cAdvisor / node-exporter families.
    /^container_(cpu_usage_seconds_total|memory_working_set_bytes|oom_events_total|cpu_cfs_throttled_periods_total|cpu_cfs_periods_total)$/,
    /^kube_(pod_container_status_restarts_total|pod_status_phase|pod_status_unschedulable|deployment_.*|horizontalpodautoscaler_.*)$/,
    /^kubelet_volume_stats_(used_bytes|capacity_bytes)$/,
    /^node_(cpu_seconds_total|memory_MemAvailable_bytes|memory_MemTotal_bytes|filesystem_avail_bytes|filesystem_size_bytes)$/,
    // Optional exporter families.
    /^redis_(commands_processed_total|connected_clients|memory_used_bytes|memory_max_bytes|keyspace_hits_total|keyspace_misses_total|evicted_keys_total)$/,
    /^kafka_(consumergroup_lag|log_log_size|network_requestchannel_requestqueuesize_value|network_requestchannel_responsequeuesize_value|server_brokertopicmetrics_total_failedproducerequestspersec_count|server_brokertopicmetrics_total_failedfetchrequestspersec_count)$/,
    /^traefik_(service_requests_total|service_request_duration_seconds_bucket)$/,
    /^ClickHouse(Metrics_Query|Metrics_MemoryTracking|ProfileEvents_Query)$/,
  ];

  const metricToken = /\b(?:rulebricks_[a-zA-Z0-9_:]+|container_[a-zA-Z0-9_:]+|kube_[a-zA-Z0-9_:]+|kubelet_[a-zA-Z0-9_:]+|node_[a-zA-Z0-9_:]+|redis_[a-zA-Z0-9_:]+|kafka_[a-zA-Z0-9_:]+|traefik_[a-zA-Z0-9_:]+|ClickHouse[a-zA-Z0-9_:]+)\b/g;
  const metrics = new Set<string>();
  for (const expr of expressions) {
    for (const match of expr.matchAll(metricToken)) {
      metrics.add(match[0]);
    }
  }

  const unknown = [...metrics].filter(
    (metric) => !knownFamilies.some((family) => family.test(metric)),
  );
  assert.deepEqual(unknown.sort(), []);
});

test("BYO tracing is disabled by default while ClickStack owns OTLP routing", () => {
  const values = buildHelmValues(
    matrix.find((c) => c.name === "aws-self-hosted-minimal")!.config,
  ) as Record<string, any>;
  assert.equal(values.global.tracing, undefined);
  assert.equal(values.traefik.tracing.otlp.enabled, true);
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
    ["clickstack-collector-agent", values.clickstack.collector.agent.tolerations],
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

test("external Postgres maps to supabase.externalDatabase with bootstrap creds", () => {
  const config = cloneFixture("aws-external-postgres");
  const values = buildHelmValues(config) as Record<string, any>;
  const sb = values.supabase;
  assert.equal(sb.enabled, true);
  // Bundled DB off; externalDatabase is the single switch.
  assert.equal(sb.db.enabled, false);
  assert.equal(sb.externalDatabase.enabled, true);
  assert.equal(
    sb.externalDatabase.host,
    "db.cluster-xxxx.us-east-1.rds.amazonaws.com",
  );
  assert.equal(sb.externalDatabase.port, 5432);
  // Bootstrap (one-time init) carries inline master creds + app role.
  assert.equal(sb.externalDatabase.bootstrap.enabled, true);
  assert.equal(sb.externalDatabase.bootstrap.masterUsername, "postgres");
  assert.equal(
    sb.externalDatabase.bootstrap.masterPassword,
    "master-pw-change-me",
  );
  // The shared service-role password the chart hands every service.
  assert.ok(typeof sb.secret.db.password === "string");
  assert.equal(sb.secret.db.database, "postgres");
  // Managed Postgres defaults to forced SSL (e.g. RDS rds.force_ssl=1), while
  // the chart defaults DB_SSL to disable; external mode must override it for
  // every service that dials the DB. Realtime takes a boolean-as-string.
  assert.equal(sb.auth.environment.DB_SSL, "require");
  assert.equal(sb.rest.environment.DB_SSL, "require");
  assert.equal(sb.meta.environment.DB_SSL, "require");
  assert.equal(sb.realtime.environment.DB_SSL, "true");
});

test("embedded Postgres does not override DB_SSL (in-cluster DB has no TLS)", () => {
  const config = cloneFixture("aws-self-hosted-minimal");
  const values = buildHelmValues(config) as Record<string, any>;
  const sb = values.supabase;
  assert.equal(sb.auth.environment, undefined);
  assert.equal(sb.rest.environment, undefined);
  assert.equal(sb.realtime.environment, undefined);
  assert.equal(sb.meta.environment, undefined);
});

test("external Postgres k8s secret mode keeps compatibility and uses secret refs", () => {
  const config = cloneFixture("aws-external-postgres");
  const values = buildHelmValues(config, { secretMode: "k8s" }) as Record<
    string,
    any
  >;
  const sb = values.supabase;

  assert.equal(sb.externalDatabase.enabled, true);
  // Keep inline host/port so older charts still render, while new charts prefer
  // the Secret keys below.
  assert.equal(
    sb.externalDatabase.host,
    "db.cluster-xxxx.us-east-1.rds.amazonaws.com",
  );
  assert.equal(sb.externalDatabase.port, 5432);
  assert.equal(sb.externalDatabase.secretRef, `${getReleaseName(config.name)}-supabase-db`);
  assert.deepEqual(sb.externalDatabase.secretRefKey, {
    host: "host",
    port: "port",
    username: "username",
    password: "password",
    database: "database",
  });
  assert.equal(
    sb.externalDatabase.bootstrap.secretRef,
    `${getReleaseName(config.name)}-supabase-db-bootstrap`,
  );
  assert.equal(sb.externalDatabase.bootstrap.masterPassword, undefined);
  assert.equal(sb.secret.db.secretRef, `${getReleaseName(config.name)}-supabase-db`);
  assert.deepEqual(sb.secret.db.secretRefKey, {
    host: "host",
    port: "port",
    username: "username",
    password: "password",
    database: "database",
  });
});

test("embedded Postgres still deploys the bundled database", () => {
  const config = cloneFixture("aws-self-hosted-minimal");
  const values = buildHelmValues(config) as Record<string, any>;
  assert.equal(values.supabase.db.enabled, true);
  assert.equal(values.supabase.externalDatabase, undefined);
});

import { buildDeploymentSecrets } from "./secrets.js";
import { deriveRealtimeSecrets } from "./helmValues.js";

test("k8s secret mode: secretRefs set, app secrets kept out of values (license stays inline for the pull secret)", () => {
  const config = cloneFixture("aws-self-hosted-minimal");
  config.features.ai = {
    enabled: true,
    openaiApiKey: "sk-test-openai-key-for-secret-mode",
  };
  const dbPw = config.database.supabaseDbPassword!;
  const jwt = config.database.supabaseJwtSecret!;
  const dashPw = config.database.supabaseDashboardPass!;
  const license = config.licenseKey;
  const openai = config.features.ai.openaiApiKey!;
  const values = buildHelmValues(config, { secretMode: "k8s" }) as Record<
    string,
    any
  >;
  const schemaResult = validateHelmValues(values);
  assert.ok(
    schemaResult.valid,
    `k8s secret-mode values should satisfy chart schema:\n${schemaResult.errors.join("\n")}`,
  );
  // secretRef seams point at the CLI-created Secrets
  assert.equal(values.global.secrets.secretRef, `${getReleaseName(config.name)}-app-secrets`);
  assert.equal(
    values.supabase.secret.db.secretRef,
    `${getReleaseName(config.name)}-supabase-db`,
  );
  assert.equal(
    values.supabase.secret.jwt.secretRef,
    `${getReleaseName(config.name)}-supabase-jwt`,
  );
  assert.equal(
    values.supabase.secret.dashboard.secretRef,
    `${getReleaseName(config.name)}-supabase-dashboard`,
  );
  assert.equal(
    values.supabase.secret.realtime.secretRef,
    `${getReleaseName(config.name)}-supabase-realtime`,
  );
  // Genuinely-sensitive app secrets are stripped (delivered via secretRef).
  assert.equal(values.global.supabase.jwtSecret, undefined);
  assert.equal(values.global.ai.openaiApiKey, undefined);
  // These two MUST stay inline: the standard (unmodified) chart consumes them at
  // Helm TEMPLATE time with no secretRef seam.
  //  - licenseKey -> registry-secret.yaml builds the <release>-regcred pull
  //    secret. Stripping it => dckr_pat_evaluation => 401 on every private image.
  //  - anonKey (public) -> app-configmap.yaml NEXT_PUBLIC_SUPABASE_PUBLIC_KEY.
  assert.equal(values.global.licenseKey, license);
  assert.ok(
    values.global.supabase.anonKey,
    "public anonKey must remain inline in k8s mode for the app ConfigMap",
  );
  // Runtime seam: the app deployment injects the browser anon key from the
  // jwt Secret, keeping it in lockstep with Kong's consumer keys on rotation.
  assert.equal(
    values.global.supabase.secretRef,
    `${getReleaseName(config.name)}-supabase-jwt`,
  );
  assert.deepEqual(values.global.supabase.secretRefKey, { anonKey: "anonKey" });
  // The genuinely-sensitive app secrets never appear in the generated values.
  const dump = JSON.stringify(values);
  for (const [label, secret] of [
    ["db password", dbPw],
    ["jwt secret", jwt],
    ["dashboard password", dashPw],
    ["openai key", openai],
  ] as const) {
    assert.ok(!dump.includes(secret), `${label} leaked into k8s-mode values`);
  }
});

test("k8s secret mode: SSO + AI configs validate against the chart schema", () => {
  // SSO clientId/clientSecret and the OpenAI key are redacted into the app
  // Secret in k8s mode; the chart schema must accept global.secrets.secretRef
  // in place of the inline values (delivered via envFrom).
  const config = cloneFixture("aws-all-features");
  const values = buildHelmValues(config, { secretMode: "k8s" }) as Record<
    string,
    any
  >;
  const result = validateHelmValues(values);
  assert.ok(
    result.valid,
    `k8s-mode SSO/AI values should satisfy the chart schema:\n${result.errors.join("\n")}`,
  );
  assert.equal(values.global.sso.clientId, undefined);
  assert.equal(values.global.sso.clientSecret, undefined);
  assert.equal(values.global.ai.openaiApiKey, undefined);
  assert.equal(values.global.secrets.secretRef, `${getReleaseName(config.name)}-app-secrets`);
});

test("k8s secret mode: managed Supabase config validates against the chart schema", () => {
  // Managed (Supabase Cloud) redacts the access token into the app Secret; the
  // schema must accept secretRef instead of an inline global.supabase.accessToken.
  const config = cloneFixture("aws-supabase-cloud");
  const values = buildHelmValues(config, { secretMode: "k8s" }) as Record<
    string,
    any
  >;
  const result = validateHelmValues(values);
  assert.ok(
    result.valid,
    `k8s-mode managed-Supabase values should satisfy the chart schema:\n${result.errors.join("\n")}`,
  );
  assert.equal(values.global.supabase.accessToken, undefined);
  assert.ok(values.global.supabase.url);
  assert.equal(values.global.secrets.secretRef, `${getReleaseName(config.name)}-app-secrets`);
  // Managed mode's runtime anon-key seam points at the consolidated app secret.
  assert.equal(
    values.global.supabase.secretRef,
    `${getReleaseName(config.name)}-app-secrets`,
  );
  assert.deepEqual(values.global.supabase.secretRefKey, {
    anonKey: "SUPABASE_ANON_KEY",
  });
});

test("inline secret mode keeps secrets in values (dev path)", () => {
  const config = cloneFixture("aws-self-hosted-minimal");
  const values = buildHelmValues(config, { secretMode: "inline" }) as Record<
    string,
    any
  >;
  assert.equal(
    values.supabase.secret.db.password,
    config.database.supabaseDbPassword,
  );
  // realtime keys derived (no shipped default) and present inline
  assert.ok(values.supabase.secret.realtime.secretKeyBase);
  assert.equal(values.supabase.secret.realtime.dbEncKey.length, 16);
  // no consolidated app secretRef in inline mode
  assert.equal(values.global.secrets?.secretRef ?? "", "");
});

test("buildDeploymentSecrets: app + supabase secrets with JWT-derived keys", () => {
  const config = cloneFixture("aws-self-hosted-minimal");
  const jwt = config.database.supabaseJwtSecret!;
  const byName = Object.fromEntries(
    buildDeploymentSecrets(config).map((s) => [s.name, s.stringData]),
  );
  const base = getReleaseName(config.name);
  assert.equal(byName[`${base}-app-secrets`].LICENSE_KEY, config.licenseKey);
  assert.equal(
    byName[`${base}-supabase-db`].password,
    config.database.supabaseDbPassword,
  );
  assert.equal(
    byName[`${base}-supabase-jwt`].anonKey,
    signSupabaseJwt("anon", jwt),
  );
  assert.equal(
    byName[`${base}-supabase-jwt`].serviceKey,
    signSupabaseJwt("service_role", jwt),
  );
  // realtime keys match the chart-side derivation + 16-byte DB_ENC_KEY
  const rt = deriveRealtimeSecrets(jwt);
  assert.equal(
    byName[`${base}-supabase-realtime`].SECRET_KEY_BASE,
    rt.secretKeyBase,
  );
  assert.equal(byName[`${base}-supabase-realtime`].DB_ENC_KEY.length, 16);
});

test("buildDeploymentSecrets includes external Postgres host/port and bootstrap creds", () => {
  const config = cloneFixture("aws-external-postgres");
  const byName = Object.fromEntries(
    buildDeploymentSecrets(config).map((s) => [s.name, s.stringData]),
  );
  const base = getReleaseName(config.name);

  assert.deepEqual(byName[`${base}-supabase-db`], {
    username: "postgres",
    password: config.database.supabaseDbPassword,
    database: "postgres",
    host: "db.cluster-xxxx.us-east-1.rds.amazonaws.com",
    port: "5432",
  });
  assert.deepEqual(byName[`${base}-supabase-db-bootstrap`], {
    "master-username": "postgres",
    "master-password": "master-pw-change-me",
    "service-password": config.database.supabaseDbPassword,
  });
});

test("external Postgres wires migrations.externalDb host/port for the migration hook", () => {
  // templates/migration-job.yaml reads DB_HOST from .Values.migrations.externalDb
  // (not supabase.externalDatabase). If unset, pg_isready gets an empty host and
  // the migrate hook hangs until Helm times out. Guards that regression.
  const config = cloneFixture("aws-external-postgres");
  const values = buildHelmValues(config, { secretMode: "k8s" }) as Record<
    string,
    any
  >;
  assert.ok(
    values.migrations?.externalDb,
    "migrations.externalDb must be set for external Postgres",
  );
  assert.ok(
    values.migrations.externalDb.host,
    "migration-hook DB_HOST must be non-empty",
  );
  assert.equal(
    values.migrations.externalDb.host,
    values.supabase.externalDatabase.host,
  );
  assert.equal(values.migrations.externalDb.port, "5432");
  // Migrations run as the master (bootstrap only sets service-role passwords, not
  // the master's), so DB_PASSWORD must come from the bootstrap Secret's
  // master-password, NOT the service password in <release>-supabase-db.
  assert.equal(
    values.migrations.externalDb.existingSecret,
    `${getReleaseName(config.name)}-supabase-db-bootstrap`,
  );
  assert.equal(values.migrations.externalDb.existingSecretKey, "master-password");
  // Bundled-Postgres deploys must NOT set it (chart uses the internal service).
  const internal = buildHelmValues(cloneFixture("aws-self-hosted-minimal"), {
    secretMode: "k8s",
  }) as Record<string, any>;
  assert.equal(internal.migrations?.externalDb, undefined);
});

test("supabase kong ingress carries Traefik websecure router annotations under TLS", () => {
  // The supabase subchart's kong ingress doesn't emit router.entrypoints/tls
  // itself, so Traefik only builds a web router and https://supabase.<domain>
  // 404s. The CLI must inject them (via the subchart's annotations passthrough).
  const config = cloneFixture("aws-self-hosted-minimal");
  const tls = buildHelmValues(config, {
    tlsEnabled: true,
    secretMode: "k8s",
  }) as Record<string, any>;
  const a = tls.supabase.kong.ingress.annotations;
  assert.equal(
    a["traefik.ingress.kubernetes.io/router.entrypoints"],
    "websecure",
  );
  assert.equal(a["traefik.ingress.kubernetes.io/router.tls"], "true");
  const notls = buildHelmValues(config, {
    tlsEnabled: false,
    secretMode: "k8s",
  }) as Record<string, any>;
  const b = notls.supabase.kong.ingress.annotations;
  assert.equal(b["traefik.ingress.kubernetes.io/router.entrypoints"], "web");
  assert.equal(b["traefik.ingress.kubernetes.io/router.tls"], "false");
});

// ===========================================================================
// Image registry / digest pinning (docker.io/rulebricks/* + global.imageRegistry)
// ===========================================================================

test("default image refs use the rulebricks/* split shape with no legacy hosts", () => {
  const config = cloneFixture("aws-self-hosted-minimal");
  const values = buildHelmValues(config) as Record<string, any>;

  // app/hps use the split { registry, repository } shape (host never in repo).
  assert.deepEqual(values.rulebricks.app.image.registry, "docker.io");
  assert.equal(values.rulebricks.app.image.repository, "rulebricks/app");
  assert.equal(values.rulebricks.hps.image.registry, "docker.io");
  assert.equal(values.rulebricks.hps.image.repository, "rulebricks/hps");

  // clickstack images keep the split shape too.
  assert.equal(values.clickstack.hyperdx.image.registry, "docker.io");
  assert.equal(values.clickstack.hyperdx.image.repository, "rulebricks/hyperdx");
  assert.equal(values.clickstack.collector.image.registry, "docker.io");
  assert.equal(
    values.clickstack.collector.image.repository,
    "rulebricks/clickstack-otel-collector",
  );
  assert.equal(values.clickstack.ferretdb.image.registry, "docker.io");
  assert.equal(
    values.clickstack.ferretdb.image.repository,
    "rulebricks/ferretdb",
  );
  assert.equal(
    values.clickstack.ferretdb.postgresImage.repository,
    "rulebricks/postgres-documentdb",
  );

  // Whole-output guard: no dhi.io and no index.docker.io anywhere.
  const dump = JSON.stringify(values);
  assert.ok(!dump.includes("dhi.io"), "dhi.io must not appear in output");
  assert.ok(
    !dump.includes("index.docker.io"),
    "index.docker.io must not appear in output",
  );
  assert.ok(!dump.includes("grepplabs"), "grepplabs must not appear in output");
});

test("global.imageDigests is always present and threaded into global", () => {
  const config = cloneFixture("aws-self-hosted-minimal");
  const values = buildHelmValues(config) as Record<string, any>;
  assert.ok(
    values.global.imageDigests !== undefined,
    "global.imageDigests must be present",
  );
  assert.equal(typeof values.global.imageDigests, "object");
  // No imageRegistry override emitted when config.imageRegistry is unset.
  assert.equal(values.global.imageRegistry, undefined);
});

test("imageRegistry override rewrites every image host to the custom registry", () => {
  const config = cloneFixture("aws-self-hosted-minimal");
  config.imageRegistry = "myacr.azurecr.io";
  // Enable external-dns so its image block is emitted and can be asserted.
  config.dns = { provider: "route53", autoManage: true };
  const values = buildHelmValues(config) as Record<string, any>;
  const reg = "myacr.azurecr.io";

  // global passthrough
  assert.equal(values.global.imageRegistry, reg);

  // app / hps / clickstack / supabase split shapes
  assert.equal(values.rulebricks.app.image.registry, reg);
  assert.equal(values.rulebricks.app.image.repository, "rulebricks/app");
  assert.equal(values.rulebricks.hps.image.registry, reg);
  assert.equal(values.clickstack.hyperdx.image.registry, reg);
  assert.equal(values.clickstack.collector.image.registry, reg);
  assert.equal(values.clickstack.ferretdb.image.registry, reg);
  assert.equal(values.clickstack.ferretdb.postgresImage.registry, reg);
  assert.equal(values.supabase.db.image.registry, reg);

  // kube-prometheus-stack sub-images
  const kps = values["kube-prometheus-stack"];
  assert.equal(kps.prometheus.prometheusSpec.image.registry, reg);
  assert.equal(
    kps.prometheus.prometheusSpec.image.repository,
    "rulebricks/prometheus",
  );
  assert.equal(kps.alertmanager.alertmanagerSpec.image.registry, reg);
  assert.equal(
    kps.alertmanager.alertmanagerSpec.image.repository,
    "rulebricks/alertmanager",
  );
  assert.equal(kps.prometheusOperator.image.registry, reg);
  assert.equal(
    kps.prometheusOperator.image.repository,
    "rulebricks/prometheus-operator",
  );
  assert.equal(
    kps.prometheusOperator.prometheusConfigReloader.image.registry,
    reg,
  );
  assert.equal(
    kps.prometheusOperator.prometheusConfigReloader.image.repository,
    "rulebricks/prometheus-config-reloader",
  );
  assert.equal(
    kps.prometheusOperator.admissionWebhooks.patch.image.registry,
    reg,
  );
  assert.equal(
    kps.prometheusOperator.admissionWebhooks.patch.image.repository,
    "rulebricks/kube-webhook-certgen",
  );
  assert.equal(kps.grafana.image.registry, reg);
  assert.equal(kps.grafana.image.repository, "rulebricks/grafana");
  assert.equal(kps.grafana.sidecar.image.registry, reg);
  assert.equal(kps.grafana.sidecar.image.repository, "rulebricks/k8s-sidecar");
  assert.equal(kps["kube-state-metrics"].image.registry, reg);
  assert.equal(
    kps["kube-state-metrics"].image.repository,
    "rulebricks/kube-state-metrics",
  );
  assert.equal(kps["prometheus-node-exporter"].image.registry, reg);
  assert.equal(
    kps["prometheus-node-exporter"].image.repository,
    "rulebricks/node-exporter",
  );

  // cert-manager (registry + repository per component)
  const cm = values["cert-manager"];
  assert.equal(cm.image.registry, reg);
  assert.equal(cm.image.repository, "rulebricks/cert-manager-controller");
  assert.equal(cm.webhook.image.registry, reg);
  assert.equal(cm.webhook.image.repository, "rulebricks/cert-manager-webhook");
  assert.equal(cm.cainjector.image.registry, reg);
  assert.equal(
    cm.cainjector.image.repository,
    "rulebricks/cert-manager-cainjector",
  );
  assert.equal(cm.startupapicheck.image.registry, reg);
  assert.equal(
    cm.startupapicheck.image.repository,
    "rulebricks/cert-manager-startupapicheck",
  );
  assert.equal(cm.acmesolver.image.registry, reg);
  assert.equal(
    cm.acmesolver.image.repository,
    "rulebricks/cert-manager-acmesolver",
  );

  // traefik (registry + repository)
  assert.equal(values.traefik.image.registry, reg);
  assert.equal(values.traefik.image.repository, "rulebricks/traefik");

  // keda (global.image.registry host + per-comp repositories)
  assert.equal(values.keda.global.image.registry, reg);
  assert.equal(values.keda.image.keda.registry, reg);
  assert.equal(values.keda.image.keda.repository, "rulebricks/keda");
  assert.equal(
    values.keda.image.metricsApiServer.repository,
    "rulebricks/keda-metrics-apiserver",
  );
  assert.equal(
    values.keda.image.webhooks.repository,
    "rulebricks/keda-admission-webhooks",
  );

  // vector + external-dns (full-path repository incl. host)
  assert.equal(values.vector.image.repository, `${reg}/rulebricks/vector`);
  assert.equal(
    values["external-dns"].image.repository,
    `${reg}/rulebricks/external-dns`,
  );

  // Every image host is the custom registry: no docker.io image refs remain.
  const dump = JSON.stringify(values);
  assert.ok(!dump.includes("dhi.io"));
  assert.ok(!dump.includes("index.docker.io"));
  assert.ok(
    !dump.includes('"docker.io/rulebricks'),
    "no full docker.io/rulebricks path refs remain when overridden",
  );
});

test("per-chart imagePullSecrets are still emitted for private rulebricks/*", () => {
  const config = cloneFixture("aws-self-hosted-minimal");
  const values = buildHelmValues(config) as Record<string, any>;
  const expected = [{ name: `${getReleaseName(config.name)}-regcred` }];

  assert.deepEqual(values.global.imagePullSecrets, expected);
  assert.deepEqual(
    values["strimzi-kafka-operator"].image.imagePullSecrets,
    expected,
  );
  assert.deepEqual(values.traefik.deployment.imagePullSecrets, expected);
  assert.deepEqual(values.keda.imagePullSecrets, expected);
  assert.deepEqual(values.vector.image.pullSecrets, expected);

  // global has no legacy dhi.io reference.
  assert.ok(!JSON.stringify(values.global).includes("dhi.io"));
});
