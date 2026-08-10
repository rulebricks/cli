import React, { useState, useEffect, useCallback, useRef } from "react";
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
  valkeyAdminIngress?: boolean;
  valkeyAdminHostname?: string;
  namespace: string;
  resumeExistingDeployment?: boolean;
  onComplete: () => void | Promise<void>;
  onSkip?: () => void | Promise<void>;
}

type Status = "loading-lb" | "idle" | "checking" | "complete" | "error";

export function DNSWaitScreen({
  domain,
  selfHostedSupabase,
  builtInObservability = false,
  observabilityHostname,
  valkeyAdminIngress = false,
  valkeyAdminHostname,
  namespace,
  resumeExistingDeployment = false,
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
  const [skipConfirmation, setSkipConfirmation] = useState(false);
  const checkInFlight = useRef(false);
  const terminalActionStarted = useRef(false);

  const checkRecords = useCallback(async () => {
    if (
      status !== "idle" ||
      records.length === 0 ||
      checkInFlight.current ||
      terminalActionStarted.current
    ) {
      return;
    }

    checkInFlight.current = true;
    setStatus("checking");
    setHasChecked(true);

    try {
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

      const complete = isDNSComplete(updatedRecords);
      setRecords(updatedRecords);
      setStatus(complete ? "complete" : "idle");

      if (complete && !terminalActionStarted.current) {
        terminalActionStarted.current = true;
        void onComplete();
      }
    } catch {
      setStatus("idle");
    } finally {
      checkInFlight.current = false;
    }
  }, [onComplete, records, status]);

  useInput((input, key) => {
    const requestedSkip = key.escape || input.toLowerCase() === "s";
    if (requestedSkip && onSkip && !terminalActionStarted.current) {
      if (skipConfirmation) {
        terminalActionStarted.current = true;
        setSkipConfirmation(false);
        void onSkip();
      } else {
        setSkipConfirmation(true);
      }
      return;
    }

    if (skipConfirmation) {
      setSkipConfirmation(false);
      return;
    }

    if (key.return && status === "idle") {
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
        valkeyAdminIngress,
        valkeyAdminHostname,
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
    valkeyAdminIngress,
    valkeyAdminHostname,
    namespace,
  ]);

  useEffect(() => {
    if (
      resumeExistingDeployment &&
      status === "idle" &&
      records.length > 0 &&
      !hasChecked
    ) {
      void checkRecords();
    }
  }, [
    checkRecords,
    hasChecked,
    records.length,
    resumeExistingDeployment,
    status,
  ]);

  const verifiedCount = records.filter((r) => r.verified).length;
  const footerText =
    skipConfirmation
      ? "Skip DNS validation? Press S or Esc again to confirm • any other key to cancel"
      : status === "complete"
        ? "DNS verified. Continuing deployment..."
        : status === "checking"
          ? "Checking DNS records..."
          : hasChecked
            ? "We couldn't find one or more DNS records. Please verify they exist and press Enter to try again."
            : "Press Enter once you've created the DNS records • S or Esc twice to skip DNS validation";

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
            <Text color={colors.muted}>
              Press S or Esc twice to skip DNS validation
            </Text>
          </Box>
        </Box>
      )}

      {(status === "idle" || status === "checking" || status === "complete") &&
        loadBalancer && (
          <Box flexDirection="column" marginY={1}>
            {resumeExistingDeployment && (
              <Box marginBottom={1}>
                <Text color={colors.muted}>
                  Existing deployment detected — resuming DNS/TLS setup.
                </Text>
              </Box>
            )}
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
                      Continuing deployment...
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
