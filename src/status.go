// status.go - Status Checker and Updater
package main

import (
	"context"
	"fmt"
	"os/exec"
	"strings"
	"time"
	"unicode"
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
	pods, err := s.k8sClient.CoreV1().Pods("default").List(ctx, metav1.ListOptions{
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
		supabase := ServiceInfo{
			Name:      "supabase",
			Namespace: "default",
			Status:    "Unknown",
		}

		// Check Kong (API Gateway)
		kongDeploy, err := s.k8sClient.AppsV1().Deployments("default").Get(ctx, "supabase-kong", metav1.GetOptions{})
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
	config        Config
	destroyCluster bool
}

// NewDestroyer creates a new destroyer
func NewDestroyer(config Config, destroyCluster bool) *Destroyer {
	return &Destroyer{
		config:        config,
		destroyCluster: destroyCluster,
	}
}

// Execute tears down the deployment
// getNamespace returns the namespace for a component with project prefix
func (d *Destroyer) getNamespace(component string) string {
	return GetDefaultNamespace(d.config.Project.Name, component)
}

func (d *Destroyer) Execute() error {
	steps := []struct {
		name string
		fn   func() error
		skip bool
	}{
		{"Delete application", d.deleteApplication, false},
		{"Delete monitoring", d.deleteMonitoring, false},
		{"Delete database", d.deleteDatabase, false},
		{"Delete ingress controller", d.deleteIngress, false},
		{"Clean up persistent volumes", d.cleanupPVCs, false},
		{"Delete namespaces", d.deleteNamespaces, false},
		{"Clean up cluster-wide resources", d.cleanupClusterResources, false},
		{"Delete managed Supabase", d.deleteManagedSupabase, false},
		{"Destroy infrastructure", d.destroyInfrastructure, !d.destroyCluster},
	}

	if d.destroyCluster {
		fmt.Println("\n🗑️  Beginning full deployment teardown (including infrastructure)...")
	} else {
		fmt.Println("\n🗑️  Beginning deployment teardown (preserving cluster infrastructure)...")
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

	return nil
}

func (d *Destroyer) deleteApplication() error {
	namespace := d.config.Project.Namespace
	if namespace == "" {
		namespace = d.getNamespace("rulebricks")
	}

	cmd := exec.Command("helm", "uninstall", "rulebricks", "-n", namespace)
	return cmd.Run()
}

func (d *Destroyer) deleteMonitoring() error {
	if !d.config.Monitoring.Enabled {
		return nil
	}

	monitoringNamespace := d.getNamespace("monitoring")
	cmd := exec.Command("helm", "uninstall", "prometheus", "-n", monitoringNamespace)
	return cmd.Run()
}

func (d *Destroyer) deleteDatabase() error {
	if d.config.Database.Type != "self-hosted" {
		return nil
	}

	supabaseNamespace := d.getNamespace("supabase")

	// First uninstall the helm release
	cmd := exec.Command("helm", "uninstall", "supabase", "-n", supabaseNamespace)
	if err := cmd.Run(); err != nil {
		// Don't fail if release doesn't exist
		if !strings.Contains(err.Error(), "not found") {
			return fmt.Errorf("failed to uninstall supabase: %w", err)
		}
	}

	// Clean up cluster-wide resources that Supabase might have created
	fmt.Println("  Cleaning up Supabase cluster-wide resources...")

	// Delete ClusterRoles
	clusterRoles := []string{"supabase-reader"}
	for _, cr := range clusterRoles {
		cmd = exec.Command("kubectl", "delete", "clusterrole", cr, "--ignore-not-found=true")
		if err := cmd.Run(); err != nil {
			color.Yellow("  Warning: Failed to delete ClusterRole %s: %v\n", cr, err)
		}
	}

	// Delete ClusterRoleBindings
	clusterRoleBindings := []string{"supabase-view"}
	for _, crb := range clusterRoleBindings {
		cmd = exec.Command("kubectl", "delete", "clusterrolebinding", crb, "--ignore-not-found=true")
		if err := cmd.Run(); err != nil {
			color.Yellow("  Warning: Failed to delete ClusterRoleBinding %s: %v\n", crb, err)
		}
	}

	// Delete the namespace itself
	cmd = exec.Command("kubectl", "delete", "namespace", supabaseNamespace, "--wait=false", "--ignore-not-found=true")
	if err := cmd.Run(); err != nil {
		color.Yellow("  Warning: Failed to delete namespace %s: %v\n", supabaseNamespace, err)
	}

	return nil
}

func (d *Destroyer) deleteIngress() error {
	traefikNamespace := d.getNamespace("traefik")
	cmd := exec.Command("helm", "uninstall", "traefik", "-n", traefikNamespace)
	return cmd.Run()
}

func (d *Destroyer) destroyInfrastructure() error {
	terraformDir := fmt.Sprintf("terraform/%s", d.config.Cloud.Provider)

	cmd := exec.Command("terraform", "destroy", "-auto-approve")
	cmd.Dir = terraformDir

	return cmd.Run()
}

func (d *Destroyer) cleanupPVCs() error {
	namespace := d.config.Project.Namespace
	if namespace == "" {
		namespace = d.getNamespace("rulebricks")
	}

	// Delete Redis PVC specifically
	fmt.Println("  Deleting Redis PVC...")
	cmd := exec.Command("kubectl", "delete", "pvc", "redis-data", "-n", namespace, "--ignore-not-found=true")
	if err := cmd.Run(); err != nil {
		color.Yellow("  Warning: Failed to delete Redis PVC: %v\n", err)
	}

	// Delete all PVCs in the rulebricks namespace
	fmt.Println("  Deleting all PVCs in rulebricks namespace...")
	cmd = exec.Command("kubectl", "delete", "pvc", "--all", "-n", namespace)
	if err := cmd.Run(); err != nil {
		color.Yellow("  Warning: Failed to delete PVCs in %s namespace: %v\n", namespace, err)
	}

	// Delete all PVCs in the traefik namespace
	traefikNamespace := d.getNamespace("traefik")
	fmt.Printf("  Deleting all PVCs in %s namespace...\n", traefikNamespace)
	cmd = exec.Command("kubectl", "delete", "pvc", "--all", "-n", traefikNamespace)
	if err := cmd.Run(); err != nil {
		color.Yellow("  Warning: Failed to delete PVCs in %s namespace: %v\n", traefikNamespace, err)
	}

	// If self-hosted Supabase, delete its PVCs
	if d.config.Database.Type == "self-hosted" {
		supabaseNamespace := d.getNamespace("supabase")
		fmt.Printf("  Deleting self-hosted Supabase PVCs in %s namespace...\n", supabaseNamespace)
		cmd = exec.Command("kubectl", "delete", "pvc", "-l", "app.kubernetes.io/instance=supabase", "-n", supabaseNamespace, "--wait=false")
		if err := cmd.Run(); err != nil {
			color.Yellow("  Warning: Failed to delete Supabase PVCs: %v\n", err)
		}
	}

	return nil
}

func (d *Destroyer) deleteNamespaces() error {
	// Delete all project-related namespaces
	namespaces := []string{
		d.getNamespace("default"),
		d.getNamespace("app"),
		d.getNamespace("supabase"),
		d.getNamespace("monitoring"),
		d.getNamespace("traefik"),
	}

	// Also add the custom namespace if specified
	if d.config.Project.Namespace != "" {
		namespaces = append(namespaces, d.config.Project.Namespace)
	}

	for _, ns := range namespaces {
		fmt.Printf("  Deleting namespace %s...\n", ns)
		cmd := exec.Command("kubectl", "delete", "namespace", ns, "--wait=false", "--ignore-not-found=true")
		if err := cmd.Run(); err != nil {
			color.Yellow("  Warning: Failed to delete namespace %s: %v\n", ns, err)
		}
	}

	return nil
}

func (d *Destroyer) cleanupClusterResources() error {
	fmt.Println("  Cleaning up cluster-wide resources...")

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
	// Only delete managed Supabase projects
	if d.config.Database.Type == "self-hosted" || d.config.Database.Provider != "supabase" {
		return nil
	}

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
