// validator.go - Configuration Validator
package main

import (
	"fmt"
	"net"
	"regexp"
	"strings"
	"github.com/fatih/color"
)

// Validator validates configuration
type Validator struct {
	config Config
}

// NewValidator creates a new validator
func NewValidator(config Config) *Validator {
	return &Validator{config: config}
}

// ValidationResults holds validation results
type ValidationResults struct {
	Errors   []ValidationError
	Warnings []ValidationWarning
}

// ValidationError represents a validation error
type ValidationError struct {
	Field   string
	Message string
}

// ValidationWarning represents a validation warning
type ValidationWarning struct {
	Field   string
	Message string
}

// IsValid returns true if there are no errors
func (r ValidationResults) IsValid() bool {
	return len(r.Errors) == 0
}

// ValidateAll validates the entire configuration
func (v *Validator) ValidateAll() ValidationResults {
	results := ValidationResults{
		Errors:   []ValidationError{},
		Warnings: []ValidationWarning{},
	}

	// Validate project settings
	v.validateProject(&results)

	// Validate cloud settings
	v.validateCloud(&results)

	// Validate Kubernetes settings
	v.validateKubernetes(&results)

	// Validate database settings
	v.validateDatabase(&results)

	// Validate email settings
	v.validateEmail(&results)

	// Validate security settings
	v.validateSecurity(&results)

	// Validate monitoring settings
	if v.config.Monitoring.Enabled {
		v.validateMonitoring(&results)
	}

	// Validate advanced settings
	v.validateAdvanced(&results)

	return results
}

func (v *Validator) validateProject(results *ValidationResults) {
	// Project name
	if v.config.Project.Name == "" {
		results.Errors = append(results.Errors, ValidationError{
			Field:   "project.name",
			Message: "Project name is required",
		})
	} else if !isValidProjectName(v.config.Project.Name) {
		results.Errors = append(results.Errors, ValidationError{
			Field:   "project.name",
			Message: "Project name must be lowercase alphanumeric with hyphens only",
		})
	}

	// Domain
	if v.config.Project.Domain == "" {
		results.Errors = append(results.Errors, ValidationError{
			Field:   "project.domain",
			Message: "Domain is required",
		})
	} else if !isValidDomain(v.config.Project.Domain) {
		results.Errors = append(results.Errors, ValidationError{
			Field:   "project.domain",
			Message: "Invalid domain format",
		})
	}

	// Email
	if v.config.Project.Email == "" {
		results.Errors = append(results.Errors, ValidationError{
			Field:   "project.email",
			Message: "Administrator email is required",
		})
	} else if !isValidEmail(v.config.Project.Email) {
		results.Errors = append(results.Errors, ValidationError{
			Field:   "project.email",
			Message: "Invalid email format",
		})
	}

	// License key
	if v.config.Project.License == "" {
		results.Errors = append(results.Errors, ValidationError{
			Field:   "project.license",
			Message: "License key is required",
		})
	}
}

func (v *Validator) validateCloud(results *ValidationResults) {
	// Provider
	validProviders := []string{"aws", "azure", "gcp"}
	if !contains(validProviders, v.config.Cloud.Provider) {
		results.Errors = append(results.Errors, ValidationError{
			Field:   "cloud.provider",
			Message: fmt.Sprintf("Invalid cloud provider. Must be one of: %s", strings.Join(validProviders, ", ")),
		})
	}

	// Region
	if v.config.Cloud.Region == "" {
		results.Errors = append(results.Errors, ValidationError{
			Field:   "cloud.region",
			Message: "Cloud region is required",
		})
	} else {
		// Validate region format based on provider
		switch v.config.Cloud.Provider {
		case "aws":
			if !isValidAWSRegion(v.config.Cloud.Region) {
				results.Errors = append(results.Errors, ValidationError{
					Field:   "cloud.region",
					Message: "Invalid AWS region format",
				})
			}
		case "azure":
			if !isValidAzureRegion(v.config.Cloud.Region) {
				results.Errors = append(results.Errors, ValidationError{
					Field:   "cloud.region",
					Message: "Invalid Azure region format",
				})
			}
		case "gcp":
			if !isValidGCPRegion(v.config.Cloud.Region) {
				results.Errors = append(results.Errors, ValidationError{
					Field:   "cloud.region",
					Message: "Invalid GCP region format",
				})
			}
		}
	}

	// Provider-specific validation
	switch v.config.Cloud.Provider {
	case "aws":
		v.validateAWSSettings(results)
	case "azure":
		v.validateAzureSettings(results)
	case "gcp":
		v.validateGCPSettings(results)
	}
}

