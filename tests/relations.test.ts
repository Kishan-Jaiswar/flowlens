import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  collectionRelations,
  explainScreen,
  referenceTargetOf,
  renderScreenDocument,
  scan,
} from '@flowslens/core';
import { exampleScan } from './helpers.js';

/**
 * How the collections link to each other.
 *
 * The one fact a document database never writes down where it matters, and the
 * one the Docs tab cannot do without: a screen showing orders is showing
 * customers too. Because this is an *inference* in the common case — no
 * `ref`, just a field called `customerId` — the tests below care as much about
 * what is not reported as about what is. A link that does not exist is a wrong
 * answer a reader has no way to check.
 */

const project = mkdtempSync(join(tmpdir(), 'flowlens-relations-'));
mkdirSync(join(project, 'api', 'src'), { recursive: true });

// A declared `ref`, an array of them, and an id field with nothing behind it.
writeFileSync(
  join(project, 'api', 'src', 'order.schema.ts'),
  `import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
   import { Document, Types } from 'mongoose';

   @Schema()
   export class Order {
     @Prop({ type: Types.ObjectId, ref: 'Customer', required: true })
     buyer: Types.ObjectId;

     @Prop({ type: [{ type: Types.ObjectId, ref: 'Product' }] })
     lines: Types.ObjectId[];

     @Prop()
     stripeSessionId: string;

     @Prop()
     total: number;
   }
   export const OrderSchema = SchemaFactory.createForClass(Order);`,
  'utf8',
);

writeFileSync(
  join(project, 'api', 'src', 'customer.schema.ts'),
  `import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
   @Schema()
   export class Customer {
     @Prop() name: string;
     @Prop() regionId: string;
   }
   export const CustomerSchema = SchemaFactory.createForClass(Customer);`,
  'utf8',
);

writeFileSync(
  join(project, 'api', 'src', 'product.schema.ts'),
  `import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
   @Schema()
   export class Product { @Prop() name: string; }
   export const ProductSchema = SchemaFactory.createForClass(Product);`,
  'utf8',
);

// The queries: one follows a link with `populate`, one joins with `$lookup`.
writeFileSync(
  join(project, 'api', 'src', 'orders.controller.ts'),
  `import { Controller, Get } from '@nestjs/common';
   import { InjectModel } from '@nestjs/mongoose';
   import { Model } from 'mongoose';
   import { Order } from './order.schema';
   import { Customer } from './customer.schema';

   @Controller('orders')
   export class OrdersController {
     constructor(
       @InjectModel(Order.name) private readonly orderModel: Model<any>,
       @InjectModel(Customer.name) private readonly customerModel: Model<any>,
     ) {}

     @Get()
     async list() {
       return this.orderModel.find({}).populate('buyer').lean();
     }

     @Get('report')
     async report() {
       return this.customerModel.aggregate([
         { $lookup: { from: 'orders', localField: 'lastOrderId', foreignField: '_id', as: 'last' } },
       ]);
     }
   }`,
  'utf8',
);

/**
 * A page, so the links can be read as a document and not only as a structure.
 *
 * The prose that says "these two arrive together" is the whole reason for
 * reading a `populate`, and it lives in a different module from the reading —
 * so a fixture with no frontend leaves the half a reader actually sees
 * untested.
 */
mkdirSync(join(project, 'web', 'src', 'pages'), { recursive: true });
writeFileSync(
  join(project, 'web', 'src', 'pages', 'orders.tsx'),
  `import axios from 'axios';
   import { useEffect, useState } from 'react';

   export default function OrdersPage() {
     const [orders, setOrders] = useState([]);
     useEffect(() => {
       axios.get('/orders').then((res) => setOrders(res.data));
     }, []);
     return <button onClick={() => axios.get('/orders')}>Refresh</button>;
   }`,
  'utf8',
);

const scanned = scan({ root: project });
const relations = collectionRelations(scanned.graph);
const find = (from: string, field: string) =>
  relations.find((relation) => relation.from === from && relation.field === field);

describe('links the schema declares', () => {
  it('reads a `ref` and resolves it to the collection the model stores in', () => {
    const buyer = find('orders', 'buyer');
    expect(buyer).toBeDefined();
    expect(buyer?.to).toBe('customers');
    expect(buyer?.via).toBe('declared');
    // The field is named `buyer`, not `customerId` — nothing but the `ref`
    // could have found this, which is the point of reading it.
    expect(buyer?.many).toBe(false);
  });

  it('reads an array of refs as a link to many', () => {
    const lines = find('orders', 'lines');
    expect(lines?.to).toBe('products');
    expect(lines?.via).toBe('declared');
    expect(lines?.many).toBe(true);
  });

  it('points a declared link at the file that declares it', () => {
    expect(find('orders', 'buyer')?.source?.file).toContain('order.schema.ts');
  });
});

describe('links a query follows', () => {
  it('marks a populated link as one the code really follows', () => {
    // `.populate('buyer')` is on the `find`, so the two arrive together.
    expect(find('orders', 'buyer')?.followed).toBe(true);
  });

  it('leaves a link nothing populates unfollowed', () => {
    expect(find('orders', 'lines')?.followed).toBe(false);
  });

  it('reads a `$lookup` as a link, even with no schema field behind it', () => {
    const joined = find('customers', 'lastOrderId');
    expect(joined?.to).toBe('orders');
    expect(joined?.via).toBe('lookup');
    // A join is the strongest evidence there is: it is in the code that runs.
    expect(joined?.followed).toBe(true);
  });

  it('records the joined collection on the query, so one action can name it', () => {
    const joins = scanned.graph
      .nodesOfKind('db-op')
      .filter((node) => Array.isArray(node.meta?.['joins']))
      .flatMap((node) => node.meta?.['joins'] as string[]);
    expect(joins).toContain('orders');
  });
});

