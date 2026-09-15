import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  analyzeFlowImpact,
  flowTiming,
  indexTests,
  mergeRuntimeTrace,
  resolveFlows,
  scan,
  testsForFlow,
  type TraceEvent,
} from '@flowslens/core';
import { EXAMPLE_ROOT, exampleScan } from './helpers.js';

/**
 * The three questions the dashboard's tabs ask of one feature: where the time
 * went, what a change would break, and what would catch it.
 */
const scanned = exampleScan();
const flows = resolveFlows(scanned.graph, { includeLocalOnly: true });
const deleteFlow = flows.find((flow) => flow.id === 'customerspage-delete')!;

describe('flowTiming', () => {
  it('says plainly that nothing was measured, instead of estimating', () => {
    const timing = flowTiming(deleteFlow);
    expect(timing.observed).toBe(false);
    expect(timing.steps).toEqual([]);
    expect(timing.totalMs).toBeUndefined();
    expect(timing.notes[0]).toMatch(/No runtime spans/);
  });

  it('reads real spans, ranks steps by their own time, and shares add to ~100', () => {
    // A fresh graph: merging spans mutates evidence, and the shared example
    // scan is used by every other test in the suite.
    const own = scan({ root: EXAMPLE_ROOT });
    const route = own.graph
      .nodesOfKind('route')
      .find((node) => node.meta?.['httpMethod'] === 'DELETE');
    expect(route).toBeDefined();

    const t = 1_735_000_000_000;
    const events: TraceEvent[] = [
      {
        v: 1,
        traceId: 'trace-1',
        spanId: 'server',
        kind: 'http-server',
        name: String(route!.label),
        startedAt: t,
        durationMs: 120,
        attrs: {
          httpMethod: route!.meta?.['httpMethod'],
          path: route!.meta?.['path'],
          statusCode: 200,
        },
      },
      {
        v: 1,
        traceId: 'trace-1',
        spanId: 'db',
        parentSpanId: 'server',
        kind: 'db',
        name: 'customers.deleteOne',
        startedAt: t + 10,
        durationMs: 90,
        attrs: { collection: 'customers', operation: 'deleteOne' },
      },
    ];
    const merged = mergeRuntimeTrace(own.graph, events);
    expect(merged.matched).toBeGreaterThan(0);

    const flow = resolveFlows(own.graph, { includeLocalOnly: true }).find(
      (candidate) => candidate.id === 'customerspage-delete',
    )!;
    const timing = flowTiming(flow);

    expect(timing.observed).toBe(true);
    expect(timing.totalMs).toBeGreaterThan(0);
    expect(timing.steps.length).toBeGreaterThan(0);
    // Sorted by own time, so the first row is the one to look at.
    const selfTimes = timing.steps.map((step) => step.avgSelfMs ?? 0);
    expect([...selfTimes].sort((a, b) => b - a)).toEqual(selfTimes);
    expect(timing.slowest?.nodeId).toBe(timing.steps[0]?.nodeId);

    const shares = timing.steps
      .map((step) => step.sharePct ?? 0)
      .reduce((sum, share) => sum + share, 0);
    expect(shares).toBeGreaterThan(95);
    expect(shares).toBeLessThan(105);
  });

  it('never sums inclusive times into the total', () => {
    const own = scan({ root: EXAMPLE_ROOT });
    const t = 1_735_000_000_000;
    const route = own.graph.nodesOfKind('route')[0]!;
    mergeRuntimeTrace(own.graph, [
      {
        v: 1,
        traceId: 'x',
        spanId: 's',
        kind: 'http-server',
        name: String(route.label),
        startedAt: t,
        durationMs: 100,
        attrs: { httpMethod: route.meta?.['httpMethod'], path: route.meta?.['path'] },
      },
    ]);
    const flow = resolveFlows(own.graph, { includeLocalOnly: true }).find((candidate) =>
      candidate.steps.some((step) => step.avgMs !== undefined),
    );
    if (!flow) return;
    const timing = flowTiming(flow);
    // The widest single measurement, not the sum of nested ones.
    expect(timing.totalMs).toBeLessThanOrEqual(100);
  });
});

