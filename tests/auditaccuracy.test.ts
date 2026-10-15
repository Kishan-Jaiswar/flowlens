import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  actionDecisions,
  appSidebar,
  renderDecisionTree,
  flowTiming,
  explainAction,
  flowPages,
  FlowGraph,
  mergeRuntimeTrace,
  renderActionDocument,
  resolveFlows,
  scan,
  SourceReader,
} from '@flowslens/core';

/**
 * What an audit of a real Next.js + Mongo app found the Docs tab saying wrong,
 * each pinned on the smallest app that shows it:
 *
 *  - server steps sorted alphabetically: the service before the access check
 *    the handler runs first;
 *  - a toast and a login in `onSuccess` listed before the request they wait for;
 *  - a check halfway down the handler called one that runs "before any work";
 *  - every page load read "Success: nothing visible · Error: not handled"
 *    while its skeleton, error state and data were right there in the JSX;
 *  - runtime tracing turned a click on a menu link, which only loads a page,
 *    into an action "GET /settings" with "no auth check" on it;
 *  - `<button onClick={onClick}>` inside a button component listed a second,
 *    wordless action beside the page's own;
 *  - a sort button only drawn for `<TH sortable onSort>` was listed on a page
 *    with plain `<TH>`s, and two private `StatusBadge`s carried one file's
 *    pager onto a page that never renders it;
 *  - a write in a module's private helper, and the second of two identical
 *    queries in one function, were missing from every tab;
 *  - a job put on a queue ended the flow at "enqueued": the worker that writes
 *    the rows, in another process, was never shown;
 *  - names nobody can read: "as", "button onClick", "Import row s
 *    (\${n} ignored)", a dialog's close called by the dialog's title, a
 *    form's submit called "ItemForm onSubmit" beside a second "Save" that
 *    sends nothing;
 *  - a click that changes a query's input (page, filter, job id) read "No
 *    request", and a query switched off by `enabled` was counted as loading
 *    when the screen opens.
 */

const project = mkdtempSync(join(tmpdir(), 'flowlens-audit-'));
const write = (rel: string, text: string): void => {
  mkdirSync(join(project, rel, '..'), { recursive: true });
  writeFileSync(join(project, rel), text, 'utf8');
};

write('tsconfig.json', JSON.stringify({ compilerOptions: { paths: { '@/*': ['./*'] } } }));
write(
  'package.json',
  JSON.stringify({ dependencies: { next: '15.0.0', react: '19.0.0', mongodb: '6.0.0' } }),
);

