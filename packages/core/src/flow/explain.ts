import { DB_EFFECT_ORDER, type DbEffect } from '../analyzer/mongo.js';
import {
  collectionRelations,
  type CollectionRelation,
  type RelationVia,
} from '../analyzer/relations.js';
import { humanizeName, pageRouteOf } from '../analyzer/screens.js';
import type { FlowGraph } from '../graph/graph.js';
import { ids } from '../graph/ids.js';
import type { Evidence } from '../graph/types.js';
import { flowApis, type ApiCallDetail, type ApiDataAccess, type FlowAftermath } from './api.js';
import { resolveFlows, type FeatureFlow } from './resolve.js';

// ---------------------------------------------------------------------------
// A screen, explained to somebody who does not read code.
//
// Every other view in Flowslens answers a developer's question about one
// action. This one answers a different question — "what is this page, and what
// happens when I use it?" — for a whole screen at once, in sentences a tester,
// a product owner or a developer's first day can read.
//
// It is deliberately complete rather than short. The document a team actually
// needs when somebody asks "what does this page do" has to answer four
// questions, not one:
//
//   1. What can I do here, and what does each control do?
//   2. What does each one read, add, change or delete, and where?
//   3. How do those places relate to each other — where does the data on the
//      screen actually come from?
//   4. What is not safe to assume, and what is this document not telling me?
//
// Written out of the same graph as everything else, with no model in the loop:
// the text below is templates over facts that were read from the source, so it
// says only what the code says, and says the same thing every time. Where a
// fact is missing it is left out rather than smoothed over, because a
// confident sentence nobody can check is worse than a gap.
// ---------------------------------------------------------------------------

/** One entry in the screen picker. */
export interface ScreenIndexEntry {
  /** `Products` — the name the flow list already uses. */
  screen: string;
  /** The route the page serves, when the screen is a page: `/products`. */
  page?: string;
  /** Things a user can do here, page loads included. */
  actions: number;
  /** Distinct endpoints this screen calls. */
  endpoints: number;
  /** Distinct collections the screen ends up touching. */
  collections: number;
  /** Highest risk level among this screen's actions. */
  risk: 'low' | 'medium' | 'high';
  /** Weakest evidence among this screen's actions. */
  evidence: Evidence;
}

/** A technical fact kept out of the prose, for the reader who wants it. */
export interface DocReference {
  label: string;
  file?: string;
  line?: number;
}

/**
 * One thing an action does to stored information.
 *
 * Separate from the story's prose on purpose. The sentences answer "what
 * happens when I click this"; this answers "which table, and what to it" — the
 * question asked by whoever has to change the table, and the one a paragraph
 * is a bad shape for. Both are built from the same facts, so they cannot
 * disagree.
 */
export interface ActionData {
  /** The collection or table itself. */
  collection: string;
  effect: DbEffect;
  /** The calls behind it: `findOne`, `updateOne`. */
  operations: string[];
  /** The request that causes it, when the action makes more than one. */
  endpoint?: string;
  /** The server code that issues it, so there is something to open. */
  by?: string;
  /** Collections the same query brings back alongside this one. */
  alongside: string[];
  /** `Reads a single record from \`customers\`.` */
  sentence: string;
  file?: string;
  line?: number;
}

/** One thing that happens on the screen, start to finish. */
export interface ScreenStory {
  /** The flow id, so the reader can jump to the developer views. */
  id: string;
  /** `Delete a product` — a heading, not an identifier. */
  title: string;
  /** `The user clicks "Delete".` */
  trigger: string;
  /** What the user has to supply for this to work. */
  inputs: string[];
  /** What happens, in order, one plain sentence each. */
  steps: string[];
  /** Which tables it touches and what it does to each. */
  data: ActionData[];
  /** What the user ends up with. */
  result: string[];
  /** Things worth knowing before changing or testing this. */
  cautions: string[];
  /** `About 1.0s, measured over 3 real runs.` */
  timing?: string;
  /** How much of this Flowslens has actually watched happen. */
  evidence: string;
  /** The component this action lives in, in words: `Products view`. */
  component?: string;
  /** Files behind the sentences above. */
  references: DocReference[];
  /** True when the action never leaves the browser. */
  localOnly: boolean;
}

/**
 * One row of the summary table: a control, and what it does.
 *
 * The thing a reader wants before any prose — every button on the screen, in
 * one place, with the tables it touches next to it. Built from the stories
 * rather than beside them, so the table cannot list a control the document
 * then fails to describe.
 */
export interface ControlRow {
  /** The flow id, for jumping to the developer views. */
  id: string;
  /** `“Delete”`, or `When the screen opens`. */
  control: string;
  /** One sentence: what this control does. */
  does: string;
  /** Requests it makes: `DELETE /customers/:id`. */
  requests: string[];
  /** Tables it touches, and what it does to each. */
  tables: Array<{ collection: string; effect: DbEffect }>;
  kind: 'on-open' | 'action' | 'local';
}

/** What the screen stores, in the reader's words. */
export interface DataNote {
  collection: string;
  /** `read, changed and deleted by this screen` */
  summary: string;
  effects: DbEffect[];
  /** `collection` for Mongo, `table` for Prisma — the reader's own word. */
  kind: 'collection' | 'table';
  /** The schema behind it, when the project declares one. */
  model?: string;
  /** The fields the schema declares, for the reader who has to change one. */
  fields: string[];
  /** Actions on this screen that touch it, by title. */
  usedBy: string[];
  /** Collections a record here points at. */
  pointsTo: string[];
  /** Collections whose records point back at this one. */
  pointedToBy: string[];
}

/**
 * One link between two tables, said in words.
 *
 * The relationship a document database never writes down where it matters, and
 * the one thing a page description cannot do without: a screen showing orders
 * is showing customers too, and no amount of reading `orders` reveals it.
 */
export interface RelationNote {
  /** The table holding the key. */
  from: string;
  /** The field that holds it: `customerId`. */
  field: string;
  /** The table the key points at. */
  to: string;
  /** True when one record here points at many there. */
  many: boolean;
  via: RelationVia;
  /** True when a query *on this screen* fetches both together. */
  followed: boolean;
  /**
   * True when some query in the project follows the link, but not one here.
   *
   * Kept apart from {@link followed} because the document is about this
   * screen. "A query on this screen fetches both together" was being said of
   * a join that lives on a different endpoint entirely — true about the
   * project, and a claim about a request this page never makes.
   */
  followedElsewhere: boolean;
  /** `Each record in \`orders\` names one record in \`customers\`…` */
  sentence: string;
  /** How Flowslens knows, said plainly — including when it is a guess. */
  basis: string;
  source?: DocReference;
}

export interface GlossaryEntry {
  term: string;
  meaning: string;
}

/** The whole document for one screen. */
export interface ScreenDoc {
  screen: string;
  page?: string;
  /** Two or three sentences saying what this screen is and what it is for. */
  summary: string[];
  counts: { actions: number; endpoints: number; collections: number; relations: number };
  /** Every control on the screen and what it does, before any prose. */
  controls: ControlRow[];
  /** What happens with no user input at all, as soon as the screen is shown. */
  onOpen: ScreenStory[];
  /** Everything a user can set off deliberately that reaches the server. */
  actions: ScreenStory[];
  /**
   * Actions that never leave the browser.
   *
   * Kept apart rather than mixed in: on a real screen these outnumber the
   * others three to one — every dialog that opens, every filter that changes
   * what is shown — and a reader looking for "what does this page do to my
   * data" should not have to wade through them to find out.
   */
  local: ScreenStory[];
  data: DataNote[];
  /** How the tables link to each other. */
  relations: RelationNote[];
  /** Where the information on this screen comes from, and where it goes. */
  dataFlow: string[];
  /** Screen-wide warnings, above the per-action ones. */
  cautions: string[];
  glossary: GlossaryEntry[];
  /** What this document cannot tell you, stated rather than hidden. */
  limits: string[];
}

export interface ExplainOptions {
  /**
   * Include actions that never reach the backend.
   *
   * On by default, unlike everywhere else in Flowslens: a developer filtering
   * the flow list wants the backend ones, but "open the filters panel" is part
   * of what a user can do here, and a page description that silently omits
   * half the buttons is not a page description.
   */
  includeLocalOnly?: boolean;
}

/** The screen a flow belongs to, with a name for the ones that have none. */
const UNPLACED = 'Elsewhere';

/**
 * Every screen in the project, most substantial first.
 *
 * Ordered by how much happens on the screen rather than alphabetically: the
 * picker's job is to get somebody to the page they are trying to understand,
 * and the busiest page is the likeliest first stop.
 */
