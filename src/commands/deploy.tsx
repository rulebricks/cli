import React, { useState, useEffect, useCallback, useRef } from "react";
import { Box, Text, useApp, useInput } from "ink";
import {
  BorderBox,
  Spinner,
  StatusLine,
  ThemeProvider,
  useTheme,
  Logo,
} from "../components/common/index.js";
import { DNSWaitScreen } from "../components/DNSWaitScreen.js";
import {
  loadDeploymentConfig,
  loadDeploymentState,
  saveDeploymentState,
  updateDeploymentStatus,
} from "../lib/config.js";
import {
  setupTerraformWorkspace,
  terraformInit,
  terraformPlan,
  terraformApply,
  terraformDestroy,
  updateKubeconfig,
  hasTerraformState,
  isTerraformInstalled,
} from "../lib/terraform.js";
import {
  installOrUpgradeChart,
  upgradeChart,
  isHelmInstalled,
} from "../lib/helm.js";
import {
  isKubectlInstalled,
  checkClusterAccessible,
} from "../lib/kubernetes.js";
import {
  generateHelmValues,
  updateHelmValuesForTLS,
} from "../lib/helmValues.js";
import {
  DeploymentConfig,
  DeploymentState,
  isSupportedDnsProvider,
  getNamespace,
  getReleaseName,
} from "../types/index.js";

interface DeployCommandProps {
  name: string;
  skipInfra?: boolean;
  skipDns?: boolean;
  version?: string;
}

type DeployStep =
  | "loading"
  | "preflight"
  | "infra-setup"
  | "infra-init"
  | "infra-plan"
  | "infra-apply"
  | "kubeconfig"
  | "helm-install" // Single-phase (External DNS) or Phase 1 (manual DNS)
  | "dns-wait" // Only for manual DNS
  | "helm-upgrade-tls" // Only for manual DNS
  | "complete"
  | "error"
  | "cleanup-prompt" // Ask user if they want to clean up failed infra
  | "cleanup-running" // Running terraform destroy
  | "cleanup-complete"; // Cleanup finished

interface StepStatus {
  preflight: "pending" | "running" | "success" | "error" | "skipped";
  infrastructure: "pending" | "running" | "success" | "error" | "skipped";
  kubeconfig: "pending" | "running" | "success" | "error" | "skipped";
  helmInstall: "pending" | "running" | "success" | "error" | "skipped";
  dnsConfig: "pending" | "running" | "success" | "error" | "skipped";
  helmUpgradeTls: "pending" | "running" | "success" | "error" | "skipped";
}

