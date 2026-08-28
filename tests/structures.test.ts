import { afterAll, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig, resolveFlows, routePathFromFile, scan } from '@flowlens/core';

const here = dirname(fileURLToPath(import.meta.url));
const STRUCTURES = resolve(here, 'fixtures', 'structures');

const at = (name: string) => join(STRUCTURES, name);

/** Can this machine create a directory symlink at all? */
function probeSymlinks(dir: string): boolean {
  const target = join(dir, 'probe-target');
  const link = join(dir, 'probe-link');
  try {
    mkdirSync(target, { recursive: true });
    symlinkSync(target, link, 'dir');
    return true;
  } catch {
    return false;
  } finally {
    rmSync(link, { recursive: true, force: true });
    rmSync(target, { recursive: true, force: true });
  }
}

/**
 * FlowLens gets pointed at whatever a developer has on disk. These fixtures are
 * the layouts that broke earlier versions: a flat directory, both Next.js
 * routers, a monorepo, a Nuxt server dir, deep nesting, CommonJS, unparseable
 * files, and a *frontend* folder named `api/`.
 *
 * The bar for every one of them is the same — do not crash, and find the flow.
 */
describe('flat layout (no src, no folders)', () => {
  const result = scan({ root: at('flat') });

  it('finds the whole chain from one directory', () => {
    expect(result.stats.apiCalls).toBe(1);
    expect(result.stats.routes).toBe(1);
    expect(result.seam.matched).toBe(1);
  });

  it('reads an express route and a mongoose model declared inline', () => {
    expect(result.graph.nodesOfKind('collection').map((n) => n.label)).toEqual(['notes']);
  });

  it('resolves the flow', () => {
    const flows = resolveFlows(result.graph);
    expect(flows.map((f) => f.label)).toEqual(['Save Note']);
    expect(flows[0]?.collections.map((c) => c.collection)).toEqual(['notes']);
  });
});

describe('Next.js pages/api (frontend and backend in one project)', () => {
  const result = scan({ root: at('next-pages-api') });

  it('derives routes from the file system', () => {
    const routes = result.graph
      .nodesOfKind('route')
      .map((n) => n.label)
      .sort();
    // patients.js branches on req.method; [id].js uses a switch.
    expect(routes).toEqual([
      'DELETE /patients/:param',
      'GET /patients',
      'PATCH /patients/:param',
      'POST /patients',
    ]);
  });

  it('matches the frontend fetch calls to them', () => {
    expect(result.seam.matched).toBe(2);
  });

  it('reaches the collection from a route handler', () => {
    const flow = resolveFlows(result.graph).find((f) => f.label === 'Create Patient');
    expect(flow?.collections.map((c) => `${c.collection}:${c.access}`)).toContain('patients:write');
  });
});

describe('Next.js App Router', () => {
  const result = scan({ root: at('next-app-router') });

  it('reads one route per exported verb', () => {
    const routes = result.graph
      .nodesOfKind('route')
      .map((n) => n.label)
      .sort();
    expect(routes).toEqual([
      'DELETE /patients/:param',
      'GET /orders',
      'GET /patients/:param',
      'POST /orders',
    ]);
  });

  it('strips the api segment so calls still match', () => {
    // app/api/orders/route.ts -> /orders, matching a fetch to /api/orders.
    expect(result.seam.matched).toBe(1);
  });

  it('finds models imported from a shared lib', () => {
    const collections = result.graph
      .nodesOfKind('collection')
      .map((n) => n.label)
      .sort();
    expect(collections).toEqual(['orders', 'patients']);
  });
});

describe('route path derivation', () => {
  it('handles both routers and every segment convention', () => {
    expect(routePathFromFile('pages/api/patients.ts')).toBe('/patients');
    expect(routePathFromFile('pages/api/patients/index.ts')).toBe('/patients');
    expect(routePathFromFile('pages/api/patients/[id].ts')).toBe('/patients/:param');
    expect(routePathFromFile('pages/api/patients/[...slug].ts')).toBe('/patients/*');
    expect(routePathFromFile('src/pages/api/a/b.js')).toBe('/a/b');
    expect(routePathFromFile('app/api/orders/route.ts', ['/api'])).toBe('/orders');
    expect(routePathFromFile('app/(admin)/api/orders/route.ts', ['/api'])).toBe('/orders');
    expect(routePathFromFile('server/api/products.get.ts')).toBe('/products');
  });

  it('ignores files that are not routes', () => {
    expect(routePathFromFile('components/Button.tsx')).toBeUndefined();
    expect(routePathFromFile('app/page.tsx')).toBeUndefined();
  });
});

