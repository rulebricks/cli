import React, { useState, useCallback, useEffect } from "react";
import { Box, Text, useApp } from "ink";
import chalk from "chalk";
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
  TlsStep,
  ExternalServicesStep,
  SecretsStep,
  FeatureConfigStep,
  VersionStep,
  ReviewStep,
} from "../components/Wizard/steps/index.js";
import {
  WizardShell,
  ProgressHeader,
  ThemeProvider,
  useTheme,
  THEMES,
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
  buildConfigureValues,
  generateHelmValues,
} from "../lib/helmValues.js";
import { resolveImageCatalog } from "../lib/imageCatalog.js";
import { assertValidHelmValues } from "../lib/validateValues.js";
import { secretModeForConfig } from "../lib/deploySequence.js";
import { ProfileConfig } from "../types/index.js";
import {
  getActiveWizardSteps,
  getConfigureSections,
  WIZARD_STEP_ORDER,
  WizardStepId,
} from "../lib/wizardSteps.js";
import { SectionMenu } from "../components/Wizard/SectionMenu.js";

/** Outcome of a saved wizard run, printed to the terminal after the
 * alternate-screen UI exits. */
export interface WizardCompletion {
  mode: "create" | "configure";
  name: string;
  domain: string;
}

/**
 * Print the post-wizard summary to the regular terminal buffer. Called by the
 * command action after the full-screen UI has been torn down, so this is the
 * only trace the wizard leaves in scrollback.
 */
export function printWizardCompletion(completion: WizardCompletion): void {
  const colors = THEMES.init;
  const accent = chalk.hex(colors.accent);
  const muted = chalk.hex(colors.muted);
  const success = chalk.hex(colors.success);
  const deployCmd = accent(`rulebricks deploy ${completion.name}`);

  const lines = [
    "",
    ...LOGO_LINES.map((line) => accent(line)),
    "",
    success.bold(
      completion.mode === "configure"
        ? "✓ Configuration updated!"
        : "✓ Configuration saved successfully!",
    ),
    "",
    `  Deployment name: ${accent.bold(completion.name)}`,
    muted(
      `  Configuration stored in ~/.rulebricks/deployments/${completion.name}/`,
    ),
    "",
    "  Next steps:",
    ...(completion.mode === "configure"
      ? [muted(`    Run ${deployCmd} to apply your changes`)]
      : [
          muted(`    1. Run ${deployCmd} to deploy`),
          muted("    2. Configure your DNS records when prompted"),
          muted(
            `    3. Access Rulebricks at ${accent(`https://${completion.domain}`)}`,
          ),
        ]),
    "",
  ];
  console.log(lines.join("\n"));
}

interface InitWizardProps {
  initialName?: string;
  initialState?: WizardState;
  mode?: "create" | "configure";
  onSaveComplete?: (completion: WizardCompletion) => void;
  profile?: ProfileConfig | null;
}

// Define step IDs for conditional navigation
type StepId = WizardStepId;

// In configure mode the section menu is the hub between edits.
type ControllerStep = StepId | "menu";

// Sections whose completion must flow into a dependent step (when active)
// before returning to the configure menu, so required follow-up values are
// collected just like in the linear create wizard.
const CONFIGURE_STEP_CHAIN: Partial<Record<StepId, StepId>> = {
  database: "database-creds",
  features: "feature-config",
};

