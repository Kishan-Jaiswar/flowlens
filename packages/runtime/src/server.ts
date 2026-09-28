import { Server, type IncomingMessage, type ServerResponse } from 'node:http';
import { flowlensHttp, type HttpTracerOptions } from './http.js';

/**
 * Request tracing for servers with no middleware chain to join.
 *
 * `flowlensHttp()` is middleware, and the Next.js App Router has nowhere to put
 * it: `middleware.ts` / `proxy.ts` is a separate invocation, so a context opened
 * there is gone by the time the route handler runs. The HTTP server's own
 * `request` event is the one place upstream of every handler, so the same
 * middleware runs there instead — and every `await` inside the handler,
 * database calls included, inherits the trace.
 */
export interface ServerTracingOptions extends HttpTracerOptions {
  /**
   * Only requests under this path are traced; `false` traces all of them.
   * Defaults to `/api/`, because a page navigation merged into the graph reads
   * as a backend route that does not exist.
   */
  prefix?: string | false;
}

type EmitArgs = [event: string | symbol, ...args: unknown[]];

const PATCHED = Symbol.for('flowlens.server-patched');
const globalRef = globalThis as typeof globalThis & { [PATCHED]?: () => void };

/**
 * Patch `http.Server` so every request opens a span. Idempotent — dev HMR
 * re-runs the caller, and patching twice would nest each request under itself.
 * Returns a function that removes the patch.
 */
export function installServerTracing(options: ServerTracingOptions = {}): () => void {
  if (globalRef[PATCHED]) return globalRef[PATCHED];

  const prefix = options.prefix ?? '/api/';
  const middleware = flowlensHttp(options);
  // Typed loosely on purpose: `emit` is overloaded per event, and this wrapper
  // forwards every event it does not care about untouched.
  const originalEmit = Server.prototype.emit as (this: Server, ...args: EmitArgs) => boolean;

  Server.prototype.emit = function flowlensEmit(this: Server, ...args: EmitArgs): boolean {
    if (args[0] !== 'request') return originalEmit.apply(this, args);
    const request = args[1] as IncomingMessage;
    const response = args[2] as ServerResponse;
    const path = (request.url ?? '/').split('?')[0] ?? '/';
    if (prefix !== false && !path.startsWith(prefix)) return originalEmit.apply(this, args);

    let handled = false;
    // `next` runs synchronously inside the trace context, so the listeners the
    // server calls — the framework's handler among them — run inside it too.
    middleware(request, response, () => {
      handled = originalEmit.apply(this, args);
    });
    return handled;
  } as Server['emit'];

  const uninstall = () => {
    Server.prototype.emit = originalEmit as Server['emit'];
    delete globalRef[PATCHED];
  };
  globalRef[PATCHED] = uninstall;
  return uninstall;
}
