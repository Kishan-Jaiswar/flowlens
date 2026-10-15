/**
 * Conditions and steps read out in plain words, for someone who does not
 * read code: `isLoading || !data` -> "Is it still loading, or is there no
 * data?".
 *
 * Read from the syntax tree of the condition, never from the project's
 * vocabulary: the same rules apply to any JavaScript or TypeScript code —
 * `&&`, `||`, `!`, comparisons, `.length`, `=== null`, `in`, `instanceof`,
 * the common checks (`.has`, `.includes`, `.startsWith`, `.trim()`), and the
 * naming conventions most code follows (`isOpen`, `hasItems`, `canSave`).
 *
 * A sentence is only produced when every part of the condition has a safe
 * reading. Anything else gives `undefined`, and the caller keeps the code: a
 * wrong sentence is worse than an exact one in code.
 */

import { ts } from 'ts-morph';

/**
 * One fact, in a shape that can be said as a statement or asked as a
 * question, either way round.
 */
type Fact =
  /** `there is a user` / `there are no rows`. */
  | { kind: 'there'; noun: string; plural: boolean; negative: boolean }
  /** `the status is 401` / `it is loading`. */
  | { kind: 'be'; subject: string; complement: string; negative: boolean }
  /** `seen has the id` / `the name includes " "`. */
  | { kind: 'do'; subject: string; verb: string; object: string; negative: boolean }
  /** `the request worked`. */
  | { kind: 'did'; subject: string; verb: string; negative: boolean }
  /** `it can save`. */
  | { kind: 'can'; subject: string; verb: string; negative: boolean };

type Said = { facts: Fact[]; join: 'and' | 'or' } | undefined;

/** Short names spelled out; only abbreviations, never project words. */
const SPELLED: Record<string, string> = {
  idx: 'index',
  qty: 'quantity',
  ctx: 'context',
  req: 'request',
  res: 'response',
  msg: 'message',
  err: 'error',
  btn: 'button',
  num: 'number',
  pct: 'percentage',
  cfg: 'config',
  conf: 'config',
  prev: 'previous',
  curr: 'current',
  str: 'text',
  e: 'event',
  evt: 'event',
  ev: 'event',
  v: 'value',
  val: 'value',
  s: 'text',
  doc: 'record',
  ms: 'milliseconds',
  col: 'column',
  cols: 'columns',
};

/** `batches` -> `batch`, `entries` -> `entry`: one of a list. */
function singular(noun: string): string {
  if (/ies$/.test(noun)) return noun.replace(/ies$/, 'y');
  if (/(ch|sh|x|ss)es$/.test(noun)) return noun.replace(/es$/, '');
  if (/[^s]s$/.test(noun)) return noun.slice(0, -1);
  return noun;
}

/** Owners that add nothing to the name of what they hold: `query.page` is "the page". */
const QUIET_OWNERS =
  /^(query|params|input|body|props|state|options|opts|args|data|values|form|this|ctx|context|req|request|e|event|evt|globalRef|globalThis|global|window|self|config|settings|filters?)$/;

/** Owners whose fields are what the caller passed in: a field there is "given" or not. */
const INPUT_OWNERS = /^(query|params|input|body|props|options|opts|args|values|form|filters?)$/;

/** Words that read as a state something is in: `open` -> "it is open". */
const STATES =
  /^(open|opened|closed|disabled|enabled|loading|loaded|pending|submitting|saving|busy|ready|valid|invalid|visible|hidden|active|selected|checked|expanded|collapsed|dirty|touched|focused|editing|required|empty|done|finished|complete|completed|success|failed|online|offline|searchable|mounted)$/;

/** `isLoadingMore` -> `is loading more`; `qty` -> `quantity`. Shared with the step labels. */
export function words(name: string): string {
  const bare = name.replace(/^_+/, '').replace(/^\$+/, '');
  const parts = bare
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .replace(/[_-]+/g, ' ')
    .toLowerCase()
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  return parts.map((part) => SPELLED[part] ?? part).join(' ');
}

/** `an error`, `a user`, `an update`, `a unique id`. */
const article = (noun: string): string =>
  /^(?:[aeio]|u(?!s|ni|ri|t)|hour|honest)/.test(noun) ? 'an' : 'a';

