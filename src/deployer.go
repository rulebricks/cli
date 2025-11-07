package main

import (
	"context"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"

	"github.com/fatih/color"
	"gopkg.in/yaml.v3"
)

type DeploymentPlan struct {
	Steps []DeploymentStep
}

type DeploymentStep interface {
	Name() string
	Description() string
	Required() bool
	CanRollback() bool
	Estimate() time.Duration
	Execute(ctx context.Context, d *Deployer) error
	Rollback(ctx context.Context, d *Deployer) error
}

type DeployerOptions struct {
	ChartVersion string
	Verbose      bool
	DryRun       bool
}

type Deployer struct {
	config   *Config
	options  DeployerOptions
	progress *ProgressIndicator
	state    *DeploymentState
	plan     DeploymentPlan

	workDir            string
	terraformDir       string
	extractedChartPath string
	chartManager       *ChartManager
	assetManager       *AssetManager
	cloudOps           *CloudOperations
	k8sOps             *KubernetesOperations
	supabaseOps        *SupabaseOperations
	secrets            *SharedSecrets
}

func NewDeployer(config *Config, options DeployerOptions) (*Deployer, error) {
	progress := NewProgressIndicator(options.Verbose)

	homeDir, _ := os.UserHomeDir()
	workDir := filepath.Join(homeDir, ".rulebricks", "deploy", config.Project.Name)
	if err := os.MkdirAll(workDir, 0755); err != nil {
		return nil, fmt.Errorf("failed to create work directory: %w", err)
	}

	chartManager, err := NewChartManager("", options.Verbose)
	if err != nil {
		return nil, fmt.Errorf("failed to initialize chart manager: %w", err)
	}

	assetManager, err := NewAssetManager(config.Project.License, workDir, options.Verbose)
	if err != nil {
		return nil, fmt.Errorf("failed to initialize asset manager: %w", err)
	}

	d := &Deployer{
		config:   config,
		options:  options,
		progress:     progress,
		workDir:      workDir,
		terraformDir: "terraform",
		chartManager: chartManager,
		assetManager: assetManager,
		secrets:      &SharedSecrets{},
		state: &DeploymentState{
			ProjectName:    config.Project.Name,
			Version:        config.Version,
			CreatedAt:      time.Now(),
			Infrastructure: InfrastructureState{},
			Database:       DatabaseState{},
			Application:    ApplicationState{},
			Monitoring:     MonitoringState{},
		},
	}

	d.loadState()
	d.plan = d.createPlan()

	return d, nil
}

func (d *Deployer) Execute() error {
	startTime := time.Now()

	d.displayPlan()

	if !nonInteractive && !d.confirmDeployment() {
		return fmt.Errorf("deployment cancelled by user")
	}

	d.progress.Section("Starting Deployment")

	if err := d.preflight(); err != nil {
		return fmt.Errorf("preflight checks failed: %w", err)
	}

	if err := d.loadSecrets(); err != nil {
		return fmt.Errorf("failed to load secrets: %w", err)
	}

	if err := d.initializeOperations(); err != nil {
		return fmt.Errorf("failed to initialize operations: %w", err)
	}

	d.progress.Info("Downloading and extracting deployment chart...")
	chartInfo, err := d.chartManager.PullChart(d.options.ChartVersion)
	if err != nil {
		return fmt.Errorf("failed to pull chart: %w", err)
	}

	d.extractedChartPath, err = d.chartManager.ExtractChart(chartInfo.CachedPath)
	if err != nil {
		return fmt.Errorf("failed to extract chart: %w", err)
	}
	defer os.RemoveAll(d.extractedChartPath)

	totalSteps := len(d.plan.Steps)
	taskNames := make([]string, totalSteps)
	for i, step := range d.plan.Steps {
		taskNames[i] = step.Name()
	}

	taskList := d.progress.StartTaskList(taskNames)

	ctx := context.Background()
	var failedStep DeploymentStep

	for _, step := range d.plan.Steps {
		task := taskList.StartTask()
		if task == nil {
			break
		}

		if !step.Required() && d.shouldSkipStep(step) {
			task.Skip()
			continue
		}

		if err := step.Execute(ctx, d); err != nil {
			task.Fail(err)
			failedStep = step
			break
		}

		task.Success()
		d.updateState(step.Name(), "completed")
	}

	taskList.Complete()

	if failedStep != nil {
		d.progress.Error("Deployment failed at step: %s", failedStep.Name())

		if failedStep.CanRollback() && d.confirmRollback() {
			d.progress.Section("Rolling Back")
			if err := failedStep.Rollback(ctx, d); err != nil {
				d.progress.Error("Rollback failed: %v", err)
			} else {
				d.progress.Success("Rollback completed")
			}
		}

		return fmt.Errorf("deployment failed")
	}

	// Save final state
	if err := d.saveState(); err != nil {
		d.progress.Warning("Failed to save deployment state: %v", err)
	}

	// Display connection information
	d.displayConnectionInfo()

	duration := time.Since(startTime)
	d.progress.Success("Deployment completed successfully in %s", formatDuration(duration))

	return nil
}

