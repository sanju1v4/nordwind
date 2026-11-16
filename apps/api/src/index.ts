import { env } from "./env.js"; // first: refuses to start if configuration is missing
import { createApp } from "./app.js";
import { db } from "./db.js";
import { configuredProviders, MODELS } from "./llm/models.js";
import { realServices } from "./services.js";

const providers = configuredProviders();
const services = realServices();
const app = createApp(providers, services);

const server = app.listen(env.API_PORT, () => {
  console.log(`API listening on http://localhost:${env.API_PORT}`);
  const available = MODELS.filter((m) => providers[m.provider]).map((m) => m.id);
  console.log(`AI models available: ${available.join(", ") || "none - add an API key to .env"}`);
  console.log(`Knowledge base: ${services.storage ? `S3 bucket ${env.S3_BUCKET}` : "off (S3_BUCKET not set)"}, embeddings: ${services.embedder.model}`);
});

// Graceful shutdown: finish in-flight requests before exiting (case study O5).
process.on("SIGTERM", () => {
  server.close(() => {
    void db.end().then(() => process.exit(0));
  });
});
