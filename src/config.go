package main

import (
	"fmt"
	"net/mail"
	"regexp"
	"strings"

	"gopkg.in/yaml.v3"
)

// Config represents the complete Rulebricks configuration
type Config struct {
	Version      string                 `yaml:"version"`
	Project      ProjectConfig          `yaml:"project"`
	Cloud        CloudConfig            `yaml:"cloud"`
	Kubernetes   KubernetesConfig       `yaml:"kubernetes"`
	Database     DatabaseConfig         `yaml:"database"`
	Email        EmailConfig            `yaml:"email"`
	Security     SecurityConfig         `yaml:"security"`
	Monitoring   MonitoringConfig       `yaml:"monitoring"`
	Advanced     AdvancedConfig         `yaml:"advanced"`
	AI           AIConfig               `yaml:"ai"`
	Logging      LoggingConfig          `yaml:"logging"`
	Performance  PerformanceConfig      `yaml:"performance"`
}

// ProjectConfig defines project-specific settings
type ProjectConfig struct {
	Name      string `yaml:"name"`
	Domain    string `yaml:"domain"`
	Email     string `yaml:"email"`
	License   string `yaml:"license"`
	Version   string `yaml:"version"`
	Namespace string `yaml:"namespace,omitempty"`
}

// CloudConfig defines cloud provider settings
type CloudConfig struct {
	Provider string      `yaml:"provider"`
	Region   string      `yaml:"region"`
	AWS      *AWSConfig  `yaml:"aws,omitempty"`
	Azure    *AzureConfig `yaml:"azure,omitempty"`
	GCP      *GCPConfig  `yaml:"gcp,omitempty"`
}

// AWSConfig defines AWS-specific settings
type AWSConfig struct {
	AccountID    string `yaml:"account_id,omitempty"`
	VPCCidr      string `yaml:"vpc_cidr,omitempty"`
	InstanceType string `yaml:"instance_type,omitempty"`
}

// AzureConfig defines Azure-specific settings
type AzureConfig struct {
	SubscriptionID string `yaml:"subscription_id,omitempty"`
	ResourceGroup  string `yaml:"resource_group,omitempty"`
	VMSize         string `yaml:"vm_size,omitempty"`
}

// GCPConfig defines GCP-specific settings
type GCPConfig struct {
	ProjectID   string `yaml:"project_id"`
	Zone        string `yaml:"zone,omitempty"`
	MachineType string `yaml:"machine_type,omitempty"`
}

// KubernetesConfig defines Kubernetes cluster settings
type KubernetesConfig struct {
	ClusterName     string `yaml:"cluster_name"`
	NodeCount       int    `yaml:"node_count"`
	MinNodes        int    `yaml:"min_nodes,omitempty"`
	MaxNodes        int    `yaml:"max_nodes,omitempty"`
	EnableAutoscale bool   `yaml:"enable_autoscale,omitempty"`
}

// DatabaseConfig defines database settings
type DatabaseConfig struct {
	Type     string               `yaml:"type"`
	Provider string               `yaml:"provider,omitempty"`
	Supabase *SupabaseConfig      `yaml:"supabase,omitempty"`
	External *ExternalDBConfig    `yaml:"external,omitempty"`
	Pooling  *PoolingConfig       `yaml:"pooling,omitempty"`
}

// SupabaseConfig defines Supabase-specific settings
type SupabaseConfig struct {
	ProjectName string `yaml:"project_name,omitempty"`
	Region      string `yaml:"region,omitempty"`
	OrgID       string `yaml:"org_id,omitempty"`
}

// ExternalDBConfig defines external database settings
type ExternalDBConfig struct {
	Host         string              `yaml:"host"`
	Port         int                 `yaml:"port"`
	Database     string              `yaml:"database"`
	Username     string              `yaml:"username"`
	PasswordFrom string              `yaml:"password_from"`
	SSLMode      string              `yaml:"ssl_mode,omitempty"`
	Replicas     []ReplicaConfig     `yaml:"replicas,omitempty"`
}

// ReplicaConfig defines database replica settings
type ReplicaConfig struct {
	Host string `yaml:"host"`
	Port int    `yaml:"port"`
	Type string `yaml:"type,omitempty"`
}

