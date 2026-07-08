import React, { useState } from "react";
import { Box, Text } from "ink";
import { useWizard } from "../WizardContext.js";
import { useFieldFlow, FlowField } from "../fieldFlow.js";
import {
  BorderBox,
  CheckboxList,
  DiscoveredSelect,
  FieldError,
  StepFooter,
  TextField,
  WizardSelect,
} from "../../common/index.js";
import {
  DiscoveredKafkaCluster,
  DiscoveredPostgresInstance,
  DiscoveredRedisInstance,
  getAwsSecretValue,
  getAzureRedisKey,
  getEventHubsConnectionString,
  getGcpRedisAuthString,
  getMskBootstrapBrokers,
  listManagedKafka,
  listManagedPostgres,
  listManagedRedis,
} from "../../../lib/cloudCli.js";
import { CloudProvider, KafkaPreset } from "../../../types/index.js";
import { externalServicesFieldOrder } from "../../../lib/wizardFlow.js";

interface ExternalServicesStepProps {
  onComplete: () => void;
  onBack: () => void;
  entryDirection?: "forward" | "back";
}

type ServiceKey = "redis" | "kafka" | "postgres";

const MODE_OPTIONS = [
  {
    label: "Prefer dedicated services for Rulebricks (recommended)",
    value: "dedicated",
  },
  {
    label: "Connect to existing providers",
    value: "existing",
  },
];

const yesNo = (yesLabel: string, noLabel: string) => [
  { label: noLabel, value: "no" },
  { label: yesLabel, value: "yes" },
];

const PRESETS: { id: KafkaPreset; label: string; hint: string }[] = [
  {
    id: "aws-msk-iam",
    label: "AWS MSK (IAM auth)",
    hint: "Pod identity: HPS + lag autoscaling connect natively. Vector uses a kafka-proxy bridge sidecar.",
  },
  {
    id: "azure-event-hubs",
    label: "Azure Event Hubs",
    hint: "SASL PLAIN with the namespace connection string.",
  },
  {
    id: "gcp-managed",
    label: "GCP Managed Service for Apache Kafka",
    hint: "SASL PLAIN credentials (Vector cannot use GCP OAUTHBEARER).",
  },
  { id: "custom", label: "Custom / other broker", hint: "Manual SSL + SASL." },
];

const CUSTOM_MECH: { id: string; label: string }[] = [
  { id: "", label: "None (SSL only)" },
  { id: "plain", label: "SASL PLAIN" },
  { id: "scram-sha-256", label: "SCRAM-SHA-256" },
  { id: "scram-sha-512", label: "SCRAM-SHA-512" },
];

// Select value that switches Postgres entry to a pasted connection string.
const CONN_STRING = "__connstring__";

function defaultPresetForCloud(provider: string | null): KafkaPreset {
  if (provider === "aws") return "aws-msk-iam";
  if (provider === "azure") return "azure-event-hubs";
  if (provider === "gcp") return "gcp-managed";
  return "custom";
}

function managedPostgresName(provider: CloudProvider | null): string {
  if (provider === "aws") return "RDS / Aurora";
  if (provider === "azure") return "Flexible Server";
  if (provider === "gcp") return "Cloud SQL";
  return "managed Postgres";
}

