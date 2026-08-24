# FlowLens

**Trace any user action from the UI to the database.**

[![CI](https://github.com/Kishan-Jaiswar/flowlens/actions/workflows/ci.yml/badge.svg)](https://github.com/Kishan-Jaiswar/flowlens/actions/workflows/ci.yml)
[![Node](https://img.shields.io/badge/node-%3E%3D18.18-brightgreen)](https://nodejs.org)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue)](LICENSE)
[![Tests](https://img.shields.io/badge/tests-176%20passing-brightgreen)](tests)

> FlowLens helps developers understand and safely modify unfamiliar applications
> by tracing a feature from the user's UI action through frontend state and
> handlers, API calls, backend controllers and services, and database
> operations — while showing dependencies, data lineage, and execution time.

The question it answers is the one you actually ask on day three of a new
codebase:

> _I clicked this button. Show me everything that happened because of it._

---

## Project status

**v0.1, pre-release.** Honest summary of what is and is not proven:

|                        | State                                                                                                                                         |
| ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| Static analysis        | Verified against a real production codebase — ~1,500 files, 204 API calls, 197 matched to backend routes                                      |
| Structure independence | 11 project layouts covered by tests, including hostile inputs                                                                                 |
| Runtime tracing        | **Implemented, not yet proven.** Every trace so far came from a script that fabricates spans. Wiring it into a live app is the next milestone |
| Stacks read            | React/Next, NestJS/Express, Mongoose. Vue, Prisma and SQL are not read yet, and the CLI tells you so                                          |

`docs/ROADMAP.md` leads with what is missing rather than what is planned.

---

## The problem

You join a project. You need to change one thing on one screen. So you start:

```text
Ctrl+Click → search → Ctrl+Click → search → Postman → Compass → DevTools
→ search again → ask someone who has been here longer
```

Eight tools and an afternoon later you know which service writes which
collection — and you still do not know what else calls it.

FlowLens turns that into:

```text
flowlens flow create-patient
```

---

## What you get

```text
$ flowlens flow prescriptionform-submit-prescription examples/clinic

Submit Prescription  (prescriptionform-submit-prescription)
web/src/components/PrescriptionForm.tsx:42
risk high (50)   evidence confirmed   373ms

Execution path
──────────────
USER ACTION
└── [ui action]   Submit Prescription
    web/src/components/PrescriptionForm.tsx:42
│
▼
FRONTEND
└── [handler]     PrescriptionForm.handleSubmit
    web/src/components/PrescriptionForm.tsx:15
│
▼
NETWORK
├── [api call]    POST /prescriptions
│   web/src/components/PrescriptionForm.tsx:16
└── [route]       POST /prescriptions
    api/src/prescriptions/prescriptions.controller.ts:9
│
▼
BACKEND
├── [method]      PrescriptionsController.create
├── [method]      PrescriptionsService.create
├── [method]      PatientsService.findById
├── [method]      MedicinesService.assertAvailable
└── [method]      AuditService.record
│
▼
DATABASE
├── [db op]       patients.findById            read
├── [db op]       medicines.countDocuments     read
├── [db op]       prescriptions.create         write
└── [db op]       auditlogs.create             write

Risk factors
────────────
  • writes to 2 collections: auditlogs, prescriptions
  • AuditService.record is called from 5 places
  • touches 5 collections in one action
  • confirmed by runtime tracing
```

---

## Install

Requires **Node 18.18 or newer**. CI runs the test suite on Node 20, 22, 24 and
26, and separately verifies that the CLI itself works on 18.18 — the test runner
no longer supports Node 18, but the product does. `.nvmrc` pins 26 for
development.

```bash
git clone https://github.com/Kishan-Jaiswar/flowlens.git
cd flowlens
npm install
npm run build
npm link -w @flowlens/cli   # puts `flowlens` on your PATH
```

Then point it at any project:

```bash
flowlens scan ~/code/my-app
flowlens flows ~/code/my-app
flowlens serve ~/code/my-app        # dashboard on http://127.0.0.1:4177
```

If your frontend and backend are separate repositories, pass both — the seam
between them is the interesting part:

```bash
flowlens scan ~/code/my-web ~/code/my-api
```

Prefer not to install anything globally? Every command works through npm:

```bash
npm run flowlens -- scan ~/code/my-app
```

### Try it on the bundled example

A source-only React + NestJS + Mongoose app, never executed, no database:

```bash
npm run scan:example
npm run flows:example
npm run serve:example

# and a synthetic recording, so the runtime merge is demoable with no server
node examples/clinic/demo-trace.mjs
flowlens trace examples/clinic
```

---

## Any project structure

FlowLens decides what a file is by **reading it**, not by where it sits. Folder
names are the least reliable thing about a real repository — `api/` is a Nest
backend in one project, an axios client in the next, and Next.js route handlers
in a third — so classification comes from decorators, imports and JSX.

Verified against a fixture for each of these layouts (`tests/structures.test.ts`):

| Layout                                                                   | Handled |
| ------------------------------------------------------------------------ | ------- |
| Flat — everything in one directory, no `src/`                            | ✅      |
| `src/` with any nesting depth                                            | ✅      |
| Monorepo — `apps/web` + `apps/api` under one root                        | ✅      |
| Separate repos — `flowlens scan ./web ./api`                             | ✅      |
| Next.js `pages/api/**` (routes from the file system)                     | ✅      |
| Next.js App Router `app/**/route.ts` (one export per verb)               | ✅      |
| Nuxt `server/api/x.get.ts` (method in the filename)                      | ✅      |
| Express / Fastify routers, including inline handlers                     | ✅      |
| NestJS decorators, DI, global prefixes                                   | ✅      |
| A **frontend** folder named `api/`                                       | ✅      |
| API calls in a service layer, one module away                            | ✅      |
| TypeScript, plain JavaScript, `.jsx`, `.mjs`, `.cjs`, CommonJS `require` | ✅      |

Dynamic route segments are understood: `[id]` → `:param`, `[...slug]` → `*`,
route groups `(admin)` are dropped, `index` collapses to its directory.

**It does not crash.** Deliberately hostile inputs are part of the suite:

- symlink cycles (`self -> .`, `parent -> ..`) and dangling links
- binary files with a `.js` extension, syntax errors, empty files
- unreadable directories, read-only projects, empty projects, a single file as root
- minified bundles and `.d.ts` files (skipped rather than parsed)

Per-file failures are collected as warnings and reported at the end; one strange
file never ends a scan of ten thousand. A read-only project falls back to
writing the graph under the current directory. `node_modules`, build output and
about thirty other generated directories are skipped, with a `--max-files` valve
for the case where FlowLens is pointed somewhere enormous by mistake.

### Structure-agnostic is not framework-agnostic

An important distinction, because "works on any project" would be a lie:

**Any _layout_ of a supported stack works.** FlowLens does not care where your
files live, what your folders are called, or how deeply they nest.

**It only reads some _stacks_.** Point it at these and it degrades to a file
count, honestly reported rather than silently:

| Not read yet                           | What happens                                      |
| -------------------------------------- | ------------------------------------------------- |
| Vue, Svelte, Astro (`.vue`, `.svelte`) | Files counted and named in the output; not parsed |
| Angular                                | Components not detected (no JSX)                  |
| Django, Rails, Go, Java, .NET, PHP     | Counted and named; not parsed                     |
| Prisma, TypeORM, Sequelize, raw SQL    | Queries not detected — Mongoose only              |
| GraphQL / tRPC                         | Resolvers are not routes yet                      |
| Queues, cron, websockets               | Not modelled                                      |

```text
$ flowlens scan ./vue-project

Notes
  • No JavaScript or TypeScript found, but this project contains 40 .vue
    — those are not parsed yet. FlowLens currently reads React/Next
    frontends and NestJS/Express backends.
```

That message exists because the earlier version said "no source files found",
which sounds like a broken tool rather than an unsupported stack.

If a scan comes back thin, it says why rather than leaving you guessing:

```text
Notes
  • Frontend found, but no backend routes. Add the backend as a second path
    (`flowlens scan ./web ./api`) if it lives in another repository.
  • No API calls detected. If requests go through a house-built wrapper,
    describe it with --request-fn '<regex>'.
```

### flowlens.config.json

Projects with their own conventions can describe them once, in the repo, instead
of retyping flags. Searched upwards from the scanned path, so it also works from
a subdirectory. Comments and trailing commas are allowed.

```jsonc
{
  // Scanned together when no paths are given on the command line.
  "roots": ["./web", "./api"],

  // Stripped from BOTH frontend URLs and backend routes.
  "apiPrefixes": ["/api", "/v2"],

  // Your request layer: capture group 1 is the HTTP verb.
  "requestFunctionPattern": "^(get|post|put|patch|delete)Request[A-Za-z0-9_]*$",

  // Identifiers treated as HTTP clients.
  "httpClients": ["axios", "api", "http"],

  "ignore": ["legacy", "generated"],
  "includeTests": false,
}
```

CLI flags override the file; the file overrides the defaults.

## Working with a real codebase

Textbook projects call `axios.post('/api/patients', body)`. Real ones do not, and
the defaults are built for the real ones.

**Separate repos.** A frontend and backend in sibling folders are scanned into
one graph — the seam between them is the whole point:

```bash
flowlens scan ./my-web ./my-api
flowlens scan ./api ./web ./mobile      # several consumers of one API
```

**A house-built request layer.** If your team wraps HTTP in named helpers,
FlowLens reads the verb from the function name and the path from the options
object:

```js
getRequest({ url: getUsersList, auth: true }); //  GET /users
patchRequestNoLoader({ url: getUser, params: `/${id}` }); //  PATCH /users/:id
```

The default pattern is `^(get|post|put|patch|delete)Request[A-Za-z0-9_]*$` —
strict enough that `getState()` and `deleteRow()` are not mistaken for HTTP
calls. Override it with `--request-fn '<regex>'` (capture group 1 is the verb).

**Endpoint constants.** Paths usually live in a constants module, not at the
call site. FlowLens resolves them automatically:

```js
// src/config/endpoints.js
export const getUsersList = '/api/users';
```

Disable with `--no-constants` if it ever guesses wrong.

**Interpolated base URLs.** `` `${baseUrl}${endpoint}?from=${date}` `` resolves
to the endpoint path; a leading interpolation is treated as a host, not a route
segment.

**Global prefixes.** `--api-prefix` strips a prefix from **both** frontend URLs
and backend routes. A Nest app serving `@Controller('api/users')` and a
frontend calling `/api/users` must be normalised on both sides, or nothing
matches. Default: `/api`.

Measured on a real production codebase — Next.js frontend (plain `.js`, no
TypeScript), NestJS + Mongoose backend, three repositories, ~1,500 files:

```text
scanned in 10.7s      339 URL constants resolved
892 components        1964 user actions       2869 handlers
204 API calls         197 matched a backend route (96%)
506 routes            105 services            81 collections
37 feature flows      261 field-level lineage links
14 collections with more than one writing service
```

## Commands

| Command                         | What it answers                                  |
| ------------------------------- | ------------------------------------------------ |
| `flowlens scan [project]`       | Build the graph. Writes `.flowlens/graph.json`.  |
| `flowlens flows [project]`      | Which user actions reach the backend?            |
| `flowlens flow <id>`            | Everything one click does, end to end.           |
| `flowlens flow <id> --markdown` | Generate a living feature document.              |
| `flowlens impact <symbol>`      | If I change this, what breaks?                   |
| `flowlens doctor [project]`     | Broken API calls, dead endpoints, shared writes. |
| `flowlens trace [project]`      | Merge recorded runtime spans into the graph.     |
| `flowlens serve [project]`      | The dashboard.                                   |

Add `--json` to any command to get machine-readable output.

---

## Static plus runtime

Static analysis proves a path **can** exist. Runtime tracing proves it **did**.
FlowLens keeps both and labels every node accordingly:

| Evidence    | Meaning                                                                                    |
| ----------- | ------------------------------------------------------------------------------------------ |
| `static`    | Found in source. Not yet observed running.                                                 |
| `runtime`   | Observed running, but the analyzer never found it — dynamic routing, an ORM helper, drift. |
| `confirmed` | Both agree. This is the path, and here is how long it took.                                |

The gaps are the most valuable output. A `static`-only endpoint may be dead
code; a `runtime`-only query is something your source reading would have missed.

Tracing is **opt-in** and lives in your app, not in FlowLens:

```ts
// NestJS / Express — development only
import { flowlensHttp, flowlensMongoose } from '@flowlens/runtime';

app.use(flowlensHttp());
mongoose.plugin(flowlensMongoose());
```

```ts
// Browser — links a click to the requests it causes
import { installBrowserTracer } from '@flowlens/runtime/browser';

installBrowserTracer();
```

Spans append to `.flowlens/trace.jsonl` in your own project. Then:

```bash
flowlens trace ./my-app
```

To see this without running anything, the example ships a synthetic recording:

```bash
node examples/clinic/demo-trace.mjs
node packages/cli/bin/flowlens.mjs trace examples/clinic
```

---

## What FlowLens does _not_ do

Worth being explicit, because a tool that reads your codebase should be boring
about its own boundaries:

- **It never connects to a database.** Not to read schemas, not to sample data,
  not ever. Collections and fields are derived from your source code. The
  Mongoose plugin is a timer around queries _your_ app already runs.
- **It never executes the code it analyzes.** The analyzer reads syntax trees;
  a project with a broken build still scans fine.
- **It makes no network calls.** No telemetry, no cloud, no account. The
  dashboard binds to `127.0.0.1`.
- **Everything stays local.** One `.flowlens/` directory inside your project.

---

## Supported stack

The MVP targets one stack properly rather than five badly:

| Layer    | Supported                                                                |
| -------- | ------------------------------------------------------------------------ |
| Frontend | React, Next.js — TypeScript _or_ plain JavaScript with JSX               |
| HTTP     | `fetch`, `axios`, configured clients, and named wrapper functions        |
| URLs     | literals, template strings, endpoint constants, interpolated base URLs   |
| Backend  | NestJS (decorators, DI, global prefixes), Express/Fastify routers        |
| Database | MongoDB via Mongoose (`@Schema`/`@Prop`, `new Schema()`, `@InjectModel`) |

Adapters are separate modules, so adding Prisma, PostgreSQL, or Vue is additive
rather than a rewrite. See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

---

## Repository layout

```text
flowlens/
├── packages/
│   ├── core/        graph engine, analyzers, flow resolver, impact, lineage
│   ├── runtime/      zero-dependency tracer (HTTP, Mongoose, browser)
│   └── cli/          the flowlens command
├── apps/
│   └── dashboard/    dependency-free web UI, served by the CLI
├── examples/
│   └── clinic/       React + NestJS + Mongoose fixture (source only)
├── tests/
│   ├── fixtures/
│   │   └── legacy-app/   a deliberately "real world" fixture: plain .js,
│   │                     wrapper functions, endpoint constants, /api prefix
│   └── *.test.ts         vitest suite (94 tests)
└── docs/
```

## Development

```bash
npm run build        # compile all three packages
npm test             # build, then run the suite (94 tests)
npm run test:watch
npm run scan:example
npm run serve:example
```

Uses npm workspaces rather than pnpm — same layout, one less thing to install.

## License

MIT
