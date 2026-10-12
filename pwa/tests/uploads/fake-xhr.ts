/** A stand-in for XMLHttpRequest: it records the request, and the test answers it. */
export class FakeXhr {
  static last: FakeXhr | null = null;
  method = '';
  url = '';
  withCredentials = false;
  timeout = 0;
  status = 0;
  responseText = '';
  body: FormData | null = null;
  upload: { onprogress: ((e: { lengthComputable: boolean; loaded: number; total: number }) => void) | null } = { onprogress: null };
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  ontimeout: (() => void) | null = null;

  constructor() {
    FakeXhr.last = this;
  }

  open(method: string, url: string) {
    this.method = method;
    this.url = url;
  }

  send(body: FormData) {
    this.body = body;
  }

  respond(status: number, text: string) {
    this.status = status;
    this.responseText = text;
    this.onload?.();
  }
}
