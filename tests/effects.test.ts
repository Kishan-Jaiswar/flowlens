import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ids, scan, type FlowNode } from '@flowslens/core';

/**
 * The three things a flow used to lose on its way through the backend: the
 * guard that can stop it, the table it writes when the ORM is Prisma, and the
 * effects that leave the app entirely.
 *
 * One project holds all three because they meet in the same handler — an order
 * is authorised, written, charged and queued, and a graph that shows only the
 * write is a graph that misleads.
 */
const project = mkdtempSync(join(tmpdir(), 'flowlens-effects-'));

mkdirSync(join(project, 'prisma'), { recursive: true });
mkdirSync(join(project, 'src', 'orders'), { recursive: true });
mkdirSync(join(project, 'src', 'legacy'), { recursive: true });
mkdirSync(join(project, 'web'), { recursive: true });

writeFileSync(
  join(project, 'package.json'),
  JSON.stringify({ dependencies: { '@nestjs/core': '^10.0.0', '@prisma/client': '^5.0.0' } }),
  'utf8',
);

// `@@map` is the case that must not be pluralised: the table is `order_rows`,
// not `orderRows` and not `order_rowses`.
writeFileSync(
  join(project, 'prisma', 'schema.prisma'),
  `datasource db { provider = "postgresql" }

   model Order {
     id     String @id
     total  Int
   }

   model OrderRow {
     id String @id
     @@map("order_rows")
   }
  `,
  'utf8',
);

writeFileSync(
  join(project, 'src', 'orders', 'orders.controller.ts'),
  `import { Controller, Post, Get, Body, UseGuards, UseInterceptors } from '@nestjs/common';
   import { OrdersService } from './orders.service';

   @Controller('orders')
   @UseGuards(JwtAuthGuard)
   export class OrdersController {
     constructor(private readonly ordersService: OrdersService) {}

     @Post()
     @UseGuards(RolesGuard)
     @UseInterceptors(AuditInterceptor)
     create(@Body() dto: CreateOrderDto) {
       return this.ordersService.create(dto);
     }

     @Get()
     list() {
       return this.ordersService.list();
     }
   }`,
  'utf8',
);

writeFileSync(
  join(project, 'src', 'orders', 'orders.service.ts'),
  `import { Injectable } from '@nestjs/common';

   @Injectable()
   export class OrdersService {
     constructor(
       private readonly prisma: PrismaService,
       private readonly ordersQueue: Queue,
       private readonly stripe: Stripe,
       private readonly mailer: Mailer,
       private readonly cache: RedisCache,
       private readonly logger: Logger,
     ) {}

     async create(dto) {
       const order = await this.prisma.order.create({ data: dto });
       await this.prisma.orderRow.createMany({ data: dto.rows });
       await this.stripe.charges.create({ amount: order.total });
       await this.ordersQueue.add('confirm-order', { id: order.id });
       await this.mailer.sendMail({ to: dto.email });
       await this.cache.del('orders:list');
       await fetch('https://api.shipping.example.com/v2/labels', { method: 'POST' });
       // Not effects: an internal hop, a relative path, and a logger.
       await fetch('http://localhost:4000/internal/reindex');
       await fetch('/internal/ping');
       this.logger.log('order created');
       return order;
     }

     async list() {
       return this.prisma.order.findMany();
     }
   }`,
  'utf8',
);

// An Express router in the same repo: middleware before the handler, and a
// Prisma query inside it.
writeFileSync(
  join(project, 'src', 'legacy', 'routes.js'),
  `const express = require('express');
   const router = express.Router();

   router.use(express.json());

   router.post('/invoices', requireAuth, rateLimit('10/min'), [auditLog], async (req, res) => {
     const invoice = await prisma.order.update({ where: { id: req.body.id }, data: {} });
     await s3.putObject({ Key: 'invoice.pdf' });
     res.json(invoice);
   });

   router.get('/invoices', async (req, res) => {
     res.json(await prisma.order.findMany());
   });

   module.exports = router;`,
  'utf8',
);

