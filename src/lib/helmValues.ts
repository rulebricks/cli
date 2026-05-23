import {
  DeploymentConfig,
  TIER_CONFIGS,
  isSupportedDnsProvider,
  getLoggingDestinationLabel,
  LoggingSink,
  RemoteWriteConfig,
  SecretKeyRef,
} from "../types/index.js";
import { saveHelmValues, getHelmValuesPath } from "./config.js";
import fs from "fs/promises";
import YAML from "yaml";

interface GenerateOptions {
  tlsEnabled?: boolean;
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
      inputs: ["kafka"],
      encoding: {
        codec: "json",
      },
    },
  };

  // Add external sink if configured
  if (
    config.features.logging.sink !== "console" &&
    config.features.logging.sink !== "pending"
  ) {
    const { sink, bucket, region } = config.features.logging;

    switch (sink) {
      // Cloud Storage sinks
      case "s3":
        sinks.s3 = {
          type: "aws_s3",
          inputs: ["kafka"],
          bucket: bucket,
          region: region,
          key_prefix: "rulebricks/logs/%Y/%m/%d/",
          compression: "gzip",
          encoding: {
            codec: "json",
          },
        };
        break;

      case "azure-blob":
        if (!bucket) {
          throw new Error("Azure Blob logging requires a storage account.");
        }
        const azureBlobSink: Record<string, unknown> = {
          type: "azure_blob",
          inputs: ["kafka"],
          account_name: bucket,
          container_name:
            config.features.logging.azureBlobContainer || "rulebricks-logs",
          blob_prefix: "rulebricks/logs/%Y/%m/%d/",
          compression: "gzip",
          encoding: {
            codec: "json",
          },
        };
        if (config.features.logging.cloudAuthMode === "secret") {
          if (!config.features.logging.azureBlobConnectionStringSecretRef) {
            throw new Error(
              "Azure Blob connection string auth requires a secret ref.",
            );
          }
          azureBlobSink.connection_string = "${AZURE_STORAGE_CONNECTION_STRING}";
        } else {
          if (
            !config.features.logging.azureBlobClientId ||
            !config.features.logging.azureBlobTenantId
          ) {
            throw new Error(
              "Azure Blob workload identity requires client ID and tenant ID.",
            );
          }
          azureBlobSink.auth = {
            azure_credential_kind: "workload_identity",
            client_id: config.features.logging.azureBlobClientId,
            tenant_id: config.features.logging.azureBlobTenantId,
            token_file_path: "/var/run/secrets/azure/tokens/azure-identity-token",
          };
        }
        sinks.azure_blob = azureBlobSink;
        break;

      case "gcs":
        sinks.gcs = {
          type: "gcp_cloud_storage",
          inputs: ["kafka"],
          bucket: bucket,
          key_prefix: "rulebricks/logs/%Y/%m/%d/",
          compression: "gzip",
          encoding: {
            codec: "json",
          },
        };
        break;

      // Logging platform sinks
      // For platforms, bucket is repurposed for API key/token, region for site/URL
      case "datadog":
        sinks.datadog = {
          type: "datadog_logs",
          inputs: ["kafka"],
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
          inputs: ["kafka"],
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
            inputs: ["kafka"],
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
            inputs: ["kafka"],
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
          inputs: ["kafka"],
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
          inputs: ["kafka"],
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
          inputs: ["kafka"],
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
  const env: Array<Record<string, unknown>> = [
    {
      name: "KAFKA_BOOTSTRAP_SERVERS",
      valueFrom: {
        configMapKeyRef: {
          name: "vector-kafka-env",
          key: "KAFKA_BOOTSTRAP_SERVERS",
        },
      },
    },
  ];

  const azureBlobSecretRef =
    config.features.logging.azureBlobConnectionStringSecretRef;

  if (
    config.features.logging.sink === "azure-blob" &&
    config.features.logging.cloudAuthMode === "secret" &&
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

  if (config.features.logging.sink === "s3" && config.features.logging.awsIamRoleArn) {
    annotations["eks.amazonaws.com/role-arn"] =
      config.features.logging.awsIamRoleArn;
  }

  if (
    config.features.logging.sink === "azure-blob" &&
    config.features.logging.cloudAuthMode !== "secret" &&
    config.features.logging.azureBlobClientId
  ) {
    annotations["azure.workload.identity/client-id"] =
      config.features.logging.azureBlobClientId;
  }

  if (config.features.logging.sink === "gcs" && config.features.logging.gcpServiceAccountEmail) {
    annotations["iam.gke.io/gcp-service-account"] =
      config.features.logging.gcpServiceAccountEmail;
  }

  return {
    create: true,
    name: "vector",
    annotations,
  };
}

function generateVectorPodLabels(config: DeploymentConfig): Record<string, string> {
  const labels: Record<string, string> = {};

  if (
    config.features.logging.sink === "azure-blob" &&
    config.features.logging.cloudAuthMode !== "secret"
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

function generateRemoteWriteSpec(
  config: DeploymentConfig,
): Array<Record<string, unknown>> {
  if (config.features.monitoring.destination === "local-grafana") {
    return [];
  }

  const remoteWrite = config.features.monitoring.remoteWrite;

  if (!remoteWrite) {
    return config.features.monitoring.remoteWriteUrl
      ? [{ url: config.features.monitoring.remoteWriteUrl }]
      : [];
  }

  const base: Record<string, unknown> = {
    url: remoteWrite.url,
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
    azureAd.workloadIdentity = {
      clientId: remoteWrite.clientId,
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

/**
 * Generates Helm values from the deployment configuration
 */
export async function generateHelmValues(
  config: DeploymentConfig,
  options: GenerateOptions = {},
): Promise<void> {
  const tierConfig = TIER_CONFIGS[config.tier];
  const { tlsEnabled = true } = options;
  const useLocalGrafana =
    config.features.monitoring.destination === "local-grafana";

  // Determine if external-dns should be enabled
  const externalDnsEnabled =
    config.dns.autoManage && isSupportedDnsProvider(config.dns.provider);

  // Determine storage class based on provider
  // Note: GCP uses "hyperdisk-balanced" because C4A instances only support Hyperdisk (not Persistent Disk)
  const storageClass =
    config.infrastructure.provider === "aws"
      ? "gp3"
      : config.infrastructure.provider === "gcp"
        ? "hyperdisk-balanced"
        : config.infrastructure.provider === "azure"
          ? "managed-premium"
          : "gp3";

  // ARM64 tolerations for GKE C4A nodes (and other ARM64 providers)
  // GKE automatically taints ARM64 nodes with kubernetes.io/arch=arm64:NoSchedule
  const arm64Tolerations = [
    {
      key: "kubernetes.io/arch",
      operator: "Equal",
      value: "arm64",
      effect: "NoSchedule",
    },
  ];

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
    },

    // =============================================================================
    // RULEBRICKS APPLICATION STACK
    // =============================================================================
    rulebricks: {
      app: {
        ...(config.appVersion
          ? {
              image: {
                repository: "index.docker.io/rulebricks/app",
                tag: config.appVersion,
                pullPolicy: "IfNotPresent",
              },
            }
          : {}),
        replicaCount: tierConfig.appReplicas,
        resources: tierConfig.appResources,
        tolerations: arm64Tolerations,

        // Logging configuration
        logging: {
          enabled: true,
          kafkaBrokers: "", // Auto-discover from Kafka subchart
          kafkaTopic: "logs",
          loggingDestination: getLoggingDestinationLabel(
            config.features.logging.sink,
          ),
        },
      },

      // HPS (High Performance Server)
      hps: {
        enabled: true,
        ...(config.hpsVersion
          ? {
              image: {
                repository: "index.docker.io/rulebricks/hps",
                tag: config.hpsVersion,
                pullPolicy: "Always",
              },
            }
          : {}),
        replicas: tierConfig.hpsReplicas,
        resources: tierConfig.hpsResources,
        tolerations: arm64Tolerations,

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
          tolerations: arm64Tolerations,
        },
      },

      // Ingress configuration
      ingress: {
        enabled: true,
        className: "traefik",
        paths: [{ path: "/", pathType: "Prefix" }],
      },

      // Redis configuration
      redis: {
        resources: tierConfig.redisResources,
        tolerations: arm64Tolerations,
        persistence: {
          enabled: true,
          size: tierConfig.redisPersistenceSize,
          storageClass: storageClass,
        },
      },
    },

    // =============================================================================
    // KAFKA (Message Queue)
    // =============================================================================
    kafka: {
      enabled: true,
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
        resources: tierConfig.kafkaResources,
        tolerations: arm64Tolerations,
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
    },

    // =============================================================================
    // TRAEFIK (Ingress Controller)
    // =============================================================================
    traefik: {
      enabled: true,
      ingressClass: {
        name: "traefik",
      },
      tolerations: arm64Tolerations,
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
      persistence: {
        enabled: false,
      },
    },

    // =============================================================================
    // KEDA (Autoscaling)
    // =============================================================================
    keda: {
      enabled: true,
      tolerations: arm64Tolerations,
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
      tolerations: arm64Tolerations,
      webhook: {
        tolerations: arm64Tolerations,
      },
      cainjector: {
        tolerations: arm64Tolerations,
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
      tolerations: arm64Tolerations,
      serviceAccount: generateVectorServiceAccount(config),
      podLabels: generateVectorPodLabels(config),
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
            topics: ["logs"],
            group_id: "vector-consumers",
            auto_offset_reset: "latest",
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
              resources: tierConfig.dbResources,
              tolerations: arm64Tolerations,
              persistence: {
                enabled: true,
                size: tierConfig.dbPersistenceSize,
                storageClassName: storageClass,
              },
            },
            auth: {
              tolerations: arm64Tolerations,
            },
            rest: {
              tolerations: arm64Tolerations,
            },
            realtime: {
              tolerations: arm64Tolerations,
            },
            meta: {
              tolerations: arm64Tolerations,
            },
            kong: {
              tolerations: arm64Tolerations,
              ingress: {
                enabled: true,
                className: "traefik",
                annotations: {},
              },
            },
            studio: {
              tolerations: arm64Tolerations,
            },
          }
        : {}),
    },

    // =============================================================================
    // MONITORING
    // =============================================================================
    monitoring: {
      enabled: config.features.monitoring.enabled,
    },
    "kube-prometheus-stack": {
      enabled: config.features.monitoring.enabled,
      alertmanager: {
        enabled: false,
      },
      grafana: {
        enabled: useLocalGrafana,
      },
      prometheus: {
        enabled: config.features.monitoring.enabled,
        serviceAccount: generatePrometheusServiceAccount(config),
        prometheusSpec: {
          retention: "30d",
          podMetadata: generatePrometheusPodMetadata(config),
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
      create: true,
      name: storageClass,
      provisioner:
        config.infrastructure.provider === "aws"
          ? "ebs.csi.aws.com"
          : config.infrastructure.provider === "gcp"
            ? "pd.csi.storage.gke.io"
            : config.infrastructure.provider === "azure"
              ? "disk.csi.azure.com"
              : "ebs.csi.aws.com",
      // Parameters for the StorageClass - must include type for disk provisioning
      parameters:
        config.infrastructure.provider === "aws"
          ? { type: "gp3" }
          : config.infrastructure.provider === "gcp"
            ? { type: "hyperdisk-balanced" }
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
