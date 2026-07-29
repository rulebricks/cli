/**
 * Shared classifier for cloud CLI authorization failures. Deploy fails open
 * on these (warn + prescribe the admin command) instead of aborting, since
 * enterprise operators commonly lack IAM/RBAC mutate rights that a platform
 * team holds. Kept deliberately narrow: only positive authorization denials
 * match, never generic errors, so a real misconfiguration still hard-stops.
 */

const AUTHORIZATION_PATTERNS: RegExp[] = [
  // AWS
  /AccessDenied(Exception)?/i,
  /not authorized to perform/i,
  /UnauthorizedOperation/i,
  // Azure
  /AuthorizationFailed/i,
  /ForbiddenByRbac/i,
  /does not have authorization/i,
  /Caller is not authorized/i,
  /\bForbidden\b/i,
  // GCP
  /PERMISSION_DENIED/i,
  /does not have permission/i,
];

/** True when a cloud CLI's stderr indicates an authorization (IAM/RBAC) denial. */
export function isCloudAuthorizationError(text: string): boolean {
  if (!text) return false;
  return AUTHORIZATION_PATTERNS.some((pattern) => pattern.test(text));
}

/**
 * Kubernetes API RBAC denial (kubectl/helm output). Separate from the cloud
 * patterns because "forbidden" alone is too broad for cloud CLIs but is the
 * canonical k8s phrasing ('... is forbidden: User "x" cannot create ...').
 */
export function isKubernetesForbiddenError(text: string): boolean {
  if (!text) return false;
  return /is forbidden|forbidden:|\bUnauthorized\b|cannot (create|get|list|patch|update) resource/i.test(
    text,
  );
}
