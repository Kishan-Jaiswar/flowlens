import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { resolveFlows, scan } from '@flowslens/core';

/**
 * The other common full-stack shape: one Next.js App Router project, the native
 * MongoDB driver behind a collections factory, and React Query hooks instead of
 * direct calls. No NestJS, no Mongoose, no DTO classes.
 *
 * Scanned as-is, a real project of this shape produced 21 routes, zero
 * collections and 3 of 121 actions reaching the backend — every layer was
 * technically "supported" while the chain broke at three separate joints.
 */
const project = mkdtempSync(join(tmpdir(), 'flowlens-next-'));

mkdirSync(join(project, 'app', 'api', 'products'), { recursive: true });
mkdirSync(join(project, 'features'), { recursive: true });
mkdirSync(join(project, 'lib', 'db'), { recursive: true });

// The collections factory: the literal names live here, in a different file
// from every query, and one of them does not match its property name.
writeFileSync(
  join(project, 'lib', 'db', 'mongo.ts'),
  `import { MongoClient } from 'mongodb';
   export function rawCollections(db) {
     return {
       products: db.collection('products'),
       movements: db.collection('movements'),
       smsTemplates: db.collection('smsendpointmaps'),
     };
   }
   export async function getCollections() { return rawCollections(await getDb()); }`,
  'utf8',
);

// The queries, in a plain module the route calls.
writeFileSync(
  join(project, 'lib', 'db', 'store.ts'),
  `import { getCollections } from './mongo';

   export async function listProducts(query) {
     const { products } = await getCollections();
     return products.find({ name: query.name }).toArray();
   }

   export async function createProduct(input) {
     const { products } = await getCollections();
     return products.insertOne(input);
   }

   export async function removeProduct(id) {
     const { products } = await getCollections();
     return products.deleteOne({ _id: id });
   }

   export async function recordMovement(entry) {
     const { movements } = await getCollections();
     return movements.insertOne(entry);
   }

   export function formatProduct(doc) { return doc.name.trim(); }`,
  'utf8',
);

// One App Router module exporting three verbs.
writeFileSync(
  join(project, 'app', 'api', 'products', 'route.ts'),
  `import { listProducts, createProduct, removeProduct, recordMovement } from '@/lib/db/store';

   export async function GET(request) {
     return Response.json(await listProducts({ name: 'x' }));
   }

   export async function POST(request) {
     const body = await request.json();
     const created = await createProduct(body);
     await recordMovement({ id: created.insertedId });
     return Response.json(created);
   }

   export async function DELETE(request) {
     return Response.json(await removeProduct('1'));
   }`,
  'utf8',
);

// React Query hooks: the request lives inside the hook, not the handler.
writeFileSync(
  join(project, 'features', 'api.ts'),
  `import { useMutation, useQuery } from '@tanstack/react-query';
   import axios from 'axios';

   export function useProducts(page) {
     return useQuery({
       queryKey: ['products', page],
       queryFn: async () => {
         const { data } = await axios.get('/products?page=1&size=20');
         return data;
       },
     });
   }

   export function useCreateProduct() {
     return useMutation({
       mutationFn: async (input) => {
         const { data } = await axios.post('/products', { name: input.name, sku: input.sku });
         return data;
       },
     });
   }`,
  'utf8',
);

// The component: `const create = useCreateProduct()` then `create.mutate(...)`.
writeFileSync(
  join(project, 'features', 'AddProductDialog.jsx'),
  `import { useCreateProduct } from './api';

   export function AddProductDialog() {
     const create = useCreateProduct();
     const submit = (values) => {
       create.mutate(values);
     };
     return <button onClick={submit}>Add Product</button>;
   }`,
  'utf8',
);

/**
 * Default `apiPrefixes` (`['/api']`) on purpose: an App Router project serves
 * `app/api/products/route.ts` at `/api/products` and its client calls
 * `/products` against a base URL of `/api`. Stripping on only one side is
 * exactly the mismatch that leaves routes and calls unjoined.
 */
