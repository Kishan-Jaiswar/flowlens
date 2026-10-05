import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { analyzeBreakage, scan, type BreakageInput } from '@flowslens/core';

/**
 * A small Next-style project on disk, edited per test.
 *
 * `before` is what git would hand back for each changed file; the file on disk
 * is the change. Nothing here touches git — the CLI owns that.
 */
const roots: string[] = [];

function project(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'flowlens-breakage-'));
  roots.push(root);
  const all: Record<string, string> = {
    'tsconfig.json': JSON.stringify({
      compilerOptions: {
        target: 'ES2020',
        module: 'esnext',
        moduleResolution: 'bundler',
        jsx: 'preserve',
        strict: true,
        allowJs: true,
        skipLibCheck: true,
        noEmit: true,
      },
      include: ['**/*.ts', '**/*.tsx', '**/*.js'],
    }),
    'jsx.d.ts': 'declare namespace JSX { interface IntrinsicElements { [name: string]: any } }\n',
    ...files,
  };
  for (const [file, text] of Object.entries(all)) {
    mkdirSync(dirname(join(root, file)), { recursive: true });
    writeFileSync(join(root, file), text);
  }
  return root;
}

function check(root: string, changes: BreakageInput[]) {
  const { graph } = scan({ root });
  return analyzeBreakage(graph, changes, { root });
}

afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

const FORMAT_BEFORE = `export function formatPrice(value: number, compact = false): string {
  return compact ? \`\${Math.round(value)}\` : value.toFixed(2);
}

export function label(name: string): string {
  return name.trim();
}
`;

const PAGE = `import { formatPrice, label } from '../../lib/format';

export default function ProductsPage() {
  const total = formatPrice(12.5);
  return <div>{label('Products')} {total} {formatPrice(3, true)}</div>;
}
`;

describe('what a change breaks', () => {
  it('reports the compiler error at each caller of a changed signature, and where it sits', () => {
    const root = project({
      'lib/format.ts': FORMAT_BEFORE.replace(
        'formatPrice(value: number, compact = false)',
        'formatPrice(value: number, currency: string, compact = false)',
      ),
      'app/products/page.tsx': PAGE,
    });
    const report = check(root, [{ file: 'lib/format.ts', before: FORMAT_BEFORE }]);

    expect(report.typeChecked).toBe(true);
    const symbol = report.symbols.find((entry) => entry.name === 'formatPrice')!;
    expect(symbol.change).toBe('signature');
    expect(symbol.details.join(' ')).toMatch(/New required parameter `currency: string`/);
    expect(symbol.details.join(' ')).toMatch(/`compact` moved from position 2 to 3/);
    expect(symbol.before).toContain('compact?: boolean');
    expect(symbol.after).toContain('currency: string');

    const broken = symbol.usages.filter((usage) => usage.verdict === 'broken');
    expect(broken).toHaveLength(2);
    const codes = broken.flatMap((usage) => usage.errors.map((error) => error.code)).sort();
    expect(codes).toEqual(['TS2345', 'TS2554']);
    const explained = broken.flatMap((usage) => usage.errors.map((error) => error.explain)).sort();
    expect(explained).toEqual([
      'Missing `currency` — `formatPrice` now needs it as argument 2.',
      'Passes a `boolean` where `formatPrice` now expects a `string`.',
    ]);
    expect(broken[0]!.file).toBe('app/products/page.tsx');
    expect(broken[0]!.in).toBe('ProductsPage');
    expect(symbol.breaks.pages).toContain('/products');
    expect(report.level).toBe('high');

    // The import line is not a use worth judging when the name still exists.
    expect(symbol.usages.every((usage) => !usage.source.startsWith('import'))).toBe(true);
    // `label` did not change, so it is not reported.
    expect(report.symbols.some((entry) => entry.name === 'label')).toBe(false);
  });

  it('calls a body-only change something to check, not a break', () => {
    const root = project({
      'lib/format.ts': FORMAT_BEFORE.replace('value.toFixed(2)', 'value.toFixed(3)'),
      'app/products/page.tsx': PAGE,
    });
    const report = check(root, [{ file: 'lib/format.ts', before: FORMAT_BEFORE }]);

    const symbol = report.symbols.find((entry) => entry.name === 'formatPrice')!;
    expect(symbol.change).toBe('body');
    expect(symbol.usages.length).toBe(2);
    expect(symbol.usages.every((usage) => usage.verdict === 'review')).toBe(true);
    expect(report.totals.errors).toBe(0);
    expect(report.summary).toMatch(/Everything still compiles/);
  });

  it('finds the uses of a deleted function, with the error on the import', () => {
    const root = project({
      'lib/format.ts': FORMAT_BEFORE.slice(FORMAT_BEFORE.indexOf('export function label')),
      'app/products/page.tsx': PAGE,
    });
    const report = check(root, [{ file: 'lib/format.ts', before: FORMAT_BEFORE }]);

    const symbol = report.symbols.find((entry) => entry.name === 'formatPrice')!;
    expect(symbol.change).toBe('removed');
    const importLine = symbol.usages.find((usage) => usage.source.startsWith('import'))!;
    expect(importLine.verdict).toBe('broken');
    expect(importLine.errors[0]!.code).toBe('TS2305');
  });

  it('reports a rename as one change, not a deletion and an addition', () => {
    const root = project({
      'lib/format.ts': FORMAT_BEFORE.replace('function label(', 'function toLabel('),
      'app/products/page.tsx': PAGE,
    });
    const report = check(root, [{ file: 'lib/format.ts', before: FORMAT_BEFORE }]);

    const symbol = report.symbols.find((entry) => entry.change === 'renamed')!;
    expect(symbol.name).toBe('label → toLabel');
    expect(symbol.usages.some((usage) => usage.verdict === 'broken')).toBe(true);
    expect(report.symbols.some((entry) => entry.change === 'added')).toBe(false);
  });

  it('judges plain JavaScript callers by the new parameter list', () => {
    const before = 'export function total(items) {\n  return items.length;\n}\n';
    const root = project({
      'lib/cart.js':
        'export function total(items, taxRate) {\n  return items.length * taxRate;\n}\n',
      'lib/checkout.js':
        "import { total } from './cart';\n\nexport function checkout(items) {\n  return total(items);\n}\n",
    });
    const report = check(root, [{ file: 'lib/cart.js', before }]);

    const usage = report.symbols.find((entry) => entry.name === 'total')!.usages[0]!;
    expect(usage.verdict).toBe('likely');
    expect(usage.reason).toMatch(/1 argument; it now needs at least 2/);
    expect(usage.in).toBe('checkout');
  });

  it('shows errors in a new file, and hides errors the project already had', () => {
    const root = project({
      'lib/format.ts': FORMAT_BEFORE,
      'lib/old.ts': 'export const broken: number = "already wrong";\n',
      'lib/fresh.ts': 'export const fresh: number = "new and wrong";\n',
    });
    const report = check(root, [
      { file: 'lib/fresh.ts', status: 'untracked' },
      // Changed, but its one error was there before the change.
      {
        file: 'lib/old.ts',
        before: '// old\nexport const broken: number = "already wrong";\n',
      },
    ]);

    const files = [...report.otherErrors, ...report.symbols.flatMap((symbol) => symbol.errors)].map(
      (error) => error.file,
    );
    expect(files).toContain('lib/fresh.ts');
    expect(files).not.toContain('lib/old.ts');
  });
});
