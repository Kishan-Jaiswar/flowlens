/**
 * Flowslens dashboard.
 *
 * Plain ES modules against the CLI's JSON API — no bundler, no framework, no
 * network dependency. It renders one feature at a time as five stacked layers
 * (UI, frontend, network, backend, data), which is the shape the product
 * promises: click a button, see everything that happened because of it.
 */

const LAYERS = [
  ['ui', 'User action'],
  ['frontend', 'Frontend'],
  ['network', 'Network'],
  ['backend', 'Backend'],
  ['data', 'Database'],
  ['external', 'Leaves the app'],
];

/**
 * What each database effect is called on screen, in the order it is shown.
 *
 * Reads come first because that is where the data on the page came from; the
 * mutations follow in the order a reviewer cares about them. `write` is last
 * and deliberately vague — `save()` and `bulkWrite()` do not say statically
 * whether they insert, update or delete.
 */
const EFFECTS = [
  ['read', 'Read from', 'reads'],
  ['create', 'Inserted into', 'inserts'],
  ['update', 'Updated in', 'updates'],
  ['delete', 'Deleted from', 'deletes'],
  ['write', 'Written to', 'writes'],
];

const EFFECT_TILE = {
  read: 'read',
  create: 'insert',
  update: 'update',
  delete: 'delete',
  write: 'write',
};

/** Graphs scanned before effects existed carry only `access`. */
function effectOf(entry) {
  return EFFECT_TILE[entry.effect] ? entry.effect : entry.access === 'write' ? 'write' : 'read';
}

const state = {
  flows: [],
  graph: null,
  selectedFlow: null,
  selectedNode: null,
  filter: '',
  includeLocal: false,
  /** Which tab is showing: flow | timing | impact | tests. */
  tab: 'flow',
  /** Timing, blast radius, tests and contract for the selected flow. */
  insight: null,
  /** The diff-scoped report, which is project-wide rather than per feature. */
  changed: null,
  changedLoading: false,
  /** True while /api/insight is in flight, so tabs can say "loading" once. */
  insightLoading: false,
};

/**
 * The four questions the tabs answer, in the order a developer asks them.
 *
 * "What does this do" comes first because nothing else makes sense without it.
 * "What would I break" comes before "is it tested" because the first decides
 * whether to make the change at all, and the second only decides how nervous
 * to be while making it.
 */
const TABS = [
  ['flow', 'Flow', 'What happens when a user does this'],
  ['apis', 'APIs', 'Every request this action makes, in full'],
  ['timing', 'Timing', 'Where the time goes, from real runs'],
  ['impact', 'Breaks', 'What else a change here would break'],
  ['tests', 'Tests', 'What would catch it if you broke it'],
  /**
   * The odd one out, and last on purpose: this one is about the whole project
   * rather than the selected feature. It answers "what did I already change",
   * which is the question you have mid-edit rather than mid-exploration.
   */
  ['changed', 'Changed', 'What your uncommitted changes put at risk'],
];

/** Tabs that ignore the selected feature. */
const PROJECT_TABS = new Set(['changed']);

const el = {
  subtitle: document.getElementById('subtitle'),
  flowList: document.getElementById('flow-list'),
  findings: document.getElementById('findings'),
  graph: document.getElementById('graph'),
  flowHeader: document.getElementById('flow-header'),
  details: document.getElementById('details'),
  filter: document.getElementById('filter'),
  showAll: document.getElementById('show-all'),
  rescan: document.getElementById('rescan'),
  docLink: document.getElementById('doc-link'),
  tabs: document.getElementById('tabs'),
  panels: {
    flow: document.getElementById('graph'),
    timing: document.getElementById('panel-timing'),
    impact: document.getElementById('panel-impact'),
    tests: document.getElementById('panel-tests'),
    apis: document.getElementById('panel-apis'),
    changed: document.getElementById('panel-changed'),
  },
};

/**
 * The token the server asked for, if any.
 *
 * On the default loopback bind the API is protected by being same-origin and
 * nothing else is needed. When the server is bound somewhere reachable it
 * requires a token, and prints a dashboard URL that carries it — so the page
 * simply passes on whatever it was opened with.
 */
const TOKEN = new URLSearchParams(window.location.search).get('token') ?? '';

/** Add the token to a same-origin API path, when there is one. */
function apiUrl(path) {
  if (!TOKEN) return path;
  return `${path}${path.includes('?') ? '&' : '?'}token=${encodeURIComponent(TOKEN)}`;
}

async function getJson(url) {
  const response = await fetch(apiUrl(url));
  if (!response.ok) throw new Error(`${url} → ${response.status}`);
  return response.json();
}

async function load() {
  try {
    const [graph, flows, doctor] = await Promise.all([
      getJson('/api/graph'),
      getJson(`/api/flows${state.includeLocal ? '?all=1' : ''}`),
      getJson('/api/doctor'),
    ]);

    state.graph = graph;
    state.flows = flows;

    const projects = graph.meta.projects ?? {};
    el.subtitle.textContent =
      `${graph.nodes.length} nodes · ${graph.edges.length} edges · ` +
      `${graph.meta.filesAnalyzed} files` +
      (Object.keys(projects).length ? ` · ${Object.values(projects).join(' + ')}` : '');

    renderFlowList();
    renderFindings(doctor);
    void loadChanged();

    const first = filteredFlows()[0];
    if (first) selectFlow(first.id);
    else renderEmpty();
  } catch (error) {
    el.graph.innerHTML = `<p class="error">Could not load the graph: ${escapeHtml(
      String(error.message),
    )}</p>`;
  }
}

function filteredFlows() {
  const needle = state.filter.trim().toLowerCase();
  if (!needle) return state.flows;
  return state.flows.filter((flow) =>
    [flow.title, flow.label, flow.screen, flow.component, flow.id, ...flow.endpoints]
      .filter(Boolean)
      .some((value) => value.toLowerCase().includes(needle)),
  );
}

function renderFlowList() {
  const flows = filteredFlows();
  el.flowList.innerHTML = '';

  if (flows.length === 0) {
    el.flowList.innerHTML = '<p class="muted" style="padding:8px">No matching features.</p>';
    return;
  }

  for (const flow of flows) {
    const button = document.createElement('button');
    button.className = 'flow-item';
    button.setAttribute('aria-selected', String(flow.id === state.selectedFlow?.id));
    button.onclick = () => selectFlow(flow.id);
    button.innerHTML = `
      <div class="label">${escapeHtml(flowTitle(flow))}</div>
      <div class="meta">${escapeHtml(
        [eventVerb(flow.event), flow.component, flow.endpoints[0], `risk ${flow.risk.level}`]
          .filter(Boolean)
          .join(' · '),
      )}</div>`;
    el.flowList.appendChild(button);
  }
}

function renderFindings(doctor) {
  const parts = [];

  for (const call of doctor.brokenCalls.slice(0, 6)) {
    const reason =
      call.meta?.mismatch === 'method'
        ? `wrong method (backend: ${(call.meta.availableMethods ?? []).join(', ')})`
        : 'no backend route';
    parts.push(
      `<div class="finding warn">⚠ ${escapeHtml(call.label)}<br />${escapeHtml(reason)}</div>`,
    );
  }

  for (const entry of doctor.sharedWrites.slice(0, 4)) {
    parts.push(
      `<div class="finding warn">⚠ <code>${escapeHtml(entry.collection)}</code> written by ${escapeHtml(
        entry.writers.join(', '),
      )}</div>`,
    );
  }

  const dead = doctor.deadEndpoints.length;
  if (dead > 0) {
    parts.push(`<div class="finding dim">${dead} endpoint(s) with no known caller</div>`);
  }

  el.findings.innerHTML =
    parts.length > 0 ? parts.join('') : '<p class="muted">Nothing to report.</p>';
}

function selectFlow(id) {
  const flow = state.flows.find((candidate) => candidate.id === id);
  if (!flow) return;
  state.selectedFlow = flow;
  state.selectedNode = null;
  el.docLink.href = apiUrl(`/api/document?flow=${encodeURIComponent(flow.id)}`);
  state.insight = null;
  renderFlowList();
  renderFlowHeader(flow);
  renderGraph(flow);
  renderDetails(null);
  renderTabs();
  showTab(state.tab);
  void loadInsight(flow.id);
}

/**
 * Fetch the timing, blast radius and tests for one feature.
 *
 * One request for all three: the tabs are read together, and three round trips
 * would make switching tabs feel like loading a new page.
 */
async function loadInsight(flowId) {
  state.insightLoading = true;
  renderTabs();
  try {
    const insight = await getJson(`/api/insight?flow=${encodeURIComponent(flowId)}`);
    // The user may have clicked another feature while this was in flight.
    if (state.selectedFlow?.id !== flowId) return;
    state.insight = insight;
  } catch (error) {
    if (state.selectedFlow?.id !== flowId) return;
    state.insight = { error: String(error.message ?? error) };
  } finally {
    state.insightLoading = false;
    renderTabs();
    showTab(state.tab);
  }
}

