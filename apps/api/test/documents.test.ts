// Knowledge base tests: upload checks, the worker queue, retries, deletes, and above all
// that search can NEVER return another company's documents (case study S1).
// Storage is in memory (instead of S3) and embeddings are the offline demo ones: no cloud, no keys.
import { randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Request, Response } from "express";
import { appRouter } from "../src/router.js";
import { createApp } from "../src/app.js";
import { db } from "../src/db.js";
import { signAccessToken, type AuthUser } from "../src/auth.js";
import { memoryStorage } from "../src/documents/storage.js";
import { demoEmbedder } from "../src/documents/embeddings.js";
import { claimJob, MAX_ATTEMPTS, processNextJob } from "../src/documents/jobs.js";
import { searchChunks } from "../src/documents/search.js";
import { chunkText } from "../src/documents/extract.js";
import { mock } from "../src/llm/providers/mock.js";

const run = randomUUID().slice(0, 8);
const workspaces: string[] = [];
const storage = memoryStorage();
const embedder = demoEmbedder();
const services = { storage, embedder };
const jobDeps = { db, storage, embedder, retryDelaySeconds: () => 0 }; // retry immediately in tests

type Caller = ReturnType<typeof appRouter.createCaller>;
const callerFor = (user: AuthUser): Caller => appRouter.createCaller({ req: {} as Request, res: {} as Response, user, services });

async function makeUser(name: string, role: "member" | "admin" = "member", workspaceId?: string): Promise<AuthUser> {
  let wid = workspaceId;
  if (!wid) {
    const ws = await db.query<{ id: string }>("INSERT INTO workspaces (name) VALUES ($1) RETURNING id", [`${name} (test ${run})`]);
    wid = ws.rows[0].id;
    workspaces.push(wid);
  }
  const u = await db.query<{ id: string }>(
    "INSERT INTO users (workspace_id, email, password_hash, role) VALUES ($1, $2, 'x', $3) RETURNING id",
    [wid, `${name}-${randomUUID().slice(0, 6)}-${run}@test.invalid`, role],
  );
  return { userId: u.rows[0].id, workspaceId: wid, role };
}

/** Plays the browser: ask for an upload URL, "upload" the bytes, confirm. Returns the document id. */
async function upload(user: AuthUser, fileName: string, text: string, contentType = "text/plain") {
  const caller = callerFor(user);
  const data = Buffer.from(text);
  const { documentId } = await caller.documents.createUpload({ fileName, contentType, sizeBytes: data.length });
  const { rows } = await db.query<{ storage_key: string }>("SELECT storage_key FROM documents WHERE id = $1", [documentId]);
  storage.put(rows[0].storage_key, data);
  await caller.documents.completeUpload({ documentId });
  return documentId;
}

/** Runs the worker until the queue is empty. */
async function drainQueue() {
  while (await processNextJob(jobDeps)) {
    /* keep going */
  }
}

const statusOf = async (id: string) =>
  (await db.query<{ status: string; error: string | null; attempts: number; chunk_count: number }>(
    "SELECT status, error, attempts, chunk_count FROM documents WHERE id = $1", [id])).rows[0];

let bauer: AuthUser;
let lutz: AuthUser;

beforeAll(async () => {
  bauer = await makeUser("bauer", "admin");
  lutz = await makeUser("lutz", "admin");
});

beforeEach(async () => {
  await drainQueue(); // start every test with an empty queue
});

afterAll(async () => {
  await db.query("DELETE FROM workspaces WHERE id = ANY($1::uuid[])", [workspaces]);
  await db.end();
});

