/**
 * The order requests happen in, and which of them wait for each other.
 *
 * One click often makes several calls, and "several calls" covers three very
 * different shapes:
 *
 *   await api.get('/carts/current');            // then
 *   await api.post('/orders', { cartId });      // …this one, which needs the first
 *
 *   api.post('/coupons/validate').then(() => api.put('/carts/current'));
 *                                               // only if the first resolved
 *
 *   await Promise.all([api.get('/medicines'), api.get('/clinics')]);
 *                                               // both at once, neither waits
 *
 * The graph knew all three sets of calls and could not tell them apart: every
 * one came out at the same depth, in whatever order the scan happened to read
 * them. That makes the most ordinary debugging question — "what runs first, and
 * what is waiting on what" — unanswerable from the picture.
 *
 * These facts are collected per call *site*, using only what is reachable from
 * the call expression itself, and recorded on the `requests` edge. Turning them
 * into a sequence needs sibling calls, which is done later, per flow, in
 * `flowApis`.
 */

import { Node, SyntaxKind, type CallExpression } from 'ts-morph';

/** Functions that start several requests at once rather than in turn. */
const CONCURRENT = new Set(['all', 'allSettled', 'race', 'any']);

/** Callbacks that run after a promise settles. */
const CONTINUATIONS = new Set(['then', 'catch', 'finally']);

/** Hooks whose body runs after render, in response to their dependencies. */
const EFFECT_HOOKS = new Set(['useEffect', 'useLayoutEffect', 'useInsertionEffect']);

export interface CallSequenceFacts {
  /**
   * Character offset of the call in its file.
   *
   * Source order is the only honest proxy for execution order in static
   * analysis, and for the sequential case it is exactly right. Offsets rather
   * than line numbers so two calls on one line still order deterministically.
   */
  pos: number;
  /** The call is awaited, so whatever follows it really does follow it. */
  awaited: boolean;
  /** The call sits inside `Promise.all([...])` or a sibling of it. */
  concurrent: boolean;
  /** How many `.then`/`.catch` callbacks enclose the call. */
  continuationDepth: number;
  /** `const order = await api.post(...)` -> `order`. */
  bindsTo?: string;
  /** Plain identifiers this call's arguments read, for spotting dependencies. */
  usesBindings: string[];
  /**
   * The dependency array of the enclosing `useEffect`, when there is one.
   *
   * This is the other way one request ends up waiting for another, and the one
   * source order cannot see: the second call does not mention the first's
   * result, it re-runs when a piece of React state changes — and that state is
   * what the first call set.
   */
  effectDeps?: string[];
  /** The call runs inside an effect rather than directly in a handler. */
  inEffect: boolean;
  /**
   * Identity of the `if`/`switch` the call sits in, when it sits in one.
   *
   * Two calls sharing this and differing in {@link branch} are *alternatives* —
   * only one of them ever runs. Reporting those as a sequence is worse than
   * reporting no order at all, because it reads as "this action makes two
   * requests" when it makes one.
   */
  branchPos?: number;
  /** `then`, `else`, or `case <label>`. */
  branch?: string;
  /** The condition that selects this branch, as written. */
  condition?: string;
  /** The call is in a `catch`, so it only runs when something failed. */
  inCatch: boolean;
  /** The call is in a `finally`, so it runs either way. */
  inFinally: boolean;
  /**
   * React state this call's result flows into.
   *
   * `.then(setUser)`, `setUser(response)`, and the `data:` binding of a query
   * hook. Pairing this with another call's `effectDeps` is what turns two
   * unrelated-looking calls into a chain.
   */
  producesState: string[];
}

/**
 * What can be known about one call site without looking at its siblings.
 */
export function callSequenceFacts(call: CallExpression): CallSequenceFacts {
  return {
    pos: call.getStart(),
    awaited: isAwaited(call),
    concurrent: isConcurrent(call),
    continuationDepth: continuationDepth(call),
    ...(resultBinding(call) ? { bindsTo: resultBinding(call)! } : {}),
    usesBindings: argumentIdentifiers(call),
    ...(enclosingEffectDeps(call) ? { effectDeps: enclosingEffectDeps(call)! } : {}),
    inEffect: enclosingEffectDeps(call) !== undefined,
    producesState: producedState(call),
    ...branchFacts(call),
    inCatch: isInside(call, SyntaxKind.CatchClause),
    inFinally: isInFinallyBlock(call),
  };
}

/**
 * Which arm of which conditional the call is in.
 *
 * Only the *nearest* conditional is recorded. Nesting two levels deep is real
 * but rare, and a chain of conditions reads worse than the one that actually
 * selects between the calls a reader is comparing.
 */