write(
  'lib/server.ts',
  `import { hasAccess } from './access';
   export async function requireShop(request) {
     const ok = await hasAccess(request.headers.get('x-shop'));
     if (!ok) return { error: Response.json({ error: 'No access' }, { status: 403 }) };
     return { shopId: request.headers.get('x-shop') };
   }`,
);
write(
  'lib/access.ts',
  `import { db } from './db';
   export async function hasAccess(shop) {
     const found = await db.collection('shops').findOne({ _id: shop });
     return Boolean(found);
   }`,
);
write('lib/db.ts', `export const db = globalThis.client.db('app');`);
write(
  'lib/store.ts',
  `import { db } from './db';
   async function logRead(shopId) {
     await db.collection('logs').insertOne({ shopId, at: Date.now() });
   }
   export async function aggregateStats(shopId) {
     const items = await db.collection('items').find({ shopId }).toArray();
     const recent = await db.collection('items').find({ shopId, recent: true }).toArray();
     await logRead(shopId);
     return { count: items.length, recent };
   }
   export async function checkCode(code) {
     const row = await db.collection('codes').findOne({ code });
     return Boolean(row);
   }`,
);
write(
  'app/api/stats/route.ts',
  `import { requireShop } from '@/lib/server';
   import { aggregateStats } from '@/lib/store';
   export async function GET(request) {
     const ctx = await requireShop(request);
     if ('error' in ctx) return ctx.error;
     return Response.json(await aggregateStats(ctx.shopId));
   }`,
);
write(
  'app/api/verify/route.ts',
  `import { aggregateStats, checkCode } from '@/lib/store';
   export async function POST(request) {
     const body = await request.json();
     const stats = await aggregateStats(body.shop);
     const ok = await checkCode(body.code);
     if (!ok) return Response.json({ error: 'Wrong code' }, { status: 401 });
     return Response.json(stats);
   }`,
);
write(
  'lib/toast.tsx',
  `'use client';
   import { createContext, useContext } from 'react';
   const ToastContext = createContext(null);
   export function ToastProvider({ children }) {
     const toast = (message) => {
       window.dispatchEvent(new CustomEvent('toast', { detail: message }));
     };
     const remember = (user) => {
       localStorage.setItem('user', user);
     };
     return <ToastContext.Provider value={{ toast, remember }}>{children}</ToastContext.Provider>;
   }
   export function useToast() {
     return useContext(ToastContext);
   }`,
);
write(
  'lib/api.ts',
  `import { useMutation, useQuery } from '@tanstack/react-query';
   export function useVerify() {
     return useMutation({
       mutationFn: async (code) => {
         const res = await fetch('/api/verify', { method: 'POST', body: JSON.stringify({ code }) });
         return res.json();
       },
     });
   }
   export function useStats() {
     return useQuery({
       queryKey: ['stats'],
       queryFn: async () => (await fetch('/api/stats')).json(),
     });
   }`,
);
write(
  'app/verify/page.tsx',
  `'use client';
   import { useToast } from '@/lib/toast';
   import { useVerify } from '@/lib/api';
   export default function VerifyPage() {
     const verify = useVerify();
     const { toast, remember } = useToast();
     const submit = () => {
       verify.mutate('1234', {
         onSuccess: (data) => {
           remember(data.user);
           toast('Welcome');
         },
       });
     };
     return <button onClick={submit}>Verify</button>;
   }`,
);
write(
  'app/stats/page.tsx',
  `'use client';
   import { useStats } from '@/lib/api';
   function Skeleton() { return <div className="pulse" />; }
   function EmptyState({ title }) { return <p>{title}</p>; }
   export default function StatsPage() {
     const { data, isLoading, isError } = useStats();
     if (isLoading) return <Skeleton />;
     if (isError) return <EmptyState title="Could not load stats" />;
     return <p>{data.count}</p>;
   }`,
);

write(
  'components/table.tsx',
  `export function TH({ sortable, onSort, children }) {
     return <th>{sortable ? <button onClick={onSort}>{children}</button> : children}</th>;
   }
   export function IconBtn({ title, onClick, children }) {
     return <button title={title} onClick={onClick}>{children}</button>;
   }
   export function Pager({ page, onPage }) {
     return <button onClick={() => onPage(page + 1)}>Next page</button>;
   }`,
);
write('components/badge.tsx', `export function StatusBadge({ s }) { return <b>{s}</b>; }`);
write(
  'components/history.tsx',
  `import { Pager } from './table';
   function StatusBadge({ s }) { return <i>{s}</i>; }
   export function History() {
     return <div><StatusBadge s="x" /><Pager page={1} onPage={(p) => console.log(p)} /></div>;
   }`,
);
write(
  'app/list/page.tsx',
  `'use client';
   import { useState } from 'react';
   import { TH, IconBtn } from '@/components/table';
   import { History } from '@/components/history';
   export default function ListPage() {
     const [sort, setSort] = useState('a');
     const [gone, setGone] = useState(false);
     return (
       <div>
         <TH sortable onSort={() => setSort(sort === 'a' ? 'b' : 'a')}>Name</TH>
         <IconBtn title="Delete" onClick={() => setGone(true)}><TrashIcon /></IconBtn>
         <History />
       </div>
     );
   }`,
);
write(
  'app/detail/page.tsx',
  `'use client';
   import { TH } from '@/components/table';
   import { StatusBadge } from '@/components/badge';
   export default function DetailPage() {
     return <div><TH>Batch</TH><StatusBadge s="ok" /></div>;
   }`,
);

