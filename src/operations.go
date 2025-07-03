package main

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strings"
	"time"

	"gopkg.in/yaml.v3"
	appsv1 "k8s.io/api/apps/v1"
	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/client-go/kubernetes"
	"k8s.io/client-go/tools/clientcmd"
)

// CloudOperations handles cloud infrastructure operations
type CloudOperations struct {
	config       *Config
	terraformDir string
	verbose      bool
	progress     *ProgressIndicator
}

// NewCloudOperations creates a new cloud operations instance
func NewCloudOperations(config *Config, terraformDir string, verbose bool) (*CloudOperations, error) {
	return &CloudOperations{
		config:       config,
		terraformDir: terraformDir,
		verbose:      verbose,
		progress:     NewProgressIndicator(verbose),
	}, nil
}

// CreateInfrastructure provisions cloud infrastructure using Terraform
func (co *CloudOperations) CreateInfrastructure(ctx context.Context) error {
	// Set provider-specific terraform directory
	co.terraformDir = filepath.Join("terraform", co.config.Cloud.Provider)

	// Ensure terraform directory exists
	if _, err := os.Stat("terraform"); os.IsNotExist(err) {
		return fmt.Errorf("terraform directory not found. Expected terraform files in ./terraform/%s", co.config.Cloud.Provider)
	}

	// Check if the specific provider directory exists
	if _, err := os.Stat(co.terraformDir); os.IsNotExist(err) {
		return fmt.Errorf("terraform configuration not found for %s provider at %s", co.config.Cloud.Provider, co.terraformDir)
	}

	// Verify terraform files exist in provider directory
	entries, err := os.ReadDir(co.terraformDir)
	if err != nil {
		return fmt.Errorf("failed to read terraform directory: %w", err)
	}

	hasTfFiles := false
	for _, entry := range entries {
		if strings.HasSuffix(entry.Name(), ".tf") {
			hasTfFiles = true
			break
		}
	}

	if !hasTfFiles {
		return fmt.Errorf("no Terraform configuration files found in %s", co.terraformDir)
	}

	// Configure terraform backend if specified
	if err := co.ConfigureTerraformBackend(); err != nil {
		return fmt.Errorf("failed to configure terraform backend: %w", err)
	}

	// Initialize Terraform
	if err := co.terraformInit(ctx); err != nil {
		return fmt.Errorf("terraform init failed: %w", err)
	}

	// Plan deployment
	if err := co.terraformPlan(ctx); err != nil {
		return fmt.Errorf("terraform plan failed: %w", err)
	}

	// Apply configuration
	if err := co.terraformApply(ctx); err != nil {
		return fmt.Errorf("terraform apply failed: %w", err)
	}

	return nil
}

// DestroyInfrastructure destroys the cloud infrastructure
func (co *CloudOperations) DestroyInfrastructure(ctx context.Context) error {
	// Set provider-specific terraform directory (same as CreateInfrastructure)
	co.terraformDir = filepath.Join("terraform", co.config.Cloud.Provider)

	// Ensure terraform directory exists
	if _, err := os.Stat(co.terraformDir); os.IsNotExist(err) {
		return fmt.Errorf("terraform configuration not found for %s provider at %s", co.config.Cloud.Provider, co.terraformDir)
	}

	return co.terraformDestroy(ctx)
}

// ConfigureTerraformBackend configures remote state backend
func (co *CloudOperations) ConfigureTerraformBackend() error {
	if co.config.Advanced.Terraform == nil || co.config.Advanced.Terraform.Backend == "" || co.config.Advanced.Terraform.Backend == "local" {
		return nil // Local backend, no configuration needed
	}

	co.progress.Info("Configuring Terraform %s backend...", co.config.Advanced.Terraform.Backend)

	// Create backend configuration file
	backendConfig := "terraform {\n  backend \"" + co.config.Advanced.Terraform.Backend + "\" {\n"

	for k, v := range co.config.Advanced.Terraform.BackendConfig {
		backendConfig += fmt.Sprintf("    %s = \"%s\"\n", k, v)
	}

	backendConfig += "  }\n}\n"

	// Write to backend.tf in terraform directory
	backendPath := filepath.Join(co.terraformDir, "backend.tf")
	if err := os.WriteFile(backendPath, []byte(backendConfig), 0644); err != nil {
		return fmt.Errorf("failed to write backend config: %w", err)
	}

	return nil
}

// WaitForClusterReady waits for the Kubernetes cluster to be ready
func (co *CloudOperations) WaitForClusterReady(ctx context.Context) error {
	// Get kubeconfig
	if err := co.updateKubeconfig(ctx); err != nil {
		return err
	}

	// Wait for cluster API to be responsive
	deadline := time.Now().Add(10 * time.Minute)
	for time.Now().Before(deadline) {
		if err := co.checkClusterHealth(ctx); err == nil {
			return nil
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(30 * time.Second):
			// Continue checking
		}
	}

	return fmt.Errorf("cluster did not become ready in time")
}

// GetInfrastructureState returns the current infrastructure state
func (co *CloudOperations) GetInfrastructureState() InfrastructureState {
	state := InfrastructureState{
		Provider:  co.config.Cloud.Provider,
		Region:    co.config.Cloud.Region,
		CreatedAt: time.Now(),
	}

	// Try to get actual values from terraform outputs
	outputs, err := co.getTerraformOutputs()
	if err == nil {
		// Use actual cluster name from terraform
		if clusterName, ok := outputs["cluster_name"]; ok && clusterName != "" {
			state.ClusterName = clusterName
		} else {
			state.ClusterName = co.config.Kubernetes.ClusterName
		}

		// Get actual cluster endpoint
		if endpoint, ok := outputs["cluster_endpoint"]; ok && endpoint != "" {
			state.ClusterEndpoint = endpoint
		}

		// TODO: Get actual node count from cluster if needed
		state.NodeCount = co.config.Kubernetes.NodeCount
	} else {
		// Fallback to config values
		state.ClusterName = co.config.Kubernetes.ClusterName
		state.NodeCount = co.config.Kubernetes.NodeCount
	}

	return state
}

// Private methods

func (co *CloudOperations) terraformInit(ctx context.Context) error {
	cmd := exec.CommandContext(ctx, "terraform", "init", "-upgrade")
	cmd.Dir = co.terraformDir
	return co.runCommand(cmd, "Initializing Terraform")
}

func (co *CloudOperations) terraformPlan(ctx context.Context) error {
	args := []string{"plan", "-out=tfplan"}
	args = append(args, co.getTerraformVariables()...)

	cmd := exec.CommandContext(ctx, "terraform", args...)
	cmd.Dir = co.terraformDir
	return co.runCommand(cmd, "Planning infrastructure changes")
}

func (co *CloudOperations) terraformApply(ctx context.Context) error {
	cmd := exec.CommandContext(ctx, "terraform", "apply", "-auto-approve", "tfplan")
	cmd.Dir = co.terraformDir
	return co.runCommand(cmd, "Creating infrastructure")
}

func (co *CloudOperations) terraformDestroy(ctx context.Context) error {
	args := []string{"destroy", "-auto-approve"}
	args = append(args, co.getTerraformVariables()...)

	cmd := exec.CommandContext(ctx, "terraform", args...)
	cmd.Dir = co.terraformDir

	// Don't create a new spinner since destroyer already has one running
	if co.verbose {
		cmd.Stdout = os.Stdout
		cmd.Stderr = os.Stderr
		co.progress.Debug("Running: %s", strings.Join(cmd.Args, " "))
	}
	return cmd.Run()
}

func (co *CloudOperations) updateKubeconfig(ctx context.Context) error {
	// First try to get cluster info from terraform outputs
	outputs, err := co.getTerraformOutputs()
	if err == nil {
		// Check if there's a configure_kubectl output (contains actual cluster name)
		if configCmd, ok := outputs["configure_kubectl"]; ok && configCmd != "" {
			cmd := exec.Command("sh", "-c", configCmd)
			return co.runCommand(cmd, "Updating kubeconfig")
		}

		// Check if there's a cluster_name output
		if clusterName, ok := outputs["cluster_name"]; ok && clusterName != "" {
			// Use the actual cluster name from terraform
			switch co.config.Cloud.Provider {
			case "aws":
				cmd := exec.CommandContext(ctx, "aws", "eks", "update-kubeconfig",
					"--name", clusterName,
					"--region", co.config.Cloud.Region)
				return co.runCommand(cmd, "Updating kubeconfig")
			case "azure":
				cmd := exec.CommandContext(ctx, "az", "aks", "get-credentials",
					"--name", clusterName,
					"--resource-group", co.config.Cloud.Azure.ResourceGroup,
					"--overwrite-existing")
				return co.runCommand(cmd, "Updating kubeconfig")
			case "gcp":
				cmd := exec.CommandContext(ctx, "gcloud", "container", "clusters", "get-credentials",
					clusterName,
					"--zone", co.config.Cloud.GCP.Zone,
					"--project", co.config.Cloud.GCP.ProjectID)
				return co.runCommand(cmd, "Updating kubeconfig")
			}
		}
	}

	// Fallback to using cluster name from config
	switch co.config.Cloud.Provider {
	case "aws":
		cmd := exec.CommandContext(ctx, "aws", "eks", "update-kubeconfig",
			"--name", co.config.Kubernetes.ClusterName,
			"--region", co.config.Cloud.Region)
		return co.runCommand(cmd, "Updating kubeconfig")
	case "azure":
		cmd := exec.CommandContext(ctx, "az", "aks", "get-credentials",
			"--name", co.config.Kubernetes.ClusterName,
			"--resource-group", co.config.Cloud.Azure.ResourceGroup,
			"--overwrite-existing")
		return co.runCommand(cmd, "Updating kubeconfig")
	case "gcp":
		cmd := exec.CommandContext(ctx, "gcloud", "container", "clusters", "get-credentials",
			co.config.Kubernetes.ClusterName,
			"--zone", co.config.Cloud.GCP.Zone,
			"--project", co.config.Cloud.GCP.ProjectID)
		return co.runCommand(cmd, "Updating kubeconfig")
	default:
		return fmt.Errorf("unsupported cloud provider: %s", co.config.Cloud.Provider)
	}
}

func (co *CloudOperations) checkClusterHealth(ctx context.Context) error {
	config, err := clientcmd.BuildConfigFromFlags("", clientcmd.NewDefaultClientConfigLoadingRules().GetDefaultFilename())
	if err != nil {
		return err
	}

	clientset, err := kubernetes.NewForConfig(config)
	if err != nil {
		return err
	}

	_, err = clientset.CoreV1().Nodes().List(ctx, metav1.ListOptions{})
	return err
}

func (co *CloudOperations) runCommand(cmd *exec.Cmd, description string) error {
	if co.verbose {
		cmd.Stdout = os.Stdout
		cmd.Stderr = os.Stderr
		co.progress.Debug("Running: %s", strings.Join(cmd.Args, " "))
		return cmd.Run()
	}

	spinner := co.progress.StartSpinner(description)
	err := cmd.Run()
	if err != nil {
		spinner.Fail()
		return err
	}
	spinner.Success()
	return nil
}

// getTerraformOutputs retrieves terraform outputs
func (co *CloudOperations) getTerraformOutputs() (map[string]string, error) {
	cmd := exec.Command("terraform", "output", "-json")
	cmd.Dir = co.terraformDir

	output, err := cmd.Output()
	if err != nil {
		return nil, fmt.Errorf("failed to get terraform outputs: %w", err)
	}

	// Parse JSON output
	var tfOutputs map[string]interface{}
	if err := json.Unmarshal(output, &tfOutputs); err != nil {
		return nil, fmt.Errorf("failed to parse terraform outputs: %w", err)
	}

	// Convert to simple string map
	outputs := make(map[string]string)
	for key, val := range tfOutputs {
		if valMap, ok := val.(map[string]interface{}); ok {
			if value, exists := valMap["value"]; exists {
				outputs[key] = fmt.Sprintf("%v", value)
			}
		}
	}

	return outputs, nil
}

