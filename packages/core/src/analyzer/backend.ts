import { dirname, join } from 'node:path';
import {
  Node,
  SyntaxKind,
  type ClassDeclaration,
  type MethodDeclaration,
  type ObjectLiteralExpression,
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
  loadedFrom,
  objectKeys,
  propertyValue,
  readPathLike,
  readString,
} from './ast.js';
import { classifyFile, isServerCandidate } from './classify.js';
import { linkDbOperations, type CollectionAliases } from './dbaccess.js';
import { linkExternalEffects } from './effects.js';
import { HTTP_METHODS, joinRoutePath, normalizePath, type HttpMethod } from './http.js';
import { linkExpressMiddleware, linkNestMiddleware } from './middleware.js';
import { collectionNameOf, dbEffectOf, upsertsIn, type DbEffect } from './mongo.js';
import { prismaEffectOf, prismaTableOf, type PrismaSchema } from './prisma.js';
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
  /**
   * Model names the project registers (`forFeature`, `@InjectModel`, `model('X')`).
   * Empty when it registers none: then every `@Schema()` class counts.
   */
  registered?: Set<string>;
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
  resolveConstant?: (name: string, at?: Node) => string | undefined;
  /** Collection handles produced by a factory; see `collectionAliasesOf`. */
  collectionAliases?: CollectionAliases;
  /** Prisma models read from `schema.prisma`, when the project has one. */
  prisma?: PrismaSchema;
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

  index.registered = registeredModels(serverFiles.map(({ file }) => file));
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
      resolveMethodBodies(info, graph, index, config);
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
          meta: {
            class: name,
            method: methodName,
            layer: role,
            ...(triggerOf(declaration, method) ? { trigger: triggerOf(declaration, method) } : {}),
          },
        });
        graph.addEdge({ from: nodeId, to: methodId, kind: 'defines' });
      }
    }

    // A schema nothing registers is a sub-document's shape (`[PatientFormFieldSchema]`), not a collection.
    if (role === 'model' && (!index.registered?.size || index.registered.has(name))) {
      declareSchemaClass(declaration, name, rel, graph, index);
    }

    if (role === 'dto') {
      declareDto(declaration, name, rel, graph);
    }

    index.classes.set(name, info);
  }
}

/**
 * The models a Nest/Mongoose project turns into collections:
 * `MongooseModule.forFeature([{ name: Patient.name, schema }])`, `@InjectModel(Patient.name)`,
 * `mongoose.model('Patient', schema)`. Read as text, once, across the server files.
 */
