import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  actionDecisions,
  screenOutline,
  explainAction,
  projectFindings,
  renderActionDocument,
  renderDecisionTree,
  resolveFlows,
  scan,
  SourceReader,
} from '@flowslens/core';

/**
 * What a second audit of a Next.js + React Query + Mongo app found, each on
 * the smallest app that shows it:
 *
 *  - a dialog written as its own component (`<AddDialog open={addOpen} />`)
 *    read "stays in the browser": its form, the validation in it and the
 *    request it sends were never joined to the button that opens it;
 *  - `router.push(\`/items/${id}/edit\`)` read "stays in the browser", and
 *    the route was cut to `/items/…`;
 *  - a two-step popup — choose a file, then "Continue", then "Import" — took
 *    the dialog's own load for the thing pressed;
 *  - the search's `useDebounce` wait, a `.catch(() => {})` that ignores a
 *    failure, a route's own 503 in its `catch` and an upsert were missing;
 *  - two "Sign out" buttons on two screens of one component read the same;
 *  - the two tabs of a page were one list.
 */

const project = mkdtempSync(join(tmpdir(), 'flowlens-popup-'));
const write = (rel: string, text: string): void => {
  mkdirSync(join(project, rel, '..'), { recursive: true });
  writeFileSync(join(project, rel), text, 'utf8');
};

