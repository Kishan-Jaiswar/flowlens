import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  explainAction,
  renderActionDocument,
  resolveFlows,
  scan,
  type ActionDoc,
  type ActionStage,
} from '@flowslens/core';
import { exampleScan } from './helpers.js';

/**
 * The Docs tab: one action, documented from the page to the database and back.
 *
 * The document is a claim about code a reader will not open, so the facts in it
 * are what these tests pin — that the child form's own handler is found before
 * the prop it calls, that the schema's rules and messages come through, that a
 * guard's statuses are followed into the helper that answers them, and that
 * the success and failure paths end up on the right side.
 */

const project = mkdtempSync(join(tmpdir(), 'flowlens-action-'));
const write = (rel: string, text: string): void => {
  mkdirSync(join(project, rel, '..'), { recursive: true });
  writeFileSync(join(project, rel), text, 'utf8');
};

write('tsconfig.json', JSON.stringify({ compilerOptions: { paths: { '@/*': ['./*'] } } }));

write(
  'lib/validation.ts',
  `import { z } from "zod";
   export const productSchema = z.object({
     name: z.string().trim().min(2, "Name is required"),
     price: z.coerce.number().min(0, "Must be ≥ 0"),
     note: z.string().optional(),
   });`,
);

write(
  'lib/api/client.ts',
  `import axios from "axios";
   import { getToken } from "./token";
   export const apiClient = axios.create({ baseURL: "/api", headers: { "Content-Type": "application/json" } });
   apiClient.interceptors.request.use((config) => {
     const token = getToken();
     if (token) config.headers.Authorization = \`Bearer \${token}\`;
     return config;
   });`,
);

write(
  'features/products/api.ts',
  `import { useMutation, useQueryClient } from "@tanstack/react-query";
   import { apiClient } from "@/lib/api/client";
   export function useCreateProduct() {
     const qc = useQueryClient();
     return useMutation({
       mutationFn: async (input) => {
         const { data } = await apiClient.post<{ product: Product; action: "added" | "updated" }>("/products", input);
         return data;
       },
       onSuccess: () => {
         qc.invalidateQueries({ queryKey: ["products"] });
       },
     });
   }`,
);

write(
  'features/products/product-form.tsx',
  `import { useState } from "react";
   import { productSchema } from "@/lib/validation";
   export function ProductForm({ onSubmit, submitting }) {
     const [values, setValues] = useState({ name: "", price: "", note: "" });
     const [errors, setErrors] = useState({});
     const handleSubmit = (e) => {
       e.preventDefault();
       const parsed = productSchema.safeParse(values);
       if (!parsed.success) {
         setErrors({ form: "invalid" });
         return;
       }
       onSubmit(parsed.data);
     };
     return (
       <form onSubmit={handleSubmit}>
         <Field label="Product name" required>
           <input value={values.name} onChange={(e) => setValues({ ...values, name: e.target.value })} />
         </Field>
         <Field label="Price">
           <input value={values.price} onChange={(e) => setValues({ ...values, price: e.target.value })} />
         </Field>
         <button type="submit" disabled={submitting}>Save product</button>
       </form>
     );
   }`,
);

write(
  'features/products/add-product-dialog.tsx',
  `import { ProductForm } from "@/features/products/product-form";
   import { useCreateProduct } from "@/features/products/api";
   import { useToast } from "@/components/toast";
   export function AddProductDialog({ onClose }) {
     const { toast } = useToast();
     const create = useCreateProduct();
     const onSubmit = (values) => {
       create.mutate(values, {
         onSuccess: () => {
           toast({ variant: "success", title: "Product added" });
           onClose();
         },
         onError: () => toast({ variant: "error", title: "Could not save" }),
       });
     };
     return <ProductForm submitting={create.isPending} onSubmit={onSubmit} />;
   }`,
);

write(
  'components/toast.tsx',
  `import { createContext, useContext } from "react";
   const ToastContext = createContext(null);
   export function useToast() { return useContext(ToastContext); }`,
);

