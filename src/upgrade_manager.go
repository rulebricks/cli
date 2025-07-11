package main

import (
	"context"
	"encoding/json"
	"fmt"
	"github.com/fatih/color"
	"gopkg.in/yaml.v3"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"
)

// UpgradeManager handles version upgrades
type UpgradeManager struct {
	config       *Config
	verbose      bool
	progress     *ProgressIndicator
	chartManager *ChartManager
	httpClient   *http.Client
}

// ChartRelease represents a GitHub release for the charts
type ChartRelease struct {
	TagName    string    `json:"tag_name"`
	Name       string    `json:"name"`
	CreatedAt  time.Time `json:"created_at"`
	Prerelease bool      `json:"prerelease"`
	Assets     []struct {
		Name               string `json:"name"`
		BrowserDownloadURL string `json:"browser_download_url"`
	} `json:"assets"`
}

// NewUpgradeManager creates a new upgrade manager
func NewUpgradeManager(config *Config, verbose bool) *UpgradeManager {
	chartManager, _ := NewChartManager("", verbose)

	return &UpgradeManager{
		config:       config,
		verbose:      verbose,
		progress:     NewProgressIndicator(verbose),
		chartManager: chartManager,
		httpClient: &http.Client{
			Timeout: 30 * time.Second,
		},
	}
}

// ListVersions lists available versions
func (um *UpgradeManager) ListVersions() error {
	spinner := um.progress.StartSpinner("Fetching available versions")

	releases, err := um.fetchReleases()
	if err != nil {
		spinner.Fail()
		return fmt.Errorf("failed to fetch releases: %w", err)
	}

	spinner.Success()

	// Get current version
	currentVersion, _ := um.getCurrentVersion()

	// Display versions
	color.New(color.Bold).Println("\n📦 Available Versions")
	fmt.Println(strings.Repeat("─", 50))

	for i, release := range releases {
		if i >= 10 { // Show only last 10 versions
			break
		}

		versionStr := strings.TrimPrefix(release.TagName, "v")

		marker := "  "
		dateStr := release.CreatedAt.Format("2006-01-02")

		if versionStr == currentVersion {
			marker = color.GreenString("→ ")
			versionStr = color.New(color.Bold, color.FgGreen).Sprintf("%s", versionStr)
			dateStr = fmt.Sprintf("%s %s", dateStr, color.GreenString("(current)"))
		} else if release.Prerelease {
			versionStr = color.YellowString("%s (pre-release)", versionStr)
		}

		fmt.Printf("%s%s - %s\n", marker, versionStr, dateStr)
	}

	fmt.Println(strings.Repeat("─", 50))
	return nil
}

// CheckStatus checks current version and available updates
func (um *UpgradeManager) CheckStatus() error {
	// Get current version
	currentVersion, err := um.getCurrentVersion()
	if err != nil {
		return fmt.Errorf("failed to get current version: %w", err)
	}

	// Get latest version
	latestVersion, err := um.getLatestVersion()
	if err != nil {
		return fmt.Errorf("failed to get latest version: %w", err)
	}

	// Display status
	color.New(color.Bold).Println("\n🔄 Upgrade Status")
	fmt.Println(strings.Repeat("─", 50))
	fmt.Printf("Current version: %s\n", color.CyanString(currentVersion))
	fmt.Printf("Latest version:  %s\n", color.CyanString(latestVersion))

	if currentVersion == latestVersion {
		color.Green("\n✅ You are running the latest version!")
	} else {
		color.Yellow("\n⬆️  An update is available!")
		fmt.Printf("\nTo upgrade, run: %s\n", color.YellowString("rulebricks upgrade run %s", latestVersion))
	}

	return nil
}