describe('monorepo (apps/web + apps/api under one root)', () => {
  const result = scan({ root: at('turborepo') });

  it('joins packages inside a single root', () => {
    expect(result.seam.matched).toBe(1);
    const flow = resolveFlows(result.graph).find((f) => f.label === 'Place Order');
    expect(flow?.endpoints).toEqual(['POST /orders']);
    expect(flow?.collections.map((c) => c.collection)).toEqual(['orders']);
  });
});

describe('Nuxt-style server/api', () => {
  const result = scan({ root: at('nuxt-style') });

  it('reads the method from the filename suffix', () => {
    expect(
      result.graph
        .nodesOfKind('route')
        .map((n) => n.label)
        .sort(),
    ).toEqual(['GET /products', 'POST /products']);
  });
});

describe('a frontend folder named api/', () => {
  const result = scan({ root: at('frontend-api-folder') });

  /**
   * The regression this exists for: an earlier version classified files by path
   * and treated anything under `api/` as backend, silently discarding every
   * call in a frontend that kept its HTTP client there.
   */
  it('does not mistake it for backend code', () => {
    const calls = result.graph
      .nodesOfKind('api-call')
      .map((n) => n.label)
      .sort();
    expect(calls).toEqual(['GET /patients', 'PATCH /patients/:param/archive']);
  });

  it('follows a handler through a service-layer function to the request', () => {
    // handleLoad -> fetchPatients (another module) -> axios.get
    const flows = resolveFlows(result.graph);
    const load = flows.find((f) => f.label === 'Load');
    expect(load?.endpoints).toEqual(['GET /patients']);
  });

  it('follows an inline arrow through a service-layer function too', () => {
    const archive = resolveFlows(result.graph).find((f) => f.label === 'Archive');
    expect(archive?.endpoints).toEqual(['PATCH /patients/:param/archive']);
  });

  it('does not keep helper functions that lead nowhere', () => {
    // Only functions that reach an API call earn a node.
    const modules = result.graph
      .allNodes()
      .filter((node) => node.meta?.['module'] === true)
      .map((node) => node.label)
      .sort();
    expect(modules).toEqual(['archivePatient', 'fetchPatients']);
  });
});

describe('deeply nested source', () => {
  it('walks all the way down', () => {
    const result = scan({ root: at('deep') });
    expect(result.stats.apiCalls).toBe(1);
    expect(resolveFlows(result.graph, { includeLocalOnly: true })).toHaveLength(1);
  });
});

describe('files that cannot be parsed', () => {
  const result = scan({ root: at('odd-files') });

  it('does not abort the scan', () => {
    // A binary file, a syntax error and an empty file sit next to valid code.
    expect(result.stats.apiCalls).toBe(1);
  });

  it('skips declarations and minified bundles', () => {
    const files = result.graph
      .allNodes()
      .map((node) => node.source?.file)
      .filter((file): file is string => Boolean(file));
    expect(files.some((file) => file.endsWith('.d.ts'))).toBe(false);
    expect(files.some((file) => file.endsWith('.min.js'))).toBe(false);
  });
});

describe('CommonJS and .cjs/.mjs', () => {
  const result = scan({ root: at('cjs-app') });

  it('reads require() and modern extensions', () => {
    expect(result.graph.nodesOfKind('route').map((n) => n.label)).toEqual(['GET /items']);
    expect(result.graph.nodesOfKind('api-call').map((n) => n.label)).toEqual(['GET /items']);
    expect(result.seam.matched).toBe(1);
  });
});

