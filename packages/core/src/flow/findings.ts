/**
 * Findings: bugs the graph and the source can show, each with the line to open.
 *
 * Six checks, chosen because each is a real, common defect in a UI → API → DB
 * app that a reader of one file cannot see, and that the graph already has
 * the joins for:
 *
 *   - no-auth              a route nothing guards
 *   - tenant-scope         a query on a tenant-scoped collection that forgets the tenant
 *   - tenant-from-request  the tenant id comes from the client, not the login
 *   - mass-assignment      the request body written to the database as is
 *   - n-plus-one           a query run once per item of a loop
 *   - sequential-awaits    independent reads awaited one after another
 *
 * The rule for every check is the same: flag only what the code shows. A
 * filter built somewhere this module cannot read is skipped, not guessed at —
 * a findings list that cries wolf gets ignored, which is worse than a short
 * one. Every finding says why it matters and how to fix it, and says when
 * something it cannot see (a check in another service, a schema that strips
 * fields) would make it a false alarm.
 */

import { Node, SyntaxKind, type CallExpression, type SourceFile } from 'ts-morph';
import type { Functionish } from '../analyzer/ast.js';
import type { FlowGraph } from '../graph/graph.js';
import type { FlowNode } from '../graph/types.js';
import {
  condense,
  localVariable,
  nameOf,
  nearestFunction,
  SourceReader,
  type SourcePoint,
} from './actionsource.js';
import { resolveFlows } from './resolve.js';

export type FindingKind =
  | 'no-auth'
  | 'tenant-scope'
  | 'tenant-from-request'
  | 'mass-assignment'
  | 'n-plus-one'
  | 'sequential-awaits';

export type FindingSeverity = 'high' | 'medium' | 'low';

export interface Finding {
  /** Stable across scans of unchanged code: kind + place. */
  id: string;
  kind: FindingKind;
  severity: FindingSeverity;
  /** One line: what is wrong, where. */
  title: string;
  /** Why it matters, in this code. */
  why: string;
  /** What to change. */
  fix: string;
  at: SourcePoint;
  /** The line(s) of code the finding is about, as written. */
  code?: string;
  /** Other places the reader needs: the loop, the guard it lacks, the sibling query. */
  related?: Array<{ text: string; at: SourcePoint }>;
  /** Graph nodes it is about — how it is tied to actions. */
  nodeIds: string[];
  /** The user actions that run through it. */
  flowIds: string[];
}

export interface ProjectFindings {
  findings: Finding[];
  /** The field this project scopes its data by, when one was found. */
  tenantKey?: string;
  checked: { routes: number; queries: number };
  notes: string[];
}

export interface FindingsOptions {
  reader?: SourceReader;
}

const SEVERITY_ORDER: Record<FindingSeverity, number> = { high: 0, medium: 1, low: 2 };

/** Every finding in the scanned project, most severe first. */
export function projectFindings(graph: FlowGraph, options: FindingsOptions = {}): ProjectFindings {
  const reader = options.reader ?? new SourceReader(graph);
  const ctx: Ctx = { graph, reader, findings: [], notes: [], queries: [] };

  readQueries(ctx);
  const tenantKey = chooseTenantKey(ctx);
  safely(ctx, 'routes', () => checkRoutes(ctx, tenantKey));
  safely(ctx, 'tenant scoping', () => checkTenantScope(ctx, tenantKey));
  safely(ctx, 'mass assignment', () => checkMassAssignment(ctx));
  safely(ctx, 'loops', () => checkLoops(ctx));
  safely(ctx, 'sequential awaits', () => checkSequentialAwaits(ctx));

  // Tie each finding to the user actions that run through its nodes.
  const flows = resolveFlows(graph, { includeLocalOnly: true });
  for (const finding of ctx.findings) {
    finding.flowIds = flows
      .filter((flow) => flow.steps.some((step) => finding.nodeIds.includes(step.nodeId)))
      .map((flow) => flow.id);
  }

  const seen = new Set<string>();
  const findings = ctx.findings
    .filter((finding) => (seen.has(finding.id) ? false : (seen.add(finding.id), true)))
    .sort(
      (a, b) =>
        SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity] ||
        a.at.file.localeCompare(b.at.file) ||
        a.at.line - b.at.line,
    );

  return {
    findings,
    ...(tenantKey ? { tenantKey } : {}),
    checked: {
      routes: graph.nodesOfKind('route').length,
      queries: ctx.queries.length,
    },
    notes: ctx.notes,
  };
}

// ---------------------------------------------------------------------------
// Shared reading
// ---------------------------------------------------------------------------

interface QueryFacts {
  node: FlowNode;
  collection: string;
  operation: string;
  effect: string;
  call: CallExpression;
  fn?: Node;
  /** Keys of the filter, when every part of it could be read. */
  filter?: FilterKeys;
  at: SourcePoint;
}

interface FilterKeys {
  keys: Set<string>;
  /** `ownerId` -> the expression that fills it. */
  values: Map<string, string>;
  /** False when part of the filter was built somewhere unreadable. */
  complete: boolean;
}

interface Ctx {
  graph: FlowGraph;
  reader: SourceReader;
  findings: Finding[];
  notes: string[];
  queries: QueryFacts[];
}

// ---------------------------------------------------------------------------
// Per-file line index
//
// ts-morph's `getStartLineNumber()` counts newlines from the top of the file
// on every call. Finding each of a thousand queries by line that way spent
// three minutes on one backend; TypeScript's own line map answers the same
// question by binary search, and each file is indexed once.
// ---------------------------------------------------------------------------

interface FileIndex {
  callsByLine: Map<number, CallExpression[]>;
  functions: Array<{ fn: Functionish; start: number; end: number }>;
}

const fileIndexes = new WeakMap<SourceFile, FileIndex>();

function lineAt(file: SourceFile, position: number): number {
  return file.compilerNode.getLineAndCharacterOfPosition(position).line + 1;
}

