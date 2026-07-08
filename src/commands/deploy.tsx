import React, { useCallback, useEffect, useState } from "react";
import { Box, Text, useApp } from "ink";
import { platform } from "os";
import {
  BorderBox,
  Spinner,
  StatusLine,
  ThemeProvider,
  useTheme,
  Logo,
  CommandApprovalProvider,
} from "../components/common/index.js";
import { DNSWaitScreen } from "../components/DNSWaitScreen.js";
import {
  loadDeploymentConfig,
  loadDeploymentState,
  loadHelmValues,
  saveDeploymentState,
  updateDeploymentStatus,
} from "../lib/config.js";
import {
  installOrUpgradeChart,
  upgradeChart,
  isHelmInstalled,
} from "../lib/helm.js";
import { assertValidHelmValues } from "../lib/validateValues.js";
import {
  isKubectlInstalled,
  checkClusterAccessible,
  waitForCertificatesReady,
} from "../lib/kubernetes.js";
import {
  updateKubeconfig,
  checkAuroraLogicalReplication,
} from "../lib/cloudCli.js";
import {
  ensureWorkloadIdentityFederation,
  verifyManualKafkaAssociations,
} from "../lib/workloadIdentity.js";
import {
  generateHelmValuesPreservingEdits,
  updateHelmValuesForTLS,
} from "../lib/helmValues.js";
import { resolveImageCatalog } from "../lib/imageCatalog.js";
import { ensureNamespace, applyDeploymentSecrets } from "../lib/secrets.js";
import { runInstallSequence } from "../lib/deploySequence.js";
import { CommandDeniedError } from "../lib/commandApproval.js";
import {
  DeploymentConfig,
  DeploymentState,
  isSupportedDnsProvider,
  getNamespace,
  getReleaseName,
} from "../types/index.js";

interface DeployCommandProps {
  name: string;
  skipDns?: boolean;
  version?: string;
  regenerateValues?: boolean;
  assumeDnsConfigured?: boolean;
  // When true, secrets are written inline into values.yaml (dev/direct-chart).
  // Default (false) = k8s mode: the CLI creates Kubernetes Secrets and the
  // generated values carry only secretRef references.
  inlineSecrets?: boolean;
}

function getConfigProductVersion(config: DeploymentConfig): string {
  return config.version;
}

type DeployStep =
  | "loading"
  | "preflight"
  | "federation"
  | "kubeconfig"
  | "helm-install"
  | "cert-check"
  | "dns-wait"
  | "helm-upgrade-tls"
  | "complete"
  | "error";

interface StepStatus {
  preflight: "pending" | "running" | "success" | "error" | "skipped";
  federation: "pending" | "running" | "success" | "error" | "skipped";
  kubeconfig: "pending" | "running" | "success" | "error" | "skipped";
  helmInstall: "pending" | "running" | "success" | "error" | "skipped";
  certCheck: "pending" | "running" | "success" | "error" | "skipped";
  dnsConfig: "pending" | "running" | "success" | "error" | "skipped";
  helmUpgradeTls: "pending" | "running" | "success" | "error" | "skipped";
}

