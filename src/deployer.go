// deployer.go - Deployment Executor
package main

import (
	"encoding/json"
	"fmt"
	"io/ioutil"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"
	"github.com/fatih/color"
	"gopkg.in/yaml.v3"
)

// DeploymentPlan represents the steps needed for deployment
type DeploymentPlan struct {
	Steps []DeploymentStep
}

// DeploymentStep represents a single deployment action
type DeploymentStep struct {
	Name        string
	Type        string // terraform, helm, kubectl, script
	Description string
	Required    bool
	Rollback    func() error
}

// Display shows the deployment plan
func (p DeploymentPlan) Display() {
	fmt.Println("\nThe following steps will be executed:")
	for i, step := range p.Steps {
		icon := "📦"
		switch step.Type {
		case "terraform":
			icon = "🏗️"
		case "helm":
			icon = "⚓"
		case "kubectl":
			icon = "☸️"
		case "script":
			icon = "📜"
		}

		fmt.Printf("%d. %s %s - %s\n", i+1, icon, step.Name, step.Description)
	}
}

// DeploymentPlanner creates deployment plans
type DeploymentPlanner struct {
	config Config
}

// NewDeploymentPlanner creates a new planner
func NewDeploymentPlanner(config Config) *DeploymentPlanner {
	return &DeploymentPlanner{config: config}
}

// CreatePlan generates a deployment plan based on configuration
func (p *DeploymentPlanner) CreatePlan() DeploymentPlan {
	plan := DeploymentPlan{
		Steps: []DeploymentStep{},
	}

	// Step 1: Terraform infrastructure
	plan.Steps = append(plan.Steps, DeploymentStep{
		Name:        "Infrastructure",
		Type:        "terraform",
		Description: fmt.Sprintf("Create %s Kubernetes cluster in %s", p.config.Cloud.Provider, p.config.Cloud.Region),
		Required:    true,
	})

	// Step 2: Core services
	plan.Steps = append(plan.Steps, DeploymentStep{
		Name:        "Core Services",
		Type:        "helm",
		Description: "Install Traefik ingress controller and cert-manager",
		Required:    true,
	})

	// Step 3: Database
	switch p.config.Database.Type {
	case "self-hosted":
		plan.Steps = append(plan.Steps, DeploymentStep{
			Name:        "Supabase",
			Type:        "helm",
			Description: "Deploy self-hosted Supabase in Kubernetes",
			Required:    true,
		})
	case "managed":
		plan.Steps = append(plan.Steps, DeploymentStep{
			Name:        "Supabase Cloud",
			Type:        "script",
			Description: "Configure managed Supabase project",
			Required:    true,
		})
	case "external":
		plan.Steps = append(plan.Steps, DeploymentStep{
			Name:        "Database Connection",
			Type:        "script",
			Description: "Validate external PostgreSQL connection",
			Required:    true,
		})
	}

	// Step 4: Kafka (mandatory) - required for HPS high-volume request processing
	plan.Steps = append(plan.Steps, DeploymentStep{
		Name:        "Kafka",
		Type:        "helm",
		Description: "Deploy Kafka for high-volume request processing and log buffering",
		Required:    true,
	})

	// Step 5: Application
	plan.Steps = append(plan.Steps, DeploymentStep{
		Name:        "Rulebricks Application",
		Type:        "helm",
		Description: "Deploy Rulebricks application and services",
		Required:    true,
	})

	// Step 6: Logging Stack (mandatory) - must be after Kafka
	// Deploy Vector to consume from Kafka
	plan.Steps = append(plan.Steps, DeploymentStep{
		Name:        "Logging Stack",
		Type:        "helm",
		Description: "Deploy Vector for log aggregation",
		Required:    true,
	})

	// Step 7: Monitoring Stack (optional)
	if p.config.Monitoring.Enabled {
		plan.Steps = append(plan.Steps, DeploymentStep{
			Name:        "Monitoring Stack",
			Type:        "helm",
			Description: "Deploy Prometheus and Grafana monitoring",
			Required:    false,
		})
	}

	// Step 8: DNS Configuration
	plan.Steps = append(plan.Steps, DeploymentStep{
		Name:        "DNS Setup",
		Type:        "script",
		Description: "Verify DNS configuration",
		Required:    true,
	})

	// Step 9: TLS Certificates
	plan.Steps = append(plan.Steps, DeploymentStep{
		Name:        "TLS Certificates",
		Type:        "script",
		Description: "Obtain Let's Encrypt certificates",
		Required:    true,
	})

	return plan
}

// Deployer executes deployment plans
type Deployer struct {
	config            *Config
	plan              DeploymentPlan
	Verbose           bool
	workDir           string
	terraformDir      string
	secrets           map[string]string
	state             *DeploymentState
	cloudOps          *CloudOperations
	supabaseOps       *SupabaseOperations
	sharedSecrets     SharedSecrets
	chartManager      *ChartManager
	chartVersion      string
	extractedChartPath string
}

// NewDeployer creates a new deployer
func NewDeployer(config Config, plan DeploymentPlan, chartVersion string, verbose bool) (*Deployer, error) {
	workDir, _ := os.Getwd()

	// Initialize chart manager
	chartManager, err := NewChartManager("", false)
	if err != nil {
		return nil, fmt.Errorf("failed to initialize chart manager: %w", err)
	}

	d := &Deployer{
		config:        &config,
		plan:          plan,
		Verbose:       verbose,
		workDir:       workDir,
		secrets:       make(map[string]string),
		state: &DeploymentState{
			ProjectName: config.Project.Name,
			Version:     chartVersion,
			CreatedAt:   time.Now(),
		},
		sharedSecrets: SharedSecrets{},
		chartManager:  chartManager,
		chartVersion:  chartVersion,
	}

	// Initialize monitoring state based on configuration
	if !config.Monitoring.Enabled {
		d.state.Monitoring = MonitoringState{
			Enabled:  false,
			Provider: "",
		}
	}

	// Initialize operations handlers
	d.cloudOps = NewCloudOperations(config, d.Verbose)
	d.supabaseOps = NewSupabaseOperations(config, d.Verbose, chartVersion)

	return d, nil
}

// Execute runs the deployment
func (d *Deployer) Execute() error {
	// Pre-flight checks
	if err := d.preflight(); err != nil {
		return fmt.Errorf("preflight checks failed: %w", err)
	}

	// Load secrets
	if err := d.loadSecrets(); err != nil {
		return fmt.Errorf("failed to load secrets: %w", err)
	}

	// Extract chart for use throughout deployment
	chartInfo, err := d.chartManager.PullChart(d.chartVersion)
	if err != nil {
		return fmt.Errorf("failed to get chart: %w", err)
	}
	d.extractedChartPath = chartInfo.CachedPath

	// Update state with actual resolved version
	d.state.Version = chartInfo.Version

	extractedPath, err := d.chartManager.ExtractChart(chartInfo.CachedPath)
	if err != nil {
		return fmt.Errorf("failed to extract chart: %w", err)
	}
	d.extractedChartPath = extractedPath
	defer os.RemoveAll(extractedPath)

	// Execute each step
	completedSteps := []int{}

	for i, step := range d.plan.Steps {
		color.Cyan("\n▶️  Step %d/%d: %s\n", i+1, len(d.plan.Steps), step.Name)

		startTime := time.Now()
		err := d.executeStep(step)
		duration := time.Since(startTime)

		if err != nil {
			if step.Required {
				color.Red("❌ Step failed after %s: %v\n", duration, err)

				// Rollback completed steps
				if len(completedSteps) > 0 {
					color.Yellow("\n🔄 Rolling back completed steps...\n")
					d.rollback(completedSteps)
				}

				return fmt.Errorf("deployment failed at step '%s': %w", step.Name, err)
			} else {
				color.Yellow("⚠️  Optional step failed after %s: %v\n", duration, err)
				color.Yellow("   Continuing with deployment...\n")
			}
		} else {
			color.Green("✅ Completed in %s\n", duration)
			completedSteps = append(completedSteps, i)
		}
	}

	return nil
}

// preflight performs pre-deployment checks
func (d *Deployer) preflight() error {
	checks := []struct {
		name    string
		command string
		args    []string
		version string
	}{
		{"kubectl", "kubectl", []string{"version", "--client"}, ""},
		{"helm", "helm", []string{"version", "--short"}, ""},
		{"terraform", "terraform", []string{"version", "-json"}, ""},
	}

	if d.config.Database.Type == "managed" {
		checks = append(checks, struct {
			name    string
			command string
			args    []string
			version string
		}{"supabase", "supabase", []string{"--version"}, ""})
	}

	fmt.Println("🔍 Running preflight checks...")

	for _, check := range checks {
		cmd := exec.Command(check.command, check.args...)
		output, err := cmd.Output()
		if err != nil {
			return fmt.Errorf("%s not found or not working properly", check.name)
		}

		version := strings.TrimSpace(string(output))
		fmt.Printf("  ✓ %s: %s\n", check.name, version)
	}

	// Check cloud provider credentials
	switch d.config.Cloud.Provider {
	case "aws":
		if err := d.checkAWSCredentials(); err != nil {
			return err
		}
	case "azure":
		if err := d.checkAzureCredentials(); err != nil {
			return err
		}
	case "gcp":
		if err := d.checkGCPCredentials(); err != nil {
			return err
		}
	}

	return nil
}