export function listScreens(graph: FlowGraph, options: ExplainOptions = {}): ScreenIndexEntry[] {
  const entries: ScreenIndexEntry[] = [];

  for (const [screen, flows] of groupByScreen(graph, options)) {
    const endpoints = new Set<string>();
    const collections = new Set<string>();
    for (const flow of flows) {
      for (const endpoint of flow.endpoints) endpoints.add(endpoint);
      for (const entry of flow.collections) collections.add(entry.collection);
    }

    entries.push({
      screen,
      ...(pageOf(flows) ? { page: pageOf(flows) } : {}),
      actions: flows.length,
      endpoints: endpoints.size,
      collections: collections.size,
      risk: worstRisk(flows),
      evidence: weakestEvidence(flows),
    });
  }

  return entries.sort((a, b) => b.actions - a.actions || a.screen.localeCompare(b.screen, 'en'));
}

/** The full document for one screen, or undefined when there is no such screen. */
export function explainScreen(
  graph: FlowGraph,
  screen: string,
  options: ExplainOptions = {},
): ScreenDoc | undefined {
  const flows = groupByScreen(graph, options).get(screen);
  if (!flows || flows.length === 0) return undefined;

  const built = flows.map((flow) => ({ flow, story: explainFlow(graph, flow) }));
  const onOpen = built.filter((entry) => isPageLoad(entry.flow));
  const deliberate = built.filter((entry) => !isPageLoad(entry.flow));
  const actions = deliberate.filter((entry) => !entry.story.localOnly);
  const local = deliberate.filter((entry) => entry.story.localOnly);

  disambiguate(onOpen);
  disambiguate(actions);
  disambiguate(local);

  const endpoints = new Set(flows.flatMap((flow) => flow.endpoints));
  const data = dataNotes(graph, built);
  /**
   * The links this screen's own queries follow.
   *
   * Taken from the actions rather than from the graph, because the graph knows
   * only that *somewhere* a query joins the two — and this document is about
   * one screen.
   */
  const joinedHere = new Set(
    built.flatMap(({ story }) =>
      story.data.flatMap((row) => row.alongside.map((other) => joinKey(row.collection, other))),
    ),
  );
  const relations = relationNotes(graph, data, joinedHere);
  const page = pageOf(flows);
  const stories = built.map((entry) => entry.story);

  return {
    screen,
    ...(page ? { page } : {}),
    summary: summarize(
      screen,
      page,
      flows,
      onOpen.map((entry) => entry.story),
      actions.map((entry) => entry.story),
      local.map((entry) => entry.story),
      data,
      relations,
    ),
    counts: {
      actions: flows.length,
      endpoints: endpoints.size,
      collections: data.length,
      relations: relations.length,
    },
    controls: controlRows(onOpen, actions, local),
    onOpen: onOpen.map((entry) => entry.story),
    actions: actions.map((entry) => entry.story),
    local: local.map((entry) => entry.story),
    data,
    relations,
    dataFlow: dataFlowSentences(built, data, relations),
    cautions: screenCautions(flows, stories, data),
    glossary: glossaryFor(stories, data, relations),
    limits: limitsOf(flows, relations, data),
  };
}

/**
 * The document as markdown, for pasting into a wiki or a handover note.
 *
 * The same text as the dashboard shows. One renderer would have meant the
 * dashboard parsing markdown to style it; two renderers over one structure
 * means neither medium is the poor relation.
 */
export function renderScreenDocument(doc: ScreenDoc): string {
  const lines: string[] = [];

  lines.push(`# ${doc.screen}`);
  lines.push('');
  if (doc.page) {
    lines.push(`Page address: \`${doc.page}\``);
    lines.push('');
  }
  for (const sentence of doc.summary) {
    lines.push(sentence);
    lines.push('');
  }

  if (doc.controls.length > 0) {
    lines.push('## Everything on this screen, at a glance');
    lines.push('');
    lines.push('| Control | What it does | Requests | Stored information |');
    lines.push('| --- | --- | --- | --- |');
    for (const row of doc.controls) {
      lines.push(
        `| ${cell(row.control)} | ${cell(row.does)} | ${cell(
          row.requests.map((endpoint) => `\`${endpoint}\``).join('<br>') || '—',
        )} | ${cell(
          row.tables
            .map((entry) => `${EFFECT_SUMMARY[entry.effect]} \`${entry.collection}\``)
            .join('<br>') || 'nothing stored',
        )} |`,
      );
    }
    lines.push('');
  }

  if (doc.onOpen.length > 0) {
    lines.push('## When the screen opens');
    lines.push('');
    for (const story of doc.onOpen) pushStory(lines, story);
  }

  if (doc.actions.length > 0) {
    lines.push('## What a user can do here');
    lines.push('');
    for (const story of doc.actions) pushStory(lines, story);
  }

  if (doc.local.length > 0) {
    lines.push('## Things that only change what is shown');
    lines.push('');
    lines.push(
      'These never contact the server and never change anything that is stored. ' +
        'They rearrange, reveal or hide what is already on the screen.',
    );
    lines.push('');
    /**
     * Led by what the user does, not by the heading.
     *
     * For these the heading is the handler's own name (`Order form change`),
     * which is the same for every field on a form. The trigger names the
     * actual control, which is what a reader is looking for.
     */
    for (const story of doc.local) {
      lines.push(`- ${story.trigger} ${story.steps.join(' ')}`.trimEnd());
    }
    lines.push('');
  }

  if (doc.data.length > 0) {
    lines.push('## The information this screen works with');
    lines.push('');
    lines.push('| Where | What this screen does with it | Used by | Fields |');
    lines.push('| --- | --- | --- | --- |');
    for (const note of doc.data) {
      lines.push(
        `| \`${note.collection}\`${note.model ? `<br>_${note.model}_` : ''} | ${cell(
          note.summary,
        )} | ${cell(note.usedBy.join('<br>') || '—')} | ${cell(
          note.fields.length > 0
            ? note.fields.map((field) => `\`${field}\``).join(', ')
            : 'not declared in code',
        )} |`,
      );
    }
    lines.push('');
  }

  if (doc.relations.length > 0 || doc.dataFlow.length > 0) {
    lines.push('## How the information fits together');
    lines.push('');
    for (const sentence of doc.dataFlow) {
      lines.push(`- ${sentence}`);
    }
    if (doc.dataFlow.length > 0) lines.push('');
    if (doc.relations.length > 0) {
      lines.push('| Link | Meaning | How this is known |');
      lines.push('| --- | --- | --- |');
      for (const relation of doc.relations) {
        const shape = relation.many ? 'one to many' : 'one to one';
        const together = relation.followed ? ', fetched together' : '';
        lines.push(
          `| \`${relation.from}.${relation.field}\` → \`${relation.to}\`<br>_${shape}${together}_ | ` +
            `${cell(relation.sentence)} | ${cell(relation.basis)} |`,
        );
      }
      lines.push('');
    }
  }

  if (doc.cautions.length > 0) {
    lines.push('## Worth knowing');
    lines.push('');
    for (const caution of doc.cautions) lines.push(`- ${caution}`);
    lines.push('');
  }

  if (doc.glossary.length > 0) {
    lines.push('## Words used above');
    lines.push('');
    for (const entry of doc.glossary) lines.push(`- **${entry.term}** — ${entry.meaning}`);
    lines.push('');
  }

  if (doc.limits.length > 0) {
    lines.push('## What this document does not cover');
    lines.push('');
    for (const limit of doc.limits) lines.push(`- ${limit}`);
    lines.push('');
  }

  return lines.join('\n');
}

function pushStory(lines: string[], story: ScreenStory): void {
  lines.push(`### ${story.title}`);
  lines.push('');
  lines.push(story.trigger);
  lines.push('');
  if (story.inputs.length > 0) {
    lines.push(`Needs from the user: ${story.inputs.join(', ')}.`);
    lines.push('');
  }
  story.steps.forEach((step, index) => lines.push(`${index + 1}. ${step}`));
  lines.push('');
  if (story.data.length > 0) {
    lines.push('| Where | What happens to it | Which call |');
    lines.push('| --- | --- | --- |');
    for (const entry of story.data) {
      lines.push(
        `| \`${entry.collection}\` | ${cell(entry.sentence)} | ${cell(
          entry.operations.map((operation) => `\`${operation}\``).join(', '),
        )} |`,
      );
    }
    lines.push('');
  }
  for (const result of story.result) lines.push(`- ${result}`);
  if (story.result.length > 0) lines.push('');
  if (story.timing) {
    lines.push(`_${story.timing}_`);
    lines.push('');
  }
  for (const caution of story.cautions) lines.push(`> ${caution}`);
  if (story.cautions.length > 0) lines.push('');
  lines.push(`_${story.evidence}_`);
  lines.push('');
  if (story.references.length > 0) {
    lines.push(
      `<details><summary>Where this lives in the code</summary>\n\n${story.references
        .map((ref) => `- ${ref.label}${ref.file ? ` — \`${reference(ref)}\`` : ''}`)
        .join('\n')}\n\n</details>`,
    );
    lines.push('');
  }
}

/** A table cell: the pipe is the column separator, so it cannot survive inside one. */
function cell(text: string): string {
  return text.replace(/\|/g, '\\|').replace(/\n+/g, ' ');
}

