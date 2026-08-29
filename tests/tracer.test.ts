import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  SPAN_HEADER,
  TRACE_HEADER,
  TraceSink,
  currentContext,
  flowlensHttp,
  flowlensMongoose,
  traceMethod,
  type TraceEvent,
} from '@flowlens/runtime';
import { mergeRuntimeTrace, parseTraceFile, resolveFlows, scan } from '@flowlens/core';
import { EXAMPLE_ROOT } from './helpers.js';

/**
 * Tests for the tracer itself, using fakes rather than a live stack.
 *
 * The tracer is duck-typed on purpose — it never imports Express or Mongoose —
 * which means its contract can be exercised with plain objects: a request, a
 * response that emits `finish`, and a schema that records the hooks registered
 * on it. No server, no database, no network.
 */

let temp: string;
let sink: TraceSink;

const traceFile = () => join(temp, 'trace.jsonl');

function spans(): TraceEvent[] {
  sink.flush();
  if (!existsSync(traceFile())) return [];
  return parseTraceFile(readFileSync(traceFile(), 'utf8'));
}

beforeEach(() => {
  temp = mkdtempSync(join(tmpdir(), 'flowlens-tracer-'));
  // batchSize 1 keeps every assertion about what was written immediate.
  sink = new TraceSink({ file: traceFile(), batchSize: 1 });
});

afterEach(() => {
  sink.close();
  rmSync(temp, { recursive: true, force: true });
});

/** A response object shaped like the bit of Node's ServerResponse we use. */
function fakeResponse(statusCode = 200) {
  const listeners = new Map<string, () => void>();
  return {
    statusCode,
    once(event: string, listener: () => void) {
      listeners.set(event, listener);
      return this;
    },
    /** Simulate the response completing. */
    finish() {
      listeners.get('finish')?.();
    },
    close() {
      listeners.get('close')?.();
    },
    listenerCount: () => listeners.size,
  };
}

describe('TraceSink', () => {
  it('appends one JSON object per line', () => {
    sink.write(event({ spanId: 'a' }));
    sink.write(event({ spanId: 'b' }));
    expect(spans().map((s) => s.spanId)).toEqual(['a', 'b']);
  });

  it('creates the directory it writes into', () => {
    const nested = new TraceSink({ file: join(temp, 'deep', 'nested', 'trace.jsonl') });
    nested.write(event({}));
    nested.flush();
    expect(existsSync(join(temp, 'deep', 'nested', 'trace.jsonl'))).toBe(true);
    nested.close();
  });

  it('buffers until the batch size is reached', () => {
    const buffered = new TraceSink({ file: join(temp, 'buffered.jsonl'), batchSize: 3 });
    buffered.write(event({ spanId: '1' }));
    buffered.write(event({ spanId: '2' }));
    expect(existsSync(join(temp, 'buffered.jsonl'))).toBe(false);
    buffered.write(event({ spanId: '3' }));
    expect(parseTraceFile(readFileSync(join(temp, 'buffered.jsonl'), 'utf8'))).toHaveLength(3);
    buffered.close();
  });

  it('writes nothing when disabled', () => {
    const off = new TraceSink({ file: join(temp, 'off.jsonl'), enabled: false });
    off.write(event({}));
    off.flush();
    expect(existsSync(join(temp, 'off.jsonl'))).toBe(false);
  });

  /**
   * Tracing must never be the reason an app breaks. A directory that cannot be
   * created disables the sink after one reported error instead of throwing on
   * every request.
   */
  it('disables itself after a write failure instead of throwing', () => {
    const errors: unknown[] = [];

    // A regular file cannot contain a directory, so creating the sink's parent
    // directory is guaranteed to fail with ENOTDIR.
    const blocker = join(temp, 'blocker');
    writeFileSync(blocker, 'not a directory', 'utf8');

    const broken = new TraceSink({
      file: join(blocker, 'nested', 'trace.jsonl'),
      onError: (error) => errors.push(error),
    });

    expect(broken.enabled).toBe(false);
    expect(errors).toHaveLength(1);
    // Still safe to use: writes are dropped rather than thrown.
    expect(() => broken.write(event({}))).not.toThrow();
    expect(() => broken.flush()).not.toThrow();
    broken.close();
  });
});

