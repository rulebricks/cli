import { z } from "zod";

// Cloud provider types
export type CloudProvider = "aws" | "gcp" | "azure";
export type DatabaseType = "self-hosted" | "supabase-cloud";
export type NodeArchitecture = "amd64" | "arm64" | "mixed" | "unknown";
export type SSOProvider =
  | "azure"
  | "google"
  | "okta"
  | "keycloak"
  | "ory"
  | "other";

// External managed Kafka presets. Drives per-cloud auth defaults and whether the
// Vector bridge sidecar is required (token mechanisms can't be spoken by Vector).
export type KafkaPreset =
  | "aws-msk-iam"
  | "azure-event-hubs"
  | "gcp-managed"
  | "custom";

// Kafka SASL mechanisms. "" means no SASL (plaintext / SSL-only).
export type KafkaSaslMechanism =
  | ""
  | "aws-iam"
  | "oauthbearer"
  | "scram-sha-256"
  | "scram-sha-512"
  | "plain";

// DNS Provider types - for External DNS feature
// 'other' means the user's DNS is not on a supported provider (Squarespace, GoDaddy, etc.)
export type DnsProvider =
  | "route53"
  | "cloudflare"
  | "google"
  | "azure"
  | "other";

// Supported DNS providers that work with external-dns
export const SUPPORTED_DNS_PROVIDERS: DnsProvider[] = [
  "route53",
  "cloudflare",
  "google",
  "azure",
];

// Logging sink types for Vector. Decision logs always go to the configured
// object storage (config.storage); this selects an *additional* external
// logging platform. 'pending' means external logging is enabled but the
// destination has not been selected yet.
export type LoggingSink =
  | "console" // Default - console only
  | "pending" // External logging enabled but not configured yet
  // Logging Platforms
  | "datadog" // Datadog Logs
  | "splunk" // Splunk HEC
  | "elasticsearch" // Elasticsearch
  | "loki" // Grafana Loki
  | "newrelic" // New Relic Logs
  | "axiom"; // Axiom

// Prometheus remote_write destination and auth configuration.
export type MonitoringDestination =
  | "local-grafana"
  | "aws-amp"
  | "azure-monitor"
  | "grafana-cloud"
  | "generic";

export type RemoteWriteDestination =
  | "aws-amp"
  | "azure-monitor"
  | "grafana-cloud"
  | "generic";

export type RemoteWriteAuthType =
  | "none"
  | "managed-identity"
  | "workload-identity"
  | "oauth"
  | "basic"
  | "bearer";

export interface SecretKeyRef {
  name: string;
  key: string;
}

export interface RemoteWriteConfig {
  destination: RemoteWriteDestination;
  url: string;
  authType?: RemoteWriteAuthType;
  awsRegion?: string;
  awsRoleArn?: string;
  azureCloud?: "AzurePublic" | "AzureChina" | "AzureGovernment";
  clientId?: string;
  tenantId?: string;
  clientSecretRef?: SecretKeyRef;
  usernameSecretRef?: SecretKeyRef;
  passwordSecretRef?: SecretKeyRef;
  bearerTokenSecretRef?: SecretKeyRef;
}

export type CloudLoggingAuthMode = "workload-identity" | "secret";
export type ObjectStorageProvider = "s3" | "azure-blob" | "gcs";

// Region mappings
export const CLOUD_REGIONS: Record<CloudProvider, string[]> = {
  aws: [
    // US regions
    "us-east-1",
    "us-east-2",
    "us-west-1",
    "us-west-2",
    // Canada
    "ca-central-1",
    "ca-west-1",
    // Europe
    "eu-west-1",
    "eu-west-2",
    "eu-west-3",
    "eu-central-1",
    "eu-central-2",
    "eu-north-1",
    "eu-south-1",
    "eu-south-2",
    // Asia Pacific
    "ap-northeast-1",
    "ap-northeast-2",
    "ap-northeast-3",
    "ap-southeast-1",
    "ap-southeast-2",
    "ap-southeast-3",
    "ap-southeast-4",
    "ap-southeast-5",
    "ap-southeast-7",
    "ap-south-1",
    "ap-south-2",
    "ap-east-1",
    // South America
    "sa-east-1",
    // Middle East & Africa
    "me-south-1",
    "me-central-1",
    "af-south-1",
    "il-central-1",
  ],
  gcp: [
    // US regions
    "us-central1",
    "us-east1",
    "us-east4",
    "us-west1",
    "us-west4",
    // North America
    "northamerica-south1",
    // Europe
    "europe-west1",
    "europe-west2",
    "europe-west3",
    "europe-west4",
    "europe-north1",
    // Asia Pacific
    "asia-east1",
    "asia-northeast1",
    "asia-south1",
    "asia-southeast1",
    // Australia
    "australia-southeast2",
  ],
  azure: [
    // US regions
    "eastus",
    "eastus2",
    "westus",
    "westus2",
    "westus3",
    "centralus",
    "northcentralus",
    "southcentralus",
    "westcentralus",
    // Canada
    "canadacentral",
    "canadaeast",
    // South America
    "brazilsouth",
    // Europe
    "northeurope",
    "westeurope",
    "uksouth",
    "ukwest",
    "francecentral",
    "francesouth",
    "germanywestcentral",
    "germanynorth",
    "switzerlandnorth",
    "switzerlandwest",
    "norwayeast",
    "norwaywest",
    "swedencentral",
    "polandcentral",
    // Asia Pacific
    "eastasia",
    "southeastasia",
    "japaneast",
    "japanwest",
    "koreacentral",
    "koreasouth",
    // Australia
    "australiaeast",
    "australiasoutheast",
    "australiacentral",
    // India
    "centralindia",
    "southindia",
    "westindia",
    // Middle East & Africa
    "uaenorth",
    "uaecentral",
    "southafricanorth",
    "qatarcentral",
    "israelcentral",
  ],
};