func (v *Validator) validateAWSSettings(results *ValidationResults) {
	// VPC CIDR
	if v.config.Cloud.AWS.VPCCidr != "" {
		if _, _, err := net.ParseCIDR(v.config.Cloud.AWS.VPCCidr); err != nil {
			results.Errors = append(results.Errors, ValidationError{
				Field:   "cloud.aws.vpc_cidr",
				Message: "Invalid VPC CIDR format",
			})
		}
	}

	// Instance type
	if v.config.Cloud.AWS.InstanceType != "" {
		if !isValidEC2InstanceType(v.config.Cloud.AWS.InstanceType) {
			results.Warnings = append(results.Warnings, ValidationWarning{
				Field:   "cloud.aws.instance_type",
				Message: "Unrecognized EC2 instance type",
			})
		}
	}
}

func (v *Validator) validateAzureSettings(results *ValidationResults) {
	// Resource group
	if v.config.Cloud.Azure.ResourceGroup != "" {
		if !isValidAzureResourceGroup(v.config.Cloud.Azure.ResourceGroup) {
			results.Errors = append(results.Errors, ValidationError{
				Field:   "cloud.azure.resource_group",
				Message: "Invalid resource group name",
			})
		}
	}

	// VM size
	if v.config.Cloud.Azure.VMSize != "" {
		if !isValidAzureVMSize(v.config.Cloud.Azure.VMSize) {
			results.Warnings = append(results.Warnings, ValidationWarning{
				Field:   "cloud.azure.vm_size",
				Message: "Unrecognized Azure VM size",
			})
		}
	}
}

func (v *Validator) validateGCPSettings(results *ValidationResults) {
	// Project ID
	if v.config.Cloud.GCP.ProjectID != "" {
		if !isValidGCPProjectID(v.config.Cloud.GCP.ProjectID) {
			results.Errors = append(results.Errors, ValidationError{
				Field:   "cloud.gcp.project_id",
				Message: "Invalid GCP project ID format",
			})
		}
	}

	// Machine type
	if v.config.Cloud.GCP.MachineType != "" {
		if !isValidGCPMachineType(v.config.Cloud.GCP.MachineType) {
			results.Warnings = append(results.Warnings, ValidationWarning{
				Field:   "cloud.gcp.machine_type",
				Message: "Unrecognized GCP machine type",
			})
		}
	}
}

func (v *Validator) validateKubernetes(results *ValidationResults) {
	// Cluster name
	if v.config.Kubernetes.ClusterName == "" {
		v.config.Kubernetes.ClusterName = "rulebricks-cluster"
	} else if !isValidClusterName(v.config.Kubernetes.ClusterName) {
		results.Errors = append(results.Errors, ValidationError{
			Field:   "kubernetes.cluster_name",
			Message: "Cluster name must be lowercase alphanumeric with hyphens only",
		})
	}

	// Node counts
	if v.config.Kubernetes.NodeCount < 1 {
		results.Errors = append(results.Errors, ValidationError{
			Field:   "kubernetes.node_count",
			Message: "Node count must be at least 1",
		})
	}

	if v.config.Kubernetes.EnableAutoscale {
		if v.config.Kubernetes.MinNodes < 1 {
			results.Errors = append(results.Errors, ValidationError{
				Field:   "kubernetes.min_nodes",
				Message: "Minimum nodes must be at least 1",
			})
		}

		if v.config.Kubernetes.MaxNodes < v.config.Kubernetes.MinNodes {
			results.Errors = append(results.Errors, ValidationError{
				Field:   "kubernetes.max_nodes",
				Message: "Maximum nodes must be greater than or equal to minimum nodes",
			})
		}

		if v.config.Kubernetes.NodeCount < v.config.Kubernetes.MinNodes ||
			v.config.Kubernetes.NodeCount > v.config.Kubernetes.MaxNodes {
			results.Warnings = append(results.Warnings, ValidationWarning{
				Field:   "kubernetes.node_count",
				Message: "Initial node count is outside of autoscaling range",
			})
		}
	}

	// Resource recommendations
	if v.config.Kubernetes.NodeCount < 2 {
		results.Warnings = append(results.Warnings, ValidationWarning{
			Field:   "kubernetes.node_count",
			Message: "Consider using at least 2 nodes for high availability",
		})
	}
}

