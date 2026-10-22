import {
  Node,
  SyntaxKind,
  type ArrayLiteralExpression,
  type CallExpression,
  type NewExpression,
  type ObjectLiteralExpression,
  type PropertyAccessExpression,
  type SourceFile,
} from 'ts-morph';
import type { FlowGraph } from '../graph/graph.js';
import type { FlowNode, SourceRef } from '../graph/types.js';
import { DB_EFFECT_ORDER, type DbEffect } from '../analyzer/mongo.js';
import type { CollectionIndex, DatabaseName } from '../analyzer/driver.js';
import { addDatabaseChecks } from './dbchecks.js';
import { projectFindings, type ProjectFindings } from './findings.js';
import { formFieldsOf, labelText, type FormField } from './action.js';
import {
  attribute,
  condense,
  localVariable,
  nameOf,
  nearestFunction,
  readSchema,
  SourceReader,
} from './actionsource.js';
import { locateQueryCall, ROLES } from './queries.js';
import { phrase, render, simplify, type Literal, type Terms } from './conditionwords.js';
import { loadedFrom } from '../analyzer/ast.js';
import {
  conditionsAround,
  pathHops,
  routesRunning,
  scenariosOf,
  type QueueHop,
  type Scenario,
} from './scenarios.js';
import type { FeatureFlow } from './resolve.js';

/**
 * The database as the code sees it: every collection, what is declared in its
 * schema, which code reads and writes it, which user actions reach it, and how
 * it links to the others.
 *
 * Read from the graph only. Flowslens never connects to a database, so a field
 * here is either declared in a schema or seen in a query — never sampled from
 * a real document — and the report says which.
 */

export interface DatabaseField {
  name: string;
  type?: string;
  required?: boolean;
  unique?: boolean;
  /** What the schema fills it with when the code leaves it out: `Date.now`. */
  defaultValue?: string;
  /** The only values the schema allows (`enum`): `['male', 'female']`. */
  enumValues?: string[];
  /** `index: true`, implied by `unique`, or the first key of a driver `createIndex`. */
  indexed?: boolean;
  /** A TTL index on it: the record is deleted this many seconds after the date it holds. */
  expiresAfterSeconds?: number;
  /** The collection this field holds ids of, when it is a link. */
  ref?: string;
  /** `never-written`: nothing in this app fills it; `never-read`: saved, but nothing reads it back. */
  unused?: 'never-written' | 'never-read';
  /** `declared` in a schema, or only `queried` — used by code but not in the schema. */
  origin: 'declared' | 'queried';
  source?: SourceRef;
  /** Every place the code puts a value into this field: where its data comes from. */
  writes: FieldWrite[];
  /** Every query that looks records up by this field. */
  lookups: FieldLookup[];
  /** Every query that orders its results by this field. */
  sorts: FieldUseSite[];
  /** Every query that asks for it by name: `projection: { name: 1 }`. */
  projected: FieldUseSite[];
  /** The form inputs a user types its value into. */
  enteredIn: FieldEntry[];
  /** Where the frontend reads it back, in the screens that load this collection. */
  shownIn: FieldDisplay[];
  /** Every endpoint whose code touches the field, and what it does with it. */
  apis: FieldApi[];
  /** The validation schemas (zod, yup, joi) that check a value under this name. */
  validation: FieldValidation[];
  /** Other code that sets or names this key: an import parser, a column mapping, a default. */
  mentions: FieldMention[];
  /**
   * Functions that insert the field but, on their update path, leave it out:
   * calling them again with a new value does not change it.
   */
  onlyOnCreate: CreateOnly[];
  /** Functions that change the field on an existing record. */
  changedBy: FunctionEndpoints[];
  /** What happens to it in each of the collection's scenarios, in their order. */
  outcomes: ScenarioOutcome[];
}

/**
 * What one scenario does to one field. `keeps` on an update that leaves it out;
 * `ignored` is a `keeps` where the request did send a value for it.
 */
export interface ScenarioOutcome {
  scenario: string;
  /** `unread`: the scenario writes records whose keys the code does not show (`insertMany(rows)`). */
  does:
    | 'sets'
    | 'recalculated'
    | 'adds'
    | 'removes'
    | 'keeps'
    | 'ignored'
    | 'not-set'
    | 'removed'
    | 'unread'
    | 'list-changed'
    | 'stale'
    | 'nothing'
    | 'matched';
  /** For `list-changed`: the helpers that rebuild the list. For `stale`: the helper that recalculates it. */
  by?: string[];
  value?: string;
  from?: ValueOrigin;
  derivedIn?: string;
  source?: SourceRef;
  /** Set only on some runs, as code and in words. */
  onlyWhen?: string;
  onlyWhenWords?: string;
  /** More than one way the case writes it: a merged batch and a new one. */
  alternatives?: Array<
    Pick<ScenarioOutcome, 'does' | 'value' | 'from' | 'onlyWhen' | 'onlyWhenWords'>
  >;
}

export interface FunctionEndpoints {
  in: string;
  endpoints: string[];
}

export interface CreateOnly extends FunctionEndpoints {
  /**
   * Other writers that call it and find the existing record themselves:
   * `importReconcileMedicine` calls `upsertMedicine` only when nothing matches.
   */
  matchedFirstBy: FunctionEndpoints[];
}

export interface FieldValidation {
  schema: string;
  library: string;
  type?: string;
  required: boolean;
  /** Checks that can fail: `at least 2 characters`. */
  rules: string[];
  /** What the value is turned into: `trimmed`, `defaults to ""`. */
  transforms: string[];
  source: SourceRef;
}

/**
 * Code outside the database calls that sets or names the key, matched by name:
 * `genericName: cell(row, "genericName")` in an import parser, or a column
 * mapping `{ key: "genericName", aliases: [...] }`.
 */
export interface FieldMention {
  /** `sets` a property of that name, or `names` it as a string. */
  kind: 'sets' | 'names';
  code: string;
  in?: string;
  source: SourceRef;
}

/** How a filter matches the field: `search` is a text match (`$regex`, `RegExp`). */
export type LookupMatch = 'equals' | 'search' | 'one-of' | 'range' | 'exists' | 'not';

/**
 * One endpoint and what it does with a field. Found by walking back from each
 * query to the routes that run it, so an endpoint no screen calls is listed too.
 */
export interface FieldApi {
  /** `POST /medicines`. */
  endpoint: string;
  source?: SourceRef;
  uses: FieldApiUse[];
  /** The frontend calls to it; empty when no screen calls it. */
  calledFrom: SourceRef[];
}

export interface FieldApiUse {
  /**
   * `saves` it, `finds` records by it, `sorts` by it; `uses` it after loading
   * (the function names it), `returns` it (a GET sends the records back), or
   * only `loads` records that hold it without using it.
   */
  does: 'saves' | 'finds' | 'sorts' | 'uses' | 'returns' | 'loads';
  /** For `returns`: whether a screen that calls this API shows the field. */
  shown?: boolean;
  /** For `saves`: another writer this API goes through first. */
  via?: string;
  /** A background job this API's save waits for. */
  queued?: QueueHop;
  match?: LookupMatch;
  /** The function the query is in. */
  in?: string;
  /** For `saves`: the value written. */
  value?: string;
  how?: string;
  source?: SourceRef;
}

/** A form input whose value ends up in the field. */
export interface FieldEntry {
  /** A form input the user types into, or `code` that builds the value (an import parser). */
  kind: 'form' | 'code';
  /** The form's own key, which may differ from the field: `mrp` for `sellingPrice`. */
  key: string;
  /** For `code`: the line that builds it, `genericName: cell(row, "genericName")`. */
  code?: string;
  /** The words on screen: `MRP / unit (₹)`. */
  label?: string;
  /** Picked with buttons (`Increase / Decrease`), not typed. */
  picked?: true;
  /** The first action that reaches it; `actions` holds every one. */
  flowId: string;
  title: string;
  /** Every user action that leads to this input and saves it the same way. */
  actions: Array<{ flowId: string; title: string }>;
  source?: SourceRef;
  /** The request the form sends: `POST /medicines`. */
  endpoint?: string;
  /** The field this one is worked out from, when the input feeds that field first: `batches[].mrp`. */
  through?: string;
  /** The write it ends in: `upsertMedicine` storing `input.mrp`. */
  savedBy: {
    in?: string;
    value: string;
    how: string;
    source?: SourceRef;
    /** Another writer the request goes through first: `importReconcileMedicine`. */
    via?: string;
    /** A background job between the request and the save: it happens later, not during the request. */
    queued?: QueueHop;
    /** A helper that works the stored value out of what was sent: `syncFromBatches`. */
    derivedIn?: string;
    derivedFrom?: string[];
  };
}

/**
 * The frontend reading the field: `formatCurrency(m.sellingPrice)` under the
 * label `MRP`. Matched by name in the screens of actions that read the
 * collection, so a common name (`name`, `status`) can match another record's.
 */
export interface FieldDisplay {
  code: string;
  label?: string;
  source: SourceRef;
}

/**
 * Where a value comes from, in the words a reader needs:
 * `input` the caller passes it in (a request, a form), `fixed` a literal,
 * `time` the clock, `computed` worked out in the function before the write.
 */
export type ValueOrigin = 'input' | 'fixed' | 'time' | 'computed';

export interface FieldUseSite {
  /** The db-op this happens in. */
  nodeId: string;
  /** The value as written: `input.name`, `nowIso()`, `"processing"`. */
  value: string;
  /** `medicines.updateOne`. */
  operation: string;
  /** The function the query is in. */
  in?: string;
  source?: SourceRef;
  /** The user actions that run this query. */
  actions: Array<{ flowId: string; title: string }>;
}

export interface FieldWrite extends FieldUseSite {
  from: ValueOrigin;
  /** A helper that works the value out before the write: `syncFromBatches`. */
  derivedIn?: string;
  /** The fields that value is worked out from: `batches[].mrp`. */
  derivedFrom?: string[];
  /** For a list: the project helpers that rebuild it before the write (`addStockToBatches`). */
  rewrittenBy?: string[];
  /** The old value plus more: `batch.quantity + addQty`. */
  adds?: true;
  /** The old value less some: `b.quantity - take`. */
  takes?: true;
  /** The conditions it is set under, when only some runs of the write set it. */
  when?: Literal[];
  /** Those conditions as code, and in plain words: "the quantity is more than 0". */
  onlyWhen?: string;
  onlyWhenWords?: string;
  /** The key read off the caller's input: `mrp` in `sellingPrice: input.mrp`. */
  inputKey?: string;
  /** `insert` for a new record, else the update operator: `$set`, `$inc`, `$push` … */
  how: string;
}

export interface FieldLookup extends FieldUseSite {
  match?: LookupMatch;
  /** Where the condition is written: one filter used by a count and a find is one lookup. */
  builtAt?: SourceRef;
  /** Other queries that reuse the same condition. */
  alsoIn: Array<{ nodeId: string; operation: string; source?: SourceRef }>;
}

export interface DatabaseOperation {
  /** `customers.create`. */
  label: string;
  operation: string;
  effect: DbEffect;
  /** The method that runs it: `CustomersService.create`. */
  method?: string;
  source?: SourceRef;
  /** The database it runs in, when the code names one: `MONGODB_DB` (an env var) or `pharma`. */
  databaseName?: DatabaseName;
  /** An update with `upsert: true`: it creates the record when none matches. */
  upsert?: boolean;
  /** An update that hides the record instead of erasing it: `is_active: false`, `deleted_at`. */
  softDelete?: true;
  /** Other collections an aggregate pulls in with `$lookup`. */
  joins?: string[];
  /** The graph node, for matching it to the fields its filter and writes name. */
  nodeId: string;
  /**
   * What runs it: a user action, a background job (timer, queue, event), a check
   * on every request (login, guard, middleware), a live connection, an endpoint
   * no screen calls, a script run by hand, or nothing in the project (`unused`).
   */
  runBy: 'user' | 'job' | 'request' | 'socket' | 'endpoint' | 'script' | 'unused';
  /** Measured by runtime tracing, when the app has run with it. */
  timing?: { count: number; avgMs: number; maxMs: number };
}

export interface DatabaseUse {
  flowId: string;
  title: string;
  /** What the action does here, reads first: `['read', 'delete']`. */
  effects: DbEffect[];
  operations: string[];
}

export interface DatabaseRelation {
  /** Collection holding the id. */
  from: string;
  field: string;
  /** Collection the id points at. */
  to: string;
  /** `ref`, `prisma`, `lookup`, `populate` are stated by the code; `naming` is a guess. */
  via: string;
  many: boolean;
  source?: SourceRef;
}

export interface DatabaseCollection {
  name: string;
  /** The engine: `mongodb`, `prisma`. */
  database?: string;
  /** True when `model` is a TypeScript type (`db.collection<Medicine>()`), not a schema the database checks. */
  typed?: boolean;
  /** The databases the code opens it in; more than one when two share a collection name. */
  databases?: DatabaseName[];
  /** Indexes the code creates (`createIndex`), in the order written. */
  indexes?: CollectionIndex[];
  model?: string;
  /** The first sentence of the doc comment on its schema or type, when it has one. */
  description?: string;
  source?: SourceRef;
  fields: DatabaseField[];
  operations: DatabaseOperation[];
  /** User actions that reach this collection, one row per action. */
  usedBy: DatabaseUse[];
  /** Links where this collection holds the id. */
  references: DatabaseRelation[];
  /** Links where another collection holds this one's id. */
  referencedBy: DatabaseRelation[];
  /** Things worth a look, in plain words: never read, written from several places. */
  notes: string[];
  /** The fields queries look records up by, most used first. */
  lookupKeys: string[];
  /** Every case that writes it, read from the code's branches: each field says what happens to it in each. */
  scenarios: Scenario[];
  /** True when `scenarios` and `outcomes` were not worked out (`scenarios: false`). */
  casesLeftOut?: true;
  /** Queries that leave out the field the rest use to keep each owner's records apart. */
  unscoped?: UnscopedQuery[];
  /** What deleting a record does to the records in other collections that hold its id. */
  onDelete?: DeleteEffect[];
  /** Lookups no index the code creates can serve: they read the whole collection. */
  slowQueries?: SlowQuery[];
  /** False when the code creates no index here, so `slowQueries` could not be worked out. */
  indexesKnown?: boolean;
}

export interface UnscopedQuery {
  label: string;
  effect: DbEffect;
  method?: string;
  source?: SourceRef;
  runBy: DatabaseOperation['runBy'];
  /** What it filters by instead, when anything. */
  filters: string[];
  /** From `flowlens findings`: high when a client is shown to be able to aim it at another owner. */
  severity: 'high' | 'medium' | 'low';
  why: string;
  fix: string;
}

export interface DeleteEffect {
  /** The collection holding the deleted record's id. */
  from: string;
  field: string;
  /** `deleted`: removed too; `changed`: updated in the same action; `kept`: left pointing at nothing. */
  outcome: 'deleted' | 'changed' | 'kept';
  actions: Array<{ flowId: string; title: string }>;
}

export interface SlowQuery {
  label: string;
  method?: string;
  source?: SourceRef;
  fields: string[];
  /** `no-index`: nothing indexes what it filters by; `text-search`: it matches part of a value, which an index cannot. */
  reason: 'no-index' | 'text-search';
}

export interface DatabaseReport {
  collections: DatabaseCollection[];
  totals: { collections: number; models: number; operations: number; relations: number };
  /** The field most queries filter by to keep owners apart (`ownerId`, `tenantId`), when there is one. */
  tenantKey?: string;
}

/** Links the code itself states, as opposed to a guess from a field name. */
export function relationIsDeclared(via: string): boolean {
  return via !== 'naming';
}

export interface DatabaseReportOptions {
  reader?: SourceReader;
  /** Links the code cannot show, declared in `flowlens.config.json` under `relations`. */
  relations?: DeclaredRelation[];
  /** `projectFindings()` already worked out, for its tenant check; read again when absent. */
  findings?: ProjectFindings;
  /**
   * `false` leaves out each write's cases (`scenarios`, every field's `outcomes`):
   * the slowest and largest part, needed only once a collection is opened.
   * The collection then says `casesLeftOut: true`.
   */
  scenarios?: boolean;
  /** Only this collection, in full: the page a user opened. */
  only?: string;
}

/** `{ "from": "medicines", "field": "ownerId", "to": "clinics" }` */
export interface DeclaredRelation {
  from: string;
  field: string;
  to: string;
  many?: boolean;
}

