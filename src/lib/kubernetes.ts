import { execa, ExecaError } from "execa";
import { DEFAULT_NAMESPACE, NodeArchitecture } from "../types/index.js";

/**
 * Extracts meaningful error message from execa error
 */
function getErrorMessage(error: unknown): string {
  const execaError = error as ExecaError;
  const output = execaError.stderr || execaError.stdout || "";
  if (output) {
    const truncated = output.length > 500 ? "..." + output.slice(-500) : output;
    return truncated;
  }
  return execaError.shortMessage || execaError.message || "Unknown error";
}

/**
 * Sleep for a specified number of milliseconds
 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Checks if kubectl is installed
 */
export async function isKubectlInstalled(): Promise<boolean> {
  try {
    await execa("kubectl", ["version", "--client"]);
    return true;
  } catch {
    return false;
  }
}

/**
 * Gets the kubectl client version
 */
export async function getKubectlVersion(): Promise<string> {
  const { stdout } = await execa("kubectl", [
    "version",
    "--client",
    "-o",
    "json",
  ]);
  const info = JSON.parse(stdout) as { clientVersion: { gitVersion: string } };
  return info.clientVersion.gitVersion;
}

/**
 * Checks if the cluster is accessible
 */
export async function isClusterAccessible(): Promise<boolean> {
  try {
    await execa("kubectl", ["cluster-info"]);
    return true;
  } catch {
    return false;
  }
}

/**
 * Checks if the cluster is accessible and returns error details if not.
 * Returns null if accessible, or an error message string if not.
 */
export async function checkClusterAccessible(): Promise<string | null> {
  try {
    await execa("kubectl", ["cluster-info"]);
    return null;
  } catch (error) {
    const execaError = error as ExecaError;

    // Build helpful error message with context
    const parts: string[] = [];

    // Get current context for debugging
    let currentContext = "";
    try {
      const { stdout: context } = await execa("kubectl", [
        "config",
        "current-context",
      ]);
      currentContext = context.trim();
      parts.push(`Current context: ${currentContext}`);
    } catch {
      parts.push("No kubectl context is currently set");
    }

    // Include the actual error output (but truncate the repetitive memcache errors)
    const stderr = execaError.stderr?.trim() || "";
    const stdout = execaError.stdout?.trim() || "";
    const rawOutput = stderr || stdout;

    // Clean up verbose/repetitive kubectl errors
    const outputLines = rawOutput.split("\n");
    const seenErrors = new Set<string>();
    const cleanedLines = outputLines.filter((line) => {
      // Skip repetitive memcache errors, keep just one
      if (line.includes("memcache.go") && line.includes("Unhandled Error")) {
        const key = "memcache-unhandled";
        if (seenErrors.has(key)) return false;
        seenErrors.add(key);
        return false; // Skip all memcache lines, they're noise
      }
      return true;
    });

    const output = cleanedLines.join("\n").trim();
    if (output) {
      parts.push(`Error: ${output}`);
    } else if (execaError.message) {
      parts.push(`Error: ${execaError.message}`);
    }

    // Detect specific error patterns and provide targeted suggestions
    const isEksCluster =
      currentContext.includes("eks") || currentContext.includes("arn:aws");
    const isGkeCluster =
      currentContext.includes("gke_") || currentContext.includes("gke-");
    const isAksCluster =
      currentContext.includes("aks") || currentContext.includes("azure");
    const isCredentialsError =
      rawOutput.includes("provide credentials") ||
      rawOutput.includes("Unauthorized") ||
      rawOutput.includes("authentication");
    const isConnectionError =
      rawOutput.includes("connection refused") ||
      rawOutput.includes("no such host") ||
      rawOutput.includes("timeout");

    parts.push("");
    parts.push("Suggestions:");

    if (isEksCluster && isCredentialsError) {
      // EKS-specific authentication issue
      parts.push(
        "  • Verify AWS credentials are configured: aws sts get-caller-identity",
      );
      parts.push("  • Check if AWS CLI profile matches: aws configure list");
      parts.push(
        "  • Refresh kubeconfig: aws eks update-kubeconfig --name <cluster-name> --region <region>",
      );
      parts.push(
        "  • Ensure your IAM user/role has EKS cluster access permissions",
      );
      parts.push(
        "  • If using SSO, refresh session: aws sso login --profile <profile>",
      );
    } else if (isGkeCluster && isCredentialsError) {
      // GKE-specific authentication issue
      parts.push("  • Verify gcloud auth: gcloud auth list");
      parts.push(
        "  • Refresh credentials: gcloud container clusters get-credentials <cluster> --region <region>",
      );
      parts.push("  • Check project: gcloud config get-value project");
    } else if (isAksCluster && isCredentialsError) {
      // AKS-specific authentication issue
      parts.push("  • Verify Azure CLI login: az account show");
      parts.push(
        "  • Refresh credentials: az aks get-credentials --name <cluster> --resource-group <rg>",
      );
    } else if (isConnectionError) {
      // Connection/network issues
      parts.push("  • Check if the cluster is running and accessible");
      parts.push("  • Verify network connectivity to the cluster endpoint");
      parts.push("  • Check if VPN connection is required");
    } else {
      // Generic suggestions
      parts.push("  • Verify your kubeconfig is correct: kubectl config view");
      parts.push(
        "  • Check the current context: kubectl config current-context",
      );
      parts.push("  • Test cluster access: kubectl cluster-info");
      parts.push("  • Ensure your credentials are valid and not expired");
    }

    return parts.join("\n");
  }
}

/**
 * Gets the current kubectl context
 */
export async function getCurrentContext(): Promise<string | null> {
  try {
    const { stdout } = await execa("kubectl", ["config", "current-context"]);
    return stdout.trim();
  } catch {
    return null;
  }
}

function parseCpuToCores(cpu: string): number {
  if (cpu.endsWith("n")) return Number(cpu.slice(0, -1)) / 1_000_000_000;
  if (cpu.endsWith("u")) return Number(cpu.slice(0, -1)) / 1_000_000;
  if (cpu.endsWith("m")) return Number(cpu.slice(0, -1)) / 1_000;
  return Number(cpu);
}

