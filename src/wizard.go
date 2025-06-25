// wizard.go - Interactive Configuration Wizard
package main

import (
	"bufio"
	"fmt"
	"os"
	"strconv"
	"strings"
	"github.com/AlecAivazis/survey/v2"
	"github.com/fatih/color"
	"golang.org/x/term"
	"io"
	"net/http"
	"path/filepath"
)

// ConfigWizard guides users through creating a configuration
type ConfigWizard struct {
	reader *bufio.Reader
	config Config
}

// NewConfigWizard creates a new configuration wizard
func NewConfigWizard() *ConfigWizard {
	return &ConfigWizard{
		reader: bufio.NewReader(os.Stdin),
		config: Config{Version: version},
	}
}

// Run executes the interactive wizard
func (w *ConfigWizard) Run() Config {
	w.printWelcome()

	// Step 1: Basic project information
	w.configureProject()

	// Step 2: Cloud provider selection
	w.configureCloud()

	// Step 3: Database configuration
	w.configureDatabase()

	// Step 4: Email configuration
	w.configureEmail()

	// Step 5: Security settings
	// Step 5: Security configuration
	w.configureSecurity()

	// Step 6: AI features configuration
	w.configureAI()

	// Step 7: Logging configuration
	w.configureLogging()

	// Step 8: Performance and scaling configuration
	w.configurePerformanceAndScaling()

	// Step 9: Optional advanced features
	w.configureAdvanced()

	// Step 10: Summary
	w.showSummary()

	return w.config
}

func (w *ConfigWizard) printWelcome() {
	color.Cyan(`
██████  ██    ██ ██      ███████ ██████  ██████  ██  ██████ ██   ██ ███████
██   ██ ██    ██ ██      ██      ██   ██ ██   ██ ██ ██      ██  ██  ██
██████  ██    ██ ██      █████   ██████  ██████  ██ ██      █████   ███████
██   ██ ██    ██ ██      ██      ██   ██ ██   ██ ██ ██      ██  ██       ██
██   ██  ██████  ███████ ███████ ██████  ██   ██ ██  ██████ ██   ██ ███████
`)

	fmt.Println("\nWelcome to the Rulebricks Configuration Wizard!")
	fmt.Println("This wizard will help you create a deployment configuration.\n")
}

func (w *ConfigWizard) configureProject() {
	color.Yellow("\n📋 Basic Project Information\n")

	// Project name
	projectName := ""
	prompt := &survey.Input{
		Message: "Project name:",
		Default: "my-rulebricks",
		Help:    "A unique identifier for your Rulebricks deployment",
	}
	survey.AskOne(prompt, &projectName)
	w.config.Project.Name = projectName

	// Domain
	domain := ""
	domainPrompt := &survey.Input{
		Message: "Domain name (e.g., rulebricks.acme.com):",
		Help:    "The domain where Rulebricks will be accessible",
	}
	survey.AskOne(domainPrompt, &domain, survey.WithValidator(survey.Required))
	w.config.Project.Domain = domain

	// Admin email
	email := ""
	emailPrompt := &survey.Input{
		Message: "Administrator email:",
		Help:    "Email address for the initial admin user and notifications",
	}
	survey.AskOne(emailPrompt, &email, survey.WithValidator(survey.Required))
	w.config.Project.Email = email

	// License key
	licenseKey := ""
	licensePrompt := &survey.Password{
		Message: "License key:",
		Help:    "Your Rulebricks license key (will be stored securely)",
	}
	survey.AskOne(licensePrompt, &licenseKey, survey.WithValidator(survey.Required))
	w.config.Project.License = licenseKey
}

func (w *ConfigWizard) configureCloud() {
	color.Yellow("\n☁️  Cloud Provider Configuration\n")

	// Cloud provider selection
	provider := ""
	providerPrompt := &survey.Select{
		Message: "Select cloud provider:",
		Options: []string{"AWS", "Azure", "Google Cloud Platform"},
		Help:    "Choose where to deploy your Kubernetes cluster",
	}
	survey.AskOne(providerPrompt, &provider)

	switch provider {
	case "AWS":
		w.config.Cloud.Provider = "aws"
		w.configureAWS()
	case "Azure":
		w.config.Cloud.Provider = "azure"
		w.configureAzure()
	case "Google Cloud Platform":
		w.config.Cloud.Provider = "gcp"
		w.configureGCP()
	}

	// Kubernetes configuration
	color.Yellow("\n🚀 Kubernetes Configuration\n")

	// Node configuration with smart defaults
	nodeCountStr := "2"
	nodePrompt := &survey.Input{
		Message: "Initial number of nodes:",
		Default: "2",
		Help:    "Starting number of worker nodes (can be scaled later)",
	}
	survey.AskOne(nodePrompt, &nodeCountStr, survey.WithValidator(func(ans interface{}) error {
		n := ans.(string)
		count := 0
		for _, ch := range n {
			if ch < '0' || ch > '9' {
				return fmt.Errorf("node count must be a number")
			}
			count = count*10 + int(ch-'0')
		}
		if count < 1 {
			return fmt.Errorf("must have at least 1 node")
		}
		if count > 100 {
			return fmt.Errorf("node count seems too high (max 100)")
		}
		return nil
	}))
	nodeCount, _ := strconv.Atoi(nodeCountStr)
	w.config.Kubernetes.NodeCount = nodeCount

	// Autoscaling
	enableAutoscale := false
	autoscalePrompt := &survey.Confirm{
		Message: "Enable cluster autoscaling?",
		Default: true,
		Help:    "Automatically scale nodes based on workload",
	}
	survey.AskOne(autoscalePrompt, &enableAutoscale)
	w.config.Kubernetes.EnableAutoscale = enableAutoscale

	if enableAutoscale {
		minNodesStr := "1"
		maxNodesStr := "10"

		minPrompt := &survey.Input{
			Message: "Minimum nodes:",
			Default: "1",
		}
		survey.AskOne(minPrompt, &minNodesStr, survey.WithValidator(func(ans interface{}) error {
			n := ans.(string)
			count, err := strconv.Atoi(n)
			if err != nil {
				return fmt.Errorf("minimum nodes must be a number")
			}
			if count < 1 {
				return fmt.Errorf("minimum nodes must be at least 1")
			}
			return nil
		}))
		minNodes, _ := strconv.Atoi(minNodesStr)
		w.config.Kubernetes.MinNodes = minNodes

		maxPrompt := &survey.Input{
			Message: "Maximum nodes:",
			Default: "10",
		}
		survey.AskOne(maxPrompt, &maxNodesStr, survey.WithValidator(func(ans interface{}) error {
			n := ans.(string)
			count, err := strconv.Atoi(n)
			if err != nil {
				return fmt.Errorf("maximum nodes must be a number")
			}
			if count < minNodes {
				return fmt.Errorf("maximum nodes must be >= minimum nodes (%d)", minNodes)
			}
			if count > 100 {
				return fmt.Errorf("maximum nodes seems too high (max 100)")
			}
			return nil
		}))
		maxNodes, _ := strconv.Atoi(maxNodesStr)
		w.config.Kubernetes.MaxNodes = maxNodes
	}
}

