import React, { useState, useCallback, useEffect, useRef } from "react";
import { Box, Text, useApp, useStdout } from "ink";
import {
  WizardProvider,
  WizardState,
  useWizard,
} from "../components/Wizard/WizardContext.js";
import {
  CloudProviderStep,
  DomainStep,
  SMTPStep,
  DatabaseStep,
  SupabaseCredentialsStep,
  FeaturesStep,
  StorageStep,
  ObservabilityStep,
  ExternalServicesStep,
  FeatureConfigStep,
  VersionStep,
  ReviewStep,
} from "../components/Wizard/steps/index.js";
import {
  AppShell,
  ProgressHeader,
  ThemeProvider,
  useTheme,
  Logo,
  LOGO_LINES,
  CommandApprovalProvider,
} from "../components/common/index.js";
import {
  saveDeploymentConfig,
  deploymentExists,
  loadHelmValues,
  loadProfile,
  saveHelmValues,
  updateProfile,
  extractProfileFromConfig,
} from "../lib/config.js";
import {
  buildHelmValues,
  generateHelmValues,
  mergeHelmValues,
} from "../lib/helmValues.js";
import { assertValidHelmValues } from "../lib/validateValues.js";
import { ProfileConfig } from "../types/index.js";
import {
  getActiveWizardSteps,
  WizardStepId,
} from "../lib/wizardSteps.js";

interface InitWizardProps {
  initialName?: string;
  initialState?: WizardState;
  mode?: "create" | "redeploy";
  onSaveComplete?: () => void;
  profile?: ProfileConfig | null;
}

// Define step IDs for conditional navigation
type StepId = WizardStepId;

const STEP_INFO: Record<StepId, { title: string; description: string }> = {
  cloud: { title: "Cloud Provider", description: "Select your cloud provider" },
  domain: { title: "Domain & DNS", description: "Configure your domain and DNS" },
  smtp: { title: "Email (SMTP)", description: "Configure email delivery" },
  database: { title: "Database", description: "Choose your database setup" },
  "database-creds": {
    title: "Database Credentials",
    description: "Configure database access",
  },
  "external-services": {
    title: "External Services",
    description: "Use managed Redis/Kafka (optional)",
  },
  features: {
    title: "Optional Features",
    description: "Enable additional features",
  },
  storage: {
    title: "Storage & Backups",
    description: "Configure object storage and database backups",
  },
  observability: {
    title: "Observability",
    description: "Choose built-in ClickStack or export to your own systems",
  },
  "feature-config": {
    title: "Feature Settings",
    description: "Configure enabled features",
  },
  version: {
    title: "License & Version",
    description: "Enter license and select version",
  },
  review: { title: "Review & Save", description: "Review your configuration" },
};

interface WizardStepControllerProps {
  mode: "create" | "redeploy";
  onSaveComplete?: () => void;
}

