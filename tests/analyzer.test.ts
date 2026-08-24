import { describe, expect, it } from 'vitest';
import {
  analyzeImpact,
  findBrokenCalls,
  findDeadEndpoints,
  findSharedWrites,
  renderFeatureDocument,
  renderFlowTree,
  resolveFlows,
} from '@flowlens/core';
import { exampleScan } from './helpers.js';

describe('scanning the example clinic app', () => {
  it('finds the frontend, the backend and the data layer', () => {
    const { stats } = exampleScan();
    expect(stats.components).toBeGreaterThanOrEqual(3);
    expect(stats.controllers).toBe(4);
    expect(stats.services).toBeGreaterThanOrEqual(5);
    expect(stats.collections).toBe(4);
  });

  it('does not mistake a frontend http client for a backend router', () => {
    // `api.post('/api/patients', body)` must not be read as a route declaration.
    const { graph } = exampleScan();
    const routes = graph.nodesOfKind('route');
    expect(routes).toHaveLength(10);
    for (const route of routes) {
      expect(route.source?.file.startsWith('api/')).toBe(true);
    }
  });

  it('joins frontend calls to backend routes', () => {
    const { seam } = exampleScan();
    expect(seam.matched).toBe(5);
  });
});

describe('feature flows', () => {
  const flows = () => resolveFlows(exampleScan().graph);

  it('discovers one flow per user action that reaches the backend', () => {
    expect(
      flows()
        .map((flow) => flow.label)
        .sort(),
    ).toEqual([
      'Archive',
      'Create Patient',
      'Delete',
      'Print Prescription',
      'Search',
      'Submit Prescription',
    ]);
  });

  it('labels a form submit with its submit button text', () => {
    const flow = flows().find((candidate) => candidate.label === 'Create Patient');
    expect(flow?.component).toBe('PatientForm');
    expect(flow?.event).toBe('onSubmit');
  });

  it('follows a click through a custom hook to the endpoint', () => {
    // handleSubmit -> createPatient (destructured) -> useCreatePatient -> POST
    const flow = flows().find((candidate) => candidate.label === 'Create Patient');
    expect(flow?.endpoints).toEqual(['POST /patients']);
    expect(
      flow?.steps.some((step) => step.kind === 'hook' && step.label === 'useCreatePatient'),
    ).toBe(true);
  });

  it('follows an inline arrow callback: onClick={() => handleDelete(id)}', () => {
    const flow = flows().find((candidate) => candidate.label === 'Delete');
    expect(flow?.endpoints).toContain('DELETE /patients/:param');
  });

  it('traces the flagship flow from click to every collection it touches', () => {
    const flow = flows().find((candidate) => candidate.label === 'Submit Prescription');
    expect(flow).toBeDefined();
    expect(flow?.endpoints).toEqual(['POST /prescriptions']);
    expect(flow?.controllers).toEqual(['PrescriptionsController']);
    expect(flow?.services.sort()).toEqual([
      'AuditService',
      'MedicinesService',
      'PatientsService',
      'PrescriptionsService',
    ]);
    expect(
      flow?.collections.map((access) => `${access.collection}:${access.access}`).sort(),
    ).toEqual(['auditlogs:write', 'medicines:read', 'patients:read', 'prescriptions:write']);
  });

  it('captures the frontend state that feeds the request', () => {
    const flow = flows().find((candidate) => candidate.label === 'Submit Prescription');
    expect(flow?.state.sort()).toEqual(['advice', 'diagnosis', 'followUpDays', 'medicines']);
  });

  it('counts one database operation per query, not one per chained modifier', () => {
    // `this.patientModel.findById(id).lean()` is a single read.
    const flow = flows().find((candidate) => candidate.label === 'Submit Prescription');
    const patientReads = flow?.steps.filter(
      (step) => step.kind === 'db-op' && step.meta?.['collection'] === 'patients',
    );
    expect(patientReads).toHaveLength(1);
    expect(patientReads?.[0]?.meta?.['operation']).toBe('findById');
  });

  it('scores a multi-collection write as riskier than a single read', () => {
    const submit = flows().find((candidate) => candidate.label === 'Submit Prescription');
    const search = flows().find((candidate) => candidate.label === 'Search');
    expect(submit?.risk.level).toBe('high');
    expect(search?.risk.level).toBe('low');
    expect(submit!.risk.score).toBeGreaterThan(search!.risk.score);
  });

  it('marks everything static until a runtime trace is merged', () => {
    for (const flow of flows()) expect(flow.evidence).toBe('static');
  });

  it('gives colliding actions distinct ids', () => {
    const ids = flows().map((flow) => flow.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe('findings', () => {
  it('catches a frontend/backend method mismatch', () => {
    // The page calls PUT /patients/:id/archive; the controller exposes PATCH.
    const broken = findBrokenCalls(exampleScan().graph);
    expect(broken).toHaveLength(1);
    expect(broken[0]?.label).toBe('PUT /patients/:param/archive');
    expect(broken[0]?.meta?.['mismatch']).toBe('method');
    expect(broken[0]?.meta?.['availableMethods']).toEqual(['PATCH']);
  });

  it('lists endpoints no frontend code calls', () => {
    const dead = findDeadEndpoints(exampleScan().graph).map((route) => route.label);
    expect(dead).toContain('GET /medicines/expiring');
  });

  it('flags a collection written by more than one service', () => {
    // PatientsService.create and ImportsService.importPatients both write patients.
    const shared = findSharedWrites(exampleScan().graph);
    const patients = shared.find((entry) => entry.collection === 'patients');
    expect(patients?.writers).toEqual(['ImportsService', 'PatientsService']);
  });

  it('does not flag a collection with a single writer', () => {
    const shared = findSharedWrites(exampleScan().graph);
    expect(shared.map((entry) => entry.collection)).not.toContain('prescriptions');
  });
});

describe('impact analysis', () => {
  it('reports every feature that depends on a shared service method', () => {
    const { graph } = exampleScan();
    const record = graph.nodesOfKind('method').find((node) => node.label === 'AuditService.record');
    expect(record).toBeDefined();

    const impact = analyzeImpact(graph, record!.id);
    expect(impact?.affectedFlows.map((flow) => flow.label).sort()).toEqual([
      'Create Patient',
      'Delete',
      'Submit Prescription',
    ]);
    expect(impact?.collections).toContain('auditlogs');
  });

  it('reports a low blast radius for a leaf method', () => {
    const { graph } = exampleScan();
    const expiring = graph
      .nodesOfKind('method')
      .find((node) => node.label === 'MedicinesService.expiringSoon');
    const impact = analyzeImpact(graph, expiring!.id);
    expect(impact?.level).toBe('low');
    expect(impact?.affectedFlows).toHaveLength(0);
  });
});

describe('data lineage', () => {
  it('follows a value from component state to the model field', () => {
    const { graph } = exampleScan();
    const document = renderFeatureDocument(
      graph,
      resolveFlows(graph).find((flow) => flow.label === 'Submit Prescription')!,
    );
    expect(document).toContain(
      'PrescriptionForm.diagnosis  →  payload.diagnosis  →  ' +
        'CreatePrescriptionDto.diagnosis  →  Prescription.diagnosis',
    );
  });

  it('starts at the payload when a value came from props, not state', () => {
    const { graph } = exampleScan();
    const document = renderFeatureDocument(
      graph,
      resolveFlows(graph).find((flow) => flow.label === 'Submit Prescription')!,
    );
    // patientId is a prop on PrescriptionForm, so it has no state ancestor.
    expect(document).toContain('payload.patientId  →  CreatePrescriptionDto.patientId');
    expect(document).not.toContain('PrescriptionForm.patientId');
  });

  it('follows a form field into the collection it lands in', () => {
    const { graph } = exampleScan();
    const document = renderFeatureDocument(
      graph,
      resolveFlows(graph).find((flow) => flow.label === 'Create Patient')!,
    );
    // state -> payload -> dto -> model
    expect(document).toContain('payload.name');
    expect(document).toContain('CreatePatientDto.name');
    expect(document).toContain('Patient.name');
  });
});

describe('rendering', () => {
  it('renders the execution path as an ASCII tree', () => {
    const { graph } = exampleScan();
    const flow = resolveFlows(graph).find(
      (candidate) => candidate.label === 'Submit Prescription',
    )!;
    const tree = renderFlowTree(flow);
    expect(tree).toContain('USER ACTION');
    expect(tree).toContain('FRONTEND');
    expect(tree).toContain('BACKEND');
    expect(tree).toContain('DATABASE');
    expect(tree.indexOf('USER ACTION')).toBeLessThan(tree.indexOf('DATABASE'));
  });

  it('generates a feature document with the sections a reviewer needs', () => {
    const { graph } = exampleScan();
    const flow = resolveFlows(graph).find(
      (candidate) => candidate.label === 'Submit Prescription',
    )!;
    const document = renderFeatureDocument(graph, flow);
    expect(document).toContain('# Submit Prescription');
    expect(document).toContain('## Execution path');
    expect(document).toContain('## Risk assessment');
    expect(document).toContain('## What could break if this changes?');
  });
});
