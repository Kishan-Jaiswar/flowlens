/**
 * How the collections link to each other.
 *
 * Every other analyzer answers "what did this action touch". This one answers
 * the question a reader asks immediately afterwards: *where did that data come
 * from*. An `orders` document holding a `customerId` is half a sentence — the
 * other half lives in `customers`, and nothing in either schema file says so
 * in a place the reader is looking.
 *
 * It is the one relationship a document database never writes down where it
 * matters, which is why it is worth a pass of its own:
 *
 *   - A declared `ref` (`@Prop({ ref: 'Customer' })`) is the author saying it.
 *   - A Prisma `@relation(fields: [authorId])` is the same statement, typed.
 *   - A `$lookup` or a `.populate()` is a query *following* the link, which is
 *     stronger still: the data really does arrive together.
 *   - A field named `customerId` next to a `customers` collection is a strong
 *     convention, and is recorded as an inference rather than as a fact.
 *
 * The four are kept apart on the edge (`meta.via`) rather than flattened,
 * because "the code says so" and "the name suggests so" are different claims
 * and a document that presents them identically is a document that cannot be
 * trusted on either.
 */

import {
  Node,
  SyntaxKind,
  type CallExpression,
  type PropertyAccessExpression,
  type SourceFile,
} from 'ts-morph';
import type { FlowGraph } from '../graph/graph.js';
import type { FlowEdge, FlowNode } from '../graph/types.js';
import { ids } from '../graph/ids.js';
import { callsIn, calleeMember, declarationOf, enclosingFunction, lineOf } from './ast.js';
import { collectionNameOf } from './mongo.js';
import type { PrismaSchema } from './prisma.js';
import type { LoadedProject } from './project.js';

/** How Flowslens came to know about a link. */
export type RelationVia =
  /** A Mongoose `ref` in the schema. */
  | 'declared'
  /** A Prisma `@relation`. */
  | 'prisma'
  /** An aggregation `$lookup` that joins the two. */
  | 'lookup'
  /** A query looks records up by an id read off another collection's record: `{ _id: template.endpointId }`. */
  | 'query'
  /** The field's name and an existing collection with the matching name. */
  | 'naming';

/** One link between two collections, as the document reads it. */
export interface CollectionRelation {
  /** The collection holding the key. */
  from: string;
  /** The field that holds it: `customerId`. */
  field: string;
  /** The collection the key points at. */
  to: string;
  via: RelationVia;
  /** True when this side holds a list of keys rather than one. */
  many: boolean;
  /**
   * True when some query actually follows the link.
   *
   * The difference between "these two are related" and "this screen's data
   * arrives from both in one go", which is the part a reader needs.
   */
  followed: boolean;
  source?: { file: string; line: number };
}

/**
 * Field names that hold an id but not a reference to anything in this app.
 *
 * Each still has to name a real collection before it is reported, so this list
 * is not what makes the inference safe — it is what stops a project that
 * happens to have a `sessions` collection from being told its `sessionId`
 * column is a foreign key into it when it is an opaque token.
 */
const NOT_REFERENCES = new Set([
  'id',
  '_id',
  'uuid',
  'externalid',
  'requestid',
  'correlationid',
  'traceid',
  'sessionid',
  'clientid',
  'deviceid',
  'messageid',
  'idempotencyid',
]);

/**
 * Record every link between collections that the project declares or follows.
 *
 * Runs after the backend, file-route and server-module passes, because it needs
 * the complete set of collections: an inferred link is only reported when the
 * collection on the other end is one the scan actually found, and a pass that
 * ran earlier would decide that against a half-built graph.
 *
 * @returns the number of links recorded.
 */
export function linkCollectionRelations(
  loaded: LoadedProject,
  graph: FlowGraph,
  prisma?: PrismaSchema,
): number {
  const collections = new Set(graph.nodesOfKind('collection').map((node) => node.label));
  if (collections.size === 0) return 0;

  /** Model name -> the collection it stores in, for resolving a `ref`. */
  const collectionOfModel = new Map<string, string>();
  for (const model of graph.nodesOfKind('model')) {
    const collection = model.meta?.['collection'];
    if (typeof collection === 'string' && collection.length > 0) {
      collectionOfModel.set(model.label, collection);
    }
  }

  let linked = 0;
  linked += declaredRefs(graph, collectionOfModel, collections);
  linked += prismaRelations(graph, prisma, collections);
  linked += inferredFromNames(
    graph,
    collectionOfModel,
    collections,
    new ValueReader(loaded, graph),
  );
  // Last: it marks the links the first three recorded as actually followed.
  linked += queryJoins(loaded, graph, collections);
  return linked;
}

