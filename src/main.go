// main.go - Rulebricks CLI
package main

import (
	"fmt"
	"io/ioutil"
	"log"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"github.com/spf13/cobra"
	"gopkg.in/yaml.v3"
)

var (
	// Version information
	version   = "1.0.0"
	gitCommit = "dev"
	buildDate = "unknown"
)

// Config represents the complete deployment configuration
type Config struct {
	Version string `yaml:"version"`
	Project struct {
		Name      string `yaml:"name"`
		Domain    string `yaml:"domain"`
		Email     string `yaml:"email"`
		License   string `yaml:"license"`
		Version   string `yaml:"version,omitempty"`
		Namespace string `yaml:"namespace,omitempty"`
	} `yaml:"project"`

	Cloud struct {
		Provider string `yaml:"provider"` // aws, azure, gcp
		Region   string `yaml:"region"`

		// Cloud-specific settings
		AWS struct {
			AccountID      string `yaml:"account_id,omitempty"`
			VPCCidr       string `yaml:"vpc_cidr,omitempty"`
			InstanceType  string `yaml:"instance_type,omitempty"`
		} `yaml:"aws,omitempty"`

		Azure struct {
			SubscriptionID  string `yaml:"subscription_id,omitempty"`
			ResourceGroup   string `yaml:"resource_group,omitempty"`
			VMSize         string `yaml:"vm_size,omitempty"`
		} `yaml:"azure,omitempty"`

		GCP struct {
			ProjectID     string `yaml:"project_id,omitempty"`
			Zone         string `yaml:"zone,omitempty"`
			MachineType  string `yaml:"machine_type,omitempty"`
		} `yaml:"gcp,omitempty"`
	} `yaml:"cloud"`

	Kubernetes struct {
		ClusterName     string `yaml:"cluster_name"`
		NodeCount       int    `yaml:"node_count"`
		MinNodes        int    `yaml:"min_nodes"`
		MaxNodes        int    `yaml:"max_nodes"`
		EnableAutoscale bool   `yaml:"enable_autoscale"`
	} `yaml:"kubernetes"`

	Database struct {
		Type     string `yaml:"type"` // managed, self-hosted, external
		Provider string `yaml:"provider,omitempty"` // supabase, postgres

		// Managed Supabase settings
		Supabase struct {
			ProjectName string `yaml:"project_name,omitempty"`
			Region      string `yaml:"region,omitempty"`
			OrgID       string `yaml:"org_id,omitempty"`
		} `yaml:"supabase,omitempty"`

		// External database settings
		External struct {
			Host         string `yaml:"host,omitempty"`
			Port         int    `yaml:"port,omitempty"`
			Database     string `yaml:"database,omitempty"`
			Username     string `yaml:"username,omitempty"`
			PasswordFrom string `yaml:"password_from,omitempty"` // env:VAR_NAME or file:/path
			SSLMode      string `yaml:"ssl_mode,omitempty"`

			// Replication settings
			Replicas []struct {
				Host     string `yaml:"host"`
				Port     int    `yaml:"port"`
				Type     string `yaml:"type"` // read, standby
			} `yaml:"replicas,omitempty"`
		} `yaml:"external,omitempty"`

		// Connection pooling
		Pooling struct {
			Enabled     bool `yaml:"enabled"`
			MaxSize     int  `yaml:"max_size,omitempty"`
			MinSize     int  `yaml:"min_size,omitempty"`
		} `yaml:"pooling,omitempty"`
	} `yaml:"database"`

	Email struct {
		Provider string `yaml:"provider"` // resend, smtp, sendgrid, ses
		From     string `yaml:"from"`
		FromName string `yaml:"from_name"`

		// SMTP settings
		SMTP struct {
			Host         string `yaml:"host,omitempty"`
			Port         int    `yaml:"port,omitempty"`
			Username     string `yaml:"username,omitempty"`
			PasswordFrom string `yaml:"password_from,omitempty"`
			Encryption   string `yaml:"encryption,omitempty"` // tls, starttls, none
			AdminEmail   string `yaml:"admin_email,omitempty"`
		} `yaml:"smtp,omitempty"`

		// API-based providers
		APIKey string `yaml:"api_key_from,omitempty"` // env:VAR_NAME or file:/path

		// Template customization
		Templates struct {
			CustomInviteURL       string `yaml:"custom_invite_url,omitempty"`
			CustomConfirmationURL string `yaml:"custom_confirmation_url,omitempty"`
			CustomRecoveryURL     string `yaml:"custom_recovery_url,omitempty"`
			CustomEmailChangeURL  string `yaml:"custom_email_change_url,omitempty"`
		} `yaml:"templates,omitempty"`
	} `yaml:"email"`

	Security struct {
		TLS struct {
			Enabled       bool     `yaml:"enabled"`
			Provider      string   `yaml:"provider,omitempty"` // letsencrypt, custom
			CustomCert    string   `yaml:"custom_cert,omitempty"`
			CustomKey     string   `yaml:"custom_key,omitempty"`
			AcmeEmail     string   `yaml:"acme_email,omitempty"`
			Domains       []string `yaml:"domains,omitempty"`
		} `yaml:"tls"`

		Secrets struct {
			Provider    string `yaml:"provider,omitempty"` // kubernetes, vault, aws-secrets
			Encryption  bool   `yaml:"encryption"`
		} `yaml:"secrets,omitempty"`

		Network struct {
			AllowedIPs    []string `yaml:"allowed_ips,omitempty"`
			RateLimiting  bool     `yaml:"rate_limiting"`

		} `yaml:"network,omitempty"`
	} `yaml:"security"`

	Monitoring struct {
		Enabled   bool   `yaml:"enabled"`
		Provider  string `yaml:"provider,omitempty"` // prometheus only

		Metrics struct {
			Retention string `yaml:"retention,omitempty"`
			Interval  string `yaml:"interval,omitempty"`
		} `yaml:"metrics,omitempty"`

		Logs struct {
			Level     string `yaml:"level,omitempty"`
			Retention string `yaml:"retention,omitempty"`
		} `yaml:"logs,omitempty"`


	} `yaml:"monitoring,omitempty"`

	Advanced struct {
		Terraform struct {
			Backend      string            `yaml:"backend,omitempty"` // local, s3, gcs, azurerm
			BackendConfig map[string]string `yaml:"backend_config,omitempty"`
			Variables    map[string]string `yaml:"variables,omitempty"`
		} `yaml:"terraform,omitempty"`

		Backup struct {
			Enabled        bool                   `yaml:"enabled"`
			Schedule       string                 `yaml:"schedule,omitempty"`
			Retention      string                 `yaml:"retention,omitempty"`
			Provider       string                 `yaml:"provider,omitempty"`
			ProviderConfig map[string]interface{} `yaml:"provider_config,omitempty"`
		} `yaml:"backup,omitempty"`

		DockerRegistry struct {
			URL         string `yaml:"url,omitempty"`         // Custom registry URL (e.g., "myregistry.azurecr.io")
			AppImage    string `yaml:"app_image,omitempty"`    // Override app image (e.g., "myregistry.azurecr.io/rulebricks/app")
			HPSImage    string `yaml:"hps_image,omitempty"`    // Override hps image (e.g., "myregistry.azurecr.io/rulebricks/hps")
		} `yaml:"docker_registry,omitempty"`

		CustomValues map[string]interface{} `yaml:"custom_values,omitempty"`
	} `yaml:"advanced,omitempty"`

	AI struct {
		Enabled           bool   `yaml:"enabled"`
		OpenAIAPIKeyFrom  string `yaml:"openai_api_key_from,omitempty"` // env:VAR_NAME or file:/path
	} `yaml:"ai,omitempty"`

	Logging struct {
		Enabled               bool   `yaml:"enabled"`

		Vector struct {
			Sink struct {
				Type     string            `yaml:"type,omitempty"` // elasticsearch, datadog, loki, s3, etc.
				Endpoint string            `yaml:"endpoint,omitempty"`
				APIKey   string            `yaml:"api_key_from,omitempty"` // env:VAR_NAME or file:/path
				Config   map[string]string `yaml:"config,omitempty"` // Additional sink-specific config
			} `yaml:"sink,omitempty"`
		} `yaml:"vector,omitempty"`
	} `yaml:"logging,omitempty"`

	Performance struct {
		VolumeLevel              string `yaml:"volume_level,omitempty"` // low, medium, high
		HPSReplicas              int    `yaml:"hps_replicas,omitempty"`
		HPSMaxReplicas           int    `yaml:"hps_max_replicas,omitempty"`
		HPSWorkerReplicas        int    `yaml:"hps_worker_replicas,omitempty"`
		HPSWorkerMaxReplicas     int    `yaml:"hps_worker_max_replicas,omitempty"`
		KafkaPartitions          int    `yaml:"kafka_partitions,omitempty"`
		KafkaLagThreshold        int    `yaml:"kafka_lag_threshold,omitempty"`
		KafkaRetentionHours      int    `yaml:"kafka_retention_hours,omitempty"`      // Log retention in hours
		KafkaStorageSize         string `yaml:"kafka_storage_size,omitempty"`         // PVC size for Kafka storage
		KafkaReplicationFactor   int    `yaml:"kafka_replication_factor,omitempty"`   // Replication factor for HA
		ScaleUpStabilization     int    `yaml:"scale_up_stabilization,omitempty"`     // seconds
		ScaleDownStabilization   int    `yaml:"scale_down_stabilization,omitempty"`   // seconds
		KedaPollingInterval      int    `yaml:"keda_polling_interval,omitempty"`      // seconds

		HPSResources struct {
			Requests struct {
				CPU    string `yaml:"cpu,omitempty"`
				Memory string `yaml:"memory,omitempty"`
			} `yaml:"requests,omitempty"`
			Limits struct {
				CPU    string `yaml:"cpu,omitempty"`
				Memory string `yaml:"memory,omitempty"`
			} `yaml:"limits,omitempty"`
		} `yaml:"hps_resources,omitempty"`

		WorkerResources struct {
			Requests struct {
				CPU    string `yaml:"cpu,omitempty"`
				Memory string `yaml:"memory,omitempty"`
			} `yaml:"requests,omitempty"`
			Limits struct {
				CPU    string `yaml:"cpu,omitempty"`
				Memory string `yaml:"memory,omitempty"`
			} `yaml:"limits,omitempty"`
		} `yaml:"worker_resources,omitempty"`
	} `yaml:"performance,omitempty"`
}