write('tsconfig.json', JSON.stringify({ compilerOptions: { paths: { '@/*': ['./*'] } } }));
write(
  'package.json',
  JSON.stringify({
    dependencies: {
      next: '15.0.0',
      react: '19.0.0',
      mongodb: '6.0.0',
      '@tanstack/react-query': '5.0.0',
      axios: '1.0.0',
    },
  }),
);
write(
  'lib/db.ts',
  `import { MongoClient } from 'mongodb';
   const client = new MongoClient(process.env.MONGODB_URI!);
   export const items = client.db('app').collection('items');
   export const settings = client.db('app').collection('settings');
   export async function createItem(input) {
     return items.insertOne(input);
   }
   export async function listItems(search) {
     const total = await items.countDocuments({ search });
     const size = 20;
     const docs = await items.find({ search }).limit(size).toArray();
     return { total, docs };
   }
   export async function saveSettings(value) {
     await settings.updateOne({ key: 'mapping' }, { $set: { value } }, { upsert: true });
   }`,
);
write(
  'lib/api.ts',
  `import axios from 'axios';
   export const api = axios.create({ baseURL: '/api' });`,
);
write(
  'hooks/use-debounce.ts',
  `import { useEffect, useState } from 'react';
   export function useDebounce(value, delay = 350) {
     const [debounced, setDebounced] = useState(value);
     useEffect(() => {
       const id = setTimeout(() => setDebounced(value), delay);
       return () => clearTimeout(id);
     }, [value, delay]);
     return debounced;
   }`,
);
write(
  'features/items/api.ts',
  `import { useMutation, useQuery } from '@tanstack/react-query';
   import { api } from '@/lib/api';
   export function useItems(search) {
     return useQuery({ queryKey: ['items', search], queryFn: async () => (await api.get('/items', { params: { search } })).data });
   }
   export function useCreateItem() {
     return useMutation({ mutationFn: async (values) => (await api.post('/items', values)).data });
   }
   export function useImport() {
     return useMutation({ mutationFn: async (rows) => (await api.post('/items/import', rows)).data });
   }
   export function usePreview() {
     return useMutation({ mutationFn: async (rows) => (await api.post('/items/preview', rows)).data });
   }
   export function useLogout() {
     return useMutation({ mutationFn: async () => (await api.post('/logout')).data });
   }`,
);
write(
  'features/items/item-form.tsx',
  `import { useState } from 'react';
   function FormField({ label, children }) { return <label>{label}{children}</label>; }
   export function ItemForm({ onSubmit, mode }) {
     const [values, setValues] = useState({ name: '' });
     const [error, setError] = useState('');
     const handleSubmit = (e) => {
       e.preventDefault();
       if (!values.name) {
         setError('Name is required');
         return;
       }
       onSubmit(values);
     };
     return (
       <form onSubmit={handleSubmit}>
         <FormField label="Item name">
           <input placeholder="Paracetamol 500mg" value={values.name} onChange={(e) => setValues({ name: e.target.value })} />
         </FormField>
         <button type="submit">{mode === 'create' ? 'Save item' : 'Update item'}</button>
       </form>
     );
   }`,
);
write(
  'features/items/add-dialog.tsx',
  `import { ItemForm } from './item-form';
   import { useCreateItem } from './api';
   export function AddDialog({ open, onClose }) {
     const create = useCreateItem();
     const onSubmit = (values) => {
       create.mutate(values, { onSuccess: () => onClose() });
     };
     if (!open) return null;
     return (
       <div role="dialog">
         <ItemForm mode="create" onSubmit={onSubmit} />
       </div>
     );
   }`,
);
write(
  'features/items/import-dialog.tsx',
  `import { useState } from 'react';
   import { useImport, usePreview } from './api';
   export function ImportDialog({ open }) {
     const preview = usePreview();
     const enqueue = useImport();
     const [file, setFile] = useState(null);
     const handleFile = (picked) => {
       if (!picked.name.endsWith('.xlsx')) return;
       setFile(picked);
     };
     const proceed = () => preview.mutate([file]);
     const runImport = () => enqueue.mutate([file]);
     if (!open) return null;
     return (
       <div role="dialog">
         <input type="file" onChange={(e) => handleFile(e.target.files[0])} />
         <button onClick={runImport}>Import rows</button>
         <button onClick={proceed}>Continue</button>
       </div>
     );
   }`,
);
write(
  'app/items/page.tsx',
  `'use client';
   import { useState } from 'react';
   import { useRouter } from 'next/navigation';
   import { useDebounce } from '@/hooks/use-debounce';
   import { useItems } from '@/features/items/api';
   import { AddDialog } from '@/features/items/add-dialog';
   import { ImportDialog } from '@/features/items/import-dialog';
   export default function ItemsPage() {
     const router = useRouter();
     const [search, setSearch] = useState('');
     const debouncedSearch = useDebounce(search);
     const { data } = useItems(debouncedSearch);
     const [addOpen, setAddOpen] = useState(false);
     const [importOpen, setImportOpen] = useState(false);
     return (
       <div>
         <h1>Items</h1>
         <input placeholder="Search items" value={search} onChange={(e) => setSearch(e.target.value)} />
         <button onClick={() => setAddOpen(true)}>Add item</button>
         <button onClick={() => setImportOpen(true)}>Import</button>
         {data?.docs.map((item) => (
           <div key={item.id}>
             <button onClick={() => router.push(\`/items/\${item.id}/edit\`)}>Edit</button>
           </div>
         ))}
         <AddDialog open={addOpen} onClose={() => setAddOpen(false)} />
         <ImportDialog open={importOpen} />
       </div>
     );
   }`,
);
write(
  'app/history/page.tsx',
  `'use client';
   import { useState } from 'react';
   import { useItems } from '@/features/items/api';
   function Uploads() {
     const { data } = useItems('uploads');
     return <button onClick={() => setTimeout(() => data, 0)}>Refresh uploads</button>;
   }
   export default function HistoryPage() {
     const [tab, setTab] = useState('moves');
     const [q, setQ] = useState('');
     return (
       <div>
         <button onClick={() => setTab('moves')}>Movements</button>
         <button onClick={() => setTab('files')}>Files</button>
         {tab === 'files' ? (
           <Uploads />
         ) : (
           <input placeholder="Search movements" value={q} onChange={(e) => setQ(e.target.value)} />
         )}
       </div>
     );
   }`,
);
write(
  'app/gate.tsx',
  `'use client';
   import { useRouter } from 'next/navigation';
   import { useLogout } from '@/features/items/api';
   export function Gate({ clinics, selected }) {
     const router = useRouter();
     const logout = useLogout();
     const signOut = async () => {
       await logout.mutateAsync().catch(() => {});
       router.replace('/login');
     };
     if (clinics.length === 0) {
       return (
         <div>
           <p className="font-semibold">No clinic access</p>
           <button onClick={signOut}>Sign out</button>
         </div>
       );
     }
     if (!selected) {
       return (
         <div>
           <h1>Choose a clinic</h1>
           <button onClick={signOut}>Sign out</button>
         </div>
       );
     }
     return null;
   }`,
);
write(
  'app/api/items/route.ts',
  `import { createItem, listItems } from '@/lib/db';
   export async function GET(request) {
     return Response.json(await listItems(new URL(request.url).searchParams.get('search')));
   }
   export async function POST(request) {
     const body = await request.json();
     return Response.json(await createItem(body), { status: 201 });
   }`,
);
write(
  'app/api/items/import/route.ts',
  `import { createItem } from '@/lib/db';
   export async function POST(request) {
     try {
       const rows = await request.json();
       await createItem(rows[0]);
       return Response.json({ ok: true }, { status: 202 });
     } catch (err) {
       return Response.json({ error: 'Could not queue the import' }, { status: 503 });
     }
   }`,
);
write(
  'app/api/items/preview/route.ts',
  `export async function POST(request) {
     return Response.json({ rows: await request.json() });
   }`,
);
write(
  'app/api/logout/route.ts',
  `export async function POST() {
     return Response.json({ ok: true });
   }`,
);
write(
  'app/api/settings/route.ts',
  `import { saveSettings } from '@/lib/db';
   export async function PUT(request) {
     await saveSettings(await request.json());
     return Response.json({ ok: true });
   }`,
);

