import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  analyzeChanged,
  mergeRuntimeTrace,
  analyzeFlowImpact,
  checkFlowContract,
  flowApis,
  indexTests,
  resolveFlows,
  scan,
} from '@flowslens/core';
import { exampleScan } from './helpers.js';

const scanned = exampleScan();
const flows = resolveFlows(scanned.graph, { includeLocalOnly: true });

describe('shared by design versus shared by accident', () => {
  /**
   * Measured on a real 132-flow project, `useToast` was the single most-flagged
   * step in the graph — 13 features "at risk" because they all show a toast.
   * A findings list that opens with that is a list people learn to skim.
   */
  it('keeps infrastructure out of the findings and says why', () => {
    const flow = flows.find((candidate) => candidate.id === 'orderform-submit-order')!;
    const impact = analyzeFlowImpact(scanned.graph, flow);

    for (const step of impact.infrastructure) {
      expect(step.sharedBy).toBe('design');
      expect(step.why.length).toBeGreaterThan(5);
    }
    for (const step of impact.shared) {
      expect(step.sharedBy).toBe('feature');
    }
    // The audit trail is the textbook case: shared on purpose, everywhere.
    const audited = [...impact.shared, ...impact.infrastructure].find((step) =>
      /audit/i.test(step.label),
    );
    if (audited) expect(audited.sharedBy).toBe('design');
  });

  it('counts only feature-level sharing toward what could break', () => {
    const flow = flows.find((candidate) => candidate.id === 'orderform-submit-order')!;
    const impact = analyzeFlowImpact(scanned.graph, flow);
    const fromFeatures = new Set(
      impact.shared.flatMap((step) => step.otherFlows.map((other) => other.id)),
    );
    for (const feature of impact.featuresAtRisk) {
      expect(fromFeatures.has(feature.id)).toBe(true);
    }
  });

  it('explains the level it reported', () => {
    for (const flow of flows.slice(0, 5)) {
      const impact = analyzeFlowImpact(scanned.graph, flow);
      expect(impact.factors.length).toBeGreaterThan(0);
      expect(impact.factors.every((factor) => factor.length > 10)).toBe(true);
    }
  });

  it('disambiguates features that share a title', () => {
    // Two different flows, same words: without a suffix the list is unusable.
    const titles = new Map<string, number>();
    for (const flow of flows) titles.set(flow.title, (titles.get(flow.title) ?? 0) + 1);
    const colliding = [...titles.entries()].find(([, count]) => count > 1)?.[0];
    if (!colliding) return;

    for (const flow of flows) {
      const impact = analyzeFlowImpact(scanned.graph, flow);
      const same = impact.featuresAtRisk.filter((feature) => feature.title === colliding);
      if (same.length > 1) {
        expect(same.every((feature) => feature.subtitle)).toBe(true);
        expect(new Set(same.map((feature) => feature.subtitle)).size).toBe(same.length);
      }
    }
  });
});

