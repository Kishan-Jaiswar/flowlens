import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { detectStack, stackSummary } from '@flowslens/core';

/**
 * A monorepo of the shape Flowslens is aimed at, plus two things it cannot
 * trace, because the interesting assertion is that it says so.
 */
const project = mkdtempSync(join(tmpdir(), 'flowlens-stack-'));

mkdirSync(join(project, 'web'), { recursive: true });
mkdirSync(join(project, 'api'), { recursive: true });
mkdirSync(join(project, 'admin'), { recursive: true });
mkdirSync(join(project, 'prisma'), { recursive: true });
mkdirSync(join(project, 'node_modules', 'react'), { recursive: true });

writeFileSync(
  join(project, 'package.json'),
  JSON.stringify({
    name: 'shop',
    private: true,
    workspaces: ['web', 'api', 'admin'],
    engines: { node: '>=20.11' },
    devDependencies: { typescript: '^5.6.3', vitest: '^4.1.11' },
  }),
  'utf8',
);
writeFileSync(join(project, 'package-lock.json'), '{}', 'utf8');
writeFileSync(join(project, 'tsconfig.json'), '{}', 'utf8');
writeFileSync(join(project, 'prisma', 'schema.prisma'), 'model User {}', 'utf8');

writeFileSync(
  join(project, 'web', 'package.json'),
  JSON.stringify({
    name: '@shop/web',
    dependencies: {
      react: '^18.3.1',
      next: '^15.0.1',
      axios: '^1.7.2',
      '@tanstack/react-query': '^5.51.1',
      antd: '^5.19.1',
    },
  }),
  'utf8',
);

writeFileSync(
  join(project, 'api', 'package.json'),
  JSON.stringify({
    name: '@shop/api',
    dependencies: {
      '@nestjs/core': '^10.3.10',
      mongoose: '^8.5.1',
      '@prisma/client': '^5.17.0',
      jsonwebtoken: '^9.0.2',
      bullmq: '^5.8.4',
      typeorm: '^0.3.20',
    },
  }),
  'utf8',
);

// A second frontend that disagrees about React's version, and a stack Flowslens
// does not read.
writeFileSync(
  join(project, 'admin', 'package.json'),
  JSON.stringify({ name: '@shop/admin', dependencies: { vue: '^3.4.31', react: '^19.0.0' } }),
  'utf8',
);

// Never read: inside node_modules.
writeFileSync(
  join(project, 'node_modules', 'react', 'package.json'),
  JSON.stringify({ name: 'react', version: '18.3.1' }),
  'utf8',
);

const report = detectStack([project]);

describe('detectStack', () => {
  it('names the frontend, backend and database with their declared versions', () => {
    const byName = new Map(report.entries.map((entry) => [entry.name, entry]));
    expect(byName.get('Next.js')?.version).toBe('^15.0.1');
    // `admin` is read before `web`, so its React is the headline one; the
    // disagreement itself is asserted below.
    expect(byName.get('React')?.version).toBe('^19.0.0');
    expect(byName.get('NestJS')?.version).toBe('^10.3.10');
    expect(byName.get('Mongoose (MongoDB)')?.version).toBe('^8.5.1');
  });

  it('summarises the stack in one line', () => {
    expect(stackSummary(report)).toBe('Next.js + NestJS + Mongoose (MongoDB)');
  });

  it('files each dependency under what it is for', () => {
    const role = (name: string) => report.entries.find((entry) => entry.name === name)?.role;
    expect(role('React Query')).toBe('state');
    expect(role('axios')).toBe('api-client');
    expect(role('JWT')).toBe('auth');
    expect(role('BullMQ')).toBe('queue');
    expect(role('Ant Design')).toBe('ui');
    expect(role('Vitest')).toBe('testing');
  });

  it('says which parts of the detected stack it cannot trace', () => {
    expect(report.unread).toContain('Vue');
    expect(report.unread).toContain('TypeORM');
    // The ones it does read must not be listed as unread.
    expect(report.unread).not.toContain('React');
    expect(report.unread).not.toContain('Prisma');
  });

  /**
   * Neither "traced" nor "not traced" is true of a queue: the `queue.add()`
   * that hands the job over is now a node, and the worker on the far side is
   * not read at all. Saying so is the whole point of the third state.
   */
  it('separates a hand-off it shows from a stack it cannot read', () => {
    expect(report.edgeOnly).toContain('BullMQ');
    expect(report.unread).not.toContain('BullMQ');
  });

  it('records which manifest each dependency came from', () => {
    const nest = report.entries.find((entry) => entry.name === 'NestJS');
    expect(nest?.from).toBe('api');
    expect(report.entries.find((entry) => entry.name === 'Ant Design')?.from).toBe('web');
  });

  it('reports one entry per package, not one per workspace that declares it', () => {
    expect(report.entries.filter((entry) => entry.name === 'React')).toHaveLength(1);
  });

  /**
   * The case that made "first manifest wins" the wrong rule: two apps in one
   * repo on different majors of React is a real situation, and collapsing them
   * silently would hide the reason a shared component behaves differently.
   */
  it('reports a version disagreement between workspaces instead of hiding it', () => {
    const react = report.entries.find((entry) => entry.name === 'React');
    expect(react?.from).toBe('admin');
    expect(react?.version).toBe('^19.0.0');
    expect(react?.conflicts).toEqual([{ from: 'web', version: '^18.3.1' }]);
  });

  it('does not invent a conflict when two workspaces agree', () => {
    expect(report.entries.find((entry) => entry.name === 'NestJS')?.conflicts).toBeUndefined();
  });

  it('reads the package manager, the node range and the workspace layout', () => {
    expect(report.packageManager).toBe('npm');
    expect(report.nodeRange).toBe('>=20.11');
    expect(report.manifests.map((manifest) => manifest.dir).sort()).toEqual([
      '.',
      'admin',
      'api',
      'web',
    ]);
    expect(report.manifests.find((manifest) => manifest.dir === '.')?.workspaces).toEqual([
      'web',
      'api',
      'admin',
    ]);
  });

  it('never reads node_modules', () => {
    expect(report.manifests.some((manifest) => manifest.dir.includes('node_modules'))).toBe(false);
  });

  it('notes marker files that a dependency list does not mention', () => {
    expect(report.markers).toContain('Prisma schema');
    expect(report.markers).toContain('TypeScript project (tsconfig.json)');
  });

  it('marks dev dependencies as such', () => {
    expect(report.entries.find((entry) => entry.name === 'TypeScript')?.dev).toBe(true);
    expect(report.entries.find((entry) => entry.name === 'React')?.dev).toBe(false);
  });
});

describe('detectStack on a project it cannot read', () => {
  it('warns about a malformed manifest instead of throwing', () => {
    const broken = mkdtempSync(join(tmpdir(), 'flowlens-stack-broken-'));
    writeFileSync(join(broken, 'package.json'), '{ not json', 'utf8');
    const result = detectStack([broken]);
    expect(result.warnings.join(' ')).toMatch(/could not read/);
    expect(result.entries).toEqual([]);
  });

  it('returns an empty report for a directory with no manifest', () => {
    const empty = mkdtempSync(join(tmpdir(), 'flowlens-stack-empty-'));
    const result = detectStack([empty]);
    expect(result.manifests).toEqual([]);
    expect(stackSummary(result)).toBe('no recognised framework');
  });

  it('does not fail on a path that does not exist', () => {
    expect(() => detectStack([join(project, 'nope')])).not.toThrow();
  });
});
