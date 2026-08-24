/**
 * Mongo/Mongoose knowledge: which calls touch the database, whether they read
 * or write, and which physical collection a model name maps to.
 */

export type DbAccess = 'read' | 'write';

/**
 * Mongoose/Mongo operations FlowLens recognises, and whether each one reads or
 * writes. Anything not listed is ignored, which keeps `this.logger.log()` out
 * of the data layer of the graph.
 */
export const DB_OPERATIONS: Record<string, DbAccess> = {
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
  // writes
  create: 'write',
  insertOne: 'write',
  insertMany: 'write',
  save: 'write',
  updateOne: 'write',
  updateMany: 'write',
  replaceOne: 'write',
  findOneAndUpdate: 'write',
  findByIdAndUpdate: 'write',
  findOneAndReplace: 'write',
  findOneAndDelete: 'write',
  findByIdAndDelete: 'write',
  findByIdAndRemove: 'write',
  deleteOne: 'write',
  deleteMany: 'write',
  remove: 'write',
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

export function dbAccessOf(operation: string): DbAccess | undefined {
  if (CHAINED_MODIFIERS.has(operation)) return undefined;
  return DB_OPERATIONS[operation];
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
  if (/(f|fe)$/.test(lower)) return `${word.replace(/fe?$/, '')}ves`;
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
