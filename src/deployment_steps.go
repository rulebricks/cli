package main

import (
	"context"
	"crypto/tls"
	"fmt"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"

	"gopkg.in/yaml.v3"
)

// InfrastructureStep handles cloud infrastructure provisioning
type InfrastructureStep struct{}

func (s *InfrastructureStep) Name() string {
	return "Infrastructure"
}

func (s *InfrastructureStep) Description() string {
	return "Provision cloud infrastructure and Kubernetes cluster"
}

func (s *InfrastructureStep) Required() bool {
	return true
}

func (s *InfrastructureStep) CanRollback() bool {
	return true
}

func (s *InfrastructureStep) Estimate() time.Duration {
	return 15 * time.Minute
}

func (s *InfrastructureStep) Execute(ctx context.Context, d *Deployer) error {
	if d.cloudOps == nil {
		return fmt.Errorf("cloud operations not initialized")
	}

	// Create infrastructure
	if err := d.cloudOps.CreateInfrastructure(ctx); err != nil {
		return fmt.Errorf("failed to create infrastructure: %w", err)
	}

	// Wait for cluster to be ready
	if err := d.cloudOps.WaitForClusterReady(ctx); err != nil {
		return fmt.Errorf("cluster not ready: %w", err)
	}

	// Get cluster endpoint
	clusterEndpoint, err := d.cloudOps.GetClusterEndpoint()
	if err != nil {
		return fmt.Errorf("failed to get cluster endpoint: %w", err)
	}

	// Update deployment state
	d.state.Infrastructure = InfrastructureState{
		Provider:        d.config.Cloud.Provider,
		Region:          d.config.Cloud.Region,
		ClusterName:     d.config.Kubernetes.ClusterName,
		ClusterEndpoint: clusterEndpoint,
		NodeCount:       d.config.Kubernetes.NodeCount,
		CreatedAt:       time.Now(),
	}

	// Save state
	if err := d.saveState(); err != nil {
		d.progress.Warning("Failed to save infrastructure state: %v", err)
	}

	// Initialize Kubernetes operations with the new cluster
	k8sOps, err := NewKubernetesOperations(d.config, d.options.Verbose)
	if err != nil {
		return fmt.Errorf("failed to initialize Kubernetes operations: %w", err)
	}
	d.k8sOps = k8sOps

	return nil
}

func (s *InfrastructureStep) Rollback(ctx context.Context, d *Deployer) error {
	if d.cloudOps == nil {
		return nil
	}
	return d.cloudOps.DestroyInfrastructure(ctx)
}

// CoreServicesStep installs core Kubernetes services
type CoreServicesStep struct{}

func (s *CoreServicesStep) Name() string {
	return "Core Services"
}

func (s *CoreServicesStep) Description() string {
	return "Install Traefik ingress and other core services"
}

func (s *CoreServicesStep) Required() bool {
	return true
}

func (s *CoreServicesStep) CanRollback() bool {
	return true
}

func (s *CoreServicesStep) Estimate() time.Duration {
	return 5 * time.Minute
}

func (s *CoreServicesStep) Execute(ctx context.Context, d *Deployer) error {
	if d.k8sOps == nil {
		return fmt.Errorf("Kubernetes operations not initialized")
	}

	// Install Traefik
	if err := d.k8sOps.InstallTraefik(ctx, d.extractedChartPath); err != nil {
		return fmt.Errorf("failed to install Traefik: %w", err)
	}



	// Install KEDA for autoscaling
	if err := d.k8sOps.InstallKEDA(ctx); err != nil {
		return fmt.Errorf("failed to install KEDA: %w", err)
	}

	return nil
}

func (s *CoreServicesStep) Rollback(ctx context.Context, d *Deployer) error {
	if d.k8sOps == nil {
		return nil
	}

	// Uninstall in reverse order
	d.k8sOps.UninstallKEDA(ctx)
	d.k8sOps.UninstallTraefik(ctx)

	return nil
}

// DatabaseStep handles database deployment
type DatabaseStep struct{}

func (s *DatabaseStep) Name() string {
	return "Database"
}

func (s *DatabaseStep) Description() string {
	return "Deploy and configure database (Supabase or external)"
}

func (s *DatabaseStep) Required() bool {
	return true
}

func (s *DatabaseStep) CanRollback() bool {
	return true
}

func (s *DatabaseStep) Estimate() time.Duration {
	switch s.getType() {
	case "managed":
		return 5 * time.Minute
	case "self-hosted":
		return 10 * time.Minute
	default:
		return 2 * time.Minute
	}
}

func (s *DatabaseStep) getType() string {
	// This would normally access the config through context
	return "self-hosted"
}

