# @flowslens/cli

**Trace any user action from the UI to the database.**

[![npm version](https://img.shields.io/npm/v/@flowslens/cli)](https://www.npmjs.com/package/@flowslens/cli)
[![npm downloads](https://img.shields.io/npm/dm/@flowslens/cli)](https://www.npmjs.com/package/@flowslens/cli)
[![CI](https://github.com/Kishan-Jaiswar/flowlens/actions/workflows/ci.yml/badge.svg)](https://github.com/Kishan-Jaiswar/flowlens/actions/workflows/ci.yml)
[![Node](https://img.shields.io/badge/node-%3E%3D18.18-brightgreen)](https://nodejs.org)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue)](https://github.com/Kishan-Jaiswar/flowlens/blob/main/LICENSE)

A free, local code-flow explorer for full-stack JavaScript and TypeScript. Point
it at a **React / Next.js** frontend and a **NestJS, Express, Fastify or
Next.js API** backend, and it shows every user action end to end — the click,
the handler, the HTTP request, the route, the service, and the **Mongoose,
MongoDB or Prisma** query — as a tree, a flowchart of every decision, and a
local dashboard. It also tells you **what an edit breaks** before you commit
it, finds **unused code**, and answers questions for your AI assistant over
**MCP**.

You join a project. You need to change one screen. So you start clicking through
files: which handler runs, which endpoint it calls, which service answers, which
collection it writes. Eight tools and an afternoon later you still do not know
what _else_ writes that collection.

Flowslens reads your source and answers in one command.

```bash
npx @flowslens/cli scan .
```

It only reads files. It never connects to a database, never runs your code, and
never writes anything into your project.

---

## First: will this work on my project?

Flowslens reads a specific set of stacks. Check here before installing — if your
stack is on the right, you will get a file count and little else.

| It reads today                                                              | Not yet                            |
| --------------------------------------------------------------------------- | ---------------------------------- |
| **React** and **Next.js** (`pages/` and App Router)                         | Vue, Svelte, Angular, Astro        |
| **NestJS**, **Express**, **Fastify**                                        | Django, Rails, Go, Java, .NET, PHP |
| Next.js `pages/api` + App Router handlers, **Nuxt** `server/api`            | GraphQL and tRPC resolvers         |
| **MongoDB** via Mongoose or the native driver, and **Prisma**               | TypeORM, Sequelize, raw SQL        |
| TypeScript **or** plain JavaScript with JSX (`.js`, `.jsx`, `.mjs`, `.cjs`) | Queues, cron jobs, websockets      |

So the sweet spot is **React/Next + NestJS, Express or Next.js API routes +
Mongoose, MongoDB or Prisma**. Any _folder
layout_ of those works — Flowslens decides what a file is by reading it, not by
which directory it sits in, and a frontend and backend in separate repositories
is a first-class case.

Point it at something unsupported and it says so plainly, rather than reporting
zero and letting you assume it is broken.

---

## Install

```bash
npm install -g @flowslens/cli
```

Or run it without installing anything:

```bash
npx @flowslens/cli scan .
```

Requires **Node 18.18 or newer**. Nothing else — no database, no config file, no
plugin in your project.

> **The package is `@flowslens/cli`. The command is `flowlens`.** The extra `s`
> is in the npm scope only.

---

## Your first two minutes

### 1. Scan

```bash
cd ~/code/my-app
flowlens scan
```

This is the only command you need to remember. It prints what it found, what
looks wrong, every feature it can trace, and the command to run next:

```text
Feature flows (6)
─────────────────
id                            action               endpoint                       collections
────────────────────────────  ───────────────────  ─────────────────────────────  ───────────────────────────────────
customerspage-delete          Customers · Delete   DELETE /customers/:param       customers,auditlogs
orderform-submit-order        Submit Order         POST /orders                   customers,products,auditlogs,orders
customerform-create-customer  Create Customer      POST /customers                auditlogs,customers

next:  flowlens flow customerspage-delete
   or:  flowlens serve
```

### 2. Pick a feature and follow it

Copy any `id` from that table:

```bash
flowlens flow orderform-submit-order
```

```text
Submit Order  (orderform-submit-order)
web/src/components/OrderForm.tsx:42
risk high (50)   evidence static

USER ACTION
└── [ui action]   Submit Order
    web/src/components/OrderForm.tsx:42
│
▼
FRONTEND
└── [handler]     OrderForm.handleSubmit
    web/src/components/OrderForm.tsx:15  sets: note, products
│
▼
NETWORK
├── [api call]    POST /orders
│   web/src/components/OrderForm.tsx:16  body: customerId, products, note
└── [route]       POST /orders
    api/src/orders/orders.controller.ts:9  dto: CreateOrderDto
│
▼
BACKEND
├── [method]      OrdersController.create
├── [method]      OrdersService.create
└── [method]      AuditService.record
│
▼
DATABASE
├── [db op]       orders.create        schema: Order      create
├── [db op]       auditlogs.create     schema: AuditLog   create
└── [db op]       customers.findById   schema: Customer   read
```

### 3. Or click around instead

```bash
flowlens serve
```

A local dashboard on `http://127.0.0.1:4177`. On the left, every action in the
app, **grouped by the page the user meets it on** — `/customers`, `/orders` —
rather than the folder its code lives in: a form or dialog is followed up to
the page that renders it, and each row shows whether it runs on open, on a
click or on a submit, and the API it calls. `/` jumps to the search.

On the right, six tabs ask questions about the action you have open. Each
carries its own headline number, so the worrying one is visible before you
open it:

```text
Docs · 7 steps   Decisions · 12 branches   Performance · not run   Tests · none   Issues & impact · 11 breaking   Unused · 14
```

| Tab                 | The question                               | Where the answer comes from                                         |
| ------------------- | ------------------------------------------ | ------------------------------------------------------------------- |
| **Docs**            | What does this action do, end to end?      | click → handler → request → route → service → collection            |
| **Decisions**       | Which way can it go, and what decides?     | the source of every function it runs, from the handler to the query |
| **Performance**     | Where does the time go?                    | runtime spans only — each step, and each query with its code        |
| **Tests**           | What would catch it if you broke it?       | which test files import its files, and the cases still to write     |
| **Issues & impact** | What is wrong in it, and what could break? | your edits type-checked before and after, findings, the graph       |
| **Unused**          | What does nothing use?                     | files, exports, dependencies and endpoints nothing reaches          |

**Issues & impact** is the one that changes how you work. It opens with three
cards — your uncommitted changes, the bugs in this action, what a change to it
would reach. For your edits, every function, component, hook, method and type
you changed is compared with its committed text, every use is found with the
TypeScript language service, and the project is type-checked as it is and with
your files put back — so only the errors _your edit_ introduced are shown, each
placed on the page it breaks and said in plain words:

```text
Your change breaks 11 places on 3 pages, in 27 actions

/medicines/[id]   7 breaks   affects Medicine detail page loads, Medicines · Delete, …
  MedicineDetailPage
    Missing `currency` — `formatCurrency` now needs it as argument 2.
    TS2554 Expected 2-3 arguments, but got 1.          7 places

What you changed
  formatCurrency   signature changed   11 breaks
  getStockLevel    body changed        1 to check
```

Before an edit, the same tab walks the graph backwards from every step and
splits it into "shared with other features" and "only this one uses" — because
editing one service for one screen is a five-minute change that can break four
other screens. Infrastructure (a toast hook, a cache, an audit trail) is kept
out of the way so the real findings are not competing with wallpaper. It needs
no instrumentation and no tests, so it works on the first run.

**Decisions** draws the action as a flowchart, read from the code: a diamond
for every `if`, `switch`, `?:`, `try`/`catch` and early `return` or `throw`, a
box for each step in plain words, a drum for each query, and every way out
labelled with what the caller gets (`422 Respond: Validation failed`). Your own
helpers and `this.service.method()` calls are followed into the class that
answers; library calls are left out. **Copy as text** gives the same tree for a
pull request — this is the example app's _Submit Order_:

```text
▸ OrderForm.handleSubmit()
  ⇄ POST /orders  → api/src/orders/orders.controller.ts:9
    ▸ this.ordersService.create(dto)
      ▸ this.customersService.findById(dto.customerId)
        ⛁ customers.findById (read)
        ◆ customer?
        ├─ no
        │  ■ throws new NotFoundException('customer not found') [404]
        └─ yes ↓ continues
      ▸ this.productsService.assertAvailable(…)
        ⛁ products.countDocuments (read)
        ◆ count !== productIds.length?
        ├─ yes
        │  ■ throws new BadRequestException('one or more products are out of stock') [400]
        └─ no ↓ continues
      ⛁ orders.create (create)
      ▸ this.auditService.record('order.created', order._id)
        ⛁ auditlogs.create (create)
    ■ responds this.ordersService.create(dto) [201]
  • setProducts([])
  • setNote('')
```

**Docs** is the action end to end: _At a glance_ first, one line per stage that
opens in place, then only the stages the action has, with the rest named under
_Not in this action_ and the reason. The request step carries the body, guards,
DTO check, the code it runs and a `curl`; _Diagram_ shows the same steps as
numbered cards. Generated from the graph by template, with no model in the
loop, so it cannot invent a step; **Copy as Markdown** gives you the same text
for a wiki or a handover note. Old `#tab=flow|apis|timing|queries|changed|breaks|issues`
links still land in the right place.

An action that makes several requests is shown as a sequence, and the shapes are
told apart rather than lumped together:

| In your code                                              | What the Docs tab says                        |
| --------------------------------------------------------- | --------------------------------------------- |
| `const a = await get(); post({ id: a.id })`               | needs the response from `GET …`               |
| `post(…).then(() => put(…))`                              | only after `POST …` resolves                  |
| `Promise.all([get(a), get(b)])`                           | sent at the same time as `GET …`              |
| `useEffect(() => get(…), [user])` + a call setting `user` | re-runs when the state set by `GET …` arrives |
| `if (isEdit) put() else post()`                           | one step, two alternatives, joined with `or`  |
| a call inside a `catch`                                   | only when the request fails                   |

Every `file:line` in every tab opens your editor (`?editor=vscode`, `cursor`,
`idea`, `zed`, …).

**That is the whole workflow.** Everything below is for when you want more.

---

## More questions it answers

```bash
# "What is this file I'm reading?" — which features run through this line
flowlens where src/components/OrderForm.tsx:20

# "If I change this, what breaks?"
flowlens impact AuditService.record

# "What is already wrong here?" — broken calls, dead endpoints, shared writes
flowlens doctor

# "Write the docs for me" — a feature document in markdown
flowlens flow orderform-submit-order --markdown > docs/submit-order.md

# "What bugs does the code show?" — no auth, tenant leaks, N+1, with the line
flowlens findings --fail-on high

# "What does nothing use?" — files, exports, dependencies, endpoints
flowlens unused

# "What does this branch change about the app?" — markdown for a PR comment
flowlens diff --base main
```

`impact` is the one to reach for before a refactor: it reports the blast radius
and every user-visible feature that would be affected.

---

## Something went wrong

**`flowlens: command not found`** — either the global install is not on your
`PATH`, or you skipped it. Use `npx @flowslens/cli <command>` instead, which
always works.

**"No flows found" or an almost-empty report.** Flowslens prints the reason under
`Notes`. The three common ones:

| Note says                             | Fix                                                          |
| ------------------------------------- | ------------------------------------------------------------ |
| Frontend found, but no backend routes | Your backend is a separate repo: `flowlens scan ./web ./api` |
| No API calls detected                 | Your requests go through a house-built wrapper — see below   |
| Contains 40 `.vue` files, not parsed  | Unsupported stack; see the table at the top                  |

**Your team wraps HTTP in its own helpers.** Flowslens already reads the common
shape — verb in the function name, path in an options object:

```js
getRequest({ url: getUsersList }); //  GET /users
patchRequestNoLoader({ url: getUser, params: `/${id}` }); //  PATCH /users/:id
```

If yours is named differently, describe it once (capture group 1 is the verb):

```bash
flowlens scan --request-fn '^(get|post|put|patch|delete)Api'
```

**Routes and calls match nothing, but both were found.** Usually a global
prefix. `/api` is stripped from both sides by default; change it with
`--api-prefix /v2`.

**Your terminal draws boxes as garbage.** `FLOWLENS_ASCII=1 flowlens flows`, or
`NO_COLOR=1` to drop colour.

**`SyntaxError` on an old Node.** You need 18.18 or newer; `node --version`.

---

## Commands

| Command                         | What it answers                                     |
| ------------------------------- | --------------------------------------------------- |
| `flowlens stack [project]`      | What is this built with? Frameworks, with versions. |
| `flowlens scan [project]`       | Build the graph, and list what it found.            |
| `flowlens flows [project]`      | Which user actions reach the backend?               |
| `flowlens flow <id>`            | Everything one click does, end to end.              |
| `flowlens flow <id> --markdown` | Generate a living feature document.                 |
| `flowlens where <file>:<line>`  | What is this code for? Features running through it. |
| `flowlens impact <symbol>`      | If I change this, what breaks?                      |
| `flowlens doctor [project]`     | Broken API calls, dead endpoints, shared writes.    |
| `flowlens findings [project]`   | Bugs the code shows, each with the line to open.    |
| `flowlens unused [project]`     | Files, folders, exports and deps nothing uses.      |
| `flowlens diff --base main`     | What this branch changes about the app — for a PR.  |
| `flowlens serve [project]`      | The dashboard.                                      |
| `flowlens mcp [project]`        | The graph as tools for an AI assistant (MCP).       |
| `flowlens init [project]`       | Detect the layout and write `flowlens.config.json`. |
| `flowlens instrument [project]` | Set up runtime tracing: new files only, dev only.   |
| `flowlens trace [project]`      | Merge recorded runtime spans into the graph.        |

`[project]` defaults to the current directory, and `scan` works from any
subdirectory of it. Add `--json` to any command for machine-readable output.

`findings` and `diff` take `--fail-on high|medium|low` to fail a CI job. `serve`
generates a new span-collection token on every run; `--token <t>` (or
`$FLOWLENS_TOKEN`) fixes it, so a tracer URL saved in `.env.local` keeps
working. To let an AI assistant query the graph:
`claude mcp add flowlens -- npx -y @flowslens/cli mcp .`

---

## Two repositories, one graph

A frontend and backend in sibling folders is the case Flowslens is built for —
the seam between them is the whole point:

```bash
flowlens scan ./my-web ./my-api
flowlens scan ./api ./web ./mobile     # several consumers of one API
```

Scanning every consumer at once also sharpens the findings: an endpoint that
looks dead against one frontend may simply be called by the mobile app.

---

## Save your settings

Tired of retyping flags? `flowlens init` writes a `flowlens.config.json` you can
commit, so everyone on the team gets the same graph:

```jsonc
{
  // Scanned together when no paths are given on the command line.
  "roots": [".", "../shop-api"],

  // Stripped from BOTH frontend URLs and backend routes.
  "apiPrefixes": ["/api"],

  // Your request layer: capture group 1 is the HTTP verb.
  "requestFunctionPattern": "^(get|post|put|patch|delete)Request",

  "ignore": ["legacy", "generated"],
}
```

Paths in `roots` are resolved relative to the config file and should use `/`, so
one committed file works for everyone on any OS.

---

## Where it puts things

Nothing goes into your project. The graph lives in your OS cache, keyed by
project path, so `git status` after a scan is empty:

| OS      | Location                                             |
| ------- | ---------------------------------------------------- |
| Linux   | `$XDG_CACHE_HOME/flowlens`, else `~/.cache/flowlens` |
| macOS   | `~/Library/Caches/flowlens`                          |
| Windows | `%LOCALAPPDATA%\flowlens\Cache`                      |

`scan` and `serve` both print the exact path. `FLOWLENS_CACHE` moves it.
Two commands write to your project, because writing is what you asked them to
do: `flowlens init` writes a config file, and `flowlens instrument` adds the
tracing files — new files only, printing the lines for files you already have
rather than editing them.

---

## Optional: prove it actually ran

Everything above is read from source, so a step means "this path _can_ run".
Add [`@flowslens/runtime`](https://www.npmjs.com/package/@flowslens/runtime) to
your app and a step becomes `confirmed` — it _did_ run, and here is how long it
took. Entirely optional; the CLI works without it. On a Next.js App Router app,
`flowlens instrument .` sets it up for you (`--print` shows what it would write).

---

## Related packages

- **[`@flowslens/core`](https://www.npmjs.com/package/@flowslens/core)** — the
  graph engine, if you want the graph programmatically instead of a report.
- **[`@flowslens/runtime`](https://www.npmjs.com/package/@flowslens/runtime)** —
  optional development-only tracer.

## Documentation

This page covers everything you need to use the CLI. The full README,
architecture notes, roadmap and changelog are on GitHub:
**[github.com/Kishan-Jaiswar/flowlens](https://github.com/Kishan-Jaiswar/flowlens)**.

Bug reports and feature requests:
[GitHub issues](https://github.com/Kishan-Jaiswar/flowlens/issues), or
**jaiswarkishan78@gmail.com**.

## Licence

MIT
