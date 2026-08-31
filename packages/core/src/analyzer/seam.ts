import type { FlowGraph } from '../graph/graph.js';
import { ids } from '../graph/ids.js';
import { bestRouteMatch, type RouteLike } from './http.js';

export interface SeamResult {
  matched: number;
  /** Frontend calls with no backend route — a wrong URL, or an external API. */
  unmatchedCalls: string[];
  /** Backend routes nothing in the frontend calls — dead endpoints. */
  orphanRoutes: string[];
}

/**
 * Join the two halves of the graph.
 *
 * Until this runs, FlowLens holds two disconnected islands: a frontend that
 * makes requests and a backend that answers them. This is where
 * `POST /api/customers` in a React handler becomes `CustomersController.create`.
 *
 * The leftovers are as useful as the matches: an unmatched call is usually a
 * typo'd URL or a method mismatch, and an orphan route is usually dead code.
 */
export function linkFrontendToBackend(graph: FlowGraph): SeamResult {
  const routes = graph.nodesOfKind('route').map((node) => ({
    id: node.id,
    method: String(node.meta?.['httpMethod'] ?? ''),
    path: String(node.meta?.['path'] ?? ''),
  }));

  const matchedRoutes = new Set<string>();
  const unmatchedCalls: string[] = [];
  let matched = 0;

  for (const call of graph.nodesOfKind('api-call')) {
    const candidate: RouteLike = {
      method: String(call.meta?.['httpMethod'] ?? ''),
      path: String(call.meta?.['path'] ?? ''),
    };
    const route = bestRouteMatch(candidate, routes);
    if (!route) {
      // Distinguish "no such endpoint" from "right path, wrong verb".
      const samePath = routes.filter((r) => r.path === candidate.path);
      if (samePath.length > 0) {
        call.meta = {
          ...call.meta,
          mismatch: 'method',
          availableMethods: samePath.map((r) => r.method),
        };
      } else {
        call.meta = { ...call.meta, mismatch: 'no-route' };
      }
      unmatchedCalls.push(call.id);
      continue;
    }
    graph.addEdge({ from: call.id, to: route.id, kind: 'handled-by' });
    matchedRoutes.add(route.id);
    matched += 1;
  }

  const orphanRoutes = routes.filter((route) => !matchedRoutes.has(route.id)).map((r) => r.id);
  for (const routeId of orphanRoutes) {
    const node = graph.node(routeId);
    if (node) node.meta = { ...node.meta, noKnownCaller: true };
  }

  return { matched, unmatchedCalls, orphanRoutes };
}

/**
 * Field-level data lineage: follow one value from the input the user typed to
 * the column it lands in.
 *
 *   state.note -> payload.note -> CreateOrderDto.note -> orders.note
 *
 * Matching is by name, which is what the code itself relies on — a DTO field
 * and a schema path only line up because they share a name.
 */
export function linkDataLineage(graph: FlowGraph): number {
  let links = 0;

  for (const call of graph.nodesOfKind('api-call')) {
    const payloadKeys = (call.meta?.['payloadKeys'] as string[] | undefined) ?? [];
    if (payloadKeys.length === 0) continue;
    const payloadSources = (call.meta?.['payloadSources'] as Record<string, string>) ?? {};

    const targets = lineageTargets(graph, call.id);

    for (const key of payloadKeys) {
      if (key.startsWith('...')) continue;
      const fieldId = ids.field(call.id, key);
      graph.addNode({
        id: fieldId,
        kind: 'field',
        label: key,
        meta: { owner: call.label, origin: 'payload' },
      });
      graph.addEdge({ from: call.id, to: fieldId, kind: 'defines' });

      // Upstream: which piece of component state fed this key?
      const sourceName = payloadSources[key];
      if (sourceName) {
        for (const handler of graph.predecessors(call.id, ['requests'])) {
          const state = graph
            .successors(handler.id, ['reads-state', 'writes-state'])
            .find((node) => node.label === sourceName);
          if (state) {
            graph.addEdge({ from: state.id, to: fieldId, kind: 'flows-to' });
            links += 1;
          }
        }
      }

      // Downstream: the DTO field, then the model field of the same name.
      let cursor = fieldId;
      for (const target of targets) {
        if (!target) continue;
        const targetField = graph
          .successors(target.id, ['defines'])
          .find((node) => node.kind === 'field' && node.label === key);
        if (!targetField) continue;
        graph.addEdge({ from: cursor, to: targetField.id, kind: 'flows-to' });
        cursor = targetField.id;
        links += 1;
      }
    }
  }

  return links;
}

/** Ranked so a field always flows payload -> dto -> model -> collection. */
const TARGET_ORDER = { dto: 0, model: 1, collection: 2 } as const;

/**
 * The schema-bearing nodes an endpoint eventually writes through.
 *
 * The DTO is reachable straight from the route (`validates`), but the *model*
 * is not: execution runs route -> controller method -> service method -> db-op
 * -> collection, and the model hangs off the collection rather than off that
 * chain. So the collection is found by traversal and the model by stepping one
 * edge back from it — otherwise lineage stops at the DTO and never reaches the
 * field the value is actually stored in.
 */
function lineageTargets(graph: FlowGraph, callId: string) {
  const reachable = graph.reachable(callId, {
    kinds: ['handled-by', 'calls', 'validates', 'queries', 'reads', 'writes', 'defines', 'injects'],
  });

  const found = new Map<string, { id: string; kind: 'dto' | 'model' | 'collection' }>();

  for (const id of reachable.keys()) {
    const node = graph.node(id);
    if (!node) continue;
    if (node.kind === 'dto' || node.kind === 'model' || node.kind === 'collection') {
      found.set(id, { id, kind: node.kind });
    }
    if (node.kind === 'collection') {
      for (const owner of graph.predecessors(id, ['defines'])) {
        if (owner.kind === 'model') found.set(owner.id, { id: owner.id, kind: 'model' });
      }
    }
  }

  return [...found.values()]
    .sort((a, b) => TARGET_ORDER[a.kind] - TARGET_ORDER[b.kind])
    .map((entry) => graph.node(entry.id));
}
