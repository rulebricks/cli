import React, { useState, useCallback } from "react";
import { Box, Text, useApp, useInput } from "ink";
import {
  BorderBox,
  Spinner,
  StatusLine,
  ThemeProvider,
  useTheme,
  Logo,
} from "../components/common/index.js";
import {
  loadDeploymentConfig,
  loadDeploymentState,
  deleteDeployment,
  deploymentExists,
} from "../lib/config.js";
import { uninstallChart, getInstalledVersion } from "../lib/helm.js";
import { terraformDestroy, hasTerraformState } from "../lib/terraform.js";
import {
  deleteNamespace,
  deletePVCs,
  isClusterAccessible,
  namespaceExists,
  removeKedaFinalizers,
} from "../lib/kubernetes.js";
import {
  DeploymentConfig,
  DeploymentState,
  getNamespace,
  getReleaseName,
} from "../types/index.js";

interface DestroyCommandProps {
  name: string;
  cluster?: boolean; // Also destroy cloud infrastructure
  config?: boolean; // Also delete local config files
  force?: boolean;
}

type DestroyStep = "loading" | "confirm" | "destroying" | "complete" | "error";

interface StepStatus {
  helm: "pending" | "running" | "success" | "error" | "skipped";
  pvc: "pending" | "running" | "success" | "error" | "skipped";
  namespace: "pending" | "running" | "success" | "error" | "skipped";
  infrastructure: "pending" | "running" | "success" | "error" | "skipped";
  cleanup: "pending" | "running" | "success" | "error" | "skipped";
}

// Determine what was actually deployed based on cluster state
interface DeploymentScope {
  hasLocalFiles: boolean;
  hasHelmRelease: boolean; // Helm release exists in cluster (checked via helm list)
  hasNamespace: boolean; // Namespace exists in cluster
  hasInfrastructure: boolean; // Terraform infra was provisioned
  clusterAccessible: boolean; // Can we reach the cluster?
}

