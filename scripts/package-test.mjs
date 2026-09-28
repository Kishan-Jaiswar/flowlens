#!/usr/bin/env node
/**
 * Install Flowslens the way a stranger will, and check that it works.
 *
 * Every other check in this repository runs against the working tree, where
 * `apps/dashboard/public` and `packages/runtime/dist` are simply *there*. That
 * is why a real packaging bug survived a green CI: `npm pack` cannot reach
 * outside a package directory, so the published CLI had no dashboard and no
 * browser tracer, and `serve` — the most demoable command — answered 500 for
 * every installed user while the whole suite stayed green.
 *
 * So this packs the actual tarballs, installs them into a throwaway project
 * with no relation to this checkout, and drives the result over HTTP. Nothing
 * short of that would have caught it.
 *
 * Separate from `npm run smoke` on purpose: this one downloads dependencies and
 * takes tens of seconds, and `smoke` is meant to stay fast enough to run often.
 */
import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const onWindows = process.platform === 'win32';

const temp = mkdtempSync(join(tmpdir(), 'flowlens-package-'));
const tarballs = join(temp, 'tarballs');
const project = join(temp, 'consumer');
mkdirSync(tarballs, { recursive: true });
mkdirSync(project, { recursive: true });

/**
 * Read from disk, so a version bump does not silently stop testing anything.
 *
 * The npm scope is read the same way, and for the same reason: renaming the
 * scope once left this script hunting for tarballs that `npm pack` no longer
 * produces. `npm pack` names a scoped tarball `scope-name-version.tgz`.
 */
const cliManifest = JSON.parse(readFileSync(join(root, 'packages', 'cli', 'package.json'), 'utf8'));
const version = cliManifest.version;
const scope = cliManifest.name.split('/')[0].replace('@', '');
const tarball = (name) => join(tarballs, `${scope}-${name}-${version}.tgz`);

let failures = 0;

process.stdout.write(
  `Flowslens package test — ${process.platform}, Node ${process.versions.node}\n\n`,
);

function ok(name) {
  process.stdout.write(`  ${'ok'.padEnd(6)}${name}\n`);
}

function bad(name, detail) {
  failures += 1;
  process.stdout.write(`  ${'FAIL'.padEnd(6)}${name}\n`);
  if (detail) process.stdout.write(`${String(detail).trim().replace(/^/gm, '        ')}\n`);
}

function run(name, command, args, options = {}) {
  const result = spawnSync(command, args, {
    encoding: 'utf8',
    shell: onWindows,
    ...options,
  });
  if (result.status === 0) {
    ok(name);
    return result;
  }
  bad(name, `${result.stdout ?? ''}\n${result.stderr ?? ''}`);
  return result;
}

// 1. Build, then pack each package exactly as `npm publish` would. `prepack`
//    fires here, which is the step being tested.
run('build', npm, ['run', 'build'], { cwd: root, env: { ...process.env } });

for (const name of ['core', 'runtime', 'cli']) {
  run(`pack @flowslens/${name}`, npm, ['pack', '--pack-destination', tarballs], {
    cwd: join(root, 'packages', name),
  });
}

// 2. A consumer project that knows nothing about this checkout.
run('create a consumer project', npm, ['init', '-y'], { cwd: project });

/**
 * Install what `npx @flowslens/cli` actually gives you: the CLI and its one
 * dependency, `@flowslens/core`.
 *
 * `@flowslens/runtime` is deliberately *not* installed. It is a dev dependency a
 * user adds to their own app to record traces, not something the CLI depends
 * on — so if the browser tracer is only reachable through a sibling
 * `@flowslens/runtime` directory, it is not reachable for a real user at all.
 * Installing it here would hide exactly that.
 */
const install = run(
  'install the published packages',
  npm,
  ['install', tarball('core'), tarball('cli')],
  {
    cwd: project,
  },
);

const installed = join(project, 'node_modules', `@${scope}`, 'cli', 'bin', 'flowlens.mjs');

/** Drive the installed CLI through Node, so bin shims are not part of the test. */
function flowlens(name, args) {
  return run(name, process.execPath, [installed, ...args], {
    cwd: project,
    env: { ...process.env, FLOWLENS_CACHE: join(temp, 'cache'), NO_COLOR: '1' },
  });
}

if (install.status === 0) {
  flowlens('the installed CLI reports its version', ['--version']);
  flowlens('scan the bundled example from outside the repo', [
    'scan',
    join(root, 'examples', 'crud'),
  ]);
  flowlens('where works from an install', [
    'where',
    'web/src/components/OrderForm.tsx:20',
    join(root, 'examples', 'crud'),
  ]);
  await checkDashboard();
  checkMcp();
  checkRuntime();
}

