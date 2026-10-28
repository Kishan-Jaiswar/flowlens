import { envBaseOf } from '../analyzer/http.js';
import { pageAtPath } from '../flow/pages.js';
import type { FlowGraph } from '../graph/graph.js';
import type { EdgeKind, FlowNode } from '../graph/types.js';
import { resolveFlows, type FeatureFlow } from '../flow/resolve.js';

/** Edges walked backwards to answer "who depends on this?". */
const DEPENDENCY_EDGES: readonly EdgeKind[] = [
  'triggers',
  'calls',
  'requests',
  'handled-by',
  'queries',
  'reads',
  'writes',
  'injects',
  'defines',
  'validates',
  'flows-to',
];

export interface Dependent {
  nodeId: string;
  kind: string;
  label: string;
  /** Hops away from the changed node. Direct callers are 1. */
  distance: number;
  file?: string;
  line?: number;
}

export interface ImpactReport {
  target: { nodeId: string; kind: string; label: string; file?: string; line?: number };
  /** Everything that would notice a change here, nearest first. */
  dependents: Dependent[];
  /** User-facing features that run through the target. */
  affectedFlows: Array<{
    id: string;
    label: string;
    /** Descriptive form: `Order · Submit`. */
    title: string;
    component?: string;
    risk: number;
  }>;
  /** Collections the target reads or writes, directly or transitively. */
  collections: string[];
  /** Direct API endpoints that lead here. */
  endpoints: string[];
  blastRadius: number;
  level: 'low' | 'medium' | 'high';
  warnings: string[];
}

/**
 * "If I change this, what breaks?"
 *
 * Answered by walking the graph *backwards* from the target. Where the flow
 * resolver goes forward from a click to a collection, this goes the other way:
 * from one function back out to every feature that depends on it.
 */
export function analyzeImpact(
  graph: FlowGraph,
  targetId: string,
  options: {
    /**
     * Pre-resolved flows, so a caller asking about many nodes resolves once.
     *
     * Without this, asking the same question of every step in a feature
     * re-resolved every flow in the project per step — quadratic on the most
     * interesting projects, which are the big ones.
     */
    flows?: FeatureFlow[];
  } = {},
): ImpactReport | undefined {
  const target = graph.node(targetId);
  if (!target) return undefined;

  const upstream = graph.reachable(targetId, { direction: 'in', kinds: DEPENDENCY_EDGES });
  upstream.delete(targetId);

  const dependents: Dependent[] = [];
  for (const [nodeId, distance] of upstream) {
    const node = graph.node(nodeId);
    if (!node) continue;
    dependents.push({
      nodeId,
      kind: node.kind,
      label: node.label,
      distance,
      ...(node.source ? { file: node.source.file, line: node.source.line } : {}),
    });
  }
  dependents.sort((a, b) => a.distance - b.distance || a.label.localeCompare(b.label));

  // Which user-visible features run through this node?
  const flows = options.flows ?? resolveFlows(graph, { includeLocalOnly: true });
  const affectedFlows = flows
    .filter((flow) => flow.steps.some((step) => step.nodeId === targetId))
    .map((flow) => ({
      id: flow.id,
      label: flow.label,
      title: flow.title,
      ...(flow.component ? { component: flow.component } : {}),
      risk: flow.risk.score,
    }))
    .sort((a, b) => b.risk - a.risk);

  const downstream = graph.reachable(targetId, {
    kinds: ['calls', 'queries', 'reads', 'writes', 'requests', 'handled-by'],
  });
  const collections = [
    ...new Set(
      [...downstream.keys()]
        .map((id) => graph.node(id))
        .filter((node): node is FlowNode => node?.kind === 'collection')
        .map((node) => node.label),
    ),
  ].sort();

  const endpoints = [
    ...new Set(
      dependents.filter((d) => d.kind === 'api-call' || d.kind === 'route').map((d) => d.label),
    ),
  ].sort();

  const uiActions = dependents.filter((d) => d.kind === 'ui-action').length;
  const blastRadius = dependents.length;

  const warnings: string[] = [];
  if (uiActions >= 3) warnings.push(`${uiActions} user actions depend on this`);
  if (endpoints.length >= 3) warnings.push(`reached from ${endpoints.length} endpoints`);
  if (collections.length >= 2) warnings.push(`touches ${collections.length} collections`);
  // A function the tracer has no span for still ran if a query it makes was seen.
  const seenRunning =
    target.evidence !== 'static' ||
    [...graph.reachable(targetId, { kinds: ['calls', 'queries'] }).keys()].some(
      (id) => graph.node(id)?.evidence !== undefined && graph.node(id)?.evidence !== 'static',
    );
  if (!seenRunning) {
    warnings.push('never observed at runtime — the static picture may be incomplete');
  }

  const level = blastRadius >= 25 || uiActions >= 4 ? 'high' : blastRadius >= 8 ? 'medium' : 'low';

  return {
    target: {
      nodeId: targetId,
      kind: target.kind,
      label: target.label,
      ...(target.source ? { file: target.source.file, line: target.source.line } : {}),
    },
    dependents,
    affectedFlows,
    collections,
    endpoints,
    blastRadius,
    level,
    warnings,
  };
}