function DestroyCommandInner({
  name,
  cluster,
  config,
  force,
}: DestroyCommandProps) {
  const { exit } = useApp();
  const { colors } = useTheme();
  const [step, setStep] = useState<DestroyStep>("loading");
  const [deploymentConfig, setDeploymentConfig] =
    useState<DeploymentConfig | null>(null);
  const [state, setState] = useState<DeploymentState | null>(null);
  const [scope, setScope] = useState<DeploymentScope | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirmText, setConfirmText] = useState("");
  const [status, setStatus] = useState<StepStatus>({
    helm: "pending",
    pvc: "pending",
    namespace: "pending",
    infrastructure: "pending",
    cleanup: "pending",
  });

  // Load config and determine scope on mount
  React.useEffect(() => {
    (async () => {
      try {
        // Check if deployment exists
        const exists = await deploymentExists(name);
        if (!exists) {
          setError(`Deployment "${name}" not found`);
          setStep("error");
          return;
        }

        // Load config (may throw if corrupted)
        let cfg: DeploymentConfig | null = null;
        try {
          cfg = await loadDeploymentConfig(name);
          setDeploymentConfig(cfg);
        } catch {
          // Config might be corrupted or missing, that's OK for destroy
        }

        // Load state
        const st = await loadDeploymentState(name);
        setState(st);

        // Determine what was actually deployed
        const deploymentScope = await determineScope(name, cfg, st);
        setScope(deploymentScope);

        if (force) {
          setStep("destroying");
          runDestroy(cfg, st, deploymentScope);
        } else {
          setStep("confirm");
        }
      } catch (err) {
        setError(
          err instanceof Error ? err.message : "Failed to load deployment",
        );
        setStep("error");
      }
    })();
  }, [name, force]);

  useInput((input, key) => {
    if (step === "confirm") {
      if (key.return) {
        if (cluster && scope?.hasInfrastructure) {
          if (confirmText === "destroy-all") {
            setStep("destroying");
            runDestroy(deploymentConfig, state, scope!);
          }
        } else {
          setStep("destroying");
          runDestroy(deploymentConfig, state, scope!);
        }
      } else if (key.escape) {
        exit();
      } else if (key.backspace || key.delete) {
        setConfirmText((t) => t.slice(0, -1));
      } else if (input && !key.ctrl && !key.meta) {
        setConfirmText((t) => t + input);
      }
    } else if (step === "error") {
      if (key.escape || key.return) {
        exit();
      }
    }
  });

  const runDestroy = useCallback(
    async (
      cfg: DeploymentConfig | null,
      st: DeploymentState | null,
      deploymentScope: DeploymentScope,
    ) => {
      try {
        // Use namespace from state if available (backwards compat), otherwise compute from deployment name
        const namespace = st?.application?.namespace || getNamespace(name);
        const releaseName = getReleaseName(name);

        // Run cluster cleanup if cluster is accessible
        if (deploymentScope.clusterAccessible) {
          // Step 1: Uninstall Helm release (only if namespace exists - helm data is stored there)
          if (deploymentScope.hasHelmRelease && deploymentScope.hasNamespace) {
            setStatus((s) => ({ ...s, helm: "running" }));
            try {
              await uninstallChart(releaseName, namespace, { wait: false });
              setStatus((s) => ({ ...s, helm: "success" }));
            } catch {
              // Helm release might already be gone, continue anyway
              setStatus((s) => ({ ...s, helm: "error" }));
            }
          } else {
            // Skip if no helm release OR namespace is already gone
            setStatus((s) => ({ ...s, helm: "skipped" }));
          }

          // Step 2: Delete all PVCs in the namespace
          if (deploymentScope.hasNamespace) {
            setStatus((s) => ({ ...s, pvc: "running" }));
            try {
              await deletePVCs(namespace);
              setStatus((s) => ({ ...s, pvc: "success" }));
            } catch {
              // PVCs might not exist, continue anyway
              setStatus((s) => ({ ...s, pvc: "error" }));
            }
          } else {
            setStatus((s) => ({ ...s, pvc: "skipped" }));
          }

          // Step 3: Delete namespace
          if (deploymentScope.hasNamespace) {
            setStatus((s) => ({ ...s, namespace: "running" }));
            try {
              // Remove KEDA finalizers first to prevent namespace deletion from hanging
              // KEDA finalizers wait for KEDA controller, but it's being deleted too
              await removeKedaFinalizers(namespace);
              await deleteNamespace(namespace);
              setStatus((s) => ({ ...s, namespace: "success" }));
            } catch {
              // Namespace might already be gone
              setStatus((s) => ({ ...s, namespace: "error" }));
            }
          } else {
            setStatus((s) => ({ ...s, namespace: "skipped" }));
          }
        } else {
          // Cluster not accessible - skip all cluster operations
          setStatus((s) => ({
            ...s,
            helm: "skipped",
            pvc: "skipped",
            namespace: "skipped",
          }));
        }

        // Destroy infrastructure if requested and it exists
        if (cluster && deploymentScope.hasInfrastructure) {
          setStatus((s) => ({ ...s, infrastructure: "running" }));
          try {
            await terraformDestroy(name);
            setStatus((s) => ({ ...s, infrastructure: "success" }));
          } catch {
            setStatus((s) => ({ ...s, infrastructure: "error" }));
          }
        } else {
          setStatus((s) => ({ ...s, infrastructure: "skipped" }));
        }

        // Clean up local files (only if --config flag is passed)
        if (config && deploymentScope.hasLocalFiles) {
          setStatus((s) => ({ ...s, cleanup: "running" }));
          try {
            await deleteDeployment(name);
            setStatus((s) => ({ ...s, cleanup: "success" }));
          } catch {
            setStatus((s) => ({ ...s, cleanup: "error" }));
          }
        } else {
          setStatus((s) => ({ ...s, cleanup: "skipped" }));
        }

        setStep("complete");
        setTimeout(() => exit(), 3000);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Destruction failed");
        setStep("error");
      }
    },
    [name, cluster, config, exit],
  );

  // Loading screen
  if (step === "loading") {
    return (
      <BorderBox title={`Destroying ${name}`}>
        <Box flexDirection="column" marginY={1}>
          <Spinner label="Checking deployment state..." />
        </Box>
      </BorderBox>
    );
  }

  // Error screen
  if (step === "error") {
    return (
      <BorderBox title="Destruction Failed">
        <Box flexDirection="column" marginY={1}>
          <Text color={colors.error} bold>
            ✗ Error
          </Text>
          <Text color={colors.error}>{error}</Text>
          <Box marginTop={1}>
            <Text color={colors.muted} dimColor>
              Press Enter or Esc to exit
            </Text>
          </Box>
        </Box>
      </BorderBox>
    );
  }

  // Complete screen
  if (step === "complete") {
    const cleanedItems: string[] = [];
    if (status.helm === "success") cleanedItems.push("Helm release");
    if (status.pvc === "success") cleanedItems.push("Persistent volume claims");
    if (status.namespace === "success")
      cleanedItems.push("Kubernetes namespace");
    if (status.infrastructure === "success")
      cleanedItems.push("Cloud infrastructure");
    if (status.cleanup === "success")
      cleanedItems.push("Local configuration files");

    // Check if nothing was cleaned in cluster (no helm, no pvc, no namespace)
    const noClusterCleanup =
      status.helm === "skipped" &&
      status.pvc === "skipped" &&
      status.namespace === "skipped";

    return (
      <BorderBox title="Destruction Complete">
        <Box flexDirection="column" marginY={1}>
          <Text color={colors.success} bold>
            ✓ Deployment "{name}" has been destroyed
          </Text>

          {cleanedItems.length > 0 && (
            <Box marginTop={1} flexDirection="column">
              <Text color={colors.muted}>Cleaned up:</Text>
              {cleanedItems.map((item) => (
                <Text key={item} color={colors.muted}>
                  {" "}
                  • {item}
                </Text>
              ))}
            </Box>
          )}

          {noClusterCleanup && status.cleanup === "success" && (
            <Box marginTop={1}>
              <Text color={colors.muted} dimColor>
                Note: No cluster resources found, only local files were cleaned
                up.
              </Text>
            </Box>
          )}

          {status.cleanup === "skipped" && (
            <Box marginTop={1}>
              <Text color={colors.muted} dimColor>
                Local configuration files preserved in
                ~/.rulebricks/deployments/{name}/
              </Text>
            </Box>
          )}
        </Box>
      </BorderBox>
    );
  }

  // Destroying screen
  if (step === "destroying") {
    // Show cluster operations if cluster is accessible
    const showClusterOps = scope?.clusterAccessible;
    const showInfra = cluster && scope?.hasInfrastructure;

    return (
      <BorderBox title={`Destroying ${name}`}>
        <Box flexDirection="column" marginY={1}>
          {showClusterOps && (
            <>
              <StatusLine
                status={status.helm}
                label="Uninstalling Helm release"
              />
              <StatusLine
                status={status.pvc}
                label="Deleting persistent volumes"
              />
              <StatusLine
                status={status.namespace}
                label="Deleting namespace"
              />
            </>
          )}
          {showInfra && (
            <StatusLine
              status={status.infrastructure}
              label="Destroying infrastructure"
            />
          )}
          {config && (
            <StatusLine
              status={status.cleanup}
              label="Cleaning up local files"
            />
          )}

          {!scope?.clusterAccessible && (
            <Box marginTop={1}>
              <Text color={colors.warning} dimColor>
                Skipping cluster operations (cluster not accessible)
              </Text>
            </Box>
          )}

          <Box marginTop={1}>
            <Spinner label="Destroying deployment..." />
          </Box>
        </Box>
      </BorderBox>
    );
  }

  // Confirmation screen
  // Check if there's nothing in the cluster to clean up
  const hasClusterResources = scope?.hasHelmRelease || scope?.hasNamespace;
  const onlyLocalFiles = !hasClusterResources && !scope?.hasInfrastructure;
  const needsInfraConfirm = cluster && scope?.hasInfrastructure;
  const willDeleteConfig = config && scope?.hasLocalFiles;

  // Nothing to do if only local files exist but --config not passed
  if (onlyLocalFiles && !config) {
    return (
      <BorderBox title="Nothing to Destroy">
        <Box flexDirection="column" marginY={1}>
          <Text color={colors.muted}>
            No cluster resources found to clean up.
          </Text>
          <Text color={colors.muted}>
            Local configuration files will be preserved.
          </Text>
          <Box marginTop={1}>
            <Text color={colors.muted} dimColor>
              Use <Text color={colors.accent}>--config</Text> to also remove
              local files.
            </Text>
          </Box>
          <Box marginTop={1}>
            <Text color={colors.muted} dimColor>
              Press Esc to exit
            </Text>
          </Box>
        </Box>
      </BorderBox>
    );
  }

  return (
    <BorderBox title="Confirm Destruction">
      <Box flexDirection="column" marginY={1}>
        {onlyLocalFiles && config ? (
          // Only cleaning local files (with --config)
          <>
            <Text color={colors.warning} bold>
              ℹ Local Cleanup
            </Text>
            <Box marginY={1} flexDirection="column">
              <Text>No cluster resources found to clean up.</Text>
              <Text>This will delete local configuration files.</Text>
            </Box>
            <Box marginTop={1}>
              <Text color={colors.warning}>
                Press Enter to confirm, Esc to cancel
              </Text>
            </Box>
          </>
        ) : (
          // Full destruction
          <>
            <Text color={colors.accent} bold>
              ⚠ WARNING
            </Text>

            <Box marginY={1} flexDirection="column">
              <Text color={colors.muted}>This will permanently delete:</Text>
              {(scope?.hasHelmRelease || scope?.hasNamespace) && (
                <>
                  <Text color={colors.muted}> • Rulebricks application</Text>
                  <Text color={colors.muted}>
                    {" "}
                    • All databases and stored data
                  </Text>
                  <Text color={colors.muted}> • All persistent volumes</Text>
                  <Text color={colors.muted}> • Monitoring stack</Text>
                  <Text color={colors.muted}> • Kubernetes namespace</Text>
                </>
              )}
              {needsInfraConfirm && (
                <>
                  <Text color={colors.accent}> • Kubernetes cluster</Text>
                  <Text color={colors.accent}> • All cloud infrastructure</Text>
                </>
              )}
              {willDeleteConfig && (
                <Text color={colors.muted}> • Local configuration files</Text>
              )}

              {!cluster && scope?.hasInfrastructure && (
                <Box marginTop={1}>
                  <Text color={colors.muted} dimColor>
                    Cloud infrastructure will be preserved. Use --cluster to
                    remove it.
                  </Text>
                </Box>
              )}
              {cluster && !scope?.hasInfrastructure && (
                <Box marginTop={1}>
                  <Text color={colors.muted} dimColor>
                    No CLI managed infrastructure found for this deployment.
                  </Text>
                </Box>
              )}
              {!willDeleteConfig && (
                <Box marginTop={!needsInfraConfirm && !cluster ? 0 : 1}>
                  <Text color={colors.muted} dimColor>
                    Local config files will be preserved. Use --config to remove
                    them.
                  </Text>
                </Box>
              )}

              {!scope?.clusterAccessible && (
                <Box marginTop={1}>
                  <Text color={colors.warning} dimColor>
                    ⚠ Cluster is not accessible. Cluster resources may need
                    manual cleanup.
                  </Text>
                </Box>
              )}
            </Box>

            {needsInfraConfirm ? (
              <Box flexDirection="column">
                <Text>
                  Type{" "}
                  <Text color={colors.accent} bold>
                    destroy-all
                  </Text>{" "}
                  to confirm:
                </Text>
                <Box marginTop={1}>
                  <Text color={colors.accent}>❯ </Text>
                  <Text>{confirmText}</Text>
                  <Text color={colors.muted}>█</Text>
                </Box>
              </Box>
            ) : (
              <Box marginTop={1}>
                <Text color={colors.warning}>
                  Press Enter to confirm, Esc to cancel
                </Text>
              </Box>
            )}
          </>
        )}
      </Box>
    </BorderBox>
  );
}

