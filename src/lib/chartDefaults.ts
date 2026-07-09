// Deployment constants the wizard never asks about, collected in one place so
// "what the chart gets beyond the wizard's questions" is auditable at a glance.
// These mirror the Helm chart's own defaults or encode structural contracts;
// operators who need different values tune the generated values.yaml or the
// chart directly.

// Baseline Kafka topic partitioning. These are NOT user-tunable sizing knobs;
// they are a structural contract that must stay consistent across three places
// at once: the kafka.provisioning topic partitions,
// rulebricks.hps.workers.solutionPartitions (the worker-fleet concurrency
// ceiling the chart cross-checks), and the worker KEDA maxReplicaCount
// (validated to be <= solutionPartitions). Partitions can never be decreased,
// so solution is sized with generous headroom up front; idle partitions are
// effectively free.
export const SOLUTION_TOPIC_PARTITIONS = 128;
export const LOGS_TOPIC_PARTITIONS = 24;

// RPC + log topics: replication factor 1. RPC traffic is transient and
// latency-sensitive (the HPS producer's acks=-1 would otherwise wait on full
// ISR replication); the in-cluster broker is single-replica by default.
export const TOPIC_REPLICATION_FACTOR = 1;

// Decision-log archive batching: flush a gzipped NDJSON file at ~64 MiB
// (uncompressed) or after 5 minutes, whichever comes first.
//
// max_bytes MUST stay well below the Vector pod's memory limit
// (vector.resources.limits.memory in the chart): the object-storage sink
// buffers the whole uncompressed batch in memory before it flushes, so a batch
// sized at or above the pod limit gets OOMKilled before it can ever write a
// blob, silently disabling decision-log export. 64 MiB leaves comfortable
// headroom under the chart's 1 GiB Vector limit while still producing large,
// scan-efficient files for ClickHouse.
export const DECISION_LOG_BATCH = {
  max_bytes: 67108864,
  timeout_secs: 300,
} as const;

// In-cluster Prometheus sizing (always installed; the wizard only configures
// optional remote_write export).
export const PROMETHEUS_RETENTION = "30d";
export const PROMETHEUS_STORAGE_SIZE = "50Gi";

// Traefik ingress autoscaling bounds, matching the chart defaults. The
// ceiling is liberal (proxy pods are cheap and shed at idle) so the ingress
// never fronts-runs a scaled-out gather plane; scale-DOWN churn is tamed by
// the chart's HPA behavior + entrypoint lifeCycle drain (see chart values).
export const TRAEFIK_MIN_REPLICAS = 1;
export const TRAEFIK_MAX_REPLICAS = 8;

// Supabase auth emails used when custom templates are disabled. These are the
// product's stock templates; enabling Custom Email Templates in the wizard
// replaces all of them.
export const DEFAULT_SUPABASE_EMAILS = {
  subjects: {
    invite: "Join your team on Rulebricks",
    confirmation: "Confirm Your Email",
    recovery: "Reset Your Password",
    emailChange: "Confirm Email Change",
  },
  templates: {
    invite:
      "https://prefix-files.s3.us-west-2.amazonaws.com/templates/invite.html",
    confirmation:
      "https://prefix-files.s3.us-west-2.amazonaws.com/templates/verify.html",
    recovery:
      "https://prefix-files.s3.us-west-2.amazonaws.com/templates/password_change.html",
    emailChange:
      "https://prefix-files.s3.us-west-2.amazonaws.com/templates/email_change.html",
  },
} as const;
