/**
 * The scenarios that write a collection, read from the code's own branches.
 *
 * Every request (or script) that reaches a write is followed down its call
 * path, and each `if` the write sits inside — or early `return` before it —
 * is a condition on it: `upsertMedicine` writes one way when `existing` and
 * another when not. Each distinct set of conditions is one scenario, so a
 * field card can say what happens to it in every case — set, kept, added to,
 * recalculated, removed — without anyone listing the cases by hand. A write
 * no request reaches is a script's or a job's, and is a scenario too: every
 * write belongs to one.
 */

import { Node, SyntaxKind, type CallExpression } from 'ts-morph';
import type { FlowGraph } from '../graph/graph.js';
import type { FlowNode, SourceRef } from '../graph/types.js';
import {
  callAtLine,
  condense,
  localVariable,
  nearestFunction,
  type SourceReader,
} from './actionsource.js';
import { phrase } from './conditionwords.js';
import { locateQueryCall } from './queries.js';

/** One condition a write sits under: `existing` holds, or does not. */
export interface ScenarioCondition {
  /** The condition as written, without a leading `!`: `existing`, `addQty > 0`. */
  code: string;
  holds: boolean;
  /** The call the condition's variable comes from: `findDuplicate` for `const existing = await findDuplicate(…)`. */
  from?: string;
  /** For a `parsed.success` check: the call that parses, `medicineSchema.safeParse`. */
  checkedBy?: string;
  /** The condition in plain words: "a matching batch is found", "the quantity is more than 0". */
  words: string;
}

export interface ScenarioWrite {
  nodeId: string;
  operation: string;
  effect: string;
  in?: string;
  source?: SourceRef;
}

export interface Scenario {
  id: string;
  /**
   * What starts it: a `request` (the frontend calls an API), a background `job`
   * (a queue worker or its failure handler), or a `script` run by hand.
   */
  kind: 'request' | 'job' | 'script';
  /** The request that starts it; none for a script or job. */
  endpoint?: string;
  /** For a script or job: the function that writes, and the one that runs it (`startImportWorker`). */
  script?: { in: string; source?: SourceRef; runBy?: { in: string; source?: SourceRef } };
  /** A case where nothing is written: the early exit, in the function it is in. */
  nothing?: { in: string; source?: SourceRef };
  /** What the writer returns on this branch, when plain: lets a caller's `if (!ok) return` rule writes out. */
  returns?: 'truthy' | 'falsy';
  /** The user actions that send the request. */
  actions: Array<{ flowId: string; title: string }>;
  when: ScenarioCondition[];
  queued?: QueueHop;
  /** This collection's writes in this scenario. */
  writes: ScenarioWrite[];
  /** Other collections written on the same path: a stock movement beside a medicine. */
  alsoWrites: string[];
  /**
   * The request's input check (`medicineSchema.safeParse`), when every path to a
   * write passes it: an invalid request is its own case, rejected before any save.
   */
  checkedBy?: string;
}

/** The worker that picks the job up, at the line it carries on toward the save. */
export interface QueueHop {
  in: string;
  source?: SourceRef;
}

const ROUTES_OF = new WeakMap<FlowGraph, Map<string, FlowNode[]>>();

/** The routes whose handler reaches a node, through calls and queued jobs. */
export function routesRunning(
  graph: FlowGraph,
  nodeId: string,
  /** Functions not to walk past: another writer that decides for itself. */
  stopAt?: ReadonlySet<string>,
): FlowNode[] {
  let cache = ROUTES_OF.get(graph);
  if (!cache) ROUTES_OF.set(graph, (cache = new Map()));
  const cached = stopAt ? undefined : cache.get(nodeId);
  if (cached) return cached;
  const routes = new Map<string, FlowNode>();
  const seen = new Set([nodeId]);
  let frontier = [nodeId];
  for (let depth = 0; depth < 12 && frontier.length; depth += 1) {
    const next: string[] = [];
    for (const id of frontier) {
      for (const node of graph.predecessors(id, ['queries', 'calls', 'emits'])) {
        if (seen.has(node.id) || stopAt?.has(node.id)) continue;
        seen.add(node.id);
        if (node.kind === 'route') routes.set(node.id, node);
        else next.push(node.id);
      }
    }
    frontier = next;
  }
  const found = [...routes.values()];
  if (!stopAt) cache.set(nodeId, found);
  return found;
}

