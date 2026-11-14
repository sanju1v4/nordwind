# Nordwind - mini enterprise AI platform

A working version of the Nordwind case study, built the right way, step by step.

## Steps so far
1. Postgres + pgvector (Neon, or Docker Compose locally)
2. API skeleton (Express + tRPC) and React frontend (Vite), with liveness/readiness checks
3. Login: workspaces, users, sessions. 15-minute access token + revocable 7-day refresh token, both in httpOnly cookies.
   The workspace always comes from the signed token, never from the browser.
4. Chats: conversations and messages, ownership check on every request, paginated sidebar, real deletes,
   and automated tests proving one company can never read another company's chats.
5. Real AI models with streaming: OpenAI / Anthropic / Mistral (+ an offline demo model), a server-side model
   allow-list, timeouts, retries with backoff, circuit breaker, fallback model, Stop button, exact usage per request.

## Run it (Windows PowerShell, from E:\Nordwind)

```powershell
npm install          # after pulling new code
npm run migrate      # applies new database migrations (run once per change, not on app start)
npm run seed         # creates demo users (once)
npm test             # tenant-isolation tests (runs against the database in .env)
npm run dev:api      # terminal 1 -> http://localhost:3000
npm run dev:web      # terminal 2 -> http://localhost:5173
```

Demo users (password `nordwind-demo-123`): `max@bauer.test` (Bauer Logistik), `anna@lutz.test` (Schreinerei Lutz).

## Checks
- http://localhost:3000/livez  -> `ok` (process alive; never depends on the DB or an AI provider)
- http://localhost:3000/readyz -> `ready` (DB reachable), or 503 if the DB is down

## Security choices (and the case-study problem each one fixes)
| Choice | Case study |
| --- | --- |
| Workspace and user id read only from the signed token (`ctx.user`) | S2, S3 |
| Long random `JWT_SECRET`, API refuses to start without it | S6 |
| 15-minute access token + refresh token that can be revoked (logout, disabled user) | S6 |
| Tokens in httpOnly cookies, not localStorage | S7 |
| Refresh tokens stored only as SHA-256 hashes; each one works once (rotation) | S6 |
| Same error and timing for wrong email and wrong password | - |
| Migrations run as a separate command | R7 |
| Every chat call checks: this conversation belongs to this user AND this workspace (404 otherwise) | S3 |
| Sidebar loads titles only, 30 at a time (keyset pagination); messages load when a chat opens | D3 |
| Indexes match the queries: `(user_id, updated_at DESC, id DESC)`, `(conversation_id, id)` | D4 |
| Deleting a chat deletes its messages (`ON DELETE CASCADE`) | S13 |
| Tests fail if the ownership check is removed (verified) | - |
| Server-side model list + per-workspace allow-list; dropdown built from it; unknown model = 400, not a crash | S10, U4 |
| Timeout for the first token and for the whole answer | R3 |
| Retry only 429 / 5xx / network / timeout, before the first token, with backoff + jitter + Retry-After | R4 |
| Circuit breaker per provider + fallback model (only if the workspace allows it) | R5 |
| Only the last 20 messages (max ~24k characters) go to the model | D7 |
| Streaming answers, Stop button; closing the tab cancels the provider call | D8, U5 |
| One `usage_events` row per request, in the same transaction as the answer | C1 |
| Logs: one JSON line per request with ids, model, tokens, latency, status. Never message text | S8 |
| Errors shown to users are specific and actionable; technical details only in logs | U2 |

## Try the reliability features with the Demo model
Put one of these words in a message: `[fail]` (provider down: watch retries and the error), `[429]` (rate limited),
`[slow]` (first token never arrives in time: watch the timeout).
| No stack traces in production error responses | - |
