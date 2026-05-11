// Public types for Phase 5's classify pipeline.
//
// `ClassifyInput` and `ClassifyResult` are the shape exchanged between the
// `/api/classify` route and the `classify/haiku.ts` wrapper. The PWA's
// `Scan.suggestion` mirrors `ClassifyResult` exactly (minus `pageOcr`,
// which is stored on `Scan.pageOcr` separately) — never copy a "post-edit"
// name into `suggestion`.

export interface ClassifyInput {
  pages: Uint8Array[];
  folders: { linkId: string; path: string }[];
  examples?: PastExample[];
}

export interface PastExample {
  ocrSnippet: string;
  finalName: string;
  folderPath: string;
}

export interface ClassifyResult {
  suggestedName: string;
  suggestedFolderLinkId: string;
  confidence: number;
  rationale: string;
  pageOcr: PageOcr[];
}

export interface PageOcr {
  text: string;
  words: { text: string; x: number; y: number; w: number; h: number }[];
}