func (w *ConfigWizard) configureAWS() {
	// AWS regions with descriptions
	regions := []string{
		"us-east-1 (N. Virginia)",
		"us-east-2 (Ohio)",
		"us-west-1 (N. California)",
		"us-west-2 (Oregon)",
		"eu-west-1 (Ireland)",
		"eu-west-2 (London)",
		"eu-west-3 (Paris)",
		"eu-central-1 (Frankfurt)",
		"ap-south-1 (Mumbai)",
		"ap-southeast-1 (Singapore)",
		"ap-southeast-2 (Sydney)",
		"ap-northeast-1 (Tokyo)",
	}

	region := ""
	regionPrompt := &survey.Select{
		Message: "Select AWS region:",
		Options: regions,
		Help:    "Choose the region closest to your users",
	}
	survey.AskOne(regionPrompt, &region)

	// Extract region code
	w.config.Cloud.Region = strings.Split(region, " ")[0]

	// Instance type selection - ARM-based instances only
	instanceTypes := []string{
		"c8g.large (2 vCPU, 4 GB RAM) - Recommended",
		"c8g.xlarge (4 vCPU, 8 GB RAM)",
		"c8g.2xlarge (8 vCPU, 16 GB RAM)",
		"m8g.large (2 vCPU, 8 GB RAM)",
		"m8g.xlarge (4 vCPU, 16 GB RAM)",
		"m8g.2xlarge (8 vCPU, 32 GB RAM)",
		"t4g.medium (2 vCPU, 4 GB RAM) - Burstable",
		"t4g.large (2 vCPU, 8 GB RAM) - Burstable",
		"t4g.xlarge (4 vCPU, 16 GB RAM) - Burstable",
	}

	instanceType := ""
	instancePrompt := &survey.Select{
		Message: "Select instance type:",
		Options: instanceTypes,
		Default: instanceTypes[0],
		Help:    "Choose based on expected workload",
	}
	survey.AskOne(instancePrompt, &instanceType)

	// Extract instance type
	w.config.Cloud.AWS.InstanceType = strings.Split(instanceType, " ")[0]

	// VPC CIDR (advanced)
	customVPC := false
	vpcPrompt := &survey.Confirm{
		Message: "Configure custom VPC settings?",
		Default: false,
		Help:    "Advanced: specify custom VPC CIDR range",
	}
	survey.AskOne(vpcPrompt, &customVPC)

	if customVPC {
		cidr := ""
		cidrPrompt := &survey.Input{
			Message: "VPC CIDR range:",
			Default: "10.0.0.0/16",
			Help:    "Must not conflict with existing networks",
		}
		survey.AskOne(cidrPrompt, &cidr)
		w.config.Cloud.AWS.VPCCidr = cidr
	}
}

func (w *ConfigWizard) configureAzure() {
	// Similar implementation for Azure
	regions := []string{
		"eastus (East US)",
		"eastus2 (East US 2)",
		"westus (West US)",
		"westus2 (West US 2)",
		"centralus (Central US)",
		"northeurope (North Europe)",
		"westeurope (West Europe)",
		"uksouth (UK South)",
		"eastasia (East Asia)",
		"southeastasia (Southeast Asia)",
		"japaneast (Japan East)",
		"australiaeast (Australia East)",
	}

	region := ""
	regionPrompt := &survey.Select{
		Message: "Select Azure region:",
		Options: regions,
	}
	survey.AskOne(regionPrompt, &region)
	w.config.Cloud.Region = strings.Split(region, " ")[0]

	// VM sizes - ARM-based instances only
	vmSizes := []string{
		"Standard_D2ps_v5 (2 vCPU, 8 GB RAM) - ARM-based",
		"Standard_D4ps_v5 (4 vCPU, 16 GB RAM) - ARM-based, Recommended",
		"Standard_D8ps_v5 (8 vCPU, 32 GB RAM) - ARM-based",
		"Standard_D16ps_v5 (16 vCPU, 64 GB RAM) - ARM-based",
		"Standard_E2ps_v5 (2 vCPU, 16 GB RAM) - ARM-based, Memory optimized",
		"Standard_E4ps_v5 (4 vCPU, 32 GB RAM) - ARM-based, Memory optimized",
		"Standard_E8ps_v5 (8 vCPU, 64 GB RAM) - ARM-based, Memory optimized",
	}

	vmSize := ""
	vmPrompt := &survey.Select{
		Message: "Select VM size:",
		Options: vmSizes,
		Default: vmSizes[0],
	}
	survey.AskOne(vmPrompt, &vmSize)
	w.config.Cloud.Azure.VMSize = strings.Split(vmSize, " ")[0]
}

func (w *ConfigWizard) configureGCP() {
	// Similar implementation for GCP
	regions := []string{
		"us-central1 (Iowa)",
		"us-east1 (South Carolina)",
		"us-west1 (Oregon)",
		"us-west2 (Los Angeles)",
		"europe-west1 (Belgium)",
		"europe-west2 (London)",
		"europe-west3 (Frankfurt)",
		"asia-east1 (Taiwan)",
		"asia-northeast1 (Tokyo)",
		"asia-southeast1 (Singapore)",
		"australia-southeast1 (Sydney)",
	}

	region := ""
	regionPrompt := &survey.Select{
		Message: "Select GCP region:",
		Options: regions,
	}
	survey.AskOne(regionPrompt, &region)
	w.config.Cloud.Region = strings.Split(region, " ")[0]

	// Machine types - ARM-based instances only
	machineTypes := []string{
		"t2a-standard-1 (1 vCPU, 4 GB RAM) - ARM-based",
		"t2a-standard-2 (2 vCPU, 8 GB RAM) - ARM-based, Recommended",
		"t2a-standard-4 (4 vCPU, 16 GB RAM) - ARM-based",
		"t2a-standard-8 (8 vCPU, 32 GB RAM) - ARM-based",
		"t2a-standard-16 (16 vCPU, 64 GB RAM) - ARM-based",
	}

	machineType := ""
	machinePrompt := &survey.Select{
		Message: "Select machine type:",
		Options: machineTypes,
		Default: machineTypes[0],
	}
	survey.AskOne(machinePrompt, &machineType)
	w.config.Cloud.GCP.MachineType = strings.Split(machineType, " ")[0]
}

func (w *ConfigWizard) configureDatabase() {
	color.Yellow("\n🗄️  Database Configuration\n")

	dbTypes := []string{
		"Managed Supabase (Recommended for getting started)",
		"Self-hosted Supabase (Run Supabase in your cluster)",
		"External PostgreSQL (Connect to existing database)",
	}

	dbType := ""
	dbPrompt := &survey.Select{
		Message: "Select database deployment type:",
		Options: dbTypes,
		Help:    "Choose how to deploy your database",
	}
	survey.AskOne(dbPrompt, &dbType)

	switch {
	case strings.Contains(dbType, "Managed"):
		w.config.Database.Type = "managed"
		w.config.Database.Provider = "supabase"
		w.configureManagedSupabase()

	case strings.Contains(dbType, "Self-hosted"):
		w.config.Database.Type = "self-hosted"
		w.config.Database.Provider = "supabase"
		// No additional config needed for self-hosted

	case strings.Contains(dbType, "External"):
		w.config.Database.Type = "external"
		w.config.Database.Provider = "postgres"
		w.configureExternalDatabase()
	}

	// Connection pooling
	pooling := false
	poolPrompt := &survey.Confirm{
		Message: "Enable connection pooling?",
		Default: true,
		Help:    "Recommended for production workloads",
	}
	survey.AskOne(poolPrompt, &pooling)
	w.config.Database.Pooling.Enabled = pooling

	if pooling {
		w.config.Database.Pooling.MinSize = 10
		w.config.Database.Pooling.MaxSize = 100
	}
}

