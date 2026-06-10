import {
  DeploymentConfig,
  TIER_CONFIGS,
  TierConfig,
  isSupportedDnsProvider,
  RemoteWriteConfig,
  SecretKeyRef,
  validateRemoteWriteConfig,
} from "../types/index.js";
import { saveHelmValues, getHelmValuesPath } from "./config.js";
import { assertValidHelmValues } from "./validateValues.js";
import {
  SUPABASE_POSTGRES_IMAGE_REPOSITORY,
  SUPABASE_POSTGRES_IMAGE_TAG,
} from "./versions.js";
import fs from "fs/promises";
import YAML from "yaml";

interface GenerateOptions {
  tlsEnabled?: boolean;
}

// global.version must be empty or a semantic version per the chart schema. The
// CLI normally pins a real version, but migrated/legacy configs can carry
// "latest"; emitting that would fail chart validation, so we omit it instead
// and let the chart fall back to its default.
const SEMVER_PATTERN = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/;

// Healthy defaults for the decision-log archive that ClickHouse reads:
// flush a gzipped NDJSON file at ~256 MiB (uncompressed) or after 5 minutes,
// whichever comes first. Users can override these in their Helm values.
const DECISION_LOG_BATCH = { max_bytes: 268435456, timeout_secs: 300 } as const;

// VRL that normalizes the Kafka decision-log envelope into the ClickHouse column
// types. Inlined as a real multi-line string (not a chart `{{ include }}`) so
// that YAML.stringify / Helm's toYaml emit it as a block scalar. A templated
// single-line include gets rendered into a single-quoted YAML scalar, whose
// newlines YAML folds into spaces — collapsing the statements onto one line and
// breaking VRL parsing. Keep in sync with rulebricks.vector.normalizeLogs.
const VECTOR_NORMALIZE_LOGS_VRL = [
  "parsed, err = parse_json(string!(.message))",
  "if err == null {",
  "  . = parsed",
  "}",
  '.timestamp = parse_timestamp!(to_string(.timestamp) ?? to_string(now()), format: "%+")',
  '.api_key = to_string(.api_key) ?? ""',
  ".user_id = to_string(.user_id) ?? null",
  ".environment = to_string(.environment) ?? null",
  ".ip = to_string(.ip) ?? null",
  ".method = to_string(.method) ?? null",
  '.url = to_string(.url) ?? ""',
  ".status = to_int(.status) ?? 0",
  ".rule_name = to_string(.rule_name) ?? null",
  ".rule_id = to_string(.rule_id) ?? null",
  ".rule_slug = to_string(.rule_slug) ?? null",
  ".rule_version = to_string(.rule_version) ?? null",
  ".operation = to_string(.operation) ?? null",
  '.level = to_string(.level) ?? "info"',
  ".error = to_string(.error) ?? null",
  '.request = to_string(.request) ?? "null"',
  '.response = to_string(.response) ?? "null"',
  '.decision = to_string(.decision) ?? "{}"',
  '.params = to_string(.params) ?? "{}"',
].join("\n");

function decisionLogPathPrefix(config: DeploymentConfig): string {
  const path = config.storage?.paths?.decisionLogs || "decision-logs";
  return `${path.replace(/^\/+|\/+$/g, "")}/year=%Y/month=%m/day=%d/hour=%H/`;
}

/**
 * Generates Vector sink configuration based on logging settings
 */
function generateVectorSinks(
  config: DeploymentConfig,
): Record<string, unknown> {
  const sinks: Record<string, unknown> = {
    // Console sink is always enabled
    console: {
      type: "console",
      inputs: ["normalize_logs"],
      encoding: {
        codec: "json",
      },
    },
  };

  if (config.storage) {
    const storage = config.storage;
    switch (config.storage.provider) {
      case "s3":
        sinks.decision_logs = {
          type: "aws_s3",
          inputs: ["normalize_logs"],
          bucket: storage.bucket,
          region: storage.region,
          key_prefix: decisionLogPathPrefix(config),
          filename_extension: "ndjson",
          compression: "gzip",
          encoding: { codec: "json" },
          framing: { method: "newline_delimited" },
          batch: { ...DECISION_LOG_BATCH },
        };
        break;
      case "azure-blob": {
        const sink: Record<string, unknown> = {
          type: "azure_blob",
          inputs: ["normalize_logs"],
          account_name: storage.bucket,
          container_name: storage.azureBlobContainer || "rulebricks",
          blob_prefix: decisionLogPathPrefix(config),
          // azure_blob has no filename_extension (unlike aws_s3/gcs); it always
          // writes ".log" (".log.gz" when compressed). ClickHouse globs on *.gz.
          compression: "gzip",
          encoding: { codec: "json" },
          framing: { method: "newline_delimited" },
          batch: { ...DECISION_LOG_BATCH },
        };
        if (config.storage.cloudAuthMode === "secret") {
          sink.connection_string = "${AZURE_STORAGE_CONNECTION_STRING}";
        } else {
          sink.auth = {
            azure_credential_kind: "workload_identity",
            client_id: config.storage.azureBlobClientId,
            tenant_id: config.storage.azureBlobTenantId,
            token_file_path: "/var/run/secrets/azure/tokens/azure-identity-token",
          };
        }
        sinks.decision_logs = sink;
        break;
      }
      case "gcs":
        sinks.decision_logs = {
          type: "gcp_cloud_storage",
          inputs: ["normalize_logs"],
          bucket: storage.bucket,
          key_prefix: decisionLogPathPrefix(config),
          filename_extension: "ndjson",
          compression: "gzip",
          encoding: { codec: "json" },
          framing: { method: "newline_delimited" },
          batch: { ...DECISION_LOG_BATCH },
        };
        break;
    }
  }

  // Add external logging-platform sink if configured. Decision logs always go
  // to object storage via the decision_logs sink above; this is an additional
  // platform destination (Datadog, Splunk, etc.).
  if (
    config.features.logging.sink !== "console" &&
    config.features.logging.sink !== "pending"
  ) {
    const { sink, bucket, region } = config.features.logging;

    switch (sink) {
      // Logging platform sinks
      // For platforms, bucket is repurposed for API key/token, region for site/URL
      case "datadog":
        sinks.datadog = {
          type: "datadog_logs",
          inputs: ["normalize_logs"],
          default_api_key: bucket, // API key stored in bucket field
          site: region || "datadoghq.com", // Site stored in region field
          compression: "gzip",
          encoding: {
            codec: "json",
          },
        };
        break;

      case "splunk":
        sinks.splunk = {
          type: "splunk_hec_logs",
          inputs: ["normalize_logs"],
          endpoint: region, // URL stored in region field
          default_token: bucket, // HEC token stored in bucket field
          compression: "gzip",
          encoding: {
            codec: "json",
          },
        };
        break;

      case "elasticsearch":
        // Elasticsearch config is JSON-encoded in bucket field
        try {
          const esConfig = JSON.parse(bucket || "{}");
          sinks.elasticsearch = {
            type: "elasticsearch",
            inputs: ["normalize_logs"],
            endpoints: [esConfig.url],
            bulk: {
              index: esConfig.index || "rulebricks-logs",
            },
            ...(esConfig.user && esConfig.password
              ? {
                  auth: {
                    strategy: "basic",
                    user: esConfig.user,
                    password: esConfig.password,
                  },
                }
              : {}),
          };
        } catch {
          // Fallback if JSON parsing fails
          sinks.elasticsearch = {
            type: "elasticsearch",
            inputs: ["normalize_logs"],
            endpoints: [bucket],
            bulk: {
              index: region || "rulebricks-logs",
            },
          };
        }
        break;

      case "loki":
        sinks.loki = {
          type: "loki",
          inputs: ["normalize_logs"],
          endpoint: bucket, // Loki URL stored in bucket field
          labels: {
            app: "rulebricks",
            source: "decision-logs",
          },
          encoding: {
            codec: "json",
          },
        };
        break;

      case "newrelic":
        sinks.newrelic = {
          type: "new_relic",
          inputs: ["normalize_logs"],
          license_key: bucket, // License key stored in bucket field
          account_id: region, // Account ID stored in region field
          api: "logs",
          compression: "gzip",
          encoding: {
            codec: "json",
          },
        };
        break;

      case "axiom":
        sinks.axiom = {
          type: "axiom",
          inputs: ["normalize_logs"],
          token: bucket, // API token stored in bucket field
          dataset: region || "rulebricks", // Dataset stored in region field
          compression: "gzip",
          encoding: {
            codec: "json",
          },
        };
        break;
    }
  }

  return sinks;
}

