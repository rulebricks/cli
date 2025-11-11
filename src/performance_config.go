package main

// All performance-related default values
type PerformanceDefaults struct {
	Kafka      KafkaPerformanceDefaults
	Vector     VectorPerformanceDefaults
	Prometheus PrometheusPerformanceDefaults
	Traefik    TraefikPerformanceDefaults
	Supabase   SupabasePerformanceDefaults
	Timeouts   TimeoutDefaults
	Tiers      map[string]TierConfig
}

// Kafka-specific performance settings
type KafkaPerformanceDefaults struct {
	DefaultRetentionHours    int
	DefaultPartitions        int
	DefaultReplicationFactor int
	DefaultStorageSize       string
	StorageClasses           map[string]string
	JVMHeapOpts              map[string]string
	JVMPerfOpts              map[string]string
	ControllerResources      map[string]ControllerResources
	InitContainerResources   InitContainerResources
	EnvVars                  map[string]string
	TopicConfigs             TopicConfigs
}

type ControllerResources struct {
	RequestsCPU    string
	RequestsMemory string
	LimitsCPU      string
	LimitsMemory   string
}

type InitContainerResources struct {
	RequestsCPU    string
	RequestsMemory string
	LimitsCPU      string
	LimitsMemory   string
}

type TopicConfigs struct {
	SolutionTopic        TopicConfig
	SolutionResponseTopic TopicConfig
	LogsTopic           TopicConfig
}

type TopicConfig struct {
	RetentionMS   string
	SegmentMS     string
	SegmentBytes  string
	RetentionBytes string
	Compression   string
}

type VectorPerformanceDefaults struct {
	Replicas        int
	RequestsCPU     string
	RequestsMemory  string
	LimitsCPU       string
	LimitsMemory    string
}

type PrometheusPerformanceDefaults struct {
	LocalRetention  string
	LocalStorageSize string
	RemoteRetention string
	RemoteStorageSize string
}

type TraefikPerformanceDefaults struct {
	DefaultMinReplicas int
	DefaultMaxReplicas int
	StorageClasses     map[string]string
}

type SupabasePerformanceDefaults struct {
	StorageSize string
}

type TimeoutDefaults struct {
	HelmInstall      string
	HelmUpgrade      string
	DeploymentWait   string
	TraefikWait      string
	KafkaWait        string
	SupabaseWait     string
}

type TierConfig struct {
	VolumeLevel            string
	NodeCount              int
	MinNodes               int
	MaxNodes               int
	HPSReplicas            int
	HPSWorkerReplicas      int
	HPSWorkerMaxReplicas   int
	KafkaRetentionHours    int
	KafkaReplicationFactor int
	KafkaStorageSize       string
	TraefikMinReplicas     int
	TraefikMaxReplicas     int
	ScaleUpStabilization   int
	ScaleDownStabilization int
	KedaPollingInterval    int
	KafkaLagThreshold      int
}

