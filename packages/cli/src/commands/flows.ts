import { writeFileSync } from 'node:fs';
import {
  renderFeatureDocument,
  renderFlowTree,
  renderTimings,
  resolveFlows,
  type FeatureFlow,
  type FlowGraph,
} from '@flowlens/core';
import { graphPath, loadGraph } from '../paths.js';
import { color, evidenceBadge, heading, riskBadge, table } from '../ui.js';

export interface FlowsArgs {
  root: string;
  graph?: string;
  json?: boolean;
  all?: boolean;
}

/** `flowlens flows` — every user action that reaches the backend. */
export function runFlows(args: FlowsArgs): number {
  const graph = loadGraph(graphPath(args.root, args.graph));
  const flows = resolveFlows(graph, { includeLocalOnly: args.all ?? false });

  if (args.json) {
    process.stdout.write(`${JSON.stringify(flows, null, 2)}\n`);
    return 0;
  }

  if (flows.length === 0) {
    process.stdout.write(color.gray('No feature flows found. Try `flowlens flows --all`.\n'));
    return 0;
  }

  process.stdout.write(heading(`${flows.length} feature flows`) + '\n');
  process.stdout.write(
    table(
      flows.map((flow) => [
        flow.id,
        flow.label.slice(0, 30),
        flow.component ?? '',
        flow.endpoints.join(' ') || color.gray('—'),
        flow.collections.map((c) => `${c.collection}:${c.access[0]}`).join(' ') || color.gray('—'),
        riskBadge(flow.risk.level),
        evidenceBadge(flow.evidence),
      ]),
      ['id', 'action', 'component', 'endpoint', 'data', 'risk', 'evidence'],
    ) + '\n',
  );
  process.stdout.write(
    color.gray(`\nflowlens flow <id> --project ${args.root}   # full trace for one flow\n`),
  );
  return 0;
}

export interface FlowArgs {
  root: string;
  id: string;
  graph?: string;
  json?: boolean;
  markdown?: boolean;
  out?: string;
}

/** `flowlens flow <id>` — the whole path from click to collection. */
export function runFlow(args: FlowArgs): number {
  const graph = loadGraph(graphPath(args.root, args.graph));
  const flows = resolveFlows(graph, { includeLocalOnly: true });
  const flow = findFlow(flows, args.id);

  if (!flow) {
    process.stderr.write(
      `${color.red('error')} no flow matching "${args.id}"\n\nAvailable:\n` +
        flows
          .slice(0, 15)
          .map((f) => `  ${f.id}${color.gray(`  ${f.label}`)}`)
          .join('\n') +
        '\n',
    );
    return 1;
  }

  if (args.json) {
    process.stdout.write(`${JSON.stringify(flow, null, 2)}\n`);
    return 0;
  }

  if (args.markdown || args.out) {
    const document = renderFeatureDocument(graph, flow);
    if (args.out) {
      writeFileSync(args.out, document, 'utf8');
      process.stdout.write(`${color.green('written')} ${args.out}\n`);
    } else {
      process.stdout.write(`${document}\n`);
    }
    return 0;
  }

  printFlow(graph, flow);
  return 0;
}

function printFlow(graph: FlowGraph, flow: FeatureFlow): void {
  process.stdout.write(`\n${color.bold(flow.label)}  ${color.gray(`(${flow.id})`)}\n`);
  if (flow.source) {
    process.stdout.write(color.gray(`${flow.source.file}:${flow.source.line}\n`));
  }
  process.stdout.write(
    `risk ${riskBadge(flow.risk.level)} ${color.gray(`(${flow.risk.score})`)}   ` +
      `evidence ${evidenceBadge(flow.evidence)}` +
      (flow.totalMs !== undefined ? `   ${color.cyan(`${flow.totalMs}ms`)}` : '') +
      '\n',
  );

  process.stdout.write(heading('Execution path') + '\n');
  process.stdout.write(`${renderFlowTree(flow)}\n`);

  if (flow.state.length > 0) {
    process.stdout.write(heading('Frontend state') + '\n');
    process.stdout.write(`${flow.state.map((s) => `  ${s}`).join('\n')}\n`);
  }

  const timings = renderTimings(flow);
  if (timings) {
    process.stdout.write(heading('Timing') + '\n');
    process.stdout.write(`${timings}\n`);
  }

  if (flow.risk.reasons.length > 0) {
    process.stdout.write(heading('Risk factors') + '\n');
    for (const reason of flow.risk.reasons) {
      process.stdout.write(`  ${color.yellow('•')} ${reason}\n`);
    }
  }

  process.stdout.write(
    color.gray(`\nflowlens flow ${flow.id} --markdown   # generate the feature document\n`),
  );
  void graph;
}

/** Match by exact id, then prefix, then a fuzzy label match. */
function findFlow(flows: FeatureFlow[], query: string): FeatureFlow | undefined {
  const needle = query.toLowerCase();
  return (
    flows.find((flow) => flow.id === query) ??
    flows.find((flow) => flow.id.startsWith(needle)) ??
    flows.find((flow) => flow.label.toLowerCase() === needle) ??
    flows.find((flow) => flow.label.toLowerCase().includes(needle))
  );
}
