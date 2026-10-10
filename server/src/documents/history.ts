import type { DB } from '../db.js';
import { logger } from '../logger.js';

const SNIPPET_MAX_CHARS = 500;

export interface FiledRecord {
  snippet: string;
  finalName: string;
  folderLinkId: string;
  folderPath: string;
  driveNodeUid: string;
}

/**
 * Every filing, recorded with an FTS5 index (migration 004) so similarity
 * recall can be switched on later without a backfill. Nothing reads it yet:
 * recall stays off until the eval shows it helps (spec §2).
 */
export class FilingHistory {
  constructor(private readonly db: DB) {}

  /** Best-effort: a history failure must never fail a filing. */
  recordSave(rec: FiledRecord): void {
    try {
      this.db
        .prepare(
          `INSERT INTO classification_history (ocr_snippet, final_name, folder_link_id, folder_path, drive_node_uid)
           VALUES (?, ?, ?, ?, ?)`,
        )
        .run(rec.snippet.slice(0, SNIPPET_MAX_CHARS), rec.finalName, rec.folderLinkId, rec.folderPath, rec.driveNodeUid);
    } catch (err) {
      logger.warn({ err: (err as Error).message }, 'filing history insert failed');
    }
  }
}
