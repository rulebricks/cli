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

// UpgradeManager handles version upgrades
type UpgradeManager struct {
	config      *Config
	verbose     bool
	progress    *ProgressIndicator
	chartManager *ChartManager
	httpClient  *http.Client
}

// ChartRelease represents a GitHub release for the charts
type ChartRelease struct {
	TagName     string    `json:"tag_name"`
	Name        string    `json:"name"`
	CreatedAt   time.Time `json:"created_at"`
	Prerelease  bool      `json:"prerelease"`
	Assets      []struct {
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
	currentVersion, err := um.getCurrentVersion()
	if err != nil {
		um.progress.Warning("Could not determine current version: %v", err)
		currentVersion = "unknown"
	}

	// Display versions
	color.New(color.Bold).Println("\n📦 Available Versions")
	fmt.Println(strings.Repeat("─", 50))

	for i, release := range releases {
		if i >= 10 { // Show only last 10 versions
			break
		}

		versionStr := release.TagName
		if strings.HasPrefix(versionStr, "v") {
			versionStr = versionStr[1:]
		}

		marker := "  "
		if versionStr == currentVersion {
			marker = "→ "
			versionStr = color.GreenString("%s (current)", versionStr)
		} else if release.Prerelease {
			versionStr = color.YellowString("%s (pre-release)", versionStr)
		}

		fmt.Printf("%s%s - %s\n", marker, versionStr, release.CreatedAt.Format("2006-01-02"))
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
	} else if currentVersion == version {
		return fmt.Errorf("already running version %s", version)
	}

	// Display upgrade plan
	color.New(color.Bold).Println("\n📋 Upgrade Plan")
	fmt.Println(strings.Repeat("─", 50))
	fmt.Printf("Current version: %s\n", currentVersion)
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
	// Check deployment state
	statePath := ".rulebricks-state.yaml"

	if data, err := os.ReadFile(statePath); err == nil {
		var state DeploymentState
		if err := yaml.Unmarshal(data, &state); err == nil && state.Application.Version != "" {
			return state.Application.Version, nil
		}
	}

	// Try to get from deployed application
	k8sOps, err := NewKubernetesOperations(um.config, false)
	if err != nil {
		return "", err
	}

	namespace := um.config.GetNamespace("app")
	deployment, err := k8sOps.GetDeployment(context.Background(), namespace, "rulebricks")
	if err != nil {
		return "", err
	}

	if version, ok := deployment.Labels["app.kubernetes.io/version"]; ok {
		return version, nil
	}

	return "", fmt.Errorf("version not found")
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
			version := release.TagName
			if strings.HasPrefix(version, "v") {
				version = version[1:]
			}
			return version, nil
		}
	}

	// If all are prereleases, return the first one
	version := releases[0].TagName
	if strings.HasPrefix(version, "v") {
		version = version[1:]
	}
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

	cmd := exec.Command("helm", "upgrade", "rulebricks",
		filepath.Join(extractedPath, "rulebricks"),
		"--namespace", namespace,
		"--values", valuesFile,
		"--wait",
		"--timeout", "10m")

	if um.verbose {
		cmd.Stdout = os.Stdout
		cmd.Stderr = os.Stderr
	}

	if err := cmd.Run(); err != nil {
		spinner.Fail()
		return fmt.Errorf("helm upgrade failed: %w", err)
	}
	spinner.Success()

	// Phase 5: Update state
	um.updateDeploymentState(version)

	duration := time.Since(startTime)
	color.Green("\n✅ Upgrade completed successfully in %s", formatDuration(duration))
	fmt.Printf("\nApplication upgraded to version: %s\n", color.CyanString(version))

	return nil
}

func (um *UpgradeManager) generateUpgradeValues() (map[string]interface{}, error) {
	// This would generate the Helm values for upgrade
	// Similar to deployment, but preserving existing configuration
	values := make(map[string]interface{})

	// Add basic configuration
	values["project"] = map[string]interface{}{
		"name":    um.config.Project.Name,
		"domain":  um.config.Project.Domain,
		"version": um.config.Project.Version,
	}

	// Add other necessary values...

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