func (w *ConfigWizard) configureManagedSupabase() {
	// Project name
	projectName := strings.ReplaceAll(w.config.Project.Domain, ".", "-")
	// Ensure project name is valid for Supabase
	projectName = sanitizeProjectName(projectName)

	namePrompt := &survey.Input{
		Message: "Supabase project name:",
		Default: projectName,
		Help:    "Name for your Supabase project (lowercase, alphanumeric, hyphens only)",
	}
	survey.AskOne(namePrompt, &projectName, survey.WithValidator(func(ans interface{}) error {
		name := ans.(string)
		if len(name) < 3 {
			return fmt.Errorf("project name must be at least 3 characters")
		}
		if len(name) > 40 {
			return fmt.Errorf("project name must be 40 characters or less")
		}
		// Validate format
		for i, ch := range name {
			if !((ch >= 'a' && ch <= 'z') || (ch >= '0' && ch <= '9') || (ch == '-' && i > 0 && i < len(name)-1)) {
				return fmt.Errorf("project name must contain only lowercase letters, numbers, and hyphens (not at start/end)")
			}
		}
		return nil
	}))
	w.config.Database.Supabase.ProjectName = projectName

	// Region selection (Supabase regions)
	regions := []string{
		"us-east-1 (North Virginia)",
		"us-west-1 (North California)",
		"eu-west-1 (Ireland)",
		"eu-west-2 (London)",
		"eu-central-1 (Frankfurt)",
		"ap-southeast-1 (Singapore)",
		"ap-northeast-1 (Tokyo)",
		"ap-south-1 (Mumbai)",
		"sa-east-1 (São Paulo)",
	}

	region := ""
	regionPrompt := &survey.Select{
		Message: "Supabase region:",
		Options: regions,
		Help:    "Should be close to your Kubernetes cluster",
	}
	survey.AskOne(regionPrompt, &region)
	w.config.Database.Supabase.Region = strings.Split(region, " ")[0]
}

func (w *ConfigWizard) configureExternalDatabase() {
	// Database host
	host := ""
	hostPrompt := &survey.Input{
		Message: "Database host:",
		Help:    "Hostname or IP address of your PostgreSQL server",
	}
	survey.AskOne(hostPrompt, &host, survey.WithValidator(func(ans interface{}) error {
		h := ans.(string)
		if h == "" {
			return fmt.Errorf("database host is required")
		}
		// Basic validation - check if it looks like a hostname or IP
		if strings.Contains(h, " ") {
			return fmt.Errorf("database host cannot contain spaces")
		}
		return nil
	}))
	w.config.Database.External.Host = host

	// Port
	portStr := "5432"
	portPrompt := &survey.Input{
		Message: "Database port:",
		Default: "5432",
	}
	survey.AskOne(portPrompt, &portStr, survey.WithValidator(func(ans interface{}) error {
		p := ans.(string)
		port, err := parsePort(p)
		if err != nil {
			return err
		}
		if isReservedPort(port) {
			return fmt.Errorf("warning: port %d is in the reserved range (1-1023)", port)
		}
		return nil
	}))
	port, _ := parsePort(portStr)
	w.config.Database.External.Port = port

	// Database name
	database := ""
	dbPrompt := &survey.Input{
		Message: "Database name:",
		Default: "rulebricks",
	}
	survey.AskOne(dbPrompt, &database)
	w.config.Database.External.Database = database

	// Username
	username := ""
	userPrompt := &survey.Input{
		Message: "Database username:",
		Default: "rulebricks",
	}
	survey.AskOne(userPrompt, &username)
	w.config.Database.External.Username = username

	// Password source
	fmt.Println("\nFor security, passwords should be provided via environment variables or files.")
	passSource := ""
	passPrompt := &survey.Select{
		Message: "How will you provide the database password?",
		Options: []string{
			"Environment variable",
			"File path",
			"Enter now (not recommended for production)",
		},
	}
	survey.AskOne(passPrompt, &passSource)

	switch passSource {
	case "Environment variable":
		envVar := ""
		envPrompt := &survey.Input{
			Message: "Environment variable name:",
			Default: "DB_PASSWORD",
		}
		survey.AskOne(envPrompt, &envVar)
		w.config.Database.External.PasswordFrom = fmt.Sprintf("env:%s", envVar)

	case "File path":
		filePath := ""
		filePrompt := &survey.Input{
			Message: "File path:",
			Default: "/run/secrets/db-password",
		}
		survey.AskOne(filePrompt, &filePath)
		w.config.Database.External.PasswordFrom = fmt.Sprintf("file:%s", filePath)

	case "Enter now (not recommended for production)":
		password := ""
		passPrompt := &survey.Password{
			Message: "Database password:",
		}
		survey.AskOne(passPrompt, &password)
		// Store temporarily, will be moved to secret management
		w.config.Database.External.PasswordFrom = fmt.Sprintf("plain:%s", password)
	}

	// SSL mode
	sslMode := ""
	sslPrompt := &survey.Select{
		Message: "SSL mode:",
		Options: []string{"require", "verify-full", "disable"},
		Default: "require",
		Help:    "SSL/TLS connection security level",
	}
	survey.AskOne(sslPrompt, &sslMode)
	w.config.Database.External.SSLMode = sslMode

	// Read replicas
	hasReplicas := false
	replicaPrompt := &survey.Confirm{
		Message: "Do you have read replicas?",
		Default: false,
		Help:    "Configure read replicas for better performance",
	}
	survey.AskOne(replicaPrompt, &hasReplicas)

	if hasReplicas {
		moreReplicas := true
		for moreReplicas {
			replica := struct {
				Host string `yaml:"host"`
				Port int    `yaml:"port"`
				Type string `yaml:"type"`
			}{
				Port: 5432,
				Type: "read",
			}

			replicaHost := ""
			hostPrompt := &survey.Input{
				Message: "Replica host:",
			}
			survey.AskOne(hostPrompt, &replicaHost)
			replica.Host = replicaHost

			w.config.Database.External.Replicas = append(
				w.config.Database.External.Replicas,
				replica,
			)

			survey.AskOne(&survey.Confirm{
				Message: "Add another replica?",
				Default: false,
			}, &moreReplicas)
		}
	}
}

