import { writeFileSync } from 'node:fs';
import {
  DB_EFFECT_LABEL,
  databaseReport,
  relationIsDeclared,
  resolveFlows,
  type DatabaseCollection,
  type DatabaseRelation,
  type DatabaseReport,
  type DeclaredRelation,
} from '@flowslens/core';
import { graphPath, loadGraph } from '../paths.js';
import { color, heading, table } from '../ui.js';

export interface DbArgs {
  root: string;
  graph?: string;
  json?: boolean;
  /** One collection to show in full; every collection when absent. */
  collection?: string;
  /** Links declared in `flowlens.config.json`. */
  relations?: DeclaredRelation[];
  /** The whole database as a Markdown document, with a diagram of its links. */
  markdown?: boolean;
  out?: string;
}

/**
 * `flowlens db [collection]` — the database as the code sees it.
 *
 * Read from the scanned graph: no connection to a database is made, so fields
 * are what the schemas declare or the queries use, never sampled documents.
 */
export function runDb(args: DbArgs): number {
  const graph = loadGraph(graphPath(args.root, args.graph));
  const report = databaseReport(graph, resolveFlows(graph, { includeLocalOnly: true }), {
    ...(args.relations ? { relations: args.relations } : {}),
  });

  if (args.markdown || args.out) {
    const document = renderDatabaseMarkdown(report);
    if (args.out) {
      writeFileSync(args.out, document, 'utf8');
      process.stdout.write(`${color.green('written')} ${args.out}\n`);
    } else process.stdout.write(document);
    return 0;
  }

  if (args.collection) {
    const wanted = args.collection.toLowerCase();
    const found = report.collections.find(
      (entry) => entry.name.toLowerCase() === wanted || entry.model?.toLowerCase() === wanted,
    );
    if (!found) {
      process.stderr.write(
        `${color.red('error')} no collection or model named "${args.collection}". ` +
          `Known: ${report.collections.map((entry) => entry.name).join(', ') || 'none'}\n`,
      );
      return 1;
    }
    process.stdout.write(
      args.json ? `${JSON.stringify(found, null, 2)}\n` : renderCollection(found),
    );
    return 0;
  }

  process.stdout.write(args.json ? `${JSON.stringify(report, null, 2)}\n` : renderDatabase(report));
  return 0;
}

export function renderDatabase(report: DatabaseReport): string {
  if (report.collections.length === 0) {
    return color.gray('No collections found: no Mongoose or Prisma model, and no query.\n');
  }
  const { totals } = report;
  return [
    '',
    color.bold(
      `${totals.collections} collections · ${totals.models} models · ` +
        `${totals.operations} database operations · ${totals.relations} links`,
    ),
    '',
    table(
      report.collections.map((entry) => [
        entry.name,
        entry.model ?? '',
        (entry.databases ?? []).map((db) => db.value ?? db.name).join(', '),
        String(entry.fields.length),
        String(entry.operations.filter((op) => op.effect === 'read').length),
        String(entry.operations.filter((op) => op.effect !== 'read').length),
        String(entry.usedBy.length),
        entry.notes.length ? color.yellow(entry.notes[0]!) : '',
      ]),
      ['Collection', 'Model', 'Database', 'Fields', 'Reads', 'Writes', 'Actions', 'Note'],
    ),
    '',
    color.gray('  flowlens db <collection> for its fields, code and the actions that reach it'),
    '',
  ].join('\n');
}

