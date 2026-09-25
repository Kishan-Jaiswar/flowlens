import { projectFindings, type Finding, type FindingSeverity } from '@flowslens/core';
import { graphPath, loadGraph } from '../paths.js';
import { color, glyph, heading } from '../ui.js';

export interface FindingsArgs {
  root: string;
  graph?: string;
  json?: boolean;
  /** Exit 1 when a finding at or above this severity exists — for CI. */
  failOn?: FindingSeverity;
}

const RANK: Record<FindingSeverity, number> = { high: 0, medium: 1, low: 2 };

/**
 * `flowlens findings` — the bugs the graph and the source can show: routes
 * with no auth, queries that forget the tenant, the request body written as
 * is, queries in loops, reads that wait for each other. Each with the line to
 * open, why it matters and how to fix it.
 */
export function runFindings(args: FindingsArgs): number {
  const graph = loadGraph(graphPath(args.root, args.graph));
  const result = projectFindings(graph);
  const failing = args.failOn
    ? result.findings.filter((finding) => RANK[finding.severity] <= RANK[args.failOn!])
    : [];

  if (args.json) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return failing.length ? 1 : 0;
  }

  const counts = (['high', 'medium', 'low'] as const)
    .map(
      (severity) =>
        [severity, result.findings.filter((f) => f.severity === severity).length] as const,
    )
    .filter(([, count]) => count > 0);
  process.stdout.write(
    heading(`Findings (${result.findings.length})`) +
      '\n' +
      color.gray(
        `  checked ${result.checked.routes} routes and ${result.checked.queries} queries` +
          (result.tenantKey ? ` · tenant field: ${result.tenantKey}` : '') +
          '\n',
      ),
  );
  if (result.findings.length === 0) {
    process.stdout.write(color.green('  nothing found\n'));
  } else {
    process.stdout.write(
      `  ${counts.map(([severity, count]) => paint(severity)(`${count} ${severity}`)).join(color.gray(' · '))}\n`,
    );
    for (const finding of result.findings) process.stdout.write(render(finding));
  }
  for (const note of result.notes) process.stdout.write(color.gray(`\n  note: ${note}\n`));
  return failing.length ? 1 : 0;
}

function paint(severity: FindingSeverity): (text: string) => string {
  return severity === 'high' ? color.red : severity === 'medium' ? color.yellow : color.gray;
}

function render(finding: Finding): string {
  const plain = (text: string): string => text.replace(/`/g, '');
  const lines = [
    '',
    `  ${paint(finding.severity)(`${glyph.warn} ${finding.severity.toUpperCase()}`)}  ${color.bold(plain(finding.title))}`,
    // `file:line` on its own: terminals make it clickable.
    `      ${color.cyan(`${finding.at.file}:${finding.at.line}`)}`,
    `      ${plain(finding.why)}`,
    `      ${color.green('fix:')} ${plain(finding.fix)}`,
  ];
  for (const related of finding.related ?? [])
    lines.push(`      ${color.gray(`${related.text} — ${related.at.file}:${related.at.line}`)}`);
  if (finding.flowIds.length)
    lines.push(
      `      ${color.gray(`reached by ${finding.flowIds.length} action${finding.flowIds.length === 1 ? '' : 's'}: ${finding.flowIds.slice(0, 3).join(', ')}${finding.flowIds.length > 3 ? ', …' : ''}`)}`,
    );
  return `${lines.join('\n')}\n`;
}
