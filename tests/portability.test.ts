import { afterAll, describe, expect, it } from 'vitest';
import { type spawn, spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ASCII_GLYPHS,
  UNICODE_GLYPHS,
  preferAscii,
  renderFlowTree,
  resolveFlows,
} from '@flowlens/core';
import { looksLikePath, splitPositionals } from '../packages/cli/dist/args.js';
import { detectSetup, findSiblingRepositories } from '../packages/cli/dist/commands/init.js';
import { browserCommand, openBrowser } from '../packages/cli/dist/commands/serve.js';
import { graphPath, outputDir, projectKey, tracePath } from '../packages/cli/dist/paths.js';
import { exampleScan } from './helpers.js';

const here = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(here, '..');
const BIN = join(REPO, 'packages', 'cli', 'bin', 'flowlens.mjs');
const EXAMPLES = join(REPO, 'examples');

/**
 * FlowLens has to work on whatever machine the developer is sitting at. These
 * tests cover the differences that actually bite: how a path is spelled, what a
 * terminal can draw, and whether the first command someone types succeeds.
 */

describe('path arguments, spelled any way', () => {
  it('recognises POSIX paths', () => {
    for (const value of ['.', '..', './app', '../api', '/srv/app', 'a/b']) {
      expect(looksLikePath(value), value).toBe(true);
    }
  });

  it('recognises Windows paths', () => {
    // The bug this replaced: only `/` counted, so every one of these was
    // mistaken for a flow id and the scan silently ran against the cwd.
    for (const value of ['.\\app', '..\\api', 'C:\\code\\app', 'c:app', '\\\\server\\share']) {
      expect(looksLikePath(value), value).toBe(true);
    }
  });

  it('does not mistake a symbol or a flow id for a path', () => {
    for (const value of ['create-patient', 'PatientsService.create', 'AuditService.record', '']) {
      expect(looksLikePath(value), value).toBe(false);
    }
  });

  it('treats every positional as a project for commands that take no argument', () => {
    expect(splitPositionals('scan', ['my-web', 'my-api'])).toEqual({
      roots: ['my-web', 'my-api'],
      args: [],
    });
    expect(splitPositionals('serve', ['whatever'])).toEqual({ roots: ['whatever'], args: [] });
  });

  it('separates a flow id from its project, in either order', () => {
    expect(splitPositionals('flow', ['create-patient', './app'])).toEqual({
      roots: ['./app'],
      args: ['create-patient'],
    });
    expect(splitPositionals('flow', ['./app', 'create-patient'])).toEqual({
      roots: ['./app'],
      args: ['create-patient'],
    });
    expect(splitPositionals('impact', ['Service.create', 'C:\\code\\app'])).toEqual({
      roots: ['C:\\code\\app'],
      args: ['Service.create'],
    });
  });

  it('accepts a directory that exists even with no separator in its name', () => {
    const exists = (value: string) => value === 'my-app';
    expect(splitPositionals('flow', ['create-patient', 'my-app'], { exists })).toEqual({
      roots: ['my-app'],
      args: ['create-patient'],
    });
  });
});

describe('the CLI, end to end', () => {
  /**
   * The graph goes to a temporary file rather than the machine-local cache.
   * Test files run in parallel, and the dashboard tests clear that directory —
   * two writers in one place is a flake waiting to happen.
   */
  const temp = mkdtempSync(join(tmpdir(), 'flowlens-cli-'));
  const graph = join(temp, 'graph.json');

  afterAll(() => {
    rmSync(temp, { recursive: true, force: true });
  });

  const run = (args: string[], cwd = REPO) =>
    spawnSync(process.execPath, [BIN, ...args, '-g', graph], {
      cwd,
      encoding: 'utf8',
      timeout: 180_000,
    });

  it('scans a project named without any path separator', () => {
    // `flowlens scan clinic` from examples/ — the spelling that used to scan
    // the wrong directory without saying so.
    const result = run(['scan', 'clinic', '--json'], EXAMPLES);
    expect(result.status).toBe(0);
    const output = JSON.parse(result.stdout) as { stats: { routes: number } };
    expect(output.stats.routes).toBeGreaterThan(0);
  });

  it('fails loudly on a project that does not exist', () => {
    const result = run(['scan', 'no-such-project'], EXAMPLES);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('does not exist');
  });

  it('still resolves a flow id given alongside a bare project name', () => {
    run(['scan', 'clinic'], EXAMPLES);
    const result = run(['flow', 'prescriptionform-submit-prescription', 'clinic'], EXAMPLES);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('Submit Prescription');
  });
});

