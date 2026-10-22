import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  databaseChanges,
  databaseReport,
  hasDatabaseChanges,
  render,
  resolveFlows,
  scan,
  simplify,
} from '@flowslens/core';
import { renderDatabaseMarkdown } from '../packages/cli/dist/commands/db.js';
import { exampleScan } from './helpers.js';

/** The Database tab and `flowlens db`: the collections as the code sees them. */

describe('databaseReport on the example app', () => {
  const { graph } = exampleScan();
  const report = databaseReport(graph, resolveFlows(graph, { includeLocalOnly: true }));
  const named = (name: string) => report.collections.find((entry) => entry.name === name)!;

  it('lists every collection with its model', () => {
    expect(report.collections.map((entry) => entry.name)).toEqual([
      'auditlogs',
      'customers',
      'orders',
      'products',
    ]);
    expect(named('customers').model).toBe('Customer');
    expect(report.totals.relations).toBe(2);
  });

  it('reads required and index off @Prop', () => {
    const phone = named('customers').fields.find((field) => field.name === 'phone')!;
    expect(phone).toMatchObject({ required: true, indexed: true, origin: 'declared' });
    const age = named('customers').fields.find((field) => field.name === 'age')!;
    expect(age.required).toBeUndefined();
  });

  it('keeps a field only a query uses apart from the schema', () => {
    const queried = named('orders').fields.find((field) => field.name === 'products[].productId');
    expect(queried).toMatchObject({ origin: 'queried', ref: 'products' });
  });

  it('gives one row per action, with every effect it has', () => {
    const remove = named('customers').usedBy.find((use) => use.flowId === 'customerspage-delete')!;
    expect(remove.effects).toEqual(['read', 'delete']);
    expect(named('customers').usedBy.filter((use) => use.flowId === remove.flowId)).toHaveLength(1);
  });

  it('marks a guessed link as one, from both ends', () => {
    const link = named('orders').references.find((r) => r.field === 'customerId')!;
    expect(link).toMatchObject({ to: 'customers', via: 'naming' });
    expect(named('customers').referencedBy).toContainEqual(link);
  });

  it('says where a field gets its value, and which actions cause it', () => {
    const phone = named('customers').fields.find((field) => field.name === 'phone')!;
    expect(phone.writes[0]).toMatchObject({
      value: 'dto.phone',
      from: 'input',
      how: 'insert',
      in: 'create',
    });
    expect(phone.writes[0]!.actions.length).toBeGreaterThan(0);
    const archived = named('customers').fields.find((field) => field.name === 'archived')!;
    expect(archived.writes).toContainEqual(
      expect.objectContaining({ value: 'true', from: 'fixed', how: '$set' }),
    );
    expect(named('customers').lookupKeys).toContain('_id');
  });

  it('follows a field from the form it is typed into to the screen that shows it', () => {
    const name = named('customers').fields.find((field) => field.name === 'name')!;
    expect(name.enteredIn[0]).toMatchObject({
      key: 'name',
      label: 'placeholder "Full name"',
      source: { file: 'web/src/components/CustomerForm.tsx' },
    });
    expect(name.shownIn).toContainEqual(
      expect.objectContaining({
        code: 'customer.name',
        source: expect.objectContaining({ file: 'web/src/pages/customers.tsx' }),
      }),
    );
  });

  it('lists every API that touches a field, and what each does with it', () => {
    const phone = named('customers').fields.find((field) => field.name === 'phone')!;
    const save = phone.apis.find((api) => api.endpoint === 'POST /customers')!;
    expect(save.uses[0]).toMatchObject({ does: 'saves', value: 'dto.phone', in: 'create' });
    expect(save.calledFrom.length).toBeGreaterThan(0);
    // Saving comes first, then the endpoints that only read it.
    expect(phone.apis[0]!.uses.some((use) => use.does === 'saves')).toBe(true);
    expect(phone.apis.some((api) => api.uses.some((use) => use.does === 'returns'))).toBe(true);
  });

  it('says a delete leaves the records that point at it behind', () => {
    expect(named('customers').onDelete).toEqual([
      expect.objectContaining({ from: 'orders', field: 'customerId', outcome: 'kept' }),
    ]);
  });

  it('flags a lookup no index serves, and leaves indexed ones alone', () => {
    const slow = named('products').slowQueries!.map((q) => q.fields);
    expect(slow).toContainEqual(['expiryDate']);
    expect(named('customers').indexesKnown).toBe(true);
  });

  it('says who runs a query no user action reaches', () => {
    const runners = new Set(named('products').operations.map((op) => op.runBy));
    expect(runners).toContain('user');
    expect(runners).toContain('endpoint');
  });

  it('flags a field saved but never read back', () => {
    const subject = named('auditlogs').fields.find((field) => field.name === 'subjectId')!;
    expect(subject.unused).toBe('never-read');
    // Read back somewhere: not flagged.
    expect(
      named('customers').fields.find((field) => field.name === 'phone')!.unused,
    ).toBeUndefined();
  });

  it('takes links the code cannot show from the config, marked as declared', () => {
    const declared = databaseReport(graph, resolveFlows(graph, { includeLocalOnly: true }), {
      relations: [{ from: 'auditlogs', field: 'subjectId', to: 'customers' }],
    });
    const audit = declared.collections.find((entry) => entry.name === 'auditlogs')!;
    expect(audit.references).toContainEqual(
      expect.objectContaining({ field: 'subjectId', to: 'customers', via: 'config' }),
    );
    expect(audit.fields.find((field) => field.name === 'subjectId')!.ref).toBe('customers');
  });

  it('writes the database as a Markdown document with a diagram of its links', () => {
    const document = renderDatabaseMarkdown(report);
    expect(document).toContain('```mermaid');
    expect(document).toMatch(/orders -\.->\|customerId\| customers/);
    expect(document).toContain('## Worth a look');
    expect(document).toContain('| `phone` |');
  });

  it('flags a collection written from several places', () => {
    expect(named('customers').notes.join(' ')).toMatch(/2 places/);
  });
});

describe('plain Mongoose schema rules', () => {
  it('reads required, unique and required: [true, msg] from new Schema({...})', () => {
    const project = mkdtempSync(join(tmpdir(), 'flowlens-database-'));
    mkdirSync(join(project, 'src'), { recursive: true });
    writeFileSync(
      join(project, 'src', 'user.ts'),
      `import mongoose from 'mongoose';
       const schema = new mongoose.Schema({
         email: { type: String, required: [true, 'email is required'], unique: true },
         nickname: { type: String, required: false },
       });
       export const User = mongoose.model('User', schema);`,
    );
    const { graph } = scan({ root: project });
    const users = databaseReport(graph, []).collections.find((entry) => entry.name === 'users')!;
    expect(users.fields.find((field) => field.name === 'email')).toMatchObject({
      required: true,
      unique: true,
      indexed: true,
    });
    expect(users.fields.find((field) => field.name === 'nickname')?.required).toBeUndefined();
    expect(users.notes).toContain('No code reads or writes it.');
  });
});