// PoolingConfig defines connection pooling settings
type PoolingConfig struct {
	Enabled bool `yaml:"enabled"`
	MaxSize int  `yaml:"max_size,omitempty"`
	MinSize int  `yaml:"min_size,omitempty"`
}

// EmailConfig defines email provider settings
type EmailConfig struct {
	From      string             `yaml:"from"`
	FromName  string             `yaml:"from_name,omitempty"`
	SMTP      *SMTPConfig        `yaml:"smtp,omitempty"`
	Templates *EmailTemplates    `yaml:"templates,omitempty"`
}

// SMTPConfig defines SMTP settings
type SMTPConfig struct {
	Host         string `yaml:"host"`
	Port         int    `yaml:"port"`
	Username     string `yaml:"username"`
	PasswordFrom string `yaml:"password_from"`
	Encryption   string `yaml:"encryption,omitempty"`
	AdminEmail   string `yaml:"admin_email,omitempty"`
}

// EmailTemplates defines custom email template URLs
type EmailTemplates struct {
	CustomInviteURL       string `yaml:"custom_invite_url,omitempty"`
	CustomConfirmationURL string `yaml:"custom_confirmation_url,omitempty"`
	CustomRecoveryURL     string `yaml:"custom_recovery_url,omitempty"`
	CustomEmailChangeURL  string `yaml:"custom_email_change_url,omitempty"`
}

// SecurityConfig defines security settings
type SecurityConfig struct {
	TLS     *TLSConfig     `yaml:"tls,omitempty"`
	Secrets *SecretsConfig `yaml:"secrets,omitempty"`
	Network *NetworkConfig `yaml:"network,omitempty"`
}

// TLSConfig defines TLS/SSL settings
type TLSConfig struct {
	Enabled    bool     `yaml:"enabled"`
	Provider   string   `yaml:"provider,omitempty"`
	CustomCert string   `yaml:"custom_cert,omitempty"`
	CustomKey  string   `yaml:"custom_key,omitempty"`
	AcmeEmail  string   `yaml:"acme_email,omitempty"`
	Domains    []string `yaml:"domains,omitempty"`
}

// SecretsConfig defines secrets management settings
type SecretsConfig struct {
	Provider   string `yaml:"provider,omitempty"`
	Encryption string `yaml:"encryption,omitempty"`
}

// NetworkConfig defines network security settings
type NetworkConfig struct {
	AllowedIPs   []string `yaml:"allowed_ips,omitempty"`
	RateLimiting bool     `yaml:"rate_limiting,omitempty"`
}

// MonitoringConfig defines monitoring settings
type MonitoringConfig struct {
	Enabled  bool                    `yaml:"enabled"`
	Mode     string                  `yaml:"mode,omitempty"` // "local" or "remote"
	Provider string                  `yaml:"provider,omitempty"` // Deprecated, use Mode instead
	Local    *LocalMonitoringConfig  `yaml:"local,omitempty"`
	Remote   *RemoteMonitoringConfig `yaml:"remote,omitempty"`
	Metrics  *MetricsConfig          `yaml:"metrics,omitempty"`
	Logs     *LogsConfig             `yaml:"logs,omitempty"`
}

// MetricsConfig defines metrics collection settings
type MetricsConfig struct {
	Retention string `yaml:"retention,omitempty"`
	Interval  string `yaml:"interval,omitempty"`
}

// LogsConfig defines log collection settings
type LogsConfig struct {
	Level     string `yaml:"level,omitempty"`
	Retention string `yaml:"retention,omitempty"`
}

// LocalMonitoringConfig defines local monitoring stack settings
type LocalMonitoringConfig struct {
	PrometheusEnabled bool   `yaml:"prometheus_enabled"`
	GrafanaEnabled    bool   `yaml:"grafana_enabled"`
	Retention         string `yaml:"retention,omitempty"`
	StorageSize       string `yaml:"storage_size,omitempty"`
}

// RemoteMonitoringConfig defines remote monitoring settings
type RemoteMonitoringConfig struct {
	Provider       string                   `yaml:"provider"` // "prometheus", "grafana-cloud", "newrelic", "custom"
	PrometheusWrite *PrometheusRemoteWrite  `yaml:"prometheus_write,omitempty"`
	NewRelic       *NewRelicConfig          `yaml:"newrelic,omitempty"`
}

