package main

import (
	"context"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/fatih/color"
	"gopkg.in/yaml.v3"
)

type DestroyerOptions struct {
	DestroyCluster bool
	Force          bool
	Verbose        bool
}

type Destroyer struct {
	config     *Config
	options    DestroyerOptions
	progress   *ProgressIndicator
	state      *DeploymentState
	cloudOps   *CloudOperations
	k8sOps     *KubernetesOperations
	namespaces []string
	components []string
}

func NewDestroyer(config *Config, options DestroyerOptions) *Destroyer {
	return &Destroyer{
		config:   config,
		options:  options,
		progress: NewProgressIndicator(options.Verbose),
	}
}

func (d *Destroyer) Execute() error {
	startTime := time.Now()

	d.progress.Section("Preparing Destruction")

	if err := d.loadState(); err != nil {
		d.progress.Warning("Could not load deployment state: %v", err)
	}

	if err := d.initializeOperations(); err != nil {
		return fmt.Errorf("failed to initialize operations: %w", err)
	}

	if err := d.discoverResources(); err != nil {
		d.progress.Warning("Could not discover all resources: %v", err)
	}

	d.displayPlan()

	d.progress.Section("Starting Destruction")

	if err := d.quickDeletion(); err != nil {
		d.progress.Warning("Quick deletion encountered errors: %v", err)
	}

	if err := d.cleanupNamespaces(); err != nil {
		d.progress.Warning("Namespace cleanup encountered errors: %v", err)
	}

	if err := d.cleanupProjectResources(); err != nil {
		d.progress.Warning("Project resource cleanup encountered errors: %v", err)
	}

	if d.options.DestroyCluster {
		if err := d.destroyInfrastructure(); err != nil {
			return fmt.Errorf("infrastructure destruction failed: %w", err)
		}
	}

	if err := d.cleanupLocalState(); err != nil {
		d.progress.Warning("Failed to clean up local state: %v", err)
	}

	duration := time.Since(startTime)
	fmt.Printf("\nDestruction completed in %s\n", formatDuration(duration))

	return nil
}

func (d *Destroyer) loadState() error {
	statePath := ".rulebricks-state.yaml"

	if _, err := os.Stat(statePath); os.IsNotExist(err) {
		return fmt.Errorf("no deployment state found")
	}

	data, err := os.ReadFile(statePath)
	if err != nil {
		return err
	}

	state := &DeploymentState{}
	if err := yaml.Unmarshal(data, state); err != nil {
		return err
	}

	d.state = state
	return nil
}

func (d *Destroyer) initializeOperations() error {
	// Initialize Kubernetes operations
	k8sOps, err := NewKubernetesOperations(d.config, d.options.Verbose)
	if err != nil {
		d.progress.Warning("Kubernetes not accessible: %v", err)
		// Continue anyway - might be destroying infrastructure
	} else {
		d.k8sOps = k8sOps
	}

	// Initialize cloud operations if destroying cluster
	if d.options.DestroyCluster {
		terraformDir := "terraform"

		cloudOps, err := NewCloudOperations(d.config, terraformDir, d.options.Verbose)
		if err != nil {
			return fmt.Errorf("failed to initialize cloud operations: %w", err)
		}
		d.cloudOps = cloudOps
	}

	return nil
}

func (d *Destroyer) discoverResources() error {
	if d.k8sOps == nil {
		return fmt.Errorf("kubernetes not accessible")
	}

	spinner := d.progress.StartSpinner("Discovering deployed resources")

	// Discover namespaces
	namespaces, err := d.k8sOps.ListProjectNamespaces(d.config.Project.Name)
	if err != nil {
		spinner.Fail()
		return err
	}
	// Filter out cert-manager namespace - we preserve it for faster redeploys
	filteredNamespaces := []string{}
	for _, ns := range namespaces {
		if ns != "cert-manager" {
			filteredNamespaces = append(filteredNamespaces, ns)
		}
	}
	d.namespaces = filteredNamespaces

	// Discover components
	components := []string{}
	if d.isComponentDeployed("app") {
		components = append(components, "Application")
	}
	if d.isComponentDeployed("supabase") && d.config.Database.Type == "self-hosted" {
		components = append(components, "Database")
	}
	if d.isComponentDeployed("monitoring") && d.config.Monitoring.Enabled {
		components = append(components, "Monitoring")
	}
	if d.isComponentDeployed("logging") && d.config.Logging.Enabled {
		components = append(components, "Logging")
	}
	if d.isComponentDeployed("execution") {
		components = append(components, "Kafka")
	}
	d.components = components

	spinner.Success(fmt.Sprintf("Found %d namespaces and %d components", len(d.namespaces), len(d.components)))
	return nil
}

func (d *Destroyer) isComponentDeployed(component string) bool {
	if d.k8sOps == nil {
		return false
	}

	namespace := d.config.GetNamespace(component)
	return contains(d.namespaces, namespace)
}

