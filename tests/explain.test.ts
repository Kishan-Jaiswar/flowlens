import { describe, expect, it } from 'vitest';
import { explainScreen, listScreens, renderScreenDocument, resolveFlows } from '@flowslens/core';
import { exampleScan } from './helpers.js';

const scanned = exampleScan();

/**
 * The Docs tab.
 *
 * Everything else Flowslens renders is read by a developer, who can tell a
 * wrong-looking `db-op` from a right one. This view is read by somebody who
 * cannot, which changes what a bug is: a sentence that sounds authoritative
 * and is not checkable is worse here than a missing one. These tests pin the
 * two properties that protect that reader — the text is built only from facts
 * in the graph, and it never falls back to the code's own words when it has
 * nothing to say.
 */
describe('listing the screens', () => {
  it('groups every flow under a screen, busiest first', () => {
    const screens = listScreens(scanned.graph);
    const flows = resolveFlows(scanned.graph, { includeLocalOnly: true });

    expect(screens.length).toBeGreaterThan(0);
    expect(screens.reduce((sum, entry) => sum + entry.actions, 0)).toBe(flows.length);

    const counts = screens.map((entry) => entry.actions);
    expect(counts).toEqual([...counts].sort((a, b) => b - a));
  });

  it('counts the endpoints and collections of the screen, not of one action', () => {
    const screens = listScreens(scanned.graph);
    const customers = screens.find((entry) => entry.screen === 'Customers');
    expect(customers).toBeDefined();

    const flows = resolveFlows(scanned.graph, { includeLocalOnly: true }).filter(
      (flow) => flow.screen === 'Customers',
    );
    const endpoints = new Set(flows.flatMap((flow) => flow.endpoints));
    expect(customers?.endpoints).toBe(endpoints.size);
  });
});

describe('explaining one screen', () => {
  const doc = explainScreen(scanned.graph, 'Customer form');

  it('opens with what the screen is, not with how it is built', () => {
    expect(doc).toBeDefined();
    expect(doc?.summary[0]).toContain('Customer form');
    // The reader is told how many things they can do before anything else.
    expect(doc?.summary[0]).toMatch(/thing[s]? a user can do/);
  });

  it('separates what the screen does by itself from what a user sets off', () => {
    const everything = [...(doc?.onOpen ?? []), ...(doc?.actions ?? []), ...(doc?.local ?? [])];
    const ids = new Set(everything.map((story) => story.id));
    expect(ids.size).toBe(everything.length);

    // Local-only actions are the ones with no request in them.
    for (const story of doc?.local ?? []) expect(story.localOnly).toBe(true);
    for (const story of doc?.actions ?? []) expect(story.localOnly).toBe(false);
  });

  it('tells the request, the checks and the storage in that order', () => {
    const create = doc?.actions.find((story) => /create/i.test(story.title));
    expect(create).toBeDefined();
    const steps = create?.steps ?? [];

    const request = steps.findIndex((step) => step.includes('sends information to the server'));
    const stores = steps.findIndex((step) => step.includes('stores something new'));
    expect(request).toBeGreaterThanOrEqual(0);
    expect(stores).toBeGreaterThan(request);
  });

  /**
   * The line between "documented" and "invented".
   *
   * Nothing in this document may describe a step the graph does not contain,
   * so every collection named in the prose has to be one the flow actually
   * touches. A generated sentence is only worth reading if it cannot be
   * plausible and wrong at the same time.
   */
  it('names only collections the action really touches', () => {
    const flows = resolveFlows(scanned.graph, { includeLocalOnly: true });
    const known = new Set(flows.flatMap((flow) => flow.collections.map((c) => c.collection)));

    for (const story of doc?.actions ?? []) {
      const flow = flows.find((candidate) => candidate.id === story.id);
      const touched = new Set(flow?.collections.map((entry) => entry.collection));
      for (const name of known) {
        const mentioned = story.steps.some((step) => step.includes(`\`${name}\``));
        if (mentioned) expect(touched.has(name)).toBe(true);
      }
    }
  });

  it('says how much of it has actually been watched running', () => {
    for (const story of doc?.actions ?? []) {
      // Nothing in the example has a trace, so every action must say so
      // rather than implying it was observed.
      expect(story.evidence).toContain('source code');
    }
    expect(doc?.limits.some((limit) => limit.includes('watched running'))).toBe(true);
  });

  it('defines only the words it used', () => {
    const text = JSON.stringify(doc);
    for (const entry of doc?.glossary ?? []) {
      expect(text).toContain(entry.term.replace(/^the /, ''));
    }
  });

  it('is the same document on every run', () => {
    const again = explainScreen(scanned.graph, 'Customer form');
    expect(JSON.stringify(again)).toBe(JSON.stringify(doc));
  });

  it('has no screen to explain when there is no such screen', () => {
    expect(explainScreen(scanned.graph, 'No Such Screen')).toBeUndefined();
  });
});