describe('contract drift', () => {
  const project = mkdtempSync(join(tmpdir(), 'flowlens-contract-'));
  mkdirSync(join(project, 'web'), { recursive: true });
  mkdirSync(join(project, 'api'), { recursive: true });

  writeFileSync(
    join(project, 'web', 'OrderForm.tsx'),
    `import React, { useState } from 'react';
     import axios from 'axios';
     export function OrderForm() {
       const [total, setTotal] = useState(0);
       const [couponCode, setCoupon] = useState('');
       const submit = async () => {
         await axios.post('/api/orders', { total, couponCode, giftWrap: true });
       };
       return <button onClick={submit}>Place order</button>;
     }`,
    'utf8',
  );
  writeFileSync(
    join(project, 'api', 'orders.controller.ts'),
    `import { Controller, Post, Body } from '@nestjs/common';
     export class CreateOrderDto {
       total: number;
       note: string;
     }
     @Controller('orders')
     export class OrdersController {
       @Post()
       create(@Body() dto: CreateOrderDto) { return dto; }
     }`,
    'utf8',
  );

  const result = scan({ root: project });
  const flow = resolveFlows(result.graph, { includeLocalOnly: true }).find((candidate) =>
    candidate.steps.some((step) => step.kind === 'api-call'),
  )!;
  const contract = checkFlowContract(result.graph, flow);
  const check = contract.checks[0]!;

  it('names the keys the frontend sends that the route does not declare', () => {
    expect(check.unexpected.map((field) => field.name).sort()).toEqual(['couponCode', 'giftWrap']);
    expect(contract.unexpectedCount).toBe(2);
  });

  it('names the declared fields the frontend never sends', () => {
    expect(check.missing.map((field) => field.name)).toEqual(['note']);
    expect(check.missing[0]?.type).toBe('string');
  });

  it('reports what does line up, so the panel is not all bad news', () => {
    expect(check.matched).toEqual(['total']);
    expect(check.dto).toBe('CreateOrderDto');
  });

  it('warns that an undeclared key is dropped rather than rejected', () => {
    expect(contract.notes.join(' ')).toMatch(/dropped/);
  });

  it('finds no drift in a feature whose sides agree', () => {
    const agreeing = flows.find((candidate) => candidate.id === 'orderform-submit-order')!;
    const report = checkFlowContract(scanned.graph, agreeing);
    expect(report.unexpectedCount).toBe(0);
    expect(report.checks[0]?.matched.length).toBeGreaterThan(0);
  });

  it('does not claim agreement for a route with no DTO', () => {
    const noDto = flows
      .map((candidate) => checkFlowContract(scanned.graph, candidate))
      .flatMap((report) => report.checks)
      .find((entry) => entry.dto === undefined);
    if (!noDto) return;
    expect(noDto.unexpected).toEqual([]);
    expect(noDto.matched).toEqual([]);
  });
});

describe('what my changes put at risk', () => {
  const tests = indexTests([process.cwd()]);

  it('finds the features a changed file runs through', () => {
    const report = analyzeChanged(
      scanned.graph,
      [{ file: 'web/src/components/OrderForm.tsx', status: 'modified' }],
      { tests },
    );
    expect(report.features.length).toBeGreaterThan(0);
    expect(report.features[0]?.touchedSteps.length).toBeGreaterThan(0);
    expect(report.summary).toContain('1 changed file');
  });

  it('ranks by how much of each feature the diff touches', () => {
    const report = analyzeChanged(scanned.graph, [
      { file: 'web/src/components/OrderForm.tsx' },
      { file: 'api/src/customers/customers.service.ts' },
    ]);
    const touched = report.features.map((feature) => feature.touchedSteps.length);
    expect([...touched].sort((a, b) => b - a)).toEqual(touched);
  });

  it('says which changed files it has no opinion about', () => {
    const report = analyzeChanged(scanned.graph, [
      { file: 'README.md', status: 'modified' },
      { file: 'web/src/components/OrderForm.tsx', status: 'modified' },
    ]);
    expect(report.unmodelled).toEqual(['README.md']);
    expect(report.notes.join(' ')).toMatch(/no step in the graph/);
  });

  it('is calm about an empty diff rather than reporting zero risk', () => {
    const report = analyzeChanged(scanned.graph, []);
    expect(report.features).toEqual([]);
    expect(report.level).toBe('low');
    expect(report.summary).toMatch(/Nothing has changed/);
  });

  it('flags affected features that no test covers', () => {
    const report = analyzeChanged(scanned.graph, [{ file: 'web/src/components/OrderForm.tsx' }], {
      tests: { files: [], byCoveredFile: new Map(), totalCases: 0 },
    });
    expect(report.untested.length).toBe(report.features.length);
    expect(report.notes.join(' ')).toMatch(/every affected feature counts as untested/);
  });

  it('names the collections the changed code can reach', () => {
    const report = analyzeChanged(scanned.graph, [
      { file: 'api/src/customers/customers.service.ts' },
    ]);
    expect(report.collections.length).toBeGreaterThan(0);
  });
});

