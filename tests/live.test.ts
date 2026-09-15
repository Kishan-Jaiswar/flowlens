import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ids, mergeRuntimeTrace, parseTraceFile, scan, type ScanResult } from '@flowslens/core';
import { TraceSink, flowlensHttp, traceMethod } from '@flowslens/runtime';

/**
 * The tracer against a live application.
 *
 * Every other tracer test drives the middleware and the sink directly, or feeds
 * the merge a span list written by hand. Those prove the contract; they cannot
 * prove the thing the roadmap actually asks for, because a hand-written span is
 * exactly the span the code under test expects.
 *
 * So this boots a real `node:http` server with the real middleware in front of
 * it, makes real requests over a real socket, lets the real sink write a real
 * JSONL file, and merges that file into a real scan. Nothing here is a stand-in
 * except the database, which is still the open item: `flowlensMongoose` needs a
 * live Mongo to be exercised honestly, and this suite must run with no server
 * of its own and no network.
 */
const project = mkdtempSync(join(tmpdir(), 'flowlens-live-'));
const traceFile = join(project, 'trace.jsonl');

mkdirSync(join(project, 'web'), { recursive: true });
mkdirSync(join(project, 'api'), { recursive: true });

writeFileSync(
  join(project, 'web', 'OrderForm.tsx'),
  `import React, { useState } from 'react';
   import axios from 'axios';

   export function OrderForm() {
     const [total, setTotal] = useState(0);
     const submitOrder = async () => {
       await axios.post('/api/orders', { total });
     };
     return <button onClick={submitOrder}>Submit Order</button>;
   }`,
  'utf8',
);

writeFileSync(
  join(project, 'api', 'orders.js'),
  `const express = require('express');
   const mongoose = require('mongoose');

   const Order = mongoose.model('Order', new mongoose.Schema({ total: Number }));
   const router = express.Router();

   router.post('/orders', async (req, res) => {
     const order = await Order.create({ total: req.body.total });
     res.json(order);
   });

   module.exports = router;`,
  'utf8',
);

/** The app under test: a real server, holding a real service. */
class OrdersService {
  async create(total: number): Promise<{ id: string; total: number }> {
    // Real work, so the span has a duration that was actually measured.
    return traceMethod(
      'OrdersService',
      'create',
      async () => {
        await new Promise((resolve) => setTimeout(resolve, 12));
        return { id: 'order-1', total };
      },
      { sink },
    );
  }
}

const sink = new TraceSink({ file: traceFile, batchSize: 1, flushIntervalMs: 1 });
const middleware = flowlensHttp({ sink });
const service = new OrdersService();

const server = createServer((request: IncomingMessage, response: ServerResponse) => {
  // The middleware is framework-agnostic on purpose, so node:http drives it
  // directly — same signature Express and Nest hand it.
  middleware(request, response, () => {
    void (async () => {
      if (request.method === 'POST' && request.url === '/orders') {
        const order = await service.create(99);
        response.writeHead(201, { 'content-type': 'application/json' });
        response.end(JSON.stringify(order));
        return;
      }
      if (request.url === '/health') {
        response.writeHead(200);
        response.end('ok');
        return;
      }
      response.writeHead(404);
      response.end();
    })();
  });
});

let base = '';
let result: ScanResult;

beforeAll(async () => {
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  base = `http://127.0.0.1:${port}`;

  // Real requests, over a real socket.
  const created = await fetch(`${base}/orders`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ total: 99 }),
  });
  expect(created.status).toBe(201);
  await created.json();

  await fetch(`${base}/orders`, { method: 'POST', body: '{}' });
  // Ignored by the tracer, and asserted below.
  await fetch(`${base}/health`);

  /**
   * Wait for the server side to finish, not for the client.
   *
   * The span is written from the response's `finish` event, which fires after
   * `fetch` has already resolved on this side of the socket — so closing the
   * sink straight after the last request raced it and produced an empty file.
   * Polling the real artifact is the honest wait: it ends when the thing being
   * asserted actually exists.
   */
  await waitFor(() => spans().filter((e) => e.kind === 'method').length >= 1);
  sink.close();
  result = scan({ root: project });
});

/** The spans the live server has written so far. */
function spans() {
  try {
    return parseTraceFile(readFileSync(traceFile, 'utf8'));
  } catch {
    // The server has not written anything yet.
    return [];
  }
}

/** Poll a condition rather than sleeping a guessed number of milliseconds. */
async function waitFor(condition: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('timed out waiting for the server to write its spans');
}

afterAll(async () => {
  await new Promise<void>((done) => server.close(() => done()));
});

describe('the tracer against a live server', () => {
  it('wrote a trace file the parser can read', () => {
    const events = spans();
    expect(events.length).toBeGreaterThan(0);
    expect(events.every((event) => event.v === 1)).toBe(true);
  });

  it('recorded one server span per real request, and skipped the health check', () => {
    const events = spans();
    const server = events.filter((event) => event.kind === 'http-server');
    expect(server).toHaveLength(2);
    expect(events.some((event) => String(event.name).includes('/health'))).toBe(false);
  });

  it('measured a duration it did not invent', () => {
    const events = spans();
    const method = events.find((event) => event.kind === 'method');
    expect(method).toBeDefined();
    // The handler really did sleep 12ms.
    expect(method!.durationMs).toBeGreaterThanOrEqual(10);
    const serverSpan = events.find((event) => event.kind === 'http-server');
    expect(serverSpan!.durationMs).toBeGreaterThanOrEqual(method!.durationMs);
  });

  it('nests the method span inside the request that caused it', () => {
    const events = spans();
    const serverSpans = new Set(
      events.filter((event) => event.kind === 'http-server').map((event) => event.spanId),
    );
    const method = events.find((event) => event.kind === 'method');
    expect(method?.parentSpanId).toBeDefined();
    expect(serverSpans.has(method!.parentSpanId!)).toBe(true);
    expect(events.filter((event) => event.kind === 'method').every((event) => event.traceId)).toBe(
      true,
    );
  });

  it('records the status code the server really returned', () => {
    const events = spans();
    const codes = events
      .filter((event) => event.kind === 'http-server')
      .map((event) => event.attrs?.['statusCode']);
    expect(codes).toContain(201);
  });
});

describe('merging a live trace into a real scan', () => {
  it('upgrades the route the requests actually hit to confirmed', () => {
    const events = spans();
    const merge = mergeRuntimeTrace(result.graph, events);
    expect(merge.spans).toBe(events.length);
    expect(merge.matched).toBeGreaterThan(0);

    const route = result.graph.node(ids.route('POST', '/orders'));
    expect(route).toBeDefined();
    expect(route?.evidence).toBe('confirmed');
  });

  it('carries the measured timings onto the graph', () => {
    const route = result.graph.node(ids.route('POST', '/orders'));
    expect(route?.timing?.count).toBe(2);
    expect(route?.timing?.avgMs).toBeGreaterThan(0);
    expect(route?.observations).toBe(2);
  });

  it('leaves the parts of the graph nothing ran as static', () => {
    const untouched = result.graph
      .nodesOfKind('ui-action')
      .every((node) => node.evidence === 'static');
    expect(untouched).toBe(true);
  });
});
