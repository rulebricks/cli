import React, { useEffect, useRef, useState } from "react";
import { Box, Text } from "ink";
import { useWizard } from "../WizardContext.js";
import { useFieldFlow, FlowField, FlowController } from "../fieldFlow.js";
import {
  BorderBox,
  CheckRows,
  DiscoveredSelect,
  FieldError,
  StepFooter,
  TextField,
  WizardSelect,
  useTheme,
} from "../../common/index.js";
import { Spinner } from "../../common/Spinner.js";
import { fetchAppVersions, formatDate } from "../../../lib/versions.js";
import {
  AppVersion,
  CHANGELOG_URL,
  NodeArchitecture,
} from "../../../types/index.js";
import { formatVersionDisplay } from "../../../lib/dockerHub.js";
import { inferClusterCapabilities } from "../../../lib/kubernetes.js";
import {
  listAzureContainerRegistries,
  AzureContainerRegistry,
} from "../../../lib/cloudCli.js";
import { findClusterSetupDefaultIndex } from "../../../lib/clusterSetupDefaults.js";

interface VersionStepProps {
  onComplete: () => void;
  onBack: () => void;
  entryDirection?: "forward" | "back";
}

function VersionPicker({ flow }: { flow: FlowController }) {
  const { state, dispatch } = useWizard();
  const { colors } = useTheme();
  const [loading, setLoading] = useState(true);
  const [versions, setVersions] = useState<AppVersion[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [authError, setAuthError] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      try {
        // Scan the cluster for its capabilities (node architecture, storage
        // class, ARM tolerations) unless an earlier scan already populated
        // them. The architecture selects the matching image versions.
        let architecture: NodeArchitecture | undefined;
        if (
          state.nodeArchitecture === "amd64" ||
          state.nodeArchitecture === "arm64"
        ) {
          architecture = state.nodeArchitecture;
        } else {
          const capabilities = await inferClusterCapabilities();
          if (capabilities) {
            dispatch({
              type: "SET_CLUSTER_CAPABILITIES",
              nodeArchitecture: capabilities.nodeArchitecture,
              arm64TolerationRequired: capabilities.arm64TolerationRequired,
              storageClass: capabilities.storageClass,
              storageProvisioner: capabilities.storageProvisioner,
              schedulableNodeCount: capabilities.schedulableNodeCount,
              totalCpuCores: capabilities.totalCpuCores,
              totalMemoryGi: capabilities.totalMemoryGi,
              eligibleCpuCores: capabilities.eligibleCpuCores,
              eligibleMemoryGi: capabilities.eligibleMemoryGi,
              totalPersistentStorageGi:
                capabilities.totalPersistentStorageGi ?? 0,
            });
            if (
              capabilities.nodeArchitecture === "amd64" ||
              capabilities.nodeArchitecture === "arm64"
            ) {
              architecture = capabilities.nodeArchitecture;
            }
          }
        }

        const appVersions = await fetchAppVersions(
          state.licenseKey,
          architecture,
        );
        setVersions(appVersions);
        if (appVersions.length === 0 && architecture) {
          setLoadError(
            `No compatible Rulebricks version found for ${architecture} nodes.`,
          );
        } else if (appVersions.length === 0) {
          setLoadError("No Rulebricks versions found.");
        }
      } catch (err) {
        const message =
          err instanceof Error ? err.message : "Failed to fetch versions";
        if (
          message.includes("authentication") ||
          message.includes("Invalid license")
        ) {
          setAuthError(
            "Invalid license key - press Esc to go back and re-enter it.",
          );
        } else {
          setLoadError(`${message}. Will use latest version.`);
        }
      }
      setLoading(false);
    })();
  }, []);

  if (loading) {
    return (
      <Box flexDirection="column" marginY={1}>
        <Spinner label="Authenticating and fetching versions..." />
        <Box marginTop={1}>
          <Text color="gray" dimColor>
            Connecting to Docker Hub...
          </Text>
        </Box>
      </Box>
    );
  }

  if (authError) {
    return (
      <Box flexDirection="column" marginY={1}>
        <Text color={colors.error}>{authError}</Text>
      </Box>
    );
  }

  const latestVersion = versions.length > 0 ? versions[0] : null;
  const items = latestVersion
    ? [
        {
          label: `Latest (${formatVersionDisplay(latestVersion.version)})${
            latestVersion.releaseDate
              ? `  ${formatDate(latestVersion.releaseDate)}`
              : ""
          }`,
          value: latestVersion.version,
        },
        ...versions.slice(1, 15).map((v) => ({
          label: `${formatVersionDisplay(v.version)}${
            v.releaseDate ? `  ${formatDate(v.releaseDate)}` : ""
          }`,
          value: v.version,
        })),
      ]
    : [];

  if (items.length === 0) {
    return (
      <Box flexDirection="column" marginY={1}>
        {loadError && (
          <Text color={colors.warning}>{loadError}</Text>
        )}
        <Text color={colors.warning}>
          No compatible image versions are available for this cluster.
        </Text>
      </Box>
    );
  }

  return (
    <Box flexDirection="column">
      {loadError && (
        <Text color={colors.warning} dimColor>
          {loadError}
        </Text>
      )}
      <WizardSelect
        label="Select Rulebricks version to deploy"
        hint={`View changelog: ${CHANGELOG_URL}`}
        items={items}
        initialValue={state.version || undefined}
        onSelect={(value) => {
          dispatch({ type: "SET_VERSION", version: value });
          flow.next();
        }}
      />
    </Box>
  );
}

