/**
 * Code nothing uses: files, exports, folders and dependencies.
 *
 * A file is used when something the app starts from reaches it through
 * imports — a route file the framework loads, a script `package.json` runs, a
 * test, a config file. Everything else is unreachable: no user action, no
 * request and no job can run it. That is a stronger claim than "no import
 * mentions it", and it is the one worth acting on: a helper only imported by
 * another dead helper is just as dead.
 *
 * Read at scan time, from the same parsed files the rest of the analysis uses,
 * so it costs one walk over imports FlowLens already resolves. Nothing is
 * executed. The honest limit — a file loaded by a path built at runtime, or
 * named only in some tool's config — is said in the notes, because the answer
 * is a list of things someone may delete.
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { Node, type SourceFile } from 'ts-morph';
import type { FlowGraph } from '../graph/graph.js';
import { findDeadEndpoints } from '../impact/impact.js';
import type { ImportUse, ModuleResolver } from './imports.js';
import type { LoadedProject } from './project.js';

export interface UnusedFile {
  file: string;
  /** Lines in the file — what deleting it saves. */
  lines: number;
}

export interface UnusedExport {
  file: string;
  name: string;
  line: number;
  kind: 'function' | 'class' | 'variable' | 'type' | 'interface' | 'enum' | 'default';
  /** Referenced inside its own file: the `export` keyword can go, the code stays. */
  usedInFile: boolean;
}

export interface UnusedFolder {
  folder: string;
  files: number;
  lines: number;
}

export interface UnusedDependency {
  name: string;
  version: string;
  /** The package.json it is declared in, relative to the root. */
  manifest: string;
}

export interface BrokenImport {
  /** The file with the import. */
  file: string;
  /** As written: `./app.module`. */
  specifier: string;
}

export interface UnusedReport {
  files: UnusedFile[];
  /**
   * Relative imports that point at no file. Not unused code but its opposite
   * — code that is missing — and the reason a whole backend can look dead:
   * `main.ts` importing an `app.module` that is not there reaches nothing.
   */
  broken: BrokenImport[];
  exports: UnusedExport[];
  folders: UnusedFolder[];
  dependencies: UnusedDependency[];
  /** Source files considered, and how many of them the app starts from. */
  checked: { files: number; entries: number };
  /** Why the entry points are what they are; what this cannot see. */
  notes: string[];
}

/**
 * Files a framework or runtime loads by name, never through an import.
 * Matched against the path relative to the root, with any leading folders.
 */
const ENTRY_PATTERNS: RegExp[] = [
  // Next.js App Router special files.
  /(?:^|\/)app\/(?:.*\/)?(?:page|layout|template|loading|error|global-error|not-found|forbidden|unauthorized|default|route|opengraph-image|twitter-image|icon|apple-icon|sitemap|robots|manifest)\.[cm]?[jt]sx?$/,
  // Next.js Pages Router, Nuxt pages and layouts: every file is a route.
  /(?:^|\/)pages\/.+\.[cm]?[jt]sx?$/,
  /(?:^|\/)layouts\/.+\.[cm]?[jt]sx?$/,
  // Nuxt / Nitro server directories.
  /(?:^|\/)server\/(?:api|routes|middleware|plugins)\/.+\.[cm]?[jt]s$/,
  // Root-level framework hooks, in the project or its src/.
  /^(?:[^/]+\/)?(?:src\/)?(?:middleware|proxy|instrumentation|instrumentation-client)\.[cm]?[jt]s$/,
  // Conventional server entry points.
  /^(?:[^/]+\/)?(?:src\/)?(?:main|index|server|app)\.[cm]?[jt]sx?$/,
  // Tool configuration: next.config.ts, vite.config.ts, tailwind.config.js…
  /(?:^|\/)[^/]+\.config\.[cm]?[jt]s$/,
  // Run by hand: scripts/seed.ts, bin/cli.js.
  /(?:^|\/)(?:scripts|bin)\/[^/]+\.[cm]?[jt]s$/,
  // Storybook, and test setup files a runner loads by name.
  /\.stories\.[cm]?[jt]sx?$/,
  /(?:^|\/)(?:setupTests|vitest\.setup|jest\.setup)\.[cm]?[jt]sx?$/,
];

