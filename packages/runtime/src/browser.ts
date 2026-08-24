/**
 * Browser-side tracer.
 *
 * This is the half that makes the product's headline question literal: it
 * records the click itself, then stamps every request that click causes with
 * the same trace id, so the backend spans join the same trace.
 *
 * Loaded only in development — it patches `fetch` and `XMLHttpRequest`.
 */

const TRACE_HEADER = 'x-flowlens-trace';
const SPAN_HEADER = 'x-flowlens-span';
const TRACE_VERSION = 1;

export interface BrowserTracerOptions {
  /**
   * Where to POST spans. The FlowLens dev server exposes this endpoint;
   * defaults to the dashboard's collector.
   */
  endpoint?: string;
  /** Ignore clicks on elements matching these selectors. */
  ignoreSelector?: string;
  /** Max characters of element text used as the action label. */
  maxLabelLength?: number;
}

interface BrowserSpan {
  v: number;
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  kind: 'ui-action' | 'http-client';
  name: string;
  startedAt: number;
  durationMs: number;
  attrs?: Record<string, unknown>;
}

/**
 * The click that is currently "in scope".
 *
 * A user action and the requests it triggers are related by time, not by call
 * stack — the fetch happens in a promise long after the click handler returned.
 * A short-lived current action is a pragmatic and accurate enough link.
 */
let currentAction: { traceId: string; spanId: string; expiresAt: number } | undefined;

const ACTION_WINDOW_MS = 5000;

let installed = false;

export function installBrowserTracer(options: BrowserTracerOptions = {}): () => void {
  if (installed || typeof window === 'undefined') return () => {};
  installed = true;

  const endpoint = options.endpoint ?? 'http://localhost:4177/__flowlens/spans';
  const maxLabel = options.maxLabelLength ?? 60;
  const queue: BrowserSpan[] = [];

  const send = () => {
    if (queue.length === 0) return;
    const batch = queue.splice(0, queue.length);
    const body = JSON.stringify(batch);
    try {
      if (navigator.sendBeacon) {
        // text/plain keeps this a CORS-simple request — a beacon cannot preflight.
        navigator.sendBeacon(endpoint, new Blob([body], { type: 'text/plain;charset=UTF-8' }));
      } else {
        void originalFetch(endpoint, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body,
          keepalive: true,
        });
      }
    } catch {
      // Never let telemetry break the app being traced.
    }
  };

  const flushTimer = window.setInterval(send, 1000);
  window.addEventListener('beforeunload', send);

  // ---- clicks -----------------------------------------------------------
  const onClick = (event: Event) => {
    const target = event.target;
    if (!(target instanceof Element)) return;
    const actionable = target.closest(
      'button, a, [role="button"], input[type="submit"], [data-flowlens-action]',
    );
    if (!actionable) return;
    if (options.ignoreSelector && actionable.matches(options.ignoreSelector)) return;

    const traceId = randomId(12);
    const spanId = randomId(8);
    currentAction = { traceId, spanId, expiresAt: Date.now() + ACTION_WINDOW_MS };

    queue.push({
      v: TRACE_VERSION,
      traceId,
      spanId,
      kind: 'ui-action',
      name: labelOf(actionable, maxLabel),
      startedAt: Date.now(),
      durationMs: 0,
      attrs: {
        component: actionable.getAttribute('data-flowlens-component') ?? undefined,
        tag: actionable.tagName.toLowerCase(),
        route: window.location.pathname,
      },
    });
  };
  document.addEventListener('click', onClick, { capture: true });

  const onSubmit = (event: Event) => {
    const form = event.target;
    if (!(form instanceof HTMLFormElement)) return;
    const traceId = randomId(12);
    const spanId = randomId(8);
    currentAction = { traceId, spanId, expiresAt: Date.now() + ACTION_WINDOW_MS };
    queue.push({
      v: TRACE_VERSION,
      traceId,
      spanId,
      kind: 'ui-action',
      name: form.getAttribute('name') ?? form.getAttribute('id') ?? 'form submit',
      startedAt: Date.now(),
      durationMs: 0,
      attrs: { tag: 'form', route: window.location.pathname },
    });
  };
  document.addEventListener('submit', onSubmit, { capture: true });

  // ---- fetch ------------------------------------------------------------
  const originalFetch = window.fetch.bind(window);
  window.fetch = async function tracedFetch(input: RequestInfo | URL, init?: RequestInit) {
    const action = activeAction();
    if (!action) return originalFetch(input, init);

    const spanId = randomId(8);
    const headers = new Headers(
      init?.headers ?? (input instanceof Request ? input.headers : undefined),
    );
    headers.set(TRACE_HEADER, action.traceId);
    headers.set(SPAN_HEADER, spanId);

    const method = (
      init?.method ?? (input instanceof Request ? input.method : 'GET')
    ).toUpperCase();
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const startedAt = Date.now();

    try {
      const response = await originalFetch(input, { ...init, headers });
      queue.push(clientSpan(action, spanId, method, url, startedAt, response.status));
      return response;
    } catch (error) {
      queue.push({
        ...clientSpan(action, spanId, method, url, startedAt),
        attrs: { httpMethod: method, path: pathOf(url), error: String(error) },
      });
      throw error;
    }
  };

  // ---- XMLHttpRequest (axios's default transport in many setups) --------
  const originalOpen = XMLHttpRequest.prototype.open;
  const originalSend = XMLHttpRequest.prototype.send;

  type Tracked = XMLHttpRequest & {
    __flowlens?: {
      method: string;
      url: string;
      spanId: string;
      startedAt: number;
      traceId: string;
    };
  };

  XMLHttpRequest.prototype.open = function patchedOpen(
    this: Tracked,
    method: string,
    url: string | URL,
    ...rest: unknown[]
  ) {
    const action = activeAction();
    if (action) {
      this.__flowlens = {
        method: method.toUpperCase(),
        url: typeof url === 'string' ? url : url.href,
        spanId: randomId(8),
        startedAt: 0,
        traceId: action.traceId,
      };
    }
    return originalOpen.apply(this, [method, url, ...rest] as never);
  } as typeof XMLHttpRequest.prototype.open;

  XMLHttpRequest.prototype.send = function patchedSend(this: Tracked, body?: unknown) {
    const tracked = this.__flowlens;
    if (tracked) {
      tracked.startedAt = Date.now();
      try {
        this.setRequestHeader(TRACE_HEADER, tracked.traceId);
        this.setRequestHeader(SPAN_HEADER, tracked.spanId);
      } catch {
        // Headers already sent — nothing to do.
      }
      this.addEventListener('loadend', () => {
        const action = { traceId: tracked.traceId, spanId: tracked.spanId };
        queue.push(
          clientSpan(
            action,
            tracked.spanId,
            tracked.method,
            tracked.url,
            tracked.startedAt,
            this.status,
          ),
        );
      });
    }
    return originalSend.call(this, body as never);
  } as typeof XMLHttpRequest.prototype.send;

  return function uninstall() {
    installed = false;
    window.clearInterval(flushTimer);
    window.removeEventListener('beforeunload', send);
    document.removeEventListener('click', onClick, { capture: true } as never);
    document.removeEventListener('submit', onSubmit, { capture: true } as never);
    window.fetch = originalFetch;
    XMLHttpRequest.prototype.open = originalOpen;
    XMLHttpRequest.prototype.send = originalSend;
    send();
  };
}

