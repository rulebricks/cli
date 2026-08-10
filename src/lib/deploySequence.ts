// Ordered install sequence shared by every deploy path. Values are generated
// and validated first, then the secrets backend is materialized so the
// chart's secretRef seams resolve before Helm installs:
//   - eso:    seed the cloud secrets manager, bind the ESO reader identity,
//             apply SecretStore/ExternalSecret manifests, and wait for every
//             ExternalSecret to reach SecretSynced=True.
//   - k8s:    apply plain in-cluster Secrets with kubectl (dev/test).
//   - inline: secrets live in the generated values; nothing to pre-create.

import type { DeploymentConfig, DeploymentState } from "../types/index.js";

export type SecretMode = "eso" | "k8s" | "inline";

/** Map the config's secrets backend to the deploy-time secret mode. */
export function secretModeForConfig(config: DeploymentConfig): SecretMode {
  const backend = config.secrets?.backend ?? "cluster";
  return backend === "cluster" ? "k8s" : "eso";
}

export interface DnsTlsResumeInput {
  forceFull: boolean;
  valuesExist: boolean;
  releaseStatus?: string;
  deploymentStatus?: DeploymentState["status"];
  tlsEnabled: boolean;
  configModifiedAtMs?: number;
  valuesModifiedAtMs?: number;
}

/**
 * Decide whether a deploy can safely skip installation and resume at manual
 * DNS validation. Fail closed whenever the local files or Helm release do not
 * prove that the existing install matches the current config.
 */
export function shouldResumeDnsTlsSetup(input: DnsTlsResumeInput): boolean {
  if (input.forceFull || !input.valuesExist) return false;
  if (input.releaseStatus !== "deployed") return false;
  if (
    input.configModifiedAtMs === undefined ||
    input.valuesModifiedAtMs === undefined ||
    !Number.isFinite(input.configModifiedAtMs) ||
    !Number.isFinite(input.valuesModifiedAtMs) ||
    input.configModifiedAtMs > input.valuesModifiedAtMs
  ) {
    return false;
  }

  return input.deploymentStatus === "waiting-dns" || !input.tlsEnabled;
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
