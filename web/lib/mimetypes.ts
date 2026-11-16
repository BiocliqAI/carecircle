// File types the AI can read, shared by the server and the browser (no Node-only imports here).
export const EXT_MIME: Record<string, string> = {
  pdf: "application/pdf", jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", gif: "image/gif", webp: "image/webp",
  heic: "image/heic", heif: "image/heif", txt: "text/plain", csv: "text/csv", md: "text/markdown",
  doc: "application/msword", docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", odt: "application/vnd.oasis.opendocument.text",
  xls: "application/vnd.ms-excel", xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", ods: "application/vnd.oasis.opendocument.spreadsheet",
};
export const WORD_TYPES = new Set([EXT_MIME.doc, EXT_MIME.docx, EXT_MIME.odt]);
export const SHEET_TYPES = new Set([EXT_MIME.xls, EXT_MIME.xlsx, EXT_MIME.ods]);
export const TEXT_TYPE = /^text\/(plain|csv|markdown|tab-separated-values)$/;

/** What upload buttons offer for documents. */
export const DOCUMENT_ACCEPT = "image/*,.pdf,.doc,.docx,.odt,.xls,.xlsx,.ods,.csv,.txt,application/pdf,application/msword,application/vnd.ms-excel,application/vnd.openxmlformats-officedocument.wordprocessingml.document,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

/** The file's type: from its extension when it has a known one (browsers often send "" or a generic type), else what the browser said. */
export function mimeFor(mime: string | null | undefined, name?: string | null): string {
  const ext = (name || "").toLowerCase().match(/\.([a-z0-9]+)$/)?.[1] ?? "";
  if (EXT_MIME[ext]) return EXT_MIME[ext];
  const m = (mime || "").split(";")[0].trim().toLowerCase();
  return m === "image/jpg" ? "image/jpeg" : m || "application/octet-stream";
}

/** Whether the AI can read a file of this type (as a photo, a PDF, or as text). */
export function readableType(mime: string | null | undefined, name?: string | null): boolean {
  const t = mimeFor(mime, name);
  return t === "application/pdf" || t.startsWith("image/") || TEXT_TYPE.test(t) || WORD_TYPES.has(t) || SHEET_TYPES.has(t);
}
