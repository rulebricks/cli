import test from "node:test";
import assert from "node:assert/strict";
import { buildHelmValues } from "./helmValues.js";
import { validateHelmValues } from "./validateValues.js";
import { buildConfigMatrix } from "./configFixtures.js";
import {
  DeploymentConfig,
  DeploymentConfigSchema,
  RemoteWriteConfig,
  validateRemoteWriteConfig,
} from "../types/index.js";

const matrix = buildConfigMatrix();

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
