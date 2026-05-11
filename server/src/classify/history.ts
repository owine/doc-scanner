import type { DB } from '../db.js';
import type { PastExample } from './types.js';
import { logger } from '../logger.js';

const OCR_SNIPPET_MAX_CHARS = 500;

export interface SavedRecord {
  ocrText: string;
  finalName: string;
  folderLinkId: string;
  folderPath: string;
  driveNodeUid: string;
}

/**
 * SQLite-backed Phase 5 classification history. Records every confirmed
 * Drive save and exposes recent saves as in-context examples for future
 * Haiku calls.
 *
 * Slice-3 retrieval is most-recent-N (no similarity scoring). The FTS5
 * inverted index is maintained in sync so a future similarity-based
 * retrieval can be added without a backfill.
 */
export class ClassificationHistory {
  private readonly insertStmt;
  private readonly recentStmt;

  constructor(private readonly db: DB) {
    this.insertStmt = db.prepare(
      `INSERT INTO classification_history (ocr_snippet, final_name, folder_link_id, folder_path, drive_node_uid)
       VALUES (?, ?, ?, ?, ?)`,
    );
    this.recentStmt = db.prepare(
      `SELECT ocr_snippet, final_name, folder_path
       FROM classification_history
       ORDER BY saved_at DESC, id DESC
       LIMIT ?`,
    );
  }

  /** Best-effort save. Caller treats failures as non-fatal — history is a
   *  classification-quality bonus, not on the user's critical path. */
  recordSave(rec: SavedRecord): void {
    const snippet = rec.ocrText.slice(0, OCR_SNIPPET_MAX_CHARS);
    try {
      this.insertStmt.run(snippet, rec.finalName, rec.folderLinkId, rec.folderPath, rec.driveNodeUid);
    } catch (err) {
      logger.warn({ err: (err as Error).message }, 'classification history insert failed');
    }
  }

  /** Return the most recent `limit` saves as PastExample shapes. */
  findRecent(limit: number): PastExample[] {
    if (limit <= 0) return [];
    const rows = this.recentStmt.all(limit) as Array<{ ocr_snippet: string; final_name: string; folder_path: string }>;
    return rows.map((r) => ({
      ocrSnippet: r.ocr_snippet,
      finalName: r.final_name,
      folderPath: r.folder_path,
    }));
  }
}
