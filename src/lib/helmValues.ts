import {
  DeploymentConfig,
  getReleaseName,
  isSupportedDnsProvider,
  RemoteWriteConfig,
  SecretKeyRef,
  validateRemoteWriteConfig,
} from "../types/index.js";
import {
  loadHelmValues,
  saveHelmValues,
  getHelmValuesPath,
} from "./config.js";
import { assertValidHelmValues } from "./validateValues.js";
import {
  SOLUTION_TOPIC_PARTITIONS,
  LOGS_TOPIC_PARTITIONS,
  TOPIC_REPLICATION_FACTOR,
  DECISION_LOG_BATCH,
  PROMETHEUS_RETENTION,
  PROMETHEUS_STORAGE_SIZE,
  TRAEFIK_MIN_REPLICAS,
  TRAEFIK_MAX_REPLICAS,
  DEFAULT_SUPABASE_EMAILS,
} from "./chartDefaults.js";
import {
  SUPABASE_POSTGRES_IMAGE_REPOSITORY,
  DEFAULT_IMAGE_REGISTRY,
  IMAGE_REPOSITORIES,
} from "./versions.js";
import {
  ImageCatalog,
  bundledImageCatalog,
  resolveImageCatalog,
} from "./imageCatalog.js";
import { createHmac } from "crypto";
import fs from "fs/promises";
import YAML from "yaml";

interface GenerateOptions {
  tlsEnabled?: boolean;
  // "k8s" (default at deploy time): sensitive values are created as Kubernetes
  // Secrets by the CLI and the generated values carry only *.secretRef; no
  // plaintext. "inline": secrets are written into the values (dev / direct-chart).
  secretMode?: "k8s" | "inline";
  // Infrastructure image tags, resolved from the chart's images/manifest.yaml
  // (see src/lib/imageCatalog.ts). When omitted, buildHelmValues falls back to
  // the snapshot bundled with this CLI release; the async generate* entry
  // points resolve the live catalog (for options.chartVersion) instead.
  images?: ImageCatalog;
  // Chart version the values are generated for; used to resolve the matching
  // image manifest when options.images is not supplied.
  chartVersion?: string;
}

// Names of the Kubernetes Secrets the CLI creates in k8s secret mode. Shared by
// the value generator (which sets the secretRef fields) and src/lib/secrets.ts
// (which creates the Secrets) so they always agree.
//
// The base MUST be the Helm release name, not config.name. Most chart consumers
// read the secretRef *value* (name-agnostic), but a few templates hardcode the
// canonical <release>-* name; e.g. templates/migration-job.yaml derives
// DB_PASSWORD from `{{ .Release.Name }}-supabase-db`. Naming these secrets with
// the release name keeps the CLI a faithful drop-in for the unmodified chart so
// we never have to customize the chart to match the CLI.
export function deploymentSecretNames(config: DeploymentConfig): {
  app: string;
  db: string;
  dbBootstrap: string;
  jwt: string;
  dashboard: string;
  realtime: string;
  smtp: string;
} {
  const base = getReleaseName(config.name);
  return {
    app: `${base}-app-secrets`,
    db: `${base}-supabase-db`,
    dbBootstrap: `${base}-supabase-db-bootstrap`,
    jwt: `${base}-supabase-jwt`,
    dashboard: `${base}-supabase-dashboard`,
    realtime: `${base}-supabase-realtime`,
    smtp: `${base}-supabase-smtp`,
  };
}

// global.version must be empty or a semantic version per the chart schema. The
// CLI normally pins a real version, but migrated/legacy configs can carry
// "latest"; emitting that would fail chart validation, so we omit it instead
// and let the chart fall back to its default.
const SEMVER_PATTERN = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/;

const SUPABASE_JWT_ISSUED_AT = 1641769200;
const SUPABASE_JWT_EXPIRES_AT = 4102444800;

// VRL that normalizes the Kafka decision-log envelope into the ClickHouse column
// types. Inlined as a real multi-line string (not a chart `{{ include }}`) so
// that YAML.stringify / Helm's toYaml emit it as a block scalar. A templated
// single-line include gets rendered into a single-quoted YAML scalar, whose
// newlines YAML folds into spaces - collapsing the statements onto one line and
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
  ".trace_id = to_string(.trace_id) ?? null",
  ".span_id = to_string(.span_id) ?? null",
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
          // Extension MUST end in .gz: the ClickHouse decision_logs named
          // collection globs year=*/month=*/day=*/hour=*/*.gz and relies on
          // the extension for compression auto-detection. A bare "ndjson"
          // extension (gzip content) is invisible to the view - decision logs
          // upload fine but never appear in the app.
          filename_extension: "ndjson.gz",
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
          // Must end in .gz - see the aws_s3 sink note above.
          filename_extension: "ndjson.gz",
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

/**
 * CA trust bundle for the Vector pods. The hardened rulebricks/vector image
 * ships NO system CA store (no /etc/ssl/certs at all), so every TLS connection
 * a sink makes - S3/GCS/Azure decision-log archive, Datadog/Splunk/Elastic app
 * logs - fails at the connector level with "dispatch failure". An initContainer
 * running the (mirrored, cert-carrying) rulebricks/curl image copies its own
 * bundle into a shared emptyDir via a file:// URL (the hardened images have no
 * shell), which is then mounted at the standard /etc/ssl/certs path.
 * SSL_CERT_FILE (set alongside, see generateVectorEnv) covers both the OpenSSL
 * and rustls code paths inside Vector.
 */
