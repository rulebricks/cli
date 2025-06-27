package main

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"github.com/fatih/color"
	"github.com/spf13/cobra"
)

var (
	// Version information
	version   = "dev"
	gitCommit = "unknown"
	buildDate = "unknown"

	// Global flags
	cfgFile        string
	nonInteractive bool
	verbose        bool
)

// rootCmd represents the base command
var rootCmd = &cobra.Command{
	Use:   "rulebricks",
	Short: "Rulebricks deployment and management CLI",
	Long: `Rulebricks CLI manages the deployment and lifecycle of Rulebricks applications
on Kubernetes clusters across multiple cloud providers.`,
	SilenceUsage:  true,
	SilenceErrors: true,
}

// initCmd handles project initialization
var initCmd = &cobra.Command{
	Use:   "init",
	Short: "Initialize a new Rulebricks project",
	Long:  `Initialize a new Rulebricks project by creating a configuration file with guided setup.`,
	RunE: func(cmd *cobra.Command, args []string) error {
		wizard := NewInitWizard(nonInteractive)
		return wizard.Run()
	},
}

// deployCmd handles deployment
var deployCmd = &cobra.Command{
	Use:   "deploy",
	Short: "Deploy Rulebricks to your cluster",
	Long:  `Deploy Rulebricks application and all required components to your Kubernetes cluster.`,
	RunE: func(cmd *cobra.Command, args []string) error {
		config, err := LoadConfig(cfgFile)
		if err != nil {
			return fmt.Errorf("failed to load configuration: %w", err)
		}

		// Validate configuration
		if err := config.Validate(); err != nil {
			return fmt.Errorf("configuration validation failed: %w", err)
		}

		// Get chart version
		chartVersion, _ := cmd.Flags().GetString("chart-version")
		if chartVersion == "" {
			chartVersion = "latest"
		}

		// Create and execute deployment
		deployer, err := NewDeployer(config, DeployerOptions{
			ChartVersion: chartVersion,
			Verbose:      verbose,
			DryRun:       false,
		})
		if err != nil {
			return fmt.Errorf("failed to initialize deployer: %w", err)
		}

		return deployer.Execute()
	},
}

// destroyCmd handles destruction
var destroyCmd = &cobra.Command{
	Use:   "destroy",
	Short: "Destroy Rulebricks deployment",
	Long:  `Remove Rulebricks and optionally destroy the underlying infrastructure.`,
	RunE: func(cmd *cobra.Command, args []string) error {
		config, err := LoadConfig(cfgFile)
		if err != nil {
			return fmt.Errorf("failed to load configuration: %w", err)
		}

		destroyCluster, _ := cmd.Flags().GetBool("cluster")
		force, _ := cmd.Flags().GetBool("force")

		// Confirm destruction
		if !nonInteractive && !confirmDestruction(destroyCluster) {
			color.Yellow("Destruction cancelled")
			return nil
		}

		destroyer := NewDestroyer(config, DestroyerOptions{
			DestroyCluster: destroyCluster,
			Force:          force,
			Verbose:        verbose,
		})

		return destroyer.Execute()
	},
}

// statusCmd shows deployment status
var statusCmd = &cobra.Command{
	Use:   "status",
	Short: "Show deployment status",
	Long:  `Display the current status of your Rulebricks deployment including all components.`,
	RunE: func(cmd *cobra.Command, args []string) error {
		config, err := LoadConfig(cfgFile)
		if err != nil {
			return fmt.Errorf("failed to load configuration: %w", err)
		}

		checker := NewStatusChecker(config)
		status, err := checker.CheckAll()
		if err != nil {
			return fmt.Errorf("failed to check status: %w", err)
		}

		status.Display()
		return nil
	},
}

// logsCmd handles log viewing
var logsCmd = &cobra.Command{
	Use:   "logs [component]",
	Short: "View component logs",
	Long: `View logs from Rulebricks components.
Available components: app, database, supabase, traefik, kong, auth, realtime, storage, prometheus, grafana, all`,
	Args: cobra.MaximumNArgs(1),
	RunE: func(cmd *cobra.Command, args []string) error {
		config, err := LoadConfig(cfgFile)
		if err != nil {
			return fmt.Errorf("failed to load configuration: %w", err)
		}

		component := "app"
		if len(args) > 0 {
			component = args[0]
		}

		follow, _ := cmd.Flags().GetBool("follow")
		tail, _ := cmd.Flags().GetInt("tail")

		viewer := NewLogViewer(config)
		return viewer.ViewLogs(component, follow, tail)
	},
}

// upgradeCmd handles version upgrades
var upgradeCmd = &cobra.Command{
	Use:   "upgrade",
	Short: "Upgrade Rulebricks to a new version",
	Long:  `Upgrade your Rulebricks deployment to a newer version.`,
}

// versionCmd shows version information
var versionCmd = &cobra.Command{
	Use:   "version",
	Short: "Show version information",
	RunE: func(cmd *cobra.Command, args []string) error {
		fmt.Printf("Rulebricks CLI\n")
		fmt.Printf("  Version:    %s\n", version)
		fmt.Printf("  Git Commit: %s\n", gitCommit)
		fmt.Printf("  Build Date: %s\n", buildDate)
		fmt.Printf("  Go Version: %s\n", getGoVersion())
		fmt.Printf("  Platform:   %s\n", getPlatform())
		return nil
	},
}

