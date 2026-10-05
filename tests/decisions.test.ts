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

describe('the decision tree reads control flow the way it runs', () => {
  const root = mkdtempSync(join(tmpdir(), 'flowlens-decisions-flow-'));
  const put = (rel: string, text: string): void => {
    mkdirSync(join(root, rel, '..'), { recursive: true });
    writeFileSync(join(root, rel), text, 'utf8');
  };
  put('tsconfig.json', JSON.stringify({ compilerOptions: { paths: { '@/*': ['./*'] } } }));
  put(
    'lib/db/mongo.ts',
    `export async function getCollections() {
       const db = await getDb();
       return {
         products: db.collection('products'),
         logs: db.collection('logs'),
         items: db.collection('items'),
       };
     }`,
  );
  put(
    'lib/cache.ts',
    `export class CacheService {
       get(key) { return this.store.findOne({ key }); }
     }`,
  );
  put(
    'lib/db/import.ts',
    `import { getCollections } from './mongo';
     export async function importRows(rows, mode) {
       const { products, logs, items } = await getCollections();
       const seen = new Map();
       for (const row of rows) {
         if (!row.sku) continue;
         if (seen.get(row.sku)) break;
         await products.insertOne(row);
       }
       await Promise.all(rows.map(async (row) => {
         if (!row.note) return;
         await logs.insertOne({ note: row.note });
       }));
       const first = rows.find((row) => row.sku);
       switch (mode) {
         case "merge":
         case "append":
           await items.updateOne({ sku: first.sku }, { $set: first });
           break;
         case "replace":
           await items.deleteMany({});
         default:
           await items.insertMany(rows);
       }
       return { ok: true };
     }`,
  );
  put(
    'app/api/import/route.ts',
    `import { importRows } from "@/lib/db/import";
     async function handleImport(body) {
       if (!body.rows) return Response.json({ error: "No rows" }, { status: 400 });
       await importRows(body.rows, body.mode);
       return Response.json({ ok: true }, { status: 201 });
     }
     export async function POST(request) {
       const body = await request.json();
       return handleImport(body);
     }`,
  );
  put(
    'app/(app)/import/page.tsx',
    `"use client";
     import { useState } from "react";
     async function sendImport(rows) {
       const response = await fetch("/api/import", { method: "POST", body: JSON.stringify({ rows }) });
       return response.json();
     }
     export default function ImportPage() {
       const [result, setResult] = useState(null);
       const run = async () => {
         setResult(await sendImport([]));
       };
       return <button onClick={run}>Run import</button>;
     }`,
  );
  const { graph } = scan({ root });
  const importFlow = resolveFlows(graph, { includeLocalOnly: true }).find(
    (candidate) => candidate.label === 'Run import',
  )!;
  const importTree = actionDecisions(graph, importFlow);
  const nodes = all(importTree.nodes);
  const printed = renderDecisionTree(importTree);
  const find = (question: string): DecisionQuestion => {
    const found = nodes.find(
      (node): node is DecisionQuestion => node.type === 'decision' && node.question === question,
    );
    expect(found, `"${question}" in\n${printed}`).toBeDefined();
    return found!;
  };

  it('follows a request made inside another call’s arguments', () => {
    // `setResult(await sendImport([]))`: the request is in the argument.
    expect(nodes).toContainEqual(
      expect.objectContaining({ type: 'group', kind: 'request', title: 'POST /import' }),
    );
  });

  it('follows a route that hands the request to a helper, with each of its responses', () => {
    const statuses = nodes
      .filter((node) => node.type === 'end' && node.outcome === 'respond')
      .map((node) => node.type === 'end' && node.statuses);
    expect(statuses).toEqual(expect.arrayContaining([[400], [201]]));
  });

  it('keeps continue and break in a loop as the decisions they are', () => {
    const sku = find('row.sku?');
    expect(sku.branches[0]?.nodes.at(-1)).toMatchObject({ type: 'end', outcome: 'next' });
    expect(sku.otherwise).toBe('yes');
    const seen = find('seen.get(row.sku)?');
    expect(seen.branches[0]?.nodes.at(-1)).toMatchObject({ type: 'end', outcome: 'break' });
  });

  it('shows work done in a .map callback as a loop, with its early return', () => {
    const loop = nodes.find(
      (node) => node.type === 'group' && node.kind === 'loop' && node.title.startsWith('for each'),
    );
    expect(loop, printed).toBeDefined();
    const inside = loop?.type === 'group' ? all(loop.nodes) : [];
    expect(inside).toContainEqual(expect.objectContaining({ kind: 'db', text: 'logs.insertOne' }));
    expect(inside).toContainEqual(expect.objectContaining({ type: 'end', outcome: 'next' }));
  });

  it('reads switch fall-through: shared labels on one arm, and a case running into the next', () => {
    const mode = find('mode?');
    expect(mode.branches.map((branch) => branch.label)).toEqual([
      'case "merge" / case "append"',
      'case "replace"',
      'default',
    ]);
    const replace = mode.branches[1]!.nodes.map((node) => node.type === 'step' && node.text);
    // No `break` after deleteMany, so the default's insertMany runs too.
    expect(replace).toEqual(['items.deleteMany', 'items.insertMany']);
  });

  it('does not mistake a Map lookup or an array find for project code or a query', () => {
    expect(printed).not.toContain('CacheService');
    expect(nodes).not.toContainEqual(expect.objectContaining({ kind: 'db', text: 'items.find' }));
    expect(nodes).not.toContainEqual(expect.objectContaining({ kind: 'db', text: 'seen.get' }));
  });
});