function generateVectorCaBundle(
  config: DeploymentConfig,
  images: ImageCatalog,
): Record<string, unknown> {
  const curlImage = images.image("curl", config.imageRegistry).ref;
  return {
    initContainers: [
      {
        name: "ca-certs",
        image: curlImage,
        command: [
          "curl",
          "-sSf",
          "-o",
          "/certs/ca-certificates.crt",
          "file:///etc/ssl/certs/ca-certificates.crt",
        ],
        volumeMounts: [{ name: "ca-certs", mountPath: "/certs" }],
      },
    ],
    extraVolumes: [{ name: "ca-certs", emptyDir: {} }],
    extraVolumeMounts: [
      { name: "ca-certs", mountPath: "/etc/ssl/certs", readOnly: true },
    ],
  };
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
  const env: Array<Record<string, unknown>> = [
    // CA bundle seeded by the ca-certs initContainer (generateVectorCaBundle).
    // The hardened vector image has no system CA store, so without this every
    // TLS sink (S3/GCS/Azure decision-log archive, Datadog, ...) fails with
    // "dispatch failure" and decision logs are silently dropped.
    { name: "SSL_CERT_FILE", value: "/etc/ssl/certs/ca-certificates.crt" },
    ...configMapKeys.map((key) => ({
      name: key,
      valueFrom: { configMapKeyRef: { name: "vector-kafka-env", key } },
    })),
  ];

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
  // AWS uses EKS Pod Identity: NO eks.amazonaws.com/role-arn annotation - the
  // CLI's workload-identity step creates a namespace-scoped association for this
  // SA (to a role granting both the object-storage and MSK access Vector needs).
  // Azure/GCP still annotate the SA, which is how their workload identity binds.
  const annotations: Record<string, string> = {};

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

function base64UrlJson(value: Record<string, unknown>): string {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

// Self-hosted Supabase derives the anon and service_role API keys from the JWT
// secret: each is an HS256 JWT (role: anon / service_role) signed with the secret.
// https://supabase.com/docs/guides/self-hosting/self-hosted-auth-keys
export function signSupabaseJwt(
  role: "anon" | "service_role",
  secret: string,
): string {
  const header = base64UrlJson({ alg: "HS256", typ: "JWT" });
  const payload = base64UrlJson({
    role,
    iss: "supabase",
    iat: SUPABASE_JWT_ISSUED_AT,
    exp: SUPABASE_JWT_EXPIRES_AT,
  });
  const body = `${header}.${payload}`;
  const signature = createHmac("sha256", secret).update(body).digest("base64url");
  return `${body}.${signature}`;
}

// Realtime needs SECRET_KEY_BASE (signs/encrypts its tokens) and a 16-byte
// DB_ENC_KEY (encrypts tenant DB creds). Derive both deterministically from the
// JWT secret so they are stable across redeploys with no extra state to persist,
// and anchored to the one root secret the operator already manages.
export function deriveRealtimeSecrets(jwtSecret: string): {
  secretKeyBase: string;
  dbEncKey: string;
} {
  const secretKeyBase = createHmac("sha256", jwtSecret)
    .update("supabase-realtime-secret-key-base")
    .digest("hex"); // 64 chars
  const dbEncKey = createHmac("sha256", jwtSecret)
    .update("supabase-realtime-db-enc-key")
    .digest("hex")
    .slice(0, 16); // Realtime requires exactly 16 bytes
  return { secretKeyBase, dbEncKey };
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

function isClickStackEnabled(config: DeploymentConfig): boolean {
  return config.features.observability?.clickstack?.enabled ?? true;
}

function generateClickStackValues(
  enabled: boolean,
  config: DeploymentConfig,
  storageClass: string,
  infrastructurePodLabels: Record<string, string>,
  operationalDaemonSetTolerations: Array<Record<string, string>>,
  images: ImageCatalog,
): Record<string, unknown> {
  const clickstack = config.features.observability?.clickstack;
  const telemetryRetentionDays =
    clickstack?.telemetryRetentionDays ?? 7;

  // Registry host for the clickstack images. The clickstack subchart routes
  // these through its own image helper, so the split { registry, repository }
  // shape lets global.imageRegistry + digest pinning flow through.
  const reg = config.imageRegistry || DEFAULT_IMAGE_REGISTRY;

  return {
    enabled,
    clickhouse: {
      database: "otel",
      username: "rulebricks",
      existingSecret: "",
      existingSecretKey: "admin-password",
      retentionDays: telemetryRetentionDays,
      ttl: "",
    },
    hyperdx: {
      enabled,
      image: {
        registry: reg,
        repository: IMAGE_REPOSITORIES.hyperdx,
        tag: images.image("hyperdx").tag,
        pullPolicy: "IfNotPresent",
      },
      resources: {
        requests: { cpu: "250m", memory: "512Mi" },
        limits: { cpu: "1000m", memory: "1Gi" },
      },
      ingress: {
        enabled,
        className: "traefik",
        hostname: "",
        allowedIPs: [],
      },
      podLabels: infrastructurePodLabels,
    },
    collector: {
      image: {
        registry: reg,
        repository: IMAGE_REPOSITORIES.clickstackOtelCollector,
        tag: images.image("clickstack-otel-collector").tag,
        pullPolicy: "IfNotPresent",
      },
      memoryLimitMiB: 800,
      agent: {
        enabled,
        securityContext: {
          runAsUser: 0,
          runAsGroup: 0,
        },
        resources: {
          requests: { cpu: "100m", memory: "256Mi" },
          limits: { cpu: "500m", memory: "512Mi" },
        },
        tolerations: operationalDaemonSetTolerations,
        podLabels: infrastructurePodLabels,
      },
      gateway: {
        replicas: 1,
        resources: {
          requests: { cpu: "250m", memory: "512Mi" },
          limits: { cpu: "2000m", memory: "1Gi" },
        },
        podLabels: infrastructurePodLabels,
      },
    },
    ferretdb: {
      enabled,
      image: {
        registry: reg,
        repository: IMAGE_REPOSITORIES.ferretdb,
        tag: images.image("ferretdb").tag,
        pullPolicy: "IfNotPresent",
      },
      postgresImage: {
        registry: reg,
        repository: IMAGE_REPOSITORIES.postgresDocumentdb,
        tag: images.image("postgres-documentdb").tag,
        pullPolicy: "IfNotPresent",
      },
      auth: {
        username: "hyperdx",
        password: "",
        existingSecret: "",
        existingSecretKey: "password",
      },
      persistence: {
        enabled,
        size: "10Gi",
        storageClassName: storageClass,
      },
      resources: {
        ferretdb: {
          requests: { cpu: "100m", memory: "256Mi" },
          limits: { cpu: "500m", memory: "512Mi" },
        },
        postgres: {
          requests: { cpu: "250m", memory: "512Mi" },
          limits: { cpu: "1000m", memory: "1Gi" },
        },
      },
      podLabels: infrastructurePodLabels,
      podAnnotations: {
        "cluster-autoscaler.kubernetes.io/safe-to-evict": "false",
      },
    },
  };
}

function generatePrometheusServiceAccount(
  config: DeploymentConfig,
): Record<string, unknown> {
  // AWS (AMP remote write) uses EKS Pod Identity - the association is created by
  // the CLI's workload-identity step, so no eks.amazonaws.com/role-arn annotation.
  // Azure Monitor still annotates the SA for its workload identity.
  const annotations: Record<string, string> = {};
  const remoteWrite = config.features.monitoring.remoteWrite;

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
    // oauth, and sdk (there is no "workloadIdentity" field - emitting it makes
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
 * Generates the Kafka broker config map (Kafka.spec.kafka.config for Strimzi).
 * These are the former KAFKA_CFG_* tuning env vars, as their Kafka property
 * names. Kept in lockstep with the chart's kafka.config.
 */
function generateKafkaConfig(): Record<string, string> {
  return {
    "auto.create.topics.enable": "true",
    "log.retention.hours": "24",
    "num.partitions": "12",
    "num.network.threads": "8",
    "num.io.threads": "8",
    "socket.send.buffer.bytes": "1048576",
    "socket.receive.buffer.bytes": "1048576",
    "socket.request.max.bytes": "209715200",
    // Broker-wide max record size; must exceed every per-topic max.message.bytes.
    "message.max.bytes": "2097152",
    "replica.fetch.max.bytes": "4194304",
    // Broker-wide default retention; the application topics carry tighter caps.
    "log.retention.bytes": "536870912",
    "log.segment.bytes": "1073741824",
    "num.replica.fetchers": "4",
    "queued.max.requests": "10000",
    "replica.socket.receive.buffer.bytes": "1048576",
    "log.cleaner.dedupe.buffer.size": "268435456",
    "log.cleaner.io.buffer.size": "1048576",
  };
}

/**
 * Effective Kafka topic prefix as HPS/Vector/KEDA will see it.
 * Mirrors generateAppLogging: in-cluster Kafka runs UNPREFIXED (dedicated
 * broker, and prefixing would desync chart-side consumers from producers);
 * external Kafka uses the explicit prefix, falling back to the chart default.
 */
function effectiveTopicPrefix(config: DeploymentConfig): string {
  if (!isExternalKafka(config)) {
    return "";
  }
  const ext = config.externalServices?.kafka?.external ?? {};
  return ext.topicPrefix !== undefined ? ext.topicPrefix : "com.rulebricks.";
}

/**
 * Explicit topic management for in-cluster Kafka.
 *
 * Generates the kafka.provisioning block consumed by BOTH the subchart
 * provisioning Job (creates topics) and the chart's kafka-topic-align Job
 * (idempotently converges pre-existing topics on upgrade). Topic names are
 * derived from the SAME prefix written to app.logging.kafkaTopicPrefix - the
 * chart fails the render if these ever diverge.
 *
 * Sizing policy (baseline constants, mirroring the chart defaults):
 * - solution/solution-response: SOLUTION_TOPIC_PARTITIONS (the worker-fleet
 *   concurrency CEILING; partitions can never be decreased, workers are sized
 *   separately by the cluster autoscaler). RF stays 1: RPC traffic is transient
 *   and latency-sensitive, and the HPS producer's acks=-1 would otherwise wait
 *   on full ISR replication.
 * - logs: LOGS_TOPIC_PARTITIONS (durable data feeding the Vector -> object
 *   storage pipeline).
 */
function generateKafkaTopics(
  config: DeploymentConfig,
): Array<Record<string, unknown>> {
  // External MSK IAM: the chart's kafka-topic-provision Job creates these on the
  // managed broker (through the proxy bridge), so they must be populated here -
  // MSK Serverless won't auto-create them. Other external brokers (SCRAM / Event
  // Hubs / GCP, no bridge) a plain client can reach stay customer-managed.
  if (isExternalKafka(config) && !kafkaUsesBridge(config)) {
    return [];
  }

  const prefix = effectiveTopicPrefix(config);
  const rpcTopicConfig = {
    "retention.ms": "300000",
    "segment.ms": "300000",
    "segment.bytes": "67108864",
    "retention.bytes": "67108864",
    "max.message.bytes": "2097152",
  };

  return [
    {
      name: `${prefix}solution`,
      partitions: SOLUTION_TOPIC_PARTITIONS,
      replicas: TOPIC_REPLICATION_FACTOR,
      config: rpcTopicConfig,
    },
    {
      name: `${prefix}solution-response`,
      partitions: SOLUTION_TOPIC_PARTITIONS,
      replicas: TOPIC_REPLICATION_FACTOR,
      config: rpcTopicConfig,
    },
    {
      name: `${prefix}logs`,
      partitions: LOGS_TOPIC_PARTITIONS,
      replicas: TOPIC_REPLICATION_FACTOR,
      config: {
        "retention.ms": "86400000",
        "retention.bytes": "268435456",
        "max.message.bytes": "2097152",
      },
    },
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

/**
 * Burst-pool scheduling, always on. Cluster-setup provisions a dedicated
 * worker pool labeled and tainted rulebricks.com/pool=burst (one big
 * Deallocate-parked node on Azure or an on-demand nodegroup on AWS); workers
 * tolerate the taint and SOFTLY prefer the label. On clusters without such a
 * pool both are inert, so BYO clusters schedule exactly as before - zero
 * configuration required either way.
 */
const BURST_POOL_TOLERATION: Record<string, string> = {
  key: "rulebricks.com/pool",
  operator: "Equal",
  value: "burst",
  effect: "NoSchedule",
};

const BURST_POOL_NODE_PREFERENCE: Record<string, unknown> = {
  weight: 100,
  preference: {
    matchExpressions: [
      { key: "rulebricks.com/pool", operator: "In", values: ["burst"] },
    ],
  },
};

function generateBackupValues(config: DeploymentConfig): Record<string, unknown> {
  const usesInClusterPostgres =
    config.database.type === "self-hosted" &&
    config.externalServices?.postgres?.mode !== "external";
  const enabled =
    usesInClusterPostgres && config.backup?.enabled === true;

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

/** Whether external Kafka authenticates with AWS MSK IAM (token mechanism). */
function kafkaUsesAwsIam(config: DeploymentConfig): boolean {
  if (!isExternalKafka(config)) return false;
  const ext = config.externalServices?.kafka?.external;
  return (
    ext?.preset === "aws-msk-iam" || ext?.sasl?.mechanism === "aws-iam"
  );
}

/**
 * Whether the Vector kafka-proxy bridge sidecar is required. Only AWS MSK IAM
 * needs it: Vector's kafka source can't speak token mechanisms, while Azure
 * Event Hubs and GCP both use SASL PLAIN/SCRAM that Vector handles directly.
 */
function kafkaUsesBridge(config: DeploymentConfig): boolean {
  return kafkaUsesAwsIam(config);
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
  storageClass: string,
  infrastructurePodLabels: Record<string, string>,
  coreScheduling: Record<string, unknown>,
): Record<string, unknown> {
  if (!isExternalRedis(config)) {
    // Sizing (resources, persistence size) falls back to the chart defaults;
    // only the deployment-specific storage class is set here.
    return {
      podLabels: infrastructurePodLabels,
      ...coreScheduling,
      persistence: {
        enabled: true,
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

function generateCacheObservabilityBlock(
  config: DeploymentConfig,
  infrastructurePodLabels: Record<string, string>,
): Record<string, unknown> {
  const cache = config.features.cache;
  const valkeyAdmin = cache?.valkeyAdmin;
  const redisExporter = cache?.redisExporter;
  const valkeyAdminIngressEnabled = valkeyAdmin?.exposure === "ingress";

  return {
    valkeyAdmin: {
      enabled: valkeyAdmin?.enabled ?? false,
      exposure: valkeyAdmin?.exposure ?? "internal",
      podLabels: infrastructurePodLabels,
      ingress: {
        enabled: valkeyAdminIngressEnabled,
        hostname: valkeyAdminIngressEnabled
          ? valkeyAdmin?.hostname || `valkey.${config.domain}`
          : "",
        basicAuth: {
          users: valkeyAdmin?.basicAuthUsers ?? [],
          existingSecret: valkeyAdmin?.basicAuthExistingSecret ?? "",
        },
        allowedIPs: valkeyAdmin?.allowedIPs ?? [],
      },
    },
    redisExporter: {
      enabled: redisExporter?.enabled ?? true,
      podLabels: infrastructurePodLabels,
    },
  };
}

/**
 * kafka-exporter block. Defaults ON where the chart can authenticate it with
 * no manual identity work: in-cluster Kafka and static PLAIN/SCRAM external
 * Kafka (the chart inherits kafkaSasl credentials). Opt-in otherwise -
 * notably AWS MSK IAM, where the exporter only supports IRSA (not the Pod
 * Identity associations this CLI creates; kafka_exporter#494).
 */
function generateKafkaExporterBlock(
  config: DeploymentConfig,
  infrastructurePodLabels: Record<string, string>,
): Record<string, unknown> {
  const requested = config.features.cache?.kafkaExporter?.enabled;
  const sasl = config.externalServices?.kafka?.external?.sasl;
  const canUseKafkaExporter =
    !isExternalKafka(config) ||
    (kafkaUsesDirectSasl(config) &&
      Boolean(sasl?.username || sasl?.existingSecret));
  return {
    enabled: requested ?? canUseKafkaExporter,
    podLabels: infrastructurePodLabels,
    brokers: isExternalKafka(config)
      ? config.externalServices?.kafka?.external?.brokers ?? ""
      : "",
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
 * HPS service account. When external Kafka uses MSK IAM, HPS authenticates to the
 * broker with its pod's cloud identity - under EKS Pod Identity that comes from a
 * namespace-scoped association (created by the CLI's workload-identity step for
 * the `<release>-hps` SA), NOT an eks.amazonaws.com/role-arn annotation. We only
 * CREATE the SA here so the association has a subject to bind.
 */
function generateHpsServiceAccount(
  config: DeploymentConfig,
): Record<string, unknown> {
  if (kafkaUsesBridge(config)) {
    return { create: true, annotations: {} };
  }
  return { create: false, annotations: {} };
}

/**
 * Top-level kafkaBridge block consumed by the Vector env ConfigMap. Only enabled
 * for AWS MSK IAM, where a kafka-proxy sidecar fronts the brokers for Vector.
 */
function generateKafkaBridge(
  config: DeploymentConfig,
  images: ImageCatalog,
): Record<string, unknown> {
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
    image: images.image("kafka-proxy", config.imageRegistry).ref,
    awsRoleArn: ext.identity?.awsRoleArn ?? "",
  };
}

/**
 * kafka-proxy sidecar for the Vector pod (AWS MSK IAM). Maps each upstream
 * broker to a sequential local port and authenticates with the pod's IRSA role.
 */
function generateVectorExtraContainers(
  config: DeploymentConfig,
  images: ImageCatalog,
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
      image: images.image("kafka-proxy", config.imageRegistry).ref,
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

// VRL for the Vector agent: parse JSON app/HPS log lines, lift trace_id/span_id
// for logs<->traces correlation, and flatten useful Kubernetes metadata. Kept
// in sync with charts/.../values.yaml vector-agent.customConfig.transforms.
const VECTOR_APP_LOGS_VRL = [
  'parsed, err = parse_json(to_string(.message) ?? "")',
  "if err == null && is_object(parsed) {",
  "  .log = parsed",
  "  .trace_id = parsed.trace_id",
  "  .span_id = parsed.span_id",
  '  if exists(parsed.level) { .level = to_string(parsed.level) ?? "info" }',
  "}",
  ".pod = .kubernetes.pod_name",
  ".namespace = .kubernetes.pod_namespace",
  ".container = .kubernetes.container_name",
  ".node = .kubernetes.pod_node_name",
].join("\n");

/**
 * global.tracing block (in-cluster OTel Collector -> pluggable trace backend).
 * Emits the destination-specific sub-block (elastic | otlp | azure-monitor) and
 * returns undefined when tracing is disabled so it is omitted entirely.
 */
function generateTracingGlobal(
  config: DeploymentConfig,
  images: ImageCatalog,
): Record<string, unknown> | undefined {
  const tracing = config.features.tracing;
  if (!tracing?.enabled) return undefined;

  const destination = tracing.destination ?? "elastic";
  const reg = config.imageRegistry || DEFAULT_IMAGE_REGISTRY;
  const base: Record<string, unknown> = {
    enabled: true,
    destination,
    samplingRatio: tracing.samplingRatio ?? 1,
    // RB image dict for the parent chart's otel-collector deployment. The
    // rulebricks.image helper requires image.repository and applies
    // global.imageRegistry to the host.
    collector: {
      image: {
        registry: reg,
        repository: IMAGE_REPOSITORIES.opentelemetryCollector,
        tag: images.image("opentelemetry-collector").tag,
      },
    },
  };

  if (destination === "elastic") {
    const elastic = tracing.elastic ?? {};
    const authMode = elastic.authMode ?? "secret-token";
    const elasticBlock: Record<string, unknown> = {
      endpoint: elastic.endpoint ?? "",
      authMode,
      tlsInsecureSkipVerify: false,
    };
    if (authMode === "secret-token" && elastic.secretToken) {
      elasticBlock.secretToken = elastic.secretToken;
    }
    if (authMode === "api-key" && elastic.apiKey) {
      elasticBlock.apiKey = elastic.apiKey;
    }
    return { ...base, elastic: elasticBlock };
  }

  if (destination === "otlp") {
    const otlp = tracing.otlp ?? {};
    const authMode = otlp.authMode ?? "none";
    const otlpBlock: Record<string, unknown> = {
      endpoint: otlp.endpoint ?? "",
      authMode,
      tlsInsecureSkipVerify: otlp.tlsInsecureSkipVerify ?? false,
    };
    if (authMode === "bearer" && otlp.token) otlpBlock.token = otlp.token;
    if (authMode === "api-key" && otlp.apiKey) otlpBlock.apiKey = otlp.apiKey;
    if (authMode === "header") {
      otlpBlock.headerName = otlp.headerName ?? "Authorization";
      if (otlp.headerValue) otlpBlock.headerValue = otlp.headerValue;
    }
    if (otlp.headers && Object.keys(otlp.headers).length > 0) {
      otlpBlock.headers = otlp.headers;
    }
    return { ...base, otlp: otlpBlock };
  }

  // azure-monitor
  const azure = tracing.azureMonitor ?? {};
  return {
    ...base,
    azureMonitor: { connectionString: azure.connectionString ?? "" },
  };
}

/**
 * traefik.tracing block: makes Traefik the root span and propagates the W3C
 * traceparent to backends. Empty object when tracing is disabled.
 */
function generateTraefikTracing(
  config: DeploymentConfig,
  releaseName: string,
): Record<string, unknown> {
  if (!isClickStackEnabled(config) && !config.features.tracing?.enabled) return {};
  return {
    otlp: {
      enabled: true,
      http: {
        enabled: true,
        endpoint: `http://${releaseName}-otel-collector:4318/v1/traces`,
      },
    },
  };
}

/**
 * vector-agent block: a second Vector deployment (role Agent / DaemonSet) that
 * tails all pod logs and ships them to a customer-managed Elasticsearch. Decision
 * logs are unaffected (they stay in ClickHouse via the `vector` aggregator).
 */
function generateVectorAgent(
  config: DeploymentConfig,
  podLabels: Record<string, string>,
  tolerations: Array<Record<string, string>>,
  images: ImageCatalog,
): Record<string, unknown> {
  const appLogs = config.features.logging.appLogs;
  if (!appLogs?.enabled) {
    return { enabled: false };
  }

  const destination = appLogs.destination ?? "elasticsearch";
  let sinkName = "elasticsearch";
  let sink: Record<string, unknown>;

  if (destination === "loki") {
    const loki = appLogs.loki ?? {};
    sinkName = "loki";
    sink = {
      type: "loki",
      inputs: ["app_logs"],
      endpoint: loki.endpoint,
      labels: loki.labels ?? {
        app: "rulebricks",
        namespace: "{{ namespace }}",
        pod: "{{ pod }}",
        container: "{{ container }}",
      },
      encoding: { codec: "json" },
    };
  } else if (destination === "generic") {
    const generic = appLogs.generic ?? {};
    sinkName = "generic_http";
    sink = {
      type: "http",
      inputs: ["app_logs"],
      uri: generic.endpoint,
      method: "post",
      encoding: { codec: "json" },
    };
    if (generic.authHeader) {
      sink.request = { headers: { Authorization: generic.authHeader } };
    }
  } else {
    const es = appLogs.elasticsearch ?? {};
    const authMode = es.authMode ?? "basic";
    sink = {
      type: "elasticsearch",
      inputs: ["app_logs"],
      endpoints: [es.endpoint],
      mode: "bulk",
      bulk: { index: es.index || "rulebricks-app-logs" },
      tls: { verify_certificate: es.verifyCertificate ?? true },
    };
    if (authMode === "basic") {
      sink.auth = { strategy: "basic", user: es.username, password: es.password };
    } else if (authMode === "api-key") {
      sink.request = { headers: { Authorization: `ApiKey ${es.apiKey}` } };
    }
  }

  return {
    enabled: true,
    role: "Agent",
    podLabels,
    // Follow active worker pools without tolerating shutdown, out-of-service,
    // or unreachable node taints.
    tolerations,
    resources: {
      requests: { cpu: "100m", memory: "256Mi" },
      limits: { cpu: "500m", memory: "512Mi" },
    },
    // The agent ships logs to customer backends over TLS and needs the same
    // CA-bundle seeding as the decision-log aggregator (hardened image has no
    // system CA store).
    ...generateVectorCaBundle(config, images),
    customConfig: {
      data_dir: "/vector-data-dir",
      sources: {
        kubernetes_logs: {
          type: "kubernetes_logs",
          // Skip both Vector deployments: the aggregator
          // (app.kubernetes.io/name=vector) re-emits decision logs on stdout
          // (those belong in ClickHouse, not Elasticsearch) and the agent
          // itself (vector-agent) to avoid a self-scrape loop.
          extra_label_selector: "app.kubernetes.io/name notin (vector,vector-agent)",
        },
      },
      transforms: {
        app_logs: {
          type: "remap",
          inputs: ["kubernetes_logs"],
          source: VECTOR_APP_LOGS_VRL,
        },
      },
      sinks: { [sinkName]: sink },
    },
  };
}

/**
 * Builds Helm values from the deployment configuration.
 */
export function buildHelmValues(
  config: DeploymentConfig,
  options: GenerateOptions = {},
): Record<string, unknown> {
  if (
    config.database.type === "self-hosted" &&
    !config.database.supabaseJwtSecret
  ) {
    throw new Error(
      "Self-hosted Supabase is missing a JWT secret. Run `rulebricks configure <name>` to regenerate deployment credentials, or set database.supabaseJwtSecret in config.yaml.",
    );
  }
  if (config.features.ai.enabled && !config.features.ai.openaiApiKey) {
    throw new Error(
      "AI features are enabled but the OpenAI API key is missing. Run `rulebricks configure <name>` and enter your OpenAI API key, or disable AI features in config.yaml.",
    );
  }

  const { tlsEnabled = true, secretMode = "inline" } = options;
  // Infrastructure image tags from the chart's images/manifest.yaml. The async
  // generate* entry points resolve the live catalog for the target chart
  // version; direct (sync) callers fall back to the bundled snapshot.
  const images = options.images ?? bundledImageCatalog();
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
  // Workers always tolerate + softly prefer the optional burst pool
  // (rulebricks.com/pool=burst). The preference is soft, so clusters without a
  // burst pool schedule workers on ordinary capacity exactly as before.
  const workerTolerations = [
    ...(architectureTolerations ?? []),
    BURST_POOL_TOLERATION,
  ];
  const operationalDaemonSetTolerations = workerTolerations;
  const workerScheduling = generateScheduling(workerTolerations, {
    ...generateWorkerPodAntiAffinity(),
    nodeAffinity: {
      preferredDuringSchedulingIgnoredDuringExecution: [
        BURST_POOL_NODE_PREFERENCE,
      ],
    },
  });
  const infrastructurePodLabels = {
    "rulebricks.com/workload-group": "infrastructure",
  };
  const applicationPodLabels = {
    "rulebricks.com/workload-group": "application",
  };
  const productVersion = config.version;

  // Scheduling priority tiers. The chart creates release-scoped
  // PriorityClasses (<release>-critical / <release>-burst); stateful
  // infrastructure references the critical class so it can always preempt
  // burst workers to reschedule, and workers reference the burst class so
  // they are strictly the first preemption victims. Subchart values cannot
  // template release names, so the CLI emits them as literals.
  const releaseName = getReleaseName(config.name);
  const criticalPriorityClass = `${releaseName}-critical`;
  const burstPriorityClass = `${releaseName}-burst`;
  // Subcharts that don't honor global.imagePullSecrets (keda, strimzi, traefik,
  // vector) need the pull secret on their own key so their pods can pull the
  // private docker.io/rulebricks/* images from index.docker.io.
  const rulebricksPullSecret = [{ name: `${releaseName}-regcred` }];
  // Registry host for every image. Empty config.imageRegistry => docker.io. When
  // set, the host is rewritten into global.imageRegistry (which kube-prometheus-stack
  // and our subcharts honor) and into each of the six Tier-2 charts' own image
  // keys below, always keeping the rulebricks/<name> path.
  const reg = config.imageRegistry || DEFAULT_IMAGE_REGISTRY;
  const clickStackEnabled = isClickStackEnabled(config);
  const clickStackConfig = config.features.observability?.clickstack;
  const clickHouseStorageSize =
    clickStackConfig?.clickHouseStorageSize ?? "100Gi";
  // Distributed tracing (self-hosted only). Lives under global so the
  // rulebricks subchart deployments can read it; the collector + traefik are
  // wired below from the same source.
  const tracingGlobal = clickStackEnabled
    ? undefined
    : generateTracingGlobal(config, images);
  // Never let the cluster-autoscaler evict single-replica stateful pods
  // during node scale-down; an evicted broker/db stalls the whole pipeline.
  const safeToEvictAnnotations = {
    "cluster-autoscaler.kubernetes.io/safe-to-evict": "false",
  };

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
      : (() => {
          const jwtSecret = config.database.supabaseJwtSecret || "";
          return {
            jwtSecret: jwtSecret || undefined,
            anonKey: jwtSecret ? signSupabaseJwt("anon", jwtSecret) : undefined,
            serviceKey: jwtSecret
              ? signSupabaseJwt("service_role", jwtSecret)
              : undefined,
          };
        })();

  // Always emit email configuration so auth pods receive template/subject env
  // vars regardless of Helm merge order. Custom values take precedence over
  // built-in defaults when explicitly enabled.
  const customEmails = config.features.customEmails;
  if (
    customEmails?.enabled &&
    customEmails.subjects &&
    customEmails.templates
  ) {
    supabaseGlobalConfig.emails = {
      subjects: {
        invite: customEmails.subjects.invite,
        confirmation: customEmails.subjects.confirmation,
        recovery: customEmails.subjects.recovery,
        emailChange: customEmails.subjects.emailChange,
      },
      templates: {
        invite: customEmails.templates.invite,
        confirmation: customEmails.templates.confirmation,
        recovery: customEmails.templates.recovery,
        emailChange: customEmails.templates.emailChange,
      },
    };
  } else {
    supabaseGlobalConfig.emails = {
      subjects: { ...DEFAULT_SUPABASE_EMAILS.subjects },
      templates: { ...DEFAULT_SUPABASE_EMAILS.templates },
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
      // Pull secret for the private docker.io/rulebricks/* images. References the
      // license registry secret <release>-regcred (index.docker.io, authed by the
      // license PAT). kube-prometheus-stack + cert-manager honor this global value;
      // keda, traefik, vector and the strimzi operator each get the same secret on
      // their own key below.
      imagePullSecrets: [{ name: `${releaseName}-regcred` }],
      // Single registry-host override (empty => docker.io/rulebricks/*). Honored by
      // kube-prometheus-stack and our subcharts; the CLI also rewrites the host into
      // the other Tier-2 charts' native image keys below.
      ...(config.imageRegistry ? { imageRegistry: config.imageRegistry } : {}),
      // Generated name->sha256 digest map from the chart image manifest (empty
      // until the helm repo's mirror pipeline writes digests back). When a name
      // is present the chart image helper pins @sha256 instead of :tag.
      imageDigests: images.digests(),
      ...(productVersion && SEMVER_PATTERN.test(productVersion)
        ? { version: productVersion }
        : {}),
      externalDnsEnabled,

      // Scheduling priority tiers (the chart renders release-scoped
      // <release>-critical and <release>-burst PriorityClasses).
      priorityClasses: { enabled: true },
      clickstack: {
        enabled: clickStackEnabled,
      },

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

      // Distributed tracing (omitted entirely when disabled).
      ...(tracingGlobal ? { tracing: tracingGlobal } : {}),
    },

    clickstack: generateClickStackValues(
      clickStackEnabled,
      config,
      storageClass,
      infrastructurePodLabels,
      operationalDaemonSetTolerations,
      images,
    ),

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
        worker: {
          path: "/metrics",
          port: 3000,
        },
      },
      app: {
        image: {
          // Split shape: the rulebricks-chart.image helper applies
          // global.imageRegistry to the host + digest pinning. The host NEVER
          // goes in repository.
          registry: reg,
          repository: IMAGE_REPOSITORIES.app,
          pullPolicy: "IfNotPresent",
        },
        // Replica count and resources fall back to the chart defaults.
        podLabels: infrastructurePodLabels,
        ...coreScheduling,

        // Logging configuration (in-cluster auto-discovery or external Kafka)
        logging: generateAppLogging(config),
      },

      // HPS (High Performance Server)
      hps: {
        enabled: true,
        image: {
          // Split shape (see app.image): host comes from global.imageRegistry via
          // the rulebricks-chart.image helper, never baked into repository.
          registry: reg,
          repository: IMAGE_REPOSITORIES.hps,
          pullPolicy: "Always",
        },
        // Replica count and resources fall back to the chart defaults.
        podLabels: applicationPodLabels,
        ...coreScheduling,
        // Gather-plane autoscaling: HPS parses every chunk response, so its
        // capacity scales with request rate (load testing showed a fixed
        // gather plane plateaus throughput while workers idle). Conservative
        // one-pod-at-a-time scaling - each scale event rebalances the
        // response consumer group and can time out in-flight requests. Only the
        // enable flag is set here; min/max and thresholds use the chart
        // defaults.
        keda: {
          enabled: true,
        },
        // Warm the hps/worker images onto active worker-capable nodes so burst
        // scale-outs skip the image pull without targeting shutdown nodes.
        imagePrepull: {
          enabled: true,
          tolerations: operationalDaemonSetTolerations,
        },
        extraEnv: [
          // FLOW_CHUNK_MAX_ITEMS is the #1 throughput dial. Each chunk is one
          // Kafka round-trip (gather -> solution -> worker -> solution-response
          // -> gather), so throughput ~= (broker messages/sec) x (payloads per
          // message). Bigger chunks = fewer messages per solution = less broker
          // and coordination overhead. Benchmarks: 10 -> 50 gave +27%, and on
          // small payloads 100 -> 1000 gave another ~1.6x (22k -> 35k sol/s),
          // until the bottleneck moved off the broker onto worker CPU.
          // 500 keeps typical bulk requests to 1-2 messages. The byte bound
          // (CHUNK_MAX_BYTES, default 256 KiB in HPS) caps message size
          // regardless, so large payloads stay under Kafka's 2 MiB
          // max.message.bytes. High-throughput, small-payload deployments can
          // raise this much higher (and CHUNK_MAX_BYTES with it); the only costs
          // are per-request latency (one worker processes a whole chunk) and the
          // 2 MiB cap on the larger response message (avg output x chunk size
          // must stay < 2 MiB, so lower this for output-heavy flows).
          { name: "FLOW_CHUNK_MAX_ITEMS", value: "500" },
        ],

        // Service account (annotated with the MSK IAM role for external Kafka)
        serviceAccount: generateHpsServiceAccount(config),

        // HPS Workers with KEDA autoscaling
        workers: {
          enabled: true,
          // Workers consume the solution topic directly, so under external MSK
          // IAM they need their own cloud identity - not the shared/default SA.
          // Same rule as HPS: a dedicated `<release>-hps-worker` SA (no role-arn
          // annotation) that the CLI's workload-identity step binds to the Kafka
          // role via Pod Identity.
          serviceAccount: generateHpsServiceAccount(config),
          // Partition count of the solution request topic (also exported to
          // HPS as MAX_WORKERS). Must match kafka.provisioning above; it is
          // the fleet-concurrency ceiling, NOT a worker count. Replica count
          // and resources fall back to the chart defaults.
          solutionPartitions: SOLUTION_TOPIC_PARTITIONS,
          keda: {
            enabled: true,
            // Poll fast so bursts are detected within seconds; the chart's
            // ScaledObject defaults add exponential scale-up (double every
            // 15s) and smooth scale-down (5-min window, -25%/min) behavior.
            // min/max replica counts fall back to the chart defaults.
            pollingInterval: 5,
            cooldownPeriod: 300,
            // Lag is measured in MESSAGES; with chunked bulk dispatch each
            // message is a bounded unit of work (~50-150ms), so 50 messages
            // approximates 5-8s of backlog for a single worker - one replica
            // is added per ~5s of fleet backlog, biasing toward early
            // scale-out for bursty traffic.
            lagThreshold: 50,
            cpuThreshold: 25,
          },
          podLabels: applicationPodLabels,
          // Burst tier: first preemption victims, so critical infrastructure
          // can always reschedule during an aggressive scale-out.
          priorityClassName: burstPriorityClass,
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
        storageClass,
        infrastructurePodLabels,
        coreScheduling,
      ),
      cache: generateCacheObservabilityBlock(config, infrastructurePodLabels),
      kafkaExporter: generateKafkaExporterBlock(config, infrastructurePodLabels),
    },

    // =============================================================================
    // KAFKA (Message Queue)
    // =============================================================================
    kafka: {
      enabled: !isExternalKafka(config),
      // Apache Kafka version, derived from the strimzi-kafka image tag in the
      // chart manifest so it always matches the broker image the operator ships.
      version: images.kafkaVersion(),
      // Single combined controller+broker node (KRaft, no ZooKeeper).
      replicas: TOPIC_REPLICATION_FACTOR,
      storage: {
        size: "20Gi",
        class: storageClass,
      },
      // Critical tier: the broker must always be able to preempt burst workers.
      priorityClassName: criticalPriorityClass,
      config: generateKafkaConfig(),
      jvm: {
        xms: "1g",
        xmx: "1g",
        extraOpts: {
          UseZGC: "true",
          AlwaysPreTouch: "true",
          MaxDirectMemorySize: "256M",
        },
      },
      metrics: {
        enabled: true,
        serviceMonitor: { enabled: true },
      },
      // Topics, reconciled by the Strimzi Topic Operator (KafkaTopic CRs) for the
      // in-cluster broker, or created by the kafka-topic-provision Job for an
      // external MSK IAM broker.
      topics: generateKafkaTopics(config),
      // When false, the chart never creates topics on an external broker - the
      // operator manages them (and the workload role needs no CreateTopic).
      provisioning: {
        enabled:
          config.externalServices?.kafka?.external?.provisionTopics ?? true,
      },
    },

    // Strimzi operator: pull secret so the operator pod pulls the private
    // rulebricks/* image from index.docker.io.
    "strimzi-kafka-operator": {
      image: { imagePullSecrets: rulebricksPullSecret },
    },

    // =============================================================================
    // VECTOR KAFKA BRIDGE (AWS MSK IAM token auth)
    // =============================================================================
    kafkaBridge: generateKafkaBridge(config, images),

    clickhouse: {
      enabled: true,
      // Critical tier: single replica must preempt burst workers to
      // reschedule; never autoscaler-evicted on scale-down.
      priorityClassName: criticalPriorityClass,
      podAnnotations: safeToEvictAnnotations,
      auth: {
        username: "rulebricks",
        password: "",
        existingSecret: '{{ printf "%s-clickhouse-credentials" .Release.Name }}',
        existingSecretKey: "admin-password",
      },
      persistence: clickStackEnabled
        ? {
            enabled: true,
            storageClass: storageClass,
            size: clickHouseStorageSize,
          }
        : { enabled: false },
      resources: clickStackEnabled
        ? {
            requests: { cpu: "1000m", memory: "4Gi" },
            limits: { cpu: "4", memory: "12Gi" },
          }
        : {
            requests: { cpu: "500m", memory: "2Gi" },
            limits: { cpu: "2", memory: "6Gi" },
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
        maxMemoryUsage: 4294967296,
        maxThreads: 4,
        maxExecutionTime: 120,
        maxRowsToRead: 50000000,
        readOverflowMode: "break",
      },
      otelQueryLimits: {
        maxMemoryUsage: 4294967296,
        maxThreads: 8,
        maxExecutionTime: 120,
      },
      otelDatabase: "otel",
      // config.d / users.d / the decision-log view are rendered by the parent
      // chart's clickhouse templates (no longer passed as Bitnami subchart values).
    },

    // =============================================================================
    // TRAEFIK (Ingress Controller)
    // =============================================================================
    traefik: {
      enabled: true,
      // traefik has no global.imageRegistry path: set registry + repository
      // directly (host = reg, rulebricks/* path).
      image: {
        registry: reg,
        repository: IMAGE_REPOSITORIES.traefik,
      },
      deployment: {
        imagePullSecrets: rulebricksPullSecret,
      },
      ingressClass: {
        name: "traefik",
      },
      ...coreScheduling,
      autoscaling: {
        enabled: true,
        minReplicas: TRAEFIK_MIN_REPLICAS,
        maxReplicas: TRAEFIK_MAX_REPLICAS,
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
          // traefik 41.x moved per-entrypoint TLS under ports.<name>.http.tls
          // (the old ports.<name>.tls location is rejected by the chart schema).
          http: {
            tls: {
              enabled: tlsEnabled,
            },
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
      // OTLP tracing: ingress becomes the root span and propagates traceparent
      // to backends. Empty object when tracing is disabled.
      tracing: generateTraefikTracing(config, releaseName),
      persistence: {
        enabled: false,
      },
    },

    // =============================================================================
    // KEDA (Autoscaling)
    // =============================================================================
    keda: {
      enabled: true,
      imagePullSecrets: rulebricksPullSecret,
      // keda reads global.image.registry (NOT global.imageRegistry) for the host;
      // set it plus the rulebricks/* repositories for all three sub-images.
      global: {
        image: {
          registry: reg,
        },
      },
      image: {
        keda: {
          registry: reg,
          repository: IMAGE_REPOSITORIES.keda,
        },
        metricsApiServer: {
          registry: reg,
          repository: IMAGE_REPOSITORIES.kedaMetricsApiServer,
        },
        webhooks: {
          registry: reg,
          repository: IMAGE_REPOSITORIES.kedaAdmissionWebhooks,
        },
      },
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
      // CRDs managed in parent chart (cert-manager v1.15+ uses crds.enabled,
      // not the deprecated installCRDs flag).
      crds: { enabled: false },
      // cert-manager prepends image.registry to image.repository, so set both per
      // component (host = reg, rulebricks/cert-manager-* path).
      image: {
        registry: reg,
        repository: IMAGE_REPOSITORIES.certManagerController,
      },
      ...coreScheduling,
      webhook: {
        image: {
          registry: reg,
          repository: IMAGE_REPOSITORIES.certManagerWebhook,
        },
        ...coreScheduling,
      },
      cainjector: {
        image: {
          registry: reg,
          repository: IMAGE_REPOSITORIES.certManagerCainjector,
        },
        ...coreScheduling,
      },
      startupapicheck: {
        image: {
          registry: reg,
          repository: IMAGE_REPOSITORIES.certManagerStartupapicheck,
        },
      },
      acmesolver: {
        image: {
          registry: reg,
          repository: IMAGE_REPOSITORIES.certManagerAcmesolver,
        },
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
      // vector's image.repository is the FULL path including host (no separate
      // registry field), so the reg host is prefixed here.
      image: {
        repository: `${reg}/${IMAGE_REPOSITORIES.vector}`,
        pullSecrets: rulebricksPullSecret,
      },
      role: "Stateless-Aggregator",
      // Replica count and resources fall back to the chart defaults.
      ...coreScheduling,
      serviceAccount: generateVectorServiceAccount(config),
      podLabels: generateVectorPodLabels(config),
      ...(generateVectorExtraContainers(config, images)
        ? { extraContainers: generateVectorExtraContainers(config, images) }
        : {}),
      // Seed the CA trust bundle the hardened image lacks; without it the
      // decision-log object-storage sink cannot complete a TLS handshake.
      ...generateVectorCaBundle(config, images),
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
    // VECTOR AGENT (Application / container logs -> Elasticsearch)
    // =============================================================================
    "vector-agent": clickStackEnabled
      ? { enabled: false }
      : {
          ...generateVectorAgent(
            config,
            infrastructurePodLabels,
            operationalDaemonSetTolerations,
            images,
          ),
          // Full-path repository (see vector above) + pull secret.
          image: {
            repository: `${reg}/${IMAGE_REPOSITORIES.vector}`,
            pullSecrets: rulebricksPullSecret,
          },
        },

    // =============================================================================
    // SUPABASE (Self-hosted Database)
    // =============================================================================
    supabase: {
      enabled: config.database.type === "self-hosted",
      ...(config.database.type === "self-hosted"
        ? (() => {
            // External managed Postgres (AWS RDS / Azure Flexible Server): the
            // self-hosted Supabase services run against it instead of the
            // bundled in-cluster database.
            const pgExt =
              config.externalServices?.postgres?.mode === "external"
                ? config.externalServices?.postgres?.external
                : undefined;
            return {
              secret: {
                db: {
                  username: "postgres",
                  // Shared service-role password (authenticator / auth_admin /
                  // replication_admin). With an external DB the bootstrap hook
                  // sets the roles to this same value.
                  password: config.database.supabaseDbPassword,
                  database: pgExt?.database || "postgres",
                },
                dashboard: {
                  username: config.database.supabaseDashboardUser || "supabase",
                  password: config.database.supabaseDashboardPass,
                },
                jwt: {
                  secret: config.database.supabaseJwtSecret,
                },
                // SECRET_KEY_BASE / DB_ENC_KEY, derived from the JWT secret
                // (stable across redeploys). The chart no longer ships defaults.
                realtime: deriveRealtimeSecrets(
                  config.database.supabaseJwtSecret || "",
                ),
              },
              ...(pgExt
                ? {
                    // One switch: enabling externalDatabase disables the bundled
                    // Postgres and runs the bootstrap hook to initialize the
                    // managed instance. db.enabled=false is explicit so chart
                    // schema rules keyed off it hold.
                    db: { enabled: false },
                    externalDatabase: {
                      enabled: true,
                      host: pgExt.host ?? "",
                      port: pgExt.port ?? 5432,
                      bootstrap: {
                        enabled: pgExt.bootstrap?.enabled ?? true,
                        masterUsername:
                          pgExt.bootstrap?.masterUsername ?? "postgres",
                        masterPassword: pgExt.bootstrap?.masterPassword ?? "",
                        appRole: pgExt.bootstrap?.appRole ?? "postgres",
                      },
                    },
                  }
                : {
                    db: {
                      // Explicit so chart schema rules that key off
                      // supabase.db.enabled (e.g. Database Backup Storage
                      // Validation) hold without relying on subchart-default
                      // coalescing.
                      enabled: true,
                      image: {
                        // Split shape: the supabase.image helper applies
                        // global.imageRegistry to the host. Host never in repository.
                        registry: reg,
                        repository: SUPABASE_POSTGRES_IMAGE_REPOSITORY,
                        tag: images.image("supabase-postgres").tag,
                        pullPolicy: "IfNotPresent",
                      },
                      podLabels: infrastructurePodLabels,
                      // Critical tier: the primary datastore must preempt burst
                      // workers to reschedule; never autoscaler-evicted.
                      // Resources and persistence size fall back to chart
                      // defaults.
                      priorityClassName: criticalPriorityClass,
                      podAnnotations: safeToEvictAnnotations,
                      ...coreScheduling,
                      persistence: {
                        enabled: true,
                        storageClassName: storageClass,
                      },
                    },
                  }),
              auth: {
                // Explicit public URLs so GoTrue never falls back to the
                // in-cluster Kong service name when global.domain propagation
                // is lost (e.g. after manual patching or partial upgrades).
                siteUrl: `https://${config.domain}`,
                externalUrl: `https://supabase.${config.domain}`,
                ...coreScheduling,
                // Managed Postgres (AWS RDS PG15+, rds.force_ssl=1 by default)
                // rejects non-SSL connections with "no pg_hba.conf entry ...
                // no encryption", but the chart defaults DB_SSL to disable.
                // The bootstrap job already hardcodes sslmode=require; these
                // overrides bring the runtime services in line with it.
                ...(pgExt ? { environment: { DB_SSL: "require" } } : {}),
              },
              rest: {
                ...coreScheduling,
                ...(pgExt ? { environment: { DB_SSL: "require" } } : {}),
              },
              realtime: {
                ...coreScheduling,
                // Realtime (v2.73.0+) takes a boolean-as-string, not sslmode.
                ...(pgExt ? { environment: { DB_SSL: "true" } } : {}),
              },
              meta: {
                ...coreScheduling,
                ...(pgExt ? { environment: { DB_SSL: "require" } } : {}),
              },
              kong: {
                ...coreScheduling,
                ingress: {
                  enabled: true,
                  className: "traefik",
                  // The supabase subchart's kong ingress does NOT emit Traefik's
                  // router.entrypoints/router.tls annotations the way the app
                  // ingress does; without them Traefik only builds a web (HTTP)
                  // router, so https://supabase.<domain> 404s and the app can't
                  // reach Supabase. Inject them via the subchart's annotations
                  // passthrough (kong/ingress.yaml ranges over these), matching
                  // charts/rulebricks/templates/ingress.yaml.
                  annotations: {
                    "traefik.ingress.kubernetes.io/router.entrypoints":
                      tlsEnabled ? "websecure" : "web",
                    "traefik.ingress.kubernetes.io/router.tls": tlsEnabled
                      ? "true"
                      : "false",
                  },
                },
              },
              studio: {
                ...coreScheduling,
              },
            };
          })()
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
      // kube-prometheus-stack honors the parent global.imageRegistry for the host
      // automatically; the CLI sets the rulebricks/* repository defaults (and the
      // reg host explicitly) for every sub-image so a bare helm install also pulls
      // rulebricks/*.
      alertmanager: {
        enabled: false,
        alertmanagerSpec: {
          image: {
            registry: reg,
            repository: IMAGE_REPOSITORIES.alertmanager,
          },
        },
      },
      prometheusOperator: {
        image: {
          registry: reg,
          repository: IMAGE_REPOSITORIES.prometheusOperator,
        },
        prometheusConfigReloader: {
          image: {
            registry: reg,
            repository: IMAGE_REPOSITORIES.prometheusConfigReloader,
          },
        },
        admissionWebhooks: {
          patch: {
            image: {
              registry: reg,
              repository: IMAGE_REPOSITORIES.kubeWebhookCertgen,
            },
          },
        },
      },
      "kube-state-metrics": {
        image: {
          registry: reg,
          repository: IMAGE_REPOSITORIES.kubeStateMetrics,
        },
      },
      "prometheus-node-exporter": {
        image: {
          registry: reg,
          repository: IMAGE_REPOSITORIES.nodeExporter,
        },
      },
      grafana: {
        enabled: useLocalGrafana,
        image: {
          registry: reg,
          repository: IMAGE_REPOSITORIES.grafana,
        },
        // Dashboard sidecar imports the provisioned Rulebricks dashboards
        // (ConfigMaps labeled grafana_dashboard="1") when in-cluster Grafana
        // is enabled.
        sidecar: {
          image: {
            registry: reg,
            repository: IMAGE_REPOSITORIES.k8sSidecar,
          },
          ...(useLocalGrafana
            ? {
                dashboards: {
                  enabled: true,
                  label: "grafana_dashboard",
                  labelValue: "1",
                  searchNamespace: "ALL",
                  folderAnnotation: "grafana_folder",
                  provider: { foldersFromFilesStructure: true },
                },
              }
            : {}),
        },
      },
      prometheus: {
        enabled: true,
        serviceAccount: generatePrometheusServiceAccount(config),
        prometheusSpec: {
          retention: PROMETHEUS_RETENTION,
          image: {
            registry: reg,
            repository: IMAGE_REPOSITORIES.prometheus,
          },
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
                    storage: PROMETHEUS_STORAGE_SIZE,
                  },
                },
              },
            },
          },
          remoteWrite: [
            ...(clickStackEnabled ? [] : generateRemoteWriteSpec(config)),
          ],
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
          // external-dns has NO image.registry field: image.repository is the
          // FULL path including host (reg prefix + rulebricks/external-dns).
          image: {
            repository: `${reg}/${IMAGE_REPOSITORIES.externalDns}`,
          },
          // external-dns 1.21+ idiom: provider is an object ({name: ...}).
          provider: { name: getExternalDnsProvider(config.dns.provider) },
          domainFilters: [config.domain],
          sources: ["ingress", "service"],
          policy: "upsert-only",
        }
      : {
          enabled: false,
        },
  };

  // The managed-Postgres migration hook (templates/migration-job.yaml) reads the
  // DB host/port from .Values.migrations.externalDb; a SEPARATE seam from
  // supabase.externalDatabase.*; and its `pg_isready -h $DB_HOST` loop hangs
  // forever (empty host) if it is unset. Wire it for external Postgres. We only
  // set host/port: DB_PASSWORD falls back to the <release>-supabase-db secret and
  // DB_USER/DB_NAME default to "postgres", which match deploymentSecretNames()
  // and the bootstrap app role.
  const migrationsPgExt =
    config.database.type === "self-hosted" &&
    config.externalServices?.postgres?.mode === "external"
      ? config.externalServices.postgres.external
      : undefined;
  if (migrationsPgExt) {
    values.migrations = {
      externalDb: {
        host: migrationsPgExt.host ?? "",
        // Chart schema requires a string here (the template quotes it).
        port: String(migrationsPgExt.port ?? 5432),
        // Run migrations as the master/app_role. The bootstrap hook creates the
        // service login roles (authenticator, supabase_auth_admin, …) with the
        // service password but deliberately does NOT change the master's
        // password (bootstrap.sql runs "as the master user (named postgres)").
        // So the migrate hook must authenticate with the MASTER credential, not
        // the service password in <release>-supabase-db (that would 401). Point
        // DB_PASSWORD at the bootstrap Secret's master-password.
        existingSecret: deploymentSecretNames(config).dbBootstrap,
        existingSecretKey: "master-password",
      },
    };
  }

  // In k8s secret mode, the CLI creates Kubernetes Secrets and the chart reads
  // them by reference. Point the chart's secretRef seams at those Secrets and
  // strip every plaintext secret out of the generated values.
  if (secretMode === "k8s") {
    return redactSecretsToRefs(values, config);
  }

  return values;
}

/**
 * Rewrites generated values for k8s secret mode: sets the chart's *.secretRef
 * seams to the CLI-created Secret names and removes inline plaintext secrets so
 * none are persisted to values.yaml or the Helm release.
 */
export function redactSecretsToRefs(
  values: Record<string, unknown>,
  config: DeploymentConfig,
): Record<string, unknown> {
  const names = deploymentSecretNames(config);
  const global = (values.global ?? {}) as Record<string, any>;
  const supabase = (values.supabase ?? {}) as Record<string, any>;
  const pgExt =
    config.database.type === "self-hosted" &&
    config.externalServices?.postgres?.mode === "external"
      ? config.externalServices.postgres.external
      : undefined;

  // App-level consolidated secret: one secretRef supplies every app cred.
  global.secrets = { ...(global.secrets ?? {}), secretRef: names.app };
  // Strip inline app/global secrets (non-secret config like host/from/url stays).
  if (global.smtp) {
    delete global.smtp.user;
    delete global.smtp.pass;
  }
  if (global.supabase) {
    delete global.supabase.jwtSecret;
    // NOTE: anonKey is intentionally NOT stripped. It is the *public* Supabase
    // key that app-configmap.yaml embeds into the Next.js client bundle
    // (SUPABASE_PUBLIC_KEY / NEXT_PUBLIC_SUPABASE_PUBLIC_KEY). That ConfigMap
    // reads global.supabase.anonKey at TEMPLATE time and there is no secretRef
    // seam for it, so stripping it leaves the browser client with an empty key.
    // It is a public token (safe in a ConfigMap by design) and never appears in
    // the k8s-mode secret-leak checks.
    delete global.supabase.serviceKey;
    delete global.supabase.accessToken;
  }
  if (global.ai) delete global.ai.openaiApiKey;
  if (global.sso) {
    delete global.sso.clientId;
    delete global.sso.clientSecret;
  }
  // NOTE: licenseKey is intentionally NOT stripped. The (standard) chart builds
  // the image-pull secret <release>-regcred from inline global.licenseKey at
  // TEMPLATE time (templates/registry-secret.yaml -> imagePullSecret helper). A
  // Kubernetes imagePullSecret cannot be sourced from a secretRef, so the chart
  // has no k8s-mode seam for it; stripping it makes the chart fall back to the
  // "evaluation" placeholder -> dckr_pat_evaluation -> 401 on every private
  // rulebricks/* image. Standalone chart users set global.licenseKey in their own
  // values for exactly this reason; the CLI must do the same to stay compatible
  // with the unmodified chart. It is a Docker Hub read-only PAT and already lives
  // in the deployment's config.yaml, so keeping it inline adds no new exposure.

  // Supabase subchart: replace each inline secret block with a secretRef.
  if (supabase.secret) {
    const dbSecret: Record<string, unknown> = { secretRef: names.db };
    if (pgExt) {
      dbSecret.secretRefKey = {
        host: "host",
        port: "port",
        username: "username",
        password: "password",
        database: "database",
      };
    }
    supabase.secret = {
      db: dbSecret,
      jwt: { secretRef: names.jwt },
      dashboard: { secretRef: names.dashboard },
      realtime: { secretRef: names.realtime },
      // Supabase auth (GoTrue) SMTP; only when SMTP creds are configured;
      // otherwise the global.smtp we just stripped would leave it empty.
      ...(config.smtp?.user || config.smtp?.pass
        ? { smtp: { secretRef: names.smtp } }
        : {}),
    };
  }

  if (pgExt && supabase.externalDatabase) {
    supabase.externalDatabase = {
      ...supabase.externalDatabase,
      // New charts read host/port/user/pass/db from this single Secret. Keep
      // externalDatabase.host/port above for older charts that do not yet support
      // host/port secret keys.
      secretRef: names.db,
      secretRefKey: {
        host: "host",
        port: "port",
        username: "username",
        password: "password",
        database: "database",
      },
      bootstrap: {
        ...(supabase.externalDatabase.bootstrap ?? {}),
        secretRef: names.dbBootstrap,
        // Master credentials move into the hook Secret in k8s mode.
        masterUsername: undefined,
        masterPassword: undefined,
      },
    };
  }

  values.global = global;
  values.supabase = supabase;
  return values;
}

/**
 * Resolves the image catalog for a generate call: an explicitly provided
 * catalog wins, otherwise the live manifest for options.chartVersion (or the
 * latest chart) is fetched — falling back to the bundled snapshot only when
 * fully offline.
 */
async function resolveGenerateImages(
  config: DeploymentConfig,
  options: GenerateOptions,
): Promise<ImageCatalog> {
  if (options.images) return options.images;
  return resolveImageCatalog(options.chartVersion ?? config.chartVersion);
}

/**
 * Generates Helm values from the deployment configuration
 */
export async function generateHelmValues(
  config: DeploymentConfig,
  options: GenerateOptions = {},
): Promise<void> {
  const images = await resolveGenerateImages(config, options);
  const values = buildHelmValues(config, { ...options, images });
  // Last-line guardrail: never write/deploy values the chart would reject.
  assertValidHelmValues(values);
  await saveHelmValues(config.name, values);
}

/**
 * Builds edit-preserving values for a deployment update: fresh generation
 * deep-merged over the existing values file, so manual values.yaml edits
 * outside generated keys survive while config-driven values always win. In
 * k8s secret mode the result is re-redacted so inline secrets carried over
 * from older values files never survive the merge. Falls back to plain
 * generation when no values file exists yet.
 */
export function buildDeployValues(
  existing: Record<string, unknown> | null,
  config: DeploymentConfig,
  options: GenerateOptions = {},
): Record<string, unknown> {
  const generated = buildHelmValues(config, options);
  if (!existing) return generated;
  const merged = mergeHelmValues(existing, generated);
  // Match buildHelmValues' default secret mode so an inline generation is
  // never immediately scrubbed back to refs.
  const secretMode = options.secretMode ?? "inline";
  return secretMode === "k8s" ? redactSecretsToRefs(merged, config) : merged;
}

/**
 * Builds the values a configure run writes; same merge strategy as deploy,
 * always in k8s secret mode.
 */
export function buildConfigureValues(
  existing: Record<string, unknown>,
  config: DeploymentConfig,
  options: Omit<GenerateOptions, "secretMode"> = {},
): Record<string, unknown> {
  return buildDeployValues(existing, config, { ...options, secretMode: "k8s" });
}

/**
 * Generates and saves values for a deploy while preserving existing
 * values.yaml edits (manual or via `rulebricks configure`); see
 * buildDeployValues for the merge semantics.
 */
export async function generateHelmValuesPreservingEdits(
  config: DeploymentConfig,
  options: GenerateOptions = {},
): Promise<void> {
  const images = await resolveGenerateImages(config, options);
  const existing = await loadHelmValues(config.name);
  const values = buildDeployValues(existing, config, { ...options, images });
  // Last-line guardrail: never write/deploy values the chart would reject.
  assertValidHelmValues(values);
  await saveHelmValues(config.name, values);
}

/**
 * Reads a deployment's current TLS state from its values so regeneration
 * preserves it exactly (both full generation and the TLS-toggle path write
 * global.tlsEnabled; cert-manager.enabled is the pre-existing fallback).
 * Defaults to true: fully deployed systems run TLS.
 */
export function deriveTlsEnabled(
  values: Record<string, unknown> | null,
): boolean {
  const globalTls = (values?.global as Record<string, unknown> | undefined)
    ?.tlsEnabled;
  if (typeof globalTls === "boolean") return globalTls;
  const certManagerEnabled = (
    values?.["cert-manager"] as Record<string, unknown> | undefined
  )?.enabled;
  if (typeof certManagerEnabled === "boolean") return certManagerEnabled;
  return true;
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

    // Keep the supabase kong ingress on the right Traefik entrypoint. The
    // subchart doesn't emit router.entrypoints/tls itself, so on the TLS-toggle
    // path (not a full regen) HTTPS to supabase.<domain> would 404 without this.
    // Mirrors what buildHelmValues sets on the kong ingress annotations.
    const supabase = values.supabase as Record<string, unknown> | undefined;
    const kongIngress = (supabase?.kong as Record<string, unknown> | undefined)
      ?.ingress as Record<string, unknown> | undefined;
    if (kongIngress && typeof kongIngress === "object") {
      kongIngress.annotations = {
        ...(kongIngress.annotations as Record<string, unknown> | undefined),
        "traefik.ingress.kubernetes.io/router.entrypoints": tlsEnabled
          ? "websecure"
          : "web",
        "traefik.ingress.kubernetes.io/router.tls": tlsEnabled ? "true" : "false",
      };
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
