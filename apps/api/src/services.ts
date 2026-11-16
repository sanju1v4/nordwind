import { env } from "./env.js";
import { s3Storage } from "./documents/storage.js";
import { configuredEmbedder } from "./documents/embeddings.js";
import type { Services } from "./trpc.js";

/** The real outside services, built from .env. Shared by the API and the worker. */
export function realServices(): Services {
  return {
    storage: env.S3_BUCKET ? s3Storage(env.S3_BUCKET, env.AWS_REGION) : null,
    embedder: configuredEmbedder(),
  };
}
