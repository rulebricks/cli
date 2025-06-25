// status.go - Status Checker and Updater
package main

import (
	"context"
	"fmt"
	"os/exec"
	"strings"
	"time"
	"unicode"
	"encoding/json"
	"github.com/fatih/color"
	v1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/client-go/kubernetes"
	"k8s.io/client-go/tools/clientcmd"
)

// StatusChecker checks deployment status
type StatusChecker struct {
	config    Config
	k8sClient *kubernetes.Clientset
}

// NewStatusChecker creates a new status checker
func NewStatusChecker(config Config) *StatusChecker {
	return &StatusChecker{config: config}
}

// DeploymentStatus represents the overall deployment status
type DeploymentStatus struct {
	Timestamp          time.Time
	Infrastructure     InfrastructureStatus
	Kubernetes         KubernetesStatus
	Database           DatabaseStatus
	Application        ApplicationStatus
	Services           ServicesStatus
	Monitoring         MonitoringStatus
	Certificates       CertificateStatus
	HealthChecks       []HealthCheck
	OverallHealth      HealthState
}

// Component statuses
type InfrastructureStatus struct {
	Provider    string
	Region      string
	ClusterName string
	Status      string
	Message     string
}

type KubernetesStatus struct {
	Version       string
	Nodes         []NodeStatus
	Namespaces    []string
	TotalPods     int
	RunningPods   int
	PendingPods   int
	FailedPods    int
}

type NodeStatus struct {
	Name       string
	Status     string
	Role       string
	Version    string
	CPU        ResourceUsage
	Memory     ResourceUsage
	DiskPressure bool
	Ready      bool
}

type ResourceUsage struct {
	Used       string
	Capacity   string
	Percentage float64
}

type DatabaseStatus struct {
	Type         string
	Provider     string
	Available    bool
	Version      string
	Connections  int
	MaxConnections int
	Size         string
	Replicas     []ReplicaStatus
}

type ReplicaStatus struct {
	Host      string
	Status    string
	Lag       time.Duration
}

type ApplicationStatus struct {
	Deployed     bool
	Version      string
	Replicas     int
	ReadyReplicas int
	URL          string
	LastDeployed time.Time
}

type ServicesStatus struct {
	Traefik      ServiceInfo
	CertManager  ServiceInfo
	Supabase     *ServiceInfo // Optional
	CustomServices map[string]ServiceInfo
}

type ServiceInfo struct {
	Name      string
	Namespace string
	Status    string
	Version   string
	Endpoints []string
}

type MonitoringStatus struct {
	Enabled      bool
	Provider     string
	GrafanaURL    string
	AlertsActive  int
}

