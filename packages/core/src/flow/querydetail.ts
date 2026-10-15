import { Node, type CallExpression } from 'ts-morph';
import { condense, unwrap } from './actionsource.js';

/**
 * What one query does, in a line, read off the call that makes it.
 *
 * A handler that loads a dashboard runs `medicines.find` twice and
 * `movements.*` three times at once; listed by collection alone they read as
 * the same step six times. What tells them apart is in the call: where the
 * result goes (`recentlyAdded`), what it filters on, how it sorts and how many
 * it keeps, which pipeline stages it runs.
 *
 *   recentlyAdded · where ownerId · newest createdAt first · up to 5
 *   todaysUpdates · counts where ownerId, createdAt (range)
 *   rollup · pipeline $match → $project → $facet (totals, categories)
 */
export function queryDetail(call: CallExpression): string | undefined {
  const base = baseQueryCall(call);
  if (!base) return undefined;
  const callee = base.getExpression();
  if (!Node.isPropertyAccessExpression(callee)) return undefined;
  const operation = callee.getName();
  const [first, second] = base.getArguments();
  const parts: string[] = [];

  const target = resultName(base);
  if (target) parts.push(`→ ${target}`);

  if (/^aggregate$/i.test(operation)) {
    const stages = pipelineStages(first);
    if (stages) parts.push(`pipeline ${stages}`);
  } else if (/^(?:countDocuments|count|estimatedDocumentCount)$/i.test(operation)) {
    const where = filterWords(first);
    parts.push(where ? `counts ${where}` : 'counts all');
  } else if (/^distinct$/i.test(operation)) {
    const field = first && Node.isStringLiteral(unwrap(first)) ? unwrap(first).getText() : '';
    const where = filterWords(second);
    parts.push(`distinct ${field.replace(/['"]/g, '') || 'values'}${where ? ` ${where}` : ''}`);
  } else if (/^(?:insert|create|save)/i.test(operation)) {
    parts.push(/many/i.test(operation) ? 'adds several' : 'adds one');
  } else {
    const where = filterWords(first);
    if (where) parts.push(where);
    if (/^(?:update|findOneAndUpdate|replace|upsert)/i.test(operation)) {
      const changes = updateWords(second);
      if (changes) parts.push(changes);
    }
  }

  // `.sort({ createdAt: -1 }).limit(5)` written after the call.
  for (const link of chainAfter(base)) {
    const name = link.getExpression();
    if (!Node.isPropertyAccessExpression(name)) continue;
    const [argument] = link.getArguments();
    switch (name.getName()) {
      case 'sort': {
        const order = sortWords(argument);
        if (order) parts.push(order);
        break;
      }
      case 'limit':
        if (argument) parts.push(`up to ${condense(argument.getText(), 20)}`);
        break;
      case 'skip':
        if (argument) parts.push(`skips ${condense(argument.getText(), 30)}`);
        break;
      case 'project':
      case 'select': {
        const keys = argument ? keysOf(argument) : [];
        if (keys.length) parts.push(`only ${keys.slice(0, 4).join(', ')}`);
        break;
      }
    }
  }
  // `find(filter, { projection: { name: 1 } })`.
  if (/^find/i.test(operation) && second) {
    const object = unwrap(second);
    if (Node.isObjectLiteralExpression(object)) {
      const projection = object.getProperty('projection');
      if (projection && Node.isPropertyAssignment(projection)) {
        const keys = keysOf(projection.getInitializer()!);
        if (keys.length) parts.push(`only ${keys.slice(0, 4).join(', ')}`);
      }
    }
  }
  return parts.length > 0 ? parts.join(' · ') : undefined;
}