func (s *DatabaseStep) Execute(ctx context.Context, d *Deployer) error {
	if d.supabaseOps == nil {
		return fmt.Errorf("Supabase operations not initialized")
	}

	// Deploy database based on type
	if err := d.supabaseOps.Deploy(ctx); err != nil {
		return fmt.Errorf("failed to deploy database: %w", err)
	}

	// Run migrations
	if err := d.supabaseOps.RunMigrations(ctx); err != nil {
		return fmt.Errorf("failed to run migrations: %w", err)
	}

	// Store database credentials in secrets
	d.secrets.DBPassword = d.supabaseOps.GetDBPassword()
	d.secrets.SupabaseAnonKey = d.supabaseOps.GetAnonKey()
	d.secrets.SupabaseServiceKey = d.supabaseOps.GetServiceKey()
	d.secrets.JWTSecret = d.supabaseOps.GetJWTSecret()

	return nil
}

func (s *DatabaseStep) Rollback(ctx context.Context, d *Deployer) error {
	if d.supabaseOps == nil {
		return nil
	}

	// Only rollback self-hosted databases
	if d.config.Database.Type == "self-hosted" {
		return d.k8sOps.UninstallSupabase(ctx)
	}

	return nil
}

// EmailConfigStep configures email services
type EmailConfigStep struct{}

func (s *EmailConfigStep) Name() string {
	return "Email Configuration"
}

func (s *EmailConfigStep) Description() string {
	return "Configure email provider and templates"
}

func (s *EmailConfigStep) Required() bool {
	return true
}

func (s *EmailConfigStep) CanRollback() bool {
	return false
}

func (s *EmailConfigStep) Estimate() time.Duration {
	return 1 * time.Minute
}

func (s *EmailConfigStep) Execute(ctx context.Context, d *Deployer) error {
	// Email configuration is handled through environment variables
	// and ConfigMaps created during application deployment
	d.progress.Debug("Email configuration will be applied during application deployment")
	return nil
}

func (s *EmailConfigStep) Rollback(ctx context.Context, d *Deployer) error {
	// No rollback needed for email configuration
	return nil
}

// MonitoringStep installs monitoring stack
type MonitoringStep struct{}

func (s *MonitoringStep) Name() string {
	return "Monitoring"
}

func (s *MonitoringStep) Description() string {
	return "Configure monitoring infrastructure"
}

func (s *MonitoringStep) Required() bool {
	return false
}

func (s *MonitoringStep) CanRollback() bool {
	return true
}

func (s *MonitoringStep) Estimate() time.Duration {
	return 5 * time.Minute
}

func (s *MonitoringStep) Execute(ctx context.Context, d *Deployer) error {
	if d.k8sOps == nil {
		return fmt.Errorf("Kubernetes operations not initialized")
	}

	// Check monitoring mode
	mode := d.config.Monitoring.Mode
	if mode == "" {
		mode = "local" // Default to local
	}

	switch mode {
	case "local":
		// Install full monitoring stack
		grafanaPassword := generateSecurePassword()
		if err := d.k8sOps.InstallPrometheus(ctx, grafanaPassword, nil); err != nil {
			return fmt.Errorf("failed to install monitoring stack: %w", err)
		}

		// Update state with monitoring info
		if d.state != nil {
			d.state.Monitoring = MonitoringState{
				Enabled:         true,
				Provider:        "prometheus",
				GrafanaURL:      fmt.Sprintf("https://grafana.%s", d.config.Project.Domain),
				GrafanaUsername: "admin",
				GrafanaPassword: grafanaPassword,
			}
		}

	case "remote":
		// Install Prometheus with remote write configuration (no Grafana)
		remoteWriteConfig := d.prepareRemoteWriteConfig()

		if err := d.k8sOps.InstallPrometheusWithRemoteWrite(ctx, "", remoteWriteConfig, false); err != nil {
			return fmt.Errorf("failed to install Prometheus with remote write: %w", err)
		}

		// Update state
		if d.state != nil {
			d.state.Monitoring = MonitoringState{
				Enabled:  true,
				Provider: d.config.Monitoring.Remote.Provider,
			}
		}

	default:
		return fmt.Errorf("unknown monitoring mode: %s", mode)
	}

	return nil
}

func (s *MonitoringStep) Rollback(ctx context.Context, d *Deployer) error {
	if d.k8sOps == nil {
		return nil
	}
	return d.k8sOps.UninstallPrometheus(ctx)
}

