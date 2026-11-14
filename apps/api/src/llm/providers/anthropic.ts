import { readSse } from "../sse.js";
import { errorFromResponse, ProviderError, type Provider, type StreamChunk, type StreamRequest } from "../types.js";

/** Anthropic's Messages API. The system prompt is a separate field there, not a message. */
export function anthropic(apiKey: string): Provider {
  return {
    name: "anthropic",
    async *stream(req: StreamRequest): AsyncIterable<StreamChunk> {
      const system = req.messages.filter((m) => m.role === "system").map((m) => m.content).join("\n\n");
      const messages = req.messages.filter((m) => m.role !== "system");
      let res: Response;
      try {
        res = await fetch("https://api.anthropic.com/v1/messages", {
          method: "POST",
          signal: req.signal,
          headers: { "content-type": "application/json", "x-api-key": apiKey, "anthropic-version": "2023-06-01" },
          body: JSON.stringify({ model: req.model, max_tokens: req.maxTokens, system, messages, stream: true }),
        });
      } catch (err) {
        if (req.signal.aborted) throw err;
        throw new ProviderError(`anthropic unreachable: ${(err as Error).message}`, null);
      }
      if (!res.ok || !res.body) throw await errorFromResponse("anthropic", res);

      let inputTokens = 0;
      for await (const { event, data } of readSse(res.body)) {
        const json = JSON.parse(data) as {
          message?: { usage?: { input_tokens?: number } };
          delta?: { type?: string; text?: string };
          usage?: { output_tokens?: number };
          error?: { type?: string; message?: string };
        };
        if (event === "message_start") inputTokens = json.message?.usage?.input_tokens ?? 0;
        else if (event === "content_block_delta" && json.delta?.type === "text_delta" && json.delta.text) {
          yield { type: "text", text: json.delta.text };
        } else if (event === "message_delta" && json.usage) {
          yield { type: "usage", inputTokens, outputTokens: json.usage.output_tokens ?? 0 };
        } else if (event === "error") {
          // e.g. "overloaded_error" in the middle of a stream
          const overloaded = json.error?.type === "overloaded_error";
          throw new ProviderError(`anthropic stream error: ${json.error?.message ?? "unknown"}`, overloaded ? 529 : 500);
        }
      }
    },
  };
}