function branchFacts(call: CallExpression): {
  branchPos?: number;
  branch?: string;
  condition?: string;
} {
  for (let node: Node | undefined = call.getParent(); node; node = node.getParent()) {
    if (Node.isIfStatement(node)) {
      const thenBlock = node.getThenStatement();
      const elseBlock = node.getElseStatement();
      const inThen = thenBlock.getStart() <= call.getStart() && call.getEnd() <= thenBlock.getEnd();
      const inElse =
        elseBlock !== undefined &&
        elseBlock.getStart() <= call.getStart() &&
        call.getEnd() <= elseBlock.getEnd();
      if (!inThen && !inElse) continue;
      return {
        branchPos: node.getStart(),
        branch: inThen ? 'then' : 'else',
        condition: condense(node.getExpression().getText()),
      };
    }
    if (Node.isConditionalExpression(node)) {
      const inWhenTrue = within(node.getWhenTrue(), call);
      return {
        branchPos: node.getStart(),
        branch: inWhenTrue ? 'then' : 'else',
        condition: condense(node.getCondition().getText()),
      };
    }
    if (Node.isCaseClause(node)) {
      return {
        branchPos: node.getParent().getStart(),
        branch: `case ${condense(node.getExpression().getText())}`,
        condition: condense(
          `${node.getParent().getParent().getExpression().getText()} === ${node
            .getExpression()
            .getText()}`,
        ),
      };
    }
    if (Node.isDefaultClause(node)) {
      return {
        branchPos: node.getParent().getStart(),
        branch: 'default',
        condition: 'no case matched',
      };
    }
    // Stop at the function boundary: a condition outside it is not a branch of
    // this action, it is a different call site.
    if (
      Node.isArrowFunction(node) ||
      Node.isFunctionExpression(node) ||
      Node.isFunctionDeclaration(node)
    ) {
      return {};
    }
  }
  return {};
}

function within(scope: Node, call: CallExpression): boolean {
  return scope.getStart() <= call.getStart() && call.getEnd() <= scope.getEnd();
}

function isInside(call: CallExpression, kind: SyntaxKind): boolean {
  for (let node: Node | undefined = call.getParent(); node; node = node.getParent()) {
    if (node.getKind() === kind) return true;
  }
  return false;
}

/** `finally` has no node of its own; it is a block on the try statement. */
function isInFinallyBlock(call: CallExpression): boolean {
  for (let node: Node | undefined = call.getParent(); node; node = node.getParent()) {
    if (!Node.isTryStatement(node)) continue;
    const block = node.getFinallyBlock();
    if (block && within(block, call)) return true;
  }
  return false;
}

/** Keep a condition short enough to read in a sentence. */
function condense(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > 48 ? `${flat.slice(0, 47)}…` : flat;
}

/**
 * The dependency list of the `useEffect` this call sits in.
 *
 * An empty array is meaningful and different from absent: `[]` means the effect
 * runs once on mount and waits for nothing, while no array at all means it runs
 * on every render.
 */
function enclosingEffectDeps(call: CallExpression): string[] | undefined {
  for (let node: Node | undefined = call.getParent(); node; node = node.getParent()) {
    if (!Node.isCallExpression(node)) continue;
    const name = calleeName(node);
    if (!EFFECT_HOOKS.has(name)) continue;
    const [, deps] = node.getArguments();
    if (!deps || !Node.isArrayLiteralExpression(deps)) return [];
    return deps
      .getElements()
      .map((element) =>
        Node.isIdentifier(element)
          ? element.getText()
          : Node.isPropertyAccessExpression(element)
            ? element.getExpression().getText()
            : '',
      )
      .filter((entry) => entry !== '');
  }
  return undefined;
}

/**
 * Which state names this call's result ends up in.
 *
 * Three idioms, because they are the three that appear in real React code:
 * a setter passed straight to `.then`, a setter called with the awaited result,
 * and the destructured `data` of a query hook.
 */
function producedState(call: CallExpression): string[] {
  const found = new Set<string>();

  // `api.get(...).then(setUser)` / `.then((r) => setUser(r))`
  for (let node: Node | undefined = call.getParent(); node; node = node.getParent()) {
    if (!Node.isCallExpression(node)) continue;
    const expression = node.getExpression();
    if (!Node.isPropertyAccessExpression(expression)) continue;
    if (!CONTINUATIONS.has(expression.getName())) continue;
    for (const argument of node.getArguments()) {
      if (Node.isIdentifier(argument)) addSetter(found, argument.getText());
      else {
        for (const inner of argument.getDescendantsOfKind(SyntaxKind.CallExpression)) {
          addSetter(found, calleeName(inner));
        }
      }
    }
    break;
  }

  const binding = resultBinding(call);
  if (binding) {
    // `const { data: cart } = useQuery(...)` and `const { data } = useQuery(...)`
    for (const match of binding.matchAll(/\bdata\s*:\s*([A-Za-z_$][\w$]*)/g)) {
      if (match[1]) found.add(match[1]);
    }
    if (/^\{[^}]*\bdata\b[^}]*\}$/.test(binding.replace(/\s+/g, ''))) found.add('data');
    if (/^[A-Za-z_$][\w$]*$/.test(binding)) found.add(binding);

    // `const user = await api.get(...); setUser(user)`
    const scope = enclosingBody(call);
    if (scope) {
      for (const candidate of scope.getDescendantsOfKind(SyntaxKind.CallExpression)) {
        const name = calleeName(candidate);
        if (!/^set[A-Z]/.test(name)) continue;
        const usesBinding = candidate.getArguments().some((argument) =>
          argument
            .getText()
            .split(/[^\w$]/)
            .includes(binding),
        );
        if (usesBinding) addSetter(found, name);
      }
    }
  }

  return [...found];
}