// loadSecrets loads sensitive information from various sources
func (d *Deployer) loadSecrets() error {
	// License key
	licenseKey, err := resolveSecretValue(d.config.Project.License)
	if err != nil {
		return fmt.Errorf("failed to load license key: %w", err)
	}
	d.secrets["license_key"] = licenseKey
	d.sharedSecrets.LicenseKey = licenseKey

	// Database password (if external)
	if d.config.Database.Type == "external" {
		password, err := resolveSecretValue(d.config.Database.External.PasswordFrom)
		if err != nil {
			return fmt.Errorf("failed to load database password: %w", err)
		}
		d.secrets["db_password"] = password
		d.sharedSecrets.DBPassword = password
	}

	// Email credentials
	switch d.config.Email.Provider {
	case "smtp":
		password, err := resolveSecretValue(d.config.Email.SMTP.PasswordFrom)
		if err != nil {
			return fmt.Errorf("failed to load SMTP password: %w", err)
		}
		d.secrets["smtp_password"] = password
		d.sharedSecrets.SMTPPassword = password

	case "resend", "sendgrid", "ses":
		apiKey, err := resolveSecretValue(d.config.Email.APIKey)
		if err != nil {
			return fmt.Errorf("failed to load email API key: %w", err)
		}
		d.secrets["email_api_key"] = apiKey
		d.sharedSecrets.EmailAPIKey = apiKey
	}

	// AI credentials
	if d.config.AI.Enabled && d.config.AI.OpenAIAPIKeyFrom != "" {
		apiKey, err := resolveSecretValue(d.config.AI.OpenAIAPIKeyFrom)
		if err != nil {
			return fmt.Errorf("failed to load OpenAI API key: %w", err)
		}
		d.secrets["openai_api_key"] = apiKey
	}

	// Logging credentials
	// Logging is now mandatory with Vector + Kafka
	// BetterStack/Logtail support has been removed

	// Pass secrets to operations handlers
	d.supabaseOps.secrets = d.secrets
	d.supabaseOps.sharedSecrets = &d.sharedSecrets

	return nil
}

// executeStep executes a single deployment step
func (d *Deployer) executeStep(step DeploymentStep) error {
	switch step.Type {
	case "terraform":
		return d.executeTerraform()
	case "helm":
		return d.executeHelm(step.Name)
	case "script":
		return d.executeScript(step.Name)
	default:
		return fmt.Errorf("unknown step type: %s", step.Type)
	}
}

// executeTerraform runs Terraform deployment
func (d *Deployer) executeTerraform() error {
	// Configure terraform backend if specified
	if err := d.cloudOps.ConfigureTerraformBackend(); err != nil {
		return fmt.Errorf("failed to configure terraform backend: %w", err)
	}

	// Setup the cluster using cloud operations
	if err := d.cloudOps.SetupCluster(); err != nil {
		return fmt.Errorf("failed to setup cluster: %w", err)
	}

	// Wait for cluster to be ready
	if err := d.cloudOps.WaitForClusterReady(5 * time.Minute); err != nil {
		return fmt.Errorf("cluster not ready: %w", err)
	}

	// Get cluster info for state
	clusterInfo, err := d.cloudOps.GetClusterInfo()
	if err != nil {
		return fmt.Errorf("failed to get cluster info: %w", err)
	}

	// Save state
	d.state.Infrastructure = InfrastructureState{
		Provider:        d.config.Cloud.Provider,
		Region:          d.config.Cloud.Region,
		ClusterName:     clusterInfo["cluster_name"],
		ClusterEndpoint: clusterInfo["cluster_endpoint"],
		NodeCount:       d.config.Kubernetes.NodeCount,
		CreatedAt:       time.Now(),
	}

	return nil
}



// executeHelm executes Helm deployments
func (d *Deployer) executeHelm(stepName string) error {
	switch stepName {
	case "Core Services":
		return d.deployCoreServices()
	case "Supabase":
		return d.deploySelfHostedSupabase()
	case "Rulebricks Application":
		return d.deployRulebricksApp()
	case "Monitoring Stack":
		return d.deployMonitoring()
	case "Kafka":
		return d.deployKafka()
	case "Logging Stack":
		return d.deployVector()
	default:
		return fmt.Errorf("unknown helm deployment: %s", stepName)
	}
}

// deployCoreServices installs Traefik and other core services
func (d *Deployer) deployCoreServices() error {
	// Add Traefik repo
	fmt.Println("📦 Adding Helm repositories...")
	cmd := exec.Command("helm", "repo", "add", "traefik", "https://helm.traefik.io/traefik", "--force-update")
	if d.Verbose {
		cmd.Stdout = os.Stdout
		cmd.Stderr = os.Stderr
	}
	if err := cmd.Run(); err != nil {
		return fmt.Errorf("failed to add Traefik helm repository: %w", err)
	}

	cmd = exec.Command("helm", "repo", "update")
	if err := cmd.Run(); err != nil {
		return err
	}

	// Install Traefik with initial configuration (no TLS yet)
	fmt.Println("⚓ Installing Traefik ingress controller (without TLS initially)...")

	// Create traefik namespace
	traefikNamespace := d.getNamespace("traefik")
	cmd = exec.Command("kubectl", "create", "namespace", traefikNamespace, "--dry-run=client", "-o", "yaml")
	output, _ := cmd.Output()
	cmd = exec.Command("kubectl", "apply", "-f", "-")
	cmd.Stdin = strings.NewReader(string(output))
	if err := cmd.Run(); err != nil {
		return fmt.Errorf("failed to create traefik namespace %s: %w", traefikNamespace, err)
	}

	// Find the traefik values file in the extracted chart
	traefikValuesPath := filepath.Join(d.extractedChartPath, "rulebricks", "traefik-values-no-tls.yaml")

	// First install Traefik WITHOUT TLS configuration
	cmd = exec.Command("helm", "upgrade", "--install", "traefik", "traefik/traefik",
		"--namespace", traefikNamespace,
		"-f", traefikValuesPath,
		"--wait")

	if d.Verbose {
		cmd.Stdout = os.Stdout
		cmd.Stderr = os.Stderr
	}

	if err := cmd.Run(); err != nil {
		return fmt.Errorf("failed to install Traefik: %w", err)
	}

	// Wait for Traefik to be ready
	fmt.Println("⏳ Waiting for Traefik to be ready...")
	cmd = exec.Command("kubectl", "wait", "--for=condition=ready", "pod",
		"-l", "app.kubernetes.io/name=traefik",
		"-n", traefikNamespace,
		"--timeout=300s")

	if err := cmd.Run(); err != nil {
		return fmt.Errorf("traefik pod failed to become ready: %w", err)
	}

	// Install metrics server for autoscaling
	fmt.Println("📊 Installing metrics server...")
	cmd = exec.Command("kubectl", "apply", "-f",
		"https://github.com/kubernetes-sigs/metrics-server/releases/latest/download/components.yaml")
	if err := cmd.Run(); err != nil {
		// Non-fatal, just warn
		color.Yellow("⚠️  Failed to install metrics server: %v\n", err)
	}

	// Install KEDA for autoscaling
	fmt.Println("📈 Installing KEDA for worker autoscaling...")

	// Add KEDA Helm repository
	cmd = exec.Command("helm", "repo", "add", "kedacore", "https://kedacore.github.io/charts", "--force-update")
	if d.Verbose {
		cmd.Stdout = os.Stdout
		cmd.Stderr = os.Stderr
	}
	if err := cmd.Run(); err != nil {
		return fmt.Errorf("failed to add KEDA helm repository: %w", err)
	}

	cmd = exec.Command("helm", "repo", "update")
	if err := cmd.Run(); err != nil {
		return err
	}

	// Create keda namespace
	kedaNamespace := "keda"
	cmd = exec.Command("kubectl", "create", "namespace", kedaNamespace, "--dry-run=client", "-o", "yaml")
	output, _ = cmd.Output()
	cmd = exec.Command("kubectl", "apply", "-f", "-")
	cmd.Stdin = strings.NewReader(string(output))
	if err := cmd.Run(); err != nil {
		return fmt.Errorf("failed to create keda namespace: %w", err)
	}

	// Install KEDA
	cmd = exec.Command("helm", "upgrade", "--install", "keda", "kedacore/keda",
		"--namespace", kedaNamespace,
		"--wait")

	if d.Verbose {
		cmd.Stdout = os.Stdout
		cmd.Stderr = os.Stderr
	}

	if err := cmd.Run(); err != nil {
		return fmt.Errorf("failed to install KEDA: %w", err)
	}

	// Wait for KEDA to be ready
	fmt.Println("⏳ Waiting for KEDA to be ready...")
	cmd = exec.Command("kubectl", "wait", "--for=condition=ready", "pod",
		"-l", "app.kubernetes.io/name=keda-operator",
		"-n", kedaNamespace,
		"--timeout=300s")

	if err := cmd.Run(); err != nil {
		return fmt.Errorf("KEDA operator pod failed to become ready: %w", err)
	}

	return nil
}

