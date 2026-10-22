import {
  Node,
  SyntaxKind,
  type ArrowFunction,
  type CallExpression,
  type FunctionDeclaration,
  type FunctionExpression,
  type JsxAttribute,
  type JsxElement,
  type JsxOpeningElement,
  type JsxSelfClosingElement,
  type ObjectLiteralExpression,
  type SourceFile,
  type VariableDeclaration,
} from 'ts-morph';
import type { FlowGraph } from '../graph/graph.js';
import type { FlowNode } from '../graph/types.js';
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
  stripQuotes,
  type Functionish,
} from './ast.js';
import { classifyFile, isFrontendCandidate } from './classify.js';
import { aftermathOf } from './aftermath.js';
import { callSequenceFacts } from './callsequence.js';
import {
  composeTitle,
  eventVerb,
  humanizeName,
  isGenericComponentName,
  screenOf,
} from './screens.js';
import { DYNAMIC_MARKER, HTTP_METHODS, PARAM, normalizePath, type HttpMethod } from './http.js';
import type { LoadedProject } from './project.js';
import { keyPrefixOf } from './querykeys.js';

/**
 * Event props that make a JSX element a user action.
 *
 * The deliberate gesture — the user meant to do this.
 */
const ACTION_PROPS = ['onClick', 'onSubmit', 'onPress', 'onDoubleClick'] as const;

/**
 * Events that are also real actions, but noisy in bulk.
 *
 * `onChange` on a text input fires per keystroke and sets local state, and there
 * are hundreds of them; listing each as a "feature" buries the actions that
 * reach the backend. But `onChange` on a dropdown that refetches, `onBlur` that
 * autosaves, and `onKeyDown` that submits a search are exactly the actions
 * someone opens this tool to trace, so leaving them out entirely means the
 * answer to "show me every action" is wrong.
 *
 * They are detected like any other action and marked `input` in `eventClass`.
 * The ones that only touch local state fall under the existing local-only
 * filter and stay hidden by default; the ones that reach an API appear next to
 * the clicks, where they belong.
 */
const INPUT_ACTION_PROPS = [
  'onChange',
  'onBlur',
  'onFocus',
  'onInput',
  'onKeyDown',
  'onKeyUp',
  'onKeyPress',
  'onSelect',
  'onToggle',
  'onDrop',
  'onClose',
  'onCancel',
  'onOk',
  'onSearch',
  'onFinish',
  'onMouseDown',
  'onMouseUp',
  'onScroll',
] as const;

export const DEFAULT_ACTION_PROPS: readonly string[] = ACTION_PROPS;
export const DEFAULT_INPUT_ACTION_PROPS: readonly string[] = INPUT_ACTION_PROPS;

/**
 * The prop names one scan treats as actions, resolved once.
 *
 * Built per scan rather than looked up per attribute: a mid-size app has tens
 * of thousands of JSX attributes, and a `Set` built once is the difference
 * between two hash lookups and two array scans on every one of them.
 */
interface ActionProps {
  /** Every prop that makes an element an action. */
  all: ReadonlySet<string>;
  /** The subset that counts as a deliberate gesture rather than input. */
  gestures: ReadonlySet<string>;
}

function actionPropsOf(config: FrontendConfig): ActionProps {
  const gestures = new Set<string>([...ACTION_PROPS, ...(config.actionProps ?? [])]);
  return {
    gestures,
    all: new Set<string>([...gestures, ...INPUT_ACTION_PROPS, ...(config.inputActionProps ?? [])]),
  };
}

/** Props we read to label an action when the element has no text child. */
const LABEL_PROPS = ['aria-label', 'title', 'label', 'name', 'placeholder', 'data-testid'];

const HANDLER_NAME = /^(handle|on)[A-Z]/;

/** The last-resort label `actionLabel` falls back to: `button onClick`. */
const UNLABELLED = /^[A-Za-z][\w.]* on[A-Z]/;
const HOOK_NAME = /^use[A-Z]/;

/**
 * Hooks that fetch as soon as the component renders.
 *
 * The distinction matters for mount actions: `useMutation` hands back a
 * `mutate` function that some handler calls later, but `useQuery` issues its
 * request on mount. Treating every hook as the deferred kind meant a page whose
 * data loads through React Query had no action at all — in a real Next.js app,
 * 1 mount action for the whole project.
 */
const QUERY_HOOKS = new Set([
  'useQuery',
  'useQueries',
  'useInfiniteQuery',
  'useSuspenseQuery',
  'useSuspenseQueries',
  'useSuspenseInfiniteQuery',
  'useSWR',
  'useSWRInfinite',
  'useSWRImmutable',
]);

/**
 * `enabled: !!jobId` with `jobId` the hook's first parameter: whether it
 * fetches at all is the caller's to say. `enabled: false` never fetches by
 * itself.
 */
function enabledBy(fn: Functionish): Record<string, unknown> {
  const params = fn.getParameters().map((param) => param.getName());
  for (const call of callsIn(fn)) {
    if (!QUERY_HOOKS.has(calleeName(call).split('.').pop() ?? '')) continue;
    const options = call.getArguments().find((arg) => Node.isObjectLiteralExpression(arg));
    const enabled =
      options && Node.isObjectLiteralExpression(options)
        ? options.getProperty('enabled')
        : undefined;
    if (!enabled || !Node.isPropertyAssignment(enabled)) continue;
    const value = enabled.getInitializer();
    if (!value) continue;
    if (value.getText() === 'false') return { enabledByParam: -1 };
    const used = value
      .getDescendantsOfKind(SyntaxKind.Identifier)
      .map((identifier) => params.indexOf(identifier.getText()));
    if (Node.isIdentifier(value)) used.push(params.indexOf(value.getText()));
    const index = used.find((position) => position >= 0);
    if (index !== undefined) return { enabledByParam: index };
  }
  return {};
}

const LIBRARY_HOOKS =
  /^(useMutation|useQuery|useInfiniteQuery|useSuspenseQuery|useSWR|useSWRMutation|useSWRImmutable)$/;

/** A library hook called in a component body, made a hook node of its own. */
function inlineLibraryHook(
  call: CallExpression,
  declaration: VariableDeclaration,
  rel: string,
  graph: FlowGraph,
): { name: string; symbol: DeclaredSymbol; fetches: boolean; componentId?: string } | undefined {
  const library = calleeName(call);
  if (!LIBRARY_HOOKS.test(library)) return undefined;
  const component = ownerComponentName(declaration);
  if (!component) return undefined;
  const binding = declaration.getNameNode();
  const local = Node.isIdentifier(binding)
    ? binding.getText()
    : Node.isObjectBindingPattern(binding)
      ? binding
          .getElements()
          .map((element) => element.getName())
          .join(', ')
      : 'result';
  const name = `${component}.${local.replace(/[^\w$]+/g, '_')}`;
  const id = ids.hook(rel, name);
  const fetches = !/Mutation$/.test(library);
  const options = call.getArguments().find((arg) => Node.isObjectLiteralExpression(arg));
  const key =
    options && Node.isObjectLiteralExpression(options)
      ? options.getProperty('queryKey')
      : undefined;
  const prefix =
    key && Node.isPropertyAssignment(key) ? keyPrefixOf(key.getInitializer()) : undefined;
  graph.addNode({
    id,
    kind: 'hook',
    label: `${local} (${library})`,
    source: { file: rel, line: lineOf(call) },
    meta: {
      inline: true,
      ...(fetches ? { fetchesOnMount: true } : {}),
      ...(prefix ? { queryKeyPrefix: prefix } : {}),
      ...aftermathMeta(call),
    },
  });
  const componentId = ids.component(rel, component);
  return {
    name,
    symbol: { id, kind: 'hook', file: rel, ensure: noop },
    fetches,
    ...(graph.hasNode(componentId) ? { componentId } : {}),
  };
}

/** The inline library hook a call is written inside, if any. */
function inlineHookOf(call: Node, hooks: Map<Node, DeclaredSymbol>): DeclaredSymbol | undefined {
  if (hooks.size === 0) return undefined;
  for (let node = call.getParent(); node; node = node.getParent()) {
    const hook = hooks.get(node);
    if (hook) return hook;
  }
  return undefined;
}

/** The literal start of a query hook's key: what an invalidation has to match. */
function queryKeyOf(fn: Functionish): Record<string, unknown> {
  for (const call of callsIn(fn)) {
    if (!QUERY_HOOKS.has(calleeName(call).split('.').pop() ?? '')) continue;
    const options = call.getArguments().find((arg) => Node.isObjectLiteralExpression(arg));
    const key =
      options && Node.isObjectLiteralExpression(options)
        ? options.getProperty('queryKey')
        : undefined;
    const prefix =
      key && Node.isPropertyAssignment(key) ? keyPrefixOf(key.getInitializer()) : undefined;
    if (prefix) return { queryKeyPrefix: prefix };
  }
  return {};
}

/** Does this function body issue a request on mount rather than on demand? */
function fetchesOnMount(fn: Functionish): boolean {
  for (const call of callsIn(fn)) {
    const name = calleeName(call);
    if (QUERY_HOOKS.has(name.split('.').pop() ?? name)) return true;
  }
  return false;
}
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
   *   getRequest({ url: getCustomersList, auth: true })
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
   * infixes a product name (`crmPostRequest`, `postAiRequest`,
   * `AcmeGetRequest`) is picked up without configuration.
   */
  requestFunctionPattern: string;
  /** Option keys read as the request path, in priority order. */
  urlKeys: string[];
  /** Option keys read as an extra path/query suffix appended to the url. */
  suffixKeys: string[];
  /** Option keys read as the request body. */
  bodyKeys: string[];
  /**
   * Extra props treated as deliberate user gestures, added to the built-in
   * click/submit list.
   *
   * Every other convention in this config is overridable — the HTTP client
   * names, the request-wrapper pattern, the URL keys — and this one was not,
   * which made it the odd one out in the worst way. A design system whose
   * button says `onAction`, or a table whose row says `onRowClick`, produced
   * zero actions for those components with no way to say otherwise short of
   * patching the package.
   */
  actionProps?: string[];
  /**
   * Extra props treated as input-class actions: detected, but hidden by the
   * local-only filter unless they reach an API. Same escape hatch, for the
   * noisier half of the list.
   */
  inputActionProps?: string[];
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

/** A call site Flowslens found but could not resolve until every file was read. */
interface PendingCall {
  /** The caller (handler, hook, component or module function). */
  from: DeclaredSymbol;
  /** Symbol being called. */
  name: string;
  file: string;
  /**
   * `name` is the *receiver* of a member call, not the callee.
   *
   * `adjust.mutate(input)` where `const adjust = useAdjustStock()`. Such a call
   * may only be resolved through the alias table — never against globals, or
   * every `router.push()` and `console.log()` would try to link to a symbol
   * named `router` or `console`.
   */
  receiverOnly?: boolean;
  /** Where the call is written, so a caller's calls can be read in order. */
  line?: number;
  /** Inside `onSuccess`/`onError`/`.then(...)`: runs once a response is back. */
  afterResponse?: boolean;
  /** Where the call ends: an argument's call ends, and so runs, before its caller. */
  end?: number;
  /** Arguments that are empty when the component first draws: `null`, a state set later. */
  emptyArgs?: number[];
  /** Names the arguments are built from, through `useMemo` and the like: `query` -> page, sortBy. */
  reads?: string[];
}

/**
 * `const { createCustomer } = useCreateCustomer()`.
 *
 * Without this, the most common React data-fetching idiom breaks the chain:
 * the handler calls `createCustomer`, which is not a hook name and not declared
 * anywhere, so the flow would stop at the handler and never reach the API call.
 */
interface PendingAlias {
  file: string;
  localName: string;
  hookName: string;
  /** The key read off the hook's result: `logout` in `const { logout: signOut } = useAuth()`. */
  member?: string;
}

/**
 * `useAuth()` returning `useContext(AuthContext)`, and what
 * `<AuthContext.Provider value={{ logout }}>` puts in it: the hook's members are
 * the provider component's own functions, so a click on `logout` runs one.
 */
interface ContextIndex {
  /** Hook name -> the context it reads. */
  hooks: Map<string, string>;
  /** `Context::member` -> the provider's handler node id. */
  members: Map<string, string>;
}

