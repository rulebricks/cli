// cloud_operations.go - Cloud provider operations
package main

import (
	"bufio"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"time"
)

// CloudOperations handles cloud provider-specific operations
type CloudOperations struct {
	config       Config
	terraformDir string
	verbose      bool
	assetManager *AssetManager
}

// NewCloudOperations creates a new cloud operations handler
func NewCloudOperations(config Config, verbose bool) *CloudOperations {
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

	return &CloudOperations{
		config:       config,
		verbose:      verbose,
		assetManager: assetManager,
	}
}

// SetupCluster creates the Kubernetes cluster on the specified cloud provider
func (c *CloudOperations) SetupCluster() error {
	fmt.Printf("🚀 Setting up Kubernetes cluster on %s...\n", c.config.Cloud.Provider)

	switch c.config.Cloud.Provider {
	case "aws":
		return c.setupAWSCluster()
	case "azure":
		return c.setupAzureCluster()
	case "gcp":
		return c.setupGCPCluster()
	default:
		return fmt.Errorf("unsupported cloud provider: %s", c.config.Cloud.Provider)
	}
}

// setupAWSCluster creates an EKS cluster on AWS
func (c *CloudOperations) setupAWSCluster() error {
	c.terraformDir = filepath.Join("terraform", "aws")

	// Ensure terraform directory exists
	if _, err := os.Stat("terraform"); os.IsNotExist(err) {
		// Try to download terraform templates if asset manager is available
		if c.assetManager != nil {
			if err := c.assetManager.EnsureTerraformAssets("terraform"); err != nil {
				return fmt.Errorf("failed to download terraform templates: %w", err)
			}
		} else {
			return fmt.Errorf("terraform configuration not found at %s and unable to download (no license key)", c.terraformDir)
		}
	}

	// Check if the specific provider directory exists
	if _, err := os.Stat(c.terraformDir); os.IsNotExist(err) {
		return fmt.Errorf("terraform configuration not found for AWS provider at %s", c.terraformDir)
	}

	// Initialize Terraform
	fmt.Println("🔧 Initializing Terraform for AWS...")
	if err := c.runTerraformCommand("init", "-upgrade"); err != nil {
		return fmt.Errorf("terraform init failed: %w", err)
	}

	// Create terraform variables
	if err := c.createAWSTerraformVars(); err != nil {
		return fmt.Errorf("failed to create terraform variables: %w", err)
	}

	// Apply Terraform configuration
	fmt.Println("🏗️  Creating AWS infrastructure...")
	if err := c.runTerraformCommand("apply", "-auto-approve"); err != nil {
		return fmt.Errorf("terraform apply failed: %w", err)
	}

	// Get outputs
	outputs, err := c.getTerraformOutputs()
	if err != nil {
		return fmt.Errorf("failed to get terraform outputs: %w", err)
	}

	// Update kubeconfig
	fmt.Println("🔑 Updating kubeconfig for EKS...")
	if err := c.updateAWSKubeconfig(outputs); err != nil {
		return fmt.Errorf("failed to update kubeconfig: %w", err)
	}

	fmt.Println("✅ AWS EKS cluster created successfully!")
	return nil
}

// setupAzureCluster creates an AKS cluster on Azure
func (c *CloudOperations) setupAzureCluster() error {
	c.terraformDir = filepath.Join("terraform", "azure")

	// Ensure terraform directory exists
	if _, err := os.Stat("terraform"); os.IsNotExist(err) {
		// Try to download terraform templates if asset manager is available
		if c.assetManager != nil {
			if err := c.assetManager.EnsureTerraformAssets("terraform"); err != nil {
				return fmt.Errorf("failed to download terraform templates: %w", err)
			}
		} else {
			return fmt.Errorf("terraform configuration not found at %s and unable to download (no license key)", c.terraformDir)
		}
	}

	// Check if the specific provider directory exists
	if _, err := os.Stat(c.terraformDir); os.IsNotExist(err) {
		return fmt.Errorf("terraform configuration not found for Azure provider at %s", c.terraformDir)
	}

	// Initialize Terraform
	fmt.Println("🔧 Initializing Terraform for Azure...")
	if err := c.runTerraformCommand("init", "-upgrade"); err != nil {
		return fmt.Errorf("terraform init failed: %w", err)
	}

	// Create terraform variables
	if err := c.createAzureTerraformVars(); err != nil {
		return fmt.Errorf("failed to create terraform variables: %w", err)
	}

	// Apply Terraform configuration
	fmt.Println("🏗️  Creating Azure infrastructure...")
	if err := c.runTerraformCommand("apply", "-auto-approve"); err != nil {
		return fmt.Errorf("terraform apply failed: %w", err)
	}

	// Get outputs
	outputs, err := c.getTerraformOutputs()
	if err != nil {
		return fmt.Errorf("failed to get terraform outputs: %w", err)
	}

	// Update kubeconfig
	fmt.Println("🔑 Getting credentials for AKS...")
	if err := c.updateAzureKubeconfig(outputs); err != nil {
		return fmt.Errorf("failed to update kubeconfig: %w", err)
	}

	fmt.Println("✅ Azure AKS cluster created successfully!")
	return nil
}