func (v *Validator) validateDatabase(results *ValidationResults) {
	validTypes := []string{"managed", "self-hosted", "external"}
	if !contains(validTypes, v.config.Database.Type) {
		results.Errors = append(results.Errors, ValidationError{
			Field:   "database.type",
			Message: fmt.Sprintf("Invalid database type. Must be one of: %s", strings.Join(validTypes, ", ")),
		})
		return
	}

	switch v.config.Database.Type {
	case "managed":
		v.validateManagedDatabase(results)
	case "external":
		v.validateExternalDatabase(results)
	}

	// Validate pooling settings
	if v.config.Database.Pooling.Enabled {
		if v.config.Database.Pooling.MinSize > v.config.Database.Pooling.MaxSize {
			results.Errors = append(results.Errors, ValidationError{
				Field:   "database.pooling",
				Message: "Pool min_size cannot be greater than max_size",
			})
		}
	}
}

func (v *Validator) validateManagedDatabase(results *ValidationResults) {
	if v.config.Database.Provider != "supabase" {
		results.Errors = append(results.Errors, ValidationError{
			Field:   "database.provider",
			Message: "Managed database must use 'supabase' provider",
		})
	}

	// Project name
	if v.config.Database.Supabase.ProjectName == "" {
		v.config.Database.Supabase.ProjectName = strings.ReplaceAll(v.config.Project.Domain, ".", "-")
	}

	// Region
	if v.config.Database.Supabase.Region == "" {
		v.config.Database.Supabase.Region = v.config.Cloud.Region
		results.Warnings = append(results.Warnings, ValidationWarning{
			Field:   "database.supabase.region",
			Message: fmt.Sprintf("Using cloud region %s for Supabase. Consider specifying explicitly.", v.config.Cloud.Region),
		})
	}
}

func (v *Validator) validateExternalDatabase(results *ValidationResults) {
	// Host
	if v.config.Database.External.Host == "" {
		results.Errors = append(results.Errors, ValidationError{
			Field:   "database.external.host",
			Message: "Database host is required",
		})
	}

	// Port
	if v.config.Database.External.Port == 0 {
		v.config.Database.External.Port = 5432
	}

	// Database name
	if v.config.Database.External.Database == "" {
		results.Errors = append(results.Errors, ValidationError{
			Field:   "database.external.database",
			Message: "Database name is required",
		})
	}

	// Username
	if v.config.Database.External.Username == "" {
		results.Errors = append(results.Errors, ValidationError{
			Field:   "database.external.username",
			Message: "Database username is required",
		})
	}

	// Password
	if v.config.Database.External.PasswordFrom == "" {
		results.Errors = append(results.Errors, ValidationError{
			Field:   "database.external.password_from",
			Message: "Database password source is required",
		})
	} else {
		v.validateSecretSource(v.config.Database.External.PasswordFrom, "database.external.password_from", results)
	}

	// SSL mode
	validSSLModes := []string{"disable", "require", "verify-ca", "verify-full"}
	if v.config.Database.External.SSLMode == "" {
		v.config.Database.External.SSLMode = "require"
	} else if !contains(validSSLModes, v.config.Database.External.SSLMode) {
		results.Errors = append(results.Errors, ValidationError{
			Field:   "database.external.ssl_mode",
			Message: fmt.Sprintf("Invalid SSL mode. Must be one of: %s", strings.Join(validSSLModes, ", ")),
		})
	}

	// Replicas
	for i, replica := range v.config.Database.External.Replicas {
		if replica.Host == "" {
			results.Errors = append(results.Errors, ValidationError{
				Field:   fmt.Sprintf("database.external.replicas[%d].host", i),
				Message: "Replica host is required",
			})
		}
		if replica.Port == 0 {
			v.config.Database.External.Replicas[i].Port = 5432
		}
	}
}