/** The `x.find(…)` call in `x.find(…).sort(…).toArray()`, from any call of the chain. */
export function baseQueryCall(call: CallExpression): CallExpression | undefined {
  let current: Node = call;
  // Down the chain to its first call on a collection.
  for (let hops = 0; hops < 8; hops++) {
    if (!Node.isCallExpression(current)) break;
    const callee = current.getExpression();
    if (!Node.isPropertyAccessExpression(callee)) break;
    const inner = unwrap(callee.getExpression());
    if (
      Node.isCallExpression(inner) &&
      Node.isPropertyAccessExpression(inner.getExpression()) &&
      !/^(?:collection|model|db|getCollection)$/.test(
        (inner.getExpression() as unknown as { getName(): string }).getName(),
      )
    ) {
      current = inner;
      continue;
    }
    break;
  }
  return Node.isCallExpression(current) ? current : undefined;
}

/** The calls written after the query: `.sort(…)`, `.limit(…)`, `.toArray()`. */
function chainAfter(base: CallExpression): CallExpression[] {
  const links: CallExpression[] = [];
  let current: Node = base;
  for (let hops = 0; hops < 8; hops++) {
    const access = current.getParent();
    if (!access || !Node.isPropertyAccessExpression(access) || access.getExpression() !== current)
      break;
    const call = access.getParent();
    if (!call || !Node.isCallExpression(call) || call.getExpression() !== access) break;
    links.push(call);
    current = call;
  }
  return links;
}

/**
 * Where the result is kept: `const recent = await …`, `{ total: await … }`,
 * or its place in `const [a, b] = await Promise.all([…])`.
 */
export function resultName(base: CallExpression): string | undefined {
  let node: Node = base;
  // Up through the rest of the chain, `await`, `.next()`, parentheses.
  for (let hops = 0; hops < 12; hops++) {
    const parent = node.getParent();
    if (!parent) return undefined;
    if (
      Node.isPropertyAccessExpression(parent) ||
      Node.isCallExpression(parent) ||
      Node.isAwaitExpression(parent) ||
      Node.isParenthesizedExpression(parent) ||
      Node.isAsExpression(parent) ||
      Node.isNonNullExpression(parent)
    ) {
      node = parent;
      continue;
    }
    if (Node.isVariableDeclaration(parent)) {
      const name = parent.getNameNode();
      return Node.isIdentifier(name) ? name.getText() : undefined;
    }
    if (Node.isPropertyAssignment(parent)) return parent.getName();
    if (Node.isReturnStatement(parent)) return 'returned';
    if (Node.isArrayLiteralExpression(parent)) return parallelName(parent, node);
    return undefined;
  }
  return undefined;
}

/** `const [rollup, recent] = await Promise.all([q1, q2])`: q2 is `recent`. */
function parallelName(list: Node, element: Node): string | undefined {
  if (!Node.isArrayLiteralExpression(list)) return undefined;
  const index = list.getElements().indexOf(element as never);
  const call = list.getParent();
  if (index < 0 || !call || !Node.isCallExpression(call)) return undefined;
  let up: Node | undefined = call.getParent();
  while (up && (Node.isAwaitExpression(up) || Node.isParenthesizedExpression(up))) {
    up = up.getParent();
  }
  if (!up || !Node.isVariableDeclaration(up)) return undefined;
  const pattern = up.getNameNode();
  if (!Node.isArrayBindingPattern(pattern)) return undefined;
  const binding = pattern.getElements()[index];
  return binding && Node.isBindingElement(binding) ? binding.getNameNode().getText() : undefined;
}

