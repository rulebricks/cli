package main

import (
	"bufio"
	"fmt"
	"os"
	"strings"
	"syscall"

	"github.com/fatih/color"
	"golang.org/x/term"
)

// InitWizard handles the interactive project initialization
type InitWizard struct {
	nonInteractive bool
	scanner        *bufio.Scanner
	config         *Config
}

// NewInitWizard creates a new initialization wizard
func NewInitWizard(nonInteractive bool) *InitWizard {
	return &InitWizard{
		nonInteractive: nonInteractive,
		scanner:        bufio.NewScanner(os.Stdin),
		config:         &Config{Version: version},
	}
}

// Run executes the initialization wizard
func (w *InitWizard) Run() error {
	if w.nonInteractive {
		return fmt.Errorf("non-interactive mode requires a configuration file")
	}

	// Display welcome message
	w.displayWelcome()

	// Check if config already exists
	if fileExists("rulebricks.yaml") {
		if !w.confirm("A configuration file already exists. Overwrite?", false) {
			return fmt.Errorf("initialization cancelled")
		}
	}

	// Run through configuration steps
	if err := w.configureProject(); err != nil {
		return err
	}

	if err := w.configureCloud(); err != nil {
		return err
	}

	if err := w.configureDatabase(); err != nil {
		return err
	}

	if err := w.configureEmail(); err != nil {
		return err
	}

	if err := w.configureSecurity(); err != nil {
		return err
	}

	if err := w.configureOptionalFeatures(); err != nil {
		return err
	}

	// Apply defaults
	w.config.ApplyDefaults()

	// Validate configuration
	if err := w.config.Validate(); err != nil {
		return fmt.Errorf("configuration validation failed: %w", err)
	}

	// Display summary
	w.displaySummary()

	// Confirm before saving
	if !w.confirm("Save this configuration?", true) {
		return fmt.Errorf("initialization cancelled")
	}

	// Save configuration
	if err := SaveConfig(w.config, "rulebricks.yaml"); err != nil {
		return fmt.Errorf("failed to save configuration: %w", err)
	}

	// Display next steps
	w.displayNextSteps()

	return nil
}

// Configuration steps

func (w *InitWizard) configureProject() error {
	color.New(color.Bold).Println("\n🚀 Project Configuration")

	// Project name
	w.config.Project.Name = w.promptString("Project name", "rulebricks", func(s string) error {
		if !isValidKubernetesName(sanitizeProjectName(s)) {
			return fmt.Errorf("project name must be lowercase alphanumeric or '-'")
		}
		return nil
	})
	w.config.Project.Name = sanitizeProjectName(w.config.Project.Name)

	// Domain
	fmt.Printf("Your application will be accessible at: %s.<root-domain> (You'll need DNS access)\n", w.config.Project.Name)
	rootDomain := w.promptString("Root domain", "example.com", func(s string) error {
		if !isValidDomain(s) {
			return fmt.Errorf("invalid domain format - please enter just the root domain (e.g., example.com)")
		}
		return nil
	})

	// Prepend project name to create full domain
	w.config.Project.Domain = fmt.Sprintf("%s.%s", w.config.Project.Name, rootDomain)

	// Email
	w.config.Project.Email = w.promptString("Admin email", "", validateEmail)

	// License key (collected here for future license validation during deployment)
	w.config.Project.License = w.promptPassword("Rulebricks license key")

	// Fetch the latest version to use as default
	fmt.Println("Fetching available Rulebricks versions...")
	latestVersion := "1.0.0" // fallback default

	// Create a chart manager to fetch versions
	chartManager, err := NewChartManager("", false)
	if err == nil {
		if releaseInfo, err := chartManager.GetLatestReleaseInfo(); err == nil {
			latestVersion = releaseInfo.Version
			if releaseInfo.ReleaseDate != "" {
				color.Green("✓ Latest version: %s (released %s)", latestVersion, releaseInfo.ReleaseDate)
			} else {
				color.Green("✓ Latest version: %s", latestVersion)
			}
		} else {
			color.Yellow("⚠️  Could not fetch latest version, using fallback: %s", latestVersion)
		}
	} else {
		color.Yellow("⚠️  Could not initialize version fetcher, using fallback: %s", latestVersion)
	}

	// Project version (Rulebricks application version) - always explicit
	fmt.Println("\nNote: Explicit version selection ensures reproducible deployments")
	w.config.Project.Version = w.promptString("Rulebricks version to deploy", latestVersion, nil)

	return nil
}

func (w *InitWizard) configureCloud() error {
	color.New(color.Bold).Println("\n☁️  Cloud Provider Configuration")

	// Cloud provider selection
	providers := []string{"aws", "azure", "gcp"}
	w.config.Cloud.Provider = w.promptChoice("Cloud provider", providers, "aws")

	// Configure provider-specific settings
	switch w.config.Cloud.Provider {
	case "aws":
		return w.configureAWS()
	case "azure":
		return w.configureAzure()
	case "gcp":
		return w.configureGCP()
	}

	return nil
}