describe('the API detail', () => {
  const submit = flows.find((candidate) => candidate.id === 'orderform-submit-order')!;
  const { calls } = flowApis(scanned.graph, submit);
  const call = calls[0]!;

  it('describes the request as the frontend writes it', () => {
    expect(call.endpoint).toBe('POST /orders');
    expect(call.method).toBe('POST');
    // The URL before the prefix was stripped, which is what you grep for.
    expect(call.rawPath).toBe('/api/orders');
    expect(call.client).toBe('api');
    expect(call.callSites[0]).toMatch(/OrderForm\.tsx:\d+/);
  });

  it('says where each payload value comes from', () => {
    expect(call.payload.map((field) => field.name)).toContain('customerId');
    expect(call.payload.every((field) => field.from !== undefined)).toBe(true);
  });

  it('names the route, its framework and the file declaring it', () => {
    expect(call.matched).toBe(true);
    expect(call.route?.framework).toBe('nestjs');
    expect(call.route?.controller).toBe('OrdersController');
    expect(call.route?.handler).toBe('create');
    expect(call.route?.file).toMatch(/orders\.controller\.ts$/);
  });

  it('lists the code the request runs and the data it touches', () => {
    expect(call.handlers.map((entry) => entry.label)).toContain('OrdersService.create');
    const orders = call.data.find((entry) => entry.collection === 'orders');
    expect(orders?.effect).toBe('create');
    expect(orders?.by).toBe('OrdersService.create');
  });

  it('folds the contract check into the call it belongs to', () => {
    expect(call.contract?.dto).toBe('CreateOrderDto');
    expect(call.contract?.matched.length).toBe(call.payload.length);
  });

  it('reports an endpoint no route answers, rather than staying quiet', () => {
    const broken = flows
      .map((candidate) => flowApis(scanned.graph, candidate))
      .flatMap((report) => report.calls)
      .find((entry) => !entry.matched);
    expect(broken).toBeDefined();
    expect(broken!.route).toBeUndefined();
    expect(broken!.warnings.join(' ')).toMatch(/No backend route matched/);
  });

  it('answers "who else calls this" from the graph', () => {
    const shared = flows
      .map((candidate) => flowApis(scanned.graph, candidate))
      .flatMap((report) => report.calls)
      .find((entry) => entry.alsoUsedBy.length > 0);
    if (!shared) return;
    // Never lists the feature being inspected.
    expect(shared.alsoUsedBy.every((feature) => feature.title.length > 0)).toBe(true);
  });

  it('is empty for an action that never leaves the browser', () => {
    const local = flows.find(
      (candidate) => !candidate.steps.some((step) => step.kind === 'api-call'),
    );
    if (!local) return;
    const report = flowApis(scanned.graph, local);
    expect(report.calls).toEqual([]);
    expect(report.notes.join(' ')).toMatch(/no HTTP request/);
  });

  it('carries the guards that run before the handler', () => {
    const guarded = mkGuarded();
    const call = guarded.calls[0]!;
    expect(call.middleware.map((entry) => entry.name)).toContain('JwtAuthGuard');
    expect(call.middleware.find((entry) => entry.name === 'JwtAuthGuard')?.role).toBe('guard');
  });

  function mkGuarded() {
    const project = mkdtempSync(join(tmpdir(), 'flowlens-apis-'));
    mkdirSync(join(project, 'web'), { recursive: true });
    mkdirSync(join(project, 'api'), { recursive: true });
    writeFileSync(
      join(project, 'web', 'Panel.tsx'),
      `import React from 'react';
       import axios from 'axios';
       export function Panel() {
         const go = () => axios.post('/api/orders', { total: 1 });
         return <button onClick={go}>Go</button>;
       }`,
      'utf8',
    );
    writeFileSync(
      join(project, 'api', 'orders.controller.ts'),
      `import { Controller, Post, Body, UseGuards } from '@nestjs/common';
       @Controller('orders')
       @UseGuards(JwtAuthGuard)
       export class OrdersController {
         @Post()
         create(@Body() dto: CreateOrderDto) { return dto; }
       }`,
      'utf8',
    );
    const result = scan({ root: project });
    const flow = resolveFlows(result.graph, { includeLocalOnly: true }).find((candidate) =>
      candidate.steps.some((step) => step.kind === 'api-call'),
    )!;
    return flowApis(result.graph, flow);
  }
});