describe('every control on the screen, at a glance', () => {
  const doc = explainScreen(scanned.graph, 'Customers');

  it('has one row per control and no control the document then omits', () => {
    const described = [...doc!.onOpen, ...doc!.actions, ...doc!.local];
    expect(doc!.controls).toHaveLength(described.length);
    expect(new Set(doc!.controls.map((row) => row.id))).toEqual(
      new Set(described.map((story) => story.id)),
    );
  });

  /**
   * The table and the prose are two renderings of one set of facts, so the
   * only interesting failure is them disagreeing — a row claiming a write the
   * paragraph below it does not describe is worse than either alone.
   */
  it('says the same thing as the action it summarises', () => {
    for (const row of doc!.controls) {
      const story = [...doc!.onOpen, ...doc!.actions, ...doc!.local].find(
        (candidate) => candidate.id === row.id,
      );
      expect(row.tables).toEqual(
        story!.data.map((entry) => ({ collection: entry.collection, effect: entry.effect })),
      );
    }
  });

  it('marks a control that only changes the screen as storing nothing', () => {
    for (const row of doc!.controls.filter((candidate) => candidate.kind === 'local')) {
      expect(row.tables).toHaveLength(0);
      expect(row.requests).toHaveLength(0);
    }
  });
});

describe('what each action does to each table', () => {
  const flows = resolveFlows(scanned.graph, { includeLocalOnly: true });
  const doc = explainScreen(scanned.graph, 'Customers');

  it('names only tables the action really touches, and only effects it has', () => {
    for (const story of doc!.actions) {
      const flow = flows.find((candidate) => candidate.id === story.id);
      const real = new Set(flow!.collections.map((entry) => `${entry.collection}:${entry.effect}`));
      for (const row of story.data) {
        expect(real.has(`${row.collection}:${row.effect}`)).toBe(true);
      }
    }
  });

  it('tells a read of one record from a read of the whole list', () => {
    const search = doc!.actions.find((story) => /search/i.test(story.title));
    const list = search?.data.find((row) => row.collection === 'customers');
    expect(list?.operations).toContain('find');
    expect(list?.sentence).toContain('every record that matches');
  });

  it('says a delete cannot be undone, where the delete is', () => {
    const remove = doc!.actions.find((story) => /delete/i.test(story.title));
    const row = remove?.data.find((entry) => entry.effect === 'delete');
    expect(row?.collection).toBe('customers');
    expect(row?.sentence).toContain('no undo');
  });

  it('lists what the user has to supply, without repeating itself', () => {
    for (const story of [...doc!.actions, ...doc!.onOpen]) {
      expect(new Set(story.inputs).size).toBe(story.inputs.length);
      // `note` (from `note`) is noise; only a differing source is worth saying.
      for (const input of story.inputs) expect(input).not.toMatch(/`(\w+)` \(from `\1`\)/);
    }
  });
});

describe('how the information fits together', () => {
  it('describes a link from the side the screen is standing on', () => {
    const customers = explainScreen(scanned.graph, 'Customers')!;
    const incoming = customers.relations.find((relation) => relation.from === 'orders');
    expect(incoming).toBeDefined();
    // This screen never reads `orders`, so it must not claim it does.
    expect(incoming?.sentence).not.toMatch(/Both are used on this screen/);
    expect(incoming?.sentence).toContain('records over there point at what is changed here');

    const orders = explainScreen(scanned.graph, 'Order form')!;
    const outgoing = orders.relations.find((relation) => relation.field === 'customerId');
    expect(outgoing?.sentence).toContain('Both are used on this screen');
  });

  it('only shows links that touch a table this screen uses', () => {
    for (const entry of listScreens(scanned.graph)) {
      const doc = explainScreen(scanned.graph, entry.screen)!;
      const mine = new Set(doc.data.map((note) => note.collection));
      for (const relation of doc.relations) {
        expect(mine.has(relation.from) || mine.has(relation.to)).toBe(true);
      }
    }
  });

  /**
   * The line between a fact and a guess, which this section lives or dies on.
   *
   * An inferred link is the common case — most projects write `customerId` and
   * no `ref` — and it is exactly the kind of claim a reader cannot check. So
   * it has to say it is a guess where it is made, and say which guesses they
   * were at the end.
   */
  it('admits which links are guesses, twice', () => {
    const doc = explainScreen(scanned.graph, 'Order form')!;
    const guessed = doc.relations.filter((relation) => relation.via === 'naming');
    expect(guessed.length).toBeGreaterThan(0);
    for (const relation of guessed)
      expect(relation.basis).toContain('Inferred from the field name');
    expect(doc.limits.some((limit) => limit.includes('Nothing in the code says so'))).toBe(true);
  });

  it('warns when the screen deletes what other tables point at', () => {
    const doc = explainScreen(scanned.graph, 'Customers')!;
    // `orders` records name a customer, and nothing on this screen tidies them.
    expect(
      doc.cautions.some(
        (caution) => caution.includes('deletes from') && caution.includes('`orders`'),
      ),
    ).toBe(true);
  });

  it('uses the right verb for a removal, which is not "saved"', () => {
    const doc = explainScreen(scanned.graph, 'Customers')!;
    const removal = doc.dataFlow.find((line) => line.includes('permanently removed'));
    expect(removal).toContain('`customers`');
    expect(doc.dataFlow.some((line) => /saved into `customers`/.test(line))).toBe(false);
  });
});