// Upgrade performs the upgrade to the specified version
func (um *UpgradeManager) Upgrade(version string, dryRun bool) error {
	// Resolve version
	if version == "latest" {
		var err error
		version, err = um.getLatestVersion()
		if err != nil {
			return fmt.Errorf("failed to get latest version: %w", err)
		}
	}

	// Get current version
	currentVersion, err := um.getCurrentVersion()
	if err != nil {
		um.progress.Warning("Could not determine current version: %v", err)
		currentVersion = "unknown"
	} else if currentVersion != "unknown" && currentVersion == version {
		return fmt.Errorf("already running version %s", version)
	}

	fmt.Print("\033[H\033[2J") // ANSI escape code to clear the console
	// Print the welcome message with ASCII art
	color.New(color.Bold, color.FgYellow).Printf(`


               ⟋ ‾‾‾‾⟋|
              ██████  |
              ██████  |
              ██████ ⟋ ‾‾‾‾⟋|
            ⟋     ⟋ ██████  |
           ██████   ██████  |
           ██████   ██████⟋
           ██████⟋

          [Upgrade Rulebricks]


`)
	// Display upgrade plan
	fmt.Println(strings.Repeat("─", 50))
	if currentVersion == "unknown" {
		fmt.Printf("Current version: %s\n", color.YellowString("unknown"))
	} else {
		fmt.Printf("Current version: %s\n", currentVersion)
	}
	fmt.Printf("Target version:  %s\n", color.GreenString(version))
	fmt.Printf("Dry run:         %v\n", dryRun)
	fmt.Println(strings.Repeat("─", 50))

	if dryRun {
		color.Yellow("\n🔍 Dry run mode - no changes will be made")
		return um.performDryRun(version)
	}

	// Confirm upgrade
	if !nonInteractive && !um.confirmUpgrade() {
		return fmt.Errorf("upgrade cancelled")
	}

	// Perform upgrade
	return um.performUpgrade(version)
}

// Private methods

func (um *UpgradeManager) fetchReleases() ([]ChartRelease, error) {
	resp, err := um.httpClient.Get("https://api.github.com/repos/rulebricks/charts/releases")
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("GitHub API returned status %d", resp.StatusCode)
	}

	var releases []ChartRelease
	if err := json.NewDecoder(resp.Body).Decode(&releases); err != nil {
		return nil, err
	}

	return releases, nil
}

func (um *UpgradeManager) getCurrentVersion() (string, error) {
	// Try to get from deployed application first (more accurate)
	k8sOps, err := NewKubernetesOperations(um.config, false)
	if err == nil {
		namespace := um.config.GetNamespace("app")

		// Try to get the deployed helm release version
		cmd := exec.Command("helm", "list", "-n", namespace, "-o", "json")
		output, err := cmd.Output()
		if err == nil {
			var releases []map[string]interface{}
			if err := json.Unmarshal(output, &releases); err == nil {
				for _, release := range releases {
					if release["name"] == "rulebricks" {
						// Try to get app_version first (most reliable)
						if appVersion, ok := release["app_version"].(string); ok && appVersion != "" {
							return appVersion, nil
						}
						// Fallback to parsing chart name
						if chartInfo, ok := release["chart"].(string); ok {
							// Extract version from chart name (e.g., "rulebricks-0.0.11")
							// Use a more robust approach - find the last occurrence of "-"
							lastDash := strings.LastIndex(chartInfo, "-")
							if lastDash > 0 && lastDash < len(chartInfo)-1 {
								version := chartInfo[lastDash+1:]
								// Validate it looks like a version
								if strings.Count(version, ".") >= 1 {
									return version, nil
								}
							}
						}
					}
				}
			}
		}

		// Fallback to deployment labels
		deployment, err := k8sOps.GetDeployment(context.Background(), namespace, "rulebricks")
		if err == nil {
			if version, ok := deployment.Labels["app.kubernetes.io/version"]; ok {
				return version, nil
			}
		}
	}

	// Check deployment state as fallback
	statePath := ".rulebricks-state.yaml"
	if data, err := os.ReadFile(statePath); err == nil {
		var state DeploymentState
		if err := yaml.Unmarshal(data, &state); err == nil && state.Application.Version != "" {
			return state.Application.Version, nil
		}
	}

	return "unknown", nil
}