/**
 * What a route passes through on its way to a db-op: another writer of the
 * collection, and a background job. A job shows as a queue (an external effect)
 * whose worker the graph links with `calls`; the save then happens when the
 * worker runs, not during the request.
 */
export function pathHops(
  graph: FlowGraph,
  route: FlowNode,
  nodeId: string,
  writerFns: ReadonlySet<string>,
): { via?: string; queued?: QueueHop } {
  const path = graph.path(route.id, nodeId, ['calls', 'queries', 'emits']);
  const own = new Set(graph.predecessors(nodeId, ['queries']).map((n) => n.id));
  let queued: QueueHop | undefined;
  for (let i = 0; i + 1 < path.length; i += 1) {
    const node = graph.node(path[i]!);
    const worker = graph.node(path[i + 1]!);
    if (node?.kind !== 'external-effect' || !worker || worker.kind === 'external-effect') continue;
    const next = path[i + 2];
    const line = next
      ? graph.edgesFrom(worker.id, ['calls']).find((edge) => edge.to === next)?.meta?.['line']
      : undefined;
    queued = {
      in: worker.label.split('.').pop()!,
      ...(worker.source
        ? {
            source: {
              file: worker.source.file,
              line: typeof line === 'number' ? line : worker.source.line,
            },
          }
        : {}),
    };
    break;
  }
  const via = path.slice(1, -1).find((id) => writerFns.has(id) && !own.has(id));
  return {
    ...(via ? { via: graph.node(via)?.label.split('.').pop() } : {}),
    ...(queued ? { queued } : {}),
  };
}

const PATH_EDGES = ['calls', 'queries', 'emits'] as const;

/**
 * Every scenario that writes a collection.
 *
 * `writeOps` are the collection's write and delete db-ops; `others` are every
 * other collection's, to say what else each scenario writes.
 */