/** `@Prop({ ref: 'Customer' })` and `customerId: { ref: 'Customer' }`. */
function declaredRefs(
  graph: FlowGraph,
  collectionOfModel: Map<string, string>,
  collections: Set<string>,
): number {
  let linked = 0;

  for (const model of graph.nodesOfKind('model')) {
    const from = collectionOfModel.get(model.label);
    if (!from) continue;

    for (const field of graph.successors(model.id, ['defines'])) {
      if (field.kind !== 'field') continue;
      const ref = field.meta?.['ref'];
      if (typeof ref !== 'string' || ref.length === 0) continue;

      /**
       * The declared model first, its conventional collection second.
       *
       * `ref: 'Customer'` names a model, and the model knows its own
       * collection — which may have been renamed with `@Schema({ collection
       * })`. Falling back to Mongoose's pluralisation is only for a model
       * declared somewhere the scan could not read, and then only if a
       * collection of that name was found anyway.
       */
      const declared = collectionOfModel.get(ref);
      const to =
        declared ?? (collections.has(collectionNameOf(ref)) ? collectionNameOf(ref) : undefined);
      if (!to) continue;

      record(graph, field.id, {
        from,
        field: field.label,
        to,
        via: 'declared',
        many: field.meta?.['refMany'] === true,
        followed: false,
        ...(field.source ? { source: { file: field.source.file, line: field.source.line } } : {}),
      });
      linked += 1;
    }
  }

  return linked;
}

/** `@relation(fields: [authorId], references: [id])`, read from schema.prisma. */
function prismaRelations(
  graph: FlowGraph,
  prisma: PrismaSchema | undefined,
  collections: Set<string>,
): number {
  if (!prisma || prisma.relations.length === 0) return 0;
  let linked = 0;

  for (const relation of prisma.relations) {
    // Only tables the scan found queries against: a schema may declare far
    // more than the code touches, and listing all of it answers nothing.
    if (!collections.has(relation.from) || !collections.has(relation.to)) continue;

    const fieldId = fieldNodeFor(graph, relation.from, relation.field);
    record(graph, fieldId, {
      from: relation.from,
      field: relation.field,
      to: relation.to,
      via: 'prisma',
      many: relation.many,
      followed: false,
    });
    linked += 1;
  }

  return linked;
}

/**
 * `orders.customerId` next to a `customers` collection.
 *
 * Reported only when the collection on the other end exists, which is what
 * keeps it from inventing links: a `subjectId` in a project with no `subjects`
 * produces nothing at all rather than a plausible-looking wrong answer. It is
 * still marked `naming` so the document can say it is reading the name and not
 * the code.
 */
function inferredFromNames(
  graph: FlowGraph,
  collectionOfModel: Map<string, string>,
  collections: Set<string>,
  values: ValueReader,
): number {
  let linked = 0;

  for (const model of graph.nodesOfKind('model')) {
    const from = collectionOfModel.get(model.label);
    if (!from) continue;

    for (const field of graph.successors(model.id, ['defines'])) {
      if (field.kind !== 'field') continue;
      // A declared ref already said it, and said it better — unless it names no model (`ref: 'Patinet'`).
      if (graph.successors(field.id, ['references']).length > 0) continue;

      const source = field.source
        ? { source: { file: field.source.file, line: field.source.line } }
        : {};

      // `batches[].supplierId`: the key's own name, a list when any step is one.
      const key = field.label.split('.').at(-1)!;
      const named = referenceTargetOf(key, collections);
      /**
       * What the code stores there outranks what the field is called: `settings.userId`
       * filled with `ctx.clinicId` at every call holds a clinic. Only top-level keys,
       * only when every place that sets it agrees, and only on a collection that exists.
       */
      const fed: string | undefined = field.label.includes('.')
        ? undefined
        : values.targetOf(from, key, collections);
      const guess: { collection: string; many: boolean } | undefined = fed
        ? { collection: fed, many: named?.many ?? false }
        : named;
      // `orders.order_id` is the order's own business id, not a link back to orders.
      if (guess && guess.collection !== from) {
        const type = String(field.meta?.['type'] ?? '');
        record(graph, field.id, {
          from,
          field: field.label,
          to: guess.collection,
          via: 'naming',
          many:
            guess.many || field.label.includes('[]') || /\[\s*\]\s*$|^(Readonly)?Array</.test(type),
          followed: false,
          ...source,
        });
        linked += 1;
        continue;
      }

      /**
       * Keys inside the field's own type, for the line-item shape.
       *
       * `products: Array<{ productId: string; quantity: number }>` is how
       * almost every order, invoice and cart is modelled, and the reference is
       * one level down — so reading only top-level field names reports an
       * order as touching no products at all, which is the opposite of true.
       */
      const type = field.meta?.['type'];
      if (typeof type !== 'string') continue;
      for (const nested of nestedTargetsOf(type, collections)) {
        const path = `${field.label}${nested.inArray ? '[]' : ''}.${nested.field}`;
        record(graph, fieldNodeFor(graph, from, path), {
          from,
          field: path,
          to: nested.collection,
          via: 'naming',
          // Many because the parent is a list, whatever the key itself holds.
          many: nested.inArray || nested.many,
          followed: false,
          ...source,
        });
        linked += 1;
      }
    }
  }

  return linked;
}

