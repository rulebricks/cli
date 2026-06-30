#!/usr/bin/env node
import { createRequire } from "node:module";
import { Command } from "commander";
import { render } from "ink";
import React from "react";
import chalk from "chalk";

import { InitWizard } from "./commands/init.js";
import { DeployCommand } from "./commands/deploy.js";
import { RedeployCommand } from "./commands/redeploy.js";
import { UpgradeCommand } from "./commands/upgrade.js";
import { DestroyCommand } from "./commands/destroy.js";
import { StatusCommand } from "./commands/status.js";
import { ListCommand } from "./commands/list.js";
import { LogsCommand } from "./commands/logs.js";
import { CloneCommand } from "./commands/clone.js";
import { OpenCommand } from "./commands/open.js";
import { BenchmarkCommand } from "./commands/benchmark.js";
import { BackupCommand } from "./commands/backup.js";
import { RestoreCommand } from "./commands/restore.js";
import { listDeployments, deploymentExists } from "./lib/config.js";
import { DeploymentPicker } from "./components/common/DeploymentPicker.js";

const require = createRequire(import.meta.url);
const packageJson = require("../package.json") as { version: string };

const VERSION = packageJson.version;

const program = new Command();

program
  .name("rulebricks")
  .description("CLI for deploying and managing private Rulebricks instances")
  .version(VERSION)
  .hook("preAction", () => {
    // Clear terminal for a fresh start
    // Logo is now rendered via Ink's Static component in each command
    console.clear();
  });

// Init command - interactive configuration wizard
program
  .command("init")
  .description("Initialize a new Rulebricks deployment configuration")
  .argument("[name]", "Deployment name")
  .option(
    "-n, --name <name>",
    "Deployment name (alternative to positional argument)",
  )
  .action(async (name, options) => {
    const deploymentName = name || options.name;
    const { waitUntilExit } = render(
      <InitWizard initialName={deploymentName} />,
    );
    await waitUntilExit();
  });

// Deploy command
program
  .command("deploy")
  .description("Deploy Rulebricks to your cluster")
  .argument("[name]", "Deployment name")
  .option("--chart-version <version>", "Specific chart version to deploy")
  .option("--version <version>", "Deprecated alias for --chart-version")
  .option(
    "--inline-secrets",
    "Write secrets inline into values.yaml instead of creating Kubernetes Secrets (dev clusters only)",
  )
  .action(async (name, options) => {
    const deploymentName = name || (await selectDeployment("deploy"));
    if (!deploymentName) {
      console.error(
        chalk.red('No deployments found. Run "rulebricks init" first.'),
      );
      process.exit(1);
    }

    const { waitUntilExit } = render(
      <DeployCommand
        name={deploymentName}
        version={options.chartVersion || options.version}
        inlineSecrets={options.inlineSecrets}
      />,
    );
    await waitUntilExit();
  });

// Redeploy command
program
  .command("redeploy")
  .description("Reconfigure and redeploy an existing Rulebricks deployment")
  .argument("[name]", "Deployment name")
  .option("--chart-version <version>", "Specific chart version to deploy")
  .action(async (name, options) => {
    const deploymentName = name || (await selectDeployment("redeploy"));
    if (!deploymentName) {
      console.error(
        chalk.red('No deployments found. Run "rulebricks init" first.'),
      );
      process.exit(1);
    }

    const { waitUntilExit } = render(
      <RedeployCommand
        name={deploymentName}
        chartVersion={options.chartVersion}
      />,
    );
    await waitUntilExit();
  });

// Upgrade command
program
  .command("upgrade")
  .description("Upgrade Rulebricks to a new version")
  .argument("[name]", "Deployment name")
  .option("--version <version>", "Target version (defaults to latest)")
  .option("--dry-run", "Preview changes without applying")
  .action(async (name, options) => {
    const deploymentName = name || (await selectDeployment("upgrade"));
    if (!deploymentName) {
      console.error(
        chalk.red('No deployments found. Run "rulebricks init" first.'),
      );
      process.exit(1);
    }

    const { waitUntilExit } = render(
      <UpgradeCommand
        name={deploymentName}
        targetVersion={options.version}
        dryRun={options.dryRun}
      />,
    );
    await waitUntilExit();
  });

// Destroy command
program
  .command("destroy")
  .description("Destroy a Rulebricks deployment")
  .argument("[name]", "Deployment name")
  .option("--config", "Also delete local configuration files")
  .option("-f, --force", "Skip confirmation")
  .option(
    "--purge",
    "Force removal of cluster-shared CRDs (cert-manager/keda/strimzi/prometheus); by default they're removed only when this is the last Rulebricks deployment on the cluster",
  )
  .action(async (name, options) => {
    // For destroy, require explicit deployment name
    if (!name) {
      const deployments = await listDeployments();
      if (deployments.length === 0) {
        console.error(
          chalk.red('No deployments found. Run "rulebricks init" first.'),
        );
      } else {
        console.error(chalk.red("Please specify a deployment to destroy.\n"));
        console.log("Available deployments:");
        for (const d of deployments) {
          console.log(`  ${chalk.yellow("•")} ${d}`);
        }
        console.log(`\nUsage: ${chalk.cyan("rulebricks destroy <name>")}`);
      }
      process.exit(1);
    }

    const { waitUntilExit } = render(
      <DestroyCommand
        name={name}
        config={options.config}
        force={options.force}
        purge={options.purge}
      />,
    );
    await waitUntilExit();
  });