function indexOf(file: SourceFile): FileIndex {
  const cached = fileIndexes.get(file);
  if (cached) return cached;
  const callsByLine = new Map<number, CallExpression[]>();
  const add = (line: number, call: CallExpression): void => {
    const list = callsByLine.get(line);
    if (!list) callsByLine.set(line, [call]);
    else if (!list.includes(call)) list.push(call);
  };
  const functions: FileIndex['functions'] = [];
  file.forEachDescendant((node) => {
    if (Node.isCallExpression(node)) {
      add(lineAt(file, node.getStart()), node);
      // A chained call is often recorded on the line its callee ends on.
      add(lineAt(file, node.getExpression().getEnd()), node);
    } else if (
      Node.isMethodDeclaration(node) ||
      Node.isFunctionDeclaration(node) ||
      Node.isArrowFunction(node) ||
      Node.isFunctionExpression(node)
    ) {
      functions.push({
        fn: node as Functionish,
        start: lineAt(file, node.getStart()),
        end: lineAt(file, node.getEnd()),
      });
    }
  });
  const index = { callsByLine, functions };
  fileIndexes.set(file, index);
  return index;
}

/** The driver call for a db-op, found through the file's line index. */
function queryCallAt(
  ctx: Ctx,
  fileName: string,
  line: number,
  operation: string,
): CallExpression | undefined {
  const file = ctx.reader.file(fileName);
  if (!file) return undefined;
  const calls = indexOf(file).callsByLine.get(line) ?? [];
  const isOperation = (call: CallExpression): boolean => {
    const callee = call.getExpression();
    return Node.isPropertyAccessExpression(callee) && callee.getName() === operation;
  };
  const exact = calls.find(isOperation);
  if (exact) return exact;
  // The line's call wraps the query: `strip(await products.findOne(…))`.
  for (const call of calls) {
    const inner = call.getDescendantsOfKind(SyntaxKind.CallExpression).find(isOperation);
    if (inner) return inner;
  }
  return undefined;
}