/** The tab bar, with each label carrying its own headline number. */
function renderTabs() {
  if (!el.tabs) return;
  el.tabs.innerHTML = TABS.map(([id, label, hint]) => {
    const active = state.tab === id;
    const badge = tabBadge(id);
    return (
      `<button id="tab-${id}" class="tab${active ? ' active' : ''}" role="tab" ` +
      `aria-selected="${active}" data-tab="${id}" title="${escapeHtml(hint)}">` +
      `<span class="tab-label">${escapeHtml(label)}</span>` +
      (badge ? `<span class="tab-badge ${badge.tone}">${escapeHtml(badge.text)}</span>` : '') +
      `</button>`
    );
  }).join('');

  for (const button of el.tabs.querySelectorAll('[data-tab]')) {
    button.addEventListener('click', () => showTab(button.dataset.tab));
  }
}

/**
 * The number on a tab.
 *
 * Deliberately the *worrying* number rather than a total: "Breaks · 3" means
 * three other features, which is the fact that should make someone open the
 * tab. A tab that always reads "12" teaches people to ignore it.
 */
function tabBadge(id) {
  // Project-wide, so it has a badge before any feature is selected.
  if (id === 'changed') {
    if (state.changedLoading && !state.changed) return { text: '…', tone: 'neutral' };
    const changed = state.changed;
    if (!changed || changed.error) return undefined;
    if (changed.features.length === 0) {
      return { text: changed.files.length === 0 ? 'clean' : 'no features', tone: 'muted' };
    }
    return {
      text: String(changed.features.length),
      tone: changed.level === 'high' ? 'danger' : changed.level === 'medium' ? 'warn' : 'neutral',
    };
  }

  const flow = state.selectedFlow;
  if (!flow) return undefined;
  if (id === 'flow') return { text: String(flow.steps.length), tone: 'neutral' };

  if (state.insightLoading && !state.insight) return { text: '…', tone: 'neutral' };
  const insight = state.insight;
  if (!insight || insight.error) return undefined;

  if (id === 'timing') {
    return insight.timing?.observed
      ? { text: `${insight.timing.totalMs}ms`, tone: 'neutral' }
      : { text: 'no runs', tone: 'muted' };
  }
  if (id === 'impact') {
    const count = insight.impact?.featuresAtRisk?.length ?? 0;
    if (count === 0) return { text: 'contained', tone: 'ok' };
    return { text: String(count), tone: insight.impact.level === 'high' ? 'danger' : 'warn' };
  }
  if (id === 'apis') {
    const calls = insight.apis?.calls ?? [];
    if (calls.length === 0) return { text: 'none', tone: 'muted' };
    // The badge reports the problem when there is one, the count otherwise.
    const unmatched = calls.filter((call) => !call.matched).length;
    if (unmatched > 0) return { text: `${unmatched} unmatched`, tone: 'danger' };
    const drift = calls.reduce((sum, call) => sum + (call.contract?.unexpected.length ?? 0), 0);
    if (drift > 0) return { text: `${drift} unread key${drift > 1 ? 's' : ''}`, tone: 'warn' };
    return { text: String(calls.length), tone: 'neutral' };
  }
  if (id === 'tests') {
    const tests = insight.tests;
    if (!tests) return undefined;
    if (tests.totalCases === 0) return { text: 'none', tone: 'danger' };
    return {
      text: `${tests.coveragePct}%`,
      tone: tests.coveragePct >= 80 ? 'ok' : tests.coveragePct >= 40 ? 'warn' : 'danger',
    };
  }
  return undefined;
}

function showTab(id) {
  state.tab = TABS.some(([candidate]) => candidate === id) ? id : 'flow';
  for (const [tabId] of TABS) {
    const panel = el.panels[tabId];
    if (panel) panel.hidden = tabId !== state.tab;
  }
  for (const button of el.tabs?.querySelectorAll('[data-tab]') ?? []) {
    const active = button.dataset.tab === state.tab;
    button.classList.toggle('active', active);
    button.setAttribute('aria-selected', String(active));
  }

  if (state.tab === 'timing') renderTiming();
  if (state.tab === 'impact') renderImpact();
  if (state.tab === 'tests') renderTests();
  if (state.tab === 'apis') renderApis();
  if (state.tab === 'changed') renderChanged();
}

/**
 * Fetch the diff report.
 *
 * Its own request, not part of `/api/insight`: it shells out to git, and
 * clicking through features should not pay for a `git status` nobody asked
 * about.
 */
async function loadChanged() {
  state.changedLoading = true;
  renderTabs();
  try {
    state.changed = await getJson('/api/changed');
  } catch (error) {
    state.changed = { error: String(error.message ?? error) };
  } finally {
    state.changedLoading = false;
    renderTabs();
    if (state.tab === 'changed') renderChanged();
  }
}

function renderFlowHeader(flow) {
  const chips = [
    `<span class="chip risk-${flow.risk.level}">risk ${flow.risk.level} · ${flow.risk.score}</span>`,
    `<span class="chip">${flow.evidence}</span>`,
  ];
  if (flow.screen) chips.push(`<span class="chip">${escapeHtml(flow.screen)}</span>`);
  if (flow.event) chips.push(`<span class="chip">${escapeHtml(eventVerb(flow.event))}</span>`);
  if (flow.component) chips.push(`<span class="chip">${escapeHtml(flow.component)}</span>`);
  if (flow.totalMs != null) chips.push(`<span class="chip">${flow.totalMs}ms observed</span>`);
  // A count per effect rather than a chip per collection: a real flow touches a
  // dozen collections, and fourteen chips is a wall, not a summary.
  for (const [effect, , plural] of EFFECTS) {
    const count = flow.collections.filter((entry) => effectOf(entry) === effect).length;
    if (count > 0) chips.push(`<span class="chip effect-${effect}">${count} ${plural}</span>`);
  }

  el.flowHeader.innerHTML = `
    <h2>${escapeHtml(flowTitle(flow))}</h2>
    <div class="chips">${chips.join('')}</div>
    ${
      flow.source
        ? `<p class="muted" style="margin-top:8px">${escapeHtml(flow.source.file)}:${flow.source.line}</p>`
        : ''
    }`;
}

function renderGraph(flow) {
  el.graph.innerHTML = '';

  const groups = LAYERS.map(([layer, title]) => ({
    layer,
    title,
    steps: flow.steps.filter((step) => step.layer === layer),
  })).filter((group) => group.steps.length > 0);

  groups.forEach((group, index) => {
    const section = document.createElement('div');
    section.className = 'layer';

    const heading = document.createElement('div');
    heading.className = 'layer-title';
    heading.textContent = group.title;
    section.appendChild(heading);

    // The question the data layer has to answer is "which collections, and what
    // happened to them" — the individual db-op tiles below spell out the calls,
    // but the grouped answer has to be readable without counting tiles.
    if (group.layer === 'data') {
      const summary = renderCollectionSummary(flow);
      if (summary) section.appendChild(summary);
    }

    section.appendChild(renderLayerSteps(group.steps));

    el.graph.appendChild(section);

    if (index < groups.length - 1) {
      const connector = document.createElement('div');
      connector.className = 'connector';
      el.graph.appendChild(connector);
    }
  });
}

/**
 * Collections grouped by what the action does to them.
 *
 * Returns undefined rather than an empty box when a flow reaches the backend but
 * no query resolved, so the layer does not claim knowledge it does not have.
 */
function renderCollectionSummary(flow) {
  if (!flow.collections.length) return undefined;

  const box = document.createElement('div');
  box.className = 'collection-summary';

  for (const [effect, title] of EFFECTS) {
    const entries = flow.collections.filter((entry) => effectOf(entry) === effect);
    if (!entries.length) continue;

    const row = document.createElement('div');
    row.className = `collection-row effect-${effect}`;
    const names = entries
      .map((entry) => {
        const calls = entry.operations.map((operation) => `${operation}()`).join(', ');
        return `<span class="collection-name" title="${escapeHtml(calls)}">${escapeHtml(
          entry.collection,
        )}</span>`;
      })
      .join('');
    row.innerHTML =
      `<span class="collection-effect">${escapeHtml(title)}</span>` +
      `<span class="collection-names">${names}</span>`;
    box.appendChild(row);
  }

  return box;
}

