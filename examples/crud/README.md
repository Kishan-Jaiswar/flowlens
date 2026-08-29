# Example: shop CRUD app

A small React/Next + NestJS + Mongoose app, used as the fixture for the test
suite and as the demo target for the CLI.

**These files are source only.** They are never executed, never installed, and
nothing here opens a database connection. `@nestjs/*` and `mongoose` are
imported for realism — FlowLens reads the syntax tree, so the imports never need
to resolve.

## Layout

```text
crud/
├── web/src/
│   ├── api/client.ts                 axios instance
│   ├── hooks/useCreateCustomer.ts    custom hook that posts
│   ├── components/CustomerForm.tsx   form submit flow
│   ├── components/OrderForm.tsx      the flagship flow
│   └── pages/customers.tsx           search, delete, archive
└── api/src/
    ├── customers/                    controller, service, schema, DTO
    ├── orders/                       calls three other services
    ├── products/                     stock check + a dead endpoint
    ├── imports/                      second writer to `customers`
    └── common/                       audit service, written from everywhere
```

## Deliberate findings

The fixture contains real problems, so `flowlens doctor` has something to say
and the tests assert on it:

| Finding | Where | Why it is there |
|---|---|---|
| Method mismatch | `customers.tsx` calls `PUT /customers/:id/archive`; the controller exposes `PATCH` | The most common frontend/backend drift |
| Dead endpoint | `GET /products/expiring` | No frontend calls it |
| Shared write | `customers` written by both `CustomersService` and `ImportsService` | Coupling nothing in either file mentions |
| High fan-in | `AuditService.record` called from five places | Makes impact analysis non-trivial |

## Try it

```bash
# from the repository root
node packages/cli/bin/flowlens.mjs scan examples/crud
node packages/cli/bin/flowlens.mjs flows examples/crud
node packages/cli/bin/flowlens.mjs flow orderform-submit-order examples/crud
node packages/cli/bin/flowlens.mjs impact AuditService.record -p examples/crud
node packages/cli/bin/flowlens.mjs doctor examples/crud

# add a synthetic runtime recording (no server, no database)
node examples/crud/demo-trace.mjs /tmp/demo-trace.jsonl
node packages/cli/bin/flowlens.mjs trace examples/crud --trace /tmp/demo-trace.jsonl

# then the dashboard
node packages/cli/bin/flowlens.mjs serve examples/crud
```

`api/src/main.ts` and `web/src/pages/_app.tsx` show how the runtime tracer would
be wired into a real app. Both are guarded by `NODE_ENV`.
