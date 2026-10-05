/**
 * "I changed this function. Where does that break, and with what error?"
 *
 * The Changed view answers the file-level question: which actions run through
 * the files you touched. That is the right first answer and the wrong last one.
 * A developer who edits `formatStock()` in a shared module does not want to
 * hear that forty actions import the module; they want to hear that two of the
 * eleven callers now pass the wrong number of arguments, which screen and which
 * endpoint those two sit on, and what the compiler says about each.
 *
 * So this works at the level of a declaration:
 *
 * 1. Each changed file is compared with its last committed text, declaration by
 *    declaration, to find the functions, components, hooks, methods and types
 *    that actually changed, and how: removed, no longer exported, signature
 *    changed, or only the body.
 * 2. Every place that uses a changed declaration is found with the TypeScript
 *    language service — real references, not a text search.
 * 3. The project is type-checked twice, once as it is on disk and once with the
 *    changed files put back to their committed text. Only errors the change
 *    *introduced* are reported, so a project that was already red does not
 *    drown the answer in errors nobody just caused.
 * 4. Each error and each use site is placed in the app through the graph: the
 *    feature, page, component, endpoint and service it belongs to.
 *
 * Pure in the same way `changed.ts` is: it takes the paths and their old text
 * and knows nothing about git. Everything runs locally on the TypeScript that
 * ts-morph already ships — no service, no model, no network.
 */

