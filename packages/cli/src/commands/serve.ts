import { spawn } from 'node:child_process';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { isIP } from 'node:net';
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
} from '@flowslens/core';
import { artifactPaths, guardArtifacts } from '../gitignore.js';
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
  /** `"gitignore": true` in the config — keep the managed block up to date. */
  gitignore?: boolean;
  /**
   * The secret that authorises span collection, and the whole API on a
   * non-loopback bind. Generated per run unless given, so the common case needs
   * no setup: `serve` prints the URLs with the token already in them.
   */
  token?: string;
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

/** Reported once per run: a warning per span batch would be its own denial of service. */
let traceLimitReported = false;

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
 * How large `trace.jsonl` may grow before the collector stops appending.
 *
 * A browser left open on a busy page posts spans indefinitely, and the endpoint
 * is reachable by anything that can talk to the port. A cap turns "fills the
 * disk overnight" into a message telling you to delete the file.
 */
export const TRACE_LIMIT_BYTES = 64 * 1024 * 1024;

/**
 * Is this bind address reachable only from this machine?
 *
 * The default is, and the security model leans on it: the API is same-origin
 * only and unauthenticated. Bind anywhere else and the token is required, since
 * "only people at this keyboard can reach it" has stopped being true.
 */
export function isLoopbackHost(host: string): boolean {
  const bare = host.replace(/^\[/, '').replace(/\]$/, '');
  return bare === 'localhost' || bare === '::1' || /^127\./.test(bare);
}

/** The hostname in a `Host` header, without the port or IPv6 brackets. */
export function hostnameOf(header: string | undefined): string | undefined {
  if (header === undefined || header === '') return undefined;
  if (header.startsWith('[')) {
    const close = header.indexOf(']');
    return close === -1 ? undefined : header.slice(1, close);
  }
  const [name] = header.split(':');
  return name === '' ? undefined : name;
}

/**
 * Reject requests addressed to this server by *name*.
 *
 * A DNS rebinding attack works like this: you visit evil.example, whose DNS
 * answer flips to 127.0.0.1 a second later. The browser now believes
 * `http://evil.example:4177` is same-origin with the dashboard, so every
 * same-origin protection below is void and the page can read your graph. The
 * defence is to insist on being addressed the way a local tool is addressed —
 * by IP literal, or by `localhost`. An attacker cannot rebind either.
 */
export function hostAllowed(header: string | undefined, boundHost: string): boolean {
  const name = hostnameOf(header);
  if (name === undefined) return false;
  if (name === 'localhost' || name === boundHost) return true;
  return isIP(name) !== 0;
}

/**
 * Same-origin check for the data API.
 *
 * `Origin` is absent on curl, on scripts, and on top-level navigation, so its
 * absence cannot mean "reject". Its *presence* is a browser telling you which
 * page is asking — and the only page allowed to ask for the graph is the
 * dashboard itself. This is what stops a random tab from POSTing to
 * `/api/rescan`, which needs no readable response to be worth doing.
 */
export function originAllowed(origin: string | undefined, hostHeader: string | undefined): boolean {
  if (origin === undefined) return true;
  if (origin === 'null' || hostHeader === undefined) return false;
  try {
    return new URL(origin).host === hostHeader;
  } catch {
    return false;
  }
}

