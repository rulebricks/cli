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
import { Spinner } from "../../common/Spinner.js";
import {
  validateBaseDomain,
  isValidEmail,
  isValidDomainFormat,
} from "../../../lib/validation.js";
import {
  DnsProvider,
  DNS_PROVIDER_NAMES,
  isSupportedDnsProvider,
} from "../../../types/index.js";

interface DomainStepProps {
  onComplete: () => void;
  onBack: () => void;
  entryDirection?: "forward" | "back";
}

const DNS_PROVIDER_OPTIONS: Array<{ label: string; value: DnsProvider }> = [
  { label: "Other / Not sure (manual DNS)", value: "other" },
  { label: "AWS Route 53", value: "route53" },
  { label: "Cloudflare", value: "cloudflare" },
  { label: "Google Cloud DNS", value: "google" },
  { label: "Azure DNS", value: "azure" },
];

const AUTO_MANAGE_OPTIONS = [
  { label: "Yes, automatically manage DNS records", value: "yes" },
  { label: "No, I'll configure DNS manually", value: "no" },
];

export function DomainStep({
  onComplete,
  onBack,
  entryDirection,
}: DomainStepProps) {
  const { state, dispatch, profile } = useWizard();
  const [error, setError] = useState<string | null>(null);

  const [domain, setDomain] = useState(state.domain || "");
  const [adminEmail, setAdminEmail] = useState(state.adminEmail || "");
  const [dnsProvider, setDnsProvider] = useState<DnsProvider>(
    state.dnsProvider,
  );
  const [validating, setValidating] = useState(false);

  const fields: FlowField[] = [
    {
      id: "domain",
      render: (flow) =>
        validating ? (
          <Box flexDirection="column" marginY={1}>
            <Spinner label="Validating domain..." />
          </Box>
        ) : (
          <TextField
            label="Enter your Rulebricks domain"
            hint={`This is where Rulebricks will be accessible${
              profile?.domainSuffix
                ? ` (e.g., app2${profile.domainSuffix})`
                : " (e.g., rulebricks.example.com)"
            }`}
            value={domain}
            onChange={setDomain}
            placeholder={
              profile?.domainSuffix
                ? `rulebricks${profile.domainSuffix}`
                : "rulebricks.example.com"
            }
            onSubmit={async () => {
              if (!domain) {
                setError("Domain is required");
                return;
              }
              if (!isValidDomainFormat(domain)) {
                setError("Invalid domain format (e.g., rulebricks.example.com)");
                return;
              }
              setError(null);
              setValidating(true);
              try {
                const result = await validateBaseDomain(domain);
                if (!result.valid) {
                  setError(result.error || "Domain validation failed");
                  setValidating(false);
                  return;
                }
              } catch {
                // Network failures shouldn't block configuration.
              }
              setValidating(false);
              dispatch({ type: "SET_DOMAIN", domain });
              flow.next();
            }}
          />
        ),
    },
    {
      id: "admin-email",
      render: (flow) => (
        <TextField
          label="Enter the admin email address"
          hint="Used for Rulebricks administration, notifications, and TLS certificate (Let's Encrypt) notices"
          value={adminEmail}
          onChange={setAdminEmail}
          placeholder="admin@example.com"
          onSubmit={() => {
            if (!adminEmail) {
              setError("Admin email is required");
              return;
            }
            if (!isValidEmail(adminEmail)) {
              setError("Invalid email format");
              return;
            }
            setError(null);
            dispatch({ type: "SET_ADMIN_EMAIL", email: adminEmail });
            // The TLS (Let's Encrypt) email defaults to the admin email in
            // toConfig; advanced users can override tlsEmail in config.yaml.
            flow.next();
          }}
        />
      ),
    },
    {
      id: "dns-provider",
      render: (flow) => (
        <WizardSelect
          label="Where is your domain's DNS hosted?"
          hint="This determines whether we can automatically manage DNS records for you"
          items={DNS_PROVIDER_OPTIONS}
          initialValue={dnsProvider}
          onSelect={(value) => {
            const provider = value as DnsProvider;
            setDnsProvider(provider);
            dispatch({ type: "SET_DNS_PROVIDER", provider });
            if (!isSupportedDnsProvider(provider)) {
              dispatch({ type: "SET_DNS_AUTO_MANAGE", autoManage: false });
            }
            flow.next();
          }}
        />
      ),
    },
    {
      id: "dns-auto-manage",
      when: () => isSupportedDnsProvider(dnsProvider),
      render: (flow) => (
        <Box flexDirection="column">
          <WizardSelect
            label="Automatic DNS Management"
            hint="Should Rulebricks automatically create and manage DNS records? This enables single-step deployment without manual DNS configuration."
            items={AUTO_MANAGE_OPTIONS}
            initialValue={state.dnsAutoManage ? "yes" : "no"}
            onSelect={(value) => {
              dispatch({
                type: "SET_DNS_AUTO_MANAGE",
                autoManage: value === "yes",
              });
              flow.next();
            }}
          />
          <Box borderStyle="round" borderColor="yellow" paddingX={1}>
            <Text color="yellow">
              Note: Auto-DNS requires external-dns with proper IAM credentials
              in your cluster.
            </Text>
          </Box>
        </Box>
      ),
    },
  ];

  const flow = useFieldFlow({
    fields,
    onDone: onComplete,
    onExit: onBack,
    entry: entryDirection === "back" ? "end" : "start",
    escapeGoesBack: !validating,
    onNavigate: () => setError(null),
  });

  const progress = () => {
    const rows: { label: string; value: string }[] = [];
    if (domain && flow.current !== "domain") {
      rows.push({ label: "Domain", value: domain });
    }
    if (adminEmail && !["domain", "admin-email"].includes(flow.current)) {
      rows.push({ label: "Admin", value: adminEmail });
    }
    if (flow.current === "dns-auto-manage") {
      rows.push({
        label: "DNS Provider",
        value: DNS_PROVIDER_NAMES[dnsProvider],
      });
    }
    return rows;
  };

  return (
    <BorderBox title="Domain & DNS">
      {flow.render()}

      <CheckRows rows={progress()} />
      <FieldError error={error} />
      <StepFooter />
    </BorderBox>
  );
}