// SMTP Configuration
export interface SMTPConfig {
  host: string;
  port: number;
  user: string;
  pass: string;
  from: string;
  fromName: string;
}

// Default SMTP providers
export const SMTP_PROVIDERS = {
  "aws-ses": {
    host: "email-smtp.us-east-1.amazonaws.com",
    port: 587,
    user: "",
  },
  sendgrid: { host: "smtp.sendgrid.net", port: 587, user: "" },
  resend: { host: "smtp.resend.com", port: 465, user: "resend" },
  mailgun: { host: "smtp.mailgun.org", port: 587, user: "" },
  postmark: { host: "smtp.postmarkapp.com", port: 587, user: "" },
  mailtrap: { host: "smtp.mailtrap.io", port: 2525, user: "" },
  custom: { host: "", port: 587, user: "" },
};

// Email template configuration for Supabase custom emails
export interface EmailSubjects {
  invite: string;
  confirmation: string;
  recovery: string;
  emailChange: string;
}

export interface EmailTemplates {
  invite: string; // URL to HTML template
  confirmation: string;
  recovery: string;
  emailChange: string;
}

export interface CustomEmailConfig {
  subjects: EmailSubjects;
  templates: EmailTemplates;
}

export const DEFAULT_EMAIL_SUBJECTS: EmailSubjects = {
  invite: "Join your team on Rulebricks",
  confirmation: "Confirm Your Email",
  recovery: "Reset Your Password",
  emailChange: "Confirm Email Change",
};

// DNS Provider display names
export const DNS_PROVIDER_NAMES: Record<DnsProvider, string> = {
  route53: "AWS Route 53",
  cloudflare: "Cloudflare",
  google: "Google Cloud DNS",
  azure: "Azure DNS",
  other: "Other / Not sure",
};

// Cloud provider display names with proper casing for UI labels. Acronyms stay
// uppercase; Azure is title-cased (so it doesn't render as "AZURE").
export const CLOUD_PROVIDER_NAMES: Record<CloudProvider, string> = {
  aws: "AWS",
  gcp: "GCP",
  azure: "Azure",
};

// Logging sink display info
export const LOGGING_SINK_INFO: Record<
  LoggingSink,
  { name: string; description: string }
> = {
  console: {
    name: "Console only",
    description: "Logs written to stdout (default)",
  },
  pending: {
    name: "External (not configured)",
    description: "External logging enabled but destination not selected",
  },
  // Logging Platforms
  datadog: {
    name: "Datadog",
    description: "Send logs to Datadog Logs",
  },
  splunk: {
    name: "Splunk",
    description: "Send logs to Splunk via HTTP Event Collector",
  },
  elasticsearch: {
    name: "Elasticsearch",
    description: "Send logs to Elasticsearch cluster",
  },
  loki: {
    name: "Grafana Loki",
    description: "Send logs to Grafana Loki",
  },
  newrelic: {
    name: "New Relic",
    description: "Send logs to New Relic Logs",
  },
  axiom: {
    name: "Axiom",
    description: "Send logs to Axiom dataset",
  },
};

const SecretKeyRefSchema = z.object({
  name: z.string().min(1),
  key: z.string().min(1),
});

/**
 * Validates a Prometheus remote_write config the same way buildHelmValues and
 * the Helm chart do, returning human-readable errors. Centralized so the wizard
 * gate, the Zod schema (load time), and Helm value generation all enforce the
 * exact same per-destination/auth requirements. This is what prevents the CLI
 * from ever persisting a monitoring config that throws at deploy time (e.g.
 * "Azure Monitor remote_write managed identity requires client ID").
 */
