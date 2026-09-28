import { currentContext, newId } from './context.js';
import { TRACE_VERSION, getSink, type TraceSink } from './sink.js';

/**
 * Tracing for the native MongoDB driver — the one `flowlensMongoose()` cannot
 * reach, because there are no schema hooks to join.
 *
 *   const db = traceDb(client.db('app'));
 *
 * A proxy around the `Db` handle: every collection it hands out records one
 * span per operation, written only while a request is being traced, which is
 * what puts `medicines.updateOne` under `PUT /api/medicines/:id` instead of
 * leaving it floating. Outside a request — index creation at start-up, a
 * background worker — there is no context and nothing is written. A plain
 * pass-through when `NODE_ENV` is `production` or `FLOWLENS_TRACING=off`.
 *
 * Typed by shape, not by import: this package has no dependencies, and the
 * driver's own types come back out of `traceDb` unchanged.
 */

/** Operations that return a promise, so the call itself can be timed. */
const AWAITED = new Set([
  'insertOne',
  'insertMany',
  'updateOne',
  'updateMany',
  'replaceOne',
  'deleteOne',
  'deleteMany',
  'findOne',
  'findOneAndUpdate',
  'findOneAndDelete',
  'findOneAndReplace',
  'countDocuments',
  'estimatedDocumentCount',
  'distinct',
  'bulkWrite',
]);

/** Operations that return a lazy cursor: the query runs when it is drained. */
const CURSORS = new Set(['find', 'aggregate']);

/** Cursor methods that actually reach the database. */
const TERMINALS = new Set(['toArray', 'forEach', 'next', 'hasNext', 'explain']);

type AnyFunction = (...args: unknown[]) => unknown;

export interface MongoTracingOptions {
  sink?: TraceSink;
}

/** A database handle whose collections are traced. */
export function traceDb<T extends object>(db: T, options: MongoTracingOptions = {}): T {
  if (!tracingEnabled()) return db;
  return new Proxy(db, {
    get(target, property) {
      const value = Reflect.get(target, property) as unknown;
      if (typeof value !== 'function') return value;
      const method = value as AnyFunction;
      if (property !== 'collection') {
        // `this` stays the real handle: the driver's classes use private fields,
        // which throw when read through a proxy.
        return (...args: unknown[]) => method.apply(target, args);
      }
      return (...args: unknown[]) => traceCollection(method.apply(target, args) as object, options);
    },
  });
}

/** One collection handle that records what it is asked to do. */
export function traceCollection<T extends object>(
  collection: T,
  options: MongoTracingOptions = {},
): T {
  if (!tracingEnabled()) return collection;
  const name = String((collection as { collectionName?: unknown }).collectionName ?? 'unknown');
  return new Proxy(collection, {
    get(target, property) {
      const value = Reflect.get(target, property) as unknown;
      if (typeof value !== 'function' || typeof property !== 'string') return value;
      const method = value as AnyFunction;
      if (AWAITED.has(property)) {
        return (...args: unknown[]) =>
          timed(name, property, options, () => method.apply(target, args));
      }
      if (CURSORS.has(property)) {
        return (...args: unknown[]) =>
          traceCursor(method.apply(target, args) as object, name, property, options);
      }
      return (...args: unknown[]) => method.apply(target, args);
    },
  });
}

/**
 * The span is written when the query runs, not when the cursor is made.
 * Chaining methods (`.sort().limit()`) return the cursor itself, so those come
 * back wrapped too, or the tracing is lost on the way to `.toArray()`.
 */
function traceCursor<T extends object>(
  cursor: T,
  collection: string,
  operation: string,
  options: MongoTracingOptions,
): T {
  const proxy: T = new Proxy(cursor, {
    get(target, property) {
      const value = Reflect.get(target, property) as unknown;
      if (typeof value !== 'function' || typeof property !== 'string') return value;
      const method = value as AnyFunction;
      if (TERMINALS.has(property)) {
        return (...args: unknown[]) =>
          timed(collection, operation, options, () => method.apply(target, args));
      }
      return (...args: unknown[]) => {
        const result = method.apply(target, args);
        return result === target ? proxy : result;
      };
    },
  });
  return proxy;
}

/** Time a call, recording success and failure alike. */
function timed<T>(
  collection: string,
  operation: string,
  options: MongoTracingOptions,
  run: () => T,
): T {
  const startedAt = Date.now();
  let result: T;
  try {
    result = run();
  } catch (error) {
    writeSpan(collection, operation, startedAt, options, error);
    throw error;
  }
  if (!isPromise(result)) {
    writeSpan(collection, operation, startedAt, options);
    return result;
  }
  return result.then(
    (value) => {
      writeSpan(collection, operation, startedAt, options);
      return value;
    },
    (error: unknown) => {
      writeSpan(collection, operation, startedAt, options, error);
      throw error;
    },
  ) as T;
}

function writeSpan(
  collection: string,
  operation: string,
  startedAt: number,
  options: MongoTracingOptions,
  error?: unknown,
): void {
  const context = currentContext();
  if (!context) return;
  const sink = options.sink ?? getSink();
  if (!sink.enabled) return;
  sink.write({
    v: TRACE_VERSION,
    traceId: context.traceId,
    spanId: newId(),
    parentSpanId: context.spanId,
    kind: 'db',
    name: `${collection}.${operation}`,
    startedAt,
    durationMs: Date.now() - startedAt,
    attrs: {
      collection,
      operation,
      driver: 'mongodb',
      ...(error ? { error: error instanceof Error ? error.message : String(error) } : {}),
    },
  });
}

function isPromise(value: unknown): value is Promise<unknown> {
  return typeof (value as Promise<unknown> | undefined)?.then === 'function';
}

function tracingEnabled(): boolean {
  return process.env['NODE_ENV'] !== 'production' && process.env['FLOWLENS_TRACING'] !== 'off';
}
