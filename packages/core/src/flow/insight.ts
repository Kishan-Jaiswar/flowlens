/**
 * The two questions a developer asks *after* "what does this button do?".
 *
 * The flow answers the first one. But a flow read on its own is quietly
 * misleading in one specific way: it shows a chain as though it belonged to
 * this feature, when most of the chain is shared. Changing
 * `CustomersService.findOne` because one screen needs an extra field is a
 * five-minute edit that breaks four other screens, and nothing in the flow view
 * says so — every step looks equally yours.
 *
 * So:
 *
 *   - {@link flowTiming} — where the time actually goes, per step, from spans
 *     the app really emitted.
 *   - {@link analyzeFlowImpact} — which steps of this flow are load-bearing for
 *     other features, so "safe to change" and "shared, be careful" are visibly
 *     different things before the edit rather than after it.
 */

import { analyzeImpact, type ImpactReport } from '../impact/impact.js';
import type { FlowGraph } from '../graph/graph.js';
import type { Layer, NodeKind } from '../graph/types.js';
import { resolveFlows, type FeatureFlow, type FlowStep } from './resolve.js';

// ---------------------------------------------------------------------------
// Timing
// ---------------------------------------------------------------------------

export interface StepTiming {
  nodeId: string;
  kind: NodeKind;
  label: string;
  layer: Layer;
  file?: string;
  line?: number;
  /** Inclusive: this step and everything it called. */
  avgMs?: number;
  /** Exclusive: this step alone. The only one that may be summed. */
  avgSelfMs?: number;
  observations?: number;
  /** Share of the flow's total exclusive time, 0–100. */
  sharePct?: number;
}

export interface FlowTiming {
  /** False when no span was ever recorded for this flow. */
  observed: boolean;
  /**
   * Wall clock for the whole flow.
   *
   * Taken from the widest inclusive measurement rather than by adding steps
   * up: a nested trace counts the same millisecond once per level, so summing
   * inclusive times reports a flow as several times slower than it was.
   */
  totalMs?: number;
  /** Sum of exclusive times — what the steps below actually account for. */
  accountedMs?: number;
  /** Every step with a measurement, slowest exclusive time first. */
  steps: StepTiming[];
  /** The single step to look at first. */
  slowest?: StepTiming;
  /** Steps in the flow that no span has ever covered. */
  unobserved: Array<Pick<StepTiming, 'nodeId' | 'kind' | 'label' | 'layer'>>;
  /** Plain-language notes: what was measured, and what this cannot tell you. */
  notes: string[];
}

/**
 * Where the time went.
 *
 * Reads only what the tracer recorded. A flow with no spans reports
 * `observed: false` rather than estimating, because an invented number in a
 * performance view is worse than no number — it gets quoted.
 */
export function flowTiming(flow: FeatureFlow): FlowTiming {
  const measured: StepTiming[] = [];
  const unobserved: FlowTiming['unobserved'] = [];

  for (const step of flow.steps) {
    if (step.avgMs === undefined && step.avgSelfMs === undefined) {
      unobserved.push({
        nodeId: step.nodeId,
        kind: step.kind,
        label: step.label,
        layer: step.layer,
      });
      continue;
    }
    measured.push(toStepTiming(step));
  }

  if (measured.length === 0) {
    return {
      observed: false,
      steps: [],
      unobserved,
      notes: [
        'No runtime spans for this flow yet. Wire up @flowslens/runtime, use the ' +
          'feature once, then run `flowlens trace`.',
      ],
    };
  }

  const accountedMs = round(measured.reduce((total, step) => total + (step.avgSelfMs ?? 0), 0));
  const totalMs = round(Math.max(...measured.map((step) => step.avgMs ?? step.avgSelfMs ?? 0)));

  for (const step of measured) {
    if (step.avgSelfMs !== undefined && accountedMs > 0) {
      step.sharePct = round((step.avgSelfMs / accountedMs) * 100);
    }
  }

  measured.sort((a, b) => (b.avgSelfMs ?? 0) - (a.avgSelfMs ?? 0));

  const notes: string[] = [];
  if (unobserved.length > 0) {
    notes.push(
      `${unobserved.length} step${unobserved.length > 1 ? 's' : ''} in this flow ` +
        'have no spans, so their time is inside their caller rather than listed.',
    );
  }
  /**
   * The gap between the two measures is the honest caveat.
   *
   * When the steps account for much less than the wall clock, the missing time
   * is real — it is in code the tracer was not wired into — and a reader who
   * does not know that will conclude the flow is faster than it is.
   */
  if (totalMs > 0 && accountedMs < totalMs * 0.8) {
    notes.push(
      `Steps account for ${accountedMs}ms of ${totalMs}ms. The rest is in code ` +
        'without instrumentation — add `traceMethod` where you need detail.',
    );
  }

  return {
    observed: true,
    totalMs,
    accountedMs,
    steps: measured,
    ...(measured[0] ? { slowest: measured[0] } : {}),
    unobserved,
    notes,
  };
}

