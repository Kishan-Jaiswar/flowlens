import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  actionDecisions,
  renderDecisionTree,
  resolveFlows,
  scan,
  type DecisionNode,
  type DecisionQuestion,
} from '@flowslens/core';
import { exampleScan } from './helpers.js';

/**
 * The Decisions tab: every way one action can go, from the click to the
 * database and back.
 *
 * The fixture is the shape the tab exists for —
 *
 *   Submit Order → validate() → invalid → show error
 *                             → valid   → POST /orders → existing customer? → update / create
 *
 * — and what these pin is that each decision is read from the code that makes
 * it, on whichever side of the request it sits, with what runs on each answer.
 */

const project = mkdtempSync(join(tmpdir(), 'flowlens-decisions-'));
const write = (rel: string, text: string): void => {
  mkdirSync(join(project, rel, '..'), { recursive: true });
  writeFileSync(join(project, rel), text, 'utf8');
};

write('tsconfig.json', JSON.stringify({ compilerOptions: { paths: { '@/*': ['./*'] } } }));

write(
  'lib/db/mongo.ts',
  `export async function getCollections() {
     const db = await getDb();
     return { orders: db.collection('orders'), customers: db.collection('customers') };
   }`,
);

write(
  'lib/db/store.ts',
  `import { getCollections } from './mongo';
   export async function saveOrder(input) {
     const { orders, customers } = await getCollections();
     const existing = await customers.findOne({ phone: input.phone });
     if (existing) {
       await customers.updateOne({ id: existing.id }, { $inc: { orders: 1 } });
     } else {
       await customers.insertOne({ phone: input.phone, orders: 1 });
     }
     await orders.insertOne({ phone: input.phone, items: input.items });
     return { ok: true };
   }`,
);

write(
  'app/api/orders/route.ts',
  `import { saveOrder } from "@/lib/db/store";
   export async function POST(request) {
     const body = await request.json();
     if (!body.items) {
       return Response.json({ error: "No items" }, { status: 422 });
     }
     switch (body.channel) {
       case "phone":
         console.log("phone order");
         break;
       default:
         break;
     }
     const result = await saveOrder(body);
     return Response.json(result, { status: 201 });
   }`,
);

write(
  'app/(app)/orders/page.tsx',
  `"use client";
   import { useState } from "react";
   function validate(items) {
     return items.length > 0;
   }
   export default function OrdersPage() {
     const [error, setError] = useState("");
     const [items, setItems] = useState([]);
     const submit = async () => {
       if (!validate(items)) {
         setError("Add at least one item");
         return;
       }
       try {
         await fetch("/api/orders", { method: "POST", body: JSON.stringify({ items }) });
         setItems([]);
       } catch (e) {
         setError("Could not place the order");
       }
     };
     return <button onClick={submit}>Submit Order</button>;
   }`,
);

const scanned = scan({ root: project });
const flow = resolveFlows(scanned.graph, { includeLocalOnly: true }).find(
  (candidate) => candidate.label === 'Submit Order',
)!;
const tree = actionDecisions(scanned.graph, flow);
const text = renderDecisionTree(tree);

/** Every node in the tree, depth first. */
function all(nodes: DecisionNode[]): DecisionNode[] {
  return nodes.flatMap((node) => {
    const inner =
      node.type === 'group'
        ? node.nodes
        : node.type === 'decision'
          ? node.branches.flatMap((branch) => branch.nodes)
          : node.type === 'try'
            ? [...node.nodes, ...(node.catch?.nodes ?? []), ...(node.finally ?? [])]
            : [];
    return [node, ...all(inner)];
  });
}

function question(text: string): DecisionQuestion {
  const found = all(tree.nodes).find(
    (node): node is DecisionQuestion => node.type === 'decision' && node.question === text,
  );
  expect(found, `a decision asking "${text}"\n${renderDecisionTree(tree)}`).toBeDefined();
  return found!;
}

