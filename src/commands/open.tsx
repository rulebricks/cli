import React, { useState, useEffect } from "react";
import { Box, Text, useApp } from "ink";
import { spawn } from "child_process";
import path from "path";
import { promises as fs } from "fs";
import {
  BorderBox,
  Spinner,
  ThemeProvider,
  useTheme,
  Logo,
} from "../components/common/index.js";
import {
  deploymentExists,
  getDeploymentDir,
  getTerraformDir,
  getHelmValuesPath,
} from "../lib/config.js";

type OpenTarget = "all" | "config" | "values" | "terraform";

interface OpenCommandProps {
  name: string;
  target: OpenTarget;
}

type OpenStep = "validating" | "opening" | "complete" | "error";

/**
 * Resolves the appropriate command to open files/directories based on OS and environment
 */
function getOpenCommand(): { cmd: string; args: string[] } {
  // Check for $EDITOR environment variable first
  const editor = process.env.EDITOR;
  if (editor) {
    return { cmd: editor, args: [] };
  }

  // Fall back to OS-specific defaults
  const platform = process.platform;
  switch (platform) {
    case "darwin":
      return { cmd: "open", args: [] };
    case "win32":
      return { cmd: "cmd", args: ["/c", "start", '""'] };
    case "linux":
    default:
      return { cmd: "xdg-open", args: [] };
  }
}

/**
 * Opens a path using the system's default handler or $EDITOR
 */
async function openPath(targetPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const { cmd, args } = getOpenCommand();
    const child = spawn(cmd, [...args, targetPath], {
      detached: true,
      stdio: "ignore",
    });

    child.on("error", (err) => {
      reject(err);
    });

    // Unref to allow the parent process to exit independently
    child.unref();

    // Give it a moment to start, then resolve
    setTimeout(resolve, 500);
  });
}

function OpenCommandInner({ name, target }: OpenCommandProps) {
  const { exit } = useApp();
  const { colors } = useTheme();
  const [step, setStep] = useState<OpenStep>("validating");
  const [error, setError] = useState<string | null>(null);
  const [openedPath, setOpenedPath] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      try {
        // Validate deployment exists
        const exists = await deploymentExists(name);
        if (!exists) {
          setError(`Deployment "${name}" not found`);
          setStep("error");
          return;
        }

        // Determine what path to open
        let targetPath: string;
        const deployDir = getDeploymentDir(name);

        switch (target) {
          case "config":
            targetPath = path.join(deployDir, "config.yaml");
            break;
          case "values":
            targetPath = getHelmValuesPath(name);
            break;
          case "terraform":
            targetPath = getTerraformDir(name);
            break;
          case "all":
          default:
            targetPath = deployDir;
            break;
        }

        // Verify the target exists
        try {
          await fs.access(targetPath);
        } catch {
          if (target === "terraform") {
            setError(
              `Terraform directory not found. Run "rulebricks deploy ${name}" first to create infrastructure files.`,
            );
          } else if (target === "values") {
            setError(
              `values.yaml not found. Run "rulebricks init" or "rulebricks deploy ${name}" first.`,
            );
          } else {
            setError(`Path not found: ${targetPath}`);
          }
          setStep("error");
          return;
        }

        setOpenedPath(targetPath);
        setStep("opening");

        // Open the path
        await openPath(targetPath);

        setStep("complete");
        setTimeout(() => exit(), 2000);
      } catch (err) {
        setError(
          err instanceof Error
            ? err.message
            : "Failed to open deployment files",
        );
        setStep("error");
      }
    })();
  }, [name, target, exit]);

  // Validating screen
  if (step === "validating") {
    return (
      <BorderBox title="Open Deployment">
        <Box flexDirection="column" marginY={1}>
          <Spinner label="Locating deployment files..." />
        </Box>
      </BorderBox>
    );
  }

  // Error screen
  if (step === "error") {
    return (
      <BorderBox title="Open Failed">
        <Box flexDirection="column" marginY={1}>
          <Text color={colors.error} bold>
            ✗ Error
          </Text>
          <Text color={colors.error}>{error}</Text>
          <Box marginTop={1}>
            <Text color={colors.muted} dimColor>
              Use <Text color={colors.accent}>rulebricks list</Text> to see
              available deployments.
            </Text>
          </Box>
        </Box>
      </BorderBox>
    );
  }

  // Opening screen
  if (step === "opening") {
    return (
      <BorderBox title="Open Deployment">
        <Box flexDirection="column" marginY={1}>
          <Spinner label="Opening files..." />
        </Box>
      </BorderBox>
    );
  }

  // Complete screen
  const targetLabel =
    target === "all"
      ? "deployment directory"
      : target === "config"
        ? "config.yaml"
        : target === "values"
          ? "values.yaml"
          : "terraform directory";

  return (
    <BorderBox title="Opened">
      <Box flexDirection="column" marginY={1}>
        <Text color={colors.success} bold>
          ✓ Opened {targetLabel}
        </Text>

        <Box marginTop={1}>
          <Text color={colors.muted} dimColor>
            Path: {openedPath}
          </Text>
        </Box>

        {target === "all" && (
          <Box marginTop={1} flexDirection="column">
            <Text color={colors.muted}>Available files:</Text>
            <Text color={colors.muted}>
              {" "}
              • config.yaml - Deployment configuration
            </Text>
            <Text color={colors.muted}> • values.yaml - Helm chart values</Text>
            <Text color={colors.muted}>
              {" "}
              • terraform/ - Infrastructure files
            </Text>
          </Box>
        )}

        {(target === "values" || target === "config") && (
          <Box marginTop={1}>
            <Text color={colors.warning} dimColor>
              Note: Manual edits may desync from wizard-managed settings
            </Text>
          </Box>
        )}
      </Box>
    </BorderBox>
  );
}

export function OpenCommand(props: OpenCommandProps) {
  return (
    <ThemeProvider theme="status">
      <Logo />
      <OpenCommandInner {...props} />
    </ThemeProvider>
  );
}
