import { existsSync, readFileSync } from 'node:fs';
import type { FlowGraph } from '../graph/graph.js';
import { pageRouteOf } from '../analyzer/screens.js';
import { SourceReader } from './actionsource.js';
import type { FeatureFlow } from './resolve.js';

/**
 * "Which page is this on?"
 *
 * The screen on a tile says where the code lives, which is not always where the
 * user meets it: `AddMedicineDialog` sits in `features/medicines/components/`,
 * and the only way to reach it is the *Add* button on `/medicines`. A list of
 * actions grouped by page has to answer the second question, so this walks up
 * from the component that owns an action — who renders `<AddMedicineDialog>`,
 * and who renders that — until it reaches a page or a layout file.
 *
 * The walk reads the JSX tag names in each file rather than the module graph.
 * That is the answer a developer grepping for `<AddMedicineDialog` would get,
 * and it stays one pass over the files however many actions there are. A
 * component rendered from two pages is on both, and is reported on both.
 */

export interface FlowPage {
  /** `/medicines/[id]`; `/` for the root page or a root layout. */
  route: string;
  /** The page (or layout) file the walk ended on. */
  file: string;
  /** A layout wraps every page under `route` rather than being one. */
  layout: boolean;
}

export interface FlowPagesOptions {
  /** Reuse a reader across requests (the server keeps one per scan). */
  reader?: SourceReader;
}

/** How many components up the walk goes before giving up. */
const MAX_DEPTH = 4;

const LAYOUT_FILE = /(?:^|\/)(?:layout|template|_app|_document)\.[cm]?[jt]sx?$/;

/** Every page each flow is reached from, keyed by flow id. Unplaced flows are absent. */
export function flowPages(
  graph: FlowGraph,
  flows: FeatureFlow[],
  options: FlowPagesOptions = {},
): Map<string, FlowPage[]> {
  const reader = options.reader ?? new SourceReader(graph);

  /** file -> components defined there; component name -> files rendering it. */
  const defined = new Map<string, Set<string>>();
  const renderedIn = new Map<string, Set<string>>();
  for (const node of graph.allNodes()) {
    if (node.kind !== 'component' || !node.source?.file) continue;
    add(defined, node.source.file, node.label);
  }
  for (const file of defined.keys()) {
    const path = reader.absolute(file);
    if (!path || !existsSync(path)) continue;
    let text: string;
    try {
      text = readFileSync(path, 'utf8');
    } catch {
      continue;
    }
    for (const match of text.matchAll(/<([A-Z][\w$]*)[\s/>]/g)) add(renderedIn, match[1]!, file);
  }

  const result = new Map<string, FlowPage[]>();
  for (const flow of flows) {
    const start = flow.steps[0]?.file;
    if (!start) continue;
    const pages = pagesAbove(start, flow.component, defined, renderedIn);
    if (pages.length > 0) result.set(flow.id, pages);
  }
  return result;
}

function pagesAbove(
  start: string,
  component: string | undefined,
  defined: Map<string, Set<string>>,
  renderedIn: Map<string, Set<string>>,
): FlowPage[] {
  const found = new Map<string, FlowPage>();
  const seen = new Set<string>([start]);
  let frontier = [start];
  for (let depth = 0; depth <= MAX_DEPTH && frontier.length > 0; depth++) {
    const next: string[] = [];
    for (const file of frontier) {
      const page = pageOf(file);
      if (page) {
        found.set(page.file, page);
        continue;
      }
      // The action's own component on the first hop; any component in the file
      // after that, since which one renders the child is not recorded.
      const names = depth === 0 && component ? [component] : [...(defined.get(file) ?? [])];
      for (const name of names) {
        for (const parent of renderedIn.get(name) ?? []) {
          if (seen.has(parent)) continue;
          seen.add(parent);
          next.push(parent);
        }
      }
    }
    frontier = next;
  }

  // A page is the more specific answer; a layout only when nothing else is.
  const all = [...found.values()];
  const pages = all.filter((page) => !page.layout);
  return (pages.length > 0 ? pages : all).sort((a, b) => a.route.localeCompare(b.route));
}

function pageOf(file: string): FlowPage | undefined {
  const route = pageRouteOf(file);
  if (route === undefined) return undefined;
  return { route: `/${route}`, file, layout: LAYOUT_FILE.test(file) };
}

function add(map: Map<string, Set<string>>, key: string, value: string): void {
  const set = map.get(key);
  if (set) set.add(value);
  else map.set(key, new Set([value]));
}