function DeployCommandInner({
  name,
  skipInfra,
  skipDns,
  version,
}: DeployCommandProps) {
  const { exit } = useApp();
  const { colors } = useTheme();
  const [step, setStep] = useState<DeployStep>("loading");
  const [config, setConfig] = useState<DeploymentConfig | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [useExternalDns, setUseExternalDns] = useState(false);
  const infraStartedRef = useRef(false); // Track if we started infra provisioning (ref for sync access)
  const [cleanupError, setCleanupError] = useState<string | null>(null);
  const [status, setStatus] = useState<StepStatus>({
    preflight: "pending",
    infrastructure: "pending",
    kubeconfig: "pending",
    helmInstall: "pending",
    dnsConfig: "pending",
    helmUpgradeTls: "pending",
  });

  // Handle cleanup prompt responses
  const handleCleanup = useCallback(async () => {
    setStep("cleanup-running");
    try {
      await terraformDestroy(name);
      setStep("cleanup-complete");
      setTimeout(() => exit(), 3000);
    } catch (err) {
      setCleanupError(err instanceof Error ? err.message : "Cleanup failed");
      setStep("cleanup-complete");
      setTimeout(() => exit(), 5000);
    }
  }, [name, exit]);

  const skipCleanup = useCallback(() => {
    setStep("error");
  }, []);

  useInput((input, key) => {
    if (step === "cleanup-prompt") {
      if (input === "y" || input === "Y") {
        handleCleanup();
      } else if (input === "n" || input === "N" || key.escape) {
        skipCleanup();
      }
    } else if (
      key.escape &&
      (step === "error" || step === "cleanup-complete")
    ) {
      exit();
    }
  });

  // Resume after DNS wait (manual DNS flow)
  const handleDnsComplete = useCallback(async () => {
    if (!config) return;

    try {
      setStep("helm-upgrade-tls");
      setStatus((s) => ({
        ...s,
        dnsConfig: "success",
        helmUpgradeTls: "running",
      }));

      // Update helm values to enable TLS
      await updateHelmValuesForTLS(name, true);

      const namespace = getNamespace(config.name);
      const releaseName = getReleaseName(config.name);

      // Upgrade the chart with TLS enabled
      await upgradeChart(name, { releaseName, namespace, version, wait: true });

      setStatus((s) => ({ ...s, helmUpgradeTls: "success" }));

      // Update state
      await updateDeploymentStatus(name, "running", {
        application: {
          appVersion: config.appVersion || "latest",
          hpsVersion: config.hpsVersion || config.appVersion || "latest",
          chartVersion: version || "latest",
          namespace,
          url: `https://${config.domain}`,
        },
      });

      setStep("complete");
      setTimeout(() => exit(), 5000);
    } catch (err) {
      const message = err instanceof Error ? err.message : "TLS upgrade failed";
      setError(message);
      setStep("error");
      setStatus((s) => ({ ...s, helmUpgradeTls: "error" }));
      await updateDeploymentStatus(name, "failed");
    }
  }, [config, name, version, exit]);

  // Skip DNS validation (manual DNS flow)
  const handleDnsSkip = useCallback(async () => {
    if (!config) return;

    setStatus((s) => ({
      ...s,
      dnsConfig: "skipped",
      helmUpgradeTls: "skipped",
    }));

    const namespace = getNamespace(config.name);

    // Mark as running without TLS upgrade
    await updateDeploymentStatus(name, "running", {
      application: {
        appVersion: config.appVersion || "latest",
        hpsVersion: config.hpsVersion || config.appVersion || "latest",
        chartVersion: version || "latest",
        namespace,
        url: `https://${config.domain}`,
      },
    });

    setStep("complete");
    setTimeout(() => exit(), 5000);
  }, [config, name, version, exit]);

  useEffect(() => {
    runDeployment();
  }, []);

  async function runDeployment() {
    try {
      // Load configuration
      const cfg = await loadDeploymentConfig(name);
      setConfig(cfg);

      // Determine if External DNS is enabled
      // External DNS = supported provider + auto-manage enabled
      const externalDnsEnabled =
        cfg.dns.autoManage && isSupportedDnsProvider(cfg.dns.provider);
      setUseExternalDns(externalDnsEnabled);

      // Initialize deployment state
      const existingState = await loadDeploymentState(name);
      const state: DeploymentState = existingState || {
        name,
        version: version || "latest",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        status: "deploying",
      };

      await saveDeploymentState(name, { ...state, status: "deploying" });

      // Preflight checks
      setStep("preflight");
      setStatus((s) => ({ ...s, preflight: "running" }));

      await runPreflightChecks(cfg);
      setStatus((s) => ({ ...s, preflight: "success" }));

      // Infrastructure provisioning
      const needsInfra = cfg.infrastructure.mode === "provision" && !skipInfra;

      if (needsInfra) {
        setStatus((s) => ({ ...s, infrastructure: "running" }));
        infraStartedRef.current = true; // Mark that we're doing infrastructure work

        // Check if already provisioned
        const hasState = await hasTerraformState(name);
        if (!hasState) {
          setStep("infra-setup");
          await setupTerraformWorkspace(name, cfg.infrastructure.provider!);
        }

        setStep("infra-init");
        await terraformInit(name);

        setStep("infra-plan");
        await terraformPlan(name);

        setStep("infra-apply");
        await terraformApply(name);

        setStatus((s) => ({ ...s, infrastructure: "success" }));

        // Update kubeconfig
        setStep("kubeconfig");
        setStatus((s) => ({ ...s, kubeconfig: "running" }));

        await updateKubeconfig(
          cfg.infrastructure.provider!,
          cfg.infrastructure.clusterName || `${name}-cluster`,
          cfg.infrastructure.region!,
          {
            gcpProjectId: cfg.infrastructure.gcpProjectId,
            azureResourceGroup: cfg.infrastructure.azureResourceGroup,
          },
        );

        // Note: StorageClass is managed by the Helm chart, not the CLI
        // This avoids conflicts where kubectl-created resources lack Helm ownership labels

        setStatus((s) => ({ ...s, kubeconfig: "success" }));
      } else {
        // For existing infrastructure, infrastructure is always skipped
        // kubeconfig may have been updated during preflight if cluster wasn't accessible
        // (in that case, it's already set to 'success'), otherwise mark as skipped
        setStatus((s) => ({
          ...s,
          infrastructure: "skipped",
          kubeconfig: s.kubeconfig === "success" ? "success" : "skipped",
        }));
      }

      // Helm Chart Installation
      setStep("helm-install");
      setStatus((s) => ({ ...s, helmInstall: "running" }));

      const namespace = getNamespace(cfg.name);
      const releaseName = getReleaseName(cfg.name);

      if (externalDnsEnabled) {
        // SINGLE-PHASE DEPLOYMENT (External DNS)
        // Install with TLS enabled from the start - external-dns handles DNS records
        await generateHelmValues(cfg, { tlsEnabled: true });
        await installOrUpgradeChart(name, {
          releaseName,
          namespace,
          version,
          wait: true,
        });

        setStatus((s) => ({
          ...s,
          helmInstall: "success",
          dnsConfig: "skipped", // External DNS handles this
          helmUpgradeTls: "skipped", // TLS enabled from start
        }));

        // Update state to running
        await updateDeploymentStatus(name, "running", {
          application: {
            appVersion: cfg.appVersion || "latest",
            hpsVersion: cfg.hpsVersion || cfg.appVersion || "latest",
            chartVersion: version || "latest",
            namespace,
            url: `https://${cfg.domain}`,
          },
        });

        setStep("complete");
        setTimeout(() => exit(), 5000);
      } else {
        // TWO-PHASE DEPLOYMENT (Manual DNS)
        // Phase 1: Install without TLS
        await generateHelmValues(cfg, { tlsEnabled: false });
        await installOrUpgradeChart(name, {
          releaseName,
          namespace,
          version,
          wait: true,
        });

        setStatus((s) => ({ ...s, helmInstall: "success" }));

        // If skipping DNS, go straight to complete
        if (skipDns) {
          setStatus((s) => ({
            ...s,
            dnsConfig: "skipped",
            helmUpgradeTls: "skipped",
          }));
          await updateDeploymentStatus(name, "waiting-dns", {
            application: {
              appVersion: cfg.appVersion || "latest",
              hpsVersion: cfg.hpsVersion || cfg.appVersion || "latest",
              chartVersion: version || "latest",
              namespace,
              url: `https://${cfg.domain}`,
            },
          });
          setStep("complete");
          setTimeout(() => exit(), 5000);
          return;
        }

        // Update state to waiting for DNS
        await updateDeploymentStatus(name, "waiting-dns");

        // Phase 2: DNS configuration wait
        setStep("dns-wait");
        setStatus((s) => ({ ...s, dnsConfig: "running" }));
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : "Unknown error";
      setError(message);

      await updateDeploymentStatus(name, "failed");

      // If we started infrastructure provisioning but failed, offer cleanup
      if (infraStartedRef.current) {
        setStep("cleanup-prompt");
      } else {
        setStep("error");
      }
    }
  }

  async function runPreflightChecks(cfg: DeploymentConfig): Promise<void> {
    // Check required tools
    const [helm, kubectl, terraform] = await Promise.all([
      isHelmInstalled(),
      isKubectlInstalled(),
      isTerraformInstalled(),
    ]);

    if (!helm) {
      throw new Error("Helm is not installed. Please install Helm first.");
    }

    if (!kubectl) {
      throw new Error(
        "kubectl is not installed. Please install kubectl first.",
      );
    }

    if (cfg.infrastructure.mode === "provision" && !terraform) {
      throw new Error(
        "Terraform is not installed. Required for infrastructure provisioning.",
      );
    }

    // Check cluster access if using existing infrastructure
    if (cfg.infrastructure.mode === "existing") {
      let clusterError = await checkClusterAccessible();

      // If cluster not accessible but we have provider details, try updating kubeconfig
      if (
        clusterError &&
        cfg.infrastructure.provider &&
        cfg.infrastructure.region &&
        cfg.infrastructure.clusterName
      ) {
        try {
          // Show visual feedback for kubeconfig update
          setStep("kubeconfig");
          setStatus((s) => ({
            ...s,
            preflight: "success",
            kubeconfig: "running",
          }));

          await updateKubeconfig(
            cfg.infrastructure.provider,
            cfg.infrastructure.clusterName,
            cfg.infrastructure.region,
            {
              gcpProjectId: cfg.infrastructure.gcpProjectId,
              azureResourceGroup: cfg.infrastructure.azureResourceGroup,
            },
          );

          // Retry cluster access check
          clusterError = await checkClusterAccessible();

          if (!clusterError) {
            setStatus((s) => ({ ...s, kubeconfig: "success" }));
          }
        } catch (kubeconfigError) {
          // Kubeconfig update failed, include both errors
          const kubeconfigMsg =
            kubeconfigError instanceof Error
              ? kubeconfigError.message
              : "Unknown error";
          throw new Error(
            `Cannot access Kubernetes cluster and kubeconfig update failed:\n` +
              `Cluster error: ${clusterError}\n` +
              `Kubeconfig update error: ${kubeconfigMsg}`,
          );
        }
      }

      if (clusterError) {
        // Provide helpful message based on whether provider details are missing
        if (
          !cfg.infrastructure.provider ||
          !cfg.infrastructure.region ||
          !cfg.infrastructure.clusterName
        ) {
          throw new Error(
            `Cannot access Kubernetes cluster:\n${clusterError}\n\n` +
              `Tip: Re-run 'rulebricks init' and provide your cloud provider, region, and cluster name ` +
              `to enable automatic kubeconfig updates.`,
          );
        }
        throw new Error(`Cannot access Kubernetes cluster:\n${clusterError}`);
      }
    }
  }

  // Cleanup prompt screen
  if (step === "cleanup-prompt") {
    return (
      <BorderBox title="Deployment Failed">
        <Box flexDirection="column" marginY={1}>
          <Text color={colors.error} bold>
            ✗ Infrastructure provisioning failed
          </Text>
          <Text color={colors.error}>{error}</Text>

          <Box marginTop={1} flexDirection="column">
            <Text color={colors.warning} bold>
              Partial infrastructure may have been created.
            </Text>
            <Text color={colors.muted}>
              Would you like to clean up to avoid orphaned resources?
            </Text>
          </Box>

          <Box marginTop={1}>
            <Text color={colors.accent} bold>
              [Y]
            </Text>
            <Text color={colors.muted}>
              {" "}
              Yes, destroy partial infrastructure
            </Text>
          </Box>
          <Box>
            <Text color={colors.accent} bold>
              [N]
            </Text>
            <Text color={colors.muted}>
              {" "}
              No, keep for debugging (you can run `rulebricks destroy --cluster`
              later)
            </Text>
          </Box>
        </Box>
      </BorderBox>
    );
  }

  // Cleanup running screen
  if (step === "cleanup-running") {
    return (
      <BorderBox title="Cleaning Up">
        <Box flexDirection="column" marginY={1}>
          <Spinner label="Destroying partial infrastructure..." />
          <Box marginTop={1}>
            <Text color={colors.muted}>This may take several minutes...</Text>
          </Box>
        </Box>
      </BorderBox>
    );
  }

  // Cleanup complete screen
  if (step === "cleanup-complete") {
    return (
      <BorderBox title="Cleanup Complete">
        <Box flexDirection="column" marginY={1}>
          {cleanupError ? (
            <>
              <Text color={colors.warning} bold>
                ⚠ Cleanup encountered issues
              </Text>
              <Text color={colors.warning}>{cleanupError}</Text>
              <Box marginTop={1}>
                <Text color={colors.muted}>
                  Some resources may remain. Run `rulebricks destroy {name}{" "}
                  --cluster` to retry.
                </Text>
              </Box>
            </>
          ) : (
            <>
              <Text color={colors.success} bold>
                ✓ Infrastructure cleaned up successfully
              </Text>
              <Box marginTop={1}>
                <Text color={colors.muted}>
                  All partial resources have been destroyed. You can try
                  deploying again.
                </Text>
              </Box>
            </>
          )}
          <Box marginTop={1}>
            <Text color={colors.muted} dimColor>
              Press Esc to exit
            </Text>
          </Box>
        </Box>
      </BorderBox>
    );
  }

  // Error screen (non-infra failures or when user skips cleanup)
  if (step === "error") {
    // Format error message, preserving newlines for multi-line errors
    const errorLines = error?.split("\n") || ["Unknown error"];

    return (
      <BorderBox title="Deployment Failed">
        <Box flexDirection="column" marginY={1}>
          <Text color={colors.error} bold>
            ✗ Error
          </Text>
          <Box flexDirection="column" marginTop={1}>
            {errorLines.map((line, i) => (
              <Text
                key={i}
                color={line.startsWith("  •") ? colors.muted : colors.error}
              >
                {line}
              </Text>
            ))}
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

  // DNS wait screen (only for manual DNS flow)
  if (step === "dns-wait" && config) {
    return (
      <DNSWaitScreen
        domain={config.domain}
        selfHostedSupabase={config.database.type === "self-hosted"}
        namespace={getNamespace(config.name)}
        onComplete={handleDnsComplete}
        onSkip={handleDnsSkip}
      />
    );
  }

  // Complete screen
  if (step === "complete") {
    const tlsSkipped = status.helmUpgradeTls === "skipped" && !useExternalDns;

    return (
      <BorderBox title="Deployment Complete">
        <Box flexDirection="column" marginY={1}>
          <Text color={colors.success} bold>
            ✓ Rulebricks deployed successfully!
          </Text>

          <Box marginTop={1} flexDirection="column">
            <Text>
              URL:{" "}
              <Text color={colors.accent}>
                https://{config?.domain}/auth/signup
              </Text>
            </Text>
            {useExternalDns && (
              <Text color={colors.muted}>
                DNS records will be created automatically by external-dns
              </Text>
            )}
            {tlsSkipped && (
              <Box marginTop={1}>
                <Text color={colors.warning}>
                  ⚠ TLS not configured. Run `rulebricks deploy {name}` again
                  after DNS setup.
                </Text>
              </Box>
            )}
          </Box>

          <Box marginTop={1} flexDirection="column">
            <Text bold>Next steps:</Text>
            <Text color={colors.muted}>
              {" "}
              • Visit the URL to complete initial setup
            </Text>
            <Text color={colors.muted}>
              {" "}
              • Run `rulebricks status {name}` to check deployment health
            </Text>
            {tlsSkipped && (
              <Text color={colors.muted}>
                {" "}
                • Configure DNS and re-run deploy for TLS
              </Text>
            )}
          </Box>
        </Box>
      </BorderBox>
    );
  }

  // Progress screen
  const helmInstallLabel = useExternalDns
    ? "Helm chart installation (with TLS)"
    : "Helm chart installation";

  return (
    <BorderBox title={`Deploying ${name}`}>
      <Box flexDirection="column" marginY={1}>
        <StatusLine status={status.preflight} label="Preflight checks" />
        <StatusLine
          status={status.infrastructure}
          label="Infrastructure provisioning"
          detail={
            step === "infra-setup"
              ? "Setting up workspace"
              : step === "infra-init"
                ? "Initializing Terraform"
                : step === "infra-plan"
                  ? "Planning changes"
                  : step === "infra-apply"
                    ? "Applying infrastructure"
                    : undefined
          }
        />
        <StatusLine
          status={status.kubeconfig}
          label="Kubernetes configuration"
        />
        <StatusLine status={status.helmInstall} label={helmInstallLabel} />
        {!useExternalDns && (
          <>
            <StatusLine status={status.dnsConfig} label="DNS configuration" />
            <StatusLine
              status={status.helmUpgradeTls}
              label="TLS configuration"
            />
          </>
        )}

        {step !== "dns-wait" && (
          <Box marginTop={1}>
            <Spinner label={getStepLabel(step, useExternalDns)} />
          </Box>
        )}
      </Box>
    </BorderBox>
  );
}

function getStepLabel(step: DeployStep, useExternalDns: boolean): string {
  switch (step) {
    case "loading":
      return "Loading configuration...";
    case "preflight":
      return "Running preflight checks...";
    case "infra-setup":
      return "Setting up Terraform workspace...";
    case "infra-init":
      return "Initializing Terraform...";
    case "infra-plan":
      return "Planning infrastructure changes...";
    case "infra-apply":
      return "Creating infrastructure (may take up to 15 minutes)...";
    case "kubeconfig":
      return "Updating kubeconfig...";
    case "helm-install":
      return useExternalDns
        ? "Installing Helm chart with TLS..."
        : "Installing Helm chart...";
    case "dns-wait":
      return "Waiting for DNS configuration...";
    case "helm-upgrade-tls":
      return "Enabling TLS certificates...";
    default:
      return "Processing...";
  }
}

export function DeployCommand(props: DeployCommandProps) {
  return (
    <ThemeProvider theme="deploy">
      <Logo />
      <DeployCommandInner {...props} />
    </ThemeProvider>
  );
}