/**
 * One layer, left to right in call order.
 *
 * Steps are grouped by depth and the groups joined with arrows, so a section
 * reads as a chain — `handleDelete -> useDeleteProduct` — rather than as an
 * unordered row of tiles where nothing says what called what.
 *
 * Everything at the same depth is stacked in one column instead of being strung
 * together, because those are siblings: `handleDelete` calls *both*
 * `useDeleteProduct` and `useToast`, and an arrow between them would claim a
 * call that does not happen.
 */
function renderLayerSteps(steps) {
  const byDepth = new Map();
  for (const step of steps) {
    const list = byDepth.get(step.depth);
    if (list) list.push(step);
    else byDepth.set(step.depth, [step]);
  }

  const row = document.createElement('div');
  row.className = 'layer-nodes';

  const depths = [...byDepth.keys()].sort((a, b) => a - b);
  depths.forEach((depth, index) => {
    const column = document.createElement('div');
    column.className = 'layer-column';
    for (const step of byDepth.get(depth)) column.appendChild(renderNode(step));
    row.appendChild(column);

    if (index < depths.length - 1) {
      const arrow = document.createElement('div');
      arrow.className = 'arrow-h';
      // Decorative: the reading order already carries the meaning.
      arrow.setAttribute('aria-hidden', 'true');
      arrow.textContent = '\u2192';
      row.appendChild(arrow);
    }
  });

  return row;
}

/** `['a','b']` -> `<code>a</code> <code>b</code>`, or a muted dash. */
function codeList(values) {
  if (!values || !values.length) return '<span class="muted">—</span>';
  return values.map((value) => `<code>${escapeHtml(value)}</code>`).join(' ');
}

function detailSection(title, body) {
  return `<h4>${escapeHtml(title)}</h4><p class="detail-list">${body}</p>`;
}

/**
 * The step's own contract, in the side panel.
 *
 * This is where "what actually happened here" lives: the state a handler set,
 * the query and body a request sent, the DTO that validated it, the schema that
 * stored it. Each block is omitted when empty rather than shown as "none", so
 * the panel stays short for steps that are just a call.
 */
function renderStepDetail(step) {
  const d = step.detail;
  if (!d) return '';
  const blocks = [];

  if (d.statesWritten?.length) blocks.push(detailSection('State set', codeList(d.statesWritten)));
  if (d.statesRead?.length) blocks.push(detailSection('State read', codeList(d.statesRead)));
  if (d.hooks?.length) blocks.push(detailSection('Hooks used', codeList(d.hooks)));

  if (d.queryKeys?.length) blocks.push(detailSection('Query parameters', codeList(d.queryKeys)));
  if (d.payloadKeys?.length) {
    // Show where each body key came from when we know: `customer_id ← customerId`.
    const rows = d.payloadKeys.map((key) => {
      const from = d.payloadSources?.[key];
      return from && from !== key
        ? `<code>${escapeHtml(key)}</code> <span class="muted">&larr; ${escapeHtml(from)}</span>`
        : `<code>${escapeHtml(key)}</code>`;
    });
    blocks.push(detailSection('Request body', rows.join('<br>')));
  }

  for (const dto of d.dtos ?? []) {
    blocks.push(
      detailSection(
        `DTO · ${dto.name}`,
        `${codeList(dto.fields)}${
          dto.file ? `<br><span class="muted">${escapeHtml(dto.file)}</span>` : ''
        }`,
      ),
    );
  }

  if (d.schema) {
    blocks.push(
      detailSection(
        `Schema · ${d.schema.model} → ${d.schema.collection}`,
        `${codeList(d.schema.fields)}${
          d.schema.file ? `<br><span class="muted">${escapeHtml(d.schema.file)}</span>` : ''
        }`,
      ),
    );
  }

  return blocks.join('');
}

/**
 * The one or two facts worth putting on the tile itself.
 *
 * Everything else is a click away in the panel; a tile that lists twenty schema
 * fields stops being scannable, which is the only thing a tile is for.
 */
function tileDetailLines(step) {
  const d = step.detail;
  if (!d) return [];
  const lines = [];
  if (d.queryKeys?.length) lines.push(`?${d.queryKeys.join(' &')}`);
  if (d.payloadKeys?.length) lines.push(`body: ${d.payloadKeys.join(', ')}`);
  if (d.dtos?.length) lines.push(`dto: ${d.dtos.map((dto) => dto.name).join(', ')}`);
  if (d.schema) lines.push(`schema: ${d.schema.model}`);
  if (d.statesWritten?.length) lines.push(`sets: ${d.statesWritten.join(', ')}`);
  return lines;
}

function renderNode(step) {
  const button = document.createElement('button');
  const warn = Boolean(step.meta?.mismatch || step.meta?.unresolved);
  button.className = `node layer-${step.layer}${warn ? ' warn' : ''}`;
  button.setAttribute('aria-selected', String(step.nodeId === state.selectedNode?.nodeId));
  button.onclick = () => {
    state.selectedNode = step;
    renderGraph(state.selectedFlow);
    renderDetails(step);
  };

  const pieces = [
    `<div class="kind">${escapeHtml(tileKind(step))}</div>`,
    `<div class="label">${escapeHtml(tileLabel(step))}</div>`,
  ];
  // The words actually on the element, when the title has rephrased them.
  const action = step.meta?.action;
  if (step.kind === 'ui-action' && action && step.meta?.event !== 'mount') {
    if (!tileLabel(step).toLowerCase().includes(String(action).toLowerCase())) {
      pieces.push(`<div class="sub">on “${escapeHtml(action)}”</div>`);
    }
  }
  if (step.file) {
    pieces.push(
      `<div class="sub">${escapeHtml(step.file)}${step.line ? `:${step.line}` : ''}</div>`,
    );
  }
  // The contract this step carries: query, body, dto, schema, state set.
  for (const line of tileDetailLines(step)) {
    pieces.push(`<div class="sub contract">${escapeHtml(line)}</div>`);
  }
  // A shared endpoint: the same node appears in every flow that calls it.
  if (step.meta?.otherCallers) {
    const others = step.meta.otherCallers;
    pieces.push(
      `<div class="sub">also called from ${others} other place${others === 1 ? '' : 's'}</div>`,
    );
  }
  if (step.avgMs != null) {
    // Self time is the honest number for "where did the time go"; total is the
    // wall clock including everything this step called.
    const self = step.avgSelfMs != null ? `${step.avgSelfMs}ms self · ` : '';
    pieces.push(
      `<div class="timing">${self}${step.avgMs}ms total · ${step.observations ?? 0}x</div>`,
    );
  }
  pieces.push(`<span class="badge ${step.evidence}">${step.evidence}</span>`);

  button.innerHTML = pieces.join('');
  return button;
}

/**
 * The whole chain as one readable list: where the click starts, what it calls,
 * and where the data ends up.
 *
 * Deliberately in execution order rather than grouped by importance, so it reads
 * as a story — the same order the layers appear on the left.
 */
function renderFlowSummary(flow) {
  const rows = [
    ['Component', flow.component ? [flow.component] : []],
    ['Screen', flow.screen ? [flow.screen] : []],
    ['State', flow.state],
    ['Hooks', flow.hooks ?? []],
    ['Endpoints', flow.endpoints],
    ['Controllers', flow.controllers],
    ['Services', flow.services],
    ['DTOs', flow.dtos ?? []],
    ['Schemas', (flow.schemas ?? []).map((entry) => `${entry.model} → ${entry.collection}`)],
  ].filter(([, values]) => values && values.length);

  const chain = rows
    .map(
      ([title, values]) =>
        `<div class="summary-row"><span class="summary-key">${escapeHtml(title)}</span>` +
        `<span class="summary-values">${codeList(values)}</span></div>`,
    )
    .join('');

  // Collections last and grouped by effect: it is the answer to "where did the
  // data go", which is the end of the story.
  const data = EFFECTS.map(([effect, title]) => {
    const names = (flow.collections ?? [])
      .filter((entry) => effectOf(entry) === effect)
      .map((entry) => entry.collection);
    if (!names.length) return '';
    return (
      `<div class="summary-row effect-${effect}"><span class="summary-key">${escapeHtml(title)}</span>` +
      `<span class="summary-values">${codeList(names)}</span></div>`
    );
  }).join('');

  return `<div class="flow-summary">${chain}${data}</div>`;
}

