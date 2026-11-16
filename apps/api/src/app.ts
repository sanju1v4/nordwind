import express from "express";
import cookieParser from "cookie-parser";
import { createExpressMiddleware } from "@trpc/server/adapters/express";
import { appRouter } from "./router.js";
import { contextFactory, type Services } from "./trpc.js";
import { httpDuration, registry } from "./metrics.js";
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

/** Builds the whole HTTP app. Tests call this with fakes; index.ts calls it with the real providers and S3. */
export function createApp(providers: Record<string, Provider>, services: Services, models?: ModelConfig[]) {
  const app = express();
  app.disable("x-powered-by");
  app.use(cookieParser());

  // Time every request. The route label is a known name, never the raw URL (bounded label values).
  const procedures = new Set(Object.keys(appRouter._def.procedures));
  app.use((req, res, next) => {
    if (req.path === "/metrics" || req.path === "/livez" || req.path === "/readyz" || req.path === "/api/chat/stream") return next();
    const end = httpDuration.startTimer();
    const path = req.path; // read NOW: Express strips the "/trpc" mount prefix from req.path during routing
    res.on("finish", () => {
      const name = path.startsWith("/trpc/") ? path.slice(6) : path;
      const route = path.startsWith("/trpc/") ? (procedures.has(name) ? `trpc:${name}` : "trpc:unknown")
        : ["/auth/refresh", "/auth/logout"].includes(path) ? path : "other";
      end({ method: req.method, route, status: String(res.statusCode) });
    });
    next();
  });

  // Prometheus scrapes this inside the cluster. The Ingress never routes /metrics to the internet.
  app.get("/metrics", async (_req, res) => {
    res.set("content-type", registry.contentType);
    res.send(await registry.metrics());
  });

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
  app.use(chatStreamRouter(providers, services, models));

  app.use(
    "/trpc",
    express.json({ limit: "1mb" }), // small on purpose: files will go straight to S3 later (case study S9)
    createExpressMiddleware({ router: appRouter, createContext: contextFactory(services) }),
  );

  return app;
}
