// supabase_operations.go - Supabase deployment and configuration
package main

import (
	"encoding/base64"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strings"
	"time"
	"github.com/fatih/color"
)

// SupabaseOperations handles Supabase deployment and configuration
type SupabaseOperations struct {
	config        Config
	verbose       bool
	projectRef    string
	anonKey       string
	serviceKey    string
	jwtSecret     string
	dbPassword    string
	dashboardPass string
	secrets       map[string]string
	sharedSecrets *SharedSecrets
	assetManager  *AssetManager
	chartVersion  string
}

// NewSupabaseOperations creates a new Supabase operations handler
func NewSupabaseOperations(config Config, verbose bool, chartVersion string) *SupabaseOperations {
	// Create asset manager if we have a license key
	var assetManager *AssetManager
	if config.Project.License != "" {
		am, err := NewAssetManager(config.Project.License, ".rulebricks", verbose)
		if err != nil && verbose {
			fmt.Printf("Warning: Failed to create asset manager: %v\n", err)
		} else {
			assetManager = am
		}
	}

	return &SupabaseOperations{
		config:       config,
		verbose:      verbose,
		assetManager: assetManager,
		chartVersion: chartVersion,
	}
}

// Deploy handles Supabase deployment based on type
func (s *SupabaseOperations) Deploy() error {
	switch s.config.Database.Type {
	case "managed":
		return s.deployManaged()
	case "self-hosted":
		return s.deploySelfHosted()
	case "external":
		// External database still uses self-hosted Supabase
		// but configured to use the external PostgreSQL
		return s.deploySelfHostedWithExternalDB()
	default:
		return fmt.Errorf("unsupported database type: %s", s.config.Database.Type)
	}
}

// deployManaged creates and configures a managed Supabase project
func (s *SupabaseOperations) deployManaged() error {
	fmt.Println("☁️  Configuring Managed Supabase...")

	// Check if Supabase CLI is installed
	if err := s.checkSupabaseCLI(); err != nil {
		return err
	}

	// Ensure authenticated
	if err := s.ensureAuthenticated(); err != nil {
		return err
	}

	// Get organization ID
	orgID, err := s.getOrganizationID()
	if err != nil {
		return err
	}

	// Check if project already exists
	projectExists, err := s.checkProjectExists()
	if err != nil {
		return err
	}

	if projectExists {
		fmt.Printf("📌 Using existing Supabase project: %s\n", s.config.Database.Supabase.ProjectName)
		s.projectRef, err = s.getProjectRef()
		if err != nil {
			return err
		}
	} else {
		// Create new project
		if err := s.createProject(orgID); err != nil {
			return err
		}
	}

	// Ensure Supabase assets are available before linking
	if s.verbose {
		fmt.Println("📦 Checking for Supabase assets...")
	}
	if err := s.EnsureSupabaseAssets(); err != nil {
		return fmt.Errorf("failed to ensure Supabase assets: %w", err)
	}

	// Link the project
	if err := s.linkProject(); err != nil {
		return err
	}

	// Configure project
	if err := s.configureProject(); err != nil {
		return err
	}

	// Push database schema
	if err := s.PushDatabaseSchema(false); err != nil {
		return err
	}

	// Get API keys
	if err := s.getAPIKeys(); err != nil {
		return err
	}

	// Store credentials
	s.config.Database.External.Host = fmt.Sprintf("%s.supabase.co", s.projectRef)
	s.config.Database.External.Port = 5432
	s.config.Database.External.Database = "postgres"
	s.config.Database.External.Username = "postgres"

	fmt.Println("✅ Managed Supabase deployment complete!")
	return nil
}

// deploySelfHosted deploys Supabase in Kubernetes
func (s *SupabaseOperations) deploySelfHosted() error {
	fmt.Println("🗄️  Deploying self-hosted Supabase...")

	// Generate secrets
	s.jwtSecret = generateRandomString(32)
	s.anonKey = generateJWT("anon", s.jwtSecret)
	s.serviceKey = generateJWT("service_role", s.jwtSecret)
	s.dbPassword = generateDatabasePassword()
	s.dashboardPass = generateRandomString(16)

	// Create Helm values
	values := s.createSelfHostedValues()

	// Deploy with Helm
	if err := s.deploySupabaseHelm(values); err != nil {
		return err
	}

	// Wait for deployment to be ready
	if err := s.waitForSupabaseReady(); err != nil {
		return err
	}

	// Run migrations
	if err := s.RunMigrations(); err != nil {
		return err
	}

	fmt.Println("✅ Self-hosted Supabase deployment complete!")
	return nil
}

