// Types for the parts of word-extractor (reads .doc and .docx) that lib/docread.ts uses.
declare module "word-extractor" {
  interface WordDocument {
    getBody(): string;
    getFootnotes(): string;
    getHeaders(opts?: { includeFooters?: boolean }): string;
    getFooters(): string;
  }
  export default class WordExtractor {
    extract(source: string | Buffer): Promise<WordDocument>;
  }
}