// ---------------------------------------------------------------------------
// One action, told as a story
// ---------------------------------------------------------------------------

/**
 * One action, as a story.
 *
 * `flowApis` carries its own `notes` and `warnings`, and they are deliberately
 * not repeated here: they are written for a developer reading the APIs tab
 * ("a rejected request will surface as an unhandled rejection"), and a
 * document that mixes those with plain sentences reads as neither. Anything
 * from them that a non-developer can act on is restated below in their words.
 */
function explainFlow(graph: FlowGraph, flow: FeatureFlow): ScreenStory {
  const apis = flowApis(graph, flow);
  const steps: string[] = [];
  const cautions: string[] = [];
  const references: DocReference[] = [];

  if (flow.source) {
    references.push({
      label: 'The screen this belongs to',
      file: flow.source.file,
      line: flow.source.line,
    });
  }

  for (const call of apis.calls) {
    steps.push(...requestSteps(call, cautions, references));
  }

  if (apis.calls.length === 0) {
    steps.push(...localSteps(flow));
  }

  return {
    id: flow.id,
    title: storyTitle(flow),
    trigger: triggerSentence(flow),
    inputs: inputSentences(apis.calls),
    steps,
    data: actionData(apis.calls),
    result: resultSentences(apis.aftermath),
    cautions: [...cautions, ...aftermathCautions(apis.aftermath, flow), ...riskCautions(flow)],
    ...(timingSentence(flow) ? { timing: timingSentence(flow) } : {}),
    evidence: evidenceSentence(flow.evidence),
    ...(componentName(flow) ? { component: componentName(flow) as string } : {}),
    references,
    localOnly: !flow.hitsBackend,
  };
}

/**
 * What one request does, as two to five sentences.
 *
 * The request, what the server does with it, and what it touches in storage —
 * in that order, because that is the order a reader asks about them.
 */
function requestSteps(
  call: ApiCallDetail,
  cautions: string[],
  references: DocReference[],
): string[] {
  const steps: string[] = [];
  const sending = describePayload(call);
  const when = call.order > 1 && call.when ? ` (${call.when})` : '';

  steps.push(`The browser ${requestVerb(call.method)} — \`${call.endpoint}\`${sending}${when}.`);

  if (!call.matched) {
    cautions.push(
      `Nothing in this project answers \`${call.endpoint}\`. Either it is served by ` +
        'another application, or the request is broken.',
    );
    return steps;
  }

  if (call.middleware.length > 0) {
    steps.push(
      `Before anything else, the server checks ${humanList(
        call.middleware.map((entry) => `${plainName(entry.name)} (${checkRole(entry.role)})`),
      )}. A request that fails the check goes no further.`,
    );
  }

  if (call.dto) {
    steps.push(
      `The server checks the information it was sent is complete and the right ` +
        `shape${call.dto.fields.length > 0 ? `: ${humanList(call.dto.fields.map((f) => f.name))}` : ''}.`,
    );
  }

  const data = dataSentences(call.data);
  if (data.length > 0) steps.push(...data);

  const joined = joinSentence(call.data);
  if (joined) steps.push(joined);

  if (call.effects.length > 0) {
    steps.push(
      `The request also sets off work outside this application — ${humanList(
        call.effects.map((effect) => plainName(effect.label)),
      )}. What happens after that is not part of this project.`,
    );
  }

  if (call.response.landsInState.length > 0) {
    steps.push(
      `What comes back is held by the screen as ${humanList(
        call.response.landsInState.map((state) => `\`${state}\``),
      )}, which is what you see on the page.`,
    );
  }

  if (call.response.statusCodes.length > 0) {
    steps.push(
      `In real runs this request has answered ${humanList(
        call.response.statusCodes.map((code) => `${code} (${statusMeaning(code)})`),
      )}.`,
    );
  }

  if (call.route?.file) {
    references.push({
      label: `Server code for ${call.endpoint}`,
      file: call.route.file,
      ...(call.route.line ? { line: call.route.line } : {}),
    });
  }
  for (const handler of call.handlers) {
    if (!handler.file) continue;
    references.push({
      label: `${plainName(handler.label)} (${handler.kind})`,
      file: handler.file,
      ...(handler.line ? { line: handler.line } : {}),
    });
  }
  for (const access of call.data) {
    if (!access.file) continue;
    references.push({
      label: `The ${access.operation} on ${access.collection}`,
      file: access.file,
      ...(access.line ? { line: access.line } : {}),
    });
  }

  if (call.contract && call.contract.unexpected.length > 0) {
    cautions.push(
      `The screen sends ${humanList(call.contract.unexpected.map((field) => quote(field.name)))}, ` +
        'which the server does not say it accepts. It may be ignored.',
    );
  }
  if (call.contract && call.contract.missing.length > 0) {
    cautions.push(
      `The server expects ${humanList(call.contract.missing.map((field) => quote(field.name)))}, ` +
        'which the screen never sends.',
    );
  }

  return steps;
}

/**
 * What an action that never leaves the browser actually does.
 *
 * "Nothing is sent to the server" on its own is a non-answer, and these are
 * most of the controls on a real screen. The state the handler writes is the
 * fact available, so it is the fact given: a reader who knows that "Filter"
 * changes `statusFilter` knows what to look at, which is more than they had.
 */
function localSteps(flow: FeatureFlow): string[] {
  const written = [
    ...new Set(
      flow.steps.flatMap((step) =>
        step.kind === 'handler' || step.kind === 'hook' || step.kind === 'ui-action'
          ? (step.detail?.statesWritten ?? [])
          : [],
      ),
    ),
  ].sort();

  const steps: string[] = [];
  if (written.length > 0) {
    steps.push(
      `It changes what the screen is holding — ${humanList(written.map(quote))} — and the page ` +
        'redraws to match.',
    );
  }
  steps.push(
    'Nothing is sent to the server and nothing that is stored changes, so this can be ' +
      'used freely without consequence.',
  );
  return steps;
}

/** What the user has to supply, gathered across every request the action makes. */
function inputSentences(calls: ApiCallDetail[]): string[] {
  const inputs = new Set<string>();
  for (const call of calls) {
    for (const field of call.payload) {
      /**
       * The source only when it differs from the name.
       *
       * Most forms name the state after the field it fills, so
       * "`note` (from `note`)" is the common case and it is noise.
       */
      const named = field.from && field.from !== field.name;
      inputs.add(
        named ? `${quote(field.name)} (from ${quote(field.from as string)})` : quote(field.name),
      );
    }
    for (const key of call.queryKeys) inputs.add(`${quote(key)} (to narrow the list)`);
  }
  return [...inputs];
}

/**
 * Every table this action touches, one row per table and effect.
 *
 * Grouped so that two `findOne`s against the same collection are one row with
 * two calls rather than two rows saying the same thing, and split by effect so
 * a collection that is read and then updated reads as the two different things
 * it is.
 */
function actionData(calls: ApiCallDetail[]): ActionData[] {
  const rows = new Map<string, ActionData>();

  for (const call of calls) {
    for (const access of call.data) {
      const effect = normalizeEffect(access.effect);
      const key = `${access.collection}:${effect}`;
      const existing = rows.get(key);
      if (existing) {
        if (access.operation && !existing.operations.includes(access.operation)) {
          existing.operations.push(access.operation);
        }
        for (const joined of access.joins ?? []) {
          if (!existing.alongside.includes(joined)) existing.alongside.push(joined);
        }
        continue;
      }
      rows.set(key, {
        collection: access.collection,
        effect,
        operations: access.operation ? [access.operation] : [],
        ...(calls.length > 1 ? { endpoint: call.endpoint } : {}),
        ...(access.by ? { by: access.by } : {}),
        alongside: [...(access.joins ?? [])],
        sentence: '',
        ...(access.file ? { file: access.file } : {}),
        ...(access.line ? { line: access.line } : {}),
      });
    }
  }

  const ordered = [...rows.values()].sort(
    (a, b) =>
      DB_EFFECT_ORDER.indexOf(a.effect) - DB_EFFECT_ORDER.indexOf(b.effect) ||
      a.collection.localeCompare(b.collection, 'en'),
  );
  for (const row of ordered) {
    row.operations.sort((a, b) => a.localeCompare(b, 'en'));
    row.alongside.sort((a, b) => a.localeCompare(b, 'en'));
    row.sentence = dataRowSentence(row);
  }
  return ordered;
}

/**
 * `Reads from \`customers\` — a single record, by its id.`
 *
 * The place first and the amount second, not the other way round. "Reads a
 * count of the matching records, not the records themselves, from `products`"
 * is the same facts in the order that makes them unreadable: the reader is
 * scanning for the table name, and every one of these sentences sits in a row
 * next to it.
 */