// deploySelfHostedSupabase deploys Supabase in Kubernetes
func (d *Deployer) deploySelfHostedSupabase() error {
	// Deploy Supabase using operations handler
	if err := d.supabaseOps.Deploy(); err != nil {
		return fmt.Errorf("failed to deploy Supabase: %w", err)
	}

	// Update state with deployment info
	d.state.Database = DatabaseState{
		Type:              d.config.Database.Type,
		Provider:          d.config.Database.Provider,
		URL:               GetSupabaseURL(*d.config, d.supabaseOps.projectRef),
		Internal:          fmt.Sprintf("postgresql://postgres:%s@supabase-db.%s.svc.cluster.local:5432/postgres?sslmode=disable", d.supabaseOps.dbPassword, d.getNamespace("supabase")),
		AnonKey:           d.supabaseOps.anonKey,
		ServiceKey:        d.supabaseOps.serviceKey,
		DashboardPassword: d.supabaseOps.dashboardPass,
		DashboardUsername: "supabase",
		DashboardURL:      fmt.Sprintf("https://supabase.%s", d.config.Project.Domain),
		PostgresHost:      fmt.Sprintf("supabase-db.%s.svc.cluster.local", d.getNamespace("supabase")),
		PostgresPort:      5432,
		PostgresDatabase:  "postgres",
		PostgresUsername:  "postgres",
	}

	// Update shared secrets
	d.sharedSecrets.SupabaseAnonKey = d.supabaseOps.anonKey
	d.sharedSecrets.SupabaseServiceKey = d.supabaseOps.serviceKey
	d.sharedSecrets.JWTSecret = d.supabaseOps.jwtSecret
	d.sharedSecrets.DashboardPassword = d.supabaseOps.dashboardPass

	// Display dashboard info for self-hosted
	if d.config.Database.Type == "self-hosted" {
		fmt.Printf("\n📋 Supabase Dashboard: https://supabase.%s\n", d.config.Project.Domain)
		fmt.Printf("   Username: supabase\n")
		fmt.Printf("   Password: %s\n", d.supabaseOps.dashboardPass)
	}

	return nil
}

// deployRulebricksApp deploys the main application
func (d *Deployer) deployRulebricksApp() error {
	fmt.Println("🚀 Deploying Rulebricks application...")

	// Determine database configuration
	var supabaseURL, anonKey, serviceKey string

	switch d.config.Database.Type {
	case "self-hosted":
		supabaseURL = fmt.Sprintf("https://supabase.%s", d.config.Project.Domain)
		anonKey = d.sharedSecrets.SupabaseAnonKey
		serviceKey = d.sharedSecrets.SupabaseServiceKey

	case "managed":
		// Should have been configured in executeScript
		supabaseURL = d.state.Database.URL
		anonKey = d.state.Database.AnonKey
		serviceKey = d.state.Database.ServiceKey

	case "external":
		// For external PostgreSQL, we need to set up PostgREST separately
		// This is a simplified version
		supabaseURL = "http://postgrest:3000"
		// Would need to deploy PostgREST and generate keys
	}

	// Create Rulebricks values
	rulebricksValues := map[string]interface{}{
		"app": map[string]interface{}{
			"tlsEnabled": true,
			"email": d.config.Project.Email,
			"licenseKey": d.secrets["license_key"],
			"nextPublicSelfHosted": "1",
			"supabaseUrl": supabaseURL,
			"supabaseAnonKey": anonKey,
			"supabaseServiceKey": serviceKey,
			"replicas": func() int {
				if d.config.Performance.HPSReplicas > 0 {
					return d.config.Performance.HPSReplicas
				}
				return 2 // Default replicas
			}(),
		},
		"imageCredentials": map[string]interface{}{
			"password": fmt.Sprintf("dckr_pat_%s", d.secrets["license_key"]),
		},
		"ingress": map[string]interface{}{
			"enabled": true,
			"className": "traefik",
			"hosts": []map[string]interface{}{
				{
					"host": d.config.Project.Domain,
					"paths": []map[string]interface{}{
						{
							"path": "/",
							"pathType": "Prefix",
						},
					},
				},
			},
		},
	}

	// Add network security settings if configured
	if len(d.config.Security.Network.AllowedIPs) > 0 {
		rulebricksValues["security"] = map[string]interface{}{
			"network": map[string]interface{}{
				"allowedIPs": d.config.Security.Network.AllowedIPs,
			},
		}
	}

	// Add custom Docker registry configuration if specified
	if d.config.Advanced.DockerRegistry.AppImage != "" {
		if appConfig, ok := rulebricksValues["app"].(map[string]interface{}); ok {
			appConfig["image"] = map[string]interface{}{
				"repository": d.config.Advanced.DockerRegistry.AppImage,
			}
		}
	}

	// Configure HPS
	hpsConfig := map[string]interface{}{
		"enabled": true,
		"autoscaling": map[string]interface{}{
			"enabled": true,
			"minReplicas": func() int {
				if d.config.Performance.HPSReplicas > 0 {
					return d.config.Performance.HPSReplicas
				}
				return 1 // Default min replicas
			}(),
			"maxReplicas": func() int {
				if d.config.Performance.HPSMaxReplicas > 0 {
					return d.config.Performance.HPSMaxReplicas
				}
				return 6 // Default max replicas
			}(),
			"targetCPUUtilizationPercentage": 50,
			"targetMemoryUtilizationPercentage": 80,
			"behavior": map[string]interface{}{
				"scaleUp": map[string]interface{}{
					"stabilizationWindowSeconds": func() int {
						if d.config.Performance.ScaleUpStabilization > 0 {
							return d.config.Performance.ScaleUpStabilization
						}
						return 30 // Default: 30 seconds
					}(),
					"policies": []map[string]interface{}{
						{
							"type": "Percent",
							"value": 100,
							"periodSeconds": 10,
						},
					},
				},
				"scaleDown": map[string]interface{}{
					"stabilizationWindowSeconds": func() int {
						if d.config.Performance.ScaleDownStabilization > 0 {
							return d.config.Performance.ScaleDownStabilization
						}
						return 180 // Default: 3 minutes
					}(),
					"policies": []map[string]interface{}{
						{
							"type": "Pods",
							"value": 1,
							"periodSeconds": 5,
						},
					},
				},
			},
		},
	}

	// Set HPS replicas if configured
	if d.config.Performance.HPSReplicas > 0 {
		hpsConfig["replicas"] = d.config.Performance.HPSReplicas
	}

	// Configure workers if performance settings are defined
	if d.config.Performance.HPSWorkerReplicas > 0 {
		hpsConfig["workers"] = map[string]interface{}{
			"enabled": true,
			"replicas": d.config.Performance.HPSWorkerReplicas,
			"topics": "bulk-solve,flows,parallel-solve",
			"keda": map[string]interface{}{
				"enabled": true,
				"minReplicaCount": d.config.Performance.HPSWorkerReplicas,
				"maxReplicaCount": d.config.Performance.HPSWorkerMaxReplicas,
				"lagThreshold": d.config.Performance.KafkaLagThreshold,
				"pollingInterval": d.config.Performance.KedaPollingInterval,
				"cooldownPeriod": d.config.Performance.ScaleDownStabilization,
			},
		}

		// Add worker resources if configured
		if d.config.Performance.WorkerResources.Requests.CPU != "" {
			hpsConfig["workers"].(map[string]interface{})["resources"] = map[string]interface{}{
				"requests": map[string]interface{}{
					"cpu":    d.config.Performance.WorkerResources.Requests.CPU,
					"memory": d.config.Performance.WorkerResources.Requests.Memory,
				},
				"limits": map[string]interface{}{
					"cpu":    d.config.Performance.WorkerResources.Limits.CPU,
					"memory": d.config.Performance.WorkerResources.Limits.Memory,
				},
			}
		}
	} else {
		// Default configuration if not specified
		hpsConfig["workers"] = map[string]interface{}{
			"enabled": true,
			"replicas": 3,
			"topics": "bulk-solve,flows,parallel-solve",
			"keda": map[string]interface{}{
				"enabled": true,
				"minReplicaCount": 3,
				"maxReplicaCount": 50,
				"lagThreshold": 100,
				"pollingInterval": 15,
				"cooldownPeriod": 300,
			},
		}
	}

	// Configure HPS resources if performance settings are defined
	if d.config.Performance.HPSResources.Requests.CPU != "" {
		hpsConfig["resources"] = map[string]interface{}{
			"requests": map[string]interface{}{
				"cpu":    d.config.Performance.HPSResources.Requests.CPU,
				"memory": d.config.Performance.HPSResources.Requests.Memory,
			},
			"limits": map[string]interface{}{
				"cpu":    d.config.Performance.HPSResources.Limits.CPU,
				"memory": d.config.Performance.HPSResources.Limits.Memory,
			},
		}
	}

	// Configure HPS image if custom registry is specified
	if d.config.Advanced.DockerRegistry.HPSImage != "" {
		hpsConfig["image"] = map[string]interface{}{
			"repository": d.config.Advanced.DockerRegistry.HPSImage,
		}
	}

	rulebricksValues["hps"] = hpsConfig

	// Add custom values if specified
	if customApp, ok := d.config.Advanced.CustomValues["app"].(map[string]interface{}); ok {
		for k, v := range customApp {
			rulebricksValues["app"].(map[string]interface{})[k] = v
		}
	}

	// Configure email settings
	emailTemplates := GetDefaultEmailTemplates()

	// Override with custom template URLs if configured
	if d.config.Email.Templates.CustomInviteURL != "" {
		emailTemplates.TemplateInvite = d.config.Email.Templates.CustomInviteURL
	}
	if d.config.Email.Templates.CustomConfirmationURL != "" {
		emailTemplates.TemplateConfirmation = d.config.Email.Templates.CustomConfirmationURL
	}
	if d.config.Email.Templates.CustomRecoveryURL != "" {
		emailTemplates.TemplateRecovery = d.config.Email.Templates.CustomRecoveryURL
	}
	if d.config.Email.Templates.CustomEmailChangeURL != "" {
		emailTemplates.TemplateEmailChange = d.config.Email.Templates.CustomEmailChangeURL
	}

	switch d.config.Email.Provider {
	case "smtp":
		rulebricksValues["app"].(map[string]interface{})["smtp"] = map[string]interface{}{
			"host": d.config.Email.SMTP.Host,
			"port": d.config.Email.SMTP.Port,
			"user": d.config.Email.SMTP.Username,
			"pass": d.secrets["smtp_password"],
			"from": d.config.Email.From,
			"fromName": d.config.Email.FromName,
		}

	case "resend", "sendgrid", "ses":
		rulebricksValues["app"].(map[string]interface{})["emailProvider"] = d.config.Email.Provider
		rulebricksValues["app"].(map[string]interface{})["emailApiKey"] = d.secrets["email_api_key"]
		rulebricksValues["app"].(map[string]interface{})["emailFrom"] = d.config.Email.From
		rulebricksValues["app"].(map[string]interface{})["emailFromName"] = d.config.Email.FromName
	}

	// Add email template configuration
	rulebricksValues["app"].(map[string]interface{})["emailTemplates"] = emailTemplates

	// Configure AI features
	if d.config.AI.Enabled {
		rulebricksValues["app"].(map[string]interface{})["ai"] = map[string]interface{}{
			"enabled": true,
			"openaiApiKey": d.secrets["openai_api_key"],
		}
	}

	// Configure logging with Vector and Kafka (mandatory)
	if d.config.Logging.Enabled {
		// Vector logging with Kafka - use Kafka brokers
		kafkaBrokers := d.state.Application.KafkaBrokers
		if kafkaBrokers == "" {
			// Fallback to internal service if external endpoint not available yet
			kafkaBrokers = fmt.Sprintf("kafka.%s:9092", d.getNamespace("logging"))
		}

		// Map sink types to friendly names
		sinkFriendlyNames := map[string]string{
			"elasticsearch":       "Elasticsearch",
			"datadog_logs":       "Datadog",
			"loki":               "Grafana Loki",
			"aws_s3":             "AWS S3",
			"azure_blob":         "Azure Blob Storage",
			"gcp_cloud_storage":  "Google Cloud Storage",
			"splunk_hec":         "Splunk",
			"new_relic_logs":     "New Relic",
			"http":               "Custom HTTP endpoint",
		}

		loggingDestination := sinkFriendlyNames[d.config.Logging.Vector.Sink.Type]
		if loggingDestination == "" {
			loggingDestination = d.config.Logging.Vector.Sink.Type
		}

		rulebricksValues["app"].(map[string]interface{})["logging"] = map[string]interface{}{
			"enabled": true,
			"kafkaBrokers": kafkaBrokers,
			"kafkaTopic": "logs",
			"loggingDestination": loggingDestination,
		}
	}

	// Create namespace if it doesn't exist
	namespace := d.config.Project.Namespace
	if namespace == "" {
		namespace = d.getNamespace("rulebricks")
	}

	cmd := exec.Command("kubectl", "create", "namespace", namespace)
	cmd.Run() // Ignore error if namespace exists

	valuesFile, err := createTempValuesFile("rulebricks", rulebricksValues)
	if err != nil {
		return err
	}
	defer os.Remove(valuesFile)

	// Get chart if not already retrieved
	chartInfo, err := d.chartManager.PullChart(d.chartVersion)
	if err != nil {
		return fmt.Errorf("failed to get chart: %w", err)
	}

	// Deploy Rulebricks using the packaged chart
	cmd = exec.Command("helm", "upgrade", "--install", "rulebricks", chartInfo.CachedPath,
		"--namespace", namespace,
		"-f", valuesFile,
		"--wait",
		"--timeout", "10m")

	if d.Verbose {
		cmd.Stdout = os.Stdout
		cmd.Stderr = os.Stderr
	}

	if err := cmd.Run(); err != nil {
		return fmt.Errorf("failed to deploy Rulebricks: %w", err)
	}

	d.state.Application = ApplicationState{
		Deployed: true,
		Version:  chartInfo.Version,
		URL:      fmt.Sprintf("https://%s", d.config.Project.Domain),
		Replicas: 2, // Default replicas, could be from config
	}

	return nil
}

