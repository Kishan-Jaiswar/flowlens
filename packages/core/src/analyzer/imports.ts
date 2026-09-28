/**
 * Which file imports which, and what it takes from each.
 *
 * The graph records where each step is declared, and that is the only thing
 * the Changed view used to match on. A file that declares no step of its own —
 * the database connection, a shared client, a helper every query goes through
 * — then looked like it reached nothing, when a change to it reaches every
 * feature built on top. Following imports backwards from the changed file is
 * what closes that gap.
 *
 * The names are what the unused-code report needs: a file can be imported and
 * still export things nobody uses.
 *
 * Only files the scan loaded are resolved, and every path is the relative one
 * node ids use, so the map lines up with `node.source.file`.
 */

import { dirname, join, resolve } from 'node:path';
import { Node, SyntaxKind, type SourceFile } from 'ts-morph';
import { readAliases } from '../flow/actionsource.js';
import type { LoadedProject } from './project.js';

const EXTENSIONS = ['.ts', '.tsx', '.js', '.jsx', '.mts', '.cts', '.mjs', '.cjs'];

/** One `import`, `export … from`, `import()` or `require()` in a file. */
export interface ImportUse {
  /** As written: `@/lib/db/store`, `./x`, `mongodb`. */
  specifier: string;
  /** The scanned file it resolves to, when it is one. */
  target?: string;
  /** Names taken from the target; `'*'` for a namespace, dynamic or re-export-all. */
  names: string[] | '*';
  /** Erased at compile time: `import type`, or only `type` specifiers. */
  typeOnly: boolean;
}

/** Resolves specifiers the way the project's tsconfig paths would. */
export interface ModuleResolver {
  /** A specifier written in `fromAbsolute`, to a scanned file's relative path. */
  resolve(specifier: string, fromAbsolute: string): string | undefined;
}

export function moduleResolver(loaded: LoadedProject): ModuleResolver {
  const loadedPaths = new Map<string, string>();
  for (const file of loaded.sourceFiles) {
    loadedPaths.set(slashed(file.getFilePath()), loaded.rel(file));
  }
  const aliasesByRoot = loaded.roots.map((root) => ({
    root: slashed(resolve(root)),
    aliases: readAliases(root),
  }));
  return {
    resolve(specifier, fromAbsolute) {
      const from = slashed(fromAbsolute);
      const aliases =
        aliasesByRoot.find((entry) => from.startsWith(`${entry.root}/`))?.aliases ?? [];
      return resolveSpecifier(specifier, from, aliases, loadedPaths);
    },
  };
}

/** file -> every import it makes, resolved where it points into the project. */
export function collectImportUses(loaded: LoadedProject): Map<string, ImportUse[]> {
  const resolver = moduleResolver(loaded);
  const result = new Map<string, ImportUse[]>();
  for (const file of loaded.sourceFiles) {
    const self = loaded.rel(file);
    const uses = usesOf(file).map((use) => {
      const target = resolver.resolve(use.specifier, file.getFilePath());
      return target && target !== self ? { ...use, target } : use;
    });
    if (uses.length > 0) result.set(self, uses);
  }
  return result;
}

/**
 * file -> the files it imports at runtime, both relative to the scan root.
 *
 * Type-only imports are left out: `import type { MovementQuery } from
 * '@/lib/db/store'` is erased at compile time, so a page that has it does not
 * run the database module — and counting it put every screen downstream of
 * the Mongo connection.
 */
export function collectImports(
  loaded: LoadedProject,
  uses: Map<string, ImportUse[]> = collectImportUses(loaded),
): Record<string, string[]> {
  const imports: Record<string, string[]> = {};
  for (const [file, list] of uses) {
    const targets = new Set(
      list.filter((use) => use.target && !use.typeOnly).map((use) => use.target!),
    );
    if (targets.size > 0) imports[file] = [...targets].sort();
  }
  return imports;
}

function usesOf(file: SourceFile): Omit<ImportUse, 'target'>[] {
  const found: Omit<ImportUse, 'target'>[] = [];

  for (const declaration of file.getImportDeclarations()) {
    const named = declaration.getNamedImports();
    const names: string[] = named.map((entry) => entry.getName());
    if (declaration.getDefaultImport()) names.push('default');
    const namespace = declaration.getNamespaceImport() !== undefined;
    const typeOnly =
      declaration.isTypeOnly() ||
      (!declaration.getDefaultImport() &&
        !namespace &&
        named.length > 0 &&
        named.every((entry) => entry.isTypeOnly()));
    found.push({
      specifier: declaration.getModuleSpecifierValue(),
      names: namespace ? '*' : names,
      typeOnly,
    });
  }

  for (const declaration of file.getExportDeclarations()) {
    const specifier = declaration.getModuleSpecifierValue();
    if (!specifier) continue;
    const named = declaration.getNamedExports();
    found.push({
      specifier,
      // `export * from` and `export * as ns from` hand on everything.
      names: named.length === 0 ? '*' : named.map((entry) => entry.getName()),
      typeOnly:
        declaration.isTypeOnly() ||
        (named.length > 0 && named.every((entry) => entry.isTypeOnly())),
    });
  }

  for (const call of file.getDescendantsOfKind(SyntaxKind.CallExpression)) {
    const callee = call.getExpression();
    const dynamic = callee.getKind() === SyntaxKind.ImportKeyword;
    const required = Node.isIdentifier(callee) && callee.getText() === 'require';
    if (!dynamic && !required) continue;
    const [argument] = call.getArguments();
    if (
      argument &&
      (Node.isStringLiteral(argument) || Node.isNoSubstitutionTemplateLiteral(argument))
    ) {
      found.push({ specifier: argument.getLiteralValue(), names: '*', typeOnly: false });
    }
  }
  return found;
}

function resolveSpecifier(
  specifier: string,
  from: string,
  aliases: ReadonlyArray<{ prefix: string; targets: string[] }>,
  loadedPaths: ReadonlyMap<string, string>,
): string | undefined {
  const bases: string[] = [];
  if (specifier.startsWith('.')) {
    bases.push(resolve(dirname(from), specifier));
  } else {
    for (const alias of aliases) {
      if (!specifier.startsWith(alias.prefix)) continue;
      const rest = specifier.slice(alias.prefix.length);
      for (const target of alias.targets) bases.push(join(target, rest));
    }
  }
  for (const base of bases) {
    for (const candidate of [
      base,
      ...EXTENSIONS.map((ext) => `${base}${ext}`),
      ...EXTENSIONS.map((ext) => join(base, `index${ext}`)),
      // `./x.js` written for NodeNext, pointing at `./x.ts`.
      ...EXTENSIONS.map((ext) => base.replace(/\.[cm]?js$/, ext)),
    ]) {
      const rel = loadedPaths.get(slashed(candidate));
      if (rel) return rel;
    }
  }
  return undefined;
}

/** ts-morph reports forward slashes on every platform; `path.resolve` does not. */
function slashed(path: string): string {
  return path.replace(/\\/g, '/');
}