async function renderDetails(step) {
  if (!step) {
    const flow = state.selectedFlow;
    el.details.innerHTML = flow
      ? `
        <h3>${escapeHtml(flowTitle(flow))}</h3>
        ${renderFlowSummary(flow)}
        <h4>Risk factors</h4>
        ${
          flow.risk.reasons.length
            ? `<ul>${flow.risk.reasons.map((reason) => `<li>${escapeHtml(reason)}</li>`).join('')}</ul>`
            : '<p class="muted">None detected.</p>'
        }
        <p class="muted">Select a step to inspect it.</p>`
      : '<p class="muted">Select a feature.</p>';
    return;
  }

  el.details.innerHTML = `
    <h3>${escapeHtml(tileLabel(step))}</h3>
    <dl>
      <dt>kind</dt><dd>${escapeHtml(step.kind)}</dd>
      ${step.detail?.component ? `<dt>component</dt><dd><code>${escapeHtml(step.detail.component)}</code></dd>` : ''}
      ${step.detail?.className ? `<dt>${escapeHtml(step.detail.classRole ?? 'class')}</dt><dd><code>${escapeHtml(step.detail.className)}</code></dd>` : ''}
      ${step.meta?.screen ? `<dt>screen</dt><dd>${escapeHtml(step.meta.screen)}</dd>` : ''}
      ${step.meta?.page ? `<dt>route</dt><dd><code>${escapeHtml(step.meta.page)}</code></dd>` : ''}
      ${step.meta?.action ? `<dt>action</dt><dd>${escapeHtml(step.meta.action)}</dd>` : ''}
      <dt>layer</dt><dd>${escapeHtml(step.layer)}</dd>
      <dt>evidence</dt><dd>${escapeHtml(step.evidence)}</dd>
      ${step.file ? `<dt>source</dt><dd>${escapeHtml(step.file)}:${step.line ?? ''}</dd>` : ''}
      ${step.avgMs != null ? `<dt>avg</dt><dd>${step.avgMs}ms</dd>` : ''}
    </dl>
    ${renderStepDetail(step)}
    <h4>Impact</h4>
    <p class="muted">loading…</p>`;

  try {
    const impact = await getJson(`/api/impact?node=${encodeURIComponent(step.nodeId)}`);
    const flows = impact.affectedFlows ?? [];
    const direct = (impact.dependents ?? []).filter((dependent) => dependent.distance === 1);

    el.details.insertAdjacentHTML(
      'beforeend',
      `
      <dl>
        <dt>blast radius</dt><dd>${impact.blastRadius} (${impact.level})</dd>
      </dl>
      <h4>Features affected (${flows.length})</h4>
      ${
        flows.length
          ? `<ul>${flows
              .slice(0, 12)
              .map((flow) => `<li>${escapeHtml(flowTitle(flow))}</li>`)
              .join('')}</ul>`
          : '<p class="muted">None.</p>'
      }
      <h4>Direct callers (${direct.length})</h4>
      ${
        direct.length
          ? `<ul>${direct
              .slice(0, 12)
              .map((dependent) => `<li><code>${escapeHtml(dependent.label)}</code></li>`)
              .join('')}</ul>`
          : '<p class="muted">None.</p>'
      }
      ${
        (impact.warnings ?? []).length
          ? `<h4>Warnings</h4><ul>${impact.warnings
              .map((warning) => `<li>${escapeHtml(warning)}</li>`)
              .join('')}</ul>`
          : ''
      }`,
    );
    // Remove the "loading…" placeholder now that real content is in.
    el.details.querySelector('p.muted')?.remove();
  } catch (error) {
    el.details.insertAdjacentHTML(
      'beforeend',
      `<p class="error">${escapeHtml(String(error.message))}</p>`,
    );
  }
}

function renderEmpty() {
  el.flowHeader.innerHTML = '';
  el.graph.innerHTML = `
    <p class="muted">
      No feature flow reached the backend. If the frontend and backend live in
      separate folders, scan the directory that contains both.
    </p>`;
}

el.filter.addEventListener('input', (event) => {
  state.filter = event.target.value;
  renderFlowList();
});

el.showAll.addEventListener('change', (event) => {
  state.includeLocal = event.target.checked;
  load();
});

el.rescan.addEventListener('click', async () => {
  el.rescan.disabled = true;
  el.rescan.textContent = 'Scanning…';
  try {
    await fetch(apiUrl('/api/rescan'), { method: 'POST' });
    await load();
  } finally {
    el.rescan.disabled = false;
    el.rescan.textContent = 'Rescan';
  }
});

/**
 * What a tile is called.
 *
 * A user action's own label is only the words on the element — "Submit" — so the
 * scan stores a descriptive title next to it (`Order · Submit`) and that
 * is what the tile shows. Code nodes keep their identifier, which is already the
 * clearest name for them.
 */
function tileLabel(step) {
  return step.meta?.title || step.label;
}

function flowTitle(flow) {
  return flow.title || flow.label;
}

/** `onClick` -> `click`, so the tile says what the user did, not the prop name. */
function eventVerb(event) {
  if (!event) return '';
  if (event === 'mount') return 'on load';
  return event.replace(/^on/, '').replace(/^[A-Z]/, (character) => character.toLowerCase());
}

/** The kind line: for a user action, the gesture; otherwise the node kind. */
function tileKind(step) {
  if (step.kind === 'ui-action') {
    const verb = eventVerb(step.meta?.event);
    return verb ? `user ${verb}` : 'user action';
  }
  // "db op" says nothing; "delete" says the thing worth knowing at a glance.
  if (step.kind === 'db-op') {
    const effect = effectOf({ effect: step.meta?.effect, access: step.meta?.access });
    return EFFECT_TILE[effect];
  }
  // "middleware" is the node kind; "guard" is what the developer called it.
  if (step.kind === 'middleware' && step.meta?.role) return String(step.meta.role);
  // Say plainly that the chain stops here rather than implying it completed.
  if (step.kind === 'external-effect') return `${step.meta?.effectKind ?? 'external'} · not read`;
  return step.kind.replace('-', ' ');
}

function escapeHtml(value) {
  return String(value ?? '').replace(
    /[&<>"']/g,
    (character) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character],
  );
}

load();

// ---------------------------------------------------------------------------
// Tab panels
//
// Each one opens with a plain sentence saying what question it answers. The
// data is the point, but a panel of numbers with no stated question is how a
// tool gets read wrong — and every one of these panels can be read wrong in a
// way that costs someone an afternoon.
// ---------------------------------------------------------------------------

/** A short note explaining the panel, in the user's terms rather than ours. */
function panelIntro(text) {
  return `<p class="panel-intro">${escapeHtml(text)}</p>`;
}

function panelError(panel, insight) {
  panel.innerHTML = `<p class="error">Could not load this view: ${escapeHtml(
    String(insight.error),
  )}</p>`;
}

function panelLoading(panel, what) {
  panel.innerHTML = `<p class="muted">Working out ${escapeHtml(what)}…</p>`;
}

/** Tab 2 — where the time goes. */
function renderTiming() {
  const panel = el.panels.timing;
  if (!panel) return;
  if (!state.insight) return panelLoading(panel, 'the timings');
  if (state.insight.error) return panelError(panel, state.insight);

  const timing = state.insight.timing;

  if (!timing.observed) {
    panel.innerHTML =
      panelIntro('How long each step of this feature takes, measured from real runs.') +
      `<div class="empty-state">
         <h3>Nothing has been measured yet</h3>
         <p>Flowslens does not guess timings. These numbers come from your app
            actually running, so there is nothing to show until it has.</p>
         <ol class="steps-todo">
           <li>Add <code>@flowslens/runtime</code> to the app you are studying.</li>
           <li><code>app.use(flowlensHttp())</code>, and <code>traceMethod</code>
               around the service methods you care about.</li>
           <li>Use the feature once in a browser, then press <strong>Rescan</strong>.</li>
         </ol>
       </div>`;
    return;
  }

  const slowest = timing.slowest;
  const rows = timing.steps
    .map((step) => {
      const share = step.sharePct ?? 0;
      const self = step.avgSelfMs ?? 0;
      return `<tr>
          <td class="t-step">
            <span class="layer-dot layer-${step.layer}"></span>
            ${escapeHtml(step.label)}
            <span class="t-kind">${escapeHtml(tileKind(step))}</span>
          </td>
          <td class="t-bar">
            <span class="bar" style="width:${Math.max(share, 1)}%"></span>
            <span class="bar-value">${self}ms</span>
          </td>
          <td class="t-share">${share}%</td>
          <td class="t-total">${step.avgMs ?? '—'}${step.avgMs != null ? 'ms' : ''}</td>
          <td class="t-runs">${step.observations ?? '—'}</td>
        </tr>`;
    })
    .join('');

  panel.innerHTML =
    panelIntro(
      'How long each step takes, measured from real runs. "Own time" is the step ' +
        'itself; "total" includes everything it called.',
    ) +
    `<div class="stat-row">
       <div class="stat"><span class="stat-value">${timing.totalMs}ms</span>
         <span class="stat-label">whole feature</span></div>
       <div class="stat"><span class="stat-value">${timing.accountedMs}ms</span>
         <span class="stat-label">accounted for by the steps below</span></div>
       ${
         slowest
           ? `<div class="stat"><span class="stat-value">${escapeHtml(slowest.label)}</span>
                <span class="stat-label">slowest step (${slowest.avgSelfMs}ms of its own)</span></div>`
           : ''
       }
     </div>
     <table class="timing-table">
       <thead><tr>
         <th>Step</th><th>Own time</th><th>Share</th><th>Total</th><th>Runs</th>
       </tr></thead>
       <tbody>${rows}</tbody>
     </table>` +
    notesList(timing.notes) +
    (timing.unobserved.length
      ? `<details class="more"><summary>${timing.unobserved.length} steps with no measurement</summary>
           <ul class="plain">${timing.unobserved
             .map((step) => `<li>${escapeHtml(step.label)}</li>`)
             .join('')}</ul></details>`
      : '');
}

