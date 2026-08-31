import { describe, expect, it } from 'vitest';
import {
  analyzeImpact,
  findBrokenCalls,
  findDeadEndpoints,
  findSharedWrites,
  renderFeatureDocument,
  renderFlowTree,
  resolveFlows,
} from '@flowslens/core';
import { exampleScan } from './helpers.js';

describe('scanning the example shop app', () => {
  it('finds the frontend, the backend and the data layer', () => {
    const { stats } = exampleScan();
    expect(stats.components).toBeGreaterThanOrEqual(3);
    expect(stats.controllers).toBe(4);
    expect(stats.services).toBeGreaterThanOrEqual(5);
    expect(stats.collections).toBe(4);
  });

  it('does not mistake a frontend http client for a backend router', () => {
    // `api.post('/api/customers', body)` must not be read as a route declaration.
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
    ).toEqual(['Archive', 'Create Customer', 'Delete', 'Print Order', 'Search', 'Submit Order']);
  });

  it('labels a form submit with its submit button text', () => {
    const flow = flows().find((candidate) => candidate.label === 'Create Customer');
    expect(flow?.component).toBe('CustomerForm');
    expect(flow?.event).toBe('onSubmit');
  });

  it('follows a click through a custom hook to the endpoint', () => {
    // handleSubmit -> createCustomer (destructured) -> useCreateCustomer -> POST
    const flow = flows().find((candidate) => candidate.label === 'Create Customer');
    expect(flow?.endpoints).toEqual(['POST /customers']);
    expect(
      flow?.steps.some((step) => step.kind === 'hook' && step.label === 'useCreateCustomer'),
    ).toBe(true);
  });

  it('follows an inline arrow callback: onClick={() => handleDelete(id)}', () => {
    const flow = flows().find((candidate) => candidate.label === 'Delete');
    expect(flow?.endpoints).toContain('DELETE /customers/:param');
  });

  it('traces the flagship flow from click to every collection it touches', () => {
    const flow = flows().find((candidate) => candidate.label === 'Submit Order');
    expect(flow).toBeDefined();
    expect(flow?.endpoints).toEqual(['POST /orders']);
    expect(flow?.controllers).toEqual(['OrdersController']);
    expect(flow?.services.sort()).toEqual([
      'AuditService',
      'CustomersService',
      'OrdersService',
      'ProductsService',
    ]);
    expect(
      flow?.collections.map((access) => `${access.collection}:${access.access}`).sort(),
    ).toEqual(['auditlogs:write', 'customers:read', 'orders:write', 'products:read']);
  });

  it('captures the frontend state that feeds the request', () => {
    const flow = flows().find((candidate) => candidate.label === 'Submit Order');
    expect(flow?.state.sort()).toEqual(['couponCode', 'deliveryDays', 'note', 'products']);
  });

  it('counts one database operation per query, not one per chained modifier', () => {
    // `this.customerModel.findById(id).lean()` is a single read.
    const flow = flows().find((candidate) => candidate.label === 'Submit Order');
    const customerReads = flow?.steps.filter(
      (step) => step.kind === 'db-op' && step.meta?.['collection'] === 'customers',
    );
    expect(customerReads).toHaveLength(1);
    expect(customerReads?.[0]?.meta?.['operation']).toBe('findById');
  });

  it('scores a multi-collection write as riskier than a single read', () => {
    const submit = flows().find((candidate) => candidate.label === 'Submit Order');
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
    // The page calls PUT /customers/:id/archive; the controller exposes PATCH.
    const broken = findBrokenCalls(exampleScan().graph);
    expect(broken).toHaveLength(1);
    expect(broken[0]?.label).toBe('PUT /customers/:param/archive');
    expect(broken[0]?.meta?.['mismatch']).toBe('method');
    expect(broken[0]?.meta?.['availableMethods']).toEqual(['PATCH']);
  });

  it('lists endpoints no frontend code calls', () => {
    const dead = findDeadEndpoints(exampleScan().graph).map((route) => route.label);
    expect(dead).toContain('GET /products/expiring');
  });

  it('flags a collection written by more than one service', () => {
    // CustomersService.create and ImportsService.importCustomers both write customers.
    const shared = findSharedWrites(exampleScan().graph);
    const customers = shared.find((entry) => entry.collection === 'customers');
    expect(customers?.writers).toEqual(['CustomersService', 'ImportsService']);
  });

  it('does not flag a collection with a single writer', () => {
    const shared = findSharedWrites(exampleScan().graph);
    expect(shared.map((entry) => entry.collection)).not.toContain('orders');
  });
});

