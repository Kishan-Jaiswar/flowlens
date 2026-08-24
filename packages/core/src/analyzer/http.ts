/**
 * The frontend/backend seam.
 *
 * The frontend says `POST /api/patients/${id}/archive`.
 * The backend says `@Controller('patients')` + `@Post(':id/archive')`.
 * Matching those two strings is the single most load-bearing piece of the
 * static analyzer — everything downstream (controller, service, collection)
 * hangs off getting it right.
 */

export const HTTP_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'] as const;
export type HttpMethod = (typeof HTTP_METHODS)[number];

/** A path segment that came from an interpolation or a route parameter. */
export const PARAM = ':param';

/**
 * Placeholder the AST reader leaves where a template interpolation was.
 * Kept distinct from `PARAM` so `normalizePath` can tell "the source wrote
 * `${something}` here" from "the route declares a parameter here".
 */
export const DYNAMIC_MARKER = '<param>';

/**
 * Normalise a URL written in source into a comparable shape.
 *
 * - strips a configurable API prefix (`/api`)
 * - drops query strings and trailing slashes
 * - replaces `${...}` interpolations, `:id` params and bare numeric/ObjectId
 *   segments with a single `:param` placeholder
 */
export function normalizePath(raw: string, apiPrefixes: string[] = ['/api']): string {
  let path = raw.trim();

  // Absolute URLs: keep only the path.
  const absolute = /^[a-z][a-z0-9+.-]*:\/\/[^/]+(\/.*)?$/i.exec(path);
  if (absolute) path = absolute[1] ?? '/';

  /**
   * A leading interpolation is a base URL, not a path segment.
   *
   *   `${baseUrl}/appointments/monthly`  ->  /appointments/monthly
   *   `${API_HOST}${getPatientsList}`    ->  /doctor/patients
   *
   * Real frontends almost never hardcode the host, so without this every call
   * in a codebase collapses to `/:param/:param` and nothing matches a route.
   * Only the first occurrence is removed — a genuine `/:tenantId/...` route
   * keeps its parameter.
   */
  if (path.startsWith(DYNAMIC_MARKER)) {
    path = path.slice(DYNAMIC_MARKER.length);
  }

  path = path.split('?')[0]!.split('#')[0]!;
  if (!path.startsWith('/')) path = `/${path}`;

  for (const prefix of apiPrefixes) {
    const clean = prefix.startsWith('/') ? prefix : `/${prefix}`;
    if (path === clean) {
      path = '/';
      break;
    }
    if (path.startsWith(`${clean}/`)) {
      path = path.slice(clean.length);
      break;
    }
  }

  const segments = path
    .split('/')
    .filter((segment) => segment.length > 0)
    .map(normalizeSegment);

  return segments.length > 0 ? `/${segments.join('/')}` : '/';
}

function normalizeSegment(segment: string): string {
  if (segment.startsWith(':') || segment.startsWith('*')) return PARAM;
  // `${id}` or an interpolation placeholder left by the AST reader
  if (/\$\{|\{\{|<param>/.test(segment)) return PARAM;
  // Express-style optional/regex segments and Nest wildcards
  if (/^\d+$/.test(segment)) return PARAM;
  if (/^[0-9a-f]{24}$/i.test(segment)) return PARAM; // Mongo ObjectId
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(segment)) return PARAM;
  return segment;
}

/**
 * Join a controller prefix and a method path into one normalised route path.
 *
 * `apiPrefixes` must be the *same* list used for frontend URLs. A NestJS app
 * with `setGlobalPrefix('api')` or `@Controller('api/doctor')` declares
 * `/api/doctor/patients` while its frontend calls `/api/doctor/patients` too —
 * stripping the prefix on one side only guarantees that nothing ever matches.
 */
export function joinRoutePath(prefix: string, suffix: string, apiPrefixes: string[] = []): string {
  const parts = [...prefix.split('/'), ...suffix.split('/')].filter((p) => p.length > 0);
  return normalizePath(`/${parts.join('/')}`, apiPrefixes);
}

export interface RouteLike {
  method: string;
  path: string;
}

/**
 * Does a frontend call match a backend route?
 *
 * Both sides are already normalised, so this is a segment-wise compare where
 * `:param` matches anything. Wildcards (`*`) match the rest of the path.
 */
export function routeMatches(call: RouteLike, route: RouteLike): boolean {
  if (call.method.toUpperCase() !== route.method.toUpperCase()) return false;
  const callSegments = call.path.split('/').filter(Boolean);
  const routeSegments = route.path.split('/').filter(Boolean);

  for (let i = 0; i < routeSegments.length; i += 1) {
    const routeSegment = routeSegments[i]!;
    if (routeSegment === '*') return true;
    const callSegment = callSegments[i];
    if (callSegment === undefined) return false;
    if (routeSegment === PARAM || callSegment === PARAM) continue;
    if (routeSegment !== callSegment) return false;
  }
  return callSegments.length === routeSegments.length;
}

/**
 * Pick the best backend route for a call.
 *
 * Scored segment by segment rather than by how literal the route is, because
 * the two directions are not symmetric:
 *
 *   call `/patients/stats`  → route `/patients/stats`   exact, best
 *   call `/patients/stats`  → route `/patients/:id`     plausible, weaker
 *   call `/patients/:param` → route `/patients/stats`   speculative — the
 *                                                      frontend interpolates a
 *                                                      value here, so a literal
 *                                                      route is a poor guess
 *
 * That last case is why literal-route-wins is wrong: `api.get(`/patients/${id}`)`
 * should resolve to `GET /patients/:id`, not to whatever fixed sub-route happens
 * to sit at the same depth.
 */
export function bestRouteMatch<T extends RouteLike>(call: RouteLike, routes: T[]): T | undefined {
  let best: T | undefined;
  let bestScore = -Infinity;
  for (const route of routes) {
    if (!routeMatches(call, route)) continue;
    const score = matchScore(call.path, route.path);
    if (score > bestScore) {
      best = route;
      bestScore = score;
    }
  }
  return best;
}

/** Higher is a better alignment between the call's path and the route's. */
export function matchScore(callPath: string, routePath: string): number {
  const callSegments = callPath.split('/').filter(Boolean);
  const routeSegments = routePath.split('/').filter(Boolean);
  let score = 0;

  for (let i = 0; i < routeSegments.length; i += 1) {
    const routeSegment = routeSegments[i]!;
    const callSegment = callSegments[i];
    if (routeSegment === '*') {
      score -= 2;
      continue;
    }
    if (callSegment === undefined) continue;

    const routeIsParam = routeSegment === PARAM;
    const callIsParam = callSegment === PARAM;

    if (!routeIsParam && !callIsParam)
      score += 3; // literal == literal
    else if (routeIsParam && callIsParam)
      score += 2; // param aligns with param
    else if (routeIsParam && !callIsParam)
      score += 1; // route generalises
    else score -= 1; // call is dynamic, route is literal
  }

  return score;
}
