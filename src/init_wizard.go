package main

import (
	"bufio"
	"fmt"
	"os"
	"strings"

	"github.com/fatih/color"
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
		config:         &Config{Version: "1.0"},
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
	w.config.Project.Name = w.promptString("Project name", "my-app", func(s string) error {
		if !isValidKubernetesName(sanitizeName(s)) {
			return fmt.Errorf("project name must be lowercase alphanumeric or '-'")
		}
		return nil
	})
	w.config.Project.Name = sanitizeName(w.config.Project.Name)

	// Domain
	w.config.Project.Domain = w.promptString("Domain name", fmt.Sprintf("%s.example.com", w.config.Project.Name), func(s string) error {
		if !isValidDomain(s) {
			return fmt.Errorf("invalid domain format")
		}
		return nil
	})

	// Email
	w.config.Project.Email = w.promptString("Admin email", "", validateEmail)

	// License key
	w.config.Project.License = w.promptPassword("Rulebricks license key")

	// Project version
	w.config.Project.Version = w.promptString("Project version", "1.0.0", nil)

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
		fmt.Sprintf("%s-cluster", w.config.Project.Name), nil)

	w.config.Kubernetes.NodeCount = w.promptInt("Initial node count", 3, 1, 100)

	if w.confirm("Enable autoscaling?", true) {
		w.config.Kubernetes.EnableAutoscale = true
		w.config.Kubernetes.MinNodes = w.promptInt("Minimum nodes", w.config.Kubernetes.NodeCount, 1, 100)
		w.config.Kubernetes.MaxNodes = w.promptInt("Maximum nodes", w.config.Kubernetes.NodeCount*2, w.config.Kubernetes.MinNodes, 100)
	}
}

func (w *InitWizard) configureDatabase() error {
	color.New(color.Bold).Println("\n🗄️  Database Configuration")

	// Database type
	dbTypes := []string{"self-hosted", "managed", "external"}
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

	case "external":
		w.config.Database.External = &ExternalDBConfig{}
		w.config.Database.External.Host = w.promptString("Database host", "", nil)
		w.config.Database.External.Port = w.promptInt("Database port", 5432, 1, 65535)
		w.config.Database.External.Database = w.promptString("Database name", "postgres", nil)
		w.config.Database.External.Username = w.promptString("Database username", "postgres", nil)
		w.config.Database.External.PasswordFrom = w.promptString("Password source (env:VAR or file:path)", "env:DB_PASSWORD", nil)
		w.config.Database.External.SSLMode = w.promptChoice("SSL mode", []string{"disable", "require", "verify-ca", "verify-full"}, "require")

		if w.confirm("Configure read replicas?", false) {
			w.configureReplicas()
		}

	case "self-hosted":
		// Self-hosted uses defaults
		color.Green("✓ Self-hosted Supabase will be deployed with the cluster")
	}

	// Connection pooling
	if w.config.Database.Type != "managed" && w.confirm("Enable connection pooling?", true) {
		w.config.Database.Pooling = &PoolingConfig{
			Enabled: true,
			MinSize: w.promptInt("Minimum pool size", 10, 1, 1000),
			MaxSize: w.promptInt("Maximum pool size", 100, 10, 1000),
		}
	}

	return nil
}

func (w *InitWizard) configureReplicas() {
	numReplicas := w.promptInt("Number of read replicas", 0, 0, 10)
	if numReplicas > 0 {
		w.config.Database.External.Replicas = make([]ReplicaConfig, numReplicas)
		for i := 0; i < numReplicas; i++ {
			fmt.Printf("\nReplica %d:\n", i+1)
			w.config.Database.External.Replicas[i] = ReplicaConfig{
				Host: w.promptString("  Host", "", nil),
				Port: w.promptInt("  Port", 5432, 1, 65535),
				Type: w.promptChoice("  Type", []string{"read", "analytics"}, "read"),
			}
		}
	}
}

