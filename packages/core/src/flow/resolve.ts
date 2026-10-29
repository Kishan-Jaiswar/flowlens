import { DB_EFFECT_ORDER, type DbEffect } from '../analyzer/mongo.js';
import type { CallGuard, PopupPresets } from '../analyzer/frontend.js';
import type { FlowGraph } from '../graph/graph.js';
import { ids, slug } from '../graph/ids.js';
import { humanizeName, isGenericComponentName } from '../analyzer/screens.js';
import {
  LAYER_OF,
  type EdgeKind,
  type Evidence,
  type FlowEdge,
  type FlowNode,
  type Layer,
  type NodeKind,
} from '../graph/types.js';

/** Edges that represent execution moving forward, in traversal order. */
export const EXECUTION_EDGES: readonly EdgeKind[] = [
  'triggers',
  'calls',
  'requests',
  'handled-by',
  /**
   * The guard runs before the handler, so it is execution, not annotation.
   *
   * Listed here rather than hung off the route as a detail because a reader
   * scanning the path for "why did this 403" needs to meet it in sequence — and
   * because a step that can stop the flow is the opposite of a footnote.
   */
  'guarded-by',
  'queries',
  'reads',
  'writes',
  /** The last step of a flow that finishes in somebody else's system. */
  'emits',
];

const LAYER_ORDER: Record<Layer, number> = {
  ui: 0,
  frontend: 1,
  network: 2,
  backend: 3,
  data: 4,
  // Last: whatever else happened, it happened after this app's own work.
  external: 5,
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
  /** Runs once a response is back: inside `onSuccess`, `onError` or `.then`. */
  afterResponse?: true;
  /** Runs later, in a background worker that took the job off a queue. */
  background?: true;
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
  /** State a handler assigns to (`setCustomers`) and reads. */
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
  /** Stable, URL-safe id: `create-customer`. */
  id: string;
  /** The words on the element the user clicks: `Submit`. */
  label: string;
  /**
   * Label plus where it lives: `Order · Submit`.
   *
   * What every list and tile shows, because `Submit` on its own does not tell a
   * reader which of the app's fifteen submits this is.
   */
  title: string;
  /** The part of the product this action belongs to: `Order`. */
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
  /** End-to-end time (the outermost span), when this action itself was traced. */
  totalMs?: number;
  /**
   * This action itself was traced: its own click, when the tracer records
   * clicks — not a request it shares, timed while another button sent it.
   */
  traced?: boolean;
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

  const actions = graph.nodesOfKind('ui-action');
  /**
   * `<Select onChange={…}>` written in MedicinesView is already its own action there —
   * "Category", "Supplier" — so the option click inside Select, named by its role
   * alone and only calling that `onChange`, says nothing more: one copy merged across
   * every Select on the page. A form's own "Save item" button still names it better.
   */
  const usedAt = new Set(
    actions.map(
      (action) => `${action.meta?.['component']}|${action.meta?.['tag']}|${action.meta?.['event']}`,
    ),
  );
  const repeatsItsSite = (action: FlowNode): boolean => {
    const props = action.meta?.['callsProps'] as string[] | undefined;
    const site = action.meta?.['site'];
    if (action.meta?.['namedByRole'] !== true || !props?.length) return false;
    // Relayed: the page's action it calls through is recorded on it.
    if ((action.meta?.['relayedBy'] as string[] | undefined)?.length) return true;
    return (
      typeof site === 'string' &&
      props.every((prop) => usedAt.has(`${site}|${action.meta?.['component']}|${prop}`))
    );
  };

  for (const action of actions) {
    if (repeatsItsSite(action)) continue;
    const flow = resolveFlow(graph, action.id);
    if (!flow) continue;

    // Two "Save" buttons in different components must not collide. Numbered
    // before the filter below, so an id names the same action with or without it.
    const seen = usedIds.get(flow.id);
    if (seen !== undefined) {
      usedIds.set(flow.id, seen + 1);
      flow.id = `${flow.id}-${seen + 1}`;
    } else {
      usedIds.set(flow.id, 1);
    }
    if (!flow.hitsBackend && !options.includeLocalOnly) continue;
    flows.push(flow);
  }

  return distinctTitles(graph, withoutRuntimeEchoes(graph, flows)).sort(
    (a, b) => b.risk.score - a.risk.score || a.title.localeCompare(b.title),
  );
}