// prepareRemoteWriteConfig prepares Prometheus remote write configuration
func (d *Deployer) prepareRemoteWriteConfig() map[string]interface{} {
	if d.config.Monitoring.Remote == nil {
		return nil
	}

	remoteWriteConfigs := []map[string]interface{}{}

	switch d.config.Monitoring.Remote.Provider {
	case "prometheus", "grafana-cloud", "custom":
		if pw := d.config.Monitoring.Remote.PrometheusWrite; pw != nil {
			config := map[string]interface{}{
				"url": pw.URL,
			}

			// Add authentication
			if pw.Username != "" && pw.PasswordFrom != "" {
				password := d.secrets.GetSecret(pw.PasswordFrom)
				config["basicAuth"] = map[string]interface{}{
					"username": pw.Username,
					"password": password,
				}
			} else if pw.BearerTokenFrom != "" {
				token := d.secrets.GetSecret(pw.BearerTokenFrom)
				config["bearerToken"] = token
			}

			// Add custom headers
			if len(pw.Headers) > 0 {
				config["headers"] = pw.Headers
			}

			// Add relabel configs
			if len(pw.WriteRelabelConfigs) > 0 {
				relabelConfigs := []map[string]interface{}{}
				for _, rc := range pw.WriteRelabelConfigs {
					relabelConfig := map[string]interface{}{}
					if len(rc.SourceLabels) > 0 {
						relabelConfig["sourceLabels"] = rc.SourceLabels
					}
					if rc.Separator != "" {
						relabelConfig["separator"] = rc.Separator
					}
					if rc.TargetLabel != "" {
						relabelConfig["targetLabel"] = rc.TargetLabel
					}
					if rc.Regex != "" {
						relabelConfig["regex"] = rc.Regex
					}
					if rc.Replacement != "" {
						relabelConfig["replacement"] = rc.Replacement
					}
					if rc.Action != "" {
						relabelConfig["action"] = rc.Action
					}
					relabelConfigs = append(relabelConfigs, relabelConfig)
				}
				config["writeRelabelConfigs"] = relabelConfigs
			}

			remoteWriteConfigs = append(remoteWriteConfigs, config)
		}

	case "newrelic":
		if nr := d.config.Monitoring.Remote.NewRelic; nr != nil {
			licenseKey := d.secrets.GetSecret(nr.LicenseKeyFrom)
			// New Relic endpoints by region
			url := "https://metric-api.newrelic.com/prometheus/v1/write"
			if nr.Region == "EU" {
				url = "https://metric-api.eu.newrelic.com/prometheus/v1/write"
			}
			remoteWriteConfigs = append(remoteWriteConfigs, map[string]interface{}{
				"url": url,
				"headers": map[string]string{
					"X-License-Key": licenseKey,
				},
			})
		}
	}

	if len(remoteWriteConfigs) > 0 {
		return map[string]interface{}{
			"remoteWrite": remoteWriteConfigs,
		}
	}

	return nil
}

// LoggingStep installs centralized logging
type LoggingStep struct{}

func (s *LoggingStep) Name() string {
	return "Logging"
}

func (s *LoggingStep) Description() string {
	return "Install Vector for centralized log collection"
}

func (s *LoggingStep) Required() bool {
	return false
}

func (s *LoggingStep) CanRollback() bool {
	return true
}

func (s *LoggingStep) Estimate() time.Duration {
	return 3 * time.Minute
}

func (s *LoggingStep) Execute(ctx context.Context, d *Deployer) error {
	if d.k8sOps == nil {
		return fmt.Errorf("Kubernetes operations not initialized")
	}

	// Install Vector
	if err := d.k8sOps.InstallVector(ctx, d.config.Logging.Vector); err != nil {
		return fmt.Errorf("failed to install Vector: %w", err)
	}

	// Update state with Vector endpoint
	if d.state != nil {
		d.state.Application.VectorEndpoint = fmt.Sprintf("vector.%s:9000", d.config.GetNamespace("logging"))
	}

	return nil
}

func (s *LoggingStep) Rollback(ctx context.Context, d *Deployer) error {
	if d.k8sOps == nil {
		return nil
	}
	return d.k8sOps.UninstallVector(ctx)
}

// KafkaStep installs Kafka for event streaming
type KafkaStep struct{}

func (s *KafkaStep) Name() string {
	return "Kafka"
}

func (s *KafkaStep) Description() string {
	return "Install Kafka for event streaming and job processing"
}

func (s *KafkaStep) Required() bool {
	return true
}

func (s *KafkaStep) CanRollback() bool {
	return true
}

func (s *KafkaStep) Estimate() time.Duration {
	return 5 * time.Minute
}

func (s *KafkaStep) Execute(ctx context.Context, d *Deployer) error {
	if d.k8sOps == nil {
		return fmt.Errorf("Kubernetes operations not initialized")
	}

	// Install Kafka
	kafkaConfig := KafkaConfig{
		Partitions:        d.config.Performance.KafkaPartitions,
		ReplicationFactor: d.config.Performance.KafkaReplicationFactor,
		RetentionHours:    d.config.Performance.KafkaRetentionHours,
		StorageSize:       d.config.Performance.KafkaStorageSize,
	}

	if err := d.k8sOps.InstallKafka(ctx, kafkaConfig); err != nil {
		return fmt.Errorf("failed to install Kafka: %w", err)
	}

	// Update state with Kafka brokers
	if d.state != nil {
		d.state.Application.KafkaBrokers = fmt.Sprintf("kafka.%s.svc.cluster.local:9092", d.config.GetNamespace("execution"))
	}

	return nil
}

