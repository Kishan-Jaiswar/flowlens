import {
  Node,
  SyntaxKind,
  type ClassDeclaration,
  type MethodDeclaration,
  type ParameterDeclaration,
  type PropertyDeclaration,
  type SourceFile,
} from 'ts-morph';
import type { FlowGraph } from '../graph/graph.js';
import { ids } from '../graph/ids.js';
import {
  asObjectLiteral,
  callsIn,
  calleeMember,
  calleeReceiver,
  decoratorStringArg,
  functionName,
  getDecorator,
  lineOf,
  objectKeys,
  propertyValue,
  readPathLike,
  readString,
} from './ast.js';
import { classifyFile, isServerCandidate } from './classify.js';
import { linkDbOperations, type CollectionAliases } from './dbaccess.js';
import { HTTP_METHODS, joinRoutePath, normalizePath, type HttpMethod } from './http.js';
import { collectionNameOf, dbEffectOf, type DbEffect } from './mongo.js';
import type { LoadedProject } from './project.js';

/** Nest route decorators, mapped to their HTTP verb. */
const ROUTE_DECORATORS: Record<string, HttpMethod | 'ALL'> = {
  Get: 'GET',
  Post: 'POST',
  Put: 'PUT',
  Patch: 'PATCH',
  Delete: 'DELETE',
  Head: 'HEAD',
  Options: 'OPTIONS',
  All: 'ALL',
};

/**
 * Names that may hold an Express/Fastify router — but only in a file that
 * actually imports one.
 *
 * Without that guard, a frontend HTTP client (`api.post('/customers', body)`)
 * looks exactly like a route declaration and the analyzer invents phantom
 * backend routes for every call the frontend makes.
 */
const ROUTER_NAMES = new Set(['router', 'app', 'server']);
const ROUTER_FACTORIES = /^(express|express\.Router|Router|fastify|Fastify)$/;
const SERVER_MODULES = /^(express|fastify|@?hapi|koa|restify)/;

const LIFECYCLE_METHODS = new Set([
  'constructor',
  'onModuleInit',
  'onModuleDestroy',
  'onApplicationBootstrap',
  'beforeApplicationShutdown',
  'onApplicationShutdown',
]);

type ClassRole = 'controller' | 'service' | 'model' | 'dto' | 'other';

interface ClassInfo {
  name: string;
  file: string;
  nodeId: string;
  role: ClassRole;
  routePrefix: string;
  declaration: ClassDeclaration;
  /** `this.customersService` -> `CustomersService` */
  injected: Map<string, string>;
  /** `this.customerModel` -> `Customer` */
  models: Map<string, string>;
  methods: Map<string, MethodDeclaration>;
}

export interface BackendIndex {
  /** Class name -> info. Class names are unique enough in practice. */
  classes: Map<string, ClassInfo>;
  /** Model name -> collection name. */
  collections: Map<string, string>;
}

export interface BackendConfig {
  /**
   * Prefixes stripped from route paths — must match the frontend list.
   *
   * A Nest app with `setGlobalPrefix('api')` or `@Controller('api/admin')`
   * serves `/api/admin/customers`; its frontend calls the same URL. Stripping
   * on only one side is why a 506-route backend matched zero frontend calls.
   */
  apiPrefixes: string[];
  /** Resolve identifiers (route path constants) to their literal value. */
  resolveConstant?: (name: string) => string | undefined;
  /** Collection handles produced by a factory; see `collectionAliasesOf`. */
  collectionAliases?: CollectionAliases;
}

export const DEFAULT_BACKEND_CONFIG: BackendConfig = {
  apiPrefixes: ['/api'],
};

/**
 * Walk the backend: routes, controllers, the services they call, and the
 * collections those services touch.
 *
 * Runs in two passes because a controller usually calls a service declared in
 * another file, and we want that edge to point at a node that already exists.
 */
