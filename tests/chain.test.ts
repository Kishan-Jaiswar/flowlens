import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { queryKeysOf, resolveFlows, scan } from '@flowlens/core';

/**
 * The product promise, end to end: click a thing, and see the component, the
 * handler, the state it sets, the hooks in play, the request with its query and
 * body, the route and its DTO, the controller and service, and the schema and
 * collection the data lands in.
 *
 * One fixture asserted from both ends, because each layer used to be present in
 * the graph while being absent from the flow — the analyzer finding a DTO is not
 * the same as a user being able to see it.
 */
const project = mkdtempSync(join(tmpdir(), 'flowlens-chain-'));

mkdirSync(join(project, 'web'), { recursive: true });
mkdirSync(join(project, 'api'), { recursive: true });

writeFileSync(
  join(project, 'web', 'CustomerSearch.jsx'),
  `import axios from 'axios';
   import { useDebouncedSearch } from './useDebouncedSearch';

   export function CustomerSearch() {
     const [customers, setCustomers] = useState([]);
     const [term, setTerm] = useState('');
     const debounced = useDebouncedSearch(300);

     const search = async () => {
       const res = await axios.get(\`/customers/search?term=\${term}&page=1\`);
       setCustomers(res.data);
     };

     const saveCustomer = async () => {
       await axios.post('/customers', { first_name: term, shop_id: shopId });
       setTerm('');
     };

     return (
       <div>
         <input onChange={search} placeholder="Find customer" />
         <button onClick={saveCustomer}>Save Customer</button>
       </div>
     );
   }`,
  'utf8',
);

writeFileSync(
  join(project, 'web', 'useDebouncedSearch.js'),
  `export function useDebouncedSearch(delay) {
     return delay;
   }`,
  'utf8',
);

writeFileSync(
  join(project, 'api', 'customers.controller.ts'),
  `import { Body, Controller, Get, Post, Query } from '@nestjs/common';
   import { CustomersService } from './customers.service';
   import { CreateCustomerDto } from './create-customer.dto';

   @Controller('customers')
   export class CustomersController {
     constructor(private readonly customersService: CustomersService) {}

     @Get('search')
     search(@Query() query: SearchDto) { return this.customersService.search(query); }

     @Post()
     create(@Body() dto: CreateCustomerDto) { return this.customersService.create(dto); }
   }`,
  'utf8',
);

writeFileSync(
  join(project, 'api', 'create-customer.dto.ts'),
  `export class CreateCustomerDto {
     first_name: string;
     shop_id: string;
   }`,
  'utf8',
);

writeFileSync(
  join(project, 'api', 'customers.service.ts'),
  `import { Injectable } from '@nestjs/common';
   import { InjectModel } from '@nestjs/mongoose';
   import { Model } from 'mongoose';
   import { Customer } from './customer.schema';

   @Injectable()
   export class CustomersService {
     constructor(@InjectModel(Customer.name) private customerModel: Model<CustomerDocument>) {}
     search(query) { return this.customerModel.find({ name: query.term }); }
     create(dto) { return this.customerModel.create(dto); }
   }`,
  'utf8',
);

writeFileSync(
  join(project, 'api', 'customer.schema.ts'),
  `import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';

   @Schema()
   export class Customer {
     @Prop() first_name: string;
     @Prop() shop_id: string;
   }
   export const CustomerSchema = SchemaFactory.createForClass(Customer);`,
  'utf8',
);

const result = scan({ root: project, apiPrefixes: [] });
const flows = resolveFlows(result.graph, { includeLocalOnly: true });
const save = flows.find((flow) => flow.label === 'Save Customer');
const stepOf = (kind: string, match: string) =>
  save?.steps.find((step) => step.kind === kind && step.label.includes(match));