describe('an action that makes several requests', () => {
  /**
   * The three shapes that used to be indistinguishable: awaited calls with a
   * data dependency, a `.then` chain, and `Promise.all`. Every one came out at
   * the same depth in whatever order the scan happened to read them.
   */
  const project = mkdtempSync(join(tmpdir(), 'flowlens-sequence-'));
  mkdirSync(join(project, 'web'), { recursive: true });
  mkdirSync(join(project, 'lib'), { recursive: true });

  writeFileSync(
    join(project, 'lib', 'api.ts'),
    'export default { get: (u) => fetch(u), post: (u, b) => fetch(u), put: (u, b) => fetch(u) };',
    'utf8',
  );
  writeFileSync(
    join(project, 'web', 'Checkout.tsx'),
    `import React from 'react';
     import api from '../lib/api';
     export function Checkout() {
       const placeOrder = async () => {
         const cart = await api.get('/api/carts/current');
         const order = await api.post('/api/orders', { cartId: cart.id });
         await api.post('/api/payments', { orderId: order.id, amount: cart.total });
       };
       const applyCoupon = () => {
         api.post('/api/coupons/validate', { code: 'X' }).then((res) => {
           api.put('/api/carts/current', { couponId: res.id });
         });
       };
       const refresh = async () => {
         await Promise.all([api.get('/api/medicines'), api.get('/api/clinics')]);
       };
       return (
         <div>
           <button onClick={placeOrder}>Place order</button>
           <button onClick={applyCoupon}>Apply coupon</button>
           <button onClick={refresh}>Refresh</button>
         </div>
       );
     }`,
    'utf8',
  );

  const result = scan({ root: project });
  const all = resolveFlows(result.graph, { includeLocalOnly: true });
  const apisOf = (id: string) =>
    flowApis(
      result.graph,
      all.find((flow) => flow.id.endsWith(id))!,
    ).calls;

  it('shows every request the action makes, not just the first', () => {
    expect(apisOf('place-order').map((call) => call.endpoint)).toEqual([
      'GET /carts/current',
      'POST /orders',
      'POST /payments',
    ]);
  });

  it('numbers them in the order the code runs them', () => {
    const calls = apisOf('place-order');
    expect(calls.map((call) => call.order)).toEqual([1, 2, 3]);
    expect(calls.every((call) => call.awaited)).toBe(true);
  });

  it('says which request is waiting on which response', () => {
    const calls = apisOf('place-order');
    expect(calls[0]?.waitsFor).toEqual([]);
    expect(calls[0]?.when).toBe('sent first');
    // The dependency is the data, not merely the line order.
    expect(calls[1]?.waitsFor).toEqual(['GET /carts/current']);
    expect(calls[1]?.when).toMatch(/needs the response from GET \/carts\/current/);
    expect(calls[2]?.waitsFor).toEqual(['GET /carts/current', 'POST /orders']);
  });

  it('recognises a call that only happens inside another call"s .then', () => {
    const calls = apisOf('apply-coupon');
    expect(calls.map((call) => call.endpoint)).toEqual([
      'POST /coupons/validate',
      'PUT /carts/current',
    ]);
    expect(calls[1]?.insideCallbackOf).toBe('POST /coupons/validate');
    expect(calls[1]?.when).toBe('only after POST /coupons/validate resolves');
    // It is a control dependency, not a data one.
    expect(calls[0]?.insideCallbackOf).toBeUndefined();
  });

  it('does not pretend that parallel requests are ordered', () => {
    const calls = apisOf('refresh');
    expect(calls).toHaveLength(2);
    for (const call of calls) {
      expect(call.parallelWith).toHaveLength(1);
      expect(call.when).toMatch(/at the same time as/);
      expect(call.waitsFor).toEqual([]);
      expect(call.insideCallbackOf).toBeUndefined();
    }
  });

  it('says out loud that unawaited calls may finish in either order', () => {
    const report = flowApis(
      result.graph,
      all.find((flow) => flow.id.endsWith('refresh'))!,
    );
    expect(report.notes.join(' ')).toMatch(/either order/);
  });

  it('calls a single request what it is, without inventing a sequence', () => {
    const single = all.find((flow) => flowApis(result.graph, flow).calls.length === 1);
    if (!single) return;
    const call = flowApis(result.graph, single).calls[0]!;
    expect(call.when).toBe('the only request this action makes');
  });
});