// deploySelfHostedWithExternalDB deploys Supabase with external PostgreSQL
func (s *SupabaseOperations) deploySelfHostedWithExternalDB() error {
	fmt.Println("🔗 Deploying Supabase with external PostgreSQL...")

	// Validate external database connection
	if err := s.validateExternalDatabase(); err != nil {
		return err
	}

	// Generate secrets for Supabase services
	s.jwtSecret = generateRandomString(32)
	s.anonKey = generateJWT("anon", s.jwtSecret)
	s.serviceKey = generateJWT("service_role", s.jwtSecret)
	s.dashboardPass = generateRandomString(16)

	// Create Helm values with external DB config
	values := s.createExternalDBValues()

	// Deploy with Helm
	if err := s.deploySupabaseHelm(values); err != nil {
		return err
	}

	// Wait for deployment to be ready
	if err := s.waitForSupabaseReady(); err != nil {
		return err
	}

	// Run migrations on external database
	if err := s.RunMigrationsExternal(); err != nil {
		return err
	}

	fmt.Println("✅ Supabase with external database deployment complete!")
	return nil
}

// checkSupabaseCLI verifies Supabase CLI is installed
func (s *SupabaseOperations) checkSupabaseCLI() error {
	cmd := exec.Command("supabase", "--version")
	if err := cmd.Run(); err != nil {
		return fmt.Errorf("Supabase CLI not found. Please install it from https://supabase.com/docs/guides/cli")
	}
	return nil
}

// ensureAuthenticated ensures Supabase CLI is authenticated
func (s *SupabaseOperations) ensureAuthenticated() error {
	cmd := exec.Command("supabase", "projects", "list")
	output, err := cmd.CombinedOutput()

	if err != nil || strings.Contains(string(output), "not logged in") {
		fmt.Println("🔐 Please authenticate with Supabase...")
		loginCmd := exec.Command("supabase", "login")
		loginCmd.Stdin = os.Stdin
		loginCmd.Stdout = os.Stdout
		loginCmd.Stderr = os.Stderr

		if err := loginCmd.Run(); err != nil {
			return fmt.Errorf("failed to authenticate with Supabase: %w", err)
		}
	}

	return nil
}

// getOrganizationID retrieves the first organization ID
func (s *SupabaseOperations) getOrganizationID() (string, error) {
	cmd := exec.Command("supabase", "orgs", "list")
	output, err := cmd.Output()
	if err != nil {
		return "", fmt.Errorf("failed to list organizations: %w", err)
	}

	// Extract organization ID using regex
	re := regexp.MustCompile(`[a-z]{20}`)
	matches := re.FindAllString(string(output), -1)

	if len(matches) == 0 {
		return "", fmt.Errorf("no organizations found")
	}

	return matches[0], nil
}

// checkProjectExists checks if a project with the configured name exists
func (s *SupabaseOperations) checkProjectExists() (bool, error) {
	cmd := exec.Command("supabase", "projects", "list")
	output, err := cmd.Output()
	if err != nil {
		return false, fmt.Errorf("failed to list projects: %w", err)
	}

	return strings.Contains(string(output), s.config.Database.Supabase.ProjectName), nil
}

// getProjectRef retrieves the project reference ID
func (s *SupabaseOperations) getProjectRef() (string, error) {
	cmd := exec.Command("supabase", "projects", "list")
	output, err := cmd.Output()
	if err != nil {
		return "", fmt.Errorf("failed to list projects: %w", err)
	}

	// Use the same parsing logic as setup.sh:
	// grep -F "$SUPABASE_PROJECT_NAME" | awk -F'│' '{print $3}' | tr -d ' ' | tail -n1
	lines := strings.Split(string(output), "\n")
	var matchingLines []string

	// Find all lines containing the project name
	for _, line := range lines {
		if strings.Contains(line, s.config.Database.Supabase.ProjectName) {
			matchingLines = append(matchingLines, line)
		}
	}

	if len(matchingLines) == 0 {
		return "", fmt.Errorf("project not found: %s", s.config.Database.Supabase.ProjectName)
	}

	// Take the last matching line (equivalent to tail -n1)
	lastLine := matchingLines[len(matchingLines)-1]

	// Split by │ and take the 3rd field (awk uses 1-based indexing, so $3 = index 2)
	parts := strings.Split(lastLine, "│")
	if len(parts) < 4 { // Need at least 4 parts to have a valid 3rd field
		return "", fmt.Errorf("invalid project list format")
	}

	// Get the 3rd field and trim spaces
	ref := strings.TrimSpace(parts[2])

	// Basic validation
	if ref == "" {
		return "", fmt.Errorf("empty project reference")
	}

	return ref, nil
}