function toStepTiming(step: FlowStep): StepTiming {
  return {
    nodeId: step.nodeId,
    kind: step.kind,
    label: step.label,
    layer: step.layer,
    ...(step.file ? { file: step.file } : {}),
    ...(step.line !== undefined ? { line: step.line } : {}),
    ...(step.avgMs !== undefined ? { avgMs: round(step.avgMs) } : {}),
    ...(step.avgSelfMs !== undefined ? { avgSelfMs: round(step.avgSelfMs) } : {}),
    ...(step.observations !== undefined ? { observations: step.observations } : {}),
  };
}

// ---------------------------------------------------------------------------
// Blast radius
// ---------------------------------------------------------------------------

/**
 * Why a step is shared — and it is the difference between a finding and
 * wallpaper.
 *
 * A toast hook, a cache, a logger and an audit service are shared *on purpose*:
 * that is what infrastructure is. Reporting them next to a business-logic
 * service two features grew into gives both the same urgency, and a reader who
 * meets `useToast` at the top of the list three times learns to skim the list.
 * Measured on a real 132-flow project, `useToast` was the single most-flagged
 * step in the whole graph.
 */
export type SharedBy = 'feature' | 'design';

export interface SharedStep {
  nodeId: string;
  kind: NodeKind;
  label: string;
  layer: Layer;
  file?: string;
  line?: number;
  /** How many graph nodes would notice a change here. */
  blastRadius: number;
  level: ImpactReport['level'];
  /** Other user-facing features that run through this same step. */
  otherFlows: Array<{ id: string; title: string; risk: number }>;
  /** Endpoints, collections and warnings, straight from the impact engine. */
  endpoints: string[];
  collections: string[];
  warnings: string[];
  /** `design` for infrastructure, `feature` for the steps worth reading. */
  sharedBy: SharedBy;
  /** Why it was classified that way, in one phrase. */
  why: string;
  /** How many of the project's features run through this step. */
  usedByFlows: number;
}

export interface FlowImpact {
  flowId: string;
  /**
   * Business-logic steps other features also depend on, most-shared first.
   *
   * This is the list to read. Infrastructure is kept separately rather than
   * mixed in, so the count on the tab means "things that might surprise you"
   * instead of "things plus the logger".
   */
  shared: SharedStep[];
  /** Shared by design: hooks, caches, loggers, audit trails, platform utilities. */
  infrastructure: SharedStep[];
  /** Steps nothing else uses — the safe place to make a change. */
  exclusive: Array<Pick<SharedStep, 'nodeId' | 'kind' | 'label' | 'layer' | 'file' | 'line'>>;
  /**
   * Every other feature this flow could break, deduplicated.
   *
   * `subtitle` disambiguates: a real project had "Medicines · Delete" twice and
   * "Select mouse down" three times, and a list of identical names is a list
   * nobody can act on.
   */
  featuresAtRisk: Array<{
    id: string;
    title: string;
    subtitle?: string;
    risk: number;
    viaSteps: number;
  }>;
  /**
   * Collections this flow writes that something else writes too.
   *
   * The failure this catches is the one static analysis is uniquely good at:
   * two features writing the same collection with different assumptions, where
   * neither author ever reads the other's code.
   */
  contestedCollections: Array<{ collection: string; writers: string[] }>;
  level: 'low' | 'medium' | 'high';
  /** One sentence a developer can act on. */
  summary: string;
  /**
   * Why the level is what it is.
   *
   * A score nobody can audit is a score nobody trusts — the same reason the
   * CLI lists its risk factors instead of just printing a number.
   */
  factors: string[];
}

/**
 * "If I change this feature, what else breaks?"
 *
 * Runs the existing impact engine on every step of the flow and sorts the
 * answer into shared and exclusive. The engine already walks the graph
 * backwards from one node; this asks the same question of a whole feature and
 * reports it as one picture.
 */
