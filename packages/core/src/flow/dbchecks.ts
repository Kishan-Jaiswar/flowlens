import type { FlowGraph } from '../graph/graph.js';
import type { CollectionIndex } from '../analyzer/driver.js';
import type { DatabaseCollection, DeleteEffect, SlowQuery } from './database.js';
import type { ProjectFindings } from './findings.js';
import type { FeatureFlow } from './resolve.js';

/**
 * The checks a reader cannot do by looking: a query that forgets the owner
 * (`flowlens findings`' tenant check), a delete that leaves records pointing at
 * nothing, a lookup no index serves, a field nothing fills or reads. Read from
 * what the report already holds — the fields every query filters by and the
 * actions that reach each collection — so the source is not read again.
 */
export function addDatabaseChecks(
  collections: DatabaseCollection[],
  flows: readonly FeatureFlow[],
  findings: ProjectFindings,
  /** A scanned file's text, for the reads the field tracker cannot follow. */
  textOf: (file: string) => string,
): void {
  const filtersOf = new Map<string, Set<string>>();
  const add = (map: Map<string, Set<string>>, id: string, name: string) =>
    map.set(id, (map.get(id) ?? new Set()).add(name));
  for (const collection of collections)
    for (const field of collection.fields)
      for (const lookup of field.lookups) {
        add(filtersOf, lookup.nodeId, field.name);
        for (const other of lookup.alsoIn) add(filtersOf, other.nodeId, field.name);
      }

  // The tenant check is `flowlens findings`' own: shown here on the collection it is about.
  const opById = new Map(
    collections.flatMap((collection) =>
      collection.operations.map((op) => [op.nodeId, { collection, op }] as const),
    ),
  );
  for (const finding of findings.findings) {
    if (finding.kind !== 'tenant-scope') continue;
    for (const nodeId of finding.nodeIds) {
      const found = opById.get(nodeId);
      if (!found) continue;
      const { collection, op } = found;
      (collection.unscoped ??= []).push({
        label: op.label,
        effect: op.effect,
        ...(op.method ? { method: op.method } : {}),
        ...(op.source ? { source: op.source } : {}),
        runBy: op.runBy,
        filters: [...(filtersOf.get(op.nodeId) ?? [])].sort(),
        severity: finding.severity,
        why: finding.why,
        fix: finding.fix,
      });
    }
  }

  const flowById = new Map(flows.map((flow) => [flow.id, flow]));
  for (const collection of collections) {
    const onDelete = deleteEffects(collection, flowById);
    if (onDelete.length) collection.onDelete = onDelete;

    if (collection.database !== 'prisma') {
      const known =
        (collection.indexes?.length ?? 0) > 0 ||
        collection.fields.some((field) => field.indexed || field.unique);
      collection.indexesKnown = known;
      if (known) {
        const slow = slowQueries(collection, filtersOf);
        if (slow.length) collection.slowQueries = slow;
      }
    }

    // A query on another collection that `$lookup`s this one reads its fields too.
    const joiners = collections.flatMap((other) =>
      other.operations.filter((op) => op.joins?.includes(collection.name) && op.source),
    );
    markUnused(
      collection,
      textOf,
      joiners.map((op) => op.source!.file),
    );
  }
}

/**
 * For each collection holding this one's id: does the action that deletes a
 * record here also delete (or update) the records there, or leave them behind?
 */
function deleteEffects(
  collection: DatabaseCollection,
  flowById: Map<string, FeatureFlow>,
): DeleteEffect[] {
  const deleting = collection.usedBy.filter((use) => use.effects.includes('delete'));
  if (deleting.length === 0) return [];
  const effects: DeleteEffect[] = [];
  const seen = new Set<string>();
  for (const relation of collection.referencedBy) {
    const key = `${relation.from}.${relation.field}`;
    if (seen.has(key) || relation.from === collection.name) continue;
    seen.add(key);
    const did = deleting.map((use) => {
      const there = (flowById.get(use.flowId)?.collections ?? []).filter(
        (entry) => entry.collection === relation.from,
      );
      if (there.some((entry) => entry.effect === 'delete')) return 'deleted' as const;
      // Creating a record there (a history row) does nothing for the ones that point here.
      if (there.some((entry) => entry.effect === 'update' || entry.effect === 'write'))
        return 'changed' as const;
      return 'kept' as const;
    });
    const outcome = did.includes('kept')
      ? 'kept'
      : did.every((d) => d === 'deleted')
        ? 'deleted'
        : 'changed';
    effects.push({
      from: relation.from,
      field: relation.field,
      outcome,
      actions: deleting.map((use) => ({ flowId: use.flowId, title: use.title })),
    });
  }
  return effects;
}

/**
 * Lookups whose filter starts with no indexed key.
 *
 * MongoDB uses a compound index only from its first key, so a field counts as
 * indexed when some index leads with it (or `_id`, which is always indexed). A
 * query with no filter at all reads everything on purpose and is left alone.
 */
function slowQueries(
  collection: DatabaseCollection,
  filtersOf: Map<string, Set<string>>,
): SlowQuery[] {
  const leading = new Set([
    '_id',
    ...(collection.indexes ?? []).map((index: CollectionIndex) => index.keys[0]![0]),
    ...collection.fields.filter((f) => f.indexed || f.unique).map((f) => f.name),
  ]);
  const slow: SlowQuery[] = [];
  for (const op of collection.operations) {
    if (op.effect === 'create') continue;
    const filters = [...(filtersOf.get(op.nodeId) ?? [])];
    if (filters.length === 0 || filters.some((name) => leading.has(name))) continue;
    const searched = filters.every((name) =>
      collection.fields
        .find((field) => field.name === name)
        ?.lookups.some((lookup) => lookup.nodeId === op.nodeId && lookup.match === 'search'),
    );
    slow.push({
      label: op.label,
      ...(op.method ? { method: op.method } : {}),
      ...(op.source ? { source: op.source } : {}),
      fields: filters.sort(),
      reason: searched ? 'text-search' : 'no-index',
    });
  }
  return slow;
}

