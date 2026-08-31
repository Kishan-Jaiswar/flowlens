import { SPAN_HEADER, TRACE_HEADER, currentContext, newId, withContext } from './context.js';
import { TRACE_VERSION, getSink, type SinkOptions, type TraceSink } from './sink.js';

/**
 * Minimal shapes of the request/response objects, so this file needs no
 * dependency on Express or Nest types (and works with Fastify's compat layer).
 */
export interface TracedRequest {
  method?: string;
  originalUrl?: string;
  url?: string;
  path?: string;
  route?: { path?: string };
  headers?: Record<string, string | string[] | undefined>;
}

export interface TracedResponse {
  statusCode?: number;
  on?(event: string, listener: () => void): unknown;
  once?(event: string, listener: () => void): unknown;
}

export interface HttpTracerOptions extends SinkOptions {
  /** Paths to skip: health checks, static assets, the FlowLens dashboard. */
  ignore?: (string | RegExp)[];
  sink?: TraceSink;
}

const DEFAULT_IGNORE: (string | RegExp)[] = [
  /^\/health/,
  /^\/favicon\.ico$/,
  /^\/_next\//,
  /^\/static\//,
  /^\/__flowlens/,
];

/**
 * Express/Nest middleware that opens one server span per request.
 *
 * Add it once, at the top of your middleware chain:
 *
 *   app.use(flowlensHttp());
 *
 * Every database operation and nested method traced inside the request
 * automatically becomes a child of this span, which is how a click in the
 * browser and an `insertOne` in Mongo end up in the same trace.
 */
export function flowlensHttp(options: HttpTracerOptions = {}) {
  const sink = options.sink ?? getSink(options);
  const ignore = [...DEFAULT_IGNORE, ...(options.ignore ?? [])];

  return function flowlensHttpMiddleware(
    request: TracedRequest,
    response: TracedResponse,
    next: (error?: unknown) => void,
  ): void {
    const path = requestPath(request);
    if (!sink.enabled || shouldIgnore(path, ignore)) {
      next();
      return;
    }

    const traceId = headerValue(request, TRACE_HEADER) ?? newId(12);
    const parentSpanId = headerValue(request, SPAN_HEADER);
    const spanId = newId();
    const startedAt = Date.now();
    const method = (request.method ?? 'GET').toUpperCase();

    let finished = false;
    const finish = () => {
      if (finished) return;
      finished = true;
      sink.write({
        v: TRACE_VERSION,
        traceId,
        spanId,
        ...(parentSpanId ? { parentSpanId } : {}),
        kind: 'http-server',
        name: `${method} ${routePattern(request) ?? path}`,
        startedAt,
        durationMs: Date.now() - startedAt,
        attrs: {
          httpMethod: method,
          // Prefer the route pattern (`/customers/:id`) over the concrete URL.
          path: routePattern(request) ?? path,
          url: path,
          statusCode: response.statusCode,
        },
      });
    };

    response.once?.('finish', finish);
    response.once?.('close', finish);

    withContext({ traceId, spanId }, () => next());
  };
}

/**
 * Wrap any async function so it appears in the trace as a method span.
 *
 * Useful for the handful of service methods you actually care about timing:
 *
 *   async create(dto) {
 *     return traceMethod('CustomersService', 'create', () => this.doCreate(dto));
 *   }
 */
export async function traceMethod<T>(
  className: string,
  methodName: string,
  fn: () => Promise<T> | T,
  options: { sink?: TraceSink } = {},
): Promise<T> {
  const sink = options.sink ?? getSink();
  const parent = currentContext();
  if (!sink.enabled || !parent) return fn();

  const spanId = newId();
  const startedAt = Date.now();
  try {
    return await withContext({ traceId: parent.traceId, spanId }, () => fn());
  } finally {
    sink.write({
      v: TRACE_VERSION,
      traceId: parent.traceId,
      spanId,
      parentSpanId: parent.spanId,
      kind: 'method',
      name: `${className}.${methodName}`,
      startedAt,
      durationMs: Date.now() - startedAt,
      attrs: { class: className, method: methodName },
    });
  }
}

function requestPath(request: TracedRequest): string {
  const raw = request.originalUrl ?? request.url ?? request.path ?? '/';
  return raw.split('?')[0] ?? '/';
}

/** Express fills `req.route.path` once a route has matched. */
function routePattern(request: TracedRequest): string | undefined {
  return request.route?.path;
}

function headerValue(request: TracedRequest, name: string): string | undefined {
  const value = request.headers?.[name] ?? request.headers?.[name.toLowerCase()];
  if (Array.isArray(value)) return value[0];
  return value;
}

function shouldIgnore(path: string, patterns: (string | RegExp)[]): boolean {
  return patterns.some((pattern) =>
    typeof pattern === 'string' ? path.startsWith(pattern) : pattern.test(path),
  );
}
