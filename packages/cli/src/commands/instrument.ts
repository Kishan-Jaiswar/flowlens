import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { color } from '../ui.js';

export interface InstrumentArgs {
  root: string;
  /** Write nothing; show the files and the steps instead. */
  print?: boolean;
  quiet?: boolean;
}

/**
 * `flowlens instrument` — set up runtime tracing without hand-written glue.
 *
 * Runtime evidence is what turns "read from the source" into "confirmed", and
 * getting it used to mean copying four files out of an app that had already
 * worked it out. This writes the ones that are new files and prints the lines
 * that belong in files the developer owns — it never edits existing code,
 * because a tool that rewrites your layout to add a tracer is a tool you stop
 * running.
 *
 * Everything it sets up is development-only: `register()` and `traceDb()` do
 * nothing when `NODE_ENV` is `production`, and the browser tracer loads only
 * when `NEXT_PUBLIC_FLOWLENS_SPANS` is set.
 */
export function runInstrument(args: InstrumentArgs): number {
  const root = args.root;
  const manifest = readManifest(root);
  if (!manifest) {
    process.stderr.write(`${color.red('error')} no package.json in ${root}\n`);
    return 1;
  }
  const deps = { ...manifest.dependencies, ...manifest.devDependencies };
  const has = (name: string): boolean => name in deps;
  const install = installCommand(root);

  const out: string[] = [];
  const steps: string[] = [];
  /** New files only, in order; `--print` shows them instead of writing. */
  const files: Array<[string, string]> = [];
  const write = (path: string, body: string): void => {
    files.push([path, body]);
  };

  if (!has('@flowslens/runtime')) {
    steps.push(`Install the tracer (dev only, no dependencies of its own):\n    ${install}`);
  }

  if (has('next')) {
    const appDir = ['app', 'src/app'].find((dir) => existsSync(join(root, dir)));
    if (!appDir) {
      process.stderr.write(
        `${color.red('error')} Next.js without an app/ directory: the Pages Router is not ` +
          'set up by this command yet.\n' +
          color.gray('  Wire it by hand: see the @flowslens/runtime README.\n'),
      );
      return 1;
    }
    const base = appDir === 'src/app' ? 'src' : '.';

    // 1. Requests and queries: instrumentation.ts.
    const instrumentation = join(root, base, 'instrumentation.ts');
    if (!existsSync(instrumentation)) {
      write(instrumentation, INSTRUMENTATION);
    } else if (!readFileSync(instrumentation, 'utf8').includes('@flowslens/runtime')) {
      steps.push(
        `Add this inside the register() in ${rel(root, instrumentation)}:\n` +
          "    await (await import('@flowslens/runtime/next')).register();",
      );
    }

    // 2. Clicks: a client component that loads the browser tracer.
    const tracer = join(root, appDir, 'flowlens-tracer.tsx');
    if (!existsSync(tracer)) write(tracer, BROWSER_COMPONENT);
    const layout = ['layout.tsx', 'layout.jsx', 'layout.js']
      .map((name) => join(root, appDir, name))
      .find((path) => existsSync(path));
    // Rendered anywhere counts — a providers component is as good as the layout.
    if (!mentions(root, '<FlowlensTracer')) {
      steps.push(
        `Render it once, inside <body> in ${layout ? rel(root, layout) : `${appDir}/layout.tsx`}:\n` +
          '    import { FlowlensTracer } from "./flowlens-tracer";\n' +
          '    …\n' +
          '    <FlowlensTracer />',
      );
    }
    const envSet = ['.env', '.env.local', '.env.development', '.env.development.local'].some(
      (name) => {
        const path = join(root, name);
        return (
          existsSync(path) && readFileSync(path, 'utf8').includes('NEXT_PUBLIC_FLOWLENS_SPANS')
        );
      },
    );
    if (!envSet)
      steps.push(
        'Point the browser at the dashboard, in .env.local:\n' +
          '    NEXT_PUBLIC_FLOWLENS_SPANS="http://127.0.0.1:4177/__flowlens/spans?token=flowlens-dev"',
      );
  } else if (has('express') || has('@nestjs/core') || has('fastify')) {
    steps.push(
      'Open a span per request, first in the middleware chain (development only):\n' +
        "    import { flowlensHttp } from '@flowslens/runtime';\n" +
        "    if (process.env.NODE_ENV !== 'production') app.use(flowlensHttp());",
    );
  } else {
    steps.push(
      'No Next.js, Express, Nest or Fastify here. Open spans yourself with\n' +
        "    installServerTracing() from '@flowslens/runtime' (any node:http server).",
    );
  }

  // 3. The database.
  const traced = mentions(root, 'traceDb(') || mentions(root, 'flowlensMongoose(');
  if (traced) {
    // Already wired: saying it again would read as "this is still missing".
  } else if (has('mongoose')) {
    steps.push(
      'Trace Mongoose, before any model is compiled:\n' +
        "    import { flowlensMongoose } from '@flowslens/runtime';\n" +
        '    mongoose.plugin(flowlensMongoose());',
    );
  } else if (has('mongodb')) {
    steps.push(
      'Trace the MongoDB driver where the Db handle is made (a no-op in production):\n' +
        "    import { traceDb } from '@flowslens/runtime';\n" +
        '    const db = traceDb(client.db(name));',
    );
  } else if (has('@prisma/client')) {
    steps.push(
      'Prisma queries are read from the source but not traced at runtime yet;\n' +
        '    requests and clicks are.',
    );
  }

  steps.push(
    'Then, in two terminals:\n' +
      '    flowlens serve . --token flowlens-dev   # dashboard + span collector\n' +
      '    npm run dev                              # click through the app, then Rescan',
  );

  if (files.length > 0 && args.print) {
    out.push(color.bold('Would write:'));
    for (const [path, body] of files) {
      out.push(color.cyan(`\n── ${rel(root, path)}`), body.trimEnd());
    }
  } else if (files.length > 0) {
    for (const [path, body] of files) writeFileSync(path, body, 'utf8');
    out.push(
      color.bold('Wrote:'),
      ...files.map(([path]) => `  ${color.green('+')} ${rel(root, path)}`),
    );
  } else {
    out.push(color.gray('Nothing to write — the tracing files are already in place.'));
  }

  out.push('', color.bold('Next:'));
  steps.forEach((step, index) => out.push(`  ${index + 1}. ${step}`));
  if (!args.quiet) {
    out.push(
      '',
      color.gray('Everything here is development-only and sends nothing off this machine:'),
      color.gray('spans go to the dashboard on 127.0.0.1 and to your OS cache.'),
    );
  }
  process.stdout.write(`${out.join('\n')}\n`);
  return 0;
}