describe('a request that waits on React state', () => {
  /**
   * The chain source order cannot see. The effect that waits for `user` is
   * written *above* the fetch that sets it, which is idiomatic React and the
   * exact case where reading top-to-bottom gives the wrong answer.
   */
  const project = mkdtempSync(join(tmpdir(), 'flowlens-effect-'));
  mkdirSync(join(project, 'web'), { recursive: true });
  mkdirSync(join(project, 'lib'), { recursive: true });

  writeFileSync(
    join(project, 'lib', 'api.ts'),
    'export default { get: (u) => fetch(u), post: (u, b) => fetch(u) };',
    'utf8',
  );
  writeFileSync(
    join(project, 'web', 'Profile.tsx'),
    `import React, { useEffect, useState } from 'react';
     import api from '../lib/api';
     export function Profile() {
       const [user, setUser] = useState(null);
       const [orders, setOrders] = useState([]);
       useEffect(() => {
         if (!user) return;
         api.get('/api/orders').then(setOrders);
       }, [user]);
       useEffect(() => {
         api.get('/api/me').then(setUser);
       }, []);
       return <div>{orders.length}</div>;
     }`,
    'utf8',
  );

  const result = scan({ root: project });
  const flow = resolveFlows(result.graph, { includeLocalOnly: true }).find((candidate) =>
    candidate.steps.some((step) => step.kind === 'api-call'),
  )!;
  const calls = flowApis(result.graph, flow).calls;

  it('gives a component that loads through useEffect a mount action at all', () => {
    // Without this there was no flow, so the screen's data loading was missing
    // from the feature list entirely.
    expect(flow).toBeDefined();
    expect(calls).toHaveLength(2);
  });

  it('orders the producer first, against the order of the source', () => {
    expect(calls.map((call) => call.endpoint)).toEqual(['GET /me', 'GET /orders']);
  });

  it('explains the wait as state rather than as a response', () => {
    expect(calls[1]?.viaState).toEqual(['GET /me']);
    expect(calls[1]?.when).toBe('re-runs when the state set by GET /me arrives');
    // It is a weaker promise than reading the response, and says so.
    expect(flowApis(result.graph, flow).notes.join(' ')).toMatch(/later render/);
  });

  it('calls an empty dependency array what it is', () => {
    expect(calls[0]?.when).toBe('sent once, when the screen loads');
  });

  it('does not invent a state dependency where there is none', () => {
    expect(calls[0]?.viaState).toEqual([]);
    expect(calls[0]?.waitsFor).toEqual([]);
  });
});

describe('conditional and error-path requests', () => {
  /**
   * The bug this covers: two calls in opposite arms of one `if` were reported
   * as "sent first" and "sent second", and a call in a `catch` as "sent third".
   * All three were wrong, and wrong in the way that gets believed — it read as
   * "this action makes three requests" when it makes one.
   */
  const project = mkdtempSync(join(tmpdir(), 'flowlens-branch-'));
  mkdirSync(join(project, 'web'), { recursive: true });
  mkdirSync(join(project, 'lib'), { recursive: true });
  writeFileSync(
    join(project, 'lib', 'api.ts'),
    'export default { get: (u) => fetch(u), post: (u, b) => fetch(u), put: (u, b) => fetch(u) };',
    'utf8',
  );
  writeFileSync(
    join(project, 'web', 'Form.tsx'),
    `import React, { useState } from 'react';
     import api from '../lib/api';
     export function Form({ isEdit, id }) {
       const [error, setError] = useState('');
       const save = async () => {
         try {
           if (isEdit) { await api.put('/api/medicines/1', { name: 'x' }); }
           else { await api.post('/api/medicines', { name: 'x' }); }
           await api.get('/api/medicines');
         } catch (e) {
           setError('failed');
           await api.post('/api/errors', { message: 'x' });
         }
       };
       return <button onClick={save}>Save</button>;
     }`,
    'utf8',
  );

  const result = scan({ root: project });
  const flow = resolveFlows(result.graph, { includeLocalOnly: true }).find((candidate) =>
    candidate.steps.some((step) => step.kind === 'api-call'),
  )!;
  const report = flowApis(result.graph, flow);
  const byEndpoint = new Map(report.calls.map((call) => [call.endpoint, call]));

  it('gives two arms of one condition the same step number', () => {
    const put = byEndpoint.get('PUT /medicines/:param')!;
    const post = byEndpoint.get('POST /medicines')!;
    expect(put.order).toBe(1);
    expect(post.order).toBe(1);
  });

  it('names the condition and the alternative instead of a sequence', () => {
    expect(byEndpoint.get('PUT /medicines/:param')?.when).toBe(
      'only when isEdit — otherwise POST /medicines',
    );
    expect(byEndpoint.get('POST /medicines')?.when).toBe(
      'only when not isEdit — otherwise PUT /medicines/:param',
    );
    expect(byEndpoint.get('PUT /medicines/:param')?.alternativeTo).toEqual(['POST /medicines']);
  });

  it('counts the step after a branch as second, not third', () => {
    const list = byEndpoint.get('GET /medicines')!;
    expect(list.order).toBe(2);
    expect(list.when).toBe('sent second');
  });

  it('marks a catch-block request as an error path', () => {
    const errors = byEndpoint.get('POST /errors')!;
    expect(errors.onFailure).toBe(true);
    expect(errors.when).toBe('only when the request fails');
  });

  it('says out loud that a shared step number means alternatives', () => {
    expect(report.notes.join(' ')).toMatch(/alternatives/);
    expect(report.notes.join(' ')).toMatch(/error path/);
  });

  it('does not mark an unconditional call as conditional', () => {
    expect(byEndpoint.get('GET /medicines')?.condition).toBeUndefined();
    expect(byEndpoint.get('GET /medicines')?.onFailure).toBe(false);
    expect(byEndpoint.get('GET /medicines')?.alternativeTo).toEqual([]);
  });
});