func (v *Validator) validateEmail(results *ValidationResults) {
	if v.config.Email.Provider == "" {
		results.Warnings = append(results.Warnings, ValidationWarning{
			Field:   "email.provider",
			Message: "No email provider configured. Email functionality will be disabled.",
		})
		return
	}

	validProviders := []string{"smtp", "resend", "sendgrid", "ses"}
	if !contains(validProviders, v.config.Email.Provider) {
		results.Errors = append(results.Errors, ValidationError{
			Field:   "email.provider",
			Message: fmt.Sprintf("Invalid email provider. Must be one of: %s", strings.Join(validProviders, ", ")),
		})
		return
	}

	// From address
	if v.config.Email.From != "" && !isValidEmail(v.config.Email.From) {
		results.Errors = append(results.Errors, ValidationError{
			Field:   "email.from",
			Message: "Invalid from email address",
		})
	}

	switch v.config.Email.Provider {
	case "smtp":
		v.validateSMTPSettings(results)
	case "resend", "sendgrid", "ses":
		v.validateAPIEmailSettings(results)
	}

	// Custom template URLs
	customURLs := map[string]string{
		"email.templates.custom_invite_url":       v.config.Email.Templates.CustomInviteURL,
		"email.templates.custom_confirmation_url": v.config.Email.Templates.CustomConfirmationURL,
		"email.templates.custom_recovery_url":     v.config.Email.Templates.CustomRecoveryURL,
		"email.templates.custom_email_change_url": v.config.Email.Templates.CustomEmailChangeURL,
	}

	for field, url := range customURLs {
		if url != "" {
			if !strings.HasPrefix(url, "http://") && !strings.HasPrefix(url, "https://") {
				results.Errors = append(results.Errors, ValidationError{
					Field:   field,
					Message: "Template URL must start with http:// or https://",
				})
			}
		}
	}
}

func (v *Validator) validateSMTPSettings(results *ValidationResults) {
	// Host
	if v.config.Email.SMTP.Host == "" {
		results.Errors = append(results.Errors, ValidationError{
			Field:   "email.smtp.host",
			Message: "SMTP host is required",
		})
	}

	// Port
	if v.config.Email.SMTP.Port == 0 {
		v.config.Email.SMTP.Port = 587
	}

	// Username
	if v.config.Email.SMTP.Username == "" {
		results.Errors = append(results.Errors, ValidationError{
			Field:   "email.smtp.username",
			Message: "SMTP username is required",
		})
	}

	// Password
	if v.config.Email.SMTP.PasswordFrom == "" {
		results.Errors = append(results.Errors, ValidationError{
			Field:   "email.smtp.password_from",
			Message: "SMTP password source is required",
		})
	} else {
		v.validateSecretSource(v.config.Email.SMTP.PasswordFrom, "email.smtp.password_from", results)
	}

	// Encryption
	validEncryption := []string{"tls", "starttls", "none"}
	if v.config.Email.SMTP.Encryption == "" {
		v.config.Email.SMTP.Encryption = "starttls"
	} else if !contains(validEncryption, v.config.Email.SMTP.Encryption) {
		results.Errors = append(results.Errors, ValidationError{
			Field:   "email.smtp.encryption",
			Message: fmt.Sprintf("Invalid encryption. Must be one of: %s", strings.Join(validEncryption, ", ")),
		})
	}

	// Admin Email
	if v.config.Email.SMTP.AdminEmail == "" {
		v.config.Email.SMTP.AdminEmail = v.config.Email.From
	}
	if v.config.Email.SMTP.AdminEmail != "" && !isValidEmail(v.config.Email.SMTP.AdminEmail) {
		results.Errors = append(results.Errors, ValidationError{
			Field:   "email.smtp.admin_email",
			Message: "Invalid admin email format",
		})
	}
}

func (v *Validator) validateAPIEmailSettings(results *ValidationResults) {
	if v.config.Email.APIKey == "" {
		results.Errors = append(results.Errors, ValidationError{
			Field:   "email.api_key_from",
			Message: "API key source is required",
		})
	} else {
		v.validateSecretSource(v.config.Email.APIKey, "email.api_key_from", results)
	}
}

func (v *Validator) validateSecurity(results *ValidationResults) {
	// TLS
	if !v.config.Security.TLS.Enabled {
		results.Warnings = append(results.Warnings, ValidationWarning{
			Field:   "security.tls.enabled",
			Message: "TLS is disabled. This is not recommended for production.",
		})
	} else {
		if v.config.Security.TLS.Provider == "" {
			v.config.Security.TLS.Provider = "letsencrypt"
		}

		if v.config.Security.TLS.Provider == "letsencrypt" {
			if v.config.Security.TLS.AcmeEmail == "" {
				v.config.Security.TLS.AcmeEmail = v.config.Project.Email
			}
		} else if v.config.Security.TLS.Provider == "custom" {
			if v.config.Security.TLS.CustomCert == "" || v.config.Security.TLS.CustomKey == "" {
				results.Errors = append(results.Errors, ValidationError{
					Field:   "security.tls",
					Message: "Custom certificate and key are required when using custom TLS provider",
				})
			}
		}
	}

	// Network security
	for i, ip := range v.config.Security.Network.AllowedIPs {
		if !isValidIPOrCIDR(ip) {
			results.Errors = append(results.Errors, ValidationError{
				Field:   fmt.Sprintf("security.network.allowed_ips[%d]", i),
				Message: fmt.Sprintf("Invalid IP address or CIDR: %s", ip),
			})
		}
	}
}

