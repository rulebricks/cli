import React, { useEffect, useState } from "react";
import { Box, Text, useInput } from "ink";
import SelectInput from "ink-select-input";
import { useWizard } from "../WizardContext.js";
import { BorderBox, useTheme } from "../../common/index.js";
import { Spinner } from "../../common/Spinner.js";
import { TIER_CONFIGS, PerformanceTier } from "../../../types/index.js";
import {
  ClusterCapabilities,
  inferClusterCapabilities,
} from "../../../lib/kubernetes.js";

interface TierStepProps {
  onComplete: () => void;
  onBack: () => void;
}

type LoadState = "loading" | "ready" | "error";

function formatWholeNumber(value: number): string {
  return String(Math.ceil(value));
}

function formatPersistentStorage(capabilities: ClusterCapabilities): string {
  if (capabilities.totalPersistentStorageGi === undefined) {
    return "dynamic capacity not reported";
  }
  return `${formatWholeNumber(capabilities.totalPersistentStorageGi)} Gi reported available`;
}

export function TierStep({ onComplete, onBack }: TierStepProps) {
  const { dispatch } = useWizard();
  const { colors } = useTheme();
  const [loadState, setLoadState] = useState<LoadState>("loading");
  const [capabilities, setCapabilities] = useState<ClusterCapabilities | null>(
    null,
  );

  useInput((input, key) => {
    if (key.escape) {
      onBack();
    }
  });

  useEffect(() => {
    let mounted = true;

    async function scanCluster() {
      setLoadState("loading");
      const detected = await inferClusterCapabilities();
      if (!mounted) return;

      if (!detected) {
        setCapabilities(null);
        setLoadState("error");
        return;
      }

      setCapabilities(detected);
      dispatch({
        type: "SET_CLUSTER_CAPABILITIES",
        nodeArchitecture: detected.nodeArchitecture,
        arm64TolerationRequired: detected.arm64TolerationRequired,
        storageClass: detected.storageClass,
        storageProvisioner: detected.storageProvisioner,
        schedulableNodeCount: detected.schedulableNodeCount,
        totalCpuCores: detected.totalCpuCores,
        totalMemoryGi: detected.totalMemoryGi,
        eligibleCpuCores: detected.eligibleCpuCores,
        eligibleMemoryGi: detected.eligibleMemoryGi,
        totalPersistentStorageGi: detected.totalPersistentStorageGi ?? 0,
      });
      setLoadState("ready");
    }

    scanCluster();
    return () => {
      mounted = false;
    };
  }, [dispatch]);

  const feasibleTiers = capabilities?.feasibleTiers ?? [];
  const items = feasibleTiers.map((tier) => ({
    label: tier.charAt(0).toUpperCase() + tier.slice(1),
    value: tier,
    config: TIER_CONFIGS[tier],
    recommended: tier === capabilities?.recommendedTier,
  }));

  const handleSelect = (item: { value: string }) => {
    dispatch({ type: "SET_TIER", tier: item.value as PerformanceTier });
    onComplete();
  };

  if (loadState === "loading") {
    return (
      <BorderBox title="Performance Tier">
        <Box flexDirection="column" marginY={1}>
          <Spinner label="Scanning cluster resources..." />
          <Box marginTop={1}>
            <Text color="gray" dimColor>
              Checking schedulable CPU, memory, storage, and architecture.
            </Text>
          </Box>
        </Box>
      </BorderBox>
    );
  }

  if (loadState === "error" || !capabilities) {
    return (
      <BorderBox title="Performance Tier">
        <Box flexDirection="column" marginY={1}>
          <Text color={colors.error} bold>
            Unable to inspect the selected Kubernetes cluster.
          </Text>
          <Box marginTop={1} flexDirection="column">
            <Text color="gray">
              Confirm kubectl can reach the cluster, then go back and reselect it.
            </Text>
            <Text color="gray">Run: kubectl cluster-info</Text>
          </Box>
        </Box>
        <Box marginTop={1}>
          <Text color="gray" dimColor>
            Esc to go back
          </Text>
        </Box>
      </BorderBox>
    );
  }

  if (items.length === 0) {
    const small = TIER_CONFIGS.small.requirements;
    return (
      <BorderBox title="Performance Tier">
        <Box flexDirection="column" marginY={1}>
          <Text color={colors.error} bold>
            This cluster is below the minimum Rulebricks size.
          </Text>
          <Box marginTop={1} flexDirection="column">
            <Text color="gray">
              Detected: {capabilities.schedulableNodeCount} schedulable nodes,{" "}
              {formatWholeNumber(capabilities.eligibleCpuCores)} vCPU,{" "}
              {formatWholeNumber(capabilities.eligibleMemoryGi)} Gi memory
            </Text>
            <Text color="gray">
              Minimum: {small.cpuCores} vCPU, {small.memoryGi} Gi memory,{" "}
              {small.persistentStorageGi} Gi persistent storage, and a default
              or usable StorageClass
            </Text>
            <Text color="gray">
              StorageClass: {capabilities.storageClass || "none detected"}
            </Text>
            {capabilities.storageClass && (
              <Text color="gray">
                Persistent storage: {formatPersistentStorage(capabilities)}
              </Text>
            )}
          </Box>
        </Box>
        <Box marginTop={1}>
          <Text color="gray" dimColor>
            Esc to go back
          </Text>
        </Box>
      </BorderBox>
    );
  }

  return (
    <BorderBox title="Performance Tier">
      <Box flexDirection="column" marginY={1}>
        <Text>Select your deployment size:</Text>
        <Text color="gray" dimColor>
          Showing tiers that fit the selected cluster.
        </Text>
        <Box marginTop={1} flexDirection="column">
          <Text color="gray">
            Cluster: {capabilities.schedulableNodeCount} nodes,{" "}
            {formatWholeNumber(capabilities.eligibleCpuCores)} vCPU,{" "}
            {formatWholeNumber(capabilities.eligibleMemoryGi)} Gi memory
          </Text>
          <Text color="gray">
            StorageClass: {capabilities.storageClass}
            {capabilities.storageProvisioner
              ? ` (${capabilities.storageProvisioner})`
              : ""}
          </Text>
          <Text color="gray">
            Persistent storage: {formatPersistentStorage(capabilities)}
          </Text>
        </Box>
      </Box>

      <SelectInput
        items={items}
        onSelect={handleSelect}
        indicatorComponent={() => null}
        itemComponent={({ isSelected, label }) => {
          const currentItem = items.find((i) => i.label === label) || items[0];
          const config = currentItem.config;
          return (
            <Box flexDirection="column" marginY={isSelected ? 1 : 0}>
              <Text color={isSelected ? colors.accent : undefined} bold={isSelected}>
                {isSelected ? "❯ " : "  "}
                {currentItem.label}
                {currentItem.recommended && (
                  <Text color={colors.success}> recommended</Text>
                )}
                <Text color="gray"> - {config.description}</Text>
              </Text>
              {isSelected && (
                <Box flexDirection="column" marginLeft={4}>
                  <Text color="gray">Throughput: {config.throughput}</Text>
                  <Text color="gray">Capacity: {config.resources}</Text>
                  <Text color="gray">
                    Requires: {config.requirements.cpuCores} vCPU,{" "}
                    {config.requirements.memoryGi} Gi memory,{" "}
                    {config.requirements.persistentStorageGi} Gi persistent storage
                  </Text>
                  <Text color="gray">
                    HPS Workers: {config.hpsWorkerReplicas.min}-
                    {config.hpsWorkerReplicas.max}
                  </Text>
                </Box>
              )}
            </Box>
          );
        }}
      />

      <Box marginTop={1}>
        <Text color="gray" dimColor>
          Esc to go back • Enter to select
        </Text>
      </Box>
    </BorderBox>
  );
}
