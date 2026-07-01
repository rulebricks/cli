import React, { createContext, useContext, useReducer, ReactNode } from "react";
import {
  DeploymentConfig,
  CloudProvider,
  DatabaseType,
  NodeArchitecture,
  SSOProvider,
  DnsProvider,
  KafkaPreset,
  KafkaSaslMechanism,
  LoggingSink,
  CloudLoggingAuthMode,
  ObjectStorageProvider,
  MonitoringDestination,
  RemoteWriteAuthType,
  RemoteWriteDestination,
  EmailSubjects,
  EmailTemplates,
  DEFAULT_EMAIL_SUBJECTS,
  ProfileConfig,
  SecretKeyRef,
  RemoteWriteConfig,
  TracingDestination,
  validateRemoteWriteConfig,
} from "../../types/index.js";
import { generateSecureSecret } from "../../lib/validation.js";

// Partial config during wizard flow
export interface WizardState {
  step: number;
  name: string;

  // Infrastructure
  provider: CloudProvider | null;
  region: string;
  clusterName: string;
  gcpProjectId: string;
  azureResourceGroup: string;

  // Domain & Email
  domain: string;
  adminEmail: string;
  tlsEmail: string;

  // DNS Configuration
  dnsProvider: DnsProvider;
  dnsAutoManage: boolean;

  // SMTP
  smtpHost: string;
  smtpPort: number;
  smtpUser: string;
  smtpPass: string;
  smtpFrom: string;
  smtpFromName: string;

  // Database
  databaseType: DatabaseType | null;
  // Supabase Cloud
  supabaseUrl: string;
  supabaseAnonKey: string;
  supabaseServiceKey: string;
  supabaseAccessToken: string;
  supabaseProjectRef: string;
  // Self-hosted Supabase
  supabaseJwtSecret: string;
  supabaseDbPassword: string;
  supabaseDashboardUser: string;
  supabaseDashboardPass: string;

  // Cluster capabilities (informational; sizing follows chart defaults)
  nodeArchitecture: NodeArchitecture | null;
  arm64TolerationRequired: boolean;
  storageClass: string;
  storageProvisioner: string;
  schedulableNodeCount: number;
  totalCpuCores: number;
  totalMemoryGi: number;
  eligibleCpuCores: number;
  eligibleMemoryGi: number;
  totalPersistentStorageGi: number;

  // Shared object storage (one bucket/container; decision logs + backups are prefixes)
  storageProvider: ObjectStorageProvider | null;
  storageBucket: string;
  storageRegion: string;
  storageCloudAuthMode: CloudLoggingAuthMode;
  storageAwsIamRoleArn: string;
  storageAzureBlobContainer: string;
  storageAzureBlobClientId: string;
  storageAzureBlobTenantId: string;
  storageAzureBlobConnectionStringSecretRef: string;
  storageGcpServiceAccountEmail: string;

  // Features - AI
  aiEnabled: boolean;
  openaiApiKey: string;

  // Features - SSO
  ssoEnabled: boolean;
  ssoProvider: SSOProvider | null;
  ssoUrl: string;
  ssoClientId: string;
  ssoClientSecret: string;

  // Features - Monitoring (Prometheus). In-cluster Prometheus is always
  // installed; this toggle only controls exporting metrics via remote_write.
  clickStackEnabled: boolean;
  clickStackTelemetryRetentionDays: number;
  clickHouseStorageSize: string;
  metricsExportEnabled: boolean;
  prometheusMonitoringDestination: MonitoringDestination | null;
  prometheusRemoteWriteUrl: string;
  prometheusRemoteWriteDestination: RemoteWriteDestination | null;
  prometheusRemoteWriteAuthType: RemoteWriteAuthType | null;
  prometheusRemoteWriteAwsRegion: string;
  prometheusRemoteWriteAwsRoleArn: string;
  prometheusRemoteWriteAzureCloud: "AzurePublic" | "AzureChina" | "AzureGovernment";
  prometheusRemoteWriteClientId: string;
  prometheusRemoteWriteTenantId: string;
  prometheusRemoteWriteSecretRef: string;
  prometheusRemoteWriteUsernameSecretRef: string;
  prometheusRemoteWritePasswordSecretRef: string;
  prometheusRemoteWriteBearerTokenSecretRef: string;

  // Features - Logging (external logging platform; Vector sink). These hold the
  // platform's credential (API key / token / JSON) and an endpoint/site/account
  // detail - NOT an object-storage bucket/region (that lives under storage*).
  // They are persisted to features.logging.bucket/region for compatibility.
  loggingSink: LoggingSink;
  loggingPlatformCredential: string;
  loggingPlatformDetail: string;

  // Features - Distributed Tracing (in-cluster OTel collector -> pluggable
  // backend: Elastic APM, a generic OTLP/HTTP endpoint, or Azure Monitor).
  tracingEnabled: boolean;
  tracingDestination: TracingDestination;
  tracingElasticEndpoint: string;
  tracingElasticAuthMode: "secret-token" | "api-key";
  tracingElasticSecretToken: string;
  tracingElasticApiKey: string;
  // Generic OTLP destination
  tracingOtlpEndpoint: string;
  tracingOtlpAuthMode: "none" | "bearer" | "api-key" | "header";
  tracingOtlpHeaderName: string;
  tracingOtlpToken: string;
  // Azure Monitor destination
  tracingAzureConnectionString: string;

  // Features - Application/container log shipping to Elasticsearch (Vector agent)
  appLogsEnabled: boolean;
  appLogsElasticEndpoint: string;
  appLogsElasticIndex: string;
  appLogsElasticAuthMode: "basic" | "api-key";
  appLogsElasticUsername: string;
  appLogsElasticPassword: string;
  appLogsElasticApiKey: string;

  // Features - Custom Email Templates
  customEmailsEnabled: boolean;
  emailSubjects: EmailSubjects;
  emailTemplates: EmailTemplates;

  // Database backups
  backupEnabled: boolean;
  backupSchedule: string;
  backupRetentionDays: number;

  // External services - Redis
  redisMode: "embedded" | "external";
  redisHost: string;
  redisPort: number;
  redisPassword: string;
  redisExistingSecret: string;
  redisExistingSecretKey: string;
  redisTls: boolean;
  redisHttpApiEnabled: boolean;
  redisHttpApiUrl: string;
  redisHttpApiToken: string;
  valkeyAdminEnabled: boolean;
  valkeyAdminExposure: "internal" | "ingress";
  valkeyAdminHostname: string;
  valkeyAdminBasicAuthUsers: string[];
  valkeyAdminAllowedIPs: string[];
  redisExporterEnabled: boolean;
  kafkaExporterEnabled: boolean;

  // External services - Kafka
  kafkaMode: "embedded" | "external";
  kafkaPreset: KafkaPreset | null;
  kafkaBrokers: string;
  kafkaTopic: string;
  kafkaTopicPrefix: string;
  // Chart auto-creates the required topics on the managed broker (MSK IAM only);
  // false = the operator manages topics themselves (locked-down broker).
  kafkaProvisionTopics: boolean;
  kafkaSsl: boolean;
  kafkaSaslMechanism: KafkaSaslMechanism;
  kafkaSaslRegion: string;
  kafkaSaslUsername: string;
  kafkaSaslPassword: string;
  kafkaSaslExistingSecret: string;
  kafkaIdentityAwsRoleArn: string;
  kafkaIdentityGcpServiceAccountEmail: string;
  kafkaIdentityAzureClientId: string;

  // External services - Postgres (managed external database; AWS/Azure only)
  postgresMode: "embedded" | "external";
  postgresHost: string;
  postgresPort: number;
  postgresDatabase: string;
  postgresMasterUsername: string;
  postgresMasterPassword: string;

  // Credentials
  licenseKey: string;

  // Version - unified product version
  version: string;

  // Legacy chart version (deprecated)
  chartVersion: string;
}