func (d *Destroyer) displayPlan() {
	color.New(color.Bold).Println("\n🗑️  Destruction Plan")
	fmt.Println(strings.Repeat("─", 50))

	if len(d.components) > 0 {
		fmt.Println("Components to remove:")
		for _, comp := range d.components {
			fmt.Printf("  • %s\n", comp)
		}
	}

	if len(d.namespaces) > 0 {
		fmt.Println("\nNamespaces to delete:")
		for _, ns := range d.namespaces {
			fmt.Printf("  • %s\n", ns)
		}
	}

	if d.options.DestroyCluster {
		fmt.Println("\nInfrastructure to destroy:")
		fmt.Printf("  • Kubernetes cluster: %s\n", d.config.Kubernetes.ClusterName)
		fmt.Printf("  • Cloud provider: %s\n", d.config.Cloud.Provider)
		fmt.Printf("  • Region: %s\n", d.config.Cloud.Region)
	}

	// Show preserved components
	if !d.options.DestroyCluster && d.isComponentDeployed("cert-manager") {
		fmt.Println("\nComponents to preserve:")
		fmt.Printf("  • cert-manager (retains certificates for faster redeploys)\n")
	}

	fmt.Println(strings.Repeat("─", 50))
}

func (d *Destroyer) quickDeletion() error {
	if d.k8sOps == nil {
		return nil
	}

	d.progress.Section("Quick Deletion Phase")

	tasks := []struct {
		name string
		fn   func(context.Context) error
	}{
		{"Rulebricks Application", d.deleteApplication},
		{"Monitoring Stack", d.deleteMonitoring},
		{"Kafka", d.deleteKafka},
		{"Vector Logging", d.deleteLogging},
		{"Supabase Database", d.deleteDatabase},
		{"KEDA", d.deleteKEDA},
		{"Traefik Ingress", d.deleteIngress},
	}

	ctx := context.Background()
	for _, task := range tasks {
		spinner := d.progress.StartSpinner(fmt.Sprintf("Uninstalling %s", task.name))

		if err := task.fn(ctx); err != nil {
			spinner.Fail()
			d.progress.Debug("Failed to delete %s: %v", task.name, err)
		} else {
			spinner.Success()
		}
	}

	return nil
}

func (d *Destroyer) cleanupNamespaces() error {
	if d.k8sOps == nil || len(d.namespaces) == 0 {
		return nil
	}

	d.progress.Section("Namespace Cleanup Phase")

	// First attempt: quick namespace deletion
	spinner := d.progress.StartSpinner("Deleting namespaces")

	var wg sync.WaitGroup
	errors := make(chan error, len(d.namespaces))

	for _, ns := range d.namespaces {
		wg.Add(1)
		go func(namespace string) {
			defer wg.Done()
			if err := d.k8sOps.DeleteNamespace(context.Background(), namespace); err != nil {
				errors <- fmt.Errorf("%s: %v", namespace, err)
			}
		}(ns)
	}

	wg.Wait()
	close(errors)

	var errs []error
	for err := range errors {
		errs = append(errs, err)
	}

	if len(errs) > 0 {
		spinner.Fail(fmt.Sprintf("Failed to delete %d namespaces", len(errs)))
	} else {
		spinner.Success("All namespaces deleted")
		return nil
	}

	// Wait for namespaces to be deleted
	d.progress.Info("Waiting for namespaces to terminate...")
	time.Sleep(30 * time.Second)

	// Check for stuck namespaces
	stuckNamespaces, err := d.k8sOps.GetStuckNamespaces(d.namespaces)
	if err != nil || len(stuckNamespaces) == 0 {
		return nil
	}

	// Force delete stuck namespaces
	d.progress.Warning("Found %d stuck namespaces, forcing deletion", len(stuckNamespaces))

	for _, ns := range stuckNamespaces {
		spinner := d.progress.StartSpinner(fmt.Sprintf("Force deleting namespace: %s", ns))
		if err := d.forceDeleteNamespace(ns); err != nil {
			spinner.Fail()
			d.progress.Error("Failed to force delete %s: %v", ns, err)
		} else {
			spinner.Success()
		}
	}

	return nil
}

func (d *Destroyer) forceDeleteNamespace(namespace string) error {
	ctx := context.Background()

	// Remove finalizers from all resources in namespace
	resourceTypes := []string{
		"pods", "services", "deployments", "statefulsets", "daemonsets",
		"replicasets", "jobs", "cronjobs", "configmaps", "secrets",
		"persistentvolumeclaims", "ingresses", "servicemonitors",
	}

	for _, resourceType := range resourceTypes {
		if err := d.k8sOps.RemoveFinalizers(ctx, namespace, resourceType); err != nil {
			d.progress.Debug("Failed to remove finalizers from %s: %v", resourceType, err)
		}
	}

	// Remove namespace finalizers
	if err := d.k8sOps.RemoveNamespaceFinalizers(ctx, namespace); err != nil {
		return fmt.Errorf("failed to remove namespace finalizers: %w", err)
	}

	// Force delete namespace
	cmd := exec.Command("kubectl", "delete", "namespace", namespace, "--force", "--grace-period=0")
	if err := cmd.Run(); err != nil {
		return fmt.Errorf("force delete failed: %w", err)
	}

	return nil
}