function generateVectorEnv(config: DeploymentConfig): Array<Record<string, unknown>> {
  // Kafka connection settings come from the templated vector-kafka-env ConfigMap
  // so the in-cluster vs external (and bridge) decision lives in one place.
  const configMapKeys = [
    "KAFKA_BOOTSTRAP_SERVERS",
    "KAFKA_TLS_ENABLED",
    "KAFKA_SASL_ENABLED",
    "KAFKA_SASL_MECHANISM",
    "KAFKA_LOG_TOPIC",
  ];
  const env: Array<Record<string, unknown>> = configMapKeys.map((key) => ({
    name: key,
    valueFrom: { configMapKeyRef: { name: "vector-kafka-env", key } },
  }));

  // SASL credentials (inline PLAIN/SCRAM). Optional so in-cluster/token-auth
  // deploys work without the secret existing.
  for (const key of ["KAFKA_SASL_USERNAME", "KAFKA_SASL_PASSWORD"]) {
    env.push({
      name: key,
      valueFrom: {
        secretKeyRef: { name: "vector-kafka-credentials", key, optional: true },
      },
    });
  }

  const azureBlobSecretRef = config.storage?.azureBlobConnectionStringSecretRef;

  if (
    config.storage?.provider === "azure-blob" &&
    config.storage.cloudAuthMode === "secret" &&
    azureBlobSecretRef
  ) {
    env.push({
      name: "AZURE_STORAGE_CONNECTION_STRING",
      valueFrom: {
        secretKeyRef: secretKeySelector(azureBlobSecretRef),
      },
    });
  }

  return env;
}

function generateVectorServiceAccount(
  config: DeploymentConfig,
): Record<string, unknown> {
  const annotations: Record<string, string> = {};

  if (config.storage?.provider === "s3" && config.storage.awsIamRoleArn) {
    annotations["eks.amazonaws.com/role-arn"] =
      config.storage.awsIamRoleArn;
  }

  if (
    config.storage?.provider === "azure-blob" &&
    config.storage.cloudAuthMode !== "secret" &&
    config.storage.azureBlobClientId
  ) {
    annotations["azure.workload.identity/client-id"] =
      config.storage.azureBlobClientId;
  }

  if (config.storage?.provider === "gcs" && config.storage.gcpServiceAccountEmail) {
    annotations["iam.gke.io/gcp-service-account"] =
      config.storage.gcpServiceAccountEmail;
  }

  // When external Kafka uses MSK IAM, the kafka-proxy bridge sidecar in this pod
  // authenticates with the pod's IRSA role. This role must also grant the object
  // storage permissions the Vector sink needs (one IRSA role per service account).
  const kafkaRoleArn =
    config.externalServices?.kafka?.external?.identity?.awsRoleArn;
  if (kafkaUsesBridge(config) && kafkaRoleArn) {
    annotations["eks.amazonaws.com/role-arn"] = kafkaRoleArn;
  }

  return {
    create: true,
    name: "vector",
    annotations,
  };
}

function generateVectorPodLabels(config: DeploymentConfig): Record<string, string> {
  const labels: Record<string, string> = {
    "rulebricks.com/workload-group": "infrastructure",
  };

  if (
    config.storage?.provider === "azure-blob" &&
    config.storage.cloudAuthMode !== "secret"
  ) {
    labels["azure.workload.identity/use"] = "true";
  }

  return labels;
}

/**
 * Maps DNS provider to external-dns provider name
 */
function getExternalDnsProvider(dnsProvider: string): string {
  const mapping: Record<string, string> = {
    route53: "aws",
    cloudflare: "cloudflare",
    google: "google",
    azure: "azure",
  };
  return mapping[dnsProvider] || "aws";
}

function secretKeySelector(ref: SecretKeyRef): Record<string, string> {
  return {
    name: ref.name,
    key: ref.key,
  };
}

/**
 * Strips surrounding whitespace and embedded control characters (notably the
 * trailing carriage return that sneaks in when a remote_write URL is pasted from
 * a CRLF file or captured from command output). A stray "\r" corrupts the URL
 * the Prometheus operator hands to remote_write, so normalize it at the source.
 */
function sanitizeRemoteWriteUrl(url: string): string {
  // eslint-disable-next-line no-control-regex
  return url.replace(/[\u0000-\u001F\u007F]/g, "").trim();
}

