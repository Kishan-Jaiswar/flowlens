/**
 * Keeping FlowLens artifacts out of `git status`.
 *
 * By default there is nothing to do: the graph and the trace live in the OS
 * cache, never in the project (see paths.ts). But `-g graph.json`,
 * `--trace trace.jsonl` and `FLOWLENS_TRACE=./spans.jsonl` all put a generated
 * file inside someone's repository, and then it shows up as an untracked change
 * on every branch until they remember to delete it.
 *
 * FlowLens will not edit a repository it was only asked to read, so the default
 * is a one-line note pointing at `flowlens init --gitignore`. Projects that want
 * it done for them opt in once, in their config, with `"gitignore": true`.
 */

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { color, glyph } from './ui.js';

const BEGIN = '# flowlens:begin (managed by FlowLens)';
const END = '# flowlens:end';

/** A generated file that lives inside a git work tree. */
export interface Artifact {
  /** Absolute path of the file FlowLens writes. */
  file: string;
  /** Absolute path of the work tree containing it. */
  gitRoot: string;
  /** The pattern that would ignore it, relative to the work tree. */
  entry: string;
}

export interface AddResult {
  /** The `.gitignore` written or that would be written. */
  path: string;
  /** Entries added by this call. */
  added: string[];
  /** Entries git already ignored, or that the managed block already had. */
  skipped: string[];
  /** Entries git is already tracking — ignoring them alone will not help. */
  tracked: string[];
}

/**
 * The work tree containing a path, if any.
 *
 * Walks up from the file rather than asking git, so it costs nothing and works
 * for a file that does not exist yet — which is the normal case for `init`,
 * where the point is to ignore the artifact *before* it is first written. A
 * `.git` file rather than a directory is a worktree or submodule; both count.
 */
