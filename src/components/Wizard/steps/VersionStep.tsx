import React, { useState, useEffect } from "react";
import { Box, Text, useInput } from "ink";
import SelectInput from "ink-select-input";
import TextInput from "ink-text-input";
import { useWizard } from "../WizardContext.js";
import { BorderBox, useTheme } from "../../common/index.js";
import { Spinner } from "../../common/Spinner.js";
import { fetchAppVersions, formatDate } from "../../../lib/versions.js";
import { AppVersion, CHANGELOG_URL } from "../../../types/index.js";
import { formatVersionDisplay } from "../../../lib/dockerHub.js";

interface VersionStepProps {
  onComplete: () => void;
  onBack: () => void;
}

type SubStep = "license" | "loading-versions" | "version";

export function VersionStep({ onComplete, onBack }: VersionStepProps) {
  const { state, dispatch } = useWizard();
  const { colors } = useTheme();
  const [subStep, setSubStep] = useState<SubStep>("license");
  const [licenseKey, setLicenseKey] = useState(state.licenseKey || "");
  const [versions, setVersions] = useState<AppVersion[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useInput((input, key) => {
    if (key.escape) {
      setError(null);
      if (subStep === "license") {
        onBack();
      } else if (subStep === "version") {
        setSubStep("license");
      }
    }
  });

  const loadVersions = async () => {
    setSubStep("loading-versions");
    setLoadError(null);

    try {
      const appVersions = await fetchAppVersions(licenseKey);
      setVersions(appVersions);

      if (appVersions.length === 0) {
        setLoadError("No versions found. Using latest.");
      }

      setSubStep("version");
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "Failed to fetch versions";

      // Check if it's an auth error
      if (
        message.includes("authentication") ||
        message.includes("Invalid license")
      ) {
        setError("Invalid license key - please check your key and try again");
        setSubStep("license");
        return;
      }

      setLoadError(`${message}. Will use latest version.`);
      setSubStep("version");
    }
  };

  const handleLicenseSubmit = () => {
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
    loadVersions();
  };

  const handleVersionSelect = (item: {
    value: string;
    hpsVersion?: string;
  }) => {
    dispatch({
      type: "SET_APP_VERSION",
      appVersion: item.value,
      hpsVersion: item.hpsVersion || item.value,
    });
    onComplete();
  };

  // Get the latest version (first numbered version from sorted list)
  const latestVersion = versions.length > 0 ? versions[0] : null;

  // Build version items for selection
  // "Latest" uses the actual first numbered version, not empty string
  const versionItems = latestVersion
    ? [
        {
          label: `✨ Latest (${formatVersionDisplay(latestVersion.version)})`,
          value: latestVersion.version,
          hpsVersion: latestVersion.hpsVersion || latestVersion.version,
          releaseDate: latestVersion.releaseDate,
        },
        // Skip the first version since it's shown as "Latest"
        ...versions.slice(1, 15).map((v) => ({
          label: formatVersionDisplay(v.version),
          value: v.version,
          hpsVersion: v.hpsVersion || v.version,
          releaseDate: v.releaseDate,
        })),
      ]
    : [
        {
          label: "✨ Latest (recommended)",
          value: "latest",
          hpsVersion: "latest",
          releaseDate: null,
        },
      ];

  return (
    <BorderBox title="License & Version">
      {subStep === "license" && (
        <Box flexDirection="column" marginY={1}>
          <Text>Enter your Rulebricks license key:</Text>
          <Text color="gray" dimColor>
            Get a license at https://rulebricks.com/pricing
          </Text>
          <Box marginTop={1}>
            <TextInput
              value={licenseKey}
              onChange={setLicenseKey}
              onSubmit={handleLicenseSubmit}
              placeholder="vd67aveCHr1G..."
            />
          </Box>
        </Box>
      )}

      {subStep === "loading-versions" && (
        <Box flexDirection="column" marginY={1}>
          <Spinner label="Authenticating and fetching versions..." />
          <Box marginTop={1}>
            <Text color="gray" dimColor>
              Connecting to Docker Hub...
            </Text>
          </Box>
        </Box>
      )}

      {subStep === "version" && (
        <Box flexDirection="column" marginY={1}>
          <Text>Select app version to deploy:</Text>
          {loadError && (
            <Text color={colors.warning} dimColor>
              ⚠ {loadError}
            </Text>
          )}
          <Box
            marginTop={1}
            height={12}
            flexDirection="column"
            overflowY="hidden"
          >
            <SelectInput
              items={versionItems}
              onSelect={handleVersionSelect}
              limit={10}
              indicatorComponent={() => null}
              itemComponent={({ isSelected, label }) => {
                // Find the version item from the list using the label
                const versionItem = versionItems.find((v) => v.label === label);
                const hasHps =
                  versionItem?.value &&
                  versionItem?.hpsVersion &&
                  versionItem.value !== "latest";
                const hasDate = versionItem?.releaseDate;

                return (
                  <Box>
                    <Text color={isSelected ? colors.accent : undefined}>
                      {isSelected ? "❯ " : "  "}
                      {label}
                    </Text>
                    {hasDate && (
                      <Text color={colors.muted}>
                        {" "}
                        ({formatDate(versionItem!.releaseDate!)})
                      </Text>
                    )}
                    {hasHps && (
                      <Text color={colors.muted}>
                        {"  "}Solver:{" "}
                        {formatVersionDisplay(versionItem!.hpsVersion!)}
                      </Text>
                    )}
                  </Box>
                );
              }}
            />
          </Box>
          <Box marginTop={1}>
            <Text color={colors.success}>✓</Text>
            <Text color="gray">
              {" "}
              License key: {licenseKey.substring(0, 8)}...
            </Text>
          </Box>
          <Box marginTop={1}>
            <Text color="gray" dimColor>
              View changelog: {CHANGELOG_URL}
            </Text>
          </Box>
        </Box>
      )}

      {error && (
        <Box marginTop={1}>
          <Text color={colors.error}>✗ {error}</Text>
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