func (um *UpgradeManager) getLatestVersion() (string, error) {
	releases, err := um.fetchReleases()
	if err != nil {
		return "", err
	}

	if len(releases) == 0 {
		return "", fmt.Errorf("no releases found")
	}

	// Find latest non-prerelease
	for _, release := range releases {
		if !release.Prerelease {
			version := strings.TrimPrefix(release.TagName, "v")
			return version, nil
		}
	}

	// If all are prereleases, return the first one
	version := releases[0].TagName
	version = strings.TrimPrefix(version, "v")
	return version, nil
}

func (um *UpgradeManager) confirmUpgrade() bool {
	fmt.Printf("\nProceed with upgrade? (y/N): ")
	var response string
	fmt.Scanln(&response)
	return strings.ToLower(response) == "y" || strings.ToLower(response) == "yes"
}

func (um *UpgradeManager) performDryRun(version string) error {
	um.progress.Section("Dry Run Analysis")

	// Download chart
	spinner := um.progress.StartSpinner("Downloading chart")
	chartInfo, err := um.chartManager.PullChart(version)
	if err != nil {
		spinner.Fail()
		return fmt.Errorf("failed to download chart: %w", err)
	}
	spinner.Success()

	// Extract and analyze
	spinner = um.progress.StartSpinner("Analyzing changes")
	extractedPath, err := um.chartManager.ExtractChart(chartInfo.CachedPath)
	if err != nil {
		spinner.Fail()
		return err
	}
	defer os.RemoveAll(extractedPath)
	spinner.Success()

	// Show what would be upgraded
	fmt.Println("\nThe following components would be upgraded:")
	fmt.Println("  • Rulebricks application")
	fmt.Println("  • Worker pods")
	fmt.Println("  • Configuration maps")

	if um.config.Database.Type == "self-hosted" {
		fmt.Println("  • Database migrations (if any)")
	}

	color.Green("\n✅ Dry run complete - no changes were made")
	return nil
}

