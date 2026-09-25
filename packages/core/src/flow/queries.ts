/**
 * The database queries one action runs: the code as written, and how long
 * each one took.
 *
 * The code comes from the source — the call on the db-op's line, with the
 * chain around it (`.find(filter).sort(...).limit(20)`) and, when an argument
 * is a variable, the lines that build it. The time comes from runtime spans
 * already merged into the graph (`node.timing`); nothing here connects to a
 * database. A query that has never been seen running says so rather than
 * showing a number it does not have.
 */

import { Node, SyntaxKind, type CallExpression } from 'ts-morph';
import type { FlowGraph } from '../graph/graph.js';
import type { Evidence, TimingStats } from '../graph/types.js';
import {
  callAtLine,
  condense,
  localVariable,
  nameOf,
  nearestFunction,
  SourceReader,
  type SourcePoint,
} from './actionsource.js';
import type { FeatureFlow } from './resolve.js';

export type QueryPartRole =
  | 'filter'
  | 'update'
  | 'document'
  | 'documents'
  | 'options'
  | 'pipeline'
  | 'operations'
  | 'field'
  | 'query'
  | 'argument';

export interface QueryLine {
  text: string;
  at: SourcePoint;
}

/** A variable the query reads, and where its value comes from. */
export interface QueryVariable {
  name: string;
  /** A parameter of the function the query is in: the caller supplies it. */
  parameterOf?: string;
  /** Its declaration, then every line that adds to it (`filter.x = …`, `or.push(…)`). */
  builtBy?: QueryLine[];
  /** `const filter = productFilter(…)`: how that helper builds what it returns. */
  helper?: { name: string; returns: string; builtBy: QueryLine[] };
}

export interface QueryPart {
  role: QueryPartRole;
  /** The argument as written: `{ id, ownerId }` or `filter`. */
  text: string;
  /** The variables the argument is made of. */
  variables?: QueryVariable[];
}

export interface ActionQuery {
  nodeId: string;
  collection: string;
  operation: string;
  /** read | create | update | delete | write */
  effect: string;
  at?: SourcePoint;
  /** The function the query is written in. */
  inFunction?: string;
  /** The whole statement's expression, chain included, as written. */
  code?: string;
  parts: QueryPart[];
  /** `.sort({ createdAt: -1 })`, `.limit(5)` — what the chain adds. */
  modifiers: string[];
  evidence: Evidence;
  timing?: TimingStats;
}

export interface ActionQueries {
  flowId: string;
  queries: ActionQuery[];
  /** The action's observed wall clock, when it has been seen running. */
  actionMs?: number;
  /** Sum of the queries' average times. */
  dbMs?: number;
  /** How many of the queries have a runtime measurement. */
  measured: number;
}

export interface ActionQueriesOptions {
  reader?: SourceReader;
}

/**
 * The queries an action runs. Listed as the flow reaches them, which follows
 * the call graph, not necessarily the order the statements execute in.
 */
export function actionQueries(
  graph: FlowGraph,
  flow: FeatureFlow,
  options: ActionQueriesOptions = {},
): ActionQueries {
  const reader = options.reader ?? new SourceReader(graph);
  const queries: ActionQuery[] = [];
  const seen = new Set<string>();
  for (const step of flow.steps) {
    if (step.kind !== 'db-op' || seen.has(step.nodeId)) continue;
    seen.add(step.nodeId);
    const node = graph.node(step.nodeId);
    const meta = { ...(node?.meta ?? {}), ...(step.meta ?? {}) } as Record<string, unknown>;
    const operation = String(meta['operation'] ?? step.label.split('.').pop() ?? '');
    const query: ActionQuery = {
      nodeId: step.nodeId,
      collection: String(meta['collection'] ?? step.label.split('.')[0] ?? ''),
      operation,
      effect: String(meta['effect'] ?? (meta['access'] === 'write' ? 'write' : 'read')),
      ...(step.file ? { at: { file: step.file, line: step.line ?? 1 } } : {}),
      parts: [],
      modifiers: [],
      evidence: node?.evidence ?? step.evidence,
      ...(node?.timing ? { timing: node.timing } : {}),
    };
    try {
      readQueryCode(reader, query);
    } catch {
      // The source could not be read; the query is still listed, without its code.
    }
    queries.push(query);
  }

  const timed = queries.filter((query) => query.timing);
  return {
    flowId: flow.id,
    queries,
    ...(flow.totalMs != null ? { actionMs: flow.totalMs } : {}),
    ...(timed.length
      ? { dbMs: Math.round(timed.reduce((sum, query) => sum + query.timing!.avgMs, 0) * 10) / 10 }
      : {}),
    measured: timed.length,
  };
}

