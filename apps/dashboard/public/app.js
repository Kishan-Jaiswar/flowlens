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
  upsert: 'upsert',
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
  /** Page groups the user folded in the sidebar, kept across re-renders. */
  closedPages: new Set(),
  /** Issues & impact sections the reader folded or opened, by section. */
  impactOpen: {},
  includeLocal: false,
  /** Which tab is showing: docs | perf | tests | changed | impact. */
  tab: 'docs',
  /** How the Docs tab shows the action: the stage list, or the diagram. */
  docView: 'list',
  /** Timing, blast radius, tests and contract for the selected flow. */
  insight: null,
  /** The diff-scoped report, which is project-wide rather than per feature. */
  changed: null,
  changedLoading: false,
  /** `/api/changed/breakage`: what the change breaks, which takes a type check. */
  breakage: null,
  breakageLoading: false,
  /** `/api/unused`: code nothing uses, for the whole project. */
  unused: null,
  /** The Docs tab's document for the selected action, and which action it is for. */
  actionDoc: null,
  actionDocFor: null,
  actionDocLoading: false,
  /** True while /api/insight is in flight, so tabs can say "loading" once. */
  insightLoading: false,
  /** The Queries tab's answer for the selected action, and which action it is for. */
  queries: null,
  queriesFor: null,
  queriesLoading: false,
  /** The Decisions tab's tree for the selected action, and which action it is for. */
  decisions: null,
  decisionsFor: null,
  decisionsLoading: false,
  /** Project-wide findings, read once per scan. */
  findings: null,
  /** Which severities and kinds Issues & impact shows for the rest of the project. */
  issueSeverities: new Set(['high', 'medium']),
  issueKind: 'all',
};

/**
 * The tabs, in the order the user asked for them.
 *
 * Each answers one question and none repeats another: Docs is the
 * whole action (as a list or as a diagram — the old Flow tab — with the
 * request details the old APIs tab had folded into its request step),
 * Decisions is every way it can go — the checks and branches from the click
 * to the database and back — Performance is where the time goes (steps, and each database query with its
 * code), then Tests, Changed and Breaks. Links to the tabs that were merged
 * away still land in the right place (see `LEGACY_TABS`).
 */
const TABS = [
  ['docs', 'Docs', 'This action end to end, as a list or a diagram'],
  [
    'decisions',
    'Decisions',
    'Every way this action can go: each check, branch and query, from the click to the database and back',
  ],
  ['perf', 'Performance', 'Where the time goes: each step, and each database query with its code'],
  ['tests', 'Tests', 'What would catch it if you broke it'],
  [
    'impact',
    'Issues & impact',
    'What is wrong and what could break: bugs in this action, what your edits break, and what a change to this action would reach',
  ],
  ['unused', 'Unused', 'Files, folders, exports and dependencies nothing uses'],
];

/** Tabs that were merged into others, for links pasted before the merge. */
const LEGACY_TABS = {
  flow: ['docs', 'diagram'],
  apis: ['docs', 'list'],
  timing: ['perf'],
  queries: ['perf'],
  changed: ['impact'],
  breaks: ['impact'],
  issues: ['impact'],
};

/** Tabs that ignore the selected feature. */
const PROJECT_TABS = new Set(['unused']);

const el = {
  subtitle: document.getElementById('subtitle'),
  flowList: document.getElementById('flow-list'),
  flowSummary: document.getElementById('flow-summary'),
  foldAll: document.getElementById('fold-all'),
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
    docs: document.getElementById('panel-docs'),
    decisions: document.getElementById('panel-decisions'),
    issues: document.getElementById('panel-issues'),
    perf: document.getElementById('panel-perf'),
    impact: document.getElementById('panel-impact'),
    tests: document.getElementById('panel-tests'),
    unused: document.getElementById('panel-unused'),
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
    void loadIssues();
    void loadUnused();

    // `#tab=apis&flow=<id>` (or the older `#docs=<id>`) opens straight onto
    // that tab and action, so a link pasted into a ticket lands where it was
    // copied from.
    const hash = new URLSearchParams(window.location.hash.slice(1));
    const linked = hash.get('flow') ?? hash.get('docs');
    const target = state.flows.find((flow) => flow.id === linked);
    const tab = hash.get('tab') ?? (hash.has('docs') ? 'docs' : null);
    const legacy = tab ? LEGACY_TABS[tab] : undefined;
    if (legacy) {
      state.tab = legacy[0];
      if (legacy[1]) state.docView = legacy[1];
    } else if (tab && TABS.some(([candidate]) => candidate === tab)) state.tab = tab;
    if (hash.get('view') === 'diagram') state.docView = 'diagram';
    const first = target ?? filteredFlows()[0];
    if (first) selectFlow(first.id);
    else {
      // A backend scanned on its own has no user actions; its issues are still
      // the project's, so that is where it opens.
      renderEmpty();
      if (!tab) state.tab = 'impact';
      renderTabs();
      showTab(state.tab);
    }
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
    [
      flow.title,
      flow.label,
      flow.screen,
      flow.component,
      flow.id,
      ...flow.endpoints,
      ...(flow.pages ?? []).map((page) => page.route),
    ]
      .filter(Boolean)
      .some((value) => value.toLowerCase().includes(needle)),
  );
}

function renderFlowList() {
  const flows = filteredFlows();
  const groups = pageGroups(flows);
  const searching = state.filter.trim() !== '';
  el.flowList.innerHTML = '';
  renderListSummary(flows, groups, searching);

  if (flows.length === 0) {
    el.flowList.innerHTML = searching
      ? `<div class="list-empty">
           <p>No action matches <strong>“${escapeHtml(state.filter.trim())}”</strong>.</p>
           <p class="muted">Try a button's text, a page like <code>/settings</code>, or an API path.</p>
           <button type="button" class="clear-filter">Clear search</button>
         </div>`
      : '<div class="list-empty"><p class="muted">No actions were found in this project.</p></div>';
    el.flowList.querySelector('.clear-filter')?.addEventListener('click', clearFilter);
    return;
  }

  for (const group of groups) {
    const section = document.createElement('details');
    section.className = 'page-group';
    // A search shows every match, folded or not; a fold comes back after it.
    section.open = searching || !state.closedPages.has(group.key);
    section.ontoggle = () => {
      if (searching) return;
      if (section.open) state.closedPages.delete(group.key);
      else state.closedPages.add(group.key);
      renderFoldAll();
    };
    section.innerHTML = `
      <summary title="${escapeHtml(group.hint)}">
        <span class="page-icon" aria-hidden="true">${ICONS[group.icon]}</span>
        <span class="page-text">
          <span class="page-name">${escapeHtml(group.name)}</span>
          ${group.sub ? `<span class="page-route">${escapeHtml(group.sub)}</span>` : ''}
        </span>
        <span class="page-count" title="${plural(group.flows.length, 'action')}">${group.flows.length}</span>
      </summary>`;

    const loads = group.flows.filter(isPageLoad);
    const actions = group.flows.filter((flow) => !isPageLoad(flow));
    const both = loads.length > 0 && actions.length > 0;
    if (both) section.appendChild(subheading('When the page opens'));
    for (const flow of loads) section.appendChild(flowItem(flow, group));
    if (both) section.appendChild(subheading('What the user can do'));
    for (const flow of actions) section.appendChild(flowItem(flow, group));
    el.flowList.appendChild(section);
  }
  renderFoldAll();
}

function renderListSummary(flows, groups, searching) {
  const pages = groups.filter((group) => group.kind === 'page').length;
  const where = pages ? ` on ${plural(pages, 'page')}` : '';
  el.flowSummary.textContent = searching
    ? `${flows.length} of ${plural(state.flows.length, 'action')} match`
    : `${plural(flows.length, 'action')}${where}`;
}

/** The header button folds every group, or opens them all once they are folded. */
function renderFoldAll() {
  const groups = [...el.flowList.querySelectorAll('.page-group')];
  const searching = state.filter.trim() !== '';
  el.foldAll.hidden = groups.length < 2 || searching;
  el.foldAll.textContent = groups.every((group) => !group.open) ? 'Expand all' : 'Collapse all';
}

/** The sidebar keys of the groups a flow is listed under. */
function groupKeys(flow) {
  const pages = flow.pages ?? [];
  if (pages.length === 0) return ['none'];
  return pages.map((page) => `${page.layout ? 'layout' : 'page'}:${page.route}`);
}

function subheading(text) {
  const node = document.createElement('div');
  node.className = 'page-sub';
  node.textContent = text;
  return node;
}

/**
 * The sidebar, one group per page the actions are on.
 *
 * Pages first, by route; then actions that only a layout reaches (they are on
 * every page under it); then the ones no page renders, such as runtime-only
 * actions. An action on two pages is listed under both.
 */
function pageGroups(flows) {
  const groups = new Map();
  const place = (key, init, flow) => {
    if (!groups.has(key)) groups.set(key, { key, ...init, flows: [] });
    groups.get(key).flows.push(flow);
  };
  for (const flow of flows) {
    const pages = flow.pages ?? [];
    if (pages.length === 0) {
      place(
        'none',
        {
          kind: 'none',
          name: 'Other actions',
          sub: 'not placed on a page',
          hint: 'No page renders these — seen only at runtime, or in a component nothing uses',
          icon: 'other',
          order: 2,
          route: '',
        },
        flow,
      );
      continue;
    }
    for (const page of pages) {
      const layout = page.layout;
      place(
        groupKeys({ pages: [page] })[0],
        {
          kind: layout ? 'layout' : 'page',
          name: layout
            ? page.route === '/'
              ? 'All pages'
              : `All pages under ${page.route}`
            : pageName(page.route),
          sub: layout ? 'shared layout' : page.route,
          hint: page.file,
          icon: layout ? 'layout' : 'page',
          order: layout ? 1 : 0,
          route: page.route,
          file: page.file,
        },
        flow,
      );
    }
  }
  return [...groups.values()].sort((a, b) => a.order - b.order || a.route.localeCompare(b.route));
}

/**
 * `/medicines/[id]/edit` -> `Medicines › Edit`, the way someone would say it.
 *
 * A route that ends on a parameter is one record's page: `/medicines/[id]` is
 * the medicine's details.
 */
function pageName(route) {
  const segments = route.split('/').filter(Boolean);
  if (segments.length === 0) return 'Home';
  const dynamic = (segment) => /^\[.*\]$|^:/.test(segment);
  const words = segments.filter((segment) => !dynamic(segment)).map(humanizeSegment);
  if (dynamic(segments[segments.length - 1])) words.push('Details');
  return words.join(' › ') || 'Details';
}

function humanizeSegment(segment) {
  const words = segment.replace(/[-_]+/g, ' ').replace(/([a-z])([A-Z])/g, '$1 $2');
  return words.charAt(0).toUpperCase() + words.slice(1).toLowerCase();
}

/**
 * What the row calls the action, given the page it sits under.
 *
 * The page is in the heading, so `Medicines · Delete` under Medicines is just
 * `Delete`. A label the scanner built from code (`MedicineForm onSubmit`) falls
 * back to the composed title, which is written in words.
 */
function actionName(flow, group) {
  if (isPageLoad(flow)) {
    if (group?.file && flow.steps[0]?.file === group.file) return 'Page opens';
    return flowTitle(flow);
  }
  const label = flow.label ?? '';
  if (label && !/\bon[A-Z]\w*\b/.test(label) && !/^[A-Z][a-z]+[A-Z]\w*\b/.test(label)) return label;
  // `Add medicine dialog submit` -> `Submit`; the dialog goes on the line below.
  const title = flowTitle(flow);
  const screen = flow.screen ?? '';
  if (screen && title.toLowerCase().startsWith(`${screen.toLowerCase()} `)) {
    const rest = title.slice(screen.length).replace(/^[\s·]+/, '');
    if (rest) return rest.charAt(0).toUpperCase() + rest.slice(1);
  }
  return title;
}

/** Where on the page the action is, when it is not the page's own code. */
function actionPlace(flow, group) {
  const file = flow.steps[0]?.file;
  if (!flow.screen || !file || file === group?.file) return '';
  const name = actionName(flow, group).toLowerCase();
  if (name.includes(flow.screen.toLowerCase())) return '';
  return `in ${flow.screen}`;
}

function isPageLoad(flow) {
  return flow.event === 'mount';
}

/** `load`, `submit` or `click`: what the row's icon says the user does. */
function actionKind(flow) {
  if (isPageLoad(flow)) return 'load';
  if (/submit/i.test(flow.event ?? '')) return 'submit';
  if (!flow.event) return 'runtime';
  return 'click';
}

const KIND_TEXT = {
  load: 'Runs by itself when this opens',
  submit: 'Runs when the user submits a form',
  click: 'Runs when the user clicks',
  runtime: 'Seen while the app ran; no source found for it',
};

const ICONS = {
  page: '<svg viewBox="0 0 16 16"><path d="M4 1.5h5.5L13 5v9.5H4z" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/><path d="M9.5 1.5V5H13" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/></svg>',
  layout:
    '<svg viewBox="0 0 16 16"><rect x="2" y="2.5" width="12" height="11" rx="1.5" fill="none" stroke="currentColor" stroke-width="1.3"/><path d="M2 6h12M6 6v7.5" stroke="currentColor" stroke-width="1.3"/></svg>',
  other:
    '<svg viewBox="0 0 16 16"><circle cx="4" cy="8" r="1.2" fill="currentColor"/><circle cx="8" cy="8" r="1.2" fill="currentColor"/><circle cx="12" cy="8" r="1.2" fill="currentColor"/></svg>',
  load: '<svg viewBox="0 0 16 16"><path d="M13 8a5 5 0 1 1-1.6-3.7" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/><path d="M13 2.5V5h-2.5" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  click:
    '<svg viewBox="0 0 16 16"><path d="M5 2.5v9l2.3-2.1 1.6 3.6 1.6-.7-1.6-3.5H12z" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/></svg>',
  submit:
    '<svg viewBox="0 0 16 16"><path d="M3 8.5l3 3 7-7" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  runtime:
    '<svg viewBox="0 0 16 16"><path d="M1.5 8h3l2-4.5 3 9 2-4.5h3" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>',
};

function flowItem(flow, group) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'flow-item';
  button.dataset.flowId = flow.id;
  button.setAttribute('aria-selected', String(flow.id === state.selectedFlow?.id));
  button.onclick = () => selectFlow(flow.id);
  const kind = actionKind(flow);
  const issues = issuesFor(flow.id).filter((finding) => finding.severity !== 'low');
  const worst = issues.some((finding) => finding.severity === 'high') ? 'high' : 'medium';
  button.title = [
    flowTitle(flow),
    KIND_TEXT[kind],
    flow.component && `Component: ${flow.component}`,
  ]
    .filter(Boolean)
    .join('\n');
  const [endpoint, ...more] = flow.endpoints;
  const [method, ...path] = (endpoint ?? '').split(' ');
  const place = actionPlace(flow, group);
  button.classList.toggle('has-issues', issues.length > 0);
  button.innerHTML = `
    <span class="kind-icon kind-${kind}" aria-hidden="true">${ICONS[kind]}</span>
    <span class="flow-text">
      <span class="label">${escapeHtml(actionName(flow, group))}</span>
      ${place ? `<span class="place">${escapeHtml(place)}</span>` : ''}
      <span class="meta">${
        endpoint
          ? `<span class="list-method verb-${escapeHtml(method.toLowerCase())}">${escapeHtml(method)}</span><span class="path">${escapeHtml(path.join(' '))}</span>${
              more.length
                ? `<span class="more-apis" title="${escapeHtml(more.join('\n'))}">+${more.length}</span>`
                : ''
            }`
          : '<span class="path">stays in the browser</span>'
      }</span>
    </span>
    ${
      issues.length
        ? `<span class="issue-mark sev-${worst}" title="${plural(issues.length, 'issue')} — see Issues & impact">⚠ ${issues.length}</span>`
        : ''
    }`;
  return button;
}

/** `plural(2, 'action')` -> `2 actions`. */
function plural(count, word) {
  return `${count} ${word}${count === 1 ? '' : 's'}`;
}

function clearFilter() {
  state.filter = '';
  el.filter.value = '';
  renderFlowList();
  el.filter.focus();
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
  if (state.queriesFor !== flow.id) state.queries = null;
  // Opening an action from a link or another tab shows it in the list too.
  for (const key of groupKeys(flow)) state.closedPages.delete(key);
  renderFlowList();
  el.flowList
    .querySelector(`.flow-item[aria-selected="true"]`)
    ?.scrollIntoView?.({ block: 'nearest' });
  renderFlowHeader(flow);
  renderGraph(flow);
  renderDetails(null);
  renderTabs();
  showTab(state.tab);
  void loadInsight(flow.id);
}

/**
 * Show the document for the selected action.
 *
 * Fetched when the tab is opened rather than with the insight: it reads
 * source files on the server, and a reader clicking through the list should
 * not pay for a document they are not looking at.
 */
function openDocsForSelection() {
  const id = state.selectedFlow?.id ?? null;
  if (id && id !== state.actionDocFor) {
    void loadActionDoc(id);
    return;
  }
  renderDocs();
}

