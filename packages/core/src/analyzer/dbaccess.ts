import { SyntaxKind, type Node, type SourceFile } from 'ts-morph';
import type { FlowGraph } from '../graph/graph.js';
import { ids } from '../graph/ids.js';
import { callsIn, calleeMember, calleeReceiver, lineOf } from './ast.js';
import { collectionNameOf, dbAccessOf } from './mongo.js';

/**
 * Database access outside a class.
 *
 * NestJS services hold their models in injected fields, which the backend
 * analyzer resolves from the constructor. Everything else — an Express route
 * handler, a Next.js API route, a plain module function — reaches for a model
 * imported at the top of the file:
 *
 *   const Note = mongoose.model('Note', schema);
 *   app.post('/notes', async (req, res) => { await Note.create(...) });
 *
 * Without this, such a backend produces routes with nothing behind them: the
 * flow stops at the handler and never reaches a collection.
 */
export function linkDbOperations(
  scope: Node,
  file: SourceFile,
  rel: string,
  graph: FlowGraph,
  ownerId: string,
): number {
  let linked = 0;

  for (const call of callsIn(scope)) {
    const operation = calleeMember(call);
    const access = dbAccessOf(operation);
    if (!access) continue;

    const receiver = calleeReceiver(call);
    if (!receiver) continue;

    const collection = collectionFor(receiver, file);
    if (!collection) continue;

    const opId = ids.dbOp(collection, operation, `${rel}:${ownerId}`);
    graph.addNode({
      id: opId,
      kind: 'db-op',
      label: `${collection}.${operation}`,
      source: { file: rel, line: lineOf(call) },
      meta: { collection, operation, access },
    });
    graph.addEdge({ from: ownerId, to: opId, kind: 'queries' });

    const collectionId = ids.collection(collection);
    graph.addNode({
      id: collectionId,
      kind: 'collection',
      label: collection,
      meta: { database: 'mongodb' },
    });
    graph.addEdge({
      from: opId,
      to: collectionId,
      kind: access === 'read' ? 'reads' : 'writes',
    });
    linked += 1;
  }

  return linked;
}

/**
 * Which collection a receiver refers to.
 *
 * Only accepted when the name can be tied to a model declaration, an explicit
 * `db.collection('x')`, or a strong naming convention. A receiver we cannot
 * justify is skipped: inventing a collection is worse than missing one.
 */
export function collectionFor(receiver: string, file: SourceFile): string | undefined {
  // db.collection('patients').find(...)
  const explicitCollection = /collection\(\s*['"]([^'"]+)['"]\s*\)/.exec(receiver);
  if (explicitCollection?.[1]) return explicitCollection[1];

  const head = receiver.split('.')[0] ?? receiver;
  const declaration = findDeclaration(file, head);
  const initializer = declaration?.getInitializer()?.getText() ?? '';

  // const Note = mongoose.model('Note', schema)
  const named = /\bmodel(?:s)?\s*(?:<[^>]*>)?\s*\(\s*['"]([^'"]+)['"]/.exec(initializer);
  if (named?.[1]) return collectionNameOf(named[1]);

  // const Note = mongoose.models.Note ?? mongoose.model(...)
  const viaModels = /\bmodels\s*[.[]\s*['"]?([A-Za-z0-9_]+)/.exec(initializer);
  if (viaModels?.[1]) return collectionNameOf(viaModels[1]);

  if (declaration) {
    // Declared here but not recognisably a model.
    if (!/mongoose|Schema|model|collection|prisma|db\b/i.test(initializer)) return undefined;
    return collectionNameOf(head.replace(/(Model|Collection|Repo|Repository)$/, ''));
  }

  // Imported: `import { PatientModel } from '../lib/models'`. The convention
  // has to carry it, so require an explicit marker or PascalCase.
  if (/(Model|Collection)$/.test(head)) {
    return collectionNameOf(head.replace(/(Model|Collection)$/, ''));
  }
  if (/^[A-Z][A-Za-z0-9]*$/.test(head) && isImported(file, head)) {
    return collectionNameOf(head);
  }

  return undefined;
}

/** Top-level first, then anywhere in the file (models are sometimes declared in a block). */
function findDeclaration(file: SourceFile, name: string) {
  return (
    file.getVariableDeclaration(name) ??
    file
      .getDescendantsOfKind(SyntaxKind.VariableDeclaration)
      .find((declaration) => declaration.getName() === name)
  );
}

function isImported(file: SourceFile, name: string): boolean {
  for (const declaration of file.getImportDeclarations()) {
    if (declaration.getDefaultImport()?.getText() === name) return true;
    for (const named of declaration.getNamedImports()) {
      if ((named.getAliasNode() ?? named.getNameNode()).getText() === name) return true;
    }
  }
  return false;
}