func (d *Deployer) createPlan() DeploymentPlan {
	var steps []DeploymentStep

	if d.state == nil || d.state.Infrastructure.ClusterEndpoint == "" {
		steps = append(steps, &InfrastructureStep{})
	}

	steps = append(steps,
		&CoreServicesStep{},
		&DatabaseStep{},
		&EmailConfigStep{},
	)

	if d.config.Monitoring.Enabled {
		steps = append(steps, &MonitoringStep{})
	}

	if d.config.Logging.Enabled {
		steps = append(steps, &LoggingStep{})
	}

	steps = append(steps, &KafkaStep{})

	steps = append(steps,
		&ApplicationStep{},
		&DNSVerificationStep{},
	)

	if d.config.Security.TLS != nil && d.config.Security.TLS.Enabled {
		steps = append(steps, &TLSConfigurationStep{})
	}

	return DeploymentPlan{Steps: steps}
}

func (d *Deployer) displayPlan() {
	fmt.Print("\033[H\033[2J")
	color.New(color.Bold, color.FgCyan).Printf(`


               ⟋ ‾‾‾‾⟋|
              ██████  |
              ██████  |
              ██████ ⟋ ‾‾‾‾⟋|
            ⟋     ⟋ ██████  |
           ██████   ██████  |
           ██████   ██████⟋
           ██████⟋

          [Install Rulebricks]


`)
	fmt.Println(strings.Repeat("─", 50))

	for i, step := range d.plan.Steps {
		status := "pending"
		if d.isStepCompleted(step.Name()) {
			status = color.GreenString("✓ completed")
		} else if !step.Required() {
			status = color.YellowString("optional")
		}

		estimate := step.Estimate()

		fmt.Printf("%2d. %-30s %s\n", i+1, step.Name(), status)
		fmt.Printf("    %s\n", color.HiBlackString(step.Description()))
		if estimate > 0 {
			fmt.Printf("    %s\n", color.HiBlackString("Estimated time: %s", formatDuration(estimate)))
		}
		fmt.Println()
	}

	fmt.Println(strings.Repeat("─", 50))
}

