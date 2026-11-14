import { createHash, randomBytes } from "node:crypto";
import bcrypt from "bcryptjs";
import { SignJWT, jwtVerify } from "jose";
import type { CookieOptions, Request, Response } from "express";
import { db } from "./db.js";
import { env, isProduction } from "./env.js";

// ---------- What we trust about a logged-in user ----------
// This comes ONLY from a token the server signed itself. Never from the request body.
export type AuthUser = {
  userId: string;
  workspaceId: string;
  role: "member" | "admin";
};

// ---------- Settings ----------
const ACCESS_TOKEN_MINUTES = 15; // short: a stolen or stale token stops working quickly (case study S6)
const REFRESH_TOKEN_DAYS = 7; // long: the user stays logged in, but the server can revoke it any time
export const ACCESS_COOKIE = "nw_access";
export const REFRESH_COOKIE = "nw_refresh";
const REFRESH_PATH = "/auth";

const secret = new TextEncoder().encode(env.JWT_SECRET);

// ---------- Passwords ----------
export const hashPassword = (password: string) => bcrypt.hash(password, 12);
export const verifyPassword = (password: string, hash: string) => bcrypt.compare(password, hash);

// Used when the email doesn't exist, so a wrong email takes as long as a wrong password.
// Otherwise an attacker could measure response times to find out which emails have accounts.
const DUMMY_HASH = bcrypt.hashSync("not-a-real-password", 12);
export const burnPasswordCheck = (password: string) => bcrypt.compare(password, DUMMY_HASH);

// ---------- Access token (JWT, 15 minutes) ----------
export async function signAccessToken(user: AuthUser): Promise<string> {
  return new SignJWT({ wid: user.workspaceId, role: user.role })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(user.userId)
    .setIssuedAt()
    .setExpirationTime(`${ACCESS_TOKEN_MINUTES}m`)
    .sign(secret);
}

export async function verifyAccessToken(token: string): Promise<AuthUser | null> {
  try {
    const { payload } = await jwtVerify(token, secret, { algorithms: ["HS256"] });
    if (typeof payload.sub !== "string" || typeof payload.wid !== "string") return null;
    const role = payload.role === "admin" ? "admin" : "member";
    return { userId: payload.sub, workspaceId: payload.wid, role };
  } catch {
    return null; // expired, tampered with, or signed with another secret
  }
}

// ---------- Refresh token (random string, stored hashed in the sessions table) ----------
const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");

export async function createSession(userId: string): Promise<string> {
  const refreshToken = randomBytes(32).toString("base64url");
  await db.query(
    `INSERT INTO sessions (user_id, refresh_token_hash, expires_at)
     VALUES ($1, $2, now() + make_interval(days => $3))`,
    [userId, sha256(refreshToken), REFRESH_TOKEN_DAYS],
  );
  return refreshToken;
}

/**
 * Exchanges a refresh token for a new one (rotation) and returns the user.
 * Returns null if the session is unknown, expired, revoked, or the user was disabled.
 * Done in one transaction with a row lock, so the same refresh token can't be used twice in parallel.
 */
export async function rotateSession(refreshToken: string): Promise<{ user: AuthUser; refreshToken: string } | null> {
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    const { rows } = await client.query<{ session_id: string; user_id: string; workspace_id: string; role: AuthUser["role"] }>(
      `SELECT s.id AS session_id, u.id AS user_id, u.workspace_id, u.role
         FROM sessions s JOIN users u ON u.id = s.user_id
        WHERE s.refresh_token_hash = $1
          AND s.revoked_at IS NULL
          AND s.expires_at > now()
          AND u.disabled_at IS NULL
        FOR UPDATE OF s`,
      [sha256(refreshToken)],
    );
    const row = rows[0];
    if (!row) {
      await client.query("ROLLBACK");
      return null;
    }
    await client.query("UPDATE sessions SET revoked_at = now() WHERE id = $1", [row.session_id]);
    const newToken = randomBytes(32).toString("base64url");
    await client.query(
      `INSERT INTO sessions (user_id, refresh_token_hash, expires_at)
       VALUES ($1, $2, now() + make_interval(days => $3))`,
      [row.user_id, sha256(newToken), REFRESH_TOKEN_DAYS],
    );
    await client.query("COMMIT");
    return { user: { userId: row.user_id, workspaceId: row.workspace_id, role: row.role }, refreshToken: newToken };
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

export async function revokeSession(refreshToken: string): Promise<void> {
  await db.query("UPDATE sessions SET revoked_at = now() WHERE refresh_token_hash = $1 AND revoked_at IS NULL", [
    sha256(refreshToken),
  ]);
}

// ---------- Cookies ----------
// httpOnly: JavaScript in the browser can't read them, so an XSS bug can't steal the token (case study S7).
// sameSite lax: the browser won't send them on requests started by other websites.
// secure: only sent over HTTPS in production.
const baseCookie: CookieOptions = { httpOnly: true, sameSite: "lax", secure: isProduction, path: "/" };

export function setAuthCookies(res: Response, accessToken: string, refreshToken: string) {
  res.cookie(ACCESS_COOKIE, accessToken, { ...baseCookie, maxAge: ACCESS_TOKEN_MINUTES * 60_000 });
  // The refresh cookie is only sent to /auth/refresh and /auth/logout, nowhere else.
  res.cookie(REFRESH_COOKIE, refreshToken, {
    ...baseCookie,
    path: REFRESH_PATH,
    maxAge: REFRESH_TOKEN_DAYS * 24 * 60 * 60_000,
  });
}

export function clearAuthCookies(res: Response) {
  res.clearCookie(ACCESS_COOKIE, { ...baseCookie });
  res.clearCookie(REFRESH_COOKIE, { ...baseCookie, path: REFRESH_PATH });
}

export const readCookie = (req: Request, name: string): string | undefined => {
  const value: unknown = req.cookies?.[name];
  return typeof value === "string" ? value : undefined;
};
