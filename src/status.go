package main

import (
	"context"
	"fmt"
	"strings"
	"time"

	"github.com/fatih/color"
	corev1 "k8s.io/api/core/v1"
)

// StatusChecker handles status checking operations
type StatusChecker struct {
	config   *Config
	k8sOps   *KubernetesOperations
	progress *ProgressIndicator
}

// NewStatusChecker creates a new status checker
func NewStatusChecker(config *Config) *StatusChecker {
	return &StatusChecker{
		config:   config,
		progress: NewProgressIndicator(false), // Status checking is always non-verbose
	}
}

// CheckAll performs a comprehensive status check
func (checker *StatusChecker) CheckAll() (*DeploymentStatus, error) {
	status := &DeploymentStatus{
		Timestamp: time.Now(),
	}

	// Initialize Kubernetes operations
	k8sOps, err := NewKubernetesOperations(checker.config, false)
	if err != nil {
		status.Infrastructure.Status = "unreachable"
		status.Infrastructure.Message = fmt.Sprintf("Cannot connect to cluster: %v", err)
		status.OverallHealth = HealthUnknown
		return status, nil
	}
	checker.k8sOps = k8sOps

	// Check components
	checker.checkInfrastructure(status)
	checker.checkKubernetes(status)
	checker.checkDatabase(status)
	checker.checkApplication(status)
	checker.checkServices(status)
	checker.checkMonitoring(status)
	checker.checkCertificates(status)

	// Calculate overall health
	status.OverallHealth = checker.calculateOverallHealth(status)

	return status, nil
}

// Component check methods

func (checker *StatusChecker) checkInfrastructure(status *DeploymentStatus) {
	status.Infrastructure = InfrastructureStatus{
		Provider:    checker.config.Cloud.Provider,
		Region:      checker.config.Cloud.Region,
		ClusterName: checker.config.Kubernetes.ClusterName,
		Status:      "running",
		Message:     "Cluster accessible",
	}

	// Get cluster endpoint
	// Note: This would require CloudOperations instance to get actual endpoint
	status.Infrastructure.ClusterEndpoint = ""
}

func (checker *StatusChecker) checkKubernetes(status *DeploymentStatus) {
	ctx := context.Background()

	// Get Kubernetes version
	version, _ := checker.k8sOps.GetKubernetesVersion()
	status.Kubernetes.Version = version

	// Get nodes
	nodes, err := checker.k8sOps.ListNodes(ctx)
	if err == nil {
		status.Kubernetes.Nodes = make([]NodeStatus, len(nodes))
		for i, node := range nodes {
			status.Kubernetes.Nodes[i] = NodeStatus{
				Name:   node.Name,
				Status: getNodeStatus(node),
				Ready:  isNodeReady(node),
				CPU:    getNodeCPU(node),
				Memory: getNodeMemory(node),
			}
		}
	}

	// Count namespaces
	namespaces, _ := checker.k8sOps.ListProjectNamespaces(checker.config.Project.Name)
	status.Kubernetes.Namespaces = len(namespaces)

	// Count pods
	status.Kubernetes.TotalPods = 0
	status.Kubernetes.RunningPods = 0
	status.Kubernetes.PendingPods = 0
	status.Kubernetes.FailedPods = 0

	for _, ns := range namespaces {
		pods, err := checker.k8sOps.ListPods(ctx, ns)
		if err != nil {
			continue
		}

		status.Kubernetes.TotalPods += len(pods.Items)
		for _, pod := range pods.Items {
			switch pod.Status.Phase {
			case corev1.PodRunning:
				status.Kubernetes.RunningPods++
			case corev1.PodPending:
				status.Kubernetes.PendingPods++
			case corev1.PodFailed:
				status.Kubernetes.FailedPods++
			}
		}
	}
}

func (checker *StatusChecker) checkDatabase(status *DeploymentStatus) {
	status.Database = DatabaseStatus{
		Type:     checker.config.Database.Type,
		Provider: checker.config.Database.Provider,
	}

	switch checker.config.Database.Type {
	case "self-hosted":
		checker.checkSelfHostedDatabase(status)
	case "managed":
		checker.checkManagedDatabase(status)
	case "external":
		checker.checkExternalDatabase(status)
	}
}

