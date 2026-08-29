import { isWhereFailure, whereIs, type WhereFlowHit, type WhereNode } from '@flowlens/core';
import { graphPath, loadGraph } from '../paths.js';
import { ascii, color, glyph, heading, riskBadge, table } from '../ui.js';

export interface WhereArgs {
  root: string;
  /** `file`, `file:line`, or `file:line:column`. */
  location: string;
  graph?: string;
  json?: boolean;
  limit?: number;
}

/**
 * `flowlens where <file>:<line>` — "what is this code for?"
 *
 * The reverse of `flowlens flow <id>`. A developer reading unfamiliar code can
 * see what a function does; what they cannot see is which user-visible features
 * depend on it, which is the thing that decides whether the change is safe. The
 * file gives you the *what*; this gives you the *why*.
 */
export function runWhere(args: WhereArgs): number {
  const graph = loadGraph(graphPath(args.root, args.graph));
  const report = whereIs(graph, args.location, { root: args.root });

  if (isWhereFailure(report)) {
    if (report.reason === 'ambiguous-file') {
      process.stderr.write(
        `${color.red('error')} "${report.file}" matches ${report.candidates.length} files:\n`,
      );
      for (const candidate of report.candidates.slice(0, 10)) {
        process.stderr.write(`  ${candidate}\n`);
      }
      process.stderr.write(color.gray('\nGive more of the path to pick one.\n'));
      return 1;
    }
    process.stderr.write(
      `${color.red('error')} nothing in the graph comes from "${report.file}"\n` +
        color.gray('The file may be unscanned, or have no components, routes or queries.\n'),
    );
    return 1;
  }

  if (args.json) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    return 0;
  }

  const limit = args.limit ?? 20;
  const at = report.line === undefined ? report.file : `${report.file}:${report.line}`;
  process.stdout.write(`\n${color.bold(at)}\n`);

  if (report.matches.length === 0) {
    process.stdout.write(color.gray('no graph node in this file\n'));
    return 0;
  }

  // Say plainly when the answer is the nearest declaration rather than the line
  // asked for — a silent approximation is how a tool loses trust.
  const offset = report.matches[0]?.offset ?? 0;
  process.stdout.write(heading(offset === 0 ? 'You are in' : 'Nearest declaration') + '\n');
  for (const match of report.matches) {
    process.stdout.write(`  ${describe(match)}${offsetNote(match)}\n`);
  }

  if (report.flows.length > 0) {
    process.stdout.write(heading(`Features running through here (${report.flows.length})`) + '\n');
    process.stdout.write(
      table(
        report.flows
          .slice(0, limit)
          .map((flow) => [
            clip(flow.title, 38),
            clip(`${flow.via.kind} ${flow.via.label}`, 34) + (flow.indirect ? ' *' : ''),
            flow.endpoints[0] ?? color.gray('local only'),
            summarize(flow.collections),
            riskBadge(flow.level),
            flow.id,
          ]),
        ['feature', 'via', 'endpoint', 'data', 'risk', 'flow id'],
      ) + '\n',
    );
    if (report.flows.some((flow) => flow.indirect)) {
      process.stdout.write(
        color.gray('  * reached one hop out — through the handler that uses this\n'),
      );
    }
    warn(report.flows);
  } else {
    process.stdout.write(
      heading('Features running through here') +
        '\n  ' +
        color.gray('none — no user action reaches this code\n'),
    );
  }

  if (report.otherFlowsInFile.length > 0) {
    process.stdout.write(
      heading(`Elsewhere in this file (${report.otherFlowsInFile.length})`) + '\n',
    );
    for (const flow of report.otherFlowsInFile.slice(0, 8)) {
      process.stdout.write(
        `  ${color.gray(`line ${flow.via.line ?? '?'}`)}  ${clip(flow.title, 40)} ` +
          color.gray(`(${flow.id})\n`),
      );
    }
  }

  process.stdout.write(
    color.gray(
      `\nflowlens flow ${report.flows[0]?.id ?? '<id>'} --project ${args.root}   # the full chain\n`,
    ),
  );
  return 0;
}

/**
 * A short list, or the first two and a count.
 *
 * Truncating the joined string would cut a collection name in half — `audi…`
 * reads as a name, not as "there is more". A count is both shorter and honest.
 */
function summarize(values: string[]): string {
  if (values.length <= 2) return values.join(', ');
  return `${values.slice(0, 2).join(', ')} ${color.gray(`+${values.length - 2}`)}`;
}

/** Cut to width, but say so — a silently truncated collection name misleads. */
function clip(text: string, width: number): string {
  if (text.length <= width) return text;
  return ascii ? `${text.slice(0, width - 3)}...` : `${text.slice(0, width - 1)}\u2026`;
}

function describe(node: WhereNode): string {
  return (
    `${color.gray(`[${node.kind}]`)} ${node.label}` +
    (node.line ? color.gray(`  line ${node.line}`) : '')
  );
}

function offsetNote(node: WhereNode): string {
  if (!node.offset) return '';
  const lines = Math.abs(node.offset) === 1 ? 'line' : 'lines';
  return color.gray(`  (${Math.abs(node.offset)} ${lines} ${node.offset > 0 ? 'above' : 'below'})`);
}

/** The two facts that change how carefully you edit this line. */
function warn(flows: WhereFlowHit[]): void {
  const high = flows.filter((flow) => flow.level === 'high').length;
  const writes = new Set(flows.flatMap((flow) => (flow.hitsBackend ? flow.collections : [])));
  const notes: string[] = [];
  if (high > 0) {
    notes.push(
      high === 1
        ? '1 high-risk feature depends on this'
        : `${high} high-risk features depend on this`,
    );
  }
  if (writes.size >= 2) notes.push(`reaches ${writes.size} collections`);
  if (flows.every((flow) => flow.evidence === 'static')) {
    notes.push('never observed at runtime — the static picture may be incomplete');
  }
  if (notes.length === 0) return;
  for (const note of notes) {
    process.stdout.write(`  ${color.yellow(glyph.warn)} ${note}\n`);
  }
}