type WizardAction =
  | { type: "SET_STEP"; step: number }
  | { type: "SET_NAME"; name: string }
  | { type: "SET_PROVIDER"; provider: CloudProvider }
  | { type: "SET_REGION"; region: string }
  | { type: "SET_CLUSTER_NAME"; clusterName: string }
  | { type: "SET_GCP_PROJECT"; projectId: string }
  | { type: "SET_AZURE_RG"; resourceGroup: string }
  | { type: "SET_DOMAIN"; domain: string }
  | { type: "SET_ADMIN_EMAIL"; email: string }
  | { type: "SET_DNS_PROVIDER"; provider: DnsProvider }
  | { type: "SET_DNS_AUTO_MANAGE"; autoManage: boolean }
  | {
      type: "SET_SMTP";
      config: Partial<
        Pick<
          WizardState,
          | "smtpHost"
          | "smtpPort"
          | "smtpUser"
          | "smtpPass"
          | "smtpFrom"
          | "smtpFromName"
        >
      >;
    }
  | { type: "SET_DATABASE_TYPE"; dbType: DatabaseType }
  | { type: "SET_SUPABASE_CONFIG"; config: Partial<WizardState> }
  | {
      type: "SET_SUPABASE_SELF_HOSTED";
      config: Partial<
        Pick<
          WizardState,
          | "supabaseJwtSecret"
          | "supabaseDbPassword"
          | "supabaseDashboardUser"
          | "supabaseDashboardPass"
        >
      >;
    }
  | {
      type: "SET_CLUSTER_CAPABILITIES";
      nodeArchitecture: NodeArchitecture;
      arm64TolerationRequired: boolean;
      storageClass?: string;
      storageProvisioner?: string;
      schedulableNodeCount?: number;
      totalCpuCores?: number;
      totalMemoryGi?: number;
      eligibleCpuCores?: number;
      eligibleMemoryGi?: number;
      totalPersistentStorageGi?: number;
    }
  | { type: "SET_AI_ENABLED"; enabled: boolean }
  | { type: "SET_OPENAI_KEY"; key: string }
  | { type: "SET_SSO_ENABLED"; enabled: boolean }
  | {
      type: "SET_SSO_CONFIG";
      config: Partial<
        Pick<
          WizardState,
          "ssoProvider" | "ssoUrl" | "ssoClientId" | "ssoClientSecret"
        >
      >;
    }
  | { type: "SET_CLICKSTACK_ENABLED"; enabled: boolean }
  | {
      type: "SET_CLICKSTACK_CONFIG";
      config: Partial<
        Pick<
          WizardState,
          | "clickStackTelemetryRetentionDays"
          | "clickHouseStorageSize"
        >
      >;
    }
  | { type: "SET_METRICS_EXPORT"; enabled: boolean }
  | { type: "SET_PROMETHEUS_REMOTE_WRITE"; url: string }
  | {
      type: "SET_PROMETHEUS_REMOTE_WRITE_CONFIG";
      config: Partial<
        Pick<
          WizardState,
          | "prometheusMonitoringDestination"
          | "prometheusRemoteWriteDestination"
          | "prometheusRemoteWriteAuthType"
          | "prometheusRemoteWriteAwsRegion"
          | "prometheusRemoteWriteAwsRoleArn"
          | "prometheusRemoteWriteAzureCloud"
          | "prometheusRemoteWriteClientId"
          | "prometheusRemoteWriteTenantId"
          | "prometheusRemoteWriteSecretRef"
          | "prometheusRemoteWriteUsernameSecretRef"
          | "prometheusRemoteWritePasswordSecretRef"
          | "prometheusRemoteWriteBearerTokenSecretRef"
        >
      >;
    }
  | { type: "SET_LOGGING_SINK"; sink: LoggingSink }
  | {
      type: "SET_STORAGE_CONFIG";
      config: Partial<
        Pick<
          WizardState,
          | "storageProvider"
          | "storageBucket"
          | "storageRegion"
          | "storageCloudAuthMode"
          | "storageAwsIamRoleArn"
          | "storageAzureBlobContainer"
          | "storageAzureBlobClientId"
          | "storageAzureBlobTenantId"
          | "storageAzureBlobConnectionStringSecretRef"
          | "storageGcpServiceAccountEmail"
        >
      >;
    }
  | {
      type: "SET_LOGGING_CONFIG";
      config: Partial<
        Pick<WizardState, "loggingPlatformCredential" | "loggingPlatformDetail">
      >;
    }
  | { type: "SET_TRACING_ENABLED"; enabled: boolean }
  | {
      type: "SET_TRACING_CONFIG";
      config: Partial<
        Pick<
          WizardState,
          | "tracingDestination"
          | "tracingElasticEndpoint"
          | "tracingElasticAuthMode"
          | "tracingElasticSecretToken"
          | "tracingElasticApiKey"
          | "tracingOtlpEndpoint"
          | "tracingOtlpAuthMode"
          | "tracingOtlpHeaderName"
          | "tracingOtlpToken"
          | "tracingAzureConnectionString"
        >
      >;
    }
  | { type: "SET_APP_LOGS_ENABLED"; enabled: boolean }
  | {
      type: "SET_APP_LOGS_CONFIG";
      config: Partial<
        Pick<
          WizardState,
          | "appLogsElasticEndpoint"
          | "appLogsElasticIndex"
          | "appLogsElasticAuthMode"
          | "appLogsElasticUsername"
          | "appLogsElasticPassword"
          | "appLogsElasticApiKey"
        >
      >;
    }
  | { type: "SET_BACKUP_ENABLED"; enabled: boolean }
  | { type: "SET_BACKUP_SCHEDULE"; schedule: string }
  | { type: "SET_BACKUP_RETENTION_DAYS"; retentionDays: number }
  | {
      type: "SET_EXTERNAL_SERVICES";
      config: Partial<
        Pick<
          WizardState,
          | "redisMode"
          | "redisHost"
          | "redisPort"
          | "redisPassword"
          | "redisExistingSecret"
          | "redisExistingSecretKey"
          | "redisTls"
          | "redisHttpApiEnabled"
          | "redisHttpApiUrl"
          | "redisHttpApiToken"
          | "valkeyAdminEnabled"
          | "valkeyAdminExposure"
          | "valkeyAdminHostname"
          | "valkeyAdminBasicAuthUsers"
          | "valkeyAdminAllowedIPs"
          | "redisExporterEnabled"
          | "kafkaExporterEnabled"
          | "kafkaMode"
          | "kafkaPreset"
          | "kafkaBrokers"
          | "kafkaTopic"
          | "kafkaTopicPrefix"
          | "kafkaProvisionTopics"
          | "kafkaSsl"
          | "kafkaSaslMechanism"
          | "kafkaSaslRegion"
          | "kafkaSaslUsername"
          | "kafkaSaslPassword"
          | "kafkaSaslExistingSecret"
          | "kafkaIdentityAwsRoleArn"
          | "kafkaIdentityGcpServiceAccountEmail"
          | "kafkaIdentityAzureClientId"
          | "postgresMode"
          | "postgresHost"
          | "postgresPort"
          | "postgresDatabase"
          | "postgresMasterUsername"
          | "postgresMasterPassword"
        >
      >;
    }
  | { type: "SET_CUSTOM_EMAILS_ENABLED"; enabled: boolean }
  | { type: "SET_EMAIL_SUBJECTS"; subjects: Partial<EmailSubjects> }
  | { type: "SET_EMAIL_TEMPLATES"; templates: Partial<EmailTemplates> }
  | { type: "SET_LICENSE_KEY"; key: string }
  | { type: "SET_VERSION"; version: string }
  | { type: "SET_CHART_VERSION"; version: string }
  | { type: "NEXT_STEP" }
  | { type: "PREV_STEP" };

/**
 * Creates the initial wizard state, optionally pre-populated from a user profile.
 * Profile values are used as defaults that the user can still modify.
 */
