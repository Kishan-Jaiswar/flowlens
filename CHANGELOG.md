# Changelog

All notable changes to this project are documented here.

Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the
project uses [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

Nothing yet.

## [0.1.0] - 2026-08-24

First working version. Static analysis is verified against a production
codebase; runtime tracing is implemented but not yet exercised against a live
application (see `docs/ROADMAP.md`).

### Added

- **Graph engine** with `static` / `runtime` / `confirmed` evidence tracking,
  traversal in both directions, and JSON round-tripping.
- **Frontend analyzer** — React and Next.js components, user actions, handlers,
  `useState` state, custom hooks, and outbound HTTP calls via `fetch`, `axios`,
  configured clients, and named wrapper functions.
- **Backend analyzer** — NestJS controllers, routes, DTOs, services, constructor
  injection; Express and Fastify routers including inline handlers; Mongoose
  schemas, models, collections, and read/write classification.
- **File-system routing** — Next.js `pages/api/**`, App Router
  `app/**/route.ts`, and Nuxt `server/api/**`, with dynamic segments, catch-alls
  and route groups.
- **Seam matching** between frontend calls and backend routes, with asymmetric
  segment scoring so an interpolated call resolves to a parameterised route.
- **Field-level data lineage** — component state to payload to DTO to
  collection.
- **Feature flows** with transparent risk scoring, every point explained.
- **Impact analysis** — "if I change this, what breaks?", answered by walking
  the graph backwards.
- **Doctor** — broken API calls, dead endpoints, and collections written by more
  than one service.
- **Runtime tracer** (`@flowlens/runtime`) — zero-dependency HTTP middleware,
  Mongoose plugin, and browser tracer that correlates a click with the requests
  it causes.
- **Static + runtime merge** with inclusive and exclusive timings.
- **Generated feature documents** in Markdown.
- **Dashboard** — dependency-free browser UI served by the CLI.
- **CLI** — `scan`, `flows`, `flow`, `impact`, `doctor`, `trace`, `serve`.
- **Structure independence** — files are classified by content rather than by
  folder name; multi-root scanning for frontend and backend in separate
  repositories; `flowlens.config.json` for per-project conventions.
- 176 tests covering unit logic, a tidy example app, a production-shaped
  fixture, eleven project layouts, hostile inputs, the runtime tracer (driven
  through fakes), and the dashboard's HTTP API (driven through the real CLI).

### Fixed during development

Recorded because each one shaped the design, and the reasoning is in
`docs/ARCHITECTURE.md`:

- A URL prefix stripped from frontend calls but not backend routes made 506
  routes and 199 calls match zero times.
- Files classified by path treated any `api/` directory as backend, silently
  discarding every call in frontends that keep their HTTP client there.
- Summing inclusive span durations reported a 204 ms request as 995 ms; timings
  are now exclusive where they are added up.
- Request-wrapper _definitions_ produced phantom endpoints such as
  `GET /:param`, which then appeared as broken calls and could match real
  parameterised routes.
- `clinicsettings` was pluralised to `clinicsettingses`; Mongoose only appends
  `es` after a double `s`.
- An invalid `--request-fn` regex failed inside every file's error handler and
  reported zero API calls instead of the real reason.
- Chained Mongoose modifiers (`.lean()`, `.sort()`) were counted as separate
  database operations.

[unreleased]: https://github.com/Kishan-Jaiswar/flowlens/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/Kishan-Jaiswar/flowlens/releases/tag/v0.1.0
