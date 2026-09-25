/**
 * Prisma knowledge: which client calls touch the database, what each one does,
 * and which physical table a client property maps to.
 *
 * The shape is deliberately parallel to `mongo.ts` + `dbaccess.ts`, and the
 * nodes it produces are the same `db-op` / `collection` kinds. A table is a
 * collection as far as the graph is concerned — the question ("what data did
 * this action touch?") does not change with the database, so neither should the
 * vocabulary. Only `meta.database` differs, for callers that want to say
 * "table" instead of "collection" in prose.
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { DbEffect } from './mongo.js';

/**
 * Prisma client operations, and what each does to the table.
 *
 * `upsert` is the honest vague `write` for the same reason `save()` is in
 * Mongoose: which branch it takes depends on whether the row already exists,
 * and that is runtime state. `$transaction` is not listed — the operations
 * inside it are separate calls and get found on their own.
 */
export const PRISMA_OPERATIONS: Record<string, DbEffect> = {
  // reads
  findUnique: 'read',
  findUniqueOrThrow: 'read',
  findFirst: 'read',
  findFirstOrThrow: 'read',
  findMany: 'read',
  count: 'read',
  aggregate: 'read',
  groupBy: 'read',
  // inserts
  create: 'create',
  createMany: 'create',
  createManyAndReturn: 'create',
  // updates
  update: 'update',
  updateMany: 'update',
  updateManyAndReturn: 'update',
  // deletes
  delete: 'delete',
  deleteMany: 'delete',
  // effect not knowable from the call site
  upsert: 'write',
};

/** What a Prisma operation does to its table, or undefined if it is not one. */
export function prismaEffectOf(operation: string): DbEffect | undefined {
  return PRISMA_OPERATIONS[operation];
}

/**
 * Receiver heads that may hold a Prisma client.
 *
 * `db` and `client` are included because `import { db } from '@/lib/db'` is the
 * common Next.js spelling, but see {@link prismaTableOf}: a head from this list
 * is only trusted when the model segment is one the schema actually declares.
 * Without that pairing, `this.db.logger.info()` would invent a table.
 */
const CLIENT_HEADS = new Set(['prisma', 'db', 'database', 'client', 'dbClient', 'prismaClient']);

/**
 * One declared link between two tables.
 *
 * Only the side that *holds* the key is recorded. `@relation(fields:
 * [authorId])` on `Post` says `posts.author_id` points at a row in `users`;
 * the matching `posts Post[]` on `User` is the same fact written from the
 * other end, and recording both would report one relationship as two.
 * Anything that wants the reverse direction can read the incoming links.
 */
export interface PrismaRelation {
  /** Table holding the foreign key. */
  from: string;
  /** The column that holds it: `authorId`. */
  field: string;
  /** Table the key points at. */
  to: string;
  /** True when this side holds a list of keys. */
  many: boolean;
}

/** Model name -> physical table name, as declared by the schema. */
export interface PrismaSchema {
  /** Client property (camelCase model name) -> table name. */
  tables: ReadonlyMap<string, string>;
  /** Declared links between tables, key-holding side only. */
  relations: readonly PrismaRelation[];
  /** Schema files the models were read from, relative to the scan root. */
  files: readonly string[];
}

const EMPTY_SCHEMA: PrismaSchema = { tables: new Map(), relations: [], files: [] };

/** True when the project has no Prisma schema at all. */
export function isEmptyPrismaSchema(schema: PrismaSchema | undefined): boolean {
  return !schema || schema.tables.size === 0;
}

/**
 * Find and read every `schema.prisma` under the scanned roots.
 *
 * Read with a regex rather than a real parser on purpose: the only two facts
 * needed are the model names and their `@@map`, both of which are unambiguous
 * lines. Taking on a Prisma parser (or shelling out to the Prisma CLI) to learn
 * two strings would be a dependency and a failure mode for no extra answer.
 */
export function loadPrismaSchema(roots: readonly string[]): PrismaSchema {
  const files: string[] = [];
  for (const root of roots) {
    for (const path of findSchemaFiles(root)) files.push(path);
  }
  if (files.length === 0) return EMPTY_SCHEMA;

  const tables = new Map<string, string>();
  /** Model name (as written) -> table name, for resolving relation targets. */
  const byModel = new Map<string, string>();
  const bodies: Array<[string, string]> = [];

  for (const path of files) {
    let text: string;
    try {
      text = readFileSync(path, 'utf8');
    } catch {
      // A schema we cannot read is a gap, not a reason to fail the scan.
      continue;
    }
    for (const { model, table, body } of readModels(text)) {
      tables.set(clientProperty(model), table);
      byModel.set(model, table);
      bodies.push([model, body]);
    }
  }

  /**
   * Relations in a second pass, once every model is known.
   *
   * A relation names another *model*, and the table it maps to may be declared
   * in a later file — Prisma 5 allows a folder of schema files. Resolving as
   * each model is read would silently drop every forward reference.
   */
  const relations: PrismaRelation[] = [];
  for (const [model, body] of bodies) {
    const from = byModel.get(model);
    if (!from) continue;
    for (const relation of readRelations(body, byModel)) relations.push({ ...relation, from });
  }

  return { tables, relations, files };
}

