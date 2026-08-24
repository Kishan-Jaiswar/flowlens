/**
 * The FlowLens graph vocabulary.
 *
 * The unit of the graph is not a *file*, it is a step in a *feature execution*:
 * a user action, the handler it triggers, the state it reads, the API it calls,
 * the controller that answers, the service that runs, the collection it touches.
 */

export type NodeKind =
  /** A clickable/submittable thing in the UI: "Submit Prescription". */
  | 'ui-action'
  /** A React component. */
  | 'component'
  /** An event handler or callback inside a component (handleSubmit). */
  | 'handler'
  /** A piece of frontend state (useState / useReducer field). */
  | 'state'
  /** A custom hook (useCreatePrescription). */
  | 'hook'
  /** An outbound HTTP call found in the frontend: POST /api/prescriptions. */
  | 'api-call'
  /** A backend route declaration: POST /prescriptions. */
  | 'route'
  /** A backend controller class. */
  | 'controller'
  /** A backend service/provider class. */
  | 'service'
  /** A method on a controller or service. */
  | 'method'
  /** A data model / schema (Mongoose model, DTO-backed entity). */
  | 'model'
  /** A physical database collection/table. */
  | 'collection'
  /** A concrete database operation: patients.insertOne. */
  | 'db-op'
  /** A request validation object (DTO). */
  | 'dto'
  /** A field on a model, DTO or payload — used for data lineage. */
  | 'field';

export type EdgeKind =
  /** component -> ui-action */
  | 'renders'
  /** ui-action -> handler */
  | 'triggers'
  /** handler -> state */
  | 'reads-state'
  /** handler -> state */
  | 'writes-state'
  /** generic code call: handler -> hook, controller.method -> service.method */
  | 'calls'
  /** handler|hook -> api-call */
  | 'requests'
  /** api-call -> route (the frontend/backend seam) */
  | 'handled-by'
  /** controller -> service (DI) */
  | 'injects'
  /** service.method -> db-op */
  | 'queries'
  /** db-op -> collection (read) */
  | 'reads'
  /** db-op -> collection (write) */
  | 'writes'
  /** container -> member: controller -> method, model -> field */
  | 'defines'
  /** route -> dto, dto -> field */
  | 'validates'
  /** field -> field: payload.name -> dto.name -> patients.name */
  | 'flows-to';

/** Which side of the app a node lives on. Drives the dashboard columns. */
export type Layer = 'ui' | 'frontend' | 'network' | 'backend' | 'data';

export const LAYER_OF: Record<NodeKind, Layer> = {
  'ui-action': 'ui',
  component: 'frontend',
  handler: 'frontend',
  state: 'frontend',
  hook: 'frontend',
  'api-call': 'network',
  route: 'network',
  controller: 'backend',
  service: 'backend',
  method: 'backend',
  dto: 'backend',
  model: 'data',
  'db-op': 'data',
  collection: 'data',
  field: 'data',
};

/** Where a node was found in source. */
export interface SourceRef {
  /** Path relative to the scanned project root, so graphs stay portable. */
  file: string;
  line: number;
  column?: number;
}

/**
 * Static analysis proves a path *can* exist. Runtime tracing proves it *did*.
 * Every node and edge carries this so the UI can say "confirmed" vs "inferred".
 */
export type Evidence = 'static' | 'runtime' | 'confirmed';

export interface FlowNode {
  id: string;
  kind: NodeKind;
  /** Human label shown in the graph: "Submit Prescription", "POST /patients". */
  label: string;
  source?: SourceRef;
  evidence: Evidence;
  /** How many times runtime tracing observed this node. */
  observations?: number;
  /** Aggregated runtime timings in ms. */
  timing?: TimingStats;
  /** Kind-specific extras (httpMethod, path, collection, operation, ...). */
  meta?: Record<string, unknown>;
}

export interface FlowEdge {
  id: string;
  from: string;
  to: string;
  kind: EdgeKind;
  evidence: Evidence;
  observations?: number;
  meta?: Record<string, unknown>;
}

/**
 * Observed durations for one node.
 *
 * Two measures, because they answer different questions:
 *
 * - *inclusive* (`avgMs`) — wall clock for this step and everything it called.
 *   "The request took 355ms."
 * - *exclusive* (`avgSelfMs`) — time spent in this step itself, with children
 *   subtracted. "82ms of that was the medicines query."
 *
 * Only exclusive times may be summed. Adding inclusive times across a nested
 * trace counts the same milliseconds once per level of nesting.
 */
export interface TimingStats {
  count: number;
  totalMs: number;
  minMs: number;
  maxMs: number;
  avgMs: number;
  /** Sum of exclusive time across observations. */
  selfTotalMs: number;
  /** Mean exclusive time. Safe to add up across a flow. */
  avgSelfMs: number;
}

export interface GraphMeta {
  /** Absolute root the scan ran against (informational only). */
  root: string;
  /** ISO timestamp of the scan. */
  scannedAt: string;
  filesAnalyzed: number;
  version: number;
  /** Detected sub-projects, e.g. { web: "web", api: "api" }. */
  projects?: Record<string, string>;
}

export interface SerializedGraph {
  meta: GraphMeta;
  nodes: FlowNode[];
  edges: FlowEdge[];
}