const { graph } = scan({ root: project });
const flows = resolveFlows(graph, { includeLocalOnly: true });
const reader = new SourceReader(graph);
const flowNamed = (title: RegExp) => {
  const flow = flows.find((candidate) => title.test(candidate.title));
  expect(flow, `no action matching ${title}`).toBeDefined();
  return flow!;
};
const doc = (title: RegExp) =>
  renderActionDocument(explainAction(graph, flowNamed(title), { reader }));
const tree = (title: RegExp) =>
  renderDecisionTree(actionDecisions(graph, flowNamed(title), { reader }));

describe('a dialog written as its own component', () => {
  it('runs from the button that opens it, through the form inside, to its request', () => {
    const add = flowNamed(/Add item/);
    expect(add.endpoints).toEqual(['POST /items']);
    const text = doc(/Add item/);
    expect(text).toContain('then in the popup fills Item name and presses "Save item"');
    expect(text).toMatch(/stops if !values\.name/);
    expect(text).not.toContain('Nothing to fill in');
  });

  it('names the form button the way the place drawing it does', () => {
    expect(flows.some((flow) => flow.label === 'Save item')).toBe(true);
  });

  it('draws the steps of a two-step popup in order, after the file it reads', () => {
    const imported = flowNamed(/· Import$/);
    expect(imported.endpoints).toEqual(
      expect.arrayContaining(['POST /items/preview', 'POST /items/import']),
    );
    const text = tree(/· Import$/);
    const chose = text.indexOf('uses "Choose a file"');
    const next = text.indexOf('presses "Continue"');
    const last = text.indexOf('presses "Import rows"');
    expect(chose).toBeGreaterThan(-1);
    expect(next).toBeGreaterThan(chose);
    expect(last).toBeGreaterThan(next);
  });
});

describe('where a click goes', () => {
  it('reads every segment of a templated route', () => {
    const edit = flowNamed(/Edit/);
    const routes = edit.steps.flatMap((step) => step.meta?.['navigatesTo'] ?? []);
    expect(routes).toContain('/items/[param]/edit');
  });
});

describe('what the screen does before and after', () => {
  it('waits for the typing to stop before it searches', () => {
    expect(tree(/Search items/)).toContain('once the typing has stopped for 350 ms');
  });

  it('says a swallowed failure is ignored, and the steps after run anyway', () => {
    const text = doc(/Sign out — on "No clinic access"/);
    expect(text).toContain('Error: ignored, so the same steps run');
  });

  it('tells two buttons apart by the screen each is on', () => {
    expect(flows.some((flow) => flow.label === 'Sign out — on "Choose a clinic"')).toBe(true);
  });
});

describe('the server side', () => {
  it("lists a route's own answer from its catch", () => {
    expect(doc(/Import rows/)).toMatch(/\*\*503\*\* \| _anything in the try fails_/);
  });

  it('flags independent reads with plain work between them', () => {
    const titles = projectFindings(graph).findings.map((finding) => finding.title);
    expect(titles.some((title) => /independent reads in listItems/.test(title))).toBe(true);
  });

  it('records an update that inserts when nothing matches', () => {
    const op = graph.nodesOfKind('db-op').find((node) => node.label === 'settings.updateOne');
    expect(op?.meta?.['upsert']).toBe(true);
  });
});

describe("a page's tabs", () => {
  it("lists each tab's controls under that tab, named by its button", () => {
    type Part = { type: string; label?: string; children?: Part[] };
    const labels = (parts: Part[]): string[] =>
      parts.flatMap((part) => [part.label ?? '', ...labels(part.children ?? [])]);
    const found = labels(screenOutline(reader, 'app/history/page.tsx') as Part[]);
    expect(found).toContain('Files tab');
    expect(found).toContain('Movements tab');
  });
});