func (um *UpgradeManager) performUpgrade(version string) error {
	startTime := time.Now()
	um.progress.Section("Starting Upgrade")

	// Debug: Log current directory
	if um.verbose {
		cwd, _ := os.Getwd()
		um.progress.Info("Current working directory: %s", cwd)
	}

	// Phase 1: Download new chart
	spinner := um.progress.StartSpinner("Downloading chart version " + version)
	chartInfo, err := um.chartManager.PullChart(version)
	if err != nil {
		spinner.Fail()
		return fmt.Errorf("failed to download chart: %w", err)
	}
	spinner.Success()

	// Phase 2: Extract chart
	spinner = um.progress.StartSpinner("Extracting chart")
	extractedPath, err := um.chartManager.ExtractChart(chartInfo.CachedPath)
	if err != nil {
		spinner.Fail()
		return err
	}
	defer os.RemoveAll(extractedPath)
	spinner.Success()

	// Debug: Log extracted path
	if um.verbose {
		um.progress.Info("Chart extracted to: %s", extractedPath)
		// List contents to verify structure
		cmd := exec.Command("ls", "-la", extractedPath)
		output, _ := cmd.Output()
		um.progress.Info("Extracted contents:\n%s", string(output))
	}

	// Phase 3: Generate values
	spinner = um.progress.StartSpinner("Preparing configuration")
	values, err := um.generateUpgradeValues()
	if err != nil {
		spinner.Fail()
		return fmt.Errorf("failed to generate values: %w", err)
	}
	spinner.Success()

	// Phase 4: Perform Helm upgrade
	spinner = um.progress.StartSpinner("Upgrading application")
	namespace := um.config.GetNamespace("app")

	valuesYAML, err := yaml.Marshal(values)
	if err != nil {
		spinner.Fail()
		return err
	}

	valuesFile, err := createTempFile("upgrade-values-", ".yaml", valuesYAML)
	if err != nil {
		spinner.Fail()
		return err
	}
	defer os.Remove(valuesFile)

	chartPath := filepath.Join(extractedPath, "rulebricks")

	// Debug: Verify chart exists
	if um.verbose {
		um.progress.Info("Using chart path: %s", chartPath)
		if _, err := os.Stat(filepath.Join(chartPath, "Chart.yaml")); err != nil {
			um.progress.Warning("Chart.yaml not found at expected path: %v", err)
		}
	}

	cmd := exec.Command("helm", "upgrade", "rulebricks",
		chartPath,
		"--namespace", namespace,
		"--values", valuesFile,
		"--wait",
		"--timeout", "10m")

	if um.verbose {
		cmd.Stdout = os.Stdout
		cmd.Stderr = os.Stderr
		if err := cmd.Run(); err != nil {
			spinner.Fail()
			return fmt.Errorf("helm upgrade failed: %w", err)
		}
	} else {
		// Capture both stdout and stderr for error reporting
		var stdout, stderr strings.Builder
		cmd.Stdout = &stdout
		cmd.Stderr = &stderr

		if err := cmd.Run(); err != nil {
			spinner.Fail()
			errMsg := stderr.String()
			outMsg := stdout.String()

			// Provide detailed error information
			errorDetails := fmt.Sprintf("helm upgrade failed: %v", err)
			if errMsg != "" {
				errorDetails += fmt.Sprintf("\n\nError output:\n%s", errMsg)
			}
			if outMsg != "" {
				errorDetails += fmt.Sprintf("\n\nStandard output:\n%s", outMsg)
			}

			// Additional debugging for common issues
			if strings.Contains(errMsg, "not found") || strings.Contains(errMsg, "no such file") {
				errorDetails += fmt.Sprintf("\n\nDebug: Chart path was: %s", chartPath)
				errorDetails += "\nPlease check if the chart was extracted correctly."
			}

			return fmt.Errorf(errorDetails)
		}
	}
	spinner.Success()

	// Phase 5: Run database migrations if applicable
	if um.config.Database.Type != "" {
		spinner = um.progress.StartSpinner("Checking for database migrations")
		migrationsRun, err := um.runDatabaseMigrations(context.Background(), extractedPath, version)
		if err != nil {
			spinner.Fail()
			um.progress.Warning("Failed to run database migrations: %v", err)
			// Don't fail the entire upgrade if migrations fail
		} else {
			spinner.Success()
			if migrationsRun > 0 {
				um.progress.Success("Applied %d new database migration(s)", migrationsRun)
			} else {
				um.progress.Info("No new database migrations to apply")
			}
		}
	}

	// Phase 6: Update state
	um.updateDeploymentState(version)

	duration := time.Since(startTime)
	color.Green("\n✅ Upgrade completed successfully in %s", formatDuration(duration))
	fmt.Printf("\nApplication upgraded to version: %s\n", color.CyanString(version))

	return nil
}

func (um *UpgradeManager) generateUpgradeValues() (map[string]interface{}, error) {
	// Get current values from deployed release
	namespace := um.config.GetNamespace("app")
	cmd := exec.Command("helm", "get", "values", "rulebricks", "-n", namespace, "-o", "json")
	output, err := cmd.Output()
	if err != nil {
		return nil, fmt.Errorf("failed to get current helm values: %w", err)
	}

	var currentValues map[string]interface{}
	if err := json.Unmarshal(output, &currentValues); err != nil {
		return nil, fmt.Errorf("failed to parse current values: %w", err)
	}

	// Start with current values as base
	values := currentValues

	// Override/update with any new configuration from config file
	values["project"] = map[string]interface{}{
		"name":    um.config.Project.Name,
		"domain":  um.config.Project.Domain,
		"version": um.config.Project.Version,
	}

	// Ensure app configuration is present
	if appConfig, ok := values["app"].(map[string]interface{}); ok {
		// Update TLS setting if changed
		appConfig["tlsEnabled"] = um.config.Security.TLS != nil && um.config.Security.TLS.Enabled

		// Update project email if different
		if um.config.Project.Email != "" {
			appConfig["email"] = um.config.Project.Email
		}

		// Update license key if present
		if um.config.Project.License != "" {
			appConfig["licenseKey"] = um.config.Project.License
		}
	}

	// Add image credentials for Docker Hub authentication
	// This is critical for pulling the Rulebricks app image
	values["imageCredentials"] = map[string]interface{}{
		"registry": "index.docker.io",
		"username": "rulebricks",
		"password": fmt.Sprintf("dckr_pat_%s", um.config.Project.License),
	}

	return values, nil
}

