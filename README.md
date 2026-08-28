# FlowLens

**Trace any user action from the UI to the database.**

[![CI](https://github.com/Kishan-Jaiswar/flowlens/actions/workflows/ci.yml/badge.svg)](https://github.com/Kishan-Jaiswar/flowlens/actions/workflows/ci.yml)
[![Node](https://img.shields.io/badge/node-%3E%3D18.18-brightgreen)](https://nodejs.org)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue)](LICENSE)
[![Tests](https://img.shields.io/badge/tests-200%20passing-brightgreen)](tests)

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
| Operating systems      | Windows, macOS and Linux: unit suite, every CLI command, and a from-scratch launcher run, all three in CI                                     |
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
├── [db op]       prescriptions.create         create
└── [db op]       auditlogs.create             create

Risk factors
────────────
  • writes to 2 collections: auditlogs, prescriptions
  • AuditService.record is called from 5 places
  • touches 5 collections in one action
  • confirmed by runtime tracing
```

---

## Install

Requires **Node 18.18 or newer** — nothing else. No database, no global config,
no per-project plugin.

Works on **Windows, macOS and Linux**. CI runs the suite on all three, and
separately runs every command a user actually types on all three, from a bare
checkout with nothing installed.

### The short way

```bash
git clone https://github.com/Kishan-Jaiswar/flowlens.git
cd flowlens
```

Then just run it. The first command installs and builds by itself:

```bash
./flowlens scan ~/code/my-app          # macOS, Linux
```

```bat
flowlens.cmd scan C:\code\my-app       :: Windows (cmd or PowerShell)
```

That is the whole setup. The launcher installs dependencies and compiles on
first use, notices later when the sources are newer than the build, and
otherwise stays out of the way. It is also why the project works from a USB
stick: copy the folder to any machine with Node on it and the first command
still works.

### On your PATH

If you would rather type `flowlens` from anywhere:

```bash
npm install
npm run build
npm link -w @flowlens/cli
```

Or, without installing anything globally:

```bash
npm run flowlens -- scan ~/code/my-app
```

### Start on a project you have never scanned

```bash
cd ~/code/my-app
flowlens init          # detects the layout, writes flowlens.config.json
flowlens scan          # from anywhere inside the project
flowlens serve         # dashboard, opens your browser
```

`init` looks at what is actually on disk. It finds a monorepo's `web/` and
`api/` directories, and it finds the very common case where the frontend and
backend are **separate sibling repositories** — `~/code/shop-web` next to
`~/code/shop-api` — because the seam between them is the interesting part:

```jsonc
// ~/code/shop-web/flowlens.config.json, written by `flowlens init`
{
  "roots": [".", "../shop-api"],
  "apiPrefixes": ["/api"],
}
```

Commit that file and everyone on the team gets the same graph. Because the
paths in it are relative and use `/`, it keeps working on someone else's machine
and on a different operating system.

You never have to run `init` — every flag it writes can be typed on the command
line instead, and a project with a conventional layout needs neither.

### Naming a project

Any spelling your shell hands over works, on any platform:

```bash
flowlens scan my-app                   # a plain directory name
flowlens scan ./my-app                 # relative
flowlens scan .\my-app                 # relative, Windows
flowlens scan C:\code\my-app           # absolute, Windows
flowlens scan ~/code/my-app            # home-relative
flowlens scan ~/code/my-web ~/code/my-api   # two repos, one graph
```

A path that does not exist is an error, not a silent scan of the wrong
directory.

### Try it on the bundled example

A source-only React + NestJS + Mongoose app, never executed, no database:

```bash
npm run scan:example
npm run flows:example
npm run serve:example

# and a synthetic recording, so the runtime merge is demoable with no server
node examples/clinic/demo-trace.mjs /tmp/demo-trace.jsonl
flowlens trace examples/clinic --trace /tmp/demo-trace.jsonl
```

### If your terminal cannot draw boxes

The trees are drawn with box-drawing characters, which every modern terminal
renders — including Windows Terminal, PowerShell 7 and VS Code. On a legacy
Windows console with a raster font, FlowLens detects it and falls back to
`|`, `` ` `` and `v` automatically. To force either behaviour:

```bash
FLOWLENS_ASCII=1 flowlens flow create-patient      # plain ASCII
FLOWLENS_UNICODE=1 flowlens flow create-patient    # box characters
NO_COLOR=1 flowlens flows                          # no colour
```

Output redirected to a file always keeps the Unicode version, so a generated
document is never degraded by the terminal that produced it.

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

`flowlens init` writes a starting point for you; everything below can also be
edited by hand or passed as flags.

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

Paths in `roots` are resolved **relative to the config file**, not to the shell's
working directory, and should be written with `/` on every platform. That is what
lets one committed file work for everyone on the team, whatever machine they are
on.

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
| `flowlens init [project]`       | Where does this project keep its two halves?     |
| `flowlens scan [project]`       | Build the graph, into a cache outside the repo.  |
| `flowlens flows [project]`      | Which user actions reach the backend?            |
| `flowlens flow <id>`            | Everything one click does, end to end.           |
| `flowlens flow <id> --markdown` | Generate a living feature document.              |
| `flowlens impact <symbol>`      | If I change this, what breaks?                   |
| `flowlens doctor [project]`     | Broken API calls, dead endpoints, shared writes. |
| `flowlens trace [project]`      | Merge recorded runtime spans into the graph.     |
| `flowlens serve [project]`      | The dashboard.                                   |

Add `--json` to any command to get machine-readable output.

`serve` opens your browser when you are at a terminal, and stays quiet when it
is piped or scripted (`--open` and `--no-open` override that). If port 4177 is
busy it moves to the next free one and tells you — unless you asked for a
specific `--port`, in which case a busy port is an error rather than a surprise.

### What a feature is called

`Submit` is not a feature name in an app with fifteen of them, so every user
action is named after the part of the product it belongs to as well as the thing
the user pressed:

```text
Prescription · Submit                    pages/prescription/[id].js
Patient detail · Complete appointment    pages/patient_detail/[id].js
Medication · Mapping cell click          components/medication/StockMedications.js
Rx screen loads                          pages/rx-screen/[id].js
```

The screen comes from the path on disk, where the framework already records it:
a route segment for a page (`pages/prescription/[id].js` → **Prescription**), the
feature folder for a component (`components/patient_detail/…` → **Patient
detail**), and the component's own name when neither says anything. The action is
the text on the element, falling back to a labelling prop, the text just inside
it, or the handler's name — and for an icon with none of those, the component and
the gesture (**Mapping cell click**). A screen the button text already names is
not repeated: `Submit Prescription` stays as it is.

Both halves stay separate in the graph, so a flow keeps `label` (the words on the
element), `screen`, and the composed `title` that lists and tiles show. `--json`
returns all three.

---

## What one action shows you

Every action resolves to a chain, and each step carries its own contract — not
just what ran next, but what it ran _with_:

| Layer       | What you get                                                                                       |
| ----------- | -------------------------------------------------------------------------------------------------- |
| User action | The words on the element, the component that renders it, the file and line                         |
| Frontend    | Handlers in the chain, the state each one sets and reads, the custom hooks in play                 |
| Network     | Method and path, **query parameters**, **request body keys** and the identifier each came from     |
| Backend     | Route → controller → service methods, and the **DTO** the route validates against, with its fields |
| Database    | The query, its effect, the **schema** behind it with its fields, and the collection                |

The left pane draws the chain; clicking any step opens its contract in the side
panel; the panel's default view lists the whole chain in execution order.
`flowlens flow <id>` prints the same thing as a tree, and `--markdown` adds
**What each request sends** and **Collections touched** tables.

### Stacks where the chain hides in the middle

The layers are usually all findable; what breaks is the _join_ between them.
Three joins are handled explicitly because each one silently emptied a layer:

- **Queries in a plain module.** `app/api/stock/route.ts` calls
  `adjustStock()` from `lib/db/store.ts`. Neither the Nest pass (no decorators)
  nor the route pass (wrong file) reaches it, so the queries are followed into
  the module and attributed to the function that makes them.
- **Collections behind a factory.** With the native driver, `const { medicines }
= await getCollections()` is a destructured binding whose literal lives in
  another file. The `name: db.collection('x')` pairs are collected project-wide,
  and the literal is read rather than the property name conventionalised —
  `smsTemplates: db.collection('smsendpointmaps')` is why.
- **Requests inside a data hook.** React Query's idiom is `const create =
useCreateMedicine()` then `create.mutate(values)`, so the request is two hops
  from the click and the middle hop is a method on a returned object. Receivers
  are resolved through the hook alias table.

A route module exporting several verbs gets **one handler per verb**, so a flow
through the `PUT` does not inherit the `DELETE`'s query. And a `useQuery`-style
hook counts as a mount action, because it fetches on render — unlike
`useMutation`, which waits for a click.

### Every action, including the ones that are not clicks

`onClick`, `onSubmit`, `onPress` and `onDoubleClick` are the deliberate
gestures. But a file upload is an `onChange`, an autosave is an `onBlur`, and a
search is often an `onKeyDown` — so those are detected too, along with
`onFocus`, `onInput`, `onKeyUp`, `onKeyPress`, `onSelect`, `onToggle`, `onDrop`,
`onClose`, `onCancel`, `onOk`, `onSearch`, `onFinish`, `onMouseDown`,
`onMouseUp` and `onScroll`.

They are marked `input` rather than `gesture` in the node's `eventClass`. Most
`onChange` handlers only set local state, and those stay behind the same
**include local-only actions** filter as any other purely local interaction — so
the default list is still the actions that reach the backend, without the
keystroke noise, and nothing is silently missing.

---

## Which collections, and what happened to them

The data layer answers two questions, not one: where the data on screen came
from, and what the action did to the database. So every query is labelled with
its **effect** rather than a read/write flag:

| Effect   | Meaning                         | Operations                                                                     |
| -------- | ------------------------------- | ------------------------------------------------------------------------------ |
| `read`   | Where the data came from        | `find`, `findOne`, `findById`, `aggregate`, `count*`, `distinct`, `exists`     |
| `create` | Documents inserted              | `create`, `insertOne`, `insertMany`, `new Model(...).save()`                   |
| `update` | Existing documents changed      | `updateOne`, `updateMany`, `replaceOne`, `findOneAndUpdate`, `find*AndReplace` |
| `delete` | Documents removed               | `deleteOne`, `deleteMany`, `remove`, `find*AndDelete`, `findByIdAndRemove`     |
| `write`  | A write whose effect is unknown | `save()` on an existing document, `bulkWrite()`                                |

`write` is deliberately vague and deliberately kept: a bare `save()` inserts a
new document and updates an existing one, and `bulkWrite` can do both plus
delete, so the call site does not carry the answer. Naming one anyway would be a
wrong finding rather than a missing one.

A collection appears once **per effect**, so an action that reads `patients` and
then edits them shows both — collapsing that into "writes patients" would lose
where the data came from. `updateOne`/`updateMany` are reported as `update` even
though `{ upsert: true }` can insert.

The dashboard groups this above the database tiles, `flowlens flow` prints the
effect beside each query, and a generated feature document gets a **Collections
touched** table.

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

If you would rather not add a dependency to the app you are tracing, load the
tracer from the running dashboard instead — nothing is copied into your project:

```js
// development only
import('http://127.0.0.1:4177/__flowlens/browser.js').then((m) =>
  m.installBrowserTracer(),
);
```

The tracer is served by the dashboard, so there is no file to copy into your
project. Spans append to a machine-local cache — never to your repository — and
`flowlens serve` prints the exact path. Then:

```bash
flowlens trace ./my-app
```

To see this without running anything, the example ships a synthetic recording:

```bash
node examples/clinic/demo-trace.mjs /tmp/demo-trace.jsonl
node packages/cli/bin/flowlens.mjs trace examples/clinic --trace /tmp/demo-trace.jsonl
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
- **It never writes to your project.** The graph and any trace live in your OS
  cache directory (`~/.cache/flowlens` on Linux, `~/Library/Caches/flowlens` on
  macOS, `%LOCALAPPDATA%\flowlens` on Windows), keyed by project path. `git
status` after a scan is empty. `flowlens init` is the one exception, and only
  because writing a config is what you asked it to do — `--print` avoids even
  that. Pass `-g` / `--trace` to choose your own paths, or set `FLOWLENS_CACHE`
  to move the whole cache.

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
├── flowlens              launcher for macOS and Linux
├── flowlens.cmd          launcher for Windows
├── bin/
│   └── flowlens.mjs      installs and builds on first use, then hands over
├── packages/
│   ├── core/             graph engine, analyzers, flow resolver, impact, lineage
│   ├── runtime/          zero-dependency tracer (HTTP, Mongoose, browser)
│   └── cli/              the flowlens command
├── apps/
│   └── dashboard/        dependency-free web UI, served by the CLI
├── examples/
│   └── clinic/           React + NestJS + Mongoose fixture (source only)
├── scripts/              build, clean and smoke-test helpers (plain Node)
├── tests/
│   ├── fixtures/
│   │   └── legacy-app/   a deliberately "real world" fixture: plain .js,
│   │                     wrapper functions, endpoint constants, /api prefix
│   └── *.test.ts         vitest suite
└── docs/
```

## Development

```bash
npm install          # also builds, via the prepare script
npm run build        # compile all three packages
npm test             # build, then run the suite
npm run test:watch
npm run smoke        # run every CLI command for real, on this OS
npm run clean
npm run verify       # lint + format + test
npm run scan:example
npm run serve:example
```

Uses npm workspaces rather than pnpm — same layout, one less thing to install.
Every script is plain Node, with no shell built in, so they all work the same on
Windows, macOS and Linux.

CI runs the unit suite on Node 20/22/24/26 on Linux plus Node 24 on Windows and
macOS, the smoke test on all three operating systems, and — separately — the
launcher on all three from a checkout with nothing installed, which is the
first thing a new user does.

## License

MIT
