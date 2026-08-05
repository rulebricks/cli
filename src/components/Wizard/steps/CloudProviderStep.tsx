import React, { useEffect, useState } from "react";
import { Box, Text } from "ink";
import SelectInput from "ink-select-input";
import { useWizard } from "../WizardContext.js";
import { useFieldFlow, FlowField } from "../fieldFlow.js";
import {
  BorderBox,
  DiscoveredSelect,
  FieldError,
  StepFooter,
  TextField,
  useTheme,
} from "../../common/index.js";
import { Spinner } from "../../common/Spinner.js";
import { CloudProvider, CLOUD_PROVIDER_NAMES } from "../../../types/index.js";
import {
  checkAllCloudClis,
  AllCloudCliStatus,
  CloudCliStatus,
  DiscoveredCluster,
  discoverClustersInRegion,
  getAzureResourceGroupInfo,
  listRegionsWithFallback,
  getGcpProjectId,
  updateKubeconfig,
  CLI_INSTALL_URLS,
  CLI_LOGIN_COMMANDS,
} from "../../../lib/cloudCli.js";

interface CloudProviderStepProps {
  onComplete: () => void;
  onBack: () => void;
  entryDirection?: "forward" | "back";
}

function formatClusterColumns(
  name: string,
  location: string,
  details: string,
  nodes: string,
): string {
  return [fit(name, 26), fit(location, 16), fit(details, 24), fit(nodes, 5)].join(
    " ",
  );
}

