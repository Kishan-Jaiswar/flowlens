import { Node, ts } from 'ts-morph';
import type { FlowGraph } from '../graph/graph.js';
import { condense, functionAtLine, SourceReader } from './actionsource.js';
import {
  actionDecisions,
  countOf,
  type ActionDecisions,
  type DecisionGroup,
  type DecisionNode,
} from './decisions.js';
import { expandedDecisions } from './shareddecisions.js';
import type { FeatureFlow } from './resolve.js';

/**
 * Every way a link's feature can go — and only that feature.
 *
 * A link like "Low" on a dashboard card does not call the backend: it opens
 * `/medicines?stockFilter=low-stock`, and the page it opens loads its list. The
 * page's own decision tree answers a wider question — every request it makes
 * as it opens, every filter it could be given. What makes the link *Low* is
 * the value it puts in the address, so this takes the requests that read that
 * value and carries the value through them: into the request, into the
 * helpers it is passed to (by their parameters), to every `if`, `?:`, `&&`,
 * `||` and `switch` it settles. Where the value settles a decision, only the
 * way it goes is drawn; a decision the value does not settle — the sign-in
 * check, a search the user may type — stays, because for this link it can
 * still go either way.
 *
 * Nothing here knows any project: the value is matched by its name wherever
 * the code reads it — `params.get("name")`, `query.name`, `body["name"]`, a
 * parameter it was passed to.
 */

export interface LinkInfo {
  /** The words on the link: `Low`. */
  label: string;
  /** Where it goes, as written: `/medicines?stockFilter=low-stock`. */
  href: string;
  /** The card or page it is on: `Needs attention`. */
  from?: string;
}

export interface LinkDecisionsOptions {
  reader?: SourceReader;
}

export function linkDecisions(
  graph: FlowGraph,
  flow: FeatureFlow,
  link: LinkInfo,
  options: LinkDecisionsOptions = {},
): ActionDecisions {
  const reader = options.reader ?? new SourceReader(graph);
  const full = actionDecisions(graph, flow, { reader });
  const query = new URLSearchParams(link.href.includes('?') ? link.href.split('?')[1] : '');
  const params = [...query.entries()];
  const path = link.href.split('?')[0] ?? link.href;

  const nodes: DecisionNode[] = [
    {
      type: 'step',
      kind: 'trigger',
      label: `You click “${link.label}”${link.from ? ` on ${link.from}` : ''}`,
      text: link.href,
      side: 'browser',
    },
    {
      type: 'step',
      kind: 'ui',
      label: `The browser opens ${path}${params.length ? ' with the filter in the address' : ''}`,
      text: link.href,
      side: 'browser',
    },
  ];
  const limits = [
    'Only what this link’s value changes is drawn — where it is read, the way it decides, ' +
      'the queries it narrows and the answer. Everything else the request does (signing in, ' +
      'the checks every request makes, the filters the link does not set) runs the same ' +
      'however the page is opened, and is in the page’s own actions.',
    'Read from the source, not run.',
  ];

  if (params.length === 0) {
    // Nothing in the address to follow: the link is just a way into the page.
    nodes.push(
      ...full.nodes.filter((node) => !(node.type === 'group' && node.kind === 'unlinked')),
    );
    return result(flow, link, nodes, limits);
  }

  const browserFiles = [
    ...new Set(
      [
        flow.source?.file,
        ...flow.steps
          .filter((step) => step.layer === 'ui' || step.layer === 'frontend')
          .map((step) => step.file),
      ].filter((file): file is string => !!file),
    ),
  ];
  for (const [name, value] of params) {
    const read = findRead(reader, browserFiles, name);
    nodes.push({
      type: 'step',
      kind: 'compute',
      label: `The page reads ${name} from the address: “${value}”`,
      text: read?.text ?? `${name}=${value}`,
      side: 'browser',
      ...(read ? { at: read.at } : {}),
    });
  }

  // The request that carries the value: the one whose handler reads it.
  // In full: a helper "opened above" may have been opened in a request not drawn here.
  const requests = collectRequests(expandedDecisions(full));
  const carrying = requests.filter((group) =>
    params.some(([name]) => fileMentions(reader, group.handledBy?.file, name)),
  );
  // What the address says for this link: its own values, and — for every other
  // name the page reads from the address — nothing.
  const known = new Map<string, string | undefined>();
  // What the page starts with, where it says so: `useState("")` is empty as it opens.
  for (const [name, value] of startingState(reader, browserFiles)) known.set(name, value);
  for (const name of addressNames(reader, browserFiles)) known.set(name, undefined);
  for (const [name, value] of params) known.set(name, value);
  const own = new Set(params.map(([name]) => name));
  for (const group of carrying.length ? carrying : requests.slice(0, 1)) {
    const scope: Scope = { known, bound: new Map(), own, marks: new Set() };
    const settled = settle(reader, group.nodes, scope);
    nodes.push({ ...group, nodes: ownPart(settled, scope.marks, false, true) });
  }
  if (carrying.length === 0) {
    limits.unshift(
      `No request was found reading ${params.map(([name]) => name).join(', ')}: the value may ` +
        'only change what the page shows, without asking the server.',
    );
  }
  nodes.push({
    type: 'step',
    kind: 'ui',
    label: `The page shows only what matches ${params.map(([name, value]) => `${name} “${value}”`).join(', ')}`,
    text: 'the list the server sent back',
    side: 'browser',
  });
  return result(flow, link, nodes, limits);
}