function generateRemoteWriteSpec(
  config: DeploymentConfig,
): Array<Record<string, unknown>> {
  if (config.features.monitoring.destination === "local-grafana") {
    return [];
  }

  const remoteWrite = config.features.monitoring.remoteWrite;

  if (!remoteWrite) {
    return config.features.monitoring.remoteWriteUrl
      ? [{ url: sanitizeRemoteWriteUrl(config.features.monitoring.remoteWriteUrl) }]
      : [];
  }

  // Enforce the same per-destination/auth requirements the wizard and Zod
  // schema do. This is unreachable for CLI-generated configs (they are gated
  // earlier) but guards hand-edited values and keeps one source of truth.
  const remoteWriteErrors = validateRemoteWriteConfig(remoteWrite);
  if (remoteWriteErrors.length > 0) {
    throw new Error(remoteWriteErrors.join(" "));
  }

  const base: Record<string, unknown> = {
    url: sanitizeRemoteWriteUrl(remoteWrite.url),
  };

  switch (remoteWrite.destination) {
    case "aws-amp":
      if (!remoteWrite.awsRegion) {
        throw new Error("AWS Managed Prometheus remote_write requires a region.");
      }
      return [
        {
          ...base,
          sigv4: {
            region: remoteWrite.awsRegion,
          },
        },
      ];
    case "azure-monitor":
      return [generateAzureMonitorRemoteWrite(remoteWrite, base)];
    case "grafana-cloud":
      return [generateBasicAuthRemoteWrite(remoteWrite, base)];
    case "generic":
      return [generateGenericRemoteWrite(remoteWrite, base)];
    default:
      return [base];
  }
}

function generatePrometheusServiceAccount(
  config: DeploymentConfig,
): Record<string, unknown> {
  const annotations: Record<string, string> = {};
  const remoteWrite = config.features.monitoring.remoteWrite;

  if (remoteWrite?.destination === "aws-amp" && remoteWrite.awsRoleArn) {
    annotations["eks.amazonaws.com/role-arn"] = remoteWrite.awsRoleArn;
  }

  if (
    remoteWrite?.destination === "azure-monitor" &&
    remoteWrite.authType === "workload-identity" &&
    remoteWrite.clientId
  ) {
    annotations["azure.workload.identity/client-id"] = remoteWrite.clientId;
  }

  return {
    create: true,
    name: "prometheus",
    annotations,
  };
}

function generatePrometheusPodMetadata(
  config: DeploymentConfig,
): Record<string, unknown> {
  const remoteWrite = config.features.monitoring.remoteWrite;

  if (
    remoteWrite?.destination === "azure-monitor" &&
    remoteWrite.authType === "workload-identity"
  ) {
    return {
      labels: {
        "azure.workload.identity/use": "true",
      },
    };
  }

  return {};
}

function generateAzureMonitorRemoteWrite(
  remoteWrite: RemoteWriteConfig,
  base: Record<string, unknown>,
): Record<string, unknown> {
  const azureAd: Record<string, unknown> = {
    cloud: remoteWrite.azureCloud || "AzurePublic",
  };

  if (remoteWrite.authType === "oauth") {
    if (
      !remoteWrite.clientId ||
      !remoteWrite.tenantId ||
      !remoteWrite.clientSecretRef
    ) {
      throw new Error(
        "Azure Monitor remote_write OAuth requires client ID, tenant ID, and client secret ref.",
      );
    }
    azureAd.oauth = {
      clientId: remoteWrite.clientId,
      tenantId: remoteWrite.tenantId,
      clientSecret: secretKeySelector(remoteWrite.clientSecretRef),
    };
  } else if (remoteWrite.authType === "workload-identity") {
    if (!remoteWrite.clientId || !remoteWrite.tenantId) {
      throw new Error(
        "Azure Monitor remote_write workload identity requires client ID and tenant ID.",
      );
    }
    // The prometheus-operator AzureAD schema supports only managedIdentity,
    // oauth, and sdk (there is no "workloadIdentity" field — emitting it makes
    // the operator reject the whole remoteWrite with "must provide Azure Managed
    // Identity or Azure OAuth or Azure SDK", which silently prevents the
    // Prometheus StatefulSet from being created). For AKS workload identity we
    // use the Azure SDK credential: it reads the projected token + AZURE_CLIENT_ID
    // injected by the workload-identity webhook (driven by the prometheus
    // ServiceAccount's azure.workload.identity/client-id annotation and the
    // azure.workload.identity/use pod label), so only the tenant ID is needed here.
    azureAd.sdk = {
      tenantId: remoteWrite.tenantId,
    };
  } else {
    if (!remoteWrite.clientId) {
      throw new Error(
        "Azure Monitor remote_write managed identity requires client ID.",
      );
    }
    azureAd.managedIdentity = {
      clientId: remoteWrite.clientId,
    };
  }

  return {
    ...base,
    azureAd,
  };
}

function generateBasicAuthRemoteWrite(
  remoteWrite: RemoteWriteConfig,
  base: Record<string, unknown>,
): Record<string, unknown> {
  if (!remoteWrite.usernameSecretRef || !remoteWrite.passwordSecretRef) {
    throw new Error(
      "Basic auth remote_write requires username and password secret refs.",
    );
  }

  return {
    ...base,
    basicAuth: {
      username: secretKeySelector(remoteWrite.usernameSecretRef),
      password: secretKeySelector(remoteWrite.passwordSecretRef),
    },
  };
}

function generateGenericRemoteWrite(
  remoteWrite: RemoteWriteConfig,
  base: Record<string, unknown>,
): Record<string, unknown> {
  if (remoteWrite.authType === "basic") {
    return generateBasicAuthRemoteWrite(remoteWrite, base);
  }

  if (remoteWrite.authType === "bearer") {
    if (!remoteWrite.bearerTokenSecretRef) {
      throw new Error("Bearer remote_write requires a token secret ref.");
    }
    return {
      ...base,
      authorization: {
        type: "Bearer",
        credentials: secretKeySelector(remoteWrite.bearerTokenSecretRef),
      },
    };
  }

  return base;
}

/**
 * Generates Kafka extra environment variables for tuning
 */
