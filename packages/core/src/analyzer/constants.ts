import { Node, SyntaxKind, type SourceFile } from 'ts-morph';
import { readPathLike, readString } from './ast.js';
import { envValue } from './driver.js';
import { ENV_MARKER } from './http.js';
import { moduleResolver } from './imports.js';
import type { LoadedProject } from './project.js';

/**
 * A project-wide table of string constants.
 *
 * Real frontends do not write URLs at the call site. They keep a module of
 * endpoint constants —
 *
 *   // misc/apiEndPointes.js
 *   export const getCustomersList = "/admin/customers";
 *
 * — and call `getRequest({ url: getCustomersList })`. Without resolving that
 * identifier back to its literal, the analyzer sees a variable, gives up, and
 * every single API call in the codebase is lost.
 */
export interface ConstantTable {
  /** Unambiguous name -> literal value. */
  values: Map<string, string>;
  /** Names declared more than once with different values. */
  ambiguous: Set<string>;
  /** HTTP client instances the project makes: `const aria = axios.create(...)`. */
  clients: Set<string>;
  /**
   * Resolve a name, or undefined if unknown or ambiguous. Given the node it is read
   * at, the file's own constant or the one it imports wins over the project-wide table.
   */
  resolve(name: string, at?: Node): string | undefined;
}

/** Only strings that could plausibly be a URL path are worth keeping. */
const PATH_LIKE = /^[/a-zA-Z0-9_\-.:{}$<>?=&%]*$/;
const MAX_LENGTH = 300;

/**
 * Collect exported and module-level string constants across the project.
 *
 * Deliberately name-keyed rather than scope-aware: resolving imports properly
 * would mean full module resolution, which `loadProject` skips on purpose. In
 * practice endpoint constants have distinctive names and live in one module, so
 * a name collision is rare — and when it happens the name is marked ambiguous
 * and skipped rather than guessed at.
 */
export function collectConstants(loaded: LoadedProject): ConstantTable {
  const values = new Map<string, string>();
  const ambiguous = new Set<string>();

  const env = (name: string): string => envBase(loaded.roots, name);
  /** file -> its own module-level constants, for names declared differently elsewhere. */
  const perFile = new Map<string, Map<string, string>>();
  for (const file of loaded.sourceFiles) {
    const own = stringConstantsIn(file, env);
    if (own.length > 0) perFile.set(loaded.rel(file), new Map(own));
    for (const [name, value] of own) {
      const existing = values.get(name);
      if (existing === undefined) {
        values.set(name, value);
        continue;
      }
      if (existing !== value) {
        ambiguous.add(name);
      }
    }
  }

  for (const name of ambiguous) values.delete(name);
  const read = (name: string): string | undefined => {
    const variable = ENV_READ.exec(name);
    return variable ? env((variable[1] ?? variable[2])!) : values.get(name);
  };
  const clients = new Set<string>();
  const bases = clientBases(loaded, read, clients);
  const resolver = moduleResolver(loaded);
  /** `name` as `file` sees it: declared there, or imported from a scanned file. */
  const scoped = (name: string, file: SourceFile): string | undefined => {
    const own = perFile.get(loaded.rel(file))?.get(name);
    if (own !== undefined) return own;
    for (const declaration of file.getImportDeclarations()) {
      const named = declaration
        .getNamedImports()
        .find((entry) => (entry.getAliasNode()?.getText() ?? entry.getName()) === name);
      if (!named) continue;
      const target = resolver.resolve(declaration.getModuleSpecifierValue(), file.getFilePath());
      return target ? perFile.get(target)?.get(named.getName()) : undefined;
    }
    return undefined;
  };

  return {
    values,
    ambiguous,
    clients,
    resolve(name: string, at?: Node) {
      if (name.startsWith(BASE_KEY)) return bases.get(name.slice(BASE_KEY.length));
      return (
        (at && !ENV_READ.test(name) ? scoped(name, at.getSourceFile()) : undefined) ?? read(name)
      );
    },
  };
}

/** `resolve("base:getRequest")`: the base URL a client or request wrapper sends to. */
export const BASE_KEY = 'base:';

/** `axios.create(...)`, `ky.create(...)`: what they return sends requests. */
const CLIENT_FACTORY = /^(axios|ky)\.create$/;

const HTTP_VERBS = /^(get|post|put|patch|delete|head|options|request)$/;

/**
 * The base URL each HTTP client sends to, and each wrapper function through it:
 *
 *   const api = axios.create({ baseURL: process.env.API_HOST });
 *   export const getRequest = ({ url }) => api.get(url);     // getRequest → <env:API_HOST=>
 *
 * A name that means two different bases in two files is left out rather than guessed.
 */
