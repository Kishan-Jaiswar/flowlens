import { existsSync, lstatSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { basename, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { Project, ScriptTarget, type SourceFile } from 'ts-morph';

/**
 * Directories never worth reading.
 *
 * Deliberately broad: FlowLens gets pointed at whatever a developer has on
 * disk, and walking a `.venv` or a `target/` directory is pure cost. Missing an
 * entry only slows a scan down; a wrong entry hides real code, so anything
 * ambiguous is left out.
 */
const DEFAULT_IGNORES = new Set([
  // package managers / vendored code
  'node_modules',
  'bower_components',
  'vendor',
  'jspm_packages',
  '.yarn',
  '.pnpm-store',
  // vcs & tooling metadata
  '.git',
  '.hg',
  '.svn',
  '.flowlens',
  '.idea',
  '.vscode',
  '.history',
  // build output
  'dist',
  'build',
  'out',
  'output',
  '.next',
  '.nuxt',
  '.svelte-kit',
  '.output',
  '.angular',
  '.docusaurus',
  'storybook-static',
  '.expo',
  // caches
  '.cache',
  '.turbo',
  '.nx',
  '.parcel-cache',
  '.rollup.cache',
  '.eslintcache',
  'coverage',
  '.nyc_output',
  // other ecosystems
  '__pycache__',
  '.pytest_cache',
  '.venv',
  'venv',
  'target',
  '.gradle',
  'Pods',
  '.terraform',
  '.serverless',
  '.vercel',
  '.netlify',
]);

const SOURCE_EXTENSIONS = ['.ts', '.tsx', '.js', '.jsx', '.mts', '.cts', '.mjs', '.cjs'];

/** Files that are technically source but never worth parsing. */
const SKIP_FILE = [
  /\.d\.[cm]?ts$/, // type declarations
  /\.min\.[cm]?js$/, // minified
  /\.bundle\.[cm]?js$/,
  /\.chunk\.[cm]?js$/,
  /-min\.js$/,
  /\.generated\.[cm]?[jt]sx?$/,
  /\.pb\.[cm]?[jt]s$/, // protobuf output
];

const TEST_PATTERN = /\.(test|spec|stories|cy|e2e)\.[cm]?[jt]sx?$/;

/**
 * Extensions FlowLens can see but not yet read.
 *
 * Counted so a scan of a Vue or Django project can say "found 40 .vue files,
 * which are not parsed yet" instead of the misleading "no source files found".
 */
const UNPARSED_EXTENSIONS = [
  '.vue',
  '.svelte',
  '.astro',
  '.py',
  '.rb',
  '.go',
  '.java',
  '.kt',
  '.php',
  '.cs',
  '.rs',
  '.ex',
  '.dart',
];

/** A single file bigger than this is almost certainly generated. */
const MAX_FILE_BYTES = 2_000_000;

/** Safety valve so a scan of the wrong directory cannot exhaust memory. */
const DEFAULT_MAX_FILES = 20_000;

/** Depth limit, as a backstop against pathological trees. */
const MAX_DEPTH = 24;

export interface ScanOptions {
  /** Root directory (or a single file) to scan. */
  root: string;
  /**
   * Additional roots to scan in the same graph.
   *
   * A frontend and backend often live in sibling repositories
   * (`~/code/app-web`, `~/code/app-api`). The seam between them is the whole
   * point of FlowLens, so both must be in one graph. Files are labelled by
   * their root (`app-web/pages/...`) to keep node ids unique and readable.
   */
  extraRoots?: string[];
  /** Extra directory names to skip. */
  ignore?: string[];
  /** Include `*.test.ts` / `*.spec.ts` / `*.stories.tsx` files (off by default). */
  includeTests?: boolean;
  /** Cap on files parsed. Defaults to 20,000. */
  maxFiles?: number;
}

export interface LoadedProject {
  project: Project;
  /** The primary root — where `.flowlens/` is written. */
  root: string;
  /** Every scanned root, primary first. */
  roots: string[];
  sourceFiles: SourceFile[];
  /** Non-fatal problems worth telling the user about. */
  warnings: string[];
  /** Counts of files present but not parseable, by extension. */
  unparsedFileTypes: Record<string, number>;
  /** Path relative to its root, with forward slashes — used in every node id. */
  rel(file: SourceFile | string): string;
}

/**
 * Load one or more directories into ts-morph without requiring a tsconfig.
 *
 * Real projects are messy: a monorepo may hold three tsconfigs, a JS-only
 * frontend and a Nest backend. FlowLens only needs the syntax tree, so we skip
 * type-checking setup entirely and walk the file system ourselves. That keeps a
 * scan fast and, more importantly, keeps it from failing on a project whose
 * `tsc` build is currently broken.
 */
export function loadProject(options: ScanOptions): LoadedProject {
  const warnings: string[] = [];
  const primary = resolve(options.root);
  if (!existsSync(primary)) {
    throw new Error(`FlowLens: path does not exist: ${primary}`);
  }

  const extraRoots: string[] = [];
  for (const candidate of options.extraRoots ?? []) {
    const path = resolve(candidate);
    if (!existsSync(path)) {
      throw new Error(`FlowLens: path does not exist: ${path}`);
    }
    if (path === primary || extraRoots.includes(path)) continue;
    extraRoots.push(path);
  }

  const ignore = new Set([...DEFAULT_IGNORES, ...(options.ignore ?? [])]);
  const maxFiles = options.maxFiles ?? DEFAULT_MAX_FILES;

  const project = new Project({
    useInMemoryFileSystem: false,
    skipAddingFilesFromTsConfig: true,
    skipFileDependencyResolution: true,
    compilerOptions: {
      allowJs: true,
      jsx: 4 /* ts.JsxEmit.ReactJSX */,
      target: ScriptTarget.ESNext,
      noLib: true,
      // Decorators appear in Nest backends and in some .js frontends.
      experimentalDecorators: true,
    },
  });

  const allRoots = [primary, ...extraRoots];
  const collected: string[] = [];
  const unparsedFileTypes: Record<string, number> = {};
  /** Guards against the same file arriving through two overlapping roots. */
  const seenFiles = new Set<string>();

  for (const current of allRoots) {
    const found = collectSourceFiles(current, {
      ignore,
      includeTests: options.includeTests ?? false,
      warnings,
      unparsed: unparsedFileTypes,
    });
    for (const file of found) {
      const key = pathKey(file);
      if (seenFiles.has(key)) continue;
      seenFiles.add(key);
      collected.push(file);
    }
  }

  let files = collected;
  if (files.length > maxFiles) {
    warnings.push(
      `found ${files.length} source files; parsing the first ${maxFiles}. ` +
        `Narrow the scan with a more specific path or --ignore <dir>.`,
    );
    files = files.slice(0, maxFiles);
  }

  for (const file of files) {
    try {
      project.addSourceFileAtPathIfExists(file);
    } catch (error) {
      // A file that cannot be parsed must not end the scan.
      warnings.push(`could not read ${file}: ${errorMessage(error)}`);
    }
  }

  const sourceFiles = project.getSourceFiles();

  /**
   * Path relative to whichever root contains the file.
   *
   * With several roots the basename is prepended, so `pages/index.js` in two
   * different repos does not produce the same node id — and a developer reading
   * `shop-web/pages/index.js` immediately knows which repo it is.
   */
  const multiRoot = allRoots.length > 1;
  const labels = rootLabels(allRoots);
  const rel = (file: SourceFile | string): string => {
    const path = typeof file === 'string' ? file : file.getFilePath();
    let best: { label: string; path: string } | undefined;
    for (const current of allRoots) {
      const candidate = relative(current, path);
      if (candidate.startsWith('..') || isAbsolute(candidate)) continue;
      // With nested roots, the deepest match is the right one.
      if (!best || candidate.length < best.path.length) {
        best = { label: labels.get(current) ?? basename(current), path: candidate };
      }
    }
    if (!best) return path;
    const normalized = best.path.split(sep).join('/');
    return multiRoot ? `${best.label}/${normalized}` : normalized;
  };

  return { project, root: primary, roots: allRoots, sourceFiles, warnings, unparsedFileTypes, rel };
}

/**
 * Distinct labels for the scanned roots.
 *
 * Two repos can share a basename (`~/a/api` and `~/b/api`), and identical
 * labels would collide in node ids, so the parent directory is added until the
 * labels differ.
 */
function rootLabels(roots: string[]): Map<string, string> {
  const labels = new Map<string, string>();
  const counts = new Map<string, number>();
  for (const root of roots) {
    const name = basename(root);
    counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  for (const root of roots) {
    const name = basename(root);
    if ((counts.get(name) ?? 0) > 1) {
      const parent = basename(resolve(root, '..'));
      labels.set(root, parent ? `${parent}-${name}` : name);
    } else {
      labels.set(root, name);
    }
  }
  return labels;
}

interface CollectOptions {
  ignore: Set<string>;
  includeTests: boolean;
  warnings: string[];
  /** Tally of files seen but not parseable, by extension. */
  unparsed: Record<string, number>;
}

/**
 * Walk a directory tree for source files.
 *
 * Symlink-aware: a link pointing at an ancestor (a `node_modules/self` link, a
 * `current -> .` deploy symlink) would otherwise make this loop forever, so
 * every directory is recorded by its real path and visited once.
 */
function collectSourceFiles(target: string, options: CollectOptions): string[] {
  const found: string[] = [];

  let rootStats;
  try {
    rootStats = statSync(target);
  } catch (error) {
    options.warnings.push(`cannot read ${target}: ${errorMessage(error)}`);
    return found;
  }

  // Pointing FlowLens at a single file should work.
  if (rootStats.isFile()) {
    if (isSourceFile(basename(target), options.includeTests)) found.push(target);
    return found;
  }
  if (!rootStats.isDirectory()) return found;

  const visited = new Set<string>();
  const stack: Array<{ dir: string; depth: number }> = [{ dir: target, depth: 0 }];

  while (stack.length > 0) {
    const { dir, depth } = stack.pop()!;

    let real: string;
    try {
      real = realpathSync(dir);
    } catch {
      continue;
    }
    if (visited.has(real)) continue;
    visited.add(real);

    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      continue; // unreadable directory — skip rather than abort the scan
    }

    for (const entry of entries) {
      if (options.ignore.has(entry)) continue;
      const full = join(dir, entry);

      let stats;
      try {
        // lstat first: we must know it is a link before following it.
        stats = lstatSync(full);
      } catch {
        continue;
      }

      if (stats.isSymbolicLink()) {
        let linked;
        try {
          linked = statSync(full); // resolves the link
        } catch {
          continue; // broken link
        }
        if (linked.isDirectory()) {
          if (depth < MAX_DEPTH) stack.push({ dir: full, depth: depth + 1 });
          continue;
        }
        if (linked.isFile() && isSourceFile(entry, options.includeTests)) {
          if (linked.size <= MAX_FILE_BYTES) found.push(full);
        }
        continue;
      }

      if (stats.isDirectory()) {
        if (depth < MAX_DEPTH) stack.push({ dir: full, depth: depth + 1 });
        continue;
      }

      if (!stats.isFile()) continue;
      if (!isSourceFile(entry, options.includeTests)) {
        tallyUnparsed(entry, options.unparsed);
        continue;
      }
      if (stats.size > MAX_FILE_BYTES) continue;
      found.push(full);
    }
  }

  // Sorted so a scan is deterministic regardless of file system ordering.
  return found.sort();
}

/**
 * A key for "is this the same file?".
 *
 * Windows and macOS default to case-insensitive file systems, so two roots that
 * differ only in the case of a shared parent (`C:\Code\app` and `C:\code\app`)
 * would otherwise deliver every file twice — and each copy would produce its
 * own set of graph nodes. Linux is case-sensitive, where two such paths really
 * are two files, so the comparison stays exact there.
 */
function pathKey(path: string): string {
  return process.platform === 'win32' || process.platform === 'darwin' ? path.toLowerCase() : path;
}

function tallyUnparsed(name: string, tally: Record<string, number>): void {
  const extension = UNPARSED_EXTENSIONS.find((candidate) => name.endsWith(candidate));
  if (!extension) return;
  tally[extension] = (tally[extension] ?? 0) + 1;
}

function isSourceFile(name: string, includeTests: boolean): boolean {
  if (!SOURCE_EXTENSIONS.some((ext) => name.endsWith(ext))) return false;
  if (SKIP_FILE.some((pattern) => pattern.test(name))) return false;
  if (!includeTests && TEST_PATTERN.test(name)) return false;
  return true;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Describe the shape of a scanned tree, for the scan summary.
 *
 * Purely informational — no analyzer behaviour depends on folder names, because
 * folder names are the least reliable thing about a real repository.
 */
export function detectProjects(root: string): Record<string, string> {
  const projects: Record<string, string> = {};
  const candidates: Array<[string, string[]]> = [
    ['web', ['web', 'frontend', 'client', 'apps/web', 'packages/web', 'src/client']],
    ['api', ['api', 'backend', 'server', 'apps/api', 'packages/api', 'src/server']],
  ];
  for (const [role, dirs] of candidates) {
    for (const dir of dirs) {
      if (existsSync(join(root, dir))) {
        projects[role] = dir;
        break;
      }
    }
  }
  return projects;
}
