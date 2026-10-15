import { Node, SyntaxKind, type SourceFile } from 'ts-morph';
import { plainFallback, plainQuestion, plainValue } from './plainwords.js';
import type { FlowGraph } from '../graph/graph.js';
import {
  condense,
  functionAtLine,
  functionOf,
  nameOf,
  returnsOf,
  SourceReader,
  unwrap,
} from './actionsource.js';
import { buildPageIndex, type PageIndex } from './pages.js';
import type { FeatureFlow } from './resolve.js';

/**
 * Where a card's numbers come from, and how it shows them.
 *
 * A dashboard card presses nothing: it reads. "97% Stock health" is
 * `Math.round(inStock / total * 100)`, `inStock` is worked out from three
 * fields of `data`, `data` is a prop handed down twice from the page's
 * `useDashboard()`, that hook is `GET /dashboard`, and the server builds
 * `lowStockCount` in an aggregation. Each step is in the code; this follows
 * them, from what the card draws back to the request and the server code that
 * makes each field.
 *
 * It is a reading: a value is traced through variables, props, `.map` rows and
 * array items written in the code, not through state the running app holds.
 */

export interface CardValue {
  /** What names it on the screen: the prop it is passed as, or the text around it. */
  label: string;
  /** As written: `formatNumber(t.value)`. */
  code: string;
  file: string;
  line: number;
  /** Fields of the loaded data it is made from: `lowStockCount`, `recentMovements[].reason`. */
  fields: string[];
  /** Values worked out in the browser on the way: `pct`, `inStock`. */
  uses: string[];
  /** The project's functions it is shown through: `formatNumber`. */
  format: string[];
  /** The hooks its data comes from: `useDashboard`. */
  hooks: string[];
}

/** A value worked out in the browser from the loaded data. */
export interface CardCalculation {
  name: string;
  code: string;
  file: string;
  line: number;
  fields: string[];
}

/** A hook the card's data comes from, and the action that loads it. */
export interface CardSource {
  hook: string;
  /** Where the hook is called. */
  file: string;
  line: number;
  /** The loads that run it, by flow id. */
  flows: string[];
  endpoints: string[];
  /** The fields of its data the card reads. */
  fields: string[];
  /** What it asks for: `{ expiring: true, sortBy: "expiryDate", pageSize: 5 }`. */
  asks?: string;
}

/** Where the server makes a field the card shows. */
export interface CardField {
  field: string;
  endpoint?: string;
  made: Array<{ code: string; file: string; line: number; how: 'returned' | 'computed' }>;
}

/** Something that decides what the card draws: a loading state, an empty list, a status. */
export interface CardCondition {
  code: string;
  file: string;
  line: number;
  /** What each way draws: `DashboardSkeleton`, `“Good”`, `EmptyState “No activity yet”`. */
  outcomes: string[];
  /** In the card itself, or around it — the page waiting for its data. */
  where: 'card' | 'around';
  /**
   * Each test of `code` as a plain yes/no question, where one can be said
   * safely: `total > 0` -> "Is the total more than 0?".
   */
  asked?: Array<string | undefined>;
  /** Each outcome as plain words where it is a value: `Math.round(x * 100)` -> "the x times 100, rounded". */
  said?: Array<string | undefined>;
}

export interface CardData {
  file: string;
  line: number;
  /** The component the card is drawn in. */
  component?: string;
  values: CardValue[];
  calculations: CardCalculation[];
  sources: CardSource[];
  fields: CardField[];
  conditions: CardCondition[];
}

export interface CardDataOptions {
  reader?: SourceReader;
  index?: PageIndex;
  /**
   * The words on a link inside a list of tiles — `Low` — so only the tile it
   * stands for is read, not its siblings.
   */
  pick?: string;
  /** Read only the element at this line: a link inside the card. */
  element?: { file: string; line: number };
}

/** Props that style or wire an element rather than show something. */
const NOT_SHOWN =
  /^(?:key|ref|className|class|style|icon|tone|progressTone|variant|size|color|id|as|asChild|type|href|to|target|rel|role|tabIndex|htmlFor|name|disabled|on[A-Z]\w*|aria-[\w-]+|data-[\w-]+)$/;
const GLOBALS = new Set([
  'Math',
  'Number',
  'String',
  'Boolean',
  'Date',
  'Array',
  'Object',
  'JSON',
  'Intl',
  'console',
  'window',
  'document',
  'undefined',
  'NaN',
  'Infinity',
]);
/** Array and value methods: `rows.slice(0, 5).map(…)` still reads `rows`. */
const PASS_THROUGH = new Set([
  'map',
  'slice',
  'filter',
  'find',
  'findLast',
  'some',
  'every',
  'reduce',
  'forEach',
  'flatMap',
  'sort',
  'toSorted',
  'reverse',
  'concat',
  'join',
  'includes',
  'at',
  'length',
  'toFixed',
  'toString',
  'toLocaleString',
  'toLocaleDateString',
  'trim',
  'toUpperCase',
  'toLowerCase',
]);
/** Callbacks whose first parameter is an item of the list they are called on. */
const ITEM_CALLBACK = new Set([
  'map',
  'filter',
  'find',
  'findLast',
  'some',
  'every',
  'forEach',
  'flatMap',
  'sort',
  'toSorted',
]);

/** What a data hook says about the request, not what it loaded: `isLoading`, `error`, `refetch`. */
const HOOK_STATE =
  /^(?:is[A-Z]\w*|loading|fetching|error|errors|status|fetchStatus|refetch|mutate|reset|isValidating|networkStatus|called|previousData|variables|failureCount|failureReason|dataUpdatedAt|errorUpdatedAt)$/;