/** `setUser` -> `user`, which is what a dependency array names. */
function addSetter(into: Set<string>, name: string): void {
  if (!/^set[A-Z]/.test(name)) return;
  const state = name.slice(3);
  into.add(state.charAt(0).toLowerCase() + state.slice(1));
}

function enclosingBody(call: CallExpression): Node | undefined {
  for (let node: Node | undefined = call.getParent(); node; node = node.getParent()) {
    if (
      Node.isArrowFunction(node) ||
      Node.isFunctionExpression(node) ||
      Node.isFunctionDeclaration(node)
    ) {
      return node;
    }
  }
  return undefined;
}

/** The called name, member calls reduced to their final segment. */
function calleeName(call: CallExpression): string {
  const expression = call.getExpression();
  if (Node.isIdentifier(expression)) return expression.getText();
  if (Node.isPropertyAccessExpression(expression)) return expression.getName();
  return '';
}

/**
 * `await api.get(...)`, including through a chain: `await api.get(...).then(f)`
 * and `await (await api.get(...)).json()` both await the request.
 */
function isAwaited(call: CallExpression): boolean {
  let current: Node | undefined = call;
  while (current) {
    const parent: Node | undefined = current.getParent();
    if (!parent) return false;
    if (Node.isAwaitExpression(parent)) return true;
    // Keep climbing only while the call is still the thing being operated on.
    if (
      Node.isPropertyAccessExpression(parent) ||
      Node.isCallExpression(parent) ||
      Node.isParenthesizedExpression(parent) ||
      Node.isNonNullExpression(parent)
    ) {
      current = parent;
      continue;
    }
    return false;
  }
  return false;
}

/** Inside the array handed to `Promise.all` and friends. */
function isConcurrent(call: CallExpression): boolean {
  for (let node: Node | undefined = call.getParent(); node; node = node.getParent()) {
    if (!Node.isCallExpression(node)) continue;
    const expression = node.getExpression();
    if (!Node.isPropertyAccessExpression(expression)) continue;
    if (!CONCURRENT.has(expression.getName())) continue;
    if (expression.getExpression().getText() !== 'Promise') continue;
    return true;
  }
  return false;
}

/**
 * How deeply the call is nested inside promise callbacks.
 *
 * A call at depth 1 cannot run until the promise whose `.then` encloses it has
 * resolved — which is a real ordering guarantee, and the one the chained shape
 * relies on.
 */
function continuationDepth(call: CallExpression): number {
  let depth = 0;
  for (let node: Node | undefined = call.getParent(); node; node = node.getParent()) {
    if (!Node.isArrowFunction(node) && !Node.isFunctionExpression(node)) continue;
    const parent = node.getParent();
    if (!parent || !Node.isCallExpression(parent)) continue;
    const expression = parent.getExpression();
    if (Node.isPropertyAccessExpression(expression) && CONTINUATIONS.has(expression.getName())) {
      depth += 1;
    }
  }
  return depth;
}

/** The variable the call's result is assigned to, if any. */
function resultBinding(call: CallExpression): string | undefined {
  for (let node: Node | undefined = call.getParent(); node; node = node.getParent()) {
    if (Node.isVariableDeclaration(node)) {
      const name = node.getNameNode();
      // Destructuring binds several names; the whole pattern is the dependency.
      return Node.isIdentifier(name) ? name.getText() : name.getText().replace(/\s+/g, ' ');
    }
    if (Node.isStatement(node)) return undefined;
  }
  return undefined;
}

/**
 * Identifiers read by the call's arguments.
 *
 * Deliberately shallow — property names, string literals and the call's own
 * callee are excluded — because the question is only "does this argument
 * mention something an earlier call produced".
 */
function argumentIdentifiers(call: CallExpression): string[] {
  const found = new Set<string>();
  for (const argument of call.getArguments()) {
    for (const identifier of argument.getDescendantsOfKind(SyntaxKind.Identifier)) {
      // `cart.id` reads `cart`; the `id` half says nothing about ordering.
      const parent = identifier.getParent();
      if (Node.isPropertyAccessExpression(parent) && parent.getNameNode() === identifier) continue;
      if (Node.isPropertyAssignment(parent) && parent.getNameNode() === identifier) continue;
      found.add(identifier.getText());
    }
    if (Node.isIdentifier(argument)) found.add(argument.getText());
  }
  return [...found];
}