/**
 * Id-like keys inside a declared object type.
 *
 * Reads the type as written rather than resolving it, which is the right
 * trade here: the shape that matters is spelled out inline (`Array<{ productId
 * string }>`), and a key that names no known collection is dropped either way,
 * so a type this cannot read costs a gap and never a wrong answer.
 */
function nestedTargetsOf(
  type: string,
  collections: ReadonlySet<string>,
): Array<{ field: string; collection: string; many: boolean; inArray: boolean }> {
  // No object literal in the type, nothing to look inside.
  if (!type.includes('{')) return [];
  const inArray = /^\s*(?:Array|ReadonlyArray)\s*</.test(type) || /\]\s*$/.test(type);

  const found: Array<{ field: string; collection: string; many: boolean; inArray: boolean }> = [];
  const seen = new Set<string>();
  for (const match of type.matchAll(/([A-Za-z_][A-Za-z0-9_]*)\s*\??\s*:/g)) {
    const key = match[1];
    if (!key || seen.has(key)) continue;
    seen.add(key);
    const target = referenceTargetOf(key, collections);
    if (!target) continue;
    found.push({ field: key, collection: target.collection, many: target.many, inArray });
  }
  return found;
}

/**
 * The collection a field name points at, when its name is evidence.
 *
 * `customerId` -> `customers`, `productIds` -> `products` (a list),
 * `created_by_id` -> `created_bies`, which is not a collection, so nothing.
 */
export function referenceTargetOf(
  field: string,
  collections: ReadonlySet<string>,
): { collection: string; many: boolean } | undefined {
  if (NOT_REFERENCES.has(field.toLowerCase())) return undefined;

  const match = /^(.+?)_?(id|ids|Id|Ids|ID|IDs)$/.exec(field);
  const base = match?.[1];
  if (!base || base.length === 0) return undefined;

  const many = /s$/i.test(match?.[2] ?? '');
  const collection = collectionNameOf(base);
  if (!collections.has(collection)) return undefined;
  return { collection, many };
}

/**
 * Queries that pull two collections together in one round trip.
 *
 * Read at the db-op's own call site, which the graph already located, so the
 * collection the query belongs to is known rather than guessed. A `$lookup`
 * names its target outright and becomes a link on its own; a `.populate()` or
 * a Prisma `include` names a *field*, and only confirms a link already
 * recorded — which is the honest reading, since resolving the field would mean
 * guessing at the schema a second time.
 */
