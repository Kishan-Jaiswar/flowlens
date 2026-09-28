import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { Server, createServer, request as httpRequest } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  SPAN_HEADER,
  TRACE_HEADER,
  TraceSink,
  currentContext,
  installServerTracing,
  traceDb,
  withContext,
  type TraceEvent,
} from '@flowslens/runtime';
import { parseTraceFile } from '@flowslens/core';

/**
 * What a Next.js App Router app on the native MongoDB driver needs, shipped in
 * the package instead of hand-written in every app: request tracing with no
 * middleware chain, a shared trace context whichever bundle loads it, and the
 * raw driver traced the way Mongoose already was. Proven first as app-side
 * glue in a real Next 16 + Atlas app; these tests pin the same behaviour with
 * a real HTTP server and a driver-shaped fake.
 */

let temp: string;
let sink: TraceSink;
const traceFile = () => join(temp, 'trace.jsonl');

function spans(): TraceEvent[] {
  sink.flush();
  return existsSync(traceFile()) ? parseTraceFile(readFileSync(traceFile(), 'utf8')) : [];
}

beforeEach(() => {
  temp = mkdtempSync(join(tmpdir(), 'flowlens-next-'));
  sink = new TraceSink({ file: traceFile(), batchSize: 1 });
});

afterEach(() => {
  sink.close();
  rmSync(temp, { recursive: true, force: true });
});

/**
 * Shaped like the driver where it matters: private fields, so a proxy that
 * calls a method with the wrong `this` throws exactly as the real one does.
 */
class FakeCursor {
  #rows: unknown[];
  constructor(rows: unknown[]) {
    this.#rows = rows;
  }
  sort(): this {
    return this;
  }
  limit(): this {
    return this;
  }
  async toArray(): Promise<unknown[]> {
    return this.#rows;
  }
}

class FakeCollection {
  #name: string;
  constructor(name: string) {
    this.#name = name;
  }
  get collectionName(): string {
    return this.#name;
  }
  find(): FakeCursor {
    return new FakeCursor([{ name: 'Paracetamol' }]);
  }
  async updateOne(): Promise<{ modifiedCount: number }> {
    return { modifiedCount: 1 };
  }
  async deleteOne(): Promise<never> {
    throw new Error('not allowed');
  }
}

class FakeDb {
  #name = 'app';
  get databaseName(): string {
    return this.#name;
  }
  collection(name: string): FakeCollection {
    return new FakeCollection(name);
  }
}

describe('traceDb — the native MongoDB driver', () => {
  const context = { traceId: 't1', spanId: 'server-span' };

  it('records one span per operation, under the request that ran it', async () => {
    const db = traceDb(new FakeDb(), { sink });
    await withContext(context, async () => {
      const medicines = db.collection('medicines');
      await medicines.updateOne();
      await medicines.find().sort().limit().toArray();
    });
    const recorded = spans();
    expect(recorded.map((span) => span.name)).toEqual(['medicines.updateOne', 'medicines.find']);
    for (const span of recorded) {
      expect(span.kind).toBe('db');
      expect(span.traceId).toBe('t1');
      expect(span.parentSpanId).toBe('server-span');
      expect(span.attrs?.['driver']).toBe('mongodb');
    }
  });

  it('keeps the driver working: private fields, chaining, and its own answers', async () => {
    const db = traceDb(new FakeDb(), { sink });
    expect(db.databaseName).toBe('app');
    const rows = await withContext(context, () =>
      db.collection('medicines').find().sort().toArray(),
    );
    expect(rows).toEqual([{ name: 'Paracetamol' }]);
  });

  it('records a failed operation and still throws it', async () => {
    const db = traceDb(new FakeDb(), { sink });
    await expect(
      withContext(context, () => db.collection('medicines').deleteOne()),
    ).rejects.toThrow('not allowed');
    expect(spans()[0]?.attrs?.['error']).toBe('not allowed');
  });

  it('writes nothing outside a request — start-up indexes, a background worker', async () => {
    const db = traceDb(new FakeDb(), { sink });
    await db.collection('medicines').updateOne();
    expect(spans()).toEqual([]);
  });

  it('is the untouched handle in production', () => {
    const previous = process.env['NODE_ENV'];
    process.env['NODE_ENV'] = 'production';
    try {
      const db = new FakeDb();
      expect(traceDb(db, { sink })).toBe(db);
    } finally {
      process.env['NODE_ENV'] = previous;
    }
  });
});

