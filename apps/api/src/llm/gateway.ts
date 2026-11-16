import type { ModelConfig } from "./models.js";
import { ProviderError, type ChatMessage, type Provider, type StreamChunk } from "./types.js";
import { circuitOpen, errorReason, llmProviderErrors } from "../metrics.js";

/**
 * The reliability layer between our app and the AI providers (case study R3, R4, R5).
 *  - timeouts: one for the first token, one for the whole answer
 *  - retries: only for errors that can go away, with exponential backoff + jitter, honouring Retry-After
 *  - circuit breaker: after repeated failures, stop calling a provider for a while and fail fast
 *  - fallback: if the chosen model is unavailable, use its configured fallback (if the workspace allows it)
 * A tool like LiteLLM can do this as a separate service; here it is ~150 lines we fully understand.
 */

export type GatewayEvent = StreamChunk | { type: "fallback"; from: string; to: string; reason: string };

export type GatewayOptions = {
  maxRetries: number; // retries after the first attempt
  baseBackoffMs: number;
  maxBackoffMs: number;
  breakerThreshold: number; // consecutive failures that open the circuit
  breakerCooldownMs: number; // how long the circuit stays open
  maxOutputTokens: number;
};

const DEFAULTS: GatewayOptions = {
  maxRetries: 2,
  baseBackoffMs: 500,
  maxBackoffMs: 8_000,
  breakerThreshold: 5,
  breakerCooldownMs: 30_000,
  maxOutputTokens: 1_024,
};

// ---------- Circuit breaker (one per provider) ----------
class CircuitBreaker {
  private failures = 0;
  private openedAt: number | null = null;
  constructor(private threshold: number, private cooldownMs: number) {}

  /** Closed: allow. Open: refuse until the cooldown has passed, then let one test request through ("half-open"). */
  canRequest(now = Date.now()): boolean {
    if (this.openedAt === null) return true;
    if (now - this.openedAt >= this.cooldownMs) {
      this.openedAt = now; // half-open: one try; another failure re-opens it for a full cooldown
      return true;
    }
    return false;
  }
  recordSuccess() {
    this.failures = 0;
    this.openedAt = null;
  }
  recordFailure(now = Date.now()) {
    this.failures++;
    if (this.failures >= this.threshold) this.openedAt = now;
  }
  get isOpen() {
    return this.openedAt !== null;
  }
}

// ---------- Helpers ----------
const sleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    if (signal.aborted) return reject(signal.reason);
    const t = setTimeout(resolve, ms);
    signal.addEventListener("abort", () => {
      clearTimeout(t);
      reject(signal.reason);
    }, { once: true });
  });

/** "Full jitter": a random wait between 0 and the exponential cap, so many clients don't retry in sync. */
export function backoffMs(attempt: number, opts: Pick<GatewayOptions, "baseBackoffMs" | "maxBackoffMs">, retryAfterMs: number | null, random = Math.random) {
  if (retryAfterMs !== null) return Math.min(retryAfterMs, opts.maxBackoffMs);
  const cap = Math.min(opts.maxBackoffMs, opts.baseBackoffMs * 2 ** attempt);
  return Math.round(cap / 2 + random() * (cap / 2));
}

export function createGateway(providers: Record<string, Provider>, options: Partial<GatewayOptions> = {}) {
  const opts = { ...DEFAULTS, ...options };
  const breakers = new Map<string, CircuitBreaker>();
  const breakerFor = (provider: string) => {
    let b = breakers.get(provider);
    if (!b) breakers.set(provider, (b = new CircuitBreaker(opts.breakerThreshold, opts.breakerCooldownMs)));
    return b;
  };

  /** One model, with timeouts and retries. Retries only happen BEFORE the first token: once text reached the user, we never repeat it. */
  async function* streamOne(model: ModelConfig, messages: ChatMessage[], userSignal: AbortSignal): AsyncGenerator<StreamChunk> {
    const provider = providers[model.provider];
    if (!provider) throw new ProviderError(`model ${model.id} is not configured`, null, "circuit_open");
    const breaker = breakerFor(model.provider);

    for (let attempt = 0; ; attempt++) {
      if (!breaker.canRequest()) {
        llmProviderErrors.inc({ provider: model.provider, reason: "circuit_open" });
        throw new ProviderError(`${model.provider} is temporarily unavailable (circuit open)`, null, "circuit_open");
      }

      // One controller per attempt: aborted by the user leaving, the first-token timer, or the total timer.
      const ctrl = new AbortController();
      const onUserAbort = () => ctrl.abort(userSignal.reason);
      userSignal.addEventListener("abort", onUserAbort, { once: true });
      let timedOut: "first_token" | "total" | null = null;
      const firstTokenTimer = setTimeout(() => { timedOut = "first_token"; ctrl.abort(); }, model.firstTokenTimeoutMs);
      const totalTimer = setTimeout(() => { timedOut = "total"; ctrl.abort(); }, model.totalTimeoutMs);

      let gotText = false;
      try {
        for await (const chunk of provider.stream({ model: model.upstream, messages, maxTokens: opts.maxOutputTokens, signal: ctrl.signal })) {
          if (chunk.type === "text" && !gotText) {
            gotText = true;
            clearTimeout(firstTokenTimer);
          }
          yield chunk;
        }
        breaker.recordSuccess();
        circuitOpen.set({ provider: model.provider }, 0);
        return;
      } catch (err) {
        if (userSignal.aborted) throw err; // the user stopped it: not the provider's fault, no retry
        const error =
          timedOut !== null
            ? new ProviderError(`${model.provider}: ${timedOut === "first_token" ? "no first token" : "answer not finished"} in time`, null, "timeout")
            : err instanceof ProviderError
              ? err
              : new ProviderError(`${model.provider}: ${(err as Error).message}`, null);

        llmProviderErrors.inc({ provider: model.provider, reason: errorReason(error.status, error.kind) });
        if (error.retryable) breaker.recordFailure(); // 4xx like a bad request is OUR bug, not provider health
        circuitOpen.set({ provider: model.provider }, breaker.isOpen ? 1 : 0);
        const canRetry = error.retryable && !gotText && attempt < opts.maxRetries && !breaker.isOpen;
        if (!canRetry) throw error;
        await sleep(backoffMs(attempt, opts, error.retryAfterMs), userSignal);
      } finally {
        clearTimeout(firstTokenTimer);
        clearTimeout(totalTimer);
        userSignal.removeEventListener("abort", onUserAbort);
      }
    }
  }

  /**
   * Streams an answer from `model`. If it fails before any text arrived and a fallback is allowed,
   * continues with the fallback and tells the caller with a "fallback" event.
   */
  async function* stream(model: ModelConfig, allowed: ModelConfig[], messages: ChatMessage[], signal: AbortSignal): AsyncGenerator<GatewayEvent & { model?: string }> {
    let sentText = false;
    try {
      for await (const chunk of streamOne(model, messages, signal)) {
        if (chunk.type === "text") sentText = true;
        yield chunk;
      }
    } catch (err) {
      const fallback = allowed.find((m) => m.id === model.fallback);
      const usable = err instanceof ProviderError && err.retryable !== false && !signal.aborted && !sentText;
      const providerSide = err instanceof ProviderError && (err.retryable || err.kind === "circuit_open");
      if (!fallback || !usable || !providerSide) throw err;
      yield { type: "fallback", from: model.id, to: fallback.id, reason: err.message };
      yield* streamOne(fallback, messages, signal);
    }
  }

  return { stream };
}