function parseMemoryToGi(memory: string): number {
  const match = memory.match(/^(\d+(?:\.\d+)?)([KMGTP]i?|[kMGTPE])?$/);
  if (!match) return 0;

  const value = Number(match[1]);
  const unit = match[2] || "";
  const multipliers: Record<string, number> = {
    Ki: 1 / 1024 / 1024,
    Mi: 1 / 1024,
    Gi: 1,
    Ti: 1024,
    Pi: 1024 * 1024,
    K: 1000 / 1024 / 1024 / 1024,
    M: 1000 ** 2 / 1024 ** 3,
    G: 1000 ** 3 / 1024 ** 3,
    T: 1000 ** 4 / 1024 ** 3,
    P: 1000 ** 5 / 1024 ** 3,
  };

  return value * (multipliers[unit] ?? 1 / 1024 ** 3);
}

function roundUpForEligibility(value: number): number {
  return Math.ceil(value);
}

/**
 * Inferred resource and scheduling capabilities for the current cluster.
 */
export interface ClusterStorageClass {
  name: string;
  provisioner: string;
  isDefault: boolean;
  volumeBindingMode?: string;
  allowVolumeExpansion?: boolean;
}

export interface ClusterCapabilities {
  nodeArchitecture: NodeArchitecture;
  arm64TolerationRequired: boolean;
  schedulableNodeCount: number;
  totalCpuCores: number;
  totalMemoryGi: number;
  eligibleCpuCores: number;
  eligibleMemoryGi: number;
  totalPersistentStorageGi?: number;
  storageClasses: ClusterStorageClass[];
  defaultStorageClass?: ClusterStorageClass;
  storageClass?: string;
  storageProvisioner?: string;
}

function normalizeNodeArchitecture(architecture?: string): "amd64" | "arm64" | null {
  if (architecture === "amd64" || architecture === "x86_64") return "amd64";
  if (architecture === "arm64" || architecture === "aarch64") return "arm64";
  return null;
}

function summarizeNodeArchitecture(
  architectures: Set<"amd64" | "arm64">,
): NodeArchitecture {
  if (architectures.size === 0) return "unknown";
  if (architectures.size > 1) return "mixed";
  return architectures.has("arm64") ? "arm64" : "amd64";
}

async function getStorageClasses(): Promise<ClusterStorageClass[]> {
  try {
    const { stdout } = await execa(
      "kubectl",
      ["get", "storageclass", "-o", "json"],
      { timeout: 15000 },
    );
    const data = JSON.parse(stdout) as {
      items?: Array<{
        metadata?: {
          name?: string;
          annotations?: Record<string, string | undefined>;
        };
        provisioner?: string;
        volumeBindingMode?: string;
        allowVolumeExpansion?: boolean;
      }>;
    };

    return (data.items ?? [])
      .map((storageClass) => {
        const annotations = storageClass.metadata?.annotations ?? {};
        return {
          name: storageClass.metadata?.name || "",
          provisioner: storageClass.provisioner || "",
          isDefault:
            annotations["storageclass.kubernetes.io/is-default-class"] ===
              "true" ||
            annotations["storageclass.beta.kubernetes.io/is-default-class"] ===
              "true",
          volumeBindingMode: storageClass.volumeBindingMode,
          allowVolumeExpansion: storageClass.allowVolumeExpansion,
        };
      })
      .filter((storageClass) => storageClass.name);
  } catch {
    return [];
  }
}

async function getPersistentStorageCapacityGi(
  storageClassName?: string,
): Promise<number | undefined> {
  if (!storageClassName) return undefined;

  try {
    const { stdout } = await execa(
      "kubectl",
      ["get", "csistoragecapacity", "-A", "-o", "json"],
      { timeout: 15000 },
    );
    const data = JSON.parse(stdout) as {
      items?: Array<{
        storageClassName?: string;
        capacity?: string;
      }>;
    };

    const capacities =
      data.items
        ?.filter((item) => item.storageClassName === storageClassName)
        .map((item) => parseMemoryToGi(item.capacity || "0"))
        .filter((capacity) => capacity > 0) ?? [];

    if (capacities.length === 0) return undefined;

    return capacities.reduce((sum, capacity) => sum + capacity, 0);
  } catch {
    return undefined;
  }
}

/**
 * Inspects the current cluster's node architecture, schedulable capacity, and
 * storage classes. The CLI uses this to keep Helm values compatible with the
 * Kubernetes resources the user has already made available (storage class, ARM
 * tolerations, etc.); workload sizing itself follows the chart defaults.
 */
export async function inferClusterCapabilities(): Promise<ClusterCapabilities | null> {
  try {
    const { stdout } = await execa("kubectl", ["get", "nodes", "-o", "json"], {
      timeout: 15000,
    });
    const data = JSON.parse(stdout) as {
      items?: Array<{
        metadata?: {
          labels?: Record<string, string | undefined>;
        };
        spec?: {
          unschedulable?: boolean;
          taints?: Array<{
            key?: string;
            value?: string;
            effect?: string;
          }>;
        };
        status?: {
          allocatable?: {
            cpu?: string;
            memory?: string;
          };
          nodeInfo?: {
            architecture?: string;
          };
        };
      }>;
    };

    const schedulableNodes =
      data.items?.filter((node) => !node.spec?.unschedulable) ?? [];

    let totalCpu = 0;
    let totalMemoryGi = 0;
    let arm64TolerationRequired = false;
    const architectures = new Set<"amd64" | "arm64">();

    for (const node of schedulableNodes) {
      totalCpu += parseCpuToCores(node.status?.allocatable?.cpu || "0");
      totalMemoryGi += parseMemoryToGi(node.status?.allocatable?.memory || "0");

      const architecture = normalizeNodeArchitecture(
        node.status?.nodeInfo?.architecture ||
          node.metadata?.labels?.["kubernetes.io/arch"] ||
          node.metadata?.labels?.["beta.kubernetes.io/arch"],
      );
      if (architecture) {
        architectures.add(architecture);
      }

      if (
        architecture === "arm64" &&
        node.spec?.taints?.some(
          (taint) =>
            taint.key === "kubernetes.io/arch" &&
            taint.value === "arm64" &&
            taint.effect === "NoSchedule",
        )
      ) {
        arm64TolerationRequired = true;
      }
    }

    const storageClasses = await getStorageClasses();
    const defaultStorageClass =
      storageClasses.find((storageClass) => storageClass.isDefault) ??
      storageClasses[0];
    const totalPersistentStorageGi = await getPersistentStorageCapacityGi(
      defaultStorageClass?.name,
    );

    return {
      nodeArchitecture: summarizeNodeArchitecture(architectures),
      arm64TolerationRequired,
      schedulableNodeCount: schedulableNodes.length,
      totalCpuCores: totalCpu,
      totalMemoryGi,
      eligibleCpuCores: roundUpForEligibility(totalCpu),
      eligibleMemoryGi: roundUpForEligibility(totalMemoryGi),
      totalPersistentStorageGi,
      storageClasses,
      defaultStorageClass,
      storageClass: defaultStorageClass?.name,
      storageProvisioner: defaultStorageClass?.provisioner,
    };
  } catch {
    return null;
  }
}