/** The thing a name refers to: `query.supplier` -> `the supplier`, `doc.clinic_id` -> `the clinic id`. */
function subjectOf(node: ts.Expression): string | undefined {
  const target = strip(node);
  if (ts.isIdentifier(target)) {
    if (target.text === 'undefined') return undefined;
    // A one-letter name says nothing; the code toggle shows which it is.
    if (target.text.length === 1 && !SPELLED[target.text]) return 'it';
    return `the ${words(target.text)}`;
  }
  if (ts.isPropertyAccessExpression(target)) {
    const name = target.name.text;
    if (name === 'length') {
      const owner = subjectOf(target.expression);
      return owner ? `the number of ${owner.replace(/^the /, '')}` : undefined;
    }
    const owner = strip(target.expression);
    if (ts.isIdentifier(owner) && QUIET_OWNERS.test(owner.text)) {
      // `e.key` is the key that was pressed, not "the key".
      if (/^(e|event|evt)$/.test(owner.text) && name === 'key') return 'the key pressed';
      return `the ${words(name)}`;
    }
    const ownerWords = subjectOf(owner);
    if (!ownerWords) return undefined;
    // `m.name` -> `the name`: a one-letter owner names nothing.
    if (ownerWords === 'it') return `the ${words(name)}`;
    // `batches[i].quantity` -> `the quantity of this batch`.
    if (ts.isElementAccessExpression(owner)) return `the ${words(name)} of ${ownerWords}`;
    return `${ownerWords} ${words(name)}`;
  }
  if (ts.isElementAccessExpression(target)) {
    const owner = subjectOf(target.expression);
    if (!owner || owner === 'it') return undefined;
    const list = owner.replace(/^the /, '');
    const one = singular(list) === list ? `${list} item` : singular(list);
    // `batches[i]` is the one the loop is on; `batches[primaryIdx]` is a particular one.
    const index = strip(target.argumentExpression);
    if (ts.isIdentifier(index) && !/^(i|j|k|n|index|idx|i\d)$/.test(index.text))
      return `the ${one} at ${words(index.text)}`;
    return `this ${one}`;
  }
  // `doc.failedAttempts ?? 0` is the failed attempts, or 0 when there are none.
  if (
    ts.isBinaryExpression(target) &&
    target.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken
  )
    return subjectOf(target.left);
  if (ts.isCallExpression(target)) {
    const callee = strip(target.expression);
    if (
      ts.isPropertyAccessExpression(callee) &&
      callee.name.text === 'now' &&
      ts.isIdentifier(callee.expression) &&
      callee.expression.text === 'Date'
    )
      return 'now';
    // `x.trim()`, `date.getTime()`: the same thing, read another way.
    if (
      ts.isPropertyAccessExpression(callee) &&
      /^(trim|getTime|valueOf|toString|toLowerCase|toUpperCase)$/.test(callee.name.text)
    )
      return subjectOf(callee.expression);
  }
  return undefined;
}

/** A value on the right of a comparison: a literal as written, a name in words. */
function valueOf(node: ts.Expression): string | undefined {
  const target = strip(node);
  if (ts.isNumericLiteral(target)) return target.text;
  if (ts.isStringLiteral(target) || ts.isNoSubstitutionTemplateLiteral(target))
    return `"${target.text}"`;
  if (target.kind === ts.SyntaxKind.TrueKeyword) return 'true';
  if (target.kind === ts.SyntaxKind.FalseKeyword) return 'false';
  if (ts.isPrefixUnaryExpression(target) && target.operator === ts.SyntaxKind.MinusToken) {
    const inner = valueOf(target.operand);
    return inner && /^\d/.test(inner) ? `-${inner}` : undefined;
  }
  // `MAX_ATTEMPTS` is a named limit: "the max attempts".
  if (ts.isIdentifier(target) && /^[A-Z][A-Z0-9_]+$/.test(target.text))
    return `the ${words(target.text)}`;
  return subjectOf(target);
}

function strip(node: ts.Expression): ts.Expression {
  let current = node;
  while (
    ts.isParenthesizedExpression(current) ||
    ts.isNonNullExpression(current) ||
    ts.isAsExpression(current) ||
    ts.isTypeAssertionExpression(current) ||
    ts.isAwaitExpression(current)
  )
    current = current.expression;
  return current;
}

const flip = (fact: Fact): Fact => ({ ...fact, negative: !fact.negative });