/**
 * Find nodes by a loose query, so the CLI can take `CustomersService.create`,
 * `customers`, or a full node id.
 */
export function findNodes(graph: FlowGraph, query: string): FlowNode[] {
  const needle = query.toLowerCase();
  const exact = graph.node(query);
  if (exact) return [exact];

  const matches = graph.allNodes().filter((node) => {
    return (
      node.label.toLowerCase() === needle ||
      node.id.toLowerCase().endsWith(needle) ||
      node.label.toLowerCase().includes(needle) ||
      node.id.toLowerCase().includes(needle)
    );
  });

  // Prefer exact label matches, then shorter labels (less incidental matching).
  return matches.sort((a, b) => {
    const aExact = a.label.toLowerCase() === needle ? 0 : 1;
    const bExact = b.label.toLowerCase() === needle ? 0 : 1;
    return aExact - bExact || a.label.length - b.label.length;
  });
}

/** Endpoints declared by the backend that no frontend code calls. */
export function findDeadEndpoints(graph: FlowGraph): FlowNode[] {
  return graph
    .nodesOfKind('route')
    .filter((route) => graph.predecessors(route.id, ['handled-by']).length === 0);
}

/**
 * Frontend calls that hit no backend route — typos and version drift.
 *
 * Calls to another service (see `findExternalCalls`) are not among them: there is
 * no route for those here because they are not this backend's to answer.
 */
export function findBrokenCalls(graph: FlowGraph): FlowNode[] {
  const external = new Set(findExternalCalls(graph));
  return unmatchedCalls(graph).filter((call) => !external.has(call));
}

/**
 * Calls that go to another service: through a base none of whose calls reaches a
 * route in the scanned code.
 *
 * The base is the environment variable the URL starts from (`<env:AI_HOST>`), the host
 * an absolute URL names, or else the client or wrapper that sends it. A client seen in
 * one call only is not enough to say so — that call may simply be wrong. With no call
 * matched at all there is no backend here to compare with, and nothing is set aside.
 */
export function findExternalCalls(graph: FlowGraph): FlowNode[] {
  const calls = graph.nodesOfKind('api-call').filter((call) => !isPageNavigation(graph, call));
  const unmatched = new Set(unmatchedCalls(graph));
  if (unmatched.size === calls.length) return [];
  const reached = new Set<string>();
  const sizes = new Map<string, number>();
  for (const call of calls) {
    const base = callBase(call);
    sizes.set(base, (sizes.get(base) ?? 0) + 1);
    if (!unmatched.has(call)) reached.add(base);
  }
  return [...unmatched].filter((call) => {
    const base = callBase(call);
    return !reached.has(base) && (!base.startsWith('client:') || sizes.get(base)! > 1);
  });
}

function unmatchedCalls(graph: FlowGraph): FlowNode[] {
  return graph
    .nodesOfKind('api-call')
    .filter((call) => graph.successors(call.id, ['handled-by']).length === 0)
    .filter((call) => !isPageNavigation(graph, call));
}

/** Where a call is sent: `env:AI_HOST`, `host:maps.example.com` or `client:aiPost`. */
export function callBase(call: FlowNode): string {
  const raw = String(call.meta?.['base'] ?? call.meta?.['rawPath'] ?? '');
  const env = envBaseOf(raw);
  if (env) return `env:${env}`;
  const host = /^[a-z][a-z0-9+.-]*:\/\/([^/?#]+)/i.exec(raw)?.[1];
  if (host) return `host:${host.replace(/^[^@]*@/, '')}`;
  return `client:${String(call.meta?.['client'] ?? '')}`;
}

/**
 * Seen only at runtime, a `GET` to the address of one of the app's own pages:
 * the browser opening that page (a Next.js `<Link>` fetches it), which no API
 * route is meant to answer.
 */
export function isPageNavigation(graph: FlowGraph, call: FlowNode): boolean {
  if (call.meta?.['discoveredAtRuntime'] !== true || call.meta?.['httpMethod'] !== 'GET')
    return false;
  const path = call.meta?.['path'];
  return typeof path === 'string' && pageAtPath(graph, path) !== undefined;
}

/** Collections written by more than one service — a common source of surprise. */
export function findSharedWrites(
  graph: FlowGraph,
): Array<{ collection: string; writers: string[] }> {
  const out: Array<{ collection: string; writers: string[] }> = [];
  for (const collection of graph.nodesOfKind('collection')) {
    const writers = new Set<string>();
    for (const op of graph.predecessors(collection.id, ['writes'])) {
      for (const method of graph.predecessors(op.id, ['queries'])) {
        const owner = method.meta?.['class'];
        if (owner) writers.add(String(owner));
      }
    }
    if (writers.size > 1) {
      out.push({ collection: collection.label, writers: [...writers].sort() });
    }
  }
  return out;
}

export type { FeatureFlow };
