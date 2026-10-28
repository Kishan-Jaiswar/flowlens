import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { resolveFlows, scan } from '@flowslens/core';

/**
 * One popup, two buttons that open it: "Reschedule" hands it `reschedule: true`,
 * "Book" `reschedule: false`, and the popup's button runs
 * `reschedule ? rescheduleApp() : createAppointment()`. Each opener's flow runs its
 * own branch, not both.
 */
const project = mkdtempSync(join(tmpdir(), 'flowlens-presets-'));
const write = (rel: string, text: string): void => {
  mkdirSync(join(project, rel, '..'), { recursive: true });
  writeFileSync(join(project, rel), text, 'utf8');
};

write('package.json', JSON.stringify({ dependencies: { next: '15.0.0', react: '19.0.0' } }));
write(
  'components/SlotPopup.tsx',
  `import { useState } from 'react';
   import axios from 'axios';
   export function SlotPopup({ data, setPopup }) {
     const [reschedule] = useState(data?.reschedule);
     const rescheduleApp = () => axios.post('/api/appointments/reschedule', { id: data.id });
     const createAppointment = () => axios.post('/api/appointments', { id: data.id });
     return (
       <button onClick={() => { reschedule ? rescheduleApp() : createAppointment(); }}>
         Schedule
       </button>
     );
   }`,
);
write(
  'app/patient/page.tsx',
  `'use client';
   import { useState } from 'react';
   import { SlotPopup } from '../../components/SlotPopup';
   export default function PatientPage() {
     const [selectTime, setSelectTime] = useState(null);
     const reschedule = () => setSelectTime({ id: 'a', reschedule: true });
     const book = () => setSelectTime({ id: 'a', reschedule: false });
     return (
       <div>
         <button onClick={reschedule}>Reschedule</button>
         <button onClick={book}>Book</button>
         {selectTime && <SlotPopup data={selectTime} setPopup={setSelectTime} />}
       </div>
     );
   }`,
);
write(
  'app/api/appointments/route.ts',
  `export async function POST() { return Response.json({}); }`,
);
write(
  'app/api/appointments/reschedule/route.ts',
  `export async function POST() { return Response.json({}); }`,
);

const flows = resolveFlows(scan({ root: project }).graph);
const endpointsOf = (label: string) => flows.find((flow) => flow.label === label)?.endpoints;

describe('a popup opened with a value set', () => {
  it('follows only the branch the opener’s value picks', () => {
    expect(endpointsOf('Reschedule')).toEqual(['POST /appointments/reschedule']);
    expect(endpointsOf('Book')).toEqual(['POST /appointments']);
  });
});
