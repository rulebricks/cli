import React, { useState, useEffect } from "react";
import { Box, Text, useInput } from "ink";
import SelectInput from "ink-select-input";
import TextInput from "ink-text-input";
import { useWizard } from "../WizardContext.js";
import { BorderBox, useTheme } from "../../common/index.js";
import { Spinner } from "../../common/Spinner.js";
import {
  SSOProvider,
  LoggingSink,
  CloudLoggingAuthMode,
  MonitoringDestination,
  RemoteWriteAuthType,
  RemoteWriteDestination,
  LOGGING_SINK_INFO,
  CLOUD_REGIONS,
  CloudProvider,
  DEFAULT_EMAIL_SUBJECTS,
} from "../../../types/index.js";
import { listBucketsInRegion, listRegions } from "../../../lib/cloudCli.js";

interface FeatureConfigStepProps {
  onComplete: () => void;
  onBack: () => void;
}

type SubStep =
  | "openai-key"
  | "sso-provider"
  | "sso-url"
  | "sso-client-id"
  | "sso-client-secret"
  | "monitoring-remote-write-ask"
  | "monitoring-remote-write-destination"
  | "monitoring-remote-write-url"
  | "monitoring-aws-region"
  | "monitoring-aws-role-arn"
  | "monitoring-remote-write-azure-auth"
  | "monitoring-remote-write-generic-auth"
  | "monitoring-remote-write-client-id"
  | "monitoring-remote-write-tenant-id"
  | "monitoring-remote-write-secret-ref"
  | "monitoring-remote-write-username-secret-ref"
  | "monitoring-remote-write-password-secret-ref"
  | "monitoring-remote-write-bearer-secret-ref"
  | "logging-category"
  | "logging-sink"
  | "logging-region-loading"
  | "logging-region"
  | "logging-bucket-loading"
  | "logging-bucket"
  | "logging-s3-role-arn"
  | "logging-azure-container"
  | "logging-azure-auth"
  | "logging-azure-client-id"
  | "logging-azure-tenant-id"
  | "logging-azure-connection-string-secret"
  | "logging-gcp-service-account"
  // Platform-specific config steps
  | "logging-datadog-config"
  | "logging-splunk-config"
  | "logging-elasticsearch-config"
  | "logging-loki-config"
  | "logging-newrelic-config"
  | "logging-axiom-config"
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

const SSO_PROVIDERS = [
  { label: "Microsoft Azure AD", value: "azure" },
  { label: "Google Workspace", value: "google" },
  { label: "Okta", value: "okta" },
  { label: "Keycloak", value: "keycloak" },
  { label: "Ory", value: "ory" },
  { label: "Other OIDC Provider", value: "other" },
];

const LOGGING_CATEGORIES = [
  { label: "Cloud Storage (S3, Azure Blob, GCS)", value: "cloud-storage" },
  {
    label: "Logging Platform (Datadog, Splunk, etc.)",
    value: "logging-platform",
  },
];

const CLOUD_STORAGE_SINKS = [
  { label: "AWS S3", value: "s3" },
  { label: "Azure Blob Storage", value: "azure-blob" },
  { label: "Google Cloud Storage", value: "gcs" },
];

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

// Bucket selector sub-component with R key refresh
interface BucketSelectorProps {
  loggingSink: LoggingSink;
  loggingRegion: string;
  availableBuckets: string[];
  isRefreshing: boolean;
  onSelect: (item: { value: string }) => void;
  onRefresh: () => void;
  colors: { accent: string; success: string; muted: string };
}

function BucketSelector({
  loggingSink,
  loggingRegion,
  availableBuckets,
  isRefreshing,
  onSelect,
  onRefresh,
  colors,
}: BucketSelectorProps) {
  useInput((input) => {
    if (input.toLowerCase() === "r") {
      onRefresh();
    }
  });

  const bucketItems = availableBuckets.map((b) => ({ label: b, value: b }));
  const hasBuckets = availableBuckets.length > 0;

  return (
    <Box flexDirection="column" marginY={1}>
      <Text bold>
        {loggingSink === "s3" && "Select S3 Bucket"}
        {loggingSink === "azure-blob" && "Select Azure Storage Account"}
        {loggingSink === "gcs" && "Select GCS Bucket"}
      </Text>
      <Text color="gray" dimColor>
        Select an existing bucket in {loggingRegion}
      </Text>

      {isRefreshing ? (
        <Box marginTop={1}>
          <Spinner label="Refreshing bucket list..." />
        </Box>
      ) : hasBuckets ? (
        <Box
          marginTop={1}
          height={10}
          flexDirection="column"
          overflowY="hidden"
        >
          <SelectInput
            items={bucketItems}
            onSelect={onSelect}
            limit={8}
            indicatorComponent={() => null}
            itemComponent={({ isSelected, label }) => (
              <Text color={isSelected ? colors.accent : undefined}>
                {isSelected ? "❯ " : "  "}
                {label}
              </Text>
            )}
          />
        </Box>
      ) : (
        <Box marginTop={1} flexDirection="column">
          <Text color="yellow">No buckets found in {loggingRegion}.</Text>
          <Text color="gray" dimColor>
            Create a bucket in your cloud console, then press R to refresh.
          </Text>
        </Box>
      )}

      <Box marginTop={1} flexDirection="column">
        <Box>
          <Text color={colors.success}>✓</Text>
          <Text color="gray">
            {" "}
            Sink: {LOGGING_SINK_INFO[loggingSink]?.name}
          </Text>
        </Box>
        <Box>
          <Text color={colors.success}>✓</Text>
          <Text color="gray"> Region: {loggingRegion}</Text>
        </Box>
      </Box>

      <Box marginTop={1}>
        <Text color="gray" dimColor>
          R to refresh list • ↑/↓ to navigate • Enter to select
        </Text>
      </Box>
    </Box>
  );
}

