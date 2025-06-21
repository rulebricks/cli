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
	"gopkg.in/yaml.v3"
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
	chartManager  *ChartManager
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

	// Create chart manager for downloading Supabase chart
	chartManager, err := NewChartManager("", verbose)
	if err != nil && verbose {
		fmt.Printf("Warning: Failed to create chart manager: %v\n", err)
	}

	return &SupabaseOperations{
		config:       config,
		verbose:      verbose,
		assetManager: assetManager,
		chartVersion: chartVersion,
		chartManager: chartManager,
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

	// Ensure realtime tenant exists (workaround for Supabase Helm chart issue)
	s.ensureRealtimeTenant()

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

	// Ensure realtime tenant exists (workaround for Supabase Helm chart issue)
	s.ensureRealtimeTenant()

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
		fmt.Println("📊 Running database migrations...")
	}

	// Check if migrations directory exists
	if _, err := os.Stat("supabase/migrations"); os.IsNotExist(err) {
		fmt.Println("No migrations directory found, skipping...")
		return nil
	}

	switch s.config.Database.Type {
	case "managed":
		// For managed Supabase, use the standard db push command
		if err := s.ensureLinked(); err != nil {
			return fmt.Errorf("failed to ensure Supabase link: %w", err)
		}

		// Change to supabase directory
		if err := os.Chdir("supabase"); err != nil {
			return fmt.Errorf("failed to change directory: %w", err)
		}
		defer os.Chdir("..")

		var cmd *exec.Cmd
		if dryRun {
			cmd = exec.Command("supabase", "db", "push", "--include-all", "--dry-run")
		} else {
			cmd = exec.Command("supabase", "db", "push", "--include-all")
		}
		cmd.Stdin = strings.NewReader("Y\n")

		if s.verbose {
			cmd.Stdout = os.Stdout
			cmd.Stderr = os.Stderr
			return cmd.Run()
		}

		output, err := cmd.CombinedOutput()
		if err != nil {
			return fmt.Errorf("supabase db push failed: %w\nOutput: %s", err, string(output))
		}
		return nil

	case "self-hosted":
		// For self-hosted, run migrations directly on the database pod
		namespace := s.getNamespace("supabase")

		// Get the database pod name
		getDbPodCmd := exec.Command("kubectl", "get", "pod",
			"-n", namespace,
			"-l", "app.kubernetes.io/name=supabase-db,app.kubernetes.io/instance=supabase",
			"-o", "jsonpath={.items[0].metadata.name}")
		dbPodBytes, err := getDbPodCmd.Output()
		if err != nil {
			return fmt.Errorf("failed to get database pod: %w", err)
		}
		dbPod := strings.TrimSpace(string(dbPodBytes))
		if dbPod == "" {
			return fmt.Errorf("no database pod found")
		}

		// Copy migrations to the database pod
		copyCmd := exec.Command("kubectl", "cp", "-n", namespace,
			"./supabase/migrations", fmt.Sprintf("%s:/tmp/migrations", dbPod))
		if err := copyCmd.Run(); err != nil {
			return fmt.Errorf("failed to copy migrations: %w", err)
		}

		// Create migrations tracking table if it doesn't exist
		createTableCmd := fmt.Sprintf(`
			PGPASSWORD=%s psql -U postgres -d postgres -c "
			CREATE TABLE IF NOT EXISTS schema_migrations (
				version VARCHAR(255) PRIMARY KEY,
				applied_at TIMESTAMP DEFAULT NOW()
			);"
		`, s.dbPassword)

		cmd := exec.Command("kubectl", "exec", "-n", namespace, dbPod, "--", "bash", "-c", createTableCmd)
		if err := cmd.Run(); err != nil {
			return fmt.Errorf("failed to create migrations table: %w", err)
		}

		// Get list of already applied migrations
		getAppliedCmd := fmt.Sprintf(`
			PGPASSWORD=%s psql -U postgres -d postgres -t -c "
			SELECT version FROM schema_migrations;"
		`, s.dbPassword)

		cmd = exec.Command("kubectl", "exec", "-n", namespace, dbPod, "--", "bash", "-c", getAppliedCmd)
		appliedOutput, _ := cmd.Output()
		appliedMigrations := make(map[string]bool)
		for _, line := range strings.Split(string(appliedOutput), "\n") {
			migration := strings.TrimSpace(line)
			if migration != "" {
				appliedMigrations[migration] = true
			}
		}

		// Run migrations
		migrationScript := fmt.Sprintf(`
			cd /tmp/migrations
			for f in *.sql; do
				if [ -f "$f" ]; then
					# Check if migration was already applied
					applied=$(PGPASSWORD=%s psql -U postgres -d postgres -t -c "
						SELECT COUNT(*) FROM schema_migrations WHERE version='$f';")
					if [ "$(echo $applied | tr -d ' ')" = "0" ]; then
						echo "Running migration: $f"
						PGPASSWORD=%s psql -U postgres -d postgres -f "$f"
						if [ $? -eq 0 ]; then
							# Record successful migration
							PGPASSWORD=%s psql -U postgres -d postgres -c "
								INSERT INTO schema_migrations (version) VALUES ('$f');"
						else
							echo "Failed to run migration: $f"
							exit 1
						fi
					else
						echo "Skipping already applied migration: $f"
					fi
				fi
			done
		`, s.dbPassword, s.dbPassword, s.dbPassword)

		if dryRun {
			fmt.Println("Would run the following migrations:")
			// List migrations that would be run
			listCmd := exec.Command("kubectl", "exec", "-n", namespace, dbPod, "--",
				"bash", "-c", "ls -1 /tmp/migrations/*.sql 2>/dev/null | sort")
			output, _ := listCmd.Output()
			for _, file := range strings.Split(string(output), "\n") {
				if file != "" {
					filename := filepath.Base(file)
					if !appliedMigrations[filename] {
						fmt.Printf("  - %s\n", filename)
					}
				}
			}
		} else {
			cmd = exec.Command("kubectl", "exec", "-n", namespace, dbPod, "--", "bash", "-c", migrationScript)
			if s.verbose {
				cmd.Stdout = os.Stdout
				cmd.Stderr = os.Stderr
			}
			if err := cmd.Run(); err != nil {
				return fmt.Errorf("failed to run migrations: %w", err)
			}
		}

		// Clean up
		cleanupCmd := exec.Command("kubectl", "exec", "-n", namespace, dbPod, "--",
			"rm", "-rf", "/tmp/migrations")
		cleanupCmd.Run()

		fmt.Println("✅ Database migrations completed!")
		return nil

	case "external":
		// For external database, use RunMigrationsExternal
		if dryRun {
			fmt.Println("Would run migrations on external database")
			return nil
		}
		return s.RunMigrationsExternal()

	default:
		return fmt.Errorf("unsupported database type: %s", s.config.Database.Type)
	}
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