function WizardStepController({
  mode,
  onSaveComplete,
}: WizardStepControllerProps) {
  const { state, dispatch, toConfig, configIssues } = useWizard();
  const { exit } = useApp();
  const { write } = useStdout();
  const { colors } = useTheme();
  const [currentStep, setCurrentStep] = useState<StepId>(
    mode === "redeploy" ? "domain" : "cloud",
  );
  const [saving, setSaving] = useState(false);
  const [complete, setComplete] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Clear terminal when transitioning to completion screen
  useEffect(() => {
    if (complete) {
      // Clear terminal using ANSI escape codes
      write("\x1B[2J\x1B[0;0H");
    }
  }, [complete, write]);

  // Track pending navigation to handle React's async state updates
  const [pendingNav, setPendingNav] = useState<"next" | "back" | null>(null);
  // Direction of the last navigation, so multi-substep steps can resume at their
  // end when the user navigates back into them (e.g. Esc from the Storage step).
  const [navDirection, setNavDirection] = useState<"forward" | "back">(
    "forward",
  );

  // Get list of active steps based on config
  const getActiveSteps = useCallback((): StepId[] => {
    return getActiveWizardSteps(state, mode);
  }, [
    mode,
    state.databaseType,
    state.aiEnabled,
    state.ssoEnabled,
    state.clickStackEnabled,
    state.metricsExportEnabled,
    state.tracingEnabled,
    state.appLogsEnabled,
    state.valkeyAdminEnabled,
    state.loggingSink,
    state.customEmailsEnabled,
  ]);

  // Handle navigation after state updates - this ensures getActiveSteps has the latest state
  useEffect(() => {
    if (pendingNav) {
      const steps = getActiveSteps();
      const currentIndex = steps.indexOf(currentStep);

      if (pendingNav === "next" && currentIndex < steps.length - 1) {
        setNavDirection("forward");
        setCurrentStep(steps[currentIndex + 1]);
      } else if (pendingNav === "back" && currentIndex > 0) {
        setNavDirection("back");
        setCurrentStep(steps[currentIndex - 1]);
      }

      setPendingNav(null);
    }
  }, [pendingNav, currentStep, getActiveSteps]);

  // Request navigation - will be processed after React renders with updated state
  const goNext = useCallback(() => {
    setPendingNav("next");
  }, []);

  const goBack = useCallback(() => {
    setPendingNav("back");
  }, []);

  const handleSave = useCallback(async () => {
    const config = toConfig({
      nodeArchitecture: state.nodeArchitecture || undefined,
      arm64TolerationRequired:
        state.arm64TolerationRequired,
      storageClass: state.storageClass || undefined,
      storageProvisioner: state.storageProvisioner || undefined,
      schedulableNodeCount: state.schedulableNodeCount || undefined,
      totalCpuCores: state.totalCpuCores || undefined,
      totalMemoryGi: state.totalMemoryGi || undefined,
      eligibleCpuCores: state.eligibleCpuCores || undefined,
      eligibleMemoryGi: state.eligibleMemoryGi || undefined,
      totalPersistentStorageGi: state.totalPersistentStorageGi || undefined,
    });
    if (!config) {
      const issues = configIssues();
      setError(
        issues.length > 0
          ? `Configuration is incomplete:\n${issues.map((i) => `  • ${i}`).join("\n")}`
          : "Invalid configuration - please check all required fields",
      );
      return;
    }

    setSaving(true);
    try {
      if (await deploymentExists(config.name)) {
        if (mode === "redeploy") {
          await saveRedeployValues(config);
          await saveDeploymentConfig(config);
          const profileData = extractProfileFromConfig(config);
          await updateProfile(profileData);
          onSaveComplete?.();
          return;
        }

        setError(
          `Deployment "${config.name}" already exists. Choose a different name.`,
        );
        setSaving(false);
        return;
      }

      await saveDeploymentConfig(config);
      await generateHelmValues(config);

      // Save configuration values to profile for future deployments
      const profileData = extractProfileFromConfig(config);
      await updateProfile(profileData);

      setComplete(true);
      onSaveComplete?.();
      setTimeout(() => exit(), 4000);
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Failed to save configuration",
      );
      setSaving(false);
    }
  }, [toConfig, configIssues, state, exit, onSaveComplete, mode]);

  async function saveRedeployValues(config: ReturnType<typeof toConfig>) {
    if (!config) return;
    const existingValues = (await loadHelmValues(config.name)) ?? {};
    const generatedValues = buildHelmValues(config);
    const mergedValues = mergeHelmValues(existingValues, generatedValues);
    // Guardrail: a merge with stale manual edits must still satisfy the chart.
    assertValidHelmValues(mergedValues);
    await saveHelmValues(config.name, mergedValues);
  }

  // Get step progress
  const steps = getActiveSteps();
  const stepNumber = steps.indexOf(currentStep) + 1;
  const totalSteps = steps.length;
  const stepInfo = STEP_INFO[currentStep];

  // Completion screen
  if (complete) {
    return (
      <Box flexDirection="column">
        {/* Render logo directly (not via Static) after terminal clear */}
        <Box flexDirection="column" marginTop={1} marginBottom={2}>
          {LOGO_LINES.map((line, i) => (
            <Text key={i} color={colors.accent}>
              {line}
            </Text>
          ))}
        </Box>

        <Box flexDirection="column" paddingLeft={2}>
          <Box marginBottom={1}>
            <Text color={colors.success} bold>
              ✓ Configuration saved successfully!
            </Text>
          </Box>

          <Box flexDirection="column" marginBottom={1}>
            <Text>
              Deployment name:{" "}
              <Text color={colors.accent} bold>
                {state.name}
              </Text>
            </Text>
            <Text color={colors.muted}>
              Configuration stored in ~/.rulebricks/deployments/{state.name}/
            </Text>
          </Box>

          <Box flexDirection="column" marginTop={1}>
            <Text bold>Next steps:</Text>
            <Box marginLeft={2} flexDirection="column">
              <Text color={colors.muted}>
                1. Run{" "}
                <Text color={colors.accent}>
                  rulebricks deploy {state.name}
                </Text>{" "}
                to deploy
              </Text>
              <Text color={colors.muted}>
                2. Configure your DNS records when prompted
              </Text>
              <Text color={colors.muted}>
                3. Access Rulebricks at{" "}
                <Text color={colors.accent}>https://{state.domain}</Text>
              </Text>
            </Box>
          </Box>

          <Box marginTop={2}>
            <Text color={colors.muted} dimColor>
              Exiting in a moment...
            </Text>
          </Box>
        </Box>
      </Box>
    );
  }

  // Saving state - simple, without wrapper
  if (saving) {
    return (
      <Box flexDirection="column" paddingTop={1} paddingLeft={2}>
        <Text color={colors.accent}>⧗ Saving configuration...</Text>
      </Box>
    );
  }

  // Error state - simple, without wrapper
  if (error) {
    return (
      <Box flexDirection="column" paddingTop={1} paddingLeft={2}>
        <Text color={colors.error} bold>
          ✗ Error
        </Text>
        <Text color={colors.error}>{error}</Text>
        <Box marginTop={1}>
          <Text color={colors.muted}>Press Ctrl+C to exit and try again</Text>
        </Box>
      </Box>
    );
  }

  // Render current step
  const renderStep = () => {
    switch (currentStep) {
      case "cloud":
        return <CloudProviderStep onComplete={goNext} onBack={goBack} />;
      case "domain":
        return <DomainStep onComplete={goNext} onBack={goBack} />;
      case "smtp":
        return <SMTPStep onComplete={goNext} onBack={goBack} />;
      case "database":
        return <DatabaseStep onComplete={goNext} onBack={goBack} />;
      case "database-creds":
        return <SupabaseCredentialsStep onComplete={goNext} onBack={goBack} />;
      case "external-services":
        return <ExternalServicesStep onComplete={goNext} onBack={goBack} />;
      case "features":
        return <FeaturesStep onComplete={goNext} onBack={goBack} />;
      case "storage":
        return <StorageStep onComplete={goNext} onBack={goBack} />;
      case "observability":
        return <ObservabilityStep onComplete={goNext} onBack={goBack} />;
      case "feature-config":
        return (
          <FeatureConfigStep
            onComplete={goNext}
            onBack={goBack}
            entryDirection={navDirection}
          />
        );
      case "version":
        return <VersionStep onComplete={goNext} onBack={goBack} />;
      case "review":
        return (
          <ReviewStep
            onComplete={handleSave}
            onBack={goBack}
            allowEditName={mode === "create"}
          />
        );
      default:
        return null;
    }
  };

  return (
    <AppShell title="Rulebricks Configuration">
      <ProgressHeader
        currentStep={stepNumber}
        totalSteps={totalSteps}
        stepTitle={stepInfo?.title || "Complete"}
      />

      <Box marginTop={1}>{renderStep()}</Box>
    </AppShell>
  );
}

export function InitWizard({
  initialName,
  initialState,
  mode = "create",
  onSaveComplete,
  profile: providedProfile,
}: InitWizardProps) {
  const [profile, setProfile] = useState<ProfileConfig | null>(
    providedProfile ?? null,
  );
  const [profileLoaded, setProfileLoaded] = useState(!!providedProfile);

  // Load profile on mount if not provided
  useEffect(() => {
    if (!providedProfile) {
      loadProfile().then((loaded) => {
        setProfile(loaded);
        setProfileLoaded(true);
      });
    }
  }, [providedProfile]);

  // Show loading state while profile is being loaded
  if (!profileLoaded) {
    return (
      <ThemeProvider theme="init">
        <Logo />
        <Box paddingLeft={2}>
          <Text>Loading...</Text>
        </Box>
      </ThemeProvider>
    );
  }

  return (
    <ThemeProvider theme="init">
      <Logo />
      <CommandApprovalProvider>
        <WizardProvider
          initialName={initialName}
          initialState={initialState}
          profile={profile}
        >
          <WizardStepController mode={mode} onSaveComplete={onSaveComplete} />
        </WizardProvider>
      </CommandApprovalProvider>
    </ThemeProvider>
  );
}
