import { Router, json, type Request, type Response } from "express";
import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { ACCESS_COOKIE, readCookie, verifyAccessToken } from "../auth.js";
import { db } from "../db.js";
import { assertOwnsConversation, workspaceAllowedModels } from "../conversations.js";
import { modelsFor, type ModelConfig } from "../llm/models.js";
import { createGateway } from "../llm/gateway.js";
import { ProviderError, type ChatMessage, type Provider } from "../llm/types.js";

const SYSTEM_PROMPT =
  "You are Nordwind, a helpful assistant for employees of small and mid-sized companies. Answer clearly and concisely.";

// Only the most recent part of a chat goes to the model (case study D7): cost stays flat, no context-window errors.
const HISTORY_MESSAGES = 20;
const HISTORY_CHAR_BUDGET = 24_000;

const body = z.object({
  conversationId: z.string().uuid(),
  content: z.string().trim().min(1).max(20_000),
  model: z.string().min(1).max(50),
});

/** Messages a user can act on. Technical details go to the logs, not the screen (case study U2). */
function userMessage(err: unknown, model: ModelConfig): string {
  if (!(err instanceof ProviderError)) return "Something went wrong on our side. Please try again.";
  if (err.kind === "timeout") return `${model.label} took too long to answer. Please try again.`;
  if (err.kind === "circuit_open") return `${model.label} is temporarily unavailable. Please try another model or try again in a minute.`;
  if (err.status === 429) return `${model.label} is busy right now (rate limited). Please try again in a moment.`;
  if (err.status === 401 || err.status === 403) return `${model.label} is not set up correctly (API key rejected). Please tell your admin.`;
  if (err.status !== null && err.status >= 500) return `${model.label} is having problems right now. Please try again shortly.`;
  return `${model.label} could not answer this request.`;
}

/** One JSON line per request: ids, numbers and status only. Never the user's text (case study S8). */
function logRequest(fields: Record<string, unknown>) {
  console.log(JSON.stringify({ msg: "chat_request", time: new Date().toISOString(), ...fields }));
}

export function chatStreamRouter(providers: Record<string, Provider>, models?: ModelConfig[]) {
  const gateway = createGateway(providers);
  const router = Router();

  router.post("/api/chat/stream", json({ limit: "64kb" }), async (req: Request, res: Response) => {
    try {
      await handle(req, res);
    } catch (err) {
      // Express 4 doesn't catch errors from async handlers by itself.
      console.error(JSON.stringify({ msg: "chat_stream_crash", error: (err as Error).message }));
      if (!res.headersSent) res.status(500).json({ error: "Something went wrong on our side. Please try again." });
      else res.end();
    }
  });

  async function handle(req: Request, res: Response) {
    const started = Date.now();

    // 1. Who is this? Only the signed cookie counts.
    const token = readCookie(req, ACCESS_COOKIE);
    const user = token ? await verifyAccessToken(token) : null;
    if (!user) return void res.status(401).json({ error: "Not logged in" });

    const parsed = body.safeParse(req.body);
    if (!parsed.success) return void res.status(400).json({ error: "Invalid request" });
    const input = parsed.data;

    // 2. Is this their conversation, and may they use this model?
    try {
      await assertOwnsConversation(db, user, input.conversationId);
    } catch (err) {
      if (err instanceof TRPCError) return void res.status(404).json({ error: "Conversation not found" });
      throw err;
    }
    const allowed = modelsFor(await workspaceAllowedModels(db, user.workspaceId), providers, models);
    const model = allowed.find((m) => m.id === input.model);
    if (!model) return void res.status(400).json({ error: "This model is not available for your workspace" });

    // 3. Save the user's message first: it is never lost, even if the model fails.
    await db.query(
      `WITH m AS (INSERT INTO messages (conversation_id, role, content) VALUES ($1, 'user', $2))
       UPDATE conversations
          SET updated_at = now(), title = CASE WHEN title = 'New chat' THEN left($2, 60) ELSE title END
        WHERE id = $1`,
      [input.conversationId, input.content],
    );

    // 4. Recent history within a budget (includes the message we just saved).
    const { rows: recent } = await db.query<{ role: "user" | "assistant"; content: string }>(
      "SELECT role, content FROM messages WHERE conversation_id = $1 ORDER BY id DESC LIMIT $2",
      [input.conversationId, HISTORY_MESSAGES],
    );
    const history: ChatMessage[] = [];
    let chars = 0;
    for (const m of recent) {
      chars += m.content.length;
      if (chars > HISTORY_CHAR_BUDGET && history.length > 0) break;
      history.unshift({ role: m.role, content: m.content });
    }
    const messages: ChatMessage[] = [{ role: "system", content: SYSTEM_PROMPT }, ...history];

    // 5. Stream the answer as Server-Sent Events.
    res.status(200).set({ "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
    res.flushHeaders();
    const send = (event: string, data: unknown) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);

    // If the user closes the tab or presses Stop, cancel the provider call too: no paying for unread tokens.
    const abort = new AbortController();
    res.on("close", () => {
      if (!res.writableEnded) abort.abort(new Error("client disconnected"));
    });

    let text = "";
    let usedModel = model;
    let inputTokens = 0;
    let outputTokens = 0;
    let status: "ok" | "error" | "aborted" = "ok";
    let errorForLog: string | undefined;

    try {
      for await (const ev of gateway.stream(model, allowed, messages, abort.signal)) {
        if (ev.type === "text") {
          text += ev.text;
          send("token", { text: ev.text });
        } else if (ev.type === "usage") {
          inputTokens = ev.inputTokens;
          outputTokens = ev.outputTokens;
        } else if (ev.type === "fallback") {
          usedModel = allowed.find((m) => m.id === ev.to) ?? usedModel;
          errorForLog = ev.reason;
          send("notice", { text: `${model.label} is unavailable right now, so ${usedModel.label} answered instead.` });
        }
      }
    } catch (err) {
      if (abort.signal.aborted) status = "aborted";
      else {
        status = "error";
        errorForLog = (err as Error).message;
        send("error", { message: userMessage(err, usedModel) });
      }
    }

    // 6. Save the answer (even a partial one the user stopped) and exactly one usage row, in one transaction.
    let messageId: string | null = null;
    const client = await db.connect();
    try {
      await client.query("BEGIN");
      if (text) {
        const saved = await client.query<{ id: string }>(
          "INSERT INTO messages (conversation_id, role, content, model) VALUES ($1, 'assistant', $2, $3) RETURNING id",
          [input.conversationId, status === "aborted" ? `${text} [stopped]` : text, usedModel.id],
        );
        messageId = saved.rows[0].id;
      }
      await client.query(
        `INSERT INTO usage_events (workspace_id, user_id, conversation_id, model, input_tokens, output_tokens, status, latency_ms)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [user.workspaceId, user.userId, input.conversationId, usedModel.id, inputTokens, outputTokens, status, Date.now() - started],
      );
      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK");
      errorForLog = `failed to save: ${(err as Error).message}`;
    } finally {
      client.release();
    }

    logRequest({
      workspaceId: user.workspaceId,
      userId: user.userId,
      conversationId: input.conversationId,
      requestedModel: model.id,
      model: usedModel.id,
      status,
      inputTokens,
      outputTokens,
      latencyMs: Date.now() - started,
      error: errorForLog,
    });

    if (!res.writableEnded) {
      if (status === "ok") send("done", { messageId, model: usedModel.id });
      res.end();
    }
  }

  return router;
}