import { existsSync, statSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { Node, Project, ts, type SourceFile } from 'ts-morph';
import type { FlowGraph } from '../graph/graph.js';
import type { EdgeKind, FlowNode } from '../graph/types.js';
import { resolveFlows, type FeatureFlow } from '../flow/resolve.js';
import type { ChangeStatus } from './changed.js';

export interface BreakageInput {
  /** Path relative to the scan root, forward-slashed — as node ids use. */
  file: string;
  status?: ChangeStatus;
  /** The file's committed text. Absent for a file that is new. */
  before?: string;
}

export type SymbolKind = 'function' | 'component' | 'hook' | 'method' | 'class' | 'type' | 'value';

export type SymbolChange =
  /** The declaration is gone. Every use of it is broken. */
  | 'removed'
  /** Still there, but other files can no longer import it. */
  | 'unexported'
  /** Same body, new name. Uses of the old name are broken. */
  | 'renamed'
  /** Parameters or return type changed: callers may no longer fit. */
  | 'signature'
  /** A type or interface changed shape. */
  | 'shape'
  /** Only the inside changed: every caller still compiles, but may behave differently. */
  | 'body'
  /** New. Nothing used it before, so nothing it can break — listed for completeness. */
  | 'added';

/** Where in the app a line of code sits. */
export interface Reach {
  features: Array<{ id: string; title: string }>;
  pages: string[];
  components: string[];
  apis: string[];
  services: string[];
  /**
   * Functions walked through to get here, when the use site itself is not a
   * step in the graph: `formatPrice` is called by `ProductRow`, which is.
   */
  via?: string[];
}

export interface BreakError {
  file: string;
  line: number;
  column: number;
  /** `TS2554` */
  code: string;
  message: string;
  /**
   * The error in plain words, when the code is one people meet often:
   * "Missing `currency` — `formatCurrency` now needs it as argument 2."
   * The compiler's own message stays in `message`.
   */
  explain?: string;
  /** The line of source the error points at, trimmed. */
  source: string;
  /** Where the error sits in the app. */
  reach: Reach;
  /**
   * For an error not on a use of a changed declaration: the changed files this
   * file imports, which are the likely cause.
   */
  from?: string[];
}

export type UsageVerdict =
  /** The compiler reports a new error here. */
  | 'broken'
  /** No compiler verdict (plain JavaScript), but the change makes this use fail. */
  | 'likely'
  /** Still compiles. The behaviour it relies on may have changed: read it. */
  | 'review';

export interface SymbolUsage {
  file: string;
  line: number;
  column: number;
  /** The line of source, trimmed. */
  source: string;
  /** The function or component the use sits in: `ProductTable › handleDelete`. */
  in?: string;
  verdict: UsageVerdict;
  /** Why it got that verdict, in a sentence. */
  reason: string;
  errors: BreakError[];
  reach: Reach;
  /**
   * Set when the line comes from the committed text of a file that has since
   * changed — the use of a removed declaration in another changed file.
   */
  approximate?: boolean;
}

export interface ChangedSymbol {
  /** `formatStock`, `ProductService.update`, `api.getProducts` */
  name: string;
  kind: SymbolKind;
  file: string;
  line: number;
  change: SymbolChange;
  /** What changed, one fact per line: "new required parameter `warehouseId: string`". */
  details: string[];
  /** Signatures before and after, when it is callable and they differ. */
  before?: string;
  after?: string;
  usages: SymbolUsage[];
  /** New compiler errors inside the changed declaration itself. */
  errors: BreakError[];
  /** Where it is used, across all uses. */
  reach: Reach;
  /** Where it breaks: the reach of the broken and likely-broken uses only. */
  breaks: Reach;
}

export interface BreakageReport {
  symbols: ChangedSymbol[];
  /** New compiler errors that sit on no use of a changed declaration. */
  otherErrors: BreakError[];
  totals: {
    symbols: number;
    broken: number;
    likely: number;
    review: number;
    errors: number;
  };
  /** False when the type check could not run; the reason is in `notes`. */
  typeChecked: boolean;
  checkedFiles: number;
  durationMs: number;
  level: 'low' | 'medium' | 'high';
  summary: string;
  notes: string[];
}

export interface BreakageOptions {
  /** The scan root the graph's relative paths start from. */
  root: string;
  /** Pre-resolved flows, when the caller already has them. */
  flows?: FeatureFlow[];
  /**
   * A project with more source files than this is not type-checked: the check
   * runs in the dashboard's request, and nobody waits a minute for a tab.
   */
  maxProjectFiles?: number;
}

const SOURCE = /\.(?:[cm]?[jt]sx?)$/;
const DECLARATION = /\.d\.[cm]?ts$/;
const MAX_SYMBOLS = 60;
const MAX_USAGES = 150;
const MAX_CHECKED_FILES = 600;
const DEFAULT_MAX_PROJECT_FILES = 8000;
/** How far to follow "used by a function that is used by..." to reach a graph step. */
const MAX_HOPS = 2;

/** Edges walked backwards from a use site to the endpoints and screens above it. */
const UPSTREAM: readonly EdgeKind[] = [
  'triggers',
  'calls',
  'requests',
  'handled-by',
  'injects',
  'defines',
  'renders',
];

export function analyzeBreakage(
  graph: FlowGraph,
  changes: readonly BreakageInput[],
  options: BreakageOptions,
): BreakageReport {
  const startedAt = Date.now();
  const root = resolve(options.root);
  const notes: string[] = [];
  const flows = options.flows ?? resolveFlows(graph, { includeLocalOnly: true });
  const placer = new Placer(graph, flows, root);

  const sources = changes.filter(
    (entry) => SOURCE.test(entry.file) && !DECLARATION.test(entry.file),
  );
  const symbols: ChangedSymbol[] = [];
  const otherErrors: BreakError[] = [];
  let checkedFiles = 0;
  let typeChecked = true;

  // One TypeScript project per tsconfig, so a monorepo's web and api halves are
  // each checked with their own settings and path aliases.
  const groups = new Map<string, BreakageInput[]>();
  for (const entry of sources) {
    const config = nearestTsconfig(join(root, entry.file), root) ?? '';
    const list = groups.get(config);
    if (list) list.push(entry);
    else groups.set(config, [entry]);
  }

  for (const [config, entries] of groups) {
    const outcome = analyzeGroup(graph, entries, {
      root,
      config: config || undefined,
      placer,
      maxProjectFiles: options.maxProjectFiles ?? DEFAULT_MAX_PROJECT_FILES,
    });
    symbols.push(...outcome.symbols);
    otherErrors.push(...outcome.otherErrors);
    checkedFiles += outcome.checkedFiles;
    if (!outcome.typeChecked) typeChecked = false;
    notes.push(...outcome.notes);
  }

  symbols.sort(
    (a, b) =>
      severity(b) - severity(a) ||
      b.usages.length - a.usages.length ||
      a.file.localeCompare(b.file) ||
      a.line - b.line,
  );

  const usages = symbols.flatMap((symbol) => symbol.usages);
  const totals = {
    symbols: symbols.filter((symbol) => symbol.change !== 'added').length,
    broken: usages.filter((usage) => usage.verdict === 'broken').length,
    likely: usages.filter((usage) => usage.verdict === 'likely').length,
    review: usages.filter((usage) => usage.verdict === 'review').length,
    errors:
      otherErrors.length +
      symbols.reduce(
        (sum, symbol) =>
          sum + symbol.errors.length + symbol.usages.reduce((n, u) => n + u.errors.length, 0),
        0,
      ),
  };

  const level: BreakageReport['level'] =
    totals.broken + totals.errors > 0
      ? 'high'
      : totals.likely > 0 || totals.review >= 5
        ? 'medium'
        : 'low';

  if (sources.length < changes.length) {
    const skipped = changes.length - sources.length;
    notes.push(
      `${skipped} changed file${skipped > 1 ? 's are' : ' is'} not JavaScript or TypeScript ` +
        'and was not compared declaration by declaration.',
    );
  }

  return {
    symbols,
    otherErrors,
    totals,
    typeChecked,
    checkedFiles,
    durationMs: Date.now() - startedAt,
    level,
    summary: summarize(totals, symbols, typeChecked),
    notes,
  };
}

function severity(symbol: ChangedSymbol): number {
  const broken = symbol.usages.filter((usage) => usage.verdict === 'broken').length;
  const likely = symbol.usages.filter((usage) => usage.verdict === 'likely').length;
  return (
    (broken + symbol.errors.length) * 1000 + likely * 100 + (symbol.change === 'added' ? -1 : 0)
  );
}

function summarize(
  totals: BreakageReport['totals'],
  symbols: readonly ChangedSymbol[],
  typeChecked: boolean,
): string {
  if (totals.symbols === 0) {
    return symbols.length > 0
      ? 'Your changes only add new code; nothing that existed before is affected.'
      : 'No function, component, hook or type changed in a way that reaches other code.';
  }
  const head = `${totals.symbols} declaration${totals.symbols > 1 ? 's' : ''} changed`;
  if (totals.broken + totals.errors > 0) {
    const sites = totals.broken;
    return (
      `${head}. The compiler reports ${totals.errors} new error${totals.errors === 1 ? '' : 's'}` +
      (sites > 0 ? `, ${sites} of them at places that use what you changed` : '') +
      '.'
    );
  }
  if (totals.likely > 0) {
    return `${head}. ${totals.likely} use${totals.likely > 1 ? 's' : ''} will most likely fail at runtime.`;
  }
  const tail = typeChecked ? 'Everything still compiles' : 'Nothing is obviously broken';
  return totals.review > 0
    ? `${head}. ${tail}; ${totals.review} use${totals.review > 1 ? 's rely' : ' relies'} on behaviour that changed.`
    : `${head}. ${tail}, and nothing else uses it.`;
}

// ---------------------------------------------------------------------------
// One tsconfig's worth of files
// ---------------------------------------------------------------------------

interface GroupOptions {
  root: string;
  config?: string;
  placer: Placer;
  maxProjectFiles: number;
}

interface GroupOutcome {
  symbols: ChangedSymbol[];
  otherErrors: BreakError[];
  checkedFiles: number;
  typeChecked: boolean;
  notes: string[];
}

/** A use of a changed declaration, before it is judged. */
interface RawUsage {
  key: string;
  abs: string;
  start: number;
  line: number;
  column: number;
  source: string;
  in?: string;
  scope?: Scope;
  /** Arguments at a call site, when it is one and none of them is spread. */
  args?: number;
  /** An import or re-export of the name rather than a use of it. */
  isImport: boolean;
  approximate?: boolean;
}

/** A compiler diagnostic, flattened to plain data. */
interface RawError {
  abs: string;
  start: number;
  end: number;
  line: number;
  column: number;
  code: number;
  message: string;
  source: string;
  scope?: Scope;
}

function analyzeGroup(
  graph: FlowGraph,
  entries: readonly BreakageInput[],
  options: GroupOptions,
): GroupOutcome {
  const { root, placer } = options;
  const notes: string[] = [];
  const abs = (file: string) => slash(join(root, file));
  const rel = (path: string) => slash(relative(root, path));

  const project = createProject(graph, root, options.config);
  for (const entry of entries) if (entry.status !== 'deleted') ensureFile(project, abs(entry.file));

  const projectSize = project.getSourceFiles().length;
  const typeChecked = projectSize <= options.maxProjectFiles;
  if (!typeChecked) {
    notes.push(
      `The project has ${projectSize} source files, more than the ${options.maxProjectFiles} this ` +
        'view type-checks, so compiler errors are not shown — only the places that use what changed.',
    );
  }

  /** Declarations per file, read once per state of the project. */
  let declCache = new Map<string, Map<string, DeclInfo>>();
  const declsOf = (file: string): Map<string, DeclInfo> => {
    const path = abs(file);
    let decls = declCache.get(path);
    if (!decls) {
      const sf = project.getSourceFile(path);
      decls = sf ? extractDecls(sf) : new Map();
      declCache.set(path, decls);
    }
    return decls;
  };

  // 1. What changed, declaration by declaration — syntax only, no checker yet.
  const scratch = new Project({
    useInMemoryFileSystem: true,
    compilerOptions: { allowJs: true, jsx: ts.JsxEmit.ReactJSX, noLib: true },
  });
  const changedFiles = new Set(entries.map((entry) => abs(entry.file)));
  const pending: Pending[] = [];

  entries.forEach((entry, index) => {
    const after = entry.status === 'deleted' ? new Map<string, DeclInfo>() : declsOf(entry.file);
    const before =
      entry.before !== undefined
        ? extractDecls(
            scratch.createSourceFile(`/before/${index}/${basenameOf(entry.file)}`, entry.before, {
              overwrite: true,
            }),
          )
        : new Map<string, DeclInfo>();

    const removed: DeclInfo[] = [];
    const added: DeclInfo[] = [];
    for (const [key, old] of before) {
      const now = after.get(key);
      if (!now) {
        removed.push(old);
        continue;
      }
      const change = compareDecl(old, now);
      if (change) pending.push({ entry, before: old, after: now, change });
    }
    for (const [key, now] of after) if (!before.has(key)) added.push(now);

    // A declaration that disappeared while one with the same body appeared is
    // a rename, and is far more useful reported as one.
    for (const old of removed) {
      const twin = added.find(
        (candidate) =>
          candidate.kind === old.kind && candidate.bodyNorm === renameBody(old, candidate),
      );
      if (twin) {
        added.splice(added.indexOf(twin), 1);
        pending.push({ entry, before: old, after: twin, change: 'renamed' });
      } else {
        pending.push({ entry, before: old, change: 'removed' });
      }
    }
    for (const now of added) pending.push({ entry, after: now, change: 'added' });
  });

  if (pending.length > MAX_SYMBOLS) {
    notes.push(
      `${pending.length} declarations changed; the ${MAX_SYMBOLS} with the most at stake are ` +
        'followed to their uses.',
    );
    pending.sort((a, b) => changeWeight(b.change) - changeWeight(a.change));
    pending.length = MAX_SYMBOLS;
  }

  // 2. Every use of what changed, in the project as it is now, and the
  //    signatures as the checker sees them — inferred return types included.
  for (const item of pending) {
    if (!item.after) continue;
    const decl = declsOf(item.entry.file).get(item.after.key);
    if (!decl) continue;
    item.afterSig = checkedSignature(decl);
    // Removed and renamed declarations are followed in the committed text, below.
    if (item.change !== 'added' && item.change !== 'renamed') {
      item.usages = findUsages(decl, root);
    }
  }

  // 3. The files worth checking: the changed ones, their users, their importers.
  const checkSet = new Set<string>(changedFiles);
  for (const item of pending) for (const usage of item.usages ?? []) checkSet.add(usage.abs);
  for (const importer of directImporters(
    graph,
    entries.map((entry) => entry.file),
  )) {
    checkSet.add(abs(importer));
  }
  const checkList = [...checkSet].slice(0, MAX_CHECKED_FILES);
  if (checkSet.size > MAX_CHECKED_FILES) {
    notes.push(
      `${checkSet.size} files use the changed code; the first ${MAX_CHECKED_FILES} were type-checked.`,
    );
  }

  const currentErrors = typeChecked ? collectErrors(project, checkList, root) : [];

  // 4. Put the changed files back to their committed text and look again.
  for (const entry of entries) {
    if (entry.before === undefined) continue;
    const path = abs(entry.file);
    const existing = project.getSourceFile(path);
    if (existing) existing.replaceWithText(entry.before);
    else project.createSourceFile(path, entry.before, { overwrite: true });
  }
  declCache = new Map();

  for (const item of pending) {
    if (!item.before) continue;
    const decl = declsOf(item.entry.file).get(item.before.key);
    if (!decl) continue;
    item.beforeSig = checkedSignature(decl);
    if (item.change === 'removed' || item.change === 'renamed') {
      item.usages = findUsages(decl, root).map((usage) =>
        changedFiles.has(usage.abs) ? { ...usage, approximate: true } : usage,
      );
    }
  }

  // A file that did not exist before had no errors before.
  const isNew = new Set(entries.filter((e) => e.before === undefined).map((e) => abs(e.file)));
  const baselineErrors = typeChecked
    ? collectErrors(
        project,
        checkList.filter((path) => !isNew.has(path)),
        root,
      )
    : [];
  const introduced = subtractErrors(currentErrors, baselineErrors, changedFiles);

  // 5. Judge each use and pin each new error to the use it sits on.
  const claimed = new Set<RawError>();
  const jsUnchecked = (path: string) =>
    /\.[cm]?jsx?$/.test(path) && !project.getCompilerOptions().checkJs;
  const built: Array<{ item: Pending; symbol: ChangedSymbol }> = [];

  for (const item of pending) {
    const decl = (item.after ?? item.before)!;
    const { beforeSig, afterSig } = item;
    let change = item.change;
    // An unchanged parameter list can still hide a new inferred return type.
    if (change === 'body' && beforeSig && afterSig && beforeSig.text !== afterSig.text) {
      change = 'signature';
    }
    const details = describeChange(change, item.before, item.after, beforeSig, afterSig);
    const name = change === 'renamed' ? item.before!.name : decl.name;

    const raw = (item.usages ?? []).filter(
      // An import line only matters when the name it imports is gone.
      (usage) =>
        !usage.isImport || change === 'removed' || change === 'unexported' || change === 'renamed',
    );
    const usages: SymbolUsage[] = [];
    for (const usage of raw.slice(0, MAX_USAGES)) {
      const errors = introduced.filter(
        (error) =>
          !claimed.has(error) &&
          error.abs === usage.abs &&
          (error.line === usage.line || (error.start <= usage.start && usage.start < error.end)),
      );
      for (const error of errors) claimed.add(error);
      const reach = placer.place(rel(usage.abs), usage.line, usage.scope);
      const judged = judgeUsage(change, usage, errors.length > 0, afterSig, {
        typeChecked,
        jsFile: jsUnchecked(usage.abs),
        name,
        renamedTo: change === 'renamed' ? item.after?.name : undefined,
      });
      usages.push({
        file: rel(usage.abs),
        line: usage.line,
        column: usage.column,
        source: usage.source,
        ...(usage.in ? { in: usage.in } : {}),
        verdict: judged.verdict,
        reason: judged.reason,
        errors: errors.map((error) =>
          toBreakError(error, reach, root, undefined, { name, signature: afterSig }),
        ),
        reach,
        ...(usage.approximate ? { approximate: true } : {}),
      });
    }
    if (raw.length > MAX_USAGES) {
      notes.push(`\`${name}\` is used ${raw.length} times; the first ${MAX_USAGES} are listed.`);
    }
    usages.sort(
      (a, b) =>
        verdictRank(a.verdict) - verdictRank(b.verdict) ||
        a.file.localeCompare(b.file) ||
        a.line - b.line,
    );

    const ownReach = item.after
      ? placer.place(item.entry.file, item.after.line, undefined)
      : emptyReach();
    const symbol: ChangedSymbol = {
      name: change === 'renamed' ? `${item.before!.name} → ${item.after!.name}` : decl.name,
      kind: decl.kind,
      file: item.entry.file,
      line: decl.line,
      change,
      details,
      ...(beforeSig && afterSig && beforeSig.text !== afterSig.text
        ? { before: beforeSig.text, after: afterSig.text }
        : {}),
      usages,
      errors: [],
      reach: mergeReach([ownReach, ...usages.map((usage) => usage.reach)]),
      breaks: mergeReach(
        usages.filter((usage) => usage.verdict !== 'review').map((usage) => usage.reach),
      ),
    };
    built.push({ item, symbol });
  }

  // New errors on no use: inside the changed code itself, or somewhere it leaks to.
  const otherErrors: BreakError[] = [];
  for (const error of introduced) {
    if (claimed.has(error)) continue;
    const file = rel(error.abs);
    const owner = changedFiles.has(error.abs)
      ? built.find(
          ({ item }) =>
            item.entry.file === file &&
            item.after !== undefined &&
            item.after.line <= error.line &&
            error.line <= item.after.endLine,
        )
      : undefined;
    const reach = placer.place(file, error.line, error.scope);
    const from = changedFiles.has(error.abs)
      ? undefined
      : (graph.meta.imports?.[file] ?? []).filter((target) =>
          entries.some((entry) => entry.file === target),
        );
    const shaped = toBreakError(error, reach, root, from?.length ? from : undefined);
    if (owner) owner.symbol.errors.push(shaped);
    else otherErrors.push(shaped);
  }
  for (const { symbol } of built) {
    if (symbol.errors.length > 0) {
      symbol.breaks = mergeReach([symbol.breaks, ...symbol.errors.map((error) => error.reach)]);
    }
  }

  if (typeChecked && !options.config) {
    notes.push(
      'No tsconfig.json was found, so the check used default settings. Path aliases ' +
        'such as `@/lib` may not resolve, which hides errors in files that use them.',
    );
  }
  if (entries.some((entry) => jsUnchecked(entry.file))) {
    notes.push(
      'JavaScript files are not type-checked (checkJs is off), so for them the verdicts ' +
        'come from comparing each call with the new parameter list, not from the compiler.',
    );
  }

  return {
    symbols: built.map(({ symbol }) => symbol),
    otherErrors,
    checkedFiles: typeChecked ? checkList.length : 0,
    typeChecked,
    notes,
  };
}

interface Pending {
  entry: BreakageInput;
  before?: DeclInfo;
  after?: DeclInfo;
  change: SymbolChange;
  beforeSig?: Signature | undefined;
  afterSig?: Signature | undefined;
  usages?: RawUsage[];
}

/** Paths as ts-morph writes them, so `C:\a` and `C:/a` are one file. */
function slash(path: string): string {
  return path.replace(/\\/g, '/');
}

function changeWeight(change: SymbolChange): number {
  return { removed: 6, renamed: 5, unexported: 5, signature: 4, shape: 3, body: 2, added: 0 }[
    change
  ];
}

function verdictRank(verdict: UsageVerdict): number {
  return verdict === 'broken' ? 0 : verdict === 'likely' ? 1 : 2;
}

// ---------------------------------------------------------------------------
// The TypeScript project
// ---------------------------------------------------------------------------

/**
 * The nearest tsconfig.json at or above the file, stopping at the scan root.
 *
 * A solution-style config (`"files": []` plus references) is skipped in favour
 * of the `tsconfig.app.json` beside it, the layout Vite generates.
 */
function nearestTsconfig(file: string, root: string): string | undefined {
  let dir = dirname(file);
  for (;;) {
    for (const name of ['tsconfig.json', 'jsconfig.json']) {
      const candidate = join(dir, name);
      if (existsSync(candidate)) {
        const app = join(dir, 'tsconfig.app.json');
        if (name === 'tsconfig.json' && existsSync(app) && isSolutionConfig(candidate)) return app;
        return candidate;
      }
    }
    if (dir === root || !isInside(dir, root)) return undefined;
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

function isSolutionConfig(path: string): boolean {
  const parsed = ts.readConfigFile(path, ts.sys.readFile);
  const config = parsed.config as { files?: unknown[]; references?: unknown[] } | undefined;
  return (
    Array.isArray(config?.files) && config.files.length === 0 && Array.isArray(config.references)
  );
}

function isInside(path: string, root: string): boolean {
  const between = relative(root, path);
  return between === '' || (!between.startsWith('..') && !isAbsolute(between));
}

function createProject(graph: FlowGraph, root: string, config: string | undefined): Project {
  if (config) {
    try {
      const project = new Project({ tsConfigFilePath: config });
      // A file the config does not include (a script, a stray .js) still
      // deserves a verdict, with the config's settings.
      return project;
    } catch {
      // A config TypeScript cannot read falls through to the defaults.
    }
  }
  const project = new Project({
    compilerOptions: {
      allowJs: true,
      checkJs: false,
      jsx: ts.JsxEmit.ReactJSX,
      target: ts.ScriptTarget.ESNext,
      module: ts.ModuleKind.ESNext,
      moduleResolution: ts.ModuleResolutionKind.Bundler,
      esModuleInterop: true,
      skipLibCheck: true,
      noEmit: true,
    },
  });
  const files = new Set<string>();
  for (const [from, targets] of Object.entries(graph.meta.imports ?? {})) {
    files.add(from);
    for (const target of targets) files.add(target);
  }
  for (const node of graph.allNodes()) if (node.source?.file) files.add(node.source.file);
  for (const file of files) {
    if (!SOURCE.test(file)) continue;
    const path = join(root, file);
    if (existsSync(path)) project.addSourceFileAtPathIfExists(path);
  }
  return project;
}

/** Make sure every changed file is in the project, even if the config skips it. */
function ensureFile(project: Project, path: string): SourceFile | undefined {
  const existing = project.getSourceFile(path);
  if (existing) return existing;
  try {
    return existsSync(path) && statSync(path).isFile()
      ? project.addSourceFileAtPath(path)
      : undefined;
  } catch {
    return undefined;
  }
}

function collectErrors(project: Project, paths: readonly string[], root: string): RawError[] {
  const errors: RawError[] = [];
  // Every file is added before the program is built, or the program is stale.
  const files = paths.map((path) => ensureFile(project, path));
  const program = project.getProgram();
  for (const sf of files) {
    if (!sf || !isInside(sf.getFilePath(), root)) continue;
    let diagnostics;
    try {
      diagnostics = [...program.getSyntacticDiagnostics(sf), ...program.getSemanticDiagnostics(sf)];
    } catch {
      continue; // a checker crash on one file must not end the analysis
    }
    const lines = sf.getFullText().split('\n');
    for (const diagnostic of diagnostics) {
      if (diagnostic.getCategory() !== ts.DiagnosticCategory.Error) continue;
      const start = diagnostic.getStart() ?? 0;
      const { line, column } = sf.getLineAndColumnAtPos(start);
      const scope = scopeAt(sf, start);
      errors.push({
        abs: sf.getFilePath(),
        start,
        end: start + (diagnostic.getLength() ?? 0),
        line,
        column,
        code: diagnostic.getCode(),
        message: ts.flattenDiagnosticMessageText(diagnostic.compilerObject.messageText, '\n'),
        source: clip(lines[line - 1]?.trim() ?? ''),
        ...(scope ? { scope } : {}),
      });
    }
  }
  return errors;
}

/**
 * The errors in `now` that were not in `then`.
 *
 * Matched as a multiset on file, code and message. Lines are part of the key
 * only for files the diff did not touch, where they cannot have moved; in a
 * changed file an old error that shifted down three lines is still old.
 */
function subtractErrors(
  now: readonly RawError[],
  then: readonly RawError[],
  changed: ReadonlySet<string>,
): RawError[] {
  const key = (error: RawError) =>
    `${error.abs}\0${error.code}\0${error.message}\0${changed.has(error.abs) ? '' : error.line}`;
  const remaining = new Map<string, number>();
  for (const error of then) remaining.set(key(error), (remaining.get(key(error)) ?? 0) + 1);
  const out: RawError[] = [];
  for (const error of now) {
    const count = remaining.get(key(error)) ?? 0;
    if (count > 0) remaining.set(key(error), count - 1);
    else out.push(error);
  }
  return out;
}

function directImporters(graph: FlowGraph, files: readonly string[]): string[] {
  const wanted = new Set(files);
  const out: string[] = [];
  for (const [from, targets] of Object.entries(graph.meta.imports ?? {})) {
    if (!wanted.has(from) && targets.some((target) => wanted.has(target))) out.push(from);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Declarations
// ---------------------------------------------------------------------------

interface ParamInfo {
  name: string;
  type?: string;
  optional: boolean;
  rest: boolean;
}

interface DeclInfo {
  key: string;
  name: string;
  kind: SymbolKind;
  line: number;
  endLine: number;
  exported: boolean;
  callable: boolean;
  params: ParamInfo[];
  returns?: string;
  /** Parameters, return annotation, type parameters, async — as written. */
  sigNorm: string;
  /** The whole declaration, printed without comments or formatting. */
  bodyNorm: string;
  /** Live only while the project it came from is unchanged. */
  node?: Node;
  nameNode?: Node;
  fn?: Node;
}

type Functionish = Node & {
  getParameters(): Array<Node>;
};

const printer = ts.createPrinter({ removeComments: true });

function normalize(node: Node): string {
  try {
    return printer
      .printNode(ts.EmitHint.Unspecified, node.compilerNode, node.getSourceFile().compilerNode)
      .replace(/\s+/g, ' ')
      .trim();
  } catch {
    return node.getText().replace(/\s+/g, ' ').trim();
  }
}

/** The function behind a declaration's initializer, unwrapping `memo(...)`, `forwardRef(...)`. */
function functionOf(node: Node | undefined): Functionish | undefined {
  let current = node;
  for (let depth = 0; current && depth < 3; depth += 1) {
    if (Node.isParenthesizedExpression(current) || Node.isAsExpression(current)) {
      current = current.getExpression();
      continue;
    }
    if (Node.isArrowFunction(current) || Node.isFunctionExpression(current)) {
      return current as unknown as Functionish;
    }
    if (Node.isCallExpression(current)) {
      current = current
        .getArguments()
        .find((arg) => Node.isArrowFunction(arg) || Node.isFunctionExpression(arg));
      continue;
    }
    return undefined;
  }
  return undefined;
}

function kindOfFunction(name: string, member: boolean): SymbolKind {
  if (member) return 'method';
  if (/^use[A-Z0-9]/.test(name)) return 'hook';
  if (/^[A-Z]/.test(name)) return 'component';
  return 'function';
}

function paramsOf(fn: Functionish): ParamInfo[] {
  return fn.getParameters().map((param) => {
    if (!Node.isParameterDeclaration(param)) {
      return { name: param.getText(), optional: false, rest: false };
    }
    const type = param.getTypeNode()?.getText().replace(/\s+/g, ' ');
    return {
      name: param.getNameNode().getText().replace(/\s+/g, ' '),
      ...(type ? { type } : {}),
      optional: param.hasQuestionToken() || param.hasInitializer(),
      rest: param.isRestParameter(),
    };
  });
}

function signatureNorm(fn: Functionish): { params: ParamInfo[]; returns?: string; norm: string } {
  const params = paramsOf(fn);
  const anyFn = fn as unknown as {
    getReturnTypeNode?: () => Node | undefined;
    getTypeParameters?: () => Node[];
    isAsync?: () => boolean;
    isGenerator?: () => boolean;
  };
  const returns = anyFn.getReturnTypeNode?.()?.getText().replace(/\s+/g, ' ');
  const typeParams = (anyFn.getTypeParameters?.() ?? []).map((tp) => tp.getText()).join(',');
  const flags = `${anyFn.isAsync?.() ? 'async' : ''}${anyFn.isGenerator?.() ? '*' : ''}`;
  return {
    params,
    ...(returns ? { returns } : {}),
    norm: JSON.stringify([params, returns ?? '', typeParams, flags]),
  };
}

/**
 * Every top-level declaration worth tracking, keyed by name.
 *
 * Top level plus one step in — class methods and the functions of an exported
 * object literal (`export const api = { getProducts() {} }`) — because that is
 * where shared code lives. Locals inside a function are covered by the
 * function itself having changed.
 */
function extractDecls(sf: SourceFile): Map<string, DeclInfo> {
  const out = new Map<string, DeclInfo>();
  const exportedNodes = new Set<Node>();
  try {
    for (const declarations of sf.getExportedDeclarations().values()) {
      for (const declaration of declarations) exportedNodes.add(declaration);
    }
  } catch {
    // Export resolution needs the binder; without it everything counts as local.
  }

  const add = (info: DeclInfo) => {
    if (!out.has(info.key)) out.set(info.key, info);
  };

  const callable = (
    key: string,
    name: string,
    kind: SymbolKind,
    node: Node,
    nameNode: Node | undefined,
    fn: Functionish,
    exported: boolean,
  ) => {
    const sig = signatureNorm(fn);
    add({
      key,
      name,
      kind,
      line: node.getStartLineNumber(),
      endLine: node.getEndLineNumber(),
      exported,
      callable: true,
      params: sig.params,
      ...(sig.returns ? { returns: sig.returns } : {}),
      sigNorm: sig.norm,
      bodyNorm: normalize(fn),
      node,
      ...(nameNode ? { nameNode } : {}),
      fn,
    });
  };

  for (const statement of sf.getStatements()) {
    if (Node.isFunctionDeclaration(statement)) {
      const name = statement.getName() ?? (statement.isDefaultExport() ? 'default' : undefined);
      if (!name) continue;
      callable(
        name,
        name,
        kindOfFunction(name, false),
        statement,
        statement.getNameNode(),
        statement as unknown as Functionish,
        exportedNodes.has(statement) || statement.isExported(),
      );
      continue;
    }

    if (Node.isVariableStatement(statement)) {
      for (const declaration of statement.getDeclarations()) {
        const nameNode = declaration.getNameNode();
        if (!Node.isIdentifier(nameNode)) continue;
        const name = nameNode.getText();
        const exported = exportedNodes.has(declaration) || statement.isExported();
        const init = declaration.getInitializer();
        const fn = functionOf(init);
        if (fn) {
          callable(name, name, kindOfFunction(name, false), declaration, nameNode, fn, exported);
          continue;
        }
        if (init && Node.isObjectLiteralExpression(init)) {
          for (const property of init.getProperties()) {
            let member: Functionish | undefined;
            let memberName: Node | undefined;
            if (Node.isMethodDeclaration(property)) {
              member = property as unknown as Functionish;
              memberName = property.getNameNode();
            } else if (Node.isPropertyAssignment(property)) {
              member = functionOf(property.getInitializer());
              memberName = property.getNameNode();
            }
            if (!member || !memberName || !Node.isIdentifier(memberName)) continue;
            const key = `${name}.${memberName.getText()}`;
            callable(key, key, 'method', property, memberName, member, exported);
          }
        }
        // A plain exported value: a config object, a constant list.
        if (exported) {
          add({
            key: name,
            name,
            kind: 'value',
            line: declaration.getStartLineNumber(),
            endLine: declaration.getEndLineNumber(),
            exported,
            callable: false,
            params: [],
            sigNorm: normalize(declaration.getTypeNode() ?? nameNode),
            bodyNorm: normalize(declaration),
            node: declaration,
            nameNode,
          });
        }
      }
      continue;
    }

    if (Node.isClassDeclaration(statement)) {
      const className =
        statement.getName() ?? (statement.isDefaultExport() ? 'default' : undefined);
      if (!className) continue;
      const exported = exportedNodes.has(statement) || statement.isExported();
      const shape = statement
        .getMembers()
        .filter(
          (member) => !Node.isMethodDeclaration(member) && !Node.isConstructorDeclaration(member),
        )
        .map((member) => normalize(member))
        .join(';');
      add({
        key: className,
        name: className,
        kind: 'class',
        line: statement.getStartLineNumber(),
        endLine: statement.getEndLineNumber(),
        exported,
        callable: false,
        params: [],
        sigNorm: `${statement
          .getHeritageClauses()
          .map((h) => h.getText())
          .join(' ')}|${shape}`,
        bodyNorm: shape,
        node: statement,
        ...(statement.getNameNode() ? { nameNode: statement.getNameNode()! } : {}),
      });
      for (const ctor of statement.getConstructors()) {
        const key = `${className}.constructor`;
        callable(
          key,
          `new ${className}`,
          'method',
          ctor,
          statement.getNameNode(),
          ctor as unknown as Functionish,
          exported,
        );
      }
      for (const method of statement.getMethods()) {
        const key = `${className}.${method.getName()}`;
        callable(
          key,
          key,
          'method',
          method,
          method.getNameNode(),
          method as unknown as Functionish,
          exported,
        );
      }
      continue;
    }

    if (
      Node.isInterfaceDeclaration(statement) ||
      Node.isTypeAliasDeclaration(statement) ||
      Node.isEnumDeclaration(statement)
    ) {
      const name = statement.getName();
      const norm = normalize(statement).replace(/^export\s+(default\s+)?/, '');
      add({
        key: name,
        name,
        kind: 'type',
        line: statement.getStartLineNumber(),
        endLine: statement.getEndLineNumber(),
        exported: exportedNodes.has(statement) || statement.isExported(),
        callable: false,
        params: [],
        sigNorm: norm,
        bodyNorm: norm,
        node: statement,
        nameNode: statement.getNameNode(),
      });
    }
  }
  return out;
}

/** How a declaration that exists on both sides changed, if it did. */
function compareDecl(before: DeclInfo, after: DeclInfo): SymbolChange | undefined {
  if (before.exported && !after.exported) return 'unexported';
  if (before.sigNorm !== after.sigNorm)
    return after.kind === 'type' || after.kind === 'class' ? 'shape' : 'signature';
  if (before.bodyNorm !== after.bodyNorm) {
    return after.kind === 'type' ? 'shape' : 'body';
  }
  return undefined;
}

/** The old body with the old name swapped for the new, so a pure rename compares equal. */
function renameBody(old: DeclInfo, candidate: DeclInfo): string {
  if (old.name === candidate.name) return old.bodyNorm;
  return old.bodyNorm.split(old.name).join(candidate.name);
}

function basenameOf(path: string): string {
  return path.split(/[\\/]/).pop() ?? 'file.ts';
}

// ---------------------------------------------------------------------------
// Signatures, as the checker sees them
// ---------------------------------------------------------------------------

interface Signature {
  params: ParamInfo[];
  returns: string;
  text: string;
  min: number;
  max: number;
}

function checkedSignature(decl: DeclInfo): Signature | undefined {
  if (!decl.callable || !decl.fn) return undefined;
  try {
    const fn = decl.fn;
    const signature = fn.getType().getCallSignatures()[0];
    const params: ParamInfo[] = (signature?.getParameters() ?? []).map((symbol) => {
      const declaration = symbol.getValueDeclaration();
      const type = clipType(symbol.getTypeAtLocation(fn).getText(fn));
      if (declaration && Node.isParameterDeclaration(declaration)) {
        return {
          name: declaration.getNameNode().getText().replace(/\s+/g, ' '),
          type,
          optional: declaration.hasQuestionToken() || declaration.hasInitializer(),
          rest: declaration.isRestParameter(),
        };
      }
      return { name: symbol.getName(), type, optional: false, rest: false };
    });
    const fallback = decl.params;
    const usable = signature ? params : fallback;
    const returns = signature
      ? clipType(signature.getReturnType().getText(fn))
      : (decl.returns ?? '');
    return {
      params: usable,
      returns,
      text: `(${usable
        .map(
          (p) =>
            `${p.rest ? '...' : ''}${p.name}${p.optional ? '?' : ''}${p.type ? `: ${p.type}` : ''}`,
        )
        .join(', ')})${returns ? ` => ${returns}` : ''}`,
      min: usable.filter((p) => !p.optional && !p.rest).length,
      max: usable.some((p) => p.rest) ? Infinity : usable.length,
    };
  } catch {
    return undefined;
  }
}

function clipType(text: string): string {
  const flat = text.replace(/import\("[^"]*"\)\./g, '').replace(/\s+/g, ' ');
  return flat.length > 140 ? `${flat.slice(0, 137)}…` : flat;
}

function describeChange(
  change: SymbolChange,
  before: DeclInfo | undefined,
  after: DeclInfo | undefined,
  beforeSig: Signature | undefined,
  afterSig: Signature | undefined,
): string[] {
  switch (change) {
    case 'removed':
      return [`\`${before!.name}\` was deleted — every place that still uses it is broken.`];
    case 'unexported':
      return [`\`${after!.name}\` is no longer exported — other files can no longer import it.`];
    case 'renamed':
      return [
        `Renamed from \`${before!.name}\` to \`${after!.name}\` — places still using the old name are broken.`,
      ];
    case 'added':
      return ['New — nothing used it before this change.'];
    case 'shape':
      return [
        `The ${after?.kind === 'class' ? 'class fields or base class' : 'type'} changed shape — ` +
          'code that builds or reads it may no longer fit.',
      ];
    case 'body':
      return ['Only the body changed: callers still compile, but get whatever it does now.'];
    case 'signature':
      break;
  }

  const old = beforeSig?.params ?? before?.params ?? [];
  const now = afterSig?.params ?? after?.params ?? [];
  const lines: string[] = [];
  // Matched by name first: inserting a parameter is one change, not a type
  // change to every parameter after it.
  const oldByName = new Map(old.map((param, index) => [param.name, index]));
  const newByName = new Map(now.map((param, index) => [param.name, index]));
  const renamedAt = new Set<number>();
  now.forEach((param, index) => {
    const previous = old[index];
    // Same position, different name, neither name on the other side: a rename.
    if (previous && !oldByName.has(param.name) && !newByName.has(previous.name)) {
      renamedAt.add(index);
      lines.push(`Parameter ${index + 1} renamed \`${previous.name}\` → \`${param.name}\`.`);
    }
  });

  now.forEach((param, index) => {
    const at = renamedAt.has(index) ? index : oldByName.get(param.name);
    if (at === undefined) {
      lines.push(
        param.optional || param.rest
          ? `New optional parameter \`${paramText(param)}\`.`
          : `New required parameter \`${paramText(param)}\` at position ${index + 1} — existing calls do not pass it.`,
      );
      return;
    }
    const previous = old[at]!;
    if (at !== index) {
      const occupant = now[at];
      lines.push(
        `Parameter \`${param.name}\` moved from position ${at + 1} to ${index + 1}` +
          (occupant
            ? ` — a call that passes it by position now passes its value as \`${occupant.name}\`.`
            : '.'),
      );
    }
    if ((previous.type ?? '') !== (param.type ?? '')) {
      lines.push(
        `Parameter \`${param.name}\` type: \`${previous.type ?? 'any'}\` → \`${param.type ?? 'any'}\`.`,
      );
    }
    if (previous.optional && !param.optional && !param.rest) {
      lines.push(`Parameter \`${param.name}\` is now required.`);
    }
    if (!previous.optional && param.optional)
      lines.push(`Parameter \`${param.name}\` is now optional.`);
  });
  old.forEach((param, index) => {
    if (newByName.has(param.name) || renamedAt.has(index)) return;
    lines.push(
      `Parameter \`${param.name}\` was removed — calls that still pass it pass one argument too many.`,
    );
  });
  const oldReturns = beforeSig?.returns ?? before?.returns;
  const newReturns = afterSig?.returns ?? after?.returns;
  if ((oldReturns ?? '') !== (newReturns ?? '')) {
    lines.push(
      `Returns \`${newReturns || 'nothing declared'}\` instead of \`${oldReturns || 'nothing declared'}\` — ` +
        'callers that use the result may read something that is no longer there.',
    );
  }
  if (lines.length === 0) lines.push('The parameter list or its types were rewritten.');
  return lines;
}

function paramText(param: ParamInfo): string {
  return `${param.rest ? '...' : ''}${param.name}${param.type ? `: ${param.type}` : ''}`;
}

// ---------------------------------------------------------------------------
// Uses
// ---------------------------------------------------------------------------

/** One level of "where in the code": the outermost named declaration around a position. */
interface Scope {
  /** `ProductTable › handleDelete` */
  chain: string[];
  /** Line range of the outermost declaration, to match graph steps against. */
  startLine: number;
  endLine: number;
  /** The outermost declaration's name node, to follow its own uses. */
  top?: Node;
}

function findUsages(decl: DeclInfo, root: string): RawUsage[] {
  if (!decl.nameNode || !decl.node) return [];
  let references: Node[];
  try {
    references = (
      decl.nameNode as unknown as { findReferencesAsNodes(): Node[] }
    ).findReferencesAsNodes();
  } catch {
    return [];
  }

  const declFile = decl.node.getSourceFile().getFilePath();
  const declStart = decl.node.getStart();
  const declEnd = decl.node.getEnd();
  const out: RawUsage[] = [];
  const seen = new Set<string>();
  const isConstructor = decl.key.endsWith('.constructor');

  for (const reference of references) {
    const refFile = reference.getSourceFile();
    const path = refFile.getFilePath();
    if (!isInside(path, root) || path.includes('/node_modules/')) continue;
    const start = reference.getStart();
    // The declaration itself, and recursion inside it, are not uses.
    if (path === declFile && start >= declStart && start < declEnd) continue;

    const parent = reference.getParent();
    if (isConstructor && !(parent && Node.isNewExpression(parent))) continue;
    const isImport =
      !!parent &&
      (Node.isImportSpecifier(parent) ||
        Node.isExportSpecifier(parent) ||
        Node.isImportClause(parent) ||
        Node.isNamespaceImport(parent));

    const { line, column } = refFile.getLineAndColumnAtPos(start);
    // One entry per line: `<Providers>…</Providers>` is two references and one use.
    const id = `${path}:${line}`;
    if (seen.has(id)) continue;
    seen.add(id);
    const scope = scopeAt(refFile, start);
    out.push({
      key: decl.key,
      abs: path,
      start,
      line,
      column,
      source: clip(refFile.getFullText().split('\n')[line - 1]?.trim() ?? ''),
      ...(scope?.chain.length ? { in: scope.chain.join(' › ') } : {}),
      ...(scope ? { scope } : {}),
      ...callArgs(reference),
      isImport,
    });
  }
  return out;
}

/** The argument count at a call site, when the reference is the thing being called. */
function callArgs(reference: Node): { args?: number } {
  let callee: Node = reference;
  const parent = reference.getParent();
  if (parent && Node.isPropertyAccessExpression(parent) && parent.getNameNode() === reference) {
    callee = parent;
  }
  const call = callee.getParent();
  if (!call || !(Node.isCallExpression(call) || Node.isNewExpression(call))) return {};
  if (call.getExpression() !== callee) return {};
  const args = call.getArguments();
  if (args.some((arg) => Node.isSpreadElement(arg))) return {};
  return { args: args.length };
}

function scopeAt(sf: SourceFile, pos: number): Scope | undefined {
  let node: Node | undefined = sf.getDescendantAtPos(pos);
  const chain: Array<{ name: string; node: Node; nameNode?: Node }> = [];
  while (node && !Node.isSourceFile(node)) {
    const named = nameOfScope(node);
    if (named)
      chain.unshift({
        name: named.name,
        node,
        ...(named.nameNode ? { nameNode: named.nameNode } : {}),
      });
    node = node.getParent();
  }
  const top = chain[0];
  if (!top) return undefined;
  return {
    chain: chain.map((entry) => entry.name),
    startLine: top.node.getStartLineNumber(),
    endLine: top.node.getEndLineNumber(),
    ...(top.nameNode ? { top: top.nameNode } : {}),
  };
}

function nameOfScope(node: Node): { name: string; nameNode?: Node } | undefined {
  if (Node.isFunctionDeclaration(node) || Node.isClassDeclaration(node)) {
    const nameNode = node.getNameNode();
    return nameNode ? { name: nameNode.getText(), nameNode } : { name: 'default' };
  }
  if (Node.isMethodDeclaration(node)) {
    const owner = node.getParent();
    const nameNode = node.getNameNode();
    return {
      name: Node.isClassDeclaration(owner)
        ? `${owner.getName() ?? 'class'}.${nameNode.getText()}`
        : nameNode.getText(),
      nameNode,
    };
  }
  if (Node.isVariableDeclaration(node) && functionOf(node.getInitializer())) {
    const nameNode = node.getNameNode();
    return Node.isIdentifier(nameNode) ? { name: nameNode.getText(), nameNode } : undefined;
  }
  if (Node.isPropertyAssignment(node) && functionOf(node.getInitializer())) {
    const nameNode = node.getNameNode();
    return { name: nameNode.getText(), nameNode };
  }
  return undefined;
}

function judgeUsage(
  change: SymbolChange,
  usage: RawUsage,
  hasError: boolean,
  signature: Signature | undefined,
  context: { typeChecked: boolean; jsFile: boolean; name: string; renamedTo?: string | undefined },
): { verdict: UsageVerdict; reason: string } {
  if (hasError) {
    return { verdict: 'broken', reason: 'The compiler reports a new error on this line.' };
  }
  const unchecked = context.jsFile || !context.typeChecked;
  switch (change) {
    case 'removed':
      return unchecked
        ? {
            verdict: 'likely',
            reason: `\`${context.name}\` no longer exists; this fails when it runs.`,
          }
        : {
            verdict: 'review',
            reason: `Used \`${context.name}\`, which was deleted — check this still resolves.`,
          };
    case 'renamed':
      return unchecked
        ? {
            verdict: 'likely',
            reason: `Still uses the old name \`${context.name}\`${context.renamedTo ? `; it is \`${context.renamedTo}\` now` : ''}.`,
          }
        : {
            verdict: 'review',
            reason: `Used the old name \`${context.name}\` — check it was updated.`,
          };
    case 'unexported':
      return usage.isImport && unchecked
        ? { verdict: 'likely', reason: `Imports \`${context.name}\`, which is no longer exported.` }
        : { verdict: 'review', reason: `\`${context.name}\` is no longer exported.` };
    case 'signature': {
      if (signature && usage.args !== undefined) {
        if (usage.args < signature.min) {
          return {
            verdict: unchecked ? 'likely' : 'review',
            reason: `Called with ${usage.args} argument${usage.args === 1 ? '' : 's'}; it now needs at least ${signature.min}.`,
          };
        }
        if (usage.args > signature.max) {
          return {
            verdict: unchecked ? 'likely' : 'review',
            reason: `Called with ${usage.args} arguments; it now takes at most ${signature.max}.`,
          };
        }
      }
      return {
        verdict: 'review',
        reason: unchecked
          ? 'The signature changed. This call still has a fitting number of arguments, but check their meaning.'
          : 'Still compiles against the new signature — check it still passes what the function now expects.',
      };
    }
    case 'shape':
      return {
        verdict: 'review',
        reason: unchecked
          ? 'Uses a type whose shape changed.'
          : 'Still compiles against the new shape — check the fields it reads mean the same thing.',
      };
    default:
      return {
        verdict: 'review',
        reason: 'Calls code whose body changed — check it still gets the result it expects.',
      };
  }
}

function toBreakError(
  error: RawError,
  reach: Reach,
  root: string,
  from?: string[],
  context?: { name: string; signature?: Signature | undefined },
): BreakError {
  const explain = explainError(error.code, error.message, context);
  return {
    file: relative(root, error.abs).split(sep).join('/'),
    line: error.line,
    column: error.column,
    code: `TS${error.code}`,
    message: error.message,
    ...(explain ? { explain } : {}),
    source: error.source,
    reach,
    ...(from ? { from } : {}),
  };
}

/**
 * A compiler error, said the way a colleague would say it.
 *
 * Only for the codes a changed function or type actually produces at its
 * callers; anything else keeps the compiler's message alone rather than a
 * paraphrase that could be wrong. With the changed function's new signature
 * at hand, a missing argument is named instead of counted.
 */
function explainError(
  code: number,
  message: string,
  context?: { name: string; signature?: Signature | undefined },
): string | undefined {
  const first = message.split('\n')[0] ?? message;
  const quoted = [...first.matchAll(/'([^']*)'/g)].map((match) => clipType(match[1] ?? ''));
  const fn = context ? `\`${context.name}\`` : 'the function';
  switch (code) {
    case 2554:
    case 2555: {
      const counts = /Expected (\d+)(?:-(\d+))? arguments?, but got (\d+)/.exec(first);
      if (!counts) return undefined;
      const got = Number(counts[3]);
      const min = Number(counts[1]);
      const max = counts[2] ? Number(counts[2]) : min;
      const params = context?.signature?.params ?? [];
      if (got < min) {
        const missing = params.slice(got, min).map((param) => `\`${param.name}\``);
        return missing.length
          ? `Missing ${missing.join(' and ')} — ${fn} now needs ${
              missing.length === 1 ? 'it' : 'them'
            } as argument ${got + 1}${missing.length > 1 ? `–${min}` : ''}.`
          : `Passes ${got} argument${got === 1 ? '' : 's'}; ${fn} now needs at least ${min}.`;
      }
      return `Passes ${got} arguments; ${fn} now takes at most ${max}.`;
    }
    case 2345:
      return quoted.length >= 2
        ? `Passes a \`${quoted[0]}\` where ${fn} now expects a \`${quoted[1]}\`.`
        : undefined;
    case 2322:
      return quoted.length >= 2
        ? `Gives a \`${quoted[0]}\` where a \`${quoted[1]}\` is now expected.`
        : undefined;
    case 2305:
    case 2614:
      return quoted.length >= 2
        ? `Imports \`${quoted[1]}\`, which ${quoted[0]} no longer exports.`
        : undefined;
    case 2724:
      return quoted.length >= 3
        ? `Imports \`${quoted[1]}\`, which ${quoted[0]} no longer exports — did you mean \`${quoted[2]}\`?`
        : undefined;
    case 2339:
      return quoted.length >= 2
        ? `Reads \`${quoted[0]}\`, which \`${quoted[1]}\` no longer has.`
        : undefined;
    case 2551:
      return quoted.length >= 3
        ? `Reads \`${quoted[0]}\`, which \`${quoted[1]}\` no longer has — did you mean \`${quoted[2]}\`?`
        : undefined;
    case 2304:
    case 2552:
      return quoted.length >= 1 ? `Uses \`${quoted[0]}\`, which no longer exists.` : undefined;
    case 2741:
      return quoted.length >= 3
        ? `Leaves out \`${quoted[0]}\`, which \`${quoted[2]}\` now requires.`
        : undefined;
    case 2353:
    case 2561:
      return quoted.length >= 2
        ? `Sets \`${quoted[0]}\`, which \`${quoted[1]}\` does not have any more.`
        : undefined;
    case 2769:
      return `No version of ${fn} accepts these arguments any more.`;
    case 2349:
      return 'Calls something that is no longer a function.';
    case 2532:
    case 18047:
    case 18048:
      return quoted.length >= 1
        ? `\`${quoted[0]}\` can now be empty here, and is used without a check.`
        : 'A value used here can now be empty, and is used without a check.';
    default:
      return undefined;
  }
}

function clip(text: string): string {
  return text.length > 160 ? `${text.slice(0, 157)}…` : text;
}

// ---------------------------------------------------------------------------
// From a line of code to the app
// ---------------------------------------------------------------------------

function emptyReach(): Reach {
  return { features: [], pages: [], components: [], apis: [], services: [] };
}

function mergeReach(reaches: readonly Reach[]): Reach {
  const features = new Map<string, { id: string; title: string }>();
  const sets = {
    pages: new Set<string>(),
    components: new Set<string>(),
    apis: new Set<string>(),
    services: new Set<string>(),
  };
  for (const reach of reaches) {
    for (const feature of reach.features) features.set(feature.id, feature);
    for (const page of reach.pages) sets.pages.add(page);
    for (const component of reach.components) sets.components.add(component);
    for (const api of reach.apis) sets.apis.add(api);
    for (const service of reach.services) sets.services.add(service);
  }
  return {
    features: [...features.values()].sort((a, b) => a.title.localeCompare(b.title)),
    pages: [...sets.pages].sort(),
    components: [...sets.components].sort(),
    apis: [...sets.apis].sort(),
    services: [...sets.services].sort(),
  };
}

/**
 * Places a line of code in the app: which feature, page, component, endpoint
 * and service it belongs to.
 *
 * The graph knows where its steps are declared. A use site inside a component
 * or handler that is a step is placed directly. A use inside a helper that is
 * not — `formatPrice` in `lib/format.ts` — is followed to *its* callers, up to
 * {@link MAX_HOPS} times, until one of them is a step.
 */
class Placer {
  private readonly byFile = new Map<string, FlowNode[]>();
  private readonly flowsByNode = new Map<string, FeatureFlow[]>();
  private readonly memo = new Map<string, Reach>();

  constructor(
    private readonly graph: FlowGraph,
    flows: readonly FeatureFlow[],
    private readonly root: string,
  ) {
    for (const node of graph.allNodes()) {
      const file = node.source?.file;
      if (!file) continue;
      const list = this.byFile.get(file);
      if (list) list.push(node);
      else this.byFile.set(file, [node]);
    }
    for (const flow of flows) {
      for (const step of flow.steps) {
        const list = this.flowsByNode.get(step.nodeId);
        if (list) {
          if (!list.includes(flow)) list.push(flow);
        } else this.flowsByNode.set(step.nodeId, [flow]);
      }
    }
  }

  place(file: string, line: number, scope: Scope | undefined, hops = 0): Reach {
    const memoKey = `${file}:${scope ? `${scope.startLine}-${scope.endLine}` : line}`;
    const cached = this.memo.get(memoKey);
    if (cached) return cached;
    // Stops a cycle of helpers calling each other from recursing forever.
    this.memo.set(memoKey, emptyReach());

    const nodes = this.byFile.get(file) ?? [];
    const seeds = scope
      ? nodes.filter((node) => {
          const at = node.source?.line ?? 0;
          return at >= scope.startLine && at <= scope.endLine;
        })
      : nodes.filter((node) => node.source?.line === line);

    let reach = seeds.length > 0 ? this.fromNodes(seeds, file) : emptyReach();
    // Not a step of any action itself — a helper, or a component with no button
    // of its own: follow the enclosing function to whoever uses it.
    if (reach.features.length === 0 && scope?.top && hops < MAX_HOPS) {
      const parts = this.callersOf(scope.top).map((caller) =>
        this.place(caller.file, caller.line, caller.scope, hops + 1),
      );
      const above = mergeReach(parts);
      if (above.features.length || above.apis.length || above.components.length) {
        const via = scope.chain[0];
        const deeper = parts.flatMap((part) => part.via ?? []);
        reach = mergeReach([reach, above]);
        if (via)
          reach.via = [via, ...new Set(deeper)]
            .filter((name, i, all) => all.indexOf(name) === i)
            .slice(0, 4);
      }
    }
    if (seeds.length === 0 && !scope && reach.features.length === 0 && nodes.length > 0) {
      // Module level, nothing on this line: whatever the graph knows of the file.
      reach = mergeReach([reach, this.fromNodes(nodes, file)]);
    }
    const page = pageOf(file);
    if (page) reach.pages = [...reach.pages, page];
    // A URL says more than a screen name; keep the names only when there is no URL.
    const urls = reach.pages.filter((entry) => entry.startsWith('/'));
    reach.pages = [...new Set(urls.length > 0 ? urls : reach.pages)].sort();

    this.memo.set(memoKey, reach);
    return reach;
  }

  private callersOf(nameNode: Node): Array<{ file: string; line: number; scope?: Scope }> {
    let references: Node[];
    try {
      references = (
        nameNode as unknown as { findReferencesAsNodes(): Node[] }
      ).findReferencesAsNodes();
    } catch {
      return [];
    }
    const own = nameNode.getParent();
    const out: Array<{ file: string; line: number; scope?: Scope }> = [];
    for (const reference of references.slice(0, 40)) {
      const sf = reference.getSourceFile();
      const path = sf.getFilePath();
      if (!isInside(path, this.root) || path.includes('node_modules')) continue;
      if (
        own &&
        reference.getStart() >= own.getStart() &&
        reference.getStart() < own.getEnd() &&
        sf === nameNode.getSourceFile()
      ) {
        continue;
      }
      const parent = reference.getParent();
      if (
        parent &&
        (Node.isImportSpecifier(parent) ||
          Node.isExportSpecifier(parent) ||
          Node.isImportClause(parent))
      ) {
        continue;
      }
      const scope = scopeAt(sf, reference.getStart());
      out.push({
        file: relative(this.root, path).split(sep).join('/'),
        line: reference.getStartLineNumber(),
        ...(scope ? { scope } : {}),
      });
    }
    return out;
  }

  private fromNodes(seeds: readonly FlowNode[], file: string): Reach {
    const features = new Map<string, { id: string; title: string }>();
    const pages = new Set<string>();
    const components = new Set<string>();
    const apis = new Set<string>();
    const services = new Set<string>();

    const note = (node: FlowNode) => {
      if (node.kind === 'component') components.add(node.label);
      if (node.kind === 'route' || node.kind === 'api-call') apis.add(node.label);
      if (node.kind === 'service' || node.kind === 'controller') services.add(node.label);
      if (node.kind === 'method') {
        const owner = node.meta?.['class'];
        services.add(owner ? `${String(owner)}.${node.label.split('.').pop()}` : node.label);
      }
      const component = node.meta?.['component'];
      if (component && node.source?.file === file) components.add(String(component));
      const screen = node.meta?.['screen'];
      if (screen) pages.add(String(screen));
    };

    // A component is broken for every action it renders.
    const expanded = [...seeds];
    for (const seed of seeds) {
      if (seed.kind !== 'component') continue;
      for (const action of this.graph.successors(seed.id, ['renders'])) {
        if (!expanded.includes(action)) expanded.push(action);
      }
    }

    for (const seed of expanded) {
      note(seed);
      for (const flow of this.flowsByNode.get(seed.id) ?? []) {
        features.set(flow.id, { id: flow.id, title: flow.title });
        if (flow.screen) pages.add(flow.screen);
        if (flow.component) components.add(flow.component);
        for (const endpoint of flow.endpoints) apis.add(endpoint);
        for (const service of [...flow.controllers, ...flow.services]) services.add(service);
        const page = flow.source?.file ? pageOf(flow.source.file) : undefined;
        if (page) pages.add(page);
      }
      // Who calls this step even when no user action does: an API route with
      // no button, a service only a cron job uses.
      const upstream = this.graph.reachable(seed.id, { direction: 'in', kinds: UPSTREAM });
      for (const id of [...upstream.keys()].slice(0, 200)) {
        const node = this.graph.node(id);
        if (!node || node.id === seed.id) continue;
        if (node.kind === 'route' || node.kind === 'api-call') apis.add(node.label);
        if (node.kind === 'component') components.add(node.label);
        for (const flow of this.flowsByNode.get(id) ?? []) {
          if (flow.entryNodeId === id) features.set(flow.id, { id: flow.id, title: flow.title });
        }
      }
    }

    return {
      features: [...features.values()].sort((a, b) => a.title.localeCompare(b.title)),
      pages: [...pages].sort(),
      components: [...components].sort(),
      apis: [...apis].sort(),
      services: [...services].sort(),
    };
  }
}

/** The URL a Next.js page file serves: `app/products/[id]/page.tsx` -> `/products/[id]`. */
function pageOf(file: string): string | undefined {
  const app = /(?:^|\/)app\/(.*?)\/?page\.[cm]?[jt]sx?$/.exec(file);
  if (app) {
    const route = (app[1] ?? '')
      .split('/')
      .filter((segment) => segment && !/^\(.*\)$/.test(segment) && !segment.startsWith('@'))
      .join('/');
    return `/${route}`;
  }
  const pages = /(?:^|\/)pages\/(.*)\.[cm]?[jt]sx?$/.exec(file);
  if (pages && !/^(_app|_document|_error|api\/)/.test(pages[1] ?? '')) {
    const route = (pages[1] ?? '').replace(/(^|\/)index$/, '');
    return `/${route}`;
  }
  return undefined;
}
