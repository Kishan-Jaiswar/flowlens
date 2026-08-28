import { DB_EFFECT_ORDER, type DbEffect } from '../analyzer/mongo.js';
import type { FlowGraph } from '../graph/graph.js';
import { ids, slug } from '../graph/ids.js';
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
  /** Everything hanging off this step that is not a call. */
  detail?: StepDetail;
}

/**
 * The facts hanging off a step that are not themselves execution.
 *
 * The chain of *calls* is only half the answer. "Which handler ran" is not
 * useful without "and what state did it set, what did it send, which DTO
 * validated it, which schema stored it". Those live on non-execution edges
 * (`defines`, `validates`, `reads-state`, `writes-state`), so a reachability
 * walk drops them — they are attached here instead, one hop out from the step
 * they belong to.
 */
export interface StepDetail {
  /** Component that renders a ui-action. */
  component?: string;
  /** State a handler assigns to (`setPatients`) and reads. */
  statesWritten?: string[];
  statesRead?: string[];
  /** Custom hooks a handler or component calls. */
  hooks?: string[];
  /** Query-string parameters on an api-call. */
  queryKeys?: string[];
  /** Request body keys, and the identifier each came from. */
  payloadKeys?: string[];
  payloadSources?: Record<string, string>;
  /** The exact call site this flow goes through. */
  callSite?: string;
  /** DTOs a route validates its input against, with their fields. */
  dtos?: Array<{ name: string; file?: string; fields: string[] }>;
  /** The schema behind a db-op, and the fields it declares. */
  schema?: { model: string; collection: string; file?: string; fields: string[] };
  /** Class and role behind a backend method step. */
  className?: string;
  classRole?: string;
}

export interface CollectionAccess {
  collection: string;
  access: 'read' | 'write';
  /**
   * What the action does to this collection: where data is read from, inserted
   * into, updated in or removed from. `write` when the operation's effect is not
   * knowable statically (`save`, `bulkWrite`).
   */
  effect: DbEffect;
  operations: string[];
}

export interface FeatureFlow {
  /** Stable, URL-safe id: `create-patient`. */
  id: string;
  /** The words on the element the user clicks: `Submit`. */
  label: string;
  /**
   * Label plus where it lives: `Prescription · Submit`.
   *
   * What every list and tile shows, because `Submit` on its own does not tell a
   * reader which of the app's fifteen submits this is.
   */
  title: string;
  /** The part of the product this action belongs to: `Prescription`. */
  screen?: string;
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
  /** DTOs validating input anywhere along the chain. */
  dtos: string[];
  /** Schemas behind the collections this action touches. */
  schemas: Array<{ model: string; collection: string }>;
  /** Custom hooks used anywhere along the chain. */
  hooks: string[];
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

  return flows.sort((a, b) => b.risk.score - a.risk.score || a.title.localeCompare(b.title));
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

  attributeCallSites(graph, steps, depths);

  // Read top to bottom: UI, frontend, network, backend, data.
  steps.sort(
    (a, b) =>
      LAYER_ORDER[a.layer] - LAYER_ORDER[b.layer] ||
      a.depth - b.depth ||
      a.label.localeCompare(b.label),
  );

