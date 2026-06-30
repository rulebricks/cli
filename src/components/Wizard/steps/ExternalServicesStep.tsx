import React, { useState } from "react";
import { Box, Text, useInput } from "ink";
import TextInput from "ink-text-input";
import SelectInput from "ink-select-input";
import { useWizard } from "../WizardContext.js";
import { BorderBox, useTheme } from "../../common/index.js";
import { KafkaPreset } from "../../../types/index.js";

interface ExternalServicesStepProps {
  onComplete: () => void;
  onBack: () => void;
}

type Field =
  | "mode"
  | "which"
  | "redis-host"
  | "redis-port"
  | "redis-tls"
  | "redis-password"
  | "redis-existing-secret"
  | "kafka-preset"
  | "kafka-brokers"
  | "kafka-topic-prefix"
  | "kafka-aws-region"
  | "kafka-aws-role"
  | "kafka-azure-connection"
  | "kafka-gcp-username"
  | "kafka-gcp-password"
  | "kafka-custom-mechanism"
  | "kafka-custom-ssl"
  | "kafka-custom-username"
  | "kafka-custom-password"
  | "pg-input-mode"
  | "pg-conn"
  | "pg-host"
  | "pg-port"
  | "pg-database"
  | "pg-master-username"
  | "pg-master-password";

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
    hint: "Pod identity (IRSA). Vector uses a kafka-proxy bridge sidecar.",
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

const PG_INPUT_MODES = [
  {
    label: "Enter connection details (AWS RDS / Azure)",
    value: "structured",
  },
  { label: "Paste a Postgres connection string", value: "connstring" },
];