func (w *InitWizard) configureAWS() error {
	w.config.Cloud.AWS = &AWSConfig{}

	// Region
	awsRegions := CloudProviderRegions["aws"]
	w.config.Cloud.Region = w.promptChoice("AWS region", awsRegions, "us-east-1")

	// Instance type
	w.config.Cloud.AWS.InstanceType = w.promptString("EC2 instance type", DefaultInstanceTypes["aws"], nil)

	// VPC CIDR
	w.config.Cloud.AWS.VPCCidr = w.promptString("VPC CIDR", "10.0.0.0/16", nil)

	// Kubernetes configuration
	w.configureKubernetes()

	return nil
}

func (w *InitWizard) configureAzure() error {
	w.config.Cloud.Azure = &AzureConfig{}

	// Region
	azureRegions := CloudProviderRegions["azure"]
	w.config.Cloud.Region = w.promptChoice("Azure region", azureRegions, "eastus")

	// Resource group
	w.config.Cloud.Azure.ResourceGroup = w.promptString("Resource group name", fmt.Sprintf("%s-rg", w.config.Project.Name), nil)

	// VM size
	w.config.Cloud.Azure.VMSize = w.promptString("VM size", DefaultInstanceTypes["azure"], nil)

	// Kubernetes configuration
	w.configureKubernetes()

	return nil
}

func (w *InitWizard) configureGCP() error {
	w.config.Cloud.GCP = &GCPConfig{}

	// Project ID
	w.config.Cloud.GCP.ProjectID = w.promptString("GCP project ID", "", func(s string) error {
		if s == "" {
			return fmt.Errorf("GCP project ID is required")
		}
		return nil
	})

	// Region
	gcpRegions := CloudProviderRegions["gcp"]
	w.config.Cloud.Region = w.promptChoice("GCP region", gcpRegions, "us-central1")

	// Zone
	w.config.Cloud.GCP.Zone = fmt.Sprintf("%s-a", w.config.Cloud.Region)

	// Machine type
	w.config.Cloud.GCP.MachineType = w.promptString("Machine type", DefaultInstanceTypes["gcp"], nil)

	// Kubernetes configuration
	w.configureKubernetes()

	return nil
}

func (w *InitWizard) configureKubernetes() {
	w.config.Kubernetes.ClusterName = w.promptString("Kubernetes cluster name",
		DefaultClusterName, nil)

	// Autoscaling is always enabled, node counts will be set based on performance tier
	w.config.Kubernetes.EnableAutoscale = true
}

func (w *InitWizard) configureDatabase() error {
	color.New(color.Bold).Println("\n🗄️  Database Configuration")

	// Database type
	dbTypes := []string{"self-hosted", "managed"}
	w.config.Database.Type = w.promptChoice("Database type", dbTypes, "self-hosted")

	switch w.config.Database.Type {
	case "managed":
		w.config.Database.Supabase = &SupabaseConfig{}
		w.config.Database.Supabase.ProjectName = w.promptString("Supabase project name", w.config.Project.Name, nil)

		// Show available regions
		fmt.Println("\nAvailable Supabase regions:")
		for _, region := range SupabaseRegions {
			fmt.Printf("  • %s (%s)\n", region.Name, region.Region)
		}

		w.config.Database.Supabase.Region = w.promptString("Supabase region", "us-east-1", nil)
		w.config.Database.Supabase.OrgID = w.promptString("Organization ID (optional)", "", nil)

	case "self-hosted":
		// Self-hosted uses defaults
		color.Green("✓ Self-hosted Supabase will be deployed with the cluster")
	}

	// Connection pooling (enabled for self-hosted databases)
	if w.config.Database.Type == "self-hosted" {
		w.config.Database.Pooling = &PoolingConfig{
			Enabled: true,
			MinSize: 10,
			MaxSize: 500,
		}
	}

	return nil
}