// setupGCPCluster creates a GKE cluster on GCP
func (c *CloudOperations) setupGCPCluster() error {
	c.terraformDir = filepath.Join("terraform", "gcp")

	// Ensure terraform directory exists
	if _, err := os.Stat("terraform"); os.IsNotExist(err) {
		// Try to download terraform templates if asset manager is available
		if c.assetManager != nil {
			if err := c.assetManager.EnsureTerraformAssets("terraform"); err != nil {
				return fmt.Errorf("failed to download terraform templates: %w", err)
			}
		} else {
			return fmt.Errorf("terraform configuration not found at %s and unable to download (no license key)", c.terraformDir)
		}
	}

	// Check if the specific provider directory exists
	if _, err := os.Stat(c.terraformDir); os.IsNotExist(err) {
		return fmt.Errorf("terraform configuration not found for GCP provider at %s", c.terraformDir)
	}

	// Initialize Terraform
	fmt.Println("🔧 Initializing Terraform for GCP...")
	if err := c.runTerraformCommand("init", "-upgrade"); err != nil {
		return fmt.Errorf("terraform init failed: %w", err)
	}

	// Create terraform variables
	if err := c.createGCPTerraformVars(); err != nil {
		return fmt.Errorf("failed to create terraform variables: %w", err)
	}

	// Apply Terraform configuration
	fmt.Println("🏗️  Creating GCP infrastructure...")
	if err := c.runTerraformCommand("apply", "-auto-approve"); err != nil {
		return fmt.Errorf("terraform apply failed: %w", err)
	}

	// Get outputs
	outputs, err := c.getTerraformOutputs()
	if err != nil {
		return fmt.Errorf("failed to get terraform outputs: %w", err)
	}

	// Update kubeconfig
	fmt.Println("🔑 Getting credentials for GKE...")
	if err := c.updateGCPKubeconfig(outputs); err != nil {
		return fmt.Errorf("failed to update kubeconfig: %w", err)
	}

	fmt.Println("✅ GCP GKE cluster created successfully!")
	return nil
}

// runTerraformCommand executes a terraform command
func (c *CloudOperations) runTerraformCommand(args ...string) error {
	cmd := exec.Command("terraform", args...)
	cmd.Dir = c.terraformDir

	if c.verbose {
		cmd.Stdout = os.Stdout
		cmd.Stderr = os.Stderr
		return cmd.Run()
	}

	// Capture output for non-verbose mode
	output, err := cmd.CombinedOutput()
	if err != nil {
		return fmt.Errorf("terraform %s failed: %s\n%s", args[0], err, string(output))
	}

	return nil
}

// getTerraformOutputs retrieves terraform outputs
func (c *CloudOperations) getTerraformOutputs() (map[string]string, error) {
	cmd := exec.Command("terraform", "output", "-json")
	cmd.Dir = c.terraformDir

	output, err := cmd.Output()
	if err != nil {
		return nil, fmt.Errorf("failed to get terraform outputs: %w", err)
	}

	var rawOutputs map[string]struct {
		Value interface{} `json:"value"`
	}

	if err := json.Unmarshal(output, &rawOutputs); err != nil {
		return nil, fmt.Errorf("failed to parse terraform outputs: %w", err)
	}

	outputs := make(map[string]string)
	for k, v := range rawOutputs {
		switch val := v.Value.(type) {
		case string:
			outputs[k] = val
		default:
			outputs[k] = fmt.Sprintf("%v", val)
		}
	}

	return outputs, nil
}