/**
 * The `@relation(fields: [...])` links in one model body.
 *
 * Read line by line rather than with one big pattern: a field declaration is a
 * line in Prisma's grammar, and matching across lines is how `references: [id]`
 * on a wrapped attribute gets paired with the wrong field.
 */
function readRelations(
  body: string,
  byModel: ReadonlyMap<string, string>,
): Array<Omit<PrismaRelation, 'from'>> {
  const out: Array<Omit<PrismaRelation, 'from'>> = [];

  for (const line of body.split('\n')) {
    const text = line.trim();
    if (text.startsWith('//') || text.startsWith('@@')) continue;

    const declaration = /^([A-Za-z_][A-Za-z0-9_]*)\s+([A-Za-z_][A-Za-z0-9_]*)(\[\])?\??/.exec(text);
    if (!declaration) continue;
    const [, name, type, list] = declaration;
    if (!name || !type) continue;

    const to = byModel.get(type);
    // A field whose type is not a model is an ordinary column.
    if (!to) continue;

    /**
     * The column holding the key, which is the field a reader can look for.
     *
     * Without `fields:` this is the back-reference side — the key lives on the
     * other model, and that model records it. Skipped rather than guessed.
     */
    const fields = /@relation\([^)]*\bfields:\s*\[([^\]]*)\]/.exec(text);
    const field = fields?.[1]?.split(',')[0]?.trim();
    if (!field) continue;

    out.push({ field, to, many: list === '[]' });
  }

  return out;
}

/**
 * `model Product { ... @@map("products") }` -> `product` -> `products`.
 *
 * Without `@@map`, Prisma names the table exactly as the model is written, so
 * that is the default here too. Guessing a pluralisation (as Mongoose needs)
 * would name tables that do not exist.
 */
function readModels(text: string): Array<{ model: string; table: string; body: string }> {
  const out: Array<{ model: string; table: string; body: string }> = [];
  const pattern = /^\s*model\s+([A-Za-z_][A-Za-z0-9_]*)\s*\{([\s\S]*?)^\s*\}/gm;
  for (const match of text.matchAll(pattern)) {
    const model = match[1];
    const body = match[2] ?? '';
    if (!model) continue;
    const mapped = /@@map\(\s*['"]([^'"]+)['"]\s*\)/.exec(body);
    const table = mapped?.[1] ?? model;
    out.push({ model, table, body });
  }
  return out;
}

/**
 * The property Prisma Client exposes for a model: the model name with a
 * lowercase first letter (`Product` -> `product`, `OrderItem` -> `orderItem`).
 */
export function clientProperty(model: string): string {
  return model.charAt(0).toLowerCase() + model.slice(1);
}

/** Directories never worth walking in search of a schema. */
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', '.next', 'coverage']);
const MAX_SCHEMA_DEPTH = 6;

function findSchemaFiles(root: string): string[] {
  const found: string[] = [];
  let stack: Array<{ dir: string; depth: number }>;
  try {
    stack = statSync(root).isDirectory() ? [{ dir: root, depth: 0 }] : [];
  } catch {
    return found;
  }

  while (stack.length > 0) {
    const { dir, depth } = stack.pop()!;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name) || entry.name.startsWith('.')) continue;
        if (depth < MAX_SCHEMA_DEPTH) stack.push({ dir: join(dir, entry.name), depth: depth + 1 });
        continue;
      }
      // Prisma 5+ also allows a `prisma/schema/*.prisma` folder of files.
      if (entry.name === 'schema.prisma' || entry.name.endsWith('.prisma')) {
        const path = join(dir, entry.name);
        if (existsSync(path)) found.push(path);
      }
    }
  }
  return found;
}

/**
 * The table a call receiver refers to, or undefined when it is not a Prisma
 * query.
 *
 * Requires both halves to agree: a recognised client head *and* a model the
 * schema declares. That is what keeps `this.db.logger.info()` and
 * `client.config.get()` out of the data layer — the cost is that a project with
 * no schema on disk gets nothing, which is the right trade. A named table that
 * does not exist is a wrong finding; a missing one is only a gap.
 */
export function prismaTableOf(
  receiver: string,
  schema: PrismaSchema | undefined,
): string | undefined {
  if (!schema || schema.tables.size === 0) return undefined;
  const parts = receiver.split('.');
  const model = parts.pop();
  if (!model) return undefined;

  // `prisma.product`, `this.prisma.product`, `ctx.db.product`.
  const head = parts.pop();
  if (!head || !CLIENT_HEADS.has(head)) return undefined;

  return schema.tables.get(model);
}
