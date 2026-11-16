import { router, publicProcedure } from "./trpc.js";
import { db } from "./db.js";
import { authRouter } from "./routers/auth.js";
import { chatRouter } from "./routers/chat.js";
import { documentsRouter } from "./routers/documents.js";

export const appRouter = router({
  auth: authRouter,
  chat: chatRouter,
  documents: documentsRouter,

  // Proves API -> Postgres works and that the pgvector extension is installed.
  dbStatus: publicProcedure.query(async () => {
    const { rows } = await db.query<{ version: string; vector: string | null }>(
      "SELECT version() AS version, (SELECT extversion FROM pg_extension WHERE extname = 'vector') AS vector",
    );
    return { postgres: rows[0].version.split(" ").slice(0, 2).join(" "), pgvector: rows[0].vector };
  }),
});

// Only the TYPE is exported to the frontend, so the browser gets autocomplete and type checks
// for every API call without any server code being shipped to it.
export type AppRouter = typeof appRouter;
