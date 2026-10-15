import { Node, SyntaxKind } from 'ts-morph';

/**
 * The literal start of a React Query key, which is what invalidation matches.
 *
 * `["import-status", jobId]` -> `["import-status"]`;
 * `queryKeys.medicines.list(query)` -> `["medicines", "list"]`, read from the
 * `queryKeys` object wherever the project declares it. Matching invalidations
 * to endpoints by URL instead said invalidating `["medicines"]` refetched
 * `/medicines/import/status`, whose key starts `"import-status"`.
 */
export function keyPrefixOf(node: Node | undefined, depth = 0): string[] | undefined {
  if (!node || depth > 6) return undefined;
  const value = unwrap(node);
  if (Node.isArrayLiteralExpression(value)) {
    const prefix: string[] = [];
    for (const element of value.getElements()) {
      const inner = unwrap(element);
      if (Node.isStringLiteral(inner) || Node.isNoSubstitutionTemplateLiteral(inner))
        prefix.push(inner.getLiteralValue());
      else if (Node.isSpreadElement(inner)) {
        const spread = keyPrefixOf(inner.getExpression(), depth + 1);
        if (!spread) break;
        prefix.push(...spread);
      } else break;
    }
    return prefix.length > 0 ? prefix : undefined;
  }
  // `queryKeys.medicines.list(query)`: the factory's body.
  if (Node.isCallExpression(value)) return keyPrefixOf(value.getExpression(), depth + 1);
  if (Node.isArrowFunction(value)) return keyPrefixOf(value.getBody(), depth + 1);
  if (Node.isPropertyAccessExpression(value) || Node.isIdentifier(value)) {
    const target = definitionOf(value);
    return target ? keyPrefixOf(target, depth + 1) : undefined;
  }
  return undefined;
}

function unwrap(node: Node): Node {
  let current = node;
  while (
    Node.isAsExpression(current) ||
    Node.isParenthesizedExpression(current) ||
    Node.isSatisfiesExpression(current) ||
    Node.isTypeAssertion(current)
  )
    current = current.getExpression();
  return current;
}

/** What `queryKeys.medicines.all` points at: a property of an object literal declared somewhere. */
function definitionOf(node: Node): Node | undefined {
  const path = node.getText().replace(/\s+/g, '').replace(/\?\./g, '.').split('.');
  const root = path.shift();
  if (!root || !/^[A-Za-z_$][\w$]*$/.test(root)) return undefined;
  // In this file, else the one variable of that name the project exports.
  const local = node.getSourceFile().getVariableDeclaration(root)?.getInitializer();
  const declared =
    local ??
    node
      .getProject()
      .getSourceFiles()
      .map((file) => file.getVariableDeclaration(root))
      .find((declaration) => declaration?.getVariableStatement()?.isExported())
      ?.getInitializer();
  let current: Node | undefined = declared ? unwrap(declared) : undefined;
  for (const segment of path) {
    if (!current || !Node.isObjectLiteralExpression(current)) return undefined;
    const property = current.getProperty(segment);
    if (property && Node.isPropertyAssignment(property)) {
      const init = property.getInitializer();
      current = init ? unwrap(init) : undefined;
    } else if (property && Node.isMethodDeclaration(property)) {
      current = property.getDescendantsOfKind(SyntaxKind.ReturnStatement)[0]?.getExpression();
    } else return undefined;
  }
  return current;
}