export function validateRemoteWriteConfig(rw: RemoteWriteConfig): string[] {
  const errors: string[] = [];
  switch (rw.destination) {
    case "aws-amp":
      if (!rw.awsRegion) {
        errors.push("AWS Managed Prometheus remote write requires a region.");
      }
      break;
    case "azure-monitor": {
      // The remote_write URL must be the full DCE metrics-ingestion path, not the
      // bare DCE host. Azure Monitor expects:
      //   https://<dce>.<region>.metrics.ingest.monitor.azure.com/dataCollectionRules/<dcrImmutableId>/streams/Microsoft-PrometheusMetrics/api/v1/write?api-version=2023-04-24
      // A bare host silently 404s, so catch the common copy-paste mistake here.
      if (
        rw.url &&
        !(
          rw.url.includes("/dataCollectionRules/") &&
          rw.url.includes("/streams/") &&
          rw.url.includes("/api/v1/write")
        )
      ) {
        errors.push(
          "Azure Monitor remote write URL must be the full DCE metrics-ingestion path " +
            "(https://<dce>.<region>.metrics.ingest.monitor.azure.com/dataCollectionRules/<dcrImmutableId>/streams/Microsoft-PrometheusMetrics/api/v1/write?api-version=2023-04-24), " +
            "not just the data collection endpoint host.",
        );
      }
      // An unset authType is treated as managed identity (the chart default).
      const authType = rw.authType ?? "managed-identity";
      if (authType === "oauth") {
        if (!rw.clientId || !rw.tenantId || !rw.clientSecretRef) {
          errors.push(
            "Azure Monitor remote write (OAuth) requires a client ID, tenant ID, and client secret reference.",
          );
        }
      } else if (authType === "workload-identity") {
        if (!rw.clientId || !rw.tenantId) {
          errors.push(
            "Azure Monitor remote write (workload identity) requires a client ID and tenant ID.",
          );
        }
      } else if (!rw.clientId) {
        errors.push(
          "Azure Monitor remote write (managed identity) requires a client ID.",
        );
      }
      break;
    }
    case "grafana-cloud":
      if (!rw.usernameSecretRef || !rw.passwordSecretRef) {
        errors.push(
          "Grafana Cloud remote write requires username and password secret references.",
        );
      }
      break;
    case "generic":
      if (
        rw.authType === "basic" &&
        (!rw.usernameSecretRef || !rw.passwordSecretRef)
      ) {
        errors.push(
          "Basic-auth remote write requires username and password secret references.",
        );
      }
      if (rw.authType === "bearer" && !rw.bearerTokenSecretRef) {
        errors.push(
          "Bearer-token remote write requires a token secret reference.",
        );
      }
      break;
  }
  return errors;
}

const RemoteWriteConfigSchema = z
  .object({
    destination: z.enum([
      "aws-amp",
      "azure-monitor",
      "grafana-cloud",
      "generic",
    ]),
    url: z.string().url(),
    authType: z
      .enum([
        "none",
        "managed-identity",
        "workload-identity",
        "oauth",
        "basic",
        "bearer",
      ])
      .optional(),
    awsRegion: z.string().optional(),
    awsRoleArn: z.string().optional(),
    azureCloud: z
      .enum(["AzurePublic", "AzureChina", "AzureGovernment"])
      .optional(),
    clientId: z.string().optional(),
    tenantId: z.string().optional(),
    clientSecretRef: SecretKeyRefSchema.optional(),
    usernameSecretRef: SecretKeyRefSchema.optional(),
    passwordSecretRef: SecretKeyRefSchema.optional(),
    bearerTokenSecretRef: SecretKeyRefSchema.optional(),
  })
  .superRefine((rw, ctx) => {
    for (const message of validateRemoteWriteConfig(rw as RemoteWriteConfig)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message });
    }
  });

const MonitoringDestinationSchema = z.enum([
  "local-grafana",
  "aws-amp",
  "azure-monitor",
  "grafana-cloud",
  "generic",
]);

// Distributed tracing: in-cluster OpenTelemetry Collector forwarding OTLP spans
// to a customer-managed Elastic APM endpoint (BYO). Self-hosted only.
// Trace backend the in-cluster collector exports to. AWS- and Azure-compatible:
// `otlp` covers any vendor-neutral OTLP/HTTP endpoint, `azure-monitor` targets
// Azure Application Insights, and `elastic` is the Elastic APM default.
export type TracingDestination = "elastic" | "otlp" | "azure-monitor";

