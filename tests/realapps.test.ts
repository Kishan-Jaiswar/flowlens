import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  findDeadEndpoints,
  findSharedWrites,
  loadConfig,
  projectFindings,
  projectUnused,
  scan,
} from '@flowslens/core';

/**
 * Shapes taken from real apps Flowslens got wrong: a wrapper that builds its own
 * absolute URL, and a constant name declared differently in several files.
 */
const project = mkdtempSync(join(tmpdir(), 'flowlens-realapps-'));
const write = (rel: string, text: string): void => {
  mkdirSync(join(project, rel, '..'), { recursive: true });
  writeFileSync(join(project, rel), text, 'utf8');
};

write(
  'web/.env',
  [
    'NEXT_PUBLIC_API_HOST=https://api.example.com/api/v3',
    'NEXT_PUBLIC_PG_API=https://pg.example.com/api',
    'NEXT_PUBLIC_ONLY_HOST=https://only.example.com',
  ].join('\n'),
);
write(
  'web/config/axios.js',
  `import axios from 'axios';
   const BASEURL = process.env.NEXT_PUBLIC_API_HOST;
   const PG_API = process.env.NEXT_PUBLIC_PG_API;
   const api = axios.create({ baseURL: BASEURL });
   export const getRequest = ({ url, params = '' }) => api.get(url + params);
   export const postRequest = ({ url, body }) => api.post(url, body);
   export const getRequestPG = ({ url, params = '' }) => api.get(\`\${PG_API}\${url + params}\`);`,
);
write(
  'web/config/endpoints.js',
  `export const getSubtopic = '/subtopics';\nexport const drugDosage = '/drug-dosage';`,
);
write('web/constants/images.js', `export const drugDosage = 'https://cdn.example.com/drug.png';`);
write('web/store/a.js', `const HOST = process.env.NEXT_PUBLIC_ONLY_HOST;\nexport const a = HOST;`);
write(
  'web/store/form.js',
  `const HOST = process.env.NEXT_PUBLIC_API_HOST;
   export const load = async (country) => fetch(\`\${HOST + '/states'}/\${country}\`);`,
);
write(
  'web/pages/quiz.js',
  `import { getRequest, getRequestPG } from '../config/axios';
   import { getSubtopic, drugDosage } from '../config/endpoints';
   export default function Quiz() {
     return (
       <div>
         <button onClick={() => getRequestPG({ url: getSubtopic })}>Topics</button>
         <button onClick={() => getRequest({ url: drugDosage })}>Dose</button>
       </div>
     );
   }`,
);

write(
  'web/config/aria.js',
  `import axios from 'axios';
   const aria = axios.create({ baseURL: process.env.NEXT_PUBLIC_ARIA_HOST || '' });
   export const startConsult = async (body) => (await aria.post('/consult/start', body)).data;`,
);

const popup = (url: string) => `import { postRequest } from '../config/axios';
   export default function SlotPopup({ onDone, reschedule }) {
     const save = async () => { await postRequest({ url: '${url}' }); onDone(); };
     const move = async () => { await postRequest({ url: '${url}/move' }); onDone(); };
     return <button onClick={() => (reschedule ? move() : save())}>Book slot</button>;
   }`;
write('web/components/SlotPopup.js', popup('/slots/book'));
write('web/components/SlotPopupNew.js', popup('/slots/book-new'));
for (const [page, extra] of [
  ['a', ''],
  ['b', 'reschedule'],
])
  write(
    `web/pages/${page}.js`,
    `import { useState } from 'react';
     import SlotPopup from '../components/SlotPopup';
     export default function Page${page}() {
       const [done, setDone] = useState(false);
       return <SlotPopup onDone={() => setDone(true)} ${extra} />;
     }`,
  );

