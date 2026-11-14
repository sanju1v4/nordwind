import { ProviderError, type Provider, type StreamChunk, type StreamRequest } from "../types.js";

const sleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal.addEventListener("abort", () => {
      clearTimeout(t);
      reject(signal.reason);
    }, { once: true });
  });

/**
 * An offline "model" for development, demos and tests. No API key, no cost.
 * Put a keyword in your message to simulate real-world failures:
 *   [fail]  -> the provider answers 503 every time (watch retries, then the fallback)
 *   [slow]  -> the first token takes 20 seconds (watch the first-token timeout)
 *   [429]   -> rate limited
 */
export function mock(opts: { tokenDelayMs?: number } = {}): Provider {
  const delay = opts.tokenDelayMs ?? 25;
  return {
    name: "mock",
    async *stream(req: StreamRequest): AsyncIterable<StreamChunk> {
      const last = req.messages.at(-1)?.content ?? "";
      if (last.includes("[fail]")) throw new ProviderError("mock returned 503", 503);
      if (last.includes("[429]")) throw new ProviderError("mock returned 429", 429, "http", 1000);
      if (last.includes("[slow]")) await sleep(20_000, req.signal);

      const history = req.messages.filter((m) => m.role !== "system").length;
      const reply =
        `This is the offline demo model. You wrote ${last.length} characters, ` +
        `and I received ${history} message(s) of history. ` +
        `Add an API key in .env to talk to a real model.`;
      const words = reply.split(/(?<= )/);
      for (const word of words) {
        await sleep(delay, req.signal);
        yield { type: "text", text: word };
      }
      const chars = req.messages.reduce((n, m) => n + m.content.length, 0);
      yield { type: "usage", inputTokens: Math.ceil(chars / 4), outputTokens: Math.ceil(reply.length / 4) };
    },
  };
}
