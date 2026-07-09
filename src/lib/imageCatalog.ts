import { promises as fs } from "fs";
import os from "os";
import path from "path";
import { execa } from "execa";
import YAML from "yaml";
import { HELM_CHART_OCI } from "../types/index.js";
import { BUNDLED_IMAGE_MANIFEST } from "../generated/imageManifest.js";
import { DEFAULT_IMAGE_REGISTRY } from "./versions.js";

// ============================================================================
// Image catalog — runtime single source of truth for infrastructure image tags
// ============================================================================
// The helm repo's images/manifest.yaml is the SSOT for every
// docker.io/rulebricks/* image the chart pulls, and it ships INSIDE every
// published chart tarball. Instead of pinning tags in the CLI source (which
// forced a CLI release for every helm-repo CVE bump), the CLI resolves the
// manifest for the exact chart version being installed:
//
//   1. ~/.rulebricks/cache/image-manifests/<version>.yaml  (immutable per version)
//   2. helm pull oci://ghcr.io/rulebricks/helm/stack [--version] -> images/manifest.yaml
//   3. https://raw.githubusercontent.com/rulebricks/helm/<ref>/images/manifest.yaml
//   4. bundled snapshot (src/generated/imageManifest.ts) — offline fallback only
//
// app / hps / hps-worker images are governed by global.version (a user
// setting) and are intentionally NOT part of this catalog.

export interface ManifestImage {
  name: string;
  tag: string;
  target?: string;
  digest?: string;
}

export interface ResolvedImage {
  registry: string;
  repository: string;
  tag: string;
  /** Full image reference: registry/repository:tag */
  ref: string;
}

export type ImageCatalogSource = "cache" | "chart" | "github" | "bundled";

/**
 * Manifest image names the CLI references directly. A fetched manifest missing
 * any of these indicates helm-repo schema drift and fails loudly rather than
 * silently generating broken values. Keep in sync with the `required` list in
 * scripts/sync-image-manifest.mjs.
 */
const REQUIRED_IMAGE_NAMES = [
  "curl",
  "hyperdx",
  "clickstack-otel-collector",
  "ferretdb",
  "postgres-documentdb",
  "opentelemetry-collector",
  "kafka-proxy",
  "supabase-postgres",
  "rclone",
  "strimzi-kafka",
  "cluster-autoscaler",
] as const;

const MANIFEST_CACHE_DIR = path.join(
  os.homedir(),
  ".rulebricks",
  "cache",
  "image-manifests",
);

export class ImageCatalog {
  private readonly byName: Map<string, ManifestImage>;
  readonly source: ImageCatalogSource;
  readonly chartVersion?: string;

  constructor(
    entries: ManifestImage[],
    meta: { source: ImageCatalogSource; chartVersion?: string },
  ) {
    this.byName = new Map(entries.map((entry) => [entry.name, entry]));
    this.source = meta.source;
    this.chartVersion = meta.chartVersion;
  }

  /**
   * Resolves a manifest entry to a full image reference. The repository path
   * (rulebricks/<name>, or the entry's explicit target) never changes; only
   * the registry HOST is overridable (config.imageRegistry).
   */
  image(name: string, registry?: string): ResolvedImage {
    const entry = this.byName.get(name);
    if (!entry) {
      throw new Error(
        `Image "${name}" is missing from the chart image manifest` +
          `${this.chartVersion ? ` (chart ${this.chartVersion})` : ""} — ` +
          "the chart and CLI versions may be incompatible. " +
          "Try upgrading the CLI: npm install -g @rulebricks/cli",
      );
    }
    const reg = registry || DEFAULT_IMAGE_REGISTRY;
    const repository = entry.target || `rulebricks/${entry.name}`;
    return {
      registry: reg,
      repository,
      tag: entry.tag,
      ref: `${reg}/${repository}:${entry.tag}`,
    };
  }