export function scenariosOf(
  graph: FlowGraph,
  reader: SourceReader,
  writeOps: readonly FlowNode[],
  others: readonly FlowNode[],
  actionsCalling: (endpoint: string) => Array<{ flowId: string; title: string }>,
): Scenario[] {
  const byKey = new Map<string, Scenario>();
  // The cases split inside the functions that write this collection; a handler's checks are preconditions.
  const writers = new Set(
    writeOps.flatMap((op) => graph.predecessors(op.id, ['queries']).map((n) => n.id)),
  );
  const conditions = new ConditionReader(graph, reader, writers);
  const routesTouched = new Map<string, FlowNode>();
  for (const op of writeOps) {
    const routes = routesRunning(graph, op.id);
    const method = graph.predecessors(op.id, ['queries'])[0];
    const write: ScenarioWrite = {
      nodeId: op.id,
      operation: op.label,
      effect: String(op.meta?.['effect'] ?? 'write'),
      ...(method ? { in: method.label.split('.').pop()! } : {}),
      ...(op.source ? { source: op.source } : {}),
    };
    // A write no request reaches: a script, or a job's handler, its own scenario.
    if (routes.length === 0) {
      const own = conditions.ofOp(op);
      if (contradicts(own.when)) continue;
      const key = `script|${write.in}|${keyOf(own.when)}`;
      const runBy = method ? callerOf(graph, method) : undefined;
      const scenario =
        byKey.get(key) ??
        byKey
          .set(key, {
            id: key,
            kind: isJob(method, runBy) ? 'job' : 'script',
            script: {
              in: write.in ?? 'code',
              ...(method?.source ? { source: method.source } : {}),
              ...(runBy ? { runBy } : {}),
            },
            actions: [],
            when: own.when,
            writes: [],
            alsoWrites: [],
          })
          .get(key)!;
      scenario.writes.push(write);
      continue;
    }
    for (const route of routes) {
      routesTouched.set(route.id, route);
      const { queued } = pathHops(graph, route, op.id, new Set());
      for (const alt of conditions.onPath(route, op)) {
        if (contradicts(alt.split)) continue;
        // In the request or in a background job: two moments, two cases.
        const key = `${route.id}|${queued?.in ?? ''}|${keyOf(alt.split)}`;
        let scenario = byKey.get(key);
        if (!scenario) {
          scenario = {
            id: key,
            kind: 'request',
            endpoint: route.label,
            actions: actionsCalling(route.label),
            when: alt.split,
            ...(queued ? { queued } : {}),
            ...(alt.result ? { returns: alt.result } : {}),
            writes: [],
            alsoWrites: [],
          };
          byKey.set(key, scenario);
        }
        if (!scenario.writes.some((w) => w.nodeId === write.nodeId)) scenario.writes.push(write);
      }
    }
  }
  // Early exits before any write: a case where nothing is written.
  for (const route of routesTouched.values())
    for (const exit of conditions.exitsOn(route, writeOps)) {
      const key = `${route.id}|nothing|${exit.in}|${keyOf(exit.when)}`;
      if (byKey.has(key)) continue;
      const { queued } = pathHops(graph, route, exit.nodeId, new Set());
      byKey.set(key, {
        id: key,
        kind: 'request',
        endpoint: route.label,
        actions: actionsCalling(route.label),
        when: exit.when,
        ...(queued ? { queued } : {}),
        writes: [],
        alsoWrites: [],
        nothing: { in: exit.in, ...(exit.source ? { source: exit.source } : {}) },
      });
    }
  // What else each scenario writes: other collections' writes on the same request that
  // can run with it — no condition contradicts, and none waits on a result this case does not give.
  for (const scenario of byKey.values()) {
    if (!scenario.endpoint || scenario.nothing) continue;
    const route = routesTouched.get(
      graph.nodesOfKind('route').find((node) => node.label === scenario.endpoint)?.id ?? '',
    );
    if (!route) continue;
    const writerNames = new Set(scenario.writes.map((w) => w.in));
    const also = new Set<string>();
    for (const op of others) {
      if (!routesRunning(graph, op.id).some((r) => r.id === route.id)) continue;
      // The same moment: a write the background job makes is not part of the request's case.
      if (pathHops(graph, route, op.id, new Set()).queued?.in !== scenario.queued?.in) continue;
      const fits = conditions
        .onPath(route, op)
        .some(
          (alt) =>
            !contradicts([...scenario.when, ...alt.all]) &&
            !alt.all.some(
              (c) =>
                c.from !== undefined &&
                writerNames.has(c.from) &&
                scenario.returns !== undefined &&
                (c.holds ? scenario.returns === 'falsy' : scenario.returns === 'truthy'),
            ),
        );
      if (fits) also.add(String(op.meta?.['collection']));
    }
    scenario.alsoWrites = [...also].sort();
  }
  const scenarios = [...byKey.values()];
  for (const group of groupBy(scenarios, (s) => s.endpoint ?? `script|${s.script?.in}`)) {
    const writing = group.filter((s) => !s.nothing);
    const shared = (writing[0]?.when ?? []).filter((c) =>
      writing.every((s) =>
        s.when.some((o) => o.holds === c.holds && subjectOf(o) === subjectOf(c)),
      ),
    );
    for (const scenario of writing)
      scenario.when = scenario.when.filter(
        (c) => !shared.some((o) => o.holds === c.holds && subjectOf(o) === subjectOf(c)),
      );
  }
  // A schema check on the way: invalid input is a case of its own, rejected before any save.
  for (const scenario of scenarios) {
    const route = scenario.endpoint
      ? graph.nodesOfKind('route').find((node) => node.label === scenario.endpoint)
      : undefined;
    const check = route && conditions.checks.get(route.id);
    if (check) scenario.checkedBy = check;
  }
  // Adds first, then changes, nothing-written cases, removals, and scripts last.
  const rank = (s: Scenario) =>
    s.script
      ? 4
      : s.writes.some((w) => w.effect === 'delete')
        ? 3
        : s.nothing
          ? 2
          : s.writes.some((w) => w.effect === 'create')
            ? 0
            : 1;
  const firstSeen = new Map(scenarios.map((s, i) => [s.endpoint, i]));
  return scenarios.sort(
    (a, b) =>
      rank(a) - rank(b) ||
      (firstSeen.get(a.endpoint) ?? 0) - (firstSeen.get(b.endpoint) ?? 0) ||
      a.when.length - b.when.length,
  );
}