func (w *InitWizard) configureEmail() error {
	color.New(color.Bold).Println("\n📧 Email Configuration")

	// Email provider (for defaults only, not stored in config)
	providers := []string{"SendGrid", "Mailgun", "AWS SES", "Resend", "Other (Custom SMTP)"}
	emailProvider := w.promptChoice("Email provider", providers, "SendGrid")

	// Common settings
	// Extract root domain from project domain (projectname.rootdomain -> rootdomain)
	rootDomain := w.config.Project.Domain
	if idx := strings.Index(rootDomain, "."); idx != -1 {
		rootDomain = rootDomain[idx+1:]
	}
	w.config.Email.From = w.promptString("From email", fmt.Sprintf("noreply@%s", rootDomain), validateEmail)
	w.config.Email.FromName = w.promptString("From name", "Rulebricks", nil)

	// Provider-specific settings - all providers use SMTP
	w.config.Email.SMTP = &SMTPConfig{}

	switch emailProvider {
	case "Other (Custom SMTP)":
		fmt.Println("\nCustom SMTP configuration:")
		w.config.Email.SMTP.Host = w.promptString("SMTP host", "", nil)
		w.config.Email.SMTP.Port = w.promptInt("SMTP port", 587, 1, 65535)
		w.config.Email.SMTP.Username = w.promptString("SMTP username", "", nil)
		w.config.Email.SMTP.PasswordFrom = w.promptString("Password source", "env:SMTP_PASSWORD", nil)
		w.config.Email.SMTP.Encryption = w.promptChoice("Encryption", []string{"starttls", "ssl", "none"}, "starttls")
		w.config.Email.SMTP.AdminEmail = w.promptString("Admin email (optional)", "", nil)

	case "SendGrid":
		fmt.Println("\nSendGrid SMTP configuration:")
		fmt.Println("Note: Use your SendGrid API key as the password")
		fmt.Println("The username is always 'apikey' for SendGrid")
		w.config.Email.SMTP.Host = "smtp.sendgrid.net"
		w.config.Email.SMTP.Port = 587
		w.config.Email.SMTP.Username = "apikey"
		w.config.Email.SMTP.PasswordFrom = w.promptString("SendGrid API key source", "env:SENDGRID_API_KEY", nil)
		w.config.Email.SMTP.Encryption = "starttls"
		w.config.Email.SMTP.AdminEmail = w.config.Email.From

	case "Mailgun":
		fmt.Println("\nMailgun SMTP configuration:")
		fmt.Println("Note: Find your SMTP credentials in Mailgun Dashboard > Domain Settings > SMTP credentials")
		fmt.Println("Username format is typically: postmaster@your-domain.mailgun.org")
		w.config.Email.SMTP.Host = "smtp.mailgun.org"
		w.config.Email.SMTP.Port = 587
		w.config.Email.SMTP.Username = w.promptString("Mailgun SMTP username", "", nil)
		w.config.Email.SMTP.PasswordFrom = w.promptString("Mailgun SMTP password source", "env:MAILGUN_SMTP_PASSWORD", nil)
		w.config.Email.SMTP.Encryption = "starttls"
		w.config.Email.SMTP.AdminEmail = w.config.Email.From

	case "AWS SES":
		fmt.Println("\nAWS SES SMTP configuration:")
		fmt.Println("Note: Create SMTP credentials in AWS Console > SES > SMTP Settings > Create SMTP credentials")
		fmt.Println("These are different from your AWS access keys!")
		region := w.config.Cloud.Region
		if region == "" {
			region = w.promptString("AWS region for SES", "us-east-1", nil)
		}
		w.config.Email.SMTP.Host = fmt.Sprintf("email-smtp.%s.amazonaws.com", region)
		w.config.Email.SMTP.Port = 587
		w.config.Email.SMTP.Username = w.promptString("SES SMTP username", "", nil)
		w.config.Email.SMTP.PasswordFrom = w.promptString("SES SMTP password source", "env:SES_SMTP_PASSWORD", nil)
		w.config.Email.SMTP.Encryption = "starttls"
		w.config.Email.SMTP.AdminEmail = w.config.Email.From

	case "Resend":
		fmt.Println("\nResend SMTP configuration:")
		fmt.Println("Note: Use your Resend API key as the password")
		fmt.Println("The username is always 'resend' for Resend")
		w.config.Email.SMTP.Host = "smtp.resend.com"
		w.config.Email.SMTP.Port = 587
		w.config.Email.SMTP.Username = "resend"
		w.config.Email.SMTP.PasswordFrom = w.promptString("Resend API key source", "env:RESEND_API_KEY", nil)
		w.config.Email.SMTP.Encryption = "starttls"
		w.config.Email.SMTP.AdminEmail = w.config.Email.From
	}

	return nil
}

func (w *InitWizard) configureSecurity() error {
	color.New(color.Bold).Println("\n🔒 Security Configuration")

	// TLS is always enabled with cert-manager/Let's Encrypt
	w.config.Security.TLS = &TLSConfig{
		Enabled:   true,
		Provider:  "cert-manager",
		AcmeEmail: w.promptString("ACME email for Let's Encrypt", w.config.Project.Email, validateEmail),
	}

	// Network security - rate limiting disabled by default
	w.config.Security.Network = &NetworkConfig{
		RateLimiting: false,
		AllowedIPs:   []string{},
	}

	// Ask about IP restrictions
	if w.confirm("Restrict access to specific IP addresses/ranges?", false) {
		var ips []string
		for {
			ip := w.promptString("IP address or CIDR range (empty to finish)", "", nil)
			if ip == "" {
				break
			}
			ips = append(ips, ip)
		}
		w.config.Security.Network.AllowedIPs = ips
	}

	return nil
}