// getTerraformVariables generates terraform variable arguments from config
func (co *CloudOperations) getTerraformVariables() []string {
	var args []string

	// Cluster name is common across all providers
	if co.config.Kubernetes.ClusterName != "" {
		args = append(args, "-var", fmt.Sprintf("cluster_name=%s", co.config.Kubernetes.ClusterName))
	}

	// Provider-specific variables
	switch co.config.Cloud.Provider {
	case "aws":
		// AWS-specific variables
		if co.config.Cloud.Region != "" {
			args = append(args, "-var", fmt.Sprintf("region=%s", co.config.Cloud.Region))
		}
		if co.config.Kubernetes.NodeCount > 0 {
			args = append(args, "-var", fmt.Sprintf("desired_capacity=%d", co.config.Kubernetes.NodeCount))
		}
		if co.config.Kubernetes.MinNodes > 0 {
			args = append(args, "-var", fmt.Sprintf("min_capacity=%d", co.config.Kubernetes.MinNodes))
		}
		if co.config.Kubernetes.MaxNodes > 0 {
			args = append(args, "-var", fmt.Sprintf("max_capacity=%d", co.config.Kubernetes.MaxNodes))
		}
		if co.config.Cloud.AWS != nil {
			if co.config.Cloud.AWS.VPCCidr != "" {
				args = append(args, "-var", fmt.Sprintf("vpc_cidr=%s", co.config.Cloud.AWS.VPCCidr))
			}
			if co.config.Cloud.AWS.InstanceType != "" {
				args = append(args, "-var", fmt.Sprintf("node_instance_type=%s", co.config.Cloud.AWS.InstanceType))
			}
		}

	case "azure":
		// Azure-specific variables
		if co.config.Cloud.Region != "" {
			args = append(args, "-var", fmt.Sprintf("location=%s", co.config.Cloud.Region))
		}
		if co.config.Kubernetes.NodeCount > 0 {
			args = append(args, "-var", fmt.Sprintf("node_count=%d", co.config.Kubernetes.NodeCount))
		}
		if co.config.Kubernetes.MinNodes > 0 {
			args = append(args, "-var", fmt.Sprintf("min_count=%d", co.config.Kubernetes.MinNodes))
		}
		if co.config.Kubernetes.MaxNodes > 0 {
			args = append(args, "-var", fmt.Sprintf("max_count=%d", co.config.Kubernetes.MaxNodes))
		}
		if co.config.Cloud.Azure != nil {
			if co.config.Cloud.Azure.ResourceGroup != "" {
				args = append(args, "-var", fmt.Sprintf("resource_group_name=%s", co.config.Cloud.Azure.ResourceGroup))
			}
			if co.config.Cloud.Azure.VMSize != "" {
				args = append(args, "-var", fmt.Sprintf("vm_size=%s", co.config.Cloud.Azure.VMSize))
			}
		}

	case "gcp":
		// GCP-specific variables
		if co.config.Cloud.Region != "" {
			args = append(args, "-var", fmt.Sprintf("region=%s", co.config.Cloud.Region))
		}
		if co.config.Kubernetes.NodeCount > 0 {
			args = append(args, "-var", fmt.Sprintf("initial_node_count=%d", co.config.Kubernetes.NodeCount))
		}
		if co.config.Kubernetes.MinNodes > 0 {
			args = append(args, "-var", fmt.Sprintf("min_node_count=%d", co.config.Kubernetes.MinNodes))
		}
		if co.config.Kubernetes.MaxNodes > 0 {
			args = append(args, "-var", fmt.Sprintf("max_node_count=%d", co.config.Kubernetes.MaxNodes))
		}
		if co.config.Cloud.GCP != nil {
			if co.config.Cloud.GCP.ProjectID != "" {
				args = append(args, "-var", fmt.Sprintf("project_id=%s", co.config.Cloud.GCP.ProjectID))
			}
			if co.config.Cloud.GCP.Zone != "" {
				args = append(args, "-var", fmt.Sprintf("zone=%s", co.config.Cloud.GCP.Zone))
			}
			if co.config.Cloud.GCP.MachineType != "" {
				args = append(args, "-var", fmt.Sprintf("machine_type=%s", co.config.Cloud.GCP.MachineType))
			}
		}
	}

	// Advanced terraform variables
	if co.config.Advanced.Terraform != nil && co.config.Advanced.Terraform.Variables != nil {
		for k, v := range co.config.Advanced.Terraform.Variables {
			args = append(args, "-var", fmt.Sprintf("%s=%v", k, v))
		}
	}

	return args
}

// KubernetesOperations handles Kubernetes cluster operations
type KubernetesOperations struct {
	config    *Config
	client    kubernetes.Interface
	verbose   bool
	progress  *ProgressIndicator
}

// NewKubernetesOperations creates a new Kubernetes operations instance
func NewKubernetesOperations(config *Config, verbose bool) (*KubernetesOperations, error) {
	kubeconfig := clientcmd.NewDefaultClientConfigLoadingRules().GetDefaultFilename()

	k8sConfig, err := clientcmd.BuildConfigFromFlags("", kubeconfig)
	if err != nil {
		return nil, fmt.Errorf("failed to build kubeconfig: %w", err)
	}

	client, err := kubernetes.NewForConfig(k8sConfig)
	if err != nil {
		return nil, fmt.Errorf("failed to create kubernetes client: %w", err)
	}

	return &KubernetesOperations{
		config:   config,
		client:   client,
		verbose:  verbose,
		progress: NewProgressIndicator(verbose),
	}, nil
}

// Core service installation methods

func (ko *KubernetesOperations) InstallTraefik(ctx context.Context, chartPath string) error {
	namespace := ko.config.GetNamespace("traefik")
	if err := ko.ensureNamespace(ctx, namespace); err != nil {
		return err
	}

	// Add Traefik Helm repository
	cmd := exec.CommandContext(ctx, "helm", "repo", "add", "traefik", "https://helm.traefik.io/traefik", "--force-update")
	if err := cmd.Run(); err != nil {
		// Ignore error if repo already exists
		ko.progress.Debug("Traefik repo may already exist: %v", err)
	}

	cmd = exec.CommandContext(ctx, "helm", "repo", "update")
	if err := cmd.Run(); err != nil {
		return fmt.Errorf("failed to update Helm repositories: %w", err)
	}

	// Use the traefik values file from the extracted chart
	traefikValuesPath := filepath.Join(chartPath, "rulebricks", "traefik-values-no-tls.yaml")

	// Install Traefik with the values file
	args := []string{
		"upgrade", "--install", "traefik", "traefik/traefik",
		"--namespace", namespace,
		"--create-namespace",
		"-f", traefikValuesPath,
		"--wait",
		"--timeout", "10m",
	}

	cmd = exec.CommandContext(ctx, "helm", args...)
	if ko.verbose {
		ko.progress.Debug("Running: %s", strings.Join(cmd.Args, " "))
		cmd.Stdout = os.Stdout
		cmd.Stderr = os.Stderr
	}

	spinner := ko.progress.StartSpinner("Installing Traefik ingress controller")

	// Capture output for debugging
	var output []byte
	var err error
	if ko.verbose {
		err = cmd.Run()
	} else {
		output, err = cmd.CombinedOutput()
	}

	if err != nil {
		spinner.Fail()
		if len(output) > 0 {
			return fmt.Errorf("failed to install Traefik: %w\nOutput: %s", err, string(output))
		}
		return fmt.Errorf("failed to install Traefik: %w", err)
	}
	spinner.Success()

	// Wait for Traefik to be ready
	ko.progress.Info("Waiting for Traefik to be ready...")

	// First check if deployment exists
	checkCmd := exec.CommandContext(ctx, "kubectl", "get", "deployment", "traefik", "-n", namespace)
	if err := checkCmd.Run(); err != nil {
		return fmt.Errorf("traefik deployment not found: %w", err)
	}

	// Then wait for it to be ready
	waitCmd := exec.CommandContext(ctx, "kubectl", "wait", "--for=condition=available", "deployment/traefik",
		"-n", namespace,
		"--timeout=300s")

	if err := waitCmd.Run(); err != nil {
		// Get more info about what's wrong
		statusCmd := exec.CommandContext(ctx, "kubectl", "get", "pods", "-n", namespace, "-o", "wide")
		statusOutput, _ := statusCmd.CombinedOutput()
		return fmt.Errorf("traefik deployment failed to become ready: %w\nPod status:\n%s", err, string(statusOutput))
	}

	return nil
}

func (ko *KubernetesOperations) UninstallTraefik(ctx context.Context) error {
	namespace := ko.config.GetNamespace("traefik")
	return ko.uninstallHelmChart(ctx, "traefik", namespace)
}

func (ko *KubernetesOperations) InstallCertManager(ctx context.Context) error {
	namespace := ko.config.GetNamespace("cert-manager")
	if err := ko.ensureNamespace(ctx, namespace); err != nil {
		return err
	}

	values := map[string]interface{}{
		"installCRDs": true,
	}

	return ko.installHelmChart(ctx, "cert-manager", "jetstack/cert-manager", namespace, values)
}

func (ko *KubernetesOperations) UninstallCertManager(ctx context.Context) error {
	namespace := ko.config.GetNamespace("cert-manager")
	return ko.uninstallHelmChart(ctx, "cert-manager", namespace)
}

func (ko *KubernetesOperations) InstallKEDA(ctx context.Context) error {
	namespace := ko.config.GetNamespace("execution")
	if err := ko.ensureNamespace(ctx, namespace); err != nil {
		return err
	}

	return ko.installHelmChart(ctx, "keda", "kedacore/keda", namespace, nil)
}

func (ko *KubernetesOperations) UninstallKEDA(ctx context.Context) error {
	namespace := ko.config.GetNamespace("execution")

	// Check if namespace exists first
	_, err := ko.client.CoreV1().Namespaces().Get(ctx, namespace, metav1.GetOptions{})
	if err != nil {
		// Namespace doesn't exist, nothing to uninstall
		return nil
	}

	return ko.uninstallHelmChart(ctx, "keda", namespace)
}

// Application installation

func (ko *KubernetesOperations) InstallApplication(ctx context.Context, chartPath string, values map[string]interface{}) error {
	namespace := ko.config.GetNamespace("app")
	if err := ko.ensureNamespace(ctx, namespace); err != nil {
		return err
	}

	// The chart is in the rulebricks subdirectory of the extracted path
	rulebricksChartPath := filepath.Join(chartPath, "rulebricks")
	return ko.installHelmChart(ctx, "rulebricks", rulebricksChartPath, namespace, values)
}

func (ko *KubernetesOperations) UninstallApplication(ctx context.Context) error {
	namespace := ko.config.GetNamespace("app")
	return ko.uninstallHelmChart(ctx, "rulebricks", namespace)
}

func (ko *KubernetesOperations) WaitForApplicationReady(ctx context.Context) error {
	namespace := ko.config.GetNamespace("app")
	return ko.waitForDeploymentReady(ctx, namespace, "rulebricks-app", 5*time.Minute)
}

// Monitoring installation

func (ko *KubernetesOperations) InstallPrometheus(ctx context.Context, grafanaPassword string, remoteWriteConfig map[string]interface{}) error {
	return ko.InstallPrometheusWithRemoteWrite(ctx, grafanaPassword, remoteWriteConfig, true)
}

