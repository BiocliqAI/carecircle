// Turns an uploaded clinical document into parts the AI can read: photos and PDFs as they are; Word (.doc, .docx),
// Excel (.xls, .xlsx), OpenDocument and plain-text files as their text. Anything else gets a clear message.
import type { AIPart } from "./claude";

const WORD = new Set([
  "application/msword",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.oasis.opendocument.text",
]);
const SHEET = new Set([
  "application/vnd.ms-excel",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.oasis.opendocument.spreadsheet",
]);
const TEXT = /^text\/(plain|csv|markdown|tab-separated-values)$/;
const EXT_MIME: Record<string, string> = {
  pdf: "application/pdf", jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", gif: "image/gif", webp: "image/webp",
  heic: "image/heic", heif: "image/heif", txt: "text/plain", csv: "text/csv", md: "text/markdown",
  doc: "application/msword", docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", odt: "application/vnd.oasis.opendocument.text",
  xls: "application/vnd.ms-excel", xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", ods: "application/vnd.oasis.opendocument.spreadsheet",
};
/** What the upload button offers. */
export const DOCUMENT_ACCEPT = "image/*,.pdf,.doc,.docx,.odt,.xls,.xlsx,.ods,.csv,.txt,application/pdf,application/msword,application/vnd.ms-excel,application/vnd.openxmlformats-officedocument.wordprocessingml.document,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

const MAX_TEXT = 400_000; // characters: far more than any clinical document; a bigger file is almost certainly not one

/** The file's type: from its extension when it has a known one (browsers often send "" or a generic type), else what the browser said. */
export function mimeFor(mime: string | null | undefined, name?: string | null): string {
  const ext = (name || "").toLowerCase().match(/\.([a-z0-9]+)$/)?.[1] ?? "";
  if (EXT_MIME[ext]) return EXT_MIME[ext];
  const m = (mime || "").split(";")[0].trim().toLowerCase();
  return m === "image/jpg" ? "image/jpeg" : m || "application/octet-stream";
}

/** One file (base64, with or without a data: prefix) as AI input. Throws with a message for the user if it can't be read. */
export async function documentParts(base64: string, mime: string, name?: string | null): Promise<AIPart[]> {
  const data = base64.replace(/^data:[^;]*;base64,/, "");
  const type = mimeFor(mime, name);
  const label = name ? `“${name}”` : "this file";
  if (type === "application/pdf") return [{ type: "document", data, mime_type: type }];
  if (type.startsWith("image/")) return [{ type: "image", data, mime_type: type }];
  let text: string;
  let kind: string;
  if (TEXT.test(type)) {
    text = Buffer.from(data, "base64").toString("utf8");
    kind = "a text file";
  } else if (WORD.has(type)) {
    text = await wordText(Buffer.from(data, "base64"), label);
    kind = "a Word document";
  } else if (SHEET.has(type)) {
    text = await sheetText(Buffer.from(data, "base64"), label);
    kind = "a spreadsheet; each sheet as comma-separated rows";
  } else {
    throw new Error(`${name ? `“${name}” is` : "That file is"} a type that can't be read. Upload a PDF, a photo, a Word or Excel file, or a text file`);
  }
  if (!text.trim()) throw new Error(`${label} has no text in it. If it's a scanned page, upload it as a PDF or photo`);
  if (text.length > MAX_TEXT) throw new Error(`${label} is too long to read (${Math.round(text.length / 1000)}k characters). Upload only the pages for this visit`);
  return [{ type: "text", text: `Contents of ${label} (${kind}):\n${text}` }];
}

async function wordText(buf: Buffer, label: string): Promise<string> {
  try {
    const { default: WordExtractor } = await import("word-extractor");
    const doc = await new WordExtractor().extract(buf);
    return [doc.getHeaders({ includeFooters: false }), doc.getBody(), doc.getFootnotes(), doc.getFooters()]
      .map((s) => (s || "").trim()).filter(Boolean).join("\n\n");
  } catch {
    throw new Error(`${label} couldn't be opened as a Word document. Save it as PDF and upload that instead`);
  }
}

async function sheetText(buf: Buffer, label: string): Promise<string> {
  try {
    const XLSX = await import("@e965/xlsx");
    const wb = XLSX.read(buf, { type: "buffer", cellDates: true, dense: true });
    return wb.SheetNames.map((n) => {
      const csv = XLSX.utils.sheet_to_csv(wb.Sheets[n], { blankrows: false, dateNF: "yyyy-mm-dd" }).trim();
      return csv ? `Sheet “${n}”:\n${csv}` : "";
    }).filter(Boolean).join("\n\n");
  } catch {
    throw new Error(`${label} couldn't be opened as a spreadsheet. Save it as PDF and upload that instead`);
  }
}