const TracingConfigSchema = z
  .object({
    enabled: z.boolean(),
    // Absent means "elastic" for backward compatibility with existing configs.
    destination: z.enum(["elastic", "otlp", "azure-monitor"]).optional(),
    samplingRatio: z.number().min(0).max(1).optional(),
    elastic: z
      .object({
        endpoint: z.string().url().optional(),
        authMode: z.enum(["secret-token", "api-key", "none"]).optional(),
        secretToken: z.string().optional(),
        apiKey: z.string().optional(),
      })
      .optional(),
    // Generic OTLP/HTTP backend (Grafana Tempo, Honeycomb, Jaeger, vendor
    // gateways, AWS/Azure OTLP ingestion, etc.).
    otlp: z
      .object({
        endpoint: z.string().url().optional(),
        authMode: z.enum(["none", "bearer", "api-key", "header"]).optional(),
        headerName: z.string().optional(),
        token: z.string().optional(),
        apiKey: z.string().optional(),
        headerValue: z.string().optional(),
        headers: z.record(z.string()).optional(),
        tlsInsecureSkipVerify: z.boolean().optional(),
      })
      .optional(),
    // Azure Monitor / Application Insights.
    azureMonitor: z
      .object({
        connectionString: z.string().optional(),
      })
      .optional(),
  })
  .superRefine((t, ctx) => {
    if (!t.enabled) return;
    const destination = t.destination ?? "elastic";
    if (destination === "elastic") {
      if (!t.elastic?.endpoint) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message:
            "features.tracing.elastic.endpoint is required when tracing destination is 'elastic'",
          path: ["elastic", "endpoint"],
        });
      }
      const mode = t.elastic?.authMode ?? "secret-token";
      if (mode === "secret-token" && !t.elastic?.secretToken) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message:
            "features.tracing.elastic.secretToken is required for authMode 'secret-token'",
          path: ["elastic", "secretToken"],
        });
      }
      if (mode === "api-key" && !t.elastic?.apiKey) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message:
            "features.tracing.elastic.apiKey is required for authMode 'api-key'",
          path: ["elastic", "apiKey"],
        });
      }
    } else if (destination === "otlp") {
      if (!t.otlp?.endpoint) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message:
            "features.tracing.otlp.endpoint is required when tracing destination is 'otlp'",
          path: ["otlp", "endpoint"],
        });
      }
      const mode = t.otlp?.authMode ?? "none";
      if (mode === "bearer" && !t.otlp?.token) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message:
            "features.tracing.otlp.token is required for authMode 'bearer'",
          path: ["otlp", "token"],
        });
      }
      if (mode === "api-key" && !t.otlp?.apiKey) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message:
            "features.tracing.otlp.apiKey is required for authMode 'api-key'",
          path: ["otlp", "apiKey"],
        });
      }
      if (mode === "header" && !t.otlp?.headerValue) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message:
            "features.tracing.otlp.headerValue is required for authMode 'header'",
          path: ["otlp", "headerValue"],
        });
      }
    } else if (destination === "azure-monitor") {
      if (!t.azureMonitor?.connectionString) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message:
            "features.tracing.azureMonitor.connectionString is required when tracing destination is 'azure-monitor'",
          path: ["azureMonitor", "connectionString"],
        });
      }
    }
  });

export type TracingConfig = z.infer<typeof TracingConfigSchema>;

// Application/container log shipping to a customer-managed Elasticsearch (BYO)
// via the Vector agent DaemonSet. Distinct from decision-log sinks.
const AppLogsConfigSchema = z
  .object({
    enabled: z.boolean(),
    destination: z.enum(["elasticsearch", "loki", "generic"]).optional(),
    elasticsearch: z
      .object({
        endpoint: z.string().url().optional(),
        index: z.string().optional(),
        authMode: z.enum(["basic", "api-key", "none"]).optional(),
        username: z.string().optional(),
        password: z.string().optional(),
        apiKey: z.string().optional(),
        verifyCertificate: z.boolean().optional(),
      })
      .optional(),
    loki: z
      .object({
        endpoint: z.string().url().optional(),
        labels: z.record(z.string()).optional(),
      })
      .optional(),
    generic: z
      .object({
        endpoint: z.string().url().optional(),
        authHeader: z.string().optional(),
      })
      .optional(),
  })
  .superRefine((a, ctx) => {
    if (!a.enabled) return;
    const destination = a.destination ?? "elasticsearch";
    if (destination === "loki") {
      if (!a.loki?.endpoint) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message:
            "features.logging.appLogs.loki.endpoint is required when appLogs destination is 'loki'",
          path: ["loki", "endpoint"],
        });
      }
      return;
    }
    if (destination === "generic") {
      if (!a.generic?.endpoint) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message:
            "features.logging.appLogs.generic.endpoint is required when appLogs destination is 'generic'",
          path: ["generic", "endpoint"],
        });
      }
      return;
    }
    if (!a.elasticsearch?.endpoint) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          "features.logging.appLogs.elasticsearch.endpoint is required when appLogs is enabled",
        path: ["elasticsearch", "endpoint"],
      });
    }
    const mode = a.elasticsearch?.authMode ?? "basic";
    if (
      mode === "basic" &&
      (!a.elasticsearch?.username || !a.elasticsearch?.password)
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          "features.logging.appLogs.elasticsearch username and password are required for authMode 'basic'",
        path: ["elasticsearch", "username"],
      });
    }
    if (mode === "api-key" && !a.elasticsearch?.apiKey) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          "features.logging.appLogs.elasticsearch.apiKey is required for authMode 'api-key'",
        path: ["elasticsearch", "apiKey"],
      });
    }
  });