write(
  'app/(app)/products/page.tsx',
  `import { useState } from "react";
   import { AddProductDialog } from "@/features/products/add-product-dialog";
   export default function ProductsPage() {
     const [addOpen, setAddOpen] = useState(false);
     return (
       <div>
         <button onClick={() => setAddOpen(true)}>Add product</button>
         {addOpen && <AddProductDialog onClose={() => setAddOpen(false)} />}
       </div>
     );
   }`,
);

write(
  'lib/api/server.ts',
  `export function apiError(message, status = 400) {
     return Response.json({ error: message }, { status });
   }
   export function unauthorized() { return apiError("Unauthorized", 401); }
   export async function requireUser(request) {
     const header = request.headers.get("authorization");
     if (!header) return { error: unauthorized() };
     if (!header.includes("admin")) return { error: apiError("Admins only", 403) };
     return { user: { name: "a" } };
   }`,
);

write(
  'lib/db/mongo.ts',
  `export async function getCollections() {
     const db = await getDb();
     return { products: db.collection('products') };
   }`,
);

write(
  'lib/db/store.ts',
  `import { getCollections } from './mongo';
   export async function upsertProduct(input) {
     const { products } = await getCollections();
     const existing = await products.findOne({ name: input.name });
     if (existing) {
       await products.updateOne({ _id: existing._id }, { $set: { price: input.price } });
       return { product: existing, action: "updated" };
     }
     const doc = { name: input.name, price: input.price, createdAt: new Date() };
     await products.insertOne(doc);
     return { product: doc, action: "added" };
   }`,
);

write(
  'app/api/products/route.ts',
  `import { apiError, requireUser } from "@/lib/api/server";
   import { upsertProduct } from "@/lib/db/store";
   import { productSchema } from "@/lib/validation";
   export async function POST(request) {
     const ctx = await requireUser(request);
     if ("error" in ctx) return ctx.error;
     const body = await request.json();
     const parsed = productSchema.safeParse(body);
     if (!parsed.success) return apiError("Validation failed", 422);
     const result = await upsertProduct(parsed.data);
     return Response.json(result, { status: result.action === "added" ? 201 : 200 });
   }`,
);

write(
  'proxy.ts',
  `export function proxy(request) { return null; }
   export const config = { matcher: ["/((?!api|_next/static).*)"] };`,
);

// A trash icon beside a filter drawer: the drawer's draft is not a form for the delete.
write(
  'lib/swal.ts',
  `import Swal from "sweetalert2";
   export async function confirmDelete(options) {
     const result = await Swal.fire({
       title: options?.title ?? "Are you sure?",
       showCancelButton: true,
       confirmButtonText: options?.confirmText ?? "Yes, delete it",
     });
     return result.isConfirmed;
   }`,
);

write(
  'features/products/delete.ts',
  `import { useMutation } from "@tanstack/react-query";
   import { apiClient } from "@/lib/api/client";
   export function useDeleteProduct() {
     return useMutation({
       mutationFn: async (id) => {
         await apiClient.delete(\`/products/\${id}\`);
       },
     });
   }`,
);

write(
  'app/(app)/catalog/page.tsx',
  `"use client";
   import { useState } from "react";
   import { confirmDelete } from "@/lib/swal";
   import { useDeleteProduct } from "@/features/products/delete";
   export default function CatalogView({ products }) {
     const [draft, setDraft] = useState({ category: "", supplier: "", expiring: false });
     const remove = useDeleteProduct();
     const handleDelete = async (product) => {
       const ok = await confirmDelete({ title: "Delete product?" });
       if (!ok) return;
       remove.mutate(product.id);
     };
     return (
       <div>
         <label htmlFor="category">Category</label>
         <input id="category" value={draft.category} onChange={(e) => setDraft({ ...draft, category: e.target.value })} />
         {products.map((p) => (
           <button key={p.id} onClick={() => handleDelete(p)}>Delete</button>
         ))}
       </div>
     );
   }`,
);

