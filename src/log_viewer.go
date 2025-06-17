// log_viewer.go - Log viewing functionality
package main

import (
	"bufio"
	"context"
	"fmt"
	"io"
	"strings"
	"time"
	"github.com/fatih/color"
	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/client-go/kubernetes"
	"k8s.io/client-go/tools/clientcmd"
)

// LogViewer handles log viewing operations
type LogViewer struct {
	config    Config
	k8sClient *kubernetes.Clientset
}

// NewLogViewer creates a new log viewer
func NewLogViewer(config Config) *LogViewer {
	return &LogViewer{config: config}
}

// ViewLogs displays logs for the specified component
func (l *LogViewer) ViewLogs(component string, follow bool, tail int) error {
	// Initialize Kubernetes client
	if err := l.initK8sClient(); err != nil {
		return fmt.Errorf("failed to connect to cluster: %w", err)
	}

	// Map component names to label selectors
	componentMap := map[string]componentInfo{
		"app": {
			namespace: l.getAppNamespace(),
			labels:    "app.kubernetes.io/name=rulebricks",
			container: "rulebricks",
		},
		"application": {
			namespace: l.getAppNamespace(),
			labels:    "app.kubernetes.io/name=rulebricks",
			container: "rulebricks",
		},
		"database": {
			namespace: "default",
			labels:    "app.kubernetes.io/name=supabase-db",
			container: "postgres",
		},
		"supabase": {
			namespace: "default",
			labels:    "app.kubernetes.io/instance=supabase",
			container: "",
		},
		"traefik": {
			namespace: GetDefaultNamespace(l.config.Project.Name, "traefik"),
			labels:    "app.kubernetes.io/name=traefik",
			container: "traefik",
		},
		"ingress": {
			namespace: GetDefaultNamespace(l.config.Project.Name, "traefik"),
			labels:    "app.kubernetes.io/name=traefik",
			container: "traefik",
		},
		"kong": {
			namespace: "default",
			labels:    "app=kong",
			container: "kong",
		},
		"auth": {
			namespace: "default",
			labels:    "app.kubernetes.io/name=supabase-auth",
			container: "gotrue",
		},
		"realtime": {
			namespace: "default",
			labels:    "app.kubernetes.io/name=supabase-realtime",
			container: "realtime",
		},
		"storage": {
			namespace: "default",
			labels:    "app.kubernetes.io/name=supabase-storage",
			container: "storage",
		},
		"prometheus": {
			namespace: "monitoring",
			labels:    "app.kubernetes.io/name=prometheus",
			container: "prometheus",
		},
		"grafana": {
			namespace: "monitoring",
			labels:    "app.kubernetes.io/name=grafana",
			container: "grafana",
		},
		"all": {
			namespace: "",
			labels:    "",
			container: "",
		},
	}

	// Handle 'all' component
	if component == "all" {
		return l.viewAllLogs(componentMap, follow, tail)
	}

	// Get component info
	info, exists := componentMap[strings.ToLower(component)]
	if !exists {
		return fmt.Errorf("unknown component: %s\nAvailable components: %s",
			component, strings.Join(getComponentNames(componentMap), ", "))
	}

	// Get pods for component
	pods, err := l.getPodsForComponent(info)
	if err != nil {
		return fmt.Errorf("failed to get pods for %s: %w", component, err)
	}

	if len(pods) == 0 {
		return fmt.Errorf("no pods found for component: %s", component)
	}

	// Display logs
	color.Cyan("📋 Logs for %s\n", component)
	fmt.Println(strings.Repeat("-", 60))

	ctx := context.Background()

	for _, pod := range pods {
		if len(pods) > 1 {
			color.Yellow("\n→ Pod: %s\n", pod.Name)
		}

		containers := l.getContainersForPod(pod, info.container)

		for _, container := range containers {
			if len(containers) > 1 || (len(pods) == 1 && len(containers) > 1) {
				color.Magenta("  Container: %s\n", container)
			}

			opts := &corev1.PodLogOptions{
				Container: container,
				Follow:    follow,
			}

			if tail > 0 {
				tailLines := int64(tail)
				opts.TailLines = &tailLines
			}

			req := l.k8sClient.CoreV1().Pods(pod.Namespace).GetLogs(pod.Name, opts)
			stream, err := req.Stream(ctx)
			if err != nil {
				color.Red("  Error getting logs: %v\n", err)
				continue
			}

			l.streamLogs(stream, pod.Name, container, follow)
			stream.Close()
		}
	}

	return nil
}

