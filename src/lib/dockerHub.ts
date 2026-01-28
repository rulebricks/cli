/**
 * Docker Hub API client for fetching image tags
 * 
 * Uses the license key as a Docker PAT for authentication
 * to access private Rulebricks images.
 */

const DOCKER_HUB_API = 'https://hub.docker.com/v2';
const DOCKER_USERNAME = 'rulebricks';

/**
 * Represents a Docker image tag with metadata
 */
export interface ImageTag {
  /** Tag name (e.g., "1.2.3" or "v1.2.3") */
  name: string;
  /** When the tag was last updated/pushed */
  lastUpdated: Date;
  /** Image digest */
  digest: string;
  /** Full image size in bytes */
  fullSize: number;
}

/**
 * Docker Hub API response for tag listing
 */
interface DockerHubTagsResponse {
  count: number;
  next: string | null;
  previous: string | null;
  results: Array<{
    name: string;
    last_updated: string;
    digest: string;
    full_size: number;
    images: Array<{
      architecture: string;
      digest: string;
    }>;
  }>;
}

/**
 * Docker Hub login response
 */
interface DockerHubLoginResponse {
  token: string;
}

/**
 * Formats the license key as a Docker PAT
 */
export function formatDockerPat(licenseKey: string): string {
  // If already formatted, return as-is
  if (licenseKey.startsWith('dckr_pat_')) {
    return licenseKey;
  }
  return `dckr_pat_${licenseKey}`;
}

/**
 * Authenticates with Docker Hub using the license key as a PAT
 * 
 * @param licenseKey - The Rulebricks license key (used as Docker PAT)
 * @returns JWT token for subsequent API calls
 */
export async function authenticateDockerHub(licenseKey: string): Promise<string> {
  const dockerPat = formatDockerPat(licenseKey);
  
  const response = await fetch(`${DOCKER_HUB_API}/users/login`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      username: DOCKER_USERNAME,
      password: dockerPat,
    }),
  });

  if (!response.ok) {
    if (response.status === 401) {
      throw new Error('Invalid license key - Docker Hub authentication failed');
    }
    throw new Error(`Docker Hub authentication failed: ${response.status} ${response.statusText}`);
  }

  const data = await response.json() as DockerHubLoginResponse;
  return data.token;
}

/**
 * Fetches available tags for a Docker Hub repository
 * 
 * @param repo - Repository name (e.g., "rulebricks/app")
 * @param token - JWT token from authentication
 * @param pageSize - Number of tags to fetch per page (max 100)
 * @returns Array of image tags sorted by last updated (newest first)
 */
export async function fetchImageTags(
  repo: string,
  token: string,
  pageSize: number = 100
): Promise<ImageTag[]> {
  const allTags: ImageTag[] = [];
  let url: string | null = `${DOCKER_HUB_API}/repositories/${repo}/tags?page_size=${pageSize}`;

  while (url) {
    const response = await fetch(url, {
      headers: {
        'Authorization': `Bearer ${token}`,
      },
    });

    if (!response.ok) {
      if (response.status === 404) {
        throw new Error(`Repository not found: ${repo}`);
      }
      throw new Error(`Failed to fetch tags for ${repo}: ${response.status}`);
    }

    const data = await response.json() as DockerHubTagsResponse;
    
    for (const tag of data.results) {
      // Skip non-semver tags like "latest", "dev", etc.
      if (!isValidVersionTag(tag.name)) {
        continue;
      }
      
      allTags.push({
        name: tag.name,
        lastUpdated: new Date(tag.last_updated),
        digest: tag.digest,
        fullSize: tag.full_size,
      });
    }

    // Get next page if available (limit to reasonable number of versions)
    url = data.next && allTags.length < 50 ? data.next : null;
  }

  // Sort by last updated, newest first
  allTags.sort((a, b) => b.lastUpdated.getTime() - a.lastUpdated.getTime());

  return allTags;
}

/**
 * Checks if a tag looks like a valid semantic version
 * Excludes "latest" and other non-numeric tags
 */
function isValidVersionTag(tag: string): boolean {
  // Exclude "latest" and similar non-versioned tags
  if (tag === 'latest' || tag === 'dev' || tag === 'main' || tag === 'master') {
    return false;
  }
  
  // Match patterns like "1.2.3", "v1.2.3", "1.2.3-beta.1"
  const versionPattern = /^v?\d+\.\d+\.\d+(-[\w.]+)?$/;
  return versionPattern.test(tag);
}

/**
 * Fetches tags for both app and HPS repositories
 * 
 * @param licenseKey - The Rulebricks license key
 * @returns Object containing app and HPS tags
 */
export async function fetchAllImageTags(licenseKey: string): Promise<{
  appTags: ImageTag[];
  hpsTags: ImageTag[];
}> {
  const token = await authenticateDockerHub(licenseKey);
  
  const [appTags, hpsTags] = await Promise.all([
    fetchImageTags('rulebricks/app', token),
    fetchImageTags('rulebricks/hps', token),
  ]);

  return { appTags, hpsTags };
}

/**
 * Normalizes a version string by removing leading 'v'
 */
export function normalizeVersion(version: string): string {
  return version.replace(/^v/, '');
}

/**
 * Formats a version for display (ensures 'v' prefix)
 */
export function formatVersionDisplay(version: string): string {
  const normalized = normalizeVersion(version);
  return `v${normalized}`;
}
