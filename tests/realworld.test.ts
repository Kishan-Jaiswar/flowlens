import { describe, expect, it } from 'vitest';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  collectConstants,
  humanizeHandler,
  isConcreteEndpoint,
  joinRoutePath,
  loadProject,
  normalizePath,
  pluralize,
  resolveFlows,
  scan,
} from '@flowlens/core';

const here = dirname(fileURLToPath(import.meta.url));

/**
 * A fixture in the shape of a real production codebase, rather than a tidy
 * textbook one:
 *
 *   - plain `.js` files with JSX, no TypeScript
 *   - a global `/api` prefix on the backend
 *   - a house-built request wrapper (`getRequest({ url })`)
 *   - endpoint paths kept in a constants module
 *   - URLs built as `` `${baseUrl}${endpoint}` ``
 *   - `onClick` on wrapper divs and icons instead of labelled buttons
 *
 * Every one of these was a reason FlowLens found 12 API calls in a 500-endpoint
 * app, so each has a test here.
 */
const LEGACY_ROOT = resolve(here, 'fixtures', 'legacy-app');

let cached: ReturnType<typeof scan> | undefined;
const legacyScan = () => (cached ??= scan({ root: LEGACY_ROOT }));

describe('global api prefix', () => {
  it('strips the prefix from backend routes as well as frontend calls', () => {
    // @Controller('api/doctor') + @Get('patients') -> /doctor/patients
    expect(joinRoutePath('api/doctor', 'patients', ['/api'])).toBe('/doctor/patients');
  });

  it('leaves routes alone when no prefix is configured', () => {
    expect(joinRoutePath('api/doctor', 'patients', [])).toBe('/api/doctor/patients');
  });

  it('matches a prefixed frontend call to a prefixed backend route', () => {
    const { graph } = legacyScan();
    const call = graph.nodesOfKind('api-call').find((n) => n.label === 'GET /doctor/patients');
    expect(call).toBeDefined();
    expect(graph.successors(call!.id, ['handled-by']).map((n) => n.label)).toEqual([
      'GET /doctor/patients',
    ]);
  });
});

describe('interpolated base urls', () => {
  it('drops a leading interpolation', () => {
    expect(normalizePath('<param>/appointments/monthly')).toBe('/appointments/monthly');
  });

  it('drops it when the endpoint follows immediately', () => {
    expect(normalizePath('<param>appointments/monthly')).toBe('/appointments/monthly');
  });

  it('keeps later interpolations as route parameters', () => {
    expect(normalizePath('<param>/patients/<param>/notes')).toBe('/patients/:param/notes');
  });

  it('only drops the first one', () => {
    expect(normalizePath('<param><param>')).toBe('/:param');
  });

  it('does not touch a path that starts with a literal', () => {
    expect(normalizePath('/patients/<param>')).toBe('/patients/:param');
  });
});

describe('url constants', () => {
  it('collects module-level string constants', () => {
    const table = collectConstants(loadProject({ root: LEGACY_ROOT }));
    expect(table.resolve('getPatientsList')).toBe('/api/doctor/patients');
    expect(table.resolve('createAppointment')).toBe('/api/appointments');
  });

  it('resolves a template constant built from another constant', () => {
    const table = collectConstants(loadProject({ root: LEGACY_ROOT }));
    expect(table.resolve('getPatientById')).toBe('/api/doctor/patients');
  });

  it('refuses to guess when a name is declared twice with different values', () => {
    const table = collectConstants(loadProject({ root: LEGACY_ROOT }));
    expect(table.ambiguous.has('duplicated')).toBe(true);
    expect(table.resolve('duplicated')).toBeUndefined();
  });

  it('can be turned off', () => {
    const withOut = scan({ root: LEGACY_ROOT, resolveConstants: false });
    expect(withOut.stats.apiCalls).toBeLessThan(legacyScan().stats.apiCalls);
  });
});