// PrometheusRemoteWrite defines Prometheus remote write configuration
type PrometheusRemoteWrite struct {
	URL               string            `yaml:"url"`
	Username          string            `yaml:"username,omitempty"`
	PasswordFrom      string            `yaml:"password_from,omitempty"`
	BearerToken       string            `yaml:"bearer_token,omitempty"`
	BearerTokenFrom   string            `yaml:"bearer_token_from,omitempty"`
	Headers           map[string]string `yaml:"headers,omitempty"`
	WriteRelabelConfigs []RelabelConfig `yaml:"write_relabel_configs,omitempty"`
}

// RelabelConfig defines Prometheus relabel configuration
type RelabelConfig struct {
	SourceLabels []string `yaml:"source_labels,omitempty"`
	Separator    string   `yaml:"separator,omitempty"`
	TargetLabel  string   `yaml:"target_label,omitempty"`
	Regex        string   `yaml:"regex,omitempty"`
	Replacement  string   `yaml:"replacement,omitempty"`
	Action       string   `yaml:"action,omitempty"`
}

// NewRelicConfig defines New Relic-specific configuration
type NewRelicConfig struct {
	LicenseKeyFrom string `yaml:"license_key_from"`
	Region         string `yaml:"region,omitempty"` // "US" or "EU", default: "US"
}

// AdvancedConfig defines advanced settings
type AdvancedConfig struct {
	Terraform      *TerraformConfig       `yaml:"terraform,omitempty"`
	Backup         *BackupConfig          `yaml:"backup,omitempty"`
	DockerRegistry *DockerRegistryConfig  `yaml:"docker_registry,omitempty"`
	CustomValues   map[string]interface{} `yaml:"custom_values,omitempty"`
}

// TerraformConfig defines Terraform backend settings
type TerraformConfig struct {
	Backend       string            `yaml:"backend,omitempty"`
	BackendConfig map[string]string `yaml:"backend_config,omitempty"`
	Variables     map[string]string `yaml:"variables,omitempty"`
}

// BackupConfig defines backup settings
type BackupConfig struct {
	Enabled        bool              `yaml:"enabled"`
	Schedule       string            `yaml:"schedule,omitempty"`
	Retention      string            `yaml:"retention,omitempty"`
	Provider       string            `yaml:"provider,omitempty"`
	ProviderConfig map[string]string `yaml:"provider_config,omitempty"`
}

// DockerRegistryConfig defines custom Docker registry settings
type DockerRegistryConfig struct {
	URL      string `yaml:"url,omitempty"`
	AppImage string `yaml:"app_image,omitempty"`
	HPSImage string `yaml:"hps_image,omitempty"`
}

// AIConfig defines AI integration settings
type AIConfig struct {
	Enabled          bool   `yaml:"enabled"`
	OpenAIAPIKeyFrom string `yaml:"openai_api_key_from,omitempty"`
}

// LoggingConfig defines centralized logging settings
type LoggingConfig struct {
	Enabled bool         `yaml:"enabled"`
	Vector  *VectorConfig `yaml:"vector,omitempty"`
}

// VectorConfig defines Vector logging pipeline settings
type VectorConfig struct {
	Sink *VectorSink `yaml:"sink,omitempty"`
}

// VectorSink defines Vector sink configuration
type VectorSink struct {
	Type     string                 `yaml:"type"`
	Endpoint string                 `yaml:"endpoint,omitempty"`
	APIKey   string                 `yaml:"api_key,omitempty"`
	Config   map[string]interface{} `yaml:"config,omitempty"`
}

