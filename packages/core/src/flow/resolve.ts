import type { FlowGraph } from '../graph/graph.js';
import { slug } from '../graph/ids.js';
import {
  LAYER_OF,
  type EdgeKind,
  type Evidence,
  type Layer,
  type NodeKind,
} from '../graph/types.js';

/** Edges that represent execution moving forward, in traversal order. */
export const EXECUTION_EDGES: readonly EdgeKind[] = [
  'triggers',
  'calls',
  'requests',
  'handled-by',
  'queries',
  'reads',
  'writes',
];

const LAYER_ORDER: Record<Layer, number> = {
  ui: 0,
  frontend: 1,
  network: 2,
  backend: 3,
  data: 4,
};

export interface FlowStep {
  nodeId: string;
  kind: NodeKind;
  label: string;
  layer: Layer;
  /** Distance from the entry point, used for indentation. */
  depth: number;
  evidence: Evidence;
  file?: string;
  line?: number;
  /** Inclusive: this step and everything it called. */
  avgMs?: number;
  /** Exclusive: this step alone. Only these may be summed. */
  avgSelfMs?: number;
  observations?: number;
  meta?: Record<string, unknown>;
}

export interface CollectionAccess {
  collection: string;
  access: 'read' | 'write';
  operations: string[];
}

export interface FeatureFlow {
  /** Stable, URL-safe id: `create-patient`. */
  id: string;
  label: string;
  component?: string;
  event?: string;
  entryNodeId: string;
  steps: FlowStep[];
  /** State the handler reads or writes. */
  state: string[];
  endpoints: string[];
  controllers: string[];
  services: string[];
  collections: CollectionAccess[];
  /** Weakest evidence along the path: a flow is only confirmed end to end. */
  evidence: Evidence;
  /** Sum of average step timings, when runtime data exists. */
  totalMs?: number;
  /** True when the flow reaches the backend at all. */
  hitsBackend: boolean;
  risk: RiskScore;
  source?: { file: string; line: number };
}

export interface RiskScore {
  score: number;
  level: 'low' | 'medium' | 'high';
  reasons: string[];
}

export interface ResolveOptions {
  /** Include UI actions that never reach an API call (pure local interactions). */
  includeLocalOnly?: boolean;
}

/**
 * Every feature flow in the app, one per user action.
 *
 * This is the function that answers the product's core question — "I clicked
 * this button, show me everything that happened" — for the whole codebase at
 * once, which is what the flow list and the dashboard render.
 */
export function resolveFlows(graph: FlowGraph, options: ResolveOptions = {}): FeatureFlow[] {
  const flows: FeatureFlow[] = [];
  const usedIds = new Map<string, number>();

  for (const action of graph.nodesOfKind('ui-action')) {
    const flow = resolveFlow(graph, action.id);
    if (!flow) continue;
    if (!flow.hitsBackend && !options.includeLocalOnly) continue;

    // Two "Save" buttons in different components must not collide.
    const seen = usedIds.get(flow.id);
    if (seen !== undefined) {
      usedIds.set(flow.id, seen + 1);
      flow.id = `${flow.id}-${seen + 1}`;
    } else {
      usedIds.set(flow.id, 1);
    }
    flows.push(flow);
  }

  return flows.sort((a, b) => b.risk.score - a.risk.score || a.label.localeCompare(b.label));
}

/** Resolve a single flow from a UI action (or any other entry node). */
export function resolveFlow(graph: FlowGraph, entryNodeId: string): FeatureFlow | undefined {
  const entry = graph.node(entryNodeId);
  if (!entry) return undefined;

  const depths = graph.reachable(entryNodeId, { kinds: EXECUTION_EDGES });
  const steps: FlowStep[] = [];

  for (const [nodeId, depth] of depths) {
    const node = graph.node(nodeId);
    if (!node) continue;
    steps.push({
      nodeId,
      kind: node.kind,
      label: node.label,
      layer: LAYER_OF[node.kind],
      depth,
      evidence: node.evidence,
      ...(node.source ? { file: node.source.file, line: node.source.line } : {}),
      ...(node.timing ? { avgMs: node.timing.avgMs, avgSelfMs: node.timing.avgSelfMs } : {}),
      ...(node.observations ? { observations: node.observations } : {}),
      ...(node.meta ? { meta: node.meta } : {}),
    });
  }

  // Read top to bottom: UI, frontend, network, backend, data.
  steps.sort(
    (a, b) =>
      LAYER_ORDER[a.layer] - LAYER_ORDER[b.layer] ||
      a.depth - b.depth ||
      a.label.localeCompare(b.label),
  );

  const handlers = graph.successors(entryNodeId, ['triggers']);
  const state = [
    ...new Set(
      handlers.flatMap((handler) =>
        graph.successors(handler.id, ['reads-state', 'writes-state']).map((node) => node.label),
      ),
    ),
  ].sort();

  const endpoints = unique(steps.filter((s) => s.kind === 'api-call').map((s) => s.label));
  const routes = steps.filter((s) => s.kind === 'route');
  const controllers = unique(
    routes.map((route) => String(route.meta?.['controller'] ?? '')).filter(Boolean),
  );
  const services = unique(
    steps
      .filter((s) => s.kind === 'method' && s.meta?.['layer'] === 'service')
      .map((s) => String(s.meta?.['class'] ?? ''))
      .filter(Boolean),
  );
  const collections = collectionAccesses(steps);

  const evidence = weakestEvidence(steps);
  // Exclusive times, because a trace is nested: the client round trip contains
  // the server span, which contains the service, which contains the query.
  const timed = steps.filter((step) => step.avgSelfMs !== undefined);
  const totalMs =
    timed.length > 0
      ? round(timed.reduce((sum, step) => sum + (step.avgSelfMs ?? 0), 0))
      : undefined;

  const component = entry.meta?.['component'] ? String(entry.meta['component']) : undefined;
  const event = entry.meta?.['event'] ? String(entry.meta['event']) : undefined;

  const flow: FeatureFlow = {
    id: slug(`${component ?? 'app'}-${entry.label}`) || slug(entry.id),
    label: entry.label,
    ...(component ? { component } : {}),
    ...(event ? { event } : {}),
    entryNodeId,
    steps,
    state,
    endpoints,
    controllers,
    services,
    collections,
    evidence,
    ...(totalMs !== undefined ? { totalMs } : {}),
    hitsBackend: endpoints.length > 0 || routes.length > 0,
    risk: { score: 0, level: 'low', reasons: [] },
    ...(entry.source ? { source: { file: entry.source.file, line: entry.source.line } } : {}),
  };

  flow.risk = scoreRisk(graph, flow);
  return flow;
}

