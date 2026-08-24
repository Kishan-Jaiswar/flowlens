import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { dirname, extname, join, normalize, resolve, sep } from 'node:path';
import {
  analyzeImpact,
  findBrokenCalls,
  findDeadEndpoints,
  findSharedWrites,
  mergeRuntimeTrace,
  parseTraceFile,
  renderFeatureDocument,
  resolveFlows,
  scan,
  type FlowGraph,
} from '@flowlens/core';
import { dashboardDir, graphPath, saveGraph, tracePath } from '../paths.js';
import { color } from '../ui.js';

export interface ServeArgs {
  root: string;
  /** Sibling repositories scanned into the same graph. */
  extraRoots?: string[];
  port?: number;
  host?: string;
  graph?: string;
  trace?: string;
  open?: boolean;
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

/**
 * `flowlens serve` — the dashboard.
 *
 * A plain Node http server: it holds the graph in memory, re-scans on demand,
 * and accepts spans from the browser tracer. Binds to localhost only, and never
 * connects out to anything.
 */
export function runServe(args: ServeArgs): number {
  const root = resolve(args.root);
  const port = args.port ?? 4177;
  const host = args.host ?? '127.0.0.1';
  const staticDir = dashboardDir();

  let graph = buildGraph(root, args);
  let lastScan = new Date();

  const server = createServer((request, response) => {
    const url = new URL(request.url ?? '/', `http://${request.headers.host ?? 'localhost'}`);
    const path = url.pathname;

    // The tracer runs on the app's origin (localhost:3000), so it needs CORS.
    if (request.method === 'OPTIONS') {
      response.writeHead(204, {
        'access-control-allow-origin': '*',
        'access-control-allow-methods': 'GET, POST, OPTIONS',
        'access-control-allow-headers': 'content-type',
        'access-control-max-age': '86400',
      });
      response.end();
      return;
    }

    // The browser tracer posts spans here.
    if (path === '/__flowlens/spans' && request.method === 'POST') {
      collectSpans(request, response, root, args);
      return;
    }

    if (path === '/api/graph') {
      sendJson(response, {
        ...graph.toJSON(),
        generatedAt: lastScan.toISOString(),
      });
      return;
    }

    if (path === '/api/flows') {
      sendJson(
        response,
        resolveFlows(graph, { includeLocalOnly: url.searchParams.get('all') === '1' }),
      );
      return;
    }

    if (path === '/api/doctor') {
      sendJson(response, {
        brokenCalls: findBrokenCalls(graph).map(summarize),
        deadEndpoints: findDeadEndpoints(graph).map(summarize),
        sharedWrites: findSharedWrites(graph),
      });
      return;
    }

    if (path === '/api/impact') {
      const nodeId = url.searchParams.get('node');
      if (!nodeId) {
        sendJson(response, { error: 'node query parameter required' }, 400);
        return;
      }
      sendJson(response, analyzeImpact(graph, nodeId) ?? { error: 'unknown node' });
      return;
    }

    if (path === '/api/document') {
      const flowId = url.searchParams.get('flow');
      const flow = resolveFlows(graph, { includeLocalOnly: true }).find((f) => f.id === flowId);
      if (!flow) {
        sendJson(response, { error: 'unknown flow' }, 404);
        return;
      }
      response.writeHead(200, { 'content-type': 'text/markdown; charset=utf-8' });
      response.end(renderFeatureDocument(graph, flow));
      return;
    }

    if (path === '/api/rescan' && request.method === 'POST') {
      graph = buildGraph(root, args);
      lastScan = new Date();
      sendJson(response, { ok: true, nodes: graph.nodeCount, edges: graph.edgeCount });
      return;
    }

    if (!staticDir) {
      response.writeHead(500, { 'content-type': 'text/plain' });
      response.end('Dashboard assets not found. Expected apps/dashboard/public/index.html.');
      return;
    }

    serveStatic(staticDir, path, response);
  });

  server.listen(port, host, () => {
    const url = `http://${host}:${port}`;
    process.stdout.write(
      `\n${color.bold('FlowLens')} dashboard on ${color.cyan(url)}\n` +
        `${color.gray('project:')} ${root}\n` +
        `${color.gray('graph:')}   ${graph.nodeCount} nodes, ${graph.edgeCount} edges\n` +
        `${color.gray('spans:')}   POST ${url}/__flowlens/spans\n\n` +
        `${color.gray('Ctrl+C to stop')}\n`,
    );
  });

  server.on('error', (error) => {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'EADDRINUSE') {
      process.stderr.write(
        `${color.red('error')} port ${port} is busy. Try \`flowlens serve ${args.root} --port ${port + 1}\`\n`,
      );
    } else {
      process.stderr.write(`${color.red('error')} ${String(error)}\n`);
    }
    process.exit(1);
  });

