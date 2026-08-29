import { Node, type SourceFile } from 'ts-morph';
import { readString } from './ast.js';
import type { LoadedProject } from './project.js';

/**
 * A project-wide table of string constants.
 *
 * Real frontends do not write URLs at the call site. They keep a module of
 * endpoint constants —
 *
 *   // misc/apiEndPointes.js
 *   export const getCustomersList = "/admin/customers";
 *
 * — and call `getRequest({ url: getCustomersList })`. Without resolving that
 * identifier back to its literal, the analyzer sees a variable, gives up, and
 * every single API call in the codebase is lost.
 */
export interface ConstantTable {
  /** Unambiguous name -> literal value. */
  values: Map<string, string>;
  /** Names declared more than once with different values. */
  ambiguous: Set<string>;
  /** Resolve a name, or undefined if unknown or ambiguous. */
  resolve(name: string): string | undefined;
}

/** Only strings that could plausibly be a URL path are worth keeping. */
const PATH_LIKE = /^[/a-zA-Z0-9_\-.:{}$<>?=&%]*$/;
const MAX_LENGTH = 300;

/**
 * Collect exported and module-level string constants across the project.
 *
 * Deliberately name-keyed rather than scope-aware: resolving imports properly
 * would mean full module resolution, which `loadProject` skips on purpose. In
 * practice endpoint constants have distinctive names and live in one module, so
 * a name collision is rare — and when it happens the name is marked ambiguous
 * and skipped rather than guessed at.
 */
export function collectConstants(loaded: LoadedProject): ConstantTable {
  const values = new Map<string, string>();
  const ambiguous = new Set<string>();

  for (const file of loaded.sourceFiles) {
    for (const [name, value] of stringConstantsIn(file)) {
      const existing = values.get(name);
      if (existing === undefined) {
        values.set(name, value);
        continue;
      }
      if (existing !== value) {
        ambiguous.add(name);
      }
    }
  }

  for (const name of ambiguous) values.delete(name);

  return {
    values,
    ambiguous,
    resolve(name: string) {
      return values.get(name);
    },
  };
}

/**
 * Module-level `const x = "..."` declarations.
 *
 * Two passes over the same file: plain literals first, then templates, so a
 * template that references an earlier constant in the same module can be
 * resolved (`const REPORTS = `${BASE}/reports``).
 */
function stringConstantsIn(file: SourceFile): Array<[string, string]> {
  const found: Array<[string, string]> = [];
  const local = new Map<string, string>();

  const declarations = file.getVariableDeclarations();

  for (const declaration of declarations) {
    const initializer = declaration.getInitializer();
    const value = readString(initializer);
    if (value === undefined) continue;
    if (value.length > MAX_LENGTH || !PATH_LIKE.test(value)) continue;
    const name = declaration.getName();
    local.set(name, value);
    found.push([name, value]);
  }

  for (const declaration of declarations) {
    const initializer = declaration.getInitializer();
    if (!initializer || !Node.isTemplateExpression(initializer)) continue;
    const name = declaration.getName();
    if (local.has(name)) continue;

    let text = initializer.getHead().getLiteralText();
    let resolvable = true;
    for (const span of initializer.getTemplateSpans()) {
      const expression = span.getExpression();
      const nested = Node.isIdentifier(expression) ? local.get(expression.getText()) : undefined;
      if (nested === undefined) {
        resolvable = false;
        break;
      }
      text += nested + span.getLiteral().getLiteralText();
    }
    if (!resolvable || text.length > MAX_LENGTH || !PATH_LIKE.test(text)) continue;
    local.set(name, text);
    found.push([name, text]);
  }

  return found;
}

/** An empty table, for callers that do not want constant resolution. */
export function emptyConstantTable(): ConstantTable {
  return { values: new Map(), ambiguous: new Set(), resolve: () => undefined };
}
