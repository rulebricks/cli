import React, { createContext, useContext, useReducer, ReactNode } from "react";
import {
  DeploymentConfig,
  CloudProvider,
  DatabaseType,
  PerformanceTier,
  SSOProvider,
  DnsProvider,
  LoggingSink,
  EmailSubjects,
  EmailTemplates,
  DEFAULT_EMAIL_SUBJECTS,
  ProfileConfig,
} from "../../types/index.js";

// Partial config during wizard flow
export interface WizardState {
  step: number;
  name: string;

  // Infrastructure
  infrastructureMode: "existing" | "provision" | null;
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
  existingExternalDns: boolean;

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

  // Performance
  tier: PerformanceTier | null;

  // Features - AI
  aiEnabled: boolean;
  openaiApiKey: string;

  // Features - SSO
  ssoEnabled: boolean;
  ssoProvider: SSOProvider | null;
  ssoUrl: string;
  ssoClientId: string;
  ssoClientSecret: string;

  // Features - Monitoring (Prometheus)
  monitoringEnabled: boolean;
  prometheusRemoteWriteUrl: string;

  // Features - Logging (Vector sinks)
  loggingSink: LoggingSink;
  loggingBucket: string;
  loggingRegion: string;

  // Features - Custom Email Templates
  customEmailsEnabled: boolean;
  emailSubjects: EmailSubjects;
  emailTemplates: EmailTemplates;

  // Credentials
  licenseKey: string;

  // Version - app and HPS image versions
  appVersion: string;
  hpsVersion: string;

  // Legacy chart version (deprecated)
  chartVersion: string;
}

type WizardAction =
  | { type: "SET_STEP"; step: number }
  | { type: "SET_NAME"; name: string }
  | { type: "SET_INFRA_MODE"; mode: "existing" | "provision" }
  | { type: "SET_PROVIDER"; provider: CloudProvider }
  | { type: "SET_REGION"; region: string }
  | { type: "SET_CLUSTER_NAME"; clusterName: string }
  | { type: "SET_GCP_PROJECT"; projectId: string }
  | { type: "SET_AZURE_RG"; resourceGroup: string }
  | { type: "SET_DOMAIN"; domain: string }
  | { type: "SET_ADMIN_EMAIL"; email: string }
  | { type: "SET_TLS_EMAIL"; email: string }
  | { type: "SET_DNS_PROVIDER"; provider: DnsProvider }
  | { type: "SET_DNS_AUTO_MANAGE"; autoManage: boolean }
  | { type: "SET_EXISTING_EXTERNAL_DNS"; exists: boolean }
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
  | { type: "SET_TIER"; tier: PerformanceTier }
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
  | { type: "SET_MONITORING"; enabled: boolean }
  | { type: "SET_PROMETHEUS_REMOTE_WRITE"; url: string }
  | { type: "SET_LOGGING_SINK"; sink: LoggingSink }
  | {
      type: "SET_LOGGING_CONFIG";
      config: Partial<Pick<WizardState, "loggingBucket" | "loggingRegion">>;
    }
  | { type: "SET_CUSTOM_EMAILS_ENABLED"; enabled: boolean }
  | { type: "SET_EMAIL_SUBJECTS"; subjects: Partial<EmailSubjects> }
  | { type: "SET_EMAIL_TEMPLATES"; templates: Partial<EmailTemplates> }
  | { type: "SET_LICENSE_KEY"; key: string }
  | { type: "SET_APP_VERSION"; appVersion: string; hpsVersion: string }
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
    infrastructureMode: profile?.infrastructureMode ?? null,
    provider: profile?.provider ?? null,
    region: profile?.region ?? "",
    clusterName: profile?.clusterName ?? "",
    gcpProjectId: "",
    azureResourceGroup: "",

    // Domain & Email - pre-populate from profile
    domain: "", // Domain is intentionally left empty - user should enter unique domain per deployment
    adminEmail: profile?.adminEmail ?? "",
    tlsEmail: profile?.tlsEmail ?? "",

    // DNS Configuration - pre-populate from profile
    dnsProvider: profile?.dnsProvider ?? "other",
    dnsAutoManage: false,
    existingExternalDns: false,

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
    supabaseJwtSecret: "",
    supabaseDbPassword: "",
    supabaseDashboardUser: "supabase",
    supabaseDashboardPass: "",

    // Performance - pre-populate from profile
    tier: profile?.tier ?? null,

    // Features - AI - pre-populate from profile
    aiEnabled: !!profile?.openaiApiKey,
    openaiApiKey: profile?.openaiApiKey ?? "",

    // Features - SSO - pre-populate from profile
    ssoEnabled: !!profile?.ssoProvider,
    ssoProvider: profile?.ssoProvider ?? null,
    ssoUrl: profile?.ssoUrl ?? "",
    ssoClientId: profile?.ssoClientId ?? "",
    ssoClientSecret: profile?.ssoClientSecret ?? "",

    // Features - Monitoring
    monitoringEnabled: false,
    prometheusRemoteWriteUrl: "",

    // Features - Logging
    loggingSink: "console", // Default to console only
    loggingBucket: "",
    loggingRegion: "",

    // Features - Custom Email Templates
    customEmailsEnabled: false,
    emailSubjects: { ...DEFAULT_EMAIL_SUBJECTS },
    emailTemplates: {
      invite: "",
      confirmation: "",
      recovery: "",
      emailChange: "",
    },

    // Credentials - pre-populate from profile
    licenseKey: profile?.licenseKey ?? "",

    // Version
    appVersion: "",
    hpsVersion: "",
    chartVersion: "",
  };
}