/** Run by a queue worker, a job processor or a scheduler — by its name or its file. */
function isJob(
  method: FlowNode | undefined,
  runBy: { in: string; source?: SourceRef } | undefined,
): boolean {
  const JOB = /worker|job|queue|consumer|processor|cron|schedul/i;
  return [runBy?.in, runBy?.source?.file, method?.source?.file].some(
    (text) => text !== undefined && JOB.test(text),
  );
}

/** The function that runs a method no request reaches: what a job's handler is run by. */
function callerOf(
  graph: FlowGraph,
  method: FlowNode,
): { in: string; source?: SourceRef } | undefined {
  // The function that calls it: `startImportWorker` for a worker's failure handler.
  const caller = graph.predecessors(method.id, ['calls'])[0];
  return caller
    ? { in: caller.label.split('.').pop()!, ...(caller.source ? { source: caller.source } : {}) }
    : undefined;
}

function groupBy<T>(items: readonly T[], key: (item: T) => string): T[][] {
  const groups = new Map<string, T[]>();
  for (const item of items)
    (groups.get(key(item)) ?? groups.set(key(item), []).get(key(item))!).push(item);
  return [...groups.values()];
}

const keyOf = (when: readonly ScenarioCondition[]): string =>
  when
    .map((c) => `${c.holds ? '' : '!'}${subjectOf(c)}`)
    .sort()
    .join('&');

/** `existing` and not `existing` on one path (or two checks by the same finder): no such case. */
function contradicts(when: readonly ScenarioCondition[]): boolean {
  const seen = new Map<string, boolean>();
  for (const condition of when) {
    const subject = subjectOf(condition);
    const before = seen.get(subject);
    if (before !== undefined && before !== condition.holds) return true;
    seen.set(subject, condition.holds);
  }
  return false;
}

/** One way down a path: the conditions that split cases, every condition, and what the writer returns. */
interface PathRead {
  split: ScenarioCondition[];
  all: ScenarioCondition[];
  result?: 'truthy' | 'falsy';
}

const MAX_ALTERNATIVES = 8;

/**
 * What a condition is about: the finder and the variable it fills, so `existing`
 * from `findDuplicate` in two functions is one check, but `doc` and `existing`
 * from two `findOne`s are two.
 */
const subjectOf = (c: ScenarioCondition): string => (c.from ? `${c.from}:${c.code}` : c.code);

const sameCondition = (c: ScenarioCondition) => `${c.holds}|${subjectOf(c)}`;
const dedupeConditions = (list: ScenarioCondition[]) => [
  ...new Map(list.map((c) => [sameCondition(c), c])).values(),
];

interface Step {
  from: FlowNode;
  fn: Node;
  calls: Node[];
}

/** Reads the conditions around call sites and queries, caching each path it opens. */
class ConditionReader {
  private readonly paths = new Map<string, PathRead[]>();
  private readonly stepCache = new Map<string, Step | undefined>();
  /** Every function a write of the collection is reached through, by name: read once. */
  private leadingNames?: Set<string>;
  /** Input checks (`schema.safeParse`) met on the way, by route. */
  readonly checks = new Map<string, string>();

  constructor(
    private readonly graph: FlowGraph,
    private readonly reader: SourceReader,
    /** Functions whose conditions split cases: the collection's writers. */
    private readonly writers: ReadonlySet<string>,
  ) {}

  /**
   * Every way from a route down to a db-op. A caller that calls the next
   * function from two places (`recordMovement` in both branches of an upsert)
   * gives two ways, each with the conditions of its own call site.
   */
  onPath(route: FlowNode, op: FlowNode): PathRead[] {
    const key = `${route.id}>${op.id}`;
    const cached = this.paths.get(key);
    if (cached) return cached;
    // Every way down, not only the shortest: `recordMovement` through `adjustStock` as well as `upsertMedicine`.
    const ways = allPaths(this.graph, route.id, op.id)
      .flatMap((path) => this.readPath(route, op, path))
      .slice(0, MAX_ALTERNATIVES * 2);
    this.paths.set(key, ways);
    return ways;
  }

