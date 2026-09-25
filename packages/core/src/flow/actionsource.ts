/**
 * The source-level facts behind one action's document.
 *
 * The graph is built for the whole project at once, so it keeps what every
 * view needs — which handler calls which endpoint, which route writes which
 * collection. An action's *document* needs more than that, and needs it for
 * only a handful of files: the condition that stops a submit, the rules in the
 * schema it is checked against, the headers an interceptor adds, the status a
 * guard answers with, the toast shown on success. Storing all of that for every
 * action in the project would multiply the graph for the sake of one screen.
 *
 * So these are read on demand, from the few files one action touches, when
 * somebody opens its document. Everything here is a *reading* of the source —
 * nothing is executed, and a fact that cannot be read is left out rather than
 * guessed.
 */

import { existsSync, readFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import {
  Node,
  Project,
  ScriptTarget,
  SyntaxKind,
  ts,
  type CallExpression,
  type Expression,
  type ObjectLiteralExpression,
  type SourceFile,
} from 'ts-morph';
import type { Functionish } from '../analyzer/ast.js';
import type { FlowGraph } from '../graph/graph.js';

const EXTENSIONS = ['.ts', '.tsx', '.js', '.jsx', '.mts', '.cts', '.mjs', '.cjs'];

/** Where a fact was read from, relative to the scanned root. */
export interface SourcePoint {
  file: string;
  line: number;
}

interface Root {
  /** Prefix used in node ids when several roots were scanned. */
  label?: string;
  path: string;
  aliases: Array<{ prefix: string; targets: string[] }>;
}

/**
 * Lazy access to the scanned project's files.
 *
 * Its own ts-morph project, holding only the files an action touches — a scan
 * of a large repository keeps nothing around once the graph is built, and
 * re-parsing twenty files is cheaper than keeping two thousand in memory for a
 * tab that may never be opened.
 */
export class SourceReader {
  private readonly project = new Project({
    useInMemoryFileSystem: false,
    skipAddingFilesFromTsConfig: true,
    skipFileDependencyResolution: true,
    compilerOptions: {
      allowJs: true,
      jsx: 4 /* ts.JsxEmit.ReactJSX */,
      target: ScriptTarget.ESNext,
      noLib: true,
      experimentalDecorators: true,
    },
  });
  private readonly roots: Root[];
  private readonly missing = new Set<string>();

  constructor(graph: FlowGraph) {
    const projects = graph.meta.projects ?? {};
    const absolute = Object.entries(projects).filter(([, path]) => isAbsolute(path));
    const roots =
      absolute.length > 1
        ? absolute.map(([label, path]) => ({ label, path }))
        : [{ path: graph.meta.root }];
    this.roots = roots.map((root) => ({ ...root, aliases: readAliases(root.path) }));
  }

  /** `features/x.tsx` (or `web/features/x.tsx`) -> an absolute path. */
  absolute(rel: string): string | undefined {
    for (const root of this.roots) {
      if (root.label) {
        if (!rel.startsWith(`${root.label}/`)) continue;
        return join(root.path, rel.slice(root.label.length + 1));
      }
      return join(root.path, rel);
    }
    return undefined;
  }

  /** The inverse of {@link absolute}: the form node ids use. */
  relative(file: SourceFile | string): string {
    const path = typeof file === 'string' ? file : file.getFilePath();
    for (const root of this.roots) {
      const candidate = relative(root.path, path);
      if (candidate.startsWith('..') || isAbsolute(candidate)) continue;
      const normalized = candidate.split(sep).join('/');
      return root.label ? `${root.label}/${normalized}` : normalized;
    }
    return path;
  }

  point(node: Node): SourcePoint {
    return { file: this.relative(node.getSourceFile()), line: node.getStartLineNumber() };
  }

  file(rel: string | undefined): SourceFile | undefined {
    if (!rel) return undefined;
    const path = this.absolute(rel);
    return path ? this.fileAt(path) : undefined;
  }

  fileAt(path: string): SourceFile | undefined {
    if (this.missing.has(path)) return undefined;
    const existing = this.project.getSourceFile(path);
    if (existing) return existing;
    try {
      const added = this.project.addSourceFileAtPathIfExists(path);
      if (!added) this.missing.add(path);
      return added;
    } catch {
      this.missing.add(path);
      return undefined;
    }
  }

  /** An import specifier, resolved the way the project's own tsconfig would. */
  resolveModule(from: SourceFile, specifier: string): SourceFile | undefined {
    const bases: string[] = [];
    if (specifier.startsWith('.')) {
      bases.push(resolve(dirname(from.getFilePath()), specifier));
    } else {
      const root = this.rootOf(from.getFilePath());
      for (const alias of root?.aliases ?? []) {
        if (!specifier.startsWith(alias.prefix)) continue;
        const rest = specifier.slice(alias.prefix.length);
        for (const target of alias.targets) bases.push(join(target, rest));
      }
    }
    for (const base of bases) {
      const candidates = [
        base,
        ...EXTENSIONS.map((ext) => `${base}${ext}`),
        ...EXTENSIONS.map((ext) => join(base, `index${ext}`)),
        // `./x.js` written for NodeNext, pointing at `./x.ts`.
        ...EXTENSIONS.map((ext) => base.replace(/\.[cm]?js$/, ext)),
      ];
      for (const candidate of candidates) {
        if (!EXTENSIONS.some((ext) => candidate.endsWith(ext))) continue;
        if (!existsSync(candidate)) continue;
        const file = this.fileAt(candidate);
        if (file) return file;
      }
    }
    return undefined;
  }

  /**
   * The declaration a name refers to from inside `file`: a local function,
   * variable or class, or the export an import points at.
   */
  declaration(name: string, file: SourceFile, depth = 0): Node | undefined {
    if (depth > 4) return undefined;
    const local =
      file.getFunction(name) ?? file.getVariableDeclaration(name) ?? file.getClass(name);
    if (local) return local;

    for (const declaration of file.getImportDeclarations()) {
      const specifier = declaration.getModuleSpecifierValue();
      const named = declaration
        .getNamedImports()
        .find((entry) => (entry.getAliasNode()?.getText() ?? entry.getName()) === name);
      const isDefault = declaration.getDefaultImport()?.getText() === name;
      if (!named && !isDefault) continue;
      const target = this.resolveModule(file, specifier);
      if (!target) return undefined;
      if (isDefault) {
        const assignment = target.getExportAssignment((entry) => !entry.isExportEquals());
        const expression = assignment?.getExpression();
        if (expression && Node.isIdentifier(expression)) {
          return this.declaration(expression.getText(), target, depth + 1);
        }
        return target.getFunctions().find((fn) => fn.isDefaultExport()) ?? expression;
      }
      return this.declaration(named!.getName(), target, depth + 1);
    }

    // `export { x } from './y'` and `export * from './y'`.
    for (const declaration of file.getExportDeclarations()) {
      const specifier = declaration.getModuleSpecifierValue();
      if (!specifier) continue;
      const named = declaration.getNamedExports();
      const entry = named.find(
        (candidate) => (candidate.getAliasNode()?.getText() ?? candidate.getName()) === name,
      );
      if (named.length > 0 && !entry) continue;
      const target = this.resolveModule(file, specifier);
      if (!target) continue;
      const found = this.declaration(entry?.getName() ?? name, target, depth + 1);
      if (found) return found;
    }
    return undefined;
  }

  /** The function a name refers to, unwrapped from `useCallback`, `memo`, … */
  functionNamed(name: string, file: SourceFile): Functionish | undefined {
    return functionOf(this.declaration(name, file));
  }

  private rootOf(path: string): Root | undefined {
    return this.roots.find((root) => {
      const candidate = relative(root.path, path);
      return !candidate.startsWith('..') && !isAbsolute(candidate);
    });
  }
}

/** `compilerOptions.paths` from the root's tsconfig/jsconfig, plus the common defaults. */
function readAliases(root: string): Root['aliases'] {
  const aliases: Root['aliases'] = [];
  for (const name of ['tsconfig.json', 'jsconfig.json']) {
    const path = join(root, name);
    if (!existsSync(path)) continue;
    try {
      const parsed = ts.parseConfigFileTextToJson(path, readFileSync(path, 'utf8'));
      const options = (parsed.config?.compilerOptions ?? {}) as {
        baseUrl?: string;
        paths?: Record<string, string[]>;
      };
      const base = resolve(root, options.baseUrl ?? '.');
      for (const [pattern, targets] of Object.entries(options.paths ?? {})) {
        aliases.push({
          prefix: pattern.replace(/\*$/, ''),
          targets: targets.map((target) => resolve(base, target.replace(/\*$/, ''))),
        });
      }
    } catch {
      // An unreadable tsconfig only costs the aliases.
    }
  }
  // Conventions nearly every React project uses, in case no config says so.
  for (const prefix of ['@/', '~/']) {
    if (aliases.some((alias) => alias.prefix === prefix)) continue;
    aliases.push({ prefix, targets: [root, join(root, 'src')] });
  }
  return aliases.sort((a, b) => b.prefix.length - a.prefix.length);
}

// ---------------------------------------------------------------------------
// Small AST helpers
// ---------------------------------------------------------------------------

const WRAPPERS = new Set(['useCallback', 'useMemo', 'memo', 'forwardRef', 'useEvent']);

/** A declaration's function, looking through `const x = useCallback(() => …)`. */
export function functionOf(node: Node | undefined): Functionish | undefined {
  if (!node) return undefined;
  if (
    Node.isFunctionDeclaration(node) ||
    Node.isMethodDeclaration(node) ||
    Node.isArrowFunction(node) ||
    Node.isFunctionExpression(node)
  ) {
    return node;
  }
  if (Node.isVariableDeclaration(node)) return functionOf(node.getInitializer());
  if (Node.isParenthesizedExpression(node) || Node.isAsExpression(node)) {
    return functionOf(node.getExpression());
  }
  if (Node.isCallExpression(node)) {
    const name = node.getExpression().getText().split('.').pop() ?? '';
    if (WRAPPERS.has(name)) return functionOf(node.getArguments()[0]);
  }
  return undefined;
}

/** A readable name for a function node: `handleSubmit`, `mutationFn`. */
export function nameOf(fn: Node): string {
  if (Node.isFunctionDeclaration(fn) || Node.isMethodDeclaration(fn)) {
    return fn.getName() ?? 'anonymous';
  }
  let current: Node | undefined = fn.getParent();
  for (let hops = 0; current && hops < 4; hops += 1) {
    if (Node.isVariableDeclaration(current)) return current.getName();
    if (Node.isPropertyAssignment(current)) return current.getName().replace(/^['"]|['"]$/g, '');
    if (Node.isJsxAttribute(current)) return `${current.getNameNode().getText()} (inline)`;
    if (
      !Node.isCallExpression(current) &&
      !Node.isParenthesizedExpression(current) &&
      !Node.isJsxExpression(current)
    )
      break;
    current = current.getParent();
  }
  return 'anonymous';
}

/** Whitespace collapsed and long text cut, for showing code in a sentence. */
export function condense(text: string, max = 110): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/**
 * A call as one short line: `create.mutate(values, { onSuccess, onError })`.
 *
 * Callbacks and option objects are what make a call span twenty lines, and
 * their *names* are the useful part at this level — what they do is shown in
 * the step that is about them.
 */
export function shortCall(call: CallExpression): string {
  const args = call.getArguments().map((arg) => shortExpression(arg));
  return `${condense(call.getExpression().getText(), 60)}(${args.join(', ')})`;
}

export function shortExpression(node: Node): string {
  if (Node.isObjectLiteralExpression(node) && condense(node.getText(), 200).length <= 60) {
    return condense(node.getText(), 60);
  }
  if (Node.isObjectLiteralExpression(node)) {
    const keys = node.getProperties().map((property) => {
      if (Node.isSpreadAssignment(property))
        return `...${condense(property.getExpression().getText(), 20)}`;
      if (Node.isPropertyAssignment(property) || Node.isShorthandPropertyAssignment(property)) {
        return property.getName();
      }
      if (Node.isMethodDeclaration(property)) return property.getName();
      return condense(property.getText(), 20);
    });
    return keys.length === 0 ? '{}' : `{ ${keys.join(', ')} }`;
  }
  if (Node.isArrowFunction(node) || Node.isFunctionExpression(node)) {
    const params = node.getParameters().map((param) => param.getName());
    return `(${params.join(', ')}) => …`;
  }
  if (Node.isCallExpression(node)) return shortCall(node);
  if (Node.isAwaitExpression(node)) return `await ${shortExpression(node.getExpression())}`;
  return condense(node.getText(), 50);
}

/** A string an expression certainly evaluates to, when it is a literal. */
export function literalText(node: Node | undefined): string | undefined {
  if (!node) return undefined;
  if (Node.isStringLiteral(node) || Node.isNoSubstitutionTemplateLiteral(node)) {
    return node.getLiteralValue();
  }
  if (Node.isTemplateExpression(node)) return node.getText().slice(1, -1);
  return undefined;
}

/** Statements that run as part of `fn`, not inside a nested function. */
export function ownDescendants<T extends Node>(fn: Node, kind: SyntaxKind): T[] {
  return fn
    .getDescendantsOfKind(kind)
    .filter((node) => nearestFunction(node) === fn) as unknown as T[];
}

export function nearestFunction(node: Node): Node | undefined {
  return node.getFirstAncestor(
    (ancestor) =>
      Node.isFunctionDeclaration(ancestor) ||
      Node.isFunctionExpression(ancestor) ||
      Node.isArrowFunction(ancestor) ||
      Node.isMethodDeclaration(ancestor),
  );
}

/** The block of statements a function runs, or its single expression. */
export function bodyStatements(fn: Functionish): Node[] {
  const body = fn.getBody();
  if (!body) return [];
  if (Node.isBlock(body)) return body.getStatements();
  return [body];
}

/** `if (!x) return …` / `throw …`: a branch that ends the function. */
export function endsFunction(node: Node | undefined): boolean {
  if (!node) return false;
  if (Node.isReturnStatement(node) || Node.isThrowStatement(node)) return true;
  if (Node.isBlock(node)) {
    const last = node.getStatements().at(-1);
    return endsFunction(last);
  }
  return false;
}

/** The function-like node that starts on `line` in `file`. */
export function functionAtLine(file: SourceFile, line: number): Functionish | undefined {
  const candidates = [
    ...file.getDescendantsOfKind(SyntaxKind.FunctionDeclaration),
    ...file.getDescendantsOfKind(SyntaxKind.MethodDeclaration),
    ...file.getDescendantsOfKind(SyntaxKind.ArrowFunction),
    ...file.getDescendantsOfKind(SyntaxKind.FunctionExpression),
  ];
  const starts = (fn: Node): number => {
    const variable = fn.getFirstAncestorByKind(SyntaxKind.VariableStatement);
    return variable && functionOf(variable.getDeclarations()[0]) === fn
      ? variable.getStartLineNumber()
      : fn.getStartLineNumber();
  };
  return candidates.find((fn) => starts(fn) === line || fn.getStartLineNumber() === line) as
    Functionish | undefined;
}

/** The call on `line` whose callee mentions `hint`, or the first call on it. */
export function callAtLine(
  file: SourceFile,
  line: number,
  hint?: string,
): CallExpression | undefined {
  const calls = file
    .getDescendantsOfKind(SyntaxKind.CallExpression)
    .filter(
      (call) =>
        call.getStartLineNumber() === line || call.getExpression().getEndLineNumber() === line,
    );
  if (hint) {
    const matched = calls.find((call) => call.getExpression().getText().includes(hint));
    if (matched) return matched;
  }
  return calls[0];
}

/** Every JSX element in a subtree, self-closing or not, as its opening tag. */
export function jsxOpenings(node: Node): Node[] {
  return [
    ...node.getDescendantsOfKind(SyntaxKind.JsxOpeningElement),
    ...node.getDescendantsOfKind(SyntaxKind.JsxSelfClosingElement),
  ].sort((a, b) => a.getStart() - b.getStart());
}

export function tagOf(opening: Node): string {
  if (Node.isJsxOpeningElement(opening) || Node.isJsxSelfClosingElement(opening)) {
    return opening.getTagNameNode().getText();
  }
  return '';
}

/** An attribute's initializer: the expression inside `{…}`, or the string. */
export function attribute(opening: Node, name: string): Node | undefined | null {
  if (!Node.isJsxOpeningElement(opening) && !Node.isJsxSelfClosingElement(opening)) return null;
  for (const attr of opening.getAttributes()) {
    if (!Node.isJsxAttribute(attr) || attr.getNameNode().getText() !== name) continue;
    const init = attr.getInitializer();
    // `<Field required />` has no initializer and means true.
    if (!init) return undefined;
    if (Node.isJsxExpression(init)) return init.getExpression() ?? undefined;
    return init;
  }
  return null;
}

/** The words inside an element, with `{cond ? "a" : "b"}` kept readable. */
export function elementText(opening: Node): string {
  const element = opening.getParent();
  if (!element || !Node.isJsxElement(element)) return '';
  const parts: string[] = [];
  for (const child of element.getJsxChildren()) {
    if (Node.isJsxText(child)) {
      const text = child.getText().replace(/\s+/g, ' ').trim();
      if (text) parts.push(text);
    } else if (Node.isJsxExpression(child)) {
      const expression = child.getExpression();
      if (!expression) continue;
      if (literal(expression)) parts.push(literal(expression)!);
      else if (Node.isConditionalExpression(expression)) {
        const strings = branchStrings(expression);
        if (strings.length > 0) parts.push(strings.join(' / '));
      }
    } else if (Node.isJsxElement(child)) {
      const text = elementText(child.getOpeningElement());
      if (text) parts.push(text);
    }
  }
  return parts.join(' ').trim();
}

/** `a ? "Saving…" : b ? "Save" : "Update"` -> the words it can show, not the condition's. */
export function branchStrings(node: Node): string[] {
  const value = unwrap(node);
  if (Node.isConditionalExpression(value)) {
    return [...branchStrings(value.getWhenTrue()), ...branchStrings(value.getWhenFalse())];
  }
  const text = literalText(value);
  return text !== undefined && text.trim() ? [text.trim()] : [];
}

function literal(node: Node): string | undefined {
  return Node.isStringLiteral(node) ? node.getLiteralValue() : undefined;
}

/** `{ a, b: c }` -> keys, with spreads marked. */
export function objectKeysOf(object: ObjectLiteralExpression): string[] {
  return object.getProperties().flatMap((property) => {
    if (Node.isPropertyAssignment(property) || Node.isShorthandPropertyAssignment(property)) {
      return [property.getName().replace(/^['"]|['"]$/g, '')];
    }
    if (Node.isMethodDeclaration(property)) return [property.getName()];
    return [];
  });
}

/** Unwrap `(x as T)`, `x!`, `(x)` and `await x`. */
export function unwrap(node: Node): Node {
  let current = node;
  for (let hops = 0; hops < 6; hops += 1) {
    if (
      Node.isAsExpression(current) ||
      Node.isParenthesizedExpression(current) ||
      Node.isNonNullExpression(current) ||
      Node.isAwaitExpression(current) ||
      Node.isSatisfiesExpression(current) ||
      Node.isTypeAssertion(current)
    ) {
      current = current.getExpression();
      continue;
    }
    break;
  }
  return current;
}

/** The local variable `name` declared inside `fn` (or its component). */
export function localVariable(fn: Node, name: string): Node | undefined {
  let scope: Node | undefined = fn;
  for (let hops = 0; scope && hops < 4; hops += 1) {
    const found = scope.getDescendantsOfKind(SyntaxKind.VariableDeclaration).find((declaration) => {
      const binding = declaration.getNameNode();
      if (Node.isIdentifier(binding)) return binding.getText() === name;
      return binding
        .getDescendantsOfKind(SyntaxKind.BindingElement)
        .some((element) => element.getNameNode().getText() === name);
    });
    if (found) return found;
    scope = nearestFunction(scope);
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Statuses
// ---------------------------------------------------------------------------

export interface StatusExit {
  status?: number;
  /** Every status the expression can produce, for `cond ? 201 : 200`. */
  statuses: number[];
  message?: string;
  /** The code that decides, when it is a condition. */
  when?: string;
  /** The returned body, as written. */
  body?: string;
  at: SourcePoint;
}

const NEST_EXCEPTIONS: Record<string, number> = {
  BadRequestException: 400,
  UnauthorizedException: 401,
  ForbiddenException: 403,
  NotFoundException: 404,
  MethodNotAllowedException: 405,
  NotAcceptableException: 406,
  RequestTimeoutException: 408,
  ConflictException: 409,
  GoneException: 410,
  PayloadTooLargeException: 413,
  UnsupportedMediaTypeException: 415,
  UnprocessableEntityException: 422,
  InternalServerErrorException: 500,
  NotImplementedException: 501,
  BadGatewayException: 502,
  ServiceUnavailableException: 503,
  GatewayTimeoutException: 504,
};

type Env = Map<string, { node?: Node; env?: Env }>;

/**
 * The HTTP status a returned or thrown expression produces.
 *
 * Follows a helper one or two levels — `unauthorized()` is
 * `apiError("Unauthorized", 401)` is `Response.json(…, { status })` — because
 * that is how almost every codebase spells its error responses, and a guard
 * reported as "returns unauthorized()" tells the reader nothing about the 401.
 */
export function statusOf(
  reader: SourceReader,
  expression: Node,
  env: Env = new Map(),
  depth = 0,
): { statuses: number[]; message?: string } | undefined {
  const node = unwrap(expression);
  if (depth > 3) return undefined;

  if (Node.isNewExpression(node)) {
    const name = node.getExpression().getText().split('.').pop() ?? '';
    const args = node.getArguments();
    const message = literalText(args[0]);
    if (NEST_EXCEPTIONS[name] !== undefined) {
      return { statuses: [NEST_EXCEPTIONS[name]], ...(message ? { message } : {}) };
    }
    if (name === 'HttpException' || name === 'HttpError' || name === 'ApiError') {
      const statuses = numbersIn(args[1], env);
      return { statuses, ...(message ? { message } : {}) };
    }
    if (name === 'Response' || name === 'NextResponse') {
      const statuses = statusFromInit(args[1], env);
      return { statuses: statuses.length > 0 ? statuses : [200] };
    }
    return undefined;
  }

  if (!Node.isCallExpression(node)) return undefined;
  const callee = node.getExpression();
  const calleeText = callee.getText();
  const member = calleeText.split('.').pop() ?? '';
  const args = node.getArguments();

  // `res.status(404).json(…)` / `reply.code(404).send(…)`
  if (Node.isPropertyAccessExpression(callee)) {
    const inner = unwrap(callee.getExpression());
    if (Node.isCallExpression(inner)) {
      const innerMember = inner.getExpression().getText().split('.').pop() ?? '';
      if (innerMember === 'status' || innerMember === 'code') {
        const statuses = numbersIn(inner.getArguments()[0], env);
        const message = messageIn(args[0]);
        return { statuses, ...(message ? { message } : {}) };
      }
    }
  }

  // `Response.json(body, { status })`, `NextResponse.json(…)`, `json(body, init)`
  if (member === 'json' && /^(Response|NextResponse|json)$|\.json$/.test(calleeText)) {
    const statuses = statusFromInit(args[1], env);
    const message = messageIn(args[0]);
    return { statuses: statuses.length > 0 ? statuses : [200], ...(message ? { message } : {}) };
  }
  if (member === 'redirect') return { statuses: [307] };

  // A helper: follow it with its arguments bound to its parameters.
  if (Node.isIdentifier(callee)) {
    const fn = reader.functionNamed(callee.getText(), node.getSourceFile());
    if (!fn) return undefined;
    const inner: Env = new Map();
    fn.getParameters().forEach((param, index) => {
      const arg = args[index];
      if (arg) inner.set(param.getName(), { node: arg, env });
      else {
        const initializer = param.getInitializer();
        if (initializer) inner.set(param.getName(), { node: initializer, env: inner });
      }
    });
    for (const statement of returnsOf(fn)) {
      const found = statusOf(reader, statement, inner, depth + 1);
      if (found && found.statuses.length > 0) {
        const message = found.message ?? literalText(args[0]);
        return { statuses: found.statuses, ...(message ? { message } : {}) };
      }
    }
  }
  return undefined;
}

/** What a function returns, or its body when it is an expression. */
export function returnsOf(fn: Functionish): Node[] {
  const body = fn.getBody();
  if (!body) return [];
  if (!Node.isBlock(body)) return [body];
  return ownDescendants<Node>(fn, SyntaxKind.ReturnStatement)
    .map((statement) =>
      (statement as unknown as { getExpression(): Node | undefined }).getExpression(),
    )
    .filter((expression): expression is Node => expression !== undefined);
}

function statusFromInit(init: Node | undefined, env: Env): number[] {
  if (!init) return [];
  const object = unwrap(init);
  if (Node.isIdentifier(object)) {
    const bound = env.get(object.getText());
    return bound?.node ? statusFromInit(bound.node, bound.env ?? env) : [];
  }
  if (!Node.isObjectLiteralExpression(object)) return [];
  const property = object.getProperty('status');
  if (!property) return [];
  if (Node.isShorthandPropertyAssignment(property)) {
    const bound = env.get('status');
    return bound?.node ? numbersIn(bound.node, bound.env ?? env) : [];
  }
  if (Node.isPropertyAssignment(property)) return numbersIn(property.getInitializer(), env);
  return [];
}

function numbersIn(node: Node | undefined, env: Env): number[] {
  if (!node) return [];
  const value = unwrap(node);
  if (Node.isNumericLiteral(value)) return [Number(value.getLiteralValue())];
  if (Node.isConditionalExpression(value)) {
    return [...numbersIn(value.getWhenTrue(), env), ...numbersIn(value.getWhenFalse(), env)];
  }
  if (Node.isIdentifier(value)) {
    const bound = env.get(value.getText());
    if (bound?.node) return numbersIn(bound.node, bound.env ?? env);
  }
  if (Node.isPropertyAccessExpression(value)) {
    const known: Record<string, number> = {
      OK: 200,
      CREATED: 201,
      NO_CONTENT: 204,
      BAD_REQUEST: 400,
      UNAUTHORIZED: 401,
      FORBIDDEN: 403,
      NOT_FOUND: 404,
      CONFLICT: 409,
      UNPROCESSABLE_ENTITY: 422,
      INTERNAL_SERVER_ERROR: 500,
    };
    const code = known[value.getName()];
    if (code !== undefined) return [code];
  }
  return [];
}

/** `{ error: "Not found" }` / `"Not found"` -> the message. */
function messageIn(node: Node | undefined): string | undefined {
  if (!node) return undefined;
  const value = unwrap(node);
  const text = literalText(value);
  if (text) return text;
  if (Node.isObjectLiteralExpression(value)) {
    for (const key of ['error', 'message', 'msg']) {
      const property = value.getProperty(key);
      if (property && Node.isPropertyAssignment(property)) {
        const found = literalText(property.getInitializer());
        if (found) return found;
      }
    }
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Schemas (zod / yup / joi)
// ---------------------------------------------------------------------------

export interface SchemaField {
  name: string;
  /** `string`, `number`, `enum(active | inactive)`. */
  type?: string;
  /** Checks that can fail: `at least 2 characters`, `whole number`. */
  rules: string[];
  /** What the value is turned into before it is used: `trimmed`, `defaults to ""`. */
  transforms: string[];
  /** Messages shown when a check fails, as written. */
  messages: string[];
  required: boolean;
}

export interface SchemaFacts {
  name: string;
  library: 'zod' | 'yup' | 'joi' | 'schema';
  fields: SchemaField[];
  at: SourcePoint;
}

const TYPE_WORDS = new Set([
  'string',
  'number',
  'boolean',
  'date',
  'bigint',
  'array',
  'object',
  'enum',
  'nativeEnum',
  'literal',
  'union',
  'any',
  'unknown',
  'mixed',
]);

/** A validation schema by name, with one entry per field. */
export function readSchema(
  reader: SourceReader,
  name: string,
  from: SourceFile,
): SchemaFacts | undefined {
  const declaration = reader.declaration(name, from);
  if (!declaration || !Node.isVariableDeclaration(declaration)) return undefined;
  const initializer = declaration.getInitializer();
  if (!initializer) return undefined;

  const objectCall = [initializer, ...initializer.getDescendantsOfKind(SyntaxKind.CallExpression)]
    .filter((node): node is CallExpression => Node.isCallExpression(node))
    .find((call) => {
      const member = call.getExpression().getText().split('.').pop();
      return (
        (member === 'object' || member === 'shape') &&
        Node.isObjectLiteralExpression(call.getArguments()[0])
      );
    });
  const shape = objectCall?.getArguments()[0];
  if (!shape || !Node.isObjectLiteralExpression(shape)) return undefined;

  const text = initializer.getText();
  const library = /^z\.|\bz\./.test(text)
    ? 'zod'
    : /\byup\.|^(object|string)\(/.test(text)
      ? 'yup'
      : /\bJoi\./.test(text)
        ? 'joi'
        : 'schema';

  const fields: SchemaField[] = [];
  for (const property of shape.getProperties()) {
    if (!Node.isPropertyAssignment(property)) continue;
    const field: SchemaField = {
      name: property.getName().replace(/^['"]|['"]$/g, ''),
      rules: [],
      transforms: [],
      messages: [],
      required: true,
    };
    const value = property.getInitializer();
    if (value) describeChain(reader, value, field, new Map(), 0);
    field.rules = [...new Set(field.rules)];
    field.transforms = [...new Set(field.transforms)];
    field.messages = [...new Set(field.messages)];
    fields.push(field);
  }
  return { name, library, fields, at: reader.point(declaration) };
}

/** Walk `z.string().trim().min(2, "…")` into rules, transforms and messages. */
function describeChain(
  reader: SourceReader,
  node: Node,
  field: SchemaField,
  params: Map<string, string>,
  depth: number,
): void {
  if (depth > 3) return;
  const segments: Array<{ name: string; args: Node[] }> = [];
  let current: Node = unwrap(node);
  for (let hops = 0; hops < 40; hops += 1) {
    if (Node.isCallExpression(current)) {
      const callee = current.getExpression();
      const name = Node.isPropertyAccessExpression(callee) ? callee.getName() : callee.getText();
      segments.unshift({ name, args: current.getArguments() });
      if (Node.isPropertyAccessExpression(callee)) {
        current = callee.getExpression();
        continue;
      }
      break;
    }
    if (Node.isPropertyAccessExpression(current)) {
      // `z.coerce.number()` — `coerce` is a property, not a call.
      if (current.getName() === 'coerce') segments.unshift({ name: 'coerce', args: [] });
      current = current.getExpression();
      continue;
    }
    break;
  }

  // A local helper such as `requiredNumber("Quantity", { int: true })`.
  if (segments.length === 1 && Node.isCallExpression(unwrap(node))) {
    const call = unwrap(node) as CallExpression;
    const callee = call.getExpression();
    if (Node.isIdentifier(callee) && !TYPE_WORDS.has(callee.getText())) {
      const fn = reader.functionNamed(callee.getText(), call.getSourceFile());
      if (fn) {
        const bound = new Map(params);
        fn.getParameters().forEach((param, index) => {
          const arg = call.getArguments()[index];
          const text = literalText(arg);
          if (text !== undefined) bound.set(param.getName(), text);
          // An option that was not passed: checks that only apply with it are skipped.
          if (!arg) bound.set(`${MISSING}${param.getName()}`, '');
        });
        field.rules.push(`checked by ${callee.getText()}()`);
        if (/optional/i.test(callee.getText())) field.required = false;
        for (const returned of returnsOf(fn))
          describeChain(reader, returned, field, bound, depth + 1);
        if (/required/i.test(callee.getText())) field.required = true;
        return;
      }
    }
  }

  for (const segment of segments) {
    const [first, second] = segment.args;
    const message = messageOf(second ?? first, params);
    switch (segment.name) {
      case 'z':
        break;
      case 'coerce':
        field.transforms.push('converted to the declared type');
        break;
      case 'string':
      case 'number':
      case 'boolean':
      case 'date':
      case 'bigint':
      case 'array':
      case 'any':
      case 'unknown':
      case 'mixed':
        field.type ??= segment.name;
        if (first && Node.isObjectLiteralExpression(first)) {
          const typeMessage = messageOf(first, params);
          if (typeMessage) field.messages.push(typeMessage);
        }
        break;
      case 'enum':
      case 'nativeEnum': {
        const options =
          first && Node.isArrayLiteralExpression(first)
            ? first.getElements().map((element) => literalText(element) ?? element.getText())
            : [condense(first?.getText() ?? '', 30)];
        field.type ??= `one of ${options.join(' | ')}`;
        break;
      }
      case 'literal':
        if (literalText(first) === '') {
          field.rules.push('or blank');
          field.required = false;
        } else field.type ??= `exactly ${first?.getText() ?? ''}`;
        break;
      case 'min':
      case 'max':
      case 'length':
      case 'gt':
      case 'gte':
      case 'lt':
      case 'lte': {
        const words: Record<string, string> = {
          min: 'at least',
          max: 'at most',
          length: 'exactly',
          gt: 'more than',
          gte: 'at least',
          lt: 'less than',
          lte: 'at most',
        };
        const unit =
          field.type === 'string' ? ' characters' : field.type === 'array' ? ' items' : '';
        field.rules.push(`${words[segment.name]} ${first?.getText() ?? '?'}${unit}`);
        if (message) field.messages.push(message);
        break;
      }
      case 'int':
      case 'integer':
        field.rules.push('whole number');
        if (message) field.messages.push(message);
        break;
      case 'positive':
      case 'nonnegative':
      case 'negative':
      case 'email':
      case 'url':
      case 'uuid':
      case 'cuid':
      case 'datetime':
      case 'nonempty':
        field.rules.push(segment.name);
        if (message) field.messages.push(message);
        break;
      case 'regex':
      case 'matches':
        field.rules.push(`matches ${condense(first?.getText() ?? '', 40)}`);
        if (message) field.messages.push(message);
        break;
      case 'required':
        field.required = true;
        if (message) field.messages.push(message);
        break;
      case 'optional':
      case 'nullable':
      case 'nullish':
        field.required = false;
        field.rules.push(segment.name);
        break;
      case 'default':
        field.required = false;
        field.transforms.push(`defaults to ${condense(first?.getText() ?? '', 30)}`);
        break;
      case 'trim':
        field.transforms.push('trimmed');
        break;
      case 'toLowerCase':
      case 'toUpperCase':
      case 'lowercase':
      case 'uppercase':
        field.transforms.push(segment.name.replace(/^to/, '').toLowerCase());
        break;
      case 'transform':
        field.transforms.push('transformed by a function');
        break;
      case 'preprocess':
        field.transforms.push(`cleaned first by \`${condense(first?.getText() ?? '', 38)}\``);
        if (second) describeChain(reader, second, field, params, depth + 1);
        break;
      case 'refine':
      case 'superRefine':
      case 'test':
        if (first && appliesOnlyWithMissing(first, params)) break;
        field.rules.push('custom check');
        if (message) field.messages.push(message);
        break;
      case 'or':
        if (first) describeChain(reader, first, field, params, depth + 1);
        break;
      default:
        break;
    }
  }
}

const MISSING = '\u0000missing:';

/** `(n) => !opts?.int || …` when `opts` was not passed: the check never fails. */
function appliesOnlyWithMissing(predicate: Node, params: Map<string, string>): boolean {
  const text = predicate.getText();
  for (const key of params.keys()) {
    if (!key.startsWith(MISSING)) continue;
    const name = key.slice(MISSING.length);
    if (new RegExp(`!\\s*${name}\\??\\.`).test(text)) return true;
  }
  return false;
}

/** A validation message: a literal, `{ message }`, with `${label}` filled in. */
function messageOf(node: Node | undefined, params: Map<string, string>): string | undefined {
  if (!node) return undefined;
  const direct = literalText(node);
  if (direct !== undefined) return fill(direct, params);
  if (Node.isObjectLiteralExpression(node)) {
    const property = node.getProperty('message');
    if (property && Node.isPropertyAssignment(property)) {
      const text = literalText(property.getInitializer());
      if (text !== undefined) return fill(text, params);
    }
  }
  return undefined;
}

function fill(text: string, params: Map<string, string>): string {
  return text.replace(/\$\{\s*([A-Za-z_$][\w$]*)(?:\.[^}]*)?\s*\}/g, (whole, name: string) => {
    const value = params.get(name);
    if (value === undefined) return whole;
    return whole.includes('.toLowerCase()') ? value.toLowerCase() : value;
  });
}

/** The schema a `safeParse`/`parse`/`validate` call or a resolver names. */
export function schemaCallIn(
  node: Node,
): Array<{ schema: string; call: CallExpression; method: string }> {
  const found: Array<{ schema: string; call: CallExpression; method: string }> = [];
  for (const call of node.getDescendantsOfKind(SyntaxKind.CallExpression)) {
    const callee = call.getExpression();
    if (Node.isPropertyAccessExpression(callee)) {
      const method = callee.getName();
      if (
        !/^(safeParse|parse|safeParseAsync|parseAsync|validate|validateSync|validateAsync)$/.test(
          method,
        )
      )
        continue;
      const receiver = unwrap(callee.getExpression());
      if (!Node.isIdentifier(receiver)) continue;
      // `JSON.parse` is not a schema.
      if (/^(JSON|Number|Date|Joi|z|yup)$/.test(receiver.getText())) continue;
      found.push({ schema: receiver.getText(), call, method });
    } else if (Node.isIdentifier(callee) && /Resolver$/.test(callee.getText())) {
      const arg = call.getArguments()[0];
      if (arg && Node.isIdentifier(arg))
        found.push({ schema: arg.getText(), call, method: callee.getText() });
    }
  }
  return found;
}

/** Keys of an object literal passed to a DB call: the filter or the document. */
export function argumentKeys(call: CallExpression, index: number): string[] {
  const arg = call.getArguments()[index];
  if (!arg) return [];
  const value = unwrap(arg);
  if (Node.isObjectLiteralExpression(value)) return objectKeysOf(value);
  return [];
}

export type { Expression };
