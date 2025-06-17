package main

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"

	"github.com/fatih/color"
	"github.com/spf13/cobra"
	"gopkg.in/yaml.v3"
)

// ChartRelease represents a GitHub release
type ChartRelease struct {
	TagName   string `json:"tag_name"`
	Name      string `json:"name"`
	CreatedAt string `json:"created_at"`
	Assets    []struct {
		Name               string `json:"name"`
		BrowserDownloadURL string `json:"browser_download_url"`
	} `json:"assets"`
}

// UpgradeManager handles chart upgrades
type UpgradeManager struct {
	config      *Config
	namespace   string
	cacheDir    string
	httpClient  *http.Client
	verbose     bool
	dryRun      bool
	version     string
	supabaseOps *SupabaseOperations
}

// CreateUpgradeCommand creates the upgrade command
func CreateUpgradeCommand() *cobra.Command {
	um := &UpgradeManager{
		httpClient: &http.Client{
			Timeout: 5 * time.Minute,
		},
	}

	cmd := &cobra.Command{
		Use:   "upgrade",
		Short: "Upgrade Rulebricks to a new version",
		Long: `Upgrade the Rulebricks deployment to a new chart version.

This command will:
- Check for available updates
- Download the specified or latest chart version
- Generate values.yaml from your rulebricks.yaml configuration
- Perform a Helm upgrade of your deployment

Examples:
  rulebricks upgrade                    # Upgrade to latest version
  rulebricks upgrade --version 1.2.3    # Upgrade to specific version
  rulebricks upgrade --dry-run          # Check what would be upgraded
  rulebricks upgrade list               # List available versions`,
		RunE: um.runUpgrade,
	}

	// Add subcommands
	cmd.AddCommand(createUpgradeListCommand(um))
	cmd.AddCommand(createUpgradeStatusCommand(um))

	// Add flags
	cmd.Flags().StringVar(&um.namespace, "namespace", "", "Kubernetes namespace (defaults to project-prefixed namespace)")
	cmd.Flags().BoolVar(&um.dryRun, "dry-run", false, "Show what would be upgraded without applying changes")
	cmd.Flags().StringVar(&um.version, "version", "latest", "Chart version to upgrade to")
	cmd.PersistentFlags().BoolVarP(&um.verbose, "verbose", "v", false, "Enable verbose output")

	return cmd
}

// createUpgradeListCommand creates the list subcommand
func createUpgradeListCommand(um *UpgradeManager) *cobra.Command {
	return &cobra.Command{
		Use:   "list",
		Short: "List available chart versions",
		Long:  "List all available Rulebricks chart versions from the GitHub releases",
		RunE: func(cmd *cobra.Command, args []string) error {
			// Try to load config and get current version early
			var currentVersion string
			if err := um.loadConfig(cmd); err == nil {
				currentVersion, _ = um.getCurrentVersion()
			}

			releases, err := um.fetchReleases()
			if err != nil {
				return fmt.Errorf("failed to fetch releases: %w", err)
			}

			if len(releases) == 0 {
				color.Yellow("No releases found")
				return nil
			}

			fmt.Println("📦 Available Rulebricks Versions:\n")

			// Show current version if found
			if currentVersion != "" {
				fmt.Printf("📌 Current version: %s\n\n", color.CyanString(currentVersion))
			}

			fmt.Printf("%-12s %-22s %s\n", "VERSION", "RELEASE DATE", "CHARTS")
			fmt.Println(strings.Repeat("-", 50))

			for _, release := range releases {
				version := strings.TrimPrefix(release.TagName, "v")

				// Parse and format date
				releaseDate := "Unknown"
				if release.CreatedAt != "" {
					t, err := time.Parse(time.RFC3339, release.CreatedAt)
					if err == nil {
						releaseDate = t.Format("2006-01-02")
					}
				}

				// Count chart assets
				chartCount := 0
				for _, asset := range release.Assets {
					if strings.HasSuffix(asset.Name, ".tgz") {
						chartCount++
					}
				}

				fmt.Printf("%-12s %-22s %d\n", version, releaseDate, chartCount)
			}

			fmt.Println("\n📚 View changelog: https://rulebricks.com/docs/changelog")

			return nil
		},
	}
}