const MONITORING_DESTINATIONS = [
  { label: "Local Grafana (bundled)", value: "local-grafana" },
  { label: "AWS Managed Prometheus (AMP)", value: "aws-amp" },
  { label: "Azure Monitor managed Prometheus", value: "azure-monitor" },
  { label: "Grafana Cloud", value: "grafana-cloud" },
  { label: "Generic Prometheus remote_write", value: "generic" },
];

const REMOTE_WRITE_DESTINATIONS = MONITORING_DESTINATIONS.filter(
  (destination) => destination.value !== "local-grafana",
);

const AZURE_REMOTE_WRITE_AUTH = [
  { label: "Workload identity", value: "workload-identity" },
  { label: "Managed identity", value: "managed-identity" },
  { label: "OAuth client secret", value: "oauth" },
];

const AZURE_LOGGING_AUTH = [
  { label: "Workload identity", value: "workload-identity" },
  { label: "Connection string Secret (fallback)", value: "secret" },
];

const GENERIC_REMOTE_WRITE_AUTH = [
  { label: "No additional auth", value: "none" },
  { label: "Basic auth from Kubernetes Secret", value: "basic" },
  { label: "Bearer token from Kubernetes Secret", value: "bearer" },
];

export function FeatureConfigStep({
  onComplete,
  onBack,
}: FeatureConfigStepProps) {
  const { state, dispatch } = useWizard();
  const { colors } = useTheme();

  // Determine what needs to be configured
  const needsAI = state.aiEnabled && !state.openaiApiKey;
  const needsSSO = state.ssoEnabled;
  const needsMonitoring = state.monitoringEnabled;
  const needsLogging = state.loggingSink !== "console";
  const needsCustomEmails = state.customEmailsEnabled;

  // Configuration order: AI -> SSO -> Monitoring -> Logging -> Custom Emails
  const getInitialStep = (): SubStep => {
    if (needsAI) return "openai-key";
    if (needsSSO) return "sso-provider";
    if (needsMonitoring) return "monitoring-remote-write-ask";
    if (needsLogging) return "logging-category";
    if (needsCustomEmails) return "email-subject-invite";
    return "done";
  };

  const [subStep, setSubStep] = useState<SubStep>(getInitialStep);
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
  const [remoteWriteAwsRoleArn, setRemoteWriteAwsRoleArn] = useState(
    state.prometheusRemoteWriteAwsRoleArn || "",
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
  const [loggingBucket, setLoggingBucket] = useState(state.loggingBucket || "");
  const [loggingRegion, setLoggingRegion] = useState(state.loggingRegion || "");
  const [loggingCloudAuthMode, setLoggingCloudAuthMode] =
    useState<CloudLoggingAuthMode>(
      state.loggingCloudAuthMode || "workload-identity",
    );
  const [s3RoleArn, setS3RoleArn] = useState(
    state.loggingAwsIamRoleArn || "",
  );
  const [azureBlobContainer, setAzureBlobContainer] = useState(
    state.loggingAzureBlobContainer || "rulebricks-logs",
  );
  const [azureBlobClientId, setAzureBlobClientId] = useState(
    state.loggingAzureBlobClientId || "",
  );
  const [azureBlobTenantId, setAzureBlobTenantId] = useState(
    state.loggingAzureBlobTenantId || "",
  );
  const [
    azureBlobConnectionStringSecretRef,
    setAzureBlobConnectionStringSecretRef,
  ] = useState(state.loggingAzureBlobConnectionStringSecretRef || "");
  const [gcpServiceAccountEmail, setGcpServiceAccountEmail] = useState(
    state.loggingGcpServiceAccountEmail || "",
  );
  const [loggingCategory, setLoggingCategory] = useState<
    "cloud-storage" | "logging-platform" | null
  >(null);
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

  // Dynamic bucket/region lists
  const [availableBuckets, setAvailableBuckets] = useState<string[]>([]);
  const [availableRegions, setAvailableRegions] = useState<string[]>([]);
  const [isRefreshing, setIsRefreshing] = useState(false);

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
      !needsCustomEmails
    ) {
      onComplete();
    }
  }, []);

  useInput((input, key) => {
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
      case "monitoring-remote-write-ask":
        if (needsSSO) setSubStep("sso-client-secret");
        else if (needsAI) setSubStep("openai-key");
        else onBack();
        break;
      case "monitoring-remote-write-destination":
        setSubStep("monitoring-remote-write-ask");
        break;
      case "monitoring-remote-write-url":
        setSubStep("monitoring-remote-write-destination");
        break;
      case "monitoring-aws-region":
        setSubStep("monitoring-remote-write-url");
        break;
      case "monitoring-aws-role-arn":
        setSubStep("monitoring-aws-region");
        break;
      case "monitoring-remote-write-azure-auth":
      case "monitoring-remote-write-generic-auth":
        setSubStep("monitoring-remote-write-url");
        break;
      case "monitoring-remote-write-client-id":
        if (remoteWriteDestination === "azure-monitor") {
          setSubStep("monitoring-remote-write-azure-auth");
        } else {
          setSubStep("monitoring-remote-write-url");
        }
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
      case "logging-category":
        if (needsMonitoring) setSubStep("monitoring-remote-write-ask");
        else if (needsSSO) setSubStep("sso-client-secret");
        else if (needsAI) setSubStep("openai-key");
        else onBack();
        break;
      case "logging-sink":
        setSubStep("logging-category");
        break;
      case "logging-region":
      case "logging-region-loading":
        setSubStep("logging-sink");
        break;
      case "logging-bucket":
      case "logging-bucket-loading":
        setSubStep("logging-region");
        break;
      case "logging-s3-role-arn":
        setSubStep("logging-bucket");
        break;
      case "logging-azure-container":
        setSubStep("logging-bucket");
        break;
      case "logging-azure-auth":
        setSubStep("logging-azure-container");
        break;
      case "logging-azure-client-id":
        setSubStep("logging-azure-auth");
        break;
      case "logging-azure-tenant-id":
        setSubStep("logging-azure-client-id");
        break;
      case "logging-azure-connection-string-secret":
        setSubStep("logging-azure-auth");
        break;
      case "logging-gcp-service-account":
        setSubStep("logging-bucket");
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
      // Email template steps
      case "email-subject-invite":
        if (needsLogging) setSubStep("logging-category");
        else if (needsMonitoring) setSubStep("monitoring-remote-write-ask");
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

  const advanceToNext = (from: SubStep) => {
    switch (from) {
      case "openai-key":
        if (needsSSO) setSubStep("sso-provider");
        else if (needsMonitoring) setSubStep("monitoring-remote-write-ask");
        else if (needsLogging) setSubStep("logging-category");
        else if (needsCustomEmails) setSubStep("email-subject-invite");
        else onComplete();
        break;
      case "sso-client-secret":
        if (needsMonitoring) setSubStep("monitoring-remote-write-ask");
        else if (needsLogging) setSubStep("logging-category");
        else if (needsCustomEmails) setSubStep("email-subject-invite");
        else onComplete();
        break;
      case "monitoring-remote-write-ask":
      case "monitoring-remote-write-destination":
      case "monitoring-remote-write-url":
      case "monitoring-aws-region":
      case "monitoring-aws-role-arn":
      case "monitoring-remote-write-azure-auth":
      case "monitoring-remote-write-generic-auth":
      case "monitoring-remote-write-client-id":
      case "monitoring-remote-write-tenant-id":
      case "monitoring-remote-write-secret-ref":
      case "monitoring-remote-write-username-secret-ref":
      case "monitoring-remote-write-password-secret-ref":
      case "monitoring-remote-write-bearer-secret-ref":
        if (needsLogging) setSubStep("logging-category");
        else if (needsCustomEmails) setSubStep("email-subject-invite");
        else onComplete();
        break;
      case "logging-bucket":
      case "logging-s3-role-arn":
      case "logging-azure-tenant-id":
      case "logging-azure-connection-string-secret":
      case "logging-gcp-service-account":
        // Cloud storage config complete, check for custom emails
        if (needsCustomEmails) setSubStep("email-subject-invite");
        else onComplete();
        break;
      case "logging-datadog-config":
      case "logging-splunk-config":
      case "logging-elasticsearch-config":
      case "logging-loki-config":
      case "logging-newrelic-config":
      case "logging-axiom-config":
        // Platform config complete, check for custom emails
        if (needsCustomEmails) setSubStep("email-subject-invite");
        else onComplete();
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
  const handleRemoteWriteAsk = (item: { value: string }) => {
    const destination = item.value as MonitoringDestination;

    if (destination === "local-grafana") {
      setRemoteWriteDestination(null);
      dispatch({ type: "SET_PROMETHEUS_REMOTE_WRITE", url: "" });
      dispatch({
        type: "SET_PROMETHEUS_REMOTE_WRITE_CONFIG",
        config: {
          prometheusMonitoringDestination: "local-grafana",
          prometheusRemoteWriteDestination: null,
          prometheusRemoteWriteAuthType: null,
        },
      });
      advanceToNext("monitoring-remote-write-ask");
      return;
    }

    handleRemoteWriteDestinationSelect({ value: destination });
  };

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
    setSubStep("monitoring-remote-write-url");
  };

  const handleRemoteWriteUrlSubmit = () => {
    if (remoteWriteUrl) {
      try {
        new URL(remoteWriteUrl);
      } catch {
        setError("Invalid URL format");
        return;
      }
    }
    setError(null);
    dispatch({ type: "SET_PROMETHEUS_REMOTE_WRITE", url: remoteWriteUrl });

    if (remoteWriteDestination === "aws-amp") {
      setSubStep("monitoring-aws-region");
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

  const handleAwsRemoteWriteRegionSubmit = () => {
    if (!remoteWriteAwsRegion) {
      setError("AWS region is required");
      return;
    }
    setError(null);
    setSubStep("monitoring-aws-role-arn");
  };

  const handleAwsRemoteWriteRoleArnSubmit = () => {
    if (remoteWriteAwsRoleArn && !remoteWriteAwsRoleArn.startsWith("arn:")) {
      setError("Enter a valid IAM role ARN or leave blank");
      return;
    }
    dispatch({
      type: "SET_PROMETHEUS_REMOTE_WRITE_CONFIG",
      config: {
        prometheusRemoteWriteDestination: "aws-amp",
        prometheusMonitoringDestination: "aws-amp",
        prometheusRemoteWriteAuthType: "none",
        prometheusRemoteWriteAwsRegion: remoteWriteAwsRegion,
        prometheusRemoteWriteAwsRoleArn: remoteWriteAwsRoleArn,
      },
    });
    setError(null);
    advanceToNext("monitoring-aws-role-arn");
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
    setSubStep("monitoring-remote-write-client-id");
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

    if (remoteWriteAuthType === "managed-identity") {
      saveRemoteWriteConfig("managed-identity", {
        clientId: remoteWriteClientId,
      });
      return;
    }

    setError(null);
    setSubStep("monitoring-remote-write-tenant-id");
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

  // === Logging Configuration ===

  // Map logging sink to cloud provider
  const sinkToProvider = (sink: LoggingSink): CloudProvider | null => {
    if (sink === "s3") return "aws";
    if (sink === "azure-blob") return "azure";
    if (sink === "gcs") return "gcp";
    return null;
  };

  // Is sink a cloud storage type?
  const isCloudStorageSink = (sink: LoggingSink): boolean => {
    return sink === "s3" || sink === "azure-blob" || sink === "gcs";
  };

  // Step 1: Select logging category
  const handleLoggingCategorySelect = (item: { value: string }) => {
    const category = item.value as "cloud-storage" | "logging-platform";
    setLoggingCategory(category);
    setSubStep("logging-sink");
  };

  // Step 2: Select logging sink based on category
  const handleLoggingSinkSelect = async (item: { value: string }) => {
    const sink = item.value as LoggingSink;
    setLoggingSink(sink);
    dispatch({ type: "SET_LOGGING_SINK", sink });

    if (isCloudStorageSink(sink)) {
      // Cloud storage: go to region selection
      loadRegionsForLogging(sink);
    } else {
      // Logging platform: go to platform-specific config
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
    }
  };

  // Load regions for cloud storage
  const loadRegionsForLogging = async (sink: LoggingSink) => {
    const provider = sinkToProvider(sink);
    if (!provider) {
      setSubStep("logging-region");
      return;
    }

    setSubStep("logging-region-loading");
    try {
      const regions = await listRegions(provider);
      if (regions.length > 0) {
        setAvailableRegions(regions);
      } else {
        setAvailableRegions(CLOUD_REGIONS[provider]);
      }
    } catch {
      setAvailableRegions(CLOUD_REGIONS[provider]);
    }
    setSubStep("logging-region");
  };

  // After region is selected, load buckets in that region
  const handleLoggingRegionSelect = async (item: { value: string }) => {
    setLoggingRegion(item.value);
    dispatch({
      type: "SET_LOGGING_CONFIG",
      config: { loggingRegion: item.value },
    });

    // Now load buckets in this region
    const provider = sinkToProvider(loggingSink);
    if (provider) {
      setSubStep("logging-bucket-loading");
      try {
        const buckets = await listBucketsInRegion(provider, item.value);
        setAvailableBuckets(buckets);
      } catch {
        setAvailableBuckets([]);
      }
    }
    setSubStep("logging-bucket");
  };

  // Refresh bucket list
  const refreshBuckets = async () => {
    if (isRefreshing) return;

    const provider = sinkToProvider(loggingSink);
    if (!provider || !loggingRegion) return;

    setIsRefreshing(true);
    try {
      const buckets = await listBucketsInRegion(provider, loggingRegion);
      setAvailableBuckets(buckets);
    } catch {
      // Keep existing list on error
    }
    setIsRefreshing(false);
  };

  // Select bucket (no create option)
  const handleLoggingBucketSelect = (item: { value: string }) => {
    setLoggingBucket(item.value);
    dispatch({
      type: "SET_LOGGING_CONFIG",
      config: { loggingBucket: item.value },
    });
    if (loggingSink === "s3") {
      setSubStep("logging-s3-role-arn");
      return;
    }
    if (loggingSink === "azure-blob") {
      setSubStep("logging-azure-container");
      return;
    }
    if (loggingSink === "gcs") {
      setSubStep("logging-gcp-service-account");
      return;
    }
    advanceToNext("logging-bucket");
  };

  const handleS3RoleArnSubmit = () => {
    if (!s3RoleArn.startsWith("arn:")) {
      setError("IAM role ARN is required for S3 IRSA");
      return;
    }
    setError(null);
    dispatch({
      type: "SET_LOGGING_CONFIG",
      config: {
        loggingCloudAuthMode: "workload-identity",
        loggingAwsIamRoleArn: s3RoleArn,
      },
    });
    advanceToNext("logging-s3-role-arn");
  };

  const handleAzureBlobContainerSubmit = () => {
    if (!azureBlobContainer) {
      setError("Azure Blob container name is required");
      return;
    }
    setError(null);
    dispatch({
      type: "SET_LOGGING_CONFIG",
      config: { loggingAzureBlobContainer: azureBlobContainer },
    });
    setSubStep("logging-azure-auth");
  };

  const handleAzureBlobAuthSelect = (item: { value: string }) => {
    const authMode = item.value as CloudLoggingAuthMode;
    setLoggingCloudAuthMode(authMode);
    dispatch({
      type: "SET_LOGGING_CONFIG",
      config: { loggingCloudAuthMode: authMode },
    });
    setSubStep(
      authMode === "workload-identity"
        ? "logging-azure-client-id"
        : "logging-azure-connection-string-secret",
    );
  };

  const handleAzureBlobClientIdSubmit = () => {
    if (!azureBlobClientId) {
      setError("Managed identity client ID is required");
      return;
    }
    setError(null);
    setSubStep("logging-azure-tenant-id");
  };

  const handleAzureBlobTenantIdSubmit = () => {
    if (!azureBlobTenantId) {
      setError("Azure tenant ID is required");
      return;
    }
    setError(null);
    dispatch({
      type: "SET_LOGGING_CONFIG",
      config: {
        loggingCloudAuthMode: "workload-identity",
        loggingAzureBlobContainer: azureBlobContainer,
        loggingAzureBlobClientId: azureBlobClientId,
        loggingAzureBlobTenantId: azureBlobTenantId,
      },
    });
    advanceToNext("logging-azure-tenant-id");
  };

  const handleAzureBlobConnectionStringSecretSubmit = () => {
    if (!azureBlobConnectionStringSecretRef.includes(":")) {
      setError("Use secret-name:key format");
      return;
    }
    setError(null);
    dispatch({
      type: "SET_LOGGING_CONFIG",
      config: {
        loggingAzureBlobContainer: azureBlobContainer,
        loggingCloudAuthMode: "secret",
        loggingAzureBlobConnectionStringSecretRef:
          azureBlobConnectionStringSecretRef,
      },
    });
    advanceToNext("logging-azure-connection-string-secret");
  };

  const handleGcpServiceAccountSubmit = () => {
    if (!gcpServiceAccountEmail.includes("@")) {
      setError("Google service account email is required");
      return;
    }
    setError(null);
    dispatch({
      type: "SET_LOGGING_CONFIG",
      config: {
        loggingCloudAuthMode: "workload-identity",
        loggingGcpServiceAccountEmail: gcpServiceAccountEmail,
      },
    });
    advanceToNext("logging-gcp-service-account");
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
        loggingBucket: datadogApiKey, // Repurpose bucket field for API key
        loggingRegion: datadogSite, // Repurpose region field for site
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
        loggingBucket: splunkHecToken,
        loggingRegion: splunkUrl,
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
    // Store as JSON in bucket field for complex config
    dispatch({
      type: "SET_LOGGING_CONFIG",
      config: {
        loggingBucket: JSON.stringify({
          url: elasticsearchUrl,
          user: elasticsearchUser,
          password: elasticsearchPass,
          index: elasticsearchIndex,
        }),
        loggingRegion: elasticsearchIndex,
      },
    });
    advanceToNext("logging-elasticsearch-config");
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
        loggingBucket: lokiUrl,
        loggingRegion: "",
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
        loggingBucket: newrelicLicenseKey,
        loggingRegion: newrelicAccountId,
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
        loggingBucket: axiomApiToken,
        loggingRegion: axiomDataset,
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

  // Build bucket items for selection (no create option - just existing buckets)
  const getBucketItems = (): Array<{ label: string; value: string }> => {
    return availableBuckets.map((b) => ({ label: b, value: b }));
  };

  // Get regions based on logging sink (use dynamic regions if available)
  const getLoggingRegions = (): Array<{ label: string; value: string }> => {
    if (availableRegions.length > 0) {
      return availableRegions.map((r) => ({ label: r, value: r }));
    }

    const provider = sinkToProvider(loggingSink);
    if (!provider) return [];

    return CLOUD_REGIONS[provider].map((r) => ({ label: r, value: r }));
  };

  // If nothing to configure, don't render
  if (
    !needsAI &&
    !needsSSO &&
    !needsMonitoring &&
    !needsLogging &&
    !needsCustomEmails
  ) {
    return null;
  }

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
      {subStep === "monitoring-remote-write-ask" && (
        <Box flexDirection="column" marginY={1}>
          <Text bold>Monitoring Destination</Text>
          <Text color="gray" dimColor>
            Choose where Prometheus metrics should be viewed or sent.
          </Text>
          <Box marginTop={1}>
            <SelectInput
              items={MONITORING_DESTINATIONS}
              onSelect={handleRemoteWriteAsk}
              indicatorComponent={() => null}
              itemComponent={({ isSelected, label }) => (
                <Text color={isSelected ? colors.accent : undefined}>
                  {isSelected ? "❯ " : "  "}
                  {label}
                </Text>
              )}
            />
          </Box>
          <ProgressSummary />
        </Box>
      )}

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

      {subStep === "monitoring-aws-region" && (
        <Box flexDirection="column" marginY={1}>
          <Text bold>AWS Managed Prometheus Region</Text>
          <Text color="gray" dimColor>
            Region used for SigV4 signing.
          </Text>
          <Box marginTop={1}>
            <TextInput
              value={remoteWriteAwsRegion}
              onChange={setRemoteWriteAwsRegion}
              onSubmit={handleAwsRemoteWriteRegionSubmit}
              placeholder="us-east-1"
            />
          </Box>
          <ProgressSummary />
        </Box>
      )}

      {subStep === "monitoring-aws-role-arn" && (
        <Box flexDirection="column" marginY={1}>
          <Text bold>Prometheus IRSA Role ARN</Text>
          <Text color="gray" dimColor>
            Optional. If provided, the Prometheus service account will be
            annotated with this role.
          </Text>
          <Box marginTop={1}>
            <TextInput
              value={remoteWriteAwsRoleArn}
              onChange={setRemoteWriteAwsRoleArn}
              onSubmit={handleAwsRemoteWriteRoleArnSubmit}
              placeholder="arn:aws:iam::123456789012:role/rulebricks-prometheus"
            />
          </Box>
          <ProgressSummary />
        </Box>
      )}

      {subStep === "monitoring-remote-write-destination" && (
        <Box flexDirection="column" marginY={1}>
          <Text bold>Remote Write Destination</Text>
          <Text color="gray" dimColor>
            Select the monitoring backend so required auth fields can be
            collected.
          </Text>
          <Box marginTop={1}>
            <SelectInput
              items={REMOTE_WRITE_DESTINATIONS}
              onSelect={handleRemoteWriteDestinationSelect}
              indicatorComponent={() => null}
              itemComponent={({ isSelected, label }) => (
                <Text color={isSelected ? colors.accent : undefined}>
                  {isSelected ? "❯ " : "  "}
                  {label}
                </Text>
              )}
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
              itemComponent={({ isSelected, label }) => (
                <Text color={isSelected ? colors.accent : undefined}>
                  {isSelected ? "❯ " : "  "}
                  {label}
                </Text>
              )}
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
              itemComponent={({ isSelected, label }) => (
                <Text color={isSelected ? colors.accent : undefined}>
                  {isSelected ? "❯ " : "  "}
                  {label}
                </Text>
              )}
            />
          </Box>
          <ProgressSummary />
        </Box>
      )}

      {subStep === "monitoring-remote-write-client-id" && (
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
            Required for workload identity and OAuth client-secret auth.
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

      {/* Logging Configuration */}
      {subStep === "logging-category" && (
        <Box flexDirection="column" marginY={1}>
          <Text bold>External Logging Destination</Text>
          <Text color="gray" dimColor>
            Choose how you want to store decision logs (Console logging is
            always included)
          </Text>
          <Box marginTop={1}>
            <SelectInput
              items={LOGGING_CATEGORIES}
              onSelect={handleLoggingCategorySelect}
              indicatorComponent={() => null}
              itemComponent={({ isSelected, label }) => (
                <Text color={isSelected ? colors.accent : undefined}>
                  {isSelected ? "❯ " : "  "}
                  {label}
                </Text>
              )}
            />
          </Box>
          <ProgressSummary />
        </Box>
      )}

      {subStep === "logging-sink" && (
        <Box flexDirection="column" marginY={1}>
          <Text bold>
            {loggingCategory === "cloud-storage"
              ? "Select Cloud Storage"
              : "Select Logging Platform"}
          </Text>
          <Text color="gray" dimColor>
            {loggingCategory === "cloud-storage"
              ? "Store logs in cloud object storage"
              : "Send logs to a centralized logging platform"}
          </Text>
          <Box marginTop={1}>
            <SelectInput
              items={
                loggingCategory === "cloud-storage"
                  ? CLOUD_STORAGE_SINKS
                  : LOGGING_PLATFORM_SINKS
              }
              onSelect={handleLoggingSinkSelect}
              indicatorComponent={() => null}
              itemComponent={({ isSelected, label }) => (
                <Text color={isSelected ? colors.accent : undefined}>
                  {isSelected ? "❯ " : "  "}
                  {label}
                </Text>
              )}
            />
          </Box>
          {state.infrastructureMode === "existing" &&
            loggingCategory === "cloud-storage" && (
              <Box
                marginTop={1}
                borderStyle="round"
                borderColor="yellow"
                paddingX={1}
              >
                <Text color="yellow">
                  Note: Cloud storage requires IRSA/Workload Identity in your
                  cluster.
                </Text>
              </Box>
            )}
          <ProgressSummary />
        </Box>
      )}

      {subStep === "logging-region-loading" && (
        <Box flexDirection="column" marginY={1}>
          <Spinner label="Loading available regions..." />
        </Box>
      )}

      {subStep === "logging-region" && (
        <Box flexDirection="column" marginY={1}>
          <Text bold>
            {loggingSink === "s3" && "Select AWS Region"}
            {loggingSink === "azure-blob" && "Select Azure Region"}
            {loggingSink === "gcs" && "Select GCP Region"}
          </Text>
          <Text color="gray" dimColor>
            Select the region where logs will be stored
          </Text>
          <Box
            marginTop={1}
            height={10}
            flexDirection="column"
            overflowY="hidden"
          >
            <SelectInput
              items={getLoggingRegions()}
              onSelect={handleLoggingRegionSelect}
              limit={8}
              indicatorComponent={() => null}
              itemComponent={({ isSelected, label }) => (
                <Text color={isSelected ? colors.accent : undefined}>
                  {isSelected ? "❯ " : "  "}
                  {label}
                </Text>
              )}
            />
          </Box>
          <Box marginTop={1}>
            <Text color={colors.success}>✓</Text>
            <Text color="gray">
              {" "}
              Sink: {LOGGING_SINK_INFO[loggingSink]?.name}
            </Text>
          </Box>
        </Box>
      )}

      {subStep === "logging-bucket-loading" && (
        <Box flexDirection="column" marginY={1}>
          <Spinner label={`Loading buckets in ${loggingRegion}...`} />
        </Box>
      )}

      {subStep === "logging-bucket" && (
        <BucketSelector
          loggingSink={loggingSink}
          loggingRegion={loggingRegion}
          availableBuckets={availableBuckets}
          isRefreshing={isRefreshing}
          onSelect={handleLoggingBucketSelect}
          onRefresh={refreshBuckets}
          colors={colors}
        />
      )}

      {subStep === "logging-s3-role-arn" && (
        <Box flexDirection="column" marginY={1}>
          <Text bold>Vector S3 IRSA Role ARN</Text>
          <Text color="gray" dimColor>
            IAM role trusted by the Vector Kubernetes service account.
          </Text>
          <Box marginTop={1}>
            <TextInput
              value={s3RoleArn}
              onChange={setS3RoleArn}
              onSubmit={handleS3RoleArnSubmit}
              placeholder="arn:aws:iam::123456789012:role/rulebricks-vector"
            />
          </Box>
          <Box marginTop={1}>
            <Text color={colors.success}>✓ S3 bucket: {loggingBucket}</Text>
          </Box>
        </Box>
      )}

      {subStep === "logging-azure-container" && (
        <Box flexDirection="column" marginY={1}>
          <Text bold>Azure Blob Container</Text>
          <Text color="gray" dimColor>
            Enter the container where Rulebricks decision logs should be
            written.
          </Text>
          <Box marginTop={1}>
            <TextInput
              value={azureBlobContainer}
              onChange={setAzureBlobContainer}
              onSubmit={handleAzureBlobContainerSubmit}
              placeholder="rulebricks-logs"
            />
          </Box>
          <Box marginTop={1} flexDirection="column">
            <Text color={colors.success}>✓ Storage account: {loggingBucket}</Text>
          </Box>
        </Box>
      )}

      {subStep === "logging-azure-auth" && (
        <Box flexDirection="column" marginY={1}>
          <Text bold>Azure Blob Authentication</Text>
          <Text color="gray" dimColor>
            Workload identity is recommended. Connection string Secret is a
            fallback for clusters without Azure Workload Identity.
          </Text>
          <Box marginTop={1}>
            <SelectInput
              items={AZURE_LOGGING_AUTH}
              onSelect={handleAzureBlobAuthSelect}
              indicatorComponent={() => null}
              itemComponent={({ isSelected, label }) => (
                <Text color={isSelected ? colors.accent : undefined}>
                  {isSelected ? "❯ " : "  "}
                  {label}
                </Text>
              )}
            />
          </Box>
        </Box>
      )}

      {subStep === "logging-azure-client-id" && (
        <Box flexDirection="column" marginY={1}>
          <Text bold>Azure Managed Identity Client ID</Text>
          <Text color="gray" dimColor>
            Client ID for the identity federated to Vector's service account.
          </Text>
          <Box marginTop={1}>
            <TextInput
              value={azureBlobClientId}
              onChange={setAzureBlobClientId}
              onSubmit={handleAzureBlobClientIdSubmit}
              placeholder="00000000-0000-0000-0000-000000000000"
            />
          </Box>
        </Box>
      )}

      {subStep === "logging-azure-tenant-id" && (
        <Box flexDirection="column" marginY={1}>
          <Text bold>Azure Tenant ID</Text>
          <Text color="gray" dimColor>
            Tenant ID used by Azure Workload Identity.
          </Text>
          <Box marginTop={1}>
            <TextInput
              value={azureBlobTenantId}
              onChange={setAzureBlobTenantId}
              onSubmit={handleAzureBlobTenantIdSubmit}
              placeholder="00000000-0000-0000-0000-000000000000"
            />
          </Box>
        </Box>
      )}

      {subStep === "logging-azure-connection-string-secret" && (
        <Box flexDirection="column" marginY={1}>
          <Text bold>Azure Storage Connection String Secret</Text>
          <Text color="gray" dimColor>
            Enter an existing Kubernetes Secret key in the format name:key.
          </Text>
          <Text color="gray" dimColor>
            The key should contain the Azure Storage connection string.
          </Text>
          <Box marginTop={1}>
            <TextInput
              value={azureBlobConnectionStringSecretRef}
              onChange={setAzureBlobConnectionStringSecretRef}
              onSubmit={handleAzureBlobConnectionStringSecretSubmit}
              placeholder="azure-blob-logs:connection-string"
            />
          </Box>
          <Box marginTop={1} flexDirection="column">
            <Text color={colors.success}>✓ Storage account: {loggingBucket}</Text>
            <Text color={colors.success}>✓ Container: {azureBlobContainer}</Text>
          </Box>
        </Box>
      )}

      {subStep === "logging-gcp-service-account" && (
        <Box flexDirection="column" marginY={1}>
          <Text bold>Google Service Account Email</Text>
          <Text color="gray" dimColor>
            GSA bound to the Vector Kubernetes service account through GKE
            Workload Identity.
          </Text>
          <Box marginTop={1}>
            <TextInput
              value={gcpServiceAccountEmail}
              onChange={setGcpServiceAccountEmail}
              onSubmit={handleGcpServiceAccountSubmit}
              placeholder="rulebricks-vector@project.iam.gserviceaccount.com"
            />
          </Box>
          <Box marginTop={1}>
            <Text color={colors.success}>✓ GCS bucket: {loggingBucket}</Text>
          </Box>
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
              itemComponent={({ isSelected, label }) => (
                <Text color={isSelected ? colors.accent : undefined}>
                  {isSelected ? "❯ " : "  "}
                  {label}
                </Text>
              )}
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
