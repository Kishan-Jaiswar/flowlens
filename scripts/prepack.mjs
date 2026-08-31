#!/usr/bin/env node
/**
 * Stage the files the CLI serves at runtime but does not own.
 *
 * Two of them live outside `packages/cli` in this repository, and `npm pack`
 * cannot reach outside a package directory — so a published `@flowlens/cli`
 * shipped `dist/` and `bin/` and nothing else. The result was a tool that
 * installed cleanly, scanned correctly, and then answered its most demoable
 * command with a 500:
 *
 *   GET /                      -> 500  Dashboard assets not found
 *   GET /__flowlens/browser.js -> 404
 *
 * `paths.ts` already looked for both in the published locations first
 * (`packageFile('dashboard')`, `packageFile('runtime', 'browser.js')`) — the
 * lookup order anticipated this copy step, which was simply never written. So
 * this script creates exactly those two paths, plus the LICENSE npm shows on a
 * package page.
 *
 * Run from `prepack`, which npm fires for `npm pack` and `npm publish` alike.
 * Everything it writes is build output: gitignored, and removed by
 * `npm run clean`.
 */
import { copyFileSync, cpSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const cli = join(root, 'packages', 'cli');

/**
 * Fail loudly on a missing source.
 *
 * A silent skip is exactly the failure this script exists to prevent: the pack
 * would succeed, the tarball would look fine, and only an installed user would
 * find out.
 */
function mustExist(path, what) {
  if (existsSync(path)) return path;
  process.stderr.write(
    `prepack: ${what} is missing at ${path}\n` +
      'Run `npm run build` first — packing now would publish a broken CLI.\n',
  );
  process.exit(1);
}

const staged = [];

// The dashboard, which `serve` sends to the browser.
const dashboard = mustExist(
  join(root, 'apps', 'dashboard', 'public'),
  'the dashboard (apps/dashboard/public)',
);
mustExist(join(dashboard, 'index.html'), 'the dashboard entry point (index.html)');
cpSync(dashboard, join(cli, 'dashboard'), { recursive: true });
staged.push('dashboard/');

// The browser tracer, served to the app being traced so that nothing is ever
// copied into the developer's own project.
const tracer = mustExist(
  join(root, 'packages', 'runtime', 'dist', 'browser.js'),
  'the browser tracer (packages/runtime/dist/browser.js)',
);
mkdirSync(join(cli, 'runtime'), { recursive: true });
copyFileSync(tracer, join(cli, 'runtime', 'browser.js'));
staged.push('runtime/browser.js');

// The licence, in every package. npm shows it on the package page, and a
// package without one reads as legally unclear however permissive the repo is.
for (const name of ['cli', 'core', 'runtime']) {
  copyFileSync(join(root, 'LICENSE'), join(root, 'packages', name, 'LICENSE'));
}
staged.push('LICENSE (all three packages)');

process.stdout.write(`prepack: staged ${staged.join(', ')}\n`);