// PerformanceConfig defines performance tuning settings
type PerformanceConfig struct {
	VolumeLevel            string            `yaml:"volume_level,omitempty"`
	HPSReplicas            int               `yaml:"hps_replicas,omitempty"`
	HPSMaxReplicas         int               `yaml:"hps_max_replicas,omitempty"`
	HPSWorkerReplicas      int               `yaml:"hps_worker_replicas,omitempty"`
	HPSWorkerMaxReplicas   int               `yaml:"hps_worker_max_replicas,omitempty"`
	KafkaPartitions        int               `yaml:"kafka_partitions,omitempty"`
	KafkaLagThreshold      int               `yaml:"kafka_lag_threshold,omitempty"`
	KafkaRetentionHours    int               `yaml:"kafka_retention_hours,omitempty"`
	KafkaStorageSize       string            `yaml:"kafka_storage_size,omitempty"`
	KafkaReplicationFactor int               `yaml:"kafka_replication_factor,omitempty"`
	ScaleUpStabilization   int               `yaml:"scale_up_stabilization,omitempty"`
	ScaleDownStabilization int               `yaml:"scale_down_stabilization,omitempty"`
	KedaPollingInterval    int               `yaml:"keda_polling_interval,omitempty"`
	HPSResources           *ResourceConfig   `yaml:"hps_resources,omitempty"`
	WorkerResources        *ResourceConfig   `yaml:"worker_resources,omitempty"`
}

// ResourceConfig defines resource limits and requests
type ResourceConfig struct {
	Requests *ResourceSpec `yaml:"requests,omitempty"`
	Limits   *ResourceSpec `yaml:"limits,omitempty"`
}

// ResourceSpec defines CPU and memory specifications
type ResourceSpec struct {
	CPU    string `yaml:"cpu,omitempty"`
	Memory string `yaml:"memory,omitempty"`
}

// Validate performs configuration validation
func (c *Config) Validate() error {
	// Validate required fields
	if c.Project.Name == "" {
		return fmt.Errorf("project.name is required")
	}
	if c.Project.Domain == "" {
		return fmt.Errorf("project.domain is required")
	}
	if c.Project.Email == "" {
		return fmt.Errorf("project.email is required")
	}

	// Validate email format
	if _, err := mail.ParseAddress(c.Project.Email); err != nil {
		return fmt.Errorf("invalid email address: %s", c.Project.Email)
	}

	// Validate project name (kubernetes compatible)
	if !isValidKubernetesName(c.Project.Name) {
		return fmt.Errorf("project name must be lowercase alphanumeric or '-', and must start and end with alphanumeric")
	}

	// Validate cloud provider
	switch c.Cloud.Provider {
	case "aws":
		if c.Cloud.Region == "" {
			return fmt.Errorf("cloud.region is required for AWS")
		}
	case "azure":
		if c.Cloud.Region == "" {
			return fmt.Errorf("cloud.region is required for Azure")
		}
	case "gcp":
		if c.Cloud.Region == "" {
			return fmt.Errorf("cloud.region is required for GCP")
		}
		if c.Cloud.GCP == nil || c.Cloud.GCP.ProjectID == "" {
			return fmt.Errorf("cloud.gcp.project_id is required for GCP")
		}
	default:
		return fmt.Errorf("unsupported cloud provider: %s (must be aws, azure, or gcp)", c.Cloud.Provider)
	}

	// Validate database configuration
	switch c.Database.Type {
	case "managed":
		if c.Database.Supabase == nil {
			return fmt.Errorf("database.supabase configuration is required for managed database")
		}
	case "self-hosted":
		// Self-hosted is valid
	case "external":
		if c.Database.External == nil {
			return fmt.Errorf("database.external configuration is required for external database")
		}
		if c.Database.External.Host == "" {
			return fmt.Errorf("database.external.host is required")
		}
		if c.Database.External.Port == 0 {
			return fmt.Errorf("database.external.port is required")
		}
	default:
		return fmt.Errorf("unsupported database type: %s (must be managed, self-hosted, or external)", c.Database.Type)
	}

	// Validate email configuration - check if SMTP is configured
	if c.Email.SMTP != nil {
		// Validate SMTP configuration
		if c.Email.SMTP.Host == "" {
			return fmt.Errorf("email.smtp.host is required")
		}
		if c.Email.SMTP.Port == 0 {
			return fmt.Errorf("email.smtp.port is required")
		}
		if c.Email.SMTP.Username == "" {
			return fmt.Errorf("email.smtp.username is required")
		}
		if c.Email.SMTP.PasswordFrom == "" {
			return fmt.Errorf("email.smtp.password_from is required")
		}
	}

	// Validate Kubernetes configuration
	if c.Kubernetes.NodeCount < 1 {
		return fmt.Errorf("kubernetes.node_count must be at least 1")
	}

	if c.Kubernetes.EnableAutoscale {
		if c.Kubernetes.MinNodes < 1 {
			return fmt.Errorf("kubernetes.min_nodes must be at least 1 when autoscaling is enabled")
		}
		if c.Kubernetes.MaxNodes < c.Kubernetes.MinNodes {
			return fmt.Errorf("kubernetes.max_nodes must be greater than or equal to min_nodes")
		}
	}

	// Validate monitoring configuration
	if c.Monitoring.Enabled {
		// Validate mode
		if c.Monitoring.Mode != "" && c.Monitoring.Mode != "local" && c.Monitoring.Mode != "remote" {
			return fmt.Errorf("monitoring.mode must be 'local' or 'remote'")
		}

		// Validate remote configuration
		if c.Monitoring.Mode == "remote" {
			if c.Monitoring.Remote == nil {
				return fmt.Errorf("monitoring.remote configuration is required for remote mode")
			}

			// Validate provider
			switch c.Monitoring.Remote.Provider {
			case "prometheus", "grafana-cloud", "newrelic", "custom":
				// Valid providers
			default:
				return fmt.Errorf("unsupported monitoring provider: %s", c.Monitoring.Remote.Provider)
			}

			// Validate provider-specific configuration
			switch c.Monitoring.Remote.Provider {
			case "prometheus", "grafana-cloud", "custom":
				if c.Monitoring.Remote.PrometheusWrite == nil {
					return fmt.Errorf("monitoring.remote.prometheus_write is required for provider '%s'", c.Monitoring.Remote.Provider)
				}
				if c.Monitoring.Remote.PrometheusWrite.URL == "" {
					return fmt.Errorf("monitoring.remote.prometheus_write.url is required")
				}
			case "newrelic":
				if c.Monitoring.Remote.NewRelic == nil {
					return fmt.Errorf("monitoring.remote.newrelic configuration is required for New Relic provider")
				}
				if c.Monitoring.Remote.NewRelic.LicenseKeyFrom == "" {
					return fmt.Errorf("monitoring.remote.newrelic.license_key_from is required")
				}
			}
		}
	}

	return nil
}

