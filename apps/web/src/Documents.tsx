import { useCallback, useEffect, useRef, useState, type ChangeEvent } from "react";
import { api } from "./trpc";

type Doc = { id: string; title: string; status: string; error: string | null; sizeBytes: number; chunks: number };

// Browsers sometimes don't know the type of .md files; we fill in the gaps by extension.
const TYPE_BY_EXTENSION: Record<string, string> = {
  pdf: "application/pdf",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  txt: "text/plain",
  md: "text/markdown",
};

const STATUS_LABEL: Record<string, string> = {
  uploading: "Uploading…",
  queued: "Waiting…",
  processing: "Processing…",
  ready: "Ready",
  failed: "Failed",
};

/** The workspace knowledge base: upload, see processing status, delete. */
export function Documents() {
  const [docs, setDocs] = useState<Doc[]>([]);
  const [enabled, setEnabled] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  const load = useCallback(async () => {
    const res = await api.documents.list.query();
    setDocs(res.items);
    setEnabled(res.enabled);
  }, []);

  useEffect(() => {
    load().catch((e: Error) => setError(e.message));
  }, [load]);

  // While something is still being processed, check again every 3 seconds (case study U3: no endless spinner).
  const pending = docs.some((d) => ["uploading", "queued", "processing"].includes(d.status));
  useEffect(() => {
    if (!pending) return;
    const t = setInterval(() => void load().catch(() => undefined), 3_000);
    return () => clearInterval(t);
  }, [pending, load]);

  async function onFile(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    setBusy(true);
    setError(null);
    try {
      const ext = file.name.split(".").pop()?.toLowerCase() ?? "";
      const contentType = file.type || TYPE_BY_EXTENSION[ext] || "application/octet-stream";

      // 1. Ask our API for a 5-minute upload link (it checks type and size first).
      const { documentId, uploadUrl } = await api.documents.createUpload.mutate({
        fileName: file.name,
        contentType,
        sizeBytes: file.size,
      });
      // 2. Upload straight to the private S3 bucket. The file never passes through our API.
      const put = await fetch(uploadUrl, { method: "PUT", headers: { "content-type": contentType }, body: file });
      if (!put.ok) throw new Error(`Upload to storage failed (${put.status}). Check the bucket's CORS settings.`);
      // 3. Tell our API it's there; it verifies the size and queues it for the worker.
      await api.documents.completeUpload.mutate({ documentId });
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
      await load().catch(() => undefined);
    }
  }

  async function remove(id: string) {
    try {
      await api.documents.delete.mutate({ documentId: id });
      await load();
    } catch (err) {
      setError((err as Error).message);
    }
  }

  return (
    <aside style={panel}>
      <h3 style={{ margin: "0 0 8px", fontSize: 15 }}>Knowledge base</h3>
      {!enabled ? (
        <p style={muted}>File storage is not configured on the server (S3_BUCKET).</p>
      ) : (
        <>
          <input ref={fileInput} type="file" accept=".pdf,.docx,.txt,.md" onChange={onFile} hidden />
          <button onClick={() => fileInput.current?.click()} disabled={busy} style={{ width: "100%" }}>
            {busy ? "Uploading…" : "+ Upload document"}
          </button>
          <p style={{ ...muted, margin: "4px 0 8px" }}>PDF, Word, text or Markdown, up to 20 MB.</p>
        </>
      )}
      {error && <p style={{ color: "crimson", fontSize: 13 }}>{error}</p>}
      {docs.map((d) => (
        <div key={d.id} style={row}>
          <div style={{ overflow: "hidden" }}>
            <div style={title} title={d.title}>
              {d.title}
            </div>
            <div style={{ fontSize: 12, color: d.status === "failed" ? "crimson" : d.status === "ready" ? "#166534" : "#92400e" }}>
              {STATUS_LABEL[d.status] ?? d.status}
              {d.status === "ready" && ` · ${d.chunks} sections`}
              {d.status === "failed" && d.error && ` · ${d.error}`}
            </div>
          </div>
          <button onClick={() => remove(d.id)} title="Delete document" style={iconButton}>
            ×
          </button>
        </div>
      ))}
      {enabled && docs.length === 0 && <p style={muted}>No documents yet.</p>}
    </aside>
  );
}

const panel = { borderLeft: "1px solid #e5e7eb", paddingLeft: 12, overflowY: "auto" } as const;
const muted = { color: "#6b7280", fontSize: 12 } as const;
const row = { display: "flex", justifyContent: "space-between", gap: 6, padding: "6px 0", borderBottom: "1px dashed #e5e7eb" } as const;
const title = { fontSize: 13, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" } as const;
const iconButton = { border: "none", background: "none", cursor: "pointer", color: "#9ca3af", fontSize: 16 } as const;