function dataRowSentence(row: ActionData): string {
  const scope = operationScope(row.operations);
  const preposition = EFFECT_PREPOSITION[row.effect];
  let sentence = `${EFFECT_VERB[row.effect]} ${preposition} ${quote(row.collection)}`;
  sentence += scope ? ` — ${scope}.` : '.';

  if (row.alongside.length > 0) {
    sentence += ` The matching ${humanList(row.alongside.map(quote))} ${
      row.alongside.length === 1 ? 'record comes' : 'records come'
    } back in the same query.`;
  }
  if (row.effect === 'delete') sentence += ' There is no undo in the code.';
  if (row.effect === 'write') {
    sentence += ' Whether that adds a record or changes one depends on what is already there.';
  }
  return sentence;
}

const EFFECT_VERB: Record<DbEffect, string> = {
  read: 'Reads',
  create: 'Adds',
  update: 'Changes',
  delete: 'Deletes',
  write: 'Saves',
};

/**
 * The same five effects in the active voice, for a row about a control.
 *
 * "Read from `customers`" describes the collection; "Reads from `customers`"
 * describes the button, and the button is what the row is about.
 */
const EFFECT_ACTIVE: Record<DbEffect, string> = {
  read: 'reads from',
  create: 'adds to',
  update: 'changes',
  delete: 'deletes from',
  write: 'saves to',
};

const EFFECT_PREPOSITION: Record<DbEffect, string> = {
  read: 'from',
  create: 'to',
  update: 'in',
  delete: 'from',
  write: 'to',
};

/**
 * How much the query touches, from the call's own name.
 *
 * `findOne` and `find` are one word apart and mean "a record" versus "the
 * whole list", which is the difference between a detail page and a report. The
 * name is the only place that difference is written down.
 */
const OPERATION_SCOPE: Record<string, string> = {
  find: 'every record that matches',
  findMany: 'every record that matches',
  findOne: 'a single record',
  findById: 'a single record, by its id',
  findUnique: 'a single record, by its id',
  findUniqueOrThrow: 'a single record, by its id',
  findFirst: 'the first record that matches',
  findFirstOrThrow: 'the first record that matches',
  countDocuments: 'a count of the matching records, not the records themselves',
  count: 'a count of the matching records, not the records themselves',
  estimatedDocumentCount: 'a rough count of all the records',
  distinct: 'the different values of one field',
  aggregate: 'a summary worked out across many records',
  groupBy: 'a summary grouped across many records',
  exists: 'only whether a matching record exists',
  create: 'one new record',
  insertOne: 'one new record',
  insertMany: 'several new records at once',
  createMany: 'several new records at once',
  createManyAndReturn: 'several new records at once',
  updateOne: 'one record',
  update: 'one record',
  replaceOne: 'one record, replaced whole',
  findOneAndUpdate: 'one record, and reads it back',
  findByIdAndUpdate: 'one record, found by its id',
  findOneAndReplace: 'one record, replaced whole',
  updateMany: 'every record that matches',
  updateManyAndReturn: 'every record that matches',
  deleteOne: 'one record',
  delete: 'one record',
  remove: 'one record',
  findOneAndDelete: 'one record, and reads it back first',
  findByIdAndDelete: 'one record, found by its id',
  findByIdAndRemove: 'one record, found by its id',
  deleteMany: 'every record that matches',
  save: 'one record',
  bulkWrite: 'several records in one go',
  upsert: 'one record',
};

/** Empty when no call name is recognised: better a short sentence than a vague one. */
function operationScope(operations: string[]): string {
  const described = operations.map((operation) => OPERATION_SCOPE[operation]).filter(Boolean);
  if (described.length === 0) return '';
  return humanList(described as string[]);
}

/** One sentence per collection the request touches, grouped by what it does. */
function dataSentences(accesses: ApiDataAccess[]): string[] {
  const byEffect = new Map<string, Set<string>>();
  for (const access of accesses) {
    const effect = normalizeEffect(access.effect);
    const collections = byEffect.get(effect) ?? new Set<string>();
    collections.add(access.collection);
    byEffect.set(effect, collections);
  }

  const sentences: string[] = [];
  for (const effect of DB_EFFECT_ORDER) {
    const collections = byEffect.get(effect);
    if (!collections || collections.size === 0) continue;
    sentences.push(
      `The server ${EFFECT_PHRASE[effect](humanList([...collections].sort().map(quote)))}.`,
    );
  }
  return sentences;
}

/**
 * The step that says two tables arrived together.
 *
 * Worth its own sentence rather than a clause on the read above, because it is
 * the answer to "where did the customer name on this row come from" — and a
 * reader who does not get it told here concludes there is a second request
 * somewhere that they will not find.
 */
function joinSentence(accesses: ApiDataAccess[]): string | undefined {
  const joined = new Set<string>();
  for (const access of accesses) {
    for (const collection of access.joins ?? []) joined.add(collection);
  }
  if (joined.size === 0) return undefined;
  const names = [...joined].sort().map(quote);
  return (
    `In the same query the server also brings back the linked ${humanList(names)} ` +
    `${joined.size === 1 ? 'record' : 'records'}, so the two arrive together rather than ` +
    'as separate requests.'
  );
}

/** What each kind of database work means to somebody who has never seen one. */
const EFFECT_PHRASE: Record<DbEffect, (targets: string) => string> = {
  read: (targets) => `looks up what is stored in ${targets}`,
  create: (targets) => `stores something new in ${targets}`,
  update: (targets) => `changes what is already stored in ${targets}`,
  delete: (targets) => `permanently removes stored information from ${targets}`,
  write: (targets) =>
    `saves information to ${targets} — either adding or changing, depending on ` +
    'what is already there',
};

function resultSentences(aftermath: FlowAftermath): string[] {
  const results: string[] = [];

  for (const target of aftermath.navigatesTo) {
    results.push(`The user is taken to \`${target}\`.`);
  }
  for (const entry of aftermath.invalidates) {
    /**
     * Name the requests, not the cache key.
     *
     * `queryKeys.products.all` is the app's own name for a cache entry —
     * meaningless outside the code. The requests it causes are the part a
     * reader can recognise, and the part a tester has to watch for.
     */
    if (entry.refetches.length > 0) {
      results.push(
        `Everything else on screen showing this data is fetched again: ` +
          `${humanList(entry.refetches.map(quote))}.`,
      );
    } else {
      results.push(`Anything else showing ${quote(entry.key)} is marked out of date and reloaded.`);
    }
  }
  if (aftermath.notifies.length > 0) {
    // `toast()` is the call, not the message: printing it tells a reader who
    // does not read code nothing they did not already assume.
    const worded = aftermath.notifies.filter((entry) => !/^\w+\(\)?$/.test(entry.trim()));
    results.push(
      worded.length > 0
        ? `The user is told what happened: ${humanList(worded.map(quote))}.`
        : 'A short message confirms it to the user.',
    );
  }
  if (aftermath.errorStates.length > 0) {
    results.push('If it fails, the screen shows the reason rather than failing silently.');
  }
  return results;
}

/**
 * The "nothing handles a failure" warning, kept rare enough to mean something.
 *
 * Most read-only actions do not catch anything, and a document that says so
 * under every heading is a document whose warnings get skimmed. It is worth
 * saying when the action changes stored information and shows the user
 * nothing either way: that is the case where a failed save looks exactly like
 * a successful one.
 */
function aftermathCautions(aftermath: FlowAftermath, flow: FeatureFlow): string[] {
  if (aftermath.handlesErrors) return [];
  if (aftermath.errorStates.length > 0 || aftermath.notifies.length > 0) return [];
  if (!flow.collections.some((entry) => entry.effect !== 'read')) return [];
  return [
    'Nothing here deals with a failure, and the screen says nothing either way. ' +
      'If the save does not work, it will look exactly like one that did.',
  ];
}

/**
 * The risk factors, kept in the reader's language.
 *
 * The flow's own reasons are written for a developer reading a risk score
 * (`performs a destructive operation (products.deleteOne)`). The ones worth
 * repeating here are the ones a non-developer can act on, so destructive work
 * and a broken contract are spelled out and the rest are left to the Breaks
 * tab, which exists for exactly that audience.
 */
function riskCautions(flow: FeatureFlow): string[] {
  const cautions: string[] = [];
  const deletes = flow.collections.filter((entry) => entry.effect === 'delete');
  if (deletes.length > 0) {
    cautions.push(
      `This permanently removes information from ${humanList(
        deletes.map((entry) => quote(entry.collection)),
      )}. There is no undo in the code.`,
    );
  }
  if (flow.risk.level === 'high') {
    /**
     * Separated by semicolons, not "and".
     *
     * The reasons are phrases that contain their own commas ("writes to 2
     * collections: auditlogs, orders"), and joining those with commas
     * produces one long list in which no reason has a beginning or an end.
     */
    cautions.push(
      'Flowslens rates this one of the riskier actions in the project — ' +
        `${flow.risk.reasons.join('; ')}.`,
    );
  }
  return cautions;
}

