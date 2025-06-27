package main

import (
	"fmt"
	"os/exec"
	"time"
)

// SharedSecrets holds secrets used across deployments
type SharedSecrets struct {
	LicenseKey         string
	DBPassword         string
	SMTPPassword       string
	SupabaseAnonKey    string
	SupabaseServiceKey string
	JWTSecret          string
	DashboardPassword  string
}

// KafkaConfig holds Kafka configuration
type KafkaConfig struct {
	Partitions        int
	ReplicationFactor int
	RetentionHours    int
	StorageSize       string
}

// CloudProviderRegions contains region information for each cloud provider
var CloudProviderRegions = map[string][]string{
	"aws": {
		"us-east-1",      // N. Virginia
		"us-east-2",      // Ohio
		"us-west-1",      // N. California
		"us-west-2",      // Oregon
		"eu-west-1",      // Ireland
		"eu-west-2",      // London
		"eu-west-3",      // Paris
		"eu-central-1",   // Frankfurt
		"ap-south-1",     // Mumbai
		"ap-southeast-1", // Singapore
		"ap-southeast-2", // Sydney
		"ap-northeast-1", // Tokyo
		"ap-northeast-2", // Seoul
		"ca-central-1",   // Canada
		"sa-east-1",      // São Paulo
	},
	"azure": {
		"eastus",
		"eastus2",
		"westus",
		"westus2",
		"centralus",
		"northeurope",
		"westeurope",
		"uksouth",
		"eastasia",
		"southeastasia",
		"japaneast",
		"australiaeast",
		"canadacentral",
		"brazilsouth",
	},
	"gcp": {
		"us-central1",
		"us-east1",
		"us-west1",
		"us-west2",
		"europe-west1",
		"europe-west2",
		"europe-west3",
		"asia-east1",
		"asia-northeast1",
		"asia-southeast1",
		"australia-southeast1",
		"southamerica-east1",
	},
}

// SupabaseRegions contains Supabase-specific regions
var SupabaseRegions = []struct {
	Name   string
	Region string
}{
	{"West US (North California)", "us-west-1"},
	{"East US (North Virginia)", "us-east-1"},
	{"East US (Ohio)", "us-east-2"},
	{"Canada (Central)", "ca-central-1"},
	{"West EU (Ireland)", "eu-west-1"},
	{"West Europe (London)", "eu-west-2"},
	{"West EU (Paris)", "eu-west-3"},
	{"Central EU (Frankfurt)", "eu-central-1"},
	{"Central Europe (Zurich)", "eu-central-2"},
	{"North EU (Stockholm)", "eu-north-1"},
	{"South Asia (Mumbai)", "ap-south-1"},
	{"Southeast Asia (Singapore)", "ap-southeast-1"},
	{"Northeast Asia (Tokyo)", "ap-northeast-1"},
	{"Northeast Asia (Seoul)", "ap-northeast-2"},
	{"Oceania (Sydney)", "ap-southeast-2"},
	{"South America (São Paulo)", "sa-east-1"},
}

// DefaultInstanceTypes contains default instance types for each cloud provider
var DefaultInstanceTypes = map[string]string{
	"aws":   "c8g.large",
	"azure": "Standard_D4ps_v5",
	"gcp":   "t2a-standard-4",
}

// KubernetesVersions contains supported Kubernetes versions
var KubernetesVersions = map[string]string{
	"aws":   "1.28",
	"azure": "1.28",
	"gcp":   "1.28",
}

// RequiredCommands lists required CLI commands for each operation
var RequiredCommands = map[string][]string{
	"base": {
		"kubectl",
		"helm",
		"terraform",
	},
	"aws": {
		"aws",
	},
	"azure": {
		"az",
	},
	"gcp": {
		"gcloud",
	},
	"managed-supabase": {
		"supabase",
	},
}

// TerraformBackendConfigs contains example backend configurations
var TerraformBackendConfigs = map[string]map[string]string{
	"s3": {
		"bucket":         "my-terraform-state",
		"key":            "rulebricks/terraform.tfstate",
		"region":         "us-east-1",
		"dynamodb_table": "terraform-locks",
		"encrypt":        "true",
	},
	"gcs": {
		"bucket": "my-terraform-state",
		"prefix": "rulebricks",
	},
	"azurerm": {
		"resource_group_name":  "terraform-state-rg",
		"storage_account_name": "tfstate",
		"container_name":       "tfstate",
		"key":                  "rulebricks.tfstate",
	},
}

// HelmChartPaths defines paths to Helm charts
type HelmChartPaths struct {
	Traefik     string
	CertManager string
	Prometheus  string
	Supabase    string
	Rulebricks  string
}

// GetDefaultHelmChartPaths returns default Helm chart paths
func GetDefaultHelmChartPaths() HelmChartPaths {
	return HelmChartPaths{
		Traefik:     "traefik/traefik",
		CertManager: "jetstack/cert-manager",
		Prometheus:  "prometheus-community/kube-prometheus-stack",
		Supabase:    "./charts/supabase",
		Rulebricks:  "./charts/rulebricks",
	}
}

// EmailTemplateConfig holds email template configuration
type EmailTemplateConfig struct {
	SubjectInvite        string
	SubjectConfirmation  string
	SubjectRecovery      string
	SubjectEmailChange   string
	TemplateInvite       string
	TemplateConfirmation string
	TemplateRecovery     string
	TemplateEmailChange  string
}

