-- 003: which model answered, which models a workspace may use, and exact usage per request.

-- NULL = every model enabled on this server. Otherwise only the listed model ids (case study S10/U4).
ALTER TABLE workspaces ADD COLUMN allowed_models text[];

ALTER TABLE messages ADD COLUMN model text;

-- One row per AI request, written in the same transaction as the answer (case study C1).
-- Monthly usage = SUM over these rows. Nothing kept only in memory, nothing lost on restart.
CREATE TABLE usage_events (
  id               bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  workspace_id     uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id          uuid REFERENCES users(id) ON DELETE SET NULL,
  conversation_id  uuid REFERENCES conversations(id) ON DELETE SET NULL,
  model            text NOT NULL,
  input_tokens     integer NOT NULL DEFAULT 0,
  output_tokens    integer NOT NULL DEFAULT 0,
  status           text NOT NULL CHECK (status IN ('ok', 'error', 'aborted')),
  latency_ms       integer NOT NULL,
  created_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX usage_events_workspace_created_idx ON usage_events (workspace_id, created_at);