// InstallPrometheusWithRemoteWrite installs Prometheus with optional Grafana and remote write configuration
func (ko *KubernetesOperations) InstallPrometheusWithRemoteWrite(ctx context.Context, grafanaPassword string, remoteWriteConfig map[string]interface{}, includeGrafana bool) error {
	namespace := ko.config.GetNamespace("monitoring")
	if err := ko.ensureNamespace(ctx, namespace); err != nil {
		return err
	}

	values := map[string]interface{}{
		"prometheus": map[string]interface{}{
			"prometheusSpec": map[string]interface{}{},
		},
	}

	// Configure Prometheus storage based on monitoring mode
	retention := "30d"
	storageSize := "50Gi"

	if ko.config.Monitoring.Mode == "remote" {
		// Shorter retention for remote mode
		retention = "7d"
		storageSize = "10Gi"
	}

	// Set retention and storage
	promSpec := values["prometheus"].(map[string]interface{})["prometheusSpec"].(map[string]interface{})
	promSpec["retention"] = retention
	promSpec["storageSpec"] = map[string]interface{}{
		"volumeClaimTemplate": map[string]interface{}{
			"spec": map[string]interface{}{
				"accessModes": []string{"ReadWriteOnce"},
				"resources": map[string]interface{}{
					"requests": map[string]interface{}{
						"storage": storageSize,
					},
				},
			},
		},
	}

	// Add remote write configuration if provided
	if remoteWriteConfig != nil && remoteWriteConfig["remoteWrite"] != nil {
		promSpec["remoteWrite"] = remoteWriteConfig["remoteWrite"]
	}

	// Configure Grafana
	if includeGrafana && grafanaPassword != "" {
		values["grafana"] = map[string]interface{}{
			"enabled":       true,
			"adminPassword": grafanaPassword,
			"ingress": map[string]interface{}{
				"enabled":   true,
				"className": "traefik",
				"hosts":     []string{fmt.Sprintf("grafana.%s", ko.config.Project.Domain)},
				"annotations": map[string]interface{}{
					"traefik.ingress.kubernetes.io/router.entrypoints":      "websecure",
					"traefik.ingress.kubernetes.io/router.tls":              "true",
					"traefik.ingress.kubernetes.io/router.tls.certresolver": "le",
				},
				"tls": []map[string]interface{}{
					{
						"hosts": []string{
							fmt.Sprintf("grafana.%s", ko.config.Project.Domain),
						},
					},
				},
			},
		}
	} else {
		// Disable Grafana
		values["grafana"] = map[string]interface{}{
			"enabled": false,
		}
	}

	// Disable alertmanager for remote configurations
	if ko.config.Monitoring.Mode == "remote" {
		values["alertmanager"] = map[string]interface{}{
			"enabled": false,
		}
	}

	return ko.installHelmChart(ctx, "prometheus", "prometheus-community/kube-prometheus-stack", namespace, values)
}

func (ko *KubernetesOperations) UninstallPrometheus(ctx context.Context) error {
	namespace := ko.config.GetNamespace("monitoring")
	return ko.uninstallHelmChart(ctx, "prometheus", namespace)
}

// Logging installation

func (ko *KubernetesOperations) InstallVector(ctx context.Context, vectorConfig *VectorConfig) error {
	namespace := ko.config.GetNamespace("logging")
	if err := ko.ensureNamespace(ctx, namespace); err != nil {
		return err
	}

	// Add Vector Helm repository
	cmd := exec.CommandContext(ctx, "helm", "repo", "add", "vector", "https://helm.vector.dev")
	if err := cmd.Run(); err != nil {
		// Ignore error if repo already exists
	}

	cmd = exec.CommandContext(ctx, "helm", "repo", "update")
	if err := cmd.Run(); err != nil {
		return fmt.Errorf("failed to update Helm repositories: %w", err)
	}

	// Get Kafka brokers - use internal service
	kafkaBrokers := fmt.Sprintf("kafka.%s.svc.cluster.local:9092", ko.config.GetNamespace("execution"))

	// Generate Vector configuration with Kafka source
	configMap := ko.generateVectorConfigMap(vectorConfig, kafkaBrokers)

	// Use project-specific release name to avoid conflicts
	releaseName := fmt.Sprintf("vector-%s", ko.config.Project.Name)

	// Check if we need a specific service account for IAM
	serviceAccountName := releaseName
	if vectorConfig != nil && vectorConfig.Sink != nil && vectorConfig.Sink.Config != nil {
		// Check for cloud storage sinks that might need IAM service accounts
		switch vectorConfig.Sink.Type {
		case "aws_s3":
			// S3 will use vector-s3-access service account if IAM is configured
			if setupIAM, ok := vectorConfig.Sink.Config["setup_iam"].(bool); ok && setupIAM {
				serviceAccountName = "vector-s3-access"
			}
		case "gcp_cloud_storage":
			// GCS will use vector-gcs-access service account if Workload Identity is configured
			if useWI, ok := vectorConfig.Sink.Config["use_workload_identity"].(bool); ok && useWI {
				serviceAccountName = "vector-gcs-access"
			}
		case "azure_blob":
			// Azure doesn't change service account but needs pod identity label
			// This is handled by the IAM setup command
		}
	}

	values := map[string]interface{}{
		"role":              "Stateless-Aggregator", // Use Deployment instead of DaemonSet
		"replicas":          2,                      // Start with 2 replicas
		"customConfig":      configMap,
		"fullnameOverride":  releaseName, // Make all resources project-specific
		"rbac": map[string]interface{}{
			"create":             true,
			"serviceAccountName": serviceAccountName,
		},
		"service": map[string]interface{}{
			"type": "ClusterIP", // Internal only, not exposed
			"ports": []map[string]interface{}{
				{
					"port":       9090,
					"targetPort": 9090,
					"protocol":   "TCP",
					"name":       "metrics", // For Prometheus metrics
				},
			},
		},
		"resources": map[string]interface{}{
			"requests": map[string]interface{}{
				"cpu":    "50m", // Reduced since it's just consuming from Kafka
				"memory": "128Mi",
			},
			"limits": map[string]interface{}{
				"cpu":    "200m",
				"memory": "256Mi",
			},
		},
	}

	return ko.installHelmChart(ctx, releaseName, "vector/vector", namespace, values)
}

func (ko *KubernetesOperations) UninstallVector(ctx context.Context) error {
	namespace := ko.config.GetNamespace("logging")
	releaseName := fmt.Sprintf("vector-%s", ko.config.Project.Name)
	return ko.uninstallHelmChart(ctx, releaseName, namespace)
}

// Kafka installation

func (ko *KubernetesOperations) InstallKafka(ctx context.Context, config KafkaConfig) error {
	namespace := ko.config.GetNamespace("execution")
	if err := ko.ensureNamespace(ctx, namespace); err != nil {
		return err
	}

	// Add Bitnami Helm repository
	cmd := exec.CommandContext(ctx, "helm", "repo", "add", "bitnami", "https://charts.bitnami.com/bitnami")
	if err := cmd.Run(); err != nil {
		// Ignore error if repo already exists
	}

	cmd = exec.CommandContext(ctx, "helm", "repo", "update")
	if err := cmd.Run(); err != nil {
		return fmt.Errorf("failed to update Helm repositories: %w", err)
	}

	// Set default values if not configured
	retentionHours := config.RetentionHours
	if retentionHours == 0 {
		retentionHours = 24
	}
	partitionCount := config.Partitions
	if partitionCount == 0 {
		partitionCount = 3
	}
	replicationFactor := config.ReplicationFactor
	if replicationFactor == 0 {
		replicationFactor = 2
	}
	storageSize := config.StorageSize
	if storageSize == "" {
		storageSize = "50Gi"
	}

	values := map[string]interface{}{
		"replicaCount": replicationFactor,
		"persistence": map[string]interface{}{
			"enabled": true,
			"size":    storageSize,
		},
		"logRetentionHours": retentionHours,
		"autoCreateTopicsEnable": true,
		"defaultReplicationFactor": replicationFactor,
		"offsetsTopicReplicationFactor": replicationFactor,
		"numPartitions": partitionCount,
		"service": map[string]interface{}{
			"type": "LoadBalancer",
			"ports": map[string]interface{}{
				"client": 9092,
			},
		},
		"controller": map[string]interface{}{
			"resources": map[string]interface{}{
				"requests": map[string]interface{}{
					"cpu":    "250m",
					"memory": "512Mi",
				},
				"limits": map[string]interface{}{
					"cpu":    "500m",
					"memory": "2Gi",
				},
			},
		},
		"kraft": map[string]interface{}{
			"enabled": true,
		},
		"zookeeper": map[string]interface{}{
			"enabled": false,
		},
		"listeners": map[string]interface{}{
			"client": map[string]interface{}{
				"protocol": "PLAINTEXT",
			},
			"controller": map[string]interface{}{
				"protocol": "PLAINTEXT",
			},
			"interbroker": map[string]interface{}{
				"protocol": "PLAINTEXT",
			},
		},
	}

	return ko.installHelmChart(ctx, "kafka", "bitnami/kafka", namespace, values)
}

func (ko *KubernetesOperations) UninstallKafka(ctx context.Context) error {
	namespace := ko.config.GetNamespace("execution")
	return ko.uninstallHelmChart(ctx, "kafka", namespace)
}

// Supabase operations

func (ko *KubernetesOperations) UninstallSupabase(ctx context.Context) error {
	namespace := ko.config.GetNamespace("supabase")
	return ko.uninstallHelmChart(ctx, "supabase", namespace)
}

// TLS configuration

func (ko *KubernetesOperations) ConfigureLetsEncrypt(ctx context.Context, tlsConfig *TLSConfig) error {
	// Create ClusterIssuer for Let's Encrypt
	issuerYAML := fmt.Sprintf(`
apiVersion: cert-manager.io/v1
kind: ClusterIssuer
metadata:
  name: letsencrypt-prod
spec:
  acme:
    server: https://acme-v02.api.letsencrypt.org/directory
    email: %s
    privateKeySecretRef:
      name: letsencrypt-prod
    solvers:
    - http01:
        ingress:
          class: traefik
`, tlsConfig.AcmeEmail)

	return ko.applyYAML(ctx, issuerYAML)
}

func (ko *KubernetesOperations) ConfigureCustomTLS(ctx context.Context, tlsConfig *TLSConfig) error {
	// Create secret with custom certificates
	namespace := ko.config.GetNamespace("traefik")

	certData, err := os.ReadFile(tlsConfig.CustomCert)
	if err != nil {
		return fmt.Errorf("failed to read certificate: %w", err)
	}

	keyData, err := os.ReadFile(tlsConfig.CustomKey)
	if err != nil {
		return fmt.Errorf("failed to read key: %w", err)
	}

	return ko.createTLSSecret(ctx, namespace, "custom-tls", certData, keyData)
}

func (ko *KubernetesOperations) WaitForCertificates(ctx context.Context) error {
	// Wait for certificates to be issued
	deadline := time.Now().Add(5 * time.Minute)
	for time.Now().Before(deadline) {
		// Check if certificates are ready by checking ingress resources
		namespace := ko.config.GetNamespace("app")
		_, err := ko.client.CoreV1().Services(namespace).Get(ctx, "rulebricks", metav1.GetOptions{})
		if err == nil {
			// Service exists, certificates should be ready
			return nil
		}

		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(10 * time.Second):
			// Continue checking
		}
	}

	return fmt.Errorf("certificates not ready in time")
}

func (ko *KubernetesOperations) RemoveTLSConfiguration(ctx context.Context) error {
	// Remove ClusterIssuer
	cmd := exec.CommandContext(ctx, "kubectl", "delete", "clusterissuer", "letsencrypt-prod", "--ignore-not-found")
	return cmd.Run()
}

// Utility methods

// GetClusterEndpoint returns the cluster endpoint
func (co *CloudOperations) GetClusterEndpoint() (string, error) {
	ctx := context.Background()

	switch co.config.Cloud.Provider {
	case "aws":
		cmd := exec.CommandContext(ctx, "aws", "eks", "describe-cluster",
			"--name", co.config.Kubernetes.ClusterName,
			"--region", co.config.Cloud.Region,
			"--query", "cluster.endpoint",
			"--output", "text")
		output, err := cmd.Output()
		if err != nil {
			return "", fmt.Errorf("failed to get cluster endpoint: %w", err)
		}
		return strings.TrimSpace(string(output)), nil

	case "azure":
		cmd := exec.CommandContext(ctx, "az", "aks", "show",
			"--name", co.config.Kubernetes.ClusterName,
			"--resource-group", co.config.Cloud.Azure.ResourceGroup,
			"--query", "fqdn",
			"--output", "tsv")
		output, err := cmd.Output()
		if err != nil {
			return "", fmt.Errorf("failed to get cluster endpoint: %w", err)
		}
		return strings.TrimSpace(string(output)), nil

	case "gcp":
		cmd := exec.CommandContext(ctx, "gcloud", "container", "clusters", "describe",
			co.config.Kubernetes.ClusterName,
			"--zone", co.config.Cloud.GCP.Zone,
			"--project", co.config.Cloud.GCP.ProjectID,
			"--format", "value(endpoint)")
		output, err := cmd.Output()
		if err != nil {
			return "", fmt.Errorf("failed to get cluster endpoint: %w", err)
		}
		return strings.TrimSpace(string(output)), nil

	default:
		return "", fmt.Errorf("unsupported cloud provider: %s", co.config.Cloud.Provider)
	}
}

func (ko *KubernetesOperations) GetKubernetesVersion() (string, error) {
	version, err := ko.client.Discovery().ServerVersion()
	if err != nil {
		return "", err
	}
	return version.GitVersion, nil
}