rmSync(temp, { recursive: true, force: true });

process.stdout.write(
  failures === 0 ? '\npackage test passed\n' : `\npackage test failed (${failures})\n`,
);
process.exit(failures === 0 ? 0 : 1);

/**
 * The check that matters: a real browser request to a real installed server.
 *
 * `serve` prints its URL and then stays up, so the port is read from stdout
 * rather than assumed — it moves to the next free one when 4177 is taken.
 */
async function checkDashboard() {
  const server = spawn(
    process.execPath,
    [installed, 'serve', join(root, 'examples', 'crud'), '--no-open'],
    {
      cwd: project,
      env: { ...process.env, FLOWLENS_CACHE: join(temp, 'cache'), NO_COLOR: '1' },
    },
  );

  let output = '';
  const url = await new Promise((done) => {
    const timer = setTimeout(() => done(undefined), 30_000);
    server.stdout.on('data', (chunk) => {
      output += chunk;
      const found = /http:\/\/[\d.]+:\d+/.exec(output);
      if (found) {
        clearTimeout(timer);
        done(found[0]);
      }
    });
    server.stderr.on('data', (chunk) => {
      output += chunk;
    });
    server.on('exit', () => {
      clearTimeout(timer);
      done(undefined);
    });
  });

  if (!url) {
    bad('serve starts from an install', output);
    server.kill();
    return;
  }
  ok('serve starts from an install');

  for (const [name, path] of [
    ['the dashboard page is in the package', '/'],
    ['the dashboard API answers', '/api/flows'],
    ['the browser tracer is in the package', '/__flowlens/browser.js'],
  ]) {
    try {
      const response = await fetch(`${url}${path}`);
      if (response.ok) ok(name);
      else bad(name, `${path} -> ${response.status} ${(await response.text()).slice(0, 120)}`);
    } catch (error) {
      bad(name, error.message);
    }
  }

  server.kill();
}

/** `flowlens mcp` from an install: a handshake and one tool call, over stdio. */
function checkMcp() {
  const lines = [
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } },
    {
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: { name: 'list_actions', arguments: {} },
    },
  ];
  const result = spawnSync(process.execPath, [installed, 'mcp', join(root, 'examples', 'crud')], {
    cwd: project,
    encoding: 'utf8',
    input: lines.map((line) => JSON.stringify(line)).join('\n') + '\n',
    env: { ...process.env, FLOWLENS_CACHE: join(temp, 'cache'), NO_COLOR: '1' },
  });
  try {
    const answers = result.stdout
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    const listed = answers.find((answer) => answer.id === 2)?.result?.content?.[0]?.text ?? '';
    if (answers[0]?.result?.serverInfo?.name === 'flowlens' && listed.includes('orderform')) {
      ok('the MCP server answers from an install');
    } else {
      bad('the MCP server answers from an install', result.stdout + result.stderr);
    }
  } catch (error) {
    bad(
      'the MCP server answers from an install',
      `${error.message}\n${result.stdout}${result.stderr}`,
    );
  }
}

/**
 * `@flowslens/runtime` the way an app installs it: the Next.js entry and the
 * MongoDB driver tracer must resolve through the package's own `exports`.
 */
function checkRuntime() {
  const app = join(temp, 'runtime-app');
  mkdirSync(app, { recursive: true });
  run('create an app that installs the runtime', npm, ['init', '-y'], { cwd: app });
  const installed = run('install @flowslens/runtime', npm, ['install', tarball('runtime')], {
    cwd: app,
  });
  if (installed.status !== 0) return;
  // A file, not `node -e`: on Windows `run` goes through the shell, and cmd
  // mangles a quoted script on the command line.
  const check = join(app, 'check.mjs');
  writeFileSync(
    check,
    [
      "const next = await import('@flowslens/runtime/next');",
      "const runtime = await import('@flowslens/runtime');",
      "const browser = await import('@flowslens/runtime/browser');",
      "if (typeof next.register !== 'function') throw new Error('no register');",
      "if (typeof runtime.traceDb !== 'function') throw new Error('no traceDb');",
      "if (typeof runtime.installServerTracing !== 'function') throw new Error('no installServerTracing');",
      "if (typeof browser.installBrowserTracer !== 'function') throw new Error('no browser tracer');",
    ].join('\n'),
    'utf8',
  );
  run('the runtime exports register, traceDb and the browser tracer', process.execPath, [check], {
    cwd: app,
  });
}