function queryJoins(loaded: LoadedProject, graph: FlowGraph, collections: Set<string>): number {
  const operations = graph.nodesOfKind('db-op').filter((node) => node.source !== undefined);
  if (operations.length === 0) return 0;

  /**
   * The call sites read once per file, not once per query.
   *
   * `callsIn` walks every descendant of the file, and a service file holds
   * dozens of queries — doing that walk per query turns a linear pass into a
   * quadratic one on exactly the files that have the most to find.
   */
  const wanted = new Map<string, typeof operations>();
  for (const operation of operations) {
    const file = operation.source?.file;
    if (!file) continue;
    wanted.set(file, [...(wanted.get(file) ?? []), operation]);
  }

  const statements = new Map<string, { text: string; call: CallExpression }>();
  for (const file of loaded.sourceFiles) {
    const mine = wanted.get(loaded.rel(file));
    if (!mine) continue;
    for (const [id, text, call] of statementsFor(file, mine))
      statements.set(id, { text: text + callerPipelines(loaded, graph, call), call });
  }
  /** Queries by where they are, for "this record came from that query". */
  const opAt = new Map<string, FlowNode>();
  for (const operation of operations)
    opAt.set(`${operation.source!.file}:${operation.source!.line}`, operation);

  /** Every recorded link, so a populated path can be matched to one. */
  const linksOf = new Map<string, CollectionRelation[]>();
  for (const relation of collectionRelations(graph)) {
    const bucket = linksOf.get(relation.from) ?? [];
    bucket.push(relation);
    linksOf.set(relation.from, bucket);
  }

  /**
   * Links by identity, so confirming one is a lookup rather than a scan.
   *
   * The obvious spelling of this walks every edge in the graph inside a loop
   * over every query — on a graph with a thousand queries and fifty thousand
   * edges, fifty million comparisons to set a handful of booleans.
   */
  const edgeOf = new Map<string, FlowEdge>();
  for (const edge of graph.allEdges()) {
    if (edge.kind !== 'references') continue;
    edgeOf.set(linkKey(edge.meta?.['from'], edge.meta?.['field'], edge.meta?.['to']), edge);
  }

  let linked = 0;

  for (const operation of operations) {
    const collection = operation.meta?.['collection'];
    if (typeof collection !== 'string' || !operation.source) continue;

    const found = statements.get(operation.id);
    if (!found) continue;
    const text = found.text;

    /** Collections this one query brings back alongside its own. */
    const joins = new Set<string>();
    /** Relation fields the query follows, whether or not they resolved. */
    const follows = new Set<string>();

    for (const lookup of lookupsIn(text)) {
      if (!collections.has(lookup.from)) continue;
      joins.add(lookup.from);
      const link = lookupLink(lookup, collection, aliasesIn(text));
      if (!link) continue;
      if (link.from === collection) follows.add(link.field);
      record(graph, fieldNodeFor(graph, link.from, link.field), {
        ...link,
        via: 'lookup',
        many: false,
        followed: true,
        source: { file: operation.source.file, line: operation.source.line },
      });
      linked += 1;
    }

    for (const path of followedPathsIn(text)) {
      follows.add(path);
      /**
       * Matched on the field name, and on the name with `Id` appended.
       *
       * Mongoose's `populate('customer')` and `populate('customerId')` are both
       * written against the same schema field in real code, depending on
       * whether the author named it for the id or for the thing.
       */
      const candidates = (linksOf.get(collection) ?? []).filter(
        (relation) =>
          relation.field === path ||
          relation.field === `${path}Id` ||
          relation.field === `${path}Ids` ||
          relation.field.replace(/_?[Ii]ds?$/, '') === path,
      );
      for (const relation of candidates) {
        joins.add(relation.to);
        const edge = edgeOf.get(linkKey(relation.from, relation.field, relation.to));
        if (edge) edge.meta = { ...edge.meta, followed: true };
      }
    }

    for (const follow of idFollowsIn(found.call)) {
      const source = opAt.get(`${operation.source.file}:${follow.loadedAt}`);
      const from = source?.meta?.['collection'];
      if (typeof from !== 'string' || from === collection || !collections.has(from)) continue;
      record(graph, fieldNodeFor(graph, from, follow.field), {
        from,
        field: follow.field,
        to: collection,
        via: 'query',
        many: false,
        followed: true,
        source: { file: operation.source.file, line: operation.source.line },
      });
      linked += 1;
    }

    if (joins.size === 0 && follows.size === 0) continue;
    graph.addNode({
      id: operation.id,
      kind: 'db-op',
      label: operation.label,
      meta: {
        ...(joins.size > 0 ? { joins: [...joins].sort() } : {}),
        ...(follows.size > 0 ? { follows: [...follows].sort() } : {}),
      },
    });
  }

  return linked;
}

/**
 * Every link the graph holds, in a stable order.
 *
 * The order is fixed (by collection, then field, then target) so that two runs
 * over the same graph produce the same document — the property the whole Docs
 * view rests on.
 */
export function collectionRelations(graph: FlowGraph): CollectionRelation[] {
  const relations: CollectionRelation[] = [];

  for (const edge of graph.allEdges()) {
    if (edge.kind !== 'references') continue;
    const from = edge.meta?.['from'];
    const to = edge.meta?.['to'];
    const field = edge.meta?.['field'];
    if (typeof from !== 'string' || typeof to !== 'string' || typeof field !== 'string') continue;

    const source = edge.meta?.['source'];
    relations.push({
      from,
      field,
      to,
      via: (edge.meta?.['via'] as RelationVia | undefined) ?? 'naming',
      many: edge.meta?.['many'] === true,
      followed: edge.meta?.['followed'] === true,
      ...(isSourceRef(source) ? { source } : {}),
    });
  }

  return relations.sort(
    (a, b) =>
      a.from.localeCompare(b.from, 'en') ||
      a.field.localeCompare(b.field, 'en') ||
      a.to.localeCompare(b.to, 'en'),
  );
}

// ---------------------------------------------------------------------------
// Reading the call site
// ---------------------------------------------------------------------------

/**
 * The whole statement each query lives in, so the chain after it is included.
 *
 * `this.orderModel.findOne({...}).populate('customer').lean()` is one
 * statement and four calls; the db-op node points at the `findOne`. Taking the
 * enclosing statement is what makes the `.populate` visible at all.
 *
 * Keyed by node id and built in one walk of the file, because the walk is the
 * expensive part and every query in the file wants it.
 */
function statementsFor(
  file: SourceFile,
  operations: ReadonlyArray<FlowNode>,
): Array<[string, string, CallExpression]> {
  const byLine = new Map<number, FlowNode[]>();
  for (const operation of operations) {
    const line = operation.source?.line;
    if (line === undefined) continue;
    byLine.set(line, [...(byLine.get(line) ?? []), operation]);
  }

  const found: Array<[string, string, CallExpression]> = [];
  for (const call of callsIn(file)) {
    const candidates = byLine.get(lineOf(call));
    if (!candidates) continue;
    // Two queries can share a line; the call's own name is what separates them.
    const member = calleeMember(call);
    const match = candidates.find((operation) => {
      const name = operation.meta?.['operation'];
      return typeof name !== 'string' || name.length === 0 || name === member;
    });
    if (!match) continue;
    const statement = call.getFirstAncestor(
      (node) => Node.isStatement(node) || Node.isVariableStatement(node),
    );
    found.push([
      match.id,
      member === 'aggregate' ? pipelineText(call) : (statement ?? call).getText(),
      call,
    ]);
  }
  return found;
}

