-- 002: conversations and messages.

CREATE TABLE conversations (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id  uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id       uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title         text NOT NULL DEFAULT 'New chat',
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);
-- Matches the sidebar query exactly: "my chats, newest first" (case study D3/D4).
CREATE INDEX conversations_user_updated_idx ON conversations (user_id, updated_at DESC, id DESC);

CREATE TABLE messages (
  id               bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  -- ON DELETE CASCADE: deleting a chat really deletes its messages (case study S13, GDPR).
  conversation_id  uuid NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  role             text NOT NULL CHECK (role IN ('user', 'assistant')),
  content          text NOT NULL CHECK (length(content) <= 20000),
  created_at       timestamptz NOT NULL DEFAULT now()
);
-- Matches "messages of one chat, in order" without scanning the whole table (case study D4).
CREATE INDEX messages_conversation_id_idx ON messages (conversation_id, id);