const SOURCE_FILE = /\.[cm]?[jt]sx?$/;
const TEST_FILE = /(?:\.(?:test|spec)\.[cm]?[jt]sx?$)|(?:^|\/)__tests__\//;
const SKIP_DIRS = new Set([
  'node_modules',
  '.next',
  '.nuxt',
  '.git',
  'dist',
  'build',
  'out',
  'coverage',
]);

/**
 * Packages a framework loads without an import in the source: React's JSX
 * runtime, Next's renderer. Reporting them would be the first thing a user
 * learns to ignore.
 */
const IMPLICIT_WITH: Record<string, string[]> = {
  next: ['react', 'react-dom', 'sharp', '@next/font'],
  react: ['react-dom'],
  nuxt: ['vue', 'vue-router'],
  '@nestjs/core': ['reflect-metadata', 'rxjs', '@nestjs/platform-express'],
};
const ALWAYS_IMPLICIT =
  /^(?:@types\/|typescript$|tslib$|eslint|prettier|postcss|autoprefixer|tailwindcss)/;

export function findUnused(
  loaded: LoadedProject,
  uses: Map<string, ImportUse[]>,
  resolver: ModuleResolver,
): UnusedReport {
  const files = loaded.sourceFiles.filter((file) => !/\.d\.[cm]?ts$/.test(file.getFilePath()));
  const byRel = new Map(files.map((file) => [loaded.rel(file), file]));

  // ---- entry points --------------------------------------------------------
  const entries = new Set<string>();
  for (const rel of byRel.keys())
    if (ENTRY_PATTERNS.some((pattern) => pattern.test(rel))) entries.add(rel);

  const manifests = loaded.roots.flatMap((root) => manifestsUnder(root));
  const mentionedText: string[] = [];
  // Every root is read for run files, with or without a package.json of its own.
  const places = [
    ...manifests,
    ...loaded.roots
      .filter((root) => !manifests.some((manifest) => dirname(manifest.path) === resolve(root)))
      .map((root) => ({ path: join(root, 'package.json'), json: {} as Manifest['json'] })),
  ];
  for (const manifest of places) {
    const dir = dirname(manifest.path);
    const referenced = [
      manifest.json.main,
      manifest.json.module,
      ...Object.values(
        typeof manifest.json.bin === 'string'
          ? { bin: manifest.json.bin }
          : (manifest.json.bin ?? {}),
      ),
      ...flattenExports(manifest.json.exports),
      ...Object.values(manifest.json.scripts ?? {}).flatMap(pathsInCommand),
    ];
    mentionedText.push(Object.values(manifest.json.scripts ?? {}).join('\n'));
    for (const path of runFiles(dir)) {
      const text = safeRead(path);
      // A README naming a package is documentation, not a use of it.
      if (!/readme/i.test(path)) mentionedText.push(text);
      referenced.push(...pathsInCommand(text));
      // Vite and friends: <script type="module" src="/src/main.tsx">.
      for (const match of text.matchAll(/\bsrc=["']\/?([^"']+\.[cm]?[jt]sx?)["']/g))
        referenced.push(match[1]);
    }
    for (const reference of referenced) {
      if (typeof reference !== 'string') continue;
      const rel = relFromRoot(loaded, resolve(dir, reference));
      const match = rel && matchSource(rel, byRel);
      if (match) entries.add(match);
    }
  }

  // Tests are entry points too: code only a test imports is not dead, it is
  // tested scaffolding — and the scan leaves test files out, so read them here.
  const testUses: ImportUse[] = [];
  for (const root of loaded.roots) {
    for (const path of filesUnder(root, (name) => TEST_FILE.test(name))) {
      for (const specifier of specifiersIn(safeRead(path))) {
        const target = resolver.resolve(specifier, path);
        testUses.push({ specifier, names: '*', typeOnly: false, ...(target ? { target } : {}) });
      }
    }
  }

  // ---- reachability --------------------------------------------------------
  const reached = new Set<string>();
  const queue = [...entries, ...testUses.flatMap((use) => (use.target ? [use.target] : []))];
  while (queue.length > 0) {
    const next = queue.pop()!;
    if (reached.has(next)) continue;
    reached.add(next);
    for (const use of uses.get(next) ?? [])
      if (use.target && !reached.has(use.target)) queue.push(use.target);
  }

  const unusedFiles: UnusedFile[] = [...byRel.entries()]
    .filter(([rel]) => !reached.has(rel))
    .map(([rel, file]) => ({ file: rel, lines: file.getEndLineNumber() }))
    .sort((a, b) => a.file.localeCompare(b.file));

  // ---- exports -------------------------------------------------------------
  const wanted = new Map<string, Set<string> | '*'>();
  const note = (target: string, names: string[] | '*'): void => {
    const current = wanted.get(target);
    if (current === '*') return;
    if (names === '*') {
      wanted.set(target, '*');
      return;
    }
    const set = current ?? new Set<string>();
    for (const name of names) set.add(name);
    wanted.set(target, set);
  };
  for (const [from, list] of uses) {
    // An unreachable file importing something does not make it used.
    if (!reached.has(from)) continue;
    for (const use of list) if (use.target) note(use.target, use.names);
  }
  for (const use of testUses) if (use.target) note(use.target, '*');

  const unusedExports: UnusedExport[] = [];
  for (const [rel, file] of byRel) {
    // Entry files export for the framework (`GET`, `default`, `metadata`), and
    // a dead file is already reported whole.
    if (entries.has(rel) || !reached.has(rel)) continue;
    const used = wanted.get(rel);
    if (used === '*') continue;
    const text = file.getFullText();
    for (const entry of exportsOf(file)) {
      if (used?.has(entry.name)) continue;
      unusedExports.push({
        file: rel,
        ...entry,
        usedInFile: entry.name !== 'default' && countWord(text, entry.name) > 1,
      });
    }
  }
  unusedExports.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);

  // ---- folders ---------------------------------------------------------------
  const unusedSet = new Set(unusedFiles.map((entry) => entry.file));
  const totals = new Map<string, { all: number; dead: number; lines: number }>();
  for (const [rel, file] of byRel) {
    const parts = rel.split('/');
    for (let depth = 1; depth < parts.length; depth += 1) {
      const folder = parts.slice(0, depth).join('/');
      const entry = totals.get(folder) ?? { all: 0, dead: 0, lines: 0 };
      entry.all += 1;
      if (unusedSet.has(rel)) {
        entry.dead += 1;
        entry.lines += file.getEndLineNumber();
      }
      totals.set(folder, entry);
    }
  }
  const deadFolders = [...totals.entries()]
    .filter(([, entry]) => entry.all >= 2 && entry.dead === entry.all)
    .map(([folder, entry]) => ({ folder, files: entry.all, lines: entry.lines }));
  // Report the top-most: `lib/legacy` rather than it and each folder inside.
  const folders = deadFolders
    .filter((entry) => !deadFolders.some((other) => entry.folder.startsWith(`${other.folder}/`)))
    .sort((a, b) => a.folder.localeCompare(b.folder));

  // ---- dependencies ----------------------------------------------------------
  const importedPackages = new Set<string>();
  for (const list of [...uses.values(), testUses]) {
    for (const use of list) {
      const name = packageOf(use.specifier);
      if (name) importedPackages.add(name);
    }
  }
  const mentioned = mentionedText.join('\n');
  const dependencies: UnusedDependency[] = [];
  for (const manifest of manifests) {
    const declared = manifest.json.dependencies ?? {};
    const implicit = new Set(Object.keys(declared).flatMap((name) => IMPLICIT_WITH[name] ?? []));
    for (const [name, version] of Object.entries(declared)) {
      if (importedPackages.has(name) || implicit.has(name) || ALWAYS_IMPLICIT.test(name)) continue;
      // A CLI run from a script, or a plugin named in a config file.
      if (mentioned.includes(name)) continue;
      dependencies.push({
        name,
        version: String(version),
        manifest: relFromRoot(loaded, manifest.path) ?? 'package.json',
      });
    }
  }

  // ---- imports that point at nothing -------------------------------------------
  const broken: BrokenImport[] = [];
  for (const [from, list] of uses) {
    const file = byRel.get(from);
    if (!file) continue;
    for (const use of list) {
      if (use.target || !use.specifier.startsWith('.')) continue;
      // A stylesheet, an image, JSON: not source, so not resolved above.
      if (existsSync(resolve(dirname(file.getFilePath()), use.specifier))) continue;
      broken.push({ file: from, specifier: use.specifier });
    }
  }

  const deadLines = unusedFiles.reduce((sum, entry) => sum + entry.lines, 0);
  return {
    files: unusedFiles,
    broken: broken.sort((a, b) => a.file.localeCompare(b.file)),
    exports: unusedExports,
    folders,
    dependencies: dependencies.sort((a, b) => a.name.localeCompare(b.name)),
    checked: { files: byRel.size, entries: entries.size },
    notes: [
      `Started from ${entries.size} entry point${entries.size === 1 ? '' : 's'}: files the framework loads by name ` +
        '(routes, pages, layouts, middleware), files package.json, its scripts, a Dockerfile or a README ' +
        'command run, scripts/ and bin/, ' +
        'config files, and every test. A file is used if one of those reaches it through imports, type imports included.',
      ...(unusedFiles.length
        ? [
            `${unusedFiles.length} unreachable file${unusedFiles.length === 1 ? '' : 's'}, ${deadLines} lines.`,
          ]
        : []),
      'Check before deleting: a file loaded by a path built at runtime, or named only in some ' +
        "tool's configuration, looks unused from the source.",
    ],
  };
}