describe('fields of a raw-driver collection, read from its queries', () => {
  it('follows spreads, $set keys and filters back to their values', () => {
    const project = mkdtempSync(join(tmpdir(), 'flowlens-database-'));
    mkdirSync(join(project, 'src'), { recursive: true });
    writeFileSync(
      join(project, 'src', 'store.ts'),
      `import { db } from './db';
       const imports = db.collection('imports');
       export async function create(data: { fileName: string }, ownerId: string) {
         const record = { fileName: data.fileName || 'Untitled', status: 'processing', createdAt: new Date() };
         await imports.insertOne({ ...record, ownerId });
       }
       export async function complete(id: string, result: { added: number; failed: number }) {
         const total = result.added + result.failed;
         await imports.updateOne({ id }, { $set: { ...result, total }, $inc: { runs: 1 } });
       }
       export async function list(ownerId: string) {
         return imports.find({ ownerId }).sort({ createdAt: -1 }).toArray();
       }`,
    );
    const { graph } = scan({ root: project });
    const imports = databaseReport(graph, []).collections.find((c) => c.name === 'imports')!;
    const field = (name: string) => imports.fields.find((entry) => entry.name === name)!;
    expect(field('fileName').writes[0]).toMatchObject({
      from: 'input',
      how: 'insert',
      in: 'create',
      inputKey: 'fileName',
    });
    expect(field('createdAt').sorts[0]).toMatchObject({ value: '-1', in: 'list' });
    expect(field('status').writes[0]).toMatchObject({ value: "'processing'", from: 'fixed' });
    expect(field('createdAt').writes[0]?.from).toBe('time');
    expect(field('ownerId').writes[0]?.from).toBe('input');
    expect(field('added').writes[0]).toMatchObject({ value: 'result.added', how: '$set' });
    // Worked out from what was sent (a sum), not the value sent itself.
    expect(field('total').writes[0]?.from).toBe('computed');
    expect(field('runs').writes[0]).toMatchObject({ how: '$inc', from: 'fixed' });
    expect(imports.lookupKeys).toEqual(['id', 'ownerId']);
  });
});

