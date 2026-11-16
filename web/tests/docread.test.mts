import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import * as XLSX from "@e965/xlsx";

const { documentParts, mimeFor } = await import("../lib/docread");
const fixture = (f: string) => readFileSync(new URL(`./fixtures/${f}`, import.meta.url)).toString("base64");
const textOf = (parts: Awaited<ReturnType<typeof documentParts>>) => (parts[0].type === "text" ? parts[0].text : "");

function workbook(bookType: "xlsx" | "biff8") {
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([["Test", "Value", "Date"], ["Creatinine", 2.17, "2026-10-14"], ["Potassium", 4.1, "2026-10-14"]]), "RFT");
  return (XLSX.write(wb, { type: "buffer", bookType }) as Buffer).toString("base64");
}

describe("reading visit documents of any common type", () => {
  it("works out the type from the file name when the browser doesn't say", () => {
    assert.equal(mimeFor("", "Discharge.PDF"), "application/pdf");
    assert.equal(mimeFor("application/octet-stream", "rx.doc"), "application/msword");
    assert.equal(mimeFor("", "labs.xls"), "application/vnd.ms-excel");
    assert.equal(mimeFor("image/jpg", "photo"), "image/jpeg");
  });

  it("passes PDFs and photos through as files", async () => {
    assert.deepEqual(await documentParts("data:application/pdf;base64,JVBERi0=", "application/pdf", "a.pdf"), [{ type: "document", data: "JVBERi0=", mime_type: "application/pdf" }]);
    assert.equal((await documentParts("AAAA", "image/png", "a.png"))[0].type, "image");
  });

  for (const f of ["rx.docx", "rx.doc"]) {
    it(`reads the text of a Word file (${f}), tables included`, async () => {
      const t = textOf(await documentParts(fixture(f), "", f));
      assert.match(t, /Word document/);
      assert.match(t, /Dr Dileep KS/);
      assert.match(t, /Lasix\s+40 mg\s+1-1\/2-0/);
      assert.match(t, /Review after 4 weeks with RFT/);
    });
  }

  for (const [name, book] of [["labs.xlsx", "xlsx"], ["labs.xls", "biff8"]] as const) {
    it(`reads every sheet of an Excel file (${name})`, async () => {
      const t = textOf(await documentParts(workbook(book), "", name));
      assert.match(t, /Sheet “RFT”/);
      assert.match(t, /Creatinine,2\.17,2026-10-14/);
    });
  }

  it("reads plain text and refuses what it can't read, with a reason", async () => {
    assert.match(textOf(await documentParts(Buffer.from("BP 140/90").toString("base64"), "text/plain", "n.txt")), /BP 140\/90/);
    await assert.rejects(documentParts("AAAA", "application/zip", "x.zip"), /can't be read/);
    await assert.rejects(documentParts(Buffer.from("not a word file").toString("base64"), "", "bad.docx"), /couldn't be opened as a Word document/);
  });
});
