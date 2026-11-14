import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { router, publicProcedure, protectedProcedure } from "../trpc.js";
import { db } from "../db.js";
import {
  burnPasswordCheck,
  createSession,
  setAuthCookies,
  signAccessToken,
  verifyPassword,
  type AuthUser,
} from "../auth.js";

export const authRouter = router({
  login: publicProcedure
    .input(z.object({ email: z.string().email().max(200), password: z.string().min(1).max(200) }))
    .mutation(async ({ ctx, input }) => {
      const { rows } = await db.query<{
        id: string;
        workspace_id: string;
        role: AuthUser["role"];
        password_hash: string;
        disabled_at: Date | null;
      }>("SELECT id, workspace_id, role, password_hash, disabled_at FROM users WHERE email = $1", [
        input.email.toLowerCase(),
      ]);
      const row = rows[0];

      // Same error and same timing whether the email or the password is wrong.
      const ok = row ? await verifyPassword(input.password, row.password_hash) : await burnPasswordCheck(input.password);
      if (!row || !ok || row.disabled_at) {
        throw new TRPCError({ code: "UNAUTHORIZED", message: "Invalid email or password" });
      }

      const user: AuthUser = { userId: row.id, workspaceId: row.workspace_id, role: row.role };
      setAuthCookies(ctx.res, await signAccessToken(user), await createSession(user.userId));
      return { ok: true };
    }),

  // Who am I? The workspace id comes from the token; names are read fresh from the database.
  me: protectedProcedure.query(async ({ ctx }) => {
    const { rows } = await db.query<{ email: string; role: string; workspace_name: string }>(
      `SELECT u.email, u.role, w.name AS workspace_name
         FROM users u JOIN workspaces w ON w.id = u.workspace_id
        WHERE u.id = $1 AND u.workspace_id = $2 AND u.disabled_at IS NULL`,
      [ctx.user.userId, ctx.user.workspaceId],
    );
    if (!rows[0]) throw new TRPCError({ code: "UNAUTHORIZED" });
    return { email: rows[0].email, role: rows[0].role, workspace: rows[0].workspace_name };
  }),
});
