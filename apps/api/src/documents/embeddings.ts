import { createHash } from "node:crypto";
import { env } from "../env.js";

export const EMBEDDING_DIMENSIONS = 1024; // must match vector(1024) in the database

export interface Embedder {
  model: string; // stored per document, so we know when a re-index is needed
  embed(texts: string[]): Promise<number[][]>;
}

/**
 * Offline "embeddings" for development and tests: the hashing trick.
 * Each word and word pair lands in one of 1024 buckets; similar texts share buckets.
 * Much weaker than a real model (no synonyms, no meaning), but deterministic, free and good enough
 * to demonstrate upload -> chunk -> search -> answer with sources.
 */
export function demoEmbedder(): Embedder {
  const bucket = (token: string) => createHash("sha1").update(token).digest().readUInt32BE(0) % EMBEDDING_DIMENSIONS;
  return {
    model: "demo-hash-1024",
    async embed(texts) {
      return texts.map((text) => {
        const v = new Array<number>(EMBEDDING_DIMENSIONS).fill(0);
        const words = text.toLowerCase().match(/\p{L}[\p{L}\p{N}]+/gu) ?? [];
        words.forEach((w, i) => {
          v[bucket(w)] += 1;
          if (i > 0) v[bucket(`${words[i - 1]} ${w}`)] += 0.5;
        });
        const norm = Math.hypot(...v) || 1;
        return v.map((x) => x / norm);
      });
    },
  };
}

/** Mistral (EU) or OpenAI embeddings, both asked for 1024 dimensions. Sent in batches. */
function apiEmbedder(opts: { model: string; url: string; apiKey: string; extra?: Record<string, unknown> }): Embedder {
  return {
    model: opts.model,
    async embed(texts) {
      const out: number[][] = [];
      for (let i = 0; i < texts.length; i += 64) {
        const res = await fetch(opts.url, {
          method: "POST",
          headers: { "content-type": "application/json", authorization: `Bearer ${opts.apiKey}` },
          body: JSON.stringify({ model: opts.model, input: texts.slice(i, i + 64), ...opts.extra }),
          signal: AbortSignal.timeout(60_000),
        });
        if (!res.ok) throw new Error(`embeddings request failed with ${res.status}`);
        const json = (await res.json()) as { data: { embedding: number[] }[] };
        out.push(...json.data.map((d) => d.embedding));
      }
      return out;
    },
  };
}

export function configuredEmbedder(): Embedder {
  if (env.EMBEDDINGS_PROVIDER === "mistral") {
    if (!env.MISTRAL_API_KEY) throw new Error("EMBEDDINGS_PROVIDER=mistral needs MISTRAL_API_KEY");
    return apiEmbedder({ model: "mistral-embed", url: "https://api.mistral.ai/v1/embeddings", apiKey: env.MISTRAL_API_KEY });
  }
  if (env.EMBEDDINGS_PROVIDER === "openai") {
    if (!env.OPENAI_API_KEY) throw new Error("EMBEDDINGS_PROVIDER=openai needs OPENAI_API_KEY");
    return apiEmbedder({
      model: "text-embedding-3-small",
      url: "https://api.openai.com/v1/embeddings",
      apiKey: env.OPENAI_API_KEY,
      extra: { dimensions: EMBEDDING_DIMENSIONS },
    });
  }
  return demoEmbedder();
}

/** pgvector's text format: [0.1,0.2,...] */
export const toVector = (v: number[]) => `[${v.join(",")}]`;
