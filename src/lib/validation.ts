import dns from 'dns';
import { promisify } from 'util';

const resolveDns = promisify(dns.resolve);
const resolve4 = promisify(dns.resolve4);
const resolveCname = promisify(dns.resolveCname);

/**
 * Validates an email address using a comprehensive regex
 */
export function isValidEmail(email: string): boolean {
  const emailRegex = /^[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*$/;
  return emailRegex.test(email) && email.length <= 254;
}

/**
 * Extracts the base domain from a full domain name
 * e.g., "rulebricks.example.com" -> "example.com"
 */
export function extractBaseDomain(fullDomain: string): string {
  const parts = fullDomain.toLowerCase().split('.');
  
  // Handle common multi-part TLDs
  const multiPartTlds = ['co.uk', 'com.au', 'co.nz', 'co.jp', 'com.br', 'co.za'];
  
  if (parts.length >= 3) {
    const lastTwo = `${parts[parts.length - 2]}.${parts[parts.length - 1]}`;
    if (multiPartTlds.includes(lastTwo)) {
      // For multi-part TLDs, take the last 3 parts
      return parts.slice(-3).join('.');
    }
  }
  
  // For standard TLDs, take the last 2 parts
  if (parts.length >= 2) {
    return parts.slice(-2).join('.');
  }
  
  return fullDomain;
}

/**
 * Validates that a domain is properly formatted
 */
export function isValidDomainFormat(domain: string): boolean {
  // Basic domain format validation
  const domainRegex = /^(?:[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?\.)+[a-zA-Z]{2,}$/;
  return domainRegex.test(domain);
}

/**
 * Checks if the base domain has active DNS records
 */
export async function validateBaseDomain(fullDomain: string): Promise<{
  valid: boolean;
  baseDomain: string;
  error?: string;
}> {
  if (!isValidDomainFormat(fullDomain)) {
    return {
      valid: false,
      baseDomain: '',
      error: 'Invalid domain format'
    };
  }
  
  const baseDomain = extractBaseDomain(fullDomain);
  
  try {
    // Try to resolve the base domain
    // First try A records
    try {
      await resolve4(baseDomain);
      return { valid: true, baseDomain };
    } catch {
      // If A record fails, try any record type
      await resolveDns(baseDomain, 'ANY');
      return { valid: true, baseDomain };
    }
  } catch (err) {
    const error = err as NodeJS.ErrnoException;
    
    if (error.code === 'ENOTFOUND') {
      return {
        valid: false,
        baseDomain,
        error: `Base domain "${baseDomain}" does not exist or has no DNS records`
      };
    }
    
    if (error.code === 'ENODATA') {
      // Domain exists but no records of the requested type
      // This is actually OK for our purposes
      return { valid: true, baseDomain };
    }
    
    // For other errors, assume the domain might be valid
    // (could be temporary DNS issues)
    return { valid: true, baseDomain };
  }
}

/**
 * Checks if a specific hostname resolves to a given target
 */
export async function checkDNSRecord(
  hostname: string,
  expectedTarget?: string
): Promise<{
  resolved: boolean;
  records: string[];
  matchesTarget: boolean;
}> {
  try {
    // Try A record first
    try {
      const aRecords = await resolve4(hostname);
      const matchesTarget = expectedTarget 
        ? aRecords.some(r => r === expectedTarget)
        : true;
      return {
        resolved: true,
        records: aRecords,
        matchesTarget
      };
    } catch {
      // Try CNAME
      const cnameRecords = await resolveCname(hostname);
      const matchesTarget = expectedTarget
        ? cnameRecords.some(r => r === expectedTarget || r.endsWith(expectedTarget))
        : true;
      return {
        resolved: true,
        records: cnameRecords,
        matchesTarget
      };
    }
  } catch {
    return {
      resolved: false,
      records: [],
      matchesTarget: false
    };
  }
}

/**
 * Validates SMTP configuration format
 */
export function validateSMTPConfig(config: {
  host: string;
  port: number;
  user: string;
  pass: string;
  from: string;
  fromName: string;
}): { valid: boolean; errors: string[] } {
  const errors: string[] = [];
  
  if (!config.host || config.host.length < 3) {
    errors.push('SMTP host is required');
  }
  
  if (!config.port || config.port < 1 || config.port > 65535) {
    errors.push('SMTP port must be between 1 and 65535');
  }
  
  if (!config.user) {
    errors.push('SMTP username is required');
  }
  
  if (!config.pass) {
    errors.push('SMTP password is required');
  }
  
  if (!config.from || !isValidEmail(config.from)) {
    errors.push('Valid SMTP from address is required');
  }
  
  if (!config.fromName || config.fromName.length < 1) {
    errors.push('SMTP from name is required');
  }
  
  return {
    valid: errors.length === 0,
    errors
  };
}

/**
 * Generates a secure random string for secrets
 */
export function generateSecureSecret(length: number = 32): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let result = '';
  const randomValues = new Uint8Array(length);
  crypto.getRandomValues(randomValues);
  for (let i = 0; i < length; i++) {
    result += chars[randomValues[i] % chars.length];
  }
  return result;
}