func (d *Destroyer) cleanupProjectResources() error {
	if d.k8sOps == nil {
		return nil
	}

	d.progress.Section("Project Resource Cleanup")

	spinner := d.progress.StartSpinner("Cleaning up project-specific cluster resources")

	// Clean up CRDs
	if err := d.k8sOps.DeleteProjectCRDs(d.config.Project.Name); err != nil {
		d.progress.Debug("Failed to delete CRDs: %v", err)
	}

	// Clean up PVs
	if err := d.k8sOps.DeleteProjectPVs(d.config.Project.Name); err != nil {
		d.progress.Debug("Failed to delete PVs: %v", err)
	}

	// Clean up cluster roles and bindings
	if err := d.k8sOps.DeleteProjectClusterRoles(d.config.Project.Name); err != nil {
		d.progress.Debug("Failed to delete cluster roles: %v", err)
	}

	spinner.Success("Project resources cleaned up")
	return nil
}

func (d *Destroyer) destroyInfrastructure() error {
	if d.cloudOps == nil {
		return fmt.Errorf("cloud operations not initialized")
	}

	d.progress.Section("Infrastructure Destruction")

	spinner := d.progress.StartSpinner("Destroying cloud infrastructure")

	ctx := context.Background()
	if err := d.cloudOps.DestroyInfrastructure(ctx); err != nil {
		spinner.Fail()
		return fmt.Errorf("failed to destroy infrastructure: %w", err)
	}

	spinner.Success("Infrastructure destroyed")
	return nil
}

func (d *Destroyer) cleanupLocalState() error {
	homeDir, _ := os.UserHomeDir()
	workDir := filepath.Join(homeDir, ".rulebricks", "deploy", d.config.Project.Name)

	spinner := d.progress.StartSpinner("Cleaning up local state")

	// Remove the state file in current directory
	statePath := ".rulebricks-state.yaml"
	if _, err := os.Stat(statePath); err == nil {
		if err := os.Remove(statePath); err != nil {
			spinner.Fail()
			return fmt.Errorf("failed to remove state file: %w", err)
		}
	}

	// Remove the work directory if it exists
	if _, err := os.Stat(workDir); err == nil {
		if err := os.RemoveAll(workDir); err != nil {
			spinner.Fail()
			return fmt.Errorf("failed to remove work directory: %w", err)
		}
	}

	spinner.Success("Local state cleaned up")
	return nil
}

// Component deletion methods

func (d *Destroyer) deleteApplication(ctx context.Context) error {
	if d.k8sOps == nil || !d.isComponentDeployed("app") {
		return nil
	}
	return d.k8sOps.UninstallApplication(ctx)
}

func (d *Destroyer) deleteMonitoring(ctx context.Context) error {
	if d.k8sOps == nil || !d.config.Monitoring.Enabled || !d.isComponentDeployed("monitoring") {
		return nil
	}
	return d.k8sOps.UninstallPrometheus(ctx)
}

func (d *Destroyer) deleteLogging(ctx context.Context) error {
	if d.k8sOps == nil || !d.config.Logging.Enabled || !d.isComponentDeployed("logging") {
		return nil
	}
	return d.k8sOps.UninstallVector(ctx)
}

func (d *Destroyer) deleteKafka(ctx context.Context) error {
	if d.k8sOps == nil || !d.isComponentDeployed("execution") {
		return nil
	}
	return d.k8sOps.UninstallKafka(ctx)
}

func (d *Destroyer) deleteDatabase(ctx context.Context) error {
	if d.k8sOps == nil || d.config.Database.Type != "self-hosted" || !d.isComponentDeployed("supabase") {
		return nil
	}
	return d.k8sOps.UninstallSupabase(ctx)
}

func (d *Destroyer) deleteIngress(ctx context.Context) error {
	if d.k8sOps == nil || !d.isComponentDeployed("traefik") {
		return nil
	}

	// NOTE: We intentionally preserve cert-manager to retain certificates
	// This allows faster redeploys with existing valid certificates,
	// avoids Let's Encrypt rate limits, and uses minimal resources when idle

	// Only delete Traefik
	return d.k8sOps.UninstallTraefik(ctx)
}

func (d *Destroyer) deleteKEDA(ctx context.Context) error {
	if d.k8sOps == nil {
		return nil
	}
	return d.k8sOps.UninstallKEDA(ctx)
}

// Utility function
func contains(slice []string, item string) bool {
	for _, s := range slice {
		if s == item {
			return true
		}
	}
	return false
}