describe('a Nest backend: models picked at run time, sub-documents, defaults, named handles', () => {
  const project = mkdtempSync(join(tmpdir(), 'flowlens-database-'));
  const write = (file: string, text: string) => {
    mkdirSync(join(project, file, '..'), { recursive: true });
    writeFileSync(join(project, file), text);
  };
  write(
    'package.json',
    JSON.stringify({ dependencies: { '@nestjs/core': '9.0.0', mongoose: '6.0.0' } }),
  );
  write(
    'src/emr/emr.schema.ts',
    `import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
     @Schema() export class Line { @Prop() text: string; }
     export const LineSchema = SchemaFactory.createForClass(Line);
     /** A piece of advice a doctor gives. More words. */
     @Schema({ timestamps: { createdAt: 'created_at' } })
     export class Advice { @Prop() advice: string; @Prop({ default: Date.now }) given_at: Date; @Prop() created_at: Date; @Prop({ type: [LineSchema] }) lines: Line[]; }
     @Schema() export class Symptom { @Prop() name: string; }
     @Schema() export class Unused { @Prop() name: string; }`,
  );
  write(
    'src/emr/emr.module.ts',
    `import { MongooseModule } from '@nestjs/mongoose';
     import { Advice, Symptom } from './emr.schema';
     export const imports = [MongooseModule.forFeature([{ name: Advice.name, schema: {} }, { name: Symptom.name, schema: {} }])];`,
  );
  write(
    'src/emr/emr.service.ts',
    `import { Injectable } from '@nestjs/common';
     import { InjectModel } from '@nestjs/mongoose';
     import { Advice, Symptom } from './emr.schema';
     @Injectable()
     export class EmrService {
       constructor(
         @InjectModel(Advice.name) private advice: Model<Advice>,
         @InjectModel(Symptom.name) private symptoms: Model<Symptom>,
       ) {}
       async search(category: string) {
         let model;
         if (category === 'advice') model = this.advice;
         else model = this.symptoms;
         return model.find({});
       }
       async save(data) { return this.findOrCreate(data, this.advice); }
       async findOrCreate(data, model) { return model.findOne({ name: data.name }); }
     }`,
  );
  write(
    'scripts/backfill.js',
    `const mongoose = require('mongoose');
     async function main() {
       const collection = mongoose.connection.collection('advices');
       await collection.updateMany({}, { $set: { advice: '' } });
     }`,
  );
  write(
    'src/emr/visit.schema.ts',
    `import { Prop, Schema } from '@nestjs/mongoose';
     import { Advice } from './emr.schema';
     import { VisitKinds } from './kinds';
     @Schema() export class Visit { @Prop({ ref: Advice.name }) advice_ref: string; @Prop() visit_id: string; @Prop({ enum: VisitKinds }) kind: string; @Prop() is_active: boolean; }`,
  );
  write('src/emr/kinds.ts', `export enum VisitKinds { first = 'first', follow = 'follow' }`);
  write(
    'src/emr/visit.list.service.ts',
    `import { Injectable } from '@nestjs/common';
     import { InjectModel } from '@nestjs/mongoose';
     @Injectable()
     export class VisitListService {
       constructor(@InjectModel(Visit.name) private visits: Model<Visit>) {}
       async run(query) { return this.visits.aggregate(query); }
       async list() {
         const stages = [{ $sort: { kind: -1 } }];
         let query = [{ $match: { visit_id: 'a' } }];
         query = [...query, ...stages];
         return this.run(query);
       }
       async hide(id) { return this.visits.updateOne({ visit_id: id }, { $set: { is_active: false } }); }
     }`,
  );
  write(
    'src/emr/visit.module.ts',
    `export const imports = [MongooseModule.forFeature([{ name: Visit.name, schema: {} }])];`,
  );
  write(
    'src/emr/visit.service.ts',
    `import { Injectable } from '@nestjs/common';
     import { InjectModel } from '@nestjs/mongoose';
     import { Cron } from '@nestjs/schedule';
     @Injectable()
     export class VisitService {
       constructor(@InjectModel(Visit.name) private visits: Model<Visit>, @InjectModel(Advice.name) private advice: Model<Advice>) {}
       async add(dto) { const visit = new this.visits(dto); visit.visit_id = 'v1'; await visit.save(); }
       async token(user) { return new this.visits(user); }
       async counts(id) { return this.visits.find({ advice_ref: new this.visits.base.Types.ObjectId(id) }); }
       async legacy() { return this.visits.update({ visit_id: 'a' }, { visit_id: 'b' }); }
       async withAdvice() {
         return this.advice.aggregate([{ $lookup: { from: 'visits', localField: '_id', foreignField: 'advice_ref', as: 'visits' } }]);
       }
       @Cron('0 * * * *') async nightly() { return this.visits.deleteMany({}); }
       async orphan() { return this.visits.countDocuments({}); }
     }
     @Injectable()
     export class JwtStrategy extends PassportStrategy(Strategy) {
       constructor(@InjectModel(Visit.name) private visits: Model<Visit>) { super(); }
       async validate(payload) { return this.visits.findOne({ visit_id: payload.id }); }
     }`,
  );
  const { graph } = scan({ root: project });
  const report = databaseReport(graph, [], { scenarios: false });
  const named = (name: string) => report.collections.find((entry) => entry.name === name);

  it('reads a ref written as `Model.name`, and a $lookup from the side that holds the id', () => {
    const links = named('visits')!.references.map((r) => `${r.field}>${r.to}:${r.via}`);
    // Stated twice — the schema's ref and the join — and read from the visits side both times.
    expect(links).toEqual([expect.stringMatching(/^advice_ref>advices:(declared|lookup)$/)]);
    expect(named('advices')!.references).toEqual([]);
  });

  it('counts `new Model(dto)` only when it is saved, with what it was built from', () => {
    const saves = named('visits')!.operations.filter((op) => op.operation === 'save');
    expect(saves.map((op) => op.method)).toEqual(['VisitService.add']);
    expect(named('visits')!.operations.map((op) => op.operation)).toContain('update');
  });

  it('reads an enum from the file it is imported from', () => {
    expect(named('visits')!.fields.find((f) => f.name === 'kind')!.enumValues).toEqual([
      'first',
      'follow',
    ]);
  });

  it('reads a pipeline a caller builds, reassignments and spreads included', () => {
    const kind = named('visits')!.fields.find((f) => f.name === 'kind')!;
    expect(kind.sorts.map((s) => s.in)).toContain('run');
    const visitId = named('visits')!.fields.find((f) => f.name === 'visit_id')!;
    expect(visitId.lookups.map((l) => l.in)).toContain('run');
  });

  it('calls an update that only hides the record a soft delete', () => {
    const hide = named('visits')!.operations.find((op) => op.method === 'VisitListService.hide')!;
    expect(hide.softDelete).toBe(true);
  });

  it('says what runs a query no user reaches: a timer, every request, or nothing', () => {
    const runBy = (method: string) =>
      named('visits')!.operations.find((op) => op.method === method)?.runBy;
    expect(runBy('VisitService.nightly')).toBe('job');
    expect(runBy('JwtStrategy.validate')).toBe('request');
    expect(runBy('VisitService.orphan')).toBe('unused');
  });

  it('files a query on a model picked into a variable or passed as a parameter on each model it can be', () => {
    expect(named('advices')!.operations.map((op) => op.method)).toEqual(
      expect.arrayContaining(['EmrService.search', 'EmrService.findOrCreate']),
    );
    expect(named('symptoms')!.operations.map((op) => op.method)).toContain('EmrService.search');
  });

  it('keeps a schema nothing registers out of the collections: a sub-document, or unused', () => {
    expect(report.collections.map((entry) => entry.name).sort()).toEqual([
      'advices',
      'symptoms',
      'visits',
    ]);
  });

  it('reads the collection a named handle holds, not the variable name', () => {
    expect(named('collections')).toBeUndefined();
    expect(named('advices')!.operations.map((op) => op.operation)).toContain('updateMany');
  });

  it('reads defaults and timestamps, and the schema comment', () => {
    const field = (name: string) => named('advices')!.fields.find((f) => f.name === name)!;
    expect(field('given_at').defaultValue).toBe('Date.now');
    expect(field('created_at').defaultValue).toMatch(/timestamps/);
    expect(field('created_at').unused).toBeUndefined();
    expect(named('advices')!.description).toBe('A piece of advice a doctor gives.');
  });
});

