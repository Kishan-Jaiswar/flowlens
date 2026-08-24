import { describe, expect, it } from 'vitest';
import {
  groupTraces,
  mergeRuntimeTrace,
  parseTraceFile,
  resolveFlows,
  scan,
  type TraceEvent,
} from '@flowlens/core';
import { EXAMPLE_ROOT } from './helpers.js';

/**
 * A recorded "Submit Prescription" click.
 *
 * Written by hand rather than captured from a live app: these tests must run
 * with no server and no database, which is also the point of the JSONL format.
 */
function submitPrescriptionTrace(): TraceEvent[] {
  const t = 1_735_000_000_000;
  return [
    {
      v: 1,
      traceId: 'trace-1',
      spanId: 'ui',
      kind: 'ui-action',
      name: 'Submit Prescription',
      startedAt: t,
      durationMs: 4,
      attrs: { component: 'PrescriptionForm' },
    },
    {
      v: 1,
      traceId: 'trace-1',
      spanId: 'client',
      parentSpanId: 'ui',
      kind: 'http-client',
      name: 'POST /api/prescriptions',
      startedAt: t + 4,
      durationMs: 196,
      attrs: { httpMethod: 'POST', path: '/api/prescriptions', statusCode: 201 },
    },
    {
      v: 1,
      traceId: 'trace-1',
      spanId: 'server',
      parentSpanId: 'client',
      kind: 'http-server',
      name: 'POST /prescriptions',
      startedAt: t + 40,
      durationMs: 150,
      attrs: { httpMethod: 'POST', path: '/prescriptions', statusCode: 201 },
    },
    {
      v: 1,
      traceId: 'trace-1',
      spanId: 'svc',
      parentSpanId: 'server',
      kind: 'method',
      name: 'PrescriptionsService.create',
      startedAt: t + 45,
      durationMs: 140,
      attrs: { class: 'PrescriptionsService', method: 'create' },
    },
    {
      v: 1,
      traceId: 'trace-1',
      spanId: 'db1',
      parentSpanId: 'svc',
      kind: 'db',
      name: 'patients.findById',
      startedAt: t + 50,
      durationMs: 27,
      attrs: { collection: 'patients', operation: 'findById' },
    },
    {
      v: 1,
      traceId: 'trace-1',
      spanId: 'db2',
      parentSpanId: 'svc',
      kind: 'db',
      name: 'prescriptions.create',
      startedAt: t + 90,
      durationMs: 41,
      attrs: { collection: 'prescriptions', operation: 'create' },
    },
    {
      v: 1,
      traceId: 'trace-1',
      spanId: 'db3',
      parentSpanId: 'svc',
      kind: 'db',
      // A collection the static analyzer never saw — dynamic, and worth surfacing.
      name: 'featureflags.find',
      startedAt: t + 140,
      durationMs: 12,
      attrs: { collection: 'featureflags', operation: 'find' },
    },
  ];
}

describe('parseTraceFile', () => {
  it('reads JSONL and skips malformed lines', () => {
    const events = submitPrescriptionTrace();
    const contents = `${events.map((event) => JSON.stringify(event)).join('\n')}\n{"partial":`;
    expect(parseTraceFile(contents)).toHaveLength(events.length);
  });

  it('ignores blank lines', () => {
    expect(parseTraceFile('\n\n  \n')).toEqual([]);
  });
});

describe('groupTraces', () => {
  it('groups by trace id and sorts by start time', () => {
    const grouped = groupTraces([...submitPrescriptionTrace()].reverse());
    expect(grouped.size).toBe(1);
    const spans = grouped.get('trace-1')!;
    expect(spans[0]?.spanId).toBe('ui');
    expect(spans.at(-1)?.spanId).toBe('db3');
  });
});

