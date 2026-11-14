// Unit tests for the reliability layer (case study R3, R4, R5). No database, no network, no API keys:
// small fake providers behave exactly like a slow, broken or rate-limited real provider.
import { describe, expect, it } from "vitest";
import { backoffMs, createGateway } from "../src/llm/gateway.js";
import type { ModelConfig } from "../src/llm/models.js";
import { ProviderError, type Provider, type StreamChunk } from "../src/llm/types.js";

const model = (id: string, provider: string, extra: Partial<ModelConfig> = {}): ModelConfig => ({
  id, label: id, provider, upstream: id, firstTokenTimeoutMs: 200, totalTimeoutMs: 2_000, ...extra,
});

/** A provider that fails `failures` times with `error`, then answers "hello world". Counts its calls. */
function flaky(failures: number, error: () => Error) {
  let calls = 0;
  const provider: Provider = {
    name: "flaky",
    async *stream(): AsyncIterable<StreamChunk> {
      calls++;
      if (calls <= failures) throw error();
      yield { type: "text", text: "hello " };
      yield { type: "text", text: "world" };
    },
  };
  return { provider, calls: () => calls };
}

const fast = { baseBackoffMs: 1, maxBackoffMs: 5 }; // keep tests quick

async function collect(it: AsyncIterable<{ type: string; text?: string; to?: string }>) {
  let text = "";
  const fallbacks: string[] = [];
  for await (const ev of it) {
    if (ev.type === "text") text += ev.text;
    if (ev.type === "fallback") fallbacks.push(ev.to!);
  }
  return { text, fallbacks };
}

describe("retries", () => {
  it("retries a 503 and then succeeds", async () => {
    const f = flaky(2, () => new ProviderError("down", 503));
    const gw = createGateway({ p: f.provider }, fast);
    const m = model("m", "p");
    const { text } = await collect(gw.stream(m, [m], [], new AbortController().signal));
    expect(text).toBe("hello world");
    expect(f.calls()).toBe(3); // 1 try + 2 retries
  });

  it("does NOT retry a 400 (our bug, retrying can't fix it)", async () => {
    const f = flaky(5, () => new ProviderError("bad request", 400));
    const gw = createGateway({ p: f.provider }, fast);
    const m = model("m", "p");
    await expect(collect(gw.stream(m, [m], [], new AbortController().signal))).rejects.toMatchObject({ status: 400 });
    expect(f.calls()).toBe(1);
  });

  it("gives up after the retry limit", async () => {
    const f = flaky(10, () => new ProviderError("down", 503));
    const gw = createGateway({ p: f.provider }, { ...fast, maxRetries: 2 });
    const m = model("m", "p");
    await expect(collect(gw.stream(m, [m], [], new AbortController().signal))).rejects.toMatchObject({ status: 503 });
    expect(f.calls()).toBe(3);
  });

  it("backoff grows exponentially, stays under the cap, and honours Retry-After", () => {
    const opts = { baseBackoffMs: 500, maxBackoffMs: 8_000 };
    const high = () => 1; // worst-case jitter
    expect(backoffMs(0, opts, null, high)).toBe(500);
    expect(backoffMs(1, opts, null, high)).toBe(1_000);
    expect(backoffMs(2, opts, null, high)).toBe(2_000);
    expect(backoffMs(10, opts, null, high)).toBe(8_000);
    expect(backoffMs(0, opts, 3_000)).toBe(3_000);
  });
});

describe("timeouts", () => {
  it("fails fast if the first token doesn't arrive in time", async () => {
    const hanging: Provider = {
      name: "hang",
      async *stream({ signal }): AsyncIterable<StreamChunk> {
        await new Promise((_, reject) => signal.addEventListener("abort", () => reject(new Error("aborted"))));
      },
    };
    const gw = createGateway({ p: hanging }, { ...fast, maxRetries: 0 });
    const m = model("m", "p", { firstTokenTimeoutMs: 50 });
    const started = Date.now();
    await expect(collect(gw.stream(m, [m], [], new AbortController().signal))).rejects.toMatchObject({ kind: "timeout" });
    expect(Date.now() - started).toBeLessThan(1_000);
  });
});

describe("circuit breaker", () => {
  it("opens after repeated failures and then fails fast without calling the provider", async () => {
    const f = flaky(100, () => new ProviderError("down", 503));
    const gw = createGateway({ p: f.provider }, { ...fast, maxRetries: 0, breakerThreshold: 3, breakerCooldownMs: 60_000 });
    const m = model("m", "p");
    for (let i = 0; i < 3; i++) {
      await expect(collect(gw.stream(m, [m], [], new AbortController().signal))).rejects.toMatchObject({ status: 503 });
    }
    expect(f.calls()).toBe(3);
    await expect(collect(gw.stream(m, [m], [], new AbortController().signal))).rejects.toMatchObject({ kind: "circuit_open" });
    expect(f.calls()).toBe(3); // the provider was not called again
  });
});

describe("fallback", () => {
  it("switches to the fallback model when the primary is down", async () => {
    const down = flaky(100, () => new ProviderError("down", 503));
    const healthy = flaky(0, () => new Error("never"));
    const gw = createGateway({ a: down.provider, b: healthy.provider }, { ...fast, maxRetries: 1 });
    const primary = model("primary", "a", { fallback: "backup" });
    const backup = model("backup", "b");
    const { text, fallbacks } = await collect(gw.stream(primary, [primary, backup], [], new AbortController().signal));
    expect(text).toBe("hello world");
    expect(fallbacks).toEqual(["backup"]);
  });

  it("does not use a fallback the workspace is not allowed to use", async () => {
    const down = flaky(100, () => new ProviderError("down", 503));
    const healthy = flaky(0, () => new Error("never"));
    const gw = createGateway({ a: down.provider, b: healthy.provider }, { ...fast, maxRetries: 0 });
    const primary = model("primary", "a", { fallback: "backup" });
    await expect(collect(gw.stream(primary, [primary], [], new AbortController().signal))).rejects.toMatchObject({ status: 503 });
    expect(healthy.calls()).toBe(0);
  });
});
