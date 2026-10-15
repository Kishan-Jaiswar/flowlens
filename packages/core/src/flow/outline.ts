import { Node, SyntaxKind, type SourceFile } from 'ts-morph';
import type { SourceReader } from './actionsource.js';
import { normalizeRoute } from './navigation.js';

/**
 * A screen, read top to bottom.
 *
 * The JSX of a page is written in the order it is drawn, so walking it — and
 * the project's own components it draws, where it draws them — gives the
 * screen's outline: its cards and sections, by the title they show; the
 * controls in each, by where their handlers are written; the components drawn
 * in each, whose loads run there; and the links, by where they go.
 *
 * It is a reading, not a render: a branch is walked whether or not it shows,
 * and a list drawn from data is one row standing for all of them.
 */

export type OutlineNode =
  | {
      type: 'section';
      label: string;
      file: string;
      line: number;
      children: OutlineNode[];
      /**
       * Drawn only while this holds — `openDownloadReportPopup` for a popup:
       * the part the button that sets it opens.
       */
      opensWhen?: string;
      /** No title of its own: named after what opens it, or what it repeats. */
      untitled?: boolean;
      /** One per item of a data list: the buttons on each invoice row. */
      repeated?: boolean;
      /** What one tab shows: the page's own controls, behind a tab. */
      tabContent?: boolean;
    }
  /** An element with a handler (`onClick`, `onSubmit`, …), by the lines of its tag. */
  | {
      type: 'handler';
      file: string;
      start: number;
      end: number;
      /** The file that draws the component this handler is in: `<Pagination>` on the stock page. */
      site?: string;
    }
  /** A component drawn here: its loads run at this point of the screen. */
  | { type: 'component'; file: string; name?: string }
  | {
      type: 'link';
      label?: string;
      /** `/medicines`, `/medicines/[param]` — the page-file spelling. */
      to: string;
      /** As written, query included: `/medicines?stockFilter=low-stock`. */
      href: string;
      /** Drawn once per item of a list: one row stands for all of them. */
      repeated?: boolean;
      file: string;
      line: number;
    };

/** A container whose title names a part of the screen: a card, a panel, a dialog. */
const SECTION_TAG =
  /^(?:section|article|fieldset|dialog)$|(?:Card|Section|Panel|Widget|Tile|Dialog|Drawer|Modal|Sheet|Popup|Popover|EmptyState|Empty|Banner|Callout)$/;
const NOT_SECTION =
  /^(?:Card|Dialog|Drawer|Modal|Sheet)(?:Title|Header|Content|Footer|Description|Action|Trigger|Close)$/;
/** Where a section's title is written, when it is not a prop. */
const TITLE_TAG = /^(?:h[1-4]|legend|[A-Z]\w*Title)$/;
const LINK_TAG = /^(?:a|Link|NavLink|NextLink|RouterLink)$/;
const TITLE_PROPS = ['title', 'heading', 'header', 'label'];

/** How far into the project's components the walk follows. */
const MAX_DEPTH = 6;
/** Elements one outline may visit, so a huge screen cannot stall the server. */
const MAX_ELEMENTS = 6000;

type Env = Map<string, Node[]>;

interface Walk {
  reader: SourceReader;
  stack: string[];
  visited: number;
  /** The files that drew each component walked into, innermost last. */
  sites: string[];
}

/** The outline of the component `name` in `file`, or of the file's default export. */
export function screenOutline(reader: SourceReader, file: string, name?: string): OutlineNode[] {
  const source = reader.file(file);
  if (!source) return [];
  const fn = componentFunction(reader, source, name);
  if (!fn) return [];
  const out: OutlineNode[] = [];
  walkFunction(fn, out, { reader, stack: [], visited: 0, sites: [] }, new Map(), name);
  return out;
}

function componentFunction(
  reader: SourceReader,
  source: SourceFile,
  name?: string,
): Node | undefined {
  let declaration: Node | undefined;
  if (name) declaration = reader.declaration(name, source);
  else {
    // By the `default` keyword: asking ts-morph starts the type checker.
    declaration = source
      .getFunctions()
      .find((fn) => fn.getModifiers().some((m) => m.getKind() === SyntaxKind.DefaultKeyword));
    if (!declaration) {
      const assignment = source.getExportAssignment((entry) => !entry.isExportEquals());
      const expression = assignment?.getExpression();
      declaration =
        expression && Node.isIdentifier(expression)
          ? reader.declaration(expression.getText(), source)
          : expression;
    }
  }
  return functionOf(declaration);
}

