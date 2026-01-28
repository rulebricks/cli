import * as dns from "dns";
import { execa } from "execa";
import { DNSRecord, DEFAULT_NAMESPACE } from "../types/index.js";

/**
 * DNS resolvers to try in order:
 * - null = system default
 * - Google Public DNS
 * - Cloudflare DNS
 */
const DNS_RESOLVERS: (string[] | null)[] = [
  null, // System default
  ["8.8.8.8", "8.8.4.4"], // Google
  ["1.1.1.1", "1.0.0.1"], // Cloudflare
];

/** Timeout for each DNS lookup attempt (ms) */
const DNS_TIMEOUT_MS = 5000;

/**
 * Helper to detect if a string is an IP address
 */
function isIPAddress(target: string): boolean {
  return /^(\d{1,3}\.){3}\d{1,3}$/.test(target);
}

/**
 * Helper to check if CNAME records match expected target
 */
function cnameMatchesTarget(
  cnameRecords: string[],
  expectedTarget: string,
): boolean {
  return cnameRecords.some(
    (r) =>
      r === expectedTarget ||
      r.endsWith(expectedTarget) ||
      r.replace(/\.$/, "") === expectedTarget.replace(/\.$/, ""),
  );
}

/**
 * Wrap a promise with a timeout
 */
function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("DNS lookup timeout")), ms);
    promise
      .then((result) => {
        clearTimeout(timer);
        resolve(result);
      })
      .catch((err) => {
        clearTimeout(timer);
        reject(err);
      });
  });
}

/**
 * Create promisified resolver functions for a specific DNS server
 */
function createResolver(servers: string[] | null): {
  resolve4: (hostname: string) => Promise<string[]>;
  resolveCname: (hostname: string) => Promise<string[]>;
} {
  const resolver = new dns.Resolver();
  if (servers) {
    resolver.setServers(servers);
  }

  return {
    resolve4: (hostname: string) =>
      new Promise((resolve, reject) => {
        resolver.resolve4(hostname, (err, addresses) => {
          if (err) reject(err);
          else resolve(addresses);
        });
      }),
    resolveCname: (hostname: string) =>
      new Promise((resolve, reject) => {
        resolver.resolveCname(hostname, (err, addresses) => {
          if (err) reject(err);
          else resolve(addresses);
        });
      }),
  };
}

/**
 * Check DNS record with a specific resolver
 */
async function checkWithResolver(
  hostname: string,
  expectedTarget: string | undefined,
  servers: string[] | null,
): Promise<{
  resolved: boolean;
  records: string[];
  type: "A" | "CNAME" | null;
  matchesTarget: boolean;
}> {
  const { resolve4, resolveCname } = createResolver(servers);

  // If expected target is a hostname (not an IP), check CNAME first
  if (expectedTarget && !isIPAddress(expectedTarget)) {
    try {
      const cnameRecords = await withTimeout(
        resolveCname(hostname),
        DNS_TIMEOUT_MS,
      );
      const matchesTarget = cnameMatchesTarget(cnameRecords, expectedTarget);
      return {
        resolved: true,
        records: cnameRecords,
        type: "CNAME",
        matchesTarget,
      };
    } catch {
      // No CNAME record exists - try A record check
      // For hostname targets, we need to resolve both the hostname and target
      // to IPs and compare them
      try {
        const [hostnameIPs, targetIPs] = await withTimeout(
          Promise.all([resolve4(hostname), resolve4(expectedTarget)]),
          DNS_TIMEOUT_MS,
        );
        const matchesTarget = hostnameIPs.some((ip) => targetIPs.includes(ip));
        return {
          resolved: true,
          records: hostnameIPs,
          type: "A",
          matchesTarget,
        };
      } catch {
        return {
          resolved: false,
          records: [],
          type: null,
          matchesTarget: false,
        };
      }
    }
  }

  // Expected target is an IP address - check A records directly
  try {
    const aRecords = await withTimeout(resolve4(hostname), DNS_TIMEOUT_MS);
    const matchesTarget = expectedTarget
      ? aRecords.some((r) => r === expectedTarget)
      : true;
    return {
      resolved: true,
      records: aRecords,
      type: "A",
      matchesTarget,
    };
  } catch {
    // Try CNAME if A fails (fallback for when no expected target)
    try {
      const cnameRecords = await withTimeout(
        resolveCname(hostname),
        DNS_TIMEOUT_MS,
      );
      const matchesTarget = expectedTarget
        ? cnameMatchesTarget(cnameRecords, expectedTarget)
        : true;
      return {
        resolved: true,
        records: cnameRecords,
        type: "CNAME",
        matchesTarget,
      };
    } catch {
      return {
        resolved: false,
        records: [],
        type: null,
        matchesTarget: false,
      };
    }
  }
}

/**
 * Checks if a DNS record resolves using multiple DNS resolvers for reliability.
 * Tries system DNS first, then Google (8.8.8.8), then Cloudflare (1.1.1.1).
 * Returns success if ANY resolver confirms the record matches the target.
 */
