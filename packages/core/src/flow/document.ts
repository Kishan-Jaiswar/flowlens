import { DB_EFFECT_LABEL, DB_EFFECT_ORDER, type DbEffect } from '../analyzer/mongo.js';
import type { FlowGraph } from '../graph/graph.js';
import type { Evidence } from '../graph/types.js';
import { analyzeImpact } from '../impact/impact.js';
import { glyphsFor, type Glyphs } from '../ui/glyphs.js';
import type { FeatureFlow, FlowStep } from './resolve.js';

const EVIDENCE_BADGE: Record<Evidence, string> = {
  static: 'inferred from source',
  runtime: 'observed at runtime only',
  confirmed: 'confirmed (static + runtime)',
};

/** How to draw: box-drawing characters, or plain ASCII for old terminals. */
export interface RenderOptions {
  ascii?: boolean;
}

/**
 * Render a feature flow as the ASCII tree from the product spec.
 *
 * Plain text on purpose: it reads the same in a terminal, a PR description, a
 * generated markdown doc and a VS Code hover.
 */
export function renderFlowTree(flow: FeatureFlow, options: RenderOptions = {}): string {
  const g = glyphsFor(options.ascii ?? false);
  const lines: string[] = [];
  const groups: Array<[string, FlowStep[]]> = [
    ['USER ACTION', flow.steps.filter((s) => s.layer === 'ui')],
    ['FRONTEND', flow.steps.filter((s) => s.layer === 'frontend')],
    ['NETWORK', flow.steps.filter((s) => s.layer === 'network')],
    ['BACKEND', flow.steps.filter((s) => s.layer === 'backend')],
    ['DATABASE', flow.steps.filter((s) => s.layer === 'data')],
  ];

  const populated = groups.filter(([, steps]) => steps.length > 0);

  populated.forEach(([title, steps], groupIndex) => {
    lines.push(title);
    steps.forEach((step, index) => {
      const last = index === steps.length - 1;
      const branch = last ? g.lastBranch : g.branch;
      lines.push(`${branch} ${stepLabel(step)}`);
      const detail = stepDetail(step, g);
      if (detail) {
        lines.push(`${last ? '    ' : `${g.vertical}   `}${detail}`);
      }
    });
    if (groupIndex < populated.length - 1) {
      lines.push(g.vertical);
      lines.push(g.down);
    }
  });

  return lines.join('\n');
}

function stepLabel(step: FlowStep): string {
  const kind = step.kind.replace('-', ' ');
  const timing = step.avgMs !== undefined ? `  ${step.avgMs}ms` : '';
  return `${padKind(kind)} ${stepTitle(step)}${timing}`;
}

/**
 * What to call a step in a tree or a tile.
 *
 * A `ui-action` carries a descriptive title (`Prescription · Submit`) because
 * its own label is only the words on the element. Everything else is named
 * after code, where the identifier *is* the clearest name.
 */
export function stepTitle(step: FlowStep): string {
  const title = step.meta?.['title'];
  return typeof title === 'string' && title.length > 0 ? title : step.label;
}

function padKind(kind: string): string {
  return `[${kind}]`.padEnd(13, ' ');
}

function stepDetail(step: FlowStep, g: Glyphs): string | undefined {
  const parts: string[] = [];
  if (step.file) parts.push(`${step.file}${step.line ? `:${step.line}` : ''}`);
  // The contract this step carries, so the tree answers "with what?" and not
  // only "what next?".
  const d = step.detail;
  if (d?.queryKeys?.length) parts.push(`?${d.queryKeys.join(' &')}`);
  if (d?.payloadKeys?.length) parts.push(`body: ${d.payloadKeys.join(', ')}`);
  if (d?.dtos?.length) parts.push(`dto: ${d.dtos.map((dto) => dto.name).join(', ')}`);
  if (d?.schema) parts.push(`schema: ${d.schema.model}`);
  if (d?.statesWritten?.length) parts.push(`sets: ${d.statesWritten.join(', ')}`);
  // Prefer the specific effect (`create`/`update`/`delete`) over the coarse
  // `write`; older graphs only carry `access`.
  if (step.kind === 'db-op') {
    const effect = step.meta?.['effect'] ?? step.meta?.['access'];
    if (effect) parts.push(String(effect));
  }
  if (step.meta?.['mismatch']) parts.push(`${g.warn} ${describeMismatch(step)}`);
  if (step.meta?.['unresolved']) parts.push(`${g.warn} handler not resolved statically`);
  if (step.meta?.['discoveredAtRuntime']) parts.push('runtime-only');
  return parts.length > 0 ? parts.join('  ') : undefined;
}

function describeMismatch(step: FlowStep): string {
  if (step.meta?.['mismatch'] === 'method') {
    const available = (step.meta['availableMethods'] as string[] | undefined) ?? [];
    return `no route for this method (backend has: ${available.join(', ')})`;
  }
  return 'no matching backend route';
}