/** `{ ownerId, createdAt: { $gte: … } }` -> `where ownerId, createdAt (range)`. */
function filterWords(filter: Node | undefined): string | undefined {
  if (!filter) return undefined;
  const value = unwrap(filter);
  if (Node.isObjectLiteralExpression(value)) {
    const keys = value.getProperties().flatMap((property) => {
      if (Node.isShorthandPropertyAssignment(property)) return [property.getName()];
      if (Node.isSpreadAssignment(property))
        return [`…${condense(property.getExpression().getText(), 20)}`];
      if (!Node.isPropertyAssignment(property)) return [];
      const name = property.getName().replace(/^['"]|['"]$/g, '');
      const initializer = property.getInitializer();
      const inner = initializer ? unwrap(initializer) : undefined;
      if (inner && Node.isObjectLiteralExpression(inner)) {
        const ops = keysOf(inner);
        if (ops.some((op) => /^\$(?:gte?|lte?)$/.test(op))) return [`${name} (range)`];
        if (ops.includes('$in')) return [`${name} (one of a list)`];
        if (ops.includes('$regex')) return [`${name} (matches text)`];
        if (ops.includes('$exists')) return [`${name} (present)`];
      }
      return [name];
    });
    return keys.length
      ? `where ${keys.slice(0, 5).join(', ')}${keys.length > 5 ? ', …' : ''}`
      : 'all';
  }
  if (Node.isIdentifier(value)) return `where \`${value.getText()}\``;
  return undefined;
}

/** `{ $set: { name }, $inc: { stock: 1 } }` -> `sets name · adds to stock`. */
function updateWords(update: Node | undefined): string | undefined {
  if (!update) return undefined;
  const value = unwrap(update);
  if (!Node.isObjectLiteralExpression(value)) return undefined;
  const words: string[] = [];
  for (const property of value.getProperties()) {
    if (!Node.isPropertyAssignment(property)) continue;
    const keys = keysOf(property.getInitializer()!);
    const verb = {
      $set: 'sets',
      $inc: 'adds to',
      $push: 'appends to',
      $pull: 'removes from',
      $unset: 'clears',
    }[property.getName().replace(/^['"]|['"]$/g, '')];
    if (verb && keys.length) words.push(`${verb} ${keys.slice(0, 4).join(', ')}`);
  }
  return words.join(' · ') || undefined;
}

/** `{ createdAt: -1 }` -> `newest createdAt first`; `{ name: 1 }` -> `by name`. */
function sortWords(sort: Node | undefined): string | undefined {
  if (!sort) return undefined;
  const value = unwrap(sort);
  if (!Node.isObjectLiteralExpression(value)) return `sorted by ${condense(value.getText(), 30)}`;
  const parts = value.getProperties().flatMap((property) => {
    if (!Node.isPropertyAssignment(property)) return [];
    const name = property.getName().replace(/^['"]|['"]$/g, '');
    const direction = property.getInitializer()?.getText().replace(/\s/g, '');
    if (direction === '-1' || direction === '"desc"' || direction === "'desc'") {
      return [
        /(?:At|Date|date|time|Time)$/.test(name) ? `newest ${name} first` : `${name} high to low`,
      ];
    }
    return [`by ${name}`];
  });
  return parts.length ? parts.join(', ') : undefined;
}

/** `[{ $match }, { $group }, { $facet: { totals, categories } }]` -> its stages. */
function pipelineStages(pipeline: Node | undefined): string | undefined {
  if (!pipeline) return undefined;
  const value = unwrap(pipeline);
  if (!Node.isArrayLiteralExpression(value)) return undefined;
  const stages = value.getElements().flatMap((element) => {
    const stage = unwrap(element);
    if (!Node.isObjectLiteralExpression(stage)) return [];
    const property = stage.getProperties()[0];
    if (!property || !Node.isPropertyAssignment(property)) return [];
    const name = property.getName().replace(/^['"]|['"]$/g, '');
    if (name === '$facet') {
      const facets = keysOf(property.getInitializer()!);
      return [`$facet (${facets.join(', ')})`];
    }
    return [name];
  });
  return stages.length ? stages.join(' → ') : undefined;
}

function keysOf(node: Node): string[] {
  const value = unwrap(node);
  if (!Node.isObjectLiteralExpression(value)) return [];
  return value.getProperties().flatMap((property) => {
    if (Node.isPropertyAssignment(property) || Node.isShorthandPropertyAssignment(property)) {
      return [property.getName().replace(/^['"]|['"]$/g, '')];
    }
    return [];
  });
}