write(
  'lib/jobs.ts',
  `import { Queue, Worker } from 'bullmq';
   import { db } from './db';
   export const IMPORT_QUEUE = 'item-import';
   export function getImportQueue() {
     return new Queue(IMPORT_QUEUE, { connection: {} });
   }
   export async function processImport(job) {
     await db.collection('items').insertMany(job.data.rows);
   }
   export function startWorker() {
     return new Worker(IMPORT_QUEUE, (job) => processImport(job), { connection: {} });
   }`,
);
write(
  'app/api/import/route.ts',
  `import { getImportQueue } from '@/lib/jobs';
   export async function POST(request) {
     const body = await request.json();
     const queue = getImportQueue();
     await queue.add('import', { rows: body.rows });
     return Response.json({ queued: true }, { status: 202 });
   }`,
);
write(
  'app/import/page.tsx',
  `'use client';
   export default function ImportPage() {
     const run = async () => {
       await fetch('/api/import', { method: 'POST', body: JSON.stringify({ rows: [] }) });
     };
     return <button onClick={run}>Import rows</button>;
   }`,
);

write(
  'components/forms.tsx',
  `'use client';
   import { useState } from 'react';
   export function Dialog({ title, onClose, children }) {
     return <div><div className="backdrop" onClick={onClose} /><h2>{title}</h2>{children}</div>;
   }
   export function ItemForm({ mode, onSubmit, onCancel }) {
     const [name, setName] = useState('');
     const handleSubmit = (e) => {
       e.preventDefault();
       if (!name) return;
       onSubmit({ name });
     };
     return (
       <form onSubmit={handleSubmit}>
         <input value={name} onChange={(e) => setName(e.target.value)} />
         <button type="button" onClick={onCancel}>Cancel</button>
         <button type="submit">{mode === 'create' ? 'Save item' : 'Update item'}</button>
       </form>
     );
   }`,
);
write(
  'app/items/page.tsx',
  `'use client';
   import { useState } from 'react';
   import { Dialog, ItemForm } from '@/components/forms';
   const KINDS = [{ value: 'in', label: 'Add stock' }, { value: 'out', label: 'Remove stock' }];
   export default function ItemsPage() {
     const [open, setOpen] = useState(false);
     const [kind, setKind] = useState('in');
     const [count, setCount] = useState(0);
     const [shop, setShop] = useState('');
     const create = async (item) => {
       await fetch('/api/items', { method: 'POST', body: JSON.stringify(item) });
     };
     const update = async (item) => {
       await fetch('/api/items/1', { method: 'PUT', body: JSON.stringify(item) });
     };
     return (
       <div>
         {KINDS.map((k) => (
           <button key={k.value} onClick={() => setKind(k.value)}>{k.label}</button>
         ))}
         <button onClick={() => setCount(count + 1)}>Import {count} row{count === 1 ? '' : 's'}</button>
         <div>
           <p>Switch shop</p>
           {['a', 'b'].map((id) => (
             <button key={id} onClick={() => setShop(id)}>
               <span>as</span> {id}
             </button>
           ))}
         </div>
         <div onMouseDown={(e) => e.preventDefault()}>{shop}</div>
         <Dialog title="New item" onClose={() => setOpen(false)}>
           <ItemForm mode="create" onSubmit={create} onCancel={() => setOpen(false)} />
         </Dialog>
         <ItemForm mode="edit" onSubmit={update} onCancel={() => setOpen(!open)} />
       </div>
     );
   }`,
);

write(
  'lib/listing.ts',
  `import { useQuery } from '@tanstack/react-query';
   export function useListing(query) {
     return useQuery({ queryKey: ['listing', query], queryFn: () => fetch('/api/listing?page=' + query.page) });
   }
   export function useArchive(page) {
     return useQuery({ queryKey: ['archive', page], queryFn: () => fetch('/api/archive?page=' + page) });
   }
   export function useJob(jobId) {
     return useQuery({ queryKey: ['job', jobId], enabled: !!jobId, queryFn: () => fetch('/api/job?id=' + jobId) });
   }`,
);
write(
  'app/listing/page.tsx',
  `'use client';
   import { useMemo, useState } from 'react';
   import { useListing, useJob } from '@/lib/listing';
   import { Pager } from '@/components/table';
   export default function ListingPage() {
     const [page, setPage] = useState(1);
     const [step, setStep] = useState('pick');
     const [jobId, setJobId] = useState(null);
     const query = useMemo(() => ({ page }), [page]);
     const { data } = useListing(query);
     const job = useJob(step === 'running' ? jobId : null);
     return (
       <div>
         <button onClick={() => setPage(page + 1)}>Next page</button>
         <button onClick={() => { setStep('running'); setJobId('42'); }}>Start job</button>
         <button onClick={() => setStep('pick')}>Back to pick</button>
         <p>{data?.length}{job.data?.state}</p>
         <Pager page={page} onPage={setPage} />
       </div>
     );
   }`,
);

