import { readFileSync } from "fs";
import { X509Certificate, createPrivateKey } from "crypto";
import { DeploymentConfig } from "../types/index.js";

/**
 * Bring-your-own TLS certificates.
 *
 * The chart's ingresses each terminate TLS from a fixed, per-host secret
 * name; in auto mode cert-manager fills those secrets, in provided mode the
 * CLI fills them from operator PEM files. Everything here is about mapping
 * "these PEM files" onto "the secrets the chart expects" and failing early
 * (with the exact gap) instead of at first HTTPS request.
 */

export interface ParsedCertificate {
  /** DNS names the certificate is valid for (SANs, CN fallback). */
  dnsNames: string[];
  /** Expiry as a Date. */
  validTo: Date;
}

export interface TlsCertificateInput {
  certFile: string;
  keyFile: string;
}

export interface TlsSecretPlanEntry {
  /** Hostname this secret serves. */
  host: string;
  /** Kubernetes secret name the chart's ingress expects. */
  secretName: string;
  /** Full PEM chain from the covering certificate file. */
  certPem: string;
  /** PEM private key. */
  keyPem: string;
}

export interface TlsSecretPlan {
  entries: TlsSecretPlanEntry[];
  /** Non-fatal issues worth surfacing (e.g. certificates expiring soon). */
  warnings: string[];
}

/** Parses the leaf certificate of a PEM (chains are leaf-first by convention). */
export function parseCertificate(certPem: string): ParsedCertificate {
  const cert = new X509Certificate(certPem);
  const dnsNames: string[] = [];
  if (cert.subjectAltName) {
    for (const entry of cert.subjectAltName.split(",")) {
      const trimmed = entry.trim();
      if (trimmed.toUpperCase().startsWith("DNS:")) {
        dnsNames.push(trimmed.slice(4).toLowerCase());
      }
    }
  }
  if (dnsNames.length === 0) {
    // Modern clients ignore CN, but a CN-only cert is better surfaced as
    // "covers this one name" than "covers nothing".
    const cn = /(?:^|\n)CN=([^\n]+)/.exec(cert.subject);
    if (cn) dnsNames.push(cn[1].trim().toLowerCase());
  }
  return { dnsNames, validTo: new Date(cert.validTo) };
}

/**
 * RFC 6125-style matching: exact names, or a single-label wildcard. A
 * wildcard covers exactly one label ("*.rb.corp.com" matches
 * "supabase.rb.corp.com" but neither "rb.corp.com" nor "a.b.rb.corp.com") -
 * the reason the apex must be its own SAN on wildcard certificates.
 */
export function certificateCoversHost(dnsNames: string[], host: string): boolean {
  const target = host.toLowerCase();
  return dnsNames.some((name) => {
    if (name === target) return true;
    if (!name.startsWith("*.")) return false;
    const suffix = name.slice(1); // ".rb.corp.com"
    if (!target.endsWith(suffix)) return false;
    const prefix = target.slice(0, target.length - suffix.length);
    return prefix.length > 0 && !prefix.includes(".");
  });
}

/** True when the private key pairs with the certificate's public key. */
export function keyMatchesCertificate(certPem: string, keyPem: string): boolean {
  try {
    const cert = new X509Certificate(certPem);
    return cert.checkPrivateKey(createPrivateKey(keyPem));
  } catch {
    return false;
  }
}

/**
 * The hostnames this deployment terminates TLS for. Apex (app + API - one
 * host, path-routed) and Supabase are always served; observability follows
 * built-in ClickStack; the Valkey admin UI only when exposed via ingress.
 */
export function requiredTlsHostnames(config: DeploymentConfig): string[] {
  const domain = config.domain.toLowerCase();
  const hosts = [domain, `supabase.${domain}`];
  if (config.features.observability?.clickstack?.enabled ?? true) {
    hosts.push(`observability.${domain}`);
  }
  const valkeyAdmin = config.features.cache?.valkeyAdmin;
  if (valkeyAdmin?.enabled && valkeyAdmin.exposure === "ingress") {
    hosts.push(valkeyAdmin.hostname?.toLowerCase() || `valkey.${domain}`);
  }
  return hosts;
}

/**
 * The TLS secret name each ingress template expects for a hostname. These
 * mirror the chart's fullname helpers (release "azpg" yields
 * "azpg-supabase-kong-tls" etc.) - the one naming contract between the CLI
 * and the chart for provided certificates.
 */
export function tlsSecretNameForHost(
  host: string,
  domain: string,
  releaseName: string,
): string {
  const apex = domain.toLowerCase();
  const target = host.toLowerCase();
  if (target === apex) return `${releaseName}-tls-secret`;
  if (target === `supabase.${apex}`) return `${releaseName}-supabase-kong-tls`;
  if (target === `observability.${apex}`) {
    return `${releaseName}-clickstack-hyperdx-tls`;
  }
  return `${releaseName}-valkey-admin-tls`;
}