/** Tab 3 — what a change here would break. */
function renderImpact() {
  const panel = el.panels.impact;
  if (!panel) return;
  if (!state.insight) return panelLoading(panel, 'what depends on this');
  if (state.insight.error) return panelError(panel, state.insight);

  const impact = state.insight.impact;

  const intro = panelIntro(
    'Before you change this feature: these are the parts of it that other ' +
      'features also run through. Change a shared step and you change them too.',
  );

  const infraCount = impact.infrastructure?.length ?? 0;

  if (impact.shared.length === 0 && impact.contestedCollections.length === 0) {
    panel.innerHTML =
      intro +
      `<div class="empty-state ok">
         <h3>This change is contained</h3>
         <p>${escapeHtml(impact.summary)}</p>
         <p class="muted">No other feature depends on this one's business logic.${
           infraCount
             ? ` It shares ${infraCount} infrastructure step${
                 infraCount > 1 ? 's' : ''
               } — a hook, a cache, a log — which is what infrastructure is for.`
             : ''
         }</p>
       </div>` +
      renderInfrastructure(impact);
    bindFlowJumps(panel);
    return;
  }

  const features = impact.featuresAtRisk
    .map(
      (feature) =>
        `<li>
           <button class="link" data-goto-flow="${escapeHtml(feature.id)}">${escapeHtml(
             feature.title,
           )}</button>
           ${
             feature.subtitle
               ? `<span class="muted small">${escapeHtml(feature.subtitle)}</span>`
               : ''
           }
           <span class="muted">— shares ${feature.viaSteps} step${
             feature.viaSteps > 1 ? 's' : ''
           } with this one</span>
         </li>`,
    )
    .join('');

  const sharedRows = impact.shared
    .map(
      (step) => `<div class="shared-step level-${step.level}" data-step-id="${escapeHtml(
        step.nodeId,
      )}">
        <div class="shared-head">
          <span class="layer-dot layer-${step.layer}"></span>
          <strong>${escapeHtml(step.label)}</strong>
          <span class="chip small">${escapeHtml(step.kind.replace('-', ' '))}</span>
          <span class="chip small ${step.level === 'high' ? 'danger' : 'warn'}">
            ${step.otherFlows.length} other feature${step.otherFlows.length > 1 ? 's' : ''}
          </span>
        </div>
        ${step.file ? `<div class="shared-file">${fileLink(step.file, step.line)}</div>` : ''}
        <div class="shared-flows">${step.otherFlows
          .map(
            (other) =>
              `<button class="pill" data-goto-flow="${escapeHtml(other.id)}">${escapeHtml(
                other.title,
              )}</button>`,
          )
          .join('')}</div>
        ${
          step.warnings.length
            ? `<ul class="warn-list">${step.warnings
                .map((warning) => `<li>${escapeHtml(warning)}</li>`)
                .join('')}</ul>`
            : ''
        }
      </div>`,
    )
    .join('');

  const contested = impact.contestedCollections.length
    ? `<h3>Collections more than one place writes</h3>
       <p class="panel-intro">These are written from several methods. Changing the
          shape of what this feature writes can break the others' assumptions,
          and nobody gets a compile error.</p>
       ${impact.contestedCollections
         .map(
           (entry) => `<div class="contested">
              <strong>${escapeHtml(entry.collection)}</strong>
              <span class="muted">written by</span>
              ${entry.writers
                .map((writer) => `<span class="pill flat">${escapeHtml(writer)}</span>`)
                .join('')}
            </div>`,
         )
         .join('')}`
    : '';

  const infrastructure = renderInfrastructure(impact);

  panel.innerHTML =
    intro +
    `<div class="verdict level-${impact.level}">
       <span class="verdict-level">${escapeHtml(impact.level)} risk</span>
       <span>${escapeHtml(impact.summary)}</span>
     </div>
     <details class="more why"><summary>Why this level</summary>
       <ul class="plain small">${(impact.factors ?? [])
         .map((factor) => `<li>${escapeHtml(factor)}</li>`)
         .join('')}</ul>
     </details>
     ${features ? `<h3>Features that could break</h3><ul class="plain">${features}</ul>` : ''}
     <h3>Shared steps, most-shared first</h3>
     ${sharedRows}
     ${infrastructure}
     ${contested}
     ${
       impact.exclusive.length
         ? `<details class="more"><summary>${impact.exclusive.length} steps only this feature uses — safe to change</summary>
              <ul class="plain">${impact.exclusive
                .map(
                  (step) =>
                    `<li>${escapeHtml(step.label)} ${
                      step.file ? `<code>${escapeHtml(step.file)}</code>` : ''
                    }</li>`,
                )
                .join('')}</ul></details>`
         : ''
     }`;

  bindFlowJumps(panel);
  bindStepSelection(panel);
}

/**
 * The steps that are shared on purpose, kept out of the way.
 *
 * Collapsed rather than hidden: the classification is a heuristic, so the
 * reader has to be able to check it — and every row says why it was demoted.
 */
function renderInfrastructure(impact) {
  const infra = impact.infrastructure ?? [];
  if (infra.length === 0) return '';
  return `<details class="more">
    <summary>${infra.length} shared step${
      infra.length > 1 ? 's' : ''
    } that look like infrastructure — shared on purpose</summary>
    <p class="panel-intro">A toast hook, a cache, a logger or an audit trail is
       shared by design. They are listed apart so they stop competing with the
       findings above, not because a change to them is safe.</p>
    ${infra
      .map(
        (step) => `<div class="shared-step infra" data-step-id="${escapeHtml(step.nodeId)}">
          <div class="shared-head">
            <span class="layer-dot layer-${step.layer}"></span>
            <strong>${escapeHtml(step.label)}</strong>
            <span class="chip small">${escapeHtml(step.kind.replace('-', ' '))}</span>
            <span class="muted small">${step.usedByFlows} features · ${escapeHtml(step.why)}</span>
          </div>
          ${step.file ? `<div class="shared-file">${fileLink(step.file, step.line)}</div>` : ''}
        </div>`,
      )
      .join('')}
  </details>`;
}

/** Tab 4 — what would catch it if you broke it. */
function renderTests() {
  const panel = el.panels.tests;
  if (!panel) return;
  if (!state.insight) return panelLoading(panel, 'which tests cover this');
  if (state.insight.error) return panelError(panel, state.insight);

  const tests = state.insight.tests;
  const intro = panelIntro(
    'Which tests import the files this feature runs through — that is, what would ' +
      'fail if you broke it.',
  );

  if (tests.files.length === 0) {
    panel.innerHTML =
      intro +
      `<div class="empty-state danger">
         <h3>Nothing covers this feature</h3>
         <p>No test file imports any file this flow runs through. A change here
            would fail silently — which makes the <strong>Breaks</strong> tab the
            one to read before editing.</p>
       </div>` +
      notesList(tests.notes);
    return;
  }

  const meterTone = tests.coveragePct >= 80 ? 'ok' : tests.coveragePct >= 40 ? 'warn' : 'danger';

  const files = tests.files
    .map(
      (file) => `<div class="test-file">
        <div class="test-head">
          <strong>${escapeHtml(file.file)}</strong>
          <span class="chip small">${file.cases.length} case${
            file.cases.length === 1 ? '' : 's'
          }</span>
          ${file.integration ? '<span class="chip small">integration</span>' : ''}
        </div>
        <div class="muted small">covers ${file.coversFromFlow
          .map((covered) => `<code>${escapeHtml(covered)}</code>`)
          .join(' ')}</div>
        <ul class="case-list">${file.cases
          .slice(0, 12)
          .map(
            (testCase) =>
              `<li>${
                testCase.suite ? `<span class="muted">${escapeHtml(testCase.suite)} › </span>` : ''
              }${escapeHtml(testCase.title)}</li>`,
          )
          .join('')}</ul>
        ${
          file.cases.length > 12
            ? `<p class="muted small">…and ${file.cases.length - 12} more</p>`
            : ''
        }
      </div>`,
    )
    .join('');

  panel.innerHTML =
    intro +
    `<div class="stat-row">
       <div class="stat">
         <span class="stat-value">${tests.coveragePct}%</span>
         <span class="stat-label">of this flow's files have a test importing them</span>
         <span class="meter"><span class="meter-fill ${meterTone}" style="width:${tests.coveragePct}%"></span></span>
       </div>
       <div class="stat"><span class="stat-value">${tests.totalCases}</span>
         <span class="stat-label">test cases touch this feature</span></div>
     </div>
     ${
       tests.uncoveredFiles.length
         ? `<h3>Unguarded parts of this feature</h3>
            <p class="panel-intro">No test imports these files, so breaking the steps
               listed under each one would not fail the suite.</p>
            ${tests.uncoveredFiles
              .map(
                (entry) => `<div class="uncovered">
                   <code>${escapeHtml(entry.file)}</code>
                   <span class="muted">— ${entry.steps
                     .map((step) => escapeHtml(step))
                     .join(', ')}</span>
                 </div>`,
              )
              .join('')}`
         : ''
     }
     <h3>Tests that cover it</h3>
     ${files}
     ${runCommand(tests)}` +
    notesList(tests.notes);

  bindCopy(panel);
}

