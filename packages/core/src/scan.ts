import { basename } from 'node:path';
import { FlowGraph } from './graph/graph.js';
import { DEFAULT_BACKEND_CONFIG, analyzeBackend, type BackendConfig } from './analyzer/backend.js';
import {
  DEFAULT_FRONTEND_CONFIG,
  analyzeFrontend,
  type FrontendConfig,
} from './analyzer/frontend.js';
import { collectConstants, type ConstantTable } from './analyzer/constants.js';
import { analyzeFileRoutes } from './analyzer/fileroutes.js';
import { analyzeServerModules } from './analyzer/servermodules.js';
import { collectionAliasesOf } from './analyzer/dbaccess.js';
import { detectProjects, loadProject, type ScanOptions } from './analyzer/project.js';
import { linkDataLineage, linkFrontendToBackend, type SeamResult } from './analyzer/seam.js';

export interface FlowLensConfig
  extends
    Partial<Omit<FrontendConfig, 'resolveConstant'>>,
    Partial<Omit<BackendConfig, 'resolveConstant'>> {
  /** Directory names to skip in addition to the defaults. */
  ignore?: string[];
  includeTests?: boolean;
  /** Cap on files parsed, as a safety valve on very large trees. */
  maxFiles?: number;
  /**
   * Resolve URL constants (`url: getCustomersList`) to their literal value.
   * On by default — without it a codebase that keeps its endpoints in a
   * constants module looks like it makes no API calls at all.
   */
  resolveConstants?: boolean;
}

export interface ScanResult {
  graph: FlowGraph;
  seam: SeamResult;
  lineageLinks: number;
  stats: ScanStats;
  durationMs: number;
  /** Endpoint constants resolved from the project, for diagnostics. */
  constants: ConstantTable;
  /** Non-fatal problems: unreadable files, files that failed to analyze. */
  warnings: string[];
  /** Plain-language notes on what was found and what to try next. */
  diagnostics: string[];
}

export interface ScanStats {
  filesAnalyzed: number;
  components: number;
  uiActions: number;
  handlers: number;
  apiCalls: number;
  routes: number;
  controllers: number;
  services: number;
  collections: number;
  dbOperations: number;
  constantsResolved: number;
  /** Routes that came from file-system routing rather than decorators. */
  fileRoutes: number;
}

/**
 * Scan a project and produce the graph.
 *
 * Order matters: the frontend and backend passes each build their own island,
 * the seam pass joins them, and only then can lineage follow a field all the
 * way from a form input to a collection.
 */
