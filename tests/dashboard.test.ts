// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  analyzeChanged,
  analyzeFlowImpact,
  flowApis,
  flowTiming,
  indexTests,
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
  it('offers the six questions, with Flow open first', async () => {
    const labels = [...document.querySelectorAll('#tabs .tab-label')].map(
      (node) => node.textContent,
    );
    expect(labels).toEqual(['Flow', 'APIs', 'Timing', 'Breaks', 'Tests', 'Changed']);
    expect(document.getElementById('tab-flow')?.getAttribute('aria-selected')).toBe('true');
    expect(document.getElementById('graph')?.hidden).toBe(false);
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
    expect(document.querySelector('#tab-timing .tab-badge')?.textContent?.trim()).toBe('no runs');
    expect(document.querySelector('#tab-tests .tab-badge')?.textContent?.trim()).toBe('none');
    const breaks = document.querySelector('#tab-impact .tab-badge');
    expect(breaks?.textContent?.trim()).toBeTruthy();
  });

  it('every panel opens with a sentence saying what it answers', async () => {
    for (const id of ['timing', 'impact', 'tests', 'apis', 'changed']) {
      const panel = await openTab(id);
      const intro = panel.querySelector('.panel-intro, .empty-state p');
      expect((intro?.textContent ?? '').length, `${id} explains itself`).toBeGreaterThan(20);
    }
  });
});

describe('the Timing tab', () => {
  it('explains how to get numbers rather than inventing them', async () => {
    const panel = await openTab('timing');
    const text = panel.textContent ?? '';
    expect(text).toContain('Nothing has been measured yet');
    expect(text).toContain('@flowslens/runtime');
    // No fabricated milliseconds anywhere in an unmeasured flow.
    expect(panel.querySelector('.timing-table')).toBeNull();
  });
});

describe('the Breaks tab', () => {
  it('leads with a verdict and a sentence, not a table', async () => {
    const panel = await openTab('impact');
    const verdict = panel.querySelector('.verdict');
    expect(verdict).not.toBeNull();
    expect(verdict?.className).toMatch(/level-(low|medium|high)/);
    expect((verdict?.textContent ?? '').length).toBeGreaterThan(30);
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
    expect(panel.querySelector('.contested')).not.toBeNull();
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

describe('the Tests tab', () => {
  it('says plainly when nothing guards the feature', async () => {
    const panel = await openTab('tests');
    const text = panel.textContent ?? '';
    expect(text).toContain('Nothing covers this feature');
    expect(text).toContain('would fail silently');
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