func (checker *StatusChecker) checkSelfHostedDatabase(status *DeploymentStatus) {
	namespace := checker.config.GetNamespace("supabase")
	ctx := context.Background()

	// Check if database pod is running
	pods, err := checker.k8sOps.ListPods(ctx, namespace)
	if err != nil {
		status.Database.Available = false
		return
	}

	for _, pod := range pods.Items {
		if strings.Contains(pod.Name, "supabase-db") {
			status.Database.Available = pod.Status.Phase == corev1.PodRunning
			break
		}
	}

	// Get database service endpoint
	service, err := checker.k8sOps.GetService(ctx, namespace, "supabase-db")
	if err == nil {
		status.Database.InternalEndpoint = fmt.Sprintf("%s.%s:5432", service.Name, service.Namespace)
	}
}

func (checker *StatusChecker) checkManagedDatabase(status *DeploymentStatus) {
	// For managed Supabase, we assume it's available if configured
	status.Database.Available = true
	status.Database.Provider = "Supabase"
	if checker.config.Database.Supabase != nil {
		status.Database.ExternalEndpoint = fmt.Sprintf("https://%s.supabase.co", checker.config.Database.Supabase.ProjectName)
	}
}

func (checker *StatusChecker) checkExternalDatabase(status *DeploymentStatus) {
	// For external database, we can't directly check availability
	status.Database.Available = true
	if checker.config.Database.External != nil {
		status.Database.ExternalEndpoint = fmt.Sprintf("%s:%d", checker.config.Database.External.Host, checker.config.Database.External.Port)
	}
}

func (checker *StatusChecker) checkApplication(status *DeploymentStatus) {
	namespace := checker.config.GetNamespace("app")
	ctx := context.Background()

	// Check deployment
	deployment, err := checker.k8sOps.GetDeployment(ctx, namespace, "rulebricks")
	if err != nil {
		status.Application.Deployed = false
		return
	}

	status.Application.Deployed = true
	status.Application.Replicas = int(deployment.Status.Replicas)
	status.Application.ReadyReplicas = int(deployment.Status.ReadyReplicas)

	// Get version from deployment labels
	if version, ok := deployment.Labels["app.kubernetes.io/version"]; ok {
		status.Application.Version = version
	}

	// Get application URL
	status.Application.URL = fmt.Sprintf("https://%s", checker.config.Project.Domain)
}

func (checker *StatusChecker) checkServices(status *DeploymentStatus) {
	ctx := context.Background()

	// Check Traefik
	traefikNs := checker.config.GetNamespace("traefik")
	traefikDeployment, err := checker.k8sOps.GetDeployment(ctx, traefikNs, "traefik")
	if err == nil && traefikDeployment.Status.ReadyReplicas > 0 {
		status.Services.Traefik = ServiceInfo{
			Name:      "Traefik",
			Namespace: traefikNs,
			Status:    "running",
		}

		// Get load balancer endpoint
		service, err := checker.k8sOps.GetService(ctx, traefikNs, "traefik")
		if err == nil && service.Status.LoadBalancer.Ingress != nil && len(service.Status.LoadBalancer.Ingress) > 0 {
			endpoint := service.Status.LoadBalancer.Ingress[0]
			if endpoint.Hostname != "" {
				status.Services.Traefik.Endpoints = []string{endpoint.Hostname}
			} else if endpoint.IP != "" {
				status.Services.Traefik.Endpoints = []string{endpoint.IP}
			}
		}
	}

	// Check cert-manager
	if checker.config.Security.TLS != nil && checker.config.Security.TLS.Enabled {
		certManagerNs := checker.config.GetNamespace("cert-manager")
		certManagerDeployment, err := checker.k8sOps.GetDeployment(ctx, certManagerNs, "cert-manager")
		if err == nil && certManagerDeployment.Status.ReadyReplicas > 0 {
			status.Services.CertManager = ServiceInfo{
				Name:      "cert-manager",
				Namespace: certManagerNs,
				Status:    "running",
			}
		}
	}

	// Check Supabase services if self-hosted
	if checker.config.Database.Type == "self-hosted" {
		supabaseNs := checker.config.GetNamespace("supabase")
		supabaseServices := []string{"kong", "auth", "realtime", "storage", "meta"}
		runningServices := 0

		for _, svc := range supabaseServices {
			deployment, err := checker.k8sOps.GetDeployment(ctx, supabaseNs, fmt.Sprintf("supabase-%s", svc))
			if err == nil && deployment.Status.ReadyReplicas > 0 {
				runningServices++
			}
		}

		if runningServices > 0 {
			status.Services.Supabase = ServiceInfo{
				Name:      "Supabase",
				Namespace: supabaseNs,
				Status:    fmt.Sprintf("%d/%d services running", runningServices, len(supabaseServices)),
			}
		}
	}
}