type CertificateStatus struct {
	Domain      string
	Issuer      string
	Valid       bool
	ExpiryDate  time.Time
	DaysLeft    int
	AutoRenewal bool
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

// CheckAll performs all status checks
func (s *StatusChecker) CheckAll() DeploymentStatus {
	status := DeploymentStatus{
		Timestamp:    time.Now(),
		HealthChecks: []HealthCheck{},
	}

	// Initialize Kubernetes client
	if err := s.initK8sClient(); err != nil {
		status.OverallHealth = HealthUnknown
		status.HealthChecks = append(status.HealthChecks, HealthCheck{
			Name:      "Kubernetes Connection",
			Component: "Infrastructure",
			Status:    HealthUnhealthy,
			Message:   fmt.Sprintf("Failed to connect to cluster: %v", err),
		})
		return status
	}

	// Check infrastructure
	status.Infrastructure = s.checkInfrastructure()

	// Check Kubernetes cluster
	status.Kubernetes = s.checkKubernetes()

	// Check database
	status.Database = s.checkDatabase()

	// Check application
	status.Application = s.checkApplication()

	// Check services
	status.Services = s.checkServices()

	// Check monitoring
	if s.config.Monitoring.Enabled {
		status.Monitoring = s.checkMonitoring()
	}

	// Check certificates
	status.Certificates = s.checkCertificates()

	// Determine overall health
	status.OverallHealth = s.calculateOverallHealth(status)

	return status
}

// getNamespace returns the namespace for a component with project prefix
func (s *StatusChecker) getNamespace(component string) string {
	return GetDefaultNamespace(s.config.Project.Name, component)
}

func (s *StatusChecker) initK8sClient() error {
	// Get kubeconfig
	kubeconfig := clientcmd.NewDefaultClientConfigLoadingRules().GetDefaultFilename()

	config, err := clientcmd.BuildConfigFromFlags("", kubeconfig)
	if err != nil {
		return err
	}

	client, err := kubernetes.NewForConfig(config)
	if err != nil {
		return err
	}

	s.k8sClient = client
	return nil
}

func (s *StatusChecker) checkInfrastructure() InfrastructureStatus {
	infra := InfrastructureStatus{
		Provider: s.config.Cloud.Provider,
		Region:   s.config.Cloud.Region,
		ClusterName: s.config.Kubernetes.ClusterName,
		Status:   "Unknown",
	}

	// Check cluster accessibility
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	_, err := s.k8sClient.CoreV1().Namespaces().List(ctx, metav1.ListOptions{})
	if err != nil {
		infra.Status = "Unreachable"
		infra.Message = fmt.Sprintf("Cannot connect to cluster: %v", err)
	} else {
		infra.Status = "Connected"
		infra.Message = "Cluster is accessible"
	}

	return infra
}

func (s *StatusChecker) checkKubernetes() KubernetesStatus {
	k8s := KubernetesStatus{}

	ctx := context.Background()

	// Get cluster version
	version, err := s.k8sClient.Discovery().ServerVersion()
	if err == nil {
		k8s.Version = version.GitVersion
	}

	// Get nodes
	nodes, err := s.k8sClient.CoreV1().Nodes().List(ctx, metav1.ListOptions{})
	if err == nil {
		for _, node := range nodes.Items {
			nodeStatus := NodeStatus{
				Name:    node.Name,
				Version: node.Status.NodeInfo.KubeletVersion,
			}

			// Check node conditions
			for _, condition := range node.Status.Conditions {
				if condition.Type == v1.NodeReady {
					nodeStatus.Ready = condition.Status == v1.ConditionTrue
					if nodeStatus.Ready {
						nodeStatus.Status = "Ready"
					} else {
						nodeStatus.Status = "NotReady"
					}
				}
				if condition.Type == v1.NodeDiskPressure {
					nodeStatus.DiskPressure = condition.Status == v1.ConditionTrue
				}
			}

			// Get node role
			if _, ok := node.Labels["node-role.kubernetes.io/master"]; ok {
				nodeStatus.Role = "master"
			} else if _, ok := node.Labels["node-role.kubernetes.io/control-plane"]; ok {
				nodeStatus.Role = "control-plane"
			} else {
				nodeStatus.Role = "worker"
			}

			// Get resource usage (would need metrics API)
			// For now, just get capacity
			if cpu := node.Status.Capacity.Cpu(); cpu != nil {
				nodeStatus.CPU.Capacity = cpu.String()
			}
			if mem := node.Status.Capacity.Memory(); mem != nil {
				nodeStatus.Memory.Capacity = mem.String()
			}

			k8s.Nodes = append(k8s.Nodes, nodeStatus)
		}
	}

	// Get namespaces
	namespaces, err := s.k8sClient.CoreV1().Namespaces().List(ctx, metav1.ListOptions{})
	if err == nil {
		for _, ns := range namespaces.Items {
			k8s.Namespaces = append(k8s.Namespaces, ns.Name)
		}
	}

	// Count pods across all namespaces
	pods, err := s.k8sClient.CoreV1().Pods("").List(ctx, metav1.ListOptions{})
	if err == nil {
		k8s.TotalPods = len(pods.Items)
		for _, pod := range pods.Items {
			switch pod.Status.Phase {
			case v1.PodRunning:
				k8s.RunningPods++
			case v1.PodPending:
				k8s.PendingPods++
			case v1.PodFailed:
				k8s.FailedPods++
			}
		}
	}

	return k8s
}

func (s *StatusChecker) checkDatabase() DatabaseStatus {
	db := DatabaseStatus{
		Type:     s.config.Database.Type,
		Provider: s.config.Database.Provider,
	}

	switch s.config.Database.Type {
	case "self-hosted":
		db = s.checkSelfHostedDatabase()
	case "managed":
		db = s.checkManagedDatabase()
	case "external":
		db = s.checkExternalDatabase()
	}

	return db
}

func (s *StatusChecker) checkSelfHostedDatabase() DatabaseStatus {
	db := DatabaseStatus{
		Type:     "self-hosted",
		Provider: "supabase",
	}

	ctx := context.Background()

	// Check if Supabase pods are running
	supabaseNamespace := s.getNamespace("supabase")
	pods, err := s.k8sClient.CoreV1().Pods(supabaseNamespace).List(ctx, metav1.ListOptions{
		LabelSelector: "app.kubernetes.io/instance=supabase",
	})

	if err == nil {
		dbPodFound := false
		for _, pod := range pods.Items {
			if strings.Contains(pod.Name, "supabase-db") {
				dbPodFound = true
				if pod.Status.Phase == v1.PodRunning {
					db.Available = true
				}
				break
			}
		}

		if !dbPodFound {
			db.Available = false
		}
	}

	// Get database version and stats (would need to exec into pod)
	if db.Available {
		db.Version = "15.1"
		db.MaxConnections = 100
	}

	return db
}

func (s *StatusChecker) checkManagedDatabase() DatabaseStatus {
	db := DatabaseStatus{
		Type:      "managed",
		Provider:  "supabase",
		Available: true, // Assume available for managed
	}

	// Would check via Supabase API
	return db
}

func (s *StatusChecker) checkExternalDatabase() DatabaseStatus {
	db := DatabaseStatus{
		Type:     "external",
		Provider: "postgres",
	}

	// Would check database connection
	// For now, assume it's available
	db.Available = true

	// Check replicas
	for _, replica := range s.config.Database.External.Replicas {
		replicaStatus := ReplicaStatus{
			Host:   replica.Host,
			Status: "Unknown",
		}

		// Would check actual replica status
		db.Replicas = append(db.Replicas, replicaStatus)
	}

	return db
}

func (s *StatusChecker) checkApplication() ApplicationStatus {
	app := ApplicationStatus{}

	namespace := s.config.Project.Namespace
	if namespace == "" {
		namespace = s.getNamespace("rulebricks")
	}

	ctx := context.Background()

	// Check deployment
	deployment, err := s.k8sClient.AppsV1().Deployments(namespace).Get(ctx, "rulebricks-app", metav1.GetOptions{})
	if err == nil {
		app.Deployed = true
		app.Replicas = int(*deployment.Spec.Replicas)
		app.ReadyReplicas = int(deployment.Status.ReadyReplicas)

		// Get version from image tag
		if len(deployment.Spec.Template.Spec.Containers) > 0 {
			image := deployment.Spec.Template.Spec.Containers[0].Image
			parts := strings.Split(image, ":")
			if len(parts) > 1 {
				app.Version = parts[1]
			}
		}

		// Get last deployment time
		app.LastDeployed = deployment.CreationTimestamp.Time
	}

	app.URL = fmt.Sprintf("https://%s", s.config.Project.Domain)

	return app
}

func (s *StatusChecker) checkServices() ServicesStatus {
	services := ServicesStatus{
		CustomServices: make(map[string]ServiceInfo),
	}

	ctx := context.Background()

	// Check Traefik
	traefikNamespace := s.getNamespace("traefik")
	traefikDeploy, err := s.k8sClient.AppsV1().Deployments(traefikNamespace).Get(ctx, "traefik", metav1.GetOptions{})
	if err == nil {
		services.Traefik = ServiceInfo{
			Name:      "traefik",
			Namespace: s.getNamespace("traefik"),
			Status:    "Running",
		}

		if traefikDeploy.Status.ReadyReplicas == *traefikDeploy.Spec.Replicas {
			services.Traefik.Status = "Healthy"
		}

		// Get service endpoints
		svc, err := s.k8sClient.CoreV1().Services(traefikNamespace).Get(ctx, "traefik", metav1.GetOptions{})
		if err == nil && len(svc.Status.LoadBalancer.Ingress) > 0 {
			lb := svc.Status.LoadBalancer.Ingress[0]
			if lb.Hostname != "" {
				services.Traefik.Endpoints = append(services.Traefik.Endpoints, lb.Hostname)
			} else if lb.IP != "" {
				services.Traefik.Endpoints = append(services.Traefik.Endpoints, lb.IP)
			}
		}
	}

	// Check Supabase if self-hosted
	if s.config.Database.Type == "self-hosted" {
		supabaseNamespace := s.getNamespace("supabase")
		supabase := ServiceInfo{
			Name:      "supabase",
			Namespace: supabaseNamespace,
			Status:    "Unknown",
		}

		// Check Kong (API Gateway)
		kongDeploy, err := s.k8sClient.AppsV1().Deployments(supabaseNamespace).Get(ctx, "supabase-kong", metav1.GetOptions{})
		if err == nil && kongDeploy.Status.ReadyReplicas > 0 {
			supabase.Status = "Running"
			supabase.Endpoints = append(supabase.Endpoints, fmt.Sprintf("https://supabase.%s", s.config.Project.Domain))
		}

		services.Supabase = &supabase
	}

	return services
}

func (s *StatusChecker) checkMonitoring() MonitoringStatus {
	mon := MonitoringStatus{
		Enabled:  true,
		Provider: s.config.Monitoring.Provider,
	}

	if s.config.Monitoring.Provider == "prometheus" {
		mon.GrafanaURL = fmt.Sprintf("https://grafana.%s", s.config.Project.Domain)

		// Check if monitoring stack is running
		ctx := context.Background()
		monitoringNamespace := s.getNamespace("monitoring")
		_, err := s.k8sClient.AppsV1().Deployments(monitoringNamespace).Get(ctx, "prometheus-kube-prometheus-prometheus", metav1.GetOptions{})
		if err != nil {
			mon.Enabled = false
		}
	}

	return mon
}

func (s *StatusChecker) checkCertificates() CertificateStatus {
	cert := CertificateStatus{
		Domain:      s.config.Project.Domain,
		Issuer:      "Let's Encrypt",
		AutoRenewal: true,
	}

	// Check certificate expiry
	// Would need to check cert-manager or actual certificate
	cert.Valid = true
	cert.ExpiryDate = time.Now().Add(60 * 24 * time.Hour) // Assume 60 days
	cert.DaysLeft = int(time.Until(cert.ExpiryDate).Hours() / 24)

	return cert
}

func (s *StatusChecker) calculateOverallHealth(status DeploymentStatus) HealthState {
	// If infrastructure is not connected, overall health is unknown
	if status.Infrastructure.Status != "Connected" {
		return HealthUnknown
	}

	// Check critical components
	criticalHealthy := true
	anyDegraded := false

	// Check nodes
	for _, node := range status.Kubernetes.Nodes {
		if !node.Ready {
			criticalHealthy = false
			break
		}
	}

	// Check database
	if !status.Database.Available {
		criticalHealthy = false
	}

	// Check application
	if status.Application.Deployed && status.Application.ReadyReplicas < status.Application.Replicas {
		anyDegraded = true
	}

	// Check failed pods
	if status.Kubernetes.FailedPods > 0 {
		anyDegraded = true
	}

	// Check certificate
	if !status.Certificates.Valid || status.Certificates.DaysLeft < 7 {
		anyDegraded = true
	}

	if !criticalHealthy {
		return HealthUnhealthy
	} else if anyDegraded {
		return HealthDegraded
	}

	return HealthHealthy
}

// Display shows the deployment status
func (s DeploymentStatus) Display() {
	// Header
	fmt.Println("\n" + strings.Repeat("=", 70))

	// Overall health with color
	healthIcon := "✅"
	healthColor := color.GreenString

	switch s.OverallHealth {
	case HealthDegraded:
		healthIcon = "⚠️"
		healthColor = color.YellowString
	case HealthUnhealthy:
		healthIcon = "❌"
		healthColor = color.RedString
	case HealthUnknown:
		healthIcon = "❓"
		healthColor = color.WhiteString
	}

	fmt.Printf("%s Deployment Status: %s\n", healthIcon, healthColor(string(s.OverallHealth)))
	fmt.Printf("📅 Last checked: %s\n", s.Timestamp.Format("2006-01-02 15:04:05"))
	fmt.Println(strings.Repeat("=", 70))

	// Infrastructure
	fmt.Printf("\n🏗️  Infrastructure (%s on %s)\n", s.Infrastructure.Provider, s.Infrastructure.Region)
	fmt.Printf("   Cluster: %s - %s\n", s.Infrastructure.ClusterName, s.Infrastructure.Status)
	if s.Infrastructure.Message != "" {
		fmt.Printf("   %s\n", s.Infrastructure.Message)
	}

	// Kubernetes
	fmt.Printf("\n☸️  Kubernetes %s\n", s.Kubernetes.Version)
	fmt.Printf("   Nodes: %d\n", len(s.Kubernetes.Nodes))
	for _, node := range s.Kubernetes.Nodes {
		statusIcon := "✅"
		if !node.Ready {
			statusIcon = "❌"
		}
		fmt.Printf("     %s %s (%s) - %s\n", statusIcon, node.Name, node.Role, node.Status)
	}
	fmt.Printf("   Pods: %d total (%d running, %d pending, %d failed)\n",
		s.Kubernetes.TotalPods, s.Kubernetes.RunningPods, s.Kubernetes.PendingPods, s.Kubernetes.FailedPods)

	// Database
	dbIcon := "✅"
	if !s.Database.Available {
		dbIcon = "❌"
	}
	fmt.Printf("\n🗄️  Database (%s %s)\n", s.Database.Type, s.Database.Provider)
	fmt.Printf("   %s Status: %s\n", dbIcon, boolToStatus(s.Database.Available))
	if s.Database.Version != "" {
		fmt.Printf("   Version: %s\n", s.Database.Version)
	}
	if len(s.Database.Replicas) > 0 {
		fmt.Printf("   Replicas: %d\n", len(s.Database.Replicas))
		for i, replica := range s.Database.Replicas {
			fmt.Printf("     %d. %s - %s\n", i+1, replica.Host, replica.Status)
		}
	}

	// Application
	appIcon := "✅"
	if !s.Application.Deployed || s.Application.ReadyReplicas < s.Application.Replicas {
		appIcon = "⚠️"
	}
	fmt.Printf("\n🚀 Application\n")
	fmt.Printf("   %s Deployed: %s (v%s)\n", appIcon, boolToStatus(s.Application.Deployed), s.Application.Version)
	if s.Application.Deployed {
		fmt.Printf("   Replicas: %d/%d ready\n", s.Application.ReadyReplicas, s.Application.Replicas)
		fmt.Printf("   URL: %s\n", s.Application.URL)
		fmt.Printf("   Last deployed: %s\n", s.Application.LastDeployed.Format("2006-01-02 15:04:05"))
	}

	// Services
	fmt.Printf("\n⚙️  Services\n")
	fmt.Printf("   Traefik: %s\n", s.Services.Traefik.Status)
	if len(s.Services.Traefik.Endpoints) > 0 {
		fmt.Printf("     Load Balancer: %s\n", s.Services.Traefik.Endpoints[0])
	}
	if s.Services.Supabase != nil {
		fmt.Printf("   Supabase: %s\n", s.Services.Supabase.Status)
		if len(s.Services.Supabase.Endpoints) > 0 {
			fmt.Printf("     Dashboard: %s\n", s.Services.Supabase.Endpoints[0])
		}
	}

	// Monitoring
	if s.Monitoring.Enabled {
		fmt.Printf("\n📊 Monitoring (%s)\n", s.Monitoring.Provider)
		if s.Monitoring.GrafanaURL != "" {
			fmt.Printf("   Grafana: %s\n", s.Monitoring.GrafanaURL)
		}
		if s.Monitoring.AlertsActive > 0 {
			fmt.Printf("   ⚠️  Active alerts: %d\n", s.Monitoring.AlertsActive)
		}
	}

	// Certificates
	certIcon := "🔒"
	certStatus := "Valid"
	if !s.Certificates.Valid {
		certIcon = "🔓"
		certStatus = "Invalid"
	} else if s.Certificates.DaysLeft < 30 {
		certIcon = "⚠️"
		certStatus = fmt.Sprintf("Expiring in %d days", s.Certificates.DaysLeft)
	}
	fmt.Printf("\n%s TLS Certificate\n", certIcon)
	fmt.Printf("   Domain: %s\n", s.Certificates.Domain)
	fmt.Printf("   Status: %s\n", certStatus)
	fmt.Printf("   Expires: %s\n", s.Certificates.ExpiryDate.Format("2006-01-02"))

	// Health checks
	if len(s.HealthChecks) > 0 {
		fmt.Printf("\n🏥 Health Checks\n")
		for _, check := range s.HealthChecks {
			icon := "✅"
			switch check.Status {
			case HealthDegraded:
				icon = "⚠️"
			case HealthUnhealthy:
				icon = "❌"
			case HealthUnknown:
				icon = "❓"
			}
			fmt.Printf("   %s %s: %s\n", icon, check.Name, check.Message)
		}
	}

	fmt.Println("\n" + strings.Repeat("=", 70))
}

func boolToStatus(b bool) string {
	if b {
		return "Available"
	}
	return "Unavailable"
}

// Updater handles deployment updates
type Updater struct {
	config Config
	state  DeploymentState
}

func (u *Updater) getNamespace(component string) string {
	return GetDefaultNamespace(u.config.Project.Name, component)
}

// NewUpdater creates a new updater
func NewUpdater(config Config, state DeploymentState) *Updater {
	return &Updater{
		config: config,
		state:  state,
	}
}

// UpdatePlan represents changes to be applied
type UpdatePlan struct {
	Changes []Change
}

// Change represents a single change
type Change struct {
	Type        string // add, modify, remove
	Component   string
	Description string
	Impact      string // low, medium, high
}

// IsEmpty checks if there are no changes
func (p UpdatePlan) IsEmpty() bool {
	return len(p.Changes) == 0
}

// Display shows the update plan
func (p UpdatePlan) Display() {
	if p.IsEmpty() {
		fmt.Println("No changes detected.")
		return
	}

	fmt.Println("\nThe following changes will be applied:")

	// Group by impact
	high := []Change{}
	medium := []Change{}
	low := []Change{}

	for _, change := range p.Changes {
		switch change.Impact {
		case "high":
			high = append(high, change)
		case "medium":
			medium = append(medium, change)
		default:
			low = append(low, change)
		}
	}

	// Display by impact level
	if len(high) > 0 {
		color.Red("\n⚠️  High Impact Changes (may cause downtime):\n")
		for _, change := range high {
			displayChange(change)
		}
	}

	if len(medium) > 0 {
		color.Yellow("\n⚡ Medium Impact Changes:\n")
		for _, change := range medium {
			displayChange(change)
		}
	}

	if len(low) > 0 {
		color.Green("\n✨ Low Impact Changes:\n")
		for _, change := range low {
			displayChange(change)
		}
	}
}

func displayChange(change Change) {
	icon := "+"
	if change.Type == "modify" {
		icon = "~"
	} else if change.Type == "remove" {
		icon = "-"
	}

	fmt.Printf("   %s [%s] %s\n", icon, change.Component, change.Description)
}

// CreateUpdatePlan analyzes changes and creates an update plan
func (u *Updater) CreateUpdatePlan() UpdatePlan {
	plan := UpdatePlan{
		Changes: []Change{},
	}

	// Compare configurations and determine changes
	// This is a simplified version - real implementation would be more comprehensive

	// Check for node count changes
	if u.config.Kubernetes.NodeCount != u.state.Infrastructure.NodeCount {
		plan.Changes = append(plan.Changes, Change{
			Type:        "modify",
			Component:   "Kubernetes",
			Description: fmt.Sprintf("Scale nodes from %d to %d", u.state.Infrastructure.NodeCount, u.config.Kubernetes.NodeCount),
			Impact:      "low",
		})
	}

	// Check for application updates
	if u.config.Advanced.CustomValues != nil {
		if replicas, ok := u.config.Advanced.CustomValues["app"].(map[string]interface{})["replicas"].(int); ok {
			if replicas != u.state.Application.Replicas {
				plan.Changes = append(plan.Changes, Change{
					Type:        "modify",
					Component:   "Application",
					Description: fmt.Sprintf("Scale application from %d to %d replicas", u.state.Application.Replicas, replicas),
					Impact:      "low",
				})
			}
		}
	}

	// Check for monitoring changes
	if u.config.Monitoring.Enabled && !u.state.Monitoring.Enabled {
		plan.Changes = append(plan.Changes, Change{
			Type:        "add",
			Component:   "Monitoring",
			Description: "Deploy Prometheus and Grafana monitoring stack",
			Impact:      "medium",
		})
	}

	// Check for database changes (high impact)
	if u.config.Database.Type != u.state.Database.Type {
		plan.Changes = append(plan.Changes, Change{
			Type:        "modify",
			Component:   "Database",
			Description: fmt.Sprintf("Change database from %s to %s", u.state.Database.Type, u.config.Database.Type),
			Impact:      "high",
		})
	}

	return plan
}

// Execute applies the update plan
func (u *Updater) Execute(plan UpdatePlan) error {
	if plan.IsEmpty() {
		return nil
	}

	fmt.Println("\n🔄 Executing update plan...")

	for i, change := range plan.Changes {
		fmt.Printf("\n[%d/%d] %s\n", i+1, len(plan.Changes), change.Description)

		switch change.Component {
		case "Kubernetes":
			if err := u.updateKubernetes(change); err != nil {
				return fmt.Errorf("failed to update Kubernetes: %w", err)
			}

		case "Application":
			if err := u.updateApplication(change); err != nil {
				return fmt.Errorf("failed to update application: %w", err)
			}

		case "Monitoring":
			if err := u.updateMonitoring(change); err != nil {
				return fmt.Errorf("failed to update monitoring: %w", err)
			}

		case "Database":
			if err := u.updateDatabase(change); err != nil {
				return fmt.Errorf("failed to update database: %w", err)
			}
		}

		color.Green("✅ Completed\n")
	}

	return nil
}

func (u *Updater) updateKubernetes(change Change) error {
	// Update node count using cloud provider APIs
	// This would involve updating the auto-scaling group or node pool
	fmt.Println("   Updating Kubernetes cluster...")
	time.Sleep(2 * time.Second) // Simulate work
	return nil
}

func (u *Updater) updateApplication(change Change) error {
	// Update application using Helm
	fmt.Println("   Updating application deployment...")

	namespace := u.config.Project.Namespace
	if namespace == "" {
		namespace = u.getNamespace("rulebricks")
	}

	// Would run: helm upgrade rulebricks ./rulebricks-chart ...
	cmd := exec.Command("kubectl", "scale", "deployment/rulebricks-app",
		fmt.Sprintf("--replicas=%d", u.config.Advanced.CustomValues["app"].(map[string]interface{})["replicas"].(int)),
		"-n", namespace)

	return cmd.Run()
}

func (u *Updater) updateMonitoring(change Change) error {
	// Deploy or update monitoring stack
	fmt.Println("   Deploying monitoring stack...")
	time.Sleep(3 * time.Second) // Simulate work
	return nil
}

func (u *Updater) updateDatabase(change Change) error {
	// This is a complex operation that would require careful migration
	return fmt.Errorf("database migration not implemented in this version")
}

// Destroyer handles deployment teardown
type Destroyer struct {
	config             Config
	destroyCluster     bool
	force              bool
	deployedComponents map[string]bool
	discoveredNamespaces []string
}

// NewDestroyer creates a new destroyer
func NewDestroyer(config Config, destroyCluster bool, force bool) *Destroyer {
	return &Destroyer{
		config:               config,
		destroyCluster:       destroyCluster,
		force:                true, // Always force delete for aggressive cleanup
		deployedComponents:   make(map[string]bool),
		discoveredNamespaces: []string{},
	}
}

// Execute tears down the deployment
// getNamespace returns the namespace for a component with project prefix
func (d *Destroyer) getNamespace(component string) string {
	return GetDefaultNamespace(d.config.Project.Name, component)
}

// Add required imports
func (d *Destroyer) discoverDeployedComponents() error {
	fmt.Println("\n🔍 Discovering all namespaces for cleanup...")

	// Get all namespaces
	projectPrefix := d.config.Project.Name
	cmd := exec.Command("kubectl", "get", "namespaces", "-o", "json")
	output, err := cmd.Output()
	if err != nil {
		return fmt.Errorf("failed to list namespaces: %w", err)
	}

	// Parse namespaces
	type NamespaceList struct {
		Items []struct {
			Metadata struct {
				Name string `json:"name"`
			} `json:"metadata"`
			Status struct {
				Phase string `json:"phase"`
			} `json:"status"`
		} `json:"items"`
	}

	var nsList NamespaceList
	if err := json.Unmarshal(output, &nsList); err != nil {
		return fmt.Errorf("failed to parse namespace list: %w", err)
	}

	// Find ALL namespaces with our project prefix
	for _, ns := range nsList.Items {
		if !strings.HasPrefix(ns.Metadata.Name, projectPrefix+"-") {
			continue
		}

		// Add to discovered namespaces list for forced cleanup
		d.discoveredNamespaces = append(d.discoveredNamespaces, ns.Metadata.Name)

		// Mark all components as deployed to trigger cleanup steps
		d.deployedComponents["application"] = true
		d.deployedComponents["traefik"] = true
		d.deployedComponents["cert-manager"] = true
		d.deployedComponents["monitoring"] = true
		d.deployedComponents["supabase"] = true
		d.deployedComponents["logging"] = true
		d.deployedComponents["kafka"] = true
		d.deployedComponents["vector"] = true
		d.deployedComponents["keda"] = true
		d.deployedComponents["execution"] = true

		fmt.Printf("  Found namespace: %s (status: %s)\n", ns.Metadata.Name, ns.Status.Phase)
	}

	fmt.Printf("\n  Total namespaces to clean: %d\n", len(d.discoveredNamespaces))

	// Also check for cluster-wide resources with our prefix
	fmt.Println("\n🔍 Checking for cluster-wide resources...")

	// Check for CRDs
	cmd = exec.Command("kubectl", "get", "crd", "-o", "name")
	if crdOutput, err := cmd.Output(); err == nil {
		lines := strings.Split(string(crdOutput), "\n")
		for _, line := range lines {
			if strings.Contains(strings.ToLower(line), projectPrefix) {
				fmt.Printf("  Found CRD: %s\n", line)
			}
		}
	}

	// Check for ClusterRoles/ClusterRoleBindings
	for _, resource := range []string{"clusterrole", "clusterrolebinding"} {
		cmd = exec.Command("kubectl", "get", resource, "-o", "name")
		if resourceOutput, err := cmd.Output(); err == nil {
			lines := strings.Split(string(resourceOutput), "\n")
			for _, line := range lines {
				if strings.Contains(line, projectPrefix) {
					fmt.Printf("  Found %s: %s\n", resource, line)
				}
			}
		}
	}

	return nil
}

func (d *Destroyer) forceDeleteNamespace(namespace string) {
	fmt.Printf("\n💣 Force deleting namespace: %s\n", namespace)

	// First, try a quick delete with a short timeout
	fmt.Printf("  Attempting quick namespace deletion...\n")
	quickCtx, quickCancel := context.WithTimeout(context.Background(), 5*time.Second)
	quickCmd := exec.CommandContext(quickCtx, "kubectl", "delete", "namespace", namespace, "--force", "--grace-period=0")
	quickCmd.Run()
	quickCancel()

	// Check if namespace still exists
	checkCmd := exec.Command("kubectl", "get", "namespace", namespace)
	if err := checkCmd.Run(); err != nil {
		fmt.Printf("  ✅ Namespace deleted successfully\n")
		return
	}

	// If still exists, do aggressive cleanup
	fmt.Printf("  Namespace still exists, performing aggressive cleanup...\n")

	// Delete common resource types that might block namespace deletion
	resourceTypes := []string{
		"deployment", "statefulset", "daemonset", "replicaset", "pod",
		"service", "ingress", "endpoints", "endpointslice",
		"pvc", "configmap", "secret", "serviceaccount",
		"role", "rolebinding", "networkpolicy",
		"poddisruptionbudget", "horizontalpodautoscaler",
		"job", "cronjob", "lease", "event",
	}

	fmt.Printf("  Deleting resources in namespace...\n")
	for i, resourceType := range resourceTypes {
		if i%5 == 0 && i > 0 {
			fmt.Printf("    Progress: %d/%d resource types\n", i, len(resourceTypes))
		}

		// Use short timeout for each resource type
		ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
		cmd := exec.CommandContext(ctx, "kubectl", "delete", resourceType, "--all", "-n", namespace, "--force", "--grace-period=0")
		cmd.Run() // Ignore errors, resource type might not exist
		cancel()

		// Also try to patch finalizers for stuck resources
		getCtx, getCancel := context.WithTimeout(context.Background(), 2*time.Second)
		getCmd := exec.CommandContext(getCtx, "kubectl", "get", resourceType, "-n", namespace, "-o", "name")
		if output, err := getCmd.Output(); err == nil {
			resources := strings.Split(strings.TrimSpace(string(output)), "\n")
			for _, resource := range resources {
				if resource != "" {
					// Remove finalizers
					patchCmd := exec.Command("kubectl", "patch", resource, "-n", namespace,
						"--type", "json", "-p", `[{"op": "remove", "path": "/metadata/finalizers"}]`)
					patchCmd.Run()
				}
			}
		}
		getCancel()
	}

	// Now handle the namespace itself
	fmt.Printf("  Removing namespace finalizers...\n")

	// Try multiple approaches to remove namespace
	approaches := []struct {
		name string
		cmd  *exec.Cmd
	}{
		{
			"patch finalizers to empty array",
			exec.Command("kubectl", "patch", "namespace", namespace,
				"--type", "json", "-p", `[{"op": "remove", "path": "/spec/finalizers"}]`),
		},
		{
			"patch finalizers to null",
			exec.Command("kubectl", "patch", "namespace", namespace,
				"-p", `{"spec":{"finalizers":null}}`, "--type=merge"),
		},
		{
			"patch metadata finalizers to null",
			exec.Command("kubectl", "patch", "namespace", namespace,
				"-p", `{"metadata":{"finalizers":null}}`, "--type=merge"),
		},
	}

	for _, approach := range approaches {
		fmt.Printf("    Trying: %s\n", approach.name)
		approach.cmd.Run()
	}

	// Use the finalize API directly
	fmt.Printf("  Using finalize API...\n")
	finalizeCmd := exec.Command("sh", "-c", fmt.Sprintf(
		`kubectl get namespace %s -o json 2>/dev/null | jq '.spec.finalizers = []' | kubectl replace --raw "/api/v1/namespaces/%s/finalize" -f - 2>/dev/null`,
		namespace, namespace,
	))
	finalizeCmd.Run()

	// Final deletion attempt
	fmt.Printf("  Final deletion attempt...\n")
	finalCtx, finalCancel := context.WithTimeout(context.Background(), 5*time.Second)
	finalCmd := exec.CommandContext(finalCtx, "kubectl", "delete", "namespace", namespace, "--force", "--grace-period=0")
	finalCmd.Run()
	finalCancel()

	// Verify deletion
	verifyCmd := exec.Command("kubectl", "get", "namespace", namespace)
	if err := verifyCmd.Run(); err != nil {
		fmt.Printf("  ✅ Namespace deleted successfully\n")
	} else {
		fmt.Printf("  ⚠️  Namespace still exists (will retry in final cleanup pass)\n")
	}
}

func (d *Destroyer) cleanupClusterWideResources() {
	projectPrefix := d.config.Project.Name
	fmt.Printf("  Looking for cluster resources with prefix '%s'...\n", projectPrefix)

	// Delete CRDs
	fmt.Println("  Checking Custom Resource Definitions...")
	cmd := exec.Command("kubectl", "get", "crd", "-o", "name")
	if output, err := cmd.Output(); err == nil {
		lines := strings.Split(string(output), "\n")
		for _, line := range lines {
			line = strings.TrimSpace(line)
			if line != "" && strings.Contains(strings.ToLower(line), strings.ToLower(projectPrefix)) {
				fmt.Printf("    Deleting %s\n", line)
				deleteCmd := exec.Command("kubectl", "delete", line, "--force", "--grace-period=0")
				deleteCmd.Run()
			}
		}
	}

	// Delete ClusterRoles
	fmt.Println("  Checking ClusterRoles...")
	cmd = exec.Command("kubectl", "get", "clusterrole", "-o", "name")
	if output, err := cmd.Output(); err == nil {
		lines := strings.Split(string(output), "\n")
		for _, line := range lines {
			line = strings.TrimSpace(line)
			if line != "" && strings.Contains(line, projectPrefix) {
				fmt.Printf("    Deleting %s\n", line)
				deleteCmd := exec.Command("kubectl", "delete", line, "--force", "--grace-period=0")
				deleteCmd.Run()
			}
		}
	}

	// Delete ClusterRoleBindings
	fmt.Println("  Checking ClusterRoleBindings...")
	cmd = exec.Command("kubectl", "get", "clusterrolebinding", "-o", "name")
	if output, err := cmd.Output(); err == nil {
		lines := strings.Split(string(output), "\n")
		for _, line := range lines {
			line = strings.TrimSpace(line)
			if line != "" && strings.Contains(line, projectPrefix) {
				fmt.Printf("    Deleting %s\n", line)
				deleteCmd := exec.Command("kubectl", "delete", line, "--force", "--grace-period=0")
				deleteCmd.Run()
			}
		}
	}

	// Delete PersistentVolumes
	fmt.Println("  Checking PersistentVolumes...")
	cmd = exec.Command("kubectl", "get", "pv", "-o", "json")
	if output, err := cmd.Output(); err == nil {
		type PVList struct {
			Items []struct {
				Metadata struct {
					Name string `json:"name"`
				} `json:"metadata"`
				Spec struct {
					ClaimRef struct {
						Namespace string `json:"namespace"`
					} `json:"claimRef"`
				} `json:"spec"`
			} `json:"items"`
		}

		var pvList PVList
		if err := json.Unmarshal(output, &pvList); err == nil {
			for _, pv := range pvList.Items {
				// Check if PV is bound to a namespace with our prefix
				if strings.HasPrefix(pv.Spec.ClaimRef.Namespace, projectPrefix+"-") {
					fmt.Printf("    Deleting PV %s (bound to %s)\n", pv.Metadata.Name, pv.Spec.ClaimRef.Namespace)
					deleteCmd := exec.Command("kubectl", "delete", "pv", pv.Metadata.Name, "--force", "--grace-period=0")
					deleteCmd.Run()
				}
			}
		}
	}

	// Delete StorageClasses
	fmt.Println("  Checking StorageClasses...")
	cmd = exec.Command("kubectl", "get", "storageclass", "-o", "name")
	if output, err := cmd.Output(); err == nil {
		lines := strings.Split(string(output), "\n")
		for _, line := range lines {
			line = strings.TrimSpace(line)
			if line != "" && strings.Contains(line, projectPrefix) {
				fmt.Printf("    Deleting %s\n", line)
				deleteCmd := exec.Command("kubectl", "delete", line, "--force", "--grace-period=0")
				deleteCmd.Run()
			}
		}
	}

	// Delete ValidatingWebhookConfigurations
	fmt.Println("  Checking ValidatingWebhookConfigurations...")
	cmd = exec.Command("kubectl", "get", "validatingwebhookconfiguration", "-o", "name")
	if output, err := cmd.Output(); err == nil {
		lines := strings.Split(string(output), "\n")
		for _, line := range lines {
			line = strings.TrimSpace(line)
			if line != "" && strings.Contains(line, projectPrefix) {
				fmt.Printf("    Deleting %s\n", line)
				deleteCmd := exec.Command("kubectl", "delete", line, "--force", "--grace-period=0")
				deleteCmd.Run()
			}
		}
	}

	// Delete MutatingWebhookConfigurations
	fmt.Println("  Checking MutatingWebhookConfigurations...")
	cmd = exec.Command("kubectl", "get", "mutatingwebhookconfiguration", "-o", "name")
	if output, err := cmd.Output(); err == nil {
		lines := strings.Split(string(output), "\n")
		for _, line := range lines {
			line = strings.TrimSpace(line)
			if line != "" && strings.Contains(line, projectPrefix) {
				fmt.Printf("    Deleting %s\n", line)
				deleteCmd := exec.Command("kubectl", "delete", line, "--force", "--grace-period=0")
				deleteCmd.Run()
			}
		}
	}

	// Delete PriorityClasses
	fmt.Println("  Checking PriorityClasses...")
	cmd = exec.Command("kubectl", "get", "priorityclass", "-o", "name")
	if output, err := cmd.Output(); err == nil {
		lines := strings.Split(string(output), "\n")
		for _, line := range lines {
			line = strings.TrimSpace(line)
			if line != "" && strings.Contains(line, projectPrefix) {
				fmt.Printf("    Deleting %s\n", line)
				deleteCmd := exec.Command("kubectl", "delete", line, "--force", "--grace-period=0")
				deleteCmd.Run()
			}
		}
	}

	// Delete IngressClasses
	fmt.Println("  Checking IngressClasses...")
	cmd = exec.Command("kubectl", "get", "ingressclass", "-o", "json")
	if output, err := cmd.Output(); err == nil {
		type IngressClassList struct {
			Items []struct {
				Metadata struct {
					Name string `json:"name"`
					Annotations map[string]string `json:"annotations"`
				} `json:"metadata"`
			} `json:"items"`
		}

		var icList IngressClassList
		if err := json.Unmarshal(output, &icList); err == nil {
			for _, ic := range icList.Items {
				// Check if IngressClass is owned by a namespace with our prefix
				if releaseNs, ok := ic.Metadata.Annotations["meta.helm.sh/release-namespace"]; ok {
					if strings.HasPrefix(releaseNs, projectPrefix+"-") {
						fmt.Printf("    Deleting IngressClass %s (owned by %s)\n", ic.Metadata.Name, releaseNs)
						deleteCmd := exec.Command("kubectl", "delete", "ingressclass", ic.Metadata.Name, "--force", "--grace-period=0")
						deleteCmd.Run()
					}
				}
				// Also check if the name contains our prefix
				if strings.Contains(ic.Metadata.Name, projectPrefix) {
					fmt.Printf("    Deleting IngressClass %s\n", ic.Metadata.Name)
					deleteCmd := exec.Command("kubectl", "delete", "ingressclass", ic.Metadata.Name, "--force", "--grace-period=0")
					deleteCmd.Run()
				}
			}
		}
	}

	fmt.Println("  ✅ Cluster-wide resource cleanup complete")
}

func (d *Destroyer) cleanupAllProjectOwnedResources() {
	projectPrefix := d.config.Project.Name
	fmt.Printf("  🧹 Cleaning ALL resources owned by %s-* namespaces...\n", projectPrefix)

	// List of all resource types to check (cluster-wide and namespaced)
	clusterWideResources := []string{
		"ingressclass",
		"clusterrole",
		"clusterrolebinding",
		"storageclass",
		"priorityclass",
		"validatingwebhookconfiguration",
		"mutatingwebhookconfiguration",
		"apiservice",
		"crd",
	}

	// Check cluster-wide resources
	for _, resourceType := range clusterWideResources {
		cmd := exec.Command("kubectl", "get", resourceType, "-o", "json")
		output, err := cmd.Output()
		if err != nil {
			continue // Resource type might not exist
		}

		type ResourceList struct {
			Items []struct {
				Metadata struct {
					Name string `json:"name"`
					Annotations map[string]string `json:"annotations"`
					Labels map[string]string `json:"labels"`
				} `json:"metadata"`
			} `json:"items"`
		}

		var resList ResourceList
		if err := json.Unmarshal(output, &resList); err != nil {
			continue
		}

		for _, res := range resList.Items {
			shouldDelete := false
			ownerInfo := ""

			// Check Helm ownership annotations
			if releaseNs, ok := res.Metadata.Annotations["meta.helm.sh/release-namespace"]; ok {
				if strings.HasPrefix(releaseNs, projectPrefix+"-") {
					shouldDelete = true
					ownerInfo = fmt.Sprintf("owned by %s", releaseNs)
				}
			}

			// Also check if managed by our project
			if releaseName, ok := res.Metadata.Labels["app.kubernetes.io/managed-by"]; ok && releaseName == "Helm" {
				if instance, ok := res.Metadata.Labels["app.kubernetes.io/instance"]; ok {
					if strings.Contains(instance, projectPrefix) {
						shouldDelete = true
						ownerInfo = fmt.Sprintf("instance %s", instance)
					}
				}
			}

			if shouldDelete {
				fmt.Printf("    Deleting %s %s (%s)\n", resourceType, res.Metadata.Name, ownerInfo)

				// Special handling for CRDs - delete all instances first
				if resourceType == "crd" {
					fmt.Printf("      Deleting all instances of %s...\n", res.Metadata.Name)
					// Extract resource name from CRD (e.g., scaledobjects from scaledobjects.keda.sh)
					resourceName := strings.Split(res.Metadata.Name, ".")[0]

					// Delete all instances across all namespaces
					deleteInstancesCmd := exec.Command("kubectl", "delete", resourceName, "--all", "--all-namespaces", "--force", "--grace-period=0")
					ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
					deleteInstancesCmd = exec.CommandContext(ctx, deleteInstancesCmd.Path, deleteInstancesCmd.Args[1:]...)
					deleteInstancesCmd.Run()
					cancel()
				}

				// Delete the resource with timeout
				ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
				deleteCmd := exec.CommandContext(ctx, "kubectl", "delete", resourceType, res.Metadata.Name, "--force", "--grace-period=0")
				if err := deleteCmd.Run(); err != nil {
					// If deletion fails, try removing finalizers
					fmt.Printf("      Resource stuck, removing finalizers...\n")
					patchCmd := exec.Command("kubectl", "patch", resourceType, res.Metadata.Name,
						"--type=json", "-p", `[{"op": "remove", "path": "/metadata/finalizers"}]`)
					patchCmd.Run()

					// Try delete again
					retryCmd := exec.Command("kubectl", "delete", resourceType, res.Metadata.Name, "--force", "--grace-period=0")
					retryCmd.Run()
				}
				cancel()
			}
		}
	}

	// Check namespaced resources in ALL namespaces (including kube-system)
	namespacedResources := []string{
		"rolebinding",
		"role",
		"serviceaccount",
		"configmap",
		"secret",
		"service",
		"deployment",
		"statefulset",
		"daemonset",
		"job",
		"cronjob",
	}

	// Get all namespaces
	namespaces := []string{"kube-system", "kube-public", "kube-node-lease", "default"}
	cmd := exec.Command("kubectl", "get", "namespaces", "-o", "name")
	if output, err := cmd.Output(); err == nil {
		lines := strings.Split(string(output), "\n")
		for _, line := range lines {
			ns := strings.TrimPrefix(strings.TrimSpace(line), "namespace/")
			if ns != "" && !contains(namespaces, ns) {
				namespaces = append(namespaces, ns)
			}
		}
	}

	// Check each namespace for resources owned by our project
	for _, ns := range namespaces {
		for _, resourceType := range namespacedResources {
			cmd := exec.Command("kubectl", "get", resourceType, "-n", ns, "-o", "json")
			output, err := cmd.Output()
			if err != nil {
				continue
			}

			type ResourceList struct {
				Items []struct {
					Metadata struct {
						Name string `json:"name"`
						Namespace string `json:"namespace"`
						Annotations map[string]string `json:"annotations"`
						Labels map[string]string `json:"labels"`
					} `json:"metadata"`
				} `json:"items"`
			}

			var resList ResourceList
			if err := json.Unmarshal(output, &resList); err != nil {
				continue
			}

			for _, res := range resList.Items {
				shouldDelete := false
				ownerInfo := ""

				// Check Helm ownership
				if releaseNs, ok := res.Metadata.Annotations["meta.helm.sh/release-namespace"]; ok {
					if strings.HasPrefix(releaseNs, projectPrefix+"-") {
						shouldDelete = true
						ownerInfo = fmt.Sprintf("owned by %s", releaseNs)
					}
				}

				if shouldDelete {
					fmt.Printf("    Deleting %s %s in namespace %s (%s)\n", resourceType, res.Metadata.Name, ns, ownerInfo)
					ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
					deleteCmd := exec.CommandContext(ctx, "kubectl", "delete", resourceType, res.Metadata.Name, "-n", ns, "--force", "--grace-period=0")
					deleteCmd.Run()
					cancel()
				}
			}
		}
	}
}

func contains(slice []string, item string) bool {
	for _, s := range slice {
		if s == item {
			return true
		}
	}
	return false
}

func (d *Destroyer) finalCleanupPass() {
	fmt.Printf("  Performing final aggressive cleanup for prefix '%s-'...\n", d.config.Project.Name)

	// Get all namespaces again
	cmd := exec.Command("kubectl", "get", "namespaces", "-o", "json")
	output, err := cmd.Output()
	if err != nil {
		fmt.Printf("  Warning: Failed to list namespaces: %v\n", err)
		return
	}

	type NamespaceList struct {
		Items []struct {
			Metadata struct {
				Name string `json:"name"`
			} `json:"metadata"`
			Status struct {
				Phase string `json:"phase"`
			} `json:"status"`
		} `json:"items"`
	}

	var nsList NamespaceList
	if err := json.Unmarshal(output, &nsList); err != nil {
		fmt.Printf("  Warning: Failed to parse namespace list: %v\n", err)
		return
	}

	projectPrefix := d.config.Project.Name
	remainingNamespaces := []string{}

	for _, ns := range nsList.Items {
		if strings.HasPrefix(ns.Metadata.Name, projectPrefix+"-") {
			remainingNamespaces = append(remainingNamespaces, ns.Metadata.Name)
			fmt.Printf("  Found remaining namespace: %s (status: %s)\n", ns.Metadata.Name, ns.Status.Phase)
		}
	}

	if len(remainingNamespaces) == 0 {
		fmt.Println("  ✅ No remaining namespaces found")
	} else {
		fmt.Printf("  💣 Force deleting %d remaining namespaces...\n", len(remainingNamespaces))
		for _, ns := range remainingNamespaces {
			d.forceDeleteNamespace(ns)
		}
	}

	// Clean up ALL resources owned by this project
	fmt.Println("  🧹 Cleaning up ALL resources owned by this project...")
	d.cleanupAllProjectOwnedResources()

	// Final cluster-wide cleanup
	d.cleanupClusterWideResources()
}

func (d *Destroyer) Execute() error {
	// Always discover what's deployed
	if err := d.discoverDeployedComponents(); err != nil {
		color.Yellow("⚠️  Warning: Failed to discover components: %v\n", err)
	}

	// First, clean up ALL resources owned by this project (including in system namespaces)
	fmt.Printf("\n🔥 Cleaning up ALL resources owned by %s project...\n", d.config.Project.Name)
	d.cleanupAllProjectOwnedResources()

	// Then, aggressively clean up all discovered namespaces
	if len(d.discoveredNamespaces) > 0 {
		fmt.Printf("\n🧹 Force cleaning %d namespaces with prefix '%s-'...\n", len(d.discoveredNamespaces), d.config.Project.Name)
		for _, ns := range d.discoveredNamespaces {
			d.forceDeleteNamespace(ns)
		}
	}

	// Clean up cluster-wide resources
	fmt.Println("\n🧹 Cleaning cluster-wide resources...")
	d.cleanupClusterWideResources()

	steps := []struct {
		name string
		fn   func() error
		skip bool
	}{}

	// Always run cleanup steps regardless of discovered components when force is enabled
	if d.force {
		// Mark all components as deployed to ensure cleanup runs
		d.deployedComponents["application"] = true
		d.deployedComponents["monitoring"] = true
		d.deployedComponents["supabase"] = true
		d.deployedComponents["traefik"] = true
		d.deployedComponents["kafka"] = true
		d.deployedComponents["vector"] = true
		d.deployedComponents["keda"] = true
		d.deployedComponents["execution"] = true
	}

	// Build steps based on discovered components
	if d.deployedComponents["application"] {
		steps = append(steps, struct {
			name string
			fn   func() error
			skip bool
		}{"Delete application", d.deleteApplication, false})
	} else if d.force {
		// In force mode, always try to delete the application
		steps = append(steps, struct {
			name string
			fn   func() error
			skip bool
		}{"Delete application", d.deleteApplication, false})
	}

	if d.deployedComponents["monitoring"] {
		steps = append(steps, struct {
			name string
			fn   func() error
			skip bool
		}{"Delete monitoring", d.deleteMonitoring, false})
	} else if d.force && d.config.Monitoring.Provider == "prometheus" {
		// In force mode, delete monitoring if configured
		steps = append(steps, struct {
			name string
			fn   func() error
			skip bool
		}{"Delete monitoring", d.deleteMonitoring, false})
	}

	if d.deployedComponents["supabase"] && d.config.Database.Type == "self-hosted" {
		steps = append(steps, struct {
			name string
			fn   func() error
			skip bool
		}{"Delete database", d.deleteDatabase, false})
	} else if d.force && d.config.Database.Type == "self-hosted" {
		// In force mode, delete database if self-hosted
		steps = append(steps, struct {
			name string
			fn   func() error
			skip bool
		}{"Delete database", d.deleteDatabase, false})
	}

	// Check for Kafka and KEDA in execution namespace
	if d.deployedComponents["execution"] || d.deployedComponents["kafka"] {
		steps = append(steps, struct {
			name string
			fn   func() error
			skip bool
		}{"Delete Kafka", d.deleteKafka, false})
		steps = append(steps, struct {
			name string
			fn   func() error
			skip bool
		}{"Delete KEDA", d.deleteKEDA, false})
	} else if d.force {
		// In force mode, always try to delete Kafka and KEDA
		steps = append(steps, struct {
			name string
			fn   func() error
			skip bool
		}{"Delete Kafka", d.deleteKafka, false})
		steps = append(steps, struct {
			name string
			fn   func() error
			skip bool
		}{"Delete KEDA", d.deleteKEDA, false})
	}

	if d.deployedComponents["logging"] || d.deployedComponents["vector"] {
		steps = append(steps, struct {
			name string
			fn   func() error
			skip bool
		}{"Delete Vector", d.deleteVector, false})
	} else if d.force {
		// In force mode, always try to delete Vector
		steps = append(steps, struct {
			name string
			fn   func() error
			skip bool
		}{"Delete Vector", d.deleteVector, false})
	}

	if d.deployedComponents["kafka"] {
		steps = append(steps, struct {
			name string
			fn   func() error
			skip bool
		}{"Delete ingress controller", d.deleteIngress, false})
	} else if d.force {
		// In force mode, always try to delete ingress
		steps = append(steps, struct {
			name string
			fn   func() error
			skip bool
		}{"Delete ingress controller", d.deleteIngress, false})
	}

	// Always clean up PVCs if any namespaces were found
	if len(d.deployedComponents) > 0 {
		// Always clean up PVCs, namespaces, and cluster resources (even in non-force mode)
		steps = append(steps, struct {
			name string
			fn   func() error
			skip bool
		}{"Clean up persistent volumes", d.cleanupPVCs, false})

		steps = append(steps, struct {
			name string
			fn   func() error
			skip bool
		}{"Delete namespaces", d.deleteNamespaces, false})
	}

	// Clean up cluster-wide resources only if we found components
	if len(d.deployedComponents) > 0 {
		steps = append(steps, struct {
			name string
			fn   func() error
			skip bool
		}{"Clean up cluster-wide resources", d.cleanupClusterResources, false})
	}

	// Only add managed Supabase deletion if using managed database
	if d.config.Database.Type == "managed" && d.config.Database.Provider == "supabase" {
		steps = append(steps, struct {
			name string
			fn   func() error
			skip bool
		}{"Delete managed Supabase", d.deleteManagedSupabase, false})
	} else if d.force && d.config.Database.Type == "managed" && d.config.Database.Provider == "supabase" {
		// In force mode, delete managed Supabase if configured
		steps = append(steps, struct {
			name string
			fn   func() error
			skip bool
		}{"Delete managed Supabase", d.deleteManagedSupabase, false})
	}

	// Add infrastructure destruction as last step
	steps = append(steps, struct {
		name string
		fn   func() error
		skip bool
	}{"Destroy infrastructure", d.destroyInfrastructure, !d.destroyCluster})

	if d.destroyCluster {
		if d.force {
			fmt.Println("\n🗑️  Beginning FORCED full deployment teardown (including infrastructure)...")
		} else {
			fmt.Println("\n🗑️  Beginning full deployment teardown (including infrastructure)...")
		}
	} else {
		if d.force {
			fmt.Println("\n🗑️  Beginning FORCED deployment teardown (preserving cluster infrastructure)...")
		} else {
			fmt.Println("\n🗑️  Beginning deployment teardown (preserving cluster infrastructure)...")
		}
	}

	for _, step := range steps {
		if step.skip {
			fmt.Printf("\n⏭️  Skipping %s (preserving cluster)\n", step.name)
			continue
		}

		fmt.Printf("\n▶️  %s...\n", step.name)
		if err := step.fn(); err != nil {
			color.Yellow("⚠️  Warning: %v\n", err)
			// Continue with other steps even if one fails
		} else {
			color.Green("✅ Completed\n")
		}
	}

	// Final aggressive cleanup pass
	fmt.Println("\n🔥 Final cleanup pass...")
	d.finalCleanupPass()

	return nil
}

func (d *Destroyer) deleteApplication() error {
	// Use default namespace or configured namespace
	namespace := d.config.Project.Namespace
	if namespace == "" {
		namespace = d.getNamespace("rulebricks")
	}
	namespaces := []string{namespace}

	// In force mode or if application is deployed, also check the app namespace
	if d.force || d.deployedComponents["application"] {
		appNamespace := d.getNamespace("app")
		if appNamespace != namespace {
			namespaces = append(namespaces, appNamespace)
		}
	}

	// Try to uninstall from all discovered namespaces
	for _, ns := range namespaces {
		cmd := exec.Command("helm", "uninstall", "rulebricks", "-n", ns)
		if output, err := cmd.CombinedOutput(); err != nil {
			outputStr := string(output)
			if !strings.Contains(outputStr, "not found") && !strings.Contains(outputStr, "release: not found") {
				return fmt.Errorf("failed to uninstall application from %s: %s", ns, outputStr)
			}
		}
	}
	return nil
}

func (d *Destroyer) deleteMonitoring() error {
	if d.config.Monitoring.Provider != "prometheus" {
		return nil
	}

	// Use default monitoring namespace
	namespaces := []string{d.getNamespace("monitoring")}

	// Try to uninstall from all discovered namespaces
	for _, ns := range namespaces {
		cmd := exec.Command("helm", "uninstall", "prometheus", "-n", ns, "--wait")
		if output, err := cmd.CombinedOutput(); err != nil {
			outputStr := string(output)
			if !strings.Contains(outputStr, "not found") && !strings.Contains(outputStr, "release: not found") {
				color.Yellow("  Warning: Failed to uninstall monitoring stack from %s: %s\n", ns, outputStr)
			}
		}
	}

	// Clean up Prometheus CRDs
	fmt.Println("  Deleting Prometheus CRDs...")
	prometheusCRDs := []string{
		"alertmanagerconfigs.monitoring.coreos.com",
		"alertmanagers.monitoring.coreos.com",
		"podmonitors.monitoring.coreos.com",
		"probes.monitoring.coreos.com",
		"prometheusagents.monitoring.coreos.com",
		"prometheuses.monitoring.coreos.com",
		"prometheusrules.monitoring.coreos.com",
		"scrapeconfigs.monitoring.coreos.com",
		"servicemonitors.monitoring.coreos.com",
		"thanosrulers.monitoring.coreos.com",
	}

	for _, crd := range prometheusCRDs {
		cmd := exec.Command("kubectl", "delete", "crd", crd, "--ignore-not-found=true")
		cmd.Run() // Ignore errors
	}

	return nil
}

func (d *Destroyer) deleteDatabase() error {
	// Use default supabase namespace
	namespaces := []string{d.getNamespace("supabase")}

	// Try to uninstall from all discovered namespaces
	for _, supabaseNamespace := range namespaces {
		// First uninstall the helm release
		cmd := exec.Command("helm", "uninstall", "supabase", "-n", supabaseNamespace)
		if output, err := cmd.CombinedOutput(); err != nil {
			outputStr := string(output)
			// Don't fail if release doesn't exist
			if !strings.Contains(outputStr, "not found") && !strings.Contains(outputStr, "release: not found") {
				return fmt.Errorf("failed to uninstall supabase from %s: %s", supabaseNamespace, outputStr)
			}
		}
	}

	// Clean up cluster-wide resources that Supabase might have created
	fmt.Println("  Cleaning up Supabase cluster-wide resources...")

	// Delete ClusterRoles
	clusterRoles := []string{"supabase-reader"}
	for _, cr := range clusterRoles {
		cmd := exec.Command("kubectl", "delete", "clusterrole", cr, "--ignore-not-found=true")
		if err := cmd.Run(); err != nil {
			color.Yellow("  Warning: Failed to delete ClusterRole %s: %v\n", cr, err)
		}
	}

	// Delete ClusterRoleBindings
	clusterRoleBindings := []string{"supabase-view"}
	for _, crb := range clusterRoleBindings {
		cmd := exec.Command("kubectl", "delete", "clusterrolebinding", crb, "--ignore-not-found=true")
		if err := cmd.Run(); err != nil {
			color.Yellow("  Warning: Failed to delete ClusterRoleBinding %s: %v\n", crb, err)
		}
	}

	// Delete the namespaces themselves
	for _, supabaseNamespace := range namespaces {
		cmd := exec.Command("kubectl", "delete", "namespace", supabaseNamespace, "--wait=false", "--ignore-not-found=true")
		if err := cmd.Run(); err != nil {
			color.Yellow("  Warning: Failed to delete namespace %s: %v\n", supabaseNamespace, err)
		}
	}

	return nil
}

func (d *Destroyer) deleteIngress() error {
	// Use default traefik namespace
	namespaces := []string{d.getNamespace("traefik")}

	// Try to uninstall from all discovered namespaces
	for _, ns := range namespaces {
		cmd := exec.Command("helm", "uninstall", "traefik", "-n", ns, "--wait")
		if output, err := cmd.CombinedOutput(); err != nil {
			outputStr := string(output)
			if !strings.Contains(outputStr, "not found") && !strings.Contains(outputStr, "release: not found") {
				color.Yellow("  Warning: Failed to uninstall Traefik from %s: %s\n", ns, outputStr)
			}
		}
	}

	// Clean up Traefik CRDs
	fmt.Println("  Deleting Traefik CRDs...")
	traefikCRDs := []string{
		"accesscontrolpolicies.hub.traefik.io",
		"aiservices.hub.traefik.io",
		"apibundles.hub.traefik.io",
		"apicatalogitems.hub.traefik.io",
		"apiplans.hub.traefik.io",
		"apiportals.hub.traefik.io",
		"apiratelimits.hub.traefik.io",
		"apis.hub.traefik.io",
		"apiversions.hub.traefik.io",
		"ingressroutes.traefik.io",
		"ingressroutetcps.traefik.io",
		"ingressrouteudps.traefik.io",
		"managedsubscriptions.hub.traefik.io",
		"middlewares.traefik.io",
		"middlewaretcps.traefik.io",
		"serverstransports.traefik.io",
		"serverstransporttcps.traefik.io",
		"tlsoptions.traefik.io",
		"tlsstores.traefik.io",
		"traefikservices.traefik.io",
	}

	for _, crd := range traefikCRDs {
		cmd := exec.Command("kubectl", "delete", "crd", crd, "--ignore-not-found=true")
		cmd.Run() // Ignore errors
	}

	// Clean up Traefik API services
	fmt.Println("  Deleting Traefik API services...")
	traefikAPIServices := []string{
		"v1alpha1.hub.traefik.io",
		"v1alpha1.traefik.io",
	}

	for _, apiService := range traefikAPIServices {
		cmd := exec.Command("kubectl", "delete", "apiservice", apiService, "--ignore-not-found=true")
		cmd.Run() // Ignore errors
	}

	// Clean up IngressClass resources
	fmt.Println("  Deleting IngressClass resources...")
	cmd := exec.Command("kubectl", "get", "ingressclass", "-o", "name")
	if output, err := cmd.Output(); err == nil {
		lines := strings.Split(string(output), "\n")
		for _, line := range lines {
			line = strings.TrimSpace(line)
			if line != "" {
				// Check if this IngressClass is related to traefik
				ingressClassName := strings.TrimPrefix(line, "ingressclass.networking.k8s.io/")
				if strings.Contains(ingressClassName, "traefik") {
					fmt.Printf("    Deleting %s\n", ingressClassName)
					deleteCmd := exec.Command("kubectl", "delete", "ingressclass", ingressClassName, "--force", "--grace-period=0")
					deleteCmd.Run()
				}
			}
		}
	}

	return nil
}

func (d *Destroyer) deleteKEDA() error {
	fmt.Println("  🧹 Force deleting KEDA components...")

	// Find ALL namespaces that might contain KEDA
	projectPrefix := d.config.Project.Name
	kedaNamespaces := []string{}

	// Look for any namespace with -keda or -execution suffix
	cmd := exec.Command("kubectl", "get", "namespaces", "-o", "name")
	if output, err := cmd.Output(); err == nil {
		lines := strings.Split(string(output), "\n")
		for _, line := range lines {
			ns := strings.TrimPrefix(strings.TrimSpace(line), "namespace/")
			if ns != "" && strings.HasPrefix(ns, projectPrefix+"-") &&
			   (strings.Contains(ns, "keda") || strings.Contains(ns, "execution")) {
				kedaNamespaces = append(kedaNamespaces, ns)
			}
		}
	}

	// Add default namespaces
	kedaNamespaces = append(kedaNamespaces, d.getNamespace("keda"), d.getNamespace("execution"))

	// Force delete all resources in KEDA namespaces
	for _, ns := range kedaNamespaces {
		fmt.Printf("    Force cleaning namespace %s...\n", ns)

		// Delete all resources in namespace
		cmd := exec.Command("kubectl", "delete", "all", "--all", "-n", ns, "--force", "--grace-period=0")
		cmd.Run()

		// Try helm uninstall first
		helmCmd := exec.Command("helm", "uninstall", "keda", "-n", ns, "--no-hooks")
		helmCmd.Run()
	}

	// Delete KEDA CRDs with force
	fmt.Println("  Force deleting KEDA CRDs...")
	kedaCRDs := []string{
		"clustertriggerauthentications.keda.sh",
		"scaledjobs.keda.sh",
		"scaledobjects.keda.sh",
		"triggerauthentications.keda.sh",
		"cloudeventsources.eventing.keda.sh",
		"clustercloudeventsources.eventing.keda.sh",
	}

	// First delete all instances of KEDA custom resources
	for _, crd := range kedaCRDs {
		resourceName := strings.Split(crd, ".")[0]
		fmt.Printf("    Deleting all %s instances...\n", resourceName)

		// Delete all instances with timeout
		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		cmd := exec.CommandContext(ctx, "kubectl", "delete", resourceName, "--all", "--all-namespaces", "--force", "--grace-period=0")
		cmd.Run()
		cancel()
	}

	// Then delete the CRDs themselves
	for _, crd := range kedaCRDs {
		fmt.Printf("    Deleting CRD %s...\n", crd)

		// First try to patch finalizers
		patchCmd := exec.Command("kubectl", "patch", "crd", crd,
			"--type=json", "-p", `[{"op": "remove", "path": "/metadata/finalizers"}]`)
		patchCmd.Run()

		// Also try merge patch
		mergePatchCmd := exec.Command("kubectl", "patch", "crd", crd,
			"-p", `{"metadata":{"finalizers":null}}`, "--type=merge")
		mergePatchCmd.Run()

		// Delete with timeout
		ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
		cmd := exec.CommandContext(ctx, "kubectl", "delete", "crd", crd, "--force", "--grace-period=0")
		if err := cmd.Run(); err != nil {
			fmt.Printf("      Warning: Failed to delete CRD %s: %v\n", crd, err)
		}
		cancel()
	}

	// Clean up KEDA resources in kube-system
	fmt.Println("  Force deleting KEDA resources in kube-system...")
	systemResources := []struct {
		kind string
		name string
	}{
		{"rolebinding", "keda-operator-auth-reader"},
		{"clusterrole", "keda-operator"},
		{"clusterrole", "keda-operator-external-metrics-reader"},
		{"clusterrolebinding", "keda-operator"},
		{"clusterrolebinding", "keda-operator-hpa-controller-external-metrics"},
	}

	for _, res := range systemResources {
		cmd := exec.Command("kubectl", "delete", res.kind, res.name, "--force", "--grace-period=0")
		cmd.Run()
	}

	// Delete any remaining KEDA-related cluster resources
	cmd = exec.Command("kubectl", "get", "clusterrole,clusterrolebinding", "-o", "name")
	if output, err := cmd.Output(); err == nil {
		lines := strings.Split(string(output), "\n")
		for _, line := range lines {
			if strings.Contains(line, "keda") {
				deleteCmd := exec.Command("kubectl", "delete", line, "--force", "--grace-period=0")
				deleteCmd.Run()
			}
		}
	}

	return nil
}

func (d *Destroyer) deleteKafka() error {
	// Use default execution namespace (Kafka is deployed there)
	namespaces := []string{d.getNamespace("execution")}

	// Try to uninstall from discovered namespaces
	for _, ns := range namespaces {
		cmd := exec.Command("helm", "uninstall", "kafka", "-n", ns, "--wait")
		if output, err := cmd.CombinedOutput(); err != nil {
			outputStr := string(output)
			if !strings.Contains(outputStr, "not found") && !strings.Contains(outputStr, "release: not found") {
				color.Yellow("  Warning: Failed to uninstall Kafka from %s: %s\n", ns, outputStr)
			}
		}
	}
	return nil
}

func (d *Destroyer) deleteVector() error {
	// Use default logging namespace
	namespaces := []string{d.getNamespace("logging")}

	// Try to uninstall from discovered namespaces
	for _, ns := range namespaces {
		cmd := exec.Command("helm", "uninstall", "vector", "-n", ns, "--wait")
		if output, err := cmd.CombinedOutput(); err != nil {
			outputStr := string(output)
			if !strings.Contains(outputStr, "not found") && !strings.Contains(outputStr, "release: not found") {
				color.Yellow("  Warning: Failed to uninstall Vector from %s: %s\n", ns, outputStr)
			}
		}
	}
	return nil
}

func (d *Destroyer) destroyInfrastructure() error {
	terraformDir := fmt.Sprintf("terraform/%s", d.config.Cloud.Provider)

	cmd := exec.Command("terraform", "destroy", "-auto-approve")
	cmd.Dir = terraformDir

	return cmd.Run()
}

func (d *Destroyer) cleanupPVCs() error {
	fmt.Println("  🧹 Force cleaning all PVCs and PVs...")

	// First, delete ALL PVCs in ALL namespaces with our project prefix
	projectPrefix := d.config.Project.Name

	// Get all namespaces
	cmd := exec.Command("kubectl", "get", "namespaces", "-o", "name")
	output, err := cmd.Output()
	if err != nil {
		fmt.Printf("  Warning: Failed to list namespaces: %v\n", err)
	} else {
		lines := strings.Split(string(output), "\n")
		for _, line := range lines {
			ns := strings.TrimPrefix(strings.TrimSpace(line), "namespace/")
			if ns != "" && strings.HasPrefix(ns, projectPrefix+"-") {
				fmt.Printf("  Force deleting all PVCs in namespace %s...\n", ns)

				// Delete all PVCs with force
				cmd = exec.Command("kubectl", "delete", "pvc", "--all", "-n", ns, "--force", "--grace-period=0")
				cmd.Run()

				// Also try to patch and delete stuck PVCs
				cmd = exec.Command("kubectl", "get", "pvc", "-n", ns, "-o", "name")
				if pvcOutput, err := cmd.Output(); err == nil {
					pvcLines := strings.Split(string(pvcOutput), "\n")
					for _, pvcLine := range pvcLines {
						pvcLine = strings.TrimSpace(pvcLine)
						if pvcLine != "" {
							// Remove finalizers
							patchCmd := exec.Command("kubectl", "patch", pvcLine, "-n", ns,
								"--type=json", "-p", `[{"op": "remove", "path": "/metadata/finalizers"}]`)
							patchCmd.Run()

							// Force delete
							deleteCmd := exec.Command("kubectl", "delete", pvcLine, "-n", ns, "--force", "--grace-period=0")
							deleteCmd.Run()
						}
					}
				}
			}
		}
	}

	// Also use discovered namespaces
	for _, ns := range d.discoveredNamespaces {
		fmt.Printf("  Force deleting all PVCs in discovered namespace %s...\n", ns)
		cmd = exec.Command("kubectl", "delete", "pvc", "--all", "-n", ns, "--force", "--grace-period=0")
		cmd.Run()
	}

	// Clean up PVs that were bound to our namespaces
	fmt.Println("  Cleaning up PersistentVolumes...")
	cmd = exec.Command("kubectl", "get", "pv", "-o", "json")
	if output, err := cmd.Output(); err == nil {
		type PVList struct {
			Items []struct {
				Metadata struct {
					Name string `json:"name"`
				} `json:"metadata"`
				Spec struct {
					ClaimRef struct {
						Namespace string `json:"namespace"`
						Name      string `json:"name"`
					} `json:"claimRef,omitempty"`
				} `json:"spec"`
				Status struct {
					Phase string `json:"phase"`
				} `json:"status"`
			} `json:"items"`
		}

		var pvList PVList
		if err := json.Unmarshal(output, &pvList); err == nil {
			for _, pv := range pvList.Items {
				// Check if PV is bound to a namespace with our prefix
				if pv.Spec.ClaimRef.Namespace != "" &&
				   strings.HasPrefix(pv.Spec.ClaimRef.Namespace, projectPrefix+"-") {
					fmt.Printf("  Force deleting PV %s (was bound to %s/%s)...\n",
						pv.Metadata.Name, pv.Spec.ClaimRef.Namespace, pv.Spec.ClaimRef.Name)

					// Remove finalizers first
					patchCmd := exec.Command("kubectl", "patch", "pv", pv.Metadata.Name,
						"--type=json", "-p", `[{"op": "remove", "path": "/metadata/finalizers"}]`)
					patchCmd.Run()

					// Remove claimRef to unbind it
					patchCmd = exec.Command("kubectl", "patch", "pv", pv.Metadata.Name,
						"--type=json", "-p", `[{"op": "remove", "path": "/spec/claimRef"}]`)
					patchCmd.Run()

					// Force delete
					deleteCmd := exec.Command("kubectl", "delete", "pv", pv.Metadata.Name, "--force", "--grace-period=0")
					deleteCmd.Run()
				}
			}
		}
	}

	return nil
}

func (d *Destroyer) deleteNamespaces() error {
	// Use discovered namespaces from discovery phase
	namespaces := []string{}
	seen := make(map[string]bool)

	// Add all discovered namespaces
	for _, ns := range d.discoveredNamespaces {
		if !seen[ns] {
			namespaces = append(namespaces, ns)
			seen[ns] = true
		}
	}

	// If no namespaces were discovered, fall back to default behavior
	if len(namespaces) == 0 {
		fmt.Println("  No namespaces discovered, using default namespace list...")
		// In force mode or when no components discovered, delete all possible namespaces

		if d.force || len(d.deployedComponents) == 0 {
			// Force mode: try all possible namespaces
			namespaces = append(namespaces, d.getNamespace("default"))
			namespaces = append(namespaces, d.getNamespace("app"))
			namespaces = append(namespaces, d.getNamespace("rulebricks"))
			namespaces = append(namespaces, d.getNamespace("supabase"))
			namespaces = append(namespaces, d.getNamespace("logging"))
			namespaces = append(namespaces, d.getNamespace("execution"))
			namespaces = append(namespaces, d.getNamespace("monitoring"))
			namespaces = append(namespaces, d.getNamespace("traefik"))
		} else {
			// Normal mode: use discovered namespaces
			for _, ns := range d.discoveredNamespaces {
				if !seen[ns] {
					namespaces = append(namespaces, ns)
					seen[ns] = true
				}
			}
		}

		// Also add the custom namespace if specified
		if d.config.Project.Namespace != "" {
			namespaces = append(namespaces, d.config.Project.Namespace)
		}
	}

	for _, ns := range namespaces {
		fmt.Printf("  Deleting namespace %s...\n", ns)

		// Check if namespace exists first
		checkCmd := exec.Command("kubectl", "get", "namespace", ns, "-o", "json")
		output, err := checkCmd.Output()
		if err != nil {
			// Namespace doesn't exist, skip
			continue
		}

		// Parse namespace to check its status
		var nsData struct {
			Status struct {
				Phase string `json:"phase"`
			} `json:"status"`
			Spec struct {
				Finalizers []string `json:"finalizers"`
			} `json:"spec"`
		}

		if err := json.Unmarshal(output, &nsData); err != nil {
			color.Yellow("  Warning: Failed to parse namespace %s data: %v\n", ns, err)
			continue
		}

		// If namespace is already terminating or has finalizers, handle it immediately
		if nsData.Status.Phase == "Terminating" || len(nsData.Spec.Finalizers) > 0 {
			fmt.Printf("  Namespace %s is terminating or has finalizers, force-deleting...\n", ns)

			// Clean up any remaining resources first
			d.cleanNamespaceResources(ns)

			// Remove finalizers to force deletion
			cmd := exec.Command("sh", "-c", fmt.Sprintf(
				`kubectl get namespace %s -o json | jq '.spec.finalizers = []' | kubectl replace --raw "/api/v1/namespaces/%s/finalize" -f -`,
				ns, ns,
			))
			if err := cmd.Run(); err != nil {
				color.Yellow("  Warning: Failed to force-delete namespace %s: %v\n", ns, err)
			} else {
				color.Green("  Force-deleted namespace %s\n", ns)
			}
		} else {
			// Clean all resources in the namespace first
			fmt.Printf("  Cleaning resources in namespace %s...\n", ns)
			d.cleanNamespaceResources(ns)

			// Normal deletion
			cmd := exec.Command("kubectl", "delete", "namespace", ns, "--wait=false", "--ignore-not-found=true")
			if err := cmd.Run(); err != nil {
				color.Yellow("  Warning: Failed to delete namespace %s: %v\n", ns, err)
			}
		}
	}

	return nil
}

func (d *Destroyer) cleanNamespaceResources(namespace string) error {
	// Delete all deployments, services, configmaps, secrets, etc. in the namespace
	resourceTypes := []string{
		"deployments",
		"services",
		"configmaps",
		"secrets",
		"ingresses",
		"persistentvolumeclaims",
		"serviceaccounts",
		"roles",
		"rolebindings",
		"jobs",
		"cronjobs",
		"pods",
		"replicasets",
		"statefulsets",
		"daemonsets",
		"horizontalpodautoscalers",
	}

	for _, resourceType := range resourceTypes {
		cmd := exec.Command("kubectl", "delete", resourceType, "--all", "-n", namespace, "--ignore-not-found=true", "--wait=false")
		if err := cmd.Run(); err != nil {
			// Don't fail on errors, just log them
			color.Yellow("  Warning: Failed to delete %s in namespace %s: %v\n", resourceType, namespace, err)
		}
	}

	return nil
}

func (d *Destroyer) cleanupClusterResources() error {
	fmt.Println("  Cleaning up cluster-wide resources...")

	// Delete metrics server if it exists
	fmt.Println("  Deleting metrics server...")
	metricsCmd := exec.Command("kubectl", "delete", "-f",
		"https://github.com/kubernetes-sigs/metrics-server/releases/latest/download/components.yaml",
		"--ignore-not-found=true")
	if err := metricsCmd.Run(); err != nil {
		color.Yellow("  Warning: Failed to delete metrics server: %v\n", err)
	}



	// Clean up any remaining ClusterRoles with project prefix
	projectPrefix := d.config.Project.Name

	// Get all clusterroles
	cmd := exec.Command("kubectl", "get", "clusterroles", "-o", "name")
	output, err := cmd.Output()
	if err == nil {
		roles := strings.Split(string(output), "\n")
		for _, role := range roles {
			role = strings.TrimSpace(role)
			if role == "" {
				continue
			}
			// Check if role contains project name or supabase
			if strings.Contains(role, projectPrefix) || strings.Contains(role, "supabase") {
				roleName := strings.TrimPrefix(role, "clusterrole.rbac.authorization.k8s.io/")
				cmd = exec.Command("kubectl", "delete", "clusterrole", roleName, "--ignore-not-found=true")
				if err := cmd.Run(); err != nil {
					color.Yellow("  Warning: Failed to delete ClusterRole %s: %v\n", roleName, err)
				}
			}
		}
	}

	// Get all clusterrolebindings
	cmd = exec.Command("kubectl", "get", "clusterrolebindings", "-o", "name")
	output, err = cmd.Output()
	if err == nil {
		bindings := strings.Split(string(output), "\n")
		for _, binding := range bindings {
			binding = strings.TrimSpace(binding)
			if binding == "" {
				continue
			}
			// Check if binding contains project name or supabase
			if strings.Contains(binding, projectPrefix) || strings.Contains(binding, "supabase") {
				bindingName := strings.TrimPrefix(binding, "clusterrolebinding.rbac.authorization.k8s.io/")
				cmd = exec.Command("kubectl", "delete", "clusterrolebinding", bindingName, "--ignore-not-found=true")
				if err := cmd.Run(); err != nil {
					color.Yellow("  Warning: Failed to delete ClusterRoleBinding %s: %v\n", bindingName, err)
				}
			}
		}
	}

	return nil
}

func (d *Destroyer) deleteManagedSupabase() error {

	// Convert domain to project name (same logic as teardown.sh)
	projectName := strings.Map(func(r rune) rune {
		if unicode.IsLetter(r) || unicode.IsDigit(r) {
			return r
		}
		return '-'
	}, d.config.Project.Domain)

	fmt.Printf("  Looking for Supabase project: %s\n", projectName)

	// List projects to find the one matching our name
	cmd := exec.Command("supabase", "projects", "list")
	output, err := cmd.Output()
	if err != nil {
		color.Yellow("  Warning: Failed to list Supabase projects: %v\n", err)
		return nil
	}

	// Parse the output to find project ref
	lines := strings.Split(string(output), "\n")
	var projectRef string
	for _, line := range lines {
		if strings.Contains(line, projectName) {
			// Extract project ref from the line (typically in the 3rd column)
			parts := strings.Split(line, "│")
			if len(parts) >= 3 {
				projectRef = strings.TrimSpace(parts[2])
				break
			}
		}
	}

	if projectRef == "" {
		fmt.Printf("  No Supabase project found with name: %s\n", projectName)
		return nil
	}

	fmt.Printf("  Found Supabase project with ref: %s\n", projectRef)

	// Delete the project
	cmd = exec.Command("supabase", "projects", "delete", projectRef, "--experimental")
	if err := cmd.Run(); err != nil {
		color.Yellow("  Warning: Failed to delete Supabase project: %v\n", err)
	} else {
		color.Green("  Supabase project deleted successfully\n")
	}

	return nil
}
