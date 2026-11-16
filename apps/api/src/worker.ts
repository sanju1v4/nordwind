import { env } from "./env.js";
import { db } from "./db.js";
import { processNextJob } from "./documents/jobs.js";
import { realServices } from "./services.js";

/**
 * The document worker: a SEPARATE process from the API (case study D1, D9).
 * Slow work (download, PDF parsing, embeddings) never blocks chat requests, and in Kubernetes
 * the API and the worker scale independently (e.g. more workers when the queue is long).
 *   npm run dev:worker
 */
const services = realServices();
if (!services.storage) {
  console.error("Worker needs S3_BUCKET (and AWS credentials) in .env");
  process.exit(1);
}
const deps = { db, storage: services.storage, embedder: services.embedder };

let stopping = false;
const IDLE_POLL_MS = 2_000;

async function loop() {
  console.log(`Worker started (bucket ${env.S3_BUCKET}, embeddings ${services.embedder.model})`);
  while (!stopping) {
    try {
      const didWork = await processNextJob(deps);
      if (!didWork) await new Promise((r) => setTimeout(r, IDLE_POLL_MS)); // queue empty: wait a bit
    } catch (err) {
      // e.g. database briefly unreachable: wait and try again instead of crashing
      console.error(JSON.stringify({ msg: "worker_error", error: (err as Error).message }));
      await new Promise((r) => setTimeout(r, 5_000));
    }
  }
  await db.end();
  console.log("Worker stopped");
}

// Graceful shutdown: finish the current document, then exit (Kubernetes sends SIGTERM before killing a pod).
for (const sig of ["SIGTERM", "SIGINT"] as const) {
  process.on(sig, () => {
    stopping = true;
  });
}

void loop();
