import { openDB, type DBSchema, type IDBPDatabase } from 'idb';
import type { UploadItem } from './types.js';

interface UploadsSchema extends DBSchema {
  uploads: { key: string; value: UploadItem };
}

/** Its own database, so it never shares a schema version with the scans store. */
const DB_NAME = 'docscanner-uploads';

export interface UploadStorage {
  all(): Promise<UploadItem[]>;
  put(item: UploadItem): Promise<void>;
  remove(id: string): Promise<void>;
}

export class UploadStore implements UploadStorage {
  private db: Promise<IDBPDatabase<UploadsSchema>> | null = null;

  private get d(): Promise<IDBPDatabase<UploadsSchema>> {
    this.db ??= openDB<UploadsSchema>(DB_NAME, 1, {
      upgrade(db) {
        db.createObjectStore('uploads', { keyPath: 'id' });
      },
    });
    return this.db;
  }

  async all(): Promise<UploadItem[]> {
    return (await (await this.d).getAll('uploads')).sort((a, b) => a.createdAt - b.createdAt);
  }

  async put(item: UploadItem): Promise<void> {
    await (await this.d).put('uploads', item);
  }

  async remove(id: string): Promise<void> {
    await (await this.d).delete('uploads', id);
  }
}
