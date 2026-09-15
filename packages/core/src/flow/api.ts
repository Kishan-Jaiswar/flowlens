/**
 * Everything about the requests one user action makes.
 *
 * The flow view shows the request as two tiles — the call and the route it
 * matched — because its job is the shape of the whole chain. But the seam is
 * where most of the questions actually are: what exactly is in the body, which
 * of those keys the route admits to accepting, what runs before the handler,
 * which collections the handler reaches, and who *else* calls the same
 * endpoint. Each of those was reachable by clicking around the graph; none of
 * them was on one screen.
 *
 * This assembles the per-endpoint answer, including the contract check, so that
 * "what does this API do and who depends on it" is one read rather than six
 * clicks.
 */

import type { FlowGraph } from '../graph/graph.js';
import type { FlowNode } from '../graph/types.js';
import { checkFlowContract, type ContractCheck } from './contract.js';
import { resolveFlows, type FeatureFlow } from './resolve.js';

export interface ApiField {
  name: string;
  /** The component state or variable the value came from. */
  from?: string;
}

export interface ApiRoute {
  method: string;
  path: string;
  /** `nestjs`, `express`, `file-route` — how the route was declared. */
  framework?: string;
  /** The controller class, when there is one. */
  controller?: string;
  /** The method or function that answers the request. */
  handler?: string;
  file?: string;
  line?: number;
}

export interface ApiDataAccess {
  collection: string;
  operation: string;
  /** read | create | update | delete | write */
  effect: string;
  /** The method that issues it, so there is something to open. */
  by?: string;
  file?: string;
  line?: number;
}

export interface ApiCallDetail {
  /** `POST /orders` — the normalised endpoint both sides agree on. */
  endpoint: string;
  method: string;
  path: string;
  /** The URL as written in the frontend, before any prefix was stripped. */
  rawPath?: string;
  /** The identifier used to make the call: `axios`, `api`, a wrapper name. */
  client?: string;
  /** Every place in the frontend that makes this call. */
  callSites: string[];
  /** Keys in the request body, and where each value comes from. */
  payload: ApiField[];
  /** Query-string keys read at the call site. */
  queryKeys: string[];

  /** False when no backend route matched — the call goes nowhere in this repo. */
  matched: boolean;
  route?: ApiRoute;

  /** Guards, interceptors and middleware that run before the handler. */
  middleware: Array<{ name: string; role: string; file?: string; line?: number }>;
  /** The request-validation object, when the route declares one. */
  dto?: { name: string; fields: ApiField[] };
  /** Controller and service methods this request runs, in call order. */
  handlers: Array<{ label: string; kind: string; file?: string; line?: number }>;
  /** Collections the request reads or writes. */
  data: ApiDataAccess[];
  /** Work that leaves the app on this request: queues, mail, third parties. */
  effects: Array<{ label: string; kind: string; file?: string; line?: number }>;

  /** Whether the request has ever been observed running. */
  evidence: FlowNode['evidence'];
  observations?: number;
  avgMs?: number;

  /** Payload versus declared fields, both directions. */
  contract?: ContractCheck;

  /**
   * What comes back, and where it goes.
   *
   * Flowslens does not read the response *shape* — the handler's return value
   * is ordinary code and typing it would be guesswork — but it does know the
   * two things a reader can act on: which React state the response lands in,
   * and which status codes the endpoint has actually answered with.
   */
  response: {
    landsInState: string[];
    statusCodes: number[];
  };

