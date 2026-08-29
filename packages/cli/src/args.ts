import { existsSync, statSync } from 'node:fs';

/**
 * Which positional arguments are project paths, and which are not.
 *
 * `flowlens flow create-customer ./my-app` and
 * `flowlens flow create-customer -p ./my-app` must behave the same, so the
 * positionals have to be sorted out. Two things make that harder than it looks:
 *
 *   - On Windows a path is `.\my-app`, `..\api` or `C:\code\app`. An earlier
 *     version only looked for `/`, so every Windows path was mistaken for a
 *     flow id and the scan silently ran against the current directory instead.
 *   - `flowlens scan my-app` has no separator at all, on any platform.
 *
 * So: for commands that take no argument of their own, *every* positional is a
 * path — which also means a typo'd directory produces "path does not exist"
 * instead of quietly scanning the wrong tree. For the two commands that do take
 * an argument, a positional is treated as a path if it looks like one or if it
 * exists on disk.
 *
 * `where` needs a third rule, because its argument *is* a path
 * (`src/App.tsx:42`) and every heuristic above would claim it as a project
 * root. Position decides instead: the first positional is the location, and
 * anything after it is a root.
 */

/** Commands whose first non-path positional is their own argument. */
const COMMANDS_WITH_ARGUMENT = new Set(['flow', 'impact']);

/** Commands whose first positional is their own argument even though it is a path. */
const COMMANDS_WITH_LOCATION = new Set(['where']);

/** Extensions FlowLens will accept as a single-file root. */
const SOURCE_EXTENSIONS = ['.ts', '.tsx', '.js', '.jsx', '.mts', '.cts', '.mjs', '.cjs'];

export interface SplitPositionals {
  /** Project roots, in the order given. */
  roots: string[];
  /** Everything else — a flow id, a symbol name. */
  args: string[];
}

export interface SplitOptions {
  /** Overridable for tests, so path detection can be checked without a disk. */
  exists?: (value: string) => boolean;
}

export function splitPositionals(
  command: string,
  rest: string[],
  options: SplitOptions = {},
): SplitPositionals {
  if (COMMANDS_WITH_LOCATION.has(command)) {
    const [location, ...tail] = rest;
    return {
      roots: [...tail],
      args: location === undefined ? [] : [location],
    };
  }

  if (!COMMANDS_WITH_ARGUMENT.has(command)) {
    return { roots: [...rest], args: [] };
  }

  const exists = options.exists ?? existsOnDisk;
  const roots: string[] = [];
  const args: string[] = [];

  for (const value of rest) {
    // The command's own argument comes first; anything after it that is not a
    // path is extra and stays in args for the command to reject.
    if (args.length === 0 && !looksLikePath(value) && !exists(value)) {
      args.push(value);
      continue;
    }
    if (looksLikePath(value) || exists(value)) {
      roots.push(value);
    } else {
      args.push(value);
    }
  }

  return { roots, args };
}

/**
 * Does this argument have the shape of a path, without touching the disk?
 *
 * Covers POSIX and Windows spellings, plus `~` which a shell may pass through
 * unexpanded (PowerShell does not expand it for arguments).
 */
export function looksLikePath(value: string): boolean {
  if (value === '' || value.startsWith('-')) return false;
  if (value === '.' || value === '..') return true;
  if (value.includes('/') || value.includes('\\')) return true;
  if (value.startsWith('~')) return true;
  // A Windows absolute or drive-relative path: C:\code\app, D:app
  if (/^[A-Za-z]:/.test(value)) return true;
  return false;
}

function existsOnDisk(value: string): boolean {
  try {
    if (!existsSync(value)) return false;
    const stats = statSync(value);
    if (stats.isDirectory()) return true;
    // A single file is a valid root, but only a source file — otherwise
    // `flowlens impact Service.create` would be mistaken for a path on the
    // day someone has a file of that name in the working directory.
    return stats.isFile() && SOURCE_EXTENSIONS.some((ext) => value.endsWith(ext));
  } catch {
    return false;
  }
}