async function loadActionDoc(flowId) {
  state.actionDocFor = flowId;
  state.actionDoc = null;
  state.actionDocLoading = true;
  renderTabs();
  renderDocs();
  try {
    const doc = await getJson(`/api/action?flow=${encodeURIComponent(flowId)}`);
    // The reader may have picked another action while this was in flight.
    if (state.actionDocFor !== flowId) return;
    state.actionDoc = doc;
  } catch (error) {
    if (state.actionDocFor !== flowId) return;
    state.actionDoc = { error: String(error.message ?? error) };
  } finally {
    if (state.actionDocFor === flowId) state.actionDocLoading = false;
    renderTabs();
    if (state.tab === 'docs') renderDocs();
    // The graph is drawn before the document arrives, whichever tab is open.
    if (state.selectedFlow?.id === flowId) renderGraph(state.selectedFlow);
  }
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
    // The Docs tab is open by default and every tab links into it.
    if (state.actionDocFor !== flowId) void loadActionDoc(flowId);
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
  // Your own breaking edits outrank anything about the selected action.
  if (id === 'impact') return impactBadge();

  if (id === 'unused') {
    const unused = state.unused;
    if (!unused || unused.error) return undefined;
    const count =
      unused.files.length +
      unused.broken.length +
      unused.dependencies.length +
      unused.exports.filter((entry) => !entry.usedInFile).length;
    return count === 0 ? { text: 'clean', tone: 'muted' } : { text: String(count), tone: 'warn' };
  }

  if (id === 'docs') {
    if (state.actionDocLoading) return { text: '…', tone: 'neutral' };
    const doc = state.actionDoc;
    if (!doc || doc.error || doc.flowId !== state.selectedFlow?.id) return undefined;
    const found = doc.stages.filter((stage) => !stage.absent).length;
    return { text: `${found} steps`, tone: 'neutral' };
  }

  if (id === 'decisions') {
    if (state.decisionsLoading) return { text: '…', tone: 'neutral' };
    const tree = state.decisions;
    if (!tree || tree.error || tree.flowId !== state.selectedFlow?.id) return undefined;
    const count = tree.counts.decisions;
    return count === 0
      ? { text: 'straight', tone: 'muted' }
      : { text: `${count} ${count === 1 ? 'branch' : 'branches'}`, tone: 'neutral' };
  }

  const flow = state.selectedFlow;
  if (!flow) return undefined;
  if (state.insightLoading && !state.insight) return { text: '…', tone: 'neutral' };
  const insight = state.insight;
  if (!insight || insight.error) return undefined;

  if (id === 'perf') {
    // The whole action when it has run; otherwise the slowest query, if any has.
    if (insight.timing?.observed) {
      const slow = (state.queries?.flowId === flow.id ? state.queries.queries : []).some(
        (query) => (query.timing?.avgMs ?? 0) >= SLOW_QUERY_MS,
      );
      return { text: formatMs(insight.timing.totalMs), tone: slow ? 'warn' : 'neutral' };
    }
    return { text: 'not run', tone: 'muted' };
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

/**
 * One badge for Issues & impact, so the most worrying of its answers wins:
 * your own breaking edits, then bugs in the selected action, then how far a
 * change to it would reach.
 */
function impactBadge() {
  const breaks = state.breakage?.totals;
  if (breaks && breaks.broken + breaks.likely + breaks.errors > 0) {
    return { text: `${breaks.broken + breaks.likely || breaks.errors} breaking`, tone: 'danger' };
  }
  const flow = state.selectedFlow;
  const findings = state.findings && !state.findings.error ? state.findings.findings : undefined;
  const mine = findings ? (flow ? issuesFor(flow.id) : findings) : [];
  if (mine.length) {
    const high = mine.filter((finding) => finding.severity === 'high').length;
    const medium = mine.some((finding) => finding.severity === 'medium');
    // Without an action, the project's worst: a total of hundreds says nothing.
    if (!flow && high) return { text: `${high} high`, tone: 'danger' };
    return {
      text: plural(mine.length, 'issue'),
      tone: high ? 'danger' : medium ? 'warn' : 'neutral',
    };
  }
  if (!flow) return findings ? { text: 'none', tone: 'ok' } : { text: '…', tone: 'neutral' };
  const impact = state.insight && !state.insight.error ? state.insight.impact : undefined;
  if (!findings || !impact) {
    return state.insightLoading || !state.findings ? { text: '…', tone: 'neutral' } : undefined;
  }
  const count = impact.featuresAtRisk?.length ?? 0;
  if (count === 0) return { text: 'clean', tone: 'ok' };
  return { text: `${count} at risk`, tone: impact.level === 'high' ? 'danger' : 'warn' };
}

function showTab(id) {
  const legacy = LEGACY_TABS[id];
  if (legacy) {
    id = legacy[0];
    if (legacy[1]) state.docView = legacy[1];
  }
  state.tab = TABS.some(([candidate]) => candidate === id) ? id : 'docs';
  const diagram = state.tab === 'docs' && state.docView === 'diagram';
  // Only the diagram uses the step inspector on the right; everything else
  // gets the full width.
  const layout = document.querySelector('.layout');
  layout?.setAttribute('data-tab', state.tab);
  layout?.toggleAttribute('data-diagram', diagram);
  const params = new URLSearchParams();
  params.set('tab', state.tab);
  if (state.selectedFlow) params.set('flow', state.selectedFlow.id);
  if (diagram) params.set('view', 'diagram');
  window.history.replaceState?.(null, '', `#${params}`);
  for (const [tabId] of TABS) {
    const panel = el.panels[tabId];
    if (panel) panel.hidden = tabId !== state.tab || (tabId === 'docs' && diagram);
  }
  if (el.graph) el.graph.hidden = !diagram;
  for (const button of el.tabs?.querySelectorAll('[data-tab]') ?? []) {
    const active = button.dataset.tab === state.tab;
    button.classList.toggle('active', active);
    button.setAttribute('aria-selected', String(active));
  }

  if (state.tab === 'decisions') openDecisionsForSelection();
  if (state.tab === 'impact') renderImpact();
  if (state.tab === 'tests') renderTests();
  if (state.tab === 'perf') openPerfForSelection();
  if (state.tab === 'unused') renderUnused();
  if (state.tab === 'docs') {
    openDocsForSelection();
    // The diagram draws the confirmation and the way back from the document.
    if (diagram && state.selectedFlow?.id === state.actionDocFor) renderGraph(state.selectedFlow);
  }
}

/** Switch the Docs tab between the stage list and the diagram. */
function setDocView(view) {
  state.docView = view === 'diagram' ? 'diagram' : 'list';
  if (state.docView === 'list') {
    state.selectedNode = null;
    document.querySelector('.layout')?.removeAttribute('data-inspecting');
  }
  showTab('docs');
}

/** The List / Diagram switch, drawn at the top of both views. */
function viewSwitch() {
  const button = (view, label) =>
    `<button class="view-option${state.docView === view ? ' active' : ''}" data-doc-view="${view}" ` +
    `aria-pressed="${state.docView === view}">${label}</button>`;
  return `<div class="view-switch" role="group" aria-label="Show the action as">${button('list', 'List')}${button('diagram', 'Diagram')}</div>`;
}

document.addEventListener('click', (event) => {
  const option = event.target.closest?.('[data-doc-view]');
  if (option) setDocView(option.dataset.docView);
});

/**
 * Fetch the diff report.
 *
 * Its own request, not part of `/api/insight`: it shells out to git, and
 * clicking through features should not pay for a `git status` nobody asked
 * about.
 */
async function loadChanged({ fresh = false } = {}) {
  state.changedLoading = true;
  renderTabs();
  try {
    state.changed = await getJson('/api/changed');
  } catch (error) {
    state.changed = { error: String(error.message ?? error) };
  } finally {
    state.changedLoading = false;
    renderTabs();
    if (state.tab === 'impact') renderImpact();
  }
  void loadBreakage({ fresh });
}

/**
 * Fetch what the change breaks.
 *
 * After the file view rather than with it: this one type-checks the project
 * twice and takes seconds, and the file view is worth reading while it runs.
 */
async function loadBreakage({ fresh = false } = {}) {
  state.breakageLoading = true;
  if (state.tab === 'impact') renderImpact();
  try {
    state.breakage = await getJson(`/api/changed/breakage${fresh ? '?fresh=1' : ''}`);
  } catch (error) {
    state.breakage = { error: String(error.message ?? error) };
  } finally {
    state.breakageLoading = false;
    renderTabs();
    if (state.tab === 'impact') renderImpact();
  }
}

/** Fetch the unused-code report — read at scan time, so this is only a lookup. */
async function loadUnused() {
  try {
    state.unused = await getJson('/api/unused');
  } catch (error) {
    state.unused = { error: String(error.message ?? error) };
  }
  renderTabs();
  if (state.tab === 'unused') renderUnused();
}

/**
 * Code nothing uses, whole-project like Changed: the imports that point at
 * nothing first (missing code, and the reason a whole folder can look dead),
 * then what could be deleted, biggest first — folders, files, dependencies —
 * then exports, and the endpoints no frontend calls, which need a human
 * because another app may call them.
 */
function renderUnused() {
  const panel = el.panels.unused;
  if (!panel) return;
  if (!state.unused) return panelLoading(panel, 'what nothing uses');
  const unused = state.unused;
  if (unused.error) {
    panel.innerHTML = `<p class="error">Could not load this view: ${escapeHtml(unused.error)}</p>`;
    return;
  }

  const intro = panelIntro(
    'Code no user action, request, job or test can reach, read from the imports. ' +
      'It is about the whole project, not the selected action. Nothing here is deleted for you.',
  );
  const dead = unused.exports.filter((entry) => !entry.usedInFile);
  const internal = unused.exports.filter((entry) => entry.usedInFile);
  const lines = unused.files.reduce((sum, entry) => sum + entry.lines, 0);
  const inFolder = (file) => unused.folders.some((entry) => file.startsWith(`${entry.folder}/`));
  const loose = unused.files.filter((entry) => !inFolder(entry.file));
  const total = unused.files.length + dead.length + unused.dependencies.length;

  const summary =
    total === 0 && unused.broken.length === 0
      ? answer(
          'ok',
          'Nothing unused',
          `Every one of the ${unused.checked.files} files is reached from the ${unused.checked.entries} entry points.` +
            (internal.length
              ? ` ${internal.length} export${internal.length === 1 ? ' is' : 's are'} only used inside ${internal.length === 1 ? 'its' : 'their'} own file — see below.`
              : ''),
        )
      : answer(
          unused.broken.length ? 'danger' : 'warn',
          [
            unused.broken.length
              ? `${unused.broken.length} import${unused.broken.length === 1 ? '' : 's'} pointing at nothing`
              : '',
            unused.files.length
              ? `${unused.files.length} unused file${unused.files.length === 1 ? '' : 's'} (${lines} lines)`
              : '',
            dead.length ? `${dead.length} dead export${dead.length === 1 ? '' : 's'}` : '',
            unused.dependencies.length
              ? `${unused.dependencies.length} unused dependenc${unused.dependencies.length === 1 ? 'y' : 'ies'}`
              : '',
          ]
            .filter(Boolean)
            .join(' · '),
          `Checked ${unused.checked.files} files from ${unused.checked.entries} entry points.`,
        );

  const parts = [intro, summary];
  if (unused.broken.length) {
    parts.push(
      heading(
        'Imports that point at nothing',
        'Missing code — the import names a file that is not there.',
      ),
      renderDocTable({
        columns: ['File', 'Imports'],
        rows: unused.broken.map((entry) => ({
          cells: [{ html: fileLink(entry.file) }, `\`${entry.specifier}\``],
          tone: 'error',
        })),
      }),
    );
  }
  if (unused.folders.length) {
    parts.push(
      heading('Folders nothing uses', 'Every file inside is unreachable.'),
      renderDocTable({
        columns: ['Folder', 'Files', 'Lines'],
        rows: unused.folders.map((entry) => ({
          cells: [`\`${entry.folder}/\``, String(entry.files), String(entry.lines)],
          tone: 'warn',
        })),
      }),
    );
  }
  if (loose.length) {
    parts.push(
      heading('Files nothing uses', 'No entry point reaches them, not even through another file.'),
      renderDocTable({
        columns: ['File', 'Lines'],
        rows: loose.map((entry) => ({
          cells: [{ html: fileLink(entry.file) }, String(entry.lines)],
          tone: 'warn',
        })),
      }),
    );
  }
  if (unused.dependencies.length) {
    parts.push(
      heading(
        'Dependencies nothing imports',
        'Not imported, not run by a script, not named in a config file.',
      ),
      renderDocTable({
        columns: ['Package', 'Version', 'Declared in'],
        rows: unused.dependencies.map((entry) => ({
          cells: [`\`${entry.name}\``, entry.version, `\`${entry.manifest}\``],
        })),
      }),
    );
  }
  if (dead.length) {
    parts.push(
      heading(
        'Exports nothing uses',
        'Not imported anywhere and not used in their own file: dead code.',
      ),
      renderDocTable({
        columns: ['Export', 'Kind'],
        rows: dead.map((entry) => ({
          cells: [`\`${entry.name}\``, entry.kind],
          at: { file: entry.file, line: entry.line },
          tone: 'warn',
        })),
      }),
    );
  }
  if (internal.length) {
    parts.push(
      `<details class="more"><summary>Exported but only used inside their own file — ${internal.length}</summary>` +
        `<p class="tab-note">The code is used; the <code>export</code> keyword is not, and can go.</p>` +
        renderDocTable({
          columns: ['Export', 'Kind'],
          rows: internal.map((entry) => ({
            cells: [`\`${entry.name}\``, entry.kind],
            at: { file: entry.file, line: entry.line },
          })),
        }) +
        '</details>',
    );
  }
  if (unused.endpoints.length) {
    parts.push(
      heading(
        'Endpoints no frontend calls',
        'The route file is loaded, but nothing in this app calls it. Another app, a webhook or a mobile client may — check before removing.',
      ),
      renderDocTable({
        columns: ['Route'],
        rows: unused.endpoints.map((entry) => ({
          cells: [`\`${entry.label}\``],
          ...(entry.file ? { at: { file: entry.file, line: entry.line } } : {}),
        })),
      }),
    );
  }
  parts.push(notesList(unused.notes));
  panel.innerHTML = parts.join('');
  bindTableFolds(panel);
}

function renderFlowHeader(flow) {
  const chips = [
    `<span class="chip risk-${flow.risk.level}">risk ${flow.risk.level} · ${flow.risk.score}</span>`,
    `<span class="chip">${flow.evidence}</span>`,
  ];
  if (flow.screen) chips.push(`<span class="chip">${escapeHtml(flow.screen)}</span>`);
  if (flow.event) chips.push(`<span class="chip">${escapeHtml(eventVerb(flow.event))}</span>`);
  if (flow.component) chips.push(`<span class="chip">${escapeHtml(flow.component)}</span>`);
  // Summed own time, not the wait: parallel requests overlap. Performance has the wait.
  if (flow.totalMs != null)
    chips.push(
      `<span class="chip" title="The own time of every measured step, added up. Steps that run at the same time overlap, so the user waits less — see Performance.">${formatMs(flow.totalMs)} of work measured</span>`,
    );
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
        ? `<p class="muted" style="margin-top:8px">${fileLink(flow.source.file, flow.source.line)}</p>`
        : ''
    }`;
}

/** What each lane of the Flow tab holds, in words anyone can read. */
const LAYER_NOTES = {
  ui: 'What the user does',
  frontend: 'Runs in the browser',
  network: 'The request, and the route that receives it',
  backend: 'Runs on the server',
  data: 'What happens in the database',
  external: 'Work that leaves the app',
  back: 'What the user sees afterwards',
};

/**
 * The Flow tab: every step of the action as a numbered card, top to bottom in
 * the order it happens, one lane per part of the app.
 *
 * Each card leads with a sentence saying what the step does ("Deletes from
 * products"), with the code name and file underneath, so it reads as a story
 * before it reads as a call graph. Two things the graph alone cannot say come
 * from the action document when it has loaded: the confirmation dialog the
 * handler waits on, and what the screen does with the answer. Hooks that only
 * hand the handler a helper (`useToast`) are not steps — they run when the
 * component renders — so they are named on the handler's card instead.
 */
function renderGraph(flow) {
  el.graph.innerHTML =
    `<div class="doc-bar"><div class="doc-picker">${viewSwitch()}<span>How this action works, end to end</span></div></div>` +
    panelIntro(
      'Read it top to bottom: each numbered box is one step, in the order it happens. ' +
        'Click a box to see its code.',
    );

  let number = 0;
  const next = () => (number += 1);
  const lanes = flowPlan(flow).map((lane) => ({
    ...lane,
    columns: lane.columns.map((column) =>
      column.map((item) =>
        item.step
          ? renderNode(item.step, next(), item.helpers, item.say)
          : storyCard(item.layer, next(), item.kind, item.summary, item.key),
      ),
    ),
  }));

  lanes.forEach((lane, index) => {
    const section = document.createElement('div');
    section.className = `layer lane-${lane.layer}`;
    const count = lane.columns.reduce((sum, column) => sum + column.length, 0);
    const title = document.createElement('div');
    title.className = 'layer-title';
    title.innerHTML =
      `<span class="layer-name">${escapeHtml(lane.title)}</span>` +
      `<span class="layer-note">${escapeHtml(LAYER_NOTES[lane.layer] ?? '')}</span>` +
      `<span class="layer-count">${count} step${count === 1 ? '' : 's'}</span>`;
    section.appendChild(title);
    const body = document.createElement('div');
    body.className = 'layer-body';
    section.appendChild(body);

    // Several collections need the grouped answer; one is already on its card.
    if (
      lane.layer === 'data' &&
      new Set(flow.collections.map((entry) => entry.collection)).size > 1
    ) {
      const summary = renderCollectionSummary(flow);
      if (summary) body.appendChild(summary);
    }

    body.appendChild(renderColumns(lane.columns));
    el.graph.appendChild(section);

    if (index < lanes.length - 1) {
      const connector = document.createElement('div');
      connector.className = 'connector';
      el.graph.appendChild(connector);
    }
  });
}

/**
 * What the Flow tab draws, before any of it is drawn: lanes of columns of
 * cards, each card a graph step or a step told from the action document. The
 * tab badge counts the same list, so the two cannot disagree.
 */
function flowPlan(flow) {
  const doc = flowDoc(flow);
  const sending = requestHooks(flow);
  const helpers = flow.steps.filter((step) => step.kind === 'hook' && !sending.has(step.nodeId));
  const opsOn = new Set(
    flow.steps.filter((step) => step.kind === 'db-op').map((step) => step.meta?.collection),
  );
  const shown = flow.steps.filter(
    (step) =>
      !(step.kind === 'hook' && !sending.has(step.nodeId)) &&
      // The operation card already names its collection.
      !(step.kind === 'collection' && opsOn.has(step.label)),
  );
  const helped =
    shown.find((step) => step.kind === 'handler') ??
    shown.find((step) => step.kind === 'ui-action');

  const lanes = LAYERS.map(([layer, title]) => {
    const steps = shown.filter((step) => step.layer === layer);
    // The document reads the words on the button; the graph only has the prop name.
    const trigger = docStageOf(doc, 'trigger');
    const columns = depthColumns(steps).map((column) =>
      column.map((step) => ({
        step,
        helpers: step === helped ? helpers : [],
        ...(step.kind === 'ui-action' && trigger && step.meta?.event !== 'mount'
          ? { say: richText(trigger.summary) }
          : {}),
      })),
    );
    const confirm = layer === 'ui' ? docStageOf(doc, 'confirm') : undefined;
    if (confirm)
      columns.push([
        { layer: 'ui', kind: 'confirmation dialog', summary: confirm.summary, key: 'confirm' },
      ]);
    return { layer, title, columns };
  });

  // The way back: what the frontend does with the answer, and where the screen ends up.
  const back = [
    ['response-handler', 'handles the answer'],
    ['final-ui', 'what the user sees'],
  ].flatMap(([key, kind]) => {
    const stage = docStageOf(doc, key);
    return stage ? [[{ layer: 'frontend', kind, summary: stage.summary, key }]] : [];
  });
  lanes.push({ layer: 'back', title: 'Back on screen', columns: back });

  return lanes.filter((lane) => lane.columns.length > 0);
}

/** The loaded action document, when it is this flow's. */
function flowDoc(flow) {
  const doc = state.actionDoc;
  return doc && !doc.error && doc.flowId === flow.id ? doc : undefined;
}

function docStageOf(doc, key) {
  const stage = doc?.stages.find((candidate) => candidate.key === key);
  return stage && !stage.absent ? stage : undefined;
}

/**
 * Hooks that send the request: the API call is written inside them
 * (`useDeleteProduct`'s `mutationFn`). Every other hook only hands the
 * component a helper.
 */
function requestHooks(flow) {
  const sites = flow.steps
    .filter((step) => step.kind === 'api-call')
    .flatMap((step) => [
      step.file,
      ...(step.meta?.callSites ?? []).map((site) => String(site).replace(/:\d+$/, '')),
    ]);
  return new Set(
    flow.steps
      .filter((step) => step.kind === 'hook' && step.file && sites.includes(step.file))
      .map((step) => step.nodeId),
  );
}

/**
 * One lane's steps, grouped by depth: steps at the same depth are siblings and
 * are stacked in one column rather than chained, because an arrow between them
 * would claim a call that does not happen.
 */
function depthColumns(steps) {
  const byDepth = new Map();
  for (const step of steps) {
    const list = byDepth.get(step.depth);
    if (list) list.push(step);
    else byDepth.set(step.depth, [step]);
  }
  return [...byDepth.keys()].sort((a, b) => a - b).map((depth) => byDepth.get(depth));
}

/** Columns left to right, joined by arrows, so a lane reads as a chain. */
function renderColumns(columns) {
  const row = document.createElement('div');
  row.className = 'layer-nodes';
  columns.forEach((cards, index) => {
    const column = document.createElement('div');
    column.className = 'layer-column';
    for (const card of cards) column.appendChild(card);
    row.appendChild(column);
    if (index < columns.length - 1) {
      const arrow = document.createElement('div');
      arrow.className = 'arrow-h';
      // Decorative: the numbers already carry the order.
      arrow.setAttribute('aria-hidden', 'true');
      arrow.textContent = '→';
      row.appendChild(arrow);
    }
  });
  return row;
}

/** A step the graph does not hold, told from the action document; opens that stage in Docs. */
function storyCard(layer, number, kind, summary, stageKey) {
  const card = document.createElement('button');
  card.className = `node layer-${layer} story`;
  card.title = 'Open this step in the Docs tab';
  card.innerHTML =
    `<div class="node-head"><span class="step-num">${number}</span>` +
    `<span class="kind">${escapeHtml(kind)}</span></div>` +
    `<div class="say">${richText(summary)}</div>`;
  card.onclick = () => {
    setDocView('list');
    setTimeout(() => {
      const stage = el.panels.docs?.querySelector(`[data-stage="${stageKey}"]`);
      stage?.scrollIntoView?.({ behavior: 'smooth', block: 'start' });
    }, 50);
  };
  return card;
}

/** What a step does, in one sentence. HTML: names are set in `<code>`. */
function stepSentence(step) {
  const name = (text) => `<code>${escapeHtml(text)}</code>`;
  const label = tileLabel(step);
  switch (step.kind) {
    case 'ui-action': {
      if (step.meta?.event === 'mount') return 'The page opens and loads its data';
      const action = step.meta?.action ?? step.label;
      const verb = eventVerb(step.meta?.event) || 'use';
      return `The user ${escapeHtml(verb === 'submit' ? 'submits' : `${verb}s`)} <strong>“${escapeHtml(action)}”</strong>`;
    }
    case 'handler':
      return `${name(String(step.label).split('.').pop())} runs`;
    case 'hook':
      return `${name(step.label)} sends the request${
        step.meta?.invalidates?.length ? ', and refreshes the cached data when it succeeds' : ''
      }`;
    case 'api-call': {
      const method = step.meta?.httpMethod ?? '';
      const path = step.meta?.rawPath ?? step.meta?.path ?? step.label;
      return `The browser sends ${name(`${method} ${path}`.trim())}`;
    }
    case 'route':
      return 'The server route receives it';
    case 'middleware':
      return `${name(step.label)} checks the request first`;
    case 'db-op': {
      const effect = effectOf({ effect: step.meta?.effect, access: step.meta?.access });
      const verb = {
        read: 'Reads',
        create: 'Inserts into',
        update: 'Updates',
        delete: 'Deletes from',
        write: 'Writes to',
      }[effect];
      return `${verb} <strong>${escapeHtml(step.meta?.collection ?? step.label)}</strong>`;
    }
    case 'collection':
      return `Collection <strong>${escapeHtml(step.label)}</strong>`;
    case 'external-effect':
      return `Leaves the app: ${name(label)}`;
    default:
      if (/ handler$/.test(label)) return 'The route handler runs';
      return `${name(label)} runs`;
  }
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
        `${codeList(dto.fields)}${dto.file ? `<br>${fileLink(dto.file)}` : ''}`,
      ),
    );
  }

  if (d.schema) {
    blocks.push(
      detailSection(
        `Schema · ${d.schema.model} → ${d.schema.collection}`,
        `${codeList(d.schema.fields)}${d.schema.file ? `<br>${fileLink(d.schema.file)}` : ''}`,
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

function renderNode(step, number, helpers = [], say = undefined) {
  const button = document.createElement('button');
  const warn = Boolean(step.meta?.mismatch || step.meta?.unresolved);
  button.className = `node layer-${step.layer}${warn ? ' warn' : ''}`;
  button.setAttribute('aria-selected', String(step.nodeId === state.selectedNode?.nodeId));
  button.onclick = () => {
    state.selectedNode = step;
    renderGraph(state.selectedFlow);
    renderDetails(step);
  };

  const sentence = say ?? stepSentence(step);
  const pieces = [
    `<div class="node-head"><span class="step-num">${number}</span>` +
      `<span class="kind">${escapeHtml(tileKind(step))}</span></div>`,
    `<div class="say">${sentence}</div>`,
  ];
  // The code name, unless the sentence already says it. A user action's title
  // is the feature's name, which the header already shows.
  const said = sentence.replace(/<[^>]+>/g, '').replace(/&[a-z]+;/g, '');
  if (step.kind !== 'ui-action' && !said.includes(tileLabel(step))) {
    pieces.push(`<div class="label">${escapeHtml(tileLabel(step))}</div>`);
  }
  // The words actually on the element, when the title has rephrased them.
  const action = step.meta?.action;
  if (step.kind === 'ui-action' && action && step.meta?.event !== 'mount') {
    if (!tileLabel(step).toLowerCase().includes(String(action).toLowerCase())) {
      pieces.push(`<div class="sub">on “${escapeHtml(action)}”</div>`);
    }
  }
  // The card is a button, so the file is a nested link the capture handler opens.
  if (step.file)
    pieces.push(`<div class="sub file">${fileRef(step.file, step.line, '', true)}</div>`);
  // The contract this step carries: query, body, dto, schema, state set.
  for (const line of tileDetailLines(step)) {
    pieces.push(`<div class="sub contract">${escapeHtml(line)}</div>`);
  }
  // Hooks that only hand it a helper run on render, so they are named here, not drawn as steps.
  if (helpers.length) {
    pieces.push(
      `<div class="sub uses">also uses ${helpers.map((hook) => `<code>${escapeHtml(hook.label)}</code>`).join(', ')}</div>`,
    );
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
    const own =
      step.avgSelfMs != null && step.avgSelfMs !== step.avgMs
        ? ` (${step.avgSelfMs}ms in this step itself)`
        : '';
    const runs = (step.observations ?? 0) > 1 ? ` · average of ${step.observations} runs` : '';
    pieces.push(`<div class="timing">took ${step.avgMs}ms${own}${runs}</div>`);
  }
  // Only worth a badge when it says something: "static" is the default for every step.
  if (step.evidence !== 'static') {
    const seen = { confirmed: 'seen running', runtime: 'seen running, not found in code' };
    pieces.push(
      `<span class="badge ${step.evidence}">${escapeHtml(seen[step.evidence] ?? step.evidence)}</span>`,
    );
  }

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
  // The inspector only takes space while it is showing a step.
  document.querySelector('.layout')?.toggleAttribute('data-inspecting', Boolean(step));
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
    <button class="button ghost small details-close" id="details-close" aria-label="Close">✕ Close</button>
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
      ${step.file ? `<dt>source</dt><dd>${fileLink(step.file, step.line)}</dd>` : ''}
      ${step.avgMs != null ? `<dt>avg</dt><dd>${step.avgMs}ms</dd>` : ''}
    </dl>
    ${renderStepDetail(step)}
    <h4>Impact</h4>
    <p class="muted">loading…</p>`;

  el.details.querySelector('#details-close')?.addEventListener('click', () => {
    state.selectedNode = null;
    renderDetails(null);
    if (state.selectedFlow) renderGraph(state.selectedFlow);
  });

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

el.filter.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && el.filter.value) {
    event.preventDefault();
    clearFilter();
  } else if (event.key === 'ArrowDown' || event.key === 'Enter') {
    const first = el.flowList.querySelector('.flow-item');
    if (!first) return;
    event.preventDefault();
    if (event.key === 'Enter') first.click();
    else first.focus();
  }
});