func (d *Deployer) preflight() error {
	spinner := d.progress.StartSpinner("Running preflight checks")

	checks := []struct {
		name    string
		command string
		version string
	}{
		{"kubectl", "kubectl", "version --client --short"},
		{"helm", "helm", "version --short"},
		{"terraform", "terraform", "version"},
	}

	switch d.config.Cloud.Provider {
	case "aws":
		checks = append(checks, struct{ name, command, version string }{
			"aws", "aws", "--version",
		})
	case "azure":
		checks = append(checks, struct{ name, command, version string }{
			"az", "az", "--version",
		})
	case "gcp":
		checks = append(checks, struct{ name, command, version string }{
			"gcloud", "gcloud", "--version",
		})
	}

	if d.config.Database.Type == "managed" {
		checks = append(checks, struct{ name, command, version string }{
			"supabase", "supabase", "--version",
		})
	}

	failed := false
	for _, check := range checks {
		if _, err := exec.LookPath(check.command); err != nil {
			d.progress.Error("%s not found in PATH", check.name)
			failed = true
			continue
		}

		if d.options.Verbose && check.version != "" {
			cmd := exec.Command(check.command, strings.Fields(check.version)...)
			if output, err := cmd.Output(); err == nil {
				d.progress.Debug("%s: %s", check.name, strings.TrimSpace(string(output)))
			}
		}
	}

	if failed {
		spinner.Fail("Preflight checks failed")
		return fmt.Errorf("required tools not found")
	}

	// Check cloud credentials
	if err := d.checkCloudCredentials(); err != nil {
		spinner.Fail("Cloud credentials check failed")
		return err
	}

	spinner.Success("Preflight checks passed")
	return nil
}

func (d *Deployer) initializeOperations() error {
	spinner := d.progress.StartSpinner("Initializing operations")

	cloudOps, err := NewCloudOperations(d.config, d.terraformDir, d.options.Verbose)
	if err != nil {
		spinner.Fail()
		return fmt.Errorf("failed to initialize cloud operations: %w", err)
	}
	d.cloudOps = cloudOps

	// Initialize Kubernetes operations
	k8sOps, err := NewKubernetesOperations(d.config, d.options.Verbose)
	if err != nil {
		// Not fatal - cluster might not exist yet
		d.progress.Debug("Kubernetes operations not yet available: %v", err)
	}
	d.k8sOps = k8sOps

	// Initialize Supabase operations
	supabaseOps := NewSupabaseOperations(d.config, SupabaseOptions{
		Verbose:      d.options.Verbose,
		WorkDir:      d.workDir,
		ChartVersion: d.options.ChartVersion,
		ChartManager: d.chartManager,
		AssetManager: d.assetManager,
		Secrets:      d.secrets,
	}, d.progress)
	d.supabaseOps = supabaseOps

	spinner.Success("Operations initialized")
	return nil
}

func (d *Deployer) checkCloudCredentials() error {
	switch d.config.Cloud.Provider {
	case "aws":
		return d.checkAWSCredentials()
	case "azure":
		return d.checkAzureCredentials()
	case "gcp":
		return d.checkGCPCredentials()
	default:
		return fmt.Errorf("unsupported cloud provider: %s", d.config.Cloud.Provider)
	}
}

func (d *Deployer) checkAWSCredentials() error {
	cmd := exec.Command("aws", "sts", "get-caller-identity")
	output, err := cmd.Output()
	if err != nil {
		return fmt.Errorf("AWS credentials not configured properly")
	}

	if d.options.Verbose {
		d.progress.Debug("AWS credentials verified: %s", strings.TrimSpace(string(output)))
	}

	return nil
}

func (d *Deployer) checkAzureCredentials() error {
	cmd := exec.Command("az", "account", "show")
	if err := cmd.Run(); err != nil {
		return fmt.Errorf("azure credentials not configured properly. Run 'az login'")
	}
	return nil
}

func (d *Deployer) checkGCPCredentials() error {
	cmd := exec.Command("gcloud", "auth", "list", "--filter=status:ACTIVE", "--format=value(account)")
	output, err := cmd.Output()
	if err != nil || strings.TrimSpace(string(output)) == "" {
		return fmt.Errorf("GCP credentials not configured properly. Run 'gcloud auth login'")
	}
	return nil
}

