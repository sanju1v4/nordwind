import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { TRPCClientError } from "@trpc/client";
import { api } from "./trpc";
import { streamChat } from "./stream";
import { Documents } from "./Documents";

type Conversation = { id: string; title: string; updatedAt: string };
type Source = { documentId: string; title: string };
type Message = { id: string; role: "user" | "assistant"; content: string; model?: string | null; sources?: Source[]; createdAt: string };
type Model = { id: string; label: string };
type Cursor = { updatedAt: string; id: string } | null;

const errorText = (err: unknown) => (err instanceof TRPCClientError || err instanceof Error ? err.message : String(err));

export function Chat() {
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [cursor, setCursor] = useState<Cursor>(null);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [olderCursor, setOlderCursor] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [models, setModels] = useState<Model[]>([]);
  const [model, setModel] = useState("");
  const [streaming, setStreaming] = useState<string | null>(null); // the answer while it is being written
  const [useDocuments, setUseDocuments] = useState(true);
  const [liveSources, setLiveSources] = useState<Source[]>([]);
  const stopper = useRef<AbortController | null>(null);
  const bottom = useRef<HTMLDivElement>(null);

  // Only the models this workspace can actually use (case study U4).
  useEffect(() => {
    api.chat.models
      .query()
      .then((list) => {
        setModels(list);
        setModel((current) => current || list[0]?.id || "");
      })
      .catch((e) => setError(errorText(e)));
  }, []);

  // Sidebar: first page of chats (titles only).
  const loadFirstPage = useCallback(async () => {
    const page = await api.chat.list.query({});
    setConversations(page.items);
    setCursor(page.nextCursor);
    return page.items;
  }, []);

  useEffect(() => {
    loadFirstPage()
      .then((items) => setActiveId((current) => current ?? items[0]?.id ?? null))
      .catch((e) => setError(errorText(e)));
  }, [loadFirstPage]);

  async function loadMoreChats() {
    if (!cursor) return;
    const page = await api.chat.list.query({ cursor });
    setConversations((prev) => [...prev, ...page.items]);
    setCursor(page.nextCursor);
  }

  // Messages are loaded only when a chat is opened (case study D3).
  useEffect(() => {
    if (!activeId) {
      setMessages([]);
      return;
    }
    api.chat.messages
      .query({ conversationId: activeId })
      .then((page) => {
        setMessages(page.items);
        setOlderCursor(page.olderCursor);
      })
      .catch((e) => setError(errorText(e)));
  }, [activeId]);

  // Braces matter: an effect may only return nothing or a cleanup function.
  // Without them, the arrow function would return scrollIntoView's result and React would crash.
  useEffect(() => {
    bottom.current?.scrollIntoView({ block: "end" });
  }, [messages.length, streaming]);

  async function loadOlder() {
    if (!activeId || !olderCursor) return;
    const page = await api.chat.messages.query({ conversationId: activeId, beforeId: olderCursor });
    setMessages((prev) => [...page.items, ...prev]);
    setOlderCursor(page.olderCursor);
  }

  async function newChat() {
    try {
      const chat = await api.chat.create.mutate();
      setConversations((prev) => [chat, ...prev]);
      setActiveId(chat.id);
    } catch (e) {
      setError(errorText(e));
    }
  }

  async function deleteChat(id: string) {
    try {
      await api.chat.delete.mutate({ conversationId: id });
      setConversations((prev) => prev.filter((c) => c.id !== id));
      if (activeId === id) setActiveId(null);
    } catch (e) {
      setError(errorText(e));
    }
  }

  async function send(e: FormEvent) {
    e.preventDefault();
    const content = draft.trim();
    if (!content || sending || !model) return;

    let conversationId = activeId;
    setSending(true);
    setError(null);
    setNotice(null);
    const stop = new AbortController();
    stopper.current = stop;
    try {
      if (!conversationId) {
        const chat = await api.chat.create.mutate();
        conversationId = chat.id;
        setActiveId(chat.id);
      }
      setDraft("");
      // Show the question at once, then the answer word by word as it arrives (case study D8/U5).
      setMessages((prev) => [...prev, { id: `local-${Date.now()}`, role: "user", content, createdAt: new Date().toISOString() }]);
      setStreaming("");
      setLiveSources([]);
      await streamChat({ conversationId, content, model, useDocuments }, {
        onToken: (t) => setStreaming((prev) => (prev ?? "") + t),
        onNotice: setNotice,
        onSources: setLiveSources,
      }, stop.signal);
    } catch (err) {
      if (!stop.signal.aborted) setError(errorText(err));
    } finally {
      // Reload from the server: that's the saved truth (includes "[stopped]" answers and real ids).
      if (conversationId) {
        const page = await api.chat.messages.query({ conversationId }).catch(() => null);
        if (page) {
          setMessages(page.items);
          setOlderCursor(page.olderCursor);
        }
        await loadFirstPage().catch(() => undefined); // new title + moves to the top
      }
      setStreaming(null);
      setSending(false);
      stopper.current = null;
    }
  }

  return (
    <div style={layout}>
      <aside style={sidebar}>
        <button onClick={newChat} style={{ width: "100%", marginBottom: 12 }}>
          + New chat
        </button>
        {conversations.map((c) => (
          <div key={c.id} style={{ ...item, background: c.id === activeId ? "#e5e7eb" : "transparent" }}>
            <span onClick={() => setActiveId(c.id)} style={itemTitle} title={c.title}>
              {c.title}
            </span>
            <button onClick={() => deleteChat(c.id)} title="Delete chat" style={iconButton}>
              ×
            </button>
          </div>
        ))}
        {cursor && (
          <button onClick={loadMoreChats} style={{ width: "100%", marginTop: 8 }}>
            Load more
          </button>
        )}
        {conversations.length === 0 && <p style={{ color: "#6b7280", fontSize: 13 }}>No chats yet.</p>}
      </aside>

      <section style={{ display: "flex", flexDirection: "column", minHeight: 0 }}>
        <div style={messageList}>
          {olderCursor && (
            <button onClick={loadOlder} style={{ alignSelf: "center" }}>
              Load older messages
            </button>
          )}
          {messages.map((m) => (
            <div key={m.id} style={m.role === "user" ? userBubble : botBubble}>
              {m.content}
              {m.role === "assistant" && m.sources && m.sources.length > 0 && <SourceList sources={m.sources} />}
              {m.role === "assistant" && m.model && <div style={modelTag}>{models.find((x) => x.id === m.model)?.label ?? m.model}</div>}
            </div>
          ))}
          {streaming !== null && (
            <div style={botBubble}>
              {streaming || "…"}
              {liveSources.length > 0 && <SourceList sources={liveSources} />}
            </div>
          )}
          {!activeId && <p style={{ color: "#6b7280" }}>Start typing to begin a new chat.</p>}
          <div ref={bottom} />
        </div>
        {notice && <p style={{ color: "#92400e", margin: "4px 0" }}>{notice}</p>}
        {error && <p style={{ color: "crimson", margin: "4px 0" }}>{error}</p>}
        <form onSubmit={send} style={{ display: "flex", gap: 8 }}>
          <select value={model} onChange={(e) => setModel(e.target.value)} disabled={sending} style={{ padding: 8 }}>
            {models.map((m) => (
              <option key={m.id} value={m.id}>
                {m.label}
              </option>
            ))}
          </select>
          <label style={{ display: "flex", alignItems: "center", gap: 4, fontSize: 13, whiteSpace: "nowrap" }} title="Answer using your workspace's documents">
            <input type="checkbox" checked={useDocuments} onChange={(e) => setUseDocuments(e.target.checked)} />
            Documents
          </label>
          <input
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder="Message…"
            maxLength={20000}
            style={{ flex: 1, padding: 10 }}
          />
          {sending ? (
            <button type="button" onClick={() => stopper.current?.abort()}>
              Stop
            </button>
          ) : (
            <button type="submit" disabled={!draft.trim() || !model}>
              Send
            </button>
          )}
        </form>
      </section>

      <Documents />
    </div>
  );
}

