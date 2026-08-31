# @flowlens/cli

**Trace any user action from the UI to the database.**

You are handed an unfamiliar codebase and asked what happens when a user presses
_Submit_. The button is in one repository, the endpoint in another, the query in
a service three files deep, and the collection name is computed at runtime.
FlowLens reads the source and answers in one command.

It reads source files only. It never connects to a database, never executes the
code it analyses, and never writes anything into the project it reads.

```bash
npx @flowlens/cli scan .
npx @flowlens/cli flows .
npx @flowlens/cli serve .
```

## What you get

```text
$ flowlens flow orderform-submit-order

Submit Order  (orderform-submit-order)
web/src/components/OrderForm.tsx:42
risk high (50)   evidence static

USER ACTION  └── [ui action]   Submit Order
FRONTEND     └── [handler]     OrderForm.handleSubmit      sets: note, products
NETWORK      ├── [api call]    POST /orders                body: customerId, products, note
             └── [route]       POST /orders                dto: CreateOrderDto
BACKEND      ├── [method]      OrdersController.create
             ├── [method]      OrdersService.create
             ├── [method]      CustomersService.findById
             └── [method]      AuditService.record
DATABASE     ├── [db op]       orders.create               schema: Order      create
             ├── [db op]       customers.findById          schema: Customer   read
             └── [db op]       auditlogs.create            schema: AuditLog   create
```

## Commands

| Command                         | What it answers                                     |
| ------------------------------- | --------------------------------------------------- |
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

Add `--json` to any command for machine-readable output.

## Supported stacks

- **Frontend** — React and Next.js (`pages/` and App Router), plain `.js` with
  JSX, `fetch`, `axios`, and house-built request wrappers with the verb in the
  name (`getRequest`, `crmPostRequest`).
- **Backend** — NestJS (controllers, DTOs, services, dependency injection),
  Express and Fastify routers, Next.js `pages/api` and App Router route
  handlers, Nuxt `server/api`.
- **Data** — Mongoose schemas and models, and the native MongoDB driver.

A frontend and backend in **separate repositories** is a first-class case — pass
both, and the seam between them is what you get:

```bash
flowlens scan ./my-web ./my-api
```

## Documentation

Full README, architecture notes and roadmap:
**https://github.com/Kishan-Jaiswar/flowlens**

## Licence

MIT