/** `function X`, `const X = () =>`, `memo(() => …)`, `forwardRef(function …)`. */
function functionOf(node: Node | undefined): Node | undefined {
  if (!node) return undefined;
  if (
    Node.isFunctionDeclaration(node) ||
    Node.isArrowFunction(node) ||
    Node.isFunctionExpression(node)
  ) {
    return node;
  }
  if (Node.isVariableDeclaration(node)) return functionOf(node.getInitializer());
  if (Node.isCallExpression(node)) return functionOf(node.getArguments()[0]);
  return undefined;
}

/** Sections made by the element a component returns: the component is that card or dialog. */
const rootSections = new WeakMap<OutlineNode, Node>();

function walkFunction(fn: Node, out: OutlineNode[], walk: Walk, env: Env, name?: string): void {
  const file = walk.reader.relative(fn.getSourceFile());
  const drawn: OutlineNode[] = [{ type: 'component', file, ...(name ? { name } : {}) }];
  const root = returnedJsx(fn);
  for (const { node, env: inner } of outerJsx(fn, env)) {
    walkJsx(node, drawn, walk, inner, node === root);
  }
  /**
   * A component that returns one dialog or card is that dialog or card: the
   * footer it builds in a variable first, and what it loads, are inside it.
   */
  const section = root ? drawn.find((entry) => rootSections.get(entry) === root) : undefined;
  if (section && section.type === 'section') {
    const before = drawn.slice(0, drawn.indexOf(section));
    const after = drawn.slice(drawn.indexOf(section) + 1);
    section.children = [...before, ...section.children, ...after];
    out.push(section);
    return;
  }
  out.push(...drawn);
}

const POPUP_TAG = /(?:Popup|Modal|Dialog|Drawer|Sheet|Overlay|Popover|Lightbox)/;

/** A popup, modal or drawer: by its name, or by an `isOpen`/`open`/`show` prop. */
function popupLike(tag: string, opening: Node): boolean {
  if (POPUP_TAG.test(tag) && !NOT_SECTION.test(tag)) return true;
  if (!Node.isJsxOpeningElement(opening) && !Node.isJsxSelfClosingElement(opening)) return false;
  return (
    /^[A-Z]/.test(tag) &&
    ['isOpen', 'open', 'show', 'visible'].some((name) => opening.getAttribute(name))
  );
}

/** `open={addOpen}`, `isOpen={Boolean(viewBill)}`: the state that opens it. */
function openProp(opening: Node): string | undefined {
  if (!Node.isJsxOpeningElement(opening) && !Node.isJsxSelfClosingElement(opening))
    return undefined;
  for (const name of ['open', 'isOpen', 'show', 'visible']) {
    const attr = opening.getAttribute(name);
    const init = attr && Node.isJsxAttribute(attr) ? attr.getInitializer() : undefined;
    const value = init && Node.isJsxExpression(init) ? init.getExpression() : undefined;
    if (value && !/^(true|false)$/.test(value.getText())) return value.getText();
  }
  return undefined;
}

