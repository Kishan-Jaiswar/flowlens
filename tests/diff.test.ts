import { spawnSync } from 'node:child_process';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { EXAMPLE_ROOT } from './helpers.js';

/**
 * `flowlens diff --base main` — a branch compared with the point it forked
 * from, in a real git repository: an endpoint added, one removed, and a
 * collection given a writer it did not have. The questions a reviewer asks,
 * answered from two graphs rather than from the lines.
 */
const here = dirname(fileURLToPath(import.meta.url));
const BIN = resolve(here, '..', 'packages', 'cli', 'bin', 'flowlens.mjs');

let repo: string;

function git(...args: string[]): string {
  const result = spawnSync('git', args, { cwd: repo, encoding: 'utf8' });
  if (result.status !== 0) throw new Error(result.stderr);
  return result.stdout;
}

function flowlens(...args: string[]): { status: number; out: string; err: string } {
  const result = spawnSync(process.execPath, [BIN, ...args], {
    cwd: repo,
    encoding: 'utf8',
    env: { ...process.env, NO_COLOR: '1' },
  });
  return { status: result.status ?? 1, out: result.stdout, err: result.stderr };
}

function edit(file: string, from: string, to: string): void {
  const path = join(repo, file);
  const text = readFileSync(path, 'utf8');
  if (!text.includes(from)) throw new Error(`${file} has no ${from}`);
  writeFileSync(path, text.replace(from, to), 'utf8');
}

beforeAll(() => {
  repo = mkdtempSync(join(tmpdir(), 'flowlens-diff-'));
  cpSync(EXAMPLE_ROOT, repo, { recursive: true });
  git('init', '--quiet', '--initial-branch=main');
  git('config', 'user.email', 'test@example.com');
  git('config', 'user.name', 'test');
  git('add', '-A');
  git('commit', '--quiet', '-m', 'base');
  git('checkout', '--quiet', '-b', 'feature');

  const controller = 'api/src/customers/customers.controller.ts';
  edit(
    controller,
    `  @Get(':id')
  findOne(@Param('id') id: string) {
    return this.customersService.findById(id);
  }
`,
    `  @Post(':id/merge')
  merge(@Param('id') id: string) {
    return this.customersService.merge(id);
  }
`,
  );
  edit(
    'api/src/customers/customers.service.ts',
    '  async remove(id: string) {',
    `  async merge(id: string) {
    await this.customerModel.updateMany({ duplicateOf: id }, { archived: true });
  }

  async remove(id: string) {`,
  );
  git('commit', '--quiet', '-am', 'merge duplicates');
}, 60_000);

afterAll(() => rmSync(repo, { recursive: true, force: true }));

describe('flowlens diff', () => {
  it('reports what the branch changed about the app', () => {
    const { status, out } = flowlens('diff', '.', '--base', 'main', '--json');
    expect(status).toBe(0);
    const report = JSON.parse(out) as {
      diff: {
        endpoints: { added: string[]; removed: string[] };
        writers: Array<{ collection: string; added: string[]; before: string[] }>;
      };
      changed: { files: Array<{ file: string }> };
    };
    expect(report.diff.endpoints.added).toContain('POST /customers/:param/merge');
    expect(report.diff.endpoints.removed).toContain('GET /customers/:param');
    const customers = report.diff.writers.find((entry) => entry.collection === 'customers');
    expect(customers?.added.join(' ')).toMatch(/merge/);
    expect(customers?.before.length).toBeGreaterThan(0);
    expect(report.changed.files.map((entry) => entry.file)).toContain(
      'api/src/customers/customers.service.ts',
    );
  });

  it('writes a pull request comment that says so, and can find itself again', () => {
    const { out } = flowlens('diff', '.', '--base', 'main');
    expect(out.startsWith('<!-- flowlens-report -->')).toBe(true);
    // The new route has no guard — the finding a reviewer most needs to see.
    expect(out).toContain('**Risk: high**');
    expect(out).toContain('### New issues (1)');
    expect(out).toContain('POST /customers/:param/merge runs without any auth check');
    // Deleting the old route took its finding with it.
    expect(out).toContain('~~GET /customers/:param runs without any auth check~~');
    expect(out).toContain('### Collections with a new writer');
    expect(out).toContain('- **removed** `GET /customers/:param`');
    expect(out).toContain('- added `POST /customers/:param/merge`');
  });

  it('counts uncommitted work on top of the branch', () => {
    edit(
      'api/src/products/products.controller.ts',
      '@Controller(',
      '// work in progress\n@Controller(',
    );
    try {
      const { out } = flowlens('diff', '.', '--base', 'main', '--json');
      const files = (JSON.parse(out) as { changed: { files: Array<{ file: string }> } }).changed
        .files;
      expect(files.map((entry) => entry.file)).toContain('api/src/products/products.controller.ts');
    } finally {
      git('checkout', '--', 'api/src/products/products.controller.ts');
    }
  });

  it('leaves no worktree behind', () => {
    flowlens('diff', '.', '--base', 'main');
    expect(git('worktree', 'list').trim().split('\n')).toHaveLength(1);
  });

  it('fails the job on a new issue at the gate, and only then', () => {
    const gated = flowlens('diff', '.', '--base', 'main', '--fail-on', 'high');
    expect(gated.status).toBe(1);
    expect(gated.err).toContain('introduces a high-or-worse issue');
    // Compared with itself the branch introduces nothing, so the gate passes.
    expect(flowlens('diff', '.', '--base', 'HEAD', '--fail-on', 'low').status).toBe(0);
    expect(flowlens('diff', '.', '--base', 'main', '--fail-on', 'bogus').status).toBe(1);
  });

  it('says plainly when the base does not exist', () => {
    const { status, err } = flowlens('diff', '.', '--base', 'no-such-branch');
    expect(status).toBe(1);
    expect(err).toContain('cannot compare with "no-such-branch"');
  });
});
