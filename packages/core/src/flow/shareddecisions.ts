/**
 * The parts of the decision trees that are the same in every action that
 * runs them — told once, so each action's tree is only what is its own.
 *
 * `requireClinic(request)` checks the token, the clinic and the access the
 * same way for twenty-one requests. Drawn inside each of them, it buried what
 * each feature actually decides under the same forty boxes. Here it is drawn
 * once, as a shared part, and each action names it with one step that says
 * how it can end *there*: `Return a 401 error to the caller`, and so on.
 *
 * Only a helper whose inside is identical is shared — the same function,
 * called with the same arguments, every decision and step in it the same.
 * Two calls that differ anywhere stay where they are. Nothing is summarised:
 * the part is the tree the walk drew, and the step that stands for it lists
 * every way it can leave the caller.
 *
 * Two things in a drawn tree depend on where the helper runs, not on the
 * helper, and are undone before comparing:
 *
 * - "— opened above": the walk opens a helper once per action and names it
 *   after that. Hidden inside a shared part, that name would point at
 *   nothing; the helper's inside is put back in its place first.
 * - "not caught, so the server answers 500": true where nothing around the
 *   call catches, false where something does. The part draws the throw as
 *   written; each action's step says what it means there.
 */

import { createHash } from 'node:crypto';
import type { SourcePoint } from './actionsource.js';
import {
  countOf,
  markUncaught,
  type ActionDecisions,
  type DecisionGroup,
  type DecisionNode,
  type DecisionSide,
  type DecisionStep,
  type SharedUse,
} from './decisions.js';

/** One helper, drawn once for every action that runs it. */
export interface SharedPart {
  id: string;
  /** `requireClinic(request)` — the call as written. */
  title: string;
  /** `Run require clinic`. */
  label: string;
  /** Where the helper is written. */
  callee: SourcePoint;
  side: DecisionSide;
  /** Its inside, as the helper runs it. */
  nodes: DecisionNode[];
  /** The actions that run it, by flow id. */
  flows: string[];
  counts: ActionDecisions['counts'];
}

export interface SharedDecisions {
  parts: Map<string, SharedPart>;
}

/** An action's tree with its shared helpers named, not drawn. */
export interface FactoredDecisions extends ActionDecisions {
  /** The ids of the shared parts this tree names, in the order it names them. */
  shared: string[];
}

const OPENED = ' — opened above';

/** Find the helpers whose inside is the same in two or more places. */
export function indexSharedDecisions(trees: ActionDecisions[]): SharedDecisions {
  const found = new Map<string, { part: SharedPart; flows: Set<string> }>();
  for (const tree of trees) {
    visitGroups(prepared(tree), (group) => {
      if (!shareable(group)) return;
      const { id, nodes } = identity(group);
      let entry = found.get(id);
      if (!entry) {
        entry = {
          part: {
            id,
            title: group.title,
            label: group.label,
            callee: group.callee!,
            side: group.side,
            nodes,
            flows: [],
            counts: countOf(nodes),
          },
          flows: new Set(),
        };
        found.set(id, entry);
      }
      entry.flows.add(tree.flowId);
    });
  }
  const parts = new Map<string, SharedPart>();
  // Shared means more than one action: a helper one action calls twice is its own.
  for (const { part, flows } of found.values()) {
    if (flows.size < 2) continue;
    parts.set(part.id, { ...part, flows: [...flows] });
  }
  return { parts };
}

/**
 * The action's tree with each shared helper replaced by one step naming it —
 * the outermost one: a shared helper inside another is part of that one.
 */
export function factorSharedDecisions(
  tree: ActionDecisions,
  shared: SharedDecisions,
): FactoredDecisions {
  const used: string[] = [];
  const fold = (list: DecisionNode[]): DecisionNode[] =>
    list.map((node) => {
      if (node.type === 'group' && shareable(node)) {
        const part = shared.parts.get(identity(node).id);
        if (part) {
          if (!used.includes(part.id)) used.push(part.id);
          return sharedStep(node, part);
        }
      }
      mapChildren(node, fold);
      return node;
    });
  const nodes = reopen(fold(prepared(tree)));
  return { ...tree, nodes, counts: countOf(nodes), shared: used };
}

