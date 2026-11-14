import express from "express";
import cookieParser from "cookie-parser";
import { createExpressMiddleware } from "@trpc/server/adapters/express";
import { appRouter } from "./router.js";
import { createContext } from "./trpc.js";
import { db } from "./db.js";
import { chatStreamRouter } from "./routes/chatStream.js";
import type { ModelConfig } from "./llm/models.js";
import type { Provider } from "./llm/types.js";
import {
  REFRESH_COOKIE,
  clearAuthCookies,
  readCookie,
  revokeSession,
  rotateSession,
  setAuthCookies,
  signAccessToken,
} from "./auth.js";

/** Builds the whole HTTP app. Tests call this with fake AI providers; index.ts calls it with the real ones. */
export function createApp(providers: Record<string, Provider>, models?: ModelConfig[]) {
  const app = express();
  app.disable("x-powered-by");
  app.use(cookieParser());

  // The browser reaches the API through the Vite dev proxy (same origin), so no CORS setup is needed.

  // Liveness: "is this process alive?" Never depends on the database or an AI provider (case study R1).
  app.get("/livez", (_req, res) => {
    res.send("ok");
  });

  // Readiness: "can this process serve traffic right now?" Checks only what we own: the database.
  app.get("/readyz", async (_req, res) => {
    try {
      await db.query("SELECT 1");
      res.send("ready");
    } catch {
      res.status(503).send("database unavailable");
    }
  });

  // Refresh and logout are plain routes under /auth, because the refresh cookie is only sent to /auth.
  app.post("/auth/refresh", async (req, res, next) => {
    try {
      const token = readCookie(req, REFRESH_COOKIE);
      const result = token ? await rotateSession(token) : null;
      if (!result) {
        clearAuthCookies(res);
        res.status(401).json({ ok: false });
        return;
      }
      setAuthCookies(res, await signAccessToken(result.user), result.refreshToken);
      res.json({ ok: true });
    } catch (err) {
      next(err);
    }
  });

  app.post("/auth/logout", async (req, res, next) => {
    try {
      const token = readCookie(req, REFRESH_COOKIE);
      if (token) await revokeSession(token);
      clearAuthCookies(res);
      res.json({ ok: true });
    } catch (err) {
      next(err);
    }
  });

  // Chat answers, streamed token by token.
  app.use(chatStreamRouter(providers, models));

  app.use(
    "/trpc",
    express.json({ limit: "1mb" }), // small on purpose: files will go straight to S3 later (case study S9)
    createExpressMiddleware({ router: appRouter, createContext }),
  );

  return app;
}
