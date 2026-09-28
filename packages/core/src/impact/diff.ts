/**
 * What a branch changes about the app, not about the text.
 *
 * `git diff` shows the lines. A reviewer's real questions are one level up:
 * did an endpoint appear or disappear, does a collection have a new writer,
 * did this change introduce a route with no auth check or a query that forgets
 * the tenant — and which user actions does it reach that nothing tests. Those
 * are differences between two graphs, so this compares two graphs.
 *
 * Pure: it takes two scanned graphs and the findings for each, and knows
 * nothing about git. The CLI decides what the base is and how it was checked
 * out, which keeps this testable without a repository.
 */

import type { FlowGraph } from '../graph/graph.js';
import { resolveFlows } from '../flow/resolve.js';
import type { Finding, FindingSeverity } from '../flow/findings.js';

export interface ActionRef {
  id: string;
  title: string;
  endpoints: string[];
  source?: { file: string; line: number };
}

export interface GraphDiff {
  /** Actions that reach the backend, by id. */
  actions: { added: ActionRef[]; removed: ActionRef[] };
  /** Backend routes, as `METHOD /path`. */
  endpoints: { added: string[]; removed: string[] };
  /** Findings present on one side only, matched by kind, file and title. */
  findings: { introduced: Finding[]; resolved: Finding[] };
  /** Collections written from a place that did not write them before. */
  writers: Array<{ collection: string; added: string[]; before: string[] }>;
}

export function diffGraphs(
  base: { graph: FlowGraph; findings: readonly Finding[] },
  head: { graph: FlowGraph; findings: readonly Finding[] },
): GraphDiff {
  const actionsOf = (graph: FlowGraph): Map<string, ActionRef> =>
    new Map(
      resolveFlows(graph)
        .filter((flow) => flow.hitsBackend)
        .map((flow) => [
          flow.id,
          {
            id: flow.id,
            title: flow.title,
            endpoints: flow.endpoints,
            ...(flow.source ? { source: flow.source } : {}),
          },
        ]),
    );
  const before = actionsOf(base.graph);
  const after = actionsOf(head.graph);

  const routesOf = (graph: FlowGraph): Set<string> =>
    new Set(
      graph
        .nodesOfKind('route')
        .filter((node) => !node.meta?.['discoveredAtRuntime'])
        .map((node) => node.label),
    );
  const routesBefore = routesOf(base.graph);
  const routesAfter = routesOf(head.graph);

  /**
   * Matched by what the finding is about, not by line: an edit above a route
   * moves every line number below it, and a finding that "moved" is neither
   * new nor fixed.
   */
  const keyOf = (finding: Finding): string => `${finding.kind}|${finding.at.file}|${finding.title}`;
  const baseKeys = new Set(base.findings.map(keyOf));
  const headKeys = new Set(head.findings.map(keyOf));

  const writersBefore = writersOf(base.graph);
  const writersAfter = writersOf(head.graph);
  const writers: GraphDiff['writers'] = [];
  for (const [collection, now] of writersAfter) {
    const then = writersBefore.get(collection) ?? new Set<string>();
    const added = [...now].filter((writer) => !then.has(writer)).sort();
    // A collection the branch creates has no "before" to surprise anyone.
    if (added.length > 0 && then.size > 0) {
      writers.push({ collection, added, before: [...then].sort() });
    }
  }

  return {
    actions: {
      added: [...after.values()].filter((action) => !before.has(action.id)),
      removed: [...before.values()].filter((action) => !after.has(action.id)),
    },
    endpoints: {
      added: [...routesAfter].filter((route) => !routesBefore.has(route)).sort(),
      removed: [...routesBefore].filter((route) => !routesAfter.has(route)).sort(),
    },
    findings: {
      introduced: head.findings.filter((finding) => !baseKeys.has(keyOf(finding))),
      resolved: base.findings.filter((finding) => !headKeys.has(keyOf(finding))),
    },
    writers: writers.sort((a, b) => a.collection.localeCompare(b.collection)),
  };
}

/** True when a finding at or above `level` was introduced. */
export function introducesAtLeast(diff: GraphDiff, level: FindingSeverity): boolean {
  const rank: Record<FindingSeverity, number> = { high: 0, medium: 1, low: 2 };
  return diff.findings.introduced.some((finding) => rank[finding.severity] <= rank[level]);
}

/** collection -> the functions that write it, by name. */
function writersOf(graph: FlowGraph): Map<string, Set<string>> {
  const result = new Map<string, Set<string>>();
  for (const collection of graph.nodesOfKind('collection')) {
    const writers = new Set<string>();
    for (const op of graph.predecessors(collection.id, ['writes'])) {
      for (const owner of graph.predecessors(op.id, ['queries'])) writers.add(owner.label);
    }
    if (writers.size > 0) result.set(collection.label, writers);
  }
  return result;
}