func (checker *StatusChecker) checkMonitoring(status *DeploymentStatus) {
	if !checker.config.Monitoring.Enabled {
		status.Monitoring.Enabled = false
		return
	}

	status.Monitoring.Enabled = true
	status.Monitoring.Provider = checker.config.Monitoring.Provider

	ctx := context.Background()
	monitoringNs := checker.config.GetNamespace("monitoring")

	// Check Prometheus
	prometheusDeployment, err := checker.k8sOps.GetDeployment(ctx, monitoringNs, "prometheus-kube-prometheus-prometheus")
	if err == nil && prometheusDeployment.Status.ReadyReplicas > 0 {
		status.Monitoring.PrometheusRunning = true
	}

	// Check Grafana
	grafanaDeployment, err := checker.k8sOps.GetDeployment(ctx, monitoringNs, "prometheus-grafana")
	if err == nil && grafanaDeployment.Status.ReadyReplicas > 0 {
		status.Monitoring.GrafanaRunning = true
		status.Monitoring.GrafanaURL = fmt.Sprintf("https://grafana.%s", checker.config.Project.Domain)
	}
}

func (checker *StatusChecker) checkCertificates(status *DeploymentStatus) {
	if checker.config.Security.TLS == nil || !checker.config.Security.TLS.Enabled {
		return
	}

	// Certificate checking would require cert-manager client
	// For now, return empty
	status.Certificates = []CertificateStatus{}
}

// Health calculation

func (checker *StatusChecker) calculateOverallHealth(status *DeploymentStatus) HealthState {
	criticalIssues := 0
	warnings := 0

	// Check infrastructure
	if status.Infrastructure.Status != "running" {
		criticalIssues++
	}

	// Check Kubernetes pods
	if status.Kubernetes.FailedPods > 0 {
		warnings++
	}
	if status.Kubernetes.PendingPods > status.Kubernetes.TotalPods/2 {
		criticalIssues++
	}

	// Check database
	if !status.Database.Available {
		criticalIssues++
	}

	// Check application
	if !status.Application.Deployed {
		criticalIssues++
	} else if status.Application.ReadyReplicas < status.Application.Replicas {
		warnings++
	}

	// Check certificates
	for _, cert := range status.Certificates {
		if !cert.Valid {
			warnings++
		}
		if cert.DaysLeft > 0 && cert.DaysLeft < 7 {
			warnings++
		}
	}

	// Determine overall health
	if criticalIssues > 0 {
		return HealthUnhealthy
	} else if warnings > 0 {
		return HealthDegraded
	}
	return HealthHealthy
}

// Helper functions

func getNodeStatus(node corev1.Node) string {
	for _, condition := range node.Status.Conditions {
		if condition.Type == corev1.NodeReady {
			if condition.Status == corev1.ConditionTrue {
				return "Ready"
			}
			return "NotReady"
		}
	}
	return "Unknown"
}

func isNodeReady(node corev1.Node) bool {
	return getNodeStatus(node) == "Ready"
}

func getNodeCPU(node corev1.Node) ResourceUsage {
	allocatable := node.Status.Allocatable[corev1.ResourceCPU]
	capacity := node.Status.Capacity[corev1.ResourceCPU]

	return ResourceUsage{
		Used:       allocatable.MilliValue(),
		Capacity:   capacity.MilliValue(),
		Percentage: float64(allocatable.MilliValue()) / float64(capacity.MilliValue()) * 100,
	}
}