export function analyzeBackend(
  loaded: LoadedProject,
  graph: FlowGraph,
  config: BackendConfig = DEFAULT_BACKEND_CONFIG,
): BackendIndex {
  const index: BackendIndex = { classes: new Map(), collections: new Map() };

  const safely = (label: string, run: () => void) => {
    try {
      run();
    } catch (error) {
      // A single odd file should degrade the graph, not abort the scan.
      loaded.warnings.push(
        `backend analysis failed for ${label}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  };

  const serverFiles: Array<{ file: SourceFile; rel: string }> = [];
  for (const file of loaded.sourceFiles) {
    const rel = loaded.rel(file);
    if (!isServerCandidate(classifyFile(file, rel))) continue;
    serverFiles.push({ file, rel });
  }

  for (const { file, rel } of serverFiles) {
    safely(rel, () => {
      declareClasses(file, rel, graph, index);
      declareMongooseModels(file, rel, graph, index);
    });
  }

  for (const info of index.classes.values()) {
    safely(info.file, () => resolveInjection(info, graph, index));
  }

  for (const info of index.classes.values()) {
    safely(info.file, () => {
      resolveRoutes(info, graph, config);
      resolveMethodBodies(info, graph, index);
    });
  }

  for (const { file, rel } of serverFiles) {
    safely(rel, () => declareExpressRoutes(file, rel, graph, config));
  }

  return index;
}

// ---------------------------------------------------------------------------
// Pass 1 — declarations
// ---------------------------------------------------------------------------

function declareClasses(
  file: SourceFile,
  rel: string,
  graph: FlowGraph,
  index: BackendIndex,
): void {
  for (const declaration of file.getClasses()) {
    const name = declaration.getName();
    if (!name) continue;

    const role = classRole(declaration, name);
    if (role === 'other') continue;

    const nodeId = nodeIdFor(role, rel, name);
    const info: ClassInfo = {
      name,
      file: rel,
      nodeId,
      role,
      routePrefix: decoratorStringArg(getDecorator(declaration, 'Controller')) ?? '',
      declaration,
      injected: new Map(),
      models: new Map(),
      methods: new Map(),
    };

    if (role === 'controller' || role === 'service') {
      graph.addNode({
        id: nodeId,
        kind: role,
        label: name,
        source: { file: rel, line: lineOf(declaration) },
      });
      for (const method of declaration.getMethods()) {
        const methodName = method.getName();
        if (LIFECYCLE_METHODS.has(methodName)) continue;
        info.methods.set(methodName, method);
        const methodId = ids.method(nodeId, methodName);
        graph.addNode({
          id: methodId,
          kind: 'method',
          label: `${name}.${methodName}`,
          source: { file: rel, line: lineOf(method) },
          meta: { class: name, method: methodName, layer: role },
        });
        graph.addEdge({ from: nodeId, to: methodId, kind: 'defines' });
      }
    }

    if (role === 'model') {
      declareSchemaClass(declaration, name, rel, graph, index);
    }

    if (role === 'dto') {
      declareDto(declaration, name, rel, graph);
    }

    index.classes.set(name, info);
  }
}

function classRole(declaration: ClassDeclaration, name: string): ClassRole {
  const decorators = declaration.getDecorators().map((d) => d.getName());
  if (decorators.includes('Controller')) return 'controller';
  if (decorators.includes('Schema')) return 'model';
  if (decorators.includes('Injectable')) {
    // A Nest pipe/guard/interceptor is @Injectable too, but naming tells them apart.
    return 'service';
  }
  if (/(Controller)$/.test(name)) return 'controller';
  if (/(Service|Repository|Provider|Gateway)$/.test(name)) return 'service';
  if (/(Dto|Input|Payload)$/.test(name)) return 'dto';
  if (/(Schema|Entity|Model|Document)$/.test(name)) return 'model';
  return 'other';
}

function nodeIdFor(role: ClassRole, rel: string, name: string): string {
  switch (role) {
    case 'controller':
      return ids.controller(rel, name);
    case 'service':
      return ids.service(rel, name);
    case 'model':
      return ids.model(name);
    case 'dto':
      return ids.dto(name);
    default:
      return ids.service(rel, name);
  }
}

/** `@Schema() class Customer { @Prop() name: string }` */
function declareSchemaClass(
  declaration: ClassDeclaration,
  name: string,
  rel: string,
  graph: FlowGraph,
  index: BackendIndex,
): void {
  const modelName = name.replace(/(Schema|Document|Entity)$/, '') || name;
  const collection =
    readString(
      (() => {
        const schemaDecorator = getDecorator(declaration, 'Schema');
        const options = asObjectLiteral(schemaDecorator?.getArguments()[0]);
        return options ? propertyValue(options, 'collection') : undefined;
      })(),
    ) ?? collectionNameOf(modelName);

  registerModel(graph, index, modelName, collection, { file: rel, line: lineOf(declaration) });

  const modelId = ids.model(modelName);
  for (const property of declaration.getProperties()) {
    const hasProp = property.getDecorators().some((d) => d.getName() === 'Prop');
    if (!hasProp) continue;
    const fieldName = property.getName();
    const fieldId = ids.field(modelId, fieldName);
    graph.addNode({
      id: fieldId,
      kind: 'field',
      label: fieldName,
      source: { file: rel, line: lineOf(property) },
      meta: { owner: modelName, type: property.getTypeNode()?.getText() },
    });
    graph.addEdge({ from: modelId, to: fieldId, kind: 'defines' });
  }
}

function declareDto(
  declaration: ClassDeclaration,
  name: string,
  rel: string,
  graph: FlowGraph,
): void {
  const dtoId = ids.dto(name);
  graph.addNode({
    id: dtoId,
    kind: 'dto',
    label: name,
    source: { file: rel, line: lineOf(declaration) },
  });
  for (const property of declaration.getProperties()) {
    const fieldName = property.getName();
    const fieldId = ids.field(dtoId, fieldName);
    graph.addNode({
      id: fieldId,
      kind: 'field',
      label: fieldName,
      source: { file: rel, line: lineOf(property) },
      meta: {
        owner: name,
        type: property.getTypeNode()?.getText(),
        optional: property.hasQuestionToken(),
        validators: property.getDecorators().map((d) => d.getName()),
      },
    });
    graph.addEdge({ from: dtoId, to: fieldId, kind: 'defines' });
  }
}

/** Plain Mongoose: `new Schema({...})` + `model('Customer', schema)`. */
function declareMongooseModels(
  file: SourceFile,
  rel: string,
  graph: FlowGraph,
  index: BackendIndex,
): void {
  for (const call of callsIn(file)) {
    const member = calleeMember(call);
    if (member !== 'model') continue;
    const args = call.getArguments();
    const modelName = readString(args[0]);
    if (!modelName) continue;
    const explicitCollection = readString(args[2]);
    registerModel(graph, index, modelName, explicitCollection ?? collectionNameOf(modelName), {
      file: rel,
      line: lineOf(call),
    });

    // Fields, when the schema literal is inline or resolvable in this file.
    const modelId = ids.model(modelName);
    const schemaLiteral = findSchemaLiteral(file, args[1]);
    if (!schemaLiteral) continue;
    for (const fieldName of objectKeys(schemaLiteral)) {
      if (fieldName.startsWith('...')) continue;
      const fieldId = ids.field(modelId, fieldName);
      graph.addNode({
        id: fieldId,
        kind: 'field',
        label: fieldName,
        source: { file: rel, line: lineOf(schemaLiteral) },
        meta: { owner: modelName },
      });
      graph.addEdge({ from: modelId, to: fieldId, kind: 'defines' });
    }
  }
}

/** Resolve `new Schema({...})`, directly or through a local variable. */
function findSchemaLiteral(file: SourceFile, argument: Node | undefined) {
  if (!argument) return undefined;
  if (Node.isNewExpression(argument)) {
    return asObjectLiteral(argument.getArguments()[0]);
  }
  if (Node.isIdentifier(argument)) {
    const declaration = file.getVariableDeclaration(argument.getText());
    const initializer = declaration?.getInitializer();
    if (initializer && Node.isNewExpression(initializer)) {
      return asObjectLiteral(initializer.getArguments()[0]);
    }
  }
  return undefined;
}

function registerModel(
  graph: FlowGraph,
  index: BackendIndex,
  modelName: string,
  collection: string,
  source: { file: string; line: number },
): void {
  index.collections.set(modelName, collection);
  const modelId = ids.model(modelName);
  graph.addNode({ id: modelId, kind: 'model', label: modelName, source, meta: { collection } });
  const collectionId = ids.collection(collection);
  graph.addNode({
    id: collectionId,
    kind: 'collection',
    label: collection,
    meta: { database: 'mongodb', model: modelName },
  });
  graph.addEdge({ from: modelId, to: collectionId, kind: 'defines' });
}

// ---------------------------------------------------------------------------
// Pass 2 — resolution
// ---------------------------------------------------------------------------

/**
 * Read dependency injection: services and Mongoose models.
 *
 * Nest supports two forms, and a real codebase mixes them in the same class:
 *
 *   constructor(@InjectModel(Vendor.name) private vendorModel: Model<D>) {}
 *
 *   @InjectModel(VendorProduct.name)
 *   private readonly vendorProductModel: Model<VendorProductDocument>;
 *
 * Reading only the constructor silently drops every query made through a
 * property-injected model, so the flow stops at the service and the collection
 * never appears — a missing layer, not a missing detail.
 */
function resolveInjection(info: ClassInfo, graph: FlowGraph, index: BackendIndex): void {
  const [constructor] = info.declaration.getConstructors();
  const members: Array<ParameterDeclaration | PropertyDeclaration> = [
    ...(constructor?.getParameters() ?? []),
    ...info.declaration.getProperties(),
  ];

  for (const member of members) {
    const receiver = `this.${member.getName()}`;

    const modelName = injectedModelName(member);
    if (modelName) {
      info.models.set(receiver, modelName);
      if (!index.collections.has(modelName)) {
        registerModel(graph, index, modelName, collectionNameOf(modelName), {
          file: info.file,
          line: lineOf(member),
        });
      }
      graph.addEdge({ from: info.nodeId, to: ids.model(modelName), kind: 'injects' });
      continue;
    }

    const typeName = baseTypeName(member);
    if (!typeName) continue;
    const target = index.classes.get(typeName);
    if (!target || (target.role !== 'service' && target.role !== 'controller')) continue;
    info.injected.set(receiver, typeName);
    graph.addEdge({ from: info.nodeId, to: target.nodeId, kind: 'injects' });
  }
}

/** `@InjectModel(Customer.name)` or `@InjectModel('Customer')`. */
function injectedModelName(member: ParameterDeclaration | PropertyDeclaration): string | undefined {
  const decorator = member.getDecorators().find((d) => d.getName() === 'InjectModel');
  if (decorator) {
    const [argument] = decorator.getArguments();
    if (argument) {
      const literal = readString(argument);
      if (literal) return literal;
      if (Node.isPropertyAccessExpression(argument)) {
        return argument.getExpression().getText();
      }
      return argument.getText().replace(/\.name$/, '');
    }
  }
  // Plain Mongoose in a service: `private customerModel: Model<Customer>`
  const typeText = member.getTypeNode()?.getText() ?? '';
  const generic = /^Model<\s*([A-Za-z0-9_]+)/.exec(typeText);
  if (generic?.[1]) return generic[1].replace(/(Document|Entity)$/, '');
  return undefined;
}

function baseTypeName(member: ParameterDeclaration | PropertyDeclaration): string | undefined {
  const typeText = member.getTypeNode()?.getText();
  if (!typeText) return undefined;
  const match = /^([A-Za-z0-9_$]+)/.exec(typeText.trim());
  return match?.[1];
}

/** Turn `@Controller('customers')` + `@Post(':id/notes')` into route nodes. */
function resolveRoutes(info: ClassInfo, graph: FlowGraph, config: BackendConfig): void {
  if (info.role !== 'controller') return;

  for (const [methodName, method] of info.methods) {
    for (const decorator of method.getDecorators()) {
      const verb = ROUTE_DECORATORS[decorator.getName()];
      if (!verb) continue;
      const suffix = decoratorStringArg(decorator, config.resolveConstant) ?? '';
      const path = joinRoutePath(info.routePrefix, suffix, config.apiPrefixes);
      const methods: HttpMethod[] = verb === 'ALL' ? [...HTTP_METHODS] : [verb];

      const methodId = ids.method(info.nodeId, methodName);
      for (const httpMethod of methods) {
        const routeId = ids.route(httpMethod, path);
        graph.addNode({
          id: routeId,
          kind: 'route',
          label: `${httpMethod} ${path}`,
          source: { file: info.file, line: lineOf(method) },
          meta: {
            httpMethod,
            path,
            controller: info.name,
            handler: methodName,
            framework: 'nestjs',
          },
        });
        graph.addEdge({ from: routeId, to: methodId, kind: 'calls' });
      }

      linkRouteDto(method, graph, ids.route(methods[0]!, path));
    }
  }
}

/** `@Body() dto: CreateCustomerDto` -> route validates dto. */
function linkRouteDto(method: MethodDeclaration, graph: FlowGraph, routeId: string): void {
  for (const parameter of method.getParameters()) {
    const isBody = parameter
      .getDecorators()
      .some((d) => ['Body', 'Query', 'Param'].includes(d.getName()));
    if (!isBody) continue;
    const typeName = baseTypeName(parameter);
    if (!typeName || !/(Dto|Input|Payload)$/.test(typeName)) continue;
    const dtoId = ids.dto(typeName);
    if (!graph.hasNode(dtoId)) {
      graph.addNode({ id: dtoId, kind: 'dto', label: typeName });
    }
    graph.addEdge({ from: routeId, to: dtoId, kind: 'validates' });
  }
}

/** Service-to-service calls and database operations inside every method body. */
function resolveMethodBodies(info: ClassInfo, graph: FlowGraph, index: BackendIndex): void {
  for (const [methodName, method] of info.methods) {
    const methodId = ids.method(info.nodeId, methodName);

    for (const call of callsIn(method)) {
      const receiver = calleeReceiver(call);
      const member = calleeMember(call);
      if (!receiver) continue;

      // 1. Database access: this.customerModel.find(...)
      const modelName = resolveModelReceiver(receiver, info);
      if (modelName) {
        const effect = dbEffectOf(member);
        if (!effect) continue;
        recordDbOp(graph, index, {
          methodId,
          modelName,
          operation: member,
          file: info.file,
          line: lineOf(call),
          site: `${info.name}.${methodName}`,
          effect,
        });
        continue;
      }

      // 2. Injected service: this.customersService.create(...)
      const targetClass = info.injected.get(receiver);
      if (targetClass) {
        const target = index.classes.get(targetClass);
        if (!target) continue;
        const targetMethodId = ids.method(target.nodeId, member);
        if (!graph.hasNode(targetMethodId)) {
          graph.addNode({
            id: targetMethodId,
            kind: 'method',
            label: `${target.name}.${member}`,
            source: { file: target.file, line: lineOf(target.declaration) },
            meta: { class: target.name, method: member, inferred: true },
          });
          graph.addEdge({ from: target.nodeId, to: targetMethodId, kind: 'defines' });
        }
        graph.addEdge({
          from: methodId,
          to: targetMethodId,
          kind: 'calls',
          meta: { line: lineOf(call) },
        });
        continue;
      }

      // 3. Same-class call: this.buildQuery(...)
      if (receiver === 'this' && info.methods.has(member) && member !== methodName) {
        graph.addEdge({
          from: methodId,
          to: ids.method(info.nodeId, member),
          kind: 'calls',
          meta: { line: lineOf(call) },
        });
      }
    }

    // `new this.customerModel(dto).save()` — the document-style write.
    for (const expression of method.getDescendantsOfKind(SyntaxKind.NewExpression)) {
      const target = expression.getExpression().getText().replace(/\s+/g, '');
      const modelName = resolveModelReceiver(target, info);
      if (!modelName) continue;
      recordDbOp(graph, index, {
        methodId,
        modelName,
        operation: 'save',
        file: info.file,
        line: lineOf(expression),
        site: `${info.name}.${methodName}`,
        // `save()` alone is ambiguous, but `new Model(...)` is not: the document
        // is new here, so this is an insert rather than an unknown write.
        effect: 'create',
      });
    }
  }
}

/**
 * Mongoose lets you chain (`this.model.find().sort().lean()`), so the receiver
 * of a call may be an expression rather than the model itself. Match on the
 * declared receiver prefix.
 */
function resolveModelReceiver(receiver: string, info: ClassInfo): string | undefined {
  const direct = info.models.get(receiver);
  if (direct) return direct;
  for (const [declared, modelName] of info.models) {
    if (receiver.startsWith(`${declared}.`) || receiver.startsWith(`${declared}(`))
      return modelName;
  }
  return undefined;
}

function recordDbOp(
  graph: FlowGraph,
  index: BackendIndex,
  input: {
    methodId: string;
    modelName: string;
    operation: string;
    file: string;
    line: number;
    site: string;
    effect: DbEffect;
  },
): void {
  const collection = index.collections.get(input.modelName) ?? collectionNameOf(input.modelName);
  const opId = ids.dbOp(collection, input.operation, input.site);
  graph.addNode({
    id: opId,
    kind: 'db-op',
    label: `${collection}.${input.operation}`,
    source: { file: input.file, line: input.line },
    meta: {
      collection,
      operation: input.operation,
      access: input.effect === 'read' ? 'read' : 'write',
      effect: input.effect,
      model: input.modelName,
    },
  });
  graph.addEdge({ from: input.methodId, to: opId, kind: 'queries' });
  graph.addEdge({
    from: opId,
    to: ids.collection(collection),
    kind: input.effect === 'read' ? 'reads' : 'writes',
  });
}

/** `router.post('/customers', createCustomer)` — Express/Fastify style. */
function declareExpressRoutes(
  file: SourceFile,
  rel: string,
  graph: FlowGraph,
  config: BackendConfig,
): void {
  const routers = findRouterNames(file);
  if (routers.size === 0) return;

  for (const call of callsIn(file)) {
    const receiver = calleeReceiver(call);
    const member = calleeMember(call).toUpperCase();
    if (!receiver || !(HTTP_METHODS as readonly string[]).includes(member)) continue;
    const receiverTail = receiver.split('.').pop() ?? receiver;
    if (!routers.has(receiverTail)) continue;

    const args = call.getArguments();
    const rawPath = readPathLike(args[0], config.resolveConstant);
    if (!rawPath) continue;
    const path = normalizePath(rawPath, config.apiPrefixes);
    const routeId = ids.route(member, path);
    graph.addNode({
      id: routeId,
      kind: 'route',
      label: `${member} ${path}`,
      source: { file: rel, line: lineOf(call) },
      meta: { httpMethod: member, path, framework: 'express' },
    });

    // The last function-ish argument is the handler; earlier ones are middleware.
    const handler = [...args]
      .reverse()
      .find(
        (argument) =>
          Node.isArrowFunction(argument) ||
          Node.isFunctionExpression(argument) ||
          Node.isIdentifier(argument),
      );
    if (!handler) continue;

    const name = Node.isIdentifier(handler)
      ? handler.getText()
      : (functionName(handler as never) ?? `handler@${lineOf(handler)}`);
    const handlerId = ids.method(`controller:${rel}#express`, name);
    graph.addNode({
      id: handlerId,
      kind: 'method',
      label: name,
      source: { file: rel, line: lineOf(handler) },
      meta: { framework: 'express' },
    });
    graph.addEdge({ from: routeId, to: handlerId, kind: 'calls' });

    /**
     * The handler's own database work.
     *
     * An inline `async (req, res) => { await Note.create(...) }` holds the
     * queries that a Nest service would keep in a class, so without this an
     * Express backend yields routes with nothing behind them.
     */
    const body = Node.isIdentifier(handler)
      ? (file.getVariableDeclaration(handler.getText())?.getInitializer() ??
        file.getFunction(handler.getText()))
      : handler;
    if (body) linkDbOperations(body, file, rel, graph, handlerId, config.collectionAliases);
  }
}

/**
 * Which identifiers in this file really are routers.
 *
 * Two signals, both required to be safe: the file imports a server framework,
 * and the identifier is either assigned from a router factory or conventionally
 * named (`app`, `router`) — including as a function parameter, which is how
 * route modules usually receive it.
 */
function findRouterNames(file: SourceFile): Set<string> {
  const importsServer = file
    .getImportDeclarations()
    .some((declaration) => SERVER_MODULES.test(declaration.getModuleSpecifierValue()));
  const requiresServer = callsIn(file).some(
    (call) =>
      calleeMember(call) === 'require' &&
      SERVER_MODULES.test(readString(call.getArguments()[0]) ?? ''),
  );

  const names = new Set<string>();

  // `const router = Router()` / `const app = express()`
  for (const declaration of file.getVariableDeclarations()) {
    const initializer = declaration.getInitializer();
    if (!initializer) continue;
    const calleeText = Node.isCallExpression(initializer)
      ? initializer.getExpression().getText().replace(/\s+/g, '')
      : Node.isNewExpression(initializer)
        ? initializer.getExpression().getText().replace(/\s+/g, '')
        : '';
    if (ROUTER_FACTORIES.test(calleeText)) names.add(declaration.getName());
  }

  if (!importsServer && !requiresServer && names.size === 0) return names;

  // `export function routes(app) { app.get(...) }`
  if (importsServer || requiresServer || names.size > 0) {
    for (const parameter of file.getDescendantsOfKind(SyntaxKind.Parameter)) {
      const name = parameter.getName();
      if (ROUTER_NAMES.has(name)) names.add(name);
    }
    for (const declaration of file.getVariableDeclarations()) {
      if (ROUTER_NAMES.has(declaration.getName())) names.add(declaration.getName());
    }
  }

  return names;
}
