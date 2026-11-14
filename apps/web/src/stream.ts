import { fetchWithRefresh } from "./trpc";

export type StreamHandlers = {
  onToken: (text: string) => void;
  onNotice: (text: string) => void;
};

/**
 * Sends a message and reads the answer as it is generated (Server-Sent Events over fetch).
 * Resolves when the answer is complete. Rejects with a user-friendly message on errors.
 * Pass an AbortSignal to stop: the server then cancels the model call too.
 */
export async function streamChat(
  body: { conversationId: string; content: string; model: string },
  handlers: StreamHandlers,
  signal: AbortSignal,
): Promise<void> {
  const res = await fetchWithRefresh("/api/chat/stream", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    signal,
  });
  if (!res.ok || !res.body) {
    const data = (await res.json().catch(() => null)) as { error?: string } | null;
    throw new Error(data?.error ?? `Request failed (${res.status})`);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  while (true) {
    const { value, done } = await reader.read();
    if (done) return;
    buffer += decoder.decode(value, { stream: true });
    let end: number;
    while ((end = buffer.indexOf("\n\n")) !== -1) {
      const block = buffer.slice(0, end);
      buffer = buffer.slice(end + 2);
      const event = /^event: (.*)$/m.exec(block)?.[1];
      const raw = /^data: (.*)$/m.exec(block)?.[1];
      if (!event || !raw) continue;
      const data = JSON.parse(raw) as { text?: string; message?: string };
      if (event === "token" && data.text) handlers.onToken(data.text);
      else if (event === "notice" && data.text) handlers.onNotice(data.text);
      else if (event === "error") throw new Error(data.message ?? "The model could not answer.");
      else if (event === "done") return;
    }
  }
}
