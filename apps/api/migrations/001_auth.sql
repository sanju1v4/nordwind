-- 001: workspaces, users and login sessions.
-- Every customer-owned row carries a workspace_id, so every query can filter by tenant.

CREATE EXTENSION IF NOT EXISTS pgcrypto; -- gen_random_uuid() on older Postgres versions

CREATE TABLE workspaces (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name        text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE users (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id   uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  email          text NOT NULL UNIQUE,
  password_hash  text NOT NULL,
  role           text NOT NULL DEFAULT 'member' CHECK (role IN ('member', 'admin')),
  disabled_at    timestamptz,          -- set this to lock a user out (e.g. they left the company)
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX users_workspace_id_idx ON users (workspace_id);

-- A session = one logged-in device. The refresh cookie points here.
-- We store only a SHA-256 hash of the refresh token: a database leak does not leak live logins.
CREATE TABLE sessions (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id             uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  refresh_token_hash  text NOT NULL UNIQUE,
  expires_at          timestamptz NOT NULL,
  revoked_at          timestamptz,
  created_at          timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX sessions_user_id_idx ON sessions (user_id);