function getInitialState(profile?: ProfileConfig | null): WizardState {
  return {
    step: 0,
    name: "",

    // Infrastructure - pre-populate from profile
    provider: profile?.provider ?? null,
    region: profile?.region ?? "",
    clusterName: profile?.clusterName ?? "",
    gcpProjectId: "",
    azureResourceGroup: "",

    // Domain & Email - pre-populate from profile
    domain: "", // Domain is intentionally left empty - user should enter unique domain per deployment
    adminEmail: profile?.adminEmail ?? "",
    // The TLS email is no longer asked in the wizard; it defaults to the admin
    // email in toConfig. Only an existing config (redeploy) can carry a custom
    // value, so it is intentionally not pre-populated from the profile.
    tlsEmail: "",

    // DNS Configuration - pre-populate from profile
    dnsProvider: profile?.dnsProvider ?? "other",
    dnsAutoManage: false,

    // SMTP - pre-populate from profile
    smtpHost: profile?.smtpHost ?? "",
    smtpPort: profile?.smtpPort ?? 587,
    smtpUser: profile?.smtpUser ?? "",
    smtpPass: profile?.smtpPass ?? "",
    smtpFrom: profile?.smtpFrom ?? "",
    smtpFromName: profile?.smtpFromName ?? "Rulebricks",

    // Database - pre-populate from profile
    databaseType: profile?.databaseType ?? null,
    supabaseUrl: "",
    supabaseAnonKey: "",
    supabaseServiceKey: "",
    supabaseAccessToken: "",
    supabaseProjectRef: "",
    supabaseJwtSecret: generateSecureSecret(64),
    supabaseDbPassword: "",
    supabaseDashboardUser: "supabase",
    supabaseDashboardPass: "",

    // Cluster capabilities (populated by the cluster scan)
    nodeArchitecture: null,
    arm64TolerationRequired: false,
    storageClass: "",
    storageProvisioner: "",
    schedulableNodeCount: 0,
    totalCpuCores: 0,
    totalMemoryGi: 0,
    eligibleCpuCores: 0,
    eligibleMemoryGi: 0,
    totalPersistentStorageGi: 0,

    // Shared object storage
    storageProvider: profile?.storage?.provider ?? null,
    storageBucket: profile?.storage?.bucket ?? "",
    storageRegion: profile?.storage?.region ?? "",
    storageCloudAuthMode: profile?.storage?.cloudAuthMode ?? "workload-identity",
    storageAwsIamRoleArn: profile?.storage?.awsIamRoleArn ?? "",
    storageAzureBlobContainer:
      profile?.storage?.azureBlobContainer ?? "rulebricks",
    storageAzureBlobClientId: profile?.storage?.azureBlobClientId ?? "",
    storageAzureBlobTenantId: profile?.storage?.azureBlobTenantId ?? "",
    storageAzureBlobConnectionStringSecretRef:
      profile?.storage?.azureBlobConnectionStringSecretRef
        ? `${profile.storage.azureBlobConnectionStringSecretRef.name}:${profile.storage.azureBlobConnectionStringSecretRef.key}`
        : "",
    storageGcpServiceAccountEmail:
      profile?.storage?.gcpServiceAccountEmail ?? "",

    // Features - AI - pre-populate from profile
    aiEnabled: !!profile?.openaiApiKey,
    openaiApiKey: profile?.openaiApiKey ?? "",

    // Features - SSO - pre-populate from profile
    ssoEnabled: !!profile?.ssoProvider,
    ssoProvider: profile?.ssoProvider ?? null,
    ssoUrl: profile?.ssoUrl ?? "",
    ssoClientId: profile?.ssoClientId ?? "",
    ssoClientSecret: profile?.ssoClientSecret ?? "",

    // Features - Monitoring (metrics export is opt-in; in-cluster Prometheus
    // is always installed)
    clickStackEnabled: true,
    clickStackTelemetryRetentionDays: 7,
    clickHouseStorageSize: "100Gi",
    metricsExportEnabled: false,
    prometheusMonitoringDestination: null,
    prometheusRemoteWriteUrl: "",
    prometheusRemoteWriteDestination: null,
    prometheusRemoteWriteAuthType: null,
    prometheusRemoteWriteAwsRegion: "",
    prometheusRemoteWriteAwsRoleArn: "",
    prometheusRemoteWriteAzureCloud: "AzurePublic",
    prometheusRemoteWriteClientId: "",
    prometheusRemoteWriteTenantId: "",
    prometheusRemoteWriteSecretRef: "",
    prometheusRemoteWriteUsernameSecretRef: "",
    prometheusRemoteWritePasswordSecretRef: "",
    prometheusRemoteWriteBearerTokenSecretRef: "",

    // Features - Logging
    loggingSink: "console", // Default to console only
    loggingPlatformCredential: "",
    loggingPlatformDetail: "",

    // Features - Distributed Tracing
    tracingEnabled: false,
    tracingDestination: "elastic",
    tracingElasticEndpoint: "",
    tracingElasticAuthMode: "secret-token",
    tracingElasticSecretToken: "",
    tracingElasticApiKey: "",
    tracingOtlpEndpoint: "",
    tracingOtlpAuthMode: "none",
    tracingOtlpHeaderName: "Authorization",
    tracingOtlpToken: "",
    tracingAzureConnectionString: "",

    // Features - Application log shipping
    appLogsEnabled: false,
    appLogsElasticEndpoint: "",
    appLogsElasticIndex: "rulebricks-app-logs",
    appLogsElasticAuthMode: "basic",
    appLogsElasticUsername: "",
    appLogsElasticPassword: "",
    appLogsElasticApiKey: "",

    // Features - Custom Email Templates
    customEmailsEnabled: false,
    emailSubjects: { ...DEFAULT_EMAIL_SUBJECTS },
    emailTemplates: {
      invite: "",
      confirmation: "",
      recovery: "",
      emailChange: "",
    },

    // Database backups
    backupEnabled: false,
    backupSchedule: "0 2 * * *",
    backupRetentionDays: 7,

    // External services - Redis (default to in-cluster)
    redisMode: "embedded",
    redisHost: "",
    redisPort: 6379,
    redisPassword: "",
    redisExistingSecret: "",
    redisExistingSecretKey: "redis-password",
    redisTls: false,
    redisHttpApiEnabled: false,
    redisHttpApiUrl: "",
    redisHttpApiToken: "",
    valkeyAdminEnabled: false,
    valkeyAdminExposure: "internal",
    valkeyAdminHostname: "",
    valkeyAdminBasicAuthUsers: [],
    valkeyAdminAllowedIPs: [],
    redisExporterEnabled: false,
    kafkaExporterEnabled: false,

    // External services - Kafka (default to in-cluster)
    kafkaMode: "embedded",
    kafkaPreset: null,
    kafkaBrokers: "",
    kafkaTopic: "logs",
    kafkaTopicPrefix: "com.rulebricks.",
    kafkaProvisionTopics: true,
    kafkaSsl: false,
    kafkaSaslMechanism: "",
    kafkaSaslRegion: "",
    kafkaSaslUsername: "",
    kafkaSaslPassword: "",
    kafkaSaslExistingSecret: "",
    kafkaIdentityAwsRoleArn: "",
    kafkaIdentityGcpServiceAccountEmail: "",
    kafkaIdentityAzureClientId: "",

    // External services - Postgres
    postgresMode: "embedded",
    postgresHost: "",
    postgresPort: 5432,
    postgresDatabase: "postgres",
    postgresMasterUsername: "postgres",
    postgresMasterPassword: "",

    // Credentials - pre-populate from profile
    licenseKey: profile?.licenseKey ?? "",

    // Version
    version: "",
    chartVersion: "",
  };
}

// Default initial state (for backwards compatibility)
const initialState: WizardState = getInitialState();

/**
 * Derives the Supabase project ref from a managed-Supabase project URL
 * (https://<ref>.supabase.co), so the wizard never has to ask for it.
 * Returns undefined for custom domains, where the ref can't be inferred.
 */
function deriveSupabaseProjectRef(url: string): string | undefined {
  const match = url
    .trim()
    .match(/^https?:\/\/([a-z0-9-]+)\.supabase\.(?:co|com|in)(?:[/:]|$)/i);
  return match ? match[1].toLowerCase() : undefined;
}

function parseSecretKeyRef(value: string) {
  const [name, key] = value.split(":").map((part) => part.trim());
  if (!name || !key) return undefined;
  return { name, key };
}

function formatSecretKeyRef(ref?: SecretKeyRef): string {
  return ref ? `${ref.name}:${ref.key}` : "";
}

/**
 * Builds the externalServices config from wizard state. Returns undefined when
 * both Redis and Kafka use the in-cluster defaults so configs stay clean.
 */
function buildExternalServices(
  state: WizardState,
): DeploymentConfig["externalServices"] {
  const redisExternal = state.redisMode === "external";
  const kafkaExternal = state.kafkaMode === "external";
  const postgresExternal = state.postgresMode === "external";
  if (!redisExternal && !kafkaExternal && !postgresExternal) {
    return undefined;
  }

  return {
    redis: {
      mode: state.redisMode,
      external: redisExternal
        ? {
            host: state.redisHost.trim() || undefined,
            port: state.redisPort || undefined,
            password: state.redisPassword || undefined,
            existingSecret: state.redisExistingSecret.trim() || undefined,
            existingSecretKey:
              state.redisExistingSecret.trim() && state.redisExistingSecretKey
                ? state.redisExistingSecretKey
                : undefined,
            tls: state.redisTls,
            httpApi: state.redisHttpApiEnabled
              ? {
                  enabled: true,
                  url: state.redisHttpApiUrl.trim() || undefined,
                  token: state.redisHttpApiToken || undefined,
                }
              : undefined,
          }
        : undefined,
    },
    kafka: {
      mode: state.kafkaMode,
      external: kafkaExternal
        ? {
            preset: state.kafkaPreset ?? "custom",
            brokers: state.kafkaBrokers.trim() || undefined,
            topic: state.kafkaTopic.trim() || undefined,
            // Always emit the prefix (incl. "") so the choice round-trips and the
            // chart doesn't silently fall back to its default.
            topicPrefix: state.kafkaTopicPrefix,
            provisionTopics: state.kafkaProvisionTopics,
            ssl: state.kafkaSsl,
            sasl: state.kafkaSaslMechanism
              ? {
                  mechanism: state.kafkaSaslMechanism,
                  region: state.kafkaSaslRegion.trim() || undefined,
                  username: state.kafkaSaslUsername || undefined,
                  password: state.kafkaSaslPassword || undefined,
                  existingSecret:
                    state.kafkaSaslExistingSecret.trim() || undefined,
                }
              : undefined,
            identity: buildKafkaIdentity(state),
          }
        : undefined,
    },
    postgres: {
      mode: state.postgresMode,
      external: postgresExternal
        ? {
            provider:
              state.provider === "aws" || state.provider === "azure"
                ? state.provider
                : undefined,
            host: state.postgresHost.trim() || undefined,
            port: state.postgresPort || undefined,
            database: state.postgresDatabase.trim() || undefined,
            // One-time creds for the chart's bootstrap hook. The shared
            // service-role password is sourced separately from the Supabase DB
            // password (secret.db) so it matches what the services present.
            bootstrap: {
              enabled: true,
              masterUsername: state.postgresMasterUsername.trim() || undefined,
              masterPassword: state.postgresMasterPassword || undefined,
              appRole: "postgres",
            },
          }
        : undefined,
    },
  };
}