const scanned = scan({ root: project });
const flows = resolveFlows(scanned.graph, { includeLocalOnly: true });
const submit = flows.find((flow) => flow.component === 'AddProductDialog' && flow.hitsBackend);

function stage(doc: ActionDoc, key: ActionStage['key']): ActionStage {
  const found = doc.stages.find((candidate) => candidate.key === key);
  if (!found) throw new Error(`no stage ${key}`);
  return found;
}

/** Every line of a stage, sub-lines included, as plain text. */
function text(found: ActionStage): string {
  return found.groups
    .flatMap((group) => [
      group.label,
      ...group.lines.flatMap((line) => [line.text, ...(line.sub ?? []).map((sub) => sub.text)]),
      ...(group.table?.rows ?? []).map((row) => row.cells.join(' | ')),
    ])
    .join('\n');
}

/** The table rows of a stage, one string per row. */
function rows(found: ActionStage): string[] {
  return found.groups.flatMap((group) =>
    (group.table?.rows ?? []).map((row) => row.cells.join(' | ')),
  );
}

describe('an action document', () => {
  it('finds the submit action on a form that lives in a child component', () => {
    expect(submit).toBeDefined();
    expect(submit!.endpoints).toContain('POST /products');
  });

  const doc = explainAction(scanned.graph, submit!);

  it('has the nineteen stages, in order, every time, each with a one-line summary', () => {
    expect(doc.stages.map((entry) => entry.n)).toEqual(Array.from({ length: 19 }, (_, i) => i + 1));
    expect(doc.stages[0]!.key).toBe('open');
    expect(doc.stages.at(-1)!.key).toBe('final-ui');
    for (const entry of doc.stages) expect(entry.summary.length).toBeGreaterThan(0);
  });

  it('groups the stages by where they happen, in round-trip order', () => {
    const phases = doc.stages.map((entry) => entry.phase);
    expect([...new Set(phases)]).toEqual(['browser', 'wire', 'server', 'database', 'back']);
    expect(stage(doc, 'guards').phase).toBe('server');
  });

  it('knows which page the dialog sits on and what opens it', () => {
    const open = text(stage(doc, 'open'));
    expect(open).toContain('/products');
    expect(open).toContain('Add product');
    expect(open).toContain('setAddOpen(true)');
    expect(stage(doc, 'open').summary).toContain('"Add product"');
  });

  it('lists the form fields under the labels the user sees', () => {
    const fields = rows(stage(doc, 'form'));
    expect(
      fields.some(
        (row) => row.includes('`name`') && row.includes('Product name') && row.includes('yes'),
      ),
    ).toBe(true);
    expect(text(stage(doc, 'form'))).toContain('useToast');
    expect(stage(doc, 'form').summary).toContain('required: "Product name"');
  });

  it('runs the child form handler before the prop it calls', () => {
    const handlers = stage(doc, 'handlers').groups.map((group) => group.label);
    expect(handlers[0]).toContain('ProductForm.handleSubmit');
    expect(handlers[1]).toContain('AddProductDialog.onSubmit');
    expect(handlers.some((label) => label.includes('mutationFn'))).toBe(true);
    expect(stage(doc, 'handlers').summary).toBe('`handleSubmit` → `onSubmit` → `mutationFn`');
    expect(doc.trigger).toContain('Save product');
  });

  it('shows the check that stops the submit and the schema rules with their messages', () => {
    const validation = text(stage(doc, 'frontend-validation'));
    expect(validation).toContain('!parsed.success');
    expect(validation).toContain('productSchema');
    expect(validation).toContain('"Name is required"');
    expect(validation).toContain('at least 2 characters');
  });

  it('traces the payload back through the handlers to the form state', () => {
    const payload = rows(stage(doc, 'payload'));
    const name = payload.find((row) => row.startsWith('`name`'))!;
    expect(name).toContain('`values.name`');
    expect(name).toContain('trimmed');
    expect(payload.find((row) => row.startsWith('`note`'))).toContain('only if filled in');
    expect(text(stage(doc, 'payload'))).toContain('productSchema.safeParse(values)');
  });

  it('reads the real URL and the headers the interceptor adds', () => {
    const request = text(stage(doc, 'request'));
    expect(request).toContain('`/api/products`');
    const headers = rows(stage(doc, 'request'));
    expect(
      headers.some((row) => row.startsWith('`Content-Type`') && row.includes('client default')),
    ).toBe(true);
    expect(
      headers.some((row) => row.startsWith('`Authorization`') && row.includes('`token`')),
    ).toBe(true);
    expect(request).toContain('action: "added" | "updated"');
  });

  it('follows a guard into its helpers to find the statuses it answers with', () => {
    const guards = rows(stage(doc, 'guards'));
    expect(
      guards.some(
        (row) =>
          row.includes('Authentication') &&
          row.includes('**401**') &&
          row.includes('"Unauthorized"'),
      ),
    ).toBe(true);
    expect(
      guards.some(
        (row) =>
          row.includes('Authorization') && row.includes('**403**') && row.includes('"Admins only"'),
      ),
    ).toBe(true);
    expect(text(stage(doc, 'guards'))).toContain('excludes `/api`');
    expect(stage(doc, 'guards').summary).toContain('401 · 403');
  });

  it('notices that the backend checks the body with the same schema', () => {
    const backend = text(stage(doc, 'backend-validation'));
    expect(backend).toContain('**422** "Validation failed"');
    expect(backend).toContain('Same schema as Frontend validation');
  });

  it('says which write runs under which condition', () => {
    const service = rows(stage(doc, 'service'));
    expect(service.some((row) => row.includes('`products.findOne`'))).toBe(true);
    expect(service.find((row) => row.includes('`products.updateOne`'))).toContain(
      'when `existing`',
    );
    expect(service.find((row) => row.includes('`products.insertOne`'))).toContain(
      'after `existing` was false',
    );
  });

  it('reports every status the route can answer with', () => {
    const response = rows(stage(doc, 'response'));
    expect(response.find((row) => row.startsWith('**201 or 200**'))).toContain(
      '{ product, action }',
    );
    for (const status of ['401', '403', '422']) {
      expect(response.some((row) => row.startsWith(`**${status}**`))).toBe(true);
    }
    expect(stage(doc, 'response').summary).toBe(
      '**200, 201** on success · **401, 403, 422** on failure',
    );
  });

  it('puts the toast and the close on success, and the error toast on failure', () => {
    const handler = stage(doc, 'response-handler');
    const success = handler.groups.find((group) => group.label === 'On success')!;
    const failure = handler.groups.find((group) => group.label === 'On error')!;
    expect(success.tone).toBe('ok');
    expect(failure.tone).toBe('error');
    const cells = (group: typeof success): string[] =>
      group.table!.rows.map((row) => row.cells.join(' | '));
    expect(
      cells(success).some((row) => row.startsWith('toast') && row.includes('"Product added"')),
    ).toBe(true);
    expect(
      cells(success).some((row) => row.startsWith('closes dialog') && row.includes('onClose()')),
    ).toBe(true);
    expect(cells(success).some((row) => row.includes('invalidateQueries'))).toBe(true);
    expect(cells(failure).some((row) => row.includes('"Could not save"'))).toBe(true);

    const final = stage(doc, 'final-ui');
    const failed = final.groups.find((group) => group.label === 'After a failed response')!;
    expect(failed.lines.some((line) => line.text.includes('stays open'))).toBe(true);
    expect(final.summary).toContain('the dialog closes');
  });

  it('renders as Markdown: the flow at a glance first, then every stage with tables', () => {
    const markdown = renderActionDocument(doc);
    const glance = markdown.indexOf('## At a glance');
    const detail = markdown.indexOf('## In detail');
    expect(glance).toBeGreaterThan(0);
    expect(detail).toBeGreaterThan(glance);
    expect(markdown).toContain('IN THE BROWSER');
    expect(markdown).toContain('#### 1. User opens page');
    expect(markdown).toContain('#### 18. Final UI state');
    expect(markdown).toContain('| Field | Comes from | Changed before sending | Sent |');
    expect(markdown).toMatch(/route\.ts:\d+/);
  });
});