  /**
   * State touched anywhere in the chain, not just by the handler the click is
   * wired to.
   *
   * A click usually calls a handler that calls two more, and the state those set
   * is just as much part of what the click did. Reading only the directly
   * triggered handlers reported no state for half the actions in a real app.
   */
  const state = [
    ...new Set(
      steps.flatMap((step) =>
        step.kind === 'handler' || step.kind === 'hook' || step.kind === 'ui-action'
          ? graph.successors(step.nodeId, ['reads-state', 'writes-state']).map((node) => node.label)
          : [],
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

  // Attach the non-execution facts before the rollups read them.
  for (const step of steps) {
    const detail = stepDetail(graph, step);
    if (detail) step.detail = detail;
  }

  const dtos = unique(steps.flatMap((s) => (s.detail?.dtos ?? []).map((d) => d.name)));
  const schemas = uniqueBy(
    steps
      .map((s) => s.detail?.schema)
      .filter((schema): schema is NonNullable<typeof schema> => Boolean(schema))
      .map(({ model, collection }) => ({ model, collection })),
    (entry) => `${entry.model}:${entry.collection}`,
  );
  const hooks = unique([
    ...steps.filter((s) => s.kind === 'hook').map((s) => s.label),
    ...steps.flatMap((s) => s.detail?.hooks ?? []),
  ]);

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
  const screen = entry.meta?.['screen'] ? String(entry.meta['screen']) : undefined;
  const title = entry.meta?.['title'] ? String(entry.meta['title']) : entry.label;

  const flow: FeatureFlow = {
    id: slug(`${component ?? 'app'}-${entry.label}`) || slug(entry.id),
    label: entry.label,
    title,
    ...(screen ? { screen } : {}),
    ...(component ? { component } : {}),
    ...(event ? { event } : {}),
    entryNodeId,
    steps,
    state,
    endpoints,
    controllers,
    services,
    collections,
    dtos,
    schemas,
    hooks,
    evidence,
    ...(totalMs !== undefined ? { totalMs } : {}),
    hitsBackend: endpoints.length > 0 || routes.length > 0,
    risk: { score: 0, level: 'low', reasons: [] },
    ...(entry.source ? { source: { file: entry.source.file, line: entry.source.line } } : {}),
  };

  flow.risk = scoreRisk(graph, flow);
  return flow;
}

/**
 * Point every `api-call` step at the call site *this* flow goes through.
 *
 * There is one api-call node per method+path, shared by every caller in the app,
 * so its own `source` is just the first site the scan read. Left alone, a click
 * in `patient_detail` showed its network step as living in
 * `components/RequestPaymentPopup.js` — code on a different screen entirely,
 * which is exactly how a correct flow comes to look like a dump of the whole
 * page. The `requests` edge knows better: it was written at the real call site.
 */
function attributeCallSites(
  graph: FlowGraph,
  steps: FlowStep[],
  depths: Map<string, number>,
): void {
  for (const step of steps) {
    if (step.kind !== 'api-call') continue;

    const edges = graph.edgesTo(step.nodeId, ['requests']);
    // Callers that this flow actually passes through, nearest to the click first.
    const mine = edges
      .filter((edge) => depths.has(edge.from))
      .sort((a, b) => (depths.get(a.from) ?? 0) - (depths.get(b.from) ?? 0));

    const nearest = mine[0];
    const file = nearest?.meta?.['file'];
    const line = nearest?.meta?.['line'];
    if (typeof file === 'string') step.file = file;
    if (typeof line === 'number') step.line = line;

    const elsewhere = edges.length - mine.length;
    if (elsewhere > 0) {
      step.meta = { ...step.meta, otherCallers: elsewhere };
    }
  }
}

/**
 * One entry per collection *per effect*, so a flow that inserts into `patients`
 * and also edits them reads as two facts rather than one vague "writes".
 *
 * Ordered by effect, not alphabetically: reads first, because that is where the
 * data on screen came from, then the mutations in the order they escalate.
 */
function collectionAccesses(steps: FlowStep[]): CollectionAccess[] {
  const map = new Map<string, CollectionAccess>();
  for (const step of steps) {
    if (step.kind !== 'db-op') continue;
    const collection = String(step.meta?.['collection'] ?? '');
    const access = step.meta?.['access'] === 'write' ? 'write' : 'read';
    // Older graphs (scanned before effects existed) carry only `access`.
    const raw = step.meta?.['effect'];
    const effect = (DB_EFFECT_ORDER.includes(raw as DbEffect) ? raw : access) as DbEffect;
    const operation = String(step.meta?.['operation'] ?? '');
    const key = `${collection}:${effect}`;
    const existing = map.get(key);
    if (existing) {
      if (operation && !existing.operations.includes(operation))
        existing.operations.push(operation);
    } else {
      map.set(key, { collection, access, effect, operations: operation ? [operation] : [] });
    }
  }
  return [...map.values()].sort(
    (a, b) =>
      DB_EFFECT_ORDER.indexOf(a.effect) - DB_EFFECT_ORDER.indexOf(b.effect) ||
      a.collection.localeCompare(b.collection),
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

  /**
   * Counted per collection, not per collection-and-effect.
   *
   * `collections` holds one entry per effect, so a collection that is inserted
   * into and later updated appears twice — listing it twice reads as two
   * collections and scored it as two.
   */
  const written = [
    ...new Set(flow.collections.filter((c) => c.access === 'write').map((c) => c.collection)),
  ].sort();
  if (written.length > 0) {
    score += written.length * 15;
    reasons.push(
      `writes to ${written.length} collection${written.length > 1 ? 's' : ''}: ${written.join(', ')}`,
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

  const touched = new Set(flow.collections.map((c) => c.collection));
  if (touched.size >= 3) {
    score += 10;
    reasons.push(`touches ${touched.size} collections in one action`);
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

/**
 * The facts one hop off a step, chosen by what the step is.
 *
 * Deliberately one hop and no further: the graph is dense enough that walking
 * `defines` transitively from a component would pull in half the app, and a
 * detail panel listing half the app answers nothing.
 */
function stepDetail(graph: FlowGraph, step: FlowStep): StepDetail | undefined {
  const detail: StepDetail = {};

  if (step.kind === 'ui-action') {
    const owner = graph.predecessors(step.nodeId, ['renders'])[0];
    if (owner) {
      detail.component = owner.label;
      /**
       * Hooks belong to the action even though they are not on its call path.
       *
       * React requires hooks to be called in the component body, not inside a
       * handler, so a reachability walk from the click never reaches them —
       * which is why a 500-file app reported hooks on 5 of 1082 actions. They
       * are attached to the action instead, via the component that renders it.
       */
      const hooks = graph
        .successors(owner.id, ['calls'])
        .filter((node) => node.kind === 'hook')
        .map((node) => node.label);
      if (hooks.length > 0) detail.hooks = unique(hooks).sort();
    }
  }

  // A handler is where state changes, and where custom hooks are called.
  if (step.kind === 'handler' || step.kind === 'hook' || step.kind === 'method') {
    const written = graph.successors(step.nodeId, ['writes-state']).map((node) => node.label);
    const read = graph.successors(step.nodeId, ['reads-state']).map((node) => node.label);
    if (written.length > 0) detail.statesWritten = unique(written).sort();
    if (read.length > 0) detail.statesRead = unique(read).sort();

    const hooks = graph
      .successors(step.nodeId, ['calls'])
      .filter((node) => node.kind === 'hook')
      .map((node) => node.label);
    if (hooks.length > 0) detail.hooks = unique(hooks).sort();
  }

  if (step.kind === 'api-call') {
    const query = (step.meta?.['queryKeys'] as string[] | undefined) ?? [];
    const payload = (step.meta?.['payloadKeys'] as string[] | undefined) ?? [];
    const sources = step.meta?.['payloadSources'] as Record<string, string> | undefined;
    if (query.length > 0) detail.queryKeys = query;
    if (payload.length > 0) detail.payloadKeys = payload;
    if (sources && Object.keys(sources).length > 0) detail.payloadSources = sources;
    // `attributeCallSites` already narrowed this to the site this flow uses.
    if (step.file) detail.callSite = `${step.file}${step.line ? `:${step.line}` : ''}`;
  }

  // The DTO is the backend's declared shape of the request body.
  if (step.kind === 'route') {
    const dtos = graph.successors(step.nodeId, ['validates']).map((node) => ({
      name: node.label,
      ...(node.source ? { file: node.source.file } : {}),
      fields: graph
        .successors(node.id, ['defines'])
        .filter((field) => field.kind === 'field')
        .map((field) => field.label),
    }));
    if (dtos.length > 0) detail.dtos = dtos;
  }

  // The schema is what the collection's documents actually look like.
  if (step.kind === 'db-op') {
    const modelName = step.meta?.['model'] ? String(step.meta['model']) : undefined;
    const model = modelName ? graph.node(ids.model(modelName)) : undefined;
    if (model) {
      detail.schema = {
        model: model.label,
        collection: String(model.meta?.['collection'] ?? step.meta?.['collection'] ?? ''),
        ...(model.source ? { file: model.source.file } : {}),
        fields: graph
          .successors(model.id, ['defines'])
          .filter((field) => field.kind === 'field')
          .map((field) => field.label),
      };
    }
  }

  if (step.kind === 'method') {
    if (step.meta?.['class']) detail.className = String(step.meta['class']);
    if (step.meta?.['layer']) detail.classRole = String(step.meta['layer']);
  }

  return Object.keys(detail).length > 0 ? detail : undefined;
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

function uniqueBy<T>(values: T[], key: (value: T) => string): T[] {
  const seen = new Map<string, T>();
  for (const value of values) if (!seen.has(key(value))) seen.set(key(value), value);
  return [...seen.values()];
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}