export type AppLogsConfig = z.infer<typeof AppLogsConfigSchema>;

const CacheObservabilityConfigSchema = z.object({
  valkeyAdmin: z
    .object({
      enabled: z.boolean(),
      exposure: z.enum(["internal", "ingress"]).optional(),
      hostname: z.string().optional(),
      basicAuthUsers: z.array(z.string()).optional(),
      basicAuthExistingSecret: z.string().optional(),
      allowedIPs: z.array(z.string()).optional(),
    })
    .optional(),
  redisExporter: z
    .object({
      enabled: z.boolean(),
    })
    .optional(),
  kafkaExporter: z
    .object({
      enabled: z.boolean(),
    })
    .optional(),
});

// Deployment configuration schema
export const DeploymentConfigSchema = z.object({
  name: z
    .string()
    .min(1)
    .max(63)
    .regex(/^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/),

  // Infrastructure
  infrastructure: z.object({
    mode: z.literal("existing"),
    provider: z.enum(["aws", "gcp", "azure"]).optional(),
    region: z.string().optional(),
    clusterName: z.string().optional(),
    gcpProjectId: z.string().optional(),
    azureResourceGroup: z.string().optional(),
    nodeArchitecture: z
      .enum(["amd64", "arm64", "mixed", "unknown"])
      .optional(),
    arm64TolerationRequired: z.boolean().optional(),
    storageClass: z.string().optional(),
    storageProvisioner: z.string().optional(),
    schedulableNodeCount: z.number().optional(),
    totalCpuCores: z.number().optional(),
    totalMemoryGi: z.number().optional(),
    eligibleCpuCores: z.number().optional(),
    eligibleMemoryGi: z.number().optional(),
    totalPersistentStorageGi: z.number().optional(),
  }),

  // Domain & TLS
  domain: z.string().min(1),
  adminEmail: z.string().email(),
  tlsEmail: z.string().email(),

  // DNS Configuration
  dns: z.object({
    // Where is the user's DNS hosted?
    provider: z.enum(["route53", "cloudflare", "google", "azure", "other"]),
    // Should we auto-manage DNS records? (only applicable for supported providers)
    autoManage: z.boolean(),
  }),

  // SMTP Configuration
  smtp: z.object({
    host: z.string().min(1),
    port: z.number().min(1).max(65535),
    user: z.string().min(1),
    pass: z.string().min(1),
    from: z.string().email(),
    fromName: z.string().min(1),
  }),

  // Database
  database: z.object({
    type: z.enum(["self-hosted", "supabase-cloud"]),
    // Supabase Cloud specific
    supabaseUrl: z.string().url().optional(),
    supabaseAnonKey: z.string().optional(),
    supabaseServiceKey: z.string().optional(),
    supabaseAccessToken: z.string().optional(),
    supabaseProjectRef: z.string().optional(),
    // Self-hosted specific
    supabaseJwtSecret: z.string().optional(),
    supabaseDbPassword: z.string().optional(),
    supabaseDashboardUser: z.string().optional(),
    supabaseDashboardPass: z.string().optional(),
  }),

  // Shared object storage: one provider, one identity, one bucket/container.
  // Decision logs and DB backups are just key prefixes within it.
  storage: z
    .object({
      provider: z.enum(["s3", "azure-blob", "gcs"]),
      cloudAuthMode: z.enum(["workload-identity", "secret"]).optional(),
      // Single bucket (S3/GCS) or storage account (azure-blob) + its region.
      bucket: z.string().min(1),
      region: z.string().min(1),
      awsIamRoleArn: z.string().optional(),
      azureBlobClientId: z.string().optional(),
      azureBlobTenantId: z.string().optional(),
      azureBlobConnectionStringSecretRef: SecretKeyRefSchema.optional(),
      // Single blob container (azure-blob only) holding all prefixes.
      azureBlobContainer: z.string().optional(),
      gcpServiceAccountEmail: z.string().optional(),
      // Per-purpose key prefixes within the single bucket/container.
      paths: z
        .object({
          decisionLogs: z.string().optional(),
          dbBackups: z.string().optional(),
        })
        .optional(),
    })
    .optional(),

  // External/managed Redis and Kafka (for large deployments that prefer managed
  // services over the in-cluster defaults). Omitted/embedded means the chart
  // deploys these in-cluster as usual.
  externalServices: z
    .object({
      redis: z
        .object({
          mode: z.enum(["embedded", "external"]),
          external: z
            .object({
              host: z.string().optional(),
              port: z.number().int().min(1).max(65535).optional(),
              password: z.string().optional(),
              existingSecret: z.string().optional(),
              existingSecretKey: z.string().optional(),
              tls: z.boolean().optional(),
              httpApi: z
                .object({
                  enabled: z.boolean(),
                  url: z.string().optional(),
                  token: z.string().optional(),
                })
                .optional(),
            })
            .optional(),
        })
        .optional(),
      kafka: z
        .object({
          mode: z.enum(["embedded", "external"]),
          external: z
            .object({
              // Preset drives per-cloud auth defaults and whether the Vector
              // bridge sidecar is required.
              preset: z
                .enum([
                  "aws-msk-iam",
                  "azure-event-hubs",
                  "gcp-managed",
                  "custom",
                ])
                .optional(),
              brokers: z.string().optional(),
              topic: z.string().optional(),
              // Prefix namespacing all Kafka topics (e.g. "com.rulebricks.").
              topicPrefix: z.string().optional(),
              ssl: z.boolean().optional(),
              sasl: z
                .object({
                  // "" means no SASL (plaintext/SSL-only).
                  mechanism: z.enum([
                    "",
                    "aws-iam",
                    "oauthbearer",
                    "scram-sha-256",
                    "scram-sha-512",
                    "plain",
                  ]),
                  region: z.string().optional(),
                  username: z.string().optional(),
                  password: z.string().optional(),
                  existingSecret: z.string().optional(),
                })
                .optional(),
              // Cloud workload identity for token mechanisms (MSK IAM / GCP
              // OAUTHBEARER). Applied to the HPS and Vector service accounts.
              identity: z
                .object({
                  awsRoleArn: z.string().optional(),
                  gcpServiceAccountEmail: z.string().optional(),
                  azureClientId: z.string().optional(),
                })
                .optional(),
            })
            .optional(),
        })
        .optional(),
    })
    .optional(),

  backup: z
    .object({
      enabled: z.boolean(),
      schedule: z.string().min(1),
      retentionDays: z.number().int().min(1),
    })
    .optional(),

  // Optional features
  features: z.object({
    ai: z.object({
      enabled: z.boolean(),
      openaiApiKey: z.string().optional(),
    }),
    sso: z.object({
      enabled: z.boolean(),
      provider: z
        .enum(["azure", "google", "okta", "keycloak", "ory", "other"])
        .optional(),
      url: z.string().url().optional(),
      clientId: z.string().optional(),
      clientSecret: z.string().optional(),
    }),
    monitoring: z.object({
      enabled: z.boolean(),
      destination: MonitoringDestinationSchema.optional(),
      // Legacy optional URL retained for existing config files.
      remoteWriteUrl: z.string().url().optional(),
      remoteWrite: RemoteWriteConfigSchema.optional(),
    }),
    // Distributed tracing (optional; self-hosted only). Absent on existing
    // config files, which keeps them valid.
    tracing: TracingConfigSchema.optional(),
    cache: CacheObservabilityConfigSchema.optional(),
    logging: z.object({
      // Console logging is always on. This selects an additional external
      // logging platform. Cloud object storage for decision logs is configured
      // separately under `storage`.
      sink: z.enum([
        "console",
        "pending",
        "datadog",
        "splunk",
        "elasticsearch",
        "loki",
        "newrelic",
        "axiom",
      ]),
      // For platforms, bucket/region are repurposed to carry the credential
      // (API key/token) and endpoint/site.
      bucket: z.string().optional(),
      region: z.string().optional(),
      // Application/container log shipping to Elasticsearch via the Vector
      // agent DaemonSet (distinct from the decision-log `sink` above).
      appLogs: AppLogsConfigSchema.optional(),
    }),
    customEmails: z
      .object({
        enabled: z.boolean(),
        subjects: z
          .object({
            invite: z.string(),
            confirmation: z.string(),
            recovery: z.string(),
            emailChange: z.string(),
          })
          .optional(),
        templates: z
          .object({
            invite: z.string().url(),
            confirmation: z.string().url(),
            recovery: z.string().url(),
            emailChange: z.string().url(),
          })
          .optional(),
      })
      .optional(),
  }),

  // Credentials
  licenseKey: z.string().min(1),

  // Product version used for app, HPS, and HPS worker images
  version: z.string().min(1),

  // Legacy chart version (deprecated, kept for backwards compatibility)
  chartVersion: z.string().optional(),
});