func (ko *KubernetesOperations) ListNodes(ctx context.Context) ([]corev1.Node, error) {
	nodeList, err := ko.client.CoreV1().Nodes().List(ctx, metav1.ListOptions{})
	if err != nil {
		return nil, err
	}
	return nodeList.Items, nil
}

func (ko *KubernetesOperations) ListProjectNamespaces(projectName string) ([]string, error) {
	ctx := context.Background()
	namespaceList, err := ko.client.CoreV1().Namespaces().List(ctx, metav1.ListOptions{})
	if err != nil {
		return nil, err
	}

	var namespaces []string
	prefix := sanitizeProjectName(projectName)
	for _, ns := range namespaceList.Items {
		if strings.HasPrefix(ns.Name, prefix) {
			namespaces = append(namespaces, ns.Name)
		}
	}

	return namespaces, nil
}

func (ko *KubernetesOperations) ListPods(ctx context.Context, namespace string) (*corev1.PodList, error) {
	return ko.client.CoreV1().Pods(namespace).List(ctx, metav1.ListOptions{})
}

func (ko *KubernetesOperations) GetService(ctx context.Context, namespace, name string) (*corev1.Service, error) {
	return ko.client.CoreV1().Services(namespace).Get(ctx, name, metav1.GetOptions{})
}

func (ko *KubernetesOperations) GetDeployment(ctx context.Context, namespace, name string) (*appsv1.Deployment, error) {
	return ko.client.AppsV1().Deployments(namespace).Get(ctx, name, metav1.GetOptions{})
}

func (ko *KubernetesOperations) GetStatefulSet(ctx context.Context, namespace, name string) (*appsv1.StatefulSet, error) {
	return ko.client.AppsV1().StatefulSets(namespace).Get(ctx, name, metav1.GetOptions{})
}

func (ko *KubernetesOperations) GetLoadBalancerEndpoint(ctx context.Context) (string, error) {
	namespace := ko.config.GetNamespace("traefik")
	service, err := ko.GetService(ctx, namespace, "traefik")
	if err != nil {
		return "", err
	}

	if len(service.Status.LoadBalancer.Ingress) > 0 {
		ingress := service.Status.LoadBalancer.Ingress[0]
		if ingress.Hostname != "" {
			return ingress.Hostname, nil
		}
		if ingress.IP != "" {
			return ingress.IP, nil
		}
	}

	return "", fmt.Errorf("load balancer endpoint not ready")
}

func (ko *KubernetesOperations) ListCertificates(ctx context.Context) ([]interface{}, error) {
	// Certificate listing requires cert-manager CRD client
	return []interface{}{}, nil
}

// Namespace operations

func (ko *KubernetesOperations) DeleteNamespace(ctx context.Context, namespace string) error {
	return ko.client.CoreV1().Namespaces().Delete(ctx, namespace, metav1.DeleteOptions{})
}

func (ko *KubernetesOperations) GetStuckNamespaces(namespaces []string) ([]string, error) {
	ctx := context.Background()
	var stuck []string

	for _, ns := range namespaces {
		namespace, err := ko.client.CoreV1().Namespaces().Get(ctx, ns, metav1.GetOptions{})
		if err != nil {
			continue
		}

		if namespace.Status.Phase == corev1.NamespaceTerminating {
			stuck = append(stuck, ns)
		}
	}

	return stuck, nil
}

func (ko *KubernetesOperations) RemoveFinalizers(ctx context.Context, namespace, resourceType string) error {
	cmd := exec.CommandContext(ctx, "kubectl", "patch", resourceType,
		"-n", namespace,
		"--all",
		"-p", `{"metadata":{"finalizers":[]}}`,
		"--type=merge")
	return cmd.Run()
}

func (ko *KubernetesOperations) RemoveNamespaceFinalizers(ctx context.Context, namespace string) error {
	cmd := exec.CommandContext(ctx, "kubectl", "patch", "namespace", namespace,
		"-p", `{"spec":{"finalizers":[]}}`,
		"--type=merge")
	return cmd.Run()
}

// Cluster-wide cleanup

func (ko *KubernetesOperations) DeleteProjectCRDs(projectName string) error {
	ctx := context.Background()
	cmd := exec.CommandContext(ctx, "kubectl", "delete", "crd",
		"-l", fmt.Sprintf("app.kubernetes.io/instance=%s", projectName),
		"--ignore-not-found")
	return cmd.Run()
}

func (ko *KubernetesOperations) DeleteProjectPVs(projectName string) error {
	ctx := context.Background()
	cmd := exec.CommandContext(ctx, "kubectl", "delete", "pv",
		"-l", fmt.Sprintf("app.kubernetes.io/instance=%s", projectName),
		"--ignore-not-found")
	return cmd.Run()
}

func (ko *KubernetesOperations) DeleteProjectClusterRoles(projectName string) error {
	ctx := context.Background()

	// Delete cluster roles
	cmd := exec.CommandContext(ctx, "kubectl", "delete", "clusterrole",
		"-l", fmt.Sprintf("app.kubernetes.io/instance=%s", projectName),
		"--ignore-not-found")
	if err := cmd.Run(); err != nil {
		return err
	}

	// Delete cluster role bindings
	cmd = exec.CommandContext(ctx, "kubectl", "delete", "clusterrolebinding",
		"-l", fmt.Sprintf("app.kubernetes.io/instance=%s", projectName),
		"--ignore-not-found")
	return cmd.Run()
}

// Private helper methods

func (ko *KubernetesOperations) ensureNamespace(ctx context.Context, namespace string) error {
	_, err := ko.client.CoreV1().Namespaces().Get(ctx, namespace, metav1.GetOptions{})
	if err != nil {
		// Create namespace if it doesn't exist
		ns := &corev1.Namespace{
			ObjectMeta: metav1.ObjectMeta{
				Name: namespace,
				Labels: map[string]string{
					"app.kubernetes.io/instance": ko.config.Project.Name,
					"app.kubernetes.io/managed-by": "rulebricks",
				},
			},
		}
		_, err = ko.client.CoreV1().Namespaces().Create(ctx, ns, metav1.CreateOptions{})
		if err != nil {
			return fmt.Errorf("failed to create namespace %s: %w", namespace, err)
		}
	}
	return nil
}

func (ko *KubernetesOperations) installHelmChart(ctx context.Context, release, chart, namespace string, values map[string]interface{}) error {
	// Create values file if needed
	args := []string{"upgrade", "--install", release, chart,
		"--namespace", namespace,
		"--create-namespace",
		"--wait",
		"--timeout", "10m"}

	if values != nil {
		valuesYAML, err := yaml.Marshal(values)
		if err != nil {
			return fmt.Errorf("failed to marshal values: %w", err)
		}

		valuesFile, err := createTempFile("values-", ".yaml", valuesYAML)
		if err != nil {
			return err
		}
		defer os.Remove(valuesFile)

		args = append(args, "-f", valuesFile)
	}

	cmd := exec.CommandContext(ctx, "helm", args...)

	if ko.verbose {
		cmd.Stdout = os.Stdout
		cmd.Stderr = os.Stderr
		ko.progress.Debug("Running: %s", strings.Join(cmd.Args, " "))
		return cmd.Run()
	}

	// Display friendly name for vector (strip project suffix)
	displayName := release
	if strings.HasPrefix(release, "vector-") {
		displayName = "vector"
	}
	spinner := ko.progress.StartSpinner(fmt.Sprintf("Installing %s", displayName))
	err := cmd.Run()
	if err != nil {
		spinner.Fail()
		return err
	}
	spinner.Success()
	return nil
}

func (ko *KubernetesOperations) uninstallHelmChart(ctx context.Context, release, namespace string) error {
	cmd := exec.CommandContext(ctx, "helm", "uninstall", release, "--namespace", namespace)

	if ko.verbose {
		cmd.Stdout = os.Stdout
		cmd.Stderr = os.Stderr
		return cmd.Run()
	}

	return cmd.Run()
}

func (ko *KubernetesOperations) waitForDeploymentReady(ctx context.Context, namespace, name string, timeout time.Duration) error {
	deadline := time.Now().Add(timeout)

	for time.Now().Before(deadline) {
		deployment, err := ko.client.AppsV1().Deployments(namespace).Get(ctx, name, metav1.GetOptions{})
		if err == nil && deployment.Status.ReadyReplicas == *deployment.Spec.Replicas {
			return nil
		}

		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(5 * time.Second):
			// Continue checking
		}
	}

	return fmt.Errorf("deployment %s/%s not ready after %v", namespace, name, timeout)
}

func (ko *KubernetesOperations) createConfigMap(ctx context.Context, namespace, name string, data map[string]string) error {
	cm := &corev1.ConfigMap{
		ObjectMeta: metav1.ObjectMeta{
			Name:      name,
			Namespace: namespace,
		},
		Data: data,
	}

	// Try to get existing ConfigMap
	existing, err := ko.client.CoreV1().ConfigMaps(namespace).Get(ctx, name, metav1.GetOptions{})
	if err == nil {
		// ConfigMap exists, update it
		existing.Data = data
		_, err = ko.client.CoreV1().ConfigMaps(namespace).Update(ctx, existing, metav1.UpdateOptions{})
		return err
	}

	// ConfigMap doesn't exist, create it
	_, err = ko.client.CoreV1().ConfigMaps(namespace).Create(ctx, cm, metav1.CreateOptions{})
	return err
}

func (ko *KubernetesOperations) createTLSSecret(ctx context.Context, namespace, name string, cert, key []byte) error {
	secret := &corev1.Secret{
		ObjectMeta: metav1.ObjectMeta{
			Name:      name,
			Namespace: namespace,
		},
		Type: corev1.SecretTypeTLS,
		Data: map[string][]byte{
			"tls.crt": cert,
			"tls.key": key,
		},
	}

	_, err := ko.client.CoreV1().Secrets(namespace).Create(ctx, secret, metav1.CreateOptions{})
	return err
}

func (ko *KubernetesOperations) applyYAML(ctx context.Context, yaml string) error {
	cmd := exec.CommandContext(ctx, "kubectl", "apply", "-f", "-")
	cmd.Stdin = strings.NewReader(yaml)
	return cmd.Run()
}