export function analyzeFlowImpact(graph: FlowGraph, flow: FeatureFlow): FlowImpact {
  /**
   * Resolve once and hand the result down.
   *
   * `analyzeImpact` needs the flow list to answer "who else runs through this",
   * and it is called for every step. Letting it resolve its own made a big
   * project quadratic in the size of the thing that makes it interesting.
   */
  const flows = resolveFlows(graph, { includeLocalOnly: true });

  /** How many features each node participates in — the ubiquity signal. */
  const usage = new Map<string, number>();
  for (const candidate of flows) {
    for (const step of candidate.steps) {
      usage.set(step.nodeId, (usage.get(step.nodeId) ?? 0) + 1);
    }
  }

  const shared: SharedStep[] = [];
  const infrastructure: SharedStep[] = [];
  const exclusive: FlowImpact['exclusive'] = [];
  const viaCount = new Map<string, { title: string; risk: number; count: number }>();

  for (const step of flow.steps) {
    /**
     * Collections and fields are skipped as *targets*.
     *
     * A collection is shared by definition and would top every list without
     * saying anything; the contested-writer check below is the useful form of
     * that question.
     */
    if (step.kind === 'collection' || step.kind === 'field') continue;

    const report = analyzeImpact(graph, step.nodeId, { flows });
    if (!report) continue;

    const others = report.affectedFlows.filter((affected) => affected.id !== flow.id);
    if (others.length === 0) {
      exclusive.push({
        nodeId: step.nodeId,
        kind: step.kind,
        label: step.label,
        layer: step.layer,
        ...(step.file ? { file: step.file } : {}),
        ...(step.line !== undefined ? { line: step.line } : {}),
      });
      continue;
    }

    const usedByFlows = usage.get(step.nodeId) ?? others.length + 1;
    const classification = classifyShared(step, usedByFlows, flows.length);

    const entry: SharedStep = {
      nodeId: step.nodeId,
      kind: step.kind,
      label: step.label,
      layer: step.layer,
      ...(step.file ? { file: step.file } : {}),
      ...(step.line !== undefined ? { line: step.line } : {}),
      blastRadius: report.blastRadius,
      level: report.level,
      otherFlows: others.map((other) => ({
        id: other.id,
        title: other.title,
        risk: other.risk,
      })),
      endpoints: report.endpoints,
      collections: report.collections,
      warnings: report.warnings,
      sharedBy: classification.sharedBy,
      why: classification.why,
      usedByFlows,
    };

    if (classification.sharedBy === 'design') {
      infrastructure.push(entry);
      continue;
    }

    shared.push(entry);
    // Only feature-level sharing counts toward "what could break": every
    // feature touches the logger, and saying so 25 times is not a warning.
    for (const other of others) {
      const seen = viaCount.get(other.id);
      if (seen) seen.count += 1;
      else viaCount.set(other.id, { title: other.title, risk: other.risk, count: 1 });
    }
  }

  const bySharing = (a: SharedStep, b: SharedStep) =>
    b.otherFlows.length - a.otherFlows.length || b.blastRadius - a.blastRadius;
  shared.sort(bySharing);
  infrastructure.sort(bySharing);

  const featuresAtRisk = disambiguate(
    [...viaCount.entries()].map(([id, value]) => ({
      id,
      title: value.title,
      risk: value.risk,
      viaSteps: value.count,
    })),
    flows,
  ).sort((a, b) => b.viaSteps - a.viaSteps || b.risk - a.risk);

  const contestedCollections = contestedWrites(graph, flow);

  const factors: string[] = [];
  if (featuresAtRisk.length > 0) {
    factors.push(
      `${featuresAtRisk.length} other feature${featuresAtRisk.length > 1 ? 's' : ''} ` +
        `run through ${shared.length} of this one's step${shared.length > 1 ? 's' : ''}`,
    );
  }
  for (const entry of contestedCollections) {
    factors.push(
      `${entry.collection} is written from ${entry.writers.length} places, not just here`,
    );
  }
  if (infrastructure.length > 0) {
    factors.push(
      `${infrastructure.length} shared step${infrastructure.length > 1 ? 's' : ''} ` +
        `looked like infrastructure and ${infrastructure.length > 1 ? 'were' : 'was'} ` +
        'not counted',
    );
  }
  if (factors.length === 0) factors.push('nothing outside this feature depends on it');

  const level: FlowImpact['level'] =
    featuresAtRisk.length >= 4 || contestedCollections.length >= 2
      ? 'high'
      : featuresAtRisk.length >= 1 || contestedCollections.length >= 1
        ? 'medium'
        : 'low';

  return {
    flowId: flow.id,
    shared,
    infrastructure,
    exclusive,
    featuresAtRisk,
    contestedCollections,
    level,
    summary: summarize(shared.length, featuresAtRisk.length, contestedCollections),
    factors,
  };
}

/**
 * Names that mean "platform", not "this feature".
 *
 * A list like this is a heuristic and will be wrong somewhere, which is why it
 * only ever *demotes* a step into a separate section rather than hiding it, and
 * why every entry carries the reason it was demoted.
 */
const INFRA_HOOK =
  /^use(Toast|Snackbar|Notification|Notify|Alert|Theme|Modal|Dialog|Drawer|Translation|Intl|Locale|Router|Navigate|Params|Media|Breakpoint|Clipboard|Debounce|LocalStorage)/i;
const INFRA_SYMBOL =
  /(logger|logging|audit|analytics|telemetry|metrics|tracking|cache|caching|config|settings|i18n|translate|toast|notification|mailer|email|queue|session|middleware|interceptor|guard)/i;
