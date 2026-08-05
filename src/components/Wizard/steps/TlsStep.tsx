import React, { useState } from "react";
import { readFileSync } from "fs";
import { Box, Text } from "ink";
import { useWizard } from "../WizardContext.js";
import { useFieldFlow, FlowField } from "../fieldFlow.js";
import {
  BorderBox,
  FieldError,
  StepFooter,
  TextField,
  WizardSelect,
} from "../../common/index.js";
import {
  parseCertificate,
  keyMatchesCertificate,
  summarizeTlsCoverage,
} from "../../../lib/tlsCerts.js";

interface TlsStepProps {
  onComplete: () => void;
  onBack: () => void;
  entryDirection?: "forward" | "back";
}

/**
 * TLS certificate issuance. A dedicated step near the END of the wizard, on
 * purpose: the hostnames that need certificates depend on choices made in
 * the observability and features steps (built-in observability adds
 * observability.<domain>, the Valkey admin UI adds valkey.<domain>), so the
 * coverage preview here is computed against the operator's actual selections
 * rather than defaults. Deploy preflight re-validates the same set.
 */
export function TlsStep({ onComplete, onBack, entryDirection }: TlsStepProps) {
  const { state, dispatch } = useWizard();
  const [error, setError] = useState<string | null>(null);

  // TLS issuance: automatic Let's Encrypt (default), an issuer the cluster's
  // platform team already runs, or operator-provided PEM certificates. The
  // provided branch is a small in-field state machine (review <-> cert path
  // -> key path) so the flow stays a single field.
  const [tlsMode, setTlsMode] = useState<
    "auto" | "external-issuer" | "provided"
  >(state.tlsMode);
  const [certPhase, setCertPhase] = useState<"review" | "cert" | "key">(
    "review",
  );
  const [certPathInput, setCertPathInput] = useState("");
  const [keyPathInput, setKeyPathInput] = useState("");
  // External issuer details (name + kind; "custom" opens kind/group entry).
  const [issuerName, setIssuerName] = useState(state.tlsIssuerName);
  const [issuerCustom, setIssuerCustom] = useState(false);
  const [issuerKindInput, setIssuerKindInput] = useState(
    state.tlsIssuerKind || "ClusterIssuer",
  );
  const [issuerGroupInput, setIssuerGroupInput] = useState(
    state.tlsIssuerGroup || "cert-manager.io",
  );
  // Public vs private issuing CA (non-auto modes).
  const [caTrust, setCaTrust] = useState<"public" | "private">(
    state.tlsCaTrust,
  );
  const [caBundleInput, setCaBundleInput] = useState(state.tlsCaBundleFile);

  // The hostnames this deployment will terminate TLS for, from the final
  // wizard selections (mirrors tlsCerts.requiredTlsHostnames on the config).
  const tlsHostnames = (): string[] => {
    const base = state.domain.trim().toLowerCase();
    const hosts = [base, `supabase.${base}`];
    if (state.clickStackEnabled) hosts.push(`observability.${base}`);
    if (state.valkeyAdminEnabled && state.valkeyAdminExposure === "ingress") {
      hosts.push(
        state.valkeyAdminHostname.trim().toLowerCase() || `valkey.${base}`,
      );
    }
    return hosts;
  };

  const fields: FlowField[] = [
    {
      id: "tls-issuance",
      render: (flow) => (
        <WizardSelect
          label="How are TLS certificates issued?"
          hint={`Certificates are needed for: ${tlsHostnames().join(", ")}. Automatic uses Let's Encrypt and renews itself - zero maintenance. The other options fit organizations that issue certificates through their own PKI.`}
          items={[
            {
              label: "Automatically via Let's Encrypt (recommended)",
              value: "auto",
            },
            {
              label:
                "Through my cluster's certificate manager (Venafi, Vault, ...)",
              value: "external-issuer",
            },
            {
              label: "I'll provide my own certificate files",
              value: "provided",
            },
          ]}
          initialValue={tlsMode}
          onSelect={(value) => {
            const mode = value as "auto" | "external-issuer" | "provided";
            setTlsMode(mode);
            dispatch({
              type: "SET_TLS_CONFIG",
              config: {
                tlsMode: mode,
                ...(mode === "auto"
                  ? {
                      tlsCertificates: [],
                      tlsIssuerName: "",
                      tlsCaTrust: "public" as const,
                      tlsCaBundleFile: "",
                    }
                  : {}),
              },
            });
            setCertPhase(
              mode === "provided" && state.tlsCertificates.length === 0
                ? "cert"
                : "review",
            );
            flow.next();
          }}
        />
      ),
    },
    {
      id: "tls-issuer-name",
      when: () => tlsMode === "external-issuer",
      render: (flow) => (
        <TextField
          label="Certificate issuer name"
          hint="The cert-manager issuer your platform team runs (e.g. a Venafi or Vault ClusterIssuer). Certificates for every hostname are requested from it and renew automatically."
          value={issuerName}
          onChange={setIssuerName}
          placeholder="venafi-tpp"
          onSubmit={() => {
            if (!issuerName.trim()) {
              setError("The issuer name is required");
              return;
            }
            setError(null);
            dispatch({
              type: "SET_TLS_CONFIG",
              config: { tlsIssuerName: issuerName.trim() },
            });
            flow.next();
          }}
        />
      ),
    },
    {
      id: "tls-issuer-kind",
      when: () => tlsMode === "external-issuer",
      render: (flow) => (
        <WizardSelect
          label="Issuer kind"
          hint="ClusterIssuer covers cert-manager's built-in issuer types, including its native Venafi issuer."
          items={[
            { label: "ClusterIssuer (cert-manager built-in)", value: "builtin" },
            {
              label: "VenafiClusterIssuer (Venafi enhanced issuer)",
              value: "venafi-enhanced",
            },
            { label: "Other (custom kind and API group)", value: "custom" },
          ]}
          initialValue={
            issuerCustom
              ? "custom"
              : state.tlsIssuerKind === "VenafiClusterIssuer"
                ? "venafi-enhanced"
                : "builtin"
          }
          onSelect={(value) => {
            if (value === "custom") {
              setIssuerCustom(true);
              flow.next();
              return;
            }
            setIssuerCustom(false);
            const preset =
              value === "venafi-enhanced"
                ? { tlsIssuerKind: "VenafiClusterIssuer", tlsIssuerGroup: "jetstack.io" }
                : { tlsIssuerKind: "ClusterIssuer", tlsIssuerGroup: "cert-manager.io" };
            dispatch({ type: "SET_TLS_CONFIG", config: preset });
            flow.next();
          }}
        />
      ),
    },
    {
      id: "tls-issuer-kind-custom",
      when: () => tlsMode === "external-issuer" && issuerCustom,
      onEscape: () => setIssuerCustom(false),
      render: (flow) => (
        <TextField
          label="Issuer kind"
          hint="The Kubernetes kind of the issuer resource"
          value={issuerKindInput}
          onChange={setIssuerKindInput}
          placeholder="ClusterIssuer"
          onSubmit={() => {
            if (!issuerKindInput.trim()) {
              setError("The issuer kind is required");
              return;
            }
            setError(null);
            dispatch({
              type: "SET_TLS_CONFIG",
              config: { tlsIssuerKind: issuerKindInput.trim() },
            });
            flow.next();
          }}
        />
      ),
    },
    {
      id: "tls-issuer-group-custom",
      when: () => tlsMode === "external-issuer" && issuerCustom,
      render: (flow) => (
        <TextField
          label="Issuer API group"
          hint="The API group of the issuer's CRD"
          value={issuerGroupInput}
          onChange={setIssuerGroupInput}
          placeholder="cert-manager.io"
          onSubmit={() => {
            if (!issuerGroupInput.trim()) {
              setError("The issuer API group is required");
              return;
            }
            setError(null);
            dispatch({
              type: "SET_TLS_CONFIG",
              config: { tlsIssuerGroup: issuerGroupInput.trim() },
            });
            flow.next();
          }}
        />
      ),
    },
    {
      id: "tls-certificates",
      when: () => tlsMode === "provided",
      // Escaping mid-entry lands back on the issuance question; make sure a
      // later re-entry starts at the review screen, not a stale path prompt.
      onEscape: () => setCertPhase("review"),
      render: (flow) => {
        if (certPhase === "cert") {
          return (
            <TextField
              label={`Certificate ${state.tlsCertificates.length + 1}: PEM certificate file`}
              hint="Path to the certificate (full chain, leaf first). The hostnames it covers are read from its SANs - a wildcard needs the apex as its own SAN."
              value={certPathInput}
              onChange={setCertPathInput}
              placeholder="/path/to/tls.crt"
              onSubmit={() => {
                try {
                  const info = parseCertificate(
                    readFileSync(certPathInput.trim(), "utf8"),
                  );
                  if (info.dnsNames.length === 0) {
                    setError(
                      "The certificate contains no DNS names (SANs) - it cannot serve any hostname.",
                    );
                    return;
                  }
                } catch {
                  setError(
                    `Cannot read or parse a PEM certificate at: ${certPathInput.trim()}`,
                  );
                  return;
                }
                setError(null);
                setCertPhase("key");
              }}
            />
          );
        }
        if (certPhase === "key") {
          return (
            <TextField
              label="Matching private key file"
              hint={`The PEM private key for ${certPathInput.trim()}`}
              value={keyPathInput}
              onChange={setKeyPathInput}
              placeholder="/path/to/tls.key"
              onSubmit={() => {
                let matches = false;
                try {
                  matches = keyMatchesCertificate(
                    readFileSync(certPathInput.trim(), "utf8"),
                    readFileSync(keyPathInput.trim(), "utf8"),
                  );
                } catch {
                  setError(
                    `Cannot read a PEM private key at: ${keyPathInput.trim()}`,
                  );
                  return;
                }
                if (!matches) {
                  setError(
                    "That private key does not match the certificate - check the file pairing.",
                  );
                  return;
                }
                dispatch({
                  type: "SET_TLS_CONFIG",
                  config: {
                    tlsCertificates: [
                      ...state.tlsCertificates,
                      {
                        certFile: certPathInput.trim(),
                        keyFile: keyPathInput.trim(),
                      },
                    ],
                  },
                });
                setCertPathInput("");
                setKeyPathInput("");
                setError(null);
                setCertPhase("review");
              }}
            />
          );
        }
        const coverage = summarizeTlsCoverage(
          tlsHostnames(),
          state.tlsCertificates,
        );
        return (
          <Box flexDirection="column">
            {coverage.summaries.map((summary) => (
              <Text
                key={summary.certFile}
                color={summary.error ? "red" : undefined}
              >
                {"  "}
                {summary.certFile} -{" "}
                {summary.error ?? summary.dnsNames.join(", ")}
              </Text>
            ))}
            {coverage.missing.length === 0 ? (
              <Box borderStyle="round" borderColor="green" paddingX={1}>
                <Text color="green">
                  All hostnames covered: {coverage.covered.join(", ")}
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
                  Not yet covered: {coverage.missing.join(", ")}
                </Text>
                <Text color="yellow">
                  A wildcard (*.{state.domain.trim().toLowerCase()}) covers one
                  subdomain label and NOT the apex - a single certificate needs
                  both as SANs.
                </Text>
              </Box>
            )}
            <Box marginTop={1}>
              <WizardSelect
                // The coverage banner above re-reads the PEM files on every
                // render, but ink-select-input keeps its highlight from mount
                // (and snaps to item 0, "Add a certificate", whenever the
                // items list changes). Without this key, fixing a cert file
                // on disk turns the banner green while Enter still triggers
                // "add" - keying on cert count + coverage remounts the select
                // so its default follows what the banner shows.
                key={`tls-review-${state.tlsCertificates.length}-${coverage.missing.length === 0 ? "covered" : "missing"}`}
                label=""
                items={[
                  { label: "Add a certificate", value: "add" },
                  { label: "Continue", value: "continue" },
                  ...(state.tlsCertificates.length > 0
                    ? [{ label: "Start over", value: "reset" }]
                    : []),
                ]}
                initialValue={
                  state.tlsCertificates.length === 0 ||
                  coverage.missing.length > 0
                    ? "add"
                    : "continue"
                }
                onSelect={(value) => {
                  if (value === "add") {
                    setError(null);
                    setCertPhase("cert");
                    return;
                  }
                  if (value === "reset") {
                    dispatch({
                      type: "SET_TLS_CONFIG",
                      config: { tlsCertificates: [] },
                    });
                    setError(null);
                    setCertPhase("cert");
                    return;
                  }
                  if (state.tlsCertificates.length === 0) {
                    setError(
                      "At least one certificate is required for bring-your-own TLS.",
                    );
                    return;
                  }
                  setError(null);
                  flow.next();
                }}
              />
            </Box>
          </Box>
        );
      },
    },
    {
      id: "tls-ca-trust",
      when: () => tlsMode !== "auto",
      render: (flow) => (
        <WizardSelect
          label="Is the issuing CA publicly trusted?"
          hint="Private/corporate CAs need their root bundle distributed to the Rulebricks components that call the deployment's own HTTPS endpoints - otherwise those calls fail TLS verification."
          items={[
            {
              label: "Public CA (DigiCert, Entrust, Let's Encrypt, ...)",
              value: "public",
            },
            { label: "Private / corporate CA", value: "private" },
          ]}
          initialValue={caTrust}
          onSelect={(value) => {
            const trust = value as "public" | "private";
            setCaTrust(trust);
            dispatch({
              type: "SET_TLS_CONFIG",
              config: {
                tlsCaTrust: trust,
                ...(trust === "public" ? { tlsCaBundleFile: "" } : {}),
              },
            });
            flow.next();
          }}
        />
      ),
    },
    {
      id: "tls-ca-bundle",
      when: () => tlsMode !== "auto" && caTrust === "private",
      render: (flow) => (
        <TextField
          label="Root CA bundle file (PEM)"
          hint="Your corporate root (and any intermediates). It is distributed to in-cluster callers additively - public endpoints keep verifying as usual."
          value={caBundleInput}
          onChange={setCaBundleInput}
          placeholder="/path/to/corporate-root-ca.pem"
          onSubmit={() => {
            try {
              parseCertificate(readFileSync(caBundleInput.trim(), "utf8"));
            } catch {
              setError(
                `Cannot read or parse a PEM certificate at: ${caBundleInput.trim()}`,
              );
              return;
            }
            setError(null);
            dispatch({
              type: "SET_TLS_CONFIG",
              config: { tlsCaBundleFile: caBundleInput.trim() },
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
    <BorderBox title="Certificates" footer={<StepFooter />}>
      {flow.render()}

      <FieldError error={error} />
    </BorderBox>
  );
}