const MAX_VALUES = 60;
const MAX_DEPTH = 14;
const MAX_CALLERS = 3;

interface Found {
  fields: Set<string>;
  uses: Set<string>;
  format: Set<string>;
  hooks: Set<string>;
}

interface Hook {
  hook: string;
  file: string;
  line: number;
  fields: Set<string>;
}

class Tracer {
  readonly hooks = new Map<string, Hook>();
  readonly calculations = new Map<string, CardCalculation>();
  readonly conditions = new Map<string, CardCondition>();
  /** Call sites already known: a component entered from the element drawing it. */
  readonly callSites = new Map<Node, Node[]>();
  private readonly callers = new Map<string, Node[]>();

  constructor(
    readonly reader: SourceReader,
    readonly index: PageIndex,
    readonly pick?: string,
  ) {}

  /** Every data reference in `expression`, traced to where it comes from. */
  trace(expression: Node, found: Found, chain: string[] = [], depth = 0): void {
    if (depth > MAX_DEPTH) return;
    const value = unwrap(expression);
    // Following a path into a literal: `[{ value: data.low }]` read as `[].value`.
    if (chain.length > 0) {
      if (Node.isArrayLiteralExpression(value) && chain[0] === '[]') {
        for (const element of this.picked(value.getElements())) {
          this.trace(element, found, chain.slice(1), depth + 1);
        }
        return;
      }
      if (Node.isObjectLiteralExpression(value)) {
        const property = value.getProperty(chain[0]!);
        if (property && Node.isPropertyAssignment(property)) {
          const initializer = property.getInitializer();
          if (initializer) this.trace(initializer, found, chain.slice(1), depth + 1);
          return;
        }
        if (property && Node.isShorthandPropertyAssignment(property)) {
          this.resolve(property.getNameNode(), found, chain.slice(1), depth + 1);
          return;
        }
      }
    }
    if (Node.isIdentifier(value)) {
      this.resolve(value, found, chain, depth + 1);
      return;
    }
    // `rows.slice(0, 5)`, `rows.filter(…)`: still the rows of `rows`.
    if (Node.isCallExpression(value)) {
      const callee = value.getExpression();
      if (Node.isPropertyAccessExpression(callee) && PASS_THROUGH.has(callee.getName())) {
        this.trace(callee.getExpression(), found, chain, depth + 1);
        for (const argument of value.getArguments()) this.trace(argument, found, [], depth + 1);
        return;
      }
    }
    if (Node.isPropertyAccessExpression(value) || Node.isElementAccessExpression(value)) {
      const root = rootOf(value);
      if (root) {
        this.resolve(root.identifier, found, [...root.chain, ...chain], depth + 1);
        // `obj[key]`: the key is read too.
        for (const argument of value.getDescendantsOfKind(SyntaxKind.ElementAccessExpression)) {
          const key = argument.getArgumentExpression();
          if (key && !Node.isLiteralExpression(key)) this.trace(key, found, [], depth + 1);
        }
        return;
      }
    }
    for (const identifier of references(value)) {
      const root = rootOf(identifier) ?? { identifier, chain: [] };
      this.resolve(root.identifier, found, root.chain, depth + 1);
    }
  }

  /** The tile a link stands for, when the list is spelled out and the link is named. */
  private picked(elements: Node[]): Node[] {
    if (!this.pick) return elements;
    const named = elements.filter(
      (element) =>
        Node.isObjectLiteralExpression(element) &&
        element
          .getProperties()
          .some(
            (property) =>
              Node.isPropertyAssignment(property) &&
              stringOf(property.getInitializer()) === this.pick,
          ),
    );
    return named.length > 0 ? named : elements;
  }

  /** What a name refers to where it is used, followed back to the data. */
  resolve(identifier: Node, found: Found, chain: string[], depth: number): void {
    if (depth > MAX_DEPTH) return;
    const name = identifier.getText();
    if (GLOBALS.has(name)) return;
    for (let scope = identifier.getParent(); scope; scope = scope.getParent()) {
      if (isFunction(scope)) {
        const parameters = (scope as unknown as { getParameters(): Node[] }).getParameters();
        const index = parameters.findIndex((parameter) => binds(parameter, name));
        if (index >= 0) {
          this.fromParameter(scope, parameters[index]!, index, name, found, chain, depth);
          return;
        }
      }
      if (Node.isBlock(scope) || Node.isSourceFile(scope) || Node.isCaseClause(scope)) {
        const declaration = declarationIn(scope, name);
        if (declaration) {
          this.fromVariable(declaration, name, found, chain, depth, Node.isSourceFile(scope));
          return;
        }
        if (Node.isSourceFile(scope)) {
          // Imported or declared as a function: a formatter, not data.
          const call = identifier.getParent();
          if (call && Node.isCallExpression(call) && call.getExpression() === identifier) {
            found.format.add(name);
          }
          return;
        }
      }
    }
  }

  private fromParameter(
    fn: Node,
    parameter: Node,
    index: number,
    name: string,
    found: Found,
    chain: string[],
    depth: number,
  ): void {
    const path = [...bindingPath(parameter, name), ...chain];
    // `list.map((item) => …)`: an item of the list.
    const call = fn.getParent();
    if (call && Node.isCallExpression(call) && call.getArguments()[0] === fn) {
      const callee = call.getExpression();
      if (
        Node.isPropertyAccessExpression(callee) &&
        ITEM_CALLBACK.has(callee.getName()) &&
        index === 0
      ) {
        this.trace(callee.getExpression(), found, ['[]', ...path], depth + 1);
        return;
      }
    }
    // A component's props: what the element drawing it passes.
    if (index !== 0 || !isComponent(fn)) return;
    const [prop, ...rest] = path;
    if (!prop) return;
    for (const site of this.callSitesOf(fn)) {
      const value = propValue(site, prop);
      if (value) this.trace(value, found, rest, depth + 1);
    }
  }

