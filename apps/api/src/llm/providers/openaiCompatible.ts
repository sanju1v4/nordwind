import { readSse } from "../sse.js";
import { errorFromResponse, ProviderError, type Provider, type StreamChunk, type StreamRequest } from "../types.js";

/**
 * Works with every API that speaks the OpenAI "chat completions" format:
 * OpenAI itself, Mistral, and gateways like LiteLLM.
 */
export function openAiCompatible(opts: { name: string; baseUrl: string; apiKey: string; includeUsageOption: boolean }): Provider {
  return {
    name: opts.name,
    async *stream(req: StreamRequest): AsyncIterable<StreamChunk> {
      let res: Response;
      try {
        res = await fetch(`${opts.baseUrl}/chat/completions`, {
          method: "POST",
          signal: req.signal,
          headers: { "content-type": "application/json", authorization: `Bearer ${opts.apiKey}` },
          body: JSON.stringify({
            model: req.model,
            messages: req.messages,
            max_tokens: req.maxTokens,
            stream: true,
            ...(opts.includeUsageOption ? { stream_options: { include_usage: true } } : {}),
          }),
        });
      } catch (err) {
        if (req.signal.aborted) throw err;
        throw new ProviderError(`${opts.name} unreachable: ${(err as Error).message}`, null);
      }
      if (!res.ok || !res.body) throw await errorFromResponse(opts.name, res);

      for await (const { data } of readSse(res.body)) {
        if (data === "[DONE]") return;
        const json = JSON.parse(data) as {
          choices?: { delta?: { content?: string | null } }[];
          usage?: { prompt_tokens?: number; completion_tokens?: number } | null;
        };
        const text = json.choices?.[0]?.delta?.content;
        if (text) yield { type: "text", text };
        if (json.usage) {
          yield { type: "usage", inputTokens: json.usage.prompt_tokens ?? 0, outputTokens: json.usage.completion_tokens ?? 0 };
        }
      }
    },
  };
}