  /** 1-based position in the order this action makes its requests. */
  order: number;
  /** The call is awaited, so what follows it genuinely follows it. */
  awaited: boolean;
  /**
   * Endpoints whose result this call reads.
   *
   * Derived from a real data dependency — an earlier call bound its result to a
   * variable, and this call's arguments mention it — so it is a statement about
   * the code rather than about source order.
   */
  waitsFor: string[];
  /** Endpoints started at the same time as this one, via `Promise.all`. */
  parallelWith: string[];
  /**
   * Set when the call only happens inside another request's `.then`.
   *
   * Different from {@link waitsFor}: this one cannot run at all unless the
   * other resolved, whether or not it uses the response.
   */
  insideCallbackOf?: string;
  /** Endpoints this one waits for through React state rather than a variable. */
  viaState: string[];
  /**
   * Endpoints that run *instead of* this one.
   *
   * Two calls in opposite arms of the same `if` are alternatives: the action
   * makes one request, not two. They share an {@link order} for that reason.
   */
  alternativeTo: string[];
  /** The condition that selects this call, when it is conditional. */
  condition?: string;
  /** True when the call only happens after something failed. */
  onFailure: boolean;
  /** One phrase for the UI: "runs first", "after POST /orders resolves", … */
  when: string;

  /**
   * Other features that call this same endpoint.
   *
   * The question behind "can I change this API": a route with four callers is
   * not yours to reshape, and that is invisible from the handler.
   */
  alsoUsedBy: Array<{ id: string; title: string; subtitle?: string }>;
  /** Other frontend call sites for the same endpoint, outside this feature. */
  otherCallSites: string[];

  warnings: string[];
}

/**
 * The half of the round trip that happens after the response lands.
 *
 * Collected from the handlers this feature runs, because that is where it is
 * written: the request goes out from one place and the consequences are dealt
 * with in another few lines of the same function.
 */
export interface FlowAftermath {
  /** Where the action sends the user next. */
  navigatesTo: string[];
  /**
   * Caches it invalidates, and the endpoints that will refetch as a result.
   *
   * This is a continuation of the flow that no amount of reading the handler
   * reveals: `invalidateQueries(['medicines'])` fires a second request from a
   * completely different component.
   */
  invalidates: Array<{ key: string; refetches: string[] }>;
  /** State set on the failure path, which is what the screen will show. */
  errorStates: string[];
  /** Toasts and notifications the user will see. */
  notifies: string[];
  /** False when no handler in this flow catches anything. */
  handlesErrors: boolean;
  notes: string[];
}

export interface FlowApis {
  calls: ApiCallDetail[];
  /** What happens once the requests come back. */
  aftermath: FlowAftermath;
  notes: string[];
}