// createUpgradeStatusCommand creates the status subcommand
func createUpgradeStatusCommand(um *UpgradeManager) *cobra.Command {
	return &cobra.Command{
		Use:   "status",
		Short: "Show current deployment status",
		Long:  "Display the current version and status of your Rulebricks deployment",
		RunE: func(cmd *cobra.Command, args []string) error {
			// Load configuration
			if err := um.loadConfig(cmd); err != nil {
				return err
			}

			// Check current deployment
			currentVersion, err := um.getCurrentVersion()
			if err != nil {
				return fmt.Errorf("failed to get current version: %w", err)
			}

			if currentVersion == "" {
				color.Yellow("⚠️  No Rulebricks deployment found in namespace '%s'", um.namespace)
				return nil
			}

			fmt.Println("📊 Rulebricks Deployment Status\n")
			fmt.Printf("Namespace:       %s\n", um.namespace)
			fmt.Printf("Current Version: %s\n", color.CyanString(currentVersion))

			// Check for updates
			latestVersion, err := um.getLatestVersion()
			if err == nil && latestVersion != currentVersion {
				fmt.Printf("Latest Version:  %s %s\n", color.GreenString(latestVersion), color.GreenString("(update available)"))
			} else if err == nil {
				fmt.Printf("Latest Version:  %s %s\n", latestVersion, color.GreenString("(up to date)"))
			}

			// Show deployment details
			fmt.Println("\n🚀 Deployment Details:")
			listCmd := exec.Command("helm", "list", "-n", um.namespace, "-o", "json")
			output, err := listCmd.Output()
			if err == nil {
				var releases []map[string]interface{}
				if err := json.Unmarshal(output, &releases); err == nil {
					for _, rel := range releases {
						if name, ok := rel["name"].(string); ok && name == "rulebricks" {
							fmt.Printf("  Status:        %s\n", rel["status"])
							fmt.Printf("  Last Updated:  %s\n", rel["updated"])
							fmt.Printf("  Revision:      %v\n", rel["revision"])
						}
					}
				}
			}

			return nil
		},
	}
}

func (um *UpgradeManager) runUpgrade(cmd *cobra.Command, args []string) error {
	// Load configuration
	if err := um.loadConfig(cmd); err != nil {
		return err
	}

	// Check cluster connectivity
	if err := um.checkClusterConnectivity(); err != nil {
		return fmt.Errorf("failed to connect to cluster: %w", err)
	}

	// Get current version
	currentVersion, err := um.getCurrentVersion()
	if err != nil {
		return fmt.Errorf("failed to get current version: %w", err)
	}

	// Determine target version
	targetVersion := um.version
	if targetVersion == "latest" {
		latest, err := um.getLatestVersion()
		if err != nil {
			return fmt.Errorf("failed to get latest version: %w", err)
		}
		targetVersion = latest
	}

	// Check if upgrade is needed
	if currentVersion == targetVersion {
		color.Green("✅ Already at version %s", targetVersion)
		return nil
	}

	if currentVersion == "" {
		fmt.Printf("🚀 Installing Rulebricks %s...\n", color.CyanString(targetVersion))
	} else {
		fmt.Printf("🔄 Upgrading Rulebricks from %s to %s...\n",
			color.YellowString(currentVersion), color.CyanString(targetVersion))
	}

	if um.dryRun {
		color.Yellow("\n🔍 DRY RUN - No changes will be applied\n")
	}

	// Download chart
	chartPath, err := um.downloadChart(targetVersion)
	if err != nil {
		return fmt.Errorf("failed to download chart: %w", err)
	}

	// Generate values.yaml from rulebricks.yaml
	valuesPath, err := um.generateValues()
	if err != nil {
		return fmt.Errorf("failed to generate values: %w", err)
	}
	defer os.Remove(valuesPath)

	// Perform upgrade
	if !um.dryRun {
		if err := um.performUpgrade(chartPath, valuesPath); err != nil {
			return fmt.Errorf("upgrade failed: %w", err)
		}

		// Run database migrations if using managed or self-hosted Supabase
		if um.config.Database.Type == "managed" || um.config.Database.Type == "self-hosted" || um.config.Database.Type == "external" {
			fmt.Println("\n🔄 Applying database migrations...")

			// Update supabaseOps with the actual deployed version
			um.supabaseOps.chartVersion = targetVersion

			// Extract new Supabase assets from the new version
			if err := um.supabaseOps.EnsureSupabaseAssets(); err != nil {
				color.Yellow("⚠️  Warning: Failed to extract new database assets: %v", err)
				color.Yellow("   You may need to update manually.")
			} else {
				// Use supabase db push for all database types
				// This works for managed, self-hosted, and external DB configurations
				if err := um.supabaseOps.PushDatabaseSchema(um.dryRun); err != nil {
					color.Yellow("⚠️  Warning: Failed to apply database migrations: %v", err)
					color.Yellow("   You may need to run migrations manually.")
				} else {
					if um.dryRun {
						color.Cyan("✓ Database migrations check completed (dry run)")
					} else {
						color.Green("✅ Database migrations applied successfully!")
					}
				}
			}
		}

		color.Green("\n✅ Upgrade completed successfully!")
	} else {
		fmt.Println("\n📋 Upgrade Summary:")
		fmt.Printf("  Chart:     %s\n", chartPath)
		fmt.Printf("  Values:    %s\n", valuesPath)
		fmt.Printf("  Namespace: %s\n", um.namespace)
		if um.config.Database.Type == "managed" || um.config.Database.Type == "self-hosted" || um.config.Database.Type == "external" {
			fmt.Println("  Database:  Migrations will be applied")
		}
		fmt.Println("\nRun without --dry-run to apply these changes.")
	}

	// Cleanup resources
	if um.supabaseOps != nil {
		um.supabaseOps.Close()
	}

	return nil
}