// createAWSTerraformVars creates terraform.tfvars for AWS
func (c *CloudOperations) createAWSTerraformVars() error {
	vars := map[string]interface{}{
		"region":              c.config.Cloud.Region,
		"cluster_name":        c.config.Kubernetes.ClusterName,
		"desired_capacity":    c.config.Kubernetes.NodeCount,
		"min_capacity":        c.config.Kubernetes.MinNodes,
		"max_capacity":        c.config.Kubernetes.MaxNodes,
	}

	// Add AWS-specific variables
	if c.config.Cloud.AWS.InstanceType != "" {
		vars["node_instance_type"] = c.config.Cloud.AWS.InstanceType
	} else {
		vars["node_instance_type"] = "c8g.large" // Default
	}

	if c.config.Cloud.AWS.VPCCidr != "" {
		vars["vpc_cidr"] = c.config.Cloud.AWS.VPCCidr
	}

	// Add custom terraform variables
	for k, v := range c.config.Advanced.Terraform.Variables {
		vars[k] = v
	}

	return c.writeTerraformVars(vars)
}

// createAzureTerraformVars creates terraform.tfvars for Azure
func (c *CloudOperations) createAzureTerraformVars() error {
	vars := map[string]interface{}{
		"location":            c.config.Cloud.Region,
		"cluster_name":        c.config.Kubernetes.ClusterName,
		"node_count":          c.config.Kubernetes.NodeCount,
		"min_count":           c.config.Kubernetes.MinNodes,
		"max_count":           c.config.Kubernetes.MaxNodes,
		"enable_auto_scaling": c.config.Kubernetes.EnableAutoscale,
	}

	// Add Azure-specific variables
	if c.config.Cloud.Azure.ResourceGroup != "" {
		vars["resource_group_name"] = c.config.Cloud.Azure.ResourceGroup
	}

	if c.config.Cloud.Azure.VMSize != "" {
		vars["vm_size"] = c.config.Cloud.Azure.VMSize
	} else {
		vars["vm_size"] = "Standard_D4s_v5" // Default
	}

	// Add custom terraform variables
	for k, v := range c.config.Advanced.Terraform.Variables {
		vars[k] = v
	}

	return c.writeTerraformVars(vars)
}

// createGCPTerraformVars creates terraform.tfvars for GCP
func (c *CloudOperations) createGCPTerraformVars() error {
	vars := map[string]interface{}{
		"region":              c.config.Cloud.Region,
		"cluster_name":        c.config.Kubernetes.ClusterName,
		"initial_node_count":  c.config.Kubernetes.NodeCount,
		"min_node_count":      c.config.Kubernetes.MinNodes,
		"max_node_count":      c.config.Kubernetes.MaxNodes,
		"enable_autoscaling":  c.config.Kubernetes.EnableAutoscale,
	}

	// Add GCP-specific variables
	if c.config.Cloud.GCP.ProjectID != "" {
		vars["project_id"] = c.config.Cloud.GCP.ProjectID
	}

	if c.config.Cloud.GCP.Zone != "" {
		vars["zone"] = c.config.Cloud.GCP.Zone
	}

	if c.config.Cloud.GCP.MachineType != "" {
		vars["machine_type"] = c.config.Cloud.GCP.MachineType
	} else {
		vars["machine_type"] = "n2-standard-4" // Default
	}

	// Add custom terraform variables
	for k, v := range c.config.Advanced.Terraform.Variables {
		vars[k] = v
	}

	return c.writeTerraformVars(vars)
}

// writeTerraformVars writes terraform.tfvars file
func (c *CloudOperations) writeTerraformVars(vars map[string]interface{}) error {
	tfvarsPath := filepath.Join(c.terraformDir, "terraform.tfvars")

	file, err := os.Create(tfvarsPath)
	if err != nil {
		return fmt.Errorf("failed to create terraform.tfvars: %w", err)
	}
	defer file.Close()

	writer := bufio.NewWriter(file)

	for k, v := range vars {
		var line string
		switch val := v.(type) {
		case string:
			line = fmt.Sprintf("%s = \"%s\"\n", k, val)
		case int:
			line = fmt.Sprintf("%s = %d\n", k, val)
		case bool:
			line = fmt.Sprintf("%s = %v\n", k, val)
		default:
			line = fmt.Sprintf("%s = %v\n", k, val)
		}

		if _, err := writer.WriteString(line); err != nil {
			return fmt.Errorf("failed to write variable %s: %w", k, err)
		}
	}

	return writer.Flush()
}

