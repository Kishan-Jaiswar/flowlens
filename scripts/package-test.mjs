#!/usr/bin/env node
/**
 * Install FlowLens the way a stranger will, and check that it works.
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
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
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

/** Read from disk, so a version bump does not silently stop testing anything. */
const version = JSON.parse(readFileSync(join(root, 'packages', 'cli', 'package.json'), 'utf8'))
  .version;
const tarball = (name) => join(tarballs, `flowlens-${name}-${version}.tgz`);

let failures = 0;

process.stdout.write(
  `FlowLens package test — ${process.platform}, Node ${process.versions.node}\n\n`,
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
  run(`pack @flowlens/${name}`, npm, ['pack', '--pack-destination', tarballs], {
    cwd: join(root, 'packages', name),
  });
}

// 2. A consumer project that knows nothing about this checkout.
run('create a consumer project', npm, ['init', '-y'], { cwd: project });

/**
 * Install what `npx @flowlens/cli` actually gives you: the CLI and its one
 * dependency, `@flowlens/core`.
 *
 * `@flowlens/runtime` is deliberately *not* installed. It is a dev dependency a
 * user adds to their own app to record traces, not something the CLI depends
 * on — so if the browser tracer is only reachable through a sibling
 * `@flowlens/runtime` directory, it is not reachable for a real user at all.
 * Installing it here would hide exactly that.
 */
const install = run('install the published packages', npm, ['install', tarball('core'), tarball('cli')], {
  cwd: project,
});

const installed = join(project, 'node_modules', '@flowlens', 'cli', 'bin', 'flowlens.mjs');

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
