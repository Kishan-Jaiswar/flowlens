import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

/**
 * `flowlens instrument` — tracing set up by the tool, not copied out of an app
 * that had already worked it out. It writes new files only and prints the
 * lines that belong in files the developer owns.
 */
const here = dirname(fileURLToPath(import.meta.url));
const BIN = resolve(here, '..', 'packages', 'cli', 'bin', 'flowlens.mjs');

let temp: string;
afterEach(() => rmSync(temp, { recursive: true, force: true }));

function project(files: Record<string, string>): string {
  temp = mkdtempSync(join(tmpdir(), 'flowlens-instrument-'));
  for (const [path, body] of Object.entries(files)) {
    mkdirSync(dirname(join(temp, path)), { recursive: true });
    writeFileSync(join(temp, path), body, 'utf8');
  }
  return temp;
}

function instrument(root: string, ...flags: string[]): { status: number; out: string } {
  const result = spawnSync(process.execPath, [BIN, 'instrument', root, ...flags], {
    encoding: 'utf8',
    env: { ...process.env, NO_COLOR: '1' },
  });
  return { status: result.status ?? 1, out: `${result.stdout}${result.stderr}` };
}

const NEXT_APP = {
  'package.json': JSON.stringify({ dependencies: { next: '16.0.0', mongodb: '6.0.0' } }),
  'app/layout.tsx':
    'export default function L({ children }) { return <html><body>{children}</body></html>; }',
};

describe('flowlens instrument', () => {
  it('writes the two tracing files for a Next.js App Router app', () => {
    const root = project(NEXT_APP);
    const { status, out } = instrument(root);
    expect(status).toBe(0);
    expect(readFileSync(join(root, 'instrumentation.ts'), 'utf8')).toContain(
      'export { register } from "@flowslens/runtime/next";',
    );
    expect(readFileSync(join(root, 'app', 'flowlens-tracer.tsx'), 'utf8')).toContain(
      'import("@flowslens/runtime/browser")',
    );
    // Everything else is printed, never edited in.
    expect(readFileSync(join(root, 'app', 'layout.tsx'), 'utf8')).not.toContain('Flowlens');
    expect(out).toContain('<FlowlensTracer />');
    expect(out).toContain('traceDb(client.db(name))');
    expect(out).toContain('npm install -D @flowslens/runtime');
    expect(out).toContain('NEXT_PUBLIC_FLOWLENS_SPANS');
  });

  it('writes nothing with --print', () => {
    const root = project(NEXT_APP);
    const { out } = instrument(root, '--print');
    expect(out).toContain('Would write:');
    expect(existsSync(join(root, 'instrumentation.ts'))).toBe(false);
    expect(existsSync(join(root, 'app', 'flowlens-tracer.tsx'))).toBe(false);
  });

  it('never replaces an instrumentation.ts the app already has', () => {
    const own = 'export async function register() { await import("./sentry"); }\n';
    const root = project({ ...NEXT_APP, 'instrumentation.ts': own });
    const { out } = instrument(root);
    expect(readFileSync(join(root, 'instrumentation.ts'), 'utf8')).toBe(own);
    expect(out).toContain("await (await import('@flowslens/runtime/next')).register();");
  });

  it('does not repeat steps the app has already done', () => {
    const root = project({
      ...NEXT_APP,
      'package.json': JSON.stringify({
        dependencies: { next: '16.0.0', mongodb: '6.0.0' },
        devDependencies: { '@flowslens/runtime': '1.2.0' },
      }),
      'app/providers.tsx': 'export const P = () => <FlowlensTracer />;',
      'lib/db.ts': 'export const db = traceDb(client.db("app"));',
      '.env': 'NEXT_PUBLIC_FLOWLENS_SPANS="http://127.0.0.1:4177/__flowlens/spans"\n',
    });
    const { out } = instrument(root);
    for (const done of ['<FlowlensTracer />', 'traceDb(client', 'install -D', '.env.local']) {
      expect(out).not.toContain(done);
    }
    expect(out).toContain('flowlens serve . --token flowlens-dev');
  });

  it('uses the package manager the project already uses', () => {
    const root = project({ ...NEXT_APP, 'pnpm-lock.yaml': '' });
    expect(instrument(root, '--print').out).toContain('pnpm add -D @flowslens/runtime');
  });

  it('tells an Express app where the middleware goes, and writes nothing', () => {
    const root = project({
      'package.json': JSON.stringify({ dependencies: { express: '5.0.0', mongoose: '8.0.0' } }),
    });
    const { status, out } = instrument(root);
    expect(status).toBe(0);
    expect(out).toContain('app.use(flowlensHttp())');
    expect(out).toContain('mongoose.plugin(flowlensMongoose())');
    expect(existsSync(join(root, 'instrumentation.ts'))).toBe(false);
  });
});