write(
  'app/archive/page.tsx',
  `'use client';
   import { useState } from 'react';
   import { useArchive } from '@/lib/listing';
   import { Pager } from '@/components/table';
   export default function ArchivePage() {
     const [page, setPage] = useState(1);
     const { data } = useArchive(page);
     return <div>{data?.length}<Pager page={page} onPage={setPage} /></div>;
   }`,
);

write(
  'app/listing/remove/page.tsx',
  `'use client';
   import { useMutation, useQueryClient } from '@tanstack/react-query';
   export default function RemovePage() {
     const qc = useQueryClient();
     const remove = useMutation({
       mutationFn: () => fetch('/api/listing/1', { method: 'DELETE' }),
       onSuccess: () => qc.invalidateQueries({ queryKey: ['listing'] }),
     });
     return <button onClick={() => remove.mutate()}>Remove listing</button>;
   }`,
);

write(
  'app/inline/page.tsx',
  `'use client';
   import { useQuery } from '@tanstack/react-query';
   export default function InlinePage() {
     const { data } = useQuery({ queryKey: ['inline'], queryFn: () => fetch('/api/inline') });
     return <p>{data?.length}</p>;
   }`,
);

write(
  'lib/session.tsx',
  `'use client';
   import { createContext, useContext, useEffect } from 'react';
   import { useRouter } from 'next/navigation';
   import { useQuery } from '@tanstack/react-query';
   const SessionContext = createContext(null);
   export function SessionProvider({ children }) {
     const { data: user, isPending, isError } = useQuery({
       queryKey: ['session'],
       queryFn: () => fetch('/api/session').then((res) => res.json()),
     });
     const status = isPending ? 'loading' : isError || !user ? 'guest' : 'member';
     return <SessionContext.Provider value={{ user, status }}>{children}</SessionContext.Provider>;
   }
   export function useSession() {
     return useContext(SessionContext);
   }
   export function MemberArea({ children }) {
     const { status } = useSession();
     const router = useRouter();
     useEffect(() => {
       if (status === 'guest') router.replace('/signin');
     }, [status, router]);
     if (status !== 'member') return <Spinner />;
     return <main>{children}</main>;
   }
   function Spinner() { return <div className="spin" />; }`,
);

write(
  'app/tabs/page.tsx',
  `'use client';
   import { useState } from 'react';
   import { useQuery } from '@tanstack/react-query';
   function Archive() {
     const { data } = useQuery({ queryKey: ['archive-tab'], queryFn: () => fetch('/api/archive-tab') });
     return <p>{data?.length}</p>;
   }
   export default function TabsPage() {
     const [tab, setTab] = useState('live');
     return (
       <div>
         <button onClick={() => setTab('live')}>Live</button>
         <button onClick={() => setTab('archive')}>Archived</button>
         {tab === 'archive' && <Archive />}
       </div>
     );
   }`,
);