function clientBases(
  loaded: LoadedProject,
  read: (name: string) => string | undefined,
  clients: Set<string>,
): Map<string, string> {
  const bases = new Map<string, string>();
  const ambiguous = new Set<string>();
  const keep = (name: string, base: string): void => {
    const existing = bases.get(name);
    if (existing === undefined) bases.set(name, base);
    else if (existing !== base) ambiguous.add(name);
  };

  for (const file of loaded.sourceFiles)
    for (const declaration of file.getVariableDeclarations()) {
      const init = declaration.getInitializer();
      if (
        !init ||
        !Node.isCallExpression(init) ||
        !/\.create$/.test(init.getExpression().getText())
      )
        continue;
      if (CLIENT_FACTORY.test(init.getExpression().getText())) clients.add(declaration.getName());
      const options = init.getArguments()[0];
      if (!options || !Node.isObjectLiteralExpression(options)) continue;
      const property = options.getProperty('baseURL');
      const value =
        property && Node.isPropertyAssignment(property) ? property.getInitializer() : undefined;
      const shorthand =
        property && Node.isShorthandPropertyAssignment(property) ? read('baseURL') : undefined;
      const base = (value ? readPathLike(value, read) : shorthand)?.trim();
      if (base) keep(declaration.getName(), base.replace(/\/+$/, ''));
    }
  const instances = [...bases.keys()];
  /** `axios.get(...)` in a wrapper: no base of its own, but its URL may carry one. */
  const receiverBase = (receiver: string): string | undefined =>
    bases.get(receiver) ?? (receiver === 'axios' ? '' : undefined);
  for (const file of loaded.sourceFiles) {
    const text = file.getFullText();
    if (!text.includes('axios') && !instances.some((name) => text.includes(name))) continue;
    const functions: Array<[string, Node]> = [
      ...file.getFunctions().map((fn): [string, Node] => [fn.getName() ?? '', fn]),
      ...file
        .getVariableDeclarations()
        .filter((d) => {
          const init = d.getInitializer();
          return Boolean(init && (Node.isArrowFunction(init) || Node.isFunctionExpression(init)));
        })
        .map((d): [string, Node] => [d.getName(), d.getInitializer()!]),
    ];
    for (const [name, fn] of functions) {
      if (!name || bases.has(name)) continue;
      for (const call of fn.getDescendantsOfKind(SyntaxKind.CallExpression)) {
        const callee = call.getExpression();
        if (!Node.isPropertyAccessExpression(callee) || !HTTP_VERBS.test(callee.getName()))
          continue;
        const instanceBase = receiverBase(callee.getExpression().getText());
        if (instanceBase === undefined) continue;
        // `${PG_API}${url}`: an absolute URL replaces the instance's baseURL, as axios does.
        const prefix = urlPrefix(call.getArguments()[0], parameterNames(fn), read) ?? '';
        const base = ABSOLUTE_OR_ENV.test(prefix) ? prefix : instanceBase + prefix;
        if (base) keep(name, base.replace(/\/+$/, ''));
        break;
      }
    }
  }
  for (const name of ambiguous) bases.delete(name);
  return bases;
}

/** A base that replaces the client's: `<env:PG_API=/api>` or `https://host/api`. */
const ABSOLUTE_OR_ENV = /^(<env:|[a-z][a-z0-9+.-]*:\/\/)/i;

/** Every name a function's parameters bind, destructured ones included. */
function parameterNames(fn: Node): Set<string> {
  const names = new Set<string>();
  if (
    !Node.isArrowFunction(fn) &&
    !Node.isFunctionExpression(fn) &&
    !Node.isFunctionDeclaration(fn)
  )
    return names;
  for (const parameter of fn.getParameters()) {
    const nameNode = parameter.getNameNode();
    for (const id of [nameNode, ...nameNode.getDescendantsOfKind(SyntaxKind.Identifier)])
      if (Node.isIdentifier(id)) names.add(id.getText());
  }
  return names;
}

/**
 * What a wrapper's URL puts in front of the `url` it was given: `${PG_API}${url}` →
 * PG_API's value. Undefined when the URL does not come from a parameter, or the part
 * before it cannot be read.
 */