func (um *UpgradeManager) updateDeploymentState(version string) error {
	statePath := ".rulebricks-state.yaml"

	// Load existing state
	var state DeploymentState
	if data, err := os.ReadFile(statePath); err == nil {
		yaml.Unmarshal(data, &state)
	}

	// Update version
	state.Application.Version = version
	state.UpdatedAt = time.Now()

	// Save state
	data, err := yaml.Marshal(&state)
	if err != nil {
		return err
	}

	return os.WriteFile(statePath, data, 0644)
}

// runDatabaseMigrations runs any new database migrations from the upgraded version
func (um *UpgradeManager) runDatabaseMigrations(ctx context.Context, extractedChartPath string, version string) (int, error) {
	// Use the same persistent work directory as initial deployment
	homeDir, _ := os.UserHomeDir()
	workDir := filepath.Join(homeDir, ".rulebricks", "deploy", um.config.Project.Name)
	if err := os.MkdirAll(workDir, 0755); err != nil {
		return 0, fmt.Errorf("failed to create work directory: %w", err)
	}
	// Don't remove the work directory - keep it persistent

	// Initialize asset manager to extract Supabase assets from the new version
	assetManager, err := NewAssetManager(um.config.Project.License, workDir, um.verbose)
	if err != nil {
		return 0, fmt.Errorf("failed to create asset manager: %w", err)
	}

	// Extract Supabase assets from the new Docker image to the same location as initial deployment
	targetSupabaseDir := filepath.Join(workDir, "supabase")

	// Remove old supabase directory to ensure clean extraction
	if err := os.RemoveAll(targetSupabaseDir); err != nil && !os.IsNotExist(err) {
		um.progress.Warning("Failed to remove old supabase directory: %v", err)
	}

	// Construct the image name for the new version
	imageName := fmt.Sprintf("%s:%s", DefaultAppImage, version)
	if um.config.Advanced.DockerRegistry != nil && um.config.Advanced.DockerRegistry.AppImage != "" {
		// Use custom registry if configured
		baseImage := um.config.Advanced.DockerRegistry.AppImage
		// Remove any existing tag
		if idx := strings.LastIndex(baseImage, ":"); idx > 0 {
			baseImage = baseImage[:idx]
		}
		imageName = fmt.Sprintf("%s:%s", baseImage, version)
	}

	// Extract Supabase assets from Docker image
	um.progress.Info("Extracting database migrations from %s to %s", imageName, targetSupabaseDir)

	// Docker login for private registry access
	dockerPassword := fmt.Sprintf("dckr_pat_%s", um.config.Project.License)
	loginCmd := exec.Command("docker", "login", "docker.io", "-u", "rulebricks", "-p", dockerPassword)
	if err := loginCmd.Run(); err != nil {
		// Try to continue anyway - image might be cached
		if um.verbose {
			um.progress.Warning("Docker login failed: %v", err)
		}
	}

	// Create a temporary container
	containerName := fmt.Sprintf("rulebricks-upgrade-extract-%d", time.Now().Unix())
	createCmd := exec.CommandContext(ctx, "docker", "create", "--name", containerName, imageName)
	if err := createCmd.Run(); err != nil {
		return 0, fmt.Errorf("failed to create container from image %s: %w", imageName, err)
	}

	// Ensure container is removed even if extraction fails
	defer func() {
		removeCmd := exec.Command("docker", "rm", "-f", containerName)
		removeCmd.Run()
	}()

	// Copy supabase directory from container
	copyCmd := exec.CommandContext(ctx, "docker", "cp",
		fmt.Sprintf("%s:/opt/rulebricks/assets/supabase", containerName), targetSupabaseDir)
	if err := copyCmd.Run(); err != nil {
		return 0, fmt.Errorf("failed to extract supabase assets from image: %w", err)
	}

	// Create Supabase operations with the temporary work directory
	supabaseOpts := &SupabaseOptions{
		Verbose:      um.verbose,
		WorkDir:      workDir,
		ChartVersion: version,
		AssetManager: assetManager,
	}

	// Load secrets from state or environment
	secrets := &SharedSecrets{}
	if um.config.Project.License != "" {
		secrets.LicenseKey = um.config.Project.License
	}

	// Get existing secrets from deployed resources if available
	if _, err := NewKubernetesOperations(um.config, um.verbose); err == nil {
		namespace := um.config.GetNamespace("app")

		// Try to get database password from existing secret
		cmd := exec.Command("kubectl", "get", "secret", "rulebricks-app-secret",
			"-n", namespace,
			"-o", "jsonpath={.data.DATABASE_URL}")
		if output, err := cmd.Output(); err == nil && len(output) > 0 {
			// Decode base64
			decodeCmd := exec.Command("base64", "-d")
			decodeCmd.Stdin = strings.NewReader(string(output))
			decoded, err := decodeCmd.Output()
			if err == nil && len(decoded) > 0 {
				// Extract password from DATABASE_URL
				if dbURL := string(decoded); dbURL != "" {
					// Parse DATABASE_URL to extract password
					if parts := strings.Split(dbURL, "@"); len(parts) >= 2 {
						userPass := parts[0]
						if idx := strings.LastIndex(userPass, ":"); idx > 0 {
							secrets.DBPassword = userPass[idx+1:]
						}
					}
				}
			}
		}

		// Get Supabase anon key
		cmd = exec.Command("kubectl", "get", "secret", "rulebricks-app-secret",
			"-n", namespace,
			"-o", "jsonpath={.data.NEXT_PUBLIC_SUPABASE_ANON_KEY}")
		if output, err := cmd.Output(); err == nil && len(output) > 0 {
			decodeCmd := exec.Command("base64", "-d")
			decodeCmd.Stdin = strings.NewReader(string(output))
			if decoded, err := decodeCmd.Output(); err == nil {
				secrets.SupabaseAnonKey = string(decoded)
			}
		}

		// Get Supabase service key
		cmd = exec.Command("kubectl", "get", "secret", "rulebricks-app-secret",
			"-n", namespace,
			"-o", "jsonpath={.data.SUPABASE_SERVICE_KEY}")
		if output, err := cmd.Output(); err == nil && len(output) > 0 {
			decodeCmd := exec.Command("base64", "-d")
			decodeCmd.Stdin = strings.NewReader(string(output))
			if decoded, err := decodeCmd.Output(); err == nil {
				secrets.SupabaseServiceKey = string(decoded)
			}
		}

		// Get JWT secret
		cmd = exec.Command("kubectl", "get", "secret", "rulebricks-app-secret",
			"-n", namespace,
			"-o", "jsonpath={.data.SUPABASE_JWT_SECRET}")
		if output, err := cmd.Output(); err == nil && len(output) > 0 {
			decodeCmd := exec.Command("base64", "-d")
			decodeCmd.Stdin = strings.NewReader(string(output))
			if decoded, err := decodeCmd.Output(); err == nil {
				secrets.JWTSecret = string(decoded)
			}
		}
	}

	supabaseOpts.Secrets = secrets
	supabaseOps := NewSupabaseOperations(um.config, *supabaseOpts, um.progress)

	// Get list of available migrations
	migrationsDir := filepath.Join(workDir, "supabase", "migrations")
	var availableMigrations []string
	if entries, err := os.ReadDir(migrationsDir); err == nil {
		for _, entry := range entries {
			if !entry.IsDir() && strings.HasSuffix(entry.Name(), ".sql") {
				availableMigrations = append(availableMigrations, entry.Name())
			}
		}
	}

	// Get list of already applied migrations
	appliedMigrations := make(map[string]bool)
	var migrationsBefore int

	switch um.config.Database.Type {
	case "self-hosted":
		namespace := fmt.Sprintf("%s-supabase", um.config.Project.Name)
		getDbPodCmd := exec.CommandContext(ctx, "kubectl", "get", "pod",
			"-n", namespace,
			"-l", "app.kubernetes.io/name=supabase-db,app.kubernetes.io/instance=supabase",
			"-o", "jsonpath={.items[0].metadata.name}")
		dbPodBytes, _ := getDbPodCmd.Output()
		if dbPod := string(dbPodBytes); dbPod != "" {
			// Get list of applied migrations
			listCmd := fmt.Sprintf(`PGPASSWORD=%s psql -U postgres -d postgres -t -c "SELECT version FROM schema_migrations;" 2>/dev/null`, secrets.DBPassword)
			cmd := exec.CommandContext(ctx, "kubectl", "exec", "-n", namespace, dbPod, "--", "bash", "-c", listCmd)
			if output, err := cmd.Output(); err == nil {
				for _, line := range strings.Split(string(output), "\n") {
					migration := strings.TrimSpace(line)
					if migration != "" {
						appliedMigrations[migration] = true
						migrationsBefore++
					}
				}
			}
		}
	case "managed":
		// For managed databases, we can't easily check what's already applied
		// We'll rely on the migration system's idempotency
		um.progress.Info("Database type: %s - will attempt to apply all migrations", um.config.Database.Type)
	}

	// Count new migrations
	newMigrations := []string{}
	for _, migration := range availableMigrations {
		if !appliedMigrations[migration] {
			newMigrations = append(newMigrations, migration)
		}
	}

	if len(newMigrations) == 0 {
		um.progress.Info("No new migrations found")
		return 0, nil
	}

	um.progress.Info("Found %d new migration(s) to apply:", len(newMigrations))
	for _, migration := range newMigrations {
		um.progress.Info("  • %s", migration)
	}

	// Run migrations
	if err := supabaseOps.RunMigrations(ctx); err != nil {
		return 0, fmt.Errorf("failed to run migrations: %w", err)
	}

	// For self-hosted, verify migrations were applied
	if um.config.Database.Type == "self-hosted" {
		namespace := fmt.Sprintf("%s-supabase", um.config.Project.Name)
		getDbPodCmd := exec.CommandContext(ctx, "kubectl", "get", "pod",
			"-n", namespace,
			"-l", "app.kubernetes.io/name=supabase-db,app.kubernetes.io/instance=supabase",
			"-o", "jsonpath={.items[0].metadata.name}")
		dbPodBytes, _ := getDbPodCmd.Output()
		if dbPod := string(dbPodBytes); dbPod != "" {
			countCmd := fmt.Sprintf(`PGPASSWORD=%s psql -U postgres -d postgres -t -c "SELECT COUNT(*) FROM schema_migrations;" 2>/dev/null || echo 0`, secrets.DBPassword)
			cmd := exec.CommandContext(ctx, "kubectl", "exec", "-n", namespace, dbPod, "--", "bash", "-c", countCmd)
			if output, err := cmd.Output(); err == nil {
				var migrationsAfter int
				fmt.Sscanf(string(output), "%d", &migrationsAfter)
				return migrationsAfter - migrationsBefore, nil
			}
		}
	}

	// For managed/external, assume all new migrations were applied
	return len(newMigrations), nil
}