// deployMonitoring installs monitoring stack
func (d *Deployer) deployMonitoring() error {
	// Always use Prometheus for monitoring
	return d.deployPrometheus()
}

// deployKafka installs Kafka for log buffering and high-volume request processing
func (d *Deployer) deployKafka() error {
	color.Blue("☕ Deploying Kafka for log buffering and request processing...\n")

	// Add Bitnami Helm repository
	cmd := exec.Command("helm", "repo", "add", "bitnami", "https://charts.bitnami.com/bitnami")
	if err := cmd.Run(); err != nil {
		// Ignore error if repo already exists
	}

	cmd = exec.Command("helm", "repo", "update")
	if err := cmd.Run(); err != nil {
		return fmt.Errorf("failed to update Helm repositories: %w", err)
	}

	// Set default values if not configured
	retentionHours := d.config.Performance.KafkaRetentionHours
	if retentionHours == 0 {
		retentionHours = 24
	}
	partitionCount := d.config.Performance.KafkaPartitions
	if partitionCount == 0 {
		partitionCount = 3
	}
	replicationFactor := d.config.Performance.KafkaReplicationFactor
	if replicationFactor == 0 {
		replicationFactor = 2
	}
	storageSize := d.config.Performance.KafkaStorageSize
	if storageSize == "" {
		storageSize = "50Gi"
	}

	kafkaValues := map[string]interface{}{
		"replicaCount": replicationFactor,
		"persistence": map[string]interface{}{
			"enabled": true,
			"size":    storageSize,
		},
		"logRetentionHours": retentionHours,
		"autoCreateTopicsEnable": true,
		"defaultReplicationFactor": replicationFactor,
		"offsetsTopicReplicationFactor": replicationFactor,
		"numPartitions": partitionCount,
		"service": map[string]interface{}{
			"type": "LoadBalancer",
			"ports": map[string]interface{}{
				"client": 9092,
			},
		},
		"controller": map[string]interface{}{
			"resources": map[string]interface{}{
				"requests": map[string]interface{}{
					"cpu":    "250m",
					"memory": "512Mi",
				},
				"limits": map[string]interface{}{
					"cpu":    "500m",
					"memory": "2Gi",
				},
			},
		},
		"kraft": map[string]interface{}{
			"enabled": true,
		},
		"zookeeper": map[string]interface{}{
			"enabled": false,
		},
		"listeners": map[string]interface{}{
			"client": map[string]interface{}{
				"protocol": "PLAINTEXT",
			},
			"controller": map[string]interface{}{
				"protocol": "PLAINTEXT",
			},
			"interbroker": map[string]interface{}{
				"protocol": "PLAINTEXT",
			},
		},
	}

	valuesFile, err := createTempValuesFile("kafka", kafkaValues)
	if err != nil {
		return err
	}
	defer os.Remove(valuesFile)

	namespace := d.getNamespace("logging")
	cmd = exec.Command("helm", "upgrade", "--install", "kafka",
		"bitnami/kafka",
		"--namespace", namespace,
		"--create-namespace",
		"--values", valuesFile,
		"--wait",
		"--timeout", "10m")

	if d.Verbose {
		cmd.Stdout = os.Stdout
		cmd.Stderr = os.Stderr
	}

	if err := cmd.Run(); err != nil {
		return fmt.Errorf("failed to deploy Kafka: %w", err)
	}

	// Get Kafka service endpoint
	time.Sleep(10 * time.Second) // Wait for service to be ready
	cmd = exec.Command("kubectl", "get", "service", "kafka",
		"-n", namespace,
		"-o", "jsonpath={.status.loadBalancer.ingress[0].hostname}")
	output, err := cmd.Output()
	if err != nil {
		// Try IP if hostname is not available
		cmd = exec.Command("kubectl", "get", "service", "kafka",
			"-n", namespace,
			"-o", "jsonpath={.status.loadBalancer.ingress[0].ip}")
		output, err = cmd.Output()
		if err != nil {
			// Use internal service name as fallback
			d.state.Application.KafkaBrokers = fmt.Sprintf("kafka.%s:9092", namespace)
			color.Yellow("⚠️  Using internal Kafka service (external endpoint not available)\n")
			return nil
		}
	}

	kafkaEndpoint := string(output)
	if kafkaEndpoint != "" {
		d.state.Application.KafkaBrokers = fmt.Sprintf("%s:9092", kafkaEndpoint)
		color.Green("✅ Kafka deployed successfully\n")
		fmt.Printf("   Brokers: %s\n", d.state.Application.KafkaBrokers)
	}

	return nil
}

