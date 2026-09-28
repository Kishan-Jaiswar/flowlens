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

/**
 * One store per process, not per module instance.
 *
 * Bundlers load this file more than once: Turbopack compiles Next's
 * `instrumentation.ts` and the route handlers into separate module graphs, and
 * dev HMR re-evaluates modules constantly. A module-scoped store then gives the
 * request tracer and the database tracer different stores, and no query ever
 * nests under its request. Keyed on a registered symbol so every copy of this
 * package — whatever its version — finds the same one.
 */
const STORAGE_KEY = Symbol.for('flowlens.trace-context');
const globalRef = globalThis as typeof globalThis & {
  [STORAGE_KEY]?: AsyncLocalStorage<TraceContext>;
};
const storage = (globalRef[STORAGE_KEY] ??= new AsyncLocalStorage<TraceContext>());

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
