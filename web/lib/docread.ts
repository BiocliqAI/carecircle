// Turns an uploaded clinical document into parts the AI can read: photos and PDFs as they are; Word (.doc, .docx),
// Excel (.xls, .xlsx), OpenDocument and plain-text files as their text. Anything else gets a clear message.
import type { AIPart } from "./claude";
import { mimeFor, SHEET_TYPES, TEXT_TYPE, WORD_TYPES } from "./mimetypes";

export { mimeFor, DOCUMENT_ACCEPT } from "./mimetypes";

const MAX_TEXT = 400_000; // characters: far more than any clinical document; a bigger file is almost certainly not one

/** One file (base64, with or without a data: prefix) as AI input. Throws with a message for the user if it can't be read. */
export async function documentParts(base64: string, mime: string, name?: string | null): Promise<AIPart[]> {
  const data = base64.replace(/^data:[^;]*;base64,/, "");
  const type = mimeFor(mime, name);
  const label = name ? `“${name}”` : "this file";
  if (type === "application/pdf") return [{ type: "document", data, mime_type: type }];
  if (type.startsWith("image/")) return [{ type: "image", data, mime_type: type }];
  let text: string;
  let kind: string;
  if (TEXT_TYPE.test(type)) {
    text = Buffer.from(data, "base64").toString("utf8");
    kind = "a text file";
  } else if (WORD_TYPES.has(type)) {
    text = await wordText(Buffer.from(data, "base64"), label);
    kind = "a Word document";
  } else if (SHEET_TYPES.has(type)) {
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
