import { isAbsolute, relative } from 'node:path';
import type { FlowGraph } from '../graph/graph.js';
import type { EdgeKind, Evidence, NodeKind } from '../graph/types.js';
import { resolveFlows, type FeatureFlow } from './resolve.js';

/**
 * "I am looking at this line. Which features run through it?"
 *
 * The inverse of `resolveFlow`. That walks forward from a click to a
 * collection; this starts from a cursor position and walks back out to every
 * user-visible feature whose execution path passes through it — the question a
 * developer actually has while reading unfamiliar code, because the file tells
 * you what the code *does*, never what it is *for*.
 *
 * Two things make it more than a lookup:
 *
 *   - A graph node sits on one line, but a developer's cursor sits anywhere.
 *     Asking for line 20 of a 30-line handler declared on line 15 has to find
 *     that handler, so an exact hit falls back to the nearest declaration
 *     *above* the line (`offset` says how far, and stays visible in the output
 *     rather than pretending the hit was exact).
 *   - Not every node in a file is a step in a flow. A `useState` field, a DTO,
 *     a schema field hang *off* the execution path rather than sitting on it —
 *     the same split `StepDetail` makes. So a match that no flow contains is
 *     followed one hop along those non-execution edges to a node that is.
 *     Deliberately one hop, for the reason `resolveFlow` stops there too:
 *     `defines` walked transitively pulls in half the app.
 */

/** Edges that attach facts to the execution path without being execution. */
const DETAIL_EDGES: readonly EdgeKind[] = [
  'renders',
  'reads-state',
  'writes-state',
  'defines',
  'validates',
  'injects',
];

export interface Location {
  /** The file as typed — separators untouched, so Windows input survives. */
  file: string;
  line?: number;
  column?: number;
}

/**
 * `file.ts`, `file.ts:42`, `file.ts:42:7`, and `C:\app\file.ts:42`.
 *
 * The path part is lazy so that backtracking lands on the *last* `:digits`,
 * which is what makes a Windows drive letter survive: `C:\app\x.ts` has a colon
 * but no trailing line number, so it stays a path.
 */
const LOCATION = /^(.*?):(\d+)(?::(\d+))?$/;

export function parseLocation(input: string): Location {
  const match = LOCATION.exec(input);
  if (!match) return { file: input };
  return {
    file: match[1]!,
    line: Number(match[2]),
    ...(match[3] ? { column: Number(match[3]) } : {}),
  };
}

export interface ResolvedFile {
  /** The path as the graph stores it: project-relative, forward slashes. */
  file?: string;
  /** Every graph file the input could have meant, when it was ambiguous. */
  candidates: string[];
}

/**
 * Map whatever the user typed onto the path the graph stores.
 *
 * Graph paths are project-relative and forward-slashed so a graph survives
 * being copied between machines, but a developer types what their editor shows:
 * an absolute path, a path relative to the shell, or just a basename. A bare
 * basename is accepted only when it is unambiguous — two `route.ts` files in an
 * App Router project is the normal case, not the exception, so guessing would
 * be worse than asking.
 */
export function resolveGraphFile(
  graph: FlowGraph,
  input: string,
  options: { root?: string } = {},
): ResolvedFile {
  const files = new Set<string>();
  for (const node of graph.allNodes()) {
    if (node.source) files.add(node.source.file);
  }

  const attempts = [normalizePathInput(input)];
  if (options.root && isAbsolute(input)) {
    attempts.push(normalizePathInput(relative(options.root, input)));
  }

  for (const attempt of attempts) {
    if (attempt !== '' && files.has(attempt)) return { file: attempt, candidates: [attempt] };
  }

  // Suffix match, which is also what makes a multi-root scan work: those paths
  // carry the project folder in front (`web/src/App.tsx`).
  for (const attempt of attempts) {
    if (attempt === '') continue;
    const suffix = [...files].filter((file) => file.endsWith(`/${attempt}`)).sort();
    if (suffix.length === 1) return { file: suffix[0]!, candidates: suffix };
    if (suffix.length > 1) return { candidates: suffix };
  }

  return { candidates: [] };
}