export async function checkDNSRecord(
  hostname: string,
  expectedTarget?: string,
): Promise<{
  resolved: boolean;
  records: string[];
  type: "A" | "CNAME" | null;
  matchesTarget: boolean;
}> {
  // Try each resolver in sequence until one succeeds with a matching target
  for (const servers of DNS_RESOLVERS) {
    try {
      const result = await checkWithResolver(hostname, expectedTarget, servers);

      // If we found a matching record, return immediately
      if (result.resolved && result.matchesTarget) {
        return result;
      }

      // If resolved but doesn't match, continue to next resolver
      // (different resolvers might have different cache states)
    } catch {
      // This resolver failed entirely, try the next one
    }
  }

  // No resolver found a matching record - do one final check with system DNS
  // to return whatever we can find (even if not matching)
  try {
    return await checkWithResolver(hostname, expectedTarget, null);
  } catch {
    return {
      resolved: false,
      records: [],
      type: null,
      matchesTarget: false,
    };
  }
}

/**
 * Gets the load balancer address from Kubernetes
 */
export async function getLoadBalancerAddress(
  namespace: string = DEFAULT_NAMESPACE,
): Promise<{ address: string | null; type: "ip" | "hostname" | null }> {
  try {
    // Get the Traefik service which is typically the load balancer
    const { stdout } = await execa("kubectl", [
      "get",
      "service",
      "-n",
      namespace,
      "-l",
      "app.kubernetes.io/name=traefik",
      "-o",
      "jsonpath={.items[0].status.loadBalancer.ingress[0]}",
    ]);

    if (!stdout || stdout === "{}") {
      // Try looking for any LoadBalancer service
      const { stdout: allServices } = await execa("kubectl", [
        "get",
        "service",
        "-n",
        namespace,
        "--field-selector=spec.type=LoadBalancer",
        "-o",
        "jsonpath={.items[0].status.loadBalancer.ingress[0]}",
      ]);

      if (!allServices || allServices === "{}") {
        return { address: null, type: null };
      }

      const parsed = JSON.parse(allServices || "{}");
      if (parsed.ip) {
        return { address: parsed.ip, type: "ip" };
      }
      if (parsed.hostname) {
        return { address: parsed.hostname, type: "hostname" };
      }
    }

    const parsed = JSON.parse(stdout || "{}");
    if (parsed.ip) {
      return { address: parsed.ip, type: "ip" };
    }
    if (parsed.hostname) {
      return { address: parsed.hostname, type: "hostname" };
    }

    return { address: null, type: null };
  } catch {
    return { address: null, type: null };
  }
}

/**
 * Gets all required DNS records for a deployment
 */
export function getRequiredDNSRecords(
  domain: string,
  loadBalancerAddress: string,
  loadBalancerType: "ip" | "hostname",
  selfHostedSupabase: boolean,
): DNSRecord[] {
  const records: DNSRecord[] = [
    {
      hostname: domain,
      type: loadBalancerType === "ip" ? "A" : "CNAME",
      target: loadBalancerAddress,
      verified: false,
      required: true,
    },
  ];

  // If self-hosted Supabase, need supabase subdomain
  if (selfHostedSupabase) {
    records.push({
      hostname: `supabase.${domain}`,
      type: loadBalancerType === "ip" ? "A" : "CNAME",
      target: loadBalancerAddress,
      verified: false,
      required: true,
    });
  }

  return records;
}

/**
 * Polls DNS records until they resolve or timeout
 */
export async function waitForDNSRecords(
  records: DNSRecord[],
  options: {
    pollIntervalMs?: number;
    timeoutMs?: number;
    onUpdate?: (records: DNSRecord[]) => void;
  } = {},
): Promise<{
  success: boolean;
  records: DNSRecord[];
  failedRecords: DNSRecord[];
}> {
  const {
    pollIntervalMs = 5000,
    timeoutMs = 300000, // 5 minutes default
    onUpdate,
  } = options;

  const startTime = Date.now();
  const updatedRecords = [...records];

  while (Date.now() - startTime < timeoutMs) {
    let allResolved = true;

    for (let i = 0; i < updatedRecords.length; i++) {
      const record = updatedRecords[i];

      if (record.verified) {
        continue;
      }

      const result = await checkDNSRecord(record.hostname, record.target);

      if (result.resolved && result.matchesTarget) {
        updatedRecords[i] = { ...record, verified: true };
      } else {
        allResolved = false;
      }
    }

    onUpdate?.(updatedRecords);

    if (allResolved) {
      return {
        success: true,
        records: updatedRecords,
        failedRecords: [],
      };
    }

    // Wait before next poll
    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
  }

  // Timeout reached
  const failedRecords = updatedRecords.filter((r) => !r.verified);
  return {
    success: false,
    records: updatedRecords,
    failedRecords,
  };
}

/**
 * Formats a DNS record for display
 */
export function formatDNSRecord(record: DNSRecord): string {
  return `${record.hostname} → ${record.type} → ${record.target}`;
}

/**
 * Checks if DNS propagation is complete for all records
 */
export function isDNSComplete(records: DNSRecord[]): boolean {
  return records.every((r) => r.verified);
}
