import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { FlowGraph } from '../graph/graph.js';
import { humanizeName, pageRouteOf } from '../analyzer/screens.js';
import { SourceReader } from './actionsource.js';
import { appNavigation, normalizeRoute, routeKey, type NavItem } from './navigation.js';
import {
  buildPageIndex,
  flowPages,
  pageTitle,
  pagesOfFile,
  resolveTag,
  type PageIndex,
} from './pages.js';
import type { FeatureFlow } from './resolve.js';
import { screenOutline, type OutlineNode } from './outline.js';

/**
 * The app's sidebar, copied, with every action in the app placed in it.
 *
 * {@link appNavigation} reads the menu; this fills it in. Each entry holds the
 * actions on the screen it opens, in the order the screen shows them — what
 * runs as it opens, then its controls from top to bottom — and the screens
 * that entry leads to are nested under it: `/medicines/[id]` under
 * *Medicines* because of its route, `/patient_detail/[id]` under *Home*
 * because a component on Home links to it.
 *
 * Parts drawn on every screen are listed once, where they sit: the menu's own
 * buttons ("+ Add Walk-In") at the top of the menu, a header or bottom bar in
 * one entry above it. Only a screen nothing links to, or an action no screen
 * renders, ends up in the entries at the bottom.
 */

export type SidebarEntryKind =
  'menu' | 'tab' | 'page' | 'auth' | 'sidebar' | 'layout' | 'section' | 'other';

export interface SidebarEntry {
  /** Unique within the tree: the labels from the top, joined. */
  key: string;
  label: string;
  kind: SidebarEntryKind;
  route?: string;
  /** The page or component file the entry stands for. */
  file?: string;
  /** Where a card or section is drawn in {@link file}. */
  line?: number;
  /** Flow ids directly in this entry, in the order they are listed. */
  actions: string[];
  /**
   * The screen top to bottom, when its JSX could be read: each action where
   * its control is, each card or section (a child entry, by key) where it is
   * drawn, and the links that leave for other screens.
   */
  items?: SidebarItem[];
  children: SidebarEntry[];
  /** Rows shown straight in the list, not in a fold: the menu's own buttons. */
  flat?: boolean;
  /**
   * The action that opens this part — "Download Report" for its popup. The
   * part is that feature: the action is its first item, and it is counted once.
   */
  openedBy?: string;
  /** One per item of a data list: the buttons on each row. */
  repeated?: boolean;
  /** Controls that change one thing together — a pager: one feature. */
  controls?: boolean;
  /** What one tab shows: its controls are the page's features, counted each. */
  tabContent?: boolean;
}

export type SidebarItem =
  | { action: string }
  | { section: string }
  | {
      link: {
        label?: string;
        to: string;
        href: string;
        repeated?: boolean;
        /** Where the link is written: what it shows is read from there. */
        file?: string;
        line?: number;
      };
    };

export interface AppSidebar {
  /** Where the copied menu is written. */
  file: string;
  line: number;
  entries: SidebarEntry[];
}

export interface AppSidebarOptions {
  reader?: SourceReader;
}

/** A part on at least this share of the screens is the app's frame, not a screen's. */
const LAYOUT_SHARE = 0.2;
/** How deep screens nest under the screens that open them. */
const MAX_NESTING = 4;

const LAYOUT_FILE = /(?:^|\/)(?:layout|template|_app|_document)\.[cm]?[jt]sx?$/;

interface Screen {
  route: string;
  key: string;
  file: string;
  title?: string;
}