/** Every request this feature makes, in full. */
export function flowApis(graph: FlowGraph, flow: FeatureFlow): FlowApis {
  const flows = resolveFlows(graph, { includeLocalOnly: true });
  const contract = checkFlowContract(graph, flow);
  const calls: ApiCallDetail[] = [];

  /**
   * The call sites this feature actually uses, in source order.
   *
   * Taken from the `requests` edges rather than the step list: the steps know
   * which endpoints are involved, the edges know where and in what order they
   * are called from.
   */
  const stepIds = new Set(flow.steps.map((step) => step.nodeId));
  const sites = flow.steps
    .filter((step) => step.kind === 'api-call')
    .map((step) => {
      const edge = graph
        .edgesTo(step.nodeId, ['requests'])
        .find((candidate) => stepIds.has(candidate.from));
      return {
        nodeId: step.nodeId,
        label: step.label,
        pos: numberOr(edge?.meta?.['pos'], Number.MAX_SAFE_INTEGER),
        awaited: edge?.meta?.['awaited'] === true,
        concurrent: edge?.meta?.['concurrent'] === true,
        continuationDepth: numberOr(edge?.meta?.['continuationDepth'], 0),
        bindsTo: typeof edge?.meta?.['bindsTo'] === 'string' ? edge.meta['bindsTo'] : undefined,
        usesBindings: asStrings(edge?.meta?.['usesBindings']),
        effectDeps:
          edge?.meta?.['effectDeps'] === undefined ? undefined : asStrings(edge.meta['effectDeps']),
        inEffect: edge?.meta?.['inEffect'] === true,
        producesState: asStrings(edge?.meta?.['producesState']),
        branchPos: numberOr(edge?.meta?.['branchPos'], -1),
        branch: typeof edge?.meta?.['branch'] === 'string' ? edge.meta['branch'] : undefined,
        condition:
          typeof edge?.meta?.['condition'] === 'string' ? edge.meta['condition'] : undefined,
        inCatch: edge?.meta?.['inCatch'] === true,
        inFinally: edge?.meta?.['inFinally'] === true,
      };
    })
    .sort((a, b) => a.pos - b.pos);

  /**
   * A request can wait on another through React state rather than a variable:
   * the first call sets some state, and the second lives in a `useEffect` that
   * lists that state as a dependency. Source order says nothing about it — the
   * effect is usually written above the fetch it waits for — so the
   * relationship is resolved here and the order corrected below.
   */
  const stateDependency = new Map<string, string[]>();
  for (const site of sites) {
    const deps = site.effectDeps ?? [];
    if (deps.length === 0) continue;
    const producers = sites
      .filter((other) => other !== site && other.producesState.some((name) => deps.includes(name)))
      .map((other) => other.label);
    if (producers.length > 0) stateDependency.set(site.nodeId, [...new Set(producers)]);
  }

  /**
   * Producers before consumers, source order otherwise.
   *
   * A stable topological pass rather than a re-sort: the only reordering that
   * matters is lifting a producer above the effect waiting for it, and this
   * leaves every unrelated call exactly where the source put it.
   */
  const ordered: typeof sites = [];
  const placed = new Set<string>();
  const place = (site: (typeof sites)[number], guard: Set<string>): void => {
    if (placed.has(site.nodeId) || guard.has(site.nodeId)) return;
    guard.add(site.nodeId);
    for (const producerLabel of stateDependency.get(site.nodeId) ?? []) {
      const producer = sites.find((candidate) => candidate.label === producerLabel);
      if (producer) place(producer, guard);
    }
    if (placed.has(site.nodeId)) return;
    placed.add(site.nodeId);
    ordered.push(site);
  };
  for (const site of sites) place(site, new Set());

  /**
   * Step numbers, where alternatives share one.
   *
   * `1 → 2 → 3` for three requests is right; for an `if`/`else` pair it claims
   * a request that never happens. Two arms of the same conditional are one
   * step with two possible shapes.
   */
  const stepOf = new Map<string, number>();
  let stepCount = 0;
  for (const site of ordered) {
    const twin = ordered.find(
      (other) =>
        other !== site &&
        other.branchPos >= 0 &&
        other.branchPos === site.branchPos &&
        other.branch !== site.branch &&
        stepOf.has(other.label),
    );
    if (twin) stepOf.set(site.label, stepOf.get(twin.label)!);
    else {
      stepCount += 1;
      stepOf.set(site.label, stepCount);
    }
  }

  for (const [index, site] of ordered.entries()) {
    const step = flow.steps.find((candidate) => candidate.nodeId === site.nodeId)!;
    const node = graph.node(step.nodeId);
    if (!node) continue;

    const earlier = ordered.slice(0, index);
    /** A real data dependency: this call reads what an earlier one produced. */
    const direct = earlier
      .filter((other) => other.bindsTo && site.usesBindings.includes(other.bindsTo))
      .map((other) => other.label);
    /** The same relationship, carried through React state. */
    const viaState = stateDependency.get(site.nodeId) ?? [];
    const waitsFor = [...new Set([...direct, ...viaState])];
    /**
     * Calls in the opposite arm of the same conditional.
     *
     * Matched on the conditional's own position, so two unrelated `if`s with
     * the same test are not confused for one.
     */
    const alternativeTo =
      site.branchPos >= 0 && site.branch
        ? ordered
            .filter(
              (other) =>
                other !== site &&
                other.branchPos === site.branchPos &&
                other.branch !== site.branch,
            )
            .map((other) => other.label)
        : [];

    /** Started together, so neither waits for the other. */
    const parallelWith = site.concurrent
      ? ordered.filter((other) => other !== site && other.concurrent).map((other) => other.label)
      : [];
    /**
     * The nearest earlier call at a shallower continuation depth is the one
     * whose callback this sits in.
     */
    const enclosing =
      site.continuationDepth > 0
        ? [...earlier].reverse().find((other) => other.continuationDepth < site.continuationDepth)
        : undefined;

    const routeNode = graph.successors(step.nodeId, ['handled-by'])[0];
    const detail: ApiCallDetail = {
      endpoint: node.label,
      method: String(node.meta?.['httpMethod'] ?? ''),
      path: String(node.meta?.['path'] ?? ''),
      ...(node.meta?.['rawPath'] ? { rawPath: String(node.meta['rawPath']) } : {}),
      ...(node.meta?.['client'] ? { client: String(node.meta['client']) } : {}),
      callSites: asStrings(node.meta?.['callSites']),
      payload: payloadOf(node),
      queryKeys: asStrings(node.meta?.['queryKeys']),
      matched: routeNode !== undefined,
      middleware: [],
      handlers: [],
      data: [],
      effects: [],
      evidence: node.evidence,
      ...(node.observations !== undefined ? { observations: node.observations } : {}),
      ...(node.timing?.avgMs !== undefined ? { avgMs: round(node.timing.avgMs) } : {}),
      alsoUsedBy: [],
      otherCallSites: [],
      warnings: [],
      order: stepOf.get(site.label) ?? index + 1,
      awaited: site.awaited,
      waitsFor,
      parallelWith,
      viaState,
      alternativeTo,
      response: {
        landsInState: site.producesState,
        statusCodes: numbersOf(routeNode?.meta?.['statusCodes']),
      },
      ...(site.condition ? { condition: site.condition } : {}),
      onFailure: site.inCatch,
      ...(enclosing ? { insideCallbackOf: enclosing.label } : {}),
      when: describeWhen({
        // The step, not the array position: alternatives share a step, so the
        // call after an if/else pair is "second", not "third".
        index: (stepOf.get(site.label) ?? index + 1) - 1,
        total: stepCount,
        waitsFor,
        parallelWith,
        insideCallbackOf: enclosing?.label,
        viaState,
        onMount: site.inEffect && (site.effectDeps?.length ?? 0) === 0,
        alternativeTo,
        ...(site.condition ? { condition: site.condition } : {}),
        branch: site.branch,
        onFailure: site.inCatch,
        always: site.inFinally,
      }),
    };

    const match = contract.checks.find((check) => check.endpoint === node.label);
    if (match) detail.contract = match;

    if (routeNode) {
      detail.route = {
        method: String(routeNode.meta?.['httpMethod'] ?? detail.method),
        path: String(routeNode.meta?.['path'] ?? detail.path),
        ...(routeNode.meta?.['framework']
          ? { framework: String(routeNode.meta['framework']) }
          : {}),
        ...(routeNode.meta?.['controller']
          ? { controller: String(routeNode.meta['controller']) }
          : {}),
        ...(routeNode.meta?.['handler'] ? { handler: String(routeNode.meta['handler']) } : {}),
        ...(routeNode.source ? { file: routeNode.source.file, line: routeNode.source.line } : {}),
      };

      for (const guard of graph.successors(routeNode.id, ['guarded-by'])) {
        detail.middleware.push({
          name: guard.label,
          role: String(guard.meta?.['role'] ?? 'middleware'),
          ...(guard.source ? { file: guard.source.file, line: guard.source.line } : {}),
        });
      }

      const dtoNode = graph
        .successors(routeNode.id, ['validates'])
        .find((candidate) => candidate.kind === 'dto');
      if (dtoNode) {
        detail.dto = {
          name: dtoNode.label,
          fields: graph
            .successors(dtoNode.id, ['defines', 'validates'])
            .filter((candidate) => candidate.kind === 'field')
            .map((field) => ({ name: String(field.meta?.['name'] ?? field.label) })),
        };
      }

      /**
       * The server-side chain, breadth-first from the route.
       *
       * Walked here rather than taken from the flow's own step list because a
       * route may be reached by several features and this view is about the
       * *endpoint*: everything the request does, not only the part this feature
       * happens to highlight.
       */
      const reached = graph.reachable(routeNode.id, {
        kinds: ['calls', 'queries', 'reads', 'writes', 'emits'],
      });
      for (const [nodeId] of reached) {
        if (nodeId === routeNode.id) continue;
        const reachedNode = graph.node(nodeId);
        if (!reachedNode) continue;

        if (reachedNode.kind === 'method') {
          detail.handlers.push({
            label: reachedNode.label,
            kind: reachedNode.kind,
            ...(reachedNode.source
              ? { file: reachedNode.source.file, line: reachedNode.source.line }
              : {}),
          });
        } else if (reachedNode.kind === 'db-op') {
          const owner = graph.predecessors(nodeId, ['queries'])[0];
          detail.data.push({
            collection: String(reachedNode.meta?.['collection'] ?? ''),
            operation: String(reachedNode.meta?.['operation'] ?? ''),
            effect: String(reachedNode.meta?.['effect'] ?? reachedNode.meta?.['access'] ?? 'write'),
            ...(owner ? { by: owner.label } : {}),
            ...(reachedNode.source
              ? { file: reachedNode.source.file, line: reachedNode.source.line }
              : {}),
          });
        } else if (reachedNode.kind === 'external-effect') {
          detail.effects.push({
            label: reachedNode.label,
            kind: String(reachedNode.meta?.['effectKind'] ?? 'external'),
            ...(reachedNode.source
              ? { file: reachedNode.source.file, line: reachedNode.source.line }
              : {}),
          });
        }
      }

      // Who else reaches this endpoint.
      const otherCalls = graph
        .predecessors(routeNode.id, ['handled-by'])
        .filter((candidate) => candidate.id !== step.nodeId);
      for (const other of otherCalls) {
        for (const site of asStrings(other.meta?.['callSites'])) {
          detail.otherCallSites.push(site);
        }
      }

      const usedBy = flows
        .filter(
          (candidate) =>
            candidate.id !== flow.id &&
            candidate.steps.some((other) => other.nodeId === routeNode.id),
        )
        .map((candidate) => ({ id: candidate.id, title: candidate.title }));
      detail.alsoUsedBy = disambiguate(usedBy, flows);
    } else {
      detail.warnings.push(
        'No backend route matched this call. Either it is served from outside this ' +
          'repository, or the method or path disagree — check --api-prefix.',
      );
    }

    if (detail.evidence === 'static') {
      detail.warnings.push('Never observed at runtime, so this is the static picture only.');
    }
    if (detail.alsoUsedBy.length >= 3) {
      detail.warnings.push(
        `${detail.alsoUsedBy.length} other features call this endpoint — changing its ` +
          'shape changes theirs.',
      );
    }

    detail.handlers.sort((a, b) => a.label.localeCompare(b.label));
    detail.data.sort(
      (a, b) => a.collection.localeCompare(b.collection) || a.operation.localeCompare(b.operation),
    );
    calls.push(detail);
  }

  const notes: string[] = [];
  if (calls.some((call) => call.alternativeTo.length > 0)) {
    notes.push(
      'Requests sharing a step number are alternatives — the action makes one of ' +
        'them, not both. The condition on each says which.',
    );
  }
  if (calls.some((call) => call.onFailure)) {
    notes.push('A request marked "only when the request fails" is an error path.');
  }
  if (calls.some((call) => call.viaState.length > 0)) {
    notes.push(
      'A request that waits on React state runs on a later render, and runs again ' +
        'every time that state changes — so it is ordered after the call that sets ' +
        'it, but it is not guaranteed to happen only once.',
    );
  }
  if (calls.length > 1) {
    notes.push(
      'Order is read from the source, which is exact for awaited calls and for ' +
        'anything inside a `.then`. Two calls fired without awaiting may finish in ' +
        "either order — that is the code's behaviour, not a gap in the reading.",
    );
  }
  if (calls.length === 0) {
    notes.push('This action makes no HTTP request that Flowslens could resolve.');
  }
  if (calls.some((call) => !call.matched)) {
    notes.push(
      'A call with no matched route is the single most common real finding in a ' +
        'first scan: usually a prefix, a verb mismatch, or an endpoint that moved.',
    );
  }
  notes.push(
    'The server-side chain is everything the endpoint does, not only the part this ' +
      'feature uses — the same route may be reached by other features.',
  );

  return { calls, aftermath: aftermathFor(graph, flow, flows), notes };
}