write(
  'web/pages/labels.js',
  `import { postRequest } from '../config/axios';
   export default function Labels({ walkIn }) {
     const [invited, setInvited] = useState(false);
     const book = () => postRequest({ url: '/slots/book' });
     const walk = () => postRequest({ url: '/slots/walk-in' });
     return (
       <div>
         <div onClick={book}>
           {walkIn ? <button onClick={walk}><span>Schedule WalkIn</span></button> : <p>Book</p>}
         </div>
         <div onClick={() => (walkIn ? rescheduleSlot() : createAppointment())}>
           {walkIn ? <button onClick={walk}><span>Walk in</span></button> : <PrimaryButton>{text}</PrimaryButton>}
         </div>
         <button onClick={() => postRequest({ url: '/invite' })}>{invited ? 'Invited' : 'Invite'}</button>
       </div>
     );
   }`,
);

write(
  'web/lib/topicsApi.js',
  `import { getRequest } from '../config/axios';
   export async function fetchTopics() { return getRequest({ url: '/topics' }); }`,
);
write(
  'web/pages/welcome.js',
  `export default function Welcome() {
     async function fetchTopics() { return []; }
     return <button onClick={() => fetchTopics()}>Load</button>;
   }`,
);
write(
  'web/components/Topics.js',
  `import { fetchTopics } from '../lib/topicsApi';
   export default function Topics() {
     return <button onClick={() => fetchTopics()}>Retry</button>;
   }`,
);

const { graph } = scan({ root: join(project, 'web') });
const labels = graph.nodesOfKind('api-call').map((node) => node.label);

describe('components drawn by import, not by name', () => {
  it('places a twin component only where its own file is imported', () => {
    const placed = graph
      .nodesOfKind('ui-action')
      .filter((node) => node.meta?.['siteFile'] !== undefined)
      .map((node) => node.source?.file);
    expect(placed).toContain('components/SlotPopup.js');
    expect(placed).not.toContain('components/SlotPopupNew.js');
  });

  it('follows only the side of a prop check each place can take', () => {
    const sent = (page: string) =>
      graph
        .nodesOfKind('ui-action')
        .filter((node) => node.meta?.['siteFile'] === `pages/${page}.js`)
        .flatMap((node) => [
          ...graph.reachable(node.id, { kinds: ['triggers', 'calls', 'requests'] }).keys(),
        ])
        .map((id) => graph.node(id))
        .filter((node) => node?.kind === 'api-call')
        .map((node) => node!.label)
        .sort();
    expect(sent('a')).toEqual(['POST /v3/slots/book']);
    expect(sent('b')).toEqual(['POST /v3/slots/book/move']);
  });
});

describe('action labels', () => {
  const labelled = (file: string) =>
    graph
      .nodesOfKind('ui-action')
      .filter((node) => node.source?.file === file)
      .map((node) => node.label);

  it('does not borrow the words of a nested control that has its own handler', () => {
    expect(labelled('pages/labels.js')).toContain('Book');
    expect(labelled('pages/labels.js').filter((label) => label === 'Schedule WalkIn')).toHaveLength(
      1,
    );
  });

  it('names a wrapper by the calls it picks between when it shows no words of its own', () => {
    expect(labelled('pages/labels.js')).toContain('Reschedule Slot or Create Appointment');
  });

  it('names a toggled button by what pressing it does', () => {
    expect(labelled('pages/labels.js')).toContain('Invite');
  });
});

describe('a function name declared in several files', () => {
  it('follows the call to the one the file imports', () => {
    const retry = graph
      .nodesOfKind('ui-action')
      .find((node) => node.source?.file === 'components/Topics.js');
    const sent = [
      ...graph.reachable(retry!.id, { kinds: ['triggers', 'calls', 'requests'] }).keys(),
    ]
      .map((id) => graph.node(id))
      .filter((node) => node?.kind === 'api-call')
      .map((node) => node!.label);
    expect(sent).toEqual(['GET /v3/topics']);
  });
});