func (w *ConfigWizard) configureEmail() {
	color.Yellow("\n📧 Email Configuration\n")

	providers := []string{
		"SMTP (Gmail, Office365, custom)",
		"Resend (API-based)",
		"SendGrid (API-based)",
		"Amazon SES",
		"Skip (configure later)",
	}

	provider := ""
	providerPrompt := &survey.Select{
		Message: "Select email provider:",
		Options: providers,
		Help:    "How to send transactional emails",
	}
	survey.AskOne(providerPrompt, &provider)

	if strings.Contains(provider, "Skip") {
		return
	}

	// From address
	from := ""
	fromPrompt := &survey.Input{
		Message: "From email address:",
		Default: fmt.Sprintf("noreply@%s", w.config.Project.Domain),
	}
	survey.AskOne(fromPrompt, &from)
	w.config.Email.From = from

	// From name
	fromName := ""
	namePrompt := &survey.Input{
		Message: "From name:",
		Default: "Rulebricks",
	}
	survey.AskOne(namePrompt, &fromName)
	w.config.Email.FromName = fromName

	switch {
	case strings.Contains(provider, "SMTP"):
		w.config.Email.Provider = "smtp"
		w.configureSMTPWithPresets()

	case strings.Contains(provider, "Resend"):
		w.config.Email.Provider = "smtp"
		w.config.Email.SMTP.Host = "smtp.resend.com"
		w.config.Email.SMTP.Port = 587
		w.config.Email.SMTP.Encryption = "starttls"
		w.config.Email.SMTP.Username = "resend"
		w.configureSMTPCredentials()

	case strings.Contains(provider, "SendGrid"):
		w.config.Email.Provider = "smtp"
		w.config.Email.SMTP.Host = "smtp.sendgrid.net"
		w.config.Email.SMTP.Port = 587
		w.config.Email.SMTP.Encryption = "starttls"
		w.configureSMTPCredentials()

	case strings.Contains(provider, "SES"):
		w.config.Email.Provider = "smtp"
		w.configureAWSSES()
	}

	// Email templates
	customTemplates := false
	templatePrompt := &survey.Confirm{
		Message: "Use custom email templates?",
		Default: false,
		Help:    "Customize the look of system emails",
	}
	survey.AskOne(templatePrompt, &customTemplates)

	if customTemplates {
		templatePath := ""
		pathPrompt := &survey.Input{
			Message: "Directory to download template files:",
			Default: "./email-templates",
			Help:    "We'll download the default templates here for you to customize",
		}
		survey.AskOne(pathPrompt, &templatePath)

		// Create directory if it doesn't exist
		if err := os.MkdirAll(templatePath, 0755); err != nil {
			color.Red("Failed to create directory: %v\n", err)
			return
		}

		// Download default templates
		fmt.Println("\n📥 Downloading default templates...")
		defaultTemplates := GetDefaultEmailTemplates()
		templates := map[string]string{
			"invite.html":        defaultTemplates.TemplateInvite,
			"confirmation.html":  defaultTemplates.TemplateConfirmation,
			"recovery.html":      defaultTemplates.TemplateRecovery,
			"email_change.html":  defaultTemplates.TemplateEmailChange,
		}

		for filename, url := range templates {
			filePath := filepath.Join(templatePath, filename)
			if err := downloadFile(filePath, url); err != nil {
				color.Red("Failed to download %s: %v\n", filename, err)
			} else {
				color.Green("✓ Downloaded %s\n", filename)
			}
		}

		fmt.Println("\n📝 Edit the templates in", templatePath, "then upload them to a publicly accessible location.")
		fmt.Println("Press Enter when ready to provide the URLs for your customized templates.\n")
		var ready string
		fmt.Scanln(&ready)

		// Prompt for custom template URLs
		fmt.Println("Enter the URLs for your customized templates:")

		inviteURL := ""
		invitePrompt := &survey.Input{
			Message: "Invite template URL:",
			Help:    "URL for your customized invite.html template",
		}
		survey.AskOne(invitePrompt, &inviteURL)
		if inviteURL != "" {
			w.config.Email.Templates.CustomInviteURL = inviteURL
		}

		confirmationURL := ""
		confirmPrompt := &survey.Input{
			Message: "Email confirmation template URL:",
			Help:    "URL for your customized confirmation.html template",
		}
		survey.AskOne(confirmPrompt, &confirmationURL)
		if confirmationURL != "" {
			w.config.Email.Templates.CustomConfirmationURL = confirmationURL
		}

		recoveryURL := ""
		recoveryPrompt := &survey.Input{
			Message: "Password recovery template URL:",
			Help:    "URL for your customized recovery.html template",
		}
		survey.AskOne(recoveryPrompt, &recoveryURL)
		if recoveryURL != "" {
			w.config.Email.Templates.CustomRecoveryURL = recoveryURL
		}

		emailChangeURL := ""
		changePrompt := &survey.Input{
			Message: "Email change template URL:",
			Help:    "URL for your customized email_change.html template",
		}
		survey.AskOne(changePrompt, &emailChangeURL)
		if emailChangeURL != "" {
			w.config.Email.Templates.CustomEmailChangeURL = emailChangeURL
		}
	}
}

func (w *ConfigWizard) configureSMTPWithPresets() {
	// Common SMTP presets
	presets := []string{
		"Gmail",
		"Office 365",
		"Custom SMTP server",
	}

	preset := ""
	presetPrompt := &survey.Select{
		Message: "SMTP preset:",
		Options: presets,
	}
	survey.AskOne(presetPrompt, &preset)

	switch preset {
	case "Gmail":
		w.config.Email.SMTP.Host = "smtp.gmail.com"
		w.config.Email.SMTP.Port = 587
		w.config.Email.SMTP.Encryption = "starttls"

	case "Office 365":
		w.config.Email.SMTP.Host = "smtp.office365.com"
		w.config.Email.SMTP.Port = 587
		w.config.Email.SMTP.Encryption = "starttls"

	case "Custom SMTP server":
		host := ""
		hostPrompt := &survey.Input{
			Message: "SMTP host:",
		}
		survey.AskOne(hostPrompt, &host)
		w.config.Email.SMTP.Host = host

		port := 587
		portPrompt := &survey.Input{
			Message: "SMTP port:",
			Default: "587",
		}
		survey.AskOne(portPrompt, &port)
		w.config.Email.SMTP.Port = port

		encryption := ""
		encPrompt := &survey.Select{
			Message: "Encryption:",
			Options: []string{"starttls", "tls", "none"},
			Default: "starttls",
		}
		survey.AskOne(encPrompt, &encryption)
		w.config.Email.SMTP.Encryption = encryption
	}

	w.configureSMTPCredentials()
}

func (w *ConfigWizard) configureSMTPCredentials() {
	// Username (if not already set)
	if w.config.Email.SMTP.Username == "" {
		username := ""
		userPrompt := &survey.Input{
			Message: "SMTP username:",
			Default: w.config.Email.From,
			Help:    "For Resend, use 'resend'. For Gmail/Office365, use your email address.",
		}
		survey.AskOne(userPrompt, &username)
		w.config.Email.SMTP.Username = username
	}

	// Password
	fmt.Println("\nFor security, SMTP passwords should be provided via environment variables.")
	envVar := ""
	envPrompt := &survey.Input{
		Message: "Environment variable for SMTP password:",
		Default: "SMTP_PASSWORD",
		Help:    "For Resend, this should be your API key. For others, use app-specific password.",
	}
	survey.AskOne(envPrompt, &envVar)
	w.config.Email.SMTP.PasswordFrom = fmt.Sprintf("env:%s", envVar)

	// Admin email for notifications
	adminEmail := ""
	adminPrompt := &survey.Input{
		Message: "Admin email for notifications:",
		Default: "support@rulebricks.com",
		Help:    "Email address for system notifications and errors",
	}
	survey.AskOne(adminPrompt, &adminEmail)
	w.config.Email.SMTP.AdminEmail = adminEmail
}

func (w *ConfigWizard) configureAWSSES() {
	// Prompt for region
	sesRegion := ""
	regionPrompt := &survey.Input{
		Message: "SES Region (e.g., us-east-1):",
		Default: "us-east-1",
	}
	survey.AskOne(regionPrompt, &sesRegion)
	w.config.Email.SMTP.Host = fmt.Sprintf("email-smtp.%s.amazonaws.com", sesRegion)
	w.config.Email.SMTP.Port = 587
	w.config.Email.SMTP.Encryption = "starttls"

	w.configureSMTPCredentials()
}

func (w *ConfigWizard) configureAPIEmail(defaultVar string) {
	fmt.Println("\nAPI keys should be provided via environment variables.")
	envVar := ""
	envPrompt := &survey.Input{
		Message: "Environment variable for API key:",
		Default: defaultVar,
	}
	survey.AskOne(envPrompt, &envVar)
	w.config.Email.APIKey = fmt.Sprintf("env:%s", envVar)
}

func (w *ConfigWizard) configureSMTP() {
	// This is the original configureSMTP function for backward compatibility
	w.configureSMTPWithPresets()
}

