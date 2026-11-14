# Nordwind - mini enterprise AI platform

A working version of the Nordwind case study, built the right way, step by step.

## Steps so far
1. Postgres + pgvector (Neon, or Docker Compose locally)
2. API skeleton (Express + tRPC) and React frontend (Vite), with liveness/readiness checks
3. Login: workspaces, users, sessions. 15-minute access token + revocable 7-day refresh token, both in httpOnly cookies.
   The workspace always comes from the signed token, never from the browser.

## Run it (Windows PowerShell, from E:\Nordwind)

```powershell
npm install          # after pulling new code
npm run migrate      # applies new database migrations (run once per change, not on app start)
npm run seed         # creates demo users (once)
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
| No stack traces in production error responses | - |