describe('terminals that cannot draw boxes', () => {
  it('keeps Unicode on a normal terminal', () => {
    expect(preferAscii({ platform: 'linux', isTTY: true, env: {} })).toBe(false);
    expect(preferAscii({ platform: 'darwin', isTTY: true, env: {} })).toBe(false);
    expect(preferAscii({ platform: 'win32', isTTY: true, env: { WT_SESSION: '1' } })).toBe(false);
    expect(preferAscii({ platform: 'win32', isTTY: true, env: { TERM: 'xterm' } })).toBe(false);
  });

  it('falls back to ASCII on a legacy Windows console', () => {
    expect(preferAscii({ platform: 'win32', isTTY: true, env: {} })).toBe(true);
  });

  it('keeps Unicode when the output is a file or a pipe', () => {
    // Redirected output is UTF-8 bytes that something else will decode, and a
    // generated document should not be degraded by the terminal that made it.
    expect(preferAscii({ platform: 'win32', isTTY: false, env: {} })).toBe(false);
  });

  it('can be forced either way', () => {
    expect(preferAscii({ platform: 'linux', isTTY: true, env: { FLOWLENS_ASCII: '1' } })).toBe(
      true,
    );
    expect(
      preferAscii({
        platform: 'win32',
        isTTY: true,
        env: { FLOWLENS_ASCII: '1', FLOWLENS_UNICODE: '1' },
      }),
    ).toBe(false);
    // `0` and `false` mean off, not "set, therefore on".
    expect(preferAscii({ platform: 'linux', isTTY: true, env: { FLOWLENS_ASCII: '0' } })).toBe(
      false,
    );
    expect(preferAscii({ platform: 'linux', isTTY: true, env: { FLOWLENS_ASCII: 'false' } })).toBe(
      false,
    );
  });

  it('draws the same tree with ASCII glyphs', () => {
    const flow = resolveFlows(exampleScan().graph)[0]!;
    const unicode = renderFlowTree(flow);
    const ascii = renderFlowTree(flow, { ascii: true });

    expect(unicode).toContain(UNICODE_GLYPHS.lastBranch);
    expect(ascii).toContain(ASCII_GLYPHS.lastBranch);
    // No box-drawing character survives the fallback...
    expect(ascii).not.toMatch(/[\u2500-\u257f\u25a0-\u25ff]/);
    // ...and the two trees still have the same shape.
    expect(ascii.split('\n').length).toBe(unicode.split('\n').length);
  });

  it('keeps the aligned glyphs the same width as the characters they replace', () => {
    /**
     * Tree indentation and table columns are laid out by character count, so a
     * fallback glyph of a different width would shear the whole tree sideways.
     *
     * `arrow` and `exchange` are exempt: they appear inside prose (`a → b`,
     * "Frontend ↔ backend"), never in a padded column, and `->` reads far
     * better there than any single-character substitute.
     */
    const aligned = [
      'branch',
      'lastBranch',
      'vertical',
      'rule',
      'warn',
      'bullet',
      'dot',
      'none',
    ] as const;
    for (const key of aligned) {
      expect([...ASCII_GLYPHS[key]].length, key).toBe([...UNICODE_GLYPHS[key]].length);
    }
  });
});

