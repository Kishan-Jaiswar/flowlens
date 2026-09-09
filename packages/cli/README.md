# @flowslens/cli

**Trace any user action from the UI to the database.**

You join a project. You need to change one screen. So you start clicking through
files: which handler runs, which endpoint it calls, which service answers, which
collection it writes. Eight tools and an afternoon later you still do not know
what _else_ writes that collection.

FlowLens reads your source and answers in one command.

```bash
npx @flowslens/cli scan .
```

It only reads files. It never connects to a database, never runs your code, and
never writes anything into your project.

---

## First: will this work on my project?

FlowLens reads a specific set of stacks. Check here before installing — if your
stack is on the right, you will get a file count and little else.

| It reads today                                                              | Not yet                             |
| --------------------------------------------------------------------------- | ----------------------------------- |
| **React** and **Next.js** (`pages/` and App Router)                         | Vue, Svelte, Angular, Astro         |
| **NestJS**, **Express**, **Fastify**                                        | Django, Rails, Go, Java, .NET, PHP  |
| Next.js `pages/api` + App Router handlers, **Nuxt** `server/api`            | GraphQL and tRPC resolvers          |
| **MongoDB** via Mongoose, and the native driver                             | Prisma, TypeORM, Sequelize, raw SQL |
| TypeScript **or** plain JavaScript with JSX (`.js`, `.jsx`, `.mjs`, `.cjs`) | Queues, cron jobs, websockets       |

So the sweet spot is **React/Next + NestJS or Express + Mongoose**. Any _folder
layout_ of those works — FlowLens decides what a file is by reading it, not by
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

A local dashboard on `http://127.0.0.1:4177`. Click any step to see what it ran
_with_: the state a handler sets, the body a request sends, the DTO a route
validates against, the schema behind a query.

**That is the whole workflow.** Everything below is for when you want more.

---

## Four more questions it answers

```bash
# "What is this file I'm reading?" — which features run through this line
flowlens where src/components/OrderForm.tsx:20

# "If I change this, what breaks?"
flowlens impact AuditService.record

# "What is already wrong here?" — broken calls, dead endpoints, shared writes
flowlens doctor

# "Write the docs for me" — a feature document in markdown
flowlens flow orderform-submit-order --markdown > docs/submit-order.md
```

`impact` is the one to reach for before a refactor: it reports the blast radius
and every user-visible feature that would be affected.

---

## Something went wrong

**`flowlens: command not found`** — either the global install is not on your
`PATH`, or you skipped it. Use `npx @flowslens/cli <command>` instead, which
always works.

**"No flows found" or an almost-empty report.** FlowLens prints the reason under
`Notes`. The three common ones:

| Note says                             | Fix                                                          |
| ------------------------------------- | ------------------------------------------------------------ |
| Frontend found, but no backend routes | Your backend is a separate repo: `flowlens scan ./web ./api` |
| No API calls detected                 | Your requests go through a house-built wrapper — see below   |
| Contains 40 `.vue` files, not parsed  | Unsupported stack; see the table at the top                  |

**Your team wraps HTTP in its own helpers.** FlowLens already reads the common
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
| `flowlens scan [project]`       | Build the graph, and list what it found.            |
| `flowlens flows [project]`      | Which user actions reach the backend?               |
| `flowlens flow <id>`            | Everything one click does, end to end.              |
| `flowlens flow <id> --markdown` | Generate a living feature document.                 |
| `flowlens where <file>:<line>`  | What is this code for? Features running through it. |
| `flowlens impact <symbol>`      | If I change this, what breaks?                      |
| `flowlens doctor [project]`     | Broken API calls, dead endpoints, shared writes.    |
| `flowlens serve [project]`      | The dashboard.                                      |
| `flowlens init [project]`       | Detect the layout and write `flowlens.config.json`. |
| `flowlens trace [project]`      | Merge recorded runtime spans into the graph.        |

`[project]` defaults to the current directory, and `scan` works from any
subdirectory of it. Add `--json` to any command for machine-readable output.

---

## Two repositories, one graph

A frontend and backend in sibling folders is the case FlowLens is built for —
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
`flowlens init` is the one command that writes to your project, because writing
a config file is what you asked it to do.

---

## Optional: prove it actually ran

Everything above is read from source, so a step means "this path _can_ run".
Add [`@flowslens/runtime`](https://www.npmjs.com/package/@flowslens/runtime) to
your app and a step becomes `confirmed` — it _did_ run, and here is how long it
took. Entirely optional; the CLI works without it.

---

## Related packages

- **[`@flowslens/core`](https://www.npmjs.com/package/@flowslens/core)** — the
  graph engine, if you want the graph programmatically instead of a report.
- **[`@flowslens/runtime`](https://www.npmjs.com/package/@flowslens/runtime)** —
  optional development-only tracer.

## Documentation

Full README, architecture notes and roadmap:
**https://github.com/Kishan-Jaiswar/flowlens**

## Licence

MIT
