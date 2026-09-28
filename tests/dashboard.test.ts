// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  projectFindings,
  actionQueries,
  analyzeChanged,
  analyzeFlowImpact,
  explainAction,
  flowApis,
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
const flows = resolveFlows(scanned.graph).map((flow) => ({ ...flow }));

/** What the real server answers, from a real graph. */
function apiResponse(path: string): unknown {
  if (path.startsWith('/api/graph')) return graph;
  if (path.startsWith('/api/flows')) return flows;
  if (path.startsWith('/api/doctor')) {
    return { brokenCalls: [], deadEndpoints: [], sharedWrites: [] };
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
    expect(document.querySelectorAll('#tabs .tab').length).toBe(7);
    expect(document.querySelector('#tab-impact .tab-badge')).not.toBeNull();
  });
}

beforeEach(async () => {
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
    const text = document.getElementById('flow-list')?.textContent ?? '';
    for (const flow of flows.slice(0, 3)) {
      expect(text).toContain(flow.title);
    }
    // Every row keeps its detail line: how it is triggered, where, what it calls.
    for (const item of document.querySelectorAll('#flow-list .flow-item')) {
      expect(item.querySelector('.meta')?.textContent?.trim()).toBeTruthy();
    }
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
  it('offers the seven tabs in the agreed order, with Docs open first', async () => {
    const labels = [...document.querySelectorAll('#tabs .tab-label')].map(
      (node) => node.textContent,
    );
    expect(labels).toEqual([
      'Docs',
      'Issues',
      'Performance',
      'Tests',
      'Changed',
      'Breaks',
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
    for (const id of ['issues', 'perf', 'impact', 'tests', 'changed']) {
      const panel = await openTab(id);
      // Some tabs fetch on open; the sentence comes with the answer.
      await vi.waitFor(() => {
        const intro = panel.querySelector('.panel-intro, .empty-state p');
        expect((intro?.textContent ?? '').length, `${id} explains itself`).toBeGreaterThan(20);
      });
    }
  });
});

describe('the Issues tab', () => {
  it('shows the selected action first, then the rest of the project with filters', async () => {
    const panel = await openTab('issues');
    await vi.waitFor(() => {
      expect(panel.querySelector('.answer')).not.toBeNull();
    });
    expect(panel.querySelector('.answer-title')?.textContent).toMatch(/issue|No issues found/);
    expect(panel.textContent).toContain('Everywhere else in the project');
    expect(panel.querySelectorAll('[data-issue-severity]')).toHaveLength(3);
    const badge = document.querySelector('#tab-issues .tab-badge')?.textContent?.trim();
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

describe('the Breaks tab', () => {
  it('leads with the answer in a sentence, before any table', async () => {
    const panel = await openTab('impact');
    const verdict = panel.querySelector('.answer');
    expect(verdict).not.toBeNull();
    expect(verdict?.className).toMatch(/tone-(ok|warn|danger)/);
    expect((verdict?.textContent ?? '').trim().length).toBeGreaterThan(30);
    const table = panel.querySelector('.adoc-table');
    if (table) {
      expect(
        verdict!.compareDocumentPosition(table) & Node.DOCUMENT_POSITION_FOLLOWING,
      ).toBeTruthy();
    }
  });

  it('names the other features a change here would reach', async () => {
    const panel = await openTab('impact');
    const jumps = panel.querySelectorAll('[data-goto-flow]');
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
    const jump = panel.querySelector<HTMLElement>('[data-goto-flow]')!;
    const target = jump.dataset.gotoFlow;
    jump.click();
    await vi.waitFor(() => {
      expect(state('selectedFlowId')).toBe(target);
    });
    // Still on Breaks, now for the feature that was clicked.
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
    const item = [...document.querySelectorAll<HTMLElement>('.flow-item')].find(
      (node) => node.querySelector('.label')?.textContent === other.title,
    )!;
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