func (d *Deployer) loadSecrets() error {
	licenseKey, err := resolveSecretValue(d.config.Project.License)
	if err != nil {
		return fmt.Errorf("failed to load license key: %w", err)
	}
	d.secrets.LicenseKey = licenseKey

	if d.config.Database.Type == "self-hosted" && d.state != nil {
		if d.state.Database.JWTSecret != "" {
			d.secrets.JWTSecret = d.state.Database.JWTSecret
			d.secrets.DBPassword = d.state.Database.DBPassword
			d.secrets.DashboardPassword = d.state.Database.DashboardPassword
			d.secrets.SupabaseAnonKey = d.state.Database.AnonKey
			d.secrets.SupabaseServiceKey = d.state.Database.ServiceKey
		}
	}

	if d.config.Email.SMTP != nil {
		password, err := resolveSecretValue(d.config.Email.SMTP.PasswordFrom)
		if err != nil {
			return fmt.Errorf("failed to load SMTP password: %w", err)
		}
		d.secrets.SMTPPassword = password
	}

	if d.config.AI.Enabled && d.config.AI.OpenAIAPIKeyFrom != "" {
		apiKey, err := resolveSecretValue(d.config.AI.OpenAIAPIKeyFrom)
		if err != nil {
			return fmt.Errorf("failed to load OpenAI API key: %w", err)
		}
		os.Setenv("OPENAI_API_KEY", apiKey)
	}

	return nil
}

func (d *Deployer) confirmDeployment() bool {
	fmt.Println("\nThis will deploy the following:")
	fmt.Printf("  • Project: %s\n", d.config.Project.Name)
	fmt.Printf("  • Domain: %s\n", d.config.Project.Domain)
	fmt.Printf("  • Cloud: %s (%s)\n", d.config.Cloud.Provider, d.config.Cloud.Region)
	fmt.Printf("  • Database: %s\n", d.config.Database.Type)

	if d.config.Monitoring.Enabled {
		mode := d.config.Monitoring.Mode
		if mode == "" {
			mode = "local"
		}
		fmt.Printf("  • Monitoring: %s", mode)
		if mode == "remote" && d.config.Monitoring.Remote != nil {
			fmt.Printf(" (%s)", d.config.Monitoring.Remote.Provider)
		}
		fmt.Println()
	}

	fmt.Printf("\nContinue? (y/N): ")
	var response string
	fmt.Scanln(&response)

	return strings.ToLower(response) == "y" || strings.ToLower(response) == "yes"
}

func (d *Deployer) confirmRollback() bool {
	if nonInteractive {
		return true
	}

	fmt.Printf("\nDo you want to rollback the failed step? (y/N): ")
	var response string
	fmt.Scanln(&response)

	return strings.ToLower(response) == "y" || strings.ToLower(response) == "yes"
}

func (d *Deployer) shouldSkipStep(step DeploymentStep) bool {
	return d.isStepCompleted(step.Name())
}

func (d *Deployer) isStepCompleted(stepName string) bool {
	if d.state == nil {
		return false
	}

	switch stepName {
	case "Infrastructure":
		return d.state.Infrastructure.ClusterEndpoint != ""
	case "Database":
		return d.state.Database.URL != ""
	case "Application":
		return d.state.Application.Deployed
	default:
		return false
	}
}

func (d *Deployer) updateState(step, status string) {
	if d.state == nil {
		d.state = &DeploymentState{
			ProjectName: d.config.Project.Name,
			Version:     d.config.Version,
			CreatedAt:   time.Now(),
		}
	}

	d.state.UpdatedAt = time.Now()

	switch step {
	case "Infrastructure":
		if status == "completed" && d.cloudOps != nil {
			d.state.Infrastructure = d.cloudOps.GetInfrastructureState()
		}
	case "Database":
		if status == "completed" && d.supabaseOps != nil {
			d.state.Database = d.supabaseOps.GetDatabaseState()
			if d.config.Database.Type == "self-hosted" {
				d.state.Database.JWTSecret = d.secrets.JWTSecret
				d.state.Database.DBPassword = d.secrets.DBPassword
				d.state.Database.DashboardPassword = d.secrets.DashboardPassword
			}
		}
	case "Application":
		if status == "completed" {
			d.state.Application.Deployed = true
			d.state.Application.Version = d.options.ChartVersion
			d.state.Application.URL = fmt.Sprintf("https://%s", d.config.Project.Domain)
		}
	}

	d.saveState()
}