/**
 * Collects the cloud workload identity for token-based Kafka auth. Returns
 * undefined when no identity is provided (e.g. Azure Event Hubs PLAIN).
 */
function buildKafkaIdentity(state: WizardState) {
  const awsRoleArn = state.kafkaIdentityAwsRoleArn.trim();
  const gcpServiceAccountEmail =
    state.kafkaIdentityGcpServiceAccountEmail.trim();
  const azureClientId = state.kafkaIdentityAzureClientId.trim();
  if (!awsRoleArn && !gcpServiceAccountEmail && !azureClientId) {
    return undefined;
  }
  return {
    awsRoleArn: awsRoleArn || undefined,
    gcpServiceAccountEmail: gcpServiceAccountEmail || undefined,
    azureClientId: azureClientId || undefined,
  };
}

/**
 * Builds the Prometheus remote_write config from wizard state. Metrics reuse the
 * single Rulebricks identity chosen in the Storage step, so Azure/AWS principals
 * fall back to the storage identity when not set explicitly.
 */
function buildRemoteWriteFromState(
  state: WizardState,
): RemoteWriteConfig | undefined {
  if (
    state.prometheusMonitoringDestination === "local-grafana" ||
    !state.prometheusRemoteWriteDestination ||
    !state.prometheusRemoteWriteUrl
  ) {
    return undefined;
  }
  return {
    destination: state.prometheusRemoteWriteDestination,
    url: state.prometheusRemoteWriteUrl,
    authType:
      state.prometheusRemoteWriteAuthType ||
      (state.prometheusRemoteWriteDestination === "azure-monitor"
        ? "managed-identity"
        : undefined),
    awsRegion:
      state.prometheusRemoteWriteDestination === "aws-amp"
        ? state.prometheusRemoteWriteAwsRegion || state.region || undefined
        : undefined,
    awsRoleArn:
      state.prometheusRemoteWriteDestination === "aws-amp"
        ? state.prometheusRemoteWriteAwsRoleArn ||
          state.storageAwsIamRoleArn ||
          undefined
        : undefined,
    azureCloud: state.prometheusRemoteWriteAzureCloud,
    clientId:
      state.prometheusRemoteWriteDestination === "azure-monitor"
        ? state.prometheusRemoteWriteClientId ||
          state.storageAzureBlobClientId ||
          undefined
        : state.prometheusRemoteWriteClientId || undefined,
    tenantId:
      state.prometheusRemoteWriteDestination === "azure-monitor"
        ? state.prometheusRemoteWriteTenantId ||
          state.storageAzureBlobTenantId ||
          undefined
        : state.prometheusRemoteWriteTenantId || undefined,
    clientSecretRef: parseSecretKeyRef(state.prometheusRemoteWriteSecretRef),
    usernameSecretRef: parseSecretKeyRef(
      state.prometheusRemoteWriteUsernameSecretRef,
    ),
    passwordSecretRef: parseSecretKeyRef(
      state.prometheusRemoteWritePasswordSecretRef,
    ),
    bearerTokenSecretRef: parseSecretKeyRef(
      state.prometheusRemoteWriteBearerTokenSecretRef,
    ),
  };
}

/**
 * Returns a list of human-readable reasons the wizard state can't be saved as a
 * valid DeploymentConfig. Empty array means it's good to save. Shared by toConfig
 * (which returns null when non-empty) and the review screen (which shows them),
 * so users get a specific reason instead of a generic "invalid configuration".
 */
export function collectConfigIssues(state: WizardState): string[] {
  const issues: string[] = [];

  if (!state.name) issues.push("Deployment name is required.");
  if (!state.domain) issues.push("Domain is required.");
  if (!state.adminEmail) issues.push("Admin email is required.");
  if (!state.licenseKey) issues.push("License key is required.");

  if (!state.smtpHost || !state.smtpUser || !state.smtpPass || !state.smtpFrom) {
    issues.push("SMTP host, user, password, and from address are required.");
  }

  if (state.databaseType === "supabase-cloud") {
    if (
      !state.supabaseUrl ||
      !state.supabaseAnonKey ||
      !state.supabaseServiceKey ||
      !state.supabaseAccessToken
    ) {
      issues.push(
        "Managed Supabase requires a project URL, anon key, service key, and access token.",
      );
    }
  } else if (state.databaseType === "self-hosted") {
    if (!state.supabaseJwtSecret) {
      issues.push("Self-hosted Supabase requires a JWT secret.");
    }
    if (!state.supabaseDbPassword) {
      issues.push("Self-hosted Supabase requires a database password.");
    }
  }

  if (state.aiEnabled && !state.openaiApiKey) {
    issues.push("AI is enabled but the OpenAI API key is missing.");
  }
  if (
    state.ssoEnabled &&
    (!state.ssoProvider || !state.ssoClientId || !state.ssoClientSecret)
  ) {
    issues.push(
      "SSO is enabled but the provider, client ID, or client secret is missing.",
    );
  }

  if (
    state.loggingSink !== "console" &&
    state.loggingSink !== "pending" &&
    !state.loggingPlatformCredential
  ) {
    issues.push(
      "The selected logging platform is missing its credentials/endpoint.",
    );
  }

  if (!state.clickStackEnabled && state.tracingEnabled) {
    if (state.tracingDestination === "elastic") {
      if (!state.tracingElasticEndpoint) {
        issues.push(
          "Distributed tracing is enabled but the Elastic APM endpoint is missing.",
        );
      }
      if (
        state.tracingElasticAuthMode === "secret-token" &&
        !state.tracingElasticSecretToken
      ) {
        issues.push(
          "Distributed tracing (secret-token auth) is missing the Elastic APM secret token.",
        );
      }
      if (
        state.tracingElasticAuthMode === "api-key" &&
        !state.tracingElasticApiKey
      ) {
        issues.push(
          "Distributed tracing (API key auth) is missing the Elastic APM API key.",
        );
      }
    } else if (state.tracingDestination === "otlp") {
      if (!state.tracingOtlpEndpoint) {
        issues.push(
          "Distributed tracing is enabled but the OTLP endpoint is missing.",
        );
      }
      if (state.tracingOtlpAuthMode !== "none" && !state.tracingOtlpToken) {
        issues.push(
          "Distributed tracing (OTLP) is missing its authentication credential.",
        );
      }
    } else if (state.tracingDestination === "azure-monitor") {
      if (!state.tracingAzureConnectionString) {
        issues.push(
          "Distributed tracing is enabled but the Azure Monitor connection string is missing.",
        );
      }
    }
  }

  if (!state.clickStackEnabled && state.appLogsEnabled) {
    if (!state.appLogsElasticEndpoint) {
      issues.push(
        "Application log shipping is enabled but the Elasticsearch endpoint is missing.",
      );
    }
    if (
      state.appLogsElasticAuthMode === "basic" &&
      (!state.appLogsElasticUsername || !state.appLogsElasticPassword)
    ) {
      issues.push(
        "Application log shipping (basic auth) is missing the Elasticsearch username or password.",
      );
    }
    if (
      state.appLogsElasticAuthMode === "api-key" &&
      !state.appLogsElasticApiKey
    ) {
      issues.push(
        "Application log shipping (API key auth) is missing the Elasticsearch API key.",
      );
    }
  }

  if (!state.storageProvider || !state.storageBucket || !state.storageRegion) {
    issues.push(
      "Object storage provider, bucket/account, and region are required.",
    );
  }
  if (state.storageProvider === "s3" && !state.storageAwsIamRoleArn) {
    issues.push("S3 storage requires an IAM role (IRSA).");
  }
  if (state.storageProvider === "azure-blob") {
    if (!state.storageAzureBlobContainer) {
      issues.push("Azure Blob storage requires a container name.");
    }
    if (
      state.storageCloudAuthMode === "workload-identity" &&
      (!state.storageAzureBlobClientId || !state.storageAzureBlobTenantId)
    ) {
      issues.push(
        "Azure Blob workload identity requires a client ID and tenant ID.",
      );
    }
    if (
      state.storageCloudAuthMode === "secret" &&
      !parseSecretKeyRef(state.storageAzureBlobConnectionStringSecretRef)
    ) {
      issues.push(
        "Azure Blob connection-string auth requires a secret reference (name:key).",
      );
    }
  }
  if (state.storageProvider === "gcs" && !state.storageGcpServiceAccountEmail) {
    issues.push("GCS storage requires a Google service account email.");
  }

  if (state.redisMode === "external" && !state.redisHost.trim()) {
    issues.push("External Redis requires a host.");
  }
  if (state.kafkaMode === "external" && !state.kafkaBrokers.trim()) {
    issues.push("External Kafka requires brokers.");
  }
  if (state.postgresMode === "external") {
    if (!state.postgresHost.trim()) {
      issues.push("External Postgres requires a host.");
    }
    if (!state.postgresMasterPassword) {
      issues.push(
        "External Postgres requires master credentials to initialize the database.",
      );
    }
  }

  if (!state.clickStackEnabled && state.metricsExportEnabled) {
    const remoteWrite = buildRemoteWriteFromState(state);
    if (!remoteWrite) {
      issues.push(
        "Metrics export is enabled but the Prometheus remote_write destination is not configured.",
      );
    } else {
      for (const message of validateRemoteWriteConfig(remoteWrite)) {
        issues.push(message);
      }
    }
  }

  if (
    state.valkeyAdminEnabled &&
    state.valkeyAdminExposure === "ingress" &&
    state.valkeyAdminBasicAuthUsers.length === 0
  ) {
    issues.push(
      "Valkey Admin ingress exposure requires at least one htpasswd BasicAuth user.",
    );
  }

  return issues;
}