func (w *InitWizard) configureOptionalFeatures() error {
	color.New(color.Bold).Println("\n⚙️  Optional Features")

	// Monitoring
	w.config.Monitoring.Enabled = w.confirm("Enable monitoring (Prometheus + Grafana)?", false)

	if w.config.Monitoring.Enabled {
		// Monitoring mode
		modeChoice := w.promptChoice("Monitoring mode:", []string{
			"local - Use built-in Prometheus and Grafana",
			"remote - Use external monitoring (Grafana Cloud, New Relic, etc.)",
		}, "local - Use built-in Prometheus and Grafana")

		switch modeChoice {
		case "local - Use built-in Prometheus and Grafana":
			w.config.Monitoring.Mode = "local"
			w.config.Monitoring.Local = &LocalMonitoringConfig{
				PrometheusEnabled: true,
				GrafanaEnabled:    true,
				Retention:         "30d",
				StorageSize:       "50Gi",
			}
		case "remote - Use external monitoring (Grafana Cloud, New Relic, etc.)":
			w.config.Monitoring.Mode = "remote"
			if err := w.configureRemoteMonitoring(); err != nil {
				return err
			}
		}
	}

	// Logging configuration (always enabled, just configure where to send logs)
	w.config.Logging.Enabled = true
	if w.confirm("Configure external rule execution log destination?", false) {
		sinkTypes := []string{"console", "elasticsearch", "datadog_logs", "loki", "aws_s3", "azure_blob", "gcp_cloud_storage", "splunk_hec", "new_relic_logs", "http"}
		w.config.Logging.Vector = &VectorConfig{
			Sink: &VectorSink{
				Type: w.promptChoice("Log sink type", sinkTypes, "console"),
			},
		}

		w.config.Logging.Vector.Sink.Config = make(map[string]interface{})

		if w.config.Logging.Vector.Sink.Type == "console" {
			// Console sink requires encoding configuration
			w.config.Logging.Vector.Sink.Config["encoding"] = "json"
		} else {
			switch w.config.Logging.Vector.Sink.Type {
			case "elasticsearch":
				w.config.Logging.Vector.Sink.Endpoint = w.promptString("Elasticsearch endpoint (e.g., https://elastic.example.com:9200)", "", nil)
				w.config.Logging.Vector.Sink.Config["index"] = w.promptString("Index name", "rulebricks-logs", nil)
				if w.confirm("Use authentication?", true) {
					w.config.Logging.Vector.Sink.Config["auth_user"] = w.promptString("Username", "elastic", nil)
					w.config.Logging.Vector.Sink.APIKey = w.promptString("Password source", "env:ELASTIC_PASSWORD", nil)
				}

			case "datadog_logs":
				w.config.Logging.Vector.Sink.APIKey = w.promptString("Datadog API key source", "env:DATADOG_API_KEY", nil)
				site := w.promptChoice("Datadog site", []string{"datadoghq.com", "datadoghq.eu"}, "datadoghq.com")
				w.config.Logging.Vector.Sink.Config["site"] = site

			case "loki":
				w.config.Logging.Vector.Sink.Endpoint = w.promptString("Loki endpoint (e.g., http://loki:3100)", "", nil)

			case "aws_s3":
				w.config.Logging.Vector.Sink.Config["bucket"] = w.promptString("S3 bucket name", "", nil)
				w.config.Logging.Vector.Sink.Config["region"] = w.promptString("AWS region", "us-east-1", nil)
				fmt.Println("\n📋 S3 requires IAM permissions for Vector to write logs")
				if w.confirm("Would you like to set up IAM permissions automatically after deployment?", true) {
					w.config.Logging.Vector.Sink.Config["setup_iam"] = true
					fmt.Println("✅ IAM setup will be available via: rulebricks vector setup-s3")
				} else {
					fmt.Println("ℹ️  You can set up IAM manually later using: rulebricks vector generate-iam-config --sink aws_s3")
				}

			case "azure_blob":
				w.config.Logging.Vector.Sink.Config["container_name"] = w.promptString("Container name", "logs", nil)
				fmt.Println("\n📋 Azure Blob Storage can use Managed Identity (recommended) or Connection String")
				if w.confirm("Would you like to use Managed Identity instead of connection string?", true) {
					w.config.Logging.Vector.Sink.Config["use_managed_identity"] = true
					w.config.Logging.Vector.Sink.Config["storage_account"] = w.promptString("Storage account name", "", nil)
					if w.confirm("Would you like to set up Managed Identity automatically after deployment?", true) {
						w.config.Logging.Vector.Sink.Config["setup_iam"] = true
						fmt.Println("✅ Managed Identity setup will be available via: rulebricks vector setup-azure")
					}
				} else {
					w.config.Logging.Vector.Sink.APIKey = w.promptString("Connection string source", "env:AZURE_STORAGE_CONNECTION_STRING", nil)
				}

			case "gcp_cloud_storage":
				w.config.Logging.Vector.Sink.Config["bucket"] = w.promptString("GCS bucket name", "", nil)
				fmt.Println("\n📋 GCS can use Workload Identity (recommended) or Service Account JSON")
				if w.confirm("Would you like to use Workload Identity instead of service account JSON?", true) {
					w.config.Logging.Vector.Sink.Config["use_workload_identity"] = true
					if w.confirm("Would you like to set up Workload Identity automatically after deployment?", true) {
						w.config.Logging.Vector.Sink.Config["setup_iam"] = true
						fmt.Println("✅ Workload Identity setup will be available via: rulebricks vector setup-gcs")
					}
				} else {
					w.config.Logging.Vector.Sink.Config["credentials_path"] = w.promptString("Service account JSON path", "/var/secrets/gcp/key.json", nil)
					fmt.Println("ℹ️  Remember to create the secret: kubectl create secret generic gcs-key -n <namespace> --from-file=key.json=<path>")
				}

			case "splunk_hec":
				w.config.Logging.Vector.Sink.Endpoint = w.promptString("Splunk HEC endpoint", "", nil)
				w.config.Logging.Vector.Sink.APIKey = w.promptString("HEC token source", "env:SPLUNK_HEC_TOKEN", nil)
				w.config.Logging.Vector.Sink.Config["index"] = w.promptString("Index name", "main", nil)

			case "new_relic_logs":
				w.config.Logging.Vector.Sink.APIKey = w.promptString("License key source", "env:NEW_RELIC_LICENSE_KEY", nil)
				region := w.promptChoice("Region", []string{"US", "EU"}, "US")
				w.config.Logging.Vector.Sink.Config["region"] = region

			case "http":
				w.config.Logging.Vector.Sink.Endpoint = w.promptString("HTTP endpoint URL", "", nil)
				if w.confirm("Add authorization header?", false) {
					authHeader := w.promptString("Authorization header value", "Bearer YOUR_TOKEN", nil)
					w.config.Logging.Vector.Sink.Config["auth_header"] = authHeader
				}
			}
		}
	} else {
		// Default to console sink if no external destination is configured
		w.config.Logging.Vector = &VectorConfig{
			Sink: &VectorSink{
				Type: "console",
				Config: map[string]interface{}{
					"encoding": "json",
				},
			},
		}
	}

	// AI features
	w.config.AI.Enabled = w.confirm("Enable AI features?", false)
	if w.config.AI.Enabled {
		w.config.AI.OpenAIAPIKeyFrom = w.promptString("OpenAI API key source", "env:OPENAI_API_KEY", nil)
	}

	// Performance tuning (mandatory)
	w.configurePerformance()

	// Advanced settings
	if w.confirm("Configure advanced settings?", false) {
		w.configureAdvanced()
	}

	return nil
}