/**
 * Tell apart two actions that would otherwise share a title.
 *
 * "Medicines · Delete" on the list and on the detail page are two actions
 * with two different code paths, but the screen phrase drops the `:id` that
 * separates their pages, and the sidebar showed the same line twice. The
 * component each lives in is what a developer would call them by; the page
 * route, the file and the line are the fallbacks when that is shared too.
 */
function distinctTitles(graph: FlowGraph, flows: FeatureFlow[]): FeatureFlow[] {
  const byTitle = new Map<string, FeatureFlow[]>();
  for (const flow of flows) {
    const group = byTitle.get(flow.title);
    if (group) group.push(flow);
    else byTitle.set(flow.title, [flow]);
  }

  const hints: Array<(flow: FeatureFlow) => string | undefined> = [
    (flow) =>
      flow.component && !isGenericComponentName(flow.component)
        ? humanizeName(flow.component)
        : undefined,
    (flow) => {
      const page = graph.node(flow.entryNodeId)?.meta?.['page'];
      return typeof page === 'string' ? page : undefined;
    },
    // `TimeSlotPopup.js` and `TimeSlotPopupNew.js` both define `TimeSlotPopup`:
    // the file's own name says which, without the whole path in the sidebar.
    (flow) => {
      const base = flow.source?.file
        .split('/')
        .pop()
        ?.replace(/\.[cm]?[jt]sx?$/, '');
      return base && base !== 'index' ? humanizeName(base) : undefined;
    },
    (flow) => flow.source?.file,
    // Two "Cancel" buttons in one form: only where they sit tells them apart.
    (flow) => (flow.source ? `line ${flow.source.line}` : undefined),
  ];
  /**
   * The first hint that tells any of them apart, then the next only within
   * the ones still alike: the detail page's Delete is "(Medicine detail page)",
   * and only the list's two need a line.
   */
  const parts = new Map<FeatureFlow, string[]>();
  const split = (group: FeatureFlow[], from: number): void => {
    for (let index = from; index < hints.length; index++) {
      const values = group.map(hints[index]!);
      if (!values.every(Boolean) || new Set(values).size < 2) continue;
      const alike = new Map<string, FeatureFlow[]>();
      group.forEach((flow, at) => {
        parts.set(flow, [...(parts.get(flow) ?? []), values[at]!]);
        alike.set(values[at]!, [...(alike.get(values[at]!) ?? []), flow]);
      });
      for (const same of alike.values()) if (same.length > 1) split(same, index + 1);
      return;
    }
  };
  for (const group of byTitle.values()) if (group.length > 1) split(group, 0);
  for (const [flow, said] of parts) flow.title = `${flow.title} (${said.join(', ')})`;
  return flows;
}

/**
 * Drop clicks seen only at runtime whose requests a declared action already makes.
 *
 * The browser tracer records every click on a button or link, including the
 * ones no handler in the source is wired to by name: the "Yes, delete it" of a
 * confirm dialog, a nav link, a table row. Each became an action of its own —
 * titled with whatever text it had, a medicine's name included — repeating
 * requests that already belong to a real action. Their timings and status
 * codes are kept, because those live on the shared steps; only the duplicate
 * entry in the list goes. A runtime click that reaches an endpoint no declared
 * action reaches is still listed: that is something the source reading missed.
 */
