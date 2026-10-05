import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { flowPages, resolveFlows, scan } from '@flowslens/core';

/**
 * The sidebar groups actions by the page they are on, so the page has to be
 * the one the user meets the action on — not the folder its code lives in.
 */

const project = mkdtempSync(join(tmpdir(), 'flowlens-pages-'));
const write = (rel: string, text: string): void => {
  mkdirSync(join(project, rel, '..'), { recursive: true });
  writeFileSync(join(project, rel), text, 'utf8');
};

write(
  'features/products/product-form.tsx',
  `export function ProductForm() {
     return <button onClick={() => fetch("/api/products", { method: "POST" })}>Save product</button>;
   }`,
);
write(
  'features/products/add-product-dialog.tsx',
  `import { ProductForm } from "./product-form";
   export function AddProductDialog() {
     return <div><ProductForm /><button onClick={() => fetch("/api/drafts", { method: "POST" })}>Save draft</button></div>;
   }`,
);
write(
  'app/(app)/products/page.tsx',
  `import { AddProductDialog } from "@/features/products/add-product-dialog";
   export default function ProductsPage() {
     return <div><button onClick={() => fetch("/api/products/refresh", { method: "POST" })}>Refresh</button><AddProductDialog /></div>;
   }`,
);
write(
  'app/(app)/products/[id]/edit/page.tsx',
  `import { ProductForm } from "@/features/products/product-form";
   export default function EditProductPage() {
     return <ProductForm />;
   }`,
);
write(
  'features/auth/session-banner.tsx',
  `export function SessionBanner() {
     return <button onClick={() => fetch("/api/logout", { method: "POST" })}>Log out</button>;
   }`,
);
write(
  'app/layout.tsx',
  `import { SessionBanner } from "@/features/auth/session-banner";
   export default function RootLayout({ children }) {
     return <html><body><SessionBanner />{children}</body></html>;
   }`,
);
write(
  'features/orphan/orphan-button.tsx',
  `export function OrphanButton() {
     return <button onClick={() => fetch("/api/orphan", { method: "POST" })}>Nobody renders me</button>;
   }`,
);

const { graph } = scan({ root: project });
const flows = resolveFlows(graph, { includeLocalOnly: true });
const pages = flowPages(graph, flows);

function routesOf(label: string): string[] {
  const flow = flows.find((candidate) => candidate.label === label);
  expect(flow, `no flow labelled ${label}`).toBeDefined();
  return (pages.get(flow!.id) ?? []).map((page) =>
    page.layout ? `layout ${page.route}` : page.route,
  );
}

describe('flowPages', () => {
  it('puts an action written on a page on that page', () => {
    expect(routesOf('Refresh')).toEqual(['/products']);
  });

  it('follows a dialog up to the page that renders it', () => {
    expect(routesOf('Save draft')).toEqual(['/products']);
  });

  it('lists a component rendered from two pages on both, through any depth', () => {
    expect(routesOf('Save product')).toEqual(['/products', '/products/[id]/edit']);
  });

  it('marks an action only a layout reaches as a layout', () => {
    expect(routesOf('Log out')).toEqual(['layout /']);
  });

  it('leaves an action nothing renders without a page', () => {
    expect(routesOf('Nobody renders me')).toEqual([]);
  });
});