// createProject creates a new Supabase project
func (s *SupabaseOperations) createProject(orgID string) error {
	fmt.Printf("🚀 Creating new Supabase project: %s\n", s.config.Database.Supabase.ProjectName)

	// Generate database password
	s.dbPassword = generateDatabasePassword()

	// Determine region
	region := s.config.Database.Supabase.Region
	if region == "" {
		region = s.config.Cloud.Region
	}

	// Create project
	cmd := exec.Command("supabase", "projects", "create",
		s.config.Database.Supabase.ProjectName,
		"--db-password", s.dbPassword,
		"--region", region,
		"--org-id", orgID)

	// Capture output to extract project reference
	output, err := cmd.CombinedOutput()
	if err != nil {
		return fmt.Errorf("failed to create project: %w\nOutput: %s", err, string(output))
	}

	if s.verbose {
		fmt.Println(string(output))
	}

	// Extract project reference from output
	// The output typically contains: "Created a new project <project-name> with id <project-ref>"
	// or similar format
	outputStr := string(output)

	// Try multiple regex patterns to find the project reference
	patterns := []string{
		`with id ([a-z0-9]{20,})`,           // "with id <ref>"
		`project id: ([a-z0-9]{20,})`,       // "project id: <ref>"
		`([a-z0-9]{20,})`,                   // Just find any 20+ char alphanumeric string
	}

	for _, pattern := range patterns {
		re := regexp.MustCompile(pattern)
		matches := re.FindStringSubmatch(outputStr)
		if len(matches) > 1 {
			s.projectRef = matches[1]
			break
		}
	}

	if s.projectRef == "" {
		// If we couldn't extract from output, fall back to listing projects
		fmt.Println("⏳ Waiting for Supabase project to be ready (this may take a few minutes)...")
		time.Sleep(200 * time.Second)

		s.projectRef, err = s.getProjectRef()
		if err != nil {
			return fmt.Errorf("failed to get project reference: %w\nCreate output was: %s", err, outputStr)
		}
	} else {
		// Still wait for project to be ready
		fmt.Println("⏳ Waiting for Supabase project to be ready (this may take a few minutes)...")
		time.Sleep(200 * time.Second)
	}

	fmt.Printf("✅ Project created with reference: %s\n", s.projectRef)
	return nil
}

// linkProject links the local project to Supabase
func (s *SupabaseOperations) linkProject() error {
	fmt.Println("🔗 Linking to Supabase project...")

	// Ensure we're in the supabase directory
	if err := os.Chdir("supabase"); err != nil {
		return fmt.Errorf("failed to change to supabase directory: %w", err)
	}
	defer os.Chdir("..")

	cmd := exec.Command("supabase", "link",
		"--project-ref", s.projectRef,
		"--password", s.dbPassword)

	if s.verbose {
		cmd.Stdout = os.Stdout
		cmd.Stderr = os.Stderr
		return cmd.Run()
	}

	// Capture output for error reporting
	output, err := cmd.CombinedOutput()
	if err != nil {
		return fmt.Errorf("supabase link failed: %w\nOutput: %s", err, string(output))
	}

	return nil
}

// configureProject configures the Supabase project
func (s *SupabaseOperations) configureProject() error {
	fmt.Println("⚙️  Configuring Supabase project...")

	// Create config.toml from template
	configTemplate := filepath.Join("supabase", "config.example.toml")
	configFile := filepath.Join("supabase", "config.toml")

	// Read template
	templateData, err := os.ReadFile(configTemplate)
	if err != nil {
		return fmt.Errorf("failed to read config template: %w", err)
	}

	// Replace variables
	config := strings.ReplaceAll(string(templateData), "env(FULL_URL)", fmt.Sprintf("https://%s", s.config.Project.Domain))

	// Write config
	if err := os.WriteFile(configFile, []byte(config), 0644); err != nil {
		return fmt.Errorf("failed to write config: %w", err)
	}
	defer os.Remove(configFile)

	// Push configuration
	fmt.Println("📤 Pushing configuration to Supabase...")

	// Change to supabase directory
	if err := os.Chdir("supabase"); err != nil {
		return fmt.Errorf("failed to change directory: %w", err)
	}
	defer os.Chdir("..")

	// Push auth configuration
	cmd := exec.Command("supabase", "config", "push", "--project-ref", s.projectRef)
	cmd.Stdin = strings.NewReader("Y\n") // Auto-confirm

	if s.verbose {
		cmd.Stdout = os.Stdout
		cmd.Stderr = os.Stderr
	}

	if err := cmd.Run(); err != nil {
		return fmt.Errorf("failed to push config: %w", err)
	}

	// Enable SSL enforcement
	fmt.Println("🔒 Enabling SSL enforcement...")
	sslCmd := exec.Command("supabase", "ssl-enforcement", "update",
		"--enable-db-ssl-enforcement",
		"--project-ref", s.projectRef,
		"--experimental")

	if err := sslCmd.Run(); err != nil {
		// Non-fatal, just warn
		color.Yellow("⚠️  Failed to enable SSL enforcement: %v\n", err)
	}

	return nil
}

