/**
 * "What did I already change, and what does it put at risk?"
 *
 * The other tabs start from a feature and work outwards. This one starts from
 * the diff, which is where a developer actually is: mid-change, about to
 * commit, wondering whether the four files they touched reach further than they
 * meant. Asking the graph that question is cheap, and unlike the timing view it
 * needs no instrumentation and unlike the tests view it says something useful
 * on a project with no tests at all.
 *
 * Deliberately pure: it takes a list of paths and knows nothing about git, so
 * the CLI decides what "changed" means (working tree, staged, or against a base
 * branch) and this stays testable without a repository.
 */

import type { FlowGraph } from '../graph/graph.js';
import { resolveFlows, type FeatureFlow } from '../flow/resolve.js';
import { testsForFlow, type TestIndex } from '../analyzer/testcoverage.js';

/** How git described the change, when the caller knows. */
export type ChangeStatus = 'modified' | 'added' | 'deleted' | 'renamed' | 'untracked';

export interface ChangedInput {
  /** Path relative to the scan root, forward-slashed — as node ids use. */
  file: string;
  status?: ChangeStatus;
}

export interface AffectedFeature {
  id: string;
  title: string;
  /** Set when another affected feature has the same title. */
  subtitle?: string;
  risk: number;
  /** The steps of this feature that live in the changed files. */
  touchedSteps: Array<{ label: string; kind: string; file: string; line?: number }>;
  /** Test cases that import at least one file this feature runs through. */
  testCases: number;
  /** Share of the feature's files a test imports, 0–100. */
  coveragePct: number;
}

export interface ChangedReport {
  /** Every path the caller reported, and what Flowslens knows about it. */
  files: Array<{
    file: string;
    status?: ChangeStatus;
    /** How many graph nodes come from this file. */
    steps: number;
  }>;
  /** Features that run through at least one changed file, most-touched first. */
  features: AffectedFeature[];
  /**
   * Affected features with no test covering them.
   *
   * The list to read before pushing: these are the features a mistake in this
   * diff reaches and nothing would catch.
   */
  untested: AffectedFeature[];
  /**
   * Changed files with no node in the graph.
   *
   * Said out loud because it is the honest limit of this view: a change to a
   * config file, a stylesheet, or a stack Flowslens does not read yet can break
   * things this cannot see.
   */
  unmodelled: string[];
  /** Collections the changed code reads or writes. */
  collections: string[];
  level: 'low' | 'medium' | 'high';
  summary: string;
  notes: string[];
}

/**
 * Which features a set of changed files reaches.
 *
 * Matching is by file, not by symbol, and that is a deliberate over-estimate:
 * a step is counted as touched if its file changed at all. Narrowing it to
 * changed *lines* would need a hunk-level diff and would trade a false alarm
 * for a false negative — the wrong direction for a view whose whole job is to
 * ask "are you sure?".
 */
export function analyzeChanged(
  graph: FlowGraph,
  changed: readonly ChangedInput[],
  options: { tests?: TestIndex } = {},
): ChangedReport {
  const wanted = new Map(changed.map((entry) => [entry.file, entry]));

  /** file -> the graph nodes declared in it. */
  const nodesByFile = new Map<string, number>();
  for (const node of graph.allNodes()) {
    const file = node.source?.file;
    if (!file || !wanted.has(file)) continue;
    nodesByFile.set(file, (nodesByFile.get(file) ?? 0) + 1);
  }

  const files = changed.map((entry) => ({
    file: entry.file,
    ...(entry.status ? { status: entry.status } : {}),
    steps: nodesByFile.get(entry.file) ?? 0,
  }));

  const flows = resolveFlows(graph, { includeLocalOnly: true });
  const emptyTests: TestIndex = { files: [], byCoveredFile: new Map(), totalCases: 0 };
  const tests = options.tests ?? emptyTests;

  const affected: AffectedFeature[] = [];
  for (const flow of flows) {
    const touchedSteps = flow.steps
      .filter((step) => step.file !== undefined && wanted.has(step.file))
      .map((step) => ({
        label: step.label,
        kind: step.kind,
        file: step.file!,
        ...(step.line !== undefined ? { line: step.line } : {}),
      }));
    if (touchedSteps.length === 0) continue;

    const coverage = testsForFlow(tests, flow);
    affected.push({
      id: flow.id,
      title: flow.title,
      risk: flow.risk.score,
      touchedSteps,
      testCases: coverage.totalCases,
      coveragePct: coverage.coveragePct,
    });
  }

  const features = disambiguate(affected, flows).sort(
    (a, b) => b.touchedSteps.length - a.touchedSteps.length || b.risk - a.risk,
  );
  const untested = features.filter((feature) => feature.testCases === 0);

  const collections = [
    ...new Set(
      features.flatMap((feature) => {
        const flow = flows.find((candidate) => candidate.id === feature.id);
        return (flow?.collections ?? []).map((entry) => entry.collection);
      }),
    ),
  ].sort();

  const unmodelled = files.filter((entry) => entry.steps === 0).map((entry) => entry.file);

  const level: ChangedReport['level'] =
    untested.length >= 3 || features.length >= 8
      ? 'high'
      : untested.length >= 1 || features.length >= 3
        ? 'medium'
        : 'low';

  return {
    files,
    features,
    untested,
    unmodelled,
    collections,
    level,
    summary: summarize(changed.length, features.length, untested.length),
    notes: noteOn(features.length, unmodelled, tests),
  };
}

function summarize(changedCount: number, featureCount: number, untestedCount: number): string {
  if (changedCount === 0) return 'Nothing has changed since the last commit.';
  if (featureCount === 0) {
    return `${changedCount} changed file${changedCount > 1 ? 's' : ''}, none of which any traced feature runs through.`;
  }
  const head =
    `${changedCount} changed file${changedCount > 1 ? 's' : ''} ` +
    `${changedCount > 1 ? 'are' : 'is'} used by ${featureCount} ` +
    `feature${featureCount > 1 ? 's' : ''}`;
  if (untestedCount === 0) return `${head}, and every one of them has a test.`;
  return `${head}; ${untestedCount} of them ${untestedCount > 1 ? 'have' : 'has'} no test.`;
}

function noteOn(featureCount: number, unmodelled: readonly string[], tests: TestIndex): string[] {
  const notes: string[] = [];
  if (unmodelled.length > 0) {
    notes.push(
      `${unmodelled.length} changed file${unmodelled.length > 1 ? 's have' : ' has'} no ` +
        'step in the graph — a config, a stylesheet, or a stack Flowslens does not ' +
        'read yet. This view cannot tell you what those reach.',
    );
  }
  if (featureCount > 0) {
    notes.push(
      'A feature is listed if any file it runs through changed at all. That over- ' +
        'estimates on purpose: narrowing it to changed lines would trade a false ' +
        'alarm for a false negative.',
    );
  }
  if (tests.files.length === 0) {
    notes.push('No test files were found, so every affected feature counts as untested.');
  }
  return notes;
}

/** Give colliding titles a distinguishing suffix; leave unique ones alone. */
function disambiguate(
  entries: AffectedFeature[],
  flows: readonly FeatureFlow[],
): AffectedFeature[] {
  const counts = new Map<string, number>();
  for (const entry of entries) counts.set(entry.title, (counts.get(entry.title) ?? 0) + 1);

  return entries.map((entry) => {
    if ((counts.get(entry.title) ?? 0) < 2) return entry;
    const flow = flows.find((candidate) => candidate.id === entry.id);
    const hint = flow?.component ?? flow?.source?.file?.split('/').pop() ?? entry.id;
    return { ...entry, subtitle: hint };
  });
}