// A frontend using a design system whose action prop is not a DOM event.
writeFileSync(
  join(project, 'web', 'OrderPanel.tsx'),
  `import React from 'react';
   import axios from 'axios';

   export function OrderPanel() {
     const submit = async () => { await axios.post('/api/orders', {}); };
     return (
       <Panel>
         <Button onAction={submit}>Place order</Button>
         <Table onRowClick={submit} />
       </Panel>
     );
   }`,
  'utf8',
);

const result = scan({ root: project });
const graph = result.graph;

const labels = (nodes: FlowNode[]) => nodes.map((node) => node.label).sort();

describe('guards, middleware and pipes', () => {
  it('attaches Nest guards from both the class and the method to the route', () => {
    const routeId = ids.route('POST', '/orders');
    const attached = graph.successors(routeId, ['guarded-by']);
    expect(labels(attached)).toEqual(['AuditInterceptor', 'JwtAuthGuard', 'RolesGuard']);
  });

  it('records what each one does, and where it was declared', () => {
    const guard = graph.node(ids.middleware('JwtAuthGuard'));
    expect(guard?.kind).toBe('middleware');
    expect(guard?.meta?.['role']).toBe('guard');
    expect(guard?.meta?.['scope']).toBe('controller');
    expect(graph.node(ids.middleware('RolesGuard'))?.meta?.['scope']).toBe('method');
    expect(graph.node(ids.middleware('AuditInterceptor'))?.meta?.['role']).toBe('interceptor');
  });

  it('applies a class-level guard to every route on the controller', () => {
    const attached = graph.successors(ids.route('GET', '/orders'), ['guarded-by']);
    expect(labels(attached)).toEqual(['JwtAuthGuard']);
  });

  it('keeps the Express middleware that sits between the path and the handler', () => {
    const attached = graph.successors(ids.route('POST', '/invoices'), ['guarded-by']);
    expect(labels(attached)).toEqual(['auditLog', 'rateLimit', 'requireAuth']);
  });

  it('leaves framework plumbing out of it', () => {
    expect(graph.hasNode(ids.middleware('json'))).toBe(false);
    expect(graph.hasNode(ids.middleware('express'))).toBe(false);
  });

  it('counts them in the scan stats', () => {
    expect(result.stats.middleware).toBeGreaterThanOrEqual(6);
  });
});

describe('prisma', () => {
  it('reads the schema and reports how many files it found', () => {
    expect(result.stats.prismaSchemas).toBe(1);
  });

  it('takes the table name literally, including @@map', () => {
    expect(graph.hasNode(ids.collection('Order'))).toBe(true);
    expect(graph.hasNode(ids.collection('order_rows'))).toBe(true);
    // Mongoose's pluralisation must not have been applied to either.
    expect(graph.hasNode(ids.collection('orders'))).toBe(false);
    expect(graph.hasNode(ids.collection('orderrows'))).toBe(false);
  });

  it('classifies the operation, not just the access', () => {
    const ops = graph.nodesOfKind('db-op').filter((node) => node.meta?.['database'] === 'prisma');
    const byLabel = new Map(ops.map((node) => [node.label, node.meta]));
    expect(byLabel.get('Order.create')?.['effect']).toBe('create');
    expect(byLabel.get('Order.findMany')?.['effect']).toBe('read');
    expect(byLabel.get('Order.update')?.['effect']).toBe('update');
    expect(byLabel.get('order_rows.createMany')?.['effect']).toBe('create');
  });

  it('marks the collection as a Prisma table', () => {
    expect(graph.node(ids.collection('Order'))?.meta?.['database']).toBe('prisma');
  });

  it('reaches the table from the service method that queries it', () => {
    const serviceMethod = graph
      .nodesOfKind('method')
      .find((node) => node.label === 'OrdersService.create');
    expect(serviceMethod).toBeDefined();
    const reached = graph.reachable(serviceMethod!.id, { kinds: ['queries', 'writes', 'reads'] });
    expect(reached.has(ids.collection('Order'))).toBe(true);
  });

  it('finds Prisma queries in a plain Express handler too', () => {
    const ops = graph.nodesOfKind('db-op').filter((node) => node.source?.file.includes('legacy'));
    expect(ops.length).toBeGreaterThan(0);
  });

  it('does not treat a non-Prisma receiver as a query', () => {
    const invented = graph
      .nodesOfKind('collection')
      .filter((node) => ['logger', 'log', 'charges'].includes(node.label));
    expect(invented).toEqual([]);
  });
});

