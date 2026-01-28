import dns from "dns";
import { promisify } from "util";
import { execa } from "execa";
import { DNSRecord, DEFAULT_NAMESPACE } from "../types/index.js";

const resolve4 = promisify(dns.resolve4);
const resolveCname = promisify(dns.resolveCname);

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
 * Checks if a DNS record resolves
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
  try {
    // If expected target is a hostname (not an IP), check CNAME first
    if (expectedTarget && !isIPAddress(expectedTarget)) {
      try {
        const cnameRecords = await resolveCname(hostname);
        // CNAME records found - return the comparison result directly
        // Don't fall through to A record check, as that would incorrectly
        // compare IPs against a hostname target
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
          const [hostnameIPs, targetIPs] = await Promise.all([
            resolve4(hostname),
            resolve4(expectedTarget),
          ]);
          // Check if any of the hostname's IPs match any of the target's IPs
          const matchesTarget = hostnameIPs.some((ip) =>
            targetIPs.includes(ip),
          );
          return {
            resolved: true,
            records: hostnameIPs,
            type: "A",
            matchesTarget,
          };
        } catch {
          // Could not resolve - DNS not configured
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
      const aRecords = await resolve4(hostname);
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
      const cnameRecords = await resolveCname(hostname);
      const matchesTarget = expectedTarget
        ? cnameMatchesTarget(cnameRecords, expectedTarget)
        : true;
      return {
        resolved: true,
        records: cnameRecords,
        type: "CNAME",
        matchesTarget,
      };
    }
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