write(
  'components/sidebar.tsx',
  `'use client';
   import Link from 'next/link';
   const NAV = [
     { label: 'Invoices', href: '/invoices' },
     { label: 'Stats', href: '/stats' },
     { label: 'Listing', href: '/listing' },
   ];
   export function Sidebar() {
     return <nav>{NAV.map((item) => <Link key={item.href} href={item.href}>{item.label}</Link>)}</nav>;
   }`,
);
write(
  'app/layout.tsx',
  `import { Sidebar } from '@/components/sidebar';
   export default function RootLayout({ children }) {
     return <html><body><Sidebar />{children}</body></html>;
   }`,
);
write(
  'components/PopupContainer.js',
  `export function PopupContainer({ isOpen, onClose, children }) {
     return isOpen ? <div className="popup">{children}<button aria-label="Close" onClick={onClose}>x</button></div> : null;
   }`,
);
write(
  'app/invoices/page.tsx',
  `'use client';
   import { useEffect, useState } from 'react';
   import { PopupContainer } from '@/components/PopupContainer';
   export default function InvoicesPage() {
     const [open, setOpenReportPopup] = useState(false);
     const [page, setPage] = useState(1);
     const [query, setQuery] = useState('');
     const [bills, setBills] = useState([]);
     const load = async () => {
       const res = await fetch('/api/invoices?page=' + page + '&q=' + query);
       setBills(await res.json());
     };
     useEffect(() => { load(); }, [page, query]);
     const download = async () => {
       await fetch('/api/invoices/report');
     };
     return (
       <div>
         <button onClick={() => setOpenReportPopup(true)}>Download Report</button>
         <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search" />
         <table>
           {bills.map((bill) => (
             <tr key={bill.id}>
               <td>{bill.name}</td>
               <td><button onClick={() => fetch('/api/invoices/' + bill.id)}>View</button></td>
             </tr>
           ))}
         </table>
         <button onClick={() => setPage(page - 1)}>Previous</button>
         <button onClick={() => setPage(page + 1)}>Next</button>
         {open && (
           <PopupContainer isOpen={open} onClose={() => setOpenReportPopup(false)}>
             <button onClick={download}>Download</button>
           </PopupContainer>
         )}
       </div>
     );
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
const labels = (title: RegExp) => flowNamed(title).steps.map((step) => step.label);
const doc = (title: RegExp) =>
  renderActionDocument(explainAction(graph, flowNamed(title), { reader }));

describe('steps run in the order the code runs them', () => {
  it('puts the access check the handler calls first before the service it calls next', () => {
    const steps = labels(/Stats page loads/);
    expect(steps.indexOf('requireShop')).toBeLessThan(steps.indexOf('aggregateStats'));
    // A query sits under the function that runs it, not after every function.
    expect(steps.indexOf('shops.findOne')).toBeLessThan(steps.indexOf('aggregateStats'));
  });

  it('lists what onSuccess does after the request and the server work', () => {
    const steps = labels(/Verify$/);
    const request = steps.indexOf('POST /verify');
    expect(request).toBeGreaterThan(-1);
    expect(steps.indexOf('ToastProvider.toast')).toBeGreaterThan(steps.indexOf('codes.findOne'));
    expect(steps.indexOf('ToastProvider.remember')).toBeGreaterThan(request);
    expect(doc(/Verify$/)).toMatch(/submit → mutationFn → remember → toast/);
  });

  it('says a check halfway down the handler runs after the work before it', () => {
    expect(doc(/Verify$/)).toContain('runs inside the handler, after `aggregateStats`');
    expect(doc(/Stats page loads/)).toContain('runs before the handler does any work');
  });
});

describe('what a page load shows', () => {
  it('reads the loading, error and data branches from the component', () => {
    const text = doc(/Stats page loads/);
    expect(text).toContain('while it loads, a loading placeholder shows');
    expect(text).toContain('"Could not load stats" shows');
    expect(text).toContain('the data it loaded appears on screen');
    expect(text).not.toContain('not handled');
  });
});

describe('runtime tracing', () => {
  it('does not turn the browser opening a page into an API action', () => {
    const traced = FlowGraph.fromJSON(structuredClone(graph.toJSON()));
    const span = { v: 1 as const, traceId: 't1', startedAt: 1, durationMs: 0 };
    mergeRuntimeTrace(traced, [
      { ...span, spanId: 'a', kind: 'ui-action', name: 'Verify', attrs: { tag: 'a' } },
      {
        ...span,
        spanId: 'b',
        parentSpanId: 'a',
        kind: 'http-client',
        name: 'GET /verify',
        durationMs: 40,
        attrs: { httpMethod: 'GET', path: '/verify', statusCode: 200 },
      },
    ]);
    const after = resolveFlows(traced, { includeLocalOnly: true });
    expect(after.flatMap((flow) => flow.endpoints)).not.toContain('GET /verify');
    expect(traced.allNodes().filter((node) => node.evidence === 'runtime')).toEqual([]);
  });
});

describe('which page an action is on', () => {
  const pages = flowPages(graph, flows);
  const routesOf = (component: string) =>
    flows
      .filter((flow) => flow.component === component)
      .flatMap((flow) => (pages.get(flow.id) ?? []).map((page) => page.route));

  it("does not list a button component's own click beside the page's", () => {
    expect(flows.filter((flow) => flow.component === 'IconBtn')).toEqual([]);
    expect(flows.some((flow) => flow.component === 'ListPage' && /Delete/.test(flow.title))).toBe(
      true,
    );
  });

  it('places a control only where the component is given what it needs', () => {
    expect(routesOf('TH')).toEqual(['/list']);
  });

  it('does not follow a component name another file defines for itself', () => {
    expect(routesOf('Pager')).toContain('/list');
    expect(routesOf('Pager')).not.toContain('/detail');
  });
});

describe('what reaches the database', () => {
  it('follows a private helper and keeps two identical queries apart', () => {
    const steps = labels(/Stats page loads/);
    expect(steps.filter((label) => label === 'items.find')).toHaveLength(2);
    expect(steps).toContain('logs.insertOne');
  });
});

describe('a job queue', () => {
  it('follows the job to the worker, after the request has answered', () => {
    const flow = flowNamed(/Import rows/);
    const worker = flow.steps.find((step) => step.label === 'processImport');
    expect(worker?.background).toBe(true);
    expect(flow.steps.map((step) => step.label)).toContain('items.insertMany');
    expect(doc(/Import rows/)).toContain('Later, in a background worker (queue `item-import`)');
  });
});

describe('what an action is called', () => {
  const names = flows.filter((flow) => flow.component === 'ItemsPage').map((flow) => flow.label);

  it('names each control by what the user reads on it', () => {
    expect(names).toContain('Add stock / Remove stock');
    expect(names).toContain('Import rows');
    expect(names).toContain('Switch shop');
    expect(names).toContain('Close "New item"');
    expect(names.some((name) => /onClick|onMouseDown|^as$/.test(name))).toBe(false);
  });

  it('names a form component by its own submit button, as this page sets it', () => {
    const save = flows.find((flow) => flow.component === 'ItemsPage' && flow.label === 'Save item');
    const update = flows.find(
      (flow) => flow.component === 'ItemsPage' && flow.label === 'Update item',
    );
    expect(save?.endpoints).toEqual(['POST /items']);
    expect(update?.endpoints).toEqual(['PUT /items/:param']);
    expect(names).toContain('Cancel');
  });

  it("does not list the dialog's backdrop beside the page's own close", () => {
    expect(flows.filter((flow) => flow.component === 'Dialog')).toEqual([]);
  });
});

describe('what a click makes the page fetch', () => {
  const endpoints = (label: string) =>
    flows.find((flow) => flow.component === 'ListingPage' && flow.label === label)?.endpoints;

  it('fetches again when a click changes what a query reads', () => {
    expect(endpoints('Next page')).toEqual(['GET /listing']);
    expect(endpoints('Start job')).toEqual(['GET /job']);
  });

  it('does not fetch what a click switches off, nor load it as the page opens', () => {
    expect(endpoints('Back to pick')).toEqual([]);
    expect(endpoints('ListingPage loads')).toEqual(['GET /listing']);
  });
});

describe('a control shared by several pages', () => {
  it("is one action per page, each making only its own page's request", () => {
    const pagers = flows.filter((flow) => flow.component === 'Pager');
    const pages = flowPages(graph, flows);
    const byRoute = Object.fromEntries(
      pagers.map((flow) => [
        (pages.get(flow.id) ?? []).map((page) => page.route).join(','),
        flow.endpoints,
      ]),
    );
    expect(byRoute['/listing']).toEqual(['GET /listing']);
    expect(byRoute['/archive']).toEqual(['GET /archive']);
  });
});

describe('timing', () => {
  it('does not time an action by a shared step another action ran', () => {
    const traced = FlowGraph.fromJSON(structuredClone(graph.toJSON()));
    const span = { v: 1 as const, traceId: 't2', startedAt: 1 };
    mergeRuntimeTrace(traced, [
      {
        ...span,
        spanId: 's',
        kind: 'http-server',
        name: 'GET /stats',
        durationMs: 30,
        attrs: { httpMethod: 'GET', path: '/stats', statusCode: 200 },
      },
      {
        ...span,
        spanId: 'q',
        parentSpanId: 's',
        kind: 'db',
        name: 'items.find',
        durationMs: 12,
        attrs: { collection: 'items', operation: 'find' },
      },
    ]);
    const after = resolveFlows(traced, { includeLocalOnly: true });
    const stats = after.find((flow) => /Stats page loads/.test(flow.title))!;
    const verify = after.find((flow) => flow.title === 'Verify')!;
    expect(flowTiming(stats).observed).toBe(true);
    // Verify runs aggregateStats -> items.find too, but was never traced itself.
    expect(verify.steps.some((step) => step.avgMs !== undefined)).toBe(true);
    expect(flowTiming(verify).observed).toBe(false);
    expect(verify.totalMs).toBeUndefined();
  });
});

describe('what an invalidation refetches', () => {
  it('matches by query key, not by a URL that happens to share a word', () => {
    const remove = flowNamed(/Remove listing/);
    const doc = explainAction(graph, remove, { reader });
    const text = renderActionDocument(doc);
    expect(text).toContain('`GET /listing` fetch again');
    // `/job` is keyed `["job"]`: invalidating `["listing"]` leaves it alone.
    expect(text).not.toMatch(/GET \/job`? fetch again|`GET \/job`, /);
  });
});