function fit(value: string, width: number): string {
  const text = value || "-";
  const clipped =
    text.length > width ? `${text.slice(0, Math.max(width - 1, 0))}~` : text;
  return clipped.padEnd(width, " ");
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

export function CloudProviderStep({
  onComplete,
  onBack,
  entryDirection,
}: CloudProviderStepProps) {
  const { state, dispatch } = useWizard();
  const { colors } = useTheme();
  const [error, setError] = useState<string | null>(null);

  const [cliStatus, setCliStatus] = useState<AllCloudCliStatus | null>(null);
  const [provider, setProvider] = useState<CloudProvider | null>(state.provider);
  const [region, setRegion] = useState(state.region || "");
  const [regionManual, setRegionManual] = useState(false);
  const [clusterName, setClusterName] = useState(
    state.clusterName || "rulebricks-cluster",
  );
  const [clusterManual, setClusterManual] = useState(false);
  const [resourceGroup, setResourceGroup] = useState(
    state.azureResourceGroup || "",
  );
  const [rgChecking, setRgChecking] = useState(false);
  const [clustersByKey] = useState(new Map<string, DiscoveredCluster>());
  const [finishing, setFinishing] = useState(false);

  useEffect(() => {
    checkAllCloudClis().then(setCliStatus);
  }, []);

  const providerItems = cliStatus
    ? [
        { label: "AWS (EKS)", value: "aws" as const, status: cliStatus.aws },
        {
          label: "Google Cloud (GKE)",
          value: "gcp" as const,
          status: cliStatus.gcp,
        },
        {
          label: "Azure (AKS)",
          value: "azure" as const,
          status: cliStatus.azure,
        },
      ].map((item) => ({ ...item, disabled: !item.status.authenticated }))
    : [];

  const renderStatusIndicator = (status: CloudCliStatus) => {
    if (!status.installed) {
      return <Text color="gray"> (not installed)</Text>;
    }
    if (!status.authenticated) {
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

  // Refresh kubeconfig for the selected cluster, then leave the step. Failures
  // are non-fatal: the cluster scan in the Version step surfaces a concrete
  // access error if kubeconfig still points at the wrong cluster.
  const finish = async (
    selected: {
      name: string;
      region: string;
      resourceGroup?: string;
      projectId?: string;
    },
    advance: () => void,
  ) => {
    setFinishing(true);

    let projectId = selected.projectId;
    if (provider === "gcp" && !projectId) {
      try {
        projectId = (await getGcpProjectId()) || undefined;
      } catch {
        projectId = undefined;
      }
    }

    dispatch({ type: "SET_REGION", region: selected.region });
    dispatch({ type: "SET_CLUSTER_NAME", clusterName: selected.name });
    dispatch({
      type: "SET_AZURE_RG",
      resourceGroup: selected.resourceGroup || "",
    });
    dispatch({ type: "SET_GCP_PROJECT", projectId: projectId || "" });

    if (provider) {
      try {
        await updateKubeconfig(provider, selected.name, selected.region, {
          gcpProjectId: projectId,
          azureResourceGroup: selected.resourceGroup,
        });
      } catch {
        // Non-fatal; see note above.
      }
    }

    setFinishing(false);
    advance();
  };

  const fields: FlowField[] = [
    {
      id: "provider",
      render: (flow) => {
        if (!cliStatus) {
          return (
            <Box flexDirection="column" marginY={1}>
              <Spinner label="Checking cloud CLI tools..." />
              <Box marginTop={1}>
                <Text color="gray" dimColor>
                  Detecting AWS, GCP, and Azure CLIs...
                </Text>
              </Box>
            </Box>
          );
        }

        if (!cliStatus.anyInstalled) {
          return (
            <Box flexDirection="column" marginY={1}>
              <Text color={colors.error} bold>
                No cloud CLI tools detected
              </Text>
              <Box marginTop={1}>
                <Text>To discover clusters, install at least one cloud CLI:</Text>
              </Box>
              <Box marginTop={1} flexDirection="column" marginLeft={2}>
                {Object.entries(CLI_INSTALL_URLS).map(([key, info]) => (
                  <Box key={key} flexDirection="column" marginBottom={1}>
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
                {Object.entries(CLI_LOGIN_COMMANDS).map(([key, cmd]) => (
                  <Box key={key} flexDirection="column">
                    {Array.isArray(cmd) ? (
                      <>
                        <Text color="gray"> {key}:</Text>
                        {cmd.map((c, i) => (
                          <Text key={i} color="gray">
                            {"   "}
                            {c}
                          </Text>
                        ))}
                      </>
                    ) : (
                      <Text color="gray">
                        {" "}
                        {key}: {cmd}
                      </Text>
                    )}
                  </Box>
                ))}
              </Box>
            </Box>
          );
        }

        return (
          <Box flexDirection="column" marginY={1}>
            <Text bold>Select your cloud provider</Text>
            {!cliStatus.anyAvailable && (
              <Text color="yellow" dimColor>
                Some CLIs are installed but not authenticated
              </Text>
            )}
            <Box marginTop={1} flexDirection="column">
              <SelectInput
                items={providerItems.map((p) => ({
                  label: p.label,
                  value: p.value,
                }))}
                initialIndex={Math.max(
                  0,
                  providerItems.findIndex((p) => p.value === provider),
                )}
                onSelect={(item: { value: string }) => {
                  const selected = providerItems.find(
                    (p) => p.value === item.value,
                  );
                  if (!selected || selected.disabled) return;
                  const next = item.value as CloudProvider;
                  if (next !== provider) {
                    setRegion("");
                    setClusterName("rulebricks-cluster");
                    setResourceGroup("");
                  }
                  setProvider(next);
                  setClusterManual(false);
                  dispatch({ type: "SET_PROVIDER", provider: next });
                  flow.next();
                }}
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
            </Box>
          </Box>
        );
      },
    },
    {
      // Asked as soon as Azure is picked: every az discovery command the
      // wizard (and later the deploy) runs is scoped to this resource group,
      // so pickers only surface the deployment's own resources instead of the
      // whole subscription.
      id: "azure-rg",
      when: () => provider === "azure",
      render: (flow) => (
        <Box flexDirection="column">
          <TextField
            label="Azure resource group"
            hint="The resource group your cluster-setup deployment targeted. All Azure discovery from here on is scoped to it."
            value={resourceGroup}
            onChange={setResourceGroup}
            placeholder="rulebricks-rg"
            focus={!rgChecking}
            onSubmit={async () => {
              const name = resourceGroup.trim();
              if (!name) {
                setError("Resource group is required for Azure deployments");
                return;
              }
              setError(null);
              setRgChecking(true);
              const info = await getAzureResourceGroupInfo(name);
              setRgChecking(false);
              if (!info) {
                setError(
                  `Resource group "${name}" was not found in the active subscription (az account show).`,
                );
                return;
              }
              setResourceGroup(info.name);
              dispatch({ type: "SET_AZURE_RG", resourceGroup: info.name });
              // The group's location is the natural region default.
              if (!region && info.location) {
                setRegion(info.location);
              }
              flow.next();
            }}
          />
          {rgChecking && <Spinner label="Checking resource group..." />}
        </Box>
      ),
    },
    {
      id: "region",
      when: () => !!provider && !regionManual,
      render: (flow) => (
        <DiscoveredSelect
          label="Select the cluster's region"
          hint={
            provider === "azure"
              ? `Defaults to the resource group's location. Cluster discovery searches the resource group, not the region.`
              : `Rulebricks will only search ${provider ? CLOUD_PROVIDER_NAMES[provider] : ""} clusters in this region.`
          }
          loadingLabel="Loading available regions..."
          emptyHint="No regions listed. Press R to refresh or enter one manually."
          load={async () =>
            (await listRegionsWithFallback(provider as CloudProvider)).map(
              (r) => ({ label: r, value: r }),
            )
          }
          initialValue={region || undefined}
          onSelect={(value) => {
            setRegion(value);
            dispatch({ type: "SET_REGION", region: value });
            flow.next();
          }}
          onManual={() => {
            setRegionManual(true);
            flow.next();
          }}
        />
      ),
    },
    {
      id: "region-manual",
      onEscape: () => setRegionManual(false),
      when: () => !!provider && regionManual,
      render: (flow) => (
        <TextField
          label="Region"
          value={region}
          onChange={setRegion}
          placeholder={provider === "azure" ? "eastus" : "us-east-1"}
          onSubmit={() => {
            if (!region.trim()) {
              setError("Region is required");
              return;
            }
            setError(null);
            dispatch({ type: "SET_REGION", region: region.trim() });
            flow.next();
          }}
        />
      ),
    },
    {
      id: "cluster",
      when: () => !!provider && !clusterManual,
      render: (flow) => (
        <Box flexDirection="column">
          <DiscoveredSelect
            label="Select your Kubernetes cluster"
            hint={`${formatClusterColumns("Name", "Location", "Details", "Nodes")}`}
            loadingLabel={
              provider === "azure"
                ? `Fetching AKS clusters in resource group ${resourceGroup.trim()}...`
                : `Fetching ${provider ? CLOUD_PROVIDER_NAMES[provider] : ""} clusters in ${region}...`
            }
            emptyHint={
              provider === "azure"
                ? `No clusters found in resource group ${resourceGroup.trim()}. Press R to refresh, or enter a name manually (see cluster-setup/ for minimum Rulebricks examples).`
                : `No clusters found in ${region}. Press R to refresh, or enter a name manually (see cluster-setup/ for minimum Rulebricks examples).`
            }
            manualLabel="Enter cluster name manually…"
            load={async () => {
              const clusters = await discoverClustersInRegion(
                provider as CloudProvider,
                region,
                provider === "azure"
                  ? { azureResourceGroup: resourceGroup.trim() || undefined }
                  : undefined,
              );
              clustersByKey.clear();
              for (const cluster of clusters) {
                const key = [
                  cluster.provider,
                  cluster.region,
                  cluster.resourceGroup || cluster.projectId || "",
                  cluster.name,
                ].join(":");
                clustersByKey.set(key, cluster);
              }
              return [...clustersByKey.entries()].map(([key, cluster]) => ({
                label: formatClusterRow(cluster),
                value: key,
              }));
            }}
            recommendIndex={(items) =>
              items.findIndex(
                (item) => clustersByKey.get(item.value)?.name === clusterName,
              )
            }
            onSelect={(value) => {
              const cluster = clustersByKey.get(value);
              if (!cluster) return;
              setClusterName(cluster.name);
              finish(cluster, flow.next);
            }}
            onManual={() => {
              setClusterManual(true);
              flow.next();
            }}
          />
        </Box>
      ),
    },
    {
      id: "cluster-name",
      onEscape: () => setClusterManual(false),
      when: () => !!provider && clusterManual,
      render: (flow) => (
        <TextField
          label="Enter the Kubernetes cluster name"
          hint="If kubectl already points at the cluster, you can enter its name manually. Need a basic cluster? See cluster-setup/."
          value={clusterName}
          onChange={setClusterName}
          placeholder="rulebricks-cluster"
          onSubmit={() => {
            if (!clusterName.trim()) {
              setError("Cluster name is required");
              return;
            }
            setError(null);
            dispatch({
              type: "SET_CLUSTER_NAME",
              clusterName: clusterName.trim(),
            });
            finish(
              {
                name: clusterName.trim(),
                region,
                // Azure: already collected and validated up front.
                resourceGroup:
                  provider === "azure" ? resourceGroup.trim() : undefined,
              },
              flow.next,
            );
          }}
        />
      ),
    },
  ];

  const flow = useFieldFlow({
    fields,
    onDone: onComplete,
    onExit: onBack,
    entry: entryDirection === "back" ? "end" : "start",
    escapeGoesBack: !finishing,
    onNavigate: () => setError(null),
  });

  return (
    <BorderBox title="Cloud Provider" footer={<StepFooter />}>
      {finishing ? (
        <Box flexDirection="column" marginY={1}>
          <Spinner label="Refreshing kubeconfig for selected cluster..." />
        </Box>
      ) : (
        flow.render()
      )}

      <FieldError error={error} />
    </BorderBox>
  );
}