const INFRA_COLLECTION = /^(auditlogs?|logs?|events?|sessions?|metrics|analytics|caches?)$/i;

/**
 * Two independent signals, because neither is enough alone.
 *
 * The name list catches the obvious cases in a small project, where nothing is
 * yet used widely enough to look ubiquitous. Ubiquity catches the ones the list
 * has never heard of — a house-built `useApiClient` that half the app imports
 * is infrastructure whatever it is called, and that is knowable from the graph
 * rather than from a vocabulary.
 */
function classifyShared(
  step: FlowStep,
  usedByFlows: number,
  totalFlows: number,
): { sharedBy: SharedBy; why: string } {
  const share = totalFlows === 0 ? 0 : usedByFlows / totalFlows;

  if (step.kind === 'middleware') {
    return { sharedBy: 'design', why: 'middleware runs for many routes by design' };
  }
  if (step.kind === 'hook' && INFRA_HOOK.test(step.label)) {
    return { sharedBy: 'design', why: 'a UI utility hook' };
  }
  if (step.kind === 'db-op' || step.kind === 'collection') {
    const collection = String(step.meta?.['collection'] ?? '');
    if (INFRA_COLLECTION.test(collection)) {
      return { sharedBy: 'design', why: `${collection} is an audit or log trail` };
    }
  }
  if (INFRA_SYMBOL.test(step.label)) {
    return { sharedBy: 'design', why: 'named like a platform utility' };
  }
  /**
   * Used by more than a third of the project's features.
   *
   * The floor of four stops a two-flow project calling everything ubiquitous,
   * where a single shared step is 50% by arithmetic rather than by nature.
   */
  if (usedByFlows >= 4 && share >= 0.35) {
    return {
      sharedBy: 'design',
      why: `used by ${Math.round(share * 100)}% of features — platform, not feature`,
    };
  }
  return { sharedBy: 'feature', why: 'business logic this feature shares' };
}

/**
 * Add a distinguishing suffix to entries whose titles collide.
 *
 * Only on collision: "Submit Order · OrderForm" reads worse than "Submit Order"
 * when there is only one of them.
 */
function disambiguate<T extends { id: string; title: string; subtitle?: string }>(
  entries: T[],
  flows: FeatureFlow[],
): T[] {
  const counts = new Map<string, number>();
  for (const entry of entries) counts.set(entry.title, (counts.get(entry.title) ?? 0) + 1);

  return entries.map((entry) => {
    if ((counts.get(entry.title) ?? 0) < 2) return entry;
    const flow = flows.find((candidate) => candidate.id === entry.id);
    const hint = flow?.component ?? flow?.source?.file?.split('/').pop() ?? entry.id;
    return { ...entry, subtitle: hint };
  });
}

function summarize(
  sharedSteps: number,
  features: number,
  contested: FlowImpact['contestedCollections'],
): string {
  if (sharedSteps === 0) {
    return 'Nothing else runs through this feature. A change here is contained.';
  }
  const parts = [
    `${sharedSteps} step${sharedSteps > 1 ? 's' : ''} of this feature ` +
      `${sharedSteps > 1 ? 'are' : 'is'} shared with ${features} other ` +
      `feature${features > 1 ? 's' : ''}`,
  ];
  if (contested.length > 0) {
    parts.push(
      `and ${contested.length} collection${contested.length > 1 ? 's' : ''} ` +
        `${contested.length > 1 ? 'are' : 'is'} written by more than one place`,
    );
  }
  return `${parts.join(', ')}.`;
}

/**
 * Collections this flow writes that something outside it also writes.
 *
 * Derived from the graph rather than from the doctor's global report, so the
 * answer is scoped to the feature on screen.
 */
function contestedWrites(
  graph: FlowGraph,
  flow: FeatureFlow,
): Array<{ collection: string; writers: string[] }> {
  const out: Array<{ collection: string; writers: string[] }> = [];

  for (const step of flow.steps) {
    if (step.kind !== 'collection') continue;
    const writeOps = graph
      .edgesTo(step.nodeId, ['writes'])
      .map((edge) => graph.node(edge.from))
      .filter((node) => node !== undefined);
    if (writeOps.length === 0) continue;

    const writers = new Set<string>();
    for (const op of writeOps) {
      // The method or handler that owns the write, which is what a reader needs
      // to open — the `db-op` node itself is an anonymous call site.
      for (const owner of graph.predecessors(op.id, ['queries'])) writers.add(owner.label);
    }
    if (writers.size > 1) {
      out.push({ collection: step.label, writers: [...writers].sort() });
    }
  }

  return out.sort((a, b) => b.writers.length - a.writers.length);
}

function round(value: number): number {
  return Math.round(value * 10) / 10;
}