/** `x` used as a condition: is there one, or is it on. */
function truthy(node: ts.Expression): Fact | undefined {
  const target = strip(node);
  // `x.trim()` -> the x is filled in.
  if (
    ts.isCallExpression(target) &&
    ts.isPropertyAccessExpression(strip(target.expression)) &&
    (strip(target.expression) as ts.PropertyAccessExpression).name.text === 'trim'
  ) {
    const subject = subjectOf((strip(target.expression) as ts.PropertyAccessExpression).expression);
    return subject ? { kind: 'be', subject, complement: 'filled in', negative: false } : undefined;
  }
  const name = ts.isIdentifier(target)
    ? target.text
    : ts.isPropertyAccessExpression(target)
      ? target.name.text
      : undefined;
  if (!name) return undefined;
  const ownerText = ts.isPropertyAccessExpression(target)
    ? strip(target.expression).getText()
    : undefined;
  const ownerSaid =
    ownerText !== undefined && !QUIET_OWNERS.test(ownerText)
      ? subjectOf((target as ts.PropertyAccessExpression).expression)
      : undefined;
  // A one-letter owner names nothing: `c.guess` is "the guess".
  const owner = ownerSaid === 'it' ? undefined : ownerSaid;
  if (name === 'length') {
    const of = ts.isPropertyAccessExpression(target) ? subjectOf(target.expression) : undefined;
    return of
      ? { kind: 'there', noun: of.replace(/^the /, ''), plural: true, negative: false }
      : undefined;
  }
  if (name === 'success' || name === 'ok') {
    return { kind: 'did', subject: owner ?? 'it', verb: 'work', negative: false };
  }
  const prefixed = /^(is|has|can|should|was|did|will|does)([A-Z_].*)$/.exec(name);
  if (prefixed) {
    const rest = words(prefixed[2]!);
    const who = owner ?? 'it';
    switch (prefixed[1]) {
      case 'is':
      case 'was':
        return { kind: 'be', subject: who, complement: rest, negative: false };
      case 'has':
        // `hasSaved` -> it has saved; `hasItems` -> there are items.
        return /ed$/.test(rest)
          ? { kind: 'be', subject: who, complement: `already ${rest}`, negative: false }
          : { kind: 'there', noun: rest, plural: /s$/.test(rest), negative: false };
      case 'can':
        return { kind: 'can', subject: who, verb: rest, negative: false };
      case 'should':
      case 'will':
      case 'does':
      case 'did':
        return {
          kind: 'do',
          subject: who,
          verb: rest.split(' ')[0]!,
          object: rest.split(' ').slice(1).join(' '),
          negative: false,
        };
    }
  }
  const spoken = words(name);
  // `noRefresh`: a switch that turns something off.
  const off = /^no([A-Z].*)$/.exec(name);
  if (off)
    return {
      kind: 'be',
      subject: `the "no ${words(off[1]!)}" setting`,
      complement: 'on',
      negative: false,
    };
  if (STATES.test(spoken) || (/^[a-z]+ed$/.test(spoken) && !owner))
    return { kind: 'be', subject: owner ?? 'it', complement: spoken, negative: false };
  // A field of what was passed in: `query.supplier` -> is the supplier given.
  if (ownerText !== undefined && INPUT_OWNERS.test(ownerText))
    return { kind: 'be', subject: `the ${spoken}`, complement: 'given', negative: false };
  if (spoken.length <= 1 || spoken === 'it') return undefined;
  // `existing` names a thing by what it is: "an existing one".
  const noun =
    /^(existing|matching|remaining|missing|incoming|outgoing|following|upcoming|leading|trailing)$/.test(
      spoken,
    )
      ? `${spoken} one`
      : spoken;
  return {
    kind: 'there',
    noun: owner ? `${owner.replace(/^the /, '')} ${noun}` : noun,
    plural: false,
    negative: false,
  };
}