func (w *InitWizard) configureRemoteMonitoring() error {
	w.config.Monitoring.Remote = &RemoteMonitoringConfig{}

	// Choose provider
	providerChoice := w.promptChoice("Select remote monitoring provider:", []string{
		"prometheus - Generic Prometheus remote write",
		"grafana-cloud - Grafana Cloud",
		"newrelic - New Relic",
		"custom - Custom Prometheus-compatible endpoint",
	}, "grafana-cloud - Grafana Cloud")

	switch providerChoice {
	case "prometheus - Generic Prometheus remote write":
		w.config.Monitoring.Remote.Provider = "prometheus"
	case "grafana-cloud - Grafana Cloud":
		w.config.Monitoring.Remote.Provider = "grafana-cloud"
	case "newrelic - New Relic":
		w.config.Monitoring.Remote.Provider = "newrelic"
	case "custom - Custom Prometheus-compatible endpoint":
		w.config.Monitoring.Remote.Provider = "custom"
	}

	switch w.config.Monitoring.Remote.Provider {
	case "prometheus", "grafana-cloud", "custom":
		w.config.Monitoring.Remote.PrometheusWrite = &PrometheusRemoteWrite{}

		// Get remote write URL
		defaultURL := ""
		if w.config.Monitoring.Remote.Provider == "grafana-cloud" {
			defaultURL = "https://prometheus-us-central1.grafana.net/api/prom/push"
		}

		url := w.promptString("Remote write URL:", defaultURL, nil)
		w.config.Monitoring.Remote.PrometheusWrite.URL = url

		// Authentication
		authChoice := w.promptChoice("Authentication type:", []string{
			"basic - Username and password",
			"bearer - Bearer token",
			"none - No authentication",
		}, "basic - Username and password")

		switch authChoice {
		case "basic - Username and password": // Basic auth
			username := w.promptString("Username:", "", nil)
			w.config.Monitoring.Remote.PrometheusWrite.Username = username
			w.config.Monitoring.Remote.PrometheusWrite.PasswordFrom = "env:MONITORING_PASSWORD"
			fmt.Println("⚠️  Password will be read from MONITORING_PASSWORD environment variable")
		case "bearer - Bearer token": // Bearer token
			w.config.Monitoring.Remote.PrometheusWrite.BearerTokenFrom = "env:MONITORING_TOKEN"
			fmt.Println("⚠️  Bearer token will be read from MONITORING_TOKEN environment variable")
		}

		// Ask about filtering metrics
		if w.confirm("Configure metric filtering?", false) {
			fmt.Println("Add metric filters to reduce data sent to remote storage.")
			fmt.Println("Example: Keep only kubernetes_.* and node_.* metrics")

			keepRegex := w.promptString("Metrics to keep (regex, empty for all):", "kubernetes_.*|node_.*|up|traefik_.*", nil)
			if keepRegex != "" {
				w.config.Monitoring.Remote.PrometheusWrite.WriteRelabelConfigs = []RelabelConfig{
					{
						SourceLabels: []string{"__name__"},
						Regex:        keepRegex,
						Action:       "keep",
					},
				}
			}
		}

	case "newrelic":
		w.config.Monitoring.Remote.NewRelic = &NewRelicConfig{
			LicenseKeyFrom: "env:NEWRELIC_LICENSE_KEY",
		}

		regionChoice := w.promptChoice("New Relic region:", []string{
			"US - United States",
			"EU - Europe",
		}, "US - United States")

		if regionChoice == "US - United States" {
			w.config.Monitoring.Remote.NewRelic.Region = "US"
		} else {
			w.config.Monitoring.Remote.NewRelic.Region = "EU"
		}

		fmt.Println("⚠️  New Relic license key will be read from NEWRELIC_LICENSE_KEY environment variable")
	}

	return nil
}