export type DeploymentConfig = z.infer<typeof DeploymentConfigSchema>;

// Deployment state tracking
export interface DeploymentState {
  name: string;
  version: string;
  createdAt: string;
  updatedAt: string;
  status:
    | "pending"
    | "deploying"
    | "waiting-dns"
    | "running"
    | "failed"
    | "destroyed";
  infrastructure?: {
    provider: CloudProvider;
    region: string;
    clusterName: string;
    clusterEndpoint?: string;
  };
  application?: {
    /** Unified Rulebricks product version */
    version: string;
    /** Legacy chart version (deprecated) */
    chartVersion?: string;
    namespace: string;
    url: string;
    loadBalancerAddress?: string;
  };
  dnsRecords?: {
    hostname: string;
    type: "A" | "CNAME";
    target: string;
    verified: boolean;
  }[];
}

// Helm chart version info (legacy)
export interface ChartVersion {
  version: string;
  appVersion: string;
  created: string;
  digest: string;
}

// Rulebricks product version with registry metadata
export interface AppVersion {
  /** Product image version (e.g., "1.5.0") */
  version: string;
  /** Release date ISO string */
  releaseDate: string;
  /** Image digest */
  digest: string;
  /** HPS server image digests for this version */
  hpsDigests?: string[];
  /** HPS worker image digests for this version */
  hpsWorkerDigests?: string[];
}