func (d *Deployer) loadState() error {
	statePath := ".rulebricks-state.yaml"

	if _, err := os.Stat(statePath); os.IsNotExist(err) {
		return nil
	}

	data, err := os.ReadFile(statePath)
	if err != nil {
		return err
	}

	state := &DeploymentState{}
	if err := yaml.Unmarshal(data, state); err != nil {
		return err
	}

	d.state = state
	return nil
}

func (d *Deployer) saveState() error {
	if d.state == nil {
		return nil
	}

	statePath := ".rulebricks-state.yaml"

	data, err := yaml.Marshal(d.state)
	if err != nil {
		return err
	}

	return os.WriteFile(statePath, data, 0644)
}

func (d *Deployer) displayConnectionInfo() {
	fmt.Print("\033[H\033[2J")
	color.New(color.Bold, color.FgGreen).Printf(`


               ⟋ ‾‾‾‾⟋|
              ██████  |
              ██████  |
              ██████ ⟋ ‾‾‾‾⟋|
            ⟋     ⟋ ██████  |
           ██████   ██████  |
           ██████   ██████⟋
           ██████⟋

               [Welcome]

`)

	fmt.Println("\n" + strings.Repeat("=", 60))
	color.Green("🎉 Deployment Complete!")
	fmt.Println(strings.Repeat("=", 60))

	fmt.Printf("\n📌 Rulebricks Instance:\n")
	fmt.Printf("   URL: https://%s\n", d.config.Project.Domain)
	fmt.Printf("   Admin Email: %s\n", d.config.Project.Email)

	if d.state != nil && d.state.Database.DashboardURL != "" {
		fmt.Printf("\n📊 Supabase Dashboard:\n")
		fmt.Printf("   URL: %s\n", d.state.Database.DashboardURL)
		if d.state.Database.DashboardUsername != "" {
			fmt.Printf("   Username: %s\n", d.state.Database.DashboardUsername)
		}
		if d.state.Database.DashboardPassword != "" {
			fmt.Printf("   Password: %s\n", d.state.Database.DashboardPassword)
		}
	}

	if d.config.Monitoring.Enabled && d.state != nil {
		mode := d.config.Monitoring.Mode
		if mode == "" {
			mode = "local"
		}

		switch mode {
		case "local":
			if d.state.Monitoring.GrafanaPassword != "" {
				fmt.Printf("\n📈 Grafana Dashboard:\n")
				fmt.Printf("   URL: https://grafana.%s\n", d.config.Project.Domain)
				fmt.Printf("   Username: admin\n")
				fmt.Printf("   Password: %s\n", d.state.Monitoring.GrafanaPassword)
			}

		case "remote":
			fmt.Printf("\n📈 Monitoring:\n")
			fmt.Printf("   Mode: Remote\n")
			if d.config.Monitoring.Remote != nil {
				fmt.Printf("   Provider: %s\n", d.config.Monitoring.Remote.Provider)
				fmt.Printf("   Metrics are being sent to your external monitoring system\n")
			}

		}
	}

	fmt.Printf("\n💾 State saved to: .rulebricks-state.yaml\n")
	fmt.Printf("\n📚 Next steps:\n")
	fmt.Printf("   1. Visit https://%s/auth/signup to create your account\n", d.config.Project.Domain)
	fmt.Printf("   2. Check 'rulebricks status' to monitor your deployment\n")
	fmt.Printf("   3. Use 'rulebricks logs' to view application logs\n")
	fmt.Printf("   4. Use 'rulebricks upgrade' to find & install new application versions\n")

	// Check if logging requires IAM setup
	if d.config.Logging.Enabled && d.config.Logging.Vector != nil && d.config.Logging.Vector.Sink != nil {
		needsIAMSetup := false
		var setupCommand string

		switch d.config.Logging.Vector.Sink.Type {
		case "aws_s3":
			needsIAMSetup = true
			setupCommand = "rulebricks vector setup-s3"
		case "gcp_cloud_storage":
			needsIAMSetup = true
			setupCommand = "rulebricks vector setup-gcs"
		case "azure_blob":
			needsIAMSetup = true
			setupCommand = "rulebricks vector setup-azure"
		}

		if needsIAMSetup {
			color.Yellow("\n⚠️  Vector logging requires IAM permissions to be configured.")
			fmt.Printf("   Run '%s' to set up the required permissions.\n", setupCommand)
			fmt.Printf("   Or use 'rulebricks vector generate-iam-config' for manual setup instructions.\n")
		}
	}

	if d.config.Email.SMTP == nil {
		color.Yellow("\n⚠️  Email not configured. Configure email to enable notifications.\n")
	}

	fmt.Println("\n" + strings.Repeat("=", 60))
}