function DeployCommandInner({
  name,
  skipDns,
  version,
  regenerateValues = true,
  assumeDnsConfigured = false,
  inlineSecrets = false,
}: DeployCommandProps) {
  const secretMode: "k8s" | "inline" = inlineSecrets ? "inline" : "k8s";
  const { exit } = useApp();
  const { colors } = useTheme();
  const [step, setStep] = useState<DeployStep>("loading");
  const [config, setConfig] = useState<DeploymentConfig | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [useExternalDns, setUseExternalDns] = useState(false);
  const [tlsWarning, setTlsWarning] = useState<string | null>(null);
  const [federationWarning, setFederationWarning] = useState<string | null>(null);
  const [status, setStatus] = useState<StepStatus>({
    preflight: "pending",
    federation: "pending",
    kubeconfig: "pending",
    helmInstall: "pending",
    certCheck: "pending",
    dnsConfig: "pending",
    helmUpgradeTls: "pending",
  });

  useEffect(() => {
    runDeployment();
  }, []);

  const markRunning = (key: keyof StepStatus) => {
    setStatus((s) => ({ ...s, [key]: "running" }));
  };

  const markSuccess = (key: keyof StepStatus) => {
    setStatus((s) => ({ ...s, [key]: "success" }));
  };

  const handleDnsComplete = useCallback(async () => {
    if (!config) return;

    try {
      setStep("helm-upgrade-tls");
      setStatus((s) => ({
        ...s,
        dnsConfig: "success",
        helmUpgradeTls: "running",
      }));

      await updateHelmValuesForTLS(name, true);

      const namespace = getNamespace(config.name);
      const releaseName = getReleaseName(config.name);

      await upgradeChart(name, { releaseName, namespace, version, wait: true });

      setStatus((s) => ({ ...s, helmUpgradeTls: "success", certCheck: "running" }));
      setStep("cert-check");
      await verifyCertificates(namespace);

      await markRunningState(config, namespace);
      setStep("complete");
      setTimeout(() => exit(), 5000);
    } catch (err) {
      await failDeployment(err, "TLS upgrade failed");
    }
  }, [config, name, version, exit]);

  const handleDnsSkip = useCallback(async () => {
    if (!config) return;

    setStatus((s) => ({
      ...s,
      dnsConfig: "skipped",
      helmUpgradeTls: "skipped",
      certCheck: "skipped",
    }));

    const namespace = getNamespace(config.name);
    const productVersion = getConfigProductVersion(config);
    await updateDeploymentStatus(name, "waiting-dns", {
      application: {
        version: productVersion,
        chartVersion: version || "latest",
        namespace,
        url: `https://${config.domain}`,
      },
    });

    setStep("complete");
    setTimeout(() => exit(), 5000);
  }, [config, name, version, exit]);

  async function runDeployment() {
    try {
      const cfg = await loadDeploymentConfig(name);
      setConfig(cfg);

      const externalDnsEnabled =
        cfg.dns.autoManage && isSupportedDnsProvider(cfg.dns.provider);
      setUseExternalDns(externalDnsEnabled);

      const existingState = await loadDeploymentState(name);
      const state: DeploymentState = existingState || {
        name,
        version: version || "latest",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        status: "deploying",
      };

      await saveDeploymentState(name, { ...state, status: "deploying" });

      setStep("preflight");
      markRunning("preflight");
      await runPreflightChecks(cfg);
      markSuccess("preflight");

      // Ensure the per-namespace workload-identity trust exists. cluster-setup
      // creates the deployment-independent identity; this wires it to this
      // deployment's ServiceAccounts so one cluster can host many deployments.
      setStep("federation");
      markRunning("federation");
      try {
        const federation = await ensureWorkloadIdentityFederation(cfg);
        setStatus((s) => ({
          ...s,
          federation: federation.skipped ? "skipped" : "success",
        }));
      } catch (federationError) {
        if (!(federationError instanceof CommandDeniedError)) {
          throw federationError;
        }
        setFederationWarning(
          "Workload identity setup was skipped because a cloud CLI command was denied. Continuing assumes you created the trust manually.",
        );
        setStatus((s) => ({
          ...s,
          federation: "skipped",
        }));
      }

      setStep("helm-install");
      markRunning("helmInstall");

      const namespace = getNamespace(cfg.name);
      const releaseName = getReleaseName(cfg.name);

      // Resolve the infrastructure image tags from the chart's own
      // images/manifest.yaml for the exact chart version being installed
      // (--chart-version, or whatever the registry currently serves). Resolved
      // once so both TLS generation phases use the same catalog.
      const imageCatalog = await resolveImageCatalog(version);

      await runInstallSequence(
        {
          regenerateValues,
          tlsEnabled: externalDnsEnabled,
          secretMode,
        },
        {
          // Merge-preserving generation: config-driven values are refreshed
          // while manual values.yaml edits and configure-only changes survive.
          generateValues: (tlsEnabled, mode) =>
            generateHelmValuesPreservingEdits(cfg, {
              tlsEnabled,
              secretMode: mode,
              images: imageCatalog,
            }),
          validateValues: ensureGeneratedValuesValid,
          ensureNamespace: () => ensureNamespace(namespace),
          applySecrets: async () => {
            await applyDeploymentSecrets(cfg, namespace);
          },
          installChart: () =>
            installOrUpgradeChart(name, {
              releaseName,
              namespace,
              version,
              wait: true,
            }),
        },
      );

      if (externalDnsEnabled) {
        setStatus((s) => ({
          ...s,
          helmInstall: "success",
          dnsConfig: "skipped",
          helmUpgradeTls: "skipped",
          certCheck: "running",
        }));

        setStep("cert-check");
        await verifyCertificates(namespace);
        await markRunningState(cfg, namespace);
        setStep("complete");
        setTimeout(() => exit(), 5000);
        return;
      }

      markSuccess("helmInstall");

      if (assumeDnsConfigured) {
        setStatus((s) => ({
          ...s,
          dnsConfig: "skipped",
          helmUpgradeTls: "skipped",
          certCheck: "running",
        }));
        setStep("cert-check");
        await verifyCertificates(namespace);
        await markRunningState(cfg, namespace);
        setStep("complete");
        setTimeout(() => exit(), 5000);
        return;
      }

      if (skipDns) {
        setStatus((s) => ({
          ...s,
          dnsConfig: "skipped",
          helmUpgradeTls: "skipped",
          certCheck: "skipped",
        }));
        const productVersion = getConfigProductVersion(cfg);
        await updateDeploymentStatus(name, "waiting-dns", {
          application: {
            version: productVersion,
            chartVersion: version || "latest",
            namespace,
            url: `https://${cfg.domain}`,
          },
        });
        setStep("complete");
        setTimeout(() => exit(), 5000);
        return;
      }

      await updateDeploymentStatus(name, "waiting-dns");
      setStep("dns-wait");
      markRunning("dnsConfig");
    } catch (err) {
      await failDeployment(err, "Unknown error");
    }
  }

  // Guardrail: validate the values we're about to install against the chart's
  // bundled schema. Catches reused/hand-edited values too (regenerateValues=false).
  async function ensureGeneratedValuesValid(): Promise<void> {
    const values = await loadHelmValues(name);
    if (values) {
      assertValidHelmValues(values);
    }
  }

  async function runPreflightChecks(cfg: DeploymentConfig): Promise<void> {
    const [helm, kubectl] = await Promise.all([
      isHelmInstalled(),
      isKubectlInstalled(),
    ]);

    if (!helm) {
      throw new Error("Helm is not installed. Please install Helm first.");
    }

    if (!kubectl) {
      throw new Error("kubectl is not installed. Please install kubectl first.");
    }

    let clusterError = await checkClusterAccessible();
    if (
      clusterError &&
      cfg.infrastructure.provider &&
      cfg.infrastructure.region &&
      cfg.infrastructure.clusterName
    ) {
      try {
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

        clusterError = await checkClusterAccessible();
        if (!clusterError) {
          markSuccess("kubeconfig");
        }
      } catch (kubeconfigError) {
        if (kubeconfigError instanceof CommandDeniedError) {
          clusterError = await checkClusterAccessible();
          if (!clusterError) {
            markSuccess("kubeconfig");
            return;
          }
        }
        const kubeconfigMsg =
          kubeconfigError instanceof Error
            ? kubeconfigError.message
            : "Unknown error";
        throw new Error(
          `Cannot access Kubernetes cluster and kubeconfig refresh failed:\n` +
            `Cluster error: ${clusterError}\n` +
            `Kubeconfig error: ${kubeconfigMsg}`,
        );
      }
    }

    if (clusterError) {
      throw new Error(`Cannot access Kubernetes cluster:\n${clusterError}`);
    }

    setStatus((s) => ({
      ...s,
      kubeconfig: s.kubeconfig === "success" ? "success" : "skipped",
    }));

    // External AWS Aurora needs logical replication for Supabase Realtime - a
    // static cluster parameter bootstrap.sql can't set - so catch it here before
    // a long deploy ends in a Realtime crashloop. Fail-open: the check returns
    // "unknown" (and we proceed) on any ambiguity; we only block when the
    // parameter is definitively off.
    const pg = cfg.externalServices?.postgres;
    if (
      pg?.mode === "external" &&
      pg.external?.provider === "aws" &&
      pg.external.host
    ) {
      const lr = await checkAuroraLogicalReplication(
        pg.external.host,
        cfg.infrastructure.region,
      );
      if (lr.status === "disabled") {
        const pgName = lr.parameterGroup ?? "<db-cluster-parameter-group>";
        throw new Error(
          "External Aurora Postgres has logical replication DISABLED" +
            (lr.parameterGroup ? ` (parameter group ${lr.parameterGroup})` : "") +
            ". Supabase Realtime requires it, and rds.logical_replication is a " +
            "static parameter the chart's bootstrap cannot set. Enable it, then " +
            "reboot the writer, before deploying:\n" +
            `  aws rds modify-db-cluster-parameter-group --db-cluster-parameter-group-name ${pgName} \\\n` +
            '    --parameters "ParameterName=rds.logical_replication,ParameterValue=1,ApplyMethod=pending-reboot"\n' +
            "  aws rds reboot-db-instance --db-instance-identifier <writer-instance>\n" +
            "(If the cluster uses a default parameter group, create a custom one first and attach it.)",
        );
      }
    }

    // AWS MSK IAM without Pod Identity credentials wedges the topic-provision
    // pre-install hook until the helm timeout ("no EC2 IMDS role found"), so
    // fail in seconds here instead. Deploy covers the common case itself by
    // deriving the cluster-setup role (<cluster>-rulebricks); this only fires
    // when that role is absent AND no manually-managed associations exist.
    const kafkaIdentity = await verifyManualKafkaAssociations(cfg);
    if (!kafkaIdentity.ok) {
      const namespace = getNamespace(cfg.name);
      const cluster = cfg.infrastructure.clusterName;
      const region = cfg.infrastructure.region;
      throw new Error(
        "External Kafka uses AWS MSK IAM, but no Pod Identity credentials are " +
          "available for these service accounts:\n" +
          kafkaIdentity.missing.map((sa) => `  - ${namespace}/${sa}`).join("\n") +
          "\nWithout them, topic provisioning and HPS cannot reach the broker " +
          "and the install hangs until the helm timeout.\n\n" +
          `The cluster-setup role (${cluster}-rulebricks) was not found (or its ` +
          "trust policy does not allow pods.eks.amazonaws.com), and no existing " +
          "Pod Identity associations cover these service accounts.\n\n" +
          "Fix one of:\n" +
          "  - Run the Rulebricks AWS cluster-setup stack, which provisions the " +
          `${cluster}-rulebricks role deploy binds automatically.\n` +
          "  - Set externalServices.kafka.external.identity.awsRoleArn in " +
          "config.yaml to a Pod Identity-capable role with MSK access.\n" +
          "  - Create the associations yourself, e.g.:\n" +
          kafkaIdentity.missing
            .map(
              (sa) =>
                `      aws eks create-pod-identity-association --cluster-name ${cluster} \\\n` +
                `        --namespace ${namespace} --service-account ${sa} \\\n` +
                `        --role-arn <role-arn> --region ${region}`,
            )
            .join("\n"),
      );
    }
  }

  async function verifyCertificates(namespace: string): Promise<void> {
    try {
      await waitForCertificatesReady(namespace);
      markSuccess("certCheck");
    } catch {
      setStatus((s) => ({ ...s, certCheck: "error" }));
      setTlsWarning(
        "TLS certificates are still being issued. HTTPS may not be available yet.",
      );
    }
  }

  async function markRunningState(
    cfg: DeploymentConfig,
    namespace: string,
  ): Promise<void> {
    const productVersion = getConfigProductVersion(cfg);
    await updateDeploymentStatus(name, "running", {
      application: {
        version: productVersion,
        chartVersion: version || "latest",
        namespace,
        url: `https://${cfg.domain}`,
      },
    });
  }

  async function failDeployment(err: unknown, fallback: string): Promise<void> {
    const message = err instanceof Error ? err.message : fallback;
    setError(message);
    setStep("error");
    setStatus((s) => ({
      ...s,
      preflight: step === "preflight" ? "error" : s.preflight,
      federation: step === "federation" ? "error" : s.federation,
      helmInstall: step === "helm-install" ? "error" : s.helmInstall,
      helmUpgradeTls:
        step === "helm-upgrade-tls" ? "error" : s.helmUpgradeTls,
    }));
    await updateDeploymentStatus(name, "failed");
  }

  if (step === "error") {
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
        </Box>
      </BorderBox>
    );
  }

  if (step === "dns-wait" && config) {
    return (
      <DNSWaitScreen
        domain={config.domain}
        selfHostedSupabase={config.database.type === "self-hosted"}
        builtInObservability={
          config.features.observability?.clickstack?.enabled ?? true
        }
        valkeyAdminIngress={
          config.features.cache?.valkeyAdmin?.enabled === true &&
          config.features.cache.valkeyAdmin.exposure === "ingress"
        }
        valkeyAdminHostname={config.features.cache?.valkeyAdmin?.hostname}
        namespace={getNamespace(config.name)}
        onComplete={handleDnsComplete}
        onSkip={handleDnsSkip}
      />
    );
  }

  if (step === "complete") {
    const tlsSkipped =
      status.helmUpgradeTls === "skipped" &&
      !useExternalDns &&
      !assumeDnsConfigured;

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
            {tlsWarning && (
              <Box marginTop={1}>
                <Text color={colors.warning}>⚠ {tlsWarning}</Text>
              </Box>
            )}
            {federationWarning && (
              <Box marginTop={1}>
                <Text color={colors.warning}>⚠ {federationWarning}</Text>
              </Box>
            )}
          </Box>

          <Box marginTop={1} flexDirection="column">
            <Text bold>Next steps:</Text>
            <Text color={colors.muted}> • Visit the URL to complete setup</Text>
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

          <Box marginTop={1} flexDirection="column">
            <Text color={colors.muted} dimColor>
              Tip: If the URL isn't accessible yet, your local DNS may need time
              to propagate.
            </Text>
            <Text color={colors.muted} dimColor>
              Flush DNS cache: {getDnsFlushCommand()}
            </Text>
          </Box>
        </Box>
      </BorderBox>
    );
  }

  const helmInstallLabel = useExternalDns
    ? "Helm chart installation (with TLS)"
    : "Helm chart installation";

  // The federation step does the cloud-appropriate per-namespace identity wiring;
  // label it for the cluster's cloud so it's clear what's happening.
  const federationLabel =
    config?.infrastructure.provider === "aws"
      ? "EKS Pod Identity associations"
      : config?.infrastructure.provider === "gcp"
        ? "Workload Identity bindings"
        : config?.infrastructure.provider === "azure"
          ? "Azure federated identity credentials"
          : "Workload identity setup";

  return (
    <BorderBox title={`Deploying ${name}`}>
      <Box flexDirection="column" marginY={1}>
        <StatusLine status={status.preflight} label="Preflight checks" />
        <StatusLine
          status={status.kubeconfig}
          label="Kubernetes configuration"
        />
        <StatusLine status={status.federation} label={federationLabel} />
        {federationWarning && (
          <Box marginLeft={2}>
            <Text color={colors.warning}>{federationWarning}</Text>
          </Box>
        )}
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
        <StatusLine
          status={status.certCheck}
          label="TLS certificate verification"
        />

        <Box marginTop={1}>
          <Spinner label={getStepLabel(step, useExternalDns)} />
        </Box>
      </Box>
    </BorderBox>
  );
}

function getDnsFlushCommand(): string {
  switch (platform()) {
    case "darwin":
      return "sudo dscacheutil -flushcache && sudo killall -HUP mDNSResponder";
    case "win32":
      return "ipconfig /flushdns";
    default:
      return "sudo systemd-resolve --flush-caches";
  }
}

function getStepLabel(step: DeployStep, useExternalDns: boolean): string {
  switch (step) {
    case "loading":
      return "Loading configuration...";
    case "preflight":
      return "Running preflight checks...";
    case "kubeconfig":
      return "Refreshing kubeconfig...";
    case "helm-install":
      return useExternalDns
        ? "Installing Helm chart with TLS..."
        : "Installing Helm chart...";
    case "dns-wait":
      return "Waiting for DNS configuration...";
    case "helm-upgrade-tls":
      return "Enabling TLS certificates...";
    case "cert-check":
      return "Verifying TLS certificates...";
    default:
      return "Processing...";
  }
}

export function DeployCommand(props: DeployCommandProps) {
  return (
    <ThemeProvider theme="deploy">
      <Logo />
      <CommandApprovalProvider>
        <DeployCommandInner {...props} />
      </CommandApprovalProvider>
    </ThemeProvider>
  );
}