// componentInfo holds information about a component
type componentInfo struct {
	namespace string
	labels    string
	container string
}

// initK8sClient initializes the Kubernetes client
func (l *LogViewer) initK8sClient() error {
	kubeconfig := clientcmd.NewDefaultClientConfigLoadingRules().GetDefaultFilename()

	config, err := clientcmd.BuildConfigFromFlags("", kubeconfig)
	if err != nil {
		return err
	}

	client, err := kubernetes.NewForConfig(config)
	if err != nil {
		return err
	}

	l.k8sClient = client
	return nil
}

// getAppNamespace returns the application namespace
func (l *LogViewer) getAppNamespace() string {
	if l.config.Project.Namespace != "" {
		return l.config.Project.Namespace
	}
	return GetDefaultNamespace(l.config.Project.Name, "rulebricks")
}

// getPodsForComponent returns pods matching the component
func (l *LogViewer) getPodsForComponent(info componentInfo) ([]corev1.Pod, error) {
	ctx := context.Background()

	pods, err := l.k8sClient.CoreV1().Pods(info.namespace).List(ctx, metav1.ListOptions{
		LabelSelector: info.labels,
	})
	if err != nil {
		return nil, err
	}

	// Filter running pods
	runningPods := []corev1.Pod{}
	for _, pod := range pods.Items {
		if pod.Status.Phase == corev1.PodRunning || pod.Status.Phase == corev1.PodPending {
			runningPods = append(runningPods, pod)
		}
	}

	return runningPods, nil
}

// getContainersForPod returns container names for a pod
func (l *LogViewer) getContainersForPod(pod corev1.Pod, preferredContainer string) []string {
	containers := []string{}

	// If a specific container is requested, use only that
	if preferredContainer != "" {
		for _, container := range pod.Spec.Containers {
			if container.Name == preferredContainer {
				return []string{preferredContainer}
			}
		}
	}

	// Otherwise, return all containers
	for _, container := range pod.Spec.Containers {
		containers = append(containers, container.Name)
	}

	return containers
}

// streamLogs streams logs from a container
func (l *LogViewer) streamLogs(stream io.ReadCloser, podName, containerName string, follow bool) {
	scanner := bufio.NewScanner(stream)

	prefix := ""
	if podName != "" {
		prefix = fmt.Sprintf("[%s] ", shortPodName(podName))
	}

	for scanner.Scan() {
		line := scanner.Text()

		// Add timestamp if not present
		if !startsWithTimestamp(line) {
			timestamp := time.Now().Format("2006-01-02T15:04:05.000Z")
			line = fmt.Sprintf("%s %s", timestamp, line)
		}

		// Colorize based on log level
		coloredLine := colorizeLine(line)

		fmt.Printf("%s%s\n", prefix, coloredLine)
	}

	if err := scanner.Err(); err != nil && err != io.EOF {
		color.Red("Error reading logs: %v\n", err)
	}
}

// viewAllLogs displays logs from all components
func (l *LogViewer) viewAllLogs(componentMap map[string]componentInfo, follow bool, tail int) error {
	color.Cyan("📋 Logs from all components\n")
	fmt.Println(strings.Repeat("=", 60))

	components := []string{"app", "database", "traefik"}

	// Add monitoring if enabled
	if l.config.Monitoring.Enabled {
		components = append(components, "prometheus", "grafana")
	}

	// Add Supabase components if self-hosted
	if l.config.Database.Type == "self-hosted" {
		components = append(components, "auth", "realtime", "storage", "kong")
	}

	for _, comp := range components {
		info := componentMap[comp]
		pods, err := l.getPodsForComponent(info)
		if err != nil || len(pods) == 0 {
			continue
		}

		color.Yellow("\n▶ %s\n", strings.Title(comp))
		fmt.Println(strings.Repeat("-", 40))

		for _, pod := range pods {
			containers := l.getContainersForPod(pod, info.container)

			for _, container := range containers {
				opts := &corev1.PodLogOptions{
					Container: container,
					Follow:    false, // Don't follow in 'all' mode
				}

				if tail > 0 {
					tailLines := int64(tail / len(components)) // Distribute tail lines
					if tailLines < 10 {
						tailLines = 10
					}
					opts.TailLines = &tailLines
				}

				ctx := context.Background()
				req := l.k8sClient.CoreV1().Pods(pod.Namespace).GetLogs(pod.Name, opts)
				stream, err := req.Stream(ctx)
				if err != nil {
					continue
				}

				l.streamLogs(stream, pod.Name, container, false)
				stream.Close()
			}
		}
	}

	if follow {
		color.Yellow("\n\nNote: Follow mode (-f) is not supported when viewing all components.\n")
		color.Yellow("Use 'rulebricks logs <component> -f' to follow a specific component.\n")
	}

	return nil
}