function safely(ctx: Ctx, what: string, run: () => void): void {
  try {
    run();
  } catch (error) {
    ctx.notes.push(
      `The ${what} check stopped early: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

/** Operations whose first argument is the filter. */
const FILTER_FIRST = new Set([
  'find',
  'findOne',
  'countDocuments',
  'deleteOne',
  'deleteMany',
  'findOneAndDelete',
  'updateOne',
  'updateMany',
  'findOneAndUpdate',
  'replaceOne',
  'findOneAndReplace',
]);

/** Operations that fetch or change one document by id alone. */
const BY_ID = new Set(['findById', 'findByIdAndUpdate', 'findByIdAndDelete', 'findByIdAndRemove']);

function readQueries(ctx: Ctx): void {
  for (const node of ctx.graph.nodesOfKind('db-op')) {
    const operation = String(node.meta?.['operation'] ?? '');
    const collection = String(node.meta?.['collection'] ?? '');
    if (!node.source || !operation || !collection) continue;
    const call = queryCallAt(ctx, node.source.file, node.source.line, operation);
    if (!call) continue;
    const fn = nearestFunction(call);
    const facts: QueryFacts = {
      node,
      collection,
      operation,
      effect: String(
        node.meta?.['effect'] ?? (node.meta?.['access'] === 'write' ? 'write' : 'read'),
      ),
      call,
      ...(fn ? { fn } : {}),
      at: { file: node.source.file, line: node.source.line },
    };
    const filterArg = BY_ID.has(operation)
      ? undefined
      : operation === 'distinct'
        ? call.getArguments()[1]
        : FILTER_FIRST.has(operation)
          ? call.getArguments()[0]
          : undefined;
    if (BY_ID.has(operation)) {
      facts.filter = { keys: new Set(['_id']), values: new Map(), complete: true };
    } else if (filterArg && fn) {
      facts.filter = filterKeys(ctx, filterArg, fn, 0);
    } else if (FILTER_FIRST.has(operation) && call.getArguments().length === 0) {
      // `find()` with no filter: every document in the collection.
      facts.filter = { keys: new Set(), values: new Map(), complete: true };
    }
    ctx.queries.push(facts);
  }
}

/**
 * The keys a filter constrains, following variables to where they are built
 * (`const filter = { ownerId }`, `filter.status = x`, a helper's return) and
 * `$and` into its clauses. `$or` is not followed: a tenant key inside an `$or`
 * does not scope the query.
 */
function filterKeys(ctx: Ctx, node: Node, fn: Node, depth: number): FilterKeys {
  const result: FilterKeys = { keys: new Set(), values: new Map(), complete: true };
  const merge = (other: FilterKeys): void => {
    for (const key of other.keys) result.keys.add(key);
    for (const [key, value] of other.values) result.values.set(key, value);
    if (!other.complete) result.complete = false;
  };
  if (depth > 3) return { ...result, complete: false };

  let value = node;
  while (
    Node.isAsExpression(value) ||
    Node.isParenthesizedExpression(value) ||
    Node.isSatisfiesExpression(value) ||
    Node.isNonNullExpression(value)
  )
    value = value.getExpression();

  if (Node.isObjectLiteralExpression(value)) {
    for (const property of value.getProperties()) {
      if (Node.isShorthandPropertyAssignment(property)) {
        result.keys.add(property.getName());
        result.values.set(property.getName(), property.getName());
      } else if (Node.isPropertyAssignment(property)) {
        const key = property.getName().replace(/^['"]|['"]$/g, '');
        const init = property.getInitializer();
        if (key === '$and' && init && Node.isArrayLiteralExpression(init)) {
          for (const clause of init.getElements()) merge(filterKeys(ctx, clause, fn, depth + 1));
        } else if (key !== '$or' && key !== '$nor') {
          result.keys.add(key);
          if (init) result.values.set(key, condense(init.getText(), 80));
        }
      } else if (Node.isSpreadAssignment(property)) {
        merge(filterKeys(ctx, property.getExpression(), fn, depth + 1));
      } else {
        result.complete = false;
      }
    }
    return result;
  }

  if (Node.isIdentifier(value)) {
    const name = value.getText();
    const declaration = localVariable(fn, name);
    if (!declaration || !Node.isVariableDeclaration(declaration))
      return { ...result, complete: false };
    const init = declaration.getInitializer();
    if (!init) return { ...result, complete: false };
    const scope = nearestFunction(declaration) ?? fn;
    const unwrapped = Node.isAwaitExpression(init) ? init.getExpression() : init;
    if (Node.isCallExpression(unwrapped) && Node.isIdentifier(unwrapped.getExpression())) {
      // `const filter = productFilter(ownerId, query)`: read what the helper returns.
      const helper = ctx.reader.functionNamed(
        unwrapped.getExpression().getText(),
        unwrapped.getSourceFile(),
      );
      const returned = helper
        ?.getDescendantsOfKind(SyntaxKind.ReturnStatement)
        .filter((statement) => nearestFunction(statement) === helper)
        .map((statement) => statement.getExpression())
        .find((expression) => expression !== undefined);
      if (helper && returned) merge(filterKeys(ctx, returned, helper, depth + 1));
      else result.complete = false;
    } else {
      merge(filterKeys(ctx, init, scope, depth + 1));
    }
    // `filter.category = x` and `filter[key] = y` add to it later.
    for (const binary of scope.getDescendantsOfKind(SyntaxKind.BinaryExpression)) {
      if (binary.getOperatorToken().getKind() !== SyntaxKind.EqualsToken) continue;
      const left = binary.getLeft();
      if (Node.isPropertyAccessExpression(left) && left.getExpression().getText() === name) {
        result.keys.add(left.getName());
        result.values.set(left.getName(), condense(binary.getRight().getText(), 80));
      } else if (Node.isElementAccessExpression(left) && left.getExpression().getText() === name) {
        result.complete = false;
      }
    }
    return result;
  }

  return { ...result, complete: false };
}

/** The line of source a node sits on, trimmed, for quoting. */
function lineOf(node: Node): string {
  const text = node.getSourceFile().getFullText().split('\n')[node.getStartLineNumber() - 1] ?? '';
  return text.trim();
}

/** The whole statement a node is part of, dedented, capped. */
function statementOf(node: Node, max = 8): string {
  const statement =
    node.getFirstAncestor((ancestor) => Node.isStatement(ancestor) && !Node.isBlock(ancestor)) ??
    node;
  const lines = statement.getText().split('\n');
  const indents = lines
    .slice(1)
    .filter((line) => line.trim())
    .map((line) => /^\s*/.exec(line)![0].length);
  const cut = indents.length ? Math.min(...indents) : 0;
  const body = [lines[0]!, ...lines.slice(1).map((line) => line.slice(cut))];
  return (body.length > max ? [...body.slice(0, max), '…'] : body).join('\n');
}

function point(ctx: Ctx, node: Node): SourcePoint {
  return ctx.reader.point(node);
}

function fnName(fn: Node | undefined): string {
  return fn ? nameOf(fn) : 'this function';
}

function push(ctx: Ctx, finding: Omit<Finding, 'id' | 'flowIds'>): void {
  ctx.findings.push({
    ...finding,
    id: `${finding.kind}:${finding.at.file}:${finding.at.line}`,
    flowIds: [],
  });
}

// ---------------------------------------------------------------------------
// Tenant key
// ---------------------------------------------------------------------------

const TENANT_KEY =
  /^(owner|clinic|tenant|org|organization|organisation|account|company|workspace|hospital|business|shop|store|team|practice|pharmacy)_?id$/i;

/**
 * The field this project scopes its data by: the tenant-looking key that the
 * most query filters use. Needs a clear majority of evidence, because every
 * tenant finding depends on it.
 */
function chooseTenantKey(ctx: Ctx): string | undefined {
  const counts = new Map<string, number>();
  for (const query of ctx.queries) {
    for (const key of query.filter?.keys ?? []) {
      if (TENANT_KEY.test(key)) counts.set(key, (counts.get(key) ?? 0) + 1);
    }
  }
  const [best] = [...counts.entries()].sort((a, b) => b[1] - a[1]);
  if (!best || best[1] < 3) {
    ctx.notes.push(
      'No tenant field is used consistently in query filters, so tenant scoping was not checked.',
    );
    return undefined;
  }
  return best[0];
}

// ---------------------------------------------------------------------------
// Routes: no-auth and tenant-from-request
// ---------------------------------------------------------------------------

/** Paths that are public by design: signing in cannot require being signed in. */
const PUBLIC_PATH =
  /(^|[/_-])(auth|login|logout|signin|sign-in|signup|sign-up|register|otp|refresh|forgot|reset|verify|verification|health|healthz|status|ping|webhooks?|callback|public|metrics|docs|swagger)($|[/_-])/i;

/**
 * A call in a handler that checks who is asking. Deliberately narrow: a
 * handler calling `shopService.getSettings()` is not an auth check, and a
 * loose match here would hide exactly the unguarded routes this looks for.
 */
const AUTH_CALL =
  /^(require|ensure|assert|check|verify|validate)_?(auth|user|session|login|signed_?in|clinic|shop|tenant|access|permission|role|owner|member|admin|token|jwt)|^get_?(auth|current|session|signed_?in|logged_?in)_?(user|session|token)?$|^(getServerSession|getSession|currentUser|authenticate|authorize|isAuthenticated|withAuth|auth)$|^verify(Token|Jwt|IdToken)$/i;

/** What an auth check answers when it fails. */
const DENIES =
  /unauthori[sz]ed|forbidden|UnauthorizedException|ForbiddenException|status:\s*40[13]\b|\b40[13]\b/i;

function checkRoutes(ctx: Ctx, tenantKey: string | undefined): void {
  const globalAuth = globalMiddlewareAuth(ctx);
  for (const route of ctx.graph.nodesOfKind('route')) {
    const method = String(
      route.meta?.['httpMethod'] ?? route.label.split(' ')[0] ?? '',
    ).toUpperCase();
    const path = String(route.meta?.['path'] ?? route.label.split(' ').slice(1).join(' '));
    const handler = handlerOf(ctx, route);
    const guards = ctx.graph.successors(route.id, ['guarded-by']);
    const inHandler = handler ? authCallsIn(handler) : [];
    const guarded = guards.length > 0 || inHandler.length > 0 || globalAuth;
    const at = handler ? point(ctx, handler) : (route.source ?? { file: '', line: 1 });

    if (!guarded && !PUBLIC_PATH.test(path) && at.file) {
      const writes = ['POST', 'PUT', 'PATCH', 'DELETE'].includes(method);
      const touches = ctx.graph
        .successors(route.id, ['queries'])
        .map((op) => String(op.meta?.['collection'] ?? ''))
        .filter(Boolean);
      const collections = [...new Set(touches)];
      push(ctx, {
        kind: 'no-auth',
        severity: writes ? 'high' : collections.length ? 'medium' : 'low',
        title: `${method} ${path} runs without any auth check`,
        why:
          `No guard, middleware or sign-in check was found before the handler, so anyone who can reach the server can call it` +
          (collections.length
            ? ` — and it ${writes ? 'changes' : 'reads'} ${collections.map((c) => `\`${c}\``).join(', ')}.`
            : '.'),
        fix: 'Add the guard the other routes use (for NestJS, `@UseGuards(JwtAuthGuard)` on the method or controller), or mark it public on purpose and document why.',
        at,
        ...(handler ? { code: statementOf(handler, 3) } : {}),
        nodeIds: [route.id],
      });
    }

    if (tenantKey && handler) checkTenantFromRequest(ctx, route, handler, tenantKey, method, path);
  }
}

/** The function that answers a route. */
function handlerOf(ctx: Ctx, route: FlowNode): Functionish | undefined {
  for (const candidate of ctx.graph.successors(route.id, ['calls'])) {
    if (!candidate.source) continue;
    const file = ctx.reader.file(candidate.source.file);
    const fn = file ? functionContaining(file, candidate.source.line) : undefined;
    if (fn) return fn;
  }
  return undefined;
}

/** The innermost function starting on `line`, or else the smallest one around it. */
function functionContaining(file: SourceFile, line: number): Functionish | undefined {
  const { functions } = indexOf(file);
  const starting = functions.find((entry) => entry.start === line);
  if (starting) return starting.fn;
  let best: FileIndex['functions'][number] | undefined;
  for (const entry of functions) {
    if (entry.start > line || entry.end < line) continue;
    if (!best || entry.end - entry.start < best.end - best.start) best = entry;
  }
  return best?.fn;
}

/**
 * The auth checks in a handler's own body: an early exit that answers 401/403
 * (`if (!user) return unauthorized()`), whatever the helper is called, or a
 * call whose name says it checks the caller (`requireShop(request)`).
 */
function authCallsIn(handler: Node): Node[] {
  const denials = handler.getDescendantsOfKind(SyntaxKind.IfStatement).filter((statement) => {
    if (nearestFunction(statement) !== handler) return false;
    const then = statement.getThenStatement();
    return /\b(return|throw)\b/.test(then.getText()) && DENIES.test(then.getText());
  });
  if (denials.length) return denials;
  return handler.getDescendantsOfKind(SyntaxKind.CallExpression).filter((call) => {
    const callee = call.getExpression();
    const name = Node.isPropertyAccessExpression(callee) ? callee.getName() : callee.getText();
    // `jwt.verify(token, …)` and `auth()` count; so does `requireShop(request)`.
    return AUTH_CALL.test(name) || /\bjwt\.verify$/.test(callee.getText());
  });
}

/** Next.js `middleware.ts`/`proxy.ts` that checks auth and runs for API routes. */
function globalMiddlewareAuth(ctx: Ctx): boolean {
  for (const name of ['middleware', 'proxy'])
    for (const dir of ['', 'src/'])
      for (const ext of ['.ts', '.js']) {
        const file = ctx.reader.file(`${dir}${name}${ext}`);
        if (!file) continue;
        const text = file.getFullText();
        const skipsApi = /\(\?!api|\(\?!\/api/.test(text);
        if (!skipsApi && /auth|session|token|jwt|cookie/i.test(text)) return true;
      }
  return false;
}

/** `userHasShopAccess(…)`, `assertShopMember(…)`, `canAccessTenant(…)`. */
const MEMBERSHIP =
  /member|belongs|allowed|(has|can)\w*access|authori[sz]e|(assert|verify|check|ensure)\w*(clinic|shop|tenant|access|owner)/i;

function membershipCheck(ctx: Ctx, route: FlowNode, handler: Node): CallExpression | undefined {
  const inHandler = handler
    .getDescendantsOfKind(SyntaxKind.CallExpression)
    .find((call) => MEMBERSHIP.test(call.getExpression().getText()));
  if (inHandler) return inHandler;
  for (const method of ctx.graph.successors(route.id, ['calls'])) {
    for (const callee of ctx.graph.successors(method.id, ['calls'])) {
      if (!callee.source) continue;
      const file = ctx.reader.file(callee.source.file);
      const fn = file ? functionContaining(file, callee.source.line) : undefined;
      const found = fn
        ?.getDescendantsOfKind(SyntaxKind.CallExpression)
        .find((call) => MEMBERSHIP.test(call.getExpression().getText()));
      if (found) return found;
    }
  }
  return undefined;
}

/**
 * `@Query('shop_id') shopId`, `@Body() dto` with a `shop_id` field,
 * `body.shop_id`, `searchParams.get("shop_id")`: the client says which
 * tenant it is, so any signed-in user can name another one.
 */
function checkTenantFromRequest(
  ctx: Ctx,
  route: FlowNode,
  handler: Functionish,
  tenantKey: string,
  method: string,
  path: string,
): void {
  const plain = tenantKey.replace(/_/g, '').toLowerCase();
  const matchesKey = (text: string): boolean =>
    text.replace(/[_'"]/g, '').toLowerCase().includes(plain);
  let evidence: Node | undefined;

  // NestJS: a decorated parameter named for the tenant.
  const parameters =
    (handler as unknown as { getParameters?: () => Node[] }).getParameters?.() ?? [];
  for (const parameter of parameters) {
    if (!Node.isParameterDeclaration(parameter)) continue;
    const decorators = parameter.getDecorators().map((decorator) => decorator.getText());
    const fromRequest = decorators.find((text) => /^@(Query|Param|Body|Headers)\(/.test(text));
    if (fromRequest && (matchesKey(fromRequest) || matchesKey(parameter.getName()))) {
      evidence = parameter;
      break;
    }
  }
  // Anything in the handler reading the tenant off the request.
  if (!evidence) {
    evidence = handler.getDescendants().find((node) => {
      if (!Node.isPropertyAccessExpression(node) && !Node.isCallExpression(node)) return false;
      const text = node.getText();
      return (
        text.length < 120 &&
        /\b(req\.|request\.)?(query|body|params|searchParams)\b(\.get\(\s*['"]|\.)/.test(text) &&
        matchesKey(text.split(/query|body|params|searchParams/).pop() ?? '')
      );
    });
  }
  if (!evidence) return;

  // A membership check tying the tenant to the caller makes this safe — in the
  // handler, or one call down in the service it hands the tenant to.
  const membership = membershipCheck(ctx, route, handler);
  // `service.x(req.user._id, query.shop_id)`: the user is passed along too, so
  // the queries may scope by both — safe if every one of them does.
  const withUser = /\breq(uest)?\.user\b|\bcurrentUser\b|\buser\._?id\b/.test(handler.getText());
  push(ctx, {
    kind: 'tenant-from-request',
    severity: membership ? 'low' : withUser ? 'medium' : 'high',
    title: `${method} ${path} takes \`${tenantKey}\` from the request`,
    why: membership
      ? `The client says which tenant it is, and \`${membership.getExpression().getText()}\` (${ctx.reader.relative(membership.getSourceFile())}) looks like the check that the signed-in user belongs to it — confirm it covers every query this route runs.`
      : withUser
        ? `The client says which tenant it is. The signed-in user is passed along too, so this is safe only if every query it leads to filters by the user as well as \`${tenantKey}\` — a query on \`${tenantKey}\` alone lets a user reach another tenant's data.`
        : `The client says which tenant it is, and nothing here checks that the signed-in user belongs to it — any user can read or change another tenant's data by changing \`${tenantKey}\`.`,
    fix: `Take the tenant from the verified login (the JWT or session), or check the requested \`${tenantKey}\` against the user's own before using it.`,
    at: point(ctx, evidence),
    code: lineOf(evidence),
    nodeIds: [route.id],
  });
}

