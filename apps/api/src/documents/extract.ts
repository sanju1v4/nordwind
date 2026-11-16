import mammoth from "mammoth";
import { extractText, getDocumentProxy } from "unpdf";

/** File types we accept. Anything else is refused at upload time (case study S9). */
export const ALLOWED_TYPES: Record<string, string> = {
  "application/pdf": "PDF",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "Word (.docx)",
  "text/plain": "Text",
  "text/markdown": "Markdown",
};
export const MAX_UPLOAD_BYTES = 20 * 1024 * 1024; // 20 MB
const MAX_TEXT_CHARS = 2_000_000; // protects the worker from "text bombs"

export async function extractTextFrom(data: Buffer, contentType: string): Promise<string> {
  let text: string;
  if (contentType === "application/pdf") {
    const pdf = await getDocumentProxy(new Uint8Array(data));
    const result = await extractText(pdf, { mergePages: true });
    text = Array.isArray(result.text) ? result.text.join("\n") : result.text;
  } else if (contentType === ALLOWED_TYPES_DOCX) {
    text = (await mammoth.extractRawText({ buffer: data })).value;
  } else if (contentType === "text/plain" || contentType === "text/markdown") {
    text = data.toString("utf8");
  } else {
    throw new Error(`unsupported file type ${contentType}`);
  }
  text = text.replace(/\u0000/g, "").trim();
  if (!text) throw new Error("No text found in this file (is it a scanned image?)");
  return text.slice(0, MAX_TEXT_CHARS);
}
const ALLOWED_TYPES_DOCX = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

/**
 * Splits text into ~1,200-character chunks along paragraph and sentence boundaries,
 * with a little overlap so an answer that spans two chunks is still found.
 */
export function chunkText(text: string, size = 1_200, overlap = 200): string[] {
  const paragraphs = text.split(/\n\s*\n/).map((p) => p.replace(/\s+/g, " ").trim()).filter(Boolean);
  const pieces: string[] = [];
  for (const p of paragraphs) {
    if (p.length <= size) pieces.push(p);
    else pieces.push(...(p.match(/[^.!?]+[.!?]+\s*|[^.!?]+$/g) ?? [p]).map((s) => s.trim()));
  }
  const chunks: string[] = [];
  let current = "";
  for (const piece of pieces) {
    for (let i = 0; i < piece.length; i += size) {
      const part = piece.slice(i, i + size); // a single giant sentence still gets cut
      if (current && current.length + part.length + 1 > size) {
        chunks.push(current);
        current = current.slice(-overlap);
      }
      current = current ? `${current} ${part}` : part;
    }
  }
  if (current) chunks.push(current);
  return chunks;
}
