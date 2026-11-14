export type ChatMessage = { role: "system" | "user" | "assistant"; content: string };

// What a provider streams back to us.
export type StreamChunk =
  | { type: "text"; text: string }
  | { type: "usage"; inputTokens: number; outputTokens: number };

export type StreamRequest = {
  model: string; // the provider's own model name, e.g. "gpt-4o-mini"
  messages: ChatMessage[];
  maxTokens: number;
  signal: AbortSignal; // aborted on timeout or when the user leaves
};

export interface Provider {
  name: string;
  stream(req: StreamRequest): AsyncIterable<StreamChunk>;
}

/**
 * An error from an AI provider, with enough detail to decide what to do next.
 * status null = network problem or timeout (no HTTP answer at all).
 */
export class ProviderError extends Error {
  constructor(
    message: string,
    readonly status: number | null,
    readonly kind: "http" | "network" | "timeout" | "circuit_open" = status === null ? "network" : "http",
    readonly retryAfterMs: number | null = null,
  ) {
    super(message);
    this.name = "ProviderError";
  }

  /** Only retry what can go away by itself: rate limits (429), provider errors (5xx), network trouble, timeouts. */
  get retryable(): boolean {
    if (this.kind === "circuit_open") return false;
    if (this.status === null) return true;
    return this.status === 429 || this.status >= 500;
  }
}

/** Turns a failed HTTP response into a ProviderError, reading Retry-After if the provider sent one. */
export async function errorFromResponse(provider: string, res: Response): Promise<ProviderError> {
  const retryAfter = res.headers.get("retry-after");
  const retryAfterMs = retryAfter && /^\d+$/.test(retryAfter) ? Number(retryAfter) * 1000 : null;
  const body = (await res.text().catch(() => "")).slice(0, 300);
  return new ProviderError(`${provider} returned ${res.status}: ${body}`, res.status, "http", retryAfterMs);
}
