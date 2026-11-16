-- 000: database extensions the schema needs. "IF NOT EXISTS" makes it safe on databases where
-- they were already enabled by hand (like the Neon project created in step 1).
CREATE EXTENSION IF NOT EXISTS vector; -- pgvector: embeddings + similarity search (used from 004)
