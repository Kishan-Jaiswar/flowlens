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
  Node,
  SyntaxKind,
  type CallExpression,
  type IfStatement,
  type ReturnStatement,
} from 'ts-morph';
import type { Functionish } from '../analyzer/ast.js';
import { dbEffectOf } from '../analyzer/mongo.js';
import type { FlowGraph } from '../graph/graph.js';
import type { FlowNode } from '../graph/types.js';
import { locateAction, type LocatedAction } from './action.js';
import {
  bodyStatements,
  condense,
  functionAtLine,
  functionOf,
  localVariable,
  nameOf,
  nearestFunction,
  shortCall,
  SourceReader,
  statusOf,
  unwrap,
  type SourcePoint,
} from './actionsource.js';
import type { FeatureFlow } from './resolve.js';

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
   */
  kind: 'trigger' | 'call' | 'ui' | 'db' | 'external' | 'guard';
  /** What happens, in plain words: `Update medicines`, `Show error "…"`. */
  label: string;
  /** The code that does it, as written (condensed). */
  text: string;
  side: DecisionSide;
  at?: SourcePoint;
  /** read | create | update | delete | write, for a query. */
  effect?: string;
  /** The graph node behind a query or effect, so a view can link to it. */
  nodeId?: string;
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
   * - `loop` — a `for`/`while` whose body does real work
   * - `unlinked` — requests the walk from the handler did not reach
   */
  kind: 'function' | 'request' | 'loop' | 'unlinked';
  /** `Runs adjustStock`, `Sends POST /stock to the server`. */
  label: string;
  title: string;
  side: DecisionSide;
  at?: SourcePoint;
  /** For a request: the file that answers it. */
  handledBy?: SourcePoint;
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
   */
  outcome: 'stop' | 'respond' | 'return' | 'throw';
  /** `Respond 422 · Validation failed`, `Stop`. */
  label: string;
  text: string;
  statuses?: number[];
  message?: string;
  side: DecisionSide;
  at?: SourcePoint;
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
const MAX_DEPTH = 7;

/** A tree past this many nodes stops growing; the reader is told. */
const MAX_NODES = 900;

/** Frontend calls that change what the user sees. */
const UI_CALLS =
  /^(toast(\.\w+)?|alert|notify|enqueueSnackbar|message\.\w+|notification\.\w+|router\.(push|replace|back|refresh|prefetch)|navigate|redirect|window\.location\.\w+|location\.(assign|replace|reload)|\w+\.invalidateQueries|\w+\.setQueryData|\w+\.refetch(Queries)?|refetch|mutate|reset|form\.reset|\w+\.reset|revalidatePath|revalidateTag)$/;

/** Hooks whose options carry the request's success and failure callbacks. */
const MUTATIONS = /\.(mutate|mutateAsync)$/;

interface Frame {
  side: DecisionSide;
  /**
   * What a `return` means here: the handler stopping, the server answering, or
   * a helper giving a value back to its caller.
   */
  role: 'handler' | 'server' | 'helper';
  depth: number;
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
  /** The component's handler a child calls through its prop, when there is one. */
  parentHandler?: Functionish;
  /** Props of the child component that run the parent's handler. */
  childProps: Set<string>;
  size: number;
  limits: Set<string>;
}