/**
 * The command that runs just these tests.
 *
 * Shown rather than run: Flowslens does not execute anything in the project it
 * reads, and a dashboard that shells out to a test runner would be a different
 * and much more invasive tool. Copying a command is one click and keeps the
 * developer in charge of their own terminal.
 */
function runCommand(tests) {
  const files = tests.files.map((file) => file.file);
  if (files.length === 0) return '';
  const command = `npx vitest run ${files.join(' ')}`;
  return `<h3>Run just these</h3>
    <div class="command">
      <code>${escapeHtml(command)}</code>
      <button class="button ghost small" data-copy="${escapeHtml(command)}">Copy</button>
    </div>`;
}

function notesList(notes) {
  if (!notes?.length) return '';
  return `<ul class="notes">${notes.map((note) => `<li>${escapeHtml(note)}</li>`).join('')}</ul>`;
}

/** Make every "other feature" reference jump to that feature. */
function bindFlowJumps(panel) {
  for (const button of panel.querySelectorAll('[data-goto-flow]')) {
    button.addEventListener('click', () => {
      const id = button.dataset.gotoFlow;
      if (!state.flows.some((flow) => flow.id === id)) return;
      state.tab = 'impact';
      selectFlow(id);
    });
  }
}

// ---------------------------------------------------------------------------
// Opening the file you are reading about
//
// The one thing a developer wants to do after reading any of these panels is
// open the code. In a terminal `file:line` is already clickable; in a browser
// it was plain text, which made the dashboard worse than the CLI at the very
// next step.
// ---------------------------------------------------------------------------

/** The editor scheme to build links for. Overridable with ?editor=. */
const EDITOR = new URLSearchParams(window.location.search).get('editor') ?? 'vscode';

const EDITOR_SCHEMES = {
  vscode: (abs, line) => `vscode://file/${abs}:${line}`,
  'vscode-insiders': (abs, line) => `vscode-insiders://file/${abs}:${line}`,
  cursor: (abs, line) => `cursor://file/${abs}:${line}`,
  windsurf: (abs, line) => `windsurf://file/${abs}:${line}`,
  idea: (abs, line) => `idea://open?file=${abs}&line=${line}`,
  webstorm: (abs, line) => `webstorm://open?file=${abs}&line=${line}`,
  zed: (abs, line) => `zed://file/${abs}:${line}`,
};

/**
 * A clickable `file:line`, or plain text when there is nothing to link to.
 *
 * Paths in the graph are relative so a scan stays portable between machines;
 * an editor needs the absolute one, so it is rebuilt from the root the scan
 * recorded.
 */
function fileLink(file, line, extraClass = '') {
  if (!file) return '';
  const shown = line ? `${file}:${line}` : file;
  const root = state.graph?.meta?.root;
  const scheme = EDITOR_SCHEMES[EDITOR];
  if (!root || !scheme) return `<code class="${extraClass}">${escapeHtml(shown)}</code>`;
  const absolute = `${root.replace(/[/\\]$/, '')}/${file}`;
  return (
    `<a class="file-link ${extraClass}" href="${escapeHtml(scheme(absolute, line ?? 1))}" ` +
    `title="Open in your editor">${escapeHtml(shown)}</a>`
  );
}

/**
 * Wire any element carrying `data-step-id` to the details sidebar.
 *
 * Reuses the panel the Flow tab already fills, so a step read about in Breaks
 * or Changed opens the same detail it would there.
 */
/**
 * `lib/auth/user-store.ts:127` shown as `user-store.ts:127`.
 *
 * The full path was breaking across five lines in a narrow column, which is
 * unreadable and also the least useful half of the string — the basename and
 * the line number are what identify the place. The whole path stays in the
 * tooltip and in the link itself.
 */
function fileRef(file, line, extraClass = '') {
  if (!file) return '';
  const base = file.split('/').pop();
  const root = state.graph?.meta?.root;
  const scheme = EDITOR_SCHEMES[EDITOR];
  const shown = line ? `${base}:${line}` : base;
  const full = line ? `${file}:${line}` : file;
  if (!root || !scheme) {
    return `<code class="file-ref ${extraClass}" title="${escapeHtml(full)}">${escapeHtml(
      shown,
    )}</code>`;
  }
  const absolute = `${root.replace(/[/\\]$/, '')}/${file}`;
  return (
    `<a class="file-link ${extraClass}" href="${escapeHtml(scheme(absolute, line ?? 1))}" ` +
    `title="${escapeHtml(full)} — open in your editor">${escapeHtml(shown)}</a>`
  );
}

function bindStepSelection(panel) {
  for (const element of panel.querySelectorAll('[data-step-id]')) {
    element.addEventListener('click', (event) => {
      if (event.target.closest('a')) return; // Let an editor link win.
      const step = state.selectedFlow?.steps.find(
        (candidate) => candidate.nodeId === element.dataset.stepId,
      );
      if (!step) return;
      state.selectedNode = step;
      renderDetails(step);
    });
  }
}

/** Tab 2 — every request this action makes, in full. */
function renderApis() {
  const panel = el.panels.apis;
  if (!panel) return;
  if (!state.insight) return panelLoading(panel, 'the requests this action makes');
  if (state.insight.error) return panelError(panel, state.insight);

  const calls = state.insight.apis?.calls ?? [];
  const intro = panelIntro(
    'Every request this action sends, and everything the endpoint does on the other ' +
      'side: what is in the body, what runs before the handler, which collections it ' +
      'touches, and who else calls it.',
  );

  if (calls.length === 0) {
    panel.innerHTML =
      intro +
      `<div class="empty-state">
         <h3>This action makes no request</h3>
         <p>It changes local state only — nothing leaves the browser, so there is no
            endpoint to describe. The <strong>Flow</strong> tab shows what it does
            instead.</p>
       </div>`;
    return;
  }

  /**
   * A one-line map before the detail.
   *
   * With three requests the shape of the sequence is the first thing to
   * understand, and reading it off three expanded cards is harder than reading
   * it off one line.
   */
  const sequence =
    calls.length > 1
      ? `<div class="sequence">${calls
          .map((call, index) => {
            const previous = calls[index - 1];
            /**
             * The join says what the relationship is: `or` between two arms of
             * one conditional, `+` for concurrent, `→` for a real sequence. An
             * arrow between alternatives would claim both requests happen.
             */
            const join =
              index === 0
                ? ''
                : previous.order === call.order
                  ? 'or'
                  : call.parallelWith.length && previous.parallelWith.length
                    ? '+'
                    : '→';
            return (
              (join ? `<span class="seq-join">${join}</span>` : '') +
              `<span class="seq-item${call.onFailure ? ' on-failure' : ''}">` +
              `<span class="seq-n">${call.order}</span>` +
              `<code>${escapeHtml(call.endpoint)}</code></span>`
            );
          })
          .join('')}</div>`
      : '';

  panel.innerHTML =
    intro +
    sequence +
    calls.map(renderApiCall).join('') +
    renderAftermath(state.insight.apis.aftermath) +
    notesList(state.insight.apis.notes);
  bindFlowJumps(panel);
  bindCopy(panel);
}

