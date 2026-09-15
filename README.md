# Flowslens

**Trace any user action from the UI to the database.**

[![CI](https://github.com/Kishan-Jaiswar/flowlens/actions/workflows/ci.yml/badge.svg)](https://github.com/Kishan-Jaiswar/flowlens/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/@flowslens/cli)](https://www.npmjs.com/package/@flowslens/cli)
[![Node](https://img.shields.io/badge/node-%3E%3D18.18-brightgreen)](https://nodejs.org)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue)](LICENSE)
[![Tests](https://img.shields.io/badge/tests-480%20passing-brightgreen)](tests)

> Flowslens helps developers understand and safely modify unfamiliar applications
> by tracing a feature from the user's UI action through frontend state and
> handlers, API calls, backend controllers and services, and database
> operations — while showing dependencies, data lineage, and execution time.

The question it answers is the one you actually ask on day three of a new
codebase:

> _I clicked this button. Show me everything that happened because of it._

---

## Project status

**v1.0.1, published on npm.** Honest summary of what is and is not proven:

|                        | State                                                                                                                                                                                                                         |
| ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Static analysis        | Verified against a real production codebase — ~1,500 files, 204 API calls, 197 matched to backend routes                                                                                                                      |
| Structure independence | Every layout in the table below has a fixture, hostile inputs included                                                                                                                                                        |
| Operating systems      | Windows, macOS and Linux: unit suite, every CLI command, and a from-scratch launcher run, all three in CI                                                                                                                     |
| Runtime tracing        | **Proven live for HTTP and method spans**: a real server, real sockets, a real trace file, merged into a real scan and asserted `confirmed`. The Mongoose plugin is still driven by fakes — a real database is the last piece |
| Stacks read            | React/Next, NestJS/Express, Mongoose, the MongoDB driver and Prisma. Vue, Svelte, TypeORM, GraphQL and raw SQL are not read yet, and `flowlens stack` tells you so before you spend the afternoon                             |
| Test suite             | 480 tests across 22 files, plus a smoke run of every CLI command and a pack-and-install test, on Linux, macOS and Windows                                                                                                     |

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

Flowslens turns that into:

```text
flowlens flow customerform-create-customer
```

---

## What you get

```text
$ flowlens flow orderform-submit-order examples/crud

Submit Order  (orderform-submit-order)
web/src/components/OrderForm.tsx:42
risk high (50)   evidence confirmed   373ms

Execution path
──────────────
USER ACTION
└── [ui action]   Submit Order
    web/src/components/OrderForm.tsx:42
│
▼
FRONTEND
└── [handler]     OrderForm.handleSubmit
    web/src/components/OrderForm.tsx:15
│
▼
NETWORK
├── [api call]    POST /orders
│   web/src/components/OrderForm.tsx:16
└── [route]       POST /orders
    api/src/orders/orders.controller.ts:9
│
▼
BACKEND
├── [method]      OrdersController.create
├── [method]      OrdersService.create
├── [method]      CustomersService.findById
├── [method]      ProductsService.assertAvailable
└── [method]      AuditService.record
│
▼
DATABASE
├── [db op]       customers.findById           read
├── [db op]       products.countDocuments      read
├── [db op]       orders.create                create
└── [db op]       auditlogs.create             create

Risk factors
────────────
  • writes to 2 collections: auditlogs, orders
  • AuditService.record is called from 5 places
  • touches 5 collections in one action
  • confirmed by runtime tracing
```

---

## Install

Requires **Node 18.18 or newer** to run — nothing else. No database, no global
config, no per-project plugin. (Working _on_ Flowslens needs Node 22.12 or newer;
see [Development](#development).)

Works on **Windows, macOS and Linux**. CI runs the suite on all three, and
separately runs every command a user actually types on all three, from a bare
checkout with nothing installed.

### The short way — no install at all

```bash
npx @flowslens/cli scan ~/code/my-app
npx @flowslens/cli serve ~/code/my-app
```

### Or install it once

```bash
npm install -g @flowslens/cli
flowlens scan ~/code/my-app
```

> **A note on the name.** The npm packages live under the **`@flowslens`**
> scope — `@flowslens/cli`, `@flowslens/core`, `@flowslens/runtime` — while the
> command you type, the config file and the cache directory are all spelled
> **`flowlens`**. So you install `@flowslens/cli` and then run `flowlens`.

### From source

If you want to modify Flowslens, or run it without touching npm:

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

### On your PATH, from a clone

`npm install -g @flowslens/cli` above is the easy route. From a clone, link the
workspace instead, so the `flowlens` on your PATH is the code you are editing:

```bash
npm install
npm run build
npm link -w @flowslens/cli
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
node examples/crud/demo-trace.mjs /tmp/demo-trace.jsonl
flowlens trace examples/crud --trace /tmp/demo-trace.jsonl
```

### If your terminal cannot draw boxes

The trees are drawn with box-drawing characters, which every modern terminal
renders — including Windows Terminal, PowerShell 7 and VS Code. On a legacy
Windows console with a raster font, Flowslens detects it and falls back to
`|`, `` ` `` and `v` automatically. To force either behaviour:

```bash
FLOWLENS_ASCII=1 flowlens flow customerform-create-customer      # plain ASCII
FLOWLENS_UNICODE=1 flowlens flow customerform-create-customer    # box characters
NO_COLOR=1 flowlens flows                          # no colour
```

Output redirected to a file always keeps the Unicode version, so a generated
document is never degraded by the terminal that produced it.

---

## Any project structure

Flowslens decides what a file is by **reading it**, not by where it sits. Folder
names are the least reliable thing about a real repository — `api/` is a Nest
backend in one project, an axios client in the next, and Next.js route handlers
in a third — so classification comes from decorators, imports and JSX.

Every layout below has a fixture in `tests/structures.test.ts`:

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
for the case where Flowslens is pointed somewhere enormous by mistake.

### Structure-agnostic is not framework-agnostic

An important distinction, because "works on any project" would be a lie:

**Any _layout_ of a supported stack works.** Flowslens does not care where your
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
    — those are not parsed yet. Flowslens currently reads React/Next
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

Textbook projects call `axios.post('/api/customers', body)`. Real ones do not, and
the defaults are built for the real ones.

**Separate repos.** A frontend and backend in sibling folders are scanned into
one graph — the seam between them is the whole point:

```bash
flowlens scan ./my-web ./my-api
flowlens scan ./api ./web ./mobile      # several consumers of one API
```

**A house-built request layer.** If your team wraps HTTP in named helpers,
Flowslens reads the verb from the function name and the path from the options
object:

```js
getRequest({ url: getUsersList, auth: true }); //  GET /users
patchRequestNoLoader({ url: getUser, params: `/${id}` }); //  PATCH /users/:id
```

The default pattern is `^(get|post|put|patch|delete)Request[A-Za-z0-9_]*$` —
strict enough that `getState()` and `deleteRow()` are not mistaken for HTTP
calls. Override it with `--request-fn '<regex>'` (capture group 1 is the verb).

**Endpoint constants.** Paths usually live in a constants module, not at the
call site. Flowslens resolves them automatically:

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

| Command                         | What it answers                                     |
| ------------------------------- | --------------------------------------------------- |
| `flowlens stack [project]`      | What is this built with? Frameworks, with versions. |
| `flowlens init [project]`       | Where does this project keep its two halves?        |
| `flowlens scan [project]`       | Build the graph, into a cache outside the repo.     |
| `flowlens flows [project]`      | Which user actions reach the backend?               |
| `flowlens flow <id>`            | Everything one click does, end to end.              |
| `flowlens flow <id> --markdown` | Generate a living feature document.                 |
| `flowlens where <file>:<line>`  | What is this code for? Features running through it. |
| `flowlens impact <symbol>`      | If I change this, what breaks?                      |
| `flowlens doctor [project]`     | Broken API calls, dead endpoints, shared writes.    |
| `flowlens trace [project]`      | Merge recorded runtime spans into the graph.        |
| `flowlens serve [project]`      | The dashboard.                                      |

Add `--json` to any command to get machine-readable output.

`serve` opens your browser when you are at a terminal, and stays quiet when it
is piped or scripted (`--open` and `--no-open` override that). If port 4177 is
busy it moves to the next free one and tells you — unless you asked for a
specific `--port`, in which case a busy port is an error rather than a surprise.

### What is this code for?

`flow <id>` goes forward from a click. `where` goes the other way: you are
reading line 20 of a file you did not write, and the question is not what the
code does but which features break if you change it.

```text
$ flowlens where web/src/components/OrderForm.tsx:20 examples/crud

Nearest declaration
───────────────────
  [api-call] POST /orders  line 16  (4 lines above)

Features running through here (1)
─────────────────────────────────
feature       via                    endpoint      data                    risk  flow id
────────────  ─────────────────────  ────────────  ──────────────────────  ────  ──────────────────────
Submit Order  api-call POST /orders  POST /orders  customers, products +2  high  orderform-submit-order
  ⚠ 1 high-risk feature depends on this
  ⚠ reaches 4 collections

Elsewhere in this file (3)
──────────────────────────
  line 35  Order form change (orderform-textarea-onchange)
  line 43  Print Order (orderform-print-order)
```

No node is declared on line 20 — it is inside `handleSubmit`'s body — so the
answer is the nearest declaration above it, and the output says so rather than
pretending the hit was exact. A location can be a bare filename
(`OrderForm.tsx`), an absolute path, or a Windows one; a basename that matches
two files lists them instead of guessing, because every App Router project has a
dozen `route.ts`.

A `useState` field, a DTO or a schema field does not sit _on_ the execution path,
so a match there is followed one hop out to the handler that uses it and marked
`*`. That is the same one-hop rule the flow tree uses for `StepDetail`, and the
same reason: `defines` walked transitively pulls in half the app.

### What a feature is called

`Submit` is not a feature name in an app with fifteen of them, so every user
action is named after the part of the product it belongs to as well as the thing
the user pressed:

```text
Order · Submit                         pages/order/[id].js
Customer detail · Complete shipment    pages/customer_detail/[id].js
Inventory · Mapping cell click         components/inventory/StockProducts.js
SKU screen loads                       pages/sku-screen/[id].js
```

The screen comes from the path on disk, where the framework already records it:
a route segment for a page (`pages/order/[id].js` → **Order**), the
feature folder for a component (`components/customer_detail/…` → **Customer
detail**), and the component's own name when neither says anything. The action is
the text on the element, falling back to a labelling prop, the text just inside
it, or the handler's name — and for an icon with none of those, the component and
the gesture (**Mapping cell click**). A screen the button text already names is
not repeated: `Submit Order` stays as it is.

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
- **Collections behind a factory.** With the native driver, `const { products }
= await getCollections()` is a destructured binding whose literal lives in
  another file. The `name: db.collection('x')` pairs are collected project-wide,
  and the literal is read rather than the property name conventionalised —
  `smsTemplates: db.collection('smsendpointmaps')` is why.
- **Requests inside a data hook.** React Query's idiom is `const create =
useCreateProduct()` then `create.mutate(values)`, so the request is two hops
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

A collection appears once **per effect**, so an action that reads `customers` and
then edits them shows both — collapsing that into "writes customers" would lose
where the data came from. `updateOne`/`updateMany` are reported as `update` even
though `{ upsert: true }` can insert.

The dashboard groups this above the database tiles, `flowlens flow` prints the
effect beside each query, and a generated feature document gets a **Collections
touched** table.

---

## Static plus runtime

Static analysis proves a path **can** exist. Runtime tracing proves it **did**.
Flowslens keeps both and labels every node accordingly:

| Evidence    | Meaning                                                                                    |
| ----------- | ------------------------------------------------------------------------------------------ |
| `static`    | Found in source. Not yet observed running.                                                 |
| `runtime`   | Observed running, but the analyzer never found it — dynamic routing, an ORM helper, drift. |
| `confirmed` | Both agree. This is the path, and here is how long it took.                                |

The gaps are the most valuable output. A `static`-only endpoint may be dead
code; a `runtime`-only query is something your source reading would have missed.

Tracing is **opt-in** and lives in your app, not in Flowslens:

```ts
// NestJS / Express — development only
import { flowlensHttp, flowlensMongoose } from '@flowslens/runtime';

app.use(flowlensHttp());
mongoose.plugin(flowlensMongoose());
```

```ts
// Browser — links a click to the requests it causes
import { installBrowserTracer } from '@flowslens/runtime/browser';

// The endpoint, token and all, is printed by `flowlens serve`.
installBrowserTracer({
  endpoint: 'http://127.0.0.1:4177/__flowlens/spans?token=…',
});
```

If you would rather not add a dependency to the app you are tracing, load the
tracer from the running dashboard instead — nothing is copied into your project:

```js
// development only — copy this line from the `tracer:` line `flowlens serve` prints
import('http://127.0.0.1:4177/__flowlens/browser.js?token=…').then((m) =>
  m.installBrowserTracer(),
);
```

Loaded that way the tracer reads its own URL, so the token comes along and there
is nothing else to configure. The collector requires it: the endpoint has to
accept requests from your app's origin, so it cannot tell who is asking and asks
what they know instead — otherwise any page in your browser could forge spans,
and a forged span is worse than a missing one, because merged into the graph it
reads as `confirmed`.

The tracer is served by the dashboard, so there is no file to copy into your
project. Spans append to a machine-local cache — never to your repository — and
`flowlens serve` prints the exact path. Then:

```bash
flowlens trace ./my-app
```

To see this without running anything, the example ships a synthetic recording:

```bash
node examples/crud/demo-trace.mjs /tmp/demo-trace.jsonl
node packages/cli/bin/flowlens.mjs trace examples/crud --trace /tmp/demo-trace.jsonl
```

---

## The dashboard's six tabs

`flowlens serve` opens one feature at a time and asks six questions about it,
in the order a developer actually asks them. Each tab carries its own headline
number, so the worrying one is visible before you open it:

```text
Flow · 24   APIs · 1   Timing · no runs   Breaks · 2   Tests · none   Changed · 5
```

**Changed** is the one to reach for mid-edit. It ignores the selected feature and
asks the project-wide question instead — what have I touched, and what runs
through it:

```text
high risk   1 changed file is used by 5 features; 5 of them have no test.

Features affected, most-touched first
  Medicines · Delete   MedicinesView        no test
    DELETE /medicines/:param             app/api/medicines/[id]/route.ts:1
  Medicines · Delete   MedicineDetailPage   no test
    DELETE /medicines/:param             app/api/medicines/[id]/route.ts:38
```

Unlike Timing it needs no instrumentation, and unlike Tests it says something
useful on a project with none — so it works from the first minute. Every
`file:line` in every tab opens your editor (`?editor=vscode`, `cursor`, `idea`,
`zed`, …).

**APIs** is the seam in full — one request, everything about it, which ends the
clicking-around it used to take to answer "what does this endpoint actually do":

```text
POST /auth/verify-otp          matched   file-route   static

Request         Sent with     apiClient
                Called from   features/auth/api.ts:37
Body            keys, where each value comes from, and whether the route declares it
Before handler  guards, pipes and middleware that can stop the request
Code it runs    verifyOtp          lib/auth/user-store.ts:125
                findOrCreateUser   lib/auth/user-store.ts:161
Data it touches otps    findOne     read     verifyOtp          …user-store.ts:127
                otps    updateOne   update   verifyOtp          …user-store.ts:135
                users   insertOne   create   findOrCreateUser   …user-store.ts:175
Leaves the app  cache (get), cache (set)     lib/db/clinics.ts:49
Who else uses it   the other features calling the same endpoint
```

**An action that makes several requests is shown as a sequence**, because "several
calls" covers three shapes that used to be indistinguishable — every call came
out at the same depth, in whatever order the scan happened to read them:

```text
1 GET /carts/current  →  2 POST /orders  →  3 POST /payments

1  GET /carts/current    sent first
2  POST /orders          needs the response from GET /carts/current
3  POST /payments        needs the response from GET /carts/current and POST /orders
```

| In the code                                                                 | What the tab says                             |
| --------------------------------------------------------------------------- | --------------------------------------------- |
| `const a = await get(); post({ id: a.id })`                                 | needs the response from `GET …`               |
| `post(…).then(() => put(…))`                                                | only after `POST …` resolves                  |
| `Promise.all([get(a), get(b)])`                                             | sent at the same time as `GET …`              |
| `useEffect(() => get(…), [user])`, where another call does `.then(setUser)` | re-runs when the state set by `GET …` arrives |
| `useEffect(() => get(…), [])`                                               | sent once, when the screen loads              |

The React-state case is the one source order cannot see: the effect that waits is
idiomatically written _above_ the fetch it depends on. Flowslens pairs the
`useEffect` dependency array with the state a call's result flows into
(`.then(setUser)`, `setUser(result)`, or a query hook's `data:` binding) and
reorders so the producer comes first — `GET /me` is reported first even when it
is written second. It is phrased as "re-runs when…" because that is a weaker
promise than reading a response: the effect fires on a later render, and again
whenever that state changes.

A component that loads its data through `useEffect` also now gets a mount action
at all. It previously had none — the mount pass looked for functions the
component calls, and an effect produces no such function — so that shape of
screen was missing from the feature list entirely.

The dependency is read from the data, not from line order: an earlier call bound
its result to a variable and this call's arguments mention it. A `.then` chain is
reported separately because it is a _control_ dependency — the second call cannot
run at all unless the first resolved, whether or not it uses the response. And
when calls are fired without awaiting, the tab says so rather than implying an
order the code does not guarantee.

Conditional requests are not described as a sequence. Two calls in opposite arms
of one `if` share a step number and are joined with `or`, a `catch` request is
marked as an error path, and a condition beats every ordering phrase — "sent
second" is false for a call that may not be sent at all.

And the round trip finishes. Each request reports **what comes back** — the
status codes the endpoint has really answered with, and the state the response
lands in — followed by one block for the action as a whole:

```text
AFTER THE RESPONSE                                    failures handled

Goes to        /medicines
Refetches      queryKeys.medicines.all  → GET /medicines, GET /medicines/:param
               queryKeys.dashboard      → GET /dashboard
The user sees  toast: Saved
               toast: Could not save
```

Cache invalidation is the continuation no amount of reading the handler reveals:
`invalidateQueries` fires fresh requests from components you are not looking at.
Keys are paired to endpoints by name on a path segment, and the panel says so —
the alternative is reading key factories, which are ordinary functions and can
be anything. A feature where nothing catches a rejection is called out, because
an unhandled rejection is a different outcome from an error message.

Plus a copyable `curl`, with `:param` placeholders left as-is rather than filled
with an invented id. The payload-versus-DTO check lives here, per request,
because agreeing about a body is a fact about an endpoint. It needs a declared
shape — NestJS DTO classes today — so a Next.js route that validates with Zod
reports "no DTO to check" rather than guessing, and a body built from a variable
rather than an object literal is reported as unreadable rather than as absent.

| Tab         | The question                                                | Where the answer comes from                                                     |
| ----------- | ----------------------------------------------------------- | ------------------------------------------------------------------------------- |
| **Flow**    | What happens when a user does this?                         | The static graph: click → handler → request → route → service → collection      |
| **APIs**    | What exactly does it request, and what happens server-side? | The seam in full: body, guards, DTO, handlers, collections, other callers       |
| **Timing**  | Where does the time go?                                     | Runtime spans only. No spans, no numbers — it tells you how to get them instead |
| **Breaks**  | What else would a change here break?                        | The graph walked backwards from every step of this flow                         |
| **Tests**   | What would catch it if you broke it?                        | Which test files import the files this flow runs through                        |
| **Changed** | What do my uncommitted edits put at risk?                   | `git status` crossed with the graph — project-wide, not per feature             |

**Breaks** is the one that changes how you work. A flow read on its own is
quietly misleading: it shows a chain as though it belonged to this feature, when
most of the chain is shared. Editing `CustomersService.findOne` because one
screen needs an extra field is a five-minute change that breaks four other
screens — and the flow view gives you no hint, because every step looks equally
yours. The Breaks tab splits the same steps into two lists:

```text
medium risk   8 steps of this feature are shared with 3 other features,
              and 1 collection is written by more than one place.

Features that could break
  Customers · Search    — shares 6 steps with this one
  Submit Order          — shares 2 steps with this one
  Create Customer       — shares 2 steps with this one

Shared steps, most-shared first
  AuditService.record        method     2 other features
  api/src/common/audit.service.ts:16
  → Submit Order · Create Customer

Collections more than one place writes
  customers  written by  CustomersService.create · CustomersService.archive
                         CustomersService.remove · ImportsService.importCustomers

▸ 8 steps only this feature uses — safe to change
```

That last line is the point: "safe to change" and "shared, be careful" are
different lists, visible _before_ the edit rather than after the bug report.
Clicking any feature name jumps to it, staying on the same tab.

The same three answers are available without the browser —
`analyzeFlowImpact`, `flowTiming`, `indexTests` and `testsForFlow` are exported
from `@flowslens/core`, and `GET /api/insight?flow=<id>` returns all three in
one response.

## What Flowslens does _not_ do

Worth being explicit, because a tool that reads your codebase should be boring
about its own boundaries:

- **It never connects to a database.** Not to read schemas, not to sample data,
  not ever. Collections and fields are derived from your source code. The
  Mongoose plugin is a timer around queries _your_ app already runs.
- **It never executes the code it analyzes.** The analyzer reads syntax trees;
  a project with a broken build still scans fine.
- **It makes no network calls.** No telemetry, no cloud, no account. The
  dashboard binds to `127.0.0.1`.
- **The dashboard answers the dashboard, and nothing else.** Binding to
  localhost is not by itself protection — every page open in your browser is
  already on localhost — so `/api/*` sends no CORS headers, rejects a request
  carrying another page's `Origin`, and rejects one addressed to a _name_
  rather than an address, which is how DNS rebinding arrives. Span collection
  has to accept cross-origin writes, so it requires the per-run token that
  `serve` prints. Bind somewhere reachable with `--host` and the token guards
  the whole API, with a warning at startup saying so.
- **It keeps out of your commits.** The graph and any trace live in your OS
  cache directory (`~/.cache/flowlens` on Linux, honouring
  `XDG_CACHE_HOME`; `~/Library/Caches/flowlens` on macOS;
  `%LOCALAPPDATA%\flowlens\Cache` on Windows), keyed by project path, so
  `git status` after a scan is empty. `flowlens init` writes a config because that is
  what you asked it to do — and adds it to `.gitignore` in the same breath, so
  the one file Flowslens creates never becomes your problem. `--print` avoids
  writing anything at all. Pass `-g` /
  `--trace` to choose your own paths, or set `FLOWLENS_CACHE` (absolute paths
  only) to move the whole cache.
- **If you do move an artifact into the repo, Flowslens ignores it for you.**
  This is the default, because the alternative puts the cost on the wrong
  person: a developer who added a read-only dev tool should never have to
  discard its output before committing their own work, on every branch, forever.
  A `-g graph.json`, a `--trace`, or a `$FLOWLENS_TRACE` pointing inside a work
  tree earns one line and a managed block:

  ```text
  gitignore: added /graph.json to .gitignore — Flowslens output stays out of your commits
  ```

  ```gitignore
  # flowlens:begin (managed by Flowslens)
  /graph.json
  # flowlens:end
  ```

  The scope is what makes editing the file defensible. Only paths Flowslens
  itself writes are added — never a block of speculative patterns — and only
  when they are inside a work tree, which in the default setup they are not, so
  `.gitignore` is usually never opened at all. Only the marked block is
  rewritten; every line you wrote survives byte for byte, and re-running
  changes nothing. Patterns are anchored, so `/graph.json` cannot also hide a
  `src/graph.json` of your own. Every addition is printed, because a tool that
  writes silently is a tool you stop trusting the moment you notice. And if the
  artifact is already committed it says so, because `git rm --cached` is the
  real fix.

  **`flowlens.config.json` is ignored too**, because Flowslens is what wrote it.
  On a default setup it is the _only_ file the tool puts in your project, and
  leaving it out meant `?? flowlens.config.json` sat in `git status` on every
  branch forever — exactly the chore this is meant to remove. A config you have
  deliberately **committed** is left alone: a pattern for a tracked file changes
  nothing, and adding one would read as a fix while doing nothing. If your team
  wants to share scan settings, commit the file and Flowslens stops touching it.

  Nothing is ever added for a file that does not exist. A project with no config
  gets no pattern for one.

  `--no-gitignore`, or `"gitignore": false` in the config, restores the old
  report-only behaviour: it tells you what would show up in `git status` and
  changes nothing.

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
│   └── crud/             React + NestJS + Mongoose fixture (source only)
├── scripts/              build, clean and smoke-test helpers (plain Node)
├── tests/
│   ├── fixtures/
│   │   └── legacy-app/   a deliberately "real world" fixture: plain .js,
│   │                     wrapper functions, endpoint constants, /api prefix
│   └── *.test.ts         vitest suite
└── docs/
```

## Development

**Use Node 22.12 or newer to work on Flowslens.** The published CLI still
supports 18.18, and CI proves it, but the test runner has a higher floor than
the product: Vitest 5 declares `^22.12 || ^24 || >=26` and jsdom 30
`^22.22 || ^24.15 || >=26`. On Node 18 `npm test` dies with a `SyntaxError`
rather than a useful message. `.nvmrc` pins the version this project is
developed on:

```bash
nvm use              # or `nvm install` the first time
node --version       # expect the version in .nvmrc
```

```bash
npm install          # also builds, via the prepare script
npm run build        # compile all three packages
npm test             # build, then run the suite — 480 tests, ~10s
npm run test:watch
npm run smoke        # run every CLI command for real, on this OS
npm run test:package # pack, install into a throwaway project, drive over HTTP
npm run clean
npm run verify       # lint + format check + build + test
npm run scan:example
npm run serve:example
```

Uses npm workspaces rather than pnpm — same layout, one less thing to install.
Every script is plain Node, with no shell built in, so they all work the same on
Windows, macOS and Linux.

The three packages are published under the `@flowslens` scope while the command
stays `flowlens`; `scripts/package-test.mjs` reads the scope out of
`packages/cli/package.json` rather than hardcoding it.

CI runs the unit suite on Node 22/24/26 on Linux plus Node 24 on Windows and
macOS, the smoke test on all three operating systems, and — separately — the
launcher on all three from a checkout with nothing installed, which is the
first thing a new user does.

## License

MIT