// Status command
program
  .command("status")
  .description("Show deployment status")
  .argument("[name]", "Deployment name")
  .action(async (name) => {
    const deploymentName = name || (await selectDeployment("show status for"));
    if (!deploymentName) {
      console.error(
        chalk.red('No deployments found. Run "rulebricks init" first.'),
      );
      process.exit(1);
    }

    const { waitUntilExit } = render(<StatusCommand name={deploymentName} />);
    await waitUntilExit();
  });

// Logs command
program
  .command("logs")
  .description("View component logs")
  .argument("[name]", "Deployment name")
  .argument(
    "[component]",
    "Component: app, hps, workers, kafka, supabase, traefik",
  )
  .option("-f, --follow", "Follow log output (default: true)")
  .option("--no-follow", "Show logs once without following")
  .option("-t, --tail <lines>", "Number of lines to show", "100")
  .option("-s, --split", "Show logs in split-pane view (side-by-side columns)")
  .action(async (name, component, options) => {
    const deploymentName = name || (await selectDeployment("view logs for"));
    if (!deploymentName) {
      console.error(
        chalk.red('No deployments found. Run "rulebricks init" first.'),
      );
      process.exit(1);
    }

    const { waitUntilExit } = render(
      <LogsCommand
        name={deploymentName}
        component={component}
        follow={options.follow}
        tail={parseInt(options.tail, 10)}
        split={options.split}
      />,
    );
    await waitUntilExit();
  });

// List command
program
  .command("list")
  .description("List all deployments")
  .action(async () => {
    const { waitUntilExit } = render(<ListCommand />);
    await waitUntilExit();
  });

// Clone command
program
  .command("clone")
  .description("Clone an existing deployment configuration")
  .argument("<source>", "Source deployment name")
  .argument("<target>", "New deployment name")
  .action(async (source, target) => {
    const { waitUntilExit } = render(
      <CloneCommand source={source} target={target} />,
    );
    await waitUntilExit();
  });

// Open command
program
  .command("open")
  .description("Open deployment files in your editor")
  .argument("<name>", "Deployment name")
  .option("--config", "Open config.yaml only")
  .option("--values", "Open values.yaml only")
  .action(async (name, options) => {
    // Validate deployment exists before rendering
    const exists = await deploymentExists(name);
    if (!exists) {
      console.error(chalk.red(`Deployment "${name}" not found.`));
      const deployments = await listDeployments();
      if (deployments.length > 0) {
        console.log("\nAvailable deployments:");
        for (const d of deployments) {
          console.log(`  ${chalk.yellow("•")} ${d}`);
        }
      }
      process.exit(1);
    }

    const target = options.config
      ? "config"
      : options.values
        ? "values"
        : "all";

    const { waitUntilExit } = render(
      <OpenCommand name={name} target={target} />,
    );
    await waitUntilExit();
  });

// Benchmark command
program
  .command("benchmark")
  .description("Run load tests against a Rulebricks deployment")
  .argument("[name]", "Deployment name (optional)")
  .action(async (name) => {
    const { waitUntilExit } = render(<BenchmarkCommand name={name} />);
    await waitUntilExit();
  });

// Backup command
program
  .command("backup")
  .description("Run an on-demand database backup")
  .argument("[name]", "Deployment name")
  .action(async (name) => {
    const deploymentName = name || (await selectDeployment("back up"));
    if (!deploymentName) {
      console.error(
        chalk.red('No deployments found. Run "rulebricks init" first.'),
      );
      process.exit(1);
    }

    const { waitUntilExit } = render(<BackupCommand name={deploymentName} />);
    await waitUntilExit();
  });

// Restore command
program
  .command("restore")
  .description("Restore the database from a backup")
  .argument("[name]", "Deployment name")
  .action(async (name) => {
    const deploymentName = name || (await selectDeployment("restore"));
    if (!deploymentName) {
      console.error(
        chalk.red('No deployments found. Run "rulebricks init" first.'),
      );
      process.exit(1);
    }

    const { waitUntilExit } = render(<RestoreCommand name={deploymentName} />);
    await waitUntilExit();
  });

/**
 * Resolves a deployment name when none was given on the command line.
 * - 0 deployments: returns null (callers print the "run init first" error)
 * - 1 deployment: auto-selects it
 * - multiple: renders an interactive picker; Esc exits cleanly
 */
async function selectDeployment(action: string): Promise<string | null> {
  const deployments = await listDeployments();

  if (deployments.length === 0) {
    return null;
  }

  if (deployments.length === 1) {
    return deployments[0];
  }

  const selection = await new Promise<string | null>((resolve) => {
    const { unmount, clear } = render(
      <DeploymentPicker
        deployments={deployments}
        action={action}
        onSelect={(name) => {
          clear();
          unmount();
          resolve(name);
        }}
        onCancel={() => {
          clear();
          unmount();
          resolve(null);
        }}
      />,
    );
  });

  if (selection === null) {
    // User cancelled the picker; not an error.
    console.log(chalk.gray("Cancelled."));
    process.exit(0);
  }

  return selection;
}

program.parse();
