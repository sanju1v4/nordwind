import type { Pool } from "pg";
import type { FileStorage } from "./storage.js";
import { toVector, type Embedder } from "./embeddings.js";
import { chunkText, extractTextFrom } from "./extract.js";

export const MAX_ATTEMPTS = 3;
const STUCK_AFTER = "10 minutes"; // a 'processing' job older than this belongs to a crashed worker

type Job = { id: string; workspace_id: string; storage_key: string; content_type: string; attempts: number };

/**
 * Takes the next document that needs processing, safely, even with many workers running at once.
 * FOR UPDATE SKIP LOCKED: each worker locks a different row; nobody waits, no job is done twice.
 * The documents table IS the queue: no extra queue service to run (SQS or pg-boss would also work).
 */
export async function claimJob(db: Pool): Promise<Job | null> {
  const { rows } = await db.query<Job>(
    `UPDATE documents d
        SET status = 'processing', attempts = d.attempts + 1, locked_at = now(), updated_at = now()
      WHERE d.id = (
              SELECT id FROM documents
               WHERE (status = 'queued' AND run_after <= now())
                  OR (status = 'processing' AND locked_at < now() - interval '${STUCK_AFTER}')
               ORDER BY run_after
               FOR UPDATE SKIP LOCKED
               LIMIT 1)
      RETURNING d.id, d.workspace_id, d.storage_key, d.content_type, d.attempts`,
  );
  return rows[0] ?? null;
}

export type JobDeps = { db: Pool; storage: FileStorage; embedder: Embedder; retryDelaySeconds?: (attempt: number) => number };

/**
 * Processes one job: download -> extract text -> chunk -> embed -> save. Returns false if the queue was empty.
 * Safe to run twice for the same document (idempotent): old chunks are replaced, never duplicated.
 */
export async function processNextJob(deps: JobDeps): Promise<boolean> {
  const job = await claimJob(deps.db);
  if (!job) return false;
  const started = Date.now();

  try {
    const data = await deps.storage.read(job.storage_key);
    const text = await extractTextFrom(data, job.content_type);
    const pieces = chunkText(text);
    const vectors = await deps.embedder.embed(pieces); // batched inside: ~10 calls for a 500-chunk manual, not 500

    const client = await deps.db.connect();
    try {
      await client.query("BEGIN");
      await client.query("DELETE FROM chunks WHERE document_id = $1", [job.id]);
      for (let i = 0; i < pieces.length; i += 100) {
        // One multi-row INSERT per 100 chunks instead of one round-trip per chunk.
        const batch = pieces.slice(i, i + 100);
        const values: unknown[] = [];
        const rows = batch.map((content, j) => {
          values.push(job.id, job.workspace_id, i + j, content, toVector(vectors[i + j]));
          const b = j * 5;
          return `($${b + 1}, $${b + 2}, $${b + 3}, $${b + 4}, $${b + 5})`;
        });
        await client.query(`INSERT INTO chunks (document_id, workspace_id, position, content, embedding) VALUES ${rows.join(", ")}`, values);
      }
      await client.query(
        `UPDATE documents SET status = 'ready', error = NULL, chunk_count = $2, embedding_model = $3, locked_at = NULL, updated_at = now()
          WHERE id = $1`,
        [job.id, pieces.length, deps.embedder.model],
      );
      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
    log({ documentId: job.id, workspaceId: job.workspace_id, status: "ready", chunks: pieces.length, ms: Date.now() - started });
  } catch (err) {
    const message = (err as Error).message;
    const final = job.attempts >= MAX_ATTEMPTS;
    const delay = deps.retryDelaySeconds?.(job.attempts) ?? 30 * 2 ** (job.attempts - 1); // 30s, 60s, ...
    await deps.db.query(
      `UPDATE documents
          SET status = $2, error = $3, locked_at = NULL, updated_at = now(),
              run_after = now() + make_interval(secs => $4)
        WHERE id = $1`,
      [job.id, final ? "failed" : "queued", final ? friendlyError(message) : null, delay],
    );
    log({ documentId: job.id, workspaceId: job.workspace_id, status: final ? "failed" : "retry", attempt: job.attempts, error: message, ms: Date.now() - started });
  }
  return true;
}

function friendlyError(message: string): string {
  if (/No text found/.test(message)) return message;
  if (/Invalid PDF|PDF/.test(message)) return "This PDF could not be read. It may be damaged or password-protected.";
  return "This file could not be processed. Please try uploading it again.";
}

/** Ids and numbers only, never document content (case study S8). */
function log(fields: Record<string, unknown>) {
  console.log(JSON.stringify({ msg: "document_job", time: new Date().toISOString(), ...fields }));
}
