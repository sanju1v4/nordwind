import pg from "pg";
import { env } from "./env.js";

// One small, shared connection pool per process.
// Kept small on purpose: pods x pool size must stay under Postgres max_connections (case study D2).
export const db = new pg.Pool({
  connectionString: env.DATABASE_URL,
  max: 10,
  connectionTimeoutMillis: 5_000,
});