type DeploymentState struct {
	ProjectName          string              `yaml:"project_name"`
	Version              string              `yaml:"version"`
	CreatedAt            time.Time           `yaml:"created_at"`
	UpdatedAt            time.Time           `yaml:"updated_at"`
	Infrastructure       InfrastructureState `yaml:"infrastructure"`
	Database             DatabaseState       `yaml:"database"`
	Application          ApplicationState    `yaml:"application"`
	Monitoring           MonitoringState     `yaml:"monitoring"`
	LoadBalancerEndpoint string              `yaml:"load_balancer_endpoint,omitempty"`
}

type InfrastructureState struct {
	Provider        string    `yaml:"provider"`
	Region          string    `yaml:"region"`
	ClusterName     string    `yaml:"cluster_name"`
	ClusterEndpoint string    `yaml:"cluster_endpoint"`
	NodeCount       int       `yaml:"node_count"`
	CreatedAt       time.Time `yaml:"created_at"`
}

type DatabaseState struct {
	Type              string `json:"type"`
	Provider          string `json:"provider"`
	URL               string `json:"url"`
	Internal          bool   `json:"internal"`
	AnonKey           string `json:"anon_key,omitempty"`
	ServiceKey        string `json:"service_key,omitempty"`
	DashboardPassword string `json:"dashboard_password,omitempty"`
	DashboardUsername string `json:"dashboard_username,omitempty"`
	DashboardURL      string `json:"dashboard_url,omitempty"`
	PostgresHost      string `json:"postgres_host,omitempty"`
	PostgresPort      int    `json:"postgres_port,omitempty"`
	PostgresDatabase  string `json:"postgres_database,omitempty"`
	PostgresUsername  string `json:"postgres_username,omitempty"`
	JWTSecret         string `json:"jwt_secret,omitempty"`
	DBPassword string `json:"db_password,omitempty"`
}

type ApplicationState struct {
	Deployed       bool   `yaml:"deployed"`
	Version        string `yaml:"version"`
	URL            string `yaml:"url"`
	Replicas       int    `yaml:"replicas"`
	VectorEndpoint string `yaml:"vector_endpoint,omitempty"`
	KafkaBrokers   string `yaml:"kafka_brokers,omitempty"`
}

type MonitoringState struct {
	Enabled         bool   `yaml:"enabled"`
	Provider        string `yaml:"provider,omitempty"`
	GrafanaURL      string `yaml:"grafana_url,omitempty"`
	GrafanaUsername string `yaml:"grafana_username,omitempty"`
	GrafanaPassword string `yaml:"grafana_password,omitempty"`
}