const SOURCE = /\.(?:[cm]?[jt]sx?)$/;
const SKIP = new Set(['node_modules', '.next', '.git', 'dist', 'build', 'out', 'coverage']);

/** True when some source file in the project contains `needle`. */
function mentions(root: string, needle: string, limit = 5000): boolean {
  const stack = [root];
  let seen = 0;
  while (stack.length > 0 && seen < limit) {
    const dir = stack.pop()!;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (!SKIP.has(entry.name) && !entry.name.startsWith('.')) stack.push(join(dir, entry.name));
        continue;
      }
      if (!SOURCE.test(entry.name)) continue;
      seen += 1;
      try {
        if (readFileSync(join(dir, entry.name), 'utf8').includes(needle)) return true;
      } catch {
        // An unreadable file cannot be the one that has it.
      }
    }
  }
  return false;
}

function readManifest(
  root: string,
): { dependencies?: Record<string, string>; devDependencies?: Record<string, string> } | undefined {
  try {
    return JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  } catch {
    return undefined;
  }
}

/** The install line for the package manager this project already uses. */
function installCommand(root: string): string {
  if (existsSync(join(root, 'pnpm-lock.yaml'))) return 'pnpm add -D @flowslens/runtime';
  if (existsSync(join(root, 'yarn.lock'))) return 'yarn add -D @flowslens/runtime';
  if (existsSync(join(root, 'bun.lockb')) || existsSync(join(root, 'bun.lock'))) {
    return 'bun add -d @flowslens/runtime';
  }
  return 'npm install -D @flowslens/runtime';
}

function rel(root: string, path: string): string {
  return relative(root, path).split('\\').join('/');
}

const INSTRUMENTATION = `// Flowslens request and query tracing — development only (a no-op in production).
// Written by \`flowlens instrument\`; delete this file to turn tracing off.
export { register } from "@flowslens/runtime/next";
`;

const BROWSER_COMPONENT = `"use client";

import { useEffect } from "react";

/**
 * Links a click to the requests it caused — development only.
 *
 * Loads nothing unless NEXT_PUBLIC_FLOWLENS_SPANS is set, and never in a
 * production build. Written by \`flowlens instrument\`.
 */
const SPANS_ENDPOINT = process.env.NEXT_PUBLIC_FLOWLENS_SPANS;

export function FlowlensTracer() {
  useEffect(() => {
    if (!SPANS_ENDPOINT || process.env.NODE_ENV === "production") return;
    let stop: (() => void) | undefined;
    let cancelled = false;
    import("@flowslens/runtime/browser")
      .then(({ installBrowserTracer }) => {
        if (!cancelled) stop = installBrowserTracer({ endpoint: SPANS_ENDPOINT });
      })
      .catch((error: unknown) => console.warn("[flowlens] browser tracer not loaded:", error));
    return () => {
      cancelled = true;
      stop?.();
    };
  }, []);
  return null;
}
`;