func (w *InitWizard) configurePerformance() {
	color.New(color.Bold).Println("\n⚡ Performance Configuration")
	fmt.Println("Choose your deployment size based on expected workload:")
	fmt.Println()

	// Display performance tier options
	color.New(color.FgCyan).Println("┌──────────────────────────────────────────────────────────────────────────────┐")
	color.New(color.FgCyan).Println("│                          Performance Tier Selection                          │")
	color.New(color.FgCyan).Println("├──────────────────────────────────────────────────────────────────────────────┤")
	fmt.Printf("│ %-10s │ %-25s │ %-35s │\n", "Tier", "Use Case", "Resources")
	color.New(color.FgCyan).Println("├──────────────────────────────────────────────────────────────────────────────┤")

	fmt.Printf("│ ")
	color.New(color.FgGreen, color.Bold).Printf("%-10s", "Small")
	fmt.Printf(" │ %-25s │ %-35s │\n", "Development/Testing", "6-8 CPUs, 11-15GB RAM, 3-4 nodes")
	fmt.Printf("│            │ %-25s │ %-35s │\n", "", "<1000 rules/sec")

	color.New(color.FgCyan).Println("├──────────────────────────────────────────────────────────────────────────────┤")

	fmt.Printf("│ ")
	color.New(color.FgYellow, color.Bold).Printf("%-10s", "Medium")
	fmt.Printf(" │ %-25s │ %-35s │\n", "Production", "6-16 CPUs, 11-30GB RAM, 3-8 nodes")
	fmt.Printf("│            │ %-25s │ %-35s │\n", "", "1,000-10,000 rules/sec")

	color.New(color.FgCyan).Println("├──────────────────────────────────────────────────────────────────────────────┤")

	fmt.Printf("│ ")
	color.New(color.FgRed, color.Bold).Printf("%-10s", "Large")
	fmt.Printf(" │ %-25s │ %-35s │\n", "High Performance", "10-32 CPUs, 19-61GB RAM, 5-16 nodes")
	fmt.Printf("│            │ %-25s │ %-35s │\n", "", ">10,000 rules/sec")

	color.New(color.FgCyan).Println("└──────────────────────────────────────────────────────────────────────────────┘")
	fmt.Println()

	tierChoice := w.promptChoice("Select performance tier",
		[]string{"small", "medium", "large"}, "small")

	// Set all performance parameters based on tier selection
	switch tierChoice {
	case "small":
		w.config.Performance.VolumeLevel = "small"
		// Node configuration: c8g.large (2 vCPUs, 3.8 GB RAM per node)
		// Total resources: 6-8 vCPUs, 11.4-15.2 GB RAM
		w.config.Kubernetes.NodeCount = 3
		w.config.Kubernetes.MinNodes = 3
		w.config.Kubernetes.MaxNodes = 4
		// HPS - fixed at 2 replicas (limit per replica: 2 vCPU, 2 GB RAM)
		w.config.Performance.HPSReplicas = 2
		// Workers - up to 4 vCPU consumption (limit per worker: 0.5 vCPU, 0.5 GB RAM)
		w.config.Performance.HPSWorkerReplicas = 4
		w.config.Performance.HPSWorkerMaxReplicas = 8
		w.config.Performance.KafkaRetentionHours = 24
		w.config.Performance.KafkaReplicationFactor = 1
		w.config.Performance.KafkaStorageSize = "10Gi"
		// Traefik - up to 4 vCPU consumption (limit per replica: 2 vCPU, 4 GB RAM)
		w.config.Performance.TraefikMinReplicas = 1
		w.config.Performance.TraefikMaxReplicas = 2
		// Total resource consumption: 4.5-10 vCPUs (HPS: 1-2, Workers: 1.5-4, Traefik: 2-4)
		// Available resources: 6-8 vCPUs - may need to scale to 4 nodes under peak load

	case "medium":
		w.config.Performance.VolumeLevel = "medium"
		// Node configuration: c8g.large (2 vCPUs, 3.8 GB RAM per node)
		// Total resources: 6-16 vCPUs, 11.4-30.4 GB RAM
		w.config.Kubernetes.NodeCount = 3
		w.config.Kubernetes.MinNodes = 3
		w.config.Kubernetes.MaxNodes = 8
		// HPS - fixed at 2 replicas (limit per replica: 2 vCPU, 2 GB RAM)
		w.config.Performance.HPSReplicas = 2
		// Workers - up to 18 vCPU consumption (limit per worker: 0.5 vCPU, 0.5 GB RAM)
		w.config.Performance.HPSWorkerReplicas = 10
		w.config.Performance.HPSWorkerMaxReplicas = 24
		w.config.Performance.KafkaRetentionHours = 72
		w.config.Performance.KafkaReplicationFactor = 2
		w.config.Performance.KafkaStorageSize = "50Gi"
		// Traefik - up to 8 vCPU consumption (limit per replica: 2 vCPU, 4 GB RAM)
		w.config.Performance.TraefikMinReplicas = 2
		w.config.Performance.TraefikMaxReplicas = 4
		// Total resource consumption: 8.5-24 vCPUs (HPS: 2-6, Workers: 2.5-10, Traefik: 4-8)
		// Available resources: 6-16 vCPUs - will auto-scale nodes based on demand

	case "large":
		w.config.Performance.VolumeLevel = "large"
		// Node configuration: c8g.large (2 vCPUs, 3.8 GB RAM per node)
		// Total resources: 10-32 vCPUs, 19-60.8 GB RAM
		w.config.Kubernetes.NodeCount = 5
		w.config.Kubernetes.MinNodes = 5
		w.config.Kubernetes.MaxNodes = 16
		// HPS - fixed at 4 replicas (limit per replica: 2 vCPU, 2 GB RAM)
		w.config.Performance.HPSReplicas = 4
		// Workers - up to 30 vCPU consumption (limit per worker: 0.5 vCPU, 0.5 GB RAM)
		w.config.Performance.HPSWorkerReplicas = 10
		w.config.Performance.HPSWorkerMaxReplicas = 48
		w.config.Performance.KafkaRetentionHours = 168
		w.config.Performance.KafkaReplicationFactor = 3
		w.config.Performance.KafkaStorageSize = "100Gi"
		// Traefik - up to 12 vCPU consumption (limit per replica: 2 vCPU, 4 GB RAM)
		w.config.Performance.TraefikMinReplicas = 2
		w.config.Performance.TraefikMaxReplicas = 6
		// Total resource consumption: 12-40 vCPUs (HPS: 3-8, Workers: 5-20, Traefik: 4-12)
		// Available resources: 10-32 vCPUs - designed for high throughput with headroom
	}

	// Set common performance parameters
	w.config.Performance.ScaleUpStabilization = 30
	w.config.Performance.ScaleDownStabilization = 300
	w.config.Performance.KedaPollingInterval = 10
	w.config.Performance.KafkaLagThreshold = 8

	fmt.Println()
	color.New(color.FgGreen).Printf("✓ Performance tier '%s' selected\n", tierChoice)
	fmt.Println()
	fmt.Println("Configuration summary:")
	fmt.Printf("  • Cluster nodes: %d-%d (autoscaling enabled)\n", w.config.Kubernetes.MinNodes, w.config.Kubernetes.MaxNodes)
	fmt.Printf("  • HPS replicas: %d (fixed)\n", w.config.Performance.HPSReplicas)
	fmt.Printf("  • Worker replicas: %d-%d\n", w.config.Performance.HPSWorkerReplicas, w.config.Performance.HPSWorkerMaxReplicas)
	fmt.Printf("  • Kafka partitions: %d\n", w.config.Performance.KafkaPartitions)
	fmt.Printf("  • Storage size: %s\n", w.config.Performance.VolumeLevel)
}