// deployVector installs Vector for log aggregation
func (d *Deployer) deployVector() error {
	color.Blue("🚀 Deploying Vector logging stack...\n")

	// Add Vector Helm repository
	cmd := exec.Command("helm", "repo", "add", "vector", "https://helm.vector.dev")
	if err := cmd.Run(); err != nil {
		// Ignore error if repo already exists
	}

	cmd = exec.Command("helm", "repo", "update")
	if err := cmd.Run(); err != nil {
		return fmt.Errorf("failed to update Helm repositories: %w", err)
	}

	// Load Vector sink API key if configured
	vectorAPIKey := ""
	if d.config.Logging.Vector.Sink.APIKey != "" {
		key, err := resolveSecretValue(d.config.Logging.Vector.Sink.APIKey)
		if err != nil {
			return fmt.Errorf("failed to load Vector sink API key: %w", err)
		}
		vectorAPIKey = key
	}

	// Create Vector configuration based on sink type with Kafka source
	vectorConfig := d.createVectorConfig(vectorAPIKey)

	// Get Kafka brokers from state or use internal service
	kafkaBrokers := d.state.Application.KafkaBrokers
	if kafkaBrokers == "" {
		kafkaBrokers = fmt.Sprintf("kafka.%s:9092", d.getNamespace("logging"))
	}

	// Update Vector config to use Kafka as source
	vectorConfig["sources"] = map[string]interface{}{
		"kafka": map[string]interface{}{
			"type":               "kafka",
			"bootstrap_servers":  kafkaBrokers,
			"topics":            []string{"logs"},
			"group_id":          "vector-consumers",
			"auto_offset_reset": "latest",
		},
	}

	// Update sinks to use kafka source
	if sinks, ok := vectorConfig["sinks"].(map[string]interface{}); ok {
		for _, sink := range sinks {
			if sinkConfig, ok := sink.(map[string]interface{}); ok {
				sinkConfig["inputs"] = []string{"kafka"}
			}
		}
	}

	// Use project-specific release name to avoid ClusterRole conflicts
	releaseName := fmt.Sprintf("vector-%s", d.config.Project.Name)

	vectorValues := map[string]interface{}{
		"role": "Agent",
		"customConfig": vectorConfig,
		"fullnameOverride": releaseName, // Make all resources project-specific
		"rbac": map[string]interface{}{
			"create": true,
			"serviceAccountName": releaseName, // Project-specific service account
		},
		"service": map[string]interface{}{
			"type": "ClusterIP",  // Internal only, not exposed
			"ports": []map[string]interface{}{
				{
					"port":       9090,
					"targetPort": 9090,
					"protocol":   "TCP",
					"name":       "metrics",  // For Prometheus metrics
				},
			},
		},
		"resources": map[string]interface{}{
			"requests": map[string]interface{}{
				"cpu":    "100m",
				"memory": "256Mi",
			},
			"limits": map[string]interface{}{
				"cpu":    "500m",
				"memory": "512Mi",
			},
		},
	}

	valuesFile, err := createTempValuesFile("vector", vectorValues)
	if err != nil {
		return err
	}
	defer os.Remove(valuesFile)

	namespace := d.getNamespace("logging")
	cmd = exec.Command("helm", "upgrade", "--install", releaseName,
		"vector/vector",
		"--namespace", namespace,
		"--create-namespace",
		"--values", valuesFile,
		"--wait",
		"--timeout", "5m")

	if d.Verbose {
		cmd.Stdout = os.Stdout
		cmd.Stderr = os.Stderr
	}

	if err := cmd.Run(); err != nil {
		return fmt.Errorf("failed to deploy Vector: %w", err)
	}

	color.Green("✅ Vector deployed successfully\n")
	fmt.Printf("   Source: Kafka (%s)\n", kafkaBrokers)
	fmt.Printf("   Sink: %s\n", d.config.Logging.Vector.Sink.Type)

	return nil
}

// createVectorConfig creates Vector configuration based on sink type
func (d *Deployer) createVectorConfig(apiKey string) map[string]interface{} {
	// Note: sources will be overridden in deployVector to use Kafka
	config := map[string]interface{}{
		"sources": map[string]interface{}{},
		"sinks": map[string]interface{}{},
	}

	sinkConfig := map[string]interface{}{
		"type":   d.config.Logging.Vector.Sink.Type,
		"inputs": []string{"kafka"}, // Will consume from Kafka source
	}

	// Configure sink based on type
	switch d.config.Logging.Vector.Sink.Type {
	case "elasticsearch":
		sinkConfig["endpoint"] = d.config.Logging.Vector.Sink.Endpoint
		if apiKey != "" {
			// For Elasticsearch, we'll use basic auth with the API key as password
			authConfig := map[string]interface{}{
				"strategy": "basic",
				"password": apiKey,
			}
			// Use username from config if provided, otherwise default to "elastic"
			if username, ok := d.config.Logging.Vector.Sink.Config["auth_user"]; ok {
				authConfig["user"] = username
			} else {
				authConfig["user"] = "elastic"
			}
			sinkConfig["auth"] = authConfig
		}

	case "datadog_logs":
		sinkConfig["default_api_key"] = apiKey
		if site, ok := d.config.Logging.Vector.Sink.Config["site"]; ok {
			sinkConfig["site"] = site
		}

	case "loki":
		sinkConfig["endpoint"] = d.config.Logging.Vector.Sink.Endpoint
		sinkConfig["encoding"] = map[string]interface{}{
			"codec": "json",
		}

	case "aws_s3":
		if bucket, ok := d.config.Logging.Vector.Sink.Config["bucket"]; ok {
			sinkConfig["bucket"] = bucket
		}
		if region, ok := d.config.Logging.Vector.Sink.Config["region"]; ok {
			sinkConfig["region"] = region
		}

		sinkConfig["compression"] = "gzip"
		sinkConfig["encoding"] = map[string]interface{}{
			"codec": "json",
		}

	case "http":
		sinkConfig["uri"] = d.config.Logging.Vector.Sink.Endpoint
		sinkConfig["encoding"] = map[string]interface{}{
			"codec": "json",
		}
		if authHeader, ok := d.config.Logging.Vector.Sink.Config["auth_header"]; ok {
			sinkConfig["headers"] = map[string]string{
				"Authorization": authHeader,
			}
		}

	case "azure_blob":
		if containerName, ok := d.config.Logging.Vector.Sink.Config["container_name"]; ok {
			sinkConfig["container_name"] = containerName
		}
		if apiKey != "" {
			// Azure Blob can use connection string OR account + key
			sinkConfig["connection_string"] = apiKey
		}
		sinkConfig["compression"] = "gzip"
		sinkConfig["encoding"] = map[string]interface{}{
			"codec": "json",
		}

	case "gcp_cloud_storage":
		if bucket, ok := d.config.Logging.Vector.Sink.Config["bucket"]; ok {
			sinkConfig["bucket"] = bucket
		}
		if credentialsPath, ok := d.config.Logging.Vector.Sink.Config["credentials_path"]; ok {
			sinkConfig["credentials_path"] = credentialsPath
		}
		sinkConfig["compression"] = "gzip"
		sinkConfig["encoding"] = map[string]interface{}{
			"codec": "json",
		}

	case "splunk_hec":
		sinkConfig["endpoint"] = d.config.Logging.Vector.Sink.Endpoint
		sinkConfig["default_token"] = apiKey  // Correct field name for Splunk HEC
		if index, ok := d.config.Logging.Vector.Sink.Config["index"]; ok {
			sinkConfig["index"] = index
		}
		sinkConfig["encoding"] = map[string]interface{}{
			"codec": "json",
		}

	case "new_relic_logs":
		// New Relic doesn't use endpoint field, it's determined by the license key
		sinkConfig["license_key"] = apiKey
		sinkConfig["encoding"] = map[string]interface{}{
			"codec": "json",
		}
		// Set region if specified (EU or US)
		if region, ok := d.config.Logging.Vector.Sink.Config["region"]; ok {
			if region == "EU" {
				sinkConfig["region"] = "eu"
			}
			// US is the default, no need to explicitly set
		}

	default:
		// Generic configuration for other sinks
		if d.config.Logging.Vector.Sink.Endpoint != "" {
			sinkConfig["endpoint"] = d.config.Logging.Vector.Sink.Endpoint
		}
		if apiKey != "" {
			sinkConfig["api_key"] = apiKey
		}
	}

	config["sinks"].(map[string]interface{})["output"] = sinkConfig
	return config
}

