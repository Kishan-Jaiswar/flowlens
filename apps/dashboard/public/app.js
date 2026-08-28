/**
 * FlowLens dashboard.
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
];

const state = {
  flows: [],
  graph: null,
  selectedFlow: null,
  selectedNode: null,
  filter: '',
  includeLocal: false,
};

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
};

async function getJson(url) {
  const response = await fetch(url);
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
  el.docLink.href = `/api/document?flow=${encodeURIComponent(flow.id)}`;
  renderFlowList();
  renderFlowHeader(flow);
  renderGraph(flow);
  renderDetails(null);
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
  for (const collection of flow.collections) {
    chips.push(
      `<span class="chip">${escapeHtml(collection.collection)} · ${collection.access}</span>`,
    );
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

    const nodes = document.createElement('div');
    nodes.className = 'layer-nodes';
    for (const step of group.steps) nodes.appendChild(renderNode(step));
    section.appendChild(nodes);

    el.graph.appendChild(section);

    if (index < groups.length - 1) {
      const connector = document.createElement('div');
      connector.className = 'connector';
      el.graph.appendChild(connector);
    }
  });
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

async function renderDetails(step) {
  if (!step) {
    const flow = state.selectedFlow;
    el.details.innerHTML = flow
      ? `
        <h3>${escapeHtml(flowTitle(flow))}</h3>
        <p class="muted">Select a step to inspect it.</p>
        <h4>Risk factors</h4>
        ${
          flow.risk.reasons.length
            ? `<ul>${flow.risk.reasons.map((reason) => `<li>${escapeHtml(reason)}</li>`).join('')}</ul>`
            : '<p class="muted">None detected.</p>'
        }
        <h4>Frontend state</h4>
        ${
          flow.state.length
            ? `<ul>${flow.state.map((name) => `<li><code>${escapeHtml(name)}</code></li>`).join('')}</ul>`
            : '<p class="muted">None.</p>'
        }`
      : '<p class="muted">Select a feature.</p>';
    return;
  }

  el.details.innerHTML = `
    <h3>${escapeHtml(tileLabel(step))}</h3>
    <dl>
      <dt>kind</dt><dd>${escapeHtml(step.kind)}</dd>
      ${step.meta?.screen ? `<dt>screen</dt><dd>${escapeHtml(step.meta.screen)}</dd>` : ''}
      ${step.meta?.page ? `<dt>route</dt><dd><code>${escapeHtml(step.meta.page)}</code></dd>` : ''}
      ${step.meta?.action ? `<dt>action</dt><dd>${escapeHtml(step.meta.action)}</dd>` : ''}
      <dt>layer</dt><dd>${escapeHtml(step.layer)}</dd>
      <dt>evidence</dt><dd>${escapeHtml(step.evidence)}</dd>
      ${step.file ? `<dt>source</dt><dd>${escapeHtml(step.file)}:${step.line ?? ''}</dd>` : ''}
      ${step.avgMs != null ? `<dt>avg</dt><dd>${step.avgMs}ms</dd>` : ''}
    </dl>
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
    await fetch('/api/rescan', { method: 'POST' });
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
 * scan stores a descriptive title next to it (`Prescription · Submit`) and that
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
