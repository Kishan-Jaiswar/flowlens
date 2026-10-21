/**
 * Conditions in plain words, for the Database page's cases — read from the
 * syntax tree, so a variable can be named for what it was made from.
 *
 * The code says `addQty > 0 && idx < 0`; a reader wants "the quantity is more
 * than 0 and no matching batch is found". Each part is phrased from what the
 * code itself shows — what a variable was made from (`input.quantity`, a
 * `findIndex`, a finder), the comparison, a list's length — and anything it
 * cannot phrase keeps its code in backticks, so nothing is invented.
 *
 * Several conditions on one value are simplified before they are phrased:
 * `!A && B || A` is `A || B`, and `A || !A` is always.
 */

import { Node, SyntaxKind } from 'ts-morph';
import { condense, localVariable, nearestFunction } from './actionsource.js';
import { words } from './plainwords.js';

/** One condition, holding or not, with its words. */
export interface Literal {
  code: string;
  holds: boolean;
  words: string;
}

/** Ways a value is written: any one of the terms, each needing all its literals. */
export type Terms = Literal[][];

const OPPOSITE: Record<string, string> = {
  '>': '<=',
  '>=': '<',
  '<': '>=',
  '<=': '>',
  '===': '!==',
  '!==': '===',
  '==': '!=',
  '!=': '==',
};

const TIME_WORDS: Record<string, string> = {
  '<': 'is before',
  '<=': 'is not after',
  '>': 'is after',
  '>=': 'is not before',
};

const OPERATOR_WORDS: Record<string, string> = {
  '>': 'is more than',
  '>=': 'is at least',
  '<': 'is less than',
  '<=': 'is at most',
  '===': 'is',
  '==': 'is',
  '!==': 'is not',
  '!=': 'is not',
};

/** `batches` → "batch", `entries` → "entry". */
function singular(word: string): string {
  if (/ies$/.test(word)) return word.replace(/ies$/, 'y');
  if (/(ches|shes|sses|xes)$/.test(word)) return word.replace(/es$/, '');
  return word.replace(/s$/, '');
}

/** What a variable holds where it is declared, `await` taken off. */
function initOf(identifier: Node): Node | undefined {
  const fn = nearestFunction(identifier);
  const declaration = fn ? localVariable(fn, identifier.getText()) : undefined;
  let init = Node.isVariableDeclaration(declaration) ? declaration.getInitializer() : undefined;
  if (init && Node.isAwaitExpression(init)) init = init.getExpression();
  return init;
}

const FINDER = /^(find|get|load|fetch|lookup|read)|duplicate|exist/i;

/** The name of what a call looks up: `getMedicine` → "medicine", `findDuplicate` → "record". */
function lookedUp(callee: string): string {
  const rest = callee.replace(/^(find|get|load|fetch|lookup|read)(One|By\w+)?/, '');
  if (!rest || /duplicate|exist/i.test(rest)) return 'record';
  return words(rest);
}

/**
 * A value in words: `input.quantity` (or a variable made from it) → "the quantity",
 * `current.currentStock` → "the current stock", `MAX_X` → "max x".
 */
function valueWords(written: Node, depth = 0): string {
  const node = bare(written);
  if (node !== written) return valueWords(node, depth);
  if (Node.isParenthesizedExpression(node)) return valueWords(node.getExpression(), depth);
  if (/^(Date\.now\(\)|new Date\(\))$/.test(node.getText())) return 'now';
  // `now - lastSentAt`: the time since.
  if (
    Node.isBinaryExpression(node) &&
    node.getOperatorToken().getText() === '-' &&
    valueWords(node.getLeft(), depth + 1) === 'now'
  )
    return `the time since ${valueWords(node.getRight(), depth + 1).replace(/^the /, 'the ')}`;
  if (Node.isNumericLiteral(node)) return node.getText();
  if (Node.isStringLiteral(node) || Node.isNoSubstitutionTemplateLiteral(node))
    return `"${node.getLiteralValue()}"`;
  if (Node.isPropertyAccessExpression(node)) {
    if (node.getName() === 'length')
      return `the number of ${words(node.getExpression().getText().split('.').pop()!)}`;
    const owner = ownerWords(node.getExpression());
    return `the ${owner === ' stored' ? 'stored ' : ''}${words(node.getName())}${owner === ' sent' ? ' sent' : ''}`;
  }
  if (Node.isIdentifier(node)) {
    const name = node.getText();
    if (/^[A-Z0-9_]+$/.test(name)) return words(name);
    if (name === 'now') return 'now';
    // `const addQty = Math.max(0, input.quantity)`: named for the one value it is made from.
    const init = depth < 2 ? initOf(node) : undefined;
    if (init && /^(Date\.now\(\)|new Date\(\))$/.test(init.getText())) return 'now';
    if (init && Node.isBinaryExpression(init) && init.getOperatorToken().getText() === '-') {
      const said = valueWords(init, depth + 1);
      if (said.startsWith('the time since')) return said;
    }
    const reads = init
      ? [init, ...init.getDescendants()].filter((n) => Node.isPropertyAccessExpression(n))
      : [];
    const outer = reads.filter((n) => {
      const parent = n.getParent();
      if (Node.isPropertyAccessExpression(parent)) return false;
      return !(Node.isCallExpression(parent) && parent.getExpression() === n);
    });
    if (outer.length === 1 && Node.isPropertyAccessExpression(outer[0]))
      return `the ${words(outer[0].getName())}`;
    return name.length === 1 ? 'the item' : `the ${words(name)}`;
  }
  return `\`${condense(node.getText(), 50)}\``;
}

