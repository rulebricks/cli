package main

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"

	"github.com/fatih/color"
	"gopkg.in/yaml.v3"
)

type UpgradeManager struct {
	config       *Config
	configPath   string
	verbose      bool
	progress     *ProgressIndicator
	chartManager *ChartManager
	httpClient   *http.Client
}

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

func NewUpgradeManager(config *Config, verbose bool) *UpgradeManager {
	return NewUpgradeManagerWithConfigPath(config, "", verbose)
}

func NewUpgradeManagerWithConfigPath(config *Config, configPath string, verbose bool) *UpgradeManager {
	chartManager, _ := NewChartManager("", verbose)

	if configPath == "" {
		configPath = "rulebricks.yaml"
	}

	return &UpgradeManager{
		config:       config,
		configPath:   configPath,
		verbose:      verbose,
		progress:     NewProgressIndicator(verbose),
		chartManager: chartManager,
		httpClient: &http.Client{
			Timeout: 30 * time.Second,
		},
	}
}

func (um *UpgradeManager) ListVersions() error {
	spinner := um.progress.StartSpinner("Fetching available versions")

	releases, err := um.fetchReleases()
	if err != nil {
		spinner.Fail()
		return fmt.Errorf("failed to fetch releases: %w", err)
	}

	spinner.Success()

	currentVersion, _ := um.getCurrentVersion()

	color.New(color.Bold).Println("\n📦 Available Versions")
	fmt.Println(strings.Repeat("─", 50))

	for i, release := range releases {
		if i >= 10 {
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

func (um *UpgradeManager) CheckStatus() error {
	currentVersion, err := um.getCurrentVersion()
	if err != nil {
		return fmt.Errorf("failed to get current version: %w", err)
	}

	latestVersion, err := um.getLatestVersion()
	if err != nil {
		return fmt.Errorf("failed to get latest version: %w", err)
	}

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

func (um *UpgradeManager) Upgrade(version string, dryRun bool) error {
	if version == "latest" {
		var err error
		version, err = um.getLatestVersion()
		if err != nil {
			return fmt.Errorf("failed to get latest version: %w", err)
		}
	}

	currentVersion, err := um.getCurrentVersion()
	if err != nil {
		um.progress.Warning("Could not determine current version: %v", err)
		currentVersion = "unknown"
	} else if currentVersion != "unknown" && currentVersion == version {
		return fmt.Errorf("already running version %s", version)
	}

	fmt.Print("\033[H\033[2J")
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

	if !nonInteractive && !um.confirmUpgrade() {
		return fmt.Errorf("upgrade cancelled")
	}

	return um.performUpgrade(version)
}

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
	k8sOps, err := NewKubernetesOperations(um.config, false)
	if err == nil {
		namespace := um.config.GetNamespace("app")

		cmd := exec.Command("helm", "list", "-n", namespace, "-o", "json")
		output, err := cmd.Output()
		if err == nil {
			var releases []map[string]interface{}
			if err := json.Unmarshal(output, &releases); err == nil {
				for _, release := range releases {
					if release["name"] == "rulebricks" {
						if appVersion, ok := release["app_version"].(string); ok && appVersion != "" {
							return appVersion, nil
						}
						if chartInfo, ok := release["chart"].(string); ok {
							lastDash := strings.LastIndex(chartInfo, "-")
							if lastDash > 0 && lastDash < len(chartInfo)-1 {
								version := chartInfo[lastDash+1:]
								if strings.Count(version, ".") >= 1 {
									return version, nil
								}
							}
						}
					}
				}
			}
		}

		deployment, err := k8sOps.GetDeployment(context.Background(), namespace, "rulebricks")
		if err == nil {
			if version, ok := deployment.Labels["app.kubernetes.io/version"]; ok {
				return version, nil
			}
		}
	}

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

	for _, release := range releases {
		if !release.Prerelease {
			version := strings.TrimPrefix(release.TagName, "v")
			return version, nil
		}
	}

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

	spinner := um.progress.StartSpinner("Downloading chart")
	chartInfo, err := um.chartManager.PullChart(version)
	if err != nil {
		spinner.Fail()
		return fmt.Errorf("failed to download chart: %w", err)
	}
	spinner.Success()

	spinner = um.progress.StartSpinner("Analyzing changes")
	extractedPath, err := um.chartManager.ExtractChart(chartInfo.CachedPath)
	if err != nil {
		spinner.Fail()
		return err
	}
	defer os.RemoveAll(extractedPath)
	spinner.Success()

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

	if um.verbose {
		cwd, _ := os.Getwd()
		um.progress.Info("Current working directory: %s", cwd)
	}

	spinner := um.progress.StartSpinner("Downloading chart version " + version)
	chartInfo, err := um.chartManager.PullChart(version)
	if err != nil {
		spinner.Fail()
		return fmt.Errorf("failed to download chart: %w", err)
	}
	spinner.Success()

	spinner = um.progress.StartSpinner("Extracting chart")
	extractedPath, err := um.chartManager.ExtractChart(chartInfo.CachedPath)
	if err != nil {
		spinner.Fail()
		return err
	}
	defer os.RemoveAll(extractedPath)
	spinner.Success()

	if um.verbose {
		um.progress.Info("Chart extracted to: %s", extractedPath)
		cmd := exec.Command("ls", "-la", extractedPath)
		output, _ := cmd.Output()
		um.progress.Info("Extracted contents:\n%s", string(output))
	}

	spinner = um.progress.StartSpinner("Preparing configuration")
	values, err := um.generateUpgradeValues()
	if err != nil {
		spinner.Fail()
		return fmt.Errorf("failed to generate values: %w", err)
	}
	spinner.Success()

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
		var stdout, stderr strings.Builder
		cmd.Stdout = &stdout
		cmd.Stderr = &stderr

		if err := cmd.Run(); err != nil {
			spinner.Fail()
			errMsg := stderr.String()
			outMsg := stdout.String()

			errorDetails := fmt.Sprintf("helm upgrade failed: %v", err)
			if errMsg != "" {
				errorDetails += fmt.Sprintf("\n\nError output:\n%s", errMsg)
			}
			if outMsg != "" {
				errorDetails += fmt.Sprintf("\n\nStandard output:\n%s", outMsg)
			}

			if strings.Contains(errMsg, "not found") || strings.Contains(errMsg, "no such file") {
				errorDetails += fmt.Sprintf("\n\nDebug: Chart path was: %s", chartPath)
				errorDetails += "\nPlease check if the chart was extracted correctly."
			}

			return fmt.Errorf("%s", errorDetails)
		}
	}
	spinner.Success()

	if um.config.Database.Type != "" {
		spinner = um.progress.StartSpinner("Checking for database migrations")
		migrationsRun, err := um.runDatabaseMigrations(context.Background(), extractedPath, version)
		if err != nil {
			spinner.Fail()
			um.progress.Warning("Failed to run database migrations: %v", err)
		} else {
			spinner.Success()
			if migrationsRun > 0 {
				um.progress.Success("Applied %d new database migration(s)", migrationsRun)
			} else {
				um.progress.Info("No new database migrations to apply")
			}
		}
	}

	um.updateDeploymentState(version)

	spinner = um.progress.StartSpinner("Restarting HPS pods")
	if err := um.restartHPSPods(); err != nil {
		spinner.Fail()
		um.progress.Warning("Failed to restart HPS pods: %v", err)
	} else {
		spinner.Success()
	}

	spinner = um.progress.StartSpinner("Updating project configuration")
	if err := um.updateProjectVersion(version); err != nil {
		spinner.Fail()
		um.progress.Warning("Failed to update project configuration: %v", err)
	} else {
		spinner.Success()
	}

	duration := time.Since(startTime)
	color.Green("\n✅ Upgrade completed successfully in %s", formatDuration(duration))
	fmt.Printf("\nApplication upgraded to version: %s\n", color.CyanString(version))

	return nil
}

func (um *UpgradeManager) generateUpgradeValues() (map[string]interface{}, error) {
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

	values := currentValues

	values["project"] = map[string]interface{}{
		"name":    um.config.Project.Name,
		"domain":  um.config.Project.Domain,
		"version": um.config.Project.Version,
	}

	if appConfig, ok := values["app"].(map[string]interface{}); ok {
		appConfig["tlsEnabled"] = um.config.Security.TLS != nil && um.config.Security.TLS.Enabled

		if um.config.Project.Email != "" {
			appConfig["email"] = um.config.Project.Email
		}

		if um.config.Project.License != "" {
			appConfig["licenseKey"] = um.config.Project.License
		}
	}

	values["imageCredentials"] = map[string]interface{}{
		"registry": "index.docker.io",
		"username": "rulebricks",
		"password": fmt.Sprintf("dckr_pat_%s", um.config.Project.License),
	}

	return values, nil
}

func (um *UpgradeManager) updateDeploymentState(version string) error {
	statePath := ".rulebricks-state.yaml"

	var state DeploymentState
	if data, err := os.ReadFile(statePath); err == nil {
		yaml.Unmarshal(data, &state)
	}

	state.Application.Version = version
	state.UpdatedAt = time.Now()

	data, err := yaml.Marshal(&state)
	if err != nil {
		return err
	}

	return os.WriteFile(statePath, data, 0644)
}

func (um *UpgradeManager) runDatabaseMigrations(ctx context.Context, extractedChartPath string, version string) (int, error) {
	homeDir, _ := os.UserHomeDir()
	workDir := filepath.Join(homeDir, ".rulebricks", "deploy", um.config.Project.Name)
	if err := os.MkdirAll(workDir, 0755); err != nil {
		return 0, fmt.Errorf("failed to create work directory: %w", err)
	}

	assetManager, err := NewAssetManager(um.config.Project.License, workDir, um.verbose)
	if err != nil {
		return 0, fmt.Errorf("failed to create asset manager: %w", err)
	}

	targetSupabaseDir := filepath.Join(workDir, "supabase")

	if err := os.RemoveAll(targetSupabaseDir); err != nil && !os.IsNotExist(err) {
		um.progress.Warning("Failed to remove old supabase directory: %v", err)
	}

	imageName := fmt.Sprintf("%s:%s", DefaultAppImage, version)
	if um.config.Advanced.DockerRegistry != nil && um.config.Advanced.DockerRegistry.AppImage != "" {
		baseImage := um.config.Advanced.DockerRegistry.AppImage
		if idx := strings.LastIndex(baseImage, ":"); idx > 0 {
			baseImage = baseImage[:idx]
		}
		imageName = fmt.Sprintf("%s:%s", baseImage, version)
	}

	um.progress.Info("Extracting database migrations from %s to %s", imageName, targetSupabaseDir)

	dockerPassword := fmt.Sprintf("dckr_pat_%s", um.config.Project.License)
	loginCmd := exec.Command("docker", "login", "docker.io", "-u", "rulebricks", "-p", dockerPassword)
	if err := loginCmd.Run(); err != nil {
		if um.verbose {
			um.progress.Warning("Docker login failed: %v", err)
		}
	}

	containerName := fmt.Sprintf("rulebricks-upgrade-extract-%d", time.Now().Unix())
	createCmd := exec.CommandContext(ctx, "docker", "create", "--name", containerName, imageName)
	if err := createCmd.Run(); err != nil {
		return 0, fmt.Errorf("failed to create container from image %s: %w", imageName, err)
	}

	defer func() {
		removeCmd := exec.Command("docker", "rm", "-f", containerName)
		removeCmd.Run()
	}()

	copyCmd := exec.CommandContext(ctx, "docker", "cp",
		fmt.Sprintf("%s:/opt/rulebricks/assets/supabase", containerName), targetSupabaseDir)
	if err := copyCmd.Run(); err != nil {
		return 0, fmt.Errorf("failed to extract supabase assets from image: %w", err)
	}

	supabaseOpts := &SupabaseOptions{
		Verbose:      um.verbose,
		WorkDir:      workDir,
		ChartVersion: version,
		AssetManager: assetManager,
	}

	secrets := &SharedSecrets{}
	if um.config.Project.License != "" {
		secrets.LicenseKey = um.config.Project.License
	}

	if _, err := NewKubernetesOperations(um.config, um.verbose); err == nil {
		namespace := um.config.GetNamespace("app")

		cmd := exec.Command("kubectl", "get", "secret", "rulebricks-app-secret",
			"-n", namespace,
			"-o", "jsonpath={.data.DATABASE_URL}")
		if output, err := cmd.Output(); err == nil && len(output) > 0 {
			decodeCmd := exec.Command("base64", "-d")
			decodeCmd.Stdin = strings.NewReader(string(output))
			decoded, err := decodeCmd.Output()
			if err == nil && len(decoded) > 0 {
				if dbURL := string(decoded); dbURL != "" {
					if parts := strings.Split(dbURL, "@"); len(parts) >= 2 {
						userPass := parts[0]
						if idx := strings.LastIndex(userPass, ":"); idx > 0 {
							secrets.DBPassword = userPass[idx+1:]
						}
					}
				}
			}
		}

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

	migrationsDir := filepath.Join(workDir, "supabase", "migrations")
	var availableMigrations []string
	if entries, err := os.ReadDir(migrationsDir); err == nil {
		for _, entry := range entries {
			if !entry.IsDir() && strings.HasSuffix(entry.Name(), ".sql") {
				availableMigrations = append(availableMigrations, entry.Name())
			}
		}
	}

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
		um.progress.Info("Database type: %s - will attempt to apply all migrations", um.config.Database.Type)
	}

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

	if err := supabaseOps.RunMigrations(ctx); err != nil {
		return 0, fmt.Errorf("failed to run migrations: %w", err)
	}

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

	return len(newMigrations), nil
}

func (um *UpgradeManager) restartHPSPods() error {
	namespace := um.config.GetNamespace("app")

	// Restart rulebricks-hps statefulset
	cmd := exec.Command("kubectl", "rollout", "restart", "statefulset/rulebricks-hps", "-n", namespace)
	if um.verbose {
		cmd.Stdout = os.Stdout
		cmd.Stderr = os.Stderr
	}
	if err := cmd.Run(); err != nil {
		return fmt.Errorf("failed to restart rulebricks-hps statefulset: %w", err)
	}

	// Restart rulebricks-hps-worker statefulset
	cmd = exec.Command("kubectl", "rollout", "restart", "statefulset/rulebricks-hps-worker", "-n", namespace)
	if um.verbose {
		cmd.Stdout = os.Stdout
		cmd.Stderr = os.Stderr
	}
	if err := cmd.Run(); err != nil {
		return fmt.Errorf("failed to restart rulebricks-hps-worker statefulset: %w", err)
	}

	return nil
}

func (um *UpgradeManager) updateProjectVersion(version string) error {
	// Update the config version
	um.config.Project.Version = version

	// Save the updated config
	return SaveConfig(um.config, um.configPath)
}
