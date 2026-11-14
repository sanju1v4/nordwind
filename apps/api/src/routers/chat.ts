import { z } from "zod";
import { TRPCError } from "@trpc/server";
import type { PoolClient } from "pg";
import { router, protectedProcedure } from "../trpc.js";
import { db } from "../db.js";
import type { AuthUser } from "../auth.js";

const PAGE_SIZE = 30;
const MESSAGES_PAGE_SIZE = 50;

/**
 * THE ownership check (fix for case study S3).
 * Every procedure that receives a conversationId calls this before touching the conversation.
 * Matches on the conversation id AND the user AND the workspace from the token.
 * Answers NOT_FOUND (not FORBIDDEN) so an attacker can't even learn that the id exists.
 */
async function assertOwnsConversation(q: Pick<PoolClient, "query">, user: AuthUser, conversationId: string) {
  const { rowCount } = await q.query(
    "SELECT 1 FROM conversations WHERE id = $1 AND user_id = $2 AND workspace_id = $3",
    [conversationId, user.userId, user.workspaceId],
  );
  if (!rowCount) throw new TRPCError({ code: "NOT_FOUND", message: "Conversation not found" });
}

const conversationId = z.string().uuid();

export const chatRouter = router({
  // Sidebar: titles only, 30 at a time, newest first (fix for case study D3: no N+1, no loading every message).
  // "Keyset" pagination: the cursor is the last row's (updated_at, id), so page 2 starts exactly after page 1.
  list: protectedProcedure
    .input(z.object({ cursor: z.object({ updatedAt: z.string(), id: z.string().uuid() }).optional() }))
    .query(async ({ ctx, input }) => {
      const { rows } = await db.query<{ id: string; title: string; updated_at: Date; cursor_ts: string }>(
        `SELECT id, title, updated_at, updated_at::text AS cursor_ts
           FROM conversations
          WHERE user_id = $1 AND workspace_id = $2
            AND ($3::timestamptz IS NULL OR (updated_at, id) < ($3::timestamptz, $4::uuid))
          ORDER BY updated_at DESC, id DESC
          LIMIT $5`,
        [ctx.user.userId, ctx.user.workspaceId, input.cursor?.updatedAt ?? null, input.cursor?.id ?? null, PAGE_SIZE + 1],
      );
      const hasMore = rows.length > PAGE_SIZE;
      const page = rows.slice(0, PAGE_SIZE);
      const last = page.at(-1);
      return {
        items: page.map((r) => ({ id: r.id, title: r.title, updatedAt: r.updated_at.toISOString() })),
        nextCursor: hasMore && last ? { updatedAt: last.cursor_ts, id: last.id } : null,
      };
    }),

  create: protectedProcedure.mutation(async ({ ctx }) => {
    // workspace_id and user_id come from the token, never from the input.
    const { rows } = await db.query<{ id: string; title: string; updated_at: Date }>(
      "INSERT INTO conversations (workspace_id, user_id) VALUES ($1, $2) RETURNING id, title, updated_at",
      [ctx.user.workspaceId, ctx.user.userId],
    );
    const c = rows[0];
    return { id: c.id, title: c.title, updatedAt: c.updated_at.toISOString() };
  }),

  // Messages of one chat: the newest 50, or the 50 before `beforeId` when scrolling up.
  messages: protectedProcedure
    .input(z.object({ conversationId, beforeId: z.string().regex(/^\d+$/).optional() }))
    .query(async ({ ctx, input }) => {
      await assertOwnsConversation(db, ctx.user, input.conversationId);
      const { rows } = await db.query<{ id: string; role: "user" | "assistant"; content: string; created_at: Date }>(
        `SELECT id, role, content, created_at
           FROM messages
          WHERE conversation_id = $1 AND ($2::bigint IS NULL OR id < $2::bigint)
          ORDER BY id DESC
          LIMIT $3`,
        [input.conversationId, input.beforeId ?? null, MESSAGES_PAGE_SIZE + 1],
      );
      const hasMore = rows.length > MESSAGES_PAGE_SIZE;
      const page = rows.slice(0, MESSAGES_PAGE_SIZE).reverse(); // oldest first for display
      return {
        items: page.map((m) => ({ id: m.id, role: m.role, content: m.content, createdAt: m.created_at.toISOString() })),
        olderCursor: hasMore ? page[0]?.id ?? null : null,
      };
    }),

  send: protectedProcedure
    .input(z.object({ conversationId, content: z.string().trim().min(1).max(20_000) }))
    .mutation(async ({ ctx, input }) => {
      const client = await db.connect();
      try {
        await client.query("BEGIN"); // all rows below are written together, or not at all
        await assertOwnsConversation(client, ctx.user, input.conversationId);

        await client.query("INSERT INTO messages (conversation_id, role, content) VALUES ($1, 'user', $2)", [
          input.conversationId,
          input.content,
        ]);

        // Placeholder until step 5 connects a real model.
        const reply = `(AI replies arrive in step 5.) You said: "${input.content.slice(0, 200)}"`;
        await client.query("INSERT INTO messages (conversation_id, role, content) VALUES ($1, 'assistant', $2)", [
          input.conversationId,
          reply,
        ]);

        // First message becomes the title; bump updated_at so the chat moves to the top of the sidebar.
        await client.query(
          `UPDATE conversations
              SET updated_at = now(),
                  title = CASE WHEN title = 'New chat' THEN left($2, 60) ELSE title END
            WHERE id = $1`,
          [input.conversationId, input.content],
        );
        await client.query("COMMIT");
        return { reply };
      } catch (err) {
        await client.query("ROLLBACK");
        throw err;
      } finally {
        client.release();
      }
    }),

  // A real delete: messages go with it through ON DELETE CASCADE (case study S13).
  delete: protectedProcedure.input(z.object({ conversationId })).mutation(async ({ ctx, input }) => {
    const { rowCount } = await db.query("DELETE FROM conversations WHERE id = $1 AND user_id = $2 AND workspace_id = $3", [
      input.conversationId,
      ctx.user.userId,
      ctx.user.workspaceId,
    ]);
    if (!rowCount) throw new TRPCError({ code: "NOT_FOUND", message: "Conversation not found" });
    return { ok: true };
  }),
});