export function databaseReport(
  graph: FlowGraph,
  flows: readonly FeatureFlow[],
  options: DatabaseReportOptions = {},
): DatabaseReport {
  const reader = options.reader ?? new SourceReader(graph);
  READ_FROM.clear();
  JOINED.length = 0;
  READER.current = reader;
  READER.graph = graph;
  CALLERS.methods = undefined;
  CALLERS.functions.clear();
  CALLERS.calls = new WeakMap();
  CALLERS.keys = new WeakMap();
  const frontend = new Frontend(graph, flows, reader);
  const project = new ProjectCode(graph, reader);
  const actionsOf = new Map<string, Array<{ flowId: string; title: string }>>();
  for (const flow of flows) {
    for (const step of flow.steps) {
      if (step.kind !== 'db-op') continue;
      const list = actionsOf.get(step.nodeId) ?? [];
      if (!list.some((entry) => entry.flowId === flow.id))
        list.push({ flowId: flow.id, title: flow.title });
      actionsOf.set(step.nodeId, list);
    }
  }

  const relations = graph
    .allEdges()
    .filter((edge) => edge.kind === 'references')
    .map((edge): DatabaseRelation => ({
      from: String(edge.meta?.['from']),
      field: String(edge.meta?.['field']),
      to: String(edge.meta?.['to']),
      via: String(edge.meta?.['via'] ?? 'naming'),
      many: edge.meta?.['many'] === true,
      ...(edge.meta?.['source'] ? { source: edge.meta['source'] as SourceRef } : {}),
    }));
  // Declared by the user: kept apart from what the code says (`via: 'config'`), and never a duplicate.
  for (const declared of options.relations ?? []) {
    if (!graph.node(`collection:${declared.from}`) || !graph.node(`collection:${declared.to}`))
      continue;
    if (
      relations.some(
        (r) => r.from === declared.from && r.field === declared.field && r.to === declared.to,
      )
    )
      continue;
    relations.push({
      from: declared.from,
      field: declared.field,
      to: declared.to,
      via: 'config',
      many: declared.many === true,
    });
  }

  const cases = options.scenarios !== false;
  const collections = graph
    .nodesOfKind('collection')
    .filter((node) => options.only === undefined || node.label === options.only)
    .map((node) =>
      collectionOf(graph, node, flows, relations, reader, actionsOf, frontend, project, cases),
    )
    .sort((a, b) => a.name.localeCompare(b.name));
  for (const { collection, name, lookup } of JOINED) {
    const target = collections.find((entry) => entry.name === collection);
    if (!target) continue;
    let field = target.fields.find((entry) => entry.name === name);
    if (!field) {
      field = { name, origin: 'queried', ...emptyUses() };
      target.fields.push(field);
    }
    field.lookups.push(lookup);
  }
  const findings = options.findings ?? projectFindings(graph, { reader });
  addDatabaseChecks(collections, flows, findings, (file) => reader.file(file)?.getFullText() ?? '');
  const tenantKey = findings.tenantKey;

  return {
    ...(tenantKey ? { tenantKey } : {}),
    collections,
    totals: {
      collections: collections.length,
      models: graph.nodesOfKind('model').length,
      operations: collections.reduce((sum, entry) => sum + entry.operations.length, 0),
      relations: relations.length,
    },
  };
}

function collectionOf(
  graph: FlowGraph,
  node: FlowNode,
  flows: readonly FeatureFlow[],
  relations: readonly DatabaseRelation[],
  reader: SourceReader,
  actionsOf: ReadonlyMap<string, Array<{ flowId: string; title: string }>>,
  frontend: Frontend,
  project: ProjectCode,
  cases = true,
): DatabaseCollection {
  const name = node.label;
  const models = graph.predecessors(node.id, ['defines']).filter((n) => n.kind === 'model');
  const model = models[0];
  const refTarget = (field: FlowNode): string | undefined =>
    graph.successors(field.id, ['references'])[0]?.label;

  const declared = models.flatMap((m) =>
    graph
      .successors(m.id, ['defines'])
      .filter((n) => n.kind === 'field')
      .map((field): DatabaseField => {
        const meta = field.meta ?? {};
        const ref = refTarget(field) ?? (typeof meta['ref'] === 'string' ? meta['ref'] : undefined);
        return {
          name: field.label,
          origin: 'declared',
          ...emptyUses(),
          ...(typeof meta['type'] === 'string' ? { type: meta['type'] } : {}),
          ...(meta['required'] === true ? { required: true } : {}),
          ...(meta['unique'] === true ? { unique: true } : {}),
          ...(meta['indexed'] === true || meta['unique'] === true ? { indexed: true } : {}),
          ...(Array.isArray(meta['enumValues'])
            ? { enumValues: meta['enumValues'] as string[] }
            : {}),
          ...(typeof meta['defaultValue'] === 'string'
            ? { defaultValue: meta['defaultValue'] }
            : {}),
          ...(ref ? { ref } : {}),
          ...(field.source ? { source: field.source } : {}),
        };
      }),
  );
  const known = new Set(declared.map((field) => field.name));
  const queried = graph
    .allNodes()
    .filter((n) => n.kind === 'field' && n.meta?.['fromQuery'] === true && n.meta['owner'] === name)
    .filter((field) => !known.has(field.label))
    .map((field): DatabaseField => {
      const ref = refTarget(field);
      return {
        name: field.label,
        origin: 'queried',
        ...emptyUses(),
        ...(ref ? { ref } : {}),
        ...(field.source ? { source: field.source } : {}),
      };
    });

  const ops = [
    ...graph.predecessors(node.id, ['reads']),
    ...graph.predecessors(node.id, ['writes']),
  ];
  const operations = [...new Map(ops.map((op) => [op.id, op])).values()]
    .map((op): DatabaseOperation => {
      const method = graph.predecessors(op.id, ['queries'])[0];
      return {
        label: op.label,
        operation: String(op.meta?.['operation'] ?? op.label),
        effect: (op.meta?.['effect'] as DbEffect | undefined) ?? 'write',
        ...(method ? { method: method.label } : {}),
        ...(op.source ? { source: op.source } : {}),
        ...(op.meta?.['databaseName']
          ? { databaseName: op.meta['databaseName'] as DatabaseName }
          : {}),
        ...(op.meta?.['upsert'] === true ? { upsert: true } : {}),
        ...(Array.isArray(op.meta?.['joins']) ? { joins: op.meta['joins'] as string[] } : {}),
        nodeId: op.id,
        runBy: actionsOf.get(op.id)?.length ? 'user' : runnerOf(graph, op.id),
        ...(op.timing
          ? {
              timing: {
                count: op.timing.count,
                avgMs: op.timing.avgMs,
                maxMs: op.timing.maxMs,
              },
            }
          : {}),
      };
    })
    .sort(
      (a, b) =>
        DB_EFFECT_ORDER.indexOf(a.effect) - DB_EFFECT_ORDER.indexOf(b.effect) ||
        a.label.localeCompare(b.label),
    );

  const fields = [...declared, ...queried];
  const fieldNamed = (fieldName: string): DatabaseField => {
    // A query writes `pharmacy_contacts.mobile_number` for the declared `pharmacy_contacts[].mobile_number`.
    let field =
      fields.find((entry) => entry.name === fieldName) ??
      fields.find(
        (entry) => entry.name.includes('[]') && entry.name.replaceAll('[]', '') === fieldName,
      );
    if (!field) {
      field = { name: fieldName, origin: 'queried', ...emptyUses() };
      fields.push(field);
    }
    return field;
  };
  const derivations: Derivation[] = [];
  for (const op of new Map(ops.map((entry) => [entry.id, entry])).values()) {
    let uses: QueryFieldUses | undefined;
    try {
      uses = fieldUsesOf(reader, op);
    } catch {
      // Unreadable source: the query is still listed under its collection, without fields.
    }
    if (!uses) continue;
    const site = {
      nodeId: op.id,
      operation: op.label,
      ...(uses.in ? { in: uses.in } : {}),
      ...(op.source ? { source: op.source } : {}),
      actions: actionsOf.get(op.id) ?? [],
    };
    for (const write of uses.writes) {
      const entry: FieldWrite = {
        ...site,
        value: write.value,
        from: write.from,
        how: write.how,
        ...(write.from === 'input' && write.key ? { inputKey: write.key } : {}),
        ...(write.derivedIn ? { derivedIn: write.derivedIn } : {}),
        ...(write.rewrittenBy ? { rewrittenBy: write.rewrittenBy } : {}),
        ...(write.adds ? { adds: true as const } : {}),
        ...(write.takes ? { takes: true as const } : {}),
        ...whenOf(write.when),
      };
      fieldNamed(write.name).writes.push(entry);
      if (write.derivedIn) derivations.push({ write: entry, key: write });
    }
    for (const lookup of uses.lookups) {
      const field = fieldNamed(lookup.name);
      const builtAt = lookup.node ? reader.point(lookup.node) : undefined;
      const same = builtAt
        ? field.lookups.find(
            (other) =>
              other.builtAt?.file === builtAt.file &&
              other.builtAt.line === builtAt.line &&
              other.in === site.in,
          )
        : undefined;
      if (same) {
        same.alsoIn.push({
          nodeId: op.id,
          operation: op.label,
          ...(op.source ? { source: op.source } : {}),
        });
        continue;
      }
      field.lookups.push({
        ...site,
        value: lookup.value,
        ...(lookup.match ? { match: lookup.match } : {}),
        ...(builtAt ? { builtAt } : {}),
        alsoIn: [],
      });
    }
    for (const sort of uses.sorts) fieldNamed(sort.name).sorts.push({ ...site, value: sort.value });
    // A `$lookup` pipeline's `$match` finds records of the collection it joins: credited there.
    for (const join of uses.joined ?? [])
      for (const key of join.lookups)
        JOINED.push({
          collection: join.collection,
          name: key.name,
          lookup: {
            ...site,
            value: key.value,
            ...(key.match ? { match: key.match } : {}),
            alsoIn: [],
          },
        });
    for (const read of uses.projected)
      fieldNamed(read.name).projected.push({ ...site, value: read.value });
  }
  resolveDerivations(fields, derivations);
  // A link declared in the config names the field the same way a schema `ref` does.
  for (const relation of relations)
    if (relation.from === name) {
      const field = fields.find((entry) => entry.name === relation.field);
      if (field && !field.ref) field.ref = relation.to;
    }
  for (const field of fields) field.enteredIn = entriesOf(graph, field, frontend);
  // The screens of actions that only load data (a page, a list, a search):
  // what they read comes back to be shown, unlike a save that reads on the way.
  const screens = [
    ...new Set(
      flows
        .filter(
          (flow) =>
            flow.collections.some((entry) => entry.collection === name) &&
            flow.collections.every((entry) => entry.effect === 'read'),
        )
        .flatMap((flow) => flow.steps)
        .filter((step) => FRONT_KINDS.has(step.kind) && step.file)
        .map((step) => step.file!),
    ),
  ];
  // Names on both the record and its items (`expiryDate` on a medicine and on each batch) say nothing about which one a receiver is.
  const topLeaves = new Set(fields.filter((f) => !f.name.includes('[]')).map((f) => f.name));
  const both = new Set(
    fields
      .filter((f) => f.name.includes('[]'))
      .map((f) => leafOf(f.name))
      .filter((leaf) => topLeaves.has(leaf)),
  );
  for (const field of fields) {
    // An item field is shown beside its siblings (`b.mrp`, `b.quantity`); a top-level one beside the others.
    const parent = field.name.includes('[]') ? field.name.split('[]')[0] : undefined;
    const siblings = fields
      .map((other) => other.name)
      .filter(
        (name) =>
          name !== field.name && (parent ? name.startsWith(`${parent}[].`) : !name.includes('[]')),
      )
      .map(leafOf)
      .filter((leaf) => !both.has(leaf));
    field.shownIn = frontend.shown(screens, leafOf(field.name), siblings, name);
  }
  // Reads that hand records back: `find*` always, an aggregate only when its pipeline names the field.
  const readOps: ReadOp[] = [];
  for (const op of new Map(ops.map((entry) => [entry.id, entry])).values()) {
    if (op.meta?.['effect'] !== 'read') continue;
    const operation = String(op.meta?.['operation'] ?? '');
    if (!/^find/.test(operation) && operation !== 'aggregate') continue;
    let call: Node | undefined;
    try {
      call = locateQueryCall(reader, op.source?.file, op.source?.line, operation);
    } catch {
      // Unreadable: an aggregate is left out rather than claimed; a find still loads records.
    }
    const fn = call && nearestFunction(call);
    readOps.push({
      op,
      aggregate: operation === 'aggregate' ? (call?.getText() ?? '') : undefined,
      fnText: fn?.getText() ?? '',
    });
  }
  // Every function that writes this collection: a request that reaches a write only through another of them goes via it.
  const writerFns = new Set(
    ops
      .filter((op) => op.meta?.['access'] === 'write')
      .flatMap((op) => graph.predecessors(op.id, ['queries']).map((n) => n.id)),
  );
  for (const field of fields) field.apis = apisOf(graph, field, readOps, frontend, writerFns);
  markUpdatePaths(graph, fields);
  const names = new Set(fields.map((field) => field.name));
  const scope = project.scopeFor(ops, names);
  for (const field of fields) Object.assign(field, project.about(field, scope));
  for (const field of fields)
    field.enteredIn.push(...codeEntriesOf(graph, field, frontend, writerFns));
  for (const field of fields) {
    const sources = new Set(field.writes.flatMap((write) => write.derivedFrom ?? []));
    const known = new Set(field.enteredIn.map(entryKey));
    for (const source of sources) {
      for (const entry of fields.find((other) => other.name === source)?.enteredIn ?? []) {
        const worked = field.writes.find((write) => write.derivedFrom?.includes(source));
        const inherited: FieldEntry = {
          ...entry,
          through: source,
          savedBy: {
            ...entry.savedBy,
            ...(worked?.derivedIn ? { derivedIn: worked.derivedIn } : {}),
            derivedFrom: [source],
          },
        };
        if (known.has(entryKey(inherited))) continue;
        known.add(entryKey(inherited));
        field.enteredIn.push(inherited);
      }
    }
  }
  const writeOps = [...new Map(ops.map((op) => [op.id, op])).values()].filter(
    (op) => op.meta?.['access'] === 'write',
  );
  const otherWrites = graph
    .nodesOfKind('db-op')
    .filter((op) => op.meta?.['access'] === 'write' && op.meta?.['collection'] !== name);
  let scenarios: Scenario[] = [];
  try {
    if (cases)
      scenarios = scenariosOf(graph, reader, writeOps, otherWrites, (endpoint) =>
        frontend.flowsCalling(endpoint).map((flow) => ({ flowId: flow.id, title: flow.title })),
      );
  } catch {
    // Unreadable branches: the field cards keep everything else.
  }
  const keyedWrites = new Set(fields.flatMap((field) => field.writes.map((write) => write.nodeId)));
  for (const field of fields)
    field.outcomes = cases ? outcomesOf(field, scenarios, keyedWrites, fields) : [];
  const lookupKeys = fields
    .filter((field) => field.lookups.length > 0)
    .sort((a, b) => b.lookups.length - a.lookups.length || a.name.localeCompare(b.name))
    .map((field) => field.name);

  // An upsert creates the record when none matches: an action that reaches one adds records too.
  const upserts = new Set(operations.filter((op) => op.upsert).map((op) => op.nodeId));
  /**
   * An update that only hides the record — `is_active: false`, `is_deleted: true`,
   * `deleted_at: new Date()` — removes it for every reader: it counts as removing.
   */
  const softDeletes = new Set(
    fields.flatMap((field) =>
      field.writes
        .filter((write) => isSoftDelete(field.name, write.value))
        .map((write) => write.nodeId),
    ),
  );
  for (const op of operations)
    if (op.effect === 'update' && softDeletes.has(op.nodeId)) op.softDelete = true;
  const usedBy = flows.flatMap((flow): DatabaseUse[] => {
    const access = flow.collections.filter((entry) => entry.collection === name);
    if (access.length === 0) return [];
    const adds = flow.steps.some((step) => upserts.has(step.nodeId));
    const hides = flow.steps.some((step) => softDeletes.has(step.nodeId));
    const effects: DbEffect[] = [
      ...access.map((entry) => entry.effect),
      ...(adds ? (['create'] as DbEffect[]) : []),
      ...(hides ? (['delete'] as DbEffect[]) : []),
    ];
    return [
      {
        flowId: flow.id,
        title: flow.title,
        effects: [...new Set(effects)].sort(
          (a, b) => DB_EFFECT_ORDER.indexOf(a) - DB_EFFECT_ORDER.indexOf(b),
        ),
        operations: [...new Set(access.flatMap((entry) => entry.operations))],
      },
    ];
  });

  const writers = new Set(
    operations
      .filter((op) => op.effect !== 'read' && op.method)
      .map((op) => op.method!.split('.')[0]),
  );
  const notes: string[] = [];
  if (operations.length === 0) notes.push('No code reads or writes it.');
  else if (!operations.some((op) => op.effect === 'read'))
    notes.push('Written but never read by this code.');
  if (writers.size > 1)
    notes.push(`Written from ${writers.size} places: ${[...writers].sort().join(', ')}.`);
  if (operations.length > 0 && usedBy.length === 0) notes.push('No user action reaches it.');
  const databases = node.meta?.['databases'] as DatabaseName[] | undefined;
  if (databases && databases.length > 1)
    notes.push(
      `A collection of this name is opened in ${databases.length} databases: ${databases.map((db) => db.value ?? db.name).join(', ')}. Each query says which.`,
    );
  const indexes = node.meta?.['indexes'] as CollectionIndex[] | undefined;
  for (const index of indexes ?? []) {
    const [first] = index.keys[0]!;
    const field = fieldNamed(first);
    field.indexed = true;
    if (index.keys.length === 1 && index.unique) field.unique = true;
    if (index.keys.length === 1 && index.ttlSeconds !== undefined)
      field.expiresAfterSeconds = index.ttlSeconds;
  }

  // An array's item fields right under it: `batches`, then `batches[].mrp`, `batches[].billNo`.
  const parentOf = (field: DatabaseField) => field.name.split('[]')[0]!;
  const order = new Map(fields.filter((f) => !f.name.includes('[]')).map((f, i) => [f.name, i]));
  fields.sort(
    (a, b) =>
      (order.get(parentOf(a)) ?? order.size) - (order.get(parentOf(b)) ?? order.size) ||
      Number(a.name.includes('[]')) - Number(b.name.includes('[]')),
  );

  return {
    name,
    ...(typeof node.meta?.['database'] === 'string' ? { database: node.meta['database'] } : {}),
    ...(databases?.length ? { databases } : {}),
    ...(indexes?.length ? { indexes } : {}),
    ...(model ? { model: model.label } : {}),
    ...(model?.meta?.['typed'] === true ? { typed: true } : {}),
    ...(model?.source ? { source: model.source } : {}),
    ...descriptionOf(reader, model?.source),
    fields,
    operations,
    usedBy,
    references: relations.filter((relation) => relation.from === name),
    referencedBy: relations.filter((relation) => relation.to === name),
    notes,
    lookupKeys,
    scenarios,
    ...(cases ? {} : { casesLeftOut: true as const }),
  };
}