/**
 * Gets pod status for the Rulebricks namespace
 */
export async function getPodStatus(
  namespace: string = DEFAULT_NAMESPACE,
): Promise<PodStatus[]> {
  try {
    const { stdout } = await execa("kubectl", [
      "get",
      "pods",
      "-n",
      namespace,
      "-o",
      "json",
    ]);

    const data = JSON.parse(stdout) as {
      items: Array<{
        metadata: { name: string };
        status: {
          phase: string;
          containerStatuses?: Array<{
            name: string;
            ready: boolean;
            restartCount: number;
          }>;
        };
      }>;
    };

    return data.items.map((pod) => ({
      name: pod.metadata.name,
      status: pod.status.phase,
      ready: pod.status.containerStatuses?.every((c) => c.ready) ?? false,
      restarts:
        pod.status.containerStatuses?.reduce(
          (sum, c) => sum + c.restartCount,
          0,
        ) ?? 0,
    }));
  } catch {
    return [];
  }
}

export interface PodStatus {
  name: string;
  status: string;
  ready: boolean;
  restarts: number;
}

/**
 * Gets service status for the Rulebricks namespace
 */
export async function getServiceStatus(
  namespace: string = DEFAULT_NAMESPACE,
): Promise<ServiceStatus[]> {
  try {
    const { stdout } = await execa("kubectl", [
      "get",
      "services",
      "-n",
      namespace,
      "-o",
      "json",
    ]);

    const data = JSON.parse(stdout) as {
      items: Array<{
        metadata: { name: string };
        spec: { type: string; ports?: Array<{ port: number }> };
        status: {
          loadBalancer?: {
            ingress?: Array<{ hostname?: string; ip?: string }>;
          };
        };
      }>;
    };

    return data.items.map((svc) => ({
      name: svc.metadata.name,
      type: svc.spec.type,
      ports: svc.spec.ports?.map((p) => p.port) ?? [],
      externalIP:
        svc.status.loadBalancer?.ingress?.[0]?.hostname ||
        svc.status.loadBalancer?.ingress?.[0]?.ip ||
        null,
    }));
  } catch {
    return [];
  }
}

export interface ServiceStatus {
  name: string;
  type: string;
  ports: number[];
  externalIP: string | null;
}

/**
 * Gets ingress status for the Rulebricks namespace
 */
export async function getIngressStatus(
  namespace: string = DEFAULT_NAMESPACE,
): Promise<IngressStatus[]> {
  try {
    const { stdout } = await execa("kubectl", [
      "get",
      "ingress",
      "-n",
      namespace,
      "-o",
      "json",
    ]);

    const data = JSON.parse(stdout) as {
      items: Array<{
        metadata: { name: string };
        spec: {
          rules?: Array<{ host: string }>;
          tls?: Array<{ hosts: string[] }>;
        };
        status: {
          loadBalancer?: {
            ingress?: Array<{ hostname?: string; ip?: string }>;
          };
        };
      }>;
    };

    return data.items.map((ing) => ({
      name: ing.metadata.name,
      hosts: ing.spec.rules?.map((r) => r.host) ?? [],
      tls: (ing.spec.tls?.length ?? 0) > 0,
      address:
        ing.status.loadBalancer?.ingress?.[0]?.hostname ||
        ing.status.loadBalancer?.ingress?.[0]?.ip ||
        null,
    }));
  } catch {
    return [];
  }
}

export interface IngressStatus {
  name: string;
  hosts: string[];
  tls: boolean;
  address: string | null;
}

/**
 * Gets certificate status
 */
export async function getCertificateStatus(
  namespace: string = DEFAULT_NAMESPACE,
): Promise<CertificateStatus[]> {
  try {
    const { stdout } = await execa("kubectl", [
      "get",
      "certificates",
      "-n",
      namespace,
      "-o",
      "json",
    ]);

    const data = JSON.parse(stdout) as {
      items: Array<{
        metadata: { name: string };
        spec: { dnsNames?: string[] };
        status: {
          conditions?: Array<{
            type: string;
            status: string;
            reason?: string;
            message?: string;
          }>;
        };
      }>;
    };

    return data.items.map((cert) => {
      const readyCond = cert.status.conditions?.find(
        (c) => c.type === "Ready",
      );
      const issuingCond = cert.status.conditions?.find(
        (c) => c.type === "Issuing",
      );
      const ready = readyCond?.status === "True";
      const failed =
        !ready &&
        issuingCond?.status === "False" &&
        issuingCond?.reason === "Failed";

      return {
        name: cert.metadata.name,
        dnsNames: cert.spec.dnsNames ?? [],
        ready,
        failed: failed ?? false,
        message: failed ? issuingCond?.message : readyCond?.message,
      };
    });
  } catch {
    return [];
  }
}

export interface CertificateStatus {
  name: string;
  dnsNames: string[];
  ready: boolean;
  failed: boolean;
  message?: string;
}

/**
 * Deletes a failed cert-manager Certificate and recreates it from its spec,
 * bypassing cert-manager's exponential backoff on failed issuance attempts.
 * The delete cascades to the failed CertificateRequest and ACME Order via
 * owner references, so the recreated Certificate starts with a clean slate.
 */
export async function recreateFailedCertificate(
  namespace: string,
  certName: string,
): Promise<boolean> {
  try {
    const { stdout } = await execa("kubectl", [
      "get",
      "certificate",
      certName,
      "-n",
      namespace,
      "-o",
      "json",
    ]);

    const cert = JSON.parse(stdout) as {
      metadata: {
        name: string;
        namespace: string;
        labels?: Record<string, string>;
        annotations?: Record<string, string>;
      };
      spec: Record<string, unknown>;
    };

    const recreated = {
      apiVersion: "cert-manager.io/v1",
      kind: "Certificate",
      metadata: {
        name: cert.metadata.name,
        namespace: cert.metadata.namespace,
        ...(cert.metadata.labels ? { labels: cert.metadata.labels } : {}),
        ...(cert.metadata.annotations
          ? { annotations: cert.metadata.annotations }
          : {}),
      },
      spec: cert.spec,
    };

    await execa("kubectl", ["delete", "certificate", certName, "-n", namespace]);
    await execa("kubectl", ["apply", "-f", "-"], {
      input: JSON.stringify(recreated),
    });

    return true;
  } catch {
    return false;
  }
}