/**
 * What the feature does after its requests return.
 *
 * Invalidated keys are matched to endpoints by name: a key of `medicines`
 * against a path containing `medicines`. It is a heuristic, and a deliberately
 * visible one — the alternative is reading React Query's key factories, which
 * are ordinary functions and can be anything. A named endpoint the reader can
 * check beats a silent gap.
 */
function aftermathFor(
  graph: FlowGraph,
  flow: FeatureFlow,
  flows: readonly FeatureFlow[],
): FlowAftermath {
  const navigatesTo = new Set<string>();
  const keys = new Set<string>();
  const errorStates = new Set<string>();
  const notifies = new Set<string>();
  let handlesErrors = false;

  for (const step of flow.steps) {
    if (step.kind !== 'handler' && step.kind !== 'hook') continue;
    const node = graph.node(step.nodeId);
    if (!node) continue;
    for (const entry of asStrings(node.meta?.['navigatesTo'])) navigatesTo.add(entry);
    for (const entry of asStrings(node.meta?.['invalidates'])) keys.add(entry);
    for (const entry of asStrings(node.meta?.['errorStates'])) errorStates.add(entry);
    for (const entry of asStrings(node.meta?.['notifies'])) notifies.add(entry);
    if (node.meta?.['handlesErrors'] === true) handlesErrors = true;
  }

  const endpoints = graph.nodesOfKind('api-call');
  const invalidates = [...keys].map((key) => {
    /**
     * The part of a key that names a resource.
     *
     * `queryKeys.medicines.all` matches on `medicines`, not on `queryKeys` or
     * `all` — those are the scaffolding every key in the project shares, and
     * matching on them would pair every invalidation with every endpoint.
     */
    const needle = keyNeedle(key);
    if (needle === '') return { key, refetches: [] };
    const refetches = endpoints
      .filter((candidate) => {
        if (String(candidate.meta?.['httpMethod'] ?? '').toUpperCase() !== 'GET') return false;
        /**
         * Segment match, not substring: `/premedicines` is not `/medicines`.
         *
         * Still deliberately broad within that, because React Query's own
         * invalidation is prefix-based — invalidating `medicines` really does
         * refetch every key beginning with it.
         */
        return String(candidate.meta?.['path'] ?? '')
          .toLowerCase()
          .split('/')
          .includes(needle);
      })
      .map((candidate) => candidate.label)
      .sort();
    return { key, refetches };
  });

  const notes: string[] = [];
  if (invalidates.length > 0) {
    notes.push(
      'An invalidated cache fires a fresh request from whichever component reads ' +
        'that key — often not the one you are looking at. Endpoints are matched to ' +
        'keys by name, so check the pairing before relying on it.',
    );
  }
  if (!handlesErrors && flow.steps.some((step) => step.kind === 'api-call')) {
    notes.push(
      'No handler in this feature catches a failure, so a rejected request will ' +
        'surface as an unhandled rejection rather than as something the user sees.',
    );
  }
  void flows;

  return {
    navigatesTo: [...navigatesTo],
    invalidates,
    errorStates: [...errorStates],
    notifies: [...notifies],
    handlesErrors,
    notes,
  };
}