export function configToWizardState(
  config: DeploymentConfig,
  profile?: ProfileConfig | null,
): WizardState {
  const base = getInitialState(profile);
  const remoteWrite = config.features.monitoring.remoteWrite;
  const storage = config.storage;
  const customEmails = config.features.customEmails;
  const externalRedis = config.externalServices?.redis;
  const externalKafka = config.externalServices?.kafka;
  const externalPostgres = config.externalServices?.postgres;

  return {
    ...base,
    name: config.name,
    provider: config.infrastructure.provider ?? base.provider,
    region: config.infrastructure.region ?? base.region,
    clusterName: config.infrastructure.clusterName ?? base.clusterName,
    gcpProjectId: config.infrastructure.gcpProjectId ?? "",
    azureResourceGroup: config.infrastructure.azureResourceGroup ?? "",
    domain: config.domain,
    adminEmail: config.adminEmail,
    tlsEmail: config.tlsEmail,
    dnsProvider: config.dns.provider,
    dnsAutoManage: config.dns.autoManage,
    smtpHost: config.smtp.host,
    smtpPort: config.smtp.port,
    smtpUser: config.smtp.user,
    smtpPass: config.smtp.pass,
    smtpFrom: config.smtp.from,
    smtpFromName: config.smtp.fromName,
    databaseType: config.database.type,
    supabaseUrl: config.database.supabaseUrl ?? "",
    supabaseAnonKey: config.database.supabaseAnonKey ?? "",
    supabaseServiceKey: config.database.supabaseServiceKey ?? "",
    supabaseAccessToken: config.database.supabaseAccessToken ?? "",
    supabaseProjectRef: config.database.supabaseProjectRef ?? "",
    supabaseJwtSecret:
      config.database.type === "self-hosted"
        ? config.database.supabaseJwtSecret || base.supabaseJwtSecret
        : config.database.supabaseJwtSecret ?? "",
    supabaseDbPassword: config.database.supabaseDbPassword ?? "",
    supabaseDashboardUser:
      config.database.supabaseDashboardUser ?? base.supabaseDashboardUser,
    supabaseDashboardPass: config.database.supabaseDashboardPass ?? "",
    nodeArchitecture: config.infrastructure.nodeArchitecture ?? null,
    arm64TolerationRequired:
      config.infrastructure.arm64TolerationRequired ?? false,
    storageClass: config.infrastructure.storageClass ?? "",
    storageProvisioner: config.infrastructure.storageProvisioner ?? "",
    schedulableNodeCount: config.infrastructure.schedulableNodeCount ?? 0,
    totalCpuCores: config.infrastructure.totalCpuCores ?? 0,
    totalMemoryGi: config.infrastructure.totalMemoryGi ?? 0,
    eligibleCpuCores: config.infrastructure.eligibleCpuCores ?? 0,
    eligibleMemoryGi: config.infrastructure.eligibleMemoryGi ?? 0,
    totalPersistentStorageGi:
      config.infrastructure.totalPersistentStorageGi ?? 0,
    storageProvider: storage?.provider ?? base.storageProvider,
    storageBucket: storage?.bucket ?? "",
    storageRegion: storage?.region ?? "",
    storageCloudAuthMode:
      storage?.cloudAuthMode ?? base.storageCloudAuthMode,
    storageAwsIamRoleArn: storage?.awsIamRoleArn ?? "",
    storageAzureBlobContainer:
      storage?.azureBlobContainer ?? base.storageAzureBlobContainer,
    storageAzureBlobClientId: storage?.azureBlobClientId ?? "",
    storageAzureBlobTenantId: storage?.azureBlobTenantId ?? "",
    storageAzureBlobConnectionStringSecretRef: formatSecretKeyRef(
      storage?.azureBlobConnectionStringSecretRef,
    ),
    storageGcpServiceAccountEmail: storage?.gcpServiceAccountEmail ?? "",
    aiEnabled: config.features.ai.enabled,
    openaiApiKey: config.features.ai.openaiApiKey ?? "",
    ssoEnabled: config.features.sso.enabled,
    ssoProvider: config.features.sso.provider ?? null,
    ssoUrl: config.features.sso.url ?? "",
    ssoClientId: config.features.sso.clientId ?? "",
    ssoClientSecret: config.features.sso.clientSecret ?? "",
    clickStackEnabled:
      config.features.observability?.clickstack?.enabled ?? true,
    clickStackTelemetryRetentionDays:
      config.features.observability?.clickstack?.telemetryRetentionDays ??
      base.clickStackTelemetryRetentionDays,
    clickHouseStorageSize:
      config.features.observability?.clickstack?.clickHouseStorageSize ??
      base.clickHouseStorageSize,
    // The toggle reflects whether remote_write is actually configured, so a
    // redeploy resumes with the metrics-export sub-flow only when in use.
    metricsExportEnabled: !!(
      remoteWrite || config.features.monitoring.remoteWriteUrl
    ),
    prometheusMonitoringDestination:
      config.features.monitoring.destination ?? null,
    prometheusRemoteWriteUrl:
      remoteWrite?.url ?? config.features.monitoring.remoteWriteUrl ?? "",
    prometheusRemoteWriteDestination: remoteWrite?.destination ?? null,
    prometheusRemoteWriteAuthType: remoteWrite?.authType ?? null,
    prometheusRemoteWriteAwsRegion: remoteWrite?.awsRegion ?? "",
    prometheusRemoteWriteAwsRoleArn: remoteWrite?.awsRoleArn ?? "",
    prometheusRemoteWriteAzureCloud:
      remoteWrite?.azureCloud ?? base.prometheusRemoteWriteAzureCloud,
    prometheusRemoteWriteClientId: remoteWrite?.clientId ?? "",
    prometheusRemoteWriteTenantId: remoteWrite?.tenantId ?? "",
    prometheusRemoteWriteSecretRef: formatSecretKeyRef(
      remoteWrite?.clientSecretRef,
    ),
    prometheusRemoteWriteUsernameSecretRef: formatSecretKeyRef(
      remoteWrite?.usernameSecretRef,
    ),
    prometheusRemoteWritePasswordSecretRef: formatSecretKeyRef(
      remoteWrite?.passwordSecretRef,
    ),
    prometheusRemoteWriteBearerTokenSecretRef: formatSecretKeyRef(
      remoteWrite?.bearerTokenSecretRef,
    ),
    loggingSink: config.features.logging.sink,
    loggingPlatformCredential: config.features.logging.bucket ?? "",
    loggingPlatformDetail: config.features.logging.region ?? "",
    // Distributed tracing (Elastic APM / generic OTLP / Azure Monitor)
    tracingEnabled: config.features.tracing?.enabled ?? false,
    tracingDestination: config.features.tracing?.destination ?? "elastic",
    tracingElasticEndpoint: config.features.tracing?.elastic?.endpoint ?? "",
    tracingElasticAuthMode:
      config.features.tracing?.elastic?.authMode === "api-key"
        ? "api-key"
        : "secret-token",
    tracingElasticSecretToken:
      config.features.tracing?.elastic?.secretToken ?? "",
    tracingElasticApiKey: config.features.tracing?.elastic?.apiKey ?? "",
    tracingOtlpEndpoint: config.features.tracing?.otlp?.endpoint ?? "",
    tracingOtlpAuthMode: config.features.tracing?.otlp?.authMode ?? "none",
    tracingOtlpHeaderName:
      config.features.tracing?.otlp?.headerName ?? "Authorization",
    tracingOtlpToken:
      config.features.tracing?.otlp?.token ??
      config.features.tracing?.otlp?.apiKey ??
      config.features.tracing?.otlp?.headerValue ??
      "",
    tracingAzureConnectionString:
      config.features.tracing?.azureMonitor?.connectionString ?? "",
    // Application log shipping (Elasticsearch via Vector agent)
    appLogsEnabled: config.features.logging.appLogs?.enabled ?? false,
    appLogsElasticEndpoint:
      config.features.logging.appLogs?.elasticsearch?.endpoint ?? "",
    appLogsElasticIndex:
      config.features.logging.appLogs?.elasticsearch?.index ??
      base.appLogsElasticIndex,
    appLogsElasticAuthMode:
      config.features.logging.appLogs?.elasticsearch?.authMode === "api-key"
        ? "api-key"
        : "basic",
    appLogsElasticUsername:
      config.features.logging.appLogs?.elasticsearch?.username ?? "",
    appLogsElasticPassword:
      config.features.logging.appLogs?.elasticsearch?.password ?? "",
    appLogsElasticApiKey:
      config.features.logging.appLogs?.elasticsearch?.apiKey ?? "",
    customEmailsEnabled: customEmails?.enabled ?? false,
    emailSubjects: customEmails?.subjects ?? base.emailSubjects,
    emailTemplates: customEmails?.templates ?? base.emailTemplates,
    backupEnabled: config.backup?.enabled ?? false,
    backupSchedule: config.backup?.schedule ?? base.backupSchedule,
    backupRetentionDays:
      config.backup?.retentionDays ?? base.backupRetentionDays,
    // External services - Redis
    redisMode: externalRedis?.mode ?? base.redisMode,
    redisHost: externalRedis?.external?.host ?? base.redisHost,
    redisPort: externalRedis?.external?.port ?? base.redisPort,
    redisPassword: externalRedis?.external?.password ?? base.redisPassword,
    redisExistingSecret:
      externalRedis?.external?.existingSecret ?? base.redisExistingSecret,
    redisExistingSecretKey:
      externalRedis?.external?.existingSecretKey ?? base.redisExistingSecretKey,
    redisTls: externalRedis?.external?.tls ?? base.redisTls,
    redisHttpApiEnabled:
      externalRedis?.external?.httpApi?.enabled ?? base.redisHttpApiEnabled,
    redisHttpApiUrl:
      externalRedis?.external?.httpApi?.url ?? base.redisHttpApiUrl,
    redisHttpApiToken:
      externalRedis?.external?.httpApi?.token ?? base.redisHttpApiToken,
    valkeyAdminEnabled:
      config.features.cache?.valkeyAdmin?.enabled ?? base.valkeyAdminEnabled,
    valkeyAdminExposure:
      config.features.cache?.valkeyAdmin?.exposure ?? base.valkeyAdminExposure,
    valkeyAdminHostname:
      config.features.cache?.valkeyAdmin?.hostname ?? base.valkeyAdminHostname,
    valkeyAdminBasicAuthUsers:
      config.features.cache?.valkeyAdmin?.basicAuthUsers ??
      base.valkeyAdminBasicAuthUsers,
    valkeyAdminAllowedIPs:
      config.features.cache?.valkeyAdmin?.allowedIPs ??
      base.valkeyAdminAllowedIPs,
    redisExporterEnabled:
      config.features.cache?.redisExporter?.enabled ??
      base.redisExporterEnabled,
    kafkaExporterEnabled:
      config.features.cache?.kafkaExporter?.enabled ??
      base.kafkaExporterEnabled,
    // External services - Kafka
    kafkaMode: externalKafka?.mode ?? base.kafkaMode,
    kafkaPreset: externalKafka?.external?.preset ?? base.kafkaPreset,
    kafkaBrokers: externalKafka?.external?.brokers ?? base.kafkaBrokers,
    kafkaTopic: externalKafka?.external?.topic ?? base.kafkaTopic,
    kafkaTopicPrefix:
      externalKafka?.external?.topicPrefix ?? base.kafkaTopicPrefix,
    kafkaProvisionTopics:
      externalKafka?.external?.provisionTopics ?? base.kafkaProvisionTopics,
    kafkaSsl: externalKafka?.external?.ssl ?? base.kafkaSsl,
    kafkaSaslMechanism:
      externalKafka?.external?.sasl?.mechanism ?? base.kafkaSaslMechanism,
    kafkaSaslRegion:
      externalKafka?.external?.sasl?.region ?? base.kafkaSaslRegion,
    kafkaSaslUsername:
      externalKafka?.external?.sasl?.username ?? base.kafkaSaslUsername,
    kafkaSaslPassword:
      externalKafka?.external?.sasl?.password ?? base.kafkaSaslPassword,
    kafkaSaslExistingSecret:
      externalKafka?.external?.sasl?.existingSecret ??
      base.kafkaSaslExistingSecret,
    kafkaIdentityAwsRoleArn:
      externalKafka?.external?.identity?.awsRoleArn ??
      base.kafkaIdentityAwsRoleArn,
    kafkaIdentityGcpServiceAccountEmail:
      externalKafka?.external?.identity?.gcpServiceAccountEmail ??
      base.kafkaIdentityGcpServiceAccountEmail,
    kafkaIdentityAzureClientId:
      externalKafka?.external?.identity?.azureClientId ??
      base.kafkaIdentityAzureClientId,
    // External services - Postgres
    postgresMode: externalPostgres?.mode ?? base.postgresMode,
    postgresHost: externalPostgres?.external?.host ?? base.postgresHost,
    postgresPort: externalPostgres?.external?.port ?? base.postgresPort,
    postgresDatabase:
      externalPostgres?.external?.database ?? base.postgresDatabase,
    postgresMasterUsername:
      externalPostgres?.external?.bootstrap?.masterUsername ??
      base.postgresMasterUsername,
    postgresMasterPassword:
      externalPostgres?.external?.bootstrap?.masterPassword ??
      base.postgresMasterPassword,
    licenseKey: config.licenseKey,
    version: config.version,
    chartVersion: config.chartVersion ?? "",
  };
}