function exportsOf(file: SourceFile): Array<Pick<UnusedExport, 'name' | 'line' | 'kind'>> {
  const found: Array<Pick<UnusedExport, 'name' | 'line' | 'kind'>> = [];
  const add = (name: string | undefined, node: Node, kind: UnusedExport['kind']): void => {
    if (name) found.push({ name, line: node.getStartLineNumber(), kind });
  };
  for (const statement of file.getStatements()) {
    if (Node.isFunctionDeclaration(statement) && statement.isExported()) {
      add(
        statement.isDefaultExport() ? 'default' : statement.getName(),
        statement,
        statement.isDefaultExport() ? 'default' : 'function',
      );
    } else if (Node.isClassDeclaration(statement) && statement.isExported()) {
      add(
        statement.isDefaultExport() ? 'default' : statement.getName(),
        statement,
        statement.isDefaultExport() ? 'default' : 'class',
      );
    } else if (Node.isInterfaceDeclaration(statement) && statement.isExported()) {
      add(statement.getName(), statement, 'interface');
    } else if (Node.isTypeAliasDeclaration(statement) && statement.isExported()) {
      add(statement.getName(), statement, 'type');
    } else if (Node.isEnumDeclaration(statement) && statement.isExported()) {
      add(statement.getName(), statement, 'enum');
    } else if (Node.isVariableStatement(statement) && statement.isExported()) {
      for (const declaration of statement.getDeclarations()) {
        const nameNode = declaration.getNameNode();
        if (Node.isIdentifier(nameNode)) add(nameNode.getText(), declaration, 'variable');
      }
    } else if (Node.isExportAssignment(statement) && !statement.isExportEquals()) {
      add('default', statement, 'default');
    } else if (Node.isExportDeclaration(statement) && !statement.getModuleSpecifier()) {
      // `export { a, b as c }` of local names: the exported name is what importers use.
      for (const entry of statement.getNamedExports()) {
        add(entry.getAliasNode()?.getText() ?? entry.getName(), entry, 'variable');
      }
    }
  }
  return found;
}

