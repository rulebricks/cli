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
import {
  findAzureDnsZone,
  findAzureDnsZoneById,
  findAzureManagedIdentity,
  parseAzureDnsZoneId,
  parseAzureManagedIdentityId,
  resolveAzureExternalDnsReferences,
  AzureDnsZoneInfo,
} from "../../../lib/cloudCli.js";

interface DomainStepProps {
  onComplete: () => void;
  onBack: () => void;
  entryDirection?: "forward" | "back";
}

const DNS_PROVIDER_OPTIONS: Array<{ label: string; value: DnsProvider }> = [
  { label: "AWS Route 53", value: "route53" },
  { label: "Azure DNS", value: "azure" },
  { label: "Google Cloud DNS", value: "google" },
  { label: "Cloudflare", value: "cloudflare" },
  { label: "Other / Not sure (manual DNS)", value: "other" },
];

/** The cloud's native DNS service - what enterprises overwhelmingly use. */
function nativeDnsProviderFor(cloud: string | null): DnsProvider | null {
  switch (cloud) {
    case "aws":
      return "route53";
    case "azure":
      return "azure";
    case "gcp":
      return "google";
    default:
      return null;
  }
}

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
  // Preselection: the deployment's own saved DNS provider (configure) wins;
  // on a fresh init the cloud's native DNS service outranks a provider
  // remembered from previous deployments (profile memory). The native option
  // is listed first with the manual-DNS escape hatch last.
  const nativeDnsProvider = nativeDnsProviderFor(state.provider);
  const [dnsProvider, setDnsProvider] = useState<DnsProvider>(
    state.configLoaded
      ? state.dnsProvider
      : (nativeDnsProvider ?? state.dnsProvider),
  );
  const dnsProviderItems = DNS_PROVIDER_OPTIONS.map((option) =>
    option.value === nativeDnsProvider
      ? { ...option, label: `${option.label} (recommended)` }
      : option,
  ).sort(
    (a, b) =>
      Number(b.value === nativeDnsProvider) -
      Number(a.value === nativeDnsProvider),
  );
  const [validating, setValidating] = useState(false);

  // TLS certificate issuance lives in the dedicated Certificates step near
  // the end of the wizard: the hostnames needing certificates depend on the
  // observability and features steps, which come after this one.

  // Azure DNS auto-detection. When the cluster-setup zone AND the
  // external-dns identity already exist, auto-manage is unambiguously the
  // right answer, so we skip the auto/manual question and instead show the
  // delegation status (the one thing the operator may still need to act on).
  const [azureDetecting, setAzureDetecting] = useState(false);
  const [azureZone, setAzureZone] = useState<AzureDnsZoneInfo | null>(null);
  const [azureAutoDetected, setAzureAutoDetected] = useState(false);
  const [azureDnsAutoManage, setAzureDnsAutoManage] = useState(
    state.dnsAutoManage,
  );
  const [azureDnsZoneId, setAzureDnsZoneId] = useState(state.azureDnsZoneId);
  const [azureExternalDnsIdentityId, setAzureExternalDnsIdentityId] = useState(
    state.azureExternalDnsIdentityId,
  );

  const detectAzureDns = async () => {
    setAzureDetecting(true);
    try {
      // Hard cap: detection is a convenience, never a reason for the wizard
      // to sit still. On timeout we fall through to the manual question.
      const hasExactReferences =
        Boolean(azureDnsZoneId) && Boolean(azureExternalDnsIdentityId);
      const [exactReferences, zone] = await Promise.all([
        hasExactReferences
          ? resolveAzureExternalDnsReferences(
              azureDnsZoneId,
              azureExternalDnsIdentityId,
            )
          : Promise.resolve(null),
        Promise.race([
          hasExactReferences
            ? findAzureDnsZoneById(azureDnsZoneId)
            : findAzureDnsZone(domain.toLowerCase()),
          new Promise<null>((resolve) =>
            setTimeout(() => resolve(null), 30000).unref?.(),
          ),
        ]),
      ]);
      let identityId = "";
      if (zone && exactReferences) {
        identityId = azureExternalDnsIdentityId;
      } else if (zone && state.clusterName && !hasExactReferences) {
        // Subscription-wide: the prerequisites template may have placed the
        // identity next to the zone in a platform resource group.
        identityId =
          (
            await findAzureManagedIdentity(
              `${state.clusterName}-external-dns`,
            )
          )?.id || "";
      }
      const requestedDomain = domain.toLowerCase();
      const zoneCoversDomain =
        zone &&
        (requestedDomain === zone.name ||
          requestedDomain.endsWith(`.${zone.name}`));
      if (zone && identityId && zoneCoversDomain) {
        setAzureZone(zone);
        setAzureAutoDetected(true);
        dispatch({ type: "SET_DNS_AUTO_MANAGE", autoManage: true });
        dispatch({
          type: "SET_AZURE_DNS_RESOURCES",
          zoneId: zone.id,
          identityId,
        });
      } else if (!hasExactReferences) {
        setAzureZone(null);
        setAzureAutoDetected(false);
        dispatch({
          type: "SET_AZURE_DNS_RESOURCES",
          zoneId: "",
          identityId: "",
        });
      }
    } catch {
      setAzureZone(null);
      setAzureAutoDetected(false);
    }
    setAzureDetecting(false);
  };

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
                setError(
                  "Invalid domain format (e.g., rulebricks.example.com)",
                );
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
          hint="Used for Rulebricks administration, notifications, and certificate expiry notices (when TLS uses Let's Encrypt)"
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
      // The Azure detection spinner renders in place of the picker rather than
      // as its own field: flow.render() always renders the CURRENT field
      // regardless of its `when`, so a field that goes invisible mid-flight
      // would stay on screen forever. Detection therefore completes before
      // flow.next() is called, exactly like the domain field's validation.
      render: (flow) =>
        azureDetecting ? (
          <Box flexDirection="column" marginY={1}>
            <Spinner label="Checking your Azure DNS zone..." />
          </Box>
        ) : (
          <WizardSelect
            label="Where is your domain's DNS hosted?"
            hint="This determines whether we can automatically manage DNS records for you"
            items={dnsProviderItems}
            initialValue={dnsProvider}
            onSelect={(value) => {
              const provider = value as DnsProvider;
              setDnsProvider(provider);
              dispatch({ type: "SET_DNS_PROVIDER", provider });
              if (!isSupportedDnsProvider(provider)) {
                dispatch({ type: "SET_DNS_AUTO_MANAGE", autoManage: false });
              }
              // Azure DNS: detect the cluster-setup zone + identity so the
              // auto/manual question can be skipped when auto-manage is viable.
              if (provider === "azure") {
                void (async () => {
                  await detectAzureDns();
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
      // Detected Azure zone + identity: auto-manage is set; show delegation
      // status instead of asking the auto/manual question.
      id: "dns-azure-detected",
      when: () => dnsProvider === "azure" && azureAutoDetected,
      render: (flow) => (
        <Box flexDirection="column" marginTop={1}>
          <Text color="green">
            Detected Azure DNS zone {azureZone?.name}
          </Text>
          {azureZone?.delegated ? (
            <Box borderStyle="round" borderColor="green" paddingX={1}>
              <Text color="green">
                Delegation is live, DNS records are managed automatically.
              </Text>
            </Box>
          ) : (
            <Box
              flexDirection="column"
              borderStyle="round"
              borderColor="yellow"
              paddingX={1}
            >
              <Text color="yellow">
                Delegate the zone by adding these NS records for{" "}
                {azureZone?.name} at your parent domain. DNS records are then
                managed automatically:
              </Text>
              {(azureZone?.nameServers ?? []).map((ns) => (
                <Text key={ns} color="yellow">
                  {"  "}
                  {ns}
                </Text>
              ))}
            </Box>
          )}
          <Box marginTop={1}>
            <WizardSelect
              label=""
              items={[{ label: "Continue", value: "continue" }]}
              onSelect={() => flow.next()}
            />
          </Box>
        </Box>
      ),
    },
    {
      id: "dns-auto-manage",
      when: () =>
        isSupportedDnsProvider(dnsProvider) &&
        !(dnsProvider === "azure" && azureAutoDetected),
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
              setAzureDnsAutoManage(value === "yes");
              if (value !== "yes" && dnsProvider === "azure") {
                setAzureDnsZoneId("");
                setAzureExternalDnsIdentityId("");
                dispatch({
                  type: "SET_AZURE_DNS_RESOURCES",
                  zoneId: "",
                  identityId: "",
                });
              }
              flow.next();
            }}
          />
          <Box borderStyle="round" borderColor="yellow" paddingX={1}>
            <Text color="yellow">
              {dnsProvider === "azure"
                ? "Note: Auto-DNS uses the <cluster>-external-dns managed identity from cluster-setup; deploy binds it automatically."
                : dnsProvider === "route53"
                  ? "Note: Auto-DNS uses the <cluster>-external-dns IAM role from cluster-setup; deploy binds it automatically."
                  : "Note: Auto-DNS requires external-dns credentials for your DNS provider in the cluster."}
            </Text>
          </Box>
        </Box>
      ),
    },
    {
      id: "azure-dns-zone-id",
      when: () =>
        dnsProvider === "azure" &&
        azureDnsAutoManage &&
        !azureAutoDetected,
      render: (flow) => (
        <TextField
          label="Azure DNS zone resource ID"
          hint="Paste the full ID from prerequisites.mainDeploymentParameters.existingDnsZoneId"
          value={azureDnsZoneId}
          onChange={setAzureDnsZoneId}
          placeholder="/subscriptions/.../providers/Microsoft.Network/dnsZones/example.com"
          onSubmit={() => {
            if (!parseAzureDnsZoneId(azureDnsZoneId.trim())) {
              setError("Enter a full Microsoft.Network/dnsZones resource ID");
              return;
            }
            setAzureDnsZoneId(azureDnsZoneId.trim());
            setError(null);
            flow.next();
          }}
        />
      ),
    },
    {
      id: "azure-external-dns-identity-id",
      when: () =>
        dnsProvider === "azure" &&
        azureDnsAutoManage &&
        !azureAutoDetected,
      render: (flow) => (
        <TextField
          label="External-dns managed identity resource ID"
          hint="Paste the full ID from prerequisites.mainDeploymentParameters.existingExternalDnsIdentityId"
          value={azureExternalDnsIdentityId}
          onChange={setAzureExternalDnsIdentityId}
          placeholder="/subscriptions/.../providers/Microsoft.ManagedIdentity/userAssignedIdentities/..."
          onSubmit={async () => {
            const identityId = azureExternalDnsIdentityId.trim();
            if (!parseAzureManagedIdentityId(identityId)) {
              setError(
                "Enter a full Microsoft.ManagedIdentity/userAssignedIdentities resource ID",
              );
              return;
            }
            setAzureDetecting(true);
            const [zone, references] = await Promise.all([
              findAzureDnsZoneById(azureDnsZoneId),
              resolveAzureExternalDnsReferences(azureDnsZoneId, identityId),
            ]);
            setAzureDetecting(false);
            const requestedDomain = domain.toLowerCase();
            if (
              !zone ||
              !references ||
              (requestedDomain !== zone.name &&
                !requestedDomain.endsWith(`.${zone.name}`))
            ) {
              setError(
                "The CLI could not read these Azure resources, or the DNS zone does not cover this domain",
              );
              return;
            }
            setAzureZone(zone);
            setAzureExternalDnsIdentityId(identityId);
            dispatch({
              type: "SET_AZURE_DNS_RESOURCES",
              zoneId: zone.id,
              identityId,
            });
            setError(null);
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
    <BorderBox title="Domain & DNS" footer={<StepFooter />}>
      {flow.render()}

      <CheckRows rows={progress()} />
      <FieldError error={error} />
    </BorderBox>
  );
}
