import { z } from "zod";

// Cloud provider types
export type CloudProvider = "aws" | "gcp" | "azure";
export type DatabaseType = "self-hosted" | "supabase-cloud";
export type PerformanceTier = "small" | "medium" | "large";
export type SSOProvider =
  | "azure"
  | "google"
  | "okta"
  | "keycloak"
  | "ory"
  | "other";

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

// Logging sink types for Vector
// 'pending' means external logging is enabled but destination not yet selected
export type LoggingSink =
  | "console" // Default - console only
  | "pending" // External logging enabled but not configured yet
  // Cloud Storage
  | "s3" // AWS S3
  | "azure-blob" // Azure Blob Storage
  | "gcs" // Google Cloud Storage
  // Logging Platforms
  | "datadog" // Datadog Logs
  | "splunk" // Splunk HEC
  | "elasticsearch" // Elasticsearch
  | "loki" // Grafana Loki
  | "newrelic" // New Relic Logs
  | "axiom"; // Axiom

// Logging sink categories
export type LoggingSinkCategory = "cloud-storage" | "logging-platform";

// Sink category mappings
export const LOGGING_SINK_CATEGORIES: Record<
  Exclude<LoggingSink, "console" | "pending">,
  LoggingSinkCategory
> = {
  s3: "cloud-storage",
  "azure-blob": "cloud-storage",
  gcs: "cloud-storage",
  datadog: "logging-platform",
  splunk: "logging-platform",
  elasticsearch: "logging-platform",
  loki: "logging-platform",
  newrelic: "logging-platform",
  axiom: "logging-platform",
};

// Region mappings
export const CLOUD_REGIONS: Record<CloudProvider, string[]> = {
  aws: [
    "us-east-1",
    "us-east-2",
    "us-west-1",
    "us-west-2",
    "eu-west-1",
    "eu-west-2",
    "eu-west-3",
    "eu-central-1",
    "ap-south-1",
    "ap-southeast-1",
    "ap-southeast-2",
    "ap-northeast-1",
    "ap-northeast-2",
    "ca-central-1",
    "sa-east-1",
  ],
  gcp: [
    "us-central1",
    "us-east1",
    "us-west1",
    "us-west2",
    "europe-west1",
    "europe-west2",
    "europe-west3",
    "asia-east1",
    "asia-northeast1",
    "asia-southeast1",
    "australia-southeast1",
    "southamerica-east1",
  ],
  azure: [
    "eastus",
    "eastus2",
    "westus",
    "westus2",
    "centralus",
    "northeurope",
    "westeurope",
    "uksouth",
    "eastasia",
    "southeastasia",
    "japaneast",
    "australiaeast",
    "canadacentral",
    "brazilsouth",
  ],
};