function result(
  flow: FeatureFlow,
  link: LinkInfo,
  nodes: DecisionNode[],
  limits: string[],
): ActionDecisions {
  return { flowId: flow.id, title: link.label, nodes, counts: countOf(nodes), limits };
}

/** The request groups of a tree, outermost first. */
function collectRequests(nodes: DecisionNode[]): DecisionGroup[] {
  const found: DecisionGroup[] = [];
  const visit = (list: DecisionNode[]) => {
    for (const node of list) {
      if (node.type === 'group') {
        if (node.kind === 'request') found.push(node);
        else visit(node.nodes);
      } else if (node.type === 'decision') node.branches.forEach((branch) => visit(branch.nodes));
      else if (node.type === 'try') {
        visit(node.nodes);
        if (node.catch) visit(node.catch.nodes);
      }
    }
  };
  visit(nodes);
  return found;
}

function fileMentions(reader: SourceReader, file: string | undefined, name: string): boolean {
  const text = file ? reader.file(file)?.getFullText() : undefined;
  return !!text && new RegExp(`['"\`]${escape(name)}['"\`]|\\.${escape(name)}\\b`).test(text);
}

/** `params.get("stockFilter")`, `router.query.stockFilter`, `searchParams.stockFilter`. */
function findRead(reader: SourceReader, files: string[], name: string) {
  const pattern = new RegExp(
    `\\.get\\(\\s*['"\`]${escape(name)}['"\`]\\s*\\)|\\bquery\\.${escape(name)}\\b|\\bquery\\[['"]${escape(name)}['"]\\]|\\bsearchParams\\.${escape(name)}\\b`,
  );
  return findLine(reader, files, pattern);
}

function findLine(reader: SourceReader, files: string[], pattern: RegExp) {
  for (const file of files) {
    const source = reader.file(file);
    if (!source) continue;
    const lines = source.getFullText().split('\n');
    const index = lines.findIndex((line) => pattern.test(line));
    if (index >= 0) return { text: condense(lines[index]!), at: { file, line: index + 1 } };
  }
  return undefined;
}