function registeredModels(files: SourceFile[]): Set<string> {
  const found = new Set<string>();
  const patterns = [
    /\bname\s*:\s*([A-Za-z_$][\w$]*)\.name\b/g,
    /@InjectModel\(\s*([A-Za-z_$][\w$]*)\.name\b/g,
    /@InjectModel\(\s*['"`]([^'"`]+)['"`]/g,
    // `ref: 'Product'` names a model Mongoose has to know to populate it.
    /\bref\s*:\s*['"`]([^'"`]+)['"`]/g,
    /\bref\s*:\s*([A-Za-z_$][\w$]*)\.name\b/g,
    /\bmodel\s*(?:<[^>]*>)?\(\s*['"`]([^'"`]+)['"`]/g,
  ];
  for (const file of files) {
    const text = file.getFullText();
    if (!/forFeature|InjectModel|\bmodel\s*[<(]|\bref\s*:/.test(text)) continue;
    // `name: X.name` counts only inside a `forFeature` registration.
    for (const block of text.matchAll(/forFeature(?:Async)?\s*\(([\s\S]*?)\)\s*[,\]]/g))
      for (const match of (block[1] ?? '').matchAll(patterns[0]!)) found.add(match[1]!);
    for (const pattern of patterns.slice(1))
      for (const match of text.matchAll(pattern)) found.add(match[1]!);
  }
  return found;
}

/**
 * What runs a method when no code calls it: a timer or a queue (`job`), every
 * request (`request`: a login strategy, a guard, a middleware), or a live
 * connection (`socket`). Read from the framework's own decorators and shapes.
 */
function triggerOf(
  declaration: ClassDeclaration,
  method: MethodDeclaration,
): 'job' | 'request' | 'socket' | undefined {
  const on = method.getDecorators().map((d) => d.getName());
  const classOn = declaration.getDecorators().map((d) => d.getName());
  const name = method.getName();
  if (
    on.some((d) =>
      /^(Cron|Interval|Timeout|Process|OnQueue\w*|OnEvent|EventPattern|MessagePattern)$/.test(d),
    )
  )
    return 'job';
  if (classOn.includes('Processor') && name === 'process') return 'job';
  if (on.includes('SubscribeMessage')) return 'socket';
  if (
    classOn.includes('WebSocketGateway') &&
    /^handle(Connection|Disconnect)$|^afterInit$/.test(name)
  )
    return 'socket';
  const heritage = declaration.getText().slice(0, declaration.getText().indexOf('{'));
  if (/\bPassportStrategy\b/.test(heritage) && name === 'validate') return 'request';
  if (/\bimplements\b[^{]*\bCanActivate\b/.test(heritage) && name === 'canActivate')
    return 'request';
  if (/\bimplements\b[^{]*\bNestMiddleware\b/.test(heritage) && name === 'use') return 'request';
  return undefined;
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
  const schemaOptions = asObjectLiteral(getDecorator(declaration, 'Schema')?.getArguments()[0]);
  const collection =
    readString(schemaOptions ? propertyValue(schemaOptions, 'collection') : undefined) ??
    collectionNameOf(modelName);
  // `@Schema({ timestamps: true })` or `{ createdAt: 'created_at' }`: Mongoose fills these itself.
  const timestamps = schemaOptions
    ? propertyValue(schemaOptions, 'timestamps')?.getText()
    : undefined;
  const stamped = new Set<string>();
  if (timestamps && timestamps !== 'false') {
    const named = [...timestamps.matchAll(/(createdAt|updatedAt)\s*:\s*['"`]([^'"`]+)['"`]/g)];
    for (const key of ['createdAt', 'updatedAt'])
      if (!new RegExp(`${key}\\s*:\\s*false`).test(timestamps))
        stamped.add(named.find((m) => m[1] === key)?.[2] ?? key);
  }

  registerModel(graph, index, modelName, collection, { file: rel, line: lineOf(declaration) });

  const modelId = ids.model(modelName);
  for (const property of declaration.getProperties()) {
    const prop = property.getDecorators().find((d) => d.getName() === 'Prop');
    if (!prop) continue;
    const fieldName = property.getName();
    const fieldId = ids.field(modelId, fieldName);
    const declaredType = property.getTypeNode()?.getText();
    graph.addNode({
      id: fieldId,
      kind: 'field',
      label: fieldName,
      source: { file: rel, line: lineOf(property) },
      meta: {
        owner: modelName,
        type: declaredType,
        /**
         * `@Prop({ ref: 'Customer' })` — the link between two collections,
         * read here because this is the only place it is written down.
         */
        ...schemaRefOf(asObjectLiteral(prop.getArguments()[0]), declaredType),
        ...fieldRulesOf(asObjectLiteral(prop.getArguments()[0])),
        ...(stamped.has(fieldName) ? { defaultValue: 'the time (Mongoose timestamps)' } : {}),
      },
    });
    graph.addEdge({ from: modelId, to: fieldId, kind: 'defines' });
  }
}

/**
 * The `ref` on one schema field, and whether it holds one id or many.
 *
 * Mongoose spells the same relationship four ways — `{ ref: 'X' }`,
 * `{ type: [..], ref: 'X' }`, `[{ ref: 'X' }]` and a `ref` on a nested `type`
 * object — and a reader of the *document* does not care which. All four are
 * normalised to the two facts that matter: the model on the other end, and
 * whether this side is a list.
 *
 * `cardinality` comes from the declared TypeScript type as well as the option
 * object, because `@Prop({ ref: 'Product' }) products: Types.ObjectId[]` says
 * "many" only in the type.
 */
function schemaRefOf(
  options: ObjectLiteralExpression | undefined,
  declaredType?: string,
): { ref?: string; refMany?: boolean } {
  if (!options) return {};

  // `ref: 'Doctor'`, or `ref: Doctor.name` — the class's name is the model's.
  const refName = (node: Node | undefined) =>
    readString(node) ?? /^([A-Za-z_$][\w$]*)\.name$/.exec(node?.getText() ?? '')?.[1];
  const direct = refName(propertyValue(options, 'ref'));
  const typeValue = propertyValue(options, 'type');
  // `type: [{ type: ObjectId, ref: 'X' }]` and `type: { ref: 'X' }`.
  const nestedElement =
    typeValue && Node.isArrayLiteralExpression(typeValue)
      ? asObjectLiteral(typeValue.getElements()[0])
      : asObjectLiteral(typeValue);
  const nested = nestedElement ? refName(propertyValue(nestedElement, 'ref')) : undefined;

  const ref = direct ?? nested;
  if (!ref) return {};

  const many =
    (typeValue !== undefined && Node.isArrayLiteralExpression(typeValue)) ||
    /\[\s*\]\s*$|^Array</.test(declaredType ?? '');
  return { ref, ...(many ? { refMany: true } : {}) };
}

/**
 * The same reading for a plain `new Schema({...})` field value.
 *
 * `customerId: { ref: 'Customer' }` is an object; `customerIds: [{ ref:
 * 'Customer' }]` is an array of one. Anything else — a bare `String`, a
 * function, an import — declares no relation.
 */
function literalRefOf(value: Node | undefined): { ref?: string; refMany?: boolean } {
  if (!value) return {};
  if (Node.isArrayLiteralExpression(value)) {
    const inner = schemaRefOf(asObjectLiteral(value.getElements()[0]));
    return inner.ref ? { ref: inner.ref, refMany: true } : {};
  }
  return schemaRefOf(asObjectLiteral(value));
}

/**
 * `required`, `unique` and `index` on one schema field, for the Database tab.
 * `required: [true, 'message']` counts; a function or a variable is not read.
 */
function fieldRulesOf(options: ObjectLiteralExpression | undefined): {
  required?: true;
  unique?: true;
  indexed?: true;
  defaultValue?: string;
  enumValues?: string[];
} {
  if (!options) return {};
  const on = (key: string) =>
    /^(true|\[\s*true\b)/.test(propertyValue(options, key)?.getText() ?? '');
  // `default: Date.now`: the database layer fills it when the code leaves it out.
  const fallback = propertyValue(options, 'default')?.getText().replace(/\s+/g, ' ');
  const choices = enumValuesOf(propertyValue(options, 'enum'));
  return {
    ...(choices.length ? { enumValues: choices } : {}),
    ...(on('required') ? { required: true } : {}),
    ...(on('unique') ? { unique: true } : {}),
    ...(on('index') ? { indexed: true } : {}),
    ...(fallback
      ? { defaultValue: fallback.length > 60 ? `${fallback.slice(0, 57)}…` : fallback }
      : {}),
  };
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
      /**
       * The field's own value, for the `ref` inside it.
       *
       * `objectKeys` is enough to name the fields, but a relation is declared
       * in the value — `customerId: { type: ObjectId, ref: 'Customer' }` — so
       * the value is read too where there is one to read.
       */
      const value = propertyValue(schemaLiteral, fieldName);
      graph.addNode({
        id: fieldId,
        kind: 'field',
        label: fieldName,
        source: { file: rel, line: lineOf(schemaLiteral) },
        meta: {
          owner: modelName,
          ...literalRefOf(value),
          ...fieldRulesOf(asObjectLiteral(value)),
        },
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
            // `@All()`: answers any method — an outside system's callback, not a screen's request.
            ...(verb === 'ALL' ? { anyMethod: true } : {}),
          },
        });
        graph.addEdge({ from: routeId, to: methodId, kind: 'calls' });
        /**
         * Guards, interceptors and pipes, per route rather than per method:
         * `@All()` expands into one node per verb, and a guard applies to each
         * of them.
         */
        linkNestMiddleware(info.declaration, method, routeId, info.file, graph);
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
function resolveMethodBodies(
  info: ClassInfo,
  graph: FlowGraph,
  index: BackendIndex,
  config: BackendConfig,
): void {
  for (const [methodName, method] of info.methods) {
    const methodId = ids.method(info.nodeId, methodName);

    /**
     * Third-party work done by this method. Recorded before the call walk so a
     * method whose only effect is an outbound call still terminates visibly
     * rather than looking like a dead end.
     */
    linkExternalEffects(method, info.file, graph, methodId, `${info.name}.${methodName}`);

    for (const call of callsIn(method)) {
      const receiver = calleeReceiver(call);
      const member = calleeMember(call);
      if (!receiver) continue;

      // 0. Prisma: this.prisma.order.create(...)
      const table = prismaTableOf(receiver, config.prisma);
      if (table) {
        const prismaEffect = prismaEffectOf(member);
        if (!prismaEffect) continue;
        recordDbOp(graph, index, {
          methodId,
          modelName: table,
          operation: member,
          file: info.file,
          line: lineOf(call),
          site: `${info.name}.${methodName}`,
          upsert: upsertsIn(call),
          effect: prismaEffect,
          collection: table,
          database: 'prisma',
        });
        continue;
      }

      // 1. Database access: this.customerModel.find(...), or a `model` that holds one of them.
      const direct = resolveModelReceiver(receiver, info);
      const modelNames = direct ? [direct] : modelsBehind(receiver, method, methodName, info);
      if (modelNames.length) {
        const effect = dbEffectOf(member);
        if (!effect) continue;
        for (const modelName of modelNames)
          recordDbOp(graph, index, {
            methodId,
            modelName,
            operation: member,
            file: info.file,
            line: lineOf(call),
            site: `${info.name}.${methodName}`,
            upsert: upsertsIn(call),
            effect,
          });
        continue;
      }

      // 1b. A loaded document saved back: `patient.uuid = uuid; await patient.save()`.
      // A loaded document written back: `doc.save()`, `doc.update({ … })`, `doc.deleteOne()`.
      if (DOCUMENT_WRITES[member] && /^[A-Za-z_$][\w$]*$/.test(receiver)) {
        const load = loadedFrom(receiver, call);
        const loadReceiver = load ? calleeReceiver(load) : undefined;
        const loadedModel = loadReceiver ? resolveModelReceiver(loadReceiver, info) : undefined;
        if (load && loadedModel && dbEffectOf(calleeMember(load))) {
          recordDbOp(graph, index, {
            methodId,
            modelName: loadedModel,
            operation: member,
            file: info.file,
            line: lineOf(call),
            site: `${info.name}.${methodName}`,
            effect: DOCUMENT_WRITES[member],
            onDocument: true,
          });
          continue;
        }
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
      // The model itself — `new this.model.base.Types.ObjectId(id)` builds an id, not a document.
      const modelName = info.models.get(target);
      if (!modelName || !isSaved(expression, method)) continue;
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
 * The values `enum:` allows: `['male', 'female']`, or an `enum Gender {…}` /
 * `const GENDERS = [...]` / `Object.values(Gender)` declared in the same file.
 */
function enumValuesOf(value: Node | undefined, depth = 0): string[] {
  if (!value || depth > 2) return [];
  if (Node.isArrayLiteralExpression(value))
    return value
      .getElements()
      .flatMap((element) =>
        Node.isStringLiteral(element) || Node.isNumericLiteral(element)
          ? [String(element.getLiteralValue())]
          : [],
      );
  const name = Node.isIdentifier(value)
    ? value.getText()
    : Node.isCallExpression(value) && /^Object\.values$/.test(value.getExpression().getText())
      ? value.getArguments()[0]?.getText()
      : undefined;
  if (!name) return [];
  // Declared here, or in the file it is imported from (`import { GenderTypes } from './enums'`).
  const here = value.getSourceFile();
  const specifier = here
    .getImportDeclarations()
    .find((declaration) =>
      declaration
        .getNamedImports()
        .some((named) => (named.getAliasNode() ?? named.getNameNode()).getText() === name),
    )
    ?.getModuleSpecifierValue();
  const from = specifier ? importedFile(here, specifier) : undefined;
  for (const file of [here, from]) {
    if (!file) continue;
    const declared = file.getEnum(name);
    if (declared)
      return declared.getMembers().map((member) => String(member.getValue() ?? member.getName()));
    let init = file.getVariableDeclaration(name)?.getInitializer();
    // `[...] as const` is still the array.
    if (init && Node.isAsExpression(init)) init = init.getExpression();
    if (init) return enumValuesOf(init, depth + 1);
  }
  return [];
}

/** A relative import's file among the scanned ones: `'../entities/patient.entity'`. */
function importedFile(from: SourceFile, specifier: string): SourceFile | undefined {
  if (!specifier.startsWith('.')) return undefined;
  const base = join(dirname(from.getFilePath()), specifier);
  for (const candidate of [
    base,
    ...['.ts', '.tsx', '.js', '.jsx', '/index.ts', '/index.js'].map((ext) => base + ext),
  ]) {
    const found = from.getProject().getSourceFile(candidate);
    if (found) return found;
  }
  return undefined;
}

/** What a loaded document's own write methods do to its record. */
const DOCUMENT_WRITES: Record<string, DbEffect> = {
  save: 'update',
  update: 'update',
  updateOne: 'update',
  set: 'update',
  deleteOne: 'delete',
  remove: 'delete',
};

/**
 * Whether a `new Model(dto)` is written: `.save()` on it, or on the variable that
 * holds it. One that only fills a token or a response is never stored.
 */
function isSaved(expression: Node, method: MethodDeclaration): boolean {
  let outer: Node = expression;
  while (
    Node.isParenthesizedExpression(outer.getParent() ?? outer) ||
    Node.isAwaitExpression(outer.getParent() ?? outer)
  )
    outer = outer.getParent()!;
  const access = outer.getParent();
  if (access && Node.isPropertyAccessExpression(access) && access.getName() === 'save') return true;
  const holder = outer.getFirstAncestorByKind(SyntaxKind.VariableDeclaration);
  if (!holder || holder.getInitializer() !== outer) return false;
  return new RegExp(`\\b${holder.getName()}\\s*\\.\\s*save\\s*\\(`).test(method.getText());
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

/**
 * The models a plain variable can hold, when the method picks one:
 *
 *   if (category === 'advice') model = this.emrAdvice; else if (…) model = this.emrSymptoms;
 *   await model.find(…)
 *
 * or is handed one by the class's own calls (`this.findOrCreate(data, this.emrAdvice)`).
 * The query reaches each of them, depending on the input; nothing else is guessed.
 */
function modelsBehind(
  receiver: string,
  method: MethodDeclaration,
  methodName: string,
  info: ClassInfo,
): string[] {
  if (!/^[A-Za-z_$][\w$]*$/.test(receiver)) return [];
  const found = new Set<string>();
  const add = (value: Node | undefined) => {
    const model = value && resolveModelReceiver(value.getText(), info);
    if (model) found.add(model);
  };
  for (const assignment of method.getDescendantsOfKind(SyntaxKind.BinaryExpression))
    if (
      assignment.getOperatorToken().getKind() === SyntaxKind.EqualsToken &&
      assignment.getLeft().getText() === receiver
    )
      add(assignment.getRight());
  for (const declaration of method.getDescendantsOfKind(SyntaxKind.VariableDeclaration))
    if (declaration.getName() === receiver) add(declaration.getInitializer());
  const position = method.getParameters().findIndex((p) => p.getName() === receiver);
  if (position >= 0)
    for (const call of method.getParentOrThrow().getDescendantsOfKind(SyntaxKind.CallExpression))
      if (call.getExpression().getText() === `this.${methodName}`)
        add(call.getArguments()[position]);
  return [...found];
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
    /**
     * The physical name, when the caller already knows it.
     *
     * Prisma declares its table in `schema.prisma`, so there is nothing to
     * derive — and running it through {@link collectionNameOf} would apply
     * Mongoose's pluralisation to a name Prisma took literally, naming a table
     * that does not exist.
     */
    collection?: string;
    database?: string;
    /** `updateOne(filter, change, { upsert: true })`: inserts when nothing matches. */
    upsert?: boolean;
    /** Called on a loaded document (`doc.update(change)`): its first argument is the change, not a filter. */
    onDocument?: boolean;
  },
): void {
  const collection =
    input.collection ?? index.collections.get(input.modelName) ?? collectionNameOf(input.modelName);
  let opId = ids.dbOp(collection, input.operation, input.site);
  // Two `findById`s in one method are two queries, each with its own line.
  const first = graph.node(opId);
  if (first && first.source?.line !== input.line)
    opId = ids.dbOp(collection, input.operation, `${input.site}@${input.line}`);
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
      ...(input.database ? { database: input.database } : {}),
      ...(input.upsert ? { upsert: true } : {}),
      ...(input.onDocument ? { onDocument: true } : {}),
    },
  });
  graph.addEdge({ from: input.methodId, to: opId, kind: 'queries' });
  /**
   * Declare the table only when the caller named it.
   *
   * Mongoose collections already arrive as nodes from the schema pass, and
   * creating them here too would change what an existing scan counts. A Prisma
   * table has no schema *class* to declare it, so without this its edge would
   * point at a node that does not exist.
   */
  if (input.collection) {
    graph.addNode({
      id: ids.collection(collection),
      kind: 'collection',
      label: collection,
      meta: { database: input.database ?? 'prisma' },
    });
  }
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
    const handlerIndex = args.findLastIndex(
      (argument) =>
        Node.isArrowFunction(argument) ||
        Node.isFunctionExpression(argument) ||
        Node.isIdentifier(argument),
    );
    const handler = handlerIndex === -1 ? undefined : args[handlerIndex];

    /**
     * The arguments between the path and the handler, which this pass used to
     * discard. `router.post('/orders', requireAuth, rateLimit, create)` is the
     * standard way to protect a route, and dropping those two names hid the
     * reason the route 401s from every flow that runs through it.
     */
    if (handlerIndex > 1) {
      linkExpressMiddleware(args, handlerIndex, routeId, rel, graph);
    }

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
    if (body) {
      linkDbOperations(body, file, rel, graph, handlerId, config.collectionAliases, config.prisma);
    }
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