export function scan(options: ScanOptions & FlowLensConfig): ScanResult {
  const startedAt = Date.now();
  const loaded = loadProject({
    root: options.root,
    ...(options.extraRoots ? { extraRoots: options.extraRoots } : {}),
    ...(options.ignore ? { ignore: options.ignore } : {}),
    ...(options.includeTests !== undefined ? { includeTests: options.includeTests } : {}),
    ...(options.maxFiles !== undefined ? { maxFiles: options.maxFiles } : {}),
  });

  // Endpoint constants must be collected before either analyzer runs: both the
  // frontend (`url: getCustomersList`) and the backend (`@Get(ROUTES.list)`) may
  // reference them.
  const constants = collectConstants(loaded);
  const resolveConstant =
    options.resolveConstants === false ? undefined : (name: string) => constants.resolve(name);

  const apiPrefixes = options.apiPrefixes ?? DEFAULT_FRONTEND_CONFIG.apiPrefixes;

  const requestFunctionPattern =
    options.requestFunctionPattern ?? DEFAULT_FRONTEND_CONFIG.requestFunctionPattern;
  /**
   * Validate the pattern once, here.
   *
   * A typo in `--request-fn` or in a config file otherwise fails inside the
   * per-file try/catch of every single file, and the scan reports zero API calls
   * with the real reason buried in warnings — which reads as "my project is
   * unsupported" rather than "you mistyped a regex".
   */
  try {
    new RegExp(requestFunctionPattern);
  } catch (error) {
    throw new Error(
      `FlowLens: requestFunctionPattern is not a valid regular expression: ` +
        `${requestFunctionPattern}\n  ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  const frontendConfig: FrontendConfig = {
    httpClients: options.httpClients ?? DEFAULT_FRONTEND_CONFIG.httpClients,
    apiPrefixes,
    requestFunctionPattern,
    urlKeys: options.urlKeys ?? DEFAULT_FRONTEND_CONFIG.urlKeys,
    suffixKeys: options.suffixKeys ?? DEFAULT_FRONTEND_CONFIG.suffixKeys,
    bodyKeys: options.bodyKeys ?? DEFAULT_FRONTEND_CONFIG.bodyKeys,
    ...(resolveConstant ? { resolveConstant } : {}),
  };

  const backendConfig: BackendConfig = {
    // The same list on both sides, or nothing ever matches.
    apiPrefixes,
    ...(resolveConstant ? { resolveConstant } : {}),
  };
  void DEFAULT_BACKEND_CONFIG;

  const graph = new FlowGraph({
    root: loaded.root,
    filesAnalyzed: loaded.sourceFiles.length,
    projects:
      loaded.roots.length > 1
        ? Object.fromEntries(loaded.roots.map((root) => [basename(root), root]))
        : detectProjects(loaded.root),
  });

  /**
   * Built before any query is linked, because the native-driver wrapper puts the
   * collection literals in a different file from the queries.
   */
  const collectionAliases = collectionAliasesOf(loaded);

  analyzeFrontend(loaded, graph, frontendConfig);
  analyzeBackend(loaded, graph, { ...backendConfig, collectionAliases });
  // File-system routes (Next.js `pages/api`, App Router, Nuxt) are a backend
  // with no controllers to find, so they need their own pass.
  const fileRoutes = analyzeFileRoutes(loaded, graph, { apiPrefixes, collectionAliases });
  /**
   * Plain modules holding the queries (`lib/db/store.ts`), which neither the
   * Nest pass nor the route pass reaches. Must run after `analyzeFileRoutes`,
   * because it joins the route handlers those declared to the module functions.
   */
  analyzeServerModules(loaded, graph, collectionAliases);
  const seam = linkFrontendToBackend(graph);
  const lineageLinks = linkDataLineage(graph);

  const stats: ScanStats = {
    filesAnalyzed: loaded.sourceFiles.length,
    components: graph.nodesOfKind('component').length,
    uiActions: graph.nodesOfKind('ui-action').length,
    handlers: graph.nodesOfKind('handler').length,
    apiCalls: graph.nodesOfKind('api-call').length,
    routes: graph.nodesOfKind('route').length,
    controllers: graph.nodesOfKind('controller').length,
    services: graph.nodesOfKind('service').length,
    collections: graph.nodesOfKind('collection').length,
    dbOperations: graph.nodesOfKind('db-op').length,
    constantsResolved: constants.values.size,
    fileRoutes,
  };

  return {
    graph,
    seam,
    lineageLinks,
    stats,
    durationMs: Date.now() - startedAt,
    constants,
    warnings: loaded.warnings,
    diagnostics: diagnose(stats, seam, loaded.unparsedFileTypes),
  };
}

/**
 * Explain a thin result.
 *
 * An empty graph is the one outcome a user cannot debug on their own — the tool
 * looks broken when it is usually pointed at the wrong directory, or at a stack
 * with a convention FlowLens has not been told about. Each message names the
 * next thing to try.
 */
function diagnose(
  stats: ScanStats,
  seam: SeamResult,
  unparsed: Record<string, number> = {},
): string[] {
  const notes: string[] = [];

  const unparsedSummary = Object.entries(unparsed)
    .sort((a, b) => b[1] - a[1])
    .map(([extension, count]) => `${count} ${extension}`)
    .join(', ');

  if (stats.filesAnalyzed === 0) {
    if (unparsedSummary) {
      // "No source files" is misleading when the project is simply written in
      // something FlowLens does not read yet.
      notes.push(
        `No JavaScript or TypeScript found, but this project contains ${unparsedSummary} ` +
          `— those are not parsed yet. FlowLens currently reads React/Next frontends and ` +
          `NestJS/Express backends.`,
      );
    } else {
      notes.push(
        'No source files found. Check the path, and note that node_modules, dist and build output are skipped.',
      );
    }
    return notes;
  }

  if (unparsedSummary) {
    notes.push(`Skipped ${unparsedSummary} — those file types are not parsed yet.`);
  }

  if (stats.components === 0 && stats.routes === 0) {
    notes.push(
      'No components and no routes. If this is a stack FlowLens does not read yet ' +
        '(Vue, Svelte, Django, Rails, Go), only the file walk will have worked.',
    );
  }

  if (stats.components > 0 && stats.routes === 0) {
    notes.push(
      'Frontend found, but no backend routes. Add the backend as a second path ' +
        '(`flowlens scan ./web ./api`) if it lives in another repository.',
    );
  }

  if (stats.routes > 0 && stats.components === 0) {
    notes.push(
      'Backend found, but no components. Add the frontend as a second path to see complete flows.',
    );
  }

  if (stats.apiCalls === 0 && stats.components > 0) {
    notes.push(
      'No API calls detected. If requests go through a house-built wrapper, describe it with ' +
        "--request-fn '<regex>' (capture group 1 = the HTTP verb), or name the client with --http-client.",
    );
  }

  if (stats.apiCalls > 0 && seam.matched === 0 && stats.routes > 0) {
    notes.push(
      'Calls and routes were both found but none matched. This is usually a URL prefix: ' +
        'check --api-prefix (it is stripped from both sides).',
    );
  }

  if (stats.collections === 0 && stats.routes > 0) {
    notes.push(
      'No collections found. FlowLens reads Mongoose schemas; other data layers are not modelled yet.',
    );
  }

  return notes;
}