export function VersionStep({
  onComplete,
  onBack,
  entryDirection,
}: VersionStepProps) {
  const { state, dispatch } = useWizard();
  const [error, setError] = useState<string | null>(null);
  const [licenseKey, setLicenseKey] = useState(state.licenseKey || "");
  // The registry offered by the image-source picker's full-mirror option.
  const acrRef = useRef<AzureContainerRegistry | null>(null);

  const fields: FlowField[] = [
    {
      id: "license",
      render: (flow) => (
        <TextField
          label="Enter your Rulebricks license key"
          hint="Get a license at https://rulebricks.com/pricing"
          value={licenseKey}
          onChange={setLicenseKey}
          placeholder="vd67aveCHr1G..."
          mask
          onSubmit={() => {
            if (!licenseKey) {
              setError("License key is required");
              return;
            }
            if (licenseKey.length < 10) {
              setError("Invalid license key format");
              return;
            }
            setError(null);
            dispatch({ type: "SET_LICENSE_KEY", key: licenseKey });
            flow.next();
          }}
        />
      ),
    },
    {
      id: "version",
      render: (flow) => <VersionPicker flow={flow} />,
    },
    {
      // Two sources only: the Rulebricks repositories (docker.io images +
      // ghcr.io chart), or a full mirror into the deployment's ACR - the CLI
      // imports every image AND the helm chart and installs from the registry.
      id: "image-source",
      when: () => state.provider === "azure",
      render: (flow) => (
        <DiscoveredSelect
          label="Container image source"
          hint="Where the cluster pulls Rulebricks images and the helm chart from. Full mirror re-runs automatically when versions or the chart change."
          loadingLabel="Looking for container registries..."
          emptyHint="No Azure Container Registry found in this subscription."
          manualLabel="Use the Rulebricks repositories (docker.io + ghcr.io)"
          showManualOption={false}
          initialValue={state.imageRegistry ? "mirror" : "docker"}
          preferRecommended={!state.configLoaded}
          recommendIndex={(items) => {
            if (!acrRef.current) return -1;
            return items.findIndex((item) => item.value === "mirror");
          }}
          load={async () => {
            const registries = await listAzureContainerRegistries(
              state.azureResourceGroup || undefined,
            );
            // Prefer the cluster-setup registry by name (<cluster-stripped>acr,
            // hashed on older deployments), then any registry in the
            // deployment's resource group, then the first one found.
            const setupIndex = findClusterSetupDefaultIndex(
              registries.map((r) => r.name),
              "container-registry",
              { provider: "azure", clusterName: state.clusterName },
            );
            const preferred =
              (setupIndex >= 0 ? registries[setupIndex] : undefined) ??
              registries.find(
                (r) =>
                  r.resourceGroup.toLowerCase() ===
                  (state.azureResourceGroup || "").toLowerCase(),
              ) ??
              registries[0] ??
              null;
            acrRef.current = preferred;
            const items = [
              {
                label: "Rulebricks repositories (docker.io + ghcr.io)",
                value: "docker",
              },
            ];
            if (preferred) {
              items.push({
                label: `${preferred.loginServer} - full mirror (images + helm chart)`,
                value: "mirror",
              });
            }
            return items;
          }}
          onSelect={(value) => {
            if (value === "docker" || !acrRef.current) {
              dispatch({
                type: "SET_IMAGE_REGISTRY",
                registry: "",
                resourceId: "",
                mode: "",
              });
            } else {
              dispatch({
                type: "SET_IMAGE_REGISTRY",
                registry: acrRef.current.loginServer,
                resourceId: acrRef.current.id,
                mode: "mirror",
              });
            }
            setError(null);
            flow.next();
          }}
          onManual={() => {
            dispatch({
              type: "SET_IMAGE_REGISTRY",
              registry: "",
              resourceId: "",
              mode: "",
            });
            flow.next();
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
    onNavigate: () => setError(null),
  });

  return (
    <BorderBox title="License & Version" footer={<StepFooter />}>
      {flow.render()}

      {flow.current === "version" && licenseKey && (
        <CheckRows
          rows={[
            { label: "License key", value: `${licenseKey.substring(0, 8)}...` },
          ]}
        />
      )}
      <FieldError error={error} />
    </BorderBox>
  );
}