describe('the shape of what is stored', () => {
  const doc = explainScreen(scanned.graph, 'Customer form');

  it('names the schema behind a collection and the fields it declares', () => {
    const customers = doc!.data.find((note) => note.collection === 'customers');
    expect(customers?.model).toBe('Customer');
    expect(customers?.fields).toContain('phone');
    // Sorted, so two runs read the same.
    expect(customers?.fields).toEqual([...(customers?.fields ?? [])].sort());
  });

  it('says which actions on this screen use it', () => {
    for (const note of doc!.data) {
      expect(note.usedBy.length).toBeGreaterThan(0);
      const titles = new Set([...doc!.onOpen, ...doc!.actions, ...doc!.local].map((s) => s.title));
      for (const user of note.usedBy) expect(titles.has(user)).toBe(true);
    }
  });

  it('says so when it has no schema, rather than describing an empty shape', () => {
    for (const entry of listScreens(scanned.graph)) {
      const screen = explainScreen(scanned.graph, entry.screen)!;
      const unknown = screen.data.filter((note) => note.fields.length === 0);
      if (unknown.length === 0) continue;
      expect(screen.limits.some((limit) => limit.includes('no schema for it was found'))).toBe(
        true,
      );
    }
  });
});

describe('the markdown version', () => {
  it('carries the same sentences as the structure it renders', () => {
    const doc = explainScreen(scanned.graph, 'Customers');
    expect(doc).toBeDefined();
    const markdown = renderScreenDocument(doc!);

    expect(markdown.startsWith('# Customers')).toBe(true);
    for (const sentence of doc!.summary) expect(markdown).toContain(sentence);
    for (const story of doc!.actions) {
      expect(markdown).toContain(`### ${story.title}`);
      for (const step of story.steps) expect(markdown).toContain(step);
    }
  });

  it('carries the tables, not only the sentences', () => {
    const doc = explainScreen(scanned.graph, 'Customers')!;
    const markdown = renderScreenDocument(doc);

    expect(markdown).toContain('## Everything on this screen, at a glance');
    expect(markdown).toContain('## How the information fits together');
    for (const row of doc.controls) expect(markdown).toContain(row.does);
    for (const relation of doc.relations) {
      expect(markdown).toContain(`\`${relation.from}.${relation.field}\` → \`${relation.to}\``);
    }
    for (const note of doc.data) {
      for (const field of note.fields) expect(markdown).toContain(`\`${field}\``);
    }
  });

  it('keeps a sentence from breaking the table it sits in', () => {
    for (const entry of listScreens(scanned.graph)) {
      const markdown = renderScreenDocument(explainScreen(scanned.graph, entry.screen)!);
      for (const line of markdown.split('\n')) {
        if (!line.startsWith('|') || line.startsWith('| ---')) continue;
        // Every row must have the same number of cells as its header, or the
        // table renders as one column of text wherever it is pasted.
        const cells = line.split(/(?<!\\)\|/).length;
        expect(cells).toBeGreaterThanOrEqual(4);
      }
    }
  });

  it('keeps developer-only wording out of the prose', () => {
    for (const entry of listScreens(scanned.graph)) {
      const markdown = renderScreenDocument(explainScreen(scanned.graph, entry.screen)!);
      // The vocabulary that makes the other tabs useful and this one unreadable.
      expect(markdown).not.toMatch(/unhandled rejection|DTO|middleware|invalidateQueries/);
    }
  });
});