/**
 * Whose value a property is, when it matters: `existing.x` is "the stored x",
 * `input.x` "the x sent"; anything else says nothing more.
 */
function ownerWords(owner: Node): string {
  let root: Node = owner;
  while (Node.isPropertyAccessExpression(root)) root = root.getExpression();
  if (!Node.isIdentifier(root)) return '';
  const fn = nearestFunction(root);
  const parameter = (fn as unknown as { getParameters?: () => Node[] } | undefined)
    ?.getParameters?.()
    .some((p) => Node.isParameterDeclaration(p) && p.getName() === root.getText());
  if (
    parameter &&
    /^(input|body|data|params|payload|values|dto|row|req|request)$/i.test(root.getText())
  )
    return ' sent';
  const init = initOf(root);
  if (
    init &&
    Node.isCallExpression(init) &&
    FINDER.test(init.getExpression().getText().split('.').pop()!)
  )
    return ' stored';
  return '';
}

/** `String(x ?? "").trim()` → `x`: wrappers that do not change whether there is a value. */
function bare(node: Node): Node {
  let current = node;
  for (let hops = 0; hops < 6; hops += 1) {
    if (Node.isParenthesizedExpression(current)) current = current.getExpression();
    else if (Node.isCallExpression(current)) {
      const callee = current.getExpression();
      const args = current.getArguments();
      if (
        Node.isPropertyAccessExpression(callee) &&
        /^(trim|toLowerCase|toUpperCase|toString|getTime|valueOf)$/.test(callee.getName()) &&
        args.length === 0
      )
        current = callee.getExpression();
      else if (
        Node.isIdentifier(callee) &&
        /^(String|Boolean|Number)$/.test(callee.getText()) &&
        args[0]
      )
        current = args[0];
      else break;
    } else if (
      Node.isBinaryExpression(current) &&
      /^(\?\?|\|\|)$/.test(current.getOperatorToken().getText()) &&
      Node.isLiteralExpression(current.getRight())
    )
      current = current.getLeft();
    else break;
  }
  return current;
}

