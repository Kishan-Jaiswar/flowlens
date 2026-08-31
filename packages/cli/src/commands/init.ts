import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { basename, join, relative, resolve, sep } from 'node:path';
import { CONFIG_FILENAMES } from '@flowlens/core';
import { color, glyph, heading } from '../ui.js';

export interface InitArgs {
  root: string;
  extraRoots?: string[];
  /** Overwrite an existing config instead of refusing. */
  force?: boolean;
  /**
   * Print the config to stdout instead of writing it.
   *
   * `init` is the one command that writes into the project, and only because
   * that is what the developer asked for. `--print` keeps even that read-only.
   */
  print?: boolean;
  json?: boolean;
  quiet?: boolean;
}

/** What `init` worked out about a project, before writing anything. */
export interface Detection {
  /** Roots to scan, absolute. */
  roots: string[];
  /** How each root was found, for the summary. */
  reasons: string[];
  /** A request-wrapper regex inferred from the code, if a family was found. */
  requestFunctionPattern?: string;
  /** Route prefixes seen in the backend, e.g. `/api`. */
  apiPrefixes?: string[];
}

/**
 * `flowlens init` — write a config file so every later command is just
 * `flowlens scan`.
 *
 * The point is a one-command start on a project nobody has configured. It looks
 * at the directory it was given, works out where the frontend and backend
 * actually live — including the very common case of two sibling repositories —
 * and records the answer in `flowlens.config.json` so the whole team gets the
 * same graph.
 *
 * Reads files only. Nothing is executed, nothing is installed, no network.
 */
export function runInit(args: InitArgs): number {
  const root = resolve(args.root);
  if (!existsSync(root)) {
    process.stderr.write(`${color.red('error')} path does not exist: ${root}\n`);
    return 1;
  }

  const existing = CONFIG_FILENAMES.map((name) => join(root, name)).find((path) =>
    existsSync(path),
  );
  if (existing && !args.force) {
    process.stderr.write(
      `${color.red('error')} ${displayPath(existing)} already exists.\n` +
        `Edit it, or re-run with --force to replace it.\n`,
    );
    return 1;
  }

  const detection = detectSetup(root, args.extraRoots ?? []);
  const config = buildConfig(root, detection);
  const target = join(root, CONFIG_FILENAMES[0]);

  // --print writes nothing: redirect it yourself, or keep the project pristine.
  if (args.print === true) {
    process.stdout.write(`${JSON.stringify(config, null, 2)}\n`);
    return 0;
  }

  writeFileSync(target, `${JSON.stringify(config, null, 2)}\n`, 'utf8');

  if (args.json) {
    process.stdout.write(`${JSON.stringify({ config: target, ...config }, null, 2)}\n`);
    return 0;
  }
  if (args.quiet) {
    process.stdout.write(`${target}\n`);
    return 0;
  }

  process.stdout.write(
    `\n${color.bold('FlowLens')} is set up for ${color.cyan(basename(root) || root)}\n`,
  );
  process.stdout.write(heading('What it found') + '\n');
  for (const reason of detection.reasons) {
    process.stdout.write(`  ${color.green(glyph.bullet)} ${reason}\n`);
  }
  if (detection.reasons.length === 0) {
    process.stdout.write(
      color.gray(`  no separate frontend or backend directory — scanning the whole project\n`),
    );
  }
  process.stdout.write(
    `\n${color.gray('wrote:')}  ${displayPath(target)} ${color.gray('(the only file FlowLens creates in your project)')}\n` +
      `${color.gray('next:')}   flowlens scan\n` +
      `${color.gray('   or:')}   flowlens serve\n`,
  );
  return 0;
}

/**
 * The shorter of the relative and absolute spellings.
 *
 * A path in a temporary directory or on another drive relativises to something
 * like `../../../../tmp/x`, which is harder to read than the absolute path and,
 * on Windows across drives, is not even expressible.
 */