// deployPrometheus installs Prometheus stack
func (d *Deployer) deployPrometheus() error {
	fmt.Println("📊 Installing Prometheus monitoring stack...")

	// Add prometheus-community repo
	cmd := exec.Command("helm", "repo", "add", "prometheus-community",
		"https://prometheus-community.github.io/helm-charts")
	if err := cmd.Run(); err != nil {
		return err
	}

	cmd = exec.Command("helm", "repo", "update")
	if err := cmd.Run(); err != nil {
		return err
	}

	// Generate and store Grafana password
	grafanaPassword := generateRandomString(16)

	// Install kube-prometheus-stack
	prometheusValues := map[string]interface{}{
		"prometheus": map[string]interface{}{
			"prometheusSpec": map[string]interface{}{
				"retention": d.config.Monitoring.Metrics.Retention,
				"storageSpec": map[string]interface{}{
					"volumeClaimTemplate": map[string]interface{}{
						"spec": map[string]interface{}{
							"accessModes": []string{"ReadWriteOnce"},
							"resources": map[string]interface{}{
								"requests": map[string]interface{}{
									"storage": "50Gi",
								},
							},
						},
					},
				},
			},
		},
		"grafana": map[string]interface{}{
			"enabled": true,
			"adminPassword": grafanaPassword,
			"ingress": map[string]interface{}{
				"enabled": true,
				"className": "traefik",
				"hosts": []string{
					fmt.Sprintf("grafana.%s", d.config.Project.Domain),
				},
				"annotations": map[string]interface{}{
					"traefik.ingress.kubernetes.io/router.entrypoints": "websecure",
					"traefik.ingress.kubernetes.io/router.tls": "true",
					"traefik.ingress.kubernetes.io/router.tls.certresolver": "le",
				},
				"tls": []map[string]interface{}{
					{
						"hosts": []string{
							fmt.Sprintf("grafana.%s", d.config.Project.Domain),
						},
					},
				},
			},
		},
		"alertmanager": map[string]interface{}{
			"enabled": false,
		},
	}

	valuesFile, err := createTempValuesFile("prometheus", prometheusValues)
	if err != nil {
		return err
	}
	defer os.Remove(valuesFile)

	monitoringNamespace := d.getNamespace("monitoring")
	cmd = exec.Command("helm", "upgrade", "--install", "prometheus",
		"prometheus-community/kube-prometheus-stack",
		"--namespace", monitoringNamespace,
		"--create-namespace",
		"-f", valuesFile,
		"--wait",
		"--timeout", "15m")

	if d.Verbose {
		cmd.Stdout = os.Stdout
		cmd.Stderr = os.Stderr
	}

	if err := cmd.Run(); err != nil {
		return err
	}

	// Update monitoring state
	d.state.Monitoring = MonitoringState{
		Enabled:         true,
		Provider:        "prometheus",
		GrafanaURL:      fmt.Sprintf("https://grafana.%s", d.config.Project.Domain),
		GrafanaUsername: "admin",
		GrafanaPassword: grafanaPassword,
	}

	return nil
}

// executeScript executes custom scripts
func (d *Deployer) executeScript(stepName string) error {
	switch stepName {
	case "Supabase Cloud":
		return d.configureManagedSupabase()
	case "Database Connection":
		return d.validateExternalDatabase()
	case "DNS Setup":
		return d.verifyDNS()
	case "TLS Certificates":
		return d.configureTLS()
	}
	return nil
}

// configureManagedSupabase sets up managed Supabase
func (d *Deployer) configureManagedSupabase() error {
	// Deploy managed Supabase using operations handler
	if err := d.supabaseOps.Deploy(); err != nil {
		return fmt.Errorf("failed to configure managed Supabase: %w", err)
	}

	// Update state with deployment info
	d.state.Database = DatabaseState{
		Type:       "managed",
		Provider:   "supabase",
		URL:        GetSupabaseURL(*d.config, d.supabaseOps.projectRef),
		DashboardURL:      GetSupabaseURL(*d.config, d.supabaseOps.projectRef),
		PostgresHost:      fmt.Sprintf("db.%s.supabase.co", d.supabaseOps.projectRef),
		PostgresPort:      5432,
		PostgresDatabase:  "postgres",
		PostgresUsername:  "postgres",
		AnonKey:    d.supabaseOps.anonKey,
		ServiceKey: d.supabaseOps.serviceKey,
	}

	// Update shared secrets
	d.sharedSecrets.SupabaseAnonKey = d.supabaseOps.anonKey
	d.sharedSecrets.SupabaseServiceKey = d.supabaseOps.serviceKey
	d.sharedSecrets.DBPassword = d.supabaseOps.dbPassword

	return nil
}

// validateExternalDatabase checks external database connection
func (d *Deployer) validateExternalDatabase() error {
	// Deploy Supabase with external database using operations handler
	if err := d.supabaseOps.Deploy(); err != nil {
		return fmt.Errorf("failed to configure Supabase with external database: %w", err)
	}

	// Update state with deployment info
	d.state.Database = DatabaseState{
		Type:              "external",
		Provider:          d.config.Database.Provider,
		URL:               GetSupabaseURL(*d.config, ""),
		Internal:          GetDatabaseURL(*d.config, d.secrets["db_password"]),
		AnonKey:           d.supabaseOps.anonKey,
		ServiceKey:        d.supabaseOps.serviceKey,
		DashboardPassword: d.supabaseOps.dashboardPass,
		DashboardUsername: "supabase",
		DashboardURL:      fmt.Sprintf("https://supabase.%s", d.config.Project.Domain),
		PostgresHost:      d.config.Database.External.Host,
		PostgresPort:      d.config.Database.External.Port,
		PostgresDatabase:  d.config.Database.External.Database,
		PostgresUsername:  d.config.Database.External.Username,
	}

	// Update shared secrets
	d.sharedSecrets.SupabaseAnonKey = d.supabaseOps.anonKey
	d.sharedSecrets.SupabaseServiceKey = d.supabaseOps.serviceKey
	d.sharedSecrets.JWTSecret = d.supabaseOps.jwtSecret

	return nil
}

// verifyDNS checks DNS configuration
func (d *Deployer) verifyDNS() error {
	fmt.Println("🌐 Verifying DNS configuration...")

	// Get load balancer endpoint
	traefikNamespace := d.getNamespace("traefik")
	cmd := exec.Command("kubectl", "get", "svc", "traefik",
		"-n", traefikNamespace,
		"-o", "jsonpath={.status.loadBalancer.ingress[0].hostname}")

	output, err := cmd.Output()
	if err != nil {
		return fmt.Errorf("failed to get load balancer endpoint: %w", err)
	}

	lbEndpoint := strings.TrimSpace(string(output))
	if lbEndpoint == "" {
		// Try IP address
		cmd = exec.Command("kubectl", "get", "svc", "traefik",
			"-n", traefikNamespace,
			"-o", "jsonpath={.status.loadBalancer.ingress[0].ip}")
		output, err = cmd.Output()
		if err != nil {
			return err
		}
		lbEndpoint = strings.TrimSpace(string(output))
	}

	d.state.LoadBalancerEndpoint = lbEndpoint

	// Display DNS requirements
	fmt.Printf("\n📝 Please configure the following DNS records:\n\n")
	fmt.Printf("1. Main application:\n")
	fmt.Printf("   Type:  CNAME\n")
	fmt.Printf("   Name:  %s\n", d.config.Project.Domain)
	fmt.Printf("   Value: %s\n\n", lbEndpoint)

	if d.config.Database.Type == "self-hosted" {
		fmt.Printf("2. Supabase dashboard:\n")
		fmt.Printf("   Type:  CNAME\n")
		fmt.Printf("   Name:  supabase.%s\n", d.config.Project.Domain)
		fmt.Printf("   Value: %s\n\n", lbEndpoint)
	}

	if d.config.Monitoring.Enabled && d.config.Monitoring.Provider == "prometheus" {
		fmt.Printf("3. Grafana dashboard:\n")
		fmt.Printf("   Type:  CNAME\n")
		fmt.Printf("   Name:  grafana.%s\n", d.config.Project.Domain)
		fmt.Printf("   Value: %s\n\n", lbEndpoint)
	}

	// Wait for user confirmation
	if !d.Verbose {
		fmt.Print("\nPress Enter after configuring DNS records...")
		fmt.Scanln()
	}

	// Verify DNS resolution
	fmt.Println("\n🔍 Checking DNS propagation...")

	domains := []string{d.config.Project.Domain}
	if d.config.Database.Type == "self-hosted" {
		domains = append(domains, fmt.Sprintf("supabase.%s", d.config.Project.Domain))
	}
	if d.config.Monitoring.Enabled && d.config.Monitoring.Provider == "prometheus" {
		domains = append(domains, fmt.Sprintf("grafana.%s", d.config.Project.Domain))
	}

	// Wait for DNS propagation with timeout
	maxAttempts := 120 // 10 minutes total (5 second intervals)
	attempt := 0
	allResolved := false
	resolvedDomains := make(map[string]bool)

	fmt.Printf("\n⏳ Waiting for DNS propagation...\n")
	fmt.Printf("   Expected target: %s\n\n", lbEndpoint)

	for attempt < maxAttempts && !allResolved {
		attempt++
		allResolved = true
		pendingCount := 0

		for _, domain := range domains {
			// Skip if already resolved
			if resolvedDomains[domain] {
				continue
			}

			// Check against multiple DNS servers to avoid cache issues
			resolved := false
			dnsServers := []string{"8.8.8.8", "1.1.1.1", ""} // Google, Cloudflare, System default

			for _, dnsServer := range dnsServers {
				var cmd *exec.Cmd
				if dnsServer == "" {
					cmd = exec.Command("nslookup", domain)
				} else {
					cmd = exec.Command("nslookup", domain, dnsServer)
				}

				output, err := cmd.Output()
				if err == nil && strings.Contains(string(output), lbEndpoint) {
					resolved = true
					break
				}
			}

			if resolved {
				resolvedDomains[domain] = true
				color.Green("   ✓ %s resolved successfully\n", domain)
			} else {
				allResolved = false
				pendingCount++
			}
		}

		if allResolved {
			color.Green("\n✅ All DNS records have propagated successfully!\n")
			break
		}

		// Show simple progress on the same line
		elapsed := attempt * 5
		fmt.Printf("\r⏳ Checking DNS... %d/%d domains pending (%ds elapsed)", pendingCount, len(domains), elapsed)

		if attempt < maxAttempts {
			time.Sleep(5 * time.Second)
		}
	}

	if !allResolved {
		fmt.Printf("\n") // Clear the progress line
		color.Yellow("\n⚠️  DNS propagation timeout reached after %d minutes.\n", maxAttempts*5/60)
		fmt.Printf("\n📋 DNS Status:\n")

		for _, domain := range domains {
			if resolvedDomains[domain] {
				color.Green("   ✓ %s → %s\n", domain, lbEndpoint)
			} else {
				// Do a final check to provide specific error
				cmd := exec.Command("nslookup", domain, "8.8.8.8")
				output, err := cmd.Output()
				if err != nil || strings.Contains(string(output), "can't find") || strings.Contains(string(output), "NXDOMAIN") {
					color.Red("   ✗ %s - Not found (DNS record not configured)\n", domain)
				} else if !strings.Contains(string(output), lbEndpoint) {
					color.Yellow("   ⚠ %s - Pointing to wrong target\n", domain)
				} else {
					color.Yellow("   ⚠ %s - Not fully propagated\n", domain)
				}
			}
		}

		if !d.Verbose {
			fmt.Print("\nDo you want to continue anyway? (y/N): ")
			var response string
			fmt.Scanln(&response)
			if response != "y" && response != "Y" {
				return fmt.Errorf("DNS propagation incomplete - deployment cancelled")
			}
		}
	}

	return nil
}