// updateAWSKubeconfig updates kubeconfig for EKS
func (c *CloudOperations) updateAWSKubeconfig(outputs map[string]string) error {
	// Try to get the configure_kubectl output first (if terraform provides it)
	if configCmd, ok := outputs["configure_kubectl"]; ok && configCmd != "" {
		cmd := exec.Command("sh", "-c", configCmd)
		if output, err := cmd.CombinedOutput(); err != nil {
			return fmt.Errorf("failed to configure kubectl: %s\n%s", err, string(output))
		}
		return nil
	}

	// Fallback to standard aws eks update-kubeconfig
	clusterName := outputs["cluster_name"]
	if clusterName == "" {
		clusterName = c.config.Kubernetes.ClusterName
	}

	region := outputs["region"]
	if region == "" {
		region = c.config.Cloud.Region
	}

	cmd := exec.Command("aws", "eks", "update-kubeconfig",
		"--region", region,
		"--name", clusterName)

	if output, err := cmd.CombinedOutput(); err != nil {
		return fmt.Errorf("failed to update kubeconfig: %s\n%s", err, string(output))
	}

	return nil
}

// updateAzureKubeconfig updates kubeconfig for AKS
func (c *CloudOperations) updateAzureKubeconfig(outputs map[string]string) error {
	// Try to get the configure_kubectl output first (if terraform provides it)
	if configCmd, ok := outputs["configure_kubectl"]; ok && configCmd != "" {
		cmd := exec.Command("sh", "-c", configCmd)
		if output, err := cmd.CombinedOutput(); err != nil {
			return fmt.Errorf("failed to configure kubectl: %s\n%s", err, string(output))
		}
		return nil
	}

	// Fallback to standard az aks get-credentials
	resourceGroup := outputs["resource_group_name"]
	if resourceGroup == "" {
		resourceGroup = c.config.Cloud.Azure.ResourceGroup
	}

	clusterName := outputs["cluster_name"]
	if clusterName == "" {
		clusterName = c.config.Kubernetes.ClusterName
	}

	cmd := exec.Command("az", "aks", "get-credentials",
		"--resource-group", resourceGroup,
		"--name", clusterName,
		"--overwrite-existing")

	if output, err := cmd.CombinedOutput(); err != nil {
		return fmt.Errorf("failed to get AKS credentials: %s\n%s", err, string(output))
	}

	return nil
}

// updateGCPKubeconfig updates kubeconfig for GKE
func (c *CloudOperations) updateGCPKubeconfig(outputs map[string]string) error {
	// Try to get the configure_kubectl output first (if terraform provides it)
	if configCmd, ok := outputs["configure_kubectl"]; ok && configCmd != "" {
		cmd := exec.Command("sh", "-c", configCmd)
		if output, err := cmd.CombinedOutput(); err != nil {
			return fmt.Errorf("failed to configure kubectl: %s\n%s", err, string(output))
		}
		return nil
	}

	// Fallback to standard gcloud container clusters get-credentials
	clusterName := outputs["cluster_name"]
	if clusterName == "" {
		clusterName = c.config.Kubernetes.ClusterName
	}

	region := outputs["region"]
	if region == "" {
		region = c.config.Cloud.Region
	}

	projectID := outputs["project_id"]
	if projectID == "" {
		projectID = c.config.Cloud.GCP.ProjectID
	}

	cmd := exec.Command("gcloud", "container", "clusters", "get-credentials",
		clusterName,
		"--region", region,
		"--project", projectID)

	if output, err := cmd.CombinedOutput(); err != nil {
		return fmt.Errorf("failed to get GKE credentials: %s\n%s", err, string(output))
	}

	return nil
}

// DestroyCluster tears down the Kubernetes cluster
func (c *CloudOperations) DestroyCluster() error {
	fmt.Printf("🗑️  Destroying Kubernetes cluster on %s...\n", c.config.Cloud.Provider)

	// Set terraform directory based on provider
	c.terraformDir = filepath.Join("terraform", c.config.Cloud.Provider)

	// Check if terraform directory exists
	if _, err := os.Stat(c.terraformDir); os.IsNotExist(err) {
		return fmt.Errorf("terraform configuration not found at %s", c.terraformDir)
	}

	// Run terraform destroy
	fmt.Println("🔥 Running terraform destroy...")
	if err := c.runTerraformCommand("destroy", "-auto-approve"); err != nil {
		return fmt.Errorf("terraform destroy failed: %w", err)
	}

	fmt.Println("✅ Infrastructure destroyed successfully!")
	return nil
}