describe('an action document for a delete behind a confirmation dialog', () => {
  const remove = flows.find(
    (flow) =>
      flow.component === 'CatalogView' && flow.endpoints.includes('DELETE /products/:param'),
  );
  const doc = explainAction(scanned.graph, remove!);

  it('finds the delete action', () => {
    expect(remove).toBeDefined();
  });

  it('does not call the page state the handler never reads a form', () => {
    const form = stage(doc, 'form');
    expect(form.summary).toBe('Nothing to fill in — a click and a confirmation');
    expect(rows(form).some((row) => row.includes('category'))).toBe(false);
  });

  it('names the dialog and its confirm button in the headline', () => {
    expect(doc.trigger).toBe('clicks "Delete", then confirms "Yes, delete it"');
    expect(stage(doc, 'trigger').summary).toBe('The user clicks **"Delete"**');
  });

  it('shows the dialog as its own step between the click and the request', () => {
    const confirm = stage(doc, 'confirm');
    expect(confirm.absent).toBeUndefined();
    expect(confirm.summary).toContain('**"Delete product?"** pops up');
    expect(confirm.summary).toContain('**"Yes, delete it"** to go ahead');
    const body = text(confirm);
    expect(body).toContain('confirmDelete');
    expect(body).toContain('**"Cancel"** → stops at `!ok`');
    const keys = doc.stages.filter((entry) => !entry.absent).map((entry) => entry.key);
    expect(keys.indexOf('confirm')).toBe(keys.indexOf('trigger') + 1);
    expect(keys.indexOf('handlers')).toBe(keys.indexOf('confirm') + 1);
  });

  it('marks the steps a delete does not have, and the Markdown leaves them out', () => {
    const absent = doc.stages.filter((entry) => entry.absent).map((entry) => entry.key);
    expect(absent).toEqual(expect.arrayContaining(['form', 'frontend-validation', 'payload']));
    expect(absent).not.toContain('trigger');
    expect(absent).not.toContain('request');
    const markdown = renderActionDocument(doc);
    expect(markdown).not.toContain('. User fills form');
    expect(markdown).toContain('**Not in this action**');
    expect(markdown).toContain('- User fills form — Nothing to fill in');
    const shown = doc.stages.length - absent.length;
    expect(markdown).toContain(`#### ${shown}. Final UI state`);
  });

  it('reports the cancel as the user choosing, not as a failed validation', () => {
    const validation = stage(doc, 'frontend-validation');
    expect(validation.summary).toContain('only the confirmation');
    expect(rows(validation)).toEqual([]);
    expect(text(stage(doc, 'final-ui'))).toContain('The user cancels the dialog');
  });
});

describe('an action document for a NestJS backend', () => {
  const example = exampleScan();
  const create = resolveFlows(example.graph).find((flow) => flow.title === 'Create Customer')!;
  const doc = explainAction(example.graph, create);

  it('reads the DTO and its decorators as the backend validation', () => {
    const backend = text(stage(doc, 'backend-validation'));
    expect(backend).toContain('CreateCustomerDto');
    expect(backend).toContain('@IsString');
  });

  it('says so when a route has no guard, rather than dropping the stage', () => {
    const guards = stage(doc, 'guards');
    expect(guards.summary).toContain('No auth check');
    expect(text(guards)).toContain('Anyone who can reach it can call it');
  });

  it('follows each payload field back to the state it came from', () => {
    const payload = rows(stage(doc, 'payload'));
    expect(payload.find((row) => row.startsWith('`name`'))).toContain('`name` _(state)_');
  });
});
