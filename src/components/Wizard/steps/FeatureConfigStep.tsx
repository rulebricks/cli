import React, { useEffect, useState } from "react";
import { useWizard } from "../WizardContext.js";
import { useFieldFlow, FlowField } from "../fieldFlow.js";
import {
  BorderBox,
  CheckRows,
  DiscoveredSelect,
  FieldError,
  StepFooter,
  TextField,
  WizardSelect,
} from "../../common/index.js";
import {
  SSOProvider,
  LoggingSink,
  RemoteWriteAuthType,
  RemoteWriteDestination,
  TracingDestination,
  DEFAULT_EMAIL_SUBJECTS,
} from "../../../types/index.js";
import {
  listRegionsWithFallback,
  listAzureWorkloadIdentities,
  getAzureTenantId,
  listAzurePrometheusTargets,
  listAwsPrometheusWorkspaces,
} from "../../../lib/cloudCli.js";
import { generateHtpasswdLine } from "../../../lib/htpasswd.js";
import { generateSecureSecret } from "../../../lib/validation.js";
import { featureConfigFieldOrder } from "../../../lib/wizardFlow.js";

interface FeatureConfigStepProps {
  onComplete: () => void;
  onBack: () => void;
  // "back" resumes at the end of the configured sections instead of the top.
  entryDirection?: "forward" | "back";
}

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

const TRACING_DESTINATIONS = [
  { label: "Elastic APM (Elastic Cloud / self-hosted)", value: "elastic" },
  { label: "Generic OTLP/HTTP (Tempo, Honeycomb, Jaeger, ...)", value: "otlp" },
  { label: "Azure Monitor / Application Insights", value: "azure-monitor" },
];

function isValidUrl(value: string): boolean {
  try {
    new URL(value);
    return true;
  } catch {
    return false;
  }
}

