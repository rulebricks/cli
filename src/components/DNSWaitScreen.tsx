import React, { useState, useEffect, useCallback } from "react";
import { Box, Text, useInput } from "ink";
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
  builtInObservability?: boolean;
  observabilityHostname?: string;
  namespace: string;
  onComplete: () => void;
  onSkip?: () => void;
}

type Status = "loading-lb" | "idle" | "checking" | "complete" | "error";

export function DNSWaitScreen({
  domain,
  selfHostedSupabase,
  builtInObservability = false,
  observabilityHostname,
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
  const [hasChecked, setHasChecked] = useState(false);

  const checkRecords = useCallback(async () => {
    if (status !== "idle" || records.length === 0) return;

    setStatus("checking");
    setHasChecked(true);

    const updatedRecords = await Promise.all(
      records.map(async (record) => {
        if (record.verified) return record;

        const result = await checkDNSRecord(record.hostname, record.target);
        return {
          ...record,
          verified: result.resolved && result.matchesTarget,
        };
      }),
    );

    setRecords(updatedRecords);
    setStatus(isDNSComplete(updatedRecords) ? "complete" : "idle");
  }, [records, status]);

  useInput((input, key) => {
    if (key.escape || input.toLowerCase() === "s") {
      onSkip?.();
    }
    if (key.return && status === "complete") {
      onComplete();
    } else if (key.return && status === "idle") {
      void checkRecords();
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
        builtInObservability,
        observabilityHostname,
      );

      setRecords(dnsRecords);
      setStatus("idle");
    };

    fetchLB();
  }, [
    domain,
    selfHostedSupabase,
    builtInObservability,
    observabilityHostname,
    namespace,
  ]);

  const verifiedCount = records.filter((r) => r.verified).length;
  const footerText =
    status === "complete"
      ? "Enter to continue"
      : status === "checking"
        ? "Checking DNS records..."
        : hasChecked
          ? "We couldn't find one or more DNS records. Please verify they exist and press Enter to try again."
          : "Press Enter once you've created the DNS records • S or Esc to skip DNS validation";

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

      {(status === "idle" || status === "checking" || status === "complete") &&
        loadBalancer && (
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
                    ) : hasChecked ? (
                      <Text color={colors.warning}>○</Text>
                    ) : (
                      <Text color={colors.muted}>○</Text>
                    )}
                    <Text> </Text>
                    <Text
                      color={
                        record.verified
                          ? colors.success
                          : hasChecked
                            ? colors.warning
                            : undefined
                      }
                    >
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
              {status === "complete" ? (
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
              ) : status === "checking" ? (
                <Box flexDirection="column">
                  <Box>
                    <Spinner label="Checking DNS records..." />
                  </Box>
                  <Box marginTop={1}>
                    <Text color={colors.muted} dimColor>
                      {verifiedCount}/{records.length} records verified
                    </Text>
                  </Box>
                </Box>
              ) : hasChecked ? (
                <Box flexDirection="column">
                  <Text color={colors.warning}>
                    We couldn't find one or more DNS records.
                  </Text>
                  <Text color={colors.muted}>
                    Please verify they exist and press Enter to try again.
                  </Text>
                </Box>
              ) : (
                <Box flexDirection="column">
                  <Text color={colors.muted}>
                    Press Enter once you've created the DNS records.
                  </Text>
                </Box>
              )}
            </Box>
          </Box>
        )}

      <Box marginTop={1}>
        <Text color={colors.muted} dimColor>{footerText}</Text>
      </Box>
    </BorderBox>
  );
}
