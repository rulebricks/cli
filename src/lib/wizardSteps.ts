export type WizardStepId =
  | "cloud"
  | "domain"
  | "smtp"
  | "database"
  | "database-creds"
  | "external-services"
  | "storage"
  | "observability"
  | "features"
  | "feature-config"
  | "version"
  | "review";

export interface WizardStepState {
  databaseType: string | null;
  aiEnabled: boolean;
  ssoEnabled: boolean;
  clickStackEnabled: boolean;
  metricsExportEnabled: boolean;
  tracingEnabled: boolean;
  appLogsEnabled: boolean;
  loggingSink: string;
  customEmailsEnabled: boolean;
}

export function getActiveWizardSteps(
  state: WizardStepState,
  mode: "create" | "redeploy",
): WizardStepId[] {
  const steps: WizardStepId[] = mode === "redeploy" ? [] : ["cloud"];

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
    state.loggingSink !== "console" ||
    state.customEmailsEnabled
  ) {
    steps.push("feature-config");
  }

  steps.push("version", "review");

  return steps;
}