func (s *KafkaStep) Rollback(ctx context.Context, d *Deployer) error {
	if d.k8sOps == nil {
		return nil
	}
	return d.k8sOps.UninstallKafka(ctx)
}

// ApplicationStep deploys the main application
type ApplicationStep struct{}

func (s *ApplicationStep) Name() string {
	return "Application"
}

func (s *ApplicationStep) Description() string {
	return "Deploy Rulebricks application"
}

func (s *ApplicationStep) Required() bool {
	return true
}

func (s *ApplicationStep) CanRollback() bool {
	return true
}

func (s *ApplicationStep) Estimate() time.Duration {
	return 5 * time.Minute
}

func (s *ApplicationStep) Execute(ctx context.Context, d *Deployer) error {
	if d.k8sOps == nil {
		return fmt.Errorf("Kubernetes operations not initialized")
	}

	// Prepare application values
	values := d.prepareApplicationValues()

	// Deploy application using the pre-extracted chart
	if err := d.k8sOps.InstallApplication(ctx, d.extractedChartPath, values); err != nil {
		return fmt.Errorf("failed to deploy application: %w", err)
	}

	// Wait for application to be ready
	if err := d.k8sOps.WaitForApplicationReady(ctx); err != nil {
		return fmt.Errorf("application not ready: %w", err)
	}

	// Update state
	if d.state != nil {
		d.state.Application.Deployed = true
		d.state.Application.Version = d.options.ChartVersion
		d.state.Application.Replicas = d.config.Performance.HPSReplicas
	}

	return nil
}

func (s *ApplicationStep) Rollback(ctx context.Context, d *Deployer) error {
	if d.k8sOps == nil {
		return nil
	}
	return d.k8sOps.UninstallApplication(ctx)
}

// DNSVerificationStep verifies DNS configuration
type DNSVerificationStep struct{}

func (s *DNSVerificationStep) Name() string {
	return "DNS Verification"
}

func (s *DNSVerificationStep) Description() string {
	return "Verify DNS records are properly configured"
}

func (s *DNSVerificationStep) Required() bool {
	return true
}

func (s *DNSVerificationStep) CanRollback() bool {
	return false
}

func (s *DNSVerificationStep) Estimate() time.Duration {
	return 2 * time.Minute
}

