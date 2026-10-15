/**
 * Every path one action can take — the click, the checks that stop it, the
 * request, the branches on the server, the queries, and what the screen does
 * with each answer — as a tree of decisions.
 *
 * The action document lists what happens stage by stage, and the graph lists
 * which functions are reached. Neither answers the question a developer asks
 * before touching a feature: *which way does it go, and what decides?*
 *
 *   Submit Order
 *     submit()
 *       ◆ valid?          no  → shows the error, stops
 *       POST /orders
 *         ◆ existing?     yes → orders.updateOne
 *                         no  → orders.insertOne
 *
 * Built by walking the source of the functions the action runs, statement by
 * statement, starting at the handler on the element. `if`, `switch`, `?:`,
 * `&&`, `try`/`catch` and early `return`/`throw` become decisions; a call into
 * the project's own code is followed (and shown only if something worth
 * seeing happens inside it); the request is followed into the server function
 * that answers it; a database or third-party call is a step, named the way the
 * graph names it. Library calls and plain computation are left out — the tree
 * is the shape of the feature, not a copy of its code.
 *
 * Read from the source, never run: a branch that is never taken at runtime is
 * still listed, and a decision made inside a library is invisible.
 */

import {
  plainFallback,
  plainQuestion,
  plainResult,
  plainValue,
  words as spoken,
} from './plainwords.js';
import { baseQueryCall, queryDetail } from './querydetail.js';
import {
  Node,
  SyntaxKind,
  type ArrayLiteralExpression,
  type ClassDeclaration,
  type CallExpression,
  type ConditionalExpression,
  type IfStatement,
  type ObjectLiteralExpression,
  type TryStatement,
  type PropertyAccessExpression,
  type ReturnStatement,
  type SourceFile,
  type VariableDeclaration,
} from 'ts-morph';
import type { Functionish } from '../analyzer/ast.js';
import { dbEffectOf } from '../analyzer/mongo.js';
import type { FlowGraph } from '../graph/graph.js';
import type { FlowNode } from '../graph/types.js';
import { locateAction, type LocatedAction } from './action.js';
import {
  rendersWatching,
  effectsWatching,
  filledFields,
  bodyStatements,
  condense,
  endsFunction,
  functionAtLine,
  functionOf,
  localVariable,
  nameOf,
  nearestFunction,
  returnsOf,
  shortCall,
  SourceReader,
  statusOf,
  unwrap,
  type SourcePoint,
} from './actionsource.js';
import { EXECUTION_EDGES, resolveFlows, type FeatureFlow } from './resolve.js';
import { pageAtPath } from './pages.js';

// ---------------------------------------------------------------------------
// The tree
// ---------------------------------------------------------------------------

/** Where a node runs. Colours the views, the same columns the graph uses. */
export type DecisionSide = 'browser' | 'server' | 'database' | 'external';

export type DecisionNode =
  DecisionStep | DecisionQuestion | DecisionGroup | DecisionTry | DecisionEnd;

export interface DecisionStep {
  type: 'step';
  /**
   * - `trigger` — what the user does
   * - `call` — the project's own function, nothing branching inside it
   * - `ui` — state set, toast, navigation, a callback prop
   * - `db` / `external` — a query, or work that leaves the app
   * - `guard` — middleware declared on the route, run before the handler
   * - `compute` — a value the next query or decision depends on: a filter
   *   condition added, or the result of a chain of `?:`
   * - `shared` — a helper that runs the same way in other actions too, drawn
   *   once on its own (see `shareddecisions.ts`) and named here
   */
  kind: 'trigger' | 'call' | 'ui' | 'db' | 'external' | 'guard' | 'compute' | 'shared';
  /** What happens, in plain words: `Update medicines`, `Show error "…"`. */
  label: string;
  /** The code that does it, as written (condensed). */
  text: string;
  side: DecisionSide;
  at?: SourcePoint;
  /** read | create | update | delete | write, for a query. */
  effect?: string;
  /**
   * What a query does, told apart from its neighbours on the same collection:
   * `→ recentlyAdded · where ownerId · newest createdAt first · up to 5`.
   */
  detail?: string;
  /** The graph node behind a query or effect, so a view can link to it. */
  nodeId?: string;
  /** For a `shared` step: which shared part it is, and how it can end here. */
  shared?: SharedUse;
}

/** A shared helper as one action runs it. */
export interface SharedUse {
  /** The part's id, the same in every action that runs it. */
  id: string;
  /** How many actions run it, this one included. */
  actions: number;
  /**
   * Every way it hands control back to this action: what it returns, an
   * answer, a throw — as they turn out here (a throw nothing catches is a 500
   * in one action and caught in another).
   */
  ends: Array<{ label: string; statuses?: number[] }>;
}

export interface DecisionBranch {
  /** `yes`, `no`, `case "admin"`, `default`, `fails`. */
  label: string;
  nodes: DecisionNode[];
  /** Every path through this branch ends it: nothing after the decision runs. */
  ends: boolean;
}

export interface DecisionQuestion {
  type: 'decision';
  /** `existing?` — the condition read as a question. */
  question: string;
  /** The question in plain words where the code allows: `ctx has error?`. */
  label: string;
  /** The condition as written. */
  code: string;
  side: DecisionSide;
  at?: SourcePoint;
  branches: DecisionBranch[];
  /**
   * The name of the path that falls through when no branch is taken, for an
   * `if` without an `else`: `no`. Absent when the branches cover every case.
   */
  otherwise?: string;
}

export interface DecisionGroup {
  type: 'group';
  /**
   * - `function` — a project function with something worth seeing inside
   * - `request` — the request, with the server function that answers it
   * - `loop` — a `for`/`while`, or a `.map`/`.forEach` callback, that does real work
   * - `parallel` — `Promise.all([...])`: started together, waited for together
   * - `unlinked` — requests the walk from the handler did not reach
   */
  kind: 'function' | 'request' | 'loop' | 'parallel' | 'unlinked';
  /** `Runs adjustStock`, `Sends POST /stock to the server`. */
  label: string;
  title: string;
  side: DecisionSide;
  at?: SourcePoint;
  /** For a request: the file that answers it. */
  handledBy?: SourcePoint;
  /** For a project function: where it is written, so the same helper is known wherever it runs. */
  callee?: SourcePoint;
  nodes: DecisionNode[];
}

export interface DecisionTry {
  type: 'try';
  side: DecisionSide;
  at?: SourcePoint;
  nodes: DecisionNode[];
  /** What runs when anything above throws, or rejects. */
  catch?: DecisionBranch;
  /** Runs either way. */
  finally?: DecisionNode[];
}

export interface DecisionEnd {
  type: 'end';
  /**
   * - `stop` — the handler returns early; nothing more happens
   * - `respond` — the server answers the request
   * - `return` — a function returns early to its caller
   * - `throw` — an error is thrown
   * - `next` / `break` — inside a loop: skip to the next item, or leave the loop
   */
  outcome: 'stop' | 'respond' | 'return' | 'throw' | 'next' | 'break';
  /** `Respond 422 · Validation failed`, `Stop`. */
  label: string;
  text: string;
  statuses?: number[];
  message?: string;
  side: DecisionSide;
  at?: SourcePoint;
  /**
   * Set on a throw marked "not caught, so the server answers 500": the throw
   * as written, before that was known — the same helper is caught elsewhere.
   */
  uncaught?: { text: string; label: string };
}

export interface ActionDecisions {
  flowId: string;
  title: string;
  nodes: DecisionNode[];
  counts: {
    /** Places the action can go more than one way. */
    decisions: number;
    /** Distinct ways it can finish: stops, responses, throws. */
    outcomes: number;
    queries: number;
    requests: number;
  };
  limits: string[];
}

export interface ActionDecisionsOptions {
  reader?: SourceReader;
}

// ---------------------------------------------------------------------------
// Walking
// ---------------------------------------------------------------------------

/** How many project functions deep a call is followed. */
const MAX_DEPTH = 10;

/** A tree past this many nodes stops growing; the reader is told. */
const MAX_NODES = 900;

/** Frontend calls that change what the user sees. */
const UI_CALLS =
  /^(toast(\.\w+)?|alert|notify|enqueueSnackbar|message\.\w+|notification\.\w+|router\.(push|replace|back|refresh|prefetch)|navigate|redirect|window\.location\.\w+|location\.(assign|replace|reload)|\w+\.invalidateQueries|\w+\.setQueryData|\w+\.removeQueries|\w+\.resetQueries|\w+\.cancelQueries|\w+\.refetch(Queries)?|refetch|mutate|reset|form\.reset|\w+\.reset|revalidatePath|revalidateTag|window\.(print|open|scrollTo)|print)$/;

/** Driver methods no plain array or map has. */
const DRIVER_ONLY =
  /^(insertOne|insertMany|updateOne|updateMany|replaceOne|deleteOne|deleteMany|findOne|findOneAndUpdate|findOneAndDelete|findOneAndReplace|countDocuments|estimatedDocumentCount|aggregate|bulkWrite|distinct|findById|findByIdAndUpdate|findByIdAndDelete)$/;

/** Hooks whose options carry the request's success and failure callbacks. */
const MUTATIONS = /\.(mutate|mutateAsync)$/;

interface Frame {
  side: DecisionSide;
  /**
   * What a `return` means here: the handler stopping, the server answering, or
   * a helper giving a value back to its caller.
   */
  role: 'handler' | 'server' | 'helper' | 'item';
  depth: number;
  /** What a `break` leaves here: a loop, or the `case` it sits in. */
  breaks?: 'loop' | 'switch';
  /** The status a framework sends for a plain returned value: Nest's 201 for a POST. */
  defaultStatus?: number;
  /** Parameters bound to the functions the caller passed: `onFilterChange(() => …)`. */
  bound?: Map<string, Functionish>;
  /** Variables this function passes to a query: `filter` in `find(filter)`. */
  queryVars?: Set<string>;
  /**
   * Inside a branch of a decision: a value set here is what the branch does —
   * `filter.category = …`, `matched.push(c)` — and is drawn, or the decision
   * that sets it disappears with it.
   */
  inBranch?: boolean;
}

type LocatedCall = LocatedAction['calls'][number];

interface Walk {
  graph: FlowGraph;
  flow: FeatureFlow;
  reader: SourceReader;
  located: LocatedAction;
  /** `file:line` -> the db-ops and effects the graph found there. */
  effects: Map<string, FlowNode[]>;
  /** `file:start` of a request call -> where the action document found it. */
  requests: Map<string, LocatedCall>;
  /** Requests already drawn, so the rest can be listed at the end. */
  drawn: Set<LocatedCall>;
  /** Functions being walked: a recursive call is named, not followed. */
  stack: Node[];
  /** Helpers already opened once: later calls name them instead of repeating the inside. */
  opened: Set<Node>;
  /**
   * Helper calls already opened, by function *and* arguments:
   * `requireEnv("MONGODB_URI")` and `requireEnv("CLINICS_DB")` are two
   * different checks, each of which can throw, and both are drawn.
   */
  openedCalls: Set<string>;
  /** The component's handler a child calls through its prop, when there is one. */
  parentHandler?: Functionish;
  /** Props of the child component that run the parent's handler. */
  childProps: Set<string>;
  size: number;
  limits: Set<string>;
  /** Work a background worker does once the request has answered: drawn after the answer. */
  later: DecisionNode[];
}