interface DeclaredSymbol {
  id: string;
  /**
   * `module-fn` is a plain exported function — a service-layer wrapper such as
   * `export async function fetchCustomers()`. Its node is created only if it
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
  const contexts: ContextIndex = { hooks: new Map(), members: new Map() };
  const actionProps = actionPropsOf(config);

  for (const file of loaded.sourceFiles) {
    const rel = loaded.rel(file);
    if (!isFrontendCandidate(classifyFile(file, rel))) continue;
    try {
      analyzeFrontendFile(
        file,
        rel,
        graph,
        config,
        globals,
        pending,
        aliases,
        contexts,
        actionProps,
      );
    } catch (error) {
      // One unusual file must never end a scan of ten thousand.
      loaded.warnings.push(`frontend analysis failed for ${rel}: ${message(error)}`);
    }
  }

  resolvePendingCalls(graph, globals, pending, aliases, contexts);
  addMountActions(graph);
  nameComponentEvents(graph);
  linkPropBindings(graph, loaded);
  linkStateRefetches(graph, loaded);
  linkEffectRefetches(graph, loaded);
  linkPopupFeatures(graph, loaded);
  markConditionalMounts(graph, loaded);
  distinguishTwins(graph, loaded);
}

/**
 * `useEffect(() => { fetchBills() }, [activeTab, debouncedSearch, page])`: the
 * tab, the search and the page buttons each make the list load again — the
 * effect reruns when a state it watches changes. Without this, a search box or
 * a date filter read "stays in the browser" and was hidden. An effect that only
 * sets another watched state (a debounce: `setTimeout(() =>
 * setDebouncedSearch(input), 1000)`) passes the change on.
 */
const POPUP_TAG = /(?:Popup|Modal|Dialog|Drawer|Sheet|Overlay|Popover)/;
const MAIN_ACTION =
  /download|save|submit|collect|create|update|send|confirm|generate|apply|add|upload|import|pay|book/i;

/**
 * "Download Report" opens a popup; the user picks the dates there and presses
 * "Download", which sends the request. To the user that is one feature, and
 * its flow runs from the first click to the database — so the button that
 * opens a popup is joined to the popup's main action, as a step the user takes
 * in it (`userStep`). Every tab then follows the feature end to end.
 */
function linkPopupFeatures(graph: FlowGraph, loaded: LoadedProject): void {
  const files = new Map(loaded.sourceFiles.map((file) => [loaded.rel(file), file] as const));
  const actions = graph.nodesOfKind('ui-action');
  for (const component of graph.nodesOfKind('component')) {
    const file = component.source ? files.get(component.source.file) : undefined;
    if (!file) continue;
    const fn = file
      .getDescendants()
      .find(
        (node) =>
          (Node.isFunctionDeclaration(node) ||
            Node.isArrowFunction(node) ||
            Node.isFunctionExpression(node)) &&
          functionName(node as Functionish) === component.label,
      );
    if (!fn) continue;
    const own = graph
      .successors(component.id, ['renders'])
      .filter((node) => node.kind === 'ui-action');
    for (const opening of [
      ...fn.getDescendantsOfKind(SyntaxKind.JsxOpeningElement),
      ...fn.getDescendantsOfKind(SyntaxKind.JsxSelfClosingElement),
    ]) {
      const tag = opening.getTagNameNode().getText();
      const openProp = ['isOpen', 'open', 'show', 'visible']
        .map((name) => opening.getAttribute(name))
        .find((attr) => attr && Node.isJsxAttribute(attr));
      if (!POPUP_TAG.test(tag) && !openProp) continue;
      const element = Node.isJsxSelfClosingElement(opening) ? opening : opening.getParent();
      const condition = [
        openProp && Node.isJsxAttribute(openProp)
          ? openProp.getInitializer()?.getText()
          : undefined,
        gateOf(element),
      ]
        .filter(Boolean)
        .join(' ');
      const names = [...condition.replace(/!!/g, '').matchAll(/(!?)\s*\b([A-Za-z_$][\w$]*)\b/g)]
        .filter((match) => match[1] !== '!')
        .map((match) => match[2]!);
      if (names.length === 0) continue;
      // What opens it: a click here that sets one of those states to something.
      const openers = own.filter((action) => {
        // `onClose={() => handleClosePopup(false)}`, a Cancel button: a close, whatever its setter is given.
        if (
          /^on(Close|Cancel|Hide|Dismiss)$/.test(String(action.meta?.['event'] ?? '')) ||
          /^(close|cancel|dismiss|hide|back)\b/i.test(action.label)
        )
          return false;
        const handler = graph.successors(action.id, ['triggers'])[0];
        // Its own handler, or the one it calls: `onClick={() => handleUpdatePayment(bill)}`.
        const handlers = handler
          ? [
              handler,
              ...graph.successors(handler.id, ['calls']).filter((node) => node.kind === 'handler'),
            ]
          : [];
        return handlers.some((each) => {
          const sets = each.meta?.['sets'] as Record<string, string[]> | undefined;
          return names.some((name) =>
            (sets?.[setterName(name)] ?? []).some(
              (value) => !/^#(false|null|undefined|0)$/.test(value) && value !== '',
            ),
          );
        });
      });
      if (openers.length === 0) continue;
      // What is in it: its own controls, and those of the components it draws.
      const start = element.getStartLineNumber();
      const end = element.getEndLineNumber();
      const drawn = new Set(
        element
          .getDescendantsOfKind(SyntaxKind.JsxOpeningElement)
          .map((inner) => inner.getTagNameNode().getText())
          .concat(
            element
              .getDescendantsOfKind(SyntaxKind.JsxSelfClosingElement)
              .map((inner) => inner.getTagNameNode().getText()),
          )
          .filter((name) => /^[A-Z]/.test(name) && name !== tag)
          // `<AddMedicineDialog open={addOpen} />`: the popup is a component of its own.
          .concat(/^[A-Z]/.test(tag) ? [tag] : []),
      );
      const inside = actions.filter((action) => {
        if (openers.includes(action)) return false;
        // Hidden behind the action that runs it, which is the one to follow.
        if (((action.meta?.['relayedBy'] as string[] | undefined) ?? []).length > 0) return false;
        const at = action.source;
        if (!at) return false;
        if (at.file === component.source!.file && at.line >= start && at.line <= end) return true;
        // A copy made for one place it is drawn: `AdjustStockDialog`'s button
        // as drawn on this page, or `MedicineForm`'s as drawn in `AddMedicineDialog`.
        const site = action.meta?.['site'];
        if (drawn.has(String(action.meta?.['component'] ?? '')))
          return site === undefined || site === component.label;
        return site !== undefined && drawn.has(String(site));
      });
      const pressed = inside.filter(
        (action) =>
          // What loads as it opens is already joined to the click that shows it.
          !/^(mount|on(Close|Change|Input|Focus|Blur|KeyDown|KeyUp|MouseDown))$/.test(
            String(action.meta?.['event']),
          ) && !/^close|^cancel/i.test(action.label),
      );
      const sending = pressed.filter((action) => {
        const handler = graph.successors(action.id, ['triggers'])[0];
        return handler !== undefined && reachesApiCall(graph, handler.id);
      });
      const main =
        sending.find((action) => action.meta?.['event'] === 'onSubmit') ??
        sending.find((action) => MAIN_ACTION.test(action.label)) ??
        sending.at(-1);
      const target = main ? graph.successors(main.id, ['triggers'])[0] : undefined;
      if (!main || !target) continue;
      // The inputs of the form it submits too: `MedicineForm` inside `AddMedicineDialog`.
      const fields = [
        ...inside,
        ...actions.filter(
          (action) =>
            main.meta?.['component'] !== component.label &&
            action.meta?.['component'] === main.meta?.['component'] &&
            !inside.includes(action),
        ),
      ]
        .filter((action) => /^on(Change|Input)$/.test(String(action.meta?.['event'])))
        // What this popup and its form hold, not a dropdown widget's own search box.
        .filter((action) =>
          [tag, component.label, main.meta?.['component']].includes(
            action.meta?.['component'] as string,
          ),
        )
        .map((action) => action.label)
        .filter((label, index, list) => list.indexOf(label) === index);
      // A wizard's earlier step — "Continue" to a preview — is pressed before the main one.
      // Picking a file runs `handleFile` — checks it and reads its columns — before
      // anything is sent: a step of its own, once however many ways lead to it.
      const working = new Set<string>();
      // A file input before the drop zone beside it: both run the same `handleFile`.
      const byEvent = (action: FlowNode): number => (action.meta?.['event'] === 'onDrop' ? 1 : 0);
      const inputs = [...inside]
        .sort((a, b) => byEvent(a) - byEvent(b))
        .filter((action) => {
          if (!/^on(Change|Drop)$/.test(String(action.meta?.['event']))) return false;
          // The popup's own inputs, not the inside of a dropdown widget drawn in it.
          const owner = action.meta?.['component'];
          if (owner !== tag && owner !== component.label) return false;
          const handler = graph.successors(action.id, ['triggers'])[0];
          const runs = handler
            ? graph
                .successors(handler.id, ['calls'])
                .filter((node) => node.kind === 'handler')
                .map((node) => node.id)
            : [];
          if (runs.length === 0 || runs.every((id) => working.has(id))) return false;
          for (const id of runs) working.add(id);
          return true;
        });
      // What is filled in comes after a step of its own: the mapping, after the file is read.
      const filled = fields.filter((label) => !inputs.some((input) => input.label === label));
      const firstFilled = inputs.length;
      const before = [
        ...inputs,
        ...sending.filter(
          (action) => action !== main && /^(continue|next|preview|proceed)\b/i.test(action.label),
        ),
      ];
      for (const opener of openers) {
        const handler = graph.successors(opener.id, ['triggers'])[0];
        if (!handler) continue;
        before.forEach((earlier, index) => {
          const step = graph.successors(earlier.id, ['triggers'])[0];
          if (!step) return;
          graph.addEdge({
            from: handler.id,
            to: step.id,
            kind: 'calls',
            meta: {
              line: end - before.length + index,
              userStep: earlier.label,
              ...(inputs.includes(earlier) ? { input: true } : {}),
              ...(index === firstFilled && filled.length ? { fields: filled } : {}),
            },
          });
        });
        graph.addEdge({
          from: handler.id,
          to: target.id,
          kind: 'calls',
          meta: {
            line: end,
            userStep: main.label,
            ...(before.length === firstFilled && filled.length ? { fields: filled } : {}),
          },
        });
        opener.meta = { ...opener.meta, opensFeature: main.id };
      }
    }
  }
}

/** `{open && <X/>}`, `{open ? <X/> : null}`: the condition an element is drawn under. */
function gateOf(element: Node): string | undefined {
  let current: Node = element;
  for (let parent = current.getParent(); parent; current = parent, parent = parent.getParent()) {
    if (Node.isParenthesizedExpression(parent)) continue;
    if (
      Node.isBinaryExpression(parent) &&
      parent.getOperatorToken().getKind() === SyntaxKind.AmpersandAmpersandToken &&
      parent.getRight() === current
    )
      return parent.getLeft().getText();
    if (Node.isConditionalExpression(parent) && parent.getWhenTrue() === current)
      return parent.getCondition().getText();
    return undefined;
  }
  return undefined;
}

function linkEffectRefetches(graph: FlowGraph, loaded: LoadedProject): void {
  const files = new Map(loaded.sourceFiles.map((file) => [loaded.rel(file), file] as const));
  for (const component of graph.nodesOfKind('component')) {
    const file = component.source ? files.get(component.source.file) : undefined;
    if (!file) continue;
    const fn = file
      .getDescendants()
      .find(
        (node) =>
          (Node.isFunctionDeclaration(node) ||
            Node.isArrowFunction(node) ||
            Node.isFunctionExpression(node)) &&
          functionName(node as Functionish) === component.label,
      );
    if (!fn) continue;
    const states = new Map(
      graph
        .successors(component.id, ['defines'])
        .filter((node) => node.kind === 'state')
        .map((node) => [node.label, node.id] as const),
    );
    if (states.size === 0) continue;
    const handlerOf = (name: string): string | undefined => {
      const id = ids.handler(component.source!.file, component.label, name);
      return graph.hasNode(id) ? id : undefined;
    };
    // Each effect: the states it watches, what it runs, the states it sets.
    const effects = fn
      .getDescendantsOfKind(SyntaxKind.CallExpression)
      .filter((call) =>
        /^(React\.)?(useEffect|useLayoutEffect)$/.test(call.getExpression().getText()),
      )
      .map((call) => {
        const [body, deps] = call.getArguments();
        const watched =
          deps && Node.isArrayLiteralExpression(deps)
            ? deps
                .getElements()
                .map((element) => element.getText())
                .filter((name) => states.has(name))
            : [];
        const calls = body ? body.getDescendantsOfKind(SyntaxKind.CallExpression) : [];
        const runs = [
          ...new Set(
            calls
              .map((inner) => inner.getExpression().getText())
              .map((name) => handlerOf(name))
              .filter((id): id is string => id !== undefined),
          ),
        ];
        const sets = calls
          .map((inner) => inner.getExpression().getText())
          .filter((name) => /^set[A-Z]/.test(name))
          .map((name) => name.charAt(3).toLowerCase() + name.slice(4))
          .filter((name) => states.has(name));
        return { watched, runs, sets };
      })
      .filter((effect) => effect.watched.length > 0);
    if (effects.length === 0) continue;
    // What changing each state ends up running, through effects that pass it on.
    const runsOn = new Map<string, Set<string>>();
    for (let round = 0; round < 3; round++) {
      for (const effect of effects) {
        const reached = new Set(effect.runs);
        for (const set of effect.sets) for (const id of runsOn.get(set) ?? []) reached.add(id);
        for (const state of effect.watched) {
          const known = runsOn.get(state) ?? new Set<string>();
          for (const id of reached) known.add(id);
          runsOn.set(state, known);
        }
      }
    }
    for (const [state, targets] of runsOn) {
      for (const writer of graph.edgesTo(states.get(state)!, ['writes-state'])) {
        const handler = graph.node(writer.from);
        if (handler?.kind !== 'handler') continue;
        for (const target of targets) {
          if (target === handler.id) continue;
          graph.addEdge({
            from: handler.id,
            to: target,
            kind: 'calls',
            meta: { refetch: true, state, effect: true },
          });
        }
      }
    }
  }
}

/**
 * `{tab === "excels" && <ImportHistoryView />}`: its data loads when the user
 * opens that tab, not when the page opens. Marked so the page does not count
 * it among what it loads by itself.
 */
function markConditionalMounts(graph: FlowGraph, loaded: LoadedProject): void {
  for (const action of graph.nodesOfKind('ui-action')) {
    if (action.meta?.['event'] !== 'mount') continue;
    const name = action.meta?.['component'];
    if (typeof name !== 'string') continue;
    const conditions: string[] = [];
    let sites = 0;
    for (const file of loaded.sourceFiles) {
      if (!file.getFullText().includes(`<${name}`)) continue;
      for (const opening of [
        ...file.getDescendantsOfKind(SyntaxKind.JsxOpeningElement),
        ...file.getDescendantsOfKind(SyntaxKind.JsxSelfClosingElement),
      ]) {
        if (opening.getTagNameNode().getText() !== name) continue;
        sites += 1;
        const element = Node.isJsxSelfClosingElement(opening) ? opening : opening.getParent();
        const condition = renderCondition(element);
        if (condition) conditions.push(condition);
      }
    }
    // Every place that draws it does so only sometimes.
    if (sites > 0 && conditions.length === sites) {
      action.meta = { ...action.meta, shownWhen: [...new Set(conditions)].join(' or ') };
      linkShowingClicks(graph, action, conditions);
    }
  }
}

/**
 * The click that shows it starts its load: `setTab("excels")` with
 * `{tab === "excels" && <ImportHistoryView />}`. Read when the condition is
 * `state === "value"`; a click setting another value does not show it.
 */
function linkShowingClicks(graph: FlowGraph, mount: FlowNode, conditions: string[]): void {
  const targets = graph.successors(mount.id, ['triggers', 'requests']);
  if (targets.length === 0) return;
  for (const condition of conditions) {
    const test = /^\s*([\w$]+)\s*===\s*["'`]([^"'`]+)["'`]\s*$/.exec(condition);
    const bare = /^\s*(!?)\s*([\w$]+)\s*$/.exec(condition);
    const state = test?.[1] ?? bare?.[2];
    if (!state) continue;
    for (const node of graph.nodesOfKind('state')) {
      if (node.label !== state) continue;
      for (const writer of graph.edgesTo(node.id, ['writes-state'])) {
        const handler = graph.node(writer.from);
        if (handler?.kind !== 'handler') continue;
        if (test && !writesValue(handler, state, test[2]!)) continue;
        // `{open && <Form />}`: `setOpen(false)` hides it; only a truthy value shows it.
        if (bare && !writesTruthy(handler, state, bare[1] === '!')) continue;
        for (const target of targets)
          graph.addEdge({
            from: handler.id,
            to: target.id,
            kind: 'calls',
            meta: { shows: mount.meta?.['component'] },
          });
      }
    }
  }
}

/** Does it set `state` to something that makes `state` (or `!state`) true? Unknown counts as yes. */
function writesTruthy(handler: FlowNode, state: string, negated: boolean): boolean {
  const setter = `set${state.charAt(0).toUpperCase()}${state.slice(1)}`;
  const written = (handler.meta?.['sets'] as Record<string, string[]> | undefined)?.[setter];
  if (!written) return true;
  const falsy = (value: string) => /^#(false|null|undefined|0)$/.test(value) || value === '';
  return written.some((value) => value === '*' || (negated ? falsy(value) : !falsy(value)));
}

/** Does this handler set `state` to `value`? Unknown (not a literal) counts as yes. */
function writesValue(handler: FlowNode, state: string, value: string): boolean {
  const setter = `set${state.charAt(0).toUpperCase()}${state.slice(1)}`;
  const written = (handler.meta?.['sets'] as Record<string, string[]> | undefined)?.[setter];
  return !written || written.includes(value) || written.includes('*');
}

/** The condition an element is drawn under, within its own component. */
function renderCondition(element: Node | undefined): string | undefined {
  for (let node = element; node; node = node.getParent()) {
    const parent = node.getParent();
    if (!parent || Node.isFunctionDeclaration(parent) || Node.isArrowFunction(parent))
      return undefined;
    if (Node.isConditionalExpression(parent) && parent.getCondition() !== node) {
      const test = parent.getCondition().getText();
      return parent.getWhenTrue() === node ? test : `not (${test})`;
    }
    if (
      Node.isBinaryExpression(parent) &&
      parent.getOperatorToken().getKind() === SyntaxKind.AmpersandAmpersandToken &&
      parent.getRight() === node
    )
      return parent.getLeft().getText();
  }
  return undefined;
}

/**
 * `Next` in `Pagination` calls `onPageChange`; the page passes `setPage`. The
 * click's effect is the page's, so each place the component is rendered is
 * followed: a setter it is given becomes a state write, a handler a call. Its
 * Docs stopped at "calls `onPageChange`" and never reached the refetch.
 */
function linkPropBindings(graph: FlowGraph, loaded: LoadedProject): void {
  for (const action of graph.nodesOfKind('ui-action')) {
    const owner = action.meta?.['component'];
    if (typeof owner !== 'string') continue;
    const props = new Set([
      ...((action.meta?.['callsProps'] as string[] | undefined) ?? []),
      ...(((action.meta?.['needsProps'] as { any?: string[] } | undefined)?.any ?? []) as string[]),
    ]);
    if (props.size === 0) continue;
    const handlers = graph
      .successors(action.id, ['triggers'])
      .filter((node) => node.kind === 'handler');
    if (handlers.length === 0) continue;

    /** Each place it is drawn, with what it is given there. */
    const sites: Array<{
      rel: string;
      site: string;
      links: Array<{ to: string; kind: 'writes-state' | 'calls'; prop: string }>;
    }> = [];
    for (const file of loaded.sourceFiles) {
      if (!file.getFullText().includes(`<${owner}`)) continue;
      const rel = loaded.rel(file);
      const openings = [
        ...file.getDescendantsOfKind(SyntaxKind.JsxOpeningElement),
        ...file.getDescendantsOfKind(SyntaxKind.JsxSelfClosingElement),
      ].filter((opening) => opening.getTagNameNode().getText() === owner);
      const needs = action.meta?.['needsProps'] as { any: string[]; all: string[] } | undefined;
      for (const opening of openings) {
        const site = siteComponentName(opening);
        if (!site) continue;
        const siteId = ids.component(rel, site);
        if (!graph.hasNode(siteId)) continue;
        // `<TH>Batch</TH>` draws no sort button: not a place this action is.
        const passed = new Set(
          opening
            .getAttributes()
            .map((attr) => (Node.isJsxAttribute(attr) ? attr.getNameNode().getText() : '...')),
        );
        if (
          needs &&
          !passed.has('...') &&
          !(
            (needs.any.length === 0 || needs.any.some((prop) => passed.has(prop))) &&
            needs.all.every((prop) => passed.has(prop))
          )
        )
          continue;
        const links: Array<{ to: string; kind: 'writes-state' | 'calls'; prop: string }> = [];
        for (const prop of props) {
          const attr = opening.getAttribute(prop);
          const init = attr && Node.isJsxAttribute(attr) ? attr.getInitializer() : undefined;
          const value = init && Node.isJsxExpression(init) ? init.getExpression() : undefined;
          if (!value) continue;
          const names = Node.isIdentifier(value)
            ? [value.getText()]
            : value
                .getDescendantsOfKind(SyntaxKind.CallExpression)
                .map((call) => call.getExpression())
                .filter((callee) => Node.isIdentifier(callee))
                .map((callee) => callee.getText());
          for (const name of names) {
            const stateId = graph
              .successors(siteId, ['defines'])
              .find((node) => node.kind === 'state' && setterOfState(node) === name)?.id;
            const handlerId = ids.handler(rel, site, name);
            if (stateId && graph.hasNode(stateId))
              links.push({ to: stateId, kind: 'writes-state', prop });
            else if (graph.hasNode(handlerId)) links.push({ to: handlerId, kind: 'calls', prop });
          }
        }
        // A place that passes nothing followable still draws it: it keeps its copy.
        sites.push({ rel, site, links });
      }
    }
    if (sites.every((site) => site.links.length === 0)) continue;
    if (sites.length === 1) {
      for (const handler of handlers)
        for (const link of sites[0]!.links)
          graph.addEdge({
            from: handler.id,
            to: link.to,
            kind: link.kind,
            meta: { viaProp: link.prop },
          });
      // Drawn in one place: that place is still where it lives — a form inside a dialog.
      action.meta = { ...action.meta, site: sites[0]!.site };
      promoteInner(graph, action.id, sites[0]!.rel, sites[0]!.site, sites[0]!.links);
      continue;
    }

    /**
     * Drawn in several places, each giving it something else: each place is
     * its own action. One shared "Next" listed every page's request at once —
     * GET /medicines on the stock history page.
     */
    for (const { rel, site, links } of sites) {
      const place = screenOf(rel, site);
      const cloneId = `${action.id}@${rel}#${site}`;
      graph.addNode({
        id: cloneId,
        kind: 'ui-action',
        label: action.label,
        ...(action.source ? { source: action.source } : {}),
        meta: {
          ...action.meta,
          // Placed by where it is drawn, not where the component lives.
          siteFile: rel,
          screen: place.screen,
          title: composeTitle(place.screen, action.label),
          ...(place.page ? { page: place.page } : {}),
        },
      });
      for (const edge of graph.edgesTo(action.id)) graph.addEdge({ ...edge, to: cloneId });
      for (const handler of handlers) {
        const handlerClone = `${handler.id}@${rel}#${site}`;
        graph.addNode({
          id: handlerClone,
          kind: 'handler',
          label: handler.label,
          ...(handler.source ? { source: handler.source } : {}),
          ...(handler.meta ? { meta: handler.meta } : {}),
        });
        for (const edge of graph.edgesFrom(handler.id))
          graph.addEdge({ ...edge, from: handlerClone });
        for (const link of links)
          graph.addEdge({
            from: handlerClone,
            to: link.to,
            kind: link.kind,
            meta: { viaProp: link.prop },
          });
        graph.addEdge({ from: cloneId, to: handlerClone, kind: 'triggers' });
      }
      graph.node(cloneId)!.meta = { ...graph.node(cloneId)!.meta, site };
      promoteInner(graph, cloneId, rel, site, links);
    }
    graph.removeNode(action.id);
  }
}

/**
 * `<MedicineForm onSubmit={onSubmit} mode="edit">`: the form's own submit
 * button checks every field, then runs this page's `onSubmit` — the whole of
 * what pressing it does. That inner action is the one listed, under the name
 * this page gives it ("Update medicine"); the page's `onSubmit` event, only
 * the second half, is hidden behind it. A button that only passes the call
 * on — a tab calling `onChange` — stays hidden behind the named outer one.
 */
function promoteInner(
  graph: FlowGraph,
  innerId: string,
  rel: string,
  site: string,
  links: Array<{ to: string; kind: 'writes-state' | 'calls'; prop: string }>,
): void {
  const inner = graph.node(innerId);
  if (!inner) return;
  const outers = ((inner.meta?.['relayedBy'] as string[] | undefined) ?? [])
    .map((id) => graph.node(id))
    .filter((node): node is FlowNode => node !== undefined);
  // Only the outer events of this place: a copy for the edit page is not relayed by the add dialog.
  const here = outers.filter(
    (outer) => outer.source?.file === rel && outer.meta?.['component'] === site,
  );
  const handlers = graph.successors(innerId, ['triggers']);
  const ownWork = handlers.some((handler) =>
    graph
      .edgesFrom(handler.id)
      .some(
        (edge) =>
          edge.meta?.['viaProp'] === undefined &&
          (edge.kind === 'writes-state' || edge.kind === 'calls' || edge.kind === 'requests'),
      ),
  );
  const called = new Set(links.filter((link) => link.kind === 'calls').map((link) => link.to));
  const runs = here.filter((outer) =>
    graph.successors(outer.id, ['triggers']).some((handler) => called.has(handler.id)),
  );
  if (!ownWork) {
    inner.meta = { ...inner.meta, relayedBy: here.map((outer) => outer.id) };
    return;
  }
  // "Save update" checks, sends and only then calls `onClose`: more than the
  // page's close, so it is its own action, not a relay of that one.
  const { relayedBy: _relay, ...unrelayed } = inner.meta ?? {};
  if (runs.length === 0) {
    inner.meta = unrelayed;
    return;
  }
  const { relayedBy: _hidden, ...meta } = inner.meta ?? {};
  inner.label = runs[0]!.label;
  inner.meta = {
    ...meta,
    action: runs[0]!.label,
    ...(typeof meta['screen'] === 'string'
      ? { title: composeTitle(meta['screen'], runs[0]!.label) }
      : {}),
  };
  for (const outer of runs) outer.meta = { ...outer.meta, relayedBy: [innerId] };
}

/** The component an element is drawn in: the nearest capitalised function around it. */
function siteComponentName(node: Node): string | undefined {
  for (let current = node.getParent(); current; current = current.getParent()) {
    if (Node.isFunctionDeclaration(current)) {
      const name = current.getName();
      if (name && /^[A-Z]/.test(name)) return name;
    }
    if (Node.isArrowFunction(current) || Node.isFunctionExpression(current)) {
      const variable = current.getParent();
      if (Node.isVariableDeclaration(variable) && /^[A-Z]/.test(variable.getName()))
        return variable.getName();
    }
  }
  return undefined;
}

/**
 * A click that sets the page, a filter or the sort fetches the list again:
 * React Query (or SWR) refetches whenever a query's input changes. Nothing
 * calls the hook from the handler, so every such click read "No request".
 * Linked here from the handler writing a state to the query hook that reads it.
 */
function linkStateRefetches(graph: FlowGraph, loaded: LoadedProject): void {
  const files = new Map(loaded.sourceFiles.map((file) => [loaded.rel(file), file] as const));
  for (const component of graph.nodesOfKind('component')) {
    const states = new Map(
      graph
        .successors(component.id, ['defines'])
        .filter((node) => node.kind === 'state')
        .map((node) => [node.label, node.id] as const),
    );
    if (states.size === 0) continue;
    // `const debouncedSearch = useDebounce(search)`: the query reads the state
    // through a delay — it fetches once the typing has stopped for that long.
    const debounced = debouncedStates(files, component, states);
    for (const edge of graph.edgesFrom(component.id, ['calls'])) {
      const hook = graph.node(edge.to);
      if (hook?.kind !== 'hook' || hook.meta?.['fetchesOnMount'] !== true) continue;
      const reads = (edge.meta?.['reads'] as string[] | undefined) ?? [];
      const delays = new Map<string, number>();
      const watched = reads
        .map((name) => {
          const through = debounced.get(name);
          if (through) {
            delays.set(through.stateId, through.ms);
            return through.stateId;
          }
          return states.get(name);
        })
        .filter(Boolean) as string[];
      if (watched.length === 0) continue;
      for (const stateId of watched) {
        const state = graph.node(stateId)?.label ?? '';
        for (const writer of graph.edgesTo(stateId, ['writes-state'])) {
          const handler = graph.node(writer.from);
          if (handler?.kind !== 'handler') continue;
          if (switchesOff(files, component, edge.meta?.['line'], handler, state, hook)) continue;
          graph.addEdge({
            from: writer.from,
            to: hook.id,
            kind: 'calls',
            meta: {
              refetch: true,
              state: graph.node(stateId)?.label,
              ...(delays.has(stateId) ? { debounceMs: delays.get(stateId) } : {}),
            },
          });
        }
      }
    }
  }
}

/**
 * `const debouncedSearch = useDebounce(search, 300)` in a component: the
 * debounced name, the state it follows, and the delay — written at the call,
 * or the default the hook declares (`delay = 350`).
 */
function debouncedStates(
  files: Map<string, SourceFile>,
  component: FlowNode,
  states: Map<string, string>,
): Map<string, { stateId: string; ms: number }> {
  const found = new Map<string, { stateId: string; ms: number }>();
  const file = component.source ? files.get(component.source.file) : undefined;
  if (!file) return found;
  for (const call of file.getDescendantsOfKind(SyntaxKind.CallExpression)) {
    const name = call.getExpression().getText();
    if (!/^useDebounce(d(Value)?)?$/.test(name)) continue;
    const [value, delay] = call.getArguments();
    const holder = call.getParent();
    if (!value || !holder || !Node.isVariableDeclaration(holder)) continue;
    if (!Node.isIdentifier(holder.getNameNode())) continue;
    const stateId = states.get(value.getText());
    if (!stateId) continue;
    let ms = delay && Node.isNumericLiteral(delay) ? Number(delay.getText()) : undefined;
    if (ms === undefined) {
      // The default the hook declares, wherever it is written.
      for (const source of files.values()) {
        const declared = source.getFunction(name);
        const initial = declared?.getParameters()[1]?.getInitializer();
        if (initial && Node.isNumericLiteral(initial)) {
          ms = Number(initial.getText());
          break;
        }
      }
    }
    if (ms !== undefined) found.set(holder.getName(), { stateId, ms });
  }
  return found;
}

/**
 * `<MedicineForm onSubmit={create} />` has no words of its own: the user
 * presses the form's own "Save medicine" button, whose handler validates and
 * then calls `onSubmit`. That button names the action here — the form's
 * `mode === "create" ? "Save medicine" : "Update medicine"` decided by the
 * `mode` this page passes — and the inner action is marked as relayed, since
 * this one already runs it (with the request it leads to).
 */
function nameComponentEvents(graph: FlowGraph): void {
  const actions = graph.nodesOfKind('ui-action');
  for (const outer of actions) {
    const tag = outer.meta?.['tag'];
    const event = outer.meta?.['event'];
    const wordless = outer.meta?.['unlabelled'] || outer.meta?.['namedByHandler'];
    if (typeof tag !== 'string' || !/^[A-Z]/.test(tag)) continue;
    const callers = actions.filter(
      (candidate) =>
        candidate.meta?.['component'] === tag &&
        (candidate.meta?.['callsProps'] as string[] | undefined)?.includes(String(event)),
    );
    // `<Tabs onChange={…}>` already named ("Paid / Outstanding"): the tab button
    // inside that calls `onChange` is the same click, said once.
    if (!wordless) {
      for (const inner of callers)
        inner.meta = {
          ...inner.meta,
          relayedBy: [...((inner.meta?.['relayedBy'] as string[] | undefined) ?? []), outer.id],
        };
      continue;
    }
    const inner = callers.find((candidate) => !candidate.meta?.['unlabelled']);
    if (!inner) {
      // `<button onClick={onCancel}>Cancel</button>` inside it, passed straight through.
      const relayed = graph
        .nodesOfKind('component')
        .filter((component) => component.label === tag)
        .map(
          (component) =>
            (component.meta?.['relayLabels'] as Record<string, string> | undefined)?.[
              String(event)
            ],
        )
        .find(Boolean);
      if (relayed) rename(outer, relayed);
      continue;
    }
    const choice = inner.meta?.['labelByProp'] as
      { prop: string; value: string; whenTrue: string; whenFalse: string } | undefined;
    const site = (outer.meta?.['siteProps'] ?? {}) as Record<string, string>;
    const label =
      choice && choice.prop in site
        ? site[choice.prop] === choice.value
          ? choice.whenTrue
          : choice.whenFalse
        : inner.label;
    rename(outer, label);
    inner.meta = {
      ...inner.meta,
      relayedBy: [...((inner.meta?.['relayedBy'] as string[] | undefined) ?? []), outer.id],
    };
  }
}

/**
 * Two "Sign out" buttons in one component — one on its "No clinic access"
 * screen, one under "Choose a clinic" — read as the same row twice. Each is
 * named by the screen it is on: the heading of the `return` it is drawn in.
 */
function distinguishTwins(graph: FlowGraph, loaded: LoadedProject): void {
  const files = new Map(loaded.sourceFiles.map((file) => [loaded.rel(file), file] as const));
  const groups = new Map<string, FlowNode[]>();
  for (const action of graph.nodesOfKind('ui-action')) {
    if (action.meta?.['event'] === 'mount' || !action.source) continue;
    const key = `${String(action.meta?.['component'])}|${action.label}`;
    groups.set(key, [...(groups.get(key) ?? []), action]);
  }
  for (const twins of groups.values()) {
    if (twins.length < 2) continue;
    const contexts = twins.map((action) => {
      const file = files.get(action.source!.file);
      const attr = file
        ?.getDescendantsOfKind(SyntaxKind.JsxAttribute)
        .find(
          (candidate) =>
            candidate.getNameNode().getText() === action.meta?.['event'] &&
            candidate.getStartLineNumber() === action.source!.line,
        );
      const drawn = attr?.getFirstAncestorByKind(SyntaxKind.ReturnStatement);
      return drawn ? screenHeading(drawn) : undefined;
    });
    // Only when it tells them apart: each its own, and no two the same.
    if (contexts.some((context) => !context) || new Set(contexts).size !== contexts.length)
      continue;
    twins.forEach((action, index) => rename(action, `${action.label} — on "${contexts[index]}"`));
  }
}

/** The title a returned screen shows: its first heading, or its first line of bold words. */
function screenHeading(drawn: Node): string | undefined {
  const elements = drawn.getDescendantsOfKind(SyntaxKind.JsxElement);
  const heading = elements.find((element) =>
    /^(h[1-6]|legend|\w*Title)$/.test(element.getOpeningElement().getTagNameNode().getText()),
  );
  const strong = elements.find((element) =>
    /font-(semibold|bold)/.test(
      element.getOpeningElement().getAttribute('className')?.getText() ?? '',
    ),
  );
  for (const candidate of [heading, strong]) {
    const text = candidate ? directText(candidate) : '';
    if (text && text.length <= 40) return text;
  }
  return undefined;
}

function rename(action: FlowNode, label: string): void {
  action.label = label;
  const { unlabelled: _unlabelled, namedByHandler: _named, ...rest } = action.meta ?? {};
  action.meta = {
    ...rest,
    action: label,
    title: composeTitle(String(action.meta?.['screen'] ?? ''), label),
  };
}

/**
 * `setStep("map")` with the hook called as `useStatus(step === "processing" ?
 * jobId : null)`: the query's input becomes `null`, which is the hook's way of
 * not fetching. Only a literal the setter is given, compared with `===`, is
 * read; anything else may well fetch, and is linked.
 */
function switchesOff(
  files: Map<string, SourceFile>,
  component: FlowNode,
  callLine: unknown,
  handler: FlowNode,
  state: string,
  hook: FlowNode,
): boolean {
  const componentFile = component.source ? files.get(component.source.file) : undefined;
  const handlerFile = handler.source ? files.get(handler.source.file) : undefined;
  if (!componentFile || !handlerFile || typeof callLine !== 'number' || !handler.source)
    return false;
  const hookCall = componentFile
    .getDescendantsOfKind(SyntaxKind.CallExpression)
    .find(
      (call) =>
        call.getStartLineNumber() === callLine && /^use[A-Z]/.test(call.getExpression().getText()),
    );
  if (!hookCall) return false;
  // What the handler sets the state to: the arguments of its setter calls.
  const body = handlerFile
    .getDescendants()
    .find(
      (node) =>
        (Node.isArrowFunction(node) ||
          Node.isFunctionExpression(node) ||
          Node.isFunctionDeclaration(node) ||
          Node.isVariableDeclaration(node)) &&
        node.getStartLineNumber() === handler.source!.line,
    );
  const setter = `set${state.charAt(0).toUpperCase()}${state.slice(1)}`;
  const written = (body?.getDescendantsOfKind(SyntaxKind.CallExpression) ?? [])
    .filter((call) => call.getExpression().getText() === setter)
    .map((call) => call.getArguments()[0]);
  if (written.length === 0) return false;

  // `setJobId(null)` where `jobId` is what switches the query on.
  const param = hook.meta?.['enabledByParam'];
  const gated = typeof param === 'number' ? hookCall.getArguments()[param] : undefined;
  if (
    gated &&
    new RegExp(`\\b${state}\\b`).test(gated.getText()) &&
    written.every((arg) => arg !== undefined && EMPTY.test(arg.getText()))
  )
    return true;

  // `setStep("map")` against `step === "processing" ? jobId : null`.
  const gate = hookCall
    .getArguments()
    .find(
      (arg) => Node.isConditionalExpression(arg) && arg.getCondition().getText().includes(state),
    );
  if (!gate || !Node.isConditionalExpression(gate)) return false;
  const test = gate.getCondition();
  if (!Node.isBinaryExpression(test) || test.getOperatorToken().getText() !== '===') return false;
  const right = test.getRight();
  if (test.getLeft().getText() !== state || !Node.isStringLiteral(right)) return false;
  // Off only if every value it sets turns the query off.
  return written.every((arg) => {
    if (!arg || !Node.isStringLiteral(arg)) return false;
    const chosen =
      arg.getLiteralValue() === right.getLiteralValue() ? gate.getWhenTrue() : gate.getWhenFalse();
    return EMPTY.test(chosen.getText());
  });
}

/**
 * What a component event needs to be named and joined up: the element's tag,
 * the literal props it is given (`mode="create"`), the props its handler calls
 * (`handleSubmit` calls `onSubmit`), and a submit button whose words depend on
 * a prop.
 */
function componentEventMeta(
  attribute: JsxAttribute,
  props: Map<string, string>,
  declared: Array<{ name: string; node: Node }>,
): Record<string, unknown> {
  const element = attribute.getFirstAncestor(
    (node) => Node.isJsxOpeningElement(node) || Node.isJsxSelfClosingElement(node),
  );
  if (!element || (!Node.isJsxOpeningElement(element) && !Node.isJsxSelfClosingElement(element)))
    return {};
  const tag = element.getTagNameNode().getText();
  const meta: Record<string, unknown> = { tag };
  // `<Link href={item.href} onClick={onNavigate}>`: the click also goes to a page.
  const links = linkTargets(element);
  if (links.length) meta['linksTo'] = links;
  if (/^[A-Z]/.test(tag)) {
    const site: Record<string, string> = {};
    for (const attr of element.getAttributes()) {
      if (!Node.isJsxAttribute(attr)) continue;
      const init = attr.getInitializer();
      if (init && Node.isStringLiteral(init))
        site[attr.getNameNode().getText()] = init.getLiteralValue();
    }
    if (Object.keys(site).length) meta['siteProps'] = site;
  }
  if (props.size === 0) return meta;
  // The handler, or the local function it names, calling one of the props.
  const init = attribute.getInitializer();
  const handler = init && Node.isJsxExpression(init) ? init.getExpression() : undefined;
  const bodies: Node[] = handler ? [handler] : [];
  // The local function it names — directly, or handed to a wrapper: `handleSubmit(onSubmit)`.
  const named = handler
    ? [handler, ...handler.getDescendantsOfKind(SyntaxKind.Identifier)].filter((node) =>
        Node.isIdentifier(node),
      )
    : [];
  for (const name of named) {
    const local = declared.find((candidate) => candidate.name === name.getText());
    if (local && !bodies.includes(local.node)) bodies.push(local.node);
  }
  const called = new Set<string>();
  for (const body of bodies) {
    for (const call of body.getDescendantsOfKind(SyntaxKind.CallExpression)) {
      const prop = props.get(call.getExpression().getText());
      // Any prop the click calls is a callback — `onSave`, or `action(data)`; a render prop is not.
      if (prop && !/^render([A-Z]|$)/.test(prop)) called.add(prop);
    }
  }
  if (called.size) meta['callsProps'] = [...called];
  // `{mode === "create" ? "Save medicine" : "Update medicine"}` on its submit button.
  if (tag === 'form' && attribute.getNameNode().getText() === 'onSubmit') {
    const form = element.getParent();
    for (const conditional of form?.getDescendantsOfKind(SyntaxKind.ConditionalExpression) ?? []) {
      if (!Node.isJsxExpression(conditional.getParent())) continue;
      // The submit button's own words, not a section title switched the same way.
      const button = conditional.getFirstAncestorByKind(SyntaxKind.JsxElement)?.getOpeningElement();
      const type = button?.getAttribute('type');
      const typeValue =
        type && Node.isJsxAttribute(type) ? type.getInitializer()?.getText() : undefined;
      if (typeValue !== '"submit"' && typeValue !== "'submit'") continue;
      const test = conditional.getCondition();
      const yes = conditional.getWhenTrue();
      const no = conditional.getWhenFalse();
      if (!Node.isBinaryExpression(test) || !/^===?$/.test(test.getOperatorToken().getText()))
        continue;
      const prop = props.get(test.getLeft().getText());
      const value = test.getRight();
      if (
        !prop ||
        !Node.isStringLiteral(value) ||
        !Node.isStringLiteral(yes) ||
        !Node.isStringLiteral(no)
      )
        continue;
      meta['labelByProp'] = {
        prop,
        value: value.getLiteralValue(),
        whenTrue: yes.getLiteralValue(),
        whenFalse: no.getLiteralValue(),
      };
      break;
    }
  }
  return meta;
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
  contexts: ContextIndex,
  actionProps: ActionProps,
): void {
  /** Names declared in this file -> node id. Local wins over global. */
  const locals = new Map<string, DeclaredSymbol>();
  /** `useMutation(...)` calls written in a component, as hooks of their own. */
  const inlineHooks = new Map<Node, DeclaredSymbol>();

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
        /**
         * Hooks carry after-effects too, and in practice more often than
         * handlers do: `useMutation({ onSuccess: () => invalidateQueries(…) })`
         * inside a custom hook is where a React Query app keeps its cache
         * invalidation, and reading only handlers missed every one of them.
         */
        meta: {
          ...(fetchesOnMount(fn) ? { fetchesOnMount: true } : {}),
          ...enabledBy(fn),
          ...queryKeyOf(fn),
          ...aftermathMeta(fn),
        },
      });
      declare(name, { id, kind: 'hook', file: rel, ensure: noop });
      const context = contextRead(fn);
      if (context) contexts.hooks.set(name, context);
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
      analyzeComponentBody(fn, id, name, rel, graph, declare, actionProps);
      continue;
    }

    /**
     * Any other top-level function.
     *
     * This is the service-layer shape: `export async function fetchCustomers()`
     * in `src/api/customers.ts`, called from a component's handler. Without it,
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
    let hookName = calleeName(initializer);
    if (hookName.includes('.') || !HOOK_NAME.test(hookName)) continue;
    /**
     * `const remove = useMutation({ mutationFn, onSuccess })` written in the
     * component: a hook of its own, named for the variable. What its options
     * call — the request, the toast, the invalidation — is its; a click on
     * `remove.mutate()` runs it. Without this, the click reached nothing.
     */
    const inline = inlineLibraryHook(initializer, declaration, rel, graph);
    if (inline) {
      hookName = inline.name;
      inlineHooks.set(initializer, inline.symbol);
      declare(inline.name, inline.symbol);
      if (inline.fetches && inline.componentId)
        graph.addEdge({
          from: inline.componentId,
          to: inline.symbol.id,
          kind: 'calls',
          meta: { line: lineOf(initializer), end: initializer.getEnd() },
        });
    }

    const nameNode = declaration.getNameNode();
    if (Node.isObjectBindingPattern(nameNode)) {
      for (const element of nameNode.getElements()) {
        const member = element.getPropertyNameNode()?.getText() ?? element.getName();
        aliases.push({ file: rel, localName: element.getName(), hookName, member });
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

  // ---- 3b. What a context provider hands out ------------------------------
  for (const [context, members] of providedMembers(file)) {
    for (const [member, { component, local }] of members) {
      contexts.members.set(`${context}::${member}`, ids.handler(rel, component, local));
    }
  }

  // ---- 4. HTTP calls and code calls --------------------------------------
  for (const call of callsIn(file)) {
    const owner = inlineHookOf(call, inlineHooks) ?? ownerOf(call, rel, locals, graph);
    const request = readHttpCall(call, config);
    if (request) {
      // Still an HTTP call, so never fall through to code-call handling —
      // but only a nameable endpoint earns a node.
      if (isConcreteEndpoint(request)) {
        // An owner that makes a request is real, whatever kind it is.
        owner?.ensure();
        linkApiCall(graph, owner?.id, request, rel, call);
      }
      // `url: relative ? archiveRelative(p, r) : archivePatient(p)`: the other side is a request too.
      const other = otherSidePath(call, config);
      if (other && other !== request.rawPath) {
        const second = buildRequest(request.method, other, undefined, config, request.client);
        if (isConcreteEndpoint(second)) {
          owner?.ensure();
          linkApiCall(
            graph,
            owner?.id,
            { ...second, payloadKeys: request.payloadKeys, payloadSources: request.payloadSources },
            rel,
            call,
          );
        }
      }
      continue;
    }
    // Bare identifier calls only: `foo()`, never `foo.bar()`. Resolution
    // happens later, once every file has declared what it exports.
    const callee = calleeName(call);
    if (!callee.includes('.') && owner) {
      pending.push({ from: owner, name: callee, file: rel, ...callPlacement(call) });
      continue;
    }

    /**
     * `adjust.mutate(input)` — a method on an object a hook handed back.
     *
     * React Query's idiom is `const adjust = useAdjustStock()` followed by
     * `adjust.mutate(...)`, and the destructured form
     * (`const { mutate } = ...`) is only half of real usage. Recording just the
     * bare-identifier form left the request unreachable from the click: in a
     * Next.js app built this way, 3 of 121 actions reached the backend.
     *
     * Only the receiver is recorded, and it is resolved solely through the
     * alias table, so a receiver that is not a hook result links to nothing.
     */
    if (owner && callee.includes('.')) {
      const receiver = callee.split('.')[0];
      if (receiver && /^[A-Za-z_$][\w$]*$/.test(receiver)) {
        pending.push({
          from: owner,
          name: receiver,
          file: rel,
          receiverOnly: true,
          // `data.map(…)`, `adjust.mutate(…)`: where and when, but these are not
          // the hook's own arguments.
          ...withoutArguments(callPlacement(call)),
        });
      }
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
  actionProps: ActionProps,
): void {
  // useState / useReducer
  for (const declaration of fn.getDescendantsOfKind(SyntaxKind.VariableDeclaration)) {
    const initializer = declaration.getInitializer();
    if (!initializer || !Node.isCallExpression(initializer)) continue;
    const hook = calleeMember(initializer);
    if (!STATE_HOOKS.has(hook)) continue;
    // The setter as written: `[openBillingPopup, setOpenBIllingPopup]` pairs by
    // position, whatever the spelling — React does not read the names.
    const pair = declaration.getNameNode();
    const second = Node.isArrayBindingPattern(pair) ? pair.getElements()[1] : undefined;
    const setter = second && Node.isBindingElement(second) ? second.getName() : undefined;
    for (const stateName of stateNamesOf(declaration)) {
      const id = ids.state(componentId, stateName);
      graph.addNode({
        id,
        kind: 'state',
        label: stateName,
        source: { file: rel, line: lineOf(declaration) },
        meta: { hook, component: componentName, ...(setter ? { setter } : {}) },
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
    const initializer = callbackOf(declaration.getInitializer());
    if (!initializer) continue;
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
    // A nested component, not a function of this one — if it draws anything.
    // `const Discard = () => { setOpen(false); save() }` is a handler with a
    // capital letter; skipped, its calls were charged to the page as it loads.
    if (COMPONENT_NAME.test(name) && containsJsx(initializer)) continue;
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
        /**
         * The second half of the round trip: where the screen goes next, what
         * it invalidates, and what the user sees when it fails.
         */
        ...aftermathMeta(initializer),
      },
    });
    graph.addEdge({ from: componentId, to: id, kind: 'defines' });
    declare(name, { id, kind: 'handler', file: rel, ensure: noop });
    linkStateReads(initializer, id, componentId, graph);
  }

  // JSX elements the user can interact with
  const props = componentProps(fn);
  for (const attribute of fn.getDescendantsOfKind(SyntaxKind.JsxAttribute)) {
    const propName = attribute.getNameNode().getText();
    if (!actionProps.all.has(propName)) continue;
    const eventClass = actionProps.gestures.has(propName) ? 'gesture' : 'input';
    const needs = propsNeeded(attribute, fn, props);
    /**
     * `<button onClick={onClick}>` inside `IconBtn`: the click is whatever the
     * page passed as `onClick`, and `<IconBtn onClick={…}>` on that page is
     * already its own action. Recorded here too, it was a second, wordless
     * "button onClick" beside every real one.
     */
    if (needs?.relay && actionProps.all.has(needs.relay)) {
      // Its words still name the page's `<MedicineForm onCancel>`: "Cancel".
      const words = actionLabel(attribute, propName, undefined, componentName);
      const component = graph.node(componentId);
      if (component && !UNLABELLED.test(words))
        component.meta = {
          ...component.meta,
          relayLabels: {
            ...(component.meta?.['relayLabels'] as Record<string, string> | undefined),
            [needs.relay]: words,
          },
        };
      continue;
    }
    // `onMouseDown={(e) => e.preventDefault()}` keeps focus; the user does nothing.
    if (onlyStopsDefault(attribute)) continue;

    // Resolve the handler first: its name is the best label for the very common
    // case of an icon or wrapper element with no text of its own.
    const handlerId = resolveActionHandler(attribute, componentId, componentName, rel, graph);
    const handlerName = handlerId ? graph.node(handlerId)?.meta?.['function'] : undefined;
    const label = actionLabel(
      attribute,
      propName,
      typeof handlerName === 'string' ? handlerName : undefined,
      componentName,
    );

    /**
     * "Submit" alone identifies nothing in an app with fifteen of them, so the
     * node also carries where it lives — `Order · Submit`. `label` stays
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
    const phrase = wordless
      ? `${componentPhrase(componentName, place.screen)} ${eventVerb(propName)}`
      : label;
    // Two "Back" buttons on two steps of one dialog are two actions, not one.
    let actionId = ids.uiAction(componentId, `${propName}-${label}`);
    const twin = graph.node(actionId);
    if (twin && twin.source?.line !== lineOf(attribute))
      actionId = ids.uiAction(componentId, `${propName}-${label}@${lineOf(attribute)}`);
    graph.addNode({
      id: actionId,
      kind: 'ui-action',
      label,
      source: { file: rel, line: lineOf(attribute) },
      meta: {
        event: propName,
        eventClass,
        component: componentName,
        ...(wordless ? { unlabelled: true } : { action: label }),
        screen: place.screen,
        title: composeTitle(place.screen, phrase),
        ...(place.page ? { page: place.page } : {}),
        ...(place.area ? { area: place.area } : {}),
        // Only where the component is given these does the element do anything.
        ...(needs ? { needsProps: { any: needs.any, all: needs.all } } : {}),
        ...componentEventMeta(attribute, props, declaredFunctions),
        // Named after the handler, not words on screen: a component's own
        // button names it better.
        ...(typeof handlerName === 'string' && label === humanizeHandler(handlerName)
          ? { namedByHandler: true }
          : {}),
      },
    });
    graph.addEdge({ from: componentId, to: actionId, kind: 'renders' });

    if (handlerId) {
      graph.addEdge({ from: actionId, to: handlerId, kind: 'triggers' });
    }
  }
}

/** A component's props, local name -> prop name: `{ onClick: open }` -> open: onClick. */
function componentProps(fn: Functionish): Map<string, string> {
  const props = new Map<string, string>();
  const param = fn.getParameters()[0];
  const binding = param?.getNameNode();
  if (binding && Node.isObjectBindingPattern(binding)) {
    for (const element of binding.getElements()) {
      if (element.getDotDotDotToken()) continue;
      props.set(element.getName(), element.getPropertyNameNode()?.getText() ?? element.getName());
    }
  } else if (binding && Node.isIdentifier(binding)) {
    // `props.onSort`
    for (const access of fn.getDescendantsOfKind(SyntaxKind.PropertyAccessExpression)) {
      if (access.getExpression().getText() === binding.getText())
        props.set(access.getText(), access.getName());
    }
  }
  return props;
}

/**
 * The props an element's handler needs from whoever renders the component:
 * the ones its handler calls (`any`: one is enough to wire it), and the ones
 * guarding it (`all`: `{sortable ? <button onClick={onSort}> : …}`). `relay`
 * when the handler is nothing but one prop, passed straight through.
 */
function propsNeeded(
  attribute: JsxAttribute,
  fn: Functionish,
  props: Map<string, string>,
): { any: string[]; all: string[]; relay?: string } | undefined {
  if (props.size === 0) return undefined;
  const init = attribute.getInitializer();
  const handler = init && Node.isJsxExpression(init) ? init.getExpression() : undefined;
  if (!handler) return undefined;
  const mentioned = (node: Node): string[] => {
    const found = new Set<string>();
    const texts = [
      node,
      ...node.getDescendantsOfKind(SyntaxKind.Identifier),
      ...node.getDescendantsOfKind(SyntaxKind.PropertyAccessExpression),
    ].map((part) => part.getText());
    for (const text of texts) {
      const prop = props.get(text);
      if (prop) found.add(prop);
    }
    return [...found];
  };
  const any = mentioned(handler).filter((prop) => /^on[A-Z]/.test(prop));
  // `onClick={onSort}`, `onClick={() => onSort()}`, `onClick={() => onSort?.()}`
  let body: Node = handler;
  if (Node.isArrowFunction(body) && body.getParameters().length === 0) body = body.getBody();
  const called =
    Node.isCallExpression(body) && body.getArguments().length === 0 ? body.getExpression() : body;
  const relay = props.get(called.getText().replace(/\?\.$/, '')) ?? props.get(called.getText());
  const all = new Set<string>();
  for (
    let node: Node | undefined = attribute.getParent();
    node && node !== fn;
    node = node.getParent()
  ) {
    const parent = node.getParent();
    if (Node.isConditionalExpression(parent) && parent.getWhenTrue() === node)
      for (const prop of mentioned(parent.getCondition())) all.add(prop);
    if (
      Node.isBinaryExpression(parent) &&
      parent.getOperatorToken().getKind() === SyntaxKind.AmpersandAmpersandToken &&
      parent.getRight() === node
    )
      for (const prop of mentioned(parent.getLeft())) all.add(prop);
  }
  if (any.length === 0 && all.size === 0) return undefined;
  return {
    any,
    all: [...all],
    ...(relay && relay === any[0] && any.length === 1 ? { relay } : {}),
  };
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
  const setterOf = new Map(stateNodes.map((node) => [setterOfState(node), node] as const));

  // What it sets each state to, when written out: `setTab("excels")`. Keyed by
  // the conventional setter name, whatever the code spells it.

  const sets: Record<string, string[]> = {};
  for (const call of fn.getDescendantsOfKind(SyntaxKind.CallExpression)) {
    const setter = call.getExpression().getText();
    if (!setterOf.has(setter)) continue;
    const arg = call.getArguments()[0];
    const value =
      arg && (Node.isStringLiteral(arg) || Node.isNoSubstitutionTemplateLiteral(arg))
        ? arg.getLiteralValue()
        : arg && /^(true|false|null|undefined|0)$/.test(arg.getText())
          ? `#${arg.getText()}`
          : '*';
    (sets[setterName(setterOf.get(setter)!.label)] ??= []).push(value);
  }
  if (Object.keys(sets).length) {
    const handler = graph.node(handlerId);
    if (handler) handler.meta = { ...handler.meta, sets };
  }

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

/** A state node's setter as the code names it. */
function setterOfState(node: FlowNode): string {
  const written = node.meta?.['setter'];
  return typeof written === 'string' ? written : setterName(node.label);
}

/**
 * Label a user action the way the user would describe it.
 * Text child first ("Submit Order"), then labelling props, then the tag.
 */
/** The words written just before a control, in the element around it: its unlabelled caption. */
function textBeside(element: Node): string | undefined {
  const own = Node.isJsxSelfClosingElement(element) ? element : element.getParent();
  const parent = own?.getParent();
  if (!own || !parent || !Node.isJsxElement(parent)) return undefined;
  const siblings = parent.getJsxChildren();
  for (let index = siblings.indexOf(own as never) - 1; index >= 0; index--) {
    const sibling = siblings[index]!;
    if (!Node.isJsxElement(sibling)) continue;
    // A caption, not another control's words: `<button>Help</button>` names the button.
    if (
      /^(button|a|Link|Button)$/.test(sibling.getOpeningElement().getTagNameNode().getText()) ||
      sibling
        .getDescendantsOfKind(SyntaxKind.JsxAttribute)
        .some((attr) => /^on[A-Z]/.test(attr.getNameNode().getText()))
    )
      continue;
    const text =
      sibling
        .getDescendantsOfKind(SyntaxKind.JsxText)
        .map((piece) => piece.getText().replace(/\s+/g, ' ').trim())
        .find((piece) => piece.length > 1) ?? '';
    if (text && text.length <= 40) return text;
  }
  return undefined;
}

/** The label of the field wrapping a control: `<FormField label="…">` or `<label>…</label>`. */
function fieldLabelAround(element: Node): string | undefined {
  let current: Node | undefined = element.getParent();
  for (let depth = 0; current && depth < 4; current = current.getParent()) {
    if (Node.isArrowFunction(current) || Node.isFunctionDeclaration(current)) return undefined;
    if (!Node.isJsxElement(current)) continue;
    depth += 1;
    const opening = current.getOpeningElement();
    if (opening.getTagNameNode().getText() === 'label') {
      const text = directText(current);
      if (text) return text;
    }
    const label = opening.getAttribute('label');
    const value = label && Node.isJsxAttribute(label) ? label.getInitializer() : undefined;
    if (value && Node.isStringLiteral(value)) return value.getLiteralValue();
  }
  return undefined;
}

function actionLabel(
  attribute: JsxAttribute,
  propName: string,
  handlerName?: string,
  componentName?: string,
): string {
  const label = elementLabel(attribute, propName, handlerName, componentName);
  // The same box is clicked to pick a file and dropped on: two actions, two names.
  return propName === 'onDrop' && !/^drop/i.test(label) ? `Drop a file on "${label}"` : label;
}

function elementLabel(
  attribute: JsxAttribute,
  propName: string,
  handlerName?: string,
  componentName?: string,
): string {
  const element = attribute.getFirstAncestor(
    (node) => Node.isJsxOpeningElement(node) || Node.isJsxSelfClosingElement(node),
  );
  if (!element) return propName;

  const tag =
    Node.isJsxOpeningElement(element) || Node.isJsxSelfClosingElement(element)
      ? element.getTagNameNode().getText()
      : 'element';
  const stringProp = (name: string): string | undefined => {
    if (!Node.isJsxOpeningElement(element) && !Node.isJsxSelfClosingElement(element)) return;
    const init = element.getAttribute(name);
    const value = init && Node.isJsxAttribute(init) ? init.getInitializer() : undefined;
    return value && Node.isStringLiteral(value) ? value.getLiteralValue() : undefined;
  };

  /**
   * `<Dialog title="Import inventory" onClose={…}>` is closing that dialog,
   * not "Import inventory"; `<AddMedicineDialog onClose={…}>` is "Close add
   * medicine dialog", not "View close (line 373)".
   */
  if (/^on(Close|Dismiss|Hide)$/.test(propName) && /^[A-Z]/.test(tag)) {
    const what = stringProp('title') ?? stringProp('aria-label') ?? stringProp('label');
    return `Close ${what ? `"${what}"` : humanizeName(tag).toLowerCase()}`;
  }
  // `<input type="file" onChange={…}>`: what the user does with it.
  if (tag === 'input' && stringProp('type') === 'file') return 'Choose a file';
  // `<div role="option" onClick={() => choose(o)}>`: one row of a dropdown.
  if (stringProp('role') === 'option') return 'Pick an option';
  if (stringProp('aria-haspopup') === 'listbox') return 'Open the list';
  // `<button aria-haspopup="menu">` with only an avatar and a name in it.
  if (stringProp('aria-haspopup') && componentName)
    return `Open ${humanizeName(componentName).toLowerCase()}`;
  // `<div className="fixed inset-0" onClick={close} />`: the dimmed page behind a panel.
  if (Node.isJsxSelfClosingElement(element) && /^(div|span)$/.test(tag) && propName === 'onClick')
    return 'Click outside to close';

  // `<Tabs tabs={tabList} onChange={…}>` with `tabList = [{ label: "Paid" }, …]`.
  const listed = listProp(element);
  if (listed) return listed;

  // A row of a list with only its data in it — a patient's name and age, a
  // page number: what the click does names it ("Select patient", "Go to page").
  const inList = element.getFirstAncestor(
    (node) => Node.isCallExpression(node) && /\.map$/.test(node.getExpression().getText()),
  );
  const said = singleCallName(attribute);
  if (
    inList &&
    said &&
    /^(Select |Go to page$)/.test(said) &&
    !(Node.isJsxOpeningElement(element) && directText(element.getParent()!))
  )
    return said;

  if (Node.isJsxOpeningElement(element)) {
    const parent = element.getParent();
    if (Node.isJsxElement(parent)) {
      const text = directText(parent);
      if (text && !isFragment(text)) return text;
      // `{ACTIONS.map((a) => <button>{a.label}</button>)}`: the list says the words.
      const listed = labelsFromList(parent);
      if (listed) return listed;

      // `<form onSubmit={...}>` has no text of its own — the user identifies it
      // by its submit button ("Create Customer"), so borrow that label.
      if (propName === 'onSubmit') {
        const buttonText = submitButtonText(parent);
        if (buttonText) return buttonText;
      }
    }
  }

  const attributes =
    Node.isJsxOpeningElement(element) || Node.isJsxSelfClosingElement(element)
      ? element.getAttributes()
      : [];
  const fromProps = (names: string[]): string | undefined => {
    for (const candidate of attributes) {
      if (!Node.isJsxAttribute(candidate)) continue;
      if (!names.includes(candidate.getNameNode().getText())) continue;
      const initializer = candidate.getInitializer();
      const value =
        initializer && Node.isStringLiteral(initializer)
          ? initializer.getLiteralValue()
          : undefined;
      if (value) return value;
    }
    return undefined;
  };
  const own = fromProps(LABEL_PROPS.filter((name) => !/^(placeholder|data-testid)$/.test(name)));
  if (own) return own;
  // `<FormField label="Medicine name"><Input placeholder="Paracetamol 500mg" …/>`:
  // the field's label names it; the placeholder is an example value.
  if (/^on(Change|Input)$/.test(propName)) {
    const wrapper = fieldLabelAround(element);
    if (wrapper) return wrapper;
  }
  const fallback = fromProps(['placeholder', 'data-testid']);
  if (fallback) return fallback;
  if (/^on(Change|Input)$/.test(propName)) {
    // `<p>Column in your file</p> … <Select onChange={…} />` in each row of a list.
    const beside = textBeside(element);
    if (beside) {
      const inRows = element.getFirstAncestor(
        (node) => Node.isCallExpression(node) && /\.map$/.test(node.getExpression().getText()),
      );
      return inRows ? `${beside} (each row)` : beside;
    }
  }

  /**
   * Text from a small subtree: `<div onClick={...}><p>Preview</p></div>`.
   *
   * Bounded by size, because the same pattern wraps whole cards and sections —
   * and "Preview" is a label while the first paragraph of a customer record is
   * not.
   */
  if (Node.isJsxOpeningElement(element)) {
    const parent = element.getParent();
    if (
      Node.isJsxElement(parent) &&
      parent.getDescendantsOfKind(SyntaxKind.JsxElement).length <= 6
    ) {
      const nested = nestedText(parent);
      if (nested && !isFragment(nested)) return nested.slice(0, 40);
    }
  }

  // `<Select value={category} onChange={…}>`: the field is named by what it holds.
  const bound =
    Node.isJsxOpeningElement(element) || Node.isJsxSelfClosingElement(element)
      ? (element.getAttribute('value') ?? element.getAttribute('checked'))
      : undefined;
  const boundTo = bound && Node.isJsxAttribute(bound) ? bound.getInitializer() : undefined;
  const held = boundTo && Node.isJsxExpression(boundTo) ? boundTo.getExpression() : undefined;
  if (held && (Node.isIdentifier(held) || Node.isPropertyAccessExpression(held)))
    return humanizeName(held.getText().split('.').pop()!).replace(/^./, (c) => c.toUpperCase());

  // Icon buttons have no text at all, but their handler is named for the job.
  if (handlerName) {
    const humanized = humanizeHandler(handlerName);
    if (humanized) return humanized;
  }

  // `onMouseDown={() => { if (!open) openMenu(); }}`: what it opens says it.
  const opened = opensOrCloses(attribute);
  if (opened) return opened;

  // A row in a list under "Switch clinic": the heading says what picking it does.
  // Only for a plain element the user clicks: a component's event is named by
  // what the component does, and a field by its own label.
  const heading = /^[a-z]/.test(tag) && propName === 'onClick' ? headingAbove(element) : undefined;
  if (heading) return heading;

  // A trash icon with `onClick={() => remove(index)}`: "Remove". Plain elements
  // only: a component's event is named by the component, after the scan.
  if (said && /^[a-z]/.test(tag)) return said;

  return `${tag} ${propName}`;
}

/**
 * `{a.label}` inside `ACTIONS.map((a) => …)`, with `ACTIONS` a literal list in
 * the file: "Increase / Decrease / Set to".
 */
/**
 * Where a link element goes: `href="/stock"`, or each `href` of the constant
 * list it is mapped from — `NAV.map((item) => <Link href={item.href}>)`.
 */
function linkTargets(element: JsxOpeningElement | JsxSelfClosingElement): string[] {
  if (!/^(a|Link|NavLink|NextLink)$/.test(element.getTagNameNode().getText())) return [];
  const attr = element.getAttribute('href') ?? element.getAttribute('to');
  const init = attr && Node.isJsxAttribute(attr) ? attr.getInitializer() : undefined;
  if (init && Node.isStringLiteral(init)) return [init.getLiteralValue()];
  const value = init && Node.isJsxExpression(init) ? init.getExpression() : undefined;
  if (!value || !Node.isPropertyAccessExpression(value)) return [];
  const item = value.getExpression().getText();
  const map = element.getFirstAncestor(
    (node: Node) =>
      Node.isCallExpression(node) &&
      /\.map$/.test(node.getExpression().getText()) &&
      (node.getArguments()[0] as Node | undefined)?.getText().startsWith(`(${item}`) === true,
  );
  const callee = map && Node.isCallExpression(map) ? map.getExpression() : undefined;
  if (!callee || !Node.isPropertyAccessExpression(callee)) return [];
  const list = element
    .getSourceFile()
    .getVariableDeclaration(callee.getExpression().getText())
    ?.getInitializer();
  if (!list || !Node.isArrayLiteralExpression(list)) return [];
  return list.getElements().flatMap((entry) => {
    const property = Node.isObjectLiteralExpression(entry)
      ? entry.getProperty(value.getName())
      : undefined;
    const target =
      property && Node.isPropertyAssignment(property) ? property.getInitializer() : undefined;
    return target && Node.isStringLiteral(target) ? [target.getLiteralValue()] : [];
  });
}

function labelsFromList(element: JsxElement): string | undefined {
  for (const child of element.getJsxChildren()) {
    if (!Node.isJsxExpression(child)) continue;
    const value = child.getExpression();
    if (!value || !Node.isPropertyAccessExpression(value)) continue;
    const item = value.getExpression().getText();
    const map = element.getFirstAncestor(
      (node) =>
        Node.isCallExpression(node) &&
        /\.map$/.test(node.getExpression().getText()) &&
        (node.getArguments()[0] as Node | undefined)?.getText().startsWith(`(${item}`) === true,
    );
    if (!map || !Node.isCallExpression(map)) continue;
    const callee = map.getExpression();
    if (!Node.isPropertyAccessExpression(callee)) continue;
    const list = element
      .getSourceFile()
      .getVariableDeclaration(callee.getExpression().getText())
      ?.getInitializer();
    if (!list || !Node.isArrayLiteralExpression(list)) continue;
    const words = list
      .getElements()
      .map((entry) =>
        Node.isObjectLiteralExpression(entry) ? entry.getProperty(value.getName()) : undefined,
      )
      .map((property) =>
        property && Node.isPropertyAssignment(property) ? property.getInitializer() : undefined,
      )
      .map((init) => (init && Node.isStringLiteral(init) ? init.getLiteralValue() : undefined));
    if (words.length > 0 && words.every(Boolean)) return words.join(' / ');
  }
  return undefined;
}

/** "as", "of", "&": text with no word a person would read as the button's name. */
function isFragment(text: string): boolean {
  const words = text.toLowerCase().match(/[a-z0-9]+/g) ?? [];
  return !words.some(
    (word) =>
      (word.length > 2 || /^\d+$/.test(word)) &&
      !/^(and|the|for|you|are|was|not|but|via|per)$/.test(word),
  );
}

/**
 * The text just before the element's container — `<p>Switch clinic</p>` above
 * a list of clinic buttons — a few levels out, never past the component.
 */
function headingAbove(element: Node): string | undefined {
  let node: Node | undefined = element.getParent();
  // Through `{items.map((item) => (…))}`: a paren, an arrow, a call, an expression.
  for (let depth = 0; node && depth < 8; depth++, node = node.getParent()) {
    if (Node.isFunctionDeclaration(node)) break;
    const parent = node.getParent();
    if (!parent || !Node.isJsxElement(parent)) continue;
    const siblings = parent.getJsxChildren();
    const index = siblings.findIndex((sibling) => sibling === node);
    for (let i = index - 1; i >= 0; i--) {
      const sibling = siblings[i]!;
      if (!Node.isJsxElement(sibling)) continue;
      // Its own words, or the heading inside it: `<div><h1>Choose a clinic</h1>…`.
      const heading = sibling
        .getDescendantsOfKind(SyntaxKind.JsxElement)
        .find((inner) =>
          /^(h[1-6]|legend|CardTitle|DialogTitle)$/.test(
            inner.getOpeningElement().getTagNameNode().getText(),
          ),
        );
      for (const candidate of [directText(sibling), heading ? directText(heading) : '']) {
        if (candidate && !isFragment(candidate) && candidate.length <= 40) return candidate;
      }
    }
  }
  return undefined;
}

/**
 * An inline handler that makes one call, said as an action: `setSelectedPatient(p)`
 * -> "Select patient", `setPage(p)` -> "Go to page", `remove(index)` -> "Remove".
 */
function singleCallName(attribute: JsxAttribute): string | undefined {
  const init = attribute.getInitializer();
  const handler = init && Node.isJsxExpression(init) ? init.getExpression() : undefined;
  if (!handler || (!Node.isArrowFunction(handler) && !Node.isFunctionExpression(handler)))
    return undefined;
  const calls = handler
    .getDescendantsOfKind(SyntaxKind.CallExpression)
    .filter((call) => !/\.(preventDefault|stopPropagation)$/.test(call.getExpression().getText()));
  if (calls.length !== 1) return undefined;
  const callee = calls[0]!.getExpression();
  if (!Node.isIdentifier(callee)) return undefined;
  const name = callee.getText();
  const selected = /^setSelected([A-Z]\w*)$/.exec(name);
  if (selected) return `Select ${humanizeName(selected[1]!).toLowerCase()}`;
  if (/^set(Page|CurrentPage|PageNumber)$/.test(name)) return 'Go to page';
  const set = /^set([A-Z]\w*)$/.exec(name);
  if (set) return `Choose ${humanizeName(set[1]!).toLowerCase()}`;
  return humanizeHandler(name);
}

/** `tabs={tabList}` / `options={…}` naming a literal list of `{ label }`: "Paid / Outstanding". */
function listProp(element: Node): string | undefined {
  if (!Node.isJsxOpeningElement(element) && !Node.isJsxSelfClosingElement(element))
    return undefined;
  for (const name of ['tabs', 'items', 'options', 'tabList']) {
    const attr = element.getAttribute(name);
    const init = attr && Node.isJsxAttribute(attr) ? attr.getInitializer() : undefined;
    const value = init && Node.isJsxExpression(init) ? init.getExpression() : undefined;
    let list: Node | undefined = value;
    if (value && Node.isIdentifier(value)) {
      const declared = value
        .getSourceFile()
        .getDescendantsOfKind(SyntaxKind.VariableDeclaration)
        .find((declaration) => declaration.getName() === value.getText());
      list = declared?.getInitializer();
    }
    if (!list || !Node.isArrayLiteralExpression(list)) continue;
    const words = list.getElements().map((entry) => {
      if (Node.isStringLiteral(entry)) return entry.getLiteralValue();
      if (!Node.isObjectLiteralExpression(entry)) return undefined;
      const label =
        entry.getProperty('label') ?? entry.getProperty('title') ?? entry.getProperty('name');
      const text = label && Node.isPropertyAssignment(label) ? label.getInitializer() : undefined;
      return text && Node.isStringLiteral(text) ? text.getLiteralValue() : undefined;
    });
    if (words.length > 1 && words.length <= 8 && words.every(Boolean)) return words.join(' / ');
  }
  return undefined;
}

/** An inline handler whose only calls open, close or toggle something: "Open menu". */
function opensOrCloses(attribute: JsxAttribute): string | undefined {
  const init = attribute.getInitializer();
  const handler = init && Node.isJsxExpression(init) ? init.getExpression() : undefined;
  if (!handler || (!Node.isArrowFunction(handler) && !Node.isFunctionExpression(handler)))
    return undefined;
  const names = handler
    .getDescendantsOfKind(SyntaxKind.CallExpression)
    .map((call) => call.getExpression().getText())
    // Moving focus along with it is not what the control is for.
    .filter((name) => !/\.(focus|blur|select|preventDefault|stopPropagation)$/.test(name));
  if (
    names.length === 0 ||
    !names.every((name) => /^(open|close|toggle|show|hide)[A-Z]\w*$/.test(name))
  )
    return undefined;
  // `openMenu`, `closeMenu` -> "Open or close menu".
  const parts = names.map((name) => /^([a-z]+)(.*)$/.exec(name)!);
  const verbs = [...new Set(parts.map((part) => part[1]!))].sort((a, b) =>
    a === 'open' ? -1 : b === 'open' ? 1 : 0,
  );
  const nouns = [...new Set(parts.map((part) => humanizeName(part[2]!).toLowerCase()))];
  const said = `${verbs.join(' or ')} ${nouns.join(' or ')}`.trim();
  return said.charAt(0).toUpperCase() + said.slice(1);
}

/** A handler that only calls `e.preventDefault()` / `e.stopPropagation()`. */
function onlyStopsDefault(attribute: JsxAttribute): boolean {
  const init = attribute.getInitializer();
  const handler = init && Node.isJsxExpression(init) ? init.getExpression() : undefined;
  if (!handler || (!Node.isArrowFunction(handler) && !Node.isFunctionExpression(handler)))
    return false;
  const body = handler.getBody();
  const statements = Node.isBlock(body) ? body.getStatements() : [body];
  return (
    statements.length > 0 &&
    statements.every((statement) =>
      /^\w+\.(preventDefault|stopPropagation)\(\);?$/.test(statement.getText().trim()),
    )
  );
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

/**
 * What to call a component in a title.
 *
 * `export default function Index()` is how a Next.js page is very often
 * written, and "Medication · Index loads" names the file convention rather
 * than anything on the screen. A name that only says "this is the component"
 * gives way to the screen it is on: "Medication loads".
 */
function componentPhrase(componentName: string, screen: string): string {
  if (isGenericComponentName(componentName) && screen) return screen;
  return humanizeName(componentName);
}

/** Does this text contain anything a person could read out loud? */
function hasWords(text: string): boolean {
  return /[A-Za-z0-9]/.test(text);
}

/**
 * The words on the button that submits this form.
 *
 * `type="submit"` says so outright, on any component — `<PrimaryButton
 * type="submit">` is as common as `<button>`. Failing that, a plain button with
 * no type submits by default. A `type="button"` never does: a form full of
 * "Add relative" and "Remove" buttons is named by none of them.
 */
function submitButtonText(form: Node): string {
  const elements = [
    ...form.getDescendantsOfKind(SyntaxKind.JsxElement).map((el) => ({
      opening: el.getOpeningElement() as Node,
      body: el as Node,
    })),
    ...form
      .getDescendantsOfKind(SyntaxKind.JsxSelfClosingElement)
      .map((el) => ({ opening: el as Node, body: el as Node })),
  ];
  const typeOf = (opening: Node): string | undefined => stringAttribute(opening, 'type');
  const tagOf = (opening: Node): string =>
    Node.isJsxOpeningElement(opening) || Node.isJsxSelfClosingElement(opening)
      ? opening.getTagNameNode().getText()
      : '';
  const textOf = (body: Node): string =>
    directText(body) || nestedText(body) || labelPropOf(body) || '';

  for (const { opening, body } of elements) {
    if (typeOf(opening) !== 'submit') continue;
    const text = textOf(body);
    if (text) return text;
  }
  /**
   * `<button type="submit" form="addPatientForm">` in a footer outside the
   * `<form id="addPatientForm">` it submits — the pinned-footer layout puts it
   * there on purpose, so look for it by the form's id.
   */
  const formId = Node.isJsxElement(form)
    ? stringAttribute(form.getOpeningElement(), 'id')
    : undefined;
  if (formId) {
    for (const opening of [
      ...form.getSourceFile().getDescendantsOfKind(SyntaxKind.JsxOpeningElement),
      ...form.getSourceFile().getDescendantsOfKind(SyntaxKind.JsxSelfClosingElement),
    ]) {
      if (stringAttribute(opening, 'form') !== formId) continue;
      const body = Node.isJsxOpeningElement(opening) ? opening.getParent() : opening;
      const text = body ? textOf(body) : '';
      if (text) return text;
    }
  }
  for (const { opening, body } of elements) {
    if (!/^(button|Button|SubmitButton)$/.test(tagOf(opening))) continue;
    if (typeOf(opening) !== undefined) continue;
    const text = textOf(body);
    if (text) return text;
  }
  return '';
}

/** `type="submit"` and `type={"submit"}` -> "submit". */
function stringAttribute(opening: Node, name: string): string | undefined {
  if (!Node.isJsxOpeningElement(opening) && !Node.isJsxSelfClosingElement(opening))
    return undefined;
  const attribute = opening.getAttribute(name);
  if (!attribute || !Node.isJsxAttribute(attribute)) return undefined;
  const initializer = attribute.getInitializer();
  if (initializer && Node.isStringLiteral(initializer)) return initializer.getLiteralValue();
  const expression =
    initializer && Node.isJsxExpression(initializer) ? initializer.getExpression() : undefined;
  return expression && Node.isStringLiteral(expression) ? expression.getLiteralValue() : undefined;
}

/** `<PrimaryButton label="Save" type="submit" />`: a labelling prop on the element itself. */
function labelPropOf(element: Node): string {
  const opening = Node.isJsxElement(element) ? element.getOpeningElement() : element;
  if (!Node.isJsxOpeningElement(opening) && !Node.isJsxSelfClosingElement(opening)) return '';
  for (const name of ['label', 'text', 'title', 'aria-label']) {
    const attribute = opening.getAttribute(name);
    const initializer =
      attribute && Node.isJsxAttribute(attribute) ? attribute.getInitializer() : undefined;
    if (initializer && Node.isStringLiteral(initializer)) return initializer.getLiteralValue();
  }
  return '';
}

/**
 * The first readable words anywhere inside an element: its text, or a string
 * it shows (`{saving ? "Saving..." : "Save"}`).
 *
 * Progress text — "Saving...", "Adding…", "Loading" — is what the button says
 * for a second while it works, not what the user pressed, so it is passed over
 * whenever the element says anything else.
 */
function nestedText(element: Node): string {
  const candidates: Array<{ position: number; text: string }> = [];
  for (const text of element.getDescendantsOfKind(SyntaxKind.JsxText)) {
    const value = text.getLiteralText().replace(/\s+/g, ' ').trim();
    if (hasWords(value)) candidates.push({ position: text.getStart(), text: value });
  }
  const literals: Node[] = [
    ...element.getDescendantsOfKind(SyntaxKind.StringLiteral),
    ...element.getDescendantsOfKind(SyntaxKind.NoSubstitutionTemplateLiteral),
    ...element.getDescendantsOfKind(SyntaxKind.TemplateExpression),
  ];
  for (const literal of literals) {
    // Attribute values are class names and ids, not words on the screen.
    if (literal.getFirstAncestorByKind(SyntaxKind.JsxAttribute)) continue;
    if (!literal.getFirstAncestorByKind(SyntaxKind.JsxExpression)) continue;
    // `cond === "x"` compares; only a branch of `? :` or `&&` is shown.
    const parent = literal.getParent();
    if (Node.isBinaryExpression(parent) && !/^&&|\|\|$/.test(parent.getOperatorToken().getText())) {
      continue;
    }
    if (Node.isCallExpression(parent) || Node.isElementAccessExpression(parent)) continue;
    const value = shownText(literal).replace(/\s+/g, ' ').trim();
    if (hasWords(value)) candidates.push({ position: literal.getStart(), text: value });
  }
  candidates.sort((a, b) => a.position - b.position);
  // Only progress text — the handler's name says more than "Cancelling...".
  const found = candidates.find((candidate) => !isProgressText(candidate.text))?.text ?? '';
  // `Create &quot;` as written in JSX is `Create "` on screen.
  return found
    .replace(/&quot;/g, '"')
    .replace(/&apos;|&#39;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/&nbsp;/g, ' ');
}

/** A string as the screen shows it: `Cancel ${count} & Remove` -> "Cancel & Remove". */
function shownText(literal: Node): string {
  if (Node.isStringLiteral(literal) || Node.isNoSubstitutionTemplateLiteral(literal)) {
    return literal.getLiteralValue();
  }
  if (Node.isTemplateExpression(literal)) {
    return [
      literal.getHead().getLiteralText(),
      ...literal.getTemplateSpans().map((span) => span.getLiteral().getLiteralText()),
    ].join(' ');
  }
  return '';
}

/** "Saving...", "Adding…", "Loading": a button's busy state. */
function isProgressText(text: string): boolean {
  return /(?:\.\.\.|…)\s*$/.test(text) || /^(?:loading|please wait)\b/i.test(text);
}

/** Immediate text children of a JSX element, collapsed to one line. */
function directText(element: Node): string {
  if (!Node.isJsxElement(element)) return '';
  let text = '';
  for (const child of element.getJsxChildren()) {
    if (Node.isJsxText(child)) text += ` ${child.getLiteralText()}`;
    // `row{count === 1 ? "" : "s"}`: the plural, joined to its word.
    else if (Node.isJsxExpression(child)) {
      const value = child.getExpression();
      if (value && Node.isConditionalExpression(value)) {
        const branches = [value.getWhenTrue(), value.getWhenFalse()].map((branch) =>
          Node.isStringLiteral(branch) ? branch.getLiteralValue() : undefined,
        );
        const suffix = branches.find((branch) => branch && /^[a-z]{1,2}$/.test(branch));
        if (suffix && branches.includes('') && /\w$/.test(text)) text += suffix;
      }
    }
  }
  // `Create &quot;` as written in JSX is `Create "` on screen.
  return text
    .replace(/&quot;/g, '"')
    .replace(/&apos;|&#39;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/&nbsp;/g, ' ')
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

  const written = Node.isJsxExpression(initializer) ? initializer.getExpression() : initializer;
  if (!written) return undefined;
  const expression = unwrapSubmitWrapper(written);

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
      meta: {
        component: componentName,
        inline: true,
        ...(wrapped ? { function: wrapped } : {}),
        // `onClick={() => router.push(\`/medicines/${m.id}\`)}` goes to another page.
        ...aftermathMeta(expression),
      },
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

/**
 * `onSubmit={handleSubmit(save)}` -> `save`.
 *
 * React Hook Form's `handleSubmit` (and `form.handleSubmit`) validates and then
 * calls the function it was given, so that function is the handler. Read as a
 * call, the form pointed at nothing, and the most important button on the
 * screen was missing from the list.
 */
function unwrapSubmitWrapper(expression: Node): Node {
  if (!Node.isCallExpression(expression)) return expression;
  if (!/(?:^|\.)handleSubmit$/.test(expression.getExpression().getText())) return expression;
  const handler = expression.getArguments()[0];
  return handler && (Node.isIdentifier(handler) || isFunctionish(handler)) ? handler : expression;
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
  /** Query-string parameter names: `?page=1&size=20` -> ['page', 'size']. */
  queryKeys: string[];
  client: string;
}

/**
 * The URL on the other side of a conditional one — `readPathLike` keeps the
 * first readable side as the call's own; this is the second.
 */
function otherSidePath(call: CallExpression, config: FrontendConfig): string | undefined {
  const [first] = call.getArguments();
  const options = asObjectLiteral(first);
  const value = options
    ? config.urlKeys.map((key) => propertyValue(options, key)).find((v) => v !== undefined)
    : first;
  let node = value;
  while (node && Node.isParenthesizedExpression(node)) node = node.getExpression();
  if (!node || !Node.isConditionalExpression(node)) return undefined;
  const resolve = config.resolveConstant;
  const whenTrue = readPathLike(node.getWhenTrue(), resolve);
  const whenFalse = readPathLike(node.getWhenFalse(), resolve);
  return whenTrue !== undefined ? whenFalse : undefined;
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
  const wrapper = readWrapperCall(member, args, config, resolve);
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
 * `getRequest({ url: getCustomersList, params: `/${id}` })`
 *
 * The verb comes from the function name and the path from the options object.
 * This is the shape most house-built API layers use, and the one that made a
 * 500-endpoint frontend look like it had twelve API calls.
 */
/**
 * The wrapper regex, compiled once per pattern.
 *
 * It was being rebuilt for every member expression in the project — wasteful,
 * and it made the cost of a pathological pattern scale with the codebase. The
 * cache is keyed by the pattern string, so a config change in the same process
 * (the dashboard re-scanning) still takes effect.
 */
const wrapperPatterns = new Map<string, RegExp>();

/** No real request wrapper is called anything like this long. */
const MAX_WRAPPER_NAME = 200;

function wrapperPattern(pattern: string): RegExp {
  let compiled = wrapperPatterns.get(pattern);
  if (!compiled) {
    compiled = new RegExp(pattern, 'i');
    wrapperPatterns.set(pattern, compiled);
  }
  // Reset: a pattern someone wrote with /g would otherwise carry lastIndex
  // between calls and match every other identifier.
  compiled.lastIndex = 0;
  return compiled;
}

function readWrapperCall(
  member: string,
  args: ReturnType<CallExpression['getArguments']>,
  config: FrontendConfig,
  resolve: ((name: string) => string | undefined) | undefined,
): DetectedRequest | undefined {
  // Case-insensitive: the verb shows up as `get`, `Get` and `GET` across the
  // wrapper families real codebases grow (`crmPostRequest`, `AcmeGetRequest`).
  /**
   * A regex only backtracks catastrophically on a long subject, and this one is
   * matched against an identifier. Refusing the absurd ones puts a ceiling on
   * what a `requestFunctionPattern` from an untrusted repository can cost.
   */
  if (member.length > MAX_WRAPPER_NAME) return undefined;
  const match = wrapperPattern(config.requestFunctionPattern).exec(member);
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
 * `params: `/${id}`` makes `/admin/customers` into `/admin/customers/:id`,
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
    if (trimmed.length === 0) return rawPath;
    // A `?...` suffix is a query string, not a path segment. It used to be
    // dropped here, which lost every query parameter in the codebase; keep it on
    // the raw path instead, because `normalizePath` strips it before matching
    // and `buildRequest` reads the parameter names off it.
    if (trimmed.startsWith('?')) return `${rawPath}${trimmed}`;
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
    queryKeys: queryKeysOf(rawPath),
    client,
  };
}

/**
 * Parameter names from a query string as written in source.
 *
 * Values are ignored on purpose — they are usually interpolations
 * (`?page=${page}`) and the name is the part that describes the contract.
 */
export function queryKeysOf(rawPath: string): string[] {
  const start = rawPath.indexOf('?');
  if (start === -1) return [];
  const keys: string[] = [];
  for (const pair of rawPath.slice(start + 1).split('&')) {
    let key = pair.split('=')[0]?.trim();
    if (!key) continue;
    // An interpolation immediately before the name leaves the placeholder stuck
    // to it (`<param>status`), which is not a parameter called `<param>status`.
    if (key.startsWith(DYNAMIC_MARKER)) key = key.slice(DYNAMIC_MARKER.length).trim();
    // Skip a fully interpolated key (`?${qs}`): there is no name to report.
    if (!key || key.includes('$') || key.includes('{') || key.includes('<')) continue;
    if (!keys.includes(key)) keys.push(key);
  }
  return keys;
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
  const existingQuery = (node.meta?.['queryKeys'] as string[] | undefined) ?? [];
  node.meta = {
    ...node.meta,
    payloadKeys: mergedKeys,
    payloadSources: { ...(node.meta?.payloadSources as object), ...request.payloadSources },
    queryKeys: [...new Set([...existingQuery, ...request.queryKeys])],
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
    /**
     * Sequencing facts travel on the edge, not the node.
     *
     * One `api-call` node stands for an endpoint and may have many call sites;
     * "which one runs first" is a fact about a site. The edge is per
     * (caller, endpoint), which is the grain the question is asked at.
     */
    graph.addEdge({
      from: ownerId,
      to: id,
      kind: 'requests',
      meta: { file: rel, line: lineOf(call), ...callSequenceFacts(call) },
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
      /**
       * `sendBill={() => sendBill(id)}` handed to a child: it runs when the
       * child calls it, never as this component draws. Charged to the
       * component, its request counted as part of the page loading.
       */
      if (current.getParent() && Node.isJsxExpression(current.getParent()!)) return undefined;
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
 * pressing anything. Those are still features — "the shipment screen loads
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
       * Deferred hooks are excluded. `const { createCustomer } =
       * useCreateCustomer()` in the body is a declaration, not a request: the
       * hook hands back a function that some handler calls later, so counting it
       * would invent a mount-time fetch for every component holding a mutation.
       *
       * A `useQuery`-style hook is the opposite — it fetches on render — so it
       * is exactly what a mount action should be built from.
       */
      .filter((node) => node.kind !== 'hook' || node.meta?.['fetchesOnMount'] === true)
      /**
       * `useImportJobStatus(step === "processing" ? jobId : null)` with
       * `enabled: !!jobId`: switched off until a job is queued, so it is the
       * polling an import starts, not something the dialog loads as it opens.
       */
      .filter((node) => {
        const param = node.meta?.['enabledByParam'];
        if (typeof param !== 'number') return true;
        if (param < 0) return false;
        const empty = graph.edgesFrom(component.id, ['calls']).find((edge) => edge.to === node.id)
          ?.meta?.['emptyArgs'] as number[] | undefined;
        return !empty?.includes(param);
      })
      .map((node) => node.id)
      .filter((id) => !triggered.has(id))
      .filter((id) => reachesApiCall(graph, id));

    /**
     * Requests made straight from the component body inside an effect.
     *
     * `useEffect(() => { api.get('/me').then(setUser) }, [])` is how a large
     * share of React code loads data, and it produces no intermediate function
     * for the walk above to find — the `requests` edge hangs off the component
     * itself. Without this the component had no mount action at all, so the
     * whole screen's data loading was missing from the flow list.
     *
     * Restricted to calls inside an effect: a request written directly in a
     * render body is a bug rather than a feature, and should not be described
     * as one.
     */
    const effectRequests = graph
      .edgesFrom(component.id, ['requests'])
      .filter((edge) => edge.meta?.['inEffect'] === true);

    if (onMount.length === 0 && effectRequests.length === 0) continue;

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
         * `Customer detail · Upcoming shipment loads`. One file can define
         * several components, and two of them fetching on mount would otherwise
         * produce two tiles reading "Customer detail loads".
         */
        title: composeTitle(
          place.screen,
          `${componentPhrase(component.label, place.screen)} ${label}`,
        ),
        ...(place.page ? { page: place.page } : {}),
        ...(place.area ? { area: place.area } : {}),
      },
    });
    graph.addEdge({ from: component.id, to: actionId, kind: 'renders' });
    for (const handler of onMount) {
      graph.addEdge({ from: actionId, to: handler, kind: 'triggers' });
    }
    /**
     * The sequencing facts are copied, not dropped.
     *
     * They describe a call *site*, and this edge stands for the same site as
     * the component's own — so an edge without them would leave the sequence
     * unanswerable depending on which edge a reader happened to follow.
     */
    for (const edge of effectRequests) {
      graph.addEdge({
        from: actionId,
        to: edge.to,
        kind: 'requests',
        ...(edge.meta ? { meta: { ...edge.meta } } : {}),
      });
    }
  }
}

/**
 * After-effects as node meta, omitting the keys with nothing in them.
 *
 * A handler that navigates nowhere should carry no `navigatesTo`, so that a
 * consumer can tell "nothing happens next" from "not looked at".
 */
function aftermathMeta(fn: Node): Record<string, unknown> {
  const after = aftermathOf(fn);
  return {
    ...(after.navigatesTo.length > 0 ? { navigatesTo: after.navigatesTo } : {}),
    ...(after.invalidates.length > 0 ? { invalidates: after.invalidates } : {}),
    ...(after.invalidatePrefixes ? { invalidatePrefixes: after.invalidatePrefixes } : {}),
    ...(after.errorStates.length > 0 ? { errorStates: after.errorStates } : {}),
    ...(after.notifies.length > 0 ? { notifies: after.notifies } : {}),
    ...(after.handlesErrors ? { handlesErrors: true } : {}),
  };
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
  contexts: ContextIndex,
): void {
  const aliasTable = new Map<string, PendingAlias>();
  for (const alias of aliases) {
    aliasTable.set(`${alias.file}::${alias.localName}`, alias);
  }

  // `onClick={logout}` with `const { logout } = useAuth()`: the handler is
  // the hook's member, so it calls whatever that member turns out to be.
  for (const node of graph.allNodes()) {
    const name = node.meta?.['function'];
    if (node.kind !== 'handler' || !node.meta?.['unresolved'] || typeof name !== 'string') continue;
    if (!node.source || !aliasTable.has(`${node.source.file}::${name}`)) continue;
    pending.push({
      from: { id: node.id, kind: 'handler', file: node.source.file, ensure: noop },
      name,
      file: node.source.file,
    });
  }

  const touched = new Set<string>();

  for (const call of pending) {
    // `createCustomer()` in this file may really mean `useCreateCustomer()`.
    const alias = aliasTable.get(`${call.file}::${call.name}`);
    const aliased = alias?.hookName;
    // A receiver is only ever a hook result; anything else is not a call edge.
    if (call.receiverOnly && !aliased) continue;
    // `logout()` from `useAuth()` is the provider's own `logout`, not the hook.
    const context = !call.receiverOnly && aliased ? contexts.hooks.get(aliased) : undefined;
    const provided = context ? contexts.members.get(`${context}::${alias?.member}`) : undefined;
    if (provided && graph.hasNode(provided) && provided !== call.from.id) {
      call.from.ensure();
      graph.addEdge({ from: call.from.id, to: provided, kind: 'calls', ...edgeMeta(call) });
      continue;
    }
    const name = aliased ?? call.name;
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

    graph.addEdge({ from: call.from.id, to: target.id, kind: 'calls', ...edgeMeta(call) });
  }

  pruneUnusedModuleFunctions(graph, touched);
}

/** A call edge's meta: where it is written, and whether it waits for a response. */
function edgeMeta(call: PendingCall): { meta?: Record<string, unknown> } {
  if (call.line === undefined) return {};
  return {
    meta: {
      line: call.line,
      ...(call.end !== undefined ? { end: call.end } : {}),
      ...(call.emptyArgs?.length ? { emptyArgs: call.emptyArgs } : {}),
      ...(call.reads?.length ? { reads: call.reads } : {}),
      ...(call.afterResponse ? { afterResponse: true } : {}),
    },
  };
}

const RESPONSE_CALLBACKS = new Set(['onSuccess', 'onError', 'onSettled']);
const PROMISE_CALLBACKS = new Set(['then', 'catch', 'finally']);

/**
 * The line of a call, and whether it only runs once a request has answered:
 * inside an `onSuccess`/`onError`/`onSettled` option, or a `.then`/`.catch`
 * callback. Without this, the toast an `onSuccess` shows read as if it came
 * before the request it reports on.
 */
function callPlacement(
  call: CallExpression,
): Pick<PendingCall, 'line' | 'end' | 'afterResponse' | 'emptyArgs' | 'reads'> {
  let afterResponse = false;
  for (let node: Node | undefined = call.getParent(); node; node = node.getParent()) {
    if (!Node.isArrowFunction(node) && !Node.isFunctionExpression(node)) continue;
    const parent = node.getParent();
    if (Node.isPropertyAssignment(parent) && RESPONSE_CALLBACKS.has(parent.getName())) {
      afterResponse = true;
      break;
    }
    if (Node.isCallExpression(parent)) {
      const expression = parent.getExpression();
      if (
        Node.isPropertyAccessExpression(expression) &&
        PROMISE_CALLBACKS.has(expression.getName())
      ) {
        afterResponse = true;
        break;
      }
    }
    // The handler itself: what encloses it is not part of this call's timing.
    if (!Node.isCallExpression(parent) && !Node.isPropertyAssignment(parent)) break;
  }
  const emptyArgs = call
    .getArguments()
    .map((arg, index) => (startsEmpty(arg) ? index : -1))
    .filter((index) => index >= 0);
  const reads = argumentNames(call);
  return {
    line: call.getStartLineNumber(),
    end: call.getEnd(),
    ...(afterResponse ? { afterResponse } : {}),
    ...(emptyArgs.length ? { emptyArgs } : {}),
    ...(reads.length ? { reads } : {}),
  };
}

/**
 * The names a call's arguments are made of, two declarations deep:
 * `useMedicines(query)` with `const query = useMemo(() => ({ page, sortBy }))`
 * reads `query`, `page` and `sortBy` — so a click that sets `page` fetches again.
 */
function argumentNames(call: CallExpression): string[] {
  const found = new Set<string>();
  const scope = call.getFirstAncestor(
    (node) =>
      Node.isFunctionDeclaration(node) ||
      Node.isArrowFunction(node) ||
      Node.isFunctionExpression(node),
  );
  let frontier: Node[] = call.getArguments();
  for (let depth = 0; depth < 3 && frontier.length > 0; depth++) {
    const next: Node[] = [];
    for (const node of frontier) {
      const identifiers = Node.isIdentifier(node)
        ? [node]
        : node.getDescendantsOfKind(SyntaxKind.Identifier);
      for (const identifier of identifiers) {
        const name = identifier.getText();
        if (found.has(name)) continue;
        found.add(name);
        const declaration = scope
          ?.getDescendantsOfKind(SyntaxKind.VariableDeclaration)
          .find(
            (candidate) =>
              Node.isIdentifier(candidate.getNameNode()) && candidate.getName() === name,
          );
        const init = declaration?.getInitializer();
        if (init && !/^use(State|Reducer)\b/.test(init.getText())) next.push(init);
      }
    }
    frontier = next;
  }
  return [...found].slice(0, 40);
}

function withoutArguments<T extends { emptyArgs?: number[]; reads?: string[] }>(
  placement: T,
): Omit<T, 'emptyArgs' | 'reads'> {
  const { emptyArgs: _empty, reads: _reads, ...rest } = placement;
  return rest;
}

const EMPTY = /^(null|undefined|false|''|""|``)$/;

/**
 * Empty when the component first draws: `null`, `step === "x" ? jobId : null`,
 * or a state declared `useState(null)` that a handler fills in later.
 */
function startsEmpty(arg: Node): boolean {
  if (EMPTY.test(arg.getText())) return true;
  if (Node.isConditionalExpression(arg))
    return EMPTY.test(arg.getWhenFalse().getText()) || EMPTY.test(arg.getWhenTrue().getText());
  if (!Node.isIdentifier(arg)) return false;
  const name = arg.getText();
  for (const declaration of arg
    .getSourceFile()
    .getDescendantsOfKind(SyntaxKind.VariableDeclaration)) {
    const binding = declaration.getNameNode();
    if (!Node.isArrayBindingPattern(binding)) continue;
    const first = binding.getElements()[0];
    if (!first || !Node.isBindingElement(first) || first.getName() !== name) continue;
    const init = declaration.getInitializer();
    if (!init || !Node.isCallExpression(init) || !/useState$/.test(init.getExpression().getText()))
      continue;
    const initial = init.getArguments()[0];
    return !initial || EMPTY.test(initial.getText());
  }
  return false;
}

/**
 * Drop module functions that lead nowhere.
 *
 * Declaring every top-level function lets Flowslens follow
 * `handler -> fetchCustomers -> axios.post`, but it also drags in ordinary
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

/** `useContext(AuthContext)` inside a hook -> `AuthContext`. */
function contextRead(fn: Functionish): string | undefined {
  for (const call of callsIn(fn)) {
    if (!/^(React\.)?useContext$/.test(calleeName(call))) continue;
    const [arg] = call.getArguments();
    if (arg && Node.isIdentifier(arg)) return arg.getText();
  }
  return undefined;
}

/**
 * `<AuthContext.Provider value={value}>` with
 * `const value = useMemo(() => ({ user, login, logout }), […])` ->
 * AuthContext: { login -> AuthProvider.login, logout -> AuthProvider.logout }.
 *
 * shortcut: only `X.Provider` with an object literal (direct, via a local
 * variable, or a `useMemo` returning one); React 19's `<X value>` is not read.
 */
function providedMembers(
  file: SourceFile,
): Map<string, Map<string, { component: string; local: string }>> {
  const out = new Map<string, Map<string, { component: string; local: string }>>();
  const elements = [
    ...file.getDescendantsOfKind(SyntaxKind.JsxOpeningElement),
    ...file.getDescendantsOfKind(SyntaxKind.JsxSelfClosingElement),
  ];
  for (const element of elements) {
    const tag = /^(\w+)\.Provider$/.exec(element.getTagNameNode().getText());
    const component = ownerComponentName(element);
    if (!tag?.[1] || !component) continue;
    const attribute = element
      .getAttributes()
      .find(
        (candidate) =>
          Node.isJsxAttribute(candidate) && candidate.getNameNode().getText() === 'value',
      );
    const initializer =
      attribute && Node.isJsxAttribute(attribute) ? attribute.getInitializer() : undefined;
    const written =
      initializer && Node.isJsxExpression(initializer) ? initializer.getExpression() : undefined;
    const object = providedObject(written, element);
    if (!object) continue;
    const members = new Map<string, { component: string; local: string }>();
    for (const property of object.getProperties()) {
      if (Node.isShorthandPropertyAssignment(property)) {
        members.set(property.getName(), { component, local: property.getName() });
      } else if (Node.isPropertyAssignment(property)) {
        const value = property.getInitializer();
        if (value && Node.isIdentifier(value))
          members.set(stripQuotes(property.getName()), { component, local: value.getText() });
      }
    }
    out.set(tag[1], members);
  }
  return out;
}

function providedObject(node: Node | undefined, at: Node): ObjectLiteralExpression | undefined {
  let value = node;
  while (value && Node.isParenthesizedExpression(value)) value = value.getExpression();
  if (!value) return undefined;
  if (Node.isObjectLiteralExpression(value)) return value;
  if (Node.isIdentifier(value)) {
    const scope = enclosingFunction(at);
    const declaration = scope
      ?.getDescendantsOfKind(SyntaxKind.VariableDeclaration)
      .find((candidate) => candidate.getName() === value!.getText());
    return declaration ? providedObject(declaration.getInitializer(), at) : undefined;
  }
  if (Node.isCallExpression(value) && /^(React\.)?useMemo$/.test(calleeName(value))) {
    const [factory] = value.getArguments();
    if (!factory || !Node.isArrowFunction(factory)) return undefined;
    const body = factory.getBody();
    if (!Node.isBlock(body)) return providedObject(body, at);
    const returned = body.getStatements().find(Node.isReturnStatement)?.getExpression();
    return providedObject(returned, at);
  }
  return undefined;
}

/** `() => {}` itself, or the function in `useCallback(() => {}, [deps])`. */
function callbackOf(
  node: Node | undefined,
): ArrowFunction | FunctionExpression | FunctionDeclaration | undefined {
  if (!node) return undefined;
  if (isFunctionish(node)) return node;
  if (!Node.isCallExpression(node) || !/^(React\.)?useCallback$/.test(calleeName(node)))
    return undefined;
  const [first] = node.getArguments();
  return first && isFunctionish(first) ? first : undefined;
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