  /**
   * Apache Kafka version derived from the strimzi-kafka image tag
   * (e.g. "1.0.1-debian13-kafka-4.2.0" -> "4.2.0"), so the chart's
   * kafka.version always matches the broker image the operator ships.
   */
  kafkaVersion(): string {
    const tag = this.image("strimzi-kafka").tag;
    const match = tag.match(/-kafka-([0-9][\w.]*)$/);
    if (!match) {
      throw new Error(
        `Cannot derive the Kafka version from the strimzi-kafka image tag "${tag}" — ` +
          "expected a \"-kafka-<version>\" suffix. The manifest schema may have changed.",
      );
    }
    return match[1];
  }

  /**
   * name -> sha256 digest map for global.imageDigests. Digests are written
   * back into the manifest by the helm repo's mirror pipeline
   * (scripts/images/render-digests.sh); entries without one are omitted.
   */
  digests(): Record<string, string> {
    const digests: Record<string, string> = {};
    for (const [name, entry] of this.byName) {
      if (entry.digest) digests[name] = entry.digest;
    }
    return digests;
  }
}

/**
 * Parses an images/manifest.yaml document and validates the entries the CLI
 * depends on. Throws on malformed or drift-y content — a successfully fetched
 * manifest that the CLI cannot understand must fail loudly, not silently fall
 * back to stale bundled tags.
 */
export function parseImageManifest(
  raw: string,
  describeSource: string,
): ManifestImage[] {
  let parsed: unknown;
  try {
    parsed = YAML.parse(raw);
  } catch (err) {
    throw new Error(
      `Failed to parse the chart image manifest from ${describeSource}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }

  const images = (parsed as { images?: unknown } | null)?.images;
  if (!Array.isArray(images)) {
    throw new Error(
      `Chart image manifest from ${describeSource} has no images: list — the manifest schema may have changed.`,
    );
  }

  const entries: ManifestImage[] = [];
  for (const item of images) {
    const entry = item as Record<string, unknown>;
    if (typeof entry?.name !== "string" || typeof entry?.tag !== "string") {
      throw new Error(
        `Chart image manifest from ${describeSource} has a malformed entry (name/tag must be strings): ${JSON.stringify(item)}`,
      );
    }
    entries.push({
      name: entry.name,
      tag: entry.tag,
      ...(typeof entry.target === "string" && entry.target
        ? { target: entry.target }
        : {}),
      ...(typeof entry.digest === "string" && entry.digest
        ? { digest: entry.digest }
        : {}),
    });
  }

  const names = new Set(entries.map((entry) => entry.name));
  const missing = REQUIRED_IMAGE_NAMES.filter((name) => !names.has(name));
  if (missing.length > 0) {
    throw new Error(
      `Chart image manifest from ${describeSource} is missing entries the CLI depends on: ${missing.join(", ")}. ` +
        "The chart and CLI versions may be incompatible; try upgrading the CLI.",
    );
  }

  return entries;
}

/**
 * The snapshot bundled with this CLI release. Offline fallback only — deploy
 * paths resolve the live manifest for the chart version being installed.
 */
export function bundledImageCatalog(): ImageCatalog {
  return new ImageCatalog(BUNDLED_IMAGE_MANIFEST.images, { source: "bundled" });
}

function cachePathFor(version: string): string {
  // Chart versions are semver, but never trust them as path components.
  return path.join(MANIFEST_CACHE_DIR, `${version.replace(/[^\w.+-]/g, "_")}.yaml`);
}

async function readCachedManifest(version: string): Promise<string | null> {
  try {
    return await fs.readFile(cachePathFor(version), "utf8");
  } catch {
    return null;
  }
}

async function writeCachedManifest(version: string, raw: string): Promise<void> {
  try {
    await fs.mkdir(MANIFEST_CACHE_DIR, { recursive: true });
    await fs.writeFile(cachePathFor(version), raw);
  } catch {
    // Cache is best-effort; never fail resolution over it.
  }
}

/**
 * Pulls the chart (the same OCI ref deploy installs from) and reads
 * images/manifest.yaml out of the tarball. Returns null when the pull fails
 * (offline, registry unreachable) so the chain can continue.
 */
async function fetchManifestFromChart(
  version?: string,
): Promise<{ raw: string; chartVersion?: string } | null> {
  let tmpDir: string | null = null;
  try {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "rb-chart-manifest-"));
    const args = ["pull", HELM_CHART_OCI, "--untar", "--untardir", tmpDir];
    if (version) {
      args.push("--version", version);
    }
    await execa("helm", args, { timeout: 120000 });

    // The tarball's top-level directory is the chart name; discover it instead
    // of hardcoding "stack".
    const dirents = await fs.readdir(tmpDir, { withFileTypes: true });
    const chartDir = dirents.find((entry) => entry.isDirectory());
    if (!chartDir) return null;

    const chartRoot = path.join(tmpDir, chartDir.name);
    const raw = await fs.readFile(
      path.join(chartRoot, "images", "manifest.yaml"),
      "utf8",
    );

    // Read the actual chart version (resolves "latest") so the cache entry is
    // keyed to the immutable release.
    let chartVersion = version;
    if (!chartVersion) {
      try {
        const chartYaml = YAML.parse(
          await fs.readFile(path.join(chartRoot, "Chart.yaml"), "utf8"),
        ) as { version?: string };
        if (typeof chartYaml?.version === "string") {
          chartVersion = chartYaml.version;
        }
      } catch {
        // Version metadata is only used for cache keying.
      }
    }

    return { raw, chartVersion };
  } catch {
    return null;
  } finally {
    if (tmpDir) {
      await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
    }
  }
}

/**
 * Fetches the manifest from the public helm repo on GitHub: by release tag
 * when the chart version is known, else from main (approximates latest).
 * Returns null on any network/HTTP failure so the chain can continue.
 */
async function fetchManifestFromGitHub(version?: string): Promise<string | null> {
  const ref = version ? `v${version}` : "main";
  try {
    const response = await fetch(
      `https://raw.githubusercontent.com/rulebricks/helm/${ref}/images/manifest.yaml`,
      { signal: AbortSignal.timeout(15000) },
    );
    if (!response.ok) return null;
    return await response.text();
  } catch {
    return null;
  }
}

