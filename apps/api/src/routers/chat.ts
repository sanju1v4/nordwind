import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { router, protectedProcedure } from "../trpc.js";
import { db } from "../db.js";
import { assertOwnsConversation, workspaceAllowedModels } from "../conversations.js";
import { configuredProviders, modelsFor } from "../llm/models.js";

const PAGE_SIZE = 30;
const MESSAGES_PAGE_SIZE = 50;

const conversationId = z.string().uuid();

export const chatRouter = router({
  // Models this user may pick: configured on the server AND allowed for their workspace (case study S10/U4).
  // The dropdown is built from this, so it never shows a model that can't work.
  models: protectedProcedure.query(async ({ ctx }) => {
    const allowed = await workspaceAllowedModels(db, ctx.user.workspaceId);
    return modelsFor(allowed, configuredProviders()).map((m) => ({ id: m.id, label: m.label }));
  }),

  // Sending a message happens in routes/chatStream.ts, because the answer is streamed token by token.

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
      const { rows } = await db.query<{ id: string; role: "user" | "assistant"; content: string; model: string | null; created_at: Date }>(
        `SELECT id, role, content, model, created_at
           FROM messages
          WHERE conversation_id = $1 AND ($2::bigint IS NULL OR id < $2::bigint)
          ORDER BY id DESC
          LIMIT $3`,
        [input.conversationId, input.beforeId ?? null, MESSAGES_PAGE_SIZE + 1],
      );
      const hasMore = rows.length > MESSAGES_PAGE_SIZE;
      const page = rows.slice(0, MESSAGES_PAGE_SIZE).reverse(); // oldest first for display
      return {
        items: page.map((m) => ({ id: m.id, role: m.role, content: m.content, model: m.model, createdAt: m.created_at.toISOString() })),
        olderCursor: hasMore ? page[0]?.id ?? null : null,
      };
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