func init() {
	// Global flags
	rootCmd.PersistentFlags().StringVarP(&cfgFile, "config", "c", "", "config file (default: rulebricks.yaml)")
	rootCmd.PersistentFlags().BoolVarP(&nonInteractive, "non-interactive", "n", false, "run in non-interactive mode")
	rootCmd.PersistentFlags().BoolVarP(&verbose, "verbose", "v", false, "enable verbose output")

	// Deploy flags
	deployCmd.Flags().String("chart-version", "", "specific chart version to deploy")

	// Destroy flags
	destroyCmd.Flags().Bool("cluster", false, "destroy the entire cluster infrastructure")
	destroyCmd.Flags().Bool("force", false, "force destruction without confirmation")

	// Logs flags
	logsCmd.Flags().BoolP("follow", "f", false, "follow log output")
	logsCmd.Flags().IntP("tail", "t", 100, "number of lines to show from the end of logs")

	// Add upgrade subcommands
	upgradeCmd.AddCommand(createUpgradeSubcommands()...)

	// Add commands to root
	rootCmd.AddCommand(
		initCmd,
		deployCmd,
		destroyCmd,
		statusCmd,
		logsCmd,
		upgradeCmd,
		versionCmd,
	)
}

func main() {
	if err := rootCmd.Execute(); err != nil {
		color.Red("Error: %v", err)
		os.Exit(1)
	}
}



// LoadConfig loads configuration from file
func LoadConfig(path string) (*Config, error) {
	if path == "" {
		path = "rulebricks.yaml"
	}

	// Check if file exists
	if _, err := os.Stat(path); err != nil {
		if os.IsNotExist(err) {
			return nil, fmt.Errorf("configuration file not found: %s\nRun 'rulebricks init' to create one", path)
		}
		return nil, err
	}

	data, err := os.ReadFile(path)
	if err != nil {
		return nil, fmt.Errorf("failed to read config file: %w", err)
	}

	config := &Config{}
	if err := config.UnmarshalYAML(data); err != nil {
		return nil, fmt.Errorf("failed to parse config: %w", err)
	}

	// Apply defaults
	config.ApplyDefaults()

	return config, nil
}

// SaveConfig saves configuration to file
func SaveConfig(config *Config, path string) error {
	if path == "" {
		path = "rulebricks.yaml"
	}

	data, err := config.MarshalYAML()
	if err != nil {
		return fmt.Errorf("failed to marshal config: %w", err)
	}

	// Create directory if needed
	dir := filepath.Dir(path)
	if err := os.MkdirAll(dir, 0755); err != nil {
		return fmt.Errorf("failed to create directory: %w", err)
	}

	// Write with proper permissions
	if err := os.WriteFile(path, data, 0644); err != nil {
		return fmt.Errorf("failed to write config: %w", err)
	}

	return nil
}

func confirmDestruction(destroyCluster bool) bool {
	if destroyCluster {
		color.Red("\n⚠️  WARNING: This will destroy your entire cluster and all data!")
		color.Yellow("This action is irreversible and will delete:")
		fmt.Println("  • All deployed applications")
		fmt.Println("  • All databases and stored data")
		fmt.Println("  • The Kubernetes cluster")
		fmt.Println("  • All cloud infrastructure")
		fmt.Printf("\nType 'destroy-all' to confirm: ")
	} else {
		color.Yellow("\n⚠️  This will remove the Rulebricks deployment")
		fmt.Println("The following will be deleted:")
		fmt.Println("  • Rulebricks application")
		fmt.Println("  • Databases (if self-hosted)")
		fmt.Println("  • Monitoring stack")
		fmt.Println("  • Ingress configuration")
		fmt.Printf("\nContinue? (y/N): ")
	}

	var response string
	fmt.Scanln(&response)

	if destroyCluster {
		return response == "destroy-all"
	}
	return strings.ToLower(response) == "y" || strings.ToLower(response) == "yes"
}

func createUpgradeSubcommands() []*cobra.Command {
	// List available versions
	listCmd := &cobra.Command{
		Use:   "list",
		Short: "List available versions",
		RunE: func(cmd *cobra.Command, args []string) error {
			config, err := LoadConfig(cfgFile)
			if err != nil {
				return err
			}

			manager := NewUpgradeManager(config, verbose)
			return manager.ListVersions()
		},
	}

	// Check current version
	statusCmd := &cobra.Command{
		Use:   "status",
		Short: "Show current version and available updates",
		RunE: func(cmd *cobra.Command, args []string) error {
			config, err := LoadConfig(cfgFile)
			if err != nil {
				return err
			}

			manager := NewUpgradeManager(config, verbose)
			return manager.CheckStatus()
		},
	}

	// Perform upgrade
	runCmd := &cobra.Command{
		Use:   "run [version]",
		Short: "Upgrade to a specific version (or latest)",
		Args:  cobra.MaximumNArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			config, err := LoadConfig(cfgFile)
			if err != nil {
				return err
			}

			version := "latest"
			if len(args) > 0 {
				version = args[0]
			}

			dryRun, _ := cmd.Flags().GetBool("dry-run")

			manager := NewUpgradeManager(config, verbose)
			return manager.Upgrade(version, dryRun)
		},
	}

	runCmd.Flags().Bool("dry-run", false, "show what would be upgraded without making changes")

	return []*cobra.Command{listCmd, statusCmd, runCmd}
}

func getGoVersion() string {
	// This would be set at build time
	return "go1.21"
}

func getPlatform() string {
	// This would detect the actual platform
	return "darwin/arm64"
}
