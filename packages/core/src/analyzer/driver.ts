import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Node, SyntaxKind, type CallExpression, type SourceFile, type TypeNode } from 'ts-morph';
import type { FlowGraph } from '../graph/graph.js';
import { ids } from '../graph/ids.js';
import {
  calleeMember,
  calleeReceiver,
  declarationOf,
  enclosingFunction,
  functionName,
  lineOf,
} from './ast.js';
import { collectionFor, type CollectionAliases } from './dbaccess.js';
import type { LoadedProject } from './project.js';

/**
 * What the native MongoDB driver says about its collections without a schema.
 *
 * A Mongoose project declares its fields, a Prisma project its tables. A project
 * on the plain `mongodb` driver says the same three things in other places, and
 * reading only its queries left every field untyped, every collection in one
 * unnamed database, and every unique key unknown:
 *
 *   - `db.collection<Medicine>("medicines")`: the TypeScript type is the schema.
 *   - `client.db(process.env.CLINICS_DB)`: which database the handle is in.
 *   - `medicines.createIndex({ id: 1 }, { unique: true })`: the indexes.
 *
 * Runs after every query is linked and before the relations pass, so the fields
 * it declares are there for a `medicineId` to be read as a link.
 */

/** The database a handle points at: a literal name, or the variable that holds it. */
export interface DatabaseName {
  name: string;
  /** True when `name` is an environment variable, not the database's own name. */
  env?: boolean;
  /** The database's own name, read from the project's env file: `pharma-dev`. */
  value?: string;
  /** The env file it was read from: `.env.local`. */
  from?: string;
}

export interface CollectionIndex {
  /** In order, with the direction or kind: `[['ownerId', '1'], ['createdAt', '-1']]`. */
  keys: Array<[string, string]>;
  unique?: boolean;
  /** `expireAfterSeconds`: a document is deleted this long after the date in the key. */
  ttlSeconds?: number;
  sparse?: boolean;
  name?: string;
  /** Other options set on it, by name: `collation`, `partialFilterExpression`. */
  options?: string[];
  source: { file: string; line: number };
}

interface Site {
  collection: string;
  type?: string;
  database?: DatabaseName;
  file: string;
  line: number;
  /** The property or variable the handle is stored in: `medicines`, `smsTemplates`. */
  binding?: string;
  /** True when the binding is a property, shared across files; a variable is local. */
  shared?: boolean;
}

const MAX_DEPTH = 5;

