/**
 * Declarative collection sync against a Rulebricks instance.
 *
 * Streams a JSON dictionary into POST /api/v1/values/sync so the collection
 * ends up exactly equal to the file: values in the file are upserted
 * (ids preserved), and values under the collection that are absent from the
 * file are archived (or hard-deleted with --permanently-delete). Large files
 * are driven as a chunked run: every chunk stages its names under one
 * sync id, and nothing is removed until the final call completes the run -
 * so an interrupted sync never removes anything and re-running is safe.
 */

import { promises as fs } from "node:fs";
import { chunkEntries, flattenValues } from "./valuesImport.js";

const CHUNK_RETRIES = 3;

export interface SyncProgress {
  processed: number;
  total: number;
  chunk: number;
  chunkCount: number;
}

export interface SyncResult {
  processed: number;
  created: number;
  updated: number;
  unchanged: number;
  archived: number;
  deleted: number;
  blocked: Array<{ id: string; name: string; reason: string }>;
  errors: Array<{ name: string; error: string }>;
  chunkCount: number;
  dryRun: boolean;
}

interface SyncResponseBody {
  created?: number;
  updated?: number;
  unchanged?: number;
  archived?: number;
  deleted?: number;
  blocked?: Array<{ id: string; name: string; reason: string }>;
  errors?: Array<{ name: string; error: string }>;
  /** Set when a retried finalize replays a completed run's stored result. */
  already_completed?: boolean;
}

async function postSync(
  baseUrl: string,
  apiKey: string,
  body: Record<string, unknown>,
): Promise<SyncResponseBody> {
  const endpoint = `${baseUrl.replace(/\/$/, "")}/api/v1/values/sync`;
  let lastError: Error | null = null;

  for (let attempt = 1; attempt <= CHUNK_RETRIES; attempt++) {
    try {
      const response = await fetch(endpoint, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-api-key": apiKey,
        },
        body: JSON.stringify(body),
      });

      if (response.ok) {
        return (await response.json()) as SyncResponseBody;
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

  throw lastError ?? new Error("Sync request failed");
}

/**
 * Syncs a collection to exactly the contents of a JSON dictionary file.
 * Keys in the file are relative to the collection ("A123" becomes
 * "<collection>.A123"); nested objects flatten with dot notation, and
 * payloads may use { "$ref": "<value name>" } reference markers.
 */
export async function syncValuesFile(options: {
  filePath: string;
  url: string;
  apiKey: string;
  collection: string;
  permanentlyDelete?: boolean;
  dryRun?: boolean;
  onProgress?: (progress: SyncProgress) => void;
}): Promise<SyncResult> {
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
  const chunks = chunkEntries(entries);
  const total = entries.length;

  const result: SyncResult = {
    processed: 0,
    created: 0,
    updated: 0,
    unchanged: 0,
    archived: 0,
    deleted: 0,
    blocked: [],
    errors: [],
    chunkCount: Math.max(chunks.length, 1),
    dryRun: options.dryRun === true,
  };

  const accumulate = (body: SyncResponseBody) => {
    result.created += body.created ?? 0;
    result.updated += body.updated ?? 0;
    result.unchanged += body.unchanged ?? 0;
    result.archived += body.archived ?? 0;
    result.deleted += body.deleted ?? 0;
    result.blocked.push(...(body.blocked ?? []));
    result.errors.push(...(body.errors ?? []));
  };

  // Single request: the server upserts, sweeps, and (for dry runs) previews
  // in one call. An empty file is legal - it empties the collection.
  if (chunks.length <= 1) {
    const body = await postSync(options.url, options.apiKey, {
      collection: options.collection,
      values: Object.fromEntries(chunks[0] ?? []),
      ...(options.permanentlyDelete ? { permanently_delete: true } : {}),
      ...(options.dryRun ? { dry_run: true } : {}),
    });
    accumulate(body);
    result.processed = total;
    options.onProgress?.({
      processed: total,
      total,
      chunk: 1,
      chunkCount: 1,
    });
    return result;
  }

  if (options.dryRun) {
    throw new Error(
      "Dry runs are only supported for syncs that fit in one request. " +
        "Reduce the file size or run without --dry-run.",
    );
  }

  // Chunked run: stage every chunk under one sync id, then finalize. The
  // sweep only happens on the completing call, so interrupting (or
  // re-running) a partial sync never removes anything.
  const syncId = `cli-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  for (let i = 0; i < chunks.length; i++) {
    const body = await postSync(options.url, options.apiKey, {
      collection: options.collection,
      sync_id: syncId,
      values: Object.fromEntries(chunks[i]),
    });
    accumulate(body);
    result.processed += chunks[i].length;
    options.onProgress?.({
      processed: result.processed,
      total,
      chunk: i + 1,
      chunkCount: chunks.length,
    });
  }

  // postSync returns exactly one body even when it retried internally: if an
  // earlier finalize attempt completed server-side but the response was lost,
  // the retry replays the stored result with already_completed: true. That
  // replayed body is authoritative for the finalize step, so accumulate it
  // exactly once here - never skip it and never accumulate per attempt.
  const finalize = await postSync(options.url, options.apiKey, {
    collection: options.collection,
    sync_id: syncId,
    complete: true,
    ...(options.permanentlyDelete ? { permanently_delete: true } : {}),
  });
  accumulate(finalize);

  return result;
}