/**
 * Polls cert-manager Certificates until all are Ready, with automatic retry
 * for transient ACME failures (e.g. order finalization race conditions).
 *
 * On failure detection: deletes and recreates the Certificate resource to
 * bypass cert-manager's 1-hour exponential backoff, then continues polling.
 *
 * Throws on timeout with details about which certs are not ready.
 * Returns silently if no Certificate resources exist in the namespace.
 */
export async function waitForCertificatesReady(
  namespace: string,
  options?: {
    timeoutMs?: number;
    pollIntervalMs?: number;
    maxRetries?: number;
  },
): Promise<void> {
  const {
    timeoutMs = 120_000,
    pollIntervalMs = 5_000,
    maxRetries = 1,
  } = options ?? {};

  let retriesUsed = 0;
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const certs = await getCertificateStatus(namespace);

    if (certs.length === 0) return;
    if (certs.every((c) => c.ready)) return;

    const failed = certs.filter((c) => c.failed);
    if (failed.length > 0 && retriesUsed < maxRetries) {
      for (const cert of failed) {
        await recreateFailedCertificate(namespace, cert.name);
      }
      retriesUsed++;
    }

    await sleep(pollIntervalMs);
  }

  // Final check after timeout
  const certs = await getCertificateStatus(namespace);
  if (certs.length > 0 && certs.every((c) => c.ready)) return;

  const notReady = certs.filter((c) => !c.ready);
  if (notReady.length > 0) {
    const details = notReady
      .map((c) => `  ${c.name}: ${c.message || "not ready"}`)
      .join("\n");
    throw new Error(
      `TLS certificates not ready after ${timeoutMs / 1000}s:\n${details}\n\n` +
        `Run 'rulebricks status' to check certificate status.`,
    );
  }
}

/**
 * Streams logs from a pod
 */
export async function streamLogs(
  podName: string,
  namespace: string = DEFAULT_NAMESPACE,
  options: {
    follow?: boolean;
    tail?: number;
    container?: string;
  } = {},
): Promise<void> {
  const { follow = false, tail = 100, container } = options;

  const args = ["logs", podName, "-n", namespace];

  if (follow) {
    args.push("-f");
  }

  if (tail) {
    args.push("--tail", String(tail));
  }

  if (container) {
    args.push("-c", container);
  }

  await execa("kubectl", args, { stdio: "inherit" });
}

export async function execInPod(
  namespace: string,
  podName: string,
  container: string | undefined,
  args: string[],
): Promise<string> {
  const kubectlArgs = ["exec", "-n", namespace, podName];
  if (container) {
    kubectlArgs.push("-c", container);
  }
  kubectlArgs.push("--", ...args);

  try {
    const { stdout } = await execa("kubectl", kubectlArgs);
    return stdout;
  } catch (error) {
    throw new Error(`Failed to exec into pod ${podName}:\n${getErrorMessage(error)}`);
  }
}

export interface EphemeralJobOptions {
  name: string;
  namespace: string;
  serviceAccountName: string;
  image: string;
  command: string[];
  env?: Array<Record<string, unknown>>;
  volumeMounts?: Array<Record<string, unknown>>;
  volumes?: Array<Record<string, unknown>>;
  // Optional init containers (run to completion before the main container),
  // e.g. an rclone download that hands off to a postgres pg_restore via a shared
  // emptyDir. Each entry is a raw container spec.
  initContainers?: Array<Record<string, unknown>>;
  labels?: Record<string, string>;
  backoffLimit?: number;
  timeoutSeconds?: number;
}

export interface EphemeralJobResult {
  jobName: string;
  logs: string;
}

export async function runEphemeralJob(
  options: EphemeralJobOptions,
): Promise<EphemeralJobResult> {
  const {
    name,
    namespace,
    serviceAccountName,
    image,
    command,
    env = [],
    volumeMounts = [],
    volumes = [],
    initContainers = [],
    labels = {},
    backoffLimit = 0,
    timeoutSeconds = 3600,
  } = options;

  const podSpec: Record<string, unknown> = {
    restartPolicy: "Never",
    serviceAccountName,
    containers: [
      {
        name: "job",
        image,
        imagePullPolicy: "IfNotPresent",
        command,
        env,
        volumeMounts,
      },
    ],
    volumes,
  };
  if (initContainers.length > 0) {
    podSpec.initContainers = initContainers;
  }

  const manifest = {
    apiVersion: "batch/v1",
    kind: "Job",
    metadata: {
      name,
      namespace,
      labels,
    },
    spec: {
      backoffLimit,
      template: {
        metadata: {
          labels,
        },
        spec: podSpec,
      },
    },
  };

  try {
    await execa("kubectl", [
      "delete",
      "job",
      name,
      "-n",
      namespace,
      "--ignore-not-found=true",
    ]);
    await execa("kubectl", ["apply", "-f", "-"], {
      input: JSON.stringify(manifest),
    });
    await execa("kubectl", [
      "wait",
      "--for=condition=complete",
      `job/${name}`,
      "-n",
      namespace,
      `--timeout=${timeoutSeconds}s`,
    ]);

    const logs = await getJobLogs(name, namespace);
    return { jobName: name, logs };
  } catch (error) {
    const logs = await getJobLogs(name, namespace).catch(() => "");
    const failed = await isJobFailed(name, namespace).catch(() => false);
    if (failed) {
      throw new Error(`Job ${name} failed:\n${logs || getErrorMessage(error)}`);
    }
    throw new Error(`Job ${name} did not complete:\n${logs || getErrorMessage(error)}`);
  }
}

export async function createJobFromCronJob(
  namespace: string,
  cronJobName: string,
  jobName: string,
): Promise<void> {
  try {
    await execa("kubectl", [
      "delete",
      "job",
      jobName,
      "-n",
      namespace,
      "--ignore-not-found=true",
    ]);
    await execa("kubectl", [
      "create",
      "job",
      jobName,
      "-n",
      namespace,
      `--from=cronjob/${cronJobName}`,
    ]);
  } catch (error) {
    throw new Error(`Failed to create backup job:\n${getErrorMessage(error)}`);
  }
}