function urlPrefix(
  url: Node | undefined,
  params: Set<string>,
  read: (name: string) => string | undefined,
): string | undefined {
  const parts: Array<string | Node> = [];
  const flatten = (node: Node): void => {
    if (Node.isParenthesizedExpression(node)) flatten(node.getExpression());
    else if (
      Node.isBinaryExpression(node) &&
      node.getOperatorToken().getKind() === SyntaxKind.PlusToken
    ) {
      flatten(node.getLeft());
      flatten(node.getRight());
    } else if (Node.isTemplateExpression(node)) {
      parts.push(node.getHead().getLiteralText());
      for (const span of node.getTemplateSpans()) {
        flatten(span.getExpression());
        parts.push(span.getLiteral().getLiteralText());
      }
    } else parts.push(node);
  };
  if (!url) return undefined;
  flatten(url);
  let prefix = '';
  for (const part of parts) {
    if (typeof part === 'string') {
      prefix += part;
      continue;
    }
    const ids = [part, ...part.getDescendantsOfKind(SyntaxKind.Identifier)];
    if (ids.some((id) => Node.isIdentifier(id) && params.has(id.getText()))) return prefix;
    const value = readPathLike(part, read);
    if (value === undefined) return undefined;
    prefix += value;
  }
  return undefined;
}

/** `process.env.API_HOST`, `process.env["API_HOST"]`. */
const ENV_READ = /^process\.env(?:\.([A-Za-z_]\w*)|\[\s*['"`]([A-Za-z_]\w*)['"`]\s*\])$/;

/**
 * A URL base read from the environment: `<env:API_HOST=/api/web>`, the variable and
 * the path its value holds in the project's env files (`https://host/api/web` → `/api/web`).
 *
 * The marker keeps which variable a call goes through — calls made through one that
 * never reaches this backend are calls to another service. Only the path is kept:
 * never the host, a user name, a password or a query string from those files.
 */
function envBase(roots: string[], name: string): string {
  const value = envValue(roots, name)?.value ?? '';
  let path = '';
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) {
    try {
      path = new URL(value).pathname;
    } catch {
      path = '';
    }
  } else if (value.startsWith('/')) path = value.split(/[?#]/)[0]!;
  return `${ENV_MARKER}${name}=${path.replace(/\/+$/, '')}>`;
}

/**
 * Module-level `const x = "..."` declarations.
 *
 * Two passes over the same file: plain literals first, then templates, so a
 * template that references an earlier constant in the same module can be
 * resolved (`const REPORTS = `${BASE}/reports``).
 */
function stringConstantsIn(
  file: SourceFile,
  env: (name: string) => string,
): Array<[string, string]> {
  const found: Array<[string, string]> = [];
  const local = new Map<string, string>();

  const declarations = file.getVariableDeclarations();

  for (const declaration of declarations) {
    let initializer = declaration.getInitializer();
    // `process.env.API_HOST || "http://localhost:3000"`: the variable is the base.
    if (
      initializer &&
      Node.isBinaryExpression(initializer) &&
      /^(\|\||\?\?)$/.test(initializer.getOperatorToken().getText())
    )
      initializer = initializer.getLeft();
    const variable = initializer && ENV_READ.exec(initializer.getText().replace(/\s+/g, ''));
    // `"/staff/create-staff "`: the stray space is not part of the route.
    const value = variable ? env((variable[1] ?? variable[2])!) : readString(initializer)?.trim();
    if (value === undefined) continue;
    if (value.length > MAX_LENGTH || !PATH_LIKE.test(value)) continue;
    const name = declaration.getName();
    local.set(name, value);
    found.push([name, value]);
  }

  for (const declaration of declarations) {
    const initializer = declaration.getInitializer();
    if (!initializer || !Node.isTemplateExpression(initializer)) continue;
    const name = declaration.getName();
    if (local.has(name)) continue;

    let text = initializer.getHead().getLiteralText();
    let resolvable = true;
    for (const span of initializer.getTemplateSpans()) {
      const expression = span.getExpression();
      const nested = Node.isIdentifier(expression) ? local.get(expression.getText()) : undefined;
      if (nested === undefined) {
        resolvable = false;
        break;
      }
      text += nested + span.getLiteral().getLiteralText();
    }
    if (!resolvable || text.length > MAX_LENGTH || !PATH_LIKE.test(text)) continue;
    local.set(name, text);
    found.push([name, text]);
  }

  // `const archivePatient = (id) => `/patients/${id}/archive``: a URL built from its
  // arguments, kept as `archivePatient()` with a placeholder for each.
  for (const declaration of declarations) {
    const initializer = declaration.getInitializer();
    if (!initializer || !Node.isArrowFunction(initializer)) continue;
    const body = initializer.getBody();
    const text = readPathLike(body, (name) => local.get(name))?.trim();
    if (!text || text.length > MAX_LENGTH || !PATH_LIKE.test(text)) continue;
    found.push([`${declaration.getName()}()`, text]);
  }

  return found;
}

/** An empty table, for callers that do not want constant resolution. */
export function emptyConstantTable(): ConstantTable {
  return { values: new Map(), ambiguous: new Set(), clients: new Set(), resolve: () => undefined };
}