/** The decision tree for one action. */
export function actionDecisions(
  graph: FlowGraph,
  flow: FeatureFlow,
  options: ActionDecisionsOptions = {},
): ActionDecisions {
  const reader = options.reader ?? new SourceReader(graph);
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
    childProps: new Set(),
    size: 0,
    limits: new Set(located.limits),
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
  } catch (error) {
    walk.limits.add(
      `Part of the source could not be read: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  // A request the walk did not reach is still part of the action: list it, with
  // its server side, rather than let the tree suggest the action sends nothing.
  const missed = located.calls.filter((call) => !walk.drawn.has(call));
  if (missed.length > 0) {
    const reached = walk.drawn.size > 0;
    nodes.push({
      type: 'group',
      label: '',
      kind: 'unlinked',
      title: reached
        ? 'Also requested — the walk from the handler did not reach these'
        : flow.event === 'mount' || !walk.located.front.some((fn) => fn.role !== 'request')
          ? 'Requests made'
          : 'Requests made — the walk from the handler did not reach them',
      side: 'browser',
      nodes: missed.flatMap((call) => [
        ...requestNodes(walk, call, { side: 'browser', role: 'handler', depth: 0 }),
        ...hookOutcome(walk, call, undefined, { side: 'browser', role: 'handler', depth: 0 }),
      ]),
    });
  }

  if (walk.size >= MAX_NODES) {
    walk.limits.add(
      `The tree stops at ${MAX_NODES} nodes; deeper helpers are named, not followed.`,
    );
  }
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

function walkEntry(walk: Walk): DecisionNode[] {
  const { located } = walk;
  const out: DecisionNode[] = [];
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
  const first = handlers[0];
  if (first) out.push(functionNode(walk, first.fn, frame, first.name));
  // A page load: the request functions are the entry.
  return out;
}

/** A function as a step, or as a group when something happens inside it. */
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
    return walkStatements(walk, bodyStatements(fn), frame, true);
  } finally {
    walk.stack.pop();
  }
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
    return walkExpression(walk, statement.getExpression(), frame);
  }

  if (Node.isVariableStatement(statement)) {
    return statement.getDeclarations().flatMap((declaration) => {
      const init = declaration.getInitializer();
      return init ? walkExpression(walk, init, frame) : [];
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

  if (Node.isSwitchStatement(statement)) {
    const branches: DecisionBranch[] = statement.getClauses().map((clause) => {
      const body = clause.getStatements().filter((inner) => !Node.isBreakStatement(inner));
      const nodes = walkStatements(walk, body, frame, false);
      return {
        label: Node.isCaseClause(clause)
          ? `case ${condense(clause.getExpression().getText(), 30)}`
          : 'default',
        nodes,
        ends: endsAll(nodes),
      };
    });
    if (branches.every((branch) => branch.nodes.length === 0)) return [];
    const exhaustive = statement.getClauses().some((clause) => Node.isDefaultClause(clause));
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
      ? walkStatements(walk, clause.getBlock().getStatements(), frame, false)
      : [];
    const finallyBlock = statement.getFinallyBlock();
    const after = finallyBlock
      ? walkStatements(walk, finallyBlock.getStatements(), frame, false)
      : [];
    if (nodes.length === 0 && caught.length === 0 && after.length === 0) return [];
    if (caught.length === 0 && after.length === 0) return nodes;
    walk.size += 1;
    return [
      {
        type: 'try',
        side: frame.side,
        at: walk.reader.point(statement),
        nodes,
        ...(clause
          ? { catch: { label: 'anything above fails', nodes: caught, ends: endsAll(caught) } }
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
    const nodes = walkStatement(walk, body, frame, false);
    if (!nodes.some(worthShowing)) return [];
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
  const thenNodes = walkStatement(walk, statement.getThenStatement(), frame, false);
  const elseStatement = statement.getElseStatement();
  const elseNodes = elseStatement ? walkStatement(walk, elseStatement, frame, false) : [];

  // Calls inside the condition run before either branch: `if (!(await exists(id)))`.
  const before = walkExpression(walk, condition, frame);

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

function returnNodes(
  walk: Walk,
  statement: ReturnStatement,
  frame: Frame,
  last: boolean,
): DecisionNode[] {
  const expression = statement.getExpression();
  // `return apiError(…, 403)` and `return { error: unauthorized() }` name their
  // status already; following the helper would only add its plumbing.
  const found = expression ? statusIn(walk, expression) : undefined;
  const work = found || !expression ? [] : walkExpression(walk, expression, frame);
  if (frame.role === 'server') {
    const text = expression
      ? `responds ${condense(expression.getText(), 70)}`
      : 'responds with no body';
    return [...work, end(walk, 'respond', text, frame, statement, found)];
  }
  if (last && !found) return work;
  if (frame.role === 'handler') return [...work, end(walk, 'stop', 'stops here', frame, statement)];
  const text = expression ? `returns ${condense(expression.getText(), 70)}` : 'returns';
  return [...work, end(walk, 'return', text, frame, statement, found)];
}

/** The status a returned value carries: the value itself, or one of its properties. */
function statusIn(
  walk: Walk,
  expression: Node,
): { statuses: number[]; message?: string } | undefined {
  const direct = statusOf(walk.reader, expression);
  if (direct?.statuses.length) return direct;
  const value = unwrap(expression);
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
    return [
      ...walkExpression(walk, node.getLeft(), frame),
      ...walkExpression(walk, node.getRight(), frame),
    ];
  }

  // The calls in this expression, not inside functions it creates.
  const calls = [node, ...node.getDescendants()]
    .filter((candidate): candidate is CallExpression => Node.isCallExpression(candidate))
    .filter((call) => ownedBy(call, node))
    .sort((a, b) => a.getEnd() - b.getEnd());

  const kept = calls
    .map((call) => ({ call, kind: classify(walk, call) }))
    .filter((entry) => entry.kind !== undefined);
  const out: DecisionNode[] = [];
  const handled = new Set<CallExpression>();
  for (const { call, kind } of kept) {
    if (handled.has(call) || walk.size >= MAX_NODES) continue;
    // `setError(message(e))`: the helper is part of what the outer call shows.
    if ((kind === 'project' || kind === 'ui') && insideArgumentsOfKept(call, kept)) continue;
    out.push(...callNodes(walk, call, kind!, frame, handled));
  }
  return out;
}

type CallKind =
  'request' | 'effect' | 'query' | 'mutate' | 'continuation' | 'prop' | 'ui' | 'project';

function classify(walk: Walk, call: CallExpression): CallKind | undefined {
  if (walk.requests.has(siteKey(call))) return 'request';
  if (effectsAt(walk, call).length > 0) return 'effect';
  if (unlinkedQuery(walk, call)) return 'query';
  const text = calleeText(call);
  if (MUTATIONS.test(text)) return 'mutate';
  const member = text.split('.').pop() ?? '';
  if ((member === 'then' || member === 'catch') && call.getArguments().length > 0)
    return 'continuation';
  if (Node.isIdentifier(call.getExpression()) && walk.childProps.has(text)) return 'prop';
  if (UI_CALLS.test(text) || /^set[A-Z]\w*$/.test(text)) return 'ui';
  if (resolveCallee(walk, call)) return 'project';
  if (Node.isIdentifier(call.getExpression()) && isProp(call, text)) return 'ui';
  return undefined;
}

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
      return effectsAt(walk, call).map((effect) => {
        walk.size += 1;
        const meta = effect.meta ?? {};
        const isDb = effect.kind === 'db-op';
        return {
          type: 'step',
          kind: isDb ? 'db' : 'external',
          label: '',
          text: isDb ? effect.label : `${effect.label} (leaves the app)`,
          side: isDb ? 'database' : 'external',
          at: walk.reader.point(call),
          ...(isDb ? { effect: String(meta['effect'] ?? meta['access'] ?? 'read') } : {}),
          nodeId: effect.id,
        } satisfies DecisionStep;
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
          effect: found.effect,
        },
      ];
    }
    case 'mutate':
      return mutateNodes(walk, call, frame);
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
      if (walk.opened.has(target))
        return [step(walk, 'call', `${label} — opened above`, frame, call)];
      const inner = walkFunction(walk, target, {
        side: frame.side,
        role: 'helper',
        depth: frame.depth + 1,
      });
      if (!inner.some(worthShowing)) return [step(walk, 'call', label, frame, call)];
      walk.opened.add(target);
      walk.size += 1;
      return [
        {
          type: 'group',
          label: '',
          kind: 'function',
          title: label,
          side: frame.side,
          at: walk.reader.point(call),
          nodes: inner,
        },
      ];
    }
  }
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
    nodes.push({
      type: 'step',
      kind: 'guard',
      label: '',
      text: `${guard.role === 'guard' ? 'checked by' : `${guard.role}:`} ${guard.name}`,
      side: 'server',
      ...(guard.file ? { at: { file: guard.file, line: guard.line ?? 1 } } : {}),
    });
  }
  const handler = located.backendFns[0];
  if (handler) {
    const server: Frame = { side: 'server', role: 'server', depth: frame.depth + 1 };
    nodes.push(...walkFunction(walk, handler.fn, server));
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
  return [
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
  ];
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
  if (Node.isIdentifier(callee)) return resolveName(walk, callee.getText(), call);
  if (!Node.isPropertyAccessExpression(callee)) return undefined;
  // `this.orders.create(dto)` / `ordersService.create(dto)`: the graph has
  // already resolved the injected class; match the method it found.
  const name = callee.getName();
  const receiver = callee.getExpression().getText();
  if (receiver === 'this') {
    const owner = call.getFirstAncestor((ancestor) => Node.isClassDeclaration(ancestor));
    if (owner && Node.isClassDeclaration(owner)) {
      const method = owner.getMethod(name);
      if (method) return method;
    }
  }
  const matches = walk.graph
    .nodesOfKind('method')
    .filter((node) => node.source && (node.label === name || node.label.endsWith(`.${name}`)));
  const inFlow = matches.filter((node) =>
    walk.flow.steps.some((flowStep) => flowStep.nodeId === node.id),
  );
  // `this.ordersService.create` -> `OrdersService.create`, not the controller's
  // own `create` that makes the call.
  const holder = receiver.split('.').pop()?.replace(/^_+/, '').toLowerCase() ?? '';
  const byHolder = (list: FlowNode[]): FlowNode[] =>
    list.filter((node) => node.label.split('.')[0]?.toLowerCase() === holder);
  const pick = [byHolder(inFlow), byHolder(matches), inFlow, matches].find(
    (list) => list.length === 1,
  )?.[0];
  if (!pick?.source) return undefined;
  // `products.find()` is the driver, not a project method that happens to be called `find`.
  if (
    /^(find|findOne|insertOne|updateOne|deleteOne|aggregate|save|create|update|delete)$/.test(
      name,
    ) &&
    !/service|repo|store|this/i.test(receiver)
  )
    return undefined;
  const file = walk.reader.file(pick.source.file);
  return file ? functionAtLine(file, pick.source.line) : undefined;
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
  if (!effect) return undefined;
  const receiver = unwrap(callee.getExpression());
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

/** The db-ops and effects the graph found at this call — the call itself, not one beside it. */
function effectsAt(walk: Walk, call: CallExpression): FlowNode[] {
  const point = walk.reader.point(call);
  const lines = new Set([point.line, call.getExpression().getEndLineNumber()]);
  const member = calleeText(call).split('.').pop() ?? '';
  const found: FlowNode[] = [];
  for (const line of lines) {
    for (const node of walk.effects.get(`${point.file}:${line}`) ?? []) {
      if (found.includes(node)) continue;
      if (node.kind === 'db-op' && String(node.meta?.['operation'] ?? '') !== member) continue;
      if (node.kind === 'external-effect' && String(node.meta?.['call'] ?? '') !== calleeText(call))
        continue;
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

/** Whether a helper's inside is worth opening: anything but plain calls. */
function worthShowing(node: DecisionNode): boolean {
  switch (node.type) {
    case 'step':
      return node.kind !== 'call';
    case 'end':
      return node.outcome !== 'return';
    case 'decision':
      return node.branches.some((branch) => branch.nodes.some(worthShowing));
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
  return {
    type: 'decision',
    question,
    label: '',
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
  const verb =
    flow.event === 'onSubmit' ? 'submits' : flow.event === 'onChange' ? 'changes' : 'clicks';
  // `MedicineForm onSubmit` is a name made from code; the title reads better.
  if (/\bon[A-Z]/.test(flow.label)) {
    const where = flow.component ?? flow.screen;
    return `The user ${verb} the form${where ? ` in ${where}` : ''}`;
  }
  return `The user ${verb} "${flow.label}"`;
}

function countOf(nodes: DecisionNode[]): ActionDecisions['counts'] {
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
        if (node.outcome !== 'return') counts.outcomes += 1;
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
      return capitalise(node.text);
    case 'db': {
      const [collection = node.text] = node.text.split('.');
      return `${DB_VERB[node.effect ?? 'read'] ?? 'Query'} ${collection}`;
    }
    case 'external': {
      // `cache (set) (leaves the app)` -> `Cache: set`
      const match = /^(.+?) \((\w+)\)/.exec(node.text);
      return match ? `${capitalise(match[1]!)}: ${match[2]}` : capitalise(node.text);
    }
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
      return `Throw ${status ? `${status} error` : 'an error'}${message}`;
    case 'return': {
      if (status) return `Return a ${status} error to the caller${message}`;
      const error = /error:\s*["'`]([^"'`]+)["'`]/.exec(node.text)?.[1];
      if (error) return `Return error "${error}" to the caller`;
      const value = node.text.replace(/^returns ?/, '');
      return value ? `Return early with ${value}` : 'Return early';
    }
  }
}

