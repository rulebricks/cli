import React, { useState } from "react";
import { Box, Text } from "ink";
import { useWizard } from "../WizardContext.js";
import { useFieldFlow, FlowField } from "../fieldFlow.js";
import {
  BorderBox,
  CheckRows,
  DiscoveredSelect,
  FieldError,
  StepFooter,
  TextField,
  WizardSelect,
} from "../../common/index.js";
import { Spinner } from "../../common/Spinner.js";
import { SMTP_PROVIDERS } from "../../../types/index.js";
import { isValidEmail } from "../../../lib/validation.js";
import {
  getAzureAcsResourceName,
  getAzureTenantId,
  buildAcsSmtpUsername,
  listAcsSenderAddresses,
} from "../../../lib/cloudCli.js";

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
  { label: "Azure Communication Services", value: "azure-acs" },
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
  if (hostLower.includes("azurecomm")) return "azure-acs";

  return "custom";
}

export function SMTPStep({
  onComplete,
  onBack,
  entryDirection,
}: SMTPStepProps) {
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

  // Azure Communication Services username assembly. The username is
  // <acs-resource>.<entra-app-client-id>.<tenant-id>: only the app client ID
  // is operator-supplied, so discover the other two from the deployment and
  // ask for just the app ID. acsAutoAssemble stays false when discovery finds
  // nothing (BYO ACS in another resource group) - then the plain username
  // field is shown instead.
  const [acsResource, setAcsResource] = useState<string | null>(null);
  const [acsTenant, setAcsTenant] = useState<string | null>(null);
  const [acsAppId, setAcsAppId] = useState("");
  const [acsDiscovering, setAcsDiscovering] = useState(false);
  const acsAutoAssemble = !!acsResource && !!acsTenant;
  // Set when the operator opts out of the discovered sender list.
  const [fromManual, setFromManual] = useState(false);

  const discoverAcs = async () => {
    setAcsDiscovering(true);
    try {
      const [resource, tenant] = await Promise.all([
        getAzureAcsResourceName(state.azureResourceGroup),
        getAzureTenantId(),
      ]);
      setAcsResource(resource);
      setAcsTenant(tenant);
    } catch {
      setAcsResource(null);
      setAcsTenant(null);
    }
    setAcsDiscovering(false);
  };

  const completed = (): { label: string; value: string }[] => {
    const rows: { label: string; value: string }[] = [];
    if (host) rows.push({ label: "Host", value: `${host}:${port}` });
    if (user) rows.push({ label: "User", value: user });
    return rows;
  };

  const fields: FlowField[] = [
    {
      id: "provider",
      // Discovery runs to completion before advancing (and renders its spinner
      // here, not as its own field): flow.render() always renders the current
      // field even after its `when` goes false, so a transient spinner field
      // would strand the wizard when discovery finds nothing.
      render: (flow) =>
        acsDiscovering ? (
          <Box flexDirection="column" marginY={1}>
            <Spinner label="Discovering the email service..." />
          </Box>
        ) : (
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
                if (changed) {
                  // A username saved for a DIFFERENT provider is never valid
                  // here - reset to the preset's user even when it is empty
                  // (e.g. profile-remembered "resend" leaking into the ACS
                  // username field).
                  setUser(providerConfig.user);
                } else if (providerConfig.user && !user) {
                  setUser(providerConfig.user);
                }
                dispatch({
                  type: "SET_SMTP",
                  config: {
                    smtpHost: providerConfig.host,
                    smtpPort: providerConfig.port,
                    ...(changed ? { smtpUser: providerConfig.user } : {}),
                  },
                });
              }
              // ACS: resolve the email service and tenant before advancing so
              // the next field is either the app-ID prompt (discovered) or the
              // plain username field (not discovered).
              if (value === "azure-acs") {
                void (async () => {
                  await discoverAcs();
                  flow.next();
                })();
                return;
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
      // ACS with a discovered resource: ask only for the Entra app client ID
      // and assemble the username. The client secret is entered next as the
      // password; deploy grants the app access to the ACS resource.
      id: "acs-app-id",
      when: () => provider === "azure-acs" && acsAutoAssemble,
      render: (flow) => (
        <TextField
          label="Email SMTP app (Entra application/client ID)"
          hint="The app ID from `az ad app create` for the Rulebricks SMTP app. Deploy grants it access automatically; its client secret is the password on the next screen."
          value={acsAppId}
          onChange={setAcsAppId}
          placeholder="00000000-0000-0000-0000-000000000000"
          onSubmit={() => {
            if (!acsAppId) {
              setError("The email SMTP app client ID is required");
              return;
            }
            const assembled = buildAcsSmtpUsername(
              acsResource ?? "",
              acsAppId,
              acsTenant ?? "",
            );
            setUser(assembled);
            setError(null);
            dispatch({ type: "SET_SMTP", config: { smtpUser: assembled } });
            flow.next();
          }}
        />
      ),
    },
    {
      id: "user",
      when: () => !(provider === "azure-acs" && acsAutoAssemble),
      render: (flow) => (
        <TextField
          label="SMTP username"
          hint={
            provider === "azure-acs"
              ? "Format: <acs-resource>.<entra-app-client-id>.<tenant-id> - the emailSmtpUsername value for your ACS resource"
              : undefined
          }
          value={user}
          onChange={setUser}
          placeholder={
            provider === "azure-acs"
              ? "rbcommxxxx.<app-id>.<tenant-id>"
              : "smtp_username"
          }
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
          hint={
            provider === "azure-acs"
              ? "The Entra app registration's client secret (az ad app credential reset)"
              : undefined
          }
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
      // ACS: every provisioned domain has a DoNotReply MailFrom, so offer the
      // real addresses (branded first when emailCustomDomain was set) instead
      // of asking the operator to transcribe one.
      id: "from-acs",
      when: () => provider === "azure-acs" && !fromManual,
      render: (flow) => (
        <DiscoveredSelect
          label="Sender email address"
          hint="Discovered from your Azure Communication Services email service"
          loadingLabel="Looking up sender addresses..."
          emptyHint="No sender domains found on the email service."
          initialValue={from || undefined}
          recommendIndex={(items) =>
            items.findIndex((i) => i.label.includes("branded"))
          }
          load={async () => {
            const senders = await listAcsSenderAddresses(
              state.azureResourceGroup,
            );
            return senders.map((s) => ({
              label: s.branded ? `${s.address}` : s.address,
              value: s.address,
            }));
          }}
          onSelect={(value) => {
            setFrom(value);
            setError(null);
            dispatch({ type: "SET_SMTP", config: { smtpFrom: value } });
            flow.next();
          }}
          onManual={() => {
            setFromManual(true);
            flow.next();
          }}
        />
      ),
    },
    {
      id: "from",
      when: () => !(provider === "azure-acs" && !fromManual),
      onEscape: () => setFromManual(false),
      render: (flow) => (
        <TextField
          label="Sender email address"
          hint={
            provider === "azure-acs"
              ? "Must be a DoNotReply address on a domain attached to your ACS email service"
              : "This must be verified with your email provider"
          }
          value={from}
          onChange={setFrom}
          placeholder={
            provider === "azure-acs"
              ? "DoNotReply@xxxx.azurecomm.net"
              : "no-reply@yourdomain.com"
          }
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
    <BorderBox title="Email">
      <Box flexDirection="column" marginY={1}>
        <Text color="gray" dimColor>
          Configure email delivery for user invitations, password resets, and
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