func (w *ConfigWizard) configureSecurity() {
	color.Yellow("\n🔒 Security Configuration\n")

	// TLS is always enabled for cloud deployments
	w.config.Security.TLS.Enabled = true
	w.config.Security.TLS.Provider = "letsencrypt"
	w.config.Security.TLS.AcmeEmail = w.config.Project.Email

	// Additional domains
	additionalDomains := false
	domainPrompt := &survey.Confirm{
		Message: "Configure additional domains?",
		Default: false,
		Help:    "Add multiple domains or wildcards",
	}
	survey.AskOne(domainPrompt, &additionalDomains)

	if additionalDomains {
		w.config.Security.TLS.Domains = []string{w.config.Project.Domain}

		// Wildcard subdomain
		wildcard := false
		wildcardPrompt := &survey.Confirm{
			Message: fmt.Sprintf("Add wildcard domain (*.%s)?", w.config.Project.Domain),
			Default: false,
		}
		survey.AskOne(wildcardPrompt, &wildcard)
		if wildcard {
			w.config.Security.TLS.Domains = append(
				w.config.Security.TLS.Domains,
				fmt.Sprintf("*.%s", w.config.Project.Domain),
			)
		}

		// Additional domains
		moreDomains := true
		for moreDomains {
			survey.AskOne(&survey.Confirm{
				Message: "Add another domain?",
				Default: false,
			}, &moreDomains)

			if moreDomains {
				domain := ""
				domainPrompt := &survey.Input{
					Message: "Domain:",
				}
				survey.AskOne(domainPrompt, &domain)
				if domain != "" {
					w.config.Security.TLS.Domains = append(
						w.config.Security.TLS.Domains,
						domain,
					)
				}
			}
		}
	}

	// Network security
	restrictIP := false
	ipPrompt := &survey.Confirm{
		Message: "Restrict access to specific IP addresses?",
		Default: false,
		Help:    "Limit access to your deployment",
	}
	survey.AskOne(ipPrompt, &restrictIP)

	if restrictIP {
		fmt.Println("\nEnter allowed IP addresses or CIDR ranges (one per line, empty line to finish):")
		w.config.Security.Network.AllowedIPs = []string{}

		for {
			fmt.Print("> ")
			ip, _ := w.reader.ReadString('\n')
			ip = strings.TrimSpace(ip)
			if ip == "" {
				break
			}
			w.config.Security.Network.AllowedIPs = append(
				w.config.Security.Network.AllowedIPs,
				ip,
			)
		}
	}

	// Rate limiting
	w.config.Security.Network.RateLimiting = true
	rateLimit := true
	ratePrompt := &survey.Confirm{
		Message: "Enable rate limiting?",
		Default: true,
		Help:    "Protect against abuse and DDoS",
	}
	survey.AskOne(ratePrompt, &rateLimit)
	w.config.Security.Network.RateLimiting = rateLimit

	// Secrets management
	w.config.Security.Secrets.Provider = "kubernetes"
	w.config.Security.Secrets.Encryption = true
}

func (w *ConfigWizard) configureAdvanced() {
	color.Yellow("\n⚙️  Advanced Configuration (Optional)\n")

	fmt.Println("Advanced options include:")
	fmt.Println("• Specific Rulebricks version selection")
	fmt.Println("• Terraform state backend (S3, GCS, Azure)")
	fmt.Println("• Monitoring with Prometheus/Grafana")
	fmt.Println("• Automated backup configuration")
	fmt.Println("• Custom Docker registry settings")
	fmt.Println()

	advanced := false
	advPrompt := &survey.Confirm{
		Message: "Configure advanced options?",
		Default: false,
		Help:    "Configure version, state management, monitoring, backups, and registry settings",
	}
	survey.AskOne(advPrompt, &advanced)

	if !advanced {
		// Set sensible defaults
		w.config.Monitoring.Enabled = true
		w.config.Monitoring.Provider = "prometheus"
		w.config.Monitoring.Logs.Level = "info"
		w.config.Monitoring.Logs.Retention = "7d"
		w.config.Monitoring.Metrics.Retention = "30d"
		w.config.Advanced.Backup.Enabled = true
		w.config.Advanced.Backup.Schedule = "0 2 * * *"
		w.config.Advanced.Backup.Retention = "30d"
		return
	}

	// Terraform backend
	fmt.Println("\n📦 Terraform State Management")
	backend := ""
	backendPrompt := &survey.Select{
		Message: "Terraform backend:",
		Options: []string{"local", "s3", "gcs", "azurerm"},
		Default: "local",
		Help:    "Where to store Terraform state",
	}
	survey.AskOne(backendPrompt, &backend)
	w.config.Advanced.Terraform.Backend = backend

	if backend != "local" {
		fmt.Println("\nConfigure backend settings in the generated config file.")
	}

	// Chart version
	fmt.Println("\n📦 Application Version")
	specifyVersion := false
	versionPrompt := &survey.Confirm{
		Message: "Specify a particular Rulebricks version to deploy?",
		Default: false,
		Help:    "By default, the latest version will be used",
	}
	survey.AskOne(versionPrompt, &specifyVersion)

	if specifyVersion {
		chartVersion := ""
		versionInput := &survey.Input{
			Message: "Rulebricks version (e.g., v1.2.3):",
			Help:    "The specific application version to deploy (`rulebricks upgrade list` to see available versions)",
		}
		survey.AskOne(versionInput, &chartVersion, survey.WithValidator(survey.Required))
		w.config.Project.Version = chartVersion
	}

	// Monitoring
	fmt.Println("\n📊 Monitoring & Observability")
	monitoring := true
	monPrompt := &survey.Confirm{
		Message: "Enable monitoring with Prometheus and Grafana?",
		Default: true,
		Help:    "Sets up Prometheus for metrics collection and Grafana for visualization dashboards",
	}
	survey.AskOne(monPrompt, &monitoring)
	w.config.Monitoring.Enabled = monitoring

	if monitoring {
		// Always use Prometheus
		w.config.Monitoring.Provider = "prometheus"

		// Log level
		logLevel := ""
		logPrompt := &survey.Select{
			Message: "Log level:",
			Options: []string{"debug", "info", "warn", "error"},
			Default: "info",
		}
		survey.AskOne(logPrompt, &logLevel)
		w.config.Monitoring.Logs.Level = logLevel

		// Retention
		w.config.Monitoring.Logs.Retention = "7d"
		w.config.Monitoring.Metrics.Retention = "30d"
	}

	// Backups
	fmt.Println("\n💾 Backup Configuration")
	backup := true
	backupPrompt := &survey.Confirm{
		Message: "Enable automatic backups?",
		Default: true,
	}
	survey.AskOne(backupPrompt, &backup)
	w.config.Advanced.Backup.Enabled = backup

	if backup {
		w.config.Advanced.Backup.Schedule = "0 2 * * *"
		w.config.Advanced.Backup.Retention = "30d"

		provider := ""
		provPrompt := &survey.Select{
			Message: "Backup storage:",
			Options: []string{"s3", "gcs", "azure-blob"},
			Help:    "Where to store backups",
		}
		survey.AskOne(provPrompt, &provider)
		w.config.Advanced.Backup.Provider = provider
	}

	// Docker Registry
	fmt.Println("\n🐳 Docker Registry Configuration")
	customRegistry := false
	registryPrompt := &survey.Confirm{
		Message: "Use custom Docker registry?",
		Default: false,
		Help:    "Configure private registry for Rulebricks images",
	}
	survey.AskOne(registryPrompt, &customRegistry)

	if customRegistry {
		// App image
		appImage := ""
		appPrompt := &survey.Input{
			Message: "App image repository:",
			Default: "index.docker.io/rulebricks/app",
			Help:    "Full path to your Rulebricks app image",
		}
		survey.AskOne(appPrompt, &appImage)
		w.config.Advanced.DockerRegistry.AppImage = appImage

		// HPS image
		hpsImage := ""
		hpsPrompt := &survey.Input{
			Message: "HPS image repository:",
			Default: "index.docker.io/rulebricks/hps",
			Help:    "Full path to your Rulebricks HPS image",
		}
		survey.AskOne(hpsPrompt, &hpsImage)
		w.config.Advanced.DockerRegistry.HPSImage = hpsImage

		// Note: Registry authentication is handled separately via deployment secrets
	}
}