// configureTLS sets up TLS certificates
func (d *Deployer) configureTLS() error {
	fmt.Println("🔒 Configuring TLS certificates...")

	// Use the existing traefik-values-tls.yaml file and override specific values
	if d.Verbose {
		fmt.Println("📋 TLS Configuration:")
		fmt.Printf("   Email: %s\n", d.config.Security.TLS.AcmeEmail)
		fmt.Printf("   Domain: %s\n", d.config.Project.Domain)
		if len(d.config.Security.TLS.Domains) > 0 {
			fmt.Printf("   Additional domains: %v\n", d.config.Security.TLS.Domains)
		}
	}

	traefikNamespace := d.getNamespace("traefik")
	// Create a temporary values file that overrides the ACME configuration
	tlsOverrides := map[string]interface{}{
		"additionalArguments": []string{
			"--api.insecure=false",
			"--api.dashboard=true",
			"--log.level=DEBUG",
			"--accesslog=true",
			"--entrypoints.metrics.address=:9100",
			"--entrypoints.traefik.address=:9000",
			"--entrypoints.web.address=:8000",
			"--entrypoints.websecure.address=:8443",
			"--entrypoints.web.http.redirections.entryPoint.to=websecure",
			"--entrypoints.web.http.redirections.entryPoint.scheme=https",
			fmt.Sprintf("--certificatesresolvers.le.acme.email=%s", d.config.Security.TLS.AcmeEmail),
			"--certificatesresolvers.le.acme.storage=/data/acme.json",
			"--certificatesresolvers.le.acme.tlschallenge=true",
		},
		"ports": map[string]interface{}{
			"websecure": map[string]interface{}{
				"port": 8443,
				"exposedPort": 443,
				"expose": map[string]interface{}{
					"enabled": true,
					"port": 443,
				},
				"tls": map[string]interface{}{
					"enabled": true,
					"certResolver": "le",
					"domains": []map[string]interface{}{
						{
							"main": d.config.Project.Domain,
						},
					},
				},
			},
		},
	}

	// Add SANs if needed
	domains := tlsOverrides["ports"].(map[string]interface{})["websecure"].(map[string]interface{})["tls"].(map[string]interface{})["domains"].([]map[string]interface{})[0]

	var sans []string
	// Add monitoring domain if enabled
	if d.config.Monitoring.Enabled && d.config.Monitoring.Provider == "prometheus" {
		sans = append(sans, fmt.Sprintf("grafana.%s", d.config.Project.Domain))
	}
	// Add Supabase domain if self-hosted
	if d.config.Database.Type == "self-hosted" {
		sans = append(sans, fmt.Sprintf("supabase.%s", d.config.Project.Domain))
	}
	// Add any additional domains from config
	sans = append(sans, d.config.Security.TLS.Domains...)

	if len(sans) > 0 {
		domains["sans"] = sans
	}

	// Create temporary values file
	tlsValuesFile, err := createTempValuesFile("traefik-tls", tlsOverrides)
	if err != nil {
		return fmt.Errorf("failed to create TLS values file: %w", err)
	}
	defer os.Remove(tlsValuesFile)

	args := []string{
		"upgrade", "--install", "traefik", "traefik/traefik",
		"--namespace", traefikNamespace,
		"-f", filepath.Join(d.extractedChartPath, "rulebricks", "traefik-values-tls.yaml"),
		"-f", tlsValuesFile,
		"--wait",
	}



	cmd := exec.Command("helm", args...)

	if d.Verbose {
		fmt.Printf("\n🔧 Running command: helm %s\n\n", strings.Join(args, " "))
		cmd.Stdout = os.Stdout
		cmd.Stderr = os.Stderr
	}

	if err := cmd.Run(); err != nil {
		return fmt.Errorf("failed to configure TLS: %w", err)
	}

	// Ensure rulebricks namespace exists
	rulebricksNamespace := d.getNamespace("rulebricks")
	nsCmd := exec.Command("kubectl", "create", "namespace", rulebricksNamespace, "--dry-run=client", "-o", "yaml")
	nsOutput, _ := nsCmd.Output()
	nsApplyCmd := exec.Command("kubectl", "apply", "-f", "-")
	nsApplyCmd.Stdin = strings.NewReader(string(nsOutput))
	nsApplyCmd.Run()

	// Update or create the config map with the current domain
	configCmd := exec.Command("kubectl", "create", "configmap", "-n", rulebricksNamespace,
		"rulebricks-config", "--from-literal=DOMAIN_NAME="+d.config.Project.Domain,
		"--dry-run=client", "-o", "yaml")
	configOutput, _ := configCmd.Output()
	applyCmd := exec.Command("kubectl", "apply", "-f", "-")
	applyCmd.Stdin = strings.NewReader(string(configOutput))
	applyCmd.Run()

	// Wait for Traefik pod to be ready with new configuration
	fmt.Println("⏳ Waiting for Traefik to reload with TLS configuration...")
	readyCmd := exec.Command("kubectl", "wait", "--for=condition=ready", "pod",
		"-l", "app.kubernetes.io/name=traefik",
		"-n", traefikNamespace,
		"--timeout=300s")

	if d.Verbose {
		readyCmd.Stdout = os.Stdout
		readyCmd.Stderr = os.Stderr
	}

	if err := readyCmd.Run(); err != nil {
		return fmt.Errorf("traefik pod failed to become ready: %w", err)
	}

	// Wait for certificate provisioning
	fmt.Println("⏳ Waiting for Let's Encrypt certificates...")

	// Check certificate status with retries
	maxAttempts := 30  // 5 minutes total
	for i := 0; i < maxAttempts; i++ {
		// Check if certificate is ready by querying traefik
		checkCmd := exec.Command("kubectl", "exec", "-n", traefikNamespace,
			"deployment/traefik", "--",
			"cat", "/data/acme.json")

		output, err := checkCmd.Output()
		if err == nil && len(output) > 100 {  // acme.json should have content
			if d.Verbose {
				fmt.Printf("\n📄 ACME storage file size: %d bytes\n", len(output))
			}
			color.Green("✓ TLS certificate obtained successfully!\n")

			// Verify HTTPS endpoint
			fmt.Printf("🔍 Verifying HTTPS endpoint for %s...\n", d.config.Project.Domain)

			// Give DNS and certificate a moment to propagate
			time.Sleep(10 * time.Second)

			// Verify HTTPS is working
			httpsURL := fmt.Sprintf("https://%s", d.config.Project.Domain)
			client := &http.Client{
				Timeout: 30 * time.Second,
			}

			maxRetries := 6 // 1 minute total
			for i := 0; i < maxRetries; i++ {
				resp, err := client.Get(httpsURL)
				if err == nil {
					resp.Body.Close()
					if resp.TLS != nil && len(resp.TLS.PeerCertificates) > 0 {
						cert := resp.TLS.PeerCertificates[0]
						// Check if certificate is valid for the domain
						if err := cert.VerifyHostname(d.config.Project.Domain); err == nil {
							color.Green("✓ HTTPS endpoint verified successfully!\n")
							return nil
						}
					}
				}

				if i < maxRetries-1 {
					if d.Verbose {
						fmt.Printf("⏳ HTTPS not ready yet, retrying in 10 seconds... (attempt %d/%d)\n", i+1, maxRetries)
						if err != nil {
							fmt.Printf("   Error: %v\n", err)
						}
					}
					time.Sleep(10 * time.Second)
				}
			}

			// If we get here, HTTPS verification failed
			return fmt.Errorf("HTTPS endpoint verification failed for %s - certificate may not be valid", d.config.Project.Domain)
		}

		if i == 0 {
			fmt.Printf("⏳ Waiting for certificate from Let's Encrypt")
		} else if i%6 == 0 {
			fmt.Printf("\n⏳ Still waiting... (%d seconds elapsed)", i*10)
			if d.Verbose {
				// Check traefik logs for any errors
				logsCmd := exec.Command("kubectl", "logs", "-n", traefikNamespace,
					"deployment/traefik", "--tail=20")
				if logsOutput, err := logsCmd.Output(); err == nil {
					fmt.Printf("\n📋 Recent Traefik logs:\n%s\n", string(logsOutput))
				}
			}
		} else {
			fmt.Printf(".")
		}

		time.Sleep(10 * time.Second)
	}

	fmt.Printf("\n")
	if d.Verbose {
		// Get final traefik logs for debugging
		logsCmd := exec.Command("kubectl", "logs", "-n", traefikNamespace,
			"deployment/traefik", "--tail=50")
		if logsOutput, err := logsCmd.Output(); err == nil {
			fmt.Printf("\n❌ TLS configuration failed. Traefik logs:\n%s\n", string(logsOutput))
		}

		// Check traefik pod status
		podCmd := exec.Command("kubectl", "describe", "pod", "-n", traefikNamespace,
			"-l", "app.kubernetes.io/name=traefik")
		if podOutput, err := podCmd.Output(); err == nil {
			fmt.Printf("\n📋 Traefik pod status:\n%s\n", string(podOutput))
		}
	}

	return fmt.Errorf("timeout waiting for TLS certificate after 5 minutes - check if domain is accessible and DNS is properly configured")
}


