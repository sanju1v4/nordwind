import { env } from "./env.js"; // first: refuses to start if configuration is missing
import express from "express";
import cookieParser from "cookie-parser";
import { createExpressMiddleware } from "@trpc/server/adapters/express";
import { appRouter } from "./router.js";
import { createContext } from "./trpc.js";
import { db } from "./db.js";
import {
  REFRESH_COOKIE,
  clearAuthCookies,
  readCookie,
  revokeSession,
  rotateSession,
  setAuthCookies,
  signAccessToken,
} from "./auth.js";

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

app.use(
  "/trpc",
  express.json({ limit: "1mb" }), // small on purpose: files will go straight to S3 later (case study S9)
  createExpressMiddleware({ router: appRouter, createContext }),
);

const server = app.listen(env.API_PORT, () => {
  console.log(`API listening on http://localhost:${env.API_PORT}`);
});

// Graceful shutdown: finish in-flight requests before exiting (case study O5).
process.on("SIGTERM", () => {
  server.close(() => {
    void db.end().then(() => process.exit(0));
  });
});