describe('the decision tree for one action', () => {
  it('starts at the click and opens the handler it runs', () => {
    expect(flow).toBeDefined();
    const [first, second] = tree.nodes;
    expect(first).toMatchObject({ type: 'step', kind: 'trigger' });
    expect(first?.type === 'step' && first.text).toBe('The user clicks "Submit Order"');
    expect(second).toMatchObject({ type: 'group', kind: 'function' });
  });

  it('turns a check with an early return into a decision whose arm stops the action', () => {
    const valid = question('validate(items)?');
    expect(valid.branches).toHaveLength(1);
    const [stop] = valid.branches;
    expect(stop?.label).toBe('no');
    expect(stop?.ends).toBe(true);
    expect(stop?.nodes.map((node) => node.type === 'step' && node.text)).toContain(
      'setError("Add at least one item")',
    );
    expect(stop?.nodes.at(-1)).toMatchObject({ type: 'end', outcome: 'stop' });
    // The other answer is not an arm: the code simply carries on.
    expect(valid.otherwise).toBe('yes');
  });

  it('follows the request into the server function that answers it', () => {
    const request = all(tree.nodes).find(
      (node) => node.type === 'group' && node.kind === 'request',
    );
    expect(request).toMatchObject({ title: 'POST /orders', side: 'server' });
    expect(request?.type === 'group' && request.handledBy?.file).toBe('app/api/orders/route.ts');
  });

  it('reads the server’s own checks, with the status each one answers', () => {
    const items = question('body.items?');
    expect(items.branches[0]?.label).toBe('no');
    expect(items.branches[0]?.nodes.at(-1)).toMatchObject({
      type: 'end',
      outcome: 'respond',
      statuses: [422],
    });
    const responses = all(tree.nodes).filter(
      (node) => node.type === 'end' && node.outcome === 'respond',
    );
    expect(responses.map((node) => node.type === 'end' && node.statuses)).toContainEqual([201]);
  });

  it('puts each query in the arm that runs it: update when the customer exists, insert when not', () => {
    const existing = question('existing?');
    const [yes, no] = existing.branches;
    expect(yes?.label).toBe('yes');
    expect(yes?.nodes).toContainEqual(
      expect.objectContaining({ type: 'step', kind: 'db', text: 'customers.updateOne' }),
    );
    expect(no?.label).toBe('no');
    expect(no?.nodes).toContainEqual(
      expect.objectContaining({ type: 'step', kind: 'db', text: 'customers.insertOne' }),
    );
    // Both arms carry on to the order insert, which runs either way.
    expect(existing.otherwise).toBeUndefined();
    expect(all(tree.nodes)).toContainEqual(
      expect.objectContaining({ kind: 'db', text: 'orders.insertOne', effect: 'create' }),
    );
  });

  it('shows what the screen does when the request fails', () => {
    const attempt = all(tree.nodes).find((node) => node.type === 'try');
    expect(attempt?.type === 'try' && attempt.catch?.nodes).toContainEqual(
      expect.objectContaining({ kind: 'ui', text: 'setError("Could not place the order")' }),
    );
  });

  it('leaves out a branch with nothing worth showing in it', () => {
    // `switch (body.channel)` only logs: no query, no response, no state.
    expect(
      all(tree.nodes).some((node) => node.type === 'decision' && node.code === 'body.channel'),
    ).toBe(false);
  });

  it('counts the places the action can go more than one way', () => {
    expect(tree.counts.decisions).toBeGreaterThanOrEqual(3);
    expect(tree.counts.requests).toBe(1);
    expect(tree.counts.queries).toBe(4);
  });

  it('says what each step does in words, keeping the code beside it', () => {
    const labels = all(tree.nodes).map((node) =>
      node.type === 'group' ? node.label : node.type === 'decision' ? node.label : node.label,
    );
    expect(labels).toEqual(
      expect.arrayContaining([
        'Show error "Add at least one item"',
        'Update customers',
        'Insert into customers',
        'Insert into orders',
        'Send POST /orders to the server',
        'Respond 422 · No items',
      ]),
    );
    const update = all(tree.nodes).find(
      (node) => node.type === 'step' && node.label === 'Update customers',
    );
    expect(update?.type === 'step' && update.text).toBe('customers.updateOne');
  });

  it('prints the same tree as text, with the line each node came from', () => {
    expect(text).toContain('◆ existing?');
    expect(text).toContain('⇄ POST /orders  → app/api/orders/route.ts:');
    expect(text).toMatch(/■ responds .* \[422\]/);
    expect(text).toContain('Limits:');
  });
});

describe('the decision tree across a NestJS service chain', () => {
  const { graph } = exampleScan();
  const order = resolveFlows(graph).find((candidate) => candidate.id === 'orderform-submit-order')!;
  const nest = actionDecisions(graph, order);
  const nodes = all(nest.nodes);

  it('follows this.service.method() into the injected service, not the controller’s own method', () => {
    expect(nodes).toContainEqual(
      expect.objectContaining({ type: 'group', title: 'this.ordersService.create(dto)' }),
    );
  });

  it('reads the exception a service throws as the status the client gets', () => {
    const thrown = nodes.filter((node) => node.type === 'end' && node.outcome === 'throw');
    expect(thrown.map((node) => node.type === 'end' && node.statuses?.[0])).toEqual(
      expect.arrayContaining([404, 400]),
    );
  });

  it('lists every write the action makes, in the order the code makes them', () => {
    const writes = nodes
      .filter((node) => node.type === 'step' && node.kind === 'db' && node.effect !== 'read')
      .map((node) => node.type === 'step' && node.text);
    expect(writes).toEqual(['orders.create', 'auditlogs.create']);
  });
});