var (
	cfgFile        string
	nonInteractive bool
	dryRun         bool
	verbose        bool
	verboseFlag    bool // Alias for verbose to maintain compatibility
	destroyCluster bool
)

var rootCmd = &cobra.Command{
	Use:   "rulebricks",
	Short: "Rulebricks deployment and management CLI",
	Long: `A CLI tool to deploy and manage Rulebricks instances across different cloud providers.

This tool simplifies the deployment process by using declarative configuration files
and provides both interactive and non-interactive modes for different use cases.`,
	CompletionOptions: cobra.CompletionOptions{
		DisableDefaultCmd: true,
	},
}

var initCmd = &cobra.Command{
	Use:   "init",
	Short: "Initialize a new Rulebricks deployment configuration",
	Long:  `Creates a new rulebricks.yaml configuration file with an interactive wizard`,
	Run: func(cmd *cobra.Command, args []string) {
		if fileExists("rulebricks.yaml") && !confirmOverwrite() {
			return
		}

		config := Config{Version: version}
		wizard := NewConfigWizard()

		if nonInteractive {
			// Generate minimal config
			config = generateMinimalConfig()
		} else {
			// Run interactive wizard
			config = wizard.Run()
		}

		if err := saveConfig(config, "rulebricks.yaml"); err != nil {
			log.Fatalf("Error saving config: %v", err)
		}

		fmt.Println("✅ Configuration saved to rulebricks.yaml")
		fmt.Println("\nNext steps:")
		fmt.Println("1. Review and edit rulebricks.yaml as needed")
		fmt.Println("2. Run 'rulebricks validate' to check your configuration")
		fmt.Println("3. Run 'rulebricks deploy' to start deployment")
	},
}

