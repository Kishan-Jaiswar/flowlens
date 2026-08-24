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
  affectedFlows: Array<{ id: string; label: string; component?: string; risk: number }>;
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
export function analyzeImpact(graph: FlowGraph, targetId: string): ImpactReport | undefined {
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
  const flows = resolveFlows(graph, { includeLocalOnly: true });
  const affectedFlows = flows
    .filter((flow) => flow.steps.some((step) => step.nodeId === targetId))
    .map((flow) => ({
      id: flow.id,
      label: flow.label,
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
  if (target.evidence === 'static') {
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
 * Find nodes by a loose query, so the CLI can take `PatientsService.create`,
 * `patients`, or a full node id.
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

/** Frontend calls that hit no backend route — typos and version drift. */
export function findBrokenCalls(graph: FlowGraph): FlowNode[] {
  return graph
    .nodesOfKind('api-call')
    .filter((call) => graph.successors(call.id, ['handled-by']).length === 0);
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
