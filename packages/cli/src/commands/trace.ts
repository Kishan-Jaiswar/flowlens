import { existsSync, readFileSync } from 'node:fs';
import { mergeRuntimeTrace, parseTraceFile } from '@flowslens/core';
import { graphPath, loadGraph, saveGraph, tracePath } from '../paths.js';
import { color, heading, table } from '../ui.js';

export interface TraceArgs {
  root: string;
  graph?: string;
  trace?: string;
  json?: boolean;
  /** Write the merged graph back to disk (default true). */
  write?: boolean;
}

/**
 * `flowlens trace` — merge recorded spans into the graph.
 *
 * Static analysis says "these components appear connected"; the trace says
 * "this exact path executed". Where both agree, the flow becomes *confirmed* —
 * and the gaps in either direction are the most interesting output of the whole
 * tool.
 */
export function runTrace(args: TraceArgs): number {
  const graphFile = graphPath(args.root, args.graph);
  const traceFile = tracePath(args.root, args.trace);

  if (!existsSync(traceFile)) {
    process.stderr.write(
      `${color.red('error')} no trace file at ${traceFile}\n\n` +
        `Record one by adding @flowlens/runtime to the app you are studying:\n` +
        `  ${color.cyan("import { flowlensHttp, flowlensMongoose } from '@flowlens/runtime';")}\n` +
        `  ${color.cyan('app.use(flowlensHttp());')}\n` +
        `  ${color.cyan('mongoose.plugin(flowlensMongoose());')}\n\n` +
        `Then use the app, and run this command again.\n`,
    );
    return 1;
  }

  const graph = loadGraph(graphFile);
  const events = parseTraceFile(readFileSync(traceFile, 'utf8'));
  const result = mergeRuntimeTrace(graph, events);

  if (args.write !== false) saveGraph(graphFile, graph);

  if (args.json) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return 0;
  }

  process.stdout.write(
    `\n${color.bold('Merged runtime traces')} ${color.gray(`from ${traceFile}`)}\n`,
  );
  process.stdout.write(
    table(
      [
        ['traces', String(result.traces)],
        ['spans', String(result.spans)],
        ['matched static nodes', color.green(String(result.matched))],
        ['runtime-only discoveries', color.cyan(String(result.discovered))],
      ],
      ['', ''],
    ) + '\n',
  );

  const confirmed = graph.allNodes().filter((node) => node.evidence === 'confirmed').length;
  const runtimeOnly = graph.allNodes().filter((node) => node.evidence === 'runtime');

  process.stdout.write(heading('Confidence') + '\n');
  process.stdout.write(
    `  ${color.green(String(confirmed))} nodes confirmed by both source and runtime\n`,
  );

  if (runtimeOnly.length > 0) {
    process.stdout.write(
      `  ${color.cyan(String(runtimeOnly.length))} nodes seen only at runtime ` +
        `${color.gray('(the static analyzer missed these — dynamic routing, ORM helpers, drift)')}\n`,
    );
    for (const node of runtimeOnly.slice(0, 10)) {
      process.stdout.write(`      ${node.kind}  ${node.label}\n`);
    }
  }

  const slowest = graph
    .allNodes()
    .filter((node) => node.timing !== undefined)
    .sort((a, b) => (b.timing?.avgMs ?? 0) - (a.timing?.avgMs ?? 0))
    .slice(0, 8);

  if (slowest.length > 0) {
    process.stdout.write(heading('Slowest observed steps') + '\n');
    process.stdout.write(
      table(
        slowest.map((node) => [
          // The kind matters: an api-call and the route it hits share a label
          // but measure different things (round trip vs server time).
          color.gray(node.kind),
          node.label.slice(0, 40),
          `${node.timing?.avgMs ?? 0}ms avg`,
          `${node.timing?.maxMs ?? 0}ms max`,
          `${node.timing?.count ?? 0}x`,
        ]),
      ) + '\n',
    );
  }

  if (args.write !== false) {
    process.stdout.write(`\n${color.gray('graph updated:')} ${graphFile}\n`);
  }
  return 0;
}
