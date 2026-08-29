# Changelog

All notable changes to this project are documented here.

Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the
project uses [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

The theme is: point FlowLens at any project, on any machine, and have the first
command work — without leaving a mark on that project.

### Fixed

- **Most flows were invisible in any codebase that does not name its functions
  `handleX`.** Node creation was gated on `/^(handle|on)[A-Z]/`, so a function
  called `fetchBillingData` or `saveVoiceRx` had no node; `ownerOf` walked past it
  and credited the request to the whole component, severing the
  `ui-action -> handler -> api-call` chain that a flow is built from. Measured on
  a production Next.js frontend: 361 of 439 API calls (82%) were mis-attributed,
  and requests owned by a component fell from 257 to 33 once every named function
  inside a component got a node. `async function save() {}` declarations inside a
  component were invisible for the same reason and are now included.
- The default `requestFunctionPattern` only matched a verb at the _start_ of the
  name, missing whole wrapper families such as `crmPostRequest`,
  `AcmeGetRequest`, `postAiRequest` and `getAiRequest`. The verb may now appear
  anywhere in the name and is matched case-insensitively, which found 31 more
  endpoints in the same frontend.

### Added

- Components that load their data on mount now get a synthetic `loads` action, so
  effect-driven fetches appear in `flows` instead of being unreachable. Tagged
  `event: 'mount'` and `synthetic: true` to distinguish them from a real DOM
  event. Hooks are excluded — `const { create } = useCreate()` in a component body
  is a declaration, not a mount-time request.

### Changed

- **FlowLens no longer writes anything into the project it reads.** The graph and
  any runtime trace used to land in `<project>/.flowlens/`, which meant that
  merely looking at a repository dirtied it. They now live in the OS cache
  directory, keyed by project path (`~/.cache/flowlens/<name>-<hash>/` on Linux,
  `~/Library/Caches/flowlens` on macOS, `%LOCALAPPDATA%\flowlens\Cache` on
  Windows). `git status` after a scan is empty. `-g` / `--trace` still override,
  and `scan` and `serve` print the path they used.
- `saveGraph`'s fallback for an unwritable destination was the **current
  directory**, which is usually the project being scanned — the one place it must
  not write. It now falls back to the temp directory, keeping the project key so
  two projects cannot overwrite each other's graph.
- The `@flowlens/runtime` sink defaulted to `.flowlens/trace.jsonl` relative to
  the traced app, putting a file in the user's repository. It now honours
  `$FLOWLENS_TRACE`, else the same machine-local cache path.
- `examples/crud/demo-trace.mjs` takes the output path as its first argument
  instead of writing inside the example project.

### Added

- `GET /__flowlens/browser.js` on the dashboard serves the browser tracer, so
  instrumenting a frontend no longer requires copying a file into it. Sent with
  `access-control-allow-origin: *`, since the traced app is always another origin.
- `FLOWLENS_CACHE` relocates the artifact cache wholesale — used by the test
  suite and the smoke test so neither writes into the developer's real cache.
- `flowlens init --print` writes the detected config to stdout instead of to the
  project. `init` remains the only command that creates a file in your project,
  and it now names that file explicitly in its output.

- `flowlens init` — detects what a project actually is and writes
  `flowlens.config.json`. Finds a monorepo's `web/`+`api/` pair, and finds the
  case where the frontend and backend are separate **sibling repositories**
  (`shop-web` next to `shop-api`), which is where the interesting seam lives.
  The config it writes uses relative, forward-slashed paths, so it survives a
  commit and a different operating system — and it makes `flowlens scan` work
  from any subdirectory of the project.
- A launcher — `./flowlens` and `flowlens.cmd` — that installs dependencies and
  builds on first use, then rebuilds only when the sources are newer. A fresh
  copy of the project now works with one command instead of three, which is what
  makes the USB-stick story true.
- `npm run smoke`: every CLI command, run for real as a process, in plain Node
  with no shell. CI runs it on Windows, macOS and Linux. It replaces a bash
  block in the workflow that could only ever prove FlowLens worked on Linux.
- An ASCII fallback for the flow trees, chosen automatically on a legacy Windows
  console and forceable either way with `FLOWLENS_ASCII` / `FLOWLENS_UNICODE`.
  Redirected output always keeps the Unicode version.
- `serve` opens a browser when you are at a terminal (`--open` / `--no-open`),
  and moves to the next free port when 4177 is busy and no `--port` was given.
- CI: the unit suite on Windows and macOS as well as Linux, plus a job that runs
  the launcher from a checkout with nothing installed.

### Fixed

- **Windows paths were silently ignored.** Only `/` counted as a path
  separator, so `flowlens scan .\my-app` or `C:\code\app` was mistaken for a
  flow id and the scan ran against the current directory without saying so. Path
  detection now understands both separators, drive letters, UNC paths and `~`,
  and for commands that take no argument of their own every positional is a
  path.
- `flowlens scan my-app` — a project named with no separator at all — scanned
  the current directory instead. It now scans `my-app`, and a path that does not
  exist is an error rather than a silent success.
- `flowlens scan -g <file>` ignored the flag and wrote to the default location,
  so the `flows -g <file>` that followed could not find the graph.
- `npm install` left the project unbuilt, so the first command a new user ran
  failed on a missing `dist/index.js`. It now builds via a `prepare` script, and
  when the build really is missing the CLI says what to run instead of throwing
  a module-resolution stack trace.
- `npm run clean` used `rm -rf`, which does not exist on a Windows shell.
- The same file reached through two roots was analyzed twice on Windows and
  macOS, where the file system is case-insensitive, producing duplicate nodes.
- The symlink tests failed on a default Windows install, where creating a
  symlink needs Developer Mode; they are now skipped there rather than failing.
- The CLI checks the Node version and says so, instead of failing with a syntax
  error on an old runtime.

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
- `shopsettings` was pluralised to `shopsettingses`; Mongoose only appends
  `es` after a double `s`.
- An invalid `--request-fn` regex failed inside every file's error handler and
  reported zero API calls instead of the real reason.
- Chained Mongoose modifiers (`.lean()`, `.sort()`) were counted as separate
  database operations.

[unreleased]: https://github.com/Kishan-Jaiswar/flowlens/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/Kishan-Jaiswar/flowlens/releases/tag/v0.1.0
