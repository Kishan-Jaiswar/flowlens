import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import {
  addToGitignore,
  existingBlock,
  findGitRoot,
  inspect,
  toPattern,
  unignored,
} from '../packages/cli/dist/gitignore.js';

const here = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(here, '..');
const BIN = join(REPO, 'packages', 'cli', 'bin', 'flowlens.mjs');

/**
 * Keeping generated files out of `git status`.
 *
 * FlowLens writes the graph and the trace to the OS cache, so on a normal
 * project there is nothing to ignore — and these tests assert that just as
 * hard as they assert the opposite, because a tool that edits a repository it
 * was only asked to read has broken a promise the README makes.
 */

const temp = mkdtempSync(join(tmpdir(), 'flowlens-gitignore-'));

afterAll(() => {
  rmSync(temp, { recursive: true, force: true });
});

/** A throwaway git repository with a scannable frontend in it. */
function repository(name: string): string {
  const root = join(temp, name);
  mkdirSync(join(root, 'src'), { recursive: true });
  writeFileSync(
    join(root, 'src', 'App.jsx'),
    `import axios from 'axios';
     export function App() {
       const handleSave = () => axios.post('/api/orders', {});
       return <button onClick={handleSave}>Save</button>;
     }`,
    'utf8',
  );
  git(root, ['init', '--quiet']);
  // A commit is not needed, but an identity is, in case a test commits.
  git(root, ['config', 'user.email', 'test@example.com']);
  git(root, ['config', 'user.name', 'FlowLens Test']);
  return root;
}

function git(cwd: string, args: string[]): string {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  return `${result.stdout ?? ''}${result.stderr ?? ''}`;
}

function cli(args: string[], cwd = temp): { status: number; out: string } {
  const result = spawnSync(process.execPath, [BIN, ...args], {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, NO_COLOR: '1' },
  });
  return { status: result.status ?? 1, out: `${result.stdout}${result.stderr}` };
}

function gitignoreOf(root: string): string {
  const path = join(root, '.gitignore');
  return existsSync(path) ? readFileSync(path, 'utf8') : '';
}

describe('finding artifacts git would notice', () => {
  it('locates the work tree a file belongs to', () => {
    const root = repository('locate');
    expect(findGitRoot(join(root, 'src', 'App.jsx'))).toBe(root);
    // The file need not exist yet — ignoring it before the first scan is the point.
    expect(findGitRoot(join(root, 'src', 'deeper', 'graph.json'))).toBe(root);
  });

  it('reports nothing for a path outside any repository', () => {
    const loose = join(temp, 'loose');
    mkdirSync(loose, { recursive: true });
    expect(inspect(join(loose, 'graph.json'))).toBeUndefined();
  });

  it('ignores paths inside .git itself', () => {
    const root = repository('dotgit');
    expect(inspect(join(root, '.git', 'graph.json'))).toBeUndefined();
  });

  it('skips a file the project already ignores', () => {
    const root = repository('already');
    writeFileSync(join(root, '.gitignore'), '*.jsonl\n', 'utf8');
    expect(unignored([join(root, 'trace.jsonl')])).toEqual([]);
    expect(unignored([join(root, 'graph.json')])).toHaveLength(1);
  });
});

describe('gitignore patterns', () => {
  it('anchors to the repository root', () => {
    // Unanchored, `graph.json` would also hide a src/graph.json someone wrote.
    expect(toPattern('graph.json')).toBe('/graph.json');
    expect(toPattern(join('build', 'graph.json'))).toBe('/build/graph.json');
  });

  it('escapes the characters git reads as syntax', () => {
    expect(toPattern('a[1]/graph*.json')).toBe('/a\\[1\\]/graph\\*.json');
  });
});

describe('the managed block', () => {
  it('appends without disturbing what the developer wrote', () => {
    const root = repository('append');
    writeFileSync(join(root, '.gitignore'), 'node_modules\ndist\n', 'utf8');

    const result = addToGitignore(root, ['/graph.json']);
    expect(result.added).toEqual(['/graph.json']);

    const contents = gitignoreOf(root);
    expect(contents).toContain('node_modules\ndist\n');
    expect(contents).toContain(
      '# flowlens:begin (managed by FlowLens)\n/graph.json\n# flowlens:end',
    );
    expect(contents.endsWith('\n')).toBe(true);
  });

  it('does not glue itself onto a file with no trailing newline', () => {
    const root = repository('no-newline');
    writeFileSync(join(root, '.gitignore'), 'dist', 'utf8');
    addToGitignore(root, ['/graph.json']);
    expect(gitignoreOf(root)).toContain('dist\n');
    expect(gitignoreOf(root).split('\n')).toContain('/graph.json');
  });

  it('is idempotent, and grows in place rather than repeating itself', () => {
    const root = repository('idempotent');
    addToGitignore(root, ['/graph.json']);
    const once = gitignoreOf(root);

    expect(addToGitignore(root, ['/graph.json']).added).toEqual([]);
    expect(gitignoreOf(root)).toBe(once);

    const second = addToGitignore(root, ['/trace.jsonl']);
    expect(second.added).toEqual(['/trace.jsonl']);
    expect(existingBlock(gitignoreOf(root))).toEqual(['/graph.json', '/trace.jsonl']);
    // One block, not two.
    expect(gitignoreOf(root).split('# flowlens:begin').length - 1).toBe(1);
  });

  it('leaves the file alone for a dry run', () => {
    const root = repository('dry');
    const result = addToGitignore(root, ['/graph.json'], { dryRun: true });
    expect(result.added).toEqual(['/graph.json']);
    expect(existsSync(join(root, '.gitignore'))).toBe(false);
  });

  it('says when the file is already committed, because ignoring it will not help', () => {
    const root = repository('tracked');
    writeFileSync(join(root, 'graph.json'), '{}\n', 'utf8');
    git(root, ['add', 'graph.json']);
    git(root, ['commit', '--quiet', '-m', 'add graph']);

    const result = addToGitignore(root, ['/graph.json']);
    expect(result.tracked).toEqual(['/graph.json']);
  });
});