function clientSpan(
  action: { traceId: string; spanId: string },
  spanId: string,
  method: string,
  url: string,
  startedAt: number,
  status?: number,
): BrowserSpan {
  return {
    v: TRACE_VERSION,
    traceId: action.traceId,
    spanId,
    parentSpanId: action.spanId,
    kind: 'http-client',
    name: `${method} ${pathOf(url)}`,
    startedAt,
    durationMs: Date.now() - startedAt,
    attrs: { httpMethod: method, path: pathOf(url), statusCode: status },
  };
}

function activeAction(): { traceId: string; spanId: string } | undefined {
  if (!currentAction) return undefined;
  if (Date.now() > currentAction.expiresAt) {
    currentAction = undefined;
    return undefined;
  }
  return { traceId: currentAction.traceId, spanId: currentAction.spanId };
}

function labelOf(element: Element, maxLength: number): string {
  const explicit = element.getAttribute('data-flowlens-action');
  if (explicit) return explicit;
  const text = (element.textContent ?? '').replace(/\s+/g, ' ').trim();
  if (text) return text.slice(0, maxLength);
  return (
    element.getAttribute('aria-label') ??
    element.getAttribute('title') ??
    element.getAttribute('name') ??
    element.tagName.toLowerCase()
  );
}

function pathOf(url: string): string {
  try {
    return new URL(url, window.location.origin).pathname;
  } catch {
    return url.split('?')[0] ?? url;
  }
}

function randomId(bytes: number): string {
  const array = new Uint8Array(bytes);
  crypto.getRandomValues(array);
  return Array.from(array, (byte) => byte.toString(16).padStart(2, '0')).join('');
}
