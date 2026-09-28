/**
 * `@flowslens/runtime` — opt-in instrumentation for the app you are studying.
 *
 * Nothing here opens a database connection or talks to a network service of its
 * own. It observes the work your app was already doing and appends spans to a
 * local JSONL file, which `flowlens trace` merges into the static graph.
 *
 * Wire it up in development only:
 *
 *   import { flowlensHttp, flowlensMongoose, traceDb } from '@flowslens/runtime';
 *   app.use(flowlensHttp());                 // Express / Nest
 *   mongoose.plugin(flowlensMongoose());     // Mongoose
 *   const db = traceDb(client.db('app'));    // the native MongoDB driver
 *
 * Next.js App Router, which has no middleware chain to join:
 *
 *   // instrumentation.ts
 *   export { register } from '@flowslens/runtime/next';
 */

export {
  SPAN_HEADER,
  TRACE_HEADER,
  currentContext,
  newId,
  withContext,
  type TraceContext,
} from './context.js';

export {
  TRACE_VERSION,
  TraceSink,
  getSink,
  setSink,
  type SinkOptions,
  type SpanKind,
  type TraceEvent,
} from './sink.js';

export {
  flowlensHttp,
  traceMethod,
  type HttpTracerOptions,
  type TracedRequest,
  type TracedResponse,
} from './http.js';

export {
  flowlensMongoose,
  type MongooseLikeSchema,
  type MongoosePluginOptions,
} from './mongoose.js';

export { traceCollection, traceDb, type MongoTracingOptions } from './mongodb.js';

export { installServerTracing, type ServerTracingOptions } from './server.js';
