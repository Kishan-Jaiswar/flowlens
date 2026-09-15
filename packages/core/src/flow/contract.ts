/**
 * What the frontend sends against what the backend accepts.
 *
 * The bug this catches has no compiler on its side. A form adds a field, the
 * DTO never learns about it, and the request succeeds — the value is simply
 * dropped, usually silently, usually discovered by a user. In the other
 * direction a DTO grows a field nobody sends, and the endpoint quietly relies
 * on a default.
 *
 * Both are already answerable from the graph: an `api-call` node records the
 * payload keys read at the call site, the route's DTO records its declared
 * fields, and the lineage pass has already matched the two wherever the names
 * agree. A key with no `flows-to` edge out of it is a key the backend does not
 * name.
 */

import type { FlowGraph } from '../graph/graph.js';
import type { FeatureFlow } from './resolve.js';

export interface ContractField {
  name: string;
  /** Where the value comes from in the component, when it is state. */
  source?: string;
  /** The DTO's declared type, when the backend named it. */
  type?: string;
}

export interface ContractCheck {
  /** `POST /orders` — the call this is about. */
  endpoint: string;
  /** The DTO the route validates, when it has one. */
  dto?: string;
  /** Keys the frontend sends that the DTO does not declare. */
  unexpected: ContractField[];
  /** DTO fields the frontend never sends. */
  missing: ContractField[];
  /** Keys that line up on both sides. */
  matched: string[];
  /**
   * True when the route declares no DTO at all.
   *
   * Reported rather than treated as "everything matches": a route that accepts
   * an untyped body is not in agreement with the frontend, it simply has no
   * opinion, and saying "0 problems" about it would be a wrong answer.
   */
  unchecked: boolean;
}

export interface FlowContract {
  checks: ContractCheck[];
  /** Total keys the frontend sends that no DTO accepts. */
  unexpectedCount: number;
  /** Total declared fields the frontend never sends. */
  missingCount: number;
  notes: string[];
}

/**
 * Compare every request this feature makes against the route that answers it.
 *
 * A feature with no payload-carrying call comes back empty, which is the honest
 * answer for a GET: there is no body to disagree about.
 */
export function checkFlowContract(graph: FlowGraph, flow: FeatureFlow): FlowContract {
  const checks: ContractCheck[] = [];

  for (const step of flow.steps) {
    if (step.kind !== 'api-call') continue;

    const payloadKeys = asStrings(step.meta?.['payloadKeys']);
    const sources = asRecord(step.meta?.['payloadSources']);

    // The route that answers this call, and the DTO it validates.
    const routes = graph.successors(step.nodeId, ['handled-by']);
    const dtoNode = routes
      .flatMap((route) => graph.successors(route.id, ['validates']))
      .find((node) => node.kind === 'dto');

    if (payloadKeys.length === 0 && !dtoNode) continue;

    const declared = dtoNode
      ? graph
          .successors(dtoNode.id, ['defines', 'validates'])
          .filter((node) => node.kind === 'field')
          .map((node) => ({
            name: String(node.meta?.['name'] ?? node.label),
            ...(node.meta?.['type'] ? { type: String(node.meta['type']) } : {}),
          }))
      : [];

    const declaredNames = new Set(declared.map((field) => field.name));
    const sentNames = new Set(payloadKeys);

    checks.push({
      endpoint: step.label,
      ...(dtoNode ? { dto: dtoNode.label } : {}),
      unexpected: dtoNode
        ? payloadKeys
            .filter((key) => !declaredNames.has(key))
            .map((key) => ({
              name: key,
              ...(sources[key] ? { source: String(sources[key]) } : {}),
            }))
        : [],
      missing: declared.filter((field) => !sentNames.has(field.name)),
      matched: payloadKeys.filter((key) => declaredNames.has(key)),
      unchecked: !dtoNode && payloadKeys.length > 0,
    });
  }

  const unexpectedCount = checks.reduce((sum, check) => sum + check.unexpected.length, 0);
  const missingCount = checks.reduce((sum, check) => sum + check.missing.length, 0);

  const notes: string[] = [];
  if (checks.some((check) => check.unchecked)) {
    notes.push(
      'One or more routes here accept a body with no DTO, so there is nothing to ' +
        'compare the payload against. This check needs a declared shape: NestJS ' +
        'DTO classes today, not yet Zod or Yup schemas, which is how most ' +
        'Next.js route handlers describe their input.',
    );
  }
  if (unexpectedCount > 0) {
    notes.push(
      'A key the DTO does not declare is usually dropped by the validation layer ' +
        'rather than rejected — the request succeeds and the value disappears.',
    );
  }
  if (missingCount > 0) {
    notes.push(
      'A declared field the frontend never sends is not necessarily a bug: it may ' +
        'be optional, or set by another caller. Flowslens does not read ' +
        'required-ness from validation decorators yet.',
    );
  }

  return { checks, unexpectedCount, missingCount, notes };
}

function asStrings(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : [];
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