// Default performance configuration
func GetPerformanceDefaults() *PerformanceDefaults {
	return &PerformanceDefaults{
		Kafka: KafkaPerformanceDefaults{
			DefaultRetentionHours:    24,
			DefaultPartitions:        3,
			DefaultReplicationFactor: 2,
			DefaultStorageSize:       "50Gi",
			StorageClasses: map[string]string{
				"aws":   "gp3",
				"azure": "managed-csi-premium",
				"gcp":   "pd-ssd",
				"default": "default",
			},
			JVMHeapOpts: map[string]string{
				"small":  "-Xmx768m -Xmx768m -XX:+UseZGC -XX:+AlwaysPreTouch -Xlog:os+container=info,gc+start=info,gc+init=info,gc+heap=info:file=/opt/bitnami/kafka/logs/gc.log:time,uptime,level,tags",
				"medium": "-Xmx1g -Xms1g -XX:+UseZGC -XX:+AlwaysPreTouch",
				"large":  "-Xmx3g -Xms3g -XX:+UseZGC -XX:+AlwaysPreTouch",
			},
			JVMPerfOpts: map[string]string{
				"small":  "-XX:MaxDirectMemorySize=256M -Djdk.nio.maxCachedBufferSize=262144",
				"medium": "-XX:MaxDirectMemorySize=256M -Djdk.nio.maxCachedBufferSize=262144",
				"large":  "-XX:MaxDirectMemorySize=512M -Djdk.nio.maxCachedBufferSize=262144",
			},
			ControllerResources: map[string]ControllerResources{
				"small": {
					RequestsCPU:    "500m",
					RequestsMemory: "2Gi",
					LimitsCPU:      "2000m",
					LimitsMemory:   "3Gi",
				},
				"medium": {
					RequestsCPU:    "1000m",
					RequestsMemory: "2Gi",
					LimitsCPU:      "2000m",
					LimitsMemory:   "3Gi",
				},
				"large": {
					RequestsCPU:    "2000m",
					RequestsMemory: "2Gi",
					LimitsCPU:      "4000m",
					LimitsMemory:   "3Gi",
				},
			},
			InitContainerResources: InitContainerResources{
				RequestsCPU:    "100m",
				RequestsMemory: "128Mi",
				LimitsCPU:      "150m",
				LimitsMemory:   "192Mi",
			},
			EnvVars: map[string]string{
				"KAFKA_CFG_QUEUED_MAX_REQUESTS":                    "10000",
				"KAFKA_CFG_NUM_NETWORK_THREADS":                    "8",
				"KAFKA_CFG_NUM_IO_THREADS":                         "8",
				"KAFKA_CFG_SOCKET_SEND_BUFFER_BYTES":                "1048576",
				"KAFKA_CFG_SOCKET_RECEIVE_BUFFER_BYTES":            "1048576",
				"KAFKA_CFG_SOCKET_REQUEST_MAX_BYTES":               "209715200",
				"KAFKA_CFG_LOG_RETENTION_BYTES":                    "4294967296",
				"KAFKA_CFG_LOG_SEGMENT_BYTES":                      "1073741824",
				"KAFKA_CFG_NUM_REPLICA_FETCHERS":                   "4",
				"KAFKA_CFG_REPLICA_SOCKET_RECEIVE_BUFFER_BYTES":   "1048576",
				"KAFKA_CFG_LOG_CLEANER_DEDUPE_BUFFER_SIZE":        "268435456",
				"KAFKA_CFG_LOG_CLEANER_IO_BUFFER_SIZE":            "1048576",
				"KAFKA_CFG_MAX_IN_FLIGHT_REQUESTS_PER_CONNECTION": "10",
			},
			TopicConfigs: TopicConfigs{
				SolutionTopic: TopicConfig{
					RetentionMS:  "30000",
					SegmentMS:    "10000",
					SegmentBytes: "16777216",
				},
				SolutionResponseTopic: TopicConfig{
					RetentionMS:  "30000",
					SegmentMS:    "10000",
					SegmentBytes: "16777216",
				},
				LogsTopic: TopicConfig{
					RetentionBytes: "4294967296",
					SegmentBytes:   "1073741824",
					Compression:    "gzip",
				},
			},
		},
		Vector: VectorPerformanceDefaults{
			Replicas:       2,
			RequestsCPU:    "50m",
			RequestsMemory: "128Mi",
			LimitsCPU:      "200m",
			LimitsMemory:   "256Mi",
		},
		Prometheus: PrometheusPerformanceDefaults{
			LocalRetention:    "30d",
			LocalStorageSize:  "50Gi",
			RemoteRetention:   "7d",
			RemoteStorageSize: "10Gi",
		},
		Traefik: TraefikPerformanceDefaults{
			DefaultMinReplicas: 1,
			DefaultMaxReplicas: 2,
			StorageClasses: map[string]string{
				"aws":   "gp2",
				"azure": "default",
				"gcp":   "standard",
				"default": "default",
			},
		},
		Supabase: SupabasePerformanceDefaults{
			StorageSize: "10Gi",
		},
		Timeouts: TimeoutDefaults{
			HelmInstall:    "10m",
			HelmUpgrade:    "10m",
			DeploymentWait: "300s",
			TraefikWait:    "300s",
			KafkaWait:      "15m",
			SupabaseWait:   "15m",
		},
		Tiers: map[string]TierConfig{
			"small": {
				VolumeLevel:            "small",
				NodeCount:              4,
				MinNodes:               4,
				MaxNodes:               4,
				HPSReplicas:            2,
				HPSWorkerReplicas:      4,
				HPSWorkerMaxReplicas:   8,
				KafkaRetentionHours:    24,
				KafkaReplicationFactor: 1,
				KafkaStorageSize:       "10Gi",
				TraefikMinReplicas:     1,
				TraefikMaxReplicas:     2,
				ScaleUpStabilization:   30,
				ScaleDownStabilization: 300,
				KedaPollingInterval:    10,
				KafkaLagThreshold:      8,
			},
			"medium": {
				VolumeLevel:            "medium",
				NodeCount:              4,
				MinNodes:               4,
				MaxNodes:               8,
				HPSReplicas:            2,
				HPSWorkerReplicas:      10,
				HPSWorkerMaxReplicas:   24,
				KafkaRetentionHours:    72,
				KafkaReplicationFactor: 2,
				KafkaStorageSize:       "50Gi",
				TraefikMinReplicas:     2,
				TraefikMaxReplicas:     4,
				ScaleUpStabilization:   30,
				ScaleDownStabilization: 300,
				KedaPollingInterval:    10,
				KafkaLagThreshold:      8,
			},
			"large": {
				VolumeLevel:            "large",
				NodeCount:              5,
				MinNodes:               5,
				MaxNodes:               16,
				HPSReplicas:            4,
				HPSWorkerReplicas:      10,
				HPSWorkerMaxReplicas:   48,
				KafkaRetentionHours:    168,
				KafkaReplicationFactor: 3,
				KafkaStorageSize:       "100Gi",
				TraefikMinReplicas:     2,
				TraefikMaxReplicas:     6,
				ScaleUpStabilization:   30,
				ScaleDownStabilization: 300,
				KedaPollingInterval:    10,
				KafkaLagThreshold:      8,
			},
		},
	}
}

// Configuration for a specific tier
func GetTierConfig(tier string) *TierConfig {
	defaults := GetPerformanceDefaults()
	if config, ok := defaults.Tiers[tier]; ok {
		return &config
	}
	if config, ok := defaults.Tiers["small"]; ok {
		return &config
	}
	return nil
}

func GetKafkaStorageClass(provider string) string {
	defaults := GetPerformanceDefaults()
	if sc, ok := defaults.Kafka.StorageClasses[provider]; ok {
		return sc
	}
	return defaults.Kafka.StorageClasses["default"]
}

func GetTraefikStorageClass(provider string) string {
	defaults := GetPerformanceDefaults()
	if sc, ok := defaults.Traefik.StorageClasses[provider]; ok {
		return sc
	}
	return defaults.Traefik.StorageClasses["default"]
}

func GetVolumeSize(level string) string {
	if tier := GetTierConfig(level); tier != nil {
		return tier.KafkaStorageSize
	}
	switch level {
	case "small":
		return "10Gi"
	case "large":
		return "100Gi"
	default:
		return "50Gi"
	}
}

