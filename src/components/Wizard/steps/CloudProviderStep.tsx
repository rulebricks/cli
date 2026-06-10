import React, { useState, useEffect } from "react";
import { Box, Text, useInput } from "ink";
import SelectInput from "ink-select-input";
import TextInput from "ink-text-input";
import { useWizard } from "../WizardContext.js";
import { BorderBox, useTheme } from "../../common/index.js";
import { Spinner } from "../../common/Spinner.js";
import {
  CloudProvider,
  CLOUD_PROVIDER_NAMES,
  CLOUD_REGIONS,
} from "../../../types/index.js";
import {
  checkAllCloudClis,
  AllCloudCliStatus,
  CloudCliStatus,
  DiscoveredCluster,
  listManagedClusters,
  listRegions,
  getGcpProjectId,
  updateKubeconfig,
  CLI_INSTALL_URLS,
  CLI_LOGIN_COMMANDS,
} from "../../../lib/cloudCli.js";

interface CloudProviderStepProps {
  onComplete: () => void;
  onBack: () => void;
}

type SubStep =
  | "checking"
  | "no-cli"
  | "provider"
  | "cluster"
  | "cluster-loading"
  | "cluster-select"
  | "manual-region-loading"
  | "manual-region"
  | "manual-rg"
  | "kubeconfig-loading";

interface ProviderItem {
  label: string;
  value: CloudProvider;
  status: CloudCliStatus;
  disabled: boolean;
}

