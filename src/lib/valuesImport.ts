/**
 * Chunked vocabulary (dynamic values) import against a Rulebricks instance.
 *
 * Streams a large JSON dictionary into POST /api/v1/values in
 * byte-bounded chunks. Each chunk is an idempotent upsert server-side, so
 * failed chunks are retried safely without re-importing everything.
 */

import { promises as fs } from "node:fs";

// Self-hosted instances accept large bodies on the values endpoint; stay well
// under typical proxy limits while keeping round trips low.
const TARGET_CHUNK_BYTES = 2 * 1024 * 1024;
const CHUNK_RETRIES = 3;

export interface ImportProgress {
  processed: number;
  total: number;
  chunk: number;
  chunkCount: number;
  created: number;
  updated: number;
}

export interface ImportResult {
  processed: number;
  created: number;
  updated: number;
  chunkCount: number;
}

type FlatEntries = Array<[string, unknown]>;

/**
 * Returns the referenced value name if the node is a name-based reference
 * marker ({ "$ref": "<value name>" } with no "$rb" key), else null.
 */
function refName(node: unknown): string | null {
  if (node === null || typeof node !== "object" || Array.isArray(node)) {
    return null;
  }
  const record = node as Record<string, unknown>;
  return typeof record.$ref === "string" &&
    record.$ref.length > 0 &&
    !("$rb" in record)
    ? record.$ref
    : null;
}

/**
 * Reference markers the server resolves - name-based ({ "$ref": "<name>" })
 * or id-based ({ "$rb": "globalValue", "id": "..." }) - are leaves; the
 * flattener must not walk into them.
 */
function isReferenceLeaf(node: Record<string, unknown>): boolean {
  return (
    refName(node) !== null ||
    (node.$rb === "globalValue" && typeof node.id === "string")
  );
}

/**
 * Flattens nested objects into dot-notation keys; arrays, primitives, and
 * reference markers are leaves. Keys are preserved exactly as written (the
 * public API does not prettify them).
 */
export function flattenValues(input: Record<string, unknown>): FlatEntries {
  const entries: FlatEntries = [];
  const walk = (node: Record<string, unknown>, prefix: string) => {
    for (const [key, value] of Object.entries(node)) {
      const newKey = prefix ? `${prefix}.${key}` : key;
      if (
        value !== null &&
        typeof value === "object" &&
        !Array.isArray(value) &&
        !isReferenceLeaf(value as Record<string, unknown>)
      ) {
        walk(value as Record<string, unknown>, newKey);
      } else {
        entries.push([newKey, value]);
      }
    }
  };
  walk(input, "");
  return entries;
}

/** Names a payload references via `$ref` markers (the payload itself, or items of a top-level array). */
function extractRefs(value: unknown): string[] {
  const nodes = Array.isArray(value) ? value : [value];
  return nodes
    .map(refName)
    .filter((name): name is string => name !== null);
}

/**
 * Orders entries so `$ref`s to names defined later in the same file still
 * resolve when the file is split into chunks (the server only resolves names
 * in the same request or already in the workspace). Marker-free entries come
 * first in original order, then reference-bearing entries dependency-first
 * (Tarjan's DFS over the name->refs graph), with cycle members emitted
 * adjacently so they land in the same chunk when they fit. A cycle that
 * still straddles a chunk boundary is not resolvable client-side and will
 * surface the server's validation error.
 */
function orderForReferences(entries: FlatEntries): FlatEntries {
  const plain: FlatEntries = [];
  const entryByName = new Map<string, FlatEntries[number]>();
  const refsByName = new Map<string, string[]>();
  for (const entry of entries) {
    const refs = extractRefs(entry[1]);
    if (refs.length === 0) {
      plain.push(entry);
    } else {
      entryByName.set(entry[0], entry);
      refsByName.set(entry[0], refs);
    }
  }
  if (entryByName.size === 0) return entries;

  const ordered = [...plain];
  const index = new Map<string, number>();
  const low = new Map<string, number>();
  const stack: string[] = [];
  const onStack = new Set<string>();
  const visit = (name: string) => {
    index.set(name, index.size);
    low.set(name, index.get(name)!);
    stack.push(name);
    onStack.add(name);
    for (const ref of refsByName.get(name)!) {
      // Names not in this file are presumed to already exist server-side.
      if (!entryByName.has(ref)) continue;
      if (!index.has(ref)) visit(ref);
      if (onStack.has(ref)) {
        low.set(name, Math.min(low.get(name)!, low.get(ref)!));
      }
    }
    if (low.get(name) === index.get(name)) {
      let member: string;
      do {
        member = stack.pop()!;
        onStack.delete(member);
        ordered.push(entryByName.get(member)!);
      } while (member !== name);
    }
  };
  for (const name of entryByName.keys()) {
    if (!index.has(name)) visit(name);
  }
  return ordered;
}

