import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { callBase, findBrokenCalls, findExternalCalls, readableUrl, scan } from '@flowslens/core';

/**
 * Where a call is really sent: a base URL held in an env variable, or set once on an
 * axios instance a wrapper uses. Without them a login call to `${WEB_API}/logout`
 * reads as `/logout` and misses its `/api/wow-web/logout` route, and every call to a
 * second service is reported as a wrong URL.
 */
const project = mkdtempSync(join(tmpdir(), 'flowlens-urlbases-'));
const write = (rel: string, text: string): void => {
  mkdirSync(join(project, rel, '..'), { recursive: true });
  writeFileSync(join(project, rel), text, 'utf8');
};

write(
  'web/.env',
  [
    'NEXT_PUBLIC_WEB_API_HOST=https://user:secret@api.example.com/api/wow-web?key=abc',
    'NEXT_PUBLIC_API_HOST="https://api.example.com"',
    'NEXT_PUBLIC_OTHER_HOST=https://other.example.com # the second service',
  ].join('\n'),
);
write(
  'web/misc/axiosConfig.js',
  `import axios from 'axios';
   const baseUrl = process.env.NEXT_PUBLIC_API_HOST;
   const OtherUrl = process.env.NEXT_PUBLIC_OTHER_HOST;
   const api = axios.create({ baseURL: baseUrl });
   const other = axios.create({ baseURL: \`\${OtherUrl}/v3\` });
   export const getRequest = ({ url }) => api.get(url);
   export const postRequest = ({ url, body }) => api.post(url, body);
   export const otherGetRequest = ({ url }) => other.get(url);
   export const otherPostRequest = ({ url, body }) => other.post(url, body);`,
);
write(
  'web/src/pages/home.tsx',
  `import { getRequest, postRequest, otherGetRequest, otherPostRequest } from '../../misc/axiosConfig';
   const WEB = process.env.NEXT_PUBLIC_WEB_API_HOST;
   export default function Home() {
     return (
       <div>
         <button onClick={() => postRequest({ url: \`\${WEB}/logout\` })}>Sign out</button>
         <button onClick={() => getRequest({ url: '/api/patients' })}>Patients</button>
         <button onClick={() => getRequest({ url: '/api/patients/missing/list' })}>Broken</button>
         <button onClick={() => otherGetRequest({ url: '/specialities' })}>Specialities</button>
         <button onClick={() => otherPostRequest({ url: '/enroll', body: {} })}>Enroll</button>
       </div>
     );
   }`,
);
write(
  'api/src/web.controller.ts',
  `import { Controller, Get, Post } from '@nestjs/common';
   @Controller('api/wow-web')
   export class WebAuthController { @Post('logout') logout() { return {}; } }
   @Controller('api/patients')
   export class PatientsController { @Get() list() { return []; } }`,
);

const { graph } = scan({ root: join(project, 'web'), extraRoots: [join(project, 'api')] });
const calls = graph.nodesOfKind('api-call');
const call = (label: string) => calls.find((node) => node.label === label);

describe('URL bases', () => {
  it('reads a base URL from the env file, path only', () => {
    const logout = call('POST /wow-web/logout');
    expect(logout).toBeDefined();
    expect(graph.successors(logout!.id, ['handled-by'])).toHaveLength(1);
    expect(logout!.meta?.['rawPath']).toBe('<env:NEXT_PUBLIC_WEB_API_HOST=/api/wow-web>/logout');
    expect(readableUrl(String(logout!.meta?.['rawPath']))).toBe(
      '${NEXT_PUBLIC_WEB_API_HOST}/logout',
    );
  });

  it('puts an axios instance’s baseURL in front of its wrappers’ calls', () => {
    const specialities = call('GET /v3/specialities');
    expect(specialities?.meta?.['rawPath']).toBe('/specialities');
    expect(specialities?.meta?.['base']).toBe('<env:NEXT_PUBLIC_OTHER_HOST=>/v3');
    expect(graph.successors(call('GET /patients')!.id, ['handled-by'])).toHaveLength(1);
  });

  it('sets calls to another service apart from broken ones', () => {
    expect(findBrokenCalls(graph).map((node) => node.label)).toEqual([
      'GET /patients/missing/list',
    ]);
    const external = findExternalCalls(graph);
    expect(external.map((node) => node.label).sort()).toEqual([
      'GET /v3/specialities',
      'POST /v3/enroll',
    ]);
    expect(new Set(external.map(callBase))).toEqual(new Set(['env:NEXT_PUBLIC_OTHER_HOST']));
    // Not flagged as a wrong URL in a flow either.
    expect(external.map((node) => node.meta?.['mismatch'])).toEqual([undefined, undefined]);
    expect(call('GET /patients/missing/list')?.meta?.['mismatch']).toBe('no-route');
  });

  it('keeps no host, credential or query string from the env file', () => {
    const text = JSON.stringify(graph.toJSON());
    for (const secret of ['secret', 'example.com', 'key=abc']) expect(text).not.toContain(secret);
  });
});
