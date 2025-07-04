package main

import (
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"

	"github.com/fatih/color"
	"github.com/spf13/cobra"
	"gopkg.in/yaml.v3"
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
			chartVersion = config.Project.Version
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

		// Confirm destruction (skip if force flag is set)
		if !nonInteractive && !force && !confirmDestruction(destroyCluster) {
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

		// Load deployment state if available
		var state *DeploymentState
		statePath := ".rulebricks-state.yaml"
		if _, err := os.Stat(statePath); err == nil {
			data, err := os.ReadFile(statePath)
			if err == nil {
				state = &DeploymentState{}
				yaml.Unmarshal(data, state)
			}
		}

		checker := NewStatusChecker(config, state)
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
Available components: app, hps, workers, redis, database, supabase, traefik, prometheus, grafana, all`,
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

// vectorCmd handles Vector logging configuration
var vectorCmd = &cobra.Command{
	Use:   "vector",
	Short: "Manage Vector logging configuration",
	Long:  `Configure IAM permissions and settings for Vector logging sinks.`,
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

	// Add vector subcommands
	vectorCmd.AddCommand(createVectorSubcommands()...)

	// Add commands to root
	rootCmd.AddCommand(
		initCmd,
		deployCmd,
		destroyCmd,
		statusCmd,
		logsCmd,
		upgradeCmd,
		versionCmd,
		vectorCmd,
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
	fmt.Print("\033[H\033[2J") // ANSI escape code to clear the console
	// Print the welcome message with ASCII art
	color.New(color.Bold, color.FgRed).Printf(`


               ⟋ ‾‾‾‾⟋|
              ██████  |
              ██████  |
              ██████ ⟋ ‾‾‾‾⟋|
            ⟋     ⟋ ██████  |
           ██████   ██████  |
           ██████   ██████⟋
           ██████⟋

         [Uninstall Rulebricks]


`);
	if destroyCluster {
		color.Red("\n⚠️  WARNING: This will destroy your entire cluster and all data!")
		color.Yellow("\nThis action is irreversible and will delete:")
		fmt.Println("  • All deployed applications")
		fmt.Println("  • All databases and stored data")
		fmt.Println("  • The Kubernetes cluster")
		fmt.Println("  • All cloud infrastructure")
		fmt.Printf("\nType 'destroy-all' to confirm: ")
	} else {
		color.Yellow("\n⚠️  This will remove the Rulebricks deployment")
		fmt.Println("\nThe following components will be deleted:")
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

func createVectorSubcommands() []*cobra.Command {
	// Setup S3 permissions
	setupS3Cmd := &cobra.Command{
		Use:   "setup-s3",
		Short: "Configure AWS IAM permissions for S3 logging",
		Long:  `Set up IAM roles and service accounts for Vector to write logs to S3.`,
		RunE: func(cmd *cobra.Command, args []string) error {
			config, err := LoadConfig(cfgFile)
			if err != nil {
				return fmt.Errorf("failed to load configuration: %w", err)
			}

			// Validate logging configuration
			if !config.Logging.Enabled {
				return fmt.Errorf("logging is not enabled in configuration")
			}
			if config.Logging.Vector == nil || config.Logging.Vector.Sink == nil {
				return fmt.Errorf("Vector sink is not configured")
			}
			if config.Logging.Vector.Sink.Type != "aws_s3" {
				return fmt.Errorf("Vector sink type is not aws_s3")
			}

			bucket, _ := cmd.Flags().GetString("bucket")
			if bucket == "" {
				if bucketValue, ok := config.Logging.Vector.Sink.Config["bucket"].(string); ok {
					bucket = bucketValue
				} else {
					return fmt.Errorf("bucket not specified and not found in configuration")
				}
			}

			region, _ := cmd.Flags().GetString("region")
			if region == "" {
				if regionValue, ok := config.Logging.Vector.Sink.Config["region"].(string); ok {
					region = regionValue
				} else {
					region = config.Cloud.Region
				}
			}

			clusterName, _ := cmd.Flags().GetString("cluster")
			if clusterName == "" {
				// Always use actual cluster name for vector commands since they operate on existing deployments
				var err error
				clusterName, err = getClusterNameWithFallback()
				if err != nil {
					return fmt.Errorf("failed to determine cluster name: %w", err)
				}
			}

			namespace := config.GetNamespace("logging")
			setup := NewVectorIAMSetup(config, namespace, clusterName, verbose, nonInteractive)
			return setup.SetupS3(bucket, region)
		},
	}
	setupS3Cmd.Flags().String("bucket", "", "S3 bucket name")
	setupS3Cmd.Flags().String("region", "", "AWS region")
	setupS3Cmd.Flags().String("cluster", "", "EKS cluster name")

	// Setup GCS permissions
	setupGCSCmd := &cobra.Command{
		Use:   "setup-gcs",
		Short: "Configure GCP IAM permissions for Cloud Storage logging",
		Long:  `Set up Workload Identity and service accounts for Vector to write logs to GCS.`,
		RunE: func(cmd *cobra.Command, args []string) error {
			config, err := LoadConfig(cfgFile)
			if err != nil {
				return fmt.Errorf("failed to load configuration: %w", err)
			}

			// Validate configuration
			if !config.Logging.Enabled {
				return fmt.Errorf("logging is not enabled in configuration")
			}
			if config.Logging.Vector == nil || config.Logging.Vector.Sink == nil {
				return fmt.Errorf("Vector sink is not configured")
			}
			if config.Logging.Vector.Sink.Type != "gcp_cloud_storage" {
				return fmt.Errorf("Vector sink type is not gcp_cloud_storage")
			}

			bucket, _ := cmd.Flags().GetString("bucket")
			if bucket == "" {
				if bucketValue, ok := config.Logging.Vector.Sink.Config["bucket"].(string); ok {
					bucket = bucketValue
				} else {
					return fmt.Errorf("bucket not specified and not found in configuration")
				}
			}

			projectID, _ := cmd.Flags().GetString("project")
			if projectID == "" {
				if config.Cloud.Provider == "gcp" && config.Cloud.GCP != nil {
					projectID = config.Cloud.GCP.ProjectID
				} else {
					return fmt.Errorf("project ID not specified and not found in configuration")
				}
			}

			clusterName, _ := cmd.Flags().GetString("cluster")
			if clusterName == "" {
				// Always use actual cluster name for vector commands since they operate on existing deployments
				var err error
				clusterName, err = getClusterNameWithFallback()
				if err != nil {
					return fmt.Errorf("failed to determine cluster name: %w", err)
				}
			}

			namespace := config.GetNamespace("logging")
			setup := NewVectorIAMSetup(config, namespace, clusterName, verbose, nonInteractive)
			return setup.SetupGCS(bucket, projectID)
		},
	}
	setupGCSCmd.Flags().String("bucket", "", "GCS bucket name")
	setupGCSCmd.Flags().String("project", "", "GCP project ID")
	setupGCSCmd.Flags().String("cluster", "", "GKE cluster name")

	// Setup Azure permissions
	setupAzureCmd := &cobra.Command{
		Use:   "setup-azure",
		Short: "Configure Azure IAM permissions for Blob Storage logging",
		Long:  `Set up Managed Identity and pod identity for Vector to write logs to Azure Blob Storage.`,
		RunE: func(cmd *cobra.Command, args []string) error {
			config, err := LoadConfig(cfgFile)
			if err != nil {
				return fmt.Errorf("failed to load configuration: %w", err)
			}

			// Validate configuration
			if !config.Logging.Enabled {
				return fmt.Errorf("logging is not enabled in configuration")
			}
			if config.Logging.Vector == nil || config.Logging.Vector.Sink == nil {
				return fmt.Errorf("Vector sink is not configured")
			}
			if config.Logging.Vector.Sink.Type != "azure_blob" {
				return fmt.Errorf("Vector sink type is not azure_blob")
			}

			storageAccount, _ := cmd.Flags().GetString("storage-account")
			container, _ := cmd.Flags().GetString("container")
			if container == "" {
				if containerValue, ok := config.Logging.Vector.Sink.Config["container_name"].(string); ok {
					container = containerValue
				} else {
					return fmt.Errorf("container not specified and not found in configuration")
				}
			}

			resourceGroup, _ := cmd.Flags().GetString("resource-group")
			if resourceGroup == "" {
				if config.Cloud.Provider == "azure" && config.Cloud.Azure != nil {
					resourceGroup = config.Cloud.Azure.ResourceGroup
				} else {
					return fmt.Errorf("resource group not specified and not found in configuration")
				}
			}

			clusterName, _ := cmd.Flags().GetString("cluster")
			if clusterName == "" {
				// Always use actual cluster name for vector commands since they operate on existing deployments
				var err error
				clusterName, err = getClusterNameWithFallback()
				if err != nil {
					return fmt.Errorf("failed to determine cluster name: %w", err)
				}
			}

			namespace := config.GetNamespace("logging")
			setup := NewVectorIAMSetup(config, namespace, clusterName, verbose, nonInteractive)
			return setup.SetupAzure(storageAccount, container, resourceGroup)
		},
	}
	setupAzureCmd.Flags().String("storage-account", "", "Azure storage account name")
	setupAzureCmd.Flags().String("container", "", "Blob container name")
	setupAzureCmd.Flags().String("resource-group", "", "Azure resource group")
	setupAzureCmd.Flags().String("cluster", "", "AKS cluster name")

	// Generate IAM configuration
	generateIAMCmd := &cobra.Command{
		Use:   "generate-iam-config",
		Short: "Generate IAM configuration for manual setup",
		Long:  `Generate IAM policies and commands for manually configuring Vector sink permissions.`,
		RunE: func(cmd *cobra.Command, args []string) error {
			config, err := LoadConfig(cfgFile)
			if err != nil {
				return fmt.Errorf("failed to load configuration: %w", err)
			}

			sinkType, _ := cmd.Flags().GetString("sink")
			if sinkType == "" && config.Logging.Enabled && config.Logging.Vector != nil && config.Logging.Vector.Sink != nil {
				sinkType = config.Logging.Vector.Sink.Type
			}
			if sinkType == "" {
				return fmt.Errorf("sink type not specified")
			}

			bucket, _ := cmd.Flags().GetString("bucket")
			if bucket == "" && config.Logging.Enabled && config.Logging.Vector != nil && config.Logging.Vector.Sink != nil {
				if bucketValue, ok := config.Logging.Vector.Sink.Config["bucket"].(string); ok {
					bucket = bucketValue
				} else if containerValue, ok := config.Logging.Vector.Sink.Config["container_name"].(string); ok {
					bucket = containerValue
				}
			}

			// Always use actual cluster name for vector commands since they operate on existing deployments
			clusterName, err := getClusterNameWithFallback()
			if err != nil {
				return fmt.Errorf("failed to determine cluster name: %w", err)
			}

			namespace := config.GetNamespace("logging")
			setup := NewVectorIAMSetup(config, namespace, clusterName, verbose, nonInteractive)
			return setup.GenerateIAMConfig(sinkType, bucket)
		},
	}
	generateIAMCmd.Flags().String("sink", "", "Sink type (aws_s3, gcp_cloud_storage, azure_blob)")
	generateIAMCmd.Flags().String("bucket", "", "Bucket/container name")

	return []*cobra.Command{setupS3Cmd, setupGCSCmd, setupAzureCmd, generateIAMCmd}
}

// NewVectorIAMSetup creates a new Vector IAM setup instance
func NewVectorIAMSetup(config interface{}, namespace, clusterName string, verbose, nonInteractive bool) *IAMSetup {
	return NewIAMSetup(config, namespace, clusterName, verbose, nonInteractive)
}

// getClusterNameWithFallback attempts to get the cluster name from multiple sources
func getClusterNameWithFallback() (string, error) {
	if verbose {
		fmt.Println("🔍 Detecting cluster name from available sources...")
	}

	// First try to get from kubectl context (most reliable for deployed clusters)
	cmd := exec.Command("kubectl", "config", "current-context")
	output, err := cmd.Output()
	if err == nil {
		context := strings.TrimSpace(string(output))
		if verbose {
			fmt.Printf("  Current kubectl context: %s\n", context)
		}
		// Extract cluster name from ARN if it's an EKS ARN
		if strings.Contains(context, "arn:aws:eks") {
			parts := strings.Split(context, "/")
			if len(parts) >= 2 {
				clusterName := parts[1]
				if verbose {
					fmt.Printf("  ✓ Extracted cluster name from EKS ARN: %s\n", clusterName)
				}
				return clusterName, nil
			}
		}
		// For Azure AKS context format
		if strings.Contains(context, "aks-") {
			// AKS contexts are typically just the cluster name
			return context, nil
		}
		// For GKE context format (typically gke_PROJECT_ZONE_CLUSTER)
		if strings.HasPrefix(context, "gke_") {
			parts := strings.Split(context, "_")
			if len(parts) >= 4 {
				return parts[3], nil
			}
		}
	}

	// Fallback to deployment state
	statePath := ".rulebricks-state.yaml"
	if verbose {
		fmt.Printf("  Checking deployment state file: %s\n", statePath)
	}
	if data, err := os.ReadFile(statePath); err == nil {
		var state DeploymentState
		if err := yaml.Unmarshal(data, &state); err == nil && state.Infrastructure.ClusterName != "" {
			if verbose {
				fmt.Printf("  ⚠️  Found cluster name in state file: %s (may be outdated)\n", state.Infrastructure.ClusterName)
			}
			return state.Infrastructure.ClusterName, nil
		}
	} else if verbose {
		fmt.Printf("  State file not found or not readable: %v\n", err)
	}

	// Try eksctl as another fallback for EKS clusters
	if verbose {
		fmt.Println("  Trying eksctl to list clusters...")
	}
	cmd = exec.Command("eksctl", "get", "cluster", "--output", "json")
	output, err = cmd.Output()
	if err == nil {
		var clusters []map[string]interface{}
		if err := json.Unmarshal(output, &clusters); err == nil && len(clusters) > 0 {
			// Return the first cluster name (should ideally filter by region/config)
			if name, ok := clusters[0]["Name"].(string); ok {
				if verbose {
					fmt.Printf("  ✓ Found cluster via eksctl: %s\n", name)
				}
				return name, nil
			}
		}
	} else if verbose {
		fmt.Printf("  eksctl command failed: %v\n", err)
	}

	// Try to load config as final fallback
	if verbose {
		fmt.Println("  Trying to load cluster name from config...")
	}

	if cfgFile != "" {
		config, err := LoadConfig(cfgFile)
		if err == nil && config.Kubernetes.ClusterName != "" {
			if verbose {
				fmt.Printf("  ✓ Found cluster name in config: %s\n", config.Kubernetes.ClusterName)
			}
			return config.Kubernetes.ClusterName, nil
		}
	}

	// Use default cluster name as last resort
	defaultClusterName := "rulebricks-cluster"
	if verbose {
		fmt.Printf("  ℹ️  Using default cluster name: %s\n", defaultClusterName)
	}
	return defaultClusterName, nil
}