describe('the decision tree follows what the code hands around', () => {
  const root = mkdtempSync(join(tmpdir(), 'flowlens-decisions-hand-'));
  const put = (rel: string, text: string): void => {
    mkdirSync(join(root, rel, '..'), { recursive: true });
    writeFileSync(join(root, rel), text, 'utf8');
  };
  put('tsconfig.json', JSON.stringify({ compilerOptions: { paths: { '@/*': ['./*'] } } }));
  put(
    'lib/server.ts',
    `export function apiError(message, status) { return Response.json({ error: message }, { status }); }
     export async function requireUser(request) {
       if (!request.headers.get("authorization")) return { error: apiError("Sign in", 401) };
       if (request.headers.get("x-banned")) return { error: apiError("Banned", 403) };
       return { user: { id: 1 } };
     }`,
  );
  put(
    'lib/db/store.ts',
    `export async function stats() {
       const db = await getDb();
       const [total, latest] = await Promise.all([
         db.collection<Doc>("orders").countDocuments({}),
         db.collection<Doc>("orders").find({}).limit(5).toArray(),
       ]);
       return { total, latest };
     }`,
  );
  put(
    'app/api/stats/route.ts',
    `import { requireUser } from "@/lib/server";
     import { stats } from "@/lib/db/store";
     export async function GET(request) {
       const ctx = await requireUser(request);
       if ("error" in ctx) return ctx.error;
       return Response.json(await stats());
     }`,
  );
  put(
    'lib/api.ts',
    `import axios from "axios";
     export const api = axios.create({ baseURL: "/api" });
     api.interceptors.response.use((r) => r, async (error) => {
       if (error.response?.status === 401) window.location.assign("/login");
       return Promise.reject(error);
     });`,
  );
  put(
    'features/stats.ts',
    `import { useQuery } from "@tanstack/react-query";
     import { api } from "@/lib/api";
     export function useStats(ready) {
       return useQuery({
         queryKey: ["stats"],
         queryFn: async () => (await api.get("/stats")).data,
         enabled: ready,
       });
     }
     export function useSaveNote() {
       const save = async (note) => {
         try {
           await api.post("/notes", { note });
         } catch {
           // the note is optional; a failure is ignored
         }
       };
       return { save };
     }`,
  );
  put(
    'app/(app)/stats/page.tsx',
    `"use client";
     import { useStats, useSaveNote } from "@/features/stats";
     export default function StatsPage() {
       const { data, refetch } = useStats(true);
       const { save } = useSaveNote();
       const reload = async () => {
         await save("reloaded");
         refetch();
       };
       return <button onClick={reload}>Reload stats</button>;
     }`,
  );
  const { graph } = scan({ root });
  const flows = resolveFlows(graph, { includeLocalOnly: true });
  const reload = flows.find((candidate) => candidate.label === 'Reload stats')!;
  const tree = actionDecisions(graph, reload);
  const nodes = all(tree.nodes);
  const printed = renderDecisionTree(tree);

  it('follows a function a hook hands back, and refetch to its query', () => {
    expect(printed).toContain('⇄ POST /notes');
    expect(printed).toContain('⇄ GET /stats');
    expect(tree.nodes.some((node) => node.type === 'group' && node.kind === 'unlinked')).toBe(
      false,
    );
  });

  it('shows an empty catch around a request as an error that is ignored', () => {
    const attempt = nodes.find((node) => node.type === 'try');
    expect(attempt?.type === 'try' && attempt.catch?.label).toMatch(/ignored/);
  });

  it('names every status a forwarded error can carry', () => {
    const forwarded = nodes.find(
      (node) => node.type === 'end' && node.text === 'responds ctx.error',
    );
    expect(forwarded?.type === 'end' && forwarded.statuses).toEqual([401, 403]);
  });

  it('follows the work inside a response, and draws Promise.all as parallel', () => {
    const parallel = nodes.find((node) => node.type === 'group' && node.kind === 'parallel');
    expect(parallel, printed).toBeDefined();
    const queries = parallel?.type === 'group' ? all(parallel.nodes) : [];
    expect(queries.map((node) => node.type === 'step' && node.text)).toEqual([
      'orders.countDocuments',
      'orders.find',
    ]);
  });

  it('puts the API client’s response interceptor between the answer and the screen', () => {
    const interceptor = nodes.find(
      (node) => node.type === 'group' && node.title.includes('interceptors.response'),
    );
    expect(interceptor, printed).toBeDefined();
  });

  it('waits on enabled: for a query made on load', () => {
    const loads = flows.find(
      (candidate) => candidate.event === 'mount' && candidate.endpoints.includes('GET /stats'),
    );
    if (!loads) return; // the page load is only an action when the scan names one
    const onLoad = all(actionDecisions(graph, loads).nodes);
    expect(onLoad).toContainEqual(
      expect.objectContaining({ type: 'decision', question: 'ready?' }),
    );
  });
});

