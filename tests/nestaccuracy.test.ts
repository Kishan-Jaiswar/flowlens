import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { actionDecisions, renderDecisionTree, resolveFlows, scan } from '@flowslens/core';

/**
 * What a hand-drawn chart of a real "Download report" (Next.js frontend,
 * NestJS + Mongoose backend) had that the Decisions tab did not:
 *
 *  - the endpoint is called from two screens, and the tab drew the other
 *    screen's code under "the walk did not reach them";
 *  - `getRequest()` picks the token and its client's interceptor sends a 401
 *    to the login page — the wrapper was a single step;
 *  - middleware applied in `configure(consumer)` with `forRoutes`/`exclude`,
 *    and the Passport strategy behind `AuthGuard('jwt')`, were missing;
 *  - an `@Res()` handler's `res.status(400).json(…)` in a catch read "the error
 *    is ignored", and its `res.send(buffer)` was not drawn;
 *  - `from ? new Date(from) : <a week ago>` was not drawn as a decision.
 */

const root = mkdtempSync(join(tmpdir(), 'flowlens-nest-'));
const web = join(root, 'web');
const api = join(root, 'api');
const write = (base: string, rel: string, text: string): void => {
  mkdirSync(join(base, rel, '..'), { recursive: true });
  writeFileSync(join(base, rel), text, 'utf8');
};

write(
  web,
  'package.json',
  JSON.stringify({ dependencies: { next: '15.0.0', react: '19.0.0', axios: '1.0.0' } }),
);
write(
  web,
  'misc/http.js',
  `import axios from 'axios';
   const client = axios.create({ baseURL: process.env.NEXT_PUBLIC_API_HOST });
   client.interceptors.request.use((config) => {
     const setIsLoading = loader.getState().setIsLoading;
     setIsLoading(true);
     return config;
   });
   client.interceptors.response.use(
     (response) => {
       const setIsLoading = loader.getState().setIsLoading;
       setIsLoading(false);
       return response;
     },
     (error) => {
       loading(false);
       if (error?.response?.status === 401) {
         window.location = '/login';
       } else {
         return Promise.reject(error);
       }
     },
   );
   const loading = (on) => { document.body.dataset.loading = on; };
   const loader = { getState: () => ({ setIsLoading: loading }) };
   export const getRequest = ({ url, params = '', auth, responseType = undefined }) => {
     let token;
     const temp = document.cookie.includes('temp');
     if (temp) token = 'temp';
     else token = 'web';
     return client.get(url + params, {
       headers: { Authorization: auth ? \`Bearer \${token}\` : 'Basic abc' },
       timeout: 60000,
       responseType,
     });
   };`,
);
write(web, 'misc/endpoints.js', `export const reportUrl = '/api/reports/range';`);
write(
  web,
  'pages/home/index.js',
  `import { getRequest } from '../../misc/http';
   import { reportUrl } from '../../misc/endpoints';
   export default function Home() {
     const quick = async () => {
       const response = await getRequest({ url: reportUrl, params: '?from=a&to=b' });
       console.log('home', response);
     };
     return <button onClick={quick}>Quick report</button>;
   }`,
);
write(
  web,
  'pages/billing/index.js',
  `import { getRequest } from '../../misc/http';
   import { reportUrl } from '../../misc/endpoints';
   export default function Billing() {
     const download = async () => {
       try {
         const response = await getRequest({ url: reportUrl, params: '?from=a&to=b', auth: true, responseType: 'blob' });
         const a = document.createElement('a');
         a.href = URL.createObjectURL(response.data);
         a.download = 'Report.xlsx';
         a.click();
       } catch (error) {
         alert(error?.response?.data?.message || error?.message);
       }
     };
     return <button onClick={download}>Download</button>;
   }`,
);