func (w *InitWizard) configureAdvanced() {
	color.New(color.Bold).Println("\n🔧 Advanced Configuration")

	// Terraform backend configuration
	if w.confirm("Configure remote Terraform backend?", false) {
		w.config.Advanced.Terraform = &TerraformConfig{}

		backendTypes := []string{"s3", "azurerm", "gcs", "remote"}
		w.config.Advanced.Terraform.Backend = w.promptChoice("Terraform backend type", backendTypes, "s3")

		w.config.Advanced.Terraform.BackendConfig = make(map[string]string)

		switch w.config.Advanced.Terraform.Backend {
		case "s3":
			w.config.Advanced.Terraform.BackendConfig["bucket"] = w.promptString("S3 bucket name", "", nil)
			w.config.Advanced.Terraform.BackendConfig["key"] = w.promptString("State file key", fmt.Sprintf("%s/terraform.tfstate", w.config.Project.Name), nil)
			w.config.Advanced.Terraform.BackendConfig["region"] = w.promptString("AWS region", w.config.Cloud.Region, nil)
			if w.confirm("Enable state locking with DynamoDB?", true) {
				w.config.Advanced.Terraform.BackendConfig["dynamodb_table"] = w.promptString("DynamoDB table name", "terraform-state-lock", nil)
			}
		case "azurerm":
			w.config.Advanced.Terraform.BackendConfig["resource_group_name"] = w.promptString("Resource group name", "", nil)
			w.config.Advanced.Terraform.BackendConfig["storage_account_name"] = w.promptString("Storage account name", "", nil)
			w.config.Advanced.Terraform.BackendConfig["container_name"] = w.promptString("Container name", "tfstate", nil)
			w.config.Advanced.Terraform.BackendConfig["key"] = w.promptString("State file key", fmt.Sprintf("%s.terraform.tfstate", w.config.Project.Name), nil)
		case "gcs":
			w.config.Advanced.Terraform.BackendConfig["bucket"] = w.promptString("GCS bucket name", "", nil)
			w.config.Advanced.Terraform.BackendConfig["prefix"] = w.promptString("State file prefix", w.config.Project.Name, nil)
		case "remote":
			w.config.Advanced.Terraform.BackendConfig["organization"] = w.promptString("Terraform Cloud organization", "", nil)
			w.config.Advanced.Terraform.BackendConfig["workspaces"] = w.promptString("Workspace name", w.config.Project.Name, nil)
		}
	}
}

// UI helper methods

