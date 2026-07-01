import React, { useState, useEffect } from "react";
import { Box, Text } from "ink";
import SelectInput from "ink-select-input";
import TextInput from "ink-text-input";
import { useWizard } from "../WizardContext.js";
import { BorderBox, useGatedInput, useTheme } from "../../common/index.js";
import { Spinner } from "../../common/Spinner.js";
import {
  SSOProvider,
  LoggingSink,
  RemoteWriteAuthType,
  RemoteWriteDestination,
  TracingDestination,
  CLOUD_REGIONS,
  DEFAULT_EMAIL_SUBJECTS,
} from "../../../types/index.js";
import {
  listRegions,
  listAzureManagedIdentities,
  getAzureTenantId,
  listAzurePrometheusTargets,
  listAwsPrometheusWorkspaces,
  AzureManagedIdentity,
  RemoteWriteTarget,
} from "../../../lib/cloudCli.js";
import { findClusterSetupDefaultIndex } from "../../../lib/clusterSetupDefaults.js";
import { generateHtpasswdLine } from "../../../lib/htpasswd.js";
import { generateSecureSecret } from "../../../lib/validation.js";

interface FeatureConfigStepProps {
  onComplete: () => void;
  onBack: () => void;
  // When the user navigates *back* into this step from a later step, resume at
  // the end of the configured sections instead of restarting from the top.
  entryDirection?: "forward" | "back";
}

type SubStep =
  | "openai-key"
  | "sso-provider"
  | "sso-url"
  | "sso-client-id"
  | "sso-client-secret"
  | "monitoring-remote-write-destination"
  | "monitoring-remote-write-url"
  | "monitoring-aws-region-loading"
  | "monitoring-aws-region"
  | "monitoring-aws-workspace-loading"
  | "monitoring-aws-workspace"
  | "monitoring-azure-target-loading"
  | "monitoring-azure-target"
  | "monitoring-remote-write-azure-auth"
  | "monitoring-remote-write-generic-auth"
  | "monitoring-azure-identity-loading"
  | "monitoring-remote-write-client-id"
  | "monitoring-remote-write-client-id-manual"
  | "monitoring-remote-write-tenant-id"
  | "monitoring-remote-write-secret-ref"
  | "monitoring-remote-write-username-secret-ref"
  | "monitoring-remote-write-password-secret-ref"
  | "monitoring-remote-write-bearer-secret-ref"
  | "logging-sink"
  // Platform-specific config steps
  | "logging-datadog-config"
  | "logging-splunk-config"
  | "logging-elasticsearch-config"
  | "logging-loki-config"
  | "logging-newrelic-config"
  | "logging-axiom-config"
  // Distributed tracing (pluggable backend)
  | "tracing-destination"
  // Elastic APM
  | "tracing-endpoint"
  | "tracing-token"
  // Generic OTLP/HTTP
  | "tracing-otlp-endpoint"
  | "tracing-otlp-auth"
  | "tracing-otlp-cred"
  // Azure Monitor
  | "tracing-azure-connection"
  // Application log shipping (BYO Elasticsearch via Vector agent; Loki/generic
  // remain config-file options, while AWS/Azure native logs are provider-level).
  | "applogs-endpoint"
  | "applogs-user"
  | "applogs-pass"
  | "applogs-index"
  // Valkey Admin public ingress
  | "valkey-admin-username"
  | "valkey-admin-password"
  | "valkey-admin-allowed-ips"
  // Custom email template steps
  | "email-subject-invite"
  | "email-subject-confirm"
  | "email-subject-recovery"
  | "email-subject-change"
  | "email-template-invite"
  | "email-template-confirm"
  | "email-template-recovery"
  | "email-template-change"
  | "done";

// Sentinel value used in select lists to drop into manual text entry.
const MANUAL = "__manual__";
const REFRESH = "__refresh__";

const SSO_PROVIDERS = [
  { label: "Microsoft Azure AD", value: "azure" },
  { label: "Google Workspace", value: "google" },
  { label: "Okta", value: "okta" },
  { label: "Keycloak", value: "keycloak" },
  { label: "Ory", value: "ory" },
  { label: "Other OIDC Provider", value: "other" },
];

// External logging forwards decision logs to a centralized logging platform.
// Cloud object storage (S3/Blob/GCS) for decision logs is configured in the
// dedicated Object Storage step, so it is intentionally not offered here.
const LOGGING_PLATFORM_SINKS = [
  { label: "Datadog", value: "datadog" },
  { label: "Splunk (HEC)", value: "splunk" },
  { label: "Elasticsearch", value: "elasticsearch" },
  { label: "Grafana Loki", value: "loki" },
  { label: "New Relic", value: "newrelic" },
  { label: "Axiom", value: "axiom" },
];

// Datadog sites
const DATADOG_SITES = [
  { label: "US1 (datadoghq.com)", value: "datadoghq.com" },
  { label: "US3 (us3.datadoghq.com)", value: "us3.datadoghq.com" },
  { label: "US5 (us5.datadoghq.com)", value: "us5.datadoghq.com" },
  { label: "EU1 (datadoghq.eu)", value: "datadoghq.eu" },
  { label: "AP1 (ap1.datadoghq.com)", value: "ap1.datadoghq.com" },
];

const REMOTE_WRITE_DESTINATIONS = [
  { label: "AWS Managed Prometheus (AMP)", value: "aws-amp" },
  { label: "Azure Monitor managed Prometheus", value: "azure-monitor" },
  { label: "Grafana Cloud", value: "grafana-cloud" },
  { label: "Generic Prometheus remote_write", value: "generic" },
];

const AZURE_REMOTE_WRITE_AUTH = [
  { label: "Workload identity", value: "workload-identity" },
  { label: "Managed identity", value: "managed-identity" },
  { label: "OAuth client secret", value: "oauth" },
];

const GENERIC_REMOTE_WRITE_AUTH = [
  { label: "No additional auth", value: "none" },
  { label: "Basic auth from Kubernetes Secret", value: "basic" },
  { label: "Bearer token from Kubernetes Secret", value: "bearer" },
];