describe('installServerTracing — requests with no middleware chain', () => {
  let server: Server | undefined;
  let uninstall: (() => void) | undefined;

  afterEach(async () => {
    uninstall?.();
    uninstall = undefined;
    await new Promise<void>((done) => (server ? server.close(() => done()) : done()));
    server = undefined;
  });

  /** A real server whose handler queries the traced db, as a route handler does. */
  async function start(): Promise<number> {
    const db = traceDb(new FakeDb(), { sink });
    server = createServer((req, res) => {
      void (async () => {
        const inside = currentContext();
        if (req.url?.startsWith('/api/')) await db.collection('medicines').updateOne();
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ traced: Boolean(inside) }));
      })();
    });
    await new Promise<void>((done) => server!.listen(0, '127.0.0.1', () => done()));
    return (server!.address() as AddressInfo).port;
  }

  function get(port: number, path: string, headers: Record<string, string> = {}) {
    return new Promise<{ status: number; body: { traced: boolean } }>((done, fail) => {
      const req = httpRequest({ host: '127.0.0.1', port, path, headers }, (res) => {
        let text = '';
        res.on('data', (chunk) => (text += chunk));
        res.on('end', () => done({ status: res.statusCode ?? 0, body: JSON.parse(text) }));
      });
      req.on('error', fail);
      req.end();
    });
  }

  it('opens a span per API request and nests its queries under it', async () => {
    uninstall = installServerTracing({ sink });
    const port = await start();
    const answer = await get(port, '/api/medicines/med_1?x=1', {
      [TRACE_HEADER]: 'browser-trace',
      [SPAN_HEADER]: 'click-span',
    });
    expect(answer.body.traced).toBe(true);

    // The response is sent before the span's `finish` listener runs.
    await new Promise((done) => setTimeout(done, 20));
    const recorded = spans();
    const request = recorded.find((span) => span.kind === 'http-server')!;
    const query = recorded.find((span) => span.kind === 'db')!;
    expect(request.name).toBe('GET /api/medicines/med_1');
    expect(request.traceId).toBe('browser-trace');
    expect(request.parentSpanId).toBe('click-span');
    expect(request.attrs?.['statusCode']).toBe(200);
    expect(query.traceId).toBe('browser-trace');
    expect(query.parentSpanId).toBe(request.spanId);
  });

  it('leaves page navigations alone', async () => {
    uninstall = installServerTracing({ sink });
    const port = await start();
    const answer = await get(port, '/medicines');
    expect(answer.body.traced).toBe(false);
    expect(spans()).toEqual([]);
  });

  it('patches once however often it is called — dev HMR re-runs it', async () => {
    uninstall = installServerTracing({ sink });
    expect(installServerTracing({ sink })).toBe(uninstall);
    const port = await start();
    await get(port, '/api/ping');
    await new Promise((done) => setTimeout(done, 20));
    expect(spans().filter((span) => span.kind === 'http-server')).toHaveLength(1);
  });
});

describe('one trace context per process', () => {
  /**
   * Turbopack compiles `instrumentation.ts` and the route handlers into
   * separate module graphs, so the package is evaluated twice. With a
   * module-scoped store the request tracer and the database tracer each had
   * their own, and no query ever nested under its request.
   */
  it('is shared by two separately loaded copies of the package', async () => {
    const url = new URL('../packages/runtime/dist/context.js', import.meta.url).href;
    const first = (await import(`${url}?copy=1`)) as typeof import('@flowslens/runtime');
    const second = (await import(`${url}?copy=2`)) as typeof import('@flowslens/runtime');
    expect(first).not.toBe(second);
    const seen = first.withContext({ traceId: 'shared', spanId: 's' }, () =>
      second.currentContext(),
    );
    expect(seen?.traceId).toBe('shared');
  });
});

describe('@flowslens/runtime/next', () => {
  it('installs request tracing on the Node runtime, and nothing on Edge or in production', async () => {
    const { register } = await import('@flowslens/runtime/next');
    const untouched = Server.prototype.emit;
    const saved = { runtime: process.env['NEXT_RUNTIME'], env: process.env['NODE_ENV'] };
    try {
      process.env['NEXT_RUNTIME'] = 'edge';
      await register();
      expect(Server.prototype.emit).toBe(untouched);

      process.env['NEXT_RUNTIME'] = 'nodejs';
      process.env['NODE_ENV'] = 'production';
      await register();
      expect(Server.prototype.emit).toBe(untouched);

      process.env['NODE_ENV'] = 'development';
      await register();
      expect(Server.prototype.emit).not.toBe(untouched);
    } finally {
      process.env['NEXT_RUNTIME'] = saved.runtime;
      process.env['NODE_ENV'] = saved.env;
      // Already installed, so this hands back the uninstaller rather than patching again.
      installServerTracing()();
    }
    expect(Server.prototype.emit).toBe(untouched);
  });
});