/**
 * An aggregate's pipeline with the variables it is built from written in:
 * `aggregate([match, lookup])`, or `aggregate(stages)` after `stages.push(lookup)`.
 *
 * Only what this aggregate runs. Reading the whole function instead hands it the
 * `$lookup`s of every other aggregate written there, and a join from another
 * collection's pipeline then reads as a link from this one.
 */
function pipelineText(call: CallExpression): string {
  const fn = enclosingFunction(call);
  const first = call.getArguments()[0];
  if (!fn || !first) return call.getText();
  const declared = new Map<string, Node>();
  for (const declaration of fn.getDescendantsOfKind(SyntaxKind.VariableDeclaration)) {
    const init = declaration.getInitializer();
    if (init && !declared.has(declaration.getName())) declared.set(declaration.getName(), init);
  }
  // Stages added after the declaration: `stages.push(lookup)`, `stages = [...stages, lookup]`.
  const added = new Map<string, Node[]>();
  const add = (name: string, node: Node): void => {
    added.set(name, [...(added.get(name) ?? []), node]);
  };
  for (const other of fn.getDescendantsOfKind(SyntaxKind.CallExpression)) {
    const callee = other.getExpression();
    if (Node.isPropertyAccessExpression(callee) && /^(push|unshift)$/.test(callee.getName()))
      for (const arg of other.getArguments()) add(callee.getExpression().getText(), arg);
  }
  for (const assignment of fn.getDescendantsOfKind(SyntaxKind.BinaryExpression))
    if (assignment.getOperatorToken().getKind() === SyntaxKind.EqualsToken)
      add(assignment.getLeft().getText(), assignment.getRight());

  const texts = [call.getText()];
  const seen = new Set<string>();
  const queue: Node[] = [first];
  while (queue.length > 0) {
    const node = queue.pop()!;
    const names = Node.isIdentifier(node)
      ? [node]
      : node.getDescendantsOfKind(SyntaxKind.Identifier);
    for (const identifier of names) {
      const name = identifier.getText();
      if (seen.has(name)) continue;
      seen.add(name);
      for (const part of [declared.get(name), ...(added.get(name) ?? [])]) {
        if (!part) continue;
        texts.push(part.getText());
        queue.push(part);
      }
    }
  }
  return texts.join('\n');
}

/**
 * Ids a query looks records up by, read off a record another query loaded.
 *
 * `const t = await templates.findOne(...)` then `endpoints.findOne({ _id: t.endpoint_id })`
 * says `endpoint_id` holds an endpoints id, whatever it is called. Only `_id`
 * and `id` keys count, and only when the record is a query's result in the
 * same function: that is the code following the link, not a name suggesting it.
 */