/**
 * A helper that is not shared but runs twice in this action is drawn the
 * first time and named after that, the way the walk draws it.
 */
function reopen(nodes: DecisionNode[]): DecisionNode[] {
  const drawn = new Set<string>();
  const pass = (list: DecisionNode[]): DecisionNode[] =>
    list.map((node) => {
      if (node.type === 'group' && node.callee) {
        if (drawn.has(node.title)) {
          const name = node.title.replace(/ \(on error\)$/, '');
          return {
            type: 'step',
            kind: 'call',
            label: `Run ${node.label.replace(/^Run /, '')} (opened above)`,
            text: `${name}${OPENED}`,
            side: node.side,
            ...(node.at ? { at: node.at } : {}),
          };
        }
        drawn.add(node.title);
      }
      mapChildren(node, pass);
      return node;
    });
  return pass(nodes);
}

/** A shared part on its own, in the shape a view draws a tree in. */
export function sharedPartTree(part: SharedPart): ActionDecisions {
  return {
    flowId: `shared:${part.id}`,
    title: part.title,
    nodes: [
      {
        type: 'group',
        kind: 'function',
        label: part.label,
        title: part.title,
        side: part.side,
        at: part.callee,
        callee: part.callee,
        nodes: structuredClone(part.nodes),
      },
    ],
    counts: part.counts,
    limits: [
      'Drawn as the helper is written. Where a throw in it is not caught, the step that names it in each action says so.',
    ],
  };
}

// ---------------------------------------------------------------------------

/**
 * A helper the request is sent from, or the user's own click, is the action
 * itself: folding it away would hide what the action does.
 */
function shareable(group: DecisionGroup): boolean {
  if (!group.callee) return false;
  let ok = true;
  visit(group.nodes, (node) => {
    if (node.type === 'group' && (node.kind === 'request' || node.kind === 'unlinked')) ok = false;
    if (node.type === 'step' && node.kind === 'trigger') ok = false;
  });
  return ok;
}

/**
 * The tree with every helper drawn in full — no "opened above" — and throws
 * marked for where they are. For a view that cuts part of a tree out: what
 * "above" pointed at may not be in the part.
 */
export function expandedDecisions(tree: ActionDecisions): DecisionNode[] {
  return prepared(tree);
}

/** The tree with every helper drawn in full, and throws marked for where they are. */
function prepared(tree: ActionDecisions): DecisionNode[] {
  const nodes = structuredClone(tree.nodes);
  const first = new Map<string, DecisionGroup>();
  visitGroups(nodes, (group) => {
    if (group.callee && !first.has(group.title)) first.set(group.title, group);
  });
  const expand = (list: DecisionNode[], open: Set<string>): DecisionNode[] =>
    list.map((node) => {
      if (node.type === 'step' && node.kind === 'call' && node.text.endsWith(OPENED)) {
        const title = node.text.slice(0, -OPENED.length);
        const group = first.get(title) ?? first.get(`${title} (on error)`);
        if (group && !open.has(group.title)) {
          const copy = structuredClone(group);
          if (node.at) copy.at = node.at;
          copy.nodes = expand(copy.nodes, new Set([...open, group.title]));
          return copy;
        }
      }
      const inner = node.type === 'group' && node.callee ? new Set([...open, node.title]) : open;
      mapChildren(node, (children) => expand(children, inner));
      return node;
    });
  const out = expand(nodes, new Set());
  unmark(out);
  markUncaught(out, false);
  return out;
}

/** Throws as written, before "not caught, so the server answers 500". */
function unmark(nodes: DecisionNode[]): void {
  visit(nodes, (node) => {
    if (node.type !== 'end' || !node.uncaught) return;
    node.text = node.uncaught.text;
    node.label = node.uncaught.label;
    delete node.statuses;
    delete node.uncaught;
  });
}