var validateCmd = &cobra.Command{
	Use:   "validate",
	Short: "Validate deployment configuration",
	Long:  `Validates the configuration file and checks prerequisites`,
	Run: func(cmd *cobra.Command, args []string) {
		config, err := loadConfig(cfgFile)
		if err != nil {
			log.Fatalf("Error loading config: %v", err)
		}

		validator := NewValidator(config)
		results := validator.ValidateAll()

		// Display validation results
		displayValidationResults(results)

		if !results.IsValid() {
			os.Exit(1)
		}

		fmt.Println("\n✅ Configuration is valid!")

		// Check prerequisites
		prereqChecker := NewPrerequisiteChecker(config)
		if err := prereqChecker.CheckAll(); err != nil {
			fmt.Printf("\n❌ Prerequisites check failed: %v\n", err)
			os.Exit(1)
		}

		fmt.Println("✅ All prerequisites met!")
	},
}

var (
	chartVersion string
)

var deployCmd = &cobra.Command{
	Use:   "deploy",
	Short: "Deploy Rulebricks to the configured cloud provider",
	Long:  `Deploys a complete Rulebricks instance based on the configuration file`,
	Run: func(cmd *cobra.Command, args []string) {
		config, err := loadConfig(cfgFile)
		if err != nil {
			log.Fatalf("Error loading config: %v", err)
		}

		// Validate first
		validator := NewValidator(config)
		if results := validator.ValidateAll(); !results.IsValid() {
			displayValidationResults(results)
			os.Exit(1)
		}

		// Create deployment plan
		planner := NewDeploymentPlanner(config)
		plan := planner.CreatePlan()

		// Display plan
		fmt.Println("\n📋 Deployment Plan:")
		plan.Display()

		if dryRun {
			fmt.Println("\n🔍 Dry run completed. No resources were created.")
			return
		}

		if !nonInteractive && !confirmDeployment() {
			fmt.Println("Deployment cancelled.")
			return
		}

		// Determine chart version to use
		deployVersion := chartVersion
		// If project.version is specified in config and user didn't explicitly set a version flag
		if config.Project.Version != "" && chartVersion == "latest" {
			deployVersion = config.Project.Version
			fmt.Printf("📌 Using chart version from config: %s\n", deployVersion)
		}

		// Execute deployment
		deployer, err := NewDeployer(config, plan, deployVersion, verbose)
		if err != nil {
			log.Fatalf("Failed to initialize deployer: %v", err)
		}

		if err := deployer.Execute(); err != nil {
			log.Fatalf("Deployment failed: %v", err)
		}

		fmt.Println("\n✅ Deployment completed successfully!")

		// Display connection information
		deployer.DisplayConnectionInfo()

		// Save deployment state
		if err := deployer.SaveState(); err != nil {
			log.Printf("Warning: Failed to save deployment state: %v", err)
		}
	},
}