describe('a value picked with buttons, and a filter only inside $or', () => {
  const project = mkdtempSync(join(tmpdir(), 'flowlens-database-'));
  const write = (file: string, text: string) => {
    mkdirSync(join(project, file, '..'), { recursive: true });
    writeFileSync(join(project, file), text);
  };
  write('package.json', JSON.stringify({ dependencies: { next: '15.0.0', react: '19.0.0' } }));
  write(
    'lib/urls.ts',
    `export const archiveStock = (id) => \`/api/stock/\${id}/archive\`;
     export const restoreStock = "/api/stock/restore ";`,
  );
  write(
    'app/stock/archive.tsx',
    `'use client';
     import { archiveStock, restoreStock } from '../../lib/urls';
     export function ArchiveButton({ id, undo }) {
       return <button onClick={() => fetch(undo ? restoreStock : archiveStock(id), { method: 'POST' })}>Archive</button>;
     }`,
  );
  write(
    'app/stock/page.tsx',
    `'use client';
     import { useState } from 'react';
     const ACTIONS = [{ value: 'increase', label: 'Increase' }, { value: 'decrease', label: 'Decrease' }];
     export default function StockPage() {
       const [action, setAction] = useState('increase');
       const [qty, setQty] = useState('');
       async function save() {
         await fetch('/api/stock', { method: 'POST', body: JSON.stringify({ actionType: action, quantity: qty }) });
       }
       return (
         <div>
           {ACTIONS.map((a) => (<button key={a.value} onClick={() => setAction(a.value)}>{a.label}</button>))}
           <label>Quantity<input value={qty} onChange={(e) => setQty(e.target.value)} /></label>
           <button onClick={save}>Save</button>
         </div>
       );
     }`,
  );
  write(
    'app/api/stock/route.ts',
    `import { record } from '../../../lib/store';
     export async function POST(request: Request) {
       const body = await request.json();
       await record('clinic-1', body);
       return Response.json({ ok: true });
     }`,
  );
  // A signed-in route runs the backfill: the tenant check only covers what a user can set off.
  write(
    'app/api/forms/route.ts',
    `import { backfill } from '../../../lib/store';
     import { requireAuth } from '../../../lib/auth';
     export async function GET(request: Request) {
       await requireAuth(request);
       return Response.json(await backfill());
     }`,
  );
  write(
    'lib/store.ts',
    `import { db } from './db';
     const movements = db.collection('movements');
     const medicines = db.collection('medicines');
     export async function record(ownerId: string, input: { actionType: string; quantity: number }) {
       await movements.insertOne({ ownerId, actionType: input.actionType, quantity: input.quantity });
     }
     export async function list(ownerId: string) { return movements.find({ ownerId }).toArray(); }
     export async function count(ownerId: string) { return movements.countDocuments({ ownerId }); }
     export async function stock(ownerId: string) { return medicines.find({ ownerId }).toArray(); }
     export async function one(ownerId: string, id: string) { return medicines.findOne({ ownerId, id }); }
     export async function backfill() {
       return medicines.find({ $or: [{ form: { $exists: false } }, { form: '' }] }).toArray();
     }`,
  );
  const { graph } = scan({ root: project });
  const report = databaseReport(graph, resolveFlows(graph, { includeLocalOnly: true }));
  const named = (name: string) => report.collections.find((entry) => entry.name === name)!;

  it('reads a URL a function builds, one with a stray space, and both sides of a conditional one', () => {
    const calls = graph.nodesOfKind('api-call').map((node) => node.label);
    expect(calls).toEqual(
      expect.arrayContaining([
        'POST /stock/restore',
        expect.stringMatching(/^POST \/stock\/:\w+\/archive$/),
      ]),
    );
  });

  it('says a value is picked with buttons, labelled with their words', () => {
    const action = named('movements').fields.find((field) => field.name === 'actionType')!;
    expect(action.enteredIn).toContainEqual(
      expect.objectContaining({
        kind: 'form',
        picked: true,
        label: 'Increase / Decrease',
        key: 'actionType',
      }),
    );
  });

  it('names the keys a filter matches inside $or, not "no filter at all"', () => {
    const unscoped = named('medicines').unscoped?.find((q) => q.method === 'backfill');
    expect(unscoped?.why).toContain('matches only on `form` inside `$or`');
  });
});

describe('a filter and a sort built from what the user picks', () => {
  it('keeps a key searched inside $or apart from the same key matched exactly, and reads a picked sort key', () => {
    const project = mkdtempSync(join(tmpdir(), 'flowlens-database-'));
    mkdirSync(join(project, 'lib'), { recursive: true });
    writeFileSync(
      join(project, 'lib', 'store.ts'),
      `import { db } from './db';
       const items = db.collection('items');
       type SortField = 'name' | 'price';
       interface Query { search?: string; form?: string; sortBy?: SortField }
       function filterOf(query: Query) {
         const filter: Record<string, unknown> = {};
         if (query.search) filter.$or = [{ name: { $regex: query.search } }, { form: { $regex: query.search } }];
         if (query.form) filter.form = query.form;
         return filter;
       }
       export async function list(query: Query) {
         const sortBy = query.sortBy ?? 'updatedAt';
         return items.find(filterOf(query)).sort({ [sortBy]: -1 }).toArray();
       }`,
    );
    const items = databaseReport(scan({ root: project }).graph, []).collections.find(
      (c) => c.name === 'items',
    )!;
    const field = (name: string) => items.fields.find((entry) => entry.name === name)!;
    expect(
      field('form')
        .lookups.map((l) => l.match ?? 'equals')
        .sort(),
    ).toEqual(['equals', 'search']);
    expect(
      items.fields
        .filter((f) => f.sorts.length)
        .map((f) => f.name)
        .sort(),
    ).toEqual(['name', 'price', 'updatedAt']);
  });
});

describe('everything about one field, read the way a reviewer would', () => {
  const project = mkdtempSync(join(tmpdir(), 'flowlens-database-'));
  mkdirSync(join(project, 'src'), { recursive: true });
  writeFileSync(
    join(project, 'src', 'store.ts'),
    `import { db } from './db';
     const medicines = db.collection('medicines');
     function medicineFilter(ownerId: string, query: { search?: string }) {
       const filter: Record<string, unknown> = { ownerId };
       const and: Array<Record<string, unknown>> = [];
       if (query.search) {
         const rx = { $regex: query.search, $options: 'i' };
         and.push({ $or: [{ name: rx }, { genericName: rx }] });
       }
       if (and.length) filter.$and = and;
       return filter;
     }
     export async function listMedicines(ownerId: string, query: { search?: string }) {
       const filter = medicineFilter(ownerId, query);
       const total = await medicines.countDocuments(filter);
       return { total, docs: await medicines.find(filter).toArray() };
     }
     export async function upsertMedicine(ownerId: string, input: { name: string; genericName: string; qty: number }) {
       const existing = await medicines.findOne({ ownerId, name: input.name });
       if (existing) {
         await medicines.updateOne({ id: existing.id }, { $set: { qty: existing.qty + input.qty } });
         return;
       }
       await medicines.insertOne({ ownerId, name: input.name, genericName: input.genericName, qty: input.qty });
     }
     export async function importReconcileMedicine(ownerId: string, row: { name: string; genericName: string; qty: number }) {
       const current = await medicines.findOne({ ownerId, name: row.name });
       if (!current) return upsertMedicine(ownerId, row);
       await medicines.updateOne({ id: current.id }, { $set: { qty: current.qty + row.qty } });
     }
     export async function updateMedicine(id: string, input: { genericName: string }) {
       await medicines.updateOne({ id }, { $set: { genericName: input.genericName } });
     }`,
  );
  writeFileSync(
    join(project, 'src', 'validation.ts'),
    `import { z } from 'zod';
     export const medicineSchema = z.object({
       name: z.string(),
       genericName: z.string().trim().default(''),
     });`,
  );
  writeFileSync(
    join(project, 'src', 'parse.ts'),
    `export function toRow(row: Record<string, string>) {
       return { name: row['name'] ?? '', genericName: row['generic'] ?? '', qty: Number(row['qty']) };
     }
     export const COLUMNS = [
       { key: 'name', aliases: ['product'] },
       { key: 'genericName', aliases: ['generic', 'salt'] },
       { key: 'qty', aliases: ['quantity'] },
     ];`,
  );
  writeFileSync(
    join(project, 'src', 'index.ts'),
    `import './store';\nimport './validation';\nimport './parse';\n`,
  );
  const { graph } = scan({ root: project });
  const medicines = databaseReport(graph, []).collections.find((c) => c.name === 'medicines')!;
  const genericName = medicines.fields.find((field) => field.name === 'genericName')!;

  it('finds a search built in a helper, step by step — once, where the condition is written', () => {
    expect(genericName.lookups).toHaveLength(1);
    expect(genericName.lookups[0]).toMatchObject({
      in: 'listMedicines',
      match: 'search',
      builtAt: { file: 'src/store.ts', line: 8 },
    });
    expect(genericName.lookups[0]!.alsoIn.map((other) => other.operation)).toEqual([
      'medicines.find',
    ]);
  });

  it('reads the validation rules that apply to it', () => {
    expect(genericName.validation[0]).toMatchObject({
      schema: 'medicineSchema',
      library: 'zod',
      required: false,
      // The field's own line, not the schema's.
      source: { file: 'src/validation.ts', line: 4 },
    });
    expect(genericName.validation[0]!.transforms).toEqual(expect.arrayContaining(['trimmed']));
  });

  it('lists other code that sets or names it, but not the queries already shown', () => {
    const files = genericName.mentions.map((mention) => mention.source.file);
    expect(files).toContain('src/parse.ts');
    expect(files).not.toContain('src/store.ts');
    expect(files).not.toContain('src/validation.ts');
  });

  it('flags a field set only on create, and says what changes it later', () => {
    expect(genericName.onlyOnCreate.map((entry) => entry.in)).toEqual(['upsertMedicine']);
    // The reconcile path finds the record itself and only calls upsertMedicine for new ones.
    expect(genericName.onlyOnCreate[0]!.matchedFirstBy.map((entry) => entry.in)).toEqual([
      'importReconcileMedicine',
    ]);
    expect(genericName.changedBy.map((entry) => entry.in)).toEqual(['updateMedicine']);
    const qty = medicines.fields.find((field) => field.name === 'qty')!;
    expect(qty.onlyOnCreate).toEqual([]);
  });
});