func getNodeMemory(node corev1.Node) ResourceUsage {
	allocatable := node.Status.Allocatable[corev1.ResourceMemory]
	capacity := node.Status.Capacity[corev1.ResourceMemory]

	return ResourceUsage{
		Used:       allocatable.Value(),
		Capacity:   capacity.Value(),
		Percentage: float64(allocatable.Value()) / float64(capacity.Value()) * 100,
	}
}

// Status types

type DeploymentStatus struct {
	Timestamp     time.Time
	Infrastructure InfrastructureStatus
	Kubernetes    KubernetesStatus
	Database      DatabaseStatus
	Application   ApplicationStatus
	Services      ServicesStatus
	Monitoring    MonitoringStatus
	Certificates  []CertificateStatus
	HealthChecks  []HealthCheck
	OverallHealth HealthState
}

type InfrastructureStatus struct {
	Provider        string
	Region          string
	ClusterName     string
	ClusterEndpoint string
	Status          string
	Message         string
}

type KubernetesStatus struct {
	Version      string
	Nodes        []NodeStatus
	Namespaces   int
	TotalPods    int
	RunningPods  int
	PendingPods  int
	FailedPods   int
}

type NodeStatus struct {
	Name   string
	Status string
	Ready  bool
	CPU    ResourceUsage
	Memory ResourceUsage
}

type ResourceUsage struct {
	Used       int64
	Capacity   int64
	Percentage float64
}

type DatabaseStatus struct {
	Type             string
	Provider         string
	Available        bool
	Version          string
	InternalEndpoint string
	ExternalEndpoint string
}

type ApplicationStatus struct {
	Deployed      bool
	Version       string
	Replicas      int
	ReadyReplicas int
	URL           string
	LastDeployed  time.Time
}

type ServicesStatus struct {
	Traefik     ServiceInfo
	CertManager ServiceInfo
	Supabase    ServiceInfo
}

type ServiceInfo struct {
	Name      string
	Namespace string
	Status    string
	Version   string
	Endpoints []string
}

type MonitoringStatus struct {
	Enabled           bool
	Provider          string
	PrometheusRunning bool
	GrafanaRunning    bool
	GrafanaURL        string
}

type CertificateStatus struct {
	Domain     string
	Issuer     string
	Valid      bool
	ExpiryDate time.Time
	DaysLeft   int
}

type HealthCheck struct {
	Name        string
	Component   string
	Status      HealthState
	Message     string
	LastChecked time.Time
}

type HealthState string

const (
	HealthHealthy   HealthState = "healthy"
	HealthDegraded  HealthState = "degraded"
	HealthUnhealthy HealthState = "unhealthy"
	HealthUnknown   HealthState = "unknown"
)

