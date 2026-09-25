import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { projectFindings, scan, type Finding } from '@flowslens/core';

/**
 * Findings: bugs the graph and the source can show.
 *
 * Each check is pinned twice — once on code that has the bug, once on the
 * near-identical code that does not — because the value of a findings list is
 * as much in what it leaves alone as in what it flags. A guarded route, a
 * public login route, an id the server made itself and reads already in
 * `Promise.all` must all stay quiet.
 */

const project = mkdtempSync(join(tmpdir(), 'flowlens-findings-'));
const write = (rel: string, text: string): void => {
  mkdirSync(join(project, rel, '..'), { recursive: true });
  writeFileSync(join(project, rel), text, 'utf8');
};

write('tsconfig.json', JSON.stringify({ compilerOptions: { paths: { '@/*': ['./*'] } } }));

write(
  'lib/db/mongo.ts',
  `export async function getCollections() {
     const db = await getDb();
     return { items: db.collection('items'), jobs: db.collection('jobs') };
   }`,
);

write(
  'lib/api/server.ts',
  `export function requireOwner(request) {
     const user = readUser(request);
     if (!user) return { error: new Response("Unauthorized", { status: 401 }) };
     return { ownerId: user.id };
   }`,
);

write(
  'lib/db/store.ts',
  `import { getCollections } from './mongo';
   export async function listItems(ownerId) {
     const { items } = await getCollections();
     return items.find({ ownerId }).toArray();
   }
   export async function countItems(ownerId) {
     const { items } = await getCollections();
     return items.countDocuments({ ownerId });
   }
   export async function deleteItem(ownerId, id) {
     const { items } = await getCollections();
     return items.deleteOne({ ownerId, id });
   }
   export async function getItem(id) {
     const { items } = await getCollections();
     return items.findOne({ id });
   }
   export async function listJobs(ownerId) {
     const { jobs } = await getCollections();
     return jobs.find({ ownerId }).toArray();
   }
   export async function markJobDone(id) {
     const { jobs } = await getCollections();
     await jobs.updateOne({ id }, { $set: { done: true } });
   }
   export async function createJob(ownerId) {
     const { jobs } = await getCollections();
     const record = { id: crypto.randomUUID(), ownerId };
     await jobs.insertOne(record);
     return record;
   }
   export async function summary(ownerId) {
     const { items } = await getCollections();
     const total = await items.countDocuments({ ownerId });
     const latest = await items.find({ ownerId }).limit(5).toArray();
     return { total, latest };
   }
   export async function summaryParallel(ownerId) {
     const { items } = await getCollections();
     const [total, latest] = await Promise.all([
       items.countDocuments({ ownerId }),
       items.find({ ownerId }).limit(5).toArray(),
     ]);
     return { total, latest };
   }`,
);

// Guarded, scoped, parallel: nothing to report.
write(
  'app/api/items/route.ts',
  `import { requireOwner } from "@/lib/api/server";
   import { listItems, summaryParallel } from "@/lib/db/store";
   export async function GET(request) {
     const ctx = requireOwner(request);
     if ("error" in ctx) return ctx.error;
     const items = await listItems(ctx.ownerId);
     return Response.json({ items, summary: await summaryParallel(ctx.ownerId) });
   }`,
);

// No guard at all, and the body written as is.
write(
  'app/api/items/import/route.ts',
  `import { getCollections } from "@/lib/db/mongo";
   export async function POST(request) {
     const body = await request.json();
     const { items } = await getCollections();
     await items.insertOne(body);
     return Response.json({ ok: true });
   }`,
);

// A client-supplied id, fetched without the tenant, once per id.
write(
  'app/api/items/batch/route.ts',
  `import { requireOwner } from "@/lib/api/server";
   import { getItem, summary } from "@/lib/db/store";
   export async function POST(request) {
     const ctx = requireOwner(request);
     if ("error" in ctx) return ctx.error;
     const params = await request.json();
     const found = [];
     for (const id of params.ids) found.push(await getItem(params.id ?? id));
     return Response.json({ found, summary: await summary(ctx.ownerId) });
   }`,
);

// The tenant named by the client.
write(
  'app/api/items/by-owner/route.ts',
  `import { requireOwner } from "@/lib/api/server";
   import { countItems } from "@/lib/db/store";
   export async function GET(request) {
     const ctx = requireOwner(request);
     if ("error" in ctx) return ctx.error;
     const ownerId = new URL(request.url).searchParams.get("ownerId");
     return Response.json({ count: await countItems(ownerId) });
   }`,
);

