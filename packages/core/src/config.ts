import { existsSync, readFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import type { FlowLensConfig } from './scan.js';

/**
 * Optional per-project configuration.
 *
 * A project with unusual conventions should be describable once, in the repo,
 * rather than re-typed as flags on every command — and committing the file
 * means the whole team gets the same graph.
 */
export const CONFIG_FILENAMES = [
  'flowlens.config.json',
  '.flowlensrc',
  '.flowlensrc.json',
] as const;

export interface FileConfig extends FlowLensConfig {
  /** Extra roots, resolved relative to the config file. */
  roots?: string[];
  /**
   * Keep FlowLens's own artifacts in `.gitignore`.
   *
   * Only relevant to a project that moved the graph or the trace into the
   * repository with `-g`, `--trace` or `$FLOWLENS_TRACE`; by default they live
   * in the OS cache and git never sees them. Committing `true` here is how a
   * team opts in once instead of every developer being told by the CLI.
   */
  gitignore?: boolean;
}

export interface LoadedConfig {
  config: FileConfig;
  /** Absolute path of the file the config came from, if any. */
  path?: string;
  /** Things worth saying out loud about the file that was found. */
  warnings?: string[];
}

/**
 * Find and read a config file.
 *
 * Searches the given directory, then its ancestors, so running the CLI from a
 * subdirectory of a monorepo still picks up the project's settings.
 */
export function loadConfig(fromDir: string, explicitPath?: string): LoadedConfig {
  if (explicitPath) {
    const path = isAbsolute(explicitPath) ? explicitPath : resolve(fromDir, explicitPath);
    if (!existsSync(path)) {
      throw new Error(`FlowLens: config file not found: ${path}`);
    }
    return loaded(parse(path), path);
  }

  let current = resolve(fromDir);
  for (;;) {
    for (const name of CONFIG_FILENAMES) {
      const candidate = join(current, name);
      if (existsSync(candidate)) {
        return loaded(parse(candidate), candidate);
      }
    }
    const parent = dirname(current);
    if (parent === current) return { config: {} };
    current = parent;
  }
}

function loaded(config: FileConfig, path: string): LoadedConfig {
  const warnings = farRoots(config, path);
  return { config, path, ...(warnings.length > 0 ? { warnings } : {}) };
}

/**
 * Roots that reach outside the neighbourhood of the config file.
 *
 * A config is *discovered*, by walking up from whatever path you pointed the
 * CLI at — so on a repository you have only just cloned, the repository decides
 * what gets read. `"roots": ["/"]` would walk your whole disk into a graph you
 * then serve over HTTP. This is a warning rather than a refusal: sibling
 * repositories (`../shop-api`) are the documented layout and must keep working,
 * and a developer who is told which directories are about to be read can judge
 * the rest. The neighbourhood is the config file's directory and its parent.
 */
function farRoots(config: FileConfig, path: string): string[] {
  if (!config.roots) return [];
  const configDir = dirname(path);
  const neighbourhood = dirname(configDir);
  const warnings: string[] = [];
  for (const root of config.roots) {
    const target = resolve(root);
    if (target === neighbourhood || contains(neighbourhood, target)) continue;
    warnings.push(
      `${path} points a scan root outside its own project: ${target}\n` +
        `  Check the file if you did not write it — a scanned directory ends up in the graph.`,
    );
  }
  return warnings;
}

/** Is `target` inside `parent`? Path-segment aware, so /a/bc is not inside /a/b. */
function contains(parent: string, target: string): boolean {
  const rel = relative(parent, target);
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel);
}

function parse(path: string): FileConfig {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (error) {
    throw new Error(`FlowLens: cannot read ${path}: ${message(error)}`);
  }

  let parsed: unknown;
  try {
    // Tolerate comments and trailing commas — these files get hand-edited.
    parsed = JSON.parse(stripJsonComments(raw));
  } catch (error) {
    throw new Error(`FlowLens: ${path} is not valid JSON: ${message(error)}`);
  }

  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`FlowLens: ${path} must contain a JSON object`);
  }

  const config = parsed as FileConfig;
  // Roots in a config file are relative to the file, not to the shell's cwd.
  if (config.roots) {
    const base = dirname(path);
    config.roots = config.roots.map((entry) => (isAbsolute(entry) ? entry : resolve(base, entry)));
  }
  return config;
}

/** CLI flags win over the config file; the config file wins over defaults. */
export function mergeConfig<T extends object>(fileConfig: T, flags: Partial<T>): T {
  const merged = { ...fileConfig };
  for (const [key, value] of Object.entries(flags)) {
    if (value !== undefined) {
      (merged as Record<string, unknown>)[key] = value;
    }
  }
  return merged;
}

function stripJsonComments(input: string): string {
  let out = '';
  let inString = false;
  let inLine = false;
  let inBlock = false;

  for (let i = 0; i < input.length; i += 1) {
    const char = input[i]!;
    const next = input[i + 1];

    if (inLine) {
      if (char === '\n') {
        inLine = false;
        out += char;
      }
      continue;
    }
    if (inBlock) {
      if (char === '*' && next === '/') {
        inBlock = false;
        i += 1;
      }
      continue;
    }
    if (inString) {
      out += char;
      if (char === '\\') {
        out += next ?? '';
        i += 1;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }
    if (char === '"') {
      inString = true;
      out += char;
      continue;
    }
    if (char === '/' && next === '/') {
      inLine = true;
      i += 1;
      continue;
    }
    if (char === '/' && next === '*') {
      inBlock = true;
      i += 1;
      continue;
    }
    out += char;
  }

  // Trailing commas before } or ]
  return out.replace(/,(\s*[}\]])/g, '$1');
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
