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
  | "kafka-custom-password";

type Externalize = "redis" | "kafka" | "both";

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

const WHICH_OPTIONS: { label: string; value: Externalize }[] = [
  { label: "Redis only", value: "redis" },
  { label: "Kafka only", value: "kafka" },
  { label: "Both Redis and Kafka", value: "both" },
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

function defaultPresetForCloud(provider: string | null): KafkaPreset {
  if (provider === "aws") return "aws-msk-iam";
  if (provider === "azure") return "azure-event-hubs";
  if (provider === "gcp") return "gcp-managed";
  return "custom";
}

export function ExternalServicesStep({
  onComplete,
  onBack,
}: ExternalServicesStepProps) {
  const { state, dispatch } = useWizard();
  const { colors } = useTheme();

  const [field, setField] = useState<Field>("mode");
  const [error, setError] = useState<string | null>(null);

  // Which services to externalize when connecting to existing providers.
  const initialExternalize: Externalize =
    state.redisMode === "external" && state.kafkaMode !== "external"
      ? "redis"
      : state.kafkaMode === "external" && state.redisMode !== "external"
        ? "kafka"
        : "both";
  const [externalize, setExternalize] =
    useState<Externalize>(initialExternalize);
  const redisChosen = externalize === "redis" || externalize === "both";
  const kafkaChosen = externalize === "kafka" || externalize === "both";

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

  const persist = (
    redisExternal: boolean,
    kafkaExternal: boolean,
    overrides: { customSsl?: boolean } = {},
  ) => {
    const redisMode = redisExternal ? "external" : "embedded";
    const kafkaMode = kafkaExternal ? "external" : "embedded";

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
      },
    });
    onComplete();
  };

  // After Redis details, go on to Kafka if chosen, otherwise finish.
  const continueAfterRedis = () => {
    if (kafkaChosen) setField("kafka-preset");
    else persist(true, false);
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
        if (redisPassword) continueAfterRedis();
        else setField("redis-existing-secret");
        return;
      case "redis-existing-secret":
        continueAfterRedis();
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
        persist(redisChosen, true);
        return;
      case "kafka-azure-connection":
        if (!azureConnection.trim()) {
          setError("Event Hubs connection string is required.");
          return;
        }
        persist(redisChosen, true);
        return;
      case "kafka-gcp-username":
        setField("kafka-gcp-password");
        return;
      case "kafka-gcp-password":
        persist(redisChosen, true);
        return;
      case "kafka-custom-username":
        setField("kafka-custom-password");
        return;
      case "kafka-custom-password":
        persist(redisChosen, true);
        return;
    }
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
        setField("which");
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
        setField(redisChosen ? "redis-password" : "which");
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
    }
  };

  useInput((_input, key) => {
    if (key.escape) {
      handleBack();
    }
  });

  // ===== Select handlers =====
  const handleModeSelect = (item: { value: string }) => {
    if (item.value === "dedicated") {
      persist(false, false);
      return;
    }
    setField("which");
  };

  const handleWhichSelect = (item: { value: string }) => {
    const choice = item.value as Externalize;
    setExternalize(choice);
    setField(choice === "kafka" ? "kafka-preset" : "redis-host");
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
    // A SASL mechanism needs credentials next; SSL-only finishes here. Pass the
    // freshly chosen ssl value to avoid reading stale state.
    if (customMechanism) {
      setField("kafka-custom-username");
    } else {
      persist(redisChosen, true, { customSsl: ssl });
    }
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
        <Text>Redis and Kafka for Rulebricks.</Text>
        <Text color="gray" dimColor>
          By default these run in-cluster, managed by the chart. You can instead
          connect to managed providers you already operate.
        </Text>
      </Box>

      {field === "mode" &&
        renderSelect(
          "How should Redis and Kafka be provided?",
          MODE_OPTIONS,
          handleModeSelect,
          state.redisMode === "external" || state.kafkaMode === "external"
            ? 1
            : 0,
        )}

      {field === "which" &&
        renderSelect(
          "Which services do you want to connect to existing providers?",
          WHICH_OPTIONS.map((o) => ({ label: o.label, value: o.value })),
          handleWhichSelect,
          Math.max(
            0,
            WHICH_OPTIONS.findIndex((o) => o.value === externalize),
          ),
          "* Managed Kafka may require admin setup (topics/partitions) outside the CLI. The CLI just collects connection info to get the chart running.",
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