function generateKafkaExtraEnvVars(): Array<{ name: string; value: string }> {
  return [
    {
      name: "KAFKA_JVM_PERFORMANCE_OPTS",
      value:
        "-XX:MaxDirectMemorySize=256M -Djdk.nio.maxCachedBufferSize=262144",
    },
    { name: "KAFKA_CFG_QUEUED_MAX_REQUESTS", value: "10000" },
    { name: "KAFKA_CFG_NUM_NETWORK_THREADS", value: "8" },
    { name: "KAFKA_CFG_NUM_IO_THREADS", value: "8" },
    { name: "KAFKA_CFG_SOCKET_SEND_BUFFER_BYTES", value: "1048576" },
    { name: "KAFKA_CFG_SOCKET_RECEIVE_BUFFER_BYTES", value: "1048576" },
    { name: "KAFKA_CFG_SOCKET_REQUEST_MAX_BYTES", value: "209715200" },
    { name: "KAFKA_CFG_LOG_RETENTION_BYTES", value: "4294967296" },
    { name: "KAFKA_CFG_LOG_SEGMENT_BYTES", value: "1073741824" },
    { name: "KAFKA_CFG_NUM_REPLICA_FETCHERS", value: "4" },
    { name: "KAFKA_CFG_REPLICA_SOCKET_RECEIVE_BUFFER_BYTES", value: "1048576" },
    { name: "KAFKA_CFG_LOG_CLEANER_DEDUPE_BUFFER_SIZE", value: "268435456" },
    { name: "KAFKA_CFG_LOG_CLEANER_IO_BUFFER_SIZE", value: "1048576" },
    { name: "KAFKA_CFG_MAX_IN_FLIGHT_REQUESTS_PER_CONNECTION", value: "10" },
  ];
}

function generateWorkerPodAntiAffinity(): Record<string, unknown> {
  return {
    podAntiAffinity: {
      preferredDuringSchedulingIgnoredDuringExecution: [
        {
          weight: 50,
          podAffinityTerm: {
            labelSelector: {
              matchExpressions: [
                {
                  key: "rulebricks.com/workload-group",
                  operator: "In",
                  values: ["infrastructure"],
                },
              ],
            },
            topologyKey: "kubernetes.io/hostname",
          },
        },
      ],
    },
  };
}

function generateScheduling(
  tolerations?: Array<Record<string, string>>,
  affinity?: Record<string, unknown>,
): Record<string, unknown> {
  return {
    ...(affinity ? { affinity } : {}),
    ...(tolerations ? { tolerations } : {}),
  };
}

function generateBackupValues(config: DeploymentConfig): Record<string, unknown> {
  const enabled =
    config.database.type === "self-hosted" && config.backup?.enabled === true;

  // The backup CronJob streams pg_dump from the running DB (using supabase.db.image)
  // and uploads it with rclone, so no backup-specific image is needed here. The
  // chart default rclone image applies unless overridden in values.
  return {
    enabled,
    schedule: config.backup?.schedule || "0 2 * * *",
    retentionDays: config.backup?.retentionDays || 7,
  };
}

function isExternalRedis(config: DeploymentConfig): boolean {
  return config.externalServices?.redis?.mode === "external";
}

function isExternalKafka(config: DeploymentConfig): boolean {
  return config.externalServices?.kafka?.mode === "external";
}

/**
 * Whether the Vector kafka-proxy bridge sidecar is required. Only AWS MSK IAM
 * needs it: Vector's kafka source can't speak token mechanisms, while Azure
 * Event Hubs and GCP both use SASL PLAIN/SCRAM that Vector handles directly.
 */
function kafkaUsesBridge(config: DeploymentConfig): boolean {
  if (!isExternalKafka(config)) return false;
  const ext = config.externalServices?.kafka?.external;
  return (
    ext?.preset === "aws-msk-iam" || ext?.sasl?.mechanism === "aws-iam"
  );
}

/**
 * Whether Vector's kafka source connects with a direct PLAIN/SCRAM credential
 * and therefore needs username/password. This mirrors the vector-kafka-env
 * ConfigMap, which only sets KAFKA_SASL_ENABLED=true for external, non-token,
 * non-bridge mechanisms (and where vector-kafka-credentials is populated). For
 * in-cluster, bridge, and token-auth paths SASL is disabled, so username and
 * password MUST be omitted: an empty env default (${VAR:-}) renders unquoted
 * via Helm's toYaml and Vector reads the value as YAML null, which it rejects
 * at startup ("invalid type: unit value, expected any valid TOML value").
 */
function kafkaUsesDirectSasl(config: DeploymentConfig): boolean {
  if (!isExternalKafka(config)) return false;
  if (kafkaUsesBridge(config)) return false;
  const mechanism = config.externalServices?.kafka?.external?.sasl?.mechanism;
  if (!mechanism) return false;
  return mechanism !== "aws-iam" && mechanism !== "oauthbearer";
}

/**
 * Builds the rulebricks.redis block: in-cluster sizing when embedded, or
 * external connection settings when the user points at managed Redis.
 */
function generateRedisBlock(
  config: DeploymentConfig,
  tierConfig: TierConfig,
  storageClass: string,
  infrastructurePodLabels: Record<string, string>,
  coreScheduling: Record<string, unknown>,
): Record<string, unknown> {
  if (!isExternalRedis(config)) {
    return {
      podLabels: infrastructurePodLabels,
      resources: tierConfig.redisResources,
      ...coreScheduling,
      persistence: {
        enabled: true,
        size: tierConfig.redisPersistenceSize,
        storageClass,
      },
    };
  }

  const ext = config.externalServices?.redis?.external ?? {};
  const external: Record<string, unknown> = {
    host: ext.host ?? "",
    port: ext.port ?? 6379,
    tls: { enabled: ext.tls ?? false },
  };
  if (ext.password) {
    external.password = ext.password;
  }
  if (ext.existingSecret) {
    external.existingSecret = ext.existingSecret;
    external.existingSecretKey = ext.existingSecretKey || "redis-password";
  }
  if (ext.httpApi?.enabled) {
    external.httpApi = {
      enabled: true,
      url: ext.httpApi.url ?? "",
      token: ext.httpApi.token ?? "",
    };
  }

  return {
    enabled: false,
    external,
  };
}

/**
 * Builds the rulebricks.app.logging block. Decision logging is always enabled;
 * external Kafka adds brokers + SSL/SASL, while embedded auto-discovers the
 * in-cluster Kafka service.
 */
