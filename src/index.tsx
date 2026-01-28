#!/usr/bin/env node
import { Command } from "commander";
import { render } from "ink";
import React from "react";
import chalk from "chalk";

import { InitWizard } from "./commands/init.js";
import { DeployCommand } from "./commands/deploy.js";
import { UpgradeCommand } from "./commands/upgrade.js";
import { DestroyCommand } from "./commands/destroy.js";
import { StatusCommand } from "./commands/status.js";
import { LogsCommand } from "./commands/logs.js";
import { CloneCommand } from "./commands/clone.js";
import { OpenCommand } from "./commands/open.js";
import { BenchmarkCommand } from "./commands/benchmark.js";
import { listDeployments, deploymentExists } from "./lib/config.js";
import { THEMES } from "./lib/theme.js";

const VERSION = "2.0.0";

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
  .option("--skip-infra", "Skip infrastructure provisioning")
  .option("--version <version>", "Specific chart version to deploy")
  .action(async (name, options) => {
    const deploymentName = name || (await selectDeployment());
    if (!deploymentName) {
      console.error(
        chalk.red('No deployment specified. Run "rulebricks init" first.'),
      );
      process.exit(1);
    }

    const { waitUntilExit } = render(
      <DeployCommand
        name={deploymentName}
        skipInfra={options.skipInfra}
        version={options.version}
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
    let deploymentName = name;
    if (!deploymentName) {
      const deployments = await listDeployments();
      if (deployments.length === 0) {
        console.error(
          chalk.red('No deployments found. Run "rulebricks init" first.'),
        );
        process.exit(1);
      } else if (deployments.length > 1) {
        console.error(chalk.red("Please specify a deployment to upgrade.\n"));
        console.log("Available deployments:");
        for (const d of deployments) {
          console.log(`  ${chalk.yellow("•")} ${d}`);
        }
        console.log(`\nUsage: ${chalk.cyan("rulebricks upgrade <name>")}`);
        process.exit(1);
      }
      deploymentName = deployments[0]; // Only one deployment, auto-select
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
  .option(
    "--cluster",
    "Also destroy cloud infrastructure (EKS/GKE/AKS cluster)",
  )
  .option("--config", "Also delete local configuration files")
  .option("-f, --force", "Skip confirmation")
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
        cluster={options.cluster}
        config={options.config}
        force={options.force}
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
    const deploymentName = name || (await selectDeployment());
    if (!deploymentName) {
      console.error(chalk.red("No deployment specified."));
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
    let deploymentName = name;
    if (!deploymentName) {
      const deployments = await listDeployments();
      if (deployments.length === 0) {
        console.error(
          chalk.red('No deployments found. Run "rulebricks init" first.'),
        );
        process.exit(1);
      } else if (deployments.length > 1) {
        console.error(
          chalk.red("Please specify a deployment to view logs for.\n"),
        );
        console.log("Available deployments:");
        for (const d of deployments) {
          console.log(`  ${chalk.yellow("•")} ${d}`);
        }
        console.log(
          `\nUsage: ${chalk.cyan("rulebricks logs <name> [component]")}`,
        );
        process.exit(1);
      }
      deploymentName = deployments[0]; // Only one deployment, auto-select
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
    const deployments = await listDeployments();
    const listColor = chalk.green; // Use status theme color (green)

    if (deployments.length === 0) {
      console.log(
        chalk.yellow(
          'No deployments found. Run "rulebricks init" to create one.',
        ),
      );
      return;
    }

    console.log(chalk.bold("\nDeployments:\n"));
    for (const name of deployments) {
      console.log(`  ${listColor("•")} ${name}`);
    }
    console.log("");
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
  .option("--terraform", "Open terraform directory only")
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
        : options.terraform
          ? "terraform"
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

// Helper to select a deployment interactively
async function selectDeployment(): Promise<string | null> {
  const deployments = await listDeployments();

  if (deployments.length === 0) {
    return null;
  }

  if (deployments.length === 1) {
    return deployments[0];
  }

  // For now, return the first one. In a full implementation,
  // we'd render an interactive selector
  return deployments[0];
}

program.parse();