el.foldAll.addEventListener('click', () => {
  const groups = pageGroups(filteredFlows());
  const open = groups.some((group) => !state.closedPages.has(group.key));
  state.closedPages = open ? new Set(groups.map((group) => group.key)) : new Set();
  renderFlowList();
});

// Up and down walk the visible rows, the way a list in any app does.
el.flowList.addEventListener('keydown', (event) => {
  if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
  const rows = [...el.flowList.querySelectorAll('.page-group[open] .flow-item')];
  const at = rows.indexOf(document.activeElement);
  if (at === -1) return;
  event.preventDefault();
  const next = event.key === 'ArrowDown' ? at + 1 : at - 1;
  if (next < 0) el.filter.focus();
  else rows[Math.min(next, rows.length - 1)]?.focus();
});

// `/` jumps to the search from anywhere that is not already a text field.
document.addEventListener('keydown', (event) => {
  if (event.key !== '/' || event.ctrlKey || event.metaKey || event.altKey) return;
  const target = event.target;
  if (target instanceof HTMLElement && target.closest('input, textarea, select, [contenteditable]'))
    return;
  event.preventDefault();
  el.filter.focus();
  el.filter.select();
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
    // A rescan merges newly recorded runs; what was read before is stale.
    state.queriesFor = null;
    state.actionDocFor = null;
    state.findings = null;
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

/**
 * The answer, before the evidence.
 *
 * Every tab opens with one coloured box that says its conclusion in plain words
 * — "safe to change", "nothing tests this" — so a reader who stops there still
 * leaves with the right idea. The tables underneath are the proof.
 */
function answer(tone, title, text) {
  return `<div class="answer tone-${escapeHtml(tone)}">
      <div class="answer-title">${escapeHtml(title)}</div>
      ${text ? `<div class="answer-text">${richText(text)}</div>` : ''}
    </div>`;
}

/** A button cell that jumps to another action. */
function flowLinkCell(id, title) {
  return {
    html: `<button class="link" data-goto-flow="${escapeHtml(id)}">${escapeHtml(title)}</button>`,
  };
}

/** A section heading inside a tab. */
function heading(text, note) {
  return `<h3 class="tab-heading">${escapeHtml(text)}</h3>${
    note ? `<p class="tab-note">${richText(note)}</p>` : ''
  }`;
}

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
/**
 * Time per step, from real runs, for the Performance tab. Database queries are
 * left out of the table — they are listed under it with their code — so the
 * table is the rest of the path: handler, request, route, service.
 */
function timingHtml(timing) {
  const steps = timing.steps.filter((step) => step.kind !== 'db-op' && step.kind !== 'collection');
  const rows = steps
    .map((step) => {
      const share = step.sharePct ?? 0;
      const self = step.avgSelfMs ?? 0;
      return `<tr>
          <td class="t-step">
            <span class="layer-dot layer-${step.layer}"></span>
            ${escapeHtml(step.label)}
            <span class="t-kind">${escapeHtml(tileKind(step))}</span>
            ${step.file ? fileRef(step.file, step.line) : ''}
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
  const unobserved = timing.unobserved.filter(
    (step) => step.kind !== 'db-op' && step.kind !== 'collection',
  );
  return (
    heading(
      'Time per step',
      '"Own time" is the step itself; "total" includes everything it called. Queries are listed below.',
    ) +
    (rows
      ? `<table class="timing-table">
       <thead><tr>
         <th>Step</th><th>Own time</th><th>Share</th><th>Total</th><th>Runs</th>
       </tr></thead>
       <tbody>${rows}</tbody>
     </table>`
      : '<p class="muted">No step outside the database was timed.</p>') +
    notesList(timing.notes) +
    (unobserved.length
      ? `<details class="more"><summary>${unobserved.length} steps with no measurement</summary>
           <ul class="plain">${unobserved
             .map((step) => `<li>${escapeHtml(step.label)}</li>`)
             .join('')}</ul></details>`
      : '')
  );
}

/** Other actions that have been measured, for when this one has not. */
function measuredElsewhereHtml() {
  const measured = state.flows
    .filter((flow) => flow.totalMs != null && flow.id !== state.selectedFlow?.id)
    .sort((a, b) => b.totalMs - a.totalMs);
  if (!measured.length) return '';
  return `<details class="more"><summary>${measured.length} other action${measured.length === 1 ? ' has' : 's have'} been measured</summary>${renderDocTable(
    {
      columns: ['Action', 'Whole action', 'Requests'],
      rows: measured.map((flow) => ({
        cells: [
          flowLinkCell(flow.id, flowTitle(flow)),
          `**${formatMs(flow.totalMs)}**`,
          flow.endpoints.map((endpoint) => `\`${endpoint}\``).join(', '),
        ],
      })),
    },
  )}</details>`;
}

/**
 * The Docs tab — the selected action, from the page opening to the state the
 * screen is left in.
 *
 * Up to nineteen stages, always in the same order, so two actions can be read
 * side by side. Only the steps the action actually has are drawn, numbered
 * 1…N; the rest are named under "Not in this action" with the reason, so a
 * missing guard or validation is still stated rather than silently dropped.
 * The document is built by `explainAction` in core from the
 * graph plus the few source files the action touches; the Markdown behind
 * "Copy" comes from the same document, so the two cannot disagree.
 */
function renderDocs() {
  const panel = el.panels.docs;
  if (!panel) return;
  const flow = state.selectedFlow;

  if (!flow) {
    panel.innerHTML = `<div class="empty-state"><h3>Nothing to describe yet</h3>
       <p>Select an action on the left.</p></div>`;
    return;
  }
  const bar = docBar(flow);
  const doc = state.actionDoc;

  if (state.actionDocLoading || !doc || (doc.flowId && doc.flowId !== flow.id)) {
    panel.innerHTML = bar + '<p class="muted">Reading the code behind this action…</p>';
    bindDocBar(panel);
    return;
  }
  if (doc.error) {
    panel.innerHTML = bar + `<p class="error">${escapeHtml(String(doc.error))}</p>`;
    bindDocBar(panel);
    return;
  }

  // Numbered as drawn, so the reader never sees a gap.
  const shown = doc.stages
    .filter((stage) => !stage.absent)
    .map((stage, index) => ({ ...stage, n: index + 1 }));
  const absent = doc.stages.filter((stage) => stage.absent);
  const phases = [];
  for (const stage of shown) {
    const last = phases.at(-1);
    if (last && last.phase === stage.phase) last.stages.push(stage);
    else phases.push({ phase: stage.phase, stages: [stage] });
  }

  panel.innerHTML =
    bar +
    `<article class="adoc">
       <header class="adoc-intro">
         <p class="adoc-lede">The user ${richText(doc.trigger.replace(/"([^"]+)"/g, '**"$1"**'))}${
           doc.screen ? ` on <strong>${escapeHtml(doc.screen)}</strong>` : ''
         }.</p>
         <div class="adoc-meta">
           ${doc.endpoints.map((endpoint) => `<code>${escapeHtml(endpoint)}</code>`).join(' ')}
           <span class="chip small ${doc.evidence === 'static' ? '' : 'ok'}">${escapeHtml(
             doc.evidence === 'static'
               ? 'read from the source'
               : doc.evidence === 'confirmed'
                 ? 'confirmed at runtime'
                 : 'seen at runtime',
           )}</span>
           ${doc.source ? fileRef(doc.source.file, doc.source.line) : ''}
         </div>
       </header>
       ${renderGlance(phases)}
       ${renderAbsent(absent)}
       ${
         doc.limits.length === 0
           ? ''
           : `<details class="more doc-limits"><summary>What this document cannot see</summary>
                <ul class="plain">${doc.limits.map((line) => `<li>${richText(line)}</li>`).join('')}</ul></details>`
       }
     </article>`;

  bindDocBar(panel);
  for (const head of panel.querySelectorAll('.adoc-head')) {
    head.addEventListener('click', () => {
      const stage = head.closest('.adoc-stage');
      const open = !stage.classList.toggle('is-collapsed');
      head.setAttribute('aria-expanded', String(open));
    });
  }
  bindTableFolds(panel);
  bindCopy(panel);
  bindFlowJumps(panel);
}

/** The "Show all N rows" buttons under long tables. */
function bindTableFolds(panel) {
  for (const button of panel.querySelectorAll('.adoc-more')) {
    button.addEventListener('click', () => {
      const wrap = button.closest('.adoc-table-wrap');
      const folded = wrap.classList.toggle('is-folded');
      button.textContent = folded ? `Show all ${button.dataset.rows} rows` : 'Show fewer';
    });
  }
}

const PHASE_TITLES = {
  browser: 'In the browser — before anything is sent',
  wire: 'Over the network',
  server: 'On the server',
  database: 'In the database',
  back: 'The way back — response to screen',
};

/**
 * The whole action on one screen: one line per stage, grouped by where it
 * happens. Every line is an accordion that starts closed, so the round trip
 * reads at a glance and a stage's detail is one click away rather than a long
 * scroll below.
 */
function renderGlance(phases) {
  return `<section class="adoc-glance" aria-label="At a glance">
      <h3>At a glance</h3>
      ${phases
        .map(
          ({ phase, stages }) => `<div class="glance-phase phase-${escapeHtml(phase)}">
            <div class="glance-phase-title">${escapeHtml(PHASE_TITLES[phase] ?? phase)}</div>
            <ol class="glance-steps">${stages.map(renderStage).join('')}</ol>
          </div>`,
        )
        .join('<div class="glance-arrow" aria-hidden="true">↓</div>')}
    </section>`;
}

/** The template's steps this action does not have, and why each is missing. */
function renderAbsent(stages) {
  if (stages.length === 0) return '';
  return `<section class="adoc-absent" aria-label="Not in this action">
      <h4>Not in this action</h4>
      <ul class="plain">${stages
        .map(
          (stage) =>
            `<li><span class="adoc-absent-title">${escapeHtml(stage.title)}</span> ${richText(stage.summary || '')}</li>`,
        )
        .join('')}</ul>
    </section>`;
}

function renderStage(stage) {
  return `<li id="adoc-stage-${stage.n}" class="adoc-stage is-collapsed${stage.groups.length === 0 ? ' is-empty' : ''}" data-stage="${escapeHtml(stage.key)}">
      <button class="adoc-head" aria-expanded="false">
        <span class="glance-num">${stage.n}</span>
        <span class="glance-title">${escapeHtml(stage.title)}</span>
        <span class="glance-summary">${richText(stage.summary || '—')}</span>
      </button>
      <div class="adoc-body">
        ${
          stage.groups.length === 0
            ? `<p class="adoc-empty">${richText(stage.empty ?? 'Nothing found for this stage.')}</p>`
            : stage.groups.map(renderDocGroup).join('')
        }
        ${stageExtras(stage.key)}
      </div>
    </li>`;
}

/**
 * What the request and response stages add from the request analysis (what
 * used to be the APIs tab): the checks on the call itself, a command to try
 * it, who else calls the endpoint, and what it answered when it ran. Only
 * facts the document does not already state.
 */
function stageExtras(key) {
  const calls = state.insight && !state.insight.error ? (state.insight.apis?.calls ?? []) : [];
  if (!calls.length) return '';
  const many = calls.length > 1;
  const label = (text, call) => (many ? `${text} · ${call.endpoint}` : text);

  if (key === 'request') {
    const groups = [];
    if (many) groups.push({ label: 'Order of the requests', html: requestSequence(calls) });
    for (const call of calls) {
      const checks = [
        ...(call.matched
          ? []
          : [
              {
                text: 'No route in this project answers this call — it is served elsewhere, or the path or method disagree.',
                tone: 'error',
              },
            ]),
        // Whether it was seen running is the evidence chip's job, and the chip is
        // per action — a per-call "never observed" contradicts it when only the
        // server side of the call was traced.
        ...call.warnings
          .filter((warning) => !/never observed/i.test(warning))
          .map((warning) => ({ text: warning, tone: 'warn' })),
        ...(call.contract?.unexpected ?? []).map((field) => ({
          text: `\`${field.name}\` is sent but the route does not declare it — validation usually drops it silently`,
          tone: 'warn',
        })),
        ...(call.contract?.missing ?? []).map((field) => ({
          text: `\`${field.name}\` is declared by the route but never sent`,
          tone: 'warn',
        })),
      ];
      if (checks.length) groups.push({ label: label('Checks on this call', call), lines: checks });
      const curl = curlFor(call);
      groups.push({
        label: label('Try it', call),
        html: `<div class="command"><code>${escapeHtml(curl)}</code>
            <button class="button ghost small" data-copy="${escapeHtml(curl)}">Copy</button></div>`,
      });
      const others = [
        ...call.alsoUsedBy.map((feature) => ({
          html: `<button class="link" data-goto-flow="${escapeHtml(feature.id)}">${escapeHtml(feature.title)}</button>${
            feature.subtitle ? ` <span class="muted">${escapeHtml(feature.subtitle)}</span>` : ''
          }`,
        })),
        ...call.otherCallSites.map((site) => {
          const [file, line] = splitSite(site);
          return { html: `also called from ${fileRef(file, line)}` };
        }),
      ];
      groups.push({
        label: label('Who else calls this endpoint', call),
        ...(others.length
          ? {
              html: `<ul class="adoc-lines">${others.map((entry) => `<li>${entry.html}</li>`).join('')}</ul>`,
            }
          : { lines: [{ text: 'Only this action calls it.', tone: 'muted' }] }),
      });
    }
    return groups.map(renderExtraGroup).join('');
  }

  if (key === 'response') {
    return calls
      .map((call) => {
        const codes = call.response.statusCodes;
        return renderExtraGroup({
          label: label('Seen running', call),
          html: codes.length
            ? `<p>Answered ${codes
                .map(
                  (code) =>
                    `<span class="chip small ${code >= 500 ? 'danger' : code >= 400 ? 'warn' : 'ok'}">${code}</span>`,
                )
                .join(
                  ' ',
                )}${call.observations ? ` over ${call.observations} run${call.observations === 1 ? '' : 's'}` : ''}${
                call.response.landsInState.length
                  ? ` · the answer lands in ${call.response.landsInState.map((name) => `<code>${escapeHtml(name)}</code>`).join(' ')}`
                  : ''
              }</p>`
            : '<p class="muted">Never seen running — the statuses above are read from the code.</p>',
        });
      })
      .join('');
  }
  return '';
}

