import { Node, SyntaxKind, type SourceFile } from 'ts-morph';
import type { FlowGraph } from '../graph/graph.js';
import { ids } from '../graph/ids.js';
import { callsIn, calleeMember, lineOf, readString } from './ast.js';
import { HTTP_METHODS, type HttpMethod } from './http.js';
import { linkDbOperations, type CollectionAliases } from './dbaccess.js';
import type { LoadedProject } from './project.js';
import { isFileSystemRoute } from './classify.js';

/**
 * File-system routing: the backend that has no controllers.
 *
 * A large share of Next.js apps put their entire API in `pages/api/**` or
 * `app/**\/route.ts`, where the URL comes from the *path on disk* and the HTTP
 * method from an exported function name or a `req.method` branch. There is no
 * decorator to read, so without this the backend half of such a project is
 * invisible — the analyzer would report a frontend making calls into nothing.
 *
 * Supported conventions:
 *   pages/api/customers.ts              ->  /customers        (all methods)
 *   pages/api/customers/[id].ts         ->  /customers/:param
 *   pages/api/customers/[...slug].ts    ->  /customers/*
 *   app/api/customers/route.ts          ->  /customers        (per exported verb)
 *   server/api/customers.get.ts         ->  /customers        (Nuxt)
 */
export interface FileRouteConfig {
  apiPrefixes: string[];
  /** Collection handles produced by a factory; see `collectionAliasesOf`. */
  collectionAliases?: CollectionAliases;
}

export function analyzeFileRoutes(
  loaded: LoadedProject,
  graph: FlowGraph,
  config: FileRouteConfig,
): number {
  let declared = 0;

  for (const file of loaded.sourceFiles) {
    const rel = loaded.rel(file);
    if (!isFileSystemRoute(rel)) continue;

    const path = routePathFromFile(rel, config.apiPrefixes);
    if (path === undefined) continue;

    const methods = methodsOf(file, rel);
    /**
     * One handler per exported verb, when the file exports them separately.
     *
     * An App Router `route.ts` commonly exports `GET`, `PUT` and `DELETE` side
     * by side. Giving the file a single handler merged all three, so a flow
     * through the PUT reported the DELETE's query too — a phantom
     * `products.deleteOne` on an edit. Where the verbs are separate functions
     * they get separate handlers, and each one's queries are scoped to its own
     * body.
     */
    const perVerb = verbFunctions(file);

    for (const method of methods) {
      const routeId = ids.route(method, path);
      graph.addNode({
        id: routeId,
        kind: 'route',
        label: `${method} ${path}`,
        source: { file: rel, line: 1 },
        meta: { httpMethod: method, path, framework: 'file-route', handler: rel },
      });
      const scope = perVerb.get(method);
      const handlerId = scope
        ? declareVerbHandler(rel, graph, path, method, lineOf(scope))
        : declareHandler(file, rel, graph, path);
      graph.addEdge({ from: routeId, to: handlerId, kind: 'calls' });
      declared += 1;
    }

    if (perVerb.size > 0) {
      for (const [method, scope] of perVerb) {
        const handlerId = declareVerbHandler(rel, graph, path, method, lineOf(scope));
        linkDbOperations(scope, file, rel, graph, handlerId, config.collectionAliases);
      }
    } else {
      /**
       * A Pages Router module branches on `req.method` inside one function, so
       * there is nothing finer to scope to: the whole file is the handler.
       */
      const handlerId = declareHandler(file, rel, graph, path);
      linkDbOperations(file, file, rel, graph, handlerId, config.collectionAliases);
    }
  }

  return declared;
}

/**
 * Turn a path on disk into a URL path.
 *
 * `pages/api/shop/[shopId]/order/[orderId].ts` -> `/shop/:param/order/:param`
 */
export function routePathFromFile(rel: string, apiPrefixes: string[] = []): string | undefined {
  const normalizedRel = rel.split('\\').join('/');

  // Everything after the routing root.
  const match =
    /(?:^|\/)pages\/api\/(.*)$/.exec(normalizedRel) ??
    /(?:^|\/)app\/(.*)\/route\.[cm]?[jt]sx?$/.exec(normalizedRel) ??
    /(?:^|\/)app\/(route)\.[cm]?[jt]sx?$/.exec(normalizedRel) ??
    /(?:^|\/)server\/(?:api|routes)\/(.*)$/.exec(normalizedRel);

  if (!match) return undefined;
  let remainder = match[1] ?? '';
  if (remainder === 'route') remainder = '';

  // Strip the extension, and any Nuxt method suffix (`customers.get.ts`).
  remainder = remainder
    .replace(/\.[cm]?[jt]sx?$/, '')
    .replace(/\.(get|post|put|patch|delete)$/i, '');

  const segments = remainder
    .split('/')
    .filter((segment) => segment.length > 0)
    // `index` is the directory itself, and Next.js route groups `(admin)` and
    // private folders `_lib` never appear in the URL.
    .filter((segment) => segment !== 'index')
    .filter((segment) => !/^\(.*\)$/.test(segment))
    .map((segment) => {
      if (/^\[\.\.\..+\]$/.test(segment)) return '*'; // catch-all
      if (/^\[.+\]$/.test(segment)) return ':param'; // dynamic
      return segment;
    });

  /**
   * Strip a configured prefix if it is still present.
   *
   * The two Next.js routers differ here: `pages/api/orders.ts` yields `orders`
   * (the `api` segment is part of the convention), while
   * `app/api/orders/route.ts` yields `api/orders`. Left unstripped, the App
   * Router case produced `/api/orders` against a frontend call normalised to
   * `/orders`, and nothing matched.
   *
   * Done by segment rather than through `normalizePath`, which would rewrite a
   * catch-all `*` into `:param` and lose its meaning.
   */
  const prefixes = apiPrefixes.map((prefix) => prefix.replace(/^\/+|\/+$/g, ''));
  if (segments.length > 0 && prefixes.includes(segments[0] ?? '')) {
    segments.shift();
  }

  return segments.length > 0 ? `/${segments.join('/')}` : '/';
}

