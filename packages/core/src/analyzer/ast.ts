import {
  Node,
  SyntaxKind,
  type ArrowFunction,
  type CallExpression,
  type ClassDeclaration,
  type Decorator,
  type Expression,
  type FunctionDeclaration,
  type FunctionExpression,
  type MethodDeclaration,
  type ObjectLiteralExpression,
  type SourceFile,
} from 'ts-morph';

export type Functionish =
  FunctionDeclaration | FunctionExpression | ArrowFunction | MethodDeclaration;

/**
 * Read an expression as a URL/route string.
 *
 * Template literals keep their shape but lose their interpolations:
 * `` `/customers/${id}/notes` `` becomes `/customers/<param>/notes`, which
 * `normalizePath` then turns into `/customers/:param/notes`. Anything genuinely
 * dynamic (a variable, a function call) returns undefined rather than a guess —
 * a wrong edge is worse than a missing one.
 */
export function readPathLike(
  expression: Node | undefined,
  /**
   * Optional lookup for identifiers, so a URL held in a constant resolves to
   * its literal instead of degrading to a placeholder. See `constants.ts`.
   */
  resolve?: (name: string) => string | undefined,
): string | undefined {
  if (!expression) return undefined;
  if (Node.isStringLiteral(expression) || Node.isNoSubstitutionTemplateLiteral(expression)) {
    return expression.getLiteralValue();
  }
  if (Node.isTemplateExpression(expression)) {
    let out = expression.getHead().getLiteralText();
    for (const span of expression.getTemplateSpans()) {
      out += readInterpolation(span.getExpression(), resolve);
      out += span.getLiteral().getLiteralText();
    }
    return out;
  }
  if (
    Node.isBinaryExpression(expression) &&
    expression.getOperatorToken().getKind() === SyntaxKind.PlusToken
  ) {
    const left = readPathLike(expression.getLeft(), resolve);
    const right = readPathLike(expression.getRight(), resolve);
    if (left === undefined && right === undefined) return undefined;
    return `${left ?? '<param>'}${right ?? '<param>'}`;
  }
  if (Node.isAsExpression(expression) || Node.isParenthesizedExpression(expression)) {
    return readPathLike(expression.getExpression(), resolve);
  }
  if (Node.isIdentifier(expression) && resolve) {
    return resolve(expression.getText());
  }
  return undefined;
}

/**
 * What a `${...}` contributes to the path.
 *
 * A known constant contributes its value; anything else — an id, an env var, a
 * function call — contributes a placeholder, because guessing here would invent
 * routes that do not exist.
 */
function readInterpolation(
  expression: Node,
  resolve?: (name: string) => string | undefined,
): string {
  if (resolve && Node.isIdentifier(expression)) {
    const value = resolve(expression.getText());
    if (value !== undefined) return value;
  }
  // Nested templates and concatenations can still be partially readable.
  if (Node.isTemplateExpression(expression) || Node.isBinaryExpression(expression)) {
    const nested = readPathLike(expression, resolve);
    if (nested !== undefined) return nested;
  }
  return '<param>';
}

/** Read a plain string literal, ignoring anything dynamic. */
export function readString(expression: Node | undefined): string | undefined {
  if (!expression) return undefined;
  if (Node.isStringLiteral(expression) || Node.isNoSubstitutionTemplateLiteral(expression)) {
    return expression.getLiteralValue();
  }
  return undefined;
}

/** The dotted callee of a call expression: `axios.post`, `this.customers.create`. */
export function calleeName(call: CallExpression): string {
  const expression = call.getExpression();
  return expression.getText().replace(/\s+/g, '');
}

/** The last identifier of the callee: `post` for `api.client.post(...)`. */
export function calleeMember(call: CallExpression): string {
  const parts = calleeName(call).split('.');
  return parts[parts.length - 1] ?? '';
}

/** The receiver of a member call: `this.customersService` for `this.customersService.create()`. */
export function calleeReceiver(call: CallExpression): string | undefined {
  const parts = calleeName(call).split('.');
  if (parts.length < 2) return undefined;
  return parts.slice(0, -1).join('.');
}

export function getDecorator(
  node: ClassDeclaration | MethodDeclaration,
  name: string,
): Decorator | undefined {
  return node.getDecorators().find((d) => d.getName() === name);
}

export function decoratorNames(node: ClassDeclaration | MethodDeclaration): string[] {
  return node.getDecorators().map((d) => d.getName());
}

/** First argument of a decorator, as a string when it is one. */
export function decoratorStringArg(
  decorator: Decorator | undefined,
  resolve?: (name: string) => string | undefined,
): string | undefined {
  if (!decorator) return undefined;
  const [first] = decorator.getArguments();
  return readPathLike(first, resolve);
}

/** Keys of an object literal, in source order. */
export function objectKeys(object: ObjectLiteralExpression): string[] {
  const keys: string[] = [];
  for (const property of object.getProperties()) {
    if (Node.isPropertyAssignment(property) || Node.isMethodDeclaration(property)) {
      keys.push(stripQuotes(property.getName()));
    } else if (Node.isShorthandPropertyAssignment(property)) {
      keys.push(property.getName());
    } else if (Node.isSpreadAssignment(property)) {
      keys.push(`...${property.getExpression().getText()}`);
    }
  }
  return keys;
}

export function asObjectLiteral(expression: Node | undefined): ObjectLiteralExpression | undefined {
  if (!expression) return undefined;
  if (Node.isObjectLiteralExpression(expression)) return expression;
  if (Node.isAsExpression(expression) || Node.isParenthesizedExpression(expression)) {
    return asObjectLiteral(expression.getExpression());
  }
  return undefined;
}

export function propertyValue(
  object: ObjectLiteralExpression,
  key: string,
): Expression | undefined {
  const property = object.getProperty(key);
  if (property && Node.isPropertyAssignment(property)) return property.getInitializer();
  return undefined;
}

export function stripQuotes(value: string): string {
  return value.replace(/^['"`]|['"`]$/g, '');
}

/** The nearest enclosing function-like node, if any. */
export function enclosingFunction(node: Node): Functionish | undefined {
  return node.getFirstAncestor(
    (ancestor): ancestor is Functionish =>
      Node.isFunctionDeclaration(ancestor) ||
      Node.isFunctionExpression(ancestor) ||
      Node.isArrowFunction(ancestor) ||
      Node.isMethodDeclaration(ancestor),
  );
}

/**
 * A readable name for a function-like node.
 *
 * Arrow functions assigned to a variable (`const handleSubmit = () => {}`) are
 * the common case in React code, so fall back to the variable name.
 */
export function functionName(fn: Functionish): string | undefined {
  if (Node.isFunctionDeclaration(fn) || Node.isMethodDeclaration(fn)) {
    return fn.getName();
  }
  const variable = fn.getFirstAncestorByKind(SyntaxKind.VariableDeclaration);
  if (variable) return variable.getName();
  const property = fn.getFirstAncestorByKind(SyntaxKind.PropertyAssignment);
  if (property) return stripQuotes(property.getName());
  return undefined;
}

export function lineOf(node: Node): number {
  return node.getStartLineNumber();
}

export function columnOf(node: Node): number {
  return node.getSourceFile().getLineAndColumnAtPos(node.getStart()).column;
}

/** Every call expression inside a node, including nested ones. */
export function callsIn(node: Node): CallExpression[] {
  return node.getDescendantsOfKind(SyntaxKind.CallExpression);
}

export function classesIn(file: SourceFile): ClassDeclaration[] {
  return file.getClasses();
}