describe('the decision tree knows the framework’s default status', () => {
  it('answers 201 for a NestJS POST that returns a value, 200 for a GET', () => {
    const { graph } = exampleScan();
    const flows = resolveFlows(graph);
    const create = all(
      actionDecisions(
        graph,
        flows.find((flow) => flow.id === 'orderform-submit-order')!,
      ).nodes,
    );
    expect(create).toContainEqual(
      expect.objectContaining({ type: 'end', outcome: 'respond', statuses: [201] }),
    );
    const search = flows.find((flow) => flow.endpoints.some((e) => e.startsWith('GET ')));
    if (search) {
      const found = all(actionDecisions(graph, search).nodes);
      expect(found).toContainEqual(
        expect.objectContaining({ type: 'end', outcome: 'respond', statuses: [200] }),
      );
    }
  });
});

describe('the decision tree shows what decides which records a query touches', () => {
  const root = mkdtempSync(join(tmpdir(), 'flowlens-decisions-values-'));
  const put = (rel: string, text: string): void => {
    mkdirSync(join(root, rel, '..'), { recursive: true });
    writeFileSync(join(root, rel), text, 'utf8');
  };
  put(
    'lib/db/store.ts',
    `export async function adjust(input, current) {
       const db = await getDb();
       const filter = { ownerId: input.ownerId };
       if (input.medicineId) filter.medicineId = input.medicineId;
       const target =
         input.action === "increase" ? current + input.qty
         : input.action === "decrease" ? current - input.qty
         : input.qty;
       await db.collection("stock").updateOne(filter, { $set: { target } }, { upsert: true });
       if (!input.quiet) window.location.href = "/stock";
     }`,
  );
  put(
    'app/api/stock/route.ts',
    `import { adjust } from "../../../lib/db/store";
     export async function POST(request) { await adjust(await request.json(), 0); return Response.json({ ok: true }); }`,
  );
  put(
    'app/page.tsx',
    `"use client";
     export default function P() { const go = async () => { await fetch("/api/stock", { method: "POST" }); }; return <button onClick={go}>Adjust</button>; }`,
  );
  const { graph } = scan({ root });
  const flow = resolveFlows(graph, { includeLocalOnly: true }).find((f) => f.label === 'Adjust')!;
  const nodes = all(actionDecisions(graph, flow).nodes);

  it('draws a condition added to a query’s filter under the decision that adds it', () => {
    const medicine = nodes.find(
      (node) => node.type === 'decision' && node.code === 'input.medicineId',
    );
    expect(medicine?.type === 'decision' && medicine.branches[0]?.nodes[0]).toMatchObject({
      kind: 'compute',
      label: 'Filter on medicine id',
    });
  });

  it('draws a chain of ?: that picks a value as nested decisions', () => {
    const computed = nodes
      .filter((node) => node.type === 'step' && node.kind === 'compute')
      .map((node) => node.type === 'step' && node.text);
    expect(computed).toEqual(
      expect.arrayContaining([
        'target = current + input.qty',
        'target = current - input.qty',
        'target = input.qty',
      ]),
    );
  });

  it('calls an update with upsert what it is, and a location assignment a navigation', () => {
    expect(nodes).toContainEqual(
      expect.objectContaining({ kind: 'db', text: 'stock.updateOne', effect: 'upsert' }),
    );
    expect(nodes).toContainEqual(expect.objectContaining({ kind: 'ui', label: 'Go to /stock' }));
  });
});