/** One condition in words; `holds` false says its opposite. */
export function phrase(expression: Node, holds: boolean, depth = 0): string {
  const node = bare(expression);
  if (Node.isPrefixUnaryExpression(node) && node.getOperatorToken() === SyntaxKind.ExclamationToken)
    return phrase(node.getOperand(), !holds, depth);
  // `parsed.success` where `const parsed = schema.safeParse(row)`.
  if (Node.isPropertyAccessExpression(node) && node.getName() === 'success') {
    const target = node.getExpression();
    const init = Node.isIdentifier(target) ? initOf(target) : undefined;
    if (init && Node.isCallExpression(init) && /safeParse/.test(init.getExpression().getText())) {
      const schema = condense(init.getExpression().getText(), 50);
      return holds ? `it passes \`${schema}\`` : `it fails \`${schema}\``;
    }
  }
  if (depth > 4)
    return holds
      ? `\`${condense(node.getText(), 60)}\``
      : `not \`${condense(node.getText(), 60)}\``;

  if (Node.isBinaryExpression(node)) {
    const operator = node.getOperatorToken().getText();
    // `A && B` / `A || B`, with negation pushed in: not (A and B) is not A or not B.
    if (operator === '&&' || operator === '||') {
      const both = holds === (operator === '&&');
      const left = phrase(node.getLeft(), holds, depth + 1);
      const right = phrase(node.getRight(), holds, depth + 1);
      return `${left} ${both ? 'and' : 'or'} ${right}`;
    }
    if (operator in OPPOSITE)
      return comparison(node.getLeft(), holds ? operator : OPPOSITE[operator]!, node.getRight());
  }

  if (Node.isIdentifier(node)) {
    let init = initOf(node);
    // `const name = displayName?.trim()`: the condition is on what it wraps.
    if (init && bare(init) !== init && !Node.isCallExpression(bare(init)))
      return phrase(bare(init), holds, depth + 1);
    if (init && Node.isAwaitExpression(init)) init = init.getExpression();
    const callee =
      init && Node.isCallExpression(init)
        ? init.getExpression().getText().split('.').pop()!
        : undefined;
    if (callee && FINDER.test(callee)) {
      const what = lookedUp(callee);
      return holds ? `a matching ${what} exists` : `no matching ${what} is found`;
    }
    if (callee) return holds ? `\`${callee}\` gives a result` : `\`${callee}\` gives nothing`;
    const thing = valueWords(node).replace(/^the /, '');
    return holds
      ? `there is ${/^[aeiou]/.test(thing) ? 'an' : 'a'} ${thing}`
      : `there is no ${thing}`;
  }
  if (Node.isPropertyAccessExpression(node))
    return holds ? `${valueWords(node)} is set` : `${valueWords(node)} is empty`;

  return holds ? `\`${condense(node.getText(), 60)}\`` : `not \`${condense(node.getText(), 60)}\``;
}

/** `a OP b` in words, with what each side was made from. */
function comparison(left: Node, operator: string, right: Node): string {
  // `idx >= 0` with `const idx = batches.findIndex(…)`: whether a matching item is found.
  const index = indexOf(left);
  const number = Node.isNumericLiteral(right)
    ? Number(right.getText())
    : Node.isPrefixUnaryExpression(right)
      ? -Number(right.getOperand().getText())
      : undefined;
  // `primaryIdx < 0`: a variable named as an index, kept by a loop.
  const named =
    !index && Node.isIdentifier(left) && /(Idx|Index)$/.test(left.getText())
      ? `${words(left.getText().replace(/(Idx|Index)$/, '')) || 'matching'} item`
      : undefined;
  if ((index || named) && number !== undefined) {
    const found =
      (operator === '>=' && number === 0) ||
      (operator === '>' && number === -1) ||
      (operator === '!==' && number === -1) ||
      (operator === '!=' && number === -1);
    const missing =
      (operator === '<' && number === 0) ||
      (operator === '<=' && number === -1) ||
      (operator === '===' && number === -1) ||
      (operator === '==' && number === -1);
    if (found) return index ? `a matching ${index} is found` : `a ${named} is found`;
    if (missing) return index ? `no matching ${index} is found` : `no ${named} is found`;
  }
  // `list.length === 0` → empty.
  if (Node.isPropertyAccessExpression(left) && left.getName() === 'length' && number === 0) {
    const list = words(left.getExpression().getText().split('.').pop()!);
    if (operator === '===' || operator === '==' || operator === '<=') return `there are no ${list}`;
    if (operator === '>' || operator === '!==' || operator === '!=') return `there are ${list}`;
  }
  // `delta > 0` with `const delta = target - previousStock`: compare the two.
  const difference = Node.isIdentifier(left) ? initOf(left) : undefined;
  if (
    number === 0 &&
    difference &&
    Node.isBinaryExpression(difference) &&
    difference.getOperatorToken().getText() === '-'
  )
    return `${valueWords(difference.getLeft())} ${OPERATOR_WORDS[operator]} ${valueWords(difference.getRight())}`;
  const a = valueWords(left);
  const b = valueWords(right);
  const TIME = /^now$|( at| ends?| expiry| expires| date| time)$/;
  if ((TIME.test(a) || TIME.test(b)) && !a.startsWith('the time since') && operator in TIME_WORDS)
    return `${a} ${TIME_WORDS[operator]} ${b}`;
  return `${a} ${OPERATOR_WORDS[operator] ?? operator} ${b}`;
}

