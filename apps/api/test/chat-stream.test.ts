// End-to-end tests of POST /api/chat/stream over real HTTP and the real database.
// The AI provider is the offline demo model, so no API keys or costs are needed.
import { randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { db } from "../src/db.js";
import { signAccessToken, type AuthUser } from "../src/auth.js";
import { mock } from "../src/llm/providers/mock.js";
import type { ModelConfig } from "../src/llm/models.js";
import { demoEmbedder } from "../src/documents/embeddings.js";

const services = { storage: null, embedder: demoEmbedder() };

const run = randomUUID().slice(0, 8);
const workspaces: string[] = [];
let server: Server;
let base: string;

const MODELS: ModelConfig[] = [
  { id: "demo", label: "Demo", provider: "mock", upstream: "mock", firstTokenTimeoutMs: 2_000, totalTimeoutMs: 10_000 },
  { id: "premium", label: "Premium", provider: "mock", upstream: "mock", firstTokenTimeoutMs: 2_000, totalTimeoutMs: 10_000 },
];

async function makeUser(name: string, allowedModels: string[] | null = null): Promise<{ user: AuthUser; cookie: string }> {
  const ws = await db.query<{ id: string }>("INSERT INTO workspaces (name, allowed_models) VALUES ($1, $2) RETURNING id", [
    `${name} (test ${run})`,
    allowedModels,
  ]);
  workspaces.push(ws.rows[0].id);
  const u = await db.query<{ id: string }>(
    "INSERT INTO users (workspace_id, email, password_hash) VALUES ($1, $2, 'x') RETURNING id",
    [ws.rows[0].id, `${name}-${run}@test.invalid`],
  );
  const user: AuthUser = { userId: u.rows[0].id, workspaceId: ws.rows[0].id, role: "member" };
  return { user, cookie: `nw_access=${await signAccessToken(user)}` };
}

async function newChat(user: AuthUser) {
  const { rows } = await db.query<{ id: string }>(
    "INSERT INTO conversations (workspace_id, user_id) VALUES ($1, $2) RETURNING id",
    [user.workspaceId, user.userId],
  );
  return rows[0].id;
}

function post(cookie: string, body: unknown, signal?: AbortSignal) {
  return fetch(`${base}/api/chat/stream`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie },
    body: JSON.stringify(body),
    signal,
  });
}

/** Reads the whole SSE response into a list of { event, data }. */
async function events(res: Response) {
  const text = await res.text();
  return text
    .split("\n\n")
    .filter(Boolean)
    .map((block) => {
      const event = /^event: (.*)$/m.exec(block)?.[1] ?? "";
      const data = JSON.parse(/^data: (.*)$/m.exec(block)?.[1] ?? "null");
      return { event, data };
    });
}

beforeAll(async () => {
  const app = createApp({ mock: mock({ tokenDelayMs: 1 }) }, services, MODELS);
  server = app.listen(0);
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  server.close();
  await db.query("DELETE FROM workspaces WHERE id = ANY($1::uuid[])", [workspaces]);
  await db.end();
});

