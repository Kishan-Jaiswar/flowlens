import { Node, SyntaxKind, type SourceFile } from 'ts-morph';
import type { FlowGraph } from '../graph/graph.js';
import { enclosingFunction, functionName, lineOf } from './ast.js';
import type { LoadedProject } from './project.js';

/**
 * Join a job queue's producer to the worker that runs its jobs.
 *
 * `queue.add("import", rows)` in a route only puts a job in Redis; the rows are
 * written by `new Worker("medicine-import", processImportJob)` in another
 * process. Nothing in the code calls the processor, so a flow that queued an
 * import ended at "enqueued to job queue" — the upsert, the stock movements
 * and the import record it finishes with were all missing.
 *
 * Matched on the queue's name, as the queue library itself does: a literal, or
 * a constant (`IMPORT_QUEUE_NAME`) resolved in the file or the one exporting it.
 * Covers BullMQ (`new Queue`/`new Worker`), Bull (`queue.process(fn)`) and
 * Bee-Queue (`new BeeQueue`).
 */
export function linkQueueWorkers(loaded: LoadedProject, graph: FlowGraph): number {
  const constants = exportedStrings(loaded.sourceFiles);
  /** Function or variable name -> queue name: `getImportQueue`, `importQueue`. */
  const queueOf = new Map<string, string>();
  /** Queue name -> processor function names. */
  const workers = new Map<string, Set<string>>();

  for (const file of loaded.sourceFiles) {
    for (const created of file.getDescendantsOfKind(SyntaxKind.NewExpression)) {
      const ctor = created.getExpression().getText();
      const [nameArg, processor] = created.getArguments();
      const name = stringOf(nameArg, file, constants);
      if (!name) continue;
      if (/^(Queue|Bull|BeeQueue)$/.test(ctor)) {
        const variable = created.getFirstAncestorByKind(SyntaxKind.VariableDeclaration);
        if (variable) queueOf.set(variable.getName(), name);
        const owner = enclosingFunction(created);
        const ownerName = owner ? functionName(owner) : undefined;
        if (ownerName) queueOf.set(ownerName, name);
      } else if (ctor === 'Worker' && processor) {
        for (const fn of processorNames(processor)) add(workers, name, fn);
      }
    }
  }
  // Bull: `importQueue.process(processImportJob)`, `.process("name", 5, fn)`.
  for (const file of loaded.sourceFiles) {
    for (const call of file.getDescendantsOfKind(SyntaxKind.CallExpression)) {
      const callee = call.getExpression();
      if (!Node.isPropertyAccessExpression(callee) || callee.getName() !== 'process') continue;
      const name = queueName(callee.getExpression(), queueOf);
      const processor = call.getArguments().at(-1);
      if (name && processor) for (const fn of processorNames(processor)) add(workers, name, fn);
    }
  }
  if (workers.size === 0) return 0;

  let linked = 0;
  for (const effect of graph.nodesOfKind('external-effect')) {
    if (effect.meta?.['effectKind'] !== 'queue' || !effect.source) continue;
    const file = loaded.sourceFiles.find(
      (candidate) => loaded.rel(candidate) === effect.source!.file,
    );
    const call = file
      ?.getDescendantsOfKind(SyntaxKind.CallExpression)
      .find(
        (candidate) =>
          lineOf(candidate) === effect.source!.line &&
          Node.isPropertyAccessExpression(candidate.getExpression()),
      );
    const receiver = call?.getExpression();
    if (!receiver || !Node.isPropertyAccessExpression(receiver)) continue;
    const name = queueName(receiver.getExpression(), queueOf);
    if (!name) continue;
    for (const processor of workers.get(name) ?? []) {
      const targets = graph.nodesOfKind('method').filter((node) => node.label === processor);
      // A name two modules share is not a link the queue's name can settle.
      if (targets.length !== 1) continue;
      graph.addNode({ ...effect, meta: { ...effect.meta, queue: name, worker: processor } });
      graph.addEdge({
        from: effect.id,
        to: targets[0]!.id,
        kind: 'calls',
        meta: { background: true, queue: name },
      });
      linked += 1;
    }
  }
  return linked;
}

/** The queue a receiver is: `queue` from `getImportQueue()`, `importQueue`, `getImportQueue()`. */
function queueName(receiver: Node, queueOf: Map<string, string>): string | undefined {
  if (Node.isCallExpression(receiver)) return queueOf.get(receiver.getExpression().getText());
  const text = receiver.getText().replace(/^this\./, '');
  if (queueOf.has(text)) return queueOf.get(text);
  if (!Node.isIdentifier(receiver)) return undefined;
  // `const queue = getImportQueue();`
  const declaration = receiver
    .getSourceFile()
    .getDescendantsOfKind(SyntaxKind.VariableDeclaration)
    .find((candidate) => candidate.getName() === text);
  const init = declaration?.getInitializer();
  if (init && Node.isCallExpression(init)) return queueOf.get(init.getExpression().getText());
  if (init && Node.isAwaitExpression(init)) {
    const inner = init.getExpression();
    if (Node.isCallExpression(inner)) return queueOf.get(inner.getExpression().getText());
  }
  return undefined;
}

/** `processImportJob`, `(job) => processImportJob(job)`, `async (job) => { await run(job) }`. */
function processorNames(processor: Node): string[] {
  if (Node.isIdentifier(processor)) return [processor.getText()];
  if (Node.isArrowFunction(processor) || Node.isFunctionExpression(processor)) {
    return processor
      .getDescendantsOfKind(SyntaxKind.CallExpression)
      .map((call) => call.getExpression())
      .filter((callee) => Node.isIdentifier(callee))
      .map((callee) => callee.getText());
  }
  return [];
}

/** A literal, or a constant declared in this file or exported by another. */
function stringOf(
  node: Node | undefined,
  file: SourceFile,
  exported: Map<string, string>,
): string | undefined {
  if (!node) return undefined;
  if (Node.isStringLiteral(node) || Node.isNoSubstitutionTemplateLiteral(node))
    return node.getLiteralValue();
  if (!Node.isIdentifier(node)) return undefined;
  const local = file.getVariableDeclaration(node.getText())?.getInitializer();
  if (local && (Node.isStringLiteral(local) || Node.isNoSubstitutionTemplateLiteral(local)))
    return local.getLiteralValue();
  return exported.get(node.getText());
}

/** `export const IMPORT_QUEUE_NAME = "medicine-import"`, across the project. */
function exportedStrings(files: SourceFile[]): Map<string, string> {
  const found = new Map<string, string>();
  for (const file of files) {
    for (const statement of file.getVariableStatements()) {
      if (!statement.isExported()) continue;
      for (const declaration of statement.getDeclarations()) {
        const init = declaration.getInitializer();
        if (init && (Node.isStringLiteral(init) || Node.isNoSubstitutionTemplateLiteral(init)))
          found.set(declaration.getName(), init.getLiteralValue());
      }
    }
  }
  return found;
}

function add(map: Map<string, Set<string>>, key: string, value: string): void {
  const set = map.get(key);
  if (set) set.add(value);
  else map.set(key, new Set([value]));
}
