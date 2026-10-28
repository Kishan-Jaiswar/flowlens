import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { flowApis, resolveFlows, scan } from '@flowslens/core';

/**
 * `queryClient.invalidateQueries()` with no key: every cached query goes stale and
 * each one on screen is fetched again — switching the account or the clinic.
 */
const project = mkdtempSync(join(tmpdir(), 'flowlens-refetchall-'));
const write = (rel: string, text: string): void => {
  mkdirSync(join(project, rel, '..'), { recursive: true });
  writeFileSync(join(project, rel), text, 'utf8');
};

write('package.json', JSON.stringify({ dependencies: { next: '15.0.0', react: '19.0.0' } }));
write(
  'features/items.ts',
  `import axios from 'axios';
   import { useQuery } from '@tanstack/react-query';
   export function useItems() {
     return useQuery({ queryKey: ['items'], queryFn: () => axios.get('/api/items') });
   }`,
);
write(
  'app/items/page.tsx',
  `'use client';
   import { useQueryClient } from '@tanstack/react-query';
   import { useItems } from '../../features/items';
   export default function ItemsPage() {
     const qc = useQueryClient();
     useItems();
     return <button onClick={() => qc.invalidateQueries()}>Reload everything</button>;
   }`,
);
write('app/api/items/route.ts', `export async function GET() { return Response.json([]); }`);

const { graph } = scan({ root: project });
const reload = resolveFlows(graph, { includeLocalOnly: true }).find(
  (flow) => flow.label === 'Reload everything',
)!;

describe('an invalidation with no key', () => {
  it('fetches every query again', () => {
    expect(flowApis(graph, reload).aftermath.invalidates).toEqual([
      { key: '*', refetches: ['GET /items'] },
    ]);
  });
});