/**
 * Which HTTP methods this handler serves.
 *
 * App Router exports one function per verb. Pages Router exports a single
 * handler and branches on `req.method`, so the branches are read; a handler
 * with no recognisable branch is assumed to answer every method, which is what
 * it actually does.
 */
function methodsOf(file: SourceFile, rel: string): HttpMethod[] {
  const found = new Set<HttpMethod>();

  // App Router / Nuxt: `export async function POST(request) {}`
  for (const fn of file.getFunctions()) {
    const name = (fn.getName() ?? '').toUpperCase();
    if (fn.isExported() && isHttpMethod(name)) found.add(name);
  }
  for (const declaration of file.getVariableDeclarations()) {
    const name = declaration.getName().toUpperCase();
    if (!isHttpMethod(name)) continue;
    const statement = declaration.getVariableStatement();
    if (statement?.isExported()) found.add(name);
  }

  // Nuxt file suffix: `customers.get.ts`
  const suffix = /\.(get|post|put|patch|delete)\.[cm]?[jt]sx?$/i.exec(rel);
  if (suffix?.[1]) {
    const method = suffix[1].toUpperCase();
    if (isHttpMethod(method)) found.add(method);
  }

  if (found.size > 0) return [...found];

  // Pages Router: read `req.method === 'POST'` style branches.
  for (const comparison of file.getDescendantsOfKind(SyntaxKind.BinaryExpression)) {
    const operator = comparison.getOperatorToken().getKind();
    if (
      operator !== SyntaxKind.EqualsEqualsEqualsToken &&
      operator !== SyntaxKind.EqualsEqualsToken
    ) {
      continue;
    }
    const left = comparison.getLeft().getText();
    const right = comparison.getRight();
    if (!/\.method$/.test(left)) continue;
    const value = readString(right)?.toUpperCase();
    if (value && isHttpMethod(value)) found.add(value);
  }

  // `switch (req.method) { case 'POST': }`
  for (const statement of file.getDescendantsOfKind(SyntaxKind.SwitchStatement)) {
    if (!/\.method$/.test(statement.getExpression().getText())) continue;
    for (const clause of statement.getClauses()) {
      if (!Node.isCaseClause(clause)) continue;
      const value = readString(clause.getExpression())?.toUpperCase();
      if (value && isHttpMethod(value)) found.add(value);
    }
  }

  // `if (['POST','PUT'].includes(req.method))`
  for (const call of callsIn(file)) {
    if (calleeMember(call) !== 'includes') continue;
    const [argument] = call.getArguments();
    if (!argument || !/\.method$/.test(argument.getText())) continue;
    const receiver = call.getExpression();
    if (!Node.isPropertyAccessExpression(receiver)) continue;
    const array = receiver.getExpression();
    if (!Node.isArrayLiteralExpression(array)) continue;
    for (const element of array.getElements()) {
      const value = readString(element)?.toUpperCase();
      if (value && isHttpMethod(value)) found.add(value);
    }
  }

  return found.size > 0 ? [...found] : [...HTTP_METHODS];
}

/** One method node per route file, named after the file. */
/**
 * Exported functions named after an HTTP verb, and their bodies.
 *
 * Empty for a Pages Router module, which has one default-exported handler.
 */
function verbFunctions(file: SourceFile): Map<HttpMethod, Node> {
  const out = new Map<HttpMethod, Node>();

  for (const fn of file.getFunctions()) {
    const name = (fn.getName() ?? '').toUpperCase();
    if (fn.isExported() && isHttpMethod(name)) out.set(name, fn);
  }
  for (const declaration of file.getVariableDeclarations()) {
    const name = declaration.getName().toUpperCase();
    if (!isHttpMethod(name)) continue;
    if (!declaration.getVariableStatement()?.isExported()) continue;
    const initializer = declaration.getInitializer();
    if (initializer) out.set(name, initializer);
  }

  return out;
}

/** The handler node for one verb of a multi-verb route module. */
function declareVerbHandler(
  rel: string,
  graph: FlowGraph,
  path: string,
  method: HttpMethod,
  line: number,
): string {
  const handlerId = ids.method(`controller:${rel}#file-route`, method);
  graph.addNode({
    id: handlerId,
    kind: 'method',
    label: `${method} ${path} handler`,
    source: { file: rel, line },
    meta: { framework: 'file-route', path, httpMethod: method },
  });
  return handlerId;
}

function declareHandler(file: SourceFile, rel: string, graph: FlowGraph, path: string): string {
  const handlerId = ids.method(`controller:${rel}#file-route`, 'handler');
  graph.addNode({
    id: handlerId,
    kind: 'method',
    label: `${rel} handler`,
    source: { file: rel, line: 1 },
    meta: { framework: 'file-route', path },
  });
  void file;
  return handlerId;
}

function isHttpMethod(value: string): value is HttpMethod {
  return (HTTP_METHODS as readonly string[]).includes(value);
}
