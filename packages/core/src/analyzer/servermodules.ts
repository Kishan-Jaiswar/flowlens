import { Node, SyntaxKind, type SourceFile } from 'ts-morph';
import type { FlowGraph } from '../graph/graph.js';
import { ids } from '../graph/ids.js';
import { calleeName, callsIn, functionName, lineOf } from './ast.js';
import { classifyFile, isFileSystemRoute, isServerCandidate } from './classify.js';
import { HTTP_METHODS } from './http.js';
import { linkDbOperations, type CollectionAliases } from './dbaccess.js';
import type { LoadedProject } from './project.js';

/**
 * The data layer that lives in plain modules.
 *
 * NestJS keeps its queries in decorated services and Express keeps them in the
 * route handler, and both are already handled. But the most common shape of a
 * modern Next.js app is neither:
 *
 *   app/api/stock/route.ts   ->  export async function POST(req) {
 *                                  return adjustStock(shopId, input)
 *                                }
 *   lib/db/store.ts          ->  export async function adjustStock(...) {
 *                                  await products.updateOne(...)
 *                                }
 *
 * The route is found by `fileroutes`, but nothing followed `adjustStock` into
 * the module that declares it, so every query in the app was invisible: a real
 * project of this shape produced 21 routes and zero collections.
 *
 * This pass declares those exported functions, joins route -> function and
 * function -> function, and attributes each function's queries to it. Functions
 * that turn out to reach no query are removed again, so ordinary helpers do not
 * clutter the graph.
 */
export function analyzeServerModules(
  loaded: LoadedProject,
  graph: FlowGraph,
  aliases?: CollectionAliases,
): number {
  /** Exported function name -> the nodes declaring it. */
  const declared = new Map<string, Array<{ id: string; file: string }>>();
  const bodies: Array<{ id: string; file: SourceFile; rel: string; scope: Node }> = [];
  const candidates = new Set<string>();

  // ---- 1. Declare exported functions in server-side modules --------------
  for (const file of loaded.sourceFiles) {
    const rel = loaded.rel(file);
    // Route files are the caller, not the module; their handler already exists.
    if (isFileSystemRoute(rel)) continue;
    const classification = classifyFile(file, rel);
    if (!isServerCandidate(classification)) continue;

    for (const fn of exportedFunctions(file)) {
      const name = fn.name;
      const id = ids.method(`module:${rel}`, name);
      graph.addNode({
        id,
        kind: 'method',
        label: name,
        source: { file: rel, line: lineOf(fn.scope) },
        meta: { layer: 'module', module: rel },
      });
      const list = declared.get(name);
      if (list) list.push({ id, file: rel });
      else declared.set(name, [{ id, file: rel }]);
      bodies.push({ id, file, rel, scope: fn.scope });
      candidates.add(id);
    }
  }

  if (declared.size === 0) return 0;

  // ---- 2. Each module function's own queries -----------------------------
  for (const entry of bodies) {
    linkDbOperations(entry.scope, entry.file, entry.rel, graph, entry.id, aliases);
  }

  // ---- 3. Join callers to those functions --------------------------------
  let linked = 0;

  // Module function -> module function.
  for (const entry of bodies) {
    linked += linkCalls(graph, entry.scope, entry.rel, entry.id, declared);
  }

  /**
   * Route handler -> module function.
   *
   * `fileroutes` gives the whole route module a single handler node, so every
   * module function called anywhere in the file belongs to it — which is
   * correct, because a route module exists to serve that one endpoint.
   */
  for (const file of loaded.sourceFiles) {
    const rel = loaded.rel(file);
    if (!isFileSystemRoute(rel)) continue;

    /**
     * Per verb where the module exports them separately, so a PUT does not
     * inherit the DELETE's queries; otherwise the file-wide handler.
     */
    let scoped = false;
    for (const verb of HTTP_METHODS) {
      const verbHandlerId = ids.method(`controller:${rel}#file-route`, verb);
      if (!graph.hasNode(verbHandlerId)) continue;
      const scope = verbScope(file, verb);
      if (!scope) continue;
      scoped = true;
      linked += linkCalls(graph, scope, rel, verbHandlerId, declared);
    }
    if (scoped) continue;

    const handlerId = ids.method(`controller:${rel}#file-route`, 'handler');
    if (!graph.hasNode(handlerId)) continue;
    linked += linkCalls(graph, file, rel, handlerId, declared);
  }

  pruneQuerylessModules(graph, candidates);
  return linked;
}