export function FeatureConfigStep({
  onComplete,
  onBack,
  entryDirection,
}: FeatureConfigStepProps) {
  const { state, dispatch } = useWizard();
  const [error, setError] = useState<string | null>(null);

  // Metrics export (Prometheus remote_write) is opt-in via the Observability
  // step; in-cluster Prometheus is always installed and needs no configuration.
  const needsAI = state.aiEnabled;
  const needsSSO = state.ssoEnabled;
  const needsMonitoring = !state.clickStackEnabled && state.metricsExportEnabled;
  const needsLogging = state.loggingSink !== "console";
  const needsTracing = !state.clickStackEnabled && state.tracingEnabled;
  const needsAppLogs = !state.clickStackEnabled && state.appLogsEnabled;
  const needsValkeyAdmin = state.valkeyAdminEnabled;
  const needsCustomEmails = state.customEmailsEnabled;
  const needsAnything =
    needsAI ||
    needsSSO ||
    needsMonitoring ||
    needsLogging ||
    needsTracing ||
    needsAppLogs ||
    needsValkeyAdmin ||
    needsCustomEmails;

  // AI / SSO
  const [openaiKey, setOpenaiKey] = useState(state.openaiApiKey || "");
  const [ssoProvider, setSsoProvider] = useState<SSOProvider | null>(
    state.ssoProvider,
  );
  const [ssoUrl, setSsoUrl] = useState(state.ssoUrl || "");
  const [ssoClientId, setSsoClientId] = useState(state.ssoClientId || "");
  const [ssoClientSecret, setSsoClientSecret] = useState(
    state.ssoClientSecret || "",
  );

  // Monitoring (Prometheus remote_write)
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
  const [awsRegionManual, setAwsRegionManual] = useState(false);
  const [rwManualUrl, setRwManualUrl] = useState(false);
  const [remoteWriteAzureCloud] = useState<
    "AzurePublic" | "AzureChina" | "AzureGovernment"
  >(state.prometheusRemoteWriteAzureCloud || "AzurePublic");
  const [remoteWriteClientId, setRemoteWriteClientId] = useState(
    state.prometheusRemoteWriteClientId || "",
  );
  const [clientIdManual, setClientIdManual] = useState(false);
  const [remoteWriteTenantId, setRemoteWriteTenantId] = useState(
    state.prometheusRemoteWriteTenantId || "",
  );
  const [rwTenantAutoDetected, setRwTenantAutoDetected] = useState(false);
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

  // Logging platforms
  const [loggingSink, setLoggingSink] = useState<LoggingSink>(
    state.loggingSink,
  );
  const [datadogApiKey, setDatadogApiKey] = useState("");
  const [datadogSite, setDatadogSite] = useState("datadoghq.com");
  const [splunkUrl, setSplunkUrl] = useState("");
  const [splunkHecToken, setSplunkHecToken] = useState("");
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

  // Distributed tracing
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

  // Application log shipping (BYO Elasticsearch)
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

  // Valkey Admin ingress
  const [defaultValkeyAdminPassword] = useState(() => generateSecureSecret(16));
  const [valkeyAdminUsername, setValkeyAdminUsername] = useState(() => {
    const existingUser = state.valkeyAdminBasicAuthUsers[0];
    return existingUser?.split(":")[0] || "admin";
  });
  const [valkeyAdminPassword, setValkeyAdminPassword] = useState("");
  const [valkeyAdminAllowedIPs, setValkeyAdminAllowedIPs] = useState(
    state.valkeyAdminAllowedIPs.join(", "),
  );

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

  // The step is excluded from the wizard when no section needs configuration;
  // this guard covers direct mounts with stale state.
  useEffect(() => {
    if (!needsAnything) onComplete();
  }, []);

  // Only offer managed-Prometheus destinations for the cluster's own cloud;
  // Grafana Cloud and generic remote_write stay available everywhere.
  const remoteWriteDestinations = REMOTE_WRITE_DESTINATIONS.filter((d) => {
    if (d.value === "aws-amp") return state.provider === "aws";
    if (d.value === "azure-monitor") return state.provider === "azure";
    return true;
  });

  // Azure Monitor tracing needs an Application Insights resource, so it is
  // only offered on Azure clusters.
  const tracingDestinations = TRACING_DESTINATIONS.filter(
    (d) => d.value !== "azure-monitor" || state.provider === "azure",
  );

  const saveRemoteWriteConfig = (
    authType: RemoteWriteAuthType,
    overrides: Partial<{
      url: string;
      awsRegion: string;
      clientId: string;
      tenantId: string;
      secretRef: string;
      usernameSecretRef: string;
      passwordSecretRef: string;
      bearerTokenSecretRef: string;
    }> = {},
  ) => {
    dispatch({
      type: "SET_PROMETHEUS_REMOTE_WRITE",
      url: overrides.url ?? remoteWriteUrl,
    });
    dispatch({
      type: "SET_PROMETHEUS_REMOTE_WRITE_CONFIG",
      config: {
        prometheusRemoteWriteDestination: remoteWriteDestination,
        prometheusMonitoringDestination: remoteWriteDestination,
        prometheusRemoteWriteAuthType: authType,
        prometheusRemoteWriteAzureCloud: remoteWriteAzureCloud,
        prometheusRemoteWriteAwsRegion:
          remoteWriteDestination === "aws-amp"
            ? (overrides.awsRegion ?? remoteWriteAwsRegion)
            : "",
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
  };

  const monitoringChecks = () => {
    const rows = [];
    if (state.openaiApiKey) rows.push({ label: "OpenAI API key configured" });
    if (state.ssoProvider) {
      rows.push({ label: "SSO", value: state.ssoProvider });
    }
    if (state.prometheusRemoteWriteUrl) {
      rows.push({ label: "Metrics remote write configured" });
    }
    return rows;
  };

  // Field visibility comes from the shared pure sequence definition, so the
  // component, the tests, and back-navigation always agree on the path.
  const fieldOrder = new Set(
    featureConfigFieldOrder({
      needs: {
        ai: needsAI,
        sso: needsSSO,
        monitoring: needsMonitoring,
        logging: needsLogging,
        tracing: needsTracing,
        appLogs: needsAppLogs,
        valkeyAdmin: needsValkeyAdmin,
        customEmails: needsCustomEmails,
      },
      ssoProvider,
      remoteWriteDestination,
      remoteWriteAuthType,
      manualRemoteWriteUrl: rwManualUrl,
      manualAwsRegion: awsRegionManual,
      manualClientId: clientIdManual,
      loggingSink,
      tracingDestination,
      tracingOtlpAuthMode,
    }),
  );

  const fieldDefs: FlowField[] = [
    // ----- AI -----
    {
      id: "openai-key",
      render: (flow) => (
        <TextField
          label="OpenAI API Key"
          hint="Required for AI-powered rule generation. Get a key at https://platform.openai.com/api-keys"
          value={openaiKey}
          onChange={setOpenaiKey}
          placeholder="sk-..."
          mask
          onSubmit={() => {
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
            flow.next();
          }}
        />
      ),
    },

    // ----- SSO -----
    {
      id: "sso-provider",
      render: (flow) => (
        <WizardSelect
          label="SSO Provider"
          hint="Select your identity provider"
          items={SSO_PROVIDERS}
          initialValue={ssoProvider ?? undefined}
          onSelect={(value) => {
            const provider = value as SSOProvider;
            setSsoProvider(provider);
            dispatch({
              type: "SET_SSO_CONFIG",
              config: { ssoProvider: provider },
            });
            flow.next();
          }}
        />
      ),
    },
    {
      id: "sso-url",
      render: (flow) => (
        <TextField
          label={`${(ssoProvider ?? "OIDC").toUpperCase()} Provider URL`}
          hint={
            ssoProvider === "azure"
              ? "e.g., https://login.microsoftonline.com/your-tenant-id"
              : ssoProvider === "okta"
                ? "e.g., https://your-org.okta.com"
                : ssoProvider === "keycloak"
                  ? "e.g., https://keycloak.example.com/realms/your-realm"
                  : ssoProvider === "ory"
                    ? "e.g., https://your-project.projects.oryapis.com"
                    : "The base URL of your OIDC provider"
          }
          value={ssoUrl}
          onChange={setSsoUrl}
          placeholder="https://..."
          onSubmit={() => {
            if (!ssoUrl) {
              setError("SSO provider URL is required");
              return;
            }
            if (!isValidUrl(ssoUrl)) {
              setError("Invalid URL format");
              return;
            }
            setError(null);
            dispatch({ type: "SET_SSO_CONFIG", config: { ssoUrl } });
            flow.next();
          }}
        />
      ),
    },
    {
      id: "sso-client-id",
      render: (flow) => (
        <TextField
          label="OAuth Client ID"
          hint="The client/application ID from your identity provider"
          value={ssoClientId}
          onChange={setSsoClientId}
          placeholder="your-client-id"
          onSubmit={() => {
            if (!ssoClientId) {
              setError("Client ID is required");
              return;
            }
            setError(null);
            dispatch({ type: "SET_SSO_CONFIG", config: { ssoClientId } });
            flow.next();
          }}
        />
      ),
    },
    {
      id: "sso-client-secret",
      render: (flow) => (
        <TextField
          label="OAuth Client Secret"
          hint="The client secret from your identity provider"
          value={ssoClientSecret}
          onChange={setSsoClientSecret}
          placeholder="your-client-secret"
          mask
          onSubmit={() => {
            if (!ssoClientSecret) {
              setError("Client secret is required");
              return;
            }
            setError(null);
            dispatch({
              type: "SET_SSO_CONFIG",
              config: { ssoProvider, ssoUrl, ssoClientId, ssoClientSecret },
            });
            flow.next();
          }}
        />
      ),
    },

    // ----- Monitoring (metrics export) -----
    {
      id: "monitoring-destination",
      render: (flow) => (
        <WizardSelect
          label="Metrics Export Destination"
          hint="Select the backend to send Prometheus metrics to so required auth fields can be collected."
          items={remoteWriteDestinations}
          initialValue={remoteWriteDestination ?? undefined}
          onSelect={(value) => {
            const destination = value as RemoteWriteDestination;
            setRemoteWriteDestination(destination);
            setRwManualUrl(false);
            dispatch({
              type: "SET_PROMETHEUS_REMOTE_WRITE_CONFIG",
              config: {
                prometheusMonitoringDestination: destination,
                prometheusRemoteWriteDestination: destination,
              },
            });
            setError(null);
            flow.next();
          }}
        />
      ),
    },
    {
      id: "monitoring-aws-region",
      render: (flow) => (
        <DiscoveredSelect
          label="AWS Managed Prometheus Region"
          hint="Region of your AMP workspace (defaults to your cluster region)."
          loadingLabel="Loading AWS regions..."
          emptyHint="No regions listed. Press R to refresh or enter one manually."
          load={async () =>
            (await listRegionsWithFallback("aws")).map((region) => ({
              label: region,
              value: region,
            }))
          }
          initialValue={remoteWriteAwsRegion}
          onSelect={(value) => {
            setRemoteWriteAwsRegion(value);
            flow.next();
          }}
          onManual={() => {
            setAwsRegionManual(true);
            flow.next();
          }}
        />
      ),
    },
    {
      id: "monitoring-aws-region-manual",
      onEscape: () => setAwsRegionManual(false),
      render: (flow) => (
        <TextField
          label="AWS Managed Prometheus Region"
          value={remoteWriteAwsRegion}
          onChange={setRemoteWriteAwsRegion}
          placeholder="us-east-1"
          onSubmit={() => {
            if (!remoteWriteAwsRegion.trim()) {
              setError("Region is required");
              return;
            }
            setError(null);
            flow.next();
          }}
        />
      ),
    },
    {
      id: "monitoring-aws-workspace",
      render: (flow) => (
        <DiscoveredSelect
          label="Select AMP Workspace"
          hint={`Choose the workspace your Rulebricks role can write to. cluster-setup creates ${state.clusterName || "<cluster>"}-amp and grants aps:RemoteWrite on it.`}
          loadingLabel="Discovering AMP workspaces..."
          emptyHint={`None found in ${remoteWriteAwsRegion}. Refresh after creating one, or enter a URL manually.`}
          load={async () =>
            (await listAwsPrometheusWorkspaces(remoteWriteAwsRegion)).map(
              (target) => ({ label: target.name, value: target.url }),
            )
          }
          recommendIndex={(items) => {
            const prefix = `${state.clusterName || ""}-amp`.toLowerCase();
            if (prefix === "-amp") return -1;
            return items.findIndex((item) =>
              item.label.toLowerCase().startsWith(prefix),
            );
          }}
          initialValue={remoteWriteUrl || undefined}
          onSelect={(value) => {
            setRemoteWriteUrl(value);
            setError(null);
            saveRemoteWriteConfig("none", { url: value });
            flow.next();
          }}
          onManual={() => {
            setRwManualUrl(true);
            flow.next();
          }}
        />
      ),
    },
    {
      id: "monitoring-azure-target",
      render: (flow) => (
        <DiscoveredSelect
          label="Select Azure Monitor target"
          hint={`Choose the Data Collection Rule your Rulebricks identity can publish to. cluster-setup grants that on ${state.clusterName || "<cluster>"}-dcr.`}
          loadingLabel="Discovering Azure Monitor data collection rules..."
          emptyHint="None found. Refresh after creating a Prometheus DCR/DCE, or enter a URL manually."
          load={async () =>
            (await listAzurePrometheusTargets()).map((target) => ({
              label: target.name,
              value: target.url,
            }))
          }
          recommendIndex={(items) => {
            const recommended = `${state.clusterName || ""}-dcr`.toLowerCase();
            if (recommended === "-dcr") return -1;
            return items.findIndex(
              (item) => item.label.toLowerCase() === recommended,
            );
          }}
          initialValue={remoteWriteUrl || undefined}
          onSelect={(value) => {
            setRemoteWriteUrl(value);
            dispatch({ type: "SET_PROMETHEUS_REMOTE_WRITE", url: value });
            setError(null);
            flow.next();
          }}
          onManual={() => {
            setRwManualUrl(true);
            flow.next();
          }}
        />
      ),
    },
    {
      id: "monitoring-url",
      onEscape: () => setRwManualUrl(false),
      render: (flow) => (
        <TextField
          label="Remote Write URL"
          hint={
            remoteWriteDestination === "azure-monitor"
              ? "Use the full ingestion URL from your Azure Monitor Data Collection Rule."
              : "Prometheus remote_write endpoint URL"
          }
          value={remoteWriteUrl}
          onChange={setRemoteWriteUrl}
          placeholder="https://metrics.example.com/api/v1/write"
          onSubmit={() => {
            if (!remoteWriteUrl) {
              setError(
                "Remote write URL is required. If you don't have a destination yet, go back and disable Metrics Export.",
              );
              return;
            }
            if (!isValidUrl(remoteWriteUrl)) {
              setError("Invalid URL format");
              return;
            }
            // Azure Monitor needs the full DCE metrics-ingestion path, not the
            // bare DCE host.
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
            dispatch({
              type: "SET_PROMETHEUS_REMOTE_WRITE",
              url: remoteWriteUrl,
            });
            if (remoteWriteDestination === "aws-amp") {
              saveRemoteWriteConfig("none");
            } else if (remoteWriteDestination === "grafana-cloud") {
              setRemoteWriteAuthType("basic");
              dispatch({
                type: "SET_PROMETHEUS_REMOTE_WRITE_CONFIG",
                config: { prometheusRemoteWriteAuthType: "basic" },
              });
            }
            flow.next();
          }}
        />
      ),
    },
    {
      id: "monitoring-azure-auth",
      render: (flow) => (
        <WizardSelect
          label="Azure Monitor Authentication"
          hint={`Azure Monitor managed Prometheus requires Azure AD authentication. Cloud: ${remoteWriteAzureCloud}`}
          items={AZURE_REMOTE_WRITE_AUTH}
          initialValue={remoteWriteAuthType ?? undefined}
          onSelect={(value) => {
            const authType = value as RemoteWriteAuthType;
            setRemoteWriteAuthType(authType);
            dispatch({
              type: "SET_PROMETHEUS_REMOTE_WRITE_CONFIG",
              config: { prometheusRemoteWriteAuthType: authType },
            });
            // Workload/managed identity reuse the single Rulebricks identity
            // chosen in the Storage step; only OAuth needs its own credentials.
            if (authType !== "oauth") {
              saveRemoteWriteConfig(authType);
            }
            setError(null);
            flow.next();
          }}
        />
      ),
    },
    {
      id: "monitoring-azure-client-id",
      render: (flow) => (
        <DiscoveredSelect
          label="Azure Identity"
          hint="Select the identity used for remote_write, or enter a client ID manually."
          loadingLabel="Loading managed identities..."
          emptyHint="None found. Press R to refresh or enter a client ID manually."
          load={async () => {
            const [identities, tenant] = await Promise.all([
              listAzureWorkloadIdentities(state.clusterName),
              remoteWriteTenantId
                ? Promise.resolve<string | null>(null)
                : getAzureTenantId(),
            ]);
            if (tenant) {
              setRemoteWriteTenantId(tenant);
              setRwTenantAutoDetected(true);
            }
            return identities.map((identity) => ({
              label: `${identity.name} (${identity.clientId})`,
              value: identity.clientId,
            }));
          }}
          initialValue={remoteWriteClientId || undefined}
          onSelect={(value) => {
            setRemoteWriteClientId(value);
            setError(null);
            flow.next();
          }}
          onManual={() => {
            setClientIdManual(true);
            flow.next();
          }}
        />
      ),
    },
    {
      id: "monitoring-azure-client-id-manual",
      onEscape: () => setClientIdManual(false),
      render: (flow) => (
        <TextField
          label="Azure Client ID"
          value={remoteWriteClientId}
          onChange={setRemoteWriteClientId}
          placeholder="00000000-0000-0000-0000-000000000000"
          onSubmit={() => {
            if (!remoteWriteClientId) {
              setError("Client ID is required");
              return;
            }
            setError(null);
            flow.next();
          }}
        />
      ),
    },
    {
      id: "monitoring-tenant-id",
      render: (flow) => (
        <TextField
          label="Azure Tenant ID"
          hint={
            rwTenantAutoDetected
              ? "Auto-detected from your Azure CLI session - edit if needed."
              : "Tenant ID of the app registration."
          }
          value={remoteWriteTenantId}
          onChange={setRemoteWriteTenantId}
          placeholder="00000000-0000-0000-0000-000000000000"
          onSubmit={() => {
            if (!remoteWriteTenantId) {
              setError("Tenant ID is required");
              return;
            }
            setError(null);
            flow.next();
          }}
        />
      ),
    },
    {
      id: "monitoring-client-secret-ref",
      render: (flow) => (
        <TextField
          label="Client Secret Reference"
          hint="Existing Kubernetes Secret key in the format name:key."
          value={remoteWriteSecretRef}
          onChange={setRemoteWriteSecretRef}
          placeholder="azure-monitor-oauth:client-secret"
          onSubmit={() => {
            if (!remoteWriteSecretRef.includes(":")) {
              setError("Use secret-name:key format");
              return;
            }
            setError(null);
            saveRemoteWriteConfig("oauth");
            flow.next();
          }}
        />
      ),
    },
    {
      id: "monitoring-generic-auth",
      render: (flow) => (
        <WizardSelect
          label="Generic Remote Write Authentication"
          hint="Choose the auth method required by the remote_write endpoint."
          items={GENERIC_REMOTE_WRITE_AUTH}
          initialValue={remoteWriteAuthType ?? undefined}
          onSelect={(value) => {
            const authType = value as RemoteWriteAuthType;
            setRemoteWriteAuthType(authType);
            if (authType === "none") {
              saveRemoteWriteConfig("none");
            }
            setError(null);
            flow.next();
          }}
        />
      ),
    },
    {
      id: "monitoring-username-secret-ref",
      render: (flow) => (
        <TextField
          label="Basic Auth Username Reference"
          hint="Existing Kubernetes Secret key in the format name:key. For Grafana Cloud, this is the instance ID."
          value={remoteWriteUsernameSecretRef}
          onChange={setRemoteWriteUsernameSecretRef}
          placeholder="prometheus-remote-write:username"
          onSubmit={() => {
            if (!remoteWriteUsernameSecretRef.includes(":")) {
              setError("Use secret-name:key format");
              return;
            }
            setError(null);
            flow.next();
          }}
        />
      ),
    },
    {
      id: "monitoring-password-secret-ref",
      render: (flow) => (
        <TextField
          label="Basic Auth Password Reference"
          hint="Existing Kubernetes Secret key in the format name:key. For Grafana Cloud, this is an API token."
          value={remoteWritePasswordSecretRef}
          onChange={setRemoteWritePasswordSecretRef}
          placeholder="prometheus-remote-write:password"
          onSubmit={() => {
            if (!remoteWritePasswordSecretRef.includes(":")) {
              setError("Use secret-name:key format");
              return;
            }
            setError(null);
            saveRemoteWriteConfig("basic");
            flow.next();
          }}
        />
      ),
    },
    {
      id: "monitoring-bearer-secret-ref",
      render: (flow) => (
        <TextField
          label="Bearer Token Reference"
          hint="Existing Kubernetes Secret key in the format name:key."
          value={remoteWriteBearerSecretRef}
          onChange={setRemoteWriteBearerSecretRef}
          placeholder="prometheus-remote-write:token"
          onSubmit={() => {
            if (!remoteWriteBearerSecretRef.includes(":")) {
              setError("Use secret-name:key format");
              return;
            }
            setError(null);
            saveRemoteWriteConfig("bearer");
            flow.next();
          }}
        />
      ),
    },

    // ----- Logging (external platforms; config-file/configure only) -----
    {
      id: "logging-sink",
      render: (flow) => (
        <WizardSelect
          label="Additional Log Forwarding"
          hint="Forward a copy of logs to a third-party logging platform. Decision logs are always archived to your object storage."
          items={LOGGING_PLATFORM_SINKS}
          initialValue={loggingSink}
          onSelect={(value) => {
            const sink = value as LoggingSink;
            setLoggingSink(sink);
            dispatch({ type: "SET_LOGGING_SINK", sink });
            flow.next();
          }}
        />
      ),
    },
    {
      id: "logging-datadog-key",
      render: (flow) => (
        <TextField
          label="Datadog API Key"
          value={datadogApiKey}
          onChange={setDatadogApiKey}
          placeholder="your-api-key"
          mask
          onSubmit={() => {
            if (!datadogApiKey) {
              setError("Datadog API key is required");
              return;
            }
            setError(null);
            flow.next();
          }}
        />
      ),
    },
    {
      id: "logging-datadog-site",
      render: (flow) => (
        <WizardSelect
          label="Datadog Site"
          items={DATADOG_SITES}
          initialValue={datadogSite}
          onSelect={(value) => {
            setDatadogSite(value);
            dispatch({
              type: "SET_LOGGING_CONFIG",
              config: {
                loggingPlatformCredential: datadogApiKey,
                loggingPlatformDetail: value,
              },
            });
            flow.next();
          }}
        />
      ),
    },
    {
      id: "logging-splunk-url",
      render: (flow) => (
        <TextField
          label="Splunk HEC URL"
          value={splunkUrl}
          onChange={setSplunkUrl}
          placeholder="https://splunk.example.com:8088"
          onSubmit={() => {
            if (!splunkUrl || !isValidUrl(splunkUrl)) {
              setError("A valid Splunk HEC URL is required");
              return;
            }
            setError(null);
            flow.next();
          }}
        />
      ),
    },
    {
      id: "logging-splunk-token",
      render: (flow) => (
        <TextField
          label="Splunk HEC Token"
          value={splunkHecToken}
          onChange={setSplunkHecToken}
          placeholder="your-hec-token"
          mask
          onSubmit={() => {
            if (!splunkHecToken) {
              setError("Splunk HEC token is required");
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
            flow.next();
          }}
        />
      ),
    },
    {
      id: "logging-es-url",
      render: (flow) => (
        <TextField
          label="Elasticsearch URL"
          value={elasticsearchUrl}
          onChange={setElasticsearchUrl}
          placeholder="https://elasticsearch.example.com:9200"
          onSubmit={() => {
            if (!elasticsearchUrl || !isValidUrl(elasticsearchUrl)) {
              setError("A valid Elasticsearch URL is required");
              return;
            }
            setError(null);
            flow.next();
          }}
        />
      ),
    },
    {
      id: "logging-es-user",
      render: (flow) => (
        <TextField
          label="Elasticsearch Username"
          hint="Optional; leave blank for no auth."
          value={elasticsearchUser}
          onChange={setElasticsearchUser}
          placeholder="elastic"
          onSubmit={() => flow.next()}
        />
      ),
    },
    {
      id: "logging-es-pass",
      render: (flow) => (
        <TextField
          label="Elasticsearch Password"
          hint="Optional; leave blank for no auth."
          value={elasticsearchPass}
          onChange={setElasticsearchPass}
          mask
          onSubmit={() => flow.next()}
        />
      ),
    },
    {
      id: "logging-es-index",
      render: (flow) => (
        <TextField
          label="Elasticsearch Index"
          value={elasticsearchIndex}
          onChange={setElasticsearchIndex}
          placeholder="rulebricks-logs"
          onSubmit={() => {
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
            setError(null);
            flow.next();
          }}
        />
      ),
    },
    {
      id: "logging-loki-url",
      render: (flow) => (
        <TextField
          label="Grafana Loki URL"
          hint="Include the /loki/api/v1/push endpoint."
          value={lokiUrl}
          onChange={setLokiUrl}
          placeholder="https://loki.example.com/loki/api/v1/push"
          onSubmit={() => {
            if (!lokiUrl || !isValidUrl(lokiUrl)) {
              setError("A valid Loki URL is required");
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
            flow.next();
          }}
        />
      ),
    },
    {
      id: "logging-newrelic-key",
      render: (flow) => (
        <TextField
          label="New Relic License Key"
          value={newrelicLicenseKey}
          onChange={setNewrelicLicenseKey}
          placeholder="your-license-key"
          mask
          onSubmit={() => {
            if (!newrelicLicenseKey) {
              setError("New Relic License Key is required");
              return;
            }
            setError(null);
            flow.next();
          }}
        />
      ),
    },
    {
      id: "logging-newrelic-account",
      render: (flow) => (
        <TextField
          label="New Relic Account ID"
          value={newrelicAccountId}
          onChange={setNewrelicAccountId}
          placeholder="1234567"
          onSubmit={() => {
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
            flow.next();
          }}
        />
      ),
    },
    {
      id: "logging-axiom-token",
      render: (flow) => (
        <TextField
          label="Axiom API Token"
          value={axiomApiToken}
          onChange={setAxiomApiToken}
          placeholder="xaat-..."
          mask
          onSubmit={() => {
            if (!axiomApiToken) {
              setError("Axiom API token is required");
              return;
            }
            setError(null);
            flow.next();
          }}
        />
      ),
    },
    {
      id: "logging-axiom-dataset",
      render: (flow) => (
        <TextField
          label="Axiom Dataset"
          value={axiomDataset}
          onChange={setAxiomDataset}
          placeholder="rulebricks"
          onSubmit={() => {
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
            flow.next();
          }}
        />
      ),
    },

    // ----- Distributed tracing -----
    {
      id: "tracing-destination",
      render: (flow) => (
        <WizardSelect
          label="Distributed Tracing - destination"
          hint="Where the in-cluster OpenTelemetry Collector exports traces."
          items={tracingDestinations}
          initialValue={tracingDestination}
          onSelect={(value) => {
            const destination = value as TracingDestination;
            setTracingDestination(destination);
            dispatch({
              type: "SET_TRACING_CONFIG",
              config: { tracingDestination: destination },
            });
            setError(null);
            flow.next();
          }}
        />
      ),
    },
    {
      id: "tracing-endpoint",
      render: (flow) => (
        <TextField
          label="Distributed Tracing - Elastic APM endpoint"
          hint="OTLP endpoint of your (customer-managed) Elastic APM."
          value={tracingEndpoint}
          onChange={setTracingEndpoint}
          placeholder="https://<deployment>.apm.<region>.cloud.es.io:443"
          onSubmit={() => {
            if (!tracingEndpoint || !isValidUrl(tracingEndpoint)) {
              setError("A valid Elastic APM OTLP endpoint is required");
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
            flow.next();
          }}
        />
      ),
    },
    {
      id: "tracing-token",
      render: (flow) => (
        <TextField
          label="Distributed Tracing - Elastic APM secret token"
          hint="Sent as Authorization: Bearer <token>. (For API key auth, configure tracing in your config file instead.)"
          value={tracingToken}
          onChange={setTracingToken}
          placeholder="elastic-apm-secret-token"
          mask
          onSubmit={() => {
            if (!tracingToken) {
              setError("Elastic APM secret token is required");
              return;
            }
            setError(null);
            dispatch({
              type: "SET_TRACING_CONFIG",
              config: { tracingElasticSecretToken: tracingToken },
            });
            flow.next();
          }}
        />
      ),
    },
    {
      id: "tracing-otlp-endpoint",
      render: (flow) => (
        <TextField
          label="Distributed Tracing - OTLP/HTTP endpoint"
          hint="Full OTLP/HTTP traces endpoint of your backend."
          value={tracingOtlpEndpoint}
          onChange={setTracingOtlpEndpoint}
          placeholder="https://otlp-gateway.example.com/otlp"
          onSubmit={() => {
            if (!tracingOtlpEndpoint || !isValidUrl(tracingOtlpEndpoint)) {
              setError("A valid OTLP endpoint is required");
              return;
            }
            setError(null);
            dispatch({
              type: "SET_TRACING_CONFIG",
              config: { tracingOtlpEndpoint },
            });
            flow.next();
          }}
        />
      ),
    },
    {
      id: "tracing-otlp-auth",
      render: (flow) => (
        <WizardSelect
          label="Distributed Tracing - OTLP authentication"
          hint="How the collector authenticates to the OTLP endpoint. (For a custom header name, configure tracing in your config file.)"
          items={[
            { label: "None", value: "none" },
            { label: "Bearer token (Authorization: Bearer)", value: "bearer" },
            { label: "API key (Authorization: ApiKey)", value: "api-key" },
          ]}
          initialValue={tracingOtlpAuthMode}
          onSelect={(value) => {
            const mode = value as "none" | "bearer" | "api-key";
            setTracingOtlpAuthMode(mode);
            dispatch({
              type: "SET_TRACING_CONFIG",
              config: { tracingOtlpAuthMode: mode },
            });
            setError(null);
            flow.next();
          }}
        />
      ),
    },
    {
      id: "tracing-otlp-cred",
      render: (flow) => (
        <TextField
          label="Distributed Tracing - OTLP credential"
          hint={`Sent as Authorization: ${tracingOtlpAuthMode === "api-key" ? "ApiKey" : "Bearer"} <value>.`}
          value={tracingOtlpToken}
          onChange={setTracingOtlpToken}
          placeholder="otlp-credential"
          mask
          onSubmit={() => {
            if (!tracingOtlpToken) {
              setError("A credential is required for the selected OTLP auth mode");
              return;
            }
            setError(null);
            dispatch({
              type: "SET_TRACING_CONFIG",
              config: { tracingOtlpToken },
            });
            flow.next();
          }}
        />
      ),
    },
    {
      id: "tracing-azure-connection",
      render: (flow) => (
        <TextField
          label="Distributed Tracing - Azure Monitor connection string"
          hint="Application Insights connection string (carries the ingestion endpoint + instrumentation key)."
          value={tracingAzureConnectionString}
          onChange={setTracingAzureConnectionString}
          placeholder="InstrumentationKey=...;IngestionEndpoint=https://..."
          mask
          onSubmit={() => {
            if (!tracingAzureConnectionString) {
              setError("Azure Monitor connection string is required");
              return;
            }
            setError(null);
            dispatch({
              type: "SET_TRACING_CONFIG",
              config: { tracingAzureConnectionString },
            });
            flow.next();
          }}
        />
      ),
    },

    // ----- Application log shipping -----
    {
      id: "applogs-endpoint",
      render: (flow) => (
        <TextField
          label="Application Log Shipping - BYO Elasticsearch endpoint"
          hint="Optional BYO sink via Vector. For AWS/Azure native log collection, enable the provider's cluster logging agent instead."
          value={appLogsEndpoint}
          onChange={setAppLogsEndpoint}
          placeholder="https://<host>.es.<region>.cloud.es.io:9243"
          onSubmit={() => {
            if (!appLogsEndpoint || !isValidUrl(appLogsEndpoint)) {
              setError("A valid Elasticsearch endpoint is required");
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
            flow.next();
          }}
        />
      ),
    },
    {
      id: "applogs-user",
      render: (flow) => (
        <TextField
          label="Application Log Shipping - Elasticsearch username"
          value={appLogsUser}
          onChange={setAppLogsUser}
          placeholder="elastic"
          onSubmit={() => {
            if (!appLogsUser) {
              setError("Elasticsearch username is required");
              return;
            }
            setError(null);
            dispatch({
              type: "SET_APP_LOGS_CONFIG",
              config: { appLogsElasticUsername: appLogsUser },
            });
            flow.next();
          }}
        />
      ),
    },
    {
      id: "applogs-pass",
      render: (flow) => (
        <TextField
          label="Application Log Shipping - Elasticsearch password"
          value={appLogsPass}
          onChange={setAppLogsPass}
          mask
          onSubmit={() => {
            if (!appLogsPass) {
              setError("Elasticsearch password is required");
              return;
            }
            setError(null);
            dispatch({
              type: "SET_APP_LOGS_CONFIG",
              config: { appLogsElasticPassword: appLogsPass },
            });
            flow.next();
          }}
        />
      ),
    },
    {
      id: "applogs-index",
      render: (flow) => (
        <TextField
          label="Application Log Shipping - index name"
          hint="Elasticsearch index (data stream) for app logs."
          value={appLogsIndex}
          onChange={setAppLogsIndex}
          placeholder="rulebricks-app-logs"
          onSubmit={() => {
            setError(null);
            dispatch({
              type: "SET_APP_LOGS_CONFIG",
              config: { appLogsElasticIndex: appLogsIndex || "rulebricks-app-logs" },
            });
            flow.next();
          }}
        />
      ),
    },

    // ----- Valkey Admin ingress -----
    {
      id: "valkey-admin-username",
      render: (flow) => (
        <TextField
          label="Valkey Admin BasicAuth Username"
          hint={`This username protects https://valkey.${state.domain}.`}
          value={valkeyAdminUsername}
          onChange={setValkeyAdminUsername}
          placeholder="admin"
          onSubmit={() => {
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
            flow.next();
          }}
        />
      ),
    },
    {
      id: "valkey-admin-password",
      render: (flow) => (
        <TextField
          label="Valkey Admin BasicAuth Password"
          hint="Leave empty to generate a secure value. Only an htpasswd bcrypt hash is stored in generated Helm values."
          value={valkeyAdminPassword}
          onChange={setValkeyAdminPassword}
          placeholder="Leave empty to generate a secure value"
          mask
          onSubmit={() => {
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
              setError(
                err instanceof Error ? err.message : "Unable to hash password",
              );
              return;
            }
            setError(null);
            flow.next();
          }}
        />
      ),
    },
    {
      id: "valkey-admin-allowed-ips",
      render: (flow) => (
        <TextField
          label="Valkey Admin Allowed IPs"
          hint="Optional comma-separated CIDR allowlist. Leave blank to allow any IP that can reach Traefik."
          value={valkeyAdminAllowedIPs}
          onChange={setValkeyAdminAllowedIPs}
          placeholder="203.0.113.0/24, 198.51.100.10/32"
          onSubmit={() => {
            const allowedIPs = valkeyAdminAllowedIPs
              .split(",")
              .map((value) => value.trim())
              .filter(Boolean);
            dispatch({
              type: "SET_EXTERNAL_SERVICES",
              config: { valkeyAdminAllowedIPs: allowedIPs },
            });
            setError(null);
            flow.next();
          }}
        />
      ),
    },

    // ----- Custom email templates -----
    {
      id: "email-subject-invite",
      render: (flow) => (
        <TextField
          label="Invite Email Subject"
          hint={`Press Enter to use the default: "${DEFAULT_EMAIL_SUBJECTS.invite}"`}
          value={emailSubjectInvite}
          onChange={setEmailSubjectInvite}
          placeholder={DEFAULT_EMAIL_SUBJECTS.invite}
          onSubmit={() => {
            dispatch({
              type: "SET_EMAIL_SUBJECTS",
              subjects: { invite: emailSubjectInvite },
            });
            flow.next();
          }}
        />
      ),
    },
    {
      id: "email-subject-confirm",
      render: (flow) => (
        <TextField
          label="Confirmation Email Subject"
          hint={`Default: "${DEFAULT_EMAIL_SUBJECTS.confirmation}"`}
          value={emailSubjectConfirm}
          onChange={setEmailSubjectConfirm}
          placeholder={DEFAULT_EMAIL_SUBJECTS.confirmation}
          onSubmit={() => {
            dispatch({
              type: "SET_EMAIL_SUBJECTS",
              subjects: { confirmation: emailSubjectConfirm },
            });
            flow.next();
          }}
        />
      ),
    },
    {
      id: "email-subject-recovery",
      render: (flow) => (
        <TextField
          label="Password Recovery Email Subject"
          hint={`Default: "${DEFAULT_EMAIL_SUBJECTS.recovery}"`}
          value={emailSubjectRecovery}
          onChange={setEmailSubjectRecovery}
          placeholder={DEFAULT_EMAIL_SUBJECTS.recovery}
          onSubmit={() => {
            dispatch({
              type: "SET_EMAIL_SUBJECTS",
              subjects: { recovery: emailSubjectRecovery },
            });
            flow.next();
          }}
        />
      ),
    },
    {
      id: "email-subject-change",
      render: (flow) => (
        <TextField
          label="Email Change Subject"
          hint={`Default: "${DEFAULT_EMAIL_SUBJECTS.emailChange}"`}
          value={emailSubjectChange}
          onChange={setEmailSubjectChange}
          placeholder={DEFAULT_EMAIL_SUBJECTS.emailChange}
          onSubmit={() => {
            dispatch({
              type: "SET_EMAIL_SUBJECTS",
              subjects: { emailChange: emailSubjectChange },
            });
            flow.next();
          }}
        />
      ),
    },
    {
      id: "email-template-invite",
      render: (flow) => (
        <TextField
          label="Invite Template URL"
          hint="Publicly accessible HTML template (S3, GCS, or any HTTPS URL)."
          value={emailTemplateInvite}
          onChange={setEmailTemplateInvite}
          placeholder="https://bucket.s3.amazonaws.com/templates/invite.html"
          onSubmit={() => {
            if (!isValidUrl(emailTemplateInvite)) {
              setError("Please enter a valid URL for the invite template");
              return;
            }
            setError(null);
            dispatch({
              type: "SET_EMAIL_TEMPLATES",
              templates: { invite: emailTemplateInvite },
            });
            flow.next();
          }}
        />
      ),
    },
    {
      id: "email-template-confirm",
      render: (flow) => (
        <TextField
          label="Confirmation Template URL"
          value={emailTemplateConfirm}
          onChange={setEmailTemplateConfirm}
          placeholder="https://bucket.s3.amazonaws.com/templates/verify.html"
          onSubmit={() => {
            if (!isValidUrl(emailTemplateConfirm)) {
              setError("Please enter a valid URL for the confirmation template");
              return;
            }
            setError(null);
            dispatch({
              type: "SET_EMAIL_TEMPLATES",
              templates: { confirmation: emailTemplateConfirm },
            });
            flow.next();
          }}
        />
      ),
    },
    {
      id: "email-template-recovery",
      render: (flow) => (
        <TextField
          label="Recovery Template URL"
          value={emailTemplateRecovery}
          onChange={setEmailTemplateRecovery}
          placeholder="https://bucket.s3.amazonaws.com/templates/password_change.html"
          onSubmit={() => {
            if (!isValidUrl(emailTemplateRecovery)) {
              setError("Please enter a valid URL for the recovery template");
              return;
            }
            setError(null);
            dispatch({
              type: "SET_EMAIL_TEMPLATES",
              templates: { recovery: emailTemplateRecovery },
            });
            flow.next();
          }}
        />
      ),
    },
    {
      id: "email-template-change",
      render: (flow) => (
        <TextField
          label="Email Change Template URL"
          value={emailTemplateChange}
          onChange={setEmailTemplateChange}
          placeholder="https://bucket.s3.amazonaws.com/templates/email_change.html"
          onSubmit={() => {
            if (!isValidUrl(emailTemplateChange)) {
              setError("Please enter a valid URL for the email change template");
              return;
            }
            setError(null);
            dispatch({
              type: "SET_EMAIL_TEMPLATES",
              templates: { emailChange: emailTemplateChange },
            });
            flow.next();
          }}
        />
      ),
    },
  ];

  const fields: FlowField[] = fieldDefs.map((field) => ({
    ...field,
    when: () => fieldOrder.has(field.id),
  }));

  const flow = useFieldFlow({
    fields,
    onDone: onComplete,
    onExit: onBack,
    entry: entryDirection === "back" ? "end" : "start",
    onNavigate: () => setError(null),
  });

  if (!needsAnything) {
    return null;
  }

  return (
    <BorderBox title="Feature Configuration">
      {flow.render()}

      <CheckRows rows={monitoringChecks()} />
      <FieldError error={error} />
      <StepFooter />
    </BorderBox>
  );
}
