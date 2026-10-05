/**
 * What "changed" means, asked of git.
 *
 * Kept out of core on purpose: core takes a list of paths and stays testable
 * without a repository, and the decision about *which* paths — working tree,
 * staged only, or everything since a base branch — is a user-facing choice that
 * belongs with the command line.
 */

import { spawnSync } from 'node:child_process';
import type { BreakageInput, ChangeStatus, ChangedInput } from '@flowslens/core';

/** Git's two-letter porcelain code, mapped to something a person reads. */
function statusOf(code: string): ChangeStatus {
  if (code.includes('?')) return 'untracked';
  if (code.includes('A')) return 'added';
  if (code.includes('D')) return 'deleted';
  if (code.includes('R')) return 'renamed';
  return 'modified';
}

/** A changed file, and where it was before a rename. */
export type ChangedFile = ChangedInput & { from?: string };

export interface ChangedFilesResult {
  files: ChangedFile[];
  /** What was compared, for the UI to state plainly. */
  against: string;
  /** Set when git could not answer — not a git repo, or git is missing. */
  error?: string;
}

/**
 * Every path that differs from the last commit, including untracked files.
 *
 * Untracked files are included because a brand-new component is exactly the
 * kind of change this view should notice, and it is invisible to `git diff`.
 */
export function changedFiles(root: string, base?: string): ChangedFilesResult {
  if (base !== undefined && base !== '') {
    const diff = git(root, ['diff', '--name-status', `${base}...HEAD`]);
    if (diff.error) return { files: [], against: base, error: diff.error };
    return {
      against: `${base}...HEAD`,
      files: diff.out
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean)
        .map((line) => {
          const [code = 'M', ...rest] = line.split(/\s+/);
          // A rename reports both paths; the new one is what exists now.
          const file = rest[rest.length - 1] ?? '';
          const from = rest.length > 1 ? rest[0] : undefined;
          return { file, status: statusOf(code), ...(from ? { from } : {}) };
        })
        .filter((entry) => entry.file !== ''),
    };
  }

  const status = git(root, ['status', '--porcelain=v1', '--untracked-files=all']);
  if (status.error) return { files: [], against: 'the last commit', error: status.error };

  const files: ChangedFile[] = [];
  for (const line of status.out.split('\n')) {
    if (line.trim() === '') continue;
    const code = line.slice(0, 2);
    const path = line.slice(3).trim();
    // `old -> new` for a rename; the new path is the one on disk.
    const [from, renamed] = path.includes(' -> ') ? path.split(' -> ') : [undefined, undefined];
    const file = renamed ?? path;
    if (file === '') continue;
    files.push({
      file: unquote(file),
      status: statusOf(code),
      ...(from ? { from: unquote(from) } : {}),
    });
  }
  return { files, against: 'the last commit' };
}

/**
 * Each changed file with its committed text, for comparing declarations.
 *
 * "Committed" means `HEAD` for working-tree changes, and the merge base for a
 * branch compared with `base` — the version the branch started from, not
 * whatever `base` has moved on to since. A new file gets no text: there is
 * nothing for it to break.
 */
export function withCommittedText(
  root: string,
  files: readonly ChangedFile[],
  base?: string,
): BreakageInput[] {
  let revision = 'HEAD';
  if (base !== undefined && base !== '') {
    const merge = git(root, ['merge-base', base, 'HEAD']);
    revision = merge.error ? base : merge.out.trim() || base;
  }
  return files.map((entry) => {
    const input: BreakageInput = {
      file: entry.file,
      ...(entry.status ? { status: entry.status } : {}),
    };
    if (entry.status === 'added' || entry.status === 'untracked') return input;
    // Repository-relative, like the paths `git status` and `git diff` print.
    const shown = git(root, ['show', `${revision}:${entry.from ?? entry.file}`]);
    return shown.error ? input : { ...input, before: shown.out };
  });
}

/** Git quotes paths with unusual characters; the graph uses them raw. */
function unquote(path: string): string {
  if (!path.startsWith('"') || !path.endsWith('"')) return path;
  return path.slice(1, -1).replace(/\\(.)/g, '$1');
}

function git(cwd: string, args: string[]): { out: string; error?: string } {
  const result = spawnSync('git', args, {
    cwd,
    encoding: 'utf8',
    windowsHide: true,
    // `git show` of a large source file outgrows the 1 MB default.
    maxBuffer: 32 * 1024 * 1024,
  });
  if (result.error) return { out: '', error: `git could not be run: ${result.error.message}` };
  if (result.status !== 0) {
    return {
      out: '',
      // Git's own message is more useful than anything invented here.
      error: (result.stderr || 'git exited with an error').trim().split('\n')[0] ?? 'git failed',
    };
  }
  return { out: result.stdout };
}