function compare(node: ts.BinaryExpression): Fact | undefined {
  const op = node.operatorToken.kind;
  const left = strip(node.left);
  const right = strip(node.right);
  const K = ts.SyntaxKind;
  const equal = op === K.EqualsEqualsEqualsToken || op === K.EqualsEqualsToken;
  const notEqual = op === K.ExclamationEqualsEqualsToken || op === K.ExclamationEqualsToken;
  if (equal || notEqual) {
    // `typeof window === "undefined"`: the code runs where there is no browser.
    if (
      ts.isTypeOfExpression(left) &&
      (ts.isStringLiteral(right) || ts.isNoSubstitutionTemplateLiteral(right))
    ) {
      const operand = strip(left.expression);
      if (ts.isIdentifier(operand) && operand.text === 'window' && right.text === 'undefined')
        return {
          kind: 'be',
          subject: 'it',
          complement: 'running outside the browser',
          negative: notEqual,
        };
      const subject = subjectOf(operand);
      const types: Record<string, string> = {
        string: 'text',
        number: 'a number',
        boolean: 'yes or no',
        object: 'an object',
        function: 'a function',
        undefined: 'missing',
      };
      const type = Object.hasOwn(types, right.text) ? types[right.text] : undefined;
      return subject && type
        ? { kind: 'be', subject, complement: type, negative: notEqual }
        : undefined;
    }
    // `rows.length === 0` -> there are no rows.
    if (
      ts.isPropertyAccessExpression(left) &&
      left.name.text === 'length' &&
      ts.isNumericLiteral(right) &&
      right.text === '0'
    ) {
      const of = subjectOf(left.expression);
      return of
        ? { kind: 'there', noun: of.replace(/^the /, ''), plural: true, negative: equal }
        : undefined;
    }
    const subject = subjectOf(left);
    if (!subject) return undefined;
    if (right.kind === K.NullKeyword || (ts.isIdentifier(right) && right.text === 'undefined'))
      return { kind: 'be', subject, complement: 'missing', negative: notEqual };
    if (
      (ts.isStringLiteral(right) || ts.isNoSubstitutionTemplateLiteral(right)) &&
      right.text === ''
    )
      return { kind: 'be', subject, complement: 'empty', negative: notEqual };
    const value = valueOf(right);
    return value ? { kind: 'be', subject, complement: value, negative: notEqual } : undefined;
  }
  const words = {
    [K.GreaterThanToken]: 'more than',
    [K.LessThanToken]: 'less than',
    [K.GreaterThanEqualsToken]: 'at least',
    [K.LessThanEqualsToken]: 'at most',
  } as Partial<Record<ts.SyntaxKind, string>>;
  const relation = words[op];
  if (!relation) return undefined;
  const subject = subjectOf(left);
  const value = valueOf(right);
  // Arithmetic on either side has no plain reading worth trusting.
  return subject && value
    ? { kind: 'be', subject, complement: `${relation} ${value}`, negative: false }
    : undefined;
}

function call(node: ts.CallExpression): Fact | undefined {
  const callee = strip(node.expression);
  const [first] = node.arguments;
  if (ts.isPropertyAccessExpression(callee)) {
    const method = callee.name.text;
    const owner = strip(callee.expression);
    // `Number.isNaN(x)`, `Array.isArray(x)`.
    if (ts.isIdentifier(owner) && owner.text === 'Number' && method === 'isNaN' && first) {
      const subject = subjectOf(first);
      return subject
        ? { kind: 'be', subject, complement: 'not a valid number', negative: false }
        : undefined;
    }
    if (ts.isIdentifier(owner) && owner.text === 'Array' && method === 'isArray' && first) {
      const subject = subjectOf(first);
      return subject ? { kind: 'be', subject, complement: 'a list', negative: false } : undefined;
    }
    const subject = subjectOf(owner);
    const object = first ? valueOf(first) : undefined;
    const verbs: Record<string, string> = {
      has: 'have',
      includes: 'include',
      startsWith: 'start with',
      endsWith: 'end with',
      test: 'match',
    };
    if (method === 'test' && first) {
      // `PATTERN.test(s)` -> the text matches the pattern.
      const text = subjectOf(first);
      return text
        ? {
            kind: 'do',
            subject: text,
            verb: 'match',
            object: `the ${words(owner.getText())} pattern`,
            negative: false,
          }
        : undefined;
    }
    // Own keys only: `obj.hasOwnProperty(k)` must not find `Object.prototype`'s.
    if (Object.hasOwn(verbs, method) && subject && object)
      return { kind: 'do', subject, verb: verbs[method]!, object, negative: false };
    // `axios.isAxiosError(error)` -> the error is an axios error.
    const is = /^is([A-Z].*)$/.exec(method);
    if (is && first) {
      const what = subjectOf(first);
      const kind = words(is[1]!);
      return what
        ? { kind: 'be', subject: what, complement: `${article(kind)} ${kind}`, negative: false }
        : undefined;
    }
    return undefined;
  }
  if (ts.isIdentifier(callee)) {
    // `isValidEmail(x)` -> the x is a valid email; `tracingEnabled()` -> tracing is enabled.
    const is = /^is([A-Z].*)$/.exec(callee.text);
    if (is && first) {
      const what = subjectOf(first);
      return what
        ? { kind: 'be', subject: what, complement: words(is[1]!), negative: false }
        : undefined;
    }
    const spoken = words(callee.text).split(' ');
    const last = spoken.at(-1)!;
    if (node.arguments.length === 0 && spoken.length > 1 && STATES.test(last))
      return {
        kind: 'be',
        subject: spoken.slice(0, -1).join(' '),
        complement: last,
        negative: false,
      };
  }
  return undefined;
}