func (um *UpgradeManager) loadConfig(cmd *cobra.Command) error {
	configFile := cmd.Flag("config").Value.String()
	if configFile == "" {
		configFile = "rulebricks.yaml"
	}

	config, err := loadConfig(configFile)
	if err != nil {
		return fmt.Errorf("failed to load configuration: %w", err)
	}
	um.config = &config

	// Set namespace - use config override, flag override, or default to project-prefixed namespace
	if um.config.Project.Namespace != "" {
		um.namespace = um.config.Project.Namespace
	} else if um.namespace == "" {
		// If no namespace specified, use project-prefixed default
		um.namespace = GetDefaultNamespace(um.config.Project.Name, "rulebricks")
	}

	// Set cache directory
	homeDir, err := os.UserHomeDir()
	if err != nil {
		return err
	}
	um.cacheDir = filepath.Join(homeDir, ".rulebricks", "charts")
	if err := os.MkdirAll(um.cacheDir, 0755); err != nil {
		return fmt.Errorf("failed to create cache directory: %w", err)
	}

	// Initialize SupabaseOperations if using Supabase
	if um.config.Database.Type == "managed" || um.config.Database.Type == "self-hosted" || um.config.Database.Type == "external" {
		um.supabaseOps = NewSupabaseOperations(*um.config, um.verbose, um.version)
	}

	return nil
}

func (um *UpgradeManager) checkClusterConnectivity() error {
	cmd := exec.Command("kubectl", "cluster-info")
	output, err := cmd.CombinedOutput()
	if err != nil {
		return fmt.Errorf("kubectl cluster-info failed: %w\n%s", err, output)
	}
	return nil
}

func (um *UpgradeManager) getCurrentVersion() (string, error) {
	cmd := exec.Command("helm", "list", "-n", um.namespace, "-o", "json")
	output, err := cmd.Output()
	if err != nil {
		return "", err
	}

	var releases []map[string]interface{}
	if err := json.Unmarshal(output, &releases); err != nil {
		return "", err
	}

	for _, release := range releases {
		if name, ok := release["name"].(string); ok && name == "rulebricks" {
			if version, ok := release["chart"].(string); ok {
				// Extract version from chart name (e.g., "rulebricks-1.2.3" -> "1.2.3")
				parts := strings.Split(version, "-")
				if len(parts) >= 2 {
					return parts[len(parts)-1], nil
				}
			}
		}
	}

	return "", nil
}

func (um *UpgradeManager) fetchReleases() ([]ChartRelease, error) {
	resp, err := um.httpClient.Get("https://api.github.com/repos/rulebricks/charts/releases")
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()

	var releases []ChartRelease
	if err := json.NewDecoder(resp.Body).Decode(&releases); err != nil {
		return nil, err
	}

	return releases, nil
}

func (um *UpgradeManager) getLatestVersion() (string, error) {
	releases, err := um.fetchReleases()
	if err != nil {
		return "", err
	}

	if len(releases) == 0 {
		return "", fmt.Errorf("no releases found")
	}

	// The first release should be the latest
	return strings.TrimPrefix(releases[0].TagName, "v"), nil
}

