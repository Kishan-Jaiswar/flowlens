#!/usr/bin/env node
/**
 * Write a synthetic runtime trace for the example app.
 *
 * The real tracer records these spans from a running app. This script fabricates
 * a plausible recording so you can see the static + runtime merge — confirmed
 * evidence, timings, and a runtime-only discovery — without starting a server or
 * connecting to any database.
 *
 *   node examples/clinic/demo-trace.mjs
 *   node packages/cli/bin/flowlens.mjs trace examples/clinic
 *
 * Every number below is made up. Nothing here talks to a database.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(fileURLToPath(import.meta.url));

// Not inside the example project: FlowLens never writes into the project it
// reads, and this script has to honour the same rule. Pass a path to choose one.
const outFile =
  process.argv[2] ?? process.env['FLOWLENS_TRACE'] ?? join(tmpdir(), 'flowlens-demo-trace.jsonl');

let clock = Date.parse('2026-08-24T09:00:00.000Z');
let spanCounter = 0;

const nextSpanId = () => `span-${(spanCounter += 1)}`;

/** One recorded user action and everything it caused. */
function recordFlow({ traceId, action, component, method, path, spans }) {
  const events = [];
  const uiSpan = nextSpanId();
  const clientSpan = nextSpanId();
  const serverSpan = nextSpanId();

  const total = spans.reduce((sum, span) => sum + span.durationMs, 0);
  const startedAt = clock;
  clock += 1500; // the user pauses between clicks

  events.push({
    v: 1,
    traceId,
    spanId: uiSpan,
    kind: 'ui-action',
    name: action,
    startedAt,
    durationMs: 3,
    attrs: { component },
  });

  events.push({
    v: 1,
    traceId,
    spanId: clientSpan,
    parentSpanId: uiSpan,
    kind: 'http-client',
    name: `${method} ${path}`,
    startedAt: startedAt + 3,
    durationMs: total + 40,
    attrs: { httpMethod: method, path, statusCode: 200 },
  });

  events.push({
    v: 1,
    traceId,
    spanId: serverSpan,
    parentSpanId: clientSpan,
    kind: 'http-server',
    name: `${method} ${path}`,
    startedAt: startedAt + 25,
    durationMs: total + 6,
    attrs: { httpMethod: method, path, statusCode: 200 },
  });

  let cursor = startedAt + 30;
  let parentOfDb = serverSpan;

  for (const span of spans) {
    const spanId = nextSpanId();
    events.push({
      v: 1,
      traceId,
      spanId,
      parentSpanId: span.kind === 'method' ? serverSpan : parentOfDb,
      kind: span.kind,
      name: span.name,
      startedAt: cursor,
      durationMs: span.durationMs,
      attrs: span.attrs,
    });
    // Method spans become the parent of the database work that follows them.
    if (span.kind === 'method') parentOfDb = spanId;
    cursor += span.durationMs;
  }

  return events;
}

const events = [
  ...recordFlow({
    traceId: 'trace-rx-1',
    action: 'Submit Prescription',
    component: 'PrescriptionForm',
    method: 'POST',
    path: '/prescriptions',
    spans: [
      {
        kind: 'method',
        name: 'PrescriptionsController.create',
        durationMs: 2,
        attrs: { class: 'PrescriptionsController', method: 'create' },
      },
      {
        kind: 'method',
        name: 'PrescriptionsService.create',
        durationMs: 148,
        attrs: { class: 'PrescriptionsService', method: 'create' },
      },
      {
        kind: 'db',
        name: 'patients.findById',
        durationMs: 27,
        attrs: { collection: 'patients', operation: 'findById' },
      },
      {
        kind: 'db',
        name: 'medicines.countDocuments',
        durationMs: 82,
        attrs: { collection: 'medicines', operation: 'countDocuments' },
      },
      {
        kind: 'db',
        name: 'prescriptions.create',
        durationMs: 41,
        attrs: { collection: 'prescriptions', operation: 'create' },
      },
      {
        kind: 'db',
        name: 'auditlogs.create',
        durationMs: 9,
        attrs: { collection: 'auditlogs', operation: 'create' },
      },
      {
        // Nothing in the source calls this — a cache the analyzer cannot see.
        kind: 'db',
        name: 'settings.findOne',
        durationMs: 6,
        attrs: { collection: 'settings', operation: 'findOne' },
      },
    ],
  }),
  ...recordFlow({
    traceId: 'trace-patient-1',
    action: 'Create Patient',
    component: 'PatientForm',
    method: 'POST',
    path: '/patients',
    spans: [
      {
        kind: 'method',
        name: 'PatientsController.create',
        durationMs: 2,
        attrs: { class: 'PatientsController', method: 'create' },
      },
      {
        kind: 'method',
        name: 'PatientsService.create',
        durationMs: 54,
        attrs: { class: 'PatientsService', method: 'create' },
      },
      {
        kind: 'db',
        name: 'patients.create',
        durationMs: 38,
        attrs: { collection: 'patients', operation: 'create' },
      },
      {
        kind: 'db',
        name: 'auditlogs.create',
        durationMs: 11,
        attrs: { collection: 'auditlogs', operation: 'create' },
      },
    ],
  }),
  ...recordFlow({
    traceId: 'trace-search-1',
    action: 'Search',
    component: 'PatientsPage',
    method: 'GET',
    path: '/patients',
    spans: [
      {
        kind: 'method',
        name: 'PatientsService.search',
        durationMs: 210,
        attrs: { class: 'PatientsService', method: 'search' },
      },
      {
        // Slow: an unindexed regex scan. Exactly what timings are for.
        kind: 'db',
        name: 'patients.find',
        durationMs: 204,
        attrs: { collection: 'patients', operation: 'find' },
      },
    ],
  }),
];

mkdirSync(dirname(outFile), { recursive: true });
writeFileSync(outFile, `${events.map((event) => JSON.stringify(event)).join('\n')}\n`, 'utf8');

console.log(`wrote ${events.length} synthetic spans to ${outFile}`);
console.log('next: node packages/cli/bin/flowlens.mjs trace examples/clinic');