function renderExtraGroup(group) {
  if (group.html) {
    return `<section class="adoc-group"><h4>${escapeHtml(group.label)}</h4>${group.html}</section>`;
  }
  return renderDocGroup({ label: group.label, lines: group.lines ?? [] });
}

/**
 * The requests in one line. The join says how they relate: `or` between two
 * arms of one conditional, `+` for concurrent, `→` for a real sequence — an
 * arrow between alternatives would claim both happen.
 */
function requestSequence(calls) {
  return `<div class="sequence">${calls
    .map((call, index) => {
      const previous = calls[index - 1];
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
    .join('')}</div>`;
}

function renderDocGroup(group) {
  const lines = group.lines.length
    ? `<ul class="adoc-lines">${group.lines.map(renderDocLine).join('')}</ul>`
    : '';
  const table = group.table?.rows.length ? renderDocTable(group.table) : '';
  const tone = group.tone ? ` tone-${escapeHtml(group.tone)}` : '';
  if (group.collapsed) {
    return `<details class="adoc-group is-folded${tone}">
        <summary>${escapeHtml(group.label)}</summary>${lines}${table}
      </details>`;
  }
  return `<section class="adoc-group${tone}">
      <h4>${escapeHtml(group.label)}</h4>${lines}${table}
    </section>`;
}

/** Long tables show this many rows until the reader asks for the rest. */
const TABLE_FOLD = 8;

function renderDocTable(table) {
  const refs = table.rows.some((row) => row.at?.file);
  const head = table.columns.some(Boolean)
    ? `<thead><tr>${table.columns.map((column) => `<th>${escapeHtml(column)}</th>`).join('')}${
        refs ? '<th></th>' : ''
      }</tr></thead>`
    : '';
  const fold = table.rows.length > TABLE_FOLD + 2;
  const rows = table.rows
    .map(
      (row, index) =>
        `<tr class="${row.tone ? `tone-${escapeHtml(row.tone)}` : ''}${fold && index >= TABLE_FOLD ? ' is-extra' : ''}">${row.cells
          .map(
            (cell) => `<td>${typeof cell === 'object' && cell ? cell.html : richText(cell)}</td>`,
          )
          .join(
            '',
          )}${refs ? `<td class="adoc-ref">${row.at?.file ? fileRef(row.at.file, row.at.line) : ''}</td>` : ''}</tr>`,
    )
    .join('');
  return `<div class="adoc-table-wrap${fold ? ' is-folded' : ''}"><table class="adoc-table${
    table.columns.some(Boolean) ? '' : ' is-keyvalue'
  }">${head}<tbody>${rows}</tbody></table>${
    fold
      ? `<button class="link adoc-more" data-rows="${table.rows.length}">Show all ${table.rows.length} rows</button>`
      : ''
  }</div>`;
}

function renderDocLine(line) {
  const sub = line.sub?.length
    ? `<ul class="adoc-lines adoc-sub">${line.sub.map(renderDocLine).join('')}</ul>`
    : '';
  return `<li class="${line.tone ? `tone-${escapeHtml(line.tone)}` : ''}">
      <span class="adoc-text">${richText(line.text)}</span>${line.at?.file ? ` ${fileRef(line.at.file, line.at.line)}` : ''}${sub}
    </li>`;
}

/**
 * Inline code, **bold** and _italic_, escaped first.
 *
 * Emphasis is applied only outside `<code>`, so `original._retry` stays code
 * rather than turning half of it italic.
 */
function richText(text) {
  return inlineCode(text)
    .split(/(<code>[\s\S]*?<\/code>)/)
    .map((part) =>
      part.startsWith('<code>')
        ? linkFileCode(part)
        : part
            .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
            .replace(/(^|[\s(])_([^_]+)_(?=$|[\s).,;:])/g, '$1<em>$2</em>'),
    )
    .join('');
}

/**
 * `<code>app/api/products/[id]/route.ts</code>` — or `…/route.ts:12`, or a
 * path at the end of `DELETE /x → app/api/…/route.ts` — opens in the editor
 * when it names a file the scan read. Nested, because rich text also lands
 * inside at-a-glance rows, which are links themselves.
 */
function linkFileCode(part) {
  const inner = part
    .slice('<code>'.length, -'</code>'.length)
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&');
  const match = /^(.*?)([\w@.()[\]/-]+\.(?:[cm]?[jt]sx?|vue|svelte|prisma))(?::(\d+))?$/.exec(
    inner,
  );
  if (!match || !isKnownFile(match[2])) return part;
  const [, before, file, line] = match;
  const link = `<code class="code-link">${editorLink(
    escapeHtml(line ? `${file}:${line}` : file),
    file,
    line ? Number(line) : 1,
    { nested: true },
  )}</code>`;
  return before.trim() ? `<code>${escapeHtml(before.trimEnd())}</code> ${link}` : link;
}

/** The action's name, plus the ways to take the document elsewhere. */
function docBar(flow) {
  const markdown = apiUrl(`/api/action?flow=${encodeURIComponent(flow.id)}&format=markdown`);
  return `<div class="doc-bar">
      <div class="doc-picker">${viewSwitch()}<span>How this action works, end to end</span></div>
      <div class="doc-bar-actions">
        <button class="button ghost" id="doc-toggle">Expand all</button>
        <button class="button ghost" id="doc-copy">Copy as Markdown</button>
        <a class="button ghost" href="${markdown}" target="_blank" rel="noreferrer">Open Markdown</a>
      </div>
    </div>`;
}

function bindDocBar(panel) {
  panel.querySelector('#doc-toggle')?.addEventListener('click', (event) => {
    const button = event.currentTarget;
    const collapse = button.textContent === 'Collapse all';
    for (const stage of panel.querySelectorAll('.adoc-stage')) {
      stage.classList.toggle('is-collapsed', collapse);
      stage.querySelector('.adoc-head')?.setAttribute('aria-expanded', String(!collapse));
    }
    button.textContent = collapse ? 'Expand all' : 'Collapse all';
  });

  panel.querySelector('#doc-copy')?.addEventListener('click', async (event) => {
    const button = event.currentTarget;
    const id = state.selectedFlow?.id;
    if (!id) return;
    // Fetched rather than rebuilt here: one renderer in core, so the pasted
    // document cannot drift from the one on screen.
    try {
      const response = await fetch(
        apiUrl(`/api/action?flow=${encodeURIComponent(id)}&format=markdown`),
      );
      await navigator.clipboard.writeText(await response.text());
      button.textContent = 'Copied';
      setTimeout(() => {
        button.textContent = 'Copy as Markdown';
      }, 1200);
    } catch {
      button.textContent = 'Could not copy';
      setTimeout(() => {
        button.textContent = 'Copy as Markdown';
      }, 1600);
    }
  });
}

/**
 * `\`GET /products\`` -> `<code>GET /products</code>`.
 *
 * The prose carries endpoints and collection names in backticks, which is how
 * they read in the markdown version. Escaping first and marking up second is
 * what keeps a collection called `<script>` from being one.
 */
function inlineCode(text) {
  return escapeHtml(String(text)).replace(/`([^`]+)`/g, '<code>$1</code>');
}

/** Jumps from the Performance tab stay on the Performance tab. */
function bindTimingJumps(panel) {
  for (const button of panel.querySelectorAll('[data-goto-flow]')) {
    button.addEventListener('click', () => {
      state.tab = 'perf';
      selectFlow(button.dataset.gotoFlow);
    });
  }
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
  const flow = state.selectedFlow;
  const intro = panelIntro(
    'Which tests would fail if you broke this action — measured by which test files ' +
      'import the files the action runs through.',
  );

  // The files no test reaches — the chain itself is in Docs, so only the gap is listed.
  const byFile = new Map();
  for (const step of flow?.steps ?? []) {
    if (!step.file) continue;
    const entry = byFile.get(step.file) ?? { layer: step.layer, steps: [] };
    entry.steps.push(step.label);
    byFile.set(step.file, entry);
  }
  const uncovered = new Set((tests.uncoveredFiles ?? []).map((entry) => entry.file));
  const covered = new Set(tests.files.flatMap((file) => file.coversFromFlow ?? []));
  const untested = [...byFile.entries()].filter(
    ([file]) =>
      !(
        tests.files.length > 0 &&
        !uncovered.has(file) &&
        (covered.size === 0 || covered.has(file))
      ),
  );
  const fileTable = untested.length
    ? heading(
        'Files no test reaches',
        'A test that imports one of these would cover the part of the action in it.',
      ) +
      renderDocTable({
        columns: ['File', 'Steps in it'],
        rows: untested.map(([file, entry]) => ({
          cells: [`\`${file}\``, [...new Set(entry.steps)].map((step) => `\`${step}\``).join(', ')],
          tone: 'error',
        })),
      })
    : '';

  if (tests.files.length === 0) {
    panel.innerHTML =
      intro +
      answer(
        'danger',
        'No test covers this action',
        `No test file imports any of the ${byFile.size} files it runs through, so breaking it would not fail the suite. Read the **Breaks** tab before editing.`,
      ) +
      renderTestPlan(state.insight.testPlan, { folded: false }) +
      fileTable +
      notesList(tests.notes);
    bindCopy(panel);
    bindTableFolds(panel);
    return;
  }

  const tone = tests.coveragePct >= 80 ? 'ok' : tests.coveragePct >= 40 ? 'warn' : 'danger';
  const cases = tests.files
    .map(
      (file) =>
        `<h3 class="tab-heading">${fileLink(file.file)} — ${file.cases.length} case${file.cases.length === 1 ? '' : 's'}${file.integration ? ' · integration' : ''}</h3>` +
        renderDocTable({
          columns: ['Test', 'Suite'],
          // Each case opens at its own `it(...)`.
          rows: file.cases.map((testCase) => ({
            cells: [testCase.title, testCase.suite ?? ''],
            at: { file: file.file, line: testCase.line },
          })),
        }),
    )
    .join('');

  panel.innerHTML =
    intro +
    answer(
      tone,
      `${tests.coveragePct}% of this action’s files are tested`,
      `${tests.totalCases} test case${tests.totalCases === 1 ? '' : 's'} would run against it.` +
        (uncovered.size
          ? ` **${uncovered.size} file${uncovered.size === 1 ? ' has' : 's have'} no test** — see below.`
          : ''),
    ) +
    fileTable +
    cases +
    runCommand(tests) +
    renderTestPlan(state.insight.testPlan, { folded: true }) +
    notesList(tests.notes);

  bindCopy(panel);
  bindTableFolds(panel);
}

const TEST_KIND_LABEL = {
  access: 'Who may call it',
  rejects: 'What it turns away',
  data: 'What it changes',
  answers: 'What it answers',
  screen: 'What the user sees',
};

/**
 * The tests worth writing for this action, read off its document: every
 * response the route can send, every write, every failure the user sees. Open
 * when nothing tests the action — it is then the useful half of the tab —
 * folded when tests exist, as a checklist to hold them against.
 */
