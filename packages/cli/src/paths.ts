import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { FlowGraph, type SerializedGraph } from '@flowslens/core';

export const GRAPH_FILE = 'graph.json';
export const TRACE_FILE = 'trace.jsonl';

/** A home directory is not guaranteed — some CI images and daemons have none. */
function safeHome(): string | undefined {
  try {
    const home = homedir();
    return home.length > 0 ? home : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Root of the machine-local artifact cache.
 *
 * FlowLens never writes into the project it reads. A scan has to leave the
 * developer's repository byte-for-byte unchanged, so that pointing the tool at a
 * colleague's checkout, a mounted volume or a read-only container image is always
 * safe, and so that `git status` after a scan is empty. Artifacts therefore live
 * in the OS cache directory, keyed by project path.
 */
function cacheRoot(): string {
  // An explicit override, for CI caching and for tests that must not touch the
  // developer's real cache. Relative values are ignored, as with XDG_CACHE_HOME.
  const override = process.env['FLOWLENS_CACHE'];
  if (override && isAbsolute(override)) return override;

  if (process.platform === 'win32') {
    const local = process.env['LOCALAPPDATA'] ?? process.env['APPDATA'];
    if (local) return join(local, 'flowlens', 'Cache');
  }
  if (process.platform === 'darwin') {
    const home = safeHome();
    if (home) return join(home, 'Library', 'Caches', 'flowlens');
  }
  // The XDG spec says a relative XDG_CACHE_HOME must be ignored.
  const xdg = process.env['XDG_CACHE_HOME'];
  if (xdg && isAbsolute(xdg)) return join(xdg, 'flowlens');
  const home = safeHome();
  if (home) return join(home, '.cache', 'flowlens');
  return join(tmpdir(), 'flowlens');
}

/**
 * A stable, filesystem-safe identifier for a project directory.
 *
 * The readable half is for humans browsing the cache; the hash is what keeps it
 * unique, so two checkouts of the same repository in different directories do not
 * share a graph. Case is folded on the platforms whose filesystems are
 * case-insensitive, so `C:\App` and `c:\app` resolve to one cache entry.
 */
export function projectKey(root: string): string {
  const absolute = resolve(root);
  const canonical =
    process.platform === 'win32' || process.platform === 'darwin'
      ? absolute.toLowerCase()
      : absolute;
  const hash = createHash('sha256').update(canonical).digest('hex').slice(0, 10);
  const slug =
    basename(absolute)
      .replace(/[^A-Za-z0-9._-]+/g, '-')
      .replace(/^[-.]+/, '')
      .replace(/[-.]+$/, '')
      .slice(0, 40) || 'project';
  return `${slug}-${hash}`;
}

/** Where FlowLens keeps its artifacts for a scanned project — never inside it. */
export function outputDir(root: string): string {
  return join(cacheRoot(), projectKey(root));
}

export function graphPath(root: string, override?: string): string {
  if (override) return isAbsolute(override) ? override : resolve(override);
  return join(outputDir(root), GRAPH_FILE);
}

export function tracePath(root: string, override?: string): string {
  if (override) return isAbsolute(override) ? override : resolve(override);
  return join(outputDir(root), TRACE_FILE);
}

/**
 * Write the graph, falling back to the temp directory.
 *
 * The cache directory can be unwritable — an odd HOME, a locked-down image, a
 * full disk — and refusing to produce output would waste a scan that already
 * succeeded. The fallback is deliberately *not* the current directory, which is
 * usually the project being scanned and must stay untouched. Returns the path
 * actually written.
 */
export function saveGraph(path: string, graph: FlowGraph): string {
  const contents = `${JSON.stringify(graph.toJSON(), null, 2)}\n`;
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, contents, 'utf8');
    return path;
  } catch (error) {
    // Keep the project key so two projects cannot overwrite each other here.
    const fallback = join(tmpdir(), 'flowlens', basename(dirname(path)), GRAPH_FILE);
    if (fallback === path) throw error;
    mkdirSync(dirname(fallback), { recursive: true });
    writeFileSync(fallback, contents, 'utf8');
    return fallback;
  }
}

export function loadGraph(path: string): FlowGraph {
  if (!existsSync(path)) {
    throw new Error(`No graph found at ${path}\nRun \`flowlens scan <project>\` first.`);
  }
  const data = JSON.parse(readFileSync(path, 'utf8')) as SerializedGraph;
  return FlowGraph.fromJSON(data);
}

/** Resolve a path inside the CLI package, e.g. the bundled dashboard. */
export function packageFile(...segments: string[]): string {
  const here = dirname(fileURLToPath(import.meta.url));
  // dist/ -> package root
  return resolve(here, '..', ...segments);
}

/** The dashboard lives in apps/dashboard, outside the CLI package. */
export function dashboardDir(): string | undefined {
  const candidates = [
    packageFile('dashboard'),
    packageFile('..', '..', 'apps', 'dashboard', 'public'),
    packageFile('..', '..', '..', 'apps', 'dashboard', 'public'),
  ];
  return candidates.find((candidate) => existsSync(join(candidate, 'index.html')));
}

/**
 * The browser tracer, served to the app being traced so that nothing has to be
 * copied into the developer's project.
 */
export function browserTracerFile(): string | undefined {
  const candidates = [
    packageFile('runtime', 'browser.js'),
    packageFile('..', 'runtime', 'dist', 'browser.js'),
    packageFile('..', '..', 'runtime', 'dist', 'browser.js'),
    packageFile('..', '..', 'packages', 'runtime', 'dist', 'browser.js'),
  ];
  return candidates.find((candidate) => existsSync(candidate));
}
