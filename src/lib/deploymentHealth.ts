import { ZodError } from "zod";
import { updateKubeconfig } from "./cloudCli.js";
import { loadDeploymentConfig, loadDeploymentState } from "./config.js";
import { getInstalledVersion } from "./helm.js";
import {
  checkClusterAccessible,
  getPodStatus,
  type PodStatus,
} from "./kubernetes.js";
import {
  DeploymentConfig,
  DeploymentState,
  getNamespace,
  getReleaseName,
} from "../types/index.js";

export type DeploymentHealthKind =
  | "online"
  | "installed-unreachable"
  | "installed-degraded"
  | "not-installed"
  | "destroyed"
  | "cluster-unreachable"
  | "config-error";

export interface DeploymentHealth {
  name: string;
  kind: DeploymentHealthKind;
  config: DeploymentConfig | null;
  state: DeploymentState | null;
  namespace: string;
  releaseName: string;
  helmVersion: string | null;
  pods: PodStatus[];
  url: string | null;
  httpReachable: boolean;
  clusterError: string | null;
  configError: string | null;
}

interface LoadDeploymentHealthOptions {
  refreshKubeconfig?: boolean;
}

export function formatConfigError(error: unknown): string {
  if (error instanceof ZodError) {
    return error.issues
      .map((issue) => {
        const path = issue.path.length > 0 ? issue.path.join(".") : "config";
        return `${path}: ${issue.message}`;
      })
      .join("\n");
  }

  return error instanceof Error ? error.message : "Invalid deployment config";
}

export function arePodsHealthy(pods: PodStatus[]): boolean {
  if (pods.length === 0) return false;
  return pods.every(
    (pod) =>
      pod.ready || pod.status === "Succeeded" || pod.status === "Completed",
  );
}

export function classifyDeploymentHealth(input: {
  state: DeploymentState | null;
  helmVersion: string | null;
  pods: PodStatus[];
  httpReachable: boolean;
  clusterError?: string | null;
}): DeploymentHealthKind {
  if (input.clusterError) {
    return input.state?.status === "destroyed"
      ? "destroyed"
      : "cluster-unreachable";
  }

  if (!input.helmVersion) {
    return input.state?.status === "destroyed" ? "destroyed" : "not-installed";
  }

  if (!arePodsHealthy(input.pods)) {
    return "installed-degraded";
  }

  if (!input.httpReachable) {
    return "installed-unreachable";
  }

  return "online";
}

export async function checkDeploymentHttpHealth(
  deploymentUrl: string,
): Promise<boolean> {
  try {
    const baseUrl = deploymentUrl.startsWith("http")
      ? deploymentUrl
      : `https://${deploymentUrl}`;
    const cleanUrl = baseUrl.replace(/\/$/, "");
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10_000);

    try {
      const response = await fetch(`${cleanUrl}/api/health`, {
        method: "GET",
        signal: controller.signal,
        headers: { Accept: "application/json" },
      });
      clearTimeout(timeout);

      if (!response.ok) return false;
      const data = (await response.json()) as { status?: string };
      return data.status === "OK";
    } catch {
      clearTimeout(timeout);
      return false;
    }
  } catch {
    return false;
  }
}

async function ensureConfiguredCluster(
  config: DeploymentConfig,
  refreshKubeconfig: boolean,
): Promise<string | null> {
  let clusterError = await checkClusterAccessible();
  if (
    clusterError &&
    refreshKubeconfig &&
    config.infrastructure.provider &&
    config.infrastructure.region &&
    config.infrastructure.clusterName
  ) {
    try {
      await updateKubeconfig(
        config.infrastructure.provider,
        config.infrastructure.clusterName,
        config.infrastructure.region,
        {
          gcpProjectId: config.infrastructure.gcpProjectId,
          azureResourceGroup: config.infrastructure.azureResourceGroup,
        },
      );
      clusterError = await checkClusterAccessible();
    } catch (error) {
      const kubeconfigError =
        error instanceof Error ? error.message : "Unknown error";
      return `${clusterError}\nKubeconfig refresh failed: ${kubeconfigError}`;
    }
  }

  return clusterError;
}

export async function loadDeploymentHealth(
  name: string,
  options: LoadDeploymentHealthOptions = {},
): Promise<DeploymentHealth> {
  const state = await loadDeploymentState(name);
  const namespace = state?.application?.namespace || getNamespace(name);
  const releaseName = getReleaseName(name);

  let config: DeploymentConfig;
  try {
    config = await loadDeploymentConfig(name);
  } catch (error) {
    return {
      name,
      kind: "config-error",
      config: null,
      state,
      namespace,
      releaseName,
      helmVersion: null,
      pods: [],
      url: state?.application?.url || null,
      httpReachable: false,
      clusterError: null,
      configError: formatConfigError(error),
    };
  }

  const url = state?.application?.url || `https://${config.domain}`;
  const clusterError = await ensureConfiguredCluster(
    config,
    options.refreshKubeconfig ?? false,
  );

  if (clusterError) {
    return {
      name,
      kind: state?.status === "destroyed" ? "destroyed" : "cluster-unreachable",
      config,
      state,
      namespace,
      releaseName,
      helmVersion: null,
      pods: [],
      url,
      httpReachable: false,
      clusterError,
      configError: null,
    };
  }

  const [helmVersion, pods, httpReachable] = await Promise.all([
    getInstalledVersion(releaseName, namespace),
    getPodStatus(namespace),
    checkDeploymentHttpHealth(url),
  ]);

  const kind = classifyDeploymentHealth({
    state,
    helmVersion,
    pods,
    httpReachable,
  });

  return {
    name,
    kind,
    config,
    state,
    namespace,
    releaseName,
    helmVersion,
    pods,
    url,
    httpReachable,
    clusterError: null,
    configError: null,
  };
}