describe('the full chain for one action', () => {
  it('finds the action at all', () => {
    expect(save).toBeDefined();
    expect(save?.source?.file).toContain('CustomerSearch.jsx');
  });

  it('names the component that renders it', () => {
    expect(save?.steps[0]?.detail?.component).toBe('CustomerSearch');
  });

  it('shows the handler and the state it sets', () => {
    const handler = stepOf('handler', 'saveCustomer');
    expect(handler).toBeDefined();
    expect(handler?.detail?.statesWritten).toContain('term');
  });

  it('shows the request body and where each key came from', () => {
    const call = stepOf('api-call', 'POST /customers');
    expect(call?.detail?.payloadKeys).toEqual(['first_name', 'shop_id']);
  });

  it('shows the DTO the route validates against, with its fields', () => {
    const route = stepOf('route', 'POST /customers');
    const dto = route?.detail?.dtos?.[0];
    expect(dto?.name).toBe('CreateCustomerDto');
    expect(dto?.fields).toEqual(expect.arrayContaining(['first_name', 'shop_id']));
  });

  it('shows the controller and the service', () => {
    expect(save?.controllers).toContain('CustomersController');
    expect(save?.services).toContain('CustomersService');
  });

  it('shows the schema behind the collection, with its fields', () => {
    const op = stepOf('db-op', 'customers.create');
    expect(op?.detail?.schema?.model).toBe('Customer');
    expect(op?.detail?.schema?.collection).toBe('customers');
    expect(op?.detail?.schema?.fields).toEqual(expect.arrayContaining(['first_name', 'shop_id']));
  });

  it('ends at the collection, with the effect', () => {
    expect(save?.collections.map((c) => `${c.collection}:${c.effect}`)).toContain(
      'customers:create',
    );
  });

  it('rolls the whole chain up onto the flow', () => {
    expect(save?.dtos).toContain('CreateCustomerDto');
    expect(save?.schemas).toEqual([{ model: 'Customer', collection: 'customers' }]);
  });
});

describe('query parameters', () => {
  it('reads parameter names off a query string', () => {
    expect(queryKeysOf('/customers/search?term=x&page=1')).toEqual(['term', 'page']);
    expect(queryKeysOf('/customers')).toEqual([]);
  });

  it('skips a fully interpolated query string rather than inventing a name', () => {
    // `?${qs}` has no name to report; a key of "${qs}" would be a wrong finding.
    expect(queryKeysOf('/customers?${qs}')).toEqual([]);
  });

  it('surfaces them on the api-call step', () => {
    const search = flows.find((flow) => flow.steps[0]?.meta?.['event'] === 'onChange');
    const call = search?.steps.find((step) => step.kind === 'api-call');
    expect(call?.detail?.queryKeys).toEqual(['term', 'page']);
  });
});

/**
 * `onChange` used to be excluded outright to keep keystroke noise out of the
 * feature list. That also hid file uploads, autosave-on-blur and
 * Enter-to-submit — real actions, and exactly the ones people go looking for.
 */
describe('input events count as actions', () => {
  it('detects an onChange action', () => {
    const change = flows.find((flow) => flow.steps[0]?.meta?.['event'] === 'onChange');
    expect(change).toBeDefined();
  });

  it('marks it as an input event so noisy ones can be filtered', () => {
    const change = flows.find((flow) => flow.steps[0]?.meta?.['event'] === 'onChange');
    expect(change?.steps[0]?.meta?.['eventClass']).toBe('input');
    const click = flows.find((flow) => flow.label === 'Save Customer');
    expect(click?.steps[0]?.meta?.['eventClass']).toBe('gesture');
  });

  it('still traces an input action all the way to the database', () => {
    const change = flows.find((flow) => flow.steps[0]?.meta?.['event'] === 'onChange');
    expect(change?.collections.map((c) => c.collection)).toContain('customers');
  });
});

/**
 * React requires hooks to be called in the component body, so they are never on
 * the click's call path. Attaching them via the component is what makes "which
 * hooks were in play" answerable at all.
 */
describe('hooks', () => {
  it('reports a custom hook used by the component, not just by the handler', () => {
    expect(save?.steps[0]?.detail?.hooks).toContain('useDebouncedSearch');
    expect(save?.hooks).toContain('useDebouncedSearch');
  });
});

rmSync(project, { recursive: true, force: true });

/**
 * `collections` holds one entry per effect, so anything counting it as "number
 * of collections" double-counts a collection that is both inserted into and
 * updated — which inflated the risk score and printed the same collection
 * twice in the reasons.
 */
describe('risk counts collections, not collection-effect pairs', () => {
  it('names each written collection once', () => {
    const reason = save?.risk.reasons.find((r) => r.startsWith('writes to'));
    expect(reason).toBeDefined();
    const named = reason!.split(': ')[1]!.split(', ');
    expect(named).toEqual([...new Set(named)]);
  });
});
