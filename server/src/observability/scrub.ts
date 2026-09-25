import type { Breadcrumb, ErrorEvent, Event } from '@sentry/hono/node';

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
export function redactExact<T extends Event>(event: T, values: readonly string[]): T {
  // The stem too: the SDK can echo a de-duplicated candidate ("Name (2).pdf")
  // that does not contain the original name.
  const needles = [...new Set(values.flatMap((v) => [v, v.replace(/\.[^.\s]+$/, '')]))]
    .filter((v) => v.length >= 3)
    .sort((a, b) => b.length - a.length);
  if (needles.length === 0) return event;
  const redact = (text: string): string =>
    needles.reduce((out, needle) => out.split(needle).join('[filename]'), text);

  // Free text only. Tags, stack frames and the rest are ours or the SDK's;
  // walking them would let a name like "upload" rewrite the drive.operation
  // tag or a frame path and break grouping.
  if (event.message) event.message = redact(event.message);
  if (event.logentry?.message) event.logentry.message = redact(event.logentry.message);
  for (const exception of event.exception?.values ?? []) {
    if (exception.value) exception.value = redact(exception.value);
  }
  for (const crumb of event.breadcrumbs ?? []) {
    if (crumb.message) crumb.message = redact(crumb.message);
  }
  return event;
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
const BARE_FILENAME = new RegExp(`[\\p{L}\\p{N}_(-][\\p{L}\\p{N}._()-]{0,254}\\.${EXT}\\b`, 'giu');
const BEARER = /bearer\s+[^\s"',;]+/gi;
// Proton addresses reach error messages (e.g. keys.ts on a key decrypt
// failure); key-based redaction cannot see inside a message.
const EMAIL = /[^\s@"'<>()[\]]{1,64}@[^\s@"'<>()[\]]{1,255}\.[a-z]{2,24}/gi;
const DATA_URL = /data:[\w/+.-]+;base64,[A-Za-z0-9+/=]+/g;

// Quantifiers above are bounded and input is capped: beforeSend runs
// synchronously on the main thread, and an error message can embed a long
// unbroken token (base64, PGP armor, a JSON body) that would make unbounded
// patterns quadratic — tens of seconds for 100 KB.
const MAX_TEXT = 2000;
// Redact over a slightly larger window than we keep, so a quoted name that
// straddles the cut is removed whole instead of losing only its tail. Still
// bounded, so still fast.
const SCRUB_WINDOW = MAX_TEXT + 512;

function scrubText(text: string): string {
  let out = redactPatterns(text.length > SCRUB_WINDOW ? text.slice(0, SCRUB_WINDOW) : text);
  if (out.length > MAX_TEXT) {
    // Drop the token the cut splits, so no partial secret survives the cap.
    out = `${out.slice(0, MAX_TEXT).replace(/\S*$/, '')}[truncated]`;
  }
  return out;
}

function redactPatterns(text: string): string {
  return text
    .replace(DATA_URL, '[data-url]')
    .replace(BEARER, 'Bearer [redacted]')
    .replace(EMAIL, '[email]')
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