describe('a save that waits for a background job', () => {
  it('names the queue worker and the writer the request goes through', () => {
    const project = mkdtempSync(join(tmpdir(), 'flowlens-database-'));
    const write = (file: string, text: string) => {
      mkdirSync(join(project, file, '..'), { recursive: true });
      writeFileSync(join(project, file), text);
    };
    write('package.json', JSON.stringify({ dependencies: { next: '15.0.0', bullmq: '5.0.0' } }));
    write(
      'lib/store.ts',
      `import { db } from './db';
       const items = db.collection('items');
       export async function upsertItem(row: { name: string; note: string; qty: number }) {
         const existing = await items.findOne({ name: row.name });
         if (existing) {
           await items.updateOne({ id: existing.id }, { $set: { qty: row.qty } });
           return;
         }
         await items.insertOne({ name: row.name, note: row.note, qty: row.qty });
       }
       export async function reconcileItem(row: { name: string; note: string; qty: number }) {
         const current = await items.findOne({ name: row.name });
         if (!current) return upsertItem(row);
         await items.updateOne({ id: current.id }, { $set: { qty: current.qty + row.qty } });
       }`,
    );
    write(
      'lib/jobs.ts',
      `import { Queue, Worker } from 'bullmq';
       import { reconcileItem } from './store';
       export const IMPORT_QUEUE = 'item-import';
       export function getImportQueue() {
         return new Queue(IMPORT_QUEUE, { connection: {} });
       }
       export async function processImport(job) {
         for (const row of job.data.rows) await reconcileItem(row);
       }
       export function startWorker() {
         return new Worker(IMPORT_QUEUE, (job) => processImport(job), { connection: {} });
       }`,
    );
    write(
      'app/api/import/route.ts',
      `import { getImportQueue } from '../../../lib/jobs';
       export async function POST(request) {
         const body = await request.json();
         const queue = getImportQueue();
         await queue.add('import', { rows: body.rows });
         return Response.json({ queued: true }, { status: 202 });
       }`,
    );
    const { graph } = scan({ root: project });
    const items = databaseReport(graph, []).collections.find((c) => c.name === 'items')!;
    const note = items.fields.find((field) => field.name === 'note')!;
    const save = note.apis
      .flatMap((api) => api.uses.map((use) => ({ endpoint: api.endpoint, use })))
      .find(({ use }) => use.does === 'saves' && use.queued)!;
    expect(save.endpoint).toMatch(/^POST \//);
    expect(save.use).toMatchObject({
      in: 'upsertItem',
      via: 'reconcileItem',
      queued: { in: 'processImport', source: { file: 'lib/jobs.ts' } },
    });
  });
});

describe('a native-driver project: its types, databases, indexes and links', () => {
  const project = mkdtempSync(join(tmpdir(), 'flowlens-database-'));
  const write = (file: string, text: string) => {
    mkdirSync(join(project, file, '..'), { recursive: true });
    writeFileSync(join(project, file), text);
  };
  write('package.json', JSON.stringify({ dependencies: { mongodb: '6.0.0', bullmq: '5.0.0' } }));
  // The database name lives in the env file, next to a credential that must never be read.
  write('.env', 'MONGODB_URI="mongodb://user:secret@host"\nAPP_DB="app-dev" # the app database\n');
  write(
    'types/index.ts',
    `export type Status = 'active' | 'inactive';
     export interface Batch { quantity: number; supplierId?: string }
     export interface Record { id: string; createdAt: string }
     export interface Item extends Record { name: string; status: Status; batches: Batch[]; extra?: { note?: string } }
     export interface Movement { id: string; itemId: string; endpointRef: string }
     export interface Endpoint { url: string }`,
  );
  write(
    'lib/mongo.ts',
    `import { MongoClient, type Db } from 'mongodb';
     import type { Item, Movement, Endpoint } from '@/types';
     const client = new MongoClient(process.env.MONGODB_URI);
     function getDb() { return client.db(process.env.APP_DB); }
     export function getOtherDb() { return client.db('shared'); }
     function raw(db: Db) {
       return {
         items: db.collection<Item>('items'),
         movements: db.collection<Movement>('movements'),
         endpoints: db.collection<Endpoint>('endpoints'),
       };
     }
     export async function ensureIndexes() {
       const { items, movements } = raw(getDb());
       await items.createIndex({ id: 1 }, { unique: true });
       await items.createIndex({ name: 1, createdAt: -1 }, { name: 'by_name' });
       await movements.createIndex({ createdAt: 1 }, { expireAfterSeconds: 3600 });
     }
     export async function getCollections() { return raw(getDb()); }`,
  );
  write(
    'lib/store.ts',
    `import { getCollections, getOtherDb } from './mongo';
     export async function sendFor(id: string) {
       const { movements, endpoints } = await getCollections();
       const movement = await movements.findOne({ id });
       return endpoints.findOne({ _id: movement.endpointRef });
     }
     export async function listShared() {
       return getOtherDb().collection('endpoints').find({}).toArray();
     }
     export async function markFailed(id: string) {
       const { items } = await getCollections();
       await items.updateOne({ id }, { $set: { status: 'inactive' } });
     }`,
  );
  write(
    'lib/jobs.ts',
    `import { Queue, Worker } from 'bullmq';
     import { markFailed } from './store';
     export const QUEUE = 'items';
     export function getQueue() { return new Queue(QUEUE, { connection: {} }); }
     export async function processItems(job) { return job.data; }
     export function start() {
       const worker = new Worker(QUEUE, (job) => processItems(job), { connection: {} });
       worker.on('failed', (job) => { markFailed(job.data.id); });
       return worker;
     }`,
  );
  write(
    'app/api/items/route.ts',
    `import { getQueue } from '../../../lib/jobs';
     export async function POST(request) {
       const queue = getQueue();
       await queue.add('item', await request.json());
       return Response.json({ queued: true });
     }`,
  );
  const { graph } = scan({ root: project });
  const report = databaseReport(graph, resolveFlows(graph, { includeLocalOnly: true }));
  const named = (name: string) => report.collections.find((entry) => entry.name === name)!;
  const field = (collection: string, name: string) =>
    named(collection).fields.find((entry) => entry.name === name);

  it('reads the TypeScript type as the schema: extends, unions, lists and objects inside', () => {
    expect(named('items')).toMatchObject({ model: 'Item', typed: true });
    expect(field('items', 'createdAt')).toMatchObject({ type: 'string', origin: 'declared' });
    expect(field('items', 'status')).toMatchObject({
      type: "'active' | 'inactive'",
      required: true,
    });
    expect(field('items', 'batches[].quantity')).toMatchObject({ type: 'number' });
    expect(field('items', 'extra')?.type).toBe('object');
    expect(field('items', 'extra.note')?.required).toBeUndefined();
  });

  it('names the database each collection and each query is in', () => {
    expect(named('items').databases).toEqual([
      { name: 'APP_DB', env: true, value: 'app-dev', from: '.env' },
    ]);
    expect(JSON.stringify(graph.toJSON())).not.toContain('secret');
    expect(
      named('endpoints')
        .databases?.map((db) => db.name)
        .sort(),
    ).toEqual(['APP_DB', 'shared']);
    const ops = named('endpoints').operations.map((op) => [op.method, op.databaseName?.name]);
    expect(ops).toContainEqual(['listShared', 'shared']);
    expect(ops).toContainEqual(['sendFor', 'APP_DB']);
    expect(named('endpoints').notes.join(' ')).toMatch(/2 databases/);
  });

  it('reads the indexes the code creates: unique, compound and TTL', () => {
    expect(named('items').indexes).toHaveLength(2);
    expect(field('items', 'id')).toMatchObject({ unique: true, indexed: true });
    expect(field('items', 'name')).toMatchObject({ indexed: true });
    expect(field('items', 'createdAt')?.indexed).toBeUndefined();
    expect(field('movements', 'createdAt')?.expiresAfterSeconds).toBe(3600);
  });

  it('links collections by a typed field name, and by an id a query looks up', () => {
    expect(named('movements').references).toContainEqual(
      expect.objectContaining({ field: 'itemId', to: 'items', via: 'naming' }),
    );
    expect(named('movements').references).toContainEqual(
      expect.objectContaining({ field: 'endpointRef', to: 'endpoints', via: 'query' }),
    );
  });

  it('lists what a change does to the database: collections, fields, indexes, links', () => {
    expect(hasDatabaseChanges(databaseChanges(graph, graph))).toBe(false);
    const other = mkdtempSync(join(tmpdir(), 'flowlens-database-'));
    mkdirSync(join(other, 'lib'), { recursive: true });
    writeFileSync(
      join(other, 'lib', 'mongo.ts'),
      `import type { Item } from './types';
       export interface Item { id: string; sku: string }
       export async function run(db) {
         const items = db.collection<Item>('items');
         await items.createIndex({ sku: 1 }, { unique: true });
         return items.find({ sku: 'a' }).toArray();
       }`,
    );
    const changes = databaseChanges(graph, scan({ root: other }).graph);
    expect(changes.collections.removed).toEqual(['endpoints', 'movements']);
    expect(changes.fields.added).toContain('items.sku');
    expect(changes.fields.removed).toContain('items.status');
    expect(changes.indexes.added).toEqual(['items: sku 1 (unique)']);
    expect(changes.links.removed).toContain('movements.itemId → items');
  });

  it("counts a worker's failure handler as part of the job", () => {
    const failed = named('items').scenarios.find((scenario) => scenario.id.includes('markFailed'));
    expect(failed?.endpoint).toMatch(/^POST \//);
  });
});

describe('values worked out by helpers, records inside arrays, and read-only fields', () => {
  const project = mkdtempSync(join(tmpdir(), 'flowlens-database-'));
  const write = (file: string, text: string) => {
    mkdirSync(join(project, file, '..'), { recursive: true });
    writeFileSync(join(project, file), text);
  };
  write(
    'src/store.ts',
    `import { db } from './db';
     import { userForPhone } from './users';
     const items = db.collection('items');
     const users = db.collection('users');
     function newBatch(input: { mrp: number; billNo: string }, quantity: number) {
       return { mrp: input.mrp, billNo: input.billNo, quantity };
     }
     function syncFromBatches(m: { batches: Array<{ mrp: number; quantity: number }> }) {
       const stock = m.batches.reduce((sum, b) => sum + b.quantity, 0);
       const first = m.batches[0];
       return { ...m, stock, price: first.mrp };
     }
     export async function addItem(input: { name: string; mrp: number; billNo: string; qty: number }) {
       const batches = input.qty > 0 ? [newBatch(input, input.qty)] : [];
       const created = syncFromBatches({ name: input.name, batches, stock: 0, price: 0 });
       await items.insertOne({ ...created });
     }
     export async function addPerson(phone: string) {
       const base = userForPhone(phone);
       await users.insertOne({ ...base, createdAt: new Date() });
     }
     export async function names() {
       return items.find({}, { projection: { label: 1 } }).toArray();
     }`,
  );
  write(
    'src/users.ts',
    `export function userForPhone(phone: string) {
       return { id: phone.slice(-6), phone, role: 'staff' };
     }`,
  );
  write('src/index.ts', `import './store';\nimport './users';\n`);
  const { graph } = scan({ root: project });
  const report = databaseReport(graph, []);
  const items = report.collections.find((c) => c.name === 'items')!;
  const field = (name: string) => items.fields.find((entry) => entry.name === name);

  it('reads a value a helper works out, over the placeholder it was given', () => {
    const stock = field('stock')!;
    expect(stock.writes).toHaveLength(1);
    expect(stock.writes[0]).toMatchObject({
      derivedIn: 'syncFromBatches',
      derivedFrom: ['batches[].quantity'],
      from: 'computed',
    });
    expect(field('price')!.writes[0]!.derivedFrom).toEqual(['batches[].mrp']);
  });

  it('opens an array of records into its own fields', () => {
    expect(field('batches[].mrp')!.writes[0]).toMatchObject({ value: 'input.mrp', from: 'input' });
    expect(field('batches[].billNo')).toBeDefined();
    expect(field('batches[].quantity')).toBeDefined();
  });

  it('follows a spread of a record built by a helper in another file', () => {
    const users = report.collections.find((c) => c.name === 'users')!;
    expect(users.fields.map((entry) => entry.name).sort()).toEqual([
      'createdAt',
      'id',
      'phone',
      'role',
    ]);
  });

  it('lists a field a read asks for by name', () => {
    expect(field('label')!.projected[0]).toMatchObject({ in: 'names' });
  });
});

describe('scenarios, read from the branches around each write', () => {
  const project = mkdtempSync(join(tmpdir(), 'flowlens-database-'));
  const write = (file: string, text: string) => {
    mkdirSync(join(project, file, '..'), { recursive: true });
    writeFileSync(join(project, file), text);
  };
  write('package.json', JSON.stringify({ dependencies: { next: '15.0.0' } }));
  write(
    'lib/store.ts',
    `import { db } from './db';
     const items = db.collection('items');
     async function findDuplicate(name: string) {
       return items.findOne({ name });
     }
     export async function upsertItem(input: { name: string; note: string; qty: number }) {
       const existing = await findDuplicate(input.name);
       if (existing) {
         await items.updateOne({ id: existing.id }, { $set: { qty: existing.qty + input.qty } });
         return;
       }
       await items.insertOne({ name: input.name, note: input.note, qty: input.qty });
     }
     export async function updateItem(id: string, input: { note: string }) {
       await items.updateOne({ id }, { $set: { note: input.note } });
     }
     export async function deleteItem(id: string) {
       await items.deleteOne({ id });
     }
     export async function backfill() {
       await items.updateMany({}, { $set: { qty: 0 } });
     }`,
  );
  write(
    'app/api/items/route.ts',
    `import { upsertItem } from '../../../lib/store';
     export async function POST(request) {
       const body = await request.json();
       await upsertItem(body);
       return Response.json({ ok: true });
     }`,
  );
  write(
    'app/api/items/[id]/route.ts',
    `import { updateItem, deleteItem } from '../../../../lib/store';
     export async function PUT(request, { params }) {
       await updateItem(params.id, await request.json());
       return Response.json({ ok: true });
     }
     export async function DELETE(request, { params }) {
       await deleteItem(params.id);
       return Response.json({ ok: true });
     }`,
  );
  const { graph } = scan({ root: project });
  const items = databaseReport(graph, []).collections.find((c) => c.name === 'items')!;
  const note = items.fields.find((field) => field.name === 'note')!;
  const outcome = (match: (s: (typeof items.scenarios)[number]) => boolean) =>
    note.outcomes[items.scenarios.findIndex(match)]?.does;

  it('splits one request into a case per branch, adds first and scripts last', () => {
    const post = items.scenarios.filter((s) => s.endpoint?.startsWith('POST'));
    expect(post).toHaveLength(2);
    expect(post.map((s) => s.when.map((c) => `${c.holds}:${c.from}`))).toEqual([
      ['false:findDuplicate'],
      ['true:findDuplicate'],
    ]);
    // In plain words, from what the variable was made from.
    expect(post.map((s) => s.when[0]!.words)).toEqual([
      'no matching record is found',
      'a matching record exists',
    ]);
    expect(items.scenarios.at(-1)!.script?.in).toBe('backfill');
  });

  it('says what each case does to a field', () => {
    expect(outcome((s) => s.endpoint?.startsWith('POST') === true && !s.when[0]!.holds)).toBe(
      'sets',
    );
    expect(outcome((s) => s.endpoint?.startsWith('POST') === true && s.when[0]!.holds)).toBe(
      'keeps',
    );
    expect(outcome((s) => s.endpoint?.startsWith('PUT') === true)).toBe('sets');
    expect(outcome((s) => s.endpoint?.startsWith('DELETE') === true)).toBe('removed');
    expect(outcome((s) => s.script !== undefined)).toBe('keeps');
  });
});

describe('cases where lists change in place, values go stale, or nothing is written', () => {
  const project = mkdtempSync(join(tmpdir(), 'flowlens-database-'));
  const write = (file: string, text: string) => {
    mkdirSync(join(project, file, '..'), { recursive: true });
    writeFileSync(join(project, file), text);
  };
  write('package.json', JSON.stringify({ dependencies: { next: '15.0.0' } }));
  write(
    'lib/store.ts',
    `import { db } from './db';
     import { reorder } from 'some-list-package';
     const items = db.collection('items');
     const logs = db.collection('logs');
     function addToBatches(m: { batches: Array<{ qty: number; price: number }> }, n: number) {
       const last = m.batches[m.batches.length - 1];
       return [...m.batches.slice(0, -1), { ...last, qty: last.qty + n }];
     }
     function sync(m: { batches: Array<{ qty: number; price: number }> }) {
       const total = m.batches.reduce((sum, b) => sum + b.qty, 0);
       return { ...m, total, price: m.batches[0].price };
     }
     export async function create(input: { name: string; qty: number; price: number }) {
       const created = sync({ name: input.name, batches: [{ qty: input.qty, price: input.price }], total: 0, price: 0 });
       await items.insertOne({ ...created });
     }
     export async function adjust(id: string, n: number) {
       const item = await items.findOne({ id });
       if (!item) return;
       const batches = addToBatches(item, n);
       const updated = sync({ ...item, batches });
       await items.updateOne({ id }, { $set: { batches: updated.batches, total: updated.total } });
     }
     export async function check(id: string, guess: string) {
       const doc = await items.findOne({ id });
       if (doc.code !== guess) {
         await items.updateOne({ id }, guess.length > 3 ? { $set: { tries: 1, code: '' } } : { $set: { tries: 1 } });
         return false;
       }
       await items.updateOne({ id }, { $set: { code: '' } });
       return true;
     }
     export async function touch(id: string, name?: string) {
       await items.updateOne({ id }, { $set: { seen: 1, ...(name ? { name } : {}) } });
     }
     export async function backfill(rows: Array<{ id: string; kind: string }>) {
       await items.bulkWrite(rows.map((r) => ({ updateOne: { filter: { id: r.id }, update: { $set: { kind: r.kind } } } })));
     }
     export async function shuffle(id: string) {
       const item = await items.findOne({ id });
       const batches = reorder(item.batches);
       await items.updateOne({ id }, { $set: { batches } });
     }
     export async function reconcile(id: string, qty: number, date?: string) {
       const item = await items.findOne({ id });
       if (date) await items.updateOne({ id }, { $set: { date } });
       if (item.qty === qty) return 'unchanged';
       await items.updateOne({ id }, { $set: { qty } });
     }
     export async function log(id: string) {
       await logs.insertOne({ id });
     }`,
  );
  write(
    'app/api/items/route.ts',
    `import { create } from '../../../lib/store';
     export async function POST(request) {
       await create(await request.json());
       return Response.json({ ok: true });
     }`,
  );
  write(
    'app/api/adjust/route.ts',
    `import { adjust } from '../../../lib/store';
     export async function POST(request) {
       const body = await request.json();
       await adjust(body.id, body.n);
       return Response.json({ ok: true });
     }`,
  );
  write(
    'app/api/check/route.ts',
    `import { check, log } from '../../../lib/store';
     export async function POST(request) {
       const body = await request.json();
       const ok = await check(body.id, body.guess);
       if (!ok) return Response.json({ ok: false }, { status: 401 });
       await log(body.id);
       return Response.json({ ok: true });
     }`,
  );
  write(
    'app/api/reconcile/route.ts',
    `import { reconcile } from '../../../lib/store';
     export async function POST(request) {
       const body = await request.json();
       await reconcile(body.id, body.qty, body.date);
       return Response.json({ ok: true });
     }`,
  );
  write(
    'app/api/shuffle/route.ts',
    `import { shuffle } from '../../../lib/store';
     export async function POST(request) {
       const body = await request.json();
       await shuffle(body.id);
       return Response.json({ ok: true });
     }`,
  );
  write(
    'app/api/touch/route.ts',
    `import { touch } from '../../../lib/store';
     export async function POST(request) {
       const body = await request.json();
       await touch(body.id, body.name);
       return Response.json({ ok: true });
     }`,
  );
  const { graph } = scan({ root: project });
  const items = databaseReport(graph, []).collections.find((c) => c.name === 'items')!;
  const field = (name: string) => items.fields.find((entry) => entry.name === name)!;
  const outcome = (name: string, match: (s: (typeof items.scenarios)[number]) => boolean) =>
    field(name).outcomes[items.scenarios.findIndex(match)];
  const adjusting = (s: (typeof items.scenarios)[number]) =>
    s.endpoint === 'POST /adjust' && !s.nothing;

  it('reads what a helper that rebuilds a list does to its items', () => {
    // `{ ...last, qty: last.qty + n }` in `addToBatches`: added to, not set.
    expect(outcome('batches[].qty', adjusting)?.does).toBe('adds');
    // A list rebuilt by code it cannot open (a package) changes as a whole.
    expect(outcome('batches[].qty', (s) => s.endpoint === 'POST /shuffle')).toMatchObject({
      does: 'list-changed',
    });
  });

  it('flags a value the helper recalculates but the save leaves out', () => {
    expect(outcome('price', adjusting)).toMatchObject({ does: 'stale', by: ['sync'] });
    expect(outcome('total', adjusting)?.does).toBe('recalculated');
  });

  it('turns an early return before any write into a nothing-written case', () => {
    const nothing = items.scenarios.find((s) => s.endpoint === 'POST /adjust' && s.nothing)!;
    expect(nothing.when[0]).toMatchObject({ holds: false, from: 'findOne' });
  });

  it('counts an exit after a write under an `if` as nothing written when that `if` was false', () => {
    const unchanged = items.scenarios.find((s) => s.endpoint === 'POST /reconcile' && s.nothing)!;
    expect(unchanged.when.map((c) => `${c.holds}:${c.code}`)).toEqual([
      'true:item.qty === qty',
      'false:date',
    ]);
  });

  it('reads both sides of a conditional update, and of a conditional spread', () => {
    const wrong = (s: (typeof items.scenarios)[number]) =>
      s.endpoint === 'POST /check' && s.returns === 'falsy';
    expect(outcome('tries', wrong)?.does).toBe('sets');
    // `...(name ? { name } : {})`: set only when there is a name.
    expect(field('name').writes.find((w) => w.in === 'touch')?.onlyWhen).toBe('`name`');
    expect(items.scenarios.every((s) => s.kind === (s.endpoint ? 'request' : 'script'))).toBe(true);
  });

  it('reads the writes inside a bulkWrite over a map', () => {
    expect(field('kind').writes[0]).toMatchObject({ in: 'backfill', value: 'r.kind' });
  });

  it('keeps a write that waits on a result out of the cases that do not give it', () => {
    const check = items.scenarios.filter((s) => s.endpoint === 'POST /check' && !s.nothing);
    expect(check.find((s) => s.returns === 'falsy')!.alsoWrites).toEqual([]);
    expect(check.find((s) => s.returns === 'truthy')!.alsoWrites).toEqual(['logs']);
  });
});

describe('conditions, simplified and in plain words', () => {
  const A = { code: 'primaryIdx >= 0', holds: true, words: 'a primary batch is found' };
  const notA = { ...A, holds: false, words: 'no primary batch is found' };
  const B = { code: 'newQty > 0', holds: true, words: 'the quantity is more than 0' };

  it('turns (not A and B) or A into A or B, and A or not A into always', () => {
    expect(render(simplify([[notA, B], [A]])).words).toBe(
      'the quantity is more than 0, or a primary batch is found',
    );
    expect(render(simplify([[A], [notA]]))).toEqual({});
  });

  it('drops a comparison a stronger one on the same values already says', () => {
    const less = { code: 'delta < 0', holds: true, words: 'less' };
    const notMore = { code: 'delta > 0', holds: false, words: 'at most' };
    expect(simplify([[notMore, less]])).toEqual([[less]]);
  });
});
