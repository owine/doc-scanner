import { request } from '../api.js';
import type { ApproveBody, DocumentView, FolderEntry, Settings } from './types.js';

const doc = (id: string, action: string) => `/api/documents/${encodeURIComponent(id)}${action}`;

export const documentsApi = {
  list: (since: number) => request<{ documents: DocumentView[]; cursor: number }>(`/api/documents?since=${since}`),
  get: (id: string) => request<DocumentView>(doc(id, '')),
  approve: (id: string, body: ApproveBody) =>
    request<DocumentView>(doc(id, '/approve'), { method: 'POST', body: JSON.stringify(body) }),
  discard: (id: string) => request<{ result: 'discarded' | 'requested' }>(doc(id, '/discard'), { method: 'POST' }),
  restore: (id: string) => request<DocumentView>(doc(id, '/restore'), { method: 'POST' }),
  retry: (id: string) => request<DocumentView>(doc(id, '/retry'), { method: 'POST' }),
  folders: () => request<{ walkedAt: string; folders: FolderEntry[] }>('/api/folders'),
  refreshFolders: () => request<{ ok: true }>('/api/folders/refresh', { method: 'POST' }),
  settings: () => request<Settings>('/api/settings'),
  saveSettings: (patch: Partial<Settings>) =>
    request<Settings>('/api/settings', { method: 'PUT', body: JSON.stringify(patch) }),
};

export type DocumentsApi = typeof documentsApi;