function displayPath(path: string): string {
  const from = relative(process.cwd(), path);
  return from && from.length < path.length ? from : path;
}

/**
 * Work out what to scan.
 *
 * Ordered from most to least confident: roots the user named, then a monorepo's
 * web/api directories, then sibling repositories, then the project itself.
 */
export function detectSetup(root: string, extraRoots: string[]): Detection {
  const reasons: string[] = [];

  if (extraRoots.length > 0) {
    const roots = [root, ...extraRoots.map((path) => resolve(path))];
    reasons.push(`${roots.length} roots given on the command line`);
    return { roots, ...inferConventions(roots), reasons };
  }

  const inside = findHalvesInside(root);
  if (inside.length > 0) {
    reasons.push(
      ...inside.map((path) => `${labelOf(path)}: ${relative(root, path).split(sep).join('/')}`),
    );
    // The project root covers both halves already; scanning it once keeps node
    // ids relative to one tree, which is what makes a graph portable.
    return { roots: [root], ...inferConventions([root]), reasons };
  }

  const siblings = findSiblingRepositories(root);
  if (siblings.length > 0) {
    const roots = [root, ...siblings];
    reasons.push(
      `this project looks like one half of a pair`,
      ...siblings.map((path) => `also scanning sibling: ${basename(path)}`),
    );
    return { roots, ...inferConventions(roots), reasons };
  }

  return { roots: [root], ...inferConventions([root]), reasons };
}

/** Directory names that mean "the frontend" or "the backend" lives here. */
const WEB_DIRS = ['web', 'frontend', 'client', 'ui', join('apps', 'web'), join('packages', 'web')];
const API_DIRS = [
  'api',
  'backend',
  'server',
  join('apps', 'api'),
  join('packages', 'api'),
  join('apps', 'server'),
];

function findHalvesInside(root: string): string[] {
  const found: string[] = [];
  for (const group of [WEB_DIRS, API_DIRS]) {
    for (const dir of group) {
      const candidate = join(root, dir);
      if (isDirectory(candidate) && hasSourceFiles(candidate)) {
        found.push(candidate);
        break;
      }
    }
  }
  return found.length === 2 ? found : [];
}

/**
 * Sibling repositories that look like the other half of this application.
 *
 * `~/code/shop-web` and `~/code/shop-api` is an extremely common layout, and the
 * seam between the two is the whole point of FlowLens — so a graph built from
 * only one of them is missing the interesting part.
 */
export function findSiblingRepositories(root: string): string[] {
  const name = basename(root);
  const parent = resolve(root, '..');
  if (parent === root) return [];

  // shop-web -> shop, shop_frontend -> shop
  const stem = name.replace(/[-_.](web|frontend|client|ui|api|backend|server)$/i, '');
  if (stem === name || stem === '') return [];

  const isBackendHalf = /[-_.](api|backend|server)$/i.test(name);
  const wanted = isBackendHalf ? ['web', 'frontend', 'client', 'ui'] : ['api', 'backend', 'server'];

  let entries: string[];
  try {
    entries = readdirSync(parent);
  } catch {
    return [];
  }

  const matches: string[] = [];
  for (const entry of entries) {
    const candidate = join(parent, entry);
    if (candidate === root || !isDirectory(candidate)) continue;
    const lower = entry.toLowerCase();
    if (!lower.startsWith(stem.toLowerCase())) continue;
    if (!wanted.some((suffix) => lower.endsWith(suffix))) continue;
    if (!hasSourceFiles(candidate)) continue;
    matches.push(candidate);
  }
  return matches.sort();
}

/**
 * Read a couple of conventions out of the code so the config is useful rather
 * than empty.
 *
 * Only patterns FlowLens can see in the source are recorded — a guess that is
 * wrong is worse than no entry at all, because it silently changes every scan.
 */