function say(node: ts.Expression): Said {
  const target = strip(node);
  if (ts.isPrefixUnaryExpression(target) && target.operator === ts.SyntaxKind.ExclamationToken) {
    const inner = say(target.operand);
    if (!inner) return undefined;
    // Not (a and b) is (not a) or (not b), and the other way round.
    return { facts: inner.facts.map(flip), join: inner.join === 'and' ? 'or' : 'and' };
  }
  if (ts.isBinaryExpression(target)) {
    const op = target.operatorToken.kind;
    if (op === ts.SyntaxKind.AmpersandAmpersandToken || op === ts.SyntaxKind.BarBarToken) {
      const join = op === ts.SyntaxKind.AmpersandAmpersandToken ? 'and' : 'or';
      const left = say(target.left);
      const right = say(target.right);
      if (!left || !right) return undefined;
      // Mixed `a && (b || c)` reads ambiguously in words: keep the code.
      if (
        (left.facts.length > 1 && left.join !== join) ||
        (right.facts.length > 1 && right.join !== join)
      )
        return undefined;
      return { facts: [...left.facts, ...right.facts], join };
    }
    if (op === ts.SyntaxKind.InKeyword) {
      // `"error" in result` -> it came back with an error.
      const key = strip(target.left);
      if (ts.isStringLiteral(key)) {
        const what = words(key.text);
        return {
          facts: [{ kind: 'there', noun: what, plural: false, negative: false }],
          join: 'and',
        };
      }
      return undefined;
    }
    if (op === ts.SyntaxKind.InstanceOfKeyword) {
      const subject = subjectOf(target.left);
      const kind = words(strip(target.right).getText());
      return subject
        ? {
            facts: [
              { kind: 'be', subject, complement: `${article(kind)} ${kind}`, negative: false },
            ],
            join: 'and',
          }
        : undefined;
    }
    const fact = compare(target);
    return fact ? { facts: [fact], join: 'and' } : undefined;
  }
  if (ts.isCallExpression(target)) {
    const fact = call(target) ?? truthy(target);
    return fact ? { facts: [fact], join: 'and' } : undefined;
  }
  const fact = truthy(target);
  return fact ? { facts: [fact], join: 'and' } : undefined;
}

/**
 * `v === undefined || v === null || v === ""` is one thing said three ways:
 * "the value is missing or empty". Facts about the same subject, the same way
 * round, are said together; the same fact twice is said once.
 */
function merged(said: NonNullable<Said>): NonNullable<Said> {
  const out: Fact[] = [];
  for (const fact of said.facts) {
    const twin = out.find(
      (other) =>
        other.kind === 'be' &&
        fact.kind === 'be' &&
        other.subject === fact.subject &&
        other.negative === fact.negative,
    ) as Extract<Fact, { kind: 'be' }> | undefined;
    if (twin && fact.kind === 'be') {
      const parts = twin.complement.split(/,? or | and /);
      if (!parts.includes(fact.complement))
        twin.complement = `${twin.complement} ${said.join} ${fact.complement}`;
      continue;
    }
    if (out.some((other) => JSON.stringify(other) === JSON.stringify(fact))) continue;
    out.push({ ...fact });
  }
  return { facts: out, join: said.join };
}

