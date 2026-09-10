# Changelog

All notable changes to this project are documented here.

Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the
project uses [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- **`.gitignore` help for the artifacts you asked FlowLens to put in your
  repository.** By default there is nothing to ignore — the graph and the trace
  are written to the OS cache, not the project — but `-g graph.json`,
  `--trace`, and `$FLOWLENS_TRACE` all put a generated file inside a work tree,
  where it then shows up as an untracked change on every branch until someone
  remembers to delete it before pushing.
  - `scan` and `serve` now print a one-line note when a file they write is
    inside a git repository and not ignored. They change nothing on their own:
    a tool asked to read a repository does not get to edit it.
  - `flowlens init --gitignore` adds exactly those paths — not a block of
    speculative patterns — to a managed section of `.gitignore`, marked with
    `# flowlens:begin` / `# flowlens:end`. It is idempotent, leaves every line
    the developer wrote untouched, anchors each pattern with a leading `/` so
    `/graph.json` cannot also hide a `src/graph.json`, skips anything the
    project already ignores, and reports files that are already committed
    (where `git rm --cached` is the actual fix). It works on an
    already-configured project, leaving the config alone, and writes nothing
    under `--print`.
  - `"gitignore": true` in `flowlens.config.json` opts a project in for
    everyone, so the block stays current on every scan; `--gitignore` /
    `--no-gitignore` override the config for one run.
  - 21 new tests, against real git repositories in a temp directory.

### Security

- **`flowlens serve` sent `Access-Control-Allow-Origin: *` on every JSON
  response**, so while the dashboard was open, any page in your browser could
  read `/api/graph` — every absolute file path, route, DTO field and collection
  name in the project — and send it anywhere. Binding to `127.0.0.1` was no
  defence: a browser is already on this machine. The wildcard now appears only
  on the span endpoints, which need it and return `{ok:true}`.
- **`POST /api/rescan` was reachable cross-origin.** With `content-type:
text/plain` it is a CORS simple request, so no preflight stood in the way and
  no readable response was needed to make it worth doing — a page could pin a
  core re-scanning a large project. `/api/*` now rejects any request carrying a
  foreign `Origin`.
- **`POST /__flowlens/spans` accepted spans from anyone.** Forged spans merge
  into the graph as `confirmed` evidence, which is precisely the claim FlowLens
  makes that nothing else does, and the trace file grew without limit. The
  endpoint now requires a token, generated per run and printed as part of the
  URLs to copy (`--token` / `$FLOWLENS_TOKEN` to fix it), and the trace file
  stops at 64 MB with a warning rather than filling the disk.
- **No `Host` header validation** left the server open to DNS rebinding, which
  defeats every same-origin rule above. Requests must now be addressed by IP
  literal or `localhost` — the two things an attacker cannot rebind.
- **`--host` exposed everything above to the network silently.** A non-loopback
  bind now requires the token for the whole API and prints a warning saying
  what it has done. The dashboard passes on the token it was opened with, so
  the printed URL just works.
- **A `flowlens.config.json` is discovered by walking up from the scanned
  path**, so an unfamiliar repository could choose its own scan settings.
  `roots` pointing outside the project now produce a warning naming the
  directory, and `requestFunctionPattern` is length-capped before compilation
  and matched only against plausible identifiers — bounding what a hostile
  pattern can cost. The pattern is also compiled once instead of once per
  member expression, which was a real cost on a large frontend.
- 21 new tests: the rules as functions, and the attacks themselves replayed
  against a live `flowlens serve`.

### Fixed

- **`packages/cli` was type-checking and running against the _published_
  `@flowslens/core` 1.0.0**, not the local workspace: a stale
  `packages/cli/node_modules/@flowslens/core` left over from an earlier install
  shadowed the workspace link, so any new core API was invisible to the CLI
  build. The lockfile never referenced it; removing the directory restores the
  intended link.

## [1.0.1] - 2026-09-09

**A documentation release, and an important one.** The READMEs published with
1.0.0 still named the pre-rename `@flowlens` scope, so all three npm pages told
readers to run `npx @flowlens/cli` — a package that does not exist. Anyone who
copied the install command off npm got "package not found". The package
manifests were renamed for 1.0.0; the READMEs inside the tarballs were not.

No runtime behaviour changes, apart from the `--version` and `--help` fixes
below.

### Fixed

- **`flowlens --version` reported `0.1.0` while the published packages were
  `1.0.0`.** The version was a literal in `packages/cli/src/index.ts`; it is now
  read from the package manifest, and a test asserts the two agree.
- **The scope rename to `@flowslens` was applied incompletely**, which left the
  repository in a state where `npm test` and `npm run test:package` both failed:
  - `tests/tracer.test.ts` still imported `@flowslens/runtime`'s old name, so the
    whole suite failed to load — 26 tests never ran.
  - `scripts/package-test.mjs` looked for `flowlens-*.tgz` tarballs and a
    `node_modules/@flowlens` directory that `npm pack` no longer produces. It now
    derives the scope from `packages/cli/package.json` rather than hardcoding it.
  - The remaining stale references were in the runtime and CLI help text, the
    example app's tracer wiring, and the docs.
- **`npm run lint` failed with 43 errors on any checkout where `prepack` had
  run.** `packages/cli/dashboard/` and `packages/cli/runtime/` are generated
  copies, gitignored but not ignored by ESLint, so browser globals in the copied
  dashboard were reported as `no-undef`. They are ignored now; the originals are
  still linted where they live.

### Documentation

- **`flowlens --help` advertised the wrong defaults.** It said the graph and
  trace default to `<project>/.flowlens/…`, which is where they went before
  1.0.0 — the opposite of the guarantee the tool is built on. The closing note
  said runtime tracing "writes to a local `.flowlens/trace.jsonl` in your own
  project", which is also no longer true. Both corrected, and `FLOWLENS_CACHE`
  and `FLOWLENS_TRACE` are now listed under ENVIRONMENT.
- **The published `@flowslens/runtime` README documented `traceMethod`
  incorrectly.** It showed `traceMethod('OrdersService.create', fn)` returning a
  wrapped function. The real signature is
  `traceMethod(className, methodName, fn, options?)` — it is `async` and wraps a
  _call_, so the documented form threw `TypeError: fn is not a function`.
- The npm READMEs for all three packages were rewritten for a first-time
  reader: what each one is for, whether you need it, install, then a numbered
  path to a working result.
  - `@flowslens/cli` now opens with **"will this work on my project?"** — a
    reads/does-not-read table — because installing a tool that cannot see your
    stack is the most expensive way to find that out. It also gained a
    troubleshooting section for the failures people actually hit.
  - `@flowslens/runtime` gained copy-paste blocks per stack (Express CommonJS,
    Express ESM, NestJS, Next.js) rather than one generic snippet, and full
    option tables.
  - `@flowslens/core` gained a complete runnable first script and a
    fail-CI-on-findings example.
  - All three now state that the packages are **ESM-only**, and that
    `require()` throws `ERR_REQUIRE_ESM` on Node 18–22.11 while working on
    22.12+. Verified on 18.20, 24.18 and 26.5.
  - Every command and API example in them was executed against
    `examples/crud`. That caught `analyzeImpact` needing a node id rather than
    a symbol name, `resolveFlow` taking an entry node id rather than a flow id,
    `renderFeatureDocument` taking `(graph, flow)`, and the `scan` option being
    `requestFunctionPattern` rather than a shortened form.
- Stale `.flowlens/` paths corrected in the NestJS example's comments and in
  four source comments that told contributors the graph is written into the
  scanned project.

- Corrected claims that had drifted: the test count (200 → 305), the project
  status (`v0.1, pre-release` → 1.0.0 on npm), the roadmap's "not published"
  entry, the dashboard's line count, and the milestone numbering after 1.0.
- **`SECURITY.md` said output goes to a `.flowlens/` directory inside your
  project.** It does not, and has not since 0.1.0 — artifacts live in the OS
  cache. Corrected, with the per-platform paths.
- `packages/runtime/README.md` told users to pass `--trace .flowlens/trace.jsonl`,
  reintroducing the file-in-your-repo behaviour that 1.0.0 removed.
- Documented that **development requires Node 20+** even though the published
  CLI supports 18.18: Vitest 4 cannot start on Node 18, so `npm test` there dies
  with a `SyntaxError` about `styleText` rather than a useful message.
- Documented the naming split — packages are `@flowslens/*`, the command is
  `flowlens` — in the README, the CLI package README and the changelog.

## [1.0.0] - 2026-08-31

First published release. The theme is: point FlowLens at any project, on any
machine, and have the first command work — without leaving a mark on that
project.

### Packaging

- **Published to npm** as `@flowslens/cli`, `@flowslens/core` and
  `@flowslens/runtime`. `npx @flowslens/cli scan .` now works without cloning
  anything. Note the scope: the packages are `@flowslens/*` while the command,
  the config file and the cache directory stay `flowlens`.
- **`npm run test:package`** packs the real tarballs, installs them into a
  throwaway project and drives the result over HTTP. Every other check runs
  against the working tree, where the dashboard and browser tracer simply
  exist — so a published CLI once shipped neither while all of CI stayed
  green.

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

- **`flowlens where <file>:<line>`** — the reverse lookup. `flow <id>` goes
  forward from a click; this starts at a cursor position and reports every
  user-visible feature whose execution path runs through it, with the endpoint,
  the collections in reach and the risk. Two details make it usable rather than
  merely correct: a line inside a function body resolves to the nearest
  declaration _above_ it and says how far, rather than silently answering a
  different question; and a match that is not itself on the execution path (a
  `useState` field, a DTO, a schema field) is followed one hop along the
  non-execution edges to a node that is — the same one-hop rule `StepDetail`
  uses, and for the same reason. A bare basename is accepted only when
  unambiguous, because every App Router project has a dozen `route.ts`.

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
- The `@flowslens/runtime` sink defaulted to `.flowlens/trace.jsonl` relative to
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
- **Runtime tracer** (`@flowslens/runtime`) — zero-dependency HTTP middleware,
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

[unreleased]: https://github.com/Kishan-Jaiswar/flowlens/compare/v1.0.1...HEAD
[1.0.1]: https://github.com/Kishan-Jaiswar/flowlens/compare/v1.0.0...v1.0.1
[1.0.0]: https://github.com/Kishan-Jaiswar/flowlens/compare/v0.1.0...v1.0.0
[0.1.0]: https://github.com/Kishan-Jaiswar/flowlens/releases/tag/v0.1.0