export function appSidebar(
  graph: FlowGraph,
  all: FeatureFlow[],
  options: AppSidebarOptions = {},
): AppSidebar | undefined {
  // A form's own "Save" that only hands its values to the page: the page's
  // `<Form onSubmit>` is that click, with the request it makes.
  const outerOf = new Map(all.map((flow) => [flow.entryNodeId, flow] as const));
  // Hidden when the page's own action already sends everything it sends.
  const relayed = (flow: FeatureFlow): boolean => {
    const outers = (
      (graph.node(flow.entryNodeId)?.meta?.['relayedBy'] as string[] | undefined) ?? []
    )
      .map((id) => outerOf.get(id))
      .filter((outer): outer is FeatureFlow => outer !== undefined);
    if (outers.length === 0) return false;
    return outers.some((outer) =>
      flow.endpoints.every((endpoint) => outer.endpoints.includes(endpoint)),
    );
  };
  const flows = all.filter((flow) => !isFieldEdit(flow) && !relayed(flow));
  const reader = options.reader ?? new SourceReader(graph);
  const nav = appNavigation(graph, { reader });
  if (!nav) return undefined;
  const index = buildPageIndex(graph, reader);
  const reached = new Map<string, Set<string>>();
  const pagesByFlow = flowPages(graph, flows, { index, reached });
  const order = new SequenceOrder(index);
  const links = new NavigationLinks(index, reader);

  const screens = new Map<string, Screen>();
  for (const file of index.defined.keys()) {
    const raw = pageRouteOf(file);
    if (raw === undefined || LAYOUT_FILE.test(file)) continue;
    const route = normalizeRoute(raw);
    const key = routeKey(route);
    if (screens.has(key)) continue;
    const title = pageTitle(index.texts.get(file) ?? '');
    screens.set(key, { route, key, file, ...(title ? { title } : {}) });
  }
  const frameShare = Math.max(4, Math.ceil(screens.size * LAYOUT_SHARE));

  /** Where each flow goes: the menu itself, the frame, a screen, or nowhere. */
  const sidebarFlows: FeatureFlow[] = [];
  const layoutFlows: FeatureFlow[] = [];
  const otherFlows: FeatureFlow[] = [];
  const byScreen = new Map<string, FeatureFlow[]>();
  for (const flow of flows) {
    const pages = pagesByFlow.get(flow.id) ?? [];
    const onScreens = pages.filter((page) => !page.layout);
    /**
     * A shared widget's own mechanics — the dropdown that opens its list on
     * every page with a select — are not a feature of any of those pages: no
     * request, nothing the page handed it, drawn on several screens.
     */
    const widget =
      !flow.hitsBackend &&
      flow.event !== 'mount' &&
      onScreens.length >= 2 &&
      // On most pages but through no layout: a widget used everywhere (a
      // select's own list), not the header drawn around every page.
      (onScreens.length < frameShare || !pages.some((page) => page.layout)) &&
      !onScreens.some((page) => page.file === flow.steps[0]?.file) &&
      !flow.steps.some((step) => step.kind === 'handler' && step.meta?.['callsProps']);
    if (widget) continue;
    if (reached.get(flow.id)?.has(nav.file)) sidebarFlows.push(flow);
    else if (onScreens.length >= frameShare || (pages.length > 0 && onScreens.length === 0)) {
      layoutFlows.push(flow);
    } else if (onScreens.length === 0) {
      // Seen only while the app ran: a browser loading `/settings` is the
      // Settings screen opening.
      const screen = flow.source ? undefined : screenOfRequest(flow, screens);
      if (screen) byScreen.set(screen, [...(byScreen.get(screen) ?? []), flow]);
      else otherFlows.push(flow);
    } else {
      for (const page of onScreens) {
        const key = routeKey(page.route);
        byScreen.set(key, [...(byScreen.get(key) ?? []), flow]);
      }
    }
  }

  // The screens the menu and the sign-in pages open themselves.
  const placed = new Set<string>();
  const markPlaced = (items: NavItem[]) => {
    for (const item of items) {
      if (item.route && !item.component) placed.add(routeKey(item.route));
      markPlaced(item.children);
    }
  };
  markPlaced(nav.items);
  markPlaced(nav.auth);
  // A tab's page is opened by its menu entry even when the entry has no link.
  for (const item of nav.items) {
    if (item.route) placed.add(routeKey(item.route));
  }

  /** Every other screen, and what opens it: a screen's key, or the frame. */
  const openers = new Map<string, Set<string>>();
  /** A linking file's own place: the menu, the frame, or the screens it is on. */
  const placeOf = new Map<string, string[]>();
  const placeOfFile = (file: string): string[] => {
    let place = placeOf.get(file);
    if (!place) {
      const seen = new Set<string>();
      const pages = pagesOfFile(index, file, undefined, seen).filter((page) => !page.layout);
      place =
        file === nav.file || seen.has(nav.file)
          ? [SIDEBAR]
          : pages.length >= frameShare
            ? [LAYOUT]
            : pages.map((page) => routeKey(page.route));
      placeOf.set(file, place);
    }
    return place;
  };
  // The nearest screen above in the URL — `/medicines/[id]` for its `/edit` —
  // whether the menu opens it or it is nested itself.
  const ancestors = [...new Set([...placed, ...screens.keys()])].sort(
    (a, b) => b.length - a.length,
  );
  for (const screen of screens.values()) {
    if (placed.has(screen.key) || screen.key === '/') continue;
    const set = new Set<string>();
    const parent = ancestors.find((route) => route !== '/' && screen.key.startsWith(`${route}/`));
    if (parent) set.add(parent);
    else {
      for (const file of linkingFiles(screen, links)) {
        for (const place of placeOfFile(file)) if (place !== screen.key) set.add(place);
      }
    }
    openers.set(screen.key, set);
  }
  const openedBy = (key: string) =>
    [...openers]
      .filter(([, from]) => from.has(key))
      .map(([screenKey]) => screens.get(screenKey)!)
      .sort((a, b) => a.route.localeCompare(b.route));

  /**
   * Each screen's main place: the opener closest to the menu, found breadth
   * first from the menu's entries. A screen is listed under every screen that
   * opens it, but what it leads to in turn is spelled out only at its main
   * place — repeating whole branches under each opener made the list endless.
   */
  const primary = new Map<string, string>();
  const spread = (roots: string[]) => {
    let frontier = roots;
    for (let depth = 0; depth < MAX_NESTING && frontier.length > 0; depth++) {
      const next: string[] = [];
      for (const parent of frontier) {
        for (const child of openedBy(parent)) {
          if (placed.has(child.key) || primary.has(child.key) || roots.includes(child.key))
            continue;
          primary.set(child.key, parent);
          next.push(child.key);
        }
      }
      frontier = next;
    }
  };
  const menuRoots: string[] = [];
  const collectRoots = (items: NavItem[]) => {
    for (const item of items) {
      if (item.route && !item.component) menuRoots.push(routeKey(item.route));
      else if (item.route && !menuRoots.includes(routeKey(item.route))) {
        menuRoots.push(routeKey(item.route));
      }
      collectRoots(item.children);
    }
  };
  collectRoots(nav.items);
  collectRoots(nav.auth);
  spread([...new Set(menuRoots), SIDEBAR, LAYOUT]);
  // Screens nothing reaches start branches of their own, at the bottom.
  const unreached = [...screens.values()]
    .filter((screen) => !placed.has(screen.key) && !primary.has(screen.key))
    .sort((a, b) => a.route.localeCompare(b.route));
  spread(unreached.map((screen) => screen.key));
  const unreachedRoots = unreached.filter((screen) => !primary.has(screen.key));

  /**
   * A screen's entry contents, read off its outline: the loads of each
   * component where it is drawn, each control's actions where the control is,
   * cards as child entries. What the walk could not place — a popup opened by
   * state, a handler in a helper — follows at the end, in source order.
   */
  /** One reading per screen, however many places it is listed. */
  const outlines = new Map<string, OutlineNode[]>();
  const laidOut = (
    here: FeatureFlow[],
    file: string | undefined,
    component: string | undefined,
    key: string,
  ): { actions: string[]; items?: SidebarItem[]; sections: SidebarEntry[] } => {
    const outlineKey = `${file}#${component ?? ''}`;
    let nodes = outlines.get(outlineKey);
    if (!nodes) {
      nodes = file ? screenOutline(reader, file, component) : [];
      outlines.set(outlineKey, nodes);
    }
    if (nodes.length === 0) return { actions: order.sorted(here, file), sections: [] };
    const assigned = new Set<string>();
    const keys = new Set<string>();
    const opening = new Map<string, { when: string; untitled: boolean }>();
    const byId = new Map(here.map((flow) => [flow.id, flow] as const));
    const take = (flows: FeatureFlow[]) => {
      const ids = order.sorted(flows.filter((flow) => !assigned.has(flow.id)));
      for (const id of ids) assigned.add(id);
      return ids;
    };
    const build = (list: OutlineNode[], path: string) => {
      const items: SidebarItem[] = [];
      const actions: string[] = [];
      const sections: SidebarEntry[] = [];
      const add = (ids: string[]) => {
        actions.push(...ids);
        items.push(...ids.map((action) => ({ action })));
      };
      for (const node of list) {
        if (node.type === 'component') {
          add(
            take(
              here.filter(
                (flow) =>
                  flow.event === 'mount' &&
                  fileOf(flow) === node.file &&
                  (!node.name || !flow.component || flow.component === node.name),
              ),
            ),
          );
        } else if (node.type === 'handler') {
          add(
            take(
              here.filter(
                (flow) =>
                  flow.event !== 'mount' &&
                  fileOf(flow) === node.file &&
                  lineOf(flow) >= node.start &&
                  lineOf(flow) <= node.end &&
                  // A shared pager's copy for the stock page is not the import list's.
                  (siteOf(flow) === undefined ||
                    node.site === undefined ||
                    siteOf(flow) === node.site),
              ),
            ),
          );
        } else if (node.type === 'link') {
          const { label, to, href, repeated, file: at, line } = node;
          items.push({
            link: {
              to,
              href,
              ...(label ? { label } : {}),
              ...(repeated ? { repeated } : {}),
              file: at,
              line,
            },
          });
        } else {
          let sectionKey = `${path}/§${node.label}`;
          for (let n = 2; keys.has(sectionKey); n++) sectionKey = `${path}/§${node.label} ${n}`;
          keys.add(sectionKey);
          const inner = build(node.children, sectionKey);
          const entry: SidebarEntry = {
            key: sectionKey,
            label: node.label,
            kind: 'section',
            file: node.file,
            line: node.line,
            actions: inner.actions,
            items: inner.items,
            children: inner.sections,
            ...(node.repeated ? { repeated: true } : {}),
            ...(node.tabContent ? { tabContent: true } : {}),
          };
          if (node.opensWhen)
            opening.set(sectionKey, { when: node.opensWhen, untitled: !!node.untitled });
          sections.push(entry);
          items.push({ section: sectionKey });
        }
      }
      attachOpeners(items, actions, sections);
      mergeRepeated(items, sections);
      dropTwins(sections);
      groupSiblings(items, actions, sections, path);
      // A popup with nothing in it — a dropdown's portal, a modal whose controls
      // are counted elsewhere — is not a part of the page to list.
      const empty = (entry: SidebarEntry): boolean =>
        entry.actions.length === 0 &&
        !(entry.items ?? []).some((item) => 'link' in item) &&
        entry.children.every(empty);
      for (const section of [...sections]) {
        if (!opening.has(section.key) || section.openedBy || !empty(section)) continue;
        sections.splice(sections.indexOf(section), 1);
        const at = items.findIndex((item) => 'section' in item && item.section === section.key);
        if (at >= 0) items.splice(at, 1);
      }
      return { items, actions, sections };
    };
    /**
     * The same list drawn twice — a table on a desktop, cards on a phone — has
     * one set of row actions: "Each row", once.
     */
    const mergeRepeated = (items: SidebarItem[], sections: SidebarEntry[]) => {
      for (const section of [...sections]) {
        if (!section.repeated || !sections.includes(section)) continue;
        const twin = sections.find(
          (other) => other !== section && other.repeated && other.label === section.label,
        );
        if (!twin) continue;
        const labels = new Set(
          twin.actions.map((id) => byId.get(id)?.label).filter((label): label is string => !!label),
        );
        // Actions the twin already has, by name, are the same controls.
        const extra = section.actions.filter((id) => !labels.has(byId.get(id)?.label ?? ''));
        twin.actions.push(...extra);
        twin.items = [...(twin.items ?? []), ...extra.map((action) => ({ action }))];
        twin.children.push(
          ...section.children.filter(
            (child) => !twin.children.some((own) => own.label === child.label),
          ),
        );
        sections.splice(sections.indexOf(section), 1);
        const at = items.findIndex((item) => 'section' in item && item.section === section.key);
        if (at >= 0) items.splice(at, 1);
      }
    };
    /**
     * Controls side by side that all change one thing — Previous, the page
     * numbers and Next all set `page` — are one feature, "Previous / Go to page
     * / Next", not three.
     */
    const groupSiblings = (
      items: SidebarItem[],
      actions: string[],
      sections: SidebarEntry[],
      path: string,
    ) => {
      const soleState = (id: string): string | undefined => {
        const flow = byId.get(id);
        if (!flow || flow.event === 'mount') return undefined;
        // The click's own handler: what the list reloading then sets is not it.
        // A shared pager sets the page through what the page passed it.
        const own = flow.steps.find((step) => step.kind === 'handler');
        if (!own) return undefined;
        // Which state, of which component: two lists' `page` are two pagers.
        const written = graph
          .edgesFrom(own.nodeId, ['writes-state'])
          .map((edge) => edge.to)
          .filter((id, index, list) => list.indexOf(id) === index);
        const label = written.length === 1 ? (graph.node(written[0]!)?.label ?? '') : '';
        // A pager or a stepper: `setPage`, `setStep`, `setActiveTab`.
        return label && /page|step|tab/i.test(label) ? written[0] : undefined;
      };
      // Every control on this level that changes the same pager state, wherever
      // it sits in the list: the group stands where the first of them is.
      const groups = new Map<string, string[]>();
      for (const item of items) {
        if (!('action' in item)) continue;
        const state = soleState(item.action);
        if (state) groups.set(state, [...(groups.get(state) ?? []), item.action]);
      }
      const used = new Set<string>();
      for (const run of groups.values()) {
        if (run.length < 2) continue;
        let label = [...new Set(run.map((id) => byId.get(id)?.label ?? id))].join(' / ');
        // Two pagers on one screen: say whose.
        if (used.has(label)) label = `${label} (${byId.get(run[0]!)?.screen ?? 'second list'})`;
        used.add(label);
        let key = `${path}/§${label}`;
        for (let n = 2; keys.has(key); n++) key = `${path}/§${label} ${n}`;
        keys.add(key);
        sections.push({
          key,
          label,
          kind: 'section',
          actions: run,
          items: run.map((action) => ({ action })),
          children: [],
          controls: true,
        });
        const first = items.findIndex((item) => 'action' in item && item.action === run[0]);
        for (const id of run) actions.splice(actions.indexOf(id), 1);
        const kept = items.filter((item) => !('action' in item) || !run.includes(item.action));
        kept.splice(Math.min(first, kept.length), 0, { section: key });
        items.splice(0, items.length, ...kept);
      }
    };
    /**
     * A popup is the feature of the button that opens it: "Download Report" and
     * its dates, Download and Close are one thing on the page, not five. The
     * opener moves into the popup's part, first, and names it when it has no
     * title; found at this level, or on the row that holds it ("View Invoice").
     */
    /**
     * A list drawn twice — cards on a phone, a table on a desktop — becomes one
     * "Each row" after its buttons were placed: the other copy's "Update stock"
     * is the popup this row already lists.
     */
    const dropTwins = (sections: SidebarEntry[]): void => {
      for (const entry of sections) {
        for (const child of entry.children) {
          const when = child.openedBy ? opening.get(child.key)?.when : undefined;
          if (!when) continue;
          for (const twin of entry.actions.filter((id) => opensPart(byId.get(id), when))) {
            entry.actions.splice(entry.actions.indexOf(twin), 1);
            const index = (entry.items ?? []).findIndex(
              (item) => 'action' in item && item.action === twin,
            );
            if (index >= 0) entry.items!.splice(index, 1);
          }
        }
        dropTwins(entry.children);
      }
    };
    const attachOpeners = (items: SidebarItem[], actions: string[], sections: SidebarEntry[]) => {
      for (const section of [...sections]) {
        const open = opening.get(section.key);
        if (!open) continue;
        const holders: Array<{ items: SidebarItem[]; actions: string[]; entry?: SidebarEntry }> = [
          { items, actions },
          ...sections
            .filter((other) => other !== section)
            .map((other) => ({ items: other.items ?? [], actions: other.actions, entry: other })),
        ];
        for (const holder of holders) {
          const opener = holder.actions.find((id) => opensPart(byId.get(id), open.when));
          if (!opener) continue;
          holder.actions.splice(holder.actions.indexOf(opener), 1);
          // The row's other button for the same popup — the mobile copy of a
          // desktop one — is the same feature: listed once, by the popup.
          for (const twin of holder.actions.filter((id) => opensPart(byId.get(id), open.when))) {
            holder.actions.splice(holder.actions.indexOf(twin), 1);
            const index = holder.items.findIndex(
              (item) => 'action' in item && item.action === twin,
            );
            if (index >= 0) holder.items.splice(index, 1);
          }
          const at = holder.items.findIndex((item) => 'action' in item && item.action === opener);
          if (holder.entry) {
            // On a row: the popup belongs to that row, where its button is.
            sections.splice(sections.indexOf(section), 1);
            const here = items.findIndex(
              (item) => 'section' in item && item.section === section.key,
            );
            if (here >= 0) items.splice(here, 1);
            holder.entry.children.push(section);
            if (at >= 0) holder.items.splice(at, 1, { section: section.key });
          } else if (at >= 0) {
            // Where the button is: the part takes its place in the page's order.
            holder.items.splice(at, 1);
            const here = items.findIndex(
              (item) => 'section' in item && item.section === section.key,
            );
            if (here >= 0) items.splice(here, 1);
            items.splice(Math.min(at, items.length), 0, { section: section.key });
          }
          section.actions.unshift(opener);
          section.items = [{ action: opener }, ...(section.items ?? [])];
          section.openedBy = opener;
          if (open.untitled) section.label = byId.get(opener)?.label ?? section.label;
          // A dialog component whose body is one titled part: one part, not
          // "Add medicine" inside "Add medicine".
          if (section.children.length === 1 && section.children[0]!.kind === 'section') {
            const only = section.children[0]!;
            const at = (section.items ?? []).findIndex(
              (item) => 'section' in item && item.section === only.key,
            );
            section.items!.splice(
              at < 0 ? section.items!.length : at,
              at < 0 ? 0 : 1,
              ...(only.items ?? only.actions.map((action) => ({ action }))),
            );
            section.actions.push(...only.actions);
            section.children = only.children;
            if (open.untitled) section.label = only.label;
          }
          break;
        }
      }
    };
    const top = build(nodes, key);
    const rest = take(here);
    top.actions.push(...rest);
    top.items.push(...rest.map((action) => ({ action })));
    return top;
  };

  const screenEntry = (
    screen: Screen,
    path: string,
    expand: boolean,
    trail: string[] = [],
  ): SidebarEntry => {
    const key = `${path}/${screen.route}`;
    const layout = laidOut(byScreen.get(screen.key) ?? [], screen.file, undefined, key);
    return {
      key,
      label: screen.title ?? screenName(screen.route),
      kind: 'page',
      route: screen.route,
      file: screen.file,
      actions: layout.actions,
      ...(layout.items ? { items: layout.items } : {}),
      children: [...layout.sections, ...(expand ? childScreens(screen.key, key, trail) : [])],
    };
  };
  /** A link back up the branch — "back to patient" — is not a screen it leads to. */
  const childScreens = (parentKey: string, path: string, trail: string[] = []): SidebarEntry[] => {
    const above = [...trail, parentKey];
    return openedBy(parentKey)
      .filter((screen) => !placed.has(screen.key) && !above.includes(screen.key))
      .map((screen) => screenEntry(screen, path, primary.get(screen.key) === parentKey, above));
  };

  const menuEntry = (item: NavItem, path: string, auth = false): SidebarEntry => {
    const key = `${path}/${item.label}`;
    const children = item.children.map((child) => menuEntry(child, key));
    const claimed = new Set(children.flatMap(allActions));
    const screen = item.route ? screens.get(routeKey(item.route)) : undefined;
    const onScreen = item.route ? (byScreen.get(routeKey(item.route)) ?? []) : [];
    const componentFile = item.component?.file;
    const own = componentFile
      ? onScreen.filter((flow) => reached.get(flow.id)?.has(componentFile))
      : onScreen.filter((flow) => !claimed.has(flow.id));
    const pages = item.route && !item.component ? childScreens(routeKey(item.route), key) : [];
    const layout = laidOut(own, componentFile ?? screen?.file, item.component?.name, key);
    return {
      key,
      label: item.label,
      kind: auth ? 'auth' : componentFile ? 'tab' : 'menu',
      ...(item.route ? { route: item.route } : {}),
      ...((componentFile ?? screen?.file) ? { file: componentFile ?? screen?.file } : {}),
      actions: layout.actions,
      ...(layout.items ? { items: layout.items } : {}),
      children: [...children, ...layout.sections, ...pages],
    };
  };

  const entries: SidebarEntry[] = [];
  entries.push(...nav.auth.map((item) => menuEntry(item, 'nav:auth', true)));
  if (layoutFlows.length > 0 || openedBy(LAYOUT).length > 0) {
    entries.push({
      key: 'nav:layout',
      label: 'Header & layout',
      kind: 'layout',
      actions: order.sorted(layoutFlows),
      children: childScreens(LAYOUT, 'nav:layout'),
    });
  }
  entries.push(...sidebarEntries(sidebarFlows, nav.file, order));
  const fromSidebar = childScreens(SIDEBAR, 'nav:sidebar');
  if (fromSidebar.length > 0) {
    entries.push({
      key: 'nav:sidebar/opens',
      label: 'Opened from the menu',
      kind: 'sidebar',
      actions: [],
      children: fromSidebar,
    });
  }
  entries.push(...nav.items.map((item) => menuEntry(item, 'nav:menu')));

  // Screens nothing links to, each with what it leads to in turn.
  const others = unreachedRoots.map((screen) => screenEntry(screen, 'nav:other', true));
  if (others.length > 0 || otherFlows.length > 0) {
    entries.push({
      key: 'nav:other',
      label: 'Other screens',
      kind: 'other',
      actions: order.sorted(otherFlows),
      children: others,
    });
  }
  return { file: nav.file, line: nav.line, entries };
}

