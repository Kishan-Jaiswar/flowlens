#!/usr/bin/env node
/**
 * Remove build output.
 *
 * Node rather than `rm -rf`, because `rm` does not exist on a Windows shell and
 * a contributor should not have to discover that through a broken script.
 */
import { readdirSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const packages = join(root, 'packages');

let removed = 0;
for (const name of readdirSync(packages)) {
  // `dashboard`, `runtime` and `LICENSE` are staged by prepack.mjs, not by tsc.
  for (const artifact of ['dist', 'tsconfig.tsbuildinfo', 'dashboard', 'runtime', 'LICENSE']) {
    const target = join(packages, name, artifact);
    try {
      rmSync(target, { recursive: true, force: true });
      removed += 1;
    } catch (error) {
      process.stderr.write(`could not remove ${target}: ${error.message}\n`);
      process.exitCode = 1;
    }
  }
}

process.stdout.write(`cleaned ${removed} build artifact paths\n`);