describe('symlinks', () => {
  const temp = mkdtempSync(join(tmpdir(), 'flowlens-symlink-'));

  afterAll(() => {
    rmSync(temp, { recursive: true, force: true });
  });

  /**
   * Windows only allows creating symlinks with Developer Mode on or from an
   * elevated shell, so these two tests cannot run on a default Windows box.
   * They are skipped rather than failed: the behaviour they cover is the
   * directory walker's, which is platform-independent and proven on the other
   * runners.
   */
  const canSymlink = probeSymlinks(temp);
  const withSymlinks = canSymlink ? it : it.skip;

  /**
   * Built at test time rather than committed: a real cycle on disk breaks every
   * other tool that walks the tree, including the test runner itself.
   */
  withSymlinks('terminates on a symlink cycle', () => {
    const src = join(temp, 'src');
    mkdirSync(src, { recursive: true });
    writeFileSync(
      join(src, 'App.jsx'),
      `import axios from 'axios';
       export function App() {
         const handleGo = () => axios.get('/api/loop');
         return <button onClick={handleGo}>Go</button>;
       }`,
      'utf8',
    );

    symlinkSync('..', join(src, 'parent'), 'dir'); // points at an ancestor
    symlinkSync('.', join(src, 'self'), 'dir'); // points at itself
    symlinkSync(join(temp, 'nope'), join(src, 'broken'), 'dir'); // dangling

    const result = scan({ root: temp });

    expect(result.stats.filesAnalyzed).toBe(1);
    expect(result.graph.nodesOfKind('api-call').map((n) => n.label)).toEqual(['GET /loop']);
  });

  withSymlinks('follows a symlink that points somewhere useful', () => {
    const linkedRoot = mkdtempSync(join(tmpdir(), 'flowlens-linked-'));
    const real = join(linkedRoot, 'real');
    mkdirSync(real, { recursive: true });
    writeFileSync(
      join(real, 'Widget.jsx'),
      `import axios from 'axios';
       export function Widget() {
         const handleSend = () => axios.post('/api/linked', {});
         return <button onClick={handleSend}>Send</button>;
       }`,
      'utf8',
    );
    const project = join(linkedRoot, 'project');
    mkdirSync(project, { recursive: true });
    symlinkSync(real, join(project, 'shared'), 'dir');

    const result = scan({ root: project });
    expect(result.graph.nodesOfKind('api-call').map((n) => n.label)).toEqual(['POST /linked']);

    rmSync(linkedRoot, { recursive: true, force: true });
  });
});

describe('degenerate inputs', () => {
  it('handles an empty directory without complaint', () => {
    const temp = mkdtempSync(join(tmpdir(), 'flowlens-empty-'));
    const result = scan({ root: temp });
    expect(result.stats.filesAnalyzed).toBe(0);
    expect(result.graph.nodeCount).toBe(0);
    expect(result.diagnostics[0]).toContain('No source files found');
    rmSync(temp, { recursive: true, force: true });
  });

  it('accepts a single file as the root', () => {
    const result = scan({ root: join(at('flat'), 'app.jsx') });
    expect(result.stats.filesAnalyzed).toBe(1);
    expect(result.stats.apiCalls).toBe(1);
  });

  it('reports a missing path clearly', () => {
    expect(() => scan({ root: at('does-not-exist') })).toThrow(/does not exist/);
  });

  it('ignores a directory that only holds dependencies', () => {
    const temp = mkdtempSync(join(tmpdir(), 'flowlens-deps-'));
    mkdirSync(join(temp, 'node_modules', 'left-pad'), { recursive: true });
    writeFileSync(
      join(temp, 'node_modules', 'left-pad', 'index.js'),
      'module.exports = 1;',
      'utf8',
    );
    const result = scan({ root: temp });
    expect(result.stats.filesAnalyzed).toBe(0);
    rmSync(temp, { recursive: true, force: true });
  });

  it('respects an explicit file cap', () => {
    const result = scan({ root: at('next-pages-api'), maxFiles: 1 });
    expect(result.stats.filesAnalyzed).toBe(1);
    expect(result.warnings.join(' ')).toContain('parsing the first 1');
  });

  it('deduplicates a root that is nested inside another root', () => {
    const result = scan({
      root: at('turborepo'),
      extraRoots: [join(at('turborepo'), 'apps', 'api')],
    });
    // The api files must be counted once, not twice.
    const controllers = result.graph.nodesOfKind('controller');
    expect(controllers).toHaveLength(1);
  });
});