function statement(fact: Fact): string {
  const no = fact.negative;
  switch (fact.kind) {
    case 'there':
      return fact.plural
        ? `there are ${no ? 'no' : 'some'} ${fact.noun}`
        : `there is ${no ? 'no' : article(fact.noun)} ${fact.noun}`;
    case 'be':
      return `${fact.subject} is ${no ? 'not ' : ''}${fact.complement}`;
    case 'do':
      return `${fact.subject} ${no ? `does not ${fact.verb}` : thirdPerson(fact.verb)}${fact.object ? ` ${fact.object}` : ''}`;
    case 'did':
      return `${fact.subject} ${no ? `did not ${fact.verb}` : past(fact.verb)}`;
    case 'can':
      return `${fact.subject} can${no ? 'not' : ''} ${fact.verb}`;
  }
}

function question(fact: Fact): string {
  const no = fact.negative;
  switch (fact.kind) {
    case 'there':
      return fact.plural
        ? `Are there ${no ? 'no' : 'any'} ${fact.noun}?`
        : `Is there ${no ? 'no' : article(fact.noun)} ${fact.noun}?`;
    case 'be':
      return `Is ${fact.subject} ${no ? 'not ' : ''}${fact.complement}?`;
    case 'do':
      return `${no ? 'Does' : 'Does'} ${fact.subject} ${no ? 'not ' : ''}${fact.verb}${fact.object ? ` ${fact.object}` : ''}?`;
    case 'did':
      return `Did ${fact.subject} ${no ? 'not ' : ''}${fact.verb}?`;
    case 'can':
      return `Can ${fact.subject} ${no ? 'not ' : ''}${fact.verb}?`;
  }
}

function thirdPerson(verb: string): string {
  const [head, ...rest] = verb.split(' ');
  const done = head === 'have' ? 'has' : /(s|sh|ch|x)$/.test(head!) ? `${head}es` : `${head}s`;
  return [done, ...rest].join(' ');
}

function past(verb: string): string {
  return verb === 'work' ? 'worked' : /e$/.test(verb) ? `${verb}d` : `${verb}ed`;
}

function parse(code: string): ts.Expression | undefined {
  const file = ts.createSourceFile('condition.ts', `(${code});`, ts.ScriptTarget.Latest, true);
  const [first] = file.statements;
  if (!first || !ts.isExpressionStatement(first) || file.statements.length !== 1) return undefined;
  // A parse error leaves missing nodes; better no sentence than a wrong one.
  if ((file as unknown as { parseDiagnostics?: unknown[] }).parseDiagnostics?.length)
    return undefined;
  return first.expression;
}

const capitalise = (text: string): string => (text ? text[0]!.toUpperCase() + text.slice(1) : text);

/**
 * A condition as a yes/no question whose "yes" is the condition holding:
 * `isLoading || !data` -> "Is it loading, or is there no data?".
 */
export function plainQuestion(code: string): string | undefined {
  const expression = parse(code);
  const read = expression ? say(expression) : undefined;
  if (!read) return undefined;
  const said = merged(read);
  if (said.facts.length === 1) return question(said.facts[0]!);
  // Several facts: the first asked, the rest said, so "yes" stays one answer.
  const parts = said.facts.map(statement);
  const glue = said.join === 'and' ? ' and ' : ', or ';
  return `${capitalise(parts.join(glue))}?`;
}

/** Names every program has, which say nothing about what is checked. */
const BUILT_IN =
  /^(Date|Math|String|Number|Boolean|Array|Object|JSON|crypto|console|window|document|globalThis|now|floor|ceil|round|max|min|abs|length|trim|toString|toUpperCase|toLowerCase|getTime|includes|has|get|test|some|every|filter|map|find|startsWith|endsWith|isNaN|isArray|isInteger|parseInt|parseFloat|i|j|k|undefined|null)$/;

/**
 * A check with no safe sentence — arithmetic, a callback, `a && (b || c)` —
 * still says what it looks at: "Does the check on hit and cache ttl
 * milliseconds hold?" — neutral, since "yes" may be the way it fails.
 */
export function plainFallback(code: string): string | undefined {
  const expression = parse(code);
  if (!expression) return undefined;
  const names: string[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isIdentifier(node) && !BUILT_IN.test(node.text)) {
      const spoken = words(node.text);
      if (spoken.length > 1 && !names.includes(spoken)) names.push(spoken);
    }
    node.forEachChild(visit);
  };
  visit(expression);
  if (names.length === 0) return 'Does this check pass?';
  const shown = names.slice(0, 3);
  const list =
    shown.length === 1
      ? shown[0]!
      : `${shown.slice(0, -1).join(', ')} and ${shown.at(-1)}${names.length > 3 ? ' (and more)' : ''}`;
  return `Does the check on ${list} hold?`;
}