// Helper functions

// getComponentNames returns available component names
func getComponentNames(componentMap map[string]componentInfo) []string {
	names := []string{}
	for name := range componentMap {
		names = append(names, name)
	}
	return names
}

// shortPodName returns a shortened pod name
func shortPodName(fullName string) string {
	parts := strings.Split(fullName, "-")
	if len(parts) > 2 {
		// Keep first part and last 2 parts (usually the replica ID)
		return fmt.Sprintf("%s-%s", parts[0], parts[len(parts)-1])
	}
	return fullName
}

// startsWithTimestamp checks if a line starts with a timestamp
func startsWithTimestamp(line string) bool {
	// Check for common timestamp patterns
	if len(line) < 10 {
		return false
	}

	// ISO 8601 format
	if line[4] == '-' && line[7] == '-' {
		return true
	}

	// Common log format with brackets
	if line[0] == '[' {
		return true
	}

	return false
}

// colorizeLine adds color to log lines based on level
func colorizeLine(line string) string {
	lowerLine := strings.ToLower(line)

	// Error levels
	if strings.Contains(lowerLine, "error") ||
	   strings.Contains(lowerLine, "err") ||
	   strings.Contains(lowerLine, "fatal") ||
	   strings.Contains(lowerLine, "panic") ||
	   strings.Contains(lowerLine, "failed") {
		return color.RedString(line)
	}

	// Warning levels
	if strings.Contains(lowerLine, "warn") ||
	   strings.Contains(lowerLine, "warning") {
		return color.YellowString(line)
	}

	// Info levels
	if strings.Contains(lowerLine, "info") ||
	   strings.Contains(lowerLine, "information") {
		return color.CyanString(line)
	}

	// Debug levels
	if strings.Contains(lowerLine, "debug") ||
	   strings.Contains(lowerLine, "trace") {
		return color.WhiteString(line)
	}

	// Success indicators
	if strings.Contains(lowerLine, "success") ||
	   strings.Contains(lowerLine, "ready") ||
	   strings.Contains(lowerLine, "started") ||
	   strings.Contains(lowerLine, "listening") {
		return color.GreenString(line)
	}

	// HTTP status codes
	if strings.Contains(line, " 200 ") ||
	   strings.Contains(line, " 201 ") ||
	   strings.Contains(line, " 204 ") {
		return color.GreenString(line)
	}

	if strings.Contains(line, " 4") && containsHTTPStatus(line) {
		return color.YellowString(line)
	}

	if strings.Contains(line, " 5") && containsHTTPStatus(line) {
		return color.RedString(line)
	}

	return line
}

// containsHTTPStatus checks if line contains HTTP status code
func containsHTTPStatus(line string) bool {
	// Look for patterns like "404" or "500" that appear to be HTTP codes
	words := strings.Fields(line)
	for _, word := range words {
		if len(word) == 3 {
			if word[0] >= '2' && word[0] <= '5' &&
			   word[1] >= '0' && word[1] <= '9' &&
			   word[2] >= '0' && word[2] <= '9' {
				return true
			}
		}
	}
	return false
}

// LogFilter represents log filtering options
type LogFilter struct {
	Level      string
	StartTime  *time.Time
	EndTime    *time.Time
	Pattern    string
	MaxLines   int
}

// FilterLogs applies filters to log output
func (l *LogViewer) FilterLogs(component string, filter LogFilter) error {
	// This would implement log filtering functionality
	// For now, we'll use the basic ViewLogs
	return l.ViewLogs(component, false, filter.MaxLines)
}