function generateAppLogging(config: DeploymentConfig): Record<string, unknown> {
  if (!isExternalKafka(config)) {
    return {
      enabled: true,
      kafkaBrokers: "", // Auto-discover from Kafka subchart
      kafkaTopic: "logs",
      // The in-cluster app/HPS produce to unprefixed topics (logs, solution,
      // solution-response). The chart default prefix ("com.rulebricks.") is meant
      // for shared/managed Kafka collision avoidance, but when applied here it
      // makes the chart-side consumers diverge from the producers: Vector would
      // subscribe to "com.rulebricks.logs" (no data) and the KEDA worker trigger
      // would watch "com.rulebricks.solution" (no lag signal). Disable prefixing
      // for the dedicated in-cluster broker so everything lines up.
      kafkaTopicPrefix: "",
    };
  }

  const ext = config.externalServices?.kafka?.external ?? {};
  const logging: Record<string, unknown> = {
    enabled: true,
    kafkaBrokers: ext.brokers ?? "",
    kafkaTopic: ext.topic || "logs",
    kafkaSsl: ext.ssl ?? false,
  };

  // Topic prefix: emit only when explicitly provided (incl. "" to disable). When
  // omitted, the chart default (com.rulebricks.) applies via value merge.
  if (ext.topicPrefix !== undefined) {
    logging.kafkaTopicPrefix = ext.topicPrefix;
  }

  if (ext.sasl?.mechanism) {
    const sasl: Record<string, unknown> = { mechanism: ext.sasl.mechanism };
    if (ext.sasl.region) sasl.region = ext.sasl.region;
    if (ext.sasl.username) sasl.username = ext.sasl.username;
    if (ext.sasl.password) sasl.password = ext.sasl.password;
    if (ext.sasl.existingSecret) sasl.existingSecret = ext.sasl.existingSecret;
    logging.kafkaSasl = sasl;
  }

  return logging;
}

/**
 * HPS service account. When external Kafka uses MSK IAM, HPS authenticates via
 * its pod identity (IRSA), so create the SA and annotate it with the role ARN.
 */
function generateHpsServiceAccount(
  config: DeploymentConfig,
): Record<string, unknown> {
  const roleArn = config.externalServices?.kafka?.external?.identity?.awsRoleArn;
  if (kafkaUsesBridge(config) && roleArn) {
    return {
      create: true,
      annotations: { "eks.amazonaws.com/role-arn": roleArn },
    };
  }
  return { create: false, annotations: {} };
}

/**
 * Top-level kafkaBridge block consumed by the Vector env ConfigMap. Only enabled
 * for AWS MSK IAM, where a kafka-proxy sidecar fronts the brokers for Vector.
 */
function generateKafkaBridge(config: DeploymentConfig): Record<string, unknown> {
  if (!kafkaUsesBridge(config)) {
    return { enabled: false };
  }
  const ext = config.externalServices?.kafka?.external ?? {};
  return {
    enabled: true,
    provider: "aws",
    region: ext.sasl?.region ?? "",
    brokers: ext.brokers ?? "",
    localPort: 19092,
    image: "grepplabs/kafka-proxy:latest",
    awsRoleArn: ext.identity?.awsRoleArn ?? "",
  };
}

/**
 * kafka-proxy sidecar for the Vector pod (AWS MSK IAM). Maps each upstream
 * broker to a sequential local port and authenticates with the pod's IRSA role.
 */
function generateVectorExtraContainers(
  config: DeploymentConfig,
): Array<Record<string, unknown>> | undefined {
  if (!kafkaUsesBridge(config)) return undefined;
  const ext = config.externalServices?.kafka?.external ?? {};
  const brokers = (ext.brokers ?? "")
    .split(",")
    .map((b) => b.trim())
    .filter(Boolean);
  if (brokers.length === 0) return undefined;

  const basePort = 19092;
  const mappings = brokers.map(
    (broker, i) => `--bootstrap-server-mapping=${broker},127.0.0.1:${basePort + i}`,
  );

  return [
    {
      name: "kafka-proxy",
      image: "grepplabs/kafka-proxy:latest",
      args: [
        "server",
        ...mappings,
        "--tls-enable",
        "--sasl-enable",
        "--sasl-method=AWS_MSK_IAM",
        `--sasl-aws-region=${ext.sasl?.region ?? ""}`,
      ],
      ports: brokers.map((_, i) => ({ containerPort: basePort + i })),
    },
  ];
}

/**
 * Builds Helm values from the deployment configuration.
 */