/**
 * Bare-identifier calls in `scope` that name a declared module function.
 *
 * Bare identifiers only: `foo.bar()` is a method on some object, not an import,
 * and guessing otherwise invents edges.
 */
function linkCalls(
  graph: FlowGraph,
  scope: Node,
  rel: string,
  fromId: string,
  declared: Map<string, Array<{ id: string; file: string }>>,
): number {
  let linked = 0;
  for (const call of callsIn(scope)) {
    const callee = calleeName(call);
    if (!callee || callee.includes('.')) continue;
    const targets = declared.get(callee);
    if (!targets || targets.length === 0) continue;
    // Prefer a declaration in this file, then an unambiguous one elsewhere.
    const target =
      targets.find((candidate) => candidate.file === rel) ??
      (targets.length === 1 ? targets[0] : undefined);
    if (!target || target.id === fromId) continue;
    graph.addEdge({ from: fromId, to: target.id, kind: 'calls', meta: { line: lineOf(call) } });
    linked += 1;
  }
  return linked;
}

/**
 * Drop module functions that reach no query.
 *
 * Declaring every exported function is what lets a route reach
 * `adjustStock -> recordMovement -> movements.insertOne`, but it also picks up
 * formatters and validators. Anything that cannot reach a `db-op` is not part of
 * the data layer, so it goes rather than padding the graph and the impact counts.
 */
function pruneQuerylessModules(graph: FlowGraph, candidates: Set<string>): void {
  for (const id of candidates) {
    if (!graph.hasNode(id)) continue;
    let reachesQuery = false;
    for (const reachedId of graph.reachable(id, { kinds: ['calls', 'queries'] }).keys()) {
      if (graph.node(reachedId)?.kind === 'db-op') {
        reachesQuery = true;
        break;
      }
    }
    if (!reachesQuery) graph.removeNode(id);
  }
}

/** The body of `export function PUT(...)`, when the module exports one. */
function verbScope(file: SourceFile, verb: string): Node | undefined {
  for (const fn of file.getFunctions()) {
    if (fn.isExported() && (fn.getName() ?? '').toUpperCase() === verb) return fn;
  }
  for (const declaration of file.getVariableDeclarations()) {
    if (declaration.getName().toUpperCase() !== verb) continue;
    if (!declaration.getVariableStatement()?.isExported()) continue;
    const initializer = declaration.getInitializer();
    if (initializer) return initializer;
  }
  return undefined;
}

interface ExportedFunction {
  name: string;
  scope: Node;
}

/**
 * Exported functions, in both shapes real code uses.
 *
 *   export async function adjustStock() {}
 *   export const adjustStock = async () => {}
 */
function exportedFunctions(file: SourceFile): ExportedFunction[] {
  const out: ExportedFunction[] = [];

  for (const fn of file.getFunctions()) {
    if (!fn.isExported()) continue;
    const name = functionName(fn);
    if (name) out.push({ name, scope: fn });
  }

  for (const statement of file.getVariableStatements()) {
    if (!statement.isExported()) continue;
    for (const declaration of statement.getDeclarations()) {
      const initializer = declaration.getInitializer();
      if (!initializer) continue;
      if (
        !Node.isArrowFunction(initializer) &&
        !Node.isFunctionExpression(initializer) &&
        initializer.getKind() !== SyntaxKind.ArrowFunction
      ) {
        continue;
      }
      out.push({ name: declaration.getName(), scope: initializer });
    }
  }

  return out;
}