export async function waitForJobComplete(
  namespace: string,
  jobName: string,
  timeoutSeconds = 3600,
): Promise<string> {
  try {
    await execa("kubectl", [
      "wait",
      "--for=condition=complete",
      `job/${jobName}`,
      "-n",
      namespace,
      `--timeout=${timeoutSeconds}s`,
    ]);
    return await getJobLogs(jobName, namespace);
  } catch (error) {
    const logs = await getJobLogs(jobName, namespace).catch(() => "");
    const failed = await isJobFailed(jobName, namespace).catch(() => false);
    if (failed) {
      throw new Error(`Job ${jobName} failed:\n${logs || getErrorMessage(error)}`);
    }
    throw new Error(`Timed out waiting for job ${jobName}:\n${logs || getErrorMessage(error)}`);
  }
}

export async function getJobLogs(
  jobName: string,
  namespace: string,
): Promise<string> {
  const { stdout } = await execa("kubectl", [
    "logs",
    `job/${jobName}`,
    "-n",
    namespace,
    "--all-containers=true",
  ]);
  return stdout;
}

async function isJobFailed(jobName: string, namespace: string): Promise<boolean> {
  const { stdout } = await execa("kubectl", [
    "get",
    "job",
    jobName,
    "-n",
    namespace,
    "-o",
    "jsonpath={.status.failed}",
  ]);
  return Number.parseInt(stdout || "0", 10) > 0;
}

export async function scaleDeployment(
  namespace: string,
  name: string,
  replicas: number,
): Promise<void> {
  try {
    await execa("kubectl", [
      "scale",
      "deployment",
      name,
      "-n",
      namespace,
      `--replicas=${replicas}`,
    ]);
  } catch (error) {
    throw new Error(`Failed to scale deployment ${name}:\n${getErrorMessage(error)}`);
  }
}

export async function waitForDeploymentReady(
  namespace: string,
  name: string,
  timeoutSeconds = 600,
): Promise<void> {
  try {
    await execa("kubectl", [
      "rollout",
      "status",
      `deployment/${name}`,
      "-n",
      namespace,
      `--timeout=${timeoutSeconds}s`,
    ]);
  } catch (error) {
    throw new Error(`Deployment ${name} is not ready:\n${getErrorMessage(error)}`);
  }
}

export async function getDeploymentReplicas(
  namespace: string,
  name: string,
): Promise<number | null> {
  try {
    const { stdout } = await execa("kubectl", [
      "get",
      "deployment",
      name,
      "-n",
      namespace,
      "-o",
      "jsonpath={.spec.replicas}",
    ]);
    return Number.parseInt(stdout || "0", 10);
  } catch {
    return null;
  }
}

/**
 * Colors for multi-pod log prefixes
 */
const POD_COLORS = [
  "\x1b[36m", // cyan
  "\x1b[33m", // yellow
  "\x1b[35m", // magenta
  "\x1b[32m", // green
  "\x1b[34m", // blue
  "\x1b[91m", // bright red
  "\x1b[92m", // bright green
  "\x1b[93m", // bright yellow
];
const RESET_COLOR = "\x1b[0m";

/**
 * Callback type for receiving log lines from multiple pods
 */
export type LogLineCallback = (
  podName: string,
  line: string,
  colorIndex: number,
) => void;

/**
 * Streams logs from multiple pods simultaneously.
 * Each log line is prefixed with the pod name and a unique color.
 * Returns a cleanup function to stop all log streams.
 */
export function streamMultiPodLogs(
  podNames: string[],
  namespace: string,
  options: {
    follow?: boolean;
    tail?: number;
    timestamps?: boolean;
    onLine?: LogLineCallback;
  } = {},
): () => void {
  const { follow = true, tail = 100, timestamps = false, onLine } = options;
  const processes: Array<{ kill: (signal?: string) => void }> = [];

  // Spawn a kubectl logs process for each pod
  podNames.forEach((podName, index) => {
    const args = ["logs", podName, "-n", namespace];

    if (follow) {
      args.push("-f");
    }

    if (tail) {
      args.push("--tail", String(tail));
    }

    if (timestamps) {
      args.push("--timestamps");
    }

    const colorIndex = index % POD_COLORS.length;
    const color = POD_COLORS[colorIndex];

    // Shorten pod name for display (take last 2 segments or truncate)
    const shortName = shortenPodName(podName);

    const proc = execa("kubectl", args);
    processes.push(proc);

    // Handle stdout line by line
    if (proc.stdout) {
      let buffer = "";
      proc.stdout.on("data", (chunk: Buffer) => {
        buffer += chunk.toString();
        const lines = buffer.split("\n");
        // Keep the last incomplete line in buffer
        buffer = lines.pop() || "";

        for (const line of lines) {
          if (line.trim()) {
            if (onLine) {
              onLine(podName, line, colorIndex);
            } else {
              // Default: print to stdout with colored prefix
              const prefix = `${color}[${shortName}]${RESET_COLOR}`;
              console.log(`${prefix} ${line}`);
            }
          }
        }
      });

      // Flush any remaining buffer on close
      proc.stdout.on("close", () => {
        if (buffer.trim()) {
          if (onLine) {
            onLine(podName, buffer, colorIndex);
          } else {
            const prefix = `${color}[${shortName}]${RESET_COLOR}`;
            console.log(`${prefix} ${buffer}`);
          }
        }
      });
    }

    // Handle stderr - print errors but continue
    if (proc.stderr) {
      proc.stderr.on("data", (chunk: Buffer) => {
        const errLine = chunk.toString().trim();
        if (errLine) {
          console.error(
            `${color}[${shortName}]${RESET_COLOR} \x1b[31m${errLine}${RESET_COLOR}`,
          );
        }
      });
    }

    // Ignore process exit errors (happens on cleanup)
    proc.catch(() => {});
  });

  // Return cleanup function
  return () => {
    for (const proc of processes) {
      try {
        proc.kill("SIGTERM");
      } catch {
        // Process may have already exited
      }
    }
  };
}

/**
 * Shortens a pod name for display in log prefixes.
 * E.g., "rulebricks-app-7f8b9c6d5-x2k4m" -> "app-x2k4m"
 */
function shortenPodName(podName: string): string {
  const parts = podName.split("-");
  if (parts.length >= 3) {
    // Try to find the component name and keep it with the random suffix
    // Pattern: <release>-<component>-<hash>-<suffix> or <component>-<hash>-<suffix>
    const suffix = parts[parts.length - 1];

    // Find meaningful component name (skip 'rulebricks' prefix)
    let componentIndex = 0;
    if (parts[0] === "rulebricks" || parts[0].length > 10) {
      componentIndex = 1;
    }

    const component = parts[componentIndex] || parts[0];
    return `${component}-${suffix}`;
  }
  // If name is short enough, return as-is
  return podName.length > 20 ? podName.substring(0, 17) + "..." : podName;
}

/**
 * Gets pods by label selector
 */
