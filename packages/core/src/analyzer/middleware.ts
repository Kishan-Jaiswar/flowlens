/**
 * The steps that run before the handler.
 *
 * `@UseGuards(JwtAuthGuard)` on a controller is the reason a request 401s, and
 * `auth` in `router.post('/orders', auth, createOrder)` is the reason the same
 * route needs a token — neither is visible anywhere in the handler you are
 * reading. Both were previously skipped: the Express pass explicitly took "the
 * last function-ish argument" and dropped the rest, and Nest's decorators were
 * only ever read for route verbs.
 *
 * That made the most common day-three question unanswerable. "Show me
 * everything that happened when I clicked this" has to include the guard that
 * could stop it.
 */

import { Node, SyntaxKind, type ClassDeclaration, type MethodDeclaration } from 'ts-morph';
import type { FlowGraph } from '../graph/graph.js';
import { ids } from '../graph/ids.js';
import { lineOf } from './ast.js';

/** What a pre-handler step does, which is what a developer wants to know. */
export type MiddlewareRole = 'guard' | 'interceptor' | 'pipe' | 'filter' | 'middleware';

/**
 * Nest decorators, mapped to the role they declare.
 *
 * Read from both the class and the method, because Nest applies both and the
 * class-level one is the one people forget.
 */
const DECORATOR_ROLES: Record<string, MiddlewareRole> = {
  UseGuards: 'guard',
  UseInterceptors: 'interceptor',
  UsePipes: 'pipe',
  UseFilters: 'filter',
};

/**
 * How each role reads in a sentence about a route.
 *
 * Phrased as a step rather than a noun ("checked by", not "guard") because that
 * is how it appears in an execution path.
 */
export const MIDDLEWARE_LABEL: Record<MiddlewareRole, string> = {
  guard: 'checked by',
  interceptor: 'wrapped by',
  pipe: 'validated by',
  filter: 'errors handled by',
  middleware: 'passes through',
};

/**
 * Express middleware that is framework plumbing, not application logic.
 *
 * `express.json()` on every route is noise: it tells the reader nothing about
 * why *this* route behaves the way it does, and listing it on 200 routes buries
 * the `requireAdmin` that matters.
 */
const PLUMBING = new Set([
  'json',
  'urlencoded',
  'text',
  'raw',
  'static',
  'cookieParser',
  'bodyParser',
  'compression',
  'cors',
  'helmet',
  'morgan',
  'logger',
  'express',
]);

/**
 * Attach the guards, interceptors and pipes declared for one Nest route.
 *
 * Class-level decorators are recorded first so that a reader sees them in the
 * order the framework runs them.
 */
export function linkNestMiddleware(
  declaration: ClassDeclaration,
  method: MethodDeclaration,
  routeId: string,
  file: string,
  graph: FlowGraph,
): number {
  let linked = 0;
  for (const [owner, scope] of [
    [declaration, 'controller'],
    [method, 'method'],
  ] as const) {
    for (const decorator of owner.getDecorators()) {
      const role = DECORATOR_ROLES[decorator.getName()];
      if (!role) continue;
      for (const argument of decorator.getArguments()) {
        const name = referencedName(argument);
        if (!name) continue;
        linked += addMiddleware(graph, {
          name,
          role,
          routeId,
          file,
          line: lineOf(decorator),
          framework: 'nestjs',
          scope,
        });
      }
    }
  }
  return linked;
}

/**
 * Attach Express middleware given inline on a route.
 *
 * `handlerIndex` is the argument the caller already identified as the handler;
 * everything between the path and it is middleware. Deriving it from the
 * caller's own decision keeps the two passes from disagreeing about which
 * argument is which.
 */
export function linkExpressMiddleware(
  args: readonly Node[],
  handlerIndex: number,
  routeId: string,
  rel: string,
  graph: FlowGraph,
): number {
  let linked = 0;
  for (let index = 1; index < handlerIndex; index += 1) {
    const argument = args[index];
    if (!argument) continue;
    for (const name of middlewareNames(argument)) {
      if (PLUMBING.has(name)) continue;
      linked += addMiddleware(graph, {
        name,
        role: 'middleware',
        routeId,
        file: rel,
        line: lineOf(argument),
        framework: 'express',
        scope: 'route',
      });
    }
  }
  return linked;
}

interface MiddlewareInput {
  name: string;
  role: MiddlewareRole;
  routeId: string;
  file: string;
  line: number;
  framework: string;
  scope: string;
}

function addMiddleware(graph: FlowGraph, input: MiddlewareInput): number {
  const id = ids.middleware(input.name);
  graph.addNode({
    id,
    kind: 'middleware',
    label: input.name,
    source: { file: input.file, line: input.line },
    meta: { role: input.role, framework: input.framework, scope: input.scope },
  });
  graph.addEdge({
    from: input.routeId,
    to: id,
    kind: 'guarded-by',
    // Where it is applied to this route: one middleware is applied in many places.
    meta: { role: input.role, scope: input.scope, file: input.file, line: input.line },
  });
  return 1;
}