function timingSentence(flow: FeatureFlow): string | undefined {
  if (flow.totalMs === undefined) return undefined;
  const runs = Math.max(
    0,
    ...flow.steps.map((step) => (typeof step.observations === 'number' ? step.observations : 0)),
  );
  const measured = runs > 0 ? `, measured over ${runs} real ${runs === 1 ? 'run' : 'runs'}` : '';
  return `Takes about ${readableDuration(flow.totalMs)} from start to finish${measured}.`;
}

const EVIDENCE_SENTENCE: Record<Evidence, string> = {
  static:
    'Read from the source code. Flowslens has not yet watched this happen, so the ' +
    'steps are what the code says will happen.',
  runtime:
    'Seen happening in a real run, but not found in the source code — it may go ' +
    'through code Flowslens cannot read.',
  confirmed:
    'Confirmed: the source code says this happens, and Flowslens has watched it ' +
    'happen in a real run.',
};

function evidenceSentence(evidence: Evidence): string {
  return EVIDENCE_SENTENCE[evidence];
}

// ---------------------------------------------------------------------------
// The screen around the actions
// ---------------------------------------------------------------------------

/** Every control, in the order the document describes them. */
function controlRows(
  onOpen: Array<{ flow: FeatureFlow; story: ScreenStory }>,
  actions: Array<{ flow: FeatureFlow; story: ScreenStory }>,
  local: Array<{ flow: FeatureFlow; story: ScreenStory }>,
): ControlRow[] {
  const row = (
    entry: { flow: FeatureFlow; story: ScreenStory },
    kind: ControlRow['kind'],
  ): ControlRow => ({
    id: entry.story.id,
    control: kind === 'on-open' ? entry.story.title : controlName(entry.flow),
    does: summaryLine(entry.story, kind),
    requests: [...new Set(entry.flow.endpoints)],
    tables: entry.story.data.map((data) => ({ collection: data.collection, effect: data.effect })),
    kind,
  });

  return [
    ...onOpen.map((entry) => row(entry, 'on-open')),
    ...actions.map((entry) => row(entry, 'action')),
    ...local.map((entry) => row(entry, 'local')),
  ];
}

/**
 * One line for the summary table.
 *
 * Built from what the action does to storage rather than from its first step,
 * because that is what a reader scanning the table is looking for — "which of
 * these buttons changes something" is the question the table exists to answer.
 */
function summaryLine(story: ScreenStory, kind: ControlRow['kind']): string {
  if (kind === 'local') return 'Only changes what is shown; nothing is sent or saved.';

  const byEffect = new Map<DbEffect, string[]>();
  for (const entry of story.data) {
    byEffect.set(entry.effect, [...(byEffect.get(entry.effect) ?? []), entry.collection]);
  }

  const parts: string[] = [];
  for (const effect of DB_EFFECT_ORDER) {
    const collections = byEffect.get(effect);
    if (!collections) continue;
    parts.push(
      `${EFFECT_ACTIVE[effect]} ${humanList([...new Set(collections)].sort().map(quote))}`,
    );
  }

  if (parts.length === 0) {
    return story.data.length === 0 && story.steps.length > 0
      ? 'Contacts the server, but nothing Flowslens can see is stored or read.'
      : 'Nothing stored is read or changed.';
  }
  return capitalize(`${parts.join('; ')}.`);
}

/**
 * The opening paragraphs.
 *
 * Plain sentences with no markup beyond backticks: the markdown renderer and
 * the dashboard both read these, and anything markdown-only would show up as
 * stray asterisks in the browser.
 */
function summarize(
  screen: string,
  page: string | undefined,
  flows: FeatureFlow[],
  onOpen: ScreenStory[],
  actions: ScreenStory[],
  local: ScreenStory[],
  data: DataNote[],
  relations: RelationNote[],
): string[] {
  const sentences: string[] = [];

  const where = page ? `the page at \`${page}\`` : 'part of the app';
  sentences.push(
    `${screen} is ${where}. There ${actions.length === 1 ? 'is' : 'are'} ` +
      `${countWord(actions.length)} ${actions.length === 1 ? 'thing' : 'things'} a user can do ` +
      `here${onOpen.length > 0 ? ', plus what the screen does for itself when it opens' : ''}.`,
  );

  if (data.length > 0) {
    sentences.push(
      `It works with ${humanList(data.map((note) => quote(note.collection)))} — the ` +
        'information the app has stored.',
    );
  } else {
    sentences.push('It stores nothing: everything on this screen happens in the browser.');
  }

  /**
   * What the screen *changes*, said in the opening.
   *
   * The single most important fact about a page, and the one a reader should
   * not have to find in a table: a screen that only reads is safe to click
   * around, and a screen that deletes is not.
   */
  const changing = data.filter((note) => note.effects.some((effect) => effect !== 'read'));
  const deleting = data.filter((note) => note.effects.includes('delete'));
  if (data.length > 0 && changing.length === 0) {
    sentences.push('Nothing on this screen changes stored information — it only reads.');
  } else if (changing.length > 0) {
    sentences.push(
      `It changes what is stored in ${humanList(changing.map((note) => quote(note.collection)))}` +
        `${
          deleting.length > 0
            ? `, and permanently deletes from ${humanList(deleting.map((note) => quote(note.collection)))}`
            : ''
        }.`,
    );
  }

  if (relations.length > 0) {
    sentences.push(
      `The information here is spread across more than one place and joined up by ` +
        `${countWord(relations.length)} ${relations.length === 1 ? 'link' : 'links'} — see ` +
        '"How the information fits together" below.',
    );
  }

  if (local.length > 0) {
    sentences.push(
      capitalize(
        `${countWord(local.length)} further ${local.length === 1 ? 'control' : 'controls'} `,
      ) +
        `only ${local.length === 1 ? 'changes' : 'change'} what is shown — opening a dialog, ` +
        'filtering a list — without contacting the server.',
    );
  }

  const confirmed = flows.filter((flow) => flow.evidence === 'confirmed').length;
  if (confirmed > 0) {
    sentences.push(
      capitalize(`${countWord(confirmed)} of the actions below`) +
        ` ${confirmed === 1 ? 'has' : 'have'} been ` +
        'watched running for real; the rest are read from the source code.',
    );
  }

  return sentences;
}

function dataNotes(
  graph: FlowGraph,
  built: Array<{ flow: FeatureFlow; story: ScreenStory }>,
): DataNote[] {
  const byCollection = new Map<string, Set<DbEffect>>();
  const usedBy = new Map<string, Set<string>>();

  for (const { flow, story } of built) {
    for (const entry of flow.collections) {
      const effects = byCollection.get(entry.collection) ?? new Set<DbEffect>();
      effects.add(entry.effect);
      byCollection.set(entry.collection, effects);
      const users = usedBy.get(entry.collection) ?? new Set<string>();
      users.add(story.title);
      usedBy.set(entry.collection, users);
    }
  }

  const relations = collectionRelations(graph);

  return [...byCollection.entries()]
    .sort((a, b) => a[0].localeCompare(b[0], 'en'))
    .map(([collection, effects]) => {
      const ordered = DB_EFFECT_ORDER.filter((effect) => effects.has(effect));
      const schema = schemaOf(graph, collection);
      return {
        collection,
        effects: [...ordered],
        summary: capitalize(
          `${humanList(ordered.map((effect) => EFFECT_SUMMARY[effect]))} by this screen.`,
        ),
        kind: schema.database === 'prisma' ? ('table' as const) : ('collection' as const),
        ...(schema.model ? { model: schema.model } : {}),
        fields: schema.fields,
        usedBy: [...(usedBy.get(collection) ?? [])].sort((a, b) => a.localeCompare(b, 'en')),
        pointsTo: [
          ...new Set(relations.filter((r) => r.from === collection).map((r) => r.to)),
        ].sort((a, b) => a.localeCompare(b, 'en')),
        pointedToBy: [
          ...new Set(relations.filter((r) => r.to === collection).map((r) => r.from)),
        ].sort((a, b) => a.localeCompare(b, 'en')),
      };
    });
}

/** How a collection's use reads in a list: "read from, changed and deleted from". */
const EFFECT_SUMMARY: Record<DbEffect, string> = {
  read: 'read from',
  create: 'added to',
  update: 'changed',
  delete: 'deleted from',
  write: 'saved to',
};

/**
 * The schema behind a collection: its model, its fields and which store it is.
 *
 * Read from the graph rather than from the flow, because a flow only knows the
 * schemas on its own path — and the reader of this section wants the shape of
 * the thing, not the shape of the part one button touched.
 */
function schemaOf(
  graph: FlowGraph,
  collection: string,
): { model?: string; fields: string[]; database?: string } {
  const node = graph.node(ids.collection(collection));
  const database = typeof node?.meta?.['database'] === 'string' ? node.meta['database'] : undefined;
  const model = graph
    .predecessors(ids.collection(collection), ['defines'])
    .find((candidate) => candidate.kind === 'model');
  if (!model) return { fields: [], ...(database ? { database } : {}) };

  const fields = graph
    .successors(model.id, ['defines'])
    .filter((candidate) => candidate.kind === 'field' && candidate.meta?.['fromQuery'] !== true)
    .map((candidate) => candidate.label)
    .sort((a, b) => a.localeCompare(b, 'en'));

  return { model: model.label, fields, ...(database ? { database } : {}) };
}