/** The sentence a reader needs next to a request: when does this one happen? */
function describeWhen(input: {
  /** Zero-based step number, where alternatives share a step. */
  index: number;
  /** Number of distinct steps, not of calls. */
  total: number;
  waitsFor: string[];
  parallelWith: string[];
  insideCallbackOf?: string;
  viaState: string[];
  onMount: boolean;
  alternativeTo: string[];
  condition?: string;
  branch?: string;
  onFailure: boolean;
  always: boolean;
}): string {
  if (input.onFailure) {
    return input.condition
      ? `only when the request fails (${input.condition})`
      : 'only when the request fails';
  }
  if (input.always) return 'runs either way, after the request settles';
  /**
   * A condition beats every ordering phrase.
   *
   * "Sent second" is false for a call that may not be sent at all, and it is
   * the kind of false that gets believed — so the condition is said first and
   * the alternative named, rather than describing a sequence that does not
   * happen.
   */
  if (input.condition && input.branch) {
    const test =
      input.branch === 'else'
        ? `only when not ${input.condition}`
        : input.branch === 'default'
          ? 'only when no case matched'
          : input.branch.startsWith('case ')
            ? `only when ${input.condition}`
            : `only when ${input.condition}`;
    return input.alternativeTo.length > 0
      ? `${test} — otherwise ${input.alternativeTo.join(' or ')}`
      : test;
  }
  if (input.total === 1) return 'the only request this action makes';
  if (input.insideCallbackOf) {
    return `only after ${input.insideCallbackOf} resolves`;
  }
  /**
   * Said differently from a direct dependency on purpose.
   *
   * "Re-runs when the state set by X arrives" is what actually happens, and it
   * is a weaker promise than reading X's response: the effect fires on a later
   * render, and again every time that state changes.
   */
  if (input.viaState.length > 0) {
    return `re-runs when the state set by ${input.viaState.join(' and ')} arrives`;
  }
  if (input.waitsFor.length > 0) {
    return `needs the response from ${input.waitsFor.join(' and ')}`;
  }
  if (input.onMount) return 'sent once, when the screen loads';
  if (input.parallelWith.length > 0) {
    return `sent at the same time as ${input.parallelWith.join(' and ')}`;
  }
  return input.index === 0 ? 'sent first' : `sent ${ordinal(input.index + 1)}`;
}