/** What makes two calls the same: the function, the arguments, every node inside. */
function identity(group: DecisionGroup): { id: string; nodes: DecisionNode[] } {
  const nodes = structuredClone(group.nodes);
  unmark(nodes);
  const id = createHash('sha1')
    .update(`${group.callee!.file}:${group.callee!.line}\n${group.title}\n${JSON.stringify(nodes)}`)
    .digest('hex')
    .slice(0, 12);
  return { id, nodes };
}

/**
 * The one step that stands for a shared helper, with every way it hands
 * control back: what it returns — an error with a status, a rejection, a
 * value — what it answers, and what it throws that nothing inside catches.
 */
function sharedStep(group: DecisionGroup, part: SharedPart): DecisionStep {
  const ends: SharedUse['ends'] = [];
  const add = (label: string, statuses?: number[]): void => {
    const key = `${label}|${statuses?.join('/') ?? ''}`;
    if (ends.some((end) => `${end.label}|${end.statuses?.join('/') ?? ''}` === key)) return;
    ends.push({ label, ...(statuses?.length ? { statuses } : {}) });
  };
  /**
   * `own`: still in the helper's own body, where a `return` hands its value
   * to the caller. Inside a helper it calls, a return goes back to that
   * instead. (A `return` in a loop's callback is drawn as "skip to the next
   * item", not as a return, so a loop keeps `own`.)
   */
  const collect = (list: DecisionNode[], own: boolean, caught: boolean): void => {
    for (const node of list) {
      switch (node.type) {
        case 'end':
          if (node.outcome === 'throw' && !caught) add(node.label, node.statuses);
          else if (node.outcome === 'respond' || node.outcome === 'stop')
            add(node.label, node.statuses);
          else if (node.outcome === 'return' && own) add(node.label, node.statuses);
          break;
        case 'decision':
          for (const branch of node.branches) collect(branch.nodes, own, caught);
          break;
        case 'group':
          collect(node.nodes, own && node.kind !== 'function', caught);
          break;
        case 'try':
          collect(node.nodes, own, caught || node.catch !== undefined);
          if (node.catch) collect(node.catch.nodes, own, caught);
          if (node.finally) collect(node.finally, own, caught);
          break;
        case 'step':
          if (node.shared) for (const end of node.shared.ends) add(end.label, end.statuses);
          break;
      }
    }
  };
  collect(group.nodes, true, false);
  // A path that reaches the end of the helper without a return of its own.
  if (!endsAll(group.nodes)) add('Carry on with the next step');
  return {
    type: 'step',
    kind: 'shared',
    label: group.label,
    text: group.title,
    side: group.side,
    ...(group.at ? { at: group.at } : {}),
    shared: { id: part.id, actions: part.flows.length, ends },
  };
}

/** Every path through the list ends in a return, an answer or a throw. */
function endsAll(nodes: DecisionNode[]): boolean {
  const last = nodes.at(-1);
  if (!last) return false;
  if (last.type === 'end') return true;
  if (last.type === 'decision')
    return last.otherwise === undefined && last.branches.every((branch) => branch.ends);
  if (last.type === 'try') return endsAll(last.nodes) && (last.catch?.ends ?? true);
  return false;
}

function mapChildren(node: DecisionNode, fn: (list: DecisionNode[]) => DecisionNode[]): void {
  switch (node.type) {
    case 'group':
      node.nodes = fn(node.nodes);
      break;
    case 'decision':
      for (const branch of node.branches) branch.nodes = fn(branch.nodes);
      break;
    case 'try':
      node.nodes = fn(node.nodes);
      if (node.catch) node.catch.nodes = fn(node.catch.nodes);
      if (node.finally) node.finally = fn(node.finally);
      break;
  }
}

function visit(nodes: DecisionNode[], fn: (node: DecisionNode) => void): void {
  for (const node of nodes) {
    fn(node);
    mapChildren(node, (children) => {
      visit(children, fn);
      return children;
    });
  }
}

function visitGroups(nodes: DecisionNode[], fn: (group: DecisionGroup) => void): void {
  visit(nodes, (node) => {
    if (node.type === 'group') fn(node);
  });
}
