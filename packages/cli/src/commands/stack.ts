import {
  STACK_ROLE_LABEL,
  STACK_ROLE_ORDER,
  detectStack,
  stackSummary,
  type StackEntry,
  type StackReport,
  type StackRole,
} from '@flowslens/core';
import { color, table } from '../ui.js';

export interface StackArgs {
  root: string;
  extraRoots?: string[];
  json?: boolean;
  quiet?: boolean;
}

/**
 * `flowlens stack` — "what is this project built with?"
 *
 * The question that comes before any flow makes sense, and the one Flowslens
 * could not answer: it knew enough about frameworks to sort files into
 * frontend and backend, then threw the evidence away. Reading the manifests
 * instead means the answer carries versions, which is the part that actually
 * decides what you can do — React 17 and React 19 are different projects.
 *
 * It reads `package.json` files and looks for marker files. No parse, no graph,
 * no `node_modules`, so it works on a repository you have not scanned yet —
 * which is exactly when you need it.
 */
export function runStack(args: StackArgs): number {
  const roots = [args.root, ...(args.extraRoots ?? [])];
  const report = detectStack(roots);

  if (args.json) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    return 0;
  }

  if (report.manifests.length === 0) {
    process.stderr.write(
      `${color.red('error')} no package.json found under ${args.root}\n` +
        color.gray('Flowslens reads JavaScript and TypeScript projects.\n'),
    );
    return 1;
  }

  process.stdout.write(`\n${color.bold(stackSummary(report))}\n`);
  process.stdout.write(`${color.gray(describeShape(report))}\n\n`);

  for (const role of STACK_ROLE_ORDER) {
    const entries = report.entries.filter((entry) => entry.role === role);
    if (entries.length === 0) continue;
    process.stdout.write(`${color.bold(STACK_ROLE_LABEL[role])}\n`);
    process.stdout.write(
      `${table(entries.map((entry) => [`  ${entry.name}`, entry.version, note(entry)]))}\n`,
    );
  }

  if (report.markers.length > 0 && !args.quiet) {
    process.stdout.write(`${color.bold('Also present')}\n`);
    for (const marker of report.markers) process.stdout.write(`  ${marker}\n`);
    process.stdout.write('\n');
  }

  /**
   * The honest footer.
   *
   * A stack report that lists Vue and TypeORM without saying Flowslens cannot
   * trace either one is a report that overpromises — the developer runs `scan`,
   * gets an empty graph, and concludes the tool is broken rather than
   * unfinished. Saying it here costs two lines and sets the expectation before
   * the afternoon is spent.
   */
  if (report.edgeOnly.length > 0) {
    process.stdout.write(
      `${color.yellow('traced to the hand-off')} ${report.edgeOnly.join(', ')}\n` +
        color.gray('  The call that hands work over is shown; what happens after is not read.\n'),
    );
  }

  if (report.unread.length > 0) {
    process.stdout.write(
      `${color.yellow('not traced yet')} ${report.unread.join(', ')}\n` +
        color.gray('  Everything else above can be followed end to end by `flowlens scan`.\n'),
    );
  }

  if (report.unread.length > 0 || report.edgeOnly.length > 0) process.stdout.write('\n');

  for (const warning of report.warnings) {
    process.stderr.write(`${color.yellow('warning')} ${warning}\n`);
  }

  return 0;
}

/** "monorepo, 4 packages, pnpm, Node >=18.18" — the shape in one line. */
function describeShape(report: StackReport): string {
  const parts: string[] = [];
  const workspaceRoot = report.manifests.find((manifest) => manifest.workspaces);
  if (workspaceRoot || report.manifests.length > 1) {
    parts.push(`monorepo, ${report.manifests.length} package.json files`);
  } else {
    parts.push('single package');
  }
  if (report.packageManager) parts.push(report.packageManager);
  if (report.nodeRange) parts.push(`Node ${report.nodeRange}`);
  return parts.join(' · ');
}

/**
 * Where a dependency was declared, and whether it is a dev dependency.
 *
 * `from` matters in a monorepo: "react 18 in web/" and "react 19 in admin/" is
 * a real situation, and the column is how a reader spots it.
 */
function note(entry: StackEntry): string {
  const bits: string[] = [];
  if (entry.from !== '.') bits.push(entry.from);
  if (entry.dev) bits.push('dev');
  if (entry.read === false) bits.push('not traced');
  if (entry.read === 'edge') bits.push('hand-off only');
  return color.gray(bits.join(' · '));
}

/** Exposed for tests: the role a package name was filed under. */
export function roleOf(report: StackReport, packageName: string): StackRole | undefined {
  return report.entries.find((entry) => entry.package === packageName)?.role;
}