function ordinal(value: number): string {
  const names = ['', 'first', 'second', 'third', 'fourth', 'fifth'];
  return names[value] ?? `${value}th`;
}

/** Segments that appear in every key factory and so identify nothing. */
const KEY_SCAFFOLDING = new Set([
  'querykeys',
  'keys',
  'key',
  'all',
  'detail',
  'details',
  'list',
  'lists',
  'byid',
  'infinite',
  'query',
]);

function keyNeedle(key: string): string {
  const parts = key
    .replace(/^\/+/, '')
    .split(/[./]/)
    .map((part) => part.trim().toLowerCase())
    .filter((part) => part !== '' && !KEY_SCAFFOLDING.has(part));
  // The last meaningful segment: `queryKeys.medicines.all` -> `medicines`.
  return parts[parts.length - 1] ?? '';
}

function numbersOf(value: unknown): number[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is number => typeof entry === 'number')
    : [];
}

function numberOr(value: unknown, fallback: number): number {
  return typeof value === 'number' ? value : fallback;
}

function payloadOf(node: FlowNode): ApiField[] {
  const keys = asStrings(node.meta?.['payloadKeys']);
  const sources =
    node.meta?.['payloadSources'] && typeof node.meta['payloadSources'] === 'object'
      ? (node.meta['payloadSources'] as Record<string, unknown>)
      : {};
  return keys.map((key) => ({
    name: key,
    ...(sources[key] ? { from: String(sources[key]) } : {}),
  }));
}

function asStrings(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : [];
}

/** Give colliding titles a distinguishing suffix; leave unique ones alone. */
function disambiguate<T extends { id: string; title: string; subtitle?: string }>(
  entries: T[],
  flows: readonly FeatureFlow[],
): T[] {
  const counts = new Map<string, number>();
  for (const entry of entries) counts.set(entry.title, (counts.get(entry.title) ?? 0) + 1);
  return entries.map((entry) => {
    if ((counts.get(entry.title) ?? 0) < 2) return entry;
    const flow = flows.find((candidate) => candidate.id === entry.id);
    const hint = flow?.component ?? flow?.source?.file?.split('/').pop() ?? entry.id;
    return { ...entry, subtitle: hint };
  });
}

function round(value: number): number {
  return Math.round(value * 10) / 10;
}