func (s *DNSVerificationStep) Execute(ctx context.Context, d *Deployer) error {
	// Get load balancer endpoint
	endpoint, err := d.k8sOps.GetLoadBalancerEndpoint(ctx)
	if err != nil {
		return fmt.Errorf("failed to get load balancer endpoint: %w", err)
	}

	// Store in state
	if d.state != nil {
		d.state.LoadBalancerEndpoint = endpoint
	}

	// Display DNS requirements
	fmt.Printf("\n📝 Please configure the following DNS records:\n\n")
	fmt.Printf("1. Main application:\n")
	fmt.Printf("   Type:  CNAME\n")
	fmt.Printf("   Name:  %s\n", d.config.Project.Domain)
	fmt.Printf("   Value: %s\n\n", endpoint)

	if d.config.Database.Type == "self-hosted" {
		fmt.Printf("2. Supabase dashboard:\n")
		fmt.Printf("   Type:  CNAME\n")
		fmt.Printf("   Name:  supabase.%s\n", d.config.Project.Domain)
		fmt.Printf("   Value: %s\n\n", endpoint)
	}

	// Check if Grafana is enabled based on monitoring mode
	includeGrafana := false
	if d.config.Monitoring.Enabled {
		mode := d.config.Monitoring.Mode
		if mode == "" {
			mode = "local"
		}
		if mode == "local" {
			includeGrafana = true
		}
	}

	if includeGrafana {
		fmt.Printf("3. Grafana dashboard:\n")
		fmt.Printf("   Type:  CNAME\n")
		fmt.Printf("   Name:  grafana.%s\n", d.config.Project.Domain)
		fmt.Printf("   Value: %s\n\n", endpoint)
	}

	// Verify DNS resolution
	domains := []string{d.config.Project.Domain}
	if d.config.Database.Type == "self-hosted" {
		domains = append(domains, fmt.Sprintf("supabase.%s", d.config.Project.Domain))
	}
	if includeGrafana {
		domains = append(domains, fmt.Sprintf("grafana.%s", d.config.Project.Domain))
	}

	// Wait for DNS propagation with timeout
	maxAttempts := 120 // 10 minutes total (5 second intervals)
	attempt := 0
	allResolved := false
	resolvedDomains := make(map[string]bool)

	fmt.Println() // Add spacing after DNS records

	for attempt < maxAttempts && !allResolved {
		// Check context cancellation
		select {
		case <-ctx.Done():
			return ctx.Err()
		default:
		}

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
				if err == nil && strings.Contains(string(output), endpoint) {
					resolved = true
					break
				}
			}

			if resolved {
				resolvedDomains[domain] = true
				// d.progress.Success("%s resolved successfully", domain)
			} else {
				allResolved = false
				pendingCount++
			}
		}

		if allResolved {
			d.progress.Success("All DNS records have propagated successfully!")
			break
		}

		// Show simple progress on the same line
		elapsed := attempt * 5
		fmt.Printf("\r⏳ Checking DNS... %d/%d domains resolved (%ds elapsed)", len(domains)-pendingCount, len(domains), elapsed)

		if attempt < maxAttempts {
			time.Sleep(5 * time.Second)
		}
	}

	if !allResolved {
		fmt.Printf("\n") // Clear the progress line
		d.progress.Warning("DNS propagation timeout reached after %d minutes.", maxAttempts*5/60)
		fmt.Printf("\n📋 DNS Status:\n")

		for _, domain := range domains {
			if resolvedDomains[domain] {
				d.progress.Success("   %s → %s", domain, endpoint)
			} else {
				// Do a final check to provide specific error
				cmd := exec.Command("nslookup", domain, "8.8.8.8")
				output, err := cmd.Output()
				if err != nil || strings.Contains(string(output), "can't find") || strings.Contains(string(output), "NXDOMAIN") {
					d.progress.Error("   %s - Not found (DNS record not configured)", domain)
				} else if !strings.Contains(string(output), endpoint) {
					d.progress.Warning("   %s - Pointing to wrong target", domain)
				} else {
					d.progress.Warning("   %s - Not fully propagated", domain)
				}
			}
		}

		if !d.options.Verbose && !nonInteractive {
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

func (s *DNSVerificationStep) Rollback(ctx context.Context, d *Deployer) error {
	// No rollback for DNS verification
	return nil
}

// TLSConfigurationStep configures TLS certificates
type TLSConfigurationStep struct{}

func (s *TLSConfigurationStep) Name() string {
	return "TLS Configuration"
}

func (s *TLSConfigurationStep) Description() string {
	return "Configure SSL/TLS certificates for secure access"
}

func (s *TLSConfigurationStep) Required() bool {
	return true
}

func (s *TLSConfigurationStep) CanRollback() bool {
	return true
}

func (s *TLSConfigurationStep) Estimate() time.Duration {
	return 3 * time.Minute
}

func (s *TLSConfigurationStep) Execute(ctx context.Context, d *Deployer) error {
	// Get TLS configuration
	tlsConfig := d.config.Security.TLS
	if tlsConfig == nil || !tlsConfig.Enabled {
		return nil
	}

	// Create a temporary values file that overrides the ACME configuration
	traefikNamespace := d.config.GetNamespace("traefik")
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
			fmt.Sprintf("--certificatesresolvers.le.acme.email=%s", tlsConfig.AcmeEmail),
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
	// Check if Grafana is enabled based on monitoring mode
	includeGrafana := false
	if d.config.Monitoring.Enabled {
		mode := d.config.Monitoring.Mode
		if mode == "" {
			mode = "local"
		}
		if mode == "local" {
			includeGrafana = true
		}
	}

	if includeGrafana {
		sans = append(sans, fmt.Sprintf("grafana.%s", d.config.Project.Domain))
	}
	// Add Supabase domain if self-hosted
	if d.config.Database.Type == "self-hosted" {
		sans = append(sans, fmt.Sprintf("supabase.%s", d.config.Project.Domain))
	}
	// Add any additional domains from config
	sans = append(sans, tlsConfig.Domains...)

	if len(sans) > 0 {
		domains["sans"] = sans
	}

	// Create temporary values file
	tlsValuesFile, err := createTempFile("traefik-tls-", ".yaml", nil)
	if err != nil {
		return fmt.Errorf("failed to create TLS values file: %w", err)
	}
	defer os.Remove(tlsValuesFile)

	// Write the values to the file
	valuesYAML, err := yaml.Marshal(tlsOverrides)
	if err != nil {
		return fmt.Errorf("failed to marshal TLS values: %w", err)
	}
	if err := os.WriteFile(tlsValuesFile, valuesYAML, 0644); err != nil {
		return fmt.Errorf("failed to write TLS values file: %w", err)
	}

	// Use the traefik-values-tls.yaml from the extracted chart
	traefikTLSValuesPath := filepath.Join(d.extractedChartPath, "rulebricks", "traefik-values-tls.yaml")

	// Build helm upgrade command with BOTH values files (just like the old implementation)
	args := []string{
		"upgrade", "--install", "traefik", "traefik/traefik",
		"--namespace", traefikNamespace,
		"-f", traefikTLSValuesPath,  // Base TLS configuration
		"-f", tlsValuesFile,          // Our overrides
		"--wait",
	}

	cmd := exec.CommandContext(ctx, "helm", args...)

	spinner := d.progress.StartSpinner("Configuring TLS certificates")

	var output []byte
	if d.options.Verbose {
		d.progress.Debug("Running: helm %s", strings.Join(args, " "))
		cmd.Stdout = os.Stdout
		cmd.Stderr = os.Stderr
		err = cmd.Run()
	} else {
		output, err = cmd.CombinedOutput()
	}

	if err != nil {
		spinner.Fail()
		if len(output) > 0 {
			return fmt.Errorf("failed to configure TLS: %w\nOutput: %s", err, string(output))
		}
		return fmt.Errorf("failed to configure TLS: %w", err)
	}
	spinner.Success()

	// Wait for Traefik to be ready
	cmd = exec.CommandContext(ctx, "kubectl", "wait", "--for=condition=ready", "pod",
		"-l", "app.kubernetes.io/name=traefik",
		"-n", traefikNamespace,
		"--timeout=300s")

	if err := cmd.Run(); err != nil {
		return fmt.Errorf("traefik pod failed to become ready: %w", err)
	}

	// Check certificate status with retries
	maxAttempts := 30  // 5 minutes total
	certificateObtained := false

	for i := 0; i < maxAttempts; i++ {
		// Check if certificate is ready by querying traefik
		checkCmd := exec.CommandContext(ctx, "kubectl", "exec", "-n", traefikNamespace,
			"deployment/traefik", "--",
			"cat", "/data/acme.json")

		output, err := checkCmd.Output()
		if err == nil && len(output) > 100 {  // acme.json should have content
			if d.options.Verbose {
				d.progress.Debug("ACME storage file size: %d bytes", len(output))
			}
			certificateObtained = true
			fmt.Println() // Clear the progress line
			break
		}

		if i%6 == 0 {
			fmt.Printf("\r⏳ Waiting for TLS certificate... (%d seconds elapsed)", i*10)
			if d.options.Verbose {
				// Check traefik logs for any errors
				logsCmd := exec.CommandContext(ctx, "kubectl", "logs", "-n", traefikNamespace,
					"deployment/traefik", "--tail=20")
				if logsOutput, err := logsCmd.Output(); err == nil {
					d.progress.Debug("Recent Traefik logs:\n%s", string(logsOutput))
				}
			}
		}

		// Give more time on the first attempt for DNS propagation
		if i == 0 {
			time.Sleep(20 * time.Second)
		} else {
			time.Sleep(10 * time.Second)
		}
	}

	if !certificateObtained {
		fmt.Println() // Clear the progress line
		if d.options.Verbose {
			// Get final traefik logs for debugging
			logsCmd := exec.CommandContext(ctx, "kubectl", "logs", "-n", traefikNamespace,
				"deployment/traefik", "--tail=50")
			if logsOutput, err := logsCmd.Output(); err == nil {
				d.progress.Error("TLS configuration failed. Traefik logs:\n%s", string(logsOutput))
			}

			// Check traefik pod status
			podCmd := exec.CommandContext(ctx, "kubectl", "describe", "pod", "-n", traefikNamespace,
				"-l", "app.kubernetes.io/name=traefik")
			if podOutput, err := podCmd.Output(); err == nil {
				d.progress.Debug("Traefik pod status:\n%s", string(podOutput))
			}
		}

		return fmt.Errorf("timeout waiting for TLS certificate after 5 minutes - check if domain is accessible and DNS is properly configured")
	}

	// Give DNS and certificate a moment to propagate
	time.Sleep(10 * time.Second)

	// Verify HTTPS is working
	httpsURL := fmt.Sprintf("https://%s", d.config.Project.Domain)
	client := &http.Client{
		Timeout: 30 * time.Second,
		Transport: &http.Transport{
			TLSClientConfig: &tls.Config{
				InsecureSkipVerify: false,
			},
		},
	}

	maxRetries := 30 // 5 minutes total
	for i := 0; i < maxRetries; i++ {
		resp, err := client.Get(httpsURL)
		if err == nil {
			defer resp.Body.Close()
			if resp.TLS != nil && len(resp.TLS.PeerCertificates) > 0 {
				cert := resp.TLS.PeerCertificates[0]
				// Check if certificate is valid for the domain
				if err := cert.VerifyHostname(d.config.Project.Domain); err == nil {
					// Also get the load balancer endpoint for information
					lbCmd := exec.CommandContext(ctx, "kubectl", "get", "svc", "traefik",
						"-n", traefikNamespace,
						"-o", "jsonpath={.status.loadBalancer.ingress[0].hostname}")

					if lbOutput, err := lbCmd.Output(); err == nil {
						lbEndpoint := strings.TrimSpace(string(lbOutput))
						if lbEndpoint != "" {
							d.progress.Info("Load balancer endpoint: %s", lbEndpoint)
						}
					}

					d.progress.Success("Main application HTTPS verified")

					// For self-hosted Supabase, also verify the Supabase domain
					if d.config.Database.Type == "self-hosted" {
						supabaseURL := fmt.Sprintf("https://supabase.%s", d.config.Project.Domain)
						d.progress.Info("Verifying Supabase HTTPS endpoint...")

						// Give Supabase endpoint a bit more time to propagate
						time.Sleep(5 * time.Second)

						supabaseRetries := 12 // 2 minutes for Supabase
						for j := 0; j < supabaseRetries; j++ {
							supabaseResp, err := client.Get(supabaseURL)
							if err == nil {
								defer supabaseResp.Body.Close()
								if supabaseResp.TLS != nil && len(supabaseResp.TLS.PeerCertificates) > 0 {
									cert := supabaseResp.TLS.PeerCertificates[0]
									// Check if certificate is valid for the subdomain
									if err := cert.VerifyHostname(fmt.Sprintf("supabase.%s", d.config.Project.Domain)); err == nil {
										d.progress.Success("Supabase HTTPS verified")
										return nil
									}
								}
							}

							if j < supabaseRetries-1 {
								if d.options.Verbose {
									d.progress.Debug("Supabase HTTPS not ready yet, retrying in 10 seconds... (attempt %d/%d)", j+1, supabaseRetries)
									if err != nil {
										d.progress.Debug("Error: %v", err)
									}
								}
								time.Sleep(10 * time.Second)
							}
						}

						// If Supabase verification failed, warn but don't fail the deployment
						d.progress.Warning("Supabase HTTPS endpoint not yet accessible at %s", supabaseURL)
						d.progress.Warning("This may cause issues with first-time login. Please wait a few minutes for DNS propagation.")
					}

					return nil
				}
			}
		}

		if i < maxRetries-1 {
			if d.options.Verbose {
				d.progress.Debug("HTTPS not ready yet, retrying in 10 seconds... (attempt %d/%d)", i+1, maxRetries)
				if err != nil {
					d.progress.Debug("Error: %v", err)
				}
			}
			time.Sleep(10 * time.Second)
		}
	}

	// If we get here, HTTPS verification failed
	return fmt.Errorf("HTTPS endpoint verification failed for %s - certificate may not be valid", d.config.Project.Domain)
}

func (s *TLSConfigurationStep) Rollback(ctx context.Context, d *Deployer) error {
	if d.k8sOps == nil {
		return nil
	}
	// Remove certificate configurations
	return d.k8sOps.RemoveTLSConfiguration(ctx)
}

// Helper methods for Deployer

func (d *Deployer) prepareApplicationValues() map[string]interface{} {
	// Get Kafka brokers from state or use internal service
	kafkaBrokers := ""
	if d.state != nil && d.state.Application.KafkaBrokers != "" {
		kafkaBrokers = d.state.Application.KafkaBrokers
	} else {
		kafkaBrokers = fmt.Sprintf("kafka.%s.svc.cluster.local:9092", d.config.GetNamespace("execution"))
	}

	// Map sink types to friendly names
	sinkFriendlyNames := map[string]string{
		"elasticsearch":      "Elasticsearch",
		"datadog_logs":       "Datadog",
		"loki":               "Grafana Loki",
		"aws_s3":             "AWS S3",
		"azure_blob":         "Azure Blob Storage",
		"gcp_cloud_storage":  "Google Cloud Storage",
		"splunk_hec":         "Splunk",
		"new_relic_logs":     "New Relic",
		"http":               "Custom HTTP endpoint",
	}

	loggingDestination := "console" // default
	if d.config.Logging.Vector != nil && d.config.Logging.Vector.Sink != nil {
		loggingDestination = sinkFriendlyNames[d.config.Logging.Vector.Sink.Type]
		if loggingDestination == "" {
			loggingDestination = d.config.Logging.Vector.Sink.Type
		}
	}

	values := map[string]interface{}{
		"app": map[string]interface{}{
			"tlsEnabled":          true,
			"email":               d.config.Project.Email,
			"licenseKey":          d.secrets.LicenseKey,
			"nextPublicSelfHosted": "1",
			"supabaseUrl":         d.getSupabaseURL(),
			"supabaseAnonKey":     d.secrets.SupabaseAnonKey,
			"supabaseServiceKey":  d.secrets.SupabaseServiceKey,
			"replicas": func() int {
				if d.config.Performance.HPSReplicas > 0 {
					return d.config.Performance.HPSReplicas
				}
				return 2 // Default replicas
			}(),
			"smtp": func() map[string]interface{} {
				if d.config.Email.SMTP != nil {
					return map[string]interface{}{
						"host":     d.config.Email.SMTP.Host,
						"port":     d.config.Email.SMTP.Port,
						"user":     d.config.Email.SMTP.Username,
						"pass":     d.secrets.SMTPPassword,
						"from":     d.config.Email.From,
						"fromName": d.config.Email.FromName,
					}
				}
				// Return minimal SMTP config if not configured
				return map[string]interface{}{
					"host":     "localhost",
					"port":     25,
					"user":     "",
					"pass":     "",
					"from":     d.config.Email.From,
					"fromName": d.config.Email.FromName,
				}
			}(),
			"logging": map[string]interface{}{
				"enabled":             true,
				"kafkaBrokers":        kafkaBrokers,
				"kafkaTopic":          "logs",
				"loggingDestination":  loggingDestination,
			},
		},
		"imageCredentials": map[string]interface{}{
			"registry": "index.docker.io",
			"username": "rulebricks",
			"password": fmt.Sprintf("dckr_pat_%s", d.secrets.LicenseKey),
		},
		"ingress": map[string]interface{}{
			"enabled":   true,
			"className": "traefik",
			"hosts": []map[string]interface{}{
				{
					"host": d.config.Project.Domain,
					"paths": []map[string]interface{}{
						{
							"path":     "/",
							"pathType": "Prefix",
						},
					},
				},
			},
		},
	}

	// Add AI configuration if enabled
	openAIKey := os.Getenv("OPENAI_API_KEY")
	if d.config.AI.Enabled && openAIKey != "" {
		values["app"].(map[string]interface{})["ai"] = map[string]interface{}{
			"enabled":      true,
			"openaiApiKey": openAIKey,
		}
	}

	// Configure email templates
	emailTemplates := GetDefaultEmailTemplates()

	// Override with custom template URLs if configured
	if d.config.Email.Templates != nil {
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
	}

	// Add email template configuration
	values["app"].(map[string]interface{})["emailTemplates"] = emailTemplates

	// Add network security settings if configured
	if d.config.Security.Network != nil && len(d.config.Security.Network.AllowedIPs) > 0 {
		values["security"] = map[string]interface{}{
			"network": map[string]interface{}{
				"allowedIPs": d.config.Security.Network.AllowedIPs,
			},
		}
	}

	// Add custom Docker registry configuration if specified
	if d.config.Advanced.DockerRegistry != nil && d.config.Advanced.DockerRegistry.AppImage != "" {
		if appConfig, ok := values["app"].(map[string]interface{}); ok {
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
				return 1
			}(),
			"maxReplicas": func() int {
				if d.config.Performance.HPSMaxReplicas > 0 {
					return d.config.Performance.HPSMaxReplicas
				}
				return 10
			}(),
			"targetCPUUtilizationPercentage": 50,
			"targetMemoryUtilizationPercentage": 80,
		},
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
	}

	values["hps"] = hpsConfig

	// Add custom values if any
	if d.config.Advanced.CustomValues != nil {
		// Add custom app values specifically
		if customApp, ok := d.config.Advanced.CustomValues["app"].(map[string]interface{}); ok {
			for k, v := range customApp {
				values["app"].(map[string]interface{})[k] = v
			}
		}

		// Add other custom values at top level
		for k, v := range d.config.Advanced.CustomValues {
			if k != "app" { // Skip app since we handled it above
				values[k] = v
			}
		}
	}

	return values
}

func (d *Deployer) prepareEmailConfig() map[string]interface{} {
	emailConfig := map[string]interface{}{
		"provider": d.config.Email.Provider,
		"from":     d.config.Email.From,
		"fromName": d.config.Email.FromName,
	}

	// All email providers use SMTP configuration
	if d.config.Email.SMTP != nil {
		emailConfig["smtp"] = map[string]interface{}{
			"host":       d.config.Email.SMTP.Host,
			"port":       d.config.Email.SMTP.Port,
			"username":   d.config.Email.SMTP.Username,
			"password":   d.secrets.SMTPPassword,
			"encryption": d.config.Email.SMTP.Encryption,
		}
	}

	return emailConfig
}

func (d *Deployer) getDatabaseURL() string {
	// This would be implemented based on database type
	return d.state.Database.URL
}

func (d *Deployer) getSupabaseURL() string {
	switch d.config.Database.Type {
	case "managed":
		return fmt.Sprintf("https://%s.supabase.co", d.config.Database.Supabase.ProjectName)
	case "self-hosted", "external":
		return fmt.Sprintf("https://supabase.%s", d.config.Project.Domain)
	default:
		return ""
	}
}

func (d *Deployer) confirmDNSConfigured() bool {
	// This method is no longer needed as the new DNS verification
	// shows all domains upfront and waits for Enter, not Y/N
	return true
}

// Utility function
func generateSecurePassword() string {
	return generateRandomString(16)
}