describe('configuration file', () => {
  const temp = mkdtempSync(join(tmpdir(), 'flowlens-config-'));

  afterAll(() => rmSync(temp, { recursive: true, force: true }));

  it('reads settings from flowlens.config.json, comments and all', () => {
    writeFileSync(
      join(temp, 'flowlens.config.json'),
      `{
         // A project with its own conventions describes them once.
         "apiPrefixes": ["/v2"],
         "requestFunctionPattern": "^(get|post)Api$",
         "ignore": ["legacy"],
       }`,
      'utf8',
    );

    const { config, path } = loadConfig(temp);
    expect(path).toBe(join(temp, 'flowlens.config.json'));
    expect(config.apiPrefixes).toEqual(['/v2']);
    expect(config.requestFunctionPattern).toBe('^(get|post)Api$');
    expect(config.ignore).toEqual(['legacy']);
  });

  it('finds a config file from a subdirectory', () => {
    const nested = join(temp, 'packages', 'web');
    mkdirSync(nested, { recursive: true });
    expect(loadConfig(nested).config.apiPrefixes).toEqual(['/v2']);
  });

  it('returns empty config when there is none', () => {
    const bare = mkdtempSync(join(tmpdir(), 'flowlens-noconfig-'));
    expect(loadConfig(bare).config).toEqual({});
    expect(loadConfig(bare).path).toBeUndefined();
    rmSync(bare, { recursive: true, force: true });
  });

  it('reports a broken config file clearly', () => {
    const broken = mkdtempSync(join(tmpdir(), 'flowlens-badconfig-'));
    writeFileSync(join(broken, 'flowlens.config.json'), '{ "apiPrefixes": ', 'utf8');
    expect(() => loadConfig(broken)).toThrow(/not valid JSON/);
    rmSync(broken, { recursive: true, force: true });
  });

  it('applies those settings to a scan', () => {
    const project = mkdtempSync(join(tmpdir(), 'flowlens-cfgscan-'));
    mkdirSync(join(project, 'src'), { recursive: true });
    mkdirSync(join(project, 'server'), { recursive: true });
    mkdirSync(join(project, 'legacy'), { recursive: true });

    writeFileSync(
      join(project, 'src', 'App.jsx'),
      `import { postApi } from './client';
       export function App() {
         const handleSave = () => postApi({ url: '/v2/things', body: { a: 1 } });
         return <button onClick={handleSave}>Save Thing</button>;
       }`,
      'utf8',
    );
    writeFileSync(
      join(project, 'src', 'client.js'),
      `import axios from 'axios';
       export const postApi = ({ url, body }) => axios.post(url, body);`,
      'utf8',
    );
    writeFileSync(
      join(project, 'server', 'things.controller.ts'),
      `import { Body, Controller, Post } from '@nestjs/common';
       @Controller('v2/things')
       export class ThingsController {
         @Post()
         create(@Body() body: { a: number }) { return body; }
       }`,
      'utf8',
    );
    writeFileSync(
      join(project, 'legacy', 'Old.jsx'),
      `import axios from 'axios';
       export function Old() {
         const handleX = () => axios.get('/v2/ignored');
         return <button onClick={handleX}>Old</button>;
       }`,
      'utf8',
    );

    const result = scan({
      root: project,
      apiPrefixes: ['/v2'],
      requestFunctionPattern: '^(get|post)Api$',
      ignore: ['legacy'],
    });

    // Custom prefix stripped on both sides, custom wrapper understood.
    expect(result.seam.matched).toBe(1);
    expect(resolveFlows(result.graph).map((f) => f.label)).toEqual(['Save Thing']);
    // The ignored directory contributed nothing.
    expect(result.graph.nodesOfKind('api-call').map((n) => n.label)).toEqual(['POST /things']);

    rmSync(project, { recursive: true, force: true });
  });
});

describe('diagnostics', () => {
  it('explains a frontend with no backend', () => {
    const result = scan({ root: at('deep') });
    expect(result.diagnostics.join(' ')).toContain('no backend routes');
  });

  it('explains a backend with no frontend', () => {
    const result = scan({ root: at('nuxt-style') });
    expect(result.diagnostics.join(' ')).toContain('no components');
  });
});
