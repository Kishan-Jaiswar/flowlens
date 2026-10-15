import { existsSync, readFileSync } from 'node:fs';
import { Node, SyntaxKind, type ObjectLiteralExpression, type SourceFile } from 'ts-morph';
import type { FlowGraph } from '../graph/graph.js';
import { humanizeName, pageRouteOf } from '../analyzer/screens.js';
import { SourceReader } from './actionsource.js';
import { pageTitle } from './pages.js';

/**
 * "Where is that in the app?"
 *
 * Someone who uses the app finds a screen by its menu: *Billing*, then
 * *Clinic Setting › Timing*. A list of actions sorted by route asks them to
 * translate that into `/billingList` and `/setting/edit/[id]` first. Most apps
 * write their menu down as data — an array of `{ name: "Billing", link:
 * BILLING }` that a sidebar maps over — so this reads that array, and the
 * dashboard lays its actions out the way the app's own sidebar does.
 *
 * Nothing is executed. A link built from a constant is followed to the
 * constant; a menu entry that opens a tab rather than a page (`{ name:
 * "Timing", tab: 1 }`) is matched to the component the tab shows, by finding
 * the array that pairs tab ids with components. What cannot be read is left
 * out, and an app whose menu is not written as data simply has none.
 */

export interface NavItem {
  label: string;
  /** `/billingList` — the page the entry opens, when it opens one. */
  route?: string;
  /**
   * The component an entry shows inside its page — a settings tab — and the
   * file that defines it, when the entry selects a tab rather than a route.
   */
  component?: { name: string; file?: string };
  children: NavItem[];
}

export interface AppNavigation {
  /** The file the menu is written in, and where. */
  file: string;
  line: number;
  items: NavItem[];
  /**
   * The pages a user meets before the menu: login, sign-up, a forgotten
   * password. No menu links to them — the menu is only drawn once signed in —
   * but they are screens with actions like any other.
   */
  auth: NavItem[];
}

export interface AppNavigationOptions {
  reader?: SourceReader;
}

const LABEL_KEYS = ['name', 'label', 'title', 'text'];
const LINK_KEYS = ['link', 'href', 'path', 'to', 'route', 'url', 'pathname'];
/** The key a tab entry is selected by: `{ name: "Timing", tab: 1 }`. */
const TAB_KEYS = ['tab', 'tabIndex', 'tabId', 'activeTab', 'index', 'id', 'key', 'value'];
/** The key holding what a tab shows: `{ id: 1, component: <Timing /> }`. */
const CONTENT_KEYS = ['component', 'content', 'element', 'render', 'panel', 'body', 'children'];
const NAV_NAME = /side|nav|menu|drawer|sidebar/i;