func (w *ConfigWizard) configureAI() {
	color.Yellow("\n🤖 AI Features Configuration\n")

	// Ask if they want to enable AI features
	enableAI := false
	enablePrompt := &survey.Confirm{
		Message: "Would you like to enable AI features in Rulebricks?",
		Default: false,
		Help:    "AI features include intelligent rule suggestions, natural language rule creation, and AI-powered data transformations",
	}
	survey.AskOne(enablePrompt, &enableAI)
	w.config.AI.Enabled = enableAI

	if enableAI {
		fmt.Println("\n📝 To use AI features, you'll need an OpenAI API key.")
		fmt.Println("You can get one from: https://platform.openai.com/api-keys")

		// Ask for OpenAI API key
		var apiKey string
		keyPrompt := &survey.Password{
			Message: "Enter your OpenAI API key:",
			Help:    "This key will be securely stored and used for AI features",
		}
		survey.AskOne(keyPrompt, &apiKey)

		// Store as environment variable reference
		if apiKey != "" {
			w.config.AI.OpenAIAPIKeyFrom = "env:OPENAI_API_KEY"
			// Store in secrets for later use
			os.Setenv("OPENAI_API_KEY", apiKey)
		}
	}
}

func (w *ConfigWizard) configureLogging() {
	color.Yellow("\n📊 Rule Execution Logging Configuration\n")

	// Logging is now mandatory for high-volume request processing
	fmt.Println("Rulebricks uses Kafka for high-volume request processing and worker execution.")
	fmt.Println("Vector will consume logs from Kafka for centralized log collection.")
	fmt.Println()

	// Set logging as enabled
	w.config.Logging.Enabled = true

	// Configure Kafka and Vector settings
	w.configureKafkaSettings()
	w.configureVectorLogging()
}

func (w *ConfigWizard) configureKafkaSettings() {
	fmt.Println("\n📊 Configure Kafka retention policy for execution messages and logs.")

	retention := 24
	retentionPrompt := &survey.Input{
		Message: "Log retention period (hours):",
		Default: "24",
		Help:    "How long to keep messages in Kafka before automatic deletion (default: 24 hours)",
	}
	survey.AskOne(retentionPrompt, &retention)

	// Ensure retention is at least 1 hour
	if retention < 1 {
		retention = 24
	}
	w.config.Performance.KafkaRetentionHours = retention

	fmt.Printf("✅ Kafka messages will be retained for %d hours\n", retention)
}

