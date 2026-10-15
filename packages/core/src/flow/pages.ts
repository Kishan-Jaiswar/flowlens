import { existsSync, readFileSync } from 'node:fs';
import { posix } from 'node:path';
import type { FlowGraph } from '../graph/graph.js';
import { pageRouteOf } from '../analyzer/screens.js';
import { SourceReader } from './actionsource.js';
import type { FeatureFlow } from './resolve.js';

/**
 * "Which page is this on?"
 *
 * The screen on a tile says where the code lives, which is not always where the
 * user meets it: `AddMedicineDialog` sits in `features/medicines/components/`,
 * and the only way to reach it is the *Add* button on `/medicines`. A list of
 * actions grouped by page has to answer the second question, so this walks up
 * from the component that owns an action — who renders `<AddMedicineDialog>`,
 * and who renders that — until it reaches a page or a layout file.
 *
 * The walk reads the JSX tag names in each file rather than the module graph.
 * That is the answer a developer grepping for `<AddMedicineDialog` would get,
 * and it stays one pass over the files however many actions there are. A
 * component rendered from two pages is on both, and is reported on both.
 */

export interface FlowPage {
  /** `/medicines/[id]`; `/` for the root page or a root layout. */
  route: string;
  /** The page (or layout) file the walk ended on. */
  file: string;
  /** A layout wraps every page under `route` rather than being one. */
  layout: boolean;
  /**
   * What the browser tab says on this page — `<title>Bills || MyClinic</title>`
   * is "Bills" — when the file sets one. It is the name the user knows the page
   * by, which the route often is not: `/billing` is "Bills".
   */
  title?: string;
}

export interface FlowPagesOptions {
  /** Reuse a reader across requests (the server keeps one per scan). */
  reader?: SourceReader;
  /**
   * Filled with every file the walk passed through on the way up from each
   * flow, keyed by flow id — the components an action is drawn inside, not
   * just the page at the top. A settings page shows one tab's component at a
   * time, and which tab an action is on is only in this list.
   */
  reached?: Map<string, Set<string>>;
  /** Reuse an index already built for the same scan. */
  index?: PageIndex;
}

/** How many components up the walk goes before giving up. */
const MAX_DEPTH = 4;

const LAYOUT_FILE = /(?:^|\/)(?:layout|template|_app|_document)\.[cm]?[jt]sx?$/;

/**
 * What the walk reads, built once: which components each file defines, which
 * files render each tag, and who imports a file under another name.
 */
export interface PageIndex {
  /** file -> components defined there. */
  defined: Map<string, Set<string>>;
  /** component name -> files rendering it. */
  renderedIn: Map<string, Set<string>>;
  /** file -> files that import it under some name and render that name. */
  importedBy: Map<string, Set<string>>;
  /** file -> its source text. */
  texts: Map<string, string>;
  files: FileIndex;
}

export function buildPageIndex(graph: FlowGraph, reader: SourceReader): PageIndex {
  const defined = new Map<string, Set<string>>();
  const renderedIn = new Map<string, Set<string>>();
  const importedBy = new Map<string, Set<string>>();
  const texts = new Map<string, string>();
  for (const node of graph.allNodes()) {
    if (node.kind !== 'component' || !node.source?.file) continue;
    add(defined, node.source.file, node.label);
  }
  for (const file of defined.keys()) {
    const path = reader.absolute(file);
    if (!path || !existsSync(path)) continue;
    let text: string;
    try {
      text = readFileSync(path, 'utf8');
    } catch {
      continue;
    }
    texts.set(file, text);
    for (const match of text.matchAll(/<([A-Z][\w$]*)[\s/>]/g)) add(renderedIn, match[1]!, file);
  }
  const files = fileIndex([...defined.keys()]);
  for (const [file, text] of texts) {
    for (const { local, specifier } of defaultImports(text)) {
      if (!renderedIn.get(local)?.has(file)) continue;
      const target = resolveImport(file, specifier, files);
      if (target && target !== file) add(importedBy, target, file);
    }
  }
  return { defined, renderedIn, importedBy, texts, files };
}