/**
 * Resolves the image catalog for a chart version ("latest"/undefined resolves
 * whatever the registry currently serves — the same chart a versionless
 * `helm install` would pick). Falls back to the bundled snapshot only when
 * every remote source is unreachable (e.g. fully offline `init`).
 */
export async function resolveImageCatalog(
  chartVersion?: string,
): Promise<ImageCatalog> {
  const version =
    chartVersion && chartVersion !== "latest" ? chartVersion : undefined;

  if (version) {
    const cached = await readCachedManifest(version);
    if (cached) {
      return new ImageCatalog(
        parseImageManifest(cached, `cache (chart ${version})`),
        { source: "cache", chartVersion: version },
      );
    }
  }

  const fromChart = await fetchManifestFromChart(version);
  if (fromChart) {
    const entries = parseImageManifest(
      fromChart.raw,
      `chart ${fromChart.chartVersion ?? "(latest)"} (${HELM_CHART_OCI})`,
    );
    if (fromChart.chartVersion) {
      await writeCachedManifest(fromChart.chartVersion, fromChart.raw);
    }
    return new ImageCatalog(entries, {
      source: "chart",
      chartVersion: fromChart.chartVersion,
    });
  }

  const fromGitHub = await fetchManifestFromGitHub(version);
  if (fromGitHub) {
    const ref = version ? `v${version}` : "main";
    const entries = parseImageManifest(fromGitHub, `github.com/rulebricks/helm@${ref}`);
    if (version) {
      await writeCachedManifest(version, fromGitHub);
    }
    return new ImageCatalog(entries, { source: "github", chartVersion: version });
  }

  console.error(
    "warning: could not fetch the chart image manifest (offline?); " +
      "using the image tags bundled with this CLI release. " +
      "They will be refreshed from the chart on the next deploy.",
  );
  return bundledImageCatalog();
}
