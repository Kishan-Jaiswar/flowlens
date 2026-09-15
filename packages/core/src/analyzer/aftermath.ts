/**
 * What happens after the request comes back.
 *
 * Everything else in the analyzer follows a click *outwards* — to a handler, a
 * request, a route, a collection. But a developer asking "what happened
 * because of this click" also means the part after the response lands: the
 * screen navigates, a cache is invalidated and refetches, an error state is set
 * and a toast appears. None of that was modelled, so a flow ended at the
 * database and the second half of the round trip was invisible.
 *
 * Read from the handler body, per handler, and recorded on the handler node.
 */

import { Node, SyntaxKind, type CallExpression } from 'ts-morph';

/** Router methods that move the user somewhere else. */
const NAVIGATION = new Set(['push', 'replace', 'back', 'forward', 'refresh']);
const ROUTER_NAMES = new Set(['router', 'navigate', 'history', 'nav']);

/** Query-cache APIs whose effect is "fetch that again". */
/**
 * `mutate` is deliberately absent.
 *
 * It triggers a mutation rather than naming a cache, so reading its arguments
 * as query keys produced entries like `medicine.id` — an id is not a key, and a
 * key nobody can match is noise in a panel that is supposed to be the reliable
 * part.
 */
const INVALIDATORS = new Set([
  'invalidateQueries',
  'refetchQueries',
  'resetQueries',
  'removeQueries',
  'revalidatePath',
  'revalidateTag',
]);

/** Toast and notification helpers, by the name they are usually called by. */
const NOTIFIERS = /^(toast|notify|showToast|showNotification|enqueueSnackbar|message|alert)$/;

export interface Aftermath {
  /** Paths the action sends the user to, as written. */
  navigatesTo: string[];
  /** Query keys or paths it invalidates, which causes a refetch. */
  invalidates: string[];
  /** State setters called on the failure path. */
  errorStates: string[];
  /** Toast or notification calls, with their message when it is a literal. */
  notifies: string[];
  /** True when the handler has a `catch` at all. */
  handlesErrors: boolean;
}

const EMPTY: Aftermath = {
  navigatesTo: [],
  invalidates: [],
  errorStates: [],
  notifies: [],
  handlesErrors: false,
};

/** Read the after-effects out of one handler body. */
export function aftermathOf(fn: Node): Aftermath {
  const navigatesTo = new Set<string>();
  const invalidates = new Set<string>();
  const errorStates = new Set<string>();
  const notifies = new Set<string>();
  let handlesErrors = false;

  for (const call of fn.getDescendantsOfKind(SyntaxKind.CallExpression)) {
    const expression = call.getExpression();
    const member = Node.isPropertyAccessExpression(expression) ? expression.getName() : '';
    const receiver = Node.isPropertyAccessExpression(expression)
      ? expression.getExpression().getText().split('.').pop()
      : '';
    const bare = Node.isIdentifier(expression) ? expression.getText() : '';

    // `router.push('/medicines')`
    if (member && NAVIGATION.has(member) && receiver && ROUTER_NAMES.has(receiver)) {
      const target = firstStringLike(call);
      navigatesTo.add(target ?? `${member}()`);
      continue;
    }

    // `queryClient.invalidateQueries({ queryKey: ['medicines'] })`
    if (INVALIDATORS.has(member) || INVALIDATORS.has(bare)) {
      for (const key of invalidatedKeys(call)) invalidates.add(key);
      continue;
    }

    // `toast.error('Could not save')` / `toast('Saved')`
    if (NOTIFIERS.test(bare) || NOTIFIERS.test(receiver ?? '')) {
      const text = firstStringLike(call);
      notifies.add(text ? `${receiver || bare}: ${text}` : `${receiver || bare}()`);
      continue;
    }

    // A setter called inside a catch is the error the user will see.
    if (/^set[A-Z]/.test(bare) && insideCatch(call)) {
      errorStates.add(bare.slice(3).charAt(0).toLowerCase() + bare.slice(4));
    }
  }

  for (const _ of fn.getDescendantsOfKind(SyntaxKind.CatchClause)) {
    handlesErrors = true;
    break;
  }

  if (
    navigatesTo.size === 0 &&
    invalidates.size === 0 &&
    errorStates.size === 0 &&
    notifies.size === 0 &&
    !handlesErrors
  ) {
    return EMPTY;
  }

  return {
    navigatesTo: [...navigatesTo],
    invalidates: [...invalidates],
    errorStates: [...errorStates],
    notifies: [...notifies],
    handlesErrors,
  };
}