/**
 * The pages (or, failing those, layouts) a file is drawn on, titled. `seen`
 * collects every file the walk passed through.
 */
export function pagesOfFile(
  index: PageIndex,
  start: string,
  component?: string,
  seen: Set<string> = new Set(),
  needs?: NeedsProps,
): FlowPage[] {
  return pagesAbove(start, component, index, seen, needs).map((page) => {
    const title = pageTitle(index.texts.get(page.file) ?? '');
    return title ? { ...page, title } : page;
  });
}

/**
 * The file a JSX tag in `file` draws: a component of its own, the file an
 * import of that name points at, or the one file defining it.
 */
export function resolveTag(index: PageIndex, file: string, tag: string): string | undefined {
  if (index.defined.get(file)?.has(tag)) return file;
  const text = index.texts.get(file) ?? '';
  for (const { local, specifier } of [...defaultImports(text), ...namedImports(text)]) {
    if (local !== tag) continue;
    const target = resolveImport(file, specifier, index.files);
    if (target) return target;
  }
  const candidates = [...index.defined].filter(([, names]) => names.has(tag));
  return candidates.length === 1 ? candidates[0]![0] : undefined;
}

/** Every page each flow is reached from, keyed by flow id. Unplaced flows are absent. */
export function flowPages(
  graph: FlowGraph,
  flows: FeatureFlow[],
  options: FlowPagesOptions = {},
): Map<string, FlowPage[]> {
  const index = options.index ?? buildPageIndex(graph, options.reader ?? new SourceReader(graph));
  const result = new Map<string, FlowPage[]>();
  for (const flow of flows) {
    // A shared control copied per place it is drawn: start from that place.
    const site = flow.steps[0]?.meta?.['siteFile'];
    const start = typeof site === 'string' ? site : flow.steps[0]?.file;
    if (!start) continue;
    const seen = new Set<string>();
    const needs = flow.steps[0]?.meta?.['needsProps'] as NeedsProps | undefined;
    const pages = pagesOfFile(
      index,
      start,
      typeof site === 'string' ? undefined : flow.component,
      seen,
      typeof site === 'string' ? undefined : needs,
    );
    options.reached?.set(flow.id, seen);
    if (pages.length > 0) result.set(flow.id, pages);
  }
  return result;
}

/** Props a component must be given for an action inside it to do anything. */
export interface NeedsProps {
  /** Its handler calls these: one of them must be passed. */
  any: string[];
  /** It is drawn only when these are set: every one must be passed. */
  all: string[];
}

function pagesAbove(
  start: string,
  component: string | undefined,
  index: PageIndex,
  seen: Set<string>,
  needs?: NeedsProps,
): FlowPage[] {
  const { defined, renderedIn, importedBy } = index;
  const found = new Map<string, FlowPage>();
  seen.add(start);
  let frontier = [start];
  for (let depth = 0; depth <= MAX_DEPTH && frontier.length > 0; depth++) {
    const next: string[] = [];
    for (const file of frontier) {
      const page = pageOf(file);
      if (page) {
        found.set(page.file, page);
        continue;
      }
      // The action's own component on the first hop; any component in the file
      // after that, since which one renders the child is not recorded. A
      // component only its own file renders — a table cell drawn by the table
      // above it — is reached through the file's other components.
      const own = depth === 0 && component ? component : undefined;
      const names = own && !renderedIn.get(own)?.has(file) ? [own] : [...(defined.get(file) ?? [])];
      // `<StatusBadge>` on a page that has its own, or imports another one, is
      // not this file's: two files' private `StatusBadge`s carried an import
      // history's table onto a detail page that never renders it.
      const parents = names.flatMap((name) =>
        [...(renderedIn.get(name) ?? [])].filter((parent) => {
          // Resolved to a file that only re-exports it (`ui/field` re-exporting
          // `Select`) is still this one: only a component of its own is another.
          const owner = resolveTag(index, parent, name);
          if (owner !== undefined && owner !== file && defined.get(owner)?.has(name)) return false;
          // `<TH>Batch</TH>` draws no sort button: only a `<TH sortable onSort>` does.
          return !needs || name !== own || passesProps(index.texts.get(parent) ?? '', name, needs);
        }),
      );
      // `import LibraryPreview from "./MaterialLibraryPreview"` renders a
      // component declared as `MaterialPreview`: the tag is the import's name.
      parents.push(...(importedBy.get(file) ?? []));
      for (const parent of parents) {
        if (seen.has(parent)) continue;
        seen.add(parent);
        next.push(parent);
      }
    }
    frontier = next;
  }

  // A page is the more specific answer; a layout only when nothing else is.
  const all = [...found.values()];
  const pages = all.filter((page) => !page.layout);
  return (pages.length > 0 ? pages : all).sort((a, b) => a.route.localeCompare(b.route));
}