/** Which argument means what, per driver method. Mongo driver, Mongoose and Prisma. */
export const ROLES: Record<string, QueryPartRole[]> = {
  find: ['filter', 'options'],
  findOne: ['filter', 'options'],
  findById: ['filter', 'options'],
  countDocuments: ['filter', 'options'],
  estimatedDocumentCount: ['options'],
  deleteOne: ['filter', 'options'],
  deleteMany: ['filter', 'options'],
  findOneAndDelete: ['filter', 'options'],
  findByIdAndDelete: ['filter', 'options'],
  distinct: ['field', 'filter', 'options'],
  updateOne: ['filter', 'update', 'options'],
  updateMany: ['filter', 'update', 'options'],
  findOneAndUpdate: ['filter', 'update', 'options'],
  findByIdAndUpdate: ['filter', 'update', 'options'],
  replaceOne: ['filter', 'document', 'options'],
  findOneAndReplace: ['filter', 'document', 'options'],
  insertOne: ['document', 'options'],
  create: ['document', 'options'],
  insertMany: ['documents', 'options'],
  aggregate: ['pipeline', 'options'],
  bulkWrite: ['operations', 'options'],
  // Prisma takes one object: `{ where, data, select }`.
  findMany: ['query'],
  findUnique: ['query'],
  findFirst: ['query'],
  count: ['query'],
  upsert: ['query'],
  update: ['query'],
  delete: ['query'],
};

/** Chain calls that only fetch or convert the result, not shape the query. */
const TERMINAL = new Set(['toArray', 'exec', 'lean', 'then', 'catch', 'next', 'hasNext']);

/** The driver call for a db-op: `products.deleteOne(…)` on its line. */
export function locateQueryCall(
  reader: SourceReader,
  file: string | undefined,
  line: number | undefined,
  operation: string,
): CallExpression | undefined {
  const source = reader.file(file);
  if (!source || !line) return undefined;
  return operationCall(callAtLine(source, line, `.${operation}`), operation);
}

function readQueryCode(reader: SourceReader, query: ActionQuery): void {
  if (!query.at) return;
  const call = locateQueryCall(reader, query.at.file, query.at.line, query.operation);
  if (!call) return;

  // Walk out to the end of the chain: `.find(f).sort(s).limit(n).toArray()`.
  let outer: Node = call;
  for (;;) {
    const parent = outer.getParent();
    const grand = parent?.getParent();
    if (
      parent &&
      Node.isPropertyAccessExpression(parent) &&
      grand &&
      Node.isCallExpression(grand)
    ) {
      const name = parent.getName();
      if (!TERMINAL.has(name)) query.modifiers.push(condense(`.${name}(${argsText(grand)})`, 90));
      outer = grand;
      continue;
    }
    break;
  }
  query.code = dedent(outer.getText());

  const fn = nearestFunction(call);
  if (fn) query.inFunction = nameOf(fn);
  const roles = ROLES[query.operation] ?? [];
  call.getArguments().forEach((argument, index) => {
    const part: QueryPart = {
      role: roles[index] ?? 'argument',
      text: condense(argument.getText(), 400),
    };
    if (fn) {
      const variables = namesIn(argument)
        .map((name) => explainVariable(reader, fn, name, 0))
        .filter((variable): variable is QueryVariable => variable !== undefined);
      if (variables.length) part.variables = variables;
    }
    query.parts.push(part);
  });
}

/**
 * The variables an argument is made of: the argument itself when it is one,
 * or the values inside an object or array — `{ ownerId, $or: or, ...clause }`.
 */
function namesIn(argument: Node): string[] {
  if (Node.isIdentifier(argument)) return [argument.getText()];
  if (!Node.isObjectLiteralExpression(argument) && !Node.isArrayLiteralExpression(argument))
    return [];
  const names: string[] = [];
  for (const node of argument.getDescendants()) {
    if (Node.isShorthandPropertyAssignment(node)) names.push(node.getName());
    else if (Node.isPropertyAssignment(node) || Node.isSpreadAssignment(node)) {
      const value = Node.isPropertyAssignment(node) ? node.getInitializer() : node.getExpression();
      if (value && Node.isIdentifier(value)) names.push(value.getText());
    }
  }
  return [...new Set(names)];
}