func (w *InitWizard) displayWelcome() {
	// clear the console
	fmt.Print("\033[H\033[2J") // ANSI escape code to clear the console
	// Print the welcome message with ASCII art
	color.New(color.Bold, color.FgGreen).Printf(`


               ⟋ ‾‾‾‾⟋|
              ██████  |
              ██████  |
              ██████ ⟋ ‾‾‾‾⟋|
            ⟋     ⟋ ██████  |
           ██████   ██████  |
           ██████   ██████⟋
           ██████⟋

         [Configure Rulebricks]


`)
	fmt.Println("This wizard will help you create a configuration file for your deployment.")
	fmt.Println("Press Ctrl+C at any time to cancel.")
}

func (w *InitWizard) displaySummary() {
	color.New(color.Bold).Println("\n📋 Configuration Summary")
	fmt.Println(strings.Repeat("─", 50))
	fmt.Printf("Project:    %s\n", w.config.Project.Name)
	fmt.Printf("Domain:     %s\n", w.config.Project.Domain)
	fmt.Printf("Version:    %s (Rulebricks version)\n", w.config.Project.Version)
	fmt.Printf("Cloud:      %s (%s)\n", w.config.Cloud.Provider, w.config.Cloud.Region)
	fmt.Printf("Database:   %s\n", w.config.Database.Type)
	fmt.Printf("Email:      SMTP (%s)\n", w.config.Email.SMTP.Host)
	fmt.Printf("TLS:        %v\n", w.config.Security.TLS.Enabled)
	if w.config.Monitoring.Enabled {
		mode := w.config.Monitoring.Mode
		if mode == "" {
			mode = "local"
		}
		fmt.Printf("Monitoring: %s", mode)
		if mode == "remote" && w.config.Monitoring.Remote != nil {
			fmt.Printf(" (%s)", w.config.Monitoring.Remote.Provider)
		}
		fmt.Println()
	} else {
		fmt.Println("Monitoring: disabled")
	}
	fmt.Println(strings.Repeat("─", 50))
}

func (w *InitWizard) displayNextSteps() {
	color.Green("\n✅ Configuration saved to rulebricks.yaml")
	fmt.Println("\nNext steps:")
	fmt.Println("1. Review and edit rulebricks.yaml if needed")
	fmt.Println("2. Ensure your cloud provider credentials are configured")
	fmt.Println("3. Run 'rulebricks deploy' to deploy your application")
	fmt.Println("\nFor more information, visit https://rulebricks.com/docs")
}

// Input helper methods

func (w *InitWizard) promptString(prompt string, defaultValue string, validator func(string) error) string {
	for {
		if defaultValue != "" {
			fmt.Printf("%s [%s]: ", prompt, defaultValue)
		} else {
			fmt.Printf("%s: ", prompt)
		}

		w.scanner.Scan()
		input := strings.TrimSpace(w.scanner.Text())

		if input == "" && defaultValue != "" {
			input = defaultValue
		}

		if validator != nil {
			if err := validator(input); err != nil {
				color.Red("Invalid input: %v", err)
				continue
			}
		}

		return input
	}
}

func (w *InitWizard) promptPassword(prompt string) string {
	fmt.Printf("%s: ", prompt)

	// Read password without echoing to terminal
	bytePassword, err := term.ReadPassword(int(syscall.Stdin))
	fmt.Println() // Print newline after password input

	if err != nil {
		color.Yellow("⚠️  Could not read password securely, falling back to visible input")
		w.scanner.Scan()
		return strings.TrimSpace(w.scanner.Text())
	}

	return strings.TrimSpace(string(bytePassword))
}

func (w *InitWizard) promptInt(prompt string, defaultValue, min, max int) int {
	for {
		input := w.promptString(prompt, fmt.Sprintf("%d", defaultValue), nil)

		var value int
		if _, err := fmt.Sscanf(input, "%d", &value); err != nil {
			color.Red("Please enter a valid number")
			continue
		}

		if value < min || value > max {
			color.Red("Value must be between %d and %d", min, max)
			continue
		}

		return value
	}
}

func (w *InitWizard) promptChoice(prompt string, choices []string, defaultChoice string) string {
	fmt.Printf("%s\n", prompt)
	for i, choice := range choices {
		if choice == defaultChoice {
			fmt.Printf("  %d. %s (default)\n", i+1, choice)
		} else {
			fmt.Printf("  %d. %s\n", i+1, choice)
		}
	}

	for {
		input := w.promptString("Choice", "", nil)

		// Check if input is a number
		var index int
		if _, err := fmt.Sscanf(input, "%d", &index); err == nil {
			if index >= 1 && index <= len(choices) {
				return choices[index-1]
			}
		}

		// Check if input matches a choice
		for _, choice := range choices {
			if strings.EqualFold(input, choice) {
				return choice
			}
		}

		// Use default if empty
		if input == "" && defaultChoice != "" {
			return defaultChoice
		}

		color.Red("Invalid choice. Please select from the list.")
	}
}

func (w *InitWizard) confirm(prompt string, defaultValue bool) bool {
	defaultStr := "n"
	if defaultValue {
		defaultStr = "y"
	}

	for {
		response := w.promptString(fmt.Sprintf("%s (y/n)", prompt), defaultStr, nil)
		response = strings.ToLower(response)

		switch response {
		case "y", "yes":
			return true
		case "n", "no":
			return false
		default:
			color.Red("Please answer 'y' or 'n'")
		}
	}
}

// Utility function
func fileExists(path string) bool {
	_, err := os.Stat(path)
	return err == nil
}
