/**
 * What is this project built with?
 *
 * The other half of "understand an unfamiliar application". The flow graph
 * answers "what happens when I click this"; nothing answered "what am I even
 * looking at" — which is the question that comes first, on the morning of day
 * one, before any flow makes sense.
 *
 * The signals were already here and thrown away: `classify.ts` knows the
 * server and client module lists well enough to decide which side a file is on,
 * then discards the evidence. This reads the manifests instead, so the answer
 * includes versions — the thing you actually need before you touch anything,
 * because React 17 and React 19 are different projects.
 *
 * Deliberately filesystem-only: no parse, no graph, no `node_modules`. `stack`
 * has to be the fastest command in the tool, because it is the first one
 * anybody runs.
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

/** What a dependency is *for*, which is how a newcomer reads a stack. */
export type StackRole =
  | 'language'
  | 'frontend'
  | 'meta-framework'
  | 'ui'
  | 'state'
  | 'api-client'
  | 'backend'
  | 'database'
  | 'auth'
  | 'queue'
  | 'realtime'
  | 'testing'
  | 'build';

/** Roles in reading order: the front door first, the toolchain last. */
export const STACK_ROLE_ORDER: readonly StackRole[] = [
  'language',
  'frontend',
  'meta-framework',
  'ui',
  'state',
  'api-client',
  'backend',
  'database',
  'auth',
  'queue',
  'realtime',
  'testing',
  'build',
];

export const STACK_ROLE_LABEL: Record<StackRole, string> = {
  language: 'Language',
  frontend: 'Frontend',
  'meta-framework': 'Framework',
  ui: 'UI toolkit',
  state: 'State & data fetching',
  'api-client': 'HTTP client',
  backend: 'Backend',
  database: 'Database',
  auth: 'Auth',
  queue: 'Jobs & messaging',
  realtime: 'Realtime',
  testing: 'Testing',
  build: 'Build & tooling',
};

interface Rule {
  /** Exact package name, or a prefix ending in `/` for a scope. */
  match: string | RegExp;
  role: StackRole;
  /** Shown instead of the raw package name when it is clearer. */
  as?: string;
  /**
   * Whether Flowslens can currently trace this part of the stack.
   *
   * The whole reason this table carries the flag: a stack report that lists
   * Vue and Prisma without saying which of them Flowslens reads is a report
   * that overpromises. `scan` already tells the truth about what it skipped;
   * `stack` should tell it before you spend the afternoon.
   *
   * `'edge'` is the third honest answer, and it exists because two of the
   * others would both be lies. A flow that enqueues a BullMQ job *is* traced up
   * to the `queue.add()` that hands it over — that step now appears as an
   * `external-effect` node — but what the worker does next is not read at all.
   * Calling that `true` promises a chain that stops; calling it `false` hides a
   * step that is really there.
   */
  read?: boolean | 'edge';
}

/**
 * The recognised ecosystem.
 *
 * Long, flat and boring on purpose — a lookup table is auditable, and every
 * entry is a package a reader can verify. Anything not listed still shows up
 * in the dependency count, it just does not get a role.
 */