export async function getPodsByLabel(
  labelSelector: string,
  namespace: string = DEFAULT_NAMESPACE,
): Promise<string[]> {
  try {
    const { stdout } = await execa("kubectl", [
      "get",
      "pods",
      "-n",
      namespace,
      "-l",
      labelSelector,
      "-o",
      "jsonpath={.items[*].metadata.name}",
    ]);

    return stdout.split(" ").filter(Boolean);
  } catch {
    return [];
  }
}

/**
 * List of valid component names for log viewing
 */
export const VALID_LOG_COMPONENTS = [
  "app",
  "hps",
  "workers",
  "kafka",
  "supabase",
  "traefik",
  "redis",
];

/**
 * Pod name patterns for each component.
 * Used to filter pods by name when label selectors may vary.
 */
const COMPONENT_POD_PATTERNS: Record<string, string[]> = {
  app: ["app", "rulebricks-app"],
  hps: ["hps", "rulebricks-hps"],
  workers: ["hps-worker", "worker"],
  kafka: ["kafka"],
  supabase: ["supabase", "db", "postgres"],
  traefik: ["traefik"],
  redis: ["redis", "dragonfly", "keydb"],
};

/**
 * Gets pods for a specific component in a deployment.
 * Queries all pods in the namespace and filters by component name patterns.
 * This approach works for all components including subcharts like Traefik
 * that may have different instance labels than the parent release.
 */
export async function getComponentPods(
  component: string,
  _releaseName: string,
  namespace: string,
): Promise<string[]> {
  if (!VALID_LOG_COMPONENTS.includes(component)) {
    return [];
  }

  try {
    // Get all pods in the namespace - subcharts like Traefik may have
    // different instance labels, so we can't rely on a single label selector
    const { stdout } = await execa("kubectl", [
      "get",
      "pods",
      "-n",
      namespace,
      "-o",
      "jsonpath={.items[*].metadata.name}",
    ]);

    const pods = stdout.split(" ").filter(Boolean);

    // Filter pods by component name patterns
    const patterns = COMPONENT_POD_PATTERNS[component] || [component];
    const matchingPods = pods.filter((podName) => {
      const lowerPodName = podName.toLowerCase();
      return patterns.some((pattern) =>
        lowerPodName.includes(pattern.toLowerCase()),
      );
    });

    return matchingPods;
  } catch {
    return [];
  }
}

/**
 * Deletes a namespace
 */
export async function deleteNamespace(
  namespace: string,
  options: { wait?: boolean } = {},
): Promise<void> {
  const { wait = false } = options;
  try {
    const args = ["delete", "namespace", namespace];
    if (wait) {
      args.push("--wait=true");
    }
    // 60 second timeout to prevent hanging
    await execa("kubectl", args, { timeout: 60000 });
  } catch (error) {
    const execaError = error as ExecaError;
    const errorMsg = execaError.stderr || execaError.message || "";
    // Ignore "not found" errors and timeouts - namespace may already be deleted
    if (!errorMsg.includes("not found") && !execaError.timedOut) {
      throw new Error(`Failed to delete namespace:\n${getErrorMessage(error)}`);
    }
  }
}

/**
 * Deletes all PVCs in a namespace
 */
export async function deletePVCs(
  namespace: string,
  options: { wait?: boolean } = {},
): Promise<void> {
  const { wait = false } = options;
  try {
    const args = ["delete", "pvc", "--all", "-n", namespace];
    if (wait) {
      args.push("--wait=true");
    }
    // 60 second timeout to prevent hanging
    await execa("kubectl", args, { timeout: 60000 });
  } catch (error) {
    const execaError = error as ExecaError;
    const errorMsg = execaError.stderr || execaError.message || "";
    // Ignore "not found" errors, "No resources", and timeouts
    if (
      !errorMsg.includes("not found") &&
      !errorMsg.includes("No resources found") &&
      !execaError.timedOut
    ) {
      throw new Error(`Failed to delete PVCs:\n${getErrorMessage(error)}`);
    }
  }
}

// Custom resources whose operator sets a finalizer that only that operator can
// clear. When the operator is uninstalled with the release, those finalizers are
// never removed and wedge the namespace (and the CRD) in Terminating forever.
// Observed blockers: KEDA ScaledObjects, cert-manager ACME Challenges/Orders, and
// Strimzi Kafka resources.
const FINALIZER_BLOCKING_CR_TYPES = [
  "scaledobjects.keda.sh",
  "scaledjobs.keda.sh",
  "challenges.acme.cert-manager.io",
  "orders.acme.cert-manager.io",
  "certificaterequests.cert-manager.io",
  "certificates.cert-manager.io",
  "kafkatopics.kafka.strimzi.io",
  "kafkausers.kafka.strimzi.io",
  "kafkanodepools.kafka.strimzi.io",
  "kafkas.kafka.strimzi.io",
];

/**
 * Strips finalizers from the custom resources whose controllers are torn down
 * with the release, so the namespace can finalize instead of hanging in
 * Terminating (NamespaceFinalizersRemaining). Best-effort per type; a missing
 * CRD (feature disabled) or already-gone object is fine.
 */
export async function removeBlockingFinalizers(namespace: string): Promise<void> {
  for (const resourceType of FINALIZER_BLOCKING_CR_TYPES) {
    try {
      const { stdout } = await execa(
        "kubectl",
        [
          "get",
          resourceType,
          "-n",
          namespace,
          "-o",
          "jsonpath={.items[*].metadata.name}",
        ],
        { timeout: 15000 },
      );
      const names = stdout.split(" ").filter(Boolean);
      for (const name of names) {
        try {
          await execa(
            "kubectl",
            [
              "patch",
              resourceType,
              name,
              "-n",
              namespace,
              "-p",
              '{"metadata":{"finalizers":null}}',
              "--type=merge",
            ],
            { timeout: 15000 },
          );
        } catch {
          // Ignore; object might already be deleted.
        }
      }
    } catch {
      // Ignore; this CRD might not be installed (feature disabled).
    }
  }
}

