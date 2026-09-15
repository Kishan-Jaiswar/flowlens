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

import { Node, type ClassDeclaration, type MethodDeclaration } from 'ts-morph';
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
    meta: { role: input.role, scope: input.scope },
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
