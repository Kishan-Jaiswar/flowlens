import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { actionQueries, resolveFlows, scan } from '@flowslens/core';

/**
 * The Queries tab: each database query an action runs, as the code wrote it,
 * with its time from runtime spans.
 *
 * What these pin is the part a reader cannot get from the call alone —
 * `find(filter)` is only useful once you see what goes into `filter`, so the
 * variables are followed to their declaration, to every line that adds to
 * them, and into the helper that returns them — and that a query nobody has
 * run carries no invented number.
 */

const project = mkdtempSync(join(tmpdir(), 'flowlens-queries-'));
const write = (rel: string, text: string): void => {
  mkdirSync(join(project, rel, '..'), { recursive: true });
  writeFileSync(join(project, rel), text, 'utf8');
};

write('tsconfig.json', JSON.stringify({ compilerOptions: { paths: { '@/*': ['./*'] } } }));

write(
  'lib/db/mongo.ts',
  `export async function getCollections() {
     const db = await getDb();
     return { products: db.collection('products') };
   }`,
);

write(
  'lib/db/store.ts',
  `import { getCollections } from './mongo';
   function productFilter(ownerId, query) {
     const filter = { ownerId };
     if (query.category) filter.category = query.category;
     if (query.inStock) filter.stock = { $gt: 0 };
     return filter;
   }
   export async function listProducts(ownerId, query) {
     const { products } = await getCollections();
     const filter = productFilter(ownerId, query);
     return products.find(filter).sort({ name: 1 }).limit(20).toArray();
   }
   export async function countMatches(ownerId, input) {
     const { products } = await getCollections();
     const or = [];
     if (input.name) or.push({ name: input.name });
     if (input.sku) or.push({ sku: input.sku });
     return products.countDocuments({ ownerId, $or: or });
   }`,
);

write(
  'app/api/products/route.ts',
  `import { countMatches, listProducts } from "@/lib/db/store";
   export async function GET(request) {
     const query = Object.fromEntries(new URL(request.url).searchParams);
     const items = await listProducts("owner", query);
     const total = await countMatches("owner", query);
     return Response.json({ items, total });
   }`,
);

write(
  'app/(app)/products/page.tsx',
  `"use client";
   export default function ProductsPage() {
     const load = async () => {
       await fetch("/api/products?category=tablets");
     };
     return <button onClick={load}>Load products</button>;
   }`,
);

const scanned = scan({ root: project });
const flow = resolveFlows(scanned.graph, { includeLocalOnly: true }).find(
  (candidate) => candidate.component === 'ProductsPage' && candidate.hitsBackend,
);
const query = (operation: string) =>
  actionQueries(scanned.graph, flow!).queries.find((entry) => entry.operation === operation)!;

describe('the queries of an action', () => {
  it('finds the action and both of its queries', () => {
    expect(flow).toBeDefined();
    const result = actionQueries(scanned.graph, flow!);
    expect(result.queries.map((entry) => `${entry.collection}.${entry.operation}`).sort()).toEqual([
      'products.countDocuments',
      'products.find',
    ]);
  });

  it('quotes the whole chain and names what it adds', () => {
    const find = query('find');
    expect(find.code).toContain('products.find(filter).sort({ name: 1 }).limit(20).toArray()');
    expect(find.modifiers).toEqual(['.sort({ name: 1 })', '.limit(20)']);
    expect(find.inFunction).toBe('listProducts');
    expect(find.at?.file).toBe('lib/db/store.ts');
  });

  it('follows a filter into the helper that builds it', () => {
    const filter = query('find').parts[0]!;
    expect(filter.role).toBe('filter');
    const variable = filter.variables![0]!;
    expect(variable.builtBy![0]!.text).toBe('const filter = productFilter(ownerId, query);');
    expect(variable.helper?.name).toBe('productFilter');
    const helperLines = variable.helper!.builtBy.map((line) => line.text);
    expect(helperLines[0]).toBe('const filter = { ownerId };');
    expect(helperLines).toContain('if (query.category) filter.category = query.category;');
    expect(helperLines).toContain('if (query.inStock) filter.stock = { $gt: 0 };');
  });

  it('explains the variables inside an object filter, and names a parameter as the caller’s', () => {
    const filter = query('countDocuments').parts[0]!;
    const byName = new Map(filter.variables!.map((variable) => [variable.name, variable]));
    expect(byName.get('ownerId')?.parameterOf).toBe('countMatches');
    const or = byName.get('or')!.builtBy!.map((line) => line.text);
    expect(or).toEqual([
      'const or = [];',
      'if (input.name) or.push({ name: input.name });',
      'if (input.sku) or.push({ sku: input.sku });',
    ]);
  });

  it('carries no time for a query nobody has run, and the recorded time for one that has', () => {
    const before = actionQueries(scanned.graph, flow!);
    expect(before.measured).toBe(0);
    expect(before.queries[0]!.timing).toBeUndefined();
    expect(before.dbMs).toBeUndefined();

    // What a merged runtime trace leaves on the node.
    const node = scanned.graph.node(before.queries[0]!.nodeId)!;
    node.timing = {
      count: 2,
      totalMs: 300,
      minMs: 100,
      maxMs: 200,
      avgMs: 150,
      selfTotalMs: 300,
      avgSelfMs: 150,
    };
    const after = actionQueries(scanned.graph, flow!);
    expect(after.measured).toBe(1);
    expect(after.queries[0]!.timing?.avgMs).toBe(150);
    expect(after.dbMs).toBe(150);
    delete node.timing;
  });
});
