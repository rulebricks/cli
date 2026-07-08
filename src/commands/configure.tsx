import React, { useEffect, useState } from "react";
import { Box, Text } from "ink";
import {
  BorderBox,
  Logo,
  Spinner,
  ThemeProvider,
  useTheme,
} from "../components/common/index.js";
import { InitWizard } from "./init.js";
import {
  configToWizardState,
  type WizardState,
} from "../components/Wizard/WizardContext.js";
import {
  deploymentExists,
  loadDeploymentConfig,
  loadHelmValues,
  loadProfile,
} from "../lib/config.js";
import { formatConfigError } from "../lib/deploymentHealth.js";
import {
  DeploymentConfig,
  ProfileConfig,
  SecretKeyRef,
} from "../types/index.js";

interface ConfigureCommandProps {
  name: string;
}

type ConfigureStep = "loading" | "wizard" | "error";

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value ? value : undefined;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" ? value : undefined;
}

function booleanValue(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function secretRefValue(value: unknown): SecretKeyRef | undefined {
  if (!isRecord(value)) return undefined;
  const name = stringValue(value.name);
  const key = stringValue(value.key);
  return name && key ? { name, key } : undefined;
}

function applyHelmValuesToConfig(
  config: DeploymentConfig,
  values: Record<string, unknown> | null,
): DeploymentConfig {
  const next = JSON.parse(JSON.stringify(config)) as DeploymentConfig;
  if (!values) return next;

  const global = isRecord(values.global) ? values.global : null;
  if (global) {
    next.domain = stringValue(global.domain) ?? next.domain;
    next.adminEmail = stringValue(global.email) ?? next.adminEmail;
    next.licenseKey = stringValue(global.licenseKey) ?? next.licenseKey;
    next.version = stringValue(global.version) ?? next.version;

    if (isRecord(global.smtp)) {
      next.smtp = {
        ...next.smtp,
        host: stringValue(global.smtp.host) ?? next.smtp.host,
        port: numberValue(global.smtp.port) ?? next.smtp.port,
        user: stringValue(global.smtp.user) ?? next.smtp.user,
        pass: stringValue(global.smtp.pass) ?? next.smtp.pass,
        from: stringValue(global.smtp.from) ?? next.smtp.from,
        fromName: stringValue(global.smtp.fromName) ?? next.smtp.fromName,
      };
    }

    if (isRecord(global.supabase)) {
      if (next.database.type === "supabase-cloud") {
        next.database.supabaseUrl =
          stringValue(global.supabase.url) ?? next.database.supabaseUrl;
        next.database.supabaseAnonKey =
          stringValue(global.supabase.anonKey) ??
          next.database.supabaseAnonKey;
        next.database.supabaseServiceKey =
          stringValue(global.supabase.serviceKey) ??
          next.database.supabaseServiceKey;
        next.database.supabaseAccessToken =
          stringValue(global.supabase.accessToken) ??
          next.database.supabaseAccessToken;
        next.database.supabaseProjectRef =
          stringValue(global.supabase.projectRef) ??
          next.database.supabaseProjectRef;
      } else {
        next.database.supabaseJwtSecret =
          stringValue(global.supabase.jwtSecret) ??
          next.database.supabaseJwtSecret;
      }
    }

    if (isRecord(global.ai)) {
      next.features.ai.enabled =
        booleanValue(global.ai.enabled) ?? next.features.ai.enabled;
      next.features.ai.openaiApiKey =
        stringValue(global.ai.openaiApiKey) ??
        next.features.ai.openaiApiKey;
    }

    if (isRecord(global.sso)) {
      next.features.sso.enabled =
        booleanValue(global.sso.enabled) ?? next.features.sso.enabled;
      next.features.sso.provider =
        (stringValue(global.sso.provider) as typeof next.features.sso.provider) ??
        next.features.sso.provider;
      next.features.sso.url =
        stringValue(global.sso.url) ?? next.features.sso.url;
      next.features.sso.clientId =
        stringValue(global.sso.clientId) ?? next.features.sso.clientId;
      next.features.sso.clientSecret =
        stringValue(global.sso.clientSecret) ??
        next.features.sso.clientSecret;
    }

    if (isRecord(global.storage) && next.storage) {
      const storage = global.storage;
      next.storage.provider =
        (stringValue(storage.provider) as typeof next.storage.provider) ??
        next.storage.provider;
      next.storage.bucket =
        stringValue(storage.bucket) ?? next.storage.bucket;
      next.storage.region =
        stringValue(storage.region) ?? next.storage.region;
      if (isRecord(storage.s3)) {
        next.storage.awsIamRoleArn =
          stringValue(storage.s3.iamRoleArn) ?? next.storage.awsIamRoleArn;
      }
      if (isRecord(storage.azure)) {
        next.storage.cloudAuthMode =
          storage.azure.authMode === "connection-string"
            ? "secret"
            : next.storage.cloudAuthMode;
        next.storage.azureBlobClientId =
          stringValue(storage.azure.clientId) ??
          next.storage.azureBlobClientId;
        next.storage.azureBlobTenantId =
          stringValue(storage.azure.tenantId) ??
          next.storage.azureBlobTenantId;
        next.storage.azureBlobContainer =
          stringValue(storage.azure.container) ??
          next.storage.azureBlobContainer;
        next.storage.azureBlobConnectionStringSecretRef =
          secretRefValue(storage.azure.connectionStringSecretRef) ??
          next.storage.azureBlobConnectionStringSecretRef;
      }
      if (isRecord(storage.gcp)) {
        next.storage.gcpServiceAccountEmail =
          stringValue(storage.gcp.serviceAccountEmail) ??
          next.storage.gcpServiceAccountEmail;
      }
      if (isRecord(storage.paths)) {
        next.storage.paths = {
          decisionLogs:
            stringValue(storage.paths.decisionLogs) ??
            next.storage.paths?.decisionLogs,
          dbBackups:
            stringValue(storage.paths.dbBackups) ??
            next.storage.paths?.dbBackups,
        };
      }
    }
  }

  if (isRecord(values.clusterIssuer)) {
    next.tlsEmail = stringValue(values.clusterIssuer.email) ?? next.tlsEmail;
  }

  if (isRecord(values.backup)) {
    next.backup = {
      enabled: booleanValue(values.backup.enabled) ?? next.backup?.enabled ?? false,
      schedule: stringValue(values.backup.schedule) ?? next.backup?.schedule ?? "0 2 * * *",
      retentionDays:
        numberValue(values.backup.retentionDays) ??
        next.backup?.retentionDays ??
        7,
    };
  }

  // External services (managed Redis/Kafka). The saved config is authoritative;
  // here we reconcile mode + connection details from the saved chart values so
  // configure reflects manual values.yaml edits. Preset/identity fall back to
  // the saved config.
  const rb = isRecord(values.rulebricks) ? values.rulebricks : null;

  const redisLive = rb && isRecord(rb.redis) ? rb.redis : null;
  if (redisLive) {
    const redisEnabled = booleanValue(redisLive.enabled);
    const savedRedis = next.externalServices?.redis;
    if (redisEnabled === false) {
      const ext = isRecord(redisLive.external) ? redisLive.external : {};
      const tls = isRecord(ext.tls) ? booleanValue(ext.tls.enabled) : undefined;
      const httpApiLive = isRecord(ext.httpApi) ? ext.httpApi : null;
      next.externalServices = {
        ...next.externalServices,
        redis: {
          mode: "external",
          external: {
            ...(savedRedis?.external ?? {}),
            host: stringValue(ext.host) ?? savedRedis?.external?.host,
            port: numberValue(ext.port) ?? savedRedis?.external?.port,
            password: stringValue(ext.password) ?? savedRedis?.external?.password,
            existingSecret:
              stringValue(ext.existingSecret) ??
              savedRedis?.external?.existingSecret,
            existingSecretKey:
              stringValue(ext.existingSecretKey) ??
              savedRedis?.external?.existingSecretKey,
            tls: tls ?? savedRedis?.external?.tls,
            httpApi: httpApiLive
              ? {
                  enabled: booleanValue(httpApiLive.enabled) ?? false,
                  url: stringValue(httpApiLive.url),
                  token: stringValue(httpApiLive.token),
                }
              : savedRedis?.external?.httpApi,
          },
        },
      };
    } else if (redisEnabled === true) {
      next.externalServices = {
        ...next.externalServices,
        redis: { mode: "embedded" },
      };
    }
  }

  const kafkaEnabled = isRecord(values.kafka)
    ? booleanValue(values.kafka.enabled)
    : undefined;
  const loggingLive =
    rb && isRecord(rb.app) && isRecord(rb.app.logging) ? rb.app.logging : null;
  if (kafkaEnabled === false && loggingLive) {
    const savedKafka = next.externalServices?.kafka;
    const saslLive = isRecord(loggingLive.kafkaSasl)
      ? loggingLive.kafkaSasl
      : null;
    const bridge = isRecord(values.kafkaBridge) ? values.kafkaBridge : null;
    const mechanism =
      (stringValue(saslLive?.mechanism) as
        | "aws-iam"
        | "oauthbearer"
        | "scram-sha-256"
        | "scram-sha-512"
        | "plain"
        | ""
        | undefined) ?? savedKafka?.external?.sasl?.mechanism;
    next.externalServices = {
      ...next.externalServices,
      kafka: {
        mode: "external",
        external: {
          ...(savedKafka?.external ?? {}),
          preset: savedKafka?.external?.preset ?? "custom",
          brokers:
            stringValue(loggingLive.kafkaBrokers) ??
            savedKafka?.external?.brokers,
          topic:
            stringValue(loggingLive.kafkaTopic) ??
            savedKafka?.external?.topic,
          topicPrefix:
            stringValue(loggingLive.kafkaTopicPrefix) ??
            savedKafka?.external?.topicPrefix,
          ssl: booleanValue(loggingLive.kafkaSsl) ?? savedKafka?.external?.ssl,
          sasl: mechanism
            ? {
                mechanism,
                region:
                  stringValue(saslLive?.region) ??
                  savedKafka?.external?.sasl?.region,
                username:
                  stringValue(saslLive?.username) ??
                  savedKafka?.external?.sasl?.username,
                password:
                  stringValue(saslLive?.password) ??
                  savedKafka?.external?.sasl?.password,
                existingSecret:
                  stringValue(saslLive?.existingSecret) ??
                  savedKafka?.external?.sasl?.existingSecret,
              }
            : savedKafka?.external?.sasl,
          identity: {
            ...(savedKafka?.external?.identity ?? {}),
            awsRoleArn:
              stringValue(bridge?.awsRoleArn) ||
              savedKafka?.external?.identity?.awsRoleArn,
          },
        },
      },
    };
  } else if (kafkaEnabled === true) {
    next.externalServices = {
      ...next.externalServices,
      kafka: { mode: "embedded" },
    };
  }

  return next;
}

function ConfigureCommandInner({ name }: ConfigureCommandProps) {
  const { colors } = useTheme();
  const [step, setStep] = useState<ConfigureStep>("loading");
  const [error, setError] = useState<string | null>(null);
  const [wizardState, setWizardState] = useState<WizardState | null>(null);
  const [profile, setProfile] = useState<ProfileConfig | null>(null);

  // Configure only edits the local config and values files, so no cluster
  // access or health check is needed; `rulebricks deploy` applies the result.
  useEffect(() => {
    (async () => {
      try {
        if (!(await deploymentExists(name))) {
          setError(
            `Deployment "${name}" not found. Run "rulebricks init" to create it.`,
          );
          setStep("error");
          return;
        }

        const config = await loadDeploymentConfig(name);
        const [loadedProfile, values] = await Promise.all([
          loadProfile(),
          loadHelmValues(name),
        ]);
        const hydratedConfig = applyHelmValuesToConfig(config, values);

        setProfile(loadedProfile);
        setWizardState(configToWizardState(hydratedConfig, loadedProfile));
        setStep("wizard");
      } catch (err) {
        setError(formatConfigError(err));
        setStep("error");
      }
    })();
  }, [name]);

  if (step === "wizard" && wizardState) {
    return (
      <InitWizard
        initialState={wizardState}
        mode="configure"
        profile={profile}
      />
    );
  }

  if (step === "error") {
    return (
      <ThemeProvider theme="init">
        <Logo />
        <BorderBox title="Configure Failed">
          <Box flexDirection="column" marginY={1}>
            <Text color={colors.error} bold>
              ✗ Error
            </Text>
            <Text color={colors.error}>{error}</Text>
          </Box>
        </BorderBox>
      </ThemeProvider>
    );
  }

  return (
    <ThemeProvider theme="init">
      <Logo />
      <BorderBox title="Configure">
        <Box marginY={1}>
          <Spinner label="Loading configuration..." />
        </Box>
      </BorderBox>
    </ThemeProvider>
  );
}

export function ConfigureCommand(props: ConfigureCommandProps) {
  return <ConfigureCommandInner {...props} />;
}