// PushDatabaseSchema pushes the database schema to Supabase
func (s *SupabaseOperations) PushDatabaseSchema(dryRun bool) error {
	if dryRun {
		fmt.Println("📊 Checking database migrations (dry run)...")
	} else {
		fmt.Println("📊 Pushing database schema...")
	}

	// Change to supabase directory
	if err := os.Chdir("supabase"); err != nil {
		return fmt.Errorf("failed to change directory: %w", err)
	}
	defer os.Chdir("..")

	var cmd *exec.Cmd

	switch s.config.Database.Type {
	case "managed":
		// For managed Supabase, ensure we're linked first
		if err := s.ensureLinked(); err != nil {
			return fmt.Errorf("failed to ensure Supabase link: %w", err)
		}
		if dryRun {
			cmd = exec.Command("supabase", "db", "push", "--include-all", "--dry-run")
		} else {
			cmd = exec.Command("supabase", "db", "push", "--include-all")
		}

	case "self-hosted", "external":
		// For self-hosted/external, use --db-url flag
		dbURL, err := s.getConnectionURL()
		if err != nil {
			return fmt.Errorf("failed to get database connection URL: %w", err)
		}
		if dryRun {
			cmd = exec.Command("supabase", "db", "push", "--include-all", "--db-url", dbURL, "--dry-run")
		} else {
			cmd = exec.Command("supabase", "db", "push", "--include-all", "--db-url", dbURL)
		}

	default:
		return fmt.Errorf("unsupported database type: %s", s.config.Database.Type)
	}

	cmd.Stdin = strings.NewReader("Y\n") // Auto-confirm

	if s.verbose || dryRun {
		cmd.Stdout = os.Stdout
		cmd.Stderr = os.Stderr
		return cmd.Run()
	}

	// For non-verbose, non-dry-run mode, capture output for error reporting
	output, err := cmd.CombinedOutput()
	if err != nil {
		return fmt.Errorf("supabase db push failed: %w\nOutput: %s", err, string(output))
	}

	return nil
}

// getAPIKeys retrieves the API keys
func (s *SupabaseOperations) getAPIKeys() error {
	fmt.Println("🔑 Retrieving API keys...")

	cmd := exec.Command("supabase", "projects", "api-keys",
		"--project-ref", s.projectRef)

	output, err := cmd.Output()
	if err != nil {
		return fmt.Errorf("failed to get API keys: %w", err)
	}

	// Parse output to extract keys
	lines := strings.Split(string(output), "\n")
	for _, line := range lines {
		if strings.Contains(line, "anon") && !strings.Contains(line, "service_role") {
			fields := strings.Fields(line)
			if len(fields) > 0 {
				s.anonKey = fields[len(fields)-1]
			}
		} else if strings.Contains(line, "service_role") {
			fields := strings.Fields(line)
			if len(fields) > 0 {
				s.serviceKey = fields[len(fields)-1]
			}
		}
	}

	// Sanitize keys
	s.anonKey = sanitizeJWT(s.anonKey)
	s.serviceKey = sanitizeJWT(s.serviceKey)

	if s.anonKey == "" || s.serviceKey == "" {
		return fmt.Errorf("failed to extract API keys")
	}

	return nil
}