describe('functions that are not named like handlers', () => {
  /**
   * The regression this covers: node creation used to be gated on
   * `/^(handle|on)[A-Z]/`, so a codebase naming its functions `fetchCustomers` or
   * `saveVoiceRx` had no node for them. Every request they made was credited to
   * the whole component instead, which severed `ui-action -> handler -> api-call`
   * and made a large app look as though it had almost no flows.
   */
  it('attributes a request to the function that made it, not the component', () => {
    const graph = exampleScan().graph;
    const owners = graph
      .allEdges()
      .filter((edge) => edge.kind === 'requests')
      .map((edge) => graph.node(edge.from)?.kind);
    expect(owners.length).toBeGreaterThan(0);
    // A component may still own a module-level call, but must not be the norm.
    expect(owners.filter((kind) => kind === 'component').length).toBeLessThan(owners.length);
  });
});

describe('screens that load their data on mount', () => {
  it('does not invent a mount action for a component that only holds a hook', () => {
    // CustomerForm calls useCreateCustomer() in its body, but the request happens
    // in handleSubmit. A hook call is a declaration, not a mount-time fetch.
    const flows = resolveFlows(exampleScan().graph);
    expect(flows.map((flow) => flow.label)).not.toContain('CustomerForm loads');
  });

  it('marks a synthetic mount action so it is distinguishable from a click', () => {
    const graph = exampleScan().graph;
    for (const action of graph.nodesOfKind('ui-action')) {
      if (action.meta?.['synthetic'] === true) {
        expect(action.meta?.['event']).toBe('mount');
      }
    }
  });
});

describe('impact analysis', () => {
  it('reports every feature that depends on a shared service method', () => {
    const { graph } = exampleScan();
    const record = graph.nodesOfKind('method').find((node) => node.label === 'AuditService.record');
    expect(record).toBeDefined();

    const impact = analyzeImpact(graph, record!.id);
    expect(impact?.affectedFlows.map((flow) => flow.label).sort()).toEqual([
      'Create Customer',
      'Delete',
      'Submit Order',
    ]);
    expect(impact?.collections).toContain('auditlogs');
  });

  it('reports a low blast radius for a leaf method', () => {
    const { graph } = exampleScan();
    const expiring = graph
      .nodesOfKind('method')
      .find((node) => node.label === 'ProductsService.expiringSoon');
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
      resolveFlows(graph).find((flow) => flow.label === 'Submit Order')!,
    );
    expect(document).toContain(
      'OrderForm.note  →  payload.note  →  ' + 'CreateOrderDto.note  →  Order.note',
    );
  });

  it('starts at the payload when a value came from props, not state', () => {
    const { graph } = exampleScan();
    const document = renderFeatureDocument(
      graph,
      resolveFlows(graph).find((flow) => flow.label === 'Submit Order')!,
    );
    // customerId is a prop on OrderForm, so it has no state ancestor.
    expect(document).toContain('payload.customerId  →  CreateOrderDto.customerId');
    expect(document).not.toContain('OrderForm.customerId');
  });

  it('follows a form field into the collection it lands in', () => {
    const { graph } = exampleScan();
    const document = renderFeatureDocument(
      graph,
      resolveFlows(graph).find((flow) => flow.label === 'Create Customer')!,
    );
    // state -> payload -> dto -> model
    expect(document).toContain('payload.name');
    expect(document).toContain('CreateCustomerDto.name');
    expect(document).toContain('Customer.name');
  });
});

describe('rendering', () => {
  it('renders the execution path as an ASCII tree', () => {
    const { graph } = exampleScan();
    const flow = resolveFlows(graph).find((candidate) => candidate.label === 'Submit Order')!;
    const tree = renderFlowTree(flow);
    expect(tree).toContain('USER ACTION');
    expect(tree).toContain('FRONTEND');
    expect(tree).toContain('BACKEND');
    expect(tree).toContain('DATABASE');
    expect(tree.indexOf('USER ACTION')).toBeLessThan(tree.indexOf('DATABASE'));
  });

  it('generates a feature document with the sections a reviewer needs', () => {
    const { graph } = exampleScan();
    const flow = resolveFlows(graph).find((candidate) => candidate.label === 'Submit Order')!;
    const document = renderFeatureDocument(graph, flow);
    expect(document).toContain('# Submit Order');
    expect(document).toContain('## Execution path');
    expect(document).toContain('## Risk assessment');
    expect(document).toContain('## What could break if this changes?');
  });
});
