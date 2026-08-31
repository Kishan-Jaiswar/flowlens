#!/usr/bin/env node
/**
 * FlowLens CLI entry point.
 *
 * Deliberately thin, and deliberately defensive about the two things that
 * actually go wrong before any FlowLens code runs: an old Node, and a checkout
 * that has not been built yet. Both produce a raw stack trace by default, which
 * tells a first-time user nothing.
 *
 * `serve` keeps the event loop alive on its own; every other command is
 * synchronous, so we only exit explicitly for those.
 */
import { createRequire } from 'node:module';

const MINIMUM_NODE = [18, 18, 0];

const current = process.versions.node.split('.').map(Number);
if (isOlder(current, MINIMUM_NODE)) {
  process.stderr.write(
    `FlowLens needs Node ${MINIMUM_NODE.join('.')} or newer — this is Node ${process.versions.node}.\n` +
      `Install a current Node from https://nodejs.org and try again.\n`,
  );
  process.exit(1);
}

let main;
try {
  ({ main } = await import('../dist/index.js'));
} catch (error) {
  if (error?.code === 'ERR_MODULE_NOT_FOUND') {
    const require = createRequire(import.meta.url);
    let version = '';
    try {
      version = ` ${require('../package.json').version}`;
    } catch {
      /* not important enough to fail over */
    }
    process.stderr.write(
      `FlowLens${version} is not built yet.\n\n` +
        `From the repository root, run:\n` +
        `  npm install\n` +
        `  npm run build\n\n` +
        `Or use the bundled launcher, which does both for you:\n` +
        `  ./flowlens <command>      (macOS, Linux)\n` +
        `  .\\flowlens.cmd <command>  (Windows)\n`,
    );
    process.exit(1);
  }
  throw error;
}

const code = main();
if (process.argv[2] !== 'serve' || code !== 0) {
  process.exitCode = code;
  if (code !== 0) process.exit(code);
}

function isOlder(actual, minimum) {
  for (let i = 0; i < minimum.length; i += 1) {
    const a = actual[i] ?? 0;
    const b = minimum[i] ?? 0;
    if (a !== b) return a < b;
  }
  return false;
}