/** The item a `findIndex`/`indexOf` searches for: "batch" for `batches.findIndex(…)`. */
function indexOf(node: Node): string | undefined {
  if (!Node.isIdentifier(node)) return undefined;
  const init = initOf(node);
  if (!init || !Node.isCallExpression(init)) return undefined;
  const callee = init.getExpression();
  if (
    !Node.isPropertyAccessExpression(callee) ||
    !/^(findIndex|indexOf|findLastIndex)$/.test(callee.getName())
  )
    return undefined;
  return singular(words(callee.getExpression().getText().split('.').pop()!));
}

const keyOf = (literal: Literal) => literal.code;

/**
 * Simplify ways to one or more terms: drop repeats and impossible terms, absorb
 * a term another one already covers, take `¬A` out of a term when `A` alone (with
 * the rest) is another term, and merge two terms that differ only in `A` / `¬A`.
 * An empty term means always.
 */
export function simplify(terms: Terms): Terms {
  let current = terms
    .map((term) => withoutImplied(dedupe(term)))
    .filter((term) => !impossible(term));
  for (let round = 0; round < 8; round += 1) {
    const before = JSON.stringify(current);
    // (S ∧ A) ∨ (S ∧ ¬A ∧ T) → (S ∧ A) ∨ (S ∧ T)
    current = current.map((term) => {
      let next = term;
      for (const other of current) {
        if (other === term) continue;
        for (const literal of other) {
          const rest = other.filter((l) => l !== literal);
          const flipped = next.find(
            (l) => keyOf(l) === keyOf(literal) && l.holds !== literal.holds,
          );
          if (flipped && rest.every((r) => next.some((l) => same(l, r))))
            next = next.filter((l) => l !== flipped);
        }
      }
      return next;
    });
    // Absorption: a term that contains another adds nothing.
    current = current.filter(
      (term, i) =>
        !current.some(
          (other, j) =>
            j !== i &&
            other.length < term.length &&
            other.every((l) => term.some((m) => same(l, m))),
        ),
    );
    current = [...new Map(current.map((term) => [termKey(term), term])).values()];
    if (JSON.stringify(current) === before) break;
  }
  return current;
}

const same = (a: Literal, b: Literal) => keyOf(a) === keyOf(b) && a.holds === b.holds;
const dedupe = (term: Literal[]) => [
  ...new Map(term.map((l) => [`${l.holds}|${keyOf(l)}`, l])).values(),
];
const impossible = (term: Literal[]) =>
  term.some((l) => term.some((m) => keyOf(l) === keyOf(m) && l.holds !== m.holds));
const termKey = (term: Literal[]) =>
  term
    .map((l) => `${l.holds}|${keyOf(l)}`)
    .sort()
    .join('&');

/** Terms in words and in code: `undefined` when the terms mean always. */
export function render(terms: Terms): { words?: string; code?: string } {
  if (!terms.length || terms.some((term) => term.length === 0)) return {};
  return {
    words: terms.map((term) => term.map((l) => l.words).join(' and ')).join(', or '),
    code: terms
      .map((term) =>
        term.map((l) => (l.holds ? `\`${l.code}\`` : `not \`${l.code}\``)).join(' and '),
      )
      .join(' or '),
  };
}

/** `a < b` already says `a <= b` and `a !== b`: the weaker comparison on the same values goes. */
function withoutImplied(term: Literal[]): Literal[] {
  const parts = term.map((literal) => ({ literal, cmp: comparisonOf(literal) }));
  const IMPLIES: Record<string, string[]> = {
    '<': ['<=', '!=='],
    '>': ['>=', '!=='],
    '===': ['<=', '>='],
  };
  return parts
    .filter(
      ({ cmp }) =>
        !cmp ||
        !parts.some(
          (other) =>
            other.cmp &&
            other.cmp !== cmp &&
            other.cmp.left === cmp.left &&
            other.cmp.right === cmp.right &&
            (IMPLIES[other.cmp.op] ?? []).includes(cmp.op),
        ),
    )
    .map(({ literal }) => literal);
}

/** A literal that is a comparison, with the operator it says once its holding is applied. */
function comparisonOf(literal: Literal): { left: string; op: string; right: string } | undefined {
  const match = /^(.+?)\s*(===|!==|>=|<=|>|<)\s*(.+)$/.exec(literal.code);
  if (!match) return undefined;
  const op = literal.holds ? match[2]! : OPPOSITE[match[2]!]!;
  return { left: match[1]!.trim(), op, right: match[3]!.trim() };
}
