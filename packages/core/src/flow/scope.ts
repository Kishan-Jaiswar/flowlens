import type { FlowGraph } from '../graph/graph.js';
import { testsForFlow, type TestIndex } from '../analyzer/testcoverage.js';
import { SourceReader } from './actionsource.js';
import { actionDecisions, type ActionDecisions } from './decisions.js';
import { flowTiming } from './insight.js';
import type { FeatureFlow } from './resolve.js';

/**
 * A page, a card or a dialog, summed up from the actions in it.
 *
 * The dashboard's tabs answer questions about one action. Opened on a screen
 * of the app's sidebar, they answer the same questions about everything on
 * that screen: which of its actions are slow, which are tested, which can go
 * more than one way, what they write and who else depends on it. Each answer
 * is the per-action one, kept per action, so the screen's tab can list them
 * and open any of them.
 */

export interface ScopeAction {
  id: string;
  title: string;
  event?: string;
  endpoints: string[];
  collections: Array<{ name: string; effect: string }>;
  risk: FeatureFlow['risk'];
  source?: FeatureFlow['source'];
  timing: { observed: boolean; totalMs?: number };
  tests: { totalCases: number; coveragePct: number; untested: string[] };
  /** Branch and outcome counts, for actions that reach the backend. */
  decisions?: { decisions: number; outcomes: number; queries: number };
}

export interface ScopeSummary {
  actions: ScopeAction[];
  /** Every request the scope makes, `GET /medicines`. */
  endpoints: string[];
  /** Every collection it touches, and how. */
  collections: Array<{ name: string; effects: string[] }>;
  /** The source files its actions run through in the browser. */
  files: string[];
  /**
   * Features outside the scope that read or write a collection it writes —
   * what a change here could break elsewhere.
   */
  sharedWith: Array<{ collection: string; flows: Array<{ id: string; title: string }> }>;
}

export interface ScopeSummaryOptions {
  tests?: TestIndex;
  reader?: SourceReader;
  /** Read each action's branches (reads source; capped for a big screen). */
  decisions?: boolean;
  /**
   * An action's counts as its chart draws them — with the helpers shared with
   * other actions named in one step, not counted again in each. Without it,
   * the counts are the walk's own.
   */
  countDecisions?: (flow: FeatureFlow) => ActionDecisions['counts'];
}

/** How many actions get their branches read: past this a screen is a list, not a tree. */
const DECISION_CAP = 60;

export function scopeSummary(
  graph: FlowGraph,
  all: FeatureFlow[],
  ids: string[],
  options: ScopeSummaryOptions = {},
): ScopeSummary {
  const byId = new Map(all.map((flow) => [flow.id, flow]));
  const wanted = new Set(ids);
  const flows = [...wanted].map((id) => byId.get(id)).filter((flow): flow is FeatureFlow => !!flow);
  const reader = options.reader ?? new SourceReader(graph);

  let read = 0;
  const actions: ScopeAction[] = flows.map((flow) => {
    const timing = flowTiming(flow);
    const tests = options.tests ? testsForFlow(options.tests, flow) : undefined;
    let decisions: ScopeAction['decisions'];
    if (options.decisions && flow.endpoints.length > 0 && read < DECISION_CAP) {
      read++;
      try {
        const counts =
          options.countDecisions?.(flow) ?? actionDecisions(graph, flow, { reader }).counts;
        decisions = {
          decisions: counts.decisions,
          outcomes: counts.outcomes,
          queries: counts.queries,
        };
      } catch {
        decisions = undefined;
      }
    }
    return {
      id: flow.id,
      title: flow.title,
      ...(flow.event ? { event: flow.event } : {}),
      endpoints: flow.endpoints,
      collections: flow.collections.map((entry) => ({
        name: entry.collection,
        effect: entry.effect,
      })),
      risk: flow.risk,
      ...(flow.source ? { source: flow.source } : {}),
      timing: {
        observed: timing.observed,
        ...(timing.totalMs !== undefined ? { totalMs: timing.totalMs } : {}),
      },
      tests: {
        totalCases: tests?.totalCases ?? 0,
        coveragePct: tests?.coveragePct ?? 0,
        untested: (tests?.uncoveredFiles ?? []).map((entry) => entry.file),
      },
      ...(decisions ? { decisions } : {}),
    };
  });

  const endpoints = [...new Set(flows.flatMap((flow) => flow.endpoints))].sort();
  const effects = new Map<string, Set<string>>();
  for (const flow of flows) {
    for (const entry of flow.collections) {
      const set = effects.get(entry.collection) ?? new Set<string>();
      set.add(entry.effect);
      effects.set(entry.collection, set);
    }
  }
  const collections = [...effects]
    .map(([name, set]) => ({ name, effects: [...set].sort() }))
    .sort((a, b) => a.name.localeCompare(b.name));

  const files = [
    ...new Set(
      flows.flatMap((flow) =>
        flow.steps
          .filter((step) => step.file && (step.layer === 'ui' || step.layer === 'frontend'))
          .map((step) => step.file!),
      ),
    ),
  ].sort();

  const written = collections
    .filter((entry) => entry.effects.some((effect) => effect !== 'read'))
    .map((entry) => entry.name);
  const sharedWith = written
    .map((collection) => ({
      collection,
      flows: all
        .filter(
          (flow) =>
            !wanted.has(flow.id) &&
            flow.collections.some((entry) => entry.collection === collection),
        )
        .map((flow) => ({ id: flow.id, title: flow.title })),
    }))
    .filter((entry) => entry.flows.length > 0);

  return { actions, endpoints, collections, files, sharedWith };
}