// ---------------------------------------------------------------------------
// Tenant scope
// ---------------------------------------------------------------------------

const UNSCOPED_OK = new Set([
  'insertOne',
  'insertMany',
  'create',
  'aggregate',
  'bulkWrite',
  'estimatedDocumentCount',
]);

function checkTenantScope(ctx: Ctx, tenantKey: string | undefined): void {
  if (!tenantKey) return;
  // Collections the project does scope somewhere: the rest may be global by design.
  const scoped = new Map<string, QueryFacts>();
  for (const query of ctx.queries)
    if (query.filter?.keys.has(tenantKey) && !scoped.has(query.collection))
      scoped.set(query.collection, query);

  for (const query of ctx.queries) {
    const example = scoped.get(query.collection);
    if (!example || UNSCOPED_OK.has(query.operation)) continue;
    if (!query.filter || !query.filter.complete || query.filter.keys.has(tenantKey)) continue;
    const writes = query.effect !== 'read';
    const byId =
      BY_ID.has(query.operation) || query.filter.keys.has('_id') || query.filter.keys.has('id');
    // Where the id comes from decides whether a client can aim it at another tenant.
    const origin = byId ? idOrigin(ctx, query) : 'unknown';
    // High only when a client is shown to be able to aim it; unknown stays medium.
    const severity: FindingSeverity =
      origin === 'server' ? 'low' : origin === 'request' ? 'high' : 'medium';
    const matched = query.filter.keys.size
      ? ` — it matches on ${[...query.filter.keys].map((key) => `\`${key}\``).join(', ')} alone`
      : ' — it has no filter at all';
    push(ctx, {
      kind: 'tenant-scope',
      severity,
      title: `\`${query.collection}.${query.operation}\` does not filter by \`${tenantKey}\``,
      why:
        `Other queries on \`${query.collection}\` are scoped by \`${tenantKey}\`, this one is not${matched}. ` +
        (origin === 'server'
          ? `Every caller passes an id the server made itself, so a client cannot aim it at another tenant today — but the first route that passes a client's id makes it a leak.`
          : origin === 'request'
            ? `A caller passes an id taken from the request, so any signed-in user can ${writes ? 'change' : 'read'} another tenant's document by sending its id.`
            : `It can ${writes ? 'change' : 'return'} another tenant's documents${byId ? ' to anyone who has or guesses an id' : ''}, unless a check in ${fnName(query.fn)}'s callers already proves the document belongs to the caller.`),
      fix: `Add \`${tenantKey}\` to the filter, the way \`${example.collection}.${example.operation}\` does.`,
      at: query.at,
      code: statementOf(query.call),
      related: [
        {
          text: `scoped the right way: ${example.collection}.${example.operation}`,
          at: example.at,
        },
      ],
      nodeIds: [query.node.id],
    });
  }
}

