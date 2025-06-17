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
		config: Config{Version: "1.0"},
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
	w.configureSecurity()

	// Step 6: Optional advanced features
	w.configureAdvanced()

	// Summary
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
			Message: "Template directory path:",
			Default: "./email-templates",
			Help:    "Directory containing HTML email templates",
		}
		survey.AskOne(pathPrompt, &templatePath)
		w.config.Email.Templates.Path = templatePath

		// Template variables
		fmt.Println("\nDefine template variables (press Enter to skip):")
		w.config.Email.Templates.Variables = make(map[string]string)

		vars := []string{"company_name", "support_email", "logo_url", "website_url"}
		for _, v := range vars {
			value := ""
			varPrompt := &survey.Input{
				Message: fmt.Sprintf("%s:", v),
			}
			survey.AskOne(varPrompt, &value)
			if value != "" {
				w.config.Email.Templates.Variables[v] = value
			}
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

	advanced := false
	advPrompt := &survey.Confirm{
		Message: "Configure advanced options?",
		Default: false,
		Help:    "Terraform backend, monitoring, backups, etc.",
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

	// Monitoring
	fmt.Println("\n📊 Monitoring & Observability")
	monitoring := true
	monPrompt := &survey.Confirm{
		Message: "Enable monitoring?",
		Default: true,
	}
	survey.AskOne(monPrompt, &monitoring)
	w.config.Monitoring.Enabled = monitoring

	if monitoring {
		provider := ""
		provPrompt := &survey.Select{
			Message: "Monitoring provider:",
			Options: []string{"prometheus", "datadog", "cloudwatch"},
			Default: "prometheus",
		}
		survey.AskOne(provPrompt, &provider)
		w.config.Monitoring.Provider = provider

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


}

func (w *ConfigWizard) showSummary() {
	color.Green("\n✅ Configuration Summary\n")

	fmt.Printf("Project:     %s\n", w.config.Project.Name)
	fmt.Printf("Domain:      %s\n", w.config.Project.Domain)
	fmt.Printf("Cloud:       %s (%s)\n", w.config.Cloud.Provider, w.config.Cloud.Region)
	fmt.Printf("Database:    %s %s\n", w.config.Database.Type, w.config.Database.Provider)
	fmt.Printf("Email:       %s\n", w.config.Email.Provider)
	fmt.Printf("Monitoring:  %v\n", w.config.Monitoring.Enabled)
	fmt.Printf("Backups:     %v\n", w.config.Advanced.Backup.Enabled)

	fmt.Println("\n📝 Your configuration will be saved to: rulebricks.yaml")
	fmt.Println("📚 You can edit this file manually before deployment.")
}

// Helper function to read password securely
func readPassword(prompt string) (string, error) {
	fmt.Print(prompt)
	// Use os.Stdin for better portability
	password, err := term.ReadPassword(int(os.Stdin.Fd()))
	fmt.Println()
	return string(password), err
}