function collectionAccesses(steps: FlowStep[]): CollectionAccess[] {
  const map = new Map<string, CollectionAccess>();
  for (const step of steps) {
    if (step.kind !== 'db-op') continue;
    const collection = String(step.meta?.['collection'] ?? '');
    const access = step.meta?.['access'] === 'write' ? 'write' : 'read';
    const operation = String(step.meta?.['operation'] ?? '');
    const key = `${collection}:${access}`;
    const existing = map.get(key);
    if (existing) {
      if (operation && !existing.operations.includes(operation))
        existing.operations.push(operation);
    } else {
      map.set(key, { collection, access, operations: operation ? [operation] : [] });
    }
  }
  return [...map.values()].sort(
    (a, b) => a.collection.localeCompare(b.collection) || a.access.localeCompare(b.access),
  );
}

/**
 * A chain is only as trustworthy as its weakest link: one inferred hop makes
 * the whole flow inferred, however much runtime data surrounds it.
 */
function weakestEvidence(steps: FlowStep[]): Evidence {
  let sawStatic = false;
  let sawRuntime = false;
  for (const step of steps) {
    if (step.evidence === 'static') sawStatic = true;
    if (step.evidence === 'runtime') sawRuntime = true;
    if (step.evidence === 'confirmed') {
      sawStatic = true;
      sawRuntime = true;
    }
  }
  if (sawStatic && sawRuntime) return 'confirmed';
  if (sawRuntime) return 'runtime';
  return 'static';
}

/**
 * How dangerous is it to change this feature?
 *
 * Kept deliberately transparent — every point is explained in `reasons`, so a
 * developer can disagree with the number and still learn something from it.
 */
export function scoreRisk(graph: FlowGraph, flow: FeatureFlow): RiskScore {
  let score = 0;
  const reasons: string[] = [];

  const writes = flow.collections.filter((c) => c.access === 'write');
  if (writes.length > 0) {
    score += writes.length * 15;
    reasons.push(
      `writes to ${writes.length} collection${writes.length > 1 ? 's' : ''}: ${writes
        .map((w) => w.collection)
        .join(', ')}`,
    );
  }

  const destructive = flow.steps.filter((step) => {
    const operation = String(step.meta?.['operation'] ?? '');
    return /delete|remove|drop/i.test(operation);
  });
  if (destructive.length > 0) {
    score += 20;
    reasons.push(`performs a destructive operation (${destructive[0]?.label})`);
  }

  // A service used by many other methods is a shared blast radius.
  for (const step of flow.steps) {
    if (step.kind !== 'method') continue;
    const callers = graph.predecessors(step.nodeId, ['calls']).length;
    if (callers >= 3) {
      score += 10;
      reasons.push(`${step.label} is called from ${callers} places`);
    }
  }

  if (flow.collections.length >= 3) {
    score += 10;
    reasons.push(`touches ${flow.collections.length} collections in one action`);
  }

  if (flow.endpoints.length > 1) {
    score += 5;
    reasons.push(`fires ${flow.endpoints.length} API calls`);
  }

  const unmatched = flow.steps.filter((step) => step.meta?.['mismatch']);
  if (unmatched.length > 0) {
    score += 25;
    reasons.push(`${unmatched.length} API call(s) have no matching backend route`);
  }

  const unresolved = flow.steps.filter((step) => step.meta?.['unresolved']);
  if (unresolved.length > 0) {
    score += 5;
    reasons.push('handler could not be resolved statically — trace at runtime to confirm');
  }

  if (flow.evidence === 'confirmed') {
    score = Math.max(0, score - 10);
    reasons.push('confirmed by runtime tracing');
  }

  const level = score >= 45 ? 'high' : score >= 20 ? 'medium' : 'low';
  return { score, level, reasons };
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}
