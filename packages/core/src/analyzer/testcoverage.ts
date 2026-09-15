/**
 * Which tests cover a feature — and, more usefully, which steps of it nothing
 * covers.
 *
 * The question this answers is the one that decides whether a change is scary:
 * a developer about to edit a shared service wants to know if anything will
 * tell them when they break it. "17 steps, 4 of them tested" is a different
 * decision from "17 steps, all tested", and neither was visible anywhere.
 *
 * Read with fs and regular expressions rather than through the analyzer,
 * deliberately. Test files are excluded from the scan by default (they would
 * otherwise appear as components and routes in their own right), and the only
 * two facts needed here are the titles and the imports — both unambiguous
 * lines. Parsing every spec file to learn two strings would slow the scan down
 * for no extra answer.
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { basename, dirname, extname, join, relative, resolve, sep } from 'node:path';
import type { FeatureFlow } from '../flow/resolve.js';

/** Same shape the project walker uses to exclude tests from the graph. */
const TEST_PATTERN = /\.(test|spec|cy|e2e)\.[cm]?[jt]sx?$/;

const SKIP_DIRS = new Set([
  'node_modules',
  '.git',
  'dist',
  'build',
  'out',
  '.next',
  '.nuxt',
  'coverage',
  '.turbo',
]);

const MAX_DEPTH = 12;

/** Extensions tried when resolving an extensionless relative import. */
const RESOLVE_EXTENSIONS = ['.ts', '.tsx', '.js', '.jsx', '.mts', '.cts', '.mjs', '.cjs'];

export interface TestCase {
  /** The `it(...)` / `test(...)` title. */
  title: string;
  /** The enclosing `describe(...)`, when there is one. */
  suite?: string;
  line: number;
}

export interface TestFile {
  /** Path relative to the scan root, forward-slashed, as node ids use. */
  file: string;
  cases: TestCase[];
  /** Project files this test imports, relative to the root. */
  covers: string[];
  /** True when the file drives the CLI or the server rather than a unit. */
  integration: boolean;
}

export interface TestIndex {
  files: TestFile[];
  /** Source file -> the test files that import it. */
  byCoveredFile: ReadonlyMap<string, string[]>;
  totalCases: number;
}

const EMPTY: TestIndex = { files: [], byCoveredFile: new Map(), totalCases: 0 };

/**
 * Find every test file under the roots and record what it imports.
 *
 * Only *relative* imports are followed. A test importing `@flowslens/core` says
 * nothing about which file it covers, and treating a package name as a covered
 * path would credit coverage to files nobody tested.
 */
export function indexTests(roots: readonly string[]): TestIndex {
  const [primary] = roots;
  if (!primary) return EMPTY;

  const files: TestFile[] = [];
  const byCoveredFile = new Map<string, string[]>();
  let totalCases = 0;

  for (const root of roots) {
    for (const absolute of findTestFiles(root)) {
      let text: string;
      try {
        text = readFileSync(absolute, 'utf8');
      } catch {
        continue;
      }

      const rel = toRel(primary, absolute);
      const cases = readCases(text);
      const covers = readCoveredFiles(text, absolute, primary);

      totalCases += cases.length;
      files.push({
        file: rel,
        cases,
        covers,
        // A test that spawns the CLI or boots the server covers the whole
        // chain, which is worth saying differently from a unit test.
        integration: /spawn|createServer|execFile|fetch\(/.test(text),
      });

      for (const covered of covers) {
        const existing = byCoveredFile.get(covered);
        if (existing) existing.push(rel);
        else byCoveredFile.set(covered, [rel]);
      }
    }
  }

  files.sort((a, b) => a.file.localeCompare(b.file));
  return { files, byCoveredFile, totalCases };
}

/**
 * `describe('X', ...)` / `it('y', ...)` titles.
 *
 * Template literals and dynamic titles are skipped rather than reported with
 * their backticks showing: a half-interpolated string in a list of test names
 * reads as a bug in Flowslens.
 */
function readCases(text: string): TestCase[] {
  const cases: TestCase[] = [];
  const lines = text.split('\n');
  let suite: string | undefined;

  for (const [index, line] of lines.entries()) {
    const describe = /\bdescribe(?:\.\w+)?\(\s*['"]([^'"]+)['"]/.exec(line);
    if (describe?.[1]) {
      suite = describe[1];
      continue;
    }
    const test = /\b(?:it|test)(?:\.\w+)?\(\s*['"]([^'"]+)['"]/.exec(line);
    if (test?.[1]) {
      cases.push({
        title: test[1],
        ...(suite ? { suite } : {}),
        line: index + 1,
      });
    }
  }

  return cases;
}

/** Relative imports and requires, resolved to real files under the root. */
function readCoveredFiles(text: string, from: string, root: string): string[] {
  const found = new Set<string>();
  const patterns = [
    /\bfrom\s+['"](\.[^'"]+)['"]/g,
    /\bimport\s*\(\s*['"](\.[^'"]+)['"]\s*\)/g,
    /\brequire\s*\(\s*['"](\.[^'"]+)['"]\s*\)/g,
  ];

  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern)) {
      const specifier = match[1];
      if (!specifier) continue;
      const resolved = resolveImport(specifier, dirname(from));
      if (!resolved) continue;
      const rel = toRel(root, resolved);
      // Outside the scanned root, or another test helping this one.
      if (rel.startsWith('..') || TEST_PATTERN.test(rel)) continue;
      found.add(rel);
    }
  }

  return [...found].sort();
}