// rollback reverses completed steps
func (d *Deployer) rollback(completedSteps []int) {
	// Run the destroy command to clean up everything except the cluster
	destroyer := NewDestroyer(*d.config, false)
	if err := destroyer.Execute(); err != nil {
		color.Red("⚠️  Failed to perform soft destroy during rollback: %v\n", err)
		color.Yellow("You may need to manually clean up resources before retrying\n")
	} else {
		color.Green("✅ Soft destroy completed - cluster preserved, ready for retry\n")
	}
}

// SaveState persists deployment state
func (d *Deployer) SaveState() error {
	d.state.UpdatedAt = time.Now()

	data, err := yaml.Marshal(d.state)
	if err != nil {
		return err
	}

	return ioutil.WriteFile(".rulebricks-state.yaml", data, 0644)
}

// getNamespace returns the namespace for a component with project prefix
func (d *Deployer) getNamespace(component string) string {
	return GetDefaultNamespace(d.config.Project.Name, component)
}

// DisplayConnectionInfo shows connection details after deployment
// DisplayConnectionInfo shows how to connect to the deployment
func (d *Deployer) DisplayConnectionInfo() {
	fmt.Println("\n" + strings.Repeat("=", 60))
	color.Green("🎉 Deployment Complete!")
	fmt.Println(strings.Repeat("=", 60))

	fmt.Printf("\n📌 Rulebricks Instance:\n")
	fmt.Printf("   URL: https://%s\n", d.config.Project.Domain)
	fmt.Printf("   Admin Email: %s\n", d.config.Project.Email)

	if d.config.Database.Type == "self-hosted" {
		fmt.Printf("\n📊 Supabase Dashboard:\n")
		fmt.Printf("   URL: https://supabase.%s\n", d.config.Project.Domain)
		fmt.Printf("   Username: supabase\n")
		fmt.Printf("   Password: %s\n", d.state.Database.DashboardPassword)
	}

	if d.config.Monitoring.Enabled && d.config.Monitoring.Provider == "prometheus" {
		fmt.Printf("\n📈 Grafana Dashboard:\n")
		fmt.Printf("   URL: https://grafana.%s\n", d.config.Project.Domain)
		fmt.Printf("   Username: admin\n")
		fmt.Printf("   Password: %s\n", d.state.Monitoring.GrafanaPassword)
	}

	fmt.Printf("\n💾 State saved to: .rulebricks-state.yaml\n")
	fmt.Printf("\n📚 Next steps:\n")
	fmt.Printf("   1. Visit https://%s/auth/signup to create your account\n", d.config.Project.Domain)
	fmt.Printf("   2. Check 'rulebricks status' to monitor your deployment\n")
	fmt.Printf("   3. Use 'rulebricks logs' to view application logs\n")

	if d.config.Email.Provider == "" {
		color.Yellow("\n⚠️  Email not configured. Configure email to enable notifications.\n")
	}

	fmt.Println("\n" + strings.Repeat("=", 60))
}

// Helper functions

func (d *Deployer) checkAWSCredentials() error {
	cmd := exec.Command("aws", "sts", "get-caller-identity")
	output, err := cmd.Output()
	if err != nil {
		return fmt.Errorf("AWS credentials not configured properly")
	}

	var identity struct {
		Account string `json:"Account"`
		Arn     string `json:"Arn"`
	}

	if err := json.Unmarshal(output, &identity); err != nil {
		return err
	}

	fmt.Printf("  ✓ AWS: Authenticated as %s\n", identity.Arn)
	return nil
}

func (d *Deployer) checkAzureCredentials() error {
	cmd := exec.Command("az", "account", "show")
	if err := cmd.Run(); err != nil {
		return fmt.Errorf("Azure CLI not authenticated. Run 'az login' first")
	}

	fmt.Printf("  ✓ Azure: Authenticated\n")
	return nil
}

func (d *Deployer) checkGCPCredentials() error {
	cmd := exec.Command("gcloud", "auth", "list", "--filter=status:ACTIVE", "--format=json")
	output, err := cmd.Output()
	if err != nil {
		return fmt.Errorf("GCP credentials not configured. Run 'gcloud auth login' first")
	}

	var accounts []map[string]interface{}
	if err := json.Unmarshal(output, &accounts); err != nil {
		return err
	}

	if len(accounts) == 0 {
		return fmt.Errorf("no active GCP account found")
	}

	fmt.Printf("  ✓ GCP: Authenticated as %s\n", accounts[0]["account"])
	return nil
}

// State management structures

type DeploymentState struct {
	ProjectName          string               `yaml:"project_name"`
	Version              string               `yaml:"version"`
	CreatedAt            time.Time            `yaml:"created_at"`
	UpdatedAt            time.Time            `yaml:"updated_at"`
	Infrastructure       InfrastructureState  `yaml:"infrastructure"`
	Database             DatabaseState        `yaml:"database"`
	Application          ApplicationState     `yaml:"application"`
	Monitoring           MonitoringState      `yaml:"monitoring"`
	LoadBalancerEndpoint string               `yaml:"load_balancer_endpoint"`
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
	Type              string `yaml:"type"`
	Provider          string `yaml:"provider"`
	URL               string `yaml:"url"`
	Internal          string `yaml:"internal,omitempty"`
	AnonKey           string `yaml:"anon_key,omitempty"`
	ServiceKey        string `yaml:"service_key,omitempty"`
	DashboardPassword string `yaml:"dashboard_password,omitempty"`
	DashboardUsername string `yaml:"dashboard_username,omitempty"`
	DashboardURL      string `yaml:"dashboard_url,omitempty"`
	PostgresHost      string `yaml:"postgres_host,omitempty"`
	PostgresPort      int    `yaml:"postgres_port,omitempty"`
	PostgresDatabase  string `yaml:"postgres_database,omitempty"`
	PostgresUsername  string `yaml:"postgres_username,omitempty"`
}

type ApplicationState struct {
	Deployed       bool   `yaml:"deployed"`
	Version        string `yaml:"version"`
	URL            string `yaml:"url"`
	Replicas       int    `yaml:"replicas"`
	VectorEndpoint string `yaml:"vector_endpoint,omitempty"` // Deprecated, kept for backward compatibility
	KafkaBrokers   string `yaml:"kafka_brokers,omitempty"`
}

type MonitoringState struct {
	Enabled         bool   `yaml:"enabled"`
	Provider        string `yaml:"provider"`
	GrafanaURL      string `yaml:"grafana_url,omitempty"`
	GrafanaUsername string `yaml:"grafana_username,omitempty"`
	GrafanaPassword string `yaml:"grafana_password,omitempty"`
}
