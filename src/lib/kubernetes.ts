import { execa, ExecaError } from "execa";
import { DEFAULT_NAMESPACE, CloudProvider } from "../types/index.js";

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
        status: { conditions?: Array<{ type: string; status: string }> };
      }>;
    };

    return data.items.map((cert) => ({
      name: cert.metadata.name,
      dnsNames: cert.spec.dnsNames ?? [],
      ready:
        cert.status.conditions?.some(
          (c) => c.type === "Ready" && c.status === "True",
        ) ?? false,
    }));
  } catch {
    return [];
  }
}

export interface CertificateStatus {
  name: string;
  dnsNames: string[];
  ready: boolean;
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
export type LogLineCallback = (podName: string, line: string, colorIndex: number) => void;

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
          console.error(`${color}[${shortName}]${RESET_COLOR} \x1b[31m${errLine}${RESET_COLOR}`);
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

/**
 * Removes finalizers from KEDA ScaledObjects to prevent namespace deletion from hanging.
 * KEDA finalizers wait for the KEDA controller to clean up, but if KEDA is being deleted
 * with the namespace, this causes a deadlock.
 */
export async function removeKedaFinalizers(namespace: string): Promise<void> {
  try {
    // Get all ScaledObjects in the namespace
    const { stdout } = await execa(
      "kubectl",
      [
        "get",
        "scaledobjects.keda.sh",
        "-n",
        namespace,
        "-o",
        "jsonpath={.items[*].metadata.name}",
      ],
      { timeout: 15000 },
    );

    const scaledObjects = stdout.split(" ").filter(Boolean);

    // Patch each ScaledObject to remove finalizers
    for (const name of scaledObjects) {
      try {
        await execa(
          "kubectl",
          [
            "patch",
            "scaledobject",
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
        // Ignore errors - object might already be deleted
      }
    }
  } catch {
    // Ignore errors - KEDA CRDs might not be installed
  }
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
 * Waits for cluster to be accessible with retries.
 * EKS IAM authentication can take time to propagate after cluster creation.
 */
export async function waitForClusterAccess(
  maxRetries: number = 30,
  delayMs: number = 10000,
): Promise<void> {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      await execa("kubectl", ["cluster-info"]);
      return; // Success
    } catch (error) {
      if (attempt === maxRetries) {
        throw new Error(
          `Cluster not accessible after ${maxRetries} attempts. ` +
            `EKS IAM authentication may not have propagated yet. ` +
            `Please wait a few minutes and try again.\n${getErrorMessage(error)}`,
        );
      }
      // Wait before next retry
      await sleep(delayMs);
    }
  }
}

/**
 * Creates default StorageClass for the cloud provider.
 * Should be called after kubeconfig is configured and cluster is accessible.
 */
export async function createDefaultStorageClass(
  provider: CloudProvider,
): Promise<void> {
  // First wait for cluster to be accessible
  await waitForClusterAccess();

  let storageClassYaml: string;

  switch (provider) {
    case "aws":
      storageClassYaml = `
apiVersion: storage.k8s.io/v1
kind: StorageClass
metadata:
  name: gp3
  annotations:
    storageclass.kubernetes.io/is-default-class: "true"
provisioner: ebs.csi.aws.com
reclaimPolicy: Delete
volumeBindingMode: WaitForFirstConsumer
parameters:
  type: gp3
  encrypted: "true"
`;
      break;

    case "gcp":
      storageClassYaml = `
apiVersion: storage.k8s.io/v1
kind: StorageClass
metadata:
  name: pd-ssd
  annotations:
    storageclass.kubernetes.io/is-default-class: "true"
provisioner: pd.csi.storage.gke.io
reclaimPolicy: Delete
volumeBindingMode: WaitForFirstConsumer
parameters:
  type: pd-ssd
`;
      break;

    case "azure":
      storageClassYaml = `
apiVersion: storage.k8s.io/v1
kind: StorageClass
metadata:
  name: managed-premium
  annotations:
    storageclass.kubernetes.io/is-default-class: "true"
provisioner: disk.csi.azure.com
reclaimPolicy: Delete
volumeBindingMode: WaitForFirstConsumer
parameters:
  skuName: Premium_LRS
`;
      break;

    default:
      throw new Error(`Unsupported cloud provider: ${provider}`);
  }

  try {
    await execa("kubectl", ["apply", "-f", "-"], {
      input: storageClassYaml,
    });
  } catch (error) {
    throw new Error(
      `Failed to create StorageClass:\n${getErrorMessage(error)}`,
    );
  }
}

/**
 * Deployed image versions from Kubernetes
 */
export interface DeployedVersions {
  appVersion: string | null;
  hpsVersion: string | null;
}

/**
 * Extracts the version tag from a Docker image string.
 * E.g., "rulebricks/rulebricks:v1.5.8" -> "v1.5.8"
 */
function extractImageTag(image: string): string | null {
  if (!image) return null;
  const parts = image.split(":");
  if (parts.length < 2) return null;
  return parts[parts.length - 1];
}

/**
 * Gets the actual deployed image versions from Kubernetes deployments.
 * Queries the app and HPS deployments to get their current image tags.
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
  };

  // Get app deployment image
  try {
    const { stdout: appImage } = await execa("kubectl", [
      "get",
      "deployment",
      `${releaseName}-app`,
      "-n",
      namespace,
      "-o",
      "jsonpath={.spec.template.spec.containers[0].image}",
    ]);
    result.appVersion = extractImageTag(appImage.trim());
  } catch {
    // Deployment may not exist or cluster not accessible
  }

  // Get HPS deployment image
  try {
    const { stdout: hpsImage } = await execa("kubectl", [
      "get",
      "deployment",
      `${releaseName}-hps`,
      "-n",
      namespace,
      "-o",
      "jsonpath={.spec.template.spec.containers[0].image}",
    ]);
    result.hpsVersion = extractImageTag(hpsImage.trim());
  } catch {
    // Deployment may not exist or cluster not accessible
  }

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