/** Constant-time token comparison, so the port cannot be used as an oracle. */
export function tokenMatches(presented: string | undefined, expected: string): boolean {
  if (presented === undefined) return false;
  const a = Buffer.from(presented);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

function presentedToken(url: URL, request: IncomingMessage): string | undefined {
  const fromQuery = url.searchParams.get('token');
  if (fromQuery !== null) return fromQuery;
  const header = request.headers['x-flowlens-token'];
  return Array.isArray(header) ? header[0] : header;
}

function deny(response: ServerResponse, status: number, message: string): void {
  response.writeHead(status, { 'content-type': 'text/plain; charset=utf-8' });
  response.end(`${message}\n`);
}

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

  /**
   * One secret per run.
   *
   * It authorises span collection — which is a write, from another origin, and
   * therefore cannot be protected by a same-origin rule — and the whole API
   * when the server is bound somewhere other than loopback. Generated rather
   * than configured so that the secure path is also the default one: the URLs
   * printed below already carry it.
   */
  const token = args.token ?? process.env['FLOWLENS_TOKEN'] ?? randomBytes(16).toString('hex');
  const local = isLoopbackHost(host);

  let graph = buildGraph(root, args);
  let lastScan = new Date();

  /**
   * `serve` writes twice — the graph on every re-scan, the trace on every batch
   * of spans the browser sends — so the warning belongs here too, before the
   * developer walks away and lets a session's worth of spans accumulate in a
   * file git can see.
   */
  const gitNotice = guardArtifacts(
    artifactPaths(graphPath(root, args.graph), tracePath(root, args.trace)),
    {
      ...(args.gitignore !== undefined ? { auto: args.gitignore } : {}),
      ...(args.graph ? { graphFlag: args.graph } : {}),
      ...(args.trace ? { traceFlag: args.trace } : {}),
    },
  );
  if (gitNotice) process.stderr.write(`\n${gitNotice}`);

  const server = createServer((request, response) => {
    const url = new URL(request.url ?? '/', `http://${request.headers.host ?? 'localhost'}`);
    const path = url.pathname;
    const origin = headerOf(request, 'origin');

    // Before anything else: is this request even addressed to us?
    if (!hostAllowed(request.headers.host, host)) {
      deny(response, 403, 'FlowLens: unexpected Host header');
      return;
    }

    /**
     * Only the tracer endpoints answer a preflight.
     *
     * They are the two that are cross-origin by design — the app being traced
     * runs on its own port. Everything else is same-origin, and a preflight
     * that says otherwise would be an invitation.
     */
    if (request.method === 'OPTIONS') {
      if (!path.startsWith('/__flowlens/')) {
        deny(response, 404, 'not found');
        return;
      }
      response.writeHead(204, {
        'access-control-allow-origin': '*',
        'access-control-allow-methods': 'GET, POST, OPTIONS',
        'access-control-allow-headers': 'content-type, x-flowlens-token',
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

    /**
     * The browser tracer posts spans here.
     *
     * A write endpoint that has to accept cross-origin requests cannot be
     * protected by checking who is asking, so it checks what they know. Without
     * this, any page in your browser could forge spans — and a forged span is
     * worse than a missing one, because merged into the graph it reads as
     * `confirmed`: the one thing FlowLens says it has actually observed.
     */
    if (path === '/__flowlens/spans' && request.method === 'POST') {
      if (!tokenMatches(presentedToken(url, request), token)) {
        response.writeHead(401, {
          'content-type': 'text/plain; charset=utf-8',
          'access-control-allow-origin': '*',
        });
        response.end('FlowLens: missing or wrong token\n');
        return;
      }
      collectSpans(request, response, root, args);
      return;
    }

    /**
     * Everything under /api describes your codebase, so it answers the
     * dashboard and nothing else: no CORS headers (see `sendJson`), an origin
     * check for browsers that send one, and — once the server is reachable from
     * off this machine — the token as well.
     */
    if (path.startsWith('/api/')) {
      if (!originAllowed(origin, request.headers.host)) {
        deny(response, 403, 'FlowLens: cross-origin requests are not allowed');
        return;
      }
      if (!local && !tokenMatches(presentedToken(url, request), token)) {
        deny(response, 401, 'FlowLens: missing or wrong token');
        return;
      }
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
    // The token belongs in the URLs people copy, not in a paragraph telling
    // them to add it: the secure spelling should be the one to hand.
    const dashboard = local ? url : `${url}/?token=${token}`;
    process.stdout.write(
      `\n${color.bold('FlowLens')} dashboard on ${color.cyan(dashboard)}\n` +
        `${color.gray('project:')} ${root}\n` +
        `${color.gray('graph:')}   ${graph.nodeCount} nodes, ${graph.edgeCount} edges\n` +
        `${color.gray('spans:')}   POST ${url}/__flowlens/spans?token=${token}\n` +
        `${color.gray('tracer:')}  ${url}/__flowlens/browser.js?token=${token}\n` +
        (requestedPort === undefined && port !== DEFAULT_PORT
          ? `${color.gray('note:')}    port ${DEFAULT_PORT} was busy, using ${port}\n`
          : '') +
        (local
          ? ''
          : `\n${color.yellow('warning')} ${host} is not loopback: this dashboard is reachable\n` +
            `        from other machines. The token above is the only thing\n` +
            `        protecting your source graph. Bind 127.0.0.1 unless you\n` +
            `        meant this.\n`) +
        `\n${color.gray('Ctrl+C to stop')}\n`,
    );
    if (args.open === true) openBrowser(dashboard);
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

      /**
       * Stop appending rather than fill the disk.
       *
       * A tab left open on a busy page produces spans forever, and the trace
       * is only ever appended to. Refusing loudly at a fixed ceiling is kinder
       * than a machine that runs out of space overnight.
       */
      if (fileSize(file) >= TRACE_LIMIT_BYTES) {
        if (!traceLimitReported) {
          traceLimitReported = true;
          process.stderr.write(
            `${color.yellow('warning')} trace file has reached ` +
              `${Math.round(TRACE_LIMIT_BYTES / 1024 / 1024)}MB and is no longer being ` +
              `appended to:\n  ${file}\n  Delete it, or point --trace somewhere else.\n`,
          );
        }
        sendJson(response, { error: 'trace file is full' }, 413, true);
        return;
      }

      appendFileSync(file, `${spans.map((span) => JSON.stringify(span)).join('\n')}\n`, 'utf8');
      sendJson(response, { ok: true, received: spans.length }, 200, true);
    } catch {
      sendJson(response, { error: 'invalid span payload' }, 400, true);
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

/**
 * No `Access-Control-Allow-Origin` here, deliberately.
 *
 * These responses carry the graph: absolute file paths, every route, every
 * collection. A wildcard would let any page you happen to have open read all of
 * it — binding to 127.0.0.1 is no protection at all against a browser that is
 * already on this machine. The tracer endpoints send their own CORS headers,
 * because they need them and carry nothing.
 */
function sendJson(response: ServerResponse, body: unknown, status = 200, cors = false): void {
  const payload = JSON.stringify(body);
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
    // Only the span collector opts in, and only so the tracer's own fetch does
    // not log a CORS error at the developer. Its body is `{ok:true}`.
    ...(cors ? { 'access-control-allow-origin': '*' } : {}),
  });
  response.end(payload);
}

function fileSize(path: string): number {
  try {
    return statSync(path).size;
  } catch {
    return 0;
  }
}

function headerOf(request: IncomingMessage, name: string): string | undefined {
  const value = request.headers[name];
  return Array.isArray(value) ? value[0] : value;
}

function summarize(node: { id: string; label: string; source?: unknown; meta?: unknown }) {
  return { id: node.id, label: node.label, source: node.source, meta: node.meta };
}