describe('links inferred from a field name', () => {
  /**
   * The whole inference rests on this.
   *
   * `stripeSessionId` and `regionId` look exactly like `customerId` to a
   * regular expression. The only thing separating a foreign key from an opaque
   * token is whether a collection of that name was actually found — so a
   * project with no `regions` must produce no link, however convincing the
   * name is.
   */
  it('reports nothing for an id that names no collection in this project', () => {
    expect(find('orders', 'stripeSessionId')).toBeUndefined();
    expect(find('customers', 'regionId')).toBeUndefined();
  });

  it('never invents a collection that the scan did not find', () => {
    const known = new Set(scanned.graph.nodesOfKind('collection').map((node) => node.label));
    for (const relation of relations) {
      expect(known.has(relation.from)).toBe(true);
      expect(known.has(relation.to)).toBe(true);
    }
  });

  it('prefers a declared `ref` over the naming convention for the same field', () => {
    const buyer = relations.filter((relation) => relation.field === 'buyer');
    expect(buyer).toHaveLength(1);
    expect(buyer[0]?.via).toBe('declared');
  });

  it('reads an id inside a list of line items, one level down', () => {
    // The shape every order, invoice and cart is modelled with.
    const example = collectionRelations(exampleScan().graph);
    const lineItem = example.find(
      (relation) => relation.from === 'orders' && relation.to === 'products',
    );
    expect(lineItem?.field).toBe('products[].productId');
    expect(lineItem?.many).toBe(true);
    expect(lineItem?.via).toBe('naming');
  });
});

describe('the document a reader sees', () => {
  const doc = explainScreen(scanned.graph, 'Orders');

  it('says the two arrive together when the query really joins them', () => {
    expect(doc).toBeDefined();
    const followed = doc!.relations.find((relation) => relation.followed);
    expect(followed?.to).toBe('customers');
    expect(followed?.sentence).toContain('fetches both together');
    // A join is in the code that runs, so it is not hedged as an inference.
    expect(followed?.basis).not.toContain('Inferred');
  });

  it('puts the links a query follows before the ones only a name suggests', () => {
    const ranks = doc!.relations.map((relation) => Number(relation.followed));
    expect(ranks).toEqual([...ranks].sort((a, b) => b - a));
  });

  it('only calls a link "fetched together" when this screen is what fetches it', () => {
    // The `$lookup` lives on a different endpoint, which this page never calls.
    const elsewhere = doc!.relations.find((relation) => relation.from === 'customers');
    expect(elsewhere?.followed).toBe(false);
    expect(elsewhere?.followedElsewhere).toBe(true);
    expect(elsewhere?.sentence).toContain('nothing on this screen');
    expect(doc!.dataFlow.join(' ')).not.toContain('joined on `lastOrderId`');
  });

  it('names the joined collection inside the action, not only in the table', () => {
    const story = [...doc!.onOpen, ...doc!.actions].find((candidate) =>
      candidate.steps.some((step) => step.includes('In the same query')),
    );
    expect(story).toBeDefined();
    expect(story!.steps.join(' ')).toContain('`customers`');
    // And on the row for the query that does it.
    const row = story!.data.find((entry) => entry.collection === 'orders');
    expect(row?.alongside).toContain('customers');
  });

  it('tells the reader where that data comes from, in the summary section', () => {
    expect(
      doc!.dataFlow.some(
        (line) => line.includes('arrives together with') && line.includes('`orders`'),
      ),
    ).toBe(true);
  });

  it('carries all of it into the markdown', () => {
    const markdown = renderScreenDocument(doc!);
    expect(markdown).toContain('`orders.buyer` → `customers`');
    // The panel marks a join with a badge; the markdown has to say it too, or
    // the pasted version is quietly the weaker document.
    expect(markdown).toContain('fetched together');
    expect(markdown).toContain('one to many');
  });
});

describe('the name rule on its own', () => {
  const collections = new Set(['customers', 'products', 'people']);

  it('maps a singular id field to its plural collection', () => {
    expect(referenceTargetOf('customerId', collections)?.collection).toBe('customers');
    expect(referenceTargetOf('customer_id', collections)?.collection).toBe('customers');
  });

  it('reads a plural id field as a link to many', () => {
    expect(referenceTargetOf('productIds', collections)?.many).toBe(true);
    expect(referenceTargetOf('productId', collections)?.many).toBe(false);
  });

  it('follows the same irregular plurals the collection names use', () => {
    expect(referenceTargetOf('personId', collections)?.collection).toBe('people');
  });

  it('refuses the id fields that are never references', () => {
    for (const field of ['id', '_id', 'sessionId', 'requestId', 'externalId']) {
      expect(referenceTargetOf(field, new Set(['ids', 'sessions', 'requests']))).toBeUndefined();
    }
  });

  it('is stable: the same graph gives the same links in the same order', () => {
    expect(collectionRelations(scanned.graph)).toEqual(relations);
  });
});
