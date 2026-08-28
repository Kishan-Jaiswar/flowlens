import {
  Node,
  SyntaxKind,
  type ArrowFunction,
  type CallExpression,
  type FunctionDeclaration,
  type FunctionExpression,
  type JsxAttribute,
  type SourceFile,
  type VariableDeclaration,
} from 'ts-morph';
import type { FlowGraph } from '../graph/graph.js';
import { ids } from '../graph/ids.js';
import {
  asObjectLiteral,
  callsIn,
  calleeMember,
  calleeName,
  calleeReceiver,
  enclosingFunction,
  functionName,
  lineOf,
  objectKeys,
  propertyValue,
  readPathLike,
  readString,
  type Functionish,
} from './ast.js';
import { classifyFile, isFrontendCandidate } from './classify.js';
import { composeTitle, eventVerb, humanizeName, screenOf } from './screens.js';
import { DYNAMIC_MARKER, HTTP_METHODS, PARAM, normalizePath, type HttpMethod } from './http.js';
import type { LoadedProject } from './project.js';

/**
 * Event props that make a JSX element a user action.
 *
 * `onChange` is deliberately absent: every keystroke in every text input would
 * become a "feature", burying the handful of actions that actually reach the
 * backend under form noise.
 */
const ACTION_PROPS = ['onClick', 'onSubmit', 'onPress', 'onDoubleClick'] as const;

/** Props we read to label an action when the element has no text child. */
const LABEL_PROPS = ['aria-label', 'title', 'label', 'name', 'placeholder', 'data-testid'];

const HANDLER_NAME = /^(handle|on)[A-Z]/;

/** The last-resort label `actionLabel` falls back to: `button onClick`. */
const UNLABELLED = /^[A-Za-z][\w.]* on[A-Z]/;
const HOOK_NAME = /^use[A-Z]/;
const COMPONENT_NAME = /^[A-Z][A-Za-z0-9]*$/;

const STATE_HOOKS = new Set(['useState', 'useReducer']);

export interface FrontendConfig {
  /** Identifiers treated as HTTP clients: `api.post(...)`, `http.get(...)`. */
  httpClients: string[];
  /** Prefixes stripped from frontend URLs before matching backend routes. */
  apiPrefixes: string[];
  /**
   * Wrapper functions whose HTTP verb is part of the function name and whose
   * path arrives in an options object:
   *
   *   getRequest({ url: getPatientsList, auth: true })
   *   patchRequestNoLoader({ url, body })
   *   postRequestV3({ url, body })
   *
   * Almost every real codebase has a family like this. The default pattern
   * requires the word `Request` after the verb so that ordinary functions
   * (`getState()`, `deleteRow()`) are not mistaken for HTTP calls — a looser
   * `^(get|post|...)` would match half the functions in a project.
   *
   * Capture group 1 must be the HTTP verb. Matched case-insensitively, and the
   * verb may appear anywhere in the name, so a wrapper family that prefixes or
   * infixes a product name (`abhaPostRequest`, `postAiRequest`,
   * `MedisageGetRequest`) is picked up without configuration.
   */
  requestFunctionPattern: string;
  /** Option keys read as the request path, in priority order. */
  urlKeys: string[];
  /** Option keys read as an extra path/query suffix appended to the url. */
  suffixKeys: string[];
  /** Option keys read as the request body. */
  bodyKeys: string[];
  /** Resolve identifiers (endpoint constants) to their literal value. */
  resolveConstant?: (name: string) => string | undefined;
}

export const DEFAULT_FRONTEND_CONFIG: FrontendConfig = {
  httpClients: ['axios', 'api', 'apiClient', 'http', 'httpClient', 'client', 'request', 'instance'],
  apiPrefixes: ['/api'],
  requestFunctionPattern:
    '^[A-Za-z0-9_]*?(get|post|put|patch|delete|head|options)[A-Za-z0-9_]*request[A-Za-z0-9_]*$',
  urlKeys: ['url', 'path', 'endpoint'],
  suffixKeys: ['params', 'query', 'suffix'],
  bodyKeys: ['body', 'data', 'payload'],
};

/** A call site FlowLens found but could not resolve until every file was read. */
interface PendingCall {
  /** The caller (handler, hook, component or module function). */
  from: DeclaredSymbol;
  /** Symbol being called. */
  name: string;
  file: string;
}

/**
 * `const { createPatient } = useCreatePatient()`.
 *
 * Without this, the most common React data-fetching idiom breaks the chain:
 * the handler calls `createPatient`, which is not a hook name and not declared
 * anywhere, so the flow would stop at the handler and never reach the API call.
 */
interface PendingAlias {
  file: string;
  localName: string;
  hookName: string;
}

interface DeclaredSymbol {
  id: string;
  /**
   * `module-fn` is a plain exported function — a service-layer wrapper such as
   * `export async function fetchPatients()`. Its node is created only if it
   * turns out to participate in a flow; see `pruneUnusedModuleFunctions`.
   */
  kind: 'hook' | 'component' | 'handler' | 'module-fn';
  file: string;
  /** Idempotently add this symbol's node to the graph. */
  ensure: () => void;
}

/**
 * Walk the frontend and record: which components exist, what a user can click,
 * which handler that runs, which state the handler reads, and which HTTP call
 * it ends up making.
 */
