import React, { useCallback, useState } from "react";
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
  updateDeploymentStatus,
} from "../lib/config.js";
import { uninstallChart, getInstalledVersion } from "../lib/helm.js";
import {
  cleanupNamespaceAPIServices,
  deleteNamespace,
  deletePVCs,
  isClusterAccessible,
  namespaceExists,
  removeKedaFinalizers,
} from "../lib/kubernetes.js";
import { DeploymentState, getNamespace, getReleaseName } from "../types/index.js";

interface DestroyCommandProps {
  name: string;
  config?: boolean;
  force?: boolean;
}

type DestroyStep = "loading" | "confirm" | "destroying" | "complete" | "error";

interface StepStatus {
  helm: "pending" | "running" | "success" | "error" | "skipped";
  pvc: "pending" | "running" | "success" | "error" | "skipped";
  namespace: "pending" | "running" | "success" | "error" | "skipped";
  cleanup: "pending" | "running" | "success" | "error" | "skipped";
}

interface DeploymentScope {
  hasLocalFiles: boolean;
  hasHelmRelease: boolean;
  hasNamespace: boolean;
  clusterAccessible: boolean;
}

function DestroyCommandInner({ name, config, force }: DestroyCommandProps) {
  const { exit } = useApp();
  const { colors } = useTheme();
  const [step, setStep] = useState<DestroyStep>("loading");
  const [state, setState] = useState<DeploymentState | null>(null);
  const [scope, setScope] = useState<DeploymentScope | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<StepStatus>({
    helm: "pending",
    pvc: "pending",
    namespace: "pending",
    cleanup: "pending",
  });

  React.useEffect(() => {
    (async () => {
      try {
        const exists = await deploymentExists(name);
        if (!exists) {
          setError(`Deployment "${name}" not found`);
          setStep("error");
          return;
        }

        try {
          await loadDeploymentConfig(name);
        } catch {
          // Config might be corrupted or missing; cluster cleanup can still use state/name.
        }

        const st = await loadDeploymentState(name);
        setState(st);

        const deploymentScope = await determineScope(name, st);
        setScope(deploymentScope);

        if (force) {
          setStep("destroying");
          runDestroy(st, deploymentScope);
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
        setStep("destroying");
        runDestroy(state, scope!);
      } else if (key.escape) {
        exit();
      }
    } else if (step === "error" && (key.escape || key.return)) {
      exit();
    }
  });

  const runDestroy = useCallback(
    async (st: DeploymentState | null, deploymentScope: DeploymentScope) => {
      try {
        const namespace = st?.application?.namespace || getNamespace(name);
        const releaseName = getReleaseName(name);

        if (deploymentScope.clusterAccessible) {
          if (deploymentScope.hasHelmRelease && deploymentScope.hasNamespace) {
            setStatus((s) => ({ ...s, helm: "running" }));
            try {
              await uninstallChart(releaseName, namespace, { wait: false });
              setStatus((s) => ({ ...s, helm: "success" }));
            } catch {
              setStatus((s) => ({ ...s, helm: "error" }));
            }
          } else {
            setStatus((s) => ({ ...s, helm: "skipped" }));
          }

          if (deploymentScope.hasNamespace) {
            setStatus((s) => ({ ...s, pvc: "running" }));
            try {
              await deletePVCs(namespace);
              setStatus((s) => ({ ...s, pvc: "success" }));
            } catch {
              setStatus((s) => ({ ...s, pvc: "error" }));
            }

            setStatus((s) => ({ ...s, namespace: "running" }));
            try {
              // Clear teardown deadlocks BEFORE deleting the namespace:
              //  - KEDA ScaledObject finalizers wait on a controller that's
              //    being removed with the namespace.
              //  - Aggregated APIServices backed by this namespace's services
              //    (KEDA external.metrics, metrics adapters, etc.) go
              //    Unavailable as the namespace tears down and break the
              //    namespace controller's discovery, wedging it in Terminating.
              await removeKedaFinalizers(namespace);
              await cleanupNamespaceAPIServices(namespace);
              await deleteNamespace(namespace);
              setStatus((s) => ({ ...s, namespace: "success" }));
            } catch {
              setStatus((s) => ({ ...s, namespace: "error" }));
            }
          } else {
            setStatus((s) => ({ ...s, pvc: "skipped", namespace: "skipped" }));
          }
        } else {
          setStatus((s) => ({
            ...s,
            helm: "skipped",
            pvc: "skipped",
            namespace: "skipped",
          }));
        }

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

        if (!config && deploymentScope.clusterAccessible) {
          await updateDeploymentStatus(name, "destroyed");
        }

        setStep("complete");
        setTimeout(() => exit(), 3000);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Destruction failed");
        setStep("error");
      }
    },
    [name, config, exit],
  );

  if (step === "loading") {
    return (
      <BorderBox title={`Destroying ${name}`}>
        <Box flexDirection="column" marginY={1}>
          <Spinner label="Checking deployment state..." />
        </Box>
      </BorderBox>
    );
  }

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

  if (step === "complete") {
    const cleanedItems: string[] = [];
    if (status.helm === "success") cleanedItems.push("Helm release");
    if (status.pvc === "success") cleanedItems.push("Persistent volume claims");
    if (status.namespace === "success")
      cleanedItems.push("Kubernetes namespace");
    if (status.cleanup === "success")
      cleanedItems.push("Local configuration files");

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

  if (step === "destroying") {
    return (
      <BorderBox title={`Destroying ${name}`}>
        <Box flexDirection="column" marginY={1}>
          {scope?.clusterAccessible && (
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

  const hasClusterResources = scope?.hasHelmRelease || scope?.hasNamespace;
  const onlyLocalFiles = !hasClusterResources;
  const willDeleteConfig = config && scope?.hasLocalFiles;

  if (onlyLocalFiles && !config) {
    return (
      <BorderBox title="Nothing to Destroy">
        <Box flexDirection="column" marginY={1}>
          <Text color={colors.muted}>No cluster resources found to clean up.</Text>
          <Text color={colors.muted}>Local configuration files will be preserved.</Text>
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
          <>
            <Text color={colors.warning} bold>
              Local Cleanup
            </Text>
            <Box marginY={1} flexDirection="column">
              <Text>No cluster resources found to clean up.</Text>
              <Text>This will delete local configuration files.</Text>
            </Box>
          </>
        ) : (
          <>
            <Text color={colors.accent} bold>
              WARNING
            </Text>
            <Box marginY={1} flexDirection="column">
              <Text color={colors.muted}>This will permanently delete:</Text>
              {(scope?.hasHelmRelease || scope?.hasNamespace) && (
                <>
                  <Text color={colors.muted}> • Rulebricks application</Text>
                  <Text color={colors.muted}> • All databases and stored data</Text>
                  <Text color={colors.muted}> • All persistent volumes</Text>
                  <Text color={colors.muted}> • Monitoring stack</Text>
                  <Text color={colors.muted}> • Kubernetes namespace</Text>
                </>
              )}
              {willDeleteConfig && (
                <Text color={colors.muted}> • Local configuration files</Text>
              )}
              {!willDeleteConfig && (
                <Box marginTop={1}>
                  <Text color={colors.muted} dimColor>
                    Local config files will be preserved. Use --config to remove
                    them.
                  </Text>
                </Box>
              )}
              {!scope?.clusterAccessible && (
                <Box marginTop={1}>
                  <Text color={colors.warning} dimColor>
                    Cluster is not accessible. Some cluster resources may need
                    manual cleanup.
                  </Text>
                </Box>
              )}
            </Box>
          </>
        )}

        <Box marginTop={1}>
          <Text color={colors.warning}>Press Enter to confirm, Esc to cancel</Text>
        </Box>
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

async function determineScope(
  name: string,
  state: DeploymentState | null,
): Promise<DeploymentScope> {
  const hasLocalFiles = true;
  const namespace = state?.application?.namespace || getNamespace(name);
  const releaseName = getReleaseName(name);

  let clusterAccessible = false;
  try {
    clusterAccessible = await isClusterAccessible();
  } catch {
    clusterAccessible = false;
  }

  let hasHelmRelease = false;
  let hasNamespace = false;

  if (clusterAccessible) {
    try {
      const installedVersion = await getInstalledVersion(releaseName, namespace);
      hasHelmRelease = installedVersion !== null;
    } catch {
      hasHelmRelease = false;
    }

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
    clusterAccessible,
  };
}