func (w *ConfigWizard) configureVectorLogging() {
	fmt.Println("\n🚀 Vector will consume logs from Kafka and forward to your chosen destination.")

	// Ask for sink type
	sinkType := ""
	sinkPrompt := &survey.Select{
		Message: "Where should Vector send the logs?",
		Options: []string{
			"Elasticsearch",
			"Datadog",
			"Grafana Loki",
			"AWS S3",
			"Azure Blob Storage",
			"Google Cloud Storage",
			"Splunk",
			"New Relic",
			"Custom HTTP endpoint",
		},
		Help: "Select your logging backend provider",
	}
	survey.AskOne(sinkPrompt, &sinkType)

	// Map friendly names to Vector sink types
	sinkTypeMap := map[string]string{
		"Elasticsearch":       "elasticsearch",
		"Datadog":            "datadog_logs",
		"Grafana Loki":       "loki",
		"AWS S3":             "aws_s3",
		"Azure Blob Storage": "azure_blob",
		"Google Cloud Storage": "gcp_cloud_storage",
		"Splunk":             "splunk_hec",
		"New Relic":          "new_relic_logs",
		"Custom HTTP endpoint": "http",
	}
	w.config.Logging.Vector.Sink.Type = sinkTypeMap[sinkType]

	// Configure sink-specific settings
	switch sinkType {
	case "Elasticsearch":
		endpoint := ""
		endpointPrompt := &survey.Input{
			Message: "Elasticsearch endpoint (e.g., https://my-cluster.es.io:9200):",
			Help:    "The URL of your Elasticsearch cluster",
		}
		survey.AskOne(endpointPrompt, &endpoint)
		w.config.Logging.Vector.Sink.Endpoint = endpoint

		// Ask for credentials
		useAuth := false
		authPrompt := &survey.Confirm{
			Message: "Does your Elasticsearch require authentication?",
			Default: true,
		}
		survey.AskOne(authPrompt, &useAuth)

		if useAuth {
			username := ""
			userPrompt := &survey.Input{
				Message: "Elasticsearch username:",
				Default: "elastic",
				Help:    "Username for basic authentication",
			}
			survey.AskOne(userPrompt, &username)

			password := ""
			passPrompt := &survey.Password{
				Message: "Elasticsearch password:",
				Help:    "Password for basic authentication",
			}
			survey.AskOne(passPrompt, &password)

			if username != "" && password != "" {
				w.config.Logging.Vector.Sink.Config = map[string]string{
					"auth_user": username,
				}
				w.config.Logging.Vector.Sink.APIKey = "env:VECTOR_ES_PASSWORD"
				os.Setenv("VECTOR_ES_PASSWORD", password)
			}
		}

	case "Datadog":
		site := ""
		sitePrompt := &survey.Select{
			Message: "Datadog site:",
			Options: []string{"datadoghq.com", "datadoghq.eu", "us3.datadoghq.com", "us5.datadoghq.com", "ddog-gov.com"},
			Default: "datadoghq.com",
		}
		survey.AskOne(sitePrompt, &site)

		apiKey := ""
		keyPrompt := &survey.Password{
			Message: "Enter Datadog API key:",
			Help:    "Your Datadog API key for log ingestion",
		}
		survey.AskOne(keyPrompt, &apiKey)

		if apiKey != "" {
			w.config.Logging.Vector.Sink.APIKey = "env:DATADOG_API_KEY"
			os.Setenv("DATADOG_API_KEY", apiKey)
			w.config.Logging.Vector.Sink.Config = map[string]string{
				"site": site,
			}
		}

	case "Grafana Loki":
		endpoint := ""
		endpointPrompt := &survey.Input{
			Message: "Loki endpoint (e.g., http://loki:3100):",
			Help:    "The URL of your Loki instance",
		}
		survey.AskOne(endpointPrompt, &endpoint)
		w.config.Logging.Vector.Sink.Endpoint = endpoint

	case "AWS S3":
		bucket := ""
		bucketPrompt := &survey.Input{
			Message: "S3 bucket name:",
			Help:    "The name of your S3 bucket for logs",
		}
		survey.AskOne(bucketPrompt, &bucket)

		region := ""
		regionPrompt := &survey.Input{
			Message: "AWS region:",
			Default: "us-east-1",
		}
		survey.AskOne(regionPrompt, &region)

		// Ask for AWS credentials
		useIAM := false
		iamPrompt := &survey.Confirm{
			Message: "Use IAM role for authentication?",
			Default: false,
			Help:    "If running on EC2/EKS with IAM roles, you can skip entering credentials",
		}
		survey.AskOne(iamPrompt, &useIAM)

		w.config.Logging.Vector.Sink.Config = map[string]string{
			"bucket": bucket,
			"region": region,
		}

		if !useIAM {
			accessKeyID := ""
			keyPrompt := &survey.Input{
				Message: "AWS Access Key ID:",
				Help:    "Your AWS access key ID for S3 access",
			}
			survey.AskOne(keyPrompt, &accessKeyID)

			secretKey := ""
			secretPrompt := &survey.Password{
				Message: "AWS Secret Access Key:",
				Help:    "Your AWS secret access key",
			}
			survey.AskOne(secretPrompt, &secretKey)

			if accessKeyID != "" && secretKey != "" {
				// Store credentials as environment variables
				os.Setenv("AWS_ACCESS_KEY_ID", accessKeyID)
				os.Setenv("AWS_SECRET_ACCESS_KEY", secretKey)
				w.config.Logging.Vector.Sink.Config["auth_type"] = "credentials"
			}
		} else {
			w.config.Logging.Vector.Sink.Config["auth_type"] = "iam"
		}

	case "Azure Blob Storage":
		containerName := ""
		containerPrompt := &survey.Input{
			Message: "Azure Storage container name:",
			Help:    "The name of your Azure blob container for logs",
		}
		survey.AskOne(containerPrompt, &containerName)

		connectionString := ""
		connPrompt := &survey.Password{
			Message: "Azure Storage connection string:",
			Help:    "Your Azure Storage connection string (starts with DefaultEndpointsProtocol=...)",
		}
		survey.AskOne(connPrompt, &connectionString)

		if connectionString != "" {
			w.config.Logging.Vector.Sink.APIKey = "env:AZURE_CONNECTION_STRING"
			os.Setenv("AZURE_CONNECTION_STRING", connectionString)
			w.config.Logging.Vector.Sink.Config = map[string]string{
				"container_name": containerName,
			}
		}

	case "Google Cloud Storage":
		bucket := ""
		bucketPrompt := &survey.Input{
			Message: "GCS bucket name:",
			Help:    "The name of your GCS bucket for logs",
		}
		survey.AskOne(bucketPrompt, &bucket)

		// Ask if they want to use service account key
		useKey := false
		keyPrompt := &survey.Confirm{
			Message: "Use service account key file?",
			Default: false,
			Help:    "Otherwise, will use default credentials (GKE workload identity, etc.)",
		}
		survey.AskOne(keyPrompt, &useKey)

		w.config.Logging.Vector.Sink.Config = map[string]string{
			"bucket": bucket,
		}

		if useKey {
			keyPath := ""
			pathPrompt := &survey.Input{
				Message: "Service account key file path:",
				Help:    "Path to your GCP service account JSON key file",
			}
			survey.AskOne(pathPrompt, &keyPath)
			if keyPath != "" {
				w.config.Logging.Vector.Sink.Config["credentials_path"] = keyPath
			}
		}

	case "Splunk":
		endpoint := ""
		endpointPrompt := &survey.Input{
			Message: "Splunk HEC endpoint (e.g., https://splunk.example.com:8088):",
			Help:    "Your Splunk HTTP Event Collector endpoint",
		}
		survey.AskOne(endpointPrompt, &endpoint)
		w.config.Logging.Vector.Sink.Endpoint = endpoint

		token := ""
		tokenPrompt := &survey.Password{
			Message: "Splunk HEC token:",
			Help:    "Your Splunk HTTP Event Collector token",
		}
		survey.AskOne(tokenPrompt, &token)

		if token != "" {
			w.config.Logging.Vector.Sink.APIKey = "env:SPLUNK_HEC_TOKEN"
			os.Setenv("SPLUNK_HEC_TOKEN", token)
		}

		// Ask about index
		index := ""
		indexPrompt := &survey.Input{
			Message: "Splunk index (optional):",
			Default: "main",
			Help:    "The Splunk index to send logs to",
		}
		survey.AskOne(indexPrompt, &index)
		if index != "" {
			w.config.Logging.Vector.Sink.Config = map[string]string{
				"index": index,
			}
		}

	case "New Relic":
		// Ask for region
		region := ""
		regionPrompt := &survey.Select{
			Message: "New Relic region:",
			Options: []string{"US", "EU"},
			Default: "US",
		}
		survey.AskOne(regionPrompt, &region)

		apiKey := ""
		keyPrompt := &survey.Password{
			Message: "New Relic License Key:",
			Help:    "Your New Relic license key for log ingestion",
		}
		survey.AskOne(keyPrompt, &apiKey)

		if apiKey != "" {
			w.config.Logging.Vector.Sink.APIKey = "env:NEW_RELIC_LICENSE_KEY"
			os.Setenv("NEW_RELIC_LICENSE_KEY", apiKey)

			// Store region in config for New Relic
			w.config.Logging.Vector.Sink.Config = map[string]string{
				"region": region,
			}
		}

	case "Custom HTTP endpoint":
		endpoint := ""
		endpointPrompt := &survey.Input{
			Message: "HTTP endpoint URL:",
			Help:    "The URL where Vector should POST logs",
		}
		survey.AskOne(endpointPrompt, &endpoint)
		w.config.Logging.Vector.Sink.Endpoint = endpoint

		// Ask for auth header
		useAuth := false
		authPrompt := &survey.Confirm{
			Message: "Does the endpoint require authentication?",
			Default: false,
		}
		survey.AskOne(authPrompt, &useAuth)

		if useAuth {
			authHeader := ""
			headerPrompt := &survey.Input{
				Message: "Authorization header value:",
				Help:    "e.g., Bearer <token>",
			}
			survey.AskOne(headerPrompt, &authHeader)
			if authHeader != "" {
				w.config.Logging.Vector.Sink.Config = map[string]string{
					"auth_header": authHeader,
				}
			}
		}

	default:
		// For other providers, just collect the basic endpoint/config
		fmt.Printf("\nPlease configure %s-specific settings in the generated config file.\n", sinkType)
	}
}

