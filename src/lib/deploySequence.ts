// Ordered install sequence shared by every deploy path. Values are generated
// and validated first, then (in k8s secret mode) the namespace and Secrets are
// created so the chart's secretRef seams resolve before Helm installs.

export type SecretMode = "k8s" | "inline";

export interface InstallSequenceOptions {
  regenerateValues: boolean;
  tlsEnabled: boolean;
  secretMode: SecretMode;
}

export interface InstallSequenceDeps {
  generateValues: (tlsEnabled: boolean, secretMode: SecretMode) => Promise<void>;
  validateValues: () => Promise<void>;
  ensureNamespace: () => Promise<void>;
  applySecrets: () => Promise<void>;
  installChart: () => Promise<void>;
}

export async function runInstallSequence(
  options: InstallSequenceOptions,
  deps: InstallSequenceDeps,
): Promise<void> {
  if (options.regenerateValues) {
    await deps.generateValues(options.tlsEnabled, options.secretMode);
  }
  await deps.validateValues();
  if (options.secretMode === "k8s") {
    await deps.ensureNamespace();
    await deps.applySecrets();
  }
  await deps.installChart();
}