function idFollowsIn(call: CallExpression): Array<{ field: string; loadedAt: number }> {
  const filter = call.getArguments()[0];
  if (!filter || !Node.isObjectLiteralExpression(filter)) return [];
  const found: Array<{ field: string; loadedAt: number }> = [];
  for (const property of filter.getProperties()) {
    if (!Node.isPropertyAssignment(property)) continue;
    if (!/^['"]?_?id['"]?$/.test(property.getName())) continue;
    let value = property.getInitializer();
    // `{ $in: list.map((m) => m.clinicId) }`, `{ $eq: t.endpointId }`
    if (value && Node.isObjectLiteralExpression(value)) {
      const operator = value.getProperties()[0];
      value =
        operator && Node.isPropertyAssignment(operator) ? operator.getInitializer() : undefined;
    }
    let holder: Node | undefined;
    let field: string | undefined;
    if (value && Node.isPropertyAccessExpression(value)) {
      holder = value.getExpression();
      field = value.getName();
    } else if (value && Node.isCallExpression(value) && calleeMember(value) === 'map') {
      const mapper = value.getArguments()[0];
      const body = mapper && Node.isArrowFunction(mapper) ? mapper.getBody() : undefined;
      if (body && Node.isPropertyAccessExpression(body)) {
        holder = (value.getExpression() as PropertyAccessExpression).getExpression();
        field = body.getName();
      }
    }
    if (!holder || !field || !Node.isIdentifier(holder) || NOT_REFERENCES.has(field.toLowerCase()))
      continue;
    const declaration = declarationOf(holder);
    const init =
      declaration && Node.isVariableDeclaration(declaration)
        ? declaration.getInitializer()
        : undefined;
    if (!init) continue;
    found.push({ field, loadedAt: lineOf(init) });
  }
  return found;
}

/** Names a pipeline makes itself: `as: 'staffClinics'`, `$addFields: { allClinics: … }`. */
function aliasesIn(text: string): Set<string> {
  const found = new Set<string>();
  for (const match of text.matchAll(/\bas\s*:\s*['"`]([\w$]+)['"`]/g)) found.add(match[1]!);
  for (const match of text.matchAll(/\$(?:addFields|set)\s*:\s*\{\s*['"`]?([\w$]+)/g))
    found.add(match[1]!);
  return found;
}

/**
 * The code of the functions that hand an aggregate its pipeline: `aggregation(query)`
 * runs what `getList` built, `$lookup` stages included. One call away, through the graph.
 */
function callerPipelines(loaded: LoadedProject, graph: FlowGraph, call: CallExpression): string {
  if (calleeMember(call) !== 'aggregate') return '';
  const fn = enclosingFunction(call);
  const arg = call.getArguments()[0];
  if (!fn || !arg || !Node.isIdentifier(arg)) return '';
  if (!fn.getParameters().some((p) => p.getName() === arg.getText())) return '';
  const rel = loaded.rel(fn.getSourceFile());
  const line = lineOf(fn);
  const self = graph
    .nodesOfKind('method')
    .find((node) => node.source?.file === rel && node.source.line === line);
  if (!self) return '';
  const texts: string[] = [];
  for (const caller of graph.predecessors(self.id, ['calls'])) {
    if (!caller.source) continue;
    const file = loaded.sourceFiles.find((f) => loaded.rel(f) === caller.source!.file);
    const callerFn = file
      ?.getDescendantsOfKind(SyntaxKind.MethodDeclaration)
      .find((m) => lineOf(m) === caller.source!.line);
    if (callerFn) texts.push(callerFn.getText());
  }
  return texts.length ? `\n${texts.join('\n')}` : '';
}

/** A link's identity, for matching a recorded edge without searching for it. */
function linkKey(from: unknown, field: unknown, to: unknown): string {
  return `${String(from)}\u0000${String(field)}\u0000${String(to)}`;
}

/** `$lookup: { from: 'customers', localField: 'customerId', foreignField: '_id', ... }` */
function lookupsIn(
  text: string,
): Array<{ from: string; localField?: string; foreignField?: string }> {
  const found: Array<{ from: string; localField?: string; foreignField?: string }> = [];
  for (const match of text.matchAll(/\$lookup\s*:\s*\{/g)) {
    const body = balanced(text, match.index + match[0].length);
    // The lookup's own keys, not those of a lookup nested in its pipeline.
    const own = body.replace(/\{[^{}]*\}/g, (inner) => inner.replace(/[^\n]/g, ' '));
    const from = /\bfrom\s*:\s*['"`]([^'"`]+)['"`]/.exec(own)?.[1];
    if (!from) continue;
    let localField = /\blocalField\s*:\s*['"`]([^'"`]+)['"`]/.exec(own)?.[1];
    let foreignField = /\bforeignField\s*:\s*['"`]([^'"`]+)['"`]/.exec(own)?.[1];
    // `let: { id: '$_id' }, pipeline: [{ $match: { $expr: { $eq: ['$appointment_id', '$$id'] } } }]`
    if (!localField) {
      const lets = new Map<string, string>();
      const letBody = /\blet\s*:\s*\{([^}]*)\}/.exec(body)?.[1] ?? '';
      for (const entry of letBody.matchAll(/([\w$]+)\s*:\s*['"`]\$([\w.]+)['"`]/g))
        lets.set(entry[1]!, entry[2]!);
      for (const eq of body.matchAll(
        /\$eq\s*:\s*\[\s*['"`]\$([\w.]+)['"`]\s*,\s*['"`]\$\$([\w$]+)['"`]\s*\]|\$eq\s*:\s*\[\s*['"`]\$\$([\w$]+)['"`]\s*,\s*['"`]\$([\w.]+)['"`]\s*\]/g,
      )) {
        const local = lets.get(eq[2] ?? eq[3]!);
        if (!local) continue;
        localField = local;
        foreignField = eq[1] ?? eq[4]!;
        break;
      }
    }
    found.push({
      from,
      ...(localField ? { localField } : {}),
      ...(foreignField ? { foreignField } : {}),
    });
  }
  return found;
}

/** The text from `start` up to the brace that closes the one just before it. */
function balanced(text: string, start: number): string {
  let depth = 1;
  for (let i = start; i < text.length; i += 1) {
    const char = text[i];
    if (char === '{') depth += 1;
    else if (char === '}' && --depth === 0) return text.slice(start, i);
  }
  return text.slice(start);
}

/**
 * Which side of a `$lookup` holds the id, as a link: `localField: 'customerId',
 * foreignField: '_id'` is this collection's `customerId` → there; `localField:
 * '_id', foreignField: 'orderId'` is there's `orderId` → here. Two non-id fields
 * (`staff_id` ↔ `staff_id`) join siblings, not a record and its owner; a local
 * field an earlier stage of the pipeline made (`as: 'staffClinics'`) is not stored.
 */
function lookupLink(
  lookup: { from: string; localField?: string; foreignField?: string },
  collection: string,
  aliases: ReadonlySet<string>,
): { from: string; field: string; to: string } | undefined {
  const { localField, foreignField = '_id' } = lookup;
  if (!localField) return undefined;
  if (localField === '_id' && foreignField !== '_id')
    return { from: lookup.from, field: foreignField, to: collection };
  if (foreignField !== '_id' || localField === '_id') return undefined;
  if (aliases.has(localField.split('.')[0]!)) return undefined;
  return { from: collection, field: localField, to: lookup.from };
}

/**
 * Relation fields a query asks to be filled in.
 *
 * Mongoose's four spellings of `populate` and Prisma's `include` all name a
 * field on the model being queried, so they are read the same way and resolved
 * against the links already recorded.
 */
function followedPathsIn(text: string): string[] {
  const paths = new Set<string>();

  for (const match of text.matchAll(
    /\.populate\(\s*(?:\{[^{}]*?path\s*:\s*)?['"`]([^'"`]+)['"`]/g,
  )) {
    if (match[1]) paths.add(match[1].split('.')[0] as string);
  }

  for (const match of text.matchAll(/\b(?:include|populate)\s*:\s*\{([^{}]*)\}/g)) {
    for (const key of (match[1] ?? '').matchAll(/([A-Za-z_][A-Za-z0-9_]*)\s*:/g)) {
      if (key[1]) paths.add(key[1]);
    }
  }

  return [...paths];
}

// ---------------------------------------------------------------------------
// Writing to the graph
// ---------------------------------------------------------------------------

/**
 * The node a link hangs off.
 *
 * A field the schema declares already has one. A `$lookup`'s `localField` and
 * a Prisma foreign key may not — the schema may be unreadable, or the column
 * may only exist in the database — so one is created, keyed on the collection
 * so that two links from different fields stay two links.
 *
 * Deliberately without a `defines` edge from the collection: the field was not
 * read from a schema, and claiming a collection defines it would put a fact in
 * the graph that no file backs up.
 */
function fieldNodeFor(graph: FlowGraph, collection: string, field: string): string {
  const collectionId = ids.collection(collection);
  const existing = graph
    .predecessors(collectionId, ['defines'])
    .filter((node) => node.kind === 'model')
    .flatMap((model) => graph.successors(model.id, ['defines']))
    .find((node) => node.kind === 'field' && node.label === field);
  if (existing) return existing.id;

  const fieldId = ids.field(collectionId, field);
  graph.addNode({
    id: fieldId,
    kind: 'field',
    label: field,
    meta: { owner: collection, fromQuery: true },
  });
  return fieldId;
}

function record(graph: FlowGraph, fieldId: string, relation: CollectionRelation): void {
  graph.addEdge({
    from: fieldId,
    to: ids.collection(relation.to),
    kind: 'references',
    meta: {
      from: relation.from,
      to: relation.to,
      field: relation.field,
      via: relation.via,
      many: relation.many,
      followed: relation.followed,
      ...(relation.source ? { source: relation.source } : {}),
    },
  });
}

function isSourceRef(value: unknown): value is { file: string; line: number } {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { file?: unknown }).file === 'string' &&
    typeof (value as { line?: unknown }).line === 'number'
  );
}

/**
 * Which collection the values written into one field point at, read from the code
 * that writes them: `{ userId }` inside `getImportMapping(userId)`, called as
 * `getImportMapping(ctx.clinicId)`, holds a clinic id. Parameters are followed up to
 * three calls back; the value's own name then says which collection it belongs to.
 */
class ValueReader {
  private readonly calls = new Map<string, Map<number, CallExpression[]>>();
  private readonly values = new Map<string, Map<string, Node[]>>();
  private readonly named = new Map<string, Map<string, CallExpression[]>>();
  private readonly files = new Map<string, SourceFile>();
  private readonly opsOf = new Map<string, FlowNode[]>();
  private readonly methodAt = new Map<string, FlowNode>();

  constructor(
    private readonly loaded: LoadedProject,
    private readonly graph: FlowGraph,
  ) {
    for (const file of loaded.sourceFiles) this.files.set(loaded.rel(file), file);
    for (const method of graph.nodesOfKind('method'))
      if (method.source) {
        const key = `${method.source.file}:${method.source.line}`;
        if (!this.methodAt.has(key)) this.methodAt.set(key, method);
      }
    for (const op of graph.nodesOfKind('db-op')) {
      const collection = op.meta?.['collection'];
      if (typeof collection !== 'string' || !op.source) continue;
      this.opsOf.set(collection, [...(this.opsOf.get(collection) ?? []), op]);
    }
  }

  /** The one collection every value written into `collection.field` names, if they agree. */
  targetOf(
    collection: string,
    field: string,
    collections: ReadonlySet<string>,
  ): string | undefined {
    const found = new Set<string>();
    for (const op of this.opsOf.get(collection) ?? []) {
      for (const value of this.valuesAt(op).get(field) ?? []) {
        for (const name of this.namesOf(value, 0)) {
          const target = referenceTargetOf(name, collections);
          if (!target) return undefined;
          found.add(target.collection);
        }
      }
    }
    return found.size === 1 ? [...found][0] : undefined;
  }

  /** Each key one query's filter and update give a value, read once. */
  private valuesAt(op: FlowNode): Map<string, Node[]> {
    let values = this.values.get(op.id);
    if (values) return values;
    values = new Map();
    const call = this.callAt(
      op.source!.file,
      op.source!.line,
      String(op.meta?.['operation'] ?? ''),
    );
    if (call) valuesOf(call, values);
    this.values.set(op.id, values);
    return values;
  }

  /** The names a value is built from, through the parameters it was handed. */
  private namesOf(value: Node, depth: number): string[] {
    if (Node.isPropertyAccessExpression(value)) return [value.getName()];
    if (!Node.isIdentifier(value)) return [];
    const declaration = declarationOf(value);
    if (!declaration || !Node.isParameterDeclaration(declaration)) return [value.getText()];
    if (depth >= 3) return [];
    const fn = enclosingFunction(declaration);
    if (!fn) return [];
    const index = fn.getParameters().indexOf(declaration);
    const name = fnName(fn);
    const self = this.methodAt.get(`${this.loaded.rel(fn.getSourceFile())}:${lineOf(fn)}`);
    if (!self || !name) return [];
    const names: string[] = [];
    for (const caller of this.graph.predecessors(self.id, ['calls'])) {
      if (!caller.source) continue;
      const file = this.files.get(caller.source.file);
      if (!file) continue;
      for (const call of this.callsNamed(caller.source.file, file).get(name) ?? []) {
        const callerFn = enclosingFunction(call);
        if (!callerFn || lineOf(callerFn) !== caller.source.line) continue;
        const arg = call.getArguments()[index];
        if (!arg) return [];
        const more = this.namesOf(arg, depth + 1);
        if (more.length === 0) return [];
        names.push(...more);
      }
    }
    return names;
  }

  private callAt(file: string, line: number, operation: string): CallExpression | undefined {
    const source = this.files.get(file);
    if (!source) return undefined;
    return this.callsOf(file, source)
      .get(line)
      ?.find((call) => !operation || calleeMember(call) === operation);
  }

  /** A file's calls by the name they call, indexed once. */
  private callsNamed(rel: string, file: SourceFile): Map<string, CallExpression[]> {
    let found = this.named.get(rel);
    if (found) return found;
    found = new Map();
    for (const calls of this.callsOf(rel, file).values())
      for (const call of calls) {
        const name = calleeMember(call);
        found.set(name, [...(found.get(name) ?? []), call]);
      }
    this.named.set(rel, found);
    return found;
  }

  /** A file's calls by the line they start on, indexed once. */
  private callsOf(rel: string, file: SourceFile): Map<number, CallExpression[]> {
    let found = this.calls.get(rel);
    if (found) return found;
    found = new Map();
    for (const call of callsIn(file)) {
      const line = lineOf(call);
      found.set(line, [...(found.get(line) ?? []), call]);
    }
    this.calls.set(rel, found);
    return found;
  }
}

/** The values a query's filter and update give each key: `{ userId }`, `{ $set: { userId: x } }`. */
function valuesOf(call: CallExpression, into: Map<string, Node[]>): void {
  const add = (key: string, value: Node): void => {
    into.set(key, [...(into.get(key) ?? []), value]);
  };
  for (const arg of call.getArguments().slice(0, 2)) {
    if (!Node.isObjectLiteralExpression(arg)) continue;
    for (const object of [arg, ...arg.getDescendantsOfKind(SyntaxKind.ObjectLiteralExpression)])
      for (const property of object.getProperties()) {
        if (Node.isShorthandPropertyAssignment(property))
          add(property.getName(), property.getNameNode());
        else if (Node.isPropertyAssignment(property)) {
          const init = property.getInitializer();
          if (init) add(property.getName(), init);
        }
      }
  }
}

/** A function's name as its callers write it. */
function fnName(fn: Node): string | undefined {
  if (Node.isFunctionDeclaration(fn) || Node.isMethodDeclaration(fn)) return fn.getName();
  const holder = fn.getParent();
  return holder && Node.isVariableDeclaration(holder) ? holder.getName() : undefined;
}