/**
 * Splits flat entries into chunks whose serialized size stays under the
 * target byte budget. Entries are reordered dependency-first so `$ref`s
 * never point at a later chunk (see orderForReferences).
 */
export function chunkEntries(entries: FlatEntries): FlatEntries[] {
  const chunks: FlatEntries[] = [];
  let current: FlatEntries = [];
  let currentBytes = 0;
  for (const entry of orderForReferences(entries)) {
    // Measure encoded bytes, not UTF-16 code units: CJK/emoji-heavy payloads
    // serialize up to 3x larger than .length suggests and would blow past
    // request-size limits.
    const entryBytes =
      Buffer.byteLength(JSON.stringify(entry[0]), "utf8") +
      Buffer.byteLength(JSON.stringify(entry[1] ?? null), "utf8") +
      2;
    if (current.length > 0 && currentBytes + entryBytes > TARGET_CHUNK_BYTES) {
      chunks.push(current);
      current = [];
      currentBytes = 0;
    }
    current.push(entry);
    currentBytes += entryBytes;
  }
  if (current.length > 0) chunks.push(current);
  return chunks;
}

async function postChunk(
  baseUrl: string,
  apiKey: string,
  values: Record<string, unknown>,
): Promise<{ created: number; updated: number }> {
  const endpoint = `${baseUrl.replace(/\/$/, "")}/api/v1/values`;
  let lastError: Error | null = null;

  for (let attempt = 1; attempt <= CHUNK_RETRIES; attempt++) {
    try {
      const response = await fetch(endpoint, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-api-key": apiKey,
        },
        body: JSON.stringify({ values }),
      });

      if (response.ok) {
        const body = (await response.json()) as {
          created?: number;
          updated?: number;
        };
        return { created: body.created ?? 0, updated: body.updated ?? 0 };
      }

      const text = await response.text();
      // 4xx responses are not retriable (validation/auth); fail immediately.
      if (response.status < 500) {
        throw new Error(`HTTP ${response.status}: ${text}`);
      }
      lastError = new Error(`HTTP ${response.status}: ${text}`);
    } catch (error) {
      if (error instanceof Error && error.message.startsWith("HTTP 4")) {
        throw error;
      }
      lastError = error instanceof Error ? error : new Error(String(error));
    }

    if (attempt < CHUNK_RETRIES) {
      await new Promise((resolve) => setTimeout(resolve, attempt * 1000));
    }
  }

  throw lastError ?? new Error("Chunk upload failed");
}

/**
 * Imports a JSON dictionary file of vocabulary values.
 */
export async function importValuesFile(options: {
  filePath: string;
  url: string;
  apiKey: string;
  onProgress?: (progress: ImportProgress) => void;
}): Promise<ImportResult> {
  const raw = await fs.readFile(options.filePath, "utf8");
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(
      `File is not valid JSON: ${error instanceof Error ? error.message : error}`,
    );
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("File must contain a JSON object of key-value pairs.");
  }

  const entries = flattenValues(parsed as Record<string, unknown>);
  if (entries.length === 0) {
    throw new Error("No key-value pairs found in the file.");
  }

  const chunks = chunkEntries(entries);
  const total = entries.length;

  let processed = 0;
  let created = 0;
  let updated = 0;

  for (let i = 0; i < chunks.length; i++) {
    const chunkValues = Object.fromEntries(chunks[i]);
    const result = await postChunk(options.url, options.apiKey, chunkValues);
    processed += chunks[i].length;
    created += result.created;
    updated += result.updated;
    options.onProgress?.({
      processed,
      total,
      chunk: i + 1,
      chunkCount: chunks.length,
      created,
      updated,
    });
  }

  return { processed, created, updated, chunkCount: chunks.length };
}