describe('house-built request wrappers', () => {
  it('reads the verb from the function name and the url from options', () => {
    const { graph } = legacyScan();
    const labels = graph.nodesOfKind('api-call').map((n) => n.label);
    expect(labels).toContain('GET /doctor/patients');
    expect(labels).toContain('POST /appointments');
  });

  it('supports name suffixes like NoLoader and V3', () => {
    const labels = legacyScan()
      .graph.nodesOfKind('api-call')
      .map((n) => n.label);
    expect(labels).toContain('PATCH /doctor/patients/:param');
    expect(labels).toContain('GET /clinic/settings');
  });

  it('appends a params suffix that extends the path', () => {
    // getRequest({ url: getPatientsList, params: `/${id}` }) -> /doctor/patients/:id
    const labels = legacyScan()
      .graph.nodesOfKind('api-call')
      .map((n) => n.label);
    expect(labels).toContain('GET /doctor/patients/:param');
  });

  it('ignores a params suffix that is only a query string', () => {
    const labels = legacyScan()
      .graph.nodesOfKind('api-call')
      .map((n) => n.label);
    // getRequest({ url: getStats, params: "?from=x" }) stays /stats
    expect(labels).toContain('GET /stats');
    expect(labels).not.toContain('GET /stats/:param');
  });

  it('does not create a phantom endpoint from the wrapper definition itself', () => {
    /**
     * `axiosConfig.js` contains real `axios.get(`${baseUrl}${url}${params}`)`
     * calls whose URL is a *parameter*. Each one used to add an endpoint like
     * `GET /:param`, which then showed up in `doctor` as a broken call and
     * could match a real `/:id` route.
     */
    const calls = legacyScan().graph.nodesOfKind('api-call');
    const phantom = calls.filter((node) => {
      const segments = String(node.meta?.['path'] ?? '')
        .split('/')
        .filter(Boolean);
      return segments.length === 0 || segments.every((segment) => segment === ':param');
    });
    expect(phantom.map((node) => node.label)).toEqual([]);
  });

  it('keeps a hardcoded root path, which is a real endpoint', () => {
    const request = {
      method: 'GET',
      rawPath: '/',
      path: '/',
      payloadKeys: [],
      payloadSources: {},
      client: 'axios',
    };
    expect(isConcreteEndpoint(request as never)).toBe(true);
  });

  it('rejects a path that is only interpolation', () => {
    const request = {
      method: 'GET',
      rawPath: '<param><param>',
      path: '/:param',
      payloadKeys: [],
      payloadSources: {},
      client: 'axios',
    };
    expect(isConcreteEndpoint(request as never)).toBe(false);
  });

  it('fails fast on an invalid request-function pattern', () => {
    // Otherwise every file fails inside its own try/catch and the scan reports
    // zero API calls, which reads as "unsupported project".
    expect(() => scan({ root: LEGACY_ROOT, requestFunctionPattern: '^(get|post' })).toThrow(
      /not a valid regular expression/,
    );
  });

  it('does not mistake ordinary functions for HTTP calls', () => {
    // getState() and deleteRow() must not become GET/DELETE requests.
    const labels = legacyScan()
      .graph.nodesOfKind('api-call')
      .map((n) => n.label);
    expect(labels.some((label) => label.includes('/state'))).toBe(false);
    expect(labels.some((label) => label.includes('/row'))).toBe(false);
  });
});

describe('action labels in real markup', () => {
  it('humanizes a handler name', () => {
    expect(humanizeHandler('handleDownloadReport')).toBe('Download Report');
    expect(humanizeHandler('onSaveRx')).toBe('Save Rx');
    expect(humanizeHandler('handleClick')).toBeUndefined();
  });

  it('labels an icon click from its handler instead of the tag name', () => {
    const labels = resolveFlows(legacyScan().graph, { includeLocalOnly: true }).map((f) => f.label);
    expect(labels).toContain('Download Report');
    expect(labels).not.toContain('IoDownload onClick');
  });

  it('labels a wrapper div from the text inside it', () => {
    const labels = resolveFlows(legacyScan().graph, { includeLocalOnly: true }).map((f) => f.label);
    expect(labels).toContain('Preview');
  });
});

describe('plain JavaScript frontends', () => {
  it('parses JSX inside .js files', () => {
    const { stats } = legacyScan();
    expect(stats.components).toBeGreaterThanOrEqual(1);
    expect(stats.uiActions).toBeGreaterThanOrEqual(5);
    expect(stats.handlers).toBeGreaterThanOrEqual(6);
  });

  it('reaches the database through a wrapper call', () => {
    const flow = resolveFlows(legacyScan().graph).find((f) =>
      f.endpoints.includes('POST /appointments'),
    );
    expect(flow?.collections.map((c) => c.collection)).toContain('appointments');
  });
});

describe('mongoose collection naming', () => {
  it('leaves an already-plural model name alone', () => {
    // `class ClinicSettings` -> clinicsettings, NOT clinicsettingses
    expect(pluralize('clinicsettings')).toBe('clinicsettings');
    expect(pluralize('settings')).toBe('settings');
  });

  it('still adds es after a double s', () => {
    expect(pluralize('address')).toBe('addresses');
    expect(pluralize('class')).toBe('classes');
  });

  it('honours an explicit collection option', () => {
    const collections = legacyScan()
      .graph.nodesOfKind('collection')
      .map((n) => n.label);
    expect(collections).toContain('pharma_stock_maps');
  });
});

describe('multi-root scanning', () => {
  it('scans sibling repositories into one graph and joins them', () => {
    const result = scan({
      root: resolve(LEGACY_ROOT, 'web'),
      extraRoots: [resolve(LEGACY_ROOT, 'server')],
    });
    expect(result.seam.matched).toBeGreaterThan(0);
    expect(resolveFlows(result.graph).length).toBeGreaterThan(0);
  });

  it('labels files by their root so ids stay unique', () => {
    const result = scan({
      root: resolve(LEGACY_ROOT, 'web'),
      extraRoots: [resolve(LEGACY_ROOT, 'server')],
    });
    const files = result.graph
      .allNodes()
      .map((node) => node.source?.file)
      .filter((file): file is string => Boolean(file));
    expect(files.some((file) => file.startsWith('web/'))).toBe(true);
    expect(files.some((file) => file.startsWith('server/'))).toBe(true);
  });
});