function groupLabel(node: DecisionGroup): string {
  switch (node.kind) {
    case 'request':
      return `Send ${node.title} to the server`;
    case 'loop':
      return capitalise(node.title);
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

/**
 * A condition in plain words, for the shapes that have one:
 * `"error" in ctx` -> `ctx has error?`, `parsed.success` -> `parsed succeeded?`,
 * `items.length` -> `items is not empty?`, `a === "x"` -> `a is "x"?`.
 */
function questionLabel(code: string, question: string): string {
  const flat = code.replace(/\s+/g, ' ').trim();
  const negated = /^!\s*\(?(.+?)\)?$/.exec(flat);
  const inner = negated && !flat.startsWith('!!') && !/[&|]/.test(flat) ? negated[1]! : flat;
  const has = /^["'`](\w+)["'`] in ([\w$.]+)$/.exec(inner);
  if (has) return `${has[2]} has ${has[1]}?`;
  const success = /^([\w$.]+)\.(success|ok)$/.exec(inner);
  if (success) return `${success[1]} succeeded?`;
  const length = /^([\w$.]+)\.length( > 0)?$/.exec(inner);
  if (length) return `${length[1]} is not empty?`;
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
                    : '•';
          const effect = node.effect ? ` (${node.effect})` : '';
          lines.push(`${indent}${mark} ${node.text}${effect}${where(node.at)}`);
          break;
        }
        case 'end':
          lines.push(`${indent}■ ${node.text}${statusText(node)}${where(node.at)}`);
          break;
        case 'group': {
          const mark = node.kind === 'request' ? '⇄' : node.kind === 'loop' ? '↻' : '▸';
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
