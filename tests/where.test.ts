import { describe, expect, it } from 'vitest';
import {
  FlowGraph,
  isWhereFailure,
  parseLocation,
  resolveGraphFile,
  whereIs,
} from '@flowlens/core';
import { splitPositionals } from '../packages/cli/src/args.js';
import { exampleScan } from './helpers.js';

/**
 * `flowlens where <file>:<line>` — the reverse lookup.
 *
 * `flow <id>` goes forward from a click; this starts at a cursor position and
 * finds the features that run through it. The interesting cases are all about
 * the mismatch between where a developer's cursor is and where a graph node is.
 */

const graph = () => exampleScan().graph;
const ok = (location: string) => {
  const report = whereIs(graph(), location);
  if (isWhereFailure(report)) throw new Error(`unexpected failure: ${report.reason}`);
  return report;
};

describe('parsing a location', () => {
  it('reads file, line and column', () => {
    expect(parseLocation('src/App.tsx')).toEqual({ file: 'src/App.tsx' });
    expect(parseLocation('src/App.tsx:42')).toEqual({ file: 'src/App.tsx', line: 42 });
    expect(parseLocation('src/App.tsx:42:7')).toEqual({
      file: 'src/App.tsx',
      line: 42,
      column: 7,
    });
  });

  it('leaves a Windows drive letter alone', () => {
    // The colon in `C:` must not be read as a line separator.
    expect(parseLocation('C:\\app\\src\\App.tsx')).toEqual({ file: 'C:\\app\\src\\App.tsx' });
    expect(parseLocation('C:\\app\\src\\App.tsx:42')).toEqual({
      file: 'C:\\app\\src\\App.tsx',
      line: 42,
    });
  });
});

describe('finding the file the user meant', () => {
  it('accepts the path exactly as the graph stores it', () => {
    expect(resolveGraphFile(graph(), 'web/src/components/OrderForm.tsx').file).toBe(
      'web/src/components/OrderForm.tsx',
    );
  });

  it('accepts a Windows spelling of the same path', () => {
    expect(resolveGraphFile(graph(), 'web\\src\\components\\OrderForm.tsx').file).toBe(
      'web/src/components/OrderForm.tsx',
    );
  });

  it('accepts a bare basename when it is unambiguous', () => {
    expect(resolveGraphFile(graph(), 'OrderForm.tsx').file).toBe(
      'web/src/components/OrderForm.tsx',
    );
  });

  it('refuses to guess between two files with the same name', () => {
    // Every App Router project has a dozen `route.ts`; picking one silently
    // would answer a question the developer did not ask.
    const fake = new FlowGraph();
    for (const dir of ['a', 'b']) {
      fake.addNode({
        id: `component:${dir}/Card.tsx#Card`,
        kind: 'component',
        label: 'Card',
        source: { file: `${dir}/Card.tsx`, line: 1 },
      });
    }
    const resolved = resolveGraphFile(fake, 'Card.tsx');
    expect(resolved.file).toBeUndefined();
    expect(resolved.candidates).toEqual(['a/Card.tsx', 'b/Card.tsx']);
  });

  it('reports an unknown file rather than an empty answer', () => {
    const report = whereIs(graph(), 'web/src/nope.tsx:1');
    expect(isWhereFailure(report) && report.reason).toBe('unknown-file');
  });
});

describe('what a line lands on', () => {
  it('finds the node declared exactly there', () => {
    const report = ok('web/src/components/OrderForm.tsx:15');
    expect(report.matches.map((match) => match.label)).toEqual(['OrderForm.handleSubmit']);
    expect(report.matches[0]?.offset).toBe(0);
  });

  it('falls back to the nearest declaration above, and says how far', () => {
    // Line 20 is inside handleSubmit's body; no node is declared on it.
    const report = ok('web/src/components/OrderForm.tsx:20');
    expect(report.matches.length).toBeGreaterThan(0);
    expect(report.matches[0]?.offset).toBeGreaterThan(0);
    expect(report.matches[0]?.line).toBeLessThan(20);
  });

  it('looks downwards when the line is above everything in the file', () => {
    const report = ok('web/src/components/OrderForm.tsx:1');
    expect(report.matches[0]?.offset).toBeLessThan(0);
  });

  it('returns every node in the file when no line is given', () => {
    const report = ok('api/src/customers/customers.service.ts');
    expect(report.line).toBeUndefined();
    expect(report.matches).toEqual(report.fileNodes);
    expect(report.matches.length).toBeGreaterThan(5);
  });
});