describe('flowlens scan', () => {
  it('says nothing about git when the graph goes to the cache', () => {
    const root = repository('quiet-default');
    const { status, out } = cli(['scan', root]);
    expect(status).toBe(0);
    expect(out).not.toContain('is not ignored');
    expect(existsSync(join(root, '.gitignore'))).toBe(false);
  });

  it('warns, and changes nothing, when -g puts the graph in the repository', () => {
    const root = repository('warned');
    const { status, out } = cli(['scan', root, '-g', 'graph.json'], root);
    expect(status).toBe(0);
    expect(out).toContain('is inside a git repository and is not ignored');
    expect(out).toContain('flowlens init --gitignore -g graph.json');
    // The warning is a warning: the repository is untouched.
    expect(existsSync(join(root, '.gitignore'))).toBe(false);
  });

  it('updates the block itself when asked with --gitignore', () => {
    const root = repository('scan-auto');
    const { status } = cli(['scan', root, '-g', 'graph.json', '--gitignore'], root);
    expect(status).toBe(0);
    expect(existingBlock(gitignoreOf(root))).toEqual(['/graph.json']);

    // And then has nothing left to say.
    const again = cli(['scan', root, '-g', 'graph.json'], root);
    expect(again.out).not.toContain('is not ignored');
  });

  it('honours "gitignore": true in the config, even under --json', () => {
    const root = repository('config-opt-in');
    writeFileSync(
      join(root, 'flowlens.config.json'),
      `${JSON.stringify({ roots: ['.'], gitignore: true }, null, 2)}\n`,
      'utf8',
    );
    const { status, out } = cli(['scan', '-g', 'graph.json', '--json'], root);
    expect(status).toBe(0);
    // Machine-readable output stays machine-readable.
    expect(() => JSON.parse(out) as unknown).not.toThrow();
    expect(existingBlock(gitignoreOf(root))).toEqual(['/graph.json']);
  });

  it('--no-gitignore overrides the config', () => {
    const root = repository('config-override');
    writeFileSync(
      join(root, 'flowlens.config.json'),
      `${JSON.stringify({ roots: ['.'], gitignore: true }, null, 2)}\n`,
      'utf8',
    );
    cli(['scan', '-g', 'graph.json', '--no-gitignore'], root);
    expect(existsSync(join(root, '.gitignore'))).toBe(false);
  });
});

describe('flowlens init --gitignore', () => {
  it('adds the artifacts the flags actually name', () => {
    const root = repository('init-flags');
    const { status, out } = cli(
      ['init', root, '--gitignore', '-g', 'graph.json', '--trace', 'spans.jsonl'],
      root,
    );
    expect(status).toBe(0);
    expect(out).toContain('Ignored');
    expect(existingBlock(gitignoreOf(root))).toEqual(['/graph.json', '/spans.jsonl']);
    // The config is still written — --gitignore is an addition, not a mode.
    expect(existsSync(join(root, 'flowlens.config.json'))).toBe(true);
  });

  it('picks up a $FLOWLENS_TRACE pointed inside the repository', () => {
    const root = repository('init-env');
    const result = spawnSync(process.execPath, [BIN, 'init', root, '--gitignore'], {
      cwd: root,
      encoding: 'utf8',
      env: { ...process.env, NO_COLOR: '1', FLOWLENS_TRACE: join(root, 'runtime.jsonl') },
    });
    expect(result.status).toBe(0);
    expect(existingBlock(gitignoreOf(root))).toEqual(['/runtime.jsonl']);
  });

  it('says plainly when there is nothing to ignore', () => {
    const root = repository('init-nothing');
    const { status, out } = cli(['init', root, '--gitignore'], root);
    expect(status).toBe(0);
    expect(out).toContain('nothing to ignore');
    expect(existsSync(join(root, '.gitignore'))).toBe(false);
  });

  it('works on a project that is already configured, and keeps the config', () => {
    const root = repository('init-again');
    const config = `${JSON.stringify({ roots: ['.'], apiPrefixes: ['/api'] }, null, 2)}\n`;
    writeFileSync(join(root, 'flowlens.config.json'), config, 'utf8');

    // Without --gitignore this is still an error, as it always was.
    expect(cli(['init', root], root).status).toBe(1);

    const { status, out } = cli(['init', root, '--gitignore', '-g', 'graph.json'], root);
    expect(status).toBe(0);
    expect(out).toContain('unchanged');
    expect(existingBlock(gitignoreOf(root))).toEqual(['/graph.json']);
    expect(readFileSync(join(root, 'flowlens.config.json'), 'utf8')).toBe(config);
  });

  it('writes nothing under --print', () => {
    const root = repository('init-print');
    const { status } = cli(['init', root, '--gitignore', '-g', 'graph.json', '--print'], root);
    expect(status).toBe(0);
    expect(existsSync(join(root, '.gitignore'))).toBe(false);
  });
});