export function CloudProviderStep({
  onComplete,
  onBack,
}: CloudProviderStepProps) {
  const { state, dispatch } = useWizard();
  const { colors } = useTheme();

  const [subStep, setSubStep] = useState<SubStep>("checking");
  const [cliStatus, setCliStatus] = useState<AllCloudCliStatus | null>(null);
  const [clusterName, setClusterName] = useState(
    state.clusterName || "rulebricks-cluster",
  );
  const [clusters, setClusters] = useState<DiscoveredCluster[]>([]);
  const [selectedProvider, setSelectedProvider] = useState<CloudProvider | null>(
    state.provider,
  );
  // Manual-entry path (no clusters discovered): region and, on Azure, the
  // resource group still need to be captured so downstream steps (kubeconfig,
  // storage/monitoring discovery) aren't left blind.
  const [manualRegion, setManualRegion] = useState(state.region || "");
  const [manualRegions, setManualRegions] = useState<string[]>([]);
  const [manualResourceGroup, setManualResourceGroup] = useState(
    state.azureResourceGroup || "",
  );
  const [rgError, setRgError] = useState<string | null>(null);

  // Check CLIs on mount
  useEffect(() => {
    async function checkClis() {
      const status = await checkAllCloudClis();

      setCliStatus(status);

      if (!status.anyInstalled) {
        setSubStep("no-cli");
      } else {
        setSubStep("provider");
      }
    }

    checkClis();
  }, []);

  useInput((input, key) => {
    if (key.escape) {
      if (
        subStep === "provider" ||
        subStep === "no-cli" ||
        subStep === "checking"
      ) {
        onBack();
      } else if (
        subStep === "manual-region" ||
        subStep === "manual-region-loading"
      ) {
        setSubStep("cluster");
      } else if (subStep === "manual-rg") {
        setRgError(null);
        setSubStep("manual-region");
      } else if (
        subStep === "cluster" ||
        subStep === "cluster-loading" ||
        subStep === "cluster-select" ||
        subStep === "kubeconfig-loading"
      ) {
        setSubStep("provider");
      }
    }
  });

  // Build provider items with status
  const getProviderItems = (): ProviderItem[] => {
    if (!cliStatus) return [];

    const providers: {
      label: string;
      value: CloudProvider;
      status: CloudCliStatus;
    }[] = [
      { label: "AWS (EKS)", value: "aws", status: cliStatus.aws },
      { label: "Google Cloud (GKE)", value: "gcp", status: cliStatus.gcp },
      { label: "Azure (AKS)", value: "azure", status: cliStatus.azure },
    ];

    return providers.map((p) => ({
      ...p,
      disabled: !p.status.authenticated,
    }));
  };

  const providerItems = getProviderItems();

  const handleProviderSelect = (item: { value: string }) => {
    const selectedItem = providerItems.find((p) => p.value === item.value);
    if (!selectedItem || selectedItem.disabled) return;

    const provider = item.value as CloudProvider;
    setSelectedProvider(provider);
    setClusterName("rulebricks-cluster");
    dispatch({ type: "SET_PROVIDER", provider });
    loadClusters(provider);
  };

  const loadClusters = async (provider: CloudProvider) => {
    setSubStep("cluster-loading");

    try {
      const availableClusters = await listManagedClusters(provider);

      setClusters(availableClusters);

      if (availableClusters.length > 0) {
        setSubStep("cluster-select");
      } else {
        // No clusters found, fall back to manual input
        setSubStep("cluster");
      }
    } catch {
      // On error, fall back to manual input
      setClusters([]);
      setSubStep("cluster");
    }
  };

  const completeWithCluster = async (cluster: DiscoveredCluster) => {
    dispatch({ type: "SET_REGION", region: cluster.region });
    dispatch({ type: "SET_CLUSTER_NAME", clusterName: cluster.name });
    dispatch({ type: "SET_AZURE_RG", resourceGroup: cluster.resourceGroup || "" });
    dispatch({ type: "SET_GCP_PROJECT", projectId: cluster.projectId || "" });

    if (cluster.provider && cluster.region) {
      setSubStep("kubeconfig-loading");
      try {
        await updateKubeconfig(cluster.provider, cluster.name, cluster.region, {
          gcpProjectId: cluster.projectId,
          azureResourceGroup: cluster.resourceGroup,
        });
      } catch {
        // The next step performs a direct kubectl scan and will show a concrete
        // access error if kubeconfig still points at the wrong cluster.
      }
    }

    onComplete();
  };

  const handleClusterSelect = (item: { value: string }) => {
    const cluster = clusters.find((c) => getClusterKey(c) === item.value);
    if (!cluster) return;

    setClusterName(cluster.name);
    completeWithCluster(cluster);
  };

  const handleClusterSubmit = () => {
    dispatch({ type: "SET_CLUSTER_NAME", clusterName });
    loadManualRegions();
  };

  // Manual path: the cluster wasn't discovered, so the region (and Azure
  // resource group) are collected explicitly before refreshing kubeconfig —
  // otherwise the tier scan runs against whatever kubectl happens to point at
  // and storage/monitoring discovery start without a region.
  const loadManualRegions = async () => {
    const provider = selectedProvider || state.provider;
    if (!provider) {
      onComplete();
      return;
    }
    setSubStep("manual-region-loading");
    try {
      const regions = await listRegions(provider);
      setManualRegions(regions.length > 0 ? regions : CLOUD_REGIONS[provider]);
    } catch {
      setManualRegions(CLOUD_REGIONS[provider]);
    }
    setSubStep("manual-region");
  };

  const handleManualRegionSelect = (item: { value: string }) => {
    setManualRegion(item.value);
    dispatch({ type: "SET_REGION", region: item.value });

    const provider = selectedProvider || state.provider;
    if (provider === "azure") {
      setSubStep("manual-rg");
    } else {
      completeManual(item.value, "");
    }
  };

  const handleManualResourceGroupSubmit = () => {
    if (!manualResourceGroup.trim()) {
      setRgError("Resource group is required for AKS clusters");
      return;
    }
    setRgError(null);
    dispatch({
      type: "SET_AZURE_RG",
      resourceGroup: manualResourceGroup.trim(),
    });
    completeManual(manualRegion, manualResourceGroup.trim());
  };

  const completeManual = async (region: string, resourceGroup: string) => {
    const provider = selectedProvider || state.provider;
    if (!provider) {
      onComplete();
      return;
    }

    setSubStep("kubeconfig-loading");
    // GCP: derive the project from the active gcloud config instead of asking.
    let gcpProjectId: string | undefined;
    if (provider === "gcp") {
      try {
        gcpProjectId = (await getGcpProjectId()) || undefined;
      } catch {
        gcpProjectId = undefined;
      }
      if (gcpProjectId) {
        dispatch({ type: "SET_GCP_PROJECT", projectId: gcpProjectId });
      }
    }

    try {
      await updateKubeconfig(provider, clusterName, region, {
        gcpProjectId,
        azureResourceGroup: resourceGroup || undefined,
      });
    } catch {
      // The next step performs a direct kubectl scan and will show a concrete
      // access error if kubeconfig still points at the wrong cluster.
    }

    onComplete();
  };

  // Render status indicator for a provider
  const renderStatusIndicator = (status: CloudCliStatus) => {
    if (!status.installed) {
      return <Text color="gray"> (not installed)</Text>;
    }
    if (!status.authenticated) {
      // Check for specific error types to show more helpful messages
      if (status.error?.toLowerCase().includes("quota")) {
        return <Text color="yellow"> (insufficient quota)</Text>;
      }
      if (status.error?.toLowerCase().includes("resource provider")) {
        return <Text color="yellow"> (providers not registered)</Text>;
      }
      return <Text color="yellow"> (log in required)</Text>;
    }
    return <Text color="green"> ✓</Text>;
  };

  const clusterItems = clusters.map((cluster) => ({
    label: formatClusterRow(cluster),
    value: getClusterKey(cluster),
  }));

  const activeProvider = selectedProvider || state.provider;
  const providerName = activeProvider
    ? CLOUD_PROVIDER_NAMES[activeProvider]
    : "";

  return (
    <BorderBox title="Cloud Provider">
      {subStep === "checking" && (
        <Box flexDirection="column" marginY={1}>
          <Spinner label="Checking cloud CLI tools..." />
          <Box marginTop={1}>
            <Text color="gray" dimColor>
              Detecting AWS, GCP, and Azure CLIs...
            </Text>
          </Box>
        </Box>
      )}

      {subStep === "no-cli" && (
        <Box flexDirection="column" marginY={1}>
          <Text color="red" bold>
            No cloud CLI tools detected
          </Text>
          <Box marginTop={1} flexDirection="column">
            <Text>
              To discover clusters, install at least one cloud CLI:
            </Text>
          </Box>
          <Box marginTop={1} flexDirection="column" marginLeft={2}>
            {Object.entries(CLI_INSTALL_URLS).map(([provider, info]) => (
              <Box key={provider} flexDirection="column" marginBottom={1}>
                <Text bold>{info.name}:</Text>
                <Text color="gray"> {info.installCmd}</Text>
                <Text color="gray"> {info.url}</Text>
              </Box>
            ))}
          </Box>
          <Box marginTop={1}>
            <Text color="gray">After installing, authenticate:</Text>
          </Box>
          <Box marginLeft={2} flexDirection="column">
            {Object.entries(CLI_LOGIN_COMMANDS).map(([provider, cmd]) => (
              <Box key={provider} flexDirection="column">
                {Array.isArray(cmd) ? (
                  <>
                    <Text color="gray"> {provider}:</Text>
                    {cmd.map((c, i) => (
                      <Text key={i} color="gray">   {c}</Text>
                    ))}
                  </>
                ) : (
                  <Text color="gray"> {provider}: {cmd}</Text>
                )}
              </Box>
            ))}
          </Box>
        </Box>
      )}

      {subStep === "provider" && cliStatus && (
        <>
          <Box flexDirection="column" marginY={1}>
            <Text>Select your cloud provider:</Text>
            {!cliStatus.anyAvailable && cliStatus.anyInstalled && (
              <Text color="yellow" dimColor>
                Some CLIs are installed but not authenticated
              </Text>
            )}
          </Box>
          <SelectInput
            items={providerItems.map((p) => ({
              label: p.label,
              value: p.value,
            }))}
            onSelect={handleProviderSelect}
            indicatorComponent={() => null}
            itemComponent={({ isSelected, label }) => {
              const item = providerItems.find((p) => p.label === label);
              if (!item) return <Text>{label}</Text>;

              const textColor = item.disabled
                ? "gray"
                : isSelected
                  ? colors.accent
                  : undefined;

              return (
                <Box>
                  <Text color={textColor} dimColor={item.disabled}>
                    {isSelected && !item.disabled ? "> " : "  "}
                    {label}
                  </Text>
                  {renderStatusIndicator(item.status)}
                  {item.status.identity && item.status.authenticated && (
                    <Text color="gray" dimColor>
                      {" "}
                      ({item.status.identity})
                    </Text>
                  )}
                </Box>
              );
            }}
          />
        </>
      )}

      {subStep === "cluster-loading" && (
        <Box flexDirection="column" marginY={1}>
          <Spinner
            label={`Fetching ${providerName} clusters...`}
          />
          <Box marginTop={1}>
            <Text color="gray" dimColor>
              This may take a moment while the cloud CLI checks accessible
              locations.
            </Text>
          </Box>
        </Box>
      )}

      {subStep === "cluster-select" && (
        <>
          <Box flexDirection="column" marginY={1}>
            <Text>Select your Kubernetes cluster:</Text>
            <Text color="gray" dimColor>
              {clusters.length} cluster{clusters.length !== 1 ? "s" : ""} found
              for {providerName}
            </Text>
          </Box>
          <Text color="gray" dimColor>
            {`  ${formatClusterColumns("Name", "Location", "Details", "Nodes")}`}
          </Text>
          <Box height={10} flexDirection="column" overflowY="hidden">
            <SelectInput
              items={clusterItems}
              onSelect={handleClusterSelect}
              limit={8}
              indicatorComponent={() => null}
              itemComponent={({ isSelected, label }) => (
                <Text color={isSelected ? colors.accent : undefined}>
                  {isSelected ? "> " : "  "}
                  {label}
                </Text>
              )}
            />
          </Box>
        </>
      )}

      {subStep === "cluster" && (
        <Box flexDirection="column" marginY={1}>
          <Text>Enter the Kubernetes cluster name:</Text>
          <Text color="gray" dimColor>
            No clusters were discovered for {providerName}. If kubectl already
            points at the cluster, you can enter its name manually.
          </Text>
          <Box marginTop={1} flexDirection="column">
            <Text color="yellow">
              Need a basic cluster? See cluster-setup/ for minimum Rulebricks
              examples.
            </Text>
          </Box>
          <Box marginTop={1}>
            <Text color={colors.accent}>{" > "}</Text>
            <TextInput
              value={clusterName}
              onChange={setClusterName}
              onSubmit={handleClusterSubmit}
              placeholder="rulebricks-cluster"
            />
          </Box>
        </Box>
      )}

      {subStep === "manual-region-loading" && (
        <Box flexDirection="column" marginY={1}>
          <Spinner label="Loading available regions..." />
        </Box>
      )}

      {subStep === "manual-region" && (
        <Box flexDirection="column" marginY={1}>
          <Text>Select the cluster's region:</Text>
          <Text color="gray" dimColor>
            Used to refresh kubeconfig and discover storage and monitoring
            resources for {clusterName}.
          </Text>
          <Box
            marginTop={1}
            height={10}
            flexDirection="column"
            overflowY="hidden"
          >
            <SelectInput
              items={manualRegions.map((r) => ({ label: r, value: r }))}
              onSelect={handleManualRegionSelect}
              limit={8}
              initialIndex={Math.max(0, manualRegions.indexOf(manualRegion))}
              indicatorComponent={() => null}
              itemComponent={({ isSelected, label }) => (
                <Text color={isSelected ? colors.accent : undefined}>
                  {isSelected ? "> " : "  "}
                  {label}
                </Text>
              )}
            />
          </Box>
        </Box>
      )}

      {subStep === "manual-rg" && (
        <Box flexDirection="column" marginY={1}>
          <Text>Enter the cluster's resource group:</Text>
          <Text color="gray" dimColor>
            The Azure resource group containing the AKS cluster (needed for
            kubeconfig access).
          </Text>
          <Box marginTop={1}>
            <Text color={colors.accent}>{" > "}</Text>
            <TextInput
              value={manualResourceGroup}
              onChange={setManualResourceGroup}
              onSubmit={handleManualResourceGroupSubmit}
              placeholder="my-resource-group"
            />
          </Box>
          {rgError && (
            <Box marginTop={1}>
              <Text color="red">✗ {rgError}</Text>
            </Box>
          )}
        </Box>
      )}

      {subStep === "kubeconfig-loading" && (
        <Box flexDirection="column" marginY={1}>
          <Spinner label="Refreshing kubeconfig for selected cluster..." />
        </Box>
      )}

      <Box marginTop={1}>
        <Text color="gray" dimColor>
          Esc to go back • Enter to continue
        </Text>
      </Box>
    </BorderBox>
  );
}

function getClusterKey(cluster: DiscoveredCluster): string {
  return [
    cluster.provider,
    cluster.region,
    cluster.resourceGroup || cluster.projectId || "",
    cluster.name,
  ].join(":");
}

function formatClusterRow(cluster: DiscoveredCluster): string {
  const details =
    cluster.resourceGroup || cluster.projectId || cluster.version || "-";
  const nodes =
    cluster.nodeCount === undefined || cluster.nodeCount === null
      ? "-"
      : String(cluster.nodeCount);

  return formatClusterColumns(cluster.name, cluster.region, details, nodes);
}

function formatClusterColumns(
  name: string,
  location: string,
  details: string,
  nodes: string,
): string {
  return [
    fit(name, 26),
    fit(location, 16),
    fit(details, 24),
    fit(nodes, 5),
  ].join(" ");
}

function fit(value: string, width: number): string {
  const text = value || "-";
  const clipped =
    text.length > width ? `${text.slice(0, Math.max(width - 1, 0))}~` : text;

  return clipped.padEnd(width, " ");
}