// ---------------------------------------------------------------------------
// The fields one query names, read from its source
// ---------------------------------------------------------------------------

interface QueryFieldUses {
  in?: string;
  writes: Array<KeyValue & { how: string }>;
  lookups: KeyValue[];
  sorts: KeyValue[];
  projected: KeyValue[];
  /** `$match` inside a `$lookup`'s own pipeline: lookups on the collection it joins. */
  joined?: Array<{ collection: string; lookups: KeyValue[] }>;
}

interface KeyValue {
  name: string;
  value: string;
  from: ValueOrigin;
  /** The last name the value reads: `mrp` in `input.mrp`, `phone` in `phone`. */
  key?: string;
  match?: LookupMatch;
  /** Where the key is written, for lookups merged by condition. */
  node?: Node;
  /** The value itself, to open an array of records it holds. */
  valueNode?: Node;
  /** The function the value is written in, when it is not the query's own (a helper). */
  fnOf?: Node;
  /** The function the key is read in. */
  scope?: Node;
  derivedIn?: string;
  rewrittenBy?: string[];
  /** Names the helper's value reads, and names anywhere in the helper: matched to fields later. */
  derivedNames?: string[];
  helperNames?: string[];
  /** `batches[idx].quantity + addQty`: the old value plus more, not a new one. */
  adds?: true;
  /** `b.quantity - take`: the old value less some. */
  takes?: true;
  /** When only some runs of the write set it: `addQty > 0`, the stored dosage form is empty. */
  when?: Literal[];
  /** A condition inside `$or`/`$and`/`$nor`: one of several on the key, never replaced by a later one. */
  branch?: true;
}

/** Operators whose keys are field names: `{ $set: { status } }`. */
const UPDATE_OPERATORS =
  /^\$(set|setOnInsert|inc|mul|min|max|push|addToSet|pull|pullAll|unset|rename|currentDate)$/;

/**
 * Which fields one query writes and which it looks records up by.
 *
 * Read the way a reviewer would: the filter's keys, the update's `$set`/`$inc`
 * keys, an insert's document keys — following a variable or a spread back to
 * the object built in the same function (`insertOne({ ...movement })`).
 */
