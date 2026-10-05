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
  renderActionDocument,
  resolveFlows,
  scan,
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

/** Set by a test to answer `/api/changed/breakage` with a report of its own. */
let breakageResponse: unknown;

/** What the real server answers, from a real graph. */
function apiResponse(path: string): unknown {
  if (path.startsWith('/api/graph')) return graph;
  if (path.startsWith('/api/flows')) return flows;
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
  if (path.startsWith('/api/queries')) {
    const flow = flows.find(
      (candidate) => candidate.id === new URL(path, 'http://x').searchParams.get('flow'),
    );
    return flow ? actionQueries(scanned.graph, flow) : { error: 'unknown flow' };
  }
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

    const fold = document.getElementById('fold-all') as HTMLButtonElement;
    expect(fold.hidden).toBe(false);
    fold.click();
    expect(
      [...document.querySelectorAll<HTMLDetailsElement>('#flow-list .page-group')].some(
        (group) => group.open,
      ),
    ).toBe(false);
    expect(fold.textContent).toBe('Expand all');
    fold.click();
    expect(
      [...document.querySelectorAll<HTMLDetailsElement>('#flow-list .page-group')].every(
        (group) => group.open,
      ),
    ).toBe(true);
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
      await vi.waitFor(() => {
        expect(document.getElementById(`tab-${tab}`)?.getAttribute('aria-selected')).toBe('true');
      });
      expect(document.getElementById('graph')?.hidden).toBe(!diagram);
    }
  });

  it('shows only one panel at a time', async () => {
    await openTab('impact');
    const visible = [...document.querySelectorAll('.panel')].filter((panel) => !panel.hidden);
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