func (w *InitWizard) configureEmail() error {
	color.New(color.Bold).Println("\n📧 Email Configuration")

	// Email provider
	providers := []string{"smtp", "sendgrid", "mailgun", "ses", "resend"}
	w.config.Email.Provider = w.promptChoice("Email provider", providers, "smtp")

	// Common settings
	w.config.Email.From = w.promptString("From email", fmt.Sprintf("noreply@%s", w.config.Project.Domain), validateEmail)
	w.config.Email.FromName = w.promptString("From name", w.config.Project.Name, nil)

	// Provider-specific settings - all providers use SMTP
	w.config.Email.SMTP = &SMTPConfig{}

	switch w.config.Email.Provider {
	case "smtp":
		w.config.Email.SMTP.Host = w.promptString("SMTP host", "", nil)
		w.config.Email.SMTP.Port = w.promptInt("SMTP port", 587, 1, 65535)
		w.config.Email.SMTP.Username = w.promptString("SMTP username", "", nil)
		w.config.Email.SMTP.PasswordFrom = w.promptString("Password source", "env:SMTP_PASSWORD", nil)
		w.config.Email.SMTP.Encryption = w.promptChoice("Encryption", []string{"tls", "ssl", "none"}, "tls")
		w.config.Email.SMTP.AdminEmail = w.promptString("Admin email (optional)", "", nil)

	case "sendgrid":
		fmt.Println("\nSendGrid SMTP configuration:")
		fmt.Println("Note: Use your SendGrid API key as the password")
		fmt.Println("The username is always 'apikey' for SendGrid")
		w.config.Email.SMTP.Host = "smtp.sendgrid.net"
		w.config.Email.SMTP.Port = 587
		w.config.Email.SMTP.Username = "apikey"
		w.config.Email.SMTP.PasswordFrom = w.promptString("SendGrid API key source", "env:SENDGRID_API_KEY", nil)
		w.config.Email.SMTP.Encryption = "tls"

	case "mailgun":
		fmt.Println("\nMailgun SMTP configuration:")
		fmt.Println("Note: Find your SMTP credentials in Mailgun Dashboard > Domain Settings > SMTP credentials")
		fmt.Println("Username format is typically: postmaster@your-domain.mailgun.org")
		w.config.Email.SMTP.Host = "smtp.mailgun.org"
		w.config.Email.SMTP.Port = 587
		w.config.Email.SMTP.Username = w.promptString("Mailgun SMTP username", "", nil)
		w.config.Email.SMTP.PasswordFrom = w.promptString("Mailgun SMTP password source", "env:MAILGUN_SMTP_PASSWORD", nil)
		w.config.Email.SMTP.Encryption = "tls"

	case "ses":
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
		w.config.Email.SMTP.Encryption = "tls"

	case "resend":
		fmt.Println("\nResend SMTP configuration:")
		fmt.Println("Note: Use your Resend API key as the password")
		fmt.Println("The username is always 'resend' for Resend")
		w.config.Email.SMTP.Host = "smtp.resend.com"
		w.config.Email.SMTP.Port = 587
		w.config.Email.SMTP.Username = "resend"
		w.config.Email.SMTP.PasswordFrom = w.promptString("Resend API key source", "env:RESEND_API_KEY", nil)
		w.config.Email.SMTP.Encryption = "tls"
	}

	return nil
}

func (w *InitWizard) configureSecurity() error {
	color.New(color.Bold).Println("\n🔒 Security Configuration")

	// TLS configuration
	w.config.Security.TLS = &TLSConfig{
		Enabled: w.confirm("Enable TLS/SSL?", true),
	}

	if w.config.Security.TLS.Enabled {
		tlsProviders := []string{"cert-manager", "custom"}
		w.config.Security.TLS.Provider = w.promptChoice("TLS provider", tlsProviders, "cert-manager")

		if w.config.Security.TLS.Provider == "cert-manager" {
			w.config.Security.TLS.AcmeEmail = w.promptString("ACME email for Let's Encrypt", w.config.Project.Email, validateEmail)
		} else {
			w.config.Security.TLS.CustomCert = w.promptString("Path to certificate file", "", nil)
			w.config.Security.TLS.CustomKey = w.promptString("Path to key file", "", nil)
		}

		// Additional domains
		if w.confirm("Add additional domains?", false) {
			domains := []string{}
			for {
				domain := w.promptString("Additional domain (empty to finish)", "", nil)
				if domain == "" {
					break
				}
				domains = append(domains, domain)
			}
			w.config.Security.TLS.Domains = domains
		}
	}

	// Network security
	w.config.Security.Network = &NetworkConfig{
		RateLimiting: w.confirm("Enable rate limiting?", true),
	}

	return nil
}