describe('the features running through a line', () => {
  it('names the feature a handler belongs to', () => {
    const report = ok('web/src/components/OrderForm.tsx:15');
    expect(report.flows.map((flow) => flow.id)).toContain('orderform-submit-order');
    const flow = report.flows.find((candidate) => candidate.id === 'orderform-submit-order')!;
    expect(flow.endpoints).toContain('POST /orders');
    expect(flow.collections).toContain('orders');
    expect(flow.indirect).toBe(false);
  });

  it('works from the backend end of the chain too', () => {
    // The same feature, found from a service method four hops downstream.
    const report = ok('api/src/customers/customers.service.ts:33');
    expect(report.flows.map((flow) => flow.id)).toContain('orderform-submit-order');
  });

  it('reaches a flow one hop out from a useState field', () => {
    // A `state` node hangs off the execution path rather than sitting on it, so
    // a reachability walk never lands on it. It is found through its handler.
    const report = ok('web/src/components/OrderForm.tsx:11');
    expect(report.matches[0]?.kind).toBe('state');
    expect(report.flows.length).toBeGreaterThan(0);
    expect(report.flows.every((flow) => flow.indirect)).toBe(true);
  });

  it('lists each collection once, however many effects the flow has', () => {
    const report = ok('api/src/customers/customers.service.ts');
    for (const flow of report.flows) {
      expect(flow.collections).toEqual([...new Set(flow.collections)]);
    }
  });

  it('separates features elsewhere in the file from features on this line', () => {
    const report = ok('web/src/components/OrderForm.tsx:15');
    const here = report.flows.map((flow) => flow.id);
    const elsewhere = report.otherFlowsInFile.map((flow) => flow.id);
    expect(elsewhere.length).toBeGreaterThan(0);
    expect(elsewhere.some((id) => here.includes(id))).toBe(false);
    // Print Order lives in the same component but on a different line.
    expect(elsewhere).toContain('orderform-print-order');
  });

  it('orders features by risk, so the dangerous one is first', () => {
    const report = ok('web/src/components/OrderForm.tsx:11');
    const risks = report.flows.map((flow) => flow.risk);
    expect(risks).toEqual([...risks].sort((a, b) => b - a));
  });
});

describe('the where command line', () => {
  it('treats the first positional as a location, not a project root', () => {
    // `src/App.tsx:42` looks exactly like a path, so position has to decide.
    const split = splitPositionals('where', ['src/App.tsx:42', 'my-app']);
    expect(split.args).toEqual(['src/App.tsx:42']);
    expect(split.roots).toEqual(['my-app']);
  });

  it('leaves the other commands unchanged', () => {
    // `impact` still decides by shape: `./my-app` looks like a path, so it is a
    // root, while a bare name that is not on disk stays an argument.
    expect(splitPositionals('impact', ['Service.create', './my-app'])).toEqual({
      args: ['Service.create'],
      roots: ['./my-app'],
    });
    expect(splitPositionals('scan', ['my-app'])).toEqual({ args: [], roots: ['my-app'] });
  });

  it('takes a location even when a root follows that is not on disk', () => {
    // `where` decides by position, so an unscanned project name still lands in
    // roots and fails with "no graph" instead of eating the location.
    expect(splitPositionals('where', ['src/App.tsx:42', 'not-on-disk'])).toEqual({
      args: ['src/App.tsx:42'],
      roots: ['not-on-disk'],
    });
  });
});