  private fromVariable(
    declaration: Node,
    name: string,
    found: Found,
    chain: string[],
    depth: number,
    moduleLevel: boolean,
  ): void {
    if (!Node.isVariableDeclaration(declaration)) return;
    const initializer = declaration.getInitializer();
    if (!initializer) return;
    if (functionOf(initializer)) {
      found.format.add(name);
      return;
    }
    const path = [...bindingPath(declaration.getNameNode(), name), ...chain];
    const value = unwrap(initializer);
    const hook = hookCall(value);
    if (hook) {
      const file = this.reader.relative(value.getSourceFile());
      const line = value.getStartLineNumber();
      const key = `${hook}@${file}:${line}`;
      const entry = this.hooks.get(key) ?? { hook, file, line, fields: new Set<string>() };
      this.hooks.set(key, entry);
      // A query hook — `const { data } = useX()`, `x.data` — keeps what it
      // loaded under `data` and its state beside it; any other hook returns
      // the data itself: `const stats = useStats()`, `const { total } = useStats()`.
      const [binding, ...rest] = path;
      if (binding !== undefined && HOOK_STATE.test(binding)) {
        found.fields.add(`${hook}().${binding}`);
      } else {
        const field = fieldName(binding === 'data' ? rest : path);
        if (field) {
          entry.fields.add(field);
          found.fields.add(field);
        }
      }
      found.hooks.add(hook);
      return;
    }
    if (moduleLevel) {
      // Constants: a palette, a label table. Only followed into a path.
      if (chain.length > 0) this.trace(value, found, chain, depth + 1);
      return;
    }
    const literal = Node.isArrayLiteralExpression(value) || Node.isObjectLiteralExpression(value);
    if (!literal && Node.isIdentifier(declaration.getNameNode())) {
      const inner: Found = emptyFound();
      this.trace(value, inner, passesChain(value) ? chain : [], depth + 1);
      merge(found, inner);
      if (inner.fields.size + inner.uses.size > 0) {
        found.uses.add(name);
        const file = this.reader.relative(declaration.getSourceFile());
        const line = declaration.getStartLineNumber();
        this.calculations.set(`${file}:${line}`, {
          name,
          code: condense(`${name} = ${value.getText()}`, 220),
          file,
          line,
          fields: [...inner.fields],
        });
        this.conditionsIn(value);
      }
      return;
    }
    // A list of tiles, or `const { rows } = data`: followed along the path.
    this.trace(value, found, path, depth + 1);
  }

  /** The elements that draw a component, searched in the files that draw it. */
  callSitesOf(fn: Node): Node[] {
    const known = this.callSites.get(fn);
    if (known) return known;
    const name = componentName(fn);
    if (!name) return [];
    const cached = this.callers.get(name);
    if (cached) return cached;
    const sites: Node[] = [];
    const pattern = new RegExp(`<${name}[\\s/>]`);
    const files = [...(this.index.renderedIn.get(name) ?? [])];
    for (const [file, text] of this.index.texts) {
      if (!files.includes(file) && pattern.test(text)) files.push(file);
    }
    for (const file of files) {
      const source = this.reader.file(file);
      if (!source) continue;
      for (const opening of openingsNamed(source, name)) {
        sites.push(opening);
        if (sites.length >= MAX_CALLERS) break;
      }
      if (sites.length >= MAX_CALLERS) break;
    }
    this.callers.set(name, sites);
    return sites;
  }

  /** The `cond ? a : b` inside a calculation: a status worked out from the data. */
  conditionsIn(node: Node): void {
    const all = Node.isConditionalExpression(node)
      ? [node]
      : node.getDescendantsOfKind(SyntaxKind.ConditionalExpression);
    for (const conditional of all) {
      // The outermost of a chain stands for all of it.
      if (Node.isConditionalExpression(conditional.getParent())) continue;
      this.addCondition(conditional, 'card');
    }
  }

