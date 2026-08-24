import type { FlowGraph } from '../graph/graph.js';
import { ids, slug } from '../graph/ids.js';
import type { EdgeKind, FlowNode, TimingStats } from '../graph/types.js';
import { bestRouteMatch, normalizePath } from '../analyzer/http.js';
import { collectionNameOf } from '../analyzer/mongo.js';
import { groupTraces, type SpanKind, type TraceEvent } from './trace.js';

export interface MergeResult {
  traces: number;
  spans: number;
  /** Spans matched to a node the static analyzer had already found. */
  matched: number;
  /** Spans that existed only at runtime — dynamic routes, reflection, drift. */
  discovered: number;
  /** Static nodes runtime never touched, by kind. */
  unobserved: Record<string, number>;
}

export interface MergeOptions {
  apiPrefixes?: string[];
}

/**
 * Fold runtime traces into the static graph.
 *
 * This is the difference between a diagram and evidence. Static analysis says
 * "these components appear connected"; a trace says "this exact path executed
 * in 204ms". Where both agree, the graph is marked `confirmed`; where runtime
 * finds something static analysis missed, the node is added rather than
 * discarded — that gap is usually the interesting part (a dynamic route, a
 * call through an ORM helper, an endpoint nobody knew was still live).
 */
export function mergeRuntimeTrace(
  graph: FlowGraph,
  events: TraceEvent[],
  options: MergeOptions = {},
): MergeResult {
  const apiPrefixes = options.apiPrefixes ?? ['/api'];
  const traces = groupTraces(events);
  const result: MergeResult = {
    traces: traces.size,
    spans: events.length,
    matched: 0,
    discovered: 0,
    unobserved: {},
  };

  const routes = graph.nodesOfKind('route').map((node) => ({
    id: node.id,
    method: String(node.meta?.['httpMethod'] ?? ''),
    path: String(node.meta?.['path'] ?? ''),
  }));

  for (const spans of traces.values()) {
    /** spanId -> resolved graph node id, so children can link to parents. */
    const resolved = new Map<string, string>();
    const selfTimes = selfTimeOf(spans);

    for (const span of spans) {
      const match = resolveSpan(graph, span, routes, apiPrefixes);
      if (!match) continue;
      if (match.discovered) result.discovered += 1;
      else result.matched += 1;

      resolved.set(span.spanId, match.nodeId);
      observeNode(graph, match.nodeId, span, selfTimes.get(span.spanId) ?? span.durationMs);
    }

    // Connect each span to its nearest resolved ancestor.
    for (const span of spans) {
      const childId = resolved.get(span.spanId);
      if (!childId) continue;
      const parentId = nearestResolvedAncestor(span, spans, resolved);
      if (!parentId || parentId === childId) continue;
      const kind = runtimeEdgeKind(graph, parentId, childId);
      graph.addEdge({ from: parentId, to: childId, kind, evidence: 'runtime' });
    }
  }

  for (const node of graph.allNodes()) {
    if (!node.observations) {
      result.unobserved[node.kind] = (result.unobserved[node.kind] ?? 0) + 1;
    }
  }

  return result;
}

interface SpanMatch {
  nodeId: string;
  discovered: boolean;
}

function resolveSpan(
  graph: FlowGraph,
  span: TraceEvent,
  routes: Array<{ id: string; method: string; path: string }>,
  apiPrefixes: string[],
): SpanMatch | undefined {
  const attrs = span.attrs ?? {};

  switch (span.kind) {
    case 'http-server': {
      const method = (attrs.httpMethod ?? 'GET').toUpperCase();
      const path = normalizePath(attrs.path ?? span.name, apiPrefixes);
      const route = bestRouteMatch({ method, path }, routes);
      if (route) return { nodeId: route.id, discovered: false };
      const id = ids.route(method, path);
      graph.addNode({
        id,
        kind: 'route',
        label: `${method} ${path}`,
        evidence: 'runtime',
        meta: { httpMethod: method, path, discoveredAtRuntime: true },
      });
      return { nodeId: id, discovered: true };
    }

    case 'http-client': {
      const method = (attrs.httpMethod ?? 'GET').toUpperCase();
      const path = normalizePath(attrs.path ?? span.name, apiPrefixes);
      const id = ids.apiCall(method, path);
      const discovered = !graph.hasNode(id);
      graph.addNode({
        id,
        kind: 'api-call',
        label: `${method} ${path}`,
        evidence: 'runtime',
        meta: { httpMethod: method, path, ...(discovered ? { discoveredAtRuntime: true } : {}) },
      });
      return { nodeId: id, discovered };
    }

    case 'db': {
      const operation = attrs.operation ?? 'find';
      const collection =
        attrs.collection ?? (attrs.class ? collectionNameOf(attrs.class) : 'unknown');
      const existing = graph
        .nodesOfKind('db-op')
        .find(
          (node) =>
            node.meta?.['collection'] === collection && node.meta?.['operation'] === operation,
        );
      if (existing) return { nodeId: existing.id, discovered: false };
      const id = ids.dbOp(collection, operation, 'runtime');
      graph.addNode({
        id,
        kind: 'db-op',
        label: `${collection}.${operation}`,
        evidence: 'runtime',
        meta: { collection, operation, discoveredAtRuntime: true },
      });
      const collectionId = ids.collection(collection);
      graph.addNode({
        id: collectionId,
        kind: 'collection',
        label: collection,
        evidence: 'runtime',
      });
      graph.addEdge({
        from: id,
        to: collectionId,
        kind: isWriteOperation(operation) ? 'writes' : 'reads',
        evidence: 'runtime',
      });
      return { nodeId: id, discovered: true };
    }

    case 'method': {
      const label = attrs.class && attrs.method ? `${attrs.class}.${attrs.method}` : span.name;
      const existing = graph.nodesOfKind('method').find((node) => node.label === label);
      if (existing) return { nodeId: existing.id, discovered: false };
      const id = `method:runtime#${label}`;
      graph.addNode({
        id,
        kind: 'method',
        label,
        evidence: 'runtime',
        meta: { discoveredAtRuntime: true, ...(attrs.class ? { class: attrs.class } : {}) },
      });
      return { nodeId: id, discovered: true };
    }

    case 'ui-action': {
      const existing = graph
        .nodesOfKind('ui-action')
        .find(
          (node) =>
            node.label === span.name &&
            (!attrs.component || node.meta?.['component'] === attrs.component),
        );
      if (existing) return { nodeId: existing.id, discovered: false };
      const id = `ui-action:runtime#${slug(`${attrs.component ?? 'app'}-${span.name}`)}`;
      graph.addNode({
        id,
        kind: 'ui-action',
        label: span.name,
        evidence: 'runtime',
        meta: {
          discoveredAtRuntime: true,
          ...(attrs.component ? { component: attrs.component } : {}),
        },
      });
      return { nodeId: id, discovered: true };
    }

    default:
      return undefined;
  }
}