// GetClusterInfo retrieves information about the current cluster
func (c *CloudOperations) GetClusterInfo() (map[string]string, error) {
	c.terraformDir = filepath.Join("terraform", c.config.Cloud.Provider)

	// Check if terraform state exists
	statePath := filepath.Join(c.terraformDir, "terraform.tfstate")
	if _, err := os.Stat(statePath); os.IsNotExist(err) {
		return nil, fmt.Errorf("no terraform state found - cluster may not exist")
	}

	// Get terraform outputs
	outputs, err := c.getTerraformOutputs()
	if err != nil {
		return nil, fmt.Errorf("failed to get cluster info: %w", err)
	}

	return outputs, nil
}

// ConfigureTerraformBackend configures remote state backend
func (c *CloudOperations) ConfigureTerraformBackend() error {
	if c.config.Advanced.Terraform.Backend == "" || c.config.Advanced.Terraform.Backend == "local" {
		return nil // Local backend, no configuration needed
	}

	fmt.Printf("🔧 Configuring Terraform %s backend...\n", c.config.Advanced.Terraform.Backend)

	// Create backend configuration file
	backendConfig := "terraform {\n  backend \"" + c.config.Advanced.Terraform.Backend + "\" {\n"

	for k, v := range c.config.Advanced.Terraform.BackendConfig {
		backendConfig += fmt.Sprintf("    %s = \"%s\"\n", k, v)
	}

	backendConfig += "  }\n}\n"

	// Write to backend.tf in each terraform directory
	providers := []string{"aws", "azure", "gcp"}
	for _, provider := range providers {
		backendPath := filepath.Join("terraform", provider, "backend.tf")
		if err := os.WriteFile(backendPath, []byte(backendConfig), 0644); err != nil {
			// Only error if the directory exists
			if _, statErr := os.Stat(filepath.Join("terraform", provider)); !os.IsNotExist(statErr) {
				return fmt.Errorf("failed to write backend config for %s: %w", provider, err)
			}
		}
	}

	return nil
}

// CheckClusterHealth verifies the cluster is healthy and accessible
func (c *CloudOperations) CheckClusterHealth() error {
	fmt.Println("🏥 Checking cluster health...")

	// Check if kubectl can connect
	cmd := exec.Command("kubectl", "cluster-info")
	output, err := cmd.CombinedOutput()
	if err != nil {
		return fmt.Errorf("cannot connect to cluster: %s\n%s", err, string(output))
	}

	// Check nodes are ready
	cmd = exec.Command("kubectl", "get", "nodes", "-o", "json")
	output, err = cmd.Output()
	if err != nil {
		return fmt.Errorf("failed to get nodes: %w", err)
	}

	var nodeList struct {
		Items []struct {
			Status struct {
				Conditions []struct {
					Type   string `json:"type"`
					Status string `json:"status"`
				} `json:"conditions"`
			} `json:"status"`
		} `json:"items"`
	}

	if err := json.Unmarshal(output, &nodeList); err != nil {
		return fmt.Errorf("failed to parse node list: %w", err)
	}

	notReadyNodes := 0
	for _, node := range nodeList.Items {
		isReady := false
		for _, condition := range node.Status.Conditions {
			if condition.Type == "Ready" && condition.Status == "True" {
				isReady = true
				break
			}
		}
		if !isReady {
			notReadyNodes++
		}
	}

	if notReadyNodes > 0 {
		return fmt.Errorf("%d nodes are not ready", notReadyNodes)
	}

	fmt.Println("✅ Cluster is healthy!")
	return nil
}

// WaitForClusterReady waits for the cluster to be ready
func (c *CloudOperations) WaitForClusterReady(timeout time.Duration) error {
	fmt.Println("⏳ Waiting for cluster to be ready...")

	deadline := time.Now().Add(timeout)
	ticker := time.NewTicker(10 * time.Second)
	defer ticker.Stop()

	for {
		select {
		case <-ticker.C:
			if err := c.CheckClusterHealth(); err == nil {
				return nil
			}

			if time.Now().After(deadline) {
				return fmt.Errorf("cluster did not become ready within %v", timeout)
			}

			fmt.Println("⏳ Still waiting for cluster...")
		}
	}
}


// Close cleans up resources
func (c *CloudOperations) Close() error {
	if c.assetManager != nil {
		return c.assetManager.Close()
	}
	return nil
}