// ApplyDefaults applies default values to the configuration
func (c *Config) ApplyDefaults() {
	// Version should already be set to CLI version by InitWizard
	// Only set a default if somehow still empty
	if c.Version == "" {
		c.Version = "1.0"
	}

	// Apply cloud defaults
	switch c.Cloud.Provider {
	case "aws":
		if c.Cloud.AWS == nil {
			c.Cloud.AWS = &AWSConfig{}
		}
		if c.Cloud.AWS.InstanceType == "" {
			c.Cloud.AWS.InstanceType = "c8g.large"
		}
		if c.Cloud.AWS.VPCCidr == "" {
			c.Cloud.AWS.VPCCidr = "10.0.0.0/16"
		}
	case "azure":
		if c.Cloud.Azure == nil {
			c.Cloud.Azure = &AzureConfig{}
		}
		if c.Cloud.Azure.VMSize == "" {
			c.Cloud.Azure.VMSize = "Standard_D4ps_v5"
		}
	case "gcp":
		if c.Cloud.GCP == nil {
			c.Cloud.GCP = &GCPConfig{}
		}
		if c.Cloud.GCP.MachineType == "" {
			c.Cloud.GCP.MachineType = "t2a-standard-4"
		}
	}

	// Apply Kubernetes defaults
	if c.Kubernetes.ClusterName == "" {
		c.Kubernetes.ClusterName = "rulebricks-cluster"
	}
	if c.Kubernetes.NodeCount == 0 {
		c.Kubernetes.NodeCount = 3
	}
	if c.Kubernetes.EnableAutoscale && c.Kubernetes.MinNodes == 0 {
		c.Kubernetes.MinNodes = c.Kubernetes.NodeCount
	}
	if c.Kubernetes.EnableAutoscale && c.Kubernetes.MaxNodes == 0 {
		c.Kubernetes.MaxNodes = c.Kubernetes.NodeCount * 2
	}

	// Apply security defaults
	if c.Security.TLS == nil {
		c.Security.TLS = &TLSConfig{
			Enabled:  true,
			Provider: "cert-manager",
		}
	}

	// Apply monitoring defaults
	if c.Monitoring.Enabled {
		// Default to local mode if not specified
		if c.Monitoring.Mode == "" {
			if c.Monitoring.Provider != "" {
				// Migrate from old provider field
				c.Monitoring.Mode = "remote"
			} else {
				c.Monitoring.Mode = "local"
			}
		}

		// Apply local monitoring defaults
		if c.Monitoring.Mode == "local" {
			if c.Monitoring.Local == nil {
				c.Monitoring.Local = &LocalMonitoringConfig{
					PrometheusEnabled: true,
					GrafanaEnabled:    true,
					Retention:         "30d",
					StorageSize:       "50Gi",
				}
			}
		}

		// Apply remote monitoring defaults
		if c.Monitoring.Mode == "remote" {
			if c.Monitoring.Remote != nil && c.Monitoring.Remote.Provider == "" {
				c.Monitoring.Remote.Provider = "prometheus"
			}
			if c.Monitoring.Remote != nil && c.Monitoring.Remote.NewRelic != nil && c.Monitoring.Remote.NewRelic.Region == "" {
				c.Monitoring.Remote.NewRelic.Region = "US"
			}
		}
	}

	if c.Monitoring.Metrics == nil {
		c.Monitoring.Metrics = &MetricsConfig{
			Retention: "30d",
			Interval:  "30s",
		}
	}
	if c.Monitoring.Logs == nil {
		c.Monitoring.Logs = &LogsConfig{
			Level:     "info",
			Retention: "7d",
		}
	}

	// Apply performance defaults
	if c.Performance.VolumeLevel == "" {
		c.Performance.VolumeLevel = "medium"
	}
	if c.Performance.HPSReplicas == 0 {
		c.Performance.HPSReplicas = 1
	}
	if c.Performance.HPSMaxReplicas == 0 {
		c.Performance.HPSMaxReplicas = 5
	}
	if c.Performance.KafkaPartitions == 0 {
		c.Performance.KafkaPartitions = 10
	}
	if c.Performance.KafkaRetentionHours == 0 {
		c.Performance.KafkaRetentionHours = 24
	}
	if c.Performance.KafkaReplicationFactor == 0 {
		c.Performance.KafkaReplicationFactor = 1
	}
}