  return 0;
}

/** Scan, then fold in any trace file that already exists. */
function buildGraph(root: string, args: ServeArgs): FlowGraph {
  const file = graphPath(root, args.graph);
  const result = scan({
    root,
    ...(args.extraRoots ? { extraRoots: args.extraRoots } : {}),
  });
  const traceFile = tracePath(root, args.trace);
  if (existsSync(traceFile)) {
    mergeRuntimeTrace(result.graph, parseTraceFile(readFileSync(traceFile, 'utf8')));
  }
  saveGraph(file, result.graph);
  return result.graph;
}

/** Accept a batch of spans from the browser tracer and append them to the trace file. */
function collectSpans(
  request: IncomingMessage,
  response: ServerResponse,
  root: string,
  args: ServeArgs,
): void {
  const chunks: Buffer[] = [];
  let size = 0;
  request.on('data', (chunk: Buffer) => {
    size += chunk.length;
    if (size > 1_000_000) {
      request.destroy();
      return;
    }
    chunks.push(chunk);
  });
  request.on('end', () => {
    try {
      const payload = JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
      const spans = Array.isArray(payload) ? payload : [payload];
      const file = tracePath(root, args.trace);
      mkdirSync(dirname(file), { recursive: true });
      appendFileSync(file, `${spans.map((span) => JSON.stringify(span)).join('\n')}\n`, 'utf8');
      sendJson(response, { ok: true, received: spans.length });
    } catch {
      sendJson(response, { error: 'invalid span payload' }, 400);
    }
  });
}

function serveStatic(dir: string, path: string, response: ServerResponse): void {
  const relative = path === '/' ? 'index.html' : path.replace(/^\/+/, '');
  // Contain the request inside the dashboard directory.
  const target = resolve(dir, normalize(relative));
  if (!target.startsWith(resolve(dir) + sep) && target !== resolve(dir, 'index.html')) {
    response.writeHead(403, { 'content-type': 'text/plain' });
    response.end('forbidden');
    return;
  }

  let file = target;
  if (existsSync(file) && statSync(file).isDirectory()) file = join(file, 'index.html');
  if (!existsSync(file)) {
    // SPA fallback
    file = join(dir, 'index.html');
    if (!existsSync(file)) {
      response.writeHead(404, { 'content-type': 'text/plain' });
      response.end('not found');
      return;
    }
  }

  response.writeHead(200, {
    'content-type': MIME[extname(file)] ?? 'application/octet-stream',
    'cache-control': 'no-store',
  });
  response.end(readFileSync(file));
}

function sendJson(response: ServerResponse, body: unknown, status = 200): void {
  const payload = JSON.stringify(body);
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
    // The tracer runs on the app's own origin (localhost:3000), not ours.
    'access-control-allow-origin': '*',
  });
  response.end(payload);
}

function summarize(node: { id: string; label: string; source?: unknown; meta?: unknown }) {
  return { id: node.id, label: node.label, source: node.source, meta: node.meta };
}
