import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import {
  analyzeChanged,
  diffGraphs,
  indexTests,
  introducesAtLeast,
  projectFindings,
  scan,
  SourceReader,
  type ChangedInput,
  type ChangedReport,
  type Finding,
  type FindingSeverity,
  type FlowGraph,
  type GraphDiff,
} from '@flowslens/core';
import { changedFiles } from '../changedfiles.js';
import { color } from '../ui.js';

export interface DiffArgs {
  root: string;
  /** The branch or commit to compare against: `main`, `origin/main`, a sha. */
  base: string;
  json?: boolean;
  out?: string;
  /** Exit 1 when the change introduces a finding at or above this severity. */
  failOn?: FindingSeverity;
}

/** First line of every report, so a CI job can find and update its own comment. */
export const REPORT_MARKER = '<!-- flowlens-report -->';

/**
 * `flowlens diff --base main` — what this branch changes about the app.
 *
 * Scans the branch as it is on disk and the point it forked from, and reports
 * the differences a reviewer would otherwise reconstruct by hand: the actions
 * the change reaches and which of them nothing tests, issues it introduces or
 * fixes, collections that gained a writer, endpoints that appeared or went.
 * Markdown by default, because the natural place for it is a pull request
 * comment; `--fail-on high` makes it a CI gate.
 *
 * The base is checked out into a temporary git worktree and removed again.
 * Nothing is executed and nothing leaves the machine.
 */
export function runDiff(args: DiffArgs): number {
  const root = resolve(args.root);
  const top = git(root, ['rev-parse', '--show-toplevel']);
  if (top.error) return fail(`not a git repository: ${root}`);

  const fork = git(root, ['merge-base', args.base, 'HEAD']);
  if (fork.error) {
    return fail(
      `cannot compare with "${args.base}": ${fork.error}\n` +
        color.gray('  In CI, fetch the base first: git fetch origin main --depth=50'),
    );
  }
  const forkPoint = fork.out.trim();

  // The branch as it is now, uncommitted work included: this is also the
  // "before I push" check.
  const head = scan({ root });
  const headFindings = findingsOf(head.graph);

  // The fork point, not the tip of the base: comparing with a `main` that
  // moved on would report everyone else's work as this branch removing it.
  const checkout = mkdtempSync(join(tmpdir(), 'flowlens-base-'));
  let baseGraph: FlowGraph;
  let baseFindings: Finding[];
  try {
    const added = git(root, ['worktree', 'add', '--detach', '--quiet', checkout, forkPoint]);
    if (added.error) return fail(`could not check out ${args.base}: ${added.error}`);
    const scanned = scan({ root: join(checkout, relative(top.out.trim(), root)) });
    baseGraph = scanned.graph;
    baseFindings = findingsOf(baseGraph);
  } finally {
    git(root, ['worktree', 'remove', '--force', checkout]);
    rmSync(checkout, { recursive: true, force: true });
    git(root, ['worktree', 'prune']);
  }

  const diff = diffGraphs(
    { graph: baseGraph, findings: baseFindings },
    { graph: head.graph, findings: headFindings },
  );
  const changed = analyzeChanged(head.graph, filesSince(root, args.base), {
    tests: indexTests([root]),
  });
  const level = levelOf(diff, changed);

  if (args.json) {
    const body = `${JSON.stringify({ base: args.base, forkPoint, level, diff, changed }, null, 2)}\n`;
    if (args.out) writeFileSync(args.out, body, 'utf8');
    else process.stdout.write(body);
  } else {
    const body = renderDiff(args.base, level, diff, changed);
    if (args.out) {
      writeFileSync(args.out, body, 'utf8');
      process.stderr.write(`${color.green('wrote')} ${args.out}\n`);
    } else {
      process.stdout.write(body);
    }
  }

  if (args.failOn && introducesAtLeast(diff, args.failOn)) {
    process.stderr.write(
      `${color.red('fail')} this change introduces a ${args.failOn}-or-worse issue (--fail-on ${args.failOn})\n`,
    );
    return 1;
  }
  return 0;
}

