import { env, isProduction } from "../env.js";
import { anthropic } from "./providers/anthropic.js";
import { mock } from "./providers/mock.js";
import { openAiCompatible } from "./providers/openaiCompatible.js";
import type { Provider } from "./types.js";

export type ModelConfig = {
  id: string; // what the browser sends and the database stores
  label: string; // what the user sees
  provider: string;
  upstream: string; // the provider's own model name
  firstTokenTimeoutMs: number; // give up if nothing arrives within this time (case study R3)
  totalTimeoutMs: number; // hard limit for the whole answer
  fallback?: string; // model id to use if this one is unavailable (case study R5)
};

/**
 * The one list of models this server knows. The browser can never pick anything else (case study S10).
 * GPT and Claude back each other up (one level only: a fallback never falls back again).
 * For strict EU-only customers, point both fallbacks at "mistral" instead.
 */
export const MODELS: ModelConfig[] = [
  { id: "gpt", label: "GPT (OpenAI)", provider: "openai", upstream: env.OPENAI_MODEL, firstTokenTimeoutMs: 15_000, totalTimeoutMs: 120_000, fallback: "claude" },
  { id: "claude", label: "Claude (Anthropic)", provider: "anthropic", upstream: env.ANTHROPIC_MODEL, firstTokenTimeoutMs: 15_000, totalTimeoutMs: 120_000, fallback: "gpt" },
  { id: "mistral", label: "Mistral (EU)", provider: "mistral", upstream: env.MISTRAL_MODEL, firstTokenTimeoutMs: 15_000, totalTimeoutMs: 120_000 },
  { id: "demo", label: "Demo model (offline)", provider: "mock", upstream: "mock", firstTokenTimeoutMs: 5_000, totalTimeoutMs: 30_000 },
];

/** Providers that are configured on this server. A provider without an API key simply doesn't exist. */
export function configuredProviders(): Record<string, Provider> {
  const p: Record<string, Provider> = {};
  if (env.OPENAI_API_KEY) {
    p.openai = openAiCompatible({ name: "openai", baseUrl: "https://api.openai.com/v1", apiKey: env.OPENAI_API_KEY, includeUsageOption: true });
  }
  if (env.ANTHROPIC_API_KEY) p.anthropic = anthropic(env.ANTHROPIC_API_KEY);
  if (env.MISTRAL_API_KEY) {
    p.mistral = openAiCompatible({ name: "mistral", baseUrl: "https://api.mistral.ai/v1", apiKey: env.MISTRAL_API_KEY, includeUsageOption: false });
  }
  if (!isProduction) p.mock = mock(); // the demo model never exists in production
  return p;
}

/**
 * Models this workspace may use right now: configured on the server AND allowed for the workspace.
 * allowedForWorkspace = null means "all models on this server".
 */
export function modelsFor(allowedForWorkspace: string[] | null, providers: Record<string, Provider>, models = MODELS): ModelConfig[] {
  return models.filter((m) => providers[m.provider] && (allowedForWorkspace === null || allowedForWorkspace.includes(m.id)));
}