  private readPath(route: FlowNode, op: FlowNode, path: readonly string[]): PathRead[] {
    let ways: PathRead[] = [{ split: [], all: [] }];
    try {
      for (const step of this.steps(path)) {
        const options = step.calls.map((call) => conditionsAround(call, step.fn));
        for (const option of options) {
          const check = option.find((c) => c.checkedBy && c.holds);
          // The request's own check; one in a job (a row at a time) is a case of its own.
          if (check?.checkedBy && step.from.id === path[1])
            this.checks.set(route.id, check.checkedBy);
        }
        if (!options.length) continue;
        const splits = this.writers.has(step.from.id);
        ways = ways
          .flatMap((way) =>
            options.map((option) => ({
              split: splits ? [...way.split, ...option] : way.split,
              all: [...way.all, ...option],
            })),
          )
          .slice(0, MAX_ALTERNATIVES);
      }
      const own = this.ofOp(op);
      ways = ways.map((way) => ({
        split: dedupeConditions([...way.split, ...own.when]),
        all: dedupeConditions([...way.all, ...own.when]),
        ...(own.result ? { result: own.result } : {}),
      }));
    } catch {
      // Unreadable code: no conditions read rather than wrong ones.
      ways = [{ split: [], all: [] }];
    }
    return ways;
  }

  /** Each method on a path, its function, and every call it makes to the next one. */
  private steps(path: readonly string[]): Step[] {
    const steps: Step[] = [];
    for (let i = 0; i + 1 < path.length; i += 1) {
      const step = this.step(path[i]!, path[i + 1]!);
      if (step) steps.push(step);
    }
    return steps;
  }

  /** One caller → callee hop, its function and every call it makes to the callee: read once. */
  private step(fromId: string, toId: string): Step | undefined {
    const key = `${fromId}>${toId}`;
    if (this.stepCache.has(key)) return this.stepCache.get(key);
    let found: Step | undefined;
    const from = this.graph.node(fromId);
    const to = this.graph.node(toId);
    if (from && to && from.kind === 'method' && to.kind !== 'db-op' && from.source) {
      const edge = this.graph.edgesFrom(from.id, ['calls']).find((e) => e.to === to.id);
      const line = edge?.meta?.['line'];
      const file = typeof line === 'number' ? this.reader.file(from.source.file) : undefined;
      const name = to.label.split('.').pop()!;
      const first = file && typeof line === 'number' ? callAtLine(file, line, name) : undefined;
      const fn = first ? functionAt(first, from.source.line) : undefined;
      if (first && fn) {
        const calls = fn
          .getDescendantsOfKind(SyntaxKind.CallExpression)
          .filter((call) => calleeName(call) === name);
        found = { from, fn, calls: calls.length ? calls : [first] };
      }
    }
    this.stepCache.set(key, found);
    return found;
  }

  /** The function a db-op is written in, as a step whose only call is the query. */
  ownStep(op: FlowNode): Step | undefined {
    const method = this.graph.predecessors(op.id, ['queries'])[0];
    const call = locateQueryCall(
      this.reader,
      op.source?.file,
      op.source?.line,
      String(op.meta?.['operation'] ?? ''),
    );
    const fn = call && functionAt(call, method?.source?.line);
    return method && call && fn ? { from: method, fn, calls: [call] } : undefined;
  }

  ofOp(op: FlowNode): { when: ScenarioCondition[]; result?: 'truthy' | 'falsy' } {
    const call = locateQueryCall(
      this.reader,
      op.source?.file,
      op.source?.line,
      String(op.meta?.['operation'] ?? ''),
    );
    if (!call) return { when: [] };
    const method = this.graph.predecessors(op.id, ['queries'])[0];
    const fn = functionAt(call, method?.source?.line);
    const result = branchResult(call, fn);
    return { when: conditionsAround(call, fn), ...(result ? { result } : {}) };
  }

