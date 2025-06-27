package main

import (
	"bufio"
	"context"
	"fmt"
	"strings"

	"github.com/fatih/color"
	"k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
)

// LogViewer handles log viewing operations
type LogViewer struct {
	config   *Config
	k8sOps   *KubernetesOperations
	progress *ProgressIndicator
}

// NewLogViewer creates a new log viewer
func NewLogViewer(config *Config) *LogViewer {
	return &LogViewer{
		config:   config,
		progress: NewProgressIndicator(false),
	}
}

// ViewLogs displays logs for the specified component
func (lv *LogViewer) ViewLogs(component string, follow bool, tail int) error {
	// Initialize Kubernetes operations
	k8sOps, err := NewKubernetesOperations(lv.config, false)
	if err != nil {
		return fmt.Errorf("failed to connect to cluster: %w", err)
	}
	lv.k8sOps = k8sOps

	// Map component names to namespaces and label selectors
	componentMap := lv.getComponentMap()

	// Handle 'all' component
	if component == "all" {
		return lv.viewAllLogs(componentMap, follow, tail)
	}

	// Get component info
	info, exists := componentMap[strings.ToLower(component)]
	if !exists {
		return fmt.Errorf("unknown component: %s\nAvailable components: %s",
			component, lv.getAvailableComponents())
	}

	// Get pods for component
	pods, err := lv.getPodsForComponent(info)
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

		if err := lv.streamPodLogs(ctx, &pod, follow, tail); err != nil {
			color.Red("  Error getting logs: %v\n", err)
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

// getComponentMap returns the mapping of components to their info
func (lv *LogViewer) getComponentMap() map[string]componentInfo {
	return map[string]componentInfo{
		"app": {
			namespace: lv.config.GetNamespace("app"),
			labels:    "app=rulebricks-app",
			container: "rulebricks-app",
		},
		"application": {
			namespace: lv.config.GetNamespace("app"),
			labels:    "app=rulebricks-app",
			container: "rulebricks-app",
		},
		"hps": {
			namespace: lv.config.GetNamespace("app"),
			labels:    "app=rulebricks-hps",
			container: "rulebricks-hps",
		},
		"workers": {
			namespace: lv.config.GetNamespace("app"),
			labels:    "app=rulebricks-hps-worker",
			container: "generic-worker",
		},
		"redis": {
			namespace: lv.config.GetNamespace("app"),
			labels:    "app=redis",
			container: "redis",
		},
		"kafka": {
			namespace: lv.config.GetNamespace("execution"),
			labels:    "app.kubernetes.io/name=kafka",
			container: "kafka",
		},
		"database": {
			namespace: lv.config.GetNamespace("supabase"),
			labels:    "app.kubernetes.io/name=supabase-db,app.kubernetes.io/instance=supabase",
			container: "postgres",
		},
		"supabase": {
			namespace: lv.config.GetNamespace("supabase"),
			labels:    "app.kubernetes.io/instance=supabase",
			container: "",
		},
		"traefik": {
			namespace: lv.config.GetNamespace("traefik"),
			labels:    "app.kubernetes.io/name=traefik",
			container: "traefik",
		},
		"prometheus": {
			namespace: lv.config.GetNamespace("monitoring"),
			labels:    "app=prometheus-kube-prometheus-prometheus",
			container: "prometheus",
		},
		"grafana": {
			namespace: lv.config.GetNamespace("monitoring"),
			labels:    "app.kubernetes.io/instance=prometheus,app.kubernetes.io/name=grafana",
			container: "grafana",
		},
	}
}

// getAvailableComponents returns a comma-separated list of available components
func (lv *LogViewer) getAvailableComponents() string {
	components := []string{"app", "hps", "workers", "redis", "kafka", "database", "supabase", "traefik", "prometheus", "grafana", "all"}
	return strings.Join(components, ", ")
}

// getPodsForComponent returns pods matching the component
func (lv *LogViewer) getPodsForComponent(info componentInfo) ([]v1.Pod, error) {
	ctx := context.Background()

	// List pods with label selector
	pods, err := lv.k8sOps.client.CoreV1().Pods(info.namespace).List(ctx, metav1.ListOptions{
		LabelSelector: info.labels,
	})
	if err != nil {
		return nil, err
	}

	// Filter running pods
	var runningPods []v1.Pod
	for _, pod := range pods.Items {
		if pod.Status.Phase == v1.PodRunning || pod.Status.Phase == v1.PodPending {
			runningPods = append(runningPods, pod)
		}
	}

	return runningPods, nil
}

// streamPodLogs streams logs from a pod
func (lv *LogViewer) streamPodLogs(ctx context.Context, pod *v1.Pod, follow bool, tail int) error {
	// Get the primary container if not specified
	containerName := ""
	if len(pod.Spec.Containers) > 0 {
		containerName = pod.Spec.Containers[0].Name
	}

	opts := &v1.PodLogOptions{
		Container: containerName,
		Follow:    follow,
	}

	if tail > 0 {
		tailLines := int64(tail)
		opts.TailLines = &tailLines
	}

	req := lv.k8sOps.client.CoreV1().Pods(pod.Namespace).GetLogs(pod.Name, opts)
	stream, err := req.Stream(ctx)
	if err != nil {
		return err
	}
	defer stream.Close()

	scanner := bufio.NewScanner(stream)
	for scanner.Scan() {
		line := scanner.Text()
		fmt.Println(lv.colorizeLine(line))
	}

	return scanner.Err()
}

// viewAllLogs displays logs from all components
func (lv *LogViewer) viewAllLogs(componentMap map[string]componentInfo, follow bool, tail int) error {
	if follow {
		color.Yellow("Note: Follow mode (-f) is not supported when viewing all components.\n")
		color.Yellow("Use 'rulebricks logs <component> -f' to follow a specific component.\n\n")
	}

	color.Cyan("📋 Logs from all components\n")
	fmt.Println(strings.Repeat("=", 60))

	components := []string{"app", "hps", "workers", "redis", "kafka", "traefik"}

	// Add monitoring if enabled
	if lv.config.Monitoring.Enabled {
		components = append(components, "prometheus", "grafana")
	}

	// Add Supabase components if self-hosted
	if lv.config.Database.Type == "self-hosted" {
		components = append(components, "database", "supabase")
	}

	for _, comp := range components {
		info, exists := componentMap[comp]
		if !exists {
			continue
		}

		pods, err := lv.getPodsForComponent(info)
		if err != nil || len(pods) == 0 {
			continue
		}

		color.Yellow("\n▶ %s\n", strings.Title(comp))
		fmt.Println(strings.Repeat("-", 40))

		ctx := context.Background()
		for _, pod := range pods {
			// Limit tail for each component when viewing all
			componentTail := tail
			if componentTail > 20 {
				componentTail = 20
			}

			if err := lv.streamPodLogs(ctx, &pod, false, componentTail); err != nil {
				lv.progress.Debug("Failed to get logs for %s: %v", pod.Name, err)
			}
		}
	}

	return nil
}

// colorizeLine adds color to log lines based on level
func (lv *LogViewer) colorizeLine(line string) string {
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
	if strings.Contains(lowerLine, "info") {
		return color.CyanString(line)
	}

	// Debug levels
	if strings.Contains(lowerLine, "debug") ||
		strings.Contains(lowerLine, "trace") {
		return color.HiBlackString(line)
	}

	// Success indicators
	if strings.Contains(lowerLine, "success") ||
		strings.Contains(lowerLine, "ready") ||
		strings.Contains(lowerLine, "started") {
		return color.GreenString(line)
	}

	return line
}
