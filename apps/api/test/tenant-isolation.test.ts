// Proves the most important promise of the platform: one customer can never see another customer's data.
// (Case study S1-S3: the bugs that leaked Bauer's price list to another company.)
//
// These tests call the real API procedures against the real database (from .env).
// They create their own throwaway workspaces with random emails and delete them afterwards.
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Request, Response } from "express";
import { appRouter } from "../src/router.js";
import { db } from "../src/db.js";
import type { AuthUser } from "../src/auth.js";

type Caller = ReturnType<typeof appRouter.createCaller>;

// A caller acts exactly like a logged-in user's requests, without HTTP.
const callerFor = (user: AuthUser | null): Caller =>
  appRouter.createCaller({ req: {} as Request, res: {} as Response, user });

const run = randomUUID().slice(0, 8);
const createdWorkspaces: string[] = [];

async function makeUser(workspaceId: string, label: string): Promise<AuthUser> {
  const { rows } = await db.query<{ id: string }>(
    "INSERT INTO users (workspace_id, email, password_hash) VALUES ($1, $2, 'not-a-login') RETURNING id",
    [workspaceId, `${label}-${run}@test.invalid`],
  );
  return { userId: rows[0].id, workspaceId, role: "member" };
}

async function makeWorkspace(name: string): Promise<string> {
  const { rows } = await db.query<{ id: string }>("INSERT INTO workspaces (name) VALUES ($1) RETURNING id", [
    `${name} (test ${run})`,
  ]);
  createdWorkspaces.push(rows[0].id);
  return rows[0].id;
}

let max: Caller; // Bauer
let maxColleague: Caller; // also Bauer, different user
let anna: Caller; // Lutz
let maxChatId: string;

beforeAll(async () => {
  const bauer = await makeWorkspace("Bauer");
  const lutz = await makeWorkspace("Lutz");
  max = callerFor(await makeUser(bauer, "max"));
  maxColleague = callerFor(await makeUser(bauer, "colleague"));
  anna = callerFor(await makeUser(lutz, "anna"));

  const chat = await max.chat.create();
  maxChatId = chat.id;
  await max.chat.send({ conversationId: maxChatId, content: "Our secret price list for 2027" });
});

afterAll(async () => {
  // ON DELETE CASCADE removes the test users, chats and messages too.
  await db.query("DELETE FROM workspaces WHERE id = ANY($1::uuid[])", [createdWorkspaces]);
  await db.end();
});

describe("tenant isolation", () => {
  it("the owner can read their own chat", async () => {
    const { items } = await max.chat.messages({ conversationId: maxChatId });
    expect(items.map((m) => m.content)).toContain("Our secret price list for 2027");
  });

  it("another company does not see the chat in its list", async () => {
    const { items } = await anna.chat.list({});
    expect(items.map((c) => c.id)).not.toContain(maxChatId);
  });

  it("another company cannot read the chat, even with the exact id", async () => {
    await expect(anna.chat.messages({ conversationId: maxChatId })).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("another company cannot write into the chat", async () => {
    await expect(anna.chat.send({ conversationId: maxChatId, content: "injected" })).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    const { items } = await max.chat.messages({ conversationId: maxChatId });
    expect(items.map((m) => m.content)).not.toContain("injected");
  });

  it("another company cannot delete the chat", async () => {
    await expect(anna.chat.delete({ conversationId: maxChatId })).rejects.toMatchObject({ code: "NOT_FOUND" });
    const { items } = await max.chat.messages({ conversationId: maxChatId });
    expect(items.length).toBeGreaterThan(0);
  });

  it("a colleague in the SAME company cannot read someone else's chat either", async () => {
    await expect(maxColleague.chat.messages({ conversationId: maxChatId })).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
  });

  it("logged-out requests are refused", async () => {
    await expect(callerFor(null).chat.list({})).rejects.toMatchObject({ code: "UNAUTHORIZED" });
  });

  it("a malformed id is rejected as bad input, not a server error", async () => {
    await expect(anna.chat.messages({ conversationId: "42" })).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });
});

describe("chat behaviour", () => {
  it("deleting a chat also deletes its messages", async () => {
    const chat = await max.chat.create();
    await max.chat.send({ conversationId: chat.id, content: "to be deleted" });
    await max.chat.delete({ conversationId: chat.id });
    const { rowCount } = await db.query("SELECT 1 FROM messages WHERE conversation_id = $1", [chat.id]);
    expect(rowCount).toBe(0);
  });

  it("the sidebar pages through chats without gaps or duplicates", async () => {
    const lutzOnly = callerFor(await makeUser(createdWorkspaces[1], "pager"));
    for (let i = 0; i < 35; i++) await lutzOnly.chat.create();

    const page1 = await lutzOnly.chat.list({});
    expect(page1.items).toHaveLength(30);
    expect(page1.nextCursor).not.toBeNull();

    const page2 = await lutzOnly.chat.list({ cursor: page1.nextCursor ?? undefined });
    expect(page2.items).toHaveLength(5);
    expect(page2.nextCursor).toBeNull();

    const all = [...page1.items, ...page2.items].map((c) => c.id);
    expect(new Set(all).size).toBe(35);
  });
});