write(
  web,
  'pages/edit/index.js',
  `import { useEffect } from 'react';
   import { getRequest } from '../../misc/http';
   import Popup from '../../misc/popup';
   export default function Edit() {
     useEffect(() => {
       const load = async () => {
         try {
           await getRequest({ url: '/api/reports/public' });
         } catch (error) {
           console.log(error);
         }
       };
       load();
     }, []);
     const update = async () => {
       await getRequest({ url: '/api/reports/range' });
     };
     const Discard = () => {
       update();
     };
     return <Popup discard={Discard} later={() => update()} />;
   }`,
);
write(
  web,
  'misc/popup.js',
  `export default function Popup({ discard }) { return <button onClick={discard}>Discard</button>; }`,
);
write(
  api,
  'package.json',
  JSON.stringify({
    dependencies: {
      '@nestjs/core': '10.0.0',
      '@nestjs/common': '10.0.0',
      '@nestjs/passport': '10.0.0',
      'passport-jwt': '4.0.0',
      mongoose: '8.0.0',
    },
  }),
);
write(
  api,
  'src/auth/jwt.strategy.ts',
  `import { Injectable } from '@nestjs/common';
   import { InjectModel } from '@nestjs/mongoose';
   import { PassportStrategy } from '@nestjs/passport';
   import { ExtractJwt, Strategy } from 'passport-jwt';
   @Injectable()
   export class JwtStrategy extends PassportStrategy(Strategy, 'jwt') {
     constructor(@InjectModel('Staff') private readonly staffModel) {
       super({
         secretOrKey: process.env.JWT_SECRET,
         jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
         ignoreExpiration: true,
       });
     }
     async validate(payload) {
       const staff = await this.staffModel.findById(payload._id);
       if (!staff) return undefined;
       return staff;
     }
   }`,
);
write(
  api,
  'src/auth/jwt.guard.ts',
  `import { Injectable } from '@nestjs/common';
   import { AuthGuard } from '@nestjs/passport';
   @Injectable()
   export class JwtAuthGuard extends AuthGuard('jwt') {
     async canActivate(context) {
       return (await super.canActivate(context)) as boolean;
     }
   }`,
);
write(
  api,
  'src/auth/staff.middleware.ts',
  `import { Injectable } from '@nestjs/common';
   import { JwtAuthGuard } from './jwt.guard';
   @Injectable()
   export class StaffMiddleware {
     async use(req, res, next) {
       if (!req['user']) await new JwtAuthGuard().canActivate(req);
       next();
     }
   }`,
);
write(
  api,
  'src/reports/reports.service.ts',
  `import { Injectable } from '@nestjs/common';
   import { InjectModel } from '@nestjs/mongoose';
   @Injectable()
   export class ReportsService {
     constructor(@InjectModel('Bill') private readonly billModel) {}
     async range(from, to) {
       const start = from ? new Date(from) : new Date(Date.now() - 7 * 86400000);
       if (isNaN(start.getTime())) throw new Error('Invalid date');
       return this.billModel.aggregate([
         { $match: { created: { $gte: start } } },
         { $lookup: { from: 'patients', localField: 'patient_id', foreignField: '_id', as: 'patient' } },
         { $unwind: '$patient' },
         { $lookup: { from: 'clinics', localField: 'clinic_id', foreignField: '_id', as: 'clinic' } },
         { $unwind: { path: '$clinic', preserveNullAndEmptyArrays: true } },
         { $match: { appointment: { $size: 0 } } },
       ]);
     }
   }`,
);
write(
  api,
  'src/reports/reports.controller.ts',
  `import { Controller, Get, Query, Res, HttpStatus } from '@nestjs/common';
   import { ReportsService } from './reports.service';
   @Controller('api/reports')
   export class ReportsController {
     constructor(private readonly reportsService: ReportsService) {}
     @Get('range')
     async range(@Query() query, @Res() res) {
       try {
         const buffer = await this.reportsService.range(query.from, query.to);
         res.setHeader('Content-Disposition', 'attachment; filename="report.xlsx"');
         res.send(buffer);
       } catch (error) {
         res.status(HttpStatus.BAD_REQUEST).json({ status: false, message: error.message });
       }
     }
     @Get('public')
     async open() {
       return { ok: true };
     }
   }`,
);
write(
  api,
  'src/auth/auth.module.ts',
  `import { Module } from '@nestjs/common';
   import { JwtStrategy } from './jwt.strategy';
   @Module({ providers: [JwtStrategy] })
   export class AuthModule {}`,
);
write(
  api,
  'src/app.module.ts',
  `import { Module, RequestMethod } from '@nestjs/common';
   import { StaffMiddleware } from './auth/staff.middleware';
   import { ReportsController } from './reports/reports.controller';
   @Module({ controllers: [ReportsController] })
   export class AppModule {
     configure(consumer) {
       consumer
         .apply(StaffMiddleware)
         .exclude({ path: 'api/reports/public', method: RequestMethod.GET })
         .forRoutes(ReportsController);
     }
   }`,
);

const { graph } = scan({ root: web, extraRoots: [api] });
const flows = resolveFlows(graph, { includeLocalOnly: true });
const tree = (label: string): string => {
  const flow = flows.find((candidate) => candidate.label === label);
  expect(flow, label).toBeDefined();
  return renderDecisionTree(actionDecisions(graph, flow!));
};