/** A field nothing in the app fills, or one it saves but never reads back. Cleanup candidates. */
function markUnused(
  collection: DatabaseCollection,
  textOf: (file: string) => string,
  joinedIn: string[] = [],
): void {
  /**
   * The files that load this collection's records: a record read in a helper
   * (`template.sms_content` after a `findOne`) is read, whatever the field
   * tracker followed. Loose on purpose — a field wrongly called unused is
   * deleted by somebody; one wrongly called used only goes unmentioned.
   */
  const readers = [
    ...new Set([
      ...collection.operations
        .filter((op) => op.effect === 'read' && op.source)
        .map((op) => op.source!.file),
      ...joinedIn,
    ]),
  ]
    .map(textOf)
    .join('\n');
  const writesCode = collection.operations.some((op) => op.effect !== 'read');
  // An upsert that creates the record copies its filter's equality keys into it.
  const upserts = new Set(collection.operations.filter((op) => op.upsert).map((op) => op.nodeId));
  for (const field of collection.fields) {
    // An item inside a list or an object is written with its parent; `_id` by the database.
    if (field.name === '_id' || /[.[]/.test(field.name)) continue;
    const filled =
      field.defaultValue !== undefined ||
      field.writes.some((write) => write.how !== '$unset') ||
      field.enteredIn.length > 0 ||
      field.mentions.some((mention) => mention.kind === 'sets') ||
      field.lookups.some((lookup) => upserts.has(lookup.nodeId) && lookup.match !== 'search');
    const read =
      field.lookups.length > 0 ||
      field.sorts.length > 0 ||
      field.projected.length > 0 ||
      readsKey(readers, field.name) ||
      field.shownIn.length > 0 ||
      field.apis.some((api) =>
        api.uses.some((use) => use.does !== 'saves' && use.does !== 'loads'),
      ) ||
      collection.fields.some((other) =>
        other.writes.some((w) => w.derivedFrom?.includes(field.name)),
      );
    // A timestamp kept for the record's history is the normal case, not a leftover.
    const stamp =
      /^(created|updated|modified|last_?modified)_?(at|on|date|time)$/i.test(field.name) ||
      (field.writes.length > 0 && field.writes.every((write) => write.from === 'time'));
    if (!filled && writesCode && field.origin === 'declared') field.unused = 'never-written';
    else if (filled && !read && !stamp) field.unused = 'never-read';
  }
}

// ---------------------------------------------------------------------------
// What a change does to the database, for `flowlens diff`
// ---------------------------------------------------------------------------

export interface DatabaseChanges {
  collections: { added: string[]; removed: string[] };
  /** `medicines.batchNumber` */
  fields: { added: string[]; removed: string[] };
  /** `medicines: ownerId 1, name 1 (unique)` */
  indexes: { added: string[]; removed: string[] };
  /** `movements.medicineId → medicines` */
  links: { added: string[]; removed: string[] };
}

/** Collections, declared fields, indexes and links, before and after: read from the graphs alone. */
export function databaseChanges(base: FlowGraph, head: FlowGraph): DatabaseChanges {
  const before = schemaOf(base);
  const after = schemaOf(head);
  const diff = (key: keyof typeof before) => ({
    added: [...after[key]].filter((item) => !before[key].has(item)).sort(),
    removed: [...before[key]].filter((item) => !after[key].has(item)).sort(),
  });
  return {
    collections: diff('collections'),
    fields: diff('fields'),
    indexes: diff('indexes'),
    links: diff('links'),
  };
}

export function hasDatabaseChanges(changes: DatabaseChanges): boolean {
  return Object.values(changes).some((part) => part.added.length > 0 || part.removed.length > 0);
}

function schemaOf(graph: FlowGraph) {
  const collections = new Set<string>();
  const fields = new Set<string>();
  const indexes = new Set<string>();
  for (const node of graph.nodesOfKind('collection')) {
    collections.add(node.label);
    for (const model of graph.predecessors(node.id, ['defines'])) {
      if (model.kind !== 'model') continue;
      for (const field of graph.successors(model.id, ['defines']))
        if (field.kind === 'field') fields.add(`${node.label}.${field.label}`);
    }
    for (const index of (node.meta?.['indexes'] as CollectionIndex[] | undefined) ?? [])
      indexes.add(
        `${node.label}: ${index.keys.map(([key, kind]) => `${key} ${kind}`).join(', ')}${
          index.unique ? ' (unique)' : ''
        }${index.ttlSeconds !== undefined ? ` (expires after ${index.ttlSeconds}s)` : ''}`,
      );
  }
  const links = new Set(
    graph
      .allEdges()
      .filter((edge) => edge.kind === 'references')
      .map(
        (edge) =>
          `${String(edge.meta?.['from'])}.${String(edge.meta?.['field'])} → ${String(edge.meta?.['to'])}`,
      ),
  );
  return { collections, fields, indexes, links };
}

/**
 * `record.key`, `record?.key`, `record["key"]`, or the key named in a string —
 * `populate('permission_id')`, `localField: 'role_id'`, `'$disease_category'` —
 * somewhere in `text`.
 */
function readsKey(text: string, key: string): boolean {
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // A quoted path may carry an alias in front: `'rolePermissions.permission_id'`, `'$material.name'`.
  return new RegExp(
    `\\.${escaped}\\b|['"\`]\\$?(?:[\\w$]+\\.)*${escaped}(?:\\.[\\w.]+)?['"\`]`,
  ).test(text);
}