describe('mergeRuntimeTrace', () => {
  const merged = () => {
    const result = scan({ root: EXAMPLE_ROOT });
    const merge = mergeRuntimeTrace(result.graph, submitPrescriptionTrace());
    return { graph: result.graph, merge };
  };

  it('matches recorded spans to nodes the analyzer already found', () => {
    const { merge } = merged();
    expect(merge.traces).toBe(1);
    expect(merge.matched).toBeGreaterThanOrEqual(5);
  });

  it('promotes a static node to confirmed once it is observed', () => {
    const { graph } = merged();
    const route = graph.nodesOfKind('route').find((node) => node.label === 'POST /prescriptions');
    expect(route?.evidence).toBe('confirmed');
    expect(route?.observations).toBe(1);
  });

  it('leaves unobserved nodes static', () => {
    const { graph } = merged();
    const dead = graph
      .nodesOfKind('route')
      .find((node) => node.label === 'GET /medicines/expiring');
    expect(dead?.evidence).toBe('static');
  });

  it('keeps a runtime-only discovery instead of discarding it', () => {
    const { graph, merge } = merged();
    expect(merge.discovered).toBeGreaterThanOrEqual(1);
    const flags = graph.nodesOfKind('collection').find((node) => node.label === 'featureflags');
    expect(flags?.evidence).toBe('runtime');
  });

  it('records timings and marks the whole flow confirmed', () => {
    const { graph } = merged();
    const flow = resolveFlows(graph).find((candidate) => candidate.label === 'Submit Prescription');
    expect(flow?.evidence).toBe('confirmed');
    expect(flow?.totalMs).toBeGreaterThan(0);

    const dbStep = flow?.steps.find((step) => step.label === 'prescriptions.create');
    expect(dbStep?.avgMs).toBe(41);
    // A leaf span has no children, so exclusive == inclusive.
    expect(dbStep?.avgSelfMs).toBe(41);
  });

  it('subtracts child spans when computing self time', () => {
    const { graph } = merged();
    // The service span is 140ms and contains 27 + 41 + 12 = 80ms of queries.
    const service = graph
      .nodesOfKind('method')
      .find((node) => node.label === 'PrescriptionsService.create');
    expect(service?.timing?.avgMs).toBe(140);
    expect(service?.timing?.avgSelfMs).toBe(60);
  });

  it('does not count nested spans several times in the flow total', () => {
    const { graph } = merged();
    const flow = resolveFlows(graph).find((candidate) => candidate.label === 'Submit Prescription');
    // The client round trip is 196ms; a naive sum of inclusive times is >500ms.
    const inclusiveSum = flow!.steps.reduce((sum, step) => sum + (step.avgMs ?? 0), 0);
    expect(flow!.totalMs!).toBeLessThanOrEqual(200);
    expect(inclusiveSum).toBeGreaterThan(flow!.totalMs!);
  });

  it('never reports negative self time when children overlap', () => {
    const result = scan({ root: EXAMPLE_ROOT });
    // Two concurrent 100ms queries inside an 120ms parent (Promise.all).
    mergeRuntimeTrace(result.graph, [
      {
        v: 1,
        traceId: 'concurrent',
        spanId: 'parent',
        kind: 'method',
        name: 'PatientsService.search',
        startedAt: 1,
        durationMs: 120,
        attrs: { class: 'PatientsService', method: 'search' },
      },
      {
        v: 1,
        traceId: 'concurrent',
        spanId: 'a',
        parentSpanId: 'parent',
        kind: 'db',
        name: 'patients.find',
        startedAt: 2,
        durationMs: 100,
        attrs: { collection: 'patients', operation: 'find' },
      },
      {
        v: 1,
        traceId: 'concurrent',
        spanId: 'b',
        parentSpanId: 'parent',
        kind: 'db',
        name: 'patients.countDocuments',
        startedAt: 2,
        durationMs: 100,
        attrs: { collection: 'patients', operation: 'countDocuments' },
      },
    ]);

    const parent = result.graph
      .nodesOfKind('method')
      .find((node) => node.label === 'PatientsService.search');
    expect(parent?.timing?.avgSelfMs).toBe(0);
  });

  it('averages repeated observations', () => {
    const result = scan({ root: EXAMPLE_ROOT });
    const first = submitPrescriptionTrace();
    const second = submitPrescriptionTrace().map((event) => ({
      ...event,
      traceId: 'trace-2',
      durationMs: event.durationMs * 3,
    }));
    mergeRuntimeTrace(result.graph, [...first, ...second]);

    const node = result.graph
      .nodesOfKind('db-op')
      .find((candidate) => candidate.label === 'prescriptions.create');
    expect(node?.timing?.count).toBe(2);
    expect(node?.timing?.minMs).toBe(41);
    expect(node?.timing?.maxMs).toBe(123);
    expect(node?.timing?.avgMs).toBe(82);
  });

  it('is idempotent in structure when merged twice', () => {
    const result = scan({ root: EXAMPLE_ROOT });
    mergeRuntimeTrace(result.graph, submitPrescriptionTrace());
    const nodes = result.graph.nodeCount;
    const edges = result.graph.edgeCount;
    mergeRuntimeTrace(result.graph, submitPrescriptionTrace());
    expect(result.graph.nodeCount).toBe(nodes);
    expect(result.graph.edgeCount).toBe(edges);
  });
});