/** The app's own menu, or undefined when none is written down as data. */
export function appNavigation(
  graph: FlowGraph,
  options: AppNavigationOptions = {},
): AppNavigation | undefined {
  const reader = options.reader ?? new SourceReader(graph);
  const files = new Set<string>();
  for (const node of graph.allNodes()) {
    if (node.kind === 'component' && node.source?.file) files.add(node.source.file);
  }
  const routes = new Set<string>();
  for (const file of files) {
    const route = pageRouteOf(file);
    if (route !== undefined) routes.add(routeKey(normalizeRoute(route)));
  }

  const texts = new Map<string, string>();
  for (const file of files) {
    const path = reader.absolute(file);
    if (!path || !existsSync(path)) continue;
    try {
      texts.set(file, readFileSync(path, 'utf8'));
    } catch {
      continue;
    }
  }

  let best: { score: number; file: string; line: number; items: NavItem[] } | undefined;
  for (const [file, text] of texts) {
    // Cheap test before parsing: a label and a link written as object keys.
    if (!/\b(?:name|label|title|text)\s*:\s*['"`]/.test(text)) continue;
    if (!/\b(?:link|href|path|to|route|url|pathname)\s*:/.test(text)) continue;
    const source = reader.file(file);
    if (!source) continue;
    for (const candidate of menuArrays(source, reader)) {
      const entries = flatten(candidate.items);
      const known = entries.filter((item) => item.route && routes.has(routeKey(item.route))).length;
      const linked = entries.filter((item) => item.route).length;
      // A menu points at the app's pages. Without file-based pages to check
      // against (a react-router app), a handful of links has to do.
      if (routes.size > 0 ? known < 2 : linked < 3) continue;
      const named = NAV_NAME.test(file) || NAV_NAME.test(candidate.name) ? 5 : 0;
      const score = known * 2 + candidate.items.length + named;
      if (!best || score > best.score) {
        best = { score, file, line: candidate.line, items: candidate.items };
      }
    }
  }
  if (!best) return undefined;

  resolveTabs(best.items, texts, reader);
  return {
    file: best.file,
    line: best.line,
    items: best.items,
    auth: authPages(files, texts, flatten(best.items)),
  };
}

interface MenuArray {
  name: string;
  line: number;
  items: NavItem[];
}

/**
 * Every array in the file that reads as a menu: three or more entries, nearly
 * all of them a label with a link or with entries of their own.
 *
 * An array nested in another menu's entry is a submenu, not a second menu.
 */
function menuArrays(source: SourceFile, reader: SourceReader): MenuArray[] {
  const found: Array<MenuArray & { node: Node }> = [];
  for (const array of source.getDescendantsOfKind(SyntaxKind.ArrayLiteralExpression)) {
    const objects = array.getElements().filter(Node.isObjectLiteralExpression);
    if (objects.length < 3) continue;
    const items = objects
      .map((object) => menuItem(object, source, reader))
      .filter((item): item is NavItem => item !== undefined);
    if (items.length < 3 || items.length < objects.length * 0.6) continue;
    const owner = array.getFirstAncestorByKind(SyntaxKind.VariableDeclaration);
    found.push({
      node: array,
      name: owner?.getName() ?? '',
      line: array.getStartLineNumber(),
      items,
    });
  }
  return found.filter(
    (candidate) =>
      !found.some(
        (other) =>
          other !== candidate &&
          other.node.getStart() <= candidate.node.getStart() &&
          other.node.getEnd() >= candidate.node.getEnd(),
      ),
  );
}

function menuItem(
  object: ObjectLiteralExpression,
  source: SourceFile,
  reader: SourceReader,
): NavItem | undefined {
  const label = LABEL_KEYS.map((key) => stringProperty(object, key)).find(Boolean);
  if (!label || !/[A-Za-z0-9]/.test(label)) return undefined;
  let route: string | undefined;
  for (const key of LINK_KEYS) {
    const value = property(object, key);
    const text = value ? resolveString(value, source, reader) : undefined;
    if (text !== undefined && isRoutish(text)) {
      route = normalizeRoute(text);
      break;
    }
  }
  const children: NavItem[] = [];
  for (const assignment of object.getProperties()) {
    if (!Node.isPropertyAssignment(assignment)) continue;
    const value = assignment.getInitializer();
    if (!value || !Node.isArrayLiteralExpression(value)) continue;
    for (const element of value.getElements()) {
      if (!Node.isObjectLiteralExpression(element)) continue;
      const child = menuItem(element, source, reader) ?? tabItem(element);
      if (child) children.push(child);
    }
  }
  const tab = tabItem(object);
  if (!route && children.length === 0 && !tab?.tab) return undefined;
  const item: NavItem & { tab?: string } = { label: label.trim(), children };
  if (route) item.route = route;
  if (!route && tab?.tab !== undefined) item.tab = tab.tab;
  return item;
}

/** `{ name: "Timing", tab: 1 }`: an entry that selects a tab rather than a page. */
function tabItem(object: ObjectLiteralExpression): (NavItem & { tab?: string }) | undefined {
  const label = LABEL_KEYS.map((key) => stringProperty(object, key)).find(Boolean);
  if (!label) return undefined;
  for (const key of TAB_KEYS) {
    const value = property(object, key);
    if (value && (Node.isNumericLiteral(value) || Node.isStringLiteral(value))) {
      return { label: label.trim(), children: [], tab: literalText(value) };
    }
  }
  return undefined;
}

/**
 * Give tab entries the component their tab shows.
 *
 * The page that owns the tabs pairs each id with what it draws — `{ id: 1,
 * component: <Timing /> }` — so the array whose ids cover the most of a
 * submenu's tabs is the one it selects from, and the page that array lives on
 * is the page the entry opens.
 */
function resolveTabs(items: NavItem[], texts: Map<string, string>, reader: SourceReader): void {
  let contents: Array<{ file: string; byId: Map<string, string> }> | undefined;
  const tabContents = () => (contents ??= tabContentArrays(texts, reader));
  const visit = (list: NavItem[]) => {
    for (const item of list) {
      visit(item.children);
      const tabs = item.children.filter((child) => (child as { tab?: string }).tab !== undefined);
      if (tabs.length === 0) continue;
      let pick: { file: string; byId: Map<string, string>; hits: number } | undefined;
      for (const array of tabContents()) {
        const hits = tabs.filter((child) =>
          array.byId.has((child as { tab?: string }).tab!),
        ).length;
        if (hits > 0 && (!pick || hits > pick.hits)) pick = { ...array, hits };
      }
      if (!pick || pick.hits < tabs.length / 2) continue;
      const pageRoute = pageRouteOf(pick.file);
      const route = pageRoute !== undefined ? normalizeRoute(pageRoute) : undefined;
      if (route && !item.route) item.route = route;
      for (const child of tabs) {
        const name = pick.byId.get((child as { tab?: string }).tab!);
        if (name) child.component = { name, file: componentFile(name, pick.file, reader) };
        if (route && !child.route) child.route = route;
      }
    }
  };
  visit(items);
  for (const item of flatten(items)) delete (item as { tab?: string }).tab;
}

/** `[{ id: 1, component: <Timing /> }, …]` in any file: tab id -> component name. */
function tabContentArrays(
  texts: Map<string, string>,
  reader: SourceReader,
): Array<{ file: string; byId: Map<string, string> }> {
  const found: Array<{ file: string; byId: Map<string, string> }> = [];
  const keys = CONTENT_KEYS.join('|');
  const test = new RegExp(`\\b(?:${keys})\\s*:\\s*\\(?\\s*<`, 'g');
  for (const [file, text] of texts) {
    // Parsing is the slow part; a tab list writes the key once per tab.
    if ((text.match(test)?.length ?? 0) < 3) continue;
    const source = reader.file(file);
    if (!source) continue;
    for (const array of source.getDescendantsOfKind(SyntaxKind.ArrayLiteralExpression)) {
      const byId = new Map<string, string>();
      for (const element of array.getElements()) {
        if (!Node.isObjectLiteralExpression(element)) continue;
        const id = TAB_KEYS.map((key) => property(element, key)).find(
          (value) => value && (Node.isNumericLiteral(value) || Node.isStringLiteral(value)),
        );
        const content = CONTENT_KEYS.map((key) => property(element, key)).find(Boolean);
        const name = content ? firstComponent(content) : undefined;
        if (id && name) byId.set(literalText(id), name);
      }
      if (byId.size >= 3) found.push({ file, byId });
    }
  }
  return found;
}

/** The first capitalised JSX tag inside a value: `<div><VisitingCard/></div>` -> `VisitingCard`. */
function firstComponent(value: Node): string | undefined {
  const tags = [
    ...(Node.isJsxElement(value) ? [value.getOpeningElement()] : []),
    ...(Node.isJsxSelfClosingElement(value) ? [value] : []),
    ...value
      .getDescendants()
      .filter((node) => Node.isJsxOpeningElement(node) || Node.isJsxSelfClosingElement(node)),
  ];
  for (const tag of tags) {
    if (!Node.isJsxOpeningElement(tag) && !Node.isJsxSelfClosingElement(tag)) continue;
    const name = tag.getTagNameNode().getText();
    if (/^[A-Z]/.test(name) && !name.includes('.')) return name;
  }
  return undefined;
}

/** Where a component used in `file` is defined, relative to the scanned root. */
function componentFile(name: string, file: string, reader: SourceReader): string | undefined {
  const source = reader.file(file);
  const declaration = source ? reader.declaration(name, source) : undefined;
  return declaration ? reader.relative(declaration.getSourceFile()) : undefined;
}

function property(object: ObjectLiteralExpression, key: string): Node | undefined {
  const found = object.getProperty(key);
  if (found && Node.isPropertyAssignment(found)) return found.getInitializer();
  if (found && Node.isShorthandPropertyAssignment(found)) return found.getNameNode();
  return undefined;
}

function stringProperty(object: ObjectLiteralExpression, key: string): string | undefined {
  const value = property(object, key);
  if (!value) return undefined;
  if (Node.isStringLiteral(value) || Node.isNoSubstitutionTemplateLiteral(value)) {
    return value.getLiteralValue();
  }
  return undefined;
}

function literalText(value: Node): string {
  return Node.isStringLiteral(value) ? value.getLiteralValue() : value.getText();
}

/**
 * The string an expression always evaluates to, following constants:
 * `HOME` -> `"home"`, `` `/${SETTING}/edit` `` -> `"/setting/edit"`. A part that
 * changes at runtime (`${clinic._id}`) becomes `[param]`, the way a page file
 * names it.
 */
function resolveString(
  value: Node,
  source: SourceFile,
  reader: SourceReader,
  depth = 0,
): string | undefined {
  if (depth > 5) return undefined;
  if (Node.isStringLiteral(value) || Node.isNoSubstitutionTemplateLiteral(value)) {
    return value.getLiteralValue();
  }
  if (Node.isParenthesizedExpression(value) || Node.isAsExpression(value)) {
    return resolveString(value.getExpression(), source, reader, depth + 1);
  }
  if (Node.isTemplateExpression(value)) {
    let text = value.getHead().getLiteralText();
    for (const span of value.getTemplateSpans()) {
      text += resolveString(span.getExpression(), source, reader, depth + 1) ?? '[param]';
      text += span.getLiteral().getLiteralText();
    }
    return text;
  }
  if (Node.isBinaryExpression(value) && value.getOperatorToken().getText() === '+') {
    const left = resolveString(value.getLeft(), source, reader, depth + 1);
    const right = resolveString(value.getRight(), source, reader, depth + 1);
    return left !== undefined && right !== undefined ? left + right : undefined;
  }
  if (Node.isIdentifier(value)) {
    const declaration = reader.declaration(value.getText(), source);
    if (declaration && Node.isVariableDeclaration(declaration)) {
      const initializer = declaration.getInitializer();
      if (initializer) {
        return resolveString(initializer, declaration.getSourceFile(), reader, depth + 1);
      }
    }
    return undefined;
  }
  // `ROUTES.billing`, with `ROUTES` an object of strings.
  if (Node.isPropertyAccessExpression(value)) {
    const target = value.getExpression();
    if (!Node.isIdentifier(target)) return undefined;
    const declaration = reader.declaration(target.getText(), source);
    if (!declaration || !Node.isVariableDeclaration(declaration)) return undefined;
    let initializer = declaration.getInitializer();
    while (initializer && Node.isAsExpression(initializer))
      initializer = initializer.getExpression();
    if (!initializer || !Node.isObjectLiteralExpression(initializer)) return undefined;
    const member = property(initializer, value.getName());
    return member
      ? resolveString(member, declaration.getSourceFile(), reader, depth + 1)
      : undefined;
  }
  return undefined;
}

/** `"home"`, `"/billing?tab=1"` and `"/"` read as routes; `"https://…"` and `"#"` do not. */
function isRoutish(text: string): boolean {
  if (/^[a-z]+:/i.test(text) || text.startsWith('#') || text.startsWith('//')) return false;
  return /^\/?[\w\-[\]/.:$]*(?:[?#].*)?$/.test(text);
}

/** `home`, `/home/`, `/home?x=1` -> `/home`; `:id` -> `[id]`, the page-file spelling. */
export function normalizeRoute(text: string): string {
  const path = text.split(/[?#]/)[0]!.replace(/:([A-Za-z_]\w*)/g, '[$1]');
  const trimmed = path.replace(/^\/+|\/+$/g, '');
  return `/${trimmed}`;
}

/** `/setting/edit/[id]` and `/setting/edit/[param]` are the same page. */
export function routeKey(route: string): string {
  return route.replace(/\[[^\]]*\]/g, '[]');
}

/**
 * Sign-in pages, in the order a new user meets them. Named by the page's own
 * title when it sets one, else by its route.
 */
const AUTH_PAGES: Array<[RegExp, number]> = [
  [/^(?:log-?in|sign-?in)$/i, 0],
  [/^(?:sign-?up|register|registration|create-?account)$/i, 1],
  [/^(?:verify|verify-?(?:email|otp|phone)|otp|confirm(?:-?email)?)$/i, 2],
  [/^(?:forgot-?password|reset-?password|recover|password-?reset)$/i, 3],
  [/^(?:log-?out|sign-?out)$/i, 4],
];

function authRank(route: string): number | undefined {
  const segments = route.split('/').filter((segment) => segment && !/^\[.*\]$/.test(segment));
  for (const segment of segments) {
    for (const [pattern, rank] of AUTH_PAGES) if (pattern.test(segment)) return rank;
  }
  return segments[0] === 'auth' ? 2 : undefined;
}

function authPages(files: Set<string>, texts: Map<string, string>, menu: NavItem[]): NavItem[] {
  const inMenu = new Set(menu.map((item) => item.route && routeKey(item.route)));
  const found: Array<NavItem & { rank: number }> = [];
  for (const file of files) {
    const raw = pageRouteOf(file);
    if (raw === undefined || /(?:^|\/)(?:layout|template)\.[cm]?[jt]sx?$/.test(file)) continue;
    const route = normalizeRoute(raw);
    const rank = authRank(route);
    if (rank === undefined || inMenu.has(routeKey(route))) continue;
    if (found.some((item) => item.route === route)) continue;
    const segments = route.split('/').filter(Boolean);
    const words = segments.filter((segment) => !/^\[.*\]$/.test(segment)).map(humanizeName);
    if (/^\[.*\]$/.test(segments[segments.length - 1] ?? '')) words.push('Details');
    const label = pageTitle(texts.get(file) ?? '') ?? words.join(' › ');
    found.push({ label, route, children: [], rank });
  }
  return found
    .sort((a, b) => a.rank - b.rank || a.route!.localeCompare(b.route!))
    .map(({ rank: _rank, ...item }) => item);
}

function flatten(items: NavItem[]): NavItem[] {
  return items.flatMap((item) => [item, ...flatten(item.children)]);
}