func (um *UpgradeManager) downloadChart(version string) (string, error) {
	chartName := fmt.Sprintf("rulebricks-%s.tgz", version)
	chartPath := filepath.Join(um.cacheDir, chartName)

	// Check if already cached
	if _, err := os.Stat(chartPath); err == nil {
		if um.verbose {
			fmt.Printf("📦 Using cached chart: %s\n", chartPath)
		}
		return chartPath, nil
	}

	// Download chart
	fmt.Printf("📥 Downloading chart version %s...\n", version)

	downloadURL := fmt.Sprintf("https://github.com/rulebricks/charts/releases/download/v%s/%s", version, chartName)
	checksumURL := fmt.Sprintf("%s.sha256", downloadURL)

	// Download checksum
	checksum, err := um.downloadFile(checksumURL, "")
	if err != nil {
		return "", fmt.Errorf("failed to download checksum: %w", err)
	}
	checksumStr := strings.TrimSpace(string(checksum))
	expectedChecksum := strings.Fields(checksumStr)[0]

	// Download chart
	if _, err := um.downloadFile(downloadURL, chartPath); err != nil {
		return "", fmt.Errorf("failed to download chart: %w", err)
	}

	// Verify checksum
	if err := um.verifyChecksum(chartPath, expectedChecksum); err != nil {
		os.Remove(chartPath)
		return "", fmt.Errorf("checksum verification failed: %w", err)
	}

	color.Green("✅ Chart downloaded and verified")
	return chartPath, nil
}

func (um *UpgradeManager) downloadFile(url, destPath string) ([]byte, error) {
	resp, err := um.httpClient.Get(url)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("HTTP %d: %s", resp.StatusCode, resp.Status)
	}

	if destPath == "" {
		// Return content as bytes
		return io.ReadAll(resp.Body)
	}

	// Save to file
	out, err := os.Create(destPath)
	if err != nil {
		return nil, err
	}
	defer out.Close()

	_, err = io.Copy(out, resp.Body)
	return nil, err
}

func (um *UpgradeManager) verifyChecksum(filePath, expectedChecksum string) error {
	file, err := os.Open(filePath)
	if err != nil {
		return err
	}
	defer file.Close()

	h := sha256.New()
	if _, err := io.Copy(h, file); err != nil {
		return err
	}

	actualChecksum := hex.EncodeToString(h.Sum(nil))
	if actualChecksum != expectedChecksum {
		return fmt.Errorf("checksum mismatch: expected %s, got %s", expectedChecksum, actualChecksum)
	}

	return nil
}

