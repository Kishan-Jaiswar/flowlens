#!/usr/bin/env node
/**
 * End-to-end smoke test, run the way a user runs FlowLens.
 *
 * The CLI is the product, so every command is executed as a real process
 * against the bundled example project. Unit tests can pass while the thing
 * someone actually types is broken — argument parsing, the bin entry point, the
 * dashboard's static assets and the exit codes all live outside them.
 *
 * Plain Node with no shell: the previous version of this was a bash block in
 * the CI workflow, which meant it could only ever prove FlowLens worked on
 * Linux. This runs identically on Windows, macOS and Linux.
 */
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const BIN = join(ROOT, 'packages', 'cli', 'bin', 'flowlens.mjs');
const PROJECT = join(ROOT, 'examples', 'clinic');
const PORT = Number(process.env['FLOWLENS_SMOKE_PORT'] ?? 4188);

const temp = mkdtempSync(join(tmpdir(), 'flowlens-smoke-'));
// Never write to the real user cache from a test run.
process.env['FLOWLENS_CACHE'] = join(temp, 'cache');
const TRACE = join(temp, 'trace.jsonl');
let failures = 0;

process.stdout.write(
  `FlowLens smoke test — ${process.platform}, Node ${process.versions.node}\n\n`,
);

// A trace left behind by an earlier run would change what `trace` reports.
// FlowLens keeps artifacts in a machine-local cache, never in the project, so
// there is nothing to clean up inside examples/clinic. Assert that instead.
assertNoArtifactsIn(PROJECT);

flowlens('the version prints', ['--version']);
flowlens('help exits cleanly', ['--help']);
flowlens('scan the example project', ['scan', PROJECT]);
flowlens('list the flows', ['flows', PROJECT]);
flowlens('doctor reports on the seam', ['doctor', PROJECT]);

// A project named without any separator — the spelling that used to be
// mistaken for a flow id and silently scanned the current directory instead.
flowlens('scan a project named without a path separator', ['scan', 'clinic'], {
  cwd: join(ROOT, 'examples'),
});

// A missing project must say so rather than quietly scanning the cwd.
expectFailure('a missing project is an error, not a silent success', ['scan', 'no-such-project']);

const markdown = join(temp, 'feature.md');
flowlens('generate a feature document', [
  'flow',
  'prescriptionform-submit-prescription',
  PROJECT,
  '--markdown',
  '--out',
  markdown,
]);
check('the document is not empty', () => existsSync(markdown) && statSync(markdown).size > 0);

run('fabricate runtime spans', process.execPath, [join(PROJECT, 'demo-trace.mjs'), TRACE]);
flowlens('merge the runtime trace', ['trace', PROJECT, '--trace', TRACE]);
flowlens('impact analysis', ['impact', 'AuditService.record', '-p', PROJECT]);

await dashboard();

rmSync(temp, { recursive: true, force: true });
assertNoArtifactsIn(PROJECT);

process.stdout.write(
  failures === 0 ? '\nsmoke test passed\n' : `\nsmoke test FAILED (${failures})\n`,
);
process.exit(failures === 0 ? 0 : 1);

/** Start the dashboard, ask it for real data, shut it down. */
async function dashboard() {
  const server = spawn(
    process.execPath,
    [BIN, 'serve', PROJECT, '--port', String(PORT), '--no-open'],
    {
      cwd: ROOT,
      stdio: 'ignore',
    },
  );

  try {
    const base = `http://127.0.0.1:${PORT}`;
    // Poll rather than sleep: the first response waits on a full scan.
    const deadline = Date.now() + 60_000;
    for (;;) {
      if (server.exitCode !== null) throw new Error(`serve exited early (${server.exitCode})`);
      try {
        const response = await fetch(`${base}/`);
        if (response.ok) break;
      } catch {
        /* not listening yet */
      }
      if (Date.now() > deadline) throw new Error('the dashboard never became ready');
      await new Promise((done) => setTimeout(done, 250));
    }

    const flows = await (await fetch(`${base}/api/flows`)).json();
    check('the dashboard serves flows', () => Array.isArray(flows) && flows.length > 0);

    const page = await (await fetch(`${base}/`)).text();
    check(
      'the dashboard serves its page',
      () => page.includes('<html') || page.includes('<!DOCTYPE'),
    );

    // Path traversal must not escape the dashboard directory.
    const escaped = await (await fetch(`${base}/../../package.json`)).text();
    check('a traversal attempt does not leak a file', () => !escaped.includes('flowlens-monorepo'));

    pass('the dashboard answers');
  } catch (error) {
    fail('the dashboard answers', error.message);
  } finally {
    server.kill();
  }
}

function flowlens(name, args, options = {}) {
  run(name, process.execPath, [BIN, ...args], options);
}

function run(name, command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? ROOT,
    encoding: 'utf8',
    // Windows needs a generous timeout: a cold ts-morph parse of the example is
    // slower there, and a hang should still fail rather than block CI forever.
    timeout: 180_000,
  });
  if (result.status === 0) {
    pass(name);
    return result;
  }
  fail(name, `exit ${result.status}\n${indent(result.stderr || result.stdout)}`);
  return result;
}

function expectFailure(name, args) {
  const result = spawnSync(process.execPath, [BIN, ...args], {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: 180_000,
  });
  if (result.status !== 0) {
    pass(name);
    return;
  }
  fail(name, 'the command succeeded when it should have failed');
}

function check(name, predicate) {
  try {
    if (predicate()) pass(name);
    else fail(name, 'assertion failed');
  } catch (error) {
    fail(name, error.message);
  }
}

function pass(name) {
  process.stdout.write(`  ok    ${name}\n`);
}

function fail(name, detail) {
  failures += 1;
  process.stdout.write(`  FAIL  ${name}\n${detail ? `${indent(detail)}\n` : ''}`);
}

function indent(text) {
  return String(text ?? '')
    .split('\n')
    .map((line) => `        ${line}`)
    .join('\n')
    .trimEnd();
}

/**
 * The read-only guarantee, checked end to end.
 *
 * FlowLens must leave the project it reads byte-for-byte unchanged, so no run of
 * any command may leave an artifact behind. This is asserted before and after the
 * whole suite rather than unit-tested, because it is the property a developer
 * actually cares about.
 */
function assertNoArtifactsIn(project) {
  const strays = ['.flowlens', 'graph.json', 'trace.jsonl', 'flowlens.config.json'].filter((name) =>
    existsSync(join(project, name)),
  );
  const name = `no FlowLens artifacts inside ${basename(project)}`;
  if (strays.length === 0) pass(name);
  else fail(name, `left behind: ${strays.join(', ')}`);
}