/** Pure core of planTlsSecrets, testable without touching the filesystem. */
export function planTlsSecretsFromPems(
  config: DeploymentConfig,
  releaseName: string,
  certificates: Array<{ certPem: string; keyPem: string; label: string }>,
  now: Date = new Date(),
): TlsSecretPlan {
  const parsed = certificates.map((c) => {
    let info: ParsedCertificate;
    try {
      info = parseCertificate(c.certPem);
    } catch (error) {
      throw new Error(
        `${c.label}: not a parseable PEM certificate (${error instanceof Error ? error.message : String(error)})`,
      );
    }
    if (!keyMatchesCertificate(c.certPem, c.keyPem)) {
      throw new Error(
        `${c.label}: the private key does not match the certificate.`,
      );
    }
    if (info.validTo.getTime() <= now.getTime()) {
      throw new Error(
        `${c.label}: the certificate expired on ${info.validTo.toISOString().slice(0, 10)}.`,
      );
    }
    return { ...c, info };
  });

  const warnings: string[] = [];
  const thirtyDays = 30 * 24 * 60 * 60 * 1000;
  for (const cert of parsed) {
    if (cert.info.validTo.getTime() - now.getTime() < thirtyDays) {
      warnings.push(
        `${cert.label} expires on ${cert.info.validTo.toISOString().slice(0, 10)} - rotate it soon (rerun deploy with the renewed files).`,
      );
    }
  }

  const hosts = requiredTlsHostnames(config);
  const uncovered: string[] = [];
  const entries: TlsSecretPlanEntry[] = [];
  for (const host of hosts) {
    const covering = parsed.find((cert) =>
      certificateCoversHost(cert.info.dnsNames, host),
    );
    if (!covering) {
      uncovered.push(host);
      continue;
    }
    entries.push({
      host,
      secretName: tlsSecretNameForHost(host, config.domain, releaseName),
      certPem: covering.certPem,
      keyPem: covering.keyPem,
    });
  }

  if (uncovered.length > 0) {
    const sanSummary = parsed
      .map((cert) => `  ${cert.label}: ${cert.info.dnsNames.join(", ") || "(no DNS names)"}`)
      .join("\n");
    throw new Error(
      [
        `The provided certificates do not cover: ${uncovered.join(", ")}.`,
        "Certificate coverage:",
        sanSummary,
        "Note: a wildcard (*.example.com) covers one subdomain label and NOT the apex - a single-certificate setup needs both the apex and the wildcard as SANs.",
      ].join("\n"),
    );
  }

  return { entries, warnings };
}

export interface TlsCertificateSummary {
  certFile: string;
  dnsNames: string[];
  /** Set when the file is unreadable or unparseable on this machine. */
  error?: string;
}

export interface TlsCoverageSummary {
  summaries: TlsCertificateSummary[];
  covered: string[];
  missing: string[];
}

/**
 * Exception-safe coverage report for the wizard: which of `hosts` the given
 * certificate files cover. Unreadable files become per-file errors instead of
 * throwing, so the review screen can always render.
 */
export function summarizeTlsCoverage(
  hosts: string[],
  certificates: TlsCertificateInput[],
): TlsCoverageSummary {
  const summaries: TlsCertificateSummary[] = certificates.map((entry) => {
    try {
      const info = parseCertificate(readFileSync(entry.certFile, "utf8"));
      return { certFile: entry.certFile, dnsNames: info.dnsNames };
    } catch (error) {
      return {
        certFile: entry.certFile,
        dnsNames: [],
        error: error instanceof Error ? error.message : String(error),
      };
    }
  });
  const covered = hosts.filter((host) =>
    summaries.some((s) => certificateCoversHost(s.dnsNames, host)),
  );
  const missing = hosts.filter((host) => !covered.includes(host));
  return { summaries, covered, missing };
}

/**
 * Reads the configured PEM files and plans the TLS secrets to create. Throws
 * with an actionable message on unreadable files, key mismatches, expired
 * certificates, or uncovered hostnames.
 */
export function planTlsSecrets(
  config: DeploymentConfig,
  releaseName: string,
): TlsSecretPlan {
  const certificates = config.tls?.certificates ?? [];
  if (config.tls?.mode !== "provided" || certificates.length === 0) {
    return { entries: [], warnings: [] };
  }
  const pems = certificates.map((entry) => {
    const label = entry.certFile;
    let certPem: string;
    let keyPem: string;
    try {
      certPem = readFileSync(entry.certFile, "utf8");
    } catch {
      throw new Error(`Cannot read certificate file: ${entry.certFile}`);
    }
    try {
      keyPem = readFileSync(entry.keyFile, "utf8");
    } catch {
      throw new Error(`Cannot read private key file: ${entry.keyFile}`);
    }
    return { certPem, keyPem, label };
  });
  return planTlsSecretsFromPems(config, releaseName, pems);
}
