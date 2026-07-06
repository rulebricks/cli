import { test } from "node:test";
import assert from "node:assert/strict";
import {
  externalServicesFieldOrder,
  featureConfigFieldOrder,
  ExternalServicesFlowState,
  FeatureConfigFlowState,
} from "./wizardFlow.js";
import {
  getActiveWizardSteps,
  getConfigureSections,
  WizardStepState,
} from "./wizardSteps.js";
import { CloudProvider, KafkaPreset } from "../types/index.js";

// ---------------------------------------------------------------------------
// Top-level step list
// ---------------------------------------------------------------------------

function stepState(overrides: Partial<WizardStepState> = {}): WizardStepState {
  return {
    databaseType: "self-hosted",
    aiEnabled: false,
    ssoEnabled: false,
    clickStackEnabled: true,
    metricsExportEnabled: false,
    tracingEnabled: false,
    appLogsEnabled: false,
    valkeyAdminEnabled: false,
    loggingSink: "console",
    customEmailsEnabled: false,
    ...overrides,
  };
}

test("minimal create path lists eleven steps", () => {
  assert.deepEqual(getActiveWizardSteps(stepState(), "create"), [
    "cloud",
    "domain",
    "smtp",
    "database",
    "database-creds",
    "external-services",
    "storage",
    "observability",
    "features",
    "version",
    "review",
  ]);
});

test("supabase-cloud drops database-creds; configure drops cloud", () => {
  const steps = getActiveWizardSteps(
    stepState({ databaseType: "supabase-cloud" }),
    "configure",
  );
  assert.equal(steps.includes("cloud"), false);
  assert.equal(steps.includes("database-creds"), false);
});

test("configure sections are the active steps minus cloud and review", () => {
  assert.deepEqual(getConfigureSections(stepState()), [
    "domain",
    "smtp",
    "database",
    "database-creds",
    "external-services",
    "storage",
    "observability",
    "features",
    "version",
  ]);

  // Conditional sections track the same visibility rules as the wizard.
  const withFeatureConfig = getConfigureSections(
    stepState({ databaseType: "supabase-cloud", aiEnabled: true }),
  );
  assert.equal(withFeatureConfig.includes("database-creds"), false);
  assert.equal(withFeatureConfig.includes("feature-config"), true);
  assert.equal(withFeatureConfig.includes("review"), false);
});

test("feature-config appears for each enabling flag", () => {
  const flags: Partial<WizardStepState>[] = [
    { aiEnabled: true },
    { ssoEnabled: true },
    { clickStackEnabled: false, metricsExportEnabled: true },
    { clickStackEnabled: false, tracingEnabled: true },
    { clickStackEnabled: false, appLogsEnabled: true },
    { valkeyAdminEnabled: true },
    { loggingSink: "datadog" },
    { customEmailsEnabled: true },
  ];
  for (const flag of flags) {
    const steps = getActiveWizardSteps(stepState(flag), "create");
    assert.equal(
      steps.includes("feature-config"),
      true,
      `expected feature-config for ${JSON.stringify(flag)}`,
    );
  }
  // ClickStack on suppresses the BYO signal sections.
  const suppressed = getActiveWizardSteps(
    stepState({ clickStackEnabled: true, metricsExportEnabled: true }),
    "create",
  );
  assert.equal(suppressed.includes("feature-config"), false);
});

// ---------------------------------------------------------------------------
// External services field sequences
// ---------------------------------------------------------------------------

function externalState(
  overrides: Partial<ExternalServicesFlowState> = {},
): ExternalServicesFlowState {
  return {
    mode: "existing",
    services: { redis: false, kafka: false, postgres: false },
    provider: "aws",
    pgAvailable: true,
    hasRedisPassword: false,
    preset: "aws-msk-iam",
    hasCustomMechanism: false,
    pgUseConnString: false,
    ...overrides,
  };
}

test("dedicated mode asks a single question", () => {
  assert.deepEqual(
    externalServicesFieldOrder(externalState({ mode: "dedicated" })),
    ["mode"],
  );
});

test("aws redis path includes discovery and secret fallback", () => {
  assert.deepEqual(
    externalServicesFieldOrder(
      externalState({ services: { redis: true, kafka: false, postgres: false } }),
    ),
    [
      "mode",
      "which",
      "redis-pick",
      "redis-host",
      "redis-port",
      "redis-tls",
      "redis-password",
      "redis-existing-secret",
    ],
  );
});

test("typed redis password hides the existing-secret prompt", () => {
  const order = externalServicesFieldOrder(
    externalState({
      services: { redis: true, kafka: false, postgres: false },
      hasRedisPassword: true,
    }),
  );
  assert.equal(order.includes("redis-existing-secret"), false);
});