function renderApiCall(call) {
  const rows = [];

  // --- the request ---------------------------------------------------------
  rows.push(
    section(
      'Request',
      `<dl class="kv">
        ${kv('Endpoint', `<code>${escapeHtml(call.endpoint)}</code>`)}
        ${call.rawPath ? kv('URL in the frontend', `<code>${escapeHtml(call.rawPath)}</code>`) : ''}
        ${call.client ? kv('Sent with', `<code>${escapeHtml(call.client)}</code>`) : ''}
        ${kv(
          'Called from',
          call.callSites.length
            ? call.callSites
                .map((site) => {
                  const [file, line] = splitSite(site);
                  return fileRef(file, line);
                })
                .join(' ')
            : '<span class="muted">unknown</span>',
        )}
        ${
          call.queryKeys.length
            ? kv('Query', call.queryKeys.map((key) => `<code>${escapeHtml(key)}</code>`).join(' '))
            : ''
        }
      </dl>`,
    ),
  );

  // --- body, with the contract folded in -----------------------------------
  const contract = call.contract;
  const unexpected = new Set((contract?.unexpected ?? []).map((field) => field.name));
  const carriesBody = ['POST', 'PUT', 'PATCH'].includes(call.method);
  if (call.payload.length === 0 && carriesBody) {
    /**
     * A body we could not read is not the same as no body.
     *
     * `api.post(url, payload)` with a variable rather than an object literal
     * leaves nothing to enumerate at the call site. Skipping the section
     * silently would read as "this request sends nothing", which is wrong in
     * the one place someone is checking what it sends.
     */
    rows.push(
      section(
        'Body',
        `<p class="muted small">This request sends a body, but the keys are not
           readable at the call site — the payload is a variable rather than an
           object literal. The <strong>Flow</strong> tab shows the state it is built
           from.</p>`,
      ),
    );
  } else if (call.payload.length > 0 || contract?.missing.length) {
    rows.push(
      section(
        'Body',
        `${
          call.payload.length
            ? `<table class="kv-table">
                 <thead><tr><th>Key</th><th>From</th><th>Accepted?</th></tr></thead>
                 <tbody>${call.payload
                   .map(
                     (field) => `<tr>
                        <td><code>${escapeHtml(field.name)}</code></td>
                        <td class="muted">${
                          field.from ? `<code>${escapeHtml(field.from)}</code>` : '—'
                        }</td>
                        <td>${
                          !contract || !call.dto
                            ? '<span class="muted">no DTO to check</span>'
                            : unexpected.has(field.name)
                              ? '<span class="chip small danger">not declared</span>'
                              : '<span class="chip small ok">yes</span>'
                        }</td>
                      </tr>`,
                   )
                   .join('')}</tbody>
               </table>`
            : '<p class="muted small">No body.</p>'
        }
        ${
          contract?.missing.length
            ? `<p class="small">Declared but never sent: ${contract.missing
                .map((field) => `<code>${escapeHtml(field.name)}</code>`)
                .join(' ')}</p>`
            : ''
        }
        ${
          unexpected.size > 0
            ? `<p class="small warn-text">A key the route does not declare is usually
                 dropped by the validation layer — the request succeeds and the value
                 disappears.</p>`
            : ''
        }`,
        true,
      ),
    );
  }

  // --- the server side -----------------------------------------------------
  if (!call.matched) {
    rows.push(
      section(
        'Handled by',
        `<p class="small warn-text">Nothing in this project answers this call.</p>`,
      ),
    );
  } else {
    rows.push(
      section(
        'Handled by',
        `<dl class="kv">
          ${kv(
            'Route',
            `<code>${escapeHtml(call.route.method)} ${escapeHtml(call.route.path)}</code>` +
              (call.route.framework
                ? ` <span class="chip small">${escapeHtml(call.route.framework)}</span>`
                : ''),
          )}
          ${
            call.route.controller
              ? kv('Controller', `<code>${escapeHtml(call.route.controller)}</code>`)
              : ''
          }
          ${call.route.handler ? kv('Handler', `<code>${escapeHtml(call.route.handler)}</code>`) : ''}
          ${call.route.file ? kv('Declared in', fileRef(call.route.file, call.route.line)) : ''}
        </dl>`,
      ),
    );

    rows.push(
      section(
        'Before the handler',
        call.middleware.length
          ? `<ul class="plain small">${call.middleware
              .map(
                (entry) =>
                  `<li><strong>${escapeHtml(entry.name)}</strong>
                     <span class="muted">${escapeHtml(entry.role)}</span>
                     ${entry.file ? fileRef(entry.file, entry.line) : ''}</li>`,
              )
              .join('')}</ul>`
          : '<p class="muted small">No guard, pipe or middleware — the handler runs directly.</p>',
      ),
    );

    if (call.dto) {
      rows.push(
        section(
          'Validated by',
          `<p class="small"><code>${escapeHtml(call.dto.name)}</code> declares
             ${call.dto.fields.map((f) => `<code>${escapeHtml(f.name)}</code>`).join(' ')}</p>`,
        ),
      );
    }

    if (call.handlers.length) {
      rows.push(
        section(
          'Code it runs',
          `<ul class="ref-list">${call.handlers
            .map(
              (entry) =>
                `<li><span class="ref-name">${escapeHtml(entry.label)}</span>${
                  entry.file ? fileRef(entry.file, entry.line) : ''
                }</li>`,
            )
            .join('')}</ul>`,
          true,
        ),
      );
    }

    if (call.data.length) {
      rows.push(
        section(
          'Data it touches',
          `<table class="data-table">
             <thead><tr>
               <th>Effect</th><th>Collection</th><th>Operation</th><th>Issued by</th><th>Where</th>
             </tr></thead>
             <tbody>${call.data
               .map(
                 (entry) => `<tr>
                    <td><span class="chip small effect-${escapeHtml(
                      entry.effect,
                    )}">${escapeHtml(entry.effect)}</span></td>
                    <td><code>${escapeHtml(entry.collection)}</code></td>
                    <td class="mono muted">${escapeHtml(entry.operation)}</td>
                    <td class="muted">${escapeHtml(entry.by ?? '—')}</td>
                    <td>${entry.file ? fileRef(entry.file, entry.line) : ''}</td>
                  </tr>`,
               )
               .join('')}</tbody>
           </table>`,
          true,
        ),
      );
    }

    if (call.effects.length) {
      rows.push(
        section(
          'Leaves the app',
          `<ul class="ref-list">${call.effects
            .map(
              (entry) =>
                `<li><span class="ref-name">${escapeHtml(entry.label)}</span>
                   <span class="muted">${escapeHtml(entry.kind)}</span>
                   ${entry.file ? fileRef(entry.file, entry.line) : ''}</li>`,
            )
            .join('')}</ul>`,
          true,
        ),
      );
    }

    rows.push(
      section(
        'What comes back',
        `<dl class="kv">
          ${kv(
            'Status seen',
            call.response.statusCodes.length
              ? call.response.statusCodes
                  .map(
                    (code) =>
                      `<span class="chip small ${
                        code >= 500 ? 'danger' : code >= 400 ? 'warn' : 'ok'
                      }">${code}</span>`,
                  )
                  .join(' ')
              : '<span class="muted">never observed running</span>',
          )}
          ${kv(
            'Lands in',
            call.response.landsInState.length
              ? call.response.landsInState
                  .map((name) => `<code>${escapeHtml(name)}</code>`)
                  .join(' ')
              : '<span class="muted">no state Flowslens can see</span>',
          )}
        </dl>`,
      ),
    );

    rows.push(
      section(
        'Who else uses it',
        call.alsoUsedBy.length || call.otherCallSites.length
          ? `${
              call.alsoUsedBy.length
                ? `<ul class="plain small">${call.alsoUsedBy
                    .map(
                      (feature) =>
                        `<li><button class="link" data-goto-flow="${escapeHtml(
                          feature.id,
                        )}">${escapeHtml(feature.title)}</button>${
                          feature.subtitle
                            ? ` <span class="muted">${escapeHtml(feature.subtitle)}</span>`
                            : ''
                        }</li>`,
                    )
                    .join('')}</ul>`
                : ''
            }
             ${
               call.otherCallSites.length
                 ? `<p class="small muted">Also called from ${call.otherCallSites
                     .map((site) => {
                       const [file, line] = splitSite(site);
                       return fileRef(file, line);
                     })
                     .join(' ')}</p>`
                 : ''
             }`
          : '<p class="muted small">Only this feature calls it.</p>',
      ),
    );
  }

  const curl = curlFor(call);

  return `<div class="api-call">
    <div class="api-head">
      <span class="seq-n big" title="${escapeHtml(call.when)}">${call.order}</span>
      <span class="method method-${escapeHtml(call.method.toLowerCase())}">${escapeHtml(
        call.method,
      )}</span>
      <code class="api-path">${escapeHtml(call.path)}</code>
      ${
        call.matched
          ? '<span class="chip small ok">matched</span>'
          : '<span class="chip small danger">no route</span>'
      }
      <span class="chip small">${escapeHtml(call.evidence)}</span>
      ${
        call.observations
          ? `<span class="muted small">${call.observations} run${
              call.observations === 1 ? '' : 's'
            }${call.avgMs ? ` · ${call.avgMs}ms` : ''}</span>`
          : ''
      }
    </div>
    <div class="api-when">
      ${escapeHtml(call.when)}${call.awaited ? ' · awaited' : ''}
    </div>
    ${
      call.warnings.length
        ? `<ul class="warn-list">${call.warnings
            .map((warning) => `<li>${escapeHtml(warning)}</li>`)
            .join('')}</ul>`
        : ''
    }
    <div class="api-sections">${rows.join('')}</div>
    <div class="command">
      <code>${escapeHtml(curl)}</code>
      <button class="button ghost small" data-copy="${escapeHtml(curl)}">Copy</button>
    </div>
  </div>`;
}

/**
 * A request you can paste into a terminal.
 *
 * The path keeps its `:param` placeholders rather than inventing an id — a
 * copyable command with a made-up value looks runnable and is not.
 */
function curlFor(call) {
  const body = call.payload.length
    ? ` \\\n  -d '${JSON.stringify(Object.fromEntries(call.payload.map((f) => [f.name, '…'])))}'`
    : '';
  const headers = call.payload.length ? " \\\n  -H 'content-type: application/json'" : '';
  return `curl -X ${call.method} "$BASE_URL${call.rawPath ?? call.path}"${headers}${body}`;
}

/**
 * A labelled block. `wide` spans the whole card.
 *
 * Tables and lists of file paths need the full width; four key/value pairs do
 * not. Mixing them in one auto-fit grid is what produced a four-column layout
 * with `updat/e` wrapping mid-word.
 */
function section(title, html, wide = false) {
  return `<section class="api-section${wide ? ' wide' : ''}"><h4>${escapeHtml(
    title,
  )}</h4>${html}</section>`;
}

function kv(key, value) {
  return `<dt>${escapeHtml(key)}</dt><dd>${value}</dd>`;
}

/** `web/src/Form.tsx:16` -> `['web/src/Form.tsx', 16]` */
function splitSite(site) {
  const match = /^(.*):(\d+)$/.exec(site);
  return match ? [match[1], Number(match[2])] : [site, undefined];
}

/** Tab 6 — what your uncommitted changes put at risk. */
function renderChanged() {
  const panel = el.panels.changed;
  if (!panel) return;
  if (!state.changed) return panelLoading(panel, 'what you have changed');

  const changed = state.changed;
  const intro = panelIntro(
    'This tab is about the whole project, not the selected feature: the files you ' +
      'have changed since the last commit, and the features that run through them.',
  );

  if (changed.error) {
    panel.innerHTML =
      intro +
      `<div class="empty-state">
         <h3>Could not read your changes</h3>
         <p>${escapeHtml(changed.error)}</p>
         <p class="muted">This view needs the project to be a git repository.</p>
       </div>`;
    return;
  }

  const refresh = `<button class="button ghost small" id="changed-refresh">Re-read changes</button>`;

  if (changed.features.length === 0) {
    panel.innerHTML =
      intro +
      `<div class="empty-state ${changed.files.length === 0 ? 'ok' : ''}">
         <h3>${
           changed.files.length === 0
             ? 'Nothing has changed'
             : 'No traced feature runs through your changes'
         }</h3>
         <p>${escapeHtml(changed.summary)}</p>
         ${
           changed.files.length > 0
             ? `<ul class="plain">${changed.files
                 .map((entry) => `<li>${fileLink(entry.file)}</li>`)
                 .join('')}</ul>`
             : ''
         }
         <p>${refresh}</p>
       </div>` +
      notesList(changed.notes);
    bindChangedRefresh(panel);
    return;
  }

  panel.innerHTML =
    intro +
    `<div class="verdict level-${changed.level}">
       <span class="verdict-level">${escapeHtml(changed.level)} risk</span>
       <span>${escapeHtml(changed.summary)}</span>
     </div>
     <div class="stat-row">
       <div class="stat"><span class="stat-value">${changed.features.length}</span>
         <span class="stat-label">features run through your changed files</span></div>
       <div class="stat"><span class="stat-value">${changed.untested.length}</span>
         <span class="stat-label">of them have no test at all</span></div>
       ${
         changed.collections.length
           ? `<div class="stat"><span class="stat-value">${changed.collections.length}</span>
                <span class="stat-label">collections the changed code touches:
                ${escapeHtml(changed.collections.join(', '))}</span></div>`
           : ''
       }
     </div>

     <h3>Features affected, most-touched first</h3>
     ${changed.features
       .map(
         (feature) => `<div class="affected ${feature.testCases === 0 ? 'untested' : ''}">
            <div class="affected-head">
              <button class="link" data-goto-flow="${escapeHtml(feature.id)}">${escapeHtml(
                feature.title,
              )}</button>
              ${
                feature.subtitle
                  ? `<span class="muted small">${escapeHtml(feature.subtitle)}</span>`
                  : ''
              }
              <span class="chip small ${feature.testCases === 0 ? 'danger' : 'ok'}">
                ${
                  feature.testCases === 0
                    ? 'no test'
                    : `${feature.testCases} test${feature.testCases === 1 ? '' : 's'}`
                }
              </span>
            </div>
            <ul class="plain small">${feature.touchedSteps
              .map(
                (step) =>
                  `<li>${escapeHtml(step.label)} ${fileLink(step.file, step.line, 'tiny')}</li>`,
              )
              .join('')}</ul>
          </div>`,
       )
       .join('')}

     <h3>Changed files</h3>
     <ul class="plain small">${changed.files
       .map(
         (entry) =>
           `<li>${fileLink(entry.file)} <span class="muted">${escapeHtml(
             entry.status ?? 'modified',
           )}${entry.steps === 0 ? ' · not in the graph' : ` · ${entry.steps} steps`}</span></li>`,
       )
       .join('')}</ul>
     <p>${refresh}</p>` +
    notesList(changed.notes);

  bindFlowJumps(panel);
  bindChangedRefresh(panel);
}

/** Copy-to-clipboard for any element carrying `data-copy`. */
function bindCopy(panel) {
  for (const button of panel.querySelectorAll('[data-copy]')) {
    button.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(button.dataset.copy);
        const original = button.textContent;
        button.textContent = 'Copied';
        setTimeout(() => {
          button.textContent = original;
        }, 1200);
      } catch {
        // A clipboard the browser will not give us is not worth an error
        // dialog: the command is on screen and selectable either way.
      }
    });
  }
}

function bindChangedRefresh(panel) {
  panel.querySelector('#changed-refresh')?.addEventListener('click', () => {
    void loadChanged();
  });
}

/**
 * What happens once the requests come back.
 *
 * Rendered as its own block below the calls rather than inside one, because
 * these are consequences of the action as a whole: a navigation happens once,
 * not once per request.
 */
function renderAftermath(after) {
  if (!after) return '';
  const hasContent =
    after.navigatesTo.length ||
    after.invalidates.length ||
    after.errorStates.length ||
    after.notifies.length ||
    after.notes.length;
  if (!hasContent) return '';

  const block = (title, html) =>
    html ? `<section class="api-section wide"><h4>${escapeHtml(title)}</h4>${html}</section>` : '';

  return `<div class="api-call aftermath">
    <div class="api-head">
      <span class="api-path">After the response</span>
      ${
        after.handlesErrors
          ? '<span class="chip small ok">failures handled</span>'
          : '<span class="chip small warn">no error handling</span>'
      }
    </div>
    <div class="api-sections">
      ${block(
        'Goes to',
        after.navigatesTo.length
          ? `<ul class="ref-list">${after.navigatesTo
              .map((target) => `<li><span class="ref-name">${escapeHtml(target)}</span></li>`)
              .join('')}</ul>`
          : '',
      )}
      ${block(
        'Refetches',
        after.invalidates.length
          ? `<ul class="ref-list">${after.invalidates
              .map(
                (entry) =>
                  `<li><span class="ref-name">${escapeHtml(entry.key)}</span>` +
                  `<span class="muted">${
                    entry.refetches.length
                      ? `→ ${entry.refetches.map((e) => escapeHtml(e)).join(', ')}`
                      : '→ no GET endpoint matched this key'
                  }</span></li>`,
              )
              .join('')}</ul>`
          : '',
      )}
      ${block(
        'The user sees',
        after.notifies.length || after.errorStates.length
          ? `<ul class="ref-list">${[
              ...after.notifies.map(
                (entry) => `<li><span class="ref-name">${escapeHtml(entry)}</span></li>`,
              ),
              ...after.errorStates.map(
                (entry) =>
                  `<li><span class="ref-name">${escapeHtml(entry)}</span>` +
                  `<span class="muted">error state</span></li>`,
              ),
            ].join('')}</ul>`
          : '',
      )}
    </div>
    ${notesList(after.notes)}
  </div>`;
}