/** `import … from 'x'`, `export … from 'x'`, `import('x')`, `require('x')`, by text. */
function specifiersIn(text: string): string[] {
  const found: string[] = [];
  for (const pattern of [
    /\bfrom\s+['"]([^'"]+)['"]/g,
    /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
    /\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
    /^\s*import\s+['"]([^'"]+)['"]/gm,
  ]) {
    for (const match of text.matchAll(pattern)) if (match[1]) found.push(match[1]);
  }
  return found;
}

/** `@scope/name/sub` -> `@scope/name`; `name/sub` -> `name`; a path or `node:` -> nothing. */
function packageOf(specifier: string): string | undefined {
  if (/^(?:\.|\/|node:|@\/|~\/|#)/.test(specifier)) return undefined;
  const parts = specifier.split('/');
  return specifier.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0];
}

/** Source-file paths inside a shell command: `tsx worker.ts`, `node scripts/seed.js`. */
function pathsInCommand(command: unknown): string[] {
  if (typeof command !== 'string') return [];
  return [
    ...command.matchAll(/(?:^|[\s"'=(])((?:\.{0,2}\/)?[\w@.-][\w@./-]*\.[cm]?[jt]sx?)\b/g),
  ].map((match) => match[1]!);
}

function flattenExports(value: unknown): string[] {
  if (typeof value === 'string') return [value];
  if (value && typeof value === 'object') return Object.values(value).flatMap(flattenExports);
  return [];
}

interface Manifest {
  path: string;
  json: {
    main?: unknown;
    module?: unknown;
    bin?: string | Record<string, string>;
    exports?: unknown;
    scripts?: Record<string, string>;
    dependencies?: Record<string, string>;
  };
}

/** The root's package.json, and one level of workspace packages below it. */
function manifestsUnder(root: string): Manifest[] {
  const found: Manifest[] = [];
  const read = (path: string): void => {
    if (!existsSync(path)) return;
    try {
      found.push({ path, json: JSON.parse(readFileSync(path, 'utf8')) as Manifest['json'] });
    } catch {
      // A broken manifest only costs its entry points.
    }
  };
  read(join(root, 'package.json'));
  for (const group of ['apps', 'packages', 'services']) {
    const dir = join(root, group);
    if (!existsSync(dir)) continue;
    for (const entry of safeList(dir)) read(join(dir, entry, 'package.json'));
  }
  return found;
}

/** Files beside a manifest that start the app or name what it runs. */
function runFiles(dir: string): string[] {
  return safeList(dir)
    .filter((name) =>
      /^(?:Dockerfile.*|Procfile|docker-compose.*\.ya?ml|compose\.ya?ml|index\.html|[^/]+\.config\.[cm]?[jt]s|\.babelrc.*|tsconfig.*\.json|vercel\.json|nodemon\.json|README[^/]*\.md)$/i.test(
        name,
      ),
    )
    .map((name) => join(dir, name));
}

function filesUnder(root: string, accept: (name: string) => boolean, limit = 20_000): string[] {
  const found: string[] = [];
  const stack = [root];
  while (stack.length > 0 && found.length < limit) {
    const dir = stack.pop()!;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name) && !entry.name.startsWith('.'))
          stack.push(join(dir, entry.name));
      } else if (
        SOURCE_FILE.test(entry.name) &&
        accept(join(dir, entry.name).split('\\').join('/'))
      ) {
        found.push(join(dir, entry.name));
      }
    }
  }
  return found;
}