  /**
   * Early exits on the way to the collection's writes, before any of them:
   * `if (attempts >= MAX) return false`, `if (!parsed.success) continue`. Each is
   * a case where nothing is written. The request handler's own are preconditions.
   */
  exitsOn(
    route: FlowNode,
    writeOps: readonly FlowNode[],
  ): Array<{ when: ScenarioCondition[]; in: string; nodeId: string; source?: SourceRef }> {
    const found: Array<{
      when: ScenarioCondition[];
      in: string;
      nodeId: string;
      source?: SourceRef;
    }> = [];
    const opNames = new Set(writeOps.map((op) => String(op.meta?.['operation'] ?? '')));
    // Every function a write of this collection is reached through: a call to one is a write.
    if (!this.leadingNames) {
      this.leadingNames = new Set<string>();
      for (const op of writeOps)
        for (const node of ancestorsOf(this.graph, op.id))
          this.leadingNames.add(node.label.split('.').pop()!);
    }
    const leading = this.leadingNames;
    const isWrite = (call: Node) => opNames.has(calleeName(call)) || leading.has(calleeName(call));
    for (const op of writeOps) {
      if (!routesRunning(this.graph, op.id).some((r) => r.id === route.id)) continue;
      for (const path of allPaths(this.graph, route.id, op.id)) {
        let steps: Step[];
        try {
          steps = this.steps(path);
          // The writer's own function too: `verifyOtp` returns early before its writes.
          const own = this.ownStep(op);
          if (own && !steps.some((step) => step.from.id === own.from.id)) steps.push(own);
        } catch {
          continue;
        }
        // The request handler checks the request: its exits are preconditions, not cases.
        for (const step of steps.filter((s) => s.from.id !== path[1])) {
          // Exits before the first write every run makes. A write under an `if` (`if (redated)
          // save`) or in a branch that returns does not stop later checks counting: the case
          // that reaches the exit is the one where that `if` was false.
          const writeCalls = step.fn
            .getDescendantsOfKind(SyntaxKind.CallExpression)
            .filter((call) => isWrite(call));
          const first = writeCalls.find((call) => !underIf(call, step.fn));
          const limit = first?.getStart() ?? Math.min(...step.calls.map((c) => c.getStart()));
          const writesIn = (node: Node | undefined) =>
            node !== undefined &&
            node.getDescendantsOfKind(SyntaxKind.CallExpression).some(isWrite);
          for (const statement of step.fn.getDescendantsOfKind(SyntaxKind.IfStatement)) {
            if (nearestFunction(statement) !== step.fn) continue;
            const then = statement.getThenStatement();
            const otherwise = statement.getElseStatement();
            if (writesIn(then)) continue;
            // `if (bad) { … } else { save }`: the side with no write is a case of its own.
            const sidePath = otherwise !== undefined && writesIn(otherwise);
            // `if (done) return …` before the writes: the case stops there.
            const stops = !otherwise && exits(then) && statement.getEnd() <= limit;
            if (!sidePath && !stops) continue;
            // `continue` skips one item: a case only when a write follows it in the same loop.
            const loop = statement.getFirstAncestor(
              (a) =>
                Node.isForStatement(a) ||
                Node.isForOfStatement(a) ||
                Node.isForInStatement(a) ||
                Node.isWhileStatement(a),
            );
            if (stops && endsInContinue(then) && !(loop && writesIn(loop))) continue;
            // Each conditional write before the exit did not happen on the way to it.
            const skipped = writeCalls
              .filter((call) => call.getEnd() < statement.getStart())
              .map((call) => innermostIf(call, step.fn))
              .filter((branch): branch is { test: Node; then: boolean } => branch !== undefined)
              .map((branch) => condition(branch.test, !branch.then));
            const when = [condition(statement.getExpression(), true), ...skipped];
            found.push({
              when,
              in: step.from.label.split('.').pop()!,
              nodeId: step.from.id,
              source: this.reader.point(statement),
            });
          }
        }
      }
    }
    return [
      ...new Map(found.map((f) => [`${f.in}|${f.when.map(sameCondition).join('&')}`, f])).values(),
    ];
  }
}

