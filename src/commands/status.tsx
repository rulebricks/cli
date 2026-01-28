import React, { useState, useEffect } from "react";
import { Box, Text, useApp } from "ink";
import {
  BorderBox,
  Section,
  Spinner,
  ThemeProvider,
  useTheme,
  Logo,
} from "../components/common/index.js";
import { loadDeploymentConfig, loadDeploymentState } from "../lib/config.js";
import {
  getPodStatus,
  getServiceStatus,
  getIngressStatus,
  getCertificateStatus,
  PodStatus,
  ServiceStatus,
  IngressStatus,
  CertificateStatus,
} from "../lib/kubernetes.js";
import { getInstalledVersion } from "../lib/helm.js";
import {
  DeploymentConfig,
  DeploymentState,
  getNamespace,
  getReleaseName,
} from "../types/index.js";
import { CommandTheme } from "../lib/theme.js";

interface StatusCommandProps {
  name: string;
}

interface ClusterStatus {
  pods: PodStatus[];
  services: ServiceStatus[];
  ingresses: IngressStatus[];
  certificates: CertificateStatus[];
  version: string | null;
}

interface LoadedData {
  config: DeploymentConfig;
  state: DeploymentState | null;
  clusterStatus: ClusterStatus;
}

function StatusCommandInner({
  name,
  data,
}: StatusCommandProps & { data: LoadedData }) {
  const { exit } = useApp();
  const { colors } = useTheme();

  const { config, state, clusterStatus } = data;

  useEffect(() => {
    // Auto-exit after displaying
    const timer = setTimeout(() => exit(), 10000);
    return () => clearTimeout(timer);
  }, [exit]);

  // Determine overall status based on deployment state and pod health
  const getOverallStatus = () => {
    // If no state file exists, deployment was never attempted
    if (!state) return "not-deployed";

    // Check the deployment state status
    if (state.status === "failed") return "failed";
    if (state.status === "destroyed") return "destroyed";
    if (state.status === "pending") return "pending";
    if (state.status === "deploying") return "deploying";
    if (state.status === "waiting-dns") return "waiting-dns";

    // If state says running, verify with actual pod status
    const pods = clusterStatus.pods || [];
    if (pods.length === 0) {
      // No pods means something is wrong (unless still deploying)
      return state.status === "running" ? "degraded" : "unknown";
    }

    // Consider a pod healthy if it's ready OR if it's a completed Job pod
    const allPodsHealthy = pods.every(
      (p) => p.ready || p.status === "Succeeded" || p.status === "Completed",
    );
    return allPodsHealthy ? "healthy" : "degraded";
  };

  const overallStatus = getOverallStatus();

  const statusDisplay: Record<
    string,
    { icon: string; label: string; color: string }
  > = {
    healthy: { icon: "●", label: "Healthy", color: colors.success },
    degraded: { icon: "◐", label: "Degraded", color: colors.warning },
    failed: { icon: "✗", label: "Failed", color: colors.error },
    destroyed: { icon: "○", label: "Destroyed", color: colors.muted },
    pending: { icon: "○", label: "Pending", color: colors.muted },
    deploying: { icon: "◐", label: "Deploying", color: colors.accent },
    "waiting-dns": {
      icon: "◐",
      label: "Waiting for DNS",
      color: colors.warning,
    },
    "not-deployed": { icon: "○", label: "Not Deployed", color: colors.muted },
    unknown: { icon: "?", label: "Unknown", color: colors.muted },
  };

  const status = statusDisplay[overallStatus] || statusDisplay["unknown"];

  return (
    <BorderBox title={`Status: ${name}`}>
      <Box flexDirection="column">
        {/* Overview */}
        <Section title="Overview">
          <Text>
            Status:{" "}
            <Text color={status.color}>
              {status.icon} {status.label}
            </Text>
          </Text>
          {state && (
            <Text>
              Version:{" "}
              <Text color={colors.accent}>
                {clusterStatus.version || "Unknown"}
              </Text>
            </Text>
          )}
          <Text>
            URL: <Text color={colors.accent}>https://{config.domain}</Text>
          </Text>
        </Section>

        {/* Not Deployed message */}
        {overallStatus === "not-deployed" && (
          <Box marginY={1} flexDirection="column">
            <Text color={colors.muted}>
              This configuration has not been deployed yet.
            </Text>
            <Box marginTop={0}>
              <Text color={colors.muted}>
                Run: <Text color={colors.accent}>rulebricks deploy {name}</Text>
              </Text>
            </Box>
          </Box>
        )}

        {/* Only show infrastructure sections when deployment has been attempted */}
        {state && (
          <>
            {/* Pods */}
            <Section title="Pods">
              {clusterStatus.pods.length === 0 ? (
                <Text color={colors.muted}>No pods found</Text>
              ) : (
                clusterStatus.pods.map((pod) => {
                  // Consider pod healthy if ready OR if it's a completed Job
                  const isHealthy =
                    pod.ready ||
                    pod.status === "Succeeded" ||
                    pod.status === "Completed";
                  return (
                    <Box key={pod.name}>
                      <Text color={isHealthy ? colors.success : colors.warning}>
                        {isHealthy ? "✓" : "○"}
                      </Text>
                      <Text> {truncate(pod.name, 40)}</Text>
                      <Text color={colors.muted}> {pod.status}</Text>
                      {pod.restarts > 0 && (
                        <Text color={colors.warning}>
                          {" "}
                          ({pod.restarts} restarts)
                        </Text>
                      )}
                    </Box>
                  );
                })
              )}
            </Section>

            {/* Services */}
            <Section title="Services">
              {clusterStatus.services.length === 0 ? (
                <Text color={colors.muted}>No services found</Text>
              ) : (
                clusterStatus.services.slice(0, 5).map((svc) => (
                  <Box key={svc.name}>
                    <Text color={colors.success}>✓</Text>
                    <Text> {truncate(svc.name, 30)}</Text>
                    <Text color={colors.muted}> {svc.type}</Text>
                    {svc.externalIP && (
                      <Text color={colors.accent}> → {svc.externalIP}</Text>
                    )}
                  </Box>
                ))
              )}
              {(clusterStatus.services.length || 0) > 5 && (
                <Text color={colors.muted}>
                  ... and {(clusterStatus.services.length || 0) - 5} more
                </Text>
              )}
            </Section>

            {/* Ingress */}
            <Section title="Ingress">
              {clusterStatus.ingresses.length === 0 ? (
                <Text color={colors.muted}>No ingresses found</Text>
              ) : (
                clusterStatus.ingresses.map((ing) => (
                  <Box key={ing.name} flexDirection="column">
                    <Box>
                      <Text
                        color={ing.address ? colors.success : colors.warning}
                      >
                        {ing.address ? "✓" : "○"}
                      </Text>
                      <Text> {ing.name}</Text>
                    </Box>
                    {ing.hosts.map((host) => (
                      <Box key={host} marginLeft={2}>
                        <Text color={colors.muted}>
                          → {host} {ing.tls ? "(TLS)" : ""}
                        </Text>
                      </Box>
                    ))}
                  </Box>
                ))
              )}
            </Section>

            {/* Certificates */}
            <Section title="TLS Certificates">
              {clusterStatus.certificates.length === 0 ? (
                <Text color={colors.muted}>No certificates found</Text>
              ) : (
                clusterStatus.certificates.map((cert) => (
                  <Box key={cert.name}>
                    <Text color={cert.ready ? colors.success : colors.warning}>
                      {cert.ready ? "✓" : "○"}
                    </Text>
                    <Text> {cert.name}</Text>
                    <Text color={cert.ready ? colors.success : colors.warning}>
                      {cert.ready ? " Ready" : " Pending"}
                    </Text>
                  </Box>
                ))
              )}
            </Section>
          </>
        )}

        <Box marginTop={1}>
          <Text color={colors.muted}>Press Ctrl+C to exit</Text>
        </Box>
      </Box>
    </BorderBox>
  );
}