function relFromRoot(loaded: LoadedProject, absolute: string): string | undefined {
  const rel = relative(loaded.root, absolute).split('\\').join('/');
  return rel.startsWith('..') ? undefined : rel;
}

/** A referenced path to the scanned file it names, extension or not. */
function matchSource(rel: string, byRel: ReadonlyMap<string, unknown>): string | undefined {
  const bare = rel.replace(/^\.\//, '');
  if (byRel.has(bare)) return bare;
  const stem = bare.replace(/\.[cm]?js$/, '');
  const direct = ['.ts', '.tsx', '.js', '.jsx', '.mts', '.cts', '.mjs', '.cjs']
    .map((ext) => `${stem}${ext}`)
    .find((candidate) => byRel.has(candidate));
  if (direct) return direct;
  // Written from somewhere else — a README at the repo top naming
  // `examples/crud/demo-trace.mjs` — so match the scanned path it ends with.
  return [...byRel.keys()].find((rel) => bare.endsWith(`/${rel}`));
}

function countWord(text: string, word: string): number {
  const escaped = word.replace(/[$]/g, '\\$');
  return (text.match(new RegExp(`(?<![\\w$])${escaped}(?![\\w$])`, 'g')) ?? []).length;
}

function safeRead(path: string): string {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return '';
  }
}

function safeList(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

export interface UncalledEndpoint {
  label: string;
  file?: string;
  line?: number;
}

export interface ProjectUnused extends UnusedReport {
  /**
   * Backend routes no frontend call reaches. A route file is loaded by the
   * framework, so it is never an unused *file* — but an endpoint nothing
   * calls is dead just the same, unless another app, a webhook or a mobile
   * client calls it, which is why it is listed apart.
   */
  endpoints: UncalledEndpoint[];
}

/** The scan's unused-code report, with the endpoints nothing calls. */
export function projectUnused(graph: FlowGraph): ProjectUnused {
  const base: UnusedReport = graph.meta.unused ?? {
    files: [],
    broken: [],
    exports: [],
    folders: [],
    dependencies: [],
    checked: { files: 0, entries: 0 },
    notes: ['This graph was scanned before unused code was tracked — rescan to see it.'],
  };
  const endpoints = findDeadEndpoints(graph)
    .filter((node) => !node.meta?.['discoveredAtRuntime'])
    .map((node) => ({
      label: node.label,
      ...(node.source ? { file: node.source.file, line: node.source.line } : {}),
    }))
    .sort((a, b) => a.label.localeCompare(b.label));
  return { ...base, endpoints };
}
