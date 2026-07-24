// Ordered install sequence shared by every deploy path. Values are generated
// and validated first, then the secrets backend is materialized so the
// chart's secretRef seams resolve before Helm installs:
//   - eso:    seed the cloud secrets manager, bind the ESO reader identity,
//             apply SecretStore/ExternalSecret manifests, and wait for every
//             ExternalSecret to reach SecretSynced=True.
//   - k8s:    apply plain in-cluster Secrets with kubectl (dev/test).
//   - inline: secrets live in the generated values; nothing to pre-create.

import type { DeploymentConfig } from "../types/index.js";

export type SecretMode = "eso" | "k8s" | "inline";

/** Map the config's secrets backend to the deploy-time secret mode. */
export function secretModeForConfig(config: DeploymentConfig): SecretMode {
  const backend = config.secrets?.backend ?? "cluster";
  return backend === "cluster" ? "k8s" : "eso";
}

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
  /** Seed + bind + apply + gate for the External Secrets Operator path. */
  setupExternalSecrets: () => Promise<void>;
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
  } else if (options.secretMode === "eso") {
    await deps.ensureNamespace();
    await deps.setupExternalSecrets();
  }
  await deps.installChart();
}