function fieldUsesOf(reader: SourceReader, op: FlowNode): QueryFieldUses | undefined {
  const operation = String(op.meta?.['operation'] ?? '');
  const call =
    locateQueryCall(reader, op.source?.file, op.source?.line, operation) ??
    (operation === 'save' ? saveOfNew(reader, op.source?.file, op.source?.line) : undefined);
  const fn = call && nearestFunction(call);
  if (!call || !fn) return undefined;
  const uses: QueryFieldUses = {
    in: nameOf(fn),
    writes: [],
    lookups: [],
    sorts: [],
    projected: [],
  };
  // `.find(f).sort({ createdAt: -1 })`, or `find(f, { sort: { … } })`.
  for (let outer: Node = call; ;) {
    const access = outer.getParent();
    const next = access?.getParent();
    if (
      !access ||
      !next ||
      !Node.isPropertyAccessExpression(access) ||
      !Node.isCallExpression(next)
    )
      break;
    const sortArg = next.getArguments()[0];
    if (access.getName() === 'sort' && sortArg) uses.sorts.push(...sortKeys(sortArg, fn));
    if (access.getName() === 'project' && sortArg)
      uses.projected.push(...projectedKeys(sortArg, fn));
    outer = next;
  }
  for (const option of objectOf(call.getArguments()[1], fn)?.getProperties() ?? []) {
    if (!Node.isPropertyAssignment(option)) continue;
    const value = option.getInitializer();
    if (!value) continue;
    if (option.getName() === 'sort') uses.sorts.push(...sortKeys(value, fn));
    if (option.getName() === 'projection') uses.projected.push(...projectedKeys(value, fn));
  }
  const lookup = (node: Node, within: Node = fn) => {
    CALLERS.reading = true;
    try {
      uses.lookups.push(...keysOf(node, within, 0).filter((key) => !key.name.startsWith('$')));
    } finally {
      CALLERS.reading = false;
    }
  };
  // The conditions the query itself runs under: a key's own conditions are the ones beyond these.
  const around = new Set(conditionsAround(call, fn).map((c) => `${c.holds}|${c.code}`));
  const conditionsOf = (key: Pick<KeyValue, 'node' | 'scope' | 'when'>): Literal[] => {
    const found: Literal[] = [];
    if (key.node && key.scope) {
      // In the query's function: what it is under beyond the query's own. In a helper: its `if`s and `? :`s.
      const own = key.scope === fn;
      for (const c of conditionsAround(key.node, key.scope, own))
        if (!own || !around.has(`${c.holds}|${c.code}`))
          found.push({ code: c.code, holds: c.holds, words: c.words });
    }
    return [...found, ...(key.when ?? [])];
  };
  const push = (key: KeyValue, name: string, how: string) => {
    const when = dedupeLiterals(conditionsOf(key));
    uses.writes.push({ ...key, name, how, ...(when.length ? { when } : { when: undefined }) });
  };
  const write = (node: Node, how: string, within: Node = fn) => {
    for (const key of keysOf(node, within, 0)) {
      push(key, key.name, how);
      // An array of records: each item's keys are fields too, `batches[].mrp` — every item's,
      // so a merged batch and a new one stay two ways the field is written.
      if (!key.valueNode || key.name.includes('[]')) continue;
      for (const item of arrayItems(key.valueNode, key.fnOf ?? within)) {
        // `batches.push(newBatch(…))` under `if (addQty > 0)`: the item's own conditions count.
        const itemWhen = conditionsOf({ node: item.node, scope: item.fn });
        for (const sub of keysOf(item.node, item.fn, 1)) {
          if (sub.name.startsWith('$')) continue;
          // The side it was chosen on, where it is built, and its own — each once.
          const when = [...(item.when ?? []), ...itemWhen, ...conditionsOf(sub)];
          push(
            { ...sub, node: undefined, scope: undefined, when },
            `${key.name}[].${sub.name}`,
            how,
          );
        }
      }
    }
  };

  const args = call.getArguments();
  if (op.meta?.['database'] === 'prisma') {
    // `{ where, data }` in one object.
    for (const key of objectOf(args[0], fn)?.getProperties() ?? []) {
      if (!Node.isPropertyAssignment(key)) continue;
      const value = key.getInitializer();
      if (!value) continue;
      if (key.getName() === 'where') lookup(value);
      else if (['data', 'create', 'update'].includes(key.getName()))
        write(value, operation === 'create' || key.getName() === 'create' ? 'insert' : '$set');
    }
    return uses;
  }

  // `patient.uuid = uuid; await patient.save()`: what was set on the document before it.
  if (operation === 'save') {
    // `new this.model(dto).save()`, or `const doc = new this.model(dto); …; doc.save()`:
    // the record is what it was built from, plus what is set on it before the save.
    const callee = call.getExpression();
    let doc: Node | undefined = Node.isPropertyAccessExpression(callee)
      ? callee.getExpression()
      : undefined;
    while (doc && (Node.isParenthesizedExpression(doc) || Node.isAwaitExpression(doc)))
      doc = doc.getExpression();
    let built: NewExpression | undefined = doc && Node.isNewExpression(doc) ? doc : undefined;
    if (doc && Node.isIdentifier(doc)) {
      const declaration = localVariable(fn, doc.getText());
      const init =
        declaration && Node.isVariableDeclaration(declaration)
          ? declaration.getInitializer()
          : undefined;
      if (init && Node.isNewExpression(init)) built = init;
      for (const key of savedKeys(doc.getText(), call, fn))
        push(key, key.name, built ? 'insert' : '$set');
    }
    const source = built?.getArguments()[0];
    if (source) write(source, 'insert');
    return uses;
  }

  // `aggregate([{ $match }, { $sort }, { $lookup: { from, pipeline: [{ $match }] } }])`.
  const readPipeline = (node: Node, within: Node, depth: number, into?: KeyValue[]): void => {
    // `aggregation(query) { return this.model.aggregate(query) }`: the pipeline its callers build.
    if (
      Node.isIdentifier(node) &&
      depth < 2 &&
      parametersOf(within).some((p) => p.getName() === node.getText())
    ) {
      for (const { arg, fn: callerFn } of callerArguments(within, node.getText()))
        readPipeline(arg, callerFn, depth + 1, into);
      return;
    }
    for (const stage of arrayElements(node, within)) {
      for (const property of objectOf(stage, within)?.getProperties() ?? []) {
        if (!Node.isPropertyAssignment(property)) continue;
        const value = property.getInitializer();
        if (!value) continue;
        const name = property.getName().replace(/^['"`]|['"`]$/g, '');
        if (name === '$match') {
          const keys = keysOf(value, within, 0).filter((key) => !key.name.startsWith('$'));
          if (into) into.push(...keys);
          else uses.lookups.push(...keys);
        } else if (name === '$sort' && !into) uses.sorts.push(...sortKeys(value, within));
        else if (name === '$lookup' && depth < 2) {
          const body = objectOf(value, within);
          const from = body?.getProperty('from');
          const sub = body?.getProperty('pipeline');
          const collection =
            from && Node.isPropertyAssignment(from)
              ? readStringValue(from.getInitializer())
              : undefined;
          const inner = sub && Node.isPropertyAssignment(sub) ? sub.getInitializer() : undefined;
          if (!collection || !inner) continue;
          const joined: KeyValue[] = [];
          readPipeline(inner, within, depth + 1, joined);
          if (joined.length) (uses.joined ??= []).push({ collection, lookups: joined });
        }
      }
    }
  };

  // `doc.update({ transaction_id })` on a loaded document: the argument is the change.
  if (op.meta?.['onDocument'] === true && operation !== 'save') {
    if (args[0]) update(args[0], fn);
    return uses;
  }

  (ROLES[operation] ?? []).forEach((role, index) => {
    const arg = args[index];
    if (!arg) return;
    if (role === 'filter') lookup(arg);
    else if (role === 'pipeline') readPipeline(arg, fn, 0);
    else if (role === 'document') write(arg, operation === 'replaceOne' ? 'replace' : 'insert');
    else if (role === 'documents') {
      const list = Node.isArrayLiteralExpression(arg) ? arg.getElements() : [];
      list.slice(0, 1).forEach((element) => write(element, 'insert'));
    } else if (role === 'update') update(arg, fn);
    else if (role === 'operations') {
      // `bulkWrite([{ updateOne: { filter, update } }])`, or `rows.map((r) => ({ … }))`.
      for (const item of arrayItems(arg, fn)) {
        for (const entry of objectOf(item.node, item.fn)?.getProperties() ?? []) {
          if (!Node.isPropertyAssignment(entry)) continue;
          const kind = entry.getName();
          const body = objectOf(entry.getInitializer(), item.fn);
          for (const part of body?.getProperties() ?? []) {
            if (!Node.isPropertyAssignment(part)) continue;
            const value = part.getInitializer();
            if (!value) continue;
            if (part.getName() === 'filter') lookup(value, item.fn);
            else if (part.getName() === 'update') update(value, item.fn);
            else if (part.getName() === 'document') write(value, 'insert', item.fn);
            else if (part.getName() === 'replacement') write(value, 'replace', item.fn);
          }
          if (kind === 'insertOne' && !body) write(entry.getInitializer()!, 'insert', item.fn);
        }
      }
    }
  });
  return uses;

  /** An update: `{ $set: { … } }`, a conditional between two, or Mongoose's implicit `$set`. */
  function update(node: Node, within: Node): void {
    // `findByIdAndUpdate(id, obj)` where `obj = classToPlain(x)` and then `obj.is_complete = true`.
    if (objectsOf(node, within).length === 0) {
      write(node, '$set', within);
      return;
    }
    for (const object of objectsOf(node, within)) {
      const operators = object
        .getProperties()
        .filter(Node.isPropertyAssignment)
        .filter((key) => UPDATE_OPERATORS.test(key.getName()));
      if (operators.length === 0) write(object, '$set', within);
      for (const key of operators) {
        const value = key.getInitializer();
        if (value) write(value, key.getName(), within);
      }
    }
  }
}

/** Every object a value can be: both sides of `cond ? { … } : { … }`, or the one it is. */
function objectsOf(node: Node | undefined, fn: Node): ObjectLiteralExpression[] {
  if (!node) return [];
  if (Node.isParenthesizedExpression(node)) return objectsOf(node.getExpression(), fn);
  if (Node.isConditionalExpression(node))
    return [...objectsOf(node.getWhenTrue(), fn), ...objectsOf(node.getWhenFalse(), fn)];
  const object = objectOf(node, fn);
  return object ? [object] : [];
}

/** The object literal a node is, or a local variable or wrapper call holds. */
function objectOf(
  node: Node | undefined,
  fn: Node,
  depth = 0,
): ObjectLiteralExpression | undefined {
  if (!node || depth > 3) return undefined;
  if (Node.isObjectLiteralExpression(node)) return node;
  if (
    Node.isAwaitExpression(node) ||
    Node.isParenthesizedExpression(node) ||
    Node.isAsExpression(node)
  )
    return objectOf(node.getExpression(), fn, depth + 1);
  if (Node.isIdentifier(node)) {
    const declaration = localVariable(fn, node.getText());
    return Node.isVariableDeclaration(declaration)
      ? objectOf(declaration.getInitializer(), fn, depth + 1)
      : undefined;
  }
  // `syncFromBatches({ … })`: a helper that takes the record and returns it.
  if (Node.isCallExpression(node)) {
    const first = node.getArguments()[0];
    return first && Node.isObjectLiteralExpression(first) ? first : undefined;
  }
  return undefined;
}

/**
 * The keys an object sets, with each value as written.
 *
 * A spread is followed to the object it copies; a spread of a parameter typed
 * inline (`result: { added: number }`) gives that type's keys. A spread of
 * anything else is left out rather than guessed.
 */
function keysOf(node: Node, fn: Node, depth: number): KeyValue[] {
  if (depth > 4) return [];
  // `syncFromBatches({ … })`, `newBatch(input, qty)`, `const base = userForPhone(phone)`.
  const call = callBehind(node, fn);
  const helper = call ? helperOf(call) : undefined;
  if (call && helper) {
    const first = call.getArguments()[0];
    const given =
      first && Node.isObjectLiteralExpression(first) ? keysOf(first, fn, depth + 1) : [];
    const worked = returnedValues(helper).flatMap((value) =>
      keysOf(value, helper, depth + 1)
        // `...m` copies the record it was given (keys off the parameter's type): not worked out.
        .filter((key) => !given.length || key.valueNode !== undefined)
        // `...m` is the record it was given, already read above.
        .map((key): KeyValue =>
          given.length ? derived(key, helper) : { ...key, fnOf: key.fnOf ?? helper },
        ),
    );
    const overridden = new Set(given.length ? worked.map((key) => key.name) : []);
    const keys = [...given.filter((key) => !overridden.has(key.name)), ...uniqueKeys(worked)];
    if (Node.isIdentifier(node)) keys.push(...assignedKeys(node.getText(), fn, depth));
    return keys;
  }
  // `plainToClass(UpdateClinicDto, clinicDto)`, `structuredClone(dto)`: a copy holds what it copies.
  if (call && !helper && COPIES.test(call.getExpression().getText())) {
    const args = call.getArguments();
    const source = /plainTo(Class|Instance)$/.test(call.getExpression().getText())
      ? args.at(-1)
      : args[0];
    const copied = [
      ...(source ? keysOf(source, fn, depth + 1) : []),
      ...(/assign$/.test(call.getExpression().getText())
        ? args.slice(1).flatMap((arg) => keysOf(arg, fn, depth + 1))
        : []),
    ];
    if (Node.isIdentifier(node)) copied.push(...assignedKeys(node.getText(), fn, depth));
    return copied;
  }
  const object = objectOf(node, fn);
  if (!object) {
    // `create(createPatientDto)` after `createPatientDto.created_by = 'staff'`: its type's fields and those.
    if (Node.isIdentifier(node)) {
      const typed = parameterKeys(fn, node.getText());
      // An untyped parameter (`updatePatient(id, setData)`): what the callers pass in.
      const passed = typed.length ? [] : callerKeys(fn, node.getText(), depth);
      return [...typed, ...passed, ...assignedKeys(node.getText(), fn, depth)];
    }
    return [];
  }
  const keys: KeyValue[] = [];
  for (const property of object.getProperties()) {
    if (Node.isPropertyAssignment(property)) {
      const nameNode = property.getNameNode();
      if (Node.isComputedPropertyName(nameNode)) continue;
      const value = property.getInitializer();
      if (!value) continue;
      const name = property.getName().replace(/^['"`]|['"`]$/g, '');
      // `$or: [{ a }, { b }]` in a filter: the fields are inside.
      if (/^\$(or|and|nor)$/.test(name)) {
        for (const element of arrayElements(value, fn))
          keys.push(...keysOf(element, fn, depth + 1).map(asBranch));
        continue;
      }
      keys.push(keyValue(name, value, fn));
    } else if (Node.isShorthandPropertyAssignment(property)) {
      keys.push(keyValue(property.getName(), property.getNameNode(), fn));
    } else if (Node.isSpreadAssignment(property)) {
      let spread: Node = property.getExpression();
      while (Node.isParenthesizedExpression(spread)) spread = spread.getExpression();
      if (Node.isConditionalExpression(spread))
        for (const side of objectsOf(spread, fn)) keys.push(...keysOf(side, fn, depth + 1));
      else if (Node.isBinaryExpression(spread) && spread.getOperatorToken().getText() === '&&')
        keys.push(...keysOf(spread.getRight(), fn, depth + 1));
      else keys.push(...keysOf(spread, fn, depth + 1));
    }
  }
  // `filter.category = x`, `filter.$or = [{ name: rx }, …]`: keys added after the literal.
  if (Node.isIdentifier(node)) keys.push(...assignedKeys(node.getText(), fn, depth));
  return keys;
}

/** Library calls that copy or convert a record without changing its keys. */
const COPIES =
  /(^|\.)(plainToClass|plainToInstance|classToPlain|instanceToPlain|structuredClone|cloneDeep|clone|toObject|toJSON|assign)$/;

/** The call a value is, or a local variable holds: `await syncFromBatches({ … })`. */
function callBehind(node: Node, fn: Node): CallExpression | undefined {
  let current: Node | undefined = node;
  for (let hops = 0; current && hops < 4; hops += 1) {
    if (
      Node.isAwaitExpression(current) ||
      Node.isParenthesizedExpression(current) ||
      Node.isAsExpression(current)
    )
      current = current.getExpression();
    else if (Node.isIdentifier(current)) current = latestValue(current, fn);
    else break;
  }
  return current && Node.isCallExpression(current) ? current : undefined;
}

/**
 * What a variable holds where it is read: the last `name = …` before that point,
 * else its declaration — `current = syncFromBatches(…)` over `let current = existing`.
 */
function latestValue(identifier: Node, fn: Node): Node | undefined {
  const name = identifier.getText();
  const before = fn
    .getDescendantsOfKind(SyntaxKind.BinaryExpression)
    .filter(
      (node) =>
        node.getOperatorToken().getKind() === SyntaxKind.EqualsToken &&
        node.getLeft().getText() === name &&
        node.getEnd() <= identifier.getStart(),
    )
    .at(-1);
  if (before) return before.getRight();
  const declaration = localVariable(fn, name);
  return Node.isVariableDeclaration(declaration) ? declaration.getInitializer() : undefined;
}

/** The project's own function a call runs, in this file or one it imports. */
function helperOf(call: CallExpression): Node | undefined {
  const callee = call.getExpression();
  if (!Node.isIdentifier(callee)) return undefined;
  const name = callee.getText();
  const file = call.getSourceFile();
  const local = file.getFunction(name) ?? file.getVariableDeclaration(name)?.getInitializer();
  let found: Node | undefined = local;
  if (!found && READER.current) {
    try {
      found = READER.current.functionNamed(name, file);
    } catch {
      found = undefined;
    }
  }
  if (!found) return undefined;
  if (
    Node.isFunctionDeclaration(found) ||
    Node.isArrowFunction(found) ||
    Node.isFunctionExpression(found)
  )
    return found;
  return undefined;
}

/** What a helper hands back: `return { … }`, or `return filter` built up in it. */
function returnedValues(helper: Node): Node[] {
  const body = (helper as unknown as { getBody?: () => Node | undefined }).getBody?.();
  if (body && !Node.isBlock(body)) return [body];
  return helper
    .getDescendantsOfKind(SyntaxKind.ReturnStatement)
    .filter((statement) => nearestFunction(statement) === helper)
    .flatMap((statement) => statement.getExpression() ?? []);
}

/** A key a helper works out: its value as the helper writes it, and the names it reads. */
function derived(key: KeyValue, helper: Node): KeyValue {
  let value = key.valueNode;
  // `return { ...m, currentStock }` with `const currentStock = batchStock(m.batches)`.
  if (value && Node.isIdentifier(value)) {
    const declaration = localVariable(helper, value.getText());
    const init = Node.isVariableDeclaration(declaration) ? declaration.getInitializer() : undefined;
    if (init) value = init;
  }
  return {
    ...key,
    value: value ? condense(value.getText(), 120) : key.value,
    from: 'computed',
    derivedIn: nameOf(helper),
    derivedNames: value ? namesRead(value, 1) : [],
    helperNames: namesRead(helper, 0),
    fnOf: helper,
  };
}

/**
 * `medicine.currentStock` where `const medicine = syncFromBatches({ … })` and the
 * helper works `currentStock` out: the value is the helper's, not a copy.
 */
function workedOutAccess(value: Node, fn: Node): KeyValue | undefined {
  if (!Node.isPropertyAccessExpression(value)) return undefined;
  const target = value.getExpression();
  if (!Node.isIdentifier(target)) return undefined;
  const call = callBehind(target, fn);
  const helper = call ? helperOf(call) : undefined;
  if (!call || !helper) return undefined;
  for (const returned of returnedValues(helper)) {
    const key = keysOf(returned, helper, 2).find(
      (entry) => entry.name === value.getName() && entry.valueNode !== undefined,
    );
    if (key) return derived(key, helper);
  }
  return undefined;
}

/**
 * `medicine.batches` where `const medicine = syncFromBatches({ ...existing, batches })`
 * and the helper only copies `batches`: the value is the `batches` built here.
 */
function passedThrough(value: Node, fn: Node): { node: Node; fn: Node } | undefined {
  if (!Node.isPropertyAccessExpression(value)) return undefined;
  const target = value.getExpression();
  if (!Node.isIdentifier(target)) return undefined;
  const call = callBehind(target, fn);
  const first = call?.getArguments()[0];
  if (!first || !Node.isObjectLiteralExpression(first)) return undefined;
  const name = value.getName();
  const property = first.getProperty(name);
  const own = Node.isPropertyAssignment(property)
    ? property.getInitializer()
    : Node.isShorthandPropertyAssignment(property)
      ? property.getNameNode()
      : undefined;
  if (own) return { node: own, fn };
  // `{ ...redated, updatedAt }`: the record spread in built the field (`applyImportRowDetails`).
  for (const spread of first.getProperties().filter(Node.isSpreadAssignment).reverse()) {
    const inner = callBehind(spread.getExpression(), fn);
    const helper = inner ? helperOf(inner) : undefined;
    if (!helper) continue;
    for (const returned of returnedValues(helper)) {
      const key = keysOf(returned, helper, 2).find((k) => k.name === name && k.valueNode);
      if (key?.valueNode) return { node: key.valueNode, fn: key.fnOf ?? helper };
    }
  }
  return undefined;
}

/**
 * The project helpers a value is rebuilt by: `addStockToBatches` and `deductFefo`
 * in `const batches = delta > 0 ? addStockToBatches(m, delta) : deductFefo(m.batches, -delta)`.
 */
function helpersFeeding(value: Node, fn: Node, depth = 0): string[] {
  if (depth > 4) return [];
  const names = new Set<string>();
  const visit = (node: Node) => {
    if (Node.isCallExpression(node)) {
      const helper = helperOf(node);
      // A function that loads (async: it reads the database) does not rebuild the value.
      const loads = (helper as unknown as { isAsync?: () => boolean } | undefined)?.isAsync?.();
      if (helper && !loads) names.add(nameOf(helper));
      for (const arg of node.getArguments()) visit(arg);
      return;
    }
    if (Node.isIdentifier(node)) {
      const init = latestValue(node, fn);
      if (init && init !== value)
        for (const name of helpersFeeding(init, fn, depth + 1)) names.add(name);
      return;
    }
    // In `{ ...redated, updatedAt: nowIso() }` only the spread carries the record along.
    if (Node.isObjectLiteralExpression(node)) {
      for (const property of node.getProperties())
        if (Node.isSpreadAssignment(property)) visit(property.getExpression());
      return;
    }
    node.forEachChild(visit);
  };
  visit(value);
  return [...names];
}

/** Property and variable names an expression reads, and those of the project helpers it calls. */
function namesRead(node: Node, depth: number): string[] {
  const names = new Set<string>();
  for (const child of [node, ...node.getDescendants()]) {
    if (Node.isPropertyAccessExpression(child)) names.add(child.getName());
    else if (Node.isIdentifier(child)) names.add(child.getText());
    if (depth > 0 && Node.isCallExpression(child)) {
      const helper = helperOf(child);
      if (helper) for (const name of namesRead(helper, 0)) names.add(name);
    }
  }
  return [...names];
}

function uniqueKeys(keys: KeyValue[]): KeyValue[] {
  // A later `x.name = …` replaces the key; a condition inside `$or` sits beside it.
  return [
    ...new Map(
      keys.map((key) => [key.branch ? `${key.name}\u0000${key.value}` : key.name, key]),
    ).values(),
  ];
}

const asBranch = (key: KeyValue): KeyValue => ({ ...key, branch: true });

/**
 * A sort's keys, a key the user picks included: `{ [sortBy]: dir }` where
 * `sortBy = query.sortBy ?? "updatedAt"` and `sortBy?: "name" | "currentStock"`
 * is every name it can hold — the literals it falls back to, and the union its
 * type declares.
 */
function sortKeys(node: Node, fn: Node): KeyValue[] {
  const keys = keysOf(node, fn, 0);
  for (const property of objectOf(node, fn)?.getProperties() ?? []) {
    if (!Node.isPropertyAssignment(property)) continue;
    const nameNode = property.getNameNode();
    const value = property.getInitializer();
    if (!Node.isComputedPropertyName(nameNode) || !value) continue;
    let picked: Node = nameNode.getExpression();
    if (Node.isIdentifier(picked)) {
      const declaration = localVariable(fn, picked.getText());
      const init =
        declaration && Node.isVariableDeclaration(declaration)
          ? declaration.getInitializer()
          : undefined;
      if (init) picked = init;
    }
    const names = new Set<string>();
    for (const part of [picked, ...picked.getDescendants()]) {
      if (Node.isStringLiteral(part)) names.add(part.getLiteralValue());
      // `query.sortBy`, `query` a parameter typed `MedicineQuery`: the property's union.
      if (!Node.isPropertyAccessExpression(part)) continue;
      const parameter = parametersOf(fn).find(
        (p) => p.getName() === part.getExpression().getText(),
      );
      const owner = parameter?.getTypeNode();
      const declared =
        owner && Node.isTypeReference(owner)
          ? READER.current?.declaration(owner.getTypeName().getText(), owner.getSourceFile())
          : undefined;
      const member = (
        declared as unknown as { getProperty?: (name: string) => Node | undefined }
      )?.getProperty?.(part.getName());
      for (const name of literalUnion(
        member && Node.isPropertySignature(member) ? member.getTypeNode() : undefined,
      ))
        names.add(name);
    }
    for (const name of names) keys.push({ name, value: value.getText(), from: 'input' });
  }
  return keys;
}

/** `"a" | "b"`, directly or through a type alias: the strings it allows. */
function literalUnion(type: Node | undefined, depth = 0): string[] {
  if (!type || depth > 3) return [];
  if (Node.isTypeReference(type)) {
    const alias = READER.current?.declaration(type.getTypeName().getText(), type.getSourceFile());
    return alias && Node.isTypeAliasDeclaration(alias)
      ? literalUnion(alias.getTypeNode(), depth + 1)
      : [];
  }
  const parts = Node.isUnionTypeNode(type) ? type.getTypeNodes() : [type];
  return parts.flatMap((part) => {
    const literal = Node.isLiteralTypeNode(part) ? part.getLiteral() : undefined;
    return literal && Node.isStringLiteral(literal) ? [literal.getLiteralValue()] : [];
  });
}

/** `projection: { name: 1, clinic_id: 1 }`: the fields a read asks for. */
function projectedKeys(node: Node, fn: Node): KeyValue[] {
  return keysOf(node, fn, 0).filter((key) => !/^(0|false)$/.test(key.value));
}

/**
 * The records an array holds, each with the function it is written in:
 * `[newBatch(input, qty)]`, `cond ? [a] : []`, `list.push(b)`, `list[i] = { … }`.
 */
interface ArrayItem {
  node: Node;
  fn: Node;
  /** The `? :` sides it was chosen on: `delta > 0` for the list `addStockToBatches` returns. */
  when?: Literal[];
}

function arrayItems(value: Node, fn: Node, depth = 0): ArrayItem[] {
  if (depth > 6) return [];
  if (Node.isParenthesizedExpression(value) || Node.isAsExpression(value))
    return arrayItems(value.getExpression(), fn, depth + 1);
  if (Node.isConditionalExpression(value)) {
    const test = value.getCondition();
    const side = (node: Node, holds: boolean) =>
      arrayItems(node, fn, depth + 1).map((item) => ({
        ...item,
        when: [
          { code: condense(test.getText(), 80), holds, words: phrase(test, holds) },
          ...(item.when ?? []),
        ],
      }));
    return [...side(value.getWhenTrue(), true), ...side(value.getWhenFalse(), false)];
  }
  if (Node.isArrayLiteralExpression(value))
    return value
      .getElements()
      .filter((element) => !Node.isSpreadElement(element))
      .map((element) => ({ node: element, fn }));
  // `rows.map((r) => ({ … }))`: each item is what the callback returns.
  if (Node.isCallExpression(value)) {
    const callee = value.getExpression();
    const callback = value.getArguments()[0];
    if (
      Node.isPropertyAccessExpression(callee) &&
      callee.getName() === 'map' &&
      callback &&
      (Node.isArrowFunction(callback) || Node.isFunctionExpression(callback))
    )
      // `b === newest ? { ...b, quantity: … } : b`: each side the callback can return.
      return returnedValues(callback)
        .flatMap(sidesOf)
        .map((node) => ({ node, fn: callback }));
    // `[...list].sort(…).map(…).filter(…)`: the items are the receiver's, reordered or thinned.
    if (
      Node.isPropertyAccessExpression(callee) &&
      /^(filter|sort|slice|reverse|toSorted|toReversed|concat)$/.test(callee.getName())
    )
      return arrayItems(callee.getExpression(), fn, depth + 1);
    // `addStockToBatches(m, delta)`: the list a project helper hands back.
    const helper = helperOf(value);
    const loads = (helper as unknown as { isAsync?: () => boolean } | undefined)?.isAsync?.();
    if (helper && !loads)
      return returnedValues(helper).flatMap((node) => arrayItems(node, helper, depth + 1));
    return [];
  }
  if (!Node.isIdentifier(value)) return [];
  const name = value.getText();
  const declaration = localVariable(fn, name);
  const init = Node.isVariableDeclaration(declaration) ? declaration.getInitializer() : undefined;
  const items = init ? arrayItems(init, fn, depth + 1) : [];
  for (const call of fn.getDescendantsOfKind(SyntaxKind.CallExpression))
    if (call.getExpression().getText() === `${name}.push`)
      items.push(...call.getArguments().map((node) => ({ node, fn })));
  for (const assignment of fn.getDescendantsOfKind(SyntaxKind.BinaryExpression)) {
    const left = assignment.getLeft();
    if (
      assignment.getOperatorToken().getKind() === SyntaxKind.EqualsToken &&
      Node.isElementAccessExpression(left) &&
      left.getExpression().getText() === name
    )
      items.push({ node: assignment.getRight(), fn });
  }
  return items;
}

/** The items of an array: written inline, or a variable filled with `.push(…)`. */
function arrayElements(value: Node, fn: Node, depth = 0): Node[] {
  // `[...windowStages, { $limit: 10 }]`: a spread array's items are this one's.
  if (Node.isArrayLiteralExpression(value))
    return value
      .getElements()
      .flatMap((element) =>
        Node.isSpreadElement(element) && depth < 3
          ? arrayElements(element.getExpression(), fn, depth + 1)
          : [element],
      );
  if (!Node.isIdentifier(value)) return [];
  const name = value.getText();
  const declaration = localVariable(fn, name);
  const init = Node.isVariableDeclaration(declaration) ? declaration.getInitializer() : undefined;
  const pushed = fn
    .getDescendantsOfKind(SyntaxKind.CallExpression)
    .filter((call) => call.getExpression().getText() === `${name}.push`)
    // `pipeline.push(...windowStages)`: the spread array's stages.
    .flatMap((call) =>
      call
        .getArguments()
        .flatMap((arg) =>
          Node.isSpreadElement(arg) && depth < 3
            ? arrayElements(arg.getExpression(), fn, depth + 1)
            : [arg],
        ),
    );
  // `aggQuery = [...filters, ...aggQuery]`: what it is reassigned to, without reading itself again.
  const reassigned = fn
    .getDescendantsOfKind(SyntaxKind.BinaryExpression)
    .filter(
      (node) =>
        node.getOperatorToken().getKind() === SyntaxKind.EqualsToken &&
        node.getLeft().getText() === name &&
        Node.isArrayLiteralExpression(node.getRight()),
    )
    .flatMap((node) =>
      (node.getRight() as ArrayLiteralExpression)
        .getElements()
        .flatMap((element) =>
          Node.isSpreadElement(element) && element.getExpression().getText() !== name && depth < 3
            ? arrayElements(element.getExpression(), fn, depth + 1)
            : Node.isSpreadElement(element)
              ? []
              : [element],
        ),
    );
  return [
    ...(init && Node.isArrayLiteralExpression(init) ? arrayElements(init, fn, depth + 1) : []),
    ...reassigned,
    ...pushed,
  ];
}

/** The code each field's writes and lookups were read from, so mentions do not repeat it. */
const READ_FROM = new Map<string, Node[]>();

/**
 * Lookups a query on one collection makes on another, inside a `$lookup` pipeline:
 * credited once every collection is read. A collection read alone (`only`) does not
 * see them; the dashboard carries them over from the whole report.
 */
const JOINED: Array<{ collection: string; name: string; lookup: FieldLookup }> = [];

/** The key itself: `mrp` for `batches[].mrp`, `mobile_number` for `pharmacy_contacts.mobile_number`. */
const leafOf = (name: string): string => name.split(/[.\]]/).pop()!.replace(/\[$/, '');

/** A write a helper worked out, waiting for the collection's fields to say what it reads. */
interface Derivation {
  write: FieldWrite;
  key: KeyValue;
}

/**
 * What each worked-out value is worked out from, as fields of the collection.
 *
 * `sellingPrice: earliest.mrp` in `syncFromBatches` reads `mrp`, and the helper
 * reads `batches`: so it comes from `batches[].mrp`. A plain field it reads
 * (`m.batches`) counts when no item field of it does.
 */
function resolveDerivations(
  fields: readonly DatabaseField[],
  derivations: readonly Derivation[],
): void {
  const names = new Set(fields.map((field) => field.name));
  for (const { write, key } of derivations) {
    const reads = new Set(key.derivedNames ?? []);
    const inHelper = new Set([...(key.helperNames ?? []), ...reads]);
    const items = [...names].filter((name) => {
      const match = /^(.+)\[\]\.(\w+)$/.exec(name);
      return match !== null && inHelper.has(match[1]!) && reads.has(match[2]!);
    });
    const parents = new Set(items.map((name) => name.split('[]')[0]));
    const plain = [...reads].filter(
      (name) => names.has(name) && name !== key.name && !parents.has(name),
    );
    const from = [...new Set([...items, ...plain])].sort();
    if (from.length) write.derivedFrom = from;
  }
}

/** The report's source reader, for opening a helper in another file. */
const READER: { current?: SourceReader; graph?: FlowGraph } = {};

/**
 * The keys callers hand an untyped parameter, one call away: the graph knows who
 * calls the function, the source what each passes in that position.
 */
function callerKeys(fn: Node, name: string, depth: number): KeyValue[] {
  const { current: reader, graph } = READER;
  // A filter's untyped parameter is an id or a query: its callers add nothing but time.
  if (!reader || !graph || depth > 2 || CALLERS.reading) return [];
  const position = parametersOf(fn).findIndex((p) => p.getName() === name);
  const method = nameOf(fn)?.split('.').pop();
  if (position < 0 || !method) return [];
  // Once per function and parameter; set empty first, so a call cycle ends.
  const byName = CALLERS.keys.get(fn) ?? new Map<string, KeyValue[]>();
  CALLERS.keys.set(fn, byName);
  const cached = byName.get(name);
  if (cached) return cached;
  byName.set(name, []);
  CALLERS.methods ??= new Map(
    graph
      .nodesOfKind('method')
      .filter((node) => node.source)
      .map((node) => [`${node.source!.file}:${node.source!.line}`, node]),
  );
  const self = CALLERS.methods.get(
    `${reader.relative(fn.getSourceFile())}:${fn.getStartLineNumber()}`,
  );
  if (!self) return [];
  const keys = callerArguments(fn, name).flatMap(({ arg, fn: callerFn }) =>
    keysOf(arg, callerFn, depth + 1),
  );
  byName.set(name, keys);
  return keys;
}

/** What each caller passes for a parameter, with the function it is passed from. */
function callerArguments(fn: Node, name: string): Array<{ arg: Node; fn: Node }> {
  const { current: reader, graph } = READER;
  if (!reader || !graph) return [];
  const position = parametersOf(fn).findIndex((p) => p.getName() === name);
  const method = nameOf(fn)?.split('.').pop();
  if (position < 0 || !method) return [];
  CALLERS.methods ??= new Map(
    graph
      .nodesOfKind('method')
      .filter((node) => node.source)
      .map((node) => [`${node.source!.file}:${node.source!.line}`, node]),
  );
  const self = CALLERS.methods.get(
    `${reader.relative(fn.getSourceFile())}:${fn.getStartLineNumber()}`,
  );
  if (!self) return [];
  const found: Array<{ arg: Node; fn: Node }> = [];
  for (const caller of graph.predecessors(self.id, ['calls'])) {
    const callerFn = caller.source
      ? functionAt(reader, caller.source.file, caller.source.line)
      : undefined;
    if (!callerFn) continue;
    for (const call of callsOf(callerFn)) {
      if (call.getExpression().getText().split('.').pop() !== method) continue;
      const arg = call.getArguments()[position];
      if (arg) found.push({ arg, fn: callerFn });
    }
  }
  return found;
}

/** Per report: method nodes by where they start, functions by position, calls by function. */
const CALLERS: {
  methods?: Map<string, FlowNode>;
  functions: Map<string, Map<number, Node>>;
  calls: WeakMap<Node, CallExpression[]>;
  keys: WeakMap<Node, Map<string, KeyValue[]>>;
  /** Set while a filter is read: its parameters are not followed to callers. */
  reading: boolean;
} = { functions: new Map(), calls: new WeakMap(), keys: new WeakMap(), reading: false };

/** A function's calls, listed once. */
function callsOf(fn: Node): CallExpression[] {
  let calls = CALLERS.calls.get(fn);
  if (!calls) {
    calls = fn.getDescendantsOfKind(SyntaxKind.CallExpression);
    CALLERS.calls.set(fn, calls);
  }
  return calls;
}

/** The function starting on `line` in `file`: each file's functions indexed by line, once. */
function functionAt(reader: SourceReader, file: string, line: number): Node | undefined {
  let byLine = CALLERS.functions.get(file);
  if (!byLine) {
    byLine = new Map();
    const source = reader.file(file);
    const functions = source
      ? [
          ...source.getDescendantsOfKind(SyntaxKind.MethodDeclaration),
          ...source.getDescendantsOfKind(SyntaxKind.FunctionDeclaration),
          ...source.getDescendantsOfKind(SyntaxKind.ArrowFunction),
        ]
      : [];
    // The compiler's own line map: one binary search per function, not a count from the top.
    const lines = source?.compilerNode;
    for (const fn of functions) {
      const at = lines
        ? lines.getLineAndCharacterOfPosition(fn.getStart()).line + 1
        : fn.getStartLineNumber();
      if (!byLine.has(at)) byLine.set(at, fn);
    }
    CALLERS.functions.set(file, byLine);
  }
  return byLine.get(line);
}

function keyValue(name: string, value: Node, fn: Node): KeyValue {
  const list = READ_FROM.get(name) ?? [];
  list.push(value.getParent() ?? value);
  READ_FROM.set(name, list);
  const match = matchOf(value, fn);
  const worked = workedOutAccess(value, fn);
  if (worked) return { ...worked, name, node: value.getParent() ?? value };
  const passed = passedThrough(withoutDefault(value), fn);
  if (passed && passed.node !== value)
    return {
      ...keyValue(name, passed.node, passed.fn),
      ...(passed.fn !== fn ? { fnOf: passed.fn } : {}),
      node: value.getParent() ?? value,
    };
  return {
    name,
    value: condense(value.getText(), 120),
    from: originOf(value, fn),
    ...keyOf(value),
    ...(match ? { match } : {}),
    node: value.getParent() ?? value,
    valueNode: value,
    scope: fn,
    ...rebuilt(value, fn),
    ...addsTo(name, value),
    ...keptIfSet(name, value, fn),
  };
}

/** `x?.trim()`, `String(x)`, `x ?? ""` → `x`: wrappers that keep where a value comes from. */
function unwrapped(node: Node): Node {
  let current = withoutDefault(node);
  for (let hops = 0; hops < 4 && Node.isCallExpression(current); hops += 1) {
    const callee = current.getExpression();
    if (
      Node.isPropertyAccessExpression(callee) &&
      /^(trim|toLowerCase|toUpperCase|toString)$/.test(callee.getName()) &&
      current.getArguments().length === 0
    )
      current = withoutDefault(callee.getExpression());
    else if (
      Node.isIdentifier(callee) &&
      /^(String|Number|Boolean)$/.test(callee.getText()) &&
      current.getArguments()[0]
    )
      current = withoutDefault(current.getArguments()[0]!);
    else break;
  }
  return current;
}

/** `medicine.dosageForm ?? ""` → `medicine.dosageForm`: a literal fallback says nothing about where it comes from. */
function withoutDefault(value: Node): Node {
  if (
    Node.isBinaryExpression(value) &&
    /^(\|\||\?\?)$/.test(value.getOperatorToken().getText()) &&
    Node.isLiteralExpression(value.getRight())
  )
    return value.getLeft();
  return value;
}

/** `quantity: b.quantity + addQty` adds to the old value; `b.quantity - take` takes from it. */
function addsTo(name: string, value: Node): { adds?: true; takes?: true } {
  if (!Node.isBinaryExpression(value)) return {};
  const operator = value.getOperatorToken().getText();
  const own = (side: Node) => Node.isPropertyAccessExpression(side) && side.getName() === name;
  if (operator === '+' && (own(value.getLeft()) || own(value.getRight()))) return { adds: true };
  if (operator === '-' && own(value.getLeft())) return { takes: true };
  return {};
}

/** `dosageForm: existing.dosageForm || input.dosageForm`: the new value only when the old is empty. */
function keptIfSet(name: string, written: Node, fn: Node): { when?: Literal[] } {
  // `dosageForm: adoptedForm` — what the variable holds.
  const value = (Node.isIdentifier(written) && latestValue(written, fn)) || written;
  // The field's old value on the record: `existing.dosageForm`, not what was sent.
  const old = (side: Node) => {
    const bare = withoutDefault(side);
    return (
      Node.isPropertyAccessExpression(bare) &&
      bare.getName() === name &&
      originOf(bare, fn) !== 'input'
    );
  };
  // `cond ? input.dosageForm : existing.dosageForm`: the new value only when `cond`.
  if (Node.isConditionalExpression(value)) {
    const test = value.getCondition();
    const as = (holds: boolean): Literal => ({
      code: condense(test.getText(), 80),
      holds,
      words: phrase(test, holds),
    });
    if (old(value.getWhenFalse()) && !old(value.getWhenTrue())) return { when: [as(true)] };
    if (old(value.getWhenTrue()) && !old(value.getWhenFalse())) return { when: [as(false)] };
    return {};
  }
  if (!Node.isBinaryExpression(value) || !/^(\|\||\?\?)$/.test(value.getOperatorToken().getText()))
    return {};
  const left = value.getLeft();
  // `input.x ?? ""` is a default for what was sent; `existing.x || input.x` keeps the old one.
  if (!Node.isPropertyAccessExpression(left) || left.getName() !== name) return {};
  if (Node.isLiteralExpression(value.getRight()) || originOf(left, fn) === 'input') return {};
  return {
    when: [{ code: condense(left.getText(), 60), holds: false, words: phrase(left, false) }],
  };
}

function rebuilt(value: Node, fn: Node): { rewrittenBy?: string[] } {
  if (Node.isLiteralExpression(value)) return {};
  const helpers = helpersFeeding(value, fn);
  return helpers.length ? { rewrittenBy: helpers } : {};
}

/** `name.key = value` lines in the function, the way a filter is built up under `if`s. */
function assignedKeys(name: string, fn: Node, depth: number): KeyValue[] {
  const keys: KeyValue[] = [];
  for (const node of fn.getDescendantsOfKind(SyntaxKind.BinaryExpression)) {
    if (node.getOperatorToken().getKind() !== SyntaxKind.EqualsToken) continue;
    const left = node.getLeft();
    // `x = { ...dto, template_id }` later in the function: what it can hold then, too.
    if (Node.isIdentifier(left) && left.getText() === name && depth < 3) {
      keys.push(...keysOf(node.getRight(), fn, depth + 1));
      continue;
    }
    if (!Node.isPropertyAccessExpression(left) || left.getExpression().getText() !== name) continue;
    const key = left.getName();
    const value = node.getRight();
    if (/^\$(or|and|nor)$/.test(key)) {
      for (const element of arrayElements(value, fn))
        keys.push(...keysOf(element, fn, depth + 1).map(asBranch));
    } else keys.push(keyValue(key, value, fn));
  }
  return keys;
}

/** How a filter value matches: `{ $regex }` or a `RegExp` is a text search, `$in` one of a list… */
function matchOf(value: Node, fn: Node): LookupMatch | undefined {
  let text = value.getText();
  if (Node.isIdentifier(value)) {
    const declaration = localVariable(fn, text);
    if (Node.isVariableDeclaration(declaration))
      text = declaration.getInitializer()?.getText() ?? text;
  }
  if (/\$regex\b|\bRegExp\(|^\/.+\/[a-z]*$/.test(text)) return 'search';
  if (/\$(in)\b/.test(text)) return 'one-of';
  if (/\$(gt|gte|lt|lte)\b/.test(text)) return 'range';
  if (/\$exists\b/.test(text)) return 'exists';
  if (/\$(ne|nin|not)\b/.test(text)) return 'not';
  return undefined;
}

/** `{ ...result }` where `result: { added: number; failed: number }` is a parameter. */
function parameterKeys(fn: Node, name: string): KeyValue[] {
  const parameter = parametersOf(fn).find((entry) => entry.getName() === name);
  const type = parameter?.getTypeNode();
  if (!type) return [];
  // `createPatientDto: CreatePatientDto`: the fields its type declares, an optional one only if sent.
  return typeMembers(type, type.getSourceFile(), 0).map((member) => ({
    name: member.name,
    value: `${name}.${member.name}`,
    from: 'input',
    key: member.name,
    ...(member.optional
      ? {
          when: [
            { code: `${name}.${member.name} !== undefined`, holds: true, words: 'it is sent' },
          ],
        }
      : {}),
  }));
}

/**
 * The fields a type declares: a literal, an interface (and what it extends), a
 * class (and its base, through NestJS's `PartialType` / `PickType` / `OmitType` /
 * `IntersectionType`), an alias, or TypeScript's `Partial` / `Pick` / `Omit`.
 */
function typeMembers(
  type: Node,
  file: SourceFile,
  depth: number,
): Array<{ name: string; optional: boolean }> {
  if (depth > 5) return [];
  const membersOf = (owner: Node): Array<{ name: string; optional: boolean }> =>
    (owner as unknown as { getProperties?: () => Node[] })
      .getProperties?.()
      .filter((p) => Node.isPropertySignature(p) || Node.isPropertyDeclaration(p))
      .filter((p) => !(Node.isPropertyDeclaration(p) && p.isStatic()))
      .map((p) => ({
        name: (p as unknown as { getName: () => string }).getName(),
        optional: (p as unknown as { hasQuestionToken: () => boolean }).hasQuestionToken(),
      })) ?? [];
  const byName = (name: string, at: SourceFile) => {
    const found = READER.current?.declaration(name, at);
    return found ? typeMembersOfDeclaration(found, depth + 1) : [];
  };
  if (Node.isTypeLiteral(type)) return membersOf(type);
  if (Node.isIntersectionTypeNode(type))
    return type.getTypeNodes().flatMap((part) => typeMembers(part, file, depth + 1));
  if (!Node.isTypeReference(type)) return [];
  const name = type.getTypeName().getText();
  const args = type.getTypeArguments();
  const keysIn = (node: Node | undefined) =>
    new Set(
      node
        ? [node, ...node.getDescendants()]
            .filter((n) => Node.isStringLiteral(n))
            .map((n) => (n as unknown as { getLiteralValue: () => string }).getLiteralValue())
        : [],
    );
  if (/^(Partial|Required|Readonly)$/.test(name) && args[0])
    return typeMembers(args[0], file, depth + 1).map((m) => ({
      ...m,
      optional: name === 'Partial' ? true : name === 'Required' ? false : m.optional,
    }));
  if ((name === 'Pick' || name === 'Omit') && args[0]) {
    const keys = keysIn(args[1]);
    return typeMembers(args[0], file, depth + 1).filter((m) =>
      name === 'Pick' ? keys.has(m.name) : !keys.has(m.name),
    );
  }
  return byName(name, file);
}

/** The fields of a class, interface or alias declaration, and of what it extends. */
function typeMembersOfDeclaration(
  declaration: Node,
  depth: number,
): Array<{ name: string; optional: boolean }> {
  if (depth > 5) return [];
  const file = declaration.getSourceFile();
  if (Node.isTypeAliasDeclaration(declaration)) {
    const node = declaration.getTypeNode();
    return node ? typeMembers(node, file, depth + 1) : [];
  }
  const own =
    (declaration as unknown as { getProperties?: () => Node[] })
      .getProperties?.()
      .filter((p) => Node.isPropertySignature(p) || Node.isPropertyDeclaration(p))
      .filter((p) => !(Node.isPropertyDeclaration(p) && p.isStatic()))
      .map((p) => ({
        name: (p as unknown as { getName: () => string }).getName(),
        optional: (p as unknown as { hasQuestionToken: () => boolean }).hasQuestionToken(),
      })) ?? [];
  const inherited: Array<{ name: string; optional: boolean }> = [];
  const bases = Node.isClassDeclaration(declaration)
    ? [declaration.getExtends()].filter((e) => e !== undefined)
    : Node.isInterfaceDeclaration(declaration)
      ? declaration.getExtends()
      : [];
  for (const base of bases) {
    const expression = base.getExpression();
    // `extends PartialType(CreatePatientDto)`, `PickType(Base, ['a', 'b'])`, `OmitType(…)`.
    if (Node.isCallExpression(expression)) {
      const helper = expression.getExpression().getText();
      const [first, second] = expression.getArguments();
      const keys = new Set(
        second
          ? [second, ...second.getDescendants()]
              .filter((n) => Node.isStringLiteral(n))
              .map((n) => (n as unknown as { getLiteralValue: () => string }).getLiteralValue())
          : [],
      );
      const parts = /IntersectionType/.test(helper)
        ? expression.getArguments()
        : first
          ? [first]
          : [];
      for (const part of parts) {
        const found = READER.current?.declaration(part.getText(), file);
        let members = found ? typeMembersOfDeclaration(found, depth + 1) : [];
        if (/PickType/.test(helper)) members = members.filter((m) => keys.has(m.name));
        if (/OmitType/.test(helper)) members = members.filter((m) => !keys.has(m.name));
        if (/PartialType/.test(helper)) members = members.map((m) => ({ ...m, optional: true }));
        inherited.push(...members);
      }
      continue;
    }
    const found = READER.current?.declaration(expression.getText(), file);
    if (found) inherited.push(...typeMembersOfDeclaration(found, depth + 1));
  }
  // An own declaration wins over the one it inherits.
  const names = new Set(own.map((m) => m.name));
  return [...own, ...inherited.filter((m) => !names.has(m.name))];
}

function parametersOf(fn: Node) {
  return (
    (fn as unknown as { getParameters?: () => Node[] })
      .getParameters?.()
      .filter(Node.isParameterDeclaration) ?? []
  );
}

/** Where a value comes from: the caller, a literal, the clock, or code before the write. */
function originOf(value: Node, fn: Node, depth = 0): ValueOrigin {
  const text = value.getText();
  if (
    Node.isStringLiteral(value) ||
    Node.isNumericLiteral(value) ||
    Node.isNoSubstitutionTemplateLiteral(value) ||
    (Node.isArrayLiteralExpression(value) && value.getElements().length === 0) ||
    /^(true|false|null|undefined)$/.test(text)
  )
    return 'fixed';
  if (/^(new Date\b|Date\.now\(|\w*[Nn]ow\w*\()/.test(text)) return 'time';
  // Built from what was sent, not the value itself: `Pharmacist ${phone.slice(-4)}`, `a - b`.
  if (Node.isTemplateExpression(value)) return 'computed';
  if (Node.isBinaryExpression(value) && /^[-+*/%]$/.test(value.getOperatorToken().getText()))
    return 'computed';
  // The first name the expression reads: `input` in `input.sku || undefined`.
  const root = Node.isIdentifier(value)
    ? value
    : value.getDescendants().find((node) => Node.isIdentifier(node));
  if (!root) return 'computed';
  const name = root.getText();
  const parameter = parametersOf(fn).find((entry) => {
    const binding = entry.getNameNode();
    return Node.isIdentifier(binding)
      ? binding.getText() === name
      : binding.getDescendants().some((node) => Node.isIdentifier(node) && node.getText() === name);
  });
  if (parameter) return 'input';
  // `const { name } = input` or `const qty = input.quantity`: one step back.
  const declaration = localVariable(fn, name);
  const init = Node.isVariableDeclaration(declaration) ? declaration.getInitializer() : undefined;
  // `const name = displayName?.trim()`: a trimmed or defaulted value sent is still the value sent.
  const plain = init ? unwrapped(init) : undefined;
  if (plain && depth === 0 && !Node.isCallExpression(plain) && !Node.isAwaitExpression(plain))
    return originOf(plain, fn, 1) === 'input' ? 'input' : 'computed';
  return 'computed';
}

/** `{ key: 'mrp' }` for `input.mrp`, `data.fileName || "x"`; nothing for `nowIso()`. */
function keyOf(value: Node): { key?: string } {
  if (Node.isIdentifier(value)) return { key: value.getText() };
  const access = [value, ...value.getDescendants()].find((node) =>
    Node.isPropertyAccessExpression(node),
  );
  if (!access || !Node.isPropertyAccessExpression(access)) return {};
  // The outermost access of that chain: `ownerId` in `params.medicine.ownerId`.
  let outer = access;
  for (let parent = outer.getParent(); parent && Node.isPropertyAccessExpression(parent);) {
    outer = parent;
    parent = outer.getParent();
  }
  return { key: outer.getName() };
}

type FieldUses = Omit<
  DatabaseField,
  'name' | 'origin' | 'type' | 'required' | 'unique' | 'indexed' | 'ref' | 'source'
>;

function emptyUses(): FieldUses {
  return {
    writes: [],
    lookups: [],
    sorts: [],
    projected: [],
    enteredIn: [],
    shownIn: [],
    apis: [],
    validation: [],
    mentions: [],
    onlyOnCreate: [],
    changedBy: [],
    outcomes: [],
  };
}

/** What each scenario does to a field: from its writes in that scenario, or what their absence means. */
function outcomesOf(
  field: DatabaseField,
  scenarios: readonly Scenario[],
  /** Writes whose keys were read: any other write's content is unknown, not empty. */
  readOps: ReadonlySet<string>,
  fields: readonly DatabaseField[],
): ScenarioOutcome[] {
  const sends = new Set(field.enteredIn.map((entry) => entry.endpoint));
  const parent = field.name.includes('[]') ? field.name.split('[]')[0] : undefined;
  const parentField = parent ? fields.find((other) => other.name === parent) : undefined;
  return scenarios.map((scenario): ScenarioOutcome => {
    if (scenario.nothing)
      return {
        scenario: scenario.id,
        does: 'nothing',
        ...(scenario.nothing.source ? { source: scenario.nothing.source } : {}),
      };
    if (scenario.writes.some((write) => write.effect === 'delete'))
      return { scenario: scenario.id, does: 'removed' };
    const ids = new Set(scenario.writes.map((write) => write.nodeId));
    const write = field.writes.find((w) => ids.has(w.nodeId));
    // An item field whose whole list is written here and no item field read: it changes with
    // the list. When other item fields were read (a re-date changes two), this one is kept.
    const listWrite = !write ? parentField?.writes.find((w) => ids.has(w.nodeId)) : undefined;
    const siblingsRead =
      parent !== undefined &&
      fields.some(
        (other) =>
          other.name.startsWith(`${parent}[].`) && other.writes.some((w) => ids.has(w.nodeId)),
      );
    if (listWrite && siblingsRead) return { scenario: scenario.id, does: 'keeps' };
    if (listWrite)
      return {
        scenario: scenario.id,
        does: 'list-changed',
        ...(listWrite.rewrittenBy ? { by: listWrite.rewrittenBy } : {}),
        ...(listWrite.source ? { source: listWrite.source } : {}),
      };
    // A helper recalculates this field in this case, but the save leaves it out.
    if (!write) {
      const helpers = new Set(
        fields.flatMap((other) =>
          other.writes.filter((w) => ids.has(w.nodeId) && w.derivedIn).map((w) => w.derivedIn!),
        ),
      );
      const worker = field.writes.find((w) => w.derivedIn && helpers.has(w.derivedIn))?.derivedIn;
      if (worker) return { scenario: scenario.id, does: 'stale', by: [worker] };
    }
    if (write) {
      // Every way this case writes it: a merged batch adds, a new batch sets.
      const ways = writeWays(field.writes.filter((w) => ids.has(w.nodeId)));
      const [first, ...rest] = ways;
      return {
        scenario: scenario.id,
        ...first!,
        ...(write.derivedIn ? { derivedIn: write.derivedIn } : {}),
        ...(write.source ? { source: write.source } : {}),
        ...(rest.length ? { alternatives: ways } : {}),
      };
    }
    if (scenario.writes.every((w) => !readOps.has(w.nodeId)))
      return { scenario: scenario.id, does: 'unread' };
    const updates = scenario.writes.some((w) => w.effect !== 'create');
    if (!updates) return { scenario: scenario.id, does: 'not-set' };
    // The key the update finds the record by is not a value it leaves behind.
    const findsBy = field.lookups.some(
      (lookup) => ids.has(lookup.nodeId) || lookup.alsoIn.some((other) => ids.has(other.nodeId)),
    );
    if (findsBy) return { scenario: scenario.id, does: 'matched' };
    return {
      scenario: scenario.id,
      does: scenario.endpoint && sends.has(scenario.endpoint) ? 'ignored' : 'keeps',
    };
  });
}

const USE_ORDER: FieldApiUse['does'][] = ['saves', 'finds', 'sorts', 'uses', 'returns', 'loads'];

interface ReadOp {
  op: FlowNode;
  /** The pipeline, for an aggregate: it hands the field back only when it names it. */
  aggregate?: string;
  /** The function the read is in: whether it goes on to use the field. */
  fnText: string;
}

/** Every endpoint that touches a field: what it does with it, and who calls it. */
function apisOf(
  graph: FlowGraph,
  field: DatabaseField,
  readOps: readonly ReadOp[],
  frontend: Frontend,
  writerFns: ReadonlySet<string>,
): FieldApi[] {
  const shownFiles = new Set(field.shownIn.map((place) => place.source.file));
  const byEndpoint = new Map<string, FieldApi>();
  const add = (nodeId: string, useFor: FieldApiUse | ((route: FlowNode) => FieldApiUse)) => {
    for (const route of routesRunning(graph, nodeId)) {
      const use = typeof useFor === 'function' ? useFor(route) : useFor;
      let api = byEndpoint.get(route.id);
      if (!api) {
        const calledFrom = graph
          .predecessors(route.id, ['handled-by'])
          .map((call) => call.source)
          .filter((source): source is SourceRef => source !== undefined);
        api = {
          endpoint: route.label,
          ...(route.source ? { source: route.source } : {}),
          uses: [],
          calledFrom: [...new Map(calledFrom.map((at) => [`${at.file}:${at.line}`, at])).values()],
        };
        byEndpoint.set(route.id, api);
      }
      // Two reads in one function are one fact for the reader.
      const read = (does: FieldApiUse['does']) => ['uses', 'returns', 'loads'].includes(does);
      const same = (other: FieldApiUse) =>
        other.does === use.does &&
        other.in === use.in &&
        (read(use.does) ||
          (use.does === 'finds' && other.match === use.match) ||
          other.source?.line === use.source?.line);
      if (!api.uses.some(same)) api.uses.push(use);
    }
  };
  const at = (site: FieldUseSite) => ({
    ...(site.in ? { in: site.in } : {}),
    ...(site.source ? { source: site.source } : {}),
  });
  for (const write of field.writes)
    add(write.nodeId, (route) => {
      const hop = pathHops(graph, route, write.nodeId, writerFns);
      return {
        does: 'saves',
        value: write.value,
        how: write.how,
        ...at(write),
        ...(hop.via ? { via: hop.via } : {}),
        ...(hop.queued ? { queued: hop.queued } : {}),
      };
    });
  for (const lookup of field.lookups)
    for (const nodeId of [lookup.nodeId, ...lookup.alsoIn.map((other) => other.nodeId)])
      add(nodeId, {
        does: 'finds',
        ...(lookup.match ? { match: lookup.match } : {}),
        ...(lookup.in ? { in: lookup.in } : {}),
        ...((lookup.builtAt ?? lookup.source) ? { source: lookup.builtAt ?? lookup.source } : {}),
      });
  for (const sort of field.sorts) add(sort.nodeId, { does: 'sorts', ...at(sort) });
  const named = new RegExp(`\\b${field.name.replace(/[$]/g, '\\$')}\\b`);
  const listed = new Set([...field.lookups, ...field.sorts].map((site) => site.nodeId));
  for (const { op, aggregate, fnText } of readOps) {
    if (listed.has(op.id)) continue;
    if (aggregate !== undefined && !named.test(aggregate)) continue;
    const method = graph.predecessors(op.id, ['queries'])[0];
    const where = {
      ...(method ? { in: method.label.split('.').pop()! } : {}),
      ...(op.source ? { source: op.source } : {}),
    };
    // Named in the function: it is used. Otherwise a GET hands the records back,
    // and anything else only loads them on the way.
    add(op.id, (route) => ({
      does: named.test(fnText)
        ? 'uses'
        : route.meta?.['httpMethod'] === 'GET'
          ? 'returns'
          : 'loads',
      ...(!named.test(fnText) && route.meta?.['httpMethod'] === 'GET'
        ? { shown: frontend.screenFiles(route.label).some((file) => shownFiles.has(file)) }
        : {}),
      ...where,
    }));
  }
  const rank = (api: FieldApi) => Math.min(...api.uses.map((use) => USE_ORDER.indexOf(use.does)));
  for (const api of byEndpoint.values())
    api.uses.sort((a, b) => USE_ORDER.indexOf(a.does) - USE_ORDER.indexOf(b.does));
  return [...byEndpoint.values()].sort(
    (a, b) => rank(a) - rank(b) || a.endpoint.localeCompare(b.endpoint),
  );
}

/** Steps that run in the browser: where a screen reads what it loaded. */
const FRONT_KINDS = new Set(['ui-action', 'component', 'handler', 'hook', 'state', 'api-call']);

const entryKey = (entry: FieldEntry): string =>
  `${entry.source?.file}:${entry.source?.line}:${entry.endpoint ?? ''}:${entry.savedBy.in ?? ''}`;

/** The form inputs that feed a field: the caller's key, matched to a form key of the same action. */
function entriesOf(graph: FlowGraph, field: DatabaseField, frontend: Frontend): FieldEntry[] {
  const found = new Map<string, FieldEntry>();
  for (const write of field.writes) {
    const keys = write.inputKey ? [write.inputKey] : (write.derivedFrom ?? []).map(leafOf);
    if (!keys.length) continue;
    for (const action of write.actions) {
      const input = frontend.form(action.flowId).find((entry) => keys.includes(entry.key));
      if (!input) continue;
      const endpoint = frontend.endpointOf(action.flowId, write.nodeId);
      const route = graph.nodesOfKind('route').find((node) => node.label === endpoint);
      const queued = route ? pathHops(graph, route, write.nodeId, new Set()).queued : undefined;
      // Keyed with the endpoint and the writer: one form used to add and to edit is two paths.
      const id = `${input.at.file}:${input.at.line}:${endpoint ?? ''}:${write.in ?? ''}`;
      // One dialog opened from several places is one path, reached by every one of them.
      const seen = found.get(id);
      if (seen) {
        if (!seen.actions.some((a) => a.flowId === action.flowId))
          seen.actions.push({ flowId: action.flowId, title: action.title });
        continue;
      }
      found.set(id, {
        actions: [{ flowId: action.flowId, title: action.title }],
        kind: 'form',
        key: input.key,
        ...(input.label ? { label: input.label } : {}),
        ...(input.picked ? { picked: true as const } : {}),
        flowId: action.flowId,
        title: action.title,
        source: input.at,
        ...(endpoint ? { endpoint } : {}),
        savedBy: {
          ...(write.in ? { in: write.in } : {}),
          value: write.value,
          how: write.how,
          ...(write.source ? { source: write.source } : {}),
          ...(queued ? { queued } : {}),
          ...(write.derivedIn ? { derivedIn: write.derivedIn } : {}),
          ...(write.derivedFrom ? { derivedFrom: write.derivedFrom } : {}),
        },
      });
    }
  }
  return [...found.values()];
}

/**
 * Code that builds the value and sends it to be saved: an import parser
 * (`genericName: cell(row, "genericName")`) in the files of an action whose
 * request reaches a write of the field. When the request reaches that write
 * only through another writer (`importReconcileMedicine` before
 * `upsertMedicine`), that writer is named as the step in between.
 */
function codeEntriesOf(
  graph: FlowGraph,
  field: DatabaseField,
  frontend: Frontend,
  writerFns: ReadonlySet<string>,
): FieldEntry[] {
  const found = new Map<string, FieldEntry>();
  // A form's own file is already its form path (`genericName: m?.genericName ?? ""` prefills it).
  const formFiles = new Set(field.enteredIn.map((entry) => entry.source?.file));
  // Code inside an action that already has a form path for the field is a hop of that path (the request body).
  const formFlows = new Set(field.enteredIn.map((entry) => entry.flowId));
  for (const mention of field.mentions) {
    if (mention.kind !== 'sets' || formFiles.has(mention.source.file)) continue;
    // `genericName: ""` is a default, not where the value comes from.
    if (/:\s*(""|''|``|0|null|undefined|false|true|\[\]|\{\})\s*$/.test(mention.code)) continue;
    for (const write of field.writes) {
      const own = new Set(graph.predecessors(write.nodeId, ['queries']).map((n) => n.id));
      const direct = new Set(
        routesRunning(
          graph,
          write.nodeId,
          new Set([...writerFns].filter((id) => !own.has(id))),
        ).map((r) => r.label),
      );
      for (const route of routesRunning(graph, write.nodeId)) {
        const reaching = frontend
          .flowsCalling(route.label)
          .filter(
            (candidate) =>
              !formFlows.has(candidate.id) &&
              frontend.flowFiles(candidate, { components: false }).includes(mention.source.file),
          );
        const flow = reaching[0];
        if (!flow) continue;
        // Reached only through another writer: name it.
        const via = direct.has(route.label)
          ? undefined
          : routesVia(graph, write.nodeId, route.id, writerFns, own);
        const { queued } = pathHops(graph, route, write.nodeId, writerFns);
        const key = `${mention.source.file}:${mention.source.line}:${route.label}`;
        if (found.has(key)) continue;
        found.set(key, {
          actions: reaching.map((candidate) => ({ flowId: candidate.id, title: candidate.title })),
          kind: 'code',
          key: field.name,
          code: mention.code,
          flowId: flow.id,
          title: flow.title,
          source: mention.source,
          endpoint: route.label,
          savedBy: {
            ...(write.in ? { in: write.in } : {}),
            value: write.value,
            how: write.how,
            ...(write.source ? { source: write.source } : {}),
            ...(via ? { via } : {}),
            ...(queued ? { queued } : {}),
          },
        });
      }
    }
  }
  return [...found.values()];
}

/** The other writer a route passes through on its way to a db-op. */
function routesVia(
  graph: FlowGraph,
  nodeId: string,
  routeId: string,
  writerFns: ReadonlySet<string>,
  own: ReadonlySet<string>,
): string | undefined {
  for (const id of writerFns) {
    if (own.has(id)) continue;
    const callsOwn = [...own].some((fn) =>
      graph.predecessors(fn, ['calls']).some((n) => n.id === id),
    );
    if (!callsOwn) continue;
    if (routesRunning(graph, id).some((route) => route.id === routeId))
      return graph.node(id)?.label.split('.').pop();
  }
  return undefined;
}

/**
 * The frontend, read once per report: each action's form, and each screen
 * file's property reads by name.
 */
class Frontend {
  private readonly forms = new Map<string, FormField[]>();
  private readonly reads = new Map<string, Map<string, Node[]>>();
  private readonly flowById: Map<string, FeatureFlow>;

  constructor(
    private readonly graph: FlowGraph,
    private readonly flows: readonly FeatureFlow[],
    private readonly reader: SourceReader,
  ) {
    this.flowById = new Map(flows.map((flow) => [flow.id, flow]));
  }

  /** The action's request that reaches this db-op, or its first one. */
  endpointOf(flowId: string, nodeId?: string): string | undefined {
    const endpoints = this.flowById.get(flowId)?.endpoints ?? [];
    const reaching = nodeId
      ? new Set(routesRunning(this.graph, nodeId).map((route) => route.label))
      : undefined;
    return endpoints.find((endpoint) => reaching?.has(endpoint)) ?? endpoints[0];
  }

  /** The flows that send this request. */
  flowsCalling(endpoint: string): FeatureFlow[] {
    return [...this.flowById.values()].filter((flow) => flow.endpoints.includes(endpoint));
  }

  /** The frontend files of the actions that send a request, and the files they import. */
  screenFiles(endpoint: string): string[] {
    return [...new Set(this.flowsCalling(endpoint).flatMap((flow) => this.flowFiles(flow)))];
  }

  /** One action's frontend files, and the files they import. */
  /**
   * The browser files an action runs through, and what they import. With
   * `components: false`, an imported component is left out: a dialog the page
   * renders runs its own actions, not this one.
   */
  flowFiles(flow: FeatureFlow, { components = true } = {}): string[] {
    const imports = this.graph.meta.imports ?? {};
    const files = new Set<string>();
    for (const step of flow.steps)
      if (FRONT_KINDS.has(step.kind) && step.file) {
        files.add(step.file);
        for (const imported of imports[step.file] ?? [])
          if (components || !/\.[jt]sx$/.test(imported)) files.add(imported);
      }
    return [...files];
  }

  form(flowId: string): FormField[] {
    let found = this.forms.get(flowId);
    if (!found) {
      const flow = this.flowById.get(flowId);
      try {
        found = flow ? formFieldsOf(this.graph, flow, this.reader, this.flows) : [];
      } catch {
        found = [];
      }
      this.forms.set(flowId, found);
    }
    return found;
  }

  /** `m.sellingPrice` in these files, with the label around each read. */
  shown(
    files: readonly string[],
    field: string,
    siblings: readonly string[],
    collection: string,
  ): FieldDisplay[] {
    if (!/^[A-Za-z_$][\w$]*$/.test(field)) return [];
    const shown: FieldDisplay[] = [];
    const others = new Set(siblings);
    for (const file of files) {
      const reads = this.readsIn(file);
      // Receivers that also read another field of this record: `m.name` beside `m.sellingPrice`.
      // `id`, `name` and the like sit on almost every object: two of those, or one other, make a record.
      const weight = new Map<string, number>();
      for (const [name, nodes] of reads)
        if (others.has(name))
          for (const receiver of new Set(
            nodes
              .filter((node) => Node.isPropertyAccessExpression(node))
              .map((node) => (node as PropertyAccessExpression).getExpression().getText()),
          ))
            weight.set(receiver, (weight.get(receiver) ?? 0) + (COMMON_KEYS.has(name) ? 0.5 : 1));
      const records = new Set(
        [...weight]
          .filter(([receiver, w]) => w >= 1 || namedAfter(receiver, collection))
          .map(([receiver]) => receiver),
      );
      for (const node of reads.get(field) ?? []) {
        if (Node.isPropertyAccessExpression(node) && !records.has(node.getExpression().getText()))
          continue;
        // Every read tells which variables hold a record; only some put the value on screen.
        if (!rendered(node)) continue;
        const label = labelNear(node);
        shown.push({
          code: condense(displayExpression(node).getText(), 90),
          ...(label ? { label } : {}),
          source: this.reader.point(node),
        });
      }
    }
    return shown;
  }

  private readsIn(file: string): Map<string, Node[]> {
    let found = this.reads.get(file);
    if (found) return found;
    found = new Map();
    let source: SourceFile | undefined;
    try {
      source = this.reader.file(file);
    } catch {
      source = undefined;
    }
    for (const access of source?.getDescendantsOfKind(SyntaxKind.PropertyAccessExpression) ?? []) {
      // `values.mrp = …` writes the form, it does not show the record.
      const parent = access.getParent();
      if (
        Node.isBinaryExpression(parent) &&
        parent.getLeft() === access &&
        parent.getOperatorToken().getKind() === SyntaxKind.EqualsToken
      )
        continue;
      // By its last name: `r.raw.mrp` reads an uploaded row as given, not a stored record.
      if (NOT_RECORDS.test(access.getExpression().getText().split('.').pop() ?? '')) continue;
      const list = found.get(access.getName()) ?? [];
      list.push(access);
      found.set(access.getName(), list);
    }
    this.reads.set(file, found);
    return found;
  }
}

/** `customer` for `customers`, `medicine` for `medicines`: a variable named after the collection. */
function namedAfter(receiver: string, collection: string): boolean {
  const last = (receiver.split(/[.?]/).filter(Boolean).pop() ?? '').toLowerCase();
  const name = collection.toLowerCase();
  return (
    last.length >= 3 &&
    (name === last || name.startsWith(last) || last.startsWith(name.replace(/e?s$/, '')))
  );
}

/** Keys nearly every object has: on their own they do not say which record a variable holds. */
const COMMON_KEYS = new Set([
  'id',
  '_id',
  'name',
  'title',
  'type',
  'status',
  'createdAt',
  'updatedAt',
]);

/** Receivers that hold something other than a loaded record: a file, an event, the form being edited. */
const NOT_RECORDS =
  /^(file|files|event|e|err|error|window|document|process|router|values|form|draft|props|params|raw)\??$/;

/** The expression a read sits in: `formatCurrency(m.sellingPrice)`, not just `m.sellingPrice`. */
function displayExpression(node: Node): Node {
  let current = node;
  for (let hops = 0; hops < 3; hops += 1) {
    const parent = current.getParent();
    if (
      !parent ||
      Node.isJsxExpression(parent) ||
      Node.isPropertyAssignment(parent) ||
      Node.isVariableDeclaration(parent) ||
      Node.isJsxAttribute(parent) ||
      Node.isBlock(parent) ||
      Node.isExpressionStatement(parent) ||
      Node.isReturnStatement(parent)
    )
      break;
    current = parent;
  }
  return current;
}

/** `{ label: "Current MRP", value: … }` or `<Field label="MRP" value={…} />`. */
function labelNear(node: Node): string | undefined {
  // Words on screen only, and never the read itself: `label: medicine?.name ?? "Edit"`.
  const words = (value: Node | null | undefined): string | undefined =>
    value &&
    value !== node &&
    !node.getAncestors().includes(value) &&
    (Node.isStringLiteral(value) || value.getDescendantsOfKind(SyntaxKind.StringLiteral).length > 0)
      ? labelText(value)
      : undefined;
  for (const ancestor of node.getAncestors().slice(0, 8)) {
    if (Node.isObjectLiteralExpression(ancestor)) {
      const label = ancestor.getProperty('label');
      const found = words(
        label && Node.isPropertyAssignment(label) ? label.getInitializer() : undefined,
      );
      if (found) return found;
    }
    const opening = Node.isJsxElement(ancestor) ? ancestor.getOpeningElement() : ancestor;
    if (Node.isJsxSelfClosingElement(opening) || Node.isJsxOpeningElement(opening)) {
      const found = words(attribute(opening, 'label'));
      if (found) return found;
    }
  }
  return undefined;
}

/**
 * Which functions only set a field when they create a record.
 *
 * `upsertMedicine` inserts `genericName`, but when it matches an existing record
 * it runs an update that leaves `genericName` out — so sending a corrected value
 * through it again changes nothing. Read per function, from the writes already
 * found: inserts the field, has an update path, and that path skips the field.
 */
function markUpdatePaths(graph: FlowGraph, fields: DatabaseField[]): void {
  const updated = new Map<string, Set<string>>();
  const opsOf = new Map<string, Set<string>>();
  for (const field of fields) {
    for (const write of field.writes) {
      if (!write.in) continue;
      (opsOf.get(write.in) ?? opsOf.set(write.in, new Set()).get(write.in)!).add(write.nodeId);
      if (write.how === 'insert' || write.how === '$setOnInsert') continue;
      (updated.get(write.in) ?? updated.set(write.in, new Set()).get(write.in)!).add(field.name);
    }
  }
  // The function nodes behind each writer: what the call graph knows them by.
  const fnIds = new Map<string, Set<string>>();
  for (const [fn, ops] of opsOf)
    fnIds.set(
      fn,
      new Set([...ops].flatMap((op) => graph.predecessors(op, ['queries']).map((n) => n.id))),
    );
  const writerIds = new Set([...fnIds.values()].flatMap((ids) => [...ids]));
  const endpointsOf = (fn: string, stop?: ReadonlySet<string>) =>
    [
      ...new Set(
        [...(opsOf.get(fn) ?? [])]
          .flatMap((id) => routesRunning(graph, id, stop))
          .map((r) => r.label),
      ),
    ].sort();
  for (const field of fields) {
    const inserts = new Set(
      field.writes.filter((w) => w.how === 'insert' && w.in).map((w) => w.in!),
    );
    const changes = new Set(
      field.writes
        .filter((w) => w.how !== 'insert' && w.how !== '$setOnInsert' && w.in)
        .map((w) => w.in!),
    );
    field.onlyOnCreate = [...inserts]
      .filter((fn) => updated.has(fn) && !updated.get(fn)!.has(field.name))
      .map((fn) => {
        const own = fnIds.get(fn) ?? new Set<string>();
        // Other writers: an endpoint reached only through one of them is that writer's path.
        const others = new Set([...writerIds].filter((id) => !own.has(id)));
        const callers = new Set(
          [...own].flatMap((id) => graph.predecessors(id, ['calls'])).map((n) => n.id),
        );
        const matchedFirstBy = [...fnIds]
          .filter(
            ([other, ids]) =>
              other !== fn && !changes.has(other) && [...ids].some((id) => callers.has(id)),
          )
          .map(([other]) => ({ in: other, endpoints: endpointsOf(other) }));
        return { in: fn, endpoints: endpointsOf(fn, others), matchedFirstBy };
      });
    field.changedBy = [...changes].sort().map((fn) => ({ in: fn, endpoints: endpointsOf(fn) }));
  }
}

/**
 * The whole project, read once per report: every validation schema, and every
 * place a key is set or named outside the database calls.
 */
class ProjectCode {
  private schemas?: Map<string, FieldValidation[]>;
  /** Each schema's field names, keyed `file:schema`. */
  private readonly schemaFields = new Map<string, string[]>();
  private names?: Map<string, NameUse[]>;

  constructor(
    private readonly graph: FlowGraph,
    private readonly reader: SourceReader,
  ) {}

  /** What a collection's fields share, worked out once: its leaf names, and the functions its queries are in. */
  scopeFor(ops: readonly FlowNode[], names: ReadonlySet<string>): CollectionScope {
    const inQueries = ops
      .map((op) => {
        try {
          const operation = String(op.meta?.['operation'] ?? '');
          const call = locateQueryCall(this.reader, op.source?.file, op.source?.line, operation);
          return call && nearestFunction(call);
        } catch {
          return undefined;
        }
      })
      .filter((fn): fn is Node => fn !== undefined);
    return { inQueries, leaves: new Set([...names].map(leafOf)) };
  }

  about(
    field: DatabaseField,
    scope: CollectionScope,
  ): Pick<DatabaseField, 'validation' | 'mentions'> {
    this.load();
    const { leaves, inQueries } = scope;
    // A schema checks this collection's records when most of its fields are this collection's.
    const validation = (this.schemas!.get(leafOf(field.name)) ?? []).filter((rule) => {
      const fields = this.schemaFields.get(`${rule.source.file}:${rule.schema}`) ?? [];
      return fields.filter((name) => leaves.has(name)).length * 2 >= fields.length;
    });
    const leaf = leafOf(field.name);
    const candidates = this.names!.get(leaf) ?? [];
    // Only beside this collection's other fields: a toast's `description` is not a medicine's.
    const besideOthers = (candidate: NameUse) => {
      const keys = keysAround(candidate);
      if (!keys) return false;
      let others = 0;
      for (const key of keys) if (key !== leaf && leaves.has(key) && ++others >= 2) return true;
      return false;
    };
    // Code already shown elsewhere on the field: the functions with its queries, its form inputs.
    const shown = new Set(
      field.enteredIn.map((entry) => `${entry.source?.file}:${entry.source?.line}`),
    );
    const readFrom = READ_FROM.get(field.name) ?? [];
    const mentions: FieldMention[] = [];
    const lines = new Set<string>();
    for (const candidate of candidates) {
      const { kind, node } = candidate;
      if (!besideOthers(candidate)) continue;
      if (inQueries.some((fn) => within(node, fn))) continue;
      const at = this.reader.point(node);
      const line = `${at.file}:${at.line}`;
      if (shown.has(line) || lines.has(line)) continue;
      if (readFrom.some((used) => within(node, used))) continue;
      lines.add(line);
      const fn = nearestFunction(node);
      mentions.push({
        kind,
        code: condense(mentionContext(node).getText(), 140),
        ...(fn ? { in: nameOf(fn) } : {}),
        source: at,
      });
    }
    mentions.sort((a, b) => (a.kind === b.kind ? 0 : a.kind === 'sets' ? -1 : 1));
    return {
      validation,
      mentions,
    };
  }

  private load(): void {
    if (this.schemas) return;
    this.schemas = new Map();
    this.names = new Map();
    const imports = this.graph.meta.imports ?? {};
    const files = new Set([...Object.keys(imports), ...Object.values(imports).flat()]);
    for (const rel of files) {
      let source: SourceFile | undefined;
      try {
        source = this.reader.file(rel);
      } catch {
        source = undefined;
      }
      if (!source) continue;
      this.readSchemas(source);
      this.readNames(source);
    }
  }

  private readSchemas(source: SourceFile): void {
    for (const declaration of source.getDescendantsOfKind(SyntaxKind.VariableDeclaration)) {
      const text = declaration.getInitializer()?.getText() ?? '';
      if (!/\b(z|yup|Joi)\.object\(|\.shape\(\{/.test(text.slice(0, 400))) continue;
      let facts;
      try {
        facts = readSchema(this.reader, declaration.getName(), source);
      } catch {
        facts = undefined;
      }
      if (facts)
        this.schemaFields.set(
          `${facts.at.file}:${facts.name}`,
          facts.fields.map((entry) => entry.name),
        );
      for (const entry of facts?.fields ?? []) {
        const list = this.schemas!.get(entry.name) ?? [];
        list.push({
          schema: facts!.name,
          library: facts!.library,
          ...(entry.type ? { type: entry.type } : {}),
          required: entry.required,
          rules: entry.rules,
          transforms: entry.transforms,
          source: entry.at ?? facts!.at,
        });
        this.schemas!.set(entry.name, list);
      }
    }
  }

  private readNames(source: SourceFile): void {
    const add = (name: string, kind: FieldMention['kind'], node: Node) => {
      const list = this.names!.get(name) ?? [];
      list.push({ kind, node });
      this.names!.set(name, list);
    };
    for (const node of source.getDescendants()) {
      if (Node.isPropertyAssignment(node) || Node.isShorthandPropertyAssignment(node)) {
        // A schema's own shape is reported as its validation, not as a mention.
        const call = node.getParent()?.getParent();
        if (
          call &&
          Node.isCallExpression(call) &&
          /\b(z|yup|Joi)\.object$|\.shape$/.test(call.getExpression().getText())
        )
          continue;
        add(node.getName().replace(/^['"`]|['"`]$/g, ''), 'sets', node);
      } else if (Node.isStringLiteral(node) && /^[A-Za-z_$][\w$]*$/.test(node.getLiteralValue())) {
        const parent = node.getParent();
        // An import path or a property name is not the key being named.
        if (
          Node.isImportDeclaration(parent) ||
          Node.isExportDeclaration(parent) ||
          (Node.isPropertyAssignment(parent) && parent.getNameNode() === node)
        )
          continue;
        add(node.getLiteralValue(), 'names', node);
      }
    }
  }
}

interface CollectionScope {
  inQueries: Node[];
  leaves: ReadonlySet<string>;
}

interface NameUse {
  kind: FieldMention['kind'];
  node: Node;
  /** The keys of the object or array around it, read once. */
  keys?: Set<string> | null;
}

const KEYS_OF_CONTAINER = new WeakMap<Node, Set<string>>();

/** The keys, and whole-name strings, of the literal around a use: read once per literal. */
function keysAround(use: NameUse): Set<string> | null {
  if (use.keys !== undefined) return use.keys;
  const container = outerLiteral(use.node);
  if (!container) return (use.keys = null);
  let keys = KEYS_OF_CONTAINER.get(container);
  if (!keys) {
    keys = new Set<string>();
    for (const child of container.getDescendants()) {
      if (Node.isPropertyAssignment(child) || Node.isShorthandPropertyAssignment(child))
        keys.add(child.getName().replace(/^['"`]|['"`]$/g, ''));
      else if (Node.isStringLiteral(child)) keys.add(child.getLiteralValue());
    }
    KEYS_OF_CONTAINER.set(container, keys);
  }
  return (use.keys = keys);
}

/** The outermost object or array literal around a node, up to three levels out. */
function outerLiteral(node: Node): Node | undefined {
  let found: Node | undefined;
  let levels = 0;
  for (const ancestor of node.getAncestors()) {
    if (Node.isObjectLiteralExpression(ancestor) || Node.isArrayLiteralExpression(ancestor)) {
      found = ancestor;
      if (++levels >= 3) break;
    }
    if (Node.isBlock(ancestor) || Node.isSourceFile(ancestor)) break;
  }
  return found;
}

function within(node: Node, outer: Node): boolean {
  return (
    node.getSourceFile() === outer.getSourceFile() &&
    outer.getPos() <= node.getPos() &&
    node.getEnd() <= outer.getEnd()
  );
}

/** Enough code around a mention to read it: the property, or the object or call naming it. */
function mentionContext(node: Node): Node {
  if (!Node.isStringLiteral(node)) return node;
  const parent = node.getParent();
  if (parent && Node.isPropertyAssignment(parent)) return parent.getParent() ?? parent;
  if (parent && Node.isCallExpression(parent)) return parent;
  return parent ?? node;
}

type WriteWay = Pick<ScenarioOutcome, 'does' | 'value' | 'from' | 'onlyWhen' | 'onlyWhenWords'>;

/**
 * The distinct ways a set of writes changes a field, with the conditions on each,
 * simplified before they are said: `x` under `A` and under `not A` is always, and
 * `(not A and B) or A` is `A or B`.
 */
function writeWays(writes: readonly FieldWrite[]): WriteWay[] {
  const doesOf = (write: FieldWrite): ScenarioOutcome['does'] =>
    write.derivedIn
      ? 'recalculated'
      : write.adds || write.how === '$inc' || write.how === '$push' || write.how === '$addToSet'
        ? 'adds'
        : write.takes || write.how === '$pull' || write.how === '$pullAll' || write.how === '$unset'
          ? 'removes'
          : 'sets';
  const groups = new Map<string, { way: WriteWay; terms: Terms }>();
  for (const write of writes) {
    const does = doesOf(write);
    const key = `${does}|${write.value}`;
    const group =
      groups.get(key) ??
      groups.set(key, { way: { does, value: write.value, from: write.from }, terms: [] }).get(key)!;
    group.terms.push(write.when ?? []);
  }
  return [...groups.values()].map(({ way, terms }) => {
    const said = render(simplify(terms));
    return said.code ? { ...way, onlyWhen: said.code, onlyWhenWords: said.words! } : way;
  });
}

/** One write's conditions, said as code and in words. */
function whenOf(
  when: readonly Literal[] | undefined,
): Pick<FieldWrite, 'when' | 'onlyWhen' | 'onlyWhenWords'> {
  if (!when?.length) return {};
  const said = render(simplify([[...when]]));
  return said.code ? { when: [...when], onlyWhen: said.code, onlyWhenWords: said.words! } : {};
}

function dedupeLiterals(list: readonly Literal[]): Literal[] {
  return [...new Map(list.map((l) => [`${l.holds}|${l.code}`, l])).values()];
}

/** The values an expression can end up as: both sides of `? :`, inside parentheses. */
function sidesOf(node: Node): Node[] {
  if (Node.isParenthesizedExpression(node)) return sidesOf(node.getExpression());
  if (Node.isConditionalExpression(node))
    return [...sidesOf(node.getWhenTrue()), ...sidesOf(node.getWhenFalse())];
  return [node];
}

/**
 * What a `doc.save()` writes: every field set on `doc` since it was loaded —
 * `doc.uuid = uuid`, `Object.assign(doc, changes)`, `doc.set({ … })`, and a copy
 * loop `doc[key] = dto[key]` (the keys of `dto`).
 */
function savedKeys(name: string, call: Node, fn: Node): KeyValue[] {
  const load = loadedFrom(name, call);
  const from = load ? load.getEnd() : fn.getStart();
  const between = (node: Node) => node.getStart() >= from && node.getEnd() <= call.getStart();
  const keys: KeyValue[] = [];
  for (const node of fn.getDescendantsOfKind(SyntaxKind.BinaryExpression)) {
    if (node.getOperatorToken().getKind() !== SyntaxKind.EqualsToken || !between(node)) continue;
    const left = node.getLeft();
    if (Node.isPropertyAccessExpression(left) && left.getExpression().getText() === name)
      keys.push(keyValue(left.getName(), node.getRight(), fn));
    // `doc[key] = dto[key]`: a copy of every key `dto` holds.
    else if (Node.isElementAccessExpression(left) && left.getExpression().getText() === name) {
      const right = node.getRight();
      const source = Node.isElementAccessExpression(right) ? right.getExpression() : undefined;
      if (source && Node.isIdentifier(source)) keys.push(...keysOf(source, fn, 1));
    }
  }
  for (const node of fn.getDescendantsOfKind(SyntaxKind.CallExpression)) {
    if (!between(node)) continue;
    const callee = node.getExpression().getText();
    const [first, second] = node.getArguments();
    if (callee === 'Object.assign' && first?.getText() === name && second)
      keys.push(...keysOf(second, fn, 1));
    if (callee === `${name}.set` && first) keys.push(...keysOf(first, fn, 1));
  }
  return uniqueKeys(keys);
}

/**
 * What runs a query no user action reaches: a background job (a queue worker
 * runs it), an endpoint no screen calls, or a script.
 *
 * Walked back from the query through the code that calls it, so a helper two
 * calls below a worker still counts as the job's.
 */
function runnerOf(graph: FlowGraph, opId: string): Exclude<DatabaseOperation['runBy'], 'user'> {
  const seen = new Set<string>([opId]);
  const queue = [opId];
  let endpoint = false;
  let request = false;
  let socket = false;
  let script = false;
  while (queue.length && seen.size < 5000) {
    const id = queue.shift()!;
    const node = graph.node(id);
    const trigger = node?.meta?.['trigger'];
    if (trigger === 'job') return 'job';
    if (trigger === 'request') request = true;
    if (trigger === 'socket') socket = true;
    // `main()` in `scripts/backfill.js`: run by hand.
    if (
      node?.source &&
      (/(^|\/)(scripts?|bin|migrations?|seeds?|seeders?)\//.test(node.source.file) ||
        node.label === 'main')
    )
      script = true;
    for (const edge of graph.edgesTo(id)) {
      if (edge.meta?.['background'] === true) return 'job';
      const from = graph.node(edge.from);
      if (from?.kind === 'route') endpoint = true;
      if (seen.has(edge.from)) continue;
      seen.add(edge.from);
      queue.push(edge.from);
    }
  }
  return endpoint
    ? 'endpoint'
    : request
      ? 'request'
      : socket
        ? 'socket'
        : script
          ? 'script'
          : 'unused';
}

/** `/** A doctor's profile. *\/` above `class Doctor` or `interface Medicine`: its first sentence. */
function descriptionOf(
  reader: SourceReader,
  source: SourceRef | undefined,
): { description?: string } {
  if (!source) return {};
  try {
    const declaration = reader
      .file(source.file)
      ?.getStatements()
      .find((statement) => statement.getStartLineNumber() === source.line);
    const docs = (
      declaration as unknown as { getJsDocs?: () => Array<{ getDescription(): string }> }
    )?.getJsDocs?.();
    const text = docs?.at(-1)?.getDescription().replace(/\s+/g, ' ').trim();
    // A sentence ends where the next one starts with a capital: `(e.g. the …)` is not an end.
    const first = text?.split(/(?<=[.!?])\s+(?=[A-Z])/)[0];
    return first ? { description: first.length > 90 ? `${first.slice(0, 87)}…` : first } : {};
  } catch {
    return {};
  }
}

/**
 * The `doc.save()` a `const doc = new this.model(dto)` on this line ends in: the
 * query is recorded where the document is built, the save may be lines below.
 */
function saveOfNew(
  reader: SourceReader,
  file: string | undefined,
  line: number | undefined,
): CallExpression | undefined {
  const created = reader
    .file(file)
    ?.getDescendantsOfKind(SyntaxKind.NewExpression)
    .find((node) => node.getStartLineNumber() === line);
  const holder = created?.getFirstAncestorByKind(SyntaxKind.VariableDeclaration);
  const fn = created && nearestFunction(created);
  if (!holder || !fn) return undefined;
  return fn
    .getDescendantsOfKind(SyntaxKind.CallExpression)
    .find(
      (call) => call.getExpression().getText().replace(/\s+/g, '') === `${holder.getName()}.save`,
    );
}

/** Attributes whose value is never on screen: handlers, list keys, styling, refs. */
const UNSHOWN_ATTRIBUTE = /^(on[A-Z]\w*|key|ref|className|class|style|id|htmlFor|disabled|hidden)$/;

/** Calls whose first argument sends or stores a value rather than shows it: a request, a mutation, a state copy, a route. */
const SENDS =
  /(^|\.)(mutate\w*|post|put|patch|delete|fetch|axios|request\w*|submit\w*|useState|set[A-Z]\w*|push|replace)$/;
/** Array methods whose callback only filters, finds or orders — the list itself is still shown. */
const PICKS = /\.(filter|find|findIndex|findLast|some|every|sort|includes|indexOf)$/;

/**
 * A read that can put the value on screen. Left out: event handlers, list keys
 * and styling, what a filter or sort callback compares, navigation, request
 * payloads and state copies. A detail row built beside the JSX (`{ value: m.mrp }`),
 * an edit form's prefill, a toast and a label picked by a comparison all count.
 */
function rendered(access: Node): boolean {
  for (
    let child: Node = access, node = access.getParent();
    node;
    child = node, node = node.getParent()
  ) {
    if (Node.isJsxAttribute(node) && UNSHOWN_ATTRIBUTE.test(node.getNameNode().getText()))
      return false;
    if (Node.isCallExpression(node)) {
      const callee = node.getExpression().getText();
      const [first] = node.getArguments();
      if (first === child && SENDS.test(callee)) return false;
      if (PICKS.test(callee) && node.getArguments().includes(child as never)) return false;
    }
    if (Node.isFunctionDeclaration(node) || Node.isMethodDeclaration(node))
      return !/^(handle|on)[A-Z]/.test(node.getName() ?? '');
    if (Node.isVariableDeclaration(node) && /^(handle|on)[A-Z]/.test(node.getName())) return false;
    if (Node.isJsxElement(node) || Node.isJsxSelfClosingElement(node)) return true;
  }
  return true;
}

/** A string literal's value, or undefined. */
function readStringValue(node: Node | undefined): string | undefined {
  return node && (Node.isStringLiteral(node) || Node.isNoSubstitutionTemplateLiteral(node))
    ? node.getLiteralValue()
    : undefined;
}

/** A write that marks the record gone without erasing it. */
function isSoftDelete(field: string, value: string): boolean {
  const v = value.trim();
  if (/^(is_?)?(deleted|archived|removed|trashed)$/i.test(field)) return /^(true|1)$/.test(v);
  if (/^(deleted|archived|removed)_?(at|on|date)$/i.test(field))
    return !/^(null|undefined)$/.test(v);
  if (/^(is_?)?active$/i.test(field)) return /^(false|0)$/.test(v);
  return false;
}