/**
 * Exclusive time per span: its own duration minus the time its direct children
 * accounted for.
 *
 * Without this, a flow's "total" is the sum of every level of nesting — the same
 * 41ms insert counted again in the service, again in the route, and again in the
 * client round trip.
 */
function selfTimeOf(spans: TraceEvent[]): Map<string, number> {
  const childDuration = new Map<string, number>();
  for (const span of spans) {
    if (!span.parentSpanId) continue;
    childDuration.set(
      span.parentSpanId,
      (childDuration.get(span.parentSpanId) ?? 0) + span.durationMs,
    );
  }

  const selfTimes = new Map<string, number>();
  for (const span of spans) {
    // Concurrent children can exceed the parent's wall clock; never go negative.
    selfTimes.set(
      span.spanId,
      Math.max(0, span.durationMs - (childDuration.get(span.spanId) ?? 0)),
    );
  }
  return selfTimes;
}

function observeNode(graph: FlowGraph, nodeId: string, span: TraceEvent, selfMs: number): void {
  const node = graph.node(nodeId);
  if (!node) return;
  // A node the analyzer had already found, now observed executing: confirmed.
  // A node that only exists because of this trace stays `runtime`.
  if (node.evidence === 'static') node.evidence = 'confirmed';
  node.observations = (node.observations ?? 0) + 1;
  node.timing = updateTiming(node.timing, span.durationMs, selfMs);
  if (span.attrs?.error) {
    node.meta = { ...node.meta, lastError: span.attrs.error };
  }
}

function updateTiming(
  current: TimingStats | undefined,
  durationMs: number,
  selfMs: number,
): TimingStats {
  if (!current) {
    return {
      count: 1,
      totalMs: round(durationMs),
      minMs: round(durationMs),
      maxMs: round(durationMs),
      avgMs: round(durationMs),
      selfTotalMs: round(selfMs),
      avgSelfMs: round(selfMs),
    };
  }
  const count = current.count + 1;
  const totalMs = current.totalMs + durationMs;
  const selfTotalMs = current.selfTotalMs + selfMs;
  return {
    count,
    totalMs: round(totalMs),
    minMs: round(Math.min(current.minMs, durationMs)),
    maxMs: round(Math.max(current.maxMs, durationMs)),
    avgMs: round(totalMs / count),
    selfTotalMs: round(selfTotalMs),
    avgSelfMs: round(selfTotalMs / count),
  };
}

/**
 * Walk up the parent chain until we find a span that mapped to a node.
 * Middleware and framework internals are usually unresolvable, and we do not
 * want them to break the chain from click to collection.
 */
function nearestResolvedAncestor(
  span: TraceEvent,
  spans: TraceEvent[],
  resolved: Map<string, string>,
): string | undefined {
  const byId = new Map(spans.map((s) => [s.spanId, s] as const));
  let parentId = span.parentSpanId;
  const seen = new Set<string>([span.spanId]);
  while (parentId && !seen.has(parentId)) {
    seen.add(parentId);
    const nodeId = resolved.get(parentId);
    if (nodeId) return nodeId;
    parentId = byId.get(parentId)?.parentSpanId;
  }
  return undefined;
}

/** Pick the edge kind that matches the layers being connected. */
function runtimeEdgeKind(graph: FlowGraph, fromId: string, toId: string): EdgeKind {
  const from = graph.node(fromId);
  const to = graph.node(toId);
  return edgeKindFor(from, to);
}

function edgeKindFor(from: FlowNode | undefined, to: FlowNode | undefined): EdgeKind {
  if (!from || !to) return 'calls';
  if (from.kind === 'ui-action') return 'triggers';
  if (to.kind === 'api-call') return 'requests';
  if (from.kind === 'api-call' && to.kind === 'route') return 'handled-by';
  if (to.kind === 'db-op') return 'queries';
  return 'calls';
}

function isWriteOperation(operation: string): boolean {
  return /^(create|insert|update|replace|delete|remove|save|bulkWrite|findOneAnd(Update|Delete|Replace)|findByIdAnd)/i.test(
    operation,
  );
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}

/** Convenience: which span kinds the tracer is allowed to emit. */
export const SPAN_KINDS: readonly SpanKind[] = [
  'ui-action',
  'http-client',
  'http-server',
  'method',
  'db',
];
