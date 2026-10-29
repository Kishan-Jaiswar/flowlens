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
  resolve?: (name: string, at?: Node) => string | undefined,
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
    return resolve(expression.getText(), expression)?.trim();
  }
  if (resolve && isEnvRead(expression)) return resolve(expression.getText().replace(/\s+/g, ''));
  // `archivePatientEndpoint(id)`: a URL-building function from the constants table.
  if (
    Node.isCallExpression(expression) &&
    Node.isIdentifier(expression.getExpression()) &&
    resolve
  ) {
    return resolve(`${expression.getExpression().getText()}()`);
  }
  // `a ? urlA : urlB`: the first readable side; the request reader adds the other as its own call.
  if (Node.isConditionalExpression(expression)) {
    return (
      readPathLike(expression.getWhenTrue(), resolve) ??
      readPathLike(expression.getWhenFalse(), resolve)
    );
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
  resolve?: (name: string, at?: Node) => string | undefined,
): string {
  if (resolve && (Node.isIdentifier(expression) || isEnvRead(expression))) {
    const value = resolve(expression.getText().replace(/\s+/g, ''), expression);
    if (value !== undefined) return value;
  }
  // Nested templates and concatenations can still be partially readable.
  if (Node.isTemplateExpression(expression) || Node.isBinaryExpression(expression)) {
    const nested = readPathLike(expression, resolve);
    if (nested !== undefined) return nested;
  }
  return '<param>';
}

/** `process.env.API_HOST`: a URL base the constants table reads from the env files. */
function isEnvRead(expression: Node): boolean {
  return (
    (Node.isPropertyAccessExpression(expression) || Node.isElementAccessExpression(expression)) &&
    expression.getExpression().getText() === 'process.env'
  );
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

/**
 * The variable or parameter an identifier names, found by name in the scopes
 * around it — innermost first. Not `getSymbol()`: that builds the type checker
 * for the whole project, seconds and gigabytes on a large one, to answer what
 * the enclosing scopes already say.
 */
export function declarationOf(identifier: Node): Node | undefined {
  const name = identifier.getText();
  for (let scope = enclosingFunction(identifier); ; scope = scope && enclosingFunction(scope)) {
    const within: Node = scope ?? identifier.getSourceFile();
    if (scope) {
      const parameter = scope.getParameters().find((p) => p.getName() === name);
      if (parameter) return parameter;
    }
    const variable = within
      .getDescendantsOfKind(SyntaxKind.VariableDeclaration)
      .find((candidate) => candidate.getName() === name && enclosingFunction(candidate) === scope);
    if (variable) return variable;
    if (!scope) return undefined;
  }
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
 * the common case in React code, so fall back to the variable name — also
 * through a wrapper call (`const save = useCallback(() => {}, [])`). Only the
 * variable the function is *assigned* to names it: an inline callback inside
 * `const searchBar = (<Button onClick={() => refetch()} />)` is anonymous.
 */
export function functionName(fn: Functionish): string | undefined {
  if (Node.isFunctionDeclaration(fn) || Node.isMethodDeclaration(fn)) {
    return fn.getName();
  }
  let node: Node = fn;
  let parent = node.getParent();
  while (
    parent &&
    (Node.isParenthesizedExpression(parent) ||
      Node.isAsExpression(parent) ||
      Node.isSatisfiesExpression(parent) ||
      Node.isNonNullExpression(parent) ||
      (Node.isCallExpression(parent) && parent.getArguments().includes(node as never)))
  ) {
    node = parent;
    parent = node.getParent();
  }
  if (parent && Node.isVariableDeclaration(parent)) return parent.getName();
  if (parent && Node.isPropertyAssignment(parent)) return stripQuotes(parent.getName());
  return undefined;
}

export function lineOf(node: Node): number {
  return node.getStartLineNumber();
}

/** Every call expression inside a node, including nested ones. */
export function callsIn(node: Node): CallExpression[] {
  return node.getDescendantsOfKind(SyntaxKind.CallExpression);
}

/**
 * The call a variable was last loaded from before `at`: `await this.patientModel.create(dto)`
 * for `patient` in `patient.uuid = uuid; await patient.save()`. Undefined when it was
 * built with `new` (that write is recorded where it is built) or is not a call.
 */
export function loadedFrom(name: string, at: Node): CallExpression | undefined {
  const fn = at.getFirstAncestor(
    (node) =>
      Node.isFunctionDeclaration(node) ||
      Node.isMethodDeclaration(node) ||
      Node.isArrowFunction(node) ||
      Node.isFunctionExpression(node),
  );
  if (!fn) return undefined;
  const values: Array<{ end: number; value: Node | undefined }> = [];
  for (const declaration of fn.getDescendantsOfKind(SyntaxKind.VariableDeclaration))
    if (declaration.getName() === name)
      values.push({ end: declaration.getEnd(), value: declaration.getInitializer() });
  for (const assignment of fn.getDescendantsOfKind(SyntaxKind.BinaryExpression))
    if (
      assignment.getOperatorToken().getKind() === SyntaxKind.EqualsToken &&
      assignment.getLeft().getText() === name
    )
      values.push({ end: assignment.getEnd(), value: assignment.getRight() });
  const last = values
    .filter((entry) => entry.end <= at.getStart())
    .sort((a, b) => a.end - b.end)
    .at(-1);
  let value = last?.value;
  while (value && (Node.isAwaitExpression(value) || Node.isParenthesizedExpression(value)))
    value = value.getExpression();
  // `this.model.findById(id).exec()` / `.populate(…)`: the model call is at the start of the chain.
  while (value && Node.isCallExpression(value)) {
    const callee = value.getExpression();
    if (!Node.isPropertyAccessExpression(callee)) break;
    const inner = callee.getExpression();
    if (!Node.isCallExpression(inner)) break;
    value = inner;
  }
  return value && Node.isCallExpression(value) ? value : undefined;
}
