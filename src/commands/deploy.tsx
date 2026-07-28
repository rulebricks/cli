import React, { useCallback, useEffect, useState } from "react";
import { Box, Text, useApp } from "ink";
import { platform } from "os";
import { readFileSync } from "fs";
import { execa } from "execa";
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
  checkAzureKeyVaultDataPlaneAccess,
  ensureAcsCustomEmailDomainLinked,
  ensureAcsSmtpRoleAssignment,
  ensureAzurePostgresLogicalReplication,
  getAzureSubscriptionId,
  getAzureTenantId,
} from "../lib/cloudCli.js";
import {
  deriveConventionalAzureExternalDnsClientId,
  detectProvisionedSecretsBackend,
  ensureWorkloadIdentityFederation,
  verifyClusterAutoscalerIdentity,
  verifyManualKafkaAssociations,
  wantsManagedDns,
} from "../lib/workloadIdentity.js";
import {
  generateHelmValuesPreservingEdits,
  updateHelmValuesForTLS,
} from "../lib/helmValues.js";
import { resolveImageCatalog } from "../lib/imageCatalog.js";
import {
  ensureNamespace,
  applyDeploymentSecrets,
  applyExternalDnsAzureConfig,
  applyProvidedTlsSecrets,
} from "../lib/secrets.js";
import {
  planTlsSecrets,
  parseCertificate,
  TlsSecretPlan,
} from "../lib/tlsCerts.js";
import { setupExternalSecrets } from "../lib/eso.js";
import {
  runInstallSequence,
  secretModeForConfig,
  SecretMode,
} from "../lib/deploySequence.js";
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
  // Default (false): the config's secrets backend decides - "eso" (cloud
  // secrets manager synced by the External Secrets Operator, the default) or
  // "k8s" (CLI-created cluster Secrets, the "cluster" backend). Either way
  // the generated values carry only secretRef references.
  inlineSecrets?: boolean;
  // ESO backends only: overwrite provider entries with the config's values
  // (default is create-if-absent so client-rotated values are preserved).
  syncSecrets?: boolean;
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
  syncSecrets = false,
}: DeployCommandProps) {
  const { exit } = useApp();
  const { colors } = useTheme();
  const [step, setStep] = useState<DeployStep>("loading");
  const [config, setConfig] = useState<DeploymentConfig | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [useExternalDns, setUseExternalDns] = useState(false);
  const [tlsWarning, setTlsWarning] = useState<string | null>(null);
  const [federationWarning, setFederationWarning] = useState<string | null>(null);
  const [autoscalerWarning, setAutoscalerWarning] = useState<string | null>(null);
  const [dnsWarning, setDnsWarning] = useState<string | null>(null);
  const [secretsWarning, setSecretsWarning] = useState<string | null>(null);
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
      // Non-auto issuance: TLS has been live since the first install (no
      // ACME involved), so confirming DNS needs no TLS flip or upgrade.
      // External-issuer mode still waits on its Certificates going Ready;
      // provided certificates have nothing to issue at all.
      if (config.tls && config.tls.mode !== "auto") {
        const externalIssuer = config.tls.mode === "external-issuer";
        setStatus((s) => ({
          ...s,
          dnsConfig: "success",
          helmUpgradeTls: "skipped",
          certCheck: externalIssuer ? "running" : "skipped",
        }));
        if (externalIssuer) {
          setStep("cert-check");
          await verifyCertificates(getNamespace(config.name));
        }
        await markRunningState(config, getNamespace(config.name));
        setStep("complete");
        setTimeout(() => exit(), 5000);
        return;
      }

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
      // Non-auto TLS issuance (external issuer or provided certificates) has
      // no ACME dependency, so TLS is on from the very first install even
      // when DNS is managed manually.
      const tlsMode = cfg.tls?.mode ?? "auto";
      const tlsProvided = tlsMode === "provided";

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
      // Bring-your-own certificates: read and validate the PEM files now
      // (key pairing, expiry, SAN coverage of every served hostname) so a
      // gap fails here with the exact missing hostname instead of surfacing
      // as a TLS handshake error after install.
      let tlsSecretPlan: TlsSecretPlan = { entries: [], warnings: [] };
      if (tlsProvided) {
        tlsSecretPlan = planTlsSecrets(cfg, getReleaseName(cfg.name));
        if (tlsSecretPlan.warnings.length > 0) {
          setTlsWarning(tlsSecretPlan.warnings.join("\n"));
        }
      }
      // External issuer: probe that the referenced issuer actually exists so
      // a typo'd name surfaces now instead of as Certificates stuck in
      // Pending. Fail-open (warn) - the CRD may be unreadable to this
      // principal, or use naming this probe cannot derive.
      if (tlsMode === "external-issuer" && cfg.tls?.issuer?.name) {
        const issuer = cfg.tls.issuer;
        const resource = `${(issuer.kind || "ClusterIssuer").toLowerCase()}.${issuer.group || "cert-manager.io"}`;
        try {
          await execa("kubectl", ["get", resource, issuer.name]);
        } catch (probeError) {
          setTlsWarning(
            `Could not confirm the certificate issuer "${issuer.name}" (${resource}) exists: ` +
              `${probeError instanceof Error ? probeError.message.split("\n")[0] : String(probeError)}. ` +
              "If certificates stay Pending after install, verify the issuer name/kind with your platform team.",
          );
        }
      }
      // Private CA: confirm the root bundle is readable and parseable before
      // it gets baked into the values.
      if (tlsMode !== "auto" && cfg.tls?.caTrust === "private") {
        try {
          parseCertificate(readFileSync(cfg.tls.caBundleFile ?? "", "utf8"));
        } catch {
          throw new Error(
            `Cannot read or parse the private root CA bundle at: ${cfg.tls.caBundleFile}. ` +
              "It must be a PEM file containing your corporate root (and any intermediates).",
          );
        }
      }
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

      // The config's secrets backend decides the mode (ESO by default);
      // --inline-secrets remains the explicit dev/direct-chart escape hatch.
      const secretMode: SecretMode = inlineSecrets
        ? "inline"
        : secretModeForConfig(cfg);

      // Cluster-setup provisions a managed secrets backend (Key Vault /
      // Secrets Manager + a reader identity) when its secrets toggle is on.
      // Running in plain cluster-secrets mode against such a cluster is
      // almost always a config gap (hand-written or exported configs skip
      // the wizard's recommendation), so say it out loud - without blocking,
      // since cluster secrets are still a supported mode.
      if (secretMode === "k8s") {
        try {
          const provisionedBackend = await detectProvisionedSecretsBackend(cfg);
          if (provisionedBackend) {
            setSecretsWarning(
              `This deploy stores secrets as plain Kubernetes Secrets, but the cluster was provisioned with ${provisionedBackend}. ` +
                `To use it, set secrets.backend in the deployment config (rulebricks configure ${name}) and redeploy.`,
            );
          }
        } catch (secretsProbeError) {
          if (!(secretsProbeError instanceof CommandDeniedError)) {
            throw secretsProbeError;
          }
        }
      }

      // Secret seeding runs FROM THIS MACHINE via `az keyvault secret set`,
      // and enterprise vaults commonly disable public network access
      // (allowKeyVaultPublicAccess=false + private endpoint, the
      // cluster-setup production default). Probe the vault's data plane now
      // so the deploy stops with guidance instead of failing midway through
      // the install with a raw Azure error.
      if (
        secretMode === "eso" &&
        cfg.secrets?.backend === "azure-key-vault" &&
        cfg.secrets.azure?.vaultName
      ) {
        try {
          const probe = await checkAzureKeyVaultDataPlaneAccess(
            cfg.secrets.azure.vaultName,
          );
          if (!probe.ok) {
            const vault = cfg.secrets.azure.vaultName;
            if (probe.reason === "network") {
              throw new Error(
                [
                  `Key Vault "${vault}" rejected data-plane access from this machine - it appears to be network-restricted (public access disabled / private endpoint only).`,
                  "Secret seeding runs from the machine executing this deploy, so either:",
                  "  • Run the deploy from a network that can reach the vault's private endpoint (VPN, peering, or a jump host in the VNet), or",
                  "  • Temporarily allow this machine's IP on the vault firewall (az keyvault network-rule add), or",
                  "  • Pre-seed the secret entries from a trusted network, then re-run the deploy.",
                  probe.detail ? `\nAzure said: ${probe.detail}` : "",
                ].join("\n"),
              );
            }
            throw new Error(
              [
                `Key Vault "${vault}" denied this principal's data-plane access (RBAC).`,
                "Seeding secrets requires the Key Vault Secrets Officer role on the vault.",
                "  • cluster-setup grants it to keyVaultWriterPrincipalIds - add your object ID there, or",
                "  • Assign it directly: az role assignment create --role \"Key Vault Secrets Officer\" --assignee <your-object-id> --scope <vault-resource-id>",
                probe.detail ? `\nAzure said: ${probe.detail}` : "",
              ].join("\n"),
            );
          }
        } catch (probeError) {
          if (!(probeError instanceof CommandDeniedError)) {
            throw probeError;
          }
          // Denied probe: assume access and let seeding surface any issue.
        }
      }

      // Never ship a known-crashlooping autoscaler: when neither the
      // conventional cluster-setup role nor an existing association backs the
      // fixed "cluster-autoscaler" SA, disable it in the generated values and
      // say so instead of stalling helm --wait for the full timeout.
      let clusterAutoscalerIdentityMissing = false;
      try {
        const autoscalerIdentity = await verifyClusterAutoscalerIdentity(cfg);
        if (!autoscalerIdentity.ok) {
          clusterAutoscalerIdentityMissing = true;
          setAutoscalerWarning(
            `Node autoscaling is disabled for this deploy: no IAM credentials found for the cluster-autoscaler. ` +
              `Provision the ${cfg.infrastructure.clusterName}-cluster-autoscaler role (cluster-setup stack) or create a ` +
              `Pod Identity association for the "cluster-autoscaler" service account in ${namespace}, then redeploy.`,
          );
        }
      } catch (autoscalerError) {
        if (!(autoscalerError instanceof CommandDeniedError)) {
          throw autoscalerError;
        }
        // Denied cloud lookups: keep the autoscaler enabled and assume
        // manually-managed credentials, matching the federation fallback.
      }

      // Azure automatic DNS: external-dns's provider needs the workload
      // identity's client ID (values annotations) and an azure.json Secret
      // (subscription + zone resource group). All three are derivable from
      // the cluster-setup conventions; fail-open so a missing identity only
      // means external-dns can't write records (the deploy still proceeds).
      let externalDnsAzureClientId: string | undefined;
      let externalDnsAzureConfig:
        | { tenantId: string; subscriptionId: string; resourceGroup: string }
        | undefined;
      if (externalDnsEnabled && wantsManagedDns(cfg, "azure")) {
        try {
          const [clientId, subscriptionId, tenantId] = await Promise.all([
            deriveConventionalAzureExternalDnsClientId(cfg),
            getAzureSubscriptionId(),
            getAzureTenantId(),
          ]);
          const resourceGroup = cfg.infrastructure.azureResourceGroup;
          if (clientId && subscriptionId && tenantId && resourceGroup) {
            externalDnsAzureClientId = clientId;
            externalDnsAzureConfig = { tenantId, subscriptionId, resourceGroup };
          } else {
            setDnsWarning(
              `Automatic DNS may not work: the ${cfg.infrastructure.clusterName}-external-dns identity ` +
                `was not found (enable external-dns in cluster-setup, or manage records manually).`,
            );
          }
        } catch (dnsError) {
          if (!(dnsError instanceof CommandDeniedError)) {
            throw dnsError;
          }
        }
      }

      await runInstallSequence(
        {
          regenerateValues,
          tlsEnabled: externalDnsEnabled || tlsMode !== "auto",
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
              clusterAutoscalerIdentityMissing,
              externalDnsAzureClientId,
            }),
          validateValues: ensureGeneratedValuesValid,
          ensureNamespace: () => ensureNamespace(namespace),
          applySecrets: async () => {
            await applyDeploymentSecrets(cfg, namespace);
            if (externalDnsAzureConfig) {
              await applyExternalDnsAzureConfig(namespace, externalDnsAzureConfig);
            }
            if (tlsSecretPlan.entries.length > 0) {
              await applyProvidedTlsSecrets(namespace, tlsSecretPlan.entries);
            }
          },
          setupExternalSecrets: async () => {
            await setupExternalSecrets(cfg, { overwriteSecrets: syncSecrets });
            // TLS material is ingress plumbing, not an application secret -
            // it goes straight to Kubernetes even in ESO mode.
            if (tlsSecretPlan.entries.length > 0) {
              await applyProvidedTlsSecrets(namespace, tlsSecretPlan.entries);
            }
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
          certCheck: tlsProvided ? "skipped" : "running",
        }));

        // Provided certificates have no ACME issuance to wait on - the TLS
        // secrets were applied before the install.
        if (!tlsProvided) {
          setStep("cert-check");
          await verifyCertificates(namespace);
        }
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
          certCheck: tlsProvided ? "skipped" : "running",
        }));
        if (!tlsProvided) {
          setStep("cert-check");
          await verifyCertificates(namespace);
        }
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

    // Azure Flexible Server: cluster-setup configures wal_level=logical, but
    // static parameters only apply after a server restart that ARM cannot
    // perform. Self-heal instead of documenting a manual step: restart when
    // the change is pending (the database is idle on a first deploy; no-op on
    // every later one). Only a definitively wrong value blocks the deploy.
    if (
      pg?.mode === "external" &&
      pg.external?.provider === "azure" &&
      pg.external.host &&
      cfg.infrastructure.azureResourceGroup
    ) {
      const serverName = pg.external.host.split(".")[0];
      const wal = await ensureAzurePostgresLogicalReplication(
        pg.external.host,
        cfg.infrastructure.azureResourceGroup,
      );
      if (wal.status === "wrong-value") {
        throw new Error(
          `External Azure Postgres has wal_level=${wal.value}; Supabase Realtime requires "logical". ` +
            "Set it and restart the server before deploying:\n" +
            `  az postgres flexible-server parameter set --resource-group ${cfg.infrastructure.azureResourceGroup} --server-name ${serverName} --name wal_level --value logical\n` +
            `  az postgres flexible-server restart --resource-group ${cfg.infrastructure.azureResourceGroup} --name ${serverName}`,
        );
      }
    }

    // ACS branded email sender: verification and linking are control-plane
    // actions ARM cannot sequence, so self-heal here (same pattern as the
    // wal_level restart). Emails from an unlinked domain fail at send time
    // with no obvious cause, so a domain that cannot be verified blocks the
    // deploy with the fix instead.
    if (
      cfg.infrastructure.provider === "azure" &&
      cfg.smtp?.host === "smtp.azurecomm.net" &&
      cfg.smtp.from &&
      cfg.infrastructure.azureResourceGroup
    ) {
      // Grant the SMTP Entra app access to the communication service FIRST -
      // without it every send is unauthorized. cluster-setup no longer does
      // this (the app is created out-of-band), so the CLI owns it, matching
      // how SSO and workload identity are wired at deploy time.
      if (cfg.smtp.user) {
        const role = await ensureAcsSmtpRoleAssignment(
          cfg.smtp.user,
          cfg.infrastructure.azureResourceGroup,
        );
        if (role.status === "no-app") {
          throw new Error(
            `The email SMTP app (client ID ${role.detail}) was not found in this tenant. ` +
              "Create it before deploying:\n" +
              '  APP_ID=$(az ad app create --display-name "Rulebricks SMTP" --sign-in-audience AzureADMyOrg --query appId -o tsv)\n' +
              "  az ad sp create --id $APP_ID\n" +
              "  az ad app credential reset --id $APP_ID   # this secret is the SMTP password\n" +
              "Then set the SMTP username's app-ID segment to $APP_ID and redeploy.",
          );
        }
      }

      const acs = await ensureAcsCustomEmailDomainLinked(
        cfg.smtp.from,
        cfg.infrastructure.azureResourceGroup,
      );
      if (acs.status === "not-verified") {
        throw new Error(
          `The email sender domain "${acs.domain}" is not verified with Azure Communication Services (pending: ${acs.detail}). ` +
            "Verification was initiated and usually completes within minutes of the DNS records resolving.\n" +
            "  • If the domain is under the deployment's delegated zone, wait a few minutes and re-run this deploy.\n" +
            "  • Otherwise, publish the emailCustomDomainVerificationRecords deployment output at your DNS provider first.\n" +
            "  • Or set smtp.from back to the Azure-managed sender (the emailSenderAddress output) to send immediately.",
        );
      }
    }

    // AWS MSK IAM without Pod Identity credentials wedges the topic-provision
    // pre-install hook until the helm timeout ("no EC2 IMDS role found"), so
    // fail in seconds here instead. Deploy covers the common case itself by
    // deriving the cluster-setup role (<cluster>-data-access, or the earlier
    // <cluster>-rulebricks name); this only fires
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
          `The cluster-setup role (${cluster}-data-access) was not found (or its ` +
          "trust policy does not allow pods.eks.amazonaws.com), and no existing " +
          "Pod Identity associations cover these service accounts.\n\n" +
          "Fix one of:\n" +
          "  - Run the Rulebricks AWS cluster-setup stack, which provisions the " +
          `${cluster}-data-access role deploy binds automatically.\n` +
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
            {autoscalerWarning && (
              <Box marginTop={1}>
                <Text color={colors.warning}>⚠ {autoscalerWarning}</Text>
              </Box>
            )}
            {dnsWarning && (
              <Box marginTop={1}>
                <Text color={colors.warning}>⚠ {dnsWarning}</Text>
              </Box>
            )}
            {secretsWarning && (
              <Box marginTop={1}>
                <Text color={colors.warning}>⚠ {secretsWarning}</Text>
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
        {autoscalerWarning && (
          <Box marginLeft={2}>
            <Text color={colors.warning}>{autoscalerWarning}</Text>
          </Box>
        )}
        {dnsWarning && (
          <Box marginLeft={2}>
            <Text color={colors.warning}>{dnsWarning}</Text>
          </Box>
        )}
        {secretsWarning && (
          <Box marginLeft={2}>
            <Text color={colors.warning}>{secretsWarning}</Text>
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