func (w *ConfigWizard) configurePerformanceAndScaling() {
	color.Yellow("\n🚀 Performance & Scaling Configuration\n")

	fmt.Println("Let's optimize Rulebricks for your expected workload.")
	fmt.Println("This will also configure Kafka settings for worker execution and optimal performance.")
	fmt.Println()

	// Ask about expected volume
	volumeLevel := ""
	volumePrompt := &survey.Select{
		Message: "What's your expected solution volume?",
		Options: []string{
			"Low (0-1,000 solutions/second)",
			"Medium (1,000-10,000 solutions/second)",
			"High (10,000-100,000 solutions/second)",
		},
		Default: "Low (0-1,000 solutions/second)",
		Help:    "This helps us configure appropriate resources and scaling policies",
	}
	survey.AskOne(volumePrompt, &volumeLevel)

	// Ask about load pattern
	loadPattern := ""
	patternPrompt := &survey.Select{
		Message: "What's your typical load pattern?",
		Options: []string{
			"Steady (consistent load throughout the day)",
			"Variable (peaks and valleys throughout the day)",
			"Spiky (sudden bursts of high traffic)",
		},
		Default: "Variable (peaks and valleys throughout the day)",
		Help:    "This helps us configure scaling responsiveness",
	}
	survey.AskOne(patternPrompt, &loadPattern)

	// Configure based on selections
	switch volumeLevel {
	case "Low (0-1,000 solutions/second)":
		// Low volume configuration
		w.config.Performance.VolumeLevel = "low"
		w.config.Performance.HPSReplicas = 1
		w.config.Performance.HPSMaxReplicas = 4
		w.config.Performance.HPSWorkerReplicas = 2
		w.config.Performance.KafkaPartitions = 12
		w.config.Performance.HPSWorkerMaxReplicas = 10
		w.config.Performance.KafkaLagThreshold = 50

		// Kafka configuration
		w.config.Performance.KafkaPartitions = 12
		w.config.Performance.KafkaStorageSize = "50Gi"
		w.config.Performance.KafkaReplicationFactor = 2
		w.config.Performance.KafkaRetentionHours = 24

		// Resources
		w.config.Performance.HPSResources.Requests.CPU = "250m"
		w.config.Performance.HPSResources.Requests.Memory = "256Mi"
		w.config.Performance.HPSResources.Limits.CPU = "500m"
		w.config.Performance.HPSResources.Limits.Memory = "512Mi"

		w.config.Performance.WorkerResources.Requests.CPU = "100m"
		w.config.Performance.WorkerResources.Requests.Memory = "128Mi"
		w.config.Performance.WorkerResources.Limits.CPU = "250m"
		w.config.Performance.WorkerResources.Limits.Memory = "256Mi"

	case "Medium (1,000-10,000 solutions/second)":
		// Medium volume configuration
		w.config.Performance.VolumeLevel = "medium"
		w.config.Performance.HPSReplicas = 2
		w.config.Performance.HPSMaxReplicas = 8
		w.config.Performance.HPSWorkerReplicas = 5
		w.config.Performance.KafkaPartitions = 36
		w.config.Performance.HPSWorkerMaxReplicas = 30
		w.config.Performance.KafkaLagThreshold = 100

		// Kafka configuration
		w.config.Performance.KafkaPartitions = 36
		w.config.Performance.KafkaStorageSize = "100Gi"
		w.config.Performance.KafkaReplicationFactor = 2
		w.config.Performance.KafkaRetentionHours = 24

		// Resources
		w.config.Performance.HPSResources.Requests.CPU = "500m"
		w.config.Performance.HPSResources.Requests.Memory = "512Mi"
		w.config.Performance.HPSResources.Limits.CPU = "1000m"
		w.config.Performance.HPSResources.Limits.Memory = "1Gi"

		w.config.Performance.WorkerResources.Requests.CPU = "200m"
		w.config.Performance.WorkerResources.Requests.Memory = "256Mi"
		w.config.Performance.WorkerResources.Limits.CPU = "500m"
		w.config.Performance.WorkerResources.Limits.Memory = "512Mi"

	case "High (10,000-100,000 solutions/second)":
		// High volume configuration - wide scaling range for flexibility
		w.config.Performance.VolumeLevel = "high"
		w.config.Performance.HPSReplicas = 3
		w.config.Performance.HPSMaxReplicas = 20             // Scale HPS for high connection volume
		w.config.Performance.HPSWorkerReplicas = 5          // Start lower to save costs
		w.config.Performance.KafkaPartitions = 600          // Support up to 500 workers
		w.config.Performance.HPSWorkerMaxReplicas = 500     // Very high ceiling
		w.config.Performance.KafkaLagThreshold = 150        // More sensitive to lag

		// Kafka configuration
		w.config.Performance.KafkaPartitions = 600
		w.config.Performance.KafkaStorageSize = "500Gi"
		w.config.Performance.KafkaReplicationFactor = 3
		w.config.Performance.KafkaRetentionHours = 24

		// Resources - higher limits for better per-instance performance
		w.config.Performance.HPSResources.Requests.CPU = "1000m"
		w.config.Performance.HPSResources.Requests.Memory = "1Gi"
		w.config.Performance.HPSResources.Limits.CPU = "4000m"      // 4 CPU cores
		w.config.Performance.HPSResources.Limits.Memory = "4Gi"     // 4GB RAM

		w.config.Performance.WorkerResources.Requests.CPU = "500m"
		w.config.Performance.WorkerResources.Requests.Memory = "512Mi"
		w.config.Performance.WorkerResources.Limits.CPU = "2000m"   // 2 CPU cores
		w.config.Performance.WorkerResources.Limits.Memory = "2Gi"  // 2GB RAM
	}

	// Configure scaling behavior based on load pattern
	switch loadPattern {
	case "Steady (consistent load throughout the day)":
		// Conservative scaling for steady load
		w.config.Performance.ScaleUpStabilization = 60    // Wait 60s before scaling up
		w.config.Performance.ScaleDownStabilization = 300 // Wait 5 min before scaling down
		w.config.Performance.KedaPollingInterval = 30     // Check every 30s

	case "Variable (peaks and valleys throughout the day)":
		// Balanced scaling for variable load
		w.config.Performance.ScaleUpStabilization = 30    // Wait 30s before scaling up
		w.config.Performance.ScaleDownStabilization = 180 // Wait 3 min before scaling down
		w.config.Performance.KedaPollingInterval = 15     // Check every 15s

	case "Spiky (sudden bursts of high traffic)":
		// Aggressive scaling for spiky load
		w.config.Performance.ScaleUpStabilization = 0     // Scale up immediately
		w.config.Performance.ScaleDownStabilization = 120 // Wait 2 min before scaling down
		w.config.Performance.KedaPollingInterval = 10     // Check every 10s
	}

	// Ask about scale-down preferences for cost optimization
	if loadPattern != "Steady (consistent load throughout the day)" {
		costOptimize := false
		costPrompt := &survey.Confirm{
			Message: "Optimize for cost by scaling down more aggressively during low traffic?",
			Default: true,
			Help:    "This may cause slight delays when traffic increases again",
		}
		survey.AskOne(costPrompt, &costOptimize)

		if costOptimize {
			// More aggressive scale down
			w.config.Performance.ScaleDownStabilization = 60 // Only 1 minute
		}
	}

	fmt.Printf("\n✅ Configured for %s volume with %s load pattern\n",
		strings.ToLower(strings.Split(volumeLevel, " ")[0]),
		strings.ToLower(strings.Split(loadPattern, " ")[0]))
}

func (w *ConfigWizard) showSummary() {
	color.Green("\n✅ Configuration Summary\n")

	fmt.Printf("Project:     %s\n", w.config.Project.Name)
	fmt.Printf("Domain:      %s\n", w.config.Project.Domain)
	fmt.Printf("Cloud:       %s (%s)\n", w.config.Cloud.Provider, w.config.Cloud.Region)
	fmt.Printf("Database:    %s %s\n", w.config.Database.Type, w.config.Database.Provider)
	fmt.Printf("Email:       %s\n", w.config.Email.Provider)
	fmt.Printf("Monitoring:  %v\n", w.config.Monitoring.Enabled)
	fmt.Printf("AI Features: %v\n", w.config.AI.Enabled)
	fmt.Printf("Logging:     Enabled (Kafka + Vector → %s)\n", w.config.Logging.Vector.Sink.Type)
	if w.config.Performance.VolumeLevel != "" {
		fmt.Printf("Performance: %s volume, %d HPS workers\n",
			w.config.Performance.VolumeLevel,
			w.config.Performance.HPSWorkerReplicas)
	}
	fmt.Printf("Backups:     %v\n", w.config.Advanced.Backup.Enabled)

	fmt.Println("\n📝 Your configuration will be saved to: rulebricks.yaml")
	fmt.Println("📚 You can edit this file manually before deployment.")
}

// downloadFile downloads a file from URL to the specified path
func downloadFile(filepath string, url string) error {
	resp, err := http.Get(url)
	if err != nil {
		return err
	}
	defer resp.Body.Close()

	out, err := os.Create(filepath)
	if err != nil {
		return err
	}
	defer out.Close()

	_, err = io.Copy(out, resp.Body)
	return err
}

// Helper function to read password securely
func readPassword(prompt string) (string, error) {
	fmt.Print(prompt)
	// Use os.Stdin for better portability
	password, err := term.ReadPassword(int(os.Stdin.Fd()))
	fmt.Println()
	return string(password), err
}