/** Trim the spellings a shell or editor adds, and settle on forward slashes. */
function normalizePathInput(input: string): string {
  return input.replace(/\\/g, '/').replace(/^\.\//, '').replace(/^\/+/, '');
}

export interface WhereNode {
  nodeId: string;
  kind: NodeKind;
  label: string;
  line?: number;
  evidence: Evidence;
  /**
   * Lines between the queried line and this node. `0` is an exact hit, a
   * positive number means the declaration is that many lines above.
   */
  offset?: number;
}

export interface WhereFlowHit {
  id: string;
  label: string;
  /** Descriptive form: `Order · Submit`. */
  title: string;
  screen?: string;
  component?: string;
  risk: number;
  level: 'low' | 'medium' | 'high';
  evidence: Evidence;
  hitsBackend: boolean;
  endpoints: string[];
  collections: string[];
  /** The step of this flow that lives at the queried location. */
  via: WhereNode;
  /**
   * True when the match was not itself on the execution path and was followed
   * one hop out — a `useState` field reached through the handler that sets it.
   */
  indirect: boolean;
}

export interface WhereReport {
  /** The resolved, project-relative file. */
  file: string;
  line?: number;
  column?: number;
  /** What the query landed on: exact hits, else the nearest declaration. */
  matches: WhereNode[];
  /** Every node the graph knows in this file, for orientation. */
  fileNodes: WhereNode[];
  /** Features running through `matches`, highest risk first. */
  flows: WhereFlowHit[];
  /** Features running through this file, but not through the matched line. */
  otherFlowsInFile: WhereFlowHit[];
}

export interface WhereOptions {
  /** Project root, so an absolute path can be made project-relative. */
  root?: string;
  /** Include features that never reach the backend. On by default. */
  includeLocalOnly?: boolean;
}

export interface WhereFailure {
  /** No node in the graph belongs to this file. */
  reason: 'unknown-file' | 'ambiguous-file';
  file: string;
  candidates: string[];
}

export function isWhereFailure(value: WhereReport | WhereFailure): value is WhereFailure {
  return 'reason' in value;
}

export function whereIs(
  graph: FlowGraph,
  input: string,
  options: WhereOptions = {},
): WhereReport | WhereFailure {
  const location = parseLocation(input);
  const resolved = resolveGraphFile(graph, location.file, options);

  if (!resolved.file) {
    return {
      reason: resolved.candidates.length > 1 ? 'ambiguous-file' : 'unknown-file',
      file: location.file,
      candidates: resolved.candidates,
    };
  }
  const file = resolved.file;

  const inFile = graph
    .allNodes()
    .filter((node) => node.source?.file === file)
    .sort(
      (a, b) => (a.source?.line ?? 0) - (b.source?.line ?? 0) || a.label.localeCompare(b.label),
    );

  const fileNodes: WhereNode[] = inFile.map((node) => describe(node.id, graph));
  const matches = matchesFor(inFile, location.line).map((node) => ({
    ...describe(node.id, graph),
    ...(location.line !== undefined
      ? { offset: location.line - (node.source?.line ?? location.line) }
      : {}),
  }));

  /**
   * Anchors are the node ids a flow can be matched on. The match itself comes
   * first; a node that no flow contains contributes its neighbours one hop out
   * along the non-execution edges instead.
   */
  const anchors = new Map<string, { node: WhereNode; indirect: boolean }>();
  for (const match of matches) anchors.set(match.nodeId, { node: match, indirect: false });
  for (const match of matches) {
    for (const neighbour of [
      ...graph.predecessors(match.nodeId, DETAIL_EDGES),
      ...graph.successors(match.nodeId, DETAIL_EDGES),
    ]) {
      if (!anchors.has(neighbour.id)) anchors.set(neighbour.id, { node: match, indirect: true });
    }
  }

  const flows = resolveFlows(graph, {
    includeLocalOnly: options.includeLocalOnly ?? true,
  });

  const hits: WhereFlowHit[] = [];
  const other: WhereFlowHit[] = [];

  for (const flow of flows) {
    const anchored = flow.steps.find((step) => anchors.has(step.nodeId));
    if (anchored) {
      const anchor = anchors.get(anchored.nodeId)!;
      hits.push(
        hit(flow, {
          via: anchor.indirect ? anchor.node : describe(anchored.nodeId, graph),
          indirect: anchor.indirect,
        }),
      );
      continue;
    }
    // Runs through the file, but not through the line that was asked about.
    const elsewhere = flow.steps.find((step) => step.file === file);
    if (elsewhere) {
      other.push(hit(flow, { via: describe(elsewhere.nodeId, graph), indirect: false }));
    }
  }

  const byRisk = (a: WhereFlowHit, b: WhereFlowHit) =>
    b.risk - a.risk || a.title.localeCompare(b.title);

  return {
    file,
    ...(location.line !== undefined ? { line: location.line } : {}),
    ...(location.column !== undefined ? { column: location.column } : {}),
    matches,
    fileNodes,
    flows: hits.sort(byRisk),
    otherFlowsInFile: other.sort(byRisk),
  };
}

/**
 * Which nodes a line landed on.
 *
 * An exact hit wins. Failing that the nearest declaration *above* the line is
 * the answer, because that is what encloses the cursor — a handler declared on
 * line 15 owns line 20. Only when the line sits above everything the graph
 * knows does it look downwards instead, so a query near the top of a file still
 * says something useful.
 */
function matchesFor<T extends { source?: { line: number } }>(inFile: T[], line?: number): T[] {
  if (line === undefined) return inFile;

  const exact = inFile.filter((node) => node.source?.line === line);
  if (exact.length > 0) return exact;

  const above = inFile.filter((node) => (node.source?.line ?? Infinity) < line);
  if (above.length > 0) {
    const nearest = Math.max(...above.map((node) => node.source?.line ?? 0));
    return above.filter((node) => node.source?.line === nearest);
  }

  const below = inFile.filter((node) => (node.source?.line ?? -Infinity) > line);
  if (below.length === 0) return [];
  const nearest = Math.min(...below.map((node) => node.source?.line ?? 0));
  return below.filter((node) => node.source?.line === nearest);
}

function describe(nodeId: string, graph: FlowGraph): WhereNode {
  const node = graph.node(nodeId);
  if (!node) return { nodeId, kind: 'field', label: nodeId, evidence: 'static' };
  return {
    nodeId,
    kind: node.kind,
    label: node.label,
    evidence: node.evidence,
    ...(node.source ? { line: node.source.line } : {}),
  };
}

function hit(flow: FeatureFlow, via: { via: WhereNode; indirect: boolean }): WhereFlowHit {
  return {
    id: flow.id,
    label: flow.label,
    title: flow.title,
    ...(flow.screen ? { screen: flow.screen } : {}),
    ...(flow.component ? { component: flow.component } : {}),
    risk: flow.risk.score,
    level: flow.risk.level,
    evidence: flow.evidence,
    hitsBackend: flow.hitsBackend,
    endpoints: flow.endpoints,
    /**
     * Deduplicated, unlike `FeatureFlow.collections`, which carries one entry
     * per effect on purpose — "reads customers then writes customers" matters
     * in a flow trace, but here the question is only which data is in reach.
     */
    collections: [...new Set(flow.collections.map((access) => access.collection))],
    via: via.via,
    indirect: via.indirect,
  };
}