func (um *UpgradeManager) generateValues() (string, error) {
	if um.verbose {
		fmt.Println("🔧 Generating values.yaml from configuration...")
	}

	// Load secrets
	secrets := make(map[string]string)
	if d, err := NewDeployer(*um.config, DeploymentPlan{}, "", false); err == nil {
		d.loadSecrets()
		secrets = d.secrets
	}

	// Build values based on configuration
	values := map[string]interface{}{
		"global": map[string]interface{}{
			"domain": um.config.Project.Domain,
			"email":  um.config.Project.Email,
		},
		"rulebricks": map[string]interface{}{
			"enabled": true,
		},
		"supabase": map[string]interface{}{
			"enabled": um.config.Database.Type == "self-hosted",
		},
	}

	// Configure Rulebricks app
	rulebricksValues := map[string]interface{}{
		"app": map[string]interface{}{
			"licenseKey": secrets["license_key"],
			"tlsEnabled": true,
			"replicas":   2,
		},
		"imageCredentials": map[string]interface{}{
			"password": fmt.Sprintf("dckr_pat_%s", secrets["license_key"]),
		},
	}

	// Add custom Docker registry configuration if specified
	if um.config.Advanced.DockerRegistry.AppImage != "" {
		if appConfig, ok := rulebricksValues["app"].(map[string]interface{}); ok {
			appConfig["image"] = map[string]interface{}{
				"repository": um.config.Advanced.DockerRegistry.AppImage,
			}
		}
	}

	// Configure HPS image if custom registry is specified
	if um.config.Advanced.DockerRegistry.HPSImage != "" {
		rulebricksValues["hps"] = map[string]interface{}{
			"image": map[string]interface{}{
				"repository": um.config.Advanced.DockerRegistry.HPSImage,
			},
		}
	}

	// Configure database
	switch um.config.Database.Type {
	case "self-hosted":
		rulebricksValues["app"].(map[string]interface{})["supabaseUrl"] = fmt.Sprintf("https://supabase.%s", um.config.Project.Domain)
		rulebricksValues["app"].(map[string]interface{})["supabaseAnonKey"] = secrets["supabase_anon_key"]
		rulebricksValues["app"].(map[string]interface{})["supabaseServiceKey"] = secrets["supabase_service_key"]

		// Configure self-hosted Supabase
		values["supabase"].(map[string]interface{})["db"] = map[string]interface{}{
			"password": secrets["db_password"],
		}
		values["supabase"].(map[string]interface{})["auth"] = map[string]interface{}{
			"jwtSecret": secrets["jwt_secret"],
		}

	case "managed":
		// For managed Supabase, try to load from deployment state
		if stateFile, err := os.ReadFile(".rulebricks-state.yaml"); err == nil {
			var state DeploymentState
			if err := yaml.Unmarshal(stateFile, &state); err == nil && state.Database.URL != "" {
				rulebricksValues["app"].(map[string]interface{})["supabaseUrl"] = state.Database.URL
				rulebricksValues["app"].(map[string]interface{})["supabaseAnonKey"] = state.Database.AnonKey
				rulebricksValues["app"].(map[string]interface{})["supabaseServiceKey"] = state.Database.ServiceKey
			}
		}
		// If no state, these values need to be provided via environment or manual configuration

	case "external":
		// External PostgreSQL configuration
		if um.config.Database.External.Host != "" {
			// Construct connection string from components
			password := ""
			if um.config.Database.External.PasswordFrom != "" {
				// Handle password retrieval from env or file
				if strings.HasPrefix(um.config.Database.External.PasswordFrom, "env:") {
					envVar := strings.TrimPrefix(um.config.Database.External.PasswordFrom, "env:")
					password = os.Getenv(envVar)
				}
			}

			connStr := fmt.Sprintf("postgresql://%s:%s@%s:%d/%s?sslmode=%s",
				um.config.Database.External.Username,
				password,
				um.config.Database.External.Host,
				um.config.Database.External.Port,
				um.config.Database.External.Database,
				um.config.Database.External.SSLMode)
			rulebricksValues["app"].(map[string]interface{})["databaseUrl"] = connStr
		}
	}

	// Configure security
	if len(um.config.Security.Network.AllowedIPs) > 0 {
		values["global"].(map[string]interface{})["security"] = map[string]interface{}{
			"network": map[string]interface{}{
				"allowedIPs": um.config.Security.Network.AllowedIPs,
			},
		}
	}

	// Configure monitoring
	if um.config.Monitoring.Enabled {
		values["monitoring"] = map[string]interface{}{
			"enabled": true,
			"prometheus": map[string]interface{}{
				"enabled": um.config.Monitoring.Provider == "prometheus" || um.config.Monitoring.Provider == "all",
			},
			"grafana": map[string]interface{}{
				"enabled": um.config.Monitoring.Provider == "prometheus" || um.config.Monitoring.Provider == "all",
			},
		}
	}

	// Add custom values
	for key, value := range um.config.Advanced.CustomValues {
		values[key] = value
	}

	values["rulebricks"] = rulebricksValues

	// Write values to temporary file
	valuesFile, err := os.CreateTemp("", "rulebricks-values-*.yaml")
	if err != nil {
		return "", err
	}

	encoder := yaml.NewEncoder(valuesFile)
	encoder.SetIndent(2)
	if err := encoder.Encode(values); err != nil {
		valuesFile.Close()
		os.Remove(valuesFile.Name())
		return "", err
	}
	valuesFile.Close()

	return valuesFile.Name(), nil
}

func (um *UpgradeManager) performUpgrade(chartPath, valuesPath string) error {
	fmt.Println("\n⚙️  Performing Helm upgrade...")

	args := []string{
		"upgrade", "--install", "rulebricks",
		chartPath,
		"--namespace", um.namespace,
		"--create-namespace",
		"--values", valuesPath,
		"--wait",
		"--timeout", "10m",
	}

	if um.verbose {
		args = append(args, "--debug")
	}

	cmd := exec.Command("helm", args...)
	cmd.Stdout = os.Stdout
	cmd.Stderr = os.Stderr

	return cmd.Run()
}
