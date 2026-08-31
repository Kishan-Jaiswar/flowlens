import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(here, '..');
const BIN = join(REPO, 'packages', 'cli', 'bin', 'flowlens.mjs');
const PROJECT = join(REPO, 'examples', 'crud');

/**
 * The dashboard and its API, exercised through the real CLI.
 *
 * `flowlens serve` is what a user actually runs, so it is tested as a process
 * rather than by importing the handler: that covers argument parsing, the bin
 * entry point, static asset resolution and the JSON API in one go. It is the
 * only part of the project that is browser code, and it had no coverage at all.
 */
const PORT = 4181;
const base = `http://127.0.0.1:${PORT}`;

/**
 * Artifacts go to a temp directory, explicitly.
 *
 * FlowLens defaults to a machine-local cache outside the project, so a test that
 * looked in `examples/crud/.flowlens` would find nothing. Naming the paths here
 * keeps the test hermetic — it neither reads nor pollutes the real user cache.
 */
const ARTIFACTS = mkdtempSync(join(tmpdir(), 'flowlens-server-test-'));
const GRAPH = join(ARTIFACTS, 'graph.json');
const TRACE = join(ARTIFACTS, 'trace.jsonl');

let server: ChildProcess;

async function get(path: string, init?: RequestInit) {
  return fetch(`${base}${path}`, init);
}

beforeAll(async () => {
  // A stale trace from another test run would change the evidence assertions.
  rmSync(TRACE, { force: true });

  const argv = [BIN, 'serve', PROJECT, '--port', String(PORT), '-g', GRAPH, '--trace', TRACE];
  server = spawn(process.execPath, argv, {
    cwd: REPO,
    stdio: 'ignore',
  });

  // Poll rather than sleep: the first request triggers a full scan.
  const deadline = Date.now() + 30_000;
  for (;;) {
    try {
      const response = await get('/');
      if (response.ok) return;
    } catch {
      // not listening yet
    }
    if (Date.now() > deadline) throw new Error('server did not start');
    await new Promise((r) => setTimeout(r, 200));
  }
}, 60_000);

afterAll(() => {
  server?.kill('SIGTERM');
  rmSync(ARTIFACTS, { recursive: true, force: true });
});

describe('static assets', () => {
  it('serves the dashboard shell', async () => {
    const response = await get('/');
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/html');
    const html = await response.text();
    expect(html).toContain('FlowLens');
    expect(html).toContain('/app.js');
  });

  it('serves the script and stylesheet with correct content types', async () => {
    const script = await get('/app.js');
    expect(script.status).toBe(200);
    expect(script.headers.get('content-type')).toContain('javascript');

    const styles = await get('/styles.css');
    expect(styles.status).toBe(200);
    expect(styles.headers.get('content-type')).toContain('text/css');
  });

  it('does not serve files from outside the dashboard directory', async () => {
    // Falls back to the shell rather than leaking the repository.
    for (const attempt of ['/../../package.json', '/%2e%2e/%2e%2e/package.json']) {
      const response = await get(attempt);
      const body = await response.text();
      expect(body).not.toContain('"flowlens-monorepo"');
      expect(body).not.toContain('"dependencies"');
    }
  });
});