/**
 * Loader component that fetches data and determines the appropriate theme
 */
function StatusLoader({ name }: StatusCommandProps) {
  const [loading, setLoading] = useState(true);
  const [data, setData] = useState<LoadedData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [theme, setTheme] = useState<CommandTheme>("status");

  useEffect(() => {
    loadStatus();
  }, []);

  async function loadStatus() {
    try {
      const config = await loadDeploymentConfig(name);
      const state = await loadDeploymentState(name);

      // Determine theme based on whether deployment was attempted
      // Use 'logs' theme (gray/muted) for undeployed, 'status' (green) for deployed
      const selectedTheme: CommandTheme = state ? "status" : "logs";
      setTheme(selectedTheme);

      // Use namespace from state if available (backwards compat), otherwise compute from deployment name
      const namespace = state?.application?.namespace || getNamespace(name);
      const releaseName = getReleaseName(name);

      const [pods, services, ingresses, certificates, version] =
        await Promise.all([
          getPodStatus(namespace),
          getServiceStatus(namespace),
          getIngressStatus(namespace),
          getCertificateStatus(namespace),
          getInstalledVersion(releaseName, namespace),
        ]);

      setData({
        config,
        state,
        clusterStatus: { pods, services, ingresses, certificates, version },
      });
      setLoading(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load status");
      setLoading(false);
    }
  }

  if (loading) {
    return (
      <ThemeProvider theme="logs">
        <Logo />
        <BorderBox title={`Status: ${name}`}>
          <Box marginY={1}>
            <Spinner label="Loading deployment status..." />
          </Box>
        </BorderBox>
      </ThemeProvider>
    );
  }

  if (error || !data) {
    return (
      <ThemeProvider theme="logs">
        <Logo />
        <BorderBox title="Status Error">
          <Box marginY={1}>
            <Text color="red">
              ✗ {error || "Failed to load deployment data"}
            </Text>
          </Box>
        </BorderBox>
      </ThemeProvider>
    );
  }

  return (
    <ThemeProvider theme={theme}>
      <Logo />
      <StatusCommandInner name={name} data={data} />
    </ThemeProvider>
  );
}

export function StatusCommand(props: StatusCommandProps) {
  return <StatusLoader {...props} />;
}

function truncate(str: string, len: number): string {
  if (str.length <= len) return str;
  return str.substring(0, len - 3) + "...";
}