writeFileSync(
  join(project, 'features', 'ProductsPage.jsx'),
  `import { useProducts } from './api';

   export function ProductsPage() {
     const { data } = useProducts(1);
     return <div>{data?.length}</div>;
   }`,
  'utf8',
);

const result = scan({ root: project });
const flows = resolveFlows(result.graph, { includeLocalOnly: true });
const add = flows.find((flow) => flow.label === 'Add Product');

describe('collections behind a factory', () => {
  const names = result.graph.nodesOfKind('collection').map((node) => node.label);

  it('resolves a destructured handle to its collection', () => {
    // `const { products } = await getCollections()` — nothing local to read.
    expect(names).toContain('products');
    expect(names).toContain('movements');
  });

  it('reads the literal rather than conventionalising the property name', () => {
    // `smsTemplates: db.collection('smsendpointmaps')` — the two differ, so a
    // name-based guess would invent a collection that does not exist.
    expect(names).not.toContain('smstemplates');
  });
});

describe('queries in a plain module the route calls', () => {
  it('reaches the module functions from the route', () => {
    const labels = result.graph.allNodes().map((node) => node.label);
    expect(labels).toContain('listProducts');
    expect(labels).toContain('createProduct');
  });

  it('drops module functions that reach no query', () => {
    // `formatProduct` is an ordinary helper and does not belong in the graph.
    expect(result.graph.allNodes().map((n) => n.label)).not.toContain('formatProduct');
  });
});

/**
 * `const create = useCreateProduct(); create.mutate(values)` — the request is
 * two indirections away from the click, and the middle one is a method on an
 * object the hook returned.
 */
describe('React Query mutation hooks', () => {
  it('traces the click through the hook to the request', () => {
    expect(add).toBeDefined();
    expect(add?.endpoints).toContain('POST /products');
  });

  it('reports the hook as part of the action', () => {
    expect(add?.hooks).toContain('useCreateProduct');
  });

  it('carries on to the collection', () => {
    expect(add?.collections.map((c) => `${c.collection}:${c.effect}`)).toContain('products:create');
  });

  it('picks up query parameters written into the path', () => {
    const list = flows.find((flow) => flow.endpoints.includes('GET /products'));
    const call = list?.steps.find((step) => step.kind === 'api-call');
    expect(call?.detail?.queryKeys).toEqual(['page', 'size']);
  });

  /**
   * `useQuery` fetches on render, so the page load is a real action. Excluding
   * every hook from mount actions hid it entirely.
   */
  it('treats a useQuery page load as an action', () => {
    const load = flows.find((flow) => flow.event === 'mount' && flow.component === 'ProductsPage');
    expect(load).toBeDefined();
    expect(load?.endpoints).toContain('GET /products');
  });

  it('does not invent a mount action from a mutation hook', () => {
    // AddProductDialog only holds `useCreateProduct`, which fires on click.
    const load = flows.find(
      (flow) => flow.event === 'mount' && flow.component === 'AddProductDialog',
    );
    expect(load).toBeUndefined();
  });
});

/**
 * One `route.ts` exporting GET, POST and DELETE used to share a single handler
 * node, so an edit reported the delete's query — a phantom destructive
 * operation on a flow that only updates.
 */
describe('a route module exporting several verbs', () => {
  const effectsFor = (endpoint: string) => {
    const flow = flows.find((candidate) => candidate.endpoints.includes(endpoint));
    return (flow?.collections ?? []).map((c) => `${c.collection}:${c.effect}`).sort();
  };

  it('scopes each verb to its own queries', () => {
    expect(effectsFor('POST /products')).toEqual(['movements:create', 'products:create']);
  });

  it('does not leak the DELETE into the GET', () => {
    const flow = flows.find((candidate) => candidate.endpoints.includes('GET /products'));
    const effects = (flow?.collections ?? []).map((c) => c.effect);
    expect(effects).not.toContain('delete');
    expect(effects).toContain('read');
  });
});

rmSync(project, { recursive: true, force: true });
