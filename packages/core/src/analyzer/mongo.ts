/**
 * Mongo/Mongoose knowledge: which calls touch the database, what each one does
 * to it, and which physical collection a model name maps to.
 */

export type DbAccess = 'read' | 'write';

/**
 * What an operation does to a collection.
 *
 * Finer than {@link DbAccess} because "writes" is not the question anyone
 * actually asks. Seeing that an action *writes* `patients` does not say whether
 * it inserted a patient, edited one, or deleted one — and those are different
 * enough that lumping them together hides the thing you opened the tool to
 * find.
 *
 * `write` remains as the honest answer for operations whose effect cannot be
 * known from the call site; see {@link DB_OPERATIONS}.
 */
export type DbEffect = 'read' | 'create' | 'update' | 'delete' | 'write';

/**
 * How each effect reads in a sentence about a collection.
 *
 * Phrased from the collection's point of view ("read from `patients`") because
 * that is the question being answered: where did this data come from, and where
 * did it go.
 */
export const DB_EFFECT_LABEL: Record<DbEffect, string> = {
  read: 'read from',
  create: 'inserted into',
  update: 'updated in',
  delete: 'deleted from',
  write: 'written to',
};

/** Reads first, then mutations in the order they escalate. */
export const DB_EFFECT_ORDER: readonly DbEffect[] = ['read', 'create', 'update', 'delete', 'write'];

/**
 * Mongoose/Mongo operations FlowLens recognises, and what each does. Anything
 * not listed is ignored, which keeps `this.logger.log()` out of the data layer
 * of the graph.
 *
 * Two entries are deliberately the vague `write`, because the call site does not
 * carry the answer and guessing would be worse than admitting it:
 *
 *   - `save()` inserts when the document is new and updates when it is not, and
 *     which one it is depends on runtime state.
 *   - `bulkWrite()` takes a list of mixed operations, so it can insert, update
 *     and delete in a single call.
 *
 * `updateOne`/`updateMany` are called `update` even though `{ upsert: true }`
 * can insert, because the option is the exception and reading it here would
 * mean resolving the options object at every call site.
 */
export const DB_OPERATIONS: Record<string, DbEffect> = {
  // reads
  find: 'read',
  findOne: 'read',
  findById: 'read',
  countDocuments: 'read',
  count: 'read',
  estimatedDocumentCount: 'read',
  distinct: 'read',
  aggregate: 'read',
  exists: 'read',
  // inserts
  create: 'create',
  insertOne: 'create',
  insertMany: 'create',
  // updates
  updateOne: 'update',
  updateMany: 'update',
  replaceOne: 'update',
  findOneAndUpdate: 'update',
  findByIdAndUpdate: 'update',
  findOneAndReplace: 'update',
  // deletes
  findOneAndDelete: 'delete',
  findByIdAndDelete: 'delete',
  findByIdAndRemove: 'delete',
  deleteOne: 'delete',
  deleteMany: 'delete',
  remove: 'delete',
  // writes of an effect that cannot be known statically
  save: 'write',
  bulkWrite: 'write',
};

/**
 * Chainable modifiers, not operations.
 *
 * `this.model.findById(id).lean()` is one read, not two — counting `lean` as an
 * operation would double every query in the graph.
 */
export const CHAINED_MODIFIERS = new Set([
  'lean',
  'sort',
  'limit',
  'skip',
  'select',
  'populate',
  'exec',
  'session',
  'hint',
  'collation',
  'maxTimeMS',
  'setOptions',
  'where',
]);

/** What an operation does to the collection, or undefined if it is not a query. */
export function dbEffectOf(operation: string): DbEffect | undefined {
  if (CHAINED_MODIFIERS.has(operation)) return undefined;
  return DB_OPERATIONS[operation];
}

/** The coarse read/write split, derived so the two can never disagree. */
export function dbAccessOf(operation: string): DbAccess | undefined {
  const effect = dbEffectOf(operation);
  if (!effect) return undefined;
  return effect === 'read' ? 'read' : 'write';
}

/**
 * Model name -> collection name, following Mongoose's own convention:
 * lowercase the name and pluralise it (`Patient` -> `patients`).
 */
export function collectionNameOf(modelName: string): string {
  const base = modelName
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .toLowerCase()
    .replace(/_/g, '');
  return pluralize(base);
}

const IRREGULAR: Record<string, string> = {
  person: 'people',
  child: 'children',
  man: 'men',
  woman: 'women',
  tooth: 'teeth',
  foot: 'feet',
  mouse: 'mice',
  goose: 'geese',
  datum: 'data',
  analysis: 'analyses',
  diagnosis: 'diagnoses',
  index: 'indexes',
  history: 'histories',
};

/**
 * Follows Mongoose's own pluralisation rules closely enough to name real
 * collections correctly.
 *
 * The `ss` in the first rule is load-bearing: Mongoose adds `es` after a
 * *double* s (`address` → `addresses`) but leaves a single trailing s alone
 * (`ClinicSettings` → `clinicsettings`). Treating both the same produced
 * `clinicsettingses`, a collection that does not exist — and a wrong collection
 * name is a wrong finding, not a cosmetic slip.
 */
export function pluralize(word: string): string {
  if (word.length === 0) return word;
  const lower = word.toLowerCase();
  const irregular = IRREGULAR[lower];
  if (irregular) return irregular;
  if (/(ss|x|z|ch|sh)$/.test(lower)) return `${word}es`;
  // Already plural (or a mass noun like "settings", "data", "news").
  if (lower.endsWith('s')) return word;
  if (/[^aeiou]y$/.test(lower)) return `${word.slice(0, -1)}ies`;
  // Mongoose's own f-rule, copied deliberately narrow: only `[lr]f` and a
  // non-f + `fe` become `ves`. A broader `/(f|fe)$/` reads as more correct
  // English but names collections that do not exist — `Staff` became
  // `stafves` where Mongoose creates `staffs`, and `Roof`/`Chief`/`Leaf`
  // became `rooves`/`chieves`/`leaves` where Mongoose just appends `s`.
  // Matching Mongoose matters more than matching a dictionary, because the
  // collection is whatever Mongoose computed.
  if (/(?:[^f]fe|[lr]f)$/.test(lower)) return `${word.replace(/fe?$/, '')}ves`;
  if (/[^aeiou]o$/.test(lower)) return `${word}es`;
  return `${word}s`;
}

/** Mongoose type constructors seen in a schema definition. */
export const SCHEMA_TYPES = new Set([
  'String',
  'Number',
  'Boolean',
  'Date',
  'Buffer',
  'ObjectId',
  'Mixed',
  'Decimal128',
  'Map',
  'Array',
]);
