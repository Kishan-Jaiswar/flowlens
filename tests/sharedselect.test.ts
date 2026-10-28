import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { resolveFlows, scan } from '@flowslens/core';

/**
 * A shared dropdown: the option row inside it has no words of its own, and only calls
 * the `onChange` each page hands it. The page's `<Select onChange>` is the action —
 * a second, merged "Pick an option" copy of it is noise.
 */
const project = mkdtempSync(join(tmpdir(), 'flowlens-select-'));
const write = (rel: string, text: string): void => {
  mkdirSync(join(project, rel, '..'), { recursive: true });
  writeFileSync(join(project, rel), text, 'utf8');
};

write('package.json', JSON.stringify({ dependencies: { next: '15.0.0', react: '19.0.0' } }));
write(
  'components/select.tsx',
  `export function Select({ onChange, options }) {
     return (
       <div>
         {options.map((o) => (
           <div key={o.value} role="option" onClick={() => onChange(o.value)}>{o.label}</div>
         ))}
       </div>
     );
   }`,
);
write(
  'app/items/page.tsx',
  `'use client';
   import axios from 'axios';
   import { Select } from '../../components/select';
   export default function ItemsPage() {
     return (
       <Select
         onChange={(kind) => axios.get(\`/api/items?kind=\${kind}\`)}
         options={[{ value: '', label: 'All kinds' }, { value: 'a', label: 'Kind A' }]}
       />
     );
   }`,
);
write('app/api/items/route.ts', `export async function GET() { return Response.json([]); }`);

const flows = resolveFlows(scan({ root: project }).graph, { includeLocalOnly: true });

describe('a shared dropdown', () => {
  it('keeps the page’s own action and drops the role-named copy inside the component', () => {
    expect(flows.some((flow) => flow.title.includes('Pick an option'))).toBe(false);
    const pick = flows.find((flow) => flow.endpoints.includes('GET /items'));
    expect(pick?.component).toBe('ItemsPage');
  });
});