/** Every simple path from one node down to another, over calls, queries and queued jobs (bounded). */
function allPaths(graph: FlowGraph, from: string, to: string): string[][] {
  const found: string[][] = [];
  const walk = (id: string, path: string[]) => {
    if (found.length >= MAX_ALTERNATIVES || path.length > 14) return;
    if (id === to) {
      found.push(path);
      return;
    }
    for (const edge of graph.edgesFrom(id, [...PATH_EDGES]))
      if (!path.includes(edge.to)) walk(edge.to, [...path, edge.to]);
  };
  walk(from, [from]);
  // A route linked straight to a query (a runtime trace saw it run) has no code on the way:
  // it counts only when no path through the code exists.
  const throughCode = found.filter((path) => path.length > 2);
  return throughCode.length ? throughCode : found;
}

/** Every node a db-op is reached from, through the calls into it. */
function ancestorsOf(graph: FlowGraph, id: string): FlowNode[] {
  const seen = new Map<string, FlowNode>();
  let frontier = [id];
  while (frontier.length) {
    const next: string[] = [];
    for (const current of frontier)
      for (const node of graph.predecessors(current, [...PATH_EDGES]))
        if (!seen.has(node.id) && node.kind !== 'route') {
          seen.set(node.id, node);
          next.push(node.id);
        }
    frontier = next;
  }
  return [...seen.values()];
}

function calleeName(call: Node): string {
  if (!Node.isCallExpression(call)) return '';
  const callee = call.getExpression();
  return Node.isPropertyAccessExpression(callee) ? callee.getName() : callee.getText();
}

/**
 * What a function returns on the branch a node is in, when it is plain:
 * `return false` after a failed guess is `falsy`; `return true` is `truthy`.
 */
function branchResult(node: Node, stop: Node | undefined): 'truthy' | 'falsy' | undefined {
  let child: Node = node;
  for (
    let parent = node.getParent();
    parent && child !== stop;
    child = parent, parent = parent.getParent()
  ) {
    if (Node.isBlock(parent)) {
      const statements = parent.getStatements();
      const after = statements.slice(statements.indexOf(child as never) + 1);
      const returned = after.find((s) => Node.isReturnStatement(s));
      if (returned && Node.isReturnStatement(returned)) {
        const value = returned.getExpression()?.getText() ?? 'undefined';
        if (/^(false|null|undefined|0|''|"")$/.test(value)) return 'falsy';
        if (/^(true|\{[\s\S]*\}|[1-9]\d*)$/.test(value)) return 'truthy';
        return undefined;
      }
    }
    if (parent === stop) break;
  }
  return undefined;
}

/** The function a call sits in that starts on `line` (the method the graph names), or the nearest. */
function functionAt(node: Node, line: number | undefined): Node | undefined {
  let found = nearestFunction(node);
  for (let current = found; current; current = nearestFunction(current)) {
    if (current.getStartLineNumber() === line) return current;
    found = current;
  }
  return line === undefined ? nearestFunction(node) : found;
}

/**
 * The conditions a node runs under inside its function: the `if`s around it
 * (and which side it is on), the `? :` it is a branch of, and each earlier
 * `if (…) return` in the blocks around it, which it only runs past when false.
 */
export function conditionsAround(
  node: Node,
  stop: Node | undefined,
  /** Count earlier `if (…) return`s too; off inside a helper, where only its branches matter. */
  withExits = true,
): ScenarioCondition[] {
  const found: ScenarioCondition[] = [];
  let child: Node = node;
  for (let parent = node.getParent(); parent; child = parent, parent = parent.getParent()) {
    if (Node.isIfStatement(parent)) {
      if (child === parent.getThenStatement()) found.push(condition(parent.getExpression(), true));
      else if (child === parent.getElseStatement())
        found.push(condition(parent.getExpression(), false));
    } else if (Node.isConditionalExpression(parent)) {
      if (child === parent.getWhenTrue()) found.push(condition(parent.getCondition(), true));
      else if (child === parent.getWhenFalse()) found.push(condition(parent.getCondition(), false));
    } else if (withExits && Node.isBlock(parent)) {
      for (const statement of parent.getStatements()) {
        if (statement === child) break;
        if (
          Node.isIfStatement(statement) &&
          !statement.getElseStatement() &&
          exits(statement.getThenStatement())
        )
          found.push(condition(statement.getExpression(), false));
      }
    }
    if (parent === stop) break;
  }
  return found.reverse();
}