describe('flowlensHttp', () => {
  it('calls next exactly once', () => {
    let calls = 0;
    flowlensHttp({ sink })(
      { method: 'GET', originalUrl: '/x', headers: {} },
      fakeResponse(),
      () => {
        calls += 1;
      },
    );
    expect(calls).toBe(1);
  });

  it('writes a server span when the response finishes', () => {
    const response = fakeResponse(201);
    flowlensHttp({ sink })(
      { method: 'POST', originalUrl: '/api/users?x=1', headers: {} },
      response,
      () => {},
    );
    expect(spans()).toHaveLength(0); // nothing until the response completes
    response.finish();

    const [span] = spans();
    expect(span?.kind).toBe('http-server');
    expect(span?.attrs?.httpMethod).toBe('POST');
    // Query string dropped: the route is what matters.
    expect(span?.attrs?.path).toBe('/api/users');
    expect(span?.attrs?.statusCode).toBe(201);
    expect(span?.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('writes the span only once even if finish and close both fire', () => {
    const response = fakeResponse();
    flowlensHttp({ sink })({ method: 'GET', originalUrl: '/a', headers: {} }, response, () => {});
    response.finish();
    response.close();
    expect(spans()).toHaveLength(1);
  });

  it('continues a trace started in the browser', () => {
    const response = fakeResponse();
    flowlensHttp({ sink })(
      {
        method: 'GET',
        originalUrl: '/a',
        headers: { [TRACE_HEADER]: 'trace-from-click', [SPAN_HEADER]: 'client-span' },
      },
      response,
      () => {},
    );
    response.finish();

    const [span] = spans();
    // Same trace id as the click, parented to the browser's request span.
    expect(span?.traceId).toBe('trace-from-click');
    expect(span?.parentSpanId).toBe('client-span');
  });

  it('starts a new trace when there is no incoming header', () => {
    const response = fakeResponse();
    flowlensHttp({ sink })({ method: 'GET', originalUrl: '/a', headers: {} }, response, () => {});
    response.finish();
    const [span] = spans();
    expect(span?.traceId).toMatch(/^[0-9a-f]+$/);
    expect(span?.parentSpanId).toBeUndefined();
  });

  it('prefers the route pattern over the concrete url', () => {
    const response = fakeResponse();
    flowlensHttp({ sink })(
      {
        method: 'GET',
        originalUrl: '/users/507f1f77bcf86cd799439011',
        route: { path: '/users/:id' },
        headers: {},
      },
      response,
      () => {},
    );
    response.finish();
    const [span] = spans();
    expect(span?.attrs?.path).toBe('/users/:id');
    expect(span?.attrs?.url).toBe('/users/507f1f77bcf86cd799439011');
  });

  it('ignores health checks and static assets', () => {
    const middleware = flowlensHttp({ sink });
    for (const url of ['/health', '/favicon.ico', '/_next/static/x.js', '/__flowlens/spans']) {
      const response = fakeResponse();
      middleware({ method: 'GET', originalUrl: url, headers: {} }, response, () => {});
      response.finish();
      // Ignored requests never register a listener in the first place.
      expect(response.listenerCount()).toBe(0);
    }
    expect(spans()).toHaveLength(0);
  });

  it('honours a custom ignore list', () => {
    const response = fakeResponse();
    flowlensHttp({ sink, ignore: [/^\/internal/] })(
      { method: 'GET', originalUrl: '/internal/metrics', headers: {} },
      response,
      () => {},
    );
    response.finish();
    expect(spans()).toHaveLength(0);
  });

  it('makes the trace context available to downstream work', () => {
    let seen: ReturnType<typeof currentContext>;
    flowlensHttp({ sink })(
      { method: 'GET', originalUrl: '/a', headers: {} },
      fakeResponse(),
      () => {
        seen = currentContext();
      },
    );
    expect(seen?.traceId).toBeTypeOf('string');
    expect(seen?.spanId).toBeTypeOf('string');
  });

  it('leaves no context outside a request', () => {
    expect(currentContext()).toBeUndefined();
  });
});

describe('traceMethod', () => {
  it('records a method span parented to the request', async () => {
    const response = fakeResponse();
    await new Promise<void>((resolve) => {
      flowlensHttp({ sink })(
        { method: 'POST', originalUrl: '/api/users', headers: {} },
        response,
        async () => {
          await traceMethod('UsersService', 'create', async () => 'created', { sink });
          resolve();
        },
      );
    });
    response.finish();

    const written = spans();
    const method = written.find((s) => s.kind === 'method');
    const server = written.find((s) => s.kind === 'http-server');
    expect(method?.name).toBe('UsersService.create');
    expect(method?.attrs?.class).toBe('UsersService');
    expect(method?.traceId).toBe(server?.traceId);
    expect(method?.parentSpanId).toBe(server?.spanId);
  });

  it('returns the wrapped value', async () => {
    const response = fakeResponse();
    let result: unknown;
    await new Promise<void>((resolve) => {
      flowlensHttp({ sink })(
        { method: 'GET', originalUrl: '/a', headers: {} },
        response,
        async () => {
          result = await traceMethod('S', 'm', () => 42, { sink });
          resolve();
        },
      );
    });
    expect(result).toBe(42);
  });

  it('still records a span when the method throws, and rethrows', async () => {
    const response = fakeResponse();
    let thrown: unknown;
    await new Promise<void>((resolve) => {
      flowlensHttp({ sink })(
        { method: 'GET', originalUrl: '/a', headers: {} },
        response,
        async () => {
          try {
            await traceMethod(
              'S',
              'boom',
              () => {
                throw new Error('nope');
              },
              { sink },
            );
          } catch (error) {
            thrown = error;
          }
          resolve();
        },
      );
    });
    expect((thrown as Error).message).toBe('nope');
    expect(spans().some((s) => s.name === 'S.boom')).toBe(true);
  });

  it('does nothing outside a request', async () => {
    // No context means no trace to attach to; the function still runs.
    expect(await traceMethod('S', 'm', () => 'value', { sink })).toBe('value');
    expect(spans()).toHaveLength(0);
  });
});

describe('flowlensMongoose', () => {
  /** Captures the hooks a Mongoose schema would have registered. */
  function fakeSchema() {
    const hooks: Array<{ phase: 'pre' | 'post'; name: string; fn: (...args: unknown[]) => void }> =
      [];
    return {
      hooks,
      pre(name: string, _options: unknown, fn: (...args: unknown[]) => void) {
        hooks.push({ phase: 'pre', name, fn });
        return this;
      },
      post(name: string, _options: unknown, fn: (...args: unknown[]) => void) {
        hooks.push({ phase: 'post', name, fn });
        return this;
      },
      find(name: string, phase: 'pre' | 'post') {
        return hooks.find((hook) => hook.name === name && hook.phase === phase)?.fn;
      },
    };
  }

  it('registers hooks for query and document operations', () => {
    const schema = fakeSchema();
    flowlensMongoose({ sink })(schema as never);
    const names = new Set(schema.hooks.map((hook) => hook.name));
    expect(names.has('find')).toBe(true);
    expect(names.has('findOneAndUpdate')).toBe(true);
    expect(names.has('deleteMany')).toBe(true);
    expect(names.has('save')).toBe(true);
    // Every operation gets both halves, or the duration cannot be measured.
    expect(schema.hooks.filter((h) => h.phase === 'pre').length).toBe(
      schema.hooks.filter((h) => h.phase === 'post').length,
    );
  });

  it('writes a db span with the collection and operation', async () => {
    const schema = fakeSchema();
    flowlensMongoose({ sink })(schema as never);
    const response = fakeResponse();

    await new Promise<void>((resolve) => {
      flowlensHttp({ sink })(
        { method: 'GET', originalUrl: '/api/users', headers: {} },
        response,
        () => {
          // What Mongoose passes as `this` on a query hook.
          const query = { mongooseCollection: { name: 'users' } };
          schema.find('find', 'pre')?.call(query);
          schema.find('find', 'post')?.call(query, []);
          resolve();
        },
      );
    });

    const db = spans().find((s) => s.kind === 'db');
    expect(db?.name).toBe('users.find');
    expect(db?.attrs?.collection).toBe('users');
    expect(db?.attrs?.operation).toBe('find');
    expect(db?.attrs?.driver).toBe('mongoose');
  });

  it('parents the query to the request that caused it', async () => {
    const schema = fakeSchema();
    flowlensMongoose({ sink })(schema as never);
    const response = fakeResponse();

    await new Promise<void>((resolve) => {
      flowlensHttp({ sink })(
        { method: 'POST', originalUrl: '/api/users', headers: {} },
        response,
        () => {
          const query = { mongooseCollection: { name: 'users' } };
          schema.find('updateOne', 'pre')?.call(query);
          schema.find('updateOne', 'post')?.call(query, {});
          resolve();
        },
      );
    });
    response.finish();

    const written = spans();
    const db = written.find((s) => s.kind === 'db');
    const server = written.find((s) => s.kind === 'http-server');
    expect(db?.traceId).toBe(server?.traceId);
    expect(db?.parentSpanId).toBe(server?.spanId);
  });

  it('reads the collection name from a document hook', async () => {
    const schema = fakeSchema();
    flowlensMongoose({ sink })(schema as never);

    await new Promise<void>((resolve) => {
      flowlensHttp({ sink })(
        { method: 'POST', originalUrl: '/api/users', headers: {} },
        fakeResponse(),
        () => {
          // Documents expose it as `this.collection.name`.
          const document = { collection: { name: 'users' } };
          schema.find('save', 'pre')?.call(document);
          schema.find('save', 'post')?.call(document, {});
          resolve();
        },
      );
    });

    expect(spans().find((s) => s.kind === 'db')?.name).toBe('users.save');
  });

  it('skips ignored collections', async () => {
    const schema = fakeSchema();
    flowlensMongoose({ sink, ignoreCollections: ['sessions'] })(schema as never);

    await new Promise<void>((resolve) => {
      flowlensHttp({ sink })(
        { method: 'GET', originalUrl: '/a', headers: {} },
        fakeResponse(),
        () => {
          const query = { mongooseCollection: { name: 'sessions' } };
          schema.find('find', 'pre')?.call(query);
          schema.find('find', 'post')?.call(query, []);
          resolve();
        },
      );
    });

    expect(spans().filter((s) => s.kind === 'db')).toHaveLength(0);
  });

  it('records nothing for a query outside a request', () => {
    const schema = fakeSchema();
    flowlensMongoose({ sink })(schema as never);
    const query = { mongooseCollection: { name: 'users' } };
    schema.find('find', 'pre')?.call(query);
    schema.find('find', 'post')?.call(query, []);
    // A background job with no trace context produces no orphan spans.
    expect(spans()).toHaveLength(0);
  });
});

/**
 * The contract that matters: spans this tracer produces must be mergeable by
 * core. Both halves are tested separately, so this checks they still agree.
 */
describe('tracer output merges into a scanned graph', () => {
  it('confirms a statically-found route from a recorded request', async () => {
    const schema = fakeSchema2();
    flowlensMongoose({ sink })(schema as never);
    const response = fakeResponse(201);

    await new Promise<void>((resolve) => {
      flowlensHttp({ sink })(
        { method: 'POST', originalUrl: '/api/customers', headers: {} },
        response,
        async () => {
          await traceMethod(
            'CustomersService',
            'create',
            async () => {
              const query = { mongooseCollection: { name: 'customers' } };
              schema.find('updateOne', 'pre')?.call(query);
              schema.find('updateOne', 'post')?.call(query, {});
            },
            { sink },
          );
          resolve();
        },
      );
    });
    response.finish();

    const result = scan({ root: EXAMPLE_ROOT });
    const merge = mergeRuntimeTrace(result.graph, spans());

    expect(merge.matched).toBeGreaterThan(0);
    const route = result.graph.nodesOfKind('route').find((n) => n.label === 'POST /customers');
    expect(route?.evidence).toBe('confirmed');
    expect(route?.timing?.count).toBe(1);

    const flow = resolveFlows(result.graph).find((f) => f.label === 'Create Customer');
    expect(flow?.evidence).toBe('confirmed');
  });

  function fakeSchema2() {
    const hooks: Array<{ phase: 'pre' | 'post'; name: string; fn: (...args: unknown[]) => void }> =
      [];
    return {
      hooks,
      pre(name: string, _o: unknown, fn: (...args: unknown[]) => void) {
        hooks.push({ phase: 'pre', name, fn });
        return this;
      },
      post(name: string, _o: unknown, fn: (...args: unknown[]) => void) {
        hooks.push({ phase: 'post', name, fn });
        return this;
      },
      find(name: string, phase: 'pre' | 'post') {
        return hooks.find((h) => h.name === name && h.phase === phase)?.fn;
      },
    };
  }
});

function event(overrides: Partial<TraceEvent>): TraceEvent {
  return {
    v: 1,
    traceId: 'trace',
    spanId: 'span',
    kind: 'http-server',
    name: 'GET /x',
    startedAt: 1_735_000_000_000,
    durationMs: 1,
    ...overrides,
  };
}