func (w *InitWizard) configureOptionalFeatures() error {
	color.New(color.Bold).Println("\n⚙️  Optional Features")

	// Monitoring
	w.config.Monitoring.Enabled = w.confirm("Enable monitoring (Prometheus + Grafana)?", true)
	if w.config.Monitoring.Enabled {
		w.config.Monitoring.Provider = "prometheus"
	}

	// Logging
	w.config.Logging.Enabled = w.confirm("Enable centralized logging?", false)
	if w.config.Logging.Enabled {
		w.config.Logging.Vector = &VectorConfig{
			Sink: &VectorSink{
				Type: w.promptChoice("Log sink type", []string{"console", "elasticsearch", "s3", "datadog"}, "console"),
			},
		}

		if w.config.Logging.Vector.Sink.Type != "console" {
			w.config.Logging.Vector.Sink.Endpoint = w.promptString("Sink endpoint", "", nil)
			if w.confirm("Requires API key?", true) {
				w.config.Logging.Vector.Sink.APIKey = w.promptString("API key source", "env:VECTOR_API_KEY", nil)
			}
		}
	}

	// AI features
	w.config.AI.Enabled = w.confirm("Enable AI features?", false)
	if w.config.AI.Enabled {
		w.config.AI.OpenAIAPIKeyFrom = w.promptString("OpenAI API key source", "env:OPENAI_API_KEY", nil)
	}

	// Performance tuning
	if w.confirm("Configure performance settings?", false) {
		w.configurePerformance()
	}

	return nil
}

func (w *InitWizard) configurePerformance() {
	w.config.Performance.VolumeLevel = w.promptChoice("Storage volume level",
		[]string{"small", "medium", "large"}, "medium")

	w.config.Performance.HPSReplicas = w.promptInt("Initial HPS replicas", 1, 1, 10)
	w.config.Performance.HPSMaxReplicas = w.promptInt("Maximum HPS replicas", 5, w.config.Performance.HPSReplicas, 50)

	if w.confirm("Configure Kafka for event processing?", false) {
		w.config.Performance.KafkaPartitions = w.promptInt("Kafka partitions", 10, 1, 100)
		w.config.Performance.KafkaRetentionHours = w.promptInt("Kafka retention (hours)", 24, 1, 168)
		w.config.Performance.KafkaReplicationFactor = w.promptInt("Kafka replication factor", 1, 1, 5)
	}
}

// UI helper methods

func (w *InitWizard) displayWelcome() {
	color.New(color.Bold, color.FgCyan).Println("\n🎉 Welcome to Rulebricks!")
	fmt.Println("This wizard will help you create a configuration file for your deployment.")
	fmt.Println("Press Ctrl+C at any time to cancel.\n")
}

func (w *InitWizard) displaySummary() {
	color.New(color.Bold).Println("\n📋 Configuration Summary")
	fmt.Println(strings.Repeat("─", 50))
	fmt.Printf("Project:    %s\n", w.config.Project.Name)
	fmt.Printf("Domain:     %s\n", w.config.Project.Domain)
	fmt.Printf("Cloud:      %s (%s)\n", w.config.Cloud.Provider, w.config.Cloud.Region)
	fmt.Printf("Database:   %s\n", w.config.Database.Type)
	fmt.Printf("Email:      %s\n", w.config.Email.Provider)
	fmt.Printf("TLS:        %v\n", w.config.Security.TLS.Enabled)
	fmt.Printf("Monitoring: %v\n", w.config.Monitoring.Enabled)
	fmt.Println(strings.Repeat("─", 50))
}

func (w *InitWizard) displayNextSteps() {
	color.Green("\n✅ Configuration saved to rulebricks.yaml")
	fmt.Println("\nNext steps:")
	fmt.Println("1. Review and edit rulebricks.yaml if needed")
	fmt.Println("2. Ensure your cloud provider credentials are configured")
	fmt.Println("3. Run 'rulebricks deploy' to deploy your application")
	fmt.Println("\nFor more information, visit https://docs.rulebricks.com")
}

// Input helper methods

func (w *InitWizard) promptString(prompt, defaultValue string, validator func(string) error) string {
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
	// In a real implementation, this would hide the input
	fmt.Printf("%s: ", prompt)
	w.scanner.Scan()
	return strings.TrimSpace(w.scanner.Text())
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
