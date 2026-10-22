// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  projectFindings,
  actionDecisions,
  actionQueries,
  analyzeBreakage,
  analyzeChanged,
  analyzeFlowImpact,
  explainAction,
  flowApis,
  flowPages,
  flowTiming,
  indexTests,
  planTests,
  projectUnused,
  databaseReport,
  renderActionDocument,
  resolveFlows,
  scan,
  scopeSummary,
  testsForFlow,
  type SerializedGraph,
} from '@flowslens/core';
import { EXAMPLE_ROOT } from './helpers.js';

/**
 * The dashboard's browser code.
 *
 * Its server and JSON API had 16 integration tests driving the real `serve`
 * process; the 660 lines of DOM rendering had none, which is the part a user
 * actually looks at. The gap mattered because the rendering layer is where the
 * labels live — and a wrong label ("write" on a delete, "Database" over a
 * payment provider) is a wrong answer delivered confidently.
 *
 * `app.js` is loaded the way a browser loads it: against the real `index.html`,
 * with `fetch` answering from a real scan of the example app. No mock of the
 * page's own structure, because a test that invents its own DOM cannot catch an
 * id that `index.html` renamed.
 */
const here = dirname(fileURLToPath(import.meta.url));
const publicDir = resolve(here, '..', 'apps', 'dashboard', 'public');

const scanned = scan({ root: EXAMPLE_ROOT });
const graph: SerializedGraph = scanned.graph.toJSON();
const resolved = resolveFlows(scanned.graph);
const pagesByFlow = flowPages(scanned.graph, resolved);
// The server adds each action's pages to `/api/flows`; so does this answer.
const flows = resolved.map((flow) => ({ ...flow, pages: pagesByFlow.get(flow.id) ?? [] }));

/** Set by a test to answer `/api/flows` with a list of its own. */
let flowsResponse: unknown;

/** Set by a test to answer `/api/navigation` with a menu; none by default. */
let navigationResponse: unknown;

/** The actions on an entry's screen, the way the server gathers them. */
function entryActions(entry: { actions: string[]; children: Array<{ kind: string }> }): string[] {
  return [
    ...entry.actions,
    ...(entry.children as Array<{ kind: string; actions: string[]; children: never[] }>)
      .filter((child) => child.kind === 'section' || child.kind === 'tab')
      .flatMap(entryActions),
  ];
}

function findEntry(entries: unknown[], key: string): Record<string, unknown> | undefined {
  for (const entry of entries as Array<{ key: string; children: unknown[] }>) {
    if (entry.key === key) return entry as unknown as Record<string, unknown>;
    const found = findEntry(entry.children, key);
    if (found) return found;
  }
  return undefined;
}

/** Set by a test to answer `/api/card` — what a card shows; none by default. */
let cardResponse: ((path: string) => unknown) | undefined;

/** Set by a test to answer `/api/changed/breakage` with a report of its own. */
let breakageResponse: unknown;

/** Set by a test to answer `/api/decisions` with a tree of its own. */
let decisionsResponse: ((path: string) => unknown) | undefined;

/** Set by a test to answer `/api/decisions/shared`: none shared by default. */
let sharedResponse: unknown;

/** What the real server answers, from a real graph. */
function apiResponse(path: string): unknown {
  if (path.startsWith('/api/graph')) return graph;
  if (path.startsWith('/api/flows')) return flowsResponse ?? flows;
  // The example app writes no menu down, as the server would report.
  if (path.startsWith('/api/navigation')) return navigationResponse ?? null;
  if (path.startsWith('/api/card')) {
    if (!cardResponse) throw new Error('unknown entry');
    return cardResponse(path);
  }
  if (path.startsWith('/api/scope')) {
    // The real summary of the entry, from the real scan.
    const params = new URL(path, 'http://x').searchParams;
    const key = params.get('entry') ?? '';
    const loads = params.get('loads') === '1';
    const nav = navigationResponse as { entries: unknown[] } | undefined;
    const entry = nav ? findEntry(nav.entries, key) : undefined;
    if (!entry) throw new Error('unknown entry');
    return {
      key,
      label: entry['label'],
      kind: entry['kind'],
      route: entry['route'],
      ...scopeSummary(
        scanned.graph,
        resolved,
        entryActions(entry as never).filter(
          (id) => !loads || resolved.find((flow) => flow.id === id)?.event === 'mount',
        ),
      ),
    };
  }
  if (path.startsWith('/api/doctor')) {
    return { brokenCalls: [], deadEndpoints: [], sharedWrites: [] };
  }
  if (path.startsWith('/api/changed/breakage')) {
    if (breakageResponse) return breakageResponse;
    return {
      against: 'the last commit',
      ...analyzeBreakage(scanned.graph, [], { root: EXAMPLE_ROOT }),
    };
  }
  if (path.startsWith('/api/changed')) {
    // A diff the graph really does run through: the example's own order form.
    return {
      against: 'the last commit',
      ...analyzeChanged(
        scanned.graph,
        [
          { file: 'web/src/components/OrderForm.tsx', status: 'modified' as const },
          { file: 'README.md', status: 'modified' as const },
        ],
        { tests: indexTests([EXAMPLE_ROOT]) },
      ),
    };
  }
  if (path.startsWith('/api/findings')) return projectFindings(scanned.graph);
  if (path.startsWith('/api/unused')) return projectUnused(scanned.graph);
  // As the server answers: the overview without cases, then one collection in full.
  if (path.startsWith('/api/database/collection'))
    return databaseReport(scanned.graph, flows, {
      only: new URL(path, 'http://x').searchParams.get('name') ?? '',
    }).collections[0];
  if (path.startsWith('/api/database'))
    return databaseReport(scanned.graph, flows, { scenarios: false });
  if (path.startsWith('/api/queries')) {
    const flow = flows.find(
      (candidate) => candidate.id === new URL(path, 'http://x').searchParams.get('flow'),
    );
    return flow ? actionQueries(scanned.graph, flow) : { error: 'unknown flow' };
  }
  if (path.startsWith('/api/decisions/shared')) return sharedResponse ?? [];
  if (path.startsWith('/api/decisions') && decisionsResponse) return decisionsResponse(path);
  if (path.startsWith('/api/decisions')) {
    const flow = flows.find(
      (candidate) => candidate.id === new URL(path, 'http://x').searchParams.get('flow'),
    );
    return flow ? actionDecisions(scanned.graph, flow) : { error: 'unknown flow' };
  }
  if (path.startsWith('/api/action')) {
    const params = new URL(path, 'http://x').searchParams;
    const flow = flows.find((candidate) => candidate.id === params.get('flow'));
    if (!flow) return { error: 'unknown flow' };
    const doc = explainAction(scanned.graph, flow);
    return params.get('format') === 'markdown' ? renderActionDocument(doc) : doc;
  }
  if (path.startsWith('/api/insight')) {
    const id = new URL(path, 'http://x').searchParams.get('flow');
    const flow = flows.find((candidate) => candidate.id === id);
    if (!flow) throw new Error('unknown flow');
    // The real server's answer, from the real functions — so a change in what
    // the endpoint returns breaks this test rather than silently drifting.
    return {
      flowId: flow.id,
      timing: flowTiming(flow),
      impact: analyzeFlowImpact(scanned.graph, flow),
      tests: testsForFlow(indexTests([EXAMPLE_ROOT]), flow),
      testPlan: planTests(explainAction(scanned.graph, flow), flow),
      apis: flowApis(scanned.graph, flow),
    };
  }
  throw new Error(`unexpected request: ${path}`);
}

async function loadDashboard(): Promise<void> {
  document.documentElement.innerHTML = readFileSync(resolve(publicDir, 'index.html'), 'utf8');

  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string) => {
      const path = String(input);
      return {
        ok: true,
        status: 200,
        json: async () => apiResponse(path),
      } as Response;
    }),
  );

  // The Docs tab writes `#docs=<flow>` to the URL, which jsdom keeps between tests.
  window.history.replaceState(null, '', '/');

  // A fresh module registry per test: `app.js` runs `load()` on import.
  vi.resetModules();
  await import(resolve(publicDir, 'app.js'));
  // Let the API calls and the first render settle, including the per-flow
  // insight the tabs need.
  await vi.waitFor(() => {
    expect(document.getElementById('graph')?.textContent).not.toBe('');
    expect(document.querySelectorAll('#tabs .tab').length).toBe(6);
    expect(document.querySelector('#tab-impact .tab-badge')).not.toBeNull();
  });
}