function defaultPresetForCloud(provider: string | null): KafkaPreset {
  if (provider === "aws") return "aws-msk-iam";
  if (provider === "azure") return "azure-event-hubs";
  if (provider === "gcp") return "gcp-managed";
  return "custom";
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

const SERVICE_ORDER: ServiceKey[] = ["redis", "kafka", "postgres"];

export function ExternalServicesStep({
  onComplete,
  onBack,
}: ExternalServicesStepProps) {
  const { state, dispatch } = useWizard();
  const { colors } = useTheme();

  const [field, setField] = useState<Field>("mode");
  const [error, setError] = useState<string | null>(null);

  // Postgres external is only offered for self-hosted Supabase (there is no
  // in-cluster database to externalize with Supabase Cloud) on providers we
  // support a managed flow for.
  const pgAvailable =
    (state.provider === "aws" || state.provider === "azure") &&
    state.databaseType === "self-hosted";

  // Multi-select of which services to connect to existing/managed providers.
  const [selected, setSelected] = useState<Record<ServiceKey, boolean>>({
    redis: state.redisMode === "external",
    kafka: state.kafkaMode === "external",
    postgres: pgAvailable && state.postgresMode === "external",
  });
  const whichItems: { key: ServiceKey; label: string; hint: string }[] = [
    { key: "redis", label: "Redis", hint: "Managed cache (ElastiCache, etc.)" },
    { key: "kafka", label: "Kafka", hint: "Managed event streaming (MSK, Event Hubs, etc.)" },
    ...(pgAvailable
      ? [
          {
            key: "postgres" as ServiceKey,
            label: "Postgres database",
            hint:
              state.provider === "aws"
                ? "Managed RDS / Aurora for the Supabase database."
                : "Azure Flexible Server for the Supabase database.",
          },
        ]
      : []),
  ];
  const [whichIndex, setWhichIndex] = useState(0);

  // Redis
  const [redisHost, setRedisHost] = useState(state.redisHost);
  const [redisPort, setRedisPort] = useState(String(state.redisPort || 6379));
  const [redisTls, setRedisTls] = useState(state.redisTls);
  const [redisPassword, setRedisPassword] = useState(state.redisPassword);
  const [redisExistingSecret, setRedisExistingSecret] = useState(
    state.redisExistingSecret,
  );

  // Kafka
  const initialPreset =
    state.kafkaPreset ?? defaultPresetForCloud(state.provider);
  const [presetIndex, setPresetIndex] = useState(
    Math.max(0, PRESETS.findIndex((p) => p.id === initialPreset)),
  );
  const preset = PRESETS[presetIndex]?.id ?? "custom";
  const [brokers, setBrokers] = useState(state.kafkaBrokers);
  const [topicPrefix, setTopicPrefix] = useState(
    state.kafkaTopicPrefix || "com.rulebricks.",
  );
  const [awsRegion, setAwsRegion] = useState(
    state.kafkaSaslRegion || state.region,
  );
  const [awsRole, setAwsRole] = useState(state.kafkaIdentityAwsRoleArn);
  const [azureConnection, setAzureConnection] = useState(
    state.kafkaSaslPassword,
  );
  const [gcpUsername, setGcpUsername] = useState(state.kafkaSaslUsername);
  const [gcpPassword, setGcpPassword] = useState(state.kafkaSaslPassword);
  const [mechIndex, setMechIndex] = useState(
    Math.max(0, CUSTOM_MECH.findIndex((m) => m.id === state.kafkaSaslMechanism)),
  );
  const customMechanism = CUSTOM_MECH[mechIndex]?.id ?? "";
  const [customSsl, setCustomSsl] = useState(state.kafkaSsl);
  const [customUsername, setCustomUsername] = useState(state.kafkaSaslUsername);
  const [customPassword, setCustomPassword] = useState(state.kafkaSaslPassword);

  // Postgres
  const [pgModeIndex, setPgModeIndex] = useState(0);
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

  // ----- chaining across the chosen services -----
  const chosen = (): ServiceKey[] => SERVICE_ORDER.filter((k) => selected[k]);
  const firstFieldOf = (k: ServiceKey): Field =>
    k === "redis"
      ? "redis-host"
      : k === "kafka"
        ? "kafka-preset"
        : "pg-input-mode";
  const goToFirstService = () => {
    const order = chosen();
    if (order.length === 0) {
      persist({});
      return;
    }
    setField(firstFieldOf(order[0]));
  };
  const isLastChosen = (k: ServiceKey) => {
    const order = chosen();
    return order[order.length - 1] === k;
  };
  const goAfter = (k: ServiceKey, overrides: { customSsl?: boolean } = {}) => {
    const order = chosen();
    const next = order[order.indexOf(k) + 1];
    if (next) setField(firstFieldOf(next));
    else persist(overrides);
  };

  const persist = (overrides: { customSsl?: boolean }) => {
    const redisExternal = selected.redis;
    const kafkaExternal = selected.kafka;
    const postgresExternal = selected.postgres;
    const redisMode = redisExternal ? "external" : "embedded";
    const kafkaMode = kafkaExternal ? "external" : "embedded";
    const postgresMode = postgresExternal ? "external" : "embedded";

    // Derive Kafka SASL/SSL/identity from the chosen preset.
    let kafkaSsl = false;
    let mechanism: typeof state.kafkaSaslMechanism = "";
    let region = "";
    let username = "";
    let password = "";
    let awsRoleArn = "";

    if (kafkaMode === "external") {
      if (preset === "aws-msk-iam") {
        kafkaSsl = true;
        mechanism = "aws-iam";
        region = awsRegion.trim();
        awsRoleArn = awsRole.trim();
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
        kafkaSsl = overrides.customSsl ?? customSsl;
        mechanism = customMechanism as typeof state.kafkaSaslMechanism;
        username = customMechanism ? customUsername : "";
        password = customMechanism ? customPassword : "";
      }
    }

    dispatch({
      type: "SET_EXTERNAL_SERVICES",
      config: {
        redisMode,
        redisHost: redisExternal ? redisHost.trim() : "",
        redisPort: Number.parseInt(redisPort, 10) || 6379,
        redisPassword: redisExternal ? redisPassword : "",
        redisExistingSecret: redisExternal ? redisExistingSecret.trim() : "",
        redisTls: redisExternal ? redisTls : false,
        kafkaMode,
        kafkaPreset: kafkaMode === "external" ? preset : null,
        kafkaBrokers: kafkaMode === "external" ? brokers.trim() : "",
        kafkaTopicPrefix:
          kafkaMode === "external" ? topicPrefix.trim() : "com.rulebricks.",
        kafkaSsl,
        kafkaSaslMechanism: mechanism,
        kafkaSaslRegion: region,
        kafkaSaslUsername: username,
        kafkaSaslPassword: password,
        kafkaIdentityAwsRoleArn: awsRoleArn,
        kafkaIdentityGcpServiceAccountEmail: "",
        postgresMode,
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

  const firstKafkaAuthField = (): Field => {
    if (preset === "aws-msk-iam") return "kafka-aws-region";
    if (preset === "azure-event-hubs") return "kafka-azure-connection";
    if (preset === "gcp-managed") return "kafka-gcp-username";
    return "kafka-custom-mechanism";
  };

  // Forward navigation for text fields (selects advance in their onSelect).
  const advance = (from: Field) => {
    setError(null);
    switch (from) {
      case "redis-host":
        if (!redisHost.trim()) {
          setError("Redis host is required for an external instance.");
          return;
        }
        setField("redis-port");
        return;
      case "redis-port":
        setField("redis-tls");
        return;
      case "redis-password":
        if (redisPassword) goAfter("redis");
        else setField("redis-existing-secret");
        return;
      case "redis-existing-secret":
        goAfter("redis");
        return;
      case "kafka-brokers":
        if (!brokers.trim()) {
          setError("At least one broker is required for external Kafka.");
          return;
        }
        setField("kafka-topic-prefix");
        return;
      case "kafka-topic-prefix":
        setField(firstKafkaAuthField());
        return;
      case "kafka-aws-region":
        if (!awsRegion.trim()) {
          setError("Region is required for MSK IAM signing.");
          return;
        }
        setField("kafka-aws-role");
        return;
      case "kafka-aws-role":
        goAfter("kafka");
        return;
      case "kafka-azure-connection":
        if (!azureConnection.trim()) {
          setError("Event Hubs connection string is required.");
          return;
        }
        goAfter("kafka");
        return;
      case "kafka-gcp-username":
        setField("kafka-gcp-password");
        return;
      case "kafka-gcp-password":
        goAfter("kafka");
        return;
      case "kafka-custom-username":
        setField("kafka-custom-password");
        return;
      case "kafka-custom-password":
        goAfter("kafka");
        return;
      case "pg-conn": {
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
        // Confirm/edit the parsed values via the structured fields.
        setField("pg-host");
        return;
      }
      case "pg-host":
        if (!pgHost.trim()) {
          setError("Database host/endpoint is required.");
          return;
        }
        setField("pg-port");
        return;
      case "pg-port":
        setField("pg-database");
        return;
      case "pg-database":
        setField("pg-master-username");
        return;
      case "pg-master-username":
        setField("pg-master-password");
        return;
      case "pg-master-password":
        if (!pgMasterPass) {
          setError(
            "Master password is required to initialize the database (roles, schemas).",
          );
          return;
        }
        goAfter("postgres");
        return;
    }
  };

  const prevServiceField = (k: ServiceKey): Field => {
    const order = chosen();
    const prev = order[order.indexOf(k) - 1];
    if (!prev) return "which";
    // Land on the last field of the previous service.
    if (prev === "redis") return "redis-password";
    if (prev === "kafka") return "kafka-preset";
    return "pg-master-password";
  };

  const handleBack = () => {
    setError(null);
    switch (field) {
      case "mode":
        onBack();
        return;
      case "which":
        setField("mode");
        return;
      case "redis-host":
        setField(prevServiceField("redis"));
        return;
      case "redis-port":
        setField("redis-host");
        return;
      case "redis-tls":
        setField("redis-port");
        return;
      case "redis-password":
        setField("redis-tls");
        return;
      case "redis-existing-secret":
        setField("redis-password");
        return;
      case "kafka-preset":
        setField(prevServiceField("kafka"));
        return;
      case "kafka-brokers":
        setField("kafka-preset");
        return;
      case "kafka-topic-prefix":
        setField("kafka-brokers");
        return;
      case "kafka-aws-region":
      case "kafka-azure-connection":
      case "kafka-gcp-username":
      case "kafka-custom-mechanism":
        setField("kafka-topic-prefix");
        return;
      case "kafka-aws-role":
        setField("kafka-aws-region");
        return;
      case "kafka-gcp-password":
        setField("kafka-gcp-username");
        return;
      case "kafka-custom-ssl":
        setField("kafka-custom-mechanism");
        return;
      case "kafka-custom-username":
        setField("kafka-custom-ssl");
        return;
      case "kafka-custom-password":
        setField("kafka-custom-username");
        return;
      case "pg-input-mode":
        setField(prevServiceField("postgres"));
        return;
      case "pg-conn":
        setField("pg-input-mode");
        return;
      case "pg-host":
        setField("pg-input-mode");
        return;
      case "pg-port":
        setField("pg-host");
        return;
      case "pg-database":
        setField("pg-port");
        return;
      case "pg-master-username":
        setField("pg-database");
        return;
      case "pg-master-password":
        setField("pg-master-username");
        return;
    }
  };

  useInput((input, key) => {
    if (field === "which") {
      if (key.escape) {
        setField("mode");
        return;
      }
      if (key.upArrow) {
        setWhichIndex((i) => Math.max(0, i - 1));
      } else if (key.downArrow) {
        setWhichIndex((i) => Math.min(whichItems.length, i + 1));
      } else if (input === " " || input === "x") {
        if (whichIndex < whichItems.length) {
          const k = whichItems[whichIndex].key;
          setSelected((s) => ({ ...s, [k]: !s[k] }));
        }
      } else if (key.return) {
        if (whichIndex === whichItems.length) {
          if (!selected.redis && !selected.kafka && !selected.postgres) {
            setError("Select at least one service to externalize.");
            return;
          }
          setError(null);
          goToFirstService();
        } else {
          const k = whichItems[whichIndex].key;
          setSelected((s) => ({ ...s, [k]: !s[k] }));
        }
      }
      return;
    }
    if (key.escape) {
      handleBack();
    }
  });

  // ===== Select handlers =====
  const handleModeSelect = (item: { value: string }) => {
    if (item.value === "dedicated") {
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
    setField("which");
  };

  const handleRedisTlsSelect = (item: { value: string }) => {
    setRedisTls(item.value === "yes");
    setField("redis-password");
  };

  const handlePresetSelect = (item: { value: string }) => {
    setPresetIndex(Math.max(0, PRESETS.findIndex((p) => p.id === item.value)));
    setField("kafka-brokers");
  };

  const handleMechanismSelect = (item: { value: string }) => {
    setMechIndex(
      Math.max(0, CUSTOM_MECH.findIndex((m) => m.id === item.value)),
    );
    setField("kafka-custom-ssl");
  };

  const handleCustomSslSelect = (item: { value: string }) => {
    const ssl = item.value === "yes";
    setCustomSsl(ssl);
    // A SASL mechanism needs credentials next; SSL-only ends Kafka here. Pass the
    // freshly chosen ssl value to avoid reading stale state when persisting.
    if (customMechanism) {
      setField("kafka-custom-username");
    } else {
      goAfter("kafka", { customSsl: ssl });
    }
  };

  const handlePgModeSelect = (item: { value: string }) => {
    setPgModeIndex(
      Math.max(0, PG_INPUT_MODES.findIndex((m) => m.value === item.value)),
    );
    setField(item.value === "connstring" ? "pg-conn" : "pg-host");
  };

  // ===== Renderers =====
  const renderSelect = (
    label: string,
    items: { label: string; value: string }[],
    onSelect: (item: { value: string }) => void,
    initialIndex = 0,
    note?: string,
  ) => (
    <Box flexDirection="column" marginY={1}>
      <Text bold>{label}</Text>
      {note && (
        <Text color="gray" dimColor>
          {note}
        </Text>
      )}
      <Box marginTop={1} flexDirection="column">
        <SelectInput
          items={items}
          onSelect={onSelect}
          initialIndex={initialIndex}
          indicatorComponent={() => null}
          itemComponent={({ isSelected, label: itemLabel }) => (
            <Text color={isSelected ? colors.accent : undefined}>
              {isSelected ? "❯ " : "  "}
              {itemLabel}
            </Text>
          )}
        />
      </Box>
      <Text color={colors.muted}>↑/↓ to choose • Enter to continue</Text>
    </Box>
  );

  const renderText = (
    label: string,
    value: string,
    onChange: (v: string) => void,
    opts: { hint?: string; placeholder?: string; mask?: boolean } = {},
  ) => (
    <Box flexDirection="column" marginY={1}>
      <Text bold>{label}</Text>
      {opts.hint && (
        <Text color="gray" dimColor>
          {opts.hint}
        </Text>
      )}
      <Box marginTop={1}>
        <TextInput
          value={value}
          onChange={onChange}
          onSubmit={() => advance(field)}
          placeholder={opts.placeholder}
          mask={opts.mask ? "*" : undefined}
        />
      </Box>
    </Box>
  );

  return (
    <BorderBox title="External Services">
      <Box flexDirection="column" marginY={1}>
        <Text>Managed services for Rulebricks.</Text>
        <Text color="gray" dimColor>
          By default Redis and Kafka run in-cluster, managed by the chart. You can
          instead connect to managed providers you already operate
          {pgAvailable ? ", including your Postgres database." : "."}
        </Text>
      </Box>

      {field === "mode" &&
        renderSelect(
          "How should these services be provided?",
          MODE_OPTIONS,
          handleModeSelect,
          state.redisMode === "external" ||
            state.kafkaMode === "external" ||
            state.postgresMode === "external"
            ? 1
            : 0,
        )}

      {field === "which" && (
        <Box flexDirection="column" marginY={1}>
          <Text bold>Which services do you want to connect to managed providers?</Text>
          <Text color="gray" dimColor>
            Space/Enter to toggle • ↑/↓ to navigate
          </Text>
          <Box marginTop={1} flexDirection="column">
            {whichItems.map((item, index) => {
              const isCursor = index === whichIndex;
              const isOn = selected[item.key];
              return (
                <Box key={item.key} flexDirection="column">
                  <Box>
                    <Text color={isCursor ? colors.accent : undefined}>
                      {isCursor ? "❯ " : "  "}
                    </Text>
                    <Text color={isOn ? colors.success : colors.muted}>
                      {isOn ? "[✓]" : "[ ]"}
                    </Text>
                    <Text color={isCursor ? colors.accent : undefined}>
                      {" "}
                      {item.label}
                    </Text>
                  </Box>
                  {isCursor && (
                    <Box marginLeft={6}>
                      <Text color="gray" dimColor>
                        {item.hint}
                      </Text>
                    </Box>
                  )}
                </Box>
              );
            })}
            <Box marginTop={1}>
              <Text
                color={
                  whichIndex === whichItems.length ? colors.accent : colors.muted
                }
              >
                {whichIndex === whichItems.length ? "❯ " : "  "}
              </Text>
              <Text
                color={
                  whichIndex === whichItems.length
                    ? colors.success
                    : colors.muted
                }
                bold={whichIndex === whichItems.length}
              >
                [Continue →]
              </Text>
            </Box>
          </Box>
          {!pgAvailable && (
            <Text color="gray" dimColor>
              Externalizing the Postgres database is available on AWS and Azure.
            </Text>
          )}
        </Box>
      )}

      {field === "redis-host" &&
        renderText("Redis host", redisHost, setRedisHost, {
          hint: "Hostname of your managed Redis (e.g. ElastiCache/Memorystore endpoint).",
          placeholder: "redis.example.com",
        })}

      {field === "redis-port" &&
        renderText("Redis port", redisPort, setRedisPort, {
          placeholder: "6379",
        })}

      {field === "redis-tls" &&
        renderSelect(
          "Redis TLS",
          yesNo(
            "Yes - connect using rediss:// (TLS)",
            "No - plaintext redis://",
          ),
          handleRedisTlsSelect,
          redisTls ? 1 : 0,
        )}

      {field === "redis-password" &&
        renderText("Redis password", redisPassword, setRedisPassword, {
          hint: "Leave blank to use an existing secret or no auth.",
          mask: true,
        })}

      {field === "redis-existing-secret" &&
        renderText(
          "Redis password secret",
          redisExistingSecret,
          setRedisExistingSecret,
          {
            hint: "Name of an existing Kubernetes secret holding the password. Blank = no auth.",
            placeholder: "my-redis-auth",
          },
        )}

      {field === "kafka-preset" &&
        renderSelect(
          "Managed Kafka type",
          PRESETS.map((p) => ({ label: p.label, value: p.id })),
          handlePresetSelect,
          presetIndex,
          "* Topics/partitions may need to be created by a Kafka admin to match worker counts.",
        )}

      {field === "kafka-brokers" &&
        renderText("Kafka bootstrap brokers", brokers, setBrokers, {
          hint: "Comma-separated host:port list.",
          placeholder: "b-1.example:9098,b-2.example:9098",
        })}

      {field === "kafka-topic-prefix" &&
        renderText("Topic prefix", topicPrefix, setTopicPrefix, {
          hint: "Namespaces topic names (e.g. com.rulebricks.solution) to avoid collisions on shared Kafka. Blank = no prefix.",
          placeholder: "com.rulebricks.",
        })}

      {field === "kafka-aws-region" &&
        renderText("AWS region", awsRegion, setAwsRegion, {
          hint: "Region of the MSK cluster (used to sign IAM auth tokens).",
          placeholder: "us-east-1",
        })}

      {field === "kafka-aws-role" &&
        renderText("MSK IAM role ARN", awsRole, setAwsRole, {
          hint: "IRSA role for HPS and the Vector bridge. Blank if set on the SAs already.",
          placeholder: "arn:aws:iam::123456789012:role/msk-access",
        })}

      {field === "kafka-azure-connection" &&
        renderText(
          "Event Hubs connection string",
          azureConnection,
          setAzureConnection,
          {
            hint: "Namespace connection string (used as the SASL PLAIN password).",
            placeholder: "Endpoint=sb://...;SharedAccessKey=...",
            mask: true,
          },
        )}

      {field === "kafka-gcp-username" &&
        renderText("Kafka username", gcpUsername, setGcpUsername, {
          hint: "GCP service account principal for SASL PLAIN.",
          placeholder: "service-account@project.iam.gserviceaccount.com",
        })}

      {field === "kafka-gcp-password" &&
        renderText("Kafka password", gcpPassword, setGcpPassword, {
          hint: "Service-account key or access token.",
          mask: true,
        })}

      {field === "kafka-custom-mechanism" &&
        renderSelect(
          "SASL mechanism",
          CUSTOM_MECH.map((m) => ({ label: m.label, value: m.id })),
          handleMechanismSelect,
          mechIndex,
        )}

      {field === "kafka-custom-ssl" &&
        renderSelect(
          "Kafka TLS/SSL",
          yesNo("Yes - connect over TLS", "No - plaintext connection"),
          handleCustomSslSelect,
          customSsl ? 1 : 0,
        )}

      {field === "kafka-custom-username" &&
        renderText("Kafka SASL username", customUsername, setCustomUsername, {})}

      {field === "kafka-custom-password" &&
        renderText("Kafka SASL password", customPassword, setCustomPassword, {
          mask: true,
        })}

      {field === "pg-input-mode" &&
        renderSelect(
          state.provider === "aws"
            ? "How do you want to provide your RDS / Aurora connection?"
            : "How do you want to provide your Flexible Server connection?",
          PG_INPUT_MODES,
          handlePgModeSelect,
          pgModeIndex,
          "Self-hosted Supabase will run against this database. A one-time bootstrap initializes roles/schemas; provide the master/admin credentials.",
        )}

      {field === "pg-conn" &&
        renderText("Postgres connection string", pgConn, setPgConn, {
          hint: "Parsed into the fields below (you can review them next). Use the admin/master user.",
          placeholder: "postgresql://postgres:pass@host:5432/postgres",
          mask: true,
        })}

      {field === "pg-host" &&
        renderText(
          state.provider === "aws" ? "RDS endpoint" : "Server host",
          pgHost,
          setPgHost,
          {
            hint:
              state.provider === "aws"
                ? "Writer/instance endpoint. Use the direct endpoint (not a proxy/pooler)."
                : "Fully-qualified server name.",
            placeholder:
              state.provider === "aws"
                ? "db.cluster-xxxx.us-east-1.rds.amazonaws.com"
                : "myserver.postgres.database.azure.com",
          },
        )}

      {field === "pg-port" &&
        renderText("Database port", pgPort, setPgPort, { placeholder: "5432" })}

      {field === "pg-database" &&
        renderText("Database name", pgDatabase, setPgDatabase, {
          hint: "The database Supabase services connect to.",
          placeholder: "postgres",
        })}

      {field === "pg-master-username" &&
        renderText("Master/admin username", pgMasterUser, setPgMasterUser, {
          hint:
            state.provider === "aws"
              ? "RDS master username (recommended: postgres). Used once to create roles/schemas."
              : "Azure server admin username. Used once to create roles/schemas.",
          placeholder: "postgres",
        })}

      {field === "pg-master-password" &&
        renderText("Master/admin password", pgMasterPass, setPgMasterPass, {
          hint: "Used by the one-time bootstrap to initialize the database. Stored in a short-lived secret.",
          mask: true,
        })}

      {error && (
        <Box marginTop={1}>
          <Text color={colors.error}>✗ {error}</Text>
        </Box>
      )}

      <Box marginTop={1}>
        <Text color="gray" dimColor>
          Esc to go back
        </Text>
      </Box>
    </BorderBox>
  );
}