/**
 * The names an Express middleware argument contributes.
 *
 * An array is unwrapped (`router.get('/x', [auth, rateLimit], handler)`) and a
 * factory call keeps the factory's name (`requireRole('admin')` is
 * `requireRole`), because that is the symbol a reader will search for.
 */
function middlewareNames(argument: Node): string[] {
  if (Node.isArrayLiteralExpression(argument)) {
    return argument.getElements().flatMap((element) => middlewareNames(element));
  }
  const name = referencedName(argument);
  return name ? [name] : [];
}

/** `JwtAuthGuard`, `new RolesGuard()`, `requireRole('admin')`, `auth.verify`. */
function referencedName(node: Node): string | undefined {
  if (Node.isIdentifier(node)) return node.getText();
  if (Node.isNewExpression(node) || Node.isCallExpression(node)) {
    return referencedName(node.getExpression());
  }
  if (Node.isPropertyAccessExpression(node)) return node.getName();
  return undefined;
}

/**
 * Middleware a Nest module applies in `configure(consumer)`:
 *
 *   consumer.apply(StaffMiddleware).exclude({ path: 'api/x', method: GET }).forRoutes(AppointmentsController);
 *
 * is how a real Nest app puts its auth in front of most routes, and reading
 * only `@UseGuards` decorators left every such route looking unprotected.
 * `forRoutes` takes `'*'`, paths, `{ path, method }` and controller classes;
 * `exclude` the same, minus the classes. Paths are matched with the API prefix
 * stripped, as the routes are stored, and `:id` matches any segment.
 */
export function linkNestConsumerMiddleware(
  files: readonly import('ts-morph').SourceFile[],
  rel: (file: import('ts-morph').SourceFile) => string,
  graph: FlowGraph,
  apiPrefixes: readonly string[],
): number {
  const routes = graph
    .nodesOfKind('route')
    .filter((route) => route.meta?.['framework'] === 'nestjs');
  if (routes.length === 0) return 0;
  let linked = 0;
  // `app.useGlobalPipes(new ValidationPipe(…))` in main.ts runs for every route.
  const GLOBAL: Record<string, MiddlewareRole> = {
    useGlobalPipes: 'pipe',
    useGlobalGuards: 'guard',
    useGlobalInterceptors: 'interceptor',
    useGlobalFilters: 'filter',
  };
  for (const file of files) {
    if (!file.getFullText().includes('useGlobal')) continue;
    for (const call of file.getDescendantsOfKind(SyntaxKind.CallExpression)) {
      const callee = call.getExpression();
      const role = Node.isPropertyAccessExpression(callee) ? GLOBAL[callee.getName()] : undefined;
      if (!role) continue;
      for (const name of call.getArguments().map((argument) => referencedName(argument))) {
        if (!name) continue;
        for (const route of routes) {
          // Applied on the controller as well: one step, where the route names it.
          if (
            graph
              .edgesFrom(route.id, ['guarded-by'])
              .some((edge) => edge.to === ids.middleware(name))
          )
            continue;
          linked += addMiddleware(graph, {
            name,
            role,
            routeId: route.id,
            file: rel(file),
            line: lineOf(call),
            framework: 'nestjs',
            scope: 'global',
          });
        }
      }
    }
  }
  for (const file of files) {
    if (!file.getFullText().includes('forRoutes')) continue;
    for (const call of file.getDescendantsOfKind(SyntaxKind.CallExpression)) {
      const callee = call.getExpression();
      if (!Node.isPropertyAccessExpression(callee) || callee.getName() !== 'forRoutes') continue;
      // Walk back down the chain: forRoutes(...) <- exclude(...) <- apply(...).
      const targets = call.getArguments();
      let excludes: Node[] = [];
      let applied: Node[] = [];
      for (
        let link: Node | undefined = callee.getExpression();
        link && Node.isCallExpression(link);
        link = Node.isPropertyAccessExpression(link.getExpression())
          ? (link.getExpression() as import('ts-morph').PropertyAccessExpression).getExpression()
          : undefined
      ) {
        const inner = link.getExpression();
        if (!Node.isPropertyAccessExpression(inner)) break;
        if (inner.getName() === 'exclude') excludes = link.getArguments();
        if (inner.getName() === 'apply') applied = link.getArguments();
      }
      const names = applied
        .map((argument) => referencedName(argument))
        .filter((name): name is string => name !== undefined && !PLUMBING.has(name));
      if (names.length === 0) continue;
      for (const route of routes) {
        if (!targets.some((target) => routeMatches(target, route, apiPrefixes, true))) continue;
        if (excludes.some((target) => routeMatches(target, route, apiPrefixes, false))) continue;
        for (const name of names) {
          linked += addMiddleware(graph, {
            name,
            role: 'middleware',
            routeId: route.id,
            file: rel(file),
            line: lineOf(call),
            framework: 'nestjs',
            scope: 'module',
          });
        }
      }
    }
  }
  return linked;
}