beforeEach(async () => {
  breakageResponse = undefined;
  flowsResponse = undefined;
  navigationResponse = undefined;
  await loadDashboard();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('the dashboard renders a real graph', () => {
  it('reports the size of the graph it loaded', () => {
    const subtitle = document.getElementById('subtitle')?.textContent ?? '';
    expect(subtitle).toContain(`${graph.nodes.length} nodes`);
    expect(subtitle).toContain(`${graph.edges.length} edges`);
  });

  it('lists every flow the API returned', () => {
    const items = document.querySelectorAll('#flow-list *');
    expect(items.length).toBeGreaterThan(0);
    const rows = [...document.querySelectorAll<HTMLElement>('#flow-list .flow-item')];
    for (const flow of flows) {
      const row = rows.find((item) => item.dataset['flowId'] === flow.id);
      expect(row, `no row for ${flow.id}`).toBeDefined();
      // The page is in the heading; the full title stays on hover.
      expect(row!.title).toContain(flow.title);
    }
    // Every row keeps its detail line: the API it calls, or that it calls none.
    for (const item of rows) {
      expect(item.querySelector('.meta')?.textContent?.trim()).toBeTruthy();
      expect(item.querySelector('.kind-icon')).not.toBeNull();
    }
  });

  it('groups the actions under the page each one is on', () => {
    const groups = [...document.querySelectorAll<HTMLDetailsElement>('#flow-list .page-group')];
    expect(groups.length).toBeGreaterThan(0);
    const routes = groups.map((group) => group.querySelector('.page-route')?.textContent ?? '');
    for (const flow of flows) {
      const expected = flow.pages.length
        ? flow.pages.map((page) => (page.layout ? 'shared layout' : page.route))
        : ['not placed on a page'];
      for (const route of expected) {
        const group = groups[routes.indexOf(route)];
        expect(group, `no group ${route}`).toBeDefined();
        expect(group!.querySelector(`[data-flow-id="${flow.id}"]`)).not.toBeNull();
      }
    }
    // A page is named in words, with its route underneath.
    const customers = groups[routes.indexOf('/customers')];
    expect(customers?.querySelector('.page-name')?.textContent).toBe('Customers');
    // Each heading counts the actions under it.
    for (const group of groups) {
      expect(group.querySelector('.page-count')?.textContent).toBe(
        String(group.querySelectorAll('.flow-item').length),
      );
    }
    expect(document.getElementById('flow-summary')?.textContent).toMatch(
      /^\d+ actions? on \d+ pages?$/,
    );
  });

  it('drops the page name from a row that sits under that page', () => {
    const flow = flows.find((candidate) => candidate.title === 'Customers · Delete')!;
    const row = document.querySelector(`[data-flow-id="${flow.id}"]`)!;
    expect(row.querySelector('.label')?.textContent).toBe('Delete');
    expect(row.querySelector('.list-method')?.textContent).toBe('DELETE');
  });

  it('searches by page route, folds groups, and says when nothing matches', async () => {
    const filter = document.getElementById('filter') as HTMLInputElement;
    const type = (value: string): void => {
      filter.value = value;
      filter.dispatchEvent(new Event('input'));
    };
    type('/orders');
    const shown = [...document.querySelectorAll<HTMLElement>('#flow-list .flow-item')];
    expect(shown.length).toBeGreaterThan(0);
    for (const row of shown) {
      const flow = flows.find((candidate) => candidate.id === row.dataset['flowId'])!;
      expect(flow.pages.map((page) => page.route)).toContain('/orders');
    }
    expect(document.getElementById('flow-summary')?.textContent).toMatch(/match$/);

    type('nothing-is-called-this');
    expect(document.querySelector('#flow-list .list-empty')?.textContent).toContain(
      'nothing-is-called-this',
    );
    document.querySelector<HTMLButtonElement>('#flow-list .clear-filter')!.click();
    expect(filter.value).toBe('');

    // Every group starts folded, and the button opens them all, then folds them.
    const groups = () => [
      ...document.querySelectorAll<HTMLDetailsElement>('#flow-list .page-group'),
    ];
    expect(groups().some((group) => group.open)).toBe(false);
    const fold = document.getElementById('fold-all') as HTMLButtonElement;
    expect(fold.hidden).toBe(false);
    expect(fold.textContent).toBe('Expand all');
    fold.click();
    expect(groups().every((group) => group.open)).toBe(true);
    expect(fold.textContent).toBe('Collapse all');
    fold.click();
    expect(groups().some((group) => group.open)).toBe(false);
  });

  it('selects the first flow and draws its layers in execution order', () => {
    const titles = [...document.querySelectorAll('.layer-title')].map(
      (node) => node.textContent ?? '',
    );
    expect(titles.length).toBeGreaterThan(1);
    // Whatever the flow, the UI action cannot come after the database.
    const ui = titles.indexOf('User action');
    const data = titles.indexOf('Database');
    if (ui !== -1 && data !== -1) expect(ui).toBeLessThan(data);
  });

  it('gives every node tile the colour class of its layer', () => {
    const nodes = [...document.querySelectorAll('.node')];
    expect(nodes.length).toBeGreaterThan(0);
    for (const node of nodes) {
      expect(node.className).toMatch(/layer-(ui|frontend|network|backend|data|external)/);
    }
  });

  it('draws the diagram as numbered steps that say what they do, inside the Docs tab', async () => {
    await openDiagram();
    const nodes = [...document.querySelectorAll('#graph .node')];
    expect(nodes.length).toBeGreaterThan(0);
    const numbers = nodes.map((node) => node.querySelector('.step-num')?.textContent);
    expect(numbers).toEqual(nodes.map((_, i) => String(i + 1)));
    for (const node of nodes) expect(node.querySelector('.say')?.textContent?.trim()).toBeTruthy();
    expect(document.getElementById('tab-docs')?.getAttribute('aria-selected')).toBe('true');
  });

  it('escapes what it renders', () => {
    // The whole page came from JSON; no unescaped angle bracket may survive.
    const scripts = document.querySelectorAll('#graph script, #flow-list script');
    expect(scripts).toHaveLength(0);
  });
});

describe('finding an action in a big app', () => {
  /**
   * The example app is small, so the shapes a large one has are made from its
   * real flows: a form rendered on three pages, a page that loads data by
   * itself, and a page whose tab title is not its route.
   */
  const reshaped = () =>
    flows.map((flow) => {
      if (flow.id === 'orderform-print-order') {
        return {
          ...flow,
          pages: ['/orders', '/customers', '/reports'].map((route) => ({
            route,
            file: `web/src/pages${route}.tsx`,
            layout: false,
          })),
        };
      }
      if (flow.id === 'customerspage-search') return { ...flow, event: 'mount' };
      return {
        ...flow,
        pages: flow.pages.map((page) =>
          page.route === '/customers' ? { ...page, title: 'Customer list' } : page,
        ),
      };
    });

  async function reload(): Promise<void> {
    vi.unstubAllGlobals();
    flowsResponse = reshaped();
    await loadDashboard();
  }

  const group = (key: string) =>
    document.querySelector<HTMLDetailsElement>(`#flow-list .page-group[data-key="${key}"]`);

  it('lists a component on three pages once, under its own name, and links to it from each', async () => {
    await reload();
    const shared = group('shared:OrderForm');
    expect(shared).not.toBeNull();
    expect(shared!.querySelector('.page-name')?.textContent).toBe('Order form');
    expect(shared!.querySelector('.page-route')?.textContent).toBe('shared · on 3 pages');
    expect(shared!.querySelector('[data-flow-id="orderform-print-order"]')).not.toBeNull();
    // Not repeated under the pages it is on.
    expect(
      document.querySelectorAll('#flow-list [data-flow-id="orderform-print-order"]').length,
    ).toBe(1);
    // A page with nothing of its own still gets a heading to link from.
    const reports = group('page:/reports');
    expect(reports?.querySelector('.page-count')?.textContent).toBe('0');
    const link = reports!.querySelector<HTMLButtonElement>('.page-shared .shared-link');
    expect(link?.textContent).toBe('Order form');
    shared!.open = false;
    shared!.dispatchEvent(new Event('toggle'));
    link!.click();
    expect(group('shared:OrderForm')?.open).toBe(true);
  });

  it('puts what the user can do first and folds what runs by itself', async () => {
    await reload();
    const customers = group('page:/customers')!;
    const fold = customers.querySelector<HTMLDetailsElement>('.page-loads');
    expect(fold).not.toBeNull();
    expect(fold!.open).toBe(false);
    expect(fold!.querySelector('summary')?.textContent).toMatch(/When the page opens\s*1/);
    expect(fold!.querySelector('[data-flow-id="customerspage-search"]')).not.toBeNull();
    const first = customers.querySelector<HTMLElement>('.flow-item');
    expect(first?.closest('.page-loads')).toBeNull();
    // The count is every action under the heading, folded or not.
    expect(customers.querySelector('.page-count')?.textContent).toBe(
      String(customers.querySelectorAll('.flow-item').length),
    );
  });

  it('opens the fold when the selected action is in it', async () => {
    await reload();
    document.querySelector<HTMLButtonElement>('[data-flow-id="customerspage-search"]')!.click();
    expect(group('page:/customers')!.querySelector<HTMLDetailsElement>('.page-loads')!.open).toBe(
      true,
    );
  });

  it('names a page by its tab title and finds it by that name', async () => {
    await reload();
    expect(group('page:/customers')?.querySelector('.page-name')?.textContent).toBe(
      'Customer list',
    );
    expect(group('page:/customers')?.querySelector('.page-route')?.textContent).toBe('/customers');
    const filter = document.getElementById('filter') as HTMLInputElement;
    filter.value = 'customer list';
    filter.dispatchEvent(new Event('input'));
    const rows = [...document.querySelectorAll<HTMLElement>('#flow-list .flow-item')];
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((row) => row.closest('.page-group[data-key="page:/customers"]'))).toBe(true);
    // A page listed only for its links has nothing to show a search.
    expect(group('page:/reports')).toBeNull();
  });
});

describe("the sidebar copies the app's own", () => {
  /**
   * The server's answer for an app whose side menu lists Orders and Customers,
   * with a sign-in page, a button in the menu itself, and a detail screen that
   * Customers links to.
   */
  const sidebar = {
    file: 'web/src/components/SideMenu.tsx',
    line: 4,
    entries: [
      {
        key: 'nav:auth/Login',
        label: 'Login',
        kind: 'auth',
        route: '/login',
        actions: [],
        children: [],
      },
      {
        key: 'nav:sidebar',
        label: 'Menu',
        kind: 'sidebar',
        actions: ['orderform-print-order'],
        children: [],
        flat: true,
      },
      {
        key: 'nav:menu/Orders',
        label: 'Orders',
        kind: 'menu',
        route: '/orders',
        actions: ['orderform-submit-order'],
        children: [],
      },
      {
        key: 'nav:menu/Customers',
        label: 'Customers',
        kind: 'menu',
        route: '/customers',
        // Screen order: what runs as it opens, then top to bottom.
        actions: ['customerspage-search', 'customerspage-archive', 'customerspage-delete'],
        children: [
          {
            key: 'nav:menu/Customers/New customer form',
            label: 'New customer form',
            kind: 'tab',
            route: '/customers',
            actions: ['customerform-create-customer'],
            children: [],
          },
          {
            key: 'nav:menu/Customers//customers/[id]',
            label: 'Customers › Details',
            kind: 'page',
            route: '/customers/[id]',
            actions: [],
            children: [],
          },
        ],
      },
    ],
  };

  async function reload(navigation: unknown): Promise<void> {
    vi.unstubAllGlobals();
    navigationResponse = navigation;
    await loadDashboard();
    // The app's sidebar is read after the first paint.
    await vi.waitFor(() => {
      expect(document.querySelector('#flow-list .nav-entry')).not.toBeNull();
    });
  }

  const entry = (key: string) =>
    document.querySelector<HTMLDetailsElement>(`#flow-list .page-group[data-key="${key}"]`);
  const topLevel = () =>
    [...document.querySelectorAll<HTMLElement>('#flow-list > .page-group')].map(
      (group) => group.querySelector(':scope > summary .page-name')?.textContent,
    );
  const rowsOf = (group: Element) =>
    [...group.querySelectorAll<HTMLElement>(':scope > .flow-item')].map(
      (row) => row.dataset['flowId'],
    );

  it('lists the entries in the order the app shows them, and nothing beside them', async () => {
    await reload(sidebar);
    // Two parts: the pages the app's menu shows, then every other page.
    expect(topLevel()).toEqual(['Orders', 'Customers', 'Login']);
    const parts = [...document.querySelectorAll<HTMLElement>('#flow-list > .nav-part')];
    expect(parts.map((part) => part.textContent?.replace(/\d+$/, '').trim())).toEqual([
      'In the app’s menu',
      'Other pages',
    ]);
    expect(parts.map((part) => part.querySelector('.nav-part-count')?.textContent)).toEqual([
      '2',
      '2',
    ]);
    // The menu's pages sit between the first heading and the second.
    expect(parts[0]!.nextElementSibling?.getAttribute('data-key')).toBe('nav:menu/Orders');
    expect(parts[1]!.nextElementSibling?.getAttribute('data-key')).toBe('nav:auth/Login');
    expect(entry('nav:auth/Login')!.querySelector('.page-route')?.textContent).toBe('/login');
    // No by-page groups, and no leftovers heading: every action has its place.
    expect(document.querySelector('#flow-list .page-group[data-key^="page:"]')).toBeNull();
    expect(document.querySelector('#flow-list .page-group[data-key^="shared:"]')).toBeNull();
    expect(document.querySelector('.nav-divider')).toBeNull();
    // An entry whose screen calls nothing still has its place, and says so.
    expect(entry('nav:auth/Login')!.querySelector('.page-count')?.textContent).toBe('0');
    expect(entry('nav:auth/Login')!.querySelector('.nav-empty')).not.toBeNull();
  });

  it("shows the menu's own buttons as rows, where the menu has them", async () => {
    await reload(sidebar);
    const rows = document.querySelector('#flow-list > .nav-flat');
    expect(rows).not.toBeNull();
    expect(rows!.previousElementSibling?.getAttribute('data-key')).toBe('nav:auth/Login');
    expect(rowsOf(rows!)).toEqual(['orderform-print-order']);
  });

  it("lists a screen's actions in screen order, with no folds in between", async () => {
    await reload(sidebar);
    const customers = entry('nav:menu/Customers')!;
    expect(rowsOf(customers)).toEqual([
      'customerspage-search',
      'customerspage-archive',
      'customerspage-delete',
    ]);
    expect(customers.querySelector(':scope > .page-loads')).toBeNull();
    expect(customers.querySelector(':scope > .page-sub')).toBeNull();
  });

  it("keeps a page's own load off the list, and tells it in the page's summary with its code", async () => {
    const search = flows.find((flow) => flow.id === 'customerspage-search')!;
    flowsResponse = flows.map((flow) => (flow === search ? { ...flow, event: 'mount' } : flow));
    await reload({
      ...sidebar,
      entries: sidebar.entries.map((navEntry) =>
        navEntry.key === 'nav:menu/Customers'
          ? { ...navEntry, file: search.steps[0]!.file }
          : navEntry,
      ),
    });
    const customers = entry('nav:menu/Customers')!;
    expect(rowsOf(customers)).toEqual(['customerspage-archive', 'customerspage-delete']);
    customers.querySelector<HTMLElement>(':scope > summary')!.click();
    const call = search.steps.find((step) => step.kind === 'api-call')!;
    await vi.waitFor(() => {
      const opens = document.querySelector<HTMLElement>(
        '#panel-docs .story-step[data-open-flow="customerspage-search"]',
      )!;
      expect(opens.textContent).toContain('When it opens');
      const calls = opens.nextElementSibling!.querySelector('.story-calls')!;
      expect(calls.textContent).toContain(call.label.split(' ')[0]);
      expect(calls.querySelector('[data-editor-href]')).not.toBeNull();
    });
  });

  it("draws what a page's actions share with the rest of the app once, and each action names it", async () => {
    const step = {
      type: 'step',
      kind: 'shared',
      label: 'Run require auth',
      text: 'requireAuth(req)',
      side: 'server',
      at: { file: 'api/src/orders.ts', line: 4 },
      shared: {
        id: 'abc',
        actions: 5,
        ends: [
          { label: 'Return { user }' },
          { label: 'Return a 401 error to the caller · Unauthorized', statuses: [401] },
        ],
      },
    };
    decisionsResponse = (path) => ({
      flowId: new URL(path, 'http://x').searchParams.get('flow'),
      title: 'x',
      nodes: [
        {
          type: 'step',
          kind: 'trigger',
          label: 'The user clicks',
          text: 'clicks',
          side: 'browser',
        },
        step,
      ],
      counts: { decisions: 1, outcomes: 1, queries: 0, requests: 1 },
      limits: [],
      shared: ['abc'],
    });
    sharedResponse = [
      {
        id: 'abc',
        flowId: 'shared:abc',
        title: 'requireAuth(req)',
        here: 3,
        actions: 5,
        nodes: [
          {
            type: 'group',
            kind: 'function',
            label: 'Run require auth',
            title: 'requireAuth(req)',
            side: 'server',
            nodes: [
              {
                type: 'decision',
                question: 'user?',
                label: 'Has user?',
                code: 'user',
                side: 'server',
                branches: [
                  {
                    label: 'no',
                    ends: true,
                    nodes: [
                      {
                        type: 'end',
                        outcome: 'return',
                        label: 'Return a 401 error to the caller · Unauthorized',
                        text: 'returns 401',
                        statuses: [401],
                        side: 'server',
                      },
                    ],
                  },
                ],
                otherwise: 'yes',
              },
            ],
          },
        ],
        counts: { decisions: 1, outcomes: 0, queries: 0, requests: 0 },
        limits: [],
      },
    ];
    try {
      await reload(sidebar);
      document.querySelector<HTMLElement>('[data-flow-id="customerspage-archive"]')!.click();
      const panel = await openTab('decisions');
      await vi.waitFor(() => {
        expect(panel.querySelector('.fc-step.kind-shared')).not.toBeNull();
      });
      const box = panel.querySelector('.fc-step.kind-shared')!;
      expect(box.textContent).toContain('The same in 4 other actions');
      // Failures first, with their status; then what it hands back when it works.
      const ends = [...box.querySelectorAll('.fc-shared-ends li')];
      expect(ends.map((end) => end.className)).toEqual(['fails', 'works']);
      expect(ends[0]!.querySelector('.fc-status')?.textContent).toBe('401');
      expect(ends[0]!.textContent).toContain('Unauthorized');
      box.querySelector<HTMLButtonElement>('.fc-shared-open')!.click();
      // The page's own summary, with the part unfolded and drawn.
      expect(document.querySelector('#flow-header h2')?.textContent).toBe('Customers');
      const story = document.querySelector<HTMLElement>('#panel-docs')!;
      await vi.waitFor(() => {
        const part = story.querySelector<HTMLDetailsElement>('.story-shared #shared-part-abc')!;
        expect(part.open).toBe(true);
        expect(part.querySelector('.shared-part-title')?.textContent).toBe('requireAuth(req)');
        expect(part.textContent).toContain('3 actions here · 5 in the app · 1 decision');
        expect(part.querySelector('.fc-diamond-text')?.textContent).toContain('Has user?');
      });
      expect(story.querySelector('.story-shared .story-heading')?.textContent).toBe(
        'The same in other actions',
      );
    } finally {
      decisionsResponse = undefined;
      sharedResponse = undefined;
    }
  });

  it('draws a card with links like the cards beside it, with a fold for what is in it', async () => {
    await reload({
      ...sidebar,
      entries: sidebar.entries.map((navEntry) =>
        navEntry.key === 'nav:menu/Orders'
          ? {
              ...navEntry,
              children: [
                {
                  key: 'nav:menu/Orders/Needs attention',
                  label: 'Needs attention',
                  kind: 'section',
                  actions: [],
                  items: [
                    { link: { label: 'Low', to: '/customers', href: '/customers?filter=low' } },
                    { link: { label: 'Out', to: '/customers', href: '/customers?filter=out' } },
                  ],
                  children: [],
                },
              ],
            }
          : navEntry,
      ),
    });
    const card = entry('nav:menu/Orders/Needs attention')!;
    expect(card.classList.contains('nav-card-fold')).toBe(true);
    const summary = card.querySelector(':scope > summary')!;
    expect(summary.querySelector('.kind-icon.kind-card')).not.toBeNull();
    expect(summary.querySelector('.label')?.textContent).toBe('Needs attention');
    expect(summary.querySelector('.meta')?.textContent).toBe('shows data · 2 links');
    expect(summary.querySelector('.page-count')?.textContent).toBe('2');
    expect(card.querySelectorAll(':scope > .nav-card-body > .nav-link').length).toBe(2);
  });

  it('nests tabs and the screens an entry leads to, and counts them in its total', async () => {
    await reload(sidebar);
    const customers = entry('nav:menu/Customers')!;
    const form = entry('nav:menu/Customers/New customer form')!;
    const detail = entry('nav:menu/Customers//customers/[id]')!;
    expect(form.parentElement?.closest('.page-group')).toBe(customers);
    expect(detail.parentElement?.closest('.page-group')).toBe(customers);
    expect(detail.querySelector('.page-route')?.textContent).toBe('/customers/[id]');
    expect(customers.querySelector(':scope > summary .page-count')?.textContent).toBe('4');
  });

  it('starts folded, and opens the entries an action is under when it is selected', async () => {
    await reload(sidebar);
    expect(entry('nav:menu/Orders')!.open).toBe(false);
    expect(entry('nav:menu/Customers')!.open).toBe(false);
    document
      .querySelector<HTMLButtonElement>('[data-flow-id="customerform-create-customer"]')!
      .click();
    expect(entry('nav:menu/Customers')!.open).toBe(true);
    expect(entry('nav:menu/Customers/New customer form')!.open).toBe(true);
  });

  it('selects the action in the address again on a reload, with every entry still folded', async () => {
    vi.unstubAllGlobals();
    navigationResponse = sidebar;
    await loadDashboard();
    window.history.replaceState(null, '', '/#flow=customerform-create-customer');
    vi.resetModules();
    await import(resolve(publicDir, 'app.js') + '?linked-entry');
    await vi.waitFor(() => {
      expect(entry('nav:menu/Customers')).not.toBeNull();
      expect(document.querySelector('#flow-header h2')?.textContent).toBe('Create Customer');
    });
    const groups = [...document.querySelectorAll<HTMLDetailsElement>('#flow-list .page-group')];
    expect(groups.some((group) => group.open)).toBe(false);
  });

  it('selects the page in the address again on a reload, still folded', async () => {
    vi.unstubAllGlobals();
    navigationResponse = sidebar;
    await loadDashboard();
    window.history.replaceState(null, '', '/#tab=docs&entry=nav%3Amenu%2FCustomers');
    vi.resetModules();
    await import(resolve(publicDir, 'app.js') + '?linked-page');
    await vi.waitFor(() => {
      expect(entry('nav:menu/Customers')?.classList.contains('selected')).toBe(true);
    });
    expect(entry('nav:menu/Customers')!.open).toBe(false);
    expect(document.querySelector('#flow-header h2')?.textContent).toBe('Customers');
  });

  it('lays a screen out top to bottom: its load, its cards, and links that lead on', async () => {
    const withCards = {
      ...sidebar,
      entries: sidebar.entries.map((entry) =>
        entry.key === 'nav:menu/Orders'
          ? {
              ...entry,
              actions: ['orderform-submit-order'],
              items: [
                { action: 'orderform-submit-order' },
                { section: 'nav:menu/Orders/§Recent customers' },
              ],
              children: [
                {
                  key: 'nav:menu/Orders/§Recent customers',
                  label: 'Recent customers',
                  kind: 'section',
                  actions: [],
                  items: [
                    { link: { label: 'View all', to: '/customers', href: '/customers?recent=1' } },
                  ],
                  children: [],
                },
              ],
            }
          : entry,
      ),
    };
    await reload(withCards);
    const orders = entry('nav:menu/Orders')!;
    const card = entry('nav:menu/Orders/§Recent customers')!;
    // The card sits after the row above it on the screen, inside the page.
    expect(card.parentElement).toBe(orders);
    expect(card.previousElementSibling?.getAttribute('data-flow-id')).toBe(
      'orderform-submit-order',
    );
    // A card of links is not empty: the link counts, and says where it goes.
    expect(card.querySelector('.page-count')?.textContent).toBe('1');
    expect(card.querySelector('.nav-empty')).toBeNull();
    const link = card.querySelector<HTMLButtonElement>('.nav-link')!;
    expect(link.textContent).toContain('View all');
    expect(link.textContent).toContain('Customers');
    expect(link.textContent).toContain('/customers?recent=1');
    // A link is a child like any other: clicking it opens its own six tabs,
    // about the screen it opens and what that screen runs as it opens.
    link.click();
    expect(link.isConnected).toBe(false); // the list re-drew around the selection
    const selected = document.querySelector<HTMLElement>('.nav-link[aria-selected="true"]');
    expect(selected?.dataset['linkKey']).toBe('nav:menu/Orders/§Recent customers#link0');
    await vi.waitFor(() => {
      expect(document.querySelector('#flow-header h2')?.textContent).toBe('View all');
    });
    expect(document.querySelector('#flow-header')?.textContent).toContain('→ Customers');
    expect(document.querySelectorAll('#tabs .tab').length).toBe(6);
    expect(window.location.hash).toContain('link0');
    await vi.waitFor(() => {
      expect(document.querySelector('#panel-docs')?.textContent).toContain(
        '“View all” on Recent customers opens Customers',
      );
    });
    // The page itself stays one click away, and is not opened by the link.
    expect(entry('nav:menu/Customers')!.open).toBe(false);
    document
      .querySelector<HTMLElement>('#panel-docs [data-open-entry="nav:menu/Customers"]')!
      .click();
    expect(entry('nav:menu/Customers')!.open).toBe(true);
  });

  it('explains a page in plain words when it is clicked, with no tabs of its own', async () => {
    await reload(sidebar);
    entry('nav:menu/Customers')!.querySelector<HTMLElement>(':scope > summary')!.click();
    // It unfolds, and is the selection.
    expect(entry('nav:menu/Customers')!.open).toBe(true);
    expect(entry('nav:menu/Customers')!.classList.contains('selected')).toBe(true);
    expect(document.querySelector('#flow-header h2')?.textContent).toBe('Customers');
    expect(window.location.hash).toContain('entry=nav%3Amenu%2FCustomers');
    // The tabs belong to what is on the page, not the page.
    expect(document.getElementById('tabs')?.hidden).toBe(true);
    const story = () => document.querySelector('#panel-docs .page-story')!;
    expect(story().querySelector('.story-lead')?.textContent).toBe(
      'This is the Customers page, opened from the app’s menu.',
    );
    // Every action on it, top to bottom, its tab's included.
    expect(
      [...story().querySelectorAll<HTMLElement>('[data-open-flow]')].map(
        (step) => step.dataset['openFlow'],
      ),
    ).toEqual([
      'customerspage-search',
      'customerspage-archive',
      'customerspage-delete',
      'customerform-create-customer',
    ]);
    // Told from each action's own document once it has been read.
    await vi.waitFor(() => {
      const create = story().querySelector('[data-open-flow="customerform-create-customer"]');
      expect(create?.textContent).toContain('You fill in');
      expect(create?.textContent).toContain('It then sends this to the server.');
    });
    // No developer words: no endpoints, no file names.
    expect(story().textContent).not.toMatch(/\/api\/|\.tsx?\b/);
    // The pages it leads to are named.
    expect(story().textContent).toContain('Pages you can go to from here');
  });

  it('gives what is on a page — an action, a tab, a card — the six tabs', async () => {
    await reload(sidebar);
    entry('nav:menu/Customers')!.querySelector<HTMLElement>(':scope > summary')!.click();
    document
      .querySelector<HTMLElement>('#panel-docs [data-open-flow="customerspage-delete"]')!
      .click();
    expect(document.getElementById('tabs')?.hidden).toBe(false);
    expect(document.querySelectorAll('#tabs .tab').length).toBe(6);
    expect(document.querySelector('#flow-header h2')?.textContent).toBe('Customers · Delete');
    // A tab of the page is a child too: its own six tabs, its actions' in full.
    entry('nav:menu/Customers/New customer form')!
      .querySelector<HTMLElement>(':scope > summary')!
      .click();
    expect(document.getElementById('tabs')?.hidden).toBe(false);
    expect(
      [...document.querySelectorAll<HTMLElement>('#panel-docs .stack-item')].map(
        (item) => item.dataset['flowId'],
      ),
    ).toEqual(['customerform-create-customer']);
    for (const tab of ['decisions', 'perf', 'tests', 'impact']) {
      document.querySelector<HTMLButtonElement>(`#tab-${tab}`)!.click();
      expect(document.querySelectorAll(`#panel-${tab} .stack-item`).length).toBe(1);
    }
  });

  it('shows what a link sets off as the link’s own tabs: the flow its screen runs as it opens', async () => {
    vi.unstubAllGlobals();
    // The Customers screen loads its list by itself as it opens.
    flowsResponse = flows.map((flow) =>
      flow.id === 'customerspage-search' ? { ...flow, event: 'mount' } : flow,
    );
    navigationResponse = {
      ...sidebar,
      entries: sidebar.entries.map((entry) =>
        entry.key === 'nav:menu/Orders'
          ? {
              ...entry,
              items: [
                { action: 'orderform-submit-order' },
                { link: { label: 'Low', to: '/customers', href: '/customers?filter=low' } },
              ],
            }
          : entry,
      ),
    };
    await loadDashboard();
    await vi.waitFor(() => {
      expect(document.querySelector('#flow-list .nav-link')).not.toBeNull();
    });
    document.querySelector<HTMLButtonElement>('#flow-list .nav-link')!.click();
    // The link is the selection; the tabs are the flow it sets off, in full.
    expect(document.querySelector('.nav-link[aria-selected="true"]')).not.toBeNull();
    expect(document.querySelector('.flow-item[aria-selected="true"]:not(.nav-link)')).toBeNull();
    expect(document.querySelector('#flow-header h2')?.textContent).toBe('Low');
    expect(document.querySelector('#flow-header')?.textContent).toContain('/customers?filter=low');
    expect(window.location.hash).toContain('link1');
    await vi.waitFor(() => {
      const docs = document.querySelector('#panel-docs')!;
      expect(docs.textContent).toContain('Clicking “Low” on Orders opens Customers');
      expect(docs.querySelector('[data-stage]')).not.toBeNull();
    });
    // No page was opened to get there.
    expect(entry('nav:menu/Customers')!.open).toBe(false);
    expect(document.querySelector('.page-group.selected')).toBeNull();
  });

  it("points a card fed by its page's own load to the page, where every step is told once", async () => {
    const search = flows.find((flow) => flow.id === 'customerspage-search')!;
    flowsResponse = flows.map((flow) => (flow === search ? { ...flow, event: 'mount' } : flow));
    cardResponse = () => ({
      key: 'nav:menu/Customers/§Stock',
      label: 'Stock',
      data: {
        file: 'web/src/components/Stats.tsx',
        line: 12,
        component: 'Stats',
        values: [],
        calculations: [],
        sources: [
          {
            hook: 'useStats',
            file: 'web/src/pages/Customers.tsx',
            line: 5,
            flows: ['customerspage-search'],
            endpoints: search.endpoints,
            fields: ['lowStockCount'],
          },
        ],
        fields: [],
        conditions: [],
      },
      sharedWith: [],
    });
    await reload({
      ...sidebar,
      entries: sidebar.entries.map((top) =>
        top.key === 'nav:menu/Customers'
          ? {
              ...top,
              file: search.steps[0]!.file,
              children: [
                {
                  key: 'nav:menu/Customers/§Stock',
                  label: 'Stock',
                  kind: 'section',
                  file: 'web/src/components/Stats.tsx',
                  line: 12,
                  actions: [],
                  children: [],
                },
                ...top.children,
              ],
            }
          : top,
      ),
    });
    entry('nav:menu/Customers')!.querySelector<HTMLElement>(':scope > summary')!.click();
    await vi.waitFor(() => {
      expect(document.querySelector('#panel-docs .story-path .card-path')).not.toBeNull();
    });
    const server = search.steps.find((step) => step.layer === 'backend')!;
    expect(document.querySelector('#panel-docs .story-path')!.textContent).toContain(server.label);
    document
      .querySelector<HTMLButtonElement>(
        '#flow-list .nav-card[data-key="nav:menu/Customers/§Stock"]',
      )!
      .click();
    await vi.waitFor(() => {
      const path = document.querySelector('#panel-docs .card-data .card-path')!;
      expect(path.textContent).toContain('Customers page’s own request');
      expect(path.textContent).toContain('lowStockCount');
      expect(path.textContent).not.toContain('The server runs');
    });
    // Its Decisions tab is the card's own: the load's tree is on the page.
    const decisions = await openTab('decisions');
    await vi.waitFor(() => {
      expect(decisions.textContent).toContain('drawn once, on the page');
    });
    expect(decisions.querySelector('.stack-item[data-flow-id="customerspage-search"]')).toBeNull();
    // The badge counts what the tab draws: the page's load is not the card's.
    expect(document.querySelector('#tab-decisions .tab-badge')?.textContent?.trim()).toBe(
      'straight',
    );
    await openTab('docs');
    document
      .querySelector<HTMLButtonElement>('#panel-docs [data-open-entry="nav:menu/Customers"]')!
      .click();
    expect(document.querySelector('#flow-header h2')?.textContent).toBe('Customers');
  });

  it('gives a card that only shows data the six tabs: where each value comes from, then its load', async () => {
    const stats = {
      file: 'web/src/components/Stats.tsx',
      line: 12,
      component: 'Stats',
      values: [
        {
          label: 'value',
          code: 'formatNumber(total)',
          file: 'web/src/components/Stats.tsx',
          line: 14,
          fields: ['lowStockCount'],
          uses: ['total'],
          format: ['formatNumber'],
          hooks: ['useStats'],
        },
      ],
      calculations: [
        {
          name: 'total',
          code: 'total = data.lowStockCount + 1',
          file: 'web/src/components/Stats.tsx',
          line: 8,
          fields: ['lowStockCount'],
        },
      ],
      sources: [
        {
          hook: 'useStats',
          file: 'web/src/pages/Customers.tsx',
          line: 5,
          flows: ['customerspage-search'],
          endpoints: ['GET /api/customers'],
          fields: ['lowStockCount'],
        },
      ],
      fields: [
        {
          field: 'lowStockCount',
          endpoint: 'GET /api/customers',
          made: [
            {
              code: 'lowStockCount: totals.low',
              file: 'api/src/stats.ts',
              line: 30,
              how: 'returned',
            },
          ],
        },
      ],
      conditions: [
        {
          code: 'isLoading',
          file: 'web/src/pages/Customers.tsx',
          line: 9,
          outcomes: ['Skeleton', 'the card'],
          where: 'around',
        },
        {
          code: 'pct >= 70 · pct >= 40',
          file: 'web/src/components/Stats.tsx',
          line: 18,
          outcomes: ['“Good”', '“Fair”', '“Low”'],
          where: 'card',
        },
      ],
    };
    cardResponse = (path) => {
      const link = new URL(path, 'http://x').searchParams.get('link');
      return {
        key: 'nav:menu/Customers/§Stock',
        label: 'Stock',
        data: link === null ? stats : { ...stats, calculations: [] },
        sharedWith: [],
      };
    };
    await reload({
      ...sidebar,
      entries: sidebar.entries.map((top) =>
        top.key === 'nav:menu/Customers'
          ? {
              ...top,
              children: [
                {
                  key: 'nav:menu/Customers/§Stock',
                  label: 'Stock',
                  kind: 'section',
                  file: 'web/src/components/Stats.tsx',
                  line: 12,
                  actions: [],
                  items: [{ link: { label: 'Low', to: '/orders', href: '/orders?filter=low' } }],
                  children: [],
                },
                {
                  key: 'nav:menu/Customers/§Worth',
                  label: 'Worth',
                  kind: 'section',
                  file: 'web/src/components/Stats.tsx',
                  line: 30,
                  actions: [],
                  children: [],
                },
                ...top.children,
              ],
            }
          : top,
      ),
    });
    entry('nav:menu/Customers')!.querySelector<HTMLElement>(':scope > summary')!.click();
    // A card with nothing in it is a row, not a fold; it still opens its tabs.
    expect(entry('nav:menu/Customers/§Worth')).toBeNull();
    const worth = document.querySelector<HTMLButtonElement>(
      '#flow-list .nav-card[data-key="nav:menu/Customers/§Worth"]',
    )!;
    expect(worth.textContent).toContain('shows data');
    worth.click();
    expect(document.querySelector('#flow-header h2')?.textContent).toBe('Worth');
    expect(document.querySelectorAll('#tabs .tab').length).toBe(6);
    expect(
      document
        .querySelector('#flow-list .nav-card[data-key="nav:menu/Customers/§Worth"]')
        ?.getAttribute('aria-selected'),
    ).toBe('true');
    entry('nav:menu/Customers/§Stock')!.querySelector<HTMLElement>(':scope > summary')!.click();
    expect(document.getElementById('tabs')?.hidden).toBe(false);
    expect(document.querySelectorAll('#tabs .tab').length).toBe(6);
    await vi.waitFor(() => {
      const docs = document.querySelector('#panel-docs')!;
      expect(docs.textContent).toContain('Stock shows data from GET /api/customers');
      expect(docs.textContent).toContain('How the data gets here');
      expect(docs.textContent).toContain('Where the server makes each field');
      expect(docs.textContent).toContain('lowStockCount: totals.low');
      expect(docs.textContent).toContain('Worked out in the browser');
      expect(docs.textContent).toContain('formatNumber(total)');
    });
    // The load that brings the data is stacked under it, in every tab.
    expect(document.querySelector('#panel-docs .stack-card')?.textContent).toBe(
      'Where its data comes from',
    );
    for (const tab of ['decisions', 'perf', 'tests', 'impact']) {
      document.querySelector<HTMLButtonElement>(`#tab-${tab}`)!.click();
      expect(
        [...document.querySelectorAll<HTMLElement>(`#panel-${tab} .stack-item`)].map(
          (item) => item.dataset['flowId'],
        ),
      ).toEqual(['customerspage-search']);
      expect(document.querySelector(`#panel-${tab} .card-data`)).not.toBeNull();
    }
    // The card's own checks are a chart: the screen around it waits on `isLoading` first.
    const chart = document.querySelector('#panel-decisions .card-chart')!;
    expect(chart.querySelector('.fc-diamond-text')?.textContent).toContain('isLoading?');
    expect(chart.textContent).toContain('Shows Skeleton instead — Stock is not drawn yet');
    expect(chart.textContent).toContain('Stock is drawn');
    expect(chart.querySelector('[data-fc="copy"]')).toBeNull();
    // A chain is one test inside the other, as it runs; every way carries on to the card.
    // (Boxes are made inner first, so the page order is not the reading order.)
    expect(
      [...chart.querySelectorAll('.fc-diamond-text .fc-label')].map((n) => n.textContent).sort(),
    ).toEqual(['isLoading?', 'pct >= 40?', 'pct >= 70?']);
    for (const word of ['The value is “Good”', 'The value is “Fair”', 'The value is “Low”'])
      expect(chart.textContent).toContain(word);

    // A link in the card is read for the number it shows first.
    document.querySelector<HTMLButtonElement>('#tab-docs')!.click();
    document.querySelector<HTMLButtonElement>('#flow-list .nav-link')!.click();
    await vi.waitFor(() => {
      const docs = document.querySelector('#panel-docs')!;
      expect(docs.textContent).toContain('“Low” shows lowStockCount from GET /api/customers');
      expect(docs.textContent).toContain('What clicking it does');
    });
    cardResponse = undefined;
  });

  it('keeps the list where it is when a row is clicked', async () => {
    await reload(sidebar);
    const scroller = document.querySelector<HTMLElement>('.sidebar')!;
    entry('nav:menu/Customers')!.querySelector<HTMLElement>(':scope > summary')!.click();
    scroller.scrollTop = 40;
    const scrolled = vi.fn();
    Element.prototype.scrollIntoView = scrolled;
    document.querySelector<HTMLButtonElement>('[data-flow-id="customerspage-archive"]')!.click();
    expect(scrolled).not.toHaveBeenCalled();
    expect(scroller.scrollTop).toBe(40);
  });

  it("finds everything under an entry by the entry's name", async () => {
    await reload(sidebar);
    const filter = document.getElementById('filter') as HTMLInputElement;
    filter.value = 'new customer';
    filter.dispatchEvent(new Event('input'));
    const rows = [...document.querySelectorAll<HTMLElement>('#flow-list .flow-item')];
    expect(rows.map((row) => row.dataset['flowId'])).toEqual(['customerform-create-customer']);
  });
});

describe('the dashboard labels a step by what it did', () => {
  it('says the database effect rather than "db op"', async () => {
    const dbFlow = flows.find((flow) => flow.collections.length > 0);
    expect(dbFlow).toBeDefined();

    const link = [...document.querySelectorAll('#flow-list [data-flow-id]')].find(
      (node) => node.getAttribute('data-flow-id') === dbFlow!.id,
    );
    if (link) (link as HTMLElement).click();
    await vi.waitFor(() => {
      expect(document.querySelectorAll('.node').length).toBeGreaterThan(0);
    });

    const text = [...document.querySelectorAll('.node')]
      .map((node) => node.textContent ?? '')
      .join(' ');
    // The effect, not the access: "write" on a delete is a wrong answer.
    expect(text).toMatch(/insert|update|delete|read|write/);
    // "db op" is the node kind; the tile must say what happened instead.
    expect(text).not.toContain('db op');
  });

  it('never leaves a step without a kind line', () => {
    const tiles = [...document.querySelectorAll('.node')];
    for (const tile of tiles) {
      expect((tile.textContent ?? '').trim().length).toBeGreaterThan(0);
    }
  });
});

/** Open the Docs tab's diagram view and wait for it to draw. */
async function openDiagram(): Promise<void> {
  await openTab('docs');
  document.querySelector<HTMLElement>('#panel-docs [data-doc-view="diagram"]')?.click();
  await vi.waitFor(() => {
    expect(document.getElementById('graph')?.hidden).toBe(false);
    expect(document.querySelectorAll('#graph .node').length).toBeGreaterThan(0);
  });
}

/** Click a tab and wait for its panel to be the visible one. */
async function openTab(id: string): Promise<HTMLElement> {
  const button = document.getElementById(`tab-${id}`) as HTMLElement | null;
  expect(button, `tab ${id} exists`).not.toBeNull();
  button!.click();
  const panel = document.querySelector<HTMLElement>(`[aria-labelledby="tab-${id}"]`)!;
  await vi.waitFor(() => {
    expect(panel.hidden).toBe(false);
  });
  return panel;
}

describe('the tabs', () => {
  it('offers the six tabs in the agreed order, with Docs open first', async () => {
    const labels = [...document.querySelectorAll('#tabs .tab-label')].map(
      (node) => node.textContent,
    );
    expect(labels).toEqual([
      'Docs',
      'Decisions',
      'Performance',
      'Tests',
      'Issues & impact',
      'Unused',
    ]);
    expect(document.getElementById('tab-docs')?.getAttribute('aria-selected')).toBe('true');
    expect(document.getElementById('panel-docs')?.hidden).toBe(false);
  });

  it('switches Docs between the list and the diagram, and only the diagram opens the inspector', async () => {
    const layout = document.querySelector('.layout')!;
    expect(layout.getAttribute('data-tab')).toBe('docs');
    expect(layout.hasAttribute('data-diagram')).toBe(false);
    await openDiagram();
    expect(layout.hasAttribute('data-diagram')).toBe(true);
    expect(document.getElementById('panel-docs')?.hidden).toBe(true);
    expect(layout.hasAttribute('data-inspecting')).toBe(false);
    document.querySelector<HTMLElement>('#graph .node')!.click();
    expect(layout.hasAttribute('data-inspecting')).toBe(true);
    document.querySelector<HTMLElement>('#details-close')!.click();
    expect(layout.hasAttribute('data-inspecting')).toBe(false);
    document.querySelector<HTMLElement>('#graph [data-doc-view="list"]')!.click();
    expect(document.getElementById('panel-docs')?.hidden).toBe(false);
    expect(document.getElementById('graph')?.hidden).toBe(true);
  });

  it('opens a file mentioned inside a diagram card in the editor, not the card', async () => {
    await openDiagram();
    const layout = document.querySelector('.layout')!;
    const link = document.querySelector<HTMLElement>('#graph .node [data-editor-href]')!;
    expect(link.dataset.editorHref).toMatch(/^vscode:\/\/file\/.+:\d+$/);
    const opened: string[] = [];
    const assign = vi.spyOn(window, 'location', 'get').mockReturnValue({
      ...window.location,
      set href(value: string) {
        opened.push(value);
      },
    } as Location);
    link.click();
    assign.mockRestore();
    // Every import of app.js in this file adds its document listener, so the
    // count is the number of loads; what matters is that only this link opened.
    expect(new Set(opened)).toEqual(new Set([link.dataset.editorHref]));
    expect(layout.hasAttribute('data-inspecting')).toBe(false);
  });

  it('sends links to the merged tabs where their content went', async () => {
    for (const [legacy, tab, diagram] of [
      ['flow', 'docs', true],
      ['apis', 'docs', false],
      ['timing', 'perf', false],
      ['queries', 'perf', false],
      ['changed', 'impact', false],
      ['breaks', 'impact', false],
      ['issues', 'impact', false],
    ] as const) {
      window.history.replaceState(null, '', `/#tab=${legacy}&flow=${flows[0]!.id}`);
      vi.resetModules();
      await import(resolve(publicDir, 'app.js') + `?legacy-${legacy}`);
      // All together: the tab can already be selected from the load before.
      // Waiting out the insight request too leaves this load idle, so it cannot
      // rewrite the URL while the next one is being imported.
      await vi.waitFor(() => {
        expect(document.getElementById(`tab-${tab}`)?.getAttribute('aria-selected')).toBe('true');
        expect(document.getElementById('graph')?.hidden).toBe(!diagram);
        expect(document.querySelector('#tab-tests .tab-badge')?.textContent).not.toBe('…');
      });
    }
  });

  it('shows only one panel at a time', async () => {
    await openTab('impact');
    const visible = [...document.querySelectorAll('.canvas .panel')].filter(
      (panel) => !panel.hidden,
    );
    expect(visible).toHaveLength(1);
    expect(visible[0]?.getAttribute('aria-labelledby')).toBe('tab-impact');
  });

  it('puts the worrying number on the tab itself, before it is opened', () => {
    // The example app has no trace and no tests of its own, and that is exactly
    // what the badges must say without the user clicking anything.
    expect(document.querySelector('#tab-perf .tab-badge')?.textContent?.trim()).toBe('not run');
    expect(document.querySelector('#tab-tests .tab-badge')?.textContent?.trim()).toBe('none');
    const breaks = document.querySelector('#tab-impact .tab-badge');
    expect(breaks?.textContent?.trim()).toBeTruthy();
  });

  it('every panel opens with a sentence saying what it answers', async () => {
    for (const id of ['perf', 'impact', 'tests']) {
      const panel = await openTab(id);
      // Some tabs fetch on open; the sentence comes with the answer.
      await vi.waitFor(() => {
        const intro = panel.querySelector('.panel-intro, .empty-state p');
        expect((intro?.textContent ?? '').length, `${id} explains itself`).toBeGreaterThan(20);
      });
    }
  });

  it('puts your own edits first, then what a change to this action would reach', async () => {
    const panel = await openTab('impact');
    await vi.waitFor(() => {
      expect(panel.querySelector('.impact-yours')?.textContent).toContain(
        'Your uncommitted changes',
      );
      // The mocked change touches files but breaks nothing.
      expect(panel.querySelector('.impact-yours .answer')?.textContent).toMatch(
        /Nothing that existed/,
      );
    });
    const yours = panel.querySelector('.impact-yours')!;
    const before = panel.querySelector('.impact-before')!;
    expect(before.textContent).toContain('Before you change');
    expect(yours.compareDocumentPosition(before) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    // The file-level list is still there, folded, for what the compiler cannot judge.
    expect(yours.querySelector('details.broad summary')?.textContent).toMatch(/Files you touched/);
    expect(panel.textContent).not.toMatch(/Could not check/);
  });

  it('lists breaks by page and component, in plain words, each reason once', async () => {
    const reach = {
      features: [{ id: flows[0]!.id, title: 'Medicine detail page loads' }],
      pages: ['/medicines/[id]'],
      components: ['MedicineDetailPage'],
      apis: ['GET /medicines/:param'],
      services: [],
    };
    const error = (line: number) => ({
      file: 'app/medicines/[id]/page.tsx',
      line,
      column: 5,
      code: 'TS2554',
      message: 'Expected 2-3 arguments, but got 1.',
      explain: 'Missing `currency` — `formatCurrency` now needs it as argument 2.',
      source: `formatCurrency(price${line})`,
      reach,
    });
    const usage = (line: number) => ({
      file: 'app/medicines/[id]/page.tsx',
      line,
      column: 5,
      source: `formatCurrency(price${line})`,
      in: 'MedicineDetailPage',
      verdict: 'broken',
      reason: 'The compiler reports a new error on this line.',
      errors: [error(line)],
      reach,
    });
    breakageResponse = {
      against: 'the last commit',
      symbols: [
        {
          name: 'formatCurrency',
          kind: 'function',
          file: 'lib/utils.ts',
          line: 47,
          change: 'signature',
          details: ['New required parameter `currency: string` at position 2.'],
          before: '(value: number) => string',
          after: '(value: number, currency: string) => string',
          usages: [usage(96), usage(97)],
          errors: [],
          reach,
          breaks: reach,
        },
      ],
      otherErrors: [],
      totals: { symbols: 1, broken: 2, likely: 0, review: 0, errors: 2 },
      typeChecked: true,
      checkedFiles: 3,
      durationMs: 1200,
      level: 'high',
      summary: '1 declaration changed.',
      notes: [],
    };
    await loadDashboard();
    const panel = await openTab('impact');
    await vi.waitFor(() => {
      expect(panel.querySelector('.impact-yours .answer')?.textContent).toContain(
        'Your change breaks 2 places on 1 page',
      );
    });
    expect(document.querySelector('#tab-impact .tab-badge')?.textContent).toBe('2 breaking');
    const page = panel.querySelector('.broken-page')!;
    expect(page.querySelector('.broken-page-name')?.textContent).toBe('/medicines/[id]');
    expect(page.querySelector('.broken-component-name')?.textContent).toBe('MedicineDetailPage');
    // Two calls failing for one reason: said once, both lines listed under it.
    const lines = page.querySelectorAll('.broken-line');
    expect(lines).toHaveLength(1);
    expect(lines[0]!.querySelector('.broken-text')?.textContent).toBe(
      'Missing currency — formatCurrency now needs it as argument 2.',
    );
    expect(lines[0]!.querySelectorAll('.broken-sites li')).toHaveLength(2);
    expect(lines[0]!.textContent).toContain('Expected 2-3 arguments, but got 1.');
    // The card does not repeat the list above it: it starts folded.
    expect(panel.querySelector('details.break-card')?.hasAttribute('open')).toBe(false);
  });
});

describe('the Decisions tab', () => {
  async function openChart(): Promise<HTMLElement> {
    const panel = await openTab('decisions');
    await vi.waitFor(() => {
      expect(panel.querySelector('.fc-stage .fc-node')).not.toBeNull();
    });
    return panel;
  }

  it('draws the action as a flowchart, from the click to the database', async () => {
    const panel = await openChart();
    // Starts at the click, in words; the request is a frame of its own.
    expect(panel.querySelector('.fc-step.kind-trigger')?.textContent).toMatch(/The user|opens/);
    expect(panel.querySelector('.fc-frame-head.kind-request')?.textContent).toMatch(
      /Send (GET|POST|PUT|PATCH|DELETE) \/\S+ to the server/,
    );
    // Shapes and connectors are drawn, not listed.
    expect(panel.querySelector('svg.fc-svg rect.fc-frame.kind-request')).not.toBeNull();
    expect(panel.querySelectorAll('svg.fc-svg path.fc-edge').length).toBeGreaterThan(2);
    expect(panel.querySelector('.answer-title')?.textContent).toMatch(/decide|straight/);
    const badge = document.querySelector('#tab-decisions .tab-badge')?.textContent?.trim();
    expect(badge).toMatch(/branch|straight/);
  });

  it('labels each step in words, and shows the code underneath on request', async () => {
    const panel = await openChart();
    // Words first: a reader who does not read code is not handed any.
    expect(panel.querySelector('.fc-stage .fc-code')).toBeNull();
    const toggle = panel.querySelector<HTMLInputElement>('[data-fc-option="showCode"]')!;
    toggle.checked = true;
    toggle.dispatchEvent(new Event('change'));
    expect(panel.querySelector('.fc-stage .fc-step .fc-code')).not.toBeNull();
    toggle.checked = false;
    toggle.dispatchEvent(new Event('change'));
    expect(panel.querySelector('.fc-stage .fc-code')).toBeNull();
  });

  it('keeps the action list beside the chart', async () => {
    await openChart();
    const sidebar = document.querySelector<HTMLElement>('.layout .sidebar')!;
    expect(document.querySelector('.layout')?.hasAttribute('data-wide')).toBe(false);
    expect(sidebar.hidden).toBe(false);
    expect(sidebar.querySelectorAll('#flow-list > *').length).toBeGreaterThan(0);
  });

  it('folds helpers into one box and opens them again, but never folds the request', async () => {
    const panel = await openChart();
    panel.querySelector<HTMLElement>('[data-fc="open"]')!.click();
    expect(panel.querySelector('.fc-folded')).toBeNull();
    const opened = panel.querySelectorAll('.fc-frame-head[data-fc-toggle]').length;
    panel.querySelector<HTMLElement>('[data-fc="close"]')!.click();
    expect(panel.querySelector('.fc-frame-head.kind-request')).not.toBeNull();
    expect(panel.querySelectorAll('.fc-frame-head[data-fc-toggle]').length).toBeLessThanOrEqual(
      opened,
    );
  });

  it('zooms the chart without redrawing it', async () => {
    const panel = await openChart();
    panel.querySelector<HTMLElement>('[data-fc="in"]')!.click();
    expect(panel.querySelector('.fc-zoom')?.textContent).toBe('110%');
    expect(panel.querySelector<HTMLElement>('.fc-stage')?.style.transform).toBe('scale(1.1)');
    panel.querySelector<HTMLElement>('[data-fc="reset"]')!.click();
    expect(panel.querySelector('.fc-zoom')?.textContent).toBe('100%');
  });
});

describe('Issues & impact', () => {
  it('answers its three questions up front, each opening its section', async () => {
    const panel = await openTab('impact');
    await vi.waitFor(() => {
      expect(panel.querySelectorAll('.impact-card')).toHaveLength(3);
      // Every card has an answer, not a placeholder.
      for (const card of panel.querySelectorAll('.impact-card-value')) {
        expect(card.textContent).not.toMatch(/…$/);
      }
    });
    const sections = [...panel.querySelectorAll<HTMLDetailsElement>('[data-impact-section]')].map(
      (section) => section.dataset['impactSection'],
    );
    expect(sections).toEqual(['impact-yours', 'impact-issues', 'impact-before', 'impact-project']);

    const yours = panel.querySelector<HTMLDetailsElement>('[data-impact-section="impact-yours"]')!;
    yours.open = false;
    panel.querySelector<HTMLElement>('[data-impact-jump="impact-yours"]')!.click();
    expect(yours.open).toBe(true);
  });

  it('shows the selected action’s issues, then the rest of the project with filters', async () => {
    const panel = await openTab('impact');
    await vi.waitFor(() => {
      expect(panel.querySelector('.impact-issues .answer')).not.toBeNull();
    });
    expect(panel.querySelector('.impact-issues .answer-title')?.textContent).toMatch(
      /issue|No issues found/,
    );
    expect(panel.textContent).toContain('Issues everywhere else in the project');
    expect(panel.querySelectorAll('#project-issues [data-issue-severity]')).toHaveLength(3);

    // A filter redraws the project list and leaves the rest of the tab alone.
    const before = panel.querySelector('.impact-overview');
    panel.querySelector<HTMLElement>('#project-issues [data-issue-severity="low"]')!.click();
    expect(panel.querySelector('.impact-overview')).toBe(before);
    expect(
      panel
        .querySelector('#project-issues [data-issue-severity="low"]')
        ?.getAttribute('aria-pressed'),
    ).toBe('true');

    const badge = document.querySelector('#tab-impact .tab-badge')?.textContent?.trim();
    expect(badge).toBeTruthy();
    expect(badge).not.toBe('…');
  });
});

describe('the Performance tab', () => {
  it('explains how to get numbers rather than inventing them', async () => {
    const panel = await openTab('perf');
    await vi.waitFor(() => {
      expect(panel.querySelector('.answer')).not.toBeNull();
    });
    const text = panel.textContent ?? '';
    expect(text).toContain('has not been run with tracing on');
    expect(text).toContain('@flowslens/runtime');
    // No fabricated milliseconds anywhere in an unmeasured flow.
    expect(panel.querySelector('.timing-table')).toBeNull();
    expect(panel.querySelector('.q-howto')?.hasAttribute('open')).toBe(true);
  });

  it('lists each query of a database action with its code', async () => {
    const dbFlow = flows.find((flow) => flow.collections.length > 0)!;
    const item = [...document.querySelectorAll<HTMLElement>('#flow-list [data-flow-id]')].find(
      (node) => node.getAttribute('data-flow-id') === dbFlow.id,
    );
    item?.click();
    const panel = await openTab('perf');
    await vi.waitFor(() => {
      expect(panel.querySelectorAll('.q-item').length).toBeGreaterThan(0);
    });
    expect(panel.querySelector('.q-code')?.textContent).toMatch(
      /\.(find|findOne|save|create|insertOne|updateOne|deleteOne|findById\w*)\(/,
    );
    expect(panel.querySelector('.q-time')?.textContent).toContain('Not measured yet');
  });
});

describe('the Impact tab, before a change', () => {
  it('leads with the answer in a sentence, before any table', async () => {
    const panel = await openTab('impact');
    const verdict = panel.querySelector('.impact-before .answer');
    expect(verdict).not.toBeNull();
    expect(verdict?.className).toMatch(/tone-(ok|warn|danger)/);
    expect((verdict?.textContent ?? '').trim().length).toBeGreaterThan(30);
    const table = panel.querySelector('.impact-before .adoc-table');
    if (table) {
      expect(
        verdict!.compareDocumentPosition(table) & Node.DOCUMENT_POSITION_FOLLOWING,
      ).toBeTruthy();
    }
  });

  it('names the other features a change here would reach', async () => {
    const panel = await openTab('impact');
    const jumps = panel.querySelectorAll('.impact-before [data-goto-flow]');
    expect(jumps.length).toBeGreaterThan(0);
    // Never offers to jump to the feature already open.
    const current = state('selectedFlowId');
    for (const jump of jumps) {
      expect(jump.getAttribute('data-goto-flow')).not.toBe(current);
    }
  });

  it('shows shared steps with the file to open', async () => {
    const panel = await openTab('impact');
    const steps = panel.querySelectorAll('.shared-step');
    expect(steps.length).toBeGreaterThan(0);
    // A path you can click, not just read: the editor link when a root is
    // known, a plain code span otherwise.
    expect(
      panel.querySelector('.shared-step .shared-file a, .shared-step .shared-file code'),
    ).not.toBeNull();
  });

  it('warns about a collection several places write', async () => {
    const panel = await openTab('impact');
    expect(panel.textContent).toContain('customers');
    const answers = [...panel.querySelectorAll('.answer')].map((node) => node.textContent ?? '');
    expect(answers.some((text) => text.includes('Shared data'))).toBe(true);
  });

  it('jumping to another feature switches the selection and keeps the tab', async () => {
    const panel = await openTab('impact');
    const jump = panel.querySelector<HTMLElement>('.impact-before [data-goto-flow]')!;
    const target = jump.dataset.gotoFlow;
    jump.click();
    await vi.waitFor(() => {
      expect(state('selectedFlowId')).toBe(target);
    });
    // Still on Impact, now for the feature that was clicked.
    expect(document.getElementById('tab-impact')?.getAttribute('aria-selected')).toBe('true');
    expect(
      document.querySelector('.flow-item[aria-selected="true"]')?.textContent ?? '',
    ).toBeTruthy();
  });
});

describe('the Unused tab', () => {
  it('lists what nothing uses, for the whole project, with the endpoints nothing calls', async () => {
    const panel = await openTab('unused');
    await vi.waitFor(() => {
      expect(panel.textContent).toContain('Endpoints no frontend calls');
    });
    const text = panel.textContent ?? '';
    // The example's archive route is called with PUT but served as PATCH.
    expect(text).toContain('PATCH /customers/:param/archive');
    // The schemas Nest never registers are exports nothing imports.
    expect(text).toContain('CustomerSchema');
    expect(document.getElementById('tab-unused')?.textContent).toMatch(/\d|clean/);
  });
});

describe('the Database page', () => {
  it('opens from the navbar, lists the collections, opens one, and jumps back to an action', async () => {
    document.querySelector<HTMLElement>('[data-page="database"]')!.click();
    const panel = document.getElementById('panel-database')!;
    expect(document.getElementById('page-database')?.hidden).toBe(false);
    expect(document.querySelector<HTMLElement>('.layout')?.hidden).toBe(true);
    expect(window.location.hash).toBe('#page=database');
    await vi.waitFor(() => {
      expect(panel.textContent).toContain('4 collections');
    });
    expect(document.getElementById('page-database-count')?.textContent).toBe('4');
    // Not a tab of an action any more.
    expect(document.getElementById('tab-database')).toBeNull();
    // The health check says what is worth fixing, in words; the diagram draws the links.
    const health = [...panel.querySelectorAll('.db-health-group > summary')].map(
      (x) => x.textContent,
    );
    expect(health.some((text) => /delete leaves linked records behind/.test(text ?? ''))).toBe(
      true,
    );
    expect(health.some((text) => /no index/.test(text ?? ''))).toBe(true);
    // The map: a row per collection in its group; hovering one draws its links.
    const mapRows = [...panel.querySelectorAll<HTMLElement>('.db-map2 .db-row2')];
    expect(mapRows.map((row) => row.dataset.dbNode)).toEqual(
      expect.arrayContaining(['customers', 'orders']),
    );
    const ordersRow = mapRows.find((row) => row.dataset.dbNode === 'orders')!;
    ordersRow.dispatchEvent(new Event('mouseenter'));
    expect(panel.querySelector('.db-map2-lines .is-guess title')?.textContent).toContain(
      'orders.customerId → customers',
    );
    // …with the key each link is joined by, on the line and in words above the map.
    expect(panel.querySelector('.db-map2-lines .is-guess text')?.textContent).toBe('customerId');
    expect(panel.querySelector('[data-db-map-info]')?.textContent).toContain(
      'points to customers by customerId',
    );
    expect(
      panel.querySelector('.db-map2.has-focus .db-row2.is-linked')?.getAttribute('data-db-node'),
    ).toBe('customers');
    ordersRow.dispatchEvent(new Event('mouseleave'));
    expect(panel.querySelector('.db-map2-lines path')).toBeNull();

    const search = panel.querySelector<HTMLInputElement>('[data-db-filter]')!;
    search.value = 'phone';
    search.dispatchEvent(new Event('input'));
    const shown = [...panel.querySelectorAll<HTMLElement>('[data-db-row]')].filter(
      (row) => !row.hidden,
    );
    expect(shown.map((row) => row.querySelector('button')?.textContent)).toEqual(['customers']);
    expect(shown[0]!.querySelector('.db-field-hit')?.textContent).toBe('Has phone');
    // A form label finds the field it is saved into.
    search.value = 'full name';
    search.dispatchEvent(new Event('input'));
    const byLabel = [...panel.querySelectorAll<HTMLElement>('[data-db-row]')].find(
      (row) => !row.hidden,
    )!;
    expect(byLabel.querySelector('.db-field-hit')?.textContent).toContain('name (typed in as');
    // The overview comes without each write's cases: they arrive for the collections the results are in.
    await vi.waitFor(() =>
      expect(panel.querySelector('[data-db-results] .db-cases-loading')).toBeNull(),
    );
    // …and the result says how the form field and the stored key connect.
    const result = panel.querySelector<HTMLElement>('[data-db-results] .db-result')!;
    expect(result.querySelector('.db-result-title')?.textContent).toContain('customers.name');
    const chain = [...result.querySelectorAll('.db-chain-kind')].map((kind) => kind.textContent);
    expect(chain).toEqual(['Typed into', 'Sent in', 'Saved by', 'Stored as', 'Shown in']);
    expect(result.textContent).toContain('POST /customers');
    expect(result.textContent).toContain('Where its value comes from');
    // The card answers the questions first; everything else sits under Code details.
    const card = result.querySelector<HTMLElement>('.db-field-body')!;
    const rows = [...card.querySelectorAll(':scope > .db-row > .db-row-label')].map(
      (l) => l.textContent,
    );
    expect(rows).toEqual(expect.arrayContaining(['Gets in', 'Shown']));
    const cases = [...card.querySelectorAll('.db-cases tbody tr')].map(
      (tr) => tr.textContent ?? '',
    );
    expect(cases.some((text) => /Create Customer/.test(text) && /set from/.test(text))).toBe(true);
    expect(cases.some((text) => /removed with the record/.test(text))).toBe(true);
    expect(card.querySelector(':scope > details.db-code > summary')?.textContent).toMatch(
      /^Code details/,
    );
    expect(result.textContent).toContain('APIs that use it');
    expect(result.textContent).toContain('saves it');
    // A long result list folds after ten; `+N more` shows the rest in place, and folds it back.
    search.value = 'e';
    search.dispatchEvent(new Event('input'));
    const visibleResults = () =>
      [...panel.querySelectorAll<HTMLElement>('[data-db-results] .db-result')].filter(
        (r) => !r.hidden,
      );
    expect(visibleResults()).toHaveLength(10);
    const more = [
      ...panel.querySelectorAll<HTMLButtonElement>(
        '[data-db-results] > .db-more-row > [data-db-more]',
      ),
    ][0]!;
    const total = panel.querySelectorAll('[data-db-results] .db-result').length;
    expect(more.textContent).toBe(`+${total - 10} more`);
    more.click();
    expect(visibleResults()).toHaveLength(total);
    expect(more.textContent).toBe('Show fewer');
    more.click();
    expect(visibleResults()).toHaveLength(10);
    search.value = 'phone';
    search.dispatchEvent(new Event('input'));

    // A count tile opens its collection on that box, picked out.
    panel
      .querySelector<HTMLElement>('[data-db-collection="customers"][data-db-life="create"]')!
      .click();
    expect(panel.querySelector('.db-life.effect-create.is-picked [data-goto-flow]')).not.toBeNull();
    panel.querySelector<HTMLElement>('[data-db-collection=""]')!.click();
    panel.querySelector<HTMLElement>('[data-db-collection="orders"]')!.click();
    const text = panel.textContent ?? '';
    expect(text).toContain('no schema checks it');
    expect(text).toContain('guessed from the name');
    expect(panel.querySelector('[data-goto-flow="orderform-submit-order"]')).not.toBeNull();

    // A link to another collection opens it.
    panel.querySelector<HTMLElement>('td [data-db-collection="customers"]')!.click();
    expect(panel.textContent).toContain('required · indexed');
    // An example record shows the shape, with placeholders for the values.
    expect(panel.querySelector('.db-example pre')?.textContent).toContain('"phone": "text"');
    // The page opens on what happens to the records, in four boxes, before any field.
    expect([...panel.querySelectorAll('.db-life-head')].map((h) => h.textContent?.trim())).toEqual([
      '➕ Added',
      '✎ Changed',
      '🗑 Removed',
      '👁 Read',
    ]);
    expect(panel.querySelector('.db-life.effect-create [data-goto-flow]')).not.toBeNull();
    // Each field opens on plain sentences: what it is, then where the user types it.
    const phone = [...panel.querySelectorAll('.db-field')].find(
      (field) => field.querySelector('.db-field-name')?.textContent === 'phone',
    )!;
    const plain = phone.querySelector('.db-field-body > .db-plain')?.textContent ?? '';
    expect(plain).toContain('kept in every customers record');
    expect(plain).toContain('it must always be set');
    expect(panel.textContent).toContain('Where its value comes from');

    // An action named here opens on the flows page.
    panel.querySelector<HTMLElement>('[data-goto-flow]')!.click();
    expect(document.getElementById('page-database')?.hidden).toBe(true);
    expect(document.querySelector<HTMLElement>('.layout')?.hidden).toBe(false);
    expect(window.location.hash).toContain('flow=');
  });
});

describe('the Tests tab', () => {
  it('says plainly when nothing guards the feature', async () => {
    const panel = await openTab('tests');
    const text = panel.textContent ?? '';
    expect(text).toContain('No test covers this action');
    expect(text).toContain('would not fail the suite');
    // …and says what a test would have to reach.
    expect(panel.querySelectorAll('.adoc-table tbody tr').length).toBeGreaterThan(0);
  });

  it('lists the tests to write first, with a skeleton to copy', async () => {
    const panel = await openTab('tests');
    await vi.waitFor(() => {
      expect(panel.textContent).toContain('Tests to write first');
    });
    const skeleton = panel.querySelector('.command.skeleton code')?.textContent ?? '';
    expect(skeleton).toContain('describe(');
    expect(skeleton).toContain('it.todo(');
    expect(panel.querySelector('.command.skeleton [data-copy]')?.getAttribute('data-copy')).toBe(
      skeleton,
    );
  });
});

/**
 * Read a fact out of the running page rather than out of the module's private
 * state: the dashboard is a script, not an exported API.
 */
function state(what: 'selectedFlowId'): string | undefined {
  if (what === 'selectedFlowId') {
    const link = document.getElementById('doc-link') as HTMLAnchorElement | null;
    const value = link?.getAttribute('href') ?? '';
    return new URL(value, 'http://x').searchParams.get('flow') ?? undefined;
  }
  return undefined;
}

/**
 * The Docs tab.
 *
 * One action, end to end. What is worth pinning is what would quietly make it
 * useless: documenting something other than the selected action, losing a
 * stage, or showing Markdown punctuation instead of styled text.
 */
describe('the Docs tab', () => {
  it('carries what the APIs tab used to add: a command to try the request, and who else calls it', async () => {
    const backend = flows.find((flow) => flow.hitsBackend)!;
    [...document.querySelectorAll<HTMLElement>('#flow-list [data-flow-id]')]
      .find((node) => node.getAttribute('data-flow-id') === backend.id)
      ?.click();
    const panel = await openTab('docs');
    await vi.waitFor(() => {
      expect(panel.querySelector('[data-stage="request"] .command code')).not.toBeNull();
    });
    const request = panel.querySelector('[data-stage="request"]')!.textContent ?? '';
    expect(request).toContain('curl -X');
    expect(request).toContain('Who else calls this endpoint');
  });

  it('draws only the steps the action has, numbered without gaps, and names the rest', async () => {
    const panel = await openTab('docs');
    await vi.waitFor(() => {
      expect(panel.querySelectorAll('.adoc-stage').length).toBeGreaterThan(0);
    });
    const drawn = panel.querySelectorAll('.adoc-stage').length;
    const numbers = [...panel.querySelectorAll('.glance-num')].map((node) => node.textContent);
    expect(numbers).toEqual(Array.from({ length: drawn }, (_, i) => String(i + 1)));
    // Every one of the nineteen is either drawn or listed as not in this action.
    expect(drawn + panel.querySelectorAll('.adoc-absent li').length).toBe(19);
    expect(panel.querySelector('.adoc-stage .glance-title')?.textContent).toBe('User opens page');
  });

  it('names no missing steps for what loads by itself as the page opens', async () => {
    vi.unstubAllGlobals();
    flowsResponse = flows.map((flow) =>
      flow.id === 'customerspage-search' ? { ...flow, event: 'mount' } : flow,
    );
    await loadDashboard();
    document.querySelector<HTMLElement>('[data-flow-id="customerspage-search"]')!.click();
    const panel = await openTab('docs');
    await vi.waitFor(() => {
      expect(panel.querySelectorAll('.adoc-stage').length).toBeGreaterThan(0);
    });
    expect(panel.querySelector('.adoc-absent')).toBeNull();
  });

  it('writes styled text, not markup', async () => {
    const panel = await openTab('docs');
    await vi.waitFor(() => {
      expect(panel.querySelector('.adoc-lines')).not.toBeNull();
    });
    const text = panel.querySelector('.adoc')?.textContent ?? '';
    expect(text).not.toContain('`');
    expect(text).not.toContain('**');
    expect(panel.querySelectorAll('.adoc code').length).toBeGreaterThan(0);
  });

  it('opens with the whole action at a glance, grouped by where it happens', async () => {
    const panel = await openTab('docs');
    await vi.waitFor(() => {
      expect(panel.querySelectorAll('.glance-steps > li')).toHaveLength(
        panel.querySelectorAll('.adoc-stage').length,
      );
      expect(panel.querySelectorAll('.glance-steps > li').length).toBeGreaterThan(0);
    });
    const phases = [...panel.querySelectorAll('.glance-phase-title')].map(
      (node) => node.textContent,
    );
    expect(phases[0]).toContain('In the browser');
    expect(phases.at(-1)).toContain('The way back');
    // Every stage's detail lives inside its line, closed until asked for.
    const glance = panel.querySelector('.adoc-glance')!;
    const stages = panel.querySelectorAll('.adoc-stage');
    expect(glance.querySelectorAll('.adoc-stage')).toHaveLength(stages.length);
    expect(panel.querySelectorAll('.adoc-stage.is-collapsed')).toHaveLength(stages.length);

    const first = stages[0]!;
    first.querySelector<HTMLButtonElement>('.adoc-head')!.click();
    expect(first.classList.contains('is-collapsed')).toBe(false);
    expect(first.querySelector('.adoc-head')?.getAttribute('aria-expanded')).toBe('true');
  });

  it('shows facts of the same shape as tables', async () => {
    const panel = await openTab('docs');
    await vi.waitFor(() => {
      expect(panel.querySelectorAll('.adoc-table').length).toBeGreaterThan(0);
    });
    expect(panel.querySelector('.adoc-table th')).not.toBeNull();
  });

  it('follows the selection to another action', async () => {
    const panel = await openTab('docs');
    const lede = (): string => panel.querySelector('.adoc-lede')?.textContent ?? '';
    await vi.waitFor(() => {
      expect(panel.querySelectorAll('.adoc-stage').length).toBeGreaterThan(0);
    });
    const before = lede();

    const other = flows.find((flow) => flow.title !== flows[0]?.title)!;
    const item = document.querySelector<HTMLElement>(`.flow-item[data-flow-id="${other.id}"]`)!;
    item.click();
    await vi.waitFor(() => {
      expect(lede()).not.toBe(before);
      expect(lede()).not.toBe('');
    });
  });

  it('collapses and expands every stage', async () => {
    const panel = await openTab('docs');
    await vi.waitFor(() => {
      expect(panel.querySelector('#doc-toggle')).not.toBeNull();
      expect(panel.querySelectorAll('.adoc-stage').length).toBeGreaterThan(0);
    });
    const drawn = panel.querySelectorAll('.adoc-stage').length;
    expect(panel.querySelectorAll('.adoc-stage.is-collapsed')).toHaveLength(drawn);
    panel.querySelector<HTMLButtonElement>('#doc-toggle')!.click();
    expect(panel.querySelectorAll('.adoc-stage.is-collapsed')).toHaveLength(0);
    panel.querySelector<HTMLButtonElement>('#doc-toggle')!.click();
    expect(panel.querySelectorAll('.adoc-stage.is-collapsed')).toHaveLength(drawn);
  });

  it('opens straight onto an action from a #docs= link', async () => {
    const other = flows.find((flow) => flow.id !== flows[0]?.id)!;
    window.history.replaceState(null, '', `/#docs=${other.id}`);
    vi.resetModules();
    await import(resolve(publicDir, 'app.js') + '?deep-link');
    await vi.waitFor(() => {
      const href = document.querySelector('#panel-docs .doc-bar a')?.getAttribute('href') ?? '';
      expect(new URL(href, 'http://x').searchParams.get('flow')).toBe(other.id);
    });
    expect(document.getElementById('panel-docs')?.hidden).toBe(false);
  });

  it('follows a link pasted into the address bar without a reload', async () => {
    await openTab('docs');
    const other = flows.find((flow) => flow.id !== flows[0]?.id)!;
    window.location.hash = `tab=decisions&flow=${other.id}`;
    window.dispatchEvent(new HashChangeEvent('hashchange'));
    await vi.waitFor(() => {
      expect(new URLSearchParams(window.location.hash.slice(1)).get('flow')).toBe(other.id);
      expect(document.getElementById('panel-decisions')?.hidden).toBe(false);
      expect(document.getElementById('panel-docs')?.hidden).toBe(true);
    });
  });

  it('links to the Markdown of the same action', async () => {
    const panel = await openTab('docs');
    await vi.waitFor(() => {
      expect(panel.querySelector('.doc-bar a')).not.toBeNull();
    });
    const href = panel.querySelector('.doc-bar a')?.getAttribute('href') ?? '';
    const url = new URL(href, 'http://x');
    expect(url.pathname).toBe('/api/action');
    expect(url.searchParams.get('flow')).toBe(flows[0]?.id);
    expect(url.searchParams.get('format')).toBe('markdown');
  });
});