export function buildHelmValues(
  config: DeploymentConfig,
  options: GenerateOptions = {},
): Record<string, unknown> {
  const tierConfig = TIER_CONFIGS[config.tier];
  const { tlsEnabled = true } = options;
  const useLocalGrafana =
    config.features.monitoring.destination === "local-grafana";

  // Determine if external-dns should be enabled
  const externalDnsEnabled =
    config.dns.autoManage && isSupportedDnsProvider(config.dns.provider);

  const gcpDiskType =
    config.infrastructure.nodeArchitecture === "amd64"
      ? "pd-balanced"
      : "hyperdisk-balanced";

  // Prefer the live cluster's StorageClass. Provider defaults are only a
  // fallback for legacy configs that predate capability scanning.
  const storageClass =
    config.infrastructure.storageClass ||
    (config.infrastructure.provider === "aws"
      ? "gp3"
      : config.infrastructure.provider === "gcp"
        ? gcpDiskType
        : config.infrastructure.provider === "azure"
          ? "managed-premium"
          : "gp3");

  const shouldApplyArm64Toleration =
    config.infrastructure.arm64TolerationRequired ?? false;
  const architectureTolerations = shouldApplyArm64Toleration
    ? [
        {
          key: "kubernetes.io/arch",
          operator: "Equal",
          value: "arm64",
          effect: "NoSchedule",
        },
      ]
    : undefined;
  const coreScheduling = generateScheduling(architectureTolerations);
  const workerScheduling = generateScheduling(
    architectureTolerations,
    generateWorkerPodAntiAffinity(),
  );
  const infrastructurePodLabels = {
    "rulebricks.com/workload-group": "infrastructure",
  };
  const applicationPodLabels = {
    "rulebricks.com/workload-group": "application",
  };
  const productVersion = config.version;

  // Build global.supabase configuration
  const supabaseGlobalConfig: Record<string, unknown> =
    config.database.type === "supabase-cloud"
      ? {
          url: config.database.supabaseUrl,
          anonKey: config.database.supabaseAnonKey,
          serviceKey: config.database.supabaseServiceKey,
          accessToken: config.database.supabaseAccessToken || undefined,
          projectRef: config.database.supabaseProjectRef || undefined,
        }
      : {
          jwtSecret: config.database.supabaseJwtSecret || undefined,
          anonKey: undefined,
          serviceKey: undefined,
        };

  // Add custom email templates if enabled
  if (
    config.features.customEmails?.enabled &&
    config.features.customEmails.subjects &&
    config.features.customEmails.templates
  ) {
    supabaseGlobalConfig.emails = {
      subjects: {
        invite: config.features.customEmails.subjects.invite,
        confirmation: config.features.customEmails.subjects.confirmation,
        recovery: config.features.customEmails.subjects.recovery,
        emailChange: config.features.customEmails.subjects.emailChange,
      },
      templates: {
        invite: config.features.customEmails.templates.invite,
        confirmation: config.features.customEmails.templates.confirmation,
        recovery: config.features.customEmails.templates.recovery,
        emailChange: config.features.customEmails.templates.emailChange,
      },
    };
  }

  const values: Record<string, unknown> = {
    // =============================================================================
    // GLOBAL CONFIGURATION
    // =============================================================================
    global: {
      domain: config.domain,
      email: config.adminEmail,
      tlsEnabled,
      licenseKey: config.licenseKey,
      ...(productVersion && SEMVER_PATTERN.test(productVersion)
        ? { version: productVersion }
        : {}),
      externalDnsEnabled,

      // SMTP Configuration
      smtp: {
        host: config.smtp.host,
        port: config.smtp.port,
        user: config.smtp.user,
        pass: config.smtp.pass,
        from: config.smtp.from,
        fromName: config.smtp.fromName,
      },

      // Supabase configuration
      supabase: supabaseGlobalConfig,

      // AI configuration
      ai: {
        enabled: config.features.ai.enabled,
        openaiApiKey: config.features.ai.enabled
          ? config.features.ai.openaiApiKey
          : undefined,
      },

      // SSO configuration
      sso: config.features.sso.enabled
        ? {
            enabled: true,
            provider: config.features.sso.provider,
            url: config.features.sso.url,
            clientId: config.features.sso.clientId,
            clientSecret: config.features.sso.clientSecret,
          }
        : {
            enabled: false,
          },

      storage: config.storage
        ? {
            // One provider, one identity, one bucket/container. decision-logs and
            // db-backups are key prefixes under paths.* within it.
            provider: config.storage.provider,
            bucket: config.storage.bucket,
            region: config.storage.region,
            s3: {
              iamRoleArn: config.storage.awsIamRoleArn || "",
              existingSecret: { name: "" },
            },
            azure: {
              authMode:
                config.storage.cloudAuthMode === "secret"
                  ? "connection-string"
                  : "workload-identity",
              clientId: config.storage.azureBlobClientId || "",
              tenantId: config.storage.azureBlobTenantId || "",
              container: config.storage.azureBlobContainer || "",
              connectionStringSecretRef:
                config.storage.azureBlobConnectionStringSecretRef || {
                  name: "",
                  key: "",
                },
            },
            gcp: {
              serviceAccountEmail: config.storage.gcpServiceAccountEmail || "",
            },
            paths: {
              decisionLogs: config.storage.paths?.decisionLogs || "decision-logs",
              dbBackups: config.storage.paths?.dbBackups || "db-backups",
            },
          }
        : undefined,
    },

    backup: generateBackupValues(config),

    // =============================================================================
    // RULEBRICKS APPLICATION STACK
    // =============================================================================
    rulebricks: {
      metrics: {
        enabled: true,
        serviceMonitor: {
          enabled: true,
          interval: "30s",
          scrapeTimeout: "10s",
        },
        app: {
          path: "/api/metrics",
        },
        hps: {
          path: "/metrics",
        },
      },
      app: {
        image: {
          repository: "index.docker.io/rulebricks/app",
          pullPolicy: "IfNotPresent",
        },
        replicas: tierConfig.appReplicas,
        resources: tierConfig.appResources,
        podLabels: infrastructurePodLabels,
        ...coreScheduling,

        // Logging configuration (in-cluster auto-discovery or external Kafka)
        logging: generateAppLogging(config),
      },

      // HPS (High Performance Server)
      hps: {
        enabled: true,
        image: {
          repository: "index.docker.io/rulebricks/hps",
          pullPolicy: "Always",
        },
        replicas: tierConfig.hpsReplicas,
        resources: tierConfig.hpsResources,
        podLabels: applicationPodLabels,
        ...coreScheduling,

        // Service account (annotated with the MSK IAM role for external Kafka)
        serviceAccount: generateHpsServiceAccount(config),

        // HPS Workers with KEDA autoscaling
        workers: {
          enabled: true,
          replicas: tierConfig.hpsWorkerReplicas.min,
          keda: {
            enabled: true,
            minReplicaCount: tierConfig.hpsWorkerReplicas.min,
            maxReplicaCount: tierConfig.hpsWorkerReplicas.max,
            pollingInterval: 10,
            cooldownPeriod: 300,
            lagThreshold: 50,
            cpuThreshold: 25,
          },
          resources: tierConfig.hpsWorkerResources,
          podLabels: applicationPodLabels,
          ...workerScheduling,
        },
      },

      // Ingress configuration
      ingress: {
        enabled: true,
        className: "traefik",
        paths: [{ path: "/", pathType: "Prefix" }],
      },

      // Redis configuration (in-cluster sizing or external connection settings)
      redis: generateRedisBlock(
        config,
        tierConfig,
        storageClass,
        infrastructurePodLabels,
        coreScheduling,
      ),
    },

    // =============================================================================
    // KAFKA (Message Queue)
    // =============================================================================
    kafka: {
      enabled: !isExternalKafka(config),
      // KRaft mode (no Zookeeper)
      kraft: {
        enabled: true,
      },
      zookeeper: {
        enabled: false,
      },
      // Kafka broker configuration
      overrideConfiguration: {
        "auto.create.topics.enable": "true",
        "log.retention.hours": "24",
        "default.replication.factor": String(tierConfig.kafkaReplication),
        "offsets.topic.replication.factor": String(tierConfig.kafkaReplication),
        "num.partitions": String(tierConfig.hpsWorkerReplicas.max), // Match max workers for parallel consumption
      },
      controller: {
        replicaCount: tierConfig.kafkaReplication,
        podLabels: infrastructurePodLabels,
        resources: tierConfig.kafkaResources,
        ...coreScheduling,
        persistence: {
          enabled: true,
          size: tierConfig.kafkaStorage,
          storageClass: storageClass,
        },
        heapOpts: tierConfig.kafkaHeapOpts,
        extraEnvVars: generateKafkaExtraEnvVars(),
      },
      listeners: {
        client: {
          protocol: "PLAINTEXT",
        },
        controller: {
          protocol: "PLAINTEXT",
        },
        interbroker: {
          protocol: "PLAINTEXT",
        },
      },
      metrics: {
        jmx: {
          enabled: true,
        },
        serviceMonitor: {
          enabled: true,
        },
      },
    },

    // =============================================================================
    // VECTOR KAFKA BRIDGE (AWS MSK IAM token auth)
    // =============================================================================
    kafkaBridge: generateKafkaBridge(config),

    clickhouse: {
      enabled: true,
      auth: {
        username: "rulebricks",
        password: "",
        existingSecret: '{{ printf "%s-clickhouse-credentials" .Release.Name }}',
        existingSecretKey: "admin-password",
      },
      shards: 1,
      replicaCount: 1,
      keeper: { enabled: false },
      persistence: { enabled: false },
      resources: {
        requests: { cpu: "200m", memory: "512Mi" },
        limits: { cpu: "1000m", memory: "2Gi" },
      },
      serviceAccount: {
        create: true,
        annotations: {},
      },
      metrics: {
        enabled: true,
        serviceMonitor: {
          enabled: true,
        },
      },
      queryLimits: {
        maxMemoryUsage: 1073741824,
        maxThreads: 4,
        maxExecutionTime: 60,
      },
      configdFiles: {
        // Server-level named collections belong in config.d (the <clickhouse> root).
        "09-decision-log-storage.xml":
          '{{ include "rulebricks.clickhouse.decisionLogStorageXml" . }}',
      },
      usersdFiles: {
        // <profiles>/<users> are read from the users config tree, so these MUST be
        // in users.d. In config.d they are silently ignored: query limits go unset,
        // date_time_input_format stays "basic" (breaking decision_logs DateTime64
        // parsing), and the admin user never gets NAMED COLLECTION access (so the
        // initdb decision_logs view fails to create).
        "10-query-limits.xml":
          '{{ include "rulebricks.clickhouse.queryLimitsXml" . }}',
        "11-named-collection-access.xml":
          '{{ include "rulebricks.clickhouse.userAccessXml" . }}',
      },
      initdbScripts: {
        "01-decision-logs-view.sql":
          '{{ include "rulebricks.clickhouse.decisionLogsViewSql" . }}',
      },
    },

    // =============================================================================
    // TRAEFIK (Ingress Controller)
    // =============================================================================
    traefik: {
      enabled: true,
      ingressClass: {
        name: "traefik",
      },
      ...coreScheduling,
      autoscaling: {
        enabled: true,
        minReplicas: 1,
        maxReplicas: 2,
      },
      resources: {
        requests: {
          cpu: "100m",
          memory: "256Mi",
        },
        limits: {
          cpu: "1000m",
          memory: "2Gi",
        },
      },
      service: {
        type: "LoadBalancer",
      },
      ports: {
        web: {
          port: 8000,
          exposedPort: 80,
        },
        websecure: {
          port: 8443,
          exposedPort: 443,
          tls: {
            enabled: tlsEnabled,
          },
        },
      },
      metrics: {
        prometheus: {
          enabled: true,
          serviceMonitor: {
            enabled: false,
          },
        },
      },
      persistence: {
        enabled: false,
      },
    },

    // =============================================================================
    // KEDA (Autoscaling)
    // =============================================================================
    keda: {
      enabled: true,
      ...coreScheduling,
      crds: {
        install: false, // CRDs managed in parent chart
      },
    },

    // =============================================================================
    // CERT-MANAGER (TLS Certificates)
    // =============================================================================
    "cert-manager": {
      enabled: tlsEnabled,
      installCRDs: false, // CRDs managed in parent chart
      ...coreScheduling,
      webhook: {
        ...coreScheduling,
      },
      cainjector: {
        ...coreScheduling,
      },
    },

    // Cluster Issuer for Let's Encrypt
    clusterIssuer: {
      enabled: tlsEnabled,
      email: config.tlsEmail,
      server: "https://acme-v02.api.letsencrypt.org/directory",
    },

    // =============================================================================
    // VECTOR (Decision Logs)
    // =============================================================================
    vector: {
      enabled: true,
      role: "Stateless-Aggregator",
      replicas: tierConfig.vectorReplicas,
      resources: tierConfig.vectorResources,
      ...coreScheduling,
      serviceAccount: generateVectorServiceAccount(config),
      podLabels: generateVectorPodLabels(config),
      ...(generateVectorExtraContainers(config)
        ? { extraContainers: generateVectorExtraContainers(config) }
        : {}),
      service: {
        enabled: true,
        ports: [{ name: "api", port: 8686, protocol: "TCP", targetPort: 8686 }],
      },
      // Load KAFKA_BOOTSTRAP_SERVERS from templated ConfigMap
      env: generateVectorEnv(config),
      customConfig: {
        sources: {
          kafka: {
            type: "kafka",
            bootstrap_servers:
              "${KAFKA_BOOTSTRAP_SERVERS:-rulebricks-kafka:9092}",
            // KAFKA_LOG_TOPIC carries the namespace prefix (e.g. com.rulebricks.logs).
            topics: ["${KAFKA_LOG_TOPIC:-logs}"],
            group_id: "vector-consumers",
            auto_offset_reset: "latest",
            // TLS + SASL driven by env from vector-kafka-env (disabled for
            // in-cluster Kafka and the kafka-proxy bridge path).
            tls: { enabled: "${KAFKA_TLS_ENABLED:-false}" },
            sasl: {
              enabled: "${KAFKA_SASL_ENABLED:-false}",
              mechanism: "${KAFKA_SASL_MECHANISM:-PLAIN}",
              // username/password are only emitted for external Kafka using a
              // direct PLAIN/SCRAM credential (where vector-kafka-credentials is
              // populated). Emitting them with an empty default would render as
              // YAML null and crash Vector at config load; omitting the keys
              // leaves them unset (valid) whenever SASL is disabled.
              ...(kafkaUsesDirectSasl(config)
                ? {
                    username: "${KAFKA_SASL_USERNAME}",
                    password: "${KAFKA_SASL_PASSWORD}",
                  }
                : {}),
            },
          },
        },
        transforms: {
          normalize_logs: {
            type: "remap",
            inputs: ["kafka"],
            source: VECTOR_NORMALIZE_LOGS_VRL,
          },
        },
        sinks: generateVectorSinks(config),
      },
    },

    // =============================================================================
    // SUPABASE (Self-hosted Database)
    // =============================================================================
    supabase: {
      enabled: config.database.type === "self-hosted",
      ...(config.database.type === "self-hosted"
        ? {
            secret: {
              db: {
                username: "postgres",
                password: config.database.supabaseDbPassword,
                database: "postgres",
              },
              dashboard: {
                username: config.database.supabaseDashboardUser || "supabase",
                password: config.database.supabaseDashboardPass,
              },
              jwt: {
                secret: config.database.supabaseJwtSecret,
              },
            },
            db: {
              // Explicit so chart schema rules that key off supabase.db.enabled
              // (e.g. Database Backup Storage Validation) hold without relying
              // on subchart-default coalescing.
              enabled: true,
              image: {
                repository: SUPABASE_POSTGRES_IMAGE_REPOSITORY,
                tag: SUPABASE_POSTGRES_IMAGE_TAG,
                pullPolicy: "IfNotPresent",
              },
              podLabels: infrastructurePodLabels,
              resources: tierConfig.dbResources,
              ...coreScheduling,
              persistence: {
                enabled: true,
                size: tierConfig.dbPersistenceSize,
                storageClassName: storageClass,
              },
            },
            auth: {
              ...coreScheduling,
            },
            rest: {
              ...coreScheduling,
            },
            realtime: {
              ...coreScheduling,
            },
            meta: {
              ...coreScheduling,
            },
            kong: {
              ...coreScheduling,
              ingress: {
                enabled: true,
                className: "traefik",
                annotations: {},
              },
            },
            studio: {
              ...coreScheduling,
            },
          }
        : {}),
    },

    // =============================================================================
    // MONITORING
    // =============================================================================
    monitoring: {
      enabled: true,
    },
    "kube-prometheus-stack": {
      enabled: true,
      alertmanager: {
        enabled: false,
      },
      grafana: {
        enabled: useLocalGrafana,
      },
      prometheus: {
        enabled: true,
        serviceAccount: generatePrometheusServiceAccount(config),
        prometheusSpec: {
          retention: "30d",
          podMetadata: generatePrometheusPodMetadata(config),
          serviceMonitorSelectorNilUsesHelmValues: false,
          serviceMonitorSelector: {},
          podMonitorSelectorNilUsesHelmValues: false,
          podMonitorSelector: {},
          storageSpec: {
            volumeClaimTemplate: {
              spec: {
                storageClassName: storageClass,
                accessModes: ["ReadWriteOnce"],
                resources: {
                  requests: {
                    storage: "50Gi",
                  },
                },
              },
            },
          },
          remoteWrite: generateRemoteWriteSpec(config),
        },
      },
    },

    // =============================================================================
    // STORAGE CLASS
    // =============================================================================
    storageClass: {
      create: false,
      name: storageClass,
      provisioner:
        config.infrastructure.storageProvisioner ||
        (config.infrastructure.provider === "aws"
          ? "ebs.csi.aws.com"
          : config.infrastructure.provider === "gcp"
            ? "pd.csi.storage.gke.io"
            : config.infrastructure.provider === "azure"
              ? "disk.csi.azure.com"
              : "ebs.csi.aws.com"),
      // Parameters for the StorageClass - must include type for disk provisioning
      parameters:
        config.infrastructure.provider === "aws"
          ? { type: "gp3" }
          : config.infrastructure.provider === "gcp"
            ? { type: gcpDiskType }
            : config.infrastructure.provider === "azure"
              ? { skuName: "Premium_LRS" }
              : { type: "gp3" },
      fsType: "ext4",
      reclaimPolicy: "Delete",
      volumeBindingMode: "WaitForFirstConsumer",
      allowVolumeExpansion: true,
    },

    // =============================================================================
    // EXTERNAL DNS
    // =============================================================================
    "external-dns": externalDnsEnabled
      ? {
          enabled: true,
          provider: getExternalDnsProvider(config.dns.provider),
          domainFilters: [config.domain],
          sources: ["ingress", "service"],
          policy: "upsert-only",
        }
      : {
          enabled: false,
        },
  };

  return values;
}