export function renderCollection(entry: DatabaseCollection): string {
  const out = [
    '',
    color.bold(entry.name) +
      color.gray(
        [
          entry.model && ` ${entry.typed ? 'type' : 'model'} ${entry.model}`,
          entry.databases?.length &&
            ` in ${entry.databases.map((db) => db.value ?? `${db.name}${db.env ? ' (env)' : ''}`).join(', ')}`,
          entry.source && ` ${entry.source.file}:${entry.source.line}`,
        ]
          .filter(Boolean)
          .join(' ·'),
      ),
    '',
  ];
  if (entry.notes.length) out.push(...entry.notes.map((note) => color.yellow(`  ! ${note}`)), '');

  if (entry.fields.length) {
    out.push(heading('Fields'));
    out.push(
      table(
        entry.fields.map((field) => [
          field.name,
          field.type ?? '',
          [
            field.required && 'required',
            field.unique ? 'unique' : field.indexed && 'indexed',
            field.expiresAfterSeconds !== undefined && `TTL ${field.expiresAfterSeconds}s`,
          ]
            .filter(Boolean)
            .join(', '),
          field.ref ? `→ ${field.ref}` : '',
          field.origin === 'declared' ? 'schema' : color.yellow('a query only'),
        ]),
        ['Field', 'Type', 'Rules', 'Links to', 'Seen in'],
      ),
      '',
    );
  }
  if (entry.indexes?.length) {
    out.push(heading('Indexes'));
    out.push(
      table(
        entry.indexes.map((index) => [
          index.keys.map(([key, kind]) => `${key} ${kind}`).join(', '),
          [
            index.unique && 'unique',
            index.ttlSeconds !== undefined && `TTL ${index.ttlSeconds}s`,
            index.sparse && 'sparse',
            index.name,
            ...(index.options ?? []),
          ]
            .filter(Boolean)
            .join(', '),
          `${index.source.file}:${index.source.line}`,
        ]),
        ['Keys', 'Options', 'Where'],
      ),
      '',
    );
  }
  if (entry.usedBy.length) {
    out.push(heading('User actions that reach it'));
    out.push(
      table(
        entry.usedBy.map((use) => [
          use.title,
          use.effects.map((effect) => DB_EFFECT_LABEL[effect]).join(', '),
          use.operations.join(', '),
          use.flowId,
        ]),
        ['Action', 'Does', 'Operations', 'Id'],
      ),
      '',
    );
  }
  if (entry.operations.length) {
    out.push(heading('Code that touches it'));
    out.push(
      table(
        entry.operations.map((op) => [
          op.label,
          op.effect,
          op.method ?? '',
          op.databaseName?.name ?? '',
          op.source ? `${op.source.file}:${op.source.line}` : '',
        ]),
        ['Operation', 'Effect', 'Method', 'Database', 'Where'],
      ),
      '',
    );
  }
  const links = (relations: DatabaseRelation[], arrow: (r: DatabaseRelation) => string) =>
    relations.map((r) => [
      arrow(r),
      r.many ? 'many' : 'one',
      r.via === 'query'
        ? 'a query looks it up'
        : r.via === 'config'
          ? 'declared in flowlens.config.json'
          : relationIsDeclared(r.via)
            ? r.via
            : color.yellow('guessed from the name'),
    ]);
  const checks = checksOf(entry);
  if (checks.length) {
    out.push(heading('Worth a look'), ...checks.map((line) => color.yellow(`  ! ${line}`)), '');
  }
  const rows = [
    ...links(entry.references, (r) => `${r.field} → ${r.to}`),
    ...links(entry.referencedBy, (r) => `${r.from}.${r.field} → here`),
  ];
  if (rows.length) {
    out.push(heading('Links'), table(rows, ['Link', 'Holds', 'Known from']), '');
  }
  return out.join('\n');
}

/** The checks on one collection, one line each: owner filter, deletes, indexes, unused fields. */
function checksOf(entry: DatabaseCollection): string[] {
  const where = (source?: { file: string; line: number }) =>
    source ? ` (${source.file}:${source.line})` : '';
  return [
    ...(entry.unscoped ?? []).map(
      (q) =>
        `[${q.severity}] ${q.label}${q.method ? ` in ${q.method}` : ''} does not filter by the owner${where(q.source)}`,
    ),
    ...(entry.onDelete ?? [])
      .filter((d) => d.outcome === 'kept')
      .map(
        (d) =>
          `deleting a record leaves ${d.from} records pointing at nothing (${d.from}.${d.field})`,
      ),
    ...(entry.slowQueries ?? []).map(
      (q) =>
        `${q.label}${q.method ? ` in ${q.method}` : ''} looks up by ${q.fields.join(', ')} with no index${
          q.reason === 'text-search' ? ' (a text search matches part of a value)' : ''
        }${where(q.source)}`,
    ),
    ...entry.fields
      .filter((f) => f.unused)
      .map((f) =>
        f.unused === 'never-written'
          ? `${f.name}: nothing in this app fills it`
          : `${f.name}: saved but never read back`,
      ),
  ];
}