function escape(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Every name the page reads from its address: `params.get("x")`, `searchParams.x`, `query.x`. */
function addressNames(reader: SourceReader, files: string[]): string[] {
  const names = new Set<string>();
  const pattern =
    /(?:[sS]earchParams|params|query)\s*(?:\.get\(\s*['"`]([\w-]+)['"`]\s*\)|\.([A-Za-z_$][\w$]*)\b(?!\s*\())/g;
  for (const file of files) {
    const text = reader.file(file)?.getFullText() ?? '';
    for (const match of text.matchAll(pattern)) {
      const name = match[1] ?? match[2];
      if (name && !/^(get|has|set|entries|keys|values|toString|forEach|append|delete)$/.test(name))
        names.add(name);
    }
  }
  return [...names];
}

/**
 * State the page sets to a fixed value as it opens: `const [category,
 * setCategory] = useState("")` is "no category". Only a literal counts — a
 * value worked out at runtime is not known here.
 */
function startingState(reader: SourceReader, files: string[]): Map<string, string | undefined> {
  const found = new Map<string, string | undefined>();
  const pattern =
    /const\s*\[\s*([A-Za-z_$][\w$]*)\s*,\s*[A-Za-z_$][\w$]*\s*\]\s*=\s*(?:React\.)?useState(?:<[^>]*>)?\(\s*(""|''|``|null|undefined|false|0)?\s*\)/g;
  for (const file of files) {
    const text = reader.file(file)?.getFullText() ?? '';
    for (const match of text.matchAll(pattern)) {
      // `useState()` and `useState("")`, `null`, `false`, `0` all start out empty.
      found.set(match[1]!, undefined);
    }
  }
  return found;
}

interface Scope {
  /** Values by the name the address gives them; `undefined` is "not in the address". */
  known: Map<string, string | undefined>;
  /** Parameters of the helper being drawn that were passed one of those values. */
  bound: Map<string, string | undefined>;
  /** The link's own names: what it puts in the address. */
  own: Set<string>;
  /** What the link's own value decides or flows into: the part that is this feature. */
  marks: Set<DecisionNode>;
}

/** Code that reads one of the link's own values: `query.stockFilter`, a parameter it was passed to. */
function readsOwn(code: string, scope: Scope): boolean {
  const names = [...scope.own, ...scope.bound.keys()];
  return names.some((name) =>
    new RegExp(`(^|[^\\w$])${escape(name)}($|[^\\w$])|['"\`]${escape(name)}['"\`]`).test(code),
  );
}

/**
 * The link's own part of a request: what its value decides or flows into,
 * the queries that run beside it — the ones the value narrows — and the
 * answer. A helper box stays only when the value reaches inside it; the rest
 * (signing in, the checks every request makes, the filters the link does not
 * set) is the same however the page is opened.
 *
 * `live`: this list is in code the value reaches, so its queries are the ones
 * it narrows.
 */
function ownPart(
  nodes: DecisionNode[],
  marks: Set<DecisionNode>,
  live: boolean,
  top = false,
): DecisionNode[] {
  const out: DecisionNode[] = [];
  for (const node of nodes) {
    if (marks.has(node)) {
      out.push(node);
      continue;
    }
    switch (node.type) {
      case 'step':
        if (live && node.kind === 'db') out.push(node);
        break;
      case 'end':
        // The answer when it works: the list the page shows.
        if (
          top &&
          node.outcome === 'respond' &&
          (node.statuses ?? []).length > 0 &&
          (node.statuses ?? []).every((status) => status < 300)
        )
          out.push(node);
        break;
      case 'group': {
        const reached = hasMark(node.nodes, marks);
        // `Promise.all`, a loop: the same function, so its queries are the value's too.
        const beside = live && node.kind !== 'function' && hasQuery(node.nodes);
        if (!reached && !beside) break;
        const inner = ownPart(node.nodes, marks, true);
        if (inner.length) out.push({ ...node, nodes: inner });
        break;
      }
      case 'try':
        if (hasMark(node.nodes, marks) || live) out.push(...ownPart(node.nodes, marks, live));
        break;
      case 'decision':
        // A question the value did not settle is not this link's.
        break;
    }
  }
  return out;
}

function hasMark(nodes: DecisionNode[], marks: Set<DecisionNode>): boolean {
  return nodes.some(
    (node) =>
      marks.has(node) ||
      (node.type === 'group' && hasMark(node.nodes, marks)) ||
      (node.type === 'try' && hasMark(node.nodes, marks)) ||
      (node.type === 'decision' && node.branches.some((branch) => hasMark(branch.nodes, marks))),
  );
}

function hasQuery(nodes: DecisionNode[]): boolean {
  return nodes.some(
    (node) =>
      (node.type === 'step' && node.kind === 'db') ||
      ((node.type === 'group' || node.type === 'try') && hasQuery(node.nodes)),
  );
}

/** Not worked out: the code reads something the address does not decide. */
const UNKNOWN = Symbol('unknown');
type Value = string | boolean | undefined | typeof UNKNOWN;

/**
 * The tree with the link's value carried through it: each decision the value
 * settles is replaced by the way it goes, and what follows a way that ends is
 * not drawn — it cannot run.
 */
function settle(reader: SourceReader, nodes: DecisionNode[], scope: Scope): DecisionNode[] {
  const out: DecisionNode[] = [];
  for (const node of nodes) {
    if (node.type === 'decision') {
      const taken = takenBranch(node, scope);
      if (taken === undefined) {
        out.push({
          ...node,
          branches: node.branches.map((branch) => ({
            ...branch,
            nodes: settle(reader, branch.nodes, scope),
          })),
        });
        continue;
      }
      const inner = settle(reader, taken?.nodes ?? [], scope);
      // Settled by the link's own value: what it runs is this feature.
      if (readsOwn(node.code, scope)) for (const child of inner) scope.marks.add(child);
      out.push(...inner);
      if (taken?.ends) break;
      continue;
    }
    if (node.type === 'group') {
      const inside = enter(reader, node, scope);
      const group = { ...node, nodes: settle(reader, node.nodes, inside) };
      // A helper handed the link's value: all of it is this feature.
      if ([...inside.bound.keys()].some((name) => inside.bound.get(name) !== undefined))
        scope.marks.add(group);
      out.push(group);
      continue;
    }
    if (node.type === 'step' && readsOwn(node.text, scope)) scope.marks.add(node);
    if (node.type === 'try') {
      out.push({
        ...node,
        nodes: settle(reader, node.nodes, scope),
        ...(node.catch
          ? { catch: { ...node.catch, nodes: settle(reader, node.catch.nodes, scope) } }
          : {}),
        ...(node.finally ? { finally: settle(reader, node.finally, scope) } : {}),
      });
      continue;
    }
    out.push(node);
  }
  return out;
}

/**
 * The branch a decision takes for this link, `null` for "none of its
 * branches — it falls through", or `undefined` when the value does not settle it.
 */
function takenBranch(
  node: Extract<DecisionNode, { type: 'decision' }>,
  scope: Scope,
): { nodes: DecisionNode[]; ends: boolean } | null | undefined {
  const cases = node.branches.every((branch) => /^(case |default$)/.test(branch.label));
  if (cases) {
    const value = evaluate(node.code.replace(/^switch\s*\((.*)\)$/, '$1'), scope);
    if (value === UNKNOWN) return undefined;
    const text = String(value);
    const index = node.branches.findIndex(
      (branch) => branch.label.replace(/^case\s+/, '').replace(/^['"`]|['"`]$/g, '') === text,
    );
    const at = index >= 0 ? index : node.branches.findIndex((branch) => branch.label === 'default');
    if (at < 0) return null;
    // A case with no body of its own runs the next one's.
    for (let i = at; i < node.branches.length; i++) {
      if (node.branches[i]!.nodes.length) return node.branches[i]!;
    }
    return node.branches[at]!;
  }
  const yes = node.branches.find((branch) => branch.label === 'yes');
  const no = node.branches.find((branch) => branch.label === 'no');
  if (!yes && !no) return undefined;
  const value = evaluate(node.code, scope);
  if (value === UNKNOWN) return undefined;
  // `!valid` is asked as "valid?", its `then` labelled "no" (see `phrase`).
  const flat = node.code.replace(/\s+/g, ' ').trim();
  const negated = /^!\s*(\(?[\w$.?[\]'"()]+\)?)$/.test(flat) && !flat.startsWith('!!');
  const holds = Boolean(value);
  const label = holds !== negated ? 'yes' : 'no';
  const branch = node.branches.find((candidate) => candidate.label === label);
  // An `if` with no `else`: the other way runs nothing and carries on.
  return branch ?? (node.otherwise === label ? null : undefined);
}

/** A helper called with one of the values: its parameters carry them in. */
function enter(
  reader: SourceReader,
  group: Extract<DecisionNode, { type: 'group' }>,
  scope: Scope,
): Scope {
  if (group.kind !== 'function' || !group.callee) return scope;
  const call = parse(group.title);
  if (!call || !ts.isCallExpression(call)) return scope;
  const source = reader.file(group.callee.file);
  const fn = source ? functionAtLine(source, group.callee.line) : undefined;
  if (!fn) return scope;
  const bound = new Map<string, string | undefined>();
  fn.getParameters().forEach((param, index) => {
    const arg = call.arguments[index];
    const name = param.getNameNode();
    if (!arg || !Node.isIdentifier(name)) return;
    // Only what reads the link's own value carries it in: `verifyToken(t, "access")` does not.
    if (!readsOwn(arg.getText(), scope)) return;
    const value = evaluateNode(arg, scope);
    if (value !== UNKNOWN && typeof value !== 'boolean') bound.set(name.getText(), value);
    // `filter(query)` hands the whole set of values on: `query.x` still reads them.
  });
  return { ...scope, bound };
}

function parse(code: string): ts.Expression | undefined {
  const file = ts.createSourceFile('x.ts', `(${code});`, ts.ScriptTarget.Latest, true);
  const [first] = file.statements;
  if (!first || !ts.isExpressionStatement(first)) return undefined;
  let expression = first.expression;
  while (ts.isParenthesizedExpression(expression)) expression = expression.expression;
  return expression;
}

function evaluate(code: string, scope: Scope): Value {
  if (code.includes('…')) return UNKNOWN;
  const expression = parse(code);
  return expression ? evaluateNode(expression, scope) : UNKNOWN;
}

/** The value of a condition for this link, as far as the address decides it. */
function evaluateNode(node: ts.Expression, scope: Scope): Value {
  if (
    ts.isParenthesizedExpression(node) ||
    ts.isNonNullExpression(node) ||
    ts.isAsExpression(node) ||
    ts.isAwaitExpression(node)
  )
    return evaluateNode(node.expression, scope);
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  if (node.kind === ts.SyntaxKind.TrueKeyword) return true;
  if (node.kind === ts.SyntaxKind.FalseKeyword) return false;
  if (node.kind === ts.SyntaxKind.NullKeyword) return undefined;
  if (ts.isIdentifier(node)) {
    if (node.text === 'undefined') return undefined;
    if (scope.bound.has(node.text)) return scope.bound.get(node.text);
    return UNKNOWN;
  }
  // `query.stockFilter`, `body["stockFilter"]`, `params.get("stockFilter")`.
  const name = ts.isPropertyAccessExpression(node)
    ? node.name.text
    : ts.isElementAccessExpression(node) && ts.isStringLiteral(node.argumentExpression)
      ? node.argumentExpression.text
      : ts.isCallExpression(node) &&
          ts.isPropertyAccessExpression(node.expression) &&
          node.expression.name.text === 'get' &&
          node.arguments.length === 1 &&
          ts.isStringLiteral(node.arguments[0]!)
        ? node.arguments[0].text
        : undefined;
  if (name !== undefined) return scope.known.has(name) ? scope.known.get(name) : UNKNOWN;
  if (ts.isPrefixUnaryExpression(node) && node.operator === ts.SyntaxKind.ExclamationToken) {
    const value = evaluateNode(node.operand, scope);
    return value === UNKNOWN ? UNKNOWN : !value;
  }
  if (ts.isBinaryExpression(node)) {
    const op = node.operatorToken.kind;
    const left = evaluateNode(node.left, scope);
    if (op === ts.SyntaxKind.AmpersandAmpersandToken) {
      if (left !== UNKNOWN && !left) return left;
      const right = evaluateNode(node.right, scope);
      return left === UNKNOWN ? (right !== UNKNOWN && !right ? right : UNKNOWN) : right;
    }
    if (op === ts.SyntaxKind.BarBarToken) {
      if (left !== UNKNOWN && left) return left;
      const right = evaluateNode(node.right, scope);
      return left === UNKNOWN ? (right !== UNKNOWN && right ? right : UNKNOWN) : right;
    }
    const right = evaluateNode(node.right, scope);
    if (left === UNKNOWN || right === UNKNOWN) return UNKNOWN;
    switch (op) {
      case ts.SyntaxKind.EqualsEqualsEqualsToken:
      case ts.SyntaxKind.EqualsEqualsToken:
        return left === right;
      case ts.SyntaxKind.ExclamationEqualsEqualsToken:
      case ts.SyntaxKind.ExclamationEqualsToken:
        return left !== right;
    }
  }
  return UNKNOWN;
}