describe('real-app URL shapes', () => {
  it('uses the host a wrapper puts in front of its url, not the instance baseURL', () => {
    expect(labels).toContain('GET /subtopics');
    expect(labels).not.toContain('GET /v3/subtopics');
  });

  it('resolves a constant through the file’s own import when the name is reused', () => {
    expect(labels).toContain('GET /v3/drug-dosage');
  });

  it('reads calls on any axios.create instance, whatever it is called', () => {
    expect(labels).toContain('POST /consult/start');
  });

  it('resolves a module constant declared differently in another file', () => {
    expect(labels).toContain('GET /v3/states/:param');
  });
});

describe('what counts as an auth check on a Nest route', () => {
  const api = mkdtempSync(join(tmpdir(), 'flowlens-nestauth-'));
  const put = (rel: string, text: string): void => {
    mkdirSync(join(api, rel, '..'), { recursive: true });
    writeFileSync(join(api, rel), text, 'utf8');
  };
  put(
    'src/main.ts',
    `import { ValidationPipe } from '@nestjs/common';
     async function bootstrap() { const app = await NestFactory.create(AppModule); app.useGlobalPipes(new ValidationPipe()); }`,
  );
  put(
    'src/optional.middleware.ts',
    `export class OptionalUserMiddleware {
       async use(req, res, next) {
         if (!req.headers?.authorization) { return next(); }
         throw new UnauthorizedException('bad token');
       }
     }`,
  );
  put(
    'src/staff.middleware.ts',
    `export class StaffMiddleware {
       async use(req, res, next) { await new JwtAuthGuard().canActivate(req); next(); }
     }`,
  );
  put(
    'src/app.module.ts',
    `import { OptionalUserMiddleware } from './optional.middleware';
     import { StaffMiddleware } from './staff.middleware';
     export class AppModule {
       configure(consumer) {
         consumer.apply(OptionalUserMiddleware).forRoutes('*');
         consumer.apply(StaffMiddleware).forRoutes({ path: '/api/notes', method: RequestMethod.POST }, { path: '/api/notes/special', method: RequestMethod.GET });
       }
     }`,
  );
  put(
    'src/things.controller.ts',
    `import { Controller, Post } from '@nestjs/common';
     @Controller('api/things')
     export class ThingsController { @Post() create() { return {}; } }
     @Controller('api/notes')
     export class NotesController { @Post() create() { return {}; } @Get(':id') one() { return {}; } @Get('special') special() { return {}; } }
     @Controller('api/hooks')
     export class HooksController { @All('any') any() { return {}; } }`,
  );
  const result = scan({ root: api });
  const unguarded = projectFindings(result.graph, result.root)
    .findings.filter((finding) => finding.kind === 'no-auth')
    .map((finding) => finding.title);

  it('is not a validation pipe, nor a middleware that lets a request with no token through', () => {
    expect(unguarded).toContain('POST /things runs without any auth check');
  });

  it('is a middleware that hands the request to a guard', () => {
    expect(unguarded).not.toContain('POST /notes runs without any auth check');
    expect(unguarded).not.toContain('GET /notes/special runs without any auth check');
  });

  it('lists an @All() route with no caller once', () => {
    const dead = findDeadEndpoints(result.graph).map((route) => route.label);
    expect(dead.filter((label) => label.endsWith(' /hooks/any'))).toEqual(['ALL /hooks/any']);
  });

  it('does not cover a :param route from a middleware applied to one literal path', () => {
    expect(unguarded).toContain('GET /notes/:param runs without any auth check');
  });
});

describe('a config file found above the project', () => {
  const desk = mkdtempSync(join(tmpdir(), 'flowlens-desk-'));
  for (const dir of ['clinic/web', 'clinic-api', 'other/site/src'])
    mkdirSync(join(desk, dir), { recursive: true });
  writeFileSync(
    join(desk, 'flowlens.config.json'),
    JSON.stringify({ roots: ['./clinic/web', './clinic-api'] }),
  );

  it('applies to the projects it lists', () => {
    expect(loadConfig(join(desk, 'clinic/web')).path).toBe(join(desk, 'flowlens.config.json'));
    expect(loadConfig(desk).path).toBe(join(desk, 'flowlens.config.json'));
  });

  it('does not apply to a neighbour it does not list', () => {
    expect(loadConfig(join(desk, 'other/site/src')).path).toBeUndefined();
  });
});