var destroyCmd = &cobra.Command{
	Use:   "destroy",
	Short: "Destroy a Rulebricks deployment",
	Long:  `Removes the Rulebricks deployment. By default, this preserves the Kubernetes cluster infrastructure.

Use --cluster to also destroy the Kubernetes cluster and all infrastructure.`,
	Run: func(cmd *cobra.Command, args []string) {
		config, err := loadConfig(cfgFile)
		if err != nil {
			log.Fatalf("Error loading config: %v", err)
		}

		// Double confirmation for destroy
		if !nonInteractive {
			if destroyCluster {
				fmt.Println("⚠️  WARNING: This will destroy all resources and data, including the Kubernetes cluster!")
			} else {
				fmt.Println("⚠️  WARNING: This will destroy all applications and data (but preserve infrastructure)!")
			}
			fmt.Printf("Type the project name '%s' to confirm: ", config.Project.Name)

			var confirmation string
			fmt.Scanln(&confirmation)

			if confirmation != config.Project.Name {
				fmt.Println("Destroy cancelled.")
				return
			}
		}

		destroyer := NewDestroyer(config, destroyCluster)
		if err := destroyer.Execute(); err != nil {
			log.Fatalf("Destroy failed: %v", err)
		}

		if !destroyCluster {
			fmt.Println("\n✅ All applications and services removed successfully.")
			fmt.Println("ℹ️  Infrastructure (Kubernetes cluster) has been preserved.")
			fmt.Println("💡 Run 'rulebricks deploy' to redeploy applications to the existing cluster.")
		} else {
			fmt.Println("\n✅ All resources destroyed successfully.")
		}

		// Always clean up state file
		os.Remove(".rulebricks-state.yaml")
	},
}

var statusCmd = &cobra.Command{
	Use:   "status",
	Short: "Check the status of a Rulebricks deployment",
	Long:  `Shows the current status and health of all deployment components`,
	Run: func(cmd *cobra.Command, args []string) {
		config, err := loadConfig(cfgFile)
		if err != nil {
			log.Fatalf("Error loading config: %v", err)
		}

		checker := NewStatusChecker(config)
		status := checker.CheckAll()

		status.Display()
	},
}

var configCmd = &cobra.Command{
	Use:   "config",
	Short: "Manage deployment configuration",
	Long:  `View, edit, and validate deployment configuration`,
}

var configGetCmd = &cobra.Command{
	Use:   "get [key]",
	Short: "Get a configuration value",
	Args:  cobra.ExactArgs(1),
	Run: func(cmd *cobra.Command, args []string) {
		config, err := loadConfig(cfgFile)
		if err != nil {
			log.Fatalf("Error loading config: %v", err)
		}

		value, err := getConfigValue(config, args[0])
		if err != nil {
			log.Fatalf("Error: %v", err)
		}

		fmt.Println(value)
	},
}