/** The decision tree for one action. */
export function actionDecisions(
  graph: FlowGraph,
  flow: FeatureFlow,
  options: ActionDecisionsOptions = {},
): ActionDecisions {
  const reader = options.reader ?? new SourceReader(graph);
  const page = pageOpened(graph, flow);
  if (page) return pageNavigation(graph, flow, page, reader);
  const located = locateAction(graph, flow, { reader });
  const walk: Walk = {
    graph,
    flow,
    reader,
    located,
    effects: effectsIndex(graph),
    requests: new Map(),
    drawn: new Set(),
    stack: [],
    opened: new Set(),
    openedCalls: new Set(),
    childProps: new Set(),
    size: 0,
    limits: new Set(located.limits),
    later: [],
  };
  for (const call of located.calls) {
    if (call.call) walk.requests.set(siteKey(call.call), call);
  }

  const nodes: DecisionNode[] = [
    {
      type: 'step',
      kind: 'trigger',
      label: '',
      text: triggerText(flow),
      side: 'browser',
      ...(flow.source ? { at: flow.source } : {}),
    },
  ];

  try {
    nodes.push(...walkEntry(walk));
    // A job queued outside any request still runs, later.
    nodes.push(...walk.later.splice(0));
  } catch (error) {
    walk.limits.add(
      `Part of the source could not be read: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  // A request the walk did not reach is still part of the action: list it, with
  // its server side, rather than let the tree suggest the action sends nothing.
  const notDrawn = located.calls.filter((call) => !walk.drawn.has(call));
  /**
   * A request this action sets off by changing what the screen shows — a
   * filter its list reads, a tab whose part loads when shown — is reached
   * through state, not a call: said so, not "the walk did not reach them".
   */
  const viaState = notDrawn.filter((call) => reachedThroughState(walk, call));
  if (viaState.length > 0) {
    nodes.push({
      type: 'group',
      label: '',
      kind: 'unlinked',
      title: (() => {
        const wait = debounceOf(walk, viaState);
        return wait
          ? `Then, once the typing has stopped for ${wait} ms, because what the screen shows changed, it loads again`
          : 'Then, because what the screen shows changed, it loads again';
      })(),
      side: 'browser',
      nodes: orderByUse(walk, viaState).flatMap((call) => unlinkedNodes(walk, call)),
    });
  }
  const missed = notDrawn.filter((call) => !viaState.includes(call));
  if (missed.length > 0) {
    const reached = walk.drawn.size > 0;
    // Hooks run as the component renders, all of them: on load, the requests
    // start together and are waited for apart — drawn side by side, not in a row.
    const together = flow.event === 'mount' && !reached && missed.length > 1;
    nodes.push({
      type: 'group',
      label: together ? 'These start together as it opens' : '',
      kind: together ? 'parallel' : 'unlinked',
      title: reached
        ? flow.event === 'mount'
          ? 'Also loaded as it opens'
          : 'Also requested — the walk from the handler did not reach these'
        : flow.event === 'mount' || !walk.located.front.some((fn) => fn.role !== 'request')
          ? 'Requests made'
          : 'Requests made — the walk from the handler did not reach them',
      side: 'browser',
      nodes: orderByUse(walk, missed).flatMap((call) => unlinkedNodes(walk, call)),
    });
  }

  if (walk.size >= MAX_NODES) {
    walk.limits.add(
      `The tree stops at ${MAX_NODES} nodes; deeper helpers are named, not followed.`,
    );
  }
  markUncaught(nodes, false);
  return {
    flowId: flow.id,
    title: flow.title,
    nodes,
    counts: countOf(labelTree(nodes)),
    limits: [
      ...walk.limits,
      'Read from the source, not run: a branch that is never taken still appears.',
      'Library code is not followed: a decision made inside a library, or behind a ' +
        'dynamic call, shows up as the call.',
    ],
  };
}

/**
 * Seen only while the app ran, a `GET` to one of the app's own pages: the user
 * opening that page, not an API call — the page file it opens, if so.
 */
function pageOpened(graph: FlowGraph, flow: FeatureFlow): string | undefined {
  if (flow.source || flow.endpoints.length === 0) return undefined;
  let page: string | undefined;
  for (const endpoint of flow.endpoints) {
    const [method, path] = endpoint.split(' ');
    if (method !== 'GET' || !path) return undefined;
    page = pageAtPath(graph, path);
    if (!page) return undefined;
  }
  return page;
}

/** Opening a page: the address, then every load the page runs as it opens, in full. */
function pageNavigation(
  graph: FlowGraph,
  flow: FeatureFlow,
  page: string,
  reader: SourceReader,
): ActionDecisions {
  const path = flow.endpoints[0]!.split(' ')[1]!;
  const nodes: DecisionNode[] = [
    {
      type: 'step',
      kind: 'trigger',
      label: `The user opens ${path}`,
      text: `opens ${path}`,
      side: 'browser',
    },
    {
      type: 'step',
      kind: 'ui',
      label: `The browser shows the page at ${path}`,
      text: `${page} — a page of the app, fetched from its own address; no API route answers it`,
      side: 'browser',
      at: { file: page, line: 1 },
    },
  ];
  const loads = resolveFlows(graph, { includeLocalOnly: true }).filter(
    (candidate) =>
      candidate.event === 'mount' && (candidate.source?.file ?? candidate.steps[0]?.file) === page,
  );
  for (const load of loads) {
    const tree = actionDecisions(graph, load, { reader });
    nodes.push({
      type: 'group',
      kind: 'function',
      label: `${capitalise(load.title)}`,
      title: load.title,
      side: 'browser',
      ...(load.source ? { at: load.source } : {}),
      // The load's own start ("X opens") is this page opening: drawn once.
      nodes: tree.nodes.filter((node) => !(node.type === 'step' && node.kind === 'trigger')),
    });
  }
  return {
    flowId: flow.id,
    title: flow.title,
    nodes,
    counts: countOf(labelTree(nodes)),
    limits: [
      `Seen while the app ran: ${path} is a page of the app, so the request is the page being opened.`,
      'Read from the source, not run: a branch that is never taken still appears.',
    ],
  };
}

/** Requests nobody's handler reached, in the order the component asks for them. */
function orderByUse(walk: Walk, calls: LocatedCall[]): LocatedCall[] {
  const file = walk.reader.file(walk.flow.source?.file ?? walk.flow.steps[0]?.file);
  const position = (call: LocatedCall): number => {
    const hook = call.hook?.name;
    if (!file || !hook) return Number.MAX_SAFE_INTEGER;
    const use = file
      .getDescendantsOfKind(SyntaxKind.CallExpression)
      .find((candidate) => calleeText(candidate) === hook);
    return use?.getStart() ?? Number.MAX_SAFE_INTEGER;
  };
  return [...calls].sort((a, b) => position(a) - position(b));
}

/**
 * One request made on load: the query function around it (so what it does
 * with the answer shows), its success and failure callbacks, and — when the
 * hook says `enabled: …` — the condition it waits for.
 */
function unlinkedNodes(walk: Walk, call: LocatedCall): DecisionNode[] {
  const frame: Frame = { side: 'browser', role: 'helper', depth: 0 };
  const inner = call.fn ? walkFunction(walk, call.fn, frame) : [];
  const nodes = [
    ...(walk.drawn.has(call) ? inner : [...inner, ...requestNodes(walk, call, frame)]),
    ...hookOutcome(walk, call, undefined, frame),
    ...dataEffects(walk, call, frame),
  ];
  const options = call.hook?.options;
  const enabled =
    options && Node.isObjectLiteralExpression(options) ? options.getProperty('enabled') : undefined;
  const condition =
    enabled && Node.isPropertyAssignment(enabled) ? enabled.getInitializer() : undefined;
  // `refetchInterval: 2000`, or a function deciding while to keep asking: the
  // request is sent again and again — a loop, not one call.
  const interval =
    options && Node.isObjectLiteralExpression(options)
      ? options.getProperty('refetchInterval')
      : undefined;
  const every =
    interval && Node.isPropertyAssignment(interval) ? interval.getInitializer() : undefined;
  if (every && every.getText() !== 'false') {
    const text = condense(every.getText(), 70);
    const polled: DecisionNode = {
      type: 'group',
      kind: 'loop',
      label: '',
      title: Node.isNumericLiteral(every)
        ? `repeats every ${every.getText()} ms`
        : `repeats while: ${text}`,
      side: 'browser',
      at: walk.reader.point(every),
      nodes: [...nodes],
    };
    walk.size += 1;
    nodes.splice(0, nodes.length, polled);
  }
  if (!condition || condition.getText() === 'true') return nodes;
  return [
    decision(
      walk,
      `${condense(condition.getText(), 50)}?`,
      condition.getText(),
      frame,
      condition,
      [{ label: 'yes — the request is sent', nodes, ends: false }],
      'no — nothing is requested',
    ),
  ];
}

/**
 * `const statusQ = useImportJobStatus(jobId)` and a `useEffect` on
 * `statusQ.data`: when the answer changes, that effect decides what happens
 * next — "Import complete" and the summary, or "Import failed" and back a
 * step. Nothing calls it, so the polled request read as the end of the story.
 */
function dataEffects(walk: Walk, call: LocatedCall, frame: Frame): DecisionNode[] {
  const hook = call.hook?.name;
  if (!hook) return [];
  const out: DecisionNode[] = [];
  const files = new Set(walk.flow.steps.flatMap((step) => (step.file ? [step.file] : [])));
  for (const rel of files) {
    const file = walk.reader.file(rel);
    if (!file) continue;
    // As it draws with the answer: `if (clinics) { … auto-select the only clinic … }`,
    // or `if (isLoading) return <Skeleton />`: which screen the user gets.
    const renders = rendersWatching(file, hook).flatMap((statement) => {
      const shown = screenReturned(statement.getThenStatement());
      if (!shown)
        return walkStatement(
          walk,
          statement,
          { ...frame, role: 'handler', depth: frame.depth + 1 },
          false,
        );
      const { question, thenLabel, elseLabel } = phrase(statement.getExpression().getText());
      const showing = step(walk, 'ui', `shows ${shown}`, frame, statement.getThenStatement());
      showing.label = `Show ${shown}`;
      return [
        decision(
          walk,
          question,
          statement.getExpression().getText(),
          frame,
          statement,
          [{ label: thenLabel, nodes: [showing], ends: true }],
          elseLabel,
        ),
      ];
    });
    if (renders.some((node) => worthShowing(node) || node.type === 'decision')) {
      walk.size += 1;
      out.push({
        type: 'group',
        kind: 'function',
        label: 'As the component draws with the answer, it decides',
        title: 'as it draws with the answer',
        side: 'browser',
        at: walk.reader.point(rendersWatching(file, hook)[0]!),
        nodes: renders,
      });
    }
    for (const { effect, fn, deps } of effectsWatching(file, hook)) {
      if (walk.opened.has(fn)) continue;
      walk.opened.add(fn);
      const inner = walkFunction(walk, fn, { ...frame, role: 'handler', depth: frame.depth + 1 });
      if (!inner.some((node) => worthShowing(node) || node.type === 'decision')) continue;
      walk.size += 1;
      out.push({
        type: 'group',
        kind: 'function',
        label: 'When the answer changes, the effect watching it runs',
        title: `when the answer changes: useEffect([${condense(deps.join(', '), 50)}])`,
        side: 'browser',
        at: walk.reader.point(effect),
        nodes: inner,
      });
    }
  }
  return out;
}

/** `return <EmptyState title="Medicine not found" />` -> `"Medicine not found"`; a skeleton -> "the loading placeholder". */
function screenReturned(then: Node): string | undefined {
  const returned = Node.isReturnStatement(then)
    ? then
    : Node.isBlock(then)
      ? then.getStatements().find((statement) => Node.isReturnStatement(statement))
      : undefined;
  const value =
    returned && Node.isReturnStatement(returned) && returned.getExpression()
      ? unwrap(returned.getExpression()!)
      : undefined;
  if (
    !value ||
    !(Node.isJsxElement(value) || Node.isJsxSelfClosingElement(value) || Node.isJsxFragment(value))
  )
    return undefined;
  const text = value.getText();
  const title = /\btitle=["']([^"']+)["']/.exec(text)?.[1];
  if (title) return `"${title}"`;
  if (/Skeleton|Spinner|Loading/.test(text)) return 'the loading placeholder';
  const heading = /<h[1-3][^>]*>([^<{]+)</.exec(text)?.[1]?.trim();
  return heading ? `"${heading}"` : 'another screen instead';
}

function walkEntry(walk: Walk): DecisionNode[] {
  const { located } = walk;
  const out: DecisionNode[] = [];
  const gate = disabledGate(walk);
  if (gate) out.push(gate);
  const handlers = located.front.filter((fn) => fn.role === 'handler');
  const child = located.front.find((fn) => fn.role === 'child');

  // `<form onSubmit={form.handleSubmit(onSubmit)}>`: the library validates
  // the fields first and only calls the handler when they pass.
  const wrapper = located.entryExpression ? unwrap(located.entryExpression) : undefined;
  if (wrapper && Node.isCallExpression(wrapper) && /handleSubmit$/.test(calleeText(wrapper))) {
    out.push({
      type: 'decision',
      question: 'the form passes validation?',
      label: 'The form passes validation?',
      code: condense(wrapper.getText(), 80),
      side: 'browser',
      at: walk.reader.point(wrapper),
      branches: [
        {
          label: 'no',
          nodes: [
            {
              type: 'step',
              kind: 'ui',
              label: 'Show the field errors',
              text: 'the field errors are shown',
              side: 'browser',
            },
            {
              type: 'end',
              outcome: 'stop',
              label: 'Stop — nothing is sent',
              text: 'nothing is sent',
              side: 'browser',
            },
          ],
          ends: true,
        },
      ],
      otherwise: 'yes',
    });
  }

  const frame: Frame = { side: 'browser', role: 'handler', depth: 0 };
  if (child) {
    // The child runs its own handler and calls the prop; the prop is the
    // parent's handler, followed from the point the child calls it.
    walk.parentHandler = handlers[0]?.fn;
    for (const name of propNames(located.child?.fn)) walk.childProps.add(name);
    out.push(
      functionNode(walk, child.fn, frame, `${located.child?.component ?? ''}.${nameOf(child.fn)}`),
    );
    return out;
  }
  // A page load runs every function it calls as it opens, one after another —
  // `getSubscription(); getTotals(); getSliders();` — not only the first.
  const entries = walk.flow.event === 'mount' ? handlers : handlers.slice(0, 1);
  for (const entry of entries) {
    if (walk.opened.has(entry.fn)) continue;
    out.push(functionNode(walk, entry.fn, frame, entry.name));
  }
  out.push(...popupSteps(walk, frame));
  return out;
}

/**
 * The click opened a popup; the rest of the feature is what the user does in
 * it: fills its fields and presses its main button ("Download"), whose own
 * handler then runs — drawn from there, to the server and back.
 */
function popupSteps(walk: Walk, frame: Frame): DecisionNode[] {
  const out: DecisionNode[] = [];
  for (const step of walk.flow.steps) {
    if (step.kind !== 'handler') continue;
    for (const edge of walk.graph.edgesFrom(step.nodeId, ['calls'])) {
      const pressed = edge.meta?.['userStep'];
      if (typeof pressed !== 'string') continue;
      const target = walk.graph.node(edge.to);
      const file = target?.source ? walk.reader.file(target.source.file) : undefined;
      const fn = file && target?.source ? functionAtLine(file, target.source.line) : undefined;
      const fields = (edge.meta?.['fields'] as string[] | undefined) ?? [];
      const said = `${filledFields(fields)}${edge.meta?.['input'] ? 'uses' : 'presses'} "${pressed}"`;
      const user: DecisionNode = {
        type: 'step',
        kind: 'ui',
        label: `In the popup, the user ${said}`,
        text: `in the popup, the user ${said}`,
        side: 'browser',
        ...(target?.source ? { at: target.source } : {}),
      };
      out.push(user);
      if (fn && !walk.opened.has(fn))
        out.push(functionNode(walk, fn, frame, target?.label ?? pressed));
    }
  }
  return out;
}

/** A function as a step, or as a group when something happens inside it. */
/**
 * `<button disabled={!canSave} onClick={save}>`: while the condition holds the
 * click cannot happen at all — the first thing that decides whether the
 * action runs, written on the button rather than in the handler.
 */
function disabledGate(walk: Walk): DecisionNode | undefined {
  const entry = walk.located.entryExpression;
  const attribute = entry?.getFirstAncestorByKind(SyntaxKind.JsxAttribute);
  const element = attribute?.getParent()?.getParent();
  if (!element || !(Node.isJsxOpeningElement(element) || Node.isJsxSelfClosingElement(element))) {
    return undefined;
  }
  const disabled = element.getAttribute('disabled');
  if (!disabled || !Node.isJsxAttribute(disabled)) return undefined;
  const initializer = disabled.getInitializer();
  const condition =
    initializer && Node.isJsxExpression(initializer) ? initializer.getExpression() : undefined;
  if (!condition || /^(true|false)$/.test(condition.getText())) return undefined;
  const frame: Frame = { side: 'browser', role: 'handler', depth: 0 };
  return decision(
    walk,
    `${condense(condition.getText(), 50)}?`,
    condition.getText(),
    frame,
    condition,
    [
      {
        label: 'yes — the button is disabled',
        nodes: [
          end(walk, 'stop', 'nothing happens — the button cannot be pressed', frame, condition),
        ],
        ends: true,
      },
    ],
    'no — it can be pressed',
  );
}

function functionNode(walk: Walk, fn: Functionish, frame: Frame, title?: string): DecisionNode {
  const name = title ?? `${nameOf(fn)}()`;
  const nodes = walkFunction(walk, fn, frame);
  return {
    type: 'group',
    label: '',
    kind: 'function',
    title: name.endsWith(')') ? name : `${name}()`,
    side: frame.side,
    at: walk.reader.point(fn),
    nodes,
  };
}

function walkFunction(walk: Walk, fn: Functionish, frame: Frame): DecisionNode[] {
  if (walk.stack.includes(fn)) {
    return [step(walk, 'call', `${nameOf(fn)}() again (recursive)`, frame, fn)];
  }
  walk.stack.push(fn);
  try {
    const body = fn.getBody();
    if (!body) return [];
    if (!Node.isBlock(body)) {
      // `async (input) => api.post(…)`: the expression is the whole function.
      return walkExpression(walk, body, frame);
    }
    const queryVars = queryVariables(walk, fn);
    return walkStatements(
      walk,
      bodyStatements(fn),
      queryVars.size ? { ...frame, queryVars } : { ...frame, queryVars: undefined },
      true,
    );
  } finally {
    walk.stack.pop();
  }
}

/**
 * The variables a function hands to its queries: `filter` and `or` in
 * `find({ ownerId, $or: or, ...filter })`. Assignments to them decide which
 * records the query touches, so they are drawn even though they call nothing.
 */
function queryVariables(walk: Walk, fn: Functionish): Set<string> {
  const names = new Set<string>();
  for (const call of fn.getDescendantsOfKind(SyntaxKind.CallExpression)) {
    if (nearestFunction(call) !== fn) continue;
    if (effectsAt(walk, call).every((node) => node.kind !== 'db-op') && !unlinkedQuery(walk, call))
      continue;
    for (const arg of call.getArguments()) {
      const value = unwrap(arg);
      if (Node.isIdentifier(value)) names.add(value.getText());
      for (const node of value.getDescendants()) {
        if (Node.isShorthandPropertyAssignment(node)) names.add(node.getName());
        if (Node.isSpreadAssignment(node) || Node.isPropertyAssignment(node)) {
          const inner = Node.isSpreadAssignment(node)
            ? node.getExpression()
            : node.getInitializer();
          if (inner && Node.isIdentifier(inner)) names.add(inner.getText());
        }
      }
    }
  }
  return names;
}

/** `filter.category = query.category` / `or.push({ sku })` on a variable a query reads. */
/**
 * What a branch does when all it does is set a value: `filter.category =
 * query.category` is "Set filter category", `and.push(…)` is "Add to and",
 * `count++` is "Count + 1". Anything else in a branch is not a step.
 */
function settingStep(walk: Walk, expression: Node, frame: Frame): DecisionStep | undefined {
  const node = unwrap(expression);
  let label: string | undefined;
  if (
    Node.isBinaryExpression(node) &&
    /=$/.test(node.getOperatorToken().getText()) &&
    !/[=!<>]=$/.test(node.getOperatorToken().getText())
  ) {
    label = settingLabel(
      node.getLeft(),
      node.getRight().getText(),
      node.getOperatorToken().getText(),
    );
  } else if (
    Node.isCallExpression(node) &&
    /\.(push|unshift|add|set|delete)$/.test(calleeText(node))
  ) {
    const base = calleeText(node).replace(/\.(push|unshift|add|set|delete)$/, '');
    const verb = /\.delete$/.test(calleeText(node)) ? 'Remove from' : 'Add to';
    label = `${verb} the ${spoken(base.split('.').pop()!)}`;
  } else if (Node.isPostfixUnaryExpression(node) || Node.isPrefixUnaryExpression(node)) {
    const text = node.getText();
    const name = text.replace(/\+\+|--/g, '');
    label = /^[\w$.]+$/.test(name)
      ? `${text.includes('++') ? 'Add 1 to' : 'Take 1 from'} the ${spoken(name.split('.').pop()!)}`
      : condense(text, 40);
  } else if (Node.isDeleteExpression(node)) {
    label = `Remove the ${spoken(node.getExpression().getText().split('.').pop()!)}`;
  }
  if (!label) return undefined;
  const made = step(walk, 'compute', condense(node.getText(), 90), frame, node);
  made.label = label;
  return made;
}

/**
 * `filter.category = query.category` -> "Set the category"; `step = "map"` ->
 * `Set the step to "map"`; `next = {}` -> "Set the next to empty". The code
 * itself is the step's text, shown with "Show code".
 */
function settingLabel(left: Node, right: string, operator: string): string {
  const target = left.getText();
  // `[day, month] = …` sets each of them.
  if (Node.isArrayLiteralExpression(left) || Node.isObjectLiteralExpression(left)) {
    const names = (target.match(/[A-Za-z_$][\w$]*/g) ?? []).map(spoken);
    const list =
      names.length > 1 ? `${names.slice(0, -1).join(', ')} and ${names.at(-1)}` : names[0];
    return `Set the ${list ?? 'values'}`;
  }
  // `next[key] = …` names the item by its list.
  const name = spoken(
    Node.isElementAccessExpression(left)
      ? left.getExpression().getText().split('.').pop()!
      : target.split('.').pop()!,
  );
  const value = plainValue(right);
  if (operator === '+=') return value ? `Add ${value} to the ${name}` : `Add to the ${name}`;
  if (operator === '-=') return value ? `Take ${value} from the ${name}` : `Take from the ${name}`;
  if (value === 'nothing') return `Clear the ${name}`;
  // Saying "set the supplier to the supplier" adds nothing.
  if (value && !value.endsWith(name)) return `Set the ${name} to ${value}`;
  return `Set the ${name}`;
}

function queryBuilding(walk: Walk, expression: Node, frame: Frame): DecisionStep | undefined {
  if (!frame.queryVars?.size) return undefined;
  const node = unwrap(expression);
  let base: string | undefined;
  let label = '';
  if (
    Node.isBinaryExpression(node) &&
    node.getOperatorToken().getKind() === SyntaxKind.EqualsToken
  ) {
    const left = node.getLeft();
    base = left.getText().split(/[.[]/)[0];
    const key = Node.isPropertyAccessExpression(left) ? left.getName() : undefined;
    label = key ? `Filter on ${spoken(key)}` : `Set the ${spoken(base!)}`;
  } else if (Node.isCallExpression(node) && /\.(push|unshift)$/.test(calleeText(node))) {
    base = calleeText(node).split('.')[0];
    label = `Add a condition to the ${spoken(base!)}`;
  }
  if (!base || !frame.queryVars.has(base)) return undefined;
  const made = step(walk, 'compute', condense(node.getText(), 90), frame, node);
  made.label = label;
  return made;
}

/**
 * `const target = a === "increase" ? x + q : a === "decrease" ? x - q : q` —
 * a chain of `?:` that picks a value is a business rule, so it is drawn as the
 * decision it is, each arm saying what the value becomes.
 */
function valueChoice(
  walk: Walk,
  name: string,
  init: Node,
  frame: Frame,
): DecisionQuestion | undefined {
  const value = unwrap(init);
  const fn = nearestFunction(value) as Functionish | undefined;
  /**
   * Where a name comes from that a request decides on: a parameter, a field
   * of one (`query.sortBy`), or a value worked out from one, or from a query's
   * answer (`const [rollup] = await Promise.all(…)`).
   */
  const fromInput = (code: string): boolean => {
    const root = /^!?\s*\(?\s*([A-Za-z_$][\w$]*)/.exec(code.trim())?.[1];
    if (!root || !fn) return false;
    if (fn.getParameters().some((param) => param.getName() === root)) return true;
    const declared = fn
      .getDescendantsOfKind(SyntaxKind.VariableDeclaration)
      .find((declaration) =>
        new RegExp(`(^|[^\\w$])${root.replace(/\$/g, '\\$')}([^\\w$]|$)`).test(
          declaration.getNameNode().getText(),
        ),
      );
    const source = declared?.getInitializer()?.getText() ?? '';
    return (
      /\bawait\b/.test(source) ||
      fn.getParameters().some((param) => new RegExp(`\\b${param.getName()}\\b`).test(source))
    );
  };
  // `const sortBy = query.sortBy ?? "updatedAt"`: a default the caller never sees.
  if (
    Node.isBinaryExpression(value) &&
    value.getOperatorToken().getKind() === SyntaxKind.QuestionQuestionToken &&
    fromInput(value.getLeft().getText())
  ) {
    const left = value.getLeft().getText();
    const fallback = step(
      walk,
      'compute',
      `${name} = ${condense(value.getRight().getText(), 70)}`,
      frame,
      value.getRight(),
    );
    const given = plainValue(value.getRight().getText());
    fallback.label = given
      ? `The ${spoken(name)} becomes ${given}`
      : `The ${spoken(name)} falls back to ${condense(value.getRight().getText(), 40)}`;
    const asked = decision(
      walk,
      `${condense(left, 50)} is missing?`,
      `${left} ?? …`,
      frame,
      value,
      [{ label: 'yes', nodes: [fallback], ends: false }],
      `no — ${name} is ${condense(left, 40)}`,
    );
    asked.label = `Is ${condense(left, 50)} missing?`;
    return asked;
  }
  if (!Node.isConditionalExpression(value)) return undefined;
  const nested = (node: Node): boolean => Node.isConditionalExpression(unwrap(node));
  /**
   * `const startDate = from_date ? new Date(from_date) : <7 days ago>`: one
   * `? :` on what the function was given is a decision about the request — a
   * default the caller never sees. Other single `? :`s are formatting.
   */
  const params = new Set(
    (nearestFunction(value) as Functionish | undefined)
      ?.getParameters()
      .map((param) => param.getName()) ?? [],
  );
  const onInput = /^!?\s*([\w$]+)/.exec(value.getCondition().getText().trim());
  const condition = value.getCondition().getText().trim();
  const decidesInput =
    (onInput !== null &&
      params.has(onInput[1]!) &&
      /^!?\s*[\w$]+(\?\.[\w$]+)?\s*$/.test(condition)) ||
    // `query.sortDir === "asc" ? 1 : -1`, `sortBy === "name" ? … : …`: an input compared with a fixed value.
    (/^[\w$]+((\?)?\.[\w$]+)*\s*[!=]==?\s*("[^"]*"|'[^']*'|-?\d+|true|false|null)$/.test(
      condition,
    ) &&
      fromInput(condition));
  if (!decidesInput && !nested(value.getWhenTrue()) && !nested(value.getWhenFalse()))
    return undefined;
  const arm = (node: Node): DecisionNode[] => {
    const inner = unwrap(node);
    if (Node.isConditionalExpression(inner)) {
      const deeper = valueChoice(walk, name, inner, frame) ?? chooseOne(inner);
      return [deeper];
    }
    const made = step(walk, 'compute', `${name} = ${condense(inner.getText(), 70)}`, frame, inner);
    const value = plainValue(inner.getText());
    made.label = value
      ? `The ${spoken(name)} becomes ${value}`
      : `The ${spoken(name)} is worked out`;
    return [made];
  };
  const chooseOne = (node: ConditionalExpression): DecisionQuestion => {
    const { question, thenLabel, elseLabel } = phrase(node.getCondition().getText());
    return decision(walk, question, node.getCondition().getText(), frame, node, [
      { label: thenLabel, nodes: arm(node.getWhenTrue()), ends: false },
      { label: elseLabel, nodes: arm(node.getWhenFalse()), ends: false },
    ]);
  };
  return chooseOne(value);
}

/**
 * @param tail these are the function's own top-level statements, so its last
 *   `return` is the ordinary end of the function rather than an early exit.
 */
function walkStatements(
  walk: Walk,
  statements: Node[],
  frame: Frame,
  tail: boolean,
): DecisionNode[] {
  const out: DecisionNode[] = [];
  statements.forEach((statement, index) => {
    if (walk.size >= MAX_NODES) return;
    const last = tail && index === statements.length - 1;
    out.push(...walkStatement(walk, statement, frame, last));
  });
  return out;
}

function walkStatement(walk: Walk, statement: Node, frame: Frame, last: boolean): DecisionNode[] {
  if (Node.isBlock(statement)) return walkStatements(walk, statement.getStatements(), frame, false);

  if (Node.isExpressionStatement(statement)) {
    // `res.status(400).json(…)`, `res.send(buffer)`: an Express-style handler answers here.
    const answered = expressResponse(walk, statement, frame);
    if (answered) return answered;
    // `setTimeout(() => search(text), 250)`: a debounce — what runs is inside.
    const later = delayedCallback(walk, statement, frame);
    if (later) return later;
    // `a.download = \`Report_${from}.xlsx\`` then `a.click()`: the browser saves a file.
    const expression = unwrap(statement.getExpression());
    if (
      frame.side === 'browser' &&
      Node.isBinaryExpression(expression) &&
      expression.getOperatorToken().getKind() === SyntaxKind.EqualsToken &&
      /\.download$/.test(expression.getLeft().getText())
    ) {
      const made = step(walk, 'compute', condense(statement.getText(), 90), frame, statement);
      made.label = `The browser saves the file as ${condense(expression.getRight().getText(), 70)}`;
      return [made];
    }
    const building = queryBuilding(walk, statement.getExpression(), frame);
    if (building) return [...walkExpression(walk, statement.getExpression(), frame), building];
    const nodes = walkExpression(walk, statement.getExpression(), frame);
    if (frame.inBranch) {
      // `and.push(...stockLevelClauses(level))`: the call inside runs first,
      // then the push is what the branch does.
      const set = settingStep(walk, statement.getExpression(), frame);
      // Not twice: the expression may already be drawn as this very step.
      const same = (node: DecisionNode): boolean =>
        node.type === 'step' && set !== undefined && node.text === set.text;
      // `user.name = await decrypt(user.name)`: the call is part of the setting, drawn once.
      if (set && !nodes.some(same)) {
        // Only the call that *is* the value set: `x = await decrypt(x)`, not a
        // call somewhere inside a function the value is built from.
        const assigned = unwrap(statement.getExpression());
        const value = Node.isBinaryExpression(assigned) ? unwrap(assigned.getRight()) : undefined;
        const callee =
          value && Node.isCallExpression(value) ? value.getExpression().getText() : undefined;
        return [
          ...nodes.filter(
            (node) =>
              !(
                callee &&
                node.type === 'step' &&
                node.kind === 'call' &&
                node.text.startsWith(`${callee}(`)
              ),
          ),
          set,
        ];
      }
    }
    return nodes;
  }

  if (Node.isVariableStatement(statement)) {
    return statement.getDeclarations().flatMap((declaration) => {
      const init = declaration.getInitializer();
      if (!init) return [];
      const name = declaration.getNameNode();
      const chosen = Node.isIdentifier(name)
        ? valueChoice(walk, name.getText(), init, frame)
        : undefined;
      if (chosen) return [chosen];
      const nodes = walkExpression(walk, init, frame);
      if (nodes.length === 0 && frame.inBranch) {
        const made = step(walk, 'compute', condense(declaration.getText(), 90), frame, declaration);
        const value = plainValue(init.getText());
        made.label = value
          ? `The ${spoken(declaration.getName())} is ${value}`
          : `Work out the ${spoken(declaration.getName())}`;
        return [made];
      }
      return nodes;
    });
  }

  if (Node.isReturnStatement(statement)) return returnNodes(walk, statement, frame, last);

  if (Node.isThrowStatement(statement)) {
    const expression = statement.getExpression();
    const found = expression ? statusOf(walk.reader, expression) : undefined;
    return [
      end(
        walk,
        'throw',
        `throws ${condense(expression?.getText() ?? 'an error', 70)}`,
        frame,
        statement,
        found,
      ),
    ];
  }

  if (Node.isIfStatement(statement)) return ifNodes(walk, statement, frame);

  // `if (!row.sku) continue;` decides what the rest of the loop body does for
  // this item; dropping it would show the work after it as unconditional.
  if (Node.isContinueStatement(statement))
    return [end(walk, 'next', 'skips to the next item', frame, statement)];
  if (Node.isBreakStatement(statement))
    return [
      end(
        walk,
        'break',
        frame.breaks === 'switch' ? 'ends this case' : 'leaves the loop',
        frame,
        statement,
      ),
    ];

  if (Node.isSwitchStatement(statement)) {
    // `case "a": case "b": …` is one arm with two labels, and a case with no
    // `break` runs on into the next one — read the arms the way they execute.
    const clauses = statement.getClauses();
    const labelOf = (clause: (typeof clauses)[number]): string =>
      Node.isCaseClause(clause)
        ? `case ${condense(clause.getExpression().getText(), 30)}`
        : 'default';
    const branches: DecisionBranch[] = [];
    let pending: string[] = [];
    clauses.forEach((clause, index) => {
      pending.push(labelOf(clause));
      if (clause.getStatements().length === 0 && index < clauses.length - 1) return;
      const body: Node[] = [];
      for (let next = index; next < clauses.length; next += 1) {
        const statements = clauses[next]!.getStatements();
        const stop = statements.findIndex((inner) => Node.isBreakStatement(inner));
        body.push(...(stop >= 0 ? statements.slice(0, stop) : statements));
        if (stop >= 0 || endsFunction(statements.at(-1))) break;
      }
      const nodes = walkStatements(
        walk,
        body,
        { ...frame, breaks: 'switch', inBranch: true },
        false,
      );
      branches.push({ label: pending.join(' / '), nodes, ends: endsAll(nodes) });
      pending = [];
    });
    if (branches.every((branch) => branch.nodes.length === 0)) return [];
    const exhaustive = clauses.some((clause) => Node.isDefaultClause(clause));
    return [
      decision(
        walk,
        `${condense(statement.getExpression().getText(), 50)}?`,
        statement.getExpression().getText(),
        frame,
        statement,
        branches,
        exhaustive ? undefined : 'no case matched',
      ),
    ];
  }

  if (Node.isTryStatement(statement)) {
    const nodes = walkStatements(walk, statement.getTryBlock().getStatements(), frame, false);
    const clause = statement.getCatchClause();
    const caught = clause
      ? [
          ...blobErrorNote(walk, statement, frame),
          ...walkStatements(walk, clause.getBlock().getStatements(), frame, false),
        ]
      : [];
    const finallyBlock = statement.getFinallyBlock();
    const after = finallyBlock
      ? walkStatements(walk, finallyBlock.getStatements(), frame, false)
      : [];
    if (nodes.length === 0 && caught.length === 0 && after.length === 0) return [];
    // `try { await send() } catch { d = null }`: an empty catch is still a
    // decision — a failure is swallowed and the code carries on — and drawing
    // the body bare would hand that failure to whatever catch is further out.
    const swallows = clause !== undefined && caught.length === 0 && nodes.some(canFail);
    if (caught.length === 0 && after.length === 0 && !swallows) return nodes;
    walk.size += 1;
    return [
      {
        type: 'try',
        side: frame.side,
        at: walk.reader.point(statement),
        nodes,
        ...(clause
          ? {
              catch: {
                label: swallows
                  ? onlyLogs(clause)
                    ? 'anything above fails — the error is only written to the console, and it carries on'
                    : 'anything above fails — the error is ignored and it carries on'
                  : 'anything above fails',
                nodes: caught,
                ends: endsAll(caught),
              },
            }
          : {}),
        ...(after.length ? { finally: after } : {}),
      },
    ];
  }

  if (
    Node.isForOfStatement(statement) ||
    Node.isForInStatement(statement) ||
    Node.isForStatement(statement) ||
    Node.isWhileStatement(statement) ||
    Node.isDoStatement(statement)
  ) {
    const body = statement.getStatement();
    const nodes = walkStatement(walk, body, { ...frame, breaks: 'loop' }, false);
    // Shown when it does real work, or decides something per item — a loop of
    // `continue`s is what produces the list the next decision looks at.
    if (!nodes.some((node) => worthShowing(node) || node.type === 'decision')) return [];
    const head = statement.getText().split('{')[0] ?? 'loop';
    walk.size += 1;
    return [
      {
        type: 'group',
        label: '',
        kind: 'loop',
        title: `repeats: ${condense(head, 60)}`,
        side: frame.side,
        at: walk.reader.point(statement),
        nodes,
      },
    ];
  }

  return [];
}

function ifNodes(walk: Walk, statement: IfStatement, frame: Frame): DecisionNode[] {
  const condition = statement.getExpression();
  const { question, thenLabel, elseLabel } = phrase(condition.getText());
  const inside = { ...frame, inBranch: true };
  const thenNodes = walkStatement(walk, statement.getThenStatement(), inside, false);
  const elseStatement = statement.getElseStatement();
  const elseNodes = elseStatement ? walkStatement(walk, elseStatement, inside, false) : [];

  // Calls inside the condition run before either branch: `if (!(await exists(id)))`.
  // A plain one is the question itself, not a step before it.
  const before = walkExpression(walk, condition, frame).filter(
    (node) => !plainCallIn(node, condition.getText()),
  );

  if (thenNodes.length === 0 && elseNodes.length === 0) return before;
  const branches: DecisionBranch[] = [];
  if (thenNodes.length > 0 || elseStatement)
    branches.push({ label: thenLabel, nodes: thenNodes, ends: endsAll(thenNodes) });
  if (elseStatement && elseNodes.length > 0)
    branches.push({ label: elseLabel, nodes: elseNodes, ends: endsAll(elseNodes) });
  const covered = elseStatement !== undefined && elseNodes.length > 0;
  return [
    ...before,
    decision(
      walk,
      question,
      condition.getText(),
      frame,
      statement,
      branches,
      covered ? undefined : elseLabel,
    ),
  ];
}

/** A helper call drawn as one line, that the text around it already shows. */
function plainCallIn(node: DecisionNode, text: string): boolean {
  return node.type === 'step' && node.kind === 'call' && text.includes(node.text);
}

function returnNodes(
  walk: Walk,
  statement: ReturnStatement,
  frame: Frame,
  last: boolean,
): DecisionNode[] {
  const expression = statement.getExpression();
  // `return handleCreate(req)` from a route: the helper's own returns are the
  // responses, so it is followed as the server rather than reported as one
  // response with whichever status its first `return` happens to give.
  const delegate = expression ? branchingHelper(walk, expression) : undefined;
  if (delegate && frame.role === 'server' && frame.depth < MAX_DEPTH) {
    const call = unwrap(expression!) as CallExpression;
    walk.size += 1;
    return [
      {
        type: 'group',
        kind: 'function',
        label: '',
        title: shortCall(call),
        side: frame.side,
        at: walk.reader.point(call),
        nodes: walkFunction(walk, delegate, { ...frame, depth: frame.depth + 1 }),
      },
    ];
  }
  // `return apiError(…, 403)` and `return { error: unauthorized() }` name their
  // status already; following the helper would only add its plumbing — but
  // what goes *into* the response is work: `json(await listMedicines(…))`.
  let found = expression && !delegate ? statusIn(walk, expression) : undefined;
  const work = !expression
    ? []
    : found
      ? responseWork(walk, expression, frame)
      : walkExpression(walk, expression, frame);
  if (frame.role === 'server') {
    // A Nest handler that returns a value answers 201 to a POST, 200 otherwise.
    if (!found && frame.defaultStatus && expression && !looksLikeResponse(expression))
      found = { statuses: [frame.defaultStatus] };
    const text = expression
      ? `responds ${condense(expression.getText(), 70)}`
      : 'responds with no body';
    return [...work, end(walk, 'respond', text, frame, statement, found)];
  }
  // The last `return` of a helper is drawn when the helper has others: its
  // ways out are the decision the caller then makes.
  const owner = nearestFunction(statement) as Functionish | undefined;
  const several = frame.role === 'helper' && owner !== undefined && returnsOf(owner).length > 1;
  if (last && !found && !several) return work;
  if (frame.role === 'handler') return [...work, end(walk, 'stop', 'stops here', frame, statement)];
  // An early `return` in a `.map`/`.forEach` callback finishes that item only.
  if (frame.role === 'item')
    return [...work, end(walk, 'next', 'finishes this item early', frame, statement)];
  const text = expression ? `returns ${condense(expression.getText(), 70)}` : 'returns';
  return [...work, end(walk, 'return', text, frame, statement, found)];
}

/** The work inside a response: its arguments, less the ones that only name a status. */
function responseWork(walk: Walk, expression: Node, frame: Frame): DecisionNode[] {
  const value = unwrap(expression);
  const parts: Node[] = Node.isCallExpression(value)
    ? value.getArguments()
    : Node.isNewExpression(value)
      ? (value.getArguments() ?? [])
      : Node.isObjectLiteralExpression(value)
        ? value
            .getProperties()
            .flatMap((property) =>
              Node.isPropertyAssignment(property) && property.getInitializer()
                ? [property.getInitializer()!]
                : [],
            )
        : [];
  return parts.flatMap((part) =>
    statusOf(walk.reader, part)?.statuses.length ? [] : walkExpression(walk, part, frame),
  );
}

/** `setTimeout(fn, 250)`, `requestAnimationFrame(fn)`: the callback, drawn as what happens next. */
function delayedCallback(walk: Walk, statement: Node, frame: Frame): DecisionNode[] | undefined {
  const expression = Node.isExpressionStatement(statement)
    ? unwrap(statement.getExpression())
    : undefined;
  // `timer.current = setTimeout(…)` too.
  const call =
    expression && Node.isBinaryExpression(expression) ? unwrap(expression.getRight()) : expression;
  if (!call || !Node.isCallExpression(call)) return undefined;
  const name = calleeText(call).split('.').pop() ?? '';
  if (!/^(setTimeout|requestAnimationFrame|queueMicrotask|setImmediate)$/.test(name))
    return undefined;
  const [callback, delay] = call.getArguments();
  const fn = callback ? functionOf(callback) : undefined;
  if (!fn) return undefined;
  const inner = walkFunction(walk, fn, { ...frame, depth: frame.depth + 1 });
  if (inner.length === 0) return undefined;
  walk.size += 1;
  return [
    {
      type: 'group',
      kind: 'function',
      label: delay ? `After ${condense(delay.getText(), 20)} ms` : 'Right after',
      title: delay ? `after ${condense(delay.getText(), 20)} ms` : 'right after',
      side: frame.side,
      at: walk.reader.point(call),
      nodes: inner,
    },
  ];
}

/** `useDebounce(search)` on the way to the refetch: how long it waits, in ms. */
function debounceOf(walk: Walk, calls: LocatedCall[]): number | undefined {
  for (const call of calls) {
    const target = walk.flow.steps.find(
      (step) => step.kind === 'api-call' && step.label === call.detail.endpoint,
    );
    if (!target) continue;
    const path = walk.graph.path(walk.flow.entryNodeId, target.nodeId, EXECUTION_EDGES);
    for (let index = 1; index < path.length; index++) {
      const edge = walk.graph
        .edgesFrom(path[index - 1]!)
        .find((candidate) => candidate.to === path[index]);
      const ms = edge?.meta?.['debounceMs'];
      if (typeof ms === 'number') return ms;
    }
  }
  return undefined;
}

/** Reached from the click only through a state change: a refetch or a part being shown. */
function reachedThroughState(walk: Walk, call: LocatedCall): boolean {
  const target = walk.flow.steps.find(
    (step) => step.kind === 'api-call' && step.label === call.detail.endpoint,
  );
  if (!target) return false;
  const path = walk.graph.path(walk.flow.entryNodeId, target.nodeId, EXECUTION_EDGES);
  return path.some((id, index) => {
    if (index === 0) return false;
    const edge = walk.graph.edgesFrom(path[index - 1]!).find((candidate) => candidate.to === id);
    return edge?.meta?.['refetch'] === true || edge?.meta?.['shows'] !== undefined;
  });
}

/**
 * `responseType: "blob"` in the try, `error.response.data.message` in the
 * catch: an error answer arrives as a Blob too, so the server's message is
 * never read and the screen falls back to the error's own text.
 */
function blobErrorNote(walk: Walk, statement: TryStatement, frame: Frame): DecisionNode[] {
  const read = statement
    .getCatchClause()
    ?.getDescendantsOfKind(SyntaxKind.PropertyAccessExpression)
    .find((access) => /response\??\.data\??\.message$/.test(access.getText()));
  if (!read) return [];
  const type = statement
    .getTryBlock()
    .getDescendantsOfKind(SyntaxKind.PropertyAssignment)
    .filter((property) => property.getName() === 'responseType')
    .map((property) => literalOf(property.getInitializer()!))
    .find((value) => value === 'blob' || value === 'arraybuffer');
  if (!type) return [];
  const made = step(
    walk,
    'compute',
    `${read.getText()} is undefined — the answer was asked for as ${type === 'blob' ? 'a Blob' : 'an ArrayBuffer'}`,
    frame,
    read,
  );
  made.label = `The server’s error message is never read: the answer was asked for as ${type === 'blob' ? 'a Blob' : 'an ArrayBuffer'}, so ${condense(read.getText(), 40)} is empty and the error’s own text (“Request failed with status code …”) is shown`;
  return [made];
}

/** `catch (e) { console.log(e) }`: the failure is printed, nothing else happens. */
function onlyLogs(clause: Node): boolean {
  if (!Node.isCatchClause(clause)) return false;
  const statements = clause.getBlock().getStatements();
  return (
    statements.length > 0 &&
    statements.every((statement) =>
      /^(console|logger|this\.logger)\.\w+\(/.test(statement.getText().trim()),
    )
  );
}

/** The response object a handler is given: `@Res() res`, `(req, res)`, Fastify's `reply`. */
const RESPONSE_PARAMS = /^(res|response|reply)$/;

/**
 * An Express/Nest `@Res()` handler answers by calling the response object, not
 * by returning: `res.status(HttpStatus.BAD_REQUEST).json(…)` ends that path
 * with a 400, `res.send(buffer)` with a 200, and `res.setHeader(…)` is a step
 * of the answer. Without this the catch read "the error is ignored".
 */
function expressResponse(walk: Walk, statement: Node, frame: Frame): DecisionNode[] | undefined {
  if (!Node.isExpressionStatement(statement)) return undefined;
  const expression = unwrap(statement.getExpression());
  if (!Node.isCallExpression(expression)) return undefined;
  const text = expression.getText();
  const root = /^([\w$]+)\./.exec(text)?.[1];
  if (!root || !RESPONSE_PARAMS.test(root)) return undefined;
  const fn = nearestFunction(statement) as Functionish | undefined;
  if (!fn?.getParameters().some((param) => param.getName() === root)) return undefined;
  const member = /\.([\w$]+)\([^]*$/.exec(text.slice(root.length))?.[1];
  const final = (
    Node.isPropertyAccessExpression(expression.getExpression())
      ? (expression.getExpression() as PropertyAccessExpression).getName()
      : ''
  ) as string;
  if (/^(setHeader|header|set|type|cookie|clearCookie|append|attachment)$/.test(final)) {
    const made = step(walk, 'compute', condense(text, 90), frame, statement);
    const [name, value] = expression
      .getArguments()
      .map((arg) => literalOf(arg) ?? condense(arg.getText(), 60));
    made.label = name
      ? `Set the ${name} header${value ? ` to ${value}` : ''}`
      : `Set the response ${final}`;
    return [made];
  }
  if (!/^(json|send|end|redirect|sendFile|download|render|sendStatus)$/.test(final) || !member)
    return undefined;
  const status = /\.status\(\s*([^)]+)\)/.exec(text)?.[1];
  const found = statusOf(walk.reader, expression);
  const code =
    found?.statuses[0] ?? (status ? statusFromText(status) : final === 'redirect' ? 302 : 200);
  const body = expression.getArguments()[0];
  return [
    ...(body ? responseWork(walk, expression, frame) : []),
    end(
      walk,
      'respond',
      body ? `responds ${code} with ${condense(body.getText(), 60)}` : `responds ${code}`,
      frame,
      statement,
      { statuses: [code] },
    ),
  ];
}

/** `400`, `HttpStatus.BAD_REQUEST`, `StatusCodes.NOT_FOUND`. */
function statusFromText(text: string): number {
  const number = Number(text.trim());
  if (Number.isInteger(number)) return number;
  const name = text.trim().split('.').pop() ?? '';
  const known: Record<string, number> = {
    OK: 200,
    CREATED: 201,
    ACCEPTED: 202,
    NO_CONTENT: 204,
    BAD_REQUEST: 400,
    UNAUTHORIZED: 401,
    FORBIDDEN: 403,
    NOT_FOUND: 404,
    CONFLICT: 409,
    UNPROCESSABLE_ENTITY: 422,
    TOO_MANY_REQUESTS: 429,
    INTERNAL_SERVER_ERROR: 500,
    SERVICE_UNAVAILABLE: 503,
  };
  return known[name] ?? 200;
}

/** `Response.json(…)`, `res.status(…).json(…)`, `new Response(…)` — an answer already. */
function looksLikeResponse(expression: Node): boolean {
  return /^(new )?(Response|NextResponse)\b|\.(json|send|status|redirect)\(/.test(
    unwrap(expression).getText(),
  );
}

function forwardedStatuses(
  walk: Walk,
  access: PropertyAccessExpression,
): { statuses: number[] } | undefined {
  const base = unwrap(access.getExpression());
  if (!Node.isIdentifier(base)) return undefined;
  const init = declarationOf(base)?.getInitializer();
  const call = init ? unwrap(init) : undefined;
  if (!call || !Node.isCallExpression(call)) return undefined;
  const helper = resolveCallee(walk, call);
  if (!helper) return undefined;
  const statuses = new Set<number>();
  for (const returned of returnsOf(helper)) {
    const object = unwrap(returned);
    if (!Node.isObjectLiteralExpression(object)) continue;
    const property = object.getProperty(access.getName());
    if (!property || !Node.isPropertyAssignment(property)) continue;
    const initializer = property.getInitializer();
    for (const status of (initializer ? statusOf(walk.reader, initializer)?.statuses : []) ?? [])
      statuses.add(status);
  }
  return statuses.size ? { statuses: [...statuses].sort((a, b) => a - b) } : undefined;
}

/**
 * The project function a returned call runs, when it can return more than one
 * thing — `apiError(msg, 400)` has one `return` and names its status; a
 * handler with an `if` and two responses does not.
 */
function branchingHelper(walk: Walk, expression: Node): Functionish | undefined {
  const value = unwrap(expression);
  if (!Node.isCallExpression(value)) return undefined;
  const target = resolveCallee(walk, value);
  if (!target || walk.stack.includes(target)) return undefined;
  return returnsOf(target).length > 1 ? target : undefined;
}

/** The status a returned value carries: the value itself, or one of its properties. */
function statusIn(
  walk: Walk,
  expression: Node,
): { statuses: number[]; message?: string } | undefined {
  const direct = statusOf(walk.reader, expression);
  if (direct?.statuses.length) return direct;
  const value = unwrap(expression);
  // `const response = NextResponse.json(…); …; return response;`
  if (Node.isIdentifier(value)) {
    const init = declarationOf(value)?.getInitializer();
    const held = init ? statusOf(walk.reader, init) : undefined;
    if (held?.statuses.length) return held;
  }
  // `return ctx.error` where `ctx = await requireClinic(…)`: every status that
  // helper puts under `error`.
  if (Node.isPropertyAccessExpression(value)) {
    const forwarded = forwardedStatuses(walk, value);
    if (forwarded) return forwarded;
  }
  if (!Node.isObjectLiteralExpression(value)) return undefined;
  for (const property of value.getProperties()) {
    if (!Node.isPropertyAssignment(property)) continue;
    const initializer = property.getInitializer();
    const inner = initializer ? statusOf(walk.reader, initializer) : undefined;
    if (inner?.statuses.length) return inner;
  }
  return undefined;
}

/**
 * Every call an expression makes that belongs in the tree, in the order they
 * run — arguments before the call that receives them.
 */
function walkExpression(walk: Walk, expression: Node, frame: Frame): DecisionNode[] {
  const node = unwrap(expression);

  if (Node.isConditionalExpression(node)) {
    const before = walkExpression(walk, node.getCondition(), frame);
    const yes = walkExpression(walk, node.getWhenTrue(), frame);
    const no = walkExpression(walk, node.getWhenFalse(), frame);
    if (yes.length === 0 && no.length === 0) return before;
    const { question, thenLabel, elseLabel } = phrase(node.getCondition().getText());
    return [
      ...before,
      decision(walk, question, node.getCondition().getText(), frame, node, [
        { label: thenLabel, nodes: yes, ends: endsAll(yes) },
        { label: elseLabel, nodes: no, ends: endsAll(no) },
      ]),
    ];
  }

  if (Node.isBinaryExpression(node)) {
    const operator = node.getOperatorToken().getKind();
    if (
      operator === SyntaxKind.AmpersandAmpersandToken ||
      operator === SyntaxKind.BarBarToken ||
      operator === SyntaxKind.QuestionQuestionToken
    ) {
      const before = walkExpression(walk, node.getLeft(), frame);
      const right = walkExpression(walk, node.getRight(), frame);
      if (right.length === 0) return before;
      const left = node.getLeft().getText();
      const { question, thenLabel, elseLabel } = phrase(left);
      const label =
        operator === SyntaxKind.AmpersandAmpersandToken
          ? thenLabel
          : operator === SyntaxKind.BarBarToken
            ? elseLabel
            : 'is null';
      return [
        ...before,
        decision(
          walk,
          operator === SyntaxKind.QuestionQuestionToken
            ? `${condense(left, 50)} is null?`
            : question,
          left,
          frame,
          node,
          [
            {
              label: operator === SyntaxKind.QuestionQuestionToken ? 'yes' : label,
              nodes: right,
              ends: endsAll(right),
            },
          ],
          'otherwise',
        ),
      ];
    }
    const work = [
      ...walkExpression(walk, node.getLeft(), frame),
      ...walkExpression(walk, node.getRight(), frame),
    ];
    // `window.location.href = "/login"` sends the user somewhere else.
    if (
      operator === SyntaxKind.EqualsToken &&
      /^(window\.)?location(\.href)?$/.test(node.getLeft().getText())
    ) {
      const target = literalOf(node.getRight()) ?? condense(node.getRight().getText(), 50);
      const go = step(walk, 'ui', condense(node.getText(), 80), frame, node);
      go.label = `Go to ${target}`;
      work.push(go);
    }
    return work;
  }

  // The calls in this expression, not inside functions it creates.
  const calls = [node, ...node.getDescendants()]
    .filter((candidate): candidate is CallExpression => Node.isCallExpression(candidate))
    .filter((call) => ownedBy(call, node))
    .sort((a, b) => a.getEnd() - b.getEnd());

  const kept = calls
    .map((call) => ({ call, kind: classify(walk, call, frame) }))
    .filter((entry) => entry.kind !== undefined);
  const out: DecisionNode[] = [];
  const handled = new Set<CallExpression>();
  for (const { call, kind } of kept) {
    if (handled.has(call) || walk.size >= MAX_NODES) continue;
    // `Promise.all([a(), b()])` draws its own members; skip them here.
    if (
      kept.some(
        (other) =>
          other.kind === 'parallel' && other.call !== call && insideArguments(call, other.call),
      )
    )
      continue;
    const nodes = callNodes(walk, call, kind!, frame, handled);
    // `setError(message(e))`: a plain helper inside another call's arguments is
    // part of what that call shows. One with a request or a query inside —
    // `setData(await loadOrders())` — is the step itself, and stays.
    if (
      (kind === 'project' || kind === 'ui') &&
      insideArgumentsOfKept(call, kept) &&
      nodes.every((node) => node.type === 'step')
    )
      continue;
    out.push(...nodes);
  }
  return out;
}

type CallKind =
  | 'request'
  | 'parallel'
  | 'iife'
  | 'outside'
  | 'bound'
  | 'hooked'
  | 'effect'
  | 'query'
  | 'mutate'
  | 'continuation'
  | 'each'
  | 'prop'
  | 'ui'
  | 'project';

/** Array methods whose callback runs once per item. */
const EACH = new Set([
  'map',
  'forEach',
  'flatMap',
  'filter',
  'some',
  'every',
  'reduce',
  'find',
  'findIndex',
]);

function classify(walk: Walk, call: CallExpression, frame: Frame): CallKind | undefined {
  if (walk.requests.has(siteKey(call))) return 'request';
  const head = calleeText(call);
  if (/^Promise\.(all|allSettled|race|any)$/.test(head)) {
    const [list] = call.getArguments();
    if (list && Node.isArrayLiteralExpression(unwrap(list))) return 'parallel';
  }
  const target = unwrap(call.getExpression());
  if (Node.isArrowFunction(target) || Node.isFunctionExpression(target)) return 'iife';
  if (Node.isIdentifier(call.getExpression()) && frame.bound?.has(head)) return 'bound';
  if (effectsAt(walk, call).length > 0) return 'effect';
  if (unlinkedQuery(walk, call)) return 'query';
  const text = calleeText(call);
  if (MUTATIONS.test(text)) return 'mutate';
  const member = text.split('.').pop() ?? '';
  if ((member === 'then' || member === 'catch') && call.getArguments().length > 0)
    return 'continuation';
  if (
    EACH.has(member) &&
    call.getArguments().some((arg) => functionOf(arg)) &&
    !resolveCallee(walk, call)
  )
    return 'each';
  if (Node.isIdentifier(call.getExpression()) && walk.childProps.has(text)) return 'prop';
  // `const { refetch } = useMedicines()` is that query's request again.
  if (Node.isIdentifier(call.getExpression()) && hookMember(walk, call)?.request) return 'hooked';
  // `setImportJobId(…)` is a function in the project that writes to the
  // database; only a `set…` nobody declared as a function is a state setter.
  if (/^set[A-Z]\w*$/.test(text) && resolveCallee(walk, call)) return 'project';
  if (UI_CALLS.test(text) || /^set[A-Z]\w*$/.test(text)) return 'ui';
  if (resolveCallee(walk, call)) return 'project';
  if (Node.isIdentifier(call.getExpression()) && hookMember(walk, call)) return 'hooked';
  // `fetch(url)` that is not one of this app's own requests leaves the app.
  if (
    /^(fetch|axios|got|ky|axios\.(get|post|put|patch|delete|head|request)|(got|ky)\.(get|post|put|patch|delete)|superagent\.(get|post|put|patch|delete))$/.test(
      text,
    )
  )
    return 'outside';
  if (Node.isIdentifier(call.getExpression()) && isProp(call, text)) return 'ui';
  // `URL.createObjectURL(blob)`, `a.click()`: how the browser is made to save a file.
  if (
    frame.side === 'browser' &&
    DOWNLOAD_CALLS.test(text) &&
    /\.download\s*=/.test(nearestFunction(call)?.getText() ?? '')
  )
    return 'ui';
  return undefined;
}

const DOWNLOAD_CALLS =
  /^((window\.)?URL\.(createObjectURL|revokeObjectURL)|[\w$]+\.click|document\.body\.(appendChild|removeChild))$/;

function callNodes(
  walk: Walk,
  call: CallExpression,
  kind: CallKind,
  frame: Frame,
  handled: Set<CallExpression>,
): DecisionNode[] {
  switch (kind) {
    case 'request': {
      const located = walk.requests.get(siteKey(call))!;
      return requestNodes(walk, located, frame);
    }
    case 'effect':
      return effectsAt(walk, call).flatMap((effect): DecisionNode[] => {
        walk.size += 1;
        const meta = effect.meta ?? {};
        const isDb = effect.kind === 'db-op';
        const made: DecisionStep = {
          type: 'step',
          kind: isDb ? 'db' : 'external',
          label: '',
          text: isDb ? effect.label : `${effect.label} (leaves the app)`,
          side: isDb ? 'database' : 'external',
          at: walk.reader.point(call),
          ...(isDb
            ? { effect: upsertAware(call, String(meta['effect'] ?? meta['access'] ?? 'read')) }
            : {}),
          ...(isDb && queryDetail(call) ? { detail: queryDetail(call) } : {}),
          nodeId: effect.id,
        };
        const nodes: DecisionNode[] = [
          made,
          ...(isDb ? pipelineRows(walk, call, String(meta['collection'] ?? ''), frame) : []),
        ];
        // After the answer, not here: the worker takes the job once it is sent.
        if (!isDb) walk.later.push(...workerNodes(walk, effect, frame));
        return nodes;
      });
    case 'query': {
      const found = unlinkedQuery(walk, call)!;
      walk.size += 1;
      return [
        {
          type: 'step',
          kind: 'db',
          label: '',
          text: `${found.collection}.${found.operation}`,
          side: 'database',
          at: walk.reader.point(call),
          effect: upsertAware(call, found.effect),
          ...(queryDetail(call) ? { detail: queryDetail(call) } : {}),
        },
        ...pipelineRows(walk, call, found.collection, frame),
      ];
    }
    case 'parallel': {
      const list = unwrap(call.getArguments()[0]!) as ArrayLiteralExpression;
      const inner = list.getElements().flatMap((element) => walkExpression(walk, element, frame));
      if (inner.length === 0) return [];
      walk.size += 1;
      return [
        {
          type: 'group',
          kind: 'parallel',
          label: '',
          title: `at the same time (${calleeText(call)})`,
          side: frame.side,
          at: walk.reader.point(call),
          nodes: inner,
        },
      ];
    }
    case 'iife': {
      // `(async () => { … })()` runs where it is written.
      const fn = unwrap(call.getExpression()) as Functionish;
      return walkFunction(walk, fn, { ...frame, role: 'helper', depth: frame.depth + 1 });
    }
    case 'bound': {
      // The callee runs the function its caller handed it: `fn()` is `setCategory(v)`.
      const fn = frame.bound!.get(calleeText(call))!;
      return walkFunction(walk, fn, { ...frame, role: 'helper', depth: frame.depth + 1 });
    }
    case 'hooked': {
      const member = hookMember(walk, call)!;
      if (member.request) return requestNodes(walk, member.request, frame);
      if (member.fn && frame.depth < MAX_DEPTH && !walk.stack.includes(member.fn)) {
        const inner = walkFunction(walk, member.fn, {
          ...frame,
          role: 'helper',
          depth: frame.depth + 1,
        });
        if (inner.some(worthShowing)) {
          walk.size += 1;
          return [
            {
              type: 'group',
              kind: 'function',
              label: '',
              title: shortCall(call),
              side: frame.side,
              at: walk.reader.point(call),
              nodes: inner,
            },
          ];
        }
      }
      const node = step(walk, 'ui', shortCall(call), frame, call);
      node.label = `Call ${calleeText(call)}() from ${member.hook}()`;
      return [node];
    }
    case 'outside': {
      const text = calleeText(call);
      const [target] = call.getArguments();
      const where = target ? (literalOf(target) ?? condense(target.getText(), 50)) : '';
      // `axios.post("/api/auth/refresh")` is this app's own route, not a third party.
      const own = where.startsWith('/');
      const verb = /\.(get|post|put|patch|delete|head)$/.exec(text)?.[1]?.toUpperCase();
      walk.size += 1;
      return [
        {
          type: 'step',
          kind: own ? 'ui' : 'external',
          label: own
            ? `Request this app’s own ${verb ? `${verb} ` : ''}${where}`
            : `Call an outside service${where ? `: ${where}` : ''}`,
          text: shortCall(call),
          side: own ? frame.side : 'external',
          at: walk.reader.point(call),
        },
      ];
    }
    case 'mutate':
      return mutateNodes(walk, call, frame);
    case 'each': {
      // `rows.map(async (row) => medicines.insertOne(row))`: the query runs per
      // row, which is a loop the tree must show, not code it may skip.
      const callback = call
        .getArguments()
        .map((arg) => functionOf(arg))
        .find(Boolean)!;
      const inner = walkFunction(walk, callback, {
        ...frame,
        role: 'item',
        depth: frame.depth + 1,
      });
      if (!inner.some((node) => worthShowing(node) || node.type === 'decision')) return [];
      const callee = call.getExpression() as PropertyAccessExpression;
      walk.size += 1;
      return [
        {
          type: 'group',
          kind: 'loop',
          label: '',
          title: `for each item of ${condense(callee.getExpression().getText(), 40)}`,
          side: frame.side,
          at: walk.reader.point(call),
          nodes: inner,
        },
      ];
    }
    case 'continuation':
      return continuationNodes(walk, call, frame, handled);
    case 'prop': {
      if (!walk.parentHandler)
        return [step(walk, 'ui', `calls the ${calleeText(call)} prop`, frame, call)];
      const parent = walk.parentHandler;
      walk.parentHandler = undefined;
      return [
        functionNode(
          walk,
          parent,
          { ...frame, role: 'helper', depth: frame.depth + 1 },
          `${calleeText(call)} → ${nameOf(parent)}`,
        ),
      ];
    }
    case 'ui': {
      const node = step(walk, 'ui', shortCall(call), frame, call);
      node.label = uiLabel(call);
      return [node];
    }
    case 'project': {
      const target = resolveCallee(walk, call)!;
      const label = shortCall(call);
      if (frame.depth >= MAX_DEPTH)
        return [step(walk, 'call', `${label} — not followed further`, frame, call)];
      // A helper handed a function runs it, so each call is opened on its own.
      const takesFunctions = call.getArguments().some((arg) => functionOf(arg) !== undefined);
      const callKey = `${target.getSourceFile().getFilePath()}:${target.getStart()}(${call
        .getArguments()
        .map((arg) => arg.getText())
        .join(',')})`;
      if (walk.openedCalls.has(callKey) && !takesFunctions)
        return [step(walk, 'call', `${label} — opened above`, frame, call)];
      const bound = new Map<string, Functionish>();
      target.getParameters().forEach((param, index) => {
        const arg = call.getArguments()[index];
        const fn =
          functionOf(arg) ??
          (arg && Node.isIdentifier(arg) ? resolveName(walk, arg.getText(), arg) : undefined);
        if (fn && Node.isIdentifier(param.getNameNode())) bound.set(param.getName(), fn);
      });
      const walked = walkFunction(walk, target, {
        side: frame.side,
        role: 'helper',
        depth: frame.depth + 1,
        ...(bound.size ? { bound } : {}),
      });
      const inner = passportChecks(walk, target, frame, call, walked) ?? walked;
      if (!inner.some(worthShowing)) return [step(walk, 'call', label, frame, call)];
      walk.openedCalls.add(callKey);
      walk.size += 1;
      return [
        {
          type: 'group',
          label: '',
          kind: 'function',
          title: label,
          side: frame.side,
          at: walk.reader.point(call),
          callee: walk.reader.point(target),
          nodes: inner,
        },
      ];
    }
  }
}

/**
 * What an aggregation does to each row, drawn as the decisions it makes:
 * `$match` keeps the rows that pass, `$lookup` reads another collection, and
 * `$unwind` without `preserveNullAndEmptyArrays` drops a row whose lookup
 * found nothing. Listed only by stage name, a report that silently left out
 * every appointment without a bill looked like it read them all.
 */
function pipelineRows(
  walk: Walk,
  call: CallExpression,
  collection: string,
  frame: Frame,
): DecisionNode[] {
  const base = baseQueryCall(call);
  const callee = base?.getExpression();
  if (!base || !Node.isPropertyAccessExpression(callee) || callee.getName() !== 'aggregate')
    return [];
  let pipeline = base.getArguments()[0] ? unwrap(base.getArguments()[0]!) : undefined;
  // `const pipeline = [...]; model.aggregate(pipeline)`.
  if (pipeline && Node.isIdentifier(pipeline)) {
    const init = declarationOf(pipeline)?.getInitializer();
    pipeline = init ? unwrap(init) : undefined;
  }
  if (!pipeline || !Node.isArrayLiteralExpression(pipeline)) return [];
  const inside: Frame = { ...frame, side: 'database' };
  const nodes: DecisionNode[] = [];
  const leftOut = (at: Node, why: string): DecisionEnd => {
    const made = end(walk, 'next', `left out of the result — ${why}`, inside, at);
    made.label = `Left out of the result — ${why}`;
    return made;
  };
  for (const element of pipeline.getElements()) {
    const stage = unwrap(element);
    if (!Node.isObjectLiteralExpression(stage)) continue;
    const property = stage.getProperties()[0];
    if (!property || !Node.isPropertyAssignment(property)) continue;
    const name = property.getName().replace(/^['"]|['"]$/g, '');
    const value = unwrap(property.getInitializer()!);
    const field = (key: string): string | undefined => {
      if (!Node.isObjectLiteralExpression(value)) return undefined;
      const found = value.getProperty(key);
      const init = found && Node.isPropertyAssignment(found) ? found.getInitializer() : undefined;
      return init ? (literalOf(init) ?? init.getText()) : undefined;
    };
    if (name === '$lookup') {
      const from = field('from');
      if (!from) continue;
      const local = field('localField');
      const foreign = field('foreignField');
      const made = step(
        walk,
        'db',
        `${from}.$lookup${local ? ` — ${local} → ${foreign ?? '_id'}` : ''}${field('as') ? `, as ${field('as')}` : ''}`,
        inside,
        element,
      );
      made.effect = 'read';
      made.label = `Look up the matching ${from}`;
      nodes.push(made);
    } else if (name === '$unwind') {
      const path = (Node.isObjectLiteralExpression(value) ? field('path') : literalOf(value)) ?? '';
      if (/^true$/.test(field('preserveNullAndEmptyArrays') ?? '')) continue;
      const what = path.replace(/^\$/, '');
      if (!what) continue;
      const asked = decision(
        walk,
        `has a ${what}?`,
        `$unwind: '${path}'`,
        inside,
        element,
        [{ label: 'no', nodes: [leftOut(element, `no ${what}`)], ends: true }],
        'yes — one row per match',
      );
      asked.label = `Has a matching ${what}?`;
      nodes.push(asked);
    } else if (name === '$match' && Node.isObjectLiteralExpression(value)) {
      const tests = value.getProperties().map((test) => {
        // `{ ownerId }`: the field equals the value of that name.
        if (Node.isShorthandPropertyAssignment(test))
          return `${test.getName()} = ${test.getName()}`;
        if (!Node.isPropertyAssignment(test)) return condense(test.getText(), 30);
        const key = test.getName().replace(/^['"]|['"]$/g, '');
        const wanted = unwrap(test.getInitializer()!);
        const text = wanted.getText().replace(/\s+/g, ' ');
        if (/^\{\s*\$size:\s*0\s*\}$/.test(text)) return `${key} is empty`;
        if (/\$(gte|gt|lte|lt)\b/.test(text)) return `${key} in range`;
        if (/^\{\s*\$in\b/.test(text)) return `${key} is one of the list`;
        if (/^\{\s*\$exists:\s*true/.test(text)) return `${key} is set`;
        return `${key} = ${condense(text, 30)}`;
      });
      if (tests.length === 0) continue;
      const question = condense(tests.join(' and '), 90);
      const asked = decision(
        walk,
        `${question}?`,
        condense(value.getText(), 120),
        inside,
        element,
        [{ label: 'no', nodes: [leftOut(element, 'it does not match')], ends: true }],
        'yes',
      );
      asked.label = `${capitalise(question)}?`;
      nodes.push(asked);
    }
  }
  if (!nodes.some((node) => node.type === 'decision')) return nodes;
  walk.size += 1;
  return [
    {
      type: 'group',
      kind: 'loop',
      label: `For each record in ${collection || 'the collection'}, inside the database`,
      title: `for each record in ${collection || 'the collection'}, inside the database`,
      side: 'database',
      at: walk.reader.point(base),
      nodes,
    },
  ];
}

/**
 * `queue.add("import", rows)` only puts a job in Redis; the rows are written
 * later by the worker that takes it — drawn here, after the response, with
 * the worker's own `on("failed")` for a job that crashes.
 */
function workerNodes(walk: Walk, effect: FlowNode, frame: Frame): DecisionNode[] {
  const edge = walk.graph
    .edgesFrom(effect.id, ['calls'])
    .find((candidate) => candidate.meta?.['background'] === true);
  const target = edge ? walk.graph.node(edge.to) : undefined;
  const file = target?.source ? walk.reader.file(target.source.file) : undefined;
  const fn = file && target?.source ? functionAtLine(file, target.source.line) : undefined;
  if (!fn || walk.opened.has(fn) || frame.depth >= MAX_DEPTH) return [];
  walk.opened.add(fn);
  const inside: Frame = { side: 'server', role: 'helper', depth: frame.depth + 1 };
  const nodes = walkFunction(walk, fn, inside);
  const name = nameOf(fn);
  // Where the worker is made: `new Worker(queue, (job) => processImportJob(job))`.
  for (const rel of projectFiles(walk)) {
    const source = walk.reader.file(rel);
    if (!source || !source.getFullText().includes('new Worker')) continue;
    const made = source
      .getDescendantsOfKind(SyntaxKind.NewExpression)
      .find(
        (created) =>
          created.getExpression().getText() === 'Worker' &&
          new RegExp(`\\b${name}\\b`).test(created.getText()),
      );
    if (!made) continue;
    const worker = made.getFirstAncestorByKind(SyntaxKind.VariableDeclaration)?.getName();
    const failed = source
      .getDescendantsOfKind(SyntaxKind.CallExpression)
      .find(
        (call) =>
          calleeText(call) === `${worker}.on` &&
          call.getArguments()[0] !== undefined &&
          literalOf(call.getArguments()[0]!) === 'failed',
      );
    const handler = failed ? functionOf(failed.getArguments()[1]) : undefined;
    if (handler) {
      const crashed = walkFunction(walk, handler, inside);
      if (crashed.length) {
        walk.size += 1;
        nodes.push({
          type: 'group',
          kind: 'function',
          label: 'If the job crashes, the worker’s failure handler runs',
          title: `if the job crashes: ${worker}.on("failed")`,
          side: 'server',
          at: walk.reader.point(failed!),
          nodes: crashed,
        });
      }
    }
    break;
  }
  walk.size += 1;
  const queue = edge?.meta?.['queue'];
  return [
    {
      type: 'group',
      kind: 'function',
      label: `Later, after the response is sent, a background worker${typeof queue === 'string' ? ` on queue "${queue}"` : ''} runs ${name}`,
      title: `later, in the background worker: ${name}()`,
      side: 'server',
      at: walk.reader.point(fn),
      callee: walk.reader.point(fn),
      nodes,
    },
  ];
}

/** The request, then the server function that answers it, in a box of its own. */
function requestNodes(walk: Walk, located: LocatedCall, frame: Frame): DecisionNode[] {
  if (walk.drawn.has(located)) {
    return [
      step(walk, 'call', `${located.detail.method} ${located.detail.path} (see above)`, frame),
    ];
  }
  walk.drawn.add(located);
  const { detail } = located;
  const nodes: DecisionNode[] = [];
  for (const guard of detail.middleware) {
    const body = middlewareBody(walk, guard);
    if (body && !walk.opened.has(body)) {
      walk.opened.add(body);
      walk.size += 1;
      nodes.push({
        type: 'group',
        kind: 'function',
        label: `${guard.name} runs before the handler`,
        title: `${guard.role === 'guard' ? 'checked by' : `${guard.role}:`} ${guard.name}`,
        side: 'server',
        ...(guard.file ? { at: { file: guard.file, line: guard.line ?? 1 } } : {}),
        callee: walk.reader.point(body),
        nodes: ((walked) =>
          passportChecks(walk, body, { ...frame, side: 'server' }, body, walked) ?? walked)(
          walkFunction(walk, body, { side: 'server', role: 'helper', depth: frame.depth + 1 }),
        ),
      });
      continue;
    }
    const checks =
      guard.role === 'pipe' && /Validation/.test(guard.name)
        ? dtoWords(walk, detail.dto?.name)
        : undefined;
    nodes.push({
      type: 'step',
      kind: 'guard',
      label: '',
      text: `${guard.role === 'guard' ? 'checked by' : `${guard.role}:`} ${guard.name}${checks ? ` — checks ${checks}` : ''}`,
      side: 'server',
      ...(guard.file ? { at: { file: guard.file, line: guard.line ?? 1 } } : {}),
    });
  }
  const handler = located.backendFns[0];
  if (handler) {
    const nest = detail.route?.framework === 'nestjs';
    const server: Frame = {
      side: 'server',
      role: 'server',
      depth: frame.depth + 1,
      ...(nest ? { defaultStatus: detail.method === 'POST' ? 201 : 200 } : {}),
    };
    nodes.push(...walkFunction(walk, handler.fn, server));
    nodes.push(...walk.later.splice(0));
  } else if (!detail.matched) {
    nodes.push({
      type: 'end',
      outcome: 'respond',
      label: '',
      text: 'no route in the scanned code answers this request',
      side: 'server',
    });
  }
  walk.size += 1;
  const wrapper = requestWrapper(walk, located);
  return [
    ...(wrapper ? wrapperNodes(walk, wrapper, frame, located) : []),
    ...requestInterceptorNodes(walk, located, frame, wrapper?.client),
    {
      type: 'group',
      label: '',
      kind: 'request',
      title: `${detail.method} ${detail.path}`,
      side: 'server',
      ...(located.call ? { at: walk.reader.point(located.call) } : {}),
      ...(handler ? { handledBy: handler.at } : {}),
      nodes,
    },
    ...interceptorNodes(walk, located, frame, wrapper?.client),
  ];
}

/** `DateRangeAppointmentsDto: from_date (string, optional), to_date (string, optional)`. */
function dtoWords(walk: Walk, name: string | undefined): string | undefined {
  if (!name) return undefined;
  const fields = walk.graph
    .successors(`dto:${name}`, ['defines', 'validates'])
    .filter((node) => node.kind === 'field')
    .map((field) => {
      const type = field.meta?.['type'];
      const notes = [
        ...(typeof type === 'string' ? [type] : []),
        ...(field.meta?.['optional'] === true ? ['optional'] : []),
      ];
      return `${field.label}${notes.length ? ` (${notes.join(', ')})` : ''}`;
    });
  return `${name}${fields.length ? `: ${fields.join(', ')}` : ''}`;
}

/**
 * `getRequest({ url, auth })` is the app's own function around the HTTP
 * client: it picks the token, then calls `axiosDefaultInstance.get(…)`. Its
 * body is part of what the click does, and its client is the one whose
 * interceptors answer a 401.
 */
function requestWrapper(
  walk: Walk,
  located: LocatedCall,
): { fn: Functionish; client: CallExpression } | undefined {
  const call = located.call;
  if (!call || !Node.isIdentifier(call.getExpression())) return undefined;
  const fn = resolveCallee(walk, call);
  if (!fn) return undefined;
  const client = fn
    .getDescendantsOfKind(SyntaxKind.CallExpression)
    .find((inner) =>
      /^[\w$]+\.(get|post|put|patch|delete|request|head)$/.test(inner.getExpression().getText()),
    );
  return client ? { fn, client } : undefined;
}

/** What the wrapper does before it sends: the work above its `return client.get(…)`. */
function wrapperNodes(
  walk: Walk,
  wrapper: { fn: Functionish; client: CallExpression },
  frame: Frame,
  located: LocatedCall,
): DecisionNode[] {
  if (walk.opened.has(wrapper.fn)) return [];
  const sending = wrapper.client.getFirstAncestor(
    (node) => Node.isStatement(node) && node.getParent() === wrapper.fn.getBody(),
  );
  const before = bodyStatements(wrapper.fn).filter(
    (statement) => !sending || statement.getEnd() <= sending.getPos(),
  );
  const inner = walkStatements(
    walk,
    before,
    { side: 'browser', role: 'helper', depth: frame.depth + 1 },
    false,
  );
  if (!inner.some((node) => worthShowing(node) || node.type === 'decision')) return [];
  const send = sendStep(walk, wrapper, located, frame);
  if (send) inner.push(send);
  walk.opened.add(wrapper.fn);
  walk.size += 1;
  return [
    {
      type: 'group',
      kind: 'function',
      label: `${nameOf(wrapper.fn)} prepares the request`,
      title: `${nameOf(wrapper.fn)}()`,
      side: 'browser',
      at: walk.reader.point(wrapper.fn),
      callee: walk.reader.point(wrapper.fn),
      nodes: inner,
    },
  ];
}

/** The API client a request goes through, and where its interceptors are written. */
function clientOf(
  walk: Walk,
  located: LocatedCall,
  via?: CallExpression,
): { name: string; uses: CallExpression[] } | undefined {
  const callee = (via ?? located.call)?.getExpression();
  const base =
    callee && Node.isPropertyAccessExpression(callee) ? unwrap(callee.getExpression()) : undefined;
  if (!base || !Node.isIdentifier(base)) return undefined;
  const declared = walk.reader.declaration(base.getText(), base.getSourceFile());
  const file = declared?.getSourceFile();
  if (!file) return undefined;
  const name = base.getText();
  // This client's own: a file often sets up several, each with its own.
  const uses = file
    .getDescendantsOfKind(SyntaxKind.CallExpression)
    .filter((candidate) =>
      new RegExp(`^${name.replace(/\$/g, '\\$')}\\.interceptors\\.(request|response)\\.use$`).test(
        calleeText(candidate),
      ),
    );
  return { name, uses };
}

function interceptorFn(
  walk: Walk,
  use: CallExpression | undefined,
  index: number,
): Functionish | undefined {
  const handler = use?.getArguments()[index];
  if (!handler) return undefined;
  return (
    functionOf(handler) ??
    (Node.isIdentifier(handler) ? resolveName(walk, handler.getText(), handler) : undefined)
  );
}

/** One interceptor, opened once per action and named after that. */
function interceptorGroup(
  walk: Walk,
  fn: Functionish,
  use: CallExpression,
  frame: Frame,
  title: string,
  label: string,
  /** An error handler that ends without a return resolves the request with nothing. */
  onError = false,
): DecisionNode[] {
  if (walk.opened.has(fn)) {
    const again = step(walk, 'call', `${title} — opened above`, frame, use);
    again.label = `${label} (opened above)`;
    return [again];
  }
  const inner = walkFunction(walk, fn, { side: 'browser', role: 'helper', depth: frame.depth + 1 });
  if (onError && !endsAll(inner)) {
    const empty = end(
      walk,
      'return',
      'returns nothing — the request resolves with undefined instead of failing',
      { ...frame, side: 'browser' },
      fn,
    );
    empty.label = 'Give back nothing — the caller gets undefined, not an error';
    inner.push(empty);
  }
  if (!inner.some(worthShowing)) return [];
  walk.opened.add(fn);
  walk.size += 1;
  return [
    {
      type: 'group',
      kind: 'function',
      label,
      title,
      side: 'browser',
      at: walk.reader.point(use),
      callee: walk.reader.point(fn),
      nodes: inner,
    },
  ];
}

/** `api.interceptors.request.use(fn)`: runs before every request the client sends. */
function requestInterceptorNodes(
  walk: Walk,
  located: LocatedCall,
  frame: Frame,
  via?: CallExpression,
): DecisionNode[] {
  const client = clientOf(walk, located, via);
  const use = client?.uses.find((candidate) => /\.request\.use$/.test(calleeText(candidate)));
  const fn = interceptorFn(walk, use, 0);
  if (!client || !use || !fn) return [];
  return interceptorGroup(
    walk,
    fn,
    use,
    frame,
    `${client.name}.interceptors.request`,
    'Before it is sent, the API client’s request interceptor runs',
  );
}

/**
 * How the wrapper sends: `client.get(url, { headers: { Authorization: auth ?
 * \`Bearer ${token}\` : …}, timeout: 60000, responseType })`, with what this
 * caller passed — `auth: true`, `responseType: "blob"` — put in.
 */
function sendStep(
  walk: Walk,
  wrapper: { fn: Functionish; client: CallExpression },
  located: LocatedCall,
  frame: Frame,
): DecisionStep | undefined {
  const options = wrapper.client
    .getArguments()
    .map((arg) => unwrap(arg))
    .filter((arg) => Node.isObjectLiteralExpression(arg))
    .at(-1);
  if (!options || !Node.isObjectLiteralExpression(options)) return undefined;
  const passed = located.call?.getArguments()[0];
  const given = new Map<string, Node>();
  if (passed && Node.isObjectLiteralExpression(unwrap(passed)))
    for (const property of (unwrap(passed) as ObjectLiteralExpression).getProperties()) {
      if (Node.isPropertyAssignment(property) && property.getInitializer())
        given.set(property.getName(), property.getInitializer()!);
    }
  /** The value this call ends up with: the caller's argument, or the arm of a `?:` it picks. */
  const resolve = (node: Node | undefined): string | undefined => {
    if (!node) return undefined;
    const value = unwrap(node);
    if (Node.isIdentifier(value)) {
      const from = given.get(value.getText());
      return from ? (literalOf(from) ?? from.getText()) : undefined;
    }
    if (Node.isConditionalExpression(value)) {
      const test = given.get(value.getCondition().getText().trim());
      const picked = test?.getText();
      if (picked === 'true') return resolve(value.getWhenTrue());
      if (picked === 'false' || (!test && /^[\w$]+$/.test(value.getCondition().getText().trim())))
        return resolve(value.getWhenFalse());
      return undefined;
    }
    return literalOf(value) ?? value.getText();
  };
  const parts: string[] = [];
  for (const property of options.getProperties()) {
    if (!Node.isPropertyAssignment(property) && !Node.isShorthandPropertyAssignment(property))
      continue;
    const name = property.getName();
    const value = Node.isPropertyAssignment(property)
      ? property.getInitializer()
      : property.getNameNode();
    if (name === 'timeout') {
      const ms = resolve(value);
      if (ms) parts.push(`gives up after ${ms} ms`);
    } else if (name === 'responseType') {
      const type = resolve(value);
      if (type && type !== 'undefined') parts.push(`reads the answer as a ${type}`);
    } else if (name === 'headers' && value && Node.isObjectLiteralExpression(unwrap(value))) {
      const auth = (unwrap(value) as ObjectLiteralExpression).getProperty('Authorization');
      const sent =
        auth && Node.isPropertyAssignment(auth) ? resolve(auth.getInitializer()) : undefined;
      const scheme = sent ? /^`?(Bearer|Basic|Token)\b/.exec(sent)?.[1] : undefined;
      if (scheme) parts.push(`sends a ${scheme} Authorization header`);
    }
  }
  const made = step(walk, 'compute', condense(wrapper.client.getText(), 90), frame, wrapper.client);
  made.label = `Send it with ${calleeText(wrapper.client)}${parts.length ? ` — ${parts.join(', ')}` : ''}`;
  return made;
}

/**
 * The client's own response interceptor, between the answer and the screen:
 * `api.interceptors.response.use(ok, onError)` is where a 401 is refreshed
 * and retried, or sent to the login page — the screen only sees what it lets
 * through. One that sends a 401 to the login page and returns nothing makes
 * the request *succeed* with `undefined`: the next `response.data` throws.
 */
function interceptorNodes(
  walk: Walk,
  located: LocatedCall,
  frame: Frame,
  via?: CallExpression,
): DecisionNode[] {
  const client = clientOf(walk, located, via);
  const use = client?.uses.find((candidate) => /\.response\.use$/.test(calleeText(candidate)));
  if (!client || !use) return [];
  const onSuccess = interceptorFn(walk, use, 0);
  const onError = interceptorFn(walk, use, 1);
  walk.limits.add(
    'An interceptor is drawn as written: whether its conditions hold for this particular URL is not worked out.',
  );
  const failed = onError
    ? interceptorGroup(
        walk,
        onError,
        use,
        frame,
        `${client.name}.interceptors.response (on error)`,
        'If the request fails, the API client’s interceptor runs first',
        true,
      )
    : [];
  const passed = onSuccess
    ? interceptorGroup(
        walk,
        onSuccess,
        use,
        frame,
        `${client.name}.interceptors.response (on success)`,
        'When the answer comes back, the API client’s interceptor runs first',
      )
    : [];
  const resolvesEmpty = onError !== undefined && fallsThrough(onError);
  const out: DecisionNode[] = [];
  if (passed.length === 0) out.push(...failed);
  else if (failed.length > 0) {
    const asked = decision(
      walk,
      'the server answered with a 2xx status?',
      'validateStatus',
      frame,
      use,
      [
        { label: 'yes', nodes: passed, ends: false },
        { label: 'no — an error status, or no answer', nodes: failed, ends: false },
      ],
    );
    asked.label = 'Did the request succeed?';
    out.push(asked);
  } else out.push(...passed);
  if (resolvesEmpty) out.push(...emptyResponseCheck(walk, located, frame));
  return out;
}

/** Some path through the function ends without a `return` or a `throw`. */
function fallsThrough(fn: Functionish): boolean {
  const body = fn.getBody();
  if (!body || !Node.isBlock(body)) return false;
  const last = body.getStatements().at(-1);
  if (!last) return true;
  if (Node.isReturnStatement(last) || Node.isThrowStatement(last)) return false;
  if (Node.isIfStatement(last)) {
    const arm = (statement: Node | undefined): boolean => {
      if (!statement) return true;
      const inner = Node.isBlock(statement) ? statement.getStatements().at(-1) : statement;
      if (!inner) return true;
      if (Node.isIfStatement(inner))
        return arm(inner.getThenStatement()) || arm(inner.getElseStatement());
      return !Node.isReturnStatement(inner) && !Node.isThrowStatement(inner);
    };
    return arm(last.getThenStatement()) || arm(last.getElseStatement());
  }
  return true;
}

/**
 * `const response = await getRequest(…); … response.data`: when the client's
 * interceptor can resolve with nothing, reading the response throws, and the
 * screen's own `catch` runs instead of what follows.
 */
function emptyResponseCheck(walk: Walk, located: LocatedCall, frame: Frame): DecisionNode[] {
  const call = located.call;
  const holder = call?.getFirstAncestorByKind(SyntaxKind.VariableDeclaration);
  if (!call || !holder || !Node.isIdentifier(holder.getNameNode())) return [];
  const name = holder.getName();
  const scope = nearestFunction(call);
  const read = scope
    ?.getDescendantsOfKind(SyntaxKind.PropertyAccessExpression)
    .find(
      (access) =>
        access.getStart() > holder.getEnd() &&
        access.getExpression().getText() === name &&
        !access.hasQuestionDotToken(),
    );
  if (!read) return [];
  const thrown = end(
    walk,
    'throw',
    `throws TypeError — cannot read ${read.getText()} of undefined`,
    frame,
    read,
  );
  thrown.label = `Stop with an error — ${read.getText()} cannot be read from nothing`;
  const asked = decision(
    walk,
    `${name} is undefined?`,
    `${name} === undefined`,
    frame,
    read,
    [{ label: 'yes — the interceptor gave back nothing', nodes: [thrown], ends: true }],
    'no',
  );
  asked.label = `Did the interceptor give back nothing for ${name}?`;
  return [asked];
}

/**
 * `adjust.mutate(input, { onSuccess, onError })`: the request lives in the
 * hook's `mutationFn`, and what happens next in two sets of callbacks — the
 * hook's own and the ones passed here.
 */
function mutateNodes(walk: Walk, call: CallExpression, frame: Frame): DecisionNode[] {
  const located = mutationOf(walk, call);
  const out: DecisionNode[] = [];
  if (located?.fn && !walk.drawn.has(located)) {
    out.push(
      ...walkFunction(walk, located.fn, { ...frame, role: 'helper', depth: frame.depth + 1 }),
    );
  }
  if (located && !walk.drawn.has(located)) out.push(...requestNodes(walk, located, frame));
  if (!located) out.push(step(walk, 'call', shortCall(call), frame, call));
  out.push(...hookOutcome(walk, located, call, frame));
  return out;
}

/** The success and failure callbacks of a query or mutation, as one decision. */
function hookOutcome(
  walk: Walk,
  located: LocatedCall | undefined,
  call: CallExpression | undefined,
  frame: Frame,
): DecisionNode[] {
  const sources = [located?.hook?.options, call?.getArguments()[1]].filter(
    (options): options is Node => options !== undefined && Node.isObjectLiteralExpression(options),
  );
  const callbacks = (key: string): DecisionNode[] =>
    sources.flatMap((options) => {
      const fn = callbackIn(options, key);
      return fn ? walkFunction(walk, fn, { ...frame, role: 'helper', depth: frame.depth + 1 }) : [];
    });
  const success = callbacks('onSuccess');
  const failure = callbacks('onError');
  const settled = callbacks('onSettled');
  if (success.length === 0 && failure.length === 0 && settled.length === 0) return [];
  const branches: DecisionBranch[] = [];
  if (success.length) branches.push({ label: 'yes — onSuccess', nodes: success, ends: false });
  if (failure.length) branches.push({ label: 'no — onError', nodes: failure, ends: false });
  const out: DecisionNode[] = [];
  if (branches.length) {
    out.push(
      decision(
        walk,
        'the request succeeded?',
        'onSuccess / onError',
        frame,
        located?.hook?.options ?? call,
        branches,
        branches.length < 2 ? 'otherwise' : undefined,
      ),
    );
  }
  if (settled.length) out.push(...settled);
  return out;
}

/** `request().then(onDone).catch(onFail)` as one decision. */
function continuationNodes(
  walk: Walk,
  call: CallExpression,
  frame: Frame,
  handled: Set<CallExpression>,
): DecisionNode[] {
  const callee = call.getExpression();
  if (!Node.isPropertyAccessExpression(callee)) return [];
  const member = callee.getName();
  // `.then(a).catch(b)`: the `.catch` draws both arms as one decision.
  const outer = call.getParent();
  if (
    member === 'then' &&
    outer &&
    Node.isPropertyAccessExpression(outer) &&
    outer.getName() === 'catch' &&
    Node.isCallExpression(outer.getParent())
  )
    return [];
  const helper: Frame = { ...frame, role: 'helper', depth: frame.depth + 1 };
  const run = (arg: Node | undefined): DecisionNode[] => {
    const fn =
      functionOf(arg) ??
      (arg && Node.isIdentifier(arg) ? resolveName(walk, arg.getText(), arg) : undefined);
    if (fn) return walkFunction(walk, fn, helper);
    return arg && /^set[A-Z]/.test(arg.getText())
      ? [step(walk, 'ui', `${arg.getText()}(result)`, frame, arg)]
      : [];
  };

  const branches: DecisionBranch[] = [];
  if (member === 'catch') {
    const receiver = unwrap(callee.getExpression());
    if (Node.isCallExpression(receiver) && calleeText(receiver).endsWith('.then')) {
      handled.add(receiver);
      const done = run(receiver.getArguments()[0]);
      if (done.length) branches.push({ label: 'yes — then', nodes: done, ends: false });
    }
    const failed = run(call.getArguments()[0]);
    if (failed.length) branches.push({ label: 'no — catch', nodes: failed, ends: endsAll(failed) });
    else if (functionOf(call.getArguments()[0])) {
      // `.catch(() => {})`: a failure is swallowed, and what follows runs anyway.
      const ignored = step(walk, 'compute', 'the error is ignored', frame, call.getArguments()[0]);
      ignored.label = 'The error is ignored, and it carries on';
      branches.push({ label: 'no — catch', nodes: [ignored], ends: false });
    }
  } else {
    const done = run(call.getArguments()[0]);
    if (done.length) branches.push({ label: 'yes — then', nodes: done, ends: false });
    const failed = run(call.getArguments()[1]);
    if (failed.length) branches.push({ label: 'no', nodes: failed, ends: endsAll(failed) });
  }
  if (branches.length === 0) return [];
  return [
    decision(
      walk,
      'it succeeded?',
      `.${member}(…)`,
      frame,
      call,
      branches,
      branches.length < 2 ? 'otherwise' : undefined,
    ),
  ];
}

// ---------------------------------------------------------------------------
// Resolving
// ---------------------------------------------------------------------------

/** The project function a call runs, when the source says which. */
function resolveCallee(walk: Walk, call: CallExpression): Functionish | undefined {
  const callee = call.getExpression();
  if (Node.isIdentifier(callee))
    return resolveName(walk, callee.getText(), call) ?? stepNamed(walk, callee.getText());
  if (!Node.isPropertyAccessExpression(callee)) return undefined;
  // `this.orders.create(dto)` / `ordersService.create(dto)`: the graph has
  // already resolved the injected class; match the method it found.
  const name = callee.getName();
  const receiver = callee.getExpression().getText();
  // `new JwtAuthGuard().canActivate(ctx)`: the class is named right there.
  const created = unwrap(callee.getExpression());
  if (Node.isNewExpression(created) && Node.isIdentifier(created.getExpression())) {
    const declared = walk.reader.declaration(
      created.getExpression().getText(),
      call.getSourceFile(),
    );
    if (declared && Node.isClassDeclaration(declared)) {
      const own = declared.getMethod(name);
      if (own) return own;
      return passportValidate(walk, declared);
    }
  }
  // `super.canActivate(context)` in `class JwtAuthGuard extends AuthGuard('jwt')`:
  // Passport runs the strategy registered as 'jwt', and its `validate` decides.
  if (receiver === 'super' && name === 'canActivate') {
    const owner = call.getFirstAncestor((ancestor) => Node.isClassDeclaration(ancestor));
    if (owner && Node.isClassDeclaration(owner)) return passportValidate(walk, owner);
  }
  if (receiver === 'this') {
    const owner = call.getFirstAncestor((ancestor) => Node.isClassDeclaration(ancestor));
    if (owner && Node.isClassDeclaration(owner)) {
      const method = owner.getMethod(name);
      if (method) return method;
    }
  }
  // `store.adjustStock(…)` through `import * as store from "@/lib/db/store"`.
  const base = unwrap(callee.getExpression());
  if (Node.isIdentifier(base)) {
    const namespace = call
      .getSourceFile()
      .getImportDeclarations()
      .find((declaration) => declaration.getNamespaceImport()?.getText() === base.getText());
    if (namespace) {
      const target = walk.reader.resolveModule(
        call.getSourceFile(),
        namespace.getModuleSpecifierValue(),
      );
      return target ? walk.reader.functionNamed(name, target) : undefined;
    }
  }
  const matches = walk.graph
    .nodesOfKind('method')
    .filter((node) => node.source && (node.label === name || node.label.endsWith(`.${name}`)));
  // Only a method whose class the receiver names: `this.ordersService.create`
  // -> `OrdersService.create`. A name match alone would send `map.get(key)` to
  // whichever class in the project happens to have a `get`.
  const holder = receiver.split('.').pop()?.replace(/^_+/, '').toLowerCase() ?? '';
  if (!holder) return undefined;
  const owns = (node: FlowNode): boolean => {
    const owner = node.label.split('.')[0]?.toLowerCase() ?? '';
    return (
      node.label.includes('.') &&
      (owner === holder ||
        (holder.length >= 4 && (owner.startsWith(holder) || holder.startsWith(owner))))
    );
  };
  const candidates = matches.filter(owns);
  const inFlow = candidates.filter((node) =>
    walk.flow.steps.some((flowStep) => flowStep.nodeId === node.id),
  );
  const pick = [inFlow, candidates].find((list) => list.length === 1)?.[0];
  if (!pick?.source) return undefined;
  const file = walk.reader.file(pick.source.file);
  return file ? functionAtLine(file, pick.source.line) : undefined;
}

/**
 * `cancelAppointment(id)` where `cancelAppointment` is a prop: the page passed
 * its own function down, and the graph followed it. The action's steps name
 * that function, and where it is.
 */
function stepNamed(walk: Walk, name: string): Functionish | undefined {
  // `onSubmit(form)` where the page passed `onSubmit={updateMedicine}`: the
  // scan joined the two, marked with the prop's name.
  const passed = [
    ...new Set(
      walk.flow.steps.flatMap((step) =>
        walk.graph
          .edgesFrom(step.nodeId, ['calls'])
          .filter((edge) => edge.meta?.['viaProp'] === name)
          .map((edge) => edge.to),
      ),
    ),
  ]
    .map((id) => walk.graph.node(id))
    .filter((node) => node?.source !== undefined);
  if (passed.length === 1) {
    const file = walk.reader.file(passed[0]!.source!.file);
    const fn = file ? functionAtLine(file, passed[0]!.source!.line) : undefined;
    if (fn) return fn;
  }
  const found = walk.flow.steps.filter(
    (step) =>
      (step.kind === 'handler' || step.kind === 'method') &&
      step.file &&
      step.line !== undefined &&
      (step.label === name || step.label.endsWith(`.${name}`)),
  );
  if (found.length !== 1) return undefined;
  const file = walk.reader.file(found[0]!.file);
  return file ? functionAtLine(file, found[0]!.line!) : undefined;
}

/** The project's files, from the scan's import table — the reader only knows what it has opened. */
function projectFiles(walk: Walk): string[] {
  const imports = (walk.graph.meta as { imports?: Record<string, string[]> }).imports ?? {};
  return [...new Set([...Object.keys(imports), ...Object.values(imports).flat()])];
}

/**
 * The `validate` of the Passport strategy a guard stands for:
 * `extends AuthGuard('jwt')` -> `class X extends PassportStrategy(Strategy, 'jwt')`.
 * A strategy given no name is registered under its library's default, 'jwt'
 * for passport-jwt and 'local' for passport-local.
 */
function passportValidate(walk: Walk, guard: ClassDeclaration): Functionish | undefined {
  const base = guard.getExtends()?.getText() ?? '';
  const wanted = /AuthGuard\(\s*['"`]([\w-]+)['"`]/.exec(base)?.[1];
  if (!wanted) return undefined;
  for (const rel of projectFiles(walk)) {
    if (!/strateg|auth|passport/i.test(rel)) continue;
    const file = walk.reader.file(rel);
    if (!file || !file.getFullText().includes('PassportStrategy')) continue;
    for (const strategy of file.getClasses()) {
      const extended = strategy.getExtends()?.getText() ?? '';
      if (!/PassportStrategy\(/.test(extended)) continue;
      const named = /,\s*['"`]([\w-]+)['"`]\s*\)/.exec(extended)?.[1];
      const library = file
        .getImportDeclarations()
        .find((declaration) => /^passport-/.test(declaration.getModuleSpecifierValue()))
        ?.getModuleSpecifierValue()
        .replace(/^passport-/, '');
      if ((named ?? library) !== wanted) continue;
      const validate = strategy.getMethod('validate');
      if (validate) return validate;
    }
  }
  return undefined;
}

/**
 * Passport checks the credentials before the strategy's `validate` runs, and
 * answers 401 when `validate` gives nothing back. Neither is in the project's
 * code, so a missing or forged token used to look like it carried on.
 */
function passportChecks(
  walk: Walk,
  validate: Functionish,
  frame: Frame,
  at: Node,
  inner: DecisionNode[],
): DecisionNode[] | undefined {
  if (!Node.isMethodDeclaration(validate) || validate.getName() !== 'validate') return undefined;
  const strategy = validate.getParent();
  if (
    !Node.isClassDeclaration(strategy) ||
    !/PassportStrategy\(/.test(strategy.getExtends()?.getText() ?? '')
  )
    return undefined;
  const library =
    strategy
      .getSourceFile()
      .getImportDeclarations()
      .map((declaration) => declaration.getModuleSpecifierValue())
      .find((specifier) => /^passport-/.test(specifier)) ?? 'passport';
  const options = strategy
    .getConstructors()[0]
    ?.getDescendantsOfKind(SyntaxKind.CallExpression)
    .find((call) => call.getExpression().getText() === 'super')
    ?.getArguments()[0];
  const text = options?.getText() ?? '';
  let question = `${library} accepts the credentials?`;
  if (library === 'passport-jwt') {
    const header = /fromHeader\(\s*['"`]([^'"`]+)/.exec(text)?.[1];
    const where = /fromAuthHeaderAsBearerToken/.test(text)
      ? 'a Bearer token in the Authorization header'
      : header
        ? `a token in the ${header} header`
        : 'a token';
    const secret = /secretOrKey\s*:\s*([^,\n}]+)/.exec(text)?.[1]?.trim();
    const expiry = /ignoreExpiration\s*:\s*true/.test(text)
      ? ' (its expiry is not checked)'
      : ', not expired';
    question = `${where}, signed with ${secret ? condense(secret, 40) : 'the secret'}${expiry}?`;
  }
  const refused = (why: string, node: Node): DecisionEnd =>
    end(walk, 'throw', `throws UnauthorizedException — ${why}`, frame, node, {
      statuses: [401],
    });
  const checked = decision(
    walk,
    question,
    text || library,
    frame,
    options ?? at,
    [
      {
        label: 'no',
        nodes: [refused(`${library} refuses the request`, options ?? at)],
        ends: true,
      },
    ],
    'yes',
  );
  checked.label = `Does the request carry ${question.replace(/\?$/, '')}?`;
  const found = decision(
    walk,
    'validate() gave back a user?',
    'validate(payload)',
    frame,
    validate,
    [{ label: 'no', nodes: [refused('validate() gave back nothing', validate)], ends: true }],
    'yes — it becomes req.user',
  );
  found.label = 'Did validate() give back a user?';
  return [checked, ...inner, found];
}

/**
 * What a middleware or guard in front of the route does, opened: its `use`,
 * `canActivate` or, for a Passport guard, the strategy's `validate`. A library
 * one (`ValidationPipe`) stays a named step.
 */
function middlewareBody(
  walk: Walk,
  guard: { name: string; role: string; file?: string },
): Functionish | undefined {
  const file = guard.file ? walk.reader.file(guard.file) : undefined;
  if (!file) return undefined;
  const declared = walk.reader.declaration(guard.name, file);
  if (!declared || !Node.isClassDeclaration(declared)) return undefined;
  const own =
    declared.getMethod('use') ??
    declared.getMethod('canActivate') ??
    declared.getMethod('intercept');
  // `canActivate() { return super.canActivate(ctx) }` adds nothing of its own.
  const onlySuper =
    own &&
    bodyStatements(own).length === 1 &&
    /super\.canActivate\(/.test(own.getBody()?.getText() ?? '');
  return onlySuper || !own ? (passportValidate(walk, declared) ?? own) : own;
}

/**
 * `const { createCustomer } = useCreateCustomer(); createCustomer(…)` — the
 * function a hook hands back, or the request behind `refetch` from a query hook.
 */
function hookMember(
  walk: Walk,
  call: CallExpression,
): { hook: string; fn?: Functionish; request?: LocatedCall } | undefined {
  const name = calleeText(call);
  const scope = nearestFunction(call);
  const declaration = scope ? localVariable(scope, name) : undefined;
  if (!declaration || !Node.isVariableDeclaration(declaration)) return undefined;
  const binding = declaration.getNameNode();
  const init = declaration.getInitializer();
  const hookCall = init ? unwrap(init) : undefined;
  if (!Node.isObjectBindingPattern(binding) || !hookCall || !Node.isCallExpression(hookCall))
    return undefined;
  const hook = calleeText(hookCall);
  if (!/^use[A-Z]/.test(hook)) return undefined;
  const element = binding.getElements().find((candidate) => candidate.getName() === name);
  const key = element?.getPropertyNameNode()?.getText() ?? name;
  const located = walk.located.calls.find((candidate) => candidate.hook?.name === hook);
  if (/^(refetch|mutate|mutateAsync|trigger)$/.test(key) && located)
    return { hook, request: located };
  const hookFn = walk.reader.functionNamed(hook, call.getSourceFile());
  if (hookFn) {
    for (const returned of returnsOf(hookFn)) {
      const object = unwrap(returned);
      if (!Node.isObjectLiteralExpression(object)) continue;
      const property = object.getProperty(key);
      const value =
        property && Node.isShorthandPropertyAssignment(property)
          ? property.getNameNode()
          : property && Node.isPropertyAssignment(property)
            ? property.getInitializer()
            : property && Node.isMethodDeclaration(property)
              ? property
              : undefined;
      const fn =
        functionOf(value) ??
        (value && Node.isIdentifier(value) ? resolveName(walk, value.getText(), value) : undefined);
      if (fn) return { hook, fn };
    }
  }
  return { hook };
}

function resolveName(walk: Walk, name: string, at: Node): Functionish | undefined {
  const scope = nearestFunction(at);
  const local = scope ? functionOf(localVariable(scope, name)) : undefined;
  if (local) return local;
  return walk.reader.functionNamed(name, at.getSourceFile());
}

/** `const adjust = useAdjustStock()` + `adjust.mutate(…)` -> the request inside the hook. */
function mutationOf(walk: Walk, call: CallExpression): LocatedCall | undefined {
  const withHook = walk.located.calls.filter((located) => located.hook);
  const callee = call.getExpression();
  const receiver = Node.isPropertyAccessExpression(callee) ? callee.getExpression() : undefined;
  if (receiver && Node.isIdentifier(receiver)) {
    const scope = nearestFunction(call);
    const declaration = scope ? localVariable(scope, receiver.getText()) : undefined;
    const init =
      declaration && Node.isVariableDeclaration(declaration)
        ? declaration.getInitializer()
        : undefined;
    const hookCall = init ? unwrap(init) : undefined;
    if (hookCall && Node.isCallExpression(hookCall)) {
      const hookName = calleeText(hookCall);
      const hookFn = walk.reader.functionNamed(hookName, call.getSourceFile());
      const found = withHook.find(
        (located) => located.hook!.fn === hookFn || located.hook!.name === hookName,
      );
      if (found) return found;
    }
  }
  return withHook.length === 1 ? withHook[0] : undefined;
}

function callbackIn(options: Node, key: string): Functionish | undefined {
  if (!Node.isObjectLiteralExpression(options)) return undefined;
  const property = options.getProperty(key);
  if (!property) return undefined;
  if (Node.isMethodDeclaration(property)) return property;
  if (Node.isPropertyAssignment(property)) return functionOf(property.getInitializer());
  return undefined;
}

/** The names a component takes as props: `({ onSubmit, onClose })` or `props.x`. */
function propNames(component: Functionish | undefined): string[] {
  const param = component?.getParameters()[0];
  if (!param) return [];
  const binding = param.getNameNode();
  if (Node.isObjectBindingPattern(binding))
    return binding.getElements().map((element) => element.getName());
  return [];
}

function isProp(call: CallExpression, name: string): boolean {
  let component: Node | undefined;
  for (let current: Node | undefined = call; current; current = nearestFunction(current)) {
    const fn = nearestFunction(current);
    if (fn && /^[A-Z]/.test(nameOf(fn))) component = fn;
    if (!fn) break;
  }
  return component ? propNames(component as Functionish).includes(name) : false;
}

function effectsIndex(graph: FlowGraph): Map<string, FlowNode[]> {
  const index = new Map<string, FlowNode[]>();
  for (const node of [...graph.nodesOfKind('db-op'), ...graph.nodesOfKind('external-effect')]) {
    if (!node.source) continue;
    const key = `${node.source.file}:${node.source.line}`;
    index.set(key, [...(index.get(key) ?? []), node]);
  }
  return index;
}

/**
 * `movements.insertOne(doc)` the scan did not link — in a helper the graph has
 * no node for — recognised by a driver method on a receiver named like a
 * collection the graph does know. Without it the tree would show a write as
 * plain code, which is the one step it must not lose.
 */
function unlinkedQuery(
  walk: Walk,
  call: CallExpression,
): { collection: string; operation: string; effect: string } | undefined {
  const callee = call.getExpression();
  if (!Node.isPropertyAccessExpression(callee)) return undefined;
  const operation = callee.getName();
  const effect = dbEffectOf(operation);
  if (!effect || takesCallback(call)) return undefined;
  const receiver = unwrap(callee.getExpression());
  // Where the receiver came from is the evidence: `db.collection<T>("x")`, or
  // a name destructured from `getCollections()`. Then even `find` is a query.
  const origin = collectionOrigin(walk, receiver, 0);
  if (origin) return { collection: origin, operation, effect };
  // Without that, only a method no array or Map has, on a receiver named
  // like a collection the graph knows.
  if (!DRIVER_ONLY.test(operation)) return undefined;
  const name = Node.isIdentifier(receiver)
    ? receiver.getText()
    : Node.isPropertyAccessExpression(receiver)
      ? receiver.getName()
      : undefined;
  if (!name) return undefined;
  const collection = walk.graph
    .nodesOfKind('collection')
    .find((node) => node.label === name || node.label.toLowerCase() === name.toLowerCase());
  return collection ? { collection: collection.label, operation, effect } : undefined;
}

/** `updateOne(filter, update, { upsert: true })` inserts when nothing matches. */
function upsertAware(call: CallExpression, effect: string): string {
  return effect === 'update' &&
    call.getArguments().some((arg) => /\bupsert\s*:\s*true\b/.test(arg.getText()))
    ? 'upsert'
    : effect;
}

/** `rows.find((row) => …)` is an array method: a driver's `find` takes a filter object. */
function takesCallback(call: CallExpression): boolean {
  return call.getArguments().some((arg) => functionOf(arg) !== undefined);
}

/** The collection an expression holds, read from where it was made. */
function collectionOrigin(walk: Walk, expression: Node, depth: number): string | undefined {
  if (depth > 3) return undefined;
  const node = unwrap(expression);
  if (Node.isCallExpression(node)) {
    // `db.collection("x")`, `db.collection<T>("x")`, `getCollection("x")`
    if (/(^|\.)(collection|getCollection)$/.test(calleeText(node))) {
      const [first] = node.getArguments();
      return first ? literalOf(first) : undefined;
    }
    return undefined;
  }
  if (Node.isPropertyAccessExpression(node)) {
    // `cols.medicines` where `const cols = await getCollections()`
    const base = unwrap(node.getExpression());
    return Node.isIdentifier(base) && collectionsSource(walk, base) ? node.getName() : undefined;
  }
  if (!Node.isIdentifier(node)) return undefined;
  const declaration = declarationOf(node);
  if (!declaration) return undefined;
  const init = declaration.getInitializer();
  const binding = declaration.getNameNode();
  if (Node.isIdentifier(binding)) return init ? collectionOrigin(walk, init, depth + 1) : undefined;
  if (Node.isObjectBindingPattern(binding) && init && isCollectionsCall(unwrap(init))) {
    const element = binding
      .getElements()
      .find((candidate) => candidate.getName() === node.getText());
    return element ? (element.getPropertyNameNode()?.getText() ?? element.getName()) : undefined;
  }
  return undefined;
}

/** `const cols = await getCollections()` — a value whose properties are collections. */
function collectionsSource(walk: Walk, identifier: Node): boolean {
  const declaration = declarationOf(identifier);
  const init = declaration?.getInitializer();
  return init !== undefined && isCollectionsCall(unwrap(init));
}

function isCollectionsCall(node: Node): boolean {
  return (
    Node.isCallExpression(node) && /(^|\.)(get)?(collections|models|db)$/i.test(calleeText(node))
  );
}

/** The `const`/`let` an identifier was declared with, in its function or its module. */
function declarationOf(identifier: Node): VariableDeclaration | undefined {
  const name = identifier.getText();
  const scope = nearestFunction(identifier);
  const local = scope ? localVariable(scope, name) : undefined;
  const found = local ?? identifier.getSourceFile().getVariableDeclaration(name);
  return found && Node.isVariableDeclaration(found) ? found : undefined;
}

/** `const cache = new Map()` — state in this process, whatever the graph called it. */
function isLocalStore(walk: Walk, call: CallExpression): boolean {
  const callee = call.getExpression();
  if (!Node.isPropertyAccessExpression(callee)) return false;
  const base = unwrap(callee.getExpression());
  if (!Node.isIdentifier(base)) return false;
  const init = declarationOf(base)?.getInitializer();
  return init !== undefined && /^new (Map|Set|WeakMap|WeakSet)\b/.test(unwrap(init).getText());
}

/** The db-ops and effects the graph found at this call — the call itself, not one beside it. */
function effectsAt(walk: Walk, call: CallExpression): FlowNode[] {
  const point = walk.reader.point(call);
  const lines = new Set([point.line, call.getExpression().getEndLineNumber()]);
  const member = calleeText(call).split('.').pop() ?? '';
  const found: FlowNode[] = [];
  for (const line of lines) {
    for (const node of walk.effects.get(`${point.file}:${line}`) ?? []) {
      if (found.includes(node)) continue;
      if (node.kind === 'db-op') {
        if (String(node.meta?.['operation'] ?? '') !== member) continue;
        // The scan took `clinics.find((c) => …)` for a query by its name.
        if (takesCallback(call)) continue;
      }
      if (node.kind === 'external-effect') {
        if (String(node.meta?.['call'] ?? '') !== calleeText(call)) continue;
        if (isLocalStore(walk, call)) continue;
      }
      found.push(node);
    }
  }
  return found;
}

// ---------------------------------------------------------------------------
// Small pieces
// ---------------------------------------------------------------------------

function siteKey(call: CallExpression): string {
  return `${call.getSourceFile().getFilePath()}:${call.getStart()}`;
}

function calleeText(call: CallExpression): string {
  return call.getExpression().getText().replace(/\s+/g, '').replace(/\?\./g, '.');
}

/** The call belongs to this expression, not to a function written inside it. */
function ownedBy(call: Node, root: Node): boolean {
  if (call === root) return true;
  for (
    let node: Node | undefined = call.getParent();
    node && node !== root;
    node = node.getParent()
  ) {
    if (
      Node.isArrowFunction(node) ||
      Node.isFunctionExpression(node) ||
      Node.isFunctionDeclaration(node) ||
      Node.isMethodDeclaration(node) ||
      Node.isConditionalExpression(node)
    )
      return false;
    if (Node.isBinaryExpression(node)) {
      const operator = node.getOperatorToken().getKind();
      if (
        operator === SyntaxKind.AmpersandAmpersandToken ||
        operator === SyntaxKind.BarBarToken ||
        operator === SyntaxKind.QuestionQuestionToken
      )
        return false;
    }
  }
  return true;
}

function insideArguments(call: CallExpression, outer: CallExpression): boolean {
  return outer
    .getArguments()
    .some((arg) => arg.getStart() <= call.getStart() && call.getEnd() <= arg.getEnd());
}

function insideArgumentsOfKept(
  call: CallExpression,
  kept: Array<{ call: CallExpression; kind: CallKind | undefined }>,
): boolean {
  return kept.some(
    (other) =>
      other.call !== call &&
      other.call
        .getArguments()
        .some((arg) => arg.getStart() <= call.getStart() && call.getEnd() <= arg.getEnd()),
  );
}

/** `!valid` -> "valid?" with the `then` branch labelled `no`. */
function phrase(condition: string): { question: string; thenLabel: string; elseLabel: string } {
  const flat = condition.replace(/\s+/g, ' ').trim();
  const negated = /^!\s*(\(?[\w$.?[\]'"()]+\)?)$/.exec(flat);
  if (negated && !flat.startsWith('!!')) {
    const inner = negated[1]!.replace(/^\((.*)\)$/, '$1');
    return { question: `${condense(inner, 60)}?`, thenLabel: 'no', elseLabel: 'yes' };
  }
  return { question: `${condense(flat, 60)}?`, thenLabel: 'yes', elseLabel: 'no' };
}

/** Nothing after this list runs: it ends in a return/throw, or every branch does. */
function endsAll(nodes: DecisionNode[]): boolean {
  const last = nodes.at(-1);
  if (!last) return false;
  if (last.type === 'end') return true;
  if (last.type === 'decision')
    return last.otherwise === undefined && last.branches.every((branch) => branch.ends);
  if (last.type === 'try') return endsAll(last.nodes) && (last.catch?.ends ?? true);
  return false;
}

/** A request, a query or an outside call: something that can fail at runtime. */
function canFail(node: DecisionNode): boolean {
  switch (node.type) {
    case 'step':
      return node.kind === 'db' || node.kind === 'external';
    case 'group':
      return node.kind === 'request' || node.nodes.some(canFail);
    case 'decision':
      return node.branches.some((branch) => branch.nodes.some(canFail));
    case 'try':
      return node.nodes.some(canFail);
    default:
      return false;
  }
}

/** Whether a helper's inside is worth opening: anything but plain calls. */
/**
 * A throw on the server that nothing catches on the way out is not where the
 * story ends: the framework answers it — a 500 in Next.js, Express and Nest
 * alike. Drawn as just "throws", the chart left the request unanswered.
 */
export function markUncaught(nodes: DecisionNode[], caught: boolean, inRequest = false): void {
  for (const node of nodes) {
    switch (node.type) {
      case 'end':
        if (
          node.outcome === 'throw' &&
          inRequest &&
          !caught &&
          node.side === 'server' &&
          !node.statuses?.length
        ) {
          node.uncaught = { text: node.text, label: node.label || endLabel(node) };
          node.statuses = [500];
          node.text = `${node.text} — not caught, so the server answers 500`;
          node.label = 'Stop with an error — nothing catches it, so the server answers 500';
        }
        break;
      case 'decision':
        node.branches.forEach((branch) => markUncaught(branch.nodes, caught, inRequest));
        break;
      case 'group':
        markUncaught(node.nodes, caught, inRequest || node.kind === 'request');
        break;
      case 'try':
        markUncaught(node.nodes, caught || node.catch !== undefined, inRequest);
        if (node.catch) markUncaught(node.catch.nodes, caught, inRequest);
        if (node.finally) markUncaught(node.finally, caught, inRequest);
        break;
    }
  }
}

function worthShowing(node: DecisionNode): boolean {
  switch (node.type) {
    case 'step':
      // A helper opened earlier in the tree was worth opening then.
      return node.kind !== 'call' || node.text.endsWith('— opened above');
    case 'end':
      return !['return', 'next', 'break'].includes(node.outcome);
    case 'decision':
      // A decision is the point of the chart, even one that only picks which
      // value to return: `switch (level) { case "low-stock": return … }`.
      return node.branches.some((branch) => branch.nodes.length > 0);
    case 'group':
      return node.kind === 'request' || node.nodes.some(worthShowing);
    case 'try':
      return node.nodes.some(worthShowing) || (node.catch?.nodes.some(worthShowing) ?? false);
  }
}

function step(
  walk: Walk,
  kind: DecisionStep['kind'],
  text: string,
  frame: Frame,
  at?: Node,
): DecisionStep {
  walk.size += 1;
  return {
    type: 'step',
    kind,
    label: '',
    text,
    side: frame.side,
    ...(at ? { at: walk.reader.point(at) } : {}),
  };
}

function end(
  walk: Walk,
  outcome: DecisionEnd['outcome'],
  text: string,
  frame: Frame,
  at: Node,
  found?: { statuses: number[]; message?: string },
): DecisionEnd {
  walk.size += 1;
  return {
    type: 'end',
    outcome,
    label: '',
    text,
    side: frame.side,
    at: walk.reader.point(at),
    ...(found?.statuses.length ? { statuses: found.statuses } : {}),
    ...(found?.message ? { message: found.message } : {}),
  };
}

function decision(
  walk: Walk,
  question: string,
  code: string,
  frame: Frame,
  at: Node | undefined,
  branches: DecisionBranch[],
  otherwise?: string,
): DecisionQuestion {
  walk.size += 1;
  const condition = at ? conditionOf(at) : undefined;
  return {
    type: 'decision',
    question,
    label: (condition && meaningOf(condition, frame.side)) ?? '',
    code: condense(code, 120),
    side: frame.side,
    ...(at ? { at: walk.reader.point(at) } : {}),
    branches,
    ...(otherwise ? { otherwise } : {}),
  };
}

function triggerText(flow: FeatureFlow): string {
  if (flow.event === 'mount' || flow.id.endsWith('-loads'))
    return `${flow.component ?? 'The page'} opens`;
  const verbs: Record<string, string> = {
    onSubmit: 'submits',
    onChange: 'changes',
    onKeyDown: 'presses a key in',
    onKeyUp: 'presses a key in',
    onFocus: 'focuses',
    onBlur: 'leaves',
    onMouseDown: 'presses on',
    onClose: 'closes',
    onSelect: 'picks',
  };
  const verb = verbs[flow.event ?? ''] ?? 'clicks';
  // `MedicineForm onSubmit` is a name made from code; the title reads better.
  if (/\bon[A-Z]/.test(flow.label)) {
    const where = flow.component ?? flow.screen;
    return `The user ${verb} the form${where ? ` in ${where}` : ''}`;
  }
  return `The user ${verb} "${flow.label}"`;
}

export function countOf(nodes: DecisionNode[]): ActionDecisions['counts'] {
  const counts = { decisions: 0, outcomes: 0, queries: 0, requests: 0 };
  const visit = (list: DecisionNode[]): void => {
    for (const node of list) {
      if (node.type === 'decision') {
        counts.decisions += 1;
        node.branches.forEach((branch) => visit(branch.nodes));
      } else if (node.type === 'group') {
        if (node.kind === 'request') counts.requests += 1;
        visit(node.nodes);
      } else if (node.type === 'try') {
        counts.decisions += node.catch ? 1 : 0;
        visit(node.nodes);
        if (node.catch) visit(node.catch.nodes);
        if (node.finally) visit(node.finally);
      } else if (node.type === 'end') {
        if (!['return', 'next', 'break'].includes(node.outcome)) counts.outcomes += 1;
      } else if (node.kind === 'db') counts.queries += 1;
    }
  };
  visit(nodes);
  return counts;
}

// ---------------------------------------------------------------------------
// Plain words
// ---------------------------------------------------------------------------

/**
 * What each node does, in words a reader can follow without the code: the
 * views lead with these and keep the code as the second line. Only phrasings
 * the code supports are used — a condition with no safe reading keeps its own
 * text rather than getting a sentence that might say something it does not.
 */
function labelTree(nodes: DecisionNode[]): DecisionNode[] {
  for (const node of nodes) {
    switch (node.type) {
      case 'step':
        if (!node.label) node.label = stepLabel(node);
        break;
      case 'end':
        if (!node.label) node.label = endLabel(node);
        break;
      case 'decision':
        if (!node.label) node.label = questionLabel(node.code, node.question);
        // Words start with a capital; code as written does not.
        if (!looksLikeCode(node.label)) node.label = capitalise(node.label);
        node.branches.forEach((branch) => labelTree(branch.nodes));
        break;
      case 'group':
        if (!node.label) node.label = groupLabel(node);
        labelTree(node.nodes);
        break;
      case 'try':
        labelTree(node.nodes);
        if (node.catch) labelTree(node.catch.nodes);
        if (node.finally) labelTree(node.finally);
        break;
    }
  }
  return nodes;
}

const DB_VERB: Record<string, string> = {
  upsert: 'Update or insert into',
  read: 'Read',
  create: 'Insert into',
  update: 'Update',
  delete: 'Delete from',
  write: 'Write to',
};

function stepLabel(node: DecisionStep): string {
  switch (node.kind) {
    case 'trigger':
    case 'guard':
    case 'compute':
      return capitalise(node.text);
    case 'db': {
      const [collection = node.text, operation = ''] = node.text.split('.');
      // A count or a pipeline is not a read of rows: say which it is.
      if (/^(?:countDocuments|count|estimatedDocumentCount)$/.test(operation))
        return `Count ${collection}`;
      if (operation === 'aggregate') return `Aggregate ${collection}`;
      return `${DB_VERB[node.effect ?? 'read'] ?? 'Query'} ${collection}`;
    }
    case 'external': {
      // `cache (set) (leaves the app)` -> `Cache: set`
      const match = /^(.+?) \((\w+)\)/.exec(node.text);
      return match ? `${capitalise(match[1]!)}: ${match[2]}` : capitalise(node.text);
    }
    case 'shared':
      return capitalise(node.text);
    case 'call': {
      if (node.text.endsWith('(recursive)')) return capitalise(node.text);
      const name = /^([\w$.]+)\(/.exec(node.text)?.[1];
      const note = / — (.+)$/.exec(node.text)?.[1];
      return `Run ${name ? `${words(name.split('.').pop()!)}` : node.text}${note ? ` (${note})` : ''}`;
    }
    case 'ui': {
      const prop = /^calls the (\w+) prop$/.exec(node.text);
      return prop ? `Call ${prop[1]} (from the parent)` : capitalise(node.text);
    }
  }
}

/** `setError("Enter a valid quantity")` -> `Show error "Enter a valid quantity"`. */
function uiLabel(call: CallExpression): string {
  const text = calleeText(call);
  const saving: Array<[RegExp, string]> = [
    [/createObjectURL$/, 'Turn the downloaded data into a link to a file'],
    [/revokeObjectURL$/, 'Free the file link'],
    [/appendChild$/, 'Put the link on the page'],
    [/removeChild$/, 'Take the link off the page'],
    [/\.click$/, 'Click the link, so the browser saves the file'],
  ];
  if (DOWNLOAD_CALLS.test(text))
    for (const [pattern, label] of saving) if (pattern.test(text)) return label;
  const [first, second] = call.getArguments();
  const literal = first ? literalOf(first) : undefined;

  const setter = /^set([A-Z]\w*)$/.exec(text);
  if (setter) {
    const name = words(setter[1]!);
    const value = first ? unwrap(first).getText() : '';
    if (/^(undefined|null|''|""|``|\[\]|\{\}|0)$/.test(value.replace(/\s/g, '')))
      return `Clear ${name}`;
    if (value === 'true') return `Turn on ${name}`;
    if (value === 'false') return `Turn off ${name}`;
    if (literal !== undefined)
      return /error|message|notice|warning/i.test(name)
        ? `Show ${name} "${condense(literal, 60)}"`
        : `Set ${name} to "${condense(literal, 60)}"`;
    return `Update ${name}`;
  }

  if (/^(toast|notify|enqueueSnackbar|alert)(\.\w+)?$|^(message|notification)\.\w+$/.test(text)) {
    const object =
      first && Node.isObjectLiteralExpression(unwrap(first)) ? unwrap(first) : undefined;
    const title =
      literal ??
      (object ? stringProperty(object, ['title', 'message', 'description']) : undefined) ??
      (second ? literalOf(second) : undefined);
    const variant =
      (object ? stringProperty(object, ['variant', 'type', 'status']) : undefined) ??
      /\.(success|error|warning|info)$/.exec(text)?.[1];
    const kind = variant && variant !== 'default' ? `${variant} ` : '';
    const noun = text.startsWith('alert') ? 'an alert' : `a ${kind}message`;
    return title ? `Show ${noun}: "${condense(title, 60)}"` : `Show ${noun}`;
  }

  const member = text.split('.').pop() ?? text;
  if (/^(push|replace|navigate|redirect|assign)$/.test(member) || text === 'navigate')
    return `Go to ${literal ?? (first ? condense(first.getText(), 50) : 'another page')}`;
  if (member === 'back') return 'Go back';
  if (member === 'refresh' || member === 'reload') return 'Reload the page data';
  if (
    /^(invalidateQueries|refetchQueries|refetch|setQueryData|mutate|revalidatePath|revalidateTag)$/.test(
      member,
    )
  ) {
    const what = first ? cacheKeyWords(first.getText()) : '';
    return `Refresh cached data${what ? `: ${what}` : ''}`;
  }
  if (member === 'reset') return 'Reset the form';
  if (Node.isIdentifier(call.getExpression())) return `Call ${text} (from the parent)`;
  return capitalise(shortCall(call));
}

function endLabel(node: DecisionEnd): string {
  const status = node.statuses?.length ? node.statuses.join(' / ') : undefined;
  const message = node.message ? ` · ${condense(node.message, 60)}` : '';
  switch (node.outcome) {
    case 'stop':
      return node.text === 'stops here' ? 'Stop — nothing more happens' : capitalise(node.text);
    case 'respond':
      if (status) return `Respond ${status}${message}`;
      if (node.text.startsWith('no route')) return 'No route answers this request';
      return `Respond with ${node.text.replace(/^responds /, '')}`;
    case 'throw':
      return `Stop with ${status ? `a ${status} error` : 'an error'}${message}`;
    case 'next':
      return node.text === 'finishes this item early'
        ? 'Done with this item'
        : 'Skip to the next item';
    case 'break':
      return node.text === 'ends this case' ? 'End this case' : 'Leave the loop';
    case 'return': {
      if (status) return `Return a ${status} error to the caller${message}`;
      const error = /error:\s*["'`]([^"'`]+)["'`]/.exec(node.text)?.[1];
      if (error) return `Return error "${error}" to the caller`;
      const value = node.text.replace(/^returns ?/, '');
      // `return Promise.reject(error)` fails the caller's await with the error.
      if (/^Promise\.reject\(/.test(value)) return 'Fail — pass the error on to the caller';
      if (!value) return 'Finish here';
      // What comes back, in words; the code is the end's text, under "Show code".
      const result = value.includes('…') ? undefined : plainResult(value);
      return `Give back ${result ?? 'the result'}`;
    }
  }
}

function groupLabel(node: DecisionGroup): string {
  switch (node.kind) {
    case 'request':
      return `Send ${node.title} to the server`;
    case 'loop':
      return capitalise(node.title);
    case 'parallel':
      return 'These run at the same time';
    case 'unlinked':
      return node.title;
    case 'function': {
      const prop = /^(\w+) → (\w+)/.exec(node.title);
      if (prop) return `${prop[1]} runs ${words(prop[2]!)}`;
      const name = /^([\w$.]+)\(/.exec(node.title)?.[1] ?? node.title;
      return `Run ${words(name.split('.').pop()!)}`;
    }
  }
}

/** The condition a decision was built from: the `if`'s test, the `?:`'s, the left of `&&`. */
function conditionOf(at: Node): Node | undefined {
  if (Node.isIfStatement(at)) return at.getExpression();
  if (Node.isConditionalExpression(at)) return at.getCondition();
  if (Node.isBinaryExpression(at)) return at.getLeft();
  return undefined;
}

/**
 * A condition read through what its variable holds.
 *
 * `if (!parsed.success)` says nothing until you know `parsed` came from
 * `verifyOtpSchema.safeParse({ phone, otp })` — then it says "are phone and otp
 * valid?". The same goes for `if (!ok)` after `const ok = await verifyOtp(…)`
 * and `res.ok` after a `fetch`. Only the assignment in scope is used; a
 * variable whose origin cannot be read keeps the generic phrasing.
 */
function meaningOf(condition: Node, side: DecisionSide): string | undefined {
  let inner = unwrap(condition);
  while (
    Node.isPrefixUnaryExpression(inner) &&
    inner.getOperatorToken() === SyntaxKind.ExclamationToken
  ) {
    inner = unwrap(inner.getOperand());
  }

  // `parsed.success`, `parsed.error`, `res.ok`
  if (Node.isPropertyAccessExpression(inner)) {
    const member = inner.getName();
    const target = unwrap(inner.getExpression());
    if (!Node.isIdentifier(target)) return undefined;
    const origin = originOf(target);
    if (member === 'success' || member === 'error') {
      const parse = origin && validationOf(origin, side);
      if (parse)
        return member === 'success'
          ? `${parse.verb} ${parse.what} valid?`
          : `${parse.verb} ${parse.what} invalid?`;
      if (member === 'success' && /^pars/i.test(target.getText())) return 'Is the input valid?';
    }
    if (member === 'ok' || member === 'success') {
      if (origin && isFetch(origin)) return 'Did the request succeed?';
      const name = origin && calledName(origin);
      if (name) return `Did ${words(name)} succeed?`;
    }
    return undefined;
  }

  // `ok`, `success`, `result` — a flag that holds a call's answer.
  if (
    Node.isIdentifier(inner) &&
    /^(ok|success|succeeded|done|result|res|response)$/i.test(inner.getText())
  ) {
    const origin = originOf(inner);
    if (origin && isFetch(origin)) return 'Did the request succeed?';
    if (origin && isConfirm(origin)) return 'Did the user confirm?';
    const name = origin && calledName(origin);
    if (name) return `Did ${words(name)} succeed?`;
  }

  // `clinics.length === 0`
  if (Node.isBinaryExpression(inner)) {
    const empty = /^([\w$.]+)\.length\s*(===|==)\s*0$/.exec(inner.getText().replace(/\s+/g, ' '));
    if (empty) return `Are there no ${words(empty[1]!.split('.').pop()!)}?`;
  }
  return undefined;
}

/** The initializer of the variable an identifier names, from its declaration in scope. */
function originOf(identifier: Node): Node | undefined {
  const name = identifier.getText();
  /**
   * The nearest declaration above it in a scope that holds it, read off the
   * syntax tree. Asking the type checker bound whole files for every
   * condition, and was most of the time a tree took on a large app.
   */
  const scopes: Node[] = [];
  let module: SourceFile | undefined;
  for (const node of identifier.getAncestors()) {
    // A parameter holds what the caller passed: there is no assignment to read.
    if (
      (Node.isFunctionDeclaration(node) ||
        Node.isArrowFunction(node) ||
        Node.isFunctionExpression(node) ||
        Node.isMethodDeclaration(node)) &&
      node.getParameters().some((param) => param.getName() === name)
    )
      break;
    if (Node.isBlock(node)) scopes.push(node);
    if (Node.isSourceFile(node)) module = node;
  }
  // Module level: declared anywhere in the file, as a closure sees it.
  const declaration = findIn(scopes, identifier, name) ?? module?.getVariableDeclaration(name);
  const value = declaration?.getInitializer();
  return value ? unwrap(value) : undefined;
}

/** The last `const name = …` above `at` in the innermost of these blocks that has one. */
function findIn(scopes: Node[], at: Node, name: string): VariableDeclaration | undefined {
  const held = new Set(scopes);
  for (const scope of scopes) {
    const found = scope
      .getDescendantsOfKind(SyntaxKind.VariableDeclaration)
      .filter(
        (candidate) =>
          candidate.getName() === name &&
          candidate.getStart() < at.getStart() &&
          held.has(candidate.getFirstAncestor((node) => Node.isBlock(node))!),
      )
      .at(-1);
    if (found) return found;
  }
  return undefined;
}

/** `schema.safeParse(x)` and friends: what is being validated, in words. */
function validationOf(
  origin: Node,
  side: DecisionSide,
): { verb: string; what: string } | undefined {
  if (!Node.isCallExpression(origin)) return undefined;
  const callee = origin.getExpression();
  if (!Node.isPropertyAccessExpression(callee)) return undefined;
  if (!/^(safeParse|safeParseAsync|validate|spa)$/.test(callee.getName())) return undefined;
  const arg = origin.getArguments()[0];
  if (!arg) return { verb: 'Is', what: 'the input' };
  const value = unwrap(arg);
  if (Node.isObjectLiteralExpression(value)) {
    const names = value
      .getProperties()
      .map((property) =>
        Node.isShorthandPropertyAssignment(property) || Node.isPropertyAssignment(property)
          ? words(property.getName())
          : undefined,
      )
      .filter((name): name is string => Boolean(name));
    if (names.length === 1) return { verb: 'Is', what: `the ${names[0]}` };
    if (names.length > 1 && names.length <= 4) {
      return { verb: 'Are', what: `${names.slice(0, -1).join(', ')} and ${names.at(-1)}` };
    }
    return { verb: 'Is', what: 'the form' };
  }
  const text = value.getText();
  if (/(^|\.)(body|json\(\))$|request\.json|req\.body|^payload$|^input$/.test(text)) {
    return { verb: 'Is', what: side === 'server' ? 'the request body' : 'the form' };
  }
  if (/searchParams|query|params/.test(text)) return { verb: 'Are', what: 'the query parameters' };
  if (Node.isIdentifier(value)) {
    const what = words(text);
    return { verb: /s$/.test(what) && !/ss$/.test(what) ? 'Are' : 'Is', what: `the ${what}` };
  }
  return { verb: 'Is', what: 'the input' };
}

/** `const ok = await confirmDelete(…)` asks a person, not the code. */
function isConfirm(origin: Node): boolean {
  return (
    Node.isCallExpression(origin) && /(^|\.)confirm\w*$/i.test(origin.getExpression().getText())
  );
}

function isFetch(origin: Node): boolean {
  return (
    Node.isCallExpression(origin) && /^(window\.)?fetch$/.test(origin.getExpression().getText())
  );
}

/** `verifyOtp` for `verifyOtp(phone, otp)` or `api.users.verifyOtp(...)`. */
function calledName(origin: Node): string | undefined {
  if (!Node.isCallExpression(origin)) return undefined;
  const name = origin.getExpression().getText().split('.').pop() ?? '';
  return /^[A-Za-z_$][\w$]*$/.test(name) ? name : undefined;
}

/**
 * A condition in plain words, for the shapes that have one:
 * `"error" in ctx` -> `ctx has error?`, `parsed.success` -> `parsed succeeded?`,
 * `items.length` -> `items is not empty?`, `a === "x"` -> `a is "x"?`.
 */
function questionLabel(code: string, question: string): string {
  // `!valid` is asked the right way up, with its branches swapped (see `phrase`):
  // the words read the condition inside.
  const single = /^!\s*(\(?[\w$.?[\]'"()]+\)?)$/.exec(code.replace(/\s+/g, ' ').trim());
  const plain = plainQuestion(
    single && !code.trim().startsWith('!!') ? single[1]!.replace(/^\((.*)\)$/, '$1') : code,
  );
  if (plain) return plain;
  const older = codeQuestionLabel(code, question);
  // The older rules give the code back when they have no reading either. (A
  // question the walk wrote in words — "the request succeeded?" — is kept.)
  return older === question && looksLikeCode(question) ? (plainFallback(code) ?? older) : older;
}

/** `hit && Date.now() - hit.at < TTL?` is code; `the request succeeded?` is not. */
function looksLikeCode(text: string): boolean {
  return /[=&|()[\]<>!+*/%`]|\w\.\w/.test(text);
}

/** The older readings, for what `plainQuestion` leaves as code. */
function codeQuestionLabel(code: string, question: string): string {
  const flat = code.replace(/\s+/g, ' ').trim();
  const doubled = /^!!\s*([\w$.]+)$/.exec(flat);
  if (doubled) return `Has ${words(doubled[1]!.split('.').pop()!)}?`;
  const negated = /^!\s*\(?(.+?)\)?$/.exec(flat);
  const inner = negated && !flat.startsWith('!!') && !/[&|]/.test(flat) ? negated[1]! : flat;
  const has = /^["'`](\w+)["'`] in ([\w$.]+)$/.exec(inner);
  if (has) return `${has[2]} has ${has[1]}?`;
  const success = /^([\w$.]+)\.(success|ok)$/.exec(inner);
  if (success) return `${success[1]} succeeded?`;
  const length = /^([\w$.]+)\.length( > 0)?$/.exec(inner);
  if (length) return `Are there any ${words(length[1]!.split('.').pop()!)}?`;
  const filled = /^([\w$]+\??\.)*([\w$]+)\?\.trim\(\)$/.exec(inner);
  if (filled) return `Is ${words(filled[2]!)} filled in?`;
  // `addQty > 0` -> `Is add qty more than 0?` — only a name against a number or a name.
  const compare = /^([\w$]+(?:\.[\w$]+)*) (>=|<=|>|<) ([\w$.]+|-?\d+(?:\.\d+)?)$/.exec(inner);
  if (compare && !negated) {
    const side = (text: string) =>
      /^-?\d/.test(text) ? text : words(text.split('.').slice(-2).join(' '));
    const op = { '>': 'more than', '<': 'less than', '>=': 'at least', '<=': 'at most' }[
      compare[2]!
    ];
    return `Is ${side(compare[1]!)} ${op} ${side(compare[3]!)}?`;
  }
  // Code that has no safe reading stays as written — `addQty > 0?`, not `AddQty > 0?`.
  if (/&&|\|\||\?\?/.test(inner)) return question;
  const equal = /^([\w$.]+) (===|!==|==|!=) ([^=<>!]+)$/.exec(inner);
  if (equal && !negated)
    return `${equal[1]} ${equal[2]!.startsWith('!') ? 'is not' : 'is'} ${equal[3]}?`;
  if (/^[a-z][\w$]*(\.[a-z][\w$]*)?$/.test(inner)) {
    const name = words(inner.split('.').pop()!);
    // `!medicine` asks whether there is one; `!allowed` asks whether it is.
    return negated && !/(ed|able|ible|valid|ok|ready|open)$/.test(name)
      ? `Has ${name}?`
      : `${capitalise(name)}?`;
  }
  return question;
}

function literalOf(node: Node): string | undefined {
  const value = unwrap(node);
  if (Node.isStringLiteral(value) || Node.isNoSubstitutionTemplateLiteral(value))
    return value.getLiteralValue();
  return undefined;
}

function stringProperty(object: Node, keys: string[]): string | undefined {
  if (!Node.isObjectLiteralExpression(object)) return undefined;
  for (const key of keys) {
    const property = object.getProperty(key);
    if (property && Node.isPropertyAssignment(property)) {
      const value = property.getInitializer();
      const text = value ? literalOf(value) : undefined;
      if (text) return text;
    }
  }
  return undefined;
}

/** `{ queryKey: queryKeys.medicines.all }` -> `medicines`; `["stock", "history"]` -> `stock history`. */
function cacheKeyWords(text: string): string {
  const key = /queryKey:\s*([^}]+)/.exec(text)?.[1] ?? text;
  const parts = key.match(/[A-Za-z_$][\w$]*/g) ?? [];
  return [...new Set(parts.filter((part) => !/^(queryKeys?|keys|all|queryKey|exact)$/.test(part)))]
    .map(words)
    .join(' ');
}

/** `isExistingCustomer` -> `is existing customer`. */
function words(name: string): string {
  return name
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[_-]+/g, ' ')
    .toLowerCase()
    .trim();
}

function capitalise(text: string): string {
  return text ? `${text[0]!.toUpperCase()}${text.slice(1)}` : text;
}

// ---------------------------------------------------------------------------
// Text
// ---------------------------------------------------------------------------

/**
 * The tree as plain text — for the terminal, an MCP answer, or a pull request.
 *
 *   ▶ The user clicks "Save update"
 *   ▸ AdjustStockDialog.submit()
 *     ◆ medicine?
 *     ├─ no
 *     │  ■ stops here
 *     └─ yes ↓
 */
export function renderDecisionTree(tree: ActionDecisions): string {
  const lines: string[] = [tree.title, ''];
  const where = (at?: SourcePoint): string => (at ? `  (${at.file}:${at.line})` : '');
  const statusText = (node: DecisionEnd): string =>
    node.statuses?.length ? ` [${node.statuses.join('/')}]` : '';

  const write = (nodes: DecisionNode[], indent: string): void => {
    for (const node of nodes) {
      switch (node.type) {
        case 'step': {
          const mark =
            node.kind === 'trigger'
              ? '▶'
              : node.kind === 'db'
                ? '⛁'
                : node.kind === 'external'
                  ? '⇢'
                  : node.kind === 'guard'
                    ? '⛨'
                    : node.kind === 'shared'
                      ? '⧉'
                      : '•';
          const effect = node.effect ? ` (${node.effect})` : '';
          const detail = node.detail ? ` — ${node.detail}` : '';
          lines.push(`${indent}${mark} ${node.text}${effect}${detail}${where(node.at)}`);
          if (node.shared) {
            lines.push(
              `${indent}  shared with ${node.shared.actions - 1} other ${node.shared.actions === 2 ? 'action' : 'actions'} — drawn once, under "Shared"`,
            );
            for (const end of node.shared.ends) {
              lines.push(
                `${indent}  ■ ${end.label.charAt(0).toLowerCase()}${end.label.slice(1)}${end.statuses?.length ? ` [${end.statuses.join('/')}]` : ''}`,
              );
            }
          }
          break;
        }
        case 'end':
          lines.push(`${indent}■ ${node.text}${statusText(node)}${where(node.at)}`);
          break;
        case 'group': {
          const mark =
            node.kind === 'request'
              ? '⇄'
              : node.kind === 'loop'
                ? '↻'
                : node.kind === 'parallel'
                  ? '⇉'
                  : '▸';
          const handled = node.handledBy
            ? `  → ${node.handledBy.file}:${node.handledBy.line}`
            : where(node.at);
          lines.push(`${indent}${mark} ${node.title}${handled}`);
          write(node.nodes, `${indent}  `);
          break;
        }
        case 'decision': {
          lines.push(`${indent}◆ ${node.question}${where(node.at)}`);
          const arms = [
            ...node.branches.map((branch) => ({ ...branch, fall: false })),
            ...(node.otherwise
              ? [{ label: node.otherwise, nodes: [], ends: false, fall: true }]
              : []),
          ];
          arms.forEach((arm, index) => {
            const lastArm = index === arms.length - 1;
            const branchMark = lastArm ? '└─' : '├─';
            const suffix = arm.fall
              ? ' ↓ continues'
              : arm.nodes.length === 0
                ? ' — plain code only'
                : '';
            lines.push(`${indent}${branchMark} ${arm.label}${suffix}`);
            write(arm.nodes, `${indent}${lastArm ? '   ' : '│  '}`);
          });
          break;
        }
        case 'try':
          lines.push(`${indent}⟳ try`);
          write(node.nodes, `${indent}  `);
          if (node.catch) {
            lines.push(`${indent}✗ if ${node.catch.label}`);
            write(node.catch.nodes, `${indent}  `);
          }
          if (node.finally) {
            lines.push(`${indent}↧ finally`);
            write(node.finally, `${indent}  `);
          }
          break;
      }
    }
  };
  write(tree.nodes, '');
  if (tree.limits.length) {
    lines.push('', 'Limits:');
    for (const limit of tree.limits) lines.push(`- ${limit}`);
  }
  return `${lines.join('\n')}\n`;
}