function inferConventions(
  roots: string[],
): Pick<Detection, 'requestFunctionPattern' | 'apiPrefixes'> {
  const wrappers = new Set<string>();
  const prefixes = new Set<string>();

  for (const root of roots) {
    for (const file of sampleFiles(root, 400)) {
      let text: string;
      try {
        text = readFileSync(file, 'utf8');
      } catch {
        continue;
      }
      if (text.length > 400_000) continue;

      // A wrapper family like getRequest / postRequestNoLoader.
      for (const match of text.matchAll(
        /\b(?:export\s+)?(?:const|function|async function)\s+((?:get|post|put|patch|delete)Request[A-Za-z0-9_]*)\b/g,
      )) {
        wrappers.add(match[1]!);
      }
      // A controller prefix like @Controller('api/customers').
      for (const match of text.matchAll(/@Controller\(\s*['"`]([^'"`]*)['"`]/g)) {
        const first = match[1]!.split('/').filter(Boolean)[0];
        if (first && !first.includes(':')) prefixes.add(`/${first}`);
      }
    }
  }

  const result: Pick<Detection, 'requestFunctionPattern' | 'apiPrefixes'> = {};
  if (wrappers.size > 0) {
    result.requestFunctionPattern = '^(get|post|put|patch|delete)Request[A-Za-z0-9_]*$';
  }
  // Only worth recording when every controller agrees; a mixed set means the
  // prefix is not a project-wide convention and stripping it would break URLs.
  if (prefixes.size === 1) {
    result.apiPrefixes = [...prefixes];
  }
  return result;
}

function buildConfig(root: string, detection: Detection): Record<string, unknown> {
  const config: Record<string, unknown> = {};
  /**
   * `roots` is always written, even when it is just `["."]`.
   *
   * Roots in a config file are resolved relative to the file, so recording them
   * is what lets `flowlens scan` work from *any* subdirectory of the project
   * rather than scanning whatever directory the shell happens to be in. Paths
   * are relative and use `/`, so the file survives being committed and read on
   * another machine.
   */
  config['roots'] = detection.roots.map((path) => toPortable(relative(root, path) || '.'));
  if (detection.apiPrefixes) config['apiPrefixes'] = detection.apiPrefixes;
  if (detection.requestFunctionPattern) {
    config['requestFunctionPattern'] = detection.requestFunctionPattern;
  }
  return config;
}

/** Config files are shared through git, so paths in them always use `/`. */
function toPortable(path: string): string {
  return path.split(sep).join('/');
}

function labelOf(path: string): string {
  const name = basename(path).toLowerCase();
  return ['api', 'backend', 'server'].includes(name) ? 'backend' : 'frontend';
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

const SOURCE_EXTENSIONS = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.mts', '.cts'];
const SKIP_DIRS = new Set([
  'node_modules',
  '.git',
  'dist',
  'build',
  '.next',
  '.flowlens',
  'coverage',
]);

function hasSourceFiles(root: string): boolean {
  for (const _ of sampleFiles(root, 1)) return true;
  return false;
}

/** A bounded walk — `init` should feel instant even on a huge checkout. */
function* sampleFiles(root: string, limit: number): Generator<string> {
  let yielded = 0;
  const stack: Array<{ dir: string; depth: number }> = [{ dir: root, depth: 0 }];
  while (stack.length > 0 && yielded < limit) {
    const { dir, depth } = stack.pop()!;
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (SKIP_DIRS.has(entry)) continue;
      const full = join(dir, entry);
      let stats;
      try {
        stats = statSync(full);
      } catch {
        continue;
      }
      if (stats.isDirectory()) {
        if (depth < 8) stack.push({ dir: full, depth: depth + 1 });
        continue;
      }
      if (!stats.isFile()) continue;
      if (!SOURCE_EXTENSIONS.some((ext) => entry.endsWith(ext))) continue;
      if (entry.endsWith('.d.ts')) continue;
      yield full;
      yielded += 1;
      if (yielded >= limit) return;
    }
  }
}
