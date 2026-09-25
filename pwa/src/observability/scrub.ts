import type { Breadcrumb, ErrorEvent } from '@sentry/browser';

/**
 * `beforeSend` scrubber for the PWA. Same allowlist-first rule as the
 * server's (server/src/observability/scrub.ts; keep the two in step): keep the
 * exception, stack, our tags and the page path; drop anything that could hold
 * a scanned page, a document name or a credential.
 *
 * Browser-specific: page images live in Blobs and canvas data URLs, and the
 * default breadcrumbs record console output and form input, so both of those
 * categories are dropped outright.
 */
export function scrubEvent(event: ErrorEvent): ErrorEvent | null {
  if (event.request) {
    const url = event.request.url;
    event.request = url ? { url: stripQuery(url) } : {};
  }

  delete event.user;

  if (event.message) event.message = scrubText(event.message);
  if (event.logentry?.message) event.logentry.message = scrubText(event.logentry.message);
  delete event.logentry?.params;

  for (const exception of event.exception?.values ?? []) {
    if (exception.value) exception.value = scrubText(exception.value);
    for (const frame of exception.stacktrace?.frames ?? []) delete frame.vars;
  }

  if (event.tags) {
    for (const [key, value] of Object.entries(event.tags)) {
      if (typeof value === 'string') event.tags[key] = scrubText(value);
    }
  }

  if (event.extra) event.extra = scrubValue(event.extra) as Record<string, unknown>;

  if (event.contexts) {
    for (const [name, context] of Object.entries(event.contexts)) {
      if (SDK_CONTEXTS.has(name) || !context) continue;
      event.contexts[name] = scrubValue(context) as Record<string, unknown>;
    }
  }

  if (event.breadcrumbs) {
    event.breadcrumbs = event.breadcrumbs
      .filter((crumb) => !DROPPED_BREADCRUMBS.has(crumb.category ?? ''))
      .map(scrubBreadcrumb);
  }

  return event;
}

const SDK_CONTEXTS = new Set(['browser', 'culture', 'device', 'os', 'trace']);
const DROPPED_BREADCRUMBS = new Set(['console', 'ui.input']);

const SENSITIVE_KEY =
  /pass(word|phrase)?|secret|token|totp|auth|cookie|session|email|^body$|^data$|content|bytes|blob|image|pdf|file.?name|name$|title|ocr|text/i;

const REDACTED = '[redacted]';

const EXT = '(?:pdf|jpe?g|png|heic|heif|webp|gif|tiff?|txt|docx?)';
const QUOTED_FILENAME = new RegExp(`(["'\`“‘])[^"'\`”’\\n]+?\\.${EXT}\\1`, 'giu');
const BARE_FILENAME = new RegExp(`[\\p{L}\\p{N}_(-][\\p{L}\\p{N}._()-]*\\.${EXT}\\b`, 'giu');
const BEARER = /bearer\s+[^\s"',;]+/gi;
const DATA_URL = /data:[\w/+.-]+;base64,[A-Za-z0-9+/=]+/g;

function scrubText(text: string): string {
  return text
    .replace(DATA_URL, '[data-url]')
    .replace(BEARER, 'Bearer [redacted]')
    .replace(QUOTED_FILENAME, '$1[filename]$1')
    .replace(BARE_FILENAME, '[filename]');
}

function scrubValue(value: unknown, depth = 0): unknown {
  if (depth > 8) return REDACTED;
  if (typeof value === 'string') return scrubText(value);
  if (value === null || typeof value !== 'object') return value;
  if (ArrayBuffer.isView(value) || value instanceof ArrayBuffer || value instanceof Blob) return '[binary]';
  if (Array.isArray(value)) return value.map((item) => scrubValue(item, depth + 1));

  const out: Record<string, unknown> = {};
  for (const [key, inner] of Object.entries(value)) {
    out[key] = SENSITIVE_KEY.test(key) ? REDACTED : scrubValue(inner, depth + 1);
  }
  return out;
}

function scrubBreadcrumb(crumb: Breadcrumb): Breadcrumb {
  const out: Breadcrumb = { ...crumb };
  if (out.message) out.message = scrubText(out.message);
  if (crumb.data) {
    const data: Record<string, unknown> = {};
    if (typeof crumb.data.method === 'string') data.method = crumb.data.method;
    for (const key of ['url', 'from', 'to'] as const) {
      if (typeof crumb.data[key] === 'string') data[key] = stripQuery(crumb.data[key]);
    }
    if (typeof crumb.data.status_code === 'number') data.status_code = crumb.data.status_code;
    out.data = data;
  }
  return out;
}

function stripQuery(url: string): string {
  const cut = url.search(/[?#]/);
  return cut === -1 ? url : url.slice(0, cut);
}
