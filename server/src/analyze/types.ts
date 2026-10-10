// Shapes exchanged between the analyzer and its callers (the ingest worker,
// and the model eval under server/evals/analyzer/).

import type Anthropic from '@anthropic-ai/sdk';

export type IngestSource = 'picker' | 'scanner' | 'share' | 'email';

/** One Drive folder the analyzer may file into, with the user's naming signal. */
export interface FolderContext {
  linkId: string;
  /** Slash-joined path from My files, e.g. "/Bills/Northwind Energy". The root is "/". */
  path: string;
  /** Up to a handful of the folder's most recent filenames, extension stripped. */
  recentNames: string[];
}

/** A previously filed document, recalled from history as an in-context example. */
export interface PastExample {
  snippet: string;
  finalName: string;
  folderPath: string;
}

export interface AnalyzeInput {
  bytes: Uint8Array;
  mimeType: string;
  /**
   * The filename the document arrived with, or null to withhold it. The eval
   * withholds it because a filed document's name is the label being predicted.
   */
  originalName: string | null;
  source: IngestSource;
  /** Free text about how the document arrived, e.g. an email subject line. */
  sourceContext?: string;
}

export type FolderChoice =
  | { kind: 'existing'; linkId: string; path: string }
  | { kind: 'new'; parentLinkId: string; parentPath: string; name: string };

export interface Analysis {
  /** Filename without extension. */
  name: string;
  /** null when the model's folder answer could not be resolved; forces review. */
  folder: FolderChoice | null;
  /** 0–1: the model's estimate that the user accepts name and folder unedited. */
  confidence: number;
  rationale: string;
  /** False for an ordinary photo that isn't a document; it is stored as-is. */
  isDocument: boolean;
  /**
   * Whether the model saw the document's content. False when it answered
   * from the filename and arrival details alone (a file too large to send,
   * rejected by the API, unreadable, or of a type it can't read): such an
   * answer is never auto-filed.
   */
  contentSeen: boolean;
  /** Identifying text kept for history recall. */
  textSnippet: string;
}

interface OutcomeBase {
  /** Model that served the request, read from the response. */
  model: string;
  usage: Anthropic.Usage;
  stopReason: Anthropic.StopReason | null;
}

export type AnalyzeOutcome =
  | (OutcomeBase & { status: 'ok'; analysis: Analysis })
  | (OutcomeBase & { status: 'refusal' | 'truncated' | 'invalid'; detail: string });
