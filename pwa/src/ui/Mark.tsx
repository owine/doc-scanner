/** The doc-scanner mark: a page with a folded corner, and the owine offset dot. Decorative.
 * The app icons draw the same mark with padding: server/scripts/render-pwa-icons.mjs. Change both together. */
export function Mark({ size = 22 }: { size?: number }) {
  return (
    <svg class="mark" width={size} height={size} viewBox="0 0 32 32" aria-hidden="true" focusable="false">
      <path d="M8 4h10.5l5 5v19H8z" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round" />
      <path d="M18.5 4v5h5" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round" />
      <circle cx="26" cy="26" r="2.6" style={{ fill: 'var(--accent)' }} />
    </svg>
  );
}