// MarshalYAML marshals the configuration to YAML
func (c *Config) MarshalYAML() ([]byte, error) {
	return yaml.Marshal(c)
}

// UnmarshalYAML unmarshals the configuration from YAML
func (c *Config) UnmarshalYAML(data []byte) error {
	return yaml.Unmarshal(data, c)
}

// GetNamespace returns the namespace for a given component
func (c *Config) GetNamespace(component string) string {
	if c.Project.Namespace != "" && component == "app" {
		return c.Project.Namespace
	}
	return GetDefaultNamespace(c.Project.Name, component)
}

// Helper functions

func isValidKubernetesName(name string) bool {
	if len(name) == 0 || len(name) > 63 {
		return false
	}

	regex := regexp.MustCompile(`^[a-z0-9]([-a-z0-9]*[a-z0-9])?$`)
	return regex.MatchString(name)
}

func sanitizeName(name string) string {
	// Convert to lowercase and replace invalid characters
	name = strings.ToLower(name)
	name = regexp.MustCompile(`[^a-z0-9-]`).ReplaceAllString(name, "-")
	name = regexp.MustCompile(`-+`).ReplaceAllString(name, "-")
	name = strings.Trim(name, "-")

	if len(name) > 63 {
		name = name[:63]
	}

	return name
}

// GetDefaultNamespace returns the default namespace for a component
func GetDefaultNamespace(projectName, component string) string {
	prefix := sanitizeName(projectName)

	switch component {
	case "traefik":
		return fmt.Sprintf("%s-traefik", prefix)
	case "cert-manager":
		return fmt.Sprintf("%s-cert-manager", prefix)
	case "monitoring", "prometheus", "grafana":
		return fmt.Sprintf("%s-monitoring", prefix)
	case "supabase":
		return fmt.Sprintf("%s-supabase", prefix)
	case "logging", "vector":
		return fmt.Sprintf("%s-logging", prefix)
	case "execution", "kafka", "workers", "keda":
		return fmt.Sprintf("%s-execution", prefix)
	case "rulebricks", "app":
		return fmt.Sprintf("%s-app", prefix)
	default:
		return fmt.Sprintf("%s-default", prefix)
	}
}