const STEP_INFO: Record<StepId, { title: string; description: string }> = {
  cloud: { title: "Cloud Provider", description: "Select your cloud provider" },
  domain: { title: "Domain & DNS", description: "Configure your domain and DNS" },
  smtp: { title: "Email", description: "Configure email delivery" },
  database: { title: "Database", description: "Choose your database setup" },
  "database-creds": {
    title: "Database Credentials",
    description: "Configure database access",
  },
  "external-services": {
    title: "External Services",
    description: "Use managed Redis/Kafka (optional)",
  },
  secrets: {
    title: "Secrets",
    description: "Link your secrets platform (External Secrets Operator)",
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
  tls: {
    title: "Certificates",
    description: "Choose how TLS certificates are issued",
  },
  version: {
    title: "License & Version",
    description: "Enter license and select version",
  },
  review: { title: "Review & Save", description: "Review your configuration" },
};

interface WizardStepControllerProps {
  mode: "create" | "configure";
  onSaveComplete?: (completion: WizardCompletion) => void;
}

function WizardStepController({
  mode,
  onSaveComplete,
}: WizardStepControllerProps) {
  const { state, toConfig, configIssues } = useWizard();
  const { exit } = useApp();
  const { colors } = useTheme();
  const [currentStep, setCurrentStep] = useState<ControllerStep>(
    mode === "configure" ? "menu" : "cloud",
  );
  // Sections the user has walked through this session (configure mode only).
  const [editedSections, setEditedSections] = useState<ReadonlySet<StepId>>(
    () => new Set(),
  );
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

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
    if (!pendingNav) return;

    if (mode === "configure") {
      const nav = pendingNav;
      setPendingNav(null);
      if (currentStep === "menu") return;

      if (nav === "back") {
        // Esc backs out of a section without treating it as updated.
        setNavDirection("forward");
        setCurrentStep("menu");
        return;
      }

      setEditedSections((prev) => new Set(prev).add(currentStep));
      const dependent = CONFIGURE_STEP_CHAIN[currentStep];
      setNavDirection("forward");
      setCurrentStep(
        dependent && getActiveSteps().includes(dependent) ? dependent : "menu",
      );
      return;
    }

    const steps = getActiveSteps();
    const currentIndex = steps.indexOf(currentStep as StepId);

    if (currentIndex === -1) {
      // The current step fell out of the active list (an earlier answer
      // changed), so land on the nearest surviving step in the requested
      // direction instead of freezing.
      const position = WIZARD_STEP_ORDER.indexOf(currentStep as StepId);
      const fallback =
        pendingNav === "next"
          ? steps.find((s) => WIZARD_STEP_ORDER.indexOf(s) > position)
          : [...steps]
              .reverse()
              .find((s) => WIZARD_STEP_ORDER.indexOf(s) < position);
      setNavDirection(pendingNav === "next" ? "forward" : "back");
      setCurrentStep(
        fallback ?? steps[pendingNav === "next" ? steps.length - 1 : 0],
      );
    } else if (pendingNav === "next" && currentIndex < steps.length - 1) {
      setNavDirection("forward");
      setCurrentStep(steps[currentIndex + 1]);
    } else if (pendingNav === "back" && currentIndex > 0) {
      setNavDirection("back");
      setCurrentStep(steps[currentIndex - 1]);
    }

    setPendingNav(null);
  }, [pendingNav, currentStep, getActiveSteps, mode]);

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
        if (mode === "configure") {
          await saveConfigureValues(config);
          await saveDeploymentConfig(config);
          const profileData = extractProfileFromConfig(config);
          await updateProfile(profileData);
          // The summary is printed to the regular buffer by the command
          // action once the full-screen UI has been restored.
          onSaveComplete?.({
            mode: "configure",
            name: config.name,
            domain: config.domain,
          });
          exit();
          return;
        }

        setError(
          `Deployment "${config.name}" already exists. Choose a different name.`,
        );
        setSaving(false);
        return;
      }

      await saveDeploymentConfig(config);
      // Ref-based generation keeps plaintext secrets out of the generated
      // values; deploy materializes the referenced Kubernetes Secrets before
      // Helm runs (ESO sync from the configured secrets backend, or direct
      // kubectl apply for the "cluster" backend).
      await generateHelmValues(config, {
        secretMode: secretModeForConfig(config),
      });

      // Save configuration values to profile for future deployments
      const profileData = extractProfileFromConfig(config);
      await updateProfile(profileData);

      onSaveComplete?.({
        mode: "create",
        name: config.name,
        domain: config.domain,
      });
      exit();
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Failed to save configuration",
      );
      setSaving(false);
    }
  }, [toConfig, configIssues, state, exit, onSaveComplete, mode]);

  async function saveConfigureValues(config: ReturnType<typeof toConfig>) {
    if (!config) return;
    const existingValues = (await loadHelmValues(config.name)) ?? {};
    // Live image tags from the chart manifest (falls back to the bundled
    // snapshot offline; the next deploy re-resolves against the chart).
    const images = await resolveImageCatalog(config.chartVersion);
    const mergedValues = buildConfigureValues(existingValues, config, { images });
    // Guardrail: a merge with stale manual edits must still satisfy the chart.
    assertValidHelmValues(mergedValues);
    await saveHelmValues(config.name, mergedValues);
  }

  // Get step progress
  const steps = getActiveSteps();
  const stepNumber = Math.max(1, steps.indexOf(currentStep as StepId) + 1);
  const totalSteps = steps.length;
  const stepInfo = currentStep === "menu" ? null : STEP_INFO[currentStep];

  // Saving state - rendered inside the stable shell
  if (saving) {
    return (
      <WizardShell title="Rulebricks Configuration">
        <Box flexDirection="column" paddingTop={1}>
          <Text color={colors.accent}>⧗ Saving configuration...</Text>
        </Box>
      </WizardShell>
    );
  }

  // Error state - rendered inside the stable shell
  if (error) {
    return (
      <WizardShell title="Rulebricks Configuration">
        <Box flexDirection="column" paddingTop={1}>
          <Text color={colors.error} bold>
            ✗ Error
          </Text>
          <Text color={colors.error}>{error}</Text>
          <Box marginTop={1}>
            <Text color={colors.muted}>Press Ctrl+C to exit and try again</Text>
          </Box>
        </Box>
      </WizardShell>
    );
  }

  // Render current step
  const renderStep = () => {
    if (currentStep === "menu") {
      return (
        <SectionMenu
          sections={getConfigureSections(state).map((id) => ({
            id,
            title: STEP_INFO[id].title,
            description: STEP_INFO[id].description,
            edited: editedSections.has(id),
          }))}
          onSelect={(id) => {
            setNavDirection("forward");
            setCurrentStep(id);
          }}
          onReview={() => {
            setNavDirection("forward");
            setCurrentStep("review");
          }}
          onExit={() => exit()}
        />
      );
    }

    const nav = { onComplete: goNext, onBack: goBack };
    switch (currentStep) {
      case "cloud":
        return <CloudProviderStep {...nav} entryDirection={navDirection} />;
      case "domain":
        return <DomainStep {...nav} entryDirection={navDirection} />;
      case "smtp":
        return <SMTPStep {...nav} entryDirection={navDirection} />;
      case "database":
        return <DatabaseStep {...nav} entryDirection={navDirection} />;
      case "database-creds":
        return (
          <SupabaseCredentialsStep {...nav} entryDirection={navDirection} />
        );
      case "external-services":
        return <ExternalServicesStep {...nav} entryDirection={navDirection} />;
      case "secrets":
        return <SecretsStep {...nav} entryDirection={navDirection} />;
      case "features":
        return <FeaturesStep {...nav} />;
      case "storage":
        return <StorageStep {...nav} entryDirection={navDirection} />;
      case "observability":
        return <ObservabilityStep {...nav} entryDirection={navDirection} />;
      case "feature-config":
        return <FeatureConfigStep {...nav} entryDirection={navDirection} />;
      case "tls":
        return <TlsStep {...nav} entryDirection={navDirection} />;
      case "version":
        return <VersionStep {...nav} entryDirection={navDirection} />;
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

  const header =
    mode === "configure" ? (
      // Step counts are meaningless when hopping between sections from the
      // menu, so show just the section title while editing.
      stepInfo && (
        <Box marginBottom={1}>
          <Text color={colors.muted}>
            Updating: <Text color="white">{stepInfo.title}</Text>
          </Text>
        </Box>
      )
    ) : (
      <ProgressHeader
        currentStep={stepNumber}
        totalSteps={totalSteps}
        stepTitle={stepInfo?.title || "Complete"}
      />
    );

  return (
    <WizardShell title="Rulebricks Configuration" header={header}>
      {renderStep()}
    </WizardShell>
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
        <WizardShell title="Rulebricks Configuration">
          <Box paddingTop={1}>
            <Text>Loading...</Text>
          </Box>
        </WizardShell>
      </ThemeProvider>
    );
  }

  return (
    <ThemeProvider theme="init">
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