/** `{open && <X/>}` / `{open ? <X/> : null}`: the condition the element is drawn under. */
function drawnWhen(node: Node): string | undefined {
  let current: Node = node;
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

/**
 * `bills.map((bill) => <tr>…</tr>)` over data, with something to press in the
 * row: "Each bill". A row drawn from a list written in the code (tiles) is not
 * repeated data, and stays as its items.
 */
function repeatedRow(node: Node, tag: string): string | undefined {
  // `<tr>`, a table component's `<TR>`, a list's `<li>`, a mobile `<details>` card.
  if (!/^(tr|li|details)$/i.test(tag) && !/Row$|Item$/.test(tag)) return undefined;
  const callback = node.getFirstAncestor(
    (ancestor) => Node.isArrowFunction(ancestor) || Node.isFunctionExpression(ancestor),
  );
  const call = callback?.getParent();
  if (!call || !Node.isCallExpression(call)) return undefined;
  const callee = call.getExpression();
  if (!Node.isPropertyAccessExpression(callee) || callee.getName() !== 'map') return undefined;
  if (arrayItems(callee.getExpression())) return undefined;
  const pressable = node
    .getDescendantsOfKind(SyntaxKind.JsxAttribute)
    .some((attribute) => /^on[A-Z]/.test(attribute.getNameNode().getText()));
  if (!pressable) return undefined;
  const param = (callback as Node & { getParameters?: () => Node[] }).getParameters?.()[0];
  const name = param && Node.isParameterDeclaration(param) ? param.getName() : '';
  // `bills.map((bill) …)` -> "Each bill"; `data.map((m) …)` says nothing -> "Each row".
  const list = callee.getExpression().getText().split('.').pop()?.replace(/\?$/, '') ?? '';
  const singular = list.replace(/ies$/, 'y').replace(/s$/, '');
  const word =
    /^[a-z][\w$]{2,}$/i.test(name) && !/^(item|el|row|entry|data|x|i)$/i.test(name)
      ? name
      : /^[a-z][\w$]{2,}$/i.test(singular) &&
          !/^(data|item|row|result|list|entrie|record)$/i.test(singular)
        ? singular
        : 'row';
  return `Each ${humanTag(word).toLowerCase()}`;
}

/** The title a popup's content shows when it is a component: its first heading. */
function childHeading(node: Node, walk: Walk): string | undefined {
  const inner = node
    .getDescendants()
    .find(
      (child) =>
        (Node.isJsxOpeningElement(child) || Node.isJsxSelfClosingElement(child)) &&
        /^[A-Z]/.test(child.getTagNameNode().getText()) &&
        !child.getTagNameNode().getText().includes('.'),
    );
  if (!inner || (!Node.isJsxOpeningElement(inner) && !Node.isJsxSelfClosingElement(inner)))
    return undefined;
  const fn = functionOf(
    walk.reader.declaration(inner.getTagNameNode().getText(), node.getSourceFile()),
  );
  if (!fn) return undefined;
  for (const element of fn.getDescendantsOfKind(SyntaxKind.JsxElement)) {
    if (!TITLE_TAG.test(element.getOpeningElement().getTagNameNode().getText())) continue;
    const text = element
      .getJsxChildren()
      .filter(Node.isJsxText)
      .map((child) => child.getLiteralText().replace(/\s+/g, ' ').trim())
      .join(' ')
      .trim();
    if (/[A-Za-z]{2}/.test(text)) return text;
  }
  return undefined;
}

/** `PopupContainer` -> "Popup container", `bill` -> "Bill". */
function humanTag(tag: string): string {
  const words = tag.replace(/([a-z0-9])([A-Z])/g, '$1 $2').toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** The JSX a component returns at its top level: `return (<X …/>)`, or an arrow's body. */
function returnedJsx(fn: Node): Node | undefined {
  const unwrap = (node: Node | undefined): Node | undefined => {
    while (node && Node.isParenthesizedExpression(node)) node = node.getExpression();
    return node && isJsx(node) ? node : undefined;
  };
  if (Node.isArrowFunction(fn) && !Node.isBlock(fn.getBody())) return unwrap(fn.getBody());
  const body = (fn as Node & { getBody?: () => Node | undefined }).getBody?.();
  if (!body || !Node.isBlock(body)) return undefined;
  const statements = body.getStatements().filter(Node.isReturnStatement);
  return unwrap(statements[statements.length - 1]?.getExpression());
}

function walkJsx(node: Node, out: OutlineNode[], walk: Walk, env: Env, isRoot = false): void {
  if (++walk.visited > MAX_ELEMENTS) return;
  const opening = Node.isJsxElement(node) ? node.getOpeningElement() : node;
  const file = walk.reader.relative(node.getSourceFile());
  if (!Node.isJsxOpeningElement(opening) && !Node.isJsxSelfClosingElement(opening)) {
    // A fragment: only its children.
    for (const child of outerJsx(node, env, true)) walkJsx(child.node, out, walk, child.env);
    return;
  }
  const tag = opening.getTagNameNode().getText();

  let container = out;
  const label =
    SECTION_TAG.test(tag) && !NOT_SECTION.test(tag) ? sectionTitle(node, opening) : undefined;
  // `{open && <PopupContainer isOpen={open}>…}`: a part of the screen that
  // opens on demand, titled or not, is one part — not its controls loose.
  // Titled or not: a dialog opens on a condition, written around it or as its
  // `open`/`isOpen` prop (`<AddMedicineDialog open={addOpen}>`).
  const opensWhen = popupLike(tag, opening) ? (drawnWhen(node) ?? openProp(opening)) : undefined;
  // `bills.map((bill) => <tr>…<button/>…</tr>)`: the buttons on each row.
  const row = !label && !opensWhen ? repeatedRow(node, tag) : undefined;
  if (label || opensWhen || row) {
    const title = label ?? (opensWhen ? childHeading(node, walk) : undefined);
    const section: OutlineNode = {
      type: 'section',
      label: title ?? row ?? humanTag(tag),
      file,
      line: opening.getStartLineNumber(),
      children: [],
      ...(opensWhen ? { opensWhen } : {}),
      ...(!title ? { untitled: true } : {}),
      ...(row ? { repeated: true } : {}),
    };
    out.push(section);
    container = section.children;
    if (isRoot) rootSections.set(section, node);
  }

  if (
    opening
      .getAttributes()
      .some(
        (attribute) =>
          Node.isJsxAttribute(attribute) && /^on[A-Z]/.test(attribute.getNameNode().getText()),
      )
  ) {
    container.push({
      type: 'handler',
      file,
      start: opening.getStartLineNumber(),
      end: opening.getEndLineNumber(),
      ...(walk.sites.length ? { site: walk.sites.at(-1)! } : {}),
    });
  }

  const href = attribute(opening, 'href') ?? attribute(opening, 'to');
  if (href && (LINK_TAG.test(tag) || /^[A-Z]/.test(tag))) {
    container.push(...links(node, href, env, walk.reader, file, opening.getStartLineNumber()));
  }
  // `<PageHeader breadcrumbs={[{ label: "Medicines", href: "/medicines" }, …]}>`:
  // links handed to a component as data — it draws a `<Link>` for each.
  if (/^[A-Z]/.test(tag)) {
    for (const attr of opening.getAttributes()) {
      if (!Node.isJsxAttribute(attr)) continue;
      const init = attr.getInitializer();
      const value = init && Node.isJsxExpression(init) ? init.getExpression() : undefined;
      if (!value || !Node.isArrayLiteralExpression(value)) continue;
      for (const entry of value.getElements()) {
        if (!Node.isObjectLiteralExpression(entry)) continue;
        const read = (key: string): string | undefined => {
          const property = entry.getProperty(key);
          const text =
            property && Node.isPropertyAssignment(property) ? property.getInitializer() : undefined;
          return text && (Node.isStringLiteral(text) || Node.isNoSubstitutionTemplateLiteral(text))
            ? text.getLiteralValue()
            : undefined;
        };
        const to = read('href') ?? read('to') ?? templateRoute(entry, 'href');
        if (!to || !isRoute(to)) continue;
        const label = read('label') ?? read('title') ?? read('name') ?? fieldShown(entry, 'label');
        container.push({
          type: 'link',
          to: normalizeRoute(to),
          href: to.startsWith('/') ? to : `/${to}`,
          file,
          line: entry.getStartLineNumber(),
          ...(label ? { label } : {}),
        });
      }
    }
  }

  // The project's own component, drawn here: walk what it draws.
  if (
    /^[A-Z]/.test(tag) &&
    !tag.includes('.') &&
    walk.stack.length < MAX_DEPTH &&
    !walk.stack.includes(tag)
  ) {
    const declaration = walk.reader.declaration(tag, node.getSourceFile());
    const fn = functionOf(declaration);
    if (fn && !fn.getSourceFile().getFilePath().includes('/node_modules/')) {
      walk.stack.push(tag);
      walk.sites.push(file);
      // The words it is given here: `<MedicineForm mode="edit">`.
      PROPS.push(
        new Map(
          opening.getAttributes().flatMap((attr) => {
            if (!Node.isJsxAttribute(attr)) return [];
            const init = attr.getInitializer();
            return init && Node.isStringLiteral(init)
              ? [[attr.getNameNode().getText(), init.getLiteralValue()] as const]
              : [];
          }),
        ),
      );
      try {
        walkFunction(fn, container, walk, new Map(), tag);
      } finally {
        PROPS.pop();
        walk.sites.pop();
        walk.stack.pop();
      }
    }
  }

  const tabs = new Map<string, OutlineNode & { type: 'section' }>();
  for (const child of outerJsx(node, env, true)) {
    if (!child.tab) {
      walkJsx(child.node, container, walk, child.env);
      continue;
    }
    let part = tabs.get(child.tab);
    if (!part) {
      part = {
        type: 'section',
        label: child.tab,
        file,
        line: child.node.getStartLineNumber(),
        children: [],
        tabContent: true,
      };
      tabs.set(child.tab, part);
      container.push(part);
    }
    walkJsx(child.node, part.children, walk, child.env);
  }
}

/**
 * The JSX directly inside a node — not inside other JSX — in source order,
 * with what each `list.map((item) => …)` binds `item` to when `list` is an
 * array written in the code.
 */
function outerJsx(
  root: Node,
  env: Env,
  skipSelf = false,
): Array<{ node: Node; env: Env; tab?: string }> {
  const found: Array<{ node: Node; env: Env; tab?: string }> = [];
  let tab: string | undefined;
  const visit = (node: Node, scope: Env) => {
    if (!(skipSelf && node === root) && isJsx(node)) {
      found.push({ node, env: scope, ...(tab ? { tab } : {}) });
      return;
    }
    // `{tab === "excels" ? <ImportHistoryView /> : <History />}`: one tab's
    // content or the other's, each a part of its own — not one list of both.
    const arms = node !== root ? tabArms(node) : undefined;
    if (arms) {
      const outer = tab;
      for (const [arm, label] of arms) {
        tab = label;
        visit(arm, scope);
      }
      tab = outer;
      return;
    }
    // A component declared inside another is its own component.
    if (node !== root && Node.isFunctionDeclaration(node) && /^[A-Z]/.test(node.getName() ?? ''))
      return;
    let next = scope;
    if (Node.isCallExpression(node)) next = bindMap(node, scope);
    node.forEachChild((child) => visit(child, next));
  };
  visit(root, env);
  return found;
}

/**
 * The two arms of `tab === "excels" ? A : B`, each named by the button that
 * picks it: the one calling `setTab("excels")` ("Excels"), and the others
 * ("Stock history"). Only a choice the user makes with such buttons counts.
 */
function tabArms(node: Node): Array<[Node, string]> | undefined {
  if (!Node.isConditionalExpression(node)) return undefined;
  const test = node.getCondition();
  if (!Node.isBinaryExpression(test) || !/^[=!]==?$/.test(test.getOperatorToken().getText()))
    return undefined;
  const [state, literal] = Node.isStringLiteral(test.getRight())
    ? [test.getLeft(), test.getRight()]
    : [test.getRight(), test.getLeft()];
  if (!Node.isIdentifier(state) || !Node.isStringLiteral(literal)) return undefined;
  if (![node.getWhenTrue(), node.getWhenFalse()].every((arm) => containsJsx(arm))) return undefined;
  const component = node.getFirstAncestor(
    (ancestor) => Node.isFunctionDeclaration(ancestor) || Node.isArrowFunction(ancestor),
  );
  if (!component) return undefined;
  const setter = `set${state.getText().charAt(0).toUpperCase()}${state.getText().slice(1)}`;
  const pickers = new Map<string, string>();
  for (const call of component.getDescendantsOfKind(SyntaxKind.CallExpression)) {
    const value = call.getArguments()[0];
    if (call.getExpression().getText() !== setter || !value || !Node.isStringLiteral(value))
      continue;
    const element = call.getFirstAncestor((ancestor) => Node.isJsxElement(ancestor));
    const words =
      element && Node.isJsxElement(element)
        ? element
            .getDescendantsOfKind(SyntaxKind.JsxText)
            .map((text) => text.getText().replace(/\s+/g, ' ').trim())
            .filter(Boolean)
            .join(' ')
        : '';
    if (words && !pickers.has(value.getLiteralValue())) pickers.set(value.getLiteralValue(), words);
  }
  const chosen = pickers.get(literal.getLiteralValue());
  const others = [...pickers]
    .filter(([value]) => value !== literal.getLiteralValue())
    .map(([, words]) => words);
  if (!chosen || others.length === 0) return undefined;
  const equals = !test.getOperatorToken().getText().startsWith('!');
  const [whenTrue, whenFalse] = equals
    ? [chosen, others.join(' / ')]
    : [others.join(' / '), chosen];
  return [
    [node.getWhenTrue(), `${whenTrue} tab`],
    [node.getWhenFalse(), `${whenFalse} tab`],
  ];
}

function containsJsx(node: Node): boolean {
  return isJsx(node) || node.getDescendants().some((inner) => isJsx(inner));
}

function isJsx(node: Node): boolean {
  return Node.isJsxElement(node) || Node.isJsxSelfClosingElement(node) || Node.isJsxFragment(node);
}

/** `tiles.map((t) => …)` with `const tiles = [{ … }, …]`: `t` is each of those objects. */
function bindMap(call: Node, scope: Env): Env {
  if (!Node.isCallExpression(call)) return scope;
  const callee = call.getExpression();
  if (!Node.isPropertyAccessExpression(callee) || callee.getName() !== 'map') return scope;
  const callback = call.getArguments()[0];
  if (!callback || !(Node.isArrowFunction(callback) || Node.isFunctionExpression(callback)))
    return scope;
  const param = callback.getParameters()[0]?.getNameNode();
  if (!param || !Node.isIdentifier(param)) return scope;
  const items = arrayItems(callee.getExpression());
  const next = new Map(scope);
  // Bound to nothing: a list drawn from data, read as one row for all of them.
  next.set(param.getText(), items ?? []);
  return next;
}

function arrayItems(expression: Node): Node[] | undefined {
  let target: Node | undefined = expression;
  if (Node.isIdentifier(expression)) target = localValue(expression);
  while (target && Node.isAsExpression(target)) target = target.getExpression();
  if (!target || !Node.isArrayLiteralExpression(target)) return undefined;
  const items = target.getElements().filter(Node.isObjectLiteralExpression);
  return items.length > 0 ? items : undefined;
}

/**
 * What a name is bound to in the scopes around it — `const tiles = […]` in the
 * component, or at the top of the file. Read by hand: resolving the symbol
 * starts the type checker, which costs seconds on a large app.
 */
function localValue(name: Node): Node | undefined {
  const text = name.getText();
  for (let scope: Node | undefined = name.getParent(); scope; scope = scope.getParent()) {
    if (!Node.isBlock(scope) && !Node.isSourceFile(scope)) continue;
    for (const statement of scope.getStatements()) {
      if (!Node.isVariableStatement(statement)) continue;
      const declaration = statement.getDeclarations().find((entry) => entry.getName() === text);
      if (declaration) return declaration.getInitializer();
    }
  }
  return undefined;
}

/** A section's title: a `title` prop written out, or the text of its title element. */
function sectionTitle(node: Node, opening: Node): string | undefined {
  for (const name of TITLE_PROPS) {
    const value = attribute(opening, name);
    const text = value ? staticText(value) : undefined;
    if (text) return text;
  }
  if (!Node.isJsxElement(node)) return undefined;
  for (const element of node.getDescendantsOfKind(SyntaxKind.JsxElement)) {
    const tag = element.getOpeningElement().getTagNameNode().getText();
    if (!TITLE_TAG.test(tag)) continue;
    const text = element
      .getJsxChildren()
      .filter(Node.isJsxText)
      .map((child) => child.getLiteralText().replace(/\s+/g, ' ').trim())
      .join(' ')
      .trim();
    return text && /[A-Za-z0-9]/.test(text) ? text : undefined;
  }
  return undefined;
}

function attribute(opening: Node, name: string): Node | undefined {
  if (!Node.isJsxOpeningElement(opening) && !Node.isJsxSelfClosingElement(opening))
    return undefined;
  const found = opening.getAttribute(name);
  if (!found || !Node.isJsxAttribute(found)) return undefined;
  const initializer = found.getInitializer();
  if (!initializer) return undefined;
  return Node.isJsxExpression(initializer) ? initializer.getExpression() : initializer;
}

/** Text that is written out: `"Expiring soon"`, `{"Low"}`, `` `Total` ``. */
/** The string props of each component being walked into, innermost last. */
const PROPS: Array<Map<string, string>> = [];

function staticText(value: Node): string | undefined {
  if (Node.isStringLiteral(value) || Node.isNoSubstitutionTemplateLiteral(value)) {
    const text = value.getLiteralValue().trim();
    return /[A-Za-z0-9]/.test(text) ? text : undefined;
  }
  // `mode === "create" ? "Batch / purchase lot" : "Batch / purchase lot (active batch)"`:
  // the name both share, or both names.
  if (Node.isConditionalExpression(value)) {
    // `mode === "create" ? …` where this place passes `mode="edit"`: that arm.
    const test = /^([\w$]+)\s*([!=])==?\s*["']([^"']*)["']$/.exec(
      value.getCondition().getText().trim(),
    );
    const given = test ? PROPS.at(-1)?.get(test[1]!) : undefined;
    if (test && given !== undefined) {
      const holds = (given === test[3]) === (test[2] === '=');
      return staticText(holds ? value.getWhenTrue() : value.getWhenFalse());
    }
    const yes = staticText(value.getWhenTrue());
    const no = staticText(value.getWhenFalse());
    if (!yes || !no) return yes ?? no;
    if (no.startsWith(yes)) return yes;
    if (yes.startsWith(no)) return no;
    return `${yes} / ${no}`;
  }
  return undefined;
}

/**
 * The link rows an element makes: one, or one per item of the array it is
 * mapped from — the Low / Stockout / Expiring tiles of a card.
 */
function links(
  node: Node,
  href: Node,
  env: Env,
  reader: SourceReader,
  file: string,
  line: number,
): OutlineNode[] {
  const used = [...env].filter(
    ([name]) =>
      new RegExp(`\\b${name}\\b`).test(href.getText()) ||
      new RegExp(`\\b${name}\\.`).test(node.getText()),
  );
  const spelled = used.find(([, items]) => items.length > 0);
  const variants: Env[] = spelled
    ? spelled[1].map((item) => new Map([...env, [spelled[0], [item]]]))
    : [env];
  const repeated = !spelled && used.length > 0;
  const result: OutlineNode[] = [];
  for (const scope of variants) {
    const to = resolveText(href, scope, reader);
    if (to === undefined || !isRoute(to)) continue;
    const label = linkLabel(node, scope, reader);
    result.push({
      type: 'link',
      to: normalizeRoute(to),
      href: to.startsWith('/') ? to : `/${to}`,
      file,
      line,
      ...(label ? { label } : {}),
      ...(repeated ? { repeated: true } : {}),
    });
  }
  return result;
}

/** The words on a link: its text, or a string it shows from the item it is drawn for. */
function linkLabel(node: Node, env: Env, reader: SourceReader): string | undefined {
  const label = attribute(Node.isJsxElement(node) ? node.getOpeningElement() : node, 'aria-label');
  const fromProp = label ? resolveText(label, env, reader) : undefined;
  if (fromProp) return fromProp;
  const parts: string[] = [];
  const visit = (child: Node) => {
    if (Node.isJsxText(child)) {
      const text = child.getLiteralText().replace(/\s+/g, ' ').trim();
      if (text) parts.push(text);
      return;
    }
    if (Node.isJsxExpression(child)) {
      const expression = child.getExpression();
      // Only a value read off the item or written out — a count is not a name.
      if (
        expression &&
        (Node.isPropertyAccessExpression(expression) || Node.isStringLiteral(expression))
      ) {
        const text = resolveText(expression, env, reader);
        if (text && /[A-Za-z]/.test(text) && !text.includes('[param]')) parts.push(text);
        // `{m.name}` of a row only the running app knows: named by its field,
        // so "Batch {m.batchNumber}" is not read as a link called "Batch".
        else if (Node.isPropertyAccessExpression(expression))
          parts.push(`‹${expression.getName()}›`);
      }
      return;
    }
    child.forEachChild(visit);
  };
  if (Node.isJsxElement(node)) for (const child of node.getJsxChildren()) visit(child);
  const text = parts.join(' ').trim();
  return text && /[A-Za-z0-9]/.test(text) ? text.slice(0, 60) : undefined;
}

/**
 * The string a value spells, reading item properties from the map it is in and
 * constants from where they are declared; a part only the running app knows
 * becomes `[param]`.
 */
function resolveText(value: Node, env: Env, reader: SourceReader, depth = 0): string | undefined {
  if (depth > 5) return undefined;
  if (Node.isStringLiteral(value) || Node.isNoSubstitutionTemplateLiteral(value))
    return value.getLiteralValue();
  if (Node.isParenthesizedExpression(value) || Node.isAsExpression(value)) {
    return resolveText(value.getExpression(), env, reader, depth + 1);
  }
  if (Node.isTemplateExpression(value)) {
    let text = value.getHead().getLiteralText();
    for (const span of value.getTemplateSpans()) {
      text +=
        (resolveText(span.getExpression(), env, reader, depth + 1) ?? '[param]') +
        span.getLiteral().getLiteralText();
    }
    return text;
  }
  if (Node.isBinaryExpression(value) && value.getOperatorToken().getText() === '+') {
    const left = resolveText(value.getLeft(), env, reader, depth + 1) ?? '[param]';
    const right = resolveText(value.getRight(), env, reader, depth + 1) ?? '[param]';
    return left + right;
  }
  if (Node.isPropertyAccessExpression(value)) {
    const target = value.getExpression();
    if (Node.isIdentifier(target)) {
      const item = env.get(target.getText());
      const object = item?.length === 1 ? item[0] : undefined;
      if (object && Node.isObjectLiteralExpression(object)) {
        const member = object.getProperty(value.getName());
        if (member && Node.isPropertyAssignment(member)) {
          const initializer = member.getInitializer();
          return initializer ? resolveText(initializer, env, reader, depth + 1) : undefined;
        }
      }
    }
    return undefined;
  }
  if (Node.isIdentifier(value)) {
    const declaration = reader.declaration(value.getText(), value.getSourceFile());
    if (declaration && Node.isVariableDeclaration(declaration)) {
      const initializer = declaration.getInitializer();
      if (
        initializer &&
        (Node.isStringLiteral(initializer) ||
          Node.isNoSubstitutionTemplateLiteral(initializer) ||
          Node.isTemplateExpression(initializer))
      ) {
        return resolveText(initializer, env, reader, depth + 1);
      }
    }
  }
  return undefined;
}

/** `/stock`, `/medicines/[param]?x=1`, `stock`; not `https://…`, `#`, `mailto:`. */
function isRoute(text: string): boolean {
  if (/^[a-z][a-z0-9+.-]*:|^\/\/|^#|^\[param\]/i.test(text)) return false;
  return /^\/|^[\w-]+(?:[/?#]|$)/.test(text);
}

/** `` href: `/medicines/${id}` `` -> `/medicines/[param]`. */
function templateRoute(entry: Node, key: string): string | undefined {
  if (!Node.isObjectLiteralExpression(entry)) return undefined;
  const property = entry.getProperty(key);
  let value =
    property && Node.isPropertyAssignment(property) ? property.getInitializer() : undefined;
  // `medicine ? \`/medicines/${id}\` : undefined`: a link once there is one to go to.
  if (value && Node.isConditionalExpression(value)) value = value.getWhenTrue();
  if (!value || !Node.isTemplateExpression(value)) return undefined;
  return (
    value.getHead().getLiteralText() +
    value
      .getTemplateSpans()
      .map((span) => `[param]${span.getLiteral().getLiteralText()}`)
      .join('')
  );
}

/** `label: medicine?.name ?? "Edit"` -> `‹name›`: the field a label shows from data. */
function fieldShown(entry: Node, key: string): string | undefined {
  if (!Node.isObjectLiteralExpression(entry)) return undefined;
  const property = entry.getProperty(key);
  const value =
    property && Node.isPropertyAssignment(property) ? property.getInitializer() : undefined;
  const access = value
    ? [value, ...value.getDescendants()].find((node) => Node.isPropertyAccessExpression(node))
    : undefined;
  return access && Node.isPropertyAccessExpression(access) ? `‹${access.getName()}›` : undefined;
}
