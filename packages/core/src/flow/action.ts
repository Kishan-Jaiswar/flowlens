/**
 * One action, documented end to end.
 *
 * The screen document answers "what is this page"; this one answers the
 * question a developer actually has in front of a button: *what happens,
 * exactly, when somebody presses it?* — in the order it happens, from the page
 * opening to the state the screen is left in, with every hop between: the
 * handlers, the checks that can stop it, how the payload is put together, the
 * real request, the guards, the validation on the other side, the business
 * logic, the queries, the response and what the frontend does with it.
 *
 * Nineteen fixed stages, always in the same order, so two actions' documents
 * can be read side by side. Not every action has every step — a delete has no
 * form, a page load no click, most actions no confirmation dialog — so a stage whose step does not exist is marked
 * `absent` and the views leave it out. They still list what was left out and
 * why: "no guard was found on this route" is a finding, and silently dropping
 * it would hide it.
 *
 * The graph supplies the chain; the few source files one action touches are
 * read on demand (see `actionsource.ts`) for the detail the graph does not
 * keep. Nothing is executed and nothing is inferred beyond what the code
 * says: a fact that cannot be read is reported as missing, not guessed.
 */

import { existsSync, readFileSync } from 'node:fs';
import { Node, SyntaxKind, type CallExpression, type IfStatement, type SourceFile } from 'ts-morph';
import type { Functionish } from '../analyzer/ast.js';
import { DB_EFFECT_LABEL, type DbEffect } from '../analyzer/mongo.js';
import type { FlowGraph } from '../graph/graph.js';
import type { Evidence } from '../graph/types.js';
import {
  argumentKeys,
  attribute,
  bodyStatements,
  callAtLine,
  condense,
  elementText,
  endsFunction,
  functionAtLine,
  functionOf,
  jsxOpenings,
  literalText,
  localVariable,
  nameOf,
  nearestFunction,
  objectKeysOf,
  ownDescendants,
  readSchema,
  returnsOf,
  schemaCallIn,
  shortCall,
  shortExpression,
  SourceReader,
  statusOf,
  tagOf,
  unwrap,
  type SchemaFacts,
  type SourcePoint,
} from './actionsource.js';
import { flowApis, type ApiCallDetail, type FlowApis } from './api.js';
import { resolveFlows, type FeatureFlow } from './resolve.js';

// ---------------------------------------------------------------------------
// The document
// ---------------------------------------------------------------------------

export type Tone = 'ok' | 'warn' | 'error' | 'muted';

export interface DocLine {
  /** Prose with code in backticks. */
  text: string;
  at?: SourcePoint;
  tone?: Tone;
  sub?: DocLine[];
}

export interface DocRow {
  /** One cell per column, prose with code in backticks. */
  cells: string[];
  at?: SourcePoint;
  tone?: Tone;
}

/**
 * Facts with the same shape, as a table.
 *
 * Twenty fields each with a label, a rule and a message read as a wall of
 * text in a list and as one glance in a table — the columns do the parsing a
 * reader would otherwise do in their head.
 */
export interface DocTable {
  columns: string[];
  rows: DocRow[];
}

export interface DocGroup {
  label: string;
  lines: DocLine[];
  table?: DocTable;
  /** Colours the whole group: a success path, a failure path. */
  tone?: Tone;
  /** Detail most readers can skip, shown folded. */
  collapsed?: boolean;
}

export type StageKey =
  | 'open'
  | 'form'
  | 'trigger'
  | 'confirm'
  | 'handlers'
  | 'frontend-validation'
  | 'payload'
  | 'request'
  | 'route'
  | 'guards'
  | 'controller'
  | 'backend-validation'
  | 'service'
  | 'database'
  | 'db-result'
  | 'response'
  | 'receive'
  | 'response-handler'
  | 'final-ui';

/** Where in the round trip a stage happens. */
export type Phase = 'browser' | 'wire' | 'server' | 'database' | 'back';

export const PHASE_TITLES: Record<Phase, string> = {
  browser: 'In the browser — before anything is sent',
  wire: 'Over the network',
  server: 'On the server',
  database: 'In the database',
  back: 'The way back — response to screen',
};

export interface ActionStage {
  n: number;
  key: StageKey;
  title: string;
  phase: Phase;
  /** One short line: what happens in this stage, for the at-a-glance view. */
  summary: string;
  groups: DocGroup[];
  /** Why the stage is empty, when it is. */
  empty?: string;
  /** The step does not exist in this action; `summary` says why. Views leave it out. */
  absent?: true;
}

export interface ActionDoc {
  flowId: string;
  title: string;
  screen?: string;
  component?: string;
  event?: string;
  /** "clicks "Save product"" — the words for the trigger. */
  trigger: string;
  evidence: Evidence;
  endpoints: string[];
  source?: SourcePoint;
  stages: ActionStage[];
  /** What the document could not see. */
  limits: string[];
}

const STAGE_PHASE: Record<StageKey, Phase> = {
  open: 'browser',
  form: 'browser',
  trigger: 'browser',
  confirm: 'browser',
  handlers: 'browser',
  'frontend-validation': 'browser',
  payload: 'browser',
  request: 'wire',
  route: 'wire',
  guards: 'server',
  controller: 'server',
  'backend-validation': 'server',
  service: 'server',
  database: 'database',
  'db-result': 'database',
  response: 'back',
  receive: 'back',
  'response-handler': 'back',
  'final-ui': 'back',
};

const STAGE_TITLES: Record<StageKey, string> = {
  open: 'User opens page',
  form: 'User fills form',
  trigger: 'User triggers the action',
  confirm: 'Confirmation dialog',
  handlers: 'Click / event handler',
  'frontend-validation': 'Frontend validation',
  payload: 'Payload construction',
  request: 'Actual API request',
  route: 'Backend route',
  guards: 'Middleware / guard / auth',
  controller: 'Controller',
  'backend-validation': 'Backend validation',
  service: 'Service / business logic',
  database: 'Database',
  'db-result': 'Database result',
  response: 'Backend response',
  receive: 'Frontend receives response',
  'response-handler': 'Frontend response handler',
  'final-ui': 'Final UI state',
};

const STAGE_ORDER: StageKey[] = [
  'open',
  'form',
  'trigger',
  'confirm',
  'handlers',
  'frontend-validation',
  'payload',
  'request',
  'route',
  'guards',
  'controller',
  'backend-validation',
  'service',
  'database',
  'db-result',
  'response',
  'receive',
  'response-handler',
  'final-ui',
];

// ---------------------------------------------------------------------------
// Context shared by the stages
// ---------------------------------------------------------------------------

interface FrontFn {
  name: string;
  fn: Functionish;
  role: 'child' | 'handler' | 'request';
  /** Why it runs: `<form onSubmit={handleSubmit}>`. */
  via?: string;
}

interface CallContext {
  detail: ApiCallDetail;
  call?: CallExpression;
  fn?: Functionish;
  /** The hook whose `useMutation`/`useQuery` holds the request function. */
  hook?: { name: string; fn: Functionish; options?: Node };
  handler?: Functionish;
  backendFns: Array<{ label: string; fn: Functionish; at: SourcePoint }>;
}

interface Ctx {
  graph: FlowGraph;
  flow: FeatureFlow;
  reader: SourceReader;
  apis: FlowApis;
  flows: FeatureFlow[];
  entryFile?: SourceFile;
  entryOpening?: Node;
  componentFn?: Functionish;
  /** A child component that handles the event first and then calls the prop. */
  child?: { component: string; fn: Functionish; handler?: Functionish; opening?: Node };
  /** The element the user actually touches. */
  triggerOpening?: Node;
  /** The component holding the form fields: the child when there is one. */
  formFn?: Functionish;
  front: FrontFn[];
  calls: CallContext[];
  frontSchemas: Array<{ facts: SchemaFacts; method: string; call: CallExpression }>;
  labels: Map<string, { label?: string; required: boolean }>;
  limits: Set<string>;
  /** Read once by `confirmationsOf`. */
  confirms?: Confirmation[];
}

export interface ExplainActionOptions {
  /** Reuse a reader across documents (the server keeps one per scan). */
  reader?: SourceReader;
}

/** The document for one feature flow. */
export function explainAction(
  graph: FlowGraph,
  flow: FeatureFlow,
  options: ExplainActionOptions = {},
): ActionDoc {
  const reader = options.reader ?? new SourceReader(graph);
  const ctx: Ctx = {
    graph,
    flow,
    reader,
    apis: flowApis(graph, flow),
    flows: resolveFlows(graph, { includeLocalOnly: true }),
    front: [],
    calls: [],
    frontSchemas: [],
    labels: new Map(),
    limits: new Set(),
  };

  // Each reading is independent: a file that fails to parse costs its stage,
  // not the document.
  safely(ctx, () => locateEntry(ctx));
  safely(ctx, () => locateCalls(ctx));
  safely(ctx, () => {
    if (ctx.formFn) ctx.labels = fieldLabels(ctx.formFn);
  });
  safely(ctx, () => collectFrontSchemas(ctx));

  const builders: Record<StageKey, (c: Ctx) => StageBody> = {
    open: stageOpen,
    form: stageForm,
    trigger: stageTrigger,
    confirm: stageConfirm,
    handlers: stageHandlers,
    'frontend-validation': stageFrontendValidation,
    payload: stagePayload,
    request: stageRequest,
    route: stageRoute,
    guards: stageGuards,
    controller: stageController,
    'backend-validation': stageBackendValidation,
    service: stageService,
    database: stageDatabase,
    'db-result': stageDbResult,
    response: stageResponse,
    receive: stageReceive,
    'response-handler': stageResponseHandler,
    'final-ui': stageFinalUi,
  };

  const stages: ActionStage[] = STAGE_ORDER.map((key, index) => {
    let body: StageBody;
    try {
      body = builders[key](ctx);
    } catch (error) {
      body = { groups: [], empty: `Could not read this stage: ${errorText(error)}` };
    }
    const groups = body.groups.filter(
      (group) => group.lines.length > 0 || (group.table?.rows.length ?? 0) > 0,
    );
    const empty = groups.length === 0 ? (body.empty ?? 'Nothing found for this stage.') : undefined;
    return {
      n: index + 1,
      key,
      title: STAGE_TITLES[key],
      phase: STAGE_PHASE[key],
      summary: body.summary ?? empty ?? '',
      groups,
      ...(empty ? { empty } : {}),
      ...(body.absent ? { absent: true as const } : {}),
    };
  });

  const entry = flow.steps[0];
  return {
    flowId: flow.id,
    title: flow.title,
    ...(flow.screen ? { screen: flow.screen } : {}),
    ...(flow.component ? { component: flow.component } : {}),
    ...(flow.event ? { event: flow.event } : {}),
    trigger: triggerPhrase(ctx),
    evidence: flow.evidence,
    endpoints: flow.endpoints,
    ...(entry?.file ? { source: { file: entry.file, line: entry.line ?? 1 } } : {}),
    stages,
    limits: [
      ...ctx.limits,
      'Read from the source, not run: branches are listed as written, and a condition ' +
        'that is never true at runtime still appears.',
      'Helpers are followed a few levels deep. Logic hidden behind a dynamic call, a ' +
        'library or a generated client shows up as the call, not as what it does.',
    ],
  };
}

