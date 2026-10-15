import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { projectFindings, scan } from '@flowslens/core';

/**
 * Findings learn a project's own words. This app is a garage's: its tenant is
 * `garageId` and its check is `requireGarage` — names no list in Flowslens
 * holds. The tenant is the id field its queries filter by across collections,
 * and the check is the helper that answers 401/403, whatever either is called.
 */

const project = mkdtempSync(join(tmpdir(), 'flowlens-findings-generic-'));
const write = (rel: string, text: string): void => {
  mkdirSync(join(project, rel, '..'), { recursive: true });
  writeFileSync(join(project, rel), text, 'utf8');
};

write('tsconfig.json', JSON.stringify({ compilerOptions: { paths: { '@/*': ['./*'] } } }));
write(
  'lib/db/mongo.ts',
  `export async function getCollections() {
     const db = await getDb();
     return { cars: db.collection('cars'), repairs: db.collection('repairs') };
   }`,
);
write(
  'lib/api/server.ts',
  `export async function requireGarage(request) {
     const user = readUser(request);
     if (!user) return { error: new Response("Sign in", { status: 401 }) };
     const garage = request.headers.get("x-garage");
     if (!(await isStaffOf(user, garage))) return { error: new Response("Not yours", { status: 403 }) };
     return { garageId: garage };
   }`,
);
write(
  'lib/db/store.ts',
  `import { getCollections } from './mongo';
   export async function listCars(garageId) {
     const { cars } = await getCollections();
     return cars.find({ garageId }).toArray();
   }
   export async function countCars(garageId) {
     const { cars } = await getCollections();
     return cars.countDocuments({ garageId });
   }
   export async function listRepairs(garageId, carId) {
     const { repairs } = await getCollections();
     return repairs.find({ garageId, carId }).toArray();
   }`,
);
write(
  'app/api/cars/route.ts',
  `import { requireGarage } from "@/lib/api/server";
   import { listCars, countCars } from "@/lib/db/store";
   export async function GET(request) {
     const ctx = await requireGarage(request);
     if ("error" in ctx) return ctx.error;
     return Response.json({ cars: await listCars(ctx.garageId), total: await countCars(ctx.garageId) });
   }`,
);
write(
  'app/api/repairs/route.ts',
  `import { listRepairs } from "@/lib/db/store";
   export async function GET(request) {
     const url = new URL(request.url);
     return Response.json(await listRepairs(url.searchParams.get("garage"), url.searchParams.get("car")));
   }`,
);

const result = projectFindings(scan({ root: project }).graph);

describe('findings in a project of its own words', () => {
  it('learns the tenant field from the queries, whatever it is called', () => {
    expect(result.tenantKey).toBe('garageId');
  });

  it('counts a helper that answers 401/403 as the auth check, whatever it is called', () => {
    const unguarded = result.findings
      .filter((finding) => finding.kind === 'no-auth')
      .map((finding) => finding.title);
    expect(unguarded).toEqual(['GET /repairs runs without any auth check']);
  });
});