test("kafka preset branches per provider", () => {
  const kafkaOnly = { redis: false, kafka: true, postgres: false };
  const cases: Array<{
    provider: CloudProvider;
    preset: KafkaPreset;
    tail: string[];
  }> = [
    {
      provider: "aws",
      preset: "aws-msk-iam",
      tail: ["kafka-aws-region", "kafka-aws-role", "kafka-provision-topics"],
    },
    {
      provider: "azure",
      preset: "azure-event-hubs",
      tail: ["kafka-azure-connection"],
    },
    {
      provider: "gcp",
      preset: "gcp-managed",
      tail: ["kafka-gcp-username", "kafka-gcp-password"],
    },
  ];
  for (const c of cases) {
    assert.deepEqual(
      externalServicesFieldOrder(
        externalState({ provider: c.provider, preset: c.preset, services: kafkaOnly }),
      ),
      [
        "mode",
        "which",
        "kafka-preset",
        "kafka-pick",
        "kafka-brokers",
        "kafka-topic-prefix",
        ...c.tail,
      ],
    );
  }
});

test("custom kafka skips discovery and gates SASL credentials", () => {
  const kafkaOnly = { redis: false, kafka: true, postgres: false };
  const sslOnly = externalServicesFieldOrder(
    externalState({ preset: "custom", services: kafkaOnly }),
  );
  assert.deepEqual(sslOnly.slice(2), [
    "kafka-preset",
    "kafka-brokers",
    "kafka-topic-prefix",
    "kafka-custom-mechanism",
    "kafka-custom-ssl",
  ]);
  const withSasl = externalServicesFieldOrder(
    externalState({
      preset: "custom",
      services: kafkaOnly,
      hasCustomMechanism: true,
    }),
  );
  assert.deepEqual(withSasl.slice(-2), [
    "kafka-custom-username",
    "kafka-custom-password",
  ]);
});

test("postgres flows on every provider, including GCP", () => {
  const pgOnly = { redis: false, kafka: false, postgres: true };
  for (const provider of ["aws", "azure", "gcp"] as CloudProvider[]) {
    const order = externalServicesFieldOrder(
      externalState({ provider, services: pgOnly }),
    );
    assert.deepEqual(order.slice(2), [
      "pg-pick",
      "pg-host",
      "pg-port",
      "pg-database",
      "pg-master-username",
      "pg-master-password",
    ]);
  }
});

test("postgres connection-string escape hatch inserts pg-conn", () => {
  const order = externalServicesFieldOrder(
    externalState({
      services: { redis: false, kafka: false, postgres: true },
      pgUseConnString: true,
    }),
  );
  assert.equal(order[3], "pg-conn");
});

test("postgres is omitted when unavailable (supabase cloud)", () => {
  const order = externalServicesFieldOrder(
    externalState({
      services: { redis: false, kafka: false, postgres: true },
      pgAvailable: false,
    }),
  );
  assert.equal(order.some((id) => id.startsWith("pg-")), false);
});

test("services chain in redis, kafka, postgres order", () => {
  const order = externalServicesFieldOrder(
    externalState({
      services: { redis: true, kafka: true, postgres: true },
      hasRedisPassword: true,
    }),
  );
  const redisEnd = order.indexOf("redis-password");
  const kafkaStart = order.indexOf("kafka-preset");
  const pgStart = order.indexOf("pg-pick");
  assert.ok(redisEnd < kafkaStart && kafkaStart < pgStart);
});

// ---------------------------------------------------------------------------
// Feature config field sequences
// ---------------------------------------------------------------------------

function featureState(
  overrides: Partial<FeatureConfigFlowState> = {},
): FeatureConfigFlowState {
  return {
    needs: {
      ai: false,
      sso: false,
      monitoring: false,
      logging: false,
      tracing: false,
      appLogs: false,
      valkeyAdmin: false,
      customEmails: false,
    },
    ssoProvider: null,
    remoteWriteDestination: null,
    remoteWriteAuthType: null,
    manualRemoteWriteUrl: false,
    manualAwsRegion: false,
    manualClientId: false,
    loggingSink: "console",
    tracingDestination: "elastic",
    tracingOtlpAuthMode: "none",
    ...overrides,
  };
}

const needsNone = featureState().needs;

test("google SSO skips the provider URL prompt", () => {
  const order = featureConfigFieldOrder(
    featureState({ needs: { ...needsNone, sso: true }, ssoProvider: "google" }),
  );
  assert.deepEqual(order, ["sso-provider", "sso-client-id", "sso-client-secret"]);
});

test("AMP monitoring flows region, workspace discovery, then done", () => {
  const order = featureConfigFieldOrder(
    featureState({
      needs: { ...needsNone, monitoring: true },
      remoteWriteDestination: "aws-amp",
    }),
  );
  assert.deepEqual(order, [
    "monitoring-destination",
    "monitoring-aws-region",
    "monitoring-aws-workspace",
  ]);
});

test("AMP manual URL replaces the workspace picker", () => {
  const order = featureConfigFieldOrder(
    featureState({
      needs: { ...needsNone, monitoring: true },
      remoteWriteDestination: "aws-amp",
      manualRemoteWriteUrl: true,
    }),
  );
  assert.deepEqual(order, [
    "monitoring-destination",
    "monitoring-aws-region",
    "monitoring-url",
  ]);
});

