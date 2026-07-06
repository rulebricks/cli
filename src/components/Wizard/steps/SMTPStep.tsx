import React, { useState } from "react";
import { Box, Text } from "ink";
import { useWizard } from "../WizardContext.js";
import { useFieldFlow, FlowField } from "../fieldFlow.js";
import {
  BorderBox,
  CheckRows,
  FieldError,
  StepFooter,
  TextField,
  WizardSelect,
} from "../../common/index.js";
import { SMTP_PROVIDERS } from "../../../types/index.js";
import { isValidEmail } from "../../../lib/validation.js";

interface SMTPStepProps {
  onComplete: () => void;
  onBack: () => void;
  entryDirection?: "forward" | "back";
}

const PROVIDER_ITEMS = [
  { label: "AWS SES", value: "aws-ses" },
  { label: "SendGrid", value: "sendgrid" },
  { label: "Resend", value: "resend" },
  { label: "Mailgun", value: "mailgun" },
  { label: "Postmark", value: "postmark" },
  { label: "Mailtrap (testing)", value: "mailtrap" },
  { label: "Custom SMTP Server", value: "custom" },
];

// Detect which provider preset matches a given SMTP host, so saved settings
// preselect the right provider instead of skipping the prompt.
function detectProviderFromHost(host: string): string | null {
  if (!host) return null;
  const hostLower = host.toLowerCase();

  if (hostLower.includes("amazonaws.com") || hostLower.includes("ses"))
    return "aws-ses";
  if (hostLower.includes("sendgrid")) return "sendgrid";
  if (hostLower.includes("resend")) return "resend";
  if (hostLower.includes("mailgun")) return "mailgun";
  if (hostLower.includes("postmark")) return "postmark";
  if (hostLower.includes("mailtrap")) return "mailtrap";

  return "custom";
}

export function SMTPStep({ onComplete, onBack, entryDirection }: SMTPStepProps) {
  const { state, dispatch } = useWizard();
  const [error, setError] = useState<string | null>(null);

  const detectedProvider = detectProviderFromHost(state.smtpHost);
  const [provider, setProvider] = useState<string>(detectedProvider ?? "");
  const [host, setHost] = useState(state.smtpHost || "");
  const [port, setPort] = useState(state.smtpPort?.toString() || "587");
  const [user, setUser] = useState(state.smtpUser || "");
  const [pass, setPass] = useState(state.smtpPass || "");
  const [from, setFrom] = useState(state.smtpFrom || "");
  const [fromName, setFromName] = useState(state.smtpFromName || "Rulebricks");

  const completed = (): { label: string; value: string }[] => {
    const rows: { label: string; value: string }[] = [];
    if (host) rows.push({ label: "Host", value: `${host}:${port}` });
    if (user) rows.push({ label: "User", value: user });
    return rows;
  };

  const fields: FlowField[] = [
    {
      id: "provider",
      render: (flow) => (
        <WizardSelect
          label="Select your email provider"
          items={PROVIDER_ITEMS}
          initialValue={provider || undefined}
          onSelect={(value) => {
            const changed = value !== provider;
            setProvider(value);
            const providerConfig =
              SMTP_PROVIDERS[value as keyof typeof SMTP_PROVIDERS];
            // Apply preset host/port/user when switching providers or when the
            // fields are still empty; keep saved values otherwise.
            if (providerConfig && (changed || !host)) {
              setHost(providerConfig.host);
              setPort(providerConfig.port.toString());
              if (providerConfig.user && (changed || !user)) {
                setUser(providerConfig.user);
              }
              dispatch({
                type: "SET_SMTP",
                config: {
                  smtpHost: providerConfig.host,
                  smtpPort: providerConfig.port,
                },
              });
            }
            flow.next();
          }}
        />
      ),
    },
    {
      id: "host",
      when: () => provider === "custom",
      render: (flow) => (
        <TextField
          label="SMTP server hostname"
          value={host}
          onChange={setHost}
          placeholder="smtp.example.com"
          onSubmit={() => {
            if (!host) {
              setError("SMTP host is required");
              return;
            }
            setError(null);
            dispatch({ type: "SET_SMTP", config: { smtpHost: host } });
            flow.next();
          }}
        />
      ),
    },
    {
      id: "port",
      when: () => provider === "custom",
      render: (flow) => (
        <TextField
          label="SMTP port"
          hint="Common ports: 25, 465 (SSL), 587 (TLS), 2525"
          value={port}
          onChange={setPort}
          placeholder="587"
          onSubmit={() => {
            const portNum = parseInt(port, 10);
            if (isNaN(portNum) || portNum < 1 || portNum > 65535) {
              setError("Port must be between 1 and 65535");
              return;
            }
            setError(null);
            dispatch({ type: "SET_SMTP", config: { smtpPort: portNum } });
            flow.next();
          }}
        />
      ),
    },
    {
      id: "user",
      render: (flow) => (
        <TextField
          label="SMTP username"
          value={user}
          onChange={setUser}
          placeholder="smtp_username"
          onSubmit={() => {
            if (!user) {
              setError("SMTP username is required");
              return;
            }
            setError(null);
            dispatch({ type: "SET_SMTP", config: { smtpUser: user } });
            flow.next();
          }}
        />
      ),
    },
    {
      id: "pass",
      render: (flow) => (
        <TextField
          label="SMTP password"
          value={pass}
          onChange={setPass}
          mask
          onSubmit={() => {
            if (!pass) {
              setError("SMTP password is required");
              return;
            }
            setError(null);
            dispatch({ type: "SET_SMTP", config: { smtpPass: pass } });
            flow.next();
          }}
        />
      ),
    },
    {
      id: "from",
      render: (flow) => (
        <TextField
          label="Sender email address"
          hint="This must be verified with your email provider"
          value={from}
          onChange={setFrom}
          placeholder="no-reply@yourdomain.com"
          onSubmit={() => {
            if (!from) {
              setError("From address is required");
              return;
            }
            if (!isValidEmail(from)) {
              setError("Invalid email format");
              return;
            }
            setError(null);
            dispatch({ type: "SET_SMTP", config: { smtpFrom: from } });
            flow.next();
          }}
        />
      ),
    },
    {
      id: "fromName",
      render: (flow) => (
        <TextField
          label="Sender display name"
          value={fromName}
          onChange={setFromName}
          placeholder="Rulebricks"
          onSubmit={() => {
            if (!fromName) {
              setError("From name is required");
              return;
            }
            setError(null);
            dispatch({
              type: "SET_SMTP",
              config: {
                smtpHost: host,
                smtpPort: parseInt(port, 10),
                smtpUser: user,
                smtpPass: pass,
                smtpFrom: from,
                smtpFromName: fromName,
              },
            });
            flow.next();
          }}
        />
      ),
    },
  ];

  const flow = useFieldFlow({
    fields,
    onDone: onComplete,
    onExit: onBack,
    entry: entryDirection === "back" ? "end" : "start",
    onNavigate: () => setError(null),
  });

  return (
    <BorderBox title="Email (SMTP)">
      <Box flexDirection="column" marginY={1}>
        <Text color="gray" dimColor>
          Configure SMTP for user invitations, password resets, and
          notifications
        </Text>
      </Box>

      {flow.render()}

      {flow.current !== "provider" && <CheckRows rows={completed()} />}
      <FieldError error={error} />
      <StepFooter />
    </BorderBox>
  );
}