describe('external effects', () => {
  const effects = () => graph.nodesOfKind('external-effect');

  it('records every kind of work that leaves the app', () => {
    const kinds = new Set(effects().map((node) => node.meta?.['effectKind']));
    expect(kinds).toContain('payment');
    expect(kinds).toContain('queue');
    expect(kinds).toContain('email');
    expect(kinds).toContain('cache');
    expect(kinds).toContain('storage');
    expect(kinds).toContain('http');
  });

  it('names the host for a third-party HTTP call', () => {
    const hosts = effects()
      .filter((node) => node.meta?.['effectKind'] === 'http')
      .map((node) => node.meta?.['target']);
    expect(hosts).toContain('api.shipping.example.com');
  });

  it('does not call the application itself external', () => {
    const hosts = effects().map((node) => node.meta?.['target']);
    expect(hosts).not.toContain('localhost');
    expect(hosts.filter((host) => host === undefined)).toEqual([]);
  });

  it('matches an injected client named by suffix, as Nest spells it', () => {
    const queue = effects().find((node) => node.meta?.['effectKind'] === 'queue');
    expect(queue?.meta?.['call']).toBe('this.ordersQueue.add');
  });

  it('admits that it cannot read the far side', () => {
    expect(effects().every((node) => node.meta?.['unread'] === true)).toBe(true);
  });

  it('hangs each effect off the step that caused it', () => {
    const serviceMethod = graph
      .nodesOfKind('method')
      .find((node) => node.label === 'OrdersService.create');
    // The five in `create`: the charge, the queued job, the mail, the cache
    // bust and the shipping API. The S3 upload belongs to the Express handler.
    const emitted = graph.successors(serviceMethod!.id, ['emits']);
    expect(emitted).toHaveLength(5);
  });

  it('ignores a logger, which is not an effect worth tracing', () => {
    expect(effects().some((node) => String(node.meta?.['call']).includes('logger'))).toBe(false);
  });

  it('counts them in the scan stats', () => {
    expect(result.stats.externalEffects).toBe(effects().length);
    expect(result.stats.externalEffects).toBeGreaterThan(0);
  });
});

describe('configurable action props', () => {
  it('ignores an unknown design-system prop by default', () => {
    const actions = scan({ root: join(project, 'web') }).graph.nodesOfKind('ui-action');
    expect(actions).toEqual([]);
  });

  it('detects it when the project says what its buttons are called', () => {
    const configured = scan({
      root: join(project, 'web'),
      actionProps: ['onAction'],
      inputActionProps: ['onRowClick'],
    });
    const actions = configured.graph.nodesOfKind('ui-action');
    expect(actions.length).toBeGreaterThanOrEqual(1);
    expect(actions.some((node) => node.meta?.['event'] === 'onAction')).toBe(true);
  });

  it('keeps the built-in props working alongside the configured ones', () => {
    const withExtra = scan({ root: join(project, 'web'), actionProps: ['onAction'] });
    const events = new Set(
      withExtra.graph.nodesOfKind('ui-action').map((node) => node.meta?.['eventClass']),
    );
    expect(events.has('gesture')).toBe(true);
  });
});
