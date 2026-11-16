import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { router, protectedProcedure } from "../trpc.js";
import { db } from "../db.js";
import { ALLOWED_TYPES, MAX_UPLOAD_BYTES } from "../documents/extract.js";

/**
 * The workspace knowledge base. Everyone in a workspace sees its documents; nobody outside ever does.
 * There is deliberately no "share with everyone" option (case study S1).
 */
const documentId = z.string().uuid();

function storageOrFail(storage: unknown) {
  if (!storage) {
    throw new TRPCError({ code: "PRECONDITION_FAILED", message: "File storage is not configured on this server (S3_BUCKET is missing)." });
  }
}

export const documentsRouter = router({
  list: protectedProcedure.query(async ({ ctx }) => {
    const { rows } = await db.query<{
      id: string; title: string; status: string; error: string | null; size_bytes: string; chunk_count: number; created_at: Date;
    }>(
      `SELECT id, title, status, error, size_bytes, chunk_count, created_at
         FROM documents WHERE workspace_id = $1 ORDER BY created_at DESC LIMIT 200`,
      [ctx.user.workspaceId],
    );
    return {
      enabled: ctx.services.storage !== null,
      items: rows.map((r) => ({
        id: r.id, title: r.title, status: r.status, error: r.error,
        sizeBytes: Number(r.size_bytes), chunks: r.chunk_count, createdAt: r.created_at.toISOString(),
      })),
    };
  }),

  /** Step 1 of an upload: check the file, reserve a row, hand out a 5-minute upload URL for the browser. */
  createUpload: protectedProcedure
    .input(z.object({
      fileName: z.string().trim().min(1).max(200),
      contentType: z.string(),
      sizeBytes: z.number().int().positive(),
    }))
    .mutation(async ({ ctx, input }) => {
      storageOrFail(ctx.services.storage);
      if (!ALLOWED_TYPES[input.contentType]) {
        throw new TRPCError({ code: "BAD_REQUEST", message: `This file type is not supported. Allowed: ${Object.values(ALLOWED_TYPES).join(", ")}.` });
      }
      if (input.sizeBytes > MAX_UPLOAD_BYTES) {
        throw new TRPCError({ code: "BAD_REQUEST", message: `File is too large. The limit is ${MAX_UPLOAD_BYTES / 1024 / 1024} MB.` });
      }
      // The storage key contains the workspace from the token and our own id. Never the user's file name:
      // no collisions between companies, no path tricks (case study S4).
      const { rows } = await db.query<{ id: string; storage_key: string }>(
        `WITH id AS (SELECT gen_random_uuid() AS v)
         INSERT INTO documents (id, workspace_id, uploaded_by, title, content_type, size_bytes, storage_key)
         SELECT v, $1::uuid, $2, $3, $4, $5, 'workspaces/' || $1::text || '/documents/' || v::text FROM id
         RETURNING id, storage_key`,
        [ctx.user.workspaceId, ctx.user.userId, input.fileName, input.contentType, input.sizeBytes],
      );
      const doc = rows[0];
      const uploadUrl = await ctx.services.storage!.presignUpload(doc.storage_key, input.contentType);
      return { documentId: doc.id, uploadUrl };
    }),

  /** Step 2: the browser says "uploaded". We check the file really arrived with the promised size, then queue it. */
  completeUpload: protectedProcedure.input(z.object({ documentId })).mutation(async ({ ctx, input }) => {
    storageOrFail(ctx.services.storage);
    const { rows } = await db.query<{ storage_key: string; size_bytes: string; status: string }>(
      "SELECT storage_key, size_bytes, status FROM documents WHERE id = $1 AND workspace_id = $2",
      [input.documentId, ctx.user.workspaceId],
    );
    const doc = rows[0];
    if (!doc) throw new TRPCError({ code: "NOT_FOUND", message: "Document not found" });
    if (doc.status !== "uploading") return { status: doc.status }; // already done: calling twice is harmless

    const actual = await ctx.services.storage!.size(doc.storage_key);
    if (actual === null || actual !== Number(doc.size_bytes) || actual > MAX_UPLOAD_BYTES) {
      await db.query("UPDATE documents SET status = 'failed', error = 'The upload did not complete. Please try again.' WHERE id = $1", [input.documentId]);
      if (actual !== null) await ctx.services.storage!.delete(doc.storage_key);
      throw new TRPCError({ code: "BAD_REQUEST", message: "The upload did not complete. Please try again." });
    }
    await db.query("UPDATE documents SET status = 'queued', run_after = now(), updated_at = now() WHERE id = $1", [input.documentId]);
    return { status: "queued" };
  }),

  /** Deletes the row, its chunks (cascade) and the file in storage (case study S13). Uploader or admin only. */
  delete: protectedProcedure.input(z.object({ documentId })).mutation(async ({ ctx, input }) => {
    const { rows } = await db.query<{ storage_key: string; uploaded_by: string | null }>(
      "SELECT storage_key, uploaded_by FROM documents WHERE id = $1 AND workspace_id = $2",
      [input.documentId, ctx.user.workspaceId],
    );
    const doc = rows[0];
    if (!doc) throw new TRPCError({ code: "NOT_FOUND", message: "Document not found" });
    if (doc.uploaded_by !== ctx.user.userId && ctx.user.role !== "admin") {
      throw new TRPCError({ code: "FORBIDDEN", message: "Only the person who uploaded this document or an admin can delete it." });
    }
    await db.query("DELETE FROM documents WHERE id = $1", [input.documentId]);
    if (ctx.services.storage) {
      await ctx.services.storage.delete(doc.storage_key).catch((err: Error) =>
        // The row is gone, so the file is unreachable; log it for a cleanup job instead of failing the user.
        console.error(JSON.stringify({ msg: "storage_delete_failed", documentId: input.documentId, error: err.message })),
      );
    }
    return { ok: true };
  }),
});
