import React, { useRef, useState } from "react";
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
  listAzureAcsResources,
  getAzureTenantId,
  buildAcsSmtpUsername,
  parseAcsSmtpAppClientId,
  parseAcsSmtpResourceName,
  listAcsSenderAddresses,
  listAzureEntraApps,
  recommendSmtpAppIndex,
  AzureAcsResource,
  AzureEntraApp,
} from "../../../lib/cloudCli.js";

/** Marks an ACS sender whose domain ownership check has not passed yet. */
const UNVERIFIED_SENDER_SUFFIX = "  - domain not verified yet";

interface SMTPStepProps {
  onComplete: () => void;
  onBack: () => void;
  entryDirection?: "forward" | "back";
}

const PROVIDER_ITEMS = [
  { label: "AWS SES", value: "aws-ses" },
  { label: "Azure Communication Services", value: "azure-acs" },
  { label: "SendGrid", value: "sendgrid" },
  { label: "Resend", value: "resend" },
  { label: "Mailgun", value: "mailgun" },
  { label: "Postmark", value: "postmark" },
  { label: "Mailtrap (testing)", value: "mailtrap" },
  { label: "Custom SMTP Server", value: "custom" },
];

/** The cloud's native email service - the usual enterprise choice. */
function nativeEmailProviderFor(cloud: string | null): string | null {
  switch (cloud) {
    case "aws":
      return "aws-ses";
    case "azure":
      return "azure-acs";
    default:
      return null;
  }
}

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
  const nativeEmailProvider = nativeEmailProviderFor(state.provider);
  // Preselection: the deployment's own saved provider (configure) wins;
  // on a fresh init the cloud-native recommendation outranks a provider
  // remembered from previous deployments (profile memory).
  const [provider, setProvider] = useState<string>(
    (state.configLoaded
      ? detectedProvider
      : (nativeEmailProvider ?? detectedProvider)) ?? "",
  );
  const providerItems = PROVIDER_ITEMS.map((item) =>
    item.value === nativeEmailProvider
      ? { ...item, label: `${item.label} (recommended)` }
      : item,
  ).sort(
    (a, b) =>
      Number(b.value === nativeEmailProvider) -
      Number(a.value === nativeEmailProvider),
  );
  const [host, setHost] = useState(state.smtpHost || "");
  const [port, setPort] = useState(state.smtpPort?.toString() || "587");
  const [user, setUser] = useState(state.smtpUser || "");
  const [pass, setPass] = useState(state.smtpPass || "");
  const [from, setFrom] = useState(state.smtpFrom || "");
  const [fromName, setFromName] = useState(state.smtpFromName || "Rulebricks");

  // Azure Communication Services username assembly. The username is
  // <acs-resource>.<entra-app-client-id>.<tenant-id>: the operator picks the
  // communication service and the Entra app, and the tenant comes from the
  // signed-in account. acsAutoAssemble stays false when the subscription holds
  // no communication service at all, or when the operator opts out - then the
  // plain username field is shown instead.
  const [acsResources, setAcsResources] = useState<AzureAcsResource[]>([]);
  const [acsResource, setAcsResource] = useState<string | null>(null);
  const [acsResourceGroup, setAcsResourceGroup] = useState("");
  // Set when the operator opts out of the discovered communication services.
  const [acsResourceManual, setAcsResourceManual] = useState(false);
  const [acsTenant, setAcsTenant] = useState<string | null>(null);
  const [acsAppId, setAcsAppId] = useState("");
  const [acsDiscovering, setAcsDiscovering] = useState(false);
  const acsAutoAssemble =
    acsResources.length > 0 && !!acsTenant && !acsResourceManual;
  // Set when the operator opts out of the discovered app-registration list.
  const [acsAppIdManual, setAcsAppIdManual] = useState(false);
  // Apps from the last discovery, aligned 1:1 with the select items (a ref:
  // recommendIndex runs in the same render the load resolves in).
  const entraAppsRef = useRef<AzureEntraApp[]>([]);
  // Same reason: the communication services behind the acs-resource items.
  const acsResourcesRef = useRef<AzureAcsResource[]>([]);
  // Set when the operator opts out of the discovered sender list.
  const [fromManual, setFromManual] = useState(false);

  // Runs before the ACS branch of the flow so it knows whether any
  // communication service exists to offer; the operator chooses which one on
  // the acs-resource screen.
  const discoverAcs = async () => {
    setAcsDiscovering(true);
    try {
      const [resources, tenant] = await Promise.all([
        listAzureAcsResources(),
        getAzureTenantId(),
      ]);
      setAcsResources(resources);
      setAcsTenant(tenant);
      // Re-entry with a saved username: keep the previously chosen service
      // selected when it still exists, so the picker opens on it.
      const savedResource = parseAcsSmtpResourceName(user);
      const match = savedResource
        ? resources.find((r) => r.name === savedResource)
        : undefined;
      if (match) {
        setAcsResource(match.name);
        setAcsResourceGroup(match.resourceGroup);
      }
    } catch {
      setAcsResources([]);
      setAcsTenant(null);
    }
    setAcsDiscovering(false);
  };

  // Shared by the discovered app picker and its manual fallback: record the
  // app ID and assemble the ACS SMTP username from the discovered parts.
  const submitAcsAppId = (appId: string) => {
    setAcsAppId(appId);
    const assembled = buildAcsSmtpUsername(
      acsResource ?? "",
      appId,
      acsTenant ?? "",
    );
    setUser(assembled);
    setError(null);
    dispatch({ type: "SET_SMTP", config: { smtpUser: assembled } });
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
            items={providerItems}
            initialValue={provider || undefined}
            onSelect={(value) => {
              // Presets apply whenever the current host belongs to a DIFFERENT
              // provider (or is empty). Comparing against the highlighted
              // `provider` is not enough: the recommendation can preselect one
              // provider while a profile-remembered host still points at
              // another, and confirming must not keep the stale host.
              const hostMatches =
                !!host && detectProviderFromHost(host) === value;
              setProvider(value);
              const providerConfig =
                SMTP_PROVIDERS[value as keyof typeof SMTP_PROVIDERS];
              if (providerConfig && !hostMatches) {
                setHost(providerConfig.host);
                setPort(providerConfig.port.toString());
                // A username saved for a different provider is never valid
                // here - reset to the preset's user even when it is empty
                // (e.g. profile-remembered "resend" leaking into the ACS
                // username field).
                setUser(providerConfig.user);
                // Same for the password: a credential minted by one provider
                // (a Resend API key, an Entra client secret) never works at
                // another, and the field is masked, so a stale prefill is
                // indistinguishable from a right one until sends fail.
                setPass("");
                dispatch({
                  type: "SET_SMTP",
                  config: {
                    smtpHost: providerConfig.host,
                    smtpPort: providerConfig.port,
                    smtpUser: providerConfig.user,
                    smtpPass: "",
                  },
                });
              } else if (providerConfig?.user && !user) {
                // Same provider, matching host, but no username yet: fill the
                // preset's fixed username (e.g. Resend's literal "resend").
                setUser(providerConfig.user);
                dispatch({
                  type: "SET_SMTP",
                  config: { smtpUser: providerConfig.user },
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
      // Which communication service sends the mail. Its name becomes the
      // leading segment of the SMTP username, and deploy grants the Entra app
      // Contributor on this exact resource - so an arbitrary pick here fails
      // at send time, which is why the operator makes it.
      id: "acs-resource",
      when: () => provider === "azure-acs" && acsAutoAssemble,
      render: (flow) => (
        <DiscoveredSelect
          label="Azure Communication Services resource"
          hint="The communication service that sends your email. Deploy grants the SMTP app access to whichever one you pick."
          loadingLabel="Discovering communication services..."
          emptyHint="None found in this subscription. Press R to refresh, or enter the SMTP username manually."
          initialValue={acsResource || undefined}
          preferRecommended={!state.configLoaded}
          recommendIndex={(items) =>
            items.findIndex(
              (item) =>
                acsResourcesRef.current
                  .find((r) => r.name === item.value)
                  ?.resourceGroup.toLowerCase() ===
                (state.azureResourceGroup || "").toLowerCase(),
            )
          }
          load={async () => {
            const resources = await listAzureAcsResources();
            acsResourcesRef.current = resources;
            setAcsResources(resources);
            return resources.map((r) => ({
              label: `${r.name} (${r.resourceGroup})`,
              value: r.name,
            }));
          }}
          onSelect={(value) => {
            const picked = acsResourcesRef.current.find(
              (r) => r.name === value,
            );
            setAcsResource(value);
            setAcsResourceGroup(picked?.resourceGroup || "");
            setError(null);
            flow.next();
          }}
          onManual={() => {
            setAcsResourceManual(true);
            flow.next();
          }}
        />
      ),
    },
    {
      // ACS with a chosen resource: pick the SMTP Entra app from the
      // tenant's app registrations (the docs create it as "Rulebricks SMTP",
      // which drives the recommendation) and assemble the username. The
      // client secret is entered next as the password; deploy grants the app
      // access to the ACS resource.
      id: "acs-app-id",
      when: () =>
        provider === "azure-acs" && acsAutoAssemble && !acsAppIdManual,
      render: (flow) => (
        <DiscoveredSelect
          label="Email SMTP app (Entra app registration)"
          hint="Deploy grants the app access automatically; its client secret is the password on the next screen."
          loadingLabel="Discovering Entra app registrations..."
          emptyHint="No app registrations found (missing Graph read access, or none exist yet)."
          initialValue={
            acsAppId || parseAcsSmtpAppClientId(user) || undefined
          }
          preferRecommended={!state.configLoaded}
          recommendIndex={() => recommendSmtpAppIndex(entraAppsRef.current)}
          load={async () => {
            const apps = await listAzureEntraApps();
            entraAppsRef.current = apps;
            return apps.map((app) => ({
              label: `${app.name} (${app.appId})`,
              value: app.appId,
            }));
          }}
          onSelect={(value) => {
            submitAcsAppId(value);
            flow.next();
          }}
          onManual={() => {
            setAcsAppIdManual(true);
            flow.next();
          }}
        />
      ),
    },
    {
      id: "acs-app-id-manual",
      when: () =>
        provider === "azure-acs" && acsAutoAssemble && acsAppIdManual,
      // Escaping returns to the discovered app list.
      onEscape: () => setAcsAppIdManual(false),
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
            submitAcsAppId(acsAppId);
            flow.next();
          }}
        />
      ),
    },
    {
      id: "user",
      when: () => !(provider === "azure-acs" && acsAutoAssemble),
      // Escaping returns to the discovered communication services.
      onEscape: () => setAcsResourceManual(false),
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
          label={
            provider === "azure-acs"
              ? "Entra app client secret (used as the SMTP password)"
              : "SMTP password"
          }
          hint={
            provider === "azure-acs"
              ? `Secrets are never listable, so mint one if needed: az ad app credential reset --id ${
                  acsAppId || parseAcsSmtpAppClientId(user) || "<app-id>"
                }`
              : undefined
          }
          value={pass}
          onChange={setPass}
          mask
          onSubmit={() => {
            if (!pass) {
              setError(
                provider === "azure-acs"
                  ? "The Entra app's client secret is required"
                  : "SMTP password is required",
              );
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
      // real addresses (branded first when one was provisioned) instead of
      // asking the operator to transcribe one.
      id: "from-acs",
      when: () => provider === "azure-acs" && !fromManual,
      render: (flow) => (
        <DiscoveredSelect
          label="Sender email address"
          hint="Discovered from your Azure Communication Services email service"
          loadingLabel="Looking up sender addresses..."
          emptyHint="No sender domains found on the email service."
          initialValue={from || undefined}
          preferRecommended={!state.configLoaded}
          recommendIndex={(items) =>
            items.findIndex((i) => !i.label.includes(UNVERIFIED_SENDER_SUFFIX))
          }
          load={async () => {
            // The chosen service's own resource group, so a BYO ACS outside
            // the deployment's group still resolves its sender domains. The
            // service name lets the lookup follow its linkedDomains to email
            // services in yet another resource group (the prerequisites
            // template's, or a central messaging team's).
            const senders = await listAcsSenderAddresses(
              acsResourceGroup || state.azureResourceGroup,
              acsResource ?? undefined,
            );
            // Unverified domains stay in the list (the operator may be
            // mid-verification) but are labeled, never recommended: cluster
            // setup creates the branded domain unverified, and sending from
            // it fails until the verification commands have been run.
            return senders.map((s) => ({
              label: s.verified
                ? s.address
                : `${s.address}${UNVERIFIED_SENDER_SUFFIX}`,
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
    <BorderBox title="Email" footer={<StepFooter />}>
      <Box flexDirection="column" marginY={1}>
        <Text color="gray" dimColor>
          Configure email delivery for user invitations, password resets, and
          notifications
        </Text>
      </Box>

      {flow.render()}

      {flow.current !== "provider" && <CheckRows rows={completed()} />}
      <FieldError error={error} />
    </BorderBox>
  );
}