// The server makes the job id; the unscoped update is defence in depth only.
write(
  'app/api/jobs/route.ts',
  `import { requireOwner } from "@/lib/api/server";
   import { createJob, listJobs, markJobDone } from "@/lib/db/store";
   export async function POST(request) {
     const ctx = requireOwner(request);
     if ("error" in ctx) return ctx.error;
     const record = await createJob(ctx.ownerId);
     await markJobDone(record.id);
     return Response.json({ jobs: await listJobs(ctx.ownerId) });
   }`,
);

// Public by design.
write(
  'app/api/auth/login/route.ts',
  `export async function POST(request) {
     const body = await request.json();
     return Response.json({ token: sign(body.phone) });
   }`,
);

const scanned = scan({ root: project });
const result = projectFindings(scanned.graph);
const of = (kind: Finding['kind']): Finding[] =>
  result.findings.filter((finding) => finding.kind === kind);

describe('findings', () => {
  it('learns the tenant field from the queries that use it', () => {
    expect(result.tenantKey).toBe('ownerId');
  });

  it('flags the route with no guard, and leaves guarded and public routes alone', () => {
    const titles = of('no-auth').map((finding) => finding.title);
    expect(titles).toEqual(['POST /items/import runs without any auth check']);
    expect(of('no-auth')[0]!.severity).toBe('high');
  });

  it('flags the request body written as is', () => {
    const mass = of('mass-assignment');
    expect(mass).toHaveLength(1);
    expect(mass[0]!.severity).toBe('high');
    expect(mass[0]!.title).toContain('items.insertOne');
    expect(mass[0]!.at.file).toBe('app/api/items/import/route.ts');
  });

  it('flags a by-id query without the tenant, high when the id comes from the request', () => {
    const byId = of('tenant-scope').find((finding) => finding.title.includes('items.findOne'))!;
    expect(byId).toBeDefined();
    expect(byId.severity).toBe('high');
    expect(byId.why).toContain('taken from the request');
    expect(byId.related?.[0]?.text).toContain('scoped the right way');
  });

  it('calls an unscoped update low when every caller passes an id the server made', () => {
    const job = of('tenant-scope').find((finding) => finding.title.includes('jobs.updateOne'))!;
    expect(job).toBeDefined();
    expect(job.severity).toBe('low');
    expect(job.why).toContain('the server made itself');
  });

  it('leaves the scoped queries alone', () => {
    const titles = of('tenant-scope').map((finding) => finding.title);
    expect(titles.some((title) => title.includes('deleteOne'))).toBe(false);
    expect(titles.some((title) => title.includes('countDocuments'))).toBe(false);
  });

  it('flags the tenant id read off the request', () => {
    const fromRequest = of('tenant-from-request');
    expect(fromRequest).toHaveLength(1);
    expect(fromRequest[0]!.title).toContain('GET /items/by-owner');
    expect(fromRequest[0]!.code).toContain('searchParams.get("ownerId")');
  });

  it('flags a query run once per item, through the helper that holds it', () => {
    const loops = of('n-plus-one');
    expect(loops).toHaveLength(1);
    expect(loops[0]!.title).toContain('items.findOne');
    expect(loops[0]!.title).toContain('getItem');
    expect(loops[0]!.at.file).toBe('app/api/items/batch/route.ts');
    expect(loops[0]!.fix).toContain('$in');
  });

  it('flags independent reads awaited in turn, and not the ones already in Promise.all', () => {
    const sequential = of('sequential-awaits');
    expect(sequential).toHaveLength(1);
    expect(sequential[0]!.title).toContain('summary');
    expect(sequential[0]!.title).not.toContain('summaryParallel');
    expect(sequential[0]!.fix).toContain('Promise.all');
  });

  it('ties findings to the actions that reach them, and sorts the worst first', () => {
    const severities = result.findings.map((finding) => finding.severity);
    const rank = { high: 0, medium: 1, low: 2 };
    expect([...severities].sort((a, b) => rank[a] - rank[b])).toEqual(severities);
    for (const finding of result.findings) expect(finding.id).toContain(finding.at.file);
  });
});