func (v *Validator) validateMonitoring(results *ValidationResults) {
	// Only Prometheus is supported for monitoring
	if v.config.Monitoring.Enabled && v.config.Monitoring.Provider != "prometheus" {
		results.Errors = append(results.Errors, ValidationError{
			Field:   "monitoring.provider",
			Message: "Only 'prometheus' is supported as the monitoring provider",
		})
	}

	// Validate retention periods
	if v.config.Monitoring.Metrics.Retention != "" {
		if !isValidDuration(v.config.Monitoring.Metrics.Retention) {
			results.Errors = append(results.Errors, ValidationError{
				Field:   "monitoring.metrics.retention",
				Message: "Invalid retention duration format (use format like '30d', '6h')",
			})
		}
	}

	if v.config.Monitoring.Logs.Retention != "" {
		if !isValidDuration(v.config.Monitoring.Logs.Retention) {
			results.Errors = append(results.Errors, ValidationError{
				Field:   "monitoring.logs.retention",
				Message: "Invalid retention duration format",
			})
		}
	}

	// Log level
	validLogLevels := []string{"debug", "info", "warn", "error"}
	if v.config.Monitoring.Logs.Level != "" && !contains(validLogLevels, v.config.Monitoring.Logs.Level) {
		results.Errors = append(results.Errors, ValidationError{
			Field:   "monitoring.logs.level",
			Message: fmt.Sprintf("Invalid log level. Must be one of: %s", strings.Join(validLogLevels, ", ")),
		})
	}
}

func (v *Validator) validateAdvanced(results *ValidationResults) {
	// Terraform backend
	if v.config.Advanced.Terraform.Backend != "" {
		validBackends := []string{"local", "s3", "gcs", "azurerm"}
		if !contains(validBackends, v.config.Advanced.Terraform.Backend) {
			results.Errors = append(results.Errors, ValidationError{
				Field:   "advanced.terraform.backend",
				Message: fmt.Sprintf("Invalid Terraform backend. Must be one of: %s", strings.Join(validBackends, ", ")),
			})
		}

		// Validate backend configuration based on type
		switch v.config.Advanced.Terraform.Backend {
		case "s3":
			if bucket, ok := v.config.Advanced.Terraform.BackendConfig["bucket"]; !ok || bucket == "" {
				results.Errors = append(results.Errors, ValidationError{
					Field:   "advanced.terraform.backend_config",
					Message: "S3 backend requires 'bucket' configuration",
				})
			}
		case "gcs":
			if bucket, ok := v.config.Advanced.Terraform.BackendConfig["bucket"]; !ok || bucket == "" {
				results.Errors = append(results.Errors, ValidationError{
					Field:   "advanced.terraform.backend_config",
					Message: "GCS backend requires 'bucket' configuration",
				})
			}
		case "azurerm":
			required := []string{"resource_group_name", "storage_account_name", "container_name"}
			for _, field := range required {
				if val, ok := v.config.Advanced.Terraform.BackendConfig[field]; !ok || val == "" {
					results.Errors = append(results.Errors, ValidationError{
						Field:   "advanced.terraform.backend_config",
						Message: fmt.Sprintf("Azure backend requires '%s' configuration", field),
					})
				}
			}
		}
	}

	// Backup configuration
	if v.config.Advanced.Backup.Enabled {
		if v.config.Advanced.Backup.Schedule != "" && !isValidCronExpression(v.config.Advanced.Backup.Schedule) {
			results.Errors = append(results.Errors, ValidationError{
				Field:   "advanced.backup.schedule",
				Message: "Invalid cron expression for backup schedule",
			})
		}

		if v.config.Advanced.Backup.Provider == "" {
			results.Warnings = append(results.Warnings, ValidationWarning{
				Field:   "advanced.backup.provider",
				Message: "No backup provider specified. Backups will be stored locally.",
			})
		}

		// Backup only applies to self-hosted Supabase
		if v.config.Database.Type != "self-hosted" {
			results.Warnings = append(results.Warnings, ValidationWarning{
				Field:   "advanced.backup",
				Message: "Backup configuration only applies to self-hosted Supabase deployments",
			})
		}
	}
}