/**
 * The links between the tables this screen uses, said in words.
 *
 * Restricted to links touching the screen's own collections, and ordered so
 * the ones a query actually follows come first: those are the ones that
 * explain what is on the page, and the rest are context.
 */
function relationNotes(
  graph: FlowGraph,
  data: DataNote[],
  joinedHere: ReadonlySet<string>,
): RelationNote[] {
  const mine = new Set(data.map((note) => note.collection));
  if (mine.size === 0) return [];

  const notes: RelationNote[] = [];
  for (const relation of collectionRelations(graph)) {
    if (!mine.has(relation.from) && !mine.has(relation.to)) continue;
    const here = joinedHere.has(joinKey(relation.from, relation.to));
    notes.push({
      from: relation.from,
      field: relation.field,
      to: relation.to,
      many: relation.many,
      via: relation.via,
      followed: here,
      followedElsewhere: relation.followed && !here,
      sentence: relationSentence(relation, mine, here),
      basis: RELATION_BASIS[relation.via],
      ...(relation.source
        ? {
            source: {
              label: `Where ${relation.from}.${relation.field} is declared`,
              file: relation.source.file,
              line: relation.source.line,
            },
          }
        : {}),
    });
  }

  return notes.sort(
    (a, b) =>
      Number(b.followed) - Number(a.followed) ||
      RELATION_RANK[a.via] - RELATION_RANK[b.via] ||
      a.from.localeCompare(b.from, 'en') ||
      a.field.localeCompare(b.field, 'en'),
  );
}

/**
 * One link, and what it means *for this screen*.
 *
 * The second half depends on which end of the link the screen is standing at,
 * and getting that wrong is the worst kind of mistake this document can make —
 * a screen that only touches `customers` was being told that the orders
 * pointing at them are "read on this screen, in separate requests", which is
 * a confident sentence about a request that does not exist.
 */
function relationSentence(
  relation: CollectionRelation,
  mine: ReadonlySet<string>,
  followedHere: boolean,
): string {
  const quantity = relation.many
    ? `any number of records in ${quote(relation.to)}`
    : `one record in ${quote(relation.to)}`;

  let sentence =
    `Each record in ${quote(relation.from)} names ${quantity}, by keeping its id in ` +
    `${quote(relation.field)}.`;

  const holdsKey = mine.has(relation.from);
  const holdsTarget = mine.has(relation.to);

  if (relation.followed && !followedHere) {
    sentence +=
      ' A query elsewhere in the app fetches both together, but nothing on this screen ' + 'does.';
    return sentence;
  }

  if (followedHere) {
    sentence +=
      ' A query on this screen fetches both together, so they arrive as one result rather ' +
      'than two requests.';
  } else if (holdsKey && holdsTarget) {
    sentence += ' Both are used on this screen, in separate requests.';
  } else if (holdsKey) {
    sentence +=
      ` This screen does not read ${quote(relation.to)} itself, so whatever it shows from ` +
      'there was fetched somewhere else.';
  } else {
    /**
     * The incoming direction, which is the one with consequences.
     *
     * A screen editing `customers` is not touching `orders` at all — and that
     * is exactly why it matters: the records pointing at what this screen
     * changes are the ones that break when it changes them.
     */
    sentence +=
      ` This screen works with ${quote(relation.to)} but not with ` +
      `${quote(relation.from)}, so records over there point at what is changed here.`;
  }

  return sentence;
}

/** One direction of a join, for asking "does this screen do that one". */
function joinKey(from: string, to: string): string {
  return `${from}\u0000${to}`;
}

/** How each kind of link came to be known, in the reader's terms. */
const RELATION_BASIS: Record<RelationVia, string> = {
  declared: 'The schema declares the link, so this is what the code says.',
  prisma: 'The schema declares the link, so this is what the code says.',
  lookup: 'A query joins the two, so the link is in the code that runs.',
  naming:
    'Inferred from the field name and a matching collection — nothing in the code ' +
    'declares this link, so check it before relying on it.',
};

const RELATION_RANK: Record<RelationVia, number> = {
  lookup: 0,
  declared: 1,
  prisma: 1,
  naming: 2,
};

/**
 * Where the information on this screen comes from, and where it goes.
 *
 * The narrative the tables cannot give: which request fills the page, which
 * link explains a column that no request on this screen fetches, and what a
 * save actually lands in. Every sentence is one fact, so a reader can stop
 * after the first and still be better off.
 */
function dataFlowSentences(
  built: Array<{ flow: FeatureFlow; story: ScreenStory }>,
  data: DataNote[],
  relations: RelationNote[],
): string[] {
  const sentences: string[] = [];

  /**
   * Which request writes which collection.
   *
   * Taken from the story rows rather than the flow, because a row carries the
   * endpoint that caused it — which is the fact a reader needs when an action
   * makes several requests and only one of them saves anything.
   */
  const writers = new Map<string, Set<string>>();
  for (const { flow, story } of built) {
    for (const row of story.data) {
      if (row.effect === 'read') continue;
      const bucket = writers.get(row.collection) ?? new Set<string>();
      // A single-request action carries no endpoint on the row; it has only one.
      for (const endpoint of row.endpoint ? [row.endpoint] : flow.endpoints) {
        bucket.add(endpoint);
      }
      writers.set(row.collection, bucket);
    }
  }

  const onOpenReads = built
    .filter((entry) => isPageLoad(entry.flow))
    .flatMap((entry) => entry.story.data.filter((row) => row.effect === 'read'));
  if (onOpenReads.length > 0) {
    sentences.push(
      `What is on the page when it opens comes from ${humanList(
        [...new Set(onOpenReads.map((row) => row.collection))].sort().map(quote),
      )}.`,
    );
  }

  for (const note of data) {
    const endpoints = [...(writers.get(note.collection) ?? [])].sort();
    const through =
      endpoints.length > 0 ? humanList(endpoints.map(quote)) : 'the requests listed above';

    if (
      note.effects.some(
        (effect) => effect === 'create' || effect === 'update' || effect === 'write',
      )
    ) {
      sentences.push(
        `Anything saved into ${quote(note.collection)} on this screen goes through ${through}.`,
      );
    }
    // Said separately: "saved into" is the wrong verb for a removal, and the
    // removal is the half a reader needs to be sure of.
    if (note.effects.includes('delete')) {
      sentences.push(
        `Records are permanently removed from ${quote(note.collection)} by ${through}.`,
      );
    }
  }

  const mine = new Set(data.map((note) => note.collection));
  for (const relation of relations) {
    if (relation.followed) {
      sentences.push(
        `${quote(relation.to)} arrives together with ${quote(relation.from)} in one query, ` +
          `joined on ${quote(relation.field)}.`,
      );
      continue;
    }
    // Followed somewhere, but not here: the relations table says so, and
    // repeating it as a "where the data comes from" sentence would imply this
    // screen is the place it happens.
    if (relation.followedElsewhere) continue;

    if (mine.has(relation.from) && !mine.has(relation.to)) {
      sentences.push(
        `${quote(relation.from)} records hold an id from ${quote(relation.to)} in ` +
          `${quote(relation.field)}, but nothing on this screen reads ${quote(relation.to)} — ` +
          'so anything shown from there comes from another screen or another request.',
      );
      continue;
    }

    if (!mine.has(relation.from) && mine.has(relation.to)) {
      sentences.push(
        `${quote(relation.from)} records elsewhere in the app point at ${quote(relation.to)} ` +
          `through ${quote(relation.field)}, so what this screen changes there is depended on ` +
          'by data this screen never shows.',
      );
    }
  }

  return sentences;
}