describe('React Query written in the component', () => {
  it('follows useMutation from the click and useQuery from the page opening', () => {
    expect(flowNamed(/Remove listing/).endpoints).toEqual(['DELETE /listing/:param']);
    expect(flowNamed(/Inline page loads/).endpoints).toEqual(['GET /inline']);
  });
});

describe('a load read through context', () => {
  it('follows what the provider shares to the components that act on it', () => {
    const text = doc(/Session provider loads/);
    expect(text).toContain('the user is sent to `/signin`');
    expect(text).toContain('while it loads, a loading placeholder shows');
    expect(text).not.toContain('not handled');
  });
});

describe('a part shown only on a tab', () => {
  it('loads when the tab is opened, not with the page', () => {
    const load = flows.find((flow) => flow.component === 'Archive' && flow.event === 'mount')!;
    expect(load.steps[0]?.meta?.['shownWhen']).toBe("tab === 'archive'");
    const tab = (label: string) =>
      flows.find((flow) => flow.component === 'TabsPage' && flow.label === label)?.endpoints;
    expect(tab('Archived')).toEqual(['GET /archive-tab']);
    expect(tab('Live')).toEqual([]);
  });
});

describe("a page's features", () => {
  it('nests a popup under its button, rows under one part, and the pager as one', () => {
    const nav = appSidebar(graph, flows, { reader });
    const find = (
      entries: NonNullable<typeof nav>['entries'],
    ): (typeof entries)[number] | undefined => {
      for (const entry of entries) {
        if (entry.route === '/invoices') return entry;
        const found = find(entry.children);
        if (found) return found;
      }
      return undefined;
    };
    const page = find(nav?.entries ?? [])!;
    expect(page).toBeDefined();
    const label = (id: string) => flows.find((flow) => flow.id === id)?.label;
    const report = page.children.find((child) => child.label === 'Download Report')!;
    expect(report.openedBy).toBeDefined();
    expect(report.actions.map(label)).toContain('Download');
    expect(page.children.some((child) => child.label === 'Each bill' && child.repeated)).toBe(true);
    expect(page.children.some((child) => child.label === 'Previous / Next')).toBe(true);
    // At the top: only what the user picks from the page.
    expect(page.actions.map(label)).not.toContain('Download');
    expect(page.actions.map(label)).not.toContain('Previous');
    // The search reloads the list through the effect that watches it.
    const search = flows.find(
      (flow) => flow.component === 'InvoicesPage' && flow.label === 'Search',
    );
    expect(search?.endpoints).toEqual(['GET /invoices']);
  });
});

describe('a feature behind a popup', () => {
  it('runs from the button that opens it to the request its popup sends', () => {
    const report = flows.find(
      (flow) => flow.component === 'InvoicesPage' && flow.label === 'Download Report',
    )!;
    expect(report.endpoints).toEqual(['GET /invoices/report']);
    const tree = renderDecisionTree(actionDecisions(graph, report, { reader }));
    expect(tree).toContain('in the popup, the user presses "Download"');
    expect(renderActionDocument(explainAction(graph, report, { reader }))).toContain(
      'then in the popup presses **"Download"**',
    );
  });
});
