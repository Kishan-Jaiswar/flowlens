import { afterAll, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig, resolveFlows, routePathFromFile, scan } from '@flowslens/core';

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
    // customers.js branches on req.method; [id].js uses a switch.
    expect(routes).toEqual([
      'DELETE /customers/:param',
      'GET /customers',
      'PATCH /customers/:param',
      'POST /customers',
    ]);
  });

  it('matches the frontend fetch calls to them', () => {
    expect(result.seam.matched).toBe(2);
  });

  it('reaches the collection from a route handler', () => {
    const flow = resolveFlows(result.graph).find((f) => f.label === 'Create Customer');
    expect(flow?.collections.map((c) => `${c.collection}:${c.access}`)).toContain(
      'customers:write',
    );
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
      'DELETE /customers/:param',
      'GET /customers/:param',
      'GET /orders',
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
    expect(collections).toEqual(['customers', 'orders']);
  });
});

describe('route path derivation', () => {
  it('handles both routers and every segment convention', () => {
    expect(routePathFromFile('pages/api/customers.ts')).toBe('/customers');
    expect(routePathFromFile('pages/api/customers/index.ts')).toBe('/customers');
    expect(routePathFromFile('pages/api/customers/[id].ts')).toBe('/customers/:param');
    expect(routePathFromFile('pages/api/customers/[...slug].ts')).toBe('/customers/*');
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
    expect(calls).toEqual(['GET /customers', 'PATCH /customers/:param/archive']);
  });

  it('follows a handler through a service-layer function to the request', () => {
    // handleLoad -> fetchCustomers (another module) -> axios.get
    const flows = resolveFlows(result.graph);
    const load = flows.find((f) => f.label === 'Load');
    expect(load?.endpoints).toEqual(['GET /customers']);
  });

  it('follows an inline arrow through a service-layer function too', () => {
    const archive = resolveFlows(result.graph).find((f) => f.label === 'Archive');
    expect(archive?.endpoints).toEqual(['PATCH /customers/:param/archive']);
  });

  it('does not keep helper functions that lead nowhere', () => {
    // Only functions that reach an API call earn a node.
    const modules = result.graph
      .allNodes()
      .filter((node) => node.meta?.['module'] === true)
      .map((node) => node.label)
      .sort();
    expect(modules).toEqual(['archiveCustomer', 'fetchCustomers']);
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

/**
 * Nest lets a class take its dependencies two ways, and a real codebase mixes
 * them: some models arrive as constructor parameters, others as decorated class
 * properties. Reading only the constructor made every query through a
 * property-injected model vanish — the flow reached the service and stopped, so
 * the whole data layer went missing for that endpoint.
 */
describe('property injection', () => {
  const project = mkdtempSync(join(tmpdir(), 'flowlens-propinject-'));

  mkdirSync(join(project, 'src'), { recursive: true });
  writeFileSync(
    join(project, 'src', 'vendor.controller.ts'),
    `import { Controller, Get } from '@nestjs/common';
     import { VendorService } from './vendor.service';
     @Controller('vendor')
     export class VendorController {
       constructor(private readonly vendorService: VendorService) {}
       @Get('customers')
       getCustomers() { return this.vendorService.getCustomersV2(); }
     }`,
    'utf8',
  );
  writeFileSync(
    join(project, 'src', 'vendor.service.ts'),
    `import { Injectable } from '@nestjs/common';
     import { InjectModel } from '@nestjs/mongoose';
     import { Model } from 'mongoose';
     @Injectable()
     export class VendorService {
       // Constructor injection: the form that always worked.
       constructor(
         @InjectModel(Vendor.name) private vendorModel: Model<VendorDocument>,
       ) {}

       // Property injection: the form that used to be invisible.
       @InjectModel(VendorProduct.name)
       private readonly vendorProductModel: Model<VendorProductDocument>;

       async getCustomersV2() {
         const owner = await this.vendorModel.findById('x');
         return this.vendorProductModel.aggregate([]).exec();
       }
     }`,
    'utf8',
  );

  // A flow starts at a user action, so the fixture needs a frontend for the
  // "reaches the collection" assertion to have anything to walk.
  writeFileSync(
    join(project, 'src', 'Customers.jsx'),
    `import axios from 'axios';
     export function Customers() {
       const loadCustomers = () => axios.get('/vendor/customers');
       return <button onClick={loadCustomers}>Load Customers</button>;
     }`,
    'utf8',
  );

  const result = scan({ root: project, apiPrefixes: [] });
  const collections = result.graph.nodesOfKind('collection').map((n) => n.label);

  it('finds models injected as decorated class properties', () => {
    expect(collections).toContain('vendorproducts');
  });

  it('still finds models injected through the constructor', () => {
    expect(collections).toContain('vendors');
  });

  it('carries the property-injected query into the flow, not just the graph', () => {
    const flow = resolveFlows(result.graph, { includeLocalOnly: true }).find(
      (f) => f.label === 'Load Customers',
    );
    // The endpoint's flow has to reach the collection, which is the thing a
    // graph-only assertion would not catch.
    expect(flow?.collections.map((c) => c.collection)).toContain('vendorproducts');
  });

  it('records the aggregate as a read', () => {
    const op = result.graph
      .nodesOfKind('db-op')
      .find((n) => n.label === 'vendorproducts.aggregate');
    expect(op?.meta?.['access']).toBe('read');
  });

  rmSync(project, { recursive: true, force: true });
});

/**
 * The point of the data layer is answering "where did this come from, and what
 * happened to it". A flow that reports `customers: write` has not answered that:
 * inserting a customer, editing one and deleting one are different facts.
 */
describe('collection effects in a flow', () => {
  const project = mkdtempSync(join(tmpdir(), 'flowlens-effects-'));

  mkdirSync(join(project, 'src'), { recursive: true });
  writeFileSync(
    join(project, 'src', 'Admin.jsx'),
    `import axios from 'axios';
     export function Admin() {
       const purge = () => axios.post('/admin/purge');
       return <button onClick={purge}>Purge</button>;
     }`,
    'utf8',
  );
  writeFileSync(
    join(project, 'src', 'admin.controller.ts'),
    `import { Controller, Post } from '@nestjs/common';
     import { AdminService } from './admin.service';
     @Controller('admin')
     export class AdminController {
       constructor(private readonly adminService: AdminService) {}
       @Post('purge')
       purge() { return this.adminService.purge(); }
     }`,
    'utf8',
  );
  writeFileSync(
    join(project, 'src', 'admin.service.ts'),
    `import { Injectable } from '@nestjs/common';
     import { InjectModel } from '@nestjs/mongoose';
     import { Model } from 'mongoose';
     @Injectable()
     export class AdminService {
       constructor(
         @InjectModel(Customer.name) private customerModel: Model<CustomerDocument>,
         @InjectModel(AuditLog.name) private auditLogModel: Model<AuditLogDocument>,
         @InjectModel(Session.name) private sessionModel: Model<SessionDocument>,
       ) {}
       async purge() {
         const stale = await this.customerModel.find({ stale: true });
         await this.customerModel.updateMany({ stale: true }, { archived: true });
         await this.sessionModel.deleteMany({ stale: true });
         await this.auditLogModel.create({ action: 'purge' });
         return stale.length;
       }
     }`,
    'utf8',
  );

  const result = scan({ root: project, apiPrefixes: [] });
  const flow = resolveFlows(result.graph, { includeLocalOnly: true }).find(
    (candidate) => candidate.label === 'Purge',
  );
  const byEffect = (effect: string) =>
    (flow?.collections ?? []).filter((c) => c.effect === effect).map((c) => c.collection);

  it('says which collection the data came from', () => {
    expect(byEffect('read')).toEqual(['customers']);
  });

  it('separates the insert, the update and the delete', () => {
    expect(byEffect('create')).toEqual(['auditlogs']);
    expect(byEffect('update')).toEqual(['customers']);
    expect(byEffect('delete')).toEqual(['sessions']);
  });

  it('reports one collection twice when an action both reads and writes it', () => {
    // `customers` is read and updated; collapsing that to a single row would
    // lose the read, which is where the data on screen came from.
    const customers = (flow?.collections ?? []).filter((c) => c.collection === 'customers');
    expect(customers.map((c) => c.effect).sort()).toEqual(['read', 'update']);
  });

  it('keeps access agreeing with effect for older consumers', () => {
    for (const entry of flow?.collections ?? []) {
      expect(entry.access).toBe(entry.effect === 'read' ? 'read' : 'write');
    }
  });

  it('lists reads before mutations', () => {
    // Reads first is what makes the panel readable top to bottom.
    expect(flow?.collections[0]?.effect).toBe('read');
  });

  rmSync(project, { recursive: true, force: true });
});
