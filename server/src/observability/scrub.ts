import type { Breadcrumb, ErrorEvent } from '@sentry/hono/node';

/**
 * `beforeSend` scrubber. This app handles scanned personal documents and
 * Proton credentials, so the rule is allowlist-first: an error event keeps the
 * exception, its stack, our own tags and the route, and loses everything that
 * could carry user content.
 *
 * - request: only `method` and `url` (without query/fragment) survive; body,
 *   cookies, headers and query string are dropped outright.
 * - user: dropped.
 * - extra / custom contexts / breadcrumb data: values under sensitive keys are
 *   redacted, binary values and data URLs are replaced.
 * - free text (exception values, messages, tags): bearer tokens, data URLs and
 *   filename-looking substrings are redacted.
 * - stack frames: `vars` (captured locals) dropped; `filename` is the source
 *   path and is kept, or events would stop grouping.
 * - breadcrumbs: console ones dropped; the rest keep only method/url/status.
 *
 * The PWA has its own copy in pwa/src/observability/scrub.ts; keep the two in
 * step when changing what counts as sensitive.
 */
export function scrubEvent(event: ErrorEvent): ErrorEvent | null {
  if (event.request) {
    const { method, url } = event.request;
    event.request = {};
    if (method) event.request.method = method;
    if (url) event.request.url = stripQuery(url);
  }

  delete event.user;

  if (event.message) event.message = scrubText(event.message);
  if (event.logentry?.message) event.logentry.message = scrubText(event.logentry.message);
  delete event.logentry?.params;

  for (const exception of event.exception?.values ?? []) {
    if (exception.value) exception.value = scrubText(exception.value);
    for (const frame of exception.stacktrace?.frames ?? []) {
      delete frame.vars;
    }
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
      .filter((crumb) => crumb.category !== 'console')
      .map(scrubBreadcrumb);
  }

  return event;
}

/**
 * Replaces every occurrence of the given values (e.g. the document name a
 * capture site was handed) anywhere in the event. Complements the pattern
 * matching in scrubText, which cannot recognise an unquoted name with spaces.
 */
export function redactExact<T>(event: T, values: readonly string[]): T {
  const needles = values.filter((v) => v.length >= 3);
  if (needles.length === 0) return event;
  const walk = (value: unknown): unknown => {
    if (typeof value === 'string') {
      return needles.reduce((text, needle) => text.split(needle).join('[filename]'), value);
    }
    if (Array.isArray(value)) return value.map(walk);
    if (value && typeof value === 'object') {
      for (const [key, inner] of Object.entries(value)) (value as Record<string, unknown>)[key] = walk(inner);
    }
    return value;
  };
  return walk(event) as T;
}

/** Contexts the SDK fills from the runtime itself; they carry no user data. */
const SDK_CONTEXTS = new Set(['app', 'cloud_resource', 'culture', 'device', 'os', 'runtime', 'trace']);

/**
 * Keys whose values are never sent. Matched case-insensitively against the
 * whole key, so `accessToken`, `AccessToken` and `x-pm-uid` all hit.
 */
const SENSITIVE_KEY =
  /pass(word|phrase)?|secret|token|auth|cookie|session|^uid$|pm-uid|mailbox|private.?key|salt|proof|remote.?user|email|^body$|^data$|content|bytes|file.?name|^name$|title|ocr|text/i;

const REDACTED = '[redacted]';

// Document and image names are the realistic way a filename reaches an error
// message. A quoted name may contain spaces ("2026 Tax Return.pdf" goes
// whole); a bare one may not, or "upload failed for scan.pdf" would lose the
// whole sentence. A bare name WITH spaces only loses its last word here, which
// is why capture sites that know the real name also redact it exactly
// (see redactStrings / report.ts).
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
  if (ArrayBuffer.isView(value) || value instanceof ArrayBuffer || isBlob(value)) return '[binary]';
  if (Array.isArray(value)) return value.map((item) => scrubValue(item, depth + 1));

  const out: Record<string, unknown> = {};
  for (const [key, inner] of Object.entries(value)) {
    out[key] = SENSITIVE_KEY.test(key) ? REDACTED : scrubValue(inner, depth + 1);
  }
  return out;
}

function isBlob(value: object): boolean {
  return typeof Blob !== 'undefined' && value instanceof Blob;
}

function scrubBreadcrumb(crumb: Breadcrumb): Breadcrumb {
  const out: Breadcrumb = { ...crumb };
  if (out.message) out.message = scrubText(out.message);
  if (crumb.data) {
    const data: Record<string, unknown> = {};
    if (typeof crumb.data.method === 'string') data.method = crumb.data.method;
    if (typeof crumb.data.url === 'string') data.url = stripQuery(crumb.data.url);
    if (typeof crumb.data.status_code === 'number') data.status_code = crumb.data.status_code;
    out.data = data;
  }
  return out;
}

function stripQuery(url: string): string {
  const cut = url.search(/[?#]/);
  return cut === -1 ? url : url.slice(0, cut);
}