func (ko *KubernetesOperations) generateVectorConfigMap(config *VectorConfig, kafkaBrokers string) map[string]interface{} {
	// Create Vector configuration with Kafka source
	vectorConfig := map[string]interface{}{
		"sources": map[string]interface{}{
			"kafka": map[string]interface{}{
				"type":               "kafka",
				"bootstrap_servers":  kafkaBrokers,
				"topics":            []string{"logs"},
				"group_id":          "vector-consumers",
				"auto_offset_reset": "latest",
			},
		},
		"sinks": map[string]interface{}{},
	}

	// Configure sink if provided
	if config != nil && config.Sink != nil {
		sinkConfig := map[string]interface{}{
			"type":   config.Sink.Type,
			"inputs": []string{"kafka"}, // Consume from Kafka source
		}

		// Load API key if configured
		apiKey := ""
		if config.Sink.APIKey != "" {
			// Note: In production, this should resolve the secret value
			apiKey = config.Sink.APIKey
		}

		// Configure sink based on type
		switch config.Sink.Type {
		case "elasticsearch":
			sinkConfig["endpoint"] = config.Sink.Endpoint
			if apiKey != "" {
				authConfig := map[string]interface{}{
					"strategy": "basic",
					"password": apiKey,
				}
				if username, ok := config.Sink.Config["auth_user"]; ok {
					authConfig["user"] = username
				} else {
					authConfig["user"] = "elastic"
				}
				sinkConfig["auth"] = authConfig
			}

		case "datadog_logs":
			sinkConfig["default_api_key"] = apiKey
			if site, ok := config.Sink.Config["site"]; ok {
				sinkConfig["site"] = site
			}

		case "loki":
			sinkConfig["endpoint"] = config.Sink.Endpoint
			sinkConfig["encoding"] = map[string]interface{}{
				"codec": "json",
			}

		case "aws_s3":
			if bucket, ok := config.Sink.Config["bucket"]; ok {
				sinkConfig["bucket"] = bucket
			}
			if region, ok := config.Sink.Config["region"]; ok {
				sinkConfig["region"] = region
			}
			sinkConfig["compression"] = "gzip"
			sinkConfig["encoding"] = map[string]interface{}{
				"codec": "json",
			}
			// When using IAM roles, no explicit credentials needed
			// The AWS SDK will automatically use the pod's IAM role

		case "http":
			sinkConfig["uri"] = config.Sink.Endpoint
			sinkConfig["encoding"] = map[string]interface{}{
				"codec": "json",
			}
			if authHeader, ok := config.Sink.Config["auth_header"]; ok {
				if authHeaderStr, ok := authHeader.(string); ok {
					sinkConfig["headers"] = map[string]string{
						"Authorization": authHeaderStr,
					}
				}
			}

		case "azure_blob":
			if containerName, ok := config.Sink.Config["container_name"]; ok {
				sinkConfig["container_name"] = containerName
			}
			// Check if using Managed Identity
			useManagedIdentity, _ := config.Sink.Config["use_managed_identity"].(bool)
			if !useManagedIdentity && apiKey != "" {
				sinkConfig["connection_string"] = apiKey
			} else if storageAccount, ok := config.Sink.Config["storage_account"]; ok {
				// When using Managed Identity, specify storage account
				sinkConfig["storage_account"] = storageAccount
			}
			sinkConfig["compression"] = "gzip"
			sinkConfig["encoding"] = map[string]interface{}{
				"codec": "json",
			}

		case "gcp_cloud_storage":
			if bucket, ok := config.Sink.Config["bucket"]; ok {
				sinkConfig["bucket"] = bucket
			}
			// Check if using Workload Identity
			useWorkloadIdentity, _ := config.Sink.Config["use_workload_identity"].(bool)
			if !useWorkloadIdentity {
				if credentialsPath, ok := config.Sink.Config["credentials_path"]; ok {
					sinkConfig["credentials_path"] = credentialsPath
				}
			}
			// When using Workload Identity, GCP SDK will automatically use the pod's service account
			sinkConfig["compression"] = "gzip"
			sinkConfig["encoding"] = map[string]interface{}{
				"codec": "json",
			}

		case "splunk_hec":
			sinkConfig["endpoint"] = config.Sink.Endpoint
			sinkConfig["default_token"] = apiKey
			if index, ok := config.Sink.Config["index"]; ok {
				sinkConfig["index"] = index
			}
			sinkConfig["encoding"] = map[string]interface{}{
				"codec": "json",
			}

		case "new_relic_logs":
			sinkConfig["license_key"] = apiKey
			sinkConfig["encoding"] = map[string]interface{}{
				"codec": "json",
			}
			if region, ok := config.Sink.Config["region"]; ok {
				if region == "EU" {
					sinkConfig["region"] = "eu"
				}
			}

		case "console":
			sinkConfig["encoding"] = map[string]interface{}{
				"codec": "json",
			}

		default:
			// Generic configuration for other sinks
			if config.Sink.Endpoint != "" {
				sinkConfig["endpoint"] = config.Sink.Endpoint
			}
			if apiKey != "" {
				sinkConfig["api_key"] = apiKey
			}
		}

		vectorConfig["sinks"].(map[string]interface{})["output"] = sinkConfig
	}

	return vectorConfig
}

// SupabaseOperations handles Supabase deployment operations
type SupabaseOperations struct {
	config        *Config
	options       SupabaseOptions
	progress      *ProgressIndicator
	projectRef    string
	anonKey       string
	serviceKey    string
	jwtSecret     string
	dbPassword    string
	dashboardPass string
}

// SupabaseOptions contains options for Supabase operations
type SupabaseOptions struct {
	Verbose      bool
	WorkDir      string
	ChartVersion string
	ChartManager *ChartManager
	AssetManager *AssetManager
	Secrets      *SharedSecrets
}

// NewSupabaseOperations creates a new Supabase operations instance
func NewSupabaseOperations(config *Config, options SupabaseOptions, progress *ProgressIndicator) *SupabaseOperations {
	return &SupabaseOperations{
		config:   config,
		options:  options,
		progress: progress,
	}
}

// Deploy deploys Supabase based on the configuration type
func (so *SupabaseOperations) Deploy(ctx context.Context) error {
	switch so.config.Database.Type {
	case "managed":
		return so.deployManaged(ctx)
	case "self-hosted":
		// Always redeploy self-hosted Supabase to avoid password mismatches
		return so.deploySelfHosted(ctx)
	case "external":
		return so.deploySelfHostedWithExternalDB(ctx)
	default:
		return fmt.Errorf("unsupported database type: %s", so.config.Database.Type)
	}
}

func (so *SupabaseOperations) deployManaged(ctx context.Context) error {
	fmt.Println("☁️  Configuring Managed Supabase...")

	// Check if Supabase CLI is installed
	if err := so.checkSupabaseCLI(); err != nil {
		return err
	}

	// Ensure authenticated
	if err := so.ensureAuthenticated(); err != nil {
		return err
	}

	// Get organization ID
	orgID, err := so.getOrganizationID()
	if err != nil {
		return err
	}

	// Check if project already exists
	projectExists, err := so.checkProjectExists()
	if err != nil {
		return err
	}

	if projectExists {
		fmt.Printf("📌 Using existing Supabase project: %s\n", so.config.Database.Supabase.ProjectName)
		so.projectRef, err = so.getProjectRef()
		if err != nil {
			return err
		}
	} else {
		// Create new project
		if err := so.createProject(orgID); err != nil {
			return err
		}
	}

	// Link the project
	if err := so.linkProject(); err != nil {
		return err
	}

	// Configure project
	if err := so.configureProject(); err != nil {
		return err
	}

	// Push database schema
	if err := so.PushDatabaseSchema(false); err != nil {
		return err
	}

	// Get API keys
	if err := so.getAPIKeys(); err != nil {
		return err
	}

	return nil
}

func (so *SupabaseOperations) deploySelfHosted(ctx context.Context) error {
	namespace := so.config.GetNamespace("supabase")

	// Check if we already have secrets from a previous deployment
	if so.options.Secrets != nil &&
		so.options.Secrets.JWTSecret != "" &&
		so.options.Secrets.DBPassword != "" &&
		so.options.Secrets.DashboardPassword != "" {
		// Reuse existing secrets
		if so.options.Verbose {
			fmt.Println("⚙ Reusing existing Supabase secrets from previous deployment")
		}
		so.jwtSecret = so.options.Secrets.JWTSecret
		so.dbPassword = so.options.Secrets.DBPassword
		so.dashboardPass = so.options.Secrets.DashboardPassword
		so.anonKey = so.options.Secrets.SupabaseAnonKey
		so.serviceKey = so.options.Secrets.SupabaseServiceKey

		// Regenerate JWT tokens if they're missing (backward compatibility)
		if so.anonKey == "" {
			so.anonKey = generateJWT("anon", so.jwtSecret)
			so.options.Secrets.SupabaseAnonKey = so.anonKey
		}
		if so.serviceKey == "" {
			so.serviceKey = generateJWT("service_role", so.jwtSecret)
			so.options.Secrets.SupabaseServiceKey = so.serviceKey
		}
	} else {
		// Generate new secrets
		if so.options.Verbose {
			fmt.Println("⚙ Generating new Supabase secrets")
		}
		so.jwtSecret = generateRandomString(32)
		so.dbPassword = generateDatabasePassword()
		so.dashboardPass = generateDatabasePassword()
		so.anonKey = generateJWT("anon", so.jwtSecret)
		so.serviceKey = generateJWT("service_role", so.jwtSecret)

		// Store in shared secrets
		if so.options.Secrets != nil {
			so.options.Secrets.DBPassword = so.dbPassword
			so.options.Secrets.SupabaseAnonKey = so.anonKey
			so.options.Secrets.SupabaseServiceKey = so.serviceKey
			so.options.Secrets.JWTSecret = so.jwtSecret
			so.options.Secrets.DashboardPassword = so.dashboardPass
		}
	}

	// Deploy Supabase using Helm
	// Generate analytics key
	analyticsKey := generateRandomString(32)

	// Create SMTP password if needed (all email providers use SMTP)
	smtpPassword := ""
	if so.options.Secrets != nil && so.config.Email.Provider != "" {
		smtpPassword = so.options.Secrets.SMTPPassword
	}

	// Create comprehensive values configuration
	values := map[string]interface{}{
		"secret": map[string]interface{}{
			"jwt": map[string]interface{}{
				"anonKey":    so.anonKey,
				"serviceKey": so.serviceKey,
				"secret":     so.jwtSecret,
			},
			"smtp": map[string]interface{}{
				"username": so.config.Email.SMTP.Username,
				"password": smtpPassword,
			},
			"db": map[string]interface{}{
				"username": "postgres",
				"password": so.dbPassword,
				"database": "postgres",
			},
			"analytics": map[string]interface{}{
				"apiKey": analyticsKey,
			},
			"dashboard": map[string]interface{}{
				"username": "supabase",
				"password": so.dashboardPass,
			},
		},
		"global": map[string]interface{}{
			"jwt": map[string]interface{}{
				"secret":     so.jwtSecret,
				"anonKey":    so.anonKey,
				"serviceKey": so.serviceKey,
			},
			"smtp": so.createSMTPConfig(),
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
				"password": so.dbPassword,
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
				"password": so.dashboardPass,
			},
			"environment": map[string]interface{}{
				"SUPABASE_PUBLIC_URL":             fmt.Sprintf("https://supabase.%s", so.config.Project.Domain),
				"NEXT_PUBLIC_ENABLE_LOGS":         "true",
				"NEXT_ANALYTICS_BACKEND_PROVIDER": "postgres",
				"STUDIO_PG_META_URL":              "http://supabase-supabase-meta:8080",
				"POSTGRES_PASSWORD":               so.dbPassword,
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
			"environment": so.createAuthEnvironment(),
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
						"host": fmt.Sprintf("supabase.%s", so.config.Project.Domain),
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
						"hosts": []string{
							fmt.Sprintf("supabase.%s", so.config.Project.Domain),
						},
					},
				},
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

	// Create temporary values file
	valuesYAML, err := yaml.Marshal(values)
	if err != nil {
		return fmt.Errorf("failed to marshal values: %w", err)
	}

	valuesFile, err := createTempFile("supabase-values-", ".yaml", valuesYAML)
	if err != nil {
		return fmt.Errorf("failed to create values file: %w", err)
	}
	defer os.Remove(valuesFile)

	// Download and extract Supabase chart using ChartManager
	if so.options.ChartManager == nil {
		return fmt.Errorf("ChartManager is required for Supabase deployment")
	}

	// Use the chart version or default to latest
	chartVersion := so.options.ChartVersion
	if chartVersion == "" {
		chartVersion = "latest"
	}

	// Pull the Supabase chart using ChartManager
	chartInfo, err := so.options.ChartManager.PullSupabaseChart(chartVersion)
	if err != nil {
		return fmt.Errorf("failed to get Supabase chart: %w", err)
	}

	// Extract the chart
	extractedPath, err := so.options.ChartManager.ExtractChart(chartInfo.CachedPath)
	if err != nil {
		return fmt.Errorf("failed to extract Supabase chart: %w", err)
	}
	defer os.RemoveAll(extractedPath)

	// The chart should be extracted as "supabase" directory
	supabaseChartPath := filepath.Join(extractedPath, "supabase")

	// Create namespace
	cmd := exec.Command("kubectl", "create", "namespace", namespace)
	cmd.Run() // Ignore error if namespace exists

	// Deploy with Helm
	cmd = exec.CommandContext(ctx, "helm", "upgrade", "--install", "supabase",
		supabaseChartPath,
		"--namespace", namespace,
		"--reset-values",
		"--values", valuesFile,
		"--wait",
		"--timeout", "15m")

	if so.options.Verbose {
		cmd.Stdout = os.Stdout
		cmd.Stderr = os.Stderr
	}

	if err := cmd.Run(); err != nil {
		return fmt.Errorf("helm deployment failed: %w", err)
	}

	// Ensure realtime tenant exists
	if err := so.ensureRealtimeTenant(ctx); err != nil {
		so.progress.Warning("Failed to ensure realtime tenant: %v", err)
	}

	return nil
}
// GetDBPassword returns the database password
func (so *SupabaseOperations) GetDBPassword() string {
	return so.dbPassword
}

// GetAnonKey returns the anonymous key
func (so *SupabaseOperations) GetAnonKey() string {
	return so.anonKey
}