var configSetCmd = &cobra.Command{
	Use:   "set [key] [value]",
	Short: "Set a configuration value",
	Args:  cobra.ExactArgs(2),
	Run: func(cmd *cobra.Command, args []string) {
		config, err := loadConfig(cfgFile)
		if err != nil {
			log.Fatalf("Error loading config: %v", err)
		}

		if err := setConfigValue(&config, args[0], args[1]); err != nil {
			log.Fatalf("Error: %v", err)
		}

		if err := saveConfig(config, cfgFile); err != nil {
			log.Fatalf("Error saving config: %v", err)
		}

		fmt.Printf("✅ Set %s = %s\n", args[0], args[1])
	},
}



var logsCmd = &cobra.Command{
	Use:   "logs [component]",
	Short: "View logs from deployment components",
	Long:  `Stream or view logs from various Rulebricks components`,
	Run: func(cmd *cobra.Command, args []string) {
		config, err := loadConfig(cfgFile)
		if err != nil {
			log.Fatalf("Error loading config: %v", err)
		}

		component := "all"
		if len(args) > 0 {
			component = args[0]
		}

		follow, _ := cmd.Flags().GetBool("follow")
		tail, _ := cmd.Flags().GetInt("tail")

		logViewer := NewLogViewer(config)
		if err := logViewer.ViewLogs(component, follow, tail); err != nil {
			log.Fatalf("Error viewing logs: %v", err)
		}
	},
}

var versionCmd = &cobra.Command{
	Use:   "version",
	Short: "Print the CLI version information",
	Long:  `Print the version information for the Rulebricks CLI`,
	Run: func(cmd *cobra.Command, args []string) {
		fmt.Printf("Rulebricks CLI\n")
		fmt.Printf("  Version:    %s\n", version)
		fmt.Printf("  Git commit: %s\n", gitCommit)
		fmt.Printf("  Built:      %s\n", buildDate)
		fmt.Printf("  Go version: %s\n", "go1.21")
		fmt.Printf("  OS/Arch:    %s/%s\n", runtime.GOOS, runtime.GOARCH)
	},
}

func init() {
	// Global flags
	rootCmd.PersistentFlags().StringVarP(&cfgFile, "config", "c", "rulebricks.yaml", "config file")
	rootCmd.PersistentFlags().BoolVarP(&nonInteractive, "yes", "y", false, "non-interactive mode")
	rootCmd.PersistentFlags().BoolVar(&dryRun, "dry-run", false, "simulate actions without making changes")
	rootCmd.PersistentFlags().BoolVarP(&verbose, "verbose", "v", false, "verbose output")
	verboseFlag = verbose // Set alias for compatibility

	// Add commands in logical order of usage
	rootCmd.AddCommand(initCmd)
	rootCmd.AddCommand(validateCmd)
	rootCmd.AddCommand(deployCmd)
	rootCmd.AddCommand(statusCmd)
	rootCmd.AddCommand(logsCmd)
	rootCmd.AddCommand(CreateUpgradeCommand())
	rootCmd.AddCommand(configCmd)
	rootCmd.AddCommand(destroyCmd)
	rootCmd.AddCommand(versionCmd)

	// Deploy command specific flags
	deployCmd.Flags().StringVar(&chartVersion, "chart-version", "latest", "Rulebricks chart version to deploy")

	// Destroy command specific flags
	destroyCmd.Flags().BoolVar(&destroyCluster, "cluster", false, "also destroy the Kubernetes cluster infrastructure")

	// Config subcommands
	configCmd.AddCommand(configGetCmd)
	configCmd.AddCommand(configSetCmd)

	// Logs flags
	logsCmd.Flags().BoolP("follow", "f", false, "follow log output")
	logsCmd.Flags().IntP("tail", "t", 100, "number of lines to show")
}

func main() {
	if err := rootCmd.Execute(); err != nil {
		fmt.Println(err)
		os.Exit(1)
	}
}

// Helper functions