/** A condition as a statement: `total > 0` -> "the total is more than 0". */
export function plainCondition(code: string): string | undefined {
  const expression = parse(code);
  const read = expression ? say(expression) : undefined;
  if (!read) return undefined;
  const said = merged(read);
  return said.facts.map(statement).join(said.join === 'and' ? ' and ' : ', or ');
}

/**
 * A value in words, when it is simple enough to say: a literal, a name, an
 * empty list, a sum — `previousStock + qty` -> "the previous stock plus the
 * quantity", `Math.max(0, x)` -> "the x, but never below 0".
 */
export function plainValue(code: string): string | undefined {
  const expression = parse(code);
  return expression ? valueWords(expression) : undefined;
}

function valueWords(node: ts.Expression): string | undefined {
  const target = strip(node);
  if (ts.isArrayLiteralExpression(target) && target.elements.length === 0) return 'an empty list';
  if (ts.isObjectLiteralExpression(target) && target.properties.length === 0) return 'empty';
  if (target.kind === ts.SyntaxKind.NullKeyword) return 'nothing';
  if (ts.isIdentifier(target) && target.text === 'undefined') return 'nothing';
  if (ts.isBinaryExpression(target)) {
    const op = {
      [ts.SyntaxKind.PlusToken]: 'plus',
      [ts.SyntaxKind.MinusToken]: 'minus',
      [ts.SyntaxKind.AsteriskToken]: 'times',
      [ts.SyntaxKind.SlashToken]: 'divided by',
    } as Partial<Record<ts.SyntaxKind, string>>;
    const word = op[target.operatorToken.kind];
    const left = valueWords(target.left);
    const right = valueWords(target.right);
    return word && left && right ? `${left} ${word} ${right}` : undefined;
  }
  if (ts.isCallExpression(target)) {
    const callee = strip(target.expression);
    const name = ts.isPropertyAccessExpression(callee) ? callee.getText() : undefined;
    const args = target.arguments.map((arg) => valueWords(arg));
    if ((name === 'Math.max' || name === 'Math.min') && args.length === 2 && args.every(Boolean)) {
      const [a, b] = args as [string, string];
      const limit = /^-?\d/.test(a) ? a : b;
      const value = limit === a ? b : a;
      return `${value}, but never ${name === 'Math.max' ? 'below' : 'above'} ${limit}`;
    }
    if (name === 'Math.round' && args[0]) return `${args[0]}, rounded`;
    if (name === 'Date.now') return 'now';
    return undefined;
  }
  if (
    ts.isNewExpression(target) &&
    strip(target.expression).getText() === 'Date' &&
    !target.arguments?.length
  )
    return 'now';
  const value = valueOf(target);
  // A one-letter name says nothing: better no value than "it".
  return value === 'it' ? undefined : value;
}

/**
 * What a function gives back, in words: `{ medicine, action: "updated" }` ->
 * `the medicine and action "updated"`, `[]` -> "an empty list", `true` ->
 * "yes". `undefined` when the value is not simple enough to say.
 */
export function plainResult(code: string): string | undefined {
  const expression = parse(code);
  if (!expression) return undefined;
  const target = strip(expression);
  if (target.kind === ts.SyntaxKind.TrueKeyword) return 'yes';
  if (target.kind === ts.SyntaxKind.FalseKeyword) return 'no';
  if (ts.isObjectLiteralExpression(target) && target.properties.length > 0) {
    const parts: string[] = [];
    for (const property of target.properties) {
      if (ts.isShorthandPropertyAssignment(property)) parts.push(words(property.name.text));
      else if (ts.isPropertyAssignment(property) && ts.isIdentifier(property.name)) {
        const value = strip(property.initializer);
        parts.push(
          ts.isStringLiteral(value) || ts.isNoSubstitutionTemplateLiteral(value)
            ? `${words(property.name.text)} "${value.text}"`
            : words(property.name.text),
        );
      }
    }
    if (parts.length === 0) return undefined;
    return `the ${parts.length > 1 ? `${parts.slice(0, -1).join(', ')} and ${parts.at(-1)}` : parts[0]}`;
  }
  return valueWords(target);
}