/**
 * Deletes aggregated APIServices (apiregistration.k8s.io) whose backing service
 * lives in the given namespace.
 *
 * Why this matters for teardown: an aggregated API (e.g. KEDA's
 * v1beta1.external.metrics.k8s.io, prometheus-adapter's custom.metrics.k8s.io,
 * etc.) is served by an in-namespace Service. When the namespace is torn down
 * that Service disappears and the (cluster-scoped) APIService goes Unavailable
 * with ServiceNotFound. The namespace controller must enumerate every API group
 * to delete a namespace's contents, so a single broken APIService makes its
 * discovery step fail and wedges the namespace in Terminating forever
 * (NamespaceDeletionDiscoveryFailure) - which then rejects any reinstall into
 * that namespace ("being terminated").
 *
 * Deleting these APIServices up front (they are going away with the namespace
 * anyway) keeps discovery healthy so the namespace can finalize. This is
 * generalized to ALL APIServices backed by the target namespace, not just KEDA,
 * and is safe: cluster APIs backed by other namespaces (e.g. metrics-server in
 * kube-system) are never matched. Listing APIService objects is served directly
 * by kube-apiserver, so this also works to rescue an already-stuck namespace.
 *
 * Returns the names of the APIServices that were deleted.
 */
export async function cleanupNamespaceAPIServices(
  namespace: string,
): Promise<string[]> {
  const deleted: string[] = [];
  try {
    const { stdout } = await execa(
      "kubectl",
      ["get", "apiservices", "-o", "json"],
      { timeout: 30000 },
    );
    const parsed = JSON.parse(stdout) as {
      items?: Array<{
        metadata?: { name?: string };
        spec?: { service?: { namespace?: string } | null };
      }>;
    };
    for (const item of parsed.items ?? []) {
      const name = item.metadata?.name;
      if (!name) continue;
      if (item.spec?.service?.namespace === namespace) {
        try {
          await execa(
            "kubectl",
            ["delete", "apiservice", name, "--ignore-not-found"],
            { timeout: 30000 },
          );
          deleted.push(name);
        } catch {
          // Best-effort: a single failure should not block teardown.
        }
      }
    }
  } catch {
    // Best-effort: if APIServices can't be listed, don't block the destroy.
  }
  return deleted;
}

/**
 * Checks if a namespace exists
 */
export async function namespaceExists(namespace: string): Promise<boolean> {
  try {
    await execa("kubectl", ["get", "namespace", namespace], { timeout: 15000 });
    return true;
  } catch {
    return false;
  }
}

/**
 * Removes this release's leftovers in the kube-system namespace. The
 * kube-prometheus-stack prometheus-operator creates a "<release>-...-kubelet"
 * Service there at runtime (via its --kubelet-service flag); it lives OUTSIDE the
 * release namespace and is operator-created (not chart-templated), so
 * `helm uninstall` never deletes it and one accumulates per deployment. Also
 * sweeps any helm-labeled kube-system objects (exporter Services/Endpoints) a
 * partial uninstall may have stranded. Scoped strictly to this release; matched
 * by the release-name prefix so a coexisting deployment's kubelet Service is
 * never touched. Best-effort; never blocks teardown.
 */
export async function cleanupKubeSystemLeftovers(
  releaseName: string,
): Promise<void> {
  // 1) helm-labeled kube-system objects from this release (only present if a
  //    prior uninstall didn't finish): the kube-prometheus-stack exporter
  //    Services (coredns/kube-controller-manager/etc.) and their Endpoints.
  try {
    await execa(
      "kubectl",
      [
        "delete",
        "service,endpoints",
        "-n",
        "kube-system",
        "-l",
        `release=${releaseName}`,
        "--ignore-not-found",
      ],
      { timeout: 30000 },
    );
  } catch {
    // best-effort
  }
  // 2) the operator-created kubelet Service, matched by name (it carries no
  //    reliable per-release label). Name is "<release>-<kube-prometheus>-kubelet"
  //    (the middle segment is truncated by the helm fullname template). The
  //    trailing "-" in the prefix guard prevents matching a sibling whose name
  //    is a prefix of this one (e.g. az-p0 vs az-p055).
  try {
    const { stdout } = await execa(
      "kubectl",
      [
        "get",
        "service",
        "-n",
        "kube-system",
        "-o",
        "jsonpath={.items[*].metadata.name}",
      ],
      { timeout: 15000 },
    );
    const targets = stdout
      .split(" ")
      .filter(Boolean)
      .filter((n) => n.startsWith(`${releaseName}-`) && n.endsWith("-kubelet"));
    for (const name of targets) {
      try {
        await execa(
          "kubectl",
          ["delete", "service", name, "-n", "kube-system", "--ignore-not-found"],
          { timeout: 30000 },
        );
      } catch {
        // best-effort
      }
    }
  } catch {
    // best-effort
  }
}

/**
 * True only when no OTHER Rulebricks deployment remains on the cluster (besides
 * `releaseName`). Gates deletion of cluster-SHARED resources (CRDs) so tearing
 * down one deployment never cascade-deletes another deployment's custom
 * resources. Deployments are named `rulebricks-<name>` for both the namespace and
 * the helm release (see getNamespace/getReleaseName), so the "rulebricks-" prefix
 * is a sound cluster-side signal. Fails CLOSED (returns false) if the cluster
 * can't be enumerated; we never purge shared resources on uncertainty.
 */
export async function isLastRulebricksDeployment(
  releaseName: string,
): Promise<boolean> {
  try {
    // Authoritative: helm releases cluster-wide.
    const { stdout } = await execa("helm", ["list", "-A", "-o", "json"], {
      timeout: 30000,
    });
    const releases = JSON.parse(stdout) as Array<{ name?: string }>;
    const otherReleases = releases.filter(
      (r) =>
        typeof r.name === "string" &&
        r.name.startsWith("rulebricks-") &&
        r.name !== releaseName,
    );
    if (otherReleases.length > 0) return false;

    // Cross-check namespaces in case a release secret is gone but the ns lingers
    // (namespace name == release name by convention).
    const { stdout: nsOut } = await execa(
      "kubectl",
      ["get", "namespaces", "-o", "jsonpath={.items[*].metadata.name}"],
      { timeout: 15000 },
    );
    const otherNamespaces = nsOut
      .split(" ")
      .filter(Boolean)
      .filter((n) => n.startsWith("rulebricks-") && n !== releaseName);
    return otherNamespaces.length === 0;
  } catch {
    return false; // fail closed; do not purge shared resources on uncertainty
  }
}

// CRD API-group suffixes the chart ships in crds/ dirs (cert-manager + keda from
// the parent crds/, strimzi + kube-prometheus-stack from subchart crds/). helm
// NEVER deletes crds/ contents on uninstall, so they leak and accumulate.
const RULEBRICKS_CRD_GROUP_SUFFIXES = [
  ".strimzi.io", // kafka.strimzi.io, core.strimzi.io
  "cert-manager.io", // cert-manager.io, acme.cert-manager.io
  ".keda.sh", // keda.sh, eventing.keda.sh
  "monitoring.coreos.com", // kube-prometheus-stack
];

