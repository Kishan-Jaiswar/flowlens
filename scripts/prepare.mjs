#!/usr/bin/env node
/**
 * Build after `npm install`, so a fresh checkout is immediately usable.
 *
 * Without this, the first thing a new user sees is `flowlens: command not
 * found` or a missing `dist/index.js`, and the fix — a second, undocumented
 * build step — is exactly the kind of friction that makes a tool not get used.
 *
 * It is a `prepare` script rather than `postinstall` so it also runs when the
 * repository is installed as a git dependency, and it fails softly: an install
 * that skipped devDependencies has no TypeScript, and refusing to finish would
 * be worse than shipping unbuilt sources that the launcher can rebuild later.
 */
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// CI installs, then builds explicitly; skipping here keeps the signal clean.
if (process.env['FLOWLENS_SKIP_PREPARE']) {
  process.exit(0);
}

const typescript = join(root, 'node_modules', 'typescript', 'package.json');
if (!existsSync(typescript)) {
  process.stderr.write(
    'FlowLens: skipping the build — TypeScript is not installed ' +
      '(a production-only install?).\nRun `npm install && npm run build` to build it.\n',
  );
  process.exit(0);
}

const result = spawnSync(
  process.execPath,
  [
    join(root, 'node_modules', 'typescript', 'bin', 'tsc'),
    '-b',
    'packages/core',
    'packages/runtime',
    'packages/cli',
  ],
  { cwd: root, stdio: 'inherit' },
);

if (result.error) {
  process.stderr.write(`FlowLens: could not build — ${result.error.message}\n`);
  process.exit(0);
}

process.exit(result.status ?? 0);