export function findGitRoot(from: string): string | undefined {
  let current = resolve(from);
  // A path that does not exist yet still has an existing ancestor.
  for (;;) {
    if (existsSync(join(current, '.git'))) return current;
    const parent = dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
}

/** How a git query answered: yes, no, or "git could not tell us". */
type Answer = boolean | undefined;

function git(gitRoot: string, args: string[]): Answer {
  try {
    const result = spawnSync('git', args, { cwd: gitRoot, stdio: 'ignore', timeout: 5000 });
    if (result.error || result.status === null) return undefined;
    if (result.status === 0) return true;
    if (result.status === 1) return false;
    // 128 and friends: not a repository, broken index, git too old to be asked.
    return undefined;
  } catch {
    return undefined;
  }
}

/** Does git already ignore this file? `undefined` when git cannot be run. */
export function isIgnored(gitRoot: string, file: string): Answer {
  return git(gitRoot, ['check-ignore', '--quiet', '--', file]);
}

/** Is the file already committed? Ignoring a tracked file does nothing. */
export function isTracked(gitRoot: string, file: string): Answer {
  return git(gitRoot, ['ls-files', '--error-unmatch', '--', file]);
}

/**
 * Describe a path FlowLens writes, if it is somewhere git would notice it.
 *
 * Returns nothing for the common case — a path in the OS cache, outside any
 * repository — so callers can treat "no artifact" as "nothing to say".
 */
export function inspect(file: string): Artifact | undefined {
  const absolute = resolve(file);
  const gitRoot = findGitRoot(absolute);
  if (gitRoot === undefined) return undefined;
  // A path inside .git itself is git's business, not ours.
  const rel = relative(gitRoot, absolute);
  if (rel === '' || rel.startsWith('..') || rel.split(sep)[0] === '.git') return undefined;
  return { file: absolute, gitRoot, entry: toPattern(rel) };
}

/**
 * Artifacts inside a repository that git is not already ignoring.
 *
 * When git cannot be consulted the artifact is dropped rather than reported:
 * a wrong "this file is not ignored" note on every scan would be worse than
 * silence, because the fix it suggests would be a no-op.
 */
export function unignored(files: string[]): Artifact[] {
  const seen = new Set<string>();
  const out: Artifact[] = [];
  for (const file of files) {
    const artifact = inspect(file);
    if (!artifact || seen.has(artifact.file)) continue;
    seen.add(artifact.file);
    if (isIgnored(artifact.gitRoot, artifact.file) !== false) continue;
    out.push(artifact);
  }
  return out;
}

/**
 * Add entries to the managed block of a work tree's `.gitignore`.
 *
 * Only FlowLens's own block is ever rewritten: everything the developer wrote
 * is preserved byte for byte, and running this twice changes nothing. Pass
 * `dryRun` to compute the result without writing.
 */
export function addToGitignore(
  gitRoot: string,
  entries: string[],
  options: { dryRun?: boolean } = {},
): AddResult {
  const path = join(gitRoot, '.gitignore');
  const original = readIfPresent(path);
  const block = existingBlock(original);

  const added: string[] = [];
  const skipped: string[] = [];
  const tracked: string[] = [];

  for (const entry of dedupe(entries)) {
    if (block.includes(entry)) {
      skipped.push(entry);
      continue;
    }
    // Outside the managed block the project may already cover it — a broad
    // `*.jsonl`, or a line someone added by hand. Do not add it twice.
    if (isIgnored(gitRoot, join(gitRoot, unescapePattern(entry))) === true) {
      skipped.push(entry);
      continue;
    }
    if (isTracked(gitRoot, join(gitRoot, unescapePattern(entry))) === true) tracked.push(entry);
    added.push(entry);
  }

  if (added.length > 0 && options.dryRun !== true) {
    writeFileSync(path, render(original, [...block, ...added]), 'utf8');
  }
  return { path, added, skipped, tracked };
}

/** Entries currently inside the managed block, in order. */
export function existingBlock(contents: string): string[] {
  const lines = contents.split('\n');
  const start = lines.indexOf(BEGIN);
  if (start === -1) return [];
  const end = lines.indexOf(END, start + 1);
  if (end === -1) return [];
  return lines
    .slice(start + 1, end)
    .map((line) => line.trim())
    .filter((line) => line !== '' && !line.startsWith('#'));
}

/** Replace the managed block, or append one, leaving every other line alone. */
function render(original: string, entries: string[]): string {
  const block = [BEGIN, ...entries, END];
  const lines = original === '' ? [] : original.split('\n');
  const start = lines.indexOf(BEGIN);
  const end = start === -1 ? -1 : lines.indexOf(END, start + 1);

  if (start !== -1 && end !== -1) {
    const next = [...lines.slice(0, start), ...block, ...lines.slice(end + 1)];
    return ensureFinalNewline(next.join('\n'));
  }

  // A file that does not end in a newline would otherwise glue the developer's
  // last pattern onto our marker comment.
  const head = original === '' ? '' : `${ensureFinalNewline(original)}\n`;
  return ensureFinalNewline(`${head}${block.join('\n')}`);
}

function ensureFinalNewline(text: string): string {
  return text.endsWith('\n') ? text : `${text}\n`;
}

/**
 * A repo-relative path as a gitignore pattern.
 *
 * Anchored with a leading `/` so it matches the one file FlowLens actually
 * writes: an unanchored `graph.json` would also hide a `src/graph.json` the
 * developer wrote themselves. `/` is used on every platform — gitignore has no
 * Windows spelling — and the characters git treats as syntax are escaped, so a
 * directory with `[` or a trailing space in its name still produces a pattern
 * that matches exactly one path.
 */
export function toPattern(relativePath: string): string {
  const posix = relativePath.split(sep).join('/');
  return `/${escapePattern(posix)}`;
}

function escapePattern(path: string): string {
  return path.replace(/[[\]*?\\]/g, (char) => `\\${char}`).replace(/ $/, '\\ ');
}

/** The inverse of {@link toPattern}, for handing a real path back to git. */
function unescapePattern(entry: string): string {
  return entry.replace(/^\//, '').replace(/\\(.)/g, '$1');
}

function readIfPresent(path: string): string {
  try {
    if (!existsSync(path) || !statSync(path).isFile()) return '';
    return readFileSync(path, 'utf8');
  } catch {
    return '';
  }
}

function dedupe(values: string[]): string[] {
  return [...new Set(values)];
}

export interface GuardOptions {
  /** `"gitignore": true` in the project config — update the file, do not ask. */
  auto?: boolean;
  /** The `-g` value the user typed, echoed back in the suggested command. */
  graphFlag?: string;
  /** The `--trace` value the user typed. */
  traceFlag?: string;
}

/**
 * What to print about artifacts that would show up in `git status`.
 *
 * Returns the empty string in the ordinary case — nothing written inside a
 * repository, or everything already ignored — so a scan of a normal project is
 * exactly as quiet as it was before.
 */
export function guardArtifacts(files: string[], options: GuardOptions = {}): string {
  const artifacts = unignored(files);
  if (artifacts.length === 0) return '';

  if (options.auto !== true) {
    const lines = artifacts.map(
      (artifact) =>
        `${color.yellow(glyph.warn)} ${color.bold(relative(artifact.gitRoot, artifact.file))} ` +
        `is inside a git repository and is not ignored`,
    );
    lines.push(color.gray(`  add it: ${suggestion(options)}`));
    return `${lines.join('\n')}\n`;
  }

  const lines: string[] = [];
  for (const [gitRoot, group] of byRoot(artifacts)) {
    const result = addToGitignore(
      gitRoot,
      group.map((artifact) => artifact.entry),
    );
    for (const entry of result.added) {
      lines.push(
        color.gray(`gitignore: added ${entry} to ${relative(process.cwd(), result.path)}`),
      );
    }
    for (const entry of result.tracked) {
      lines.push(
        `${color.yellow(glyph.warn)} ${entry.replace(/^\//, '')} is already tracked by git — ` +
          color.gray(`git rm --cached ${entry.replace(/^\//, '')}`),
      );
    }
  }
  return lines.length > 0 ? `${lines.join('\n')}\n` : '';
}

function suggestion(options: GuardOptions): string {
  const flags = [
    options.graphFlag ? `-g ${options.graphFlag}` : '',
    options.traceFlag ? `--trace ${options.traceFlag}` : '',
  ].filter(Boolean);
  return `flowlens init --gitignore${flags.length > 0 ? ` ${flags.join(' ')}` : ''}`;
}

export function byRoot(artifacts: Artifact[]): Map<string, Artifact[]> {
  const groups = new Map<string, Artifact[]>();
  for (const artifact of artifacts) {
    const group = groups.get(artifact.gitRoot);
    if (group) group.push(artifact);
    else groups.set(artifact.gitRoot, [artifact]);
  }
  return groups;
}

/** Candidate artifact paths for a project, in the order a user meets them. */
export function artifactPaths(graphFile: string, traceFile: string): string[] {
  const paths = [graphFile, traceFile];
  /**
   * The runtime tracer writes wherever `FLOWLENS_TRACE` points, and it is set
   * in the *app's* environment — so this catches the case where someone pointed
   * their dev server at a file inside the repository.
   */
  const fromEnv = process.env['FLOWLENS_TRACE'];
  if (fromEnv !== undefined && fromEnv !== '') {
    paths.push(isAbsolute(fromEnv) ? fromEnv : resolve(fromEnv));
  }
  return paths;
}