func loadConfig(filename string) (Config, error) {
	var config Config

	// Clean the filename - remove surrounding quotes if present
	filename = strings.Trim(filename, `"'`)

	if verbose {
		fmt.Printf("🔍 Loading config from: %s\n", filename)
	}

	// Resolve the config file path
	absPath, err := filepath.Abs(filename)
	if err != nil {
		return config, fmt.Errorf("failed to resolve config file path: %w", err)
	}

	if verbose {
		fmt.Printf("📁 Resolved absolute path: %s\n", absPath)
	}

	// Check if file exists
	if _, err := os.Stat(absPath); os.IsNotExist(err) {
		if verbose {
			fmt.Printf("⚠️  File not found at absolute path, trying relative path: %s\n", filename)
		}
		// Try relative to current directory
		if _, err := os.Stat(filename); os.IsNotExist(err) {
			cwd, _ := os.Getwd()
			return config, fmt.Errorf("config file not found: %s\n\nSearched locations:\n  - %s\n  - %s\n\nPlease ensure the config file exists or specify the correct path with -c flag",
				filename, absPath, filepath.Join(cwd, filename))
		}
		absPath = filename
	}

	if verbose {
		fmt.Printf("✅ Found config file at: %s\n", absPath)
	}

	data, err := ioutil.ReadFile(absPath)
	if err != nil {
		return config, fmt.Errorf("failed to read config file '%s': %w", absPath, err)
	}

	// Support environment variable substitution
	expanded := os.ExpandEnv(string(data))

	if err := yaml.Unmarshal([]byte(expanded), &config); err != nil {
		return config, fmt.Errorf("failed to parse config file '%s': %w\n\nPlease check the YAML syntax is valid", absPath, err)
	}

	// Set defaults
	setConfigDefaults(&config)

	return config, nil
}

func saveConfig(config Config, filename string) error {
	data, err := yaml.Marshal(&config)
	if err != nil {
		return fmt.Errorf("failed to marshal config: %w", err)
	}

	return ioutil.WriteFile(filename, data, 0644)
}

func setConfigDefaults(config *Config) {
	if config.Kubernetes.ClusterName == "" {
		config.Kubernetes.ClusterName = "rulebricks-cluster"
	}
	if config.Kubernetes.NodeCount == 0 {
		config.Kubernetes.NodeCount = 1
	}
	if config.Kubernetes.MinNodes == 0 {
		config.Kubernetes.MinNodes = 1
	}
	if config.Kubernetes.MaxNodes == 0 {
		config.Kubernetes.MaxNodes = 4
	}
	if config.Security.TLS.Provider == "" && config.Security.TLS.Enabled {
		config.Security.TLS.Provider = "letsencrypt"
	}
	if config.Email.FromName == "" {
		config.Email.FromName = "Rulebricks"
	}
}

func fileExists(filename string) bool {
	_, err := os.Stat(filename)
	return !os.IsNotExist(err)
}

func confirmOverwrite() bool {
	fmt.Print("rulebricks.yaml already exists. Overwrite? (y/N): ")
	var response string
	fmt.Scanln(&response)
	return response == "y" || response == "Y"
}

func confirmDeployment() bool {
	fmt.Print("\nProceed with deployment? (y/N): ")
	var response string
	fmt.Scanln(&response)
	return response == "y" || response == "Y"
}



func generateMinimalConfig() Config {
	config := Config{
		Version: version,
	}

	// Project settings
	config.Project.Name = "my-rulebricks"
	config.Project.Domain = "rulebricks.example.com"
	config.Project.Email = "admin@example.com"
	config.Project.License = "YOUR_LICENSE_KEY"

	// Cloud settings
	config.Cloud.Provider = "aws"
	config.Cloud.Region = "us-east-1"

	// Kubernetes settings
	config.Kubernetes.ClusterName = "rulebricks-cluster"
	config.Kubernetes.NodeCount = 2
	config.Kubernetes.MinNodes = 1
	config.Kubernetes.MaxNodes = 4
	config.Kubernetes.EnableAutoscale = true

	// Database settings
	config.Database.Type = "managed"
	config.Database.Provider = "supabase"

	// Email settings (optional but provide example)
	config.Email.Provider = "smtp"
	config.Email.From = "noreply@example.com"
	config.Email.FromName = "Rulebricks"

	// Security settings
	config.Security.TLS.Enabled = true
	config.Security.TLS.Provider = "letsencrypt"

	// Monitoring settings
	config.Monitoring.Enabled = true
	config.Monitoring.Provider = "prometheus"

	return config
}

// loadDeploymentState loads the saved deployment state
func loadDeploymentState() (DeploymentState, error) {
	data, err := ioutil.ReadFile(".rulebricks-state.yaml")
	if err != nil {
		return DeploymentState{}, fmt.Errorf("no deployment state found: %w", err)
	}

	var state DeploymentState
	if err := yaml.Unmarshal(data, &state); err != nil {
		return DeploymentState{}, fmt.Errorf("failed to parse state: %w", err)
	}

	return state, nil
}
