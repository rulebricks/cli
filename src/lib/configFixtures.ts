import {
  CloudProvider,
  DatabaseType,
  DeploymentConfig,
  MonitoringDestination,
  RemoteWriteConfig,
} from "../types/index.js";

/**
 * A representative matrix of deployment configurations used to verify that
 * buildHelmValues() always produces schema-valid, chart-consumable values.
 *
 * Shared between the unit harness (src/lib/helmValues.test.ts) and the
 * end-to-end chart check (scripts/verify-against-chart.mjs) so both exercise the
 * exact same scenarios.
 */

const JWT_SECRET = "test-jwt-secret-with-at-least-32-characters-long";

type StorageConfig = NonNullable<DeploymentConfig["storage"]>;

function s3Storage(): StorageConfig {
  return {
    provider: "s3",
    cloudAuthMode: "workload-identity",
    awsIamRoleArn: "arn:aws:iam::123456789012:role/rulebricks-cluster-rulebricks",
    bucket: "rulebricks-cluster-data-123456789012",
    region: "us-east-1",
    paths: { decisionLogs: "decision-logs", dbBackups: "db-backups" },
  };
}

function gcsStorage(): StorageConfig {
  return {
    provider: "gcs",
    cloudAuthMode: "workload-identity",
    gcpServiceAccountEmail: "rulebricks@my-project.iam.gserviceaccount.com",
    bucket: "rulebricks-cluster-data",
    region: "us-central1",
    paths: { decisionLogs: "decision-logs", dbBackups: "db-backups" },
  };
}

function azureStorage(mode: "workload-identity" | "secret"): StorageConfig {
  return {
    provider: "azure-blob",
    cloudAuthMode: mode,
    azureBlobClientId:
      mode === "workload-identity"
        ? "11111111-1111-1111-1111-111111111111"
        : undefined,
    azureBlobTenantId:
      mode === "workload-identity"
        ? "22222222-2222-2222-2222-222222222222"
        : undefined,
    azureBlobConnectionStringSecretRef:
      mode === "secret"
        ? { name: "azure-storage", key: "connection-string" }
        : undefined,
    bucket: "rbstorageacct",
    region: "eastus",
    azureBlobContainer: "rulebricks-cluster-data",
    paths: { decisionLogs: "decision-logs", dbBackups: "db-backups" },
  };
}

function storageForProvider(provider: CloudProvider): StorageConfig {
  switch (provider) {
    case "gcp":
      return gcsStorage();
    case "azure":
      return azureStorage("workload-identity");
    default:
      return s3Storage();
  }
}

interface MatrixOptions {
  name: string;
  provider?: CloudProvider;
  database?: DatabaseType;
  storage?: StorageConfig;
  externalServices?: DeploymentConfig["externalServices"];
  backupEnabled?: boolean;
  ai?: boolean;
  sso?: boolean;
  customEmails?: boolean;
  clickStackEnabled?: boolean;
  remoteWrite?: RemoteWriteConfig;
  monitoringDestination?: MonitoringDestination;
  tracing?: NonNullable<DeploymentConfig["features"]["tracing"]>;
  appLogs?: NonNullable<DeploymentConfig["features"]["logging"]["appLogs"]>;
  cache?: NonNullable<DeploymentConfig["features"]["cache"]>;
  version?: string;
}