// createSelfHostedValues creates Helm values for self-hosted deployment
func (s *SupabaseOperations) createSelfHostedValues() map[string]interface{} {
	values := map[string]interface{}{
		"global": map[string]interface{}{
			"jwt": map[string]interface{}{
				"secret":     s.jwtSecret,
				"anonKey":    s.anonKey,
				"serviceKey": s.serviceKey,
			},
			"smtp": s.createSMTPConfig(),
		},
		"db": map[string]interface{}{
			"enabled": true,
			"image": map[string]interface{}{
				"tag": "15.1.0.147",
			},
			"auth": map[string]interface{}{
				"username": "postgres",
				"password": s.dbPassword,
				"database": "postgres",
			},
			"persistence": map[string]interface{}{
				"enabled": true,
				"size":    "20Gi",
			},
		},
		"studio": map[string]interface{}{
			"enabled": true,
			"image": map[string]interface{}{
				"tag": "20231123-64a766a",
			},
			"auth": map[string]interface{}{
				"password": s.dashboardPass,
			},
		},
		"auth": map[string]interface{}{
			"enabled": true,
			"image": map[string]interface{}{
				"tag": "v2.132.3",
			},
			"env": s.createAuthEnv(),
		},
		"rest": map[string]interface{}{
			"enabled": true,
			"image": map[string]interface{}{
				"tag": "v12.0.1",
			},
		},
		"realtime": map[string]interface{}{
			"enabled": true,
			"image": map[string]interface{}{
				"tag": "v2.25.50",
			},
		},
		"storage": map[string]interface{}{
			"enabled": true,
			"image": map[string]interface{}{
				"tag": "v0.46.4",
			},
			"persistence": map[string]interface{}{
				"enabled": true,
				"size":    "10Gi",
			},
		},
		"kong": map[string]interface{}{
			"enabled": true,
			"image": map[string]interface{}{
				"tag": "2.8.1",
			},
			"ingress": map[string]interface{}{
				"enabled":   true,
				"className": "traefik",
				"annotations": map[string]interface{}{
					"cert-manager.io/cluster-issuer": "letsencrypt-prod",
				},
				"hosts": []map[string]interface{}{
					{
						"host": fmt.Sprintf("supabase.%s", s.config.Project.Domain),
						"paths": []map[string]interface{}{
							{
								"path":     "/",
								"pathType": "Prefix",
							},
						},
					},
				},
				"tls": []map[string]interface{}{
					{
						"secretName": "supabase-tls",
						"hosts": []string{
							fmt.Sprintf("supabase.%s", s.config.Project.Domain),
						},
					},
				},
			},
		},
	}

	// Add backup configuration if enabled for self-hosted
	if s.config.Advanced.Backup.Enabled {
		backupConfig := map[string]interface{}{
			"enabled":   true,
			"schedule":  s.config.Advanced.Backup.Schedule,
			"retention": s.config.Advanced.Backup.Retention,
			"provider":  s.config.Advanced.Backup.Provider,
		}

		// Add provider-specific configuration
		switch s.config.Advanced.Backup.Provider {
		case "s3":
			if s.config.Advanced.Backup.ProviderConfig != nil {
				backupConfig["s3"] = s.config.Advanced.Backup.ProviderConfig
			}
		case "gcs":
			if s.config.Advanced.Backup.ProviderConfig != nil {
				backupConfig["gcs"] = s.config.Advanced.Backup.ProviderConfig
			}
		case "azure-blob":
			if s.config.Advanced.Backup.ProviderConfig != nil {
				backupConfig["azure"] = s.config.Advanced.Backup.ProviderConfig
			}
		}

		values["backup"] = backupConfig
	}

	return values
}

// createExternalDBValues creates Helm values for external database
func (s *SupabaseOperations) createExternalDBValues() map[string]interface{} {
	values := s.createSelfHostedValues()

	// Disable internal database
	values["db"] = map[string]interface{}{
		"enabled": false,
	}

	// Configure services to use external database
	dbURL := fmt.Sprintf("postgresql://%s:%s@%s:%d/%s?sslmode=%s",
	s.config.Database.External.Username,
	s.secrets["db_password"],
	s.config.Database.External.Host,
	s.config.Database.External.Port,
	s.config.Database.External.Database,
	s.config.Database.External.SSLMode,
)

	// Update auth service
	authEnv := values["auth"].(map[string]interface{})["env"].(map[string]interface{})
	authEnv["DATABASE_URL"] = dbURL

	// Update rest service
	values["rest"].(map[string]interface{})["env"] = map[string]interface{}{
		"PGRST_DB_URI": dbURL,
	}

	// Update realtime service
	values["realtime"].(map[string]interface{})["env"] = map[string]interface{}{
		"DB_HOST":     s.config.Database.External.Host,
		"DB_PORT":     fmt.Sprintf("%d", s.config.Database.External.Port),
		"DB_USER":     s.config.Database.External.Username,
		"DB_PASSWORD": s.secrets["db_password"],
		"DB_NAME":     s.config.Database.External.Database,
		"DB_SSL":      s.config.Database.External.SSLMode != "disable",
	}

	// Update storage service
	values["storage"].(map[string]interface{})["env"] = map[string]interface{}{
		"DATABASE_URL": dbURL,
	}

	return values
}

