import { currentContext, newId } from './context.js';
import { TRACE_VERSION, getSink, type TraceSink } from './sink.js';

/**
 * Duck-typed Mongoose surface.
 *
 * Typing against `mongoose` would make this package depend on it. FlowLens is a
 * dev tool — it should not pull a database driver into anyone's dependency tree,
 * and it must not be the thing that decides which Mongoose version you run.
 */
/** `this` inside a Mongoose hook: a Query or a Document. */
export type MongooseHookTarget = Record<PropertyKey, unknown>;

export interface MongooseLikeSchema {
  pre(
    hook: string | RegExp,
    options: { query?: boolean; document?: boolean },
    fn: (this: MongooseHookTarget) => void,
  ): unknown;
  post(
    hook: string | RegExp,
    options: { query?: boolean; document?: boolean },
    fn: (this: MongooseHookTarget, result: unknown) => void,
  ): unknown;
}

/** Query middleware hooks worth timing. */
const QUERY_HOOKS = [
  'find',
  'findOne',
  'findOneAndUpdate',
  'findOneAndDelete',
  'findOneAndReplace',
  'countDocuments',
  'estimatedDocumentCount',
  'distinct',
  'updateOne',
  'updateMany',
  'replaceOne',
  'deleteOne',
  'deleteMany',
  'aggregate',
] as const;

const DOCUMENT_HOOKS = ['save', 'validate', 'remove'] as const;

export interface MongoosePluginOptions {
  sink?: TraceSink;
  /** Collection names to skip (session stores, job queues, logs). */
  ignoreCollections?: string[];
}

/**
 * A Mongoose plugin that records one span per database operation.
 *
 * Register it globally, once, in your app's bootstrap — never inside FlowLens
 * itself. FlowLens does not open a connection; it only reads spans your own
 * app chose to emit.
 *
 *   mongoose.plugin(flowlensMongoose());
 */
export function flowlensMongoose(options: MongoosePluginOptions = {}) {
  const ignore = new Set(options.ignoreCollections ?? []);

  return function plugin(schema: MongooseLikeSchema): void {
    const sink = options.sink ?? getSink();

    const startKey = Symbol('flowlens.start');
    const spanKey = Symbol('flowlens.span');

    const begin = function (this: Record<PropertyKey, unknown>): void {
      (this as Record<PropertyKey, unknown>)[startKey] = Date.now();
      (this as Record<PropertyKey, unknown>)[spanKey] = newId();
    };

    const end = (kind: 'query' | 'document', operation: string) =>
      function (this: Record<PropertyKey, unknown>): void {
        const context = currentContext();
        if (!sink.enabled || !context) return;
        const startedAt = this[startKey];
        if (typeof startedAt !== 'number') return;

        const collection = collectionOf(this, kind);
        if (!collection || ignore.has(collection)) return;

        sink.write({
          v: TRACE_VERSION,
          traceId: context.traceId,
          spanId: String(this[spanKey] ?? newId()),
          parentSpanId: context.spanId,
          kind: 'db',
          name: `${collection}.${operation}`,
          startedAt,
          durationMs: Date.now() - startedAt,
          attrs: { collection, operation, driver: 'mongoose' },
        });
      };

    for (const hook of QUERY_HOOKS) {
      schema.pre(hook, { query: true }, begin);
      schema.post(hook, { query: true }, end('query', hook));
    }

    for (const hook of DOCUMENT_HOOKS) {
      schema.pre(hook, { document: true }, begin);
      schema.post(hook, { document: true }, end('document', hook));
    }
  };
}

/**
 * Get the collection name from a query or a document.
 * Mongoose exposes it in different places depending on the hook type.
 */
function collectionOf(
  target: Record<PropertyKey, unknown>,
  kind: 'query' | 'document',
): string | undefined {
  const candidates: unknown[] =
    kind === 'query'
      ? [
          (target['mongooseCollection'] as { name?: string } | undefined)?.name,
          (target['model'] as { collection?: { name?: string } } | undefined)?.collection?.name,
        ]
      : [
          (target['collection'] as { name?: string } | undefined)?.name,
          (target['constructor'] as { collection?: { name?: string } } | undefined)?.collection
            ?.name,
        ];

  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.length > 0) return candidate;
  }
  return undefined;
}
