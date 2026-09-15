/**
 * Flowslens core.
 *
 * Flowslens answers one question about an unfamiliar codebase:
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

export {
  scan,
  type FlowslensConfig,
  // Re-exported on purpose, for callers who imported it at 1.0.
  type FlowLensConfig,
  type ScanResult,
  type ScanStats,
} from './scan.js';
export {
  analyzeFlowImpact,
  flowTiming,
  type FlowImpact,
  type FlowTiming,
  type SharedBy,
  type SharedStep,
  type StepTiming,
} from './flow/insight.js';
export {
  analyzeChanged,
  type AffectedFeature,
  type ChangeStatus,
  type ChangedInput,
  type ChangedReport,
} from './impact/changed.js';
export {
  flowApis,
  type ApiCallDetail,
  type ApiDataAccess,
  type ApiField,
  type ApiRoute,
  type FlowApis,
} from './flow/api.js';
export {
  checkFlowContract,
  type ContractCheck,
  type ContractField,
  type FlowContract,
} from './flow/contract.js';
export {
  indexTests,
  testFileName,
  testsForFlow,
  type FlowTests,
  type TestCase,
  type TestFile,
  type TestIndex,
} from './analyzer/testcoverage.js';
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
  STACK_ROLE_LABEL,
  STACK_ROLE_ORDER,
  detectStack,
  stackSummary,
  type StackEntry,
  type StackManifest,
  type StackReport,
  type StackRole,
} from './analyzer/stack.js';
export {
  MIDDLEWARE_LABEL,
  linkExpressMiddleware,
  linkNestMiddleware,
  type MiddlewareRole,
} from './analyzer/middleware.js';
export { EFFECT_LABEL, linkExternalEffects, type EffectKind } from './analyzer/effects.js';
export {
  PRISMA_OPERATIONS,
  clientProperty,
  isEmptyPrismaSchema,
  loadPrismaSchema,
  prismaEffectOf,
  prismaTableOf,
  type PrismaSchema,
} from './analyzer/prisma.js';
export {
  DEFAULT_ACTION_PROPS,
  DEFAULT_FRONTEND_CONFIG,
  DEFAULT_INPUT_ACTION_PROPS,
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
  isWhereFailure,
  parseLocation,
  resolveGraphFile,
  whereIs,
  type Location,
  type ResolvedFile,
  type WhereFailure,
  type WhereFlowHit,
  type WhereNode,
  type WhereOptions,
  type WhereReport,
} from './flow/where.js';
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