describe('analyzeFlowImpact', () => {
  const impact = analyzeFlowImpact(scanned.graph, deleteFlow);

  it('separates steps other features share from steps only this one uses', () => {
    expect(impact.shared.length).toBeGreaterThan(0);
    expect(impact.exclusive.length).toBeGreaterThan(0);
    // A step cannot be both.
    const sharedIds = new Set(impact.shared.map((step) => step.nodeId));
    expect(impact.exclusive.every((step) => !sharedIds.has(step.nodeId))).toBe(true);
  });

  it('never lists the feature being inspected as a feature at risk', () => {
    expect(impact.featuresAtRisk.some((feature) => feature.id === deleteFlow.id)).toBe(false);
    for (const step of impact.shared) {
      expect(step.otherFlows.some((other) => other.id === deleteFlow.id)).toBe(false);
    }
  });

  it('ranks the most-shared step first', () => {
    const counts = impact.shared.map((step) => step.otherFlows.length);
    expect([...counts].sort((a, b) => b - a)).toEqual(counts);
  });

  it('counts how many steps each at-risk feature shares', () => {
    expect(impact.featuresAtRisk.length).toBeGreaterThan(0);
    for (const feature of impact.featuresAtRisk) {
      expect(feature.viaSteps).toBeGreaterThan(0);
      expect(feature.title).toBeTruthy();
    }
  });

  it('names a collection several methods write, with its writers', () => {
    const customers = impact.contestedCollections.find((entry) => entry.collection === 'customers');
    expect(customers).toBeDefined();
    expect(customers!.writers.length).toBeGreaterThan(1);
    // Writers are the methods a developer can open, not anonymous call sites.
    expect(customers!.writers.every((writer) => writer.includes('.'))).toBe(true);
  });

  it('gives a summary sentence that matches the numbers', () => {
    expect(impact.summary).toContain(String(impact.shared.length));
    expect(impact.level).toBe('medium');
  });

  it('calls a self-contained feature contained', () => {
    /**
     * "Contained" needs both halves. A feature can share no business logic and
     * still write a collection several other places write, which is a real
     * reason to be careful and keeps it off `low`.
     */
    const lonely = flows.find((flow) => {
      const candidate = analyzeFlowImpact(scanned.graph, flow);
      return candidate.shared.length === 0 && candidate.contestedCollections.length === 0;
    });
    if (!lonely) return;
    const report = analyzeFlowImpact(scanned.graph, lonely);
    expect(report.level).toBe('low');
    expect(report.summary).toMatch(/contained/);
    expect(report.factors.join(' ')).toMatch(/nothing outside this feature/);
  });
});

describe('test coverage', () => {
  const project = mkdtempSync(join(tmpdir(), 'flowlens-tests-'));

  mkdirSync(join(project, 'src'), { recursive: true });
  mkdirSync(join(project, 'src', '__tests__'), { recursive: true });

  writeFileSync(
    join(project, 'src', 'OrderForm.tsx'),
    `import React from 'react';
     import axios from 'axios';
     export function OrderForm() {
       const submit = async () => { await axios.post('/api/orders', {}); };
       return <button onClick={submit}>Submit Order</button>;
     }`,
    'utf8',
  );
  writeFileSync(
    join(project, 'src', 'orders.js'),
    `const express = require('express');
     const mongoose = require('mongoose');
     const Order = mongoose.model('Order', new mongoose.Schema({ total: Number }));
     const router = express.Router();
     router.post('/orders', async (req, res) => { res.json(await Order.create(req.body)); });
     module.exports = router;`,
    'utf8',
  );

  writeFileSync(
    join(project, 'src', '__tests__', 'OrderForm.test.tsx'),
    `import { describe, it, expect } from 'vitest';
     import { OrderForm } from '../OrderForm';

     describe('OrderForm', () => {
       it('submits the order', () => { expect(true).toBe(true); });
       it('disables the button while saving', () => { expect(true).toBe(true); });
     });`,
    'utf8',
  );
  // An unrelated test, which must not be credited to this flow.
  writeFileSync(
    join(project, 'src', '__tests__', 'unrelated.test.ts'),
    `import { describe, it } from 'vitest';
     import { helper } from '../nowhere';
     describe('something else', () => { it('does not matter here', () => {}); });`,
    'utf8',
  );

  const index = indexTests([project]);

  it('finds test files and reads their case titles', () => {
    const form = index.files.find((file) => file.file.endsWith('OrderForm.test.tsx'));
    expect(form).toBeDefined();
    expect(form!.cases.map((testCase) => testCase.title)).toEqual([
      'submits the order',
      'disables the button while saving',
    ]);
    expect(form!.cases[0]?.suite).toBe('OrderForm');
  });

  it('resolves a relative import to the file it actually covers', () => {
    const form = index.files.find((file) => file.file.endsWith('OrderForm.test.tsx'))!;
    expect(form.covers).toContain('src/OrderForm.tsx');
  });

  it('ignores an import that resolves to nothing', () => {
    const unrelated = index.files.find((file) => file.file.endsWith('unrelated.test.ts'))!;
    expect(unrelated.covers).toEqual([]);
  });

  it('reports which of a flow"s files are covered and which are not', () => {
    const result = scan({ root: project });
    const flow = resolveFlows(result.graph, { includeLocalOnly: true })[0];
    expect(flow).toBeDefined();

    const tests = testsForFlow(index, flow!);
    expect(tests.files.length).toBe(1);
    expect(tests.files[0]?.file).toMatch(/OrderForm\.test\.tsx$/);
    expect(tests.totalCases).toBe(2);
    expect(tests.coveragePct).toBeGreaterThan(0);
    // The Express side has no test importing it.
    expect(tests.uncoveredFiles.some((entry) => entry.file === 'src/orders.js')).toBe(true);
    expect(tests.notes.some((note) => note.includes('files this flow runs through'))).toBe(true);
  });

  it('says so plainly when a feature has no tests at all', () => {
    const tests = testsForFlow({ files: [], byCoveredFile: new Map(), totalCases: 0 }, deleteFlow);
    expect(tests.files).toEqual([]);
    expect(tests.coveragePct).toBe(0);
    expect(tests.notes.join(' ')).toMatch(/No test files found/);
  });

  it('finds its own suite when pointed at this repository', () => {
    const own = indexTests([process.cwd()]);
    expect(own.files.length).toBeGreaterThanOrEqual(19);
    expect(own.totalCases).toBeGreaterThan(300);
  });
});