// createAuthEnv creates environment variables for auth service
func (s *SupabaseOperations) createAuthEnv() map[string]interface{} {
	env := map[string]interface{}{
		"GOTRUE_SITE_URL":               fmt.Sprintf("https://%s", s.config.Project.Domain),
		"GOTRUE_URI_ALLOW_LIST":         fmt.Sprintf("https://%s,https://%s/*,https://%s/auth/changepass,https://%s/settings/password,https://%s/dashboard", s.config.Project.Domain, s.config.Project.Domain, s.config.Project.Domain, s.config.Project.Domain, s.config.Project.Domain),
		"API_EXTERNAL_URL":              fmt.Sprintf("https://supabase.%s", s.config.Project.Domain),
		"GOTRUE_JWT_EXP":                "3600",
		"GOTRUE_JWT_DEFAULT_GROUP_NAME": "authenticated",
		"GOTRUE_JWT_ADMIN_ROLES":        "service_role",
		"GOTRUE_JWT_AUD":                "authenticated",
		"GOTRUE_DISABLE_SIGNUP":         "false",
		"GOTRUE_EXTERNAL_EMAIL_ENABLED": "true",
		"GOTRUE_MAILER_AUTOCONFIRM":     "false",
		"GOTRUE_MAILER_SECURE_EMAIL_CHANGE_ENABLED": "false",
		"GOTRUE_EXTERNAL_ANONYMOUS_USERS_ENABLED":   "false",
		"GOTRUE_EXTERNAL_MANUAL_LINKING_ENABLED":    "false",
		"GOTRUE_RATE_LIMIT_EMAIL_SENT":              "3600",
		"GOTRUE_RATE_LIMIT_SMS_SENT":                "3600",
		"GOTRUE_RATE_LIMIT_VERIFY":                  "3600",
		"GOTRUE_RATE_LIMIT_TOKEN_REFRESH":           "150",
		"GOTRUE_SECURITY_REFRESH_TOKEN_ROTATION_ENABLED": "true",
		"GOTRUE_SECURITY_REFRESH_TOKEN_REUSE_INTERVAL":   "10",
		"GOTRUE_MAILER_SUBJECTS_INVITE":        "Join your team on Rulebricks",
		"GOTRUE_MAILER_SUBJECTS_CONFIRMATION":  "Confirm Your Email",
		"GOTRUE_MAILER_SUBJECTS_RECOVERY":      "Reset Your Password",
		"GOTRUE_MAILER_SUBJECTS_EMAIL_CHANGE":  "Confirm Email Change",
		"GOTRUE_MAILER_TEMPLATES_INVITE":       "https://prefix-files.s3.us-west-2.amazonaws.com/templates/invite.html",
		"GOTRUE_MAILER_TEMPLATES_CONFIRMATION": "https://prefix-files.s3.us-west-2.amazonaws.com/templates/verify.html",
		"GOTRUE_MAILER_TEMPLATES_RECOVERY":     "https://prefix-files.s3.us-west-2.amazonaws.com/templates/password_change.html",
		"GOTRUE_MAILER_TEMPLATES_EMAIL_CHANGE": "https://prefix-files.s3.us-west-2.amazonaws.com/templates/email_change.html",
	}

	// Add SMTP configuration if configured
	if s.config.Email.Provider == "smtp" {
		env["GOTRUE_SMTP_HOST"] = s.config.Email.SMTP.Host
		env["GOTRUE_SMTP_PORT"] = fmt.Sprintf("%d", s.config.Email.SMTP.Port)
		env["GOTRUE_SMTP_USER"] = s.config.Email.SMTP.Username
		env["GOTRUE_SMTP_PASS"] = s.secrets["smtp_password"]
		env["GOTRUE_SMTP_ADMIN_EMAIL"] = s.config.Email.SMTP.AdminEmail
		env["GOTRUE_SMTP_SENDER_NAME"] = s.config.Email.FromName
	}

	return env
}

// createSMTPConfig creates SMTP configuration
func (s *SupabaseOperations) createSMTPConfig() map[string]interface{} {
	if s.config.Email.Provider != "smtp" {
		return nil
	}

	return map[string]interface{}{
		"host":     s.config.Email.SMTP.Host,
		"port":     s.config.Email.SMTP.Port,
		"username": s.config.Email.SMTP.Username,
		"password": s.secrets["smtp_password"],
		"from":     s.config.Email.From,
		"fromName": s.config.Email.FromName,
	}
}

// deploySupabaseHelm deploys Supabase using Helm
func (s *SupabaseOperations) deploySupabaseHelm(values map[string]interface{}) error {
	fmt.Println("⚓ Deploying Supabase with Helm...")

	// Create temporary values file
	valuesFile, err := createTempValuesFile("supabase", values)
	if err != nil {
		return fmt.Errorf("failed to create values file: %w", err)
	}
	defer os.Remove(valuesFile)

	// Create namespace
	supabaseNamespace := s.getNamespace("supabase")
	cmd := exec.Command("kubectl", "create", "namespace", supabaseNamespace)
	cmd.Run() // Ignore error if namespace exists

	// Deploy with Helm
	cmd = exec.Command("helm", "upgrade", "--install", "supabase",
		"./charts/supabase",
		"--namespace", supabaseNamespace,
		"--values", valuesFile,
		"--wait",
		"--timeout", "15m")

	if s.verbose {
		cmd.Stdout = os.Stdout
		cmd.Stderr = os.Stderr
	}

	return cmd.Run()
}

// waitForSupabaseReady waits for Supabase to be ready
func (s *SupabaseOperations) waitForSupabaseReady() error {
	fmt.Println("⏳ Waiting for Supabase to be ready...")

	supabaseNamespace := s.getNamespace("supabase")
	cmd := exec.Command("kubectl", "wait", "--for=condition=ready",
		"pod", "-l", "app.kubernetes.io/instance=supabase",
		"--namespace", supabaseNamespace,
		"--timeout", "600s")

	return cmd.Run()
}