// Default initial state (for backwards compatibility)
const initialState: WizardState = getInitialState();

function wizardReducer(state: WizardState, action: WizardAction): WizardState {
  switch (action.type) {
    case "SET_STEP":
      return { ...state, step: action.step };
    case "SET_NAME":
      return { ...state, name: action.name };
    case "SET_INFRA_MODE":
      return { ...state, infrastructureMode: action.mode };
    case "SET_PROVIDER":
      return { ...state, provider: action.provider, region: "" };
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
    case "SET_TLS_EMAIL":
      return { ...state, tlsEmail: action.email };
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
    case "SET_EXISTING_EXTERNAL_DNS":
      return { ...state, existingExternalDns: action.exists };
    case "SET_SMTP":
      return { ...state, ...action.config };
    case "SET_DATABASE_TYPE":
      return { ...state, databaseType: action.dbType };
    case "SET_SUPABASE_CONFIG":
      return { ...state, ...action.config };
    case "SET_SUPABASE_SELF_HOSTED":
      return { ...state, ...action.config };
    case "SET_TIER":
      return { ...state, tier: action.tier };
    case "SET_AI_ENABLED":
      return { ...state, aiEnabled: action.enabled };
    case "SET_OPENAI_KEY":
      return { ...state, openaiApiKey: action.key };
    case "SET_SSO_ENABLED":
      return { ...state, ssoEnabled: action.enabled };
    case "SET_SSO_CONFIG":
      return { ...state, ...action.config };
    case "SET_MONITORING":
      return { ...state, monitoringEnabled: action.enabled };
    case "SET_PROMETHEUS_REMOTE_WRITE":
      return { ...state, prometheusRemoteWriteUrl: action.url };
    case "SET_LOGGING_SINK":
      // Reset bucket/region if switching to console
      return {
        ...state,
        loggingSink: action.sink,
        loggingBucket: action.sink === "console" ? "" : state.loggingBucket,
        loggingRegion: action.sink === "console" ? "" : state.loggingRegion,
      };
    case "SET_LOGGING_CONFIG":
      return { ...state, ...action.config };
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
    case "SET_APP_VERSION":
      return {
        ...state,
        appVersion: action.appVersion,
        hpsVersion: action.hpsVersion,
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
  toConfig: () => DeploymentConfig | null;
  skipToStep: (stepId: string) => void;
  profile: ProfileConfig | null;
  /** Suggests a domain based on the profile's domain suffix and deployment name */
  suggestDomain: (name: string) => string;
}

const WizardContext = createContext<WizardContextValue | null>(null);

interface WizardProviderProps {
  children: ReactNode;
  initialName?: string;
  profile?: ProfileConfig | null;
}

export function WizardProvider({
  children,
  initialName,
  profile,
}: WizardProviderProps) {
  // Initialize state with profile values for pre-population
  const [state, dispatch] = useReducer(wizardReducer, {
    ...getInitialState(profile),
    name: initialName || "",
  });

  const toConfig = (): DeploymentConfig | null => {
    // Validate required fields
    if (
      !state.name ||
      !state.domain ||
      !state.adminEmail ||
      !state.tlsEmail ||
      !state.licenseKey
    ) {
      return null;
    }

    // Validate SMTP
    if (
      !state.smtpHost ||
      !state.smtpUser ||
      !state.smtpPass ||
      !state.smtpFrom
    ) {
      return null;
    }

    // Validate database config
    if (state.databaseType === "supabase-cloud") {
      if (
        !state.supabaseUrl ||
        !state.supabaseAnonKey ||
        !state.supabaseServiceKey
      ) {
        return null;
      }
    } else if (state.databaseType === "self-hosted") {
      if (!state.supabaseDbPassword) {
        return null;
      }
    }

    // Validate logging sink config
    if (state.loggingSink !== "console" && !state.loggingBucket) {
      return null;
    }

    return {
      name: state.name,
      infrastructure: {
        mode: state.infrastructureMode || "existing",
        provider: state.provider || undefined,
        region: state.region || undefined,
        clusterName: state.clusterName || undefined,
        gcpProjectId: state.gcpProjectId || undefined,
        azureResourceGroup: state.azureResourceGroup || undefined,
      },
      domain: state.domain,
      adminEmail: state.adminEmail,
      tlsEmail: state.tlsEmail,
      dns: {
        provider: state.dnsProvider,
        autoManage: state.dnsAutoManage,
        existingExternalDns: state.existingExternalDns || undefined,
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
        supabaseProjectRef: state.supabaseProjectRef || undefined,
        supabaseJwtSecret: state.supabaseJwtSecret || undefined,
        supabaseDbPassword: state.supabaseDbPassword || undefined,
        supabaseDashboardUser: state.supabaseDashboardUser || undefined,
        supabaseDashboardPass: state.supabaseDashboardPass || undefined,
      },
      tier: state.tier || "small",
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
          enabled: state.monitoringEnabled,
          remoteWriteUrl: state.prometheusRemoteWriteUrl || undefined,
        },
        logging: {
          sink: state.loggingSink,
          bucket: state.loggingBucket || undefined,
          region: state.loggingRegion || undefined,
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
      appVersion: state.appVersion || undefined,
      hpsVersion: state.hpsVersion || undefined,
      chartVersion: state.chartVersion || undefined,
    };
  };

  const skipToStep = (stepId: string) => {
    // For conditional step skipping
    const stepIndex = [
      "mode",
      "cloud",
      "domain",
      "smtp",
      "database",
      "database-creds",
      "tier",
      "features",
      "feature-config",
      "credentials",
      "review",
    ].indexOf(stepId);
    if (stepIndex >= 0) {
      dispatch({ type: "SET_STEP", step: stepIndex });
    }
  };

  /**
   * Suggests a domain based on the profile's domain suffix and a deployment name.
   * e.g., if profile has domainSuffix ".example.com" and name is "staging",
   * suggests "staging.example.com"
   */
  const suggestDomain = (name: string): string => {
    if (!profile?.domainSuffix || !name) return "";
    // Remove leading dot if present and combine with name
    const suffix = profile.domainSuffix.startsWith(".")
      ? profile.domainSuffix.slice(1)
      : profile.domainSuffix;
    return `${name}.${suffix}`;
  };

  return (
    <WizardContext.Provider
      value={{
        state,
        dispatch,
        toConfig,
        skipToStep,
        profile: profile ?? null,
        suggestDomain,
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