describe('unused code a framework or package still needs', () => {
  const app = mkdtempSync(join(tmpdir(), 'flowlens-unused-'));
  const put = (rel: string, text: string): void => {
    mkdirSync(join(app, rel, '..'), { recursive: true });
    writeFileSync(join(app, rel), text, 'utf8');
  };
  put(
    'package.json',
    JSON.stringify({ dependencies: { 'react-i18next': '1', i18next: '1', lodash: '1' } }),
  );
  put(
    'node_modules/react-i18next/package.json',
    JSON.stringify({ name: 'react-i18next', peerDependencies: { i18next: '*' } }),
  );
  put(
    'pages/index.js',
    `import { useTranslation } from 'react-i18next';\nexport default function Home() { return null; }`,
  );
  put('public/sw.js', `self.addEventListener('push', () => {});`);
  const report = projectUnused(scan({ root: app }).graph);

  it('keeps a peer dependency of a package the code imports', () => {
    expect(report.dependencies.map((entry) => entry.name)).toEqual(['lodash']);
  });

  it('keeps a script in public/, which is loaded by its URL', () => {
    expect(report.files.map((entry) => entry.file)).not.toContain('public/sw.js');
  });
});

describe('findings that hold only for code a request runs, the way it runs', () => {
  const app = mkdtempSync(join(tmpdir(), 'flowlens-findings-real-'));
  const put = (rel: string, text: string): void => {
    mkdirSync(join(app, rel, '..'), { recursive: true });
    writeFileSync(join(app, rel), text, 'utf8');
  };
  put('tsconfig.json', JSON.stringify({ compilerOptions: { paths: { '@/*': ['./*'] } } }));
  put(
    'lib/db/mongo.ts',
    `export async function getCollections() {
       const db = await getDb();
       return { cars: db.collection('cars'), tags: db.collection('tags') };
     }`,
  );
  put(
    'lib/db/store.ts',
    `import { getCollections } from './mongo';
     export async function tagAll(names) {
       const { tags } = await getCollections();
       names.forEach((name) => { tags.findOne({ name }); });
     }
     export async function tagEach(names) {
       const { tags } = await getCollections();
       for (const name of names) await tags.findOne({ name });
     }
     export async function addTag(name) {
       const { tags } = await getCollections();
       await tags.insertOne({ name });
     }`,
  );
  put(
    'app/api/tags/route.ts',
    `import { tagAll, tagEach } from "@/lib/db/store";
     export async function POST(request) {
       const body = await request.json();
       await tagAll(body.names);
       await tagEach(body.names);
       return Response.json({});
     }`,
  );
  put(
    'scripts/backfill.ts',
    `import { getCollections } from '../lib/db/mongo';
     async function main() {
       const { cars, tags } = await getCollections();
       const a = await cars.find({}).toArray();
       const b = await tags.find({}).toArray();
       await tags.insertOne({ name: 'seed' });
       console.log(a, b);
     }
     main();`,
  );
  const graph = scan({ root: app }).graph;
  const found = projectFindings(graph).findings;

  it('counts each module that writes a collection as a writer, not only service classes', () => {
    expect(findSharedWrites(graph)).toEqual([
      { collection: 'tags', writers: ['lib/db/store.ts', 'scripts/backfill.ts'] },
    ]);
  });

  it('does not say a one-off script makes a request wait', () => {
    expect(found.filter((finding) => finding.kind === 'sequential-awaits')).toEqual([]);
  });

  it('tells a forEach that starts every query at once from a loop that awaits each', () => {
    const loops = found.filter((finding) => finding.kind === 'n-plus-one');
    expect(loops.map((finding) => finding.severity).sort()).toEqual(['low', 'medium']);
  });
});
