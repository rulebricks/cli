/**
 * Chunked vocabulary (dynamic values) import against a Rulebricks instance.
 *
 * Streams a large JSON dictionary into POST /api/v1/values/bulk in
 * byte-bounded chunks. Each chunk is an idempotent upsert server-side, so
 * failed chunks are retried safely without re-importing everything.
 */

import { promises as fs } from "node:fs";

// Self-hosted instances accept large bodies on the bulk endpoint; stay well
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
 * Flattens nested objects into dot-notation keys; arrays and primitives are
 * leaves. Key prettification happens server-side.
 */
export function flattenValues(input: Record<string, unknown>): FlatEntries {
  const entries: FlatEntries = [];
  const walk = (node: Record<string, unknown>, prefix: string) => {
    for (const [key, value] of Object.entries(node)) {
      const newKey = prefix ? `${prefix}.${key}` : key;
      if (value !== null && typeof value === "object" && !Array.isArray(value)) {
        walk(value as Record<string, unknown>, newKey);
      } else {
        entries.push([newKey, value]);
      }
    }
  };
  walk(input, "");
  return entries;
}

/**
 * Splits flat entries into chunks whose serialized size stays under the
 * target byte budget.
 */
export function chunkEntries(entries: FlatEntries): FlatEntries[] {
  const chunks: FlatEntries[] = [];
  let current: FlatEntries = [];
  let currentBytes = 0;
  for (const entry of entries) {
    const entryBytes =
      JSON.stringify(entry[0]).length +
      JSON.stringify(entry[1] ?? null).length +
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
  const endpoint = `${baseUrl.replace(/\/$/, "")}/api/v1/values/bulk`;
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
