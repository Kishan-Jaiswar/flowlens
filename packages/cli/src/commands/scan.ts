import { relative } from 'node:path';
import { findBrokenCalls, findDeadEndpoints, resolveFlows, scan } from '@flowlens/core';
import { graphPath, saveGraph } from '../paths.js';
import { color, heading, table } from '../ui.js';

export interface ScanArgs {
  root: string;
  /** Sibling repositories scanned into the same graph. */
  extraRoots?: string[];
  out?: string;
  json?: boolean;
  quiet?: boolean;
  includeTests?: boolean;
  ignore?: string[];
  apiPrefix?: string[];
  requestFunctionPattern?: string;
  httpClients?: string[];
  resolveConstants?: boolean;
  maxFiles?: number;
  /** Config file the settings came from, shown for transparency. */
  configPath?: string;
}

/**
 * `flowlens scan <project>` — read the source, build the graph, write it to
 * `.flowlens/graph.json`.
 *
 * Reads files only. No database connection, no network calls, no code executed
 * from the project being scanned.
 */
export function runScan(args: ScanArgs): number {
  const result = scan({
    root: args.root,
    ...(args.extraRoots ? { extraRoots: args.extraRoots } : {}),
    ...(args.ignore ? { ignore: args.ignore } : {}),
    ...(args.includeTests !== undefined ? { includeTests: args.includeTests } : {}),
    ...(args.apiPrefix ? { apiPrefixes: args.apiPrefix } : {}),
    ...(args.requestFunctionPattern ? { requestFunctionPattern: args.requestFunctionPattern } : {}),
    ...(args.httpClients ? { httpClients: args.httpClients } : {}),
    ...(args.resolveConstants !== undefined ? { resolveConstants: args.resolveConstants } : {}),
    ...(args.maxFiles ? { maxFiles: args.maxFiles } : {}),
  });

  const target = saveGraph(graphPath(args.root, args.out), result.graph);

  const flows = resolveFlows(result.graph);
  const broken = findBrokenCalls(result.graph);
  const dead = findDeadEndpoints(result.graph);

  if (args.json) {
    process.stdout.write(
      `${JSON.stringify(
        {
          graph: target,
          stats: result.stats,
          seam: { matched: result.seam.matched, unmatched: result.seam.unmatchedCalls.length },
          flows: flows.length,
          durationMs: result.durationMs,
        },
        null,
        2,
      )}\n`,
    );
    return 0;
  }

  if (args.quiet) {
    process.stdout.write(`${target}\n`);
    return 0;
  }

  const { stats } = result;
  const scanned = [args.root, ...(args.extraRoots ?? [])].join(' + ');
  process.stdout.write(
    `\n${color.bold('FlowLens')} scanned ${color.cyan(scanned)} ` +
      `${color.gray(`(${stats.filesAnalyzed} files in ${result.durationMs}ms)`)}\n`,
  );
  if (stats.constantsResolved > 0) {
    process.stdout.write(
      color.gray(`resolved ${stats.constantsResolved} URL constants from source\n`),
    );
  }
  if (args.configPath) {
    process.stdout.write(color.gray(`config: ${args.configPath}\n`));
  }

  process.stdout.write(heading('What it found') + '\n');
  process.stdout.write(
    table(
      [
        ['components', String(stats.components)],
        ['user actions', String(stats.uiActions)],
        ['handlers', String(stats.handlers)],
        ['API calls (frontend)', String(stats.apiCalls)],
        ['routes (backend)', String(stats.routes)],
        ['controllers', String(stats.controllers)],
        ['services', String(stats.services)],
        ['db operations', String(stats.dbOperations)],
        ['collections', String(stats.collections)],
      ],
      ['', 'count'],
    ) + '\n',
  );
  if (stats.fileRoutes > 0) {
    process.stdout.write(
      color.gray(
        `${stats.fileRoutes} of those routes come from file-system routing (pages/api, app router)\n`,
      ),
    );
  }

  process.stdout.write(heading('Frontend ↔ backend') + '\n');
  process.stdout.write(
    `${color.green(String(result.seam.matched))} API calls matched a backend route\n`,
  );
  if (broken.length > 0) {
    process.stdout.write(
      `${color.yellow(String(broken.length))} API calls matched nothing — likely a wrong URL or method:\n`,
    );
    for (const call of broken.slice(0, 8)) {
      const hint =
        call.meta?.['mismatch'] === 'method'
          ? ` ${color.gray(`(backend has ${(call.meta['availableMethods'] as string[]).join(', ')})`)}`
          : '';
      process.stdout.write(`  ${color.yellow('⚠')} ${call.label}${hint}\n`);
    }
    if (broken.length > 8) process.stdout.write(color.gray(`  … ${broken.length - 8} more\n`));
  }
  if (dead.length > 0) {
    process.stdout.write(
      `${color.gray(String(dead.length))} backend routes have no known caller ${color.gray('(possibly dead, or called from outside this repo)')}\n`,
    );
  }
  process.stdout.write(`${color.gray(`${result.lineageLinks} field-level lineage links`)}\n`);

  process.stdout.write(heading(`Feature flows (${flows.length})`) + '\n');
  if (flows.length === 0) {
    process.stdout.write(
      color.gray(
        'No UI action reached the backend. If this project keeps its frontend elsewhere,\n' +
          'scan the parent directory containing both.\n',
      ),
    );
  } else {
    process.stdout.write(
      table(
        flows.slice(0, 10).map((flow) => [
          flow.id,
          flow.label.slice(0, 32),
          flow.endpoints[0] ?? '',
          // A collection read *and* written appears twice in `collections`;
          // the summary only needs the name once.
          [...new Set(flow.collections.map((c) => c.collection))].join(',').slice(0, 60),
        ]),
        ['id', 'action', 'endpoint', 'collections'],
      ) + '\n',
    );
    if (flows.length > 10) process.stdout.write(color.gray(`… ${flows.length - 10} more\n`));
  }

  // Guidance whenever the result looks thinner than the project deserves.
  if (result.diagnostics.length > 0) {
    process.stdout.write(heading('Notes') + '\n');
    for (const note of result.diagnostics) {
      process.stdout.write(`  ${color.yellow('•')} ${note}\n`);
    }
  }

  if (result.warnings.length > 0) {
    const shown = result.warnings.slice(0, 5);
    process.stdout.write(heading(`Skipped (${result.warnings.length})`) + '\n');
    for (const warning of shown) {
      process.stdout.write(`  ${color.gray('·')} ${warning}\n`);
    }
    if (result.warnings.length > shown.length) {
      process.stdout.write(color.gray(`  … ${result.warnings.length - shown.length} more\n`));
    }
  }

  process.stdout.write(
    `\n${color.gray('graph:')} ${relative(process.cwd(), target) || target}\n` +
      `${color.gray('next:')}  flowlens flow ${flows[0]?.id ?? '<id>'} ${color.gray(`--project ${args.root}`)}\n` +
      `${color.gray('   or:')}  flowlens serve ${args.root}\n`,
  );

  return 0;
}