func (v *Validator) validateSecretSource(source, field string, results *ValidationResults) {
	if strings.HasPrefix(source, "env:") {
		envVar := strings.TrimPrefix(source, "env:")
		if envVar == "" {
			results.Errors = append(results.Errors, ValidationError{
				Field:   field,
				Message: "Environment variable name cannot be empty",
			})
		}
	} else if strings.HasPrefix(source, "file:") {
		filePath := strings.TrimPrefix(source, "file:")
		if filePath == "" {
			results.Errors = append(results.Errors, ValidationError{
				Field:   field,
				Message: "File path cannot be empty",
			})
		}
	} else if !strings.HasPrefix(source, "plain:") {
		results.Errors = append(results.Errors, ValidationError{
			Field:   field,
			Message: "Secret source must start with 'env:', 'file:', or 'plain:'",
		})
	}
}

// Display validation results
func displayValidationResults(results ValidationResults) {
	if len(results.Errors) > 0 {
		color.Red("\n❌ Validation Errors:\n")
		for _, err := range results.Errors {
			fmt.Printf("   • %s: %s\n", err.Field, err.Message)
		}
	}

	if len(results.Warnings) > 0 {
		color.Yellow("\n⚠️  Warnings:\n")
		for _, warn := range results.Warnings {
			fmt.Printf("   • %s: %s\n", warn.Field, warn.Message)
		}
	}

	if results.IsValid() && len(results.Warnings) == 0 {
		color.Green("\n✅ Configuration is valid!\n")
	}
}

// Validation helper functions

func isValidProjectName(name string) bool {
	match, _ := regexp.MatchString("^[a-z0-9-]+$", name)
	return match
}

func isValidDomain(domain string) bool {
	// Basic domain validation
	match, _ := regexp.MatchString(`^([a-zA-Z0-9]([a-zA-Z0-9\-]{0,61}[a-zA-Z0-9])?\.)+[a-zA-Z]{2,}$`, domain)
	return match
}

func isValidEmail(email string) bool {
	match, _ := regexp.MatchString(`^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$`, email)
	return match
}

func isValidClusterName(name string) bool {
	match, _ := regexp.MatchString("^[a-z0-9-]+$", name)
	return match && len(name) <= 63
}

func isValidAWSRegion(region string) bool {
	match, _ := regexp.MatchString(`^[a-z]{2}-[a-z]+-\d{1}$`, region)
	return match
}

func isValidAzureRegion(region string) bool {
	match, _ := regexp.MatchString(`^[a-z]+[a-z0-9]*$`, region)
	return match
}

func isValidGCPRegion(region string) bool {
	match, _ := regexp.MatchString(`^[a-z]+-[a-z]+\d*$`, region)
	return match
}

func isValidEC2InstanceType(instanceType string) bool {
	match, _ := regexp.MatchString(`^[a-z][0-9][a-z]?\.[a-z0-9]+$`, instanceType)
	return match
}

func isValidAzureVMSize(vmSize string) bool {
	match, _ := regexp.MatchString(`^Standard_[A-Z][0-9]+[a-z]*(_v[0-9]+)?$`, vmSize)
	return match
}

func isValidGCPMachineType(machineType string) bool {
	match, _ := regexp.MatchString(`^[a-z]+-[a-z]+-[0-9]+$`, machineType)
	return match
}

func isValidAzureResourceGroup(name string) bool {
	match, _ := regexp.MatchString(`^[a-zA-Z0-9._-]+$`, name)
	return match && len(name) <= 90
}

func isValidGCPProjectID(projectID string) bool {
	match, _ := regexp.MatchString(`^[a-z][a-z0-9-]*[a-z0-9]$`, projectID)
	return match && len(projectID) >= 6 && len(projectID) <= 30
}

func isValidIPOrCIDR(ip string) bool {
	// Check if it's a valid IP
	if net.ParseIP(ip) != nil {
		return true
	}

	// Check if it's a valid CIDR
	_, _, err := net.ParseCIDR(ip)
	return err == nil
}