/** Does any `<Tag …>` in the text pass the props the action needs? A spread may. */
export function passesProps(text: string, tag: string, needs: NeedsProps): boolean {
  for (const match of text.matchAll(new RegExp(`<${tag}(?![\\w$])`, 'g'))) {
    // Up to the tag's closing `>`, skipping `{…}` and strings: `=>` is not it.
    let depth = 0;
    let quote = '';
    let end = match.index! + match[0].length;
    for (; end < text.length; end++) {
      const char = text[end]!;
      if (quote) {
        if (char === quote) quote = '';
      } else if (char === '"' || char === "'" || char === '`') quote = char;
      else if (char === '{') depth++;
      else if (char === '}') depth--;
      else if (char === '>' && depth === 0) break;
    }
    const opening = text.slice(match.index! + match[0].length, end);
    if (/\{\s*\.\.\./.test(opening)) return true;
    // Attribute names outside any `{…}`.
    let flat = '';
    depth = 0;
    for (const char of opening) {
      if (char === '{') depth++;
      if (depth === 0) flat += char;
      if (char === '}') depth--;
    }
    const passed = new Set(
      [...flat.matchAll(/(?:^|\s)([A-Za-z_$][\w$-]*)(?==|\s|\/|$)/g)].map((m) => m[1]!),
    );
    if (
      (needs.any.length === 0 || needs.any.some((prop) => passed.has(prop))) &&
      needs.all.every((prop) => passed.has(prop))
    )
      return true;
  }
  return false;
}

function pageOf(file: string): FlowPage | undefined {
  const route = pageRouteOf(file);
  if (route === undefined) return undefined;
  return { route: `/${route}`, file, layout: LAYOUT_FILE.test(file) };
}

/**
 * The page's own name for itself: `<title>` in a Pages Router page, or
 * `metadata.title` in an App Router one.
 *
 * The site's name after a separator ("Bills || MyClinic") is on every page, so
 * it is cut. A title built from data (`<title>{name}</title>`) is not readable
 * here and is skipped.
 */
export function pageTitle(text: string): string | undefined {
  const raw =
    /<title>\s*([^<{]*?)\s*<\/title>/.exec(text)?.[1] ??
    /<title>\s*\{\s*(['"`])([^'"`$]*)\1\s*\}\s*<\/title>/.exec(text)?.[2] ??
    /export\s+const\s+metadata\b[^=]*=\s*\{[^}]*?\btitle\s*:\s*(['"`])([^'"`$]*)\1/.exec(text)?.[2];
  if (!raw) return undefined;
  const name = raw
    .split(/\s*(?:\|\|?|·|—|–)\s*/)
    .map((part) => part.trim())
    .find((part) => /[A-Za-z0-9]/.test(part));
  return name || undefined;
}

/** `import Name from "./file"` and `import Name, { other } from "./file"`. */
function defaultImports(text: string): Array<{ local: string; specifier: string }> {
  const found: Array<{ local: string; specifier: string }> = [];
  for (const match of text.matchAll(
    /import\s+([A-Z][\w$]*)\s*(?:,\s*\{[^}]*\})?\s+from\s+['"]([^'"]+)['"]/g,
  )) {
    found.push({ local: match[1]!, specifier: match[2]! });
  }
  return found;
}

/** `import { Name } from "./file"` and `import { Other as Name } from "./file"`. */
function namedImports(text: string): Array<{ local: string; specifier: string }> {
  const found: Array<{ local: string; specifier: string }> = [];
  for (const match of text.matchAll(
    /import\s+(?:[\w$]+\s*,\s*)?\{([^}]*)\}\s*from\s+['"]([^'"]+)['"]/g,
  )) {
    for (const part of match[1]!.split(',')) {
      const local = part
        .trim()
        .split(/\s+as\s+/)
        .pop()
        ?.trim();
      if (local && /^[A-Z]/.test(local)) found.push({ local, specifier: match[2]! });
    }
  }
  return found;
}

const SOURCE_EXTENSION = /\.[cm]?[jt]sx?$/;

export interface FileIndex {
  /** `components/home/QuickActions` (no extension) -> the scanned file. */
  byBare: Map<string, string>;
  bare: string[];
}

function fileIndex(files: string[]): FileIndex {
  const byBare = new Map<string, string>();
  for (const file of files) byBare.set(file.replace(SOURCE_EXTENSION, ''), file);
  return { byBare, bare: [...byBare.keys()] };
}

/**
 * The scanned file an import points at, or undefined for a package.
 *
 * Relative paths are joined; `@/x`, `~/x` and `src/x` are the common project
 * aliases, matched by the end of the path because the alias root is in a
 * tsconfig this does not read.
 */
function resolveImport(from: string, specifier: string, files: FileIndex): string | undefined {
  const bare = specifier.replace(SOURCE_EXTENSION, '');
  if (bare.startsWith('.')) {
    const base = posix.normalize(posix.join(posix.dirname(from), bare));
    return files.byBare.get(base) ?? files.byBare.get(`${base}/index`);
  }
  const alias = /^(?:@|~|src)\/(.+)$/.exec(bare);
  if (!alias) return undefined;
  for (const tail of [`/${alias[1]}`, `/${alias[1]}/index`]) {
    const match = files.bare.find(
      (candidate) => candidate === tail.slice(1) || candidate.endsWith(tail),
    );
    if (match) return files.byBare.get(match);
  }
  return undefined;
}

function add(map: Map<string, Set<string>>, key: string, value: string): void {
  const set = map.get(key);
  if (set) set.add(value);
  else map.set(key, new Set([value]));
}

/**
 * The page file the app serves at a path, if one: `/stock` -> the Stock page.
 *
 * A Next.js app fetches a page's data from its own address when the user
 * follows a `<Link>`, so runtime tracing records `GET /stock` beside the API
 * calls. That is the user opening a page, not a request no route answers.
 */
export function pageAtPath(graph: FlowGraph, path: string): string | undefined {
  const wanted = shape(path.split('?')[0] ?? path);
  for (const node of graph.allNodes()) {
    if (node.kind !== 'component' || !node.source?.file) continue;
    if (LAYOUT_FILE.test(node.source.file)) continue;
    const route = pageRouteOf(node.source.file);
    if (route !== undefined && shape(`/${route}`) === wanted) return node.source.file;
  }
  return undefined;
}

/** `/medicines/[id]`, `/medicines/:id` and `/medicines/42` all compare as `/medicines/*`. */
function shape(path: string): string {
  return (
    '/' +
    path
      .split('/')
      .filter(Boolean)
      .map((segment) => (/^\[.*\]$|^:|^\d+$/.test(segment) ? '*' : segment))
      .join('/')
  );
}