// GetServiceKey returns the service role key
func (so *SupabaseOperations) GetServiceKey() string {
	return so.serviceKey
}

// GetJWTSecret returns the JWT secret
func (so *SupabaseOperations) GetJWTSecret() string {
	return so.jwtSecret
}

// GetDatabaseState returns the current database state
func (so *SupabaseOperations) GetDatabaseState() DatabaseState {
	state := DatabaseState{
		Type:              so.config.Database.Type,
		Provider:          so.config.Database.Provider,
		URL:               GetDatabaseURL(so.config, so.dbPassword),
		AnonKey:           so.anonKey,
		ServiceKey:        so.serviceKey,
		DashboardPassword: so.dashboardPass,
		DashboardUsername: "supabase",
		DashboardURL:      fmt.Sprintf("https://supabase.%s", so.config.Project.Domain),
		JWTSecret:         so.jwtSecret,
		DBPassword:        so.dbPassword,
		Internal:          so.config.Database.Type == "self-hosted",
	}

	// Set database connection details based on type
	switch so.config.Database.Type {
	case "external":
		if so.config.Database.External != nil {
			state.PostgresHost = so.config.Database.External.Host
			state.PostgresPort = so.config.Database.External.Port
			state.PostgresDatabase = so.config.Database.External.Database
			state.PostgresUsername = so.config.Database.External.Username
		}
	case "managed":
		// For managed Supabase, use the project reference
		state.PostgresHost = fmt.Sprintf("%s.supabase.co", so.projectRef)
		state.PostgresPort = 5432
		state.PostgresDatabase = "postgres"
		state.PostgresUsername = "postgres"
	default:
		// For self-hosted
		state.PostgresHost = "supabase-db." + so.config.GetNamespace("supabase")
		state.PostgresPort = 5432
		state.PostgresDatabase = "postgres"
		state.PostgresUsername = "postgres"
	}

	return state
}

// RunMigrations runs database migrations
func (so *SupabaseOperations) RunMigrations(ctx context.Context) error {
	switch so.config.Database.Type {
	case "managed":
		// For managed, migrations are pushed via supabase db push
		// Ensure Supabase assets are available
		if err := so.EnsureSupabaseAssets(); err != nil {
			return fmt.Errorf("failed to ensure Supabase assets: %w", err)
		}

		// Change to supabase directory
		supabaseDir := filepath.Join(so.options.WorkDir, "supabase")
		currentDir, err := os.Getwd()
		if err != nil {
			return fmt.Errorf("failed to get current directory: %w", err)
		}

		if err := os.Chdir(supabaseDir); err != nil {
			return fmt.Errorf("failed to change to supabase directory: %w", err)
		}
		defer os.Chdir(currentDir)

		// Run db push with include-all flag
		cmd := exec.CommandContext(ctx, "supabase", "db", "push", "--include-all")
		cmd.Stdin = strings.NewReader("Y\n")
		if so.options.Verbose {
			cmd.Stdout = os.Stdout
			cmd.Stderr = os.Stderr
		}
		return cmd.Run()
	case "self-hosted":
		// For self-hosted, we need to run migrations manually on the database pod
		return so.runSelfHostedMigrations(ctx)
	case "external":
		// For external DB, we need to run migrations manually
		return so.RunMigrationsExternal(ctx)
	}
	return nil
}

// RunMigrationsExternal runs migrations on an external database
func (so *SupabaseOperations) RunMigrationsExternal(ctx context.Context) error {
	fmt.Println("Running migrations on external database...")

	// Ensure Supabase assets are available
	if err := so.EnsureSupabaseAssets(); err != nil {
		return fmt.Errorf("failed to ensure Supabase assets: %w", err)
	}

	// Get database password
	password, err := resolveSecretValue(so.config.Database.External.PasswordFrom)
	if err != nil {
		return fmt.Errorf("failed to resolve database password: %w", err)
	}

	// Build connection string
	connStr := fmt.Sprintf("postgresql://%s:%s@%s:%d/%s?sslmode=%s",
		so.config.Database.External.Username,
		password,
		so.config.Database.External.Host,
		so.config.Database.External.Port,
		so.config.Database.External.Database,
		so.config.Database.External.SSLMode)

	// Get migration files
	migrationsDir := filepath.Join(so.options.WorkDir, "supabase", "migrations")
	entries, err := os.ReadDir(migrationsDir)
	if err != nil {
		return fmt.Errorf("failed to read migrations directory: %w", err)
	}

	// Run each migration file
	for _, entry := range entries {
		if !entry.IsDir() && strings.HasSuffix(entry.Name(), ".sql") {
			migrationPath := filepath.Join(migrationsDir, entry.Name())
			fmt.Printf("  Running migration: %s\n", entry.Name())

			// Read migration file
			content, err := os.ReadFile(migrationPath)
			if err != nil {
				return fmt.Errorf("failed to read migration %s: %w", entry.Name(), err)
			}

			// Execute using psql
			cmd := exec.CommandContext(ctx, "psql", connStr, "-c", string(content))
			if err := cmd.Run(); err != nil {
				return fmt.Errorf("failed to execute migration %s: %w", entry.Name(), err)
			}
		}
	}

	return nil
}