const LIFECYCLE: Array<[string, string]> = [
  ['create', 'Added by'],
  ['update', 'Changed by'],
  ['delete', 'Removed by'],
  ['read', 'Read by'],
];

/** Pipes and line breaks would end a Markdown table cell. */
const cell = (text: string) => text.replace(/\|/g, '\\|').replace(/\n/g, ' ');

/** Mermaid ids must be plain words. */
const nodeId = (name: string) => name.replace(/[^A-Za-z0-9_]/g, '_');

/**
 * The database as a document: what each collection holds, who adds, changes,
 * removes and reads its records, how the collections link (a Mermaid diagram,
 * which GitHub draws), and what is worth a look.
 */
export function renderDatabaseMarkdown(report: DatabaseReport): string {
  const out = [
    '# Database',
    '',
    `${report.totals.collections} collections · ${report.totals.operations} queries · ${report.totals.relations} links. ` +
      'Read from the code by Flowslens — no connection to a real database.',
    '',
  ];
  const relations = [
    ...new Map(
      report.collections
        .flatMap((c) => c.references)
        .map((r) => [`${r.from}.${r.field}>${r.to}`, r] as const),
    ).values(),
  ];
  if (relations.length) {
    out.push('## How the collections connect', '', '```mermaid', 'flowchart LR');
    for (const c of report.collections) out.push(`  ${nodeId(c.name)}["${c.name}"]`);
    for (const r of relations)
      out.push(
        `  ${nodeId(r.from)} ${relationIsDeclared(r.via) ? '-->' : '-.->'}|${r.field}| ${nodeId(r.to)}`,
      );
    out.push(
      '```',
      '',
      'A dotted arrow is guessed from a field name; a solid one is stated in the code.',
      '',
    );
  }
  const problems = report.collections.flatMap((c) =>
    checksOf(c).map((line) => `- **${c.name}**: ${line}`),
  );
  if (problems.length) out.push('## Worth a look', '', ...problems, '');

  for (const c of report.collections) {
    out.push(
      `## ${c.name}`,
      '',
      `${c.fields.length} fields${c.databases?.length ? ` · database ${c.databases.map((db) => `\`${db.value ?? db.name}\``).join(', ')}` : ''}${
        c.model ? ` · ${c.typed ? 'type' : 'model'} \`${c.model}\`` : ''
      }`,
      '',
    );
    for (const [effect, label] of LIFECYCLE) {
      const titles = [
        ...new Set(
          c.usedBy
            .filter((u) =>
              u.effects.some((e) => e === effect || (effect === 'update' && e === 'write')),
            )
            .map((u) => u.title.replace(/\s*\([^)]*\)\s*$/, '')),
        ),
      ];
      if (titles.length) out.push(`- **${label}:** ${titles.join(', ')}`);
    }
    out.push('');
    if (c.references.length || c.referencedBy.length) {
      for (const r of c.references) out.push(`- \`${r.field}\` → **${r.to}**`);
      for (const r of c.referencedBy) out.push(`- **${r.from}**.\`${r.field}\` → here`);
      out.push('');
    }
    if (c.fields.length) {
      out.push('| Field | Type | Rules | On screen |', '| --- | --- | --- | --- |');
      for (const f of c.fields) {
        const labels = [
          ...new Set(
            [
              ...f.enteredIn.filter((e) => e.kind === 'form').map((e) => e.label ?? e.key),
              ...f.shownIn.map((x) => x.label ?? ''),
            ].filter((name) => name && name !== f.name),
          ),
        ];
        const rules = [
          f.required && 'required',
          f.unique ? 'unique' : f.indexed && 'indexed',
          f.expiresAfterSeconds !== undefined && `expires after ${f.expiresAfterSeconds}s`,
          f.ref && `links to ${f.ref}`,
        ].filter(Boolean);
        out.push(
          `| \`${cell(f.name)}\` | ${cell(f.type ?? '')} | ${cell(rules.join(', '))} | ${cell(labels.join(', '))} |`,
        );
      }
      out.push('');
    }
  }
  return `${out.join('\n')}\n`;
}