// RunMigrations runs database migrations
func (s *SupabaseOperations) RunMigrations() error {
	fmt.Println("🔄 Running database migrations...")

	// Ensure Supabase assets are available
	if err := s.EnsureSupabaseAssets(); err != nil {
		return fmt.Errorf("failed to ensure Supabase assets: %w", err)
	}

	// Get database pod
	supabaseNamespace := s.getNamespace("supabase")
	cmd := exec.Command("kubectl", "get", "pod",
		"-l", "app.kubernetes.io/name=supabase-db",
		"-n", supabaseNamespace,
		"-o", "jsonpath={.items[0].metadata.name}")

	output, err := cmd.Output()
	if err != nil {
		return fmt.Errorf("failed to get database pod: %w", err)
	}

	dbPod := strings.TrimSpace(string(output))

	// Copy migrations
	migrationsPath := filepath.Join("supabase", "migrations")
	cmd = exec.Command("kubectl", "cp", migrationsPath,
		fmt.Sprintf("%s/%s:/tmp/migrations", supabaseNamespace, dbPod))

	if err := cmd.Run(); err != nil {
		return fmt.Errorf("failed to copy migrations: %w", err)
	}

	// Run migrations
	cmd = exec.Command("kubectl", "exec", dbPod,
		"-n", supabaseNamespace,
		"--",
		"bash", "-c",
		fmt.Sprintf("cd /tmp/migrations && PGPASSWORD=%s psql -U postgres -d postgres -f init.sql", s.dbPassword))

	if s.verbose {
		cmd.Stdout = os.Stdout
		cmd.Stderr = os.Stderr
	}

	return cmd.Run()
}

// RunMigrationsExternal runs migrations on external database
func (s *SupabaseOperations) RunMigrationsExternal() error {
	fmt.Println("🔄 Running database migrations on external database...")

	// Ensure Supabase assets are available
	if err := s.EnsureSupabaseAssets(); err != nil {
		return fmt.Errorf("failed to ensure Supabase assets: %w", err)
	}

	// Create a temporary pod to run migrations
	supabaseNamespace := s.getNamespace("supabase")
	migrationPod := fmt.Sprintf(`
apiVersion: v1
kind: Pod
metadata:
  name: migration-runner
  namespace: %s
spec:
  restartPolicy: Never
  containers:
  - name: postgres
    image: postgres:15
    command: ["sleep", "3600"]
    env:
    - name: PGPASSWORD
      value: "%s"
`, supabaseNamespace, s.secrets["db_password"])

	// Create pod
	cmd := exec.Command("kubectl", "apply", "-f", "-")
	cmd.Stdin = strings.NewReader(migrationPod)

	if err := cmd.Run(); err != nil {
		return fmt.Errorf("failed to create migration pod: %w", err)
	}

	defer func() {
		// Clean up pod
		exec.Command("kubectl", "delete", "pod", "migration-runner", "-n", supabaseNamespace).Run()
	}()

	// Wait for pod to be ready
	cmd = exec.Command("kubectl", "wait", "--for=condition=ready",
		"pod/migration-runner",
		"--namespace", supabaseNamespace,
		"--timeout", "60s")

	if err := cmd.Run(); err != nil {
		return fmt.Errorf("migration pod failed to start: %w", err)
	}

	// Copy migrations
	migrationsPath := filepath.Join("supabase", "migrations")
	cmd = exec.Command("kubectl", "cp", migrationsPath,
		fmt.Sprintf("%s/migration-runner:/tmp/migrations", supabaseNamespace))

	if err := cmd.Run(); err != nil {
		return fmt.Errorf("failed to copy migrations: %w", err)
	}

	// Run migrations
	cmd = exec.Command("kubectl", "exec", "migration-runner",
		"-n", supabaseNamespace,
		"--",
		"bash", "-c",
		fmt.Sprintf("cd /tmp/migrations && psql -h %s -p %d -U %s -d %s -f init.sql",
			s.config.Database.External.Host,
			s.config.Database.External.Port,
			s.config.Database.External.Username,
			s.config.Database.External.Database))

	if s.verbose {
		cmd.Stdout = os.Stdout
		cmd.Stderr = os.Stderr
	}

	return cmd.Run()
}

// validateExternalDatabase validates external database connection
func (s *SupabaseOperations) validateExternalDatabase() error {
	fmt.Println("🔍 Validating external database connection...")

	// This would be implemented with actual database connection test
	// For now, we assume it's valid if configuration is provided

	if s.config.Database.External.Host == "" {
		return fmt.Errorf("external database host not configured")
	}

	if s.config.Database.External.Username == "" {
		return fmt.Errorf("external database username not configured")
	}

	fmt.Printf("✅ External database configured: %s:%d\n",
		s.config.Database.External.Host,
		s.config.Database.External.Port)

	return nil
}