describe('a condition is read through what its variable holds', () => {
  const root = mkdtempSync(join(tmpdir(), 'flowlens-decisions-meaning-'));
  const put = (rel: string, text: string): void => {
    mkdirSync(join(root, rel, '..'), { recursive: true });
    writeFileSync(join(root, rel), text, 'utf8');
  };
  put(
    'app/api/auth/verify/route.ts',
    `export async function POST(request) {
       const body = await request.json();
       const parsed = verifySchema.safeParse(body);
       if (!parsed.success) return Response.json({ error: "Invalid input" }, { status: 422 });
       const clinics = await findClinics(parsed.data.phone);
       if (clinics.length === 0) return Response.json({ error: "Not registered" }, { status: 403 });
       const ok = await verifyOtp(parsed.data.phone, parsed.data.otp);
       if (!ok) return Response.json({ error: "Wrong code" }, { status: 401 });
       return Response.json({ ok: true });
     }
     async function findClinics(phone) { return []; }
     async function verifyOtp(phone, otp) { return true; }`,
  );
  put(
    'app/login/page.tsx',
    `"use client";
     export default function Login() {
       const submit = async () => {
         const parsed = verifySchema.safeParse({ phone, otp });
         if (!parsed.success) { setError("Check the code"); return; }
         const res = await fetch("/api/auth/verify", { method: "POST" });
         if (!res.ok) { setError("Failed"); return; }
       };
       return <button onClick={submit}>Verify</button>;
     }`,
  );
  const { graph } = scan({ root });
  const flow = resolveFlows(graph, { includeLocalOnly: true }).find((f) => f.label === 'Verify')!;
  const labels = all(actionDecisions(graph, flow).nodes)
    .filter((node): node is DecisionQuestion => node.type === 'decision')
    .map((node) => node.label);

  it('says what a schema check validates, on each side of the request', () => {
    // Was `parsed succeeded?` on both sides.
    expect(labels).toContain('Are phone and otp valid?');
    expect(labels).toContain('Is the request body valid?');
  });

  it('names the call behind a flag, and a fetch as the request', () => {
    expect(labels).toContain('Did verify otp succeed?');
    expect(labels).toContain('Did the request succeed?');
    expect(labels).toContain('Are there no clinics?');
  });
});