/**
 * The timing breakdown, when runtime data is available.
 *
 * Shows exclusive time per step, so the column adds up to the total instead of
 * counting nested spans several times over.
 */
export function renderTimings(flow: FeatureFlow, options: RenderOptions = {}): string | undefined {
  const g = glyphsFor(options.ascii ?? false);
  const timed = flow.steps.filter((step) => step.avgSelfMs !== undefined);
  if (timed.length === 0) return undefined;

  // An api-call and the route it hits share a label; the kind disambiguates
  // "network round trip" from "server-side handling".
  const rows = timed
    .filter((step) => (step.avgSelfMs ?? 0) > 0)
    .sort((a, b) => (b.avgSelfMs ?? 0) - (a.avgSelfMs ?? 0))
    .map((step) => ({ name: `${step.label} (${step.kind})`, ms: step.avgSelfMs ?? 0 }));

  const width = Math.max(...rows.map((row) => row.name.length), 8);
  const lines = rows.map((row) => `${row.name.padEnd(width)}  ${String(row.ms).padStart(8)}ms`);

  lines.push(g.rule.repeat(width + 12));
  lines.push(`${'Total'.padEnd(width)}  ${String(flow.totalMs ?? 0).padStart(8)}ms`);
  return lines.join('\n');
}

/**
 * The living feature document.
 *
 * Generated, never hand-written — the point is that it cannot drift from the
 * code, because it *is* the code, read back.
 */
export function renderFeatureDocument(graph: FlowGraph, flow: FeatureFlow): string {
  const lines: string[] = [];

  lines.push(`# ${flow.title}`);
  lines.push('');
  lines.push(
    `> Generated by FlowLens from source${flow.evidence === 'static' ? '' : ' and runtime traces'}.`,
  );
  lines.push('');

  lines.push('## Overview');
  lines.push('');
  lines.push(`| | |`);
  lines.push(`|---|---|`);
  lines.push(`| Flow id | \`${flow.id}\` |`);
  if (flow.screen) lines.push(`| Screen | ${flow.screen} |`);
  if (flow.label !== flow.title) lines.push(`| Action | ${flow.label} |`);
  if (flow.component) lines.push(`| Component | \`${flow.component}\` |`);
  if (flow.event) lines.push(`| Event | \`${flow.event}\` |`);
  if (flow.source) lines.push(`| Declared at | \`${flow.source.file}:${flow.source.line}\` |`);
  lines.push(`| Evidence | ${EVIDENCE_BADGE[flow.evidence]} |`);
  lines.push(`| Risk | **${flow.risk.level}** (${flow.risk.score}) |`);
  if (flow.totalMs !== undefined) lines.push(`| Observed duration | ${flow.totalMs}ms |`);
  lines.push(`| Endpoints | ${flow.endpoints.map((e) => `\`${e}\``).join(', ') || '—'} |`);
  lines.push(
    `| Collections | ${
      flow.collections.map((c) => `\`${c.collection}\` (${c.effect})`).join(', ') || '—'
    } |`,
  );
  if (flow.controllers.length > 0)
    lines.push(`| Controllers | ${flow.controllers.map((c) => `\`${c}\``).join(', ')} |`);
  if (flow.services.length > 0)
    lines.push(`| Services | ${flow.services.map((c) => `\`${c}\``).join(', ')} |`);
  if (flow.dtos.length > 0) lines.push(`| DTOs | ${flow.dtos.map((c) => `\`${c}\``).join(', ')} |`);
  if (flow.schemas.length > 0)
    lines.push(
      `| Schemas | ${flow.schemas.map((s) => `\`${s.model}\` → \`${s.collection}\``).join(', ')} |`,
    );
  if (flow.hooks.length > 0)
    lines.push(`| Hooks | ${flow.hooks.map((c) => `\`${c}\``).join(', ')} |`);
  lines.push('');

  lines.push('## Execution path');
  lines.push('');
  lines.push('```text');
  lines.push(renderFlowTree(flow));
  lines.push('```');
  lines.push('');

  if (flow.state.length > 0) {
    lines.push('## Frontend state involved');
    lines.push('');
    for (const state of flow.state) lines.push(`- \`${state}\``);
    lines.push('');
  }

  const requests = flow.steps.filter(
    (step) =>
      step.kind === 'api-call' &&
      (step.detail?.queryKeys?.length || step.detail?.payloadKeys?.length),
  );
  if (requests.length > 0) {
    lines.push('## What each request sends');
    lines.push('');
    lines.push('| Endpoint | Query | Body |');
    lines.push('| --- | --- | --- |');
    for (const step of requests) {
      const query = (step.detail?.queryKeys ?? []).map((k) => `\`${k}\``).join(', ') || '—';
      const body = (step.detail?.payloadKeys ?? []).map((k) => `\`${k}\``).join(', ') || '—';
      lines.push(`| \`${step.label}\` | ${query} | ${body} |`);
    }
    lines.push('');
  }

  if (flow.collections.length > 0) {
    lines.push('## Collections touched');
    lines.push('');
    lines.push('| Collection | What happens | Operations |');
    lines.push('| --- | --- | --- |');
    for (const entry of flow.collections) {
      lines.push(
        `| \`${entry.collection}\` | ${DB_EFFECT_LABEL[entry.effect]} | ${entry.operations
          .map((operation) => `\`${operation}()\``)
          .join(', ')} |`,
      );
    }
    lines.push('');
    const unknown = flow.collections.filter((entry) => entry.effect === 'write');
    if (unknown.length > 0) {
      lines.push(
        `Rows marked "written to" use \`${unknown[0]?.operations.join('`/`')}\`, whose effect ` +
          'depends on runtime state — they may insert or update.',
      );
      lines.push('');
    }
  }

  const lineage = renderLineage(graph, flow);
  if (lineage) {
    lines.push('## Data lineage');
    lines.push('');
    lines.push('```text');
    lines.push(lineage);
    lines.push('```');
    lines.push('');
  }

  const timings = renderTimings(flow);
  if (timings) {
    lines.push('## Timing');
    lines.push('');
    lines.push('```text');
    lines.push(timings);
    lines.push('```');
    lines.push('');
  }

  lines.push('## Risk assessment');
  lines.push('');
  if (flow.risk.reasons.length === 0) {
    lines.push('- No risk factors detected.');
  } else {
    for (const reason of flow.risk.reasons) lines.push(`- ${reason}`);
  }
  lines.push('');

  const shared = renderSharedUsage(graph, flow);
  if (shared.length > 0) {
    lines.push('## Who else uses this code?');
    lines.push('');
    lines.push('| Shared symbol | Also used by |');
    lines.push('|---|---|');
    for (const row of shared) {
      lines.push(`| \`${row.label}\` | ${row.others.map((o) => `\`${o}\``).join(', ')} |`);
    }
    lines.push('');
    lines.push('Changing any of these affects more than this feature.');
    lines.push('');
  }

  lines.push('## What could break if this changes?');
  lines.push('');
  // Split by effect: "writes 4 collections" and "deletes from 1" deserve
  // different amounts of attention from a reviewer.
  for (const effect of DB_EFFECT_ORDER) {
    if (effect === 'read') continue;
    const targets = flow.collections.filter((c) => c.effect === effect);
    if (targets.length === 0) continue;
    const named = targets.map((c) => `\`${c.collection}\` (${c.operations.join(', ')})`).join(', ');
    lines.push(
      `- Data ${DB_EFFECT_LABEL[effect as DbEffect]}: ${named}. ` +
        'Any consumer of these fields is downstream of this feature.',
    );
  }
  for (const endpoint of flow.endpoints) {
    lines.push(`- \`${endpoint}\` is part of the frontend/backend contract for this feature.`);
  }
  if (flow.risk.level === 'high') {
    lines.push('- Marked **high risk**: review the risk factors above before changing it.');
  }
  lines.push('');

  return lines.join('\n');
}