// Performance tier configurations
export const TIER_CONFIGS: Record<PerformanceTier, TierConfig> = {
  small: {
    description: "Development & Testing",
    throughput: "<1,000 rules/sec",
    nodes: { min: 4, max: 4 },
    resources: "2 vCPU, 4GB RAM each",
    // HPS
    hpsReplicas: 2,
    hpsWorkerReplicas: { min: 4, max: 8 },
    hpsResources: {
      requests: { cpu: "500m", memory: "1Gi" },
      limits: { cpu: "1500m", memory: "1536Mi" },
    },
    hpsWorkerResources: {
      requests: { cpu: "100m", memory: "128Mi" },
      limits: { cpu: "500m", memory: "512Mi" },
    },
    // Kafka
    kafkaStorage: "10Gi",
    kafkaReplication: 1,
    kafkaResources: {
      requests: { cpu: "500m", memory: "2Gi" },
      limits: { cpu: "2000m", memory: "3Gi" },
    },
    kafkaHeapOpts: "-Xmx1g -Xms1g -XX:+UseZGC -XX:+AlwaysPreTouch",
    // Redis
    redisResources: {
      requests: { cpu: "200m", memory: "256Mi" },
      limits: { cpu: "500m", memory: "2Gi" },
    },
    redisPersistenceSize: "4Gi",
    // Vector
    vectorReplicas: 2,
    vectorResources: {
      requests: { cpu: "50m", memory: "128Mi" },
      limits: { cpu: "200m", memory: "256Mi" },
    },
    // Database
    dbResources: {
      requests: { cpu: "500m", memory: "1Gi" },
      limits: { cpu: "1000m", memory: "2Gi" },
    },
    dbPersistenceSize: "10Gi",
    // App
    appReplicas: 2,
    appResources: {
      requests: { cpu: "500m", memory: "512Mi" },
      limits: { cpu: "2000m", memory: "2Gi" },
    },
  },
  medium: {
    description: "Production",
    throughput: "1,000-10,000 rules/sec",
    nodes: { min: 4, max: 8 },
    resources: "2-4 vCPU, 4-8GB RAM each",
    // HPS
    hpsReplicas: 3,
    hpsWorkerReplicas: { min: 10, max: 24 },
    hpsResources: {
      requests: { cpu: "1000m", memory: "1Gi" },
      limits: { cpu: "4000m", memory: "4Gi" },
    },
    hpsWorkerResources: {
      requests: { cpu: "500m", memory: "512Mi" },
      limits: { cpu: "2000m", memory: "2Gi" },
    },
    // Kafka
    kafkaStorage: "50Gi",
    kafkaReplication: 2,
    kafkaResources: {
      requests: { cpu: "1000m", memory: "3Gi" },
      limits: { cpu: "2000m", memory: "4Gi" },
    },
    kafkaHeapOpts: "-Xmx2g -Xms2g -XX:+UseZGC -XX:+AlwaysPreTouch",
    // Redis
    redisResources: {
      requests: { cpu: "200m", memory: "512Mi" },
      limits: { cpu: "1000m", memory: "4Gi" },
    },
    redisPersistenceSize: "8Gi",
    // Vector
    vectorReplicas: 2,
    vectorResources: {
      requests: { cpu: "100m", memory: "256Mi" },
      limits: { cpu: "500m", memory: "512Mi" },
    },
    // Database
    dbResources: {
      requests: { cpu: "1000m", memory: "2Gi" },
      limits: { cpu: "2000m", memory: "4Gi" },
    },
    dbPersistenceSize: "50Gi",
    // App
    appReplicas: 2,
    appResources: {
      requests: { cpu: "500m", memory: "512Mi" },
      limits: { cpu: "2000m", memory: "2Gi" },
    },
  },
  large: {
    description: "High Performance",
    throughput: ">10,000 rules/sec",
    nodes: { min: 5, max: 16 },
    resources: "2-4 vCPU, 4-8GB RAM each",
    // HPS
    hpsReplicas: 4,
    hpsWorkerReplicas: { min: 10, max: 48 },
    hpsResources: {
      requests: { cpu: "2000m", memory: "2Gi" },
      limits: { cpu: "4000m", memory: "4Gi" },
    },
    hpsWorkerResources: {
      requests: { cpu: "1000m", memory: "1Gi" },
      limits: { cpu: "2000m", memory: "2Gi" },
    },
    // Kafka
    kafkaStorage: "100Gi",
    kafkaReplication: 3,
    kafkaResources: {
      requests: { cpu: "2000m", memory: "4Gi" },
      limits: { cpu: "4000m", memory: "6Gi" },
    },
    kafkaHeapOpts: "-Xmx3g -Xms3g -XX:+UseZGC -XX:+AlwaysPreTouch",
    // Redis
    redisResources: {
      requests: { cpu: "500m", memory: "1Gi" },
      limits: { cpu: "2000m", memory: "8Gi" },
    },
    redisPersistenceSize: "16Gi",
    // Vector
    vectorReplicas: 3,
    vectorResources: {
      requests: { cpu: "200m", memory: "512Mi" },
      limits: { cpu: "1000m", memory: "1Gi" },
    },
    // Database
    dbResources: {
      requests: { cpu: "2000m", memory: "4Gi" },
      limits: { cpu: "4000m", memory: "8Gi" },
    },
    dbPersistenceSize: "100Gi",
    // App
    appReplicas: 3,
    appResources: {
      requests: { cpu: "1000m", memory: "1Gi" },
      limits: { cpu: "2000m", memory: "2Gi" },
    },
  },
};

// Resource specification for Kubernetes
export interface ResourceSpec {
  requests: { cpu: string; memory: string };
  limits: { cpu: string; memory: string };
}