  /** `inner`: the card, inside one of the branches — that branch draws it. */
  addCondition(node: Node, where: CardCondition['where'], inner?: Node): void {
    const file = this.reader.relative(node.getSourceFile());
    const line = node.getStartLineNumber();
    const key = `${file}:${line}:${node.getStart()}`;
    if (this.conditions.has(key)) return;
    let code: string;
    let outcomes: string[];
    if (Node.isConditionalExpression(node)) {
      const ways = chainOf(node);
      code = ways.conditions.map((condition) => condense(condition.getText(), 80)).join(' · ');
      outcomes = ways.results.map((result) =>
        inner && result.containsRange(inner.getPos(), inner.getEnd())
          ? 'the card'
          : describe(result),
      );
    } else if (Node.isBinaryExpression(node)) {
      code = condense(node.getLeft().getText(), 100);
      outcomes = [inner ? 'the card' : describe(node.getRight()), 'nothing'];
      if (node.getOperatorToken().getText() === '||') outcomes.reverse();
    } else return;
    const tests = code.split(' · ');
    const asked = tests.map((test) => plainQuestion(test) ?? plainFallback(test));
    const said = outcomes.map((outcome) =>
      /^[“"]|^(the card|nothing|its content)$/.test(outcome) ? undefined : plainValue(outcome),
    );
    this.conditions.set(key, {
      code,
      file,
      line,
      outcomes,
      where,
      ...(asked.some(Boolean) ? { asked } : {}),
      ...(said.some(Boolean) ? { said } : {}),
    });
  }
}

/**
 * Read a card: what it shows, where each value comes from, and where the
 * server makes it.
 */
export function cardData(
  graph: FlowGraph,
  flows: FeatureFlow[],
  section: { file: string; line: number },
  options: CardDataOptions = {},
): CardData | undefined {
  const reader = options.reader ?? new SourceReader(graph);
  const at = options.element ?? section;
  const source = reader.file(at.file);
  if (!source) return undefined;
  const element = elementAt(source, at.line);
  if (!element) return undefined;
  const index = options.index ?? buildPageIndex(graph, reader);
  const tracer = new Tracer(reader, index, options.pick);
  const values: CardValue[] = [];
  const seen = new Set<string>();

  /** The component a prop value is handed to, which decides how it is drawn. */
  let shownThrough: string | undefined;
  const add = (label: string, expression: Node) => {
    if (values.length >= MAX_VALUES) return;
    const file = reader.relative(expression.getSourceFile());
    const line = expression.getStartLineNumber();
    const key = `${file}:${expression.getStart()}`;
    if (seen.has(key)) return;
    seen.add(key);
    const found = emptyFound();
    tracer.trace(expression, found);
    if (found.fields.size + found.uses.size === 0) return;
    values.push({
      label,
      code: condense(expression.getText(), 120),
      file,
      line,
      fields: [...found.fields],
      uses: [...found.uses],
      format: [...found.format, ...(shownThrough ? [shownThrough] : [])],
      hooks: [...found.hooks],
    });
  };

  const sameFile = element.getSourceFile();
  const visitExpression = (expression: Node, label: string, depth: number, chained = false) => {
    const value = unwrap(expression);
    if (Node.isArrowFunction(value) || Node.isFunctionExpression(value)) {
      // A render callback: what it draws, per row.
      const body = value.getBody();
      if (body && containsJsx(body)) visitExpression(body, label, depth);
      return;
    }
    if (Node.isBlock(value)) {
      for (const result of value.getDescendantsOfKind(SyntaxKind.ReturnStatement)) {
        const returned = result.getExpression();
        if (returned) visitExpression(returned, label, depth);
      }
      return;
    }
    if (isJsxNode(value)) {
      visitJsx(value, depth);
      return;
    }
    if (!containsJsx(value)) {
      add(label, value);
      return;
    }
    if (Node.isConditionalExpression(value)) {
      // `a ? x : b ? y : z` is one condition, said once.
      if (!chained) tracer.addCondition(value, 'card');
      visitCondition(value.getCondition());
      visitExpression(value.getWhenTrue(), label, depth);
      visitExpression(value.getWhenFalse(), label, depth, true);
      return;
    }
    if (
      Node.isBinaryExpression(value) &&
      /^(?:&&|\|\||\?\?)$/.test(value.getOperatorToken().getText())
    ) {
      tracer.addCondition(value, 'card');
      visitCondition(value.getLeft());
      visitExpression(value.getRight(), label, depth);
      return;
    }
    if (Node.isCallExpression(value)) {
      const callee = value.getExpression();
      // `rows.slice(0, 5).map((m) => <Row …/>)`: a row per item of `rows`.
      if (Node.isPropertyAccessExpression(callee) && callee.getName() === 'map') {
        add(`${label === 'text' ? 'list' : label} (one row each)`, callee.getExpression());
      }
      for (const argument of value.getArguments()) visitExpression(argument, label, depth);
    }
  };
  /** What a condition reads is data too: `rows.length === 0` reads `rows`. */
  const visitCondition = (condition: Node) => {
    const found = emptyFound();
    tracer.trace(condition, found);
  };

  const visitJsx = (node: Node, depth: number) => {
    if (Node.isJsxFragment(node)) {
      for (const child of node.getJsxChildren()) visitChild(child, node, depth);
      return;
    }
    const opening = Node.isJsxElement(node) ? node.getOpeningElement() : node;
    if (!Node.isJsxOpeningElement(opening) && !Node.isJsxSelfClosingElement(opening)) return;
    const tag = opening.getTagNameNode().getText();
    for (const attribute of opening.getAttributes()) {
      if (!Node.isJsxAttribute(attribute)) continue;
      const name = attribute.getNameNode().getText();
      if (NOT_SHOWN.test(name)) continue;
      const initializer = attribute.getInitializer();
      if (!initializer || !Node.isJsxExpression(initializer)) continue;
      const expression = initializer.getExpression();
      // `<ExpiryBadge expiryDate={m.expiryDate} />`: the badge decides what is
      // drawn ("Expired", "In 12d"), not the raw date — it is shown through it.
      if (expression) {
        const outer = shownThrough;
        if (/^[A-Z]/.test(tag)) shownThrough = `<${tag}>`;
        visitExpression(expression, name, depth);
        shownThrough = outer;
      }
    }
    // One of the file's own components inside the card: what it draws is the card's too.
    if (/^[A-Z]/.test(tag) && !tag.includes('.') && depth < 3) {
      const fn = functionOf(reader.declaration(tag, opening.getSourceFile()));
      if (
        fn &&
        fn.getSourceFile() === sameFile &&
        !fn.containsRange(opening.getPos(), opening.getEnd())
      ) {
        tracer.callSites.set(fn, [opening]);
        for (const returned of returnsOf(fn)) {
          if (containsJsx(returned)) visitExpression(returned, 'text', depth + 1);
        }
      }
    }
    if (Node.isJsxElement(node)) {
      for (const child of node.getJsxChildren()) visitChild(child, node, depth);
    }
  };
  const visitChild = (child: Node, parent: Node, depth: number) => {
    if (Node.isJsxExpression(child)) {
      const expression = child.getExpression();
      if (expression) visitExpression(expression, textAround(parent), depth);
    } else if (isJsxNode(child)) visitJsx(child, depth);
  };

  visitJsx(element, 0);

  // What decides whether the card is drawn at all: the page waiting for its data.
  const component = enclosingComponent(element);
  around(tracer, element, component);

  const hooks = [...tracer.hooks.values()];
  const sources: CardSource[] = hooks.map((hook) => {
    const loads = loadsOf(flows, hook);
    return {
      hook: hook.hook,
      file: hook.file,
      line: hook.line,
      flows: loads.map((flow) => flow.id),
      endpoints: ownEndpoints(loads, hook.hook),
      fields: [...hook.fields].sort(),
      ...asking(element.getSourceFile(), hook),
    };
  });
  const fields: CardField[] = [];
  for (const hook of hooks) {
    const loads = loadsOf(flows, hook);
    const tops = [...new Set([...hook.fields].map((field) => field.split(/[.[]/)[0]!))].filter(
      Boolean,
    );
    for (const field of tops) {
      const made = serverMade(reader, loads, field);
      fields.push({
        field,
        ...(loads[0]?.endpoints[0] ? { endpoint: loads[0].endpoints[0] } : {}),
        made,
      });
    }
  }

  return {
    file: reader.relative(element.getSourceFile()),
    line: element.getStartLineNumber(),
    ...(component ? { component: componentName(component) } : {}),
    values,
    calculations: [...tracer.calculations.values()].sort(
      (a, b) => a.file.localeCompare(b.file) || a.line - b.line,
    ),
    sources,
    fields,
    conditions: [...tracer.conditions.values()].sort(
      (a, b) =>
        (a.where === b.where ? 0 : a.where === 'around' ? -1 : 1) ||
        a.file.localeCompare(b.file) ||
        a.line - b.line,
    ),
  };
}

/** Conditions on the way down to the card: in its component, then where that is drawn. */
function around(tracer: Tracer, element: Node, component: Node | undefined): void {
  let node: Node | undefined = element;
  let fn = component;
  for (let level = 0; node && level < 4; level++) {
    for (let up = node.getParent(); up && up !== fn; up = up.getParent()) {
      const inside = (part: Node) => part.containsRange(node!.getPos(), node!.getEnd());
      if (
        Node.isConditionalExpression(up) &&
        !inside(up.getCondition()) &&
        !Node.isConditionalExpression(up.getParent())
      ) {
        tracer.addCondition(up, 'around', node);
      } else if (
        Node.isBinaryExpression(up) &&
        /^(?:&&|\|\|)$/.test(up.getOperatorToken().getText()) &&
        inside(up.getRight())
      ) {
        tracer.addCondition(up, 'around', node);
      }
    }
    if (!fn || !isComponent(fn)) return;
    const site = tracer.callSitesOf(fn)[0];
    if (!site) return;
    node = site;
    fn = enclosingComponent(site);
  }
}

/** The loads that run a hook: those whose steps call it, from the file it is called in first. */
function loadsOf(flows: FeatureFlow[], hook: Hook): FeatureFlow[] {
  const running = flows.filter((flow) =>
    flow.steps.some((step) => step.kind === 'hook' && step.label === hook.hook),
  );
  const mounts = running.filter((flow) => flow.event === 'mount');
  const here = mounts.filter((flow) => flow.source?.file === hook.file);
  if (here.length > 0) return here;
  if (mounts.length > 0) return mounts.slice(0, 1);
  return running.slice(0, 1);
}

/**
 * Where the server makes `field`: the property of the object it returns, and
 * the other places that name is worked out — an aggregation's `$sum`, a
 * variable it is copied from.
 */
function serverMade(reader: SourceReader, loads: FeatureFlow[], field: string): CardField['made'] {
  const made: CardField['made'] = [];
  const seen = new Set<string>();
  const push = (node: Node, code: string, how: 'returned' | 'computed') => {
    const file = reader.relative(node.getSourceFile());
    const line = node.getStartLineNumber();
    const key = `${file}:${line}`;
    if (seen.has(key)) return;
    seen.add(key);
    made.push({ code: condense(code, 240), file, line, how });
  };
  for (const flow of loads) {
    for (const step of flow.steps) {
      if (step.layer !== 'backend' || !step.file || !step.line) continue;
      const source = reader.file(step.file);
      const fn = source ? functionAtLine(source, step.line) : undefined;
      if (!fn) continue;
      const returned: Node[] = [];
      for (const result of returnsOf(fn)) {
        const object = unwrap(result);
        if (!Node.isObjectLiteralExpression(object)) continue;
        const property = object.getProperty(field);
        if (!property) continue;
        returned.push(property);
        push(property, property.getText(), 'returned');
        // `field: totals.field` / `field,`: the variable it is read from.
        const from = Node.isShorthandPropertyAssignment(property)
          ? property.getNameNode()
          : Node.isPropertyAssignment(property)
            ? property.getInitializer()
            : undefined;
        const root = from && Node.isIdentifier(unwrap(from)) ? unwrap(from) : undefined;
        const variable = root
          ? fn
              .getDescendantsOfKind(SyntaxKind.VariableDeclaration)
              .find((declaration) => declaration.getName() === root.getText())
          : undefined;
        if (variable) push(variable, variable.getText(), 'computed');
      }
      if (returned.length === 0) continue;
      const computed: Node[] = [];
      for (const property of fn.getDescendantsOfKind(SyntaxKind.PropertyAssignment)) {
        if (property.getName() !== field || returned.includes(property)) continue;
        push(property, property.getText(), 'computed');
        computed.push(property);
      }
      // `inventoryValue: { $sum: "$cost" }` with `cost: batchSumExpr("purchasePrice")`
      // an earlier stage: the field is made from that, and that from the helper.
      for (const property of computed) {
        for (const literal of property.getDescendantsOfKind(SyntaxKind.StringLiteral)) {
          const ref = /^\$([A-Za-z_]\w*)$/.exec(literal.getLiteralValue())?.[1];
          if (!ref || ref === field) continue;
          for (const earlier of fn.getDescendantsOfKind(SyntaxKind.PropertyAssignment)) {
            const init = earlier.getInitializer();
            if (earlier.getName() !== ref || !init || /^(1|0|true|false)$/.test(init.getText()))
              continue;
            push(earlier, earlier.getText(), 'computed');
            const helper = Node.isCallExpression(init) ? init.getExpression() : undefined;
            const declared =
              helper && Node.isIdentifier(helper)
                ? (fn.getSourceFile().getFunction(helper.getText()) ??
                  fn.getSourceFile().getVariableDeclaration(helper.getText()))
                : undefined;
            if (declared) push(declared, declared.getText(), 'computed');
          }
        }
      }
    }
    if (made.length > 0) break;
  }
  return made;
}

// ---------------------------------------------------------------------------
// Reading helpers
// ---------------------------------------------------------------------------

function emptyFound(): Found {
  return { fields: new Set(), uses: new Set(), format: new Set(), hooks: new Set() };
}

function merge(into: Found, from: Found): void {
  for (const key of ['fields', 'uses', 'format', 'hooks'] as const) {
    for (const value of from[key]) into[key].add(value);
  }
}

/** The JSX element whose tag starts on `line`: the card, or a link in it. */
function elementAt(source: SourceFile, line: number): Node | undefined {
  const openings = [
    ...source.getDescendantsOfKind(SyntaxKind.JsxOpeningElement),
    ...source.getDescendantsOfKind(SyntaxKind.JsxSelfClosingElement),
  ]
    .filter((opening) => opening.getStartLineNumber() === line)
    .sort((a, b) => a.getStart() - b.getStart());
  const opening = openings[0];
  if (!opening) return undefined;
  return Node.isJsxOpeningElement(opening) ? opening.getParent() : opening;
}

function openingsNamed(source: SourceFile, name: string): Node[] {
  return [
    ...source.getDescendantsOfKind(SyntaxKind.JsxOpeningElement),
    ...source.getDescendantsOfKind(SyntaxKind.JsxSelfClosingElement),
  ]
    .filter((opening) => opening.getTagNameNode().getText() === name)
    .sort((a, b) => a.getStart() - b.getStart());
}

function propValue(site: Node, prop: string): Node | undefined {
  if (!Node.isJsxOpeningElement(site) && !Node.isJsxSelfClosingElement(site)) return undefined;
  const attribute = site.getAttribute(prop);
  if (!attribute || !Node.isJsxAttribute(attribute)) return undefined;
  const initializer = attribute.getInitializer();
  if (!initializer) return undefined;
  return Node.isJsxExpression(initializer) ? initializer.getExpression() : initializer;
}

function isFunction(node: Node): boolean {
  return (
    Node.isFunctionDeclaration(node) ||
    Node.isFunctionExpression(node) ||
    Node.isArrowFunction(node) ||
    Node.isMethodDeclaration(node)
  );
}

function componentName(fn: Node): string | undefined {
  const name = nameOf(fn);
  return /^[A-Z]/.test(name) ? name : undefined;
}

function isComponent(fn: Node): boolean {
  return componentName(fn) !== undefined;
}

function enclosingComponent(node: Node): Node | undefined {
  for (let up = node.getParent(); up; up = up.getParent()) {
    if (isFunction(up) && isComponent(up)) return up;
  }
  return undefined;
}

/** `const x = …` declared directly in `scope`, or exported from it. */
function declarationIn(scope: Node, name: string): Node | undefined {
  const statements = (scope as unknown as { getStatements(): Node[] }).getStatements();
  for (const statement of statements) {
    if (!Node.isVariableStatement(statement)) continue;
    for (const declaration of statement.getDeclarations()) {
      if (binds(declaration.getNameNode(), name)) return declaration;
    }
  }
  return undefined;
}

/** Does a parameter or binding name declare `name`? */
function binds(node: Node, name: string): boolean {
  const target = Node.isParameterDeclaration(node) ? node.getNameNode() : node;
  if (Node.isIdentifier(target)) return target.getText() === name;
  return target
    .getDescendantsOfKind(SyntaxKind.BindingElement)
    .some((element) => element.getNameNode().getText() === name);
}

/**
 * The path a destructured name is read from: `{ data: { rows } }` binds
 * `rows` to `data.rows`; a plain name is the whole value.
 */
function bindingPath(node: Node, name: string): string[] {
  const target = Node.isParameterDeclaration(node) ? node.getNameNode() : node;
  if (Node.isIdentifier(target)) return [];
  const element = target
    .getDescendantsOfKind(SyntaxKind.BindingElement)
    .find((candidate) => candidate.getNameNode().getText() === name);
  if (!element) return [];
  const path: string[] = [];
  for (let up: Node | undefined = element; up && up !== target.getParent(); up = up.getParent()) {
    if (Node.isBindingElement(up)) {
      const key = up.getPropertyNameNode()?.getText() ?? up.getNameNode().getText();
      path.unshift(Node.isArrayBindingPattern(up.getParent()) ? '[]' : key);
    }
  }
  return path;
}

/** `useDashboard()`, `useQuery(…)`, `React.useContext(…)`. */
function hookCall(value: Node): string | undefined {
  if (!Node.isCallExpression(value)) return undefined;
  const name = value.getExpression().getText().split('.').pop() ?? '';
  return /^use[A-Z]/.test(name) ? name : undefined;
}

/** `['recentMovements', '[]', 'reason']` -> `recentMovements[].reason`. */
function fieldName(path: string[]): string | undefined {
  const parts = path.filter((part) => !PASS_THROUGH.has(part));
  if (parts.length === 0) return undefined;
  return parts.reduce(
    (text, part) => (part === '[]' ? `${text}[]` : text ? `${text}.${part}` : part),
    '',
  );
}

/** A value that is the data itself, not worked out from it: a path is followed through it. */
function passesChain(value: Node): boolean {
  return (
    Node.isIdentifier(value) ||
    Node.isPropertyAccessExpression(value) ||
    Node.isElementAccessExpression(value) ||
    (Node.isBinaryExpression(value) && /^(?:\?\?|\|\|)$/.test(value.getOperatorToken().getText()))
  );
}

/** `data.recent.slice(0, 5)` -> `data` with the path `recent`. */
function rootOf(node: Node): { identifier: Node; chain: string[] } | undefined {
  // Up from an identifier to the end of its access chain.
  let top = node;
  while (true) {
    const parent = top.getParent();
    if (!parent) break;
    if (
      (Node.isPropertyAccessExpression(parent) || Node.isElementAccessExpression(parent)) &&
      parent.getExpression() === top
    ) {
      top = parent;
      continue;
    }
    if (Node.isNonNullExpression(parent) || Node.isParenthesizedExpression(parent)) {
      top = parent;
      continue;
    }
    break;
  }
  // Then down, collecting names.
  const chain: string[] = [];
  let current: Node = Node.isIdentifier(node) ? top : node;
  while (true) {
    current = unwrap(current);
    if (Node.isPropertyAccessExpression(current)) {
      chain.unshift(current.getName());
      current = current.getExpression();
    } else if (Node.isElementAccessExpression(current)) {
      const key = current.getArgumentExpression();
      chain.unshift(key && Node.isStringLiteral(key) ? key.getLiteralValue() : '[]');
      current = current.getExpression();
    } else if (Node.isCallExpression(current)) {
      // `rows.slice(0, 5)`: still `rows`.
      const callee = current.getExpression();
      if (!Node.isPropertyAccessExpression(callee) || !PASS_THROUGH.has(callee.getName()))
        return undefined;
      current = callee.getExpression();
    } else break;
  }
  if (!Node.isIdentifier(current)) return undefined;
  // A path stops at a method: `.toFixed`, `.map` are not fields.
  const end = chain.findIndex((part) => PASS_THROUGH.has(part));
  return { identifier: current, chain: end >= 0 ? chain.slice(0, end) : chain };
}

/**
 * The names an expression reads: identifiers that are not property names,
 * JSX tags or attribute names, types, or declared inside it.
 */
function references(expression: Node): Node[] {
  const found: Node[] = [];
  const visit = (node: Node) => {
    if (Node.isTypeNode(node)) return;
    if (Node.isIdentifier(node)) {
      const parent = node.getParent();
      if (
        parent &&
        ((Node.isPropertyAccessExpression(parent) && parent.getNameNode() === node) ||
          (Node.isPropertyAssignment(parent) && parent.getNameNode() === node) ||
          Node.isJsxAttribute(parent) ||
          Node.isJsxOpeningElement(parent) ||
          Node.isJsxClosingElement(parent) ||
          Node.isJsxSelfClosingElement(parent) ||
          Node.isParameterDeclaration(parent) ||
          Node.isBindingElement(parent))
      ) {
        return;
      }
      // Only the head of an access chain: `data` in `data.x.y`.
      if (
        parent &&
        (Node.isPropertyAccessExpression(parent) || Node.isElementAccessExpression(parent))
      ) {
        if (parent.getExpression() !== node) return;
      }
      found.push(node);
      return;
    }
    node.forEachChild(visit);
  };
  visit(expression);
  // One per access chain.
  const seen = new Set<Node>();
  return found.filter((node) => !seen.has(node) && seen.add(node));
}

function containsJsx(node: Node): boolean {
  if (isJsxNode(node)) return true;
  return (
    node.getFirstDescendant(
      (child) =>
        Node.isJsxElement(child) ||
        Node.isJsxSelfClosingElement(child) ||
        Node.isJsxFragment(child),
    ) !== undefined
  );
}

function jsxTags(node: Node): string[] {
  return [
    ...node.getDescendantsOfKind(SyntaxKind.JsxOpeningElement),
    ...node.getDescendantsOfKind(SyntaxKind.JsxSelfClosingElement),
  ]
    .sort((a, b) => a.getStart() - b.getStart())
    .map((opening) => opening.getTagNameNode().getText());
}

function isJsxNode(node: Node): boolean {
  return Node.isJsxElement(node) || Node.isJsxSelfClosingElement(node) || Node.isJsxFragment(node);
}

/** `a ? x : b ? y : z` -> conditions `a`, `b` and results `x`, `y`, `z`. */
function chainOf(node: Node): { conditions: Node[]; results: Node[] } {
  const conditions: Node[] = [];
  const results: Node[] = [];
  let current: Node = node;
  while (Node.isConditionalExpression(current)) {
    conditions.push(current.getCondition());
    results.push(current.getWhenTrue());
    current = unwrap(current.getWhenFalse());
  }
  results.push(current);
  return { conditions, results };
}

/** What a branch draws, in a few words. */
function describe(node: Node): string {
  const value = unwrap(node);
  const text = stringOf(value);
  if (text !== undefined) return `“${text}”`;
  if (Node.isObjectLiteralExpression(value)) {
    for (const property of value.getProperties()) {
      if (!Node.isPropertyAssignment(property)) continue;
      const inner = stringOf(property.getInitializer());
      if (inner) return `“${inner}”`;
    }
  }
  if (Node.isNullLiteral(value) || value.getText() === 'undefined') return 'nothing';
  if (isJsxNode(value)) {
    const opening = Node.isJsxElement(value) ? value.getOpeningElement() : value;
    if (Node.isJsxFragment(opening)) return 'its content';
    const tag =
      Node.isJsxOpeningElement(opening) || Node.isJsxSelfClosingElement(opening)
        ? opening.getTagNameNode().getText()
        : '';
    const title =
      Node.isJsxOpeningElement(opening) || Node.isJsxSelfClosingElement(opening)
        ? ['title', 'label', 'emptyLabel']
            .map((name) => {
              const attribute = opening.getAttribute(name);
              return attribute && Node.isJsxAttribute(attribute)
                ? stringOf(attribute.getInitializer())
                : undefined;
            })
            .find(Boolean)
        : undefined;
    const words = Node.isJsxElement(value) ? textAround(value) : '';
    if (/^[a-z]/.test(tag)) {
      if (words && words !== 'text') return `“${condense(words, 50)}”`;
      // A plain wrapper: named by the first component it draws — `Skeleton`, `ActivityRow`.
      const named = jsxTags(value).find((name) => /^[A-Z]/.test(name));
      return named ? `${named}…` : `<${tag}>`;
    }
    return title ? `${tag} “${title}”` : tag;
  }
  if (Node.isCallExpression(value)) {
    const callee = value.getExpression();
    if (Node.isPropertyAccessExpression(callee) && callee.getName() === 'map') {
      const named = jsxTags(value).find((name) => /^[A-Z]/.test(name));
      return `a row per item${named ? ` (${named})` : ''}`;
    }
  }
  return condense(value.getText(), 50);
}

/** A string written out: `"Good"`, `{"Good"}`. */
function stringOf(node: Node | undefined): string | undefined {
  if (!node) return undefined;
  const value = Node.isJsxExpression(node) ? node.getExpression() : node;
  if (!value) return undefined;
  if (Node.isStringLiteral(value) || Node.isNoSubstitutionTemplateLiteral(value)) {
    return value.getLiteralValue();
  }
  return undefined;
}

/** The words of an element with its values as `{…}`: "{…} of {…} medicines adequately stocked". */
function textAround(element: Node): string {
  if (!Node.isJsxElement(element)) return 'text';
  const parts: string[] = [];
  for (const child of element.getJsxChildren()) {
    if (Node.isJsxText(child)) {
      const text = child.getLiteralText().replace(/\s+/g, ' ').trim();
      if (text) parts.push(text);
    } else if (Node.isJsxExpression(child) && child.getExpression()) {
      const text = stringOf(child);
      parts.push(text ?? '{…}');
    }
  }
  const text = parts.join(' ').trim();
  return /[A-Za-z]/.test(text) ? condense(text, 80) : 'text';
}

/**
 * The requests written inside one hook, not the whole load it is part of:
 * `useMeta` is `GET /meta`, though the page load it runs in also sends
 * `GET /medicines`. Read from where each request is written — in the hook's
 * file, after the hook starts and before the next hook there does.
 */
function ownEndpoints(loads: FeatureFlow[], hookName: string): string[] {
  const found = new Set<string>();
  for (const flow of loads) {
    const hook = flow.steps.find((step) => step.kind === 'hook' && step.label === hookName);
    if (!hook?.file || hook.line === undefined) {
      for (const endpoint of flow.endpoints) found.add(endpoint);
      continue;
    }
    const nextHook = Math.min(
      ...flow.steps
        .filter(
          (step) =>
            step.kind === 'hook' && step.file === hook.file && (step.line ?? 0) > hook.line!,
        )
        .map((step) => step.line!),
      Infinity,
    );
    for (const step of flow.steps) {
      if (step.kind !== 'api-call' || step.file !== hook.file || step.line === undefined) continue;
      if (step.line >= hook.line && step.line < nextHook) found.add(step.label);
    }
  }
  return [...found];
}

/**
 * The arguments of the hook call a card's data comes from: which rows it is
 * — `useMedicines({ expiring: true, sortBy: "expiryDate", pageSize: 5 })` is
 * the five soonest to expire, not "the medicines".
 */
function asking(file: SourceFile, hook: { hook: string; line: number }): { asks?: string } {
  const asks = argumentsAt(file, hook);
  return asks ? { asks } : {};
}

function argumentsAt(file: SourceFile, hook: { hook: string; line: number }): string | undefined {
  const call = file
    .getDescendantsOfKind(SyntaxKind.CallExpression)
    .find(
      (candidate) =>
        candidate.getExpression().getText() === hook.hook &&
        candidate.getStartLineNumber() === hook.line,
    );
  const args = call?.getArguments() ?? [];
  if (args.length === 0) return undefined;
  return args.map((arg) => arg.getText().replace(/\s+/g, ' ')).join(', ');
}