describe('the Decisions tab of a NestJS request', () => {
  it("draws this screen's own call, not another screen calling the same endpoint", () => {
    const text = tree('Download');
    expect(text).not.toContain('pages/home');
    expect(text).not.toContain('did not reach');
    expect(text).toContain("a.download = 'Report.xlsx'");
  });

  it("opens the request wrapper and its client's interceptor", () => {
    const text = tree('Download');
    expect(text).toMatch(/getRequest\(\)/);
    expect(text).toContain('temp?');
    expect(text).toContain('interceptors.response (on error)');
  });

  it('runs module middleware, and the Passport strategy behind the guard, before the handler', () => {
    const text = tree('Download');
    expect(text).toContain('middleware: StaffMiddleware');
    expect(text).toContain('staffs.findById');
    const route = graph.nodesOfKind('route').find((node) => node.label === 'GET /reports/public')!;
    expect(graph.successors(route.id, ['guarded-by']).map((node) => node.label)).not.toContain(
      'StaffMiddleware',
    );
  });

  it("reads an @Res() handler's answers and the defaults it fills in", () => {
    const text = tree('Download');
    expect(text).toContain('responds 200 with buffer');
    expect(text).toContain('responds 400 with');
    expect(text).not.toContain('the error is ignored');
    expect(text).toContain('from?');
  });
});

describe('what the hand-drawn chart had that the tab did not', () => {
  it("draws Passport's own token check and its 401s, around the strategy's validate", () => {
    const text = tree('Download');
    expect(text).toContain(
      'a Bearer token in the Authorization header, signed with process.env.JWT_SECRET (its expiry is not checked)?',
    );
    expect(text).toContain('throws UnauthorizedException — passport-jwt refuses the request [401]');
    expect(text).toContain('validate() gave back a user?');
    expect(text).toContain('throws UnauthorizedException — validate() gave back nothing [401]');
  });

  it('names the collections a pipeline looks up, and the rows it leaves out', () => {
    const text = tree('Download');
    expect(text).toContain('patients.$lookup — patient_id → _id, as patient');
    expect(text).toContain('clinics.$lookup');
    expect(text).toContain('has a patient?');
    expect(text).not.toContain('has a clinic?');
    expect(text).toContain('appointment is empty?');
    expect(text).toContain('left out of the result — no patient');
  });

  it('shows the request interceptor, both answers, and an empty answer from a 401', () => {
    const text = tree('Download');
    expect(text).toContain('client.interceptors.request');
    expect(text).toContain('client.interceptors.response (on success)');
    expect(text).toContain('returns nothing — the request resolves with undefined');
    expect(text).toContain('response is undefined?');
    expect(text).toContain('throws TypeError — cannot read response.data of undefined');
  });

  it('says how the wrapper sends, and that a blob answer hides the error message', () => {
    const { nodes } = actionDecisions(
      graph,
      flows.find((flow) => flow.label === 'Download')!,
    );
    const labels = JSON.stringify(nodes);
    expect(labels).toContain(
      'Send it with client.get — sends a Bearer Authorization header, gives up after 60000 ms, reads the answer as a blob',
    );
    expect(labels).toContain('The server’s error message is never read');
    expect(labels).toContain('Click the link, so the browser saves the file');
  });

  it("lists what the middleware reads, and the collections looked up, as the request's data", () => {
    const route = graph.nodesOfKind('route').find((node) => node.label === 'GET /reports/range')!;
    const reached = [...graph.reachable(route.id, { kinds: ['calls', 'queries'] }).keys()];
    expect(reached.some((id) => id.includes('bills.aggregate'))).toBe(true);
    const staff = graph.nodesOfKind('method').find((node) => node.label === 'StaffMiddleware.use')!;
    const fromMiddleware = [...graph.reachable(staff.id, { kinds: ['calls', 'queries'] }).keys()];
    expect(fromMiddleware.some((id) => id.includes('staffs.findById'))).toBe(true);
  });
});

describe('what runs as a page opens', () => {
  it('leaves out handlers and callbacks the page only hands to a popup', () => {
    const load = flows.find((flow) => flow.component === 'Edit' && flow.event === 'mount')!;
    expect(load.endpoints).toEqual(['GET /reports/public']);
    const text = renderDecisionTree(actionDecisions(graph, load));
    expect(text).toContain('the error is only written to the console');
  });
});
