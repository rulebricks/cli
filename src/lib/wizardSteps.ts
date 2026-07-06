export const WIZARD_STEP_ORDER = [
  "cloud",
  "domain",
  "smtp",
  "database",
  "database-creds",
  "external-services",
  "storage",
  "observability",
  "features",
  "feature-config",
  "version",
  "review",
] as const;

export type WizardStepId = (typeof WIZARD_STEP_ORDER)[number];

export interface WizardStepState {
  databaseType: string | null;
  aiEnabled: boolean;
  ssoEnabled: boolean;
  clickStackEnabled: boolean;
  metricsExportEnabled: boolean;
  tracingEnabled: boolean;
  appLogsEnabled: boolean;
  valkeyAdminEnabled: boolean;
  loggingSink: string;
  customEmailsEnabled: boolean;
}

export function getActiveWizardSteps(
  state: WizardStepState,
  mode: "create" | "configure",
): WizardStepId[] {
  const steps: WizardStepId[] = mode === "configure" ? [] : ["cloud"];

  steps.push("domain", "smtp", "database");

  if (state.databaseType === "self-hosted") {
    steps.push("database-creds");
  }

  steps.push("external-services");
  steps.push("storage");
  steps.push("observability");
  steps.push("features");

  if (
    state.aiEnabled ||
    state.ssoEnabled ||
    (!state.clickStackEnabled && state.metricsExportEnabled) ||
    (!state.clickStackEnabled && state.tracingEnabled) ||
    (!state.clickStackEnabled && state.appLogsEnabled) ||
    state.valkeyAdminEnabled ||
    state.loggingSink !== "console" ||
    state.customEmailsEnabled
  ) {
    steps.push("feature-config");
  }

  steps.push("version", "review");

  return steps;
}

/**
 * Sections offered on the configure command's entry menu: every active
 * wizard step except "review", which the menu exposes as its own
 * "Review & save changes" action.
 */
export function getConfigureSections(state: WizardStepState): WizardStepId[] {
  return getActiveWizardSteps(state, "configure").filter(
    (step) => step !== "review",
  );
}
