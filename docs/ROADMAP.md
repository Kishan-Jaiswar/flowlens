# Roadmap

Milestones are ordered so that each one is independently useful. Nothing here
requires the whole system to exist first.

## Not done, and it matters

Listed before the feature roadmap on purpose: these are gaps in what has
_already been built_, and they are worth more than any new feature.

- [ ] **The runtime tracer has not run against a live application.** Its
      contract is now covered by 26 unit tests — the sink, the HTTP middleware,
      `traceMethod`, and the Mongoose plugin driven through fake schema hooks —
      and a test asserts that the spans it emits merge into a scanned graph and
      produce `confirmed` evidence. What is still missing is the real thing: a
      running Express or NestJS app with a real database, clicked through by
      hand. Until that happens, the integration is verified only against fakes.
- [ ] **Not published.** `npm link -w @flowlens/cli` works and is documented,
      but installing means cloning the repo. Publishing `@flowlens/cli` to npm
      would make `npx flowlens scan .` the first-run experience.
- [ ] **The dashboard's browser code is untested.** Its server and JSON API now
      have 16 integration tests that drive the real `flowlens serve` process, but
      the 356 lines of DOM rendering in `apps/dashboard/public/app.js` have no
      direct coverage.

## Done — v0.1 (this repo)

- [x] Graph engine with evidence tracking and JSON round trip
- [x] React/Next analyzer: components, actions, handlers, state, hooks
- [x] HTTP call detection: `fetch`, `axios`, configurable clients
- [x] NestJS analyzer: controllers, routes, DTOs, services, DI
- [x] Express/Fastify router detection
- [x] Mongoose analyzer: schemas, models, collections, read/write classification
- [x] Frontend/backend seam matching with asymmetric scoring
- [x] Field-level data lineage: state → payload → DTO → collection
- [x] Feature flow resolution with transparent risk scoring
- [x] Impact analysis ("what breaks if I change this?")
- [x] Doctor: broken calls, dead endpoints, shared writes
- [x] Runtime tracer: HTTP, Mongoose, browser click→request correlation
- [x] Static + runtime merge with inclusive/exclusive timings
- [x] Generated feature documents (markdown)
- [x] Dependency-free dashboard
- [x] CLI: scan, flows, flow, impact, doctor, trace, serve
- [x] Structure-agnostic file classification (content, not folder names)
- [x] Next.js `pages/api` + App Router, Nuxt `server/api` file routes
- [x] Endpoint-constant resolution and house-built request wrappers
- [x] Multi-root scanning for frontend/backend in separate repositories
- [x] `flowlens.config.json`
- [x] Verified against a production codebase: 1,519 files, 197/204 calls matched

## Next — v0.2

- [ ] **Prove the tracer end to end.** Wire `@flowlens/runtime` into a small
      throwaway Express + Mongoose app, click through it, and check that
      `flowlens trace` reports `confirmed` with real timings. Then unit-test the
      sink, the middleware, the Mongoose plugin and the browser tracer. This is
      the highest-value work left in the project.
- [ ] **VS Code extension.** The natural home for "show me where this feature
      lives": a tree view of flows, `Ctrl+Click` to any step, inline risk on the
      handler you are editing. Higher value than the browser extension because
      the developer is already here.
- [ ] **Watch mode.** `flowlens serve --watch` re-scans changed files instead of
      the whole project.
- [ ] **Incremental scan cache.** Per-file analyzer results keyed by mtime.
- [ ] **`flowlens diff`.** Compare two graphs: which flows changed, which
      endpoints appeared, which collection gained a writer. This is the CI story
      — fail a PR that silently adds a second writer to a collection.

## v0.3 — more of the stack

- [ ] PostgreSQL/MySQL via Prisma and TypeORM adapters
- [ ] Redis: cache reads/writes as first-class data nodes
- [ ] Queues (BullMQ): a job as a continuation of the flow that enqueued it
- [ ] Vue and Svelte frontend analyzers
- [ ] tRPC and GraphQL resolvers as route equivalents

## v0.4 — analysis

- [ ] **N+1 detection.** A trace where one request produces _n_ similar queries.
      Cheap to detect once spans exist, and immediately actionable.
- [ ] **API contract drift.** Payload keys the frontend sends that no DTO
      accepts, and required DTO fields the frontend never sends.
- [ ] **Architecture rules.** Assert "controllers must not touch models
      directly" and fail CI when a new edge violates it.
- [ ] **Feature health.** Error rate and p95 per flow, from the same spans.

## v0.5 — Chrome DevTools panel

Deliberately late. The browser is the most _demoable_ surface but the least
essential: the core value is the chain from code to database, and that lives in
the editor and the terminal. Once the graph and the tracer are solid, a DevTools
panel is a thin client over both — "I just clicked this, show me what happened",
live.

## Later — AI

An explanation layer over a verified graph:

> "Explain how prescription creation works."
> "What would break if I renamed `Patient.phone`?"

Ordered last on purpose. An LLM reading the repo directly guesses; an LLM reading
a graph that has been confirmed by runtime traces cites. The graph is the
product; AI is an interface to it.

## Explicit non-goals

- **A file dependency visualiser.** Crowded category, and it answers the wrong
  question.
- **An APM.** FlowLens explains a codebase in development; it is not production
  monitoring, and the tracer is not built for production load.
- **Auto-refactoring.** Telling you what will break is useful and verifiable.
  Changing it for you is a different product with a much higher bar.
- **A hosted service.** Local-first is a feature: no account, no upload, no
  question about where your source code went.