// loadChartValues loads values from a YAML file in the chart directory
func (s *SupabaseOperations) loadChartValues(chartPath string, filename string) (map[string]interface{}, error) {
	valuesPath := filepath.Join(chartPath, filename)

	data, err := os.ReadFile(valuesPath)
	if err != nil {
		return nil, fmt.Errorf("failed to read %s: %w", filename, err)
	}

	var values map[string]interface{}
	if err := yaml.Unmarshal(data, &values); err != nil {
		return nil, fmt.Errorf("failed to parse %s: %w", filename, err)
	}

	return values, nil
}

// mergeValues recursively merges override values into base values
func mergeValues(base, override map[string]interface{}) map[string]interface{} {
	result := make(map[string]interface{})

	// Copy base values
	for k, v := range base {
		result[k] = v
	}

	// Apply overrides
	for k, v := range override {
		if baseVal, exists := result[k]; exists {
			// If both are maps, merge recursively
			if baseMap, baseOk := baseVal.(map[string]interface{}); baseOk {
				if overrideMap, overrideOk := v.(map[string]interface{}); overrideOk {
					result[k] = mergeValues(baseMap, overrideMap)
					continue
				}
			}
		}
		// Otherwise, override the value
		result[k] = v
	}

	return result
}

// createSelfHostedValues creates Helm values for self-hosted deployment
func (s *SupabaseOperations) createSelfHostedValues() map[string]interface{} {
	// Generate analytics key if not set
	analyticsKey := generateRandomString(32)

	// Create complete values configuration with injected values
	// This mirrors what setup.sh does when creating values-selfhosted-configured.yaml
	values := map[string]interface{}{
		"secret": map[string]interface{}{
			"jwt": map[string]interface{}{
				"anonKey":    s.anonKey,
				"serviceKey": s.serviceKey,
				"secret":     s.jwtSecret,
			},
			"smtp": map[string]interface{}{
				"username": s.config.Email.SMTP.Username,
				"password": s.secrets["smtp_password"],
			},
			"db": map[string]interface{}{
				"username": "postgres",
				"password": s.dbPassword,
				"database": "postgres",
			},
			"analytics": map[string]interface{}{
				"apiKey": analyticsKey,
			},
			"dashboard": map[string]interface{}{
				"username": "supabase",
				"password": s.dashboardPass,
			},
		},
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
				"repository": "supabase/postgres",
				"tag":        "15.1.0.147",
				"pullPolicy": "IfNotPresent",
			},
			"persistence": map[string]interface{}{
				"enabled": true,
				"size":    "10Gi",
			},
			"auth": map[string]interface{}{
				"username": "postgres",
				"password": s.dbPassword,
				"database": "postgres",
			},
		},
		"studio": map[string]interface{}{
			"enabled": true,
			"image": map[string]interface{}{
				"repository": "supabase/studio",
				"tag":        "20231123-64a766a",
				"pullPolicy": "IfNotPresent",
			},
			"auth": map[string]interface{}{
				"password": s.dashboardPass,
			},
			"environment": map[string]interface{}{
				"SUPABASE_PUBLIC_URL":             fmt.Sprintf("https://supabase.%s", s.config.Project.Domain),
				"NEXT_PUBLIC_ENABLE_LOGS":         "true",
				"NEXT_ANALYTICS_BACKEND_PROVIDER": "postgres",
				"STUDIO_PG_META_URL":              "http://supabase-supabase-meta:8080",
				"POSTGRES_PASSWORD":               s.dbPassword,
				"DEFAULT_ORGANIZATION_NAME":       "Default Organization",
				"DEFAULT_PROJECT_NAME":            "Default Project",
				"SUPABASE_URL":                    "http://supabase-supabase-kong:8000",
			},
		},
		"auth": map[string]interface{}{
			"enabled": true,
			"image": map[string]interface{}{
				"repository": "supabase/gotrue",
				"tag":        "v2.132.3",
				"pullPolicy": "IfNotPresent",
			},
			"environment": s.createAuthEnv(),
		},
		"rest": map[string]interface{}{
			"enabled": true,
			"image": map[string]interface{}{
				"repository": "postgrest/postgrest",
				"tag":        "v12.0.1",
				"pullPolicy": "IfNotPresent",
			},
			"environment": map[string]interface{}{
				"PGRST_DB_SCHEMAS":            "public,storage,graphql_public",
				"PGRST_DB_EXTRA_SEARCH_PATH":  "public,extensions",
				"PGRST_DB_MAX_ROWS":           "1000",
				"PGRST_DB_ANON_ROLE":          "anon",
				"PGRST_JWT_AUD":               "authenticated",
			},
		},
		"realtime": map[string]interface{}{
			"enabled": true,
			"image": map[string]interface{}{
				"repository": "supabase/realtime",
				"tag":        "v2.25.50",
				"pullPolicy": "IfNotPresent",
			},
		},
		"meta": map[string]interface{}{
			"enabled": true,
			"image": map[string]interface{}{
				"repository": "supabase/postgres-meta",
				"tag":        "v0.75.0",
				"pullPolicy": "IfNotPresent",
			},
		},
		"storage": map[string]interface{}{
			"enabled": true,
			"image": map[string]interface{}{
				"repository": "supabase/storage-api",
				"tag":        "v0.46.4",
				"pullPolicy": "IfNotPresent",
			},
			"persistence": map[string]interface{}{
				"enabled": true,
				"size":    "10Gi",
			},
			"environment": map[string]interface{}{
				"FILE_SIZE_LIMIT":              "52428800",
				"STORAGE_BACKEND":              "file",
				"FILE_STORAGE_BACKEND_PATH":    "/var/lib/storage",
				"TENANT_ID":                    "stub",
				"REGION":                       "stub",
				"GLOBAL_S3_BUCKET":             "stub",
			},
		},
		"imgproxy": map[string]interface{}{
			"enabled": true,
			"image": map[string]interface{}{
				"repository": "darthsim/imgproxy",
				"tag":        "v3.8.0",
				"pullPolicy": "IfNotPresent",
			},
		},
		"kong": map[string]interface{}{
			"enabled": true,
			"image": map[string]interface{}{
				"repository": "kong",
				"tag":        "2.8.1",
				"pullPolicy": "IfNotPresent",
			},
			"ingress": map[string]interface{}{
				"enabled":   true,
				"className": "traefik",
				"annotations": map[string]interface{}{
					"traefik.ingress.kubernetes.io/router.entrypoints":   "websecure",
					"traefik.ingress.kubernetes.io/router.tls":           "true",
					"traefik.ingress.kubernetes.io/router.tls.certresolver": "le",
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
				"tls": []interface{}{},
			},
		},
		"analytics": map[string]interface{}{
			"enabled": true,
			"image": map[string]interface{}{
				"repository": "supabase/logflare",
				"tag":        "1.4.0",
				"pullPolicy": "IfNotPresent",
			},
		},
		"vector": map[string]interface{}{
			"enabled": true,
			"image": map[string]interface{}{
				"repository": "timberio/vector",
				"tag":        "0.28.1-alpine",
				"pullPolicy": "IfNotPresent",
			},
		},
		"functions": map[string]interface{}{
			"enabled": true,
			"image": map[string]interface{}{
				"repository": "supabase/edge-runtime",
				"tag":        "v1.29.1",
				"pullPolicy": "IfNotPresent",
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
	authEnv := values["auth"].(map[string]interface{})["environment"].(map[string]interface{})
	authEnv["DATABASE_URL"] = dbURL

	// Update rest service
	values["rest"].(map[string]interface{})["environment"] = map[string]interface{}{
		"PGRST_DB_URI": dbURL,
	}

	// Update realtime service
	values["realtime"].(map[string]interface{})["environment"] = map[string]interface{}{
		"DB_HOST":     s.config.Database.External.Host,
		"DB_PORT":     fmt.Sprintf("%d", s.config.Database.External.Port),
		"DB_USER":     s.config.Database.External.Username,
		"DB_PASSWORD": s.secrets["db_password"],
		"DB_NAME":     s.config.Database.External.Database,
		"DB_SSL":      s.config.Database.External.SSLMode != "disable",
	}

	// Update storage service
	values["storage"].(map[string]interface{})["environment"] = map[string]interface{}{
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
		"GOTRUE_MAILER_TEMPLATES_INVITE":       s.getTemplateURL("invite", "https://prefix-files.s3.us-west-2.amazonaws.com/templates/invite.html"),
		"GOTRUE_MAILER_TEMPLATES_CONFIRMATION": s.getTemplateURL("confirmation", "https://prefix-files.s3.us-west-2.amazonaws.com/templates/verify.html"),
		"GOTRUE_MAILER_TEMPLATES_RECOVERY":     s.getTemplateURL("recovery", "https://prefix-files.s3.us-west-2.amazonaws.com/templates/password_change.html"),
		"GOTRUE_MAILER_TEMPLATES_EMAIL_CHANGE": s.getTemplateURL("emailChange", "https://prefix-files.s3.us-west-2.amazonaws.com/templates/email_change.html"),
	}

	// Add SMTP configuration (provider is always SMTP)
	env["GOTRUE_SMTP_HOST"] = s.config.Email.SMTP.Host
	env["GOTRUE_SMTP_PORT"] = fmt.Sprintf("%d", s.config.Email.SMTP.Port)
	env["GOTRUE_SMTP_USER"] = s.config.Email.SMTP.Username
	env["GOTRUE_SMTP_PASS"] = s.secrets["smtp_password"]
	env["GOTRUE_SMTP_ADMIN_EMAIL"] = s.config.Email.SMTP.AdminEmail
	env["GOTRUE_SMTP_SENDER_NAME"] = s.config.Email.FromName

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

	// Download and extract Supabase chart
	var supabaseChartPath string
	if s.chartManager != nil && s.chartVersion != "" {
		// Pull the Supabase chart using ChartManager
		chartInfo, err := s.chartManager.PullSupabaseChart(s.chartVersion)
		if err != nil {
			return fmt.Errorf("failed to get Supabase chart: %w", err)
		}

		// Extract the chart
		extractedPath, err := s.chartManager.ExtractChart(chartInfo.CachedPath)
		if err != nil {
			return fmt.Errorf("failed to extract Supabase chart: %w", err)
		}
		defer os.RemoveAll(extractedPath)

		// The chart should be extracted as "supabase" directory
		supabaseChartPath = filepath.Join(extractedPath, "supabase")
	} else {
		// Fallback to local path
		supabaseChartPath = "./charts/supabase"
	}



	// Create namespace
	supabaseNamespace := s.getNamespace("supabase")
	cmd := exec.Command("kubectl", "create", "namespace", supabaseNamespace)
	cmd.Run() // Ignore error if namespace exists

	// Deploy with Helm
	cmd = exec.Command("helm", "upgrade", "--install", "supabase",
		supabaseChartPath,
		"--namespace", supabaseNamespace,
		"--reset-values",
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
	// Ensure Supabase assets are available
	if err := s.EnsureSupabaseAssets(); err != nil {
		return fmt.Errorf("failed to ensure Supabase assets: %w", err)
	}

	// Use PushDatabaseSchema which handles all database types correctly
	return s.PushDatabaseSchema(false)
}

// RunMigrationsExternal runs migrations on external database
func (s *SupabaseOperations) RunMigrationsExternal() error {
	fmt.Println("🔄 Running database migrations on external database...")

	// Check if migrations directory exists
	if _, err := os.Stat("supabase/migrations"); os.IsNotExist(err) {
		fmt.Println("No migrations directory found, skipping...")
		return nil
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

	// Create migrations tracking table if it doesn't exist
	createTableCmd := fmt.Sprintf(`psql -h %s -p %d -U %s -d %s -c "
		CREATE TABLE IF NOT EXISTS schema_migrations (
			version VARCHAR(255) PRIMARY KEY,
			applied_at TIMESTAMP DEFAULT NOW()
		);"`,
		s.config.Database.External.Host,
		s.config.Database.External.Port,
		s.config.Database.External.Username,
		s.config.Database.External.Database)

	cmd = exec.Command("kubectl", "exec", "migration-runner", "-n", supabaseNamespace, "--", "bash", "-c", createTableCmd)
	if err := cmd.Run(); err != nil {
		return fmt.Errorf("failed to create migrations table: %w", err)
	}

	// Run migrations with tracking
	migrationScript := fmt.Sprintf(`
		cd /tmp/migrations
		for f in *.sql; do
			if [ -f "$f" ]; then
				# Check if migration was already applied
				applied=$(psql -h %s -p %d -U %s -d %s -t -c "
					SELECT COUNT(*) FROM schema_migrations WHERE version='$f';")
				if [ "$(echo $applied | tr -d ' ')" = "0" ]; then
					echo "Running migration: $f"
					psql -h %s -p %d -U %s -d %s -f "$f"
					if [ $? -eq 0 ]; then
						# Record successful migration
						psql -h %s -p %d -U %s -d %s -c "
							INSERT INTO schema_migrations (version) VALUES ('$f');"
					else
						echo "Failed to run migration: $f"
						exit 1
					fi
				else
					echo "Skipping already applied migration: $f"
				fi
			fi
		done
	`,
		s.config.Database.External.Host, s.config.Database.External.Port,
		s.config.Database.External.Username, s.config.Database.External.Database,
		s.config.Database.External.Host, s.config.Database.External.Port,
		s.config.Database.External.Username, s.config.Database.External.Database,
		s.config.Database.External.Host, s.config.Database.External.Port,
		s.config.Database.External.Username, s.config.Database.External.Database)

	cmd = exec.Command("kubectl", "exec", "migration-runner", "-n", supabaseNamespace,
		"--", "bash", "-c", migrationScript)

	if s.verbose {
		cmd.Stdout = os.Stdout
		cmd.Stderr = os.Stderr
	}

	if err := cmd.Run(); err != nil {
		return fmt.Errorf("failed to run migrations: %w", err)
	}

	fmt.Println("✅ Database migrations completed!")
	return nil
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
		return fmt.Sprintf("postgresql://postgres:%s@supabase-supabase-db.%s.svc.cluster.local:5432/postgres?sslmode=disable",
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

// getTemplateURL returns custom template URL if configured, otherwise returns default
func (s *SupabaseOperations) getTemplateURL(templateType string, defaultURL string) string {
	switch templateType {
	case "invite":
		if s.config.Email.Templates.CustomInviteURL != "" {
			return s.config.Email.Templates.CustomInviteURL
		}
	case "confirmation":
		if s.config.Email.Templates.CustomConfirmationURL != "" {
			return s.config.Email.Templates.CustomConfirmationURL
		}
	case "recovery":
		if s.config.Email.Templates.CustomRecoveryURL != "" {
			return s.config.Email.Templates.CustomRecoveryURL
		}
	case "emailChange":
		if s.config.Email.Templates.CustomEmailChangeURL != "" {
			return s.config.Email.Templates.CustomEmailChangeURL
		}
	}
	return defaultURL
}

// ensureRealtimeTenant works around a Supabase Helm chart issue where the realtime
// service expects a different tenant ID than what the migrations create
func (s *SupabaseOperations) ensureRealtimeTenant() {
	namespace := s.getNamespace("supabase")

	// This is a non-critical operation - don't fail deployment if it errors
	cmd := exec.Command("kubectl", "exec", "-n", namespace,
		"deployment/supabase-supabase-db", "--",
		"psql", "-U", "supabase_admin", "-d", "postgres", "-c",
		`INSERT INTO _realtime.tenants SELECT gen_random_uuid(), 'supabase-supabase-realtime', name, jwt_secret, max_concurrent_users, max_events_per_second, postgres_cdc_default, max_bytes_per_second, max_channels_per_client, max_joins_per_second, NOW(), NOW() FROM _realtime.tenants WHERE external_id = 'realtime-dev' ON CONFLICT DO NOTHING;
		INSERT INTO _realtime.extensions SELECT gen_random_uuid(), type, settings, 'supabase-supabase-realtime', NOW(), NOW() FROM _realtime.extensions WHERE tenant_external_id = 'realtime-dev' AND NOT EXISTS (SELECT 1 FROM _realtime.extensions WHERE tenant_external_id = 'supabase-supabase-realtime');`)

	cmd.Run() // Ignore errors
}
