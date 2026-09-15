/**
 * What "changed" means, asked of git.
 *
 * Kept out of core on purpose: core takes a list of paths and stays testable
 * without a repository, and the decision about *which* paths — working tree,
 * staged only, or everything since a base branch — is a user-facing choice that
 * belongs with the command line.
 */

import { spawnSync } from 'node:child_process';
import type { ChangeStatus, ChangedInput } from '@flowslens/core';

/** Git's two-letter porcelain code, mapped to something a person reads. */
function statusOf(code: string): ChangeStatus {
  if (code.includes('?')) return 'untracked';
  if (code.includes('A')) return 'added';
  if (code.includes('D')) return 'deleted';
  if (code.includes('R')) return 'renamed';
  return 'modified';
}

export interface ChangedFilesResult {
  files: ChangedInput[];
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
          return { file, status: statusOf(code) };
        })
        .filter((entry) => entry.file !== ''),
    };
  }

  const status = git(root, ['status', '--porcelain=v1', '--untracked-files=all']);
  if (status.error) return { files: [], against: 'the last commit', error: status.error };

  const files: ChangedInput[] = [];
  for (const line of status.out.split('\n')) {
    if (line.trim() === '') continue;
    const code = line.slice(0, 2);
    const path = line.slice(3).trim();
    // `old -> new` for a rename; the new path is the one on disk.
    const file = path.includes(' -> ') ? (path.split(' -> ')[1] ?? path) : path;
    if (file === '') continue;
    files.push({ file: unquote(file), status: statusOf(code) });
  }
  return { files, against: 'the last commit' };
}

/** Git quotes paths with unusual characters; the graph uses them raw. */
function unquote(path: string): string {
  if (!path.startsWith('"') || !path.endsWith('"')) return path;
  return path.slice(1, -1).replace(/\\(.)/g, '$1');
}

function git(cwd: string, args: string[]): { out: string; error?: string } {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8', windowsHide: true });
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