export function FeatureConfigStep({
  onComplete,
  onBack,
  entryDirection,
}: FeatureConfigStepProps) {
  const { state, dispatch } = useWizard();
  const { colors } = useTheme();

  // Determine what needs to be configured. Metrics export (Prometheus
  // remote_write) is opt-in via the Features step; in-cluster Prometheus is
  // always installed and needs no configuration.
  // Show the OpenAI key step whenever AI is enabled, even if a key is already
  // in wizard state (e.g. pre-filled from the saved profile or an existing
  // config on redeploy). The input is seeded with that value so the user can
  // confirm or change it — previously a pre-filled key silently skipped this
  // step entirely, which looked like the wizard never collected the key.
  const needsAI = state.aiEnabled;
  const needsSSO = state.ssoEnabled;
  const needsMonitoring = !state.clickStackEnabled && state.metricsExportEnabled;
  const needsLogging = state.loggingSink !== "console";
  const needsTracing = !state.clickStackEnabled && state.tracingEnabled;
  const needsAppLogs = !state.clickStackEnabled && state.appLogsEnabled;
  const needsValkeyAdmin = state.valkeyAdminEnabled;
  const needsCustomEmails = state.customEmailsEnabled;

  // Configuration order:
  // AI -> SSO -> Monitoring -> Logging -> Tracing -> AppLogs -> Valkey Admin -> Custom Emails
  const getInitialStep = (): SubStep => {
    if (needsAI) return "openai-key";
    if (needsSSO) return "sso-provider";
    if (needsMonitoring) return "monitoring-remote-write-destination";
    if (needsLogging) return "logging-sink";
    if (needsTracing) return "tracing-destination";
    if (needsAppLogs) return "applogs-endpoint";
    if (needsValkeyAdmin) return "valkey-admin-username";
    if (needsCustomEmails) return "email-subject-invite";
    return "done";
  };

  // Terminal sub-step of the last enabled section. Used when navigating *back*
  // into this step so the user resumes at the end instead of the very start.
  const tracingFinalStep = (): SubStep => {
    const destination = state.tracingDestination || "elastic";
    if (destination === "otlp") {
      return state.tracingOtlpAuthMode && state.tracingOtlpAuthMode !== "none"
        ? "tracing-otlp-cred"
        : "tracing-otlp-auth";
    }
    if (destination === "azure-monitor") return "tracing-azure-connection";
    return "tracing-token";
  };

  const loggingFinalStep = (): SubStep => {
    switch (state.loggingSink) {
      case "datadog":
        return "logging-datadog-config";
      case "splunk":
        return "logging-splunk-config";
      case "elasticsearch":
        return "logging-elasticsearch-config";
      case "loki":
        return "logging-loki-config";
      case "newrelic":
        return "logging-newrelic-config";
      case "axiom":
        return "logging-axiom-config";
      default:
        return "logging-sink";
    }
  };

  const getFinalStep = (): SubStep => {
    if (needsCustomEmails) return "email-template-change";
    if (needsValkeyAdmin) return "valkey-admin-allowed-ips";
    if (needsAppLogs) return "applogs-index";
    if (needsTracing) return tracingFinalStep();
    if (needsLogging) return loggingFinalStep();
    if (needsMonitoring) return "monitoring-remote-write-destination";
    if (needsSSO) return "sso-client-secret";
    if (needsAI) return "openai-key";
    return "done";
  };

  const [subStep, setSubStep] = useState<SubStep>(
    entryDirection === "back" ? getFinalStep : getInitialStep,
  );
  const [openaiKey, setOpenaiKey] = useState(state.openaiApiKey || "");
  const [ssoProvider, setSsoProvider] = useState<SSOProvider | null>(
    state.ssoProvider,
  );
  const [ssoUrl, setSsoUrl] = useState(state.ssoUrl || "");
  const [ssoClientId, setSsoClientId] = useState(state.ssoClientId || "");
  const [ssoClientSecret, setSsoClientSecret] = useState(
    state.ssoClientSecret || "",
  );
  const [remoteWriteUrl, setRemoteWriteUrl] = useState(
    state.prometheusRemoteWriteUrl || "",
  );
  const [remoteWriteDestination, setRemoteWriteDestination] =
    useState<RemoteWriteDestination | null>(
      state.prometheusRemoteWriteDestination,
    );
  const [remoteWriteAuthType, setRemoteWriteAuthType] =
    useState<RemoteWriteAuthType | null>(state.prometheusRemoteWriteAuthType);
  const [remoteWriteAwsRegion, setRemoteWriteAwsRegion] = useState(
    state.prometheusRemoteWriteAwsRegion || state.region || "us-east-1",
  );
  const [remoteWriteAzureCloud] = useState<
    "AzurePublic" | "AzureChina" | "AzureGovernment"
  >(state.prometheusRemoteWriteAzureCloud || "AzurePublic");
  const [remoteWriteClientId, setRemoteWriteClientId] = useState(
    state.prometheusRemoteWriteClientId || "",
  );
  const [remoteWriteTenantId, setRemoteWriteTenantId] = useState(
    state.prometheusRemoteWriteTenantId || "",
  );
  const [remoteWriteSecretRef, setRemoteWriteSecretRef] = useState(
    state.prometheusRemoteWriteSecretRef || "",
  );
  const [remoteWriteUsernameSecretRef, setRemoteWriteUsernameSecretRef] =
    useState(state.prometheusRemoteWriteUsernameSecretRef || "");
  const [remoteWritePasswordSecretRef, setRemoteWritePasswordSecretRef] =
    useState(state.prometheusRemoteWritePasswordSecretRef || "");
  const [remoteWriteBearerSecretRef, setRemoteWriteBearerSecretRef] = useState(
    state.prometheusRemoteWriteBearerTokenSecretRef || "",
  );
  const [loggingSink, setLoggingSink] = useState<LoggingSink>(
    state.loggingSink,
  );
  const [error, setError] = useState<string | null>(null);

  // Logging platform config
  const [datadogApiKey, setDatadogApiKey] = useState("");
  const [datadogSite, setDatadogSite] = useState("datadoghq.com");
  const [splunkHecToken, setSplunkHecToken] = useState("");
  const [splunkUrl, setSplunkUrl] = useState("");
  const [elasticsearchUrl, setElasticsearchUrl] = useState("");
  const [elasticsearchUser, setElasticsearchUser] = useState("");
  const [elasticsearchPass, setElasticsearchPass] = useState("");
  const [elasticsearchIndex, setElasticsearchIndex] =
    useState("rulebricks-logs");
  const [lokiUrl, setLokiUrl] = useState("");
  const [newrelicLicenseKey, setNewrelicLicenseKey] = useState("");
  const [newrelicAccountId, setNewrelicAccountId] = useState("");
  const [axiomApiToken, setAxiomApiToken] = useState("");
  const [axiomDataset, setAxiomDataset] = useState("rulebricks");

  // Distributed tracing. The wizard supports three destinations (Elastic APM,
  // generic OTLP/HTTP, Azure Monitor). For Elastic it collects endpoint + secret
  // token (api-key auth remains available via config file).
  const [tracingDestination, setTracingDestination] =
    useState<TracingDestination>(state.tracingDestination || "elastic");
  const [tracingEndpoint, setTracingEndpoint] = useState(
    state.tracingElasticEndpoint || "",
  );
  const [tracingToken, setTracingToken] = useState(
    state.tracingElasticSecretToken || "",
  );
  const [tracingOtlpEndpoint, setTracingOtlpEndpoint] = useState(
    state.tracingOtlpEndpoint || "",
  );
  const [tracingOtlpAuthMode, setTracingOtlpAuthMode] = useState<
    "none" | "bearer" | "api-key"
  >(
    state.tracingOtlpAuthMode === "bearer" ||
      state.tracingOtlpAuthMode === "api-key"
      ? state.tracingOtlpAuthMode
      : "none",
  );
  const [tracingOtlpToken, setTracingOtlpToken] = useState(
    state.tracingOtlpToken || "",
  );
  const [tracingAzureConnectionString, setTracingAzureConnectionString] =
    useState(state.tracingAzureConnectionString || "");

  // Application log shipping (BYO Elasticsearch via Vector agent). Basic auth.
  const [appLogsEndpoint, setAppLogsEndpoint] = useState(
    state.appLogsElasticEndpoint || "",
  );
  const [appLogsUser, setAppLogsUser] = useState(
    state.appLogsElasticUsername || "",
  );
  const [appLogsPass, setAppLogsPass] = useState(
    state.appLogsElasticPassword || "",
  );
  const [appLogsIndex, setAppLogsIndex] = useState(
    state.appLogsElasticIndex || "rulebricks-app-logs",
  );

  const [defaultValkeyAdminPassword] = useState(() => generateSecureSecret(16));
  const [valkeyAdminUsername, setValkeyAdminUsername] = useState(() => {
    const existingUser = state.valkeyAdminBasicAuthUsers[0];
    return existingUser?.split(":")[0] || "admin";
  });
  const [valkeyAdminPassword, setValkeyAdminPassword] = useState("");
  const [valkeyAdminAllowedIPs, setValkeyAdminAllowedIPs] = useState(
    state.valkeyAdminAllowedIPs.join(", "),
  );

  // Dynamic resource lists for remote-write identity selection.
  const [rwRegions, setRwRegions] = useState<string[]>([]);
  const [rwIdentities, setRwIdentities] = useState<AzureManagedIdentity[]>([]);
  const [rwTargets, setRwTargets] = useState<RemoteWriteTarget[]>([]);

  // Only offer the managed-Prometheus option for the cluster's own cloud (no
  // AWS Managed Prometheus on an Azure cluster, etc.); Grafana Cloud and generic
  // remote_write stay available everywhere.
  const remoteWriteDestinations = REMOTE_WRITE_DESTINATIONS.filter((d) => {
    if (d.value === "aws-amp") return state.provider === "aws";
    if (d.value === "azure-monitor") return state.provider === "azure";
    return true;
  });
  const [rwTenantAutoDetected, setRwTenantAutoDetected] = useState(false);

  // Custom email templates
  const [emailSubjectInvite, setEmailSubjectInvite] = useState(
    state.emailSubjects?.invite || DEFAULT_EMAIL_SUBJECTS.invite,
  );
  const [emailSubjectConfirm, setEmailSubjectConfirm] = useState(
    state.emailSubjects?.confirmation || DEFAULT_EMAIL_SUBJECTS.confirmation,
  );
  const [emailSubjectRecovery, setEmailSubjectRecovery] = useState(
    state.emailSubjects?.recovery || DEFAULT_EMAIL_SUBJECTS.recovery,
  );
  const [emailSubjectChange, setEmailSubjectChange] = useState(
    state.emailSubjects?.emailChange || DEFAULT_EMAIL_SUBJECTS.emailChange,
  );
  const [emailTemplateInvite, setEmailTemplateInvite] = useState(
    state.emailTemplates?.invite || "",
  );
  const [emailTemplateConfirm, setEmailTemplateConfirm] = useState(
    state.emailTemplates?.confirmation || "",
  );
  const [emailTemplateRecovery, setEmailTemplateRecovery] = useState(
    state.emailTemplates?.recovery || "",
  );
  const [emailTemplateChange, setEmailTemplateChange] = useState(
    state.emailTemplates?.emailChange || "",
  );

  // If nothing needs configuration, complete immediately
  useEffect(() => {
    if (
      !needsAI &&
      !needsSSO &&
      !needsMonitoring &&
      !needsLogging &&
      !needsTracing &&
      !needsAppLogs &&
      !needsValkeyAdmin &&
      !needsCustomEmails
    ) {
      onComplete();
    }
  }, []);

  useGatedInput((input, key) => {
    if (key.escape) {
      setError(null);
      handleBack();
    }
  });

  const handleBack = () => {
    switch (subStep) {
      case "openai-key":
        onBack();
        break;
      case "sso-provider":
        if (needsAI) setSubStep("openai-key");
        else onBack();
        break;
      case "sso-url":
        setSubStep("sso-provider");
        break;
      case "sso-client-id":
        if (ssoProvider === "google") setSubStep("sso-provider");
        else setSubStep("sso-url");
        break;
      case "sso-client-secret":
        setSubStep("sso-client-id");
        break;
      case "monitoring-remote-write-destination":
        if (needsSSO) setSubStep("sso-client-secret");
        else if (needsAI) setSubStep("openai-key");
        else onBack();
        break;
      case "monitoring-azure-target-loading":
      case "monitoring-azure-target":
      case "monitoring-aws-region-loading":
      case "monitoring-aws-region":
        // Azure target discovery and AWS region both branch directly off the
        // destination choice.
        setSubStep("monitoring-remote-write-destination");
        break;
      case "monitoring-aws-workspace-loading":
      case "monitoring-aws-workspace":
        setSubStep("monitoring-aws-region");
        break;
      case "monitoring-remote-write-url":
        // The manual-URL fallback is reached from the discovery picker.
        if (remoteWriteDestination === "azure-monitor") {
          setSubStep("monitoring-azure-target");
        } else if (remoteWriteDestination === "aws-amp") {
          setSubStep("monitoring-aws-workspace");
        } else {
          setSubStep("monitoring-remote-write-destination");
        }
        break;
      case "monitoring-remote-write-azure-auth":
        setSubStep("monitoring-azure-target");
        break;
      case "monitoring-remote-write-generic-auth":
        setSubStep("monitoring-remote-write-url");
        break;
      case "monitoring-azure-identity-loading":
      case "monitoring-remote-write-client-id":
        if (remoteWriteDestination === "azure-monitor") {
          setSubStep("monitoring-remote-write-azure-auth");
        } else {
          setSubStep("monitoring-remote-write-url");
        }
        break;
      case "monitoring-remote-write-client-id-manual":
        setSubStep("monitoring-remote-write-client-id");
        break;
      case "monitoring-remote-write-tenant-id":
        setSubStep("monitoring-remote-write-client-id");
        break;
      case "monitoring-remote-write-secret-ref":
        setSubStep(
          remoteWriteDestination === "azure-monitor"
            ? "monitoring-remote-write-tenant-id"
            : "monitoring-remote-write-url",
        );
        break;
      case "monitoring-remote-write-username-secret-ref":
        setSubStep(
          remoteWriteDestination === "grafana-cloud"
            ? "monitoring-remote-write-url"
            : "monitoring-remote-write-generic-auth",
        );
        break;
      case "monitoring-remote-write-password-secret-ref":
        setSubStep("monitoring-remote-write-username-secret-ref");
        break;
      case "monitoring-remote-write-bearer-secret-ref":
        setSubStep("monitoring-remote-write-generic-auth");
        break;
      case "logging-sink":
        if (needsMonitoring) setSubStep("monitoring-remote-write-destination");
        else if (needsSSO) setSubStep("sso-client-secret");
        else if (needsAI) setSubStep("openai-key");
        else onBack();
        break;
      // Logging platform config steps
      case "logging-datadog-config":
      case "logging-splunk-config":
      case "logging-elasticsearch-config":
      case "logging-loki-config":
      case "logging-newrelic-config":
      case "logging-axiom-config":
        setSubStep("logging-sink");
        break;
      // Distributed tracing steps
      case "tracing-destination":
        if (needsLogging) setSubStep("logging-sink");
        else if (needsMonitoring)
          setSubStep("monitoring-remote-write-destination");
        else if (needsSSO) setSubStep("sso-client-secret");
        else if (needsAI) setSubStep("openai-key");
        else onBack();
        break;
      case "tracing-endpoint":
      case "tracing-otlp-endpoint":
      case "tracing-azure-connection":
        setSubStep("tracing-destination");
        break;
      case "tracing-token":
        setSubStep("tracing-endpoint");
        break;
      case "tracing-otlp-auth":
        setSubStep("tracing-otlp-endpoint");
        break;
      case "tracing-otlp-cred":
        setSubStep("tracing-otlp-auth");
        break;
      // Application log shipping steps
      case "applogs-endpoint":
        if (needsTracing) setSubStep(tracingFinalStep());
        else if (needsLogging) setSubStep(loggingFinalStep());
        else if (needsMonitoring)
          setSubStep("monitoring-remote-write-destination");
        else if (needsSSO) setSubStep("sso-client-secret");
        else if (needsAI) setSubStep("openai-key");
        else onBack();
        break;
      case "applogs-user":
        setSubStep("applogs-endpoint");
        break;
      case "applogs-pass":
        setSubStep("applogs-user");
        break;
      case "applogs-index":
        setSubStep("applogs-pass");
        break;
      // Valkey Admin steps
      case "valkey-admin-username":
        if (needsAppLogs) setSubStep("applogs-index");
        else if (needsTracing) setSubStep(tracingFinalStep());
        else if (needsLogging) setSubStep(loggingFinalStep());
        else if (needsMonitoring)
          setSubStep("monitoring-remote-write-destination");
        else if (needsSSO) setSubStep("sso-client-secret");
        else if (needsAI) setSubStep("openai-key");
        else onBack();
        break;
      case "valkey-admin-password":
        setSubStep("valkey-admin-username");
        break;
      case "valkey-admin-allowed-ips":
        setSubStep("valkey-admin-password");
        break;
      // Email template steps
      case "email-subject-invite":
        if (needsValkeyAdmin) {
          setSubStep("valkey-admin-allowed-ips");
        } else if (needsAppLogs) setSubStep("applogs-index");
        else if (needsTracing) setSubStep(tracingFinalStep());
        else if (needsLogging) setSubStep(loggingFinalStep());
        else if (needsMonitoring)
          setSubStep("monitoring-remote-write-destination");
        else if (needsSSO) setSubStep("sso-client-secret");
        else if (needsAI) setSubStep("openai-key");
        else onBack();
        break;
      case "email-subject-confirm":
        setSubStep("email-subject-invite");
        break;
      case "email-subject-recovery":
        setSubStep("email-subject-confirm");
        break;
      case "email-subject-change":
        setSubStep("email-subject-recovery");
        break;
      case "email-template-invite":
        setSubStep("email-subject-change");
        break;
      case "email-template-confirm":
        setSubStep("email-template-invite");
        break;
      case "email-template-recovery":
        setSubStep("email-template-confirm");
        break;
      case "email-template-change":
        setSubStep("email-template-recovery");
        break;
    }
  };

  // Section sequencing helpers. Each "goTo<Section>OrAfter" advances to the next
  // enabled section, so adding a section only required inserting it into this
  // chain (Logging -> Tracing -> AppLogs -> Valkey Admin -> Custom Emails).
  const goToCustomEmailsOrDone = () => {
    if (needsCustomEmails) setSubStep("email-subject-invite");
    else onComplete();
  };
  const goToValkeyAdminOrAfter = () => {
    if (needsValkeyAdmin) setSubStep("valkey-admin-username");
    else goToCustomEmailsOrDone();
  };
  const goToAppLogsOrAfter = () => {
    if (needsAppLogs) setSubStep("applogs-endpoint");
    else goToValkeyAdminOrAfter();
  };
  const goToTracingOrAfter = () => {
    if (needsTracing) setSubStep("tracing-destination");
    else goToAppLogsOrAfter();
  };
  const goToLoggingOrAfter = () => {
    if (needsLogging) setSubStep("logging-sink");
    else goToTracingOrAfter();
  };
  const goToMonitoringOrAfter = () => {
    if (needsMonitoring) setSubStep("monitoring-remote-write-destination");
    else goToLoggingOrAfter();
  };

  const advanceToNext = (from: SubStep) => {
    switch (from) {
      case "openai-key":
        if (needsSSO) setSubStep("sso-provider");
        else goToMonitoringOrAfter();
        break;
      case "sso-client-secret":
        goToMonitoringOrAfter();
        break;
      case "monitoring-remote-write-destination":
      case "monitoring-remote-write-url":
      case "monitoring-aws-region":
      case "monitoring-remote-write-azure-auth":
      case "monitoring-remote-write-generic-auth":
      case "monitoring-remote-write-client-id":
      case "monitoring-remote-write-tenant-id":
      case "monitoring-remote-write-secret-ref":
      case "monitoring-remote-write-username-secret-ref":
      case "monitoring-remote-write-password-secret-ref":
      case "monitoring-remote-write-bearer-secret-ref":
        goToLoggingOrAfter();
        break;
      case "logging-datadog-config":
      case "logging-splunk-config":
      case "logging-elasticsearch-config":
      case "logging-loki-config":
      case "logging-newrelic-config":
      case "logging-axiom-config":
        // Decision-log platform config complete -> tracing/appLogs/emails.
        goToTracingOrAfter();
        break;
      case "tracing-token":
      case "tracing-otlp-cred":
      case "tracing-azure-connection":
        goToAppLogsOrAfter();
        break;
      case "applogs-index":
        goToValkeyAdminOrAfter();
        break;
      case "valkey-admin-allowed-ips":
        goToCustomEmailsOrDone();
        break;
      case "email-template-change":
        // All email config complete
        onComplete();
        break;
    }
  };

  // === AI Configuration ===
  const handleOpenAIKeySubmit = () => {
    if (!openaiKey) {
      setError("OpenAI API key is required for AI features");
      return;
    }
    if (!openaiKey.startsWith("sk-")) {
      setError('OpenAI API key should start with "sk-"');
      return;
    }
    setError(null);
    dispatch({ type: "SET_OPENAI_KEY", key: openaiKey });
    advanceToNext("openai-key");
  };

  // === SSO Configuration ===
  const handleSsoProviderSelect = (item: { value: string }) => {
    const provider = item.value as SSOProvider;
    setSsoProvider(provider);
    dispatch({ type: "SET_SSO_CONFIG", config: { ssoProvider: provider } });

    if (provider === "google") {
      setSubStep("sso-client-id");
    } else {
      setSubStep("sso-url");
    }
  };

  const handleSsoUrlSubmit = () => {
    if (!ssoUrl) {
      setError("SSO provider URL is required");
      return;
    }
    try {
      new URL(ssoUrl);
    } catch {
      setError("Invalid URL format");
      return;
    }
    setError(null);
    setSubStep("sso-client-id");
  };

  const handleSsoClientIdSubmit = () => {
    if (!ssoClientId) {
      setError("Client ID is required");
      return;
    }
    setError(null);
    setSubStep("sso-client-secret");
  };

  const handleSsoClientSecretSubmit = () => {
    if (!ssoClientSecret) {
      setError("Client secret is required");
      return;
    }
    setError(null);

    dispatch({
      type: "SET_SSO_CONFIG",
      config: {
        ssoProvider,
        ssoUrl,
        ssoClientId,
        ssoClientSecret,
      },
    });

    advanceToNext("sso-client-secret");
  };

  // === Monitoring Configuration ===
  const handleRemoteWriteDestinationSelect = (item: { value: string }) => {
    const destination = item.value as RemoteWriteDestination;
    setRemoteWriteDestination(destination);
    setError(null);
    dispatch({
      type: "SET_PROMETHEUS_REMOTE_WRITE_CONFIG",
      config: {
        prometheusMonitoringDestination: destination,
        prometheusRemoteWriteDestination: destination,
      },
    });
    // Auto-discover the remote_write URL where we can, so the user selects an
    // existing target instead of hand-building a URL. Manual entry stays available.
    if (destination === "azure-monitor") {
      loadAzureTargets();
    } else if (destination === "aws-amp") {
      loadAwsRegions();
    } else {
      setSubStep("monitoring-remote-write-url");
    }
  };

  // Azure Monitor: discover Data Collection Rules that ingest Prometheus metrics
  // and pre-assemble each remote_write URL.
  const loadAzureTargets = async () => {
    setSubStep("monitoring-azure-target-loading");
    try {
      setRwTargets(await listAzurePrometheusTargets());
    } catch {
      setRwTargets([]);
    }
    setSubStep("monitoring-azure-target");
  };

  const handleAzureTargetSelect = (item: { value: string }) => {
    if (item.value === REFRESH) {
      loadAzureTargets();
      return;
    }
    if (item.value === MANUAL) {
      setSubStep("monitoring-remote-write-url");
      return;
    }
    setRemoteWriteUrl(item.value);
    dispatch({ type: "SET_PROMETHEUS_REMOTE_WRITE", url: item.value });
    setError(null);
    setSubStep("monitoring-remote-write-azure-auth");
  };

  // AWS Managed Prometheus: discover workspaces in the chosen region and
  // pre-assemble each remote_write URL.
  const loadAwsWorkspaces = async (region: string) => {
    setSubStep("monitoring-aws-workspace-loading");
    try {
      setRwTargets(await listAwsPrometheusWorkspaces(region));
    } catch {
      setRwTargets([]);
    }
    setSubStep("monitoring-aws-workspace");
  };

  const handleAwsWorkspaceSelect = (item: { value: string }) => {
    if (item.value === REFRESH) {
      loadAwsWorkspaces(remoteWriteAwsRegion);
      return;
    }
    if (item.value === MANUAL) {
      setSubStep("monitoring-remote-write-url");
      return;
    }
    setRemoteWriteUrl(item.value);
    dispatch({ type: "SET_PROMETHEUS_REMOTE_WRITE", url: item.value });
    setError(null);
    saveAwsAmpConfig("");
  };

  const handleRemoteWriteUrlSubmit = () => {
    if (!remoteWriteUrl) {
      setError(
        "Remote write URL is required. If you don't have a destination yet, go back and disable Metrics Export.",
      );
      return;
    }

    try {
      new URL(remoteWriteUrl);
    } catch {
      setError("Invalid URL format");
      return;
    }
    // Azure Monitor needs the full DCE metrics-ingestion path, not the bare DCE
    // host. Catch it here so the user gets immediate feedback instead of a
    // failure at save time.
    if (
      remoteWriteDestination === "azure-monitor" &&
      !(
        remoteWriteUrl.includes("/dataCollectionRules/") &&
        remoteWriteUrl.includes("/streams/") &&
        remoteWriteUrl.includes("/api/v1/write")
      )
    ) {
      setError(
        "Azure Monitor needs the full ingestion URL, e.g.\n" +
          "https://<dce>.<region>.metrics.ingest.monitor.azure.com/dataCollectionRules/<dcrImmutableId>/streams/Microsoft-PrometheusMetrics/api/v1/write?api-version=2023-04-24\n" +
          "(the data collection endpoint host alone won't work).",
      );
      return;
    }
    setError(null);
    dispatch({ type: "SET_PROMETHEUS_REMOTE_WRITE", url: remoteWriteUrl });

    if (remoteWriteDestination === "aws-amp") {
      // Region was already chosen before this manual-URL fallback (it's reached
      // from the workspace picker), so save directly.
      saveAwsAmpConfig("");
    } else if (remoteWriteDestination === "azure-monitor") {
      setSubStep("monitoring-remote-write-azure-auth");
    } else if (remoteWriteDestination === "grafana-cloud") {
      setRemoteWriteAuthType("basic");
      dispatch({
        type: "SET_PROMETHEUS_REMOTE_WRITE_CONFIG",
        config: { prometheusRemoteWriteAuthType: "basic" },
      });
      setSubStep("monitoring-remote-write-username-secret-ref");
    } else if (remoteWriteDestination === "generic") {
      setSubStep("monitoring-remote-write-generic-auth");
    } else {
      setError("Select a remote_write destination first");
    }
  };

  // AWS Managed Prometheus: pick region then IRSA role from CLI-backed lists.
  const loadAwsRegions = async () => {
    setSubStep("monitoring-aws-region-loading");
    try {
      const regions = await listRegions("aws");
      setRwRegions(regions.length > 0 ? regions : CLOUD_REGIONS.aws);
    } catch {
      setRwRegions(CLOUD_REGIONS.aws);
    }
    setSubStep("monitoring-aws-region");
  };

  const handleAwsRegionSelect = (item: { value: string }) => {
    setRemoteWriteAwsRegion(item.value);
    // Discover AMP workspaces in this region; the role is the single Rulebricks
    // role from the Storage step (reused at assembly), so there's no role prompt.
    loadAwsWorkspaces(item.value);
  };

  const saveAwsAmpConfig = (roleArn: string) => {
    dispatch({
      type: "SET_PROMETHEUS_REMOTE_WRITE_CONFIG",
      config: {
        prometheusRemoteWriteDestination: "aws-amp",
        prometheusMonitoringDestination: "aws-amp",
        prometheusRemoteWriteAuthType: "none",
        prometheusRemoteWriteAwsRegion: remoteWriteAwsRegion,
        prometheusRemoteWriteAwsRoleArn: roleArn,
      },
    });
    setError(null);
    advanceToNext("monitoring-aws-region");
  };

  const saveRemoteWriteConfig = (
    authType: RemoteWriteAuthType,
    overrides: Partial<{
      clientId: string;
      tenantId: string;
      secretRef: string;
      usernameSecretRef: string;
      passwordSecretRef: string;
      bearerTokenSecretRef: string;
    }> = {},
  ) => {
    if (!remoteWriteDestination || !remoteWriteUrl) {
      setError("Remote write destination and URL are required");
      return;
    }

    dispatch({
      type: "SET_PROMETHEUS_REMOTE_WRITE_CONFIG",
      config: {
        prometheusRemoteWriteDestination: remoteWriteDestination,
        prometheusMonitoringDestination: remoteWriteDestination,
        prometheusRemoteWriteAuthType: authType,
        prometheusRemoteWriteAzureCloud: remoteWriteAzureCloud,
        prometheusRemoteWriteClientId:
          overrides.clientId ?? remoteWriteClientId,
        prometheusRemoteWriteTenantId:
          overrides.tenantId ?? remoteWriteTenantId,
        prometheusRemoteWriteSecretRef:
          overrides.secretRef ?? remoteWriteSecretRef,
        prometheusRemoteWriteUsernameSecretRef:
          overrides.usernameSecretRef ?? remoteWriteUsernameSecretRef,
        prometheusRemoteWritePasswordSecretRef:
          overrides.passwordSecretRef ?? remoteWritePasswordSecretRef,
        prometheusRemoteWriteBearerTokenSecretRef:
          overrides.bearerTokenSecretRef ?? remoteWriteBearerSecretRef,
      },
    });
    setError(null);
    advanceToNext("monitoring-remote-write-url");
  };

  const handleAzureRemoteWriteAuthSelect = (item: { value: string }) => {
    const authType = item.value as RemoteWriteAuthType;
    setRemoteWriteAuthType(authType);
    dispatch({
      type: "SET_PROMETHEUS_REMOTE_WRITE_CONFIG",
      config: { prometheusRemoteWriteAuthType: authType },
    });
    // Workload/managed identity reuse the single Rulebricks identity chosen in
    // the Storage step (filled in during config assembly), so there's no second
    // identity to pick here. Only OAuth needs its own app-registration credentials.
    if (authType === "workload-identity" || authType === "managed-identity") {
      saveRemoteWriteConfig(authType);
      return;
    }
    loadAzureIdentitiesForRemoteWrite();
  };

  // Azure Monitor: pick the managed/workload identity client ID from a list and
  // auto-fill the tenant ID from the active Azure CLI session.
  const loadAzureIdentitiesForRemoteWrite = async () => {
    setSubStep("monitoring-azure-identity-loading");
    try {
      const [identities, tenant] = await Promise.all([
        listAzureManagedIdentities(),
        remoteWriteTenantId
          ? Promise.resolve<string | null>(null)
          : getAzureTenantId(),
      ]);
      setRwIdentities(identities);
      if (tenant) {
        setRemoteWriteTenantId(tenant);
        setRwTenantAutoDetected(true);
      }
    } catch {
      setRwIdentities([]);
    }
    setSubStep("monitoring-remote-write-client-id");
  };

  const proceedAfterClientId = () => {
    if (remoteWriteAuthType === "managed-identity") {
      saveRemoteWriteConfig("managed-identity", {
        clientId: remoteWriteClientId,
      });
      return;
    }
    setError(null);
    setSubStep("monitoring-remote-write-tenant-id");
  };

  const handleRemoteWriteClientIdSelect = (item: { value: string }) => {
    if (item.value === MANUAL) {
      setSubStep("monitoring-remote-write-client-id-manual");
      return;
    }
    setRemoteWriteClientId(item.value);
    proceedAfterClientId();
  };

  const handleGenericRemoteWriteAuthSelect = (item: { value: string }) => {
    const authType = item.value as RemoteWriteAuthType;
    setRemoteWriteAuthType(authType);

    if (authType === "none") {
      saveRemoteWriteConfig("none");
    } else if (authType === "basic") {
      setSubStep("monitoring-remote-write-username-secret-ref");
    } else {
      setSubStep("monitoring-remote-write-bearer-secret-ref");
    }
  };

  const handleRemoteWriteClientIdSubmit = () => {
    if (!remoteWriteClientId) {
      setError("Client ID is required");
      return;
    }
    proceedAfterClientId();
  };

  const handleRemoteWriteTenantIdSubmit = () => {
    if (!remoteWriteTenantId) {
      setError("Tenant ID is required");
      return;
    }

    if (remoteWriteAuthType === "workload-identity") {
      saveRemoteWriteConfig("workload-identity", {
        clientId: remoteWriteClientId,
        tenantId: remoteWriteTenantId,
      });
      return;
    }

    setError(null);
    setSubStep("monitoring-remote-write-secret-ref");
  };

  const handleRemoteWriteSecretRefSubmit = () => {
    if (!remoteWriteSecretRef.includes(":")) {
      setError("Use secret-name:key format");
      return;
    }
    saveRemoteWriteConfig(remoteWriteAuthType || "oauth", {
      clientId: remoteWriteClientId,
      tenantId: remoteWriteTenantId,
      secretRef: remoteWriteSecretRef,
    });
  };

  const handleRemoteWriteUsernameSecretRefSubmit = () => {
    if (!remoteWriteUsernameSecretRef.includes(":")) {
      setError("Use secret-name:key format");
      return;
    }
    setError(null);
    setSubStep("monitoring-remote-write-password-secret-ref");
  };

  const handleRemoteWritePasswordSecretRefSubmit = () => {
    if (!remoteWritePasswordSecretRef.includes(":")) {
      setError("Use secret-name:key format");
      return;
    }
    saveRemoteWriteConfig("basic", {
      usernameSecretRef: remoteWriteUsernameSecretRef,
      passwordSecretRef: remoteWritePasswordSecretRef,
    });
  };

  const handleRemoteWriteBearerSecretRefSubmit = () => {
    if (!remoteWriteBearerSecretRef.includes(":")) {
      setError("Use secret-name:key format");
      return;
    }
    saveRemoteWriteConfig("bearer", {
      bearerTokenSecretRef: remoteWriteBearerSecretRef,
    });
  };

  // === Logging Configuration (external logging platforms) ===
  const handleLoggingSinkSelect = (item: { value: string }) => {
    const sink = item.value as LoggingSink;
    setLoggingSink(sink);
    dispatch({ type: "SET_LOGGING_SINK", sink });

    switch (sink) {
      case "datadog":
        setSubStep("logging-datadog-config");
        break;
      case "splunk":
        setSubStep("logging-splunk-config");
        break;
      case "elasticsearch":
        setSubStep("logging-elasticsearch-config");
        break;
      case "loki":
        setSubStep("logging-loki-config");
        break;
      case "newrelic":
        setSubStep("logging-newrelic-config");
        break;
      case "axiom":
        setSubStep("logging-axiom-config");
        break;
    }
  };

  // === Logging Platform Config Handlers ===

  const handleDatadogConfigSubmit = () => {
    if (!datadogApiKey) {
      setError("Datadog API key is required");
      return;
    }
    setError(null);
    dispatch({
      type: "SET_LOGGING_CONFIG",
      config: {
        loggingPlatformCredential: datadogApiKey, // platform API key
        loggingPlatformDetail: datadogSite, // platform site
      },
    });
    advanceToNext("logging-datadog-config");
  };

  const handleSplunkConfigSubmit = () => {
    if (!splunkUrl) {
      setError("Splunk HEC URL is required");
      return;
    }
    if (!splunkHecToken) {
      setError("Splunk HEC token is required");
      return;
    }
    try {
      new URL(splunkUrl);
    } catch {
      setError("Invalid URL format");
      return;
    }
    setError(null);
    dispatch({
      type: "SET_LOGGING_CONFIG",
      config: {
        loggingPlatformCredential: splunkHecToken,
        loggingPlatformDetail: splunkUrl,
      },
    });
    advanceToNext("logging-splunk-config");
  };

  const handleElasticsearchConfigSubmit = () => {
    if (!elasticsearchUrl) {
      setError("Elasticsearch URL is required");
      return;
    }
    try {
      new URL(elasticsearchUrl);
    } catch {
      setError("Invalid URL format");
      return;
    }
    setError(null);
    // Store the connection as JSON in the credential field for complex config.
    dispatch({
      type: "SET_LOGGING_CONFIG",
      config: {
        loggingPlatformCredential: JSON.stringify({
          url: elasticsearchUrl,
          user: elasticsearchUser,
          password: elasticsearchPass,
          index: elasticsearchIndex,
        }),
        loggingPlatformDetail: elasticsearchIndex,
      },
    });
    advanceToNext("logging-elasticsearch-config");
  };

  // === Distributed Tracing (Elastic APM) ===
  const handleTracingEndpointSubmit = () => {
    if (!tracingEndpoint) {
      setError("Elastic APM OTLP endpoint is required");
      return;
    }
    try {
      new URL(tracingEndpoint);
    } catch {
      setError("Invalid URL format");
      return;
    }
    setError(null);
    dispatch({
      type: "SET_TRACING_CONFIG",
      config: {
        tracingElasticEndpoint: tracingEndpoint,
        tracingElasticAuthMode: "secret-token",
      },
    });
    setSubStep("tracing-token");
  };

  const handleTracingTokenSubmit = () => {
    if (!tracingToken) {
      setError("Elastic APM secret token is required");
      return;
    }
    setError(null);
    dispatch({
      type: "SET_TRACING_CONFIG",
      config: { tracingElasticSecretToken: tracingToken },
    });
    advanceToNext("tracing-token");
  };

  const handleTracingDestinationSelect = (item: { value: string }) => {
    const destination = item.value as TracingDestination;
    setTracingDestination(destination);
    dispatch({
      type: "SET_TRACING_CONFIG",
      config: { tracingDestination: destination },
    });
    setError(null);
    if (destination === "elastic") setSubStep("tracing-endpoint");
    else if (destination === "otlp") setSubStep("tracing-otlp-endpoint");
    else setSubStep("tracing-azure-connection");
  };

  const handleTracingOtlpEndpointSubmit = () => {
    if (!tracingOtlpEndpoint) {
      setError("OTLP endpoint is required");
      return;
    }
    try {
      new URL(tracingOtlpEndpoint);
    } catch {
      setError("Invalid URL format");
      return;
    }
    setError(null);
    dispatch({
      type: "SET_TRACING_CONFIG",
      config: { tracingOtlpEndpoint },
    });
    setSubStep("tracing-otlp-auth");
  };

  const handleTracingOtlpAuthSelect = (item: { value: string }) => {
    const mode = item.value as "none" | "bearer" | "api-key";
    setTracingOtlpAuthMode(mode);
    dispatch({
      type: "SET_TRACING_CONFIG",
      config: { tracingOtlpAuthMode: mode },
    });
    setError(null);
    if (mode === "none") {
      // No credential needed; the section is complete.
      goToAppLogsOrAfter();
    } else {
      setSubStep("tracing-otlp-cred");
    }
  };

  const handleTracingOtlpCredSubmit = () => {
    if (!tracingOtlpToken) {
      setError("A credential is required for the selected OTLP auth mode");
      return;
    }
    setError(null);
    dispatch({
      type: "SET_TRACING_CONFIG",
      config: { tracingOtlpToken },
    });
    advanceToNext("tracing-otlp-cred");
  };

  const handleTracingAzureConnectionSubmit = () => {
    if (!tracingAzureConnectionString) {
      setError("Azure Monitor connection string is required");
      return;
    }
    setError(null);
    dispatch({
      type: "SET_TRACING_CONFIG",
      config: { tracingAzureConnectionString },
    });
    advanceToNext("tracing-azure-connection");
  };

  // === Application Log Shipping (BYO Elasticsearch) ===
  const handleAppLogsEndpointSubmit = () => {
    if (!appLogsEndpoint) {
      setError("Elasticsearch endpoint is required");
      return;
    }
    try {
      new URL(appLogsEndpoint);
    } catch {
      setError("Invalid URL format");
      return;
    }
    setError(null);
    dispatch({
      type: "SET_APP_LOGS_CONFIG",
      config: {
        appLogsElasticEndpoint: appLogsEndpoint,
        appLogsElasticAuthMode: "basic",
      },
    });
    setSubStep("applogs-user");
  };

  const handleAppLogsUserSubmit = () => {
    if (!appLogsUser) {
      setError("Elasticsearch username is required");
      return;
    }
    setError(null);
    dispatch({
      type: "SET_APP_LOGS_CONFIG",
      config: { appLogsElasticUsername: appLogsUser },
    });
    setSubStep("applogs-pass");
  };

  const handleAppLogsPassSubmit = () => {
    if (!appLogsPass) {
      setError("Elasticsearch password is required");
      return;
    }
    setError(null);
    dispatch({
      type: "SET_APP_LOGS_CONFIG",
      config: { appLogsElasticPassword: appLogsPass },
    });
    setSubStep("applogs-index");
  };

  const handleAppLogsIndexSubmit = () => {
    const index = appLogsIndex || "rulebricks-app-logs";
    setError(null);
    dispatch({
      type: "SET_APP_LOGS_CONFIG",
      config: { appLogsElasticIndex: index },
    });
    advanceToNext("applogs-index");
  };

  // === Valkey Admin Ingress ===
  const handleValkeyAdminUsernameSubmit = () => {
    const username = valkeyAdminUsername.trim();
    if (!username) {
      setError("Username is required");
      return;
    }
    if (username.includes(":")) {
      setError("Username cannot contain ':'");
      return;
    }
    setValkeyAdminUsername(username);
    setError(null);
    setSubStep("valkey-admin-password");
  };

  const handleValkeyAdminPasswordSubmit = () => {
    // Empty means "use a generated secure value", matching the Supabase flow.
    const effectivePassword =
      valkeyAdminPassword.trim() || defaultValkeyAdminPassword;
    if (effectivePassword.length < 8) {
      setError("Valkey Admin password must be at least 8 characters");
      return;
    }

    try {
      const htpasswdLine = generateHtpasswdLine(
        valkeyAdminUsername,
        effectivePassword,
      );
      dispatch({
        type: "SET_EXTERNAL_SERVICES",
        config: {
          valkeyAdminExposure: "ingress",
          valkeyAdminHostname: "",
          valkeyAdminBasicAuthUsers: [htpasswdLine],
        },
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to hash password");
      return;
    }

    setError(null);
    setSubStep("valkey-admin-allowed-ips");
  };

  const handleValkeyAdminAllowedIPsSubmit = () => {
    const allowedIPs = valkeyAdminAllowedIPs
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean);

    dispatch({
      type: "SET_EXTERNAL_SERVICES",
      config: { valkeyAdminAllowedIPs: allowedIPs },
    });
    setError(null);
    advanceToNext("valkey-admin-allowed-ips");
  };

  const handleLokiConfigSubmit = () => {
    if (!lokiUrl) {
      setError("Loki URL is required");
      return;
    }
    try {
      new URL(lokiUrl);
    } catch {
      setError("Invalid URL format");
      return;
    }
    setError(null);
    dispatch({
      type: "SET_LOGGING_CONFIG",
      config: {
        loggingPlatformCredential: lokiUrl,
        loggingPlatformDetail: "",
      },
    });
    advanceToNext("logging-loki-config");
  };

  const handleNewrelicConfigSubmit = () => {
    if (!newrelicLicenseKey) {
      setError("New Relic License Key is required");
      return;
    }
    if (!newrelicAccountId) {
      setError("New Relic Account ID is required");
      return;
    }
    setError(null);
    dispatch({
      type: "SET_LOGGING_CONFIG",
      config: {
        loggingPlatformCredential: newrelicLicenseKey,
        loggingPlatformDetail: newrelicAccountId,
      },
    });
    advanceToNext("logging-newrelic-config");
  };

  const handleAxiomConfigSubmit = () => {
    if (!axiomApiToken) {
      setError("Axiom API token is required");
      return;
    }
    if (!axiomDataset) {
      setError("Axiom dataset is required");
      return;
    }
    setError(null);
    dispatch({
      type: "SET_LOGGING_CONFIG",
      config: {
        loggingPlatformCredential: axiomApiToken,
        loggingPlatformDetail: axiomDataset,
      },
    });
    advanceToNext("logging-axiom-config");
  };

  // === Custom Email Configuration Handlers ===

  const handleEmailSubjectInviteSubmit = () => {
    dispatch({
      type: "SET_EMAIL_SUBJECTS",
      subjects: { invite: emailSubjectInvite },
    });
    setSubStep("email-subject-confirm");
  };

  const handleEmailSubjectConfirmSubmit = () => {
    dispatch({
      type: "SET_EMAIL_SUBJECTS",
      subjects: { confirmation: emailSubjectConfirm },
    });
    setSubStep("email-subject-recovery");
  };

  const handleEmailSubjectRecoverySubmit = () => {
    dispatch({
      type: "SET_EMAIL_SUBJECTS",
      subjects: { recovery: emailSubjectRecovery },
    });
    setSubStep("email-subject-change");
  };

  const handleEmailSubjectChangeSubmit = () => {
    dispatch({
      type: "SET_EMAIL_SUBJECTS",
      subjects: { emailChange: emailSubjectChange },
    });
    setSubStep("email-template-invite");
  };

  const validateUrl = (url: string): boolean => {
    if (!url) return false;
    try {
      new URL(url);
      return true;
    } catch {
      return false;
    }
  };

  const handleEmailTemplateInviteSubmit = () => {
    if (!validateUrl(emailTemplateInvite)) {
      setError("Please enter a valid URL for the invite template");
      return;
    }
    setError(null);
    dispatch({
      type: "SET_EMAIL_TEMPLATES",
      templates: { invite: emailTemplateInvite },
    });
    setSubStep("email-template-confirm");
  };

  const handleEmailTemplateConfirmSubmit = () => {
    if (!validateUrl(emailTemplateConfirm)) {
      setError("Please enter a valid URL for the confirmation template");
      return;
    }
    setError(null);
    dispatch({
      type: "SET_EMAIL_TEMPLATES",
      templates: { confirmation: emailTemplateConfirm },
    });
    setSubStep("email-template-recovery");
  };

  const handleEmailTemplateRecoverySubmit = () => {
    if (!validateUrl(emailTemplateRecovery)) {
      setError("Please enter a valid URL for the recovery template");
      return;
    }
    setError(null);
    dispatch({
      type: "SET_EMAIL_TEMPLATES",
      templates: { recovery: emailTemplateRecovery },
    });
    setSubStep("email-template-change");
  };

  const handleEmailTemplateChangeSubmit = () => {
    if (!validateUrl(emailTemplateChange)) {
      setError("Please enter a valid URL for the email change template");
      return;
    }
    setError(null);
    dispatch({
      type: "SET_EMAIL_TEMPLATES",
      templates: { emailChange: emailTemplateChange },
    });
    advanceToNext("email-template-change");
  };

  // If nothing to configure, don't render
  if (
    !needsAI &&
    !needsSSO &&
    !needsMonitoring &&
    !needsLogging &&
    !needsTracing &&
    !needsAppLogs &&
    !needsValkeyAdmin &&
    !needsCustomEmails
  ) {
    return null;
  }

  // Shared list item renderer (matches the wizard's other select lists).
  const selectItem = ({
    isSelected,
    label,
  }: {
    isSelected?: boolean;
    label: string;
  }) => (
    <Text color={isSelected ? colors.accent : undefined}>
      {isSelected ? "❯ " : "  "}
      {label}
    </Text>
  );

  // Progress summary
  const ProgressSummary = () => (
    <Box marginTop={1} flexDirection="column">
      {state.openaiApiKey && (
        <Box>
          <Text color={colors.success}>✓</Text>
          <Text color="gray"> OpenAI API key configured</Text>
        </Box>
      )}
      {state.ssoProvider && (
        <Box>
          <Text color={colors.success}>✓</Text>
          <Text color="gray"> SSO: {state.ssoProvider}</Text>
        </Box>
      )}
      {state.prometheusRemoteWriteUrl && (
        <Box>
          <Text color={colors.success}>✓</Text>
          <Text color="gray"> Metrics remote write configured</Text>
        </Box>
      )}
    </Box>
  );

  return (
    <BorderBox title="Feature Configuration">
      {/* AI Configuration */}
      {subStep === "openai-key" && (
        <Box flexDirection="column" marginY={1}>
          <Text bold>OpenAI API Key</Text>
          <Text color="gray" dimColor>
            Required for AI-powered rule generation features
          </Text>
          <Box marginTop={1}>
            <TextInput
              value={openaiKey}
              onChange={setOpenaiKey}
              onSubmit={handleOpenAIKeySubmit}
              placeholder="sk-..."
              mask="*"
            />
          </Box>
          <Box marginTop={1}>
            <Text color="gray" dimColor>
              Get your API key at: https://platform.openai.com/api-keys
            </Text>
          </Box>
        </Box>
      )}

      {/* SSO Configuration */}
      {subStep === "sso-provider" && (
        <Box flexDirection="column" marginY={1}>
          <Text bold>SSO Provider</Text>
          <Text color="gray" dimColor>
            Select your identity provider
          </Text>
          <Box marginTop={1}>
            <SelectInput
              items={SSO_PROVIDERS}
              onSelect={handleSsoProviderSelect}
              itemComponent={({ isSelected, label }) => (
                <Text color={isSelected ? colors.accent : undefined}>
                  {label}
                </Text>
              )}
            />
          </Box>
          <ProgressSummary />
        </Box>
      )}

      {subStep === "sso-url" && (
        <Box flexDirection="column" marginY={1}>
          <Text bold>{ssoProvider?.toUpperCase()} Provider URL</Text>
          <Text color="gray" dimColor>
            {ssoProvider === "azure" &&
              "e.g., https://login.microsoftonline.com/your-tenant-id"}
            {ssoProvider === "okta" && "e.g., https://your-org.okta.com"}
            {ssoProvider === "keycloak" &&
              "e.g., https://keycloak.example.com/realms/your-realm"}
            {ssoProvider === "ory" &&
              "e.g., https://your-project.projects.oryapis.com"}
            {ssoProvider === "other" && "The base URL of your OIDC provider"}
          </Text>
          <Box marginTop={1}>
            <TextInput
              value={ssoUrl}
              onChange={setSsoUrl}
              onSubmit={handleSsoUrlSubmit}
              placeholder="https://..."
            />
          </Box>
          <Box marginTop={1}>
            <Text color={colors.success}>✓</Text>
            <Text color="gray"> Provider: {ssoProvider}</Text>
          </Box>
        </Box>
      )}

      {subStep === "sso-client-id" && (
        <Box flexDirection="column" marginY={1}>
          <Text bold>OAuth Client ID</Text>
          <Text color="gray" dimColor>
            The client/application ID from your identity provider
          </Text>
          <Box marginTop={1}>
            <TextInput
              value={ssoClientId}
              onChange={setSsoClientId}
              onSubmit={handleSsoClientIdSubmit}
              placeholder="your-client-id"
            />
          </Box>
          <Box marginTop={1} flexDirection="column">
            <Box>
              <Text color={colors.success}>✓</Text>
              <Text color="gray"> Provider: {ssoProvider}</Text>
            </Box>
            {ssoUrl && (
              <Box>
                <Text color={colors.success}>✓</Text>
                <Text color="gray"> URL: {ssoUrl}</Text>
              </Box>
            )}
          </Box>
        </Box>
      )}

      {subStep === "sso-client-secret" && (
        <Box flexDirection="column" marginY={1}>
          <Text bold>OAuth Client Secret</Text>
          <Text color="gray" dimColor>
            The client secret from your identity provider
          </Text>
          <Box marginTop={1}>
            <TextInput
              value={ssoClientSecret}
              onChange={setSsoClientSecret}
              onSubmit={handleSsoClientSecretSubmit}
              placeholder="your-client-secret"
              mask="*"
            />
          </Box>
          <Box marginTop={1} flexDirection="column">
            <Box>
              <Text color={colors.success}>✓</Text>
              <Text color="gray"> Provider: {ssoProvider}</Text>
            </Box>
            <Box>
              <Text color={colors.success}>✓</Text>
              <Text color="gray"> Client ID configured</Text>
            </Box>
          </Box>
        </Box>
      )}

      {/* Monitoring Configuration */}
      {subStep === "monitoring-remote-write-url" && (
        <Box flexDirection="column" marginY={1}>
          <Text bold>Remote Write URL</Text>
          <Text color="gray" dimColor>
            Prometheus remote_write endpoint URL
          </Text>
          {remoteWriteDestination === "azure-monitor" && (
            <Text color="gray" dimColor>
              Use the ingestion URL from your Azure Monitor workspace/Data
              Collection Rule.
            </Text>
          )}
          <Box marginTop={1}>
            <TextInput
              value={remoteWriteUrl}
              onChange={setRemoteWriteUrl}
              onSubmit={handleRemoteWriteUrlSubmit}
              placeholder="https://metrics.example.com/api/v1/write"
            />
          </Box>
          <ProgressSummary />
        </Box>
      )}

      {subStep === "monitoring-aws-region-loading" && (
        <Box flexDirection="column" marginY={1}>
          <Spinner label="Loading AWS regions..." />
        </Box>
      )}

      {subStep === "monitoring-aws-region" && (
        <Box flexDirection="column" marginY={1}>
          <Text bold>AWS Managed Prometheus Region</Text>
          <Text color="gray" dimColor>
            Region of your AMP workspace (defaults to your cluster region).
          </Text>
          <Box marginTop={1} height={10} flexDirection="column" overflowY="hidden">
            <SelectInput
              items={rwRegions.map((r) => ({ label: r, value: r }))}
              onSelect={handleAwsRegionSelect}
              limit={8}
              initialIndex={Math.max(0, rwRegions.indexOf(remoteWriteAwsRegion))}
              indicatorComponent={() => null}
              itemComponent={selectItem}
            />
          </Box>
          <ProgressSummary />
        </Box>
      )}

      {subStep === "monitoring-aws-workspace-loading" && (
        <Box flexDirection="column" marginY={1}>
          <Spinner label="Discovering AMP workspaces..." />
        </Box>
      )}

      {subStep === "monitoring-aws-workspace" && (
        <Box flexDirection="column" marginY={1}>
          <Text bold>Select AMP Workspace</Text>
          <Text color="gray" dimColor>
            Choose the workspace your Rulebricks role can write to. cluster-setup
            creates {`${state.clusterName || "<cluster>"}-amp`} and grants
            aps:RemoteWrite on it.
          </Text>
          {rwTargets.length === 0 && (
            <Box marginTop={1}>
              <Text color="yellow">
                None found in {remoteWriteAwsRegion}. Refresh after creating one,
                or enter a URL manually.
              </Text>
            </Box>
          )}
          {(() => {
            const recommendedPrefix = `${state.clusterName || ""}-amp`.toLowerCase();
            const isRec = (name: string) =>
              recommendedPrefix !== "-amp" &&
              name.toLowerCase().startsWith(recommendedPrefix);
            const sorted = [...rwTargets].sort((a, b) => {
              return (
                (isRec(a.name) ? 0 : 1) - (isRec(b.name) ? 0 : 1) ||
                a.name.localeCompare(b.name)
              );
            });
            return (
              <Box marginTop={1} height={10} flexDirection="column" overflowY="hidden">
                <SelectInput
                  items={[
                    ...sorted.map((t) => ({
                      label: isRec(t.name) ? `${t.name}  - recommended` : t.name,
                      value: t.url,
                    })),
                    { label: "↻ Refresh list", value: REFRESH },
                    { label: "Enter URL manually…", value: MANUAL },
                  ]}
                  onSelect={handleAwsWorkspaceSelect}
                  limit={8}
                  indicatorComponent={() => null}
                  itemComponent={selectItem}
                />
              </Box>
            );
          })()}
          <ProgressSummary />
        </Box>
      )}

      {subStep === "monitoring-azure-target-loading" && (
        <Box flexDirection="column" marginY={1}>
          <Spinner label="Discovering Azure Monitor data collection rules..." />
        </Box>
      )}

      {subStep === "monitoring-azure-target" && (
        <Box flexDirection="column" marginY={1}>
          <Text bold>Select Azure Monitor target</Text>
          <Text color="gray" dimColor>
            Choose the Data Collection Rule your Rulebricks identity can publish
            to. cluster-setup grants that on {`${state.clusterName || "<cluster>"}-dcr`};
            the workspace's auto-created {`${state.clusterName || "<cluster>"}-amw`} rule
            usually lacks the publish role.
          </Text>
          {rwTargets.length === 0 && (
            <Box marginTop={1}>
              <Text color="yellow">
                None found. Refresh after creating a Prometheus DCR/DCE, or enter
                a URL manually.
              </Text>
            </Box>
          )}
          {(() => {
            // Recommend the cluster-setup DCR (<cluster>-dcr) -- the one granted
            // Monitoring Metrics Publisher -- and list it first.
            const recommendedName = `${state.clusterName || ""}-dcr`.toLowerCase();
            const sorted = [...rwTargets].sort((a, b) => {
              const aRec = a.name.toLowerCase() === recommendedName ? 0 : 1;
              const bRec = b.name.toLowerCase() === recommendedName ? 0 : 1;
              return aRec - bRec || a.name.localeCompare(b.name);
            });
            return (
              <Box marginTop={1} height={10} flexDirection="column" overflowY="hidden">
                <SelectInput
                  items={[
                    ...sorted.map((t) => ({
                      label:
                        t.name.toLowerCase() === recommendedName
                          ? `${t.name}  - recommended`
                          : t.name,
                      value: t.url,
                    })),
                    { label: "↻ Refresh list", value: REFRESH },
                    { label: "Enter URL manually…", value: MANUAL },
                  ]}
                  onSelect={handleAzureTargetSelect}
                  limit={8}
                  indicatorComponent={() => null}
                  itemComponent={selectItem}
                />
              </Box>
            );
          })()}
          <ProgressSummary />
        </Box>
      )}

      {subStep === "monitoring-remote-write-destination" && (
        <Box flexDirection="column" marginY={1}>
          <Text bold>Metrics Export Destination</Text>
          <Text color="gray" dimColor>
            Select the backend to send Prometheus metrics to so required auth
            fields can be collected.
          </Text>
          <Box marginTop={1}>
            <SelectInput
              items={remoteWriteDestinations}
              onSelect={handleRemoteWriteDestinationSelect}
              indicatorComponent={() => null}
              itemComponent={selectItem}
            />
          </Box>
          <ProgressSummary />
        </Box>
      )}

      {subStep === "monitoring-remote-write-azure-auth" && (
        <Box flexDirection="column" marginY={1}>
          <Text bold>Azure Monitor Authentication</Text>
          <Text color="gray" dimColor>
            Azure Monitor managed Prometheus requires Azure AD authentication.
          </Text>
          <Text color="gray" dimColor>
            Cloud: {remoteWriteAzureCloud}
          </Text>
          <Box marginTop={1}>
            <SelectInput
              items={AZURE_REMOTE_WRITE_AUTH}
              onSelect={handleAzureRemoteWriteAuthSelect}
              indicatorComponent={() => null}
              itemComponent={selectItem}
            />
          </Box>
          <ProgressSummary />
        </Box>
      )}

      {subStep === "monitoring-remote-write-generic-auth" && (
        <Box flexDirection="column" marginY={1}>
          <Text bold>Generic Remote Write Authentication</Text>
          <Text color="gray" dimColor>
            Choose the auth method required by the remote_write endpoint.
          </Text>
          <Box marginTop={1}>
            <SelectInput
              items={GENERIC_REMOTE_WRITE_AUTH}
              onSelect={handleGenericRemoteWriteAuthSelect}
              indicatorComponent={() => null}
              itemComponent={selectItem}
            />
          </Box>
          <ProgressSummary />
        </Box>
      )}

      {subStep === "monitoring-azure-identity-loading" && (
        <Box flexDirection="column" marginY={1}>
          <Spinner label="Loading managed identities..." />
        </Box>
      )}

      {subStep === "monitoring-remote-write-client-id" && (
        <Box flexDirection="column" marginY={1}>
          <Text bold>Azure Identity</Text>
          <Text color="gray" dimColor>
            Select the managed/workload identity for remote_write, or enter a
            client ID manually.
          </Text>
          <Box marginTop={1} height={10} flexDirection="column" overflowY="hidden">
            <SelectInput
              items={[
                ...rwIdentities.map((i) => ({
                  label: `${i.name} (${i.clientId})`,
                  value: i.clientId,
                })),
                { label: "Enter manually…", value: MANUAL },
              ]}
              onSelect={handleRemoteWriteClientIdSelect}
              limit={8}
              initialIndex={Math.max(
                0,
                findClusterSetupDefaultIndex(
                  rwIdentities.map((i) => i.name),
                  "metrics-identity",
                  { provider: "azure", clusterName: state.clusterName },
                ),
              )}
              indicatorComponent={() => null}
              itemComponent={selectItem}
            />
          </Box>
          <ProgressSummary />
        </Box>
      )}

      {subStep === "monitoring-remote-write-client-id-manual" && (
        <Box flexDirection="column" marginY={1}>
          <Text bold>Azure Client ID</Text>
          <Text color="gray" dimColor>
            Use the managed identity, workload identity, or app registration
            client ID.
          </Text>
          <Box marginTop={1}>
            <TextInput
              value={remoteWriteClientId}
              onChange={setRemoteWriteClientId}
              onSubmit={handleRemoteWriteClientIdSubmit}
              placeholder="00000000-0000-0000-0000-000000000000"
            />
          </Box>
          <ProgressSummary />
        </Box>
      )}

      {subStep === "monitoring-remote-write-tenant-id" && (
        <Box flexDirection="column" marginY={1}>
          <Text bold>Azure Tenant ID</Text>
          <Text color="gray" dimColor>
            {rwTenantAutoDetected
              ? "Auto-detected from your Azure CLI session - edit if needed."
              : "Required for workload identity and OAuth client-secret auth."}
          </Text>
          <Box marginTop={1}>
            <TextInput
              value={remoteWriteTenantId}
              onChange={setRemoteWriteTenantId}
              onSubmit={handleRemoteWriteTenantIdSubmit}
              placeholder="00000000-0000-0000-0000-000000000000"
            />
          </Box>
          <ProgressSummary />
        </Box>
      )}

      {subStep === "monitoring-remote-write-secret-ref" && (
        <Box flexDirection="column" marginY={1}>
          <Text bold>Client Secret Reference</Text>
          <Text color="gray" dimColor>
            Existing Kubernetes Secret key in the format name:key.
          </Text>
          <Box marginTop={1}>
            <TextInput
              value={remoteWriteSecretRef}
              onChange={setRemoteWriteSecretRef}
              onSubmit={handleRemoteWriteSecretRefSubmit}
              placeholder="azure-monitor-oauth:client-secret"
            />
          </Box>
          <ProgressSummary />
        </Box>
      )}

      {subStep === "monitoring-remote-write-username-secret-ref" && (
        <Box flexDirection="column" marginY={1}>
          <Text bold>Basic Auth Username Reference</Text>
          <Text color="gray" dimColor>
            Existing Kubernetes Secret key in the format name:key. For Grafana
            Cloud, this is the instance ID.
          </Text>
          <Box marginTop={1}>
            <TextInput
              value={remoteWriteUsernameSecretRef}
              onChange={setRemoteWriteUsernameSecretRef}
              onSubmit={handleRemoteWriteUsernameSecretRefSubmit}
              placeholder="prometheus-remote-write:username"
            />
          </Box>
          <ProgressSummary />
        </Box>
      )}

      {subStep === "monitoring-remote-write-password-secret-ref" && (
        <Box flexDirection="column" marginY={1}>
          <Text bold>Basic Auth Password Reference</Text>
          <Text color="gray" dimColor>
            Existing Kubernetes Secret key in the format name:key. For Grafana
            Cloud, this is an API token.
          </Text>
          <Box marginTop={1}>
            <TextInput
              value={remoteWritePasswordSecretRef}
              onChange={setRemoteWritePasswordSecretRef}
              onSubmit={handleRemoteWritePasswordSecretRefSubmit}
              placeholder="prometheus-remote-write:password"
            />
          </Box>
          <ProgressSummary />
        </Box>
      )}

      {subStep === "monitoring-remote-write-bearer-secret-ref" && (
        <Box flexDirection="column" marginY={1}>
          <Text bold>Bearer Token Reference</Text>
          <Text color="gray" dimColor>
            Existing Kubernetes Secret key in the format name:key.
          </Text>
          <Box marginTop={1}>
            <TextInput
              value={remoteWriteBearerSecretRef}
              onChange={setRemoteWriteBearerSecretRef}
              onSubmit={handleRemoteWriteBearerSecretRefSubmit}
              placeholder="prometheus-remote-write:token"
            />
          </Box>
          <ProgressSummary />
        </Box>
      )}

      {/* Logging Configuration (external logging platforms) */}
      {subStep === "logging-sink" && (
        <Box flexDirection="column" marginY={1}>
          <Text bold>Additional Log Forwarding</Text>
          <Text color="gray" dimColor>
            Optional: forward a copy of logs to a third-party logging platform.
            Decision logs are always archived to your object storage (configured
            in the Object Storage step); this is an additional destination.
          </Text>
          <Box marginTop={1}>
            <SelectInput
              items={LOGGING_PLATFORM_SINKS}
              onSelect={handleLoggingSinkSelect}
              indicatorComponent={() => null}
              itemComponent={selectItem}
            />
          </Box>
          <ProgressSummary />
        </Box>
      )}

      {/* Datadog Configuration */}
      {subStep === "logging-datadog-config" && (
        <Box flexDirection="column" marginY={1}>
          <Text bold>Datadog Configuration</Text>
          <Text color="gray" dimColor>
            Configure Datadog Logs integration
          </Text>

          <Box marginTop={1} flexDirection="column">
            <Text>API Key:</Text>
            <Box>
              <TextInput
                value={datadogApiKey}
                onChange={setDatadogApiKey}
                placeholder="your-api-key"
                mask="*"
              />
            </Box>
          </Box>

          <Box marginTop={1} flexDirection="column">
            <Text>Datadog Site:</Text>
            <SelectInput
              items={DATADOG_SITES}
              initialIndex={DATADOG_SITES.findIndex(
                (s) => s.value === datadogSite,
              )}
              onSelect={(item) => setDatadogSite(item.value)}
              indicatorComponent={() => null}
              itemComponent={selectItem}
            />
          </Box>

          <Box marginTop={1}>
            <Text color="gray" dimColor>
              Press Enter after selecting site to continue
            </Text>
          </Box>

          <Box marginTop={1}>
            <Text
              color={datadogApiKey ? colors.accent : colors.muted}
              bold={!!datadogApiKey}
            >
              {datadogApiKey
                ? "→ Press Enter to continue"
                : "Enter API key to continue"}
            </Text>
          </Box>

          {datadogApiKey && (
            <Box marginTop={1}>
              <TextInput
                value=""
                onChange={() => {}}
                onSubmit={handleDatadogConfigSubmit}
                placeholder=""
              />
            </Box>
          )}
        </Box>
      )}

      {/* Splunk Configuration */}
      {subStep === "logging-splunk-config" && (
        <Box flexDirection="column" marginY={1}>
          <Text bold>Splunk HEC Configuration</Text>
          <Text color="gray" dimColor>
            Configure Splunk HTTP Event Collector
          </Text>

          <Box marginTop={1} flexDirection="column">
            <Text>HEC URL:</Text>
            <Box>
              <TextInput
                value={splunkUrl}
                onChange={setSplunkUrl}
                placeholder="https://splunk.example.com:8088"
              />
            </Box>
          </Box>

          <Box marginTop={1} flexDirection="column">
            <Text>HEC Token:</Text>
            <Box>
              <TextInput
                value={splunkHecToken}
                onChange={setSplunkHecToken}
                onSubmit={handleSplunkConfigSubmit}
                placeholder="your-hec-token"
                mask="*"
              />
            </Box>
          </Box>
        </Box>
      )}

      {/* Elasticsearch Configuration */}
      {subStep === "logging-elasticsearch-config" && (
        <Box flexDirection="column" marginY={1}>
          <Text bold>Elasticsearch Configuration</Text>
          <Text color="gray" dimColor>
            Configure Elasticsearch logging destination
          </Text>

          <Box marginTop={1} flexDirection="column">
            <Text>Elasticsearch URL:</Text>
            <Box>
              <TextInput
                value={elasticsearchUrl}
                onChange={setElasticsearchUrl}
                placeholder="https://elasticsearch.example.com:9200"
              />
            </Box>
          </Box>

          <Box marginTop={1} flexDirection="column">
            <Text>Username (optional):</Text>
            <Box>
              <TextInput
                value={elasticsearchUser}
                onChange={setElasticsearchUser}
                placeholder="elastic"
              />
            </Box>
          </Box>

          <Box marginTop={1} flexDirection="column">
            <Text>Password (optional):</Text>
            <Box>
              <TextInput
                value={elasticsearchPass}
                onChange={setElasticsearchPass}
                placeholder=""
                mask="*"
              />
            </Box>
          </Box>

          <Box marginTop={1} flexDirection="column">
            <Text>Index name:</Text>
            <Box>
              <TextInput
                value={elasticsearchIndex}
                onChange={setElasticsearchIndex}
                onSubmit={handleElasticsearchConfigSubmit}
                placeholder="rulebricks-logs"
              />
            </Box>
          </Box>
        </Box>
      )}

      {/* Loki Configuration */}
      {subStep === "logging-loki-config" && (
        <Box flexDirection="column" marginY={1}>
          <Text bold>Grafana Loki Configuration</Text>
          <Text color="gray" dimColor>
            Configure Loki logging destination
          </Text>

          <Box marginTop={1} flexDirection="column">
            <Text>Loki URL:</Text>
            <Text color="gray" dimColor>
              Include /loki/api/v1/push endpoint
            </Text>
            <Box>
              <TextInput
                value={lokiUrl}
                onChange={setLokiUrl}
                onSubmit={handleLokiConfigSubmit}
                placeholder="https://loki.example.com/loki/api/v1/push"
              />
            </Box>
          </Box>
        </Box>
      )}

      {/* New Relic Configuration */}
      {subStep === "logging-newrelic-config" && (
        <Box flexDirection="column" marginY={1}>
          <Text bold>New Relic Configuration</Text>
          <Text color="gray" dimColor>
            Configure New Relic Logs integration
          </Text>

          <Box marginTop={1} flexDirection="column">
            <Text>License Key:</Text>
            <Box>
              <TextInput
                value={newrelicLicenseKey}
                onChange={setNewrelicLicenseKey}
                placeholder="your-license-key"
                mask="*"
              />
            </Box>
          </Box>

          <Box marginTop={1} flexDirection="column">
            <Text>Account ID:</Text>
            <Box>
              <TextInput
                value={newrelicAccountId}
                onChange={setNewrelicAccountId}
                onSubmit={handleNewrelicConfigSubmit}
                placeholder="1234567"
              />
            </Box>
          </Box>
        </Box>
      )}

      {/* Axiom Configuration */}
      {subStep === "logging-axiom-config" && (
        <Box flexDirection="column" marginY={1}>
          <Text bold>Axiom Configuration</Text>
          <Text color="gray" dimColor>
            Configure Axiom logging destination
          </Text>

          <Box marginTop={1} flexDirection="column">
            <Text>API Token:</Text>
            <Box>
              <TextInput
                value={axiomApiToken}
                onChange={setAxiomApiToken}
                placeholder="xaat-..."
                mask="*"
              />
            </Box>
          </Box>

          <Box marginTop={1} flexDirection="column">
            <Text>Dataset:</Text>
            <Box>
              <TextInput
                value={axiomDataset}
                onChange={setAxiomDataset}
                onSubmit={handleAxiomConfigSubmit}
                placeholder="rulebricks"
              />
            </Box>
          </Box>
        </Box>
      )}

      {/* Custom Email Templates - Subject Lines */}
      {subStep === "email-subject-invite" && (
        <Box flexDirection="column" marginY={1}>
          <Text bold>Custom Email Templates</Text>
          <Text color="gray" dimColor>
            Customize Supabase auth email subjects and templates.
          </Text>
          <Box marginTop={1}>
            <Text color="gray" dimColor>
              First, let's customize the subject lines. Press Enter to use
              defaults.
            </Text>
          </Box>

          <Box marginTop={1} flexDirection="column">
            <Text>Invite Email Subject:</Text>
            <Text color="gray" dimColor>
              Default: "{DEFAULT_EMAIL_SUBJECTS.invite}"
            </Text>
            <Box>
              <TextInput
                value={emailSubjectInvite}
                onChange={setEmailSubjectInvite}
                onSubmit={handleEmailSubjectInviteSubmit}
                placeholder={DEFAULT_EMAIL_SUBJECTS.invite}
              />
            </Box>
          </Box>
        </Box>
      )}

      {subStep === "email-subject-confirm" && (
        <Box flexDirection="column" marginY={1}>
          <Text bold>Custom Email Templates - Subject Lines</Text>

          <Box marginTop={1} flexDirection="column">
            <Text>Confirmation Email Subject:</Text>
            <Text color="gray" dimColor>
              Default: "{DEFAULT_EMAIL_SUBJECTS.confirmation}"
            </Text>
            <Box>
              <TextInput
                value={emailSubjectConfirm}
                onChange={setEmailSubjectConfirm}
                onSubmit={handleEmailSubjectConfirmSubmit}
                placeholder={DEFAULT_EMAIL_SUBJECTS.confirmation}
              />
            </Box>
          </Box>

          <Box marginTop={1}>
            <Text color={colors.success}>✓</Text>
            <Text color="gray"> Invite: {emailSubjectInvite}</Text>
          </Box>
        </Box>
      )}

      {subStep === "email-subject-recovery" && (
        <Box flexDirection="column" marginY={1}>
          <Text bold>Custom Email Templates - Subject Lines</Text>

          <Box marginTop={1} flexDirection="column">
            <Text>Password Recovery Email Subject:</Text>
            <Text color="gray" dimColor>
              Default: "{DEFAULT_EMAIL_SUBJECTS.recovery}"
            </Text>
            <Box>
              <TextInput
                value={emailSubjectRecovery}
                onChange={setEmailSubjectRecovery}
                onSubmit={handleEmailSubjectRecoverySubmit}
                placeholder={DEFAULT_EMAIL_SUBJECTS.recovery}
              />
            </Box>
          </Box>

          <Box marginTop={1} flexDirection="column">
            <Box>
              <Text color={colors.success}>✓</Text>
              <Text color="gray"> Invite: {emailSubjectInvite}</Text>
            </Box>
            <Box>
              <Text color={colors.success}>✓</Text>
              <Text color="gray"> Confirmation: {emailSubjectConfirm}</Text>
            </Box>
          </Box>
        </Box>
      )}

      {subStep === "email-subject-change" && (
        <Box flexDirection="column" marginY={1}>
          <Text bold>Custom Email Templates - Subject Lines</Text>

          <Box marginTop={1} flexDirection="column">
            <Text>Email Change Subject:</Text>
            <Text color="gray" dimColor>
              Default: "{DEFAULT_EMAIL_SUBJECTS.emailChange}"
            </Text>
            <Box>
              <TextInput
                value={emailSubjectChange}
                onChange={setEmailSubjectChange}
                onSubmit={handleEmailSubjectChangeSubmit}
                placeholder={DEFAULT_EMAIL_SUBJECTS.emailChange}
              />
            </Box>
          </Box>

          <Box marginTop={1} flexDirection="column">
            <Box>
              <Text color={colors.success}>✓</Text>
              <Text color="gray"> Invite: {emailSubjectInvite}</Text>
            </Box>
            <Box>
              <Text color={colors.success}>✓</Text>
              <Text color="gray"> Confirmation: {emailSubjectConfirm}</Text>
            </Box>
            <Box>
              <Text color={colors.success}>✓</Text>
              <Text color="gray"> Recovery: {emailSubjectRecovery}</Text>
            </Box>
          </Box>
        </Box>
      )}

      {/* Custom Email Templates - Template URLs */}
      {subStep === "email-template-invite" && (
        <Box flexDirection="column" marginY={1}>
          <Text bold>Custom Email Templates - Template URLs</Text>
          <Text color="gray" dimColor>
            Provide URLs to your custom HTML email templates.
          </Text>
          <Text color="gray" dimColor>
            Templates must be publicly accessible (S3, GCS, or any HTTPS URL).
          </Text>

          <Box marginTop={1} flexDirection="column">
            <Text>Invite Template URL:</Text>
            <Box>
              <TextInput
                value={emailTemplateInvite}
                onChange={setEmailTemplateInvite}
                onSubmit={handleEmailTemplateInviteSubmit}
                placeholder="https://bucket.s3.amazonaws.com/templates/invite.html"
              />
            </Box>
          </Box>

          <Box marginTop={1}>
            <Text color={colors.success}>✓</Text>
            <Text color="gray"> All subject lines configured</Text>
          </Box>
        </Box>
      )}

      {subStep === "email-template-confirm" && (
        <Box flexDirection="column" marginY={1}>
          <Text bold>Custom Email Templates - Template URLs</Text>

          <Box marginTop={1} flexDirection="column">
            <Text>Confirmation Template URL:</Text>
            <Box>
              <TextInput
                value={emailTemplateConfirm}
                onChange={setEmailTemplateConfirm}
                onSubmit={handleEmailTemplateConfirmSubmit}
                placeholder="https://bucket.s3.amazonaws.com/templates/verify.html"
              />
            </Box>
          </Box>

          <Box marginTop={1}>
            <Text color={colors.success}>✓</Text>
            <Text color="gray"> Invite: {emailTemplateInvite}</Text>
          </Box>
        </Box>
      )}

      {subStep === "email-template-recovery" && (
        <Box flexDirection="column" marginY={1}>
          <Text bold>Custom Email Templates - Template URLs</Text>

          <Box marginTop={1} flexDirection="column">
            <Text>Recovery Template URL:</Text>
            <Box>
              <TextInput
                value={emailTemplateRecovery}
                onChange={setEmailTemplateRecovery}
                onSubmit={handleEmailTemplateRecoverySubmit}
                placeholder="https://bucket.s3.amazonaws.com/templates/password_change.html"
              />
            </Box>
          </Box>

          <Box marginTop={1} flexDirection="column">
            <Box>
              <Text color={colors.success}>✓</Text>
              <Text color="gray"> Invite: {emailTemplateInvite}</Text>
            </Box>
            <Box>
              <Text color={colors.success}>✓</Text>
              <Text color="gray"> Confirmation: {emailTemplateConfirm}</Text>
            </Box>
          </Box>
        </Box>
      )}

      {subStep === "email-template-change" && (
        <Box flexDirection="column" marginY={1}>
          <Text bold>Custom Email Templates - Template URLs</Text>

          <Box marginTop={1} flexDirection="column">
            <Text>Email Change Template URL:</Text>
            <Box>
              <TextInput
                value={emailTemplateChange}
                onChange={setEmailTemplateChange}
                onSubmit={handleEmailTemplateChangeSubmit}
                placeholder="https://bucket.s3.amazonaws.com/templates/email_change.html"
              />
            </Box>
          </Box>

          <Box marginTop={1} flexDirection="column">
            <Box>
              <Text color={colors.success}>✓</Text>
              <Text color="gray"> Invite: {emailTemplateInvite}</Text>
            </Box>
            <Box>
              <Text color={colors.success}>✓</Text>
              <Text color="gray"> Confirmation: {emailTemplateConfirm}</Text>
            </Box>
            <Box>
              <Text color={colors.success}>✓</Text>
              <Text color="gray"> Recovery: {emailTemplateRecovery}</Text>
            </Box>
          </Box>
        </Box>
      )}

      {/* Distributed Tracing - destination picker */}
      {subStep === "tracing-destination" && (
        <Box flexDirection="column" marginY={1}>
          <Text bold>Distributed Tracing - destination</Text>
          <Text color="gray" dimColor>
            Where the in-cluster OpenTelemetry Collector exports traces. Works on
            AWS and Azure.
          </Text>
          <Box marginTop={1}>
            <SelectInput
              items={[
                { label: "Elastic APM (Elastic Cloud / self-hosted)", value: "elastic" },
                { label: "Generic OTLP/HTTP (Tempo, Honeycomb, Jaeger, ...)", value: "otlp" },
                { label: "Azure Monitor / Application Insights", value: "azure-monitor" },
              ]}
              initialIndex={Math.max(
                0,
                ["elastic", "otlp", "azure-monitor"].indexOf(tracingDestination),
              )}
              onSelect={handleTracingDestinationSelect}
            />
          </Box>
        </Box>
      )}

      {/* Distributed Tracing - generic OTLP endpoint */}
      {subStep === "tracing-otlp-endpoint" && (
        <Box flexDirection="column" marginY={1}>
          <Text bold>Distributed Tracing - OTLP/HTTP endpoint</Text>
          <Text color="gray" dimColor>
            Full OTLP/HTTP traces endpoint of your backend (e.g. a Grafana Cloud
            OTLP gateway or Honeycomb).
          </Text>
          <Box marginTop={1}>
            <TextInput
              value={tracingOtlpEndpoint}
              onChange={setTracingOtlpEndpoint}
              onSubmit={handleTracingOtlpEndpointSubmit}
              placeholder="https://otlp-gateway.example.com/otlp"
            />
          </Box>
        </Box>
      )}

      {/* Distributed Tracing - generic OTLP auth mode */}
      {subStep === "tracing-otlp-auth" && (
        <Box flexDirection="column" marginY={1}>
          <Text bold>Distributed Tracing - OTLP authentication</Text>
          <Text color="gray" dimColor>
            How the collector authenticates to the OTLP endpoint. (For a custom
            header name, configure tracing in your config file.)
          </Text>
          <Box marginTop={1}>
            <SelectInput
              items={[
                { label: "None", value: "none" },
                { label: "Bearer token (Authorization: Bearer)", value: "bearer" },
                { label: "API key (Authorization: ApiKey)", value: "api-key" },
              ]}
              initialIndex={Math.max(
                0,
                ["none", "bearer", "api-key"].indexOf(tracingOtlpAuthMode),
              )}
              onSelect={handleTracingOtlpAuthSelect}
            />
          </Box>
        </Box>
      )}

      {/* Distributed Tracing - generic OTLP credential */}
      {subStep === "tracing-otlp-cred" && (
        <Box flexDirection="column" marginY={1}>
          <Text bold>Distributed Tracing - OTLP credential</Text>
          <Text color="gray" dimColor>
            Sent as Authorization:{" "}
            {tracingOtlpAuthMode === "api-key" ? "ApiKey" : "Bearer"} &lt;value&gt;.
          </Text>
          <Box marginTop={1}>
            <TextInput
              value={tracingOtlpToken}
              onChange={setTracingOtlpToken}
              onSubmit={handleTracingOtlpCredSubmit}
              placeholder="otlp-credential"
              mask="*"
            />
          </Box>
        </Box>
      )}

      {/* Distributed Tracing - Azure Monitor connection string */}
      {subStep === "tracing-azure-connection" && (
        <Box flexDirection="column" marginY={1}>
          <Text bold>Distributed Tracing - Azure Monitor connection string</Text>
          <Text color="gray" dimColor>
            Application Insights connection string (carries the ingestion
            endpoint + instrumentation key).
          </Text>
          <Box marginTop={1}>
            <TextInput
              value={tracingAzureConnectionString}
              onChange={setTracingAzureConnectionString}
              onSubmit={handleTracingAzureConnectionSubmit}
              placeholder="InstrumentationKey=...;IngestionEndpoint=https://..."
              mask="*"
            />
          </Box>
        </Box>
      )}

      {/* Distributed Tracing - Elastic APM endpoint */}
      {subStep === "tracing-endpoint" && (
        <Box flexDirection="column" marginY={1}>
          <Text bold>Distributed Tracing - Elastic APM endpoint</Text>
          <Text color="gray" dimColor>
            OTLP endpoint of your (customer-managed) Elastic APM. The in-cluster
            OpenTelemetry Collector forwards traces here.
          </Text>
          <Box marginTop={1}>
            <TextInput
              value={tracingEndpoint}
              onChange={setTracingEndpoint}
              onSubmit={handleTracingEndpointSubmit}
              placeholder="https://<deployment>.apm.<region>.cloud.es.io:443"
            />
          </Box>
        </Box>
      )}

      {subStep === "tracing-token" && (
        <Box flexDirection="column" marginY={1}>
          <Text bold>Distributed Tracing - Elastic APM secret token</Text>
          <Text color="gray" dimColor>
            Sent as Authorization: Bearer &lt;token&gt; to Elastic APM. (For API
            key auth, configure tracing in your config file instead.)
          </Text>
          <Box marginTop={1}>
            <TextInput
              value={tracingToken}
              onChange={setTracingToken}
              onSubmit={handleTracingTokenSubmit}
              placeholder="elastic-apm-secret-token"
              mask="*"
            />
          </Box>
        </Box>
      )}

      {/* Application Log Shipping - BYO Elasticsearch */}
      {subStep === "applogs-endpoint" && (
        <Box flexDirection="column" marginY={1}>
          <Text bold>Application Log Shipping - BYO Elasticsearch endpoint</Text>
          <Text color="gray" dimColor>
            Optional BYO sink via Vector. For AWS/Azure native log collection,
            enable the provider's cluster logging agent instead. Decision logs stay
            in object storage.
          </Text>
          <Box marginTop={1}>
            <TextInput
              value={appLogsEndpoint}
              onChange={setAppLogsEndpoint}
              onSubmit={handleAppLogsEndpointSubmit}
              placeholder="https://<host>.es.<region>.cloud.es.io:9243"
            />
          </Box>
        </Box>
      )}

      {subStep === "applogs-user" && (
        <Box flexDirection="column" marginY={1}>
          <Text bold>Application Log Shipping - Elasticsearch username</Text>
          <Box marginTop={1}>
            <TextInput
              value={appLogsUser}
              onChange={setAppLogsUser}
              onSubmit={handleAppLogsUserSubmit}
              placeholder="elastic"
            />
          </Box>
        </Box>
      )}

      {subStep === "applogs-pass" && (
        <Box flexDirection="column" marginY={1}>
          <Text bold>Application Log Shipping - Elasticsearch password</Text>
          <Box marginTop={1}>
            <TextInput
              value={appLogsPass}
              onChange={setAppLogsPass}
              onSubmit={handleAppLogsPassSubmit}
              placeholder="password"
              mask="*"
            />
          </Box>
        </Box>
      )}

      {subStep === "applogs-index" && (
        <Box flexDirection="column" marginY={1}>
          <Text bold>Application Log Shipping - index name</Text>
          <Text color="gray" dimColor>
            Elasticsearch index (data stream) for app logs.
          </Text>
          <Box marginTop={1}>
            <TextInput
              value={appLogsIndex}
              onChange={setAppLogsIndex}
              onSubmit={handleAppLogsIndexSubmit}
              placeholder="rulebricks-app-logs"
            />
          </Box>
        </Box>
      )}

      {/* Valkey Admin public ingress */}
      {subStep === "valkey-admin-username" && (
        <Box flexDirection="column" marginY={1}>
          <Text bold>Valkey Admin BasicAuth Username</Text>
          <Text color="gray" dimColor>
            This username protects https://valkey.{state.domain}.
          </Text>
          <Box marginTop={1}>
            <TextInput
              value={valkeyAdminUsername}
              onChange={setValkeyAdminUsername}
              onSubmit={handleValkeyAdminUsernameSubmit}
              placeholder="admin"
            />
          </Box>
        </Box>
      )}

      {subStep === "valkey-admin-password" && (
        <Box flexDirection="column" marginY={1}>
          <Text bold>Valkey Admin BasicAuth Password</Text>
          <Text color="gray" dimColor>
            Password for accessing the Valkey Admin console. Leave empty to
            generate a secure value. The CLI stores only an htpasswd bcrypt hash
            in generated Helm values.
          </Text>
          <Box marginTop={1}>
            <TextInput
              value={valkeyAdminPassword}
              onChange={setValkeyAdminPassword}
              onSubmit={handleValkeyAdminPasswordSubmit}
              placeholder="Leave empty to generate a secure value"
              mask="*"
            />
          </Box>
        </Box>
      )}

      {subStep === "valkey-admin-allowed-ips" && (
        <Box flexDirection="column" marginY={1}>
          <Text bold>Valkey Admin Allowed IPs</Text>
          <Text color="gray" dimColor>
            Optional comma-separated CIDR allowlist. Leave blank to allow any IP
            that can reach Traefik.
          </Text>
          <Box marginTop={1}>
            <TextInput
              value={valkeyAdminAllowedIPs}
              onChange={setValkeyAdminAllowedIPs}
              onSubmit={handleValkeyAdminAllowedIPsSubmit}
              placeholder="203.0.113.0/24, 198.51.100.10/32"
            />
          </Box>
        </Box>
      )}

      {error && (
        <Box marginTop={1}>
          <Text color="red">✗ {error}</Text>
        </Box>
      )}

      <Box marginTop={1}>
        <Text color="gray" dimColor>
          Esc to go back • Enter to continue
        </Text>
      </Box>
    </BorderBox>
  );
}