// validateExternal validates external database configuration
// runSelfHostedMigrations runs migrations on the self-hosted Supabase database
func (so *SupabaseOperations) runSelfHostedMigrations(ctx context.Context) error {
	so.progress.Info("Running migrations on self-hosted database...")

	// Ensure Supabase assets are available
	if err := so.EnsureSupabaseAssets(); err != nil {
		return fmt.Errorf("failed to ensure Supabase assets: %w", err)
	}

	// Check if migrations directory exists
	migrationsDir := filepath.Join(so.options.WorkDir, "supabase", "migrations")
	if _, err := os.Stat(migrationsDir); os.IsNotExist(err) {
		so.progress.Info("No migrations directory found, skipping...")
		return nil
	}

	namespace := fmt.Sprintf("%s-supabase", so.config.Project.Name)

	// Get the database pod name
	getDbPodCmd := exec.CommandContext(ctx, "kubectl", "get", "pod",
		"-n", namespace,
		"-l", "app.kubernetes.io/name=supabase-db,app.kubernetes.io/instance=supabase",
		"-o", "jsonpath={.items[0].metadata.name}")
	dbPodBytes, err := getDbPodCmd.Output()
	if err != nil {
		return fmt.Errorf("failed to get database pod: %w", err)
	}
	dbPod := string(dbPodBytes)
	if dbPod == "" {
		return fmt.Errorf("database pod not found")
	}

	// Copy migrations to the database pod
	copyCmd := exec.CommandContext(ctx, "kubectl", "cp", "-n", namespace,
		migrationsDir, fmt.Sprintf("%s:/tmp/migrations", dbPod))
	if err := copyCmd.Run(); err != nil {
		return fmt.Errorf("failed to copy migrations: %w", err)
	}

	// Get database password
	dbPassword := so.dbPassword
	if dbPassword == "" && so.options.Secrets != nil {
		dbPassword = so.options.Secrets.DBPassword
	}

	// Create migrations tracking table if it doesn't exist
	createTableCmd := fmt.Sprintf(`
		PGPASSWORD=%s psql -U postgres -d postgres -c "
		CREATE TABLE IF NOT EXISTS schema_migrations (
			version VARCHAR(255) PRIMARY KEY,
			applied_at TIMESTAMP DEFAULT NOW()
		);"
	`, dbPassword)

	cmd := exec.CommandContext(ctx, "kubectl", "exec", "-n", namespace, dbPod, "--", "bash", "-c", createTableCmd)
	if err := cmd.Run(); err != nil {
		return fmt.Errorf("failed to create migrations table: %w", err)
	}

	// Get list of already applied migrations
	getAppliedCmd := fmt.Sprintf(`
		PGPASSWORD=%s psql -U postgres -d postgres -t -c "
		SELECT version FROM schema_migrations;"
	`, dbPassword)

	cmd = exec.CommandContext(ctx, "kubectl", "exec", "-n", namespace, dbPod, "--", "bash", "-c", getAppliedCmd)
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
	`, dbPassword, dbPassword, dbPassword)

	cmd = exec.CommandContext(ctx, "kubectl", "exec", "-n", namespace, dbPod, "--", "bash", "-c", migrationScript)
	if so.options.Verbose {
		cmd.Stdout = os.Stdout
		cmd.Stderr = os.Stderr
	}
	if err := cmd.Run(); err != nil {
		return fmt.Errorf("failed to run migrations: %w", err)
	}

	// Clean up copied migrations
	cleanupCmd := exec.CommandContext(ctx, "kubectl", "exec", "-n", namespace, dbPod, "--",
		"rm", "-rf", "/tmp/migrations")
	cleanupCmd.Run()

	so.progress.Success("Database migrations completed")
	return nil
}

func (so *SupabaseOperations) validateExternal(ctx context.Context) error {
	if so.config.Database.External == nil {
		return fmt.Errorf("external database configuration missing")
	}

	// Validate required fields
	if so.config.Database.External.Host == "" {
		return fmt.Errorf("external database host is required")
	}
	if so.config.Database.External.Port == 0 {
		return fmt.Errorf("external database port is required")
	}
	if so.config.Database.External.Database == "" {
		return fmt.Errorf("external database name is required")
	}
	if so.config.Database.External.Username == "" {
		return fmt.Errorf("external database username is required")
	}

	return nil
}

// checkSupabaseCLI checks if Supabase CLI is installed
func (so *SupabaseOperations) checkSupabaseCLI() error {
	_, err := exec.LookPath("supabase")
	if err != nil {
		return fmt.Errorf("supabase CLI not found. Please install it from https://supabase.com/docs/guides/cli")
	}
	return nil
}

// ensureAuthenticated ensures the user is authenticated with Supabase
func (so *SupabaseOperations) ensureAuthenticated() error {
	// Check if already authenticated
	cmd := exec.Command("supabase", "projects", "list")
	if err := cmd.Run(); err != nil {
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
func (so *SupabaseOperations) getOrganizationID() (string, error) {
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
func (so *SupabaseOperations) checkProjectExists() (bool, error) {
	cmd := exec.Command("supabase", "projects", "list")
	output, err := cmd.Output()
	if err != nil {
		return false, fmt.Errorf("failed to list projects: %w", err)
	}

	return strings.Contains(string(output), so.config.Database.Supabase.ProjectName), nil
}

// getProjectRef retrieves the project reference ID
func (so *SupabaseOperations) getProjectRef() (string, error) {
	cmd := exec.Command("supabase", "projects", "list")
	output, err := cmd.Output()
	if err != nil {
		return "", fmt.Errorf("failed to list projects: %w", err)
	}

	// Use the same parsing logic as the original setup.sh
	lines := strings.Split(string(output), "\n")
	var matchingLines []string

	// Find all lines containing the project name
	for _, line := range lines {
		if strings.Contains(line, so.config.Database.Supabase.ProjectName) {
			matchingLines = append(matchingLines, line)
		}
	}

	if len(matchingLines) == 0 {
		return "", fmt.Errorf("project not found: %s", so.config.Database.Supabase.ProjectName)
	}

	// Take the last matching line
	lastLine := matchingLines[len(matchingLines)-1]

	// Split by │ and take the 3rd field
	parts := strings.Split(lastLine, "│")
	if len(parts) < 4 {
		return "", fmt.Errorf("invalid project list format")
	}

	// Get the 3rd field and trim spaces
	ref := strings.TrimSpace(parts[2])

	if ref == "" {
		return "", fmt.Errorf("empty project reference")
	}

	return ref, nil
}

// createProject creates a new Supabase project
func (so *SupabaseOperations) createProject(orgID string) error {
	fmt.Printf("🚀 Creating new Supabase project: %s\n", so.config.Database.Supabase.ProjectName)

	// Generate database password
	so.dbPassword = generateDatabasePassword()

	// Build command
	args := []string{
		"projects", "create", so.config.Database.Supabase.ProjectName,
		"--db-pass", so.dbPassword,
		"--org-id", orgID,
	}

	if so.config.Database.Supabase.Region != "" {
		args = append(args, "--region", so.config.Database.Supabase.Region)
	}

	cmd := exec.Command("supabase", args...)
	output, err := cmd.Output()
	if err != nil {
		return fmt.Errorf("failed to create project: %w", err)
	}

	// Extract project ref from output
	so.projectRef = extractProjectRef(string(output))
	if so.projectRef == "" {
		// If we can't extract from output, get it via list
		so.projectRef, err = so.getProjectRef()
		if err != nil {
			return fmt.Errorf("failed to get project reference: %w", err)
		}
	}

	fmt.Printf("✅ Project created with reference: %s\n", so.projectRef)
	return nil
}

// linkProject links the local project to the remote Supabase project
func (so *SupabaseOperations) linkProject() error {
	// Change to supabase directory
	supabaseDir := filepath.Join(so.options.WorkDir, "supabase")

	cmd := exec.Command("supabase", "link", "--project-ref", so.projectRef)
	cmd.Dir = supabaseDir

	if err := cmd.Run(); err != nil {
		return fmt.Errorf("failed to link project: %w", err)
	}

	return nil
}

// createAuthEnvironment creates auth service environment variables
func (so *SupabaseOperations) createAuthEnvironment() map[string]interface{} {
	emailTemplates := GetDefaultEmailTemplates()

	env := map[string]interface{}{
		"GOTRUE_SITE_URL":                  fmt.Sprintf("https://%s", so.config.Project.Domain),
		"GOTRUE_URI_ALLOW_LIST":            fmt.Sprintf("https://%s,https://%s/*,https://%s/auth/changepass,https://%s/settings/password,https://%s/dashboard", so.config.Project.Domain, so.config.Project.Domain, so.config.Project.Domain, so.config.Project.Domain, so.config.Project.Domain),
		"API_EXTERNAL_URL":                 fmt.Sprintf("https://supabase.%s", so.config.Project.Domain),
		"GOTRUE_JWT_EXP":                   "3600",
		"GOTRUE_JWT_DEFAULT_GROUP_NAME":    "authenticated",
		"GOTRUE_JWT_ADMIN_ROLES":           "service_role",
		"GOTRUE_JWT_AUD":                   "authenticated",
		"GOTRUE_DISABLE_SIGNUP":            "false",
		"GOTRUE_EXTERNAL_EMAIL_ENABLED":    "true",
		"GOTRUE_MAILER_AUTOCONFIRM":        "false",
		"GOTRUE_MAILER_SECURE_EMAIL_CHANGE_ENABLED": "false",
		"GOTRUE_EXTERNAL_ANONYMOUS_USERS_ENABLED":   "false",
		"GOTRUE_EXTERNAL_MANUAL_LINKING_ENABLED":    "false",
		"GOTRUE_RATE_LIMIT_EMAIL_SENT":              "3600",
		"GOTRUE_RATE_LIMIT_SMS_SENT":                "3600",
		"GOTRUE_RATE_LIMIT_VERIFY":                  "3600",
		"GOTRUE_EXTERNAL_PHONE_ENABLED":             "true",
		"GOTRUE_SMS_AUTOCONFIRM":                    "true",
		"GOTRUE_SECURITY_REFRESH_TOKEN_ROTATION_ENABLED": "true",
		"GOTRUE_SECURITY_REFRESH_TOKEN_REUSE_INTERVAL":   "10",
		"GOTRUE_MAILER_SUBJECTS_INVITE":        "Join your team on Rulebricks",
		"GOTRUE_MAILER_SUBJECTS_CONFIRMATION":  "Confirm Your Email",
		"GOTRUE_MAILER_SUBJECTS_RECOVERY":      "Reset Your Password",
		"GOTRUE_MAILER_SUBJECTS_EMAIL_CHANGE":  "Confirm Email Change",
	}

	// Configure email settings based on provider
	if so.config.Email.Provider != "" {
		env["GOTRUE_EXTERNAL_EMAIL_ENABLED"] = "true"
		env["GOTRUE_MAILER_AUTOCONFIRM"] = "false"

		// All email providers use SMTP configuration in GOTRUE
		if so.config.Email.SMTP != nil {
			env["GOTRUE_SMTP_HOST"] = so.config.Email.SMTP.Host
			env["GOTRUE_SMTP_PORT"] = fmt.Sprintf("%d", so.config.Email.SMTP.Port)
			env["GOTRUE_SMTP_USER"] = so.config.Email.SMTP.Username
			env["GOTRUE_SMTP_PASS"] = so.options.Secrets.SMTPPassword
			env["GOTRUE_SMTP_ADMIN_EMAIL"] = so.config.Email.SMTP.AdminEmail
			env["GOTRUE_SMTP_SENDER_NAME"] = so.config.Email.FromName
		}
	} else {
		// Email disabled
		env["GOTRUE_EXTERNAL_EMAIL_ENABLED"] = "false"
		env["GOTRUE_MAILER_AUTOCONFIRM"] = "true"
	}

	// Add email template configuration when email is enabled
	if so.config.Email.Provider != "" {
		// Always set template URLs
		env["GOTRUE_MAILER_TEMPLATES_INVITE"] = emailTemplates.TemplateInvite
		env["GOTRUE_MAILER_TEMPLATES_CONFIRMATION"] = emailTemplates.TemplateConfirmation
		env["GOTRUE_MAILER_TEMPLATES_RECOVERY"] = emailTemplates.TemplateRecovery
		env["GOTRUE_MAILER_TEMPLATES_EMAIL_CHANGE"] = emailTemplates.TemplateEmailChange

		// Override with custom templates if provided
		if so.config.Email.Templates != nil {
			if so.config.Email.Templates.CustomInviteURL != "" {
				env["GOTRUE_MAILER_TEMPLATES_INVITE"] = so.config.Email.Templates.CustomInviteURL
			}
			if so.config.Email.Templates.CustomConfirmationURL != "" {
				env["GOTRUE_MAILER_TEMPLATES_CONFIRMATION"] = so.config.Email.Templates.CustomConfirmationURL
			}
			if so.config.Email.Templates.CustomRecoveryURL != "" {
				env["GOTRUE_MAILER_TEMPLATES_RECOVERY"] = so.config.Email.Templates.CustomRecoveryURL
			}
			if so.config.Email.Templates.CustomEmailChangeURL != "" {
				env["GOTRUE_MAILER_TEMPLATES_EMAIL_CHANGE"] = so.config.Email.Templates.CustomEmailChangeURL
			}
		}
	}

	return env
}

// createSMTPConfig creates SMTP configuration
func (so *SupabaseOperations) createSMTPConfig() map[string]interface{} {
	// If no email provider is configured or SMTP config is missing, disable email
	if so.config.Email.Provider == "" || so.config.Email.SMTP == nil {
		return map[string]interface{}{
			"enabled": false,
		}
	}

	// All email providers use SMTP configuration
	return map[string]interface{}{
		"enabled":  true,
		"host":     so.config.Email.SMTP.Host,
		"port":     so.config.Email.SMTP.Port,
		"username": so.config.Email.SMTP.Username,
		"password": so.options.Secrets.SMTPPassword,
		"from":     so.config.Email.From,
		"fromName": so.config.Email.FromName,
		"secure":   so.config.Email.SMTP.Encryption == "ssl",
		"auth":     true,
	}
}

// deploySelfHostedWithExternalDB deploys Supabase with external PostgreSQL
func (so *SupabaseOperations) deploySelfHostedWithExternalDB(ctx context.Context) error {
	so.progress.Info("Deploying Supabase with external PostgreSQL...")

	// Validate external database connection
	if err := so.validateExternal(ctx); err != nil {
		return err
	}

	// Generate secrets for Supabase services
	so.jwtSecret = generateRandomString(32)
	so.anonKey = generateJWT("anon", so.jwtSecret)
	so.serviceKey = generateJWT("service_role", so.jwtSecret)

	// Create Helm values with external DB config
	values := so.createExternalDBValues()

	// Create values file
	valuesData, err := yaml.Marshal(values)
	if err != nil {
		return fmt.Errorf("failed to marshal values: %w", err)
	}

	valuesFile := filepath.Join(so.options.WorkDir, "supabase-external-values.yaml")
	if err := os.WriteFile(valuesFile, valuesData, 0644); err != nil {
		return fmt.Errorf("failed to write values file: %w", err)
	}

	// Pull the Supabase chart
	chartVersion := so.options.ChartVersion
	if chartVersion == "" {
		chartVersion = "latest"
	}

	// Pull the Supabase chart using ChartManager
	chartInfo, err := so.options.ChartManager.PullSupabaseChart(chartVersion)
	if err != nil {
		return fmt.Errorf("failed to get Supabase chart: %w", err)
	}

	// Extract the chart
	extractedPath, err := so.options.ChartManager.ExtractChart(chartInfo.CachedPath)
	if err != nil {
		return fmt.Errorf("failed to extract Supabase chart: %w", err)
	}
	defer os.RemoveAll(extractedPath)

	// The chart should be extracted as "supabase" directory
	supabaseChartPath := filepath.Join(extractedPath, "supabase")

	// Deploy with Helm
	namespace := so.config.GetNamespace("supabase")

	// Create namespace
	cmd := exec.Command("kubectl", "create", "namespace", namespace)
	cmd.Run() // Ignore error if namespace exists

	cmd = exec.CommandContext(ctx, "helm", "upgrade", "--install", "supabase",
		supabaseChartPath,
		"--namespace", namespace,
		"--reset-values",
		"-f", valuesFile,
		"--wait",
		"--timeout", "15m")

	if so.options.Verbose {
		cmd.Stdout = os.Stdout
		cmd.Stderr = os.Stderr
	}

	if err := cmd.Run(); err != nil {
		return fmt.Errorf("failed to deploy Supabase with external DB: %w", err)
	}

	// Ensure realtime tenant exists
	if err := so.ensureRealtimeTenant(ctx); err != nil {
		so.progress.Warning("Failed to ensure realtime tenant: %v", err)
	}

	// Run migrations on external database
	if err := so.RunMigrationsExternal(ctx); err != nil {
		return err
	}

	so.progress.Success("Supabase with external database deployment complete!")
	return nil
}

// createExternalDBValues creates Helm values for external database
func (so *SupabaseOperations) createExternalDBValues() map[string]interface{} {
	// Start with the same base configuration as self-hosted
	analyticsKey := generateRandomString(32)

	// Create SMTP password if needed (all email providers use SMTP)
	smtpPassword := ""
	if so.options.Secrets != nil && so.config.Email.Provider != "" {
		smtpPassword = so.options.Secrets.SMTPPassword
	}

	// Create comprehensive values configuration
	values := map[string]interface{}{
		"secret": map[string]interface{}{
			"jwt": map[string]interface{}{
				"anonKey":    so.anonKey,
				"serviceKey": so.serviceKey,
				"secret":     so.jwtSecret,
			},
			"smtp": map[string]interface{}{
				"username": so.config.Email.SMTP.Username,
				"password": smtpPassword,
			},
			"db": map[string]interface{}{
				"username": "postgres",
				"password": so.dbPassword,
				"database": "postgres",
			},
			"analytics": map[string]interface{}{
				"apiKey": analyticsKey,
			},
			"dashboard": map[string]interface{}{
				"username": "supabase",
				"password": so.dashboardPass,
			},
		},
		"global": map[string]interface{}{
			"jwt": map[string]interface{}{
				"secret":     so.jwtSecret,
				"anonKey":    so.anonKey,
				"serviceKey": so.serviceKey,
			},
			"smtp": so.createSMTPConfig(),
		},
		"db": map[string]interface{}{
			"enabled": false, // Disable internal database for external
		},
		"studio": map[string]interface{}{
			"enabled": true,
			"image": map[string]interface{}{
				"repository": "supabase/studio",
				"tag":        "20231123-64a766a",
				"pullPolicy": "IfNotPresent",
			},
			"auth": map[string]interface{}{
				"password": so.dashboardPass,
			},
			"environment": map[string]interface{}{
				"SUPABASE_PUBLIC_URL":             fmt.Sprintf("https://supabase.%s", so.config.Project.Domain),
				"NEXT_PUBLIC_ENABLE_LOGS":         "true",
				"NEXT_ANALYTICS_BACKEND_PROVIDER": "postgres",
				"STUDIO_PG_META_URL":              "http://supabase-supabase-meta:8080",
				"POSTGRES_PASSWORD":               so.dbPassword,
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
			"environment": so.createAuthEnvironment(),
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
			"environment": map[string]interface{}{
				"KONG_DECLARATIVE_CONFIG": "/opt/kong/kong.yml",
				"KONG_DATABASE":           "off",
				"KONG_LOG_LEVEL":          "info",
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
						"host": fmt.Sprintf("supabase.%s", so.config.Project.Domain),
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
						"hosts": []string{
							fmt.Sprintf("supabase.%s", so.config.Project.Domain),
						},
					},
				},
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
	}

	// Now modify for external database

	// Get database password
	dbPassword, _ := resolveSecretValue(so.config.Database.External.PasswordFrom)

	// Configure services to use external database
	dbURL := fmt.Sprintf("postgresql://%s:%s@%s:%d/%s?sslmode=%s",
		so.config.Database.External.Username,
		dbPassword,
		so.config.Database.External.Host,
		so.config.Database.External.Port,
		so.config.Database.External.Database,
		so.config.Database.External.SSLMode)

	// Update auth service - merge with existing environment
	authEnv := values["auth"].(map[string]interface{})["environment"].(map[string]interface{})
	authEnv["DATABASE_URL"] = dbURL

	// Update rest service - merge with existing environment
	restEnv := values["rest"].(map[string]interface{})["environment"].(map[string]interface{})
	restEnv["PGRST_DB_URI"] = dbURL

	// Update realtime service
	values["realtime"].(map[string]interface{})["environment"] = map[string]interface{}{
		"DB_HOST":          so.config.Database.External.Host,
		"DB_PORT":          fmt.Sprintf("%d", so.config.Database.External.Port),
		"DB_USER":          so.config.Database.External.Username,
		"DB_PASSWORD":      dbPassword,
		"DB_NAME":          so.config.Database.External.Database,
		"DB_SSL":           so.config.Database.External.SSLMode != "disable",
		"MAX_HEADER_LENGTH": "8192",
	}

	// Update storage service - merge with existing environment
	storageEnv := values["storage"].(map[string]interface{})["environment"].(map[string]interface{})
	storageEnv["DATABASE_URL"] = dbURL

	// Update meta service - need to add environment if not exists
	if metaEnv, ok := values["meta"].(map[string]interface{})["environment"].(map[string]interface{}); ok {
		metaEnv["PG_META_DB_URL"] = dbURL
	} else {
		values["meta"].(map[string]interface{})["environment"] = map[string]interface{}{
			"PG_META_DB_URL": dbURL,
		}
	}

	// Update imgproxy if enabled - need to add environment if not exists
	if imgproxy, ok := values["imgproxy"].(map[string]interface{}); ok && imgproxy["enabled"].(bool) {
		if imgproxyEnv, ok := imgproxy["environment"].(map[string]interface{}); ok {
			imgproxyEnv["IMGPROXY_DATABASE_URL"] = dbURL
		} else {
			values["imgproxy"].(map[string]interface{})["environment"] = map[string]interface{}{
				"IMGPROXY_DATABASE_URL": dbURL,
			}
		}
	}

	return values
}

// ensureRealtimeTenant ensures the realtime tenant is configured in the database
func (so *SupabaseOperations) ensureRealtimeTenant(ctx context.Context) error {
	namespace := so.config.GetNamespace("supabase")

	// Wait a bit for the realtime seed to complete and create the realtime-dev tenant
	time.Sleep(5 * time.Second)

	// Get the JWT secret that we need to encrypt
	jwtSecret := so.jwtSecret
	if jwtSecret == "" && so.options.Secrets != nil {
		jwtSecret = so.options.Secrets.JWTSecret
	}
	if jwtSecret == "" {
		// If we still don't have it, try to get it from the secret
		cmd := exec.CommandContext(ctx, "kubectl", "get", "secret", "supabase-jwt",
			"-n", namespace, "-o", "jsonpath={.data.secret}")
		output, err := cmd.Output()
		if err == nil && len(output) > 0 {
			decoded, err := base64.StdEncoding.DecodeString(string(output))
			if err == nil {
				jwtSecret = string(decoded)
			}
		}
	}

	if jwtSecret == "" {
		return fmt.Errorf("unable to determine JWT secret for realtime tenant")
	}

	// Execute SQL to ensure realtime tenants exist with properly encrypted JWT secret
	// The realtime service expects JWT secrets to be encrypted using AES-ECB with DB_ENC_KEY
	// We use PostgreSQL's encode/encrypt functions to do this
	cmd := exec.CommandContext(ctx, "kubectl", "exec", "-n", namespace,
		"deployment/supabase-supabase-db", "--",
		"psql", "-U", "supabase_admin", "-d", "postgres", "-c",
		fmt.Sprintf(`-- Enable pgcrypto if not already enabled
		CREATE EXTENSION IF NOT EXISTS pgcrypto;

		-- Create supabase-supabase-realtime tenant with encrypted JWT secret
		INSERT INTO _realtime.tenants (id, name, external_id, jwt_secret, max_concurrent_users,
		       inserted_at, updated_at, max_events_per_second, postgres_cdc_default,
		       max_bytes_per_second, max_channels_per_client, max_joins_per_second, suspend)
		SELECT gen_random_uuid(), name, 'supabase-supabase-realtime',
		       encode(encrypt('%s'::bytea, 'supabaserealtime'::bytea, 'aes-ecb'), 'base64'),
		       max_concurrent_users, NOW(), NOW(), max_events_per_second, postgres_cdc_default,
		       max_bytes_per_second, max_channels_per_client, max_joins_per_second, suspend
		FROM _realtime.tenants WHERE external_id = 'realtime-dev'
		ON CONFLICT (external_id) DO UPDATE SET jwt_secret = encode(encrypt('%s'::bytea, 'supabaserealtime'::bytea, 'aes-ecb'), 'base64');

		-- Create supabase tenant (for JWT iss claim) with encrypted JWT secret
		INSERT INTO _realtime.tenants (id, name, external_id, jwt_secret, max_concurrent_users,
		       inserted_at, updated_at, max_events_per_second, postgres_cdc_default,
		       max_bytes_per_second, max_channels_per_client, max_joins_per_second, suspend)
		SELECT gen_random_uuid(), name, 'supabase',
		       encode(encrypt('%s'::bytea, 'supabaserealtime'::bytea, 'aes-ecb'), 'base64'),
		       max_concurrent_users, NOW(), NOW(), max_events_per_second, postgres_cdc_default,
		       max_bytes_per_second, max_channels_per_client, max_joins_per_second, suspend
		FROM _realtime.tenants WHERE external_id = 'realtime-dev'
		ON CONFLICT (external_id) DO UPDATE SET jwt_secret = encode(encrypt('%s'::bytea, 'supabaserealtime'::bytea, 'aes-ecb'), 'base64');

		-- Create extensions for both tenants
		INSERT INTO _realtime.extensions
		SELECT gen_random_uuid(), type, settings, 'supabase-supabase-realtime', NOW(), NOW()
		FROM _realtime.extensions WHERE tenant_external_id = 'realtime-dev'
		AND NOT EXISTS (SELECT 1 FROM _realtime.extensions WHERE tenant_external_id = 'supabase-supabase-realtime');

		INSERT INTO _realtime.extensions
		SELECT gen_random_uuid(), type, settings, 'supabase', NOW(), NOW()
		FROM _realtime.extensions WHERE tenant_external_id = 'realtime-dev'
		AND NOT EXISTS (SELECT 1 FROM _realtime.extensions WHERE tenant_external_id = 'supabase');`, jwtSecret, jwtSecret, jwtSecret, jwtSecret))

	if err := cmd.Run(); err != nil {
		// This is non-fatal - realtime may not be enabled or this might be an external database
		if so.options.Verbose && so.progress != nil {
			so.progress.Debug("Warning: Failed to configure realtime tenant: %v", err)
		}
	}

	return nil
}

// configureProject configures the Supabase project settings
func (so *SupabaseOperations) configureProject() error {
	fmt.Println("⚙️  Configuring project settings...")

	// Create config.toml from template
	configTemplate := filepath.Join(so.options.WorkDir, "supabase", "config.example.toml")
	configFile := filepath.Join(so.options.WorkDir, "supabase", "config.toml")

	// Read template
	templateData, err := os.ReadFile(configTemplate)
	if err != nil {
		return fmt.Errorf("failed to read config template: %w", err)
	}

	// Replace variables
	config := strings.ReplaceAll(string(templateData), "env(FULL_URL)", fmt.Sprintf("https://%s", so.config.Project.Domain))

	// Write config
	if err := os.WriteFile(configFile, []byte(config), 0644); err != nil {
		return fmt.Errorf("failed to write config: %w", err)
	}

	// Push configuration
	fmt.Println("📤 Pushing configuration to Supabase...")

	// Push auth configuration
	cmd := exec.Command("supabase", "config", "push", "--project-ref", so.projectRef)
	cmd.Dir = filepath.Join(so.options.WorkDir, "supabase")
	cmd.Stdin = strings.NewReader("Y\n") // Auto-confirm

	if so.options.Verbose {
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
		"--project-ref", so.projectRef,
		"--experimental")

	if err := sslCmd.Run(); err != nil {
		// Non-fatal, just warn
		fmt.Printf("⚠️  Failed to enable SSL enforcement: %v\n", err)
	}

	return nil
}

// PushDatabaseSchema pushes the database schema to Supabase
func (so *SupabaseOperations) PushDatabaseSchema(dryRun bool) error {
	fmt.Println("📤 Pushing database schema...")

	supabaseDir := filepath.Join(so.options.WorkDir, "supabase")

	args := []string{"db", "push"}
	if dryRun {
		args = append(args, "--dry-run")
	}
	args = append(args, "--project-ref", so.projectRef)

	cmd := exec.Command("supabase", args...)
	cmd.Dir = supabaseDir

	return cmd.Run()
}

// getAPIKeys retrieves API keys from the Supabase project
func (so *SupabaseOperations) getAPIKeys() error {
	fmt.Println("🔑 Retrieving API keys...")

	cmd := exec.Command("supabase", "projects", "api-keys", "--project-ref", so.projectRef)
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
				so.anonKey = fields[len(fields)-1]
			}
		} else if strings.Contains(line, "service_role") {
			fields := strings.Fields(line)
			if len(fields) > 0 {
				so.serviceKey = fields[len(fields)-1]
			}
		}
	}

	// Sanitize keys
	so.anonKey = sanitizeJWT(so.anonKey)
	so.serviceKey = sanitizeJWT(so.serviceKey)

	if so.anonKey == "" || so.serviceKey == "" {
		return fmt.Errorf("failed to extract API keys")
	}

	return nil
}

// EnsureSupabaseAssets ensures Supabase assets are available
func (so *SupabaseOperations) EnsureSupabaseAssets() error {
	supabaseDir := filepath.Join(so.options.WorkDir, "supabase")

	// Use asset manager if available
	if so.options.AssetManager != nil {
		// Construct the image name
		imageName := fmt.Sprintf("%s:%s", DefaultAppImage, so.options.ChartVersion)
		if so.config.Advanced.DockerRegistry != nil && so.config.Advanced.DockerRegistry.AppImage != "" {
			// Use custom registry if configured
			baseImage := so.config.Advanced.DockerRegistry.AppImage
			// Remove any existing tag
			if idx := strings.LastIndex(baseImage, ":"); idx > 0 {
				baseImage = baseImage[:idx]
			}
			imageName = fmt.Sprintf("%s:%s", baseImage, so.options.ChartVersion)
		}
		return so.options.AssetManager.EnsureSupabaseAssets(imageName, supabaseDir)
	}

	// Otherwise just check if directory exists
	if _, err := os.Stat(supabaseDir); os.IsNotExist(err) {
		return fmt.Errorf("supabase directory not found: %s", supabaseDir)
	}

	return nil
}

// Helper functions

// extractProjectRef extracts project reference from supabase output
func extractProjectRef(output string) string {
	// Extract project ref from output like "Project created: abcdefghijklmnop"
	re := regexp.MustCompile(`Project created: ([a-z0-9]+)`)
	matches := re.FindStringSubmatch(output)
	if len(matches) > 1 {
		return matches[1]
	}
	return ""
}

// extractKey extracts API key from supabase output
func extractKey(output, keyType string) string {
	lines := strings.Split(output, "\n")
	for _, line := range lines {
		if strings.Contains(line, keyType) {
			fields := strings.Fields(line)
			if len(fields) > 0 {
				return fields[len(fields)-1]
			}
		}
	}
	return ""
}
