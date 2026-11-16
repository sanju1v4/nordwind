-- 004: knowledge base. Documents (which also act as the processing queue) and their searchable chunks.

CREATE TABLE documents (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id     uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  uploaded_by      uuid REFERENCES users(id) ON DELETE SET NULL,
  title            text NOT NULL,
  content_type     text NOT NULL,
  size_bytes       bigint NOT NULL CHECK (size_bytes > 0),
  storage_key      text NOT NULL UNIQUE,            -- private S3 key: workspaces/<workspace>/documents/<id>
  status           text NOT NULL DEFAULT 'uploading'
                   CHECK (status IN ('uploading', 'queued', 'processing', 'ready', 'failed')),
  error            text,                            -- shown to the user when status = failed (case study U3)
  attempts         integer NOT NULL DEFAULT 0,
  run_after        timestamptz NOT NULL DEFAULT now(), -- retry backoff for the worker
  locked_at        timestamptz,                     -- when a worker took the job (to recover crashed workers)
  embedding_model  text,
  chunk_count      integer NOT NULL DEFAULT 0,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, workspace_id)                         -- lets chunks prove they belong to the same workspace
);
CREATE INDEX documents_workspace_created_idx ON documents (workspace_id, created_at DESC);
-- Small partial index for the worker's "next job" query: only rows that still need work.
CREATE INDEX documents_queue_idx ON documents (run_after) WHERE status IN ('queued', 'processing');

CREATE TABLE chunks (
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  document_id   uuid NOT NULL,
  workspace_id  uuid NOT NULL,                      -- copied here so every search filters by tenant directly
  position      integer NOT NULL,
  content       text NOT NULL,
  embedding     vector(1024) NOT NULL,
  -- A chunk can only exist with the SAME workspace as its document; the database enforces it.
  -- Deleting a document deletes its chunks (case study S13).
  FOREIGN KEY (document_id, workspace_id) REFERENCES documents (id, workspace_id) ON DELETE CASCADE
);
CREATE INDEX chunks_document_id_idx ON chunks (document_id);
CREATE INDEX chunks_workspace_id_idx ON chunks (workspace_id);
-- Approximate nearest-neighbour index: search stays fast with millions of chunks (case study D5).
CREATE INDEX chunks_embedding_hnsw_idx ON chunks USING hnsw (embedding vector_cosine_ops);

-- Which documents an answer used, shown under the answer (case study U1).
ALTER TABLE messages ADD COLUMN sources jsonb;
