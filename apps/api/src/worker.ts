import http from "node:http";
import client from "prom-client";
import { env } from "./env.js";
import { db } from "./db.js";
import { processNextJob } from "./documents/jobs.js";
import { realServices } from "./services.js";
import { registry } from "./metrics.js";

/**
 * The document worker: a SEPARATE process from the API (case study D1, D9).
 * Slow work (download, PDF parsing, embeddings) never blocks chat requests, and in Kubernetes
 * the API and the worker scale independently (e.g. more workers when the queue is long).
 *   npm run dev:worker
 */
const services = realServices();
if (!services.storage) {
  console.error("Worker needs S3_BUCKET (and AWS credentials) in the environment");
  process.exit(1);
}
const deps = { db, storage: services.storage, embedder: services.embedder };

let stopping = false;
let lastLoopAt = Date.now(); // liveness: updated every loop round
const IDLE_POLL_MS = 2_000;
const STUCK_AFTER_MS = 10 * 60_000; // longer than any single job should take

// How many documents wait in each state: the "is the worker keeping up?" signal for dashboards and alerts.
new client.Gauge({
  name: "nordwind_document_queue",
  help: "Documents by status (queued = waiting for the worker)",
  labelNames: ["status"] as const,
  registers: [registry],
  async collect() {
    const { rows } = await db.query<{ status: string; n: string }>(
      "SELECT status, count(*) AS n FROM documents WHERE status IN ('queued', 'processing') GROUP BY status",
    );
    this.reset();
    for (const s of ["queued", "processing"]) this.set({ status: s }, Number(rows.find((r) => r.status === s)?.n ?? 0));
  },
});

// Small HTTP server for Kubernetes and Prometheus (the worker has no other HTTP traffic).
const server = http.createServer(async (req, res) => {
  if (req.url === "/livez") {
    const stuck = Date.now() - lastLoopAt > STUCK_AFTER_MS;
    res.writeHead(stuck ? 503 : 200).end(stuck ? "stuck" : "ok"); // Kubernetes restarts a stuck worker
  } else if (req.url === "/metrics") {
    res.writeHead(200, { "content-type": registry.contentType }).end(await registry.metrics());
  } else {
    res.writeHead(404).end();
  }
});
server.listen(env.WORKER_METRICS_PORT);

async function loop() {
  console.log(`Worker started (bucket ${env.S3_BUCKET}, embeddings ${services.embedder.model}, metrics :${env.WORKER_METRICS_PORT})`);
  while (!stopping) {
    lastLoopAt = Date.now();
    try {
      const didWork = await processNextJob(deps);
      if (!didWork) await new Promise((r) => setTimeout(r, IDLE_POLL_MS)); // queue empty: wait a bit
    } catch (err) {
      // e.g. database briefly unreachable: wait and try again instead of crashing
      console.error(JSON.stringify({ msg: "worker_error", error: (err as Error).message }));
      await new Promise((r) => setTimeout(r, 5_000));
    }
  }
  server.close();
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