export function declareDriverSchemas(
  loaded: LoadedProject,
  graph: FlowGraph,
  aliases: CollectionAliases,
): void {
  if (graph.nodesOfKind('collection').length === 0) return;
  const types = typeIndex(loaded.sourceFiles);
  const functions = functionIndex(loaded.sourceFiles);
  const resolver = new DatabaseResolver(loaded, functions);

  const sites: Site[] = [];
  for (const file of loaded.sourceFiles) {
    const rel = loaded.rel(file);
    for (const call of file.getDescendantsOfKind(SyntaxKind.CallExpression)) {
      if (calleeMember(call) !== 'collection') continue;
      const arg = call.getArguments()[0];
      if (!arg || !(Node.isStringLiteral(arg) || Node.isNoSubstitutionTemplateLiteral(arg)))
        continue;
      const callee = call.getExpression();
      if (!Node.isPropertyAccessExpression(callee)) continue;
      const typeArg = call.getTypeArguments()[0];
      const database = resolver.of(callee.getExpression(), 0);
      const holder = call.getParent();
      const binding =
        holder && (Node.isPropertyAssignment(holder) || Node.isVariableDeclaration(holder))
          ? holder.getName().replace(/^['"`]|['"`]$/g, '')
          : undefined;
      sites.push({
        collection: arg.getLiteralValue(),
        ...(typeArg && Node.isTypeReference(typeArg)
          ? { type: typeArg.getTypeName().getText() }
          : {}),
        ...(database ? { database } : {}),
        file: rel,
        line: lineOf(call),
        ...(binding ? { binding, shared: Node.isPropertyAssignment(holder) } : {}),
      });
    }
  }

  // `medicines: Collection<Medicine>` in the interface a factory returns.
  const typed = new Map<string, string>();
  for (const file of loaded.sourceFiles) {
    for (const property of file.getDescendantsOfKind(SyntaxKind.PropertySignature)) {
      const type = property.getTypeNode();
      if (!type || !Node.isTypeReference(type) || type.getTypeName().getText() !== 'Collection')
        continue;
      const arg = type.getTypeArguments()[0];
      const collection = aliases.get(property.getName());
      if (collection && arg && Node.isTypeReference(arg))
        typed.set(collection, arg.getTypeName().getText());
    }
  }

  for (const collection of graph.nodesOfKind('collection')) {
    const name = collection.label;
    const own = sites.filter((site) => site.collection === name);

    const databases = uniqueBy(
      own.flatMap((site) => (site.database ? [site.database] : [])),
      (db) => db.name,
    );
    if (databases.length > 0)
      graph.addNode({ ...collection, meta: { ...collection.meta, databases } });

    const named = [...new Set(own.flatMap((site) => (site.type ? [site.type] : [])))];
    const type = named.length === 1 ? named[0] : named.length === 0 ? typed.get(name) : undefined;
    const hasModel = graph
      .predecessors(collection.id, ['defines'])
      .some((node) => node.kind === 'model');
    const declaration = type ? types.get(type) : undefined;
    // shortcut: one type serves one collection; a type shared by two collections declares neither.
    if (type && declaration && !hasModel && !graph.node(ids.model(type))) {
      declareModel(graph, loaded, types, type, declaration, name, collection.id);
    }
  }

  labelOperations(loaded, graph, sites);
  declareIndexes(loaded, graph, aliases);
}

// ---------------------------------------------------------------------------
// The type as a schema
// ---------------------------------------------------------------------------

type TypeDeclaration = Node;

/** Interfaces and type aliases by name; a name declared twice is dropped, not guessed at. */
function typeIndex(files: SourceFile[]): Map<string, TypeDeclaration> {
  const found = new Map<string, TypeDeclaration | null>();
  for (const file of files) {
    for (const declaration of [...file.getInterfaces(), ...file.getTypeAliases()]) {
      const name = declaration.getName();
      found.set(name, found.has(name) ? null : declaration);
    }
  }
  return new Map(
    [...found].filter((entry): entry is [string, TypeDeclaration] => entry[1] !== null),
  );
}

interface TypedField {
  path: string;
  type: string;
  required: boolean;
  file: string;
  line: number;
}

function declareModel(
  graph: FlowGraph,
  loaded: LoadedProject,
  types: Map<string, TypeDeclaration>,
  type: string,
  declaration: TypeDeclaration,
  collection: string,
  collectionId: string,
): void {
  const modelId = ids.model(type);
  const file = loaded.rel(declaration.getSourceFile());
  graph.addNode({
    id: modelId,
    kind: 'model',
    label: type,
    source: { file, line: lineOf(declaration) },
    meta: { collection, typed: true },
  });
  graph.addEdge({ from: modelId, to: collectionId, kind: 'defines' });
  for (const field of fieldsOf(loaded, types, declaration, '', 0, new Set([type]))) {
    const fieldId = ids.field(modelId, field.path);
    graph.addNode({
      id: fieldId,
      kind: 'field',
      label: field.path,
      source: { file: field.file, line: field.line },
      meta: { owner: type, type: field.type, ...(field.required ? { required: true } : {}) },
    });
    graph.addEdge({ from: modelId, to: fieldId, kind: 'defines' });
  }
}

/** Every property, `extends` included, and the fields inside objects and arrays of objects. */
function fieldsOf(
  loaded: LoadedProject,
  types: Map<string, TypeDeclaration>,
  declaration: Node,
  prefix: string,
  depth: number,
  seen: Set<string>,
): TypedField[] {
  if (depth > 3) return [];
  const members: Node[] = [];
  const collect = (node: Node | undefined): void => {
    if (!node) return;
    if (Node.isInterfaceDeclaration(node)) {
      for (const base of node.getExtends()) {
        const name = base.getExpression().getText();
        if (!seen.has(name)) collect(types.get(name));
      }
      members.push(...node.getProperties());
    } else if (Node.isTypeAliasDeclaration(node)) collect(node.getTypeNode());
    else if (Node.isTypeLiteral(node)) members.push(...node.getProperties());
    else if (Node.isIntersectionTypeNode(node)) node.getTypeNodes().forEach(collect);
    else if (Node.isTypeReference(node)) {
      const name = node.getTypeName().getText();
      if (!seen.has(name)) collect(types.get(name));
    }
  };
  collect(declaration);

  const out: TypedField[] = [];
  for (const member of members) {
    if (!Node.isPropertySignature(member)) continue;
    const path = `${prefix}${member.getName().replace(/^['"`]|['"`]$/g, '')}`;
    const typeNode = member.getTypeNode();
    out.push({
      path,
      type: typeNode ? typeText(typeNode, types) : 'unknown',
      required: !member.hasQuestionToken(),
      file: loaded.rel(member.getSourceFile()),
      line: lineOf(member),
    });
    const inner = typeNode && objectInside(typeNode, types);
    if (inner) {
      const next = new Set(seen);
      if (inner.name) next.add(inner.name);
      out.push(
        ...fieldsOf(
          loaded,
          types,
          inner.node,
          `${path}${inner.array ? '[]' : ''}.`,
          depth + 1,
          next,
        ),
      );
    }
  }
  return out;
}

/** The object a property holds, directly or as a list: `Batch[]`, `{ entityId?: string }`. */
function objectInside(
  node: TypeNode,
  types: Map<string, TypeDeclaration>,
): { node: Node; array: boolean; name?: string } | undefined {
  let array = false;
  let current: TypeNode = node;
  // `T | undefined | null` holds a T.
  if (Node.isUnionTypeNode(current)) {
    const parts = current
      .getTypeNodes()
      .filter((part) => !/^(undefined|null)$/.test(part.getText()));
    if (parts.length !== 1) return undefined;
    current = parts[0]!;
  }
  if (Node.isArrayTypeNode(current)) {
    array = true;
    current = current.getElementTypeNode();
  } else if (
    Node.isTypeReference(current) &&
    /^(Readonly)?Array$/.test(current.getTypeName().getText())
  ) {
    const element = current.getTypeArguments()[0];
    if (!element) return undefined;
    array = true;
    current = element;
  }
  if (Node.isTypeLiteral(current)) return { node: current, array };
  if (!Node.isTypeReference(current)) return undefined;
  const name = current.getTypeName().getText();
  const declaration = types.get(name);
  // Only a type the project declares as an object: never `Date`, `ObjectId` or a union alias.
  if (!declaration) return undefined;
  const isObject =
    Node.isInterfaceDeclaration(declaration) ||
    (Node.isTypeAliasDeclaration(declaration) &&
      Node.isTypeLiteral(declaration.getTypeNodeOrThrow()));
  return isObject ? { node: declaration, array, name } : undefined;
}

/** The type as written, a union of literals spelled out: `MedicineStatus` -> `"active" | "inactive"`. */
function typeText(node: TypeNode, types: Map<string, TypeDeclaration>): string {
  // An inline object's keys are its own fields, listed under it.
  if (Node.isTypeLiteral(node)) return 'object';
  if (Node.isArrayTypeNode(node) && Node.isTypeLiteral(node.getElementTypeNode()))
    return 'object[]';
  // `User["role"]`: the type that property is declared with.
  if (Node.isIndexedAccessTypeNode(node)) {
    const owner = node.getObjectTypeNode();
    const declaration = Node.isTypeReference(owner)
      ? types.get(owner.getTypeName().getText())
      : undefined;
    const body =
      declaration && Node.isTypeAliasDeclaration(declaration)
        ? declaration.getTypeNode()
        : declaration;
    const key = node
      .getIndexTypeNode()
      .getText()
      .replace(/^['"`]|['"`]$/g, '');
    const member =
      body && (Node.isInterfaceDeclaration(body) || Node.isTypeLiteral(body))
        ? body.getProperty(key)
        : undefined;
    const declared = member && Node.isPropertySignature(member) ? member.getTypeNode() : undefined;
    if (declared) return typeText(declared, types);
  }
  const text = node.getText().replace(/\s+/g, ' ');
  if (!Node.isTypeReference(node)) return text;
  const alias = types.get(node.getTypeName().getText());
  const aliased = alias && Node.isTypeAliasDeclaration(alias) ? alias.getTypeNode() : undefined;
  if (
    aliased &&
    Node.isUnionTypeNode(aliased) &&
    aliased.getTypeNodes().every((part) => Node.isLiteralTypeNode(part))
  )
    return aliased
      .getText()
      .replace(/\s+/g, ' ')
      .replace(/^\|\s*/, '');
  return text;
}

// ---------------------------------------------------------------------------
// Which database
// ---------------------------------------------------------------------------

type FunctionLike = Node;

/** Top-level functions by name, declared or `const f = () => …`; a name declared twice is dropped. */
function functionIndex(files: SourceFile[]): Map<string, FunctionLike> {
  const found = new Map<string, FunctionLike | null>();
  const add = (name: string | undefined, node: FunctionLike) => {
    if (name) found.set(name, found.has(name) ? null : node);
  };
  for (const file of files) {
    for (const fn of file.getFunctions()) add(fn.getName(), fn);
    for (const declaration of file.getVariableDeclarations()) {
      const init = declaration.getInitializer();
      if (init && (Node.isArrowFunction(init) || Node.isFunctionExpression(init)))
        add(declaration.getName(), init);
    }
  }
  return new Map([...found].filter((entry): entry is [string, FunctionLike] => entry[1] !== null));
}

/**
 * Follows a database handle back to the `.db(name)` that made it.
 *
 * Through variables, `await`, wrappers (`traceDb(client.db(X))`), functions that
 * return one (`getClinicsDb()`), and parameters (`rawCollections(db)`), whose
 * callers must all agree. Anything it cannot follow is left unnamed, never guessed.
 */
class DatabaseResolver {
  private readonly callers = new Map<string, CallExpression[]>();

  constructor(
    private readonly loaded: LoadedProject,
    private readonly functions: Map<string, FunctionLike>,
  ) {
    for (const file of loaded.sourceFiles) {
      for (const call of file.getDescendantsOfKind(SyntaxKind.CallExpression)) {
        const callee = call.getExpression();
        if (!Node.isIdentifier(callee)) continue;
        const list = this.callers.get(callee.getText()) ?? [];
        list.push(call);
        this.callers.set(callee.getText(), list);
      }
    }
  }

  of(node: Node | undefined, depth: number): DatabaseName | undefined {
    if (!node || depth > MAX_DEPTH) return undefined;
    const expr = unwrap(node);

    const made = [expr, ...expr.getDescendantsOfKind(SyntaxKind.CallExpression)].find(
      (candidate): candidate is CallExpression =>
        Node.isCallExpression(candidate) && calleeMember(candidate) === 'db',
    );
    if (made) return this.nameOf(made.getArguments()[0], depth + 1);

    if (Node.isIdentifier(expr)) {
      const declaration = declarationOf(expr);
      if (declaration && Node.isVariableDeclaration(declaration))
        return this.of(declaration.getInitializer(), depth + 1);
      if (declaration && Node.isParameterDeclaration(declaration))
        return this.ofParameter(declaration, depth + 1);
      return undefined;
    }

    if (Node.isCallExpression(expr) && Node.isIdentifier(expr.getExpression())) {
      const fn = this.functions.get(expr.getExpression().getText());
      if (!fn) return undefined;
      const body = Node.isArrowFunction(fn) ? fn.getBody() : fn;
      const returned =
        Node.isBlock(body) || Node.isFunctionDeclaration(body) || Node.isFunctionExpression(body)
          ? body
              .getDescendantsOfKind(SyntaxKind.ReturnStatement)
              .filter((statement) => enclosingFunction(statement) === fn)
              .map((statement) => statement.getExpression())
          : [body];
      return agreed(returned.map((value) => this.of(value, depth + 1)));
    }
    return undefined;
  }

  private ofParameter(parameter: Node, depth: number): DatabaseName | undefined {
    if (!Node.isParameterDeclaration(parameter)) return undefined;
    const fn = enclosingFunction(parameter);
    const name = fn && functionName(fn);
    if (!fn || !name || this.functions.get(name) !== fn) return undefined;
    const index = fn.getParameters().indexOf(parameter as never);
    const calls = this.callers.get(name) ?? [];
    return agreed(calls.map((call) => this.of(call.getArguments()[index], depth)));
  }

  /** An env variable naming a database, with the name it holds in the project's env files. */
  private envName(name: string): DatabaseName {
    const found = envValue(this.loaded.roots, name);
    return { name, env: true, ...found };
  }

  /** `"pharma"`, `process.env.CLINICS_DB`, `requireEnv("CLINICS_DB")`, `process.env.X || "dev"`. */
  private nameOf(node: Node | undefined, depth: number): DatabaseName | undefined {
    if (!node || depth > MAX_DEPTH) return undefined;
    const expr = unwrap(node);
    if (Node.isStringLiteral(expr) || Node.isNoSubstitutionTemplateLiteral(expr))
      return { name: expr.getLiteralValue() };
    const env = /\bprocess\.env(?:\.([A-Za-z_]\w*)|\[\s*['"`]([A-Za-z_]\w*)['"`]\s*\])/.exec(
      expr.getText(),
    );
    if (env) return this.envName((env[1] ?? env[2])!);
    if (Node.isBinaryExpression(expr)) return this.nameOf(expr.getLeft(), depth + 1);
    if (Node.isCallExpression(expr)) {
      const args = expr.getArguments();
      const only = args.length === 1 ? args[0] : undefined;
      // `requireEnv("CLINICS_DB")`: a helper that reads the variable it is given.
      if (only && Node.isStringLiteral(only) && /env/i.test(expr.getExpression().getText()))
        return this.envName(only.getLiteralValue());
      // `name.trim()`
      const callee = expr.getExpression();
      return Node.isPropertyAccessExpression(callee)
        ? this.nameOf(callee.getExpression(), depth + 1)
        : undefined;
    }
    if (Node.isIdentifier(expr)) {
      const declaration = declarationOf(expr);
      if (declaration && Node.isVariableDeclaration(declaration))
        return this.nameOf(declaration.getInitializer(), depth + 1);
    }
    return undefined;
  }
}

/**
 * Where a project keeps its development settings, in the order Next.js and
 * dotenv read them; the example file last, as the fallback a fresh clone has.
 */
const ENV_FILES = [
  '.env.local',
  '.env.development.local',
  '.env.development',
  '.env',
  '.env.example',
];

/**
 * The value one variable has in the project's env files. Only that variable is
 * read and kept: the same files hold credentials, which must never reach the graph.
 */
export function envValue(
  roots: string[],
  name: string,
): { value: string; from: string } | undefined {
  if (!/^[A-Za-z_]\w*$/.test(name)) return undefined;
  const line = new RegExp(`^\\s*(?:export\\s+)?${name}\\s*=\\s*(.*)$`, 'm');
  for (const root of roots)
    for (const file of ENV_FILES) {
      const path = join(root, file);
      if (!existsSync(path)) continue;
      const raw = line.exec(readFileSync(path, 'utf8'))?.[1]?.trim();
      if (!raw) continue;
      // `"pharma-dev" # comment` → `pharma-dev`; unquoted, the comment still ends it.
      const quoted = /^(['"])(.*?)\1/.exec(raw);
      const value = quoted ? quoted[2]! : raw.replace(/\s+#.*$/, '');
      if (value) return { value, from: file };
    }
  return undefined;
}

function unwrap(node: Node): Node {
  let current = node;
  for (;;) {
    if (
      Node.isAwaitExpression(current) ||
      Node.isParenthesizedExpression(current) ||
      Node.isAsExpression(current) ||
      Node.isNonNullExpression(current) ||
      Node.isSatisfiesExpression(current)
    )
      current = current.getExpression();
    else return current;
  }
}

/** The one answer every path gives, or none. */
function agreed(names: Array<DatabaseName | undefined>): DatabaseName | undefined {
  if (names.length === 0 || names.some((name) => !name)) return undefined;
  const distinct = uniqueBy(names as DatabaseName[], (name) => name.name);
  return distinct.length === 1 ? distinct[0] : undefined;
}

/**
 * The database each query runs in, on the query itself.
 *
 * By the handle it is called on: the `.collection()` on its own line, the
 * variable or factory property the handle was stored in, and failing that the
 * collection's only database.
 */
function labelOperations(loaded: LoadedProject, graph: FlowGraph, sites: Site[]): void {
  const files = new Map(loaded.sourceFiles.map((file) => [loaded.rel(file), file]));
  for (const op of graph.nodesOfKind('db-op')) {
    const collection = op.meta?.['collection'];
    if (typeof collection !== 'string' || !op.source || op.meta?.['database'] === 'prisma')
      continue;
    const own = sites.filter((site) => site.collection === collection && site.database);
    if (own.length === 0) continue;
    const onLine = own.find(
      (site) => site.file === op.source!.file && site.line === op.source!.line,
    );
    let database = onLine?.database;
    if (!database) {
      const call = files
        .get(op.source.file)
        ?.getDescendantsOfKind(SyntaxKind.CallExpression)
        .find(
          (candidate) =>
            lineOf(candidate) === op.source!.line &&
            calleeMember(candidate) === op.meta?.['operation'],
        );
      const head = call && calleeReceiver(call)?.split('.')[0];
      const bound = head
        ? own.filter(
            (site) => site.binding === head && (site.shared || site.file === op.source!.file),
          )
        : [];
      database = agreed(bound.map((site) => site.database));
    }
    database ??= agreed(own.map((site) => site.database));
    if (database) graph.addNode({ ...op, meta: { ...op.meta, databaseName: database } });
  }
}

// ---------------------------------------------------------------------------
// Indexes
// ---------------------------------------------------------------------------

/** `createIndex(keys, options)` and `createIndexes([{ key, ...options }])`. */
function declareIndexes(loaded: LoadedProject, graph: FlowGraph, aliases: CollectionAliases): void {
  const found = new Map<string, CollectionIndex[]>();
  for (const file of loaded.sourceFiles) {
    const rel = loaded.rel(file);
    for (const call of file.getDescendantsOfKind(SyntaxKind.CallExpression)) {
      const member = calleeMember(call);
      if (member !== 'createIndex' && member !== 'createIndexes' && member !== 'index') continue;
      const receiver = calleeReceiver(call);
      // `OrderSchema.index({ doctor_id: 1 })`: a Mongoose schema's own index, on its model's collection.
      const collection =
        member === 'index'
          ? schemaCollection(receiver, file, graph)
          : receiver && collectionFor(receiver, file, aliases);
      if (!collection || !graph.node(ids.collection(collection))) continue;
      const [first, second] = call.getArguments();
      const specs: Array<[Node | undefined, Node | undefined]> =
        member === 'createIndex' || member === 'index'
          ? [[first, second]]
          : first && Node.isArrayLiteralExpression(first)
            ? first.getElements().map((element) => {
                const object = Node.isObjectLiteralExpression(element) ? element : undefined;
                const key = object?.getProperty('key');
                return [
                  key && Node.isPropertyAssignment(key) ? key.getInitializer() : undefined,
                  object,
                ];
              })
            : [];
      for (const [keysNode, optionsNode] of specs) {
        const index = indexOf(keysNode, optionsNode, { file: rel, line: lineOf(call) });
        if (!index) continue;
        const list = found.get(collection) ?? [];
        const signature = JSON.stringify({ ...index, source: undefined });
        if (!list.some((other) => JSON.stringify({ ...other, source: undefined }) === signature))
          list.push(index);
        found.set(collection, list);
      }
    }
  }
  for (const [collection, indexes] of found) {
    const node = graph.node(ids.collection(collection))!;
    graph.addNode({ ...node, meta: { ...node.meta, indexes } });
  }
}

/**
 * The collection a Mongoose schema variable belongs to: `SchemaFactory.createForClass(Order)`
 * (named the way the Nest pass names the model), or a `new Schema(…)` handed to `model('Order', …)`.
 */
function schemaCollection(
  receiver: string | undefined,
  file: SourceFile,
  graph: FlowGraph,
): string | undefined {
  if (!receiver || !/^[A-Za-z_$][\w$]*$/.test(receiver)) return undefined;
  const init = file.getVariableDeclaration(receiver)?.getInitializer()?.getText() ?? '';
  let model = /createForClass\(\s*([A-Za-z_$][\w$]*)\s*\)/
    .exec(init)?.[1]
    ?.replace(/(Schema|Document|Entity)$/, '');
  if (!model && /\bnew\s+(?:mongoose\.)?Schema\b/.test(init)) {
    const registered = file
      .getDescendantsOfKind(SyntaxKind.CallExpression)
      .find((c) => calleeMember(c) === 'model' && c.getArguments()[1]?.getText() === receiver);
    const name = registered?.getArguments()[0];
    model = name && Node.isStringLiteral(name) ? name.getLiteralValue() : undefined;
  }
  const collection = model ? graph.node(ids.model(model))?.meta?.['collection'] : undefined;
  return typeof collection === 'string' ? collection : undefined;
}

function indexOf(
  keysNode: Node | undefined,
  optionsNode: Node | undefined,
  source: { file: string; line: number },
): CollectionIndex | undefined {
  if (!keysNode || !Node.isObjectLiteralExpression(keysNode)) return undefined;
  const keys: Array<[string, string]> = [];
  for (const property of keysNode.getProperties()) {
    if (!Node.isPropertyAssignment(property)) return undefined;
    keys.push([
      property.getName().replace(/^['"`]|['"`]$/g, ''),
      property
        .getInitializerOrThrow()
        .getText()
        .replace(/^['"`]|['"`]$/g, ''),
    ]);
  }
  if (keys.length === 0) return undefined;
  const index: CollectionIndex = { keys, source };
  const options: string[] = [];
  if (optionsNode && Node.isObjectLiteralExpression(optionsNode)) {
    for (const property of optionsNode.getProperties()) {
      if (!Node.isPropertyAssignment(property) && !Node.isShorthandPropertyAssignment(property))
        continue;
      const name = property.getName();
      const value = Node.isPropertyAssignment(property)
        ? property.getInitializerOrThrow().getText()
        : name;
      if (name === 'key') continue;
      if (name === 'unique') {
        if (value === 'true') index.unique = true;
      } else if (name === 'sparse') {
        if (value === 'true') index.sparse = true;
      } else if (name === 'expireAfterSeconds' && /^\d+$/.test(value))
        index.ttlSeconds = Number(value);
      else if (name === 'name' && /^['"`]/.test(value)) index.name = value.slice(1, -1);
      else options.push(name);
    }
  }
  if (options.length > 0) index.options = options;
  return index;
}

function uniqueBy<T>(items: T[], key: (item: T) => string): T[] {
  return [...new Map(items.map((item) => [key(item), item])).values()];
}