// Display method for DeploymentStatus
func (status *DeploymentStatus) Display() {
	// Header
	fmt.Println()
	color.New(color.Bold).Printf("📊 Deployment Status\n")
	fmt.Printf("Checked at: %s\n", status.Timestamp.Format("2006-01-02 15:04:05"))
	fmt.Println(strings.Repeat("─", 60))

	// Overall Health
	healthIcon := getHealthIcon(status.OverallHealth)
	healthColor := getHealthColor(status.OverallHealth)
	fmt.Printf("\nOverall Health: %s %s\n", healthIcon, healthColor(string(status.OverallHealth)))

	// Infrastructure
	fmt.Printf("\n🏗️  Infrastructure\n")
	fmt.Printf("   Provider: %s (%s)\n", status.Infrastructure.Provider, status.Infrastructure.Region)
	fmt.Printf("   Cluster: %s\n", status.Infrastructure.ClusterName)
	fmt.Printf("   Status: %s\n", getStatusText(status.Infrastructure.Status))

	// Kubernetes
	fmt.Printf("\n☸️  Kubernetes\n")
	fmt.Printf("   Version: %s\n", status.Kubernetes.Version)
	fmt.Printf("   Nodes: %d (all %s)\n", len(status.Kubernetes.Nodes), getNodesStatus(status.Kubernetes.Nodes))
	fmt.Printf("   Namespaces: %d\n", status.Kubernetes.Namespaces)
	fmt.Printf("   Pods: %d total (%s running, %s pending, %s failed)\n",
		status.Kubernetes.TotalPods,
		color.GreenString("%d", status.Kubernetes.RunningPods),
		color.YellowString("%d", status.Kubernetes.PendingPods),
		color.RedString("%d", status.Kubernetes.FailedPods))

	// Database
	fmt.Printf("\n🗄️  Database\n")
	fmt.Printf("   Type: %s\n", status.Database.Type)
	fmt.Printf("   Available: %s\n", getBoolStatus(status.Database.Available))
	if status.Database.InternalEndpoint != "" {
		fmt.Printf("   Internal: %s\n", status.Database.InternalEndpoint)
	}
	if status.Database.ExternalEndpoint != "" {
		fmt.Printf("   External: %s\n", status.Database.ExternalEndpoint)
	}

	// Application
	fmt.Printf("\n🚀 Application\n")
	fmt.Printf("   Deployed: %s\n", getBoolStatus(status.Application.Deployed))
	if status.Application.Deployed {
		fmt.Printf("   Version: %s\n", status.Application.Version)
		fmt.Printf("   Replicas: %d/%d ready\n", status.Application.ReadyReplicas, status.Application.Replicas)
		fmt.Printf("   URL: %s\n", color.CyanString(status.Application.URL))
	}

	// Services
	fmt.Printf("\n🔧 Services\n")
	if status.Services.Traefik.Status != "" {
		fmt.Printf("   Traefik: %s\n", getStatusText(status.Services.Traefik.Status))
		if len(status.Services.Traefik.Endpoints) > 0 {
			fmt.Printf("      Load Balancer: %s\n", status.Services.Traefik.Endpoints[0])
		}
	}
	if status.Services.CertManager.Status != "" {
		fmt.Printf("   Cert-Manager: %s\n", getStatusText(status.Services.CertManager.Status))
	}
	if status.Services.Supabase.Status != "" {
		fmt.Printf("   Supabase: %s\n", status.Services.Supabase.Status)
	}

	// Monitoring
	if status.Monitoring.Enabled {
		fmt.Printf("\n📈 Monitoring\n")
		fmt.Printf("   Prometheus: %s\n", getBoolStatus(status.Monitoring.PrometheusRunning))
		fmt.Printf("   Grafana: %s\n", getBoolStatus(status.Monitoring.GrafanaRunning))
		if status.Monitoring.GrafanaURL != "" {
			fmt.Printf("   Dashboard: %s\n", color.CyanString(status.Monitoring.GrafanaURL))
		}
	}

	// Certificates
	if len(status.Certificates) > 0 {
		fmt.Printf("\n🔒 Certificates\n")
		for _, cert := range status.Certificates {
			validStatus := color.GreenString("✓ valid")
			if !cert.Valid {
				validStatus = color.RedString("✗ invalid")
			} else if cert.DaysLeft < 30 {
				validStatus = color.YellowString("⚠ expires in %d days", cert.DaysLeft)
			}
			fmt.Printf("   %s: %s\n", cert.Domain, validStatus)
		}
	}

	fmt.Println(strings.Repeat("─", 60))
}

// Helper display functions

func getHealthIcon(health HealthState) string {
	switch health {
	case HealthHealthy:
		return "✅"
	case HealthDegraded:
		return "⚠️"
	case HealthUnhealthy:
		return "❌"
	default:
		return "❓"
	}
}

func getHealthColor(health HealthState) func(string, ...interface{}) string {
	switch health {
	case HealthHealthy:
		return color.GreenString
	case HealthDegraded:
		return color.YellowString
	case HealthUnhealthy:
		return color.RedString
	default:
		return color.HiBlackString
	}
}

func getStatusText(status string) string {
	switch status {
	case "running":
		return color.GreenString("✓ running")
	case "stopped":
		return color.RedString("✗ stopped")
	default:
		return color.YellowString("? " + status)
	}
}

func getBoolStatus(value bool) string {
	if value {
		return color.GreenString("✓ yes")
	}
	return color.RedString("✗ no")
}

func getNodesStatus(nodes []NodeStatus) string {
	allReady := true
	for _, node := range nodes {
		if !node.Ready {
			allReady = false
			break
		}
	}
	if allReady {
		return color.GreenString("ready")
	}
	return color.YellowString("not all ready")
}