export function DestroyCommand(props: DestroyCommandProps) {
  return (
    <ThemeProvider theme="destroy">
      <Logo />
      <DestroyCommandInner {...props} />
    </ThemeProvider>
  );
}

/**
 * Determines what actually exists by checking cluster state directly.
 * This ensures cleanup works even if local state is out of sync.
 */
async function determineScope(
  name: string,
  config: DeploymentConfig | null,
  state: DeploymentState | null,
): Promise<DeploymentScope> {
  // Check if we have local files (we do, since we loaded the deployment)
  const hasLocalFiles = true;

  // Check if infrastructure was provisioned (from local terraform state)
  const hasInfrastructure = await hasTerraformState(name);

  // Use namespace from state if available (backwards compat), otherwise compute from deployment name
  const namespace = state?.application?.namespace || getNamespace(name);
  const releaseName = getReleaseName(name);

  // Check if cluster is accessible
  let clusterAccessible = false;
  try {
    clusterAccessible = await isClusterAccessible();
  } catch {
    clusterAccessible = false;
  }

  // If cluster is accessible, check what actually exists in the cluster
  let hasHelmRelease = false;
  let hasNamespace = false;

  if (clusterAccessible) {
    // Check if Helm release actually exists in the cluster
    try {
      const installedVersion = await getInstalledVersion(
        releaseName,
        namespace,
      );
      hasHelmRelease = installedVersion !== null;
    } catch {
      hasHelmRelease = false;
    }

    // Check if namespace exists
    try {
      hasNamespace = await namespaceExists(namespace);
    } catch {
      hasNamespace = false;
    }
  }

  return {
    hasLocalFiles,
    hasHelmRelease,
    hasNamespace,
    hasInfrastructure,
    clusterAccessible,
  };
}