function withoutRuntimeEchoes(graph: FlowGraph, flows: FeatureFlow[]): FeatureFlow[] {
  const isRuntimeOnly = (flow: FeatureFlow): boolean =>
    graph.node(flow.entryNodeId)?.meta?.['discoveredAtRuntime'] === true;

  const declared = new Set<string>();
  for (const flow of flows) {
    if (isRuntimeOnly(flow)) continue;
    for (const step of flow.steps) if (step.kind === 'api-call') declared.add(step.nodeId);
  }

  return flows.filter(
    (flow) =>
      !isRuntimeOnly(flow) ||
      flow.steps.some((step) => step.kind === 'api-call' && !declared.has(step.nodeId)),
  );
}

/** Resolve a single flow from a UI action (or any other entry node). */
/**
 * What one action runs, as `graph.reachable` finds it — less the calls a popup's
 * opener rules out. Opened with `data.reschedule` set to true, the popup's
 * `reschedule ? rescheduleApp() : createAppointment()` runs only `rescheduleApp`.
 */
function reachableFrom(graph: FlowGraph, entryNodeId: string): Map<string, number> {
  const depths = new Map<string, number>();
  if (!graph.hasNode(entryNodeId)) return depths;
  depths.set(entryNodeId, 0);
  const queue: Array<[string, number, PopupPresets[]]> = [[entryNodeId, 0, []]];
  while (queue.length > 0) {
    const [id, depth, presets] = queue.shift()!;
    for (const edge of graph.edgesFrom(id, EXECUTION_EDGES)) {
      if (ruledOut(graph, edge, presets) || depths.has(edge.to)) continue;
      depths.set(edge.to, depth + 1);
      const handed = edge.meta?.['presets'] as PopupPresets | undefined;
      queue.push([edge.to, depth + 1, handed ? [...presets, handed] : presets]);
    }
  }
  return depths;
}

function ruledOut(graph: FlowGraph, edge: FlowEdge, presets: readonly PopupPresets[]): boolean {
  const guard = edge.meta?.['guard'] as CallGuard | undefined;
  if (!guard || presets.length === 0) return false;
  const component = graph.node(edge.from)?.meta?.['component'];
  return presets.some(
    (handed) =>
      handed.component === component &&
      guard.path in handed.values &&
      Boolean(handed.values[guard.path]) !== guard.truthy,
  );
}