/**
 * Generates Helm values from the deployment configuration
 */
export async function generateHelmValues(
  config: DeploymentConfig,
  options: GenerateOptions = {},
): Promise<void> {
  const values = buildHelmValues(config, options);
  // Last-line guardrail: never write/deploy values the chart would reject.
  assertValidHelmValues(values);
  await saveHelmValues(config.name, values);
}

/**
 * Updates existing Helm values to enable or disable TLS
 */
export async function updateHelmValuesForTLS(
  deploymentName: string,
  tlsEnabled: boolean,
): Promise<void> {
  const valuesPath = getHelmValuesPath(deploymentName);

  try {
    const content = await fs.readFile(valuesPath, "utf8");
    const values = YAML.parse(content) as Record<string, unknown>;

    // Update TLS settings
    if (values.global && typeof values.global === "object") {
      (values.global as Record<string, unknown>).tlsEnabled = tlsEnabled;
    }

    // Update cert-manager
    if (values["cert-manager"] && typeof values["cert-manager"] === "object") {
      (values["cert-manager"] as Record<string, unknown>).enabled = tlsEnabled;
    }

    // Update cluster issuer
    if (values.clusterIssuer && typeof values.clusterIssuer === "object") {
      (values.clusterIssuer as Record<string, unknown>).enabled = tlsEnabled;
    }

    // Update traefik TLS
    if (values.traefik && typeof values.traefik === "object") {
      const traefik = values.traefik as Record<string, unknown>;
      if (traefik.ports && typeof traefik.ports === "object") {
        const ports = traefik.ports as Record<string, unknown>;
        if (ports.websecure && typeof ports.websecure === "object") {
          const websecure = ports.websecure as Record<string, unknown>;
          if (websecure.tls && typeof websecure.tls === "object") {
            (websecure.tls as Record<string, unknown>).enabled = tlsEnabled;
          }
        }
      }
    }

    // Save updated values
    await fs.writeFile(valuesPath, YAML.stringify(values), "utf8");
  } catch (error) {
    throw new Error(`Failed to update Helm values: ${error}`);
  }
}

/**
 * Updates existing Helm values with new configuration
 */
export function mergeHelmValues(
  existing: Record<string, unknown>,
  updates: Partial<Record<string, unknown>>,
): Record<string, unknown> {
  return deepMerge(existing, updates);
}

function deepMerge(
  target: Record<string, unknown>,
  source: Record<string, unknown>,
): Record<string, unknown> {
  const result = { ...target };

  for (const key of Object.keys(source)) {
    const sourceValue = source[key];
    const targetValue = target[key];

    if (
      sourceValue &&
      typeof sourceValue === "object" &&
      !Array.isArray(sourceValue) &&
      targetValue &&
      typeof targetValue === "object" &&
      !Array.isArray(targetValue)
    ) {
      result[key] = deepMerge(
        targetValue as Record<string, unknown>,
        sourceValue as Record<string, unknown>,
      );
    } else {
      result[key] = sourceValue;
    }
  }

  return result;
}