describe('flowlens init', () => {
  const temp = mkdtempSync(join(tmpdir(), 'flowlens-init-'));

  afterAll(() => {
    rmSync(temp, { recursive: true, force: true });
  });

  const web = (dir: string) => {
    mkdirSync(join(dir, 'src'), { recursive: true });
    writeFileSync(
      join(dir, 'src', 'App.jsx'),
      `import axios from 'axios';
       export function App() {
         const handleSave = () => axios.post('/api/orders', {});
         return <button onClick={handleSave}>Save</button>;
       }`,
      'utf8',
    );
  };
  const api = (dir: string) => {
    mkdirSync(join(dir, 'src'), { recursive: true });
    writeFileSync(
      join(dir, 'src', 'orders.controller.ts'),
      `import { Controller, Post } from '@nestjs/common';
       @Controller('api/orders')
       export class OrdersController {
         @Post() create() { return 1; }
       }`,
      'utf8',
    );
  };

  it('finds both halves of a monorepo', () => {
    const root = join(temp, 'mono');
    web(join(root, 'web'));
    api(join(root, 'api'));

    const detection = detectSetup(root, []);
    // One root covers both halves, which keeps node ids relative to one tree.
    expect(detection.roots).toEqual([root]);
    expect(detection.reasons).toEqual(['frontend: web', 'backend: api']);
    expect(detection.apiPrefixes).toEqual(['/api']);
  });

  it('finds the sibling repository holding the other half', () => {
    const parent = join(temp, 'pair');
    web(join(parent, 'shop-web'));
    api(join(parent, 'shop-api'));

    expect(findSiblingRepositories(join(parent, 'shop-web'))).toEqual([join(parent, 'shop-api')]);
    // And from the other side.
    expect(findSiblingRepositories(join(parent, 'shop-api'))).toEqual([join(parent, 'shop-web')]);
  });

  it('does not pair a project with an unrelated neighbour', () => {
    const parent = join(temp, 'unrelated');
    web(join(parent, 'shop-web'));
    api(join(parent, 'payroll-api'));
    expect(findSiblingRepositories(join(parent, 'shop-web'))).toEqual([]);
  });

  it('writes a config that makes `scan` work from anywhere in the project', () => {
    const root = join(temp, 'written');
    web(root);

    const init = spawnSync(process.execPath, [BIN, 'init', root], { encoding: 'utf8' });
    expect(init.status).toBe(0);

    const config = JSON.parse(readFileSync(join(root, 'flowlens.config.json'), 'utf8')) as {
      roots: string[];
    };
    // Relative and forward-slashed, so the file survives a commit and a
    // different machine.
    expect(config.roots).toEqual(['.']);

    // Run from a subdirectory: the config is found by walking up, and the whole
    // project is scanned rather than just the subdirectory.
    const scan = spawnSync(process.execPath, [BIN, 'scan', '--json'], {
      cwd: join(root, 'src'),
      encoding: 'utf8',
    });
    expect(scan.status).toBe(0);
    expect((JSON.parse(scan.stdout) as { stats: { apiCalls: number } }).stats.apiCalls).toBe(1);
  });

  it('refuses to overwrite an existing config unless told to', () => {
    const root = join(temp, 'existing');
    web(root);
    writeFileSync(join(root, 'flowlens.config.json'), '{}\n', 'utf8');

    const refused = spawnSync(process.execPath, [BIN, 'init', root], { encoding: 'utf8' });
    expect(refused.status).toBe(1);
    expect(refused.stderr).toContain('already exists');

    const forced = spawnSync(process.execPath, [BIN, 'init', root, '--force'], {
      encoding: 'utf8',
    });
    expect(forced.status).toBe(0);
  });

  it('reports a project that does not exist', () => {
    const result = spawnSync(process.execPath, [BIN, 'init', join(temp, 'nope')], {
      encoding: 'utf8',
    });
    expect(result.status).toBe(1);
  });
});

describe('opening a browser', () => {
  const URL = 'http://127.0.0.1:4177/';

  // Never call the real opener here. It spawns `xdg-open`, which on a desktop
  // machine really does open tabs at a URL with no server behind it.

  it('uses the right opener on each platform', () => {
    expect(browserCommand(URL, 'darwin')).toEqual(['open', [URL]]);
    expect(browserCommand(URL, 'linux')).toEqual(['xdg-open', [URL]]);
    // Anything else falls back to the freedesktop opener rather than failing.
    expect(browserCommand(URL, 'sunos')).toEqual(['xdg-open', [URL]]);
  });

  it('passes start its title argument on Windows', () => {
    // Without the empty title, `start` treats the quoted URL as a window title
    // and opens nothing.
    const [command, args] = browserCommand(URL, 'win32');
    expect(command).toMatch(/cmd(\.exe)?$/i);
    expect(args).toEqual(['/c', 'start', '', URL]);
  });

  it('never throws, whatever the platform', () => {
    // Best effort by design: a headless machine, a container or an SSH session
    // has nothing to open, and that must not take the dashboard down.
    const launch = (() => {
      throw new Error('no browser here');
    }) as unknown as typeof spawn;

    for (const platform of ['win32', 'darwin', 'linux', 'sunos']) {
      expect(() => openBrowser(URL, platform, launch)).not.toThrow();
    }
  });

  it('swallows a spawn that fails asynchronously', () => {
    // `spawn` reports a missing binary through an 'error' event, not a throw.
    const handlers: Array<() => void> = [];
    const child = {
      on: (event: string, handler: () => void) => {
        if (event === 'error') handlers.push(handler);
        return child;
      },
      unref: () => child,
    };
    const launch = (() => child) as unknown as typeof spawn;

    openBrowser(URL, 'linux', launch);
    expect(handlers).toHaveLength(1);
    expect(() => handlers[0]?.()).not.toThrow();
  });
});