/**
 * The keys an invalidation names.
 *
 * Both spellings are read — `invalidateQueries(['medicines'])` and the v5
 * `invalidateQueries({ queryKey: ['medicines'] })` — because a project on
 * either version should get the same answer. Only the leading literal of a key
 * array is taken: `['medicines', id]` invalidates the medicines family, and the
 * id is the part that varies.
 */
function invalidatedKeys(call: CallExpression): string[] {
  const keys: string[] = [];
  for (const argument of call.getArguments()) {
    if (Node.isArrayLiteralExpression(argument)) {
      const first = argument.getElements()[0];
      const literal = first ? readLiteral(first) : undefined;
      if (literal) keys.push(literal);
      continue;
    }
    if (Node.isObjectLiteralExpression(argument)) {
      for (const property of argument.getProperties()) {
        if (!Node.isPropertyAssignment(property)) continue;
        if (!['queryKey', 'queryKeys', 'key'].includes(property.getName())) continue;
        const value = property.getInitializer();
        if (value && Node.isArrayLiteralExpression(value)) {
          const first = value.getElements()[0];
          const key = first ? (readLiteral(first) ?? keyExpression(first)) : undefined;
          if (key) keys.push(key);
        } else if (value) {
          /**
           * A key factory rather than a literal.
           *
           * `queryKey: queryKeys.medicines.all` is how a real React Query app
           * is written, and reading only literals missed every invalidation in
           * one. The expression is taken as written, and the matching later is
           * by name — which is a heuristic, and is labelled as one.
           */
          const key = readLiteral(value) ?? keyExpression(value);
          if (key) keys.push(key);
        }
      }
      continue;
    }
    const key = readLiteral(argument) ?? keyExpression(argument);
    if (key) keys.push(key);
  }
  return keys;
}

/**
 * A key factory expression, reduced to something a reader recognises.
 *
 * `queryKeys.medicines.detail(medicine.id)` -> `queryKeys.medicines.detail`.
 * The call arguments are dropped because they are the part that varies; the
 * path is the part that names the family being invalidated.
 */
function keyExpression(node: Node): string | undefined {
  const base = Node.isCallExpression(node) ? node.getExpression() : node;
  if (!Node.isPropertyAccessExpression(base) && !Node.isIdentifier(base)) return undefined;
  const text = base.getText().replace(/\s+/g, '');
  return /^[A-Za-z_$][\w$.]*$/.test(text) ? text : undefined;
}

function firstStringLike(call: CallExpression): string | undefined {
  const [first] = call.getArguments();
  return first ? readLiteral(first) : undefined;
}

/** A string literal, or a template's literal head — enough to name a target. */
function readLiteral(node: Node): string | undefined {
  if (Node.isStringLiteral(node) || Node.isNoSubstitutionTemplateLiteral(node)) {
    return node.getLiteralValue();
  }
  if (Node.isTemplateExpression(node)) {
    const head = node.getHead().getLiteralText();
    return head ? `${head}…` : undefined;
  }
  return undefined;
}

function insideCatch(node: Node): boolean {
  for (let current: Node | undefined = node.getParent(); current; current = current.getParent()) {
    if (Node.isCatchClause(current)) return true;
  }
  return false;
}