function build(options: MatrixOptions): DeploymentConfig {
  const provider = options.provider ?? "aws";
  const database = options.database ?? "self-hosted";
  const storage = options.storage ?? storageForProvider(provider);
  const region =
    provider === "gcp" ? "us-central1" : provider === "azure" ? "eastus" : "us-east-1";

  const databaseConfig: DeploymentConfig["database"] =
    database === "self-hosted"
      ? {
          type: "self-hosted",
          supabaseJwtSecret: JWT_SECRET,
          supabaseDbPassword: "db-password-1234",
          supabaseDashboardUser: "supabase",
          supabaseDashboardPass: "dashboard-pass-1234",
        }
      : {
          type: "supabase-cloud",
          supabaseUrl: "https://abcdefghijkl.supabase.co",
          supabaseAnonKey: "anon-key-value",
          supabaseServiceKey: "service-key-value",
          supabaseAccessToken: "sbp_access_token_value",
          supabaseProjectRef: "abcdefghijkl",
        };

  // Matches the wizard default: in-cluster Prometheus only, no destination,
  // unless metrics export (remoteWrite) or an explicit destination
  // (e.g. config-file-only "local-grafana") is configured.
  const monitoringDestination: MonitoringDestination | undefined =
    options.monitoringDestination ?? options.remoteWrite?.destination;
  const clickStackEnabled =
    options.clickStackEnabled ??
    !(options.remoteWrite || options.tracing || options.appLogs);

  return {
    name: options.name,
    infrastructure: {
      mode: "existing",
      provider,
      region,
      clusterName: "rulebricks-cluster",
      nodeArchitecture: "amd64",
      arm64TolerationRequired: false,
      storageClass:
        provider === "gcp"
          ? "pd-balanced"
          : provider === "azure"
            ? "managed-premium"
            : "gp3",
    },
    domain: "rb.example.com",
    adminEmail: "admin@example.com",
    tlsEmail: "tls@example.com",
    dns: { provider: "route53", autoManage: false },
    smtp: {
      host: "smtp.example.com",
      port: 587,
      user: "smtp-user",
      pass: "smtp-pass",
      from: "no-reply@example.com",
      fromName: "Rulebricks",
    },
    database: databaseConfig,
    storage,
    externalServices: options.externalServices,
    backup:
      database === "self-hosted"
        ? {
            enabled: options.backupEnabled ?? false,
            schedule: "0 2 * * *",
            retentionDays: 7,
          }
        : undefined,
    features: {
      ai: options.ai
        ? { enabled: true, openaiApiKey: "sk-test-openai-key" }
        : { enabled: false },
      sso: options.sso
        ? {
            enabled: true,
            provider: "okta",
            url: "https://example.okta.com",
            clientId: "sso-client-id",
            clientSecret: "sso-client-secret",
          }
        : { enabled: false },
      monitoring: {
        enabled: true,
        destination: monitoringDestination,
        remoteWrite: options.remoteWrite,
      },
      observability: {
        clickstack: {
          enabled: clickStackEnabled,
        },
      },
      tracing: options.tracing,
      cache: options.cache,
      logging: { sink: "console", appLogs: options.appLogs },
      customEmails: options.customEmails
        ? {
            enabled: true,
            subjects: {
              invite: "Join your team",
              confirmation: "Confirm Your Email",
              recovery: "Reset Your Password",
              emailChange: "Confirm Email Change",
            },
            templates: {
              invite: "https://example.com/invite.html",
              confirmation: "https://example.com/confirm.html",
              recovery: "https://example.com/recovery.html",
              emailChange: "https://example.com/change.html",
            },
          }
        : undefined,
    },
    licenseKey: "test-license-key",
    version: options.version ?? "1.8.17",
  };
}

