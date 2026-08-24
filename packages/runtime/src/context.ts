import { AsyncLocalStorage } from 'node:async_hooks';
import { randomBytes } from 'node:crypto';

/**
 * The trace context, carried through async work by AsyncLocalStorage.
 *
 * This is what lets a Mongoose hook know which HTTP request — and therefore
 * which user click — it belongs to, without threading a parameter through
 * every service method.
 */
export interface TraceContext {
  traceId: string;
  spanId: string;
}

const storage = new AsyncLocalStorage<TraceContext>();

/** Header used to carry the trace id across the frontend/backend boundary. */
export const TRACE_HEADER = 'x-flowlens-trace';
export const SPAN_HEADER = 'x-flowlens-span';

export function currentContext(): TraceContext | undefined {
  return storage.getStore();
}

/** Run `fn` with the given context active for all async work inside it. */
export function withContext<T>(context: TraceContext, fn: () => T): T {
  return storage.run(context, fn);
}

export function newId(bytes = 8): string {
  return randomBytes(bytes).toString('hex');
}