// Parse a postgres:// URL into parts. Returns null when it isn't parseable.
function parsePostgresUrl(raw: string): {
  host?: string;
  port?: number;
  database?: string;
  user?: string;
  password?: string;
} | null {
  const trimmed = raw.trim();
  if (!/^postgres(ql)?:\/\//i.test(trimmed)) return null;
  try {
    const u = new URL(trimmed.replace(/^postgres(ql)?:\/\//i, "http://"));
    const db = u.pathname.replace(/^\//, "");
    return {
      host: u.hostname || undefined,
      port: u.port ? Number.parseInt(u.port, 10) : undefined,
      database: db || undefined,
      user: u.username ? decodeURIComponent(u.username) : undefined,
      password: u.password ? decodeURIComponent(u.password) : undefined,
    };
  } catch {
    return null;
  }
}

export function ExternalServicesStep({
  onComplete,
  onBack,
  entryDirection,
}: ExternalServicesStepProps) {
  const { state, dispatch } = useWizard();
  const [error, setError] = useState<string | null>(null);

  const provider = state.provider;
  const anyExternal =
    state.redisMode === "external" ||
    state.kafkaMode === "external" ||
    state.postgresMode === "external";

  // Externalizing the Postgres database applies to self-hosted Supabase only
  // (with Supabase Cloud there is no in-cluster database to replace).
  const pgAvailable = provider !== null && state.databaseType === "self-hosted";

  const [modeChoice, setModeChoice] = useState<"dedicated" | "existing">(
    anyExternal ? "existing" : "dedicated",
  );
  const [selected, setSelected] = useState<Record<ServiceKey, boolean>>({
    redis: state.redisMode === "external",
    kafka: state.kafkaMode === "external",
    postgres: pgAvailable && state.postgresMode === "external",
  });

  // Redis
  const [redisHost, setRedisHost] = useState(state.redisHost);
  const [redisPort, setRedisPort] = useState(String(state.redisPort || 6379));
  const [redisTls, setRedisTls] = useState(state.redisTls);
  const [redisPassword, setRedisPassword] = useState(state.redisPassword);
  const [redisExistingSecret, setRedisExistingSecret] = useState(
    state.redisExistingSecret,
  );

  // Kafka
  const [preset, setPreset] = useState<KafkaPreset>(
    state.kafkaPreset ?? defaultPresetForCloud(provider),
  );
  const [brokers, setBrokers] = useState(state.kafkaBrokers);
  const [topicPrefix, setTopicPrefix] = useState(
    state.kafkaTopicPrefix || "com.rulebricks.",
  );
  const [awsRegion, setAwsRegion] = useState(
    state.kafkaSaslRegion || state.region,
  );
  const [provisionTopics, setProvisionTopics] = useState(
    state.kafkaProvisionTopics,
  );
  const [azureConnection, setAzureConnection] = useState(
    state.kafkaSaslPassword,
  );
  const [gcpUsername, setGcpUsername] = useState(state.kafkaSaslUsername);
  const [gcpPassword, setGcpPassword] = useState(state.kafkaSaslPassword);
  const [customMechanism, setCustomMechanism] = useState(
    state.kafkaSaslMechanism as string,
  );
  const [customSsl, setCustomSsl] = useState(state.kafkaSsl);
  const [customUsername, setCustomUsername] = useState(state.kafkaSaslUsername);
  const [customPassword, setCustomPassword] = useState(state.kafkaSaslPassword);

  // Postgres
  const [pgUseConnString, setPgUseConnString] = useState(false);
  const [pgConn, setPgConn] = useState("");
  const [pgHost, setPgHost] = useState(state.postgresHost);
  const [pgPort, setPgPort] = useState(String(state.postgresPort || 5432));
  const [pgDatabase, setPgDatabase] = useState(
    state.postgresDatabase || "postgres",
  );
  const [pgMasterUser, setPgMasterUser] = useState(
    state.postgresMasterUsername || "postgres",
  );
  const [pgMasterPass, setPgMasterPass] = useState(state.postgresMasterPassword);

  // Lookup maps from discovered-list values (names) to full records, so
  // selections can prefill connection fields and fetch credentials.
  const [redisByName] = useState(new Map<string, DiscoveredRedisInstance>());
  const [kafkaByName] = useState(new Map<string, DiscoveredKafkaCluster>());
  const [pgByName] = useState(new Map<string, DiscoveredPostgresInstance>());

  // Committed answers are written to wizard state as the user advances, so
  // leaving the step and returning never loses what was already entered.
  type ExternalServicesPatch = Extract<
    Parameters<typeof dispatch>[0],
    { type: "SET_EXTERNAL_SERVICES" }
  >["config"];
  const save = (config: ExternalServicesPatch) =>
    dispatch({ type: "SET_EXTERNAL_SERVICES", config });

  const persist = () => {
    const redisExternal = selected.redis;
    const kafkaExternal = selected.kafka;
    const postgresExternal = selected.postgres;

    // Derive Kafka SASL/SSL/identity from the chosen preset.
    let kafkaSsl = false;
    let mechanism: typeof state.kafkaSaslMechanism = "";
    let region = "";
    let username = "";
    let password = "";
    let awsRoleArn = "";

    if (kafkaExternal) {
      if (preset === "aws-msk-iam") {
        kafkaSsl = true;
        mechanism = "aws-iam";
        region = awsRegion.trim();
        // Not collected by the wizard: deploy derives the cluster-setup role
        // or reuses existing associations. Pass through any config.yaml value
        // so a manual override survives configure re-runs.
        awsRoleArn = state.kafkaIdentityAwsRoleArn;
      } else if (preset === "azure-event-hubs") {
        kafkaSsl = true;
        mechanism = "plain";
        username = "$ConnectionString";
        password = azureConnection;
      } else if (preset === "gcp-managed") {
        kafkaSsl = true;
        mechanism = "plain";
        username = gcpUsername;
        password = gcpPassword;
      } else {
        kafkaSsl = customSsl;
        mechanism = customMechanism as typeof state.kafkaSaslMechanism;
        username = customMechanism ? customUsername : "";
        password = customMechanism ? customPassword : "";
      }
    }

    dispatch({
      type: "SET_EXTERNAL_SERVICES",
      config: {
        redisMode: redisExternal ? "external" : "embedded",
        redisHost: redisExternal ? redisHost.trim() : "",
        redisPort: Number.parseInt(redisPort, 10) || 6379,
        redisPassword: redisExternal ? redisPassword : "",
        redisExistingSecret: redisExternal ? redisExistingSecret.trim() : "",
        redisTls: redisExternal ? redisTls : false,
        kafkaMode: kafkaExternal ? "external" : "embedded",
        kafkaPreset: kafkaExternal ? preset : null,
        kafkaBrokers: kafkaExternal ? brokers.trim() : "",
        kafkaTopicPrefix: kafkaExternal
          ? topicPrefix.trim()
          : "com.rulebricks.",
        kafkaSsl,
        kafkaSaslMechanism: mechanism,
        kafkaSaslRegion: region,
        kafkaSaslUsername: username,
        kafkaSaslPassword: password,
        kafkaIdentityAwsRoleArn: awsRoleArn,
        kafkaIdentityGcpServiceAccountEmail: "",
        kafkaIdentityAzureClientId: "",
        kafkaProvisionTopics: kafkaExternal ? provisionTopics : true,
        postgresMode: postgresExternal ? "external" : "embedded",
        postgresHost: postgresExternal ? pgHost.trim() : "",
        postgresPort: Number.parseInt(pgPort, 10) || 5432,
        postgresDatabase: postgresExternal
          ? pgDatabase.trim() || "postgres"
          : "postgres",
        postgresMasterUsername: postgresExternal
          ? pgMasterUser.trim() || "postgres"
          : "postgres",
        postgresMasterPassword: postgresExternal ? pgMasterPass : "",
      },
    });
    onComplete();
  };

  // Prefill handlers for discovery selections. Credential fetches run in the
  // background (behind the approval gate) and never clobber typed values.
  const applyRedisSelection = (instance: DiscoveredRedisInstance) => {
    setRedisHost(instance.host);
    setRedisPort(String(instance.port));
    setRedisTls(instance.tls);
    save({
      redisHost: instance.host,
      redisPort: instance.port,
      redisTls: instance.tls,
    });
    if (!instance.authEnabled) return;
    if (provider === "aws" && instance.authSecretId) {
      getAwsSecretValue(instance.authSecretId, state.region).then((secret) => {
        if (secret) setRedisPassword((current) => current || secret);
      });
    } else if (provider === "azure" && instance.resourceGroup) {
      getAzureRedisKey(instance.name, instance.resourceGroup).then((key) => {
        if (key) setRedisPassword((current) => current || key);
      });
    } else if (provider === "gcp") {
      getGcpRedisAuthString(instance.name, state.region).then((auth) => {
        if (auth) setRedisPassword((current) => current || auth);
      });
    }
  };

  const applyKafkaSelection = (cluster: DiscoveredKafkaCluster) => {
    if (cluster.brokers) {
      setBrokers(cluster.brokers);
      save({ kafkaBrokers: cluster.brokers });
    }
    if (provider === "aws" && cluster.arn) {
      getMskBootstrapBrokers(cluster.arn, state.region).then((discovered) => {
        if (discovered) setBrokers((current) => current || discovered);
      });
    } else if (provider === "azure" && cluster.resourceGroup) {
      getEventHubsConnectionString(cluster.name, cluster.resourceGroup).then(
        (connection) => {
          if (connection) {
            setAzureConnection((current) => current || connection);
          }
        },
      );
    }
  };

  const applyPostgresSelection = (instance: DiscoveredPostgresInstance) => {
    setPgHost(instance.host);
    setPgPort(String(instance.port));
    if (instance.database) setPgDatabase(instance.database);
    if (instance.masterUsername) setPgMasterUser(instance.masterUsername);
    save({
      postgresHost: instance.host,
      postgresPort: instance.port,
      ...(instance.database ? { postgresDatabase: instance.database } : {}),
      ...(instance.masterUsername
        ? { postgresMasterUsername: instance.masterUsername }
        : {}),
    });
    if (instance.masterSecretArn) {
      getAwsSecretValue(instance.masterSecretArn, state.region).then(
        (secret) => {
          if (secret) setPgMasterPass((current) => current || secret);
        },
      );
    }
  };

  const presetChoices = PRESETS.filter(
    (p) =>
      p.id === "custom" ||
      provider === null ||
      p.id === defaultPresetForCloud(provider),
  );

  const pgName = managedPostgresName(provider);

  // Field visibility comes from the shared pure sequence definition, so the
  // component, the tests, and back-navigation always agree on the path.
  const fieldOrder = new Set(
    externalServicesFieldOrder({
      mode: modeChoice,
      services: selected,
      provider,
      pgAvailable,
      hasRedisPassword: !!redisPassword,
      preset,
      hasCustomMechanism: customMechanism !== "",
      pgUseConnString,
    }),
  );

  const fieldDefs: FlowField[] = [
    {
      id: "mode",
      render: (flow) => (
        <WizardSelect
          label="How should these services be provided?"
          items={MODE_OPTIONS}
          initialValue={modeChoice}
          onSelect={(value) => {
            if (value === "dedicated") {
              setModeChoice("dedicated");
              setSelected({ redis: false, kafka: false, postgres: false });
              dispatch({
                type: "SET_EXTERNAL_SERVICES",
                config: {
                  redisMode: "embedded",
                  kafkaMode: "embedded",
                  postgresMode: "embedded",
                },
              });
              onComplete();
              return;
            }
            setModeChoice("existing");
            flow.next();
          }}
        />
      ),
    },
    {
      id: "which",
      render: (flow) => (
        <CheckboxList
          label="Which services do you want to connect to managed providers?"
          items={[
            {
              key: "redis",
              label: "Redis",
              hint: "Managed cache (ElastiCache, Azure Cache, Memorystore).",
              checked: selected.redis,
            },
            {
              key: "kafka",
              label: "Kafka",
              hint: "Managed event streaming (MSK, Event Hubs, GCP Managed Kafka).",
              checked: selected.kafka,
            },
            ...(pgAvailable
              ? [
                  {
                    key: "postgres",
                    label: "Postgres database",
                    hint: `${pgName} for the Supabase database.`,
                    checked: selected.postgres,
                  },
                ]
              : []),
          ]}
          onToggle={(key) =>
            setSelected((s) => ({
              ...s,
              [key]: !s[key as ServiceKey],
            }))
          }
          onContinue={() => {
            if (!selected.redis && !selected.kafka && !selected.postgres) {
              setError("Select at least one service to externalize.");
              return;
            }
            setError(null);
            save({
              redisMode: selected.redis ? "external" : "embedded",
              kafkaMode: selected.kafka ? "external" : "embedded",
              postgresMode: selected.postgres ? "external" : "embedded",
            });
            flow.next();
          }}
        />
      ),
    },

    // ----- Redis -----
    {
      id: "redis-pick",
      render: (flow) => (
        <DiscoveredSelect
          label="Select your managed Redis"
          hint="Discovered through your cloud CLI; connection details prefill the next prompts."
          loadingLabel="Discovering managed Redis instances..."
          emptyHint="None found. Press R to refresh or enter details manually."
          load={async () => {
            const instances = await listManagedRedis(
              provider as CloudProvider,
              state.region,
              { clusterName: state.clusterName },
            );
            redisByName.clear();
            for (const instance of instances) {
              redisByName.set(instance.name, instance);
            }
            return instances.map((instance) => ({
              label: `${instance.name}  (${instance.host})`,
              value: instance.name,
            }));
          }}
          recommendIndex={(items) =>
            items.findIndex(
              (item) => redisByName.get(item.value)?.host === state.redisHost,
            )
          }
          onSelect={(value) => {
            const instance = redisByName.get(value);
            if (instance) applyRedisSelection(instance);
            flow.next();
          }}
          onManual={() => flow.next()}
        />
      ),
    },
    {
      id: "redis-host",
      render: (flow) => (
        <TextField
          label="Redis host"
          hint="Hostname of your managed Redis endpoint."
          value={redisHost}
          onChange={setRedisHost}
          placeholder="redis.example.com"
          onSubmit={() => {
            if (!redisHost.trim()) {
              setError("Redis host is required for an external instance.");
              return;
            }
            setError(null);
            save({ redisHost: redisHost.trim() });
            flow.next();
          }}
        />
      ),
    },
    {
      id: "redis-port",
      render: (flow) => (
        <TextField
          label="Redis port"
          value={redisPort}
          onChange={setRedisPort}
          placeholder="6379"
          onSubmit={() => {
            save({ redisPort: Number.parseInt(redisPort, 10) || 6379 });
            flow.next();
          }}
        />
      ),
    },
    {
      id: "redis-tls",
      render: (flow) => (
        <WizardSelect
          label="Redis TLS"
          items={yesNo(
            "Yes - connect using rediss:// (TLS)",
            "No - plaintext redis://",
          )}
          initialValue={redisTls ? "yes" : "no"}
          onSelect={(value) => {
            setRedisTls(value === "yes");
            save({ redisTls: value === "yes" });
            flow.next();
          }}
        />
      ),
    },
    {
      id: "redis-password",
      render: (flow) => (
        <TextField
          label="Redis password"
          hint="Leave blank to use an existing secret or no auth."
          value={redisPassword}
          onChange={setRedisPassword}
          mask
          onSubmit={() => {
            save({ redisPassword });
            flow.next();
          }}
        />
      ),
    },
    {
      id: "redis-existing-secret",
      render: (flow) => (
        <TextField
          label="Redis password secret"
          hint="Name of an existing Kubernetes secret holding the password. Blank = no auth."
          value={redisExistingSecret}
          onChange={setRedisExistingSecret}
          placeholder="my-redis-auth"
          onSubmit={() => {
            save({ redisExistingSecret: redisExistingSecret.trim() });
            flow.next();
          }}
        />
      ),
    },

    // ----- Kafka -----
    {
      id: "kafka-preset",
      render: (flow) => (
        <WizardSelect
          label="Managed Kafka type"
          hint="Topics/partitions may need to be created by a Kafka admin to match worker counts."
          items={presetChoices.map((p) => ({ label: p.label, value: p.id }))}
          initialValue={preset}
          onSelect={(value) => {
            setPreset(value as KafkaPreset);
            save({ kafkaPreset: value as KafkaPreset });
            flow.next();
          }}
        />
      ),
    },
    {
      id: "kafka-pick",
      render: (flow) => (
        <DiscoveredSelect
          label="Select your managed Kafka"
          hint="Brokers (and credentials where possible) prefill the next prompts."
          loadingLabel="Discovering managed Kafka clusters..."
          emptyHint="None found. Press R to refresh or enter brokers manually."
          load={async () => {
            const clusters = await listManagedKafka(
              provider as CloudProvider,
              state.region,
            );
            kafkaByName.clear();
            for (const cluster of clusters) {
              kafkaByName.set(cluster.name, cluster);
            }
            return clusters.map((cluster) => ({
              label: cluster.brokers
                ? `${cluster.name}  (${cluster.brokers.split(",")[0]})`
                : cluster.name,
              value: cluster.name,
            }));
          }}
          onSelect={(value) => {
            const cluster = kafkaByName.get(value);
            if (cluster) applyKafkaSelection(cluster);
            flow.next();
          }}
          onManual={() => flow.next()}
        />
      ),
    },
    {
      id: "kafka-brokers",
      render: (flow) => (
        <TextField
          label="Kafka bootstrap brokers"
          hint="Comma-separated host:port list."
          value={brokers}
          onChange={setBrokers}
          placeholder="b-1.example:9098,b-2.example:9098"
          onSubmit={() => {
            if (!brokers.trim()) {
              setError("At least one broker is required for external Kafka.");
              return;
            }
            setError(null);
            save({ kafkaBrokers: brokers.trim() });
            flow.next();
          }}
        />
      ),
    },
    {
      id: "kafka-topic-prefix",
      render: (flow) => (
        <TextField
          label="Topic prefix"
          hint="Namespaces topic names (e.g. com.rulebricks.solution) to avoid collisions on shared Kafka. Blank = no prefix."
          value={topicPrefix}
          onChange={setTopicPrefix}
          placeholder="com.rulebricks."
          onSubmit={() => {
            save({ kafkaTopicPrefix: topicPrefix.trim() });
            flow.next();
          }}
        />
      ),
    },
    {
      id: "kafka-aws-region",
      render: (flow) => (
        <TextField
          label="AWS region"
          hint="Region of the MSK cluster (used to sign IAM auth tokens)."
          value={awsRegion}
          onChange={setAwsRegion}
          placeholder="us-east-1"
          onSubmit={() => {
            if (!awsRegion.trim()) {
              setError("Region is required for MSK IAM signing.");
              return;
            }
            setError(null);
            save({ kafkaSaslRegion: awsRegion.trim() });
            flow.next();
          }}
        />
      ),
    },
    {
      id: "kafka-provision-topics",
      render: (flow) => (
        <WizardSelect
          label="Kafka topic provisioning"
          items={yesNo(
            "Yes - the chart creates the required topics on the broker",
            "No - I manage topics myself (locked-down / no CreateTopic)",
          )}
          initialValue={provisionTopics ? "yes" : "no"}
          onSelect={(value) => {
            setProvisionTopics(value === "yes");
            save({ kafkaProvisionTopics: value === "yes" });
            flow.next();
          }}
        />
      ),
    },
    {
      id: "kafka-azure-connection",
      render: (flow) => (
        <TextField
          label="Event Hubs connection string"
          hint="Namespace connection string (used as the SASL PLAIN password)."
          value={azureConnection}
          onChange={setAzureConnection}
          placeholder="Endpoint=sb://...;SharedAccessKey=..."
          mask
          onSubmit={() => {
            if (!azureConnection.trim()) {
              setError("Event Hubs connection string is required.");
              return;
            }
            setError(null);
            save({ kafkaSaslPassword: azureConnection });
            flow.next();
          }}
        />
      ),
    },
    {
      id: "kafka-gcp-username",
      render: (flow) => (
        <TextField
          label="Kafka username"
          hint="GCP service account principal for SASL PLAIN."
          value={gcpUsername}
          onChange={setGcpUsername}
          placeholder="service-account@project.iam.gserviceaccount.com"
          onSubmit={() => {
            save({ kafkaSaslUsername: gcpUsername });
            flow.next();
          }}
        />
      ),
    },
    {
      id: "kafka-gcp-password",
      render: (flow) => (
        <TextField
          label="Kafka password"
          hint="Service-account key or access token."
          value={gcpPassword}
          onChange={setGcpPassword}
          mask
          onSubmit={() => {
            save({ kafkaSaslPassword: gcpPassword });
            flow.next();
          }}
        />
      ),
    },
    {
      id: "kafka-custom-mechanism",
      render: (flow) => (
        <WizardSelect
          label="SASL mechanism"
          items={CUSTOM_MECH.map((m) => ({ label: m.label, value: m.id }))}
          initialValue={customMechanism}
          onSelect={(value) => {
            setCustomMechanism(value);
            save({
              kafkaSaslMechanism: value as ExternalServicesPatch["kafkaSaslMechanism"],
            });
            flow.next();
          }}
        />
      ),
    },
    {
      id: "kafka-custom-ssl",
      render: (flow) => (
        <WizardSelect
          label="Kafka TLS/SSL"
          items={yesNo("Yes - connect over TLS", "No - plaintext connection")}
          initialValue={customSsl ? "yes" : "no"}
          onSelect={(value) => {
            setCustomSsl(value === "yes");
            save({ kafkaSsl: value === "yes" });
            flow.next();
          }}
        />
      ),
    },
    {
      id: "kafka-custom-username",
      render: (flow) => (
        <TextField
          label="Kafka SASL username"
          value={customUsername}
          onChange={setCustomUsername}
          onSubmit={() => {
            save({ kafkaSaslUsername: customUsername });
            flow.next();
          }}
        />
      ),
    },
    {
      id: "kafka-custom-password",
      render: (flow) => (
        <TextField
          label="Kafka SASL password"
          value={customPassword}
          onChange={setCustomPassword}
          mask
          onSubmit={() => {
            save({ kafkaSaslPassword: customPassword });
            flow.next();
          }}
        />
      ),
    },

    // ----- Postgres -----
    {
      id: "pg-pick",
      render: (flow) => (
        <DiscoveredSelect
          label={`Select your ${pgName} instance`}
          hint="Self-hosted Supabase will run against this database. A one-time bootstrap initializes roles/schemas."
          loadingLabel={`Discovering ${pgName} instances...`}
          emptyHint="None found. Press R to refresh or enter details manually."
          load={async () => {
            const instances = await listManagedPostgres(
              provider as CloudProvider,
              state.region,
            );
            pgByName.clear();
            for (const instance of instances) {
              pgByName.set(instance.name, instance);
            }
            return [
              ...instances.map((instance) => ({
                label: `${instance.name}  (${instance.host})`,
                value: instance.name,
              })),
              {
                label: "Paste a Postgres connection string…",
                value: CONN_STRING,
              },
            ];
          }}
          recommendIndex={(items) =>
            items.findIndex(
              (item) => pgByName.get(item.value)?.host === state.postgresHost,
            )
          }
          onSelect={(value) => {
            if (value === CONN_STRING) {
              setPgUseConnString(true);
              flow.next();
              return;
            }
            setPgUseConnString(false);
            const instance = pgByName.get(value);
            if (instance) applyPostgresSelection(instance);
            flow.next();
          }}
          onManual={() => {
            setPgUseConnString(false);
            flow.next();
          }}
        />
      ),
    },
    {
      id: "pg-conn",
      onEscape: () => setPgUseConnString(false),
      render: (flow) => (
        <TextField
          label="Postgres connection string"
          hint="Parsed into the fields below (you can review them next). Use the admin/master user."
          value={pgConn}
          onChange={setPgConn}
          placeholder="postgresql://postgres:pass@host:5432/postgres"
          mask
          onSubmit={() => {
            const parsed = parsePostgresUrl(pgConn);
            if (!parsed || !parsed.host) {
              setError(
                "Enter a valid connection string, e.g. postgresql://user:pass@host:5432/postgres",
              );
              return;
            }
            setPgHost(parsed.host);
            if (parsed.port) setPgPort(String(parsed.port));
            if (parsed.database) setPgDatabase(parsed.database);
            if (parsed.user) setPgMasterUser(parsed.user);
            if (parsed.password) setPgMasterPass(parsed.password);
            save({
              postgresHost: parsed.host,
              ...(parsed.port ? { postgresPort: parsed.port } : {}),
              ...(parsed.database ? { postgresDatabase: parsed.database } : {}),
              ...(parsed.user ? { postgresMasterUsername: parsed.user } : {}),
              ...(parsed.password
                ? { postgresMasterPassword: parsed.password }
                : {}),
            });
            setError(null);
            flow.next();
          }}
        />
      ),
    },
    {
      id: "pg-host",
      render: (flow) => (
        <TextField
          label={provider === "aws" ? "RDS endpoint" : "Server host"}
          hint={
            provider === "aws"
              ? "Writer/instance endpoint. Use the direct endpoint (not a proxy/pooler)."
              : "Fully-qualified server name or address."
          }
          value={pgHost}
          onChange={setPgHost}
          placeholder={
            provider === "aws"
              ? "db.cluster-xxxx.us-east-1.rds.amazonaws.com"
              : provider === "azure"
                ? "myserver.postgres.database.azure.com"
                : "10.10.0.3"
          }
          onSubmit={() => {
            if (!pgHost.trim()) {
              setError("Database host/endpoint is required.");
              return;
            }
            setError(null);
            save({ postgresHost: pgHost.trim() });
            flow.next();
          }}
        />
      ),
    },
    {
      id: "pg-port",
      render: (flow) => (
        <TextField
          label="Database port"
          value={pgPort}
          onChange={setPgPort}
          placeholder="5432"
          onSubmit={() => {
            save({ postgresPort: Number.parseInt(pgPort, 10) || 5432 });
            flow.next();
          }}
        />
      ),
    },
    {
      id: "pg-database",
      render: (flow) => (
        <TextField
          label="Database name"
          hint="The database Supabase services connect to."
          value={pgDatabase}
          onChange={setPgDatabase}
          placeholder="postgres"
          onSubmit={() => {
            save({ postgresDatabase: pgDatabase.trim() || "postgres" });
            flow.next();
          }}
        />
      ),
    },
    {
      id: "pg-master-username",
      render: (flow) => (
        <TextField
          label="Master/admin username"
          hint={`${pgName} admin username. Used once to create roles/schemas.`}
          value={pgMasterUser}
          onChange={setPgMasterUser}
          placeholder="postgres"
          onSubmit={() => {
            save({ postgresMasterUsername: pgMasterUser.trim() || "postgres" });
            flow.next();
          }}
        />
      ),
    },
    {
      id: "pg-master-password",
      render: (flow) => (
        <TextField
          label="Master/admin password"
          hint="Used by the one-time bootstrap to initialize the database. Stored in a short-lived secret."
          value={pgMasterPass}
          onChange={setPgMasterPass}
          mask
          onSubmit={() => {
            if (!pgMasterPass) {
              setError(
                "Master password is required to initialize the database (roles, schemas).",
              );
              return;
            }
            setError(null);
            flow.next();
          }}
        />
      ),
    },
  ];

  const fields: FlowField[] = fieldDefs.map((field) => ({
    ...field,
    when: () => fieldOrder.has(field.id),
  }));

  const flow = useFieldFlow({
    fields,
    onDone: persist,
    onExit: onBack,
    entry: entryDirection === "back" ? "end" : "start",
    onNavigate: () => setError(null),
  });

  return (
    <BorderBox title="External Services">
      <Box flexDirection="column" marginY={1}>
        <Text>Managed services for Rulebricks.</Text>
        <Text color="gray" dimColor>
          By default Redis and Kafka run in-cluster, managed by the chart. You
          can instead connect to managed providers you already operate
          {pgAvailable ? ", including your Postgres database." : "."}
        </Text>
      </Box>

      {flow.render()}

      <FieldError error={error} />
      <StepFooter />
    </BorderBox>
  );
}