/** A value read off the request: route params, query, body. */
const FROM_REQUEST =
  /\b(req|request)\.(params|query|body)|\bparams\b|\bsearchParams\b|\bquery\.|\bbody\.|@(Param|Query|Body)\(/;

/**
 * Where the id in a by-id filter comes from: `request` when a caller passes
 * something off the request, `server` when every caller passes a value it
 * made or fetched itself, `unknown` otherwise. Followed one call up — through
 * the graph's `calls` edges into each caller's argument.
 */
function idOrigin(ctx: Ctx, query: QueryFacts): 'request' | 'server' | 'unknown' {
  const fn = query.fn;
  const idValue = query.filter?.values.get('id') ?? query.filter?.values.get('_id');
  const direct = query.call.getArguments()[0]?.getText() ?? '';
  if (FROM_REQUEST.test(idValue ?? '') || (BY_ID.has(query.operation) && FROM_REQUEST.test(direct)))
    return 'request';
  if (!fn) return 'unknown';
  // First the value where the query is written: `shipment._id` of an
  // shipment this function just created is the server's own.
  const idNode = idExpression(query);
  if (idNode) {
    const here = originOfValue(fn, idNode);
    if (here !== 'unknown') return here;
  }
  // The id is a parameter: look at what each caller passes for it.
  const parameters = (fn as unknown as { getParameters?: () => Node[] }).getParameters?.() ?? [];
  const idName = BY_ID.has(query.operation) ? direct : (idValue ?? '');
  const index = parameters.findIndex(
    (parameter) => Node.isParameterDeclaration(parameter) && parameter.getName() === idName,
  );
  if (index < 0) return 'unknown';
  const name = nameOf(fn).split('.').pop() ?? '';
  const owner = ctx.graph
    .predecessors(query.node.id, ['queries'])
    .find((node) => node.kind === 'method');
  if (!owner || !name) return 'unknown';
  const verdicts: Array<'request' | 'server' | 'unknown'> = [];
  for (const caller of ctx.graph.predecessors(owner.id, ['calls'])) {
    if (!caller.source) continue;
    const file = ctx.reader.file(caller.source.file);
    const callerFn = file ? functionContaining(file, caller.source.line) : undefined;
    if (!callerFn) continue;
    for (const call of callerFn.getDescendantsOfKind(SyntaxKind.CallExpression)) {
      const callee = call.getExpression();
      const called = Node.isPropertyAccessExpression(callee) ? callee.getName() : callee.getText();
      if (called !== name) continue;
      const argument = call.getArguments()[index];
      if (!argument) continue;
      verdicts.push(originOfValue(callerFn, argument));
    }
  }
  if (verdicts.length === 0) return 'unknown';
  if (verdicts.includes('request')) return 'request';
  return verdicts.every((verdict) => verdict === 'server') ? 'server' : 'unknown';
}

/** The expression that supplies the id: `findById(x)`'s `x`, or `{ _id: x }`'s `x`. */
function idExpression(query: QueryFacts): Node | undefined {
  const first = query.call.getArguments()[0];
  if (!first) return undefined;
  if (BY_ID.has(query.operation)) return first;
  if (!Node.isObjectLiteralExpression(first)) return undefined;
  for (const property of first.getProperties()) {
    if (Node.isShorthandPropertyAssignment(property) && /^_?id$/.test(property.getName()))
      return property.getNameNode();
    if (Node.isPropertyAssignment(property) && /^['"]?_?id['"]?$/.test(property.getName()))
      return property.getInitializer();
  }
  return undefined;
}

/**
 * `record.id` from a local `const record = await createX()`, `job.data.id`,
 * `crypto.randomUUID()`: server-made. `params.id`, `body.id`: from the request.
 */
function originOfValue(fn: Node, value: Node): 'request' | 'server' | 'unknown' {
  const text = value.getText();
  if (FROM_REQUEST.test(text)) return 'request';
  if (/randomUUID|nanoid|uuid|ObjectId\(|\bjob\.(data|id)\b/.test(text)) return 'server';
  const root = text.split(/[.[(]/)[0] ?? '';
  const parameters = (fn as unknown as { getParameters?: () => Node[] }).getParameters?.() ?? [];
  const parameter = parameters.find(
    (candidate) => Node.isParameterDeclaration(candidate) && candidate.getName() === root,
  );
  if (parameter && Node.isParameterDeclaration(parameter)) {
    const decorated = parameter
      .getDecorators()
      .map((decorator) => decorator.getText())
      .join(' ');
    if (/@(Param|Query|Body)\(/.test(decorated) || /job/i.test(root))
      return decorated ? 'request' : 'server';
    return 'unknown';
  }
  const declaration = localVariable(fn, root);
  if (declaration && Node.isVariableDeclaration(declaration)) {
    const init = declaration.getInitializer()?.getText() ?? '';
    if (FROM_REQUEST.test(init) || /\.json\(\)/.test(init)) return 'request';
    // Made or fetched here: `await createImportRecord(...)`, `await x.findOne(...)`, a literal.
    if (/^(await\s+)?[\w.]+\(/.test(init) || /^[{[`'"\d]/.test(init)) return 'server';
    if (/\bjob\b/.test(init)) return 'server';
  }
  return 'unknown';
}

// ---------------------------------------------------------------------------
// Mass assignment
// ---------------------------------------------------------------------------

/** Where the written object goes, per operation. */
const WRITTEN_ARG: Record<string, number> = {
  updateOne: 1,
  updateMany: 1,
  findOneAndUpdate: 1,
  findByIdAndUpdate: 1,
  replaceOne: 1,
  findOneAndReplace: 1,
  insertOne: 0,
  insertMany: 0,
  create: 0,
};

function checkMassAssignment(ctx: Ctx): void {
  const whitelisting = validationWhitelists(ctx);
  for (const query of ctx.queries) {
    const index = WRITTEN_ARG[query.operation];
    if (index === undefined || !query.fn) continue;
    const written = query.call.getArguments()[index];
    if (!written) continue;
    // The value that is spread or passed whole: `body`, `{ $set: dto }`, `{ ...req.body }`.
    const sources = wholeValues(written);
    for (const source of sources) {
      const origin = requestOrigin(query.fn, source);
      if (!origin) continue;
      if (origin.kind === 'dto' && whitelisting) continue;
      push(ctx, {
        kind: 'mass-assignment',
        severity: origin.kind === 'raw' ? 'high' : 'medium',
        title: `\`${query.collection}.${query.operation}\` writes \`${source.getText()}\` as it came in`,
        why:
          origin.kind === 'raw'
            ? `\`${source.getText()}\` is the request body, written without picking fields, so a client can set any field — a role, an owner, a price — by adding it to the request.`
            : `\`${source.getText()}\` is a DTO written whole. ${whitelisting === false ? 'The global `ValidationPipe` runs without `whitelist: true`, so' : 'Unless validation strips undeclared fields,'} fields the DTO does not declare pass straight into the database.`,
        fix:
          origin.kind === 'raw'
            ? 'Copy only the fields the client may set (`{ name: body.name, … }`), or parse it with a schema that strips unknown keys first.'
            : 'Turn on `new ValidationPipe({ whitelist: true })`, or copy the allowed fields explicitly.',
        at: point(ctx, source),
        code: statementOf(query.call),
        related: origin.at ? [{ text: origin.text, at: point(ctx, origin.at) }] : [],
        nodeIds: [query.node.id],
      });
      break;
    }
  }
}

/** True when a global `ValidationPipe` strips undeclared fields; false when it does not; undefined when none was found. */
function validationWhitelists(ctx: Ctx): boolean | undefined {
  for (const rel of ['src/main.ts', 'main.ts', 'src/main.js']) {
    const file = ctx.reader.file(rel);
    if (!file) continue;
    const text = file.getFullText();
    if (!/ValidationPipe/.test(text)) continue;
    return /whitelist\s*:\s*true/.test(text);
  }
  return undefined;
}

/** The identifiers written whole: the argument itself, `$set: x`, or `...x`. */
function wholeValues(written: Node): Node[] {
  if (Node.isIdentifier(written) || Node.isPropertyAccessExpression(written)) return [written];
  if (!Node.isObjectLiteralExpression(written)) return [];
  const values: Node[] = [];
  for (const property of written.getProperties()) {
    if (Node.isSpreadAssignment(property)) values.push(property.getExpression());
    else if (Node.isPropertyAssignment(property) && /^\$?set$/i.test(property.getName())) {
      const init = property.getInitializer();
      if (!init) continue;
      if (Node.isIdentifier(init) || Node.isPropertyAccessExpression(init)) values.push(init);
      else if (Node.isObjectLiteralExpression(init))
        for (const inner of init.getProperties())
          if (Node.isSpreadAssignment(inner)) values.push(inner.getExpression());
    }
  }
  return values;
}

/**
 * Whether a written value is the request as sent: `req.body`, `await
 * request.json()`, a `@Body()` parameter, or a parameter typed as a DTO.
 * A value that went through `schema.parse` is not.
 */
function requestOrigin(
  fn: Node,
  value: Node,
): { kind: 'raw' | 'dto'; text: string; at?: Node } | undefined {
  const text = value.getText();
  if (/\b(req|request)\.body\b/.test(text))
    return { kind: 'raw', text: 'read from the request here', at: value };
  if (!Node.isIdentifier(value)) return undefined;
  const name = text;
  const parameters = (fn as unknown as { getParameters?: () => Node[] }).getParameters?.() ?? [];
  const parameter = parameters.find(
    (candidate) => Node.isParameterDeclaration(candidate) && candidate.getName() === name,
  );
  if (parameter && Node.isParameterDeclaration(parameter)) {
    if (parameter.getDecorators().some((decorator) => /^@Body\(/.test(decorator.getText())))
      return { kind: 'dto', text: '`@Body()` parameter', at: parameter };
    const type = parameter.getTypeNode()?.getText() ?? '';
    if (/Dto\b|DTO\b/.test(type))
      return { kind: 'dto', text: `typed as \`${type}\``, at: parameter };
    return undefined;
  }
  const declaration = localVariable(fn, name);
  if (declaration && Node.isVariableDeclaration(declaration)) {
    const init = declaration.getInitializer()?.getText() ?? '';
    if (/\.parse\(|safeParse|validate/.test(init)) return undefined;
    if (/\b(req|request)\.(body|json\(\))/.test(init) || /await\s+\w+\.json\(\)/.test(init))
      return { kind: 'raw', text: 'read from the request here', at: declaration };
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Loops: N+1
// ---------------------------------------------------------------------------

const ITERATING = /^(map|forEach|flatMap|filter|reduce|some|every|find|findIndex)$/;

interface LoopFacts {
  loop: Node;
  /** `Promise.all(items.map(...))`: N queries at once rather than one after another. */
  parallel: boolean;
}

/** The loop that repeats `node`, up to the enclosing function. */
function loopAround(node: Node, stopAt: Node | undefined): LoopFacts | undefined {
  for (
    let current = node.getParent();
    current && current !== stopAt;
    current = current.getParent()
  ) {
    if (
      Node.isForStatement(current) ||
      Node.isForOfStatement(current) ||
      Node.isForInStatement(current) ||
      Node.isWhileStatement(current) ||
      Node.isDoStatement(current)
    ) {
      // `for (const x of ["a", "b"])` runs a known, small number of times.
      if (Node.isForOfStatement(current) && Node.isArrayLiteralExpression(current.getExpression()))
        return undefined;
      return { loop: current, parallel: false };
    }
    if (Node.isArrowFunction(current) || Node.isFunctionExpression(current)) {
      const call = current.getParent();
      if (call && Node.isCallExpression(call)) {
        const callee = call.getExpression();
        if (Node.isPropertyAccessExpression(callee) && ITERATING.test(callee.getName())) {
          if (Node.isArrayLiteralExpression(callee.getExpression())) return undefined;
          const parallel = Boolean(
            call.getFirstAncestor(
              (ancestor) =>
                Node.isCallExpression(ancestor) &&
                /Promise\.(all|allSettled)$/.test(ancestor.getExpression().getText()),
            ),
          );
          return { loop: call, parallel };
        }
      }
      return undefined;
    }
  }
  return undefined;
}

function checkLoops(ctx: Ctx): void {
  for (const query of ctx.queries) {
    // The query itself inside a loop.
    const direct = loopAround(query.call, query.fn?.getParent());
    if (direct) {
      reportLoop(ctx, query, direct, query.call);
      continue;
    }
    // Or its function called from inside a loop (one level up).
    if (!query.fn) continue;
    const name = nameOf(query.fn).split('.').pop() ?? '';
    if (!name || name === 'anonymous') continue;
    const owner = ctx.graph
      .predecessors(query.node.id, ['queries'])
      .find((node) => node.kind === 'method');
    if (!owner) continue;
    for (const caller of ctx.graph.predecessors(owner.id, ['calls'])) {
      if (!caller.source) continue;
      const file = ctx.reader.file(caller.source.file);
      const fn = file ? functionContaining(file, caller.source.line) : undefined;
      if (!fn) continue;
      const site = fn.getDescendantsOfKind(SyntaxKind.CallExpression).find((call) => {
        const callee = call.getExpression();
        const called = Node.isPropertyAccessExpression(callee)
          ? callee.getName()
          : callee.getText();
        return called === name;
      });
      const loop = site ? loopAround(site, fn.getParent()) : undefined;
      if (site && loop) {
        reportLoop(ctx, query, loop, site);
        break;
      }
    }
  }
}

function reportLoop(ctx: Ctx, query: QueryFacts, facts: LoopFacts, site: Node): void {
  const through = site === query.call ? '' : ` through \`${site.getText().split('(')[0]}\``;
  const avg = query.node.timing?.avgMs;
  push(ctx, {
    kind: 'n-plus-one',
    severity: facts.parallel ? 'low' : 'medium',
    title: `\`${query.collection}.${query.operation}\` runs once per item of a loop${through}`,
    why:
      (facts.parallel
        ? 'Every item starts its own query at once (`Promise.all` over a list): N round trips and N connections at the same time.'
        : 'Every item waits for its own query before the next starts: N round trips one after another, so it slows down as the list grows.') +
      (avg ? ` One run takes ${Math.round(avg)}ms on average here.` : ''),
    fix:
      query.effect === 'read'
        ? `Fetch them in one query — \`${query.collection}.find({ <key>: { $in: ids } })\` — and match the results up in memory.`
        : `Collect the changes and send them in one \`${query.collection}.bulkWrite([...])\` instead of one write per item.`,
    at: point(ctx, site),
    code: statementOf(facts.loop, 6),
    related:
      site === query.call ? [] : [{ text: `the query, in ${fnName(query.fn)}`, at: query.at }],
    nodeIds: [query.node.id],
  });
}

// ---------------------------------------------------------------------------
// Sequential awaits
// ---------------------------------------------------------------------------

/**
 * Two reads awaited one after the other where the second does not use the
 * first: `const a = await x.findOne(); const b = await y.find();`. Writes are
 * left alone — their order may matter.
 */
function checkSequentialAwaits(ctx: Ctx): void {
  const readsByStatement = new Map<Node, QueryFacts>();
  for (const query of ctx.queries) {
    if (query.effect !== 'read') continue;
    const await_ = query.call.getFirstAncestorByKind(SyntaxKind.AwaitExpression);
    if (!await_ || nearestFunction(await_) !== query.fn) continue;
    const statement = await_.getFirstAncestor(
      (node) => Node.isStatement(node) && !Node.isBlock(node),
    );
    if (!statement || loopAround(statement, query.fn?.getParent())) continue;
    readsByStatement.set(statement, query);
  }

  const done = new Set<Node>();
  for (const [statement, query] of readsByStatement) {
    if (done.has(statement)) continue;
    const block = statement.getParent();
    if (!block || !Node.isBlock(block)) continue;
    const statements = block.getStatements();
    const run: Array<{ statement: Node; query: QueryFacts }> = [{ statement, query }];
    const declared = new Set(namesDeclaredBy(statement));
    for (
      let index = statements.indexOf(statement as never) + 1;
      index < statements.length;
      index += 1
    ) {
      const next = statements[index]!;
      const nextQuery = readsByStatement.get(next);
      if (!nextQuery) break;
      // Uses an earlier result: it has to wait.
      const used = next
        .getDescendantsOfKind(SyntaxKind.Identifier)
        .some((id) => declared.has(id.getText()));
      if (used) break;
      run.push({ statement: next, query: nextQuery });
      for (const name of namesDeclaredBy(next)) declared.add(name);
    }
    if (run.length < 2) continue;
    for (const entry of run) done.add(entry.statement);
    const times = run
      .map((entry) => entry.query.node.timing?.avgMs)
      .filter((ms): ms is number => ms !== undefined);
    const saving =
      times.length === run.length
        ? ` Measured, they take ${times.map((ms) => `${Math.round(ms)}ms`).join(' + ')}; together they would take about ${Math.round(Math.max(...times))}ms.`
        : '';
    push(ctx, {
      kind: 'sequential-awaits',
      severity: 'low',
      title: `${run.length} independent reads in ${fnName(query.fn)} wait for each other`,
      why: `${run.map((entry) => `\`${entry.query.collection}.${entry.query.operation}\``).join(', ')} are awaited one after another, but none uses another's result, so the request pays for each round trip in turn.${saving}`,
      fix: 'Start them together: `const [a, b] = await Promise.all([ … , … ])`.',
      at: point(ctx, statement),
      code: run.map((entry) => lineOf(entry.statement)).join('\n'),
      nodeIds: run.map((entry) => entry.query.node.id),
    });
  }
}

function namesDeclaredBy(statement: Node): string[] {
  if (!Node.isVariableStatement(statement)) return [];
  return statement.getDeclarations().flatMap((declaration) => {
    const binding = declaration.getNameNode();
    return Node.isIdentifier(binding)
      ? [binding.getText()]
      : binding.getDescendantsOfKind(SyntaxKind.BindingElement).map((element) => element.getName());
  });
}
