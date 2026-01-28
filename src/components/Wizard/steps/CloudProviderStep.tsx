import React, { useState, useEffect } from "react";
import { Box, Text, useInput } from "ink";
import SelectInput from "ink-select-input";
import TextInput from "ink-text-input";
import { useWizard } from "../WizardContext.js";
import { BorderBox, useTheme } from "../../common/index.js";
import { Spinner } from "../../common/Spinner.js";
import { CLOUD_REGIONS, CloudProvider } from "../../../types/index.js";
import {
  checkAllCloudClis,
  AllCloudCliStatus,
  CloudCliStatus,
  TerraformStatus,
  checkTerraform,
  listRegions,
  listClusters,
  getGcpProjectId,
  CLI_INSTALL_URLS,
  CLI_LOGIN_COMMANDS,
  TERRAFORM_INSTALL_INFO,
} from "../../../lib/cloudCli.js";

interface CloudProviderStepProps {
  onComplete: () => void;
  onBack: () => void;
}

type SubStep =
  | "checking"
  | "no-cli"
  | "provider"
  | "region"
  | "region-loading"
  | "cluster"
  | "cluster-loading"
  | "cluster-select"
  | "gcp-project"
  | "azure-rg";

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
  const [terraformStatus, setTerraformStatus] =
    useState<TerraformStatus | null>(null);
  const [clusterName, setClusterName] = useState(
    state.clusterName || "rulebricks-cluster",
  );
  const [gcpProject, setGcpProject] = useState(state.gcpProjectId || "");
  const [azureRg, setAzureRg] = useState(state.azureResourceGroup || "");
  const [regions, setRegions] = useState<string[]>([]);
  const [regionsLoading, setRegionsLoading] = useState(false);
  const [clusters, setClusters] = useState<string[]>([]);
  const [clustersLoading, setClustersLoading] = useState(false);

  // Whether we need infrastructure provisioning (Terraform required)
  const needsTerraform = state.infrastructureMode === "provision";

  // Check CLIs on mount
  useEffect(() => {
    async function checkClis() {
      // Check cloud CLIs and Terraform in parallel
      const [status, tfStatus] = await Promise.all([
        checkAllCloudClis(),
        needsTerraform
          ? checkTerraform()
          : Promise.resolve({ installed: true } as TerraformStatus),
      ]);

      setCliStatus(status);
      setTerraformStatus(tfStatus);

      if (!status.anyInstalled) {
        setSubStep("no-cli");
      } else {
        setSubStep("provider");
      }
    }

    checkClis();
  }, [needsTerraform]);

  useInput((input, key) => {
    if (key.escape) {
      if (
        subStep === "provider" ||
        subStep === "no-cli" ||
        subStep === "checking"
      ) {
        onBack();
      } else if (subStep === "region" || subStep === "region-loading") {
        setSubStep("provider");
      } else if (
        subStep === "cluster" ||
        subStep === "cluster-loading" ||
        subStep === "cluster-select"
      ) {
        setSubStep("region");
      } else if (subStep === "gcp-project") {
        setSubStep("provider");
      } else if (subStep === "azure-rg") {
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
      disabled: !p.status.installed || !p.status.authenticated,
    }));
  };

  const providerItems = getProviderItems();

  const handleProviderSelect = async (item: { value: string }) => {
    const selectedItem = providerItems.find((p) => p.value === item.value);
    if (!selectedItem || selectedItem.disabled) return;

    const provider = item.value as CloudProvider;
    dispatch({ type: "SET_PROVIDER", provider });

    if (provider === "gcp") {
      // Try to auto-fill GCP project ID
      const detectedProject = await getGcpProjectId();
      if (detectedProject) {
        setGcpProject(detectedProject);
      }
      setSubStep("gcp-project");
    } else if (provider === "azure") {
      setSubStep("azure-rg");
    } else {
      loadRegions(provider);
    }
  };

  const loadRegions = async (provider: CloudProvider) => {
    setSubStep("region-loading");
    setRegionsLoading(true);

    try {
      const dynamicRegions = await listRegions(provider);

      if (dynamicRegions.length > 0) {
        setRegions(dynamicRegions);
      } else {
        // Fall back to static regions
        setRegions(CLOUD_REGIONS[provider]);
      }
    } catch {
      // Fall back to static regions on error
      setRegions(CLOUD_REGIONS[provider]);
    }

    setRegionsLoading(false);
    setSubStep("region");
  };

  const handleRegionSelect = (item: { value: string }) => {
    dispatch({ type: "SET_REGION", region: item.value });

    // For existing infrastructure, load available clusters
    if (state.infrastructureMode === "existing" && state.provider) {
      loadClusters(state.provider, item.value);
    } else {
      // For provisioning, go directly to cluster name input
      setSubStep("cluster");
    }
  };

  const loadClusters = async (provider: CloudProvider, region: string) => {
    setSubStep("cluster-loading");
    setClustersLoading(true);

    try {
      const availableClusters = await listClusters(provider, region, {
        azureResourceGroup: state.azureResourceGroup || undefined,
      });

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

    setClustersLoading(false);
  };

  const handleClusterSelect = (item: { value: string }) => {
    setClusterName(item.value);
    dispatch({ type: "SET_CLUSTER_NAME", clusterName: item.value });
    onComplete();
  };

  const handleClusterSubmit = () => {
    dispatch({ type: "SET_CLUSTER_NAME", clusterName });
    onComplete();
  };

  const handleGcpProjectSubmit = () => {
    dispatch({ type: "SET_GCP_PROJECT", projectId: gcpProject });
    loadRegions("gcp");
  };

  const handleAzureRgSubmit = () => {
    dispatch({ type: "SET_AZURE_RG", resourceGroup: azureRg });
    loadRegions("azure");
  };

  const regionItems = regions.map((r) => ({ label: r, value: r }));

  // Render status indicator for a provider
  const renderStatusIndicator = (status: CloudCliStatus) => {
    if (!status.installed) {
      return <Text color="gray"> (not installed)</Text>;
    }
    if (!status.authenticated) {
      return <Text color="yellow"> (log in required)</Text>;
    }
    return <Text color="green"> ✓</Text>;
  };

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
              To provision infrastructure, you need to install and authenticate
              with at least one cloud CLI:
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
              <Text key={provider} color="gray">
                {" "}
                {provider}: {cmd}
              </Text>
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
                ⚠ Some CLIs are installed but not authenticated
              </Text>
            )}
            {needsTerraform &&
              terraformStatus &&
              !terraformStatus.installed && (
                <Box
                  marginTop={1}
                  borderStyle="round"
                  borderColor="yellow"
                  paddingX={1}
                  flexDirection="column"
                >
                  <Text color="yellow" bold>
                    ⚠ Terraform not installed
                  </Text>
                  <Text color="gray">
                    You'll need Terraform to provision infrastructure.
                  </Text>
                  <Text color="gray">
                    Install: {TERRAFORM_INSTALL_INFO.installCmd}
                  </Text>
                  <Text color="gray" dimColor>
                    {TERRAFORM_INSTALL_INFO.url}
                  </Text>
                </Box>
              )}
            {needsTerraform && terraformStatus?.installed && (
              <Box marginTop={1}>
                <Text color="green">✓</Text>
                <Text color="gray">
                  {" "}
                  Terraform{" "}
                  {terraformStatus.version
                    ? `v${terraformStatus.version}`
                    : ""}{" "}
                  detected
                </Text>
              </Box>
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
                    {isSelected && !item.disabled ? "❯ " : "  "}
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

      {subStep === "gcp-project" && (
        <Box flexDirection="column" marginY={1}>
          <Text>Enter your GCP Project ID:</Text>
          {gcpProject && (
            <Text color="gray" dimColor>
              Detected project: {gcpProject}
            </Text>
          )}
          <Box marginTop={1}>
            <Text color={colors.accent}>❯ </Text>
            <TextInput
              value={gcpProject}
              onChange={setGcpProject}
              onSubmit={handleGcpProjectSubmit}
              placeholder="my-gcp-project"
            />
          </Box>
        </Box>
      )}

      {subStep === "azure-rg" && (
        <Box flexDirection="column" marginY={1}>
          <Text>Enter your Azure Resource Group name:</Text>
          <Text color="gray" dimColor>
            This resource group will contain all Rulebricks resources
          </Text>
          <Box marginTop={1}>
            <Text color={colors.accent}>❯ </Text>
            <TextInput
              value={azureRg}
              onChange={setAzureRg}
              onSubmit={handleAzureRgSubmit}
              placeholder="rulebricks-rg"
            />
          </Box>
        </Box>
      )}

      {subStep === "region-loading" && (
        <Box flexDirection="column" marginY={1}>
          <Spinner
            label={`Fetching ${state.provider?.toUpperCase()} regions...`}
          />
        </Box>
      )}

      {subStep === "region" && (
        <>
          <Box flexDirection="column" marginY={1}>
            <Text>Select a region for {state.provider?.toUpperCase()}:</Text>
            <Text color="gray" dimColor>
              {regions.length} regions available
            </Text>
          </Box>
          <Box height={10} flexDirection="column" overflowY="hidden">
            <SelectInput
              items={regionItems}
              onSelect={handleRegionSelect}
              limit={8}
              indicatorComponent={() => null}
              itemComponent={({ isSelected, label }) => (
                <Text color={isSelected ? colors.accent : undefined}>
                  {isSelected ? "❯ " : "  "}
                  {label}
                </Text>
              )}
            />
          </Box>
        </>
      )}

      {subStep === "cluster-loading" && (
        <Box flexDirection="column" marginY={1}>
          <Spinner
            label={`Fetching ${state.provider?.toUpperCase()} clusters in ${state.region}...`}
          />
        </Box>
      )}

      {subStep === "cluster-select" && (
        <>
          <Box flexDirection="column" marginY={1}>
            <Text>Select your Kubernetes cluster:</Text>
            <Text color="gray" dimColor>
              {clusters.length} cluster{clusters.length !== 1 ? "s" : ""} found
              in {state.region}
            </Text>
          </Box>
          <Box height={10} flexDirection="column" overflowY="hidden">
            <SelectInput
              items={clusters.map((c) => ({ label: c, value: c }))}
              onSelect={handleClusterSelect}
              limit={8}
              indicatorComponent={() => null}
              itemComponent={({ isSelected, label }) => (
                <Text color={isSelected ? colors.accent : undefined}>
                  {isSelected ? "❯ " : "  "}
                  {label}
                </Text>
              )}
            />
          </Box>
          {state.provider && state.region && (
            <Box marginTop={1}>
              <Text color={colors.success}>✓</Text>
              <Text color="gray">
                {" "}
                {state.provider?.toUpperCase()} • {state.region}
              </Text>
            </Box>
          )}
        </>
      )}

      {subStep === "cluster" && (
        <Box flexDirection="column" marginY={1}>
          <Text>Enter the Kubernetes cluster name:</Text>
          <Text color="gray" dimColor>
            {state.infrastructureMode === "provision"
              ? "This cluster will be created"
              : clusters.length === 0 && state.infrastructureMode === "existing"
                ? "No clusters found in this region - enter the name manually"
                : "Enter the name of your existing cluster"}
          </Text>
          <Box marginTop={1}>
            <Text color={colors.accent}>❯ </Text>
            <TextInput
              value={clusterName}
              onChange={setClusterName}
              onSubmit={handleClusterSubmit}
              placeholder="rulebricks-cluster"
            />
          </Box>
          {state.provider && state.region && (
            <Box marginTop={1}>
              <Text color={colors.success}>✓</Text>
              <Text color="gray">
                {" "}
                {state.provider?.toUpperCase()} • {state.region}
              </Text>
            </Box>
          )}
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