function screenCautions(flows: FeatureFlow[], stories: ScreenStory[], data: DataNote[]): string[] {
  const cautions: string[] = [];

  const destructive = stories.filter((story, index) =>
    (flows[index] as FeatureFlow).collections.some((entry) => entry.effect === 'delete'),
  );
  if (destructive.length > 0) {
    cautions.push(
      capitalize(
        `${countWord(destructive.length)} ${destructive.length === 1 ? 'action' : 'actions'} on `,
      ) +
        `this screen permanently ${destructive.length === 1 ? 'deletes' : 'delete'} ` +
        `information: ${humanList(destructive.map((story) => story.title))}.`,
    );
  }

  const unmatched = flows.filter((flow) =>
    flow.steps.some((step) => step.meta?.['mismatch'] !== undefined),
  );
  if (unmatched.length > 0) {
    cautions.push(
      capitalize(
        `${countWord(unmatched.length)} ${unmatched.length === 1 ? 'action asks' : 'actions ask'} `,
      ) +
        'for something no code in this project answers. Those requests may be handled ' +
        'by another application, or may simply be broken.',
    );
  }

  const shared = sharedEndpoints(flows);
  if (shared.length > 0) {
    cautions.push(
      `${humanList(shared.map(quote))} ${shared.length === 1 ? 'is' : 'are'} used by more than ` +
        'one action on this screen: a change there affects all of them.',
    );
  }

  /**
   * Deleting the thing other records point at.
   *
   * The most expensive bug this document can prevent. A screen that deletes a
   * customer is not looking at orders, so nothing on the screen, in the code
   * it runs, or in any other tab says that the orders naming that customer are
   * about to point at nothing. It is only visible once the links are known,
   * which is the whole reason for knowing them.
   */
  const orphaning = data.filter(
    (note) => note.effects.includes('delete') && note.pointedToBy.length > 0,
  );
  for (const note of orphaning) {
    const unhandled = note.pointedToBy.filter(
      (other) => !data.some((candidate) => candidate.collection === other),
    );
    if (unhandled.length === 0) continue;
    cautions.push(
      `This screen deletes from ${quote(note.collection)}, and records in ` +
        `${humanList(unhandled.map(quote))} point at it. Nothing on this screen touches ` +
        `${unhandled.length === 1 ? 'that' : 'those'}, so after a delete ` +
        `${unhandled.length === 1 ? 'it may hold' : 'they may hold'} an id that no longer ` +
        'exists. Check whether something elsewhere cleans that up.',
    );
  }

  /**
   * Two collections written in one action.
   *
   * The failure mode nobody plans for: the code writes one, then the other,
   * with nothing holding the two together, so an error in between leaves the
   * data disagreeing with itself. Worth saying on the screen rather than only
   * next to the action, because it is a question for whoever owns the data.
   */
  const multiWrite = stories.filter((story) => {
    const written = new Set(
      story.data.filter((row) => row.effect !== 'read').map((row) => row.collection),
    );
    return written.size > 1;
  });
  if (multiWrite.length > 0) {
    cautions.push(
      `${humanList(multiWrite.map((story) => story.title))} ${
        multiWrite.length === 1 ? 'changes' : 'change'
      } more than one place in one go. If it stops halfway, some of it will have been ` +
        'saved and the rest will not.',
    );
  }

  return cautions;
}

function sharedEndpoints(flows: FeatureFlow[]): string[] {
  const counts = new Map<string, number>();
  for (const flow of flows) {
    for (const endpoint of new Set(flow.endpoints)) {
      counts.set(endpoint, (counts.get(endpoint) ?? 0) + 1);
    }
  }
  return [...counts.entries()]
    .filter(([, count]) => count > 1)
    .map(([endpoint]) => endpoint)
    .sort((a, b) => a.localeCompare(b, 'en'));
}

/**
 * Terms the document could not avoid, defined where they are read.
 *
 * Only the ones that appear: a glossary of words that are not on the page is
 * how a reader learns the glossary is not worth reading.
 */
