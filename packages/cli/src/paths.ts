import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { FlowGraph, type SerializedGraph } from '@flowlens/core';

export const FLOWLENS_DIR = '.flowlens';
export const GRAPH_FILE = 'graph.json';
export const TRACE_FILE = 'trace.jsonl';

/** Where FlowLens keeps its artifacts for a scanned project. */
export function outputDir(root: string): string {
  return join(resolve(root), FLOWLENS_DIR);
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
 * Write the graph, falling back to the current directory.
 *
 * A project can be read-only — a mounted volume, a container image, someone
 * else's checkout — and refusing to produce output would waste a scan that
 * already succeeded. Returns the path actually written.
 */
export function saveGraph(path: string, graph: FlowGraph): string {
  const contents = `${JSON.stringify(graph.toJSON(), null, 2)}\n`;
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, contents, 'utf8');
    return path;
  } catch (error) {
    const fallback = join(process.cwd(), FLOWLENS_DIR, GRAPH_FILE);
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