/** Which documents an answer was based on (case study U1: users can check the answer, and leaks would be visible). */
function SourceList({ sources }: { sources: Source[] }) {
  return <div style={sourceStyle}>Sources: {sources.map((s) => s.title).join(", ")}</div>;
}

const layout = { display: "grid", gridTemplateColumns: "220px 1fr 240px", gap: 16, height: "72vh" } as const;
const sidebar = { borderRight: "1px solid #e5e7eb", paddingRight: 12, overflowY: "auto" } as const;
const item = { display: "flex", alignItems: "center", borderRadius: 6, padding: "4px 6px" } as const;
const itemTitle = { flex: 1, cursor: "pointer", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" } as const;
const iconButton = { border: "none", background: "none", cursor: "pointer", color: "#9ca3af", fontSize: 16 } as const;
const messageList = { flex: 1, overflowY: "auto", display: "flex", flexDirection: "column", gap: 8, paddingBottom: 8 } as const;
const bubble = { padding: "8px 12px", borderRadius: 10, maxWidth: "80%", whiteSpace: "pre-wrap" } as const;
const userBubble = { ...bubble, alignSelf: "flex-end", background: "#111827", color: "#fff" } as const;
const botBubble = { ...bubble, alignSelf: "flex-start", background: "#f3f4f6" } as const;
const modelTag = { fontSize: 11, color: "#6b7280", marginTop: 4 } as const;
const sourceStyle = { fontSize: 12, color: "#374151", marginTop: 6, borderTop: "1px solid #e5e7eb", paddingTop: 4 } as const;
