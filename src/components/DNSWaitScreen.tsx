import React, { useState, useEffect, useCallback, useRef } from "react";
import { Box, Text, useInput } from "ink";
import InkSpinner from "ink-spinner";
import { BorderBox, Spinner, useTheme } from "./common/index.js";
import { DNSRecord } from "../types/index.js";
import {
  getLoadBalancerAddress,
  getRequiredDNSRecords,
  checkDNSRecord,
  isDNSComplete,
} from "../lib/dns.js";

interface DNSWaitScreenProps {
  domain: string;
  selfHostedSupabase: boolean;
  namespace: string;
  onComplete: () => void;
  onSkip?: () => void;
}

type Status = "loading-lb" | "waiting-dns" | "complete" | "error";

export function DNSWaitScreen({
  domain,
  selfHostedSupabase,
  namespace,
  onComplete,
  onSkip,
}: DNSWaitScreenProps) {
  const { colors } = useTheme();
  const [status, setStatus] = useState<Status>("loading-lb");
  const [loadBalancer, setLoadBalancer] = useState<{
    address: string;
    type: "ip" | "hostname";
  } | null>(null);
  const [records, setRecords] = useState<DNSRecord[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [pollCount, setPollCount] = useState(0);

  // Use ref to avoid stale closure in polling interval
  const recordsRef = useRef<DNSRecord[]>(records);
  recordsRef.current = records;

  useInput((input, key) => {
    if (key.escape || input.toLowerCase() === "s") {
      onSkip?.();
    }
    if (key.return && status === "complete") {
      onComplete();
    }
  });

  // Fetch load balancer address
  useEffect(() => {
    const fetchLB = async () => {
      const result = await getLoadBalancerAddress(namespace);

      if (!result.address) {
        setError(
          "Could not determine load balancer address. Make sure the deployment is running.",
        );
        setStatus("error");
        return;
      }

      setLoadBalancer({ address: result.address, type: result.type! });

      const dnsRecords = getRequiredDNSRecords(
        domain,
        result.address,
        result.type!,
        selfHostedSupabase,
      );

      setRecords(dnsRecords);
      setStatus("waiting-dns");
    };

    fetchLB();
  }, [domain, selfHostedSupabase, namespace]);

  // Poll DNS records
  useEffect(() => {
    if (status !== "waiting-dns") return;

    const pollDNS = async () => {
      // Use ref to get current records, avoiding stale closure
      const currentRecords = recordsRef.current;

      const updatedRecords = await Promise.all(
        currentRecords.map(async (record) => {
          if (record.verified) return record;

          const result = await checkDNSRecord(record.hostname, record.target);
          return {
            ...record,
            verified: result.resolved && result.matchesTarget,
          };
        }),
      );

      setRecords(updatedRecords);
      setPollCount((c) => c + 1);

      if (isDNSComplete(updatedRecords)) {
        setStatus("complete");
      }
    };

    // Initial check
    pollDNS();

    // Poll every 5 seconds
    const interval = setInterval(pollDNS, 5000);

    return () => clearInterval(interval);
  }, [status]);

  const verifiedCount = records.filter((r) => r.verified).length;

  return (
    <BorderBox title="Configure DNS Records">
      {status === "loading-lb" && (
        <Box flexDirection="column" marginY={1}>
          <Spinner label="Getting load balancer address..." />
        </Box>
      )}

      {status === "error" && (
        <Box flexDirection="column" marginY={1}>
          <Text color={colors.error} bold>
            ✗ Error
          </Text>
          <Text color={colors.error}>{error}</Text>
          <Box marginTop={1}>
            <Text color={colors.muted}>Press Esc to skip DNS validation</Text>
          </Box>
        </Box>
      )}

      {(status === "waiting-dns" || status === "complete") && loadBalancer && (
        <Box flexDirection="column" marginY={1}>
          <Text bold>Your load balancer address:</Text>
          <Box marginY={1}>
            <Text color={colors.accent} bold>
              {loadBalancer.address}
            </Text>
          </Box>

          <Text>Please add the following DNS records:</Text>
          <Box marginTop={1} flexDirection="column">
            {records.map((record, idx) => (
              <Box key={idx} flexDirection="column" marginBottom={1}>
                {/* Line 1: Status + hostname */}
                <Box>
                  {record.verified ? (
                    <Text color={colors.success}>✓</Text>
                  ) : (
                    <Text color={colors.accent}>
                      <InkSpinner type="dots" />
                    </Text>
                  )}
                  <Text> </Text>
                  <Text color={record.verified ? colors.success : undefined}>
                    {record.hostname}
                  </Text>
                </Box>
                {/* Line 2: Arrow + type + arrow + target (indented) */}
                <Box marginLeft={2}>
                  <Text color={colors.accent}>{record.type}</Text>
                  <Text color={colors.muted}> → </Text>
                  <Text color={colors.accent}>{record.target}</Text>
                </Box>
              </Box>
            ))}
          </Box>

          <Box marginTop={2}>
            {status === "waiting-dns" ? (
              <Box flexDirection="column">
                <Box>
                  <Spinner
                    label={`Checking DNS propagation... (${verifiedCount}/${records.length} complete)`}
                  />
                </Box>
                <Box marginTop={1}>
                  <Text color={colors.muted} dimColor>
                    Poll #{pollCount} • DNS changes can take up to 48 hours to
                    propagate
                  </Text>
                </Box>
              </Box>
            ) : (
              <Box flexDirection="column">
                <Text color={colors.success} bold>
                  ✓ All DNS records verified!
                </Text>
                <Box marginTop={1}>
                  <Text color={colors.muted}>
                    Press Enter to continue with TLS setup
                  </Text>
                </Box>
              </Box>
            )}
          </Box>
        </Box>
      )}

      <Box marginTop={1}>
        <Text color={colors.muted} dimColor>
          {status === "complete"
            ? "Enter to continue"
            : "S or Esc to skip DNS validation (not recommended)"}
        </Text>
      </Box>
    </BorderBox>
  );
}
