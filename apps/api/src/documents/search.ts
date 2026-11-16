import type { Pool } from "pg";
import { toVector, type Embedder } from "./embeddings.js";

export type FoundChunk = { documentId: string; title: string; content: string; distance: number };

/**
 * Finds the chunks most similar to the question, ONLY inside one workspace (fix for case study S1).
 * workspaceId must come from the verified token, never from the request.
 *
 * hnsw.iterative_scan (pgvector 0.8+): the index keeps searching until it finds enough rows that pass
 * the workspace filter. Without it, a filtered search on a big shared index can return too few results.
 */
export async function searchChunks(db: Pool, embedder: Embedder, workspaceId: string, question: string, limit = 6): Promise<FoundChunk[]> {
  const [vector] = await embedder.embed([question]);
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL hnsw.iterative_scan = relaxed_order");
    const { rows } = await client.query<{ document_id: string; title: string; content: string; distance: number }>(
      `SELECT c.document_id, d.title, c.content, c.embedding <=> $2::vector AS distance
         FROM chunks c JOIN documents d ON d.id = c.document_id AND d.workspace_id = c.workspace_id
        WHERE c.workspace_id = $1 AND d.status = 'ready' AND d.embedding_model = $4
        ORDER BY c.embedding <=> $2::vector
        LIMIT $3`,
      [workspaceId, toVector(vector), limit, embedder.model],
    );
    await client.query("COMMIT");
    return rows.map((r) => ({ documentId: r.document_id, title: r.title, content: r.content, distance: Number(r.distance) }));
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}
