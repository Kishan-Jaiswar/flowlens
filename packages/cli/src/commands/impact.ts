import {
  analyzeImpact,
  findBrokenCalls,
  findDeadEndpoints,
  findNodes,
  findSharedWrites,
} from '@flowlens/core';
import { graphPath, loadGraph } from '../paths.js';
import { color, glyph, heading, table } from '../ui.js';

export interface ImpactArgs {
  root: string;
  query: string;
  graph?: string;
  json?: boolean;
  limit?: number;
}

/**
 * `flowlens impact <symbol>` — "if I change this, what breaks?"
 *
 * The question a developer actually asks before touching unfamiliar code, and
 * the one that normally takes an afternoon of grepping.
 */
export function runImpact(args: ImpactArgs): number {
  const graph = loadGraph(graphPath(args.root, args.graph));
  const candidates = findNodes(graph, args.query);

  if (candidates.length === 0) {
    process.stderr.write(`${color.red('error')} nothing in the graph matches "${args.query}"\n`);
    return 1;
  }

  const target = candidates[0]!;
  if (candidates.length > 1 && !args.json) {
    process.stdout.write(
      color.gray(
        `${candidates.length} matches; using ${target.label}. Others: ` +
          candidates
            .slice(1, 5)
            .map((node) => node.label)
            .join(', ') +
          '\n',
      ),
    );
  }

  const report = analyzeImpact(graph, target.id);
  if (!report) {
    process.stderr.write(`${color.red('error')} could not analyze ${target.label}\n`);
    return 1;
  }

  if (args.json) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    return 0;
  }

  const limit = args.limit ?? 20;

  process.stdout.write(
    `\n${color.bold(report.target.label)} ${color.gray(`(${report.target.kind})`)}\n`,
  );
  if (report.target.file) {
    process.stdout.write(color.gray(`${report.target.file}:${report.target.line}\n`));
  }
  process.stdout.write(
    `blast radius ${blastColor(report.level)(String(report.blastRadius))} ` +
      `${color.gray(`nodes depend on this (${report.level} impact)`)}\n`,
  );

  if (report.affectedFlows.length > 0) {
    process.stdout.write(
      heading(`User-facing features affected (${report.affectedFlows.length})`) + '\n',
    );
    process.stdout.write(
      table(
        report.affectedFlows
          .slice(0, limit)
          .map((flow) => [flow.title.slice(0, 40), flow.component ?? '', flow.id]),
        ['feature', 'component', 'flow id'],
      ) + '\n',
    );
  }

  const direct = report.dependents.filter((dependent) => dependent.distance === 1);
  if (direct.length > 0) {
    process.stdout.write(heading(`Direct callers (${direct.length})`) + '\n');
    process.stdout.write(
      table(
        direct
          .slice(0, limit)
          .map((dependent) => [
            dependent.kind,
            dependent.label.slice(0, 44),
            dependent.file ? `${dependent.file}:${dependent.line}` : '',
          ]),
        ['kind', 'label', 'source'],
      ) + '\n',
    );
  }

  if (report.collections.length > 0) {
    process.stdout.write(heading('Data touched downstream') + '\n');
    process.stdout.write(`  ${report.collections.join(', ')}\n`);
  }

  if (report.warnings.length > 0) {
    process.stdout.write(heading('Warnings') + '\n');
    for (const warning of report.warnings) {
      process.stdout.write(`  ${color.yellow(glyph.warn)} ${warning}\n`);
    }
  }

  return 0;
}

function blastColor(level: 'low' | 'medium' | 'high') {
  if (level === 'high') return color.red;
  if (level === 'medium') return color.yellow;
  return color.green;
}

export interface DoctorArgs {
  root: string;
  graph?: string;
  json?: boolean;
}

/**
 * `flowlens doctor` — the findings that need no question asked: broken calls,
 * dead endpoints, and collections written from more than one place.
 */
export function runDoctor(args: DoctorArgs): number {
  const graph = loadGraph(graphPath(args.root, args.graph));
  const broken = findBrokenCalls(graph);
  const dead = findDeadEndpoints(graph);
  const shared = findSharedWrites(graph);

  if (args.json) {
    process.stdout.write(
      `${JSON.stringify(
        {
          brokenCalls: broken.map((node) => ({
            label: node.label,
            source: node.source,
            meta: node.meta,
          })),
          deadEndpoints: dead.map((node) => ({ label: node.label, source: node.source })),
          sharedWrites: shared,
        },
        null,
        2,
      )}\n`,
    );
    return 0;
  }

  process.stdout.write(heading(`API calls with no backend route (${broken.length})`) + '\n');
  if (broken.length === 0) {
    process.stdout.write(color.green('  none — every frontend call matches a route\n'));
  } else {
    for (const call of broken) {
      const reason =
        call.meta?.['mismatch'] === 'method'
          ? `method mismatch, backend has ${(call.meta['availableMethods'] as string[]).join(', ')}`
          : 'no such route';
      process.stdout.write(
        `  ${color.yellow(glyph.warn)} ${call.label}  ${color.gray(reason)}\n` +
          (call.source ? `      ${color.gray(`${call.source.file}:${call.source.line}`)}\n` : ''),
      );
    }
  }

  process.stdout.write(heading(`Endpoints with no known caller (${dead.length})`) + '\n');
  if (dead.length === 0) {
    process.stdout.write(color.green('  none\n'));
  } else {
    for (const route of dead) {
      process.stdout.write(
        `  ${color.gray(glyph.dot)} ${route.label}` +
          (route.source ? `  ${color.gray(`${route.source.file}:${route.source.line}`)}` : '') +
          '\n',
      );
    }
    process.stdout.write(
      color.gray('  (mobile clients, cron jobs and other repos will not appear as callers)\n'),
    );
  }

  process.stdout.write(
    heading(`Collections written by several services (${shared.length})`) + '\n',
  );
  if (shared.length === 0) {
    process.stdout.write(color.green('  none — each collection has a single writer\n'));
  } else {
    for (const entry of shared) {
      process.stdout.write(
        `  ${color.yellow(glyph.warn)} ${entry.collection}: ${entry.writers.join(', ')}\n`,
      );
    }
  }

  return 0;
}