function safely(ctx: Ctx, run: () => void): void {
  try {
    run();
  } catch (error) {
    ctx.limits.add(`Part of the source could not be read: ${errorText(error)}`);
  }
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// ---------------------------------------------------------------------------
// Locating the code
// ---------------------------------------------------------------------------

function locateEntry(ctx: Ctx): void {
  const { flow, reader } = ctx;
  const entry = flow.steps[0];
  const file = reader.file(entry?.file);
  if (!file || !entry) return;
  ctx.entryFile = file;

  if (flow.component) {
    ctx.componentFn =
      reader.functionNamed(flow.component, file) ??
      (functionAtLine(file, entry.line ?? 0) && nearestComponent(file, entry.line ?? 0));
  }

  const event = flow.event;
  if (event && event !== 'mount') {
    const attr = file
      .getDescendantsOfKind(SyntaxKind.JsxAttribute)
      .filter((candidate) => candidate.getNameNode().getText() === event)
      .sort(
        (a, b) =>
          Math.abs(a.getStartLineNumber() - (entry.line ?? 0)) -
          Math.abs(b.getStartLineNumber() - (entry.line ?? 0)),
      )[0];
    const opening = attr?.getParent()?.getParent();
    if (opening) ctx.entryOpening = opening;
  }
  ctx.componentFn ??= ctx.entryOpening ? componentOf(ctx.entryOpening) : undefined;
  ctx.formFn = ctx.componentFn;
  ctx.triggerOpening = ctx.entryOpening;

  // The handler named on the element, then the handlers the graph found.
  const seen = new Set<Node>();
  const push = (fn: Functionish | undefined, role: FrontFn['role'], via?: string): void => {
    if (!fn || seen.has(fn)) return;
    seen.add(fn);
    ctx.front.push({ name: qualified(fn), fn, role, ...(via ? { via } : {}) });
  };

  // A child component that runs its own handler before calling the prop.
  if (ctx.entryOpening && event) {
    const tag = tagOf(ctx.entryOpening);
    if (/^[A-Z]/.test(tag)) locateChild(ctx, tag, event);
  }
  if (ctx.child?.handler) {
    push(
      ctx.child.handler,
      'child',
      ctx.child.opening ? openingSnippet(ctx.child.opening, ctx.child.handler) : undefined,
    );
  }

  if (ctx.entryOpening && event) {
    const expression = attribute(ctx.entryOpening, event);
    if (expression) {
      const via = `<${tagOf(ctx.entryOpening)} ${event}={${condense(expression.getText(), 40)}}>`;
      for (const fn of handlersFromExpression(ctx, expression)) push(fn, 'handler', via);
    }
  }
  for (const step of flow.steps) {
    if (step.kind !== 'handler' || !step.file || !step.line) continue;
    const stepFile = reader.file(step.file);
    if (stepFile) push(functionAtLine(stepFile, step.line), 'handler');
  }
}

/** The function component declared around a line. */
function nearestComponent(file: SourceFile, line: number): Functionish | undefined {
  const fn = functionAtLine(file, line);
  return fn ? componentOf(fn) : undefined;
}

/** The outermost capitalised function around a node: the component. */
function componentOf(node: Node): Functionish | undefined {
  let found: Functionish | undefined;
  let current: Node | undefined = node;
  while (current) {
    const fn = nearestFunction(current) as Functionish | undefined;
    if (!fn) break;
    if (/^[A-Z]/.test(nameOf(fn))) found = fn;
    current = fn;
  }
  return found;
}

/** `ProductForm.handleSubmit` — the component and the function. */
function qualified(fn: Functionish): string {
  const name = nameOf(fn);
  const component = componentOf(fn);
  const componentName = component && component !== fn ? nameOf(component) : undefined;
  if (componentName) return `${componentName}.${name}`;
  const hook = fn.getFirstAncestor(
    (ancestor) =>
      Node.isFunctionDeclaration(ancestor) && /^use[A-Z]/.test(ancestor.getName() ?? ''),
  );
  if (hook && Node.isFunctionDeclaration(hook)) return `${hook.getName()} → ${name}`;
  return name;
}

function openingSnippet(opening: Node, handler: Functionish): string {
  return `<${tagOf(opening)} …={${nameOf(handler)}}>`;
}

/** The functions an attribute value runs: a name, an arrow, `form.handleSubmit(fn)`. */
function handlersFromExpression(ctx: Ctx, expression: Node): Functionish[] {
  const found: Functionish[] = [];
  const value = unwrap(expression);
  const byName = (name: string): Functionish | undefined => {
    const scope = ctx.componentFn ?? value;
    return (
      functionOf(localVariable(scope, name)) ??
      (ctx.entryFile ? ctx.reader.functionNamed(name, ctx.entryFile) : undefined)
    );
  };
  if (Node.isIdentifier(value)) {
    const fn = byName(value.getText());
    if (fn) found.push(fn);
  } else if (Node.isArrowFunction(value) || Node.isFunctionExpression(value)) {
    found.push(value);
    // `() => handleSave(item)` — the named function is where the work is.
    for (const call of ownDescendants<CallExpression>(value, SyntaxKind.CallExpression)) {
      const callee = call.getExpression();
      if (!Node.isIdentifier(callee)) continue;
      const fn = byName(callee.getText());
      if (fn) found.push(fn);
    }
  } else if (Node.isCallExpression(value)) {
    // `form.handleSubmit(onSubmit)` — react-hook-form validates, then calls it.
    for (const arg of value.getArguments()) {
      if (Node.isIdentifier(arg)) {
        const fn = byName(arg.getText());
        if (fn) found.push(fn);
      }
    }
  }
  return found;
}

/**
 * `<ProductForm onSubmit={onSubmit} />` — find where ProductForm calls it.
 *
 * The step the graph skips: the prop is not the first code that runs. The
 * child's own `handleSubmit` runs, validates and only then calls the prop, so
 * the part of the flow that decides whether anything is sent at all lives in a
 * different component from the one the action is attributed to.
 */
function locateChild(ctx: Ctx, tag: string, event: string): void {
  if (!ctx.entryFile) return;
  const component = ctx.reader.functionNamed(tag, ctx.entryFile);
  if (!component) return;
  const params = component.getParameters();
  const first = params[0];
  if (!first) return;

  const names = new Set<string>();
  const binding = first.getNameNode();
  if (Node.isObjectBindingPattern(binding)) {
    for (const element of binding.getElements()) {
      const property = element.getPropertyNameNode()?.getText() ?? element.getName();
      if (property === event) names.add(element.getName());
    }
  } else {
    names.add(`${binding.getText()}.${event}`);
  }
  if (names.size === 0) return;

  const invocation = component
    .getDescendantsOfKind(SyntaxKind.CallExpression)
    .find((call) => names.has(call.getExpression().getText()));
  let handler: Functionish | undefined;
  if (invocation) {
    const around = nearestFunction(invocation) as Functionish | undefined;
    if (around && around !== component) handler = around;
  }

  // The element the user touches inside the child.
  let opening: Node | undefined;
  if (handler) {
    const handlerName = nameOf(handler);
    opening = jsxOpenings(component).find((candidate) => {
      if (!Node.isJsxOpeningElement(candidate) && !Node.isJsxSelfClosingElement(candidate))
        return false;
      return candidate.getAttributes().some((attr) => {
        if (!Node.isJsxAttribute(attr)) return false;
        const init = attr.getInitializer();
        const expression = init && Node.isJsxExpression(init) ? init.getExpression() : undefined;
        return (
          expression !== undefined &&
          (expression === handler || expression.getText() === handlerName)
        );
      });
    });
  } else {
    // Passed straight down: `<form onSubmit={onSubmit}>`.
    opening = jsxOpenings(component).find((candidate) => {
      if (!Node.isJsxOpeningElement(candidate) && !Node.isJsxSelfClosingElement(candidate))
        return false;
      return candidate
        .getAttributes()
        .some(
          (attr) =>
            Node.isJsxAttribute(attr) &&
            [...names].some((name) => attr.getText().includes(`{${name}}`)),
        );
    });
  }
  if (!handler && !opening) return;

  ctx.child = {
    component: tag,
    fn: component,
    ...(handler ? { handler } : {}),
    ...(opening ? { opening } : {}),
  };
  ctx.formFn = component;
  if (opening) ctx.triggerOpening = opening;
}

function locateCalls(ctx: Ctx): void {
  const { reader, graph } = ctx;
  for (const detail of ctx.apis.calls) {
    const context: CallContext = { detail, backendFns: [] };
    const site = detail.callSites[0];
    const match = site ? /^(.*):(\d+)$/.exec(site) : null;
    if (match) {
      const file = reader.file(match[1]);
      if (file) {
        const call = callAtLine(
          file,
          Number(match[2]),
          detail.client ?? detail.method.toLowerCase(),
        );
        if (call) {
          context.call = call;
          const fn = nearestFunction(call) as Functionish | undefined;
          if (fn) context.fn = fn;
          const hookCall = call.getFirstAncestor(
            (ancestor) =>
              Node.isCallExpression(ancestor) &&
              /^(useMutation|useQuery|useInfiniteQuery|useSWR|useSWRMutation|useSuspenseQuery)$/.test(
                ancestor.getExpression().getText(),
              ),
          );
          const hookFn = hookCall
            ? (nearestFunction(hookCall) as Functionish | undefined)
            : undefined;
          if (hookCall && hookFn && Node.isCallExpression(hookCall)) {
            const options = hookCall
              .getArguments()
              .find((arg) => Node.isObjectLiteralExpression(arg));
            context.hook = { name: nameOf(hookFn), fn: hookFn, ...(options ? { options } : {}) };
          }
        }
      }
    }
    if (context.fn && !ctx.front.some((entry) => entry.fn === context.fn)) {
      ctx.front.push({ name: qualified(context.fn), fn: context.fn, role: 'request' });
    }

    // The server side, in the order the flow reaches it.
    const routeStep = ctx.flow.steps.find(
      (step) =>
        step.kind === 'route' &&
        graph.edgesTo(step.nodeId, ['handled-by']).length > 0 &&
        step.label === detail.route?.method + ' ' + detail.route?.path,
    );
    const handlerSteps = ctx.flow.steps.filter(
      (step) => step.kind === 'method' && step.depth > (routeStep?.depth ?? 0),
    );
    const labels = new Set(detail.handlers.map((handler) => handler.label));
    for (const step of handlerSteps) {
      if (!labels.has(step.label) && detail.handlers.length > 0) continue;
      const file = reader.file(step.file);
      if (!file || !step.line) continue;
      const fn = functionAtLine(file, step.line);
      if (fn)
        context.backendFns.push({
          label: step.label,
          fn,
          at: { file: step.file!, line: step.line },
        });
    }
    ctx.calls.push(context);
  }
}

// ---------------------------------------------------------------------------
// Form fields
// ---------------------------------------------------------------------------

const FIELD_PATTERNS = [
  /\bvalues\.(\w+)/,
  /\bform\.(\w+)/,
  /\bset\(\s*["'`](\w+)["'`]\s*\)/,
  /\bregister\(\s*["'`](\w+)["'`]/,
  /\berr(?:or)?s?\(\s*["'`](\w+)["'`]\s*\)/,
  /\berrors\.(\w+)/,
];

/** `name` -> "Product name", required — from the JSX around each input. */
function fieldLabels(fn: Functionish): Map<string, { label?: string; required: boolean }> {
  const labels = new Map<string, { label?: string; required: boolean }>();
  // `const [phone, setPhone] = useState("")` + `<input value={phone} />`
  const stateNames = new Set(
    fn
      .getDescendantsOfKind(SyntaxKind.ArrayBindingPattern)
      .filter((binding) => /useState/.test(binding.getParent()?.getText() ?? ''))
      .map((binding) => binding.getElements()[0])
      .filter((element) => element !== undefined && Node.isBindingElement(element))
      .map((element) => (element as import('ts-morph').BindingElement).getName()),
  );
  for (const opening of jsxOpenings(fn)) {
    if (!Node.isJsxOpeningElement(opening) && !Node.isJsxSelfClosingElement(opening)) continue;
    let key: string | undefined;
    const nameAttr = attribute(opening, 'name');
    if (nameAttr && literalText(nameAttr)) key = literalText(nameAttr);
    if (!key) {
      for (const attr of opening.getAttributes()) {
        if (!Node.isJsxAttribute(attr)) continue;
        const name = attr.getNameNode().getText();
        if (
          !/^(value|checked|onChange|selected|defaultValue)$/.test(name) &&
          !attr.getText().includes('register(')
        )
          continue;
        const text = attr.getText();
        const init = attr.getInitializer();
        const bare = init && Node.isJsxExpression(init) ? init.getExpression() : undefined;
        if (name === 'value' && bare && Node.isIdentifier(bare) && stateNames.has(bare.getText())) {
          key = bare.getText();
          break;
        }
        for (const pattern of FIELD_PATTERNS) {
          const found = pattern.exec(text);
          if (found?.[1]) {
            key = found[1];
            break;
          }
        }
        if (key) break;
      }
    }
    if (!key || labels.has(key)) continue;

    let label: string | undefined;
    let required = attribute(opening, 'required') !== null;
    const own = attribute(opening, 'label');
    if (own) label = labelText(own);
    // `<FormField label="Product name" required><Input … /></FormField>`
    const self = Node.isJsxOpeningElement(opening) ? opening.getParent() : opening;
    const ancestors = self
      .getAncestors()
      .filter((ancestor) => Node.isJsxElement(ancestor))
      .slice(0, 3);
    for (const ancestor of ancestors) {
      if (label || !Node.isJsxElement(ancestor)) break;
      const parentOpening = ancestor.getOpeningElement();
      const labelAttr = attribute(parentOpening, 'label');
      if (labelAttr) {
        label = labelText(labelAttr);
        if (attribute(parentOpening, 'required') !== null) required = true;
      }
    }
    if (!label) {
      const placeholder = attribute(opening, 'placeholder');
      const aria = attribute(opening, 'aria-label');
      label = (aria && literalText(aria)) ?? undefined;
      if (!label && placeholder && literalText(placeholder))
        label = `placeholder "${literalText(placeholder)}"`;
    }
    labels.set(key, { ...(label ? { label } : {}), required });
  }
  return labels;
}

/** `"Product name"`, or the words in `{stockLabel?.label ?? "Quantity"}`. */
function labelText(node: Node): string {
  const direct = literalText(node);
  if (direct !== undefined) return direct;
  const words = node
    .getDescendantsOfKind(SyntaxKind.StringLiteral)
    .map((literal) => literal.getLiteralValue())
    .filter((value) => value.trim());
  return words.length > 0 ? words.join(' / ') : condense(node.getText(), 40);
}

interface StateEntry {
  name: string;
  setter?: string;
  initial?: string;
  keys?: Array<{ key: string; initial: string }>;
  at: SourcePoint;
}

/** `const [values, setValues] = useState(() => toFormState(product))`. */
function stateIn(ctx: Ctx, fn: Functionish): StateEntry[] {
  const entries: StateEntry[] = [];
  for (const call of ownDescendants<CallExpression>(fn, SyntaxKind.CallExpression)) {
    const callee = call.getExpression().getText();
    if (!/^(React\.)?(useState|useReducer)$/.test(callee)) continue;
    const declaration = call.getFirstAncestorByKind(SyntaxKind.VariableDeclaration);
    if (!declaration) continue;
    const binding = declaration.getNameNode();
    const names = Node.isArrayBindingPattern(binding)
      ? binding
          .getElements()
          .map((element) => (Node.isBindingElement(element) ? element.getName() : ''))
      : [binding.getText()];
    const initialArg = call.getArguments()[callee.endsWith('useReducer') ? 1 : 0];
    const entry: StateEntry = {
      name: names[0] ?? binding.getText(),
      ...(names[1] ? { setter: names[1] } : {}),
      ...(initialArg ? { initial: shortExpression(initialArg) } : {}),
      at: ctx.reader.point(call),
    };
    const object = initialArg ? objectFrom(ctx, initialArg) : undefined;
    if (object) {
      entry.keys = object.getProperties().flatMap((property) => {
        if (Node.isPropertyAssignment(property)) {
          return [
            {
              key: property.getName(),
              initial: condense(property.getInitializer()?.getText() ?? '', 50),
            },
          ];
        }
        if (Node.isShorthandPropertyAssignment(property))
          return [{ key: property.getName(), initial: property.getName() }];
        return [];
      });
    }
    entries.push(entry);
  }
  return entries;
}

/** The object literal an initializer evaluates to, through `() => f(x)` and `f(x)`. */
function objectFrom(
  ctx: Ctx,
  node: Node,
  depth = 0,
): import('ts-morph').ObjectLiteralExpression | undefined {
  if (depth > 3) return undefined;
  const value = unwrap(node);
  if (Node.isObjectLiteralExpression(value)) return value;
  if (Node.isArrowFunction(value) || Node.isFunctionExpression(value)) {
    for (const returned of returnsOf(value)) {
      const found = objectFrom(ctx, returned, depth + 1);
      if (found) return found;
    }
  }
  if (Node.isCallExpression(value)) {
    const callee = value.getExpression();
    if (Node.isIdentifier(callee)) {
      const fn = ctx.reader.functionNamed(callee.getText(), value.getSourceFile());
      if (fn) {
        for (const returned of returnsOf(fn)) {
          const found = objectFrom(ctx, returned, depth + 1);
          if (found) return found;
        }
      }
    }
  }
  return undefined;
}

const PLAIN_HOOKS =
  /^(React\.)?(useState|useReducer|useMemo|useCallback|useRef|useEffect|useLayoutEffect|useId|useTransition|useDeferredValue|useImperativeHandle|useInsertionEffect)$/;

interface HookUse {
  name: string;
  binding: string;
  kind: 'context' | 'query' | 'mutation' | 'store' | 'router' | 'form' | 'cache' | 'hook';
  endpoints: string[];
  at: SourcePoint;
}

/** The custom and library hooks a component calls, and what each gives it. */
function hooksIn(ctx: Ctx, fn: Functionish): HookUse[] {
  const uses: HookUse[] = [];
  for (const call of ownDescendants<CallExpression>(fn, SyntaxKind.CallExpression)) {
    const callee = call.getExpression().getText();
    if (!/^use[A-Z]/.test(callee) || PLAIN_HOOKS.test(callee)) continue;
    const declaration = call.getFirstAncestorByKind(SyntaxKind.VariableDeclaration);
    const binding = declaration
      ? condense(declaration.getNameNode().getText(), 50)
      : '(result unused)';
    const resolved = ctx.reader.functionNamed(callee, call.getSourceFile());
    const body = resolved?.getText() ?? '';
    let kind: HookUse['kind'] = 'hook';
    if (/^use(Router|Params|SearchParams|Pathname|Navigate|Location|Match)$/.test(callee))
      kind = 'router';
    else if (/^use(Form|FormContext|Formik|Controller)$/.test(callee)) kind = 'form';
    else if (callee === 'useQueryClient' || callee === 'useSWRConfig') kind = 'cache';
    else if (
      /^use(Selector|Dispatch|Store|AppSelector|AppDispatch|Atom|AtomValue|Recoil\w*)$/.test(callee)
    )
      kind = 'store';
    else if (/\buseMutation\b|\buseSWRMutation\b/.test(body)) kind = 'mutation';
    else if (/\buse(Query|InfiniteQuery|SuspenseQuery|SWR)\b/.test(body)) kind = 'query';
    else if (/\buseContext\b|\buse\(\s*\w+Context/.test(body)) kind = 'context';
    else if (/\b(create|useStore)\b/.test(body) && /zustand|getState/.test(body)) kind = 'store';
    else if (!resolved) kind = 'context';

    const endpoints: string[] = [];
    if (resolved) {
      const hookId = `hook:${ctx.reader.relative(resolved.getSourceFile())}#${callee}`;
      for (const request of ctx.graph.successors(hookId, ['requests']))
        endpoints.push(request.label);
    }
    uses.push({ name: callee, binding, kind, endpoints, at: ctx.reader.point(call) });
  }
  return uses;
}

// ---------------------------------------------------------------------------
// Frontend validation
// ---------------------------------------------------------------------------

function collectFrontSchemas(ctx: Ctx): void {
  const scopes: Node[] = ctx.front
    .filter((entry) => entry.role !== 'request')
    .map((entry) => entry.fn);
  // react-hook-form resolvers are declared in the component body.
  if (ctx.formFn) scopes.push(ctx.formFn);
  const seen = new Set<string>();
  for (const scope of scopes) {
    for (const found of schemaCallIn(scope)) {
      if (seen.has(found.schema)) continue;
      // The component body holds every handler; only its resolver belongs to this action.
      if (
        scope === ctx.formFn &&
        !found.method.endsWith('Resolver') &&
        !ctx.front.some((entry) => entry.fn.containsRange(found.call.getPos(), found.call.getEnd()))
      )
        continue;
      const facts = readSchema(ctx.reader, found.schema, found.call.getSourceFile());
      if (!facts) continue;
      seen.add(found.schema);
      ctx.frontSchemas.push({ facts, method: found.method, call: found.call });
    }
  }
}

/** `if (!parsed.success) { setErrors(next); return; }` — a check that stops the flow. */
function stoppingChecks(
  fn: Functionish,
): Array<{ condition: string; does: string[]; node: IfStatement }> {
  const checks: Array<{ condition: string; does: string[]; node: IfStatement }> = [];
  for (const statement of ownDescendants<IfStatement>(fn, SyntaxKind.IfStatement)) {
    const then = statement.getThenStatement();
    if (!endsFunction(then)) continue;
    const does = directCalls(then).map((call) => shortCall(call));
    const returned = returnIn(then);
    if (returned) does.push(`returns ${shortExpression(returned)}`);
    if (throwIn(then)) does.push('throws');
    checks.push({
      condition: condense(statement.getExpression().getText(), 90),
      does,
      node: statement,
    });
  }
  return checks;
}

interface Confirmation {
  /** `confirmDelete({ … })`, as written. */
  call: string;
  title?: string;
  /** The button that goes ahead: `"Yes, delete it"`. */
  button: string;
  /** The body text under the title. */
  message?: string;
  /** The button that backs out. */
  cancel: string;
  at: SourcePoint;
  /** The check that stops the flow when the user cancels: `!ok`. */
  condition: string;
  node: IfStatement;
  in: string;
}

/** `window.confirm`, `Swal.fire`, `confirmDelete`, `useConfirm()`'s `confirm`. */
const CONFIRM_CALLEE = /^(window\.)?confirm$|(^|\.)\w*[cC]onfirm\w*$|^(\w*[sS]wal)(\.fire)?$/;

/**
 * `const ok = await confirmDelete(); if (!ok) return;` — a dialog the user has
 * to accept. It stops the flow like a validation check, but nothing is being
 * validated: the user is being asked.
 */
function confirmationsOf(ctx: Ctx): Confirmation[] {
  if (ctx.confirms) return ctx.confirms;
  const found: Confirmation[] = [];
  for (const entry of ctx.front) {
    if (entry.role === 'request') continue;
    for (const check of stoppingChecks(entry.fn)) {
      const condition = check.node.getExpression();
      const candidates: Node[] = [condition, ...condition.getDescendants()].flatMap((node) => {
        if (Node.isCallExpression(node)) return [node];
        if (!Node.isIdentifier(node)) return [];
        const declaration = localVariable(entry.fn, node.getText());
        const init =
          declaration && Node.isVariableDeclaration(declaration)
            ? declaration.getInitializer()
            : undefined;
        return init ? [unwrap(init)] : [];
      });
      const call = candidates.find(
        (node): node is CallExpression =>
          Node.isCallExpression(node) && CONFIRM_CALLEE.test(node.getExpression().getText()),
      );
      if (!call) continue;
      found.push({
        call: shortCall(call),
        ...confirmTexts(ctx, call),
        at: ctx.reader.point(call),
        condition: check.condition,
        node: check.node,
        in: shortName(entry.name),
      });
    }
  }
  ctx.confirms = found;
  return found;
}

/** The dialog's title and confirm button, from the call or the helper's defaults. */
function confirmTexts(
  ctx: Ctx,
  call: CallExpression,
): { title?: string; message?: string; button: string; cancel: string } {
  const callee = call.getExpression().getText();
  const fromObject = (scope: Node | undefined, names: string[]): string | undefined => {
    if (!scope) return undefined;
    for (const property of scope.getDescendantsOfKind(SyntaxKind.PropertyAssignment)) {
      if (!names.includes(property.getName())) continue;
      let value = property.getInitializer();
      // `options?.confirmText ?? "Yes, delete it"`: the default is the literal.
      while (value && Node.isBinaryExpression(value)) value = value.getRight();
      const text = literalText(value);
      if (text !== undefined) return text;
    }
    return undefined;
  };
  const args = call.getArguments()[0];
  const helper = Node.isIdentifier(call.getExpression())
    ? ctx.reader.functionNamed(callee, call.getSourceFile())
    : undefined;
  const title =
    fromObject(args, ['title']) ??
    (args && !Node.isObjectLiteralExpression(args) ? literalText(args) : undefined) ??
    fromObject(helper, ['title']);
  const messageNames = ['text', 'message', 'description', 'content', 'html'];
  const message = fromObject(args, messageNames) ?? fromObject(helper, messageNames);
  const buttonNames = ['confirmButtonText', 'confirmText', 'okText', 'confirmLabel'];
  const button = fromObject(args, buttonNames) ?? fromObject(helper, buttonNames) ?? 'OK';
  const cancelNames = ['cancelButtonText', 'cancelText', 'cancelLabel'];
  const cancel = fromObject(args, cancelNames) ?? fromObject(helper, cancelNames) ?? 'Cancel';
  return { ...(title ? { title } : {}), ...(message ? { message } : {}), button, cancel };
}

/** The value a branch returns — the branch itself when it is `if (x) return y;`. */
function returnIn(branch: Node): Node | undefined {
  if (Node.isReturnStatement(branch)) return branch.getExpression();
  return branch
    .getDescendantsOfKind(SyntaxKind.ReturnStatement)
    .find((statement) => nearestFunction(statement) === nearestFunction(branch))
    ?.getExpression();
}

function throwIn(branch: Node): Node | undefined {
  if (Node.isThrowStatement(branch)) return branch.getExpression();
  return branch
    .getDescendantsOfKind(SyntaxKind.ThrowStatement)
    .find((statement) => nearestFunction(statement) === nearestFunction(branch))
    ?.getExpression();
}

/** Calls a branch makes as its own steps: statements, `const x = await f()`, `return f()`. */
function branchCalls(branch: Node): CallExpression[] {
  const statements = Node.isBlock(branch) ? branch.getStatements() : [branch];
  return statements.flatMap((statement) => {
    const expressions: Array<Node | undefined> = Node.isVariableStatement(statement)
      ? statement.getDeclarations().map((declaration) => declaration.getInitializer())
      : Node.isExpressionStatement(statement) || Node.isReturnStatement(statement)
        ? [statement.getExpression()]
        : [];
    return expressions
      .map((expression) => (expression ? unwrap(expression) : undefined))
      .filter(
        (expression): expression is CallExpression =>
          expression !== undefined && Node.isCallExpression(expression),
      );
  });
}

/** Calls that are statements of their own in a branch: `setErrors(next);`. */
function directCalls(branch: Node): CallExpression[] {
  const statements = Node.isBlock(branch) ? branch.getStatements() : [branch];
  return statements.flatMap((statement) => {
    if (!Node.isExpressionStatement(statement)) return [];
    const expression = unwrap(statement.getExpression());
    return Node.isCallExpression(expression) ? [expression] : [];
  });
}

function ownCalls(node: Node, fn: Node): CallExpression[] {
  return node
    .getDescendantsOfKind(SyntaxKind.CallExpression)
    .filter((call) => nearestFunction(call) === fn || nearestFunction(call) === undefined)
    .filter(
      (call) =>
        !call.getFirstAncestor(
          (ancestor) =>
            Node.isCallExpression(ancestor) &&
            ancestor !== call &&
            node.containsRange(ancestor.getPos(), ancestor.getEnd()),
        ),
    );
}

/** A schema as a table: one row per field, with its label, rules and messages. */
function schemaTable(facts: SchemaFacts, labels: Ctx['labels']): DocTable {
  return {
    columns: ['Field', 'Label', 'Required', 'Checks', 'Error message'],
    rows: facts.fields.map((field) => ({
      cells: [
        `\`${field.name}\``,
        labels.get(field.name)?.label ?? '',
        field.required ? 'yes' : 'no',
        [
          ...new Set([
            ...(field.type ? [field.type] : []),
            ...field.rules.filter((rule) => rule !== 'optional' && rule !== 'or blank'),
          ]),
        ].join(', '),
        field.messages.map((message) => `"${message}"`).join(', '),
      ],
    })),
  };
}

// ---------------------------------------------------------------------------
// Tracing a value back to where it came from
// ---------------------------------------------------------------------------

interface Trace {
  steps: DocLine[];
  /** Where the walk stopped, when it stopped at an object literal. */
  object?: { node: import('ts-morph').ObjectLiteralExpression; fn: Functionish };
  /** The schema that validated and reshaped it on the way, if any. */
  schema?: SchemaFacts;
  /** State the value finally comes from. */
  state?: string;
}

/**
 * Follow a request body back through the calls that handed it along.
 *
 * `mutationFn(input)` ← `create.mutate(values)` ← `onSubmit(parsed.data)` ←
 * `productSchema.safeParse(values)` ← `useState(...)`. Each hop is one of the
 * handlers already in the chain, so the walk only ever looks where the flow
 * goes, and stops at the first thing it cannot follow.
 */
function traceValue(ctx: Ctx, start: Node, startFn: Functionish | undefined): Trace {
  const trace: Trace = { steps: [] };
  let expression: Node = start;
  let fn: Functionish | undefined = startFn;
  const frontFns = ctx.front.map((entry) => entry.fn);

  for (let hops = 0; hops < 10 && fn; hops += 1) {
    const value = unwrap(expression);

    // `parsed.data` where `parsed = schema.safeParse(x)`.
    if (Node.isPropertyAccessExpression(value) && value.getName() === 'data') {
      const receiver = unwrap(value.getExpression());
      const declaration = Node.isIdentifier(receiver)
        ? localVariable(fn, receiver.getText())
        : undefined;
      const init =
        declaration && Node.isVariableDeclaration(declaration)
          ? declaration.getInitializer()
          : undefined;
      const schemaCall = init
        ? schemaCallIn(init.getParent() ?? init).find((found) => found.call === unwrap(init))
        : undefined;
      if (schemaCall && init) {
        const facts = readSchema(ctx.reader, schemaCall.schema, schemaCall.call.getSourceFile());
        if (facts) trace.schema = facts;
        trace.steps.push({
          text: `\`${value.getText()}\` is the output of \`${shortCall(schemaCall.call)}\` — validated and cleaned by \`${schemaCall.schema}\``,
          at: ctx.reader.point(schemaCall.call),
        });
        const arg = schemaCall.call.getArguments()[0];
        if (!arg) break;
        expression = arg;
        continue;
      }
    }

    // `values.name` — a field of some state.
    if (Node.isPropertyAccessExpression(value)) {
      const root = value.getText().split(/[.?[]/)[0] ?? '';
      const state = stateNamed(ctx, fn, root);
      if (state) {
        trace.state = root;
        trace.steps.push({ text: `\`${value.getText()}\` — from state \`${root}\``, at: state });
        break;
      }
      // `input.name` where `input` was passed in: follow `input`, then pick `name`.
      const receiver = unwrap(value.getExpression());
      const index = Node.isIdentifier(receiver)
        ? fn.getParameters().findIndex((param) => param.getName() === receiver.getText())
        : -1;
      const caller = index >= 0 ? callerOf(ctx, fn, frontFns) : undefined;
      const arg = caller?.call.getArguments()[index];
      const object = arg ? unwrap(arg) : undefined;
      const property =
        object && Node.isObjectLiteralExpression(object)
          ? object.getProperty(value.getName())
          : undefined;
      const next =
        property && Node.isPropertyAssignment(property)
          ? property.getInitializer()
          : property && Node.isShorthandPropertyAssignment(property)
            ? property.getNameNode()
            : undefined;
      if (caller && next) {
        trace.steps.push({
          text: `\`${value.getText()}\` comes from \`${shortCall(caller.call)}\` in \`${qualified(caller.fn)}\``,
          at: ctx.reader.point(caller.call),
        });
        expression = next;
        fn = caller.fn;
        continue;
      }
      trace.steps.push({ text: `\`${value.getText()}\``, tone: 'muted' });
      break;
    }

    if (!Node.isIdentifier(value)) {
      trace.steps.push({
        text: `built as \`${condense(value.getText(), 70)}\``,
        at: ctx.reader.point(value),
      });
      if (Node.isObjectLiteralExpression(value)) trace.object = { node: value, fn };
      break;
    }
    const name = value.getText();

    const state = stateNamed(ctx, fn, name);
    if (state) {
      trace.state = name;
      trace.steps.push({ text: `\`${name}\` — the form's state (\`useState\`)`, at: state });
      break;
    }

    // A parameter: find who passed it in.
    const params = fn.getParameters();
    const index = params.findIndex((param) => {
      const binding = param.getNameNode();
      if (Node.isIdentifier(binding)) return binding.getText() === name;
      return binding
        .getDescendantsOfKind(SyntaxKind.BindingElement)
        .some((element) => element.getName() === name);
    });
    if (index >= 0) {
      const param = params[index]!;
      const destructured = !Node.isIdentifier(param.getNameNode());
      const caller = callerOf(ctx, fn, frontFns);
      if (!caller) {
        trace.steps.push({
          text: `\`${name}\` — a parameter of \`${nameOf(fn)}\`; the caller could not be followed`,
          tone: 'muted',
        });
        break;
      }
      let arg: Node | undefined = caller.call.getArguments()[index];
      if (arg && destructured) {
        const object = unwrap(arg);
        if (Node.isObjectLiteralExpression(object)) {
          const property = object.getProperty(name);
          arg =
            property && Node.isPropertyAssignment(property)
              ? property.getInitializer()
              : property && Node.isShorthandPropertyAssignment(property)
                ? property.getNameNode()
                : undefined;
        }
      }
      trace.steps.push({
        text: `\`${nameOf(fn)}\` receives it from \`${shortCall(caller.call)}\` in \`${qualified(caller.fn)}\``,
        at: ctx.reader.point(caller.call),
      });
      if (!arg) break;
      expression = arg;
      fn = caller.fn;
      continue;
    }

    // A local: follow its initializer.
    const declaration = localVariable(fn, name);
    if (declaration && Node.isVariableDeclaration(declaration)) {
      const init = declaration.getInitializer();
      if (!init) break;
      trace.steps.push({
        text: `\`const ${condense(declaration.getText(), 80)}\``,
        at: ctx.reader.point(declaration),
      });
      if (Node.isObjectLiteralExpression(unwrap(init))) {
        trace.object = { node: unwrap(init) as import('ts-morph').ObjectLiteralExpression, fn };
        break;
      }
      expression = init;
      continue;
    }
    trace.steps.push({ text: `\`${name}\``, tone: 'muted' });
    break;
  }
  return trace;
}

function stateNamed(ctx: Ctx, fn: Functionish, name: string): SourcePoint | undefined {
  const component = componentOf(fn) ?? fn;
  const entry = stateIn(ctx, component).find((candidate) => candidate.name === name);
  return entry?.at;
}

/** The call, among the chain's functions, that invokes `fn`. */
function callerOf(
  ctx: Ctx,
  fn: Functionish,
  candidates: Functionish[],
): { call: CallExpression; fn: Functionish } | undefined {
  const name = nameOf(fn);

  // `mutationFn` inside `useCreateProduct` is invoked by `create.mutate(...)`.
  const hookCall = fn.getFirstAncestor(
    (ancestor) =>
      Node.isCallExpression(ancestor) &&
      /^(useMutation|useSWRMutation)$/.test(ancestor.getExpression().getText()),
  );
  const hookFn = hookCall ? (nearestFunction(hookCall) as Functionish | undefined) : undefined;
  if (hookFn) {
    const hookName = nameOf(hookFn);
    for (const candidate of candidates) {
      for (const call of candidate.getDescendantsOfKind(SyntaxKind.CallExpression)) {
        const callee = call.getExpression();
        if (!Node.isPropertyAccessExpression(callee)) continue;
        if (!/^(mutate|mutateAsync|trigger)$/.test(callee.getName())) continue;
        const receiver = callee.getExpression().getText();
        const declaration = localVariable(candidate, receiver);
        const init =
          declaration && Node.isVariableDeclaration(declaration)
            ? declaration.getInitializer()
            : undefined;
        if (init && init.getText().startsWith(`${hookName}(`)) return { call, fn: candidate };
      }
    }
  }

  // The entry handler, handed to a child as a prop and called there.
  if (
    ctx.child?.handler &&
    ctx.front.some((entry) => entry.fn === fn && entry.role === 'handler')
  ) {
    const event = ctx.flow.event ?? '';
    const invocation = ctx.child.handler
      .getDescendantsOfKind(SyntaxKind.CallExpression)
      .find((call) => {
        const text = call.getExpression().getText();
        return text === event || text.endsWith(`.${event}`);
      });
    if (invocation) return { call: invocation, fn: ctx.child.handler };
  }

  // A plain function called by name.
  for (const candidate of candidates) {
    if (candidate === fn) continue;
    const call = candidate
      .getDescendantsOfKind(SyntaxKind.CallExpression)
      .find(
        (found) =>
          found.getExpression().getText() === name ||
          found.getExpression().getText().endsWith(`.${name}`),
      );
    if (call) return { call, fn: candidate };
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Request details
// ---------------------------------------------------------------------------

interface HeaderRow {
  name: string;
  value: string;
  setBy: string;
  when?: string;
  at: SourcePoint;
}

interface ClientFacts {
  name: string;
  baseURL?: string;
  headers: HeaderRow[];
  responseInterceptors: DocLine[];
  at?: SourcePoint;
}

/** `apiClient` -> its baseURL, default headers and interceptors. */
function clientFacts(ctx: Ctx, call: CallExpression): ClientFacts | undefined {
  const callee = call.getExpression();
  const receiver = Node.isPropertyAccessExpression(callee)
    ? unwrap(callee.getExpression())
    : undefined;
  const name =
    receiver && Node.isIdentifier(receiver)
      ? receiver.getText()
      : Node.isIdentifier(callee)
        ? callee.getText()
        : undefined;
  if (!name) return undefined;
  const facts: ClientFacts = { name, headers: [], responseInterceptors: [] };

  if (name === 'fetch') {
    const init = call.getArguments()[1];
    const object = init ? unwrap(init) : undefined;
    if (object && Node.isObjectLiteralExpression(object))
      headerLines(ctx, object, facts.headers, 'this call');
    return facts;
  }

  const declaration = ctx.reader.declaration(name, call.getSourceFile());
  if (!declaration) return facts;
  facts.at = ctx.reader.point(declaration);

  if (Node.isVariableDeclaration(declaration)) {
    const init = declaration.getInitializer();
    const created = init ? unwrap(init) : undefined;
    if (
      created &&
      Node.isCallExpression(created) &&
      /\.create$/.test(created.getExpression().getText())
    ) {
      const options = created.getArguments()[0];
      if (options && Node.isObjectLiteralExpression(options)) {
        const base = options.getProperty('baseURL');
        if (base && Node.isPropertyAssignment(base)) {
          facts.baseURL =
            literalText(base.getInitializer()) ??
            condense(base.getInitializer()?.getText() ?? '', 50);
        }
        headerLines(ctx, options, facts.headers, 'client default');
      }
    }
  } else {
    // A request wrapper function: read the headers it sets.
    const fn = functionOf(declaration);
    for (const object of fn?.getDescendantsOfKind(SyntaxKind.ObjectLiteralExpression) ?? []) {
      if (object.getProperty('headers')) headerLines(ctx, object, facts.headers, `\`${name}\``);
    }
  }

  // `apiClient.interceptors.request.use(fn)` anywhere in the same file.
  const file = declaration.getSourceFile();
  for (const use of file.getDescendantsOfKind(SyntaxKind.CallExpression)) {
    const text = use.getExpression().getText();
    if (text === `${name}.interceptors.request.use`) {
      const handler = functionOf(use.getArguments()[0]);
      if (!handler) continue;
      for (const assignment of handler.getDescendantsOfKind(SyntaxKind.BinaryExpression)) {
        if (assignment.getOperatorToken().getKind() !== SyntaxKind.EqualsToken) continue;
        const left = assignment.getLeft().getText();
        const header = /headers(?:\.(\w[\w-]*)|\[\s*["'`]([^"'`]+)["'`]\s*\])/.exec(left);
        if (!header) continue;
        const guard = assignment.getFirstAncestorByKind(SyntaxKind.IfStatement);
        facts.headers.push({
          name: header[1] ?? header[2] ?? '',
          value: condense(assignment.getRight().getText(), 50),
          setBy: 'request interceptor',
          ...(guard && handler.containsRange(guard.getPos(), guard.getEnd())
            ? { when: condense(guard.getExpression().getText(), 40) }
            : {}),
          at: ctx.reader.point(assignment),
        });
      }
    }
    if (text === `${name}.interceptors.response.use`) {
      const [success, failure] = use.getArguments();
      const onError = functionOf(failure);
      if (onError) {
        for (const statement of ownDescendants<IfStatement>(onError, SyntaxKind.IfStatement)) {
          const does = branchCalls(statement.getThenStatement())
            .map((inner) => shortCall(inner))
            .slice(0, 4);
          facts.responseInterceptors.push({
            text: `On an error response, if \`${condense(statement.getExpression().getText(), 80)}\`${does.length ? ` → ${does.map((d) => `\`${d}\``).join(', ')}` : ''}`,
            at: ctx.reader.point(statement),
          });
        }
        if (facts.responseInterceptors.length === 0) {
          facts.responseInterceptors.push({
            text: `Every error response passes through \`${nameOf(onError)}\` first`,
            at: ctx.reader.point(onError),
          });
        }
      }
      const onSuccess = functionOf(success);
      if (onSuccess && onSuccess.getText().replace(/\s/g, '') !== '(response)=>response') {
        facts.responseInterceptors.push({
          text: `Every successful response passes through the success interceptor`,
          at: ctx.reader.point(onSuccess),
        });
      }
    }
  }
  return facts;
}

function headerLines(
  ctx: Ctx,
  options: import('ts-morph').ObjectLiteralExpression,
  into: HeaderRow[],
  setBy: string,
): void {
  const property = options.getProperty('headers');
  if (!property || !Node.isPropertyAssignment(property)) return;
  const value = property.getInitializer();
  const object = value ? unwrap(value) : undefined;
  if (object && Node.isObjectLiteralExpression(object)) {
    for (const entry of object.getProperties()) {
      if (Node.isPropertyAssignment(entry)) {
        into.push({
          name: entry.getName().replace(/^['"]|['"]$/g, ''),
          value: condense(entry.getInitializer()?.getText() ?? '', 50),
          setBy,
          at: ctx.reader.point(entry),
        });
      } else if (Node.isSpreadAssignment(entry)) {
        into.push({
          name: `...${condense(entry.getExpression().getText(), 40)}`,
          value: '(every key of it)',
          setBy,
          at: ctx.reader.point(entry),
        });
      }
    }
  } else if (value) {
    into.push({
      name: '(computed)',
      value: condense(value.getText(), 60),
      setBy,
      at: ctx.reader.point(value),
    });
  }
}

/** The argument that carries the body, by client and method. */
function bodyArgument(call: CallExpression, method: string): Node | undefined {
  const args = call.getArguments();
  const callee = call.getExpression().getText();
  if (callee === 'fetch' || callee.endsWith('.fetch')) {
    const init = args[1] ? unwrap(args[1]) : undefined;
    if (init && Node.isObjectLiteralExpression(init)) {
      const body = init.getProperty('body');
      if (body && Node.isPropertyAssignment(body)) {
        const value = body.getInitializer();
        if (
          value &&
          Node.isCallExpression(value) &&
          value.getExpression().getText() === 'JSON.stringify'
        )
          return value.getArguments()[0];
        return value;
      }
    }
    return undefined;
  }
  if (!/^(POST|PUT|PATCH)$/i.test(method)) return undefined;
  // `axios({ method, url, data })`
  const first = args[0] ? unwrap(args[0]) : undefined;
  if (
    first &&
    Node.isObjectLiteralExpression(first) &&
    (first.getProperty('data') || first.getProperty('body'))
  ) {
    const data = first.getProperty('data') ?? first.getProperty('body');
    return data && Node.isPropertyAssignment(data) ? data.getInitializer() : undefined;
  }
  return args[1];
}

/** `${id}` in the URL -> `id`, with where it comes from. */
function pathParams(ctx: Ctx, context: CallContext): DocLine[] {
  const lines: DocLine[] = [];
  const url = context.call?.getArguments()[0];
  if (url && Node.isTemplateExpression(unwrap(url))) {
    const template = unwrap(url) as import('ts-morph').TemplateExpression;
    for (const span of template.getTemplateSpans()) {
      const expression = span.getExpression();
      const trace = traceValue(ctx, expression, context.fn);
      const origin = trace.steps.length > 1 ? trace.steps.at(-1)!.text : undefined;
      lines.push({
        text: `\`${condense(expression.getText(), 40)}\` fills a path segment${origin ? ` — ${origin}` : ''}`,
        at: ctx.reader.point(expression),
      });
    }
  }
  const declared = (context.detail.route?.path ?? '')
    .split('/')
    .filter((segment) => segment.startsWith(':') || segment.startsWith('['));
  if (lines.length === 0 && declared.length > 0) {
    for (const segment of declared) lines.push({ text: `\`${segment}\` in the route path` });
  }
  return lines;
}

/** `params: { page, search }` passed in the request config. */
function configQueryKeys(call: CallExpression | undefined): string[] {
  if (!call) return [];
  for (const arg of call.getArguments()) {
    const object = unwrap(arg);
    if (!Node.isObjectLiteralExpression(object)) continue;
    const params = object.getProperty('params');
    if (params && Node.isPropertyAssignment(params)) {
      const value = params.getInitializer();
      if (value && Node.isObjectLiteralExpression(unwrap(value)))
        return objectKeysOf(unwrap(value) as import('ts-morph').ObjectLiteralExpression);
      if (value) return [`…${condense(value.getText(), 30)}`];
    }
  }
  return [];
}

/** `apiClient.post<{ product: Product }>(…)` -> the declared response type. */
function declaredResponseType(call: CallExpression | undefined): string | undefined {
  const typeArg = call?.getTypeArguments()[0];
  return typeArg ? condense(typeArg.getText(), 120) : undefined;
}

// ---------------------------------------------------------------------------
// Backend
// ---------------------------------------------------------------------------

interface GuardExit {
  status?: number;
  statuses: number[];
  message?: string;
  condition?: string;
  at: SourcePoint;
}

interface GuardFacts {
  name: string;
  call: string;
  exits: GuardExit[];
  at: SourcePoint;
  declaredAt?: SourcePoint;
}

/**
 * The calls a route handler makes before doing any work, that end it early.
 *
 * `const ctx = await requireShop(request); if ("error" in ctx) return ctx.error;`
 * is how file routes spell a guard — there is no decorator to find, only the
 * shape: a call, then an early return that depends on its result.
 */
function guardsIn(ctx: Ctx, handler: Functionish): GuardFacts[] {
  const guards: GuardFacts[] = [];
  const statements = bodyStatements(handler);
  const bindings = new Map<string, CallExpression>();

  for (const statement of statements) {
    if (Node.isVariableStatement(statement)) {
      for (const declaration of statement.getDeclarations()) {
        const init = declaration.getInitializer();
        const call = init ? unwrap(init) : undefined;
        if (!call || !Node.isCallExpression(call)) continue;
        if (!Node.isIdentifier(call.getExpression())) continue;
        const binding = declaration.getNameNode();
        const names = Node.isIdentifier(binding)
          ? [binding.getText()]
          : binding
              .getDescendantsOfKind(SyntaxKind.BindingElement)
              .map((element) => element.getName());
        for (const name of names) bindings.set(name, call);
      }
      continue;
    }
    if (!Node.isIfStatement(statement) || !endsFunction(statement.getThenStatement())) continue;
    const condition = statement.getExpression();
    const text = condition.getText();

    let call: CallExpression | undefined;
    for (const [name, candidate] of bindings) {
      if (new RegExp(`\\b${name}\\b`).test(text)) call = candidate;
    }
    call ??= condition
      .getDescendantsOfKind(SyntaxKind.CallExpression)
      .find((inner) => Node.isIdentifier(inner.getExpression()));
    if (!call) continue;
    const name = call.getExpression().getText();
    // Parsing the body and schema checks are validation, not guards.
    if (/^(safeParse|parse|validate)/.test(name) || name === 'json') continue;
    if (guards.some((guard) => guard.name === name)) continue;

    const fn = ctx.reader.functionNamed(name, call.getSourceFile());
    const exits: GuardExit[] = [];
    if (fn) {
      for (const returned of ownDescendants<import('ts-morph').ReturnStatement>(
        fn,
        SyntaxKind.ReturnStatement,
      )) {
        const expression = returned.getExpression();
        if (!expression) continue;
        let target: Node = unwrap(expression);
        if (Node.isObjectLiteralExpression(target)) {
          const error = target.getProperty('error');
          if (!error || !Node.isPropertyAssignment(error)) continue;
          target = error.getInitializer() ?? target;
        }
        const status = statusOf(ctx.reader, target);
        if (!status || status.statuses.length === 0) continue;
        const guard = returned.getFirstAncestorByKind(SyntaxKind.IfStatement);
        const inCatch = returned.getFirstAncestorByKind(SyntaxKind.CatchClause);
        exits.push({
          statuses: status.statuses,
          ...(status.statuses[0] !== undefined ? { status: status.statuses[0] } : {}),
          ...(status.message ? { message: status.message } : {}),
          ...(inCatch && fn.containsRange(inCatch.getPos(), inCatch.getEnd())
            ? { condition: '(the check itself throws)' }
            : guard && fn.containsRange(guard.getPos(), guard.getEnd())
              ? { condition: condense(guard.getExpression().getText(), 60) }
              : {}),
          at: ctx.reader.point(returned),
        });
      }
    }
    if (exits.length === 0) {
      const returned = returnIn(statement.getThenStatement());
      const status = returned ? statusOf(ctx.reader, returned) : undefined;
      if (status) {
        exits.push({
          statuses: status.statuses,
          ...(status.statuses[0] !== undefined ? { status: status.statuses[0] } : {}),
          ...(status.message ? { message: status.message } : {}),
          condition: condense(text, 60),
          at: ctx.reader.point(statement),
        });
      }
    }
    guards.push({
      name,
      call: shortCall(call),
      exits,
      at: ctx.reader.point(call),
      ...(fn ? { declaredAt: ctx.reader.point(fn) } : {}),
    });
  }
  return guards;
}

function classifyExit(
  exit: GuardExit,
  guardName: string,
): 'Authentication' | 'Authorization' | 'Other checks' {
  if (exit.status === 401) return 'Authentication';
  if (exit.status === 403) return 'Authorization';
  if (exit.status === undefined && /auth|token|session|login/i.test(guardName))
    return 'Authentication';
  return 'Other checks';
}

function classifyMiddleware(
  name: string,
  role: string,
): 'Authentication' | 'Authorization' | 'Other checks' {
  if (/role|permission|polic|access|admin|owner|acl|casl/i.test(name)) return 'Authorization';
  if (/auth|jwt|token|session|passport|login/i.test(name)) return 'Authentication';
  void role;
  return 'Other checks';
}

/** A condition as code, or as words when it is a description rather than code. */
function conditionText(condition: string | undefined): string {
  if (!condition) return '';
  return condition.startsWith('(') ? `_${condition.slice(1, -1)}_` : `\`${condition}\``;
}

function exitText(exit: GuardExit): string {
  const status = exit.statuses.length > 0 ? exit.statuses.join(' or ') : '?';
  return `${exit.condition ? `${conditionText(exit.condition)} → ` : ''}**${status}**${exit.message ? ` "${exit.message}"` : ''}`;
}

/** The validation a handler runs on its input, and what it answers when it fails. */
function backendSchemaChecks(
  ctx: Ctx,
  handler: Functionish,
): Array<{ facts?: SchemaFacts; schema: string; call: CallExpression; exit?: GuardExit }> {
  const found: Array<{
    facts?: SchemaFacts;
    schema: string;
    call: CallExpression;
    exit?: GuardExit;
  }> = [];
  for (const entry of schemaCallIn(handler)) {
    if (nearestFunction(entry.call) !== handler) continue;
    const facts = readSchema(ctx.reader, entry.schema, entry.call.getSourceFile());
    const declaration = entry.call.getFirstAncestorByKind(SyntaxKind.VariableDeclaration);
    const name = declaration?.getName();
    let exit: GuardExit | undefined;
    for (const statement of ownDescendants<IfStatement>(handler, SyntaxKind.IfStatement)) {
      if (!name || !statement.getExpression().getText().includes(name)) continue;
      const returned = returnIn(statement.getThenStatement());
      const thrown = throwIn(statement.getThenStatement());
      const target = returned ?? thrown;
      const status = target ? statusOf(ctx.reader, target) : undefined;
      if (status) {
        exit = {
          statuses: status.statuses,
          ...(status.statuses[0] !== undefined ? { status: status.statuses[0] } : {}),
          ...(status.message ? { message: status.message } : {}),
          condition: condense(statement.getExpression().getText(), 60),
          at: ctx.reader.point(statement),
        };
      }
      break;
    }
    // `schema.parse(x)` throws instead of returning.
    if (!exit && /^parse/.test(entry.method)) {
      exit = {
        statuses: [],
        condition: `\`${entry.schema}.${entry.method}\` throws`,
        at: ctx.reader.point(entry.call),
      };
    }
    found.push({
      ...(facts ? { facts } : {}),
      schema: entry.schema,
      call: entry.call,
      ...(exit ? { exit } : {}),
    });
  }
  return found;
}

/** Early returns in a handler that are neither guards nor schema checks. */
function businessExits(ctx: Ctx, fn: Functionish, skip: Set<IfStatement>): GuardExit[] {
  const exits: GuardExit[] = [];
  for (const statement of ownDescendants<IfStatement>(fn, SyntaxKind.IfStatement)) {
    if (skip.has(statement)) continue;
    const then = statement.getThenStatement();
    const returned = returnIn(then);
    const thrown = throwIn(then);
    const target = thrown ?? returned;
    if (!target) continue;
    const status = statusOf(ctx.reader, target);
    const message =
      status?.message ??
      (thrown && Node.isNewExpression(unwrap(thrown))
        ? literalText((unwrap(thrown) as import('ts-morph').NewExpression).getArguments()[0])
        : undefined);
    if (!status && !thrown) continue;
    exits.push({
      statuses: status?.statuses ?? [],
      ...(status?.statuses[0] !== undefined ? { status: status.statuses[0] } : {}),
      ...(message ? { message } : {}),
      condition: condense(statement.getExpression().getText(), 70),
      at: ctx.reader.point(statement),
    });
  }
  return exits;
}

/** The conditions under which a call inside `fn` runs. */
function conditionsFor(node: Node, fn: Node): string[] {
  const conditions: string[] = [];
  let current: Node | undefined = node;
  while (current && current !== fn) {
    const parent: Node | undefined = current.getParent();
    if (!parent) break;
    if (Node.isIfStatement(parent)) {
      const condition = condense(parent.getExpression().getText(), 60);
      if (parent.getThenStatement() === current) conditions.unshift(`when \`${condition}\``);
      else if (parent.getElseStatement() === current)
        conditions.unshift(`when not \`${condition}\``);
    } else if (Node.isConditionalExpression(parent)) {
      const condition = condense(parent.getCondition().getText(), 60);
      if (parent.getWhenTrue() === current) conditions.unshift(`when \`${condition}\``);
      else if (parent.getWhenFalse() === current) conditions.unshift(`when not \`${condition}\``);
    } else if (Node.isBlock(parent)) {
      // An earlier `if (x) { …; return }` in the same block means "only when not x".
      for (const sibling of parent.getStatements()) {
        if (sibling === current) break;
        if (
          Node.isIfStatement(sibling) &&
          endsFunction(sibling.getThenStatement()) &&
          !sibling.getElseStatement()
        ) {
          conditions.unshift(
            `after \`${condense(sibling.getExpression().getText(), 50)}\` was false`,
          );
        }
      }
    } else if (Node.isCatchClause(parent)) {
      conditions.unshift('only if something above threw');
    }
    current = parent;
  }
  return conditions;
}

// ---------------------------------------------------------------------------
// Frontend response handling
// ---------------------------------------------------------------------------

type ReactionPhase = 'on success' | 'on error' | 'always';

interface Reaction {
  phase: ReactionPhase;
  where: string;
  calls: CallExpression[];
}

/** Callbacks that run when the response comes back, wherever they are written. */
function reactionsFor(ctx: Ctx, context: CallContext): Reaction[] {
  const reactions: Reaction[] = [];
  const phaseOf = (key: string): ReactionPhase | undefined =>
    /^(onSuccess|then)$/.test(key)
      ? 'on success'
      : /^(onError|catch)$/.test(key)
        ? 'on error'
        : /^(onSettled|finally)$/.test(key)
          ? 'always'
          : undefined;

  const fromOptions = (options: Node | undefined, where: string): void => {
    if (!options || !Node.isObjectLiteralExpression(options)) return;
    for (const property of options.getProperties()) {
      const key =
        Node.isPropertyAssignment(property) || Node.isMethodDeclaration(property)
          ? property.getName()
          : undefined;
      const phase = key ? phaseOf(key) : undefined;
      if (!phase) continue;
      const fn = Node.isMethodDeclaration(property)
        ? property
        : functionOf(Node.isPropertyAssignment(property) ? property.getInitializer() : undefined);
      if (!fn) continue;
      reactions.push({ phase, where: `${where} ${key}`, calls: ownCalls(fn, fn) });
    }
  };

  // The hook's own `useMutation({ onSuccess })`.
  if (context.hook?.options) fromOptions(context.hook.options, `\`${context.hook.name}\``);

  for (const entry of ctx.front) {
    if (entry.role === 'request') continue;
    for (const call of entry.fn.getDescendantsOfKind(SyntaxKind.CallExpression)) {
      const callee = call.getExpression();
      if (!Node.isPropertyAccessExpression(callee)) continue;
      const member = callee.getName();
      // `create.mutate(values, { onSuccess, onError })`
      if (/^(mutate|mutateAsync|trigger)$/.test(member)) {
        fromOptions(call.getArguments()[1], `\`${callee.getText()}(…)\``);
      }
      // `request.then(fn).catch(fn)`
      const phase = phaseOf(member);
      if (phase && (member === 'then' || member === 'catch' || member === 'finally')) {
        const fn = functionOf(call.getArguments()[0]);
        if (fn)
          reactions.push({
            phase,
            where: `\`.${member}()\` in \`${entry.name}\``,
            calls: ownCalls(fn, fn),
          });
      }
    }
    // `await save(); after…` with no try: what follows runs only on success.
    const statements = bodyStatements(entry.fn);
    const awaitAt = statements.findIndex(
      (statement) =>
        !Node.isTryStatement(statement) &&
        statement
          .getDescendantsOfKind(SyntaxKind.AwaitExpression)
          .some((awaited) => nearestFunction(awaited) === entry.fn),
    );
    if (awaitAt >= 0 && awaitAt < statements.length - 1) {
      const after = statements
        .slice(awaitAt + 1)
        .filter((statement) => !Node.isTryStatement(statement))
        .flatMap((statement) => ownCallsOf(statement, entry.fn));
      if (after.length > 0)
        reactions.push({
          phase: 'on success',
          where: `after the await in \`${entry.name}\``,
          calls: after,
        });
    }
    // `try { await save(); after… } catch { … }`
    for (const tryStatement of ownDescendants<import('ts-morph').TryStatement>(
      entry.fn,
      SyntaxKind.TryStatement,
    )) {
      const statements = tryStatement.getTryBlock().getStatements();
      const awaitIndex = statements.findIndex(
        (statement) =>
          statement.getDescendantsOfKind(SyntaxKind.AwaitExpression).length > 0 ||
          Node.isAwaitExpression(statement),
      );
      if (awaitIndex >= 0) {
        const after = statements
          .slice(awaitIndex + 1)
          .flatMap((statement) => ownCallsOf(statement, entry.fn));
        const awaited = statements[awaitIndex]!;
        after.unshift(
          ...ownCallsOf(awaited, entry.fn).filter(
            (call) => !call.getFirstAncestorByKind(SyntaxKind.AwaitExpression),
          ),
        );
        reactions.push({
          phase: 'on success',
          where: `after the await in \`${entry.name}\``,
          calls: after,
        });
      }
      const catchClause = tryStatement.getCatchClause();
      if (catchClause)
        reactions.push({
          phase: 'on error',
          where: `catch in \`${entry.name}\``,
          calls: ownCallsOf(catchClause.getBlock(), entry.fn),
        });
      const finallyBlock = tryStatement.getFinallyBlock();
      if (finallyBlock)
        reactions.push({
          phase: 'always',
          where: `finally in \`${entry.name}\``,
          calls: ownCallsOf(finallyBlock, entry.fn),
        });
    }
  }
  return reactions;
}

function ownCallsOf(node: Node, fn: Node): CallExpression[] {
  const calls = node
    .getDescendantsOfKind(SyntaxKind.CallExpression)
    .filter((call) => nearestFunction(call) === fn);
  if (Node.isCallExpression(node) && nearestFunction(node) === fn) calls.unshift(node);
  return calls.filter(
    (call) =>
      !calls.some(
        (other) =>
          other !== call &&
          other.getArguments().some((arg) => arg.containsRange(call.getPos(), call.getEnd())),
      ),
  );
}

type ReactionKind =
  | 'State update'
  | 'Query invalidation'
  | 'Cache update'
  | 'Navigation'
  | 'Toast/notification'
  | 'Modal close'
  | 'Other';

function classifyReaction(call: CallExpression): { kind: ReactionKind; text: string } | undefined {
  const callee = call.getExpression();
  const text = callee.getText();
  const member = text.split('.').pop() ?? '';
  const args = call.getArguments();

  if (
    /^(invalidateQueries|refetchQueries|resetQueries|removeQueries|revalidatePath|revalidateTag)$/.test(
      member,
    )
  ) {
    return { kind: 'Query invalidation', text: `\`${condense(call.getText(), 90)}\`` };
  }
  if (/^(setQueryData|setQueriesData)$/.test(member) || (text === 'mutate' && args.length > 0)) {
    return { kind: 'Cache update', text: `\`${shortCall(call)}\`` };
  }
  if (
    (/^(push|replace|back|forward|refresh|navigate)$/.test(member) &&
      /router|navigate|history|nav/i.test(text)) ||
    text === 'navigate' ||
    text === 'redirect'
  ) {
    return { kind: 'Navigation', text: `\`${condense(call.getText(), 80)}\`` };
  }
  if (
    /^(toast|notify|showToast|showNotification|enqueueSnackbar|alert|success|error|info|warning|fire)$/.test(
      member,
    ) &&
    (/toast|notif|snack|message|swal|alert/i.test(text) || text === member)
  ) {
    return { kind: 'Toast/notification', text: toastText(call) };
  }
  const first = args[0] ? unwrap(args[0]) : undefined;
  const falsy = first !== undefined && (first.getText() === 'false' || first.getText() === 'null');
  if (
    /^(onClose|close|closeModal|closeDialog|onDismiss|dismiss|hide|onOpenChange|handleClose)$/.test(
      member,
    ) ||
    (/^set\w*(Open|Show|Visible|Modal|Dialog|Drawer)\w*$/.test(member) && falsy)
  ) {
    return { kind: 'Modal close', text: `\`${condense(call.getText(), 60)}\`` };
  }
  if (/^set[A-Z]/.test(member) && Node.isIdentifier(callee)) {
    return { kind: 'State update', text: `\`${condense(call.getText(), 70)}\`` };
  }
  if (
    /^(preventDefault|stopPropagation|log|warn|debug|get|has|find|map|filter|some|every|includes|startsWith|endsWith|trim|toString|join|slice|split|getErrorMessage|String|Number|Boolean|parse|stringify)$/.test(
      member,
    )
  )
    return undefined;
  return { kind: 'Other', text: `\`${shortCall(call)}\`` };
}

function toastText(call: CallExpression): string {
  const first = call.getArguments()[0];
  const value = first ? unwrap(first) : undefined;
  const callee = call.getExpression().getText();
  if (value && Node.isObjectLiteralExpression(value)) {
    const pick = (key: string): string | undefined => {
      const property = value.getProperty(key);
      if (!property || !Node.isPropertyAssignment(property)) return undefined;
      const init = property.getInitializer();
      if (!init) return undefined;
      const literal = literalText(init);
      if (literal !== undefined) return `"${literal}"`;
      if (Node.isConditionalExpression(unwrap(init))) {
        const conditional = unwrap(init) as import('ts-morph').ConditionalExpression;
        const a = literalText(conditional.getWhenTrue());
        const b = literalText(conditional.getWhenFalse());
        if (a !== undefined && b !== undefined) return `"${a}" or "${b}"`;
      }
      return `\`${condense(init.getText(), 50)}\``;
    };
    const variant = pick('variant') ?? pick('type') ?? pick('status');
    const title = pick('title') ?? pick('message') ?? pick('text');
    const description = pick('description');
    return `\`${callee}\`${variant ? ` (${variant.replace(/"/g, '')})` : ''}: ${title ?? '…'}${description ? ` — ${description}` : ''}`;
  }
  const text = literalText(value);
  return `\`${callee}\`${text !== undefined ? `: "${text}"` : value ? `: \`${condense(value.getText(), 50)}\`` : ''}`;
}

// ---------------------------------------------------------------------------
// Stages
// ---------------------------------------------------------------------------

interface StageBody {
  summary?: string;
  groups: DocGroup[];
  empty?: string;
  /** This action has no such step (not: the step could not be read). */
  absent?: true;
}

function isPageLoad(flow: FeatureFlow): boolean {
  return flow.event === 'mount' || flow.steps[0]?.meta?.['synthetic'] === true;
}

function pageRoute(file: string | undefined): string | undefined {
  if (!file) return undefined;
  const app =
    /(?:^|\/)app\/(.*)\/?page\.[jt]sx?$/.exec(file) ?? /(?:^|\/)app\/()page\.[jt]sx?$/.exec(file);
  if (app) {
    const route = (app[1] ?? '')
      .split('/')
      .filter((segment) => segment && !/^\(.*\)$/.test(segment) && !segment.startsWith('@'))
      .map((segment) => segment.replace(/^\[\.\.\.(.*)\]$/, '*$1').replace(/^\[(.*)\]$/, ':$1'))
      .join('/');
    return `/${route}`;
  }
  const pages = /(?:^|\/)pages\/(.*)\.[jt]sx?$/.exec(file);
  if (pages && !pages[1]!.startsWith('api/') && !/^_(app|document)$/.test(pages[1]!)) {
    return `/${pages[1]!.replace(/(^|\/)index$/, '').replace(/\[(.*?)\]/g, ':$1')}`;
  }
  return undefined;
}

interface Parent {
  component: string;
  file: string;
  line: number;
  openWhen?: string;
  openedBy?: { text: string; setter: string; at: SourcePoint };
}

/** Where a component is rendered, walking up until a page. */
function parentsOf(ctx: Ctx, component: string, file: string, depth = 0): Parent[] {
  if (depth > 2 || pageRoute(file)) return [];
  const files = new Set<string>();
  for (const node of ctx.graph.allNodes()) {
    const source = node.source?.file;
    if (source && /\.[jt]sx$|\.js$/.test(source)) files.add(source);
  }
  const needle = new RegExp(`<${component}[\\s/>]`);
  for (const candidate of files) {
    if (candidate === file) continue;
    const path = ctx.reader.absolute(candidate);
    if (!path || !existsSync(path)) continue;
    let text: string;
    try {
      text = readFileSync(path, 'utf8');
    } catch {
      continue;
    }
    if (!needle.test(text)) continue;
    const source = ctx.reader.file(candidate);
    if (!source) continue;
    const opening = jsxOpenings(source).find((node) => tagOf(node) === component);
    if (!opening) continue;
    const owner = componentOf(opening);
    const ownerName = owner ? nameOf(owner) : candidate;
    const parent: Parent = {
      component: ownerName,
      file: candidate,
      line: opening.getStartLineNumber(),
    };

    // `<AddProductDialog open={addOpen} />` or `{addOpen && <AddProductDialog />}`
    let openWhen: string | undefined;
    for (const name of ['open', 'isOpen', 'show', 'visible', 'opened']) {
      const value = attribute(opening, name);
      if (value) {
        openWhen = condense(value.getText(), 40);
        break;
      }
    }
    if (!openWhen) {
      const binary = opening.getFirstAncestorByKind(SyntaxKind.BinaryExpression);
      if (binary && binary.getOperatorToken().getKind() === SyntaxKind.AmpersandAmpersandToken)
        openWhen = condense(binary.getLeft().getText(), 40);
    }
    if (openWhen) {
      parent.openWhen = openWhen;
      const stateName = openWhen.replace(/^!+/, '').split(/[.\s]/)[0] ?? '';
      const setter = `set${stateName.charAt(0).toUpperCase()}${stateName.slice(1)}`;
      const trigger = (owner ?? source)
        .getDescendantsOfKind(SyntaxKind.CallExpression)
        .find(
          (call) =>
            call.getExpression().getText() === setter &&
            call.getArguments()[0]?.getText() !== 'false' &&
            call.getFirstAncestorByKind(SyntaxKind.JsxAttribute),
        );
      if (trigger) {
        const attr = trigger.getFirstAncestorByKind(SyntaxKind.JsxAttribute)!;
        const element = attr.getParent()?.getParent();
        const words = element ? elementText(element) || tagOf(element) : '';
        parent.openedBy = {
          text: words,
          setter: condense(trigger.getText(), 50),
          at: ctx.reader.point(trigger),
        };
      }
    }
    return [parent, ...parentsOf(ctx, ownerName, candidate, depth + 1)];
  }
  return [];
}

// ---------------------------------------------------------------------------
// Small builders
// ---------------------------------------------------------------------------

function plural(count: number, word: string): string {
  return `${count} ${word}${count === 1 ? '' : 's'}`;
}

function code(text: string): string {
  return `\`${text}\``;
}

/** `features/x/add-dialog.tsx` -> `add-dialog.tsx`, for summaries. */
function baseName(file: string | undefined): string {
  return (file ?? '').split('/').pop() ?? '';
}

function table(columns: string[], rows: DocRow[]): DocTable {
  return { columns, rows };
}

// ---------------------------------------------------------------------------
// Stages
// ---------------------------------------------------------------------------

function stageOpen(ctx: Ctx): StageBody {
  const { flow } = ctx;
  const entry = flow.steps[0];
  const lines: DocLine[] = [];
  const loads: DocRow[] = [];

  const parents = entry?.file && flow.component ? parentsOf(ctx, flow.component, entry.file) : [];
  const page =
    pageRoute(entry?.file) ??
    [...parents]
      .reverse()
      .map((parent) => pageRoute(parent.file))
      .find(Boolean) ??
    (typeof entry?.meta?.['page'] === 'string' ? String(entry.meta['page']) : undefined);
  const pageFile = pageRoute(entry?.file)
    ? entry?.file
    : parents.find((parent) => pageRoute(parent.file))?.file;

  lines.push({
    text: page
      ? `Page ${code(page)}${flow.screen ? ` — ${flow.screen}` : ''}`
      : `No page route was found; the action lives in ${code(flow.component ?? 'a component')}`,
    ...(pageFile ? { at: { file: pageFile, line: 1 } } : {}),
  });

  const chain = [flow.component, ...parents.map((parent) => parent.component)];
  parents.forEach((parent, index) => {
    lines.push({
      text:
        `${code(parent.component)} renders ${code(`<${chain[index]}>`)}` +
        (parent.openWhen ? ` while ${code(parent.openWhen)} is true` : ''),
      at: { file: parent.file, line: parent.line },
    });
    if (parent.openedBy) {
      lines.push({
        text: `Opened by clicking **"${parent.openedBy.text}"** → ${code(parent.openedBy.setter)}`,
        at: parent.openedBy.at,
      });
    }
  });

  const components = new Set(
    [flow.component, ctx.child?.component, ...parents.map((parent) => parent.component)].filter(
      Boolean,
    ),
  );
  const seen = new Set<string>();
  for (const candidate of ctx.flows) {
    if (candidate.id === flow.id || !isPageLoad(candidate) || !components.has(candidate.component))
      continue;
    for (const endpoint of candidate.endpoints) {
      if (seen.has(endpoint)) continue;
      seen.add(endpoint);
      loads.push({
        cells: [code(endpoint), candidate.title],
        ...(candidate.source ? { at: candidate.source } : {}),
      });
    }
  }
  if (ctx.formFn) {
    for (const hook of hooksIn(ctx, ctx.formFn)) {
      if (hook.kind !== 'query') continue;
      for (const endpoint of hook.endpoints) {
        if (seen.has(endpoint)) continue;
        seen.add(endpoint);
        loads.push({
          cells: [code(endpoint), `${code(`${hook.name}()`)} in ${code(nameOf(ctx.formFn))}`],
          at: hook.at,
        });
      }
    }
  }

  const opener = parents.find((parent) => parent.openedBy)?.openedBy;
  const summary = isPageLoad(flow)
    ? `${page ? `${code(page)} opens` : 'The page opens'} — this action runs by itself, no click`
    : `On ${page ? code(page) : (flow.screen ?? 'the screen')}` +
      (opener
        ? `, the user clicks **"${opener.text}"** to open ${code(flow.component ?? '')}`
        : '');

  return {
    summary,
    groups: [
      { label: 'Where', lines },
      { label: 'Loaded when it opens', lines: [], table: table(['Request', 'Loaded by'], loads) },
    ],
  };
}

function stageForm(ctx: Ctx): StageBody {
  if (!ctx.formFn) return { groups: [], empty: 'The component could not be read.' };
  const formFn = ctx.formFn;

  const hooks = [
    ...hooksIn(ctx, formFn),
    ...(ctx.componentFn && ctx.componentFn !== formFn ? hooksIn(ctx, ctx.componentFn) : []),
  ];
  const contextLines: DocLine[] = hooks
    .filter((hook) => ['context', 'store', 'router', 'cache'].includes(hook.kind))
    .map((hook) => ({
      text: `${code(hook.binding)} ← ${code(`${hook.name}()`)} _(${hook.kind})_`,
      at: hook.at,
    }));

  if (isPageLoad(ctx.flow)) {
    const states = stateIn(ctx, formFn);
    return {
      summary: 'Nothing to fill in — the page loads its data by itself',
      absent: true,
      groups: [
        {
          label: 'Page state the requests read',
          lines: [],
          table: table(
            ['State', 'Starts as'],
            states.map((state) => ({
              cells: [code(state.name), state.initial ? code(state.initial) : ''],
              at: state.at,
            })),
          ),
          collapsed: states.length > 6,
        },
        { label: 'Context / store', lines: contextLines },
      ],
    };
  }

  // A form's own state is what it submits. Anywhere else a component holds state
  // for every control on it — a delete button sits beside the filter drawer's
  // draft — so only the state the handlers read belongs to this action.
  const inForm = isFormTrigger(ctx);
  const handlers = ctx.front.filter((entry) => entry.role !== 'request').map((entry) => entry.fn);
  const read = (state: StateEntry): boolean =>
    handlers.some((fn) =>
      fn.getDescendantsOfKind(SyntaxKind.Identifier).some((id) => id.getText() === state.name),
    );
  const states = stateIn(ctx, formFn).filter((state) => inForm || read(state));
  if (ctx.componentFn && ctx.componentFn !== formFn)
    states.push(...stateIn(ctx, ctx.componentFn).filter(read));

  // Field values: from a form-state object, the labelled inputs, or both.
  const rows: DocRow[] = [];
  const required: string[] = [];
  const seen = new Set<string>();
  const addField = (key: string, initial?: string): void => {
    if (seen.has(key)) return;
    seen.add(key);
    const label = ctx.labels.get(key);
    if (label?.required) required.push(label.label ?? key);
    rows.push({
      cells: [
        code(key),
        label?.label ?? '',
        label?.required ? '**yes**' : '',
        initial ? code(initial) : '',
      ],
    });
  };
  for (const state of states)
    for (const entry of state.keys ?? []) addField(entry.key, entry.initial);
  // Labelled inputs are the form's fields; beside a lone button they are some other control's.
  const readNames = new Set(states.map((state) => state.name));
  for (const key of ctx.labels.keys()) if (inForm || readNames.has(key)) addField(key);

  const stateRows: DocRow[] = states.map((state) => ({
    cells: [
      code(state.name),
      state.setter ? code(state.setter) : '',
      state.keys?.length
        ? `object of ${plural(state.keys.length, 'field')}`
        : state.initial
          ? code(state.initial)
          : '',
    ],
    at: state.at,
  }));
  const formHooks: DocLine[] = hooks
    .filter((hook) => hook.kind === 'form')
    .map((hook) => ({
      text: `${code(hook.binding)} ← ${code(`${hook.name}()`)} manages the form`,
      at: hook.at,
    }));

  // Existing state: what the form is handed, and server data it reads.
  const existing: DocLine[] = [];
  if (
    ctx.child &&
    ctx.entryOpening &&
    (Node.isJsxOpeningElement(ctx.entryOpening) || Node.isJsxSelfClosingElement(ctx.entryOpening))
  ) {
    for (const attr of ctx.entryOpening.getAttributes()) {
      if (!Node.isJsxAttribute(attr)) continue;
      const name = attr.getNameNode().getText();
      if (name === ctx.flow.event || /^on[A-Z]/.test(name)) continue;
      existing.push({
        text: `prop ${code(condense(attr.getText(), 70))} from ${code(ctx.flow.component ?? '')}`,
        at: ctx.reader.point(attr),
      });
    }
  }
  for (const hook of hooks.filter((entry) => entry.kind === 'query')) {
    existing.push({
      text: `${code(hook.binding)} ← ${code(`${hook.name}()`)}${hook.endpoints.length ? `, loaded by ${hook.endpoints.map(code).join(', ')}` : ''}`,
      at: hook.at,
    });
  }

  const summary =
    rows.length > 0
      ? `Fills ${plural(rows.length, 'field')} in ${code(nameOf(formFn))}` +
        (required.length ? ` — required: ${required.map((r) => `"${r}"`).join(', ')}` : '')
      : confirmationsOf(ctx).length > 0
        ? 'Nothing to fill in — a click and a confirmation'
        : 'Nothing to fill in — a single control';

  return {
    summary,
    ...(rows.length === 0 ? { absent: true as const } : {}),
    groups: [
      {
        label: 'Field values',
        lines: [],
        table: table(['Field', 'Label on screen', 'Required', 'Starts as'], rows),
      },
      {
        label: 'Form state',
        lines: formHooks,
        table: table(['State', 'Setter', 'Holds'], stateRows),
        collapsed: true,
      },
      { label: 'Existing state', lines: existing },
      { label: 'Context / store', lines: contextLines },
    ],
  };
}

/** The user submits a form: `<form onSubmit>`, a submit button, or a control inside a `<form>`. */
function isFormTrigger(ctx: Ctx): boolean {
  if (ctx.flow.event === 'onSubmit') return true;
  const opening = ctx.triggerOpening;
  if (!opening) return false;
  if (tagOf(opening) === 'form') return true;
  const type = attribute(opening, 'type');
  if (type && literalText(type) === 'submit') return true;
  // Up to the component that renders it, not past it.
  for (const ancestor of opening.getAncestors()) {
    if (Node.isJsxElement(ancestor) && tagOf(ancestor.getOpeningElement()) === 'form') return true;
    if (
      Node.isArrowFunction(ancestor) ||
      Node.isFunctionDeclaration(ancestor) ||
      Node.isFunctionExpression(ancestor)
    )
      return false;
  }
  return false;
}

function triggerPhrase(ctx: Ctx, withConfirm = true): string {
  const { flow } = ctx;
  if (isPageLoad(flow)) return `opens ${flow.screen ?? flow.component ?? 'the screen'}`;
  const opening = ctx.triggerOpening;
  let words = '';
  if (opening && tagOf(opening) === 'form') {
    const submit = jsxOpenings(opening.getParent() ?? opening).find((candidate) => {
      const type = attribute(candidate, 'type');
      return type !== null && type !== undefined && literalText(type) === 'submit';
    });
    words = submit ? elementText(submit) : '';
    return words ? `clicks "${words}" (submits the form)` : 'submits the form';
  }
  if (opening) words = elementText(opening);
  const verb =
    flow.event === 'onChange' ? 'changes' : flow.event === 'onSubmit' ? 'submits' : 'clicks';
  const confirm = withConfirm ? confirmationsOf(ctx)[0] : undefined;
  return (
    (words ? `${verb} "${words}"` : `${verb} ${flow.label}`) +
    (confirm ? `, then confirms "${confirm.button}"` : '')
  );
}

function stageTrigger(ctx: Ctx): StageBody {
  const { flow } = ctx;
  if (isPageLoad(flow)) {
    return {
      summary: 'No click — runs when the component mounts',
      groups: [{ label: 'Trigger', lines: [{ text: 'Runs as soon as the component mounts' }] }],
    };
  }
  const lines: DocLine[] = [];
  if (ctx.triggerOpening) {
    const opening = ctx.triggerOpening;
    const event = ctx.child
      ? ctx.child.handler
        ? eventOn(opening, ctx.child.handler)
        : ctx.flow.event
      : flow.event;
    const element = `<${tagOf(opening)} ${event ?? flow.event ?? ''}>`;
    lines.push({ text: `Element ${code(element)}`, at: ctx.reader.point(opening) });
    const disabled = submitButton(opening);
    if (disabled)
      lines.push({ text: `Disabled while ${code(disabled.condition)} — blocks a double submit` });
  }
  if (ctx.child) {
    lines.push({
      text: `The button lives in ${code(ctx.child.component)}; ${code(flow.component ?? '')} hands it ${code(flow.event ?? '')}`,
      ...(ctx.entryOpening ? { at: ctx.reader.point(ctx.entryOpening) } : {}),
    });
  }
  const words = triggerPhrase(ctx, false);
  return {
    summary: `The user ${words.replace(/"([^"]+)"/g, '**"$1"**')}`,
    groups: [{ label: 'Trigger', lines }],
  };
}

function eventOn(opening: Node, handler: Functionish): string | undefined {
  if (!Node.isJsxOpeningElement(opening) && !Node.isJsxSelfClosingElement(opening))
    return undefined;
  for (const attr of opening.getAttributes()) {
    if (!Node.isJsxAttribute(attr)) continue;
    const init = attr.getInitializer();
    const expression = init && Node.isJsxExpression(init) ? init.getExpression() : undefined;
    if (expression && (expression === handler || expression.getText() === nameOf(handler)))
      return attr.getNameNode().getText();
  }
  return undefined;
}

/** The submit button's `disabled={…}`, for forms. */
function submitButton(opening: Node): { condition: string } | undefined {
  const scope = opening.getParent() ?? opening;
  const candidates =
    tagOf(opening) === 'form'
      ? jsxOpenings(scope).filter((candidate) => {
          const type = attribute(candidate, 'type');
          return type !== null && type !== undefined && literalText(type) === 'submit';
        })
      : [opening];
  for (const candidate of candidates) {
    const disabled = attribute(candidate, 'disabled') ?? attribute(candidate, 'loading');
    if (disabled) return { condition: condense(disabled.getText(), 50) };
  }
  return undefined;
}

/** `AddProductDialog.onSubmit` -> `onSubmit`, for a chain that fits on a line. */
function shortName(name: string): string {
  return name.includes(' → ') ? (name.split(' → ').pop() ?? name) : (name.split('.').pop() ?? name);
}

/** The dialog a handler waits on before it sends anything. */
function stageConfirm(ctx: Ctx): StageBody {
  const confirms = confirmationsOf(ctx);
  if (confirms.length === 0)
    return {
      summary: 'No confirmation — the click goes straight through',
      groups: [],
      absent: true,
    };
  const groups: DocGroup[] = confirms.map((confirm) => ({
    label: confirm.title ? `"${confirm.title}"` : 'Dialog',
    lines: [
      {
        text: `Opened by ${code(confirm.call)} in ${code(confirm.in)}, which waits for the answer`,
        at: confirm.at,
        tone: 'muted' as const,
      },
      {
        text: `**"${confirm.button}"** → the handler carries on and the request is sent`,
        tone: 'ok' as const,
      },
      {
        text: `**"${confirm.cancel}"** → stops at ${code(confirm.condition)}; nothing is sent and nothing changes`,
        at: ctx.reader.point(confirm.node),
        tone: 'error' as const,
      },
    ],
    table: table(
      ['Part', 'Text'],
      [
        ...(confirm.title ? [{ cells: ['Title', confirm.title] }] : []),
        ...(confirm.message ? [{ cells: ['Message', confirm.message] }] : []),
        { cells: ['Confirm button', `"${confirm.button}"`] },
        { cells: ['Cancel button', `"${confirm.cancel}"`] },
      ],
    ),
  }));
  const first = confirms[0]!;
  return {
    summary:
      `${first.title ? `**"${first.title}"** pops up` : 'A dialog pops up'}` +
      ` — the user clicks **"${first.button}"** to go ahead, or **"${first.cancel}"** to stop`,
    groups,
  };
}

function stageHandlers(ctx: Ctx): StageBody {
  if (ctx.front.length === 0)
    return { groups: [], empty: 'No handler could be read for this action.' };
  const groups: DocGroup[] = ctx.front.map((entry, index) => {
    const role =
      entry.role === 'child'
        ? ' — runs first, inside the form'
        : entry.role === 'request'
          ? ' — sends the request'
          : '';
    const lines: DocLine[] = [];
    lines.push({
      text: entry.via ? `wired as ${code(entry.via)}` : 'called by the step above',
      at: ctx.reader.point(entry.fn),
      tone: 'muted',
    });
    lines.push(...summarizeFn(entry.fn));
    return { label: `${index + 1}. ${entry.name}${role}`, lines };
  });
  return {
    summary: ctx.front.map((entry) => code(shortName(entry.name))).join(' → '),
    groups,
  };
}

/** One line per statement of a function body. */
function summarizeFn(fn: Functionish, limit = 12): DocLine[] {
  const lines: DocLine[] = [];
  for (const statement of bodyStatements(fn)) {
    if (lines.length >= limit) {
      lines.push({ text: '…', tone: 'muted' });
      break;
    }
    lines.push({ text: statementText(statement) });
  }
  return lines;
}

function statementText(statement: Node): string {
  if (Node.isVariableStatement(statement)) {
    const declaration = statement.getDeclarations()[0];
    const init = declaration?.getInitializer();
    return code(
      `const ${condense(declaration?.getNameNode().getText() ?? '', 40)}${init ? ` = ${shortExpression(init)}` : ''}`,
    );
  }
  if (Node.isExpressionStatement(statement))
    return code(shortExpression(statement.getExpression()));
  if (Node.isIfStatement(statement)) {
    const then = statement.getThenStatement();
    const stops = endsFunction(then);
    const calls = directCalls(then)
      .slice(0, 2)
      .map((call) => shortCall(call));
    const returned = returnIn(then);
    if (returned && calls.length < 2) calls.push(`return ${shortExpression(returned)}`);
    return (
      `if ${code(condense(statement.getExpression().getText(), 60))} → ` +
      (calls.length ? code(calls.join('; ')) : '') +
      (stops ? ` **stops here**` : '') +
      (statement.getElseStatement() ? ' _(else …)_' : '')
    );
  }
  if (Node.isReturnStatement(statement)) {
    const expression = statement.getExpression();
    return expression ? `returns ${code(shortExpression(expression))}` : 'returns';
  }
  if (Node.isTryStatement(statement)) return code('try { … } catch { … }');
  if (Node.isThrowStatement(statement))
    return `throws ${code(condense(statement.getExpression()?.getText() ?? '', 60))}`;
  return code(condense(statement.getText(), 70));
}

/** Only the fields a schema actually checks, so the table is about rules. */
function checkedRows(facts: SchemaFacts, labels: Ctx['labels']): DocTable {
  const full = schemaTable(facts, labels);
  return {
    columns: full.columns,
    rows: full.rows.filter((_, index) => {
      const field = facts.fields[index]!;
      const realRules = field.rules.filter(
        (rule) => rule !== 'optional' && rule !== 'or blank' && !rule.startsWith('checked by'),
      );
      return field.required || realRules.length > 0 || field.messages.length > 0;
    }),
  };
}

function stageFrontendValidation(ctx: Ctx): StageBody {
  const stops: DocRow[] = [];
  const confirms = confirmationsOf(ctx);
  for (const entry of ctx.front) {
    if (entry.role === 'request') continue;
    for (const check of stoppingChecks(entry.fn)) {
      // Cancelling a dialog is the user's choice, not a failed check.
      if (confirms.some((confirm) => confirm.node === check.node)) continue;
      const shows = check.does.filter((does) => !does.startsWith('returns'));
      stops.push({
        cells: [
          code(check.condition),
          shows.map(code).join(', ') || '_nothing — stops quietly_',
          code(shortName(entry.name)),
        ],
        at: ctx.reader.point(check.node),
        tone: 'warn',
      });
    }
  }

  const groups: DocGroup[] = [
    {
      label: 'Stops the submit when',
      lines: [],
      table: table(['Condition', 'What the user sees', 'In'], stops),
    },
  ];
  for (const entry of ctx.frontSchemas) {
    groups.push({
      label: `Rules in ${entry.facts.name} (${entry.facts.library}, via ${entry.method})`,
      lines: [
        {
          text: `declared in ${code(baseName(entry.facts.at.file))}`,
          at: entry.facts.at,
          tone: 'muted',
        },
      ],
      table: checkedRows(entry.facts, ctx.labels),
    });
  }

  const hints: DocLine[] = [];
  const required = [...ctx.labels.entries()]
    .filter(([, label]) => label.required)
    .map(([key, label]) => label.label ?? key);
  if (required.length > 0)
    hints.push({
      text: `Marked required on the form: ${required.map((r) => `"${r}"`).join(', ')}`,
    });
  const disabled = ctx.triggerOpening ? submitButton(ctx.triggerOpening) : undefined;
  if (disabled)
    hints.push({
      text: `The button is disabled while ${code(disabled.condition)}, so it cannot be sent twice`,
    });
  groups.push({ label: 'Form hints', lines: hints });

  if (confirms.length > 0)
    groups.push({
      label: 'Asks the user first (not a validation)',
      lines: confirms.map((confirm) => ({
        text: `${code(confirm.call)} — stops at ${code(confirm.condition)} if the user cancels; see Confirmation dialog`,
        at: ctx.reader.point(confirm.node),
      })),
    });

  const schema = ctx.frontSchemas[0];
  const checked = schema ? checkedRows(schema.facts, ctx.labels).rows.length : 0;
  const summary =
    stops.length + ctx.frontSchemas.length === 0
      ? confirms.length > 0
        ? 'No input to check — only the confirmation, which stops if the user cancels'
        : 'No check — whatever is typed is sent'
      : [
          schema ? `${code(schema.facts.name)} checks ${plural(checked, 'field')}` : '',
          stops[0] ? `stops if ${stops[0].cells[0]}` : '',
        ]
          .filter(Boolean)
          .join('; ');

  return {
    summary,
    groups,
    // A confirmation dialog is already shown under the trigger.
    ...(stops.length + ctx.frontSchemas.length === 0 && hints.length === 0
      ? { absent: true as const }
      : {}),
    ...(stops.length + ctx.frontSchemas.length + confirms.length === 0 && hints.length === 0
      ? { empty: 'Nothing checks the input on the frontend; whatever is entered is sent.' }
      : {}),
  };
}

function stagePayload(ctx: Ctx): StageBody {
  if (ctx.calls.length === 0) return noRequest(ctx);
  const groups: DocGroup[] = [];
  const summaries: string[] = [];
  let bodiless = 0;

  for (const context of ctx.calls) {
    const prefix = ctx.calls.length > 1 ? `${context.detail.endpoint} · ` : '';
    const { detail } = context;
    const body = context.call ? bodyArgument(context.call, detail.method) : undefined;
    if (!body) {
      const none = /^(GET|DELETE|HEAD)$/.test(detail.method)
        ? `No body — a ${detail.method} sends its data in the URL`
        : 'No body was found at the call site';
      groups.push({ label: `${prefix}Payload`, lines: [{ text: none }] });
      summaries.push(`${code(detail.endpoint)}: no body`);
      bodiless += 1;
      continue;
    }

    /** field -> [comes from, changed before sending, sent when] */
    const rows = new Map<
      string,
      { from: string; changed: string; sent: string; at?: SourcePoint }
    >();
    const put = (
      field: string,
      patch: Partial<{ from: string; changed: string; sent: string; at: SourcePoint }>,
    ): void => {
      const current = rows.get(field) ?? { from: '', changed: '', sent: 'always' };
      rows.set(field, { ...current, ...patch });
    };
    const value = unwrap(body);
    let trace: Trace | undefined;
    let source = '';

    const fromLiteral = (
      literal: import('ts-morph').ObjectLiteralExpression,
      literalFn: Functionish | undefined,
    ): void => {
      for (const property of literal.getProperties()) {
        if (Node.isSpreadAssignment(property)) {
          const inner = unwrap(property.getExpression());
          if (
            Node.isConditionalExpression(inner) ||
            (Node.isBinaryExpression(inner) &&
              inner.getOperatorToken().getKind() === SyntaxKind.AmpersandAmpersandToken)
          ) {
            const condition = Node.isConditionalExpression(inner)
              ? inner.getCondition().getText()
              : (inner as import('ts-morph').BinaryExpression).getLeft().getText();
            const keys = inner
              .getDescendantsOfKind(SyntaxKind.ObjectLiteralExpression)
              .flatMap((object) => objectKeysOf(object));
            for (const key of keys.length ? keys : ['(extra fields)'])
              put(key, {
                from: code(condense(inner.getText(), 40)),
                sent: `only when ${code(condense(condition, 40))}`,
                at: ctx.reader.point(property),
              });
          } else {
            put(`...${condense(property.getExpression().getText(), 30)}`, {
              from: 'every key of it',
              at: ctx.reader.point(property),
            });
          }
          continue;
        }
        if (!Node.isPropertyAssignment(property) && !Node.isShorthandPropertyAssignment(property))
          continue;
        const key = property.getName();
        const init = Node.isPropertyAssignment(property)
          ? property.getInitializer()
          : property.getNameNode();
        if (!init) continue;
        const inner = unwrap(init);
        const origin = traceValue(ctx, init, literalFn);
        const from = (origin.steps.at(-1)?.text ?? code(condense(init.getText(), 40))).replace(
          / — the form's state \(`useState`\)$/,
          ' _(state)_',
        );
        if (Node.isConditionalExpression(inner)) {
          put(key, {
            from: code(condense(inner.getText(), 50)),
            sent: `depends on ${code(condense(inner.getCondition().getText(), 40))}`,
            at: ctx.reader.point(property),
          });
        } else if (
          Node.isCallExpression(inner) ||
          Node.isTemplateExpression(inner) ||
          Node.isBinaryExpression(inner)
        ) {
          put(key, {
            from,
            changed: code(condense(inner.getText(), 50)),
            at: ctx.reader.point(property),
          });
        } else {
          put(key, { from, at: ctx.reader.point(property) });
        }
      }
    };

    if (Node.isObjectLiteralExpression(value)) {
      fromLiteral(value, context.fn);
      source = 'an object built at the call';
    } else {
      trace = traceValue(ctx, body, context.fn);
      const schema = trace.schema;
      if (trace.object) {
        fromLiteral(trace.object.node, trace.object.fn);
        source = `an object built in ${code(shortName(qualified(trace.object.fn)))}`;
      } else if (schema) {
        for (const field of schema.fields) {
          const label = ctx.labels.get(field.name)?.label;
          put(field.name, {
            from: trace.state
              ? `${code(`${trace.state}.${field.name}`)}${label ? ` — "${label}"` : ''}`
              : label
                ? `"${label}"`
                : 'the form',
            changed: field.transforms.join('; '),
            sent:
              field.rules.some((rule) => rule === 'optional' || rule === 'or blank') &&
              !field.transforms.some((t) => t.startsWith('defaults to'))
                ? 'only if filled in'
                : 'always',
          });
        }
        source = `${trace.state ? code(trace.state) : 'the form'}, cleaned by ${code(schema.name)}`;
      } else if (detail.payload.length > 0) {
        for (const field of detail.payload)
          put(field.name, { from: field.from ? code(field.from) : '' });
      } else if (trace.state) {
        const state = ctx.formFn
          ? stateIn(ctx, ctx.formFn).find((entry) => entry.name === trace!.state)
          : undefined;
        for (const entry of state?.keys ?? [])
          put(entry.key, { from: code(`${trace.state}.${entry.key}`) });
        if (!state?.keys) put(`(all of ${trace.state})`, { from: code(trace.state) });
        source = code(trace.state);
      }
    }

    groups.push({
      label: `${prefix}Payload`,
      lines: [],
      table: table(
        ['Field', 'Comes from', 'Changed before sending', 'Sent'],
        [...rows.entries()].map(([field, row]) => ({
          cells: [
            code(field),
            row.from,
            row.changed,
            row.sent === 'always' ? 'always' : `**${row.sent}**`,
          ],
          ...(row.at ? { at: row.at } : {}),
        })),
      ),
    });
    if (trace && trace.steps.length > 0) {
      groups.push({
        label: `${prefix}How the value travels to the request`,
        lines: [...trace.steps]
          .reverse()
          .map((step, index) => ({ ...step, text: `${index + 1}. ${step.text}` }))
          .concat([
            {
              text: `${trace.steps.length + 1}. sent as ${code(condense(body.getText(), 40))}`,
              at: ctx.reader.point(body),
            },
          ]),
      });
    }
    summaries.push(`Sends ${plural(rows.size, 'field')}${source ? ` from ${source}` : ''}`);
  }
  // Everything it sends is in the URL, which the request stage shows.
  return {
    summary: summaries.join(' · '),
    groups,
    ...(bodiless === ctx.calls.length ? { absent: true as const } : {}),
  };
}

function noRequest(ctx: Ctx): StageBody {
  void ctx;
  return {
    summary: 'No request — only changes what is on screen',
    groups: [],
    absent: true,
    empty: 'This action makes no request — it only changes what is on screen.',
  };
}

function stageRequest(ctx: Ctx): StageBody {
  if (ctx.calls.length === 0) return noRequest(ctx);
  const groups: DocGroup[] = [];
  const summaries: string[] = [];
  for (const context of ctx.calls) {
    const { detail } = context;
    const prefix = ctx.calls.length > 1 ? `${detail.order}. ${detail.endpoint} · ` : '';
    const client = context.call ? clientFacts(ctx, context.call) : undefined;
    const raw = detail.rawPath ?? detail.path;
    const url =
      client?.baseURL && !/^https?:/.test(raw) ? `${client.baseURL.replace(/\/$/, '')}${raw}` : raw;
    const query = [...new Set([...detail.queryKeys, ...configQueryKeys(context.call)])];
    const body = context.call ? bodyArgument(context.call, detail.method) : undefined;
    const declared = declaredResponseType(context.call);
    const paths = pathParams(ctx, context);

    const rows: DocRow[] = [
      { cells: ['Method', `**${detail.method}**`] },
      {
        cells: ['URL', code(url)],
        ...(context.call ? { at: ctx.reader.point(context.call) } : {}),
      },
    ];
    if (client)
      rows.push({ cells: ['Client', code(client.name)], ...(client.at ? { at: client.at } : {}) });
    rows.push({ cells: ['When', detail.when] });
    if (detail.condition) rows.push({ cells: ['Only when', code(detail.condition)] });
    if (query.length) rows.push({ cells: ['Query params', query.map(code).join(', ')] });
    for (const line of paths)
      rows.push({ cells: ['Path param', line.text], ...(line.at ? { at: line.at } : {}) });
    rows.push({
      cells: [
        'Body',
        body ? `${code(condense(body.getText(), 50))} — see Payload construction` : '_none_',
      ],
    });
    if (declared) rows.push({ cells: ['Expects back', code(declared)] });

    groups.push({ label: `${prefix}Request`, lines: [], table: table(['', ''], rows) });
    groups.push({
      label: `${prefix}Headers`,
      lines: client?.headers.length
        ? []
        : [{ text: 'No headers set in code; the browser defaults apply', tone: 'muted' }],
      table: table(
        ['Header', 'Value', 'Set by', 'Only when'],
        (client?.headers ?? []).map((header) => ({
          cells: [
            code(header.name),
            code(header.value.replace(/^`|`$/g, '')),
            header.setBy,
            header.when ? code(header.when) : 'always',
          ],
          at: header.at,
        })),
      ),
    });
    summaries.push(
      `${code(`${detail.method} ${url}`)}` +
        (client?.headers.length
          ? ` with ${client.headers.map((h) => code(h.name)).join(', ')}`
          : ''),
    );
  }
  return { summary: summaries.join(' · '), groups };
}

function stageRoute(ctx: Ctx): StageBody {
  if (ctx.calls.length === 0) return noRequest(ctx);
  const summaries: string[] = [];
  const lines: DocLine[] = ctx.calls.map(({ detail }) => {
    if (!detail.route) {
      summaries.push(`${code(detail.endpoint)} matches **no route** here`);
      return {
        text: `${code(detail.endpoint)} matched **no route** in the scanned code — it is served elsewhere, or the path or method disagree`,
        tone: 'error' as const,
      };
    }
    const framework =
      { 'file-route': 'Next.js file route', nestjs: 'NestJS controller', express: 'Express route' }[
        detail.route.framework ?? ''
      ] ??
      detail.route.framework ??
      'route';
    summaries.push(
      `${code(`${detail.route.method} ${detail.route.path}`)} → ${detail.route.controller ? code(detail.route.controller) : code(detail.route.file ?? '')}`,
    );
    return {
      text:
        `${code(`${detail.route.method} ${detail.route.path}`)} — ${framework}` +
        (detail.route.controller ? ` ${code(detail.route.controller)}` : '') +
        (detail.rawPath && detail.rawPath !== detail.route.path
          ? ` _(the frontend calls ${code(detail.rawPath)}; the prefix is stripped)_`
          : ''),
      ...(detail.route.file
        ? { at: { file: detail.route.file, line: detail.route.line ?? 1 } }
        : {}),
    };
  });
  return { summary: summaries.join(' · '), groups: [{ label: 'Matched route', lines }] };
}

function stageGuards(ctx: Ctx): StageBody {
  if (ctx.calls.length === 0) return noRequest(ctx);
  const rows: DocRow[] = [];
  const runs: DocLine[] = [];
  const globals: DocLine[] = [];
  const names = new Set<string>();

  for (const context of ctx.calls) {
    for (const middleware of context.detail.middleware) {
      names.add(middleware.name);
      rows.push({
        cells: [
          code(middleware.name),
          classifyMiddleware(middleware.name, middleware.role),
          `_${middleware.role}, before the handler_`,
          '',
          '',
        ],
        ...(middleware.file ? { at: { file: middleware.file, line: middleware.line ?? 1 } } : {}),
      });
    }
    const handler = context.backendFns[0]?.fn;
    if (!handler) continue;
    for (const guard of guardsIn(ctx, handler)) {
      names.add(guard.name);
      runs.push({
        text: `${code(guard.call)} runs before the handler does any work, and returns early if it fails`,
        at: guard.declaredAt ?? guard.at,
      });
      for (const exit of guard.exits) {
        rows.push({
          cells: [
            code(guard.name),
            classifyExit(exit, guard.name),
            conditionText(exit.condition),
            exit.statuses.length ? `**${exit.statuses.join(' or ')}**` : '',
            exit.message ? `"${exit.message}"` : '',
          ],
          at: exit.at,
          tone: 'error',
        });
      }
    }
  }

  // Next.js `middleware.ts` / `proxy.ts`.
  for (const name of ['middleware', 'proxy']) {
    for (const dir of ['', 'src/']) {
      for (const ext of ['.ts', '.js']) {
        const rel = `${dir}${name}${ext}`;
        const file = ctx.reader.file(rel);
        if (!file) continue;
        const matcher = file
          .getDescendantsOfKind(SyntaxKind.PropertyAssignment)
          .find((property) => property.getName() === 'matcher');
        const text = matcher?.getInitializer()?.getText() ?? '';
        const skipsApi = /\(\?!api|\(\?!\/api/.test(text);
        globals.push({
          text: skipsApi
            ? `${code(rel)} does **not** run for this request — its matcher excludes ${code('/api')}`
            : `${code(rel)} runs before the route${text ? ` (matcher ${code(condense(text, 60))})` : ' for every path'}`,
          at: { file: rel, line: matcher?.getStartLineNumber() ?? 1 },
          tone: skipsApi ? 'muted' : 'ok',
        });
      }
    }
  }

  const found = rows.length > 0 || runs.length > 0;
  const statuses = [
    ...new Set(
      rows.flatMap((row) => row.cells[3]!.replace(/\*/g, '').split(' or ')).filter(Boolean),
    ),
  ].sort();
  if (!found) {
    runs.push({
      text: 'No guard, middleware or auth check was found on this route. Anyone who can reach it can call it.',
      tone: 'warn',
    });
  }
  return {
    summary: found
      ? `${[...names].map(code).join(', ')}${statuses.length ? ` — can answer ${statuses.join(' · ')}` : ''}`
      : '**No auth check** — anyone who can reach the route can call it',
    ...(found ? {} : { absent: true as const }),
    groups: [
      {
        label: 'Checks before the handler',
        lines: runs,
        table: table(['Check', 'Kind', 'Fails when', 'Status', 'Message'], rows),
      },
      { label: 'App-wide middleware', lines: globals },
    ],
  };
}

function stageController(ctx: Ctx): StageBody {
  if (ctx.calls.length === 0) return noRequest(ctx);
  const groups: DocGroup[] = [];
  const summaries: string[] = [];
  for (const context of ctx.calls) {
    const handler = context.backendFns[0];
    if (!handler) {
      if (context.detail.route)
        groups.push({
          label: context.detail.endpoint,
          lines: [
            {
              text: `The handler for ${code(context.detail.endpoint)} could not be read`,
              tone: 'muted',
            },
          ],
        });
      continue;
    }
    // Only the calls the handler makes as steps of its own, not the ones inside a return.
    const calls = [
      ...new Set(
        bodyStatements(handler.fn)
          .flatMap((statement) => {
            if (Node.isVariableStatement(statement))
              return statement.getDeclarations().map((declaration) => declaration.getInitializer());
            if (Node.isExpressionStatement(statement)) return [statement.getExpression()];
            return [];
          })
          .map((expression) => (expression ? unwrap(expression) : undefined))
          .filter(
            (expression): expression is CallExpression =>
              expression !== undefined && Node.isCallExpression(expression),
          )
          .map((call) =>
            call
              .getExpression()
              .getText()
              .replace(/^this\./, ''),
          )
          .filter(
            (name) =>
              !/^(request|req|res|response|JSON|console)\b|\.catch$|\.json$|^json$/.test(name),
          ),
      ),
    ].slice(0, 5);
    summaries.push(
      `${code(handler.label)}${calls.length ? ` calls ${calls.map(code).join(', ')}` : ''}`,
    );
    groups.push({
      label: handler.label,
      lines: [
        { text: 'what the handler does, line by line:', at: handler.at, tone: 'muted' },
        ...summarizeFn(handler.fn, 14),
      ],
    });
  }
  return { summary: summaries.join(' · '), groups };
}

function stageBackendValidation(ctx: Ctx): StageBody {
  if (ctx.calls.length === 0) return noRequest(ctx);
  const groups: DocGroup[] = [];
  const business: DocRow[] = [];
  const permission: DocLine[] = [];
  const summaries: string[] = [];

  for (const context of ctx.calls) {
    const { detail } = context;
    if (detail.dto) {
      const pipe = detail.middleware.some((m) => /ValidationPipe/.test(m.name));
      groups.push({
        label: `DTO ${detail.dto.name}${pipe ? ' (ValidationPipe)' : ''}`,
        lines: [],
        table: dtoTable(
          ctx,
          detail.dto.name,
          detail.dto.fields.map((f) => f.name),
        ),
      });
      summaries.push(`${code(detail.dto.name)} validates the body`);
    }
    const handler = context.backendFns[0]?.fn;
    if (!handler) continue;
    const checks = backendSchemaChecks(ctx, handler);
    const skip = new Set<IfStatement>();
    for (const check of checks) {
      const shared = ctx.frontSchemas.some((front) => front.facts.name === check.schema);
      const failure = check.exit ? ` — if it fails: ${exitText(check.exit)}` : '';
      if (shared) {
        groups.push({
          label: `Schema ${check.schema}`,
          lines: [
            { text: `${code(shortCall(check.call))}${failure}`, at: ctx.reader.point(check.call) },
            {
              text: `Same schema as Frontend validation, so the frontend and backend enforce the same rules`,
              tone: 'ok',
            },
          ],
        });
      } else {
        groups.push({
          label: `Schema ${check.schema}${check.facts ? ` (${check.facts.library})` : ''}`,
          lines: [
            { text: `${code(shortCall(check.call))}${failure}`, at: ctx.reader.point(check.call) },
          ],
          ...(check.facts ? { table: checkedRows(check.facts, ctx.labels) } : {}),
        });
      }
      summaries.push(
        `${code(check.schema)}${shared ? ' again' : ''}${check.exit?.statuses.length ? ` → ${check.exit.statuses.join(' or ')} if invalid` : ''}`,
      );
    }
    for (const statement of ownDescendants<IfStatement>(handler, SyntaxKind.IfStatement)) {
      const text = statement.getExpression().getText();
      if (
        checks.some((check) => {
          const name = check.call.getFirstAncestorByKind(SyntaxKind.VariableDeclaration)?.getName();
          return name !== undefined && text.includes(name);
        })
      )
        skip.add(statement);
    }
    for (const guard of guardsIn(ctx, handler)) {
      for (const statement of ownDescendants<IfStatement>(handler, SyntaxKind.IfStatement)) {
        if (
          statement.getStartLineNumber() >= guard.at.line &&
          statement.getStartLineNumber() <= guard.at.line + 2
        )
          skip.add(statement);
      }
      for (const exit of guard.exits) {
        if (exit.status === 403)
          permission.push({
            text: `${code(guard.name)}: ${exitText(exit)} _(see Middleware / guard / auth)_`,
            at: exit.at,
          });
      }
    }
    const rowOf = (exit: GuardExit, where: string): DocRow => ({
      cells: [
        conditionText(exit.condition),
        exit.statuses.length ? `**${exit.statuses.join(' or ')}**` : '_throws_',
        exit.message ? `"${exit.message}"` : '',
        code(where),
      ],
      at: exit.at,
      tone: 'error',
    });
    for (const exit of businessExits(ctx, handler, skip))
      business.push(rowOf(exit, context.backendFns[0]!.label));
    for (const service of context.backendFns.slice(1)) {
      for (const exit of businessExits(ctx, service.fn, new Set()))
        business.push(rowOf(exit, service.label));
    }
  }
  groups.push({
    label: 'Business rules that reject the request',
    lines: [],
    table: table(['Fails when', 'Status', 'Message', 'In'], business),
  });
  groups.push({ label: 'Permission checks', lines: permission });
  if (business.length) summaries.push(`${plural(business.length, 'business rule')}`);

  const empty = groups.every(
    (group) => group.lines.length === 0 && (group.table?.rows.length ?? 0) === 0,
  );
  // Permission checks are the guard stage's, repeated here for reference; on
  // their own they are not validation.
  const onlyPermissions = !empty && summaries.length === 0;
  return {
    summary: empty
      ? '**No validation** — whatever arrives is used as is'
      : onlyPermissions
        ? 'No input validation — only the permission checks under Middleware / guard / auth'
        : summaries.join(' · '),
    groups,
    ...(empty || onlyPermissions ? { absent: true as const } : {}),
    ...(empty
      ? { empty: 'The backend does not validate this input — whatever arrives is used as is.' }
      : {}),
  };
}

/** A DTO's fields with their class-validator decorators. */
function dtoTable(ctx: Ctx, name: string, fields: string[]): DocTable {
  const node = ctx.graph.nodesOfKind('dto').find((candidate) => candidate.label === name);
  const file = node?.source ? ctx.reader.file(node.source.file) : undefined;
  const declaration = file?.getClass(name);
  if (!declaration)
    return table(
      ['Field', 'Checks'],
      fields.map((field) => ({ cells: [code(field), ''] })),
    );
  return table(
    ['Field', 'Required', 'Checks'],
    declaration.getProperties().map((property) => ({
      cells: [
        code(property.getName()),
        property.hasQuestionToken() ? 'no' : 'yes',
        property
          .getDecorators()
          .map((decorator) => code(`@${decorator.getName()}`))
          .join(' '),
      ],
      at: ctx.reader.point(property),
    })),
  );
}

interface DbOp {
  label: string;
  collection: string;
  operation: string;
  effect: string;
  call?: CallExpression;
  at: SourcePoint;
}

function dbOpsIn(ctx: Ctx, fn: Functionish): DbOp[] {
  const file = ctx.reader.relative(fn.getSourceFile());
  const start = fn.getStartLineNumber();
  const end = fn.getEndLineNumber();
  const found: DbOp[] = [];
  for (const step of ctx.flow.steps) {
    if (step.kind !== 'db-op' || step.file !== file || !step.line) continue;
    if (step.line < start || step.line > end) continue;
    const operation = String(step.meta?.['operation'] ?? '');
    const call = callAtLine(fn.getSourceFile(), step.line, operation);
    if (call && nearestFunction(call) !== fn && !fn.containsRange(call.getPos(), call.getEnd()))
      continue;
    found.push({
      label: step.label,
      collection: String(step.meta?.['collection'] ?? ''),
      operation,
      effect: String(step.meta?.['effect'] ?? step.meta?.['access'] ?? 'write'),
      ...(call ? { call } : {}),
      at: { file, line: step.line },
    });
  }
  return found.sort((a, b) => a.at.line - b.at.line);
}

function stageService(ctx: Ctx): StageBody {
  if (ctx.calls.length === 0) return noRequest(ctx);
  const order: DocLine[] = [];
  const rows: DocRow[] = [];
  const transform: DocLine[] = [];
  let reads = 0;
  let writes = 0;
  const chains: string[] = [];

  for (const context of ctx.calls) {
    const services = context.backendFns.slice(1);
    if (services.length > 0) {
      chains.push(services.map((service) => code(service.label)).join(' → '));
      order.push({ text: services.map((service) => code(service.label)).join(' → ') });
    }
    for (const entry of context.backendFns) {
      for (const op of dbOpsIn(ctx, entry.fn)) {
        const conditions = op.call ? conditionsFor(op.call, entry.fn) : [];
        let does: string;
        if (op.effect === 'read') {
          reads += 1;
          const keys = op.call ? argumentKeys(op.call, 0) : [];
          does = `checks existing data${keys.length ? ` by ${keys.map(code).join(', ')}` : ''}`;
        } else {
          writes += 1;
          const docIndex = /^(update|replace|findOneAnd|findByIdAnd)/.test(op.operation) ? 1 : 0;
          const keys = op.call ? argumentKeys(op.call, docIndex) : [];
          const verb =
            { create: 'inserts', update: 'updates', delete: 'deletes' }[op.effect] ?? 'writes';
          does = `${verb}${keys.length ? ` ${keys.slice(0, 8).map(code).join(', ')}${keys.length > 8 ? ', …' : ''}` : ''}`;
        }
        rows.push({
          cells: [
            code(entry.label),
            code(op.label),
            does,
            conditions.length ? conditions.join(', ') : 'always',
          ],
          at: op.at,
        });
      }
      // Objects assembled in the service before being written.
      if (entry !== context.backendFns[0]) {
        for (const declaration of ownDescendants<import('ts-morph').VariableDeclaration>(
          entry.fn,
          SyntaxKind.VariableDeclaration,
        )) {
          const init = declaration.getInitializer();
          const value = init ? unwrap(init) : undefined;
          if (!value || !Node.isObjectLiteralExpression(value)) continue;
          const keys = objectKeysOf(value);
          if (keys.length < 2) continue;
          transform.push({
            text: `${code(declaration.getName())} is built in ${code(entry.label)} from ${keys.slice(0, 8).map(code).join(', ')}${keys.length > 8 ? ', …' : ''}`,
            at: ctx.reader.point(declaration),
          });
        }
      }
    }
  }
  const counts = [reads ? plural(reads, 'read') : '', writes ? plural(writes, 'write') : '']
    .filter(Boolean)
    .join(', ');
  return {
    summary:
      [chains.join(' · '), counts].filter(Boolean).join(': ') ||
      'No service logic — the handler does the work',
    ...(chains.length === 0 && !counts ? { absent: true as const } : {}),
    groups: [
      { label: 'Functions, in order', lines: order },
      {
        label: 'What it does, and when',
        lines: [],
        table: table(['In', 'Operation', 'Does', 'Runs when'], rows),
      },
      { label: 'Data it builds before writing', lines: transform, collapsed: transform.length > 3 },
    ],
  };
}

function stageDatabase(ctx: Ctx): StageBody {
  if (ctx.calls.length === 0) return noRequest(ctx);
  const rows: DocRow[] = [];
  const schemas: DocLine[] = [];
  const effects = new Map<string, Set<string>>();
  for (const context of ctx.calls) {
    for (const access of context.detail.data) {
      const label =
        (DB_EFFECT_LABEL as Record<string, string>)[access.effect as DbEffect] ?? access.effect;
      const set = effects.get(access.collection) ?? new Set<string>();
      set.add(access.effect === 'create' ? 'insert' : access.effect);
      effects.set(access.collection, set);
      rows.push({
        cells: [
          `**${access.collection}**`,
          code(access.operation),
          label,
          access.by ? code(access.by) : '',
        ],
        ...(access.file ? { at: { file: access.file, line: access.line ?? 1 } } : {}),
        tone: access.effect === 'delete' ? 'error' : access.effect === 'read' ? undefined : 'ok',
      });
      if (access.joins?.length)
        rows.push({ cells: ['', '', `also brings back ${access.joins.map(code).join(', ')}`, ''] });
    }
  }
  for (const collection of effects.keys()) {
    const schema = ctx.flow.steps.find((step) => step.detail?.schema?.collection === collection)
      ?.detail?.schema;
    if (schema && schema.fields.length > 0)
      schemas.push({
        text: `**${collection}** (${code(schema.model)}): ${schema.fields.map(code).join(', ')}`,
        ...(schema.file ? { at: { file: schema.file, line: 1 } } : {}),
      });
  }
  return {
    summary:
      [...effects.entries()]
        .map(([collection, set]) => `**${collection}** — ${[...set].join(', ')}`)
        .join(' · ') || 'No database operation could be read',
    groups: [
      {
        label: 'Operations',
        lines: [],
        table: table(['Collection', 'Operation', 'Effect', 'Called in'], rows),
      },
      { label: 'Schemas', lines: schemas, collapsed: true },
    ],
    ...(rows.length === 0 ? { absent: true as const } : {}),
    ...(rows.length === 0
      ? { empty: 'The request reaches no database operation that could be read.' }
      : {}),
  };
}

const RESULT_OF: Record<string, string> = {
  findOne: 'the first match, or null',
  findById: 'the document, or null',
  find: 'a list of matches',
  aggregate: 'the pipeline output',
  countDocuments: 'a count',
  count: 'a count',
  distinct: 'the distinct values',
  exists: 'whether one exists',
  insertOne: '`{ acknowledged, insertedId }`',
  insertMany: '`{ insertedCount, insertedIds }`',
  create: 'the created record',
  createMany: 'a count of created records',
  save: 'the saved document',
  updateOne: '`{ matchedCount, modifiedCount }`',
  updateMany: '`{ matchedCount, modifiedCount }`',
  update: 'the updated record',
  replaceOne: '`{ matchedCount, modifiedCount }`',
  findOneAndUpdate: 'the document (before or after the update)',
  findByIdAndUpdate: 'the document (before or after the update)',
  deleteOne: '`{ deletedCount }`',
  deleteMany: '`{ deletedCount }`',
  delete: 'the deleted record',
  findOneAndDelete: 'the deleted document',
  findByIdAndDelete: 'the deleted document',
  bulkWrite: 'counts per kind of write',
  upsert: 'the created or updated record',
};

function stageDbResult(ctx: Ctx): StageBody {
  if (ctx.calls.length === 0) return noRequest(ctx);
  const rows: DocRow[] = [];
  const kept: string[] = [];
  for (const context of ctx.calls) {
    for (const entry of context.backendFns) {
      for (const op of dbOpsIn(ctx, entry.fn)) {
        const result = RESULT_OF[op.operation] ?? 'the driver result';
        let use = '_not used_';
        if (op.call) {
          const declaration = op.call.getFirstAncestorByKind(SyntaxKind.VariableDeclaration);
          const returned = op.call.getFirstAncestorByKind(SyntaxKind.ReturnStatement);
          if (declaration && entry.fn.containsRange(declaration.getPos(), declaration.getEnd())) {
            const name = condense(declaration.getNameNode().getText(), 30);
            use = `kept as ${code(name)}`;
            kept.push(`${code(op.operation)} → ${code(name)}`);
          } else if (returned && entry.fn.containsRange(returned.getPos(), returned.getEnd())) {
            use = `returned from ${code(entry.label)}`;
            kept.push(`${code(op.operation)} → returned by ${code(entry.label)}`);
          }
        }
        rows.push({ cells: [code(op.label), result, use], at: op.at });
      }
    }
  }
  return {
    summary: kept.length
      ? `Results used: ${kept.join(', ')}`
      : 'Only acknowledgements come back; nothing reads them',
    ...(rows.length === 0 ? { absent: true as const } : {}),
    groups: [
      {
        label: 'What each operation gives back',
        lines: [],
        table: table(['Operation', 'Gives back', 'Then'], rows),
      },
    ],
  };
}

function stageResponse(ctx: Ctx): StageBody {
  if (ctx.calls.length === 0) return noRequest(ctx);
  const rows: DocRow[] = [];
  const observed: DocLine[] = [];
  const ok: string[] = [];
  const failed: string[] = [];
  const errorRow = (exit: GuardExit, from: string): void => {
    if (rows.some((row) => row.at?.line === exit.at.line && row.at.file === exit.at.file)) return;
    const status = exit.statuses.join(' or ');
    if (status) failed.push(status);
    rows.push({
      cells: [
        `**${status || '?'}**`,
        conditionText(exit.condition),
        exit.message ? `"${exit.message}"` : '',
        from,
      ],
      at: exit.at,
      tone: 'error',
    });
  };

  for (const context of ctx.calls) {
    const { detail } = context;
    const handler = context.backendFns[0];
    if (handler) {
      // The final return(s): the happy path.
      const finals = bodyStatements(handler.fn).filter((statement) =>
        Node.isReturnStatement(statement),
      );
      for (const statement of finals) {
        let expression = Node.isReturnStatement(statement) ? statement.getExpression() : undefined;
        if (!expression) continue;
        if (Node.isIdentifier(unwrap(expression))) {
          const declaration = localVariable(handler.fn, unwrap(expression).getText());
          const init =
            declaration && Node.isVariableDeclaration(declaration)
              ? declaration.getInitializer()
              : undefined;
          if (init && Node.isCallExpression(unwrap(init))) expression = init;
        }
        const status = statusOf(ctx.reader, expression);
        const call = unwrap(expression);
        // Only a response helper wraps the body; otherwise the returned value is the body.
        const bodyArg = status && Node.isCallExpression(call) ? call.getArguments()[0] : expression;
        const shape = bodyArg ? responseShape(ctx, bodyArg, handler.fn) : undefined;
        const statusText = status?.statuses.length
          ? status.statuses.join(' or ')
          : defaultStatus(detail);
        const decider = Node.isCallExpression(call) ? statusDecider(call) : undefined;
        ok.push(statusText);
        rows.push({
          cells: [
            `**${statusText}**`,
            decider ? `success — ${code(decider)} picks the code` : 'success',
            bodyArg
              ? shape && !Node.isObjectLiteralExpression(unwrap(bodyArg))
                ? shape
                : code(condense(bodyArg.getText(), 50))
              : '',
            code(handler.label),
          ],
          at: ctx.reader.point(statement),
          tone: 'ok',
        });
      }
      if (finals.length === 0 && /nestjs/.test(detail.route?.framework ?? '')) {
        ok.push(defaultStatus(detail));
        rows.push({
          cells: [
            `**${defaultStatus(detail)}**`,
            'success',
            `whatever ${code(handler.label)} returns, as JSON`,
            code(handler.label),
          ],
          tone: 'ok',
        });
      }
      for (const guard of guardsIn(ctx, handler.fn))
        for (const exit of guard.exits) errorRow(exit, code(guard.name));
      for (const check of backendSchemaChecks(ctx, handler.fn))
        if (check.exit) errorRow(check.exit, `${code(check.schema)} failed`);
      for (const service of context.backendFns)
        for (const exit of businessExits(ctx, service.fn, new Set()))
          if (exit.statuses.length) errorRow(exit, code(service.label));
      if (ownDescendants(handler.fn, SyntaxKind.TryStatement).length === 0) {
        rows.push({
          cells: [
            '**500**',
            'anything throws unexpectedly',
            '_framework default — no readable body_',
            '',
          ],
          tone: 'muted',
        });
      }
    }
    if (detail.response.statusCodes.length > 0) {
      observed.push({
        text: `Seen at runtime: ${detail.response.statusCodes.map((code) => `**${code}**`).join(', ')}`,
        tone: 'ok',
      });
    }
  }
  const unique = (list: string[]): string =>
    [...new Set(list.flatMap((entry) => entry.split(' or ')))].sort().join(', ');
  return {
    summary:
      (ok.length ? `**${unique(ok)}** on success` : '') +
      (failed.length ? ` · **${unique(failed)}** on failure` : ''),
    groups: [
      {
        label: 'Every response the route can send',
        lines: observed,
        table: table(['Status', 'When', 'Body / message', 'From'], rows),
      },
    ],
  };
}

function defaultStatus(detail: ApiCallDetail): string {
  if (/nestjs/.test(detail.route?.framework ?? '')) return detail.method === 'POST' ? '201' : '200';
  return '200';
}

/** `{ status: result.action === "added" ? 201 : 200 }` -> the condition. */
function statusDecider(call: CallExpression): string | undefined {
  for (const arg of call.getArguments()) {
    const object = unwrap(arg);
    if (!Node.isObjectLiteralExpression(object)) continue;
    const status = object.getProperty('status');
    if (status && Node.isPropertyAssignment(status)) {
      const init = status.getInitializer();
      if (init && Node.isConditionalExpression(unwrap(init)))
        return condense(
          (unwrap(init) as import('ts-morph').ConditionalExpression).getCondition().getText(),
          50,
        );
    }
  }
  return undefined;
}

/** `result` -> `{ product, action }`, from what the function that produced it returns. */
function responseShape(ctx: Ctx, body: Node, fn: Functionish): string | undefined {
  const value = unwrap(body);
  if (Node.isObjectLiteralExpression(value)) return code(`{ ${objectKeysOf(value).join(', ')} }`);
  if (!Node.isIdentifier(value)) return undefined;
  const declaration = localVariable(fn, value.getText());
  const init =
    declaration && Node.isVariableDeclaration(declaration)
      ? declaration.getInitializer()
      : undefined;
  const call = init ? unwrap(init) : undefined;
  if (!call || !Node.isCallExpression(call) || !Node.isIdentifier(call.getExpression()))
    return undefined;
  const name = call.getExpression().getText();
  const producer = ctx.reader.functionNamed(name, call.getSourceFile());
  if (!producer) return `the result of ${code(`${name}()`)}`;
  const keys = new Set<string>();
  for (const returned of returnsOf(producer)) {
    const object = unwrap(returned);
    if (Node.isObjectLiteralExpression(object))
      for (const key of objectKeysOf(object)) keys.add(key);
  }
  const declared = producer.getReturnTypeNode()?.getText();
  if (keys.size > 0) return `${code(`{ ${[...keys].join(', ')} }`)} from ${code(`${name}()`)}`;
  return declared
    ? `${code(condense(declared, 80))} from ${code(`${name}()`)}`
    : `the result of ${code(`${name}()`)}`;
}

function stageReceive(ctx: Ctx): StageBody {
  if (ctx.calls.length === 0) return noRequest(ctx);
  const groups: DocGroup[] = [];
  const summaries: string[] = [];
  for (const context of ctx.calls) {
    const prefix = ctx.calls.length > 1 ? `${context.detail.endpoint} · ` : '';
    const lines: DocLine[] = [];
    const interceptors: DocLine[] = [];
    let handsBack = '';
    if (context.call) {
      const statement = context.call.getFirstAncestor(
        (node) => Node.isStatement(node) && nearestFunction(node) === context.fn,
      );
      lines.push({
        text: `${context.detail.awaited ? 'Awaited' : '**Not awaited**'} in ${code(context.fn ? qualified(context.fn) : '?')}: ${code(condense(statement?.getText() ?? context.call.getText(), 90))}`,
        at: ctx.reader.point(context.call),
      });
      if (context.fn) {
        for (const returned of returnsOf(context.fn)) {
          if (returned.containsRange(context.call.getPos(), context.call.getEnd())) continue;
          handsBack = condense(returned.getText(), 40);
          lines.push({ text: `Hands back ${code(handsBack)}`, at: ctx.reader.point(returned) });
        }
      }
      if (context.hook)
        lines.push({
          text: `React Query (${code(context.hook.name)}) tracks the loading and error state`,
          at: ctx.reader.point(context.hook.fn),
        });
      const client = clientFacts(ctx, context.call);
      interceptors.push(...(client?.responseInterceptors ?? []));
    }
    const landed = realState(context);
    if (landed.length > 0) lines.push({ text: `Stored in state: ${landed.map(code).join(', ')}` });
    groups.push({ label: `${prefix}Response arrives`, lines });
    groups.push({
      label: `${prefix}Response interceptor (runs first)`,
      lines: interceptors,
      collapsed: interceptors.length > 2,
    });
    summaries.push(
      `${context.fn ? code(shortName(qualified(context.fn))) : 'The caller'} ${context.detail.awaited ? 'awaits it' : 'does not await it'}` +
        (handsBack ? ` and returns ${code(handsBack)}` : '') +
        (interceptors.length ? ' · the response interceptor runs first' : ''),
    );
  }
  return { summary: summaries.join(' · '), groups };
}

/**
 * State the response lands in, minus plain locals.
 *
 * `const { data } = await api.post(…)` names a variable, not React state; it
 * is reported by the request stage already and would read here as the screen
 * changing.
 */
function realState(context: CallContext): string[] {
  return context.detail.response.landsInState.filter(
    (name) =>
      !context.fn ||
      !localVariable(context.fn, name) ||
      nearestFunction(localVariable(context.fn, name)!) !== context.fn,
  );
}

interface ReactionRow {
  phase: ReactionPhase;
  kind: ReactionKind;
  text: string;
  where: string;
  at?: SourcePoint;
}

const KIND_WORD: Record<ReactionKind, string> = {
  'State update': 'state update',
  'Query invalidation': 'refetch',
  'Cache update': 'cache update',
  Navigation: 'navigation',
  'Toast/notification': 'toast',
  'Modal close': 'closes dialog',
  Other: 'call',
};

/** Everything the frontend does once the response is back, by phase. */
function reactionRows(ctx: Ctx): ReactionRow[] {
  const rows: ReactionRow[] = [];
  const add = (row: ReactionRow): void => {
    if (rows.some((existing) => existing.phase === row.phase && existing.text === row.text)) return;
    rows.push(row);
  };
  if (ctx.calls.length === 0) {
    // Local-only: what the handler changes is the whole response.
    for (const entry of ctx.front) {
      for (const call of ownCallsOf(entry.fn, entry.fn)) {
        const reaction = classifyReaction(call);
        if (reaction && reaction.kind !== 'Other')
          add({
            phase: 'always',
            kind: reaction.kind,
            text: reaction.text,
            where: code(shortName(entry.name)),
            at: ctx.reader.point(call),
          });
      }
    }
  }
  for (const context of ctx.calls) {
    for (const reaction of reactionsFor(ctx, context)) {
      for (const call of reaction.calls) {
        const classified = classifyReaction(call);
        if (!classified) continue;
        add({
          phase: reaction.phase,
          kind: classified.kind,
          text: classified.text,
          where: reaction.where,
          at: ctx.reader.point(call),
        });
      }
    }
    for (const name of realState(context))
      add({
        phase: 'on success',
        kind: 'State update',
        text: `the response is stored in ${code(name)}`,
        where: '',
      });
  }
  return rows;
}

function refetches(ctx: Ctx): string[] {
  return [...new Set(ctx.apis.aftermath.invalidates.flatMap((entry) => entry.refetches))];
}

function stageResponseHandler(ctx: Ctx): StageBody {
  const rows = reactionRows(ctx);
  const refetched = refetches(ctx);
  const groupFor = (phase: ReactionPhase, label: string, tone: Tone): DocGroup => ({
    label,
    lines: [],
    tone,
    table: table(
      ['Does', 'Detail', 'Written in'],
      rows
        .filter((row) => row.phase === phase)
        .map((row) => ({
          cells: [KIND_WORD[row.kind], row.text, row.where],
          ...(row.at ? { at: row.at } : {}),
        })),
    ),
  });
  const kinds = (phase: ReactionPhase): string =>
    [
      ...new Set(
        rows
          .filter((row) => row.phase === phase && row.kind !== 'Other')
          .map((row) => KIND_WORD[row.kind]),
      ),
    ].join(', ');
  const success = kinds('on success');
  const failure = kinds('on error');
  const handlesErrors = rows.some((row) => row.phase === 'on error');
  return {
    summary:
      ctx.calls.length === 0
        ? kinds('always') || 'Nothing visible changes'
        : `Success: ${success || 'nothing visible'}` +
          ` · Error: ${handlesErrors ? failure || 'handled quietly' : '**not handled**'}`,
    groups: [
      groupFor('on success', 'On success', 'ok'),
      groupFor('on error', 'On error', 'error'),
      groupFor('always', ctx.calls.length === 0 ? 'What the handler changes' : 'Always', 'muted'),
      {
        label: 'Refetched because a cache was invalidated',
        lines: refetched.length
          ? [
              {
                text: `${refetched.map(code).join(', ')} fetch again from whichever component shows them`,
              },
            ]
          : [],
      },
    ],
  };
}

function stageFinalUi(ctx: Ctx): StageBody {
  const rows = reactionRows(ctx);
  const refetched = refetches(ctx);
  const onSuccess: DocLine[] = [];
  const onError: DocLine[] = [];
  const onInvalid: DocLine[] = [];

  for (const row of rows) {
    if (row.kind === 'Query invalidation' && refetched.length) continue;
    const phrase = describeOutcome(row.kind, row.text);
    if (!phrase) continue;
    if (row.phase === 'on error') onError.push({ text: phrase });
    else if (row.phase === 'on success') onSuccess.push({ text: phrase });
    else {
      onSuccess.push({ text: phrase });
      if (ctx.calls.length) onError.push({ text: phrase });
    }
  }
  if (refetched.length)
    onSuccess.push({
      text: `Data on screen refreshes — ${refetched.map(code).join(', ')} load again`,
    });
  if (ctx.calls.length > 0 && onError.length === 0) {
    onError.push({
      text: 'Nothing handles the failure — the screen stays as it was, with no message',
      tone: 'warn',
    });
  }
  const closes = onSuccess.some((line) => /closes/.test(line.text));
  if (closes && !onError.some((line) => /closes/.test(line.text))) {
    onError.push({
      text: 'The form stays open with what was typed, so the user can fix it and retry',
    });
  }
  for (const entry of ctx.front) {
    if (entry.role === 'request') continue;
    for (const check of stoppingChecks(entry.fn)) {
      if (confirmationsOf(ctx).some((confirm) => confirm.node === check.node)) {
        onInvalid.push({
          text: `The user cancels the dialog (${code(check.condition)}) → nothing changes; no request is made`,
        });
        continue;
      }
      const shows = check.does.filter((does) => /^set[A-Z]|toast|alert|notify/.test(does));
      onInvalid.push({
        text: `${code(check.condition)} → ${shows.length ? shows.map(code).join(', ') : 'stops quietly'}; no request is made`,
      });
    }
  }

  const headline = [
    rows.some((row) => row.phase !== 'on error' && row.kind === 'Modal close')
      ? 'the dialog closes'
      : '',
    rows.some((row) => row.phase !== 'on error' && row.kind === 'Navigation')
      ? 'the user is sent to another page'
      : '',
    rows.some((row) => row.phase !== 'on error' && row.kind === 'Toast/notification')
      ? 'a toast confirms it'
      : '',
    refetched.length ? 'the data on screen refreshes' : '',
  ].filter(Boolean);
  return {
    summary: headline.length
      ? `On success ${headline.join(', ')}`
      : ctx.calls.length
        ? 'Nothing visible changes on success'
        : 'Only what is on screen changes',
    groups: [
      {
        label: ctx.calls.length ? 'After a successful response' : 'After the click',
        lines: onSuccess,
        tone: 'ok',
      },
      {
        label: 'After a failed response',
        lines: ctx.calls.length > 0 ? onError : [],
        tone: 'error',
      },
      { label: 'If the frontend check fails', lines: onInvalid, tone: 'warn' },
    ],
  };
}

function describeOutcome(kind: ReactionKind, text: string): string | undefined {
  switch (kind) {
    case 'Toast/notification':
      return `A toast appears — ${text}`;
    case 'Modal close':
      return `The dialog closes (${text})`;
    case 'Navigation':
      return `The user is taken elsewhere: ${text}`;
    case 'Query invalidation':
      return `Cached data is marked stale: ${text}`;
    case 'Cache update':
      return `The cached data is updated in place: ${text}`;
    case 'State update':
      return `Screen state changes: ${text}`;
    default:
      return undefined;
  }
}

// ---------------------------------------------------------------------------
// Markdown
// ---------------------------------------------------------------------------

/**
 * The document as Markdown: the at-a-glance flow first, as the vertical chain
 * a developer skims in ten seconds, then every stage in detail with its facts
 * as tables and a `file:line` on each.
 */
export function renderActionDocument(doc: ActionDoc): string {
  const out: string[] = [];
  out.push(`# ${doc.title}`, '');
  out.push(`**The user ${doc.trigger}${doc.screen ? ` on ${doc.screen}` : ''}.**`, '');
  const meta = [
    doc.endpoints.length ? `Requests: ${doc.endpoints.map(code).join(', ')}` : 'No requests',
    doc.evidence === 'static'
      ? 'read from the source'
      : doc.evidence === 'confirmed'
        ? 'read from the source and seen running'
        : 'seen running',
    doc.source ? `starts at ${code(`${doc.source.file}:${doc.source.line}`)}` : '',
  ].filter(Boolean);
  out.push(meta.join(' · '), '');

  // Only the steps this action has, numbered as the reader will count them.
  const shown = doc.stages.filter((stage) => !stage.absent);
  const absent = doc.stages.filter((stage) => stage.absent);
  const number = new Map(shown.map((stage, index) => [stage.key, index + 1]));

  out.push('## At a glance', '', '```text');
  const width = Math.max(...shown.map((stage) => stage.title.length)) + 2;
  let phase: Phase | undefined;
  for (const stage of shown) {
    if (stage.phase !== phase) {
      if (phase) out.push('        │', '        ▼');
      phase = stage.phase;
      out.push(PHASE_TITLES[phase].toUpperCase());
    }
    const marker = stage.groups.length === 0 ? '·' : '●';
    out.push(
      `  ${String(number.get(stage.key)).padStart(2)} ${marker} ${stage.title.padEnd(width)}${plain(stage.summary)}`,
    );
  }
  out.push('```', '');
  if (absent.length > 0) {
    out.push('**Not in this action**', '');
    for (const stage of absent) out.push(`- ${stage.title} — ${stage.summary}`);
    out.push('');
  }

  out.push('## In detail', '');
  phase = undefined;
  for (const stage of shown) {
    if (stage.phase !== phase) {
      phase = stage.phase;
      out.push(`### ${PHASE_TITLES[phase]}`, '');
    }
    out.push(`#### ${number.get(stage.key)}. ${stage.title}`, '');
    if (stage.summary) out.push(`> ${stage.summary}`, '');
    if (stage.groups.length === 0) {
      out.push(`_${stage.empty ?? 'Nothing found.'}_`, '');
      continue;
    }
    for (const group of stage.groups) {
      const body: string[] = [];
      for (const line of group.lines) pushLine(body, line, 0);
      if (group.table && group.table.rows.length > 0) {
        if (body.length) body.push('');
        pushTable(body, group.table);
      }
      if (group.collapsed) {
        out.push(`<details><summary>${group.label}</summary>`, '', ...body, '', '</details>', '');
      } else {
        out.push(`**${group.label}**`, '', ...body, '');
      }
    }
  }

  out.push('## What this document cannot see', '');
  for (const limit of doc.limits) out.push(`- ${limit}`);
  out.push('');
  return out.join('\n');
}

function ref(at: SourcePoint | undefined): string {
  return at?.file ? ` _(${at.file}:${at.line})_` : '';
}

function pushLine(out: string[], line: DocLine, depth: number): void {
  out.push(`${'  '.repeat(depth)}- ${line.text}${ref(line.at)}`);
  for (const sub of line.sub ?? []) pushLine(out, sub, depth + 1);
}

function pushTable(out: string[], data: DocTable): void {
  const cell = (text: string): string => text.replace(/\|/g, '\\|').replace(/\n/g, ' ');
  const hasRefs = data.rows.some((row) => row.at?.file);
  const columns = hasRefs ? [...data.columns, 'Code'] : data.columns;
  out.push(`| ${columns.map((column) => cell(column || ' ')).join(' | ')} |`);
  out.push(`|${columns.map(() => '---').join('|')}|`);
  for (const row of data.rows) {
    const cells = hasRefs
      ? [...row.cells, row.at?.file ? code(`${baseName(row.at.file)}:${row.at.line}`) : '']
      : row.cells;
    out.push(`| ${cells.map((value) => cell(value)).join(' | ')} |`);
  }
}

/** Markdown markers stripped for the at-a-glance block, which is a code block. */
function plain(text: string): string {
  return text
    .replace(/\*\*/g, '')
    .replace(/`/g, '')
    .replace(/(^|\s)_([^_]+)_/g, '$1$2');
}

export type { SchemaFacts };