function renderTestPlan(plan, { folded }) {
  if (!plan?.cases?.length) return '';
  const where = [
    plan.file ? `request tests in \`${plan.file}\`` : '',
    plan.screenFile ? `screen tests in \`${plan.screenFile}\`` : '',
  ].filter(Boolean);
  const body =
    renderDocTable({
      columns: ['Test to write', 'Covers'],
      rows: plan.cases.map((entry) => ({
        cells: [{ html: escapeHtml(entry.title) }, TEST_KIND_LABEL[entry.kind] ?? entry.kind],
        ...(entry.at ? { at: entry.at } : {}),
        tone: entry.kind === 'access' || entry.kind === 'data' ? 'warn' : undefined,
      })),
    }) +
    `<div class="command skeleton">
      <pre><code>${escapeHtml(plan.skeleton)}</code></pre>
      <button class="button ghost small" data-copy="${escapeHtml(plan.skeleton)}">Copy</button>
    </div>`;
  const note = where.length
    ? `Most important first. Put the ${where.join(' and the ')}.`
    : 'Most important first.';
  if (folded) {
    return `<details class="more test-plan"><summary>What a complete suite would check — ${plan.cases.length} case${plan.cases.length === 1 ? '' : 's'}</summary>
        <p class="tab-note">${richText(note)}</p>${body}</details>`;
  }
  return heading(`Tests to write first — ${plan.cases.length}`, note) + body;
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
      // Stay on the tab the link was clicked in.
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
 * The absolute path of a scanned file, for the editor.
 *
 * Paths in the graph are relative so a scan stays portable between machines.
 * A multi-root scan prefixes each file with its repo's name
 * (`shop-api/src/…`), and `meta.projects` maps that name back to the
 * repo; everything else is relative to the root.
 */
function absolutePath(file) {
  const meta = state.graph?.meta;
  if (!file || !meta?.root) return undefined;
  if (/^(\/|[A-Za-z]:[\\/])/.test(file)) return file;
  const isAbsolute = (path) => typeof path === 'string' && /^(\/|[A-Za-z]:[\\/])/.test(path);
  for (const [label, path] of Object.entries(meta.projects ?? {})) {
    if (isAbsolute(path) && file.startsWith(`${label}/`))
      return `${path.replace(/[/\\]$/, '')}/${file.slice(label.length + 1)}`;
  }
  return `${meta.root.replace(/[/\\]$/, '')}/${file}`;
}

/** The link that opens `file` at `line` in the editor, or undefined. */
function editorHref(file, line) {
  const absolute = absolutePath(file);
  const scheme = EDITOR_SCHEMES[EDITOR];
  return absolute && scheme ? scheme(absolute, line ?? 1) : undefined;
}

/**
 * A `file:line` that opens in the editor.
 *
 * A real link where one is allowed; a span carrying `data-editor-href` where
 * it sits inside something already clickable (a diagram card is a button, an
 * at-a-glance row is a link), which the capture handler below opens without
 * setting off the thing around it.
 */
function editorLink(label, file, line, { extraClass = '', title, nested = false } = {}) {
  const href = editorHref(file, line);
  const full = line ? `${file}:${line}` : file;
  const tip = escapeHtml(`${title ?? full} — open in your editor`);
  if (!href)
    return `<code class="file-ref ${extraClass}" title="${escapeHtml(full)}">${label}</code>`;
  return nested
    ? `<span class="file-link ${extraClass}" role="link" tabindex="0" data-editor-href="${escapeHtml(href)}" title="${tip}">${label}</span>`
    : `<a class="file-link ${extraClass}" href="${escapeHtml(href)}" data-editor-href="${escapeHtml(href)}" title="${tip}">${label}</a>`;
}

/** The full `path:line`, clickable. */
function fileLink(file, line, extraClass = '') {
  if (!file) return '';
  return editorLink(escapeHtml(line ? `${file}:${line}` : file), file, line, { extraClass });
}

document.addEventListener(
  'click',
  (event) => {
    const target = event.target.closest?.('[data-editor-href]');
    if (!target) return;
    // Capture phase, so the card or row around the link never sees the click.
    event.preventDefault();
    event.stopPropagation();
    window.location.href = target.dataset.editorHref;
  },
  true,
);

document.addEventListener('keydown', (event) => {
  if (event.key !== 'Enter') return;
  const target = event.target.closest?.('span[data-editor-href]');
  if (!target) return;
  event.preventDefault();
  window.location.href = target.dataset.editorHref;
});

/** Every file the scan read, so a path written in text can be made a link. */
let knownFiles = { graph: null, files: new Set() };
function isKnownFile(path) {
  if (knownFiles.graph !== state.graph) {
    const files = new Set();
    for (const node of state.graph?.nodes ?? []) {
      const file = node.source?.file ?? node.file;
      if (file) files.add(file);
    }
    knownFiles = { graph: state.graph, files };
  }
  return knownFiles.files.has(path);
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
function fileRef(file, line, extraClass = '', nested = false) {
  if (!file) return '';
  const base = file.split('/').pop();
  return editorLink(escapeHtml(line ? `${base}:${line}` : base), file, line, {
    extraClass,
    nested,
  });
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
/** A query at or above this average is called slow on the tab and its badge. */
const SLOW_QUERY_MS = 200;

const QUERY_EFFECT = {
  read: 'read',
  create: 'insert',
  update: 'update',
  delete: 'delete',
  write: 'write',
};

const PART_ROLE = {
  filter: 'Filter — which documents',
  update: 'Update — what changes',
  document: 'Document inserted',
  documents: 'Documents inserted',
  options: 'Options',
  pipeline: 'Pipeline',
  operations: 'Operations',
  field: 'Field',
  query: 'Query',
  argument: 'Argument',
};

function formatMs(ms) {
  return ms >= 1000 ? `${(ms / 1000).toFixed(ms >= 10000 ? 0 : 1)}s` : `${Math.round(ms)}ms`;
}

/** The queries are fetched when the tab opens: they read source files, like the Docs tab. */
function openPerfForSelection() {
  const id = state.selectedFlow?.id ?? null;
  if (id && id !== state.queriesFor) {
    void loadQueries(id);
    return;
  }
  renderPerf();
}

async function loadQueries(flowId) {
  state.queriesFor = flowId;
  state.queries = null;
  state.queriesLoading = true;
  renderTabs();
  renderPerf();
  try {
    const data = await getJson(`/api/queries?flow=${encodeURIComponent(flowId)}`);
    if (state.queriesFor !== flowId) return;
    state.queries = data;
  } catch (error) {
    if (state.queriesFor !== flowId) return;
    state.queries = { error: String(error.message ?? error) };
  } finally {
    if (state.queriesFor === flowId) state.queriesLoading = false;
    renderTabs();
    if (state.tab === 'perf') renderPerf();
  }
}

// ---------------------------------------------------------------------------
// Decisions — every way the action can go
// ---------------------------------------------------------------------------

/**
 * Fetched when the tab is opened, like the document: it reads source files on
 * the server, and clicking through the list should not pay for trees nobody
 * looks at.
 */
function openDecisionsForSelection() {
  const id = state.selectedFlow?.id ?? null;
  if (id && id !== state.decisionsFor) {
    void loadDecisions(id);
    return;
  }
  renderDecisions();
}

async function loadDecisions(flowId) {
  state.decisionsFor = flowId;
  state.decisions = null;
  state.decisionsLoading = true;
  // Folds belong to one action's chart; a new action starts from the defaults.
  fc.folds = new Map();
  fc.fitNext = true;
  renderTabs();
  renderDecisions();
  try {
    const tree = await getJson(`/api/decisions?flow=${encodeURIComponent(flowId)}`);
    if (state.decisionsFor !== flowId) return;
    state.decisions = tree;
  } catch (error) {
    if (state.decisionsFor !== flowId) return;
    state.decisions = { error: String(error.message ?? error) };
  } finally {
    if (state.decisionsFor === flowId) state.decisionsLoading = false;
    renderTabs();
    if (state.tab === 'decisions') renderDecisions();
  }
}

/**
 * The chart's view settings, kept across re-renders of the same action.
 *
 * `folds` is keyed by each box's position in the tree, so opening a helper and
 * then toggling the code lines does not snap it shut again.
 */
const fc = {
  zoom: 1,
  showCalls: false,
  showCode: false,
  folds: new Map(),
  /** Fit a chart wider than the screen the first time it is drawn. */
  fitNext: true,
};

/** The view toggles outlive a reload: a reader who wants the code wants it every time. */
const FC_SETTINGS = 'flowlens.decisions.view';
try {
  const saved = JSON.parse(localStorage.getItem(FC_SETTINGS) ?? '{}');
  fc.showCalls = saved.showCalls === true;
  fc.showCode = saved.showCode === true;
} catch {
  // A private window or a corrupt value: the defaults are fine.
}
function saveFcSettings() {
  try {
    const { showCalls, showCode } = fc;
    localStorage.setItem(FC_SETTINGS, JSON.stringify({ showCalls, showCode }));
  } catch {
    // Not persisted; the toggle still works for this visit.
  }
}

/** Spacing, in pixels at 100%. */
const FC = {
  gapY: 30,
  gapX: 44,
  framePad: 16,
  headGap: 12,
  branchDrop: 30,
  merge: 18,
};

function renderDecisions() {
  const panel = el.panels.decisions;
  if (!panel) return;
  const flow = state.selectedFlow;
  if (!flow) {
    panel.innerHTML = `<div class="empty-state"><h3>Nothing selected</h3><p>Select an action on the left.</p></div>`;
    return;
  }
  const tree = state.decisions;
  if (state.decisionsLoading || !tree || (tree.flowId && tree.flowId !== flow.id))
    return panelLoading(panel, 'every way this action can go');
  if (tree.error) return panelError(panel, tree);

  const { decisions, outcomes, queries, requests } = tree.counts;
  const summary =
    decisions === 0
      ? answer(
          'neutral',
          'This action runs straight through',
          'No `if`, `switch` or early return decides anything along the way.',
        )
      : answer(
          'neutral',
          `${decisions} ${decisions === 1 ? 'place decides' : 'places decide'} which way this action goes`,
          `It can end ${outcomes} ${outcomes === 1 ? 'way' : 'ways'}` +
            (requests ? `, sends ${requests} ${requests === 1 ? 'request' : 'requests'}` : '') +
            (queries ? ` and runs ${queries} ${queries === 1 ? 'query' : 'queries'}` : '') +
            '. Read it top to bottom: at each ◆ the arrows say which answer leads where.',
        );

  const check = (key, label, on) =>
    `<label class="fc-check"><input type="checkbox" data-fc-option="${key}"${on ? ' checked' : ''}> ${label}</label>`;
  const toolbar =
    `<div class="fc-toolbar">` +
    `<div class="fc-group-buttons" role="group" aria-label="Zoom">` +
    `<button class="button" data-fc="out" title="Zoom out">−</button>` +
    `<button class="button fc-zoom" data-fc="reset" title="Actual size">${Math.round(fc.zoom * 100)}%</button>` +
    `<button class="button" data-fc="in" title="Zoom in">+</button>` +
    `<button class="button" data-fc="fit" title="Fit the width of the panel">Fit</button>` +
    `</div>` +
    `<div class="fc-group-buttons">` +
    check('showCode', 'Show code', fc.showCode) +
    check('showCalls', 'Show helper calls', fc.showCalls) +
    `</div>` +
    `<div class="fc-group-buttons">` +
    `<button class="button" data-fc="open">Expand all</button>` +
    `<button class="button" data-fc="close">Collapse helpers</button>` +
    `<button class="button" data-fc="copy">Copy as text</button>` +
    `</div></div>`;

  const legend =
    `<div class="fc-legend">` +
    `<span class="fc-key"><i class="fc-swatch shape-pill"></i>Start / end</span>` +
    `<span class="fc-key"><i class="fc-swatch shape-box"></i>Step</span>` +
    `<span class="fc-key"><i class="fc-swatch shape-diamond"></i>Decision</span>` +
    `<span class="fc-key"><i class="fc-swatch shape-db"></i>Database</span>` +
    `<span class="fc-key"><i class="fc-swatch side-browser"></i>Browser</span>` +
    `<span class="fc-key"><i class="fc-swatch side-server"></i>Server</span>` +
    `<span class="fc-key"><i class="fc-swatch side-external"></i>Leaves the app</span>` +
    `</div>`;

  const limits = tree.limits.length
    ? `<details class="dt-limits"><summary>What this cannot see</summary><ul>${tree.limits
        .map((limit) => `<li>${escapeHtml(limit)}</li>`)
        .join('')}</ul></details>`
    : '';

  panel.innerHTML =
    summary +
    `<div class="fc-bar">${toolbar}${legend}</div>` +
    `<div class="fc-scroll"><div class="fc-sizer"><div class="fc-stage"></div></div></div>` +
    limits;

  drawFlowchart(panel, tree);

  for (const button of panel.querySelectorAll('[data-fc]')) {
    button.addEventListener('click', () => flowchartAction(panel, tree, flow, button));
  }
  for (const input of panel.querySelectorAll('[data-fc-option]')) {
    input.addEventListener('change', () => {
      fc[input.dataset.fcOption] = input.checked;
      saveFcSettings();
      drawFlowchart(panel, tree);
    });
  }
}

function flowchartAction(panel, tree, flow, button) {
  const action = button.dataset.fc;
  if (action === 'copy') return void copyDecisionText(flow.id, button);
  if (action === 'in' || action === 'out' || action === 'reset' || action === 'fit') {
    const stage = panel.querySelector('.fc-stage');
    const scroll = panel.querySelector('.fc-scroll');
    const width = Number(stage?.dataset.width ?? 0);
    if (action === 'in') fc.zoom = Math.min(1.6, fc.zoom + 0.1);
    if (action === 'out') fc.zoom = Math.max(0.3, fc.zoom - 0.1);
    if (action === 'reset') fc.zoom = 1;
    if (action === 'fit' && width > 0 && scroll)
      fc.zoom = Math.max(0.3, Math.min(1, (scroll.clientWidth - 8) / width));
    fc.zoom = Math.round(fc.zoom * 100) / 100;
    applyZoom(panel);
    return;
  }
  if (action === 'open' || action === 'close') {
    for (const key of collectGroupKeys(tree.nodes)) {
      fc.folds.set(key.key, action === 'open' ? true : key.always);
    }
    drawFlowchart(panel, tree);
  }
}

async function copyDecisionText(flowId, button) {
  try {
    const response = await fetch(
      apiUrl(`/api/decisions?flow=${encodeURIComponent(flowId)}&format=text`),
    );
    await navigator.clipboard.writeText(await response.text());
    button.textContent = 'Copied';
  } catch {
    button.textContent = 'Could not copy';
  }
  setTimeout(() => (button.textContent = 'Copy as text'), 1500);
}

function applyZoom(panel) {
  const stage = panel.querySelector('.fc-stage');
  const sizer = panel.querySelector('.fc-sizer');
  if (!stage || !sizer) return;
  const width = Number(stage.dataset.width ?? 0);
  const height = Number(stage.dataset.height ?? 0);
  stage.style.transform = `scale(${fc.zoom})`;
  sizer.style.width = `${Math.ceil(width * fc.zoom)}px`;
  sizer.style.height = `${Math.ceil(height * fc.zoom)}px`;
  const label = panel.querySelector('.fc-zoom');
  if (label) label.textContent = `${Math.round(fc.zoom * 100)}%`;
}

/** Every group's fold key, and whether "Collapse helpers" leaves it open. */
function collectGroupKeys(nodes, path = 'n', out = []) {
  nodes.forEach((node, index) => {
    const key = `${path}.${index}`;
    if (node.type === 'group') {
      // A helper the request is made from stays open, or folding it would hide the request.
      out.push({
        key,
        always:
          node.kind === 'request' ||
          node.kind === 'unlinked' ||
          path === 'n' ||
          containsRequest(node.nodes),
      });
      collectGroupKeys(node.nodes, key, out);
    } else if (node.type === 'decision') {
      node.branches.forEach((branch, b) => collectGroupKeys(branch.nodes, `${key}.b${b}`, out));
    } else if (node.type === 'try') {
      collectGroupKeys(node.nodes, `${key}.t`, out);
      if (node.catch) collectGroupKeys(node.catch.nodes, `${key}.c`, out);
      if (node.finally) collectGroupKeys(node.finally, `${key}.f`, out);
    }
  });
  return out;
}

function containsRequest(nodes) {
  return nodes.some(
    (node) =>
      (node.type === 'group' && (node.kind === 'request' || containsRequest(node.nodes))) ||
      (node.type === 'decision' && node.branches.some((branch) => containsRequest(branch.nodes))) ||
      (node.type === 'try' &&
        (containsRequest(node.nodes) || containsRequest(node.catch?.nodes ?? []))),
  );
}

/** A query that changes data, or a request, somewhere inside. */
function writesData(node) {
  const children = [
    ...(node.nodes ?? []),
    ...(node.branches ?? []).flatMap((branch) => branch.nodes),
    ...(node.catch?.nodes ?? []),
    ...(node.finally ?? []),
  ];
  return children.some(
    (child) =>
      (child.type === 'step' && child.kind === 'db' && child.effect !== 'read') ||
      (child.type === 'group' && child.kind === 'request') ||
      writesData(child),
  );
}

// ---- building the chart ---------------------------------------------------

/**
 * The chart is laid out in two passes over a tree of blocks:
 *
 * - `measure` gives each block its size, its axis (the x the flow enters and
 *   leaves on) and whether every path through it ends;
 * - `place` puts it at an absolute position and records the boxes, frames
 *   and arrows to draw.
 *
 * The boxes are real HTML (so text wraps, and file links work) measured after
 * they are in the page; the arrows and diamonds are one SVG underneath.
 */
function drawFlowchart(panel, tree) {
  const stage = panel.querySelector('.fc-stage');
  if (!stage) return;
  stage.innerHTML = '';
  // Room to measure in: in a zero-width stage every box would shrink to its
  // narrowest wrap and measure taller than it draws.
  stage.style.width = '6000px';
  stage.style.height = '6000px';
  const nodesLayer = document.createElement('div');
  nodesLayer.className = 'fc-nodes';
  stage.appendChild(nodesLayer);

  const root = buildSeq(tree.nodes, 'n', 0, nodesLayer);
  measure(root);
  const margin = 24;
  const out = { edges: [], frames: [], diamonds: [], labels: [] };
  place(root, margin, margin, out);
  const width = root.w + margin * 2;
  const height = root.h + margin * 2;

  stage.dataset.width = String(width);
  stage.dataset.height = String(height);
  stage.style.width = `${width}px`;
  stage.style.height = `${height}px`;
  stage.insertAdjacentHTML('afterbegin', flowchartSvg(out, width, height));
  for (const label of out.labels) {
    const tag = document.createElement('div');
    tag.className = `fc-edge-label${label.tone ? ` tone-${label.tone}` : ''}`;
    tag.textContent = label.text;
    tag.style.left = `${label.x}px`;
    tag.style.top = `${label.y}px`;
    nodesLayer.appendChild(tag);
  }
  // The first drawing of an action fits the screen if it is wider than it;
  // after that the reader's own zoom is kept.
  const scroll = panel.querySelector('.fc-scroll');
  if (fc.fitNext && scroll && scroll.clientWidth > 0) {
    fc.zoom = width > scroll.clientWidth ? Math.max(0.45, (scroll.clientWidth - 8) / width) : 1;
    fc.zoom = Math.round(fc.zoom * 100) / 100;
    fc.fitNext = false;
  }
  applyZoom(panel);

  for (const toggle of stage.querySelectorAll('[data-fc-toggle]')) {
    toggle.addEventListener('click', (event) => {
      if (event.target.closest('[data-editor-href]')) return;
      const key = toggle.dataset.fcToggle;
      fc.folds.set(key, toggle.dataset.open !== 'true');
      drawFlowchart(panel, tree);
    });
  }
}

function buildSeq(nodes, path, depth, layer) {
  const items = [];
  // Helper calls are hidden by default — unless they are all an arm has, as
  // in `delta > 0 ? addStock() : deductFefo()`, where they are the answer.
  const onlyCalls = nodes.every((node) => node.type === 'step' && node.kind === 'call');
  nodes.forEach((node, index) => {
    if (node.type === 'step' && node.kind === 'call' && !fc.showCalls && !onlyCalls) return;
    items.push(...buildBlock(node, `${path}.${index}`, depth, layer));
  });
  return { kind: 'seq', items };
}

function buildBlock(node, key, depth, layer) {
  switch (node.type) {
    case 'step':
    case 'end':
      return [{ kind: 'box', el: boxElement(node, layer), ends: node.type === 'end' }];
    case 'decision': {
      const branches = node.branches.map((branch, index) => ({
        label: branch.label,
        ends: branch.ends,
        tone: branchTone(branch),
        seq: emptyAware(buildSeq(branch.nodes, `${key}.b${index}`, depth, layer), layer),
      }));
      return [
        {
          kind: 'decision',
          el: diamondElement(node, layer),
          side: node.side,
          branches,
          fall: node.otherwise ?? null,
        },
      ];
    }
    case 'group': {
      const defaultOpen =
        node.kind === 'request' || node.kind === 'unlinked' || depth < 2 || writesData(node);
      const open = fc.folds.has(key) ? fc.folds.get(key) : defaultOpen;
      if (!open || node.nodes.length === 0) {
        return [{ kind: 'box', el: foldedElement(node, key, layer), ends: false }];
      }
      return [
        {
          kind: 'frame',
          el: frameHeadElement(node, key, layer),
          frameClass: `kind-${node.kind} side-${node.side}`,
          seq: buildSeq(node.nodes, key, depth + 1, layer),
        },
      ];
    }
    case 'try': {
      const blocks = [
        {
          kind: 'try',
          el: plainHead('Try', 'try', layer),
          seq: buildSeq(node.nodes, `${key}.t`, depth, layer),
          catch: node.catch
            ? {
                label: `if ${node.catch.label}`,
                ends: node.catch.ends,
                tone: 'bad',
                seq: emptyAware(buildSeq(node.catch.nodes, `${key}.c`, depth, layer), layer),
              }
            : null,
        },
      ];
      if (node.finally?.length) {
        blocks.push({
          kind: 'frame',
          el: plainHead('Either way (finally)', 'finally', layer),
          frameClass: 'kind-finally',
          seq: buildSeq(node.finally, `${key}.f`, depth, layer),
        });
      }
      return blocks;
    }
    default:
      return [];
  }
}

/** An arm with nothing in it still needs something to point the arrow at. */
function emptyAware(seq, layer) {
  if (seq.items.length > 0) return seq;
  const el = document.createElement('div');
  el.className = 'fc-node fc-plain';
  el.textContent = 'nothing to show — plain code';
  layer.appendChild(el);
  return { kind: 'seq', items: [{ kind: 'box', el, ends: false }] };
}

/** Red for an arm that ends in a failure, so the unhappy paths stand out. */
function branchTone(branch) {
  const last = branch.nodes.at(-1);
  if (!last || last.type !== 'end') return '';
  const worst = Math.max(0, ...(last.statuses ?? []));
  if (last.outcome === 'throw' || worst >= 400) return 'bad';
  if (last.outcome === 'stop') return 'stop';
  return '';
}

function endTone(node) {
  const worst = Math.max(0, ...(node.statuses ?? []));
  if (node.outcome === 'throw' || worst >= 500) return 'danger';
  if (worst >= 400) return 'warn';
  if (node.outcome === 'respond' && worst > 0) return 'ok';
  return 'muted';
}

function codeLine(label, code) {
  if (!fc.showCode || !code) return '';
  const clean = (text) => text.replace(/\s+/g, '').toLowerCase();
  if (clean(label) === clean(code)) return '';
  return `<code class="fc-code">${escapeHtml(code)}</code>`;
}

function atLine(at) {
  return at ? `<span class="fc-at">${fileRef(at.file, at.line, '', true)}</span>` : '';
}

function boxElement(node, layer) {
  const el = document.createElement('div');
  if (node.type === 'end') {
    const status = node.statuses?.length ? node.statuses.join(' / ') : '';
    const label = status ? statusWords(node) : node.label;
    el.className = `fc-node fc-end tone-${endTone(node)} side-${node.side}`;
    el.innerHTML =
      (status ? `<span class="fc-status">${escapeHtml(status)}</span>` : '') +
      `<div class="fc-body"><div class="fc-label">${escapeHtml(label)}</div>` +
      `${node.outcome === 'stop' ? '' : codeLine(node.label, node.text)}${atLine(node.at)}</div>`;
  } else {
    const icon =
      { trigger: '▶', db: '⛁', external: '⇢', guard: '⛨', ui: '◧', call: 'ƒ', compute: '≔' }[
        node.kind
      ] ?? '•';
    const effect = node.effect
      ? `<span class="fc-effect effect-${escapeHtml(node.effect)}">${escapeHtml(EFFECT_TILE[node.effect] ?? node.effect)}</span>`
      : '';
    el.className = `fc-node fc-step kind-${node.kind} side-${node.side}`;
    el.innerHTML =
      `<span class="fc-icon" aria-hidden="true">${icon}</span>` +
      `<div class="fc-body"><div class="fc-label">${escapeHtml(node.label)}${effect}</div>` +
      `${node.kind === 'trigger' ? '' : codeLine(node.label, node.text)}${atLine(node.at)}</div>`;
  }
  layer.appendChild(el);
  return el;
}

/** Beside a status badge the number is already said: `422` + `Respond: Validation failed`. */
function statusWords(node) {
  const message = node.message ? `: ${node.message}` : '';
  if (node.outcome === 'respond') return `Respond${message}`;
  if (node.outcome === 'throw') return `Throw${message || ' an error'}`;
  return `Return to the caller${message}`;
}

function diamondElement(node, layer) {
  const el = document.createElement('div');
  el.className = `fc-node fc-diamond-text side-${node.side}`;
  el.innerHTML =
    `<div class="fc-label">${escapeHtml(node.label)}</div>` +
    codeLine(node.label, node.code) +
    atLine(node.at);
  el.title = node.code;
  layer.appendChild(el);
  return el;
}

function frameHeadElement(node, key, layer) {
  const el = document.createElement('div');
  el.className = `fc-frame-head kind-${node.kind} side-${node.side}`;
  el.dataset.fcToggle = key;
  el.dataset.open = 'true';
  el.setAttribute('role', 'button');
  el.tabIndex = 0;
  const icon =
    { request: '⇄', loop: '↻', parallel: '⇉', function: 'ƒ', unlinked: '⋯' }[node.kind] ?? 'ƒ';
  const where = node.handledBy
    ? `<span class="fc-at">answered by ${fileRef(node.handledBy.file, node.handledBy.line, '', true)}</span>`
    : atLine(node.at);
  el.innerHTML =
    `<span class="fc-fold" aria-hidden="true">▾</span><span class="fc-icon">${icon}</span>` +
    `<span class="fc-label">${escapeHtml(node.label)}</span>` +
    (node.kind === 'request' || node.title === node.label ? '' : codeLine(node.label, node.title)) +
    where;
  layer.appendChild(el);
  return el;
}

function foldedElement(node, key, layer) {
  const el = document.createElement('div');
  const count = countInside(node.nodes);
  el.className = `fc-node fc-folded kind-${node.kind} side-${node.side}`;
  el.dataset.fcToggle = key;
  el.dataset.open = 'false';
  el.setAttribute('role', 'button');
  el.tabIndex = 0;
  el.title = 'Open to see what happens inside';
  el.innerHTML =
    `<span class="fc-fold" aria-hidden="true">▸</span>` +
    `<div class="fc-body"><div class="fc-label">${escapeHtml(node.label)}` +
    (count ? ` <span class="fc-count">${count} inside</span>` : '') +
    `</div>${codeLine(node.label, node.title)}${atLine(node.at)}</div>`;
  layer.appendChild(el);
  return el;
}

function plainHead(text, kind, layer) {
  const el = document.createElement('div');
  el.className = `fc-frame-head kind-${kind}`;
  el.innerHTML = `<span class="fc-label">${escapeHtml(text)}</span>`;
  layer.appendChild(el);
  return el;
}

/** How many decisions, queries and ends a folded box hides. */
function countInside(nodes) {
  let decisions = 0;
  let queries = 0;
  const visit = (list) => {
    for (const node of list) {
      if (node.type === 'decision') {
        decisions += 1;
        node.branches.forEach((branch) => visit(branch.nodes));
      } else if (node.type === 'group') visit(node.nodes);
      else if (node.type === 'try') {
        visit(node.nodes);
        if (node.catch) visit(node.catch.nodes);
      } else if (node.type === 'step' && node.kind === 'db') queries += 1;
    }
  };
  visit(nodes);
  const parts = [];
  if (decisions) parts.push(`${decisions} ${decisions === 1 ? 'decision' : 'decisions'}`);
  if (queries) parts.push(`${queries} ${queries === 1 ? 'query' : 'queries'}`);
  return parts.join(', ');
}

// ---- measuring ------------------------------------------------------------

/** Width and height of an element, estimated where the page cannot measure (hidden, tests). */
function sizeOf(el) {
  const w = el.offsetWidth;
  const h = el.offsetHeight;
  if (w > 0 && h > 0) return { w, h };
  const chars = (el.textContent ?? '').length;
  const width = Math.max(110, Math.min(300, chars * 7 + 40));
  const lines = Math.max(1, Math.ceil((chars * 7) / (width - 30)));
  return { w: width, h: 18 * lines + 18 };
}

function measure(block) {
  switch (block.kind) {
    case 'box': {
      const { w, h } = sizeOf(block.el);
      Object.assign(block, { w, h, ax: w / 2 });
      return block;
    }
    case 'seq': {
      let left = 0;
      let right = 0;
      let cy = 0;
      let bottom = 0;
      // Space a decision's exit arm still occupies to the right of the axis
      // after the diamond itself: later steps may sit beside it, not over it.
      const reserved = [];
      block.items.forEach((item, index) => {
        measure(item);
        left = Math.max(left, item.ax);
        right = Math.max(right, item.w - item.ax);
        if (index) cy += FC.gapY;
        const reach = item.w - item.ax;
        for (const region of reserved) {
          if (region.bottom > cy && reach > region.left - 20) cy = region.bottom + FC.gapY;
        }
        item.offY = cy;
        if (item.overhang)
          reserved.push({ left: item.overhang.left, bottom: cy + item.overhang.bottom });
        cy += item.h;
        bottom = Math.max(bottom, cy, ...reserved.map((region) => region.bottom));
      });
      const ends = block.items.some((item) => item.ends);
      return Object.assign(block, { w: left + right, h: bottom, ax: left, ends });
    }
    case 'frame': {
      const head = sizeOf(block.el);
      measure(block.seq);
      const inner = Math.max(head.w, block.seq.w);
      const w = inner + FC.framePad * 2;
      const axInner = Math.max(block.seq.ax, head.w / 2);
      return Object.assign(block, {
        head,
        w: Math.max(w, axInner + (block.seq.w - block.seq.ax) + FC.framePad * 2),
        h: head.h + FC.headGap + block.seq.h + FC.framePad + (block.seq.ends ? 0 : FC.gapY - 8),
        ax: FC.framePad + axInner,
        ends: false,
      });
    }
    case 'decision': {
      const text = sizeOf(block.el);
      // The smallest diamond the text box fits inside: tw/dw + th/dh <= 1.
      const dh = text.h + 40;
      const dw = Math.max(150, text.w / (1 - text.h / dh) + 24);
      block.text = text;
      block.dw = dw;
      block.dh = dh;
      block.branches.forEach((branch) => measure(branch.seq));
      return block.fall ? measureSide(block) : measureSplit(block);
    }
    case 'try': {
      const head = sizeOf(block.el);
      measure(block.seq);
      const frame = {
        w: Math.max(head.w, block.seq.w) + FC.framePad * 2,
        h: head.h + FC.headGap + block.seq.h + FC.framePad,
        ax: FC.framePad + Math.max(block.seq.ax, head.w / 2),
      };
      block.head = head;
      block.frame = frame;
      if (block.catch) measure(block.catch.seq);
      const catchW = block.catch ? FC.gapX + 40 + block.catch.seq.w : 0;
      const catchH = block.catch ? FC.branchDrop + block.catch.seq.h : 0;
      const tryEnds = block.seq.ends;
      const catchEnds = !block.catch || block.catch.ends;
      const continues = !tryEnds || !catchEnds;
      const body = Math.max(frame.h, catchH);
      return Object.assign(block, {
        w: frame.w + catchW,
        h: body + (continues ? FC.merge * 2 : 0),
        ax: frame.ax,
        ends: !continues,
      });
    }
  }
  return block;
}

/** `if (!valid) { …; return; }` — the arm goes right, the flow carries on down. */
function measureSide(block) {
  const { dw, dh } = block;
  let x = dw / 2 + FC.gapX;
  let tallest = 0;
  for (const branch of block.branches) {
    branch.x = x; // left edge, relative to the axis
    x += branch.seq.w + FC.gapX;
    tallest = Math.max(tallest, branch.seq.h);
  }
  const anyRejoin = block.branches.some((branch) => !branch.ends);
  const body = Math.max(dh, dh / 2 + FC.branchDrop + tallest);
  const w = dw / 2 + Math.max(dw / 2, x - FC.gapX);
  if (!anyRejoin) {
    // Every arm ends: the flow carries on right under the diamond, beside them.
    return Object.assign(block, {
      w,
      h: dh + FC.merge,
      ax: dw / 2,
      ends: false,
      overhang: { left: dw / 2 + FC.gapX, bottom: body },
    });
  }
  return Object.assign(block, {
    w,
    h: body + FC.merge * 2,
    ax: dw / 2,
    ends: false,
  });
}

/** `if … else …` — the arms side by side under the diamond, joining below. */
function measureSplit(block) {
  const { dw, dh } = block;
  const total =
    block.branches.reduce((sum, branch) => sum + branch.seq.w, 0) +
    FC.gapX * Math.max(0, block.branches.length - 1);
  const w = Math.max(dw, total);
  let x = (w - total) / 2;
  let tallest = 0;
  for (const branch of block.branches) {
    branch.x = x; // left edge, relative to the block
    x += branch.seq.w + FC.gapX;
    tallest = Math.max(tallest, branch.seq.h);
  }
  const anyRejoin = block.branches.some((branch) => !branch.ends);
  return Object.assign(block, {
    w,
    h: dh + FC.branchDrop + 14 + tallest + (anyRejoin ? FC.merge * 2 : 0),
    ax: w / 2,
    ends: !anyRejoin,
  });
}

// ---- placing --------------------------------------------------------------

function put(el, x, y) {
  el.style.left = `${Math.round(x)}px`;
  el.style.top = `${Math.round(y)}px`;
}

/**
 * One connector. `head: false` for a line that only carries the flow on to
 * the next arrow — an arrowhead halfway down a straight line reads as a step.
 */
function arrow(out, points, { label, at, tone, head = true } = {}) {
  out.edges.push({ points, tone, head });
  if (label) {
    const [x, y] = at ?? points[1] ?? points[0];
    out.labels.push({ text: label, x, y, tone });
  }
}

function place(block, x, y, out) {
  switch (block.kind) {
    case 'box':
      put(block.el, x, y);
      return;
    case 'seq': {
      const axis = x + block.ax;
      block.items.forEach((item, index) => {
        const top = y + item.offY;
        if (index > 0) {
          const previous = block.items[index - 1];
          if (!previous.ends)
            arrow(out, [
              [axis, y + previous.offY + previous.h],
              [axis, top],
            ]);
        }
        place(item, axis - item.ax, top, out);
      });
      return;
    }
    case 'frame': {
      out.frames.push({ x, y, w: block.w, h: block.h, cls: block.frameClass });
      put(block.el, x + FC.framePad - 4, y + 8);
      const axis = x + block.ax;
      const top = y + block.head.h + FC.headGap + 6;
      place(block.seq, axis - block.seq.ax, top, out);
      if (!block.seq.ends) {
        const bottom = top + block.seq.h;
        arrow(
          out,
          [
            [axis, bottom],
            [axis, y + block.h],
          ],
          { head: false },
        );
      }
      return;
    }
    case 'decision': {
      const axis = x + block.ax;
      out.diamonds.push({
        cx: axis,
        cy: y + block.dh / 2,
        w: block.dw,
        h: block.dh,
        side: block.side,
      });
      put(block.el, axis - block.text.w / 2, y + (block.dh - block.text.h) / 2);
      return block.fall ? placeSide(block, axis, y, out) : placeSplit(block, x, y, out);
    }
    case 'try': {
      const { frame } = block;
      const axis = x + block.ax;
      out.frames.push({ x, y, w: frame.w, h: frame.h, cls: 'kind-try' });
      put(block.el, x + FC.framePad - 4, y + 8);
      const top = y + block.head.h + FC.headGap + 6;
      place(block.seq, axis - block.seq.ax, top, out);
      const bottom = y + block.h;
      const mergeY = bottom - FC.merge;
      if (!block.seq.ends)
        arrow(
          out,
          [
            [axis, top + block.seq.h],
            [axis, bottom],
          ],
          { head: false },
        );
      if (block.catch) {
        const left = x + frame.w + FC.gapX + 40;
        const cx = left + block.catch.seq.ax;
        const startY = y + block.head.h / 2 + 8;
        arrow(
          out,
          [
            [x + frame.w, startY],
            [cx, startY],
            [cx, y + FC.branchDrop],
          ],
          {
            label: block.catch.label,
            at: [(x + frame.w + cx) / 2, startY],
            tone: 'bad',
          },
        );
        place(block.catch.seq, left, y + FC.branchDrop, out);
        if (!block.catch.ends) {
          arrow(out, [
            [cx, y + FC.branchDrop + block.catch.seq.h],
            [cx, mergeY],
            [axis, mergeY],
          ]);
        }
      }
      return;
    }
  }
}

function placeSide(block, axis, y, out) {
  const { dw, dh } = block;
  const rightCorner = axis + dw / 2;
  const midY = y + dh / 2;
  const bottom = y + block.h;
  const mergeY = bottom - FC.merge;
  // The answer that carries on goes straight down.
  arrow(
    out,
    [
      [axis, y + dh],
      [axis, bottom],
    ],
    {
      label: block.fall,
      at: [axis, y + dh + 14],
      head: false,
    },
  );
  for (const branch of block.branches) {
    const left = axis + branch.x;
    const cx = left + branch.seq.ax;
    const top = midY + FC.branchDrop;
    arrow(
      out,
      [
        [rightCorner, midY],
        [cx, midY],
        [cx, top],
      ],
      {
        label: branch.label,
        at: [(rightCorner + Math.min(cx, rightCorner + 160)) / 2 + 8, midY],
        tone: branch.tone,
      },
    );
    place(branch.seq, left, top, out);
    if (!branch.ends) {
      arrow(out, [
        [cx, top + branch.seq.h],
        [cx, mergeY],
        [axis, mergeY],
      ]);
    }
  }
}

function placeSplit(block, x, y, out) {
  const { dh } = block;
  const axis = x + block.ax;
  const splitY = y + dh + 12;
  const top = y + dh + FC.branchDrop + 14;
  const tallest = Math.max(...block.branches.map((branch) => branch.seq.h));
  const mergeY = top + tallest + FC.merge;
  for (const branch of block.branches) {
    const left = x + branch.x;
    const cx = left + branch.seq.ax;
    arrow(
      out,
      [
        [axis, y + dh],
        [axis, splitY],
        [cx, splitY],
        [cx, top],
      ],
      {
        label: branch.label,
        at: [cx, (splitY + top) / 2],
        tone: branch.tone,
      },
    );
    place(branch.seq, left, top, out);
    if (!branch.ends) {
      arrow(out, [
        [cx, top + branch.seq.h],
        [cx, mergeY],
        [axis, mergeY],
        [axis, y + block.h],
      ]);
    }
  }
}

function flowchartSvg(out, width, height) {
  const path = (points) =>
    points.map(([px, py], index) => `${index ? 'L' : 'M'}${px} ${py}`).join(' ');
  const frames = out.frames
    .map(
      (frame) =>
        `<rect class="fc-frame ${escapeHtml(frame.cls)}" x="${frame.x}" y="${frame.y}" width="${frame.w}" height="${frame.h}" rx="12" />`,
    )
    .join('');
  const diamonds = out.diamonds
    .map(
      (d) =>
        `<polygon class="fc-diamond side-${escapeHtml(d.side)}" points="${d.cx},${d.cy - d.h / 2} ${d.cx + d.w / 2},${d.cy} ${d.cx},${d.cy + d.h / 2} ${d.cx - d.w / 2},${d.cy}" />`,
    )
    .join('');
  const edges = out.edges
    .map(
      (edge) =>
        `<path class="fc-edge${edge.tone ? ` tone-${edge.tone}` : ''}" d="${path(edge.points)}" ${edge.head ? ` marker-end="url(#fc-arrow${edge.tone === 'bad' ? '-bad' : ''})"` : ''} />`,
    )
    .join('');
  return (
    `<svg class="fc-svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" aria-hidden="true">` +
    `<defs>` +
    `<marker id="fc-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0 0 L10 5 L0 10 z" class="fc-arrowhead" /></marker>` +
    `<marker id="fc-arrow-bad" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0 0 L10 5 L0 10 z" class="fc-arrowhead tone-bad" /></marker>` +
    `</defs>${frames}${edges}${diamonds}</svg>`
  );
}

/** Findings, read once per scan: the flow list marks and Issues & impact both need them. */
async function loadIssues() {
  try {
    state.findings = await getJson('/api/findings');
  } catch (error) {
    state.findings = { error: String(error.message ?? error), findings: [] };
  }
  renderFlowList();
  renderTabs();
  if (state.tab === 'impact') renderImpact();
}

function issuesFor(flowId) {
  return (state.findings?.findings ?? []).filter((finding) => finding.flowIds.includes(flowId));
}

const ISSUE_KINDS = {
  'no-auth': 'No auth check',
  'tenant-scope': 'Missing tenant filter',
  'tenant-from-request': 'Tenant taken from the request',
  'mass-assignment': 'Mass assignment',
  'n-plus-one': 'Query in a loop (N+1)',
  'sequential-awaits': 'Reads that wait for each other',
};

/**
 * Bugs the graph and the source can show, each with the line to open, why it
 * matters and how to fix it: the selected action's first, then the rest of
 * the project, filterable — a real codebase has hundreds, and the high ones
 * must not drown in the low ones.
 */
function actionIssuesHtml(number) {
  const flow = state.selectedFlow;
  const data = state.findings;
  const title = flow ? `Issues in <em>${escapeHtml(flowTitle(flow))}</em>` : 'Issues in an action';
  let body;
  if (!flow) {
    body = `<p class="tab-note">Pick an action on the left to see the bugs in the code it runs through.</p>`;
  } else if (!data) {
    body = `<p class="muted">Reading the whole project for bugs…</p>`;
  } else if (data.error) {
    body = `<p class="error">${escapeHtml(String(data.error))}</p>`;
  } else {
    const mine = issuesFor(flow.id);
    body = mine.length
      ? answer(
          issueTone(mine),
          `${plural(mine.length, 'issue')} in the code this action runs through`,
          'Each one names the line to open and how to fix it.',
        ) +
        `<ol class="issue-list">${mine.map((finding) => renderIssue(finding, true)).join('')}</ol>`
      : answer(
          'ok',
          'No issues found in this action',
          'Checked for missing auth, missing tenant filters, mass assignment, queries in loops and reads that wait for each other.',
        );
  }
  return impactSection(number, title, body, 'impact-issues');
}

/** The rest of the project's issues, in a box of its own so a filter redraws only it. */
function projectIssuesHtml(number) {
  const title = state.selectedFlow
    ? 'Issues everywhere else in the project'
    : 'Issues across the project';
  return impactSection(
    number,
    title,
    `<div id="project-issues">${projectIssuesBody()}</div>`,
    'impact-project',
  );
}

function projectIssuesBody() {
  const data = state.findings;
  if (!data) return `<p class="muted">Reading the whole project for bugs…</p>`;
  if (data.error) return `<p class="error">${escapeHtml(String(data.error))}</p>`;
  const flow = state.selectedFlow;
  const mine = flow ? issuesFor(flow.id) : [];
  const others = data.findings.filter((finding) => !mine.includes(finding));
  if (others.length === 0) {
    return `<p class="tab-note">No other issues in the project. Checked ${data.checked.routes} routes and ${data.checked.queries} queries.</p>`;
  }

  const counts = { high: 0, medium: 0, low: 0 };
  for (const finding of others) counts[finding.severity] += 1;
  const kinds = [...new Set(others.map((finding) => finding.kind))];
  const shown = others.filter(
    (finding) =>
      state.issueSeverities.has(finding.severity) &&
      (state.issueKind === 'all' || finding.kind === state.issueKind),
  );
  const filters = `<div class="issue-filters" role="group" aria-label="Filter issues">
      ${['high', 'medium', 'low']
        .map(
          (severity) =>
            `<button class="issue-filter sev-${severity}${state.issueSeverities.has(severity) ? ' active' : ''}" data-issue-severity="${severity}" aria-pressed="${state.issueSeverities.has(severity)}">${counts[severity]} ${severity}</button>`,
        )
        .join('')}
      <select class="issue-kind" aria-label="Kind of issue">
        <option value="all">Every kind</option>
        ${kinds
          .map(
            (kind) =>
              `<option value="${kind}"${state.issueKind === kind ? ' selected' : ''}>${escapeHtml(ISSUE_KINDS[kind] ?? kind)} (${others.filter((finding) => finding.kind === kind).length})</option>`,
          )
          .join('')}
      </select>
    </div>`;

  const scope = [
    `${plural(others.length, 'issue')} in other actions and routes`,
    `checked ${data.checked.routes} routes and ${data.checked.queries} queries`,
    data.tenantKey ? `tenant field: \`${data.tenantKey}\`` : 'no tenant field found',
  ].join(' · ');

  return (
    `<p class="tab-note">${richText(scope)}. Showing ${shown.length}.</p>` +
    filters +
    (shown.length
      ? `<ol class="issue-list">${shown.map((finding) => renderIssue(finding, false)).join('')}</ol>`
      : '<p class="muted">Nothing at the chosen severity.</p>') +
    notesList(data.notes)
  );
}

/** Wire the filters inside the project list; they redraw it and nothing else. */
function bindProjectIssues(panel) {
  const box = panel.querySelector('#project-issues');
  if (!box) return;
  const redraw = () => {
    box.innerHTML = projectIssuesBody();
    bindProjectIssues(panel);
  };
  for (const button of box.querySelectorAll('[data-issue-severity]')) {
    button.addEventListener('click', () => {
      const severity = button.dataset.issueSeverity;
      if (state.issueSeverities.has(severity)) state.issueSeverities.delete(severity);
      else state.issueSeverities.add(severity);
      redraw();
    });
  }
  box.querySelector('.issue-kind')?.addEventListener('change', (event) => {
    state.issueKind = event.target.value;
    redraw();
  });
  bindIssueJumps(box);
}

function issueTone(findings) {
  if (findings.some((finding) => finding.severity === 'high')) return 'danger';
  if (findings.some((finding) => finding.severity === 'medium')) return 'warn';
  return 'neutral';
}

/** One finding: the headline always; why, fix, code and the actions it reaches when opened. */
function renderIssue(finding, open) {
  const actions = finding.flowIds
    .map((id) => state.flows.find((candidate) => candidate.id === id))
    .filter(Boolean);
  return `<li class="issue sev-${escapeHtml(finding.severity)}">
      <details${open ? ' open' : ''}>
        <summary>
          <span class="chip small sev-${escapeHtml(finding.severity)}">${escapeHtml(finding.severity)}</span>
          <span class="issue-kind-label">${escapeHtml(ISSUE_KINDS[finding.kind] ?? finding.kind)}</span>
          <span class="issue-title">${richText(finding.title)}</span>
          <span class="issue-where">${fileRef(finding.at.file, finding.at.line, '', true)}</span>
        </summary>
        <div class="issue-body">
          <p>${richText(finding.why)}</p>
          ${
            finding.code
              ? `<div class="q-code-wrap"><pre class="q-code"><code>${escapeHtml(finding.code)}</code></pre>${editorLink('Open in editor', finding.at.file, finding.at.line, { extraClass: 'q-open' })}</div>`
              : ''
          }
          <p class="issue-fix"><strong>Fix:</strong> ${richText(finding.fix)}</p>
          ${
            finding.related?.length
              ? `<ul class="adoc-lines">${finding.related
                  .map(
                    (entry) =>
                      `<li>${escapeHtml(entry.text)} ${fileRef(entry.at.file, entry.at.line)}</li>`,
                  )
                  .join('')}</ul>`
              : ''
          }
          ${
            actions.length
              ? `<p class="muted issue-actions">Reached by ${actions
                  .map(
                    (flow) =>
                      `<button class="link" data-issue-flow="${escapeHtml(flow.id)}">${escapeHtml(flowTitle(flow))}</button>`,
                  )
                  .join(', ')}</p>`
              : ''
          }
        </div>
      </details>
    </li>`;
}

/** An action named under an issue opens that action, staying on this tab. */
function bindIssueJumps(panel) {
  for (const button of panel.querySelectorAll('[data-issue-flow]')) {
    button.addEventListener('click', () => {
      state.tab = 'impact';
      selectFlow(button.dataset.issueFlow);
    });
  }
}

/**
 * The Performance tab: where the action's time goes. One answer at the top,
 * then the time of each step, then each database query as the code wrote it
 * with its own time.
 *
 * Every number comes from runtime spans; FlowLens never connects to the
 * database itself. The query code is read from the source, including the
 * lines that build a filter held in a variable — `find(filter)` says nothing
 * until you see what goes into `filter`. Nothing measured says so, with how to
 * measure, rather than a guess.
 */
function renderPerf() {
  const panel = el.panels.perf;
  if (!panel) return;
  const flow = state.selectedFlow;
  if (!flow) {
    panel.innerHTML = `<div class="empty-state"><h3>Nothing selected</h3><p>Select an action on the left.</p></div>`;
    return;
  }
  if (!state.insight) return panelLoading(panel, 'the timings');
  if (state.insight.error) return panelError(panel, state.insight);
  const data = state.queries;
  if (state.queriesLoading || !data || (data.flowId && data.flowId !== flow.id))
    return panelLoading(panel, 'the queries behind this action');

  const timing = state.insight.timing;
  const queries = data.error ? [] : data.queries;
  const timed = queries.filter((query) => query.timing);
  const slowestQuery = timed.reduce(
    (worst, query) => (!worst || query.timing.avgMs > worst.timing.avgMs ? query : worst),
    undefined,
  );

  let summary;
  if (!timing.observed && timed.length === 0) {
    summary = answer(
      'neutral',
      'This action has not been run with tracing on',
      'FlowLens does not guess timings — the numbers come from your app actually running. See **How to measure it** at the end.',
    );
  } else {
    const facts = [];
    if (timing.slowest)
      facts.push(
        `Slowest step: \`${timing.slowest.label}\` (${formatMs(timing.slowest.avgSelfMs)} of its own` +
          (timing.fewRuns
            ? `, from **${timing.slowestRuns === 1 ? 'one run' : `${timing.slowestRuns} runs`}** — do the action a few more times before trusting it).`
            : `, over ${timing.slowestRuns} runs).`),
      );
    if (slowestQuery)
      facts.push(
        `Slowest query: \`${slowestQuery.collection}.${slowestQuery.operation}\` at ${formatMs(slowestQuery.timing.avgMs)} on average.`,
      );
    if (data.dbMs)
      facts.push(
        `The ${timed.length} timed ${timed.length === 1 ? 'query adds' : 'queries add'} up to **${formatMs(data.dbMs)}** — queries started together overlap, so that can be more than the wait.`,
      );
    const slow = slowestQuery && slowestQuery.timing.avgMs >= SLOW_QUERY_MS;
    // The wait is the longest step start to finish; the own times add up to more
    // when requests run side by side, and the header chip shows that sum.
    if (timing.observed && timing.accountedMs > timing.totalMs * 1.1)
      facts.push(
        `The steps' own times add up to ${formatMs(timing.accountedMs)} because some run at the same time.`,
      );
    summary = answer(
      slow ? 'warn' : 'ok',
      timing.observed
        ? `The user waits about ${formatMs(timing.totalMs)} — the longest step, start to finish`
        : 'Only some queries have been timed',
      facts.join(' '),
    );
  }

  const stepsPart = timing.observed ? timingHtml(timing) : '';
  const queriesPart = data.error
    ? `<p class="error">${escapeHtml(String(data.error))}</p>`
    : queriesHtml(queries, flow);

  const howTo = `<details class="more q-howto"${timing.observed || timed.length ? '' : ' open'}>
      <summary>How to measure it</summary>
      <ol>
        <li>Run the app with FlowLens tracing on: <code>@flowslens/runtime</code> in a Node server,
            or the app's own instrumentation (a Next.js app's <code>.env.local</code> can point
            <code>NEXT_PUBLIC_FLOWLENS_SPANS</code> at this dashboard).</li>
        <li>The dashboard has to run with the token the app sends: <code>flowlens serve &lt;project&gt; --token flowlens-dev</code>.</li>
        <li>Do the action in the app a few times — every run adds to the averages.</li>
        <li>Press <strong>Rescan</strong> at the top.</li>
      </ol>
      <p class="muted">FlowLens never connects to the database. The app measures its own work and sends only
         names and times — for a query, the collection and the operation; no filter values, no documents.</p>
    </details>`;

  panel.innerHTML =
    panelIntro(
      'Where the time goes when a user does this: each step, and each database query with the code that runs it.',
    ) +
    summary +
    stepsPart +
    queriesPart +
    (timing.observed ? '' : measuredElsewhereHtml()) +
    howTo;
  bindTimingJumps(panel);
}

/** Each database query: its time, its code, and where its variables come from. */
function queriesHtml(queries, flow) {
  if (queries.length === 0) {
    return (
      heading('Database queries') +
      `<p class="muted">${
        flow.hitsBackend
          ? 'No database query was found on the way — the endpoint may answer from memory or call another service.'
          : 'This action never reaches the backend, so there is nothing to query.'
      }</p>`
    );
  }
  const timed = queries.filter((query) => query.timing);
  const maxMs = Math.max(1, ...timed.map((query) => query.timing.maxMs));
  const rows = queries
    .map((query, index) => {
      const effect = QUERY_EFFECT[query.effect] ?? query.effect;
      const t = query.timing;
      const bar = t
        ? `<div class="q-bar" title="fastest ${formatMs(t.minMs)} · slowest ${formatMs(t.maxMs)}">
             <span class="q-bar-range" style="left:${(t.minMs / maxMs) * 100}%;width:${Math.max(0.5, ((t.maxMs - t.minMs) / maxMs) * 100)}%"></span>
             <span class="q-bar-avg" style="width:${Math.max(1, (t.avgMs / maxMs) * 100)}%"></span>
           </div>`
        : '';
      const time = t
        ? `<div class="q-time${t.avgMs >= SLOW_QUERY_MS ? ' is-slow' : ''}">
             <strong>${formatMs(t.avgMs)}</strong> average
             <span class="muted">· fastest ${formatMs(t.minMs)} · slowest ${formatMs(t.maxMs)} · ${t.count} run${t.count === 1 ? '' : 's'}</span>
           </div>${bar}`
        : `<div class="q-time muted">Not measured yet</div>`;
      const where = [
        query.inFunction ? `in <code>${escapeHtml(query.inFunction)}</code>` : '',
        query.at ? fileRef(query.at.file, query.at.line) : '',
      ]
        .filter(Boolean)
        .join(' · ');
      const code = query.code
        ? `<div class="q-code-wrap"><pre class="q-code"><code>${escapeHtml(query.code)}</code></pre>${
            query.at
              ? editorLink('Open in editor', query.at.file, query.at.line, {
                  extraClass: 'q-open',
                })
              : ''
          }</div>`
        : `<p class="muted q-nocode">${
            query.evidence === 'runtime'
              ? 'Seen running, but not found in the code — it is called through something FlowLens cannot follow (a cached helper, a dynamic collection name, a library).'
              : 'The code for this query could not be read.'
          }</p>`;
      const variables = query.parts
        .flatMap((part) => (part.variables ?? []).map((variable) => ({ part, variable })))
        .filter(({ variable }) => variable.builtBy?.length || variable.parameterOf);
      const built = variables.length
        ? `<div class="q-built">${variables.map(({ part, variable }) => renderQueryVariable(part, variable)).join('')}</div>`
        : '';
      return `<li class="q-item">
          <div class="q-head">
            <span class="q-num">${index + 1}</span>
            <span class="chip small effect-${escapeHtml(query.effect)}">${escapeHtml(effect)}</span>
            <span class="q-name"><strong>${escapeHtml(query.collection)}</strong>.${escapeHtml(query.operation)}</span>
            <span class="q-where muted">${where}</span>
          </div>
          ${time}
          ${code}
          ${built}
        </li>`;
    })
    .join('');
  return (
    heading(
      `Database queries (${queries.length})`,
      `${timed.length} of ${queries.length} timed. The code is what the backend runs; a variable is followed to the lines that build it.`,
    ) + `<ol class="q-list">${rows}</ol>`
  );
}

/** Where a variable in a query comes from: the caller, or the lines that build it. */
function renderQueryVariable(part, variable) {
  const role = PART_ROLE[part.role] ?? part.role;
  const lead = part.text === variable.name ? role : `${role}: uses`;
  if (variable.parameterOf) {
    return `<p class="q-var"><span class="muted">${escapeHtml(lead)}</span> <code>${escapeHtml(variable.name)}</code>
      — passed in by whoever calls <code>${escapeHtml(variable.parameterOf)}</code></p>`;
  }
  const lines = (list) =>
    // Each line opens where it is written.
    `<pre class="q-code small"><code>${list
      .map((line) =>
        line.at?.file && editorHref(line.at.file, line.at.line)
          ? `<span class="q-line" data-editor-href="${escapeHtml(editorHref(line.at.file, line.at.line))}" title="${escapeHtml(`${line.at.file}:${line.at.line}`)} — open in your editor">${escapeHtml(line.text)}</span>`
          : escapeHtml(line.text),
      )
      .join('\n')}</code></pre>`;
  const helper = variable.helper
    ? `<p class="q-var muted">…and <code>${escapeHtml(variable.helper.name)}</code> builds the
         <code>${escapeHtml(variable.helper.returns)}</code> it returns like this:</p>${lines(variable.helper.builtBy)}`
    : '';
  return `<p class="q-var"><span class="muted">${escapeHtml(lead)}</span> <code>${escapeHtml(variable.name)}</code>, built here <span class="muted">— click a line to open it</span>:</p>
    ${lines(variable.builtBy)}${helper}`;
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

/** `web/src/Form.tsx:16` -> `['web/src/Form.tsx', 16]` */
function splitSite(site) {
  const match = /^(.*):(\d+)$/.exec(site);
  return match ? [match[1], Number(match[2])] : [site, undefined];
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

// ---------------------------------------------------------------------------
// The Impact tab
//
// One question at two moments: "what does my change break?" asked after the
// edit (your uncommitted changes, checked by the compiler, whole project) and
// before it (what a change to the selected action would reach, from the
// graph). Two labelled sections rather than one blended list, because they
// have different scopes and a reader must always know why a line is there.
// ---------------------------------------------------------------------------

const CHANGE_LABELS = {
  removed: 'deleted',
  unexported: 'no longer exported',
  renamed: 'renamed',
  signature: 'signature changed',
  shape: 'shape changed',
  body: 'body changed',
  added: 'new',
};

const VERDICT_LABELS = {
  broken: ['danger', 'breaks'],
  likely: ['warn', 'likely breaks'],
  review: ['muted', 'check'],
};

/**
 * Tab — what is wrong and what could break. Three answers at the top, one per
 * question, each a link to its section; then the sections, the most urgent
 * first: your own breaking edits, the selected action's bugs, what a change
 * to it would reach, and last the long list of the rest of the project.
 */
function renderImpact() {
  const panel = el.panels.impact;
  if (!panel) return;
  panel.innerHTML =
    panelIntro(
      'What is wrong and what could break: the edits you have already made, checked by the ' +
        'compiler across the whole project; the bugs in the selected action; and what a change ' +
        'to it would reach. Read from the source — nothing is run.',
    ) +
    impactOverviewHtml() +
    yourChangesHtml() +
    actionIssuesHtml(2) +
    beforeYouChangeHtml() +
    projectIssuesHtml(4);

  for (const card of panel.querySelectorAll('[data-impact-jump]')) {
    card.addEventListener('click', () => {
      const section = panel.querySelector(`[data-impact-section="${card.dataset.impactJump}"]`);
      if (!section) return;
      section.open = true;
      state.impactOpen[card.dataset.impactJump] = true;
      section.scrollIntoView?.({ behavior: 'smooth', block: 'start' });
    });
  }
  for (const section of panel.querySelectorAll('[data-impact-section]')) {
    section.addEventListener('toggle', () => {
      state.impactOpen[section.dataset.impactSection] = section.open;
    });
  }
  bindProjectIssues(panel);
  bindIssueJumps(panel.querySelector('.impact-issues') ?? panel);
  bindFlowJumps(panel);
  bindStepSelection(panel);
  bindTableFolds(panel);
  panel.querySelector('#impact-recheck')?.addEventListener('click', () => {
    void loadChanged({ fresh: true });
  });
}

/** The three answers, side by side: each says its verdict and opens its section. */
function impactOverviewHtml() {
  const card = (target, label, verdict) =>
    `<button type="button" class="impact-card tone-${escapeHtml(verdict.tone)}" data-impact-jump="${target}">
      <span class="impact-card-label">${escapeHtml(label)}</span>
      <span class="impact-card-value">${escapeHtml(verdict.text)}</span>
      ${verdict.note ? `<span class="impact-card-note">${escapeHtml(verdict.note)}</span>` : ''}
    </button>`;
  return `<div class="impact-overview">
      ${card('impact-yours', 'Your uncommitted changes', changesVerdict())}
      ${card('impact-issues', 'Bugs in this action', issuesVerdict())}
      ${card('impact-before', 'If you change this action', reachVerdict())}
    </div>`;
}

function changesVerdict() {
  const changed = state.changed;
  if (!changed) return { text: 'Reading…', tone: 'neutral' };
  if (changed.error) return { text: 'Needs git', tone: 'muted', note: 'Not a git repository' };
  if (changed.files.length === 0)
    return { text: 'No changes', tone: 'ok', note: 'Since the last commit' };
  const files = plural(changed.files.length, 'changed file');
  const report = state.breakage;
  if (!report || (!report.error && !Array.isArray(report.symbols))) {
    return { text: 'Checking…', tone: 'neutral', note: files };
  }
  if (report.error) return { text: 'Not checked', tone: 'muted', note: files };
  const breaks = breakItems(report).length;
  if (breaks) return { text: `Breaks ${plural(breaks, 'place')}`, tone: 'danger', note: files };
  if (report.totals.review) {
    return { text: `${report.totals.review} to check`, tone: 'warn', note: `Compiles · ${files}` };
  }
  return { text: 'Compiles', tone: 'ok', note: files };
}

function issuesVerdict() {
  const flow = state.selectedFlow;
  if (!flow) return { text: 'Pick an action', tone: 'muted' };
  const data = state.findings;
  if (!data) return { text: 'Reading…', tone: 'neutral' };
  if (data.error) return { text: 'Not checked', tone: 'muted' };
  const mine = issuesFor(flow.id);
  if (mine.length === 0) return { text: 'None found', tone: 'ok' };
  const high = mine.filter((finding) => finding.severity === 'high').length;
  return {
    text: plural(mine.length, 'issue'),
    tone: issueTone(mine),
    note: high ? `${high} high` : undefined,
  };
}

function reachVerdict() {
  if (!state.selectedFlow) return { text: 'Pick an action', tone: 'muted' };
  const insight = state.insight;
  if (!insight) return { text: 'Working out…', tone: 'neutral' };
  if (insight.error || !insight.impact) return { text: 'Not checked', tone: 'muted' };
  const impact = insight.impact;
  const others = impact.featuresAtRisk?.length ?? 0;
  const shared = impact.contestedCollections?.length ?? 0;
  const data = shared ? `Shares data: ${plural(shared, 'collection')}` : undefined;
  if (impact.shared.length === 0) {
    return { text: 'Safe on its own', tone: shared ? 'warn' : 'ok', note: data };
  }
  return {
    text: `${plural(others, 'action')} share code`,
    tone: impact.level === 'high' ? 'danger' : 'warn',
    note: data ?? `Change risk: ${impact.level}`,
  };
}

/** Which section each card describes, so a folded section still says its answer. */
const IMPACT_VERDICTS = {
  'impact-yours': () => changesVerdict(),
  'impact-issues': () => issuesVerdict(),
  'impact-before': () => reachVerdict(),
};

/**
 * One foldable section. It starts open unless `open` says otherwise, and once
 * the reader folds or opens it, that choice holds across actions.
 */
function impactSection(number, title, body, extraClass = '', { open = true } = {}) {
  const key = extraClass.split(' ')[0];
  const shown = state.impactOpen[key] ?? open;
  const verdict = IMPACT_VERDICTS[key]?.();
  return `<details class="impact-section ${extraClass}" data-impact-section="${key}"${shown ? ' open' : ''}>
      <summary class="impact-title">
        <span class="impact-step">${number}</span>
        <span class="impact-title-text">${title}</span>
        ${verdict ? `<span class="chip small ${escapeHtml(verdict.tone)} impact-verdict">${escapeHtml(verdict.text)}</span>` : ''}
      </summary>
      <div class="impact-body">${body}</div>
    </details>`;
}

/** Section 1 — the uncommitted changes. */
function yourChangesHtml() {
  const title = 'Your uncommitted changes';
  const changed = state.changed;
  const recheck = `<button class="button ghost small" id="impact-recheck"${
    state.changedLoading || state.breakageLoading ? ' disabled' : ''
  }>${state.changedLoading || state.breakageLoading ? 'Checking…' : 'Check again'}</button>`;

  if (!changed) {
    return impactSection(1, title, `<p class="muted">Reading your changes…</p>`, 'impact-yours');
  }
  if (changed.error) {
    return impactSection(
      1,
      title,
      `<p class="tab-note">Could not read your changes: ${escapeHtml(changed.error)} — this part needs a git repository.</p>`,
      'impact-yours',
    );
  }
  if (changed.files.length === 0) {
    return impactSection(
      1,
      title,
      `<p class="tab-note">Nothing has changed since the last commit. Edit some code and press <strong>Check again</strong>, ` +
        `or read below what a change to the selected action would break.</p><p>${recheck}</p>`,
      'impact-yours is-clean',
    );
  }

  const report = state.breakage;
  const ready = report && !report.error && Array.isArray(report.symbols);
  let body;
  if (!report || (!report.error && !ready)) {
    body =
      answer(
        'neutral',
        'Checking what your change breaks…',
        `${changed.files.length} changed file${changed.files.length === 1 ? '' : 's'}. ` +
          'Type-checking every place that uses what you changed, before and after your edit.',
      ) + broadHtml(changed);
  } else if (report.error) {
    body =
      answer('neutral', 'Could not check what your change breaks', report.error) +
      broadHtml(changed);
  } else {
    const changedSymbols = report.symbols.filter((symbol) => symbol.change !== 'added');
    const added = report.symbols.filter((symbol) => symbol.change === 'added');
    const breaks = breakItems(report);
    body =
      headlineHtml(report, breaks) +
      (breaks.length ? brokenInAppHtml(breaks) : '') +
      (changedSymbols.length
        ? heading(
            'What you changed',
            'One card per function, component, hook or type you changed: how it changed, and every ' +
              'place that uses it. Click a card to open it.',
          ) +
          changedSymbols
            // The breaks are listed above already; with none, the places to
            // check are the news, so those cards start open.
            .map((symbol) =>
              symbolCard(symbol, {
                open: breaks.length === 0 && symbol.usages.some((u) => u.verdict === 'review'),
              }),
            )
            .join('')
        : '') +
      (added.length
        ? `<p class="tab-note">New, so nothing depends on them yet: ${added
            .map((symbol) => `<code>${escapeHtml(symbol.name)}</code>`)
            .join(', ')}.</p>`
        : '') +
      broadHtml(changed) +
      notesList(report.notes);
  }
  // A report with nothing breaking is long and not news: folded, the card
  // above and the heading still say so.
  const breaking = ready && breakItems(report).length > 0;
  return impactSection(1, title, body + `<p>${recheck}</p>`, 'impact-yours', {
    open: !ready || breaking,
  });
}

/** The one sentence a reader who stops here should leave with. */
function headlineHtml(report, breaks) {
  const pages = new Set(breaks.map((item) => item.page).filter((page) => page.startsWith('/')));
  const features = new Set(breaks.flatMap((item) => item.reach.features.map((f) => f.id)));
  const { totals } = report;
  const how = report.typeChecked
    ? `Checked with the TypeScript compiler — ${report.checkedFiles} file${report.checkedFiles === 1 ? '' : 's'}, ` +
      `before and after your edit, in ${(report.durationMs / 1000).toFixed(1)}s. Only errors your edit introduced are shown.`
    : 'Not type-checked: verdicts come from comparing each use with the new declaration.';

  if (breaks.length > 0) {
    return answer(
      'danger',
      `Your change breaks ${breaks.length} place${breaks.length === 1 ? '' : 's'}` +
        (pages.size ? ` on ${pages.size} page${pages.size === 1 ? '' : 's'}` : '') +
        (features.size ? `, in ${features.size} action${features.size === 1 ? '' : 's'}` : ''),
      `Fix these before you commit. ${how}`,
    );
  }
  if (totals.symbols === 0) {
    return answer('ok', 'Nothing that existed before changed', `${report.summary} ${how}`);
  }
  if (totals.review > 0) {
    return answer(
      'warn',
      `Your change compiles — ${totals.review} place${totals.review === 1 ? '' : 's'} to check`,
      `Nothing breaks, but ${totals.review === 1 ? 'one place relies' : 'these places rely'} on ` +
        `behaviour you changed. Open the cards below to read ${totals.review === 1 ? 'it' : 'them'}. ${how}`,
    );
  }
  return answer('ok', 'Your change compiles, and nothing else uses what you changed', how);
}

/**
 * Every break, flattened: compiler errors at uses, uses that will fail in
 * plain JavaScript, errors inside the changed code and errors elsewhere.
 */
function breakItems(report) {
  const items = [];
  const place = (reach) => reach.pages[0] ?? (reach.apis[0] ? `API ${reach.apis[0]}` : '');
  for (const symbol of report.symbols) {
    for (const usage of symbol.usages) {
      if (usage.verdict === 'review') continue;
      const base = {
        symbol: symbol.name,
        file: usage.file,
        line: usage.line,
        in: usage.in,
        source: usage.source,
        reach: usage.reach,
        page: place(usage.reach),
      };
      if (usage.errors.length) {
        for (const error of usage.errors) {
          items.push({ ...base, text: error.explain ?? error.message, error });
        }
      } else {
        items.push({ ...base, text: usage.reason, likely: true });
      }
    }
    for (const error of symbol.errors) {
      items.push({
        symbol: symbol.name,
        file: error.file,
        line: error.line,
        in: undefined,
        source: error.source,
        reach: error.reach,
        page: place(error.reach),
        text: error.explain ?? error.message,
        error,
        inside: true,
      });
    }
  }
  for (const error of report.otherErrors) {
    items.push({
      symbol: undefined,
      file: error.file,
      line: error.line,
      in: undefined,
      source: error.source,
      reach: error.reach,
      page: place(error.reach),
      text: error.explain ?? error.message,
      error,
      from: error.from,
    });
  }
  return items;
}

/**
 * The breaks, the way the app is used rather than the way the code is laid
 * out: page, then the component on it, then each broken line in plain words.
 */
function brokenInAppHtml(items) {
  const pages = new Map();
  for (const item of items) {
    const key = item.page || 'Not on a traced page';
    if (!pages.has(key)) pages.set(key, []);
    pages.get(key).push(item);
  }
  const ordered = [...pages].sort(
    ([a, x], [b, y]) =>
      y.length - x.length || Number(b.startsWith('/')) - Number(a.startsWith('/')),
  );

  const groups = ordered
    .map(([page, list]) => {
      const features = new Map();
      for (const item of list) for (const f of item.reach.features) features.set(f.id, f);
      const featureList = [...features.values()];
      const components = new Map();
      for (const item of list) {
        const key = item.in?.split(' › ')[0] ?? item.reach.components[0] ?? item.file;
        if (!components.has(key)) components.set(key, []);
        components.get(key).push(item);
      }
      const shownFeatures = featureList
        .slice(0, 4)
        .map(
          (f) =>
            `<button class="link" data-goto-flow="${escapeHtml(f.id)}">${escapeHtml(f.title)}</button>`,
        )
        .join(', ');
      return `<div class="broken-page">
          <div class="broken-page-head">
            <span class="broken-page-name">${page.startsWith('/') ? `<code>${escapeHtml(page)}</code>` : escapeHtml(page)}</span>
            <span class="chip small danger">${list.length} break${list.length === 1 ? '' : 's'}</span>
            ${
              featureList.length
                ? `<span class="broken-page-features">affects ${shownFeatures}${
                    featureList.length > 4
                      ? ` <span class="muted">+${featureList.length - 4} more</span>`
                      : ''
                  }</span>`
                : ''
            }
          </div>
          ${[...components]
            .map(
              ([component, rows]) => `<div class="broken-component">
                <div class="broken-component-name"><code>${escapeHtml(component)}</code></div>
                <ul class="broken-lines">${sameError(rows).map(brokenLineHtml).join('')}</ul>
              </div>`,
            )
            .join('')}
        </div>`;
    })
    .join('');

  return (
    heading(
      'Broken in the app',
      'Page, then the component on it, then each line that no longer works — in plain words, ' +
        'with the compiler’s message underneath.',
    ) + `<div class="broken-in-app">${groups}</div>`
  );
}

/**
 * Seven calls failing for the same reason are one problem, said once, with
 * the seven lines under it — not the same sentence seven times.
 */
function sameError(rows) {
  const groups = new Map();
  for (const item of rows) {
    const key = `${item.error?.code ?? 'likely'}\0${item.text}\0${item.symbol ?? ''}`;
    if (!groups.has(key)) groups.set(key, { ...item, sites: [] });
    groups.get(key).sites.push(item);
  }
  return [...groups.values()];
}

function brokenLineHtml(group) {
  const cause = group.symbol
    ? group.inside
      ? `inside your change to <code>${escapeHtml(group.symbol)}</code>`
      : `uses <code>${escapeHtml(group.symbol)}</code>`
    : group.from?.length
      ? `imports ${group.from.map((file) => `<code>${escapeHtml(file)}</code>`).join(', ')}`
      : '';
  const meta = [
    group.error ? `<span class="chip small danger">${escapeHtml(group.error.code)}</span>` : '',
    group.likely ? `<span class="chip small warn">likely, at runtime</span>` : '',
    cause,
    group.sites.length > 1 ? `<strong>${group.sites.length} places</strong>` : '',
  ]
    .filter(Boolean)
    .join(' · ');
  const compiler =
    group.error && group.error.explain
      ? `<div class="broken-compiler">${escapeHtml(group.error.message.split('\n')[0])}</div>`
      : '';
  const sites = group.sites
    .map(
      (site) =>
        `<li>${fileLink(site.file, site.line)}${
          site.source ? `<pre class="usage-src">${escapeHtml(site.source)}</pre>` : ''
        }</li>`,
    )
    .join('');
  return `<li class="broken-line">
      <div class="broken-text">${richText(group.text)}</div>
      ${compiler}
      <div class="broken-meta">${meta}</div>
      <ul class="broken-sites">${sites}</ul>
    </li>`;
}

function symbolCard(symbol, { open = false } = {}) {
  const counts = { broken: 0, likely: 0, review: 0 };
  for (const usage of symbol.usages) counts[usage.verdict] += 1;
  const failing = counts.broken + counts.likely + symbol.errors.length;
  const tone = failing > 0 ? 'danger' : counts.review > 0 ? 'warn' : 'ok';
  const tally = [
    failing
      ? `<span class="chip small danger">${failing} break${failing === 1 ? '' : 's'}</span>`
      : '',
    counts.review ? `<span class="chip small warn">${counts.review} to check</span>` : '',
    symbol.usages.length === 0 && !symbol.errors.length
      ? `<span class="chip small ok">nothing else uses it</span>`
      : '',
  ].join('');

  const signature =
    symbol.before && symbol.after
      ? `<div class="sig-diff"><div class="sig-before"><span>before</span><code>${escapeHtml(
          symbol.name,
        )}${escapeHtml(symbol.before)}</code></div><div class="sig-after"><span>after</span><code>${escapeHtml(
          symbol.name,
        )}${escapeHtml(symbol.after)}</code></div></div>`
      : '';

  const reach = failing > 0 ? symbol.breaks : symbol.reach;
  const reachTitle = failing > 0 ? 'Where it breaks' : 'Where it is used';

  const usages = symbol.usages.length
    ? renderDocTable({
        columns: ['Where it is used', 'Verdict', 'What happens there', 'In the app'],
        rows: symbol.usages.map((usage) => {
          const [verdictTone, verdictText] = VERDICT_LABELS[usage.verdict];
          return {
            cells: [
              {
                html:
                  fileLink(usage.file, usage.line) +
                  (usage.in
                    ? `<div class="muted small">in <code>${escapeHtml(usage.in)}</code></div>`
                    : '') +
                  (usage.approximate
                    ? `<div class="muted small">line from the committed text</div>`
                    : ''),
              },
              { html: `<span class="chip small ${verdictTone}">${verdictText}</span>` },
              {
                html:
                  (usage.errors.length
                    ? usage.errors.map(errorHtml).join('')
                    : `<div>${richText(usage.reason)}</div>`) +
                  (usage.source ? `<pre class="usage-src">${escapeHtml(usage.source)}</pre>` : ''),
              },
              { html: reachHtml(usage.reach, true) },
            ],
            tone: usage.verdict === 'broken' ? 'error' : usage.verdict === 'likely' ? 'warn' : '',
          };
        }),
      })
    : '';

  return `<details class="break-card tone-${tone}"${open ? ' open' : ''}>
      <summary>
        <code class="break-name">${escapeHtml(symbol.name)}</code>
        <span class="chip small">${escapeHtml(symbol.kind)}</span>
        <span class="chip small ${symbol.change === 'body' ? '' : 'warn'}">${escapeHtml(
          CHANGE_LABELS[symbol.change] ?? symbol.change,
        )}</span>
        ${tally}
        <span class="break-file">${fileLink(symbol.file, symbol.line)}</span>
      </summary>
      <div class="break-body">
        <ul class="break-details">${symbol.details.map((line) => `<li>${richText(line)}</li>`).join('')}</ul>
        ${signature}
        ${reachIsEmpty(reach) ? '' : `<div class="break-reach"><div class="break-reach-title">${reachTitle}</div>${reachHtml(reach, false)}</div>`}
        ${usages}
      </div>
    </details>`;
}

/**
 * The file-level view, folded away: every action that runs through or imports
 * a changed file. Kept because it sees changes the compiler cannot (a config,
 * a query string) — and folded because it over-counts on purpose.
 */
function broadHtml(changed) {
  const files = renderDocTable({
    columns: ['Changed file', 'Status', 'Steps of the app in it'],
    rows: changed.files.map((entry) => ({
      cells: [
        { html: fileLink(entry.file) },
        entry.status ?? 'modified',
        entry.steps > 0
          ? `**${entry.steps}**`
          : entry.importedBy > 0
            ? `none of its own — imported by **${entry.importedBy}** file${entry.importedBy === 1 ? '' : 's'}`
            : '_none — config, styles, or not analysed_',
      ],
      tone: entry.steps === 0 && !entry.importedBy ? 'muted' : '',
    })),
  });
  const actions = changed.features.length
    ? renderDocTable({
        columns: ['Action', 'Changed steps it runs through', 'Tests'],
        rows: changed.features.map((feature) => ({
          cells: [
            flowLinkCell(
              feature.id,
              feature.title + (feature.subtitle ? ` · ${feature.subtitle}` : ''),
            ),
            [
              feature.touchedSteps.map((step) => `\`${step.label}\``).join(', '),
              (feature.through ?? []).length
                ? `through an import of ${feature.through.map((file) => `\`${file}\``).join(', ')}`
                : '',
            ]
              .filter(Boolean)
              .join(' · '),
            feature.testCases === 0 ? 'none' : `${feature.testCases}`,
          ],
        })),
      })
    : '';
  const count = changed.features.length;
  return `<details class="more broad">
      <summary>Files you touched (${changed.files.length}) and every action that imports them (${count}) — the broad view</summary>
      <p class="panel-intro">An over-estimate on purpose: an action is listed if any file it runs through
        changed at all, or imports one that did. Useful for changes the compiler cannot judge — a config,
        a stylesheet, a query — and to see which of these actions have no test.
        ${changed.collections.length ? ` Data the changed code reaches: ${changed.collections.map((c) => `<code>${escapeHtml(c)}</code>`).join(', ')}.` : ''}</p>
      ${files}
      ${actions}
      ${notesList(changed.notes)}
    </details>`;
}

/** Section 2 — what a change to the selected action would reach. */
function beforeYouChangeHtml() {
  const flow = state.selectedFlow;
  const title = flow
    ? `Before you change <em>${escapeHtml(flow.title ?? flow.label)}</em>`
    : 'Before you change an action';
  if (!flow) {
    return impactSection(
      3,
      title,
      `<p class="tab-note">Pick an action on the left to see what else runs through its code.</p>`,
      'impact-before',
    );
  }
  if (!state.insight) {
    return impactSection(
      3,
      title,
      `<p class="muted">Working out what depends on this…</p>`,
      'impact-before',
    );
  }
  if (state.insight.error) {
    return impactSection(
      3,
      title,
      `<p class="error">Could not load this part: ${escapeHtml(String(state.insight.error))}</p>`,
      'impact-before',
    );
  }

  const impact = state.insight.impact;
  const others = impact.featuresAtRisk ?? [];
  const contested = impact.contestedCollections ?? [];

  // The verdict: one sentence about code, one about data.
  const codeAnswer =
    impact.shared.length === 0
      ? answer(
          'ok',
          'Safe to change on its own',
          'No other action runs through this action’s code. ' + (impact.summary ?? ''),
        )
      : answer(
          impact.level === 'high' ? 'danger' : 'warn',
          `${others.length} other action${others.length === 1 ? '' : 's'} share${others.length === 1 ? 's' : ''} code with this one`,
          `Change risk: **${impact.level}**. ${impact.summary ?? ''}`,
        );
  const dataAnswer = contested.length
    ? answer(
        'warn',
        `Shared data: ${contested.map((entry) => entry.collection).join(', ')}`,
        'Other code writes the same collection' +
          (contested.length > 1 ? 's' : '') +
          '. Changing the shape of what this action saves can break it — and there is no compile error to warn you.',
      )
    : '';

  const atRisk = others.length
    ? heading('Actions that would feel it') +
      renderDocTable({
        columns: ['Action', 'Shares'],
        rows: others.map((feature) => ({
          cells: [
            flowLinkCell(
              feature.id,
              feature.title + (feature.subtitle ? ` · ${feature.subtitle}` : ''),
            ),
            `${feature.viaSteps} step${feature.viaSteps > 1 ? 's' : ''}`,
          ],
          tone: 'warn',
        })),
      })
    : '';

  const shared = impact.shared.length
    ? heading('Shared code, most-shared first') +
      renderDocTable({
        columns: ['Step', 'Kind', 'Also used by', 'Warnings'],
        rows: impact.shared.map((step) => ({
          cells: [
            `\`${step.label}\``,
            step.kind.replace('-', ' '),
            {
              html: step.otherFlows
                .map(
                  (other) =>
                    `<button class="pill" data-goto-flow="${escapeHtml(other.id)}">${escapeHtml(other.title)}</button>`,
                )
                .join(' '),
            },
            step.warnings.join(' '),
          ],
          ...(step.file ? { at: { file: step.file, line: step.line } } : {}),
          tone: step.level === 'high' ? 'error' : 'warn',
        })),
      })
    : '';

  const data = contested.length
    ? heading('Shared data') +
      renderDocTable({
        columns: ['Collection', 'Also written by'],
        rows: contested.map((entry) => ({
          cells: [
            `**${entry.collection}**`,
            entry.writers.map((writer) => `\`${writer}\``).join(', '),
          ],
          tone: 'warn',
        })),
      })
    : '';

  const why = (impact.factors ?? []).length
    ? `<details class="more"><summary>Why this risk level</summary><ul class="plain why-list">${impact.factors
        .map((factor) => `<li>${escapeHtml(factor)}</li>`)
        .join('')}</ul></details>`
    : '';

  const exclusive = impact.exclusive.length
    ? `<details class="more"><summary>${impact.exclusive.length} step${
        impact.exclusive.length === 1 ? '' : 's'
      } only this action uses — safe to change</summary>` +
      renderDocTable({
        columns: ['Step', 'Kind'],
        rows: impact.exclusive.map((step) => ({
          cells: [`\`${step.label}\``, (step.kind ?? '').replace('-', ' ')],
          ...(step.file ? { at: { file: step.file, line: step.line } } : {}),
          tone: 'ok',
        })),
      }) +
      `</details>`
    : '';

  return impactSection(
    3,
    title,
    `<p class="tab-note">Planning an edit: which other actions run through the same code or write the same data. ` +
      `Change a shared part and you change them too.</p>` +
      `<div class="answer-row">${codeAnswer}${dataAnswer}</div>` +
      atRisk +
      shared +
      data +
      why +
      exclusive +
      renderInfrastructure(impact),
    'impact-before',
  );
}

function errorHtml(error) {
  return `<div class="break-error">${
    error.explain ? `<div>${richText(error.explain)}</div>` : ''
  }<div class="${error.explain ? 'broken-compiler' : ''}"><span class="chip small danger">${escapeHtml(
    error.code,
  )}</span> ${escapeHtml(error.message.split('\n')[0])}</div></div>`;
}

function reachIsEmpty(reach) {
  return (
    !reach ||
    (!reach.features.length &&
      !reach.pages.length &&
      !reach.components.length &&
      !reach.apis.length &&
      !reach.services.length)
  );
}

/** Feature, page, component, API and service, one labelled row each. */
function reachHtml(reach, compact) {
  if (reachIsEmpty(reach)) return '<span class="muted">not part of any traced feature</span>';
  const limit = compact ? 3 : 12;
  const list = (items, render) => {
    const shown = items.slice(0, limit).map(render).join(', ');
    return items.length > limit
      ? `${shown} <span class="muted">+${items.length - limit} more</span>`
      : shown;
  };
  const rows = [
    [
      'Feature',
      reach.features,
      (f) =>
        `<button class="link" data-goto-flow="${escapeHtml(f.id)}">${escapeHtml(f.title)}</button>`,
    ],
    ['Page', reach.pages, (p) => `<code>${escapeHtml(p)}</code>`],
    ['Component', reach.components, (c) => `<code>${escapeHtml(c)}</code>`],
    ['API', reach.apis, (a) => `<code>${escapeHtml(a)}</code>`],
    ['Service', reach.services, (v) => `<code>${escapeHtml(v)}</code>`],
  ].filter(([, items]) => items.length);
  const via = reach.via?.length
    ? `<div class="muted small">through ${reach.via.map((name) => `<code>${escapeHtml(name)}</code>`).join(' → ')}</div>`
    : '';
  return `<dl class="reach${compact ? ' compact' : ''}">${rows
    .map(([label, items, render]) => `<dt>${label}</dt><dd>${list(items, render)}</dd>`)
    .join('')}</dl>${via}`;
}