const RULES: readonly Rule[] = [
  // language & runtime
  { match: 'typescript', role: 'language', as: 'TypeScript', read: true },
  // frontend frameworks
  { match: 'react', role: 'frontend', as: 'React', read: true },
  { match: 'react-native', role: 'frontend', as: 'React Native', read: true },
  { match: 'vue', role: 'frontend', as: 'Vue', read: false },
  { match: 'svelte', role: 'frontend', as: 'Svelte', read: false },
  { match: /^@angular\/core$/, role: 'frontend', as: 'Angular', read: false },
  { match: 'solid-js', role: 'frontend', as: 'Solid', read: false },
  { match: 'preact', role: 'frontend', as: 'Preact', read: false },
  // meta-frameworks
  { match: 'next', role: 'meta-framework', as: 'Next.js', read: true },
  { match: 'nuxt', role: 'meta-framework', as: 'Nuxt', read: false },
  { match: '@remix-run/react', role: 'meta-framework', as: 'Remix', read: false },
  { match: '@sveltejs/kit', role: 'meta-framework', as: 'SvelteKit', read: false },
  { match: 'astro', role: 'meta-framework', as: 'Astro', read: false },
  { match: 'gatsby', role: 'meta-framework', as: 'Gatsby', read: false },
  { match: 'expo', role: 'meta-framework', as: 'Expo', read: false },
  // ui
  { match: /^@mui\/material$/, role: 'ui', as: 'MUI' },
  { match: 'antd', role: 'ui', as: 'Ant Design' },
  { match: 'tailwindcss', role: 'ui', as: 'Tailwind CSS' },
  { match: /^@chakra-ui\//, role: 'ui', as: 'Chakra UI' },
  { match: /^@mantine\/core$/, role: 'ui', as: 'Mantine' },
  { match: 'bootstrap', role: 'ui', as: 'Bootstrap' },
  { match: /^@radix-ui\//, role: 'ui', as: 'Radix' },
  { match: 'styled-components', role: 'ui', as: 'styled-components' },
  // state & data fetching
  { match: 'redux', role: 'state', as: 'Redux' },
  { match: '@reduxjs/toolkit', role: 'state', as: 'Redux Toolkit' },
  { match: 'zustand', role: 'state', as: 'Zustand' },
  { match: 'jotai', role: 'state', as: 'Jotai' },
  { match: 'recoil', role: 'state', as: 'Recoil' },
  { match: 'mobx', role: 'state', as: 'MobX' },
  { match: '@tanstack/react-query', role: 'state', as: 'React Query', read: true },
  { match: 'swr', role: 'state', as: 'SWR', read: true },
  { match: 'react-hook-form', role: 'state', as: 'React Hook Form' },
  { match: 'formik', role: 'state', as: 'Formik' },
  // http clients
  { match: 'axios', role: 'api-client', as: 'axios', read: true },
  { match: 'ky', role: 'api-client', as: 'ky' },
  { match: 'got', role: 'api-client', as: 'got' },
  { match: 'graphql', role: 'api-client', as: 'GraphQL', read: false },
  { match: '@apollo/client', role: 'api-client', as: 'Apollo Client', read: false },
  { match: '@trpc/client', role: 'api-client', as: 'tRPC', read: false },
  // backend
  { match: /^@nestjs\/core$/, role: 'backend', as: 'NestJS', read: true },
  { match: 'express', role: 'backend', as: 'Express', read: true },
  { match: 'fastify', role: 'backend', as: 'Fastify', read: true },
  { match: 'koa', role: 'backend', as: 'Koa', read: false },
  { match: '@hapi/hapi', role: 'backend', as: 'hapi', read: false },
  { match: 'apollo-server', role: 'backend', as: 'Apollo Server', read: false },
  { match: '@trpc/server', role: 'backend', as: 'tRPC server', read: false },
  // database
  { match: 'mongoose', role: 'database', as: 'Mongoose (MongoDB)', read: true },
  { match: 'mongodb', role: 'database', as: 'MongoDB driver', read: true },
  { match: '@prisma/client', role: 'database', as: 'Prisma', read: true },
  { match: 'typeorm', role: 'database', as: 'TypeORM', read: false },
  { match: 'sequelize', role: 'database', as: 'Sequelize', read: false },
  { match: 'drizzle-orm', role: 'database', as: 'Drizzle', read: false },
  { match: 'knex', role: 'database', as: 'Knex', read: false },
  { match: 'pg', role: 'database', as: 'PostgreSQL driver', read: false },
  { match: /^mysql2?$/, role: 'database', as: 'MySQL driver', read: false },
  { match: 'better-sqlite3', role: 'database', as: 'SQLite', read: false },
  { match: '@supabase/supabase-js', role: 'database', as: 'Supabase', read: false },
  { match: 'firebase', role: 'database', as: 'Firebase', read: false },
  // auth
  { match: 'passport', role: 'auth', as: 'Passport' },
  { match: /^@nestjs\/passport$/, role: 'auth', as: 'Nest Passport' },
  { match: 'jsonwebtoken', role: 'auth', as: 'JWT' },
  { match: 'next-auth', role: 'auth', as: 'NextAuth' },
  { match: '@auth/core', role: 'auth', as: 'Auth.js' },
  { match: '@clerk/nextjs', role: 'auth', as: 'Clerk' },
  { match: 'bcrypt', role: 'auth', as: 'bcrypt' },
  { match: 'bcryptjs', role: 'auth', as: 'bcrypt' },
  // queues & messaging
  { match: 'bullmq', role: 'queue', read: 'edge', as: 'BullMQ' },
  { match: 'bull', role: 'queue', read: 'edge', as: 'Bull' },
  { match: 'kafkajs', role: 'queue', read: 'edge', as: 'Kafka' },
  { match: 'amqplib', role: 'queue', read: 'edge', as: 'RabbitMQ' },
  { match: 'ioredis', role: 'queue', read: 'edge', as: 'Redis' },
  { match: 'redis', role: 'queue', read: 'edge', as: 'Redis' },
  // realtime
  { match: 'socket.io', role: 'realtime', read: 'edge', as: 'Socket.IO' },
  { match: 'ws', role: 'realtime', read: 'edge', as: 'ws' },
  { match: 'pusher', role: 'realtime', read: 'edge', as: 'Pusher' },
  // testing
  { match: 'vitest', role: 'testing', as: 'Vitest' },
  { match: 'jest', role: 'testing', as: 'Jest' },
  { match: 'mocha', role: 'testing', as: 'Mocha' },
  { match: '@playwright/test', role: 'testing', as: 'Playwright' },
  { match: 'cypress', role: 'testing', as: 'Cypress' },
  { match: '@testing-library/react', role: 'testing', as: 'Testing Library' },
  // build & tooling
  { match: 'vite', role: 'build', as: 'Vite' },
  { match: 'webpack', role: 'build', as: 'webpack' },
  { match: 'esbuild', role: 'build', as: 'esbuild' },
  { match: 'turbo', role: 'build', as: 'Turborepo' },
  { match: 'nx', role: 'build', as: 'Nx' },
  { match: 'eslint', role: 'build', as: 'ESLint' },
  { match: 'prettier', role: 'build', as: 'Prettier' },
  { match: 'docker-compose', role: 'build', as: 'Docker Compose' },
];

/** One entry in the report: a real dependency, at a real version. */
export interface StackEntry {
  /** Display name (`Next.js`), falling back to the package name. */
  name: string;
  /** The package it was detected from. */
  package: string;
  /** The range as written in the manifest (`^15.0.1`). */
  version: string;
  role: StackRole;
  /** Which manifest declared it, relative to the root. */
  from: string;
  dev: boolean;
  /**
   * Whether Flowslens traces this part of the stack today. `'edge'` means the
   * hand-off is shown but the far side is not read. `undefined` means the
   * question does not apply (a UI kit, a linter).
   */
  read?: boolean | 'edge';
  /**
   * Other manifests that declare this package at a *different* version.
   *
   * Reported rather than collapsed, because a monorepo running React 18 in one
   * app and React 19 in another is not a formatting detail — it is the reason
   * a shared component behaves differently in the two, and "first manifest
   * wins" would have quietly picked one and hidden the other.
   */
  conflicts?: Array<{ from: string; version: string }>;
}

export interface StackManifest {
  /** Manifest directory, relative to the root (`.` for the root itself). */
  dir: string;
  name?: string;
  version?: string;
  private?: boolean;
  /** Declared workspace globs, if this manifest is a monorepo root. */
  workspaces?: string[];
  dependencies: number;
  scripts: string[];
}

export interface StackReport {
  root: string;
  manifests: StackManifest[];
  /** npm / pnpm / yarn / bun, from the lockfile that is actually present. */
  packageManager?: string;
  /** `engines.node`, when the project states one. */
  nodeRange?: string;
  entries: StackEntry[];
  /** Notable files that say something a dependency list does not. */
  markers: string[];
  /** Parts of the detected stack Flowslens cannot trace at all yet. */
  unread: string[];
  /** Parts traced only as far as the hand-off out of the app. */
  edgeOnly: string[];
  /** Things worth saying out loud: unreadable or malformed manifests. */
  warnings: string[];
}

const LOCKFILES: ReadonlyArray<[string, string]> = [
  ['pnpm-lock.yaml', 'pnpm'],
  ['yarn.lock', 'yarn'],
  ['bun.lockb', 'bun'],
  ['bun.lock', 'bun'],
  ['package-lock.json', 'npm'],
  ['npm-shrinkwrap.json', 'npm'],
];

/** Files whose mere presence is a fact about the stack. */
const MARKER_FILES: ReadonlyArray<[string, string]> = [
  ['tsconfig.json', 'TypeScript project (tsconfig.json)'],
  ['nest-cli.json', 'NestJS CLI project'],
  ['next.config.js', 'Next.js config'],
  ['next.config.mjs', 'Next.js config'],
  ['next.config.ts', 'Next.js config'],
  ['nuxt.config.ts', 'Nuxt config'],
  ['vite.config.ts', 'Vite config'],
  ['angular.json', 'Angular workspace'],
  ['docker-compose.yml', 'Docker Compose'],
  ['docker-compose.yaml', 'Docker Compose'],
  ['Dockerfile', 'Dockerfile'],
  ['.env.example', 'documented environment (.env.example)'],
  ['prisma/schema.prisma', 'Prisma schema'],
  ['schema.prisma', 'Prisma schema'],
  ['turbo.json', 'Turborepo'],
  ['pnpm-workspace.yaml', 'pnpm workspaces'],
  ['.nvmrc', 'pinned Node version (.nvmrc)'],
];

const SKIP_DIRS = new Set([
  'node_modules',
  '.git',
  'dist',
  'build',
  'out',
  '.next',
  '.nuxt',
  'coverage',
  '.turbo',
  'vendor',
  '.venv',
]);

/** Manifests deeper than this are examples or fixtures, not the project. */
const MAX_DEPTH = 4;

/**
 * Read the stack of one or more roots.
 *
 * Multi-root because the frontend and backend often live in sibling
 * repositories, which is exactly the case where "what is this built with" has
 * two different answers and the developer needs both.
 */
export function detectStack(roots: readonly string[]): StackReport {
  const [primary = '.'] = roots;
  const warnings: string[] = [];
  const manifests: StackManifest[] = [];
  const entries: StackEntry[] = [];
  const seen = new Map<string, StackEntry>();
  let nodeRange: string | undefined;
  let packageManager: string | undefined;
  const markers = new Set<string>();

  for (const root of roots) {
    for (const [file, manager] of LOCKFILES) {
      if (!packageManager && existsSync(join(root, file))) packageManager = manager;
    }
    for (const [file, label] of MARKER_FILES) {
      if (existsSync(join(root, file))) markers.add(label);
    }

    for (const path of findManifests(root)) {
      let parsed: Record<string, unknown>;
      try {
        parsed = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
      } catch {
        warnings.push(`could not read ${rel(primary, path)} — skipped`);
        continue;
      }

      const dir = rel(primary, join(path, '..')) || '.';
      const deps = record(parsed.dependencies);
      const devDeps = record(parsed.devDependencies);
      const peerDeps = record(parsed.peerDependencies);

      manifests.push({
        dir,
        ...(typeof parsed.name === 'string' ? { name: parsed.name } : {}),
        ...(typeof parsed.version === 'string' ? { version: parsed.version } : {}),
        ...(parsed.private === true ? { private: true } : {}),
        ...(stringArray(parsed.workspaces) ? { workspaces: stringArray(parsed.workspaces)! } : {}),
        dependencies: Object.keys(deps).length + Object.keys(devDeps).length,
        scripts: Object.keys(record(parsed.scripts)),
      });

      const engines = record(parsed.engines);
      if (!nodeRange && typeof engines.node === 'string') nodeRange = engines.node;
      if (!packageManager && typeof parsed.packageManager === 'string') {
        packageManager = parsed.packageManager.split('@')[0];
      }

      for (const [group, dev] of [
        [deps, false],
        [devDeps, true],
        [peerDeps, true],
      ] as const) {
        for (const [name, version] of Object.entries(group)) {
          const rule = ruleFor(name);
          if (!rule) continue;
          const label = rule.as ?? name;
          /**
           * One entry per package, not per manifest.
           *
           * A monorepo declares `react` in three workspaces; reporting it three
           * times makes the report longer without making it truer. The first
           * manifest wins, and `from` names it, so the reader can still find a
           * version disagreement by looking there.
           */
          const key = `${label}:${name}`;
          const declared = typeof version === 'string' ? version : 'unknown';
          const already = seen.get(key);
          if (already) {
            if (already.version !== declared) {
              already.conflicts = [...(already.conflicts ?? []), { from: dir, version: declared }];
            }
            continue;
          }
          const entry: StackEntry = {
            name: label,
            package: name,
            version: declared,
            role: rule.role,
            from: dir,
            dev,
            ...(rule.read !== undefined ? { read: rule.read } : {}),
          };
          seen.set(key, entry);
          entries.push(entry);
        }
      }
    }
  }

  entries.sort(
    (a, b) =>
      STACK_ROLE_ORDER.indexOf(a.role) - STACK_ROLE_ORDER.indexOf(b.role) ||
      a.name.localeCompare(b.name),
  );

  return {
    root: primary,
    manifests,
    ...(packageManager ? { packageManager } : {}),
    ...(nodeRange ? { nodeRange } : {}),
    entries,
    markers: [...markers],
    unread: entries.filter((entry) => entry.read === false).map((entry) => entry.name),
    edgeOnly: entries.filter((entry) => entry.read === 'edge').map((entry) => entry.name),
    warnings,
  };
}

/** The headline: the one frontend, backend and database worth naming. */
export function stackSummary(report: StackReport): string {
  const pick = (role: StackRole): string | undefined =>
    report.entries.find((entry) => entry.role === role)?.name;
  const parts = [
    pick('meta-framework') ?? pick('frontend'),
    pick('backend'),
    pick('database'),
  ].filter((part): part is string => Boolean(part));
  return parts.length > 0 ? parts.join(' + ') : 'no recognised framework';
}

function ruleFor(name: string): Rule | undefined {
  return RULES.find((rule) =>
    typeof rule.match === 'string' ? rule.match === name : rule.match.test(name),
  );
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function stringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const out = value.filter((item): item is string => typeof item === 'string');
  return out.length > 0 ? out : undefined;
}

function rel(root: string, path: string): string {
  return relative(root, path).split(sep).join('/');
}

/** Every `package.json` in the tree, nearest first, skipping build output. */
function findManifests(root: string): string[] {
  const found: string[] = [];
  try {
    if (!statSync(root).isDirectory()) return found;
  } catch {
    // An unreadable or missing root is a gap, not a reason to fail.
    return found;
  }

  // Breadth-first, so the root manifest is read before any workspace and wins
  // the `engines.node` and package-manager questions.
  const queue: Array<{ dir: string; depth: number }> = [{ dir: root, depth: 0 }];
  while (queue.length > 0) {
    const { dir, depth } = queue.shift()!;
    const manifest = join(dir, 'package.json');
    if (existsSync(manifest)) found.push(manifest);

    if (depth >= MAX_DEPTH) continue;
    let dirEntries;
    try {
      dirEntries = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of dirEntries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (!entry.isDirectory()) continue;
      if (SKIP_DIRS.has(entry.name) || entry.name.startsWith('.')) continue;
      queue.push({ dir: join(dir, entry.name), depth: depth + 1 });
    }
  }
  return found;
}
