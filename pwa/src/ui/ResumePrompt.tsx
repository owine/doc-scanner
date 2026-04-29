import type { Scan } from '../scanner/types.js';

export interface ResumePromptProps {
  scan: Scan;
  onResume: () => void;
  onDiscard: () => void;
}

function relativeTime(ms: number): string {
  const sec = Math.floor((Date.now() - ms) / 1000);
  if (sec < 60) return 'just now';
  if (sec < 3600) return `${Math.floor(sec / 60)} min ago`;
  if (sec < 86400) return `${Math.floor(sec / 3600)} h ago`;
  return new Date(ms).toLocaleDateString();
}

export function ResumePrompt({ scan, onResume, onDiscard }: ResumePromptProps) {
  return (
    <main class="auth-screen">
      <div class="card">
        <h2 style={{ marginTop: 0 }}>Unfinished scan</h2>
        <p>You have an in-progress scan with <strong>{scan.pageCount} pages</strong> from {relativeTime(scan.createdAt)}.</p>
        <div style={{ display: 'flex', gap: 8 }}>
          <button class="btn" onClick={onResume}>Resume scanning</button>
          <button class="btn btn-secondary" onClick={onDiscard}>Discard</button>
        </div>
      </div>
    </main>
  );
}