export interface TierConfig {
  description: string;
  throughput: string;
  nodes: { min: number; max: number };
  resources: string;
  // HPS configuration
  hpsReplicas: number;
  hpsWorkerReplicas: { min: number; max: number };
  hpsResources: ResourceSpec;
  hpsWorkerResources: ResourceSpec;
  // Kafka configuration
  kafkaStorage: string;
  kafkaReplication: number;
  kafkaResources: ResourceSpec;
  kafkaHeapOpts: string;
  // Redis configuration
  redisResources: ResourceSpec;
  redisPersistenceSize: string;
  // Vector configuration
  vectorReplicas: number;
  vectorResources: ResourceSpec;
  // Database configuration (for self-hosted Supabase)
  dbResources: ResourceSpec;
  dbPersistenceSize: string;
  // App configuration
  appReplicas: number;
  appResources: ResourceSpec;
}

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
  // Cloud Storage
  s3: {
    name: "AWS S3",
    description: "Store logs in an S3 bucket",
  },
  "azure-blob": {
    name: "Azure Blob Storage",
    description: "Store logs in Azure Blob container",
  },
  gcs: {
    name: "Google Cloud Storage",
    description: "Store logs in a GCS bucket",
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

// Logging destination labels for UI display (shown in the Rulebricks app)
export const LOGGING_DESTINATION_LABELS: Record<LoggingSink, string> = {
  console: "Console (stdout)",
  pending: "External (configuring...)",
  s3: "AWS S3",
  "azure-blob": "Azure Blob Storage",
  gcs: "Google Cloud Storage",
  datadog: "Datadog",
  splunk: "Splunk",
  elasticsearch: "Elasticsearch",
  loki: "Grafana Loki",
  newrelic: "New Relic",
  axiom: "Axiom",
};

// Helper to get logging destination label for Helm values
export function getLoggingDestinationLabel(sink: LoggingSink): string {
  return LOGGING_DESTINATION_LABELS[sink] || "Console (stdout)";
}

// Deployment configuration schema
export const DeploymentConfigSchema = z.object({
  name: z
    .string()
    .min(1)
    .max(63)
    .regex(/^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/),

  // Infrastructure
  infrastructure: z.object({
    mode: z.enum(["existing", "provision"]),
    provider: z.enum(["aws", "gcp", "azure"]).optional(),
    region: z.string().optional(),
    clusterName: z.string().optional(),
    gcpProjectId: z.string().optional(),
    azureResourceGroup: z.string().optional(),
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
    // For existing clusters: does external-dns already exist cluster-wide?
    existingExternalDns: z.boolean().optional(),
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

  // Performance
  tier: z.enum(["small", "medium", "large"]),

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
      // Optional: Prometheus remote write URL (Datadog, Grafana Cloud, etc.)
      remoteWriteUrl: z.string().url().optional(),
    }),
    logging: z.object({
      // Logging always happens to console by default
      // This configures additional external sinks
      sink: z.enum([
        "console",
        "pending",
        "s3",
        "azure-blob",
        "gcs",
        "datadog",
        "splunk",
        "elasticsearch",
        "loki",
        "newrelic",
        "axiom",
      ]),
      // Sink-specific configuration
      // For cloud storage: bucket name and region
      // For platforms: repurposed for credentials (API key) and extra config
      bucket: z.string().optional(),
      region: z.string().optional(),
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

  // Version - app and HPS image versions
  appVersion: z.string().optional(),
  hpsVersion: z.string().optional(),

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
    /** App image version */
    appVersion: string;
    /** HPS image version */
    hpsVersion: string;
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

// App version with matched HPS version
export interface AppVersion {
  /** App image version (e.g., "1.5.0") */
  version: string;
  /** Release date ISO string */
  releaseDate: string;
  /** Matched HPS version (latest HPS released on or before app release) */
  hpsVersion: string | null;
  /** Image digest */
  digest: string;
}

// Wizard step types
export interface WizardStep {
  id: string;
  title: string;
  description: string;
}

export const WIZARD_STEPS: WizardStep[] = [
  { id: "mode", title: "Deployment Mode", description: "Choose how to deploy" },
  {
    id: "cloud",
    title: "Cloud Provider",
    description: "Select your cloud provider",
  },
  {
    id: "domain",
    title: "Domain & DNS",
    description: "Configure your domain and DNS",
  },
  {
    id: "smtp",
    title: "Email (SMTP)",
    description: "Configure email delivery",
  },
  {
    id: "database",
    title: "Database",
    description: "Choose your database setup",
  },
  {
    id: "database-creds",
    title: "Database Credentials",
    description: "Configure database access",
  },
  {
    id: "tier",
    title: "Performance Tier",
    description: "Select your deployment size",
  },
  {
    id: "features",
    title: "Optional Features",
    description: "Enable additional features",
  },
  {
    id: "feature-config",
    title: "Feature Settings",
    description: "Configure enabled features",
  },
  {
    id: "credentials",
    title: "License & Version",
    description: "Enter license and select version",
  },
  {
    id: "review",
    title: "Review & Save",
    description: "Review your configuration",
  },
];

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
  tier: z.enum(["small", "medium", "large"]).optional(),
  databaseType: z.enum(["self-hosted", "supabase-cloud"]).optional(),
  infrastructureMode: z.enum(["existing", "provision"]).optional(),

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
export const HELM_CHART_OCI = "oci://ghcr.io/rulebricks/charts/stack";

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
