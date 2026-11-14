import { TRPCError } from "@trpc/server";
import type { PoolClient } from "pg";
import type { AuthUser } from "./auth.js";

/**
 * THE ownership check (fix for case study S3), shared by tRPC and the streaming route.
 * Matches the conversation id AND the user AND the workspace from the token.
 * Answers NOT_FOUND (not FORBIDDEN) so an attacker can't even learn that the id exists.
 */
export async function assertOwnsConversation(q: Pick<PoolClient, "query">, user: AuthUser, conversationId: string) {
  const { rowCount } = await q.query(
    "SELECT 1 FROM conversations WHERE id = $1 AND user_id = $2 AND workspace_id = $3",
    [conversationId, user.userId, user.workspaceId],
  );
  if (!rowCount) throw new TRPCError({ code: "NOT_FOUND", message: "Conversation not found" });
}

export async function workspaceAllowedModels(q: Pick<PoolClient, "query">, workspaceId: string): Promise<string[] | null> {
  const { rows } = await q.query<{ allowed_models: string[] | null }>("SELECT allowed_models FROM workspaces WHERE id = $1", [workspaceId]);
  return rows[0]?.allowed_models ?? null;
}
