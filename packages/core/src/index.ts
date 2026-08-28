/**
 * FlowLens core.
 *
 * FlowLens answers one question about an unfamiliar codebase:
 * "I clicked this button — show me everything that happened."
 *
 * Nothing in this package connects to a database or a running service. It
 * reads source files and, optionally, a trace file your own app wrote.
 */

export { FlowGraph, edgeId, type AddEdgeInput, type AddNodeInput } from './graph/graph.js';
export { ids, slug } from './graph/ids.js';
export {
  LAYER_OF,
  type EdgeKind,
  type Evidence,
  type FlowEdge,
  type FlowNode,
  type GraphMeta,
  type Layer,
  type NodeKind,
  type SerializedGraph,
  type SourceRef,
  type TimingStats,
} from './graph/types.js';

export { scan, type FlowLensConfig, type ScanResult, type ScanStats } from './scan.js';
export {
  CONFIG_FILENAMES,
  loadConfig,
  mergeConfig,
  type FileConfig,
  type LoadedConfig,
} from './config.js';
export {
  classifyFile,
  isFileSystemRoute,
  isFrontendCandidate,
  isServerCandidate,
  type Classification,
  type FileSide,
} from './analyzer/classify.js';
export {
  analyzeFileRoutes,
  routePathFromFile,
  type FileRouteConfig,
} from './analyzer/fileroutes.js';
export {
  detectProjects,
  loadProject,
  type LoadedProject,
  type ScanOptions,
} from './analyzer/project.js';
export {
  DEFAULT_FRONTEND_CONFIG,
  analyzeFrontend,
  humanizeHandler,
  isConcreteEndpoint,
  queryKeysOf,
  readHttpCall,
  type DetectedRequest,
  type FrontendConfig,
} from './analyzer/frontend.js';
export {
  DEFAULT_BACKEND_CONFIG,
  analyzeBackend,
  type BackendConfig,
  type BackendIndex,
} from './analyzer/backend.js';
export { collectConstants, emptyConstantTable, type ConstantTable } from './analyzer/constants.js';
export {
  TITLE_SEPARATOR,
  composeTitle,
  eventVerb,
  humanizeName,
  pageRouteOf,
  screenOf,
  type ScreenName,
} from './analyzer/screens.js';
export {
  DYNAMIC_MARKER,
  HTTP_METHODS,
  PARAM,
  bestRouteMatch,
  joinRoutePath,
  matchScore,
  normalizePath,
  routeMatches,
  type HttpMethod,
  type RouteLike,
} from './analyzer/http.js';
export {
  DB_EFFECT_LABEL,
  DB_EFFECT_ORDER,
  DB_OPERATIONS,
  collectionNameOf,
  dbAccessOf,
  dbEffectOf,
  pluralize,
  type DbAccess,
  type DbEffect,
} from './analyzer/mongo.js';
export { linkDataLineage, linkFrontendToBackend, type SeamResult } from './analyzer/seam.js';

export {
  EXECUTION_EDGES,
  resolveFlow,
  resolveFlows,
  scoreRisk,
  type CollectionAccess,
  type FeatureFlow,
  type FlowStep,
  type ResolveOptions,
  type RiskScore,
} from './flow/resolve.js';
export {
  renderFeatureDocument,
  renderFlowTree,
  renderTimings,
  stepTitle,
  type RenderOptions,
} from './flow/document.js';
export {
  ASCII_GLYPHS,
  UNICODE_GLYPHS,
  glyphsFor,
  preferAscii,
  type AsciiProbe,
  type Glyphs,
} from './ui/glyphs.js';

export {
  analyzeImpact,
  findBrokenCalls,
  findDeadEndpoints,
  findNodes,
  findSharedWrites,
  type Dependent,
  type ImpactReport,
} from './impact/impact.js';

export {
  TRACE_VERSION,
  groupTraces,
  parseTraceFile,
  type SpanKind,
  type TraceAttributes,
  type TraceEvent,
} from './runtime/trace.js';
export {
  SPAN_KINDS,
  mergeRuntimeTrace,
  type MergeOptions,
  type MergeResult,
} from './runtime/merge.js';