function wizardReducer(state: WizardState, action: WizardAction): WizardState {
  switch (action.type) {
    case "SET_STEP":
      return { ...state, step: action.step };
    case "SET_NAME":
      return { ...state, name: action.name };
    case "SET_PROVIDER":
      if (action.provider === state.provider) {
        return {
          ...state,
          provider: action.provider,
          region: "",
          clusterName: "",
          gcpProjectId: "",
          azureResourceGroup: "",
        };
      }
      return {
        ...state,
        provider: action.provider,
        region: "",
        clusterName: "",
        gcpProjectId: "",
        azureResourceGroup: "",
        storageProvider: null,
        storageBucket: "",
        storageRegion: "",
        storageAwsIamRoleArn: "",
        storageAzureBlobContainer: "",
        storageAzureBlobClientId: "",
        storageAzureBlobTenantId: "",
        storageAzureBlobConnectionStringSecretRef: "",
        storageGcpServiceAccountEmail: "",
      };
    case "SET_REGION":
      return { ...state, region: action.region };
    case "SET_CLUSTER_NAME":
      return { ...state, clusterName: action.clusterName };
    case "SET_GCP_PROJECT":
      return { ...state, gcpProjectId: action.projectId };
    case "SET_AZURE_RG":
      return { ...state, azureResourceGroup: action.resourceGroup };
    case "SET_DOMAIN":
      return { ...state, domain: action.domain };
    case "SET_ADMIN_EMAIL":
      return { ...state, adminEmail: action.email };
    case "SET_DNS_PROVIDER":
      // Reset auto-manage if switching to unsupported provider
      return {
        ...state,
        dnsProvider: action.provider,
        dnsAutoManage:
          action.provider === "other" ? false : state.dnsAutoManage,
      };
    case "SET_DNS_AUTO_MANAGE":
      return { ...state, dnsAutoManage: action.autoManage };
    case "SET_SMTP":
      return { ...state, ...action.config };
    case "SET_DATABASE_TYPE":
      return { ...state, databaseType: action.dbType };
    case "SET_SUPABASE_CONFIG":
      return { ...state, ...action.config };
    case "SET_SUPABASE_SELF_HOSTED":
      return { ...state, ...action.config };
    case "SET_CLUSTER_CAPABILITIES":
      return {
        ...state,
        nodeArchitecture: action.nodeArchitecture,
        arm64TolerationRequired: action.arm64TolerationRequired,
        storageClass: action.storageClass ?? state.storageClass,
        storageProvisioner:
          action.storageProvisioner ?? state.storageProvisioner,
        schedulableNodeCount:
          action.schedulableNodeCount ?? state.schedulableNodeCount,
        totalCpuCores: action.totalCpuCores ?? state.totalCpuCores,
        totalMemoryGi: action.totalMemoryGi ?? state.totalMemoryGi,
        eligibleCpuCores: action.eligibleCpuCores ?? state.eligibleCpuCores,
        eligibleMemoryGi: action.eligibleMemoryGi ?? state.eligibleMemoryGi,
        totalPersistentStorageGi:
          action.totalPersistentStorageGi ?? state.totalPersistentStorageGi,
      };
    case "SET_AI_ENABLED":
      return { ...state, aiEnabled: action.enabled };
    case "SET_OPENAI_KEY":
      return { ...state, openaiApiKey: action.key };
    case "SET_SSO_ENABLED":
      return { ...state, ssoEnabled: action.enabled };
    case "SET_SSO_CONFIG":
      return { ...state, ...action.config };
    case "SET_METRICS_EXPORT":
      return {
        ...state,
        clickStackEnabled: action.enabled ? false : state.clickStackEnabled,
        metricsExportEnabled: action.enabled,
      };
    case "SET_PROMETHEUS_REMOTE_WRITE":
      return { ...state, prometheusRemoteWriteUrl: action.url };
    case "SET_PROMETHEUS_REMOTE_WRITE_CONFIG":
      return { ...state, ...action.config };
    case "SET_LOGGING_SINK":
      // Reset the platform credential/detail if switching back to console.
      return {
        ...state,
        loggingSink: action.sink,
        loggingPlatformCredential:
          action.sink === "console" ? "" : state.loggingPlatformCredential,
        loggingPlatformDetail:
          action.sink === "console" ? "" : state.loggingPlatformDetail,
      };
    case "SET_STORAGE_CONFIG":
      return { ...state, ...action.config };
    case "SET_LOGGING_CONFIG":
      return { ...state, ...action.config };
    case "SET_CLICKSTACK_ENABLED":
      return {
        ...state,
        clickStackEnabled: action.enabled,
        metricsExportEnabled: action.enabled ? false : state.metricsExportEnabled,
        tracingEnabled: action.enabled ? false : state.tracingEnabled,
        appLogsEnabled: action.enabled ? false : state.appLogsEnabled,
      };
    case "SET_CLICKSTACK_CONFIG":
      return { ...state, ...action.config };
    case "SET_TRACING_ENABLED":
      return {
        ...state,
        clickStackEnabled: action.enabled ? false : state.clickStackEnabled,
        tracingEnabled: action.enabled,
      };
    case "SET_TRACING_CONFIG":
      return { ...state, ...action.config };
    case "SET_APP_LOGS_ENABLED":
      return {
        ...state,
        clickStackEnabled: action.enabled ? false : state.clickStackEnabled,
        appLogsEnabled: action.enabled,
      };
    case "SET_APP_LOGS_CONFIG":
      return { ...state, ...action.config };
    case "SET_BACKUP_ENABLED":
      return { ...state, backupEnabled: action.enabled };
    case "SET_BACKUP_SCHEDULE":
      return { ...state, backupSchedule: action.schedule };
    case "SET_BACKUP_RETENTION_DAYS":
      return { ...state, backupRetentionDays: action.retentionDays };
    case "SET_EXTERNAL_SERVICES":
      return {
        ...state,
        ...action.config,
        ...(action.config.postgresMode === "external"
          ? { backupEnabled: false }
          : {}),
      };
    case "SET_CUSTOM_EMAILS_ENABLED":
      return { ...state, customEmailsEnabled: action.enabled };
    case "SET_EMAIL_SUBJECTS":
      return {
        ...state,
        emailSubjects: { ...state.emailSubjects, ...action.subjects },
      };
    case "SET_EMAIL_TEMPLATES":
      return {
        ...state,
        emailTemplates: { ...state.emailTemplates, ...action.templates },
      };
    case "SET_LICENSE_KEY":
      return { ...state, licenseKey: action.key };
    case "SET_VERSION":
      return {
        ...state,
        version: action.version,
      };
    case "SET_CHART_VERSION":
      return { ...state, chartVersion: action.version };
    case "NEXT_STEP":
      return { ...state, step: state.step + 1 };
    case "PREV_STEP":
      return { ...state, step: Math.max(0, state.step - 1) };
    default:
      return state;
  }
}