export function resolveFlow(graph: FlowGraph, entryNodeId: string): FeatureFlow | undefined {
  const entry = graph.node(entryNodeId);
  if (!entry) return undefined;

  const depths = reachableFrom(graph, entryNodeId);
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

  // Read top to bottom: UI, frontend, network, then the server and its data in
  // the order the code runs them — a query sits under the function that runs it.
  const { order, afterResponse, background } = executionOrder(graph, entryNodeId);
  const rank = (step: FlowStep): number => {
    // A queued job runs in a worker, after the request has already answered.
    if (background.has(step.nodeId)) return LAYER_ORDER.backend + 0.75;
    // `onSuccess`, `.then`: what the screen does once the answer is back.
    if (afterResponse.has(step.nodeId)) return LAYER_ORDER.backend + 0.5;
    if (step.layer === 'data') return LAYER_ORDER.backend;
    // An in-process effect (a cache, a log) with a line runs where it is written.
    if (step.layer === 'external' && step.line !== undefined) return LAYER_ORDER.backend;
    return LAYER_ORDER[step.layer];
  };
  for (const step of steps) {
    if (afterResponse.has(step.nodeId)) step.afterResponse = true;
    if (background.has(step.nodeId)) step.background = true;
  }
  steps.sort(
    (a, b) =>
      rank(a) - rank(b) ||
      (order.get(a.nodeId) ?? Infinity) - (order.get(b.nodeId) ?? Infinity) ||
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
  // Only an action whose own request (or, with none, its handler) was traced
  // has a time: a shared lookup timed in another action is that action's.
  const ownSteps = steps.filter((step) => step.kind === 'api-call' || step.kind === 'route');
  // Where clicks are traced, a click is timed only if it was itself made:
  // the shared GET /medicines timed from Search is not the Category filter's.
  const ownTimed =
    entry.kind === 'ui-action' && entry.meta?.['event'] !== 'mount' && clicksTraced(graph)
      ? entry.timing !== undefined
      : (ownSteps.length > 0
          ? ownSteps
          : steps.filter((step) => step.kind === 'ui-action' || step.kind === 'handler')
        ).some((step) => step.avgMs !== undefined || step.avgSelfMs !== undefined);
  // End to end: the outermost span, which contains the rest. Adding up the
  // steps counts the queries a `Promise.all` runs side by side once each.
  const totalMs =
    timed.length > 0 && ownTimed
      ? round(Math.max(...steps.map((step) => step.avgMs ?? step.avgSelfMs ?? 0)))
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
    ...(timed.length > 0 ? { traced: ownTimed } : {}),
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
 * in `customer_detail` showed its network step as living in
 * `components/RequestPaymentPopup.js` — code on a different screen entirely,
 * which is exactly how a correct flow comes to look like a dump of the whole
 * page. The `requests` edge knows better: it was written at the real call site.
 */
/**
 * Each node's place in the order the code runs: depth-first from the entry,
 * every function's calls visited in the order they appear in its body.
 *
 * Breadth-first depth with an alphabetical tiebreak put `getDashboardStats`
 * before the `requireClinic` the handler calls first. A call's position is the
 * line the edge was written at, else — for a query, read or write, whose node
 * is the call itself — that node's line when it sits in the caller's file.
 * Edges with neither keep graph order,
 * after the placed ones — a runtime shortcut from a route straight to a query
 * must not pull the query ahead of the handler that runs it.
 */
function executionOrder(
  graph: FlowGraph,
  entryNodeId: string,
): { order: Map<string, number>; afterResponse: Set<string>; background: Set<string> } {
  const order = new Map<string, number>();
  const afterResponse = new Set<string>();
  const background = new Set<string>();
  const visit = (id: string, after: boolean, later: boolean): void => {
    order.set(id, order.size);
    if (after) afterResponse.add(id);
    if (later) background.add(id);
    const from = graph.node(id);
    const placed = graph.edgesFrom(id, EXECUTION_EDGES).map((edge, index) => {
      const target = graph.node(edge.to);
      const line = edge.meta?.['line'];
      const position =
        typeof line === 'number'
          ? line
          : // A query's own line is where it runs; a function's is where it is defined.
            edge.kind !== 'calls' &&
              target?.source &&
              from?.source &&
              target.source.file === from.source.file
            ? target.source.line
            : Infinity;
      const end = edge.meta?.['end'];
      return {
        to: edge.to,
        position,
        end: typeof end === 'number' ? end : Infinity,
        index,
        after: after || edge.meta?.['afterResponse'] === true,
        later: later || edge.meta?.['background'] === true,
      };
    });
    placed.sort((a, b) => a.position - b.position || a.end - b.end || a.index - b.index);
    for (const next of placed) if (!order.has(next.to)) visit(next.to, next.after, next.later);
  };
  visit(entryNodeId, false, false);
  return { order, afterResponse, background };
}

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
 * One entry per collection *per effect*, so a flow that inserts into `customers`
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

  // Every step seen running is not this action seen running: they may all
  // have run under other buttons.
  if (flow.evidence === 'confirmed' && flow.traced !== false) {
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

const CLICKS_TRACED = new WeakMap<FlowGraph, boolean>();
/** The browser tracer ran: some click has a span of its own. */
function clicksTraced(graph: FlowGraph): boolean {
  let found = CLICKS_TRACED.get(graph);
  if (found === undefined) {
    found = graph
      .nodesOfKind('ui-action')
      .some((node) => node.timing !== undefined && node.meta?.['event'] !== 'mount');
    CLICKS_TRACED.set(graph, found);
  }
  return found;
}
