#!/usr/bin/env node
/**
 * The launcher: `flowlens` from a checkout, with no setup step.
 *
 * FlowLens is meant to be copied onto a machine — a laptop, a USB stick, a
 * fresh clone — pointed at whatever project is there, and used. That means the
 * first command someone types must work, not fail with "cannot find
 * ../dist/index.js" because they have not run `npm install && npm run build`
 * yet. So this script does it for them, once, and never again:
 *
 *   - installs dependencies if node_modules is missing
 *   - builds if dist is missing or older than the sources
 *   - then hands over to the real CLI
 *
 * Everything here is plain Node with no dependencies, because it has to run
 * before the dependencies exist. It is also the only part of FlowLens that
 * shells out, and it only ever shells out to npm.
 *
 * The published `@flowlens/cli` package ships a built `dist` and uses
 * `packages/cli/bin/flowlens.mjs` directly — this file is for the repository.
 */
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CLI_BIN = join(ROOT, 'packages', 'cli', 'bin', 'flowlens.mjs');
const CLI_DIST = join(ROOT, 'packages', 'cli', 'dist', 'index.js');
const PACKAGES = join(ROOT, 'packages');

/**
 * Our own record of when the build last ran.
 *
 * Not `dist/index.js`'s timestamp: `tsc -b` is incremental and will not rewrite
 * an output file whose contents did not change, so a source edit anywhere else
 * in the workspace leaves that file older than the sources for ever — and the
 * launcher would rebuild on every single command. Writing the stamp ourselves,
 * immediately after a successful build, is the only timestamp we can trust.
 *
 * It lives in node_modules so it is already ignored by git, and so that a fresh
 * `npm install` correctly forces a rebuild.
 */
const STAMP = join(ROOT, 'node_modules', '.flowlens-build');

const argv = process.argv.slice(2);

if (!existsSync(join(ROOT, 'node_modules'))) {
  note('Installing dependencies (first run only)…');
  if (!npm('npm install --no-fund --no-audit')) {
    fail(
      'npm install failed.\n' +
        'FlowLens needs its dependencies once, then never again. Check the output above.',
    );
  }
}

if (needsBuild()) {
  note('Building FlowLens…');
  if (!npm('npm run build')) {
    fail('Build failed. Check the output above.');
  }
  stampBuild();
}

// Hand over as a child process rather than importing: the real CLI owns its own
// exit-code and event-loop behaviour (`serve` stays alive), and reproducing that
// here would be a second copy of the same rule.
const child = spawn(process.execPath, [CLI_BIN, ...argv], { stdio: 'inherit' });
child.on('error', (error) => fail(`could not start FlowLens: ${error.message}`));
child.on('exit', (code, signal) => {
  if (signal) {
    // Exit the way the child did, so a Ctrl+C still looks like a Ctrl+C.
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 0);
});

/**
 * Is the build missing or stale?
 *
 * An mtime comparison rather than a hash: this runs before every command, so it
 * has to be cheap, and `tsc -b` does the real incremental check anyway. Getting
 * this wrong in the safe direction costs a second; getting it wrong the other
 * way would run a user's command against code they already edited.
 */
function needsBuild() {
  if (!existsSync(CLI_DIST)) return true;
  let built;
  try {
    built = statSync(STAMP).mtimeMs;
  } catch {
    // No stamp: either a first build, or one made by `npm run build` directly.
    // Rebuilding once to establish the stamp is cheap and always correct.
    return true;
  }
  return newestSourceTime() > built;
}

function stampBuild() {
  try {
    writeFileSync(STAMP, `${new Date().toISOString()}\n`, 'utf8');
  } catch {
    // A read-only checkout still works; it just checks the build every time.
  }
}

function newestSourceTime() {
  let newest = 0;
  const stack = [PACKAGES];
  while (stack.length > 0) {
    const dir = stack.pop();
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.name === 'node_modules' || entry.name === 'dist') continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        stack.push(full);
        continue;
      }
      if (!/\.(ts|tsx|mts|cts|json)$/.test(entry.name)) continue;
      try {
        const time = statSync(full).mtimeMs;
        if (time > newest) newest = time;
      } catch {
        /* a file that vanished mid-walk cannot be newer than the build */
      }
    }
  }
  return newest;
}

/**
 * Run npm.
 *
 * A shell, and a single literal command line rather than an argument array.
 * The shell is what makes this work on Windows, where npm is `npm.cmd` and
 * cannot be spawned directly; the single string is what keeps Node from warning
 * about unescaped arguments (DEP0190), which does not apply here because every
 * command line is a constant in this file and no user input reaches it.
 */
function npm(commandLine) {
  const result = spawnSync(commandLine, { cwd: ROOT, stdio: 'inherit', shell: true });
  if (result.error) {
    fail(
      `could not run npm: ${result.error.message}\n` +
        'npm ships with Node. Install Node from https://nodejs.org and try again.',
    );
  }
  return result.status === 0;
}

function note(message) {
  process.stderr.write(`${message}\n`);
}

function fail(message) {
  process.stderr.write(`\nFlowLens: ${message}\n`);
  process.exit(1);
}
