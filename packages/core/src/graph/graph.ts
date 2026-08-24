import {
  type EdgeKind,
  type Evidence,
  type FlowEdge,
  type FlowNode,
  type GraphMeta,
  type NodeKind,
  type SerializedGraph,
  type SourceRef,
  LAYER_OF,
} from './types.js';

export interface AddNodeInput {
  id: string;
  kind: NodeKind;
  label: string;
  source?: SourceRef;
  evidence?: Evidence;
  meta?: Record<string, unknown>;
}

export interface AddEdgeInput {
  from: string;
  to: string;
  kind: EdgeKind;
  evidence?: Evidence;
  meta?: Record<string, unknown>;
}

const EVIDENCE_RANK: Record<Evidence, number> = { static: 0, runtime: 1, confirmed: 2 };

/**
 * An in-memory property graph with the few traversals FlowLens actually needs.
 *
 * Deliberately not a graph database: a scanned mid-size app produces thousands
 * (not millions) of nodes, and keeping it a plain object makes the whole graph
 * serialisable to `.flowlens/graph.json` — which is what the dashboard, the CLI
 * and future editor extensions all read.
 */
export class FlowGraph {
  readonly meta: GraphMeta;

  private readonly nodes = new Map<string, FlowNode>();
  private readonly edges = new Map<string, FlowEdge>();
  private readonly out = new Map<string, Set<string>>();
  private readonly incoming = new Map<string, Set<string>>();

  constructor(meta?: Partial<GraphMeta>) {
    this.meta = {
      root: meta?.root ?? '.',
      scannedAt: meta?.scannedAt ?? new Date().toISOString(),
      filesAnalyzed: meta?.filesAnalyzed ?? 0,
      version: meta?.version ?? 1,
      ...(meta?.projects ? { projects: meta.projects } : {}),
    };
  }

  /** Insert a node, or merge into the existing one with the same id. */
  addNode(input: AddNodeInput): FlowNode {
    const existing = this.nodes.get(input.id);
    if (existing) {
      if (input.source && !existing.source) existing.source = input.source;
      if (input.meta) existing.meta = { ...existing.meta, ...input.meta };
      existing.evidence = this.mergeEvidence(existing.evidence, input.evidence ?? 'static');
      return existing;
    }
    const node: FlowNode = {
      id: input.id,
      kind: input.kind,
      label: input.label,
      evidence: input.evidence ?? 'static',
      ...(input.source ? { source: input.source } : {}),
      ...(input.meta ? { meta: input.meta } : {}),
    };
    this.nodes.set(node.id, node);
    return node;
  }

  /**
   * Insert an edge. Edge identity is (from, kind, to), so re-discovering the
   * same relationship from a different analyzer is idempotent.
   */
  addEdge(input: AddEdgeInput): FlowEdge {
    const id = edgeId(input.from, input.kind, input.to);
    const existing = this.edges.get(id);
    if (existing) {
      if (input.meta) existing.meta = { ...existing.meta, ...input.meta };
      existing.evidence = this.mergeEvidence(existing.evidence, input.evidence ?? 'static');
      return existing;
    }
    const edge: FlowEdge = {
      id,
      from: input.from,
      to: input.to,
      kind: input.kind,
      evidence: input.evidence ?? 'static',
      ...(input.meta ? { meta: input.meta } : {}),
    };
    this.edges.set(id, edge);
    index(this.out, input.from, id);
    index(this.incoming, input.to, id);
    return edge;
  }

  /**
   * Static + runtime = confirmed. That upgrade is the whole reason the
   * dashboard can distinguish "these files look connected" from
   * "this exact path executed".
   */
  private mergeEvidence(current: Evidence, next: Evidence): Evidence {
    if (current === next) return current;
    if (
      (current === 'static' && next === 'runtime') ||
      (current === 'runtime' && next === 'static')
    ) {
      return 'confirmed';
    }
    return EVIDENCE_RANK[next] > EVIDENCE_RANK[current] ? next : current;
  }

  hasNode(id: string): boolean {
    return this.nodes.has(id);
  }

  /**
   * Remove a node and every edge touching it.
   *
   * Used to prune speculative nodes — an analyzer may declare a symbol before
   * it knows whether the symbol participates in a flow, and a graph full of
   * disconnected utility functions is harder to read than one without them.
   */
  removeNode(id: string): boolean {
    if (!this.nodes.has(id)) return false;
    for (const edge of [...this.edgesFrom(id), ...this.edgesTo(id)]) {
      this.edges.delete(edge.id);
      this.out.get(edge.from)?.delete(edge.id);
      this.incoming.get(edge.to)?.delete(edge.id);
    }
    this.out.delete(id);
    this.incoming.delete(id);
    return this.nodes.delete(id);
  }

  node(id: string): FlowNode | undefined {
    return this.nodes.get(id);
  }

  edge(id: string): FlowEdge | undefined {
    return this.edges.get(id);
  }

  allNodes(): FlowNode[] {
    return [...this.nodes.values()];
  }

  allEdges(): FlowEdge[] {
    return [...this.edges.values()];
  }

