import React, { useState } from "react";
import { Box, Text, useInput } from "ink";
import SelectInput from "ink-select-input";
import TextInput from "ink-text-input";
import { useWizard } from "../WizardContext.js";
import { BorderBox, useTheme } from "../../common/index.js";
import { SMTP_PROVIDERS } from "../../../types/index.js";
import { isValidEmail } from "../../../lib/validation.js";

interface SMTPStepProps {
  onComplete: () => void;
  onBack: () => void;
}

type SubStep =
  | "provider"
  | "host"
  | "port"
  | "user"
  | "pass"
  | "from"
  | "fromName";

const PROVIDER_ITEMS = [
  { label: "AWS SES", value: "aws-ses" },
  { label: "SendGrid", value: "sendgrid" },
  { label: "Resend", value: "resend" },
  { label: "Mailgun", value: "mailgun" },
  { label: "Postmark", value: "postmark" },
  { label: "Mailtrap (testing)", value: "mailtrap" },
  { label: "Custom SMTP Server", value: "custom" },
];

// Detect which provider preset matches a given SMTP host
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

export function SMTPStep({ onComplete, onBack }: SMTPStepProps) {
  const { state, dispatch } = useWizard();
  const { colors } = useTheme();

  // Determine initial step based on whether we have pre-populated SMTP settings
  const getInitialSubStep = (): SubStep => {
    // If we have pre-populated SMTP host from profile, skip provider selection
    if (state.smtpHost && state.smtpUser) {
      return "pass"; // Start at password entry (most sensitive, likely needs re-entry)
    }
    if (state.smtpHost) {
      return "user"; // Have host but no user
    }
    return "provider"; // Fresh start
  };

  const [subStep, setSubStep] = useState<SubStep>(getInitialSubStep);
  const [provider, setProvider] = useState<string>(
    detectProviderFromHost(state.smtpHost) || "",
  );
  const [host, setHost] = useState(state.smtpHost || "");
  const [port, setPort] = useState(state.smtpPort?.toString() || "587");
  const [user, setUser] = useState(state.smtpUser || "");
  const [pass, setPass] = useState(state.smtpPass || "");
  const [from, setFrom] = useState(state.smtpFrom || "");
  const [fromName, setFromName] = useState(state.smtpFromName || "Rulebricks");
  const [error, setError] = useState<string | null>(null);

  useInput((input, key) => {
    if (key.escape) {
      setError(null);
      if (subStep === "provider") {
        onBack();
      } else if (subStep === "host") {
        setSubStep("provider");
      } else if (subStep === "port") {
        setSubStep("host");
      } else if (subStep === "user") {
        // If we started with pre-populated settings, going back goes to provider
        if (getInitialSubStep() === "user") {
          setSubStep("provider");
        } else {
          setSubStep("port");
        }
      } else if (subStep === "pass") {
        // If we started with pre-populated settings, going back from pass goes to user
        setSubStep("user");
      } else if (subStep === "from") {
        setSubStep("pass");
      } else if (subStep === "fromName") {
        setSubStep("from");
      }
    }
  });

  const handleProviderSelect = (item: { value: string }) => {
    setProvider(item.value);
    const providerConfig =
      SMTP_PROVIDERS[item.value as keyof typeof SMTP_PROVIDERS];

    if (providerConfig) {
      setHost(providerConfig.host);
      setPort(providerConfig.port.toString());
      // Pre-fill user if provider has a default (like Resend)
      if (providerConfig.user) {
        setUser(providerConfig.user);
      }
    }

    if (item.value === "custom") {
      setSubStep("host");
    } else {
      setSubStep("user");
    }
  };

  const handleHostSubmit = () => {
    if (!host) {
      setError("SMTP host is required");
      return;
    }
    setError(null);
    setSubStep("port");
  };

  const handlePortSubmit = () => {
    const portNum = parseInt(port, 10);
    if (isNaN(portNum) || portNum < 1 || portNum > 65535) {
      setError("Port must be between 1 and 65535");
      return;
    }
    setError(null);
    setSubStep("user");
  };

  const handleUserSubmit = () => {
    if (!user) {
      setError("SMTP username is required");
      return;
    }
    setError(null);
    setSubStep("pass");
  };

  const handlePassSubmit = () => {
    if (!pass) {
      setError("SMTP password is required");
      return;
    }
    setError(null);
    setSubStep("from");
  };

  const handleFromSubmit = () => {
    if (!from) {
      setError("From address is required");
      return;
    }
    if (!isValidEmail(from)) {
      setError("Invalid email format");
      return;
    }
    setError(null);
    setSubStep("fromName");
  };

  const handleFromNameSubmit = () => {
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

    onComplete();
  };

  const getCompletedFields = () => {
    const fields: { label: string; value: string }[] = [];
    if (host) fields.push({ label: "Host", value: host });
    if (port && subStep !== "port") fields.push({ label: "Port", value: port });
    if (user && subStep !== "user") fields.push({ label: "User", value: user });
    if (pass && subStep !== "pass")
      fields.push({ label: "Password", value: "••••••••" });
    if (from && subStep !== "from") fields.push({ label: "From", value: from });
    return fields;
  };

  return (
    <BorderBox title="Email (SMTP)">
      <Box flexDirection="column" marginY={1}>
        <Text color="gray" dimColor>
          Configure SMTP for user invitations, password resets, and
          notifications
        </Text>
      </Box>

      {subStep === "provider" && (
        <Box flexDirection="column" marginY={1}>
          <Text>Select your email provider:</Text>
          <Box marginTop={1}>
            <SelectInput
              items={PROVIDER_ITEMS}
              onSelect={handleProviderSelect}
              itemComponent={({ isSelected, label }) => (
                <Text color={isSelected ? colors.accent : undefined}>
                  {label}
                </Text>
              )}
            />
          </Box>
        </Box>
      )}

      {subStep === "host" && (
        <Box flexDirection="column" marginY={1}>
          <Text>Enter SMTP server hostname:</Text>
          <Box marginTop={1}>
            <TextInput
              value={host}
              onChange={setHost}
              onSubmit={handleHostSubmit}
              placeholder="smtp.example.com"
            />
          </Box>
        </Box>
      )}

      {subStep === "port" && (
        <Box flexDirection="column" marginY={1}>
          <Text>Enter SMTP port:</Text>
          <Text color="gray" dimColor>
            Common ports: 25, 465 (SSL), 587 (TLS), 2525
          </Text>
          <Box marginTop={1}>
            <TextInput
              value={port}
              onChange={setPort}
              onSubmit={handlePortSubmit}
              placeholder="587"
            />
          </Box>
          {getCompletedFields().map((f) => (
            <Box key={f.label}>
              <Text color="green">✓</Text>
              <Text color="gray">
                {" "}
                {f.label}: {f.value}
              </Text>
            </Box>
          ))}
        </Box>
      )}

      {subStep === "user" && (
        <Box flexDirection="column" marginY={1}>
          <Text>Enter SMTP username:</Text>
          <Box marginTop={1}>
            <TextInput
              value={user}
              onChange={setUser}
              onSubmit={handleUserSubmit}
              placeholder="smtp_username"
            />
          </Box>
          {getCompletedFields().map((f) => (
            <Box key={f.label}>
              <Text color="green">✓</Text>
              <Text color="gray">
                {" "}
                {f.label}: {f.value}
              </Text>
            </Box>
          ))}
        </Box>
      )}

      {subStep === "pass" && (
        <Box flexDirection="column" marginY={1}>
          <Text>Enter SMTP password:</Text>
          <Box marginTop={1}>
            <TextInput
              value={pass}
              onChange={setPass}
              onSubmit={handlePassSubmit}
              placeholder="••••••••"
              mask="*"
            />
          </Box>
          {getCompletedFields().map((f) => (
            <Box key={f.label}>
              <Text color="green">✓</Text>
              <Text color="gray">
                {" "}
                {f.label}: {f.value}
              </Text>
            </Box>
          ))}
        </Box>
      )}

      {subStep === "from" && (
        <Box flexDirection="column" marginY={1}>
          <Text>Enter sender email address:</Text>
          <Text color="gray" dimColor>
            This must be verified with your email provider
          </Text>
          <Box marginTop={1}>
            <TextInput
              value={from}
              onChange={setFrom}
              onSubmit={handleFromSubmit}
              placeholder="no-reply@yourdomain.com"
            />
          </Box>
          {getCompletedFields().map((f) => (
            <Box key={f.label}>
              <Text color="green">✓</Text>
              <Text color="gray">
                {" "}
                {f.label}: {f.value}
              </Text>
            </Box>
          ))}
        </Box>
      )}

      {subStep === "fromName" && (
        <Box flexDirection="column" marginY={1}>
          <Text>Enter sender display name:</Text>
          <Box marginTop={1}>
            <TextInput
              value={fromName}
              onChange={setFromName}
              onSubmit={handleFromNameSubmit}
              placeholder="Rulebricks"
            />
          </Box>
          {getCompletedFields().map((f) => (
            <Box key={f.label}>
              <Text color="green">✓</Text>
              <Text color="gray">
                {" "}
                {f.label}: {f.value}
              </Text>
            </Box>
          ))}
        </Box>
      )}

      {error && (
        <Box marginTop={1}>
          <Text color="red">✗ {error}</Text>
        </Box>
      )}

      <Box marginTop={1}>
        <Text color="gray" dimColor>
          Esc to go back • Enter to continue
        </Text>
      </Box>
    </BorderBox>
  );
}