/** A branch that always leaves: `return …`, `throw …`, or a block ending in one. */
function exits(statement: Node): boolean {
  const leaves = (node: Node) =>
    Node.isReturnStatement(node) || Node.isThrowStatement(node) || Node.isContinueStatement(node);
  if (leaves(statement)) return true;
  if (!Node.isBlock(statement)) return false;
  const last = statement.getStatements().at(-1);
  return last !== undefined && leaves(last);
}

const CONDITIONS = new WeakMap<Node, Map<boolean, ScenarioCondition>>();

/** A condition, read once per node and side: phrasing it walks the variables it names. */
function condition(expression: Node, holds: boolean): ScenarioCondition {
  let sides = CONDITIONS.get(expression);
  if (!sides) CONDITIONS.set(expression, (sides = new Map()));
  const known = sides.get(holds);
  if (known) return known;
  const read = readCondition(expression, holds);
  sides.set(holds, read);
  return read;
}

function readCondition(expression: Node, holds: boolean): ScenarioCondition {
  let node = expression;
  for (;;) {
    if (Node.isParenthesizedExpression(node)) node = node.getExpression();
    else if (
      Node.isPrefixUnaryExpression(node) &&
      node.getOperatorToken() === SyntaxKind.ExclamationToken
    ) {
      holds = !holds;
      node = node.getOperand();
    } else break;
  }
  // `const existing = await findDuplicate(…)`: name the finder, so two checks by it agree.
  let from: string | undefined;
  if (Node.isIdentifier(node)) {
    const init = calledFor(node);
    if (init) from = init.getExpression().getText().split('.').pop();
  }
  // `parsed.success` where `const parsed = schema.safeParse(body)`.
  let checkedBy: string | undefined;
  if (Node.isPropertyAccessExpression(node) && node.getName() === 'success') {
    const init = calledFor(node.getExpression());
    if (init) {
      checkedBy = condense(init.getExpression().getText(), 60);
      from = checkedBy.split('.').pop();
    }
  }
  return {
    code: condense(node.getText(), 80),
    holds,
    words: phrase(node, holds),
    ...(from ? { from } : {}),
    ...(checkedBy ? { checkedBy } : {}),
  };
}

/**
 * The call a condition's variable holds: `verifyOtp(…)` for `ok` in
 * `const ok = await verifyOtp(…)`. Read from the declarations in scope, not the
 * type checker, which a file read on its own may not have.
 */
function calledFor(identifier: Node): CallExpression | undefined {
  if (!Node.isIdentifier(identifier)) return undefined;
  const fn = nearestFunction(identifier);
  let init = fn ? latestDeclared(fn, identifier) : undefined;
  if (init && Node.isAwaitExpression(init)) init = init.getExpression();
  return init && Node.isCallExpression(init) ? init : undefined;
}

function latestDeclared(fn: Node, identifier: Node): Node | undefined {
  const declaration = localVariable(fn, identifier.getText());
  return Node.isVariableDeclaration(declaration) ? declaration.getInitializer() : undefined;
}

function endsInContinue(statement: Node): boolean {
  if (Node.isContinueStatement(statement)) return true;
  const last = Node.isBlock(statement) ? statement.getStatements().at(-1) : undefined;
  return last !== undefined && Node.isContinueStatement(last);
}

/** Inside any `if` branch (or `? :` side) of a function: a write only some runs make. */
function underIf(node: Node, stop: Node): boolean {
  return innermostIf(node, stop) !== undefined;
}

/** The nearest `if` a node sits in, and on which side: `then` true for its first branch. */
function innermostIf(node: Node, stop: Node): { test: Node; then: boolean } | undefined {
  let child: Node = node;
  for (
    let parent = node.getParent();
    parent && parent !== stop;
    child = parent, parent = parent.getParent()
  ) {
    if (Node.isIfStatement(parent)) {
      if (child === parent.getThenStatement()) return { test: parent.getExpression(), then: true };
      if (child === parent.getElseStatement()) return { test: parent.getExpression(), then: false };
    }
  }
  return undefined;
}