/**
 * Deletes the cluster-scoped CRDs the chart installs from crds/ dirs (cert-
 * manager, keda, strimzi, kube-prometheus-stack). CLUSTER-SHARED: deleting a CRD
 * cascade-deletes every custom resource of that kind across ALL namespaces, so
 * callers MUST gate this on isLastRulebricksDeployment() (or an explicit
 * operator --purge); never call it while another Rulebricks deployment exists.
 * Best-effort, non-blocking; returns the CRD names removed.
 */
export async function deleteRulebricksCRDs(): Promise<string[]> {
  const deleted: string[] = [];
  try {
    const { stdout } = await execa(
      "kubectl",
      ["get", "crd", "-o", "jsonpath={.items[*].metadata.name}"],
      { timeout: 30000 },
    );
    const targets = stdout
      .split(" ")
      .filter(Boolean)
      .filter((name) =>
        RULEBRICKS_CRD_GROUP_SUFFIXES.some((suffix) => name.endsWith(suffix)),
      );
    for (const name of targets) {
      try {
        await execa(
          "kubectl",
          ["delete", "crd", name, "--ignore-not-found", "--wait=false"],
          { timeout: 30000 },
        );
        deleted.push(name);
      } catch {
        // best-effort: a single CRD failure should not block teardown
      }
    }
  } catch {
    // best-effort: if CRDs can't be listed, don't block the destroy
  }
  return deleted;
}

/**
 * Deployed image versions from Kubernetes
 */
export interface DeployedVersions {
  appVersion: string | null;
  hpsVersion: string | null;
  hpsWorkerVersion: string | null;
  appDigest: string | null;
  hpsDigests: string[];
  hpsWorkerDigests: string[];
}

/**
 * Extracts the version tag from a Docker image string.
 * E.g., "rulebricks/rulebricks:v1.5.8" -> "v1.5.8"
 */
export function extractImageTag(image: string): string | null {
  if (!image) return null;
  const parts = image.split(":");
  if (parts.length < 2) return null;
  return parts[parts.length - 1];
}

export function extractImageDigest(imageId: string): string | null {
  const digest = imageId.split("@").pop();
  return digest?.startsWith("sha256:") ? digest : null;
}

async function getWorkloadImage(
  workloadType: "deployment" | "statefulset",
  name: string,
  namespace: string,
): Promise<string | null> {
  try {
    const { stdout } = await execa("kubectl", [
      "get",
      workloadType,
      name,
      "-n",
      namespace,
      "-o",
      "jsonpath={.spec.template.spec.containers[0].image}",
    ]);
    return stdout.trim() || null;
  } catch {
    return null;
  }
}

async function getPodImageDigests(
  releaseName: string,
  workloadName: string,
  namespace: string,
  containerName: string,
): Promise<string[]> {
  try {
    const { stdout } = await execa("kubectl", [
      "get",
      "pods",
      "-n",
      namespace,
      "-l",
      `app.kubernetes.io/name=${workloadName},app.kubernetes.io/instance=${releaseName}`,
      "-o",
      "json",
    ]);
    const data = JSON.parse(stdout) as {
      items?: Array<{
        status?: {
          containerStatuses?: Array<{
            name: string;
            imageID?: string;
          }>;
        };
      }>;
    };

    return Array.from(
      new Set(
        (data.items || [])
          .flatMap((pod) => pod.status?.containerStatuses || [])
          .filter((status) => status.name === containerName)
          .map((status) => extractImageDigest(status.imageID || ""))
          .filter((digest): digest is string => Boolean(digest)),
      ),
    );
  } catch {
    return [];
  }
}

/**
 * Gets actual deployed image tags and running image digests from Kubernetes.
 * HPS runs as StatefulSets, so digest checks inspect the pods behind those sets.
 *
 * @param releaseName - The Helm release name (e.g., "rulebricks")
 * @param namespace - The Kubernetes namespace
 * @returns DeployedVersions with app and HPS versions, or null if not found
 */
export async function getDeployedImageVersions(
  releaseName: string,
  namespace: string,
): Promise<DeployedVersions> {
  const result: DeployedVersions = {
    appVersion: null,
    hpsVersion: null,
    hpsWorkerVersion: null,
    appDigest: null,
    hpsDigests: [],
    hpsWorkerDigests: [],
  };

  const appName = `${releaseName}-app`;
  const hpsName = `${releaseName}-hps`;
  const hpsWorkerName = `${releaseName}-hps-worker`;

  const [appImage, hpsImage, hpsWorkerImage] = await Promise.all([
    getWorkloadImage("deployment", appName, namespace),
    getWorkloadImage("statefulset", hpsName, namespace),
    getWorkloadImage("statefulset", hpsWorkerName, namespace),
  ]);

  result.appVersion = appImage ? extractImageTag(appImage) : null;
  result.hpsVersion = hpsImage ? extractImageTag(hpsImage) : null;
  result.hpsWorkerVersion = hpsWorkerImage
    ? extractImageTag(hpsWorkerImage)?.replace(/^worker-/, "") || null
    : null;

  const [appDigests, hpsDigests, hpsWorkerDigests] = await Promise.all([
    getPodImageDigests(releaseName, appName, namespace, "app"),
    getPodImageDigests(releaseName, hpsName, namespace, "hps"),
    getPodImageDigests(releaseName, hpsWorkerName, namespace, "hps-worker"),
  ]);

  result.appDigest = appDigests[0] || null;
  result.hpsDigests = hpsDigests;
  result.hpsWorkerDigests = hpsWorkerDigests;

  return result;
}

/**
 * Kubernetes workload types that support rollout restart
 */
export type WorkloadType = "deployment" | "statefulset" | "daemonset";

/**
 * Performs a rollout restart on a Kubernetes workload (deployment, statefulset, or daemonset).
 * This forces pods to be recreated, pulling fresh images if pullPolicy is Always.
 *
 * @param workloadType - The type of workload (deployment, statefulset, daemonset)
 * @param name - The name of the workload to restart
 * @param namespace - The Kubernetes namespace
 * @returns true if restart was successful, false if workload doesn't exist or failed
 */
export async function rolloutRestart(
  workloadType: WorkloadType,
  name: string,
  namespace: string,
): Promise<boolean> {
  try {
    await execa("kubectl", [
      "rollout",
      "restart",
      workloadType,
      name,
      "-n",
      namespace,
    ]);
    return true;
  } catch {
    // Workload may not exist or cluster not accessible
    return false;
  }
}