export function analyzeFrontend(
  loaded: LoadedProject,
  graph: FlowGraph,
  config: FrontendConfig = DEFAULT_FRONTEND_CONFIG,
): void {
  /** Global name -> declaration, used to resolve cross-file hook calls. */
  const globals = new Map<string, DeclaredSymbol[]>();
  const pending: PendingCall[] = [];
  const aliases: PendingAlias[] = [];

  for (const file of loaded.sourceFiles) {
    const rel = loaded.rel(file);
    if (!isFrontendCandidate(classifyFile(file, rel))) continue;
    try {
      analyzeFrontendFile(file, rel, graph, config, globals, pending, aliases);
    } catch (error) {
      // One unusual file must never end a scan of ten thousand.
      loaded.warnings.push(`frontend analysis failed for ${rel}: ${message(error)}`);
    }
  }

  resolvePendingCalls(graph, globals, pending, aliases);
  addMountActions(graph);
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function analyzeFrontendFile(
  file: SourceFile,
  rel: string,
  graph: FlowGraph,
  config: FrontendConfig,
  globals: Map<string, DeclaredSymbol[]>,
  pending: PendingCall[],
  aliases: PendingAlias[],
): void {
  /** Names declared in this file -> node id. Local wins over global. */
  const locals = new Map<string, DeclaredSymbol>();

  const declare = (name: string, symbol: DeclaredSymbol) => {
    locals.set(name, symbol);
    const list = globals.get(name);
    if (list) list.push(symbol);
    else globals.set(name, [symbol]);
  };

  // ---- 1. Components, hooks and module-level functions --------------------
  for (const fn of topLevelFunctions(file)) {
    const name = functionName(fn);
    if (!name) continue;

    if (HOOK_NAME.test(name)) {
      const id = ids.hook(rel, name);
      graph.addNode({
        id,
        kind: 'hook',
        label: name,
        source: { file: rel, line: lineOf(fn) },
      });
      declare(name, { id, kind: 'hook', file: rel, ensure: noop });
      continue;
    }

    if (COMPONENT_NAME.test(name) && containsJsx(fn)) {
      const id = ids.component(rel, name);
      graph.addNode({
        id,
        kind: 'component',
        label: name,
        source: { file: rel, line: lineOf(fn) },
      });
      declare(name, { id, kind: 'component', file: rel, ensure: noop });
      analyzeComponentBody(fn, id, name, rel, graph, declare);
      continue;
    }

    /**
     * Any other top-level function.
     *
     * This is the service-layer shape: `export async function fetchPatients()`
     * in `src/api/patients.ts`, called from a component's handler. Without it,
     * the chain stops at the handler and the API call floats free — which is how
     * a project whose requests live one module away looks like it makes none.
     *
     * The node is created lazily so the graph does not fill up with utility
     * functions that turn out to be irrelevant.
     */
    const moduleId = ids.handler(rel, 'module', name);
    const line = lineOf(fn);
    declare(name, {
      id: moduleId,
      kind: 'module-fn',
      file: rel,
      ensure: () => {
        if (graph.hasNode(moduleId)) return;
        graph.addNode({
          id: moduleId,
          kind: 'handler',
          label: name,
          source: { file: rel, line },
          meta: { module: true, function: name },
        });
      },
    });
  }

  // ---- 2. Handlers declared outside a component --------------------------
  for (const declaration of file.getVariableDeclarations()) {
    const name = declaration.getName();
    if (!HANDLER_NAME.test(name)) continue;
    const existing = locals.get(name);
    if (existing && existing.kind !== 'module-fn') continue;
    const initializer = declaration.getInitializer();
    if (!initializer || !isFunctionish(initializer)) continue;
    const id = ids.handler(rel, 'module', name);
    graph.addNode({
      id,
      kind: 'handler',
      label: name,
      source: { file: rel, line: lineOf(declaration) },
    });
    declare(name, { id, kind: 'handler', file: rel, ensure: noop });
  }

  // ---- 3. Values destructured out of a hook call --------------------------
  // Descendants, not top-level: the idiom appears *inside* a component body.
  // Keyed by (file, name), so the same alias reused in two components in one
  // file resolves to whichever hook was seen last — rare, and cheap to accept.
  for (const declaration of file.getDescendantsOfKind(SyntaxKind.VariableDeclaration)) {
    const initializer = declaration.getInitializer();
    if (!initializer || !Node.isCallExpression(initializer)) continue;
    const hookName = calleeName(initializer);
    if (hookName.includes('.') || !HOOK_NAME.test(hookName)) continue;

    const nameNode = declaration.getNameNode();
    if (Node.isObjectBindingPattern(nameNode)) {
      for (const element of nameNode.getElements()) {
        aliases.push({ file: rel, localName: element.getName(), hookName });
      }
    } else if (Node.isArrayBindingPattern(nameNode)) {
      for (const element of nameNode.getElements()) {
        if (Node.isBindingElement(element)) {
          aliases.push({ file: rel, localName: element.getName(), hookName });
        }
      }
    } else if (Node.isIdentifier(nameNode)) {
      aliases.push({ file: rel, localName: nameNode.getText(), hookName });
    }
  }

  // ---- 4. HTTP calls and code calls --------------------------------------
  for (const call of callsIn(file)) {
    const owner = ownerOf(call, rel, locals, graph);
    const request = readHttpCall(call, config);
    if (request) {
      // Still an HTTP call, so never fall through to code-call handling —
      // but only a nameable endpoint earns a node.
      if (isConcreteEndpoint(request)) {
        // An owner that makes a request is real, whatever kind it is.
        owner?.ensure();
        linkApiCall(graph, owner?.id, request, rel, call);
      }
      continue;
    }
    // Bare identifier calls only: `foo()`, never `foo.bar()`. Resolution
    // happens later, once every file has declared what it exports.
    const callee = calleeName(call);
    if (!callee.includes('.') && owner) {
      pending.push({ from: owner, name: callee, file: rel });
    }
  }
}

/** State, nested handlers and JSX actions inside one component. */
function analyzeComponentBody(
  fn: Functionish,
  componentId: string,
  componentName: string,
  rel: string,
  graph: FlowGraph,
  declare: (name: string, symbol: DeclaredSymbol) => void,
): void {
  // useState / useReducer
  for (const declaration of fn.getDescendantsOfKind(SyntaxKind.VariableDeclaration)) {
    const initializer = declaration.getInitializer();
    if (!initializer || !Node.isCallExpression(initializer)) continue;
    const hook = calleeMember(initializer);
    if (!STATE_HOOKS.has(hook)) continue;
    for (const stateName of stateNamesOf(declaration)) {
      const id = ids.state(componentId, stateName);
      graph.addNode({
        id,
        kind: 'state',
        label: stateName,
        source: { file: rel, line: lineOf(declaration) },
        meta: { hook, component: componentName },
      });
      graph.addEdge({ from: componentId, to: id, kind: 'defines' });
    }
  }

  /**
   * Functions declared inside the component.
   *
   * Every named function gets a node, not only `handleX`/`onX`. A request made
   * from `fetchBillingData` or `saveVoiceRx` has to stay attributable to the
   * function that made it: without a node, `ownerOf` walks past it and credits
   * the whole component, which severs the `ui-action -> handler -> api-call`
   * chain and silently drops the flow. Any codebase that does not use the
   * `handle` naming convention would otherwise appear to have almost no flows.
   *
   * `eventHandler` records whether the name looks like a DOM handler, so the
   * distinction is still available to callers that want it.
   */
  const declaredFunctions: { name: string; node: Node; line: number }[] = [];
  for (const declaration of fn.getDescendantsOfKind(SyntaxKind.VariableDeclaration)) {
    const initializer = declaration.getInitializer();
    if (!initializer || !isFunctionish(initializer)) continue;
    declaredFunctions.push({
      name: declaration.getName(),
      node: initializer,
      line: lineOf(declaration),
    });
  }
  // `async function save() {}` inside a component is just as common as the
  // arrow-function form, and was previously invisible.
  for (const declaration of fn.getDescendantsOfKind(SyntaxKind.FunctionDeclaration)) {
    const name = declaration.getName();
    if (!name) continue;
    declaredFunctions.push({ name, node: declaration, line: lineOf(declaration) });
  }

  for (const { name, node: initializer, line } of declaredFunctions) {
    // A nested component, not a function of this one.
    if (COMPONENT_NAME.test(name)) continue;
    const id = ids.handler(rel, componentName, name);
    graph.addNode({
      id,
      kind: 'handler',
      label: `${componentName}.${name}`,
      source: { file: rel, line },
      meta: {
        component: componentName,
        function: name,
        eventHandler: HANDLER_NAME.test(name),
      },
    });
    graph.addEdge({ from: componentId, to: id, kind: 'defines' });
    declare(name, { id, kind: 'handler', file: rel, ensure: noop });
    linkStateReads(initializer, id, componentId, graph);
  }

  // JSX elements the user can interact with
  for (const attribute of fn.getDescendantsOfKind(SyntaxKind.JsxAttribute)) {
    const propName = attribute.getNameNode().getText();
    if (!(ACTION_PROPS as readonly string[]).includes(propName)) continue;

    // Resolve the handler first: its name is the best label for the very common
    // case of an icon or wrapper element with no text of its own.
    const handlerId = resolveActionHandler(attribute, componentId, componentName, rel, graph);
    const handlerName = handlerId ? graph.node(handlerId)?.meta?.['function'] : undefined;
    const label = actionLabel(
      attribute,
      propName,
      typeof handlerName === 'string' ? handlerName : undefined,
    );

    /**
     * "Submit" alone identifies nothing in an app with fifteen of them, so the
     * node also carries where it lives — `Prescription · Submit`. `label` stays
     * the words on the element, which is what a text search looks for.
     */
    const place = screenOf(rel, componentName);
    /**
     * An icon button with no text, no labelling prop and no named handler has
     * nothing to quote, and `button onClick` on a tile is noise. Name it after
     * the component and the gesture instead — "Mapping cell click" — and leave
     * `action` unset, since there are no words on the element to show.
     */
    const wordless = !hasWords(label) || UNLABELLED.test(label);
    const phrase = wordless ? `${humanizeName(componentName)} ${eventVerb(propName)}` : label;
    const actionId = ids.uiAction(componentId, `${propName}-${label}`);
    graph.addNode({
      id: actionId,
      kind: 'ui-action',
      label,
      source: { file: rel, line: lineOf(attribute) },
      meta: {
        event: propName,
        component: componentName,
        ...(wordless ? { unlabelled: true } : { action: label }),
        screen: place.screen,
        title: composeTitle(place.screen, phrase),
        ...(place.page ? { page: place.page } : {}),
        ...(place.area ? { area: place.area } : {}),
      },
    });
    graph.addEdge({ from: componentId, to: actionId, kind: 'renders' });

    if (handlerId) {
      graph.addEdge({ from: actionId, to: handlerId, kind: 'triggers' });
    }
  }
}

/** `const [value, setValue] = useState()` -> ["value"] (the setter is noise). */
function stateNamesOf(declaration: VariableDeclaration): string[] {
  const nameNode = declaration.getNameNode();
  if (Node.isArrayBindingPattern(nameNode)) {
    // `const [, setValue] = useState()` leaves an omitted element in slot 0.
    const [first] = nameNode.getElements();
    if (first && Node.isBindingElement(first)) return [first.getName()];
    return [];
  }
  if (Node.isIdentifier(nameNode)) return [nameNode.getText()];
  if (Node.isObjectBindingPattern(nameNode)) {
    return nameNode.getElements().map((element) => element.getName());
  }
  return [];
}

/** Wire a handler to the component state it touches. */
function linkStateReads(fn: Node, handlerId: string, componentId: string, graph: FlowGraph): void {
  const stateNodes = graph.successors(componentId, ['defines']).filter((n) => n.kind === 'state');
  if (stateNodes.length === 0) return;
  const byName = new Map(stateNodes.map((node) => [node.label, node] as const));
  const setterOf = new Map(stateNodes.map((node) => [setterName(node.label), node] as const));

  for (const identifier of fn.getDescendantsOfKind(SyntaxKind.Identifier)) {
    const text = identifier.getText();
    const written = setterOf.get(text);
    if (written) {
      graph.addEdge({ from: handlerId, to: written.id, kind: 'writes-state' });
      continue;
    }
    const read = byName.get(text);
    if (read) {
      graph.addEdge({ from: handlerId, to: read.id, kind: 'reads-state' });
    }
  }
}

function setterName(state: string): string {
  return `set${state.charAt(0).toUpperCase()}${state.slice(1)}`;
}

/**
 * Label a user action the way the user would describe it.
 * Text child first ("Submit Prescription"), then labelling props, then the tag.
 */
function actionLabel(attribute: JsxAttribute, propName: string, handlerName?: string): string {
  const element = attribute.getFirstAncestor(
    (node) => Node.isJsxOpeningElement(node) || Node.isJsxSelfClosingElement(node),
  );
  if (!element) return propName;

  const tag =
    Node.isJsxOpeningElement(element) || Node.isJsxSelfClosingElement(element)
      ? element.getTagNameNode().getText()
      : 'element';

  if (Node.isJsxOpeningElement(element)) {
    const parent = element.getParent();
    if (Node.isJsxElement(parent)) {
      const text = directText(parent);
      if (text) return text;

      // `<form onSubmit={...}>` has no text of its own — the user identifies it
      // by its submit button ("Create Patient"), so borrow that label.
      if (propName === 'onSubmit') {
        for (const descendant of parent.getDescendantsOfKind(SyntaxKind.JsxElement)) {
          const tagName = descendant.getOpeningElement().getTagNameNode().getText();
          if (!/^(button|Button|SubmitButton)$/.test(tagName)) continue;
          const buttonText = directText(descendant);
          if (buttonText) return buttonText;
        }
      }
    }
  }

  const attributes =
    Node.isJsxOpeningElement(element) || Node.isJsxSelfClosingElement(element)
      ? element.getAttributes()
      : [];
  for (const candidate of attributes) {
    if (!Node.isJsxAttribute(candidate)) continue;
    if (!LABEL_PROPS.includes(candidate.getNameNode().getText())) continue;
    const initializer = candidate.getInitializer();
    const value =
      initializer && Node.isStringLiteral(initializer) ? initializer.getLiteralValue() : undefined;
    if (value) return value;
  }

  /**
   * Text from a small subtree: `<div onClick={...}><p>Preview</p></div>`.
   *
   * Bounded by size, because the same pattern wraps whole cards and sections —
   * and "Preview" is a label while the first paragraph of a patient record is
   * not.
   */
  if (Node.isJsxOpeningElement(element)) {
    const parent = element.getParent();
    if (
      Node.isJsxElement(parent) &&
      parent.getDescendantsOfKind(SyntaxKind.JsxElement).length <= 6
    ) {
      const nested = parent
        .getDescendantsOfKind(SyntaxKind.JsxText)
        .map((text) => text.getLiteralText().replace(/\s+/g, ' ').trim())
        .find((text) => text.length > 0);
      if (nested) return nested.slice(0, 40);
    }
  }

  // Icon buttons have no text at all, but their handler is named for the job.
  if (handlerName) {
    const humanized = humanizeHandler(handlerName);
    if (humanized) return humanized;
  }

  return `${tag} ${propName}`;
}

/**
 * `handleDownloadReport` -> `Download Report`.
 *
 * Developers name handlers after the user's intent, which makes them the best
 * available label when the markup provides none.
 */
export function humanizeHandler(name: string): string | undefined {
  const stripped = name.replace(/^(handle|on)/, '').replace(/(Click|Press|Submit)$/, '');
  if (stripped.length === 0) return undefined;
  const words = stripped
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[_-]+/g, ' ')
    .trim();
  if (words.length === 0) return undefined;
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** Does this text contain anything a person could read out loud? */
function hasWords(text: string): boolean {
  return /[A-Za-z0-9]/.test(text);
}

/** Immediate text children of a JSX element, collapsed to one line. */
function directText(element: Node): string {
  if (!Node.isJsxElement(element)) return '';
  return element
    .getJsxChildren()
    .map((child) => (Node.isJsxText(child) ? child.getLiteralText() : ''))
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Find the handler an action prop points at.
 * `onClick={handleSubmit}` resolves to the declared handler; an inline arrow
 * gets its own synthetic handler node so the flow is not broken.
 */
function resolveActionHandler(
  attribute: JsxAttribute,
  componentId: string,
  componentName: string,
  rel: string,
  graph: FlowGraph,
): string | undefined {
  const initializer = attribute.getInitializer();
  if (!initializer) return undefined;

  const expression = Node.isJsxExpression(initializer) ? initializer.getExpression() : initializer;
  if (!expression) return undefined;

  if (Node.isIdentifier(expression)) {
    const name = expression.getText();
    const id = ids.handler(rel, componentName, name);
    if (graph.hasNode(id)) return id;
    const moduleId = ids.handler(rel, 'module', name);
    if (graph.hasNode(moduleId)) return moduleId;
    // Handler comes from props or another module: keep the name, mark it unresolved.
    graph.addNode({
      id,
      kind: 'handler',
      label: `${componentName}.${name}`,
      source: { file: rel, line: lineOf(expression) },
      meta: { component: componentName, function: name, unresolved: true },
    });
    graph.addEdge({ from: componentId, to: id, kind: 'defines' });
    return id;
  }

  if (isFunctionish(expression)) {
    const name = `inline@${lineOf(expression)}`;
    const id = ids.handler(rel, componentName, name);
    // `onClick={() => handleDelete(id)}` — the wrapped call names the action.
    const wrapped = expression
      .getDescendantsOfKind(SyntaxKind.CallExpression)
      .map((call) => calleeName(call))
      .find((callee) => !callee.includes('.') && HANDLER_NAME.test(callee));
    graph.addNode({
      id,
      kind: 'handler',
      label: `${componentName}.${attribute.getNameNode().getText()} (inline)`,
      source: { file: rel, line: lineOf(expression) },
      meta: { component: componentName, inline: true, ...(wrapped ? { function: wrapped } : {}) },
    });
    graph.addEdge({ from: componentId, to: id, kind: 'defines' });
    linkStateReads(expression, id, componentId, graph);
    return id;
  }

  // onClick={() => handleSubmit(x)} handled above; onClick={someObj.method} below.
  if (Node.isPropertyAccessExpression(expression)) {
    const name = expression.getName();
    const id = ids.handler(rel, componentName, name);
    graph.addNode({
      id,
      kind: 'handler',
      label: `${componentName}.${name}`,
      source: { file: rel, line: lineOf(expression) },
      meta: { component: componentName, function: name },
    });
    graph.addEdge({ from: componentId, to: id, kind: 'defines' });
    return id;
  }

  return undefined;
}

export interface DetectedRequest {
  method: HttpMethod;
  /** Raw path as written in source. */
  rawPath: string;
  /** Normalised path used for route matching. */
  path: string;
  /** Keys of the request body object literal, when it is one. */
  payloadKeys: string[];
  /** payload key -> identifier it was assigned from (for state lineage). */
  payloadSources: Record<string, string>;
  client: string;
}

/**
 * Recognise an outbound HTTP call.
 *
 * Covers the four shapes that make up almost all real frontend code:
 *   fetch(url, { method })
 *   axios.post(url, body)
 *   axios({ url, method })
 *   api.post(url, body)      // any configured client identifier
 */
export function readHttpCall(
  call: CallExpression,
  config: FrontendConfig = DEFAULT_FRONTEND_CONFIG,
): DetectedRequest | undefined {
  const callee = calleeName(call);
  const member = calleeMember(call);
  const receiver = calleeReceiver(call);
  const args = call.getArguments();
  const resolve = config.resolveConstant;

  const isClient = (name: string | undefined): boolean => {
    if (!name) return false;
    const last = name.split('.').pop() ?? name;
    return config.httpClients.includes(last) || config.httpClients.includes(name);
  };

  // getRequest({ url, params }) — verb in the function name, path in options.
  const wrapper = readWrapperCall(call, member, args, config, resolve);
  if (wrapper) return wrapper;

  // fetch(url, { method })
  if (callee === 'fetch' || callee.endsWith('.fetch')) {
    const rawPath = readPathLike(args[0], resolve);
    if (!rawPath) return undefined;
    const options = asObjectLiteral(args[1]);
    const method = (readString(options && propertyValue(options, 'method')) ?? 'GET').toUpperCase();
    if (!isHttpMethod(method)) return undefined;
    return buildRequest(method, rawPath, bodyObject(options, 'body'), config, 'fetch');
  }

  // axios.post(url, body) / api.get(url)
  const memberUpper = member.toUpperCase();
  if (isHttpMethod(memberUpper) && isClient(receiver)) {
    const rawPath = readPathLike(args[0], resolve);
    if (!rawPath) return undefined;
    const bodyArg = memberUpper === 'GET' || memberUpper === 'DELETE' ? undefined : args[1];
    return buildRequest(
      memberUpper,
      rawPath,
      asObjectLiteral(bodyArg),
      config,
      receiver ?? 'client',
    );
  }

  // axios({ url, method, data })
  if (isClient(callee)) {
    const options = asObjectLiteral(args[0]);
    if (options) {
      const rawPath = readOption(options, config.urlKeys, resolve);
      if (!rawPath) return undefined;
      const method = (readString(propertyValue(options, 'method')) ?? 'GET').toUpperCase();
      if (!isHttpMethod(method)) return undefined;
      return buildRequest(
        method,
        withSuffix(rawPath, options, config, resolve),
        bodyObject(options, 'data'),
        config,
        callee,
      );
    }
    const rawPath = readPathLike(args[0], resolve);
    if (rawPath) {
      const options2 = asObjectLiteral(args[1]);
      const method = (
        readString(options2 && propertyValue(options2, 'method')) ?? 'GET'
      ).toUpperCase();
      if (!isHttpMethod(method)) return undefined;
      return buildRequest(method, rawPath, bodyObject(options2, 'data'), config, callee);
    }
  }

  return undefined;
}

/**
 * `getRequest({ url: getPatientsList, params: `/${id}` })`
 *
 * The verb comes from the function name and the path from the options object.
 * This is the shape most house-built API layers use, and the one that made a
 * 500-endpoint frontend look like it had twelve API calls.
 */
function readWrapperCall(
  call: CallExpression,
  member: string,
  args: ReturnType<CallExpression['getArguments']>,
  config: FrontendConfig,
  resolve: ((name: string) => string | undefined) | undefined,
): DetectedRequest | undefined {
  // Case-insensitive: the verb shows up as `get`, `Get` and `GET` across the
  // wrapper families real codebases grow (`abhaPostRequest`, `MedisageGetRequest`).
  const match = new RegExp(config.requestFunctionPattern, 'i').exec(member);
  const verb = match?.[1]?.toUpperCase();
  if (!verb || !isHttpMethod(verb)) return undefined;

  const options = asObjectLiteral(args[0]);
  if (options) {
    const rawPath = readOption(options, config.urlKeys, resolve);
    if (!rawPath) return undefined;
    return buildRequest(
      verb,
      withSuffix(rawPath, options, config, resolve),
      bodyObjectFrom(options, config.bodyKeys),
      config,
      member,
    );
  }

  // Some wrappers take the url positionally: getRequest(url, options)
  const rawPath = readPathLike(args[0], resolve);
  if (!rawPath) return undefined;
  const trailing = asObjectLiteral(args[1]);
  return buildRequest(
    verb,
    trailing ? withSuffix(rawPath, trailing, config, resolve) : rawPath,
    trailing ? bodyObjectFrom(trailing, config.bodyKeys) : undefined,
    config,
    member,
  );
}

/** First readable value among a list of option keys. */
function readOption(
  options: NonNullable<ReturnType<typeof asObjectLiteral>>,
  keys: string[],
  resolve: ((name: string) => string | undefined) | undefined,
): string | undefined {
  for (const key of keys) {
    const value = propertyValue(options, key);
    const read = readPathLike(value, resolve);
    if (read) return read;
    // `{ url }` shorthand: the property name is also the variable name.
    const property = options.getProperty(key);
    if (property && Node.isShorthandPropertyAssignment(property) && resolve) {
      const resolved = resolve(property.getName());
      if (resolved) return resolved;
    }
  }
  return undefined;
}

/**
 * Append a `params`-style suffix when it extends the *path*.
 *
 * `params: `/${id}`` makes `/doctor/patients` into `/doctor/patients/:id`,
 * which is a different route. A query string (`?from=x`) does not change the
 * route, so it is dropped.
 */
function withSuffix(
  rawPath: string,
  options: NonNullable<ReturnType<typeof asObjectLiteral>>,
  config: FrontendConfig,
  resolve: ((name: string) => string | undefined) | undefined,
): string {
  for (const key of config.suffixKeys) {
    const suffix = readPathLike(propertyValue(options, key), resolve);
    if (suffix === undefined) continue;
    const trimmed = suffix.trim();
    if (trimmed.startsWith('?') || trimmed.length === 0) return rawPath;
    if (trimmed.startsWith('/')) return `${rawPath}${trimmed}`;
    return `${rawPath}/${trimmed}`;
  }
  return rawPath;
}

/** Body object from the first matching key. */
function bodyObjectFrom(
  options: NonNullable<ReturnType<typeof asObjectLiteral>>,
  keys: string[],
): ReturnType<typeof asObjectLiteral> {
  for (const key of keys) {
    const found = bodyObject(options, key);
    if (found) return found;
  }
  return undefined;
}

function buildRequest(
  method: string,
  rawPath: string,
  body: ReturnType<typeof asObjectLiteral>,
  config: FrontendConfig,
  client: string,
): DetectedRequest {
  const payloadKeys = body ? objectKeys(body) : [];
  const payloadSources: Record<string, string> = {};
  if (body) {
    for (const property of body.getProperties()) {
      if (Node.isShorthandPropertyAssignment(property)) {
        payloadSources[property.getName()] = property.getName();
      } else if (Node.isPropertyAssignment(property)) {
        const initializer = property.getInitializer();
        if (initializer && Node.isIdentifier(initializer)) {
          payloadSources[property.getName()] = initializer.getText();
        }
      }
    }
  }
  return {
    method: method as HttpMethod,
    rawPath,
    path: normalizePath(rawPath, config.apiPrefixes),
    payloadKeys,
    payloadSources,
    client,
  };
}

/** `body: JSON.stringify(payload)` or `data: { ... }`. */
function bodyObject(
  options: ReturnType<typeof asObjectLiteral>,
  key: string,
): ReturnType<typeof asObjectLiteral> {
  if (!options) return undefined;
  const value = propertyValue(options, key);
  if (!value) return undefined;
  const direct = asObjectLiteral(value);
  if (direct) return direct;
  if (Node.isCallExpression(value) && calleeName(value) === 'JSON.stringify') {
    return asObjectLiteral(value.getArguments()[0]);
  }
  return undefined;
}

/**
 * Is this a real endpoint, or the inside of a generic request helper?
 *
 * The definition of a wrapper contains a genuine HTTP call whose URL is a
 * *parameter*:
 *
 *   export const getRequest = ({ url, params }) =>
 *     axios.get(`${baseUrl}${url}${params}`);   // -> GET /:param
 *
 * Every such helper would otherwise add a phantom endpoint per verb. Those are
 * not merely cosmetic: they surface in `doctor` as broken calls, and a path of
 * pure parameters can match a real `/:id` route and invent a flow.
 *
 * The test is whether any segment survived as a literal. A hardcoded
 * `axios.get('/')` is kept, because that path was written, not interpolated.
 */
export function isConcreteEndpoint(request: DetectedRequest): boolean {
  const segments = request.path.split('/').filter(Boolean);
  const hasLiteral = segments.some((segment) => segment !== PARAM && segment !== '*');
  if (hasLiteral) return true;
  // No literal segment: acceptable only if the source held no interpolation.
  return !request.rawPath.includes(DYNAMIC_MARKER);
}

function linkApiCall(
  graph: FlowGraph,
  ownerId: string | undefined,
  request: DetectedRequest,
  rel: string,
  call: CallExpression,
): void {
  const id = ids.apiCall(request.method, request.path);
  const node = graph.addNode({
    id,
    kind: 'api-call',
    label: `${request.method} ${request.path}`,
    source: { file: rel, line: lineOf(call) },
    meta: {
      httpMethod: request.method,
      path: request.path,
      rawPath: request.rawPath,
      client: request.client,
    },
  });

  // Payload keys accumulate across call sites — two screens may post different
  // subsets of the same endpoint.
  const existingKeys = (node.meta?.payloadKeys as string[] | undefined) ?? [];
  const mergedKeys = [...new Set([...existingKeys, ...request.payloadKeys])];
  node.meta = {
    ...node.meta,
    payloadKeys: mergedKeys,
    payloadSources: { ...(node.meta?.payloadSources as object), ...request.payloadSources },
  };

  /**
   * Where this endpoint is called from, across the whole app.
   *
   * One node per method+path is deliberate — it is what makes "who else calls
   * this?" answerable — but it means the node's own `source` is merely the first
   * call site the scan happened to read. A flow must show *its* call site, so
   * every site is recorded on the edge as well as counted here.
   */
  const site = `${rel}:${lineOf(call)}`;
  const sites = (node.meta?.['callSites'] as string[] | undefined) ?? [];
  if (!sites.includes(site)) {
    node.meta = { ...node.meta, callSites: [...sites, site] };
  }

  if (ownerId) {
    graph.addEdge({
      from: ownerId,
      to: id,
      kind: 'requests',
      meta: { file: rel, line: lineOf(call) },
    });
  }
}

/**
 * Which graph node "owns" a call site: the nearest handler, hook or component.
 * Falls back to undefined for module-level calls we cannot attribute.
 */
function ownerOf(
  call: CallExpression,
  rel: string,
  locals: Map<string, DeclaredSymbol>,
  graph: FlowGraph,
): DeclaredSymbol | undefined {
  const existing = (id: string): DeclaredSymbol => ({
    id,
    kind: 'handler',
    file: rel,
    ensure: noop,
  });

  let current: Functionish | undefined = enclosingFunction(call);
  while (current) {
    const name = functionName(current);
    if (name) {
      const local = locals.get(name);
      if (local) return local;
      const component = ownerComponentName(current);
      if (component) {
        const handlerId = ids.handler(rel, component, name);
        if (graph.hasNode(handlerId)) return existing(handlerId);
      }
    } else {
      /**
       * An anonymous function — almost always an inline JSX callback such as
       * `onClick={() => handleDelete(id)}`. It gets a synthetic handler node,
       * and this must be checked *before* walking further out; otherwise the
       * call is attributed to the whole component and the action's own path
       * (action -> inline handler -> ...) is left empty.
       */
      const component = ownerComponentName(current);
      if (component) {
        const inlineId = ids.handler(rel, component, `inline@${lineOf(current)}`);
        if (graph.hasNode(inlineId)) return existing(inlineId);
      }
    }
    current = enclosingFunction(current);
  }
  return undefined;
}

function noop(): void {}

function ownerComponentName(node: Node): string | undefined {
  let current: Functionish | undefined = enclosingFunction(node) ?? undefined;
  let last: string | undefined;
  while (current) {
    const name = functionName(current);
    if (name && COMPONENT_NAME.test(name)) last = name;
    current = enclosingFunction(current);
  }
  return last;
}

/**
 * Give every component a synthetic "loads" action when its mount path reaches
 * the backend.
 *
 * A great many screens fetch their data from `useEffect` rather than from a
 * click, so the work is triggered by the component appearing, not by the user
 * pressing anything. Those are still features — "the appointment screen loads
 * its diseases" is exactly what someone tracing a flow wants to find — but with
 * no `ui-action` at the head of the chain they were invisible to `flows`.
 *
 * The action is only created when something downstream actually requests, so
 * this never invents an entry point for a purely presentational component. It is
 * tagged `event: 'mount'` so callers can tell it from a real DOM event.
 */
function addMountActions(graph: FlowGraph): void {
  for (const component of graph.nodesOfKind('component')) {
    // Functions this component invokes directly, minus anything a real UI
    // action already triggers — those flows exist and would be duplicated.
    const triggered = new Set<string>();
    for (const action of graph.successors(component.id, ['renders'])) {
      for (const handler of graph.successors(action.id, ['triggers'])) triggered.add(handler.id);
    }

    const onMount = graph
      .successors(component.id, ['calls'])
      /**
       * Hooks are excluded. `const { createPatient } = useCreatePatient()` in
       * the body is a declaration, not a request: the hook hands back a function
       * that some handler calls later. Counting it would invent a mount-time
       * fetch for every component that merely holds a data hook.
       */
      .filter((node) => node.kind !== 'hook')
      .map((node) => node.id)
      .filter((id) => !triggered.has(id))
      .filter((id) => reachesApiCall(graph, id));

    if (onMount.length === 0) continue;

    const label = 'loads';
    const place = screenOf(component.source?.file ?? '', component.label);
    const actionId = ids.uiAction(component.id, `mount-${label}`);
    graph.addNode({
      id: actionId,
      kind: 'ui-action',
      label: `${component.label} ${label}`,
      ...(component.source ? { source: component.source } : {}),
      meta: {
        event: 'mount',
        component: component.label,
        synthetic: true,
        action: label,
        screen: place.screen,
        /**
         * `Patient detail · Upcoming appointment loads`. One file can define
         * several components, and two of them fetching on mount would otherwise
         * produce two tiles reading "Patient detail loads".
         */
        title: composeTitle(place.screen, `${humanizeName(component.label)} ${label}`),
        ...(place.page ? { page: place.page } : {}),
        ...(place.area ? { area: place.area } : {}),
      },
    });
    graph.addEdge({ from: component.id, to: actionId, kind: 'renders' });
    for (const handler of onMount) {
      graph.addEdge({ from: actionId, to: handler, kind: 'triggers' });
    }
  }
}

/** Does this node reach an api-call by calling or requesting? */
function reachesApiCall(graph: FlowGraph, start: string): boolean {
  for (const id of graph.reachable(start, { kinds: ['calls', 'requests'] }).keys()) {
    if (graph.node(id)?.kind === 'api-call') return true;
  }
  return false;
}

function resolvePendingCalls(
  graph: FlowGraph,
  globals: Map<string, DeclaredSymbol[]>,
  pending: PendingCall[],
  aliases: PendingAlias[],
): void {
  const aliasTable = new Map<string, string>();
  for (const alias of aliases) {
    aliasTable.set(`${alias.file}::${alias.localName}`, alias.hookName);
  }

  const touched = new Set<string>();

  for (const call of pending) {
    // `createPatient()` in this file may really mean `useCreatePatient()`.
    const name = aliasTable.get(`${call.file}::${call.name}`) ?? call.name;
    const candidates = globals.get(name);
    if (!candidates || candidates.length === 0) continue;
    // Prefer a declaration in the same file, then a unique global one.
    const sameFile = candidates.find((c) => c.file === call.file);
    const target = sameFile ?? (candidates.length === 1 ? candidates[0] : undefined);
    if (!target || target.id === call.from.id) continue;

    // Both ends must exist before they can be joined; lazily-declared module
    // functions are materialised here and pruned below if they lead nowhere.
    call.from.ensure();
    target.ensure();
    if (call.from.kind === 'module-fn') touched.add(call.from.id);
    if (target.kind === 'module-fn') touched.add(target.id);

    graph.addEdge({ from: call.from.id, to: target.id, kind: 'calls' });
  }

  pruneUnusedModuleFunctions(graph, touched);
}

/**
 * Drop module functions that lead nowhere.
 *
 * Declaring every top-level function lets FlowLens follow
 * `handler -> fetchPatients -> axios.post`, but it also drags in ordinary
 * helpers that merely call each other. Anything that cannot reach an API call
 * is not part of a feature flow, so it is removed rather than left to clutter
 * the graph and the impact counts.
 */
function pruneUnusedModuleFunctions(graph: FlowGraph, candidates: Set<string>): void {
  for (const id of candidates) {
    if (!graph.hasNode(id)) continue;
    const reachable = graph.reachable(id, { kinds: ['calls', 'requests'] });
    let reachesApi = false;
    for (const reachedId of reachable.keys()) {
      if (graph.node(reachedId)?.kind === 'api-call') {
        reachesApi = true;
        break;
      }
    }
    if (!reachesApi) graph.removeNode(id);
  }
}

function topLevelFunctions(file: SourceFile): Functionish[] {
  const out: Functionish[] = [];
  for (const fn of file.getFunctions()) out.push(fn);
  for (const declaration of file.getVariableDeclarations()) {
    const initializer = declaration.getInitializer();
    if (initializer && isFunctionish(initializer)) out.push(initializer);
  }
  // `export default function () {}` and `export default () => {}`
  const defaultExport = file.getDefaultExportSymbol()?.getDeclarations() ?? [];
  for (const declaration of defaultExport) {
    if (Node.isFunctionDeclaration(declaration) && !out.includes(declaration)) {
      out.push(declaration);
    }
  }
  return out;
}

function isFunctionish(
  node: Node,
): node is ArrowFunction | FunctionExpression | FunctionDeclaration {
  return (
    Node.isArrowFunction(node) ||
    Node.isFunctionExpression(node) ||
    Node.isFunctionDeclaration(node)
  );
}

function containsJsx(node: Node): boolean {
  return (
    node.getFirstDescendant(
      (child) =>
        Node.isJsxElement(child) ||
        Node.isJsxSelfClosingElement(child) ||
        Node.isJsxFragment(child),
    ) !== undefined
  );
}

function isHttpMethod(value: string): value is HttpMethod {
  return (HTTP_METHODS as readonly string[]).includes(value);
}