function glossaryFor(
  stories: ScreenStory[],
  data: DataNote[],
  relations: RelationNote[],
): GlossaryEntry[] {
  const text = stories
    .flatMap((story) => [
      story.trigger,
      ...story.steps,
      ...story.result,
      ...story.cautions,
      ...story.data.map((row) => row.sentence),
    ])
    .concat(relations.map((relation) => relation.sentence))
    .join(' ');
  const entries: GlossaryEntry[] = [];

  const add = (term: string, meaning: string, when: boolean) => {
    if (when) entries.push({ term, meaning });
  };

  add(
    'the browser',
    'the part of the app running on the user’s own machine — the page they can see and click.',
    /browser/.test(text),
  );
  add(
    'the server',
    'the part of the app running elsewhere, which the browser asks for information and which is the only part allowed to store it.',
    /server/.test(text),
  );
  add(
    'request',
    'one question or instruction the browser sends the server, written as a method and an address — `GET /products` asks for the product list.',
    /`(GET|POST|PUT|PATCH|DELETE)/.test(text),
  );
  add(
    'stored information',
    `groups of saved records, each holding one kind of thing${
      data.length > 0 ? ` — here: ${humanList(data.map((note) => quote(note.collection)))}` : ''
    }.`,
    data.length > 0,
  );
  add(
    'record',
    'one saved item — one customer, one order. A group of them is what the names in backticks above refer to.',
    /record/.test(text),
  );
  add(
    'field',
    'one labelled part of a record: a customer’s `name`, an order’s `total`.',
    relations.length > 0 || data.some((note) => note.fields.length > 0),
  );
  add(
    'names',
    'holds the id of a record kept somewhere else, which is how two groups of stored information are joined up.',
    relations.length > 0,
  );
  add(
    'reloaded',
    'the screen asks the server for that information again, so what you see matches what was just saved.',
    /reloaded/.test(text),
  );
  add(
    'checks',
    'a rule the server applies before doing the work — usually "is this user allowed to do this".',
    /the server checks/.test(text),
  );

  return entries;
}

function limitsOf(flows: FeatureFlow[], relations: RelationNote[], data: DataNote[]): string[] {
  const limits: string[] = [];

  const unresolved = flows.filter((flow) =>
    flow.steps.some((step) => step.meta?.['unresolved'] === true),
  );
  if (unresolved.length > 0) {
    const one = unresolved.length === 1;
    limits.push(
      capitalize(`${countWord(unresolved.length)} ${one ? 'action goes' : 'actions go'} `) +
        `through code Flowslens could not follow to the end, so ${one ? 'its' : 'their'} ` +
        'last steps may be missing.',
    );
  }

  if (flows.every((flow) => flow.evidence === 'static')) {
    limits.push(
      'Nothing on this screen has been watched running. Everything above is what the ' +
        'code says will happen, not a recording of it happening.',
    );
  }

  /**
   * Say which links are guesses, by name.
   *
   * The links section is the part of this document a reader is most likely to
   * act on and least able to check, so the ones that rest on a naming
   * convention are named here rather than left to a phrase in a table cell.
   */
  const guessed = relations.filter((relation) => relation.via === 'naming');
  if (guessed.length > 0) {
    limits.push(
      `${humanList(guessed.map((relation) => `\`${relation.from}.${relation.field}\``))} ` +
        `${guessed.length === 1 ? 'is treated as a link' : 'are treated as links'} because of ` +
        'the field name and a collection that matches it. Nothing in the code says so.',
    );
  }

  const unknownShape = data.filter((note) => note.fields.length === 0);
  if (unknownShape.length > 0) {
    limits.push(
      `The shape of ${humanList(unknownShape.map((note) => quote(note.collection)))} is not ` +
        'described here: no schema for it was found in this project, so its fields are ' +
        'whatever the database happens to hold.',
    );
  }

  limits.push(
    'Filters and conditions are not described. "Reads every record that matches" does not ' +
      'say what it matches on — that is in the code the links at the end of each action ' +
      'point to.',
  );

  limits.push(
    'What the screen looks like — wording, layout, colours — is not described here. ' +
      'This document is about what happens, not what it looks like.',
  );

  return limits;
}

// ---------------------------------------------------------------------------
// Naming and phrasing
// ---------------------------------------------------------------------------

/**
 * A heading for one action.
 *
 * The flow's own title repeats the screen (`Products · Delete`), which reads
 * badly under a heading that already says Products.
 */
function storyTitle(flow: FeatureFlow): string {
  if (isPageLoad(flow)) {
    return flow.component ? plainName(flow.component) : 'When the screen opens';
  }
  const screen = flow.screen ?? '';
  const title = flow.title;
  const trimmed =
    screen && title.startsWith(`${screen} · `) ? title.slice(screen.length + 3) : title;
  return plainName(trimmed);
}

/**
 * Two buttons, one word.
 *
 * A screen built from several components often has the same label twice —
 * "Delete" on the list and "Delete" on the detail page are different actions
 * with different consequences, and two identical headings make the document
 * look like it repeated itself. The component is what tells them apart.
 */
/** What to call the part of the screen an action lives in. */
function componentName(flow: FeatureFlow): string | undefined {
  if (flow.component) return plainName(flow.component);
  // A page's own actions carry no component; the file is the next best name.
  const file = flow.source?.file;
  if (!file) return undefined;
  const base = file
    .split('/')
    .pop()
    ?.replace(/\.[cm]?[jt]sx?$/, '');
  if (!base || base === 'index') return undefined;
  return `the ${humanizeName(base).toLowerCase()} page`;
}

/**
 * Give colliding headings something that tells them apart.
 *
 * Tried in order of how much the reader learns from it: the part of the screen
 * it lives in, then the control itself, then its position. The last is a poor
 * heading and is only reached when two controls really are indistinguishable
 * from outside the code — at which point saying "the second one" is still
 * better than printing the same heading twice and leaving the reader to guess
 * which paragraph belongs to which button.
 */
function disambiguate(entries: Array<{ flow: FeatureFlow; story: ScreenStory }>): void {
  const count = (title: string) => entries.filter((entry) => entry.story.title === title).length;

  for (const entry of entries) {
    if (count(entry.story.title) < 2) continue;

    const byComponent = entry.story.component
      ? `${entry.story.title} (in ${entry.story.component})`
      : undefined;
    if (byComponent && entries.filter((other) => byComponent === candidateFor(other)).length < 2) {
      entry.story.title = byComponent;
      continue;
    }

    const control = controlName(entry.flow);
    entry.story.title = `${entry.story.title} — ${control}`;
  }

  // Positions last, for the few that even the control name does not separate.
  entries.forEach((entry, index) => {
    if (count(entry.story.title) < 2) return;
    entry.story.title = `${entry.story.title} (${ordinalWord(index + 1)})`;
  });
}

/** What `disambiguate` would produce for an entry, for the collision check. */
function candidateFor(entry: { story: ScreenStory }): string | undefined {
  return entry.story.component ? `${entry.story.title} (in ${entry.story.component})` : undefined;
}

const ORDINALS = ['', 'first', 'second', 'third', 'fourth', 'fifth', 'sixth', 'seventh'];

function ordinalWord(value: number): string {
  return ORDINALS[value] ?? `number ${value}`;
}

function triggerSentence(flow: FeatureFlow): string {
  if (isPageLoad(flow)) {
    return 'No clicking needed: this runs as soon as the screen appears.';
  }

  const verb = presentTense(flow.event);
  return `The user ${verb} ${controlName(flow)}.`;
}

/**
 * What to call the thing the user touched.
 *
 * The label is the words on the element, which is exactly right when the
 * element has words on it. When it does not, the analyzer falls back to the
 * code — `AdjustStockDialog onClose`, `button onClick` — and quoting that at
 * a reader is worse than not naming it: they will go looking for a button
 * that says "onClose". Code-shaped labels are turned back into the thing they
 * describe instead.
 */
function controlName(flow: FeatureFlow): string {
  const label = flow.label.trim();
  const handlerLike = /\bon[A-Z][A-Za-z]*\b/.test(label);
  const identifierLike = !/\s/.test(label) && /[a-z][A-Z]/.test(label);

  if (label.length > 0 && !handlerLike && !identifierLike) return `“${label}”`;

  const subject = label.replace(/\bon[A-Z][A-Za-z]*\b/g, '').trim() || flow.component || '';
  const named = subject.length > 0 ? humanizeName(subject).toLowerCase() : '';
  return named.length > 0 ? `the ${named}` : 'this control';
}

/** `onClick` -> `clicks`, `onSubmit` -> `submits`. */
function presentTense(event: string | undefined): string {
  if (!event) return 'uses';
  const verb = event
    .replace(/^on/, '')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .trim();
  if (verb.length === 0) return 'uses';
  if (verb.endsWith('s')) return verb;
  // `change` -> `changes`, `submit` -> `submits`: the plain third person is
  // right for every event name a UI framework uses.
  return `${verb}s`;
}

/** Does this action run by itself when the screen appears? */
function isPageLoad(flow: FeatureFlow): boolean {
  return flow.event === 'mount' || /\bloads$/i.test(flow.label.trim());
}

const REQUEST_VERB: Record<string, string> = {
  GET: 'asks the server for information',
  POST: 'sends information to the server',
  PUT: 'sends a replacement to the server',
  PATCH: 'sends a change to the server',
  DELETE: 'asks the server to delete something',
};

function requestVerb(method: string): string {
  return REQUEST_VERB[method.toUpperCase()] ?? 'sends a request to the server';
}

/**
 * What a pre-handler step does, without naming the machinery.
 *
 * The analyzer's own words for these are `guard`, `pipe`, `interceptor` — the
 * right words in the APIs tab and three words this reader does not have. Each
 * is replaced by what it does to the request.
 */
const CHECK_ROLE: Record<string, string> = {
  guard: 'is this allowed',
  pipe: 'is what was sent valid',
  interceptor: 'wraps the request',
  filter: 'deals with failures',
  middleware: 'runs first either way',
};

function checkRole(role: string): string {
  return CHECK_ROLE[role] ?? 'runs first either way';
}

function describePayload(call: ApiCallDetail): string {
  const body = call.payload.map((field) => field.name);
  const query = call.queryKeys;
  if (body.length > 0) return `, sending ${humanList(body.map(quote))}`;
  if (query.length > 0) return `, narrowed down by ${humanList(query.map(quote))}`;
  return '';
}

/** What a status code means, for a reader who has never seen one. */
function statusMeaning(code: number): string {
  if (code >= 200 && code < 300) return 'it worked';
  if (code === 401) return 'not signed in';
  if (code === 403) return 'not allowed';
  if (code === 404) return 'not found';
  if (code === 422 || code === 400) return 'the information sent was not acceptable';
  if (code >= 400 && code < 500) return 'the request was refused';
  if (code >= 500) return 'the server failed';
  return 'other';
}

/**
 * `ProductsView` -> `Products view`, left alone when it is already prose.
 *
 * The same rule the flow tiles use, so a reader moving between the tabs sees
 * one name per thing rather than two spellings of it.
 */
function plainName(name: string): string {
  if (/\s/.test(name)) return name;
  return humanizeName(name);
}

function humanList(items: string[]): string {
  const unique = [...new Set(items.filter((item) => item.length > 0))];
  if (unique.length === 0) return '';
  if (unique.length === 1) return unique[0] as string;
  return `${unique.slice(0, -1).join(', ')} and ${unique[unique.length - 1] as string}`;
}

function quote(value: string): string {
  return `\`${value}\``;
}

const COUNT_WORDS = ['no', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine'];

/** First letter up, for a sentence that begins with a counted word. */
function capitalize(sentence: string): string {
  return `${sentence.charAt(0).toUpperCase()}${sentence.slice(1)}`;
}

/** Small numbers read better as words in a sentence; large ones do not. */
function countWord(value: number): string {
  return COUNT_WORDS[value] ?? String(value);
}

function readableDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return `${(ms / 1000).toFixed(1)} seconds`;
}

function reference(ref: DocReference): string {
  return ref.line ? `${ref.file}:${ref.line}` : String(ref.file);
}

// ---------------------------------------------------------------------------
// Grouping
// ---------------------------------------------------------------------------

function groupByScreen(graph: FlowGraph, options: ExplainOptions): Map<string, FeatureFlow[]> {
  const flows = resolveFlows(graph, { includeLocalOnly: options.includeLocalOnly ?? true });
  const grouped = new Map<string, FeatureFlow[]>();

  for (const flow of flows) {
    const screen = flow.screen?.trim() || UNPLACED;
    const bucket = grouped.get(screen) ?? [];
    bucket.push(flow);
    grouped.set(screen, bucket);
  }

  /**
   * Page loads first, then the rest as the flow list already orders them.
   *
   * A reader works down the page in the order things happen, and what the
   * screen does before anybody touches it happens first.
   */
  for (const bucket of grouped.values()) {
    bucket.sort((a, b) => Number(isPageLoad(b)) - Number(isPageLoad(a)));
  }

  return grouped;
}

/**
 * The address to put at the top of the document.
 *
 * A screen is usually several files, and in an App Router project they serve
 * different routes — `/products` and `/products/[id]` are both "Products".
 * The one to print is the one most of the screen's actions live under, and on
 * a tie the shortest: `/products` describes the screen, `/products/[id]`
 * describes one row of it.
 */
function pageOf(flows: FeatureFlow[]): string | undefined {
  const counts = new Map<string, number>();
  for (const flow of flows) {
    if (!flow.source?.file) continue;
    const route = pageRouteOf(flow.source.file);
    if (route === undefined) continue;
    const address = `/${route}`;
    counts.set(address, (counts.get(address) ?? 0) + 1);
  }

  return [...counts.entries()].sort(
    (a, b) => b[1] - a[1] || segments(a[0]) - segments(b[0]) || a[0].localeCompare(b[0], 'en'),
  )[0]?.[0];
}

function segments(route: string): number {
  return route.split('/').filter((part) => part.length > 0).length;
}

function worstRisk(flows: FeatureFlow[]): 'low' | 'medium' | 'high' {
  if (flows.some((flow) => flow.risk.level === 'high')) return 'high';
  if (flows.some((flow) => flow.risk.level === 'medium')) return 'medium';
  return 'low';
}

function weakestEvidence(flows: FeatureFlow[]): Evidence {
  if (flows.some((flow) => flow.evidence === 'static')) return 'static';
  if (flows.some((flow) => flow.evidence === 'runtime')) return 'runtime';
  return 'confirmed';
}

/** `write` is the catch-all the analyzer falls back to; keep it in range. */
function normalizeEffect(effect: string): DbEffect {
  return (DB_EFFECT_ORDER as readonly string[]).includes(effect) ? (effect as DbEffect) : 'write';
}