describe('graph API', () => {
  it('returns the serialised graph', async () => {
    const graph = await (await get('/api/graph')).json();
    expect(graph.nodes.length).toBeGreaterThan(50);
    expect(graph.edges.length).toBeGreaterThan(50);
    expect(graph.meta.filesAnalyzed).toBeGreaterThan(0);
    // Paths stay relative so a graph survives being copied between machines.
    for (const node of graph.nodes.slice(0, 40)) {
      if (node.source?.file) expect(node.source.file.startsWith('/')).toBe(false);
    }
  });

  it('returns feature flows', async () => {
    const flows = await (await get('/api/flows')).json();
    expect(Array.isArray(flows)).toBe(true);
    const labels = flows.map((flow: { label: string }) => flow.label);
    expect(labels).toContain('Submit Order');

    const submit = flows.find((flow: { label: string }) => flow.label === 'Submit Order');
    expect(submit.steps.length).toBeGreaterThan(5);
    expect(submit.risk.level).toBeTypeOf('string');
    expect(submit.endpoints).toContain('POST /orders');
  });

  it('includes local-only actions when asked', async () => {
    const all = await (await get('/api/flows?all=1')).json();
    const backendOnly = await (await get('/api/flows')).json();
    expect(all.length).toBeGreaterThanOrEqual(backendOnly.length);
  });

  it('returns doctor findings', async () => {
    const doctor = await (await get('/api/doctor')).json();
    // The example ships a deliberate PUT/PATCH mismatch.
    expect(doctor.brokenCalls.map((c: { label: string }) => c.label)).toContain(
      'PUT /customers/:param/archive',
    );
    expect(doctor.sharedWrites.map((s: { collection: string }) => s.collection)).toContain(
      'customers',
    );
    expect(Array.isArray(doctor.deadEndpoints)).toBe(true);
  });

  it('answers impact queries for a node', async () => {
    const graph = await (await get('/api/graph')).json();
    const method = graph.nodes.find(
      (node: { kind: string; label: string }) =>
        node.kind === 'method' && node.label === 'AuditService.record',
    );
    expect(method).toBeDefined();

    const impact = await (await get(`/api/impact?node=${encodeURIComponent(method.id)}`)).json();
    expect(impact.blastRadius).toBeGreaterThan(0);
    expect(impact.affectedFlows.length).toBeGreaterThan(1);
  });

  it('rejects an impact query with no node', async () => {
    const response = await get('/api/impact');
    expect(response.status).toBe(400);
    expect((await response.json()).error).toBeTypeOf('string');
  });

  it('renders a feature document as markdown', async () => {
    const response = await get('/api/document?flow=orderform-submit-order');
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('markdown');
    const document = await response.text();
    expect(document).toContain('# Submit Order');
    expect(document).toContain('## Execution path');
  });

  it('404s an unknown flow', async () => {
    const response = await get('/api/document?flow=no-such-flow');
    expect(response.status).toBe(404);
  });
});

describe('span collection', () => {
  it('accepts spans from the browser tracer and appends them', async () => {
    const spans = [
      {
        v: 1,
        traceId: 'server-test-1',
        spanId: 'ui-1',
        kind: 'ui-action',
        name: 'Submit Order',
        startedAt: 1_735_000_000_000,
        durationMs: 3,
        attrs: { component: 'OrderForm' },
      },
      {
        v: 1,
        traceId: 'server-test-1',
        spanId: 'client-1',
        parentSpanId: 'ui-1',
        kind: 'http-client',
        name: 'POST /api/orders',
        startedAt: 1_735_000_000_003,
        durationMs: 120,
        attrs: { httpMethod: 'POST', path: '/api/orders', statusCode: 201 },
      },
    ];

    const response = await get('/__flowlens/spans', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(spans),
    });

    expect(response.status).toBe(200);
    expect((await response.json()).received).toBe(2);

    expect(existsSync(TRACE)).toBe(true);
    expect(readFileSync(TRACE, 'utf8')).toContain('server-test-1');
  });

  it('rejects a malformed payload without dying', async () => {
    const response = await get('/__flowlens/spans', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: 'not json at all',
    });
    expect(response.status).toBe(400);
    // The server is still up afterwards.
    expect((await get('/api/graph')).ok).toBe(true);
  });

  it('answers CORS preflight, since the tracer runs on another origin', async () => {
    const response = await get('/__flowlens/spans', { method: 'OPTIONS' });
    expect(response.status).toBe(204);
    expect(response.headers.get('access-control-allow-origin')).toBe('*');
    expect(response.headers.get('access-control-allow-methods')).toContain('POST');
  });
});

describe('rescan', () => {
  it('rebuilds the graph on demand', async () => {
    const response = await get('/api/rescan', { method: 'POST' });
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.ok).toBe(true);
    expect(body.nodes).toBeGreaterThan(50);
  });

  it('folds the collected spans into the graph after a rescan', async () => {
    // The spans posted earlier are on disk, so a rescan should now find
    // runtime evidence for the route they exercised.
    await get('/api/rescan', { method: 'POST' });
    const flows = await (await get('/api/flows')).json();
    const submit = flows.find((flow: { label: string }) => flow.label === 'Submit Order');
    expect(['runtime', 'confirmed']).toContain(submit.evidence);
  });
});