export function buildConfigMatrix(): { name: string; config: DeploymentConfig }[] {
  const cases: MatrixOptions[] = [
    { name: "aws-self-hosted-minimal", provider: "aws" },
    { name: "aws-backup-enabled", provider: "aws", backupEnabled: true },
    {
      name: "aws-all-features",
      provider: "aws",
      backupEnabled: true,
      ai: true,
      sso: true,
      customEmails: true,
    },
    {
      name: "aws-external-redis",
      provider: "aws",
      externalServices: {
        redis: {
          mode: "external",
          external: { host: "redis.example.com", port: 6379, tls: true },
        },
        kafka: { mode: "embedded" },
      },
    },
    {
      name: "aws-external-kafka-msk",
      provider: "aws",
      externalServices: {
        redis: { mode: "embedded" },
        kafka: {
          mode: "external",
          external: {
            preset: "aws-msk-iam",
            brokers: "b-1.msk.example:9098,b-2.msk.example:9098",
            topicPrefix: "com.rulebricks.",
            ssl: true,
            sasl: { mechanism: "aws-iam", region: "us-east-1" },
            identity: {
              awsRoleArn: "arn:aws:iam::123456789012:role/msk-access",
            },
          },
        },
      },
    },
    {
      name: "aws-external-postgres",
      provider: "aws",
      externalServices: {
        redis: { mode: "embedded" },
        kafka: { mode: "embedded" },
        postgres: {
          mode: "external",
          external: {
            provider: "aws",
            host: "db.cluster-xxxx.us-east-1.rds.amazonaws.com",
            port: 5432,
            database: "postgres",
            bootstrap: {
              enabled: true,
              masterUsername: "postgres",
              masterPassword: "master-pw-change-me",
              appRole: "postgres",
            },
          },
        },
      },
    },
    {
      name: "azure-external-postgres",
      provider: "azure",
      externalServices: {
        redis: { mode: "embedded" },
        kafka: { mode: "embedded" },
        postgres: {
          mode: "external",
          external: {
            provider: "azure",
            host: "myserver.postgres.database.azure.com",
            port: 5432,
            database: "postgres",
            bootstrap: {
              enabled: true,
              masterUsername: "pgadmin",
              masterPassword: "master-pw-change-me",
              appRole: "pgadmin",
            },
          },
        },
      },
    },
    {
      name: "aws-remote-write-amp",
      provider: "aws",
      remoteWrite: {
        destination: "aws-amp",
        url: "https://aps-workspaces.us-east-1.amazonaws.com/workspaces/ws-123/api/v1/remote_write",
        awsRegion: "us-east-1",
        awsRoleArn: "arn:aws:iam::123456789012:role/rulebricks-cluster-metrics",
      },
    },
    { name: "aws-supabase-cloud", provider: "aws", database: "supabase-cloud" },
    {
      name: "aws-local-grafana",
      provider: "aws",
      monitoringDestination: "local-grafana",
    },
    { name: "gcp-self-hosted", provider: "gcp" },
    {
      name: "gcp-external-kafka",
      provider: "gcp",
      externalServices: {
        redis: { mode: "embedded" },
        kafka: {
          mode: "external",
          external: {
            preset: "gcp-managed",
            brokers: "bootstrap.managedkafka.example:9092",
            topicPrefix: "com.rulebricks.",
            ssl: true,
            sasl: {
              mechanism: "plain",
              username: "sa@project.iam.gserviceaccount.com",
              password: "token",
            },
          },
        },
      },
    },
    { name: "azure-workload-identity", provider: "azure" },
    {
      name: "azure-storage-secret",
      provider: "azure",
      storage: azureStorage("secret"),
    },
    {
      name: "azure-remote-write-managed",
      provider: "azure",
      remoteWrite: {
        destination: "azure-monitor",
        url: "https://example.eastus.metrics.ingest.monitor.azure.com/dataCollectionRules/dcr-1/streams/Microsoft-PrometheusMetrics/api/v1/write?api-version=2023-04-24",
        authType: "managed-identity",
        clientId: "33333333-3333-3333-3333-333333333333",
      },
    },
    {
      name: "azure-remote-write-workload",
      provider: "azure",
      remoteWrite: {
        destination: "azure-monitor",
        url: "https://example.eastus.metrics.ingest.monitor.azure.com/dataCollectionRules/dcr-1/streams/Microsoft-PrometheusMetrics/api/v1/write?api-version=2023-04-24",
        authType: "workload-identity",
        clientId: "33333333-3333-3333-3333-333333333333",
        tenantId: "22222222-2222-2222-2222-222222222222",
      },
    },
    {
      name: "azure-remote-write-oauth",
      provider: "azure",
      remoteWrite: {
        destination: "azure-monitor",
        url: "https://example.eastus.metrics.ingest.monitor.azure.com/dataCollectionRules/dcr-1/streams/Microsoft-PrometheusMetrics/api/v1/write?api-version=2023-04-24",
        authType: "oauth",
        clientId: "33333333-3333-3333-3333-333333333333",
        tenantId: "22222222-2222-2222-2222-222222222222",
        clientSecretRef: { name: "azure-monitor", key: "client-secret" },
      },
    },
    {
      name: "remote-write-grafana-cloud",
      provider: "aws",
      remoteWrite: {
        destination: "grafana-cloud",
        url: "https://prometheus-prod-01.grafana.net/api/prom/push",
        authType: "basic",
        usernameSecretRef: { name: "grafana-cloud", key: "username" },
        passwordSecretRef: { name: "grafana-cloud", key: "password" },
      },
    },
    {
      name: "remote-write-generic-bearer",
      provider: "aws",
      remoteWrite: {
        destination: "generic",
        url: "https://metrics.example.com/api/v1/write",
        authType: "bearer",
        bearerTokenSecretRef: { name: "metrics", key: "token" },
      },
    },
    {
      name: "aws-tracing-elastic",
      provider: "aws",
      tracing: {
        enabled: true,
        samplingRatio: 1,
        elastic: {
          endpoint: "https://rb-deployment.apm.us-east-1.aws.elastic-cloud.com:443",
          authMode: "secret-token",
          secretToken: "elastic-apm-secret-token",
        },
      },
    },
    {
      name: "aws-app-logs-elasticsearch",
      provider: "aws",
      appLogs: {
        enabled: true,
        destination: "elasticsearch",
        elasticsearch: {
          endpoint: "https://rb-deployment.es.us-east-1.aws.elastic-cloud.com:9243",
          index: "rulebricks-app-logs",
          authMode: "basic",
          username: "elastic",
          password: "elastic-password",
        },
      },
    },
    {
      name: "aws-app-logs-loki",
      provider: "aws",
      appLogs: {
        enabled: true,
        destination: "loki",
        loki: {
          endpoint: "https://loki.example.com/loki/api/v1/push",
          labels: { app: "rulebricks", source: "app-logs" },
        },
      },
    },
    {
      name: "aws-app-logs-generic-http",
      provider: "aws",
      appLogs: {
        enabled: true,
        destination: "generic",
        generic: {
          endpoint: "https://logs.example.com/ingest",
          authHeader: "Bearer generic-log-token",
        },
      },
    },
    {
      name: "aws-valkey-admin-internal",
      provider: "aws",
      cache: {
        valkeyAdmin: { enabled: true, exposure: "internal" },
        redisExporter: { enabled: true },
        kafkaExporter: { enabled: true },
      },
    },
    {
      name: "aws-tracing-otlp",
      provider: "aws",
      tracing: {
        enabled: true,
        destination: "otlp",
        otlp: {
          endpoint: "https://otlp-gateway.example.com/otlp",
          authMode: "bearer",
          token: "otlp-bearer-token",
        },
      },
    },
    {
      name: "azure-tracing-azure-monitor",
      provider: "azure",
      tracing: {
        enabled: true,
        destination: "azure-monitor",
        azureMonitor: {
          connectionString:
            "InstrumentationKey=00000000-0000-0000-0000-000000000000;IngestionEndpoint=https://eastus-1.in.applicationinsights.azure.com/",
        },
      },
    },
    {
      name: "aws-tracing-and-app-logs",
      provider: "aws",
      tracing: {
        enabled: true,
        elastic: {
          endpoint: "https://rb-deployment.apm.us-east-1.aws.elastic-cloud.com:443",
          authMode: "api-key",
          apiKey: "elastic-apm-api-key",
        },
      },
      appLogs: {
        enabled: true,
        destination: "elasticsearch",
        elasticsearch: {
          endpoint: "https://rb-deployment.es.us-east-1.aws.elastic-cloud.com:9243",
          authMode: "api-key",
          apiKey: "elastic-es-api-key",
        },
      },
    },
    { name: "aws-version-latest", provider: "aws", version: "latest" },
    {
      name: "everything-external",
      provider: "aws",
      backupEnabled: true,
      ai: true,
      sso: true,
      externalServices: {
        redis: {
          mode: "external",
          external: {
            host: "redis.example.com",
            existingSecret: "redis-auth",
            existingSecretKey: "redis-password",
            tls: true,
          },
        },
        kafka: {
          mode: "external",
          external: {
            preset: "custom",
            brokers: "kafka-1.example:9093",
            topicPrefix: "com.rulebricks.",
            ssl: true,
            sasl: {
              mechanism: "scram-sha-512",
              username: "kafka-user",
              password: "kafka-pass",
            },
          },
        },
      },
    },
  ];

  return cases.map((options) => ({ name: options.name, config: build(options) }));
}