type Level = 'low' | 'medium' | 'high';

/**
 * The headline risk, from what a reviewer would weigh: a new high-severity
 * issue, or untested actions whose own code changed. Browser-only actions do
 * not count, and neither does breadth alone — a change to a shared file that
 * reaches many tested actions is wide, not dangerous.
 */
function levelOf(diff: GraphDiff, changed: ChangedReport): Level {
  const backend = changed.features.filter((feature) => feature.hitsBackend);
  const untestedDirect = backend.filter(
    (feature) => feature.touchedSteps.length > 0 && feature.testCases === 0,
  ).length;
  const untestedShared = backend.filter(
    (feature) => feature.touchedSteps.length === 0 && feature.testCases === 0,
  ).length;
  if (introducesAtLeast(diff, 'high') || untestedDirect >= 3) return 'high';
  if (
    introducesAtLeast(diff, 'medium') ||
    diff.writers.length > 0 ||
    diff.endpoints.removed.length > 0 ||
    untestedDirect > 0 ||
    untestedShared >= 8
  ) {
    return 'medium';
  }
  return 'low';
}

/** The review comment. Every section is left out when it has nothing to say. */
export function renderDiff(
  base: string,
  level: Level,
  diff: GraphDiff,
  changed: ChangedReport,
): string {
  const out: string[] = [REPORT_MARKER, '## FlowLens — what this change does to the app', ''];
  const introduced = diff.findings.introduced.length;
  const reached = changed.features.filter((feature) => feature.hitsBackend);
  const bare = reached.filter((feature) => feature.testCases === 0).length;
  out.push(
    `**Risk: ${level}** · compared with \`${base}\` · ` +
      `${changed.files.length} changed file${changed.files.length === 1 ? '' : 's'} reach ` +
      `${reached.length} user action${reached.length === 1 ? '' : 's'}` +
      (reached.length ? (bare ? `, ${bare} with no test.` : ', all tested.') : '.') +
      (introduced ? ` **${introduced} new issue${introduced === 1 ? '' : 's'}.**` : ''),
    '',
  );

  if (introduced) {
    out.push(`### New issues (${introduced})`, '');
    for (const finding of diff.findings.introduced) {
      out.push(
        `- **[${finding.severity}]** ${finding.title} — \`${finding.at.file}:${finding.at.line}\``,
        `  ${finding.why}`,
        `  **Fix:** ${finding.fix}`,
      );
    }
    out.push('');
  }

  /**
   * Split by how the change reaches each action. Its own code changed: that
   * is the review, one row each. Reached only because it imports a changed
   * shared file: worth knowing, but thirty rows of the same import list is a
   * comment nobody reads, so it is one line. Browser-only actions (a toggle,
   * a filter) are counted, not listed.
   */
  const backend = changed.features.filter((feature) => feature.hitsBackend);
  const direct = backend.filter((feature) => feature.touchedSteps.length > 0);
  const shared = backend.filter((feature) => feature.touchedSteps.length === 0);
  const localOnly = changed.features.length - backend.length;

  if (direct.length) {
    const untested = direct.filter((feature) => feature.testCases === 0).length;
    out.push(
      `### Actions whose code changed (${direct.length}${untested ? `, ${untested} with no test` : ''})`,
      '',
      '| Action | Changed steps | Tests |',
      '| --- | --- | --- |',
    );
    for (const feature of direct.slice(0, 25)) {
      const labels = [...new Set(feature.touchedSteps.map((step) => step.label))];
      const steps =
        labels
          .slice(0, 4)
          .map((label) => `\`${label}\``)
          .join(', ') + (labels.length > 4 ? ` +${labels.length - 4} more` : '');
      out.push(
        `| ${escapeCell(feature.title + (feature.subtitle ? ` · ${feature.subtitle}` : ''))} | ${escapeCell(steps)} | ${feature.testCases === 0 ? '**none**' : feature.testCases} |`,
      );
    }
    if (direct.length > 25) out.push('', `…and ${direct.length - 25} more.`);
    out.push('');
  }

  if (shared.length) {
    const files = [...new Set(shared.flatMap((feature) => feature.through))].sort();
    const untested = shared.filter((feature) => feature.testCases === 0).length;
    const names = shared.map((feature) => feature.title);
    out.push(
      `### Also reached through shared code (${shared.length}${untested ? `, ${untested} with no test` : ''})`,
      '',
      `${files
        .slice(0, 6)
        .map((file) => `\`${file}\``)
        .join(', ')}${files.length > 6 ? ` and ${files.length - 6} more` : ''} ` +
        `${files.length === 1 ? 'is' : 'are'} imported by: ${names.slice(0, 12).join(', ')}` +
        `${names.length > 12 ? `, and ${names.length - 12} more` : ''}.`,
      '',
    );
  }

  if (localOnly > 0) {
    out.push(
      `<sub>Also touches ${localOnly} browser-only interaction${localOnly === 1 ? '' : 's'} (no request) — not listed.</sub>`,
      '',
    );
  }

  if (diff.writers.length) {
    out.push('### Collections with a new writer', '');
    for (const entry of diff.writers) {
      out.push(
        `- \`${entry.collection}\` is now also written by ${entry.added.map((name) => `\`${name}\``).join(', ')}` +
          ` — before: ${entry.before.map((name) => `\`${name}\``).join(', ')}`,
      );
    }
    out.push('');
  }

  if (diff.endpoints.added.length || diff.endpoints.removed.length) {
    out.push('### Endpoints', '');
    for (const route of diff.endpoints.added) out.push(`- added \`${route}\``);
    for (const route of diff.endpoints.removed) out.push(`- **removed** \`${route}\``);
    out.push('');
  }

  if (diff.actions.added.length || diff.actions.removed.length) {
    out.push('### User actions', '');
    for (const action of diff.actions.added) {
      out.push(
        `- new: ${action.title}${action.endpoints.length ? ` → ${action.endpoints.join(', ')}` : ''}`,
      );
    }
    for (const action of diff.actions.removed) out.push(`- **gone:** ${action.title}`);
    out.push('');
  }

  if (diff.findings.resolved.length) {
    out.push(`### Fixed (${diff.findings.resolved.length})`, '');
    for (const finding of diff.findings.resolved) {
      out.push(`- ~~${finding.title}~~ — \`${finding.at.file}\``);
    }
    out.push('');
  }

  if (changed.unmodelled.length) {
    out.push(
      `<sub>Not traced: ${changed.unmodelled.map((file) => `\`${file}\``).join(', ')} — config, styles, or a stack FlowLens does not read.</sub>`,
      '',
    );
  }
  out.push('<sub>FlowLens reads the source; nothing was executed or sent anywhere.</sub>', '');
  return out.join('\n');
}

/** Committed since the fork point, plus whatever is uncommitted on top. */
function filesSince(root: string, base: string): ChangedInput[] {
  const merged = new Map<string, ChangedInput>();
  for (const entry of [...changedFiles(root, base).files, ...changedFiles(root).files]) {
    merged.set(entry.file, entry);
  }
  return [...merged.values()];
}

function findingsOf(graph: FlowGraph): Finding[] {
  return projectFindings(graph, { reader: new SourceReader(graph) }).findings;
}

function escapeCell(text: string): string {
  return text.replace(/\|/g, '\\|').replace(/\n/g, ' ');
}

function git(cwd: string, args: string[]): { out: string; error?: string } {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (result.error) return { out: '', error: result.error.message };
  if (result.status !== 0) return { out: '', error: (result.stderr || 'git failed').trim() };
  return { out: result.stdout };
}

function fail(message: string): number {
  process.stderr.write(`${color.red('error')} ${message}\n`);
  return 1;
}