// EnsureSupabaseAssets ensures Supabase assets are extracted from Docker image
func (s *SupabaseOperations) EnsureSupabaseAssets() error {
	// Only extract if we have an asset manager (requires license key)
	if s.assetManager == nil {
		// Check if supabase directory exists locally
		if _, err := os.Stat("supabase"); os.IsNotExist(err) {
			return fmt.Errorf("supabase directory not found and no license key provided to extract from Docker image")
		}
		// Local directory exists, use it
		if s.verbose {
			fmt.Println("✓ Using existing local Supabase directory")
		}
		return nil
	}

	// Get the Rulebricks image name with appropriate version
	var imageName string

	if s.config.Advanced.DockerRegistry.AppImage != "" {
		// Use custom image
		imageName = s.config.Advanced.DockerRegistry.AppImage

		// If custom image doesn't have a registry prefix, add docker.io
		if !strings.Contains(imageName, "/") || (!strings.Contains(strings.Split(imageName, "/")[0], ".") && !strings.Contains(strings.Split(imageName, "/")[0], ":")) {
			// Image is like "myimage" or "myorg/myimage" without registry
			// Docker Hub doesn't need explicit registry prefix
		}

		// If custom image doesn't have a tag, append the chartVersion
		if !strings.Contains(imageName, ":") {
			imageTag := s.chartVersion
			if imageTag == "" || imageTag == "latest" {
				imageTag = "latest"
			}
			imageName = fmt.Sprintf("%s:%s", imageName, imageTag)
		}
	} else {
		// Use default image with chartVersion
		imageTag := s.chartVersion
		if imageTag == "" || imageTag == "latest" {
			imageTag = "latest"
		}
		imageName = fmt.Sprintf("rulebricks/app:%s", imageTag)
	}

	// Extract Supabase assets if not already present
	if s.verbose {
		fmt.Printf("🐳 Using Docker image: %s\n", imageName)
	}
	return s.assetManager.EnsureSupabaseAssets(imageName, "supabase")
}


// ensureLinked ensures the local project is linked to managed Supabase
func (s *SupabaseOperations) ensureLinked() error {
	// This is only needed for managed Supabase
	if s.config.Database.Type != "managed" {
		return nil
	}

	// Check if we're already linked by reading the project ID from config
	configPath := filepath.Join("supabase", ".temp", "project-ref")

	// For managed, we need the project ref
	if s.projectRef == "" {
		// Try to read from stored config
		if data, err := os.ReadFile(configPath); err == nil {
			s.projectRef = strings.TrimSpace(string(data))
		} else {
			// Get project ref from the API
			var err error
			s.projectRef, err = s.getProjectRef()
			if err != nil {
				return fmt.Errorf("failed to get project reference: %w", err)
			}
		}
	}
	return s.linkProject()
}

// getConnectionURL returns the database connection URL for self-hosted or external databases
func (s *SupabaseOperations) getConnectionURL() (string, error) {
	// For upgrades, retrieve the database password from the existing deployment if not set
	if s.dbPassword == "" {
		// Try to get password from Kubernetes secret
		supabaseNamespace := s.getNamespace("supabase")
		secretCmd := exec.Command("kubectl", "get", "secret",
			"supabase-db", "-n", supabaseNamespace,
			"-o", "jsonpath={.data.password}")

		secretOutput, err := secretCmd.Output()
		if err == nil && len(secretOutput) > 0 {
			// Decode base64 password
			decodedPassword, err := base64.StdEncoding.DecodeString(string(secretOutput))
			if err == nil {
				s.dbPassword = string(decodedPassword)
			}
		}

		// If still no password, we can't proceed
		if s.dbPassword == "" {
			return "", fmt.Errorf("database password not available - ensure Supabase is deployed")
		}
	}

	switch s.config.Database.Type {
	case "self-hosted":
		// For self-hosted, connect to the PostgreSQL service in the cluster
		supabaseNamespace := s.getNamespace("supabase")
		return fmt.Sprintf("postgresql://postgres:%s@supabase-db.%s.svc.cluster.local:5432/postgres?sslmode=disable",
			s.dbPassword, supabaseNamespace), nil

	case "external":
		// For external database, use the configured connection details
		sslMode := s.config.Database.External.SSLMode
		if sslMode == "" {
			sslMode = "require"
		}
		return fmt.Sprintf("postgresql://%s:%s@%s:%d/%s?sslmode=%s",
			s.config.Database.External.Username,
			s.dbPassword,
			s.config.Database.External.Host,
			s.config.Database.External.Port,
			s.config.Database.External.Database,
			sslMode), nil

	default:
		return "", fmt.Errorf("unsupported database type for connection URL: %s", s.config.Database.Type)
	}
}

// Close cleans up resources
func (s *SupabaseOperations) Close() error {
	if s.assetManager != nil {
		return s.assetManager.Close()
	}
	return nil
}

// getNamespace returns the namespace for a component with project prefix
func (s *SupabaseOperations) getNamespace(component string) string {
	return GetDefaultNamespace(s.config.Project.Name, component)
}
