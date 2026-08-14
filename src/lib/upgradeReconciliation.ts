import type { DeploymentConfig } from "../types/index.js";
import { secretModeForConfig } from "./deploySequence.js";

export interface UpgradeReconciliationOptions {
  targetVersion: string;
  dryRun: boolean;
  /** Restore local desired files if a real atomic upgrade fails. */
  restoreOnFailure?: boolean;
}

export interface UpgradeReconciliationDeps<TSnapshot, TResult> {
  reloadConfig: () => Promise<DeploymentConfig>;
  captureSnapshot: (config: DeploymentConfig) => Promise<TSnapshot>;
  prepareArtifacts: (config: DeploymentConfig) => Promise<void>;
  regenerateValues: (config: DeploymentConfig) => Promise<void>;
  persistConfig: (config: DeploymentConfig) => Promise<void>;
  ensureNamespace: (config: DeploymentConfig) => Promise<void>;
  applyKubernetesSecrets: (config: DeploymentConfig) => Promise<void>;
  setupExternalSecrets: (config: DeploymentConfig) => Promise<void>;
  runHelm: (config: DeploymentConfig) => Promise<TResult>;
  restoreSnapshot: (snapshot: TSnapshot) => Promise<void>;
}

export interface UpgradeReconciliationResult<TResult> {
  config: DeploymentConfig;
  helmResult: TResult;
}

/** Return a new desired config without mutating the freshly loaded source. */
export function withUpgradeVersion(
  config: DeploymentConfig,
  targetVersion: string,
): DeploymentConfig {
  return { ...config, version: targetVersion };
}

/**
 * Run the shared app/chart upgrade reconciliation in its required order:
 * reload desired config, prepare mirrored artifacts, regenerate all managed
 * values, persist the selected app version, materialize secrets, then invoke
 * Helm. Dry-runs exercise the same local reconciliation and Helm rendering but
 * never write secrets and always restore the original config and values.
 */
export async function runUpgradeReconciliation<TSnapshot, TResult>(
  options: UpgradeReconciliationOptions,
  deps: UpgradeReconciliationDeps<TSnapshot, TResult>,
): Promise<UpgradeReconciliationResult<TResult>> {
  const desiredConfig = await deps.reloadConfig();
  const targetConfig = withUpgradeVersion(
    desiredConfig,
    options.targetVersion,
  );
  const snapshot = options.dryRun || options.restoreOnFailure
    ? await deps.captureSnapshot(desiredConfig)
    : undefined;
  let operationError: unknown;

  try {
    await deps.prepareArtifacts(targetConfig);
    await deps.regenerateValues(targetConfig);
    await deps.persistConfig(targetConfig);

    if (!options.dryRun) {
      await deps.ensureNamespace(targetConfig);
      if (secretModeForConfig(targetConfig) === "eso") {
        await deps.setupExternalSecrets(targetConfig);
      } else {
        await deps.applyKubernetesSecrets(targetConfig);
      }
    }

    const helmResult = await deps.runHelm(targetConfig);
    return { config: targetConfig, helmResult };
  } catch (error) {
    operationError = error;
    throw error;
  } finally {
    const shouldRestore =
      options.dryRun ||
      (options.restoreOnFailure === true && operationError !== undefined);
    if (snapshot !== undefined && shouldRestore) {
      try {
        await deps.restoreSnapshot(snapshot);
      } catch (restoreError) {
        if (operationError === undefined) throw restoreError;
        const operationMessage =
          operationError instanceof Error
            ? operationError.message
            : String(operationError);
        const restoreMessage =
          restoreError instanceof Error
            ? restoreError.message
            : String(restoreError);
        throw new Error(
          `${operationMessage}\n\nThe upgrade also failed to restore the local config/values snapshot: ${restoreMessage}`,
          { cause: operationError },
        );
      }
    }
  }
}