describe('reading a project without writing to it', () => {
  const PROJECT = join(EXAMPLES, 'clinic');

  it('keeps the graph and trace outside the project', () => {
    for (const artifact of [graphPath(PROJECT), tracePath(PROJECT), outputDir(PROJECT)]) {
      expect(artifact.startsWith(resolve(PROJECT))).toBe(false);
      expect(artifact.startsWith(resolve(REPO))).toBe(false);
    }
  });

  it('still honours an explicit --graph / --trace', () => {
    const target = join(tmpdir(), 'flowlens-explicit.json');
    expect(graphPath(PROJECT, target)).toBe(target);
    expect(tracePath(PROJECT, target)).toBe(target);
  });

  it('gives two checkouts of the same name different cache entries', () => {
    const a = projectKey('/home/dev/one/clinic-web');
    const b = projectKey('/home/dev/two/clinic-web');
    expect(a).not.toBe(b);
    // The readable half survives, so the cache stays browsable.
    expect(a.startsWith('clinic-web-')).toBe(true);
  });

  it('honours FLOWLENS_CACHE, so a run can be redirected entirely', () => {
    // The suite itself relies on this (see tests/setup.ts), so it is load-bearing.
    const cache = process.env['FLOWLENS_CACHE'];
    expect(cache, 'FLOWLENS_CACHE should be set by tests/setup.ts').toBeTruthy();
    expect(graphPath(PROJECT).startsWith(cache!)).toBe(true);
  });

  it('is stable for the same path and safe as a directory name', () => {
    expect(projectKey(PROJECT)).toBe(projectKey(PROJECT));
    expect(projectKey(PROJECT)).toMatch(/^[A-Za-z0-9._-]+$/);
  });

  it('leaves nothing behind after a real scan', () => {
    const before = readdirSync(PROJECT).sort();
    const graph = join(mkdtempSync(join(tmpdir(), 'flowlens-readonly-')), 'graph.json');
    const result = spawnSync(process.execPath, [BIN, 'scan', PROJECT, '-g', graph], {
      cwd: REPO,
      encoding: 'utf8',
    });
    expect(result.status).toBe(0);
    expect(existsSync(graph)).toBe(true);
    expect(readdirSync(PROJECT).sort()).toEqual(before);
    expect(existsSync(join(PROJECT, '.flowlens'))).toBe(false);
  });
});

describe('the launcher', () => {
  it('exists for both shells and points at the same entry point', () => {
    expect(existsSync(join(REPO, 'flowlens'))).toBe(true);
    expect(existsSync(join(REPO, 'flowlens.cmd'))).toBe(true);
    expect(existsSync(join(REPO, 'bin', 'flowlens.mjs'))).toBe(true);

    // A .cmd file with LF-only endings can be mis-parsed by cmd.exe, and this
    // one is the Windows entry point.
    expect(readFileSync(join(REPO, 'flowlens.cmd'), 'utf8')).toContain('\r\n');
  });

  it('explains itself instead of crashing when the build is missing', () => {
    // Simulated by pointing the bin at a checkout with no dist: the message a
    // first-time user sees has to say what to do.
    const fake = mkdtempSync(join(tmpdir(), 'flowlens-nodist-'));
    mkdirSync(join(fake, 'bin'), { recursive: true });
    writeFileSync(
      join(fake, 'package.json'),
      JSON.stringify({ name: '@flowlens/cli', version: '0.1.0' }),
      'utf8',
    );
    writeFileSync(join(fake, 'bin', 'flowlens.mjs'), readFileSync(BIN, 'utf8'), 'utf8');

    const result = spawnSync(process.execPath, [join(fake, 'bin', 'flowlens.mjs'), '--version'], {
      encoding: 'utf8',
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('not built yet');
    expect(result.stderr).toContain('npm run build');

    rmSync(fake, { recursive: true, force: true });
  });
});