test("azure monitor oauth collects identity, tenant, and secret ref", () => {
  const order = featureConfigFieldOrder(
    featureState({
      needs: { ...needsNone, monitoring: true },
      remoteWriteDestination: "azure-monitor",
      remoteWriteAuthType: "oauth",
    }),
  );
  assert.deepEqual(order, [
    "monitoring-destination",
    "monitoring-azure-target",
    "monitoring-azure-auth",
    "monitoring-azure-client-id",
    "monitoring-tenant-id",
    "monitoring-client-secret-ref",
  ]);
});

test("azure monitor workload identity ends at the auth select", () => {
  const order = featureConfigFieldOrder(
    featureState({
      needs: { ...needsNone, monitoring: true },
      remoteWriteDestination: "azure-monitor",
      remoteWriteAuthType: "workload-identity",
    }),
  );
  assert.deepEqual(order.slice(-1), ["monitoring-azure-auth"]);
});

test("grafana cloud collects basic-auth secret refs after the URL", () => {
  const order = featureConfigFieldOrder(
    featureState({
      needs: { ...needsNone, monitoring: true },
      remoteWriteDestination: "grafana-cloud",
    }),
  );
  assert.deepEqual(order, [
    "monitoring-destination",
    "monitoring-url",
    "monitoring-username-secret-ref",
    "monitoring-password-secret-ref",
  ]);
});

test("generic remote write branches by auth type", () => {
  const base = {
    needs: { ...needsNone, monitoring: true },
    remoteWriteDestination: "generic" as const,
  };
  const none = featureConfigFieldOrder(
    featureState({ ...base, remoteWriteAuthType: "none" }),
  );
  assert.deepEqual(none.slice(-1), ["monitoring-generic-auth"]);
  const basic = featureConfigFieldOrder(
    featureState({ ...base, remoteWriteAuthType: "basic" }),
  );
  assert.deepEqual(basic.slice(-2), [
    "monitoring-username-secret-ref",
    "monitoring-password-secret-ref",
  ]);
  const bearer = featureConfigFieldOrder(
    featureState({ ...base, remoteWriteAuthType: "bearer" }),
  );
  assert.deepEqual(bearer.slice(-1), ["monitoring-bearer-secret-ref"]);
});

test("tracing destinations expose their own credential prompts", () => {
  const needs = { ...needsNone, tracing: true };
  assert.deepEqual(
    featureConfigFieldOrder(
      featureState({ needs, tracingDestination: "elastic" }),
    ),
    ["tracing-destination", "tracing-endpoint", "tracing-token"],
  );
  assert.deepEqual(
    featureConfigFieldOrder(
      featureState({
        needs,
        tracingDestination: "otlp",
        tracingOtlpAuthMode: "bearer",
      }),
    ),
    [
      "tracing-destination",
      "tracing-otlp-endpoint",
      "tracing-otlp-auth",
      "tracing-otlp-cred",
    ],
  );
  assert.deepEqual(
    featureConfigFieldOrder(
      featureState({ needs, tracingDestination: "azure-monitor" }),
    ),
    ["tracing-destination", "tracing-azure-connection"],
  );
});

test("sections run in AI, SSO, monitoring, logging, tracing, app-logs, valkey, emails order", () => {
  const order = featureConfigFieldOrder(
    featureState({
      needs: {
        ai: true,
        sso: true,
        monitoring: true,
        logging: true,
        tracing: true,
        appLogs: true,
        valkeyAdmin: true,
        customEmails: true,
      },
      ssoProvider: "okta",
      remoteWriteDestination: "grafana-cloud",
      loggingSink: "datadog",
      tracingDestination: "elastic",
    }),
  );
  const anchors = [
    "openai-key",
    "sso-provider",
    "monitoring-destination",
    "logging-sink",
    "tracing-destination",
    "applogs-endpoint",
    "valkey-admin-username",
    "email-subject-invite",
  ];
  const positions = anchors.map((anchor) => order.indexOf(anchor));
  assert.deepEqual(
    [...positions].sort((a, b) => a - b),
    positions,
    `sections out of order: ${order.join(", ")}`,
  );
  assert.equal(positions.includes(-1), false);
});

test("every logging platform has a field chain", () => {
  const sinks = [
    ["datadog", ["logging-datadog-key", "logging-datadog-site"]],
    ["splunk", ["logging-splunk-url", "logging-splunk-token"]],
    [
      "elasticsearch",
      ["logging-es-url", "logging-es-user", "logging-es-pass", "logging-es-index"],
    ],
    ["loki", ["logging-loki-url"]],
    ["newrelic", ["logging-newrelic-key", "logging-newrelic-account"]],
    ["axiom", ["logging-axiom-token", "logging-axiom-dataset"]],
  ] as const;
  for (const [sink, expected] of sinks) {
    const order = featureConfigFieldOrder(
      featureState({ needs: { ...needsNone, logging: true }, loggingSink: sink }),
    );
    assert.deepEqual(order, ["logging-sink", ...expected]);
  }
});
