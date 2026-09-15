# Roadmap

Milestones are ordered so that each one is independently useful. Nothing here
requires the whole system to exist first.

## Not done, and it matters

Listed before the feature roadmap on purpose: these are gaps in what has
_already been built_, and they are worth more than any new feature.

- [x] **The tracer now runs against a live application** (`tests/live.test.ts`).
      A real `node:http` server with the real middleware in front of it, real
      requests over a real socket, the real sink writing a real JSONL file, and
      that file merged into a real scan — asserting `confirmed` evidence,
      observation counts, parent/child nesting and durations that were actually
      measured rather than asserted. Nothing in that path is a stand-in.
- [ ] **Except the database.** `flowlensMongoose` is still driven through fake
      schema hooks, because exercising it honestly needs a live Mongo and the
      suite must run with no server and no network of its own. This is the last
      piece of the original gap, and it is now the only one.
- [ ] **API contract drift across a guard.** A route behind `@UseGuards` is now
      a visible step, but Flowslens does not read what the guard _checks_, so it
      cannot yet say which roles or scopes a flow requires.
- [x] **The dashboard's browser code has coverage** (`tests/dashboard.test.ts`).
      `app.js` is loaded the way a browser loads it — against the real
      `index.html`, with `fetch` answering from a real scan of the example app —
      and the rendered DOM is asserted: layer order, per-layer colour classes,
      the flow list, escaping, and that a step is labelled by what it did rather
      than by its node kind. Seven tests, not a full sweep of 660 lines, but the
      labelling layer is where a wrong answer gets delivered confidently.

## Done — v1.0 (published)

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
- [x] Published to npm as `@flowslens/cli`, `@flowslens/core` and
      `@flowslens/runtime` (2026-08-31), so `npx @flowslens/cli scan .` is the
      first-run experience
- [x] Pack-and-install test (`npm run test:package`) that installs the real
      tarballs into a throwaway project and drives the dashboard over HTTP

## Done since v1.0

- [x] **The request sequence.** One action often makes several calls, and
      "several calls" covers shapes that used to be indistinguishable: awaited
      calls with a data dependency, a `.then` chain, `Promise.all`, a
      `useEffect` waiting on state another call sets, and mutually exclusive
      `if`/`else` arms. Each is now numbered and explained, alternatives share a
      step, and an error-path request is labelled as one.
- [x] **The round trip.** Status codes the endpoint really answered with, the
      state a response lands in, where the action navigates, what the user is
      shown on success and failure, and cache invalidation followed to the
      refetch it causes.

- [x] **Four tabs in the dashboard, not one view.** Flow (what happens), Timing
      (where the time goes, from real spans), Breaks (which steps other features
      share, and which collections several methods write) and Tests (which test
      files import the files this flow runs through, and which of them nothing
      covers). Each tab label carries its own headline number so the risky one
      is visible unopened. Exported from core as `analyzeFlowImpact`,
      `flowTiming`, `indexTests` and `testsForFlow`; served together from
      `GET /api/insight`.

- [x] **`flowlens stack`** — frameworks, versions, package manager, workspace
      layout and marker files, read from the manifests without a scan. Says in
      three states which parts of the detected stack are traced, not traced, or
      traced only as far as the hand-off out of the app.
- [x] **Guards, middleware, interceptors and pipes as flow steps.** `@UseGuards`
      at class and method level, and the Express arguments between the path and
      the handler, which this analyzer used to discard. Framework plumbing is
      filtered out.
- [x] **Work that leaves the app is a visible terminal step.** Third-party HTTP,
      queues, cache, mail, object storage, sockets and payment providers get an
      `external-effect` node in their own `LEAVES THE APP` layer, each marked
      unread — so a flow that cannot be followed further says so instead of
      appearing to end.
- [x] **Prisma.** `schema.prisma` (including `@@map` and the Prisma 5 `schema/`
      folder), every client operation classified by effect, and table names
      taken literally. Works in Nest services, Express handlers, file routes and
      plain query modules.
- [x] **`actionProps` / `inputActionProps` config**, so a design system whose
      button is `onAction` is no longer invisible.

## Next — v1.1

- [ ] **Prove the tracer against a real database.** HTTP and method spans are
      now proven live, end to end. What is left is Mongo: wire
      `@flowslens/runtime` into a throwaway Express + Mongoose app with a real
      database, click through it, and check that `flowlens trace` reports
      `confirmed` for the collection too.
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

## v1.2 — more of the stack

- [x] PostgreSQL/MySQL via Prisma
- [ ] TypeORM, Sequelize and Drizzle adapters
- [ ] Redis: cache reads/writes as first-class data nodes rather than a single
      terminal effect
- [ ] Queues (BullMQ): follow the job into the worker that handles it. The
      `add()` that enqueues it is already a step; what runs next is not read
- [ ] Vue and Svelte frontend analyzers
- [ ] tRPC and GraphQL resolvers as route equivalents

## v1.3 — analysis

Still open here, and worth stating precisely because parts of it are done:

The Breaks tab covers the "what else depends on this" half of this milestone.
What is left below is the part that needs either spans or a rule engine.

- [ ] **N+1 detection.** A trace where one request produces _n_ similar queries.
      Cheap to detect once spans exist, and immediately actionable.
- [x] **API contract drift** for NestJS DTOs — payload keys no DTO accepts, and
      declared fields the frontend never sends.
- [ ] **Contract drift for Zod and Yup schemas**, which is how most Next.js
      route handlers declare their input. Until then such a route reports "no
      DTO to check" rather than being counted as agreeing.
- [ ] **Response shape.** Status codes and the landing state are read; the
      fields an endpoint returns are not, because the handler's return value is
      ordinary code and typing it would be guesswork.
- [ ] **Guard semantics.** A guard is named, not read: which role or scope it
      requires is still invisible.
- [ ] **Query shape.** Collection and operation, but not the filter, the
      projection, or whether a loop makes it an N+1.
- [ ] **Next.js `middleware.ts`**, which runs for matching routes and is not
      read at all.
- [ ] **Chains through a global store.** The `useEffect` chain is resolved
      inside a component; a dependency through Redux or Zustand, or across a
      custom-hook boundary, is not linked.
- [ ] **Architecture rules.** Assert "controllers must not touch models
      directly" and fail CI when a new edge violates it.
- [ ] **Feature health.** Error rate and p95 per flow, from the same spans. The
      Timing tab now shows mean own-time per step; percentiles and error rates
      need the sink to record outcomes, not just durations.

## v1.4 — Chrome DevTools panel

Deliberately late. The browser is the most _demoable_ surface but the least
essential: the core value is the chain from code to database, and that lives in
the editor and the terminal. Once the graph and the tracer are solid, a DevTools
panel is a thin client over both — "I just clicked this, show me what happened",
live.

## Later — AI

An explanation layer over a verified graph:

> "Explain how order creation works."
> "What would break if I renamed `Customer.phone`?"

Ordered last on purpose. An LLM reading the repo directly guesses; an LLM reading
a graph that has been confirmed by runtime traces cites. The graph is the
product; AI is an interface to it.

## Explicit non-goals

- **A file dependency visualiser.** Crowded category, and it answers the wrong
  question.
- **An APM.** Flowslens explains a codebase in development; it is not production
  monitoring, and the tracer is not built for production load.
- **Auto-refactoring.** Telling you what will break is useful and verifiable.
  Changing it for you is a different product with a much higher bar.
- **A hosted service.** Local-first is a feature: no account, no upload, no
  question about where your source code went.
