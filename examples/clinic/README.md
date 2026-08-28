# Example: clinic app

A small React/Next + NestJS + Mongoose app, used as the fixture for the test
suite and as the demo target for the CLI.

**These files are source only.** They are never executed, never installed, and
nothing here opens a database connection. `@nestjs/*` and `mongoose` are
imported for realism — FlowLens reads the syntax tree, so the imports never need
to resolve.

## Layout

```text
clinic/
├── web/src/
│   ├── api/client.ts                 axios instance
│   ├── hooks/useCreatePatient.ts     custom hook that posts
│   ├── components/PatientForm.tsx    form submit flow
│   ├── components/PrescriptionForm.tsx  the flagship flow
│   └── pages/patients.tsx            search, delete, archive
└── api/src/
    ├── patients/                     controller, service, schema, DTO
    ├── prescriptions/                calls three other services
    ├── medicines/                    stock check + a dead endpoint
    ├── imports/                      second writer to `patients`
    └── common/                       audit service, written from everywhere
```

## Deliberate findings

The fixture contains real problems, so `flowlens doctor` has something to say
and the tests assert on it:

| Finding | Where | Why it is there |
|---|---|---|
| Method mismatch | `patients.tsx` calls `PUT /patients/:id/archive`; the controller exposes `PATCH` | The most common frontend/backend drift |
| Dead endpoint | `GET /medicines/expiring` | No frontend calls it |
| Shared write | `patients` written by both `PatientsService` and `ImportsService` | Coupling nothing in either file mentions |
| High fan-in | `AuditService.record` called from five places | Makes impact analysis non-trivial |

## Try it

```bash
# from the repository root
node packages/cli/bin/flowlens.mjs scan examples/clinic
node packages/cli/bin/flowlens.mjs flows examples/clinic
node packages/cli/bin/flowlens.mjs flow prescriptionform-submit-prescription examples/clinic
node packages/cli/bin/flowlens.mjs impact AuditService.record -p examples/clinic
node packages/cli/bin/flowlens.mjs doctor examples/clinic

# add a synthetic runtime recording (no server, no database)
node examples/clinic/demo-trace.mjs /tmp/demo-trace.jsonl
node packages/cli/bin/flowlens.mjs trace examples/clinic --trace /tmp/demo-trace.jsonl

# then the dashboard
node packages/cli/bin/flowlens.mjs serve examples/clinic
```

`api/src/main.ts` and `web/src/pages/_app.tsx` show how the runtime tracer would
be wired into a real app. Both are guarded by `NODE_ENV`.