/**
 * Node/TypeScript import resolution, narrowed to what tests actually use.
 *
 * `./foo.js` is tried as `./foo.ts` first, because that is what a compiled ESM
 * import of a TypeScript file looks like and it is the spelling every test in
 * this repository uses.
 */
function resolveImport(specifier: string, fromDir: string): string | undefined {
  const target = resolve(fromDir, specifier);
  const ext = extname(target);

  if (ext) {
    const withoutExt = target.slice(0, -ext.length);
    for (const candidate of [
      ...RESOLVE_EXTENSIONS.map((replacement) => `${withoutExt}${replacement}`),
      target,
    ]) {
      if (isFile(candidate)) return candidate;
    }
  }

  for (const candidate of [
    ...RESOLVE_EXTENSIONS.map((extension) => `${target}${extension}`),
    ...RESOLVE_EXTENSIONS.map((extension) => join(target, `index${extension}`)),
  ]) {
    if (isFile(candidate)) return candidate;
  }

  return undefined;
}

function isFile(path: string): boolean {
  try {
    return existsSync(path) && statSync(path).isFile();
  } catch {
    return false;
  }
}

function toRel(root: string, path: string): string {
  return relative(root, path).split(sep).join('/');
}

function findTestFiles(root: string): string[] {
  const found: string[] = [];
  try {
    if (!statSync(root).isDirectory()) return found;
  } catch {
    return found;
  }

  const stack: Array<{ dir: string; depth: number }> = [{ dir: root, depth: 0 }];
  while (stack.length > 0) {
    const { dir, depth } = stack.pop()!;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name) || entry.name.startsWith('.')) continue;
        if (depth < MAX_DEPTH) stack.push({ dir: join(dir, entry.name), depth: depth + 1 });
        continue;
      }
      if (TEST_PATTERN.test(entry.name)) found.push(join(dir, entry.name));
    }
  }
  return found;
}

// ---------------------------------------------------------------------------
// Per-flow view
// ---------------------------------------------------------------------------

export interface FlowTests {
  /** Tests that import at least one file this flow runs through. */
  files: Array<{
    file: string;
    cases: TestCase[];
    integration: boolean;
    /** Which of the flow's files this test reaches. */
    coversFromFlow: string[];
  }>;
  totalCases: number;
  /** Files in this flow that no test imports — where a change is unguarded. */
  uncoveredFiles: Array<{ file: string; steps: string[] }>;
  /** Share of the flow's files that a test reaches, 0–100. */
  coveragePct: number;
  notes: string[];
}

/**
 * Which tests would notice if this feature broke.
 *
 * Coverage is measured in *files the flow runs through*, not lines. A line
 * percentage would be a more familiar number and a worse answer: the question
 * is "will anything fail if I change this step", and a test that imports the
 * file at all is the honest unit for that.
 */
export function testsForFlow(index: TestIndex, flow: FeatureFlow): FlowTests {
  const flowFiles = new Map<string, string[]>();
  for (const step of flow.steps) {
    if (!step.file) continue;
    const steps = flowFiles.get(step.file);
    if (steps) steps.push(step.label);
    else flowFiles.set(step.file, [step.label]);
  }

  const relevant = new Map<string, string[]>();
  const covered = new Set<string>();

  for (const file of flowFiles.keys()) {
    for (const test of index.byCoveredFile.get(file) ?? []) {
      covered.add(file);
      const list = relevant.get(test);
      if (list) list.push(file);
      else relevant.set(test, [file]);
    }
  }

  const files = [...relevant.entries()]
    .map(([file, coversFromFlow]) => {
      const entry = index.files.find((candidate) => candidate.file === file);
      return {
        file,
        cases: entry?.cases ?? [],
        integration: entry?.integration ?? false,
        coversFromFlow: coversFromFlow.sort(),
      };
    })
    .sort((a, b) => b.cases.length - a.cases.length || a.file.localeCompare(b.file));

  const uncoveredFiles = [...flowFiles.entries()]
    .filter(([file]) => !covered.has(file))
    .map(([file, steps]) => ({ file, steps: [...new Set(steps)].sort() }))
    .sort((a, b) => b.steps.length - a.steps.length);

  const totalFiles = flowFiles.size;
  const coveragePct = totalFiles === 0 ? 0 : Math.round((covered.size / totalFiles) * 100);
  const totalCases = files.reduce((sum, file) => sum + file.cases.length, 0);

  const notes: string[] = [];
  if (index.files.length === 0) {
    notes.push('No test files found under the scanned roots.');
  } else if (files.length === 0) {
    notes.push(
      'No test imports any file this feature runs through. A change here would ' + 'fail silently.',
    );
  }
  if (uncoveredFiles.length > 0 && files.length > 0) {
    notes.push(
      `${uncoveredFiles.length} of ${totalFiles} files in this flow have no test ` +
        'importing them.',
    );
  }
  notes.push(
    'Coverage is measured in files this flow runs through, not lines — it answers ' +
      '"would anything fail?", not "how thoroughly?".',
  );

  return { files, totalCases, uncoveredFiles, coveragePct, notes };
}

/** The bare name, for a compact label: `orders.service.ts`. */
export function testFileName(file: string): string {
  return basename(file);
}
