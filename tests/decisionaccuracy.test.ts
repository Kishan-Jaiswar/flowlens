import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  actionDecisions,
  findBrokenCalls,
  pageAtPath,
  renderDecisionTree,
  resolveFlows,
  scan,
} from '@flowslens/core';

/**
 * What an audit of a real app's decision trees found missing or wrong, each
 * pinned on the smallest app that shows it:
 *
 *  - a helper whose `if`s only set values (a query filter) was not drawn;
 *  - a `switch` that only picks which value to return was not drawn;
 *  - a throw nothing catches ended the chart without the 500 it becomes;
 *  - one helper called with two arguments was opened once, hiding the other;
 *  - a disabled button's condition was not where the chart starts;
 *  - polling (`refetchInterval`) was drawn as one request;
 *  - a page the browser opened was reported as a broken API call.
 */

const project = mkdtempSync(join(tmpdir(), 'flowlens-accuracy-'));
const write = (rel: string, text: string): void => {
  mkdirSync(join(project, rel, '..'), { recursive: true });
  writeFileSync(join(project, rel), text, 'utf8');
};

write('tsconfig.json', JSON.stringify({ compilerOptions: { paths: { '@/*': ['./*'] } } }));

write(
  'lib/db/mongo.ts',
  `function requireEnv(name) {
     const value = process.env[name];
     if (!value) throw new Error(name + " is not set");
     return value;
   }
   function getClient() {
     return connect(requireEnv("DB_URI"));
   }
   export async function getCollections() {
     const db = getClient().db(requireEnv("APP_DB"));
     return { items: db.collection('items') };
   }`,
);

write(
  'lib/db/store.ts',
  `import { getCollections } from './mongo';
   function levelClauses(level) {
     switch (level) {
       case "out":
         return [{ stock: { $lte: 0 } }];
       case "low":
         return [{ stock: { $gt: 0 } }];
       default:
         return [];
     }
   }
   function itemFilter(query) {
     const filter = { owner: query.owner };
     const and = [];
     if (query.category) filter.category = query.category;
     if (query.level) and.push(...levelClauses(query.level));
     if (and.length) filter.$and = and;
     return filter;
   }
   export async function listItems(query) {
     const { items } = await getCollections();
     return items.find(itemFilter(query)).toArray();
   }`,
);

write(
  'app/api/items/route.ts',
  `import { listItems } from "@/lib/db/store";
   export async function GET(request) {
     const url = new URL(request.url);
     return Response.json(await listItems({ level: url.searchParams.get("level") }));
   }`,
);

write(
  'app/(app)/items/page.tsx',
  `"use client";
   import { useState } from "react";
   export default function ItemsPage() {
     const [ready, setReady] = useState(false);
     const load = async () => {
       await fetch("/api/items?level=low");
     };
     return <button disabled={!ready} onClick={load}>Load items</button>;
   }`,
);

write(
  'features/imports/api.ts',
  `import { useQuery } from "@tanstack/react-query";
   export function useImports() {
     return useQuery({
       queryKey: ["imports"],
       queryFn: () => fetch("/api/items").then((r) => r.json()),
       refetchInterval: 2000,
     });
   }`,
);

write(
  'app/(app)/imports/page.tsx',
  `"use client";
   import { useImports } from "@/features/imports/api";
   export default function ImportsPage() {
     const { data } = useImports();
     return <div>{data?.length}</div>;
   }`,
);

const scanned = scan({ root: project });
const flows = resolveFlows(scanned.graph, { includeLocalOnly: true });
const click = flows.find((flow) => flow.label === 'Load items')!;
const text = renderDecisionTree(actionDecisions(scanned.graph, click));

describe('decision trees draw the whole feature', () => {
  it('opens a helper whose decisions only set values, and the switch inside it', () => {
    expect(text).toContain('itemFilter(query)');
    expect(text).toContain('◆ query.category?');
    expect(text).toContain('filter.category = query.category');
    expect(text).toContain('◆ query.level?');
    expect(text).toMatch(/levelClauses\(query\.level\)[\s\S]*case "low"/);
    expect(text).toContain('and.push(...levelClauses(query.level))');
  });

  it('answers 500 for a throw nothing on the server catches', () => {
    expect(text).toMatch(
      /throws new Error\(name \+ " is not set"\) — not caught, so the server answers 500/,
    );
  });

  it('draws a helper once per argument, so each check that can throw is shown', () => {
    expect(text).toMatch(/requireEnv\("DB_URI"\)\s+\(/);
    expect(text).toMatch(/requireEnv\("APP_DB"\)\s+\(/);
    expect(text).not.toContain('opened above');
  });

  it('starts at the button’s own condition when it can be disabled', () => {
    const lines = text.split('\n');
    expect(lines[3]).toContain('◆ !ready?');
    expect(text).toContain('yes — the button is disabled');
    expect(text).toContain('nothing happens — the button cannot be pressed');
  });

  it('draws polling as a loop around the request', () => {
    const load = flows.find(
      (flow) => flow.event === 'mount' && flow.source?.file === 'app/(app)/imports/page.tsx',
    );
    expect(load, flows.map((flow) => flow.id).join(', ')).toBeDefined();
    const polled = renderDecisionTree(actionDecisions(scanned.graph, load!));
    expect(polled).toMatch(/↻ repeats every 2000 ms[\s\S]*⇄ GET \/items/);
  });
});

describe('a page the browser opens is not an API call', () => {
  it('finds the page at an address, whatever its parameters are called', () => {
    expect(pageAtPath(scanned.graph, '/items')).toBe('app/(app)/items/page.tsx');
    expect(pageAtPath(scanned.graph, '/items?tab=2')).toBe('app/(app)/items/page.tsx');
    expect(pageAtPath(scanned.graph, '/nowhere')).toBeUndefined();
  });

  it('leaves a runtime GET to one of the app’s pages out of the broken calls', () => {
    scanned.graph.addNode({
      id: 'api-call:GET /imports',
      kind: 'api-call',
      label: 'GET /imports',
      evidence: 'runtime',
      meta: { httpMethod: 'GET', path: '/imports', discoveredAtRuntime: true },
    });
    scanned.graph.addNode({
      id: 'api-call:GET /reports',
      kind: 'api-call',
      label: 'GET /reports',
      evidence: 'runtime',
      meta: { httpMethod: 'GET', path: '/reports', discoveredAtRuntime: true },
    });
    const broken = findBrokenCalls(scanned.graph).map((call) => call.label);
    expect(broken).not.toContain('GET /imports');
    // A path with no page behind it is still a call nothing answers.
    expect(broken).toContain('GET /reports');
  });
});
