import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { scan, type UnusedReport } from '@flowslens/core';

/**
 * Code nothing uses. A file is used when something the app starts from — a
 * route file the framework loads, a script package.json runs, a test, a config
 * file — reaches it through imports. The fixture has one of each kind of
 * reachable file and one of each kind of dead one.
 */
const root = mkdtempSync(join(tmpdir(), 'flowlens-unused-'));
const files: Record<string, string> = {
  'package.json': JSON.stringify({
    scripts: { dev: 'next dev', worker: 'tsx worker.ts', db: 'prisma migrate dev' },
    dependencies: {
      next: '16.0.0',
      react: '19.0.0',
      'react-dom': '19.0.0',
      zod: '4.0.0',
      lodash: '4.0.0',
      prisma: '6.0.0',
    },
  }),
  'tsconfig.json': JSON.stringify({ compilerOptions: { paths: { '@/*': ['./*'] } } }),
  'next.config.ts': 'export default {};',
  // Framework entry points, reached by name.
  'app/layout.tsx': 'export default function L({ children }) { return children; }',
  'app/page.tsx': `import { total } from '@/lib/math';
     import type { Row } from '@/lib/types';
     export default async function Page() {
       const { Chart } = await import('@/components/chart');
       const rows: Row[] = [];
       return total(rows.length) + String(Chart);
     }`,
  'app/api/items/route.ts': `import { z } from 'zod';
     export async function GET() { return Response.json(z.string().parse('ok')); }`,
  // Reached through imports.
  'lib/math.ts': `export function total(n: number) { return double(n); }
     export function double(n: number) { return n * 2; }
     export function neverUsed() { return 0; }`,
  'lib/types.ts': 'export interface Row { id: string }',
  'components/chart.tsx': 'export const Chart = () => null;',
  // Run by package.json and by hand.
  'worker.ts': "import { total } from './lib/math'; total(1);",
  'scripts/seed.ts': "import { double } from '../lib/math'; double(2);",
  // Only a test imports it: tested, not dead.
  'lib/format.ts': 'export const format = (n: number) => String(n);',
  'lib/format.test.ts': "import { format } from './format'; format(1);",
  // Dead: nothing reaches these.
  'lib/old-helper.ts': "import { chain } from './only-dead-imports-me'; export const old = chain;",
  'lib/only-dead-imports-me.ts': 'export const chain = 1;',
  'lib/legacy/a.ts': 'export const a = 1;\nexport const b = 2;\n',
  'lib/legacy/b.ts': "import { a } from './a'; export const c = a;",
};
for (const [path, body] of Object.entries(files)) {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), body, 'utf8');
}
afterAll(() => rmSync(root, { recursive: true, force: true }));

const unused = scan({ root }).graph.meta.unused as UnusedReport;
const deadFiles = unused.files.map((entry) => entry.file);

describe('unused files', () => {
  it('finds files nothing the app starts from reaches — chains of dead code included', () => {
    expect(deadFiles).toEqual([
      'lib/legacy/a.ts',
      'lib/legacy/b.ts',
      'lib/old-helper.ts',
      'lib/only-dead-imports-me.ts',
    ]);
  });

  it('counts routes, config, package.json scripts, scripts/, tests, type and dynamic imports as uses', () => {
    for (const used of [
      'app/page.tsx',
      'app/api/items/route.ts',
      'next.config.ts',
      'worker.ts',
      'scripts/seed.ts',
      'lib/format.ts',
      'lib/types.ts',
      'components/chart.tsx',
    ]) {
      expect(deadFiles).not.toContain(used);
    }
  });

  it('says how many lines deleting them saves', () => {
    expect(unused.files.find((entry) => entry.file === 'lib/legacy/a.ts')?.lines).toBe(3);
  });
});

describe('unused folders', () => {
  it('names the top-most folder whose every file is dead, not each file in it', () => {
    expect(unused.folders).toEqual([{ folder: 'lib/legacy', files: 2, lines: 4 }]);
  });
});

describe('unused exports', () => {
  it('lists exports of a used file that nothing imports, and whether the file uses them itself', () => {
    const math = unused.exports.filter((entry) => entry.file === 'lib/math.ts');
    expect(math.map((entry) => [entry.name, entry.usedInFile])).toEqual([['neverUsed', false]]);
    expect(math[0]?.kind).toBe('function');
  });

  it('leaves the exports a framework reads by name alone', () => {
    // `GET` and `default` in route and page files are for Next, not for imports.
    expect(unused.exports.some((entry) => entry.file.startsWith('app/'))).toBe(false);
  });
});

describe('unused dependencies', () => {
  it('lists a dependency nothing imports, and not the ones used implicitly or by a script', () => {
    // react-dom is Next's renderer, prisma runs from a script, zod is imported.
    expect(unused.dependencies.map((entry) => entry.name)).toEqual(['lodash']);
  });
});