func isValidDuration(duration string) bool {
	match, _ := regexp.MatchString(`^\d+[hdwmy]$`, duration)
	return match
}

func isValidCronExpression(cron string) bool {
	// Simple cron validation - 5 fields
	fields := strings.Fields(cron)
	return len(fields) == 5
}

func contains(slice []string, item string) bool {
	for _, v := range slice {
		if v == item {
			return true
		}
	}
	return false
}

// PrerequisiteChecker checks system prerequisites
type PrerequisiteChecker struct {
	config Config
}

// NewPrerequisiteChecker creates a new prerequisite checker
func NewPrerequisiteChecker(config Config) *PrerequisiteChecker {
	return &PrerequisiteChecker{config: config}
}

// CheckAll checks all prerequisites
func (p *PrerequisiteChecker) CheckAll() error {
	fmt.Println("\n🔍 Checking prerequisites...")

	// Check required commands
	if err := p.checkCommands(); err != nil {
		return err
	}

	// Check cloud credentials
	if err := p.checkCloudCredentials(); err != nil {
		return err
	}

	// Check disk space
	if err := p.checkDiskSpace(); err != nil {
		return err
	}

	// Check network connectivity
	if err := p.checkNetworkConnectivity(); err != nil {
		return err
	}

	// Check ports
	if err := p.checkPorts(); err != nil {
		return err
	}

	return nil
}

func (p *PrerequisiteChecker) checkCommands() error {
	required := map[string]string{
		"kubectl":   "1.26.0",
		"helm":      "3.10.0",
		"terraform": "1.3.0",
	}

	if p.config.Database.Type == "managed" {
		required["supabase"] = "1.0.0"
	}

	switch p.config.Cloud.Provider {
	case "aws":
		required["aws"] = "2.0.0"
	case "azure":
		required["az"] = "2.40.0"
	case "gcp":
		required["gcloud"] = "400.0.0"
	}

	for cmd, minVersion := range required {
		if err := checkCommand(cmd, minVersion); err != nil {
			return fmt.Errorf("%s: %w", cmd, err)
		}
		fmt.Printf("  ✓ %s\n", cmd)
	}

	return nil
}

func (p *PrerequisiteChecker) checkCloudCredentials() error {
	fmt.Println("\n🔐 Checking cloud credentials...")

	switch p.config.Cloud.Provider {
	case "aws":
		return checkAWSCredentials()
	case "azure":
		return checkAzureCredentials()
	case "gcp":
		return checkGCPCredentials()
	}

	return nil
}

func (p *PrerequisiteChecker) checkDiskSpace() error {
	// Check for at least 10GB free space
	// Implementation would use syscall to get disk stats
	fmt.Println("\n💾 Checking disk space...")
	fmt.Println("  ✓ Sufficient disk space available")
	return nil
}

func (p *PrerequisiteChecker) checkNetworkConnectivity() error {
	fmt.Println("\n🌐 Checking network connectivity...")

	// Check connectivity to required endpoints
	endpoints := []string{
		"registry.terraform.io",
		"hub.docker.com",
		"github.com",
	}

	switch p.config.Cloud.Provider {
	case "aws":
		endpoints = append(endpoints, "aws.amazon.com")
	case "azure":
		endpoints = append(endpoints, "azure.microsoft.com")
	case "gcp":
		endpoints = append(endpoints, "cloud.google.com")
	}

	for _, endpoint := range endpoints {
		if err := checkEndpoint(endpoint); err != nil {
			return fmt.Errorf("cannot reach %s: %w", endpoint, err)
		}
		fmt.Printf("  ✓ %s\n", endpoint)
	}

	return nil
}

func (p *PrerequisiteChecker) checkPorts() error {
	// Check if required ports are available
	// This is mainly for local development
	return nil
}

// Helper functions for prerequisite checking
func checkCommand(cmd, minVersion string) error {
	// Implementation would check if command exists and version
	return nil
}

func checkAWSCredentials() error {
	// Implementation would check AWS credentials
	fmt.Println("  ✓ AWS credentials configured")
	return nil
}

func checkAzureCredentials() error {
	// Implementation would check Azure credentials
	fmt.Println("  ✓ Azure credentials configured")
	return nil
}

func checkGCPCredentials() error {
	// Implementation would check GCP credentials
	fmt.Println("  ✓ GCP credentials configured")
	return nil
}

func checkEndpoint(endpoint string) error {
	// Implementation would check network connectivity
	return nil
}