/**
 * Does this action open the part drawn while `when` holds? It sets one of the
 * states the condition reads to something that is not false: `setOpenX(true)`,
 * `setViewBill(bill)` — not `setOpenX(false)`, which closes it.
 */
function opensPart(flow: FeatureFlow | undefined, when: string): boolean {
  if (!flow || flow.event === 'mount') return false;
  const names = new Set(
    // `!!adjustTarget` is `adjustTarget`.
    [...when.replace(/!!/g, '').matchAll(/(!?)\s*\b([A-Za-z_$][\w$]*)\b/g)]
      .filter((match) => match[1] !== '!')
      .map((match) => match[2]!),
  );
  for (const step of flow.steps) {
    if (step.kind !== 'handler') continue;
    const sets = step.meta?.['sets'] as Record<string, string[]> | undefined;
    for (const [setter, values] of Object.entries(sets ?? {})) {
      const state = setter.charAt(3).toLowerCase() + setter.slice(4);
      if (!names.has(state)) continue;
      if (values.some((value) => !/^#(false|null|undefined|0)$/.test(value) && value !== ''))
        return true;
    }
  }
  return false;
}

/**
 * Typing in a field, ticking a box, moving focus: filling a form in, not an
 * action of its own. Listed, a login page of two buttons read as four rows —
 * "9876543210" and "Form change" beside "Send OTP". The form's submit already
 * says what is filled in. A field that calls the backend as it changes — a
 * search box, a filter that refetches — does something, and stays.
 */
const FIELD_EVENT =
  /^on(?:Change|Input|KeyDown|KeyUp|KeyPress|Focus|Blur|Select|Paste|ValueChange|CheckedChange)$/;

export function isFieldEdit(flow: FeatureFlow): boolean {
  return !!flow.event && FIELD_EVENT.test(flow.event) && flow.endpoints.length === 0;
}

const SIDEBAR = '#sidebar';
const LAYOUT = '#layout';

/**
 * The menu's own actions: its buttons as rows at the top, then one fold per
 * part it opens — the walk-in form behind "+ Add Walk-In".
 */
function sidebarEntries(
  flows: FeatureFlow[],
  navFile: string,
  order: SequenceOrder,
): SidebarEntry[] {
  if (flows.length === 0) return [];
  const own = flows.filter((flow) => fileOf(flow) === navFile);
  const byFile = new Map<string, FeatureFlow[]>();
  for (const flow of flows) {
    const file = fileOf(flow);
    if (!file || file === navFile) continue;
    byFile.set(file, [...(byFile.get(file) ?? []), flow]);
  }
  const entries: SidebarEntry[] = [];
  if (own.length > 0) {
    entries.push({
      key: 'nav:sidebar',
      label: 'Menu',
      kind: 'sidebar',
      file: navFile,
      actions: order.sorted(own, navFile),
      children: [],
      flat: true,
    });
  }
  const parts = [...byFile].sort((a, b) =>
    compareKeys(order.keyOf(a[0], navFile), order.keyOf(b[0], navFile)),
  );
  for (const [file, partFlows] of parts) {
    const name = partFlows.find((flow) => flow.component)?.component ?? baseName(file);
    entries.push({
      key: `nav:sidebar/${file}`,
      label: humanizeName(name),
      kind: 'sidebar',
      file,
      actions: order.sorted(partFlows, navFile),
      children: [],
    });
  }
  return entries;
}

/**
 * The files that send the user to a screen: its route in a navigation —
 * `router.push("/patient_detail/" + id)`, `<Link href="/medicines/new">`.
 * Read up to the first parameter, since the rest is built at runtime.
 */
function linkingFiles(screen: Screen, links: NavigationLinks): string[] {
  const segments: string[] = [];
  for (const segment of screen.route.split('/').filter(Boolean)) {
    if (/^\[.*\]$/.test(segment)) break;
    segments.push(segment);
  }
  if (segments.length === 0) return [];
  const prefix = `/${segments.join('/')}`;
  const files: string[] = [];
  for (const [file, targets] of links.all()) {
    if (file === screen.file) continue;
    if (
      targets.some(
        (target) =>
          target === prefix ||
          (/^[/?#]/.test(target.slice(prefix.length)) && target.startsWith(prefix)),
      )
    ) {
      files.push(file);
    }
  }
  return files;
}

/** `router.push(`, `navigate(`, `href=`, `to=`, `location.href =`: where a link's address is written. */
const NAVIGATION =
  /(?:\.(?:push|replace)|\bnavigate|\bredirect|\bpermanentRedirect)\s*\(|\b(?:href|to)\s*=\s*\{?|\blocation(?:\.href)?\s*=(?!=)/g;

/**
 * Where each file sends the user, read from its navigation calls.
 *
 * The address is put back together from what it is written with: string
 * pieces, template literals, and constants — `"/" + EDIT_APPOINTMENT` is
 * `/edit-appointment` when `constant.js` says so. Only a navigation counts:
 * `axios.get("/clinic/1")` is a request to the API, not a link to `/clinic`.
 * A relative `router.push("import-contacts")` is read from the root, the way
 * these apps write it.
 */
class NavigationLinks {
  private targets?: Map<string, string[]>;
  private readonly constants = new Map<string, Map<string, string>>();

  constructor(
    private readonly index: PageIndex,
    private readonly reader: SourceReader,
  ) {}

  all(): Map<string, string[]> {
    if (this.targets) return this.targets;
    this.targets = new Map();
    for (const [file, text] of this.index.texts) {
      const found: string[] = [];
      for (const match of text.matchAll(NAVIGATION)) {
        const target = this.address(
          file,
          text.slice(match.index + match[0].length, match.index + match[0].length + 240),
        );
        if (target) found.push(target);
      }
      if (found.length > 0) this.targets.set(file, found);
    }
    return this.targets;
  }

  /** The address an argument spells, up to the first piece known only at runtime. */
  private address(file: string, argument: string): string | undefined {
    let text = '';
    let rest = argument.trimStart();
    for (let guard = 0; guard < 12 && rest.length > 0; guard++) {
      const literal = /^(['"])((?:\\.|(?!\1)[^\\\n])*)\1/.exec(rest);
      const template = /^`([^`]*)`/.exec(rest);
      const name = /^([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*)/.exec(rest);
      if (literal) {
        text += literal[2];
        rest = rest.slice(literal[0].length);
      } else if (template) {
        const [head, ...spans] = template[1]!.split('${');
        text += head;
        for (const span of spans) {
          const close = span.indexOf('}');
          const value = this.constant(file, span.slice(0, close).trim());
          if (value === undefined) return finish(`${text}[param]`);
          text += value + span.slice(close + 1);
        }
        rest = rest.slice(template[0].length);
      } else if (name) {
        const value = this.constant(file, name[1]!);
        if (value === undefined) return text ? finish(`${text}[param]`) : undefined;
        text += value;
        rest = rest.slice(name[0].length);
      } else break;
      const plus = /^\s*\+\s*/.exec(rest);
      if (!plus) break;
      rest = rest.slice(plus[0].length);
    }
    return text ? finish(text) : undefined;

    function finish(value: string): string | undefined {
      if (/^[a-z][a-z0-9+.-]*:|^\/\/|^#|^\[param\]/i.test(value)) return undefined;
      const path = value.split(/[?#]/)[0]!.replace(/\/+$/, '');
      if (!/^\/?[\w\-[\]/.]*$/.test(path) || path.replace(/\//g, '') === '') return undefined;
      return path.startsWith('/') ? path : `/${path}`;
    }
  }

  /** A string constant visible in `file`: its own, or one it imports from a relative path. */
  private constant(file: string, name: string): string | undefined {
    if (!/^[A-Z_$][\w$]*$/i.test(name) || name.includes('.')) return undefined;
    const local = this.constantsOf(file, this.index.texts.get(file) ?? '').get(name);
    if (local !== undefined) return local;
    const text = this.index.texts.get(file) ?? '';
    for (const match of text.matchAll(/import\s*\{([^}]*)\}\s*from\s*['"](\.[^'"]+)['"]/g)) {
      const names = match[1]!.split(',').map((part) => part.trim().split(/\s+as\s+/));
      const entry = names.find((parts) => (parts[1] ?? parts[0]) === name);
      if (!entry) continue;
      const target = this.moduleText(file, match[2]!);
      if (!target) return undefined;
      return this.constantsOf(target.path, target.text).get(entry[0]!);
    }
    return undefined;
  }

  private constantsOf(key: string, text: string): Map<string, string> {
    let found = this.constants.get(key);
    if (!found) {
      found = new Map();
      for (const match of text.matchAll(
        /(?:^|\n)\s*(?:export\s+)?const\s+([A-Za-z_$][\w$]*)\s*=\s*(['"`])([^'"`$\n]*)\2/g,
      )) {
        found.set(match[1]!, match[3]!);
      }
      this.constants.set(key, found);
    }
    return found;
  }

  private moduleText(from: string, specifier: string): { path: string; text: string } | undefined {
    const base = this.reader.absolute(from);
    if (!base) return undefined;
    const target = join(dirname(base), specifier);
    for (const candidate of [
      target,
      ...['.js', '.jsx', '.ts', '.tsx', '.mjs'].map((ext) => target + ext),
      ...['.js', '.ts'].map((ext) => join(target, `index${ext}`)),
    ]) {
      if (!/\.[cm]?[jt]sx?$/.test(candidate) || !existsSync(candidate)) continue;
      try {
        return { path: candidate, text: readFileSync(candidate, 'utf8') };
      } catch {
        return undefined;
      }
    }
    return undefined;
  }
}

/**
 * Top-to-bottom order on a screen.
 *
 * JSX is written in the order it is drawn, so each component gets the path of
 * line numbers that leads to it from the screen's file — `<Header>` on line 10
 * comes before `<Table>` on line 40, and a button on line 5 of `Table` sits
 * inside that — and an action sorts by that path and its own line. What runs as
 * the screen opens comes before anything the user presses.
 */
class SequenceOrder {
  private readonly keys = new Map<string, Map<string, number[]>>();
  private readonly lineStarts = new Map<string, number[]>();

  constructor(private readonly index: PageIndex) {}

  sorted(flows: FeatureFlow[], root?: string): string[] {
    const decorated = [...new Map(flows.map((flow) => [flow.id, flow])).values()].map((flow) => ({
      flow,
      load: flow.event === 'mount' ? 0 : 1,
      key: [...this.keyOf(fileOf(flow) ?? '', root), lineOf(flow)],
      file: fileOf(flow) ?? '',
    }));
    decorated.sort(
      (a, b) =>
        a.load - b.load ||
        compareKeys(a.key, b.key) ||
        a.file.localeCompare(b.file) ||
        a.flow.id.localeCompare(b.flow.id),
    );
    return decorated.map((entry) => entry.flow.id);
  }

  /** The path of lines from `root` to `file`; files it does not draw sort last. */
  keyOf(file: string, root?: string): number[] {
    if (!root) return [];
    let keys = this.keys.get(root);
    if (!keys) {
      keys = new Map();
      this.walk(root, [], keys, 0);
      this.keys.set(root, keys);
    }
    return keys.get(file) ?? [Number.MAX_SAFE_INTEGER];
  }

  private walk(file: string, key: number[], keys: Map<string, number[]>, depth: number): void {
    if (keys.has(file)) return;
    keys.set(file, key);
    if (depth > 6) return;
    const text = this.index.texts.get(file);
    if (!text) return;
    for (const match of text.matchAll(/<([A-Z][\w$]*)[\s/>]/g)) {
      const target = resolveTag(this.index, file, match[1]!);
      if (!target || target === file) continue;
      this.walk(target, [...key, this.lineAt(file, text, match.index)], keys, depth + 1);
    }
  }

  private lineAt(file: string, text: string, offset: number): number {
    let starts = this.lineStarts.get(file);
    if (!starts) {
      starts = [0];
      for (let i = 0; i < text.length; i++) if (text[i] === '\n') starts.push(i + 1);
      this.lineStarts.set(file, starts);
    }
    let low = 0;
    let high = starts.length - 1;
    while (low < high) {
      const mid = (low + high + 1) >> 1;
      if (starts[mid]! <= offset) low = mid;
      else high = mid - 1;
    }
    return low + 1;
  }
}

/** `GET /settings` with no source behind it: the screen at that address, if there is one. */
function screenOfRequest(flow: FeatureFlow, screens: Map<string, Screen>): string | undefined {
  for (const endpoint of flow.endpoints) {
    const [method, path] = endpoint.split(' ');
    if (method !== 'GET' || !path) continue;
    const key = routeKey(normalizeRoute(path));
    if (screens.has(key)) return key;
  }
  return undefined;
}

function compareKeys(a: number[], b: number[]): number {
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    if (a[i] !== b[i]) return a[i]! - b[i]!;
  }
  return a.length - b.length;
}

function fileOf(flow: FeatureFlow): string | undefined {
  return flow.source?.file ?? flow.steps[0]?.file;
}

function lineOf(flow: FeatureFlow): number {
  return flow.source?.line ?? flow.steps[0]?.line ?? 0;
}

function allActions(entry: SidebarEntry): string[] {
  return [...entry.actions, ...entry.children.flatMap(allActions)];
}

function baseName(file: string): string {
  return (file.split('/').pop() ?? file).replace(/\.[cm]?[jt]sx?$/, '');
}

/** `/medicines/[id]/edit` -> `Medicines › Edit`; a route ending on a parameter is one record's page. */
function screenName(route: string): string {
  const segments = route.split('/').filter(Boolean);
  if (segments.length === 0) return 'Home';
  const dynamic = (segment: string) => /^\[.*\]$/.test(segment);
  const words = segments.filter((segment) => !dynamic(segment)).map(humanizeName);
  if (dynamic(segments[segments.length - 1]!)) words.push('Details');
  return words.join(' › ') || 'Details';
}

/** The page a per-place copy of a shared component's action was made for. */
function siteOf(flow: FeatureFlow): string | undefined {
  const site = flow.steps[0]?.meta?.['siteFile'];
  return typeof site === 'string' ? site : undefined;
}