/** Does a `forRoutes`/`exclude` argument cover this route? */
function routeMatches(
  target: Node,
  route: { meta?: Record<string, unknown> },
  apiPrefixes: readonly string[],
  classes: boolean,
): boolean {
  const path = String(route.meta?.['path'] ?? '');
  const method = String(route.meta?.['httpMethod'] ?? '').toUpperCase();
  if (Node.isStringLiteral(target) || Node.isNoSubstitutionTemplateLiteral(target))
    return pathMatches(target.getLiteralValue(), path, apiPrefixes);
  if (Node.isIdentifier(target)) return classes && route.meta?.['controller'] === target.getText();
  if (Node.isObjectLiteralExpression(target)) {
    const pathProperty = target.getProperty('path');
    const pathValue =
      pathProperty && Node.isPropertyAssignment(pathProperty)
        ? pathProperty.getInitializer()
        : undefined;
    if (
      !pathValue ||
      (!Node.isStringLiteral(pathValue) && !Node.isNoSubstitutionTemplateLiteral(pathValue))
    )
      return false;
    if (!pathMatches(pathValue.getLiteralValue(), path, apiPrefixes)) return false;
    const methodProperty = target.getProperty('method');
    const methodValue =
      methodProperty && Node.isPropertyAssignment(methodProperty)
        ? (methodProperty.getInitializer()?.getText().split('.').pop() ?? 'ALL')
        : 'ALL';
    return methodValue === 'ALL' || methodValue === method;
  }
  return false;
}

/** `'/api/appointments/:id'` against the stored `/appointments/:param`; `*` matches the rest. */
function pathMatches(pattern: string, path: string, apiPrefixes: readonly string[]): boolean {
  const strip = (value: string): string[] => {
    let text = `/${value.replace(/^\/+/, '')}`;
    for (const prefix of apiPrefixes) {
      if (text === prefix || text.startsWith(`${prefix}/`)) text = text.slice(prefix.length) || '/';
    }
    return text.split('/').filter(Boolean);
  };
  const want = strip(pattern);
  const have = strip(path);
  for (let index = 0; index < want.length; index += 1) {
    const segment = want[index]!;
    if (segment === '*' || segment.endsWith('*')) return true;
    const actual = have[index];
    if (actual === undefined) return false;
    // `:id` in the pattern takes any value; a route's own `:id` is not `opd-data`.
    if (segment.startsWith(':')) continue;
    if (segment !== actual) return false;
  }
  return want.length === have.length || (want.length === 0 && pattern.trim() === '*');
}

/**
 * Join a middleware or guard to the code it runs that no call names.
 *
 * `new JwtAuthGuard().canActivate(ctx)` inside a middleware, and
 * `super.canActivate(ctx)` in `class JwtAuthGuard extends AuthGuard('jwt')` —
 * which runs the Passport strategy registered as 'jwt', and its `validate`.
 * Without these edges the staff and doctor reads that decide who the user is
 * were missing from every request's database list.
 */
export function linkGuardCalls(
  files: readonly import('ts-morph').SourceFile[],
  graph: FlowGraph,
): number {
  const methods = new Map(graph.nodesOfKind('method').map((node) => [node.label, node.id]));
  /** Passport strategy name -> its `validate` method's node. */
  const strategies = new Map<string, string>();
  for (const file of files) {
    if (!file.getFullText().includes('PassportStrategy')) continue;
    const library = file
      .getImportDeclarations()
      .map((declaration) => declaration.getModuleSpecifierValue())
      .find((specifier) => /^passport-/.test(specifier))
      ?.replace(/^passport-/, '');
    for (const strategy of file.getClasses()) {
      const extended = strategy.getExtends()?.getText() ?? '';
      if (!/PassportStrategy\(/.test(extended)) continue;
      const named = /,\s*['"`]([\w-]+)['"`]\s*\)/.exec(extended)?.[1] ?? library;
      const id = methods.get(`${strategy.getName()}.validate`);
      if (named && id) strategies.set(named, id);
    }
  }
  let linked = 0;
  for (const file of files) {
    for (const owner of file.getClasses()) {
      for (const method of owner.getMethods()) {
        const from = methods.get(`${owner.getName()}.${method.getName()}`);
        if (!from) continue;
        for (const call of method.getDescendantsOfKind(SyntaxKind.CallExpression)) {
          const callee = call.getExpression();
          if (!Node.isPropertyAccessExpression(callee)) continue;
          const receiver = callee.getExpression();
          let to: string | undefined;
          if (Node.isNewExpression(receiver))
            to = methods.get(`${receiver.getExpression().getText()}.${callee.getName()}`);
          else if (receiver.getText() === 'super' && callee.getName() === 'canActivate') {
            const wanted = /AuthGuard\(\s*['"`]([\w-]+)['"`]/.exec(
              owner.getExtends()?.getText() ?? '',
            )?.[1];
            to = wanted ? strategies.get(wanted) : undefined;
          }
          if (!to || to === from) continue;
          graph.addEdge({ from, to, kind: 'calls', meta: { line: lineOf(call) } });
          linked += 1;
        }
      }
    }
  }
  return linked;
}