/** The call to `operation` itself, when the line's first call is an outer wrapper. */
function operationCall(
  call: CallExpression | undefined,
  operation: string,
): CallExpression | undefined {
  if (!call) return undefined;
  const matches = (candidate: CallExpression): boolean => {
    const callee = candidate.getExpression();
    return Node.isPropertyAccessExpression(callee) && callee.getName() === operation;
  };
  if (matches(call)) return call;
  return call.getDescendantsOfKind(SyntaxKind.CallExpression).find(matches) ?? call;
}

/** Where a variable's value comes from: its declaration and every line that adds to it. */
function explainVariable(
  reader: SourceReader,
  fn: Node,
  name: string,
  depth: number,
): QueryVariable | undefined {
  const parameter = (fn as unknown as { getParameters?: () => Node[] })
    .getParameters?.()
    .find((candidate) => Node.isParameterDeclaration(candidate) && candidate.getName() === name);
  if (parameter) return { name, parameterOf: nameOf(fn) };

  const declaration = localVariable(fn, name);
  if (!declaration || !Node.isVariableDeclaration(declaration)) return undefined;
  const lines: QueryLine[] = [];
  const statement = declaration.getFirstAncestorByKind(SyntaxKind.VariableStatement) ?? declaration;
  lines.push({ text: condense(dedent(statement.getText()), 600), at: reader.point(statement) });
  const scope = nearestFunction(declaration) ?? fn;
  lines.push(...additionsTo(reader, scope, name));
  const variable: QueryVariable = { name, builtBy: dedupe(lines).slice(0, 12) };

  // `const filter = productFilter(ownerId, query)`: open the helper once.
  const init = declaration.getInitializer();
  const called = init && Node.isAwaitExpression(init) ? init.getExpression() : init;
  if (depth === 0 && called && Node.isCallExpression(called)) {
    const callee = called.getExpression();
    const helper = Node.isIdentifier(callee)
      ? reader.functionNamed(callee.getText(), called.getSourceFile())
      : undefined;
    const returned = helper
      ?.getDescendantsOfKind(SyntaxKind.ReturnStatement)
      .filter((statement) => nearestFunction(statement) === helper)
      .map((statement) => statement.getExpression())
      .find((expression) => expression && Node.isIdentifier(expression));
    if (helper && returned) {
      const inner = explainVariable(reader, helper, returned.getText(), depth + 1);
      if (inner?.builtBy?.length)
        variable.helper = {
          name: callee.getText(),
          returns: returned.getText(),
          builtBy: inner.builtBy,
        };
    }
  }
  return variable;
}

/** `filter.category = x`, `filter[key] = y`, `or.push({ … })` — with the `if` that guards each. */
function additionsTo(reader: SourceReader, scope: Node, name: string): QueryLine[] {
  const lines: QueryLine[] = [];
  const guarded = (node: Node): string => {
    const owner = node.getFirstAncestorByKind(SyntaxKind.IfStatement);
    // Only a one-line `if (x) filter.y = z;` is quoted whole; a block would be a wall.
    return owner && owner.getStartLineNumber() === node.getStartLineNumber()
      ? owner.getText()
      : node.getText();
  };
  const nodes = scope.getDescendants().filter((node) => {
    if (Node.isBinaryExpression(node)) {
      if (node.getOperatorToken().getKind() !== SyntaxKind.EqualsToken) return false;
      const left = node.getLeft().getText();
      return left.startsWith(`${name}.`) || left.startsWith(`${name}[`);
    }
    if (Node.isCallExpression(node)) {
      const callee = node.getExpression().getText();
      return callee === `${name}.push` || callee === `${name}.unshift`;
    }
    return false;
  });
  for (const node of nodes)
    lines.push({ text: condense(dedent(guarded(node)), 240), at: reader.point(node) });
  return lines;
}

function argsText(call: CallExpression): string {
  return call
    .getArguments()
    .map((argument) => argument.getText())
    .join(', ');
}

function dedupe<T extends { text: string }>(lines: T[]): T[] {
  const seen = new Set<string>();
  return lines.filter((line) => (seen.has(line.text) ? false : (seen.add(line.text), true)));
}

/** Strip the indentation the code had in its file, keeping its shape. */
function dedent(text: string): string {
  const [first = '', ...rest] = text.split('\n');
  const lines = rest.filter((line) => line.trim());
  const indents = lines.map((line) => /^\s*/.exec(line)![0].length);
  let cut = indents.length ? Math.min(...indents) : 0;
  // A chain (`db\n  .collection(…)\n  .find(…)`) keeps its continuation indent.
  if (lines.some((line) => /^\s*/.exec(line)![0].length === cut && line.trim().startsWith('.')))
    cut = Math.max(0, cut - 2);
  return [first, ...rest.map((line) => line.slice(cut))].join('\n').trimEnd();
}