/** state -> payload -> dto -> collection, one line per field. */
function renderLineage(graph: FlowGraph, flow: FeatureFlow): string | undefined {
  const apiCalls = flow.steps.filter((step) => step.kind === 'api-call');
  const chains: string[] = [];

  for (const call of apiCalls) {
    for (const field of graph.successors(call.nodeId, ['defines'])) {
      if (field.kind !== 'field') continue;
      const upstream = graph.predecessors(field.id, ['flows-to']);
      const chain: string[] = [];
      for (const source of upstream) {
        const owner = source.meta?.['component'] ?? source.meta?.['owner'];
        chain.push(owner ? `${owner}.${source.label}` : source.label);
      }
      chain.push(`payload.${field.label}`);

      let cursor = field.id;
      const seen = new Set<string>([cursor]);
      for (;;) {
        const next = graph.successors(cursor, ['flows-to']).find((node) => !seen.has(node.id));
        if (!next) break;
        seen.add(next.id);
        const owner = next.meta?.['owner'];
        chain.push(owner ? `${owner}.${next.label}` : next.label);
        cursor = next.id;
      }

      if (chain.length > 1) chains.push(chain.join('  →  '));
    }
  }

  return chains.length > 0 ? [...new Set(chains)].sort().join('\n') : undefined;
}

/** Methods in this flow that other features also depend on. */
function renderSharedUsage(
  graph: FlowGraph,
  flow: FeatureFlow,
): Array<{ label: string; others: string[] }> {
  const rows: Array<{ label: string; others: string[] }> = [];

  for (const step of flow.steps) {
    if (step.kind !== 'method' && step.kind !== 'route') continue;
    const impact = analyzeImpact(graph, step.nodeId);
    if (!impact) continue;
    const others = impact.affectedFlows.filter((other) => other.id !== flow.id).map((o) => o.label);
    if (others.length > 0) {
      rows.push({ label: step.label, others: [...new Set(others)].sort() });
    }
  }

  return rows.sort((a, b) => b.others.length - a.others.length).slice(0, 15);
}