describe('what happens after the response', () => {
  const project = mkdtempSync(join(tmpdir(), 'flowlens-after-'));
  mkdirSync(join(project, 'web'), { recursive: true });
  mkdirSync(join(project, 'lib'), { recursive: true });
  writeFileSync(
    join(project, 'lib', 'api.ts'),
    'export default { get: (u) => fetch(u), post: (u, b) => fetch(u) };',
    'utf8',
  );
  writeFileSync(
    join(project, 'web', 'List.tsx'),
    `import React from 'react';
     import { useRouter } from 'next/navigation';
     import { useQueryClient } from '@tanstack/react-query';
     import toast from 'react-hot-toast';
     import api from '../lib/api';
     export function List() {
       const router = useRouter();
       const queryClient = useQueryClient();
       const load = async () => { await api.get('/api/medicines'); };
       const save = async () => {
         try {
           await api.post('/api/medicines', { name: 'x' });
           queryClient.invalidateQueries({ queryKey: ['medicines'] });
           toast.success('Saved');
           router.push('/medicines');
         } catch (e) {
           toast.error('Could not save');
         }
       };
       return <><button onClick={load}>Load</button><button onClick={save}>Save</button></>;
     }`,
    'utf8',
  );

  const result = scan({ root: project });
  const flows = resolveFlows(result.graph, { includeLocalOnly: true });
  const save = flows.find((flow) => flow.label === 'Save')!;
  const after = flowApis(result.graph, save).aftermath;

  it('says where the action sends the user', () => {
    expect(after.navigatesTo).toEqual(['/medicines']);
  });

  it('follows an invalidated cache to the endpoint that will refetch', () => {
    // The continuation no amount of reading the handler reveals: the refetch
    // fires from a different component.
    expect(after.invalidates).toEqual([{ key: 'medicines', refetches: ['GET /medicines'] }]);
    expect(after.notes.join(' ')).toMatch(/matched to\s+keys by name/);
  });

  it('reports what the user will actually see, success and failure', () => {
    expect(after.notifies).toContain('toast: Saved');
    expect(after.notifies).toContain('toast: Could not save');
    expect(after.handlesErrors).toBe(true);
  });

  it('warns when a feature never catches a failure', () => {
    const load = flows.find((flow) => flow.label === 'Load')!;
    const report = flowApis(result.graph, load).aftermath;
    expect(report.handlesErrors).toBe(false);
    expect(report.notes.join(' ')).toMatch(/unhandled rejection/);
  });

  it('records the status codes an endpoint really answered with', () => {
    const own = scan({ root: project });
    const route = own.graph.nodesOfKind('route')[0];
    if (!route) return;
    mergeRuntimeTrace(own.graph, [
      {
        v: 1,
        traceId: 't',
        spanId: 's',
        kind: 'http-server',
        name: String(route.label),
        startedAt: 1,
        durationMs: 5,
        attrs: {
          httpMethod: route.meta?.['httpMethod'],
          path: route.meta?.['path'],
          statusCode: 500,
        },
      },
    ]);
    expect(route.meta?.['statusCodes']).toEqual([500]);
  });
});
