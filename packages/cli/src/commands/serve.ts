import { spawn } from 'node:child_process';
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
import { browserTracerFile, dashboardDir, graphPath, saveGraph, tracePath } from '../paths.js';
import { color } from '../ui.js';

export interface ServeArgs {
  root: string;
  /** Sibling repositories scanned into the same graph. */
  extraRoots?: string[];
  port?: number;
  host?: string;
  graph?: string;
  trace?: string;
  /**
   * Open a browser once the server is listening.
   *
   * The CLI turns this on for an interactive terminal and off everywhere else,
   * so a scripted or CI run never tries to launch a browser.
   */
  open?: boolean;
}

const DEFAULT_PORT = 4177;

/**
 * How many ports to try before giving up.
 *
 * Only when the port was *not* asked for explicitly: a developer who typed
 * `--port 4177` wants that port, and silently moving would be worse than an
 * error. But the default being busy — a second project, or a dashboard left
 * running yesterday — should not need a flag to work around.
 */
const PORT_ATTEMPTS = 20;

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
  const requestedPort = args.port;
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

    // Serve the browser tracer itself. This is what keeps runtime tracing
    // read-only: the app being traced imports the script from here instead of
    // having a copy dropped into its own `public/` directory.
    if (path === '/__flowlens/browser.js') {
      const tracer = browserTracerFile();
      if (!tracer) {
        response.writeHead(404, { 'content-type': 'text/plain' });
        response.end('Browser tracer not built. Run `npm run build` in FlowLens.');
        return;
      }
      response.writeHead(200, {
        'content-type': 'text/javascript; charset=utf-8',
        // The app runs on its own origin, so this is always a cross-origin load.
        'access-control-allow-origin': '*',
        'cache-control': 'no-store',
      });
      response.end(readFileSync(tracer, 'utf8'));
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

  let port = requestedPort ?? DEFAULT_PORT;
  let attempt = 0;

  server.on('listening', () => {
    const url = `http://${displayHost(host)}:${port}`;
    process.stdout.write(
      `\n${color.bold('FlowLens')} dashboard on ${color.cyan(url)}\n` +
        `${color.gray('project:')} ${root}\n` +
        `${color.gray('graph:')}   ${graph.nodeCount} nodes, ${graph.edgeCount} edges\n` +
        `${color.gray('spans:')}   POST ${url}/__flowlens/spans\n` +
        `${color.gray('tracer:')}  ${url}/__flowlens/browser.js\n` +
        (requestedPort === undefined && port !== DEFAULT_PORT
          ? `${color.gray('note:')}    port ${DEFAULT_PORT} was busy, using ${port}\n`
          : '') +
        `\n${color.gray('Ctrl+C to stop')}\n`,
    );
    if (args.open === true) openBrowser(url);
  });

  server.on('error', (error) => {
    const code = (error as NodeJS.ErrnoException).code;

    // Walk up to the next port, but only if the user did not name one.
    if (code === 'EADDRINUSE' && requestedPort === undefined && attempt < PORT_ATTEMPTS) {
      attempt += 1;
      port = DEFAULT_PORT + attempt;
      server.listen(port, host);
      return;
    }

    if (code === 'EADDRINUSE') {
      process.stderr.write(
        `${color.red('error')} port ${port} is busy. Try \`flowlens serve ${args.root} --port ${port + 1}\`\n`,
      );
    } else if (code === 'EACCES') {
      process.stderr.write(
        `${color.red('error')} not allowed to listen on ${host}:${port}` +
          `${port < 1024 ? ' (ports below 1024 need elevated privileges)' : ''}\n`,
      );
    } else if (code === 'EADDRNOTAVAIL') {
      process.stderr.write(
        `${color.red('error')} no interface with address ${host}. Try \`--host 127.0.0.1\`\n`,
      );
    } else {
      process.stderr.write(`${color.red('error')} ${String(error)}\n`);
    }
    process.exit(1);
  });

  server.listen(port, host);
  return 0;
}

/** `0.0.0.0` is a valid thing to bind but not a valid thing to click. */
function displayHost(host: string): string {
  if (host === '0.0.0.0' || host === '::') return '127.0.0.1';
  // A bare IPv6 address needs brackets in a URL.
  return host.includes(':') ? `[${host}]` : host;
}

/**
 * The command that opens a URL on a given platform.
 *
 * Split out from {@link openBrowser} so the per-platform mapping can be
 * asserted without launching anything: a test that called the real opener would
 * open tabs on the developer's desktop, and could only ever check that it did
 * not throw.
 */
export function browserCommand(
  url: string,
  platform: string = process.platform,
): [string, string[]] {
  if (platform === 'win32') {
    // The empty string is `start`'s title argument — without it, a quoted URL
    // would be treated as the window title and nothing would open.
    return [process.env['ComSpec'] ?? 'cmd', ['/c', 'start', '', url]];
  }
  if (platform === 'darwin') return ['open', [url]];
  return ['xdg-open', [url]];
}

/**
 * Open the dashboard in the default browser.
 *
 * Best effort on purpose: on a headless machine, in a container, or over SSH
 * there is nothing to open, and the URL is already printed above. A failure here
 * must never take the server down with it, so every path is swallowed.
 *
 * `launch` is injectable so tests can prove that failure is swallowed without
 * spawning a real process.
 */
export function openBrowser(
  url: string,
  platform: string = process.platform,
  launch: typeof spawn = spawn,
): void {
  const [command, args] = browserCommand(url, platform);

  try {
    const child = launch(command, args, { stdio: 'ignore', detached: true });
    child.on('error', () => {
      /* no browser available — the URL is printed, that is enough */
    });
    child.unref();
  } catch {
    /* same */
  }
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