// DNS Record type for tracking
export interface DNSRecord {
  hostname: string;
  type: "A" | "CNAME";
  target: string;
  verified: boolean;
  required: boolean;
}

// Helper to check if DNS provider supports external-dns
export function isSupportedDnsProvider(provider: DnsProvider): boolean {
  return SUPPORTED_DNS_PROVIDERS.includes(provider);
}

// Profile configuration schema for persistent user preferences
export const ProfileConfigSchema = z.object({
  // Infrastructure preferences
  provider: z.enum(["aws", "gcp", "azure"]).optional(),
  region: z.string().optional(),
  clusterName: z.string().optional(),

  // Domain preferences
  domainSuffix: z.string().optional(), // e.g., ".rulebricks.com"
  adminEmail: z.string().email().optional(),
  tlsEmail: z.string().email().optional(),
  dnsProvider: z
    .enum(["route53", "cloudflare", "google", "azure", "other"])
    .optional(),

  // SMTP settings
  smtpHost: z.string().optional(),
  smtpPort: z.number().optional(),
  smtpUser: z.string().optional(),
  smtpPass: z.string().optional(),
  smtpFrom: z.string().optional(),
  smtpFromName: z.string().optional(),

  // API Keys
  openaiApiKey: z.string().optional(),
  licenseKey: z.string().optional(),

  // Preferences
  databaseType: z.enum(["self-hosted", "supabase-cloud"]).optional(),
  storage: z
    .object({
      provider: z.enum(["s3", "azure-blob", "gcs"]),
      cloudAuthMode: z.enum(["workload-identity", "secret"]).optional(),
      bucket: z.string().optional(),
      region: z.string().optional(),
      awsIamRoleArn: z.string().optional(),
      azureBlobClientId: z.string().optional(),
      azureBlobTenantId: z.string().optional(),
      azureBlobConnectionStringSecretRef: SecretKeyRefSchema.optional(),
      azureBlobContainer: z.string().optional(),
      gcpServiceAccountEmail: z.string().optional(),
      paths: z
        .object({
          decisionLogs: z.string().optional(),
          dbBackups: z.string().optional(),
        })
        .optional(),
    })
    .optional(),

  // SSO (optional)
  ssoProvider: z
    .enum(["azure", "google", "okta", "keycloak", "ory", "other"])
    .optional(),
  ssoUrl: z.string().optional(),
  ssoClientId: z.string().optional(),
  ssoClientSecret: z.string().optional(),
});

export type ProfileConfig = z.infer<typeof ProfileConfigSchema>;

// Constants
export const CHANGELOG_URL = "https://rulebricks.com/docs/changelog";
export const HELM_CHART_OCI = "oci://ghcr.io/rulebricks/helm/stack";

// Legacy namespace/release name - kept for backwards compatibility with existing deployments
export const DEFAULT_NAMESPACE = "rulebricks";
export const LEGACY_RELEASE_NAME = "rulebricks";

/**
 * Generates a deployment-specific Kubernetes namespace.
 * Format: rulebricks-<deployment-name>
 * Example: rulebricks-prod, rulebricks-staging
 */