describe("upload checks", () => {
  it("refuses file types we can't process", async () => {
    await expect(
      callerFor(bauer).documents.createUpload({ fileName: "virus.exe", contentType: "application/x-msdownload", sizeBytes: 100 }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  it("refuses files over 20 MB", async () => {
    await expect(
      callerFor(bauer).documents.createUpload({ fileName: "huge.pdf", contentType: "application/pdf", sizeBytes: 50 * 1024 * 1024 }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  it("stores files under the workspace and our own id, never the user's file name", async () => {
    const id = await upload(bauer, "../../etc/passwd.txt", "hello");
    const { rows } = await db.query<{ storage_key: string }>("SELECT storage_key FROM documents WHERE id = $1", [id]);
    expect(rows[0].storage_key).toBe(`workspaces/${bauer.workspaceId}/documents/${id}`);
  });

  it("refuses to queue a document whose upload never arrived or has the wrong size", async () => {
    const caller = callerFor(bauer);
    const { documentId } = await caller.documents.createUpload({ fileName: "a.txt", contentType: "text/plain", sizeBytes: 999 });
    await expect(caller.documents.completeUpload({ documentId })).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect((await statusOf(documentId)).status).toBe("failed");
  });
});

describe("processing (worker)", () => {
  it("turns an upload into searchable chunks", async () => {
    const id = await upload(bauer, "Fahrerhandbuch.txt", "Ruhezeiten: Fahrer müssen nach 4,5 Stunden 45 Minuten Pause machen.\n\nTanken nur an Vertragstankstellen.");
    expect((await statusOf(id)).status).toBe("queued"); // upload returns at once; work happens in the worker
    await drainQueue();
    const s = await statusOf(id);
    expect(s.status).toBe("ready");
    expect(s.chunk_count).toBeGreaterThan(0);
  });

  it("two workers never take the same job (FOR UPDATE SKIP LOCKED)", async () => {
    await upload(bauer, "one.txt", "first document");
    await upload(bauer, "two.txt", "second document");
    const [a, b] = await Promise.all([claimJob(db), claimJob(db)]);
    expect(a && b).toBeTruthy();
    expect(a!.id).not.toBe(b!.id);
    // hand them back so other tests start clean
    await db.query("UPDATE documents SET status = 'queued', locked_at = NULL WHERE id = ANY($1::uuid[])", [[a!.id, b!.id]]);
  });

  it("retries a broken file, then marks it failed with a message the user can act on", async () => {
    const id = await upload(bauer, "broken.pdf", "this is not really a pdf", "application/pdf");
    await drainQueue();
    const s = await statusOf(id);
    expect(s.status).toBe("failed");
    expect(s.attempts).toBe(MAX_ATTEMPTS);
    expect(s.error).toMatch(/PDF could not be read/);
  });

  it("reprocessing a document replaces its chunks instead of duplicating them", async () => {
    const id = await upload(bauer, "again.txt", "Paragraph one.\n\nParagraph two.");
    await drainQueue();
    const before = (await statusOf(id)).chunk_count;
    await db.query("UPDATE documents SET status = 'queued', run_after = now() WHERE id = $1", [id]);
    await drainQueue();
    const { rows } = await db.query<{ n: string }>("SELECT count(*) AS n FROM chunks WHERE document_id = $1", [id]);
    expect(Number(rows[0].n)).toBe(before);
  });
});

describe("tenant isolation (case study S1)", () => {
  it("search never returns another company's document, even for a perfect match", async () => {
    const secret = "Preisliste 2027 Sondertarif Kühlkette Bauer Logistik exklusiv";
    await upload(bauer, "Preisliste_2027.txt", secret);
    await drainQueue();

    const forBauer = await searchChunks(db, embedder, bauer.workspaceId, secret);
    expect(forBauer.map((c) => c.title)).toContain("Preisliste_2027.txt");

    const forLutz = await searchChunks(db, embedder, lutz.workspaceId, secret);
    expect(forLutz.map((c) => c.title)).not.toContain("Preisliste_2027.txt");
    expect(forLutz.every((c) => !c.content.includes("Sondertarif"))).toBe(true);
  });

  it("another company can't see, confirm or delete our documents", async () => {
    const id = await upload(bauer, "intern.txt", "internal");
    const other = callerFor(lutz);
    expect((await other.documents.list()).items.map((d) => d.id)).not.toContain(id);
    await expect(other.documents.completeUpload({ documentId: id })).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(other.documents.delete({ documentId: id })).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("the database itself refuses a chunk whose workspace differs from its document", async () => {
    const id = await upload(bauer, "guard.txt", "guarded");
    await drainQueue();
    await expect(
      db.query(
        "INSERT INTO chunks (document_id, workspace_id, position, content, embedding) VALUES ($1, $2, 99, 'x', $3)",
        [id, lutz.workspaceId, `[${new Array(1024).fill(0).join(",")}]`],
      ),
    ).rejects.toThrow(/foreign key/);
  });
});

describe("deleting", () => {
  it("removes the row, all chunks and the stored file", async () => {
    const id = await upload(bauer, "delete-me.txt", "short lived");
    await drainQueue();
    const { rows } = await db.query<{ storage_key: string }>("SELECT storage_key FROM documents WHERE id = $1", [id]);
    await callerFor(bauer).documents.delete({ documentId: id });
    expect(await statusOf(id)).toBeUndefined();
    expect((await db.query("SELECT 1 FROM chunks WHERE document_id = $1", [id])).rowCount).toBe(0);
    expect(storage.has(rows[0].storage_key)).toBe(false);
  });

  it("a colleague who is not an admin can't delete someone else's document", async () => {
    const id = await upload(bauer, "boss.txt", "boss only");
    const colleague = await makeUser("colleague", "member", bauer.workspaceId);
    await expect(callerFor(colleague).documents.delete({ documentId: id })).rejects.toMatchObject({ code: "FORBIDDEN" });
  });
});

describe("chat with documents", () => {
  let server: Server;
  let base: string;
  beforeAll(() => {
    server = createApp({ mock: mock({ tokenDelayMs: 1 }) }, services, [
      { id: "demo", label: "Demo", provider: "mock", upstream: "mock", firstTokenTimeoutMs: 2_000, totalTimeoutMs: 10_000 },
    ]).listen(0);
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(() => void server.close());

  it("answers with the workspace's documents and saves which ones were used", async () => {
    await upload(bauer, "Zollleitfaden.txt", "Für Exporte in die Schweiz braucht man eine Ausfuhranmeldung und eine Handelsrechnung.");
    await drainQueue();
    const { rows } = await db.query<{ id: string }>(
      "INSERT INTO conversations (workspace_id, user_id) VALUES ($1, $2) RETURNING id", [bauer.workspaceId, bauer.userId]);
    const chatId = rows[0].id;

    const res = await fetch(`${base}/api/chat/stream`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie: `nw_access=${await signAccessToken(bauer)}` },
      body: JSON.stringify({ conversationId: chatId, content: "Was brauche ich für Exporte in die Schweiz?", model: "demo", useDocuments: true }),
    });
    const body = await res.text();
    expect(body).toContain("event: sources");
    expect(body).toContain("Zollleitfaden.txt");

    const saved = await db.query<{ sources: { title: string }[] }>(
      "SELECT sources FROM messages WHERE conversation_id = $1 AND role = 'assistant'", [chatId]);
    expect(saved.rows[0].sources.map((s) => s.title)).toContain("Zollleitfaden.txt");
  });
});

describe("chunking", () => {
  it("keeps chunks under the size limit, even for one giant paragraph", () => {
    const chunks = chunkText("word ".repeat(5_000));
    expect(chunks.length).toBeGreaterThan(10);
    expect(Math.max(...chunks.map((c) => c.length))).toBeLessThanOrEqual(1_200 + 201);
  });
});
