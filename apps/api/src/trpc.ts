import { initTRPC, TRPCError } from "@trpc/server";
import type { CreateExpressContextOptions } from "@trpc/server/adapters/express";
import { ACCESS_COOKIE, readCookie, verifyAccessToken, type AuthUser } from "./auth.js";
import { isProduction } from "./env.js";

// The context is what every procedure receives.
// `user` comes ONLY from the signed access-token cookie, never from the request body (case study S2).
export async function createContext({ req, res }: CreateExpressContextOptions) {
  const token = readCookie(req, ACCESS_COOKIE);
  const user: AuthUser | null = token ? await verifyAccessToken(token) : null;
  return { req, res, user };
}
export type Context = Awaited<ReturnType<typeof createContext>>;

// isDev false in production = error responses never include stack traces.
const t = initTRPC.context<Context>().create({ isDev: !isProduction });

export const router = t.router;
export const publicProcedure = t.procedure;

// Any procedure built on this refuses callers without a valid token.
// Inside it, ctx.user is guaranteed to exist, so code can use ctx.user.workspaceId safely.
export const protectedProcedure = t.procedure.use(({ ctx, next }) => {
  if (!ctx.user) throw new TRPCError({ code: "UNAUTHORIZED" });
  return next({ ctx: { ...ctx, user: ctx.user } });
});