  get nodeCount(): number {
    return this.nodes.size;
  }

  get edgeCount(): number {
    return this.edges.size;
  }

  nodesOfKind(kind: NodeKind): FlowNode[] {
    return this.allNodes().filter((n) => n.kind === kind);
  }

  /** Outgoing edges, optionally filtered to a set of edge kinds. */
  edgesFrom(id: string, kinds?: readonly EdgeKind[]): FlowEdge[] {
    return this.resolve(this.out.get(id), kinds);
  }

  /** Incoming edges, optionally filtered to a set of edge kinds. */
  edgesTo(id: string, kinds?: readonly EdgeKind[]): FlowEdge[] {
    return this.resolve(this.incoming.get(id), kinds);
  }

  private resolve(ids: Set<string> | undefined, kinds?: readonly EdgeKind[]): FlowEdge[] {
    if (!ids) return [];
    const out: FlowEdge[] = [];
    for (const id of ids) {
      const edge = this.edges.get(id);
      if (edge && (!kinds || kinds.includes(edge.kind))) out.push(edge);
    }
    return out;
  }

  /** Direct successors of a node. */
  successors(id: string, kinds?: readonly EdgeKind[]): FlowNode[] {
    return dedupeNodes(this.edgesFrom(id, kinds).map((e) => this.nodes.get(e.to)));
  }

  /** Direct predecessors of a node. */
  predecessors(id: string, kinds?: readonly EdgeKind[]): FlowNode[] {
    return dedupeNodes(this.edgesTo(id, kinds).map((e) => this.nodes.get(e.from)));
  }

  /**
   * Everything reachable from `start`, breadth-first.
   * `direction: 'in'` answers the "who uses this?" question.
   */
  reachable(
    start: string,
    opts: { direction?: 'out' | 'in'; kinds?: readonly EdgeKind[]; maxDepth?: number } = {},
  ): Map<string, number> {
    const { direction = 'out', kinds, maxDepth = Infinity } = opts;
    const depths = new Map<string, number>();
    if (!this.nodes.has(start)) return depths;
    const queue: Array<[string, number]> = [[start, 0]];
    depths.set(start, 0);
    while (queue.length > 0) {
      const [id, depth] = queue.shift()!;
      if (depth >= maxDepth) continue;
      const next =
        direction === 'out'
          ? this.edgesFrom(id, kinds).map((e) => e.to)
          : this.edgesTo(id, kinds).map((e) => e.from);
      for (const nextId of next) {
        if (depths.has(nextId)) continue;
        depths.set(nextId, depth + 1);
        queue.push([nextId, depth + 1]);
      }
    }
    return depths;
  }

  /** Shortest path between two nodes, as node ids. Empty when unreachable. */
  path(from: string, to: string, kinds?: readonly EdgeKind[]): string[] {
    if (from === to) return this.nodes.has(from) ? [from] : [];
    const prev = new Map<string, string>();
    const seen = new Set<string>([from]);
    const queue = [from];
    while (queue.length > 0) {
      const id = queue.shift()!;
      for (const edge of this.edgesFrom(id, kinds)) {
        if (seen.has(edge.to)) continue;
        seen.add(edge.to);
        prev.set(edge.to, id);
        if (edge.to === to) {
          const path = [to];
          let cursor = to;
          while (prev.has(cursor)) {
            cursor = prev.get(cursor)!;
            path.unshift(cursor);
          }
          return path;
        }
        queue.push(edge.to);
      }
    }
    return [];
  }

  layerOf(id: string): string | undefined {
    const node = this.nodes.get(id);
    return node ? LAYER_OF[node.kind] : undefined;
  }

  toJSON(): SerializedGraph {
    return {
      meta: this.meta,
      nodes: this.allNodes(),
      edges: this.allEdges(),
    };
  }

  static fromJSON(data: SerializedGraph): FlowGraph {
    const graph = new FlowGraph(data.meta);
    for (const node of data.nodes) {
      graph.nodes.set(node.id, node);
    }
    for (const edge of data.edges) {
      graph.edges.set(edge.id, edge);
      index(graph.out, edge.from, edge.id);
      index(graph.incoming, edge.to, edge.id);
    }
    return graph;
  }

  /** Fold another graph into this one (used to merge per-project scans). */
  merge(other: FlowGraph): this {
    for (const node of other.allNodes()) this.addNode(node);
    for (const edge of other.allEdges()) this.addEdge(edge);
    this.meta.filesAnalyzed += other.meta.filesAnalyzed;
    return this;
  }
}

export function edgeId(from: string, kind: EdgeKind, to: string): string {
  return `${from}--${kind}-->${to}`;
}

function index(map: Map<string, Set<string>>, key: string, value: string): void {
  const set = map.get(key);
  if (set) set.add(value);
  else map.set(key, new Set([value]));
}

function dedupeNodes(nodes: Array<FlowNode | undefined>): FlowNode[] {
  const seen = new Map<string, FlowNode>();
  for (const node of nodes) {
    if (node) seen.set(node.id, node);
  }
  return [...seen.values()];
}
