#!/usr/bin/env node
/**
 * FlowLens CLI entry point.
 *
 * `serve` keeps the event loop alive on its own; every other command is
 * synchronous, so we only exit explicitly for those.
 */
import { main } from '../dist/index.js';

const code = main();
if (process.argv[2] !== 'serve' || code !== 0) {
  process.exitCode = code;
  if (code !== 0) process.exit(code);
}