interface WizardContextValue {
  state: WizardState;
  dispatch: React.Dispatch<WizardAction>;
  toConfig: (options?: {
    nodeArchitecture?: NodeArchitecture;
    arm64TolerationRequired?: boolean;
    storageClass?: string;
    storageProvisioner?: string;
    schedulableNodeCount?: number;
    totalCpuCores?: number;
    totalMemoryGi?: number;
    eligibleCpuCores?: number;
    eligibleMemoryGi?: number;
    totalPersistentStorageGi?: number;
  }) => DeploymentConfig | null;
  /** Human-readable reasons the current state can't be saved (empty = valid). */
  configIssues: () => string[];
  skipToStep: (stepId: string) => void;
  profile: ProfileConfig | null;
}

const WizardContext = createContext<WizardContextValue | null>(null);

interface WizardProviderProps {
  children: ReactNode;
  initialName?: string;
  initialState?: WizardState;
  profile?: ProfileConfig | null;
}

export function WizardProvider({
  children,
  initialName,
  initialState,
  profile,
}: WizardProviderProps) {
  // Initialize state with profile values for pre-population
  const [state, dispatch] = useReducer(wizardReducer, {
    ...getInitialState(profile),
    ...initialState,
    name: initialState?.name || initialName || "",
  });

  const toConfig = (
    options: {
      nodeArchitecture?: NodeArchitecture;
      arm64TolerationRequired?: boolean;
      storageClass?: string;
      storageProvisioner?: string;
      schedulableNodeCount?: number;
      totalCpuCores?: number;
      totalMemoryGi?: number;
      eligibleCpuCores?: number;
      eligibleMemoryGi?: number;
      totalPersistentStorageGi?: number;
    } = {},
  ): DeploymentConfig | null => {
    // All field/credential gates (including the remote_write checks) live in one
    // place so the review screen can show the specific reason a config is
    // invalid instead of a generic message.
    if (collectConfigIssues(state).length > 0) {
      return null;
    }
    // collectConfigIssues guarantees these, but narrow them for the type checker.
    if (!state.storageProvider) {
      return null;
    }

    const externalServices = buildExternalServices(state);
    const remoteWrite = !state.clickStackEnabled && state.metricsExportEnabled
      ? buildRemoteWriteFromState(state)
      : undefined;

    return {
      name: state.name,
      infrastructure: {
        mode: "existing",
        provider: state.provider || undefined,
        region: state.region || undefined,
        clusterName: state.clusterName || undefined,
        gcpProjectId: state.gcpProjectId || undefined,
        azureResourceGroup: state.azureResourceGroup || undefined,
        nodeArchitecture:
          options.nodeArchitecture || state.nodeArchitecture || undefined,
        arm64TolerationRequired:
          options.arm64TolerationRequired ?? state.arm64TolerationRequired,
        storageClass: options.storageClass || state.storageClass || undefined,
        storageProvisioner:
          options.storageProvisioner || state.storageProvisioner || undefined,
        schedulableNodeCount:
          options.schedulableNodeCount || state.schedulableNodeCount || undefined,
        totalCpuCores:
          options.totalCpuCores || state.totalCpuCores || undefined,
        totalMemoryGi:
          options.totalMemoryGi || state.totalMemoryGi || undefined,
        eligibleCpuCores:
          options.eligibleCpuCores || state.eligibleCpuCores || undefined,
        eligibleMemoryGi:
          options.eligibleMemoryGi || state.eligibleMemoryGi || undefined,
        totalPersistentStorageGi:
          options.totalPersistentStorageGi ||
          state.totalPersistentStorageGi ||
          undefined,
      },
      domain: state.domain,
      adminEmail: state.adminEmail,
      // Not asked in the wizard; defaults to the admin email. A custom value
      // survives redeploys via configToWizardState / config.yaml edits.
      tlsEmail: state.tlsEmail || state.adminEmail,
      dns: {
        provider: state.dnsProvider,
        autoManage: state.dnsAutoManage,
      },
      smtp: {
        host: state.smtpHost,
        port: state.smtpPort,
        user: state.smtpUser,
        pass: state.smtpPass,
        from: state.smtpFrom,
        fromName: state.smtpFromName,
      },
      database: {
        type: state.databaseType || "self-hosted",
        supabaseUrl: state.supabaseUrl || undefined,
        supabaseAnonKey: state.supabaseAnonKey || undefined,
        supabaseServiceKey: state.supabaseServiceKey || undefined,
        supabaseAccessToken: state.supabaseAccessToken || undefined,
        // Derived from the project URL when not set explicitly (config.yaml
        // edits and redeploy merges still win).
        supabaseProjectRef:
          state.supabaseProjectRef ||
          (state.databaseType === "supabase-cloud" && state.supabaseUrl
            ? deriveSupabaseProjectRef(state.supabaseUrl)
            : undefined) ||
          undefined,
        supabaseJwtSecret: state.supabaseJwtSecret || undefined,
        supabaseDbPassword: state.supabaseDbPassword || undefined,
        supabaseDashboardUser: state.supabaseDashboardUser || undefined,
        supabaseDashboardPass: state.supabaseDashboardPass || undefined,
      },
      storage: {
        provider: state.storageProvider,
        cloudAuthMode: state.storageCloudAuthMode,
        bucket: state.storageBucket,
        region: state.storageRegion,
        awsIamRoleArn:
          state.storageProvider === "s3"
            ? state.storageAwsIamRoleArn || undefined
            : undefined,
        azureBlobClientId:
          state.storageProvider === "azure-blob"
            ? state.storageAzureBlobClientId || undefined
            : undefined,
        azureBlobTenantId:
          state.storageProvider === "azure-blob"
            ? state.storageAzureBlobTenantId || undefined
            : undefined,
        azureBlobConnectionStringSecretRef:
          state.storageProvider === "azure-blob"
            ? parseSecretKeyRef(
                state.storageAzureBlobConnectionStringSecretRef,
              )
            : undefined,
        azureBlobContainer:
          state.storageProvider === "azure-blob"
            ? state.storageAzureBlobContainer || undefined
            : undefined,
        gcpServiceAccountEmail:
          state.storageProvider === "gcs"
            ? state.storageGcpServiceAccountEmail || undefined
            : undefined,
        paths: {
          decisionLogs: "decision-logs",
          dbBackups: "db-backups",
        },
      },
      backup: {
        enabled:
          state.databaseType === "self-hosted" ? state.backupEnabled : false,
        schedule: state.backupSchedule || "0 2 * * *",
        retentionDays: state.backupRetentionDays || 7,
      },
      externalServices,
      features: {
        ai: {
          enabled: state.aiEnabled,
          openaiApiKey: state.openaiApiKey || undefined,
        },
        sso: {
          enabled: state.ssoEnabled,
          provider: state.ssoProvider || undefined,
          url: state.ssoUrl || undefined,
          clientId: state.ssoClientId || undefined,
          clientSecret: state.ssoClientSecret || undefined,
        },
        monitoring: {
          // In-cluster Prometheus is always installed.
          enabled: true,
          destination: !state.clickStackEnabled && state.metricsExportEnabled
            ? state.prometheusMonitoringDestination ||
              remoteWrite?.destination ||
              undefined
            : // "local-grafana" is a config-file-only option (in-cluster
              // Grafana, no remote write) and must survive redeploys.
              state.prometheusMonitoringDestination === "local-grafana"
              ? "local-grafana"
              : undefined,
          remoteWriteUrl: !state.clickStackEnabled && state.metricsExportEnabled
            ? state.prometheusRemoteWriteUrl || undefined
            : undefined,
          remoteWrite,
        },
        observability: {
          clickstack: {
            enabled: state.clickStackEnabled,
            telemetryRetentionDays: state.clickStackTelemetryRetentionDays,
            clickHouseStorageSize: state.clickHouseStorageSize,
          },
        },
        // Distributed tracing (self-hosted only). Omitted when disabled. The
        // destination selects which backend sub-block is emitted.
        tracing: !state.clickStackEnabled && state.tracingEnabled
          ? state.tracingDestination === "otlp"
            ? {
                enabled: true,
                destination: "otlp" as const,
                otlp: {
                  endpoint: state.tracingOtlpEndpoint || undefined,
                  authMode: state.tracingOtlpAuthMode,
                  headerName:
                    state.tracingOtlpAuthMode === "header"
                      ? state.tracingOtlpHeaderName || undefined
                      : undefined,
                  token:
                    state.tracingOtlpAuthMode === "bearer"
                      ? state.tracingOtlpToken || undefined
                      : undefined,
                  apiKey:
                    state.tracingOtlpAuthMode === "api-key"
                      ? state.tracingOtlpToken || undefined
                      : undefined,
                  headerValue:
                    state.tracingOtlpAuthMode === "header"
                      ? state.tracingOtlpToken || undefined
                      : undefined,
                },
              }
            : state.tracingDestination === "azure-monitor"
              ? {
                  enabled: true,
                  destination: "azure-monitor" as const,
                  azureMonitor: {
                    connectionString:
                      state.tracingAzureConnectionString || undefined,
                  },
                }
              : {
                  enabled: true,
                  destination: "elastic" as const,
                  elastic: {
                    endpoint: state.tracingElasticEndpoint || undefined,
                    authMode: state.tracingElasticAuthMode,
                    secretToken:
                      state.tracingElasticAuthMode === "secret-token"
                        ? state.tracingElasticSecretToken || undefined
                        : undefined,
                    apiKey:
                      state.tracingElasticAuthMode === "api-key"
                        ? state.tracingElasticApiKey || undefined
                        : undefined,
                  },
                }
          : undefined,
        cache:
          state.valkeyAdminEnabled ||
          state.redisExporterEnabled ||
          state.kafkaExporterEnabled
            ? {
                valkeyAdmin: state.valkeyAdminEnabled
                  ? {
                      enabled: true,
                      exposure: state.valkeyAdminExposure,
                      hostname: state.valkeyAdminHostname || undefined,
                      basicAuthUsers:
                        state.valkeyAdminBasicAuthUsers.length > 0
                          ? state.valkeyAdminBasicAuthUsers
                          : undefined,
                      allowedIPs:
                        state.valkeyAdminAllowedIPs.length > 0
                          ? state.valkeyAdminAllowedIPs
                          : undefined,
                    }
                  : undefined,
                redisExporter: state.redisExporterEnabled
                  ? { enabled: true }
                  : undefined,
                kafkaExporter: state.kafkaExporterEnabled
                  ? { enabled: true }
                  : undefined,
              }
            : undefined,
        logging: {
          // External logging is now a platform-only sink (Datadog, Splunk,
          // etc.). The persisted bucket/region keys carry the platform
          // credential and endpoint/detail (not an object-storage bucket).
          // Cloud object storage for decision logs is configured separately
          // under `storage` above.
          sink: state.loggingSink,
          bucket: state.loggingPlatformCredential || undefined,
          region: state.loggingPlatformDetail || undefined,
          // Application/container log shipping to Elasticsearch (Vector agent).
          appLogs: !state.clickStackEnabled && state.appLogsEnabled
            ? {
                enabled: true,
                elasticsearch: {
                  endpoint: state.appLogsElasticEndpoint || undefined,
                  index: state.appLogsElasticIndex || undefined,
                  authMode: state.appLogsElasticAuthMode,
                  username:
                    state.appLogsElasticAuthMode === "basic"
                      ? state.appLogsElasticUsername || undefined
                      : undefined,
                  password:
                    state.appLogsElasticAuthMode === "basic"
                      ? state.appLogsElasticPassword || undefined
                      : undefined,
                  apiKey:
                    state.appLogsElasticAuthMode === "api-key"
                      ? state.appLogsElasticApiKey || undefined
                      : undefined,
                },
              }
            : undefined,
        },
        customEmails: state.customEmailsEnabled
          ? {
              enabled: true,
              subjects: state.emailSubjects,
              templates: {
                invite: state.emailTemplates.invite,
                confirmation: state.emailTemplates.confirmation,
                recovery: state.emailTemplates.recovery,
                emailChange: state.emailTemplates.emailChange,
              },
            }
          : undefined,
      },
      licenseKey: state.licenseKey,
      version: state.version,
      chartVersion: state.chartVersion || undefined,
    };
  };

  const skipToStep = (stepId: string) => {
    const stepIndex = [
      "cloud",
      "domain",
      "smtp",
      "database",
      "database-creds",
      "external-services",
      "storage",
      "observability",
      "features",
      "feature-config",
      "version",
      "review",
    ].indexOf(stepId);
    if (stepIndex >= 0) {
      dispatch({ type: "SET_STEP", step: stepIndex });
    }
  };

  return (
    <WizardContext.Provider
      value={{
        state,
        dispatch,
        toConfig,
        configIssues: () => collectConfigIssues(state),
        skipToStep,
        profile: profile ?? null,
      }}
    >
      {children}
    </WizardContext.Provider>
  );
}

export function useWizard() {
  const context = useContext(WizardContext);
  if (!context) {
    throw new Error("useWizard must be used within WizardProvider");
  }
  return context;
}
