import { describe, expect, it } from 'vitest';
import { FlowGraph, collectionNameOf, dbAccessOf, pluralize } from '@flowlens/core';

function sample(): FlowGraph {
  const graph = new FlowGraph({ root: '/tmp/example' });
  graph.addNode({ id: 'action', kind: 'ui-action', label: 'Save' });
  graph.addNode({ id: 'handler', kind: 'handler', label: 'Form.handleSave' });
  graph.addNode({ id: 'call', kind: 'api-call', label: 'POST /patients' });
  graph.addNode({ id: 'route', kind: 'route', label: 'POST /patients' });
  graph.addNode({ id: 'method', kind: 'method', label: 'PatientsService.create' });
  graph.addNode({ id: 'collection', kind: 'collection', label: 'patients' });
  graph.addEdge({ from: 'action', to: 'handler', kind: 'triggers' });
  graph.addEdge({ from: 'handler', to: 'call', kind: 'requests' });
  graph.addEdge({ from: 'call', to: 'route', kind: 'handled-by' });
  graph.addEdge({ from: 'route', to: 'method', kind: 'calls' });
  graph.addEdge({ from: 'method', to: 'collection', kind: 'writes' });
  return graph;
}

describe('FlowGraph', () => {
  it('treats (from, kind, to) as edge identity', () => {
    const graph = sample();
    const before = graph.edgeCount;
    graph.addEdge({ from: 'action', to: 'handler', kind: 'triggers' });
    expect(graph.edgeCount).toBe(before);
  });

  it('merges node metadata instead of replacing the node', () => {
    const graph = sample();
    graph.addNode({
      id: 'call',
      kind: 'api-call',
      label: 'POST /patients',
      meta: { httpMethod: 'POST' },
    });
    graph.addNode({
      id: 'call',
      kind: 'api-call',
      label: 'POST /patients',
      meta: { path: '/patients' },
    });
    expect(graph.node('call')?.meta).toEqual({ httpMethod: 'POST', path: '/patients' });
  });

  it('upgrades static + runtime evidence to confirmed', () => {
    const graph = sample();
    expect(graph.node('route')?.evidence).toBe('static');
    graph.addNode({ id: 'route', kind: 'route', label: 'POST /patients', evidence: 'runtime' });
    expect(graph.node('route')?.evidence).toBe('confirmed');
  });

  it('does not downgrade confirmed evidence', () => {
    const graph = sample();
    graph.addEdge({ from: 'call', to: 'route', kind: 'handled-by', evidence: 'runtime' });
    graph.addEdge({ from: 'call', to: 'route', kind: 'handled-by', evidence: 'static' });
    const edge = graph.allEdges().find((candidate) => candidate.kind === 'handled-by');
    expect(edge?.evidence).toBe('confirmed');
  });

  it('walks forward to find everything a click reaches', () => {
    const reachable = sample().reachable('action');
    expect([...reachable.keys()]).toContain('collection');
    expect(reachable.get('collection')).toBe(5);
  });

  it('walks backward to answer "who uses this?"', () => {
    const upstream = sample().reachable('collection', { direction: 'in' });
    expect([...upstream.keys()]).toContain('action');
  });

  it('respects an edge-kind filter', () => {
    const reachable = sample().reachable('action', { kinds: ['triggers'] });
    expect([...reachable.keys()]).toEqual(['action', 'handler']);
  });

  it('finds the shortest path between two nodes', () => {
    expect(sample().path('action', 'collection')).toEqual([
      'action',
      'handler',
      'call',
      'route',
      'method',
      'collection',
    ]);
  });

  it('returns an empty path when unreachable', () => {
    expect(sample().path('collection', 'action')).toEqual([]);
  });

  it('survives a round trip through JSON', () => {
    const graph = sample();
    const restored = FlowGraph.fromJSON(JSON.parse(JSON.stringify(graph.toJSON())));
    expect(restored.nodeCount).toBe(graph.nodeCount);
    expect(restored.edgeCount).toBe(graph.edgeCount);
    expect(restored.path('action', 'collection')).toEqual(graph.path('action', 'collection'));
  });

  it('does not loop forever on a cycle', () => {
    const graph = sample();
    graph.addEdge({ from: 'collection', to: 'action', kind: 'calls' });
    expect(graph.reachable('action').size).toBe(6);
  });
});

describe('mongo naming', () => {
  it('pluralises the way mongoose does', () => {
    expect(pluralize('patient')).toBe('patients');
    expect(pluralize('prescription')).toBe('prescriptions');
    expect(pluralize('history')).toBe('histories');
    expect(pluralize('address')).toBe('addresses');
    expect(pluralize('person')).toBe('people');
    expect(pluralize('diagnosis')).toBe('diagnoses');
  });

  it('derives a collection name from a model name', () => {
    expect(collectionNameOf('Patient')).toBe('patients');
    expect(collectionNameOf('AuditLog')).toBe('auditlogs');
    expect(collectionNameOf('MedicineStock')).toBe('medicinestocks');
  });

  it('classifies reads and writes', () => {
    expect(dbAccessOf('find')).toBe('read');
    expect(dbAccessOf('findByIdAndUpdate')).toBe('write');
    expect(dbAccessOf('deleteMany')).toBe('write');
  });

  it('ignores chained modifiers so one query is not counted twice', () => {
    expect(dbAccessOf('lean')).toBeUndefined();
    expect(dbAccessOf('sort')).toBeUndefined();
    expect(dbAccessOf('limit')).toBeUndefined();
  });
});