describe("POST /api/chat/stream", () => {
  it("streams an answer, then saves it with exactly one usage row", async () => {
    const { user, cookie } = await makeUser("streamer");
    const chatId = await newChat(user);

    const res = await post(cookie, { conversationId: chatId, content: "Hallo!", model: "demo" });
    expect(res.status).toBe(200);
    const evs = await events(res);
    const streamed = evs.filter((e) => e.event === "token").map((e) => e.data.text).join("");
    expect(streamed).toContain("offline demo model");
    expect(evs.at(-1)?.event).toBe("done");

    const msgs = await db.query("SELECT role, content, model FROM messages WHERE conversation_id = $1 ORDER BY id", [chatId]);
    expect(msgs.rows.map((r) => r.role)).toEqual(["user", "assistant"]);
    expect(msgs.rows[1].content).toBe(streamed);
    expect(msgs.rows[1].model).toBe("demo");

    const usage = await db.query("SELECT status, output_tokens FROM usage_events WHERE conversation_id = $1", [chatId]);
    expect(usage.rows).toHaveLength(1);
    expect(usage.rows[0].status).toBe("ok");
    expect(usage.rows[0].output_tokens).toBeGreaterThan(0);
  });

  it("refuses requests without a login", async () => {
    const res = await post("", { conversationId: randomUUID(), content: "hi", model: "demo" });
    expect(res.status).toBe(401);
  });

  it("refuses to write into another company's conversation", async () => {
    const owner = await makeUser("owner");
    const attacker = await makeUser("attacker");
    const chatId = await newChat(owner.user);

    const res = await post(attacker.cookie, { conversationId: chatId, content: "injected", model: "demo" });
    expect(res.status).toBe(404);
    const msgs = await db.query("SELECT 1 FROM messages WHERE conversation_id = $1", [chatId]);
    expect(msgs.rowCount).toBe(0);
  });

  it("refuses a model the workspace is not allowed to use", async () => {
    const { user, cookie } = await makeUser("restricted", ["demo"]);
    const chatId = await newChat(user);
    const res = await post(cookie, { conversationId: chatId, content: "hi", model: "premium" });
    expect(res.status).toBe(400);
  });

  it("refuses a model that doesn't exist (instead of crashing)", async () => {
    const { user, cookie } = await makeUser("typo");
    const chatId = await newChat(user);
    const res = await post(cookie, { conversationId: chatId, content: "hi", model: "gpt-9-ultra" });
    expect(res.status).toBe(400);
  });

  it("shows a friendly error when the provider keeps failing, and records it", async () => {
    const { user, cookie } = await makeUser("failing");
    const chatId = await newChat(user);
    const res = await post(cookie, { conversationId: chatId, content: "please [fail]", model: "demo" });
    const evs = await events(res);
    const error = evs.find((e) => e.event === "error");
    expect(error?.data.message).toMatch(/having problems/);
    expect(error?.data.message).not.toMatch(/503/); // technical details stay in the logs

    const usage = await db.query("SELECT status FROM usage_events WHERE conversation_id = $1", [chatId]);
    expect(usage.rows[0].status).toBe("error");
  });

  it("stops the model when the user presses Stop (closes the connection)", async () => {
    const app = createApp({ mock: mock({ tokenDelayMs: 200 }) }, services, MODELS); // slow tokens
    const slowServer = app.listen(0);
    const slowBase = `http://127.0.0.1:${(slowServer.address() as AddressInfo).port}`;
    try {
      const { user, cookie } = await makeUser("stopper");
      const chatId = await newChat(user);
      const ctrl = new AbortController();
      const res = await fetch(`${slowBase}/api/chat/stream`, {
        method: "POST",
        headers: { "content-type": "application/json", cookie },
        body: JSON.stringify({ conversationId: chatId, content: "long answer please", model: "demo" }),
        signal: ctrl.signal,
      });
      const reader = res.body!.getReader();
      await reader.read(); // first token arrived
      ctrl.abort(); // the user presses Stop
      await new Promise((r) => setTimeout(r, 600));

      const usage = await db.query("SELECT status FROM usage_events WHERE conversation_id = $1", [chatId]);
      expect(usage.rows[0]?.status).toBe("aborted");
      const saved = await db.query("SELECT content FROM messages WHERE conversation_id = $1 AND role = 'assistant'", [chatId]);
      expect(saved.rows[0]?.content ?? "").toMatch(/\[stopped\]$/);
    } finally {
      slowServer.close();
    }
  });
});

describe("GET /metrics", () => {
  it("counts chat answers by model and outcome", async () => {
    const { user, cookie } = await makeUser("metrics");
    const chatId = await newChat(user);
    await events(await post(cookie, { conversationId: chatId, content: "hi", model: "demo" }));
    const text = await (await fetch(`${base}/metrics`)).text();
    expect(text).toMatch(/nordwind_chat_requests_total\{model="demo",status="ok"\} [1-9]/);
    expect(text).toContain("nordwind_chat_time_to_first_token_seconds_bucket");
  });

  it("never turns random URLs into label values (bounded cardinality)", async () => {
    const res = await fetch(`${base}/trpc/some.random.${randomUUID()}`);
    await res.text(); // let the response finish, so its timing is recorded
    const text = await (await fetch(`${base}/metrics`)).text();
    expect(text).toContain('route="trpc:unknown"');
    expect(text).not.toMatch(/route="trpc:some\.random/);
  });
});