// GetDefaultEmailTemplates returns the default email template configuration
func GetDefaultEmailTemplates() EmailTemplateConfig {
	return EmailTemplateConfig{
		SubjectInvite:        "You've been invited",
		SubjectConfirmation:  "Confirm Your Email",
		SubjectRecovery:      "Reset Your Password",
		SubjectEmailChange:   "Confirm Email Change",
		TemplateInvite:       "https://prefix-files.s3.us-west-2.amazonaws.com/templates/invite.html",
		TemplateConfirmation: "https://prefix-files.s3.us-west-2.amazonaws.com/templates/verify.html",
		TemplateRecovery:     "https://prefix-files.s3.us-west-2.amazonaws.com/templates/password_change.html",
		TemplateEmailChange:  "https://prefix-files.s3.us-west-2.amazonaws.com/templates/email_change.html",
	}
}

// GetRequiredCommands returns all required commands based on configuration
func GetRequiredCommands(config *Config) []string {
	commands := RequiredCommands["base"]

	// Add cloud provider specific commands
	if providerCmds, ok := RequiredCommands[config.Cloud.Provider]; ok {
		commands = append(commands, providerCmds...)
	}

	// Add Supabase CLI if using managed deployment
	if config.Database.Type == "managed" {
		commands = append(commands, RequiredCommands["managed-supabase"]...)
	}

	return uniqueStringSlice(commands)
}

// ValidateCloudProviderConfig validates cloud-specific configuration
func ValidateCloudProviderConfig(config *Config) error {
	switch config.Cloud.Provider {
	case "aws":
		if config.Cloud.Region == "" {
			return fmt.Errorf("AWS region is required")
		}
		if !stringSliceContains(CloudProviderRegions["aws"], config.Cloud.Region) {
			return fmt.Errorf("invalid AWS region: %s", config.Cloud.Region)
		}
	case "azure":
		if config.Cloud.Region == "" {
			return fmt.Errorf("Azure region is required")
		}
		if !stringSliceContains(CloudProviderRegions["azure"], config.Cloud.Region) {
			return fmt.Errorf("invalid Azure region: %s", config.Cloud.Region)
		}
	case "gcp":
		if config.Cloud.Region == "" {
			return fmt.Errorf("GCP region is required")
		}
		if !stringSliceContains(CloudProviderRegions["gcp"], config.Cloud.Region) {
			return fmt.Errorf("invalid GCP region: %s", config.Cloud.Region)
		}
		if config.Cloud.GCP == nil || config.Cloud.GCP.ProjectID == "" {
			return fmt.Errorf("GCP project ID is required")
		}
	default:
		return fmt.Errorf("unsupported cloud provider: %s", config.Cloud.Provider)
	}

	return nil
}

// GetSupabaseURL returns the Supabase URL based on deployment type
func GetSupabaseURL(config *Config, projectRef string) string {
	switch config.Database.Type {
	case "managed":
		return fmt.Sprintf("https://%s.supabase.co", projectRef)
	case "self-hosted", "external":
		return fmt.Sprintf("https://supabase.%s", config.Project.Domain)
	default:
		return ""
	}
}

// GetDatabaseURL constructs the database URL based on configuration
func GetDatabaseURL(config *Config, password string) string {
	switch config.Database.Type {
	case "self-hosted":
		return fmt.Sprintf("postgresql://postgres:%s@supabase-db.%s.svc.cluster.local:5432/postgres?sslmode=disable",
			password, config.GetNamespace("supabase"))
	case "external":
		return fmt.Sprintf("postgresql://%s:%s@%s:%d/%s?sslmode=%s",
			config.Database.External.Username,
			password,
			config.Database.External.Host,
			config.Database.External.Port,
			config.Database.External.Database,
			config.Database.External.SSLMode)
	case "managed":
		// Managed Supabase database URL would be constructed differently
		return fmt.Sprintf("postgresql://postgres:%s@db.%s.supabase.co:5432/postgres",
			password, config.Database.Supabase.ProjectName)
	default:
		return ""
	}
}

// CommandExists checks if a command is available in PATH
func CommandExists(cmd string) bool {
	_, err := exec.LookPath(cmd)
	return err == nil
}

// Environment variables
const (
	EnvPrefix      = "RULEBRICKS"
	EnvLicenseKey  = "RULEBRICKS_LICENSE_KEY"
	EnvAPIKey      = "RULEBRICKS_API_KEY"
	EnvDebug       = "RULEBRICKS_DEBUG"
)

// Docker registry constants
const (
	DefaultDockerRegistry = "docker.io"
	DefaultDockerOrg      = "rulebricks"
	DefaultAppImage       = "rulebricks/app"
	DefaultHPSImage       = "rulebricks/hps"
)

// Chart versions
const (
	MinChartVersion     = "1.0.0"
	DefaultChartVersion = "latest"
)

// Timeouts
const (
	DefaultTimeout      = 5 * time.Minute
	InfraTimeout        = 30 * time.Minute
	KubernetesTimeout   = 10 * time.Minute
	ApplicationTimeout  = 15 * time.Minute
	DNSTimeout          = 5 * time.Minute
	CertificateTimeout  = 10 * time.Minute
)

// Resource defaults
const (
	DefaultHPSReplicas          = 1
	DefaultHPSMaxReplicas       = 5
	DefaultWorkerReplicas       = 1
	DefaultWorkerMaxReplicas    = 10
	DefaultKafkaPartitions      = 10
	DefaultKafkaRetentionHours  = 24
	DefaultKafkaReplicationFactor = 1
)

// Volume levels
const (
	VolumeLevelSmall  = "small"
	VolumeLevelMedium = "medium"
	VolumeLevelLarge  = "large"
)

// GetVolumeSize returns the volume size based on level
func GetVolumeSize(level string) string {
	switch level {
	case VolumeLevelSmall:
		return "10Gi"
	case VolumeLevelLarge:
		return "100Gi"
	default:
		return "50Gi"
	}
}
