// Pure field-sequence definitions for the branchiest wizard steps. The step
// components derive their field visibility from these functions and the tests
// assert exact sequences against them, so every UI path is encoded (and
// checked) as plain data.

import {
  CloudProvider,
  KafkaPreset,
  LoggingSink,
  RemoteWriteAuthType,
  RemoteWriteDestination,
  SSOProvider,
  TracingDestination,
} from "../types/index.js";

export interface ExternalServicesFlowState {
  mode: "dedicated" | "existing";
  services: { redis: boolean; kafka: boolean; postgres: boolean };
  provider: CloudProvider | null;
  pgAvailable: boolean;
  hasRedisPassword: boolean;
  preset: KafkaPreset;
  hasCustomMechanism: boolean;
  pgUseConnString: boolean;
}

export function externalServicesFieldOrder(
  s: ExternalServicesFlowState,
): string[] {
  const fields: string[] = ["mode"];
  if (s.mode !== "existing") return fields;
  fields.push("which");

  if (s.services.redis) {
    if (s.provider) fields.push("redis-pick");
    fields.push("redis-host", "redis-port", "redis-tls", "redis-password");
    if (!s.hasRedisPassword) fields.push("redis-existing-secret");
  }

  if (s.services.kafka) {
    fields.push("kafka-preset");
    if (s.preset !== "custom" && s.provider) fields.push("kafka-pick");
    fields.push("kafka-brokers", "kafka-topic-prefix");
    if (s.preset === "aws-msk-iam") {
      // No identity-role field: deploy derives the cluster-setup role
      // (<cluster>-rulebricks) or reuses existing Pod Identity associations;
      // config.yaml (externalServices.kafka.external.identity) overrides.
      fields.push("kafka-aws-region", "kafka-provision-topics");
    } else if (s.preset === "azure-event-hubs") {
      fields.push("kafka-azure-connection");
    } else if (s.preset === "gcp-managed") {
      fields.push("kafka-gcp-username", "kafka-gcp-password");
    } else {
      fields.push("kafka-custom-mechanism", "kafka-custom-ssl");
      if (s.hasCustomMechanism) {
        fields.push("kafka-custom-username", "kafka-custom-password");
      }
    }
  }

  if (s.services.postgres && s.pgAvailable) {
    if (s.provider) fields.push("pg-pick");
    if (s.pgUseConnString) fields.push("pg-conn");
    fields.push(
      "pg-host",
      "pg-port",
      "pg-database",
      "pg-master-username",
      "pg-master-password",
    );
  }

  return fields;
}

export interface FeatureConfigFlowState {
  needs: {
    ai: boolean;
    sso: boolean;
    monitoring: boolean;
    logging: boolean;
    tracing: boolean;
    appLogs: boolean;
    valkeyAdmin: boolean;
    customEmails: boolean;
  };
  ssoProvider: SSOProvider | null;
  remoteWriteDestination: RemoteWriteDestination | null;
  remoteWriteAuthType: RemoteWriteAuthType | null;
  manualRemoteWriteUrl: boolean;
  manualAwsRegion: boolean;
  manualClientId: boolean;
  loggingSink: LoggingSink;
  tracingDestination: TracingDestination;
  tracingOtlpAuthMode: "none" | "bearer" | "api-key";
}

export function featureConfigFieldOrder(s: FeatureConfigFlowState): string[] {
  const fields: string[] = [];

  if (s.needs.ai) fields.push("openai-key");

  if (s.needs.sso) {
    fields.push("sso-provider");
    if (s.ssoProvider !== "google") fields.push("sso-url");
    fields.push("sso-client-id", "sso-client-secret");
  }

  if (s.needs.monitoring) {
    fields.push("monitoring-destination");
    const dest = s.remoteWriteDestination;
    if (dest === "aws-amp") {
      fields.push(
        s.manualAwsRegion
          ? "monitoring-aws-region-manual"
          : "monitoring-aws-region",
      );
      if (!s.manualRemoteWriteUrl) fields.push("monitoring-aws-workspace");
    }
    if (dest === "azure-monitor" && !s.manualRemoteWriteUrl) {
      fields.push("monitoring-azure-target");
    }
    if (
      dest === "grafana-cloud" ||
      dest === "generic" ||
      s.manualRemoteWriteUrl
    ) {
      fields.push("monitoring-url");
    }
    if (dest === "azure-monitor") {
      fields.push("monitoring-azure-auth");
      if (s.remoteWriteAuthType === "oauth") {
        fields.push(
          s.manualClientId
            ? "monitoring-azure-client-id-manual"
            : "monitoring-azure-client-id",
        );
        fields.push("monitoring-tenant-id", "monitoring-client-secret-ref");
      }
    }
    if (dest === "generic") fields.push("monitoring-generic-auth");
    if (
      dest === "grafana-cloud" ||
      (dest === "generic" && s.remoteWriteAuthType === "basic")
    ) {
      fields.push(
        "monitoring-username-secret-ref",
        "monitoring-password-secret-ref",
      );
    }
    if (dest === "generic" && s.remoteWriteAuthType === "bearer") {
      fields.push("monitoring-bearer-secret-ref");
    }
  }

  if (s.needs.logging) {
    fields.push("logging-sink");
    switch (s.loggingSink) {
      case "datadog":
        fields.push("logging-datadog-key", "logging-datadog-site");
        break;
      case "splunk":
        fields.push("logging-splunk-url", "logging-splunk-token");
        break;
      case "elasticsearch":
        fields.push(
          "logging-es-url",
          "logging-es-user",
          "logging-es-pass",
          "logging-es-index",
        );
        break;
      case "loki":
        fields.push("logging-loki-url");
        break;
      case "newrelic":
        fields.push("logging-newrelic-key", "logging-newrelic-account");
        break;
      case "axiom":
        fields.push("logging-axiom-token", "logging-axiom-dataset");
        break;
      default:
        break;
    }
  }

  if (s.needs.tracing) {
    fields.push("tracing-destination");
    if (s.tracingDestination === "elastic") {
      fields.push("tracing-endpoint", "tracing-token");
    } else if (s.tracingDestination === "otlp") {
      fields.push("tracing-otlp-endpoint", "tracing-otlp-auth");
      if (s.tracingOtlpAuthMode !== "none") fields.push("tracing-otlp-cred");
    } else {
      fields.push("tracing-azure-connection");
    }
  }

  if (s.needs.appLogs) {
    fields.push("applogs-endpoint", "applogs-user", "applogs-pass", "applogs-index");
  }

  if (s.needs.valkeyAdmin) {
    fields.push(
      "valkey-admin-username",
      "valkey-admin-password",
      "valkey-admin-allowed-ips",
    );
  }

  if (s.needs.customEmails) {
    fields.push(
      "email-subject-invite",
      "email-subject-confirm",
      "email-subject-recovery",
      "email-subject-change",
      "email-template-invite",
      "email-template-confirm",
      "email-template-recovery",
      "email-template-change",
    );
  }

  return fields;
}