export function getNamespace(deploymentName: string): string {
  return `rulebricks-${deploymentName}`;
}

/**
 * Generates a deployment-specific Helm release name.
 * Format: rulebricks-<deployment-name>
 * Example: rulebricks-prod, rulebricks-staging
 */
export function getReleaseName(deploymentName: string): string {
  return `rulebricks-${deploymentName}`;
}

// ============================================================================
// Benchmark Types
// ============================================================================

/** Benchmark test mode - QPS measures requests/sec, throughput measures solutions/sec */
export type BenchmarkTestMode = "qps" | "throughput";

/** Benchmark preset intensity level */
export type BenchmarkPreset = "light" | "medium" | "heavy" | "custom";

/** Configuration for a benchmark test run */
export interface BenchmarkConfig {
  /** Name of the deployment being tested */
  deploymentName: string;
  /** Full API URL including flow slug (e.g., https://domain.com/api/v1/flows/benchmark-flow) */
  apiUrl: string;
  /** Rulebricks API key */
  apiKey: string;
  /** Test mode - qps or throughput */
  testMode: BenchmarkTestMode;
  /** Test duration (e.g., "2m", "4m") */
  testDuration: string;
  /** Target requests per second */
  targetRps: number;
  /** Bulk size - only for throughput mode (payloads per request) */
  bulkSize?: number;
}

/** Result metrics from a benchmark test */
export interface BenchmarkMetrics {
  /** Actual requests per second achieved */
  actualRps: number;
  /** Success rate as percentage (0-100) */
  successRate: number;
  /** P50 latency in milliseconds */
  p50Latency: number;
  /** P90 latency in milliseconds */
  p90Latency: number;
  /** P95 latency in milliseconds */
  p95Latency: number;
  /** P99 latency in milliseconds */
  p99Latency: number;
  /** Minimum latency in milliseconds */
  minLatency: number;
  /** Maximum latency in milliseconds */
  maxLatency: number;
  /** Average latency in milliseconds */
  avgLatency: number;
  /** Total requests made */
  totalRequests: number;
  /** Number of failed requests */
  failedRequests: number;
  /** Test duration in seconds */
  testDuration: number;
  /** Total data sent in bytes */
  dataSent: number;
  /** Total data received in bytes */
  dataReceived: number;
  /** Max virtual users used */
  maxVUs: number;
  /** For throughput tests: actual throughput (solutions/sec) */
  actualThroughput?: number;
  /** For throughput tests: total payloads processed */
  totalPayloads?: number;
}

/** Result of a benchmark test run */
export interface BenchmarkResult {
  /** Whether the test completed successfully */
  success: boolean;
  /** Path to the output directory */
  outputDir: string;
  /** Path to the HTML report */
  reportPath: string;
  /** Path to the JSON results */
  resultsPath: string;
  /** Parsed metrics from the test (if successful) */
  metrics?: BenchmarkMetrics;
  /** Error message if the test failed */
  error?: string;
}

/** Preset configurations for QPS tests */
export const QPS_PRESETS: Record<
  Exclude<BenchmarkPreset, "custom">,
  {
    targetRps: number;
    testDuration: string;
    label: string;
    description: string;
  }
> = {
  light: {
    targetRps: 100,
    testDuration: "2m",
    label: "Light",
    description: "100 RPS for 2 minutes - quick validation",
  },
  medium: {
    targetRps: 500,
    testDuration: "4m",
    label: "Medium",
    description: "500 RPS for 4 minutes - standard load test",
  },
  heavy: {
    targetRps: 1000,
    testDuration: "4m",
    label: "Heavy",
    description: "1000 RPS for 4 minutes - stress test",
  },
};

/** Preset configurations for throughput tests */
export const THROUGHPUT_PRESETS: Record<
  Exclude<BenchmarkPreset, "custom">,
  {
    targetRps: number;
    bulkSize: number;
    testDuration: string;
    label: string;
    description: string;
  }
> = {
  light: {
    targetRps: 50,
    bulkSize: 25,
    testDuration: "2m",
    label: "Light",
    description: "1,250 solutions/sec for 2 minutes",
  },
  medium: {
    targetRps: 100,
    bulkSize: 50,
    testDuration: "4m",
    label: "Medium",
    description: "5,000 solutions/sec for 4 minutes",
  },
  heavy: {
    targetRps: 200,
    bulkSize: 100,
    testDuration: "4m",
    label: "Heavy",
    description: "20,000 solutions/sec for 4 minutes",
  },
};

/** Cloud URLs that should be blocked from benchmarking */
export const BLOCKED_BENCHMARK_DOMAINS = [
  "api.rulebricks.com",
  "rulebricks.io",
  "app.rulebricks.com",
];
